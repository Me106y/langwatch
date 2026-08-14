# Changelog

## [3.1.0](https://github.com/langwatch/langwatch/compare/langevals@v3.0.0...langevals@v3.1.0) (2026-08-14)


### Features

* **sdk:** judge n-way target comparisons from the experiment SDKs ([#6863](https://github.com/langwatch/langwatch/issues/6863)) ([9c34d3c](https://github.com/langwatch/langwatch/commit/9c34d3c37418ecf6d29b0e521d66fca0661a45d8))


### Bug Fixes

* **ci:** re-arm a dead ast-grep rule and repoint stale post-restructure paths ([#6892](https://github.com/langwatch/langwatch/issues/6892)) ([4a88619](https://github.com/langwatch/langwatch/commit/4a88619d46f30f14212d8e366c83855030249db4))

## [3.0.0](https://github.com/langwatch/langwatch/compare/langevals@v2.2.0...langevals@v3.0.0) (2026-08-08)


### ⚠ BREAKING CHANGES

* **evaluators:** evaluations, monitors and experiments referencing a legacy/ragas_* evaluator type stop working. Their current equivalents in the ragas/* family remain available.

### Features

* **evaluators:** remove the legacy Ragas evaluators ([#6600](https://github.com/langwatch/langwatch/issues/6600)) ([ef9ea90](https://github.com/langwatch/langwatch/commit/ef9ea90e22bc2adb92bacf5c732cc996c9782bfe))
