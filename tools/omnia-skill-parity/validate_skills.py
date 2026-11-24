#!/usr/bin/env python3
"""Zero-dependency Python 3 stdlib skill parity, registration, and UTF-8 LF hygiene validator."""

from __future__ import annotations

import sys

sys.dont_write_bytecode = True

import argparse
import hashlib
import json
import os
import re
import stat
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

MAX_SKILL_NAME_LENGTH = 64
MAX_DESCRIPTION_LENGTH = 1024
MIN_SHORT_DESCRIPTION_LENGTH = 25
MAX_SHORT_DESCRIPTION_LENGTH = 64
FILE_ATTRIBUTE_REPARSE_POINT = 0x400

VALID_NAME_RE = re.compile(r"^[a-z0-9-]+$")
NON_ASCII_RUN_RE = re.compile(r"[^\x00-\x7f]{2,}")
# CP1252 0x80..0x9F mapped Unicode characters (which appear when UTF-8 continuation bytes 0x80..0x9F are decoded as CP1252)
CP1252_HIGH_CHARS = (
    "\u20ac\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u017d"
    "\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u017e\u0178"
)
LONE_C2_C3_SUSPECT_RE = re.compile(
    "(?<![A-Za-z\u00c0-\u1ef9])[\u00c2\u00c3](?=[\\s\x80-\x9f]|$)|[a-z][\u00c2\u00c3][a-z]"
)

# Raw byte-level markers for common UTF-8 double-encoding and replacement errors.
RAW_MOJIBAKE_BYTES: tuple[tuple[str, bytes], ...] = (
    ("double_utf8_punct", b"\xc3\xa2\xe2\x82\xac"),
    ("replacement_char", b"\xef\xbf\xbd"),
)

# Double-encoded UTF-8 turns 2-byte UTF-8 (C2..DF 80..BF) or 3-byte UTF-8 (E0..EF 80..BF 80..BF)
# into lead characters (â, Â, Ã, Ä, Æ, á) followed by Latin-1/CP1252 continuation glyphs.
_CONT_CLASS = "[\u0080-\u00bf" + re.escape(CP1252_HIGH_CHARS) + "]"
DOUBLE_UTF8_PREFIX_RE = re.compile(
    "(?:"
    + "\u00e2[" + re.escape(CP1252_HIGH_CHARS) + "]"
    + "|[\u00c2\u00c3]" + _CONT_CLASS
    + "|\u00c4" + _CONT_CLASS
    + "|\u00c6" + _CONT_CLASS
    + "|\u00e1[\u00ba\u00bb]" + _CONT_CLASS
    + ")"
)

DEFAULT_WORKSPACE_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CODEX_SKILLS = Path.home() / ".codex" / "skills"
DEFAULT_USER_AGENTS_SKILLS = Path.home() / ".agents" / "skills"
DEFAULT_GLOBAL_SKILLS_JSON = Path.home() / ".gemini" / "config" / "skills.json"


def is_reparse_point(path: Path) -> bool:
    """Return True if path is a symlink or Windows junction/reparse point."""
    try:
        if path.is_symlink():
            return True
        st = os.lstat(path)
        attrs = getattr(st, "st_file_attributes", 0)
        if attrs & FILE_ATTRIBUTE_REPARSE_POINT:
            return True
        return stat.S_ISLNK(st.st_mode)
    except OSError:
        return False


def find_disallowed_control_bytes(data: bytes) -> list[str]:
    """Return sorted hex labels for disallowed ASCII control bytes."""
    found: set[int] = set()
    for byte in data:
        if (byte < 0x20 and byte not in (0x09, 0x0A, 0x0D)) or byte == 0x7F:
            found.add(byte)
    return [f"0x{b:02x}" for b in sorted(found)]


def _try_recover_double_utf8(segment: str) -> tuple[str, str] | None:
    """Attempt CP1252 or Latin-1 round-trip recovery on a suspicious non-ASCII run."""
    for encoding in ("cp1252", "latin1"):
        try:
            raw_bytes = segment.encode(encoding)
            decoded = raw_bytes.decode("utf-8")
        except (UnicodeEncodeError, UnicodeDecodeError):
            continue
        if decoded != segment:
            return encoding, decoded
    return None


def detect_mojibake(raw: bytes, text: str | None) -> list[dict[str, Any]]:
    """Detect byte-level and line-level UTF-8 mojibake patterns without false-firing on clean UTF-8."""
    findings: list[dict[str, Any]] = []
    seen_keys: set[tuple[int, int, str]] = set()

    def add_finding(line: int, column: int, pattern: str, excerpt: str, recovered: str | None = None) -> None:
        key = (line, column, pattern)
        if key in seen_keys:
            return
        seen_keys.add(key)
        entry: dict[str, Any] = {
            "line": line,
            "column": column,
            "pattern": pattern,
            "excerpt": excerpt[:160],
        }
        if recovered is not None:
            entry["recovered_preview"] = recovered[:120]
        findings.append(entry)

    # Raw byte offset checks work even if file has mixed/invalid UTF-8.
    for pat_name, pat_bytes in RAW_MOJIBAKE_BYTES:
        start = 0
        while True:
            idx = raw.find(pat_bytes, start)
            if idx == -1:
                break
            line_no = raw[:idx].count(b"\n") + 1
            line_start = raw.rfind(b"\n", 0, idx) + 1
            line_end = raw.find(b"\n", idx)
            if line_end == -1:
                line_end = len(raw)
            col = len(raw[line_start:idx].decode("utf-8", errors="replace")) + 1
            excerpt = raw[line_start:line_end].decode("utf-8", errors="replace").strip()
            add_finding(line_no, col, pat_name, excerpt)
            start = idx + len(pat_bytes)

    if text is None:
        return findings

    for line_no, line in enumerate(text.splitlines(), 1):
        if "\ufffd" in line:
            col = line.index("\ufffd") + 1
            add_finding(line_no, col, "replacement_char", line.strip())

        for match in NON_ASCII_RUN_RE.finditer(line):
            seg = match.group(0)
            recovered = _try_recover_double_utf8(seg)
            if recovered is not None:
                enc, decoded = recovered
                add_finding(
                    line_no,
                    match.start() + 1,
                    f"double_utf8_{enc}",
                    line.strip(),
                    decoded,
                )

        for match in DOUBLE_UTF8_PREFIX_RE.finditer(line):
            add_finding(line_no, match.start() + 1, "double_utf8_prefix", line.strip())

        for match in LONE_C2_C3_SUSPECT_RE.finditer(line):
            add_finding(line_no, match.start() + 1, "lone_c2_c3_marker", line.strip())

    return findings


def inspect_bytes_hygiene(path: Path) -> dict[str, Any]:
    """Inspect a file's raw bytes for UTF-8 validity, BOM, EOL, control chars, and mojibake."""
    raw = path.read_bytes()
    crlf_lines = raw.count(b"\r\n")
    total_lf = raw.count(b"\n")
    lf_only_lines = total_lf - crlf_lines
    stray_cr = raw.count(b"\r") - crlf_lines
    has_bom = raw.startswith(b"\xef\xbb\xbf")
    control_bytes = find_disallowed_control_bytes(raw)
    sha256 = hashlib.sha256(raw).hexdigest()

    utf8_valid = True
    utf8_error: str | None = None
    text: str | None = None
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        utf8_valid = False
        utf8_error = str(exc)

    mojibake = detect_mojibake(raw, text)
    em_dash_count = raw.count(b"\xe2\x80\x94")
    en_dash_count = raw.count(b"\xe2\x80\x93")
    non_ascii_lines = 0
    if text is not None:
        non_ascii_lines = sum(1 for ln in text.splitlines() if any(ord(ch) > 127 for ch in ln))

    clean = (
        utf8_valid
        and not has_bom
        and crlf_lines == 0
        and stray_cr == 0
        and len(control_bytes) == 0
        and len(mojibake) == 0
    )

    return {
        "path": str(path),
        "size_bytes": len(raw),
        "sha256": sha256,
        "utf8_valid": utf8_valid,
        "utf8_error": utf8_error,
        "has_bom": has_bom,
        "crlf_lines": crlf_lines,
        "lf_only_lines": lf_only_lines,
        "stray_cr_count": stray_cr,
        "mixed_eol": crlf_lines > 0 and lf_only_lines > 0,
        "control_bytes": control_bytes,
        "mojibake_count": len(mojibake),
        "mojibake_findings": mojibake,
        "em_dash_utf8_count": em_dash_count,
        "en_dash_utf8_count": en_dash_count,
        "non_ascii_lines": non_ascii_lines,
        "clean": clean,
    }


def _unquote_yaml_scalar(raw_val: str) -> tuple[str, bool]:
    """Unquote a YAML scalar string and report whether it was explicitly quoted."""
    val = raw_val.strip()
    if len(val) >= 2 and val[0] == '"' and val[-1] == '"':
        inner = val[1:-1]
        inner = (
            inner.replace('\\"', '"')
            .replace("\\\\", "\\")
            .replace("\\n", "\n")
            .replace("\\t", "\t")
        )
        return inner, True
    if len(val) >= 2 and val[0] == "'" and val[-1] == "'":
        return val[1:-1].replace("''", "'"), True
    return val, False


def parse_yaml_frontmatter(text: str) -> tuple[dict[str, str] | None, str, str | None]:
    """Extract top-level scalar fields from SKILL.md YAML frontmatter without external dependencies."""
    norm = text.lstrip("\ufeff").replace("\r\n", "\n")
    lines = norm.split("\n")
    if not lines or lines[0].strip() != "---":
        return None, norm, "missing opening YAML frontmatter delimiter '---'"

    closing_idx: int | None = None
    for idx in range(1, len(lines)):
        if lines[idx].strip() == "---":
            closing_idx = idx
            break
    if closing_idx is None:
        return None, norm, "missing closing YAML frontmatter delimiter '---'"

    fm_lines = lines[1:closing_idx]
    body = "\n".join(lines[closing_idx + 1 :])
    top_fields: dict[str, str] = {}

    i = 0
    while i < len(fm_lines):
        line = fm_lines[i]
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            i += 1
            continue
        # Ignore indented nested keys (for example metadata.openclaw.envVars[].name)
        if line[0] in (" ", "\t") or line.lstrip().startswith("-"):
            i += 1
            continue
        if ":" not in line:
            return None, body, f"malformed top-level frontmatter line: {line!r}"
        key, rest = line.split(":", 1)
        key = key.strip()
        rest_stripped = rest.strip()
        if rest_stripped in ("|", "|-", ">", ">-"):
            block: list[str] = []
            j = i + 1
            while j < len(fm_lines):
                nxt = fm_lines[j]
                if not nxt.strip():
                    block.append("")
                    j += 1
                    continue
                if nxt[0] in (" ", "\t"):
                    block.append(nxt.strip())
                    j += 1
                    continue
                break
            joiner = "\n" if rest_stripped.startswith("|") else " "
            top_fields[key] = joiner.join(part for part in block if part != "").strip()
            i = j
            continue
        if rest_stripped == "":
            # Nested mapping or list block (e.g. metadata:), skip collecting as top scalar
            top_fields.setdefault(key, "")
            i += 1
            continue
        # Inline value; collect any indented folded continuation lines if unquoted
        val, was_quoted = _unquote_yaml_scalar(rest_stripped)
        if not was_quoted:
            cont: list[str] = [val]
            j = i + 1
            while j < len(fm_lines):
                nxt = fm_lines[j]
                if nxt and nxt[0] in (" ", "\t") and not nxt.lstrip().startswith("-") and ":" not in nxt:
                    cont.append(nxt.strip())
                    j += 1
                    continue
                break
            top_fields[key] = " ".join(cont).strip()
            i = j
            continue
        top_fields[key] = val
        i += 1

    return top_fields, body, None


def _has_unclosed_todo_outside_fences(body: str) -> bool:
    """Return True if body contains an unresolved [TODO:...] line outside fenced code blocks."""
    fence_char: str | None = None
    fence_len = 0
    for line in body.splitlines():
        fence_match = re.match(r"^[ \t]*(?:(?:[-+*]|\d+[.)])[ \t]+)?(`{3,}|~{3,})(.*)$", line)
        if fence_match:
            marker = fence_match.group(1)
            if fence_char is None:
                fence_char = marker[0]
                fence_len = len(marker)
            elif marker[0] == fence_char and len(marker) >= fence_len and not fence_match.group(2).strip():
                fence_char = None
                fence_len = 0
            continue
        if fence_char is None and re.fullmatch(r"[ ]{0,3}\[TODO:[^\n]*\][ \t]*", line):
            return True
    return False


def parse_openai_yaml(text: str) -> tuple[dict[str, dict[str, tuple[str, bool]]], list[str]]:
    """Parse agents/openai.yaml sections and return (sections_map, parse_errors)."""
    norm = text.lstrip("\ufeff").replace("\r\n", "\n")
    sections: dict[str, dict[str, tuple[str, bool]]] = {}
    errors: list[str] = []
    current_section: str | None = None
    section_indent: int | None = None

    for line_no, raw_line in enumerate(norm.splitlines(), 1):
        stripped = raw_line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        indent = len(raw_line) - len(raw_line.lstrip(" "))
        if "\t" in raw_line[:indent]:
            errors.append(f"line {line_no}: tabs are invalid in YAML indentation")
            continue
        if indent == 0:
            if not stripped.endswith(":"):
                errors.append(f"line {line_no}: expected top-level section '<name>:'")
                current_section = None
                continue
            sec_name = stripped[:-1].strip()
            if not sec_name:
                errors.append(f"line {line_no}: empty top-level section key")
                current_section = None
                continue
            current_section = sec_name
            section_indent = None
            sections.setdefault(sec_name, {})
            continue

        if current_section is None:
            errors.append(f"line {line_no}: indented content outside any top-level section")
            continue

        if current_section == "interface":
            if section_indent is None:
                section_indent = indent
            if indent != section_indent:
                errors.append(f"line {line_no}: inconsistent indentation under 'interface'")
                continue
            if ":" not in stripped:
                errors.append(f"line {line_no}: malformed interface entry {stripped!r}")
                continue
            key, raw_val = stripped.split(":", 1)
            key = key.strip()
            if not key or key.startswith('"') or key.startswith("'"):
                errors.append(f"line {line_no}: interface key {key!r} must be unquoted and non-empty")
                continue
            val, quoted = _unquote_yaml_scalar(raw_val)
            sections["interface"][key] = (val, quoted)

    return sections, errors


def validate_openai_yaml(skill_dir: Path, skill_name: str) -> dict[str, Any]:
    """Validate <skill_dir>/agents/openai.yaml structure, interface fields, and hygiene."""
    yaml_path = skill_dir / "agents" / "openai.yaml"
    errors: list[str] = []
    warnings: list[str] = []

    if not yaml_path.is_file():
        return {
            "exists": False,
            "path": str(yaml_path),
            "valid": False,
            "errors": [f"{skill_dir.name}: missing agents/openai.yaml"],
            "warnings": [],
            "interface": {},
            "hygiene": None,
        }

    hygiene = inspect_bytes_hygiene(yaml_path)
    if not hygiene["utf8_valid"]:
        errors.append(f"{skill_dir.name}: agents/openai.yaml invalid UTF-8 ({hygiene['utf8_error']})")
    if hygiene["has_bom"]:
        errors.append(f"{skill_dir.name}: agents/openai.yaml contains UTF-8 BOM")
    if hygiene["crlf_lines"] > 0 or hygiene["stray_cr_count"] > 0:
        errors.append(f"{skill_dir.name}: agents/openai.yaml contains CRLF/CR line endings")
    if hygiene["control_bytes"]:
        errors.append(
            f"{skill_dir.name}: agents/openai.yaml contains control bytes {hygiene['control_bytes']}"
        )
    if hygiene["mojibake_count"] > 0:
        errors.append(f"{skill_dir.name}: agents/openai.yaml contains UTF-8 mojibake")

    parsed_interface: dict[str, str] = {}
    if hygiene["utf8_valid"]:
        text = yaml_path.read_bytes().decode("utf-8")
        sections, parse_errs = parse_openai_yaml(text)
        for err in parse_errs:
            errors.append(f"{skill_dir.name}: agents/openai.yaml {err}")
        iface = sections.get("interface")
        if iface is None:
            errors.append(f"{skill_dir.name}: agents/openai.yaml missing 'interface:' section")
        else:
            for req_key in ("display_name", "short_description", "default_prompt"):
                if req_key not in iface:
                    errors.append(f"{skill_dir.name}: agents/openai.yaml missing interface.{req_key}")
                else:
                    val, quoted = iface[req_key]
                    parsed_interface[req_key] = val
                    if not val.strip():
                        errors.append(
                            f"{skill_dir.name}: agents/openai.yaml interface.{req_key} is empty"
                        )
                    if not quoted:
                        warnings.append(
                            f"{skill_dir.name}: agents/openai.yaml interface.{req_key} should be quoted"
                        )
            short_desc = parsed_interface.get("short_description", "")
            if short_desc and not (MIN_SHORT_DESCRIPTION_LENGTH <= len(short_desc) <= MAX_SHORT_DESCRIPTION_LENGTH):
                warnings.append(
                    f"{skill_dir.name}: interface.short_description length {len(short_desc)} "
                    f"outside {MIN_SHORT_DESCRIPTION_LENGTH}..{MAX_SHORT_DESCRIPTION_LENGTH} chars"
                )
            default_prompt = parsed_interface.get("default_prompt", "")
            token_re = re.compile(r"(?:^|\W)\$" + re.escape(skill_name) + r"(?=$|[^a-z0-9-])")
            if default_prompt and not token_re.search(default_prompt):
                errors.append(
                    f"{skill_dir.name}: interface.default_prompt must reference ${skill_name}"
                )
            for icon_key in ("icon_small", "icon_large"):
                if icon_key in iface:
                    rel = iface[icon_key][0]
                    parsed_interface[icon_key] = rel
                    try:
                        resolved_skill = skill_dir.resolve()
                        resolved_icon = (skill_dir / rel).resolve()
                        resolved_icon.relative_to(resolved_skill)
                        if not resolved_icon.is_file():
                            errors.append(
                                f"{skill_dir.name}: interface.{icon_key} target missing: {rel}"
                            )
                    except ValueError:
                        errors.append(
                            f"{skill_dir.name}: interface.{icon_key} escapes skill root: {rel}"
                        )

    return {
        "exists": True,
        "path": str(yaml_path),
        "valid": len(errors) == 0,
        "errors": errors,
        "warnings": warnings,
        "interface": parsed_interface,
        "hygiene": hygiene,
    }


def validate_skill_dir(skill_dir: Path, require_openai_yaml: bool = True) -> dict[str, Any]:
    """Validate one skill directory for SKILL.md frontmatter, hygiene, and agents/openai.yaml."""
    folder_name = skill_dir.name
    errors: list[str] = []
    warnings: list[str] = []

    skill_md = skill_dir / "SKILL.md"
    if not skill_md.is_file():
        return {
            "folder": folder_name,
            "path": str(skill_dir),
            "reparse_point": is_reparse_point(skill_dir),
            "frontmatter_name": None,
            "description_length": 0,
            "valid": False,
            "errors": [f"{folder_name}: missing SKILL.md"],
            "warnings": [],
            "skill_md_hygiene": None,
            "openai_yaml": validate_openai_yaml(skill_dir, folder_name) if require_openai_yaml else None,
        }

    hygiene = inspect_bytes_hygiene(skill_md)
    if not hygiene["utf8_valid"]:
        errors.append(f"{folder_name}: SKILL.md invalid UTF-8 ({hygiene['utf8_error']})")
    if hygiene["has_bom"]:
        errors.append(f"{folder_name}: SKILL.md contains UTF-8 BOM")
    if hygiene["crlf_lines"] > 0 or hygiene["stray_cr_count"] > 0:
        errors.append(
            f"{folder_name}: SKILL.md has {hygiene['crlf_lines']} CRLF and {hygiene['stray_cr_count']} stray CR"
        )
    if hygiene["control_bytes"]:
        errors.append(f"{folder_name}: SKILL.md contains control bytes {hygiene['control_bytes']}")
    if hygiene["mojibake_count"] > 0:
        errors.append(
            f"{folder_name}: SKILL.md contains {hygiene['mojibake_count']} UTF-8 mojibake finding(s)"
        )

    fm_name: str | None = None
    desc = ""
    if hygiene["utf8_valid"]:
        text = skill_md.read_bytes().decode("utf-8")
        fm, body, fm_err = parse_yaml_frontmatter(text)
        if fm_err is not None or fm is None:
            errors.append(f"{folder_name}: {fm_err}")
        else:
            fm_name = fm.get("name", "").strip()
            desc = fm.get("description", "").strip()
            if not fm_name:
                errors.append(f"{folder_name}: missing top-level 'name' in frontmatter")
            else:
                if not VALID_NAME_RE.match(fm_name) or fm_name.startswith("-") or fm_name.endswith("-") or "--" in fm_name:
                    errors.append(f"{folder_name}: invalid hyphen-case frontmatter name {fm_name!r}")
                if len(fm_name) > MAX_SKILL_NAME_LENGTH:
                    errors.append(
                        f"{folder_name}: frontmatter name length {len(fm_name)} > {MAX_SKILL_NAME_LENGTH}"
                    )
                if fm_name != folder_name:
                    errors.append(
                        f"{folder_name}: frontmatter name {fm_name!r} != folder name {folder_name!r}"
                    )

            if not desc:
                errors.append(f"{folder_name}: missing top-level 'description' in frontmatter")
            else:
                if desc.startswith("[TODO:"):
                    errors.append(f"{folder_name}: description has unresolved [TODO:...] placeholder")
                if len(desc) > MAX_DESCRIPTION_LENGTH:
                    errors.append(
                        f"{folder_name}: description length {len(desc)} > {MAX_DESCRIPTION_LENGTH}"
                    )
                if "<" in desc or ">" in desc:
                    errors.append(f"{folder_name}: description contains angle brackets (< or >)")

            if _has_unclosed_todo_outside_fences(body):
                errors.append(f"{folder_name}: body contains unresolved [TODO:...] placeholder")

    # Scan non-SKILL.md files inside the skill directory for UTF-8 / CRLF / mojibake hygiene.
    non_skill_hygiene_issues: list[str] = []
    for subfile in sorted(skill_dir.rglob("*")):
        if not subfile.is_file() or "__pycache__" in subfile.parts or subfile.suffix == ".pyc":
            continue
        if subfile == skill_md or subfile == (skill_dir / "agents" / "openai.yaml"):
            continue
        if subfile.suffix.lower() in {".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".woff2"}:
            continue
        sub_h = inspect_bytes_hygiene(subfile)
        rel = str(subfile.relative_to(skill_dir)).replace("\\", "/")
        if not sub_h["utf8_valid"]:
            non_skill_hygiene_issues.append(f"{rel}: invalid UTF-8")
        if sub_h["crlf_lines"] > 0 or sub_h["stray_cr_count"] > 0:
            non_skill_hygiene_issues.append(f"{rel}: CRLF={sub_h['crlf_lines']}")
        if sub_h["mojibake_count"] > 0:
            non_skill_hygiene_issues.append(f"{rel}: mojibake={sub_h['mojibake_count']}")
    for issue in non_skill_hygiene_issues:
        errors.append(f"{folder_name}: {issue}")

    oy_res = validate_openai_yaml(skill_dir, folder_name) if require_openai_yaml else None
    if oy_res is not None:
        errors.extend(oy_res["errors"])
        warnings.extend(oy_res["warnings"])

    return {
        "folder": folder_name,
        "path": str(skill_dir),
        "reparse_point": is_reparse_point(skill_dir),
        "frontmatter_name": fm_name,
        "description_length": len(desc),
        "valid": len(errors) == 0,
        "errors": errors,
        "warnings": warnings,
        "skill_md_hygiene": hygiene,
        "openai_yaml": oy_res,
    }


def compute_skill_tree_sha256(skill_dir: Path) -> str:
    """Compute a deterministic SHA-256 over all files inside a skill directory."""
    h = hashlib.sha256()
    if not skill_dir.is_dir():
        return ""
    for f in sorted(skill_dir.rglob("*")):
        if not f.is_file() or "__pycache__" in f.parts or f.suffix == ".pyc":
            continue
        rel = f.relative_to(skill_dir).as_posix().encode("utf-8")
        file_digest = hashlib.sha256(f.read_bytes()).hexdigest().encode("ascii")
        h.update(rel + b"\0" + file_digest + b"\n")
    return h.hexdigest()


def validate_skills_json(
    skills_json_path: Path,
    workspace_root: Path | None = None,
    expected_skills_root: Path | None = None,
    require_drive_absolute: bool = False,
) -> dict[str, Any]:
    """Validate a workspace or global skills.json manifest."""
    errors: list[str] = []
    warnings: list[str] = []
    resolved_entries: list[dict[str, Any]] = []

    if not skills_json_path.is_file():
        return {
            "path": str(skills_json_path),
            "exists": False,
            "valid": False,
            "errors": [f"missing skills.json: {skills_json_path}"],
            "warnings": [],
            "entries": [],
        }

    hygiene = inspect_bytes_hygiene(skills_json_path)
    if not hygiene["clean"]:
        errors.append(f"skills.json hygiene failure: {skills_json_path}")

    try:
        payload = json.loads(skills_json_path.read_bytes().decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        errors.append(f"skills.json parse error: {exc}")
        return {
            "path": str(skills_json_path),
            "exists": True,
            "valid": False,
            "errors": errors,
            "warnings": warnings,
            "entries": [],
        }

    entries = payload.get("entries") if isinstance(payload, dict) else None
    if not isinstance(entries, list) or not entries:
        errors.append("skills.json must be a JSON object with a non-empty 'entries' array")
        return {
            "path": str(skills_json_path),
            "exists": True,
            "valid": False,
            "errors": errors,
            "warnings": warnings,
            "entries": [],
        }

    covers_expected = expected_skills_root is None
    expected_norm = os.path.normcase(str(expected_skills_root.resolve())) if expected_skills_root else None

    for idx, entry in enumerate(entries):
        if not isinstance(entry, dict) or not isinstance(entry.get("path"), str):
            errors.append(f"entries[{idx}] missing string 'path'")
            continue
        raw_path = entry["path"].strip()
        if not raw_path:
            errors.append(f"entries[{idx}] has empty 'path'")
            continue
        if raw_path.startswith("~") or "$HOME" in raw_path or "%USERPROFILE%" in raw_path:
            errors.append(f"entries[{idx}] uses unexpanded home token ({raw_path!r}); use explicit path")
        if require_drive_absolute and not re.match(r"^[A-Za-z]:/", raw_path):
            errors.append(
                f"entries[{idx}] path {raw_path!r} is not Windows drive-absolute forward-slash (C:/... or D:/...)"
            )

        candidate = Path(raw_path)
        if not candidate.is_absolute() and workspace_root is not None:
            candidate = workspace_root / candidate
        exists = candidate.is_dir()
        if not exists:
            errors.append(f"entries[{idx}] target directory does not exist: {candidate}")
        elif expected_norm is not None:
            if os.path.normcase(str(candidate.resolve())) == expected_norm:
                covers_expected = True

        excludes = entry.get("exclude", [])
        if excludes and not isinstance(excludes, list):
            errors.append(f"entries[{idx}].exclude must be a list of regex strings")
        elif isinstance(excludes, list):
            for pat in excludes:
                try:
                    re.compile(str(pat))
                except re.error as exc:
                    errors.append(f"entries[{idx}].exclude invalid regex {pat!r}: {exc}")

        resolved_entries.append(
            {
                "raw_path": raw_path,
                "resolved_path": str(candidate),
                "exists": exists,
                "exclude": excludes if isinstance(excludes, list) else [],
            }
        )

    if not covers_expected:
        errors.append(f"skills.json does not register expected skills root: {expected_skills_root}")

    return {
        "path": str(skills_json_path),
        "exists": True,
        "valid": len(errors) == 0,
        "errors": errors,
        "warnings": warnings,
        "entries": resolved_entries,
    }


def _scan_root_for_parity(root_path: Path) -> dict[str, Any]:
    """Scan one skill root directory for inventory, frontmatter names, CRLF, and openai.yaml presence."""
    if not root_path.is_dir():
        return {
            "path": str(root_path),
            "exists": False,
            "skill_count": 0,
            "skills": {},
            "duplicate_frontmatter_names": {},
            "crlf_skill_md_count": 0,
            "missing_openai_yaml_count": 0,
            "name_mismatch_count": 0,
        }

    skills: dict[str, dict[str, Any]] = {}
    name_to_folders: dict[str, list[str]] = {}
    crlf_count = 0
    missing_oy_count = 0
    mismatch_count = 0

    for entry in sorted(root_path.iterdir(), key=lambda p: p.name):
        if not entry.is_dir() or entry.name.startswith("."):
            continue
        sk = entry / "SKILL.md"
        if not sk.is_file():
            continue
        raw = sk.read_bytes()
        has_crlf = b"\r\n" in raw
        if has_crlf:
            crlf_count += 1
        oy = entry / "agents" / "openai.yaml"
        has_oy = oy.is_file()
        if not has_oy:
            missing_oy_count += 1
        fm_name: str | None = None
        try:
            text = raw.decode("utf-8")
            fm, _, _ = parse_yaml_frontmatter(text)
            if fm is not None:
                fm_name = fm.get("name", "").strip() or None
        except UnicodeDecodeError:
            fm_name = None
        if fm_name is not None:
            name_to_folders.setdefault(fm_name, []).append(entry.name)
            if fm_name != entry.name:
                mismatch_count += 1
        skills[entry.name] = {
            "reparse_point": is_reparse_point(entry),
            "frontmatter_name": fm_name,
            "skill_md_sha256": hashlib.sha256(raw).hexdigest(),
            "openai_yaml_sha256": hashlib.sha256(oy.read_bytes()).hexdigest() if has_oy else None,
            "has_crlf": has_crlf,
        }

    duplicates = {k: v for k, v in sorted(name_to_folders.items()) if len(v) > 1}
    return {
        "path": str(root_path),
        "exists": True,
        "skill_count": len(skills),
        "skills": skills,
        "duplicate_frontmatter_names": duplicates,
        "crlf_skill_md_count": crlf_count,
        "missing_openai_yaml_count": missing_oy_count,
        "name_mismatch_count": mismatch_count,
    }


def check_cross_host_parity(
    workspace_skills_root: Path,
    peer_roots: dict[str, Path],
) -> dict[str, Any]:
    """Compare workspace skills against peer host roots and detect drift, missing mirrors, and duplicates."""
    ws_scan = _scan_root_for_parity(workspace_skills_root)
    peer_scans = {label: _scan_root_for_parity(path) for label, path in peer_roots.items()}

    per_skill_parity: list[dict[str, Any]] = []
    drift_count = 0
    missing_mirror_count = 0
    prefixed_duplicate_twins: list[dict[str, Any]] = []

    for slug, ws_info in sorted(ws_scan["skills"].items()):
        peer_states: dict[str, dict[str, Any]] = {}
        all_synced = True
        for label, pscan in peer_scans.items():
            if not pscan["exists"]:
                peer_states[label] = {"status": "root_missing"}
                all_synced = False
                continue
            pinfo = pscan["skills"].get(slug)
            if pinfo is None:
                peer_states[label] = {"status": "missing_skill"}
                missing_mirror_count += 1
                all_synced = False
                continue
            sk_match = pinfo["skill_md_sha256"] == ws_info["skill_md_sha256"]
            oy_match = pinfo["openai_yaml_sha256"] == ws_info["openai_yaml_sha256"]
            if sk_match and oy_match:
                status = "in_sync"
            else:
                status = "drifted"
                drift_count += 1
                all_synced = False
            peer_states[label] = {
                "status": status,
                "reparse_point": pinfo["reparse_point"],
                "skill_md_match": sk_match,
                "openai_yaml_match": oy_match,
                "peer_openai_yaml_present": pinfo["openai_yaml_sha256"] is not None,
            }

        per_skill_parity.append(
            {
                "slug": slug,
                "workspace_skill_md_sha256": ws_info["skill_md_sha256"],
                "workspace_openai_yaml_sha256": ws_info["openai_yaml_sha256"],
                "all_peers_in_sync": all_synced,
                "peers": peer_states,
            }
        )

        # Detect unprefixed duplicate twins (for example kdense-citation-management vs citation-management)
        if slug.startswith("kdense-"):
            unprefixed = slug[len("kdense-") :]
            for label, pscan in peer_scans.items():
                twin = pscan["skills"].get(unprefixed)
                if twin is not None:
                    prefixed_duplicate_twins.append(
                        {
                            "prefixed_slug": slug,
                            "unprefixed_slug": unprefixed,
                            "peer_root": label,
                            "twin_frontmatter_name": twin["frontmatter_name"],
                            "workspace_frontmatter_name": ws_info["frontmatter_name"],
                            "frontmatter_name_collision": (
                                twin["frontmatter_name"] == ws_info["frontmatter_name"]
                                and twin["frontmatter_name"] is not None
                            ),
                            "twin_skill_md_sha256": twin["skill_md_sha256"],
                            "workspace_skill_md_sha256": ws_info["skill_md_sha256"],
                            "byte_identical_skill_md": (
                                twin["skill_md_sha256"] == ws_info["skill_md_sha256"]
                            ),
                        }
                    )

    root_summaries = {
        "workspace": {
            "path": ws_scan["path"],
            "exists": ws_scan["exists"],
            "skill_count": ws_scan["skill_count"],
            "duplicate_frontmatter_names": ws_scan["duplicate_frontmatter_names"],
            "crlf_skill_md_count": ws_scan["crlf_skill_md_count"],
            "missing_openai_yaml_count": ws_scan["missing_openai_yaml_count"],
            "name_mismatch_count": ws_scan["name_mismatch_count"],
        }
    }
    for label, pscan in peer_scans.items():
        root_summaries[label] = {
            "path": pscan["path"],
            "exists": pscan["exists"],
            "skill_count": pscan["skill_count"],
            "duplicate_frontmatter_names": pscan["duplicate_frontmatter_names"],
            "crlf_skill_md_count": pscan["crlf_skill_md_count"],
            "missing_openai_yaml_count": pscan["missing_openai_yaml_count"],
            "name_mismatch_count": pscan["name_mismatch_count"],
        }

    return {
        "root_summaries": root_summaries,
        "workspace_skills_parity": per_skill_parity,
        "drift_count": drift_count,
        "missing_mirror_count": missing_mirror_count,
        "prefixed_duplicate_twins": prefixed_duplicate_twins,
    }


def scan_docs_hygiene(docs_dir: Path) -> dict[str, Any]:
    """Scan Markdown files under docs_dir read-only for UTF-8, EOL, control bytes, and mojibake."""
    if not docs_dir.is_dir():
        return {
            "path": str(docs_dir),
            "exists": False,
            "files_scanned": 0,
            "clean": False,
            "files_with_issues": [],
            "total_em_dash_utf8": 0,
            "total_mojibake_findings": 0,
            "files": [],
        }

    files_report: list[dict[str, Any]] = []
    issue_files: list[str] = []
    total_em = 0
    total_moj = 0
    for md in sorted(docs_dir.glob("*.md")):
        rep = inspect_bytes_hygiene(md)
        files_report.append(rep)
        total_em += rep["em_dash_utf8_count"]
        total_moj += rep["mojibake_count"]
        if not rep["clean"]:
            issue_files.append(md.name)

    return {
        "path": str(docs_dir),
        "exists": True,
        "files_scanned": len(files_report),
        "clean": len(issue_files) == 0,
        "files_with_issues": issue_files,
        "total_em_dash_utf8": total_em,
        "total_mojibake_findings": total_moj,
        "files": files_report,
    }


def run_full_audit(
    workspace_root: Path,
    skills_root: Path | None = None,
    skills_json: Path | None = None,
    global_skills_json: Path | None = None,
    codex_skills: Path | None = None,
    user_agents_skills: Path | None = None,
    docs_dir: Path | None = None,
    staged_kdense_dir: Path | None = None,
    require_openai_yaml: bool = True,
) -> dict[str, Any]:
    """Run the complete skill parity, registration, staged verification, and docs hygiene audit."""
    resolved_skills_root = skills_root or (workspace_root / ".agents" / "skills")
    resolved_skills_json = skills_json or (workspace_root / ".agents" / "skills.json")

    projections_path = workspace_root / ".agents" / "kdense-projections.json"
    projection_names: set[str] = set()
    if projections_path.is_file():
        try:
            pdata = json.loads(projections_path.read_bytes().decode("utf-8"))
            for item in pdata.get("skills", []):
                if isinstance(item, dict) and isinstance(item.get("name"), str):
                    projection_names.add(item["name"])
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            pass

    skill_dirs = (
        [d for d in sorted(resolved_skills_root.iterdir(), key=lambda p: p.name) if d.is_dir() and not d.name.startswith(".")]
        if resolved_skills_root.is_dir()
        else []
    )
    skill_results: list[dict[str, Any]] = []
    curated_valid = 0
    curated_total = 0
    projected_valid = 0
    projected_total = 0

    for d in skill_dirs:
        res = validate_skill_dir(d, require_openai_yaml=require_openai_yaml)
        is_proj = d.name in projection_names or d.name.startswith("kdense-")
        res["admission_class"] = "research_projection_only" if is_proj else "curated_runtime"
        skill_results.append(res)
        if is_proj:
            projected_total += 1
            if res["valid"]:
                projected_valid += 1
        else:
            curated_total += 1
            if res["valid"]:
                curated_valid += 1

    ws_skills_json_res = validate_skills_json(
        resolved_skills_json,
        workspace_root=workspace_root,
        expected_skills_root=resolved_skills_root,
        require_drive_absolute=False,
    )

    global_skills_json_res: dict[str, Any] | None = None
    if global_skills_json is not None and global_skills_json.exists():
        global_skills_json_res = validate_skills_json(
            global_skills_json,
            workspace_root=None,
            expected_skills_root=resolved_skills_root,
            require_drive_absolute=(os.name == "nt"),
        )

    peer_roots: dict[str, Path] = {}
    if codex_skills is not None:
        peer_roots["codex"] = codex_skills
    if user_agents_skills is not None:
        peer_roots["user_agents"] = user_agents_skills

    cross_host = check_cross_host_parity(resolved_skills_root, peer_roots)

    staged_results: list[dict[str, Any]] = []
    if staged_kdense_dir is not None and staged_kdense_dir.is_dir():
        for sd in sorted(staged_kdense_dir.iterdir(), key=lambda p: p.name):
            if sd.is_dir() and not sd.name.startswith("."):
                staged_results.append(validate_skill_dir(sd, require_openai_yaml=require_openai_yaml))

    docs_res = scan_docs_hygiene(docs_dir) if docs_dir is not None else None

    return {
        "schema": "omnia.skill.parity.receipt.v1",
        "generated_at_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "workspace_root": str(workspace_root),
        "skills_root": str(resolved_skills_root),
        "summary": {
            "total_skills_checked": len(skill_results),
            "valid_skills": sum(1 for r in skill_results if r["valid"]),
            "invalid_skills": sum(1 for r in skill_results if not r["valid"]),
            "curated_runtime_total": curated_total,
            "curated_runtime_valid": curated_valid,
            "projected_total": projected_total,
            "projected_valid": projected_valid,
            "workspace_skills_json_valid": ws_skills_json_res["valid"],
            "global_skills_json_valid": global_skills_json_res["valid"] if global_skills_json_res else None,
            "staged_kdense_total": len(staged_results),
            "staged_kdense_valid": sum(1 for r in staged_results if r["valid"]),
            "docs_workspace_clean": docs_res["clean"] if docs_res else None,
            "docs_workspace_mojibake_count": docs_res["total_mojibake_findings"] if docs_res else None,
            "cross_host_drift_count": cross_host["drift_count"],
            "cross_host_missing_mirror_count": cross_host["missing_mirror_count"],
        },
        "skills": skill_results,
        "workspace_skills_json": ws_skills_json_res,
        "global_skills_json": global_skills_json_res,
        "cross_host_parity": cross_host,
        "staged_kdense_validation": staged_results,
        "docs_hygiene": docs_res,
    }


def format_markdown_report(receipt: dict[str, Any]) -> str:
    """Render a concise, evidence-grounded Markdown parity and hygiene report from a receipt."""
    summary = receipt["summary"]
    peers = [root for label, root in receipt["cross_host_parity"]["root_summaries"].items() if label != "workspace"]
    available = sum(root["exists"] for root in peers)
    lines: list[str] = [
        "# Omnia Skill Parity & UTF-8 Hygiene Report",
        "",
        f"- **Generated (UTC)**: `{receipt['generated_at_utc']}`",
        f"- **Skills Root**: `{receipt['skills_root']}`",
        f"- **Curated Runtime Skills Valid**: `{summary['curated_runtime_valid']}/{summary['curated_runtime_total']}`",
        f"- **Projected (`kdense-*`) Skills Valid in Repo**: `{summary['projected_valid']}/{summary['projected_total']}`",
        f"- **Staged Corrected `kdense-*` Skills Valid**: `{summary['staged_kdense_valid']}/{summary['staged_kdense_total']}`",
        f"- **Workspace `skills.json` Valid**: `{summary['workspace_skills_json_valid']}`",
        f"- **Global `skills.json` Valid**: `{summary['global_skills_json_valid']}`",
        f"- **Cross-Host Coverage**: {available}/{len(peers)} configured peer roots available",
        (f"- **Available Peer Roots Only**: {summary['cross_host_drift_count']} drift, {summary['cross_host_missing_mirror_count']} missing skills"
         if available else "- **Cross-Host Parity**: not measured (no peer root available)"),
        f"- **Workspace Docs Hygiene (`docs/workspace/*.md`)**: clean=`{summary['docs_workspace_clean']}`, mojibake_findings=`{summary['docs_workspace_mojibake_count']}`",
        "",
        f"## 1. Repository Skills Audit (`{receipt['skills_root']}`)",
        "",
        "| Skill Folder | Admission Class | Frontmatter `name` | `openai.yaml` | Status | Findings |",
        "|---|---|---|---|---|---|",
    ]

    for sk in receipt["skills"]:
        oy = sk.get("openai_yaml") or {}
        oy_state = "OK" if oy.get("valid") else ("MISSING" if not oy.get("exists") else "INVALID")
        status = "PASS" if sk["valid"] else "FAIL"
        findings = "; ".join(sk["errors"] + sk["warnings"]) if (sk["errors"] or sk["warnings"]) else "None"
        lines.append(
            f"| `{sk['folder']}` | `{sk['admission_class']}` | `{sk['frontmatter_name']}` | `{oy_state}` | **{status}** | {findings} |"
        )

    if receipt.get("staged_kdense_validation"):
        lines.extend(
            [
                "",
                "## 2. Staged Corrected `kdense-*` Validation",
                "",
                "| Staged Skill | Frontmatter `name` | `openai.yaml` | Status | Findings |",
                "|---|---|---|---|---|",
            ]
        )
        for st in receipt["staged_kdense_validation"]:
            oy = st.get("openai_yaml") or {}
            oy_state = "OK" if oy.get("valid") else "INVALID"
            status = "PASS" if st["valid"] else "FAIL"
            findings = "; ".join(st["errors"] + st["warnings"]) if (st["errors"] or st["warnings"]) else "None"
            lines.append(
                f"| `{st['folder']}` | `{st['frontmatter_name']}` | `{oy_state}` | **{status}** | {findings} |"
            )

    ch = receipt["cross_host_parity"]
    lines.extend(
        [
            "",
            "## 3. Cross-Host Parity & Duplicate Findings",
            "",
            "Top-level skill directories scanned per root (excluding dot-prefixed folders such as `.system`).",
            "",
        ]
    )
    lines.append("| Root | Exists | Skills | Duplicate `name:` | CRLF `SKILL.md` | Missing `openai.yaml` | `name != folder` |")
    lines.append("|---|---|---|---|---|---|---|")
    for rname, rs in ch["root_summaries"].items():
        dup_cnt = len(rs["duplicate_frontmatter_names"])
        lines.append(
            f"| `{rname}` (`{rs['path']}`) | `{rs['exists']}` | `{rs['skill_count']}` | `{dup_cnt}` | `{rs['crlf_skill_md_count']}` | `{rs['missing_openai_yaml_count']}` | `{rs['name_mismatch_count']}` |"
        )

    lines.extend(["", "### Intra-Root Duplicate Frontmatter `name:` Collisions", ""])
    any_intra = False
    for rname, rs in ch["root_summaries"].items():
        for fname, folders in rs["duplicate_frontmatter_names"].items():
            any_intra = True
            lines.append(f"- `{rname}`: frontmatter `name: {fname}` claimed by folders `{folders}`")
    if not any_intra:
        lines.append("- None detected.")

    lines.extend(["", "### Cross-Host Prefixed vs Unprefixed Twins (`kdense-*`)", ""])
    if ch["prefixed_duplicate_twins"]:
        for twin in ch["prefixed_duplicate_twins"]:
            lines.append(
                f"- `{twin['prefixed_slug']}` (workspace) vs `{twin['peer_root']}/{twin['unprefixed_slug']}`: "
                f"frontmatter_collision=`{twin['frontmatter_name_collision']}` (`{twin['twin_frontmatter_name']}`), "
                f"byte_identical_SKILL_md=`{twin['byte_identical_skill_md']}` "
                f"(ws=`{twin['workspace_skill_md_sha256'][:12]}`, peer=`{twin['twin_skill_md_sha256'][:12]}`)"
            )
    else:
        lines.append("- None detected.")

    lines.extend(["", "### Workspace-to-Peer Skill Parity Drift", ""])
    drift_rows = [row for row in ch["workspace_skills_parity"] if not row["all_peers_in_sync"]]
    if drift_rows:
        for row in drift_rows:
            peer_desc = ", ".join(
                f"{pname}={pdata['status']}(sk={pdata.get('skill_md_match')},oy={pdata.get('openai_yaml_match')})"
                for pname, pdata in row["peers"].items()
            )
            lines.append(f"- `{row['slug']}`: {peer_desc}")
    else:
        lines.append("- All workspace skills are byte-identical across peer roots.")

    docs = receipt.get("docs_hygiene")
    if docs is not None:
        lines.extend(
            [
                "",
                "## 4. Read-Only UTF-8 & Mojibake Inspection (`docs/workspace/*.md`)",
                "",
                f"- **Directory**: `{docs['path']}`",
                f"- **Markdown Files Scanned**: `{docs['files_scanned']}`",
                f"- **Clean Pure UTF-8 LF Files**: `{docs['files_scanned'] - len(docs['files_with_issues'])}/{docs['files_scanned']}`",
                f"- **Valid Single-Encoded Em-Dashes (`\\xe2\\x80\\x94`) Observed**: `{docs['total_em_dash_utf8']}`",
                f"- **Mojibake / Double-Encoded Findings**: `{docs['total_mojibake_findings']}`",
                "",
                "| File | Bytes | UTF-8 | BOM | CRLF | `\\xe2\\x80\\x94` Count | Non-ASCII Lines | Mojibake Findings |",
                "|---|---|---|---|---|---|---|---|",
            ]
        )
        for frep in docs["files"]:
            fname = Path(frep["path"]).name
            lines.append(
                f"| `{fname}` | `{frep['size_bytes']}` | `{frep['utf8_valid']}` | `{frep['has_bom']}` | "
                f"`{frep['crlf_lines']}` | `{frep['em_dash_utf8_count']}` | `{frep['non_ascii_lines']}` | `{frep['mojibake_count']}` |"
            )

    return "\n".join(lines) + "\n"


def _write_utf8_lf(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    normalized = content.replace("\r\n", "\n").replace("\r", "\n")
    path.write_bytes(normalized.encode("utf-8"))


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Validate Omnia skills, openai.yaml, skills.json, cross-host parity, and UTF-8 LF hygiene."
    )
    parser.add_argument("--workspace-root", type=Path, default=DEFAULT_WORKSPACE_ROOT)
    parser.add_argument("--skills-root", type=Path, default=None)
    parser.add_argument("--skills-json", type=Path, default=None)
    parser.add_argument("--global-skills-json", type=Path, default=DEFAULT_GLOBAL_SKILLS_JSON)
    parser.add_argument("--codex-skills", type=Path, default=DEFAULT_CODEX_SKILLS)
    parser.add_argument("--user-agents-skills", type=Path, default=DEFAULT_USER_AGENTS_SKILLS)
    parser.add_argument("--docs-dir", type=Path, default=None)
    parser.add_argument("--staged-kdense-dir", type=Path, default=None)
    parser.add_argument("--no-openai-yaml", action="store_true")
    parser.add_argument("--json-out", type=Path, default=None)
    parser.add_argument("--md-out", type=Path, default=None)
    parser.add_argument(
        "--strict",
        action="store_true",
        help="Exit 1 if any curated skill, skills.json, staged kdense skill, or docs_dir has errors.",
    )
    parser.add_argument(
        "--strict-all-skills",
        action="store_true",
        help="Exit 1 if any skill in skills_root (including research projections) fails validation.",
    )
    return parser


def _resolve_peer_profile_path(explicit: Path, default_path: Path, rel_parts: tuple[str, ...]) -> Path:
    """Resolve user profile skill roots across alternate Windows drive mounts (e.g. E:/Users/<user>)."""
    if explicit != default_path or explicit.exists():
        return explicit
    home_name = Path.home().name
    for drive in ("E", "D", "C"):
        candidate = Path(f"{drive}:/Users/{home_name}").joinpath(*rel_parts)
        if candidate.exists():
            return candidate
    return explicit


def main(argv: list[str] | None = None) -> int:
    parser = build_arg_parser()
    args = parser.parse_args(argv)
    docs_dir = args.docs_dir if args.docs_dir is not None else (args.workspace_root / "docs" / "workspace")
    global_skills_json = _resolve_peer_profile_path(
        args.global_skills_json, DEFAULT_GLOBAL_SKILLS_JSON, (".gemini", "config", "skills.json")
    )
    codex_skills = _resolve_peer_profile_path(
        args.codex_skills, DEFAULT_CODEX_SKILLS, (".codex", "skills")
    )
    user_agents_skills = _resolve_peer_profile_path(
        args.user_agents_skills, DEFAULT_USER_AGENTS_SKILLS, (".agents", "skills")
    )

    receipt = run_full_audit(
        workspace_root=args.workspace_root,
        skills_root=args.skills_root,
        skills_json=args.skills_json,
        global_skills_json=global_skills_json,
        codex_skills=codex_skills,
        user_agents_skills=user_agents_skills,
        docs_dir=docs_dir if docs_dir.is_dir() else None,
        staged_kdense_dir=args.staged_kdense_dir,
        require_openai_yaml=not args.no_openai_yaml,
    )

    if args.json_out is not None:
        _write_utf8_lf(args.json_out, json.dumps(receipt, indent=2, ensure_ascii=False) + "\n")
    if args.md_out is not None:
        _write_utf8_lf(args.md_out, format_markdown_report(receipt))

    print(json.dumps(receipt["summary"], indent=2, ensure_ascii=False))

    s = receipt["summary"]
    if args.strict_all_skills:
        global_ok = s["global_skills_json_valid"] in (True, None)
        peers_available = any(
            root["exists"]
            for label, root in receipt["cross_host_parity"]["root_summaries"].items()
            if label != "workspace"
        )
        parity_ok = (not peers_available) or (
            s["cross_host_drift_count"] == 0 and s["cross_host_missing_mirror_count"] == 0
        )
        ok = (
            s["invalid_skills"] == 0
            and bool(s["workspace_skills_json_valid"])
            and global_ok
            and parity_ok
            and (s["docs_workspace_clean"] in (True, None))
        )
        return 0 if ok else 1
    if args.strict:
        curated_ok = s["curated_runtime_valid"] == s["curated_runtime_total"]
        staged_ok = s["staged_kdense_valid"] == s["staged_kdense_total"]
        docs_ok = s["docs_workspace_clean"] in (True, None)
        global_ok = s["global_skills_json_valid"] in (True, None)
        return 0 if (curated_ok and staged_ok and bool(s["workspace_skills_json_valid"]) and global_ok and docs_ok) else 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
