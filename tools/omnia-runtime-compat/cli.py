#!/usr/bin/env python3
"""Command-line interface for Omnia runtime compatibility contracts.

Always run with ``python -B`` so no ``__pycache__`` directories or ``.pyc``
bytecode files are created inside the repository checkout.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Mapping, Sequence

if __package__ in (None, ""):
    _SELF_DIR = str(Path(__file__).resolve().parent)
    if _SELF_DIR not in sys.path:
        sys.path.insert(0, _SELF_DIR)
    from compat_contracts import (  # type: ignore[no-redef]
        CompatContractError,
        NamespaceIndex,
        build_namespace_index,
        lower_responses_request,
        map_opencode_provider_and_models,
        map_opencode_tool_descriptor,
        restore_responses_json,
        restore_sse_stream,
        validate_turn_steer_payload,
    )
else:
    from .compat_contracts import (
        CompatContractError,
        NamespaceIndex,
        build_namespace_index,
        lower_responses_request,
        map_opencode_provider_and_models,
        map_opencode_tool_descriptor,
        restore_responses_json,
        restore_sse_stream,
        validate_turn_steer_payload,
    )


def _read_text_input(path: str | None) -> str:
    if path is None or path == "-":
        return sys.stdin.read()
    return Path(path).read_text(encoding="utf-8")


def _read_json_input(path: str | None) -> Any:
    raw = _read_text_input(path)
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise CompatContractError("INVALID_JSON", f"Failed to parse JSON input: {exc}") from exc


def _load_namespace_index(args: argparse.Namespace) -> NamespaceIndex:
    tools: list[Mapping[str, Any]] | None = None
    aliases: Mapping[str, Any] | None = None
    if getattr(args, "tools", None):
        loaded = _read_json_input(args.tools)
        if isinstance(loaded, list):
            tools = loaded
        elif isinstance(loaded, Mapping):
            if isinstance(loaded.get("tools"), list):
                tools = loaded["tools"]
            if isinstance(loaded.get("namespaceAliases"), Mapping):
                aliases = loaded["namespaceAliases"]
            elif tools is None and all(isinstance(v, Mapping) for v in loaded.values()):
                aliases = loaded
        else:
            raise CompatContractError("INVALID_TOOLS_FILE", "--tools JSON must be an array or object.")
    known_ns = list(getattr(args, "known_namespace", None) or [])
    return build_namespace_index(
        tools,
        aliases=aliases,
        known_namespaces=known_ns,
        infer_mcp_double_underscore=bool(getattr(args, "infer_mcp", False)),
    )


def _write_json_stdout(data: Any) -> None:
    sys.stdout.write(json.dumps(data, indent=2, ensure_ascii=False) + "\n")


def _cmd_lower_responses(args: argparse.Namespace) -> int:
    payload = _read_json_input(args.input)
    plan = lower_responses_request(payload, infer_mcp_double_underscore=args.infer_mcp)
    _write_json_stdout({
        "payload": plan.payload,
        "namespaceAliases": {
            alias: {"namespace": target.namespace, "name": target.name}
            for alias, target in sorted(plan.index.namespace_aliases.items())
        },
        "customNames": sorted(plan.index.custom_names),
        "rootFunctionNames": sorted(plan.index.root_function_names),
    })
    return 0


def _cmd_restore_responses(args: argparse.Namespace) -> int:
    payload = _read_json_input(args.input)
    index = _load_namespace_index(args)
    restored = restore_responses_json(payload, index, restore_custom_exec=args.restore_custom_exec)
    _write_json_stdout(restored)
    return 0


def _cmd_restore_sse(args: argparse.Namespace) -> int:
    raw_sse = _read_text_input(args.input)
    index = _load_namespace_index(args)
    restored = restore_sse_stream(raw_sse, index, restore_custom_exec=args.restore_custom_exec)
    sys.stdout.write(restored)
    if restored and not restored.endswith("\n"):
        sys.stdout.write("\n")
    return 0


def _cmd_validate_steer(args: argparse.Namespace) -> int:
    payload = _read_json_input(args.input)
    result = validate_turn_steer_payload(
        payload,
        active_turn_id=args.active_turn_id,
        explicit_user_budget=bool(args.explicit_user_budget),
    )
    _write_json_stdout(result)
    return 0 if result["valid"] else 2


def _cmd_map_provider(args: argparse.Namespace) -> int:
    loaded = _read_json_input(args.input)
    if args.models:
        provider_desc = loaded
        models_desc = _read_json_input(args.models)
    elif isinstance(loaded, Mapping) and "provider" in loaded and "models" in loaded:
        provider_desc = loaded["provider"]
        models_desc = loaded["models"]
    elif isinstance(loaded, Mapping):
        provider_desc = loaded
        models_desc = loaded.get("models") if isinstance(loaded.get("models"), (list, Mapping)) else []
    else:
        raise CompatContractError("INVALID_PROVIDER_INPUT", "Expected provider object or {provider, models} wrapper.")

    mapped = map_opencode_provider_and_models(
        provider_desc,
        models_desc,
        reject_inline_secrets=not args.allow_redacted_inline_secrets,
        exclude_utility_ids=not args.keep_utility_ids,
    )
    _write_json_stdout(mapped)
    return 0


def _cmd_map_tool(args: argparse.Namespace) -> int:
    tool_desc = _read_json_input(args.input)
    mapped = map_opencode_tool_descriptor(
        tool_desc,
        reject_inline_secrets=not args.allow_redacted_inline_secrets,
    )
    _write_json_stdout(mapped)
    return 0


def build_parser() -> argparse.ArgumentParser:
    """Create the CLI argument parser."""
    parser = argparse.ArgumentParser(
        prog="omnia-runtime-compat",
        description="Deterministic runtime compatibility checks & schema mappers for Omnia.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_lower = sub.add_parser("lower-responses", help="Flatten /v1/responses namespace and custom tools.")
    p_lower.add_argument("--input", help="Path to request JSON (defaults to stdin).")
    p_lower.add_argument("--infer-mcp", action="store_true", help="Enable mcp__<server>__<tool> heuristic.")
    p_lower.set_defaults(func=_cmd_lower_responses)

    for cmd_name, cmd_help, fn in (
        ("restore-responses", "Restore stripped namespaces on /v1/responses JSON.", _cmd_restore_responses),
        ("restore-sse", "Restore stripped namespaces across a /v1/responses SSE stream.", _cmd_restore_sse),
    ):
        p_rest = sub.add_parser(cmd_name, help=cmd_help)
        p_rest.add_argument("--input", help="Input file path (defaults to stdin).")
        p_rest.add_argument("--tools", help="Request JSON, tools list JSON, or alias map JSON.")
        p_rest.add_argument("--known-namespace", action="append", default=[], help="Known namespace prefix.")
        p_rest.add_argument("--infer-mcp", action="store_true", help="Enable mcp__<server>__<tool> heuristic.")
        p_rest.add_argument("--restore-custom-exec", action="store_true", help="Restore custom exec tool calls.")
        p_rest.set_defaults(func=fn)

    p_steer = sub.add_parser("validate-steer", help="Validate TurnSteer + ADDITIVE_INTAKE payload.")
    p_steer.add_argument("--input", help="Path to TurnSteer JSON (defaults to stdin).")
    p_steer.add_argument("--active-turn-id", help="Optional active turn ID for CAS verification.")
    p_steer.add_argument(
        "--explicit-user-budget",
        action="store_true",
        help="Allow an explicit positive integer tokenBudget/token_budget override.",
    )
    p_steer.set_defaults(func=_cmd_validate_steer)

    p_prov = sub.add_parser("map-provider", help="Map opencode provider + models into Omnia routing JSON.")
    p_prov.add_argument("--input", help="Path to provider or {provider, models} JSON (defaults to stdin).")
    p_prov.add_argument("--models", help="Optional separate models list/dict JSON path.")
    p_prov.add_argument(
        "--allow-redacted-inline-secrets",
        action="store_true",
        help="Strip inline secrets with redaction marker instead of failing closed.",
    )
    p_prov.add_argument("--keep-utility-ids", action="store_true", help="Do not filter plugin/task/mcp/tool IDs.")
    p_prov.set_defaults(func=_cmd_map_provider)

    p_tool = sub.add_parser("map-tool", help="Map opencode tool descriptor into Omnia tool descriptor JSON.")
    p_tool.add_argument("--input", help="Path to tool descriptor JSON (defaults to stdin).")
    p_tool.add_argument(
        "--allow-redacted-inline-secrets",
        action="store_true",
        help="Redact inline secrets with warning instead of failing closed.",
    )
    p_tool.set_defaults(func=_cmd_map_tool)

    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """CLI entrypoint returning process exit code."""
    parser = build_parser()
    args = parser.parse_args(list(argv) if argv is not None else None)
    try:
        return int(args.func(args))
    except CompatContractError as exc:
        sys.stderr.write(json.dumps({"error": {"code": exc.code, "message": exc.message, "details": exc.details}}) + "\n")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
