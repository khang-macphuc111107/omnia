"""Deterministic compatibility contracts for Omnia runtime integration.

Pure Python 3 standard-library implementations extracted from audited contracts
in ``D:/opencode`` (MIT) and ``D:/CodexBetaPatched`` without carrying binary
patches, private credentials, or unsafe runtime bypasses.

Modules covered:
1. ``/v1/responses`` tool-namespace lowering, preservation, and SSE/JSON restoration.
2. ``TurnSteer`` CAS preconditions, typed ``UserInput`` validation, and Omnia
   ``ADDITIVE_INTAKE`` / ``token_budget = NULL`` governance.
3. ``opencode`` provider, model, and tool descriptor mapping into Omnia routing
   and capability receipts with strict secret exclusion/redaction.
"""

from __future__ import annotations

import copy
import json
import re
from dataclasses import dataclass, field
from typing import Any, Mapping, Sequence
from urllib.parse import urlsplit

PSEUDO_ROOT_NAMESPACE = "functions"
RESERVED_CODEMODE_TOOL_NAME = "execute"
MAX_THREAD_ID_LENGTH = 240
CONTROL_CHAR_RE = re.compile(r"[\x00-\x1f\x7f]")
SAFE_IDENT_RE = re.compile(r"[^a-zA-Z0-9_]")
SAFE_TOOL_ID_RE = re.compile(r"[^a-zA-Z0-9_-]")
UTILITY_MODEL_ID_RE = re.compile(r"^(?:plugin|task|mcp|tool)(?:[/:._-]|$)", re.IGNORECASE)
MCP_DOUBLE_UNDERSCORE_RE = re.compile(r"^(mcp__[A-Za-z0-9_-]+)__(.+)$")

RESERVED_CLIENT_METADATA_KEYS = frozenset({
    "session_id",
    "thread_id",
    "turn_id",
    "window_id",
})

ALLOWED_USER_INPUT_DETAILS = frozenset({"auto", "low", "high", "original"})
ALLOWED_ADDITIONAL_CONTEXT_KINDS = frozenset({"untrusted", "application"})
ALLOWED_STEER_MODES = frozenset({
    "ADDITIVE_INTAKE",
    "BOUNDARY_CORRECTION",
    "EXPLICIT_STOP_OR_REPLACE",
})

OMNIA_ROUTING_SCHEMA_VERSION = "omnia.routing.v2.cpp20"
OMNIA_REDACTION_POLICY = "strict_no_secrets_no_prompts_no_raw_urls_v1"

SECRET_KEY_TOKENS = (
    "apikey",
    "api_key",
    "authtoken",
    "auth_token",
    "experimental_bearer_token",
    "bearer",
    "secret",
    "password",
    "passwd",
    "private_key",
    "access_token",
    "refresh_token",
    "session_token",
    "id_token",
    "cookie",
    "set-cookie",
    "x-api-key",
    "authorization",
    "proxy-authorization",
)

SECRET_VALUE_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("bearer_token", re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._\-=/+]{8,}")),
    ("openai_key", re.compile(r"\bsk-(?:proj-|live-|test-|svcacct-)?[A-Za-z0-9_\-]{12,}")),
    ("anthropic_key", re.compile(r"\bsk-ant-[A-Za-z0-9_\-]{12,}")),
    ("github_token", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{16,}")),
    ("google_api_key", re.compile(r"\bAIza[0-9A-Za-z\-_]{20,}")),
    ("slack_token", re.compile(r"\bxox[baprs]-[A-Za-z0-9\-]{10,}")),
    ("pem_private_key", re.compile(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----")),
)

ENV_REF_BRACED_RE = re.compile(r"^\{\s*env\s*:\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}$")
ENV_REF_DOLLAR_RE = re.compile(r"^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$")
ENV_REF_PREFIX_RE = re.compile(r"^env:([A-Za-z_][A-Za-z0-9_]*)$")
SENSITIVE_QUERY_KEYS = frozenset({
    "key",
    "api_key",
    "apikey",
    "token",
    "access_token",
    "auth",
    "authorization",
    "secret",
    "signature",
    "sig",
})


class CompatContractError(ValueError):
    """Raised when a runtime compatibility contract rejects unsafe input."""

    def __init__(self, code: str, message: str, *, details: Any = None) -> None:
        super().__init__(f"[{code}] {message}")
        self.code = code
        self.message = message
        self.details = details


def _is_int(value: Any) -> bool:
    """Return True for integers excluding bool."""
    return isinstance(value, int) and not isinstance(value, bool)


def extract_env_reference(value: Any) -> str | None:
    """Return canonical ``env:VAR`` when *value* is a symbolic env reference, else None."""
    if not isinstance(value, str):
        return None
    stripped = value.strip()
    if not stripped:
        return None
    for pattern in (ENV_REF_BRACED_RE, ENV_REF_DOLLAR_RE, ENV_REF_PREFIX_RE):
        match = pattern.match(stripped)
        if match:
            return f"env:{match.group(1)}"
    return None


def _is_secret_key_name(key: str) -> bool:
    lowered = key.strip().lower()
    if not lowered:
        return False
    return any(tok in lowered for tok in SECRET_KEY_TOKENS)


def _has_secret_url_parts(value: str) -> bool:
    if "://" not in value:
        return False
    try:
        parsed = urlsplit(value)
    except ValueError:
        return False
    if parsed.username or parsed.password:
        return True
    if parsed.query:
        for pair in parsed.query.split("&"):
            k = pair.split("=", 1)[0].strip().lower()
            if k in SENSITIVE_QUERY_KEYS:
                return True
    return False


def sanitize_url_origin(url: Any) -> tuple[str | None, bool]:
    """Strip credentials, query string, and fragment from a URL.

    Returns ``(origin_only_url, had_sensitive_parts)``.
    """
    if not isinstance(url, str) or not url.strip():
        return None, False
    raw = url.strip()
    if "://" not in raw:
        return None, False
    try:
        parsed = urlsplit(raw)
    except ValueError:
        return None, True
    if not parsed.scheme or not parsed.hostname:
        return None, bool(parsed.username or parsed.password or parsed.query)
    had_sensitive = _has_secret_url_parts(raw)
    host = parsed.hostname
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
    port_part = f":{parsed.port}" if parsed.port is not None else ""
    return f"{parsed.scheme.lower()}://{host}{port_part}", had_sensitive


def detect_inline_secrets(obj: Any, *, path: str = "$") -> list[dict[str, str]]:
    """Scan a JSON-like structure for inline secrets without echoing secret values."""
    findings: list[dict[str, str]] = []

    def _walk(node: Any, cur_path: str, parent_key: str | None) -> None:
        if isinstance(node, Mapping):
            for k, v in node.items():
                key_str = str(k)
                next_path = f"{cur_path}.{key_str}"
                if _is_secret_key_name(key_str) and isinstance(v, str) and v.strip():
                    if extract_env_reference(v) is None:
                        findings.append({"path": next_path, "reason": "secret_key_with_inline_value"})
                elif isinstance(v, Mapping) and _is_secret_key_name(key_str):
                    _walk(v, next_path, key_str)
                else:
                    _walk(v, next_path, key_str)
            return
        if isinstance(node, list):
            for idx, item in enumerate(node):
                _walk(item, f"{cur_path}[{idx}]", parent_key)
            return
        if isinstance(node, str) and node.strip():
            if extract_env_reference(node) is not None:
                return
            for label, pattern in SECRET_VALUE_PATTERNS:
                if pattern.search(node):
                    findings.append({"path": cur_path, "reason": f"matched_{label}"})
                    break
            else:
                if _has_secret_url_parts(node):
                    findings.append({"path": cur_path, "reason": "url_contains_credentials_or_secret_query"})

    _walk(obj, path, None)
    return findings


def redact_inline_secrets(obj: Any) -> Any:
    """Return a deep copy of *obj* with inline secrets and secret URL parts stripped."""
    if isinstance(obj, Mapping):
        out: dict[str, Any] = {}
        for k, v in obj.items():
            key_str = str(k)
            if _is_secret_key_name(key_str) and isinstance(v, str):
                env_ref = extract_env_reference(v)
                out[key_str] = env_ref if env_ref is not None else "[REDACTED_SECRET]"
            else:
                out[key_str] = redact_inline_secrets(v)
        return out
    if isinstance(obj, list):
        return [redact_inline_secrets(item) for item in obj]
    if isinstance(obj, str):
        if extract_env_reference(obj) is not None:
            return obj
        redacted = obj
        for _, pattern in SECRET_VALUE_PATTERNS:
            redacted = pattern.sub("[REDACTED_SECRET]", redacted)
        if _has_secret_url_parts(redacted):
            origin, _ = sanitize_url_origin(redacted)
            return origin if origin is not None else "[REDACTED_URL]"
        return redacted
    return obj


# ---------------------------------------------------------------------------
# 1. /v1/responses Tool-Namespace Lowering & Restoration
# ---------------------------------------------------------------------------


def flat_tool_name(namespace: str, name: str) -> str:
    """Flatten ``(namespace, name)`` using Codex/OpenCode ``_`` sanitization."""
    ns_part = SAFE_IDENT_RE.sub("_", (namespace or "").strip() or "namespace")
    name_part = SAFE_IDENT_RE.sub("_", (name or "").strip() or "tool")
    return f"{ns_part}_{name_part}"


def _strip_schema_extensions(value: Any) -> Any:
    """Remove non-standard ``encrypted`` and nested ``input_schema`` keys cleanly."""
    if isinstance(value, list):
        return [_strip_schema_extensions(item) for item in value]
    if isinstance(value, Mapping):
        out: dict[str, Any] = {}
        for key, item in value.items():
            if key in ("encrypted", "input_schema"):
                continue
            out[key] = _strip_schema_extensions(item)
        return out
    return value


def _custom_input_from_argument(arguments: Any) -> str:
    """Extract custom ``exec`` input string from JSON arguments or raw text."""
    if isinstance(arguments, str):
        stripped = arguments.strip()
        if not stripped:
            return ""
        try:
            parsed = json.loads(stripped)
        except json.JSONDecodeError:
            return arguments
        return _custom_input_from_argument(parsed)
    if isinstance(arguments, Mapping):
        for field_name in ("command", "input", "cmd"):
            if isinstance(arguments.get(field_name), str):
                return str(arguments[field_name])
        return json.dumps(arguments, ensure_ascii=False)
    if arguments is None:
        return ""
    return str(arguments)


@dataclass(frozen=True)
class NamespaceTarget:
    """Resolved original ``(namespace, name)`` for a flattened tool alias."""

    namespace: str
    name: str


@dataclass
class NamespaceIndex:
    """Bidirectional alias registry for ``/v1/responses`` namespace restoration."""

    namespace_aliases: dict[str, NamespaceTarget] = field(default_factory=dict)
    forward_aliases: dict[tuple[str, str], str] = field(default_factory=dict)
    custom_names: set[str] = field(default_factory=set)
    known_namespaces: set[str] = field(default_factory=set)
    root_function_names: set[str] = field(default_factory=set)
    infer_mcp_double_underscore: bool = False

    def register_namespace_tool(self, namespace: str, name: str, *, alias: str | None = None) -> str:
        """Register ``(namespace, name)`` unless *namespace* is pseudo-root ``functions``."""
        clean_ns = (namespace or "").strip()
        clean_name = (name or "").strip()
        if not clean_name:
            raise CompatContractError("INVALID_TOOL_NAME", "Tool name must be non-empty.")
        if not clean_ns or clean_ns == PSEUDO_ROOT_NAMESPACE:
            self.root_function_names.add(clean_name)
            return clean_name
        flat = alias.strip() if isinstance(alias, str) and alias.strip() else flat_tool_name(clean_ns, clean_name)
        target = NamespaceTarget(namespace=clean_ns, name=clean_name)
        self.namespace_aliases.setdefault(flat, target)
        self.forward_aliases.setdefault((clean_ns, clean_name), flat)
        self.known_namespaces.add(clean_ns)
        return flat

    def resolve(self, raw_name: str | None, existing_namespace: str | None = None) -> NamespaceTarget | None:
        """Resolve a possibly flattened/stripped function call name to its namespace target."""
        clean_existing_ns = existing_namespace.strip() if isinstance(existing_namespace, str) else ""
        if clean_existing_ns == PSEUDO_ROOT_NAMESPACE:
            clean_existing_ns = ""
        clean_name = raw_name.strip() if isinstance(raw_name, str) else ""

        if clean_existing_ns:
            return NamespaceTarget(namespace=clean_existing_ns, name=clean_name)
        if not clean_name:
            return None
        if clean_name in self.root_function_names:
            return None
        if clean_name in self.namespace_aliases:
            return self.namespace_aliases[clean_name]

        for known_ns in sorted(self.known_namespaces, key=len, reverse=True):
            if known_ns == PSEUDO_ROOT_NAMESPACE:
                continue
            prefix = SAFE_IDENT_RE.sub("_", known_ns) + "_"
            if clean_name.startswith(prefix) and len(clean_name) > len(prefix):
                return NamespaceTarget(namespace=known_ns, name=clean_name[len(prefix):])

        if self.infer_mcp_double_underscore:
            match = MCP_DOUBLE_UNDERSCORE_RE.match(clean_name)
            if match:
                return NamespaceTarget(namespace=match.group(1), name=match.group(2))
        return None


@dataclass
class StreamCallState:
    """Per-item stream state tracked across ``/v1/responses`` SSE frames."""

    raw_name: str = ""
    is_custom: bool = False
    arguments: str = ""


@dataclass
class SseRestorationState:
    """Mutable stream correlation table keyed by ``item_id`` or fallback index."""

    calls: dict[str, StreamCallState] = field(default_factory=dict)


@dataclass
class LoweredResponsesPlan:
    """Lowered ``/v1/responses`` request payload plus namespace restoration index."""

    payload: dict[str, Any]
    index: NamespaceIndex


def build_namespace_index(
    tools: Sequence[Mapping[str, Any]] | None = None,
    *,
    aliases: Mapping[str, Mapping[str, Any] | tuple[str, str]] | None = None,
    known_namespaces: Sequence[str] | None = None,
    infer_mcp_double_underscore: bool = False,
) -> NamespaceIndex:
    """Build a :class:`NamespaceIndex` from ``tools``, explicit ``aliases``, or namespace hints."""
    index = NamespaceIndex(infer_mcp_double_underscore=infer_mcp_double_underscore)

    if known_namespaces:
        for ns in known_namespaces:
            if isinstance(ns, str):
                clean = ns.strip()
                if clean and clean != PSEUDO_ROOT_NAMESPACE:
                    index.known_namespaces.add(clean)

    if aliases:
        for alias_key, target_spec in aliases.items():
            if isinstance(target_spec, tuple) and len(target_spec) == 2:
                ns, tool_name = str(target_spec[0]), str(target_spec[1])
            elif isinstance(target_spec, Mapping):
                ns = str(target_spec.get("namespace") or "")
                tool_name = str(target_spec.get("name") or "")
            else:
                continue
            index.register_namespace_tool(ns, tool_name, alias=str(alias_key))

    for tool in tools or ():
        if not isinstance(tool, Mapping):
            continue
        tool_type = tool.get("type")
        if tool_type == "namespace" and isinstance(tool.get("tools"), list):
            ns_name = str(tool.get("name") or "").strip()
            for child in tool["tools"]:
                if isinstance(child, Mapping) and isinstance(child.get("name"), str):
                    index.register_namespace_tool(ns_name, child["name"])
        elif tool_type == "custom" and isinstance(tool.get("name"), str):
            index.custom_names.add(tool["name"])
        elif tool_type == "function" and isinstance(tool.get("name"), str):
            ns_name = str(tool.get("namespace") or "").strip()
            if ns_name:
                index.register_namespace_tool(ns_name, tool["name"])
            else:
                index.root_function_names.add(tool["name"])

    return index


def _lower_tool_declaration(tool: Any, index: NamespaceIndex, out_tools: list[Any]) -> None:
    if not isinstance(tool, Mapping):
        out_tools.append(copy.deepcopy(tool))
        return
    tool_type = tool.get("type")
    if tool_type == "namespace" and isinstance(tool.get("tools"), list):
        ns_name = str(tool.get("name") or "").strip()
        for child in tool["tools"]:
            if not isinstance(child, Mapping):
                continue
            child_name = str(child.get("name") or "").strip()
            if not child_name:
                continue
            lowered_name = index.register_namespace_tool(ns_name, child_name)
            params = child.get("parameters") or child.get("input_schema") or {"type": "object", "properties": {}}
            lowered_fn: dict[str, Any] = {
                "type": "function",
                "name": lowered_name,
                "parameters": _strip_schema_extensions(copy.deepcopy(params)),
            }
            if isinstance(child.get("description"), str):
                lowered_fn["description"] = child["description"]
            if "strict" in child:
                lowered_fn["strict"] = bool(child["strict"])
            out_tools.append(lowered_fn)
        return
    if tool_type == "custom" and isinstance(tool.get("name"), str):
        custom_name = tool["name"]
        index.custom_names.add(custom_name)
        out_tools.append({
            "type": "function",
            "name": custom_name,
            "description": str(tool.get("description") or f"Execute {custom_name} command."),
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {
                        "type": "string",
                        "description": "Freeform command input.",
                    },
                },
                "required": ["command"],
                "additionalProperties": False,
            },
            "strict": False,
        })
        return
    cloned = copy.deepcopy(dict(tool))
    if cloned.get("namespace") == PSEUDO_ROOT_NAMESPACE:
        cloned.pop("namespace", None)
    if "parameters" in cloned:
        cloned["parameters"] = _strip_schema_extensions(cloned["parameters"])
    out_tools.append(cloned)


def _lower_input_item(item: Any, index: NamespaceIndex) -> Any:
    if not isinstance(item, Mapping):
        return copy.deepcopy(item)
    cloned = copy.deepcopy(dict(item))
    item_type = cloned.get("type")
    if item_type == "function_call":
        ns = str(cloned.get("namespace") or "").strip()
        name = str(cloned.get("name") or "").strip()
        if ns == PSEUDO_ROOT_NAMESPACE:
            cloned.pop("namespace", None)
        elif ns and name:
            cloned["name"] = index.forward_aliases.get((ns, name)) or index.register_namespace_tool(ns, name)
            cloned.pop("namespace", None)
        return cloned
    if item_type == "custom_tool_call":
        return {
            "type": "function_call",
            "call_id": cloned.get("call_id"),
            "name": cloned.get("name"),
            "arguments": json.dumps({"command": cloned.get("input", "")}, ensure_ascii=False),
            **({"id": cloned["id"]} if "id" in cloned else {}),
        }
    if item_type == "custom_tool_call_output":
        return {
            "type": "function_call_output",
            "call_id": cloned.get("call_id"),
            "output": cloned.get("output", ""),
        }
    if item_type == "agent_message":
        text_val = cloned.get("text") or cloned.get("message") or ""
        return {
            "type": "message",
            "role": "assistant",
            "content": [{"type": "output_text", "text": str(text_val)}],
        }
    return cloned


def lower_responses_request(
    payload: Mapping[str, Any],
    *,
    infer_mcp_double_underscore: bool = False,
) -> LoweredResponsesPlan:
    """Lower Codex ``namespace`` / ``custom`` tools into flat functions and return a restoration index."""
    if not isinstance(payload, Mapping):
        raise CompatContractError("INVALID_PAYLOAD", "Request payload must be a JSON object.")
    body = copy.deepcopy(dict(payload))
    index = NamespaceIndex(infer_mcp_double_underscore=infer_mcp_double_underscore)

    if isinstance(body.get("tools"), list):
        lowered_tools: list[Any] = []
        for tool in body["tools"]:
            _lower_tool_declaration(tool, index, lowered_tools)
        body["tools"] = lowered_tools

    if isinstance(body.get("input"), list):
        body["input"] = [_lower_input_item(item, index) for item in body["input"]]

    tool_choice = body.get("tool_choice")
    if isinstance(tool_choice, Mapping) and tool_choice.get("type") == "function":
        tc = dict(tool_choice)
        tc_ns = str(tc.get("namespace") or "").strip()
        tc_name = str(tc.get("name") or "").strip()
        if tc_ns == PSEUDO_ROOT_NAMESPACE:
            tc.pop("namespace", None)
        elif tc_ns and tc_name:
            tc["name"] = index.forward_aliases.get((tc_ns, tc_name)) or index.register_namespace_tool(tc_ns, tc_name)
            tc.pop("namespace", None)
        body["tool_choice"] = tc

    return LoweredResponsesPlan(payload=body, index=index)


def _restore_function_call_item(
    item: Any,
    index: NamespaceIndex,
    *,
    restore_custom_exec: bool = False,
    for_added_stream: bool = False,
) -> Any:
    """Restore stripped ``namespace`` (or custom exec) on a ``function_call`` item."""
    if not isinstance(item, Mapping):
        return copy.deepcopy(item)
    cloned = copy.deepcopy(dict(item))
    if cloned.get("type") != "function_call":
        return cloned

    existing_ns = cloned.get("namespace")
    if existing_ns == PSEUDO_ROOT_NAMESPACE:
        cloned.pop("namespace", None)
        return cloned

    raw_name = str(cloned.get("name") or "")
    target = index.resolve(raw_name, existing_ns if isinstance(existing_ns, str) else None)
    if target is not None:
        cloned["name"] = target.name
        if target.namespace and target.namespace != PSEUDO_ROOT_NAMESPACE:
            cloned["namespace"] = target.namespace
        else:
            cloned.pop("namespace", None)
        return cloned

    if restore_custom_exec and raw_name in index.custom_names:
        custom_item: dict[str, Any] = {
            "type": "custom_tool_call",
            "status": cloned.get("status") or ("in_progress" if for_added_stream else "completed"),
            "call_id": cloned.get("call_id"),
            "name": raw_name,
            "input": "" if for_added_stream else _custom_input_from_argument(cloned.get("arguments")),
        }
        if "id" in cloned:
            custom_item["id"] = cloned["id"]
        return custom_item

    return cloned


def restore_responses_json(
    payload: Mapping[str, Any],
    index: NamespaceIndex,
    *,
    restore_custom_exec: bool = False,
) -> dict[str, Any]:
    """Restore stripped tool namespaces in a non-streaming ``/v1/responses`` payload.

    Leaves non-tool output items and unrelated metadata fields unmutated.
    """
    if not isinstance(payload, Mapping):
        raise CompatContractError("INVALID_PAYLOAD", "Response payload must be a JSON object.")
    result = copy.deepcopy(dict(payload))
    if isinstance(result.get("output"), list):
        result["output"] = [
            _restore_function_call_item(item, index, restore_custom_exec=restore_custom_exec)
            for item in result["output"]
        ]
    if isinstance(result.get("response"), Mapping):
        result["response"] = restore_responses_json(
            result["response"],
            index,
            restore_custom_exec=restore_custom_exec,
        )
    return result


def _sse_correlation_key(event: Mapping[str, Any], item: Mapping[str, Any] | None = None) -> str | None:
    if isinstance(item, Mapping):
        for key in ("id", "call_id"):
            val = item.get(key)
            if isinstance(val, str) and val:
                return val
    for key in ("item_id", "call_id"):
        val = event.get(key)
        if isinstance(val, str) and val:
            return val
    output_idx = event.get("output_index")
    if _is_int(output_idx):
        return f"output_index:{output_idx}"
    return None


def restore_sse_event(
    event: Mapping[str, Any],
    state: SseRestorationState,
    index: NamespaceIndex,
    *,
    restore_custom_exec: bool = False,
) -> dict[str, Any]:
    """Restore stripped MCP tool namespaces on a single parsed SSE event JSON object."""
    if not isinstance(event, Mapping):
        raise CompatContractError("INVALID_SSE_EVENT", "SSE event object must be a JSON object.")
    result = copy.deepcopy(dict(event))
    event_type = result.get("type")

    if event_type == "response.output_item.added" and isinstance(result.get("item"), Mapping):
        item = result["item"]
        corr_key = _sse_correlation_key(result, item)
        if item.get("type") == "function_call":
            raw_name = str(item.get("name") or "")
            is_custom = bool(restore_custom_exec and raw_name in index.custom_names and index.resolve(raw_name) is None)
            if corr_key:
                state.calls[corr_key] = StreamCallState(
                    raw_name=raw_name,
                    is_custom=is_custom,
                    arguments=str(item.get("arguments") or ""),
                )
            result["item"] = _restore_function_call_item(
                item,
                index,
                restore_custom_exec=restore_custom_exec,
                for_added_stream=True,
            )
        return result

    if event_type == "response.function_call_arguments.delta":
        corr_key = _sse_correlation_key(result)
        call_state = state.calls.get(corr_key) if corr_key else None
        if call_state is not None:
            delta_text = str(result.get("delta") or "")
            call_state.arguments += delta_text
            if call_state.is_custom and restore_custom_exec:
                result["type"] = "response.custom_tool_call_input.delta"
                return result
        if result.get("namespace") == PSEUDO_ROOT_NAMESPACE:
            result.pop("namespace", None)
        return result

    if event_type == "response.function_call_arguments.done":
        corr_key = _sse_correlation_key(result)
        call_state = state.calls.get(corr_key) if corr_key else None
        if call_state is not None and call_state.is_custom and restore_custom_exec:
            final_args = result.get("arguments") if "arguments" in result else call_state.arguments
            out_custom = dict(result)
            out_custom["type"] = "response.custom_tool_call_input.done"
            out_custom["input"] = _custom_input_from_argument(final_args)
            out_custom["name"] = call_state.raw_name
            out_custom.pop("arguments", None)
            return out_custom
        raw_name = str(result.get("name") or (call_state.raw_name if call_state else "") or "")
        existing_ns = result.get("namespace")
        if existing_ns == PSEUDO_ROOT_NAMESPACE:
            result.pop("namespace", None)
            existing_ns = None
        target = index.resolve(raw_name, existing_ns if isinstance(existing_ns, str) else None)
        if target is not None:
            result["name"] = target.name
            if target.namespace and target.namespace != PSEUDO_ROOT_NAMESPACE:
                result["namespace"] = target.namespace
        return result

    if event_type == "response.output_item.done" and isinstance(result.get("item"), Mapping):
        result["item"] = _restore_function_call_item(
            result["item"],
            index,
            restore_custom_exec=restore_custom_exec,
            for_added_stream=False,
        )
        return result

    if event_type in ("response.completed", "response.done", "response.incomplete") and isinstance(
        result.get("response"), Mapping
    ):
        result["response"] = restore_responses_json(
            result["response"],
            index,
            restore_custom_exec=restore_custom_exec,
        )
        return result

    return result


def restore_sse_stream(
    raw_sse_text: str,
    index: NamespaceIndex,
    *,
    restore_custom_exec: bool = False,
) -> str:
    """Transform a complete SSE frame stream while leaving unrelated frames untouched."""
    if not isinstance(raw_sse_text, str):
        raise CompatContractError("INVALID_SSE_STREAM", "SSE text must be a string.")
    normalized = raw_sse_text.replace("\r\n", "\n")
    blocks = normalized.split("\n\n")
    state = SseRestorationState()
    rendered_blocks: list[str] = []

    for block in blocks:
        if not block.strip():
            rendered_blocks.append(block)
            continue
        lines = block.split("\n")
        data_lines: list[str] = []
        other_lines: list[str] = []
        event_line_idx: int | None = None
        event_header_val: str | None = None

        for idx, line in enumerate(lines):
            if line.startswith("data:"):
                data_lines.append(line[5:].lstrip(" "))
            else:
                if line.startswith("event:"):
                    event_line_idx = len(other_lines)
                    event_header_val = line[6:].strip()
                other_lines.append(line)

        if not data_lines:
            rendered_blocks.append(block)
            continue

        raw_data = "\n".join(data_lines)
        if raw_data.strip() == "[DONE]":
            rendered_blocks.append(block)
            continue

        try:
            parsed = json.loads(raw_data)
        except json.JSONDecodeError:
            rendered_blocks.append(block)
            continue

        if not isinstance(parsed, Mapping):
            rendered_blocks.append(block)
            continue

        restored = restore_sse_event(
            parsed,
            state,
            index,
            restore_custom_exec=restore_custom_exec,
        )
        if event_line_idx is not None and isinstance(restored.get("type"), str) and event_header_val:
            if restored["type"] != event_header_val:
                other_lines[event_line_idx] = f"event: {restored['type']}"

        rebuilt_lines = list(other_lines) + [f"data: {json.dumps(restored, ensure_ascii=False)}"]
        rendered_blocks.append("\n".join(rebuilt_lines))

    return "\n\n".join(rendered_blocks)


# ---------------------------------------------------------------------------
# 2. TurnSteer + ADDITIVE_INTAKE Payload Validator
# ---------------------------------------------------------------------------


def _validate_nonempty_str(
    value: Any,
    field_path: str,
    errors: list[dict[str, str]],
    *,
    max_len: int | None = None,
    reject_control_chars: bool = False,
) -> str | None:
    if not isinstance(value, str) or not value.strip():
        errors.append({
            "code": "INVALID_REQUIRED_STRING",
            "path": field_path,
            "message": f"{field_path} must be a non-empty string.",
        })
        return None
    if max_len is not None and len(value) > max_len:
        errors.append({
            "code": "STRING_TOO_LONG",
            "path": field_path,
            "message": f"{field_path} exceeds max length {max_len}.",
        })
    if reject_control_chars and CONTROL_CHAR_RE.search(value):
        errors.append({
            "code": "INVALID_CONTROL_CHARS",
            "path": field_path,
            "message": f"{field_path} contains forbidden ASCII control characters.",
        })
    return value


def _validate_detail_field(value: Any, path: str, errors: list[dict[str, str]]) -> None:
    if value is not None and (not isinstance(value, str) or value not in ALLOWED_USER_INPUT_DETAILS):
        errors.append({
            "code": "INVALID_IMAGE_DETAIL",
            "path": path,
            "message": f"{path} must be null or one of {sorted(ALLOWED_USER_INPUT_DETAILS)}.",
        })


def _validate_user_input_item(item: Any, idx: int, errors: list[dict[str, str]]) -> str | None:
    path = f"$.input[{idx}]"
    if not isinstance(item, Mapping):
        errors.append({
            "code": "INVALID_USER_INPUT_ITEM",
            "path": path,
            "message": "Each UserInput item must be an object.",
        })
        return None
    kind = item.get("type")
    if not isinstance(kind, str) or not kind:
        errors.append({
            "code": "MISSING_USER_INPUT_TYPE",
            "path": f"{path}.type",
            "message": "UserInput item requires a non-empty 'type'.",
        })
        return None

    if kind == "text":
        _validate_nonempty_str(item.get("text"), f"{path}.text", errors)
        elements = item.get("text_elements")
        if elements is not None:
            if not isinstance(elements, list):
                errors.append({
                    "code": "INVALID_TEXT_ELEMENTS",
                    "path": f"{path}.text_elements",
                    "message": "text_elements must be a list.",
                })
            else:
                for el_idx, el in enumerate(elements):
                    el_path = f"{path}.text_elements[{el_idx}]"
                    if not isinstance(el, Mapping):
                        errors.append({
                            "code": "INVALID_TEXT_ELEMENT",
                            "path": el_path,
                            "message": "TextElement must be an object.",
                        })
                        continue
                    br = el.get("byteRange")
                    if not isinstance(br, Mapping) or not _is_int(br.get("start")) or not _is_int(br.get("end")):
                        errors.append({
                            "code": "INVALID_BYTE_RANGE",
                            "path": f"{el_path}.byteRange",
                            "message": "byteRange requires integer 'start' and 'end'.",
                        })
                    elif br["start"] < 0 or br["end"] < br["start"]:
                        errors.append({
                            "code": "INVALID_BYTE_RANGE_BOUNDS",
                            "path": f"{el_path}.byteRange",
                            "message": "byteRange must satisfy 0 <= start <= end.",
                        })
                    ph = el.get("placeholder")
                    if ph is not None and not isinstance(ph, str):
                        errors.append({
                            "code": "INVALID_PLACEHOLDER",
                            "path": f"{el_path}.placeholder",
                            "message": "placeholder must be null or string.",
                        })
        return kind

    if kind == "image":
        _validate_nonempty_str(item.get("url"), f"{path}.url", errors)
        _validate_detail_field(item.get("detail"), f"{path}.detail", errors)
        return kind

    if kind == "localImage":
        _validate_nonempty_str(item.get("path"), f"{path}.path", errors)
        _validate_detail_field(item.get("detail"), f"{path}.detail", errors)
        return kind

    if kind == "audio":
        _validate_nonempty_str(item.get("url"), f"{path}.url", errors)
        return kind

    if kind == "localAudio":
        _validate_nonempty_str(item.get("path"), f"{path}.path", errors)
        return kind

    if kind in ("skill", "mention"):
        _validate_nonempty_str(item.get("name"), f"{path}.name", errors)
        _validate_nonempty_str(item.get("path"), f"{path}.path", errors)
        return kind

    errors.append({
        "code": "INVALID_USER_INPUT_TYPE",
        "path": f"{path}.type",
        "message": f"Unsupported UserInput type '{kind}'.",
    })
    return None


def validate_turn_steer_payload(
    payload: Mapping[str, Any],
    *,
    active_turn_id: str | None = None,
    explicit_user_budget: bool = False,
) -> dict[str, Any]:
    """Validate a Codex ``TurnSteerParams`` payload paired with Omnia ``ADDITIVE_INTAKE`` rules.

    Returns a deterministic, secret-free validation receipt dict.
    """
    errors: list[dict[str, str]] = []
    warnings: list[str] = []

    if not isinstance(payload, Mapping):
        return {
            "valid": False,
            "errors": [{"code": "INVALID_PAYLOAD", "path": "$", "message": "Payload must be a JSON object."}],
            "warnings": [],
            "receipt": None,
        }

    thread_id = _validate_nonempty_str(
        payload.get("threadId"),
        "$.threadId",
        errors,
        max_len=MAX_THREAD_ID_LENGTH,
        reject_control_chars=True,
    )
    expected_turn_id = _validate_nonempty_str(
        payload.get("expectedTurnId"),
        "$.expectedTurnId",
        errors,
        reject_control_chars=True,
    )

    if active_turn_id is not None and expected_turn_id is not None and expected_turn_id != active_turn_id:
        errors.append({
            "code": "CAS_TURN_MISMATCH",
            "path": "$.expectedTurnId",
            "message": f"expectedTurnId '{expected_turn_id}' does not match active turn '{active_turn_id}'.",
        })

    raw_input = payload.get("input")
    input_types: list[str] = []
    if not isinstance(raw_input, list) or len(raw_input) == 0:
        errors.append({
            "code": "EMPTY_USER_INPUT",
            "path": "$.input",
            "message": "input must be a non-empty array of typed UserInput items.",
        })
    else:
        for idx, item in enumerate(raw_input):
            kind = _validate_user_input_item(item, idx, errors)
            if kind is not None:
                input_types.append(kind)

    client_msg_id = payload.get("clientUserMessageId")
    if client_msg_id is not None and (not isinstance(client_msg_id, str) or not client_msg_id.strip()):
        errors.append({
            "code": "INVALID_CLIENT_MESSAGE_ID",
            "path": "$.clientUserMessageId",
            "message": "clientUserMessageId must be null or a non-empty string.",
        })

    add_ctx = payload.get("additionalContext")
    if add_ctx is not None:
        if not isinstance(add_ctx, Mapping):
            errors.append({
                "code": "INVALID_ADDITIONAL_CONTEXT",
                "path": "$.additionalContext",
                "message": "additionalContext must be null or an object map.",
            })
        else:
            for ctx_key, ctx_entry in add_ctx.items():
                ctx_path = f"$.additionalContext.{ctx_key}"
                if not isinstance(ctx_entry, Mapping):
                    errors.append({
                        "code": "INVALID_ADDITIONAL_CONTEXT_ENTRY",
                        "path": ctx_path,
                        "message": "additionalContext entry must be an object.",
                    })
                    continue
                if ctx_entry.get("kind") not in ALLOWED_ADDITIONAL_CONTEXT_KINDS:
                    errors.append({
                        "code": "INVALID_ADDITIONAL_CONTEXT_KIND",
                        "path": f"{ctx_path}.kind",
                        "message": f"kind must be one of {sorted(ALLOWED_ADDITIONAL_CONTEXT_KINDS)}.",
                    })
                if not isinstance(ctx_entry.get("value"), str):
                    errors.append({
                        "code": "INVALID_ADDITIONAL_CONTEXT_VALUE",
                        "path": f"{ctx_path}.value",
                        "message": "additionalContext entry value must be a string.",
                    })

    resp_meta = payload.get("responsesapiClientMetadata")
    meta_keys: list[str] = []
    if resp_meta is not None:
        if not isinstance(resp_meta, Mapping):
            errors.append({
                "code": "INVALID_CLIENT_METADATA",
                "path": "$.responsesapiClientMetadata",
                "message": "responsesapiClientMetadata must be null or a string-valued map.",
            })
        else:
            for m_key, m_val in resp_meta.items():
                key_str = str(m_key)
                meta_keys.append(key_str)
                if key_str in RESERVED_CLIENT_METADATA_KEYS:
                    errors.append({
                        "code": "RESERVED_METADATA_KEY_OVERRIDE",
                        "path": f"$.responsesapiClientMetadata.{key_str}",
                        "message": f"Reserved metadata key '{key_str}' cannot be overridden by client metadata.",
                    })
                if not isinstance(m_val, str):
                    errors.append({
                        "code": "INVALID_CLIENT_METADATA_VALUE",
                        "path": f"$.responsesapiClientMetadata.{key_str}",
                        "message": "responsesapiClientMetadata values must be strings.",
                    })

    # Omnia ADDITIVE_INTAKE governance check
    has_omnia_steer = "omniaSteer" in payload
    raw_omnia_steer = payload.get("omniaSteer")
    if has_omnia_steer and raw_omnia_steer is not None and not isinstance(raw_omnia_steer, Mapping):
        errors.append({
            "code": "INVALID_OMNIA_STEER",
            "path": "$.omniaSteer",
            "message": "omniaSteer must be null or a mapping object.",
        })
        omnia_steer_map: Mapping[str, Any] = {}
    else:
        omnia_steer_map = raw_omnia_steer if isinstance(raw_omnia_steer, Mapping) else {}

    raw_mode = next(
        (
            candidate
            for candidate in (
                omnia_steer_map.get("steerMode"),
                omnia_steer_map.get("mode"),
                payload.get("steerMode"),
                payload.get("mode"),
            )
            if candidate is not None
        ),
        "ADDITIVE_INTAKE",
    )
    if not isinstance(raw_mode, str) or raw_mode not in ALLOWED_STEER_MODES:
        errors.append({
            "code": "INVALID_STEER_MODE",
            "path": "$.steerMode",
            "message": f"Steer mode must be one of {sorted(ALLOWED_STEER_MODES)}.",
        })
        steer_mode = None
    else:
        steer_mode = raw_mode

    budget_entries: list[tuple[str, Any]] = []
    for scope_prefix, scope_map in (("$.omniaSteer", omnia_steer_map), ("$", payload)):
        for budget_key in ("tokenBudget", "token_budget"):
            if budget_key in scope_map and scope_map[budget_key] is not None:
                budget_entries.append((f"{scope_prefix}.{budget_key}", scope_map[budget_key]))

    validated_token_budget: int | None = None
    if not explicit_user_budget:
        for b_path, _ in budget_entries:
            errors.append({
                "code": "FORBIDDEN_TOKEN_BUDGET_CAP",
                "path": b_path,
                "message": "Omnia ADDITIVE_INTAKE requires token_budget to remain null/unset.",
            })
    elif budget_entries:
        valid_budgets: list[int] = []
        for b_path, b_val in budget_entries:
            if not _is_int(b_val) or b_val <= 0:
                errors.append({
                    "code": "INVALID_TOKEN_BUDGET",
                    "path": b_path,
                    "message": f"{b_path} must be a positive integer when explicit_user_budget=True.",
                })
            else:
                valid_budgets.append(b_val)
        if len(set(valid_budgets)) > 1:
            errors.append({
                "code": "CONFLICTING_TOKEN_BUDGET",
                "path": "$.tokenBudget",
                "message": "Conflicting explicit tokenBudget/token_budget values specified.",
            })
        elif len(valid_budgets) == len(budget_entries):
            validated_token_budget = valid_budgets[0]

    if steer_mode == "EXPLICIT_STOP_OR_REPLACE":
        has_target = any(
            scope_map.get(key)
            for scope_map in (omnia_steer_map, payload)
            for key in ("supersedesItemId", "supersedes_item_id", "targetItemId", "reason")
        )
        if not has_target:
            errors.append({
                "code": "MISSING_SUPERSESSION_TARGET",
                "path": "$.supersedesItemId",
                "message": "EXPLICIT_STOP_OR_REPLACE requires supersedesItemId/targetItemId or explicit reason.",
            })

    secret_findings = detect_inline_secrets(payload)
    if secret_findings:
        warnings.append("inline_secret_patterns_detected_and_omitted_from_receipt")

    receipt = {
        "threadId": thread_id,
        "expectedTurnId": expected_turn_id,
        "casChecked": active_turn_id is not None,
        "steerMode": steer_mode,
        "tokenBudget": validated_token_budget,
        "inputItemCount": len(raw_input) if isinstance(raw_input, list) else 0,
        "inputTypes": input_types,
        "clientMetadataKeys": sorted(meta_keys),
        "additionalContextCount": len(add_ctx) if isinstance(add_ctx, Mapping) else 0,
        "inlineSecretsDetected": len(secret_findings) > 0,
        "redactionPolicy": OMNIA_REDACTION_POLICY,
    }
    return {
        "valid": len(errors) == 0,
        "errors": errors,
        "warnings": warnings,
        "receipt": receipt,
    }


# ---------------------------------------------------------------------------
# 3. opencode Provider, Model & Tool Descriptor -> Omnia Routing Mapper
# ---------------------------------------------------------------------------


def _infer_adapter_family(provider_desc: Mapping[str, Any]) -> str:
    pkg = str(provider_desc.get("package") or provider_desc.get("npm") or "").strip().lower()
    canonical = str(provider_desc.get("canonical") or provider_desc.get("id") or "").strip().lower()
    for token in (
        "openai-responses",
        "openai-compatible-responses",
        "open-responses",
        "claude-agent",
        "anthropic",
        "google",
        "openai",
        "opencode",
    ):
        if token in pkg:
            return token
    if pkg:
        tail = pkg.rstrip("/").split("/")[-1]
        if tail:
            return tail
    return canonical or "custom"


def _infer_privacy_tier(
    provider_desc: Mapping[str, Any],
    origin: str | None,
) -> str:
    settings = provider_desc.get("settings") if isinstance(provider_desc.get("settings"), Mapping) else {}
    explicit = provider_desc.get("privacyTier") or settings.get("privacyTier")
    if isinstance(explicit, str):
        norm = explicit.strip().lower()
        mapping = {
            "local_only": "local_only",
            "strict_local_zero_retention": "local_only",
            "zero_data_retention": "zero_data_retention",
            "enterprise_zdr": "zero_data_retention",
            "private_vpc": "private_vpc",
            "public": "public",
            "standard_cloud": "public",
        }
        if norm in mapping:
            return mapping[norm]

    provider_id = str(provider_desc.get("canonical") or provider_desc.get("id") or "").lower()
    if origin:
        host = (urlsplit(origin).hostname or "").lower()
        if host in ("localhost", "127.0.0.1", "::1"):
            return "local_only"
        if host.startswith(("10.", "192.168.")) or (
            host.startswith("172.") and host.split(".")[1].isdigit() and 16 <= int(host.split(".")[1]) <= 31
        ):
            return "private_vpc"
    if provider_id in ("ollama", "lmstudio", "llamacpp", "llama.cpp", "local"):
        return "local_only"
    if settings.get("zeroDataRetention") is True or settings.get("zdr") is True:
        return "zero_data_retention"
    return "public"


def _privacy_ui_label(privacy_tier: str) -> str:
    return {
        "local_only": "strict_local_zero_retention",
        "zero_data_retention": "enterprise_zdr",
        "private_vpc": "private_vpc",
        "public": "standard_cloud",
    }.get(privacy_tier, "standard_cloud")


def _extract_provider_credential_status(provider_desc: Mapping[str, Any]) -> tuple[bool, str | None, list[dict[str, str]]]:
    """Extract non-secret ``(credential_present, credential_ref, secret_findings)``."""
    settings = provider_desc.get("settings") if isinstance(provider_desc.get("settings"), Mapping) else {}
    integration_id = provider_desc.get("integrationID")
    findings = detect_inline_secrets(provider_desc)

    env_refs: list[str] = []
    for container in (provider_desc, settings):
        for key in ("apiKey", "api_key", "authToken", "auth_token", "credentialRef"):
            if key in container:
                env_ref = extract_env_reference(container.get(key))
                if env_ref is not None:
                    env_refs.append(env_ref)

    raw_env_list = provider_desc.get("env")
    if isinstance(raw_env_list, list):
        for env_name in raw_env_list:
            if isinstance(env_name, str) and env_name.strip():
                env_refs.append(f"env:{env_name.strip()}")

    if env_refs:
        return True, env_refs[0], findings
    if isinstance(integration_id, str) and integration_id.strip():
        return True, f"integration:{integration_id.strip()}", findings
    if findings:
        return True, "redacted:inline_secret_omitted", findings
    return False, None, findings


def _is_utility_model_entry(model_id: str, model_desc: Mapping[str, Any]) -> bool:
    if UTILITY_MODEL_ID_RE.match(model_id):
        return True
    for key in ("kind", "type", "category"):
        val = str(model_desc.get(key) or "").strip().lower()
        if val in ("plugin", "task", "tool"):
            return True
    for marker in ("pluginId", "plugin_id", "taskId", "task_id", "toolId", "tool_id"):
        if marker in model_desc and model_desc.get(marker) is not None:
            return True
    return False


def _usd_per_million_to_microunits(value: Any) -> int | None:
    if value is None or isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if value < 0:
        return None
    return round(float(value) * 1_000_000)


def _normalize_model_capabilities(model_desc: Mapping[str, Any]) -> dict[str, Any]:
    raw_caps = model_desc.get("capabilities") if isinstance(model_desc.get("capabilities"), Mapping) else {}
    modalities = model_desc.get("modalities") if isinstance(model_desc.get("modalities"), Mapping) else {}

    input_mods = raw_caps.get("input") if isinstance(raw_caps.get("input"), list) else modalities.get("input") or []
    output_mods = raw_caps.get("output") if isinstance(raw_caps.get("output"), list) else modalities.get("output") or []
    input_set = {str(m).lower() for m in input_mods}
    output_set = {str(m).lower() for m in output_mods}

    tools_field = raw_caps.get("tools")
    if isinstance(tools_field, Mapping):
        tool_use = bool(tools_field.get("supported", False))
    elif isinstance(tools_field, bool):
        tool_use = tools_field
    else:
        tool_use = bool(model_desc.get("tool_call", False))

    reasoning_field = raw_caps.get("reasoning")
    if isinstance(reasoning_field, Mapping):
        reasoning = bool(reasoning_field.get("supported", False))
    elif isinstance(reasoning_field, bool):
        reasoning = reasoning_field
    else:
        reasoning = bool(model_desc.get("reasoning", False))

    structured_output = bool(
        raw_caps.get("structuredOutput")
        if "structuredOutput" in raw_caps
        else raw_caps.get("structured_output", False)
    )
    streaming = bool(raw_caps.get("streaming", True))

    model_type = str(model_desc.get("type") or "chat").lower()
    has_text = ("text" in input_set or "text" in output_set) or (
        not input_set and not output_set and model_type in ("chat", "decision")
    )
    has_vision = "image" in input_set or "vision" in input_set
    has_audio = "audio" in input_set or "audio" in output_set

    tags: list[str] = []
    if has_text:
        tags.append("text_generation")
    if tool_use:
        tags.append("tool_use")
    if has_vision:
        tags.append("multimodal_vision")
    if has_audio:
        tags.append("audio_io")
    if structured_output:
        tags.append("structured_output")
    if reasoning:
        tags.append("reasoning")
    if streaming:
        tags.append("streaming")

    return {
        "flags": {
            "text": has_text,
            "vision": has_vision,
            "audio": has_audio,
            "toolUse": tool_use,
            "structuredOutput": structured_output,
            "streaming": streaming,
            "reasoning": reasoning,
        },
        "tags": tags,
    }


def _extract_model_pricing(model_desc: Mapping[str, Any]) -> dict[str, int | None]:
    raw_cost = model_desc.get("cost")
    tier: Mapping[str, Any] | None = None
    if isinstance(raw_cost, list) and raw_cost and isinstance(raw_cost[0], Mapping):
        tier = raw_cost[0]
    elif isinstance(raw_cost, Mapping):
        tier = raw_cost
    if tier is None:
        return {
            "inputPerMillionMicrounits": None,
            "outputPerMillionMicrounits": None,
            "cacheReadPerMillionMicrounits": None,
            "cacheWritePerMillionMicrounits": None,
        }
    cache = tier.get("cache") if isinstance(tier.get("cache"), Mapping) else {}
    return {
        "inputPerMillionMicrounits": _usd_per_million_to_microunits(tier.get("input")),
        "outputPerMillionMicrounits": _usd_per_million_to_microunits(tier.get("output")),
        "cacheReadPerMillionMicrounits": _usd_per_million_to_microunits(
            cache.get("read") if "read" in cache else tier.get("cache_read")
        ),
        "cacheWritePerMillionMicrounits": _usd_per_million_to_microunits(
            cache.get("write") if "write" in cache else tier.get("cache_write")
        ),
    }


def map_opencode_provider_and_models(
    provider_desc: Mapping[str, Any],
    models_desc: Sequence[Mapping[str, Any]] | Mapping[str, Mapping[str, Any]],
    *,
    reject_inline_secrets: bool = True,
    exclude_utility_ids: bool = True,
) -> dict[str, Any]:
    """Translate ``opencode`` ``Provider.Info`` and ``Model.Info`` descriptors into Omnia routing candidates.

    Guarantees exported receipts never retain inline API keys, Bearer tokens, or secret URL parts.
    """
    if not isinstance(provider_desc, Mapping):
        raise CompatContractError("INVALID_PROVIDER_DESCRIPTOR", "provider_desc must be an object.")
    provider_id = str(provider_desc.get("id") or "").strip()
    if not provider_id:
        raise CompatContractError("MISSING_PROVIDER_ID", "provider_desc requires a non-empty 'id'.")

    cred_present, cred_ref, provider_secrets = _extract_provider_credential_status(provider_desc)
    model_secrets = detect_inline_secrets(models_desc, path="$.models")
    all_secret_findings = provider_secrets + model_secrets
    if reject_inline_secrets and all_secret_findings:
        raise CompatContractError(
            "INLINE_SECRET_REJECTED",
            "Provider or model descriptor contains inline secret material; use env/vault reference instead.",
            details={"paths": [f["path"] for f in all_secret_findings]},
        )

    settings = provider_desc.get("settings") if isinstance(provider_desc.get("settings"), Mapping) else {}
    raw_base_url = settings.get("baseURL") or settings.get("baseUrl") or provider_desc.get("api")
    endpoint_origin, url_had_sensitive = sanitize_url_origin(raw_base_url)

    canonical_provider = str(provider_desc.get("canonical") or provider_id)
    activation = str(provider_desc.get("activation") or "auto").lower()
    adapter_family = _infer_adapter_family(provider_desc)
    privacy_tier = _infer_privacy_tier(provider_desc, endpoint_origin)

    if isinstance(models_desc, Mapping):
        model_items = [
            {"id": key, **val} if isinstance(val, Mapping) and "id" not in val else val
            for key, val in models_desc.items()
        ]
    elif isinstance(models_desc, Sequence) and not isinstance(models_desc, (str, bytes)):
        model_items = list(models_desc)
    else:
        raise CompatContractError("INVALID_MODELS_DESCRIPTOR", "models_desc must be a sequence or mapping.")

    candidates: list[dict[str, Any]] = []
    excluded_models: list[dict[str, str]] = []

    for model in model_items:
        if not isinstance(model, Mapping):
            continue
        model_id = str(model.get("modelID") or model.get("id") or "").strip()
        if not model_id:
            continue
        if exclude_utility_ids and _is_utility_model_entry(model_id, model):
            excluded_models.append({"id": model_id, "reason": "utility_or_non_model_entry"})
            continue

        caps = _normalize_model_capabilities(model)
        limits = model.get("limit") if isinstance(model.get("limit"), Mapping) else {}
        ctx_limit = limits.get("context") if _is_int(limits.get("context")) and limits["context"] >= 0 else None
        in_limit = limits.get("input") if _is_int(limits.get("input")) and limits["input"] >= 0 else None
        out_limit = limits.get("output") if _is_int(limits.get("output")) and limits["output"] >= 0 else None

        status = str(model.get("status") or "active").lower()
        model_enabled = bool(model.get("enabled", True))
        candidate_enabled = activation != "disabled" and model_enabled and status != "deprecated"

        compat_raw = model.get("compatibility")
        if not isinstance(compat_raw, Mapping):
            compat_raw = provider_desc.get("compatibility") if isinstance(provider_desc.get("compatibility"), Mapping) else {}

        candidates.append({
            "candidateId": f"{provider_id}:{model_id}",
            "providerId": provider_id,
            "canonicalProviderId": canonical_provider,
            "modelId": model_id,
            "canonicalModelId": str(model.get("canonical") or model_id),
            "displayName": str(model.get("name") or model_id),
            "adapterFamily": adapter_family,
            "authBoundary": cred_ref or "unconfigured",
            "credentialPresent": cred_present,
            "credentialRef": cred_ref,
            "endpointOrigin": endpoint_origin,
            "privacyTier": privacy_tier,
            "privacyLabel": _privacy_ui_label(privacy_tier),
            "enabled": candidate_enabled,
            "status": status,
            "modelType": str(model.get("type") or "chat").lower(),
            "capabilities": caps["tags"],
            "capabilitiesFlags": caps["flags"],
            "contextLimitTokens": ctx_limit,
            "inputLimitTokens": in_limit,
            "maxOutputTokens": out_limit,
            "pricing": _extract_model_pricing(model),
            "compatibility": redact_inline_secrets(dict(compat_raw)),
            "quotaState": {
                "kind": "unknown",
                "detail": "uninitialized_from_static_descriptor",
            },
            "healthVerified": False,
        })

    return {
        "schemaVersion": OMNIA_ROUTING_SCHEMA_VERSION,
        "redactionPolicy": OMNIA_REDACTION_POLICY,
        "provider": {
            "id": provider_id,
            "canonicalId": canonical_provider,
            "name": str(provider_desc.get("name") or provider_id),
            "activation": activation,
            "adapterFamily": adapter_family,
            "privacyTier": privacy_tier,
            "credentialPresent": cred_present,
            "credentialRef": cred_ref,
            "endpointOrigin": endpoint_origin,
            "inlineSecretsStripped": bool(all_secret_findings or url_had_sensitive),
        },
        "candidates": candidates,
        "excludedModels": excluded_models,
    }


def map_opencode_tool_descriptor(
    tool_desc: Mapping[str, Any],
    *,
    reject_inline_secrets: bool = True,
) -> dict[str, Any]:
    """Translate an ``opencode`` ``Tool.Info``, MCP, or namespace descriptor into Omnia format."""
    if not isinstance(tool_desc, Mapping):
        raise CompatContractError("INVALID_TOOL_DESCRIPTOR", "tool_desc must be an object.")

    findings = detect_inline_secrets(tool_desc)
    if reject_inline_secrets and findings:
        raise CompatContractError(
            "INLINE_SECRET_REJECTED",
            "Tool descriptor contains inline secret material.",
            details={"paths": [f["path"] for f in findings]},
        )

    raw_name = str(tool_desc.get("name") or tool_desc.get("id") or "").strip()
    if not raw_name:
        raise CompatContractError("MISSING_TOOL_NAME", "Tool descriptor requires 'name' or 'id'.")
    norm_name = SAFE_TOOL_ID_RE.sub("_", raw_name)

    raw_ns = tool_desc.get("namespace")
    clean_ns = str(raw_ns).strip() if isinstance(raw_ns, str) and raw_ns.strip() else None
    if clean_ns == PSEUDO_ROOT_NAMESPACE:
        clean_ns = None

    effective_name = f"{SAFE_IDENT_RE.sub('_', clean_ns)}_{norm_name}" if clean_ns else norm_name

    options = tool_desc.get("options") if isinstance(tool_desc.get("options"), Mapping) else {}
    codemode_enabled = options.get("codemode") is not False
    pinned = bool(options.get("pinned", False))
    permission_action = str(options.get("permission") or effective_name)

    input_schema = tool_desc.get("inputSchema") or tool_desc.get("parameters") or tool_desc.get("input")
    if isinstance(input_schema, Mapping):
        sanitized_input_schema = _strip_schema_extensions(redact_inline_secrets(dict(input_schema)))
    else:
        sanitized_input_schema = {"type": "object", "properties": {}}

    output_schema = tool_desc.get("outputSchema") or tool_desc.get("output")
    sanitized_output_schema = (
        _strip_schema_extensions(redact_inline_secrets(dict(output_schema)))
        if isinstance(output_schema, Mapping)
        else None
    )

    warnings: list[str] = []
    if clean_ns is None and norm_name == RESERVED_CODEMODE_TOOL_NAME:
        warnings.append("reserved_codemode_identifier_execute_collision")
    if isinstance(raw_ns, str) and raw_ns.strip() == PSEUDO_ROOT_NAMESPACE:
        warnings.append("pseudo_namespace_functions_normalized_to_root")
    if findings:
        warnings.append("inline_secrets_redacted")

    source_kind = str(tool_desc.get("source") or ("mcp" if clean_ns and clean_ns.startswith("mcp") else "plugin"))

    return {
        "schemaVersion": "omnia.tool.descriptor.v1",
        "redactionPolicy": OMNIA_REDACTION_POLICY,
        "name": norm_name,
        "namespace": clean_ns,
        "effectiveName": effective_name,
        "description": redact_inline_secrets(str(tool_desc.get("description") or "")),
        "sourceKind": source_kind,
        "executionMode": "codemode" if codemode_enabled else "native",
        "pinned": pinned,
        "permissionAction": permission_action,
        "inputSchema": sanitized_input_schema,
        "outputSchema": sanitized_output_schema,
        "warnings": warnings,
    }
