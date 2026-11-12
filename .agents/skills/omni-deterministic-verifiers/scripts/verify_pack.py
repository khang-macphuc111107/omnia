#!/usr/bin/env python3
"""Zero-dependency Phase-3 deterministic verifier pack: preservation, WCAG contrast, secrets, tokens, and skill-doctor."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path

SECRET_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("AWS Access Key", re.compile(r"AKIA[0-9A-Z]{16}")),
    ("OpenAI / Standard sk- Key", re.compile(r"\bsk-[A-Za-z0-9_-]{20,}\b")),
    ("Google API Key", re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b")),
    ("GitHub PAT / Token", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{30,}\b")),
    ("Slack Token", re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b")),
    ("Private Key PEM", re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----")),
    ("Embedded Credential URL", re.compile(r"https?://[^/\s:@]+:[^/\s:@]+@[^/\s]+")),
]


def find_disallowed_control_bytes(data: bytes) -> list[str]:
    present: set[int] = set()
    for b in data:
        if (b < 0x20 and b not in (0x09, 0x0A, 0x0D)) or b == 0x7F:
            present.add(b)
    return [f"0x{b:02x}" for b in sorted(present)]


def inspect_one_file(p: Path) -> dict[str, object]:
    data = p.read_bytes()
    crlf_count = data.count(b"\r\n")
    lf_only_count = data.count(b"\n") - crlf_count
    bad_controls = find_disallowed_control_bytes(data)
    utf8_ok = True
    try:
        data.decode("utf-8")
    except UnicodeDecodeError:
        utf8_ok = False
    return {
        "path": str(p),
        "trailing_space_in_name": p.name.endswith(" ") or p.stem.endswith(" "),
        "size_bytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
        "utf8_valid": utf8_ok,
        "control_chars_found": bad_controls,
        "eol_profile": {
            "crlf_lines": crlf_count,
            "lf_only_lines": lf_only_count,
            "mixed_eol": crlf_count > 0 and lf_only_count > 0,
        },
    }


def cmd_preservation(target_str: str) -> dict[str, object]:
    target = Path(target_str)
    if target.is_file():
        info = inspect_one_file(target)
        info["verifier"] = "source-preservation"
        return info
    files = [f for f in sorted(target.rglob("*")) if f.is_file() and ".git" not in f.parts and "__pycache__" not in f.parts]
    reports = [inspect_one_file(f) for f in files]
    issues = [
        r["path"]
        for r in reports
        if not r["utf8_valid"]
        or r["control_chars_found"]
        or r["trailing_space_in_name"]
        or r["eol_profile"]["crlf_lines"] > 0  # type: ignore[index]
    ]
    return {
        "verifier": "source-preservation-tree",
        "root": str(target),
        "files_checked": len(reports),
        "clean_utf8_lf": len(issues) == 0,
        "files_with_issues": issues[:50],
    }


def hex_to_rel_luminance(hex_color: str) -> float:
    h = hex_color.strip().lstrip("#")
    if len(h) == 3:
        h = "".join(ch * 2 for ch in h)
    if len(h) != 6:
        raise ValueError(f"Expected 3- or 6-digit hex color, got {hex_color!r}")
    r, g, b = (int(h[i : i + 2], 16) / 255.0 for i in (0, 2, 4))

    def lin(c: float) -> float:
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)


def cmd_contrast(fg: str, bg: str) -> dict[str, object]:
    l1 = hex_to_rel_luminance(fg)
    l2 = hex_to_rel_luminance(bg)
    bright, dark = max(l1, l2), min(l1, l2)
    ratio = (bright + 0.05) / (dark + 0.05)
    return {
        "verifier": "ui-wcag-contrast",
        "foreground": fg,
        "background": bg,
        "contrast_ratio": round(ratio, 2),
        "wcag_aa_normal_text_4_5": ratio >= 4.5,
        "wcag_aa_large_ui_3_0": ratio >= 3.0,
        "wcag_aaa_normal_text_7_0": ratio >= 7.0,
    }


def cmd_secrets(target_str: str) -> dict[str, object]:
    target = Path(target_str)
    files = [target] if target.is_file() else [f for f in sorted(target.rglob("*")) if f.is_file() and ".git" not in f.parts]
    findings: list[dict[str, object]] = []
    scanned = 0
    for f in files:
        if f.stat().st_size > 8_000_000:
            continue
        scanned += 1
        content = f.read_text(encoding="utf-8", errors="ignore")
        for line_no, line in enumerate(content.splitlines(), 1):
            for label, pat in SECRET_PATTERNS:
                if pat.search(line):
                    findings.append({"file": str(f), "line": line_no, "rule": label})
    return {
        "verifier": "secret-redaction-scan",
        "files_scanned": scanned,
        "clean": len(findings) == 0,
        "findings_count": len(findings),
        "findings": findings[:40],
    }


def cmd_tokens(path_str: str, limit: int = 5000) -> dict[str, object]:
    p = Path(path_str)
    text = p.read_text(encoding="utf-8", errors="replace")
    est_tokens = max(1, len(text) // 4)
    return {
        "verifier": "token-budget-guard",
        "path": str(p),
        "char_length": len(text),
        "line_count": text.count("\n") + 1,
        "estimated_tokens": est_tokens,
        "safe_under_limit": est_tokens <= limit,
    }


def extract_fm_scalar(fm: str, key: str) -> str:
    lines = fm.splitlines()
    out: list[str] = []
    collecting = False
    for line in lines:
        if line.startswith(f"{key}:"):
            rest = line.split(":", 1)[1].strip()
            collecting = True
            if rest not in ("", ">", ">-", "|", "|-"):
                out.append(rest.strip("\"'"))
        elif collecting and (line.startswith(" ") or line.startswith("\t")):
            out.append(line.strip())
        else:
            collecting = False
    return " ".join(out).strip()


def audit_single_skill_dir(skill_dir: Path, allow_crlf: bool = False) -> tuple[list[str], bool]:
    errs: list[str] = []
    skill_md = skill_dir / "SKILL.md"
    if not skill_md.is_file():
        return [f"{skill_dir.name}: missing SKILL.md"], False
    raw = skill_md.read_bytes()
    has_crlf = b"\r\n" in raw
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        return [f"{skill_dir.name}: UTF-8 decode error ({exc})"], has_crlf
    for label in find_disallowed_control_bytes(raw):
        errs.append(f"{skill_dir.name}: SKILL.md contains control byte {label}")
    if has_crlf and not allow_crlf:
        errs.append(f"{skill_dir.name}: SKILL.md contains CRLF line endings")
    norm = text.lstrip("\ufeff").replace("\r\n", "\n")
    m = re.match(r"^---\n(.*?)\n---(?:\n|$)(.*)", norm, re.DOTALL)
    if not m:
        return errs + [f"{skill_dir.name}: malformed or missing YAML frontmatter"], has_crlf
    fm, body = m.group(1), m.group(2)
    name = extract_fm_scalar(fm, "name")
    desc = extract_fm_scalar(fm, "description")
    if not name or not desc:
        errs.append(f"{skill_dir.name}: missing name or description in frontmatter")
    elif name != skill_dir.name:
        errs.append(f"{skill_dir.name}: frontmatter name {name!r} != directory slug")
    if len(desc) > 1024:
        errs.append(f"{skill_dir.name}: description length {len(desc)} > 1024")
    if "<" in desc or ">" in desc:
        errs.append(f"{skill_dir.name}: description contains angle brackets (< or >)")
    if "[TODO:" in fm or re.search(r"^[ ]{0,3}\[TODO:[^\n]*\]", body, re.MULTILINE):
        errs.append(f"{skill_dir.name}: unfinished [TODO:...] placeholder")
    return errs, has_crlf


def cmd_skill_doctor(target_str: str, allow_crlf: bool = False) -> dict[str, object]:
    target = Path(target_str)
    if (target / "SKILL.md").is_file():
        dirs = [target]
    else:
        dirs = [d for d in sorted(target.iterdir(), key=lambda p: p.name) if d.is_dir() and not d.name.startswith(".")]
    errors: list[str] = []
    crlf_skills = 0
    for d in dirs:
        d_errs, has_crlf = audit_single_skill_dir(d, allow_crlf=allow_crlf)
        errors.extend(d_errs)
        if has_crlf:
            crlf_skills += 1
    return {
        "verifier": "skill-doctor",
        "target": str(target),
        "skills_checked": len(dirs),
        "crlf_skills_count": crlf_skills,
        "allow_crlf": allow_crlf,
        "clean": len(errors) == 0,
        "errors": errors,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="Omni Deterministic Phase-3 Verifier Suite")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_pres = sub.add_parser("preservation", help="Check UTF-8, LF/CRLF, control chars, and SHA-256")
    p_pres.add_argument("target")

    p_con = sub.add_parser("contrast", help="Compute WCAG 2.1 contrast ratio for two hex colors")
    p_con.add_argument("fg")
    p_con.add_argument("bg")

    p_sec = sub.add_parser("secrets", help="Scan file or directory for leaked credentials/keys")
    p_sec.add_argument("target")

    p_tok = sub.add_parser("tokens", help="Check estimated token budget of a file")
    p_tok.add_argument("path")
    p_tok.add_argument("--limit", type=int, default=5000)

    p_doc = sub.add_parser("skill-doctor", help="Audit a skill folder or skill root")
    p_doc.add_argument("target")
    p_doc.add_argument("--allow-crlf", action="store_true", help="Report CRLF count without failing legacy global roots")

    args = ap.parse_args()
    if args.cmd == "preservation":
        res = cmd_preservation(args.target)
    elif args.cmd == "contrast":
        res = cmd_contrast(args.fg, args.bg)
    elif args.cmd == "secrets":
        res = cmd_secrets(args.target)
    elif args.cmd == "tokens":
        res = cmd_tokens(args.path, args.limit)
    else:
        res = cmd_skill_doctor(args.target, allow_crlf=args.allow_crlf)

    print(json.dumps(res, indent=2, ensure_ascii=False))
    is_ok = bool(res.get("clean", res.get("clean_utf8_lf", res.get("utf8_valid", True))))
    return 0 if is_ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
