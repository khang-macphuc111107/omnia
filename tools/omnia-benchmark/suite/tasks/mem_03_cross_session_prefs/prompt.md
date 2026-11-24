# Task: Enforce Cross-Session Engineering Decisions & Incident Postmortems

Inspect `memory_archive/` (`prior_session_1.jsonl`, `prior_session_2.jsonl`, `prior_session_3.jsonl`, and `incidents.csv`).
Three prior sessions and an incident postmortem define mandatory security and operational constraints across `service/auth.py`, `service/audit.py`, and `service/handler.py` (including forbidden legacy fallbacks, key-rotation precedence, tenant header normalization, PII scrubbing, and idempotent retry budget).

Fix `service/auth.py`, `service/audit.py`, and `service/handler.py` so every constraint from `memory_archive/` is satisfied and `python -m unittest discover -s tests` passes cleanly (do not edit `tests/`).
