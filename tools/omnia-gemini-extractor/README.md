# `omnia-gemini-extractor`

Zero-dependency Python 3 + Node v28 extractor for **public** Gemini share links (`https://share.gemini.google/<id>` or `https://gemini.google.com/share/<id>`).

## Features

- **Strict Gate Policy**: Accepts only public share links; explicitly refuses private `gemini.google.com/app/...` / `accounts.google.com/...` (`auth_required`) and `google.com/sorry` CAPTCHA redirects (`captcha_blocked`) without attempting any bypass.
- **WIZ `batchexecute` Decoder**: Strips `)]}'` prefixes, parses length-prefixed/JSON `wrb.fr` frames, extracts `ujx1Bf` share metadata + multi-page `root[0][0]` cursor pagination + `otAQ7b` model maps.
- **Rich Extraction (`omnia.gemini-share-transcript.v1`)**: Extracts prompts, attachments (`t[2][0][4]` uploaded files + `t[2][15]` pasted blocks while explicitly ignoring scalar boolean `t[2][8] = false`), `search_queries` (`t[3][1]`), `model_id` (`t[3][14]`), `response_markdown` (`draft[1][0]`), `thinking_steps` (`draft[37][1]` with interleaved `sources`), and `grounding_citations` (`draft[2][1]`).
- **Network-Service CDP Capture (`cdp_capture.mjs`)**: Zero-npm Node v28 script launching headless Edge/Chrome on an ephemeral loopback port with a temporary `--user-data-dir` cleaned up in `finally`, streaming `*batchexecute*` responses via `Fetch.enable` directly to external storage (`D:\OmniaData\...`) without `Runtime.evaluate` OOM.
- **Zero-Secret Hygiene & Completeness Checks**: Redacts PEM keys, Bearer tokens, provider prefixes, cookies, signed/secret URL params, emails, and Windows/POSIX home paths (`redact=True`), and verifies `cursor_exhausted`, `0` empty turns, and exact summary counts.

## Usage

Always run Python with `-B` (`PYTHONDONTWRITEBYTECODE=1`) so `__pycache__` is never emitted inside the repository:

```powershell
python -B -m unittest discover -s tools/omnia-gemini-extractor -p "test_*.py" -v
node --check tools/omnia-gemini-extractor/cdp_capture.mjs
python -B tools/omnia-gemini-extractor/cli.py capture-cdp --url https://share.gemini.google/<id> --out D:\OmniaData\exports\gemini-share\<id>_raw.txt --json-out D:\OmniaData\exports\gemini-share\<id>.json
python -B tools/omnia-gemini-extractor/cli.py verify --in D:\OmniaData\exports\gemini-share\<id>.json
python -B tools/omnia-gemini-extractor/cli.py export-markdown --in D:\OmniaData\exports\gemini-share\<id>.json --out D:\OmniaData\exports\gemini-share\<id>.md
```
