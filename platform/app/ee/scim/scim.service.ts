// SPDX-License-Identifier: LicenseRef-LangWatch-Enterprise
import { DepartmentService } from "@ee/governance/services/department/department.service";
import { generate } from "@langwatch/ksuid";
import { createLogger } from "@langwatch/observability";
import { PrismaClientKnownRequestError } from "@prisma/client/runtime/client";
import {
  type PrismaClient,
  RoleBindingScopeType,
  TeamUserRole,
  type User,
} from "~/generated/prisma/client";
import { MembershipLifecycleService } from "~/server/users/membership-lifecycle.service";
import { UserService } from "~/server/users/user.service";
import { KSUID_RESOURCES } from "~/utils/constants";
import {
  SCIM_ENTERPRISE_USER_SCHEMA,
  type ScimCreateUserRequest,
  type ScimError,
  type ScimListResponse,
  type ScimPatchOperation,
  type ScimPatchRequest,
  type ScimUser,
} from "./scim.types";

const logger = createLogger("langwatch:scim");

const GUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The `scimSource` value that marks a membership as directory-managed. */
const SCIM_SOURCE = "scim";

/** The membership fields the SCIM representation of a person is built from. */
type ScimMembership = { externalId: string | null; disabledAt: Date | null };

/**
 * Maps between SCIM 2.0 User resources and LangWatch User/OrganizationUser models.
 * All operations are scoped to an organization for multi-tenancy.
 */
export class ScimService {
  private readonly userService: UserService;
  private readonly departmentService: DepartmentService;
  /**
   * Directory traffic is org-scoped by definition — the token that carried
   * this request belongs to one organization's IdP. Every activate /
   * deactivate below therefore goes through the membership lifecycle rather
   * than the global account flag, or one tenant's directory decides a
   * person's state inside every other tenant (#6976, ADR-094 Decision 4).
   */
  private readonly membershipLifecycle: MembershipLifecycleService;

  constructor(private readonly prisma: PrismaClient) {
    this.userService = UserService.create(prisma);
    this.departmentService = DepartmentService.create(prisma);
    this.membershipLifecycle = MembershipLifecycleService.create(prisma);
  }

  static create(prisma: PrismaClient): ScimService {
    return new ScimService(prisma);
  }

  /**
   * Apply the SCIM enterprise costCenter attribute to a membership. A
   * non-empty name resolves (creating if absent) and assigns; an explicit
   * empty/null value clears the assignment so spend rolls up under
   * Unassigned. `undefined` means the attribute was not in this request, so
   * the current assignment is left untouched.
   */
  private async syncCostCenterFromScim({
    userId,
    organizationId,
    costCenter,
  }: {
    userId: string;
    organizationId: string;
    costCenter: string | null | undefined;
  }): Promise<void> {
    if (costCenter === undefined) return;

    const trimmed = typeof costCenter === "string" ? costCenter.trim() : "";
    if (trimmed === "") {
      await this.departmentService.assignUser({
        organizationId,
        userId,
        departmentId: null,
      });
      return;
    }

    const department = await this.departmentService.resolveByNameOrCreate({
      organizationId,
      name: trimmed,
    });
    await this.departmentService.assignUser({
      organizationId,
      userId,
      departmentId: department.id,
    });
  }

  /**
   * Read the enterprise costCenter from a create/replace body. Returns
   * `undefined` when the enterprise extension is absent so callers can tell
   * "not provided" from "explicitly cleared".
   */
  private costCenterFromRequest(
    request: ScimCreateUserRequest,
  ): string | null | undefined {
    const ext = (request as Record<string, unknown>)[
      SCIM_ENTERPRISE_USER_SCHEMA
    ] as { costCenter?: string | null } | undefined;
    if (!ext || !("costCenter" in ext)) return undefined;
    return ext.costCenter ?? null;
  }

  /**
   * Read the enterprise costCenter from a PATCH operation, supporting both
   * the schema-qualified path form (`...:User:costCenter`) and the
   * value-object form. Returns `{ present: false }` when the op does not
   * touch costCenter.
   */
  private costCenterFromPatchOp(
    operation: ScimPatchOperation,
  ): { present: true; value: string | null } | { present: false } {
    const costCenterPath = `${SCIM_ENTERPRISE_USER_SCHEMA}:costCenter`;

    if (operation.path === costCenterPath) {
      if (operation.op === "remove") return { present: true, value: null };
      const v = operation.value;
      return { present: true, value: typeof v === "string" ? v : null };
    }

    if (operation.value != null && typeof operation.value === "object") {
      const value = operation.value as Record<string, unknown>;
      const ext = value[SCIM_ENTERPRISE_USER_SCHEMA] as
        | { costCenter?: string | null }
        | undefined;
      if (ext && "costCenter" in ext) {
        return { present: true, value: ext.costCenter ?? null };
      }
    }

    return { present: false };
  }

  async createUser({
    request,
    organizationId,
  }: {
    request: ScimCreateUserRequest;
    organizationId: string;
  }): Promise<ScimUser | ScimError> {
    const email = request.userName;
    const name = this.buildNameFromRequest(request);

    const existingUser = await this.userService.findByEmail({ email });

    if (existingUser) {
      const existingMembership = await this.prisma.organizationUser.findUnique({
        where: {
          userId_organizationId: {
            userId: existingUser.id,
            organizationId,
          },
        },
      });

      if (existingMembership) {
        return this.scimError({
          status: "409",
          detail: "User already exists in this organization",
        });
      }

      try {
        await this.prisma.organizationUser.create({
          data: {
            userId: existingUser.id,
            organizationId,
            role: "MEMBER",
            ...this.anchorFromRequest({ request, organizationId }),
          },
        });
        await this.prisma.roleBinding.create({
          data: {
            id: generate(KSUID_RESOURCES.ROLE_BINDING).toString(),
            organizationId,
            userId: existingUser.id,
            role: TeamUserRole.MEMBER,
            scopeType: RoleBindingScopeType.ORGANIZATION,
            scopeId: organizationId,
          },
        });
      } catch (e) {
        if (e instanceof PrismaClientKnownRequestError && e.code === "P2002") {
          return await this.toScimUserInOrg({
            user: existingUser,
            organizationId,
          });
        }
        throw e;
      }

      // Re-provisioning restores access in THIS organization and lifts the
      // global flag only if it was set. It deliberately does not restore
      // usage-attribution links — an admin relinks (ADR-094 Decision 4).
      await this.membershipLifecycle.onMembershipReactivated({
        organizationId,
        userId: existingUser.id,
      });

      await this.syncCostCenterFromScim({
        userId: existingUser.id,
        organizationId,
        costCenter: this.costCenterFromRequest(request),
      });

      const reloadedUser = await this.userService.findById({
        id: existingUser.id,
      });
      if (!reloadedUser) {
        return this.scimError({ status: "404", detail: "User not found" });
      }
      return await this.toScimUserInOrg({
        user: reloadedUser,
        organizationId,
      });
    }

    const newUser = await this.userService.create({ name, email });

    try {
      await this.prisma.organizationUser.create({
        data: {
          userId: newUser.id,
          organizationId,
          role: "MEMBER",
          ...this.anchorFromRequest({ request, organizationId }),
        },
      });
      await this.prisma.roleBinding.create({
        data: {
          organizationId,
          userId: newUser.id,
          role: TeamUserRole.MEMBER,
          scopeType: RoleBindingScopeType.ORGANIZATION,
          scopeId: organizationId,
        },
      });
    } catch (e) {
      if (e instanceof PrismaClientKnownRequestError && e.code === "P2002") {
        return this.scimError({
          status: "409",
          detail: "User already exists in this organization",
        });
      }
      throw e;
    }

    await this.syncCostCenterFromScim({
      userId: newUser.id,
      organizationId,
      costCenter: this.costCenterFromRequest(request),
    });

    return await this.toScimUserInOrg({ user: newUser, organizationId });
  }

  async getUser({
    id,
    organizationId,
  }: {
    id: string;
    organizationId: string;
  }): Promise<ScimUser | ScimError> {
    const membership = await this.prisma.organizationUser.findUnique({
      where: {
        userId_organizationId: {
          userId: id,
          organizationId,
        },
      },
      include: { user: true },
    });

    if (!membership) {
      return this.scimError({ status: "404", detail: "User not found" });
    }

    return this.toScimUser(membership.user, membership);
  }

  async listUsers({
    organizationId,
    filter,
    startIndex = 1,
    count = 100,
  }: {
    organizationId: string;
    filter?: string;
    startIndex?: number;
    count?: number;
  }): Promise<ScimListResponse<ScimUser>> {
    const parsedFilter = this.parseUserFilter(filter);

    const whereClause: Record<string, unknown> = {
      organizationId,
    };

    if (parsedFilter?.attribute === "userName") {
      whereClause.user = {
        email: { equals: parsedFilter.value, mode: "insensitive" },
      };
    } else if (parsedFilter?.attribute === "externalId") {
      // The anchor is matched on the membership column, exactly (an id is an
      // id — case-folding it would collide two distinct directory subjects).
      whereClause.externalId = parsedFilter.value;
    }

    const [memberships, totalCount] = await Promise.all([
      this.prisma.organizationUser.findMany({
        where: whereClause,
        include: { user: true },
        skip: startIndex - 1,
        take: count,
      }),
      this.prisma.organizationUser.count({ where: whereClause }),
    ]);

    return {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
      totalResults: totalCount,
      startIndex,
      itemsPerPage: count,
      Resources: memberships.map((m) => this.toScimUser(m.user, m)),
    };
  }

  async replaceUser({
    id,
    organizationId,
    request,
  }: {
    id: string;
    organizationId: string;
    request: ScimCreateUserRequest;
  }): Promise<ScimUser | ScimError> {
    const membership = await this.prisma.organizationUser.findUnique({
      where: {
        userId_organizationId: {
          userId: id,
          organizationId,
        },
      },
    });

    if (!membership) {
      return this.scimError({ status: "404", detail: "User not found" });
    }

    const name = this.buildNameFromRequest(request);
    const active = request.active !== false;

    await this.userService.updateProfile({
      id,
      name,
      email: request.userName,
    });

    // Branch on the MEMBERSHIP, not the account: `active: false` from this
    // directory ends this membership, and only the person's last active
    // membership takes the account with it.
    if (active && membership.disabledAt) {
      await this.membershipLifecycle.onMembershipReactivated({
        organizationId,
        userId: id,
      });
    } else if (!active && !membership.disabledAt) {
      await this.membershipLifecycle.onMembershipDeactivated({
        organizationId,
        userId: id,
      });
    }

    await this.persistAnchor({
      userId: id,
      organizationId,
      externalId: request.externalId,
    });

    await this.syncCostCenterFromScim({
      userId: id,
      organizationId,
      costCenter: this.costCenterFromRequest(request),
    });

    const reloadedUser = await this.userService.findById({ id });
    if (!reloadedUser) {
      return this.scimError({ status: "404", detail: "User not found" });
    }
    return await this.toScimUserInOrg({ user: reloadedUser, organizationId });
  }

  async updateUser({
    id,
    organizationId,
    patchRequest,
  }: {
    id: string;
    organizationId: string;
    patchRequest: ScimPatchRequest;
  }): Promise<ScimUser | ScimError> {
    const membership = await this.prisma.organizationUser.findUnique({
      where: {
        userId_organizationId: {
          userId: id,
          organizationId,
        },
      },
    });

    if (!membership) {
      return this.scimError({ status: "404", detail: "User not found" });
    }

    for (const operation of patchRequest.Operations) {
      // Enterprise costCenter can arrive via replace/add (set) or remove
      // (clear), as a schema-qualified path or inside a value object, so it
      // is handled before the replace-only profile logic below.
      const costCenterOp = this.costCenterFromPatchOp(operation);
      if (costCenterOp.present) {
        await this.syncCostCenterFromScim({
          userId: id,
          organizationId,
          costCenter: costCenterOp.value,
        });
      }

      if (operation.op !== "replace") continue;

      // Handle path="active" with a scalar boolean value (e.g. Okta/Azure AD style)
      if (operation.path === "externalId") {
        if (typeof operation.value === "string") {
          await this.persistAnchor({
            userId: id,
            organizationId,
            externalId: operation.value,
          });
        }
        continue;
      }

      if (operation.path === "active") {
        if (operation.value === false || operation.value === "false") {
          await this.membershipLifecycle.onMembershipDeactivated({
            organizationId,
            userId: id,
          });
        } else {
          await this.membershipLifecycle.onMembershipReactivated({
            organizationId,
            userId: id,
          });
        }
        continue;
      }

      if (operation.value == null || typeof operation.value !== "object")
        continue;

      const value = operation.value as Record<string, unknown>;
      const updates: { name?: string; email?: string } = {};

      if ("active" in value) {
        if (value.active === false) {
          await this.membershipLifecycle.onMembershipDeactivated({
            organizationId,
            userId: id,
          });
        } else {
          await this.membershipLifecycle.onMembershipReactivated({
            organizationId,
            userId: id,
          });
        }
      }

      if ("externalId" in value && typeof value.externalId === "string") {
        await this.persistAnchor({
          userId: id,
          organizationId,
          externalId: value.externalId,
        });
      }

      if ("userName" in value && typeof value.userName === "string") {
        updates.email = value.userName;
      }

      if ("name" in value && typeof value.name === "object") {
        const nameObj = value.name as Record<string, string>;
        const parts = [nameObj.givenName, nameObj.familyName].filter(Boolean);
        if (parts.length > 0) {
          updates.name = parts.join(" ");
        }
      } else if ("name.givenName" in value || "name.familyName" in value) {
        // Dot-notation attribute paths in value object (RFC 7644 §3.5.2)
        const given =
          typeof value["name.givenName"] === "string"
            ? value["name.givenName"]
            : null;
        const family =
          typeof value["name.familyName"] === "string"
            ? value["name.familyName"]
            : null;
        const parts = [given, family].filter(Boolean);
        if (parts.length > 0) {
          updates.name = parts.join(" ");
        }
      }

      if (Object.keys(updates).length > 0) {
        await this.userService.updateProfile({ id, ...updates });
      }
    }

    const reloadedUser = await this.userService.findById({ id });
    if (!reloadedUser) {
      return this.scimError({ status: "404", detail: "User not found" });
    }
    return await this.toScimUserInOrg({ user: reloadedUser, organizationId });
  }

  async deleteUser({
    id,
    organizationId,
  }: {
    id: string;
    organizationId: string;
  }): Promise<ScimError | null> {
    const membership = await this.prisma.organizationUser.findUnique({
      where: {
        userId_organizationId: {
          userId: id,
          organizationId,
        },
      },
    });

    if (!membership) {
      return this.scimError({ status: "404", detail: "User not found" });
    }

    // One transaction covering the membership removal, its role bindings and
    // the closing link rows. It used to commit the removal first and
    // deactivate afterwards; a crash in that gap lost the closing rows
    // forever, because the IdP's retry finds no membership and answers 404
    // before ever reaching the second step (ADR-094 Decision 4).
    await this.membershipLifecycle.onMembershipDeactivated({
      organizationId,
      userId: id,
      membershipChange: "remove",
    });
    return null;
  }

  /**
   * The SCIM view of a person IN ONE ORGANIZATION. It takes the membership,
   * not just the account, because both fields the IdP reads back live there:
   * the directory anchor it wrote, and `active`, which since ADR-094 Decision
   * 4 means "active HERE" — an account left alive for the person's other
   * organizations must not report a member this directory just suspended as
   * still active.
   */
  toScimUser(user: User, membership?: ScimMembership | null): ScimUser {
    const { givenName, familyName } = this.splitName(user.name ?? "");

    return {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      id: user.id,
      ...(membership?.externalId ? { externalId: membership.externalId } : {}),
      userName: user.email ?? "",
      name: {
        givenName,
        familyName,
      },
      emails: [
        {
          primary: true,
          value: user.email ?? "",
          type: "work",
        },
      ],
      active: user.deactivatedAt === null && !membership?.disabledAt,
      meta: {
        resourceType: "User",
        created: user.createdAt.toISOString(),
        lastModified: user.updatedAt.toISOString(),
      },
    };
  }

  /**
   * The anchor columns to write when the membership row is CREATED, so the
   * directory's id lands with the row rather than in a follow-up update that
   * could be lost between the two.
   *
   * A null externalId means "this payload carries no anchor" and writes
   * nothing — Entra sends an explicit null when the mapped attribute is empty,
   * and a directory that has not populated the attribute yet must not be read
   * as one asserting the person has no directory id.
   */
  private anchorFromRequest({
    request,
    organizationId,
  }: {
    request: ScimCreateUserRequest;
    organizationId: string;
  }): { externalId?: string; scimSource?: string } {
    const externalId = request.externalId;
    if (externalId == null) return {};
    this.warnIfAnchorLooksMutable({ externalId, organizationId });
    return { externalId, scimSource: SCIM_SOURCE };
  }

  /** The SCIM view of a person, with their membership of this organization. */
  private async toScimUserInOrg({
    user,
    organizationId,
  }: {
    user: User;
    organizationId: string;
  }): Promise<ScimUser> {
    const membership = await this.prisma.organizationUser.findUnique({
      where: { userId_organizationId: { userId: user.id, organizationId } },
      select: { externalId: true, disabledAt: true },
    });
    return this.toScimUser(user, membership);
  }

  /**
   * Write the directory anchor onto the membership. `scimSource` is what makes
   * the row directory-owned — the discriminator shipped code already keys on,
   * not "externalId is set" (ADR-094 Decision 7). Storing the anchor creates
   * NO usage-attribution link: matching a login to a person stays an admin
   * decision, and this only gives that decision something to propose from.
   *
   * Null is absent, not "clear it". Writing null over a stored anchor would
   * quietly detach a person from their directory identity on any sync where
   * the attribute happened to be empty, and the anchor has no history to
   * recover it from.
   */
  private async persistAnchor({
    userId,
    organizationId,
    externalId,
  }: {
    userId: string;
    organizationId: string;
    externalId: string | null | undefined;
  }): Promise<void> {
    if (externalId == null) return;
    this.warnIfAnchorLooksMutable({ externalId, organizationId });
    await this.prisma.organizationUser.updateMany({
      where: { userId, organizationId },
      data: { externalId, scimSource: SCIM_SOURCE },
    });
  }

  private buildNameFromRequest(request: ScimCreateUserRequest): string {
    if (request.name) {
      const parts = [request.name.givenName, request.name.familyName].filter(
        Boolean,
      );
      if (parts.length > 0) {
        return parts.join(" ");
      }
    }
    return request.userName.split("@")[0] ?? request.userName;
  }

  private splitName(fullName: string): {
    givenName: string;
    familyName: string;
  } {
    const spaceIndex = fullName.indexOf(" ");
    if (spaceIndex === -1) {
      return { givenName: fullName, familyName: "" };
    }
    return {
      givenName: fullName.substring(0, spaceIndex),
      familyName: fullName.substring(spaceIndex + 1),
    };
  }

  /**
   * SCIM filters this surface answers: `userName eq <value>` and
   * `externalId eq <value>`, each with or without double quotes.
   *
   * Both halves matter for Microsoft Entra, whose documented retrieve is a
   * straight unquoted `externalId eq jyoung`. We used to match only quoted
   * `userName`, so an Entra retrieve fell through to null, returned every
   * member instead of the one asked for, and — since Entra provisions a new
   * user whenever a query finds none — silently created a duplicate person.
   */
  private parseUserFilter(
    filter?: string,
  ): { attribute: "userName" | "externalId"; value: string } | null {
    if (!filter) return null;
    const match = filter
      .trim()
      .match(/^(userName|externalId)\s+eq\s+(?:"([^"]*)"|(\S+))$/);
    if (!match) return null;
    const value = match[2] ?? match[3];
    if (!value) return null;
    return { attribute: match[1] as "userName" | "externalId", value };
  }

  /**
   * Entra's DEFAULT user mapping sends `mailNickname` — a mutable nickname —
   * as the external id, and only a customer who remaps `objectId` gets a
   * stable anchor. Warn rather than reject: Okta's immutable id is not a GUID
   * either and has to keep working, so refusing non-GUIDs would break a
   * directory that is doing nothing wrong.
   */
  private warnIfAnchorLooksMutable({
    externalId,
    organizationId,
  }: {
    externalId: string;
    organizationId: string;
  }): void {
    if (GUID_PATTERN.test(externalId)) return;
    logger.warn(
      { organizationId },
      "SCIM user externalId is not a GUID. If this directory is Microsoft Entra, its default mapping sends a mutable nickname — remap objectId to externalId, or the person's usage attribution anchor moves when they are renamed.",
    );
  }

  private scimError({
    status,
    detail,
  }: {
    status: string;
    detail: string;
  }): ScimError {
    return {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
      status,
      detail,
    };
  }
}
