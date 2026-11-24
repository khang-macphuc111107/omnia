# Task: Implement Pipeline Satisfying All Active Invariants Without Compaction Drift

Read `docs/SPEC_HISTORY.md` and `docs/archive_*.log` (~110 KB combined).
Eight architectural invariants (`INV-01` through `INV-08`) were specified across early sections and later amended in two explicit errata entries (while unapproved brainstorm comments must be ignored).

Fix `router/pipeline.py` (`DispatchPipeline.process_batch(events: list[dict]) -> dict`) so it satisfies ALL 8 effective invariants simultaneously and passes `python -m unittest discover -s tests` (do not edit `tests/`).
