#!/usr/bin/env python3
"""Zero-dependency bilingual (Vietnamese + English) BM25+fuzzy skill router, 24-pipeline DAG composer, cold-vault lookup, doctor, and 16-case golden routing benchmark."""

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
    "nghien cuu sau": "deep research web search academic arxiv openalex europepmc rag citation ledger prisma",
    "nghien cuu": "deep research literature review web search citation rag grounding sources",
    "tu duy sau": "deep think multi hypothesis tree of thought invariant proof falsification red team",
    "suy luan sau": "deep think multi hypothesis reasoning proof falsification adversarial critique",
    "trich dan": "citation management deep research inline s001 g001 sources ledger bibtex grounding",
    "nguon": "sources ledger deep research searched viewed extracted rag vault citation",
    "vong doi": "super plan run lifecycle goal spec blueprint plan todo progress dod handoff memory lessons",
    "ke hoach": "super plan run lifecycle goal plan loop dod spec blueprint tasks milestones",
    "muc tieu": "goal plan loop dod super plan run lifecycle objective acceptance criteria",
    "dac ta": "spec blueprint super plan run lifecycle acceptance criteria deep proposal",
    "kien truc": "blueprint architecture deep think deep proposal super plan run lifecycle rust",
    "bai hoc": "lessons learn super plan run lifecycle memory continuous learning codify",
    "hoc hoi": "learn lessons skill codify super plan run lifecycle memory continuous learning",
    "giao dien": "ui direction modern tech quantitative qa anti slop tokens layout design frontend wcag",
    "soan thao": "composer caret rich text markdown latex attachment inline tray",
    "dinh tuyen": "provider routing quota reservation circuit breaker fallback latency skill router",
    "tri nho": "memory hierarchical graph rag provenance recall context compression lessons",
    "tim kiem": "web search deep research rag retrieval grounding citation query bm25",
    "don dep": "clean hygiene externalize worktree quarantine storage recovery ledger",
    "ban giao": "session governance handoff admission checkpoint receipt collaborator lifecycle",
    "lich su": "history transcript sqlite zstd protobuf redaction export sync fts5",
    "chinh ta": "vietnamese typo vni telex qwerty shorthand intent inference",
    "viet tat": "vietnamese shorthand abbreviation typo intent inference",
    "bao mat": "security audit secret redaction threat model permission boundary origin sandbox",
    "kiem chung": "verify deterministic qa test contrast sha256 eol audit verifier preservation",
    "song song": "parallel swarm subagent orchestration disjoint ownership peer mesh",
    "steer": "additive steer queue backlog continuity goal deep steer compare swap",
    "dieu huong": "deep steer compare swap mutation supersession cancellation control receipt",
    "dich nguoc": "reverse engineering binary disassembly protocol",
    "cua so": "window topology desktop control uia accessibility background win32",
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
    "nckh": "deep proposal academic research grant hypotheses evaluation kdense literature review",
    "proposal": "deep proposal rfc thesis grant spec kit rfp tradeoff compliance",
    "rfc": "deep proposal engineering architecture rfc candidate tradeoff rollback",
    "rfp": "deep proposal client solution rfp compliance matrix roi wbs sla",
    "rust": "full native rust cargo workspace winsqlite3 win32 studio cli tui harness",
    "mang": "network ip dns proxy tls speedtest bufferbloat observatory",
    "toc do mang": "speedtest bufferbloat latency jitter throughput network observatory",
    "tai file": "omnidrive downloader multi stream range http google drive hls dash ffmpeg",
    "kho ky nang": "omni bilingual skill router cold vault bm25 dag pipelines doctor golden eval",
    "mcp": "codex mcp namespace diagnostics sse code mode windows timeout",
    "lap trinh cpp": "deep cpp native cpp20 cmake ninja msvc raii win32 winsqlite3 direct2d dwm uia winsock2",
    "cpp20": "deep cpp native cmake ninja msvc raii win32 winsqlite3 bcrypt direct2d dwm uia winsock2",
    "cpp": "deep cpp native cpp20 cmake ninja msvc raii win32 winsqlite3 direct2d dwm uia winsock2",
    "win32": "deep cpp native win32 dwm mica direct2d uia wm getobject",
    "winsqlite3": "deep cpp native winsqlite3 wal lease raii",
    "khoa hoc": "kdense scientific writing literature review citation management brainstorming critical thinking visualization",
    "truc quan hoa": "kdense scientific visualization matplotlib plotly figure contrast accessibility",
}

PREWIRED_PIPELINES: dict[str, dict[str, object]] = {
    "omnia-deep-research": {
        "goal": "Default-ON 6-stage active web/academic search, extraction, persistent Local+Global RAG, inline [S###]/[G###] citations & PRISMA source ledger",
        "skills": [
            "autonomous-power-continuity",
            "deep-research",
            "kdense-literature-review",
            "kdense-citation-management",
            "omni-deterministic-verifiers",
            "super-plan-run-lifecycle",
        ],
    },
    "omnia-deep-think": {
        "goal": "Formal invariant framing, >=3 Tree-of-Thought branches, executable proof/fuzz falsification & cross-model adversarial critique",
        "skills": [
            "autonomous-power-continuity",
            "deep-think",
            "deep-research",
            "kdense-scientific-critical-thinking",
            "omni-deterministic-verifiers",
            "super-plan-run-lifecycle",
        ],
    },
    "omnia-workspace-governance": {
        "goal": "Proactive 12-artifact cross-linked Lifecycle OS (Goal/Spec/Blueprint/Plan/Todo/Progress/DoD/Handoff/Memory/Lessons/Learn/Skills)",
        "skills": [
            "autonomous-power-continuity",
            "additive-steer-queue",
            "super-plan-run-lifecycle",
            "goal-plan-loop-dod",
            "omni-deterministic-verifiers",
            "omnia-session-governance-handoff",
        ],
    },
    "omnia-memory-learn-evolve": {
        "goal": "2-Tier Lessons capture, Semantic Overlap Audit, Gap Radar Evolver, atomic skill codification & 3-way cross-host parity sync",
        "skills": [
            "super-plan-run-lifecycle",
            "omni-bilingual-skill-router",
            "omni-deterministic-verifiers",
            "omnia-session-governance-handoff",
        ],
    },
    "omnia-rust-flagship-studio": {
        "goal": "Full Native Rust 17-crate workspace + Flagship ui-v5 Studio + ratatui TUI + Win32 Mica/UIA shell with zero-bloat & strict verification",
        "skills": [
            "autonomous-power-continuity",
            "additive-steer-queue",
            "super-plan-run-lifecycle",
            "deep-general-graph-orchestration",
            "omni-deterministic-verifiers",
            "omnia-session-governance-handoff",
        ],
    },
    "omnia-network-observatory": {
        "goal": "Native Rust Network/IP/DNS/Proxy/TLS + cancellable Speedtest/Bufferbloat Observatory with Privacy Mask & SQLite WAL history",
        "skills": [
            "super-plan-run-lifecycle",
            "deep-think",
            "omni-deterministic-verifiers",
            "omnia-session-governance-handoff",
        ],
    },
    "omnia-frontier-benchmarks": {
        "goal": "Zero-sequential parallel harness benchmarking (Suite v5, 9 public suites, All-51 models, 5-effort sweep) with cleanroom trace audit",
        "skills": [
            "goal-plan-loop-dod",
            "deep-think",
            "kdense-scientific-critical-thinking",
            "kdense-scientific-visualization",
            "omni-deterministic-verifiers",
        ],
    },
    "omnia-atelier-notebook": {
        "goal": "Grounded Notebook Q&A, multi-format source preview, citations, study artifacts & research synthesis",
        "skills": [
            "deep-research",
            "kdense-citation-management",
            "kdense-scientific-writing",
            "omni-deterministic-verifiers",
        ],
    },
    "omnia-omnidrive-downloader": {
        "goal": "Multi-stream HTTP/Google Drive/HLS/DASH downloader with Byte-Range integrity, FFmpeg tail-decode & non-bypass manual handoff",
        "skills": [
            "goal-plan-loop-dod",
            "deep-think",
            "omni-deterministic-verifiers",
            "omnia-session-governance-handoff",
        ],
    },
    "omnia-session-handoff": {
        "goal": "Repository preservation, session admission, multi-host history redaction & 6-state collaborator handoff",
        "skills": [
            "autonomous-power-continuity",
            "additive-steer-queue",
            "omnia-session-governance-handoff",
            "super-plan-run-lifecycle",
            "deep-clean",
            "omni-deterministic-verifiers",
        ],
    },
    "omnia-ui-surface": {
        "goal": "Anti-AI-slop WCAG >= 4.8:1 multi-theme UI direction, 4x-CPU Playwright E2E, contrast verification & zero-overflow layout QA",
        "skills": [
            "goal-plan-loop-dod",
            "super-plan-run-lifecycle",
            "kdense-scientific-visualization",
            "omni-deterministic-verifiers",
        ],
    },
    "omnia-rich-composer": {
        "goal": "Caret-accurate rich composer, live Markdown/LaTeX/symbol palette, inline [S###]/[G###] chips & dual inline/tray attachments",
        "skills": [
            "omnia-session-governance-handoff",
            "super-plan-run-lifecycle",
            "vietnamese-typo-intent-inference",
            "omni-deterministic-verifiers",
        ],
    },
    "omnia-dynamic-router": {
        "goal": "Deterministic provider/model router with model-scoped cooldowns, simulate mode, atomic quota reservation & circuit breakers",
        "skills": [
            "goal-plan-loop-dod",
            "deep-think",
            "omni-deterministic-verifiers",
            "omnia-session-governance-handoff",
        ],
    },
    "omnia-bidirectional-peer-graph": {
        "goal": "Bidirectional all-to-all agent peer mesh (A <-> B) + Graphify deterministic forward/reverse provenance graph",
        "skills": [
            "autonomous-power-continuity",
            "deep-general-graph-orchestration",
            "super-plan-run-lifecycle",
            "omni-deterministic-verifiers",
            "omnia-session-governance-handoff",
        ],
    },
    "omnia-deep-proposal": {
        "goal": "Decision-grade Engineering RFC, Academic/Thesis/Grant, Product/Spec-Kit & Client/RFP proposals with trade-off matrices",
        "skills": [
            "autonomous-power-continuity",
            "deep-proposal",
            "deep-research",
            "deep-think",
            "omni-deterministic-verifiers",
            "omnia-session-governance-handoff",
        ],
    },
    "omnia-memory-and-proactive-rag": {
        "goal": "Bi-temporal Hindsight/Graphiti/HippoRAG memory & proactive Local+Global RAG with inline citation ledgers",
        "skills": [
            "deep-research",
            "super-plan-run-lifecycle",
            "deep-general-graph-orchestration",
            "omni-deterministic-verifiers",
        ],
    },
    "bilingual-steer-intake": {
        "goal": "Decode Vietnamese/English VNI/Telex/QWERTY slips + shorthand and queue mid-run steers without dropping unfinished work",
        "skills": [
            "vietnamese-typo-intent-inference",
            "additive-steer-queue",
            "deep-steer",
            "autonomous-power-continuity",
            "goal-plan-loop-dod",
        ],
    },
    "triple-audit-release": {
        "goal": "Pre-release secret scan, UTF-8 LF hygiene, skill parity, clean-clone verification & 3-consecutive frozen-snapshot cleanroom audits",
        "skills": [
            "deep-clean",
            "omni-deterministic-verifiers",
            "omnia-session-governance-handoff",
            "super-plan-run-lifecycle",
        ],
    },
    "q1-scientific-paper": {
        "goal": "Systematic literature review, brainstorming, critical appraisal, publication figures, verified BibTeX citations & manuscript drafting",
        "skills": [
            "deep-research",
            "kdense-literature-review",
            "kdense-scientific-brainstorming",
            "kdense-scientific-critical-thinking",
            "kdense-citation-management",
            "kdense-scientific-visualization",
            "kdense-scientific-writing",
        ],
    },
    "rust-zero-copy-engine": {
        "goal": "Low-footprint native Rust systems engineering within binary-size, startup-latency & RSS budgets",
        "skills": [
            "goal-plan-loop-dod",
            "deep-think",
            "super-plan-run-lifecycle",
            "omni-deterministic-verifiers",
        ],
    },
    "hybrid-rag-vs-agent": {
        "goal": "Architectural trade-off evaluation and implementation of CST GraphRAG vs autonomous agentic harness",
        "skills": [
            "deep-proposal",
            "deep-research",
            "deep-think",
            "deep-general-graph-orchestration",
            "omni-deterministic-verifiers",
        ],
    },
    "codex-mcp-diagnostics": {
        "goal": "Diagnose and repair Codex MCP namespace stripping, V8 code_mode execution & Windows cold-start timeouts",
        "skills": [
            "codex-mcp-namespace-diagnostics",
            "deep-think",
            "omni-deterministic-verifiers",
            "super-plan-run-lifecycle",
        ],
    },
    "omnia-cpp20-native-diag": {
        "goal": "General/historical Windows 11 native C++20 CMake/Ninja/MSVC/Win32/Direct2D/UIA diagnostics & archive maintenance",
        "skills": [
            "deep-cpp-native",
            "omni-deterministic-verifiers",
            "omnia-session-governance-handoff",
        ],
    },
    "safe-workspace-deep-clean": {
        "goal": "Inventory, provenance classification, quarantine, 0x400 reparse guards & verified free-space reclamation",
        "skills": [
            "deep-clean",
            "omni-deterministic-verifiers",
            "omnia-session-governance-handoff",
        ],
    },
}

GOLDEN_BENCHMARK_CASES: list[tuple[str, str]] = [
    ("nghiên cứu sâu web search trích dẫn nguồn S001 G001 và RAG lưu trữ cục bộ", "deep-research"),
    ("suy luận sâu chứng minh bất biến thuật toán Tree of Thought và phản biện red team", "deep-think"),
    ("tạo và liên kết vòng đời Goal Spec Blueprint Plan Todo DoD Handoff Lessons Learn", "super-plan-run-lifecycle"),
    ("kiểm tra điều kiện mở phiên SESSION_ADMISSION và bàn giao 6 trạng thái", "omnia-session-governance-handoff"),
    ("xử lý yêu cầu bổ sung giữa chừng bằng hàng đợi additive steer không hủy việc cũ", "additive-steer-queue"),
    ("soạn đề cương luận văn RFC RFP kiến trúc kèm ma trận đánh đổi phương án", "deep-proposal"),
    ("điều phối mạng lưới agent hai chiều peer mesh và đồ thị Graphify", "deep-general-graph-orchestration"),
    ("dọn dẹp kho lưu trữ kiểm tra reparse point phân loại và cách ly an toàn", "deep-clean"),
    ("kiểm chứng tất định SHA-256 LF tương phản màu WCAG quét bí mật và FFmpeg", "omni-deterministic-verifiers"),
    ("định tuyến kỹ năng song ngữ Việt Anh BM25 và ghép dây chuyền DAG", "omni-bilingual-skill-router"),
    ("sửa lỗi gõ dấu VNI Telex và viết tắt tiếng Việt của lập trình viên", "vietnamese-typo-intent-inference"),
    ("chẩn đoán lỗi Codex MCP namespace stripping và timeout khởi động Windows", "codex-mcp-namespace-diagnostics"),
    ("chuyển hướng tác vụ an toàn bằng compare and swap và biên nhận điều khiển", "deep-steer"),
    ("tổng quan tài liệu khoa học hệ thống PubMed arXiv bioRxiv và sàng lọc PRISMA", "kdense-literature-review"),
    ("quản lý trích dẫn BibTeX kiểm tra DOI qua OpenAlex và Google Scholar", "kdense-citation-management"),
    ("lập trình ứng dụng bản địa Windows C++20 CMake Ninja MSVC Direct2D UIA", "deep-cpp-native"),
]

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


def bounded_levenshtein(a: str, b: str, max_dist: int = 1) -> int:
    if abs(len(a) - len(b)) > max_dist:
        return max_dist + 1
    if a == b:
        return 0
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        curr = [i]
        row_min = i
        for j, cb in enumerate(b, 1):
            cost = 0 if ca == cb else 1
            val = min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
            curr.append(val)
            if val < row_min:
                row_min = val
        if row_min > max_dist:
            return max_dist + 1
        prev = curr
    return prev[-1]


def parse_frontmatter_quick(content: str) -> tuple[str, str, str, int]:
    clean = content.lstrip("\ufeff").replace("\r\n", "\n")
    m = re.match(r"^---\n(.*?)\n---(?:\n|$)(.*)", clean, re.DOTALL)
    if not m:
        return "", "", clean, 0
    fm_text, body = m.group(1), m.group(2)
    fm_tokens_est = max(1, len(fm_text) // 4)
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
    return name, " ".join(desc_lines).strip(), body, fm_tokens_est


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
            name, desc, body, fm_tok = parse_frontmatter_quick(text)
            slug = name or child.name
            if slug in seen:
                continue
            seen.add(slug)
            catalog.append({
                "slug": slug,
                "tier": "active",
                "root": str(root),
                "path": str(skill_md),
                "description": desc,
                "description_chars": len(desc),
                "frontmatter_tokens_est": fm_tok,
                "body_tokens_est": max(1, len(body) // 4),
                "sha256_lf": hashlib.sha256(raw.replace(b"\r\n", b"\n")).hexdigest(),
            })
    return catalog


def load_cold_vault_catalog(vault_path: Path) -> list[dict[str, object]]:
    if not vault_path.is_file():
        return []
    data = json.loads(vault_path.read_text(encoding="utf-8"))
    raw_items = data.get("skills_catalog") or data.get("skills") or []
    cat_titles = {
        str(c.get("id") or c.get("category_id") or ""): str(c.get("title") or c.get("name") or "")
        for c in (data.get("categories_100") or [])
        if isinstance(c, dict)
    }
    out: list[dict[str, object]] = []
    for entry in raw_items:
        if not isinstance(entry, dict):
            continue
        slug = str(entry.get("slug") or entry.get("name") or "").strip()
        if not slug:
            continue
        focus = " ".join(
            part
            for part in (
                str(entry.get("focus") or "").strip(),
                str(entry.get("focus_en") or "").strip(),
                str(entry.get("description") or "").strip(),
                str(entry.get("description_vi") or "").strip(),
            )
            if part
        )
        cat_id = str(entry.get("category_id") or "").strip()
        cat = str(entry.get("category") or cat_titles.get(cat_id, "")).strip()
        arts = entry.get("canonical_artifacts") or entry.get("artifacts") or []
        art_str = " ".join(str(a) for a in arts) if isinstance(arts, list) else str(arts)
        out.append({
            "slug": slug,
            "tier": "cold_vault",
            "root": str(vault_path),
            "path": str(entry.get("path") or f"vault://{slug}"),
            "description": f"{cat}: {focus} {art_str}".strip(),
            "description_chars": len(focus),
            "frontmatter_tokens_est": 0,
            "body_tokens_est": 0,
            "sha256_lf": str(entry.get("sha256") or ""),
        })
    return out


def classify_stage(slug: str, desc: str) -> int:
    s = f"{slug} {desc}".lower()
    if any(k in slug for k in ("steer", "continuity", "typo", "admission", "governance", "goal-plan")):
        return 1
    if any(k in slug for k in ("verif", "audit", "quantitative", "test", "security", "eval", "diagnostics")):
        return 3
    if any(k in slug for k in ("ledger", "handoff", "memory-skill-evolution", "report", "lifecycle")):
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
        self.slug_tokens: list[set[str]] = []
        self.doc_lens: list[int] = []
        self.df: Counter[str] = Counter()
        for s in skills:
            raw_slug = str(s["slug"])
            slug_words = raw_slug.replace("-", " ")
            core_words = raw_slug.replace("deep-", "").replace("kdense-", "").replace("-", " ")
            weighted = f"{slug_words} {core_words} {core_words} {core_words} {s['description']}"
            toks = tokenize_bilingual(weighted)
            counts = Counter(toks)
            self.doc_tokens.append(counts)
            self.slug_tokens.append(set(TOKEN_RE.findall(strip_accents(raw_slug.lower()))))
            self.doc_lens.append(len(toks))
            for t in counts:
                self.df[t] += 1
        self.n_docs = max(1, len(skills))
        self.avgdl = sum(self.doc_lens) / self.n_docs if self.doc_lens else 1.0

    def search(self, query: str, top_k: int = 6) -> list[tuple[float, dict[str, object]]]:
        raw_direct = set(TOKEN_RE.findall(strip_accents(query.lower())))
        q_terms = tokenize_bilingual(query)
        if not q_terms:
            return []
        ranked: list[tuple[float, dict[str, object]]] = []
        for idx, s in enumerate(self.skills):
            dl = self.doc_lens[idx]
            tf_map = self.doc_tokens[idx]
            slug_set = self.slug_tokens[idx]
            score = 0.0
            for term in q_terms:
                tf = tf_map.get(term, 0)
                if tf == 0 and len(term) >= 5:
                    for cand in slug_set:
                        if bounded_levenshtein(term, cand, max_dist=1) <= 1:
                            tf = 1
                            break
                if tf == 0:
                    continue
                n_q = self.df.get(term, 1)
                idf = math.log(1.0 + (self.n_docs - n_q + 0.5) / (n_q + 0.5))
                denom = tf + self.k1 * (1.0 - self.b + self.b * (dl / self.avgdl))
                term_score = idf * ((tf * (self.k1 + 1.0)) / denom)
                if term in raw_direct:
                    term_score *= 1.8
                if term in slug_set:
                    term_score *= 1.35
                score += term_score
            if score > 0:
                ranked.append((round(score, 4), s))
        ranked.sort(key=lambda item: (-item[0], str(item[1]["slug"])))
        return ranked[:top_k]


def main() -> int:
    ap = argparse.ArgumentParser(description="Omni Bilingual BM25+Fuzzy Skill Router, 24-Pipeline DAG Composer & Golden Eval")
    ap.add_argument("--workspace", default="", help="Optional workspace root")
    ap.add_argument("--vault", default="", help="Optional external omni-deep-1000-catalog.json cold vault path")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_route = sub.add_parser("route", help="Rank skills for a Vietnamese or English query")
    p_route.add_argument("query")
    p_route.add_argument("-k", "--top-k", type=int, default=6)

    sub.add_parser("pipelines", help="List all 24 pre-wired multi-skill pipelines")
    p_pipe = sub.add_parser("pipeline", help="Inspect one pre-wired pipeline against live skills")
    p_pipe.add_argument("name", choices=sorted(PREWIRED_PIPELINES.keys()))

    sub.add_parser("doctor", help="Compute Merkle SHA-256 lock digest & token health across roots")
    sub.add_parser("golden-eval", help="Run the 16-case Bilingual Golden Routing Benchmark (>= 95% Top-5 Recall)")

    args = ap.parse_args()
    ws = Path(args.workspace).resolve() if args.workspace else None
    roots = default_roots(ws)
    skills = discover_live_skills(roots)
    if args.vault:
        seen_slugs = {str(s["slug"]) for s in skills}
        for vskill in load_cold_vault_catalog(Path(args.vault)):
            if str(vskill["slug"]) not in seen_slugs:
                skills.append(vskill)
                seen_slugs.add(str(vskill["slug"]))
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
        active_skills = [s for s in skills if s.get("tier") == "active"]
        concat = "".join(f"{s['slug']}:{s['sha256_lf']}\n" for s in sorted(active_skills, key=lambda x: str(x["slug"])))
        merkle = hashlib.sha256(concat.encode("utf-8")).hexdigest()
        over_1024 = [s["slug"] for s in active_skills if int(s["description_chars"]) > 1024]  # type: ignore[arg-type]
        over_fm = [s["slug"] for s in active_skills if int(s["frontmatter_tokens_est"]) > 110]  # type: ignore[arg-type]
        over_body = [s["slug"] for s in active_skills if int(s["body_tokens_est"]) > 3500]  # type: ignore[arg-type]
        print(json.dumps({
            "roots_scanned": [str(r) for r in roots],
            "unique_active_skills": len(active_skills),
            "total_indexed_skills": len(skills),
            "ecosystem_merkle_sha256": merkle,
            "descriptions_over_1024_chars": over_1024,
            "frontmatters_over_110_est_tokens": over_fm,
            "bodies_over_3500_est_tokens": over_body,
            "healthy": len(over_1024) == 0,
        }, indent=2, ensure_ascii=False))
        return 0

    if args.cmd == "golden-eval":
        router = BM25Router(skills)
        top1 = 0
        top5 = 0
        misses: list[dict[str, object]] = []
        for query, expected in GOLDEN_BENCHMARK_CASES:
            hits = [str(s["slug"]) for _, s in router.search(query, top_k=5)]
            if hits and hits[0] == expected:
                top1 += 1
            if expected in hits:
                top5 += 1
            else:
                misses.append({"query": query, "expected": expected, "top5": hits})
        total = len(GOLDEN_BENCHMARK_CASES)
        recall5 = round((top5 * 100.0) / max(1, total), 2)
        print(json.dumps({
            "cases": total,
            "top1_hits": top1,
            "top5_hits": top5,
            "top5_recall_pct": recall5,
            "gate_95pct_passed": recall5 >= 95.0,
            "misses": misses,
        }, indent=2, ensure_ascii=False))
        return 0 if recall5 >= 95.0 else 1

    router = BM25Router(skills)
    matches = router.search(args.query, top_k=args.top_k)
    print(json.dumps({
        "query": args.query,
        "indexed_skills": len(skills),
        "top_matches": [
            {
                "score": score,
                "slug": s["slug"],
                "tier": s["tier"],
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
