"""Zero-dependency extractor for public Gemini share transcripts (`ujx1Bf` / `otAQ7b`).

Implements strict public share URL validation, WIZ `batchexecute` frame decoding,
multi-page cursor pagination, full extraction of thinking steps, interleaved search
sources, grounding citations, attachments (ignoring scalar `turn[2][8] = false`),
completeness verification, and strict secret/cookie/signed-URL/PII/path redaction.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime, timezone
import html as html_lib
import json
import re
from typing import Any, Callable
import urllib.error
import urllib.parse
import urllib.request

SCHEMA_VERSION = "omnia.gemini-share-transcript.v1"

REDACTED_SECRET = "[REDACTED_SECRET]"
REDACTED_PEM_KEY = "[REDACTED_PEM_KEY]"
REDACTED_URL = "[REDACTED_URL]"
REDACTED_EMAIL = "[REDACTED_EMAIL]"
REDACTED_USER_PROFILE = "[REDACTED_USER_PROFILE]"
REDACTED_USER_HOME = "[REDACTED_USER_HOME]"

UNSAFE_PROTOTYPE_KEYS = frozenset({"__proto__", "constructor", "prototype"})

ALLOWED_SHARE_HOSTS = frozenset({"share.gemini.google", "gemini.google.com"})
SHARE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{4,128}$")
MAX_PAGINATION_PAGES = 128
MAX_RAW_TEXT_BYTES = 64 * 1024 * 1024

TRACKING_QUERY_PARAMS = frozenset({
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
})

SIGNED_URL_QUERY_PARAMS = frozenset({
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
    "x-goog-api-key",
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
    "googleaccessid",
})

SECRET_QUERY_PARAMS = frozenset({
    "x-amz-signature",
    "x-amz-security-token",
    "x-amz-credential",
    "x-goog-signature",
    "x-goog-credential",
    "x-goog-api-key",
    "sig",
    "signature",
    "token",
    "access_token",
    "refresh_token",
    "id_token",
    "api_key",
    "apikey",
    "key",
    "client_secret",
    "auth",
    "authorization",
    "secret",
    "password",
    "passwd",
    "cookie",
    "session_token",
})

_PEM_RE = re.compile(
    r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----"
)
_BEARER_RE = re.compile(r"\b(Bearer[ \t]+)([A-Za-z0-9._~+/=-]{8,})", re.IGNORECASE)
_PROVIDER_TOKEN_RE = re.compile(
    r"(?<![A-Za-z0-9_])("
    r"github_pat_[A-Za-z0-9_-]{16,}|"
    r"gh[pousr]_[A-Za-z0-9_-]{16,}|"
    r"sk-ant-[A-Za-z0-9_-]{12,}|"
    r"sk-proj-[A-Za-z0-9_-]{12,}|"
    r"sk-[A-Za-z0-9_-]{12,}|"
    r"AIza[A-Za-z0-9_-]{20,}|"
    r"AKIA[A-Za-z0-9_-]{16,}|"
    r"xox[bpa]-[A-Za-z0-9_-]{10,}|"
    r"hf_[A-Za-z0-9_-]{16,}|"
    r"glpat-[A-Za-z0-9_-]{16,}"
    r")(?![A-Za-z0-9])"
)
_COOKIE_HEADER_RE = re.compile(
    r"(?<![A-Za-z0-9_-])((?:set-)?cookie[ \t]*:[ \t]*)([^\r\n]+)",
    re.IGNORECASE,
)
_COOKIE_PAIR_RE = re.compile(
    r"(?<![A-Za-z0-9_-])("
    r"__Secure-1PSIDTS|__Secure-3PSIDTS|__Secure-1PSIDCC|__Secure-3PSIDCC|"
    r"__Secure-1PSID|__Secure-3PSID|SAPISID|APISID|SSID|HSID|SIDCC|NID|cf_clearance|"
    r"SID"
    r")=([^\s;\"'&,}]{6,})",
    re.IGNORECASE,
)
_KV_SECRET_RE = re.compile(
    r"(?<![A-Za-z0-9_])("
    r"api_key|apikey|access_token|refresh_token|id_token|client_secret|"
    r"password|passwd|cf_clearance|session_token|management_key|admin_key|"
    r"x-goog-api-key|x-api-key|authorization"
    r")([ \t]*[:=][ \t]*)([\"']?)([^\s\"'&,;})]{4,})(\3)",
    re.IGNORECASE,
)
_WIN_PROFILE_RE = re.compile(
    r"[A-Za-z]:[\\/]users[\\/][^\s\\/'\",;)>]+",
    re.IGNORECASE,
)
_POSIX_HOME_RE = re.compile(
    r"(?<![A-Za-z0-9_])/(?:home|Users)/[^\s/\\'\"),;>]+",
    re.IGNORECASE,
)
_EMAIL_RE = re.compile(
    r"(?<![A-Za-z0-9_://])([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})(?![A-Za-z0-9])"
)
_INLINE_URL_RE = re.compile(r"https?://[^\s<>'\"\)\]]+")
_BIDI_RE = re.compile(r"[\u200E\u200F\u202A-\u202E\u2066-\u2069]")


class GeminiShareError(ValueError):
    """Base error for Gemini share validation, decoding, and extraction."""

    def __init__(self, reason: str, message: str) -> None:
        super().__init__(message)
        self.reason = reason
        self.message = message


class GeminiBlockedError(GeminiShareError):
    """Raised when a URL or response hits an auth or CAPTCHA gate that must not be bypassed."""


class GeminiDecodeError(GeminiShareError):
    """Raised when WIZ batchexecute framing or payload JSON is malformed."""


@dataclass(frozen=True)
class ShareUrlValidation:
    """Result of validating a Gemini share URL without bypassing access controls."""

    valid: bool
    status: str
    reason: str
    share_id: str | None
    normalized_url: str | None
    host: str | None
    detail: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _has_control_chars(value: str) -> bool:
    return any(ord(ch) <= 0x1F or ord(ch) == 0x7F for ch in value)


def _is_safe_placeholder(value: str) -> bool:
    trimmed = value.strip()
    if not trimmed:
        return True
    if trimmed.startswith("[REDACTED") and trimmed.endswith("]"):
        inner = trimmed[1:-1]
        return all(ch.isupper() or ch.isdigit() or ch == "_" for ch in inner)
    low = trimmed.lower()
    if low in {"<redacted>", "<secret>"}:
        return True
    if low.startswith("env:") or (low.startswith("${") and low.endswith("}")):
        return True
    return False


def validate_share_url(url: str) -> ShareUrlValidation:
    """Validates a public Gemini share URL and explicitly rejects auth/CAPTCHA gates.

    Accepts `https://share.gemini.google/<id>` or `https://gemini.google.com/share/<id>`.
    Explicitly refuses `gemini.google.com/app/...` (`auth_required`),
    `accounts.google.com/...` (`auth_required`), and `google.com/sorry` (`captcha_blocked`).
    """
    if not isinstance(url, str) or not url.strip():
        return ShareUrlValidation(
            valid=False,
            status="invalid",
            reason="empty_url",
            share_id=None,
            normalized_url=None,
            host=None,
            detail="URL cannot be empty",
        )

    raw = url.strip()
    if _has_control_chars(raw) or _BIDI_RE.search(raw):
        return ShareUrlValidation(
            valid=False,
            status="invalid",
            reason="unsafe_characters",
            share_id=None,
            normalized_url=None,
            host=None,
            detail="URL contains forbidden control or bidirectional override characters",
        )

    try:
        parsed = urllib.parse.urlsplit(raw)
    except ValueError as exc:
        return ShareUrlValidation(
            valid=False,
            status="invalid",
            reason="malformed_url",
            share_id=None,
            normalized_url=None,
            host=None,
            detail=f"Malformed URL: {exc}",
        )

    scheme = parsed.scheme.lower()
    if scheme not in {"https", "http"}:
        return ShareUrlValidation(
            valid=False,
            status="invalid",
            reason="unsupported_scheme",
            share_id=None,
            normalized_url=None,
            host=None,
            detail=f"Unsupported URL scheme '{scheme}'",
        )

    if parsed.username or parsed.password:
        return ShareUrlValidation(
            valid=False,
            status="blocked",
            reason="embedded_credentials",
            share_id=None,
            normalized_url=None,
            host=None,
            detail="URL must not embed credentials",
        )

    host = (parsed.hostname or "").rstrip(".").lower()
    if not host:
        return ShareUrlValidation(
            valid=False,
            status="invalid",
            reason="missing_host",
            share_id=None,
            normalized_url=None,
            host=None,
            detail="URL is missing a hostname",
        )

    path = parsed.path or "/"
    path_low = path.lower()

    # Check CAPTCHA gates first so sorry redirects carrying continue=app/share stay captcha_blocked.
    if (host == "google.com" or host.endswith(".google.com")) and (
        path_low == "/sorry" or path_low.startswith("/sorry/") or host.startswith("sorry.")
    ):
        return ShareUrlValidation(
            valid=False,
            status="blocked",
            reason="captcha_blocked",
            share_id=None,
            normalized_url=None,
            host=host,
            detail="Refused google.com/sorry CAPTCHA gate without bypassing anti-bot controls",
        )

    # Check auth gates (accounts.google.com or private gemini.google.com/app/...).
    if host == "accounts.google.com" or (
        host == "gemini.google.com"
        and (
            path_low == "/app"
            or path_low.startswith("/app/")
            or re.match(r"^/u/\d+/app(?:/|$)", path_low) is not None
            or path_low.startswith("/signin")
        )
    ):
        return ShareUrlValidation(
            valid=False,
            status="blocked",
            reason="auth_required",
            share_id=None,
            normalized_url=None,
            host=host,
            detail="Refused private authenticated Gemini/Google URL without bypassing auth",
        )

    if scheme != "https":
        return ShareUrlValidation(
            valid=False,
            status="invalid",
            reason="insecure_scheme",
            share_id=None,
            normalized_url=None,
            host=host,
            detail="Public Gemini share URLs require HTTPS",
        )

    if host not in ALLOWED_SHARE_HOSTS:
        return ShareUrlValidation(
            valid=False,
            status="invalid",
            reason="unsupported_host",
            share_id=None,
            normalized_url=None,
            host=host,
            detail=f"Host '{host}' is not an allowed Gemini share host",
        )

    if parsed.port not in (None, 443):
        return ShareUrlValidation(
            valid=False,
            status="invalid",
            reason="unsupported_port",
            share_id=None,
            normalized_url=None,
            host=host,
            detail="Non-standard port is not permitted for Gemini share URLs",
        )

    segments = [seg for seg in path.split("/") if seg]
    share_id: str | None = None
    canonical_path: str | None = None

    if host == "share.gemini.google":
        if len(segments) == 1:
            share_id = segments[0]
            canonical_path = f"/{share_id}"
    elif host == "gemini.google.com":
        if len(segments) == 2 and segments[0] == "share":
            share_id = segments[1]
            canonical_path = f"/share/{share_id}"

    if not share_id or not SHARE_ID_RE.match(share_id):
        return ShareUrlValidation(
            valid=False,
            status="invalid",
            reason="invalid_share_id",
            share_id=None,
            normalized_url=None,
            host=host,
            detail="Expected https://share.gemini.google/<id> or https://gemini.google.com/share/<id>",
        )

    # Check query parameters for secret-bearing material; strip tracking params.
    clean_pairs: list[tuple[str, str]] = []
    for k, v in urllib.parse.parse_qsl(parsed.query, keep_blank_values=True):
        kl = k.lower()
        if kl in TRACKING_QUERY_PARAMS:
            continue
        if kl in SECRET_QUERY_PARAMS or "secret" in kl or "password" in kl or "token" in kl:
            if not _is_safe_placeholder(v):
                return ShareUrlValidation(
                    valid=False,
                    status="blocked",
                    reason="secret_in_query",
                    share_id=None,
                    normalized_url=None,
                    host=host,
                    detail=f"Query parameter '{k}' contains secret material",
                )
        clean_pairs.append((k, v))

    query_str = urllib.parse.urlencode(clean_pairs)
    normalized = urllib.parse.urlunsplit(("https", host, canonical_path, query_str, ""))

    return ShareUrlValidation(
        valid=True,
        status="accepted",
        reason="ok",
        share_id=share_id,
        normalized_url=normalized,
        host=host,
        detail="Valid public Gemini share URL",
    )


def require_valid_share_url(url: str) -> ShareUrlValidation:
    """Validates `url`, raising `GeminiBlockedError` or `GeminiShareError` on rejection."""
    res = validate_share_url(url)
    if res.valid:
        return res
    if res.reason in {"auth_required", "captcha_blocked", "embedded_credentials", "secret_in_query"}:
        raise GeminiBlockedError(res.reason, res.detail)
    raise GeminiShareError(res.reason, res.detail)


def sanitize_url(raw_url: str | None) -> tuple[str | None, list[str]]:
    """Sanitizes a URL by stripping credentials/tracking and redacting secret/signed params."""
    if not isinstance(raw_url, str):
        return None, []
    trimmed = _BIDI_RE.sub("", raw_url).strip()
    if not trimmed:
        return None, []
    if _has_control_chars(trimmed):
        return None, ["url_control_chars_stripped"]

    # Allow benign inline raster data URIs (e.g. cached favicons), block active data/js URIs.
    low = trimmed.lower()
    if low.startswith("data:image/"):
        if "svg" in low[:32]:
            return None, ["unsafe_svg_data_uri_stripped"]
        return trimmed, []
    if not (low.startswith("https://") or low.startswith("http://")):
        return None, ["unsafe_non_http_url_stripped"]

    try:
        parsed = urllib.parse.urlsplit(trimmed)
    except ValueError:
        return REDACTED_URL, ["malformed_url_redacted"]

    flags: list[str] = []
    host = (parsed.hostname or "").lower()
    if not host:
        return REDACTED_URL, ["missing_host_redacted"]

    netloc = f"[{host}]" if ":" in host else host
    if parsed.port is not None:
        netloc = f"{netloc}:{parsed.port}"
    if parsed.username or parsed.password:
        flags.append("url_userinfo_stripped")

    clean_pairs: list[tuple[str, str]] = []
    for k, v in urllib.parse.parse_qsl(parsed.query, keep_blank_values=True):
        kl = k.lower()
        if kl in TRACKING_QUERY_PARAMS:
            flags.append(f"tracking_param_stripped:{k}")
            continue
        is_secret = (
            kl in SECRET_QUERY_PARAMS
            or kl in SIGNED_URL_QUERY_PARAMS
            or "secret" in kl
            or "password" in kl
            or "token" in kl
            or "signature" in kl
        )
        if is_secret and not _is_safe_placeholder(v):
            flags.append(f"query_secret_redacted:{k}")
            clean_pairs.append((k, REDACTED_SECRET))
            continue
        red_val, val_hits = redact_text(v, redact_urls=False)
        if val_hits:
            flags.append(f"query_value_redacted:{k}")
            clean_pairs.append((k, REDACTED_SECRET))
            continue
        clean_pairs.append((k, red_val))

    query = urllib.parse.urlencode(clean_pairs)
    # Restore clean bracketed placeholder rather than percent-encoding `[REDACTED_SECRET]`
    query = query.replace("%5BREDACTED_SECRET%5D", REDACTED_SECRET)
    rebuilt = urllib.parse.urlunsplit((parsed.scheme.lower(), netloc, parsed.path or "/", query, ""))
    return rebuilt, flags


def redact_text(text: str, *, redact_urls: bool = True) -> tuple[str, list[str]]:
    """Redacts PEM keys, Bearer tokens, provider tokens, cookies, KV secrets, signed URLs, emails, and user paths."""
    if not isinstance(text, str) or not text:
        return "", []

    hits: list[str] = []
    out = _BIDI_RE.sub("", text)
    if out != text:
        hits.append("bidi_controls_stripped")

    def _sub_pem(_m: re.Match[str]) -> str:
        hits.append("pem_private_key")
        return REDACTED_PEM_KEY

    out = _PEM_RE.sub(_sub_pem, out)

    def _sub_bearer(m: re.Match[str]) -> str:
        tok = m.group(2)
        if _is_safe_placeholder(tok):
            return m.group(0)
        hits.append("bearer_token")
        return f"{m.group(1)}{REDACTED_SECRET}"

    out = _BEARER_RE.sub(_sub_bearer, out)

    def _sub_provider(m: re.Match[str]) -> str:
        hits.append("provider_token_prefix")
        return REDACTED_SECRET

    out = _PROVIDER_TOKEN_RE.sub(_sub_provider, out)

    def _sub_cookie_hdr(m: re.Match[str]) -> str:
        val = m.group(2).strip()
        if _is_safe_placeholder(val):
            return m.group(0)
        hits.append("cookie_header")
        return f"{m.group(1)}{REDACTED_SECRET}"

    out = _COOKIE_HEADER_RE.sub(_sub_cookie_hdr, out)

    def _sub_cookie_pair(m: re.Match[str]) -> str:
        val = m.group(2)
        if _is_safe_placeholder(val):
            return m.group(0)
        hits.append(f"cookie_secret:{m.group(1)}")
        return f"{m.group(1)}={REDACTED_SECRET}"

    out = _COOKIE_PAIR_RE.sub(_sub_cookie_pair, out)

    def _sub_kv(m: re.Match[str]) -> str:
        val = m.group(4)
        if _is_safe_placeholder(val):
            return m.group(0)
        hits.append(f"kv_secret:{m.group(1).lower()}")
        quote = m.group(3)
        return f"{m.group(1)}{m.group(2)}{quote}{REDACTED_SECRET}{quote}"

    out = _KV_SECRET_RE.sub(_sub_kv, out)

    if redact_urls and ("http://" in out or "https://" in out):
        def _sub_url(m: re.Match[str]) -> str:
            raw_u = m.group(0)
            trailing = ""
            while raw_u and raw_u[-1] in ".,;:)":
                if raw_u[-1] == ")" and raw_u.count("(") >= raw_u.count(")"):
                    break
                trailing = raw_u[-1] + trailing
                raw_u = raw_u[:-1]
            cleaned, url_flags = sanitize_url(raw_u)
            if url_flags:
                hits.extend(url_flags)
            return (cleaned or REDACTED_URL) + trailing

        out = _INLINE_URL_RE.sub(_sub_url, out)

    def _sub_win_path(_m: re.Match[str]) -> str:
        hits.append("windows_user_profile")
        return REDACTED_USER_PROFILE

    out = _WIN_PROFILE_RE.sub(_sub_win_path, out)

    def _sub_posix_path(_m: re.Match[str]) -> str:
        hits.append("posix_user_home")
        return f"/{REDACTED_USER_HOME}"

    out = _POSIX_HOME_RE.sub(_sub_posix_path, out)

    def _sub_email(m: re.Match[str]) -> str:
        hits.append("pii_email")
        return REDACTED_EMAIL

    out = _EMAIL_RE.sub(_sub_email, out)

    # Preserve insertion order while deduplicating hit labels.
    dedup_hits = list(dict.fromkeys(hits))
    return out, dedup_hits


def _find_unsafe_prototype_key(obj: Any, path: str = "$") -> str | None:
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k in UNSAFE_PROTOTYPE_KEYS:
                return f"{path}.{k}"
            nested = _find_unsafe_prototype_key(v, f"{path}.{k}")
            if nested is not None:
                return nested
    elif isinstance(obj, list):
        for idx, item in enumerate(obj):
            nested = _find_unsafe_prototype_key(item, f"{path}[{idx}]")
            if nested is not None:
                return nested
    return None


def _detect_html_gate(raw_text: str) -> str | None:
    low = raw_text[:8192].lower()
    if "<html" not in low and "<!doctype html" not in low:
        return None
    if (
        "google.com/sorry" in low
        or "g-recaptcha" in low
        or "unusual traffic from your computer network" in low
        or "recaptcha/api.js" in low
    ):
        return "captcha_blocked"
    if (
        "accounts.google.com/servicelogin" in low
        or "accounts.google.com/v3/signin" in low
        or "sign in - google accounts" in low
        or "consent.google.com" in low
    ):
        return "auth_required"
    return None


def _strip_xssi_prefix(text: str, pos: int) -> int:
    n = len(text)
    while pos < n and text[pos] in " \t\r\n":
        pos += 1
    if text.startswith(")]}'", pos):
        pos += 4
        while pos < n and text[pos] in " \t\r\n":
            pos += 1
    return pos


def _format_published_timestamp(raw_val: Any) -> str | None:
    if raw_val is None:
        return None
    if isinstance(raw_val, str):
        stripped = raw_val.strip()
        return stripped or None
    if isinstance(raw_val, (int, float)) and not isinstance(raw_val, bool):
        sec = float(raw_val)
        if sec > 1e12:
            sec /= 1000.0
        try:
            dt = datetime.fromtimestamp(sec, tz=timezone.utc)
            return dt.strftime("%Y-%m-%dT%H:%M:%SZ")
        except (OverflowError, OSError, ValueError):
            return str(raw_val)
    if isinstance(raw_val, list) and raw_val:
        sec_val = raw_val[0]
        if isinstance(sec_val, (int, float)) and not isinstance(sec_val, bool):
            nanos = 0
            if len(raw_val) > 1 and isinstance(raw_val[1], (int, float)) and not isinstance(raw_val[1], bool):
                nanos = int(raw_val[1])
            try:
                dt = datetime.fromtimestamp(float(sec_val), tz=timezone.utc)
                if nanos > 0:
                    micro = min(999999, nanos // 1000)
                    dt = dt.replace(microsecond=micro)
                    return dt.strftime("%Y-%m-%dT%H:%M:%S.%fZ")
                return dt.strftime("%Y-%m-%dT%H:%M:%SZ")
            except (OverflowError, OSError, ValueError):
                return str(raw_val)
    return None


def _parse_ot_aq7b_model_map(payload: Any) -> dict[str, str]:
    models: dict[str, str] = {}
    if isinstance(payload, dict):
        for k, v in payload.items():
            if k in UNSAFE_PROTOTYPE_KEYS:
                continue
            if isinstance(v, str) and v.strip():
                models[str(k)] = v.strip()
            elif isinstance(v, dict):
                name = v.get("name") or v.get("display_name") or v.get("label")
                if isinstance(name, str) and name.strip():
                    models[str(k)] = name.strip()
        return models

    if not isinstance(payload, list):
        return models

    # WIZ `otAQ7b` may wrap entries directly or inside `payload[0]`.
    candidates = payload
    if len(payload) == 1 and isinstance(payload[0], list) and payload[0] and isinstance(payload[0][0], list):
        candidates = payload[0]

    for entry in candidates:
        if isinstance(entry, dict):
            mid = entry.get("id") or entry.get("model_id")
            mname = entry.get("name") or entry.get("display_name") or entry.get("label")
            if isinstance(mid, str) and mid.strip() and isinstance(mname, str) and mname.strip():
                models[mid.strip()] = mname.strip()
        elif isinstance(entry, list) and len(entry) >= 2:
            raw_id = entry[0]
            if isinstance(raw_id, (str, int)) and not isinstance(raw_id, bool):
                mid_str = str(raw_id).strip()
                # Prefer first readable non-ID string label in entry[1..].
                label: str | None = None
                for cell in entry[1:]:
                    if isinstance(cell, str) and cell.strip():
                        label = cell.strip()
                        break
                    if isinstance(cell, list) and cell and isinstance(cell[0], str) and cell[0].strip():
                        label = cell[0].strip()
                        break
                if mid_str and label:
                    models[mid_str] = label
    return models


def _parse_ujx1bf_root(root: Any) -> dict[str, Any]:
    if not isinstance(root, list) or not root or not isinstance(root[0], list):
        raise GeminiDecodeError("invalid_ujx1bf_root", "ujx1Bf payload must be a nested list with root[0]")

    container = root[0]
    raw_cursor = container[0] if len(container) > 0 else None
    cursor = raw_cursor.strip() if isinstance(raw_cursor, str) and raw_cursor.strip() else None

    raw_turns = container[1] if len(container) > 1 and isinstance(container[1], list) else []

    title: str | None = None
    header_conv_id: str | None = None
    if len(container) > 2 and isinstance(container[2], list):
        meta = container[2]
        if len(meta) > 0 and isinstance(meta[0], str) and meta[0].strip():
            header_conv_id = meta[0].strip()
        if len(meta) > 1 and isinstance(meta[1], str) and meta[1].strip():
            title = meta[1].strip()

    share_id: str | None = None
    if len(container) > 3 and isinstance(container[3], str) and container[3].strip():
        share_id = container[3].strip()

    raw_pub = container[4] if len(container) > 4 else None
    published_timestamp = _format_published_timestamp(raw_pub)

    return {
        "cursor": cursor,
        "turns": raw_turns,
        "title": title,
        "header_conversation_id": header_conv_id,
        "share_id": share_id,
        "published_timestamp": published_timestamp,
        "root": root,
    }


def decode_batchexecute_frames(raw_text: str) -> dict[str, Any]:
    """Parses Google WIZ `batchexecute` length-prefixed/JSON `wrb.fr` frames.

    Strips optional `)]}'` anti-XSSI prefixes (including across concatenated pages),
    extracts `ujx1Bf` roots (`root[0][0]` cursor, `root[0][1]` turns, `root[0][2][1]`
    title, `root[0][3]` share_id, `root[0][4]` published timestamp) and `otAQ7b` model maps.
    """
    if not isinstance(raw_text, str):
        raise GeminiDecodeError("invalid_input", "raw_text must be a string")
    if len(raw_text.encode("utf-8", errors="ignore")) > MAX_RAW_TEXT_BYTES:
        raise GeminiDecodeError("payload_too_large", "raw_text exceeds 64 MiB limit")

    cleaned = raw_text.lstrip("\ufeff")
    if not cleaned.strip():
        raise GeminiDecodeError("empty_payload", "batchexecute payload is empty")

    gate = _detect_html_gate(cleaned)
    if gate is not None:
        raise GeminiBlockedError(gate, f"HTML response hit {gate} gate")

    decoder = json.JSONDecoder()
    pos = _strip_xssi_prefix(cleaned, 0)
    n = len(cleaned)

    chunks: list[Any] = []
    while pos < n:
        pos = _strip_xssi_prefix(cleaned, pos)
        if pos >= n:
            break

        # Skip WIZ chunk length header lines like `452\n` or `1024\r\n`.
        line_end = cleaned.find("\n", pos)
        line = cleaned[pos:] if line_end == -1 else cleaned[pos:line_end]
        line_stripped = line.strip()
        if line_stripped.isdigit():
            pos = n if line_end == -1 else line_end + 1
            pos = _strip_xssi_prefix(cleaned, pos)
            if pos >= n:
                break

        try:
            obj, next_pos = decoder.raw_decode(cleaned, pos)
        except json.JSONDecodeError as exc:
            raise GeminiDecodeError(
                "malformed_batchexecute_json",
                f"Failed decoding batchexecute frame at offset {pos}: {exc}",
            ) from exc

        unsafe_path = _find_unsafe_prototype_key(obj)
        if unsafe_path is not None:
            raise GeminiDecodeError(
                "unsafe_prototype_key",
                f"Forbidden prototype key detected at {unsafe_path}",
            )
        chunks.append(obj)
        pos = next_pos

    if not chunks:
        raise GeminiDecodeError("empty_frames", "No batchexecute JSON chunks found")

    frames: list[dict[str, Any]] = []
    ujx1bf_roots: list[Any] = []
    ujx1bf_pages: list[dict[str, Any]] = []
    model_map: dict[str, str] = {}
    errors: list[dict[str, Any]] = []

    def _collect_envelopes(chunk: Any) -> list[list[Any]]:
        if isinstance(chunk, list) and chunk:
            if isinstance(chunk[0], str):
                return [chunk]
            return [item for item in chunk if isinstance(item, list)]
        return []

    for chunk in chunks:
        for env in _collect_envelopes(chunk):
            tag = env[0] if env and isinstance(env[0], str) else ""
            if tag == "er":
                errors.append({"kind": "er", "envelope": env})
                continue
            if tag != "wrb.fr":
                continue

            rpc_id = env[1] if len(env) > 1 and isinstance(env[1], str) else ""
            raw_payload = env[2] if len(env) > 2 else None
            error_info = env[5] if len(env) > 5 else None

            if raw_payload is None and error_info is not None:
                errors.append({"kind": "wrb.fr", "rpc_id": rpc_id, "error": error_info})
                err_txt = json.dumps(error_info).lower()
                if "unauthenticated" in err_txt or error_info == [7] or error_info == 7:
                    raise GeminiBlockedError("auth_required", "WIZ RPC returned unauthenticated status")
                if "captcha" in err_txt or "sorry" in err_txt:
                    raise GeminiBlockedError("captcha_blocked", "WIZ RPC returned CAPTCHA block")
                continue

            parsed_payload: Any = raw_payload
            if isinstance(raw_payload, str):
                try:
                    parsed_payload = json.loads(raw_payload)
                except json.JSONDecodeError as exc:
                    raise GeminiDecodeError(
                        "malformed_wrb_payload",
                        f"Invalid JSON payload inside wrb.fr frame for '{rpc_id}': {exc}",
                    ) from exc

            unsafe_path = _find_unsafe_prototype_key(parsed_payload)
            if unsafe_path is not None:
                raise GeminiDecodeError(
                    "unsafe_prototype_key",
                    f"Forbidden prototype key inside '{rpc_id}' payload at {unsafe_path}",
                )

            frame_rec: dict[str, Any] = {
                "rpc_id": rpc_id,
                "payload": parsed_payload,
            }
            frames.append(frame_rec)

            if rpc_id == "ujx1Bf":
                page = _parse_ujx1bf_root(parsed_payload)
                ujx1bf_roots.append(parsed_payload)
                ujx1bf_pages.append(page)
            elif rpc_id == "otAQ7b":
                model_map.update(_parse_ot_aq7b_model_map(parsed_payload))

    return {
        "frames": frames,
        "ujx1bf_roots": ujx1bf_roots,
        "ujx1bf_pages": ujx1bf_pages,
        "model_map": model_map,
        "errors": errors,
        "raw_frame_count": len(frames),
    }


def _safe_str(val: Any) -> str | None:
    if isinstance(val, str):
        return val
    return None


def _clean_text(val: str, redact: bool, field: str, redacted_fields: list[str]) -> str:
    if not redact:
        return val
    cleaned, hits = redact_text(val)
    for h in hits:
        redacted_fields.append(f"{field}:{h}")
    return cleaned


def _clean_url_field(val: Any, redact: bool, field: str, redacted_fields: list[str]) -> str | None:
    if not isinstance(val, str) or not val.strip():
        return None
    if not redact:
        return val.strip()
    cleaned, flags = sanitize_url(val)
    for f in flags:
        redacted_fields.append(f"{field}:{f}")
    return cleaned


def _normalize_attachments(
    prompt_node: Any,
    redact: bool,
    turn_idx: int,
    redacted_fields: list[str],
) -> list[dict[str, Any]]:
    """Extracts uploaded files (`t[2][0][4]`) and pasted blocks (`t[2][15]`).

    Explicitly ignores scalar boolean `t[2][8] = false`.
    """
    if not isinstance(prompt_node, list):
        return []

    attachments: list[dict[str, Any]] = []

    # 1. Uploaded files at `t[2][0][4]`
    if len(prompt_node) > 0 and isinstance(prompt_node[0], list):
        inner = prompt_node[0]
        raw_uploads = inner[4] if len(inner) > 4 else None
        if isinstance(raw_uploads, list):
            for idx, item in enumerate(raw_uploads):
                rec = _parse_upload_item(item, redact, f"turns[{turn_idx}].attachments[{idx}]", redacted_fields)
                if rec is not None:
                    attachments.append(rec)

    # 2. Explicitly ignore `t[2][8]` when scalar boolean (`false`/`true`) — never parse it as attachments!
    if len(prompt_node) > 8 and isinstance(prompt_node[8], bool):
        pass

    # 3. Pasted blocks at `t[2][15]`
    raw_pasted = prompt_node[15] if len(prompt_node) > 15 else None
    if isinstance(raw_pasted, str) and raw_pasted.strip():
        text_val = _clean_text(
            raw_pasted,
            redact,
            f"turns[{turn_idx}].pasted[0]",
            redacted_fields,
        )
        attachments.append({
            "kind": "pasted_block",
            "name": "pasted-text-1",
            "mime_type": "text/plain",
            "url": None,
            "text": text_val,
            "size_bytes": len(raw_pasted.encode("utf-8")),
        })
    elif isinstance(raw_pasted, list) and raw_pasted:
        # Handle either a list of block items OR a single `[text, name, mime]` tuple.
        if all(not isinstance(x, (list, dict)) for x in raw_pasted) and isinstance(raw_pasted[0], str):
            pasted_items: list[Any] = [raw_pasted]
        else:
            pasted_items = raw_pasted

        for p_idx, item in enumerate(pasted_items):
            rec = _parse_pasted_item(
                item,
                redact,
                f"turns[{turn_idx}].pasted[{p_idx}]",
                p_idx,
                redacted_fields,
            )
            if rec is not None:
                attachments.append(rec)

    return attachments


def _parse_upload_item(
    item: Any,
    redact: bool,
    field_prefix: str,
    redacted_fields: list[str],
) -> dict[str, Any] | None:
    if isinstance(item, bool) or item is None:
        return None
    if isinstance(item, dict):
        name = _safe_str(item.get("name") or item.get("filename") or item.get("title")) or "uploaded-file"
        mime = _safe_str(item.get("mime_type") or item.get("mime"))
        url = _clean_url_field(item.get("url") or item.get("uri"), redact, f"{field_prefix}.url", redacted_fields)
        size = item.get("size_bytes") if isinstance(item.get("size_bytes"), int) else None
        return {
            "kind": "uploaded_file",
            "name": _clean_text(name, redact, f"{field_prefix}.name", redacted_fields),
            "mime_type": mime,
            "url": url,
            "text": None,
            "size_bytes": size,
        }
    if isinstance(item, str) and item.strip():
        if item.strip().startswith(("http://", "https://")):
            return {
                "kind": "uploaded_file",
                "name": "uploaded-file",
                "mime_type": None,
                "url": _clean_url_field(item, redact, f"{field_prefix}.url", redacted_fields),
                "text": None,
                "size_bytes": None,
            }
        return {
            "kind": "uploaded_file",
            "name": _clean_text(item.strip(), redact, f"{field_prefix}.name", redacted_fields),
            "mime_type": None,
            "url": None,
            "text": None,
            "size_bytes": None,
        }
    if isinstance(item, list) and item:
        url: str | None = None
        name: str | None = None
        mime: str | None = None
        size: int | None = None

        def _visit(cell: Any) -> None:
            nonlocal url, name, mime, size
            if isinstance(cell, bool) or cell is None:
                return
            if isinstance(cell, int) and size is None and cell >= 0:
                size = cell
                return
            if isinstance(cell, str):
                s = cell.strip()
                if not s:
                    return
                if s.startswith(("http://", "https://")) and url is None:
                    url = _clean_url_field(s, redact, f"{field_prefix}.url", redacted_fields)
                elif "/" in s and " " not in s and len(s) < 96 and "." not in s.split("/")[-1] and mime is None:
                    mime = s
                elif name is None:
                    name = _clean_text(s, redact, f"{field_prefix}.name", redacted_fields)
            elif isinstance(cell, list):
                for sub in cell:
                    _visit(sub)

        _visit(item)
        if url or name or mime:
            return {
                "kind": "uploaded_file",
                "name": name or "uploaded-file",
                "mime_type": mime,
                "url": url,
                "text": None,
                "size_bytes": size,
            }
    return None


def _parse_pasted_item(
    item: Any,
    redact: bool,
    field_prefix: str,
    idx: int,
    redacted_fields: list[str],
) -> dict[str, Any] | None:
    if isinstance(item, bool) or item is None:
        return None
    if isinstance(item, dict):
        text_raw = _safe_str(item.get("text") or item.get("content")) or ""
        name = _safe_str(item.get("name") or item.get("title")) or f"pasted-block-{idx + 1}"
        mime = _safe_str(item.get("mime_type") or item.get("mime")) or "text/plain"
        if not text_raw and not name:
            return None
        return {
            "kind": "pasted_block",
            "name": _clean_text(name, redact, f"{field_prefix}.name", redacted_fields),
            "mime_type": mime,
            "url": None,
            "text": _clean_text(text_raw, redact, f"{field_prefix}.text", redacted_fields),
            "size_bytes": len(text_raw.encode("utf-8")),
        }
    if isinstance(item, str) and item.strip():
        return {
            "kind": "pasted_block",
            "name": f"pasted-block-{idx + 1}",
            "mime_type": "text/plain",
            "url": None,
            "text": _clean_text(item, redact, f"{field_prefix}.text", redacted_fields),
            "size_bytes": len(item.encode("utf-8")),
        }
    if isinstance(item, list) and item:
        text_raw = _safe_str(item[0]) if len(item) > 0 else None
        if text_raw is None and len(item) > 0 and isinstance(item[0], list):
            text_raw = _safe_str(item[0][0]) if item[0] else None
        name = _safe_str(item[1]) if len(item) > 1 else None
        mime = _safe_str(item[2]) if len(item) > 2 else None
        if text_raw is None and name is None:
            return None
        text_str = text_raw or ""
        return {
            "kind": "pasted_block",
            "name": _clean_text(name or f"pasted-block-{idx + 1}", redact, f"{field_prefix}.name", redacted_fields),
            "mime_type": mime or "text/plain",
            "url": None,
            "text": _clean_text(text_str, redact, f"{field_prefix}.text", redacted_fields),
            "size_bytes": len(text_str.encode("utf-8")),
        }
    return None


def _normalize_thinking_sources(
    raw_sources: Any,
    redact: bool,
    field_prefix: str,
    redacted_fields: list[str],
) -> list[dict[str, Any]]:
    if not isinstance(raw_sources, list):
        return []
    sources: list[dict[str, Any]] = []
    for idx, src in enumerate(raw_sources):
        if isinstance(src, dict):
            url = _clean_url_field(src.get("url"), redact, f"{field_prefix}[{idx}].url", redacted_fields)
            favicon = _clean_url_field(
                src.get("favicon"), redact, f"{field_prefix}[{idx}].favicon", redacted_fields
            )
            title = _clean_text(
                _safe_str(src.get("title")) or "",
                redact,
                f"{field_prefix}[{idx}].title",
                redacted_fields,
            )
            if url or title:
                sources.append({"favicon": favicon, "url": url, "title": title})
        elif isinstance(src, list) and src:
            favicon: str | None = None
            url: str | None = None
            title = ""
            if len(src) >= 3:
                s0, s1, s2 = src[0], src[1], src[2]
                if isinstance(s1, str) and s1.strip().startswith(("http://", "https://")):
                    favicon = _clean_url_field(s0, redact, f"{field_prefix}[{idx}].favicon", redacted_fields)
                    url = _clean_url_field(s1, redact, f"{field_prefix}[{idx}].url", redacted_fields)
                    title = _clean_text(_safe_str(s2) or "", redact, f"{field_prefix}[{idx}].title", redacted_fields)
                elif isinstance(s0, str) and s0.strip().startswith(("http://", "https://")):
                    url = _clean_url_field(s0, redact, f"{field_prefix}[{idx}].url", redacted_fields)
                    title = _clean_text(_safe_str(s1) or "", redact, f"{field_prefix}[{idx}].title", redacted_fields)
                    favicon = _clean_url_field(s2, redact, f"{field_prefix}[{idx}].favicon", redacted_fields)
                else:
                    favicon = _clean_url_field(s0, redact, f"{field_prefix}[{idx}].favicon", redacted_fields)
                    url = _clean_url_field(s1, redact, f"{field_prefix}[{idx}].url", redacted_fields)
                    title = _clean_text(_safe_str(s2) or "", redact, f"{field_prefix}[{idx}].title", redacted_fields)
            elif len(src) == 2:
                s0, s1 = src[0], src[1]
                if isinstance(s1, str) and s1.strip().startswith(("http://", "https://")):
                    favicon = _clean_url_field(s0, redact, f"{field_prefix}[{idx}].favicon", redacted_fields)
                    url = _clean_url_field(s1, redact, f"{field_prefix}[{idx}].url", redacted_fields)
                elif isinstance(s0, str) and s0.strip().startswith(("http://", "https://")):
                    url = _clean_url_field(s0, redact, f"{field_prefix}[{idx}].url", redacted_fields)
                    title = _clean_text(_safe_str(s1) or "", redact, f"{field_prefix}[{idx}].title", redacted_fields)
            if url or title:
                sources.append({"favicon": favicon, "url": url, "title": title})
    return sources


def _normalize_thinking_steps(
    draft: list[Any],
    redact: bool,
    turn_idx: int,
    redacted_fields: list[str],
) -> list[dict[str, Any]]:
    if len(draft) <= 37 or not isinstance(draft[37], list) or len(draft[37]) <= 1:
        return []
    raw_steps = draft[37][1]
    if not isinstance(raw_steps, list):
        return []

    steps: list[dict[str, Any]] = []
    for s_idx, item in enumerate(raw_steps):
        prefix = f"turns[{turn_idx}].thinking_steps[{s_idx}]"
        if isinstance(item, dict):
            action = _safe_str(item.get("action")) or "think"
            provider = _safe_str(item.get("provider"))
            header = _clean_text(_safe_str(item.get("header")) or "", redact, f"{prefix}.header", redacted_fields)
            body = _clean_text(_safe_str(item.get("body")) or "", redact, f"{prefix}.body", redacted_fields)
            sources = _normalize_thinking_sources(
                item.get("sources"), redact, f"{prefix}.sources", redacted_fields
            )
            steps.append({
                "action": action,
                "provider": provider,
                "header": header,
                "body": body,
                "sources": sources,
            })
        elif isinstance(item, list) and item:
            action: str | None = "think"
            provider: str | None = None
            header = ""
            body = ""
            raw_sources: Any = []

            if len(item) >= 5:
                action = _safe_str(item[0]) or "think"
                provider = _safe_str(item[1])
                header = _safe_str(item[2]) or ""
                if isinstance(item[3], str):
                    body = item[3]
                elif isinstance(item[3], list):
                    body = "\n".join(x for x in item[3] if isinstance(x, str))
                raw_sources = item[4]
            elif len(item) == 4:
                if isinstance(item[3], list):
                    action = _safe_str(item[0]) or "think"
                    provider = _safe_str(item[1])
                    header = _safe_str(item[2]) or ""
                    raw_sources = item[3]
                else:
                    action = _safe_str(item[0]) or "think"
                    provider = _safe_str(item[1])
                    header = _safe_str(item[2]) or ""
                    body = _safe_str(item[3]) or ""
            elif len(item) == 3:
                if isinstance(item[2], list):
                    header = _safe_str(item[0]) or ""
                    body = _safe_str(item[1]) or ""
                    raw_sources = item[2]
                else:
                    action = _safe_str(item[0]) or "think"
                    header = _safe_str(item[1]) or ""
                    body = _safe_str(item[2]) or ""
            elif len(item) == 2:
                header = _safe_str(item[0]) or ""
                body = _safe_str(item[1]) or ""
            elif len(item) == 1:
                body = _safe_str(item[0]) or ""

            steps.append({
                "action": action,
                "provider": provider,
                "header": _clean_text(header, redact, f"{prefix}.header", redacted_fields),
                "body": _clean_text(body, redact, f"{prefix}.body", redacted_fields),
                "sources": _normalize_thinking_sources(
                    raw_sources, redact, f"{prefix}.sources", redacted_fields
                ),
            })
    return steps


def _normalize_span(raw_span: Any, redact: bool, field_prefix: str, redacted_fields: list[str]) -> Any:
    if isinstance(raw_span, dict):
        out: dict[str, Any] = {}
        for key in ("start", "end", "start_index", "end_index"):
            if key in raw_span and isinstance(raw_span[key], int) and not isinstance(raw_span[key], bool):
                out[key] = raw_span[key]
        if isinstance(raw_span.get("text"), str):
            out["text"] = _clean_text(raw_span["text"], redact, f"{field_prefix}.text", redacted_fields)
        return out
    if isinstance(raw_span, list):
        out_dict: dict[str, Any] = {}
        if len(raw_span) >= 2 and isinstance(raw_span[0], int) and isinstance(raw_span[1], int):
            out_dict["start"] = raw_span[0]
            out_dict["end"] = raw_span[1]
            if len(raw_span) >= 3 and isinstance(raw_span[2], str):
                out_dict["text"] = _clean_text(
                    raw_span[2], redact, f"{field_prefix}.text", redacted_fields
                )
            return out_dict
        return [
            _clean_text(x, redact, f"{field_prefix}[{i}]", redacted_fields) if isinstance(x, str) else x
            for i, x in enumerate(raw_span)
        ]
    if isinstance(raw_span, str):
        return _clean_text(raw_span, redact, field_prefix, redacted_fields)
    return raw_span


def _normalize_grounding_item(
    item: Any,
    redact: bool,
    field_prefix: str,
    redacted_fields: list[str],
) -> dict[str, Any] | None:
    if isinstance(item, dict):
        url = _clean_url_field(item.get("url"), redact, f"{field_prefix}.url", redacted_fields)
        title = _clean_text(_safe_str(item.get("title")) or "", redact, f"{field_prefix}.title", redacted_fields)
        snippet_raw = _safe_str(item.get("snippet"))
        snippet = (
            _clean_text(snippet_raw, redact, f"{field_prefix}.snippet", redacted_fields)
            if snippet_raw is not None
            else None
        )
        pub_raw = _safe_str(item.get("publisher"))
        publisher = (
            _clean_text(pub_raw, redact, f"{field_prefix}.publisher", redacted_fields)
            if pub_raw is not None
            else None
        )
        if url or title or snippet:
            return {"url": url, "title": title, "snippet": snippet, "publisher": publisher}
        return None
    if isinstance(item, list) and item:
        raw_url = item[0]
        pub_hint: str | None = None
        if isinstance(raw_url, list) and raw_url:
            pub_hint = _safe_str(raw_url[1]) if len(raw_url) > 1 else None
            raw_url = raw_url[0]
        url = _clean_url_field(raw_url, redact, f"{field_prefix}.url", redacted_fields)
        title = _clean_text(
            _safe_str(item[1]) if len(item) > 1 and isinstance(item[1], str) else "",
            redact,
            f"{field_prefix}.title",
            redacted_fields,
        )
        snippet_raw = _safe_str(item[2]) if len(item) > 2 else None
        snippet = (
            _clean_text(snippet_raw, redact, f"{field_prefix}.snippet", redacted_fields)
            if snippet_raw is not None
            else None
        )
        pub_raw = (_safe_str(item[3]) if len(item) > 3 else None) or pub_hint
        publisher = (
            _clean_text(pub_raw, redact, f"{field_prefix}.publisher", redacted_fields)
            if pub_raw is not None
            else None
        )
        if url or title or snippet:
            return {"url": url, "title": title, "snippet": snippet, "publisher": publisher}
    return None


def _normalize_grounding_citations(
    draft: list[Any],
    redact: bool,
    turn_idx: int,
    redacted_fields: list[str],
) -> list[dict[str, Any]]:
    if len(draft) <= 2 or not isinstance(draft[2], list) or len(draft[2]) <= 1:
        return []
    raw_groups = draft[2][1]
    if not isinstance(raw_groups, list):
        return []

    citations: list[dict[str, Any]] = []
    for g_idx, group in enumerate(raw_groups):
        prefix = f"turns[{turn_idx}].grounding_citations[{g_idx}]"
        if isinstance(group, dict):
            span = _normalize_span(group.get("span"), redact, f"{prefix}.span", redacted_fields)
            raw_items = group.get("items") if isinstance(group.get("items"), list) else []
            items: list[dict[str, Any]] = []
            for i_idx, item in enumerate(raw_items):
                norm = _normalize_grounding_item(item, redact, f"{prefix}.items[{i_idx}]", redacted_fields)
                if norm is not None:
                    items.append(norm)
            if span is not None or items:
                citations.append({"span": span, "items": items})
        elif isinstance(group, list) and group:
            if len(group) >= 2 and isinstance(group[1], list):
                span = _normalize_span(group[0], redact, f"{prefix}.span", redacted_fields)
                raw_items = group[1]
                # Handle `[span, [url, title, snippet, publisher]]` where `group[1]` is a single flat citation item.
                if raw_items and isinstance(raw_items[0], str) and raw_items[0].startswith(("http://", "https://")):
                    raw_items = [raw_items]
                items = []
                for i_idx, item in enumerate(raw_items):
                    norm = _normalize_grounding_item(item, redact, f"{prefix}.items[{i_idx}]", redacted_fields)
                    if norm is not None:
                        items.append(norm)
                if span is not None or items:
                    citations.append({"span": span, "items": items})
            else:
                norm = _normalize_grounding_item(group, redact, f"{prefix}.items[0]", redacted_fields)
                if norm is not None:
                    citations.append({"span": None, "items": [norm]})
    return citations


def _extract_turn(
    raw_turn: Any,
    turn_idx: int,
    header_conv_id: str | None,
    model_map: dict[str, str],
    redact: bool,
    redacted_fields: list[str],
) -> dict[str, Any]:
    if not isinstance(raw_turn, list):
        raise GeminiDecodeError("invalid_turn", f"Turn {turn_idx} is not a list")

    # `t[0]` holds `[conversation_id, turn_id]` or scalar `turn_id`.
    conversation_id: str | None = header_conv_id
    turn_id = ""
    if len(raw_turn) > 0:
        t0 = raw_turn[0]
        if isinstance(t0, list):
            if len(t0) >= 2:
                conversation_id = _safe_str(t0[0]) or conversation_id
                turn_id = _safe_str(t0[1]) or _safe_str(t0[0]) or ""
            elif len(t0) == 1:
                turn_id = _safe_str(t0[0]) or ""
        elif isinstance(t0, str):
            turn_id = t0.strip()
            if not conversation_id:
                conversation_id = turn_id

    # `t[2][0][0]` prompt text, `t[2][0][4]` uploaded files, `t[2][15]` pasted blocks (`t[2][8]=false` ignored).
    prompt_node = raw_turn[2] if len(raw_turn) > 2 else None
    raw_prompt = ""
    if isinstance(prompt_node, list) and len(prompt_node) > 0:
        if isinstance(prompt_node[0], list) and len(prompt_node[0]) > 0:
            raw_prompt = _safe_str(prompt_node[0][0]) or ""
        elif isinstance(prompt_node[0], str):
            raw_prompt = prompt_node[0]

    prompt_text = _clean_text(raw_prompt, redact, f"turns[{turn_idx}].prompt_text", redacted_fields)
    attachments = _normalize_attachments(prompt_node, redact, turn_idx, redacted_fields)

    # `t[3]` holds candidate drafts (`t[3][0][0]`), `search_queries` (`t[3][1]`), and `model_id` (`t[3][14]`).
    resp_node = raw_turn[3] if len(raw_turn) > 3 and isinstance(raw_turn[3], list) else []

    search_queries: list[str] = []
    if len(resp_node) > 1 and isinstance(resp_node[1], list):
        for q_idx, q_item in enumerate(resp_node[1]):
            q_str: str | None = None
            if isinstance(q_item, str):
                q_str = q_item
            elif isinstance(q_item, list) and q_item and isinstance(q_item[0], str):
                q_str = q_item[0]
            if q_str and q_str.strip():
                search_queries.append(
                    _clean_text(
                        q_str.strip(),
                        redact,
                        f"turns[{turn_idx}].search_queries[{q_idx}]",
                        redacted_fields,
                    )
                )

    model_id: str | None = None
    if len(resp_node) > 14:
        raw_mid = resp_node[14]
        if isinstance(raw_mid, str) and raw_mid.strip():
            model_id = raw_mid.strip()
        elif isinstance(raw_mid, int) and not isinstance(raw_mid, bool):
            model_id = str(raw_mid)
        elif isinstance(raw_mid, list) and raw_mid and isinstance(raw_mid[0], (str, int)):
            model_id = str(raw_mid[0]).strip()
    model_name = model_map.get(model_id) if model_id else None

    draft: list[Any] = []
    if len(resp_node) > 0 and isinstance(resp_node[0], list) and resp_node[0]:
        if isinstance(resp_node[0][0], list):
            draft = resp_node[0][0]
        else:
            draft = resp_node[0]

    response_id = _safe_str(draft[0]) if len(draft) > 0 else None
    raw_resp_md = ""
    if len(draft) > 1:
        if isinstance(draft[1], list) and draft[1]:
            raw_resp_md = _safe_str(draft[1][0]) or ""
        elif isinstance(draft[1], str):
            raw_resp_md = draft[1]
    response_markdown = _clean_text(
        raw_resp_md, redact, f"turns[{turn_idx}].response_markdown", redacted_fields
    )

    thinking_steps = _normalize_thinking_steps(draft, redact, turn_idx, redacted_fields)
    grounding_citations = _normalize_grounding_citations(draft, redact, turn_idx, redacted_fields)

    return {
        "turn_index": turn_idx,
        "conversation_id": conversation_id,
        "turn_id": turn_id,
        "prompt_text": prompt_text,
        "attachments": attachments,
        "search_queries": search_queries,
        "model_id": model_id,
        "model_name": model_name,
        "response_id": response_id,
        "response_markdown": response_markdown,
        "thinking_steps": thinking_steps,
        "grounding_citations": grounding_citations,
    }


def _compute_summary(turns: list[dict[str, Any]], cursor_exhausted: bool) -> dict[str, Any]:
    turns_total = len(turns)
    turns_with_thinking = 0
    thinking_steps_total = 0
    turns_with_sources = 0
    unique_urls: set[str] = set()
    search_queries_total = 0
    attachments_total = 0
    empty_turns_total = 0

    for turn in turns:
        prompt_ok = bool((turn.get("prompt_text") or "").strip()) or bool(turn.get("attachments"))
        resp_ok = bool((turn.get("response_markdown") or "").strip()) or bool(turn.get("thinking_steps"))
        if not prompt_ok or not resp_ok:
            empty_turns_total += 1

        steps = turn.get("thinking_steps") or []
        if steps:
            turns_with_thinking += 1
            thinking_steps_total += len(steps)

        turn_has_source = False
        for step in steps:
            for src in step.get("sources") or []:
                u = src.get("url")
                if isinstance(u, str) and u.strip():
                    unique_urls.add(u.strip())
                    turn_has_source = True
                elif isinstance(src.get("title"), str) and src["title"].strip():
                    turn_has_source = True

        for gc in turn.get("grounding_citations") or []:
            for item in gc.get("items") or []:
                u = item.get("url")
                if isinstance(u, str) and u.strip():
                    unique_urls.add(u.strip())
                    turn_has_source = True
                elif isinstance(item.get("title"), str) and item["title"].strip():
                    turn_has_source = True

        if turn_has_source:
            turns_with_sources += 1

        search_queries_total += len(turn.get("search_queries") or [])
        attachments_total += len(turn.get("attachments") or [])

    return {
        "turns_total": turns_total,
        "turns_with_thinking": turns_with_thinking,
        "thinking_steps_total": thinking_steps_total,
        "turns_with_sources": turns_with_sources,
        "unique_sources_total": len(unique_urls),
        "search_queries_total": search_queries_total,
        "attachments_total": attachments_total,
        "empty_turns_total": empty_turns_total,
        "cursor_exhausted": bool(cursor_exhausted),
    }


def extract_share_transcript(
    raw_frames_or_roots: Any,
    source_url: str = "",
    redact: bool = True,
) -> dict[str, Any]:
    """Extracts a complete `omnia.gemini-share-transcript.v1` transcript across paginated `ujx1Bf` pages."""
    sanitized_source_url: str | None = None
    share_id_from_url: str | None = None
    redacted_fields: list[str] = []

    if isinstance(source_url, str) and source_url.strip():
        checked = require_valid_share_url(source_url)
        share_id_from_url = checked.share_id
        sanitized_source_url, url_flags = sanitize_url(checked.normalized_url)
        for f in url_flags:
            redacted_fields.append(f"source_url:{f}")

    pages: list[dict[str, Any]] = []
    model_map: dict[str, str] = {}

    if isinstance(raw_frames_or_roots, str):
        decoded = decode_batchexecute_frames(raw_frames_or_roots)
        pages.extend(decoded["ujx1bf_pages"])
        model_map.update(decoded["model_map"])
    elif isinstance(raw_frames_or_roots, dict) and "ujx1bf_pages" in raw_frames_or_roots:
        pages.extend(raw_frames_or_roots["ujx1bf_pages"])
        model_map.update(raw_frames_or_roots.get("model_map") or {})
    elif isinstance(raw_frames_or_roots, list):
        # Could be a single `root` (`[[cursor, turns, ...]]`) OR a list of raw texts / decoded dicts / roots.
        if (
            raw_frames_or_roots
            and isinstance(raw_frames_or_roots[0], list)
            and len(raw_frames_or_roots[0]) > 0
            and (
                len(raw_frames_or_roots) == 1
                or (
                    len(raw_frames_or_roots[0]) >= 2
                    and (raw_frames_or_roots[0][0] is None or isinstance(raw_frames_or_roots[0][0], str))
                    and isinstance(raw_frames_or_roots[0][1], list)
                )
            )
            and not isinstance(raw_frames_or_roots[0][0], list)
        ):
            pages.append(_parse_ujx1bf_root(raw_frames_or_roots))
        else:
            for item in raw_frames_or_roots:
                if isinstance(item, str):
                    decoded = decode_batchexecute_frames(item)
                    pages.extend(decoded["ujx1bf_pages"])
                    model_map.update(decoded["model_map"])
                elif isinstance(item, dict) and "ujx1bf_pages" in item:
                    pages.extend(item["ujx1bf_pages"])
                    model_map.update(item.get("model_map") or {})
                elif isinstance(item, list):
                    pages.append(_parse_ujx1bf_root(item))
                else:
                    raise GeminiDecodeError(
                        "unsupported_page_item",
                        f"Unsupported item type in raw_frames_or_roots: {type(item).__name__}",
                    )
    else:
        raise GeminiDecodeError(
            "unsupported_input",
            "raw_frames_or_roots must be raw text, decoded frames dict, or list of pages/roots",
        )

    if not pages:
        raise GeminiDecodeError("missing_ujx1bf", "No ujx1Bf payloads were found")

    title: str | None = None
    share_id: str | None = share_id_from_url
    published_timestamp: str | None = None
    header_conv_id: str | None = None

    seen_cursors: set[str] = set()
    seen_turn_keys: set[tuple[str, str]] = set()
    turns: list[dict[str, Any]] = []
    last_cursor: str | None = None
    cursor_cycle_detected = False

    for page_idx, page in enumerate(pages):
        if page_idx >= MAX_PAGINATION_PAGES:
            break
        if title is None and page.get("title"):
            title = _clean_text(page["title"], redact, "title", redacted_fields)
        if share_id is None and page.get("share_id"):
            share_id = page["share_id"]
        if published_timestamp is None and page.get("published_timestamp"):
            published_timestamp = page["published_timestamp"]
        if header_conv_id is None and page.get("header_conversation_id"):
            header_conv_id = page["header_conversation_id"]

        for raw_turn in page.get("turns") or []:
            next_idx = len(turns)
            parsed_turn = _extract_turn(
                raw_turn,
                next_idx,
                header_conv_id,
                model_map,
                redact,
                redacted_fields,
            )
            dedup_key = (
                parsed_turn.get("turn_id") or f"idx:{next_idx}",
                parsed_turn.get("response_id") or "",
            )
            if dedup_key in seen_turn_keys and parsed_turn.get("turn_id"):
                continue
            seen_turn_keys.add(dedup_key)
            turns.append(parsed_turn)

        last_cursor = page.get("cursor")
        if last_cursor:
            if last_cursor in seen_cursors:
                cursor_cycle_detected = True
                break
            seen_cursors.add(last_cursor)

    cursor_exhausted = (last_cursor is None) and (not cursor_cycle_detected)
    summary = _compute_summary(turns, cursor_exhausted)

    clean_model_map: dict[str, str] = {}
    for mk, mv in model_map.items():
        clean_model_map[mk] = _clean_text(mv, redact, f"model_map.{mk}", redacted_fields)

    return {
        "schema_version": SCHEMA_VERSION,
        "source_url": sanitized_source_url or "",
        "share_id": share_id,
        "title": title or "",
        "published_timestamp": published_timestamp,
        "cursor_exhausted": cursor_exhausted,
        "next_cursor": last_cursor,
        "pages_processed": len(pages),
        "model_map": clean_model_map,
        "turns": turns,
        "summary": summary,
        "redaction_applied": bool(redact),
        "redacted_fields": list(dict.fromkeys(redacted_fields)),
    }


def verify_completeness(transcript: dict[str, Any]) -> dict[str, Any]:
    """Verifies transcript completeness: `cursor_exhausted`, `0` empty turns, and exact counts."""
    if not isinstance(transcript, dict):
        raise GeminiDecodeError("invalid_transcript", "Transcript must be a dict")

    issues: list[str] = []
    schema_version = transcript.get("schema_version")
    if schema_version != SCHEMA_VERSION:
        issues.append(f"unexpected_schema_version:{schema_version}")

    turns = transcript.get("turns")
    if not isinstance(turns, list):
        raise GeminiDecodeError("invalid_transcript", "Transcript 'turns' must be a list")

    cursor_exhausted = bool(transcript.get("cursor_exhausted", False)) and not transcript.get("next_cursor")
    counts = _compute_summary(turns, cursor_exhausted)

    if not cursor_exhausted:
        issues.append("cursor_not_exhausted")
    if counts["turns_total"] == 0:
        issues.append("zero_turns")
    if counts["empty_turns_total"] > 0:
        issues.append(f"empty_turns_detected:{counts['empty_turns_total']}")

    existing_summary = transcript.get("summary")
    if isinstance(existing_summary, dict):
        for key in (
            "turns_total",
            "turns_with_thinking",
            "thinking_steps_total",
            "turns_with_sources",
            "unique_sources_total",
            "search_queries_total",
            "attachments_total",
        ):
            if key in existing_summary and existing_summary[key] != counts[key]:
                issues.append(f"summary_mismatch:{key}:{existing_summary[key]}!={counts[key]}")

    return {
        "passed": len(issues) == 0,
        "issues": issues,
        "schema_version": schema_version,
        **counts,
    }


def _extract_embedded_wiz_values(html_text: str) -> dict[str, str]:
    values: dict[str, str] = {}
    for key in ("FdrFJe", "cfb2h", "SNlM0e"):
        m = re.search(rf'"{key}"\s*:\s*"([^"]+)"', html_text)
        if m:
            values[key] = m.group(1)
    return values


def _extract_embedded_ujx1bf_from_html(html_text: str) -> list[Any]:
    roots: list[Any] = []
    # Check AF_initDataCallback({..., data:...}) blocks in HTML if present.
    pattern = re.compile(r"AF_initDataCallback\(\{[^}]*?data:(\[[\s\S]*?\])\s*(?:,\s*sideChannel|\}\))")
    for m in pattern.finditer(html_text):
        snippet = m.group(1)
        try:
            parsed = json.loads(snippet)
            if (
                isinstance(parsed, list)
                and parsed
                and isinstance(parsed[0], list)
                and len(parsed[0]) >= 2
                and isinstance(parsed[0][1], list)
            ):
                roots.append(parsed)
        except json.JSONDecodeError:
            continue
    return roots


def fetch_share_http(
    share_url: str,
    *,
    redact: bool = True,
    max_pages: int = 32,
    timeout_seconds: float = 30.0,
    transport: Callable[[str, bytes | None, dict[str, str], float], tuple[int, str, str]] | None = None,
) -> dict[str, Any]:
    """Fetches a public Gemini share URL via HTTP and paginates `ujx1Bf` cursors without bypassing gates.

    `transport(url, data, headers, timeout)` can be injected in tests and must return
    `(status_code, final_url, response_text)`.
    """
    checked = require_valid_share_url(share_url)
    assert checked.normalized_url is not None and checked.share_id is not None

    def _default_transport(
        req_url: str,
        data: bytes | None,
        headers: dict[str, str],
        timeout: float,
    ) -> tuple[int, str, str]:
        req = urllib.request.Request(req_url, data=data, headers=headers, method="POST" if data is not None else "GET")
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw_bytes = resp.read()
                charset = resp.headers.get_content_charset() or "utf-8"
                return resp.getcode(), resp.geturl(), raw_bytes.decode(charset, errors="replace")
        except urllib.error.HTTPError as err:
            body = err.read().decode("utf-8", errors="replace") if err.fp else ""
            return err.code, err.geturl() or req_url, body

    call_transport = transport or _default_transport
    base_headers = {
        "User-Agent": "OmniaGeminiExtractor/1.0 (+https://gemini.google.com)",
        "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
    }

    status, final_url, html_body = call_transport(checked.normalized_url, None, base_headers, timeout_seconds)
    # Re-validate post-redirect final URL so auth/CAPTCHA redirects are refused immediately.
    require_valid_share_url(final_url)
    gate = _detect_html_gate(html_body)
    if gate is not None:
        raise GeminiBlockedError(gate, f"Remote page returned {gate} gate")
    if status == 429:
        raise GeminiBlockedError("captcha_blocked", "HTTP 429 rate/CAPTCHA block encountered")
    if status in (401, 403):
        raise GeminiBlockedError("auth_required", f"HTTP {status} authentication required")
    if status >= 400:
        raise GeminiDecodeError("http_error", f"HTTP fetch returned status {status}")

    wiz = _extract_embedded_wiz_values(html_body)
    pages_collected: list[Any] = []
    model_map: dict[str, str] = {}

    embedded_roots = _extract_embedded_ujx1bf_from_html(html_body)
    if embedded_roots:
        for r in embedded_roots:
            pages_collected.append(_parse_ujx1bf_root(r))

    cursor: str | None = pages_collected[-1]["cursor"] if pages_collected else None
    seen_cursors: set[str] = set()
    page_num = 0

    # If no embedded root was found, do initial RPC page fetch with cursor=None; else continue pagination loop.
    need_initial_rpc = len(pages_collected) == 0
    while (need_initial_rpc or cursor is not None) and page_num < min(max_pages, MAX_PAGINATION_PAGES):
        need_initial_rpc = False
        if cursor is not None:
            if cursor in seen_cursors:
                break
            seen_cursors.add(cursor)

        rpc_args = [checked.share_id, cursor]
        freq = json.dumps([[["ujx1Bf", json.dumps(rpc_args), None, "generic"]]], separators=(",", ":"))
        form_map: dict[str, str] = {"f.req": freq}
        if "SNlM0e" in wiz:
            form_map["at"] = wiz["SNlM0e"]
        encoded_form = urllib.parse.urlencode(form_map).encode("utf-8")

        query_params = {"rpcids": "ujx1Bf", "source-path": f"/share/{checked.share_id}"}
        if "FdrFJe" in wiz:
            query_params["f.sid"] = wiz["FdrFJe"]
        if "cfb2h" in wiz:
            query_params["bl"] = wiz["cfb2h"]
        rpc_url = "https://gemini.google.com/_/BardChatUi/data/batchexecute?" + urllib.parse.urlencode(
            query_params
        )

        rpc_headers = {
            "User-Agent": base_headers["User-Agent"],
            "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        }
        rpc_status, rpc_final_url, rpc_body = call_transport(
            rpc_url, encoded_form, rpc_headers, timeout_seconds
        )
        # Check redirect target against gate patterns (only reject auth/CAPTCHA, batchexecute host is allowed).
        rpc_check = validate_share_url(rpc_final_url)
        if rpc_check.reason in {"auth_required", "captcha_blocked"}:
            raise GeminiBlockedError(rpc_check.reason, rpc_check.detail)
        if rpc_status == 429:
            raise GeminiBlockedError("captcha_blocked", "HTTP 429 on batchexecute RPC")
        if rpc_status in (401, 403):
            raise GeminiBlockedError("auth_required", f"HTTP {rpc_status} on batchexecute RPC")
        if rpc_status >= 400:
            raise GeminiDecodeError("rpc_http_error", f"batchexecute returned HTTP {rpc_status}")

        decoded = decode_batchexecute_frames(rpc_body)
        model_map.update(decoded["model_map"])
        if not decoded["ujx1bf_pages"]:
            break
        pages_collected.extend(decoded["ujx1bf_pages"])
        cursor = decoded["ujx1bf_pages"][-1]["cursor"]
        page_num += 1

    return extract_share_transcript(
        {"ujx1bf_pages": pages_collected, "model_map": model_map},
        source_url=checked.normalized_url,
        redact=redact,
    )


def export_transcript_markdown(
    transcript: dict[str, Any],
    *,
    include_thinking: bool = True,
    include_sources: bool = True,
) -> str:
    """Renders an extracted `omnia.gemini-share-transcript.v1` dict to clean UTF-8 LF Markdown."""
    if not isinstance(transcript, dict):
        raise GeminiDecodeError("invalid_transcript", "Transcript must be a dict")

    title = (transcript.get("title") or "").strip() or "Gemini Shared Conversation"
    lines: list[str] = [f"# {html_lib.unescape(title)}", ""]
    if transcript.get("source_url"):
        lines.append(f"- **Source URL:** {transcript['source_url']}")
    if transcript.get("share_id"):
        lines.append(f"- **Share ID:** `{transcript['share_id']}`")
    if transcript.get("published_timestamp"):
        lines.append(f"- **Published:** `{transcript['published_timestamp']}`")
    lines.append(f"- **Cursor Exhausted:** `{transcript.get('cursor_exhausted', False)}`")
    lines.append("")

    for turn in transcript.get("turns") or []:
        t_idx = turn.get("turn_index", 0)
        lines.append(f"## Turn {t_idx + 1}")
        lines.append("")
        if turn.get("model_id"):
            label = turn.get("model_name") or turn["model_id"]
            lines.append(f"*Model:* `{label}`")
            lines.append("")

        lines.append("### Prompt")
        lines.append("")
        lines.append(turn.get("prompt_text") or "")
        lines.append("")

        attachments = turn.get("attachments") or []
        if attachments:
            lines.append("### Attachments")
            lines.append("")
            for att in attachments:
                kind = att.get("kind", "attachment")
                name = att.get("name", "unnamed")
                mime = att.get("mime_type") or "unknown"
                url = att.get("url")
                line = f"- `{kind}`: **{name}** (`{mime}`)"
                if url:
                    line += f" — {url}"
                lines.append(line)
                if att.get("text"):
                    lines.append("")
                    lines.append("```text")
                    lines.append(att["text"])
                    lines.append("```")
            lines.append("")

        queries = turn.get("search_queries") or []
        if queries:
            lines.append("### Search Queries")
            lines.append("")
            for q in queries:
                lines.append(f"- {q}")
            lines.append("")

        if include_thinking and (turn.get("thinking_steps") or []):
            lines.append("### Thinking Steps")
            lines.append("")
            for step in turn["thinking_steps"]:
                header = step.get("header") or step.get("action") or "Step"
                provider = f" ({step['provider']})" if step.get("provider") else ""
                lines.append(f"#### {header}{provider}")
                lines.append("")
                if step.get("body"):
                    lines.append(step["body"])
                    lines.append("")
                if include_sources and (step.get("sources") or []):
                    lines.append("Sources:")
                    for src in step["sources"]:
                        stitle = src.get("title") or src.get("url") or "source"
                        surl = src.get("url") or ""
                        lines.append(f"- [{stitle}]({surl})" if surl else f"- {stitle}")
                    lines.append("")

        lines.append("### Response")
        lines.append("")
        lines.append(turn.get("response_markdown") or "")
        lines.append("")

        citations = turn.get("grounding_citations") or []
        if include_sources and citations:
            lines.append("### Grounding Citations")
            lines.append("")
            for cite in citations:
                for item in cite.get("items") or []:
                    ctitle = item.get("title") or item.get("url") or "citation"
                    curl = item.get("url") or ""
                    pub = f" — *{item['publisher']}*" if item.get("publisher") else ""
                    lines.append(f"- [{ctitle}]({curl}){pub}" if curl else f"- {ctitle}{pub}")
            lines.append("")

    summary = transcript.get("summary") or {}
    if summary:
        lines.append("## Summary")
        lines.append("")
        for k, v in summary.items():
            lines.append(f"- `{k}`: `{v}`")
        lines.append("")

    return "\n".join(lines).rstrip() + "\n"
