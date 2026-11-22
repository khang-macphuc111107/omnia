# Omnia Skill Parity & UTF-8 Hygiene Validator (`omnia-skill-parity`)

Zero-dependency Python 3 standard-library validator for Omnia repository skills, `agents/openai.yaml` metadata, `skills.json` registration, cross-host skill parity (`D:\Omnia\.agents\skills`, `~/.codex/skills`, `~/.agents/skills`), and byte-level UTF-8 `LF` / mojibake hygiene.

## Checks Implemented

1. **`SKILL.md` Frontmatter & Body Contract**:
   - Top-level YAML `name` equals the directory slug (`^[a-z0-9-]+$`, `<= 64` chars) without allowing nested keys (such as `metadata.openclaw.envVars[].name`) to shadow top-level `name`.
   - Non-empty `description` (`<= 1024` chars, no `<` or `>`, no unresolved `[TODO:...]` markers).
2. **`agents/openai.yaml` Interface Schema**:
   - Required `interface:` block with `display_name`, `short_description` (`25..64` chars recommended), and `default_prompt` explicitly referencing `$<skill-slug>`.
   - Containment checks for optional `icon_small` and `icon_large` relative paths.
3. **`skills.json` Manifest Registration**:
   - Validates `.agents/skills.json` (and optional `~/.gemini/config/skills.json` Windows drive-absolute `C:/...` or `D:/...` paths without unexpanded `~` or `$HOME`).
4. **Cross-Host Parity & Duplicate Detection**:
   - Compares `SKILL.md` and `agents/openai.yaml` SHA-256 digests across workspace, Codex, and `~/.agents/skills`, detecting reparse points, drift, missing mirrors, intra-root frontmatter `name:` collisions, and prefixed/unprefixed twins (`kdense-*` vs unprefixed).
5. **UTF-8, `0` CRLF, and Byte-Level Mojibake Detection**:
   - Enforces strict UTF-8, zero BOM, zero CRLF/stray CR, zero disallowed control bytes, and detects double-encoded UTF-8 sequences (`\xc3\xa2\xe2\x82\xac`, `Ã`/`Â`/`Ä`/`Æ` CP1252/Latin-1 double-encodings, `\ufffd`) without false-positives on clean UTF-8 em-dashes (`\xe2\x80\x94`) or Vietnamese text.

## Usage (`python -B` — Zero `__pycache__` Writes)

```powershell
# Run full live audit and emit JSON receipt + Markdown report outside D:\Omnia
python -B tools/omnia-skill-parity/validate_skills.py `
  --staged-kdense-dir D:\OmniaData\qa\agy-parallel-20261114\lane4-skill-parity\staged-kdense `
  --json-out D:\OmniaData\qa\agy-parallel-20261114\lane4-skill-parity\SKILL_PARITY_RECEIPT.json `
  --md-out D:\OmniaData\qa\agy-parallel-20261114\lane4-skill-parity\SKILL_PARITY_REPORT.md `
  --strict

# Run unit tests
python -B -m unittest discover -s D:\Omnia\tools\omnia-skill-parity -p "test_*.py" -v
```
