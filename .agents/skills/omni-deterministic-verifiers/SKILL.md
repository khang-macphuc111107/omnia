---
name: omni-deterministic-verifiers
description: Run zero-dependency Phase-3 machine verifiers for byte and LF preservation, SHA-256 digests, control-character hygiene, WCAG 2.1 color contrast ratios, secret and credential leak scanning, progressive-disclosure token ceilings, and SKILL.md structural audits.
metadata:
  short-description: Deterministic SHA-256, LF, WCAG contrast, secret, and token verifiers
---

# Omni Deterministic Phase-3 Verifiers

Replace subjective AI self-grading ("looks clean", "contrast seems readable", "no secrets noticed") with deterministic, reproducible CLI checks executed during Phase-3 verification.

## Executable Verifier Suite (`scripts/verify_pack.py`)

Run `scripts/verify_pack.py` directly from Python 3 (stdlib only, zero external packages required):

```bash
# 1. Byte/SHA-256/EOL & control-char check (catches CRLF drift, 0x0b vertical tabs, NUL bytes, trailing-space filenames)
python scripts/verify_pack.py preservation path/to/file_or_dir

# 2. Exact WCAG 2.1 relative-luminance contrast check (AA >= 4.5:1 normal text, >= 3.0:1 UI, AAA >= 7.0:1)
python scripts/verify_pack.py contrast "#E6EDF3" "#0D1117"

# 3. Secret, API key, token & credential-URL leak scan across files or directories
python scripts/verify_pack.py secrets path/to/export_or_docs

# 4. Token-budget & 5k tool-truncation guard
python scripts/verify_pack.py tokens path/to/document.md --limit 5000

# 5. Structural & UTF-8 LF audit across a skill folder or skill root
python scripts/verify_pack.py skill-doctor path/to/skills_root
```

## Mandatory Verification Gates

1. **Repository & Handoff Hygiene (`preservation` + `secrets`)**:
   - Every edited source, Markdown, JSON, YAML, or script file in `LF`-governed repositories must report `crlf_lines == 0`, `mixed_eol == false`, and `control_chars_found == []` (explicitly catching `0x0b` Google Docs/PowerShell vertical-tab artifacts).
   - Every exported transcript, research ledger, and collaborator handoff doc must report `clean == true` (`findings_count == 0`) on `secrets`.
2. **UI Direction & Token Seeds (`contrast`)**:
   - Verify primary body text `>= 4.5:1` (`wcag_aa_normal_text_4_5: true`) and interactive UI chrome `>= 3.0:1` (`wcag_aa_large_ui_3_0: true`) numerically before presenting UI candidates.
3. **Skill Authoring (`skill-doctor`)**:
   - Verify valid UTF-8 `LF`, non-empty `name` matching directory slug, `description` `<= 1,024` chars without angle brackets, and zero unresolved `[TODO:...]` scaffold markers.
