#!/usr/bin/env python3
"""Zero-dependency bilingual (Vietnamese + English) BM25 skill router, 4-stage DAG composer, and registry doctor."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import unicodedata
from collections import Counter
from pathlib import Path

VN_EN_SYNONYMS: dict[str, str] = {
    "giao dien": "ui direction modern tech quantitative qa anti slop tokens layout design frontend",
    "soan thao": "composer caret rich text markdown latex attachment inline tray",
    "dinh tuyen": "provider routing quota reservation circuit breaker fallback latency",
    "tri nho": "memory hierarchical graph rag provenance recall context compression",
    "tim kiem": "web search research rag retrieval grounding citation query",
    "don dep": "clean hygiene externalize worktree quarantine storage recovery ledger",
    "ban giao": "session governance handoff admission checkpoint receipt collaborator",
    "lich su": "history transcript sqlite zstd protobuf redaction export sync",
    "chinh ta": "vietnamese typo vni telex qwerty shorthand intent inference",
    "viet tat": "vietnamese shorthand abbreviation typo intent inference",
    "bao mat": "security audit secret redaction threat model permission boundary",
    "kiem chung": "verify deterministic qa test contrast sha256 eol audit",
    "song song": "parallel swarm subagent orchestration disjoint ownership",
    "steer": "additive steer queue backlog continuity goal",
    "dich nguoc": "reverse engineering binary disassembly protocol",
    "cua so": "window topology desktop control uia accessibility background",
    "do thi": "graphify general graph bidirectional peer mesh duplex knowledge graph ast",
    "2 chieu": "bidirectional duplex all to all peer mesh general graph",
    "hai chieu": "bidirectional duplex all to all peer mesh general graph",
    "de cuong luan van": "deep proposal academic thesis research grant hypotheses literature gap rubric",
    "de cuong": "deep proposal academic thesis research grant rfc spec kit",
    "luan van": "deep proposal academic thesis research grant hypotheses methodology",
    "khoa luan": "deep proposal academic thesis capstone research methodology",
    "de xuat giai phap": "deep proposal rfc rfp architecture candidate tradeoff compliance roi",
    "de xuat": "deep proposal rfc rfp product spec kit architecture tradeoff",
    "dau thau": "deep proposal rfp compliance matrix wbs sla roi client solution",
    "nckh": "deep proposal academic research grant hypotheses evaluation",
    "thesis proposal": "deep proposal academic thesis research grant hypotheses literature gap",
    "research proposal": "deep proposal academic research grant hypotheses methodology",
    "proposal": "deep proposal rfc thesis grant spec kit rfp tradeoff compliance",
    "rfc": "deep proposal engineering architecture rfc candidate tradeoff rollback",
    "rfp": "deep proposal client solution rfp compliance matrix roi wbs sla",
    "lap trinh cpp": "deep cpp native cpp20 cmake ninja msvc raii win32 winsqlite3 direct2d dwm uia winsock2",
    "ung dung ban dia": "deep cpp native cpp20 win32 dwm mica direct2d uia winsqlite3 winsock2",
    "ban dia": "deep cpp native cpp20 win32 dwm direct2d uia",
    "cpp20": "deep cpp native cmake ninja msvc raii win32 winsqlite3 bcrypt direct2d dwm uia winsock2",
    "cpp": "deep cpp native cpp20 cmake ninja msvc raii win32 winsqlite3 direct2d uia winsock2",
    "cmake": "deep cpp native cpp20 cmake ninja msvc ctest",
    "ninja": "deep cpp native cpp20 cmake ninja msvc ctest",
    "msvc": "deep cpp native cpp20 cmake ninja msvc raii win32",
    "win32": "deep cpp native cpp20 win32 dwm mica direct2d uia wm getobject",
    "direct2d": "deep cpp native cpp20 win32 dwm mica direct2d directwrite",
    "winsqlite": "deep cpp native cpp20 winsqlite3 wal lease raii",
    "winsqlite3": "deep cpp native cpp20 winsqlite3 wal lease raii",
    "winsock2": "deep cpp native cpp20 winsock2 loopback origin bridge",
    "webview2": "deep cpp native cpp20 winsock2 loopback origin studio ui",
}

PREWIRED_PIPELINES: dict[str, dict[str, object]] = {
    "omnia-cpp20-flagship-studio": {
        "goal": "Zero-overhead native Windows 11 C++20 engine + Win32/Direct2D/UIA shell + Origin-guarded Winsock2 flagship Studio UI",
        "skills": [
            "autonomous-power-continuity",
            "additive-steer-queue",
            "deep-cpp-native",
            "deep-general-graph-orchestration",
            "deep-ui-direction",
            "low-disruption-desktop-control",
            "ui-quantitative-audit",
            "omni-deterministic-verifiers",
            "omnia-session-governance-handoff",
        ],
    },
    "omnia-deep-proposal": {
        "goal": "Decision-grade Engineering RFC, Academic/Thesis/Grant, Product/Spec-Kit, and Client/RFP proposals with multi-option trade-offs & falsifiable gates",
        "skills": [
            "autonomous-power-continuity",
            "deep-proposal",
            "deep-decision-record",
            "omni-deterministic-verifiers",
            "omnia-session-governance-handoff",
        ],
    },
    "omnia-bidirectional-peer-graph": {
        "goal": "Bidirectional all-to-all agent peer mesh (A <-> B) + Graphify deterministic forward/reverse provenance graph",
        "skills": [
            "autonomous-power-continuity",
            "deep-general-graph-orchestration",
            "deep-knowledge-graph",
            "omni-deterministic-verifiers",
            "omnia-session-governance-handoff",
        ],
    },
    "omnia-session-handoff": {
        "goal": "Repository preservation, session admission, multi-host history redaction & collaborator handoff",
        "skills": [
            "autonomous-power-continuity",
            "additive-steer-queue",
            "omnia-session-governance-handoff",
            "deep-clean",
            "cross-artifact-ledger-binding",
            "omni-deterministic-verifiers",
        ],
    },
    "omnia-ui-surface": {
        "goal": "Anti-AI-slop UI direction, semantic tokens, accessibility & quantitative layout QA",
        "skills": [
            "deep-ui-direction",
            "design-system",
            "modern-tech-ui-design",
            "ui-quantitative-audit",
            "omni-deterministic-verifiers",
        ],
    },
    "omnia-rich-composer": {
        "goal": "Caret-accurate rich composer, live Markdown/LaTeX symbol palette & dual inline/tray attachments",
        "skills": [
            "omnia-session-governance-handoff",
            "deep-ui-direction",
            "low-disruption-desktop-control",
            "ui-quantitative-audit",
            "omni-deterministic-verifiers",
        ],
    },
    "omnia-dynamic-router": {
        "goal": "Deterministic provider/model router with atomic quota reservation, circuit breakers & route receipts",
        "skills": [
            "goal-plan-loop-dod",
            "harness-architecture-and-tool-design",
            "security-state-machine-audit",
            "verification-before-completion",
            "omni-deterministic-verifiers",
        ],
    },
    "omnia-memory-and-proactive-rag": {
        "goal": "Hierarchical + provenance-typed graph memory and proactive multi-query search/RAG source ledgers",
        "skills": [
            "memory-systems",
            "deep-memory-governance",
            "deep-adaptive-web-research",
            "rag-ingestion-and-retrieval",
            "deep-answer-grounding",
        ],
    },
    "bilingual-steer-intake": {
        "goal": "Decode Vietnamese/English VNI/Telex/QWERTY slips + shorthand and queue mid-run steers without drops",
        "skills": [
            "vietnamese-typo-intent-inference",
            "additive-steer-queue",
            "autonomous-power-continuity",
            "goal-plan-loop-dod",
        ],
    },
}

TOKEN_RE = re.compile(r"[a-z0-9]+")


def strip_accents(text: str) -> str:
    norm = unicodedata.normalize("NFD", text.replace("đ", "d").replace("Đ", "D"))
    return "".join(ch for ch in norm if unicodedata.category(ch) != "Mn")


def tokenize_bilingual(text: str) -> list[str]:
    normalized = strip_accents(text.lower()).replace("c++20", " cpp20 ").replace("c++", " cpp ")
    lowered = " " + re.sub(r"\s+", " ", normalized).strip() + " "
    expanded = [lowered]
    for vn_phrase, en_terms in VN_EN_SYNONYMS.items():
        if f" {vn_phrase} " in lowered or (len(vn_phrase) >= 5 and vn_phrase in lowered):
            expanded.append(en_terms)
    return [tok for tok in TOKEN_RE.findall(" ".join(expanded)) if len(tok) > 1]


def parse_frontmatter_quick(content: str) -> tuple[str, str, str]:
    clean = content.lstrip("\ufeff").replace("\r\n", "\n")
    m = re.match(r"^---\n(.*?)\n---(?:\n|$)(.*)", clean, re.DOTALL)
    if not m:
        return "", "", clean
    fm_text, body = m.group(1), m.group(2)
    name = ""
    desc_lines: list[str] = []
    in_desc = False
    for line in fm_text.splitlines():
        if line.startswith("name:"):
            name = line.split(":", 1)[1].strip().strip("\"'")
            in_desc = False
        elif line.startswith("description:"):
            rest = line.split(":", 1)[1].strip()
            in_desc = True
            if rest not in ("", ">", ">-", "|", "|-"):
                desc_lines.append(rest.strip("\"'"))
        elif in_desc and (line.startswith(" ") or line.startswith("\t")):
            desc_lines.append(line.strip())
        else:
            in_desc = False
    return name, " ".join(desc_lines).strip(), body


def default_roots(workspace: Path | None = None) -> list[Path]:
    home = Path.home()
    roots: list[Path] = []
    if workspace:
        roots.append(workspace / ".agents" / "skills")
    cwd_skills = Path.cwd() / ".agents" / "skills"
    if cwd_skills.exists() and cwd_skills not in roots:
        roots.append(cwd_skills)
    script_parent_skills = Path(__file__).resolve().parents[2]
    if script_parent_skills.name == "skills" and script_parent_skills not in roots:
        roots.append(script_parent_skills)
    for candidate in [
        home / ".codex" / "skills",
        home / ".codex" / "skills" / ".system",
        home / ".agents" / "skills",
    ]:
        if candidate.exists() and candidate not in roots:
            roots.append(candidate)
    return [r for r in roots if r.exists()]


def discover_live_skills(roots: list[Path]) -> list[dict[str, object]]:
    seen: set[str] = set()
    catalog: list[dict[str, object]] = []
    for root in roots:
        for child in sorted(root.iterdir(), key=lambda p: p.name):
            if child.name.startswith(".") or not child.is_dir():
                continue
            skill_md = child / "SKILL.md"
            if not skill_md.is_file():
                continue
            raw = skill_md.read_bytes()
            text = raw.decode("utf-8", errors="replace")
            name, desc, body = parse_frontmatter_quick(text)
            slug = name or child.name
            if slug in seen:
                continue
            seen.add(slug)
            catalog.append({
                "slug": slug,
                "root": str(root),
                "path": str(skill_md),
                "description": desc,
                "description_chars": len(desc),
                "body_tokens_est": max(1, len(body) // 4),
                "sha256_lf": hashlib.sha256(raw.replace(b"\r\n", b"\n")).hexdigest(),
            })
    return catalog


def classify_stage(slug: str, desc: str) -> int:
    s = f"{slug} {desc}".lower()
    if any(k in slug for k in ("steer", "continuity", "typo", "admission", "governance", "goal-plan")):
        return 1
    if any(k in slug for k in ("verif", "audit", "quantitative", "test", "security", "eval")):
        return 3
    if any(k in slug for k in ("ledger", "handoff", "memory-skill-evolution", "report")):
        return 4
    if "verify" in s and "audit" in s and "implement" not in s:
        return 3
    return 2


def compose_dag(slugs_with_meta: list[dict[str, object]]) -> dict[str, list[str]]:
    stages: dict[int, list[str]] = {1: [], 2: [], 3: [], 4: []}
    for item in slugs_with_meta:
        slug = str(item["slug"])
        st = classify_stage(slug, str(item.get("description", "")))
        if slug not in stages[st]:
            stages[st].append(slug)
    if not stages[1]:
        stages[1].append("autonomous-power-continuity")
    if not stages[3]:
        stages[3].append("omni-deterministic-verifiers")
    if not stages[4]:
        stages[4].append("omnia-session-governance-handoff")
    return {
        "stage_1_preflight_and_intake": stages[1],
        "stage_2_domain_execution": stages[2],
        "stage_3_verification_gate": stages[3],
        "stage_4_receipt_and_learning": stages[4],
    }


class BM25Router:
    def __init__(self, skills: list[dict[str, object]], k1: float = 1.5, b: float = 0.75) -> None:
        self.skills = skills
        self.k1 = k1
        self.b = b
        self.doc_tokens: list[Counter[str]] = []
        self.doc_lens: list[int] = []
        self.df: Counter[str] = Counter()
        for s in skills:
            raw_slug = str(s["slug"])
            slug_words = raw_slug.replace("-", " ")
            core_words = raw_slug.replace("deep-", "").replace("-", " ")
            weighted = f"{slug_words} {core_words} {core_words} {core_words} {s['description']}"
            toks = tokenize_bilingual(weighted)
            counts = Counter(toks)
            self.doc_tokens.append(counts)
            self.doc_lens.append(len(toks))
            for t in counts:
                self.df[t] += 1
        self.n_docs = max(1, len(skills))
        self.avgdl = sum(self.doc_lens) / self.n_docs if self.doc_lens else 1.0

    def search(self, query: str, top_k: int = 6) -> list[tuple[float, dict[str, object]]]:
        q_terms = tokenize_bilingual(query)
        if not q_terms:
            return []
        ranked: list[tuple[float, dict[str, object]]] = []
        for idx, s in enumerate(self.skills):
            dl = self.doc_lens[idx]
            tf_map = self.doc_tokens[idx]
            score = 0.0
            for term in q_terms:
                tf = tf_map.get(term, 0)
                if tf == 0:
                    continue
                n_q = self.df.get(term, 0)
                idf = math.log(1.0 + (self.n_docs - n_q + 0.5) / (n_q + 0.5))
                denom = tf + self.k1 * (1.0 - self.b + self.b * (dl / self.avgdl))
                score += idf * ((tf * (self.k1 + 1.0)) / denom)
            if score > 0:
                ranked.append((round(score, 4), s))
        ranked.sort(key=lambda item: (-item[0], str(item[1]["slug"])))
        return ranked[:top_k]


def main() -> int:
    ap = argparse.ArgumentParser(description="Omni Bilingual BM25 Skill Router & DAG Composer")
    ap.add_argument("--workspace", default="", help="Optional workspace root")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_route = sub.add_parser("route", help="Rank skills for a Vietnamese or English query")
    p_route.add_argument("query")
    p_route.add_argument("-k", "--top-k", type=int, default=6)

    sub.add_parser("pipelines", help="List pre-wired multi-skill pipelines")
    p_pipe = sub.add_parser("pipeline", help="Inspect one pre-wired pipeline against live skills")
    p_pipe.add_argument("name", choices=sorted(PREWIRED_PIPELINES.keys()))

    sub.add_parser("doctor", help="Compute Merkle SHA-256 lock digest & token health across roots")

    args = ap.parse_args()
    ws = Path(args.workspace).resolve() if args.workspace else None
    roots = default_roots(ws)
    skills = discover_live_skills(roots)
    by_slug = {str(s["slug"]): s for s in skills}

    if args.cmd == "pipelines":
        out = {
            name: {
                "goal": spec["goal"],
                "skills": spec["skills"],
                "installed_count": sum(1 for sl in spec["skills"] if sl in by_slug),  # type: ignore[union-attr]
            }
            for name, spec in sorted(PREWIRED_PIPELINES.items())
        }
        print(json.dumps(out, indent=2, ensure_ascii=False))
        return 0

    if args.cmd == "pipeline":
        spec = PREWIRED_PIPELINES[args.name]
        items = [by_slug.get(sl, {"slug": sl, "description": ""}) for sl in spec["skills"]]  # type: ignore[union-attr]
        print(json.dumps({
            "pipeline": args.name,
            "goal": spec["goal"],
            "missing_skills": [sl for sl in spec["skills"] if sl not in by_slug],  # type: ignore[union-attr]
            "execution_dag": compose_dag(items),
        }, indent=2, ensure_ascii=False))
        return 0

    if args.cmd == "doctor":
        concat = "".join(f"{s['slug']}:{s['sha256_lf']}\n" for s in sorted(skills, key=lambda x: str(x["slug"])))
        merkle = hashlib.sha256(concat.encode("utf-8")).hexdigest()
        over_1024 = [s["slug"] for s in skills if int(s["description_chars"]) > 1024]  # type: ignore[arg-type]
        over_body = [s["slug"] for s in skills if int(s["body_tokens_est"]) > 5000]  # type: ignore[arg-type]
        print(json.dumps({
            "roots_scanned": [str(r) for r in roots],
            "unique_skills": len(skills),
            "ecosystem_merkle_sha256": merkle,
            "descriptions_over_1024_chars": over_1024,
            "bodies_over_5000_est_tokens": over_body,
            "healthy": len(over_1024) == 0,
        }, indent=2, ensure_ascii=False))
        return 0

    router = BM25Router(skills)
    matches = router.search(args.query, top_k=args.top_k)
    print(json.dumps({
        "query": args.query,
        "indexed_skills": len(skills),
        "top_matches": [
            {
                "score": score,
                "slug": s["slug"],
                "root": s["root"],
                "description": s["description"],
            }
            for score, s in matches
        ],
        "recommended_execution_dag": compose_dag([s for _, s in matches]),
    }, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
