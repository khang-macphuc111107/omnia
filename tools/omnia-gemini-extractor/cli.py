"""CLI for `omnia-gemini-extractor`.

Subcommands:
  - `parse-raw`: Decode one or more raw `batchexecute` capture files into transcript JSON.
  - `fetch-http`: Fetch a public Gemini share URL via stdlib HTTP with cursor pagination.
  - `capture-cdp`: Drive `cdp_capture.mjs` (Node v28) to capture `batchexecute` externally.
  - `verify`: Validate completeness of an extracted `omnia.gemini-share-transcript.v1` JSON file.
  - `export-markdown`: Render an extracted JSON or raw `batchexecute` file to UTF-8 LF Markdown.

Enforces UTF-8 without BOM + Unix LF (`\n`) and never writes inside the repository unless
an explicit `--out` path inside the repository (plus `--allow-in-repo`) is supplied.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from typing import Sequence

try:
    from .extractor import (
        GeminiBlockedError,
        GeminiShareError,
        export_transcript_markdown,
        extract_share_transcript,
        fetch_share_http,
        require_valid_share_url,
        verify_completeness,
    )
except ImportError:
    # Support direct `python -B tools/omnia-gemini-extractor/cli.py ...` invocation.
    _pkg_dir = Path(__file__).resolve().parent
    if str(_pkg_dir) not in sys.path:
        sys.path.insert(0, str(_pkg_dir))
    from extractor import (
        GeminiBlockedError,
        GeminiShareError,
        export_transcript_markdown,
        extract_share_transcript,
        fetch_share_http,
        require_valid_share_url,
        verify_completeness,
    )


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _is_within(target: Path, parent: Path) -> bool:
    try:
        target.resolve().relative_to(parent.resolve())
        return True
    except ValueError:
        return False


def _default_external_raw_path(share_id: str) -> Path:
    external_root = Path(r"D:\OmniaData")
    if os.name == "nt" and external_root.exists():
        return external_root / "exports" / "gemini-share" / f"{share_id}_raw.txt"
    return Path(tempfile.gettempdir()) / "omnia-gemini-share" / f"{share_id}_raw.txt"


def _write_text_utf8_lf(out_path: str | None, content: str, *, allow_in_repo: bool = False) -> None:
    normalized = content.replace("\r\n", "\n").replace("\r", "\n")
    if not normalized.endswith("\n"):
        normalized += "\n"
    if out_path is None or out_path == "-":
        sys.stdout.write(normalized)
        return
    target = Path(out_path).resolve()
    if not allow_in_repo and _is_within(target, _repo_root()):
        raise ValueError(
            f"Refusing to write inside repository path '{target}' without --allow-in-repo"
        )
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("w", encoding="utf-8", newline="\n") as fh:
        fh.write(normalized)


def _read_text_input(path_arg: str) -> str:
    if path_arg == "-":
        return sys.stdin.read()
    return Path(path_arg).read_text(encoding="utf-8")


def _cmd_parse_raw(args: argparse.Namespace) -> int:
    raw_inputs = [_read_text_input(p) for p in args.inputs]
    payload: str | list[str] = raw_inputs[0] if len(raw_inputs) == 1 else raw_inputs
    transcript = extract_share_transcript(
        payload,
        source_url=args.source_url or "",
        redact=not args.no_redact,
    )
    report = verify_completeness(transcript)
    if args.strict and not report["passed"]:
        _write_text_utf8_lf(
            args.out,
            json.dumps({"transcript": transcript, "verification": report}, indent=2, ensure_ascii=False),
            allow_in_repo=args.allow_in_repo,
        )
        return 1
    _write_text_utf8_lf(
        args.out,
        json.dumps(transcript, indent=2, ensure_ascii=False),
        allow_in_repo=args.allow_in_repo,
    )
    return 0


def _cmd_fetch_http(args: argparse.Namespace) -> int:
    transcript = fetch_share_http(
        args.url,
        redact=not args.no_redact,
        max_pages=args.max_pages,
        timeout_seconds=args.timeout,
    )
    _write_text_utf8_lf(
        args.out,
        json.dumps(transcript, indent=2, ensure_ascii=False),
        allow_in_repo=args.allow_in_repo,
    )
    return 0


def _cmd_capture_cdp(args: argparse.Namespace) -> int:
    checked = require_valid_share_url(args.url)
    assert checked.share_id is not None and checked.normalized_url is not None

    raw_out = Path(args.out) if args.out else _default_external_raw_path(checked.share_id)
    if not args.allow_in_repo and _is_within(raw_out, _repo_root()):
        raise ValueError(
            f"Refusing to write CDP capture inside repository path '{raw_out}' without --allow-in-repo"
        )

    cdp_script = Path(__file__).resolve().parent / "cdp_capture.mjs"
    cmd = [
        args.node_bin,
        str(cdp_script),
        "--url",
        checked.normalized_url,
        "--out",
        str(raw_out),
        "--timeout-ms",
        str(int(args.timeout_ms)),
    ]
    if args.browser:
        cmd.extend(["--browser", args.browser])
    if args.allow_in_repo:
        cmd.append("--allow-in-repo")

    proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if proc.returncode != 0:
        if proc.stdout.strip():
            sys.stdout.write(proc.stdout.rstrip() + "\n")
        if proc.stderr.strip():
            sys.stderr.write(proc.stderr.rstrip() + "\n")
        return proc.returncode

    if args.json_out:
        raw_text = raw_out.read_text(encoding="utf-8")
        transcript = extract_share_transcript(
            raw_text,
            source_url=checked.normalized_url,
            redact=not args.no_redact,
        )
        _write_text_utf8_lf(
            args.json_out,
            json.dumps(transcript, indent=2, ensure_ascii=False),
            allow_in_repo=args.allow_in_repo,
        )
    elif proc.stdout.strip():
        sys.stdout.write(proc.stdout.rstrip() + "\n")
    return 0


def _cmd_verify(args: argparse.Namespace) -> int:
    raw = _read_text_input(args.input_path)
    transcript = json.loads(raw)
    report = verify_completeness(transcript)
    _write_text_utf8_lf(
        args.out,
        json.dumps(report, indent=2, ensure_ascii=False),
        allow_in_repo=args.allow_in_repo,
    )
    return 0 if report["passed"] else 1


def _cmd_export_markdown(args: argparse.Namespace) -> int:
    raw = _read_text_input(args.input_path)
    if args.raw:
        transcript = extract_share_transcript(
            raw,
            source_url=args.source_url or "",
            redact=not args.no_redact,
        )
    else:
        transcript = json.loads(raw)
    md = export_transcript_markdown(
        transcript,
        include_thinking=not args.no_thinking,
        include_sources=not args.no_sources,
    )
    _write_text_utf8_lf(args.out, md, allow_in_repo=args.allow_in_repo)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="omnia-gemini-extractor",
        description="Extract, verify, and export public Gemini share conversations.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_parse = sub.add_parser("parse-raw", help="Parse raw batchexecute frame text into transcript JSON")
    p_parse.add_argument("--in", dest="inputs", action="append", required=True, help="Raw capture path or '-'")
    p_parse.add_argument("--source-url", default="", help="Optional public Gemini share URL")
    p_parse.add_argument("--out", default=None, help="Output JSON path (defaults to stdout)")
    p_parse.add_argument("--no-redact", action="store_true", help="Disable secret/PII/path redaction")
    p_parse.add_argument("--strict", action="store_true", help="Exit 1 if completeness verification fails")
    p_parse.add_argument("--allow-in-repo", action="store_true", help="Allow writing --out inside repository")
    p_parse.set_defaults(func=_cmd_parse_raw)

    p_http = sub.add_parser("fetch-http", help="Fetch public Gemini share over HTTP and paginate ujx1Bf")
    p_http.add_argument("--url", required=True, help="Public Gemini share URL")
    p_http.add_argument("--out", default=None, help="Output JSON path (defaults to stdout)")
    p_http.add_argument("--max-pages", type=int, default=32, help="Maximum pagination pages")
    p_http.add_argument("--timeout", type=float, default=30.0, help="HTTP timeout in seconds")
    p_http.add_argument("--no-redact", action="store_true", help="Disable secret/PII/path redaction")
    p_http.add_argument("--allow-in-repo", action="store_true", help="Allow writing --out inside repository")
    p_http.set_defaults(func=_cmd_fetch_http)

    p_cdp = sub.add_parser("capture-cdp", help="Capture ujx1Bf batchexecute via headless Edge/Chrome CDP")
    p_cdp.add_argument("--url", required=True, help="Public Gemini share URL")
    p_cdp.add_argument("--out", default=None, help="External output path for raw batchexecute capture")
    p_cdp.add_argument("--json-out", default=None, help="Optional parsed transcript JSON output path")
    p_cdp.add_argument("--browser", default="", help="Explicit Edge/Chrome executable path")
    p_cdp.add_argument("--node-bin", default="node", help="Node.js v28+ executable")
    p_cdp.add_argument("--timeout-ms", type=int, default=45000, help="Capture timeout in milliseconds")
    p_cdp.add_argument("--no-redact", action="store_true", help="Disable redaction when --json-out is used")
    p_cdp.add_argument("--allow-in-repo", action="store_true", help="Allow writing inside repository")
    p_cdp.set_defaults(func=_cmd_capture_cdp)

    p_verify = sub.add_parser("verify", help="Verify completeness of an extracted transcript JSON")
    p_verify.add_argument("--in", dest="input_path", required=True, help="Transcript JSON path or '-'")
    p_verify.add_argument("--out", default=None, help="Optional output JSON report path")
    p_verify.add_argument("--allow-in-repo", action="store_true", help="Allow writing --out inside repository")
    p_verify.set_defaults(func=_cmd_verify)

    p_md = sub.add_parser("export-markdown", help="Export transcript JSON or raw capture to Markdown")
    p_md.add_argument("--in", dest="input_path", required=True, help="Transcript JSON (or raw with --raw)")
    p_md.add_argument("--out", default=None, help="Output Markdown path (defaults to stdout)")
    p_md.add_argument("--raw", action="store_true", help="Treat --in as raw batchexecute payload")
    p_md.add_argument("--source-url", default="", help="Optional source URL when --raw is used")
    p_md.add_argument("--no-redact", action="store_true", help="Disable redaction when --raw is used")
    p_md.add_argument("--no-thinking", action="store_true", help="Omit thinking steps from Markdown")
    p_md.add_argument("--no-sources", action="store_true", help="Omit sources and citations from Markdown")
    p_md.add_argument("--allow-in-repo", action="store_true", help="Allow writing --out inside repository")
    p_md.set_defaults(func=_cmd_export_markdown)

    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return int(args.func(args))
    except GeminiBlockedError as exc:
        sys.stderr.write(json.dumps({"error": exc.reason, "detail": exc.message}) + "\n")
        return 2
    except (GeminiShareError, ValueError, OSError) as exc:
        reason = exc.reason if isinstance(exc, GeminiShareError) else "cli_error"
        sys.stderr.write(json.dumps({"error": reason, "detail": str(exc)}) + "\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
