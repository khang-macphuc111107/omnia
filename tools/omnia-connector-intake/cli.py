"""CLI entrypoint for deterministic Omnia connector contract intake checks."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Sequence

if str(Path(__file__).resolve().parent) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parent))

from connector_contracts import (  # noqa: E402
    inspect_connector_bundle,
    normalize_proxy_route_config,
    validate_download_manifest,
    validate_notebook_bundle,
)


def _read_json_input(input_arg: str) -> dict[str, Any]:
    if input_arg == "-":
        raw_text = sys.stdin.read()
    else:
        path = Path(input_arg)
        raw_text = path.read_text(encoding="utf-8")
    data = json.loads(raw_text)
    if not isinstance(data, dict):
        raise ValueError("Input JSON root must be an object.")
    return data


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="omnia-connector-intake",
        description="Normalize and validate proxy, notebook, and download connector payloads.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    def _add_common(sub: argparse.ArgumentParser) -> None:
        sub.add_argument(
            "--input",
            required=True,
            help="Path to UTF-8 JSON payload, or '-' for stdin.",
        )
        sub.add_argument(
            "--strict",
            action="store_true",
            help="Exit with code 2 when validation produces refusing errors (valid=false).",
        )
        sub.add_argument(
            "--output",
            default="-",
            help="Output path for normalized JSON (default stdout '-').",
        )

    p_proxy = subparsers.add_parser(
        "normalize-proxy",
        help="Normalize htmustc-proxy config/route JSON into Omnia DynamicProviderRouter schema.",
    )
    _add_common(p_proxy)
    p_proxy.add_argument(
        "--allow-private",
        action="store_true",
        help="Allow private/RFC1918 endpoint IPs when appropriate.",
    )
    p_proxy.add_argument(
        "--allow-http",
        action="store_true",
        help="Downgrade non-TLS remote HTTP from blocking error to warning.",
    )

    p_nb = subparsers.add_parser(
        "validate-notebook",
        help="Validate Gemini Notebook export & citation bundle into Omnia MemoryGraph schema.",
    )
    _add_common(p_nb)
    p_nb.add_argument(
        "--namespace-prefix",
        default="connectors/notebook",
        help="Default MemoryGraph namespace_path when omitted.",
    )

    p_dl = subparsers.add_parser(
        "validate-download",
        help="Validate Google Drive Downloader range & SHA-256 manifest for Omnia media intake.",
    )
    _add_common(p_dl)

    p_bundle = subparsers.add_parser(
        "inspect-bundle",
        help="Dispatch single ('kind') or multi-connector bundle JSON.",
    )
    _add_common(p_bundle)
    p_bundle.add_argument("--allow-private", action="store_true")
    p_bundle.add_argument("--allow-http", action="store_true")

    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)

    try:
        payload = _read_json_input(args.input)
        if args.command == "normalize-proxy":
            result = normalize_proxy_route_config(
                payload,
                strict_tls=not args.allow_http,
                allow_private_endpoints=args.allow_private,
            )
        elif args.command == "validate-notebook":
            result = validate_notebook_bundle(
                payload,
                namespace_prefix=args.namespace_prefix,
            )
        elif args.command == "validate-download":
            result = validate_download_manifest(payload)
        elif args.command == "inspect-bundle":
            result = inspect_connector_bundle(
                payload,
                strict_tls=not args.allow_http,
                allow_private_endpoints=args.allow_private,
            )
        else:
            parser.error(f"Unknown command: {args.command}")
            return 2
    except (OSError, ValueError, TypeError, json.JSONDecodeError) as exc:
        err_payload = {"valid": False, "status": "INPUT_ERROR", "error": str(exc)}
        sys.stderr.write(json.dumps(err_payload, ensure_ascii=False) + "\n")
        return 1

    rendered = json.dumps(result, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
    if args.output == "-":
        sys.stdout.write(rendered)
    else:
        Path(args.output).write_text(rendered, encoding="utf-8", newline="\n")

    if args.strict and not result.get("valid", False):
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
