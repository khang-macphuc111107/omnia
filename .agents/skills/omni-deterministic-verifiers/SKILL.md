---
name: omni-deterministic-verifiers
description: Run zero-dependency Phase-3 machine verifiers for byte and LF preservation, SHA-256 digests, control-character hygiene, WCAG 2.1 color contrast ratios, secret and credential leak scanning, progressive-disclosure token ceilings, SKILL.md structural audits, FFmpeg media tail-decode gates, and localhost HTTP/WebSocket Origin parity checks.
metadata:
  short-description: Deterministic SHA-256, LF, WCAG contrast, secret, media, and Origin verifiers
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
4. **Media Tail-Decode & MSE Discontinuity Gate (FFmpeg)**:
   - Never treat `ffmpeg -v error -ss <T> -i file.mp4 -f null -` exit code `0` alone as proof of media completeness: input-seeking past actual EOF exits `0` with empty `stderr` and `0` decoded frames. Parse `Duration:` against expected duration AND run `-stats -v error -ss <tail_start> -t <window> -i file.mp4 -f null -` asserting decoded `frame=` count `> 0` near the expected tail and across `#EXT-X-DISCONTINUITY` / `ffmpeg -f concat` part seams. For MSE fMP4 streams with mid-stream `moov`, `timestampOffset` jumps, or `tfdt` resets, split into sequential part files for `-f concat` remuxing, scope `<video>` polling strictly to MSE (`blob:` / `srcObject`), and refuse EME/DRM (`mediaKeys` / `SAMPLE-AES` / CENC) and anti-bot gates (`2026-11-12-omnidownloader-mse-capture-and-security-hardening.md`).
5. **Localhost Daemon HTTP + Companion WebSocket `Origin` Parity**:
   - Browser `WebSocket` handshakes do not send CORS `OPTIONS` preflights. Whenever a localhost daemon restricts HTTP routes to loopback/extension `Origin` allowlists, verify matching exact-origin enforcement on companion `WebSocketServer` (`verifyClient` / `upgrade` handler) with negative cross-origin probes (`Origin: https://evil.example` -> `403`) on both surfaces.
