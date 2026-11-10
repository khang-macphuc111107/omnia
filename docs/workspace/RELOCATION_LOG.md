# Relocation log

## 2026-11-11 — `rea`

- Source: `D:\Omnia\upstream_tools\rea`
- Destination: `D:\Omnia\research\repos\rea`
- Reason: zero text-reference hits in the scoped audit; independent upstream origin.
- Method: same-volume move, no copy/delete operation.
- Verification: 34,866 files; 915,767,448 bytes before and after; SHA-256/path manifest matched with zero mismatches or missing files.
- Nested `.git` was preserved at the destination to retain upstream provenance.
- Receipt: `C:\Users\khang\.codex\research\omnia-restructure\20261111\relocation-rea\AFTER.json`

## 2026-11-11 — `omnia-public`

- Source: `D:\Omnia\repos\omnia-public`
- Destination: `D:\Omnia\projects\omnia-public`
- Verification: 17,446 files; 582,041,675 bytes before and after; SHA-256/path manifest matched with zero mismatches or missing files.
- Nested `.git` was preserved. `tools/maintained-scripts/stage-public-release.mjs` now uses explicit `OMNIA_WORKSPACE_ROOT`/`OMNIA_SOURCE_ROOT` paths and stages to `projects/omnia-public`.
