# Task: Recover Broken Python Financial Package (`quantlib_mini`)

This repository contains `quantlib_mini`, a zero-dependency Python 3.13 fixed-income bond pricing package. Several cascading configuration, import, packaging, I/O, and financial calculation faults are currently breaking the package, its test suite, and its CLI.

## Requirements

Diagnose and repair all faults in the workspace so that:

1. `pyproject.toml` is valid TOML and loads cleanly via `tomllib`.
2. Standard library modules (including `calendar` and `statistics`) are not shadowed when running Python from the workspace root, while preserving all business-day holiday calendar functionality inside `quantlib_mini`.
3. All `quantlib_mini` submodules import cleanly regardless of import order (no circular import errors).
4. The unit test suite passes completely when executed via:
   ```
   python -m unittest discover -s tests -v
   ```
   All test files in `tests/` must be discovered and pass without disabling, deleting, or weakening test assertions.
5. The CLI runs cleanly and outputs accurate JSON financial valuations strictly conforming to `SPEC.md`:
   ```
   python -m quantlib_mini.cli --curve data/yield_curve.csv --bond data/sample_bond.json
   ```
6. All calculations (zero-curve interpolation/discounting, UTF-8 BOM + CRLF CSV loading, business-day adjustments, and `ACT/365F`, `ACT/ACT`, and `30/360` day-count conventions) strictly match `SPEC.md`.

## Constraints

- Use Python 3.13 standard library only (no third-party packages).
- Do **not** modify the financial values in `data/yield_curve.csv` or `data/sample_bond.json`, and do not work around CSV parsing bugs by stripping encoding markers from `data/yield_curve.csv` — the loader itself must handle arbitrary UTF-8 BOM + CRLF CSV files.
- Keep `SPEC.md` intact and preserve the public API and CLI JSON output schema documented in `SPEC.md`.
