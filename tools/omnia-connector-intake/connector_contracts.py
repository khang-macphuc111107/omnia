"""Deterministic non-secret intake contracts for Omnia connectors.

Integrates verified architectural contracts from three external sources into
Omnia schemas while enforcing strict secret redaction, SSRF/endpoint checks,
path-traversal guards, XXE bounds, and range-integrity invariants:

1. `htmustc-proxy` -> Omnia `DynamicProviderRouter` schema
2. `Gemini Notebook` -> Omnia `MemoryGraph` / `GraphifyProvenance` intake schema
3. `Google Drive Downloader` -> Omnia `PayloadBlob` / resumable range intake schema
"""

from __future__ import annotations

import hashlib
import ipaddress
import math
import re
import unicodedata
from dataclasses import dataclass
from typing import Any
from urllib.parse import parse_qsl, unquote, urlencode, urlsplit, urlunsplit

# ---------------------------------------------------------------------------
# Shared constants & security/secret redaction primitives
# ---------------------------------------------------------------------------

REDACTED_SECRET = "[REDACTED_SECRET]"
REDACTED_PEM_KEY = "[REDACTED_PEM_KEY]"

UNSAFE_FIELD_KEYS = frozenset({"__proto__", "constructor", "prototype"})

PRIVACY_TIERS = {
    "public": "Public",
    "zero_data_retention": "ZeroDataRetention",
    "zerodataretention": "ZeroDataRetention",
    "zdr": "ZeroDataRetention",
    "private_vpc": "PrivateVpc",
    "privatevpc": "PrivateVpc",
    "local_only": "LocalOnly",
    "localonly": "LocalOnly",
}

CIRCUIT_STATES = {
    "closed": "Closed",
    "open": "Open",
    "half_open": "HalfOpen",
    "halfopen": "HalfOpen",
}

ROUTING_STRATEGIES = {
    "weighted_round_robin": "weighted_round_robin",
    "round_robin": "round_robin",
    "weighted_random": "weighted_random",
    "fill_first": "fill_first",
}

FAILURE_SCOPES = {
    "none": "scope_none",
    "scope_none": "scope_none",
    "scopenone": "scope_none",
    "account_cooldown": "scope_account_cooldown",
    "scope_account_cooldown": "scope_account_cooldown",
    "scopeaccountcooldown": "scope_account_cooldown",
    "account_manual": "scope_account_manual",
    "scope_account_manual": "scope_account_manual",
    "scopeaccountmanual": "scope_account_manual",
    "account_suspended": "scope_account_suspended",
    "scope_account_suspended": "scope_account_suspended",
    "scopeaccountsuspended": "scope_account_suspended",
    "account_quota": "scope_account_quota",
    "scope_account_quota": "scope_account_quota",
    "scopeaccountquota": "scope_account_quota",
    "model": "scope_model",
    "scope_model": "scope_model",
    "scopemodel": "scope_model",
}

CLIENT_FAULT_EXEMPT_STATUSES = (400, 409, 413, 422)
MAX_CONCURRENT_LIMIT = 1024
MAX_COOLDOWN_MS = 24 * 60 * 60 * 1000
DEFAULT_CIRCUIT_COOLDOWN_MS = 30_000
DEFAULT_ROTATION_COOLDOWN_MS = 15_000
DEFAULT_FAILOVER_DEADLINE_MS = 60_000
MAX_COMBO_DEPTH = 4

# Aligned with htmustc-proxy internal/api/handler/mgmt_account_redact.go
# (non-secret metadata only; raw email omitted/masked to avoid PII leakage).
PUBLIC_CREDENTIAL_KEYS = frozenset(
    {
        "auth_mode",
        "account_tier",
        "plan_type",
        "region",
        "project_id",
        "provider",
        "provider_id",
        "scopes",
        "enabled",
        "label",
        "workspace_id",
        "account_id",
        "tier",
        "model_family",
    }
)

SENSITIVE_KEY_TOKENS = (
    "api_key",
    "apikey",
    "access_token",
    "refresh_token",
    "id_token",
    "bearer",
    "authorization",
    "client_secret",
    "secret",
    "password",
    "passwd",
    "private_key",
    "cookie",
    "session_key",
    "session_token",
    "management_key",
    "admin_key",
    "token",
    "cf_clearance",
    "sig",
    "signature",
)

SAFE_PLACEHOLDER_PATTERNS = (
    re.compile(r"^\$\{[A-Za-z_][A-Za-z0-9_]*\}$"),
    re.compile(r"^env:[A-Za-z_][A-Za-z0-9_]*$"),
    re.compile(r"^\[REDACTED(?:_[A-Z0-9]+)?\]$"),
    re.compile(r"^\*{3}redacted\*{3}(?::[A-Za-z0-9]{1,8})?$", re.IGNORECASE),
    re.compile(r"^<(?:redacted|secret|env:[^>]+)>$", re.IGNORECASE),
)

_PEM_RE = re.compile(
    r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----",
    re.MULTILINE,
)
_BEARER_RE = re.compile(r"\bBearer\s+([A-Za-z0-9._~+/=-]{8,})", re.IGNORECASE)
_TOKEN_PREFIX_RE = re.compile(
    r"\b(?:github_pat_[A-Za-z0-9_]{16,}|gh[pos]_[A-Za-z0-9]{16,}"
    r"|sk-[A-Za-z0-9_-]{12,}|AIza[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16,})\b"
)
_KV_SECRET_RE = re.compile(
    r"(?i)\b(api_key|apikey|access_token|refresh_token|client_secret|password|passwd|cf_clearance|session_token)"
    r"(\s*[:=]\s*)([\"']?)([^\s\"'&,;}{]{4,})(\3)"
)
_COOKIE_PAIR_RE = re.compile(
    r"(?i)\b(__Secure-[13]PSID(?:TS|CC)?|SAPISID|APISID|SSID|HSID|SIDCC|NID|cf_clearance)"
    r"(=)([^;\s]{6,})"
)

_ENV_REF_RE = re.compile(r"^(?:\$\{[A-Za-z_][A-Za-z0-9_]*\}|env:[A-Za-z_][A-Za-z0-9_]*)$")
_HEX64_RE = re.compile(r"^[0-9a-f]{64}$")
_HEX32_RE = re.compile(r"^[0-9a-f]{32}$")
_HEX8_RE = re.compile(r"^[0-9a-f]{8}$")
_DURATION_RE = re.compile(r"^\s*(-?\d+(?:\.\d+)?)\s*(ms|s|m|h)?\s*$", re.IGNORECASE)

_METADATA_IPS = frozenset({"169.254.169.254", "100.100.100.200"})
_METADATA_HOSTS = frozenset({"metadata.google.internal", "metadata.goog"})
_LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "::1", "[::1]"})

# Notebook & document validation constants (aligned with Gemini Notebook)
MEMORY_TIERS = {"working": "working", "durable": "durable"}
GRAPHIFY_PROVENANCES = {
    "extracted": "extracted",
    "inferred": "inferred",
    "ambiguous": "ambiguous",
}
PRIVATE_DISK_PATH_KEYS = frozenset(
    {
        "localpath",
        "diskpath",
        "fullpath",
        "originalpath",
        "local_path",
        "disk_path",
        "full_path",
        "original_path",
        "user_profile_path",
        "temp_path",
    }
)
MAX_SAFE_FILENAME_LEN = 88
MAX_SAFE_TXT_CHUNK_BYTES = 120 * 1024
MAX_MICRO_PASTE_BYTES = 40 * 1024
MAX_XML_MEMBER_BYTES = 128 * 1024 * 1024
MAX_ARCHIVE_DEPTH = 5
MAX_DOWNLOAD_FILENAME_LEN = 200
MAX_DOWNLOAD_ACTIVE_SEGMENTS = 128
MAX_DOWNLOAD_JOURNAL_CHUNKS = 65_536
MIN_SPLIT_THRESHOLD_BYTES = 512 * 1024
MAX_OMNF_FRAME_BYTES = 16 * 1024 * 1024

ALLOWED_MIME_BY_EXT: dict[str, tuple[str, ...]] = {
    ".pdf": ("application/pdf",),
    ".txt": ("text/plain",),
    ".md": ("text/markdown", "text/plain"),
    ".markdown": ("text/markdown", "text/plain"),
    ".csv": ("text/csv", "text/plain"),
    ".tsv": ("text/tab-separated-values", "text/plain"),
    ".docx": ("application/vnd.openxmlformats-officedocument.wordprocessingml.document",),
    ".xlsx": ("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",),
    ".pptx": ("application/vnd.openxmlformats-officedocument.presentationml.presentation",),
    ".png": ("image/png",),
    ".jpg": ("image/jpeg",),
    ".jpeg": ("image/jpeg",),
    ".webp": ("image/webp",),
    ".gif": ("image/gif",),
    ".mp3": ("audio/mpeg",),
    ".wav": ("audio/wav", "audio/x-wav"),
    ".m4a": ("audio/mp4", "audio/x-m4a"),
    ".aac": ("audio/aac",),
    ".ogg": ("audio/ogg",),
    ".flac": ("audio/flac",),
    ".mp4": ("video/mp4",),
    ".webm": ("video/webm",),
    ".mov": ("video/quicktime",),
    ".json": ("application/json", "text/plain"),
    ".yaml": ("application/yaml", "text/yaml", "text/plain"),
    ".yml": ("application/yaml", "text/yaml", "text/plain"),
    ".xml": ("application/xml", "text/xml"),
    ".html": ("text/html",),
    ".htm": ("text/html",),
    # Code extensions converted deterministically into Markdown
    ".py": ("text/markdown", "text/x-python", "text/plain"),
    ".go": ("text/markdown", "text/x-go", "text/plain"),
    ".js": ("text/markdown", "text/javascript", "application/javascript", "text/plain"),
    ".ts": ("text/markdown", "text/typescript", "text/plain"),
    ".cpp": ("text/markdown", "text/x-c++src", "text/plain"),
    ".hpp": ("text/markdown", "text/x-c++hdr", "text/plain"),
    ".c": ("text/markdown", "text/x-csrc", "text/plain"),
    ".h": ("text/markdown", "text/x-chdr", "text/plain"),
    ".rs": ("text/markdown", "text/rust", "text/plain"),
    ".ps1": ("text/markdown", "text/plain"),
}

FORBIDDEN_EXECUTABLE_EXTS = frozenset(
    {".exe", ".dll", ".bat", ".cmd", ".com", ".msi", ".scr", ".vbs", ".wsf", ".hta", ".pif"}
)
FORBIDDEN_MIME_TYPES = frozenset(
    {
        "application/x-msdownload",
        "application/x-dosexec",
        "application/x-executable",
        "application/x-msi",
        "application/x-msdos-program",
        "application/x-sh",
        "application/x-csh",
    }
)

_XXE_RE = re.compile(r"<!\s*(?:DOCTYPE|ENTITY)\b", re.IGNORECASE)
_BIDI_CONTROL_RE = re.compile(r"[\u200E\u200F\u202A-\u202E\u2066-\u2069]")
_WIN_RESERVED_STEMS = frozenset(
    {"CON", "PRN", "AUX", "NUL"}
    | {f"COM{i}" for i in range(1, 10)}
    | {f"LPT{i}" for i in range(1, 10)}
)
_WINDOWS_DRIVE_RE = re.compile(r"^[A-Za-z]:")
_WIN_ABS_PROFILE_RE = re.compile(r"(?i)[A-Za-z]:\\Users\\[^\\/\s\"']+")
_POSIX_HOME_RE = re.compile(r"/(?:home|Users)/[^/\s\"']+")

TRACKING_QUERY_PARAMS = frozenset(
    {
        "utm_source",
        "utm_medium",
        "utm_campaign",
        "utm_term",
        "utm_content",
        "utm_id",
        "fbclid",
        "gclid",
        "dclid",
        "yclid",
        "msclkid",
        "mc_cid",
        "mc_eid",
        "igshid",
        "_ga",
        "_gl",
        "spm",
    }
)
SIGNED_URL_SECRET_QUERY_PARAMS = frozenset(
    {
        "x-amz-signature",
        "x-amz-security-token",
        "x-amz-credential",
        "x-goog-signature",
        "x-goog-credential",
        "sig",
        "signature",
        "token",
        "access_token",
        "api_key",
        "apikey",
        "key",
        "client_secret",
        "auth",
    }
)
SIGNED_URL_PRESERVED_PARAMS = frozenset(
    {
        "x-amz-algorithm",
        "x-amz-date",
        "x-amz-expires",
        "x-amz-signedheaders",
        "x-amz-signature",
        "x-amz-security-token",
        "x-amz-credential",
        "x-goog-algorithm",
        "x-goog-date",
        "x-goog-expires",
        "x-goog-signedheaders",
        "x-goog-signature",
        "x-goog-credential",
        "sig",
        "sv",
        "se",
        "sp",
        "sr",
        "st",
        "expires",
        "signature",
        "key-pair-id",
        "policy",
    }
)
_HTTP_DATE_RE = re.compile(
    r"^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s+\d{2}\s+"
    r"(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}\s+"
    r"\d{2}:\d{2}:\d{2}\s+GMT$"
)


@dataclass(frozen=True)
class Finding:
    """Structured validation or redaction finding."""

    severity: str  # "error" | "warning" | "info"
    code: str
    path: str
    message: str

    def to_dict(self) -> dict[str, str]:
        return {
            "severity": self.severity,
            "code": self.code,
            "path": self.path,
            "message": self.message,
        }


def _has_control_chars(value: str) -> bool:
    return any(ord(ch) <= 0x1F or ord(ch) == 0x7F for ch in value)


def _is_safe_placeholder(value: str) -> bool:
    trimmed = value.strip()
    if not trimmed:
        return True
    return any(pat.match(trimmed) for pat in SAFE_PLACEHOLDER_PATTERNS)


def redact_secrets(text: str) -> tuple[str, list[str]]:
    """Redact PEM keys, bearer tokens, provider keys, cookies, and KV secrets."""
    if not isinstance(text, str) or not text:
        return "", []
    hits: list[str] = []
    out = text

    out, pem_n = _PEM_RE.subn(REDACTED_PEM_KEY, out)
    if pem_n:
        hits.append("PEM_PRIVATE_KEY")

    def _replace_bearer(match: re.Match[str]) -> str:
        tok = match.group(1)
        if _is_safe_placeholder(tok):
            return match.group(0)
        hits.append("BEARER_TOKEN")
        return f"Bearer {REDACTED_SECRET}"

    out = _BEARER_RE.sub(_replace_bearer, out)

    out, prefix_n = _TOKEN_PREFIX_RE.subn(REDACTED_SECRET, out)
    if prefix_n:
        hits.append("PROVIDER_TOKEN_PREFIX")

    def _replace_kv(match: re.Match[str]) -> str:
        key, sep, quote, val = match.group(1), match.group(2), match.group(3), match.group(4)
        if _is_safe_placeholder(val):
            return match.group(0)
        hits.append(f"KV_SECRET:{key.lower()}")
        return f"{key}{sep}{quote}{REDACTED_SECRET}{quote}"

    out = _KV_SECRET_RE.sub(_replace_kv, out)

    def _replace_cookie(match: re.Match[str]) -> str:
        hits.append(f"COOKIE_SECRET:{match.group(1)}")
        return f"{match.group(1)}={REDACTED_SECRET}"

    out = _COOKIE_PAIR_RE.sub(_replace_cookie, out)
    return out, sorted(set(hits))


def redact_private_disk_strings(text: str) -> tuple[str, bool]:
    """Redact host-specific home/profile substrings when present in text fields."""
    if not text:
        return "", False
    changed = False
    out = _WIN_ABS_PROFILE_RE.sub("[REDACTED_USER_PROFILE]", text)
    if out != text:
        changed = True
    out2 = _POSIX_HOME_RE.sub("/[REDACTED_USER_HOME]", out)
    if out2 != out:
        changed = True
    return out2, changed


def _scan_unsafe_keys(obj: Any, path: str, findings: list[Finding]) -> None:
    if isinstance(obj, dict):
        for k, v in obj.items():
            key_str = str(k)
            if key_str in UNSAFE_FIELD_KEYS:
                findings.append(
                    Finding(
                        "error",
                        "ERR_UNSAFE_PROTOTYPE_KEY",
                        f"{path}.{key_str}" if path else key_str,
                        f"Forbidden prototype-pollution key {key_str!r}.",
                    )
                )
            _scan_unsafe_keys(v, f"{path}.{key_str}" if path else key_str, findings)
    elif isinstance(obj, list):
        for idx, item in enumerate(obj):
            _scan_unsafe_keys(item, f"{path}[{idx}]", findings)


def _is_sensitive_key_name(key: str) -> bool:
    low = key.strip().lower()
    if low in PUBLIC_CREDENTIAL_KEYS:
        return False
    return any(tok in low for tok in SENSITIVE_KEY_TOKENS)


_MISSING = object()
_INT_STR_RE = re.compile(r"^\s*[+-]?\d+\s*$")


def _parse_int_value(
    value: Any,
    default: int,
    field_path: str,
    findings: list[Finding],
) -> tuple[int, bool]:
    """Parse an integer strictly, rejecting bool, None, float, containers, and malformed strings."""
    if value is _MISSING:
        return default, True
    if value is None or isinstance(value, bool):
        findings.append(
            Finding(
                "error",
                "ERR_INVALID_INTEGER",
                field_path,
                f"Expected integer value, got {type(value).__name__} ({value!r}).",
            )
        )
        return default, False
    if isinstance(value, int):
        return value, True
    if isinstance(value, str):
        if _INT_STR_RE.match(value):
            return int(value.strip()), True
        findings.append(
            Finding(
                "error",
                "ERR_INVALID_INTEGER",
                field_path,
                f"Expected integer value, got malformed string {value!r}.",
            )
        )
        return default, False
    findings.append(
        Finding(
            "error",
            "ERR_INVALID_INTEGER",
            field_path,
            f"Expected integer value, got {type(value).__name__}.",
        )
    )
    return default, False


def _parse_int_field(
    mapping: dict[str, Any],
    key: str,
    default: int,
    field_path: str,
    findings: list[Finding],
    *,
    fallback_key: str | None = None,
) -> tuple[int, bool]:
    """Extract and strictly parse an integer field from a mapping."""
    if key in mapping:
        raw_val = mapping[key]
    elif fallback_key and fallback_key in mapping:
        raw_val = mapping[fallback_key]
    else:
        raw_val = _MISSING
    return _parse_int_value(raw_val, default, field_path, findings)


def _parse_float_field(
    mapping: dict[str, Any],
    key: str,
    default: float,
    field_path: str,
    findings: list[Finding],
) -> tuple[float, bool]:
    """Extract and strictly parse a finite float field from a mapping."""
    if key not in mapping:
        return default, True
    raw_val = mapping[key]
    if raw_val is None or isinstance(raw_val, bool):
        findings.append(
            Finding(
                "error",
                "ERR_INVALID_NUMBER",
                field_path,
                f"Expected numeric value, got {type(raw_val).__name__}.",
            )
        )
        return default, False
    if isinstance(raw_val, (int, float)):
        num = float(raw_val)
        if not math.isfinite(num):
            findings.append(
                Finding("error", "ERR_INVALID_NUMBER", field_path, "Numeric value must be finite.")
            )
            return default, False
        return num, True
    if isinstance(raw_val, str):
        try:
            num = float(raw_val.strip())
        except ValueError:
            num = float("nan")
        if math.isfinite(num):
            return num, True
    findings.append(
        Finding(
            "error",
            "ERR_INVALID_NUMBER",
            field_path,
            f"Expected finite number, got {type(raw_val).__name__}.",
        )
    )
    return default, False


def _parse_duration_ms(value: Any, default_ms: int) -> tuple[int, bool]:
    """Parse duration string ('15s', '30m', '300ms', '12h') or numeric ms."""
    if value is None:
        return default_ms, True
    if isinstance(value, bool):
        return default_ms, False
    if isinstance(value, (int, float)):
        if not math.isfinite(float(value)):
            return default_ms, False
        return int(round(value)), True
    if not isinstance(value, str):
        return default_ms, False
    m = _DURATION_RE.match(value)
    if not m:
        return default_ms, False
    num = float(m.group(1))
    unit = (m.group(2) or "ms").lower()
    mult = {"ms": 1, "s": 1000, "m": 60_000, "h": 3_600_000}[unit]
    return int(round(num * mult)), True


def _strip_url_credentials_and_inspect(
    raw_url: str,
    path: str,
    findings: list[Finding],
    *,
    strict_tls: bool,
    allow_private_endpoints: bool,
    allow_loopback_http: bool = True,
    redact_signed_params: bool = True,
) -> dict[str, Any]:
    """Normalize URL, detect SSRF/TLS/userinfo issues, and redact query secrets."""
    result: dict[str, Any] = {
        "normalized_url": "",
        "scheme": "",
        "host": "",
        "port": None,
        "is_loopback": False,
        "is_private": False,
        "had_embedded_credentials": False,
        "had_query_secrets": False,
        "stripped_tracking_params": [],
        "preserved_signed_params": [],
        "safe": False,
    }
    if not isinstance(raw_url, str) or not raw_url.strip():
        findings.append(Finding("error", "ERR_EMPTY_URL", path, "Endpoint URL must be a non-empty string."))
        return result

    if _has_control_chars(raw_url):
        findings.append(
            Finding("error", "ERR_URL_CONTROL_CHARS", path, "URL contains forbidden control/CRLF/NUL characters.")
        )
        return result

    candidate = raw_url.strip()
    try:
        parsed = urlsplit(candidate)
    except ValueError as exc:
        findings.append(Finding("error", "ERR_MALFORMED_URL", path, f"Invalid URL: {exc}"))
        return result

    scheme = parsed.scheme.lower()
    result["scheme"] = scheme
    allowed_schemes = {"https", "http", "socks5", "socks5h"}
    if scheme not in allowed_schemes:
        findings.append(
            Finding("error", "ERR_UNSAFE_SCHEME", path, f"Disallowed URL scheme {scheme!r}; expected HTTPS/HTTP/SOCKS5.")
        )
        return result

    host = (parsed.hostname or "").strip().lower()
    if not host:
        findings.append(Finding("error", "ERR_MISSING_HOST", path, "URL is missing a hostname."))
        return result
    result["host"] = host

    try:
        port = parsed.port
    except ValueError:
        findings.append(Finding("error", "ERR_INVALID_PORT", path, "URL has an invalid TCP port."))
        return result
    result["port"] = port

    is_loopback = host in _LOOPBACK_HOSTS
    is_private = False
    is_metadata = host in _METADATA_HOSTS or host in _METADATA_IPS
    try:
        ip_obj = ipaddress.ip_address(host.strip("[]"))
        is_loopback = ip_obj.is_loopback
        is_private = ip_obj.is_private or ip_obj.is_link_local or ip_obj.is_unspecified or ip_obj.is_reserved
        if str(ip_obj) in _METADATA_IPS or ip_obj.is_link_local:
            is_metadata = True
    except ValueError:
        pass

    result["is_loopback"] = is_loopback
    result["is_private"] = is_private

    if parsed.username is not None or parsed.password is not None:
        result["had_embedded_credentials"] = True
        findings.append(
            Finding(
                "error",
                "ERR_URL_EMBEDDED_CREDENTIALS",
                path,
                "Embedded credentials in URL userinfo are forbidden and were stripped.",
            )
        )

    if is_metadata:
        findings.append(
            Finding(
                "error",
                "ERR_SSRF_METADATA_HOST",
                path,
                f"Cloud/link-local metadata host {host!r} is forbidden.",
            )
        )
    elif is_private and not is_loopback and not allow_private_endpoints:
        findings.append(
            Finding(
                "error",
                "ERR_UNSAFE_PRIVATE_ENDPOINT",
                path,
                f"Private/unspecified IP endpoint {host!r} requires explicit LocalOnly/PrivateVpc allowance.",
            )
        )

    if scheme in {"http", "socks5"} and not (is_loopback and allow_loopback_http):
        if strict_tls:
            findings.append(
                Finding(
                    "error",
                    "ERR_UNSAFE_NON_TLS_ENDPOINT",
                    path,
                    f"Remote endpoint uses non-TLS scheme {scheme!r}; HTTPS is required.",
                )
            )
        else:
            findings.append(
                Finding(
                    "warning",
                    "WARN_NON_TLS_ENDPOINT",
                    path,
                    f"Remote endpoint uses non-TLS scheme {scheme!r}.",
                )
            )

    # Rebuild sanitized query: drop tracking params, redact literal query secrets, keep signed parameter names
    clean_pairs: list[tuple[str, str]] = []
    if parsed.query:
        for qk, qv in parse_qsl(parsed.query, keep_blank_values=True):
            qk_low = qk.lower()
            if qk_low in TRACKING_QUERY_PARAMS:
                result["stripped_tracking_params"].append(qk)
                continue
            if qk_low in SIGNED_URL_PRESERVED_PARAMS:
                result["preserved_signed_params"].append(qk)
            is_secret_param = (
                qk_low in SIGNED_URL_SECRET_QUERY_PARAMS
                or "secret" in qk_low
                or "password" in qk_low
                or "token" in qk_low
            )
            if is_secret_param and not _is_safe_placeholder(qv):
                if qk_low not in SIGNED_URL_PRESERVED_PARAMS:
                    result["had_query_secrets"] = True
                    findings.append(
                        Finding(
                            "error",
                            "ERR_URL_QUERY_SECRET",
                            path,
                            f"Literal secret/token found in URL query parameter {qk!r} and redacted.",
                        )
                    )
                    clean_pairs.append((qk, REDACTED_SECRET))
                    continue
                if redact_signed_params:
                    clean_pairs.append((qk, REDACTED_SECRET))
                    continue
            _, text_hits = redact_secrets(qv)
            if text_hits:
                result["had_query_secrets"] = True
                findings.append(
                    Finding(
                        "error",
                        "ERR_URL_QUERY_SECRET",
                        path,
                        f"Literal token pattern found in query parameter {qk!r} and redacted.",
                    )
                )
                clean_pairs.append((qk, REDACTED_SECRET))
                continue
            clean_pairs.append((qk, qv))

    host_netloc = f"[{host}]" if ":" in host and not host.startswith("[") else host
    if port is not None:
        host_netloc = f"{host_netloc}:{port}"
    sanitized_query = urlencode(clean_pairs, doseq=True)
    result["normalized_url"] = urlunsplit((scheme, host_netloc, parsed.path or "/", sanitized_query, ""))

    blocking = {
        "ERR_URL_EMBEDDED_CREDENTIALS",
        "ERR_SSRF_METADATA_HOST",
        "ERR_UNSAFE_PRIVATE_ENDPOINT",
        "ERR_UNSAFE_NON_TLS_ENDPOINT",
        "ERR_URL_QUERY_SECRET",
    }
    result["safe"] = not any(f.path == path and f.code in blocking for f in findings)
    return result


# ---------------------------------------------------------------------------
# 1. htmustc-proxy -> Omnia DynamicProviderRouter schema normalizer
# ---------------------------------------------------------------------------

def _sanitize_credential_map(
    creds: dict[str, Any],
    path: str,
    findings: list[Finding],
    *,
    strict_allowlist: bool = True,
) -> tuple[dict[str, Any], bool, str]:
    """Normalize account credentials/headers using allowlist + default-deny redaction."""
    sanitized: dict[str, Any] = {}
    credential_present = False
    credential_source = "none"

    for k, v in creds.items():
        key = str(k)
        key_path = f"{path}.{key}"
        key_low = key.lower()

        if key_low in PUBLIC_CREDENTIAL_KEYS:
            if isinstance(v, str):
                red_val, hits = redact_secrets(v)
                if hits:
                    findings.append(
                        Finding(
                            "error",
                            "ERR_LITERAL_SECRET_PRESENT",
                            key_path,
                            f"Literal secret embedded in metadata field {key!r} was redacted.",
                        )
                    )
                    sanitized[key] = red_val
                else:
                    sanitized[key] = v
            else:
                sanitized[key] = v
            continue

        if key_low in {"email", "user_email", "account_email"}:
            sanitized["email_present"] = bool(v)
            findings.append(
                Finding(
                    "info",
                    "INFO_PII_EMAIL_OMITTED",
                    key_path,
                    "Raw email omitted from normalized connector contract.",
                )
            )
            continue

        is_sensitive = strict_allowlist or _is_sensitive_key_name(key)

        if isinstance(v, str):
            trimmed = v.strip()
            if not trimmed:
                continue
            red_val, val_hits = redact_secrets(trimmed)
            if not is_sensitive and not val_hits:
                sanitized[key] = trimmed
                continue
            credential_present = True
            if _ENV_REF_RE.match(trimmed):
                credential_source = "env_ref"
                sanitized[key] = trimmed
            elif _is_safe_placeholder(trimmed):
                credential_source = "redacted_ref"
                sanitized[key] = REDACTED_SECRET
            else:
                credential_source = "literal_refused"
                sanitized[key] = red_val if val_hits else REDACTED_SECRET
                findings.append(
                    Finding(
                        "error",
                        "ERR_LITERAL_SECRET_PRESENT",
                        key_path,
                        f"Literal credential in {key!r} is refused and was redacted; use env ref instead.",
                    )
                )
        elif isinstance(v, dict):
            nested_allowlist = strict_allowlist and (key_low != "headers")
            nested, sub_present, sub_src = _sanitize_credential_map(
                v, key_path, findings, strict_allowlist=nested_allowlist
            )
            sanitized[key] = nested
            credential_present = credential_present or sub_present
            if sub_present and credential_source == "none":
                credential_source = sub_src
        elif v is not None and is_sensitive:
            credential_present = True
            sanitized[key] = REDACTED_SECRET
            credential_source = "literal_refused"
            findings.append(
                Finding(
                    "error",
                    "ERR_LITERAL_SECRET_PRESENT",
                    key_path,
                    f"Literal credential value in {key!r} is refused and was redacted.",
                )
            )
        elif v is not None:
            sanitized[key] = v

    return sanitized, credential_present, credential_source


def _detect_combo_cycles(combos: list[dict[str, Any]], findings: list[Finding]) -> None:
    adj: dict[str, list[str]] = {}
    for idx, combo in enumerate(combos):
        cid = str(combo.get("combo_id", f"combo_{idx}"))
        targets = [str(m) for m in combo.get("models", []) if isinstance(m, str)]
        adj[cid] = targets
        if len(targets) > MAX_COMBO_DEPTH:
            findings.append(
                Finding(
                    "warning",
                    "WARN_COMBO_DEPTH_TRUNCATED",
                    f"combos[{idx}].models",
                    f"Combo {cid!r} exceeds max fallback depth {MAX_COMBO_DEPTH} ({len(targets)} entries).",
                )
            )

    visiting: set[str] = set()
    visited: set[str] = set()

    def _dfs(node: str, depth: int, path_idx: str) -> None:
        if node in visiting:
            findings.append(
                Finding("error", "ERR_COMBO_CYCLE", path_idx, f"Combo fallback cycle detected at {node!r}.")
            )
            return
        if node in visited or depth > MAX_COMBO_DEPTH:
            return
        visiting.add(node)
        for nxt in adj.get(node, []):
            _dfs(nxt, depth + 1, path_idx)
        visiting.remove(node)
        visited.add(node)

    for idx, combo in enumerate(combos):
        cid = str(combo.get("combo_id", f"combo_{idx}"))
        _dfs(cid, 0, f"combos[{idx}]")


def normalize_proxy_route_config(
    raw: dict[str, Any],
    *,
    strict_tls: bool = True,
    allow_private_endpoints: bool = False,
) -> dict[str, Any]:
    """Normalize an htmustc-proxy config/route payload into Omnia DynamicProviderRouter schema."""
    if not isinstance(raw, dict):
        raise TypeError("raw proxy config must be a dict")

    findings: list[Finding] = []
    _scan_unsafe_keys(raw, "", findings)

    # Check rejected upstream patterns (anti-spoofing / default mgmt password / cookie sidecars)
    server_cfg = raw.get("server") if isinstance(raw.get("server"), dict) else {}
    mgmt_cfg = raw.get("management") if isinstance(raw.get("management"), dict) else {}
    admin_pw = server_cfg.get("admin_password") or mgmt_cfg.get("password") or raw.get("admin_password")
    if isinstance(admin_pw, str) and admin_pw.strip():
        if admin_pw.strip() == "123456":
            findings.append(
                Finding(
                    "error",
                    "ERR_DEFAULT_MGMT_PASSWORD",
                    "management.password",
                    "Hardcoded default management password '123456' is rejected.",
                )
            )
        elif not _ENV_REF_RE.match(admin_pw.strip()) and not _is_safe_placeholder(admin_pw.strip()):
            findings.append(
                Finding(
                    "error",
                    "ERR_LITERAL_SECRET_PRESENT",
                    "management.password",
                    "Literal management password is refused; use env var reference.",
                )
            )

    for bad_flag, code in (
        ("claude_code_cloak", "ERR_REJECTED_SPOOFING_POLICY"),
        ("tls_impersonation", "ERR_REJECTED_SPOOFING_POLICY"),
        ("utls_fingerprint", "ERR_REJECTED_SPOOFING_POLICY"),
        ("recaptcha_bypass", "ERR_REJECTED_ANTI_BOT_BYPASS"),
        ("flaresolverr_url", "ERR_REJECTED_ANTI_BOT_BYPASS"),
    ):
        val = raw.get(bad_flag)
        if val:
            findings.append(
                Finding(
                    "error",
                    code,
                    bad_flag,
                    f"Forbidden spoofing/bypass option {bad_flag!r} is rejected by Omnia policy.",
                )
            )

    # Check static server API keys
    raw_api_keys = server_cfg.get("api_keys") if server_cfg else raw.get("api_keys")
    normalized_api_keys: list[dict[str, Any]] = []
    if isinstance(raw_api_keys, list):
        for idx, item in enumerate(raw_api_keys):
            item_path = f"server.api_keys[{idx}]"
            if isinstance(item, str):
                trimmed = item.strip()
                if _ENV_REF_RE.match(trimmed) or _is_safe_placeholder(trimmed):
                    normalized_api_keys.append({"source": "env_ref" if _ENV_REF_RE.match(trimmed) else "redacted", "ref": trimmed})
                else:
                    findings.append(
                        Finding(
                            "error",
                            "ERR_LITERAL_SECRET_PRESENT",
                            item_path,
                            "Literal server API key refused and redacted.",
                        )
                    )
                    normalized_api_keys.append({"source": "literal_refused", "ref": REDACTED_SECRET})
            elif isinstance(item, dict):
                san_map, _, src = _sanitize_credential_map(item, item_path, findings)
                normalized_api_keys.append({"source": src, "metadata": san_map})

    # Normalize routing policy
    routing_raw = raw.get("routing") if isinstance(raw.get("routing"), dict) else {}
    raw_strategy = str(routing_raw.get("strategy", "weighted_round_robin")).strip().lower()
    if raw_strategy not in ROUTING_STRATEGIES:
        findings.append(
            Finding(
                "error",
                "ERR_INVALID_ROUTING_STRATEGY",
                "routing.strategy",
                f"Unknown routing strategy {raw_strategy!r}; expected one of {sorted(ROUTING_STRATEGIES)}.",
            )
        )
        strategy = "weighted_round_robin"
    else:
        strategy = ROUTING_STRATEGIES[raw_strategy]

    rl_ms, rl_ok = _parse_duration_ms(
        routing_raw.get("rate_limit_cooldown_ms", routing_raw.get("rate_limit_cooldown")),
        DEFAULT_ROTATION_COOLDOWN_MS,
    )
    se_ms, se_ok = _parse_duration_ms(
        routing_raw.get("server_error_cooldown_ms", routing_raw.get("server_error_cooldown")),
        DEFAULT_CIRCUIT_COOLDOWN_MS,
    )
    bw_ms, bw_ok = _parse_duration_ms(
        routing_raw.get("busy_retry_wait_ms", routing_raw.get("busy_retry_wait")),
        5_000,
    )
    fo_ms, fo_ok = _parse_duration_ms(
        routing_raw.get("failover_deadline_ms", routing_raw.get("failover_deadline")),
        DEFAULT_FAILOVER_DEADLINE_MS,
    )
    for field_name, val_ms, ok in (
        ("routing.rate_limit_cooldown", rl_ms, rl_ok),
        ("routing.server_error_cooldown", se_ms, se_ok),
        ("routing.busy_retry_wait", bw_ms, bw_ok),
        ("routing.failover_deadline", fo_ms, fo_ok),
    ):
        if not ok or val_ms < 0 or val_ms > MAX_COOLDOWN_MS:
            findings.append(
                Finding(
                    "error",
                    "ERR_INVALID_DURATION_BOUNDS",
                    field_name,
                    f"Duration {val_ms} ms out of safe bounds [0, {MAX_COOLDOWN_MS}].",
                )
            )

    max_concurrent, _ = _parse_int_field(routing_raw, "max_concurrent", 8, "routing.max_concurrent", findings)
    if max_concurrent <= 0 or max_concurrent > MAX_CONCURRENT_LIMIT:
        findings.append(
            Finding(
                "error",
                "ERR_INVALID_CONCURRENCY_LIMIT",
                "routing.max_concurrent",
                f"max_concurrent={max_concurrent} must be in [1, {MAX_CONCURRENT_LIMIT}].",
            )
        )
        max_concurrent = max(1, min(max_concurrent, MAX_CONCURRENT_LIMIT))

    max_failover_rounds, _ = _parse_int_field(
        routing_raw, "max_failover_rounds", 3, "routing.max_failover_rounds", findings
    )
    if max_failover_rounds < 1 or max_failover_rounds > 16:
        findings.append(
            Finding(
                "error",
                "ERR_INVALID_FAILOVER_ROUNDS",
                "routing.max_failover_rounds",
                f"max_failover_rounds={max_failover_rounds} must be in [1, 16].",
            )
        )

    probe_unproven_every, _ = _parse_int_field(
        routing_raw, "probe_unproven_every", 4, "routing.probe_unproven_every", findings
    )
    sticky_limit, _ = _parse_int_field(routing_raw, "sticky_limit", 3, "routing.sticky_limit", findings)

    # Validate proxy_pools (masking userinfo, enforcing URL rules)
    normalized_pools: list[dict[str, Any]] = []
    raw_pools = raw.get("proxy_pools") if isinstance(raw.get("proxy_pools"), list) else []
    for idx, pool in enumerate(raw_pools):
        if not isinstance(pool, dict):
            continue
        p_path = f"proxy_pools[{idx}]"
        raw_proxy_url = pool.get("proxy_url", "")
        url_info = (
            _strip_url_credentials_and_inspect(
                str(raw_proxy_url),
                f"{p_path}.proxy_url",
                findings,
                strict_tls=False,
                allow_private_endpoints=True,
                allow_loopback_http=True,
            )
            if raw_proxy_url
            else {"normalized_url": "", "safe": True}
        )
        pool_max_slots, _ = _parse_int_field(pool, "max_slots", 0, f"{p_path}.max_slots", findings)
        normalized_pools.append(
            {
                "pool_id": str(pool.get("id", f"pool-{idx}")),
                "name": str(pool.get("name", f"pool-{idx}")),
                "proxy_url_sanitized": url_info["normalized_url"],
                "strict_proxy": bool(pool.get("strict_proxy", False)),
                "max_slots": pool_max_slots,
            }
        )

    # Normalize provider_nodes + accounts -> DynamicProviderRouter RouteCandidate + CandidateResourceState
    candidates: list[dict[str, Any]] = []
    resource_states: dict[str, dict[str, Any]] = {}

    raw_items: list[tuple[str, str, dict[str, Any]]] = []
    for idx, node in enumerate(raw.get("provider_nodes") or []):
        if isinstance(node, dict):
            raw_items.append(("node", f"provider_nodes[{idx}]", node))
    for idx, acct in enumerate(raw.get("accounts") or []):
        if isinstance(acct, dict):
            raw_items.append(("account", f"accounts[{idx}]", acct))
    for idx, cand in enumerate(raw.get("candidates") or []):
        if isinstance(cand, dict):
            raw_items.append(("candidate", f"candidates[{idx}]", cand))

    for kind, item_path, item in raw_items:
        provider_id = str(item.get("provider_id") or item.get("provider") or item.get("api_type") or "custom").strip()
        model_id = str(
            item.get("model_id")
            or item.get("model")
            or ((item.get("models") or ["default"])[0] if isinstance(item.get("models"), list) and item.get("models") else "default")
        ).strip()
        cand_id = str(item.get("candidate_id") or item.get("id") or f"{provider_id}:{model_id}:{len(candidates)}")

        privacy_key = str(item.get("privacy_tier", "public")).strip().lower()
        privacy_tier = PRIVACY_TIERS.get(privacy_key, "Public")
        if privacy_key not in PRIVACY_TIERS:
            findings.append(
                Finding(
                    "error",
                    "ERR_INVALID_PRIVACY_TIER",
                    f"{item_path}.privacy_tier",
                    f"Unknown privacy_tier {privacy_key!r}.",
                )
            )

        raw_url = item.get("base_url") or item.get("endpoint_url")
        sanitized_url = ""
        if raw_url is not None:
            url_res = _strip_url_credentials_and_inspect(
                str(raw_url),
                f"{item_path}.base_url",
                findings,
                strict_tls=strict_tls,
                allow_private_endpoints=allow_private_endpoints or privacy_tier in {"LocalOnly", "PrivateVpc"},
                allow_loopback_http=True,
            )
            sanitized_url = url_res["normalized_url"]

        # Check raw headers / api_key / credentials on the candidate
        cred_payload: dict[str, Any] = {}
        for k in (
            "api_key",
            "bearer",
            "authorization",
            "access_token",
            "refresh_token",
            "secret",
            "password",
            "cookie",
            "auth_mode",
            "region",
            "project_id",
            "tier",
            "account_tier",
        ):
            if k in item:
                cred_payload[k] = item[k]
        if isinstance(item.get("credentials"), dict):
            cred_payload.update(item["credentials"])
        if isinstance(item.get("headers"), dict):
            cred_payload["headers"] = item["headers"]

        san_creds, cred_present, cred_source = _sanitize_credential_map(cred_payload, item_path, findings)
        if isinstance(item.get("credential_present"), bool):
            cred_present = cred_present or item["credential_present"]

        raw_caps = item.get("capabilities") if isinstance(item.get("capabilities"), dict) else {}
        max_attachments, _ = _parse_int_field(
            raw_caps, "max_attachments", 16, f"{item_path}.capabilities.max_attachments", findings
        )
        capabilities = {
            "text": bool(raw_caps.get("text", True)),
            "vision": bool(raw_caps.get("vision", False)),
            "audio": bool(raw_caps.get("audio", False)),
            "tool_use": bool(raw_caps.get("tool_use", False)),
            "structured_output": bool(raw_caps.get("structured_output", False)),
            "streaming": bool(raw_caps.get("streaming", True)),
            "max_attachments": max_attachments,
        }

        cb_raw = item.get("circuit_breaker") if isinstance(item.get("circuit_breaker"), dict) else {}
        cb_state_key = str(cb_raw.get("state", item.get("circuit_state", "closed"))).strip().lower()
        cb_state = CIRCUIT_STATES.get(cb_state_key)
        if not cb_state:
            findings.append(
                Finding(
                    "error",
                    "ERR_INVALID_CIRCUIT_STATE",
                    f"{item_path}.circuit_state",
                    f"Unknown circuit_state {cb_state_key!r}; expected closed/open/half_open.",
                )
            )
            cb_state = "Closed"

        cb_cooldown_ms, cb_ok = _parse_duration_ms(
            cb_raw.get("cooldown_ms", cb_raw.get("cooldown", item.get("circuit_cooldown_ms"))),
            max(se_ms, DEFAULT_CIRCUIT_COOLDOWN_MS),
        )
        if not cb_ok or cb_cooldown_ms <= 0 or cb_cooldown_ms > MAX_COOLDOWN_MS:
            findings.append(
                Finding(
                    "error",
                    "ERR_INVALID_DURATION_BOUNDS",
                    f"{item_path}.circuit_cooldown_ms",
                    f"circuit_cooldown_ms={cb_cooldown_ms} out of bounds (0, {MAX_COOLDOWN_MS}].",
                )
            )
            cb_cooldown_ms = DEFAULT_CIRCUIT_COOLDOWN_MS

        if "failure_threshold" in cb_raw:
            cb_threshold, _ = _parse_int_field(
                cb_raw, "failure_threshold", 3, f"{item_path}.circuit_failure_threshold", findings
            )
        else:
            cb_threshold, _ = _parse_int_field(
                item, "circuit_failure_threshold", 3, f"{item_path}.circuit_failure_threshold", findings
            )
        if cb_threshold < 1 or cb_threshold > 50:
            findings.append(
                Finding(
                    "error",
                    "ERR_INVALID_CIRCUIT_THRESHOLD",
                    f"{item_path}.circuit_failure_threshold",
                    f"failure_threshold={cb_threshold} must be in [1, 50].",
                )
            )
            cb_threshold = max(1, min(cb_threshold, 50))

        scope_raw = str(item.get("failure_scope", "scope_none")).strip().lower()
        failure_scope = FAILURE_SCOPES.get(scope_raw)
        if not failure_scope:
            findings.append(
                Finding(
                    "error",
                    "ERR_INVALID_FAILURE_SCOPE",
                    f"{item_path}.failure_scope",
                    f"Unknown failure_scope {scope_raw!r}.",
                )
            )
            failure_scope = "scope_none"

        quota_raw = item.get("quota") if isinstance(item.get("quota"), dict) else {}
        quota_kind = str(quota_raw.get("kind", "Unknown")).strip()
        if quota_kind not in {"Known", "Unknown", "Stale", "Contradictory"}:
            quota_kind = "Unknown"

        context_limit_tokens, _ = _parse_int_field(
            item, "context_limit_tokens", 128_000, f"{item_path}.context_limit_tokens", findings
        )
        max_output_tokens, _ = _parse_int_field(
            item, "max_output_tokens", 8_192, f"{item_path}.max_output_tokens", findings
        )
        quality_tier, _ = _parse_int_field(item, "quality_tier", 3, f"{item_path}.quality_tier", findings)
        retention_hours, _ = _parse_int_field(item, "retention_hours", 0, f"{item_path}.retention_hours", findings)
        route_priority, _ = _parse_int_field(
            item, "route_priority", 100, f"{item_path}.route_priority", findings, fallback_key="priority"
        )
        ewma_latency_ms, _ = _parse_float_field(
            item, "ewma_latency_ms", 0.0, f"{item_path}.ewma_latency_ms", findings
        )
        timeout_count, _ = _parse_int_field(item, "timeout_count", 0, f"{item_path}.timeout_count", findings)
        error_count, _ = _parse_int_field(item, "error_count", 0, f"{item_path}.error_count", findings)
        success_count, _ = _parse_int_field(item, "success_count", 0, f"{item_path}.success_count", findings)
        retry_after_until_ms, _ = _parse_int_field(
            item, "retry_after_until_ms", 0, f"{item_path}.retry_after_until_ms", findings
        )
        consecutive_failures, _ = _parse_int_field(
            item, "consecutive_failures", 0, f"{item_path}.consecutive_failures", findings
        )
        cand_max_concurrency, _ = _parse_int_field(
            item, "max_concurrency", max_concurrent, f"{item_path}.max_concurrency", findings
        )
        epoch_val, _ = _parse_int_field(item, "epoch", 1, f"{item_path}.epoch", findings)

        cand_record = {
            "candidate_id": cand_id,
            "provider_id": provider_id,
            "model_id": model_id,
            "source_kind": kind,
            "auth_boundary": str(item.get("auth_boundary", "workspace:default")),
            "capabilities": capabilities,
            "context_limit_tokens": context_limit_tokens,
            "max_output_tokens": max_output_tokens,
            "quality_tier": quality_tier,
            "pricing_version": str(item.get("pricing_version", "v1")),
            "region": str(item.get("region", "")),
            "privacy_tier": privacy_tier,
            "retention_hours": retention_hours,
            "credential_present": cred_present,
            "credential_source": cred_source,
            "enabled": bool(item.get("enabled", True)),
            "route_priority": route_priority,
            "endpoint_url": sanitized_url,
            "api_type": str(item.get("api_type", "openai")),
            "metadata": san_creds,
        }
        candidates.append(cand_record)

        resource_states[cand_id] = {
            "quota": {
                "kind": quota_kind,
                "remaining_units": quota_raw.get("remaining_units"),
                "source": str(quota_raw.get("source", "connector_intake")),
            },
            "ewma_latency_ms": ewma_latency_ms,
            "timeout_count": timeout_count,
            "error_count": error_count,
            "success_count": success_count,
            "retry_after_until_ms": retry_after_until_ms,
            "circuit_state": cb_state,
            "circuit_failure_threshold": cb_threshold,
            "circuit_cooldown_ms": cb_cooldown_ms,
            "consecutive_failures": consecutive_failures,
            "max_concurrency": min(max(1, cand_max_concurrency), MAX_CONCURRENT_LIMIT),
            "epoch": epoch_val,
            "failure_scope": failure_scope,
            "client_fault_exempt_statuses": list(CLIENT_FAULT_EXEMPT_STATUSES),
        }

    # Combo graph validation
    normalized_combos: list[dict[str, Any]] = []
    raw_combos = raw.get("combos") if isinstance(raw.get("combos"), list) else []
    for idx, combo in enumerate(raw_combos):
        if isinstance(combo, dict):
            normalized_combos.append(
                {
                    "combo_id": str(combo.get("combo_id", combo.get("name", f"combo-{idx}"))),
                    "kind": str(combo.get("kind", "fallback")),
                    "models": [str(m) for m in combo.get("models", []) if isinstance(m, str)][:MAX_COMBO_DEPTH],
                    "probe_interval_ms": 30_000,
                }
            )
    if normalized_combos:
        _detect_combo_cycles(normalized_combos, findings)

    has_errors = any(f.severity == "error" for f in findings)
    return {
        "schema_version": "omnia.dynamic_router_intake.v1",
        "source_origin": "htmustc-proxy",
        "valid": not has_errors,
        "status": "ACCEPTED" if not has_errors else "REFUSED",
        "routing_policy": {
            "strategy": strategy,
            "probe_unproven_every": probe_unproven_every,
            "rate_limit_cooldown_ms": max(0, rl_ms),
            "server_error_cooldown_ms": max(0, se_ms),
            "busy_retry_wait_ms": max(0, bw_ms),
            "failover_deadline_ms": max(0, fo_ms),
            "max_concurrent": max_concurrent,
            "sticky_limit": sticky_limit,
            "session_affinity": bool(routing_raw.get("session_affinity", True)),
            "max_failover_rounds": max_failover_rounds,
            "failover_round_pause_ms": 300,
            "model_entitlement_cooldown_ms": 12 * 3_600_000,
            "account_quota_cooldown_ms": 30 * 60_000,
            "client_fault_exempt_statuses": list(CLIENT_FAULT_EXEMPT_STATUSES),
        },
        "server_api_keys": normalized_api_keys,
        "proxy_pools": normalized_pools,
        "candidates": candidates,
        "resource_states": resource_states,
        "combos": normalized_combos,
        "findings": [f.to_dict() for f in findings],
    }


# ---------------------------------------------------------------------------
# 2. Gemini Notebook -> Omnia MemoryGraph / knowledge intake validator
# ---------------------------------------------------------------------------

def is_valid_memory_namespace(namespace_path: str) -> bool:
    """Mirror Omnia C++ MemoryGraph::is_valid_namespace exactly."""
    if not isinstance(namespace_path, str) or not namespace_path:
        return False
    if "\\" in namespace_path or ":" in namespace_path:
        return False
    if _has_control_chars(namespace_path):
        return False
    segments = namespace_path.split("/")
    if not (1 <= len(segments) <= 8):
        return False
    for seg in segments:
        if not seg or seg in {".", ".."}:
            return False
    return True


def _validate_relative_doc_path(rel_path: str, field_path: str, findings: list[Finding]) -> str:
    """Validate relative path safety against traversal, absolute, drive, and UNC paths."""
    if not isinstance(rel_path, str) or not rel_path.strip():
        findings.append(Finding("error", "ERR_EMPTY_PATH", field_path, "Document relative path must not be empty."))
        return ""

    raw = rel_path.strip()
    if _has_control_chars(raw) or _BIDI_CONTROL_RE.search(raw):
        findings.append(
            Finding(
                "error",
                "ERR_UNSAFE_PATH_CHARS",
                field_path,
                "Path contains control or bidirectional override characters.",
            )
        )
        return ""

    decoded = unquote(raw)
    if (
        raw.startswith(("/", "\\"))
        or decoded.startswith(("/", "\\"))
        or _WINDOWS_DRIVE_RE.match(raw)
        or _WINDOWS_DRIVE_RE.match(decoded)
    ):
        findings.append(
            Finding("error", "ERR_PATH_TRAVERSAL", field_path, f"Absolute, drive, or UNC path {raw!r} is forbidden.")
        )
        return ""

    normalized = raw.replace("\\", "/")
    parts = [p for p in normalized.split("/") if p != ""]
    decoded_parts = [p for p in decoded.replace("\\", "/").split("/") if p != ""]
    if not parts or ".." in parts or ".." in decoded_parts or "." in parts:
        findings.append(
            Finding("error", "ERR_PATH_TRAVERSAL", field_path, f"Path traversal segment in {raw!r} is forbidden.")
        )
        return ""

    clean = "/".join(parts)
    if len(parts[-1]) > MAX_SAFE_FILENAME_LEN:
        findings.append(
            Finding(
                "warning",
                "WARN_FILENAME_EXCEEDS_88_CHARS",
                field_path,
                f"Basename exceeds safe notebook limit ({len(parts[-1])} > {MAX_SAFE_FILENAME_LEN} chars).",
            )
        )
    return clean


def _strip_private_paths(obj: dict[str, Any], field_path: str, findings: list[Finding]) -> list[str]:
    stripped: list[str] = []
    for key in list(obj.keys()):
        if str(key).lower() in PRIVATE_DISK_PATH_KEYS:
            stripped.append(str(key))
            obj.pop(key, None)
    if stripped:
        findings.append(
            Finding(
                "warning",
                "WARN_STRIPPED_PRIVATE_DISK_PATHS",
                field_path,
                f"Stripped private local path fields: {', '.join(sorted(stripped))}.",
            )
        )
    return stripped


def _extract_extension(rel_path: str) -> str:
    base = rel_path.rsplit("/", 1)[-1]
    if "." not in base:
        return ""
    return "." + base.rsplit(".", 1)[-1].lower()


def validate_notebook_bundle(
    bundle: dict[str, Any],
    *,
    namespace_prefix: str = "connectors/notebook",
) -> dict[str, Any]:
    """Validate Gemini Notebook conversion/export & citation bundle for Omnia MemoryGraph intake."""
    if not isinstance(bundle, dict):
        raise TypeError("notebook bundle must be a dict")

    findings: list[Finding] = []
    _scan_unsafe_keys(bundle, "", findings)

    raw_ns = bundle.get("namespace_path") if "namespace_path" in bundle else namespace_prefix
    namespace_path = str("" if raw_ns is None else raw_ns).strip()
    if not is_valid_memory_namespace(namespace_path):
        findings.append(
            Finding(
                "error",
                "ERR_INVALID_NAMESPACE",
                "namespace_path",
                f"Invalid MemoryGraph namespace_path {namespace_path!r}.",
            )
        )

    bundle_tier_raw = str(bundle.get("tier", "durable")).strip().lower()
    bundle_tier = MEMORY_TIERS.get(bundle_tier_raw)
    if not bundle_tier:
        findings.append(
            Finding("error", "ERR_INVALID_MEMORY_TIER", "tier", f"Invalid MemoryTier {bundle_tier_raw!r}.")
        )
        bundle_tier = "durable"

    sources = bundle.get("sources") if isinstance(bundle.get("sources"), list) else []
    citations = bundle.get("citations") if isinstance(bundle.get("citations"), list) else []

    entries: list[dict[str, Any]] = []
    edges: list[dict[str, Any]] = []
    title_to_ids: dict[str, list[str]] = {}
    id_to_entry: dict[str, dict[str, Any]] = {}
    remote_to_id: dict[str, str] = {}

    for idx, src in enumerate(sources):
        if not isinstance(src, dict):
            findings.append(Finding("error", "ERR_INVALID_SOURCE_ITEM", f"sources[{idx}]", "Source entry must be an object."))
            continue
        s_path = f"sources[{idx}]"
        src_copy = dict(src)
        _strip_private_paths(src_copy, s_path, findings)

        rel_path = _validate_relative_doc_path(
            str(src_copy.get("rel_path", src_copy.get("source_path", ""))),
            f"{s_path}.rel_path",
            findings,
        )
        ext = _extract_extension(rel_path) if rel_path else str(src_copy.get("extension", "")).lower()
        mime_type = str(src_copy.get("mime_type", "")).strip().lower()

        # Check forbidden executables/MIMEs
        if ext in FORBIDDEN_EXECUTABLE_EXTS or mime_type in FORBIDDEN_MIME_TYPES:
            findings.append(
                Finding(
                    "error",
                    "ERR_FORBIDDEN_FILE_TYPE",
                    f"{s_path}.mime_type",
                    f"Executable/disallowed type ext={ext!r} mime={mime_type!r} rejected.",
                )
            )
        elif ext:
            allowed_mimes = ALLOWED_MIME_BY_EXT.get(ext)
            if allowed_mimes is None:
                findings.append(
                    Finding(
                        "error",
                        "ERR_UNSUPPORTED_EXTENSION",
                        f"{s_path}.rel_path",
                        f"Extension {ext!r} is outside notebook allowlist.",
                    )
                )
            elif mime_type and mime_type not in allowed_mimes:
                findings.append(
                    Finding(
                        "error",
                        "ERR_MIME_EXTENSION_MISMATCH",
                        f"{s_path}.mime_type",
                        f"MIME {mime_type!r} does not match extension {ext!r} ({allowed_mimes}).",
                    )
                )
            elif not mime_type:
                mime_type = allowed_mimes[0]

        # Size, chunk, archive depth, XXE, and encryption bounds
        byte_len, _ = _parse_int_field(src_copy, "byte_len", 0, f"{s_path}.byte_len", findings)
        if byte_len < 0:
            findings.append(Finding("error", "ERR_NEGATIVE_SIZE", f"{s_path}.byte_len", "byte_len must be >= 0."))

        archive_depth, _ = _parse_int_field(src_copy, "archive_depth", 0, f"{s_path}.archive_depth", findings)
        if archive_depth < 0:
            findings.append(
                Finding("error", "ERR_NEGATIVE_SIZE", f"{s_path}.archive_depth", "archive_depth must be >= 0.")
            )
        elif archive_depth > MAX_ARCHIVE_DEPTH:
            findings.append(
                Finding(
                    "error",
                    "ERR_ARCHIVE_DEPTH_EXCEEDED",
                    f"{s_path}.archive_depth",
                    f"Archive depth {archive_depth} exceeds max depth {MAX_ARCHIVE_DEPTH}.",
                )
            )

        if ext in {".xml", ".docx", ".xlsx", ".pptx", ".html", ".htm"} or "xml" in mime_type:
            xml_member_bytes, _ = _parse_int_field(
                src_copy, "xml_member_bytes", max(0, byte_len), f"{s_path}.xml_member_bytes", findings
            )
            if xml_member_bytes < 0:
                findings.append(
                    Finding(
                        "error",
                        "ERR_NEGATIVE_SIZE",
                        f"{s_path}.xml_member_bytes",
                        "xml_member_bytes must be >= 0.",
                    )
                )
            elif xml_member_bytes > MAX_XML_MEMBER_BYTES:
                findings.append(
                    Finding(
                        "error",
                        "ERR_XML_MEMBER_SIZE_EXCEEDED",
                        f"{s_path}.xml_member_bytes",
                        f"XML member {xml_member_bytes} exceeds 128 MiB cap.",
                    )
                )

        chunk_bytes, _ = _parse_int_field(src_copy, "chunk_bytes", 0, f"{s_path}.chunk_bytes", findings)
        if chunk_bytes < 0:
            findings.append(
                Finding("error", "ERR_NEGATIVE_SIZE", f"{s_path}.chunk_bytes", "chunk_bytes must be >= 0.")
            )
        elif chunk_bytes > MAX_SAFE_TXT_CHUNK_BYTES:
            findings.append(
                Finding(
                    "error",
                    "ERR_CHUNK_SIZE_EXCEEDED",
                    f"{s_path}.chunk_bytes",
                    f"Text chunk {chunk_bytes} exceeds {MAX_SAFE_TXT_CHUNK_BYTES} byte limit.",
                )
            )
        if bool(src_copy.get("is_micro_paste", False)) and byte_len > MAX_MICRO_PASTE_BYTES:
            findings.append(
                Finding(
                    "error",
                    "ERR_MICRO_PASTE_SIZE_EXCEEDED",
                    f"{s_path}.byte_len",
                    f"Micro-paste {byte_len} exceeds {MAX_MICRO_PASTE_BYTES} byte limit.",
                )
            )

        # Content secret, XXE, and SHA-256 verification
        raw_content = src_copy.get("content")
        sanitized_content = None
        computed_sha256 = None
        secret_hits: list[str] = []
        if isinstance(raw_content, str):
            if _XXE_RE.search(raw_content):
                findings.append(
                    Finding(
                        "error",
                        "ERR_XXE_FORBIDDEN",
                        f"{s_path}.content",
                        "XML DOCTYPE/ENTITY declaration detected and rejected (XXE guard).",
                    )
                )
            red_content, secret_hits = redact_secrets(raw_content)
            if secret_hits:
                findings.append(
                    Finding(
                        "error",
                        "ERR_LITERAL_SECRET_PRESENT",
                        f"{s_path}.content",
                        f"Literal secrets detected in source content ({', '.join(secret_hits)}) and redacted.",
                    )
                )
            red_content, prof_hit = redact_private_disk_strings(red_content)
            if prof_hit:
                findings.append(
                    Finding(
                        "warning",
                        "WARN_REDACTED_USER_PROFILE_PATH",
                        f"{s_path}.content",
                        "Host user-profile substring redacted from source content.",
                    )
                )
            sanitized_content = red_content
            computed_sha256 = hashlib.sha256(raw_content.encode("utf-8")).hexdigest()

        declared_sha = str(src_copy.get("content_sha256", "")).strip().lower()
        if declared_sha.startswith("sha256:"):
            declared_sha = declared_sha[7:]
        if declared_sha and not _HEX64_RE.match(declared_sha):
            findings.append(
                Finding("error", "ERR_INVALID_SHA256", f"{s_path}.content_sha256", "content_sha256 must be 64 hex chars.")
            )
        elif declared_sha and computed_sha256 and declared_sha != computed_sha256 and not secret_hits:
            findings.append(
                Finding(
                    "error",
                    "ERR_CHECKSUM_MISMATCH",
                    f"{s_path}.content_sha256",
                    "Declared content_sha256 does not match UTF-8 content digest.",
                )
            )

        effective_sha = declared_sha if _HEX64_RE.match(declared_sha) else (computed_sha256 or "")
        if not effective_sha:
            findings.append(
                Finding(
                    "error",
                    "ERR_MISSING_PROVENANCE_HASH",
                    f"{s_path}.content_sha256",
                    "Source entry must supply content_sha256 or content for provenance hashing.",
                )
            )

        prov_raw = str(src_copy.get("provenance", "extracted")).strip().lower()
        provenance = GRAPHIFY_PROVENANCES.get(prov_raw)
        if not provenance:
            findings.append(
                Finding("error", "ERR_INVALID_PROVENANCE", f"{s_path}.provenance", f"Invalid provenance {prov_raw!r}.")
            )
            provenance = "extracted"

        entry_tier_raw = str(src_copy.get("tier", bundle_tier)).strip().lower()
        entry_tier = MEMORY_TIERS.get(entry_tier_raw, bundle_tier)

        extraction_status = str(src_copy.get("extraction_status", "OK"))
        if bool(src_copy.get("pdf_encrypted", False)) and not sanitized_content:
            extraction_status = "UNREADABLE:ENCRYPTED_PDF"

        source_id = str(src_copy.get("source_id") or src_copy.get("remote_id") or f"src-{idx}")
        source_title = str(src_copy.get("title") or (rel_path.rsplit("/", 1)[-1] if rel_path else source_id))
        source_title, _ = redact_private_disk_strings(source_title)

        updated_at_ms, _ = _parse_int_field(src_copy, "updated_at_ms", 0, f"{s_path}.updated_at_ms", findings)

        entry = {
            "id": source_id,
            "namespace_path": namespace_path,
            "key": rel_path or source_id,
            "tier": entry_tier,
            "content_sha256": effective_sha,
            "updated_at_ms": updated_at_ms,
            "mime_type": mime_type or "application/octet-stream",
            "byte_len": byte_len,
            "title": source_title,
            "remote_id": str(src_copy.get("remote_id", "")),
            "provenance": provenance,
            "extraction_status": extraction_status,
            "links": [],
        }
        if sanitized_content is not None:
            entry["content_preview"] = sanitized_content[:512]

        entries.append(entry)
        id_to_entry[source_id] = entry
        remote_id_str = str(src_copy.get("remote_id", "")).strip()
        if remote_id_str:
            remote_to_id[remote_id_str] = source_id
        if source_title:
            title_to_ids.setdefault(source_title.casefold(), []).append(source_id)

    # Validate citations -> MemoryEdge with sourceIdentity ambiguity guard
    for idx, cit in enumerate(citations):
        if not isinstance(cit, dict):
            findings.append(Finding("error", "ERR_INVALID_CITATION", f"citations[{idx}]", "Citation must be an object."))
            continue
        c_path = f"citations[{idx}]"
        cit_copy = dict(cit)
        _strip_private_paths(cit_copy, c_path, findings)

        raw_remote_id = str(cit_copy.get("remote_id") or "").strip()
        raw_source_id = str(cit_copy.get("source_id") or "").strip()
        target_id = raw_source_id or (remote_to_id.get(raw_remote_id, "") if raw_remote_id else "")
        target_title = str(cit_copy.get("source_title") or "").strip()

        if raw_source_id or raw_remote_id:
            if not target_id or target_id not in id_to_entry:
                findings.append(
                    Finding(
                        "error",
                        "ERR_DANGLING_CITATION_SOURCE",
                        f"{c_path}.source_id",
                        f"Citation references unknown source_id/remote_id {raw_source_id or raw_remote_id!r}.",
                    )
                )
                continue
        elif target_title:
            matches = title_to_ids.get(target_title.casefold(), [])
            if len(matches) == 0:
                findings.append(
                    Finding(
                        "error",
                        "ERR_DANGLING_CITATION_SOURCE",
                        f"{c_path}.source_title",
                        f"Citation references unknown source_title {target_title!r}.",
                    )
                )
                continue
            if len(matches) > 1:
                findings.append(
                    Finding(
                        "error",
                        "ERR_AMBIGUOUS_CITATION_TARGET",
                        f"{c_path}.source_title",
                        f"Ambiguous citation title {target_title!r} matches {len(matches)} sources; remote_id/source_id required.",
                    )
                )
                continue
            target_id = matches[0]
        else:
            findings.append(
                Finding(
                    "error",
                    "ERR_MISSING_CITATION_TARGET",
                    c_path,
                    "Citation must specify remote_id/source_id or unique source_title.",
                )
            )
            continue

        prov_raw = str(cit_copy.get("provenance", "extracted")).strip().lower()
        provenance = GRAPHIFY_PROVENANCES.get(prov_raw)
        if not provenance:
            findings.append(
                Finding("error", "ERR_INVALID_PROVENANCE", f"{c_path}.provenance", f"Invalid provenance {prov_raw!r}.")
            )
            provenance = "extracted"

        quote_text = str(cit_copy.get("quote", ""))
        if quote_text:
            _, q_hits = redact_secrets(quote_text)
            if q_hits:
                findings.append(
                    Finding(
                        "error",
                        "ERR_LITERAL_SECRET_PRESENT",
                        f"{c_path}.quote",
                        f"Literal secrets in citation quote ({', '.join(q_hits)}) rejected.",
                    )
                )

        from_id = str(cit_copy.get("citation_id") or f"citation-{idx}")
        relation = str(cit_copy.get("relation") or "CITES")
        edge = {
            "from_id": from_id,
            "to_id": target_id,
            "relation": relation,
            "provenance": provenance,
        }
        edges.append(edge)
        id_to_entry[target_id]["links"].append(edge)

    has_errors = any(f.severity == "error" for f in findings)
    return {
        "schema_version": "omnia.memory_graph_intake.v1",
        "source_origin": "Gemini Notebook",
        "valid": not has_errors,
        "status": "ACCEPTED" if not has_errors else "REFUSED",
        "namespace_path": namespace_path,
        "entries": entries,
        "edges": edges,
        "findings": [f.to_dict() for f in findings],
    }


# ---------------------------------------------------------------------------
# 3. Google Drive Downloader -> Omnia PayloadBlob & range manifest validator
# ---------------------------------------------------------------------------

def sanitize_download_filename(raw_name: str, *, max_len: int = MAX_DOWNLOAD_FILENAME_LEN) -> tuple[str, list[str]]:
    """Sanitize untrusted filename per Google Drive Downloader Win32/POSIX rules."""
    notes: list[str] = []
    if not isinstance(raw_name, str) or not raw_name.strip():
        return "download.bin", ["EMPTY_FALLBACK"]

    cleaned = raw_name.strip()
    if _BIDI_CONTROL_RE.search(cleaned):
        cleaned = _BIDI_CONTROL_RE.sub("", cleaned)
        notes.append("STRIPPED_BIDI_CONTROLS")

    if _has_control_chars(cleaned):
        cleaned = "".join(ch for ch in cleaned if ord(ch) > 0x1F and ord(ch) != 0x7F)
        notes.append("STRIPPED_CONTROL_CHARS")

    # Drop directory components & traversal
    if "/" in cleaned or "\\" in cleaned or _WINDOWS_DRIVE_RE.match(cleaned) or cleaned in {".", ".."}:
        cleaned = re.split(r"[\\/]+", cleaned)[-1]
        if cleaned in {"", ".", ".."}:
            cleaned = "download.bin"
        notes.append("DROPPED_PATH_COMPONENTS")

    # Replace Windows/NTFS forbidden characters
    forbidden_re = re.compile(r'[<>:"/\\|?*]')
    if forbidden_re.search(cleaned):
        cleaned = forbidden_re.sub("_", cleaned)
        notes.append("REPLACED_ILLEGAL_CHARS")

    # Trim trailing dots & whitespace (Windows aliasing defense)
    trimmed = cleaned.rstrip(". ")
    if trimmed != cleaned:
        cleaned = trimmed
        notes.append("TRIMMED_TRAILING_DOTS_SPACES")

    cleaned = unicodedata.normalize("NFC", cleaned)
    if not cleaned or cleaned in {".", ".."}:
        cleaned = "download.bin"
        notes.append("EMPTY_FALLBACK")

    # Guard Windows reserved device names (e.g. CON, PRN, NUL, COM1..9, LPT1..9)
    stem, dot, ext = cleaned.partition(".")
    if stem.upper() in _WIN_RESERVED_STEMS:
        cleaned = f"_{stem}{dot}{ext}" if dot else f"_{stem}"
        notes.append("ESCAPED_WIN32_RESERVED_NAME")

    # Length cap preserving extension cleanly
    if len(cleaned) > max_len:
        if "." in cleaned and not cleaned.startswith("."):
            base, ext_part = cleaned.rsplit(".", 1)
            ext_suffix = "." + ext_part[:32]
            keep = max(1, max_len - len(ext_suffix))
            cleaned = base[:keep].rstrip(". ") + ext_suffix
        else:
            cleaned = cleaned[:max_len].rstrip(". ")
        notes.append("TRUNCATED_MAX_LEN")

    return cleaned, notes


def classify_http_validator(
    *,
    etag: str | None = None,
    last_modified: str | None = None,
    if_range: str | None = None,
) -> tuple[str, bool]:
    """Classify resume validator strength per protocolDiagnostics.js."""
    strong_source = (etag or "").strip() or (if_range or "").strip()
    if strong_source.startswith('"') and strong_source.endswith('"') and len(strong_source) >= 2:
        return "strong_etag", True
    if strong_source.upper().startswith('W/"') and strong_source.endswith('"'):
        return "weak_etag", False
    lm = (last_modified or "").strip() or (if_range or "").strip()
    if lm and _HTTP_DATE_RE.match(lm):
        return "last_modified", False
    return "none", False


def _is_allowed_ws_origin(origin: str) -> bool:
    if not isinstance(origin, str) or not origin.strip():
        return False
    low = origin.strip().lower()
    if low.startswith(("chrome-extension://", "moz-extension://", "edge-extension://")):
        return len(low.split("://", 1)[1].split("/", 1)[0]) >= 8
    try:
        parsed = urlsplit(low)
    except ValueError:
        return False
    return parsed.scheme in {"http", "https"} and (parsed.hostname or "") in _LOOPBACK_HOSTS


def validate_download_manifest(manifest: dict[str, Any]) -> dict[str, Any]:
    """Validate Google Drive Downloader range/SHA-256 manifest for Omnia media intake."""
    if not isinstance(manifest, dict):
        raise TypeError("download manifest must be a dict")

    findings: list[Finding] = []
    _scan_unsafe_keys(manifest, "", findings)

    # Reject DRM / CAPTCHA bypass attempts
    if bool(manifest.get("drm_supported", False)):
        findings.append(
            Finding(
                "error",
                "ERR_FORBIDDEN_DRM_SUPPORT",
                "drm_supported",
                "Omnia connector intake forbids DRM bypass/decryption (drm_supported must be false).",
            )
        )
    for bad_key in ("drm_bypass", "widevine_decrypt", "captcha_solver", "view_only_bypass"):
        if manifest.get(bad_key):
            findings.append(
                Finding(
                    "error",
                    "ERR_FORBIDDEN_DRM_OR_CAPTCHA_BYPASS",
                    bad_key,
                    f"Forbidden capability {bad_key!r} is rejected.",
                )
            )

    auth_boundary = str(manifest.get("auth_boundary", "MANUAL_VISIBLE_BROWSER_ONLY"))
    if auth_boundary != "MANUAL_VISIBLE_BROWSER_ONLY":
        findings.append(
            Finding(
                "warning",
                "WARN_NONSTANDARD_AUTH_BOUNDARY",
                "auth_boundary",
                f"Expected MANUAL_VISIBLE_BROWSER_ONLY auth boundary, got {auth_boundary!r}.",
            )
        )

    ws_origin = manifest.get("ws_origin")
    if ws_origin is not None and not _is_allowed_ws_origin(str(ws_origin)):
        findings.append(
            Finding(
                "error",
                "ERR_DISALLOWED_WS_ORIGIN",
                "ws_origin",
                f"Extension/loopback bridge origin {ws_origin!r} is not trusted.",
            )
        )

    # URL validation & tracking parameter stripping
    source_url = manifest.get("source_url") or manifest.get("url")
    url_info = {"normalized_url": "", "stripped_tracking_params": [], "preserved_signed_params": []}
    if source_url is not None:
        url_info = _strip_url_credentials_and_inspect(
            str(source_url),
            "source_url",
            findings,
            strict_tls=True,
            allow_private_endpoints=False,
            allow_loopback_http=True,
            redact_signed_params=True,
        )

    # Filename sanitization
    raw_filename = str(manifest.get("filename") or manifest.get("suggested_filename") or "")
    sanitized_filename, fname_notes = sanitize_download_filename(raw_filename)
    if fname_notes and fname_notes != ["EMPTY_FALLBACK"]:
        findings.append(
            Finding(
                "warning",
                "WARN_FILENAME_SANITIZED",
                "filename",
                f"Filename sanitized ({', '.join(fname_notes)}): {sanitized_filename!r}.",
            )
        )
    elif not raw_filename.strip():
        findings.append(Finding("error", "ERR_MISSING_FILENAME", "filename", "Download manifest requires filename."))

    # Total bytes & range segments validation
    total_bytes_raw = manifest.get("total_bytes")
    if isinstance(total_bytes_raw, bool) or not isinstance(total_bytes_raw, int) or total_bytes_raw < 0:
        findings.append(
            Finding("error", "ERR_INVALID_TOTAL_BYTES", "total_bytes", "total_bytes must be a non-negative integer.")
        )
        total_bytes = 0
    else:
        total_bytes = total_bytes_raw

    segments_raw = manifest.get("segments")
    if segments_raw is None:
        segments_raw = []
    if not isinstance(segments_raw, list):
        findings.append(Finding("error", "ERR_INVALID_SEGMENTS", "segments", "segments must be a list."))
        segments_raw = []

    if len(segments_raw) > MAX_DOWNLOAD_JOURNAL_CHUNKS:
        findings.append(
            Finding(
                "error",
                "ERR_SEGMENT_COUNT_EXCEEDED",
                "segments",
                f"Segment count {len(segments_raw)} exceeds journal limit {MAX_DOWNLOAD_JOURNAL_CHUNKS}.",
            )
        )
    elif len(segments_raw) > MAX_DOWNLOAD_ACTIVE_SEGMENTS:
        findings.append(
            Finding(
                "warning",
                "WARN_SEGMENT_COUNT_ABOVE_IDM_CAP",
                "segments",
                f"Segment count {len(segments_raw)} exceeds active worker cap {MAX_DOWNLOAD_ACTIVE_SEGMENTS}.",
            )
        )

    parsed_segments: list[dict[str, Any]] = []
    for idx, seg in enumerate(segments_raw):
        seg_path = f"segments[{idx}]"
        if not isinstance(seg, dict):
            findings.append(Finding("error", "ERR_INVALID_SEGMENT_ENTRY", seg_path, "Segment must be an object."))
            continue
        start = seg.get("start")
        end = seg.get("end")
        if (
            isinstance(start, bool)
            or isinstance(end, bool)
            or not isinstance(start, int)
            or not isinstance(end, int)
        ):
            findings.append(Finding("error", "ERR_INVALID_SEGMENT_BOUNDS", seg_path, "Segment start/end must be ints."))
            continue
        if start < 0 or end < start or (total_bytes > 0 and end >= total_bytes) or (total_bytes == 0 and end >= 0):
            findings.append(
                Finding(
                    "error",
                    "ERR_SEGMENT_OUT_OF_RANGE",
                    seg_path,
                    f"Segment [{start}, {end}] is out of bounds for total_bytes={total_bytes}.",
                )
            )
            continue
        seg_len = end - start + 1
        dl_bytes = seg.get("downloaded_bytes")
        completed = bool(seg.get("completed", False))
        if dl_bytes is None:
            dl_bytes = seg_len if completed else 0
        elif isinstance(dl_bytes, bool) or not isinstance(dl_bytes, int) or dl_bytes < 0 or dl_bytes > seg_len:
            findings.append(
                Finding(
                    "error",
                    "ERR_INVALID_SEGMENT_PROGRESS",
                    f"{seg_path}.downloaded_bytes",
                    f"downloaded_bytes={dl_bytes} invalid for segment length {seg_len}.",
                )
            )
            dl_bytes = 0

        seg_sha = str(seg.get("sha256", "")).strip().lower()
        if seg_sha.startswith("sha256:"):
            seg_sha = seg_sha[7:]
        if seg_sha and not _HEX64_RE.match(seg_sha):
            findings.append(
                Finding("error", "ERR_INVALID_SHA256", f"{seg_path}.sha256", "Segment sha256 must be 64 hex chars.")
            )

        seg_index, _ = _parse_int_field(seg, "index", idx, f"{seg_path}.index", findings)
        parsed_segments.append(
            {
                "index": seg_index,
                "start": start,
                "end": end,
                "length": seg_len,
                "downloaded_bytes": dl_bytes,
                "completed": completed and (dl_bytes == seg_len),
                "sha256": seg_sha,
            }
        )

    # Sort & detect overlaps / gaps
    ordered = sorted(parsed_segments, key=lambda s: (s["start"], s["end"]))
    overlaps: list[dict[str, int]] = []
    gaps: list[dict[str, int]] = []
    covered_bytes = 0
    total_downloaded_bytes = 0

    if total_bytes > 0 and not ordered:
        gaps.append({"start": 0, "end": total_bytes - 1})
    elif ordered:
        cursor = 0
        for s in ordered:
            total_downloaded_bytes += s["downloaded_bytes"]
            if s["start"] > cursor:
                gaps.append({"start": cursor, "end": s["start"] - 1})
            if s["start"] < cursor:
                ov_end = min(cursor - 1, s["end"])
                overlaps.append({"start": s["start"], "end": ov_end})
                findings.append(
                    Finding(
                        "error",
                        "ERR_RANGE_OVERLAP",
                        "segments",
                        f"Overlapping byte range [{s['start']}, {ov_end}].",
                    )
                )
                if s["end"] >= cursor:
                    covered_bytes += s["end"] - cursor + 1
                    cursor = s["end"] + 1
            else:
                covered_bytes += s["end"] - s["start"] + 1
                cursor = s["end"] + 1
        if cursor < total_bytes:
            gaps.append({"start": cursor, "end": total_bytes - 1})

    is_range_complete = (len(overlaps) == 0) and (len(gaps) == 0) and (covered_bytes == total_bytes)
    all_segments_done = all(s["completed"] for s in ordered) if ordered else (total_bytes == 0)
    is_download_complete = is_range_complete and all_segments_done

    require_complete = bool(manifest.get("require_complete", False)) or str(manifest.get("status", "")).lower() == "completed"
    if not is_range_complete and gaps:
        findings.append(
            Finding(
                "error" if require_complete else "warning",
                "ERR_RANGE_GAPS_DETECTED" if require_complete else "WARN_RANGE_INCOMPLETE",
                "segments",
                f"Detected {len(gaps)} uncovered byte gap(s); covered {covered_bytes}/{total_bytes} bytes.",
            )
        )

    # HTTP validator & checksum checks
    validator_strength, resume_safe = classify_http_validator(
        etag=manifest.get("etag"),
        last_modified=manifest.get("last_modified"),
        if_range=manifest.get("if_range"),
    )
    if len(ordered) > 1 and not resume_safe:
        findings.append(
            Finding(
                "warning",
                "WARN_WEAK_OR_MISSING_IF_RANGE",
                "etag",
                f"Multi-segment download lacks strong ETag validator (strength={validator_strength!r}).",
            )
        )

    sha256_raw = str(manifest.get("sha256", "")).strip().lower()
    if sha256_raw.startswith("sha256:"):
        sha256_raw = sha256_raw[7:]
    if sha256_raw and not _HEX64_RE.match(sha256_raw):
        findings.append(
            Finding("error", "ERR_INVALID_SHA256", "sha256", "Expected 64-character lowercase hex SHA-256 digest.")
        )
        sha256_norm = ""
    else:
        sha256_norm = sha256_raw

    if require_complete and not sha256_norm:
        findings.append(
            Finding("error", "ERR_MISSING_SHA256", "sha256", "Completed download manifest must supply sha256 digest.")
        )

    raw_crc = manifest.get("crc32c")
    crc32c = ("" if raw_crc is None else str(raw_crc)).strip().lower()
    if crc32c and not _HEX8_RE.match(crc32c):
        findings.append(
            Finding("error", "ERR_INVALID_CRC32C", "crc32c", "Invalid crc32c digest; expected 8 hex chars.")
        )

    raw_md5 = manifest.get("md5")
    md5_hex = ("" if raw_md5 is None else str(raw_md5)).strip().lower()
    if md5_hex and not _HEX32_RE.match(md5_hex):
        findings.append(
            Finding("error", "ERR_INVALID_MD5", "md5", "Invalid md5 digest; expected 32 hex chars.")
        )

    mime_type = str(manifest.get("mime_type", "application/octet-stream")).strip().lower()
    if mime_type in FORBIDDEN_MIME_TYPES or _extract_extension(sanitized_filename) in FORBIDDEN_EXECUTABLE_EXTS:
        findings.append(
            Finding(
                "error",
                "ERR_FORBIDDEN_FILE_TYPE",
                "filename",
                f"Executable download payload ({sanitized_filename!r} / {mime_type!r}) is refused.",
            )
        )

    has_errors = any(f.severity == "error" for f in findings)
    extraction_status = (
        "VERIFIED_COMPLETE"
        if (not has_errors and is_download_complete and bool(sha256_norm))
        else ("RANGE_PARTIAL" if not has_errors else "REFUSED")
    )
    return {
        "schema_version": "omnia.media_intake.v1",
        "source_origin": "Google Drive Downloader",
        "valid": not has_errors,
        "status": "ACCEPTED" if not has_errors else "REFUSED",
        "payload_blob": {
            "sha256": sha256_norm,
            "mime_type": mime_type,
            "byte_len": total_bytes,
            "extraction_status": extraction_status,
        },
        "sanitized_filename": sanitized_filename,
        "filename_changed": sanitized_filename != raw_filename,
        "filename_notes": fname_notes,
        "source_url_sanitized": url_info["normalized_url"],
        "stripped_tracking_params": url_info["stripped_tracking_params"],
        "preserved_signed_params": url_info["preserved_signed_params"],
        "validator_strength": validator_strength,
        "resume_safe": resume_safe,
        "auth_boundary": auth_boundary,
        "drm_supported": False,
        "range_summary": {
            "total_bytes": total_bytes,
            "segment_count": len(ordered),
            "covered_bytes": covered_bytes,
            "downloaded_bytes": total_downloaded_bytes,
            "gaps": gaps,
            "overlaps": overlaps,
            "is_range_complete": is_range_complete,
            "is_download_complete": is_download_complete,
            "min_split_threshold_bytes": MIN_SPLIT_THRESHOLD_BYTES,
            "max_frame_bytes": MAX_OMNF_FRAME_BYTES,
        },
        "findings": [f.to_dict() for f in findings],
    }


# ---------------------------------------------------------------------------
# Unified dispatcher
# ---------------------------------------------------------------------------

def inspect_connector_bundle(
    payload: dict[str, Any],
    *,
    strict_tls: bool = True,
    allow_private_endpoints: bool = False,
) -> dict[str, Any]:
    """Dispatch either a single connector payload ('kind') or a multi-connector bundle."""
    if not isinstance(payload, dict):
        raise TypeError("payload must be a dict")

    kind = str(payload.get("kind", "")).strip().lower()
    if kind == "proxy_route":
        return normalize_proxy_route_config(
            payload, strict_tls=strict_tls, allow_private_endpoints=allow_private_endpoints
        )
    if kind == "notebook_bundle":
        return validate_notebook_bundle(payload)
    if kind == "download_manifest":
        return validate_download_manifest(payload)

    proxy_results = [
        normalize_proxy_route_config(item, strict_tls=strict_tls, allow_private_endpoints=allow_private_endpoints)
        for item in (payload.get("proxy_routes") or [])
        if isinstance(item, dict)
    ]
    notebook_results = [
        validate_notebook_bundle(item)
        for item in (payload.get("notebook_bundles") or [])
        if isinstance(item, dict)
    ]
    download_results = [
        validate_download_manifest(item)
        for item in (payload.get("download_manifests") or [])
        if isinstance(item, dict)
    ]
    all_items = proxy_results + notebook_results + download_results
    all_valid = bool(all_items) and all(item["valid"] for item in all_items)
    return {
        "schema_version": "omnia.connector_intake_bundle.v1",
        "valid": all_valid,
        "status": "ACCEPTED" if all_valid else "REFUSED",
        "counts": {
            "proxy_routes": len(proxy_results),
            "notebook_bundles": len(notebook_results),
            "download_manifests": len(download_results),
            "passed": sum(1 for item in all_items if item["valid"]),
            "failed": sum(1 for item in all_items if not item["valid"]),
        },
        "proxy_routes": proxy_results,
        "notebook_bundles": notebook_results,
        "download_manifests": download_results,
    }
