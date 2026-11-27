use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use omnia_core::{sha256_hex, truncate_utf8_codepoints};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::proactive_rag::{fold_vietnamese_ascii, tokenize_folded};
use crate::research_vault::{atomic_write_with_retry, levenshtein_bounded};

const MAX_SKILLS_PER_ROOT: usize = 1024;
const MAX_SKILL_FILE_BYTES: u64 = 256 * 1024;
const MAX_DESCRIPTION_CODEPOINTS: usize = 1024;

/// Default read-only Cold Vault catalog locations (never dumped as stub files into tracked repo).
pub const DEFAULT_COLD_VAULT_PATHS: &[&str] = &[
    r"D:\OmniaData\research\omnia-clean-2026-11-12\omni-deep-1000-catalog.json",
    r"C:\Users\khang\.gemini\config\plugins\agy-fast\omni-vault",
];

/// Errors returned while validating or loading skill manifests and packages.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SkillError {
    #[error("skill root or manifest i/o error: {0}")]
    IoError(String),
    #[error("invalid skills.json manifest: {0}")]
    InvalidManifest(String),
    #[error("skill path `{0}` violates symlink/reparse or containment policy")]
    UnsafePath(String),
    #[error("skill registry internal lock poisoned")]
    InternalLockPoisoned,
}

/// Optional UI metadata parsed from `<skill_dir>/agents/openai.yaml`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct OpenAiSkillInterface {
    pub display_name: String,
    pub short_description: String,
    pub default_prompt: String,
}

impl OpenAiSkillInterface {
    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "display_name": self.display_name,
            "short_description": self.short_description,
            "default_prompt": self.default_prompt,
        })
    }
}

/// Registered skill metadata loaded from `SKILL.md` and `agents/openai.yaml`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillMetadata {
    pub name: String,
    pub description: String,
    pub path: String,
    pub openai_interface: Option<OpenAiSkillInterface>,
    pub category: String,
    pub canonical_artifacts: Vec<String>,
    pub sha256: String,
    pub frontmatter_tokens: usize,
    pub body_tokens: usize,
    pub has_5phase_headers: bool,
}

impl SkillMetadata {
    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "name": self.name,
            "description": self.description,
            "path": self.path,
            "openai_interface": self.openai_interface.as_ref().map(OpenAiSkillInterface::to_json),
            "category": self.category,
            "canonical_artifacts": self.canonical_artifacts,
            "sha256": self.sha256,
            "frontmatter_tokens": self.frontmatter_tokens,
            "body_tokens": self.body_tokens,
            "has_5phase_headers": self.has_5phase_headers,
        })
    }
}

impl Serialize for SkillMetadata {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.to_json().serialize(serializer)
    }
}

/// Ranked BM25 search match from [`SkillRegistry::search`].
#[derive(Debug, Clone, PartialEq)]
pub struct SkillMatch {
    pub skill: SkillMetadata,
    pub score: f64,
    pub matched_terms: Vec<String>,
}

impl SkillMatch {
    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "skill": self.skill.to_json(),
            "score": self.score,
            "matched_terms": self.matched_terms,
        })
    }
}

/// Read-only Cold Vault entry loaded from `omni-deep-1000-catalog.json` or `.agents/vault/skills/`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColdVaultEntry {
    pub slug: String,
    pub category_id: String,
    pub category: String,
    pub focus: String,
    pub canonical_artifacts: Vec<String>,
    pub source: String,
    pub path: Option<String>,
}

/// One stage inside a 4-Stage Execution DAG or pre-wired pipeline.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionDagStage {
    pub stage: String,
    pub skills: Vec<String>,
    pub purpose: String,
}

/// Pre-wired multi-skill DAG pipeline specification (`24` Rust-native pipelines).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineSpec {
    pub id: String,
    pub title: String,
    pub category: String,
    pub stages: Vec<ExecutionDagStage>,
    pub description: String,
}

/// Structural & SHA-256 Merkle integrity report emitted by [`SkillRegistry::doctor`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDoctorReport {
    pub ok: bool,
    pub total_skills: usize,
    pub cold_vault_count: usize,
    pub startup_tokens_est: usize,
    pub merkle_root_sha256: String,
    pub findings: Vec<Value>,
}

/// Input payload for [`SkillRegistry::codify_skill`] (`writing-skills` quality-gated creator).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodifySkillRequest {
    pub slug: String,
    pub description: String,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub canonical_artifacts: Vec<String>,
    pub body_md: String,
    #[serde(default)]
    pub invariants_md: Option<String>,
    #[serde(default)]
    pub dry_run: bool,
}

/// Summary report emitted after scanning a skills directory or manifest.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SkillLoadReport {
    pub loaded: usize,
    pub skipped: usize,
    pub errors: Vec<String>,
}

impl SkillLoadReport {
    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "loaded": self.loaded,
            "skipped": self.skipped,
            "errors": self.errors,
        })
    }
}

#[derive(Debug, Clone)]
struct IndexedSkill {
    meta: SkillMetadata,
    term_freqs: HashMap<String, usize>,
    doc_len: usize,
}

/// 36 Bilingual Vietnamese -> English technical synonym groups for high-recall skill & RAG routing.
const VN_EN_SYNONYMS: &[(&str, &[&str])] = &[
    ("tieng viet", &["vietnamese", "bilingual", "telex", "vni", "typo"]),
    ("go nham", &["typo", "vietnamese", "shorthand", "intent"]),
    ("telex", &["vietnamese", "telex", "vni", "typo", "bilingual"]),
    ("c++", &["cpp", "cpp20", "native", "msvc", "cmake"]),
    ("cpp", &["cpp", "cpp20", "native", "msvc", "win32"]),
    ("rust", &["rust", "cargo", "crate", "clippy", "native", "memory"]),
    ("hang doi", &["steer", "queue", "additive", "backlog"]),
    ("steer", &["steer", "queue", "additive", "supersede"]),
    ("de xuat", &["proposal", "rfc", "spec", "tradeoff"]),
    ("nghien cuu", &["research", "literature", "citation", "prisma", "evidence", "rag"]),
    ("tim kiem", &["search", "research", "rag", "bm25", "retrieval", "web"]),
    ("suy luan", &["think", "deep", "hypothesis", "falsify", "redteam", "reasoning"]),
    ("tu duy", &["think", "reasoning", "hypothesis", "analysis", "critical"]),
    ("trich dan", &["citation", "bibtex", "doi", "reference", "grounding", "evidence"]),
    ("bo nho", &["memory", "graph", "rag", "handoff", "lesson", "learn"]),
    ("bai hoc", &["lesson", "learn", "skill", "retrospective", "memory"]),
    ("ky nang", &["skill", "router", "dag", "vault", "codify"]),
    ("ban giao", &["handoff", "checkpoint", "governance", "session", "transfer"]),
    ("muc tieu", &["goal", "plan", "dod", "loop", "spec", "blueprint"]),
    ("ke hoach", &["plan", "blueprint", "spec", "goal", "todo", "tasks"]),
    ("nghiem thu", &["dod", "verify", "verifier", "audit", "receipt", "cleanroom"]),
    ("kiem chung", &["verify", "verifier", "deterministic", "audit", "test", "qa"]),
    ("don dep", &["clean", "deep-clean", "quarantine", "hygiene", "reclaim"]),
    ("do thi", &["graph", "graphify", "peer", "mesh", "orchestration", "dag"]),
    ("da tac nhan", &["swarm", "mesh", "peer", "graph", "orchestration", "agent"]),
    ("giao dien", &["ui", "design", "wcag", "contrast", "theme", "playwright", "studio"]),
    ("tuong phan", &["contrast", "wcag", "accessibility", "color", "theme"]),
    ("bao mat", &["security", "secret", "redactor", "origin", "ssrf", "loopback"]),
    ("lo bi mat", &["secret", "credential", "redactor", "leak", "audit"]),
    ("mang", &["network", "dns", "tls", "proxy", "speedtest", "bufferbloat"]),
    ("toc do mang", &["speedtest", "bufferbloat", "latency", "jitter", "network"]),
    ("dinh tuyen", &["router", "routing", "fallback", "circuit", "quota"]),
    ("tai xuong", &["download", "downloader", "range", "hls", "dash", "drive"]),
    ("so ghi chu", &["notebook", "atelier", "grounding", "citation", "source"]),
    ("bieu do", &["visualization", "chart", "plot", "figure", "matplotlib"]),
    ("bai bao", &["manuscript", "writing", "paper", "scientific", "literature", "citation"]),
];

/// Legacy skill alias resolver (`L1461`, `L1555`).
#[must_use]
pub fn resolve_skill_alias(slug: &str) -> &str {
    match slug.trim().to_ascii_lowercase().as_str() {
        "modern-tech-ui-design" => "deep-ui-modern-tech",
        "skill-router" | "omni-router" => "omni-bilingual-skill-router",
        "verifiers" | "omni-verifiers" => "omni-deterministic-verifiers",
        "handoff" | "session-governance" => "omnia-session-governance-handoff",
        "steer" => "additive-steer-queue",
        _ => slug.trim(),
    }
}

/// Thread-safe skill catalog reading `.agents/skills.json`, `SKILL.md` frontmatter,
/// `agents/openai.yaml`, and read-only Cold Vault catalogs with bilingual EN/VN BM25+fuzzy search,
/// 4-Stage DAG composition, 24 pre-wired pipelines, Merkle doctor, and quality-gated codification.
#[derive(Debug, Default)]
pub struct SkillRegistry {
    skills: Mutex<Vec<IndexedSkill>>,
    cold_vault: Mutex<Vec<ColdVaultEntry>>,
}

impl SkillRegistry {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn load_from_workspace(
        &self,
        workspace_root: &Path,
    ) -> Result<SkillLoadReport, SkillError> {
        let manifest_path = workspace_root.join(".agents").join("skills.json");
        self.load_from_manifest(workspace_root, &manifest_path)
    }

    pub fn load_from_manifest(
        &self,
        workspace_root: &Path,
        manifest_path: &Path,
    ) -> Result<SkillLoadReport, SkillError> {
        let canonical_ws = canonical_safe_dir(workspace_root)?;
        let manifest_meta = fs::symlink_metadata(manifest_path)
            .map_err(|e| SkillError::IoError(format!("{}: {e}", manifest_path.display())))?;
        if is_symlink_or_reparse(&manifest_meta) || !is_within_root(&canonical_ws, manifest_path) {
            return Err(SkillError::UnsafePath(manifest_path.display().to_string()));
        }
        let raw = fs::read_to_string(manifest_path)
            .map_err(|e| SkillError::IoError(format!("{}: {e}", manifest_path.display())))?;
        let cleaned = raw.strip_prefix('\u{FEFF}').unwrap_or(&raw);
        let parsed: Value = serde_json::from_str(cleaned)
            .map_err(|e| SkillError::InvalidManifest(e.to_string()))?;
        let Some(entries) = parsed.get("entries").and_then(Value::as_array) else {
            return Err(SkillError::InvalidManifest(
                "missing array field `entries`".to_owned(),
            ));
        };

        let mut total_report = SkillLoadReport::default();
        for entry in entries {
            let Some(rel) = entry.get("path").and_then(Value::as_str) else {
                total_report
                    .errors
                    .push("manifest entry missing string `path`".to_owned());
                total_report.skipped += 1;
                continue;
            };
            let rel_trimmed = rel.trim();
            if rel_trimmed.is_empty() || Path::new(rel_trimmed).is_absolute() {
                total_report
                    .errors
                    .push(format!("unsafe manifest path `{rel_trimmed}`"));
                total_report.skipped += 1;
                continue;
            }
            let dir_path = workspace_root.join(rel_trimmed);
            if !is_within_root(&canonical_ws, &dir_path) {
                total_report.errors.push(format!(
                    "manifest path `{rel_trimmed}` escapes workspace root"
                ));
                total_report.skipped += 1;
                continue;
            }
            let sub = self.load_from_directory(&dir_path)?;
            total_report.loaded += sub.loaded;
            total_report.skipped += sub.skipped;
            total_report.errors.extend(sub.errors);
        }
        Ok(total_report)
    }

    pub fn load_from_directory(&self, dir: &Path) -> Result<SkillLoadReport, SkillError> {
        let canonical_root = canonical_safe_dir(dir)?;
        let rd = fs::read_dir(&canonical_root)
            .map_err(|e| SkillError::IoError(format!("{}: {e}", dir.display())))?;

        let mut child_dirs: Vec<PathBuf> = rd.flatten().map(|e| e.path()).collect();
        child_dirs.sort();

        let mut report = SkillLoadReport::default();
        let mut loaded_items = Vec::new();

        for child in child_dirs {
            if loaded_items.len() >= MAX_SKILLS_PER_ROOT {
                report.skipped += 1;
                report
                    .errors
                    .push(format!("skill root limit ({MAX_SKILLS_PER_ROOT}) reached"));
                break;
            }
            let Ok(child_meta) = fs::symlink_metadata(&child) else {
                report.skipped += 1;
                continue;
            };
            if is_symlink_or_reparse(&child_meta) || !child_meta.is_dir() {
                report.skipped += 1;
                continue;
            }
            if !is_within_root(&canonical_root, &child) {
                report.skipped += 1;
                report
                    .errors
                    .push(format!("containment rejected {}", child.display()));
                continue;
            }

            let skill_md = child.join("SKILL.md");
            let Ok(md_meta) = fs::symlink_metadata(&skill_md) else {
                report.skipped += 1;
                continue;
            };
            if is_symlink_or_reparse(&md_meta)
                || !md_meta.is_file()
                || md_meta.len() > MAX_SKILL_FILE_BYTES
                || !is_within_root(&canonical_root, &skill_md)
            {
                report.skipped += 1;
                continue;
            }

            let Ok(bytes) = fs::read(&skill_md) else {
                report.skipped += 1;
                continue;
            };
            let digest = sha256_hex(&bytes);
            let text = omnia_core::sanitize_utf8_lossy(&bytes);
            let stripped = text.strip_prefix('\u{FEFF}').unwrap_or(&text);
            let Some(fm) = parse_frontmatter_full(stripped) else {
                report.skipped += 1;
                report.errors.push(format!(
                    "missing valid YAML frontmatter in {}",
                    skill_md.display()
                ));
                continue;
            };
            let fallback_name = child
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
            let name = if fm.name.is_empty() {
                fallback_name
            } else {
                fm.name
            };
            let description = truncate_utf8_codepoints(&fm.description, MAX_DESCRIPTION_CODEPOINTS);
            let openai_interface = load_openai_yaml(&canonical_root, &child);

            let meta = SkillMetadata {
                name,
                description,
                path: child.to_string_lossy().replace('\\', "/"),
                openai_interface,
                category: fm.category,
                canonical_artifacts: fm.canonical_artifacts,
                sha256: digest,
                frontmatter_tokens: fm.frontmatter_tokens,
                body_tokens: fm.body_tokens,
                has_5phase_headers: fm.has_5phase_headers,
            };
            loaded_items.push(build_indexed_skill(meta));
            report.loaded += 1;
        }

        let mut guard = self
            .skills
            .lock()
            .map_err(|_| SkillError::InternalLockPoisoned)?;
        for item in loaded_items {
            if let Some(pos) = guard.iter().position(|s| s.meta.name == item.meta.name) {
                guard[pos] = item;
            } else {
                guard.push(item);
            }
        }
        guard.sort_by(|a, b| a.meta.name.cmp(&b.meta.name));
        Ok(report)
    }

    /// Read-only Cold Vault loader scanning external JSON catalogs (`omni-deep-1000-catalog.json`,
    /// `SKILL_INDEX.json`) or vault directories (`omni-vault/`) with zero startup token bloat.
    pub fn load_cold_vault_catalog(&self, paths: &[&Path]) -> usize {
        let mut entries: Vec<ColdVaultEntry> = Vec::new();
        let mut seen: BTreeSet<String> = BTreeSet::new();

        for path in paths {
            if path.is_file() {
                if let Ok(raw) = fs::read_to_string(path) {
                    if let Ok(val) = serde_json::from_str::<Value>(raw.trim_start_matches('\u{FEFF}'))
                    {
                        parse_catalog_json_into(&val, path, &mut seen, &mut entries);
                    }
                }
            } else if path.is_dir() {
                let idx_json = path.join("SKILL_INDEX.json");
                if idx_json.is_file() {
                    if let Ok(raw) = fs::read_to_string(&idx_json) {
                        if let Ok(val) =
                            serde_json::from_str::<Value>(raw.trim_start_matches('\u{FEFF}'))
                        {
                            parse_catalog_json_into(&val, &idx_json, &mut seen, &mut entries);
                        }
                    }
                }
                let skills_sub = if path.join("skills").is_dir() {
                    path.join("skills")
                } else {
                    path.to_path_buf()
                };
                if let Ok(rd) = fs::read_dir(&skills_sub) {
                    for ent in rd.flatten().take(1_500) {
                        let p = ent.path();
                        if !p.is_dir() {
                            continue;
                        }
                        let slug = p
                            .file_name()
                            .map(|s| s.to_string_lossy().into_owned())
                            .unwrap_or_default();
                        if slug.is_empty() || !seen.insert(slug.clone()) {
                            continue;
                        }
                        let skill_md = p.join("SKILL.md");
                        let focus = fs::read_to_string(&skill_md)
                            .ok()
                            .and_then(|s| parse_frontmatter_full(s.trim_start_matches('\u{FEFF}')))
                            .map(|fm| fm.description)
                            .unwrap_or_else(|| slug.replace('-', " "));
                        entries.push(ColdVaultEntry {
                            slug,
                            category_id: "vault".into(),
                            category: "Cold Vault".into(),
                            focus,
                            canonical_artifacts: Vec::new(),
                            source: skills_sub.to_string_lossy().replace('\\', "/"),
                            path: Some(skill_md.to_string_lossy().replace('\\', "/")),
                        });
                    }
                }
            }
        }

        let count = entries.len();
        if let Ok(mut guard) = self.cold_vault.lock() {
            *guard = entries;
        }
        count
    }

    /// Loads default external cold vault catalogs if present on disk.
    pub fn load_default_cold_vault(&self) -> usize {
        let paths: Vec<&Path> = DEFAULT_COLD_VAULT_PATHS.iter().map(Path::new).collect();
        self.load_cold_vault_catalog(&paths)
    }

    #[must_use]
    pub fn cold_vault_entries(&self) -> Vec<ColdVaultEntry> {
        self.cold_vault
            .lock()
            .map(|g| g.clone())
            .unwrap_or_default()
    }

    pub fn list_skills(&self) -> Result<Vec<SkillMetadata>, SkillError> {
        let guard = self
            .skills
            .lock()
            .map_err(|_| SkillError::InternalLockPoisoned)?;
        Ok(guard.iter().map(|s| s.meta.clone()).collect())
    }

    pub fn search(&self, query: &str, top_k: usize) -> Result<Vec<SkillMatch>, SkillError> {
        let guard = self
            .skills
            .lock()
            .map_err(|_| SkillError::InternalLockPoisoned)?;
        if guard.is_empty() || query.trim().is_empty() || top_k == 0 {
            return Ok(Vec::new());
        }

        let alias_target = resolve_skill_alias(query).to_ascii_lowercase();
        let direct_terms = tokenize_folded(query);
        let query_terms = expand_skill_query_terms(query);
        if query_terms.is_empty() {
            return Ok(Vec::new());
        }

        let n_docs = guard.len() as f64;
        let avgdl = (guard.iter().map(|d| d.doc_len).sum::<usize>() as f64 / n_docs).max(1.0);
        let k1 = 1.2_f64;
        let b = 0.75_f64;

        let mut doc_freq: HashMap<&str, usize> = HashMap::new();
        for term in &query_terms {
            let df = guard
                .iter()
                .filter(|doc| doc.term_freqs.contains_key(term.as_str()))
                .count();
            doc_freq.insert(term.as_str(), df);
        }

        let mut results = Vec::new();
        for doc in guard.iter() {
            let mut score = 0.0_f64;
            let mut matched = Vec::new();
            let dl = doc.doc_len as f64;
            let folded_name = fold_vietnamese_ascii(&doc.meta.name);

            if folded_name == alias_target {
                score += 8.0;
                matched.push(alias_target.clone());
            }

            for term in &query_terms {
                let mut tf = doc.term_freqs.get(term.as_str()).copied().unwrap_or(0) as f64;
                if tf == 0.0
                    && term.len() >= 5
                    && doc
                        .term_freqs
                        .keys()
                        .any(|k| k.len() >= 5 && levenshtein_bounded(term, k, 1) <= 1)
                {
                    tf = 0.6;
                }
                if tf <= 0.0 {
                    continue;
                }
                matched.push(term.clone());
                let df = doc_freq.get(term.as_str()).copied().unwrap_or(0) as f64;
                let idf = ((n_docs - df + 0.5) / (df + 0.5) + 1.0).ln();
                let denom = tf + k1 * (1.0 - b + b * (dl / avgdl));
                let weight = if direct_terms.contains(term) { 2.0 } else { 1.0 };
                score += weight * idf * ((tf * (k1 + 1.0)) / denom.max(1e-9));
            }
            if score > 0.0 {
                let slug_hits = query_terms
                    .iter()
                    .filter(|t| folded_name.contains(t.as_str()))
                    .count();
                if slug_hits > 0 {
                    score += 2.2 * (slug_hits as f64).min(3.0);
                }
                results.push(SkillMatch {
                    skill: doc.meta.clone(),
                    score,
                    matched_terms: matched,
                });
            }
        }

        results.sort_by(|a, b| {
            b.score
                .total_cmp(&a.score)
                .then_with(|| a.skill.name.cmp(&b.skill.name))
        });
        results.truncate(top_k);
        Ok(results)
    }

    /// Searches active workspace skills + optional read-only Cold Vault entries (`1,001`-skill catalog).
    #[must_use]
    pub fn search_with_vault(&self, query: &str, limit: usize, include_vault: bool) -> Value {
        let cap = limit.clamp(1, 50);
        let active_matches = self.search(query, cap).unwrap_or_default();
        let mut vault_matches = Vec::new();
        if include_vault && !query.trim().is_empty() {
            let direct = tokenize_folded(query);
            let expanded = expand_skill_query_terms(query);
            let alias = resolve_skill_alias(query).to_ascii_lowercase();
            let vault = self.cold_vault_entries();
            let mut scored: Vec<(f64, ColdVaultEntry)> = Vec::new();
            for entry in vault {
                let slug_f = fold_vietnamese_ascii(&entry.slug);
                let bag = fold_vietnamese_ascii(&format!(
                    "{} {} {} {}",
                    entry.slug,
                    entry.category,
                    entry.focus,
                    entry.canonical_artifacts.join(" ")
                ));
                let mut sc = if slug_f == alias { 10.0 } else { 0.0 };
                for tok in &expanded {
                    if slug_f.contains(tok.as_str()) {
                        sc += if direct.contains(tok) { 3.5 } else { 2.0 };
                    } else if bag.contains(tok.as_str()) {
                        sc += if direct.contains(tok) { 1.8 } else { 0.9 };
                    }
                }
                if sc > 0.0 {
                    scored.push((sc, entry));
                }
            }
            scored.sort_by(|a, b| b.0.total_cmp(&a.0).then_with(|| a.1.slug.cmp(&b.1.slug)));
            for (sc, e) in scored.into_iter().take(cap) {
                vault_matches.push(json!({
                    "entry": e,
                    "score": (sc * 100.0).round() / 100.0,
                }));
            }
        }
        json!({
            "query": query,
            "matches": active_matches.iter().map(SkillMatch::to_json).collect::<Vec<_>>(),
            "vaultMatches": vault_matches,
            "activeTotal": self.list_skills().map(|v| v.len()).unwrap_or(0),
            "vaultTotal": self.cold_vault_entries().len(),
        })
    }

    /// Composes a deterministic 4-Stage Execution DAG (`stage_1_preflight_framing` ->
    /// `stage_2_domain_execution` -> `stage_3_verification_gate` -> `stage_4_receipt_handoff`).
    #[must_use]
    pub fn compose_4stage_dag(&self, query: &str, max_per_stage: usize) -> Value {
        let cap = max_per_stage.clamp(1, 6);
        let active = self.search(query, cap * 3).unwrap_or_default();
        let mut s2: Vec<String> = active
            .iter()
            .map(|m| m.skill.name.clone())
            .filter(|n| {
                !matches!(
                    n.as_str(),
                    "omnia-session-governance-handoff" | "omni-deterministic-verifiers"
                )
            })
            .take(cap)
            .collect();
        if s2.is_empty() {
            s2.push("goal-plan-loop-dod".into());
        }
        let stages = vec![
            ExecutionDagStage {
                stage: "stage_1_preflight_framing".into(),
                skills: vec![
                    "omnia-session-governance-handoff".into(),
                    "omni-bilingual-skill-router".into(),
                ],
                purpose: "Hydrate workspace GOAL/DOD/CHECKPOINT/HANDOFF, lock scope & additive steer queue.".into(),
            },
            ExecutionDagStage {
                stage: "stage_2_domain_execution".into(),
                skills: s2,
                purpose: format!("Execute domain-specific engineering/research workflow for: `{}`", query.trim()),
            },
            ExecutionDagStage {
                stage: "stage_3_verification_gate".into(),
                skills: vec!["omni-deterministic-verifiers".into()],
                purpose: "Run machine verifiers (UTF-8 LF, SHA-256, secrets, WCAG contrast, citation integrity, live tests).".into(),
            },
            ExecutionDagStage {
                stage: "stage_4_receipt_handoff".into(),
                skills: vec![
                    "omnia-session-governance-handoff".into(),
                    "autonomous-power-continuity".into(),
                ],
                purpose: "Emit 6-state completion receipt, update HANDOFF/lessons, and promote verified skills.".into(),
            },
        ];
        json!({
            "query": query,
            "stages": stages,
        })
    }

    /// Returns the 24 pre-wired Rust-native multi-skill DAG pipelines (`L4475..4626`).
    #[must_use]
    pub fn pipelines(&self) -> Vec<PipelineSpec> {
        default_24_pipelines()
    }

    /// Runs structural & token-ceiling hygiene doctor (`<=110` frontmatter tok, `<=3500` body tok,
    /// SHA-256 Merkle attestation root).
    #[must_use]
    pub fn doctor(&self) -> SkillDoctorReport {
        let skills = self.list_skills().unwrap_or_default();
        let cold_count = self.cold_vault_entries().len();
        let mut findings = Vec::new();
        let mut startup_tokens = 0usize;
        let mut merkle_input = String::new();

        for sk in &skills {
            startup_tokens += sk.frontmatter_tokens.max(12);
            merkle_input.push_str(&sk.name);
            merkle_input.push(':');
            merkle_input.push_str(&sk.sha256);
            merkle_input.push('\n');

            if sk.frontmatter_tokens > 110 {
                findings.push(json!({
                    "skill": sk.name,
                    "severity": "warn",
                    "code": "frontmatter_token_budget_exceeded",
                    "detail": format!("{} tokens > 110 ceiling", sk.frontmatter_tokens),
                }));
            }
            if sk.body_tokens > 3_500 {
                findings.push(json!({
                    "skill": sk.name,
                    "severity": "warn",
                    "code": "body_token_budget_exceeded",
                    "detail": format!("{} tokens > 3500 progressive-disclosure ceiling", sk.body_tokens),
                }));
            }
            if sk.description.trim().is_empty() {
                findings.push(json!({
                    "skill": sk.name,
                    "severity": "error",
                    "code": "empty_description",
                    "detail": "SKILL.md frontmatter description is empty",
                }));
            }
        }
        let ok = !findings.iter().any(|f| f["severity"] == "error");
        SkillDoctorReport {
            ok,
            total_skills: skills.len(),
            cold_vault_count: cold_count,
            startup_tokens_est: startup_tokens,
            merkle_root_sha256: sha256_hex(merkle_input.as_bytes()),
            findings,
        }
    }

    /// Quality-gated atomic skill codifier (`writing-skills` + `workflow_skill_creator` rules):
    /// enforces `"Use when..."` trigger description, `<90`/`<3500` token ceilings, semantic overlap check,
    /// and writes atomic UTF-8 LF `SKILL.md` + `references/invariants.md` + `templates/receipt.template.md`.
    pub fn codify_skill(
        &self,
        workspace_root: &Path,
        req: &CodifySkillRequest,
    ) -> Result<Value, String> {
        let slug = req.slug.trim().to_ascii_lowercase();
        if slug.is_empty()
            || slug.len() > 64
            || !slug
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        {
            return Err("skill slug must be lowercase [a-z0-9-] (1..=64 chars)".into());
        }
        let desc = req.description.trim();
        if !desc.to_ascii_lowercase().starts_with("use when") {
            return Err(
                "skill description must start with `Use when...` (trigger-only discipline, no workflow summary leak)"
                    .into(),
            );
        }
        let fm_tokens = (slug.len() + desc.len() + req.category.len()).div_ceil(4);
        let body_tokens = req.body_md.len().div_ceil(4);
        if fm_tokens > 110 {
            return Err(format!("frontmatter exceeds 110 token budget ({fm_tokens} tok)"));
        }
        if body_tokens > 3_500 {
            return Err(format!("SKILL.md body exceeds 3,500 token budget ({body_tokens} tok)"));
        }

        // Semantic overlap check against existing skills (`deep-omni-conflict-deduplicator`).
        let existing = self.search(&format!("{slug} {desc}"), 3).unwrap_or_default();
        let overlap_candidates: Vec<String> = existing
            .iter()
            .filter(|m| m.skill.name != slug && m.score >= 5.0)
            .map(|m| m.skill.name.clone())
            .collect();

        let artifacts_json =
            serde_json::to_string(&req.canonical_artifacts).unwrap_or_else(|_| "[]".into());
        let category = if req.category.trim().is_empty() {
            "Omnia Learned Skill"
        } else {
            req.category.trim()
        };
        let skill_md = format!(
            "---\nname: {slug}\ndescription: >-\n  {desc}\nversion: \"1.0.0\"\ncategory: \"{category}\"\ncanonical_artifacts: {artifacts_json}\n---\n\n{}\n",
            req.body_md.replace("\r\n", "\n").replace('\r', "\n").trim()
        );
        let sha = sha256_hex(skill_md.as_bytes());

        if req.dry_run {
            return Ok(json!({
                "ok": true,
                "dryRun": true,
                "slug": slug,
                "sha256": sha,
                "frontmatterTokens": fm_tokens,
                "bodyTokens": body_tokens,
                "overlapCandidates": overlap_candidates,
            }));
        }

        let skill_dir = workspace_root.join(".agents").join("skills").join(&slug);
        atomic_write_with_retry(&skill_dir.join("SKILL.md"), skill_md.as_bytes())?;
        if let Some(inv) = &req.invariants_md {
            let inv_lf = format!("{}\n", inv.replace("\r\n", "\n").replace('\r', "\n").trim());
            atomic_write_with_retry(
                &skill_dir.join("references").join("invariants.md"),
                inv_lf.as_bytes(),
            )?;
        }
        let receipt_tpl = format!(
            "# Execution Receipt — `{slug}`\n\n- **Verified**: `<runtime-proven>`\n- **Partial**: `<subset>`\n- **Unresolved**: `<open>`\n- **Blocked**: `<external>`\n- **Next**: `<next-atomic-step>`\n- **Exact Practical Limits**: `<constraints>`\n"
        );
        atomic_write_with_retry(
            &skill_dir.join("templates").join("receipt.template.md"),
            receipt_tpl.as_bytes(),
        )?;
        let _ = self.load_from_directory(&workspace_root.join(".agents").join("skills"));

        Ok(json!({
            "ok": true,
            "dryRun": false,
            "slug": slug,
            "path": skill_dir.join("SKILL.md").to_string_lossy().replace('\\', "/"),
            "sha256": sha,
            "frontmatterTokens": fm_tokens,
            "bodyTokens": body_tokens,
            "overlapCandidates": overlap_candidates,
        }))
    }
}

fn parse_catalog_json_into(
    val: &Value,
    source_path: &Path,
    seen: &mut BTreeSet<String>,
    out: &mut Vec<ColdVaultEntry>,
) {
    let mut cat_titles: HashMap<String, String> = HashMap::new();
    if let Some(cats) = val.get("categories_100").and_then(Value::as_array) {
        for c in cats {
            if let (Some(id), Some(title)) = (
                c.get("id")
                    .or_else(|| c.get("category_id"))
                    .and_then(Value::as_str),
                c.get("title")
                    .or_else(|| c.get("name"))
                    .or_else(|| c.get("title_en"))
                    .and_then(Value::as_str),
            ) {
                cat_titles.insert(id.to_string(), title.to_string());
            }
        }
    }
    let arr = val
        .get("skills_catalog")
        .and_then(Value::as_array)
        .or_else(|| val.get("skills").and_then(Value::as_array))
        .or_else(|| val.as_array());
    let Some(items) = arr else {
        return;
    };
    let src_str = source_path.to_string_lossy().replace('\\', "/");
    for item in items {
        let Some(slug) = item
            .get("slug")
            .or_else(|| item.get("name"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        else {
            continue;
        };
        if !seen.insert(slug.to_string()) {
            continue;
        }
        let category_id = item
            .get("category_id")
            .or_else(|| item.get("cat_id"))
            .and_then(Value::as_str)
            .unwrap_or("00")
            .to_string();
        let category = item
            .get("category")
            .or_else(|| item.get("category_title"))
            .and_then(Value::as_str)
            .map(ToString::to_string)
            .or_else(|| cat_titles.get(&category_id).cloned())
            .unwrap_or_else(|| "General".to_string());
        let focus_en = item
            .get("focus_en")
            .or_else(|| item.get("focus"))
            .or_else(|| item.get("description"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let desc_vi = item
            .get("description_vi")
            .and_then(Value::as_str)
            .unwrap_or("");
        let focus = match (focus_en.trim().is_empty(), desc_vi.trim().is_empty()) {
            (false, false) => format!("{} — {}", focus_en.trim(), desc_vi.trim()),
            (false, true) => focus_en.trim().to_string(),
            (true, false) => desc_vi.trim().to_string(),
            (true, true) => slug.replace('-', " "),
        };
        let artifacts = item
            .get("canonical_artifacts")
            .or_else(|| item.get("artifacts"))
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(ToString::to_string)
                    .collect()
            })
            .unwrap_or_default();
        let path = item
            .get("path")
            .and_then(Value::as_str)
            .map(ToString::to_string);
        out.push(ColdVaultEntry {
            slug: slug.to_string(),
            category_id,
            category,
            focus,
            canonical_artifacts: artifacts,
            source: src_str.clone(),
            path,
        });
    }
}

fn expand_skill_query_terms(query: &str) -> BTreeSet<String> {
    let mut terms = tokenize_folded(query);
    let alias = resolve_skill_alias(query);
    if alias != query.trim() {
        for tok in tokenize_folded(alias) {
            terms.insert(tok);
        }
    }
    let folded = format!(" {} ", fold_vietnamese_ascii(query));
    for (needle, extras) in VN_EN_SYNONYMS {
        if folded.contains(needle) {
            for extra in *extras {
                terms.insert((*extra).to_owned());
            }
        }
    }
    terms
}

fn build_indexed_skill(meta: SkillMetadata) -> IndexedSkill {
    let mut bag = format!(
        "{} {} {} {} {}",
        meta.name,
        meta.name,
        meta.description,
        meta.category,
        meta.canonical_artifacts.join(" ")
    );
    if let Some(iface) = &meta.openai_interface {
        bag.push(' ');
        bag.push_str(&iface.display_name);
        bag.push(' ');
        bag.push_str(&iface.short_description);
        bag.push(' ');
        bag.push_str(&iface.default_prompt);
    }
    let folded = fold_vietnamese_ascii(&bag);
    let mut term_freqs: HashMap<String, usize> = HashMap::new();
    let mut doc_len = 0usize;
    let mut cur = String::new();
    for ch in folded.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
            cur.push(ch);
        } else if !cur.is_empty() {
            if cur.len() >= 2 {
                *term_freqs.entry(std::mem::take(&mut cur)).or_insert(0) += 1;
                doc_len += 1;
            } else {
                cur.clear();
            }
        }
    }
    if cur.len() >= 2 {
        *term_freqs.entry(cur).or_insert(0) += 1;
        doc_len += 1;
    }
    IndexedSkill {
        meta,
        term_freqs,
        doc_len,
    }
}

struct ParsedFrontmatter {
    name: String,
    description: String,
    category: String,
    canonical_artifacts: Vec<String>,
    frontmatter_tokens: usize,
    body_tokens: usize,
    has_5phase_headers: bool,
}

fn parse_frontmatter_full(content: &str) -> Option<ParsedFrontmatter> {
    let mut lines = content.lines();
    if lines.next()?.trim() != "---" {
        return None;
    }
    let mut fm_lines = Vec::new();
    let mut closed = false;
    let mut body_chars = 0usize;
    let mut body_acc = String::new();
    for line in lines {
        if !closed && line.trim() == "---" {
            closed = true;
            continue;
        }
        if !closed {
            fm_lines.push(line);
        } else {
            body_chars += line.len() + 1;
            if body_acc.len() < 4096 {
                body_acc.push_str(line);
                body_acc.push('\n');
            }
        }
    }
    if !closed {
        return None;
    }
    let name = extract_yaml_scalar(&fm_lines, "name").unwrap_or_default();
    let desc = extract_yaml_scalar(&fm_lines, "description").unwrap_or_default();
    if desc.is_empty() && name.is_empty() {
        return None;
    }
    let category = extract_yaml_scalar(&fm_lines, "category").unwrap_or_default();
    let canonical_artifacts = extract_yaml_scalar(&fm_lines, "canonical_artifacts")
        .and_then(|raw| serde_json::from_str::<Vec<String>>(&raw).ok())
        .unwrap_or_default();
    let fm_chars: usize = fm_lines.iter().map(|l| l.len() + 1).sum();
    let body_low = body_acc.to_ascii_lowercase();
    let has_5phase_headers = body_low.contains("phase 0")
        || body_low.contains("## purpose")
        || body_low.contains("verification");
    Some(ParsedFrontmatter {
        name,
        description: desc,
        category,
        canonical_artifacts,
        frontmatter_tokens: fm_chars.div_ceil(4),
        body_tokens: body_chars.div_ceil(4),
        has_5phase_headers,
    })
}

fn load_openai_yaml(canonical_root: &Path, skill_dir: &Path) -> Option<OpenAiSkillInterface> {
    let agents_dir = skill_dir.join("agents");
    let yaml_path = agents_dir.join("openai.yaml");
    let dir_meta = fs::symlink_metadata(&agents_dir).ok()?;
    if is_symlink_or_reparse(&dir_meta) || !dir_meta.is_dir() {
        return None;
    }
    let file_meta = fs::symlink_metadata(&yaml_path).ok()?;
    if is_symlink_or_reparse(&file_meta)
        || !file_meta.is_file()
        || file_meta.len() > MAX_SKILL_FILE_BYTES
        || !is_within_root(canonical_root, &yaml_path)
    {
        return None;
    }
    let bytes = fs::read(&yaml_path).ok()?;
    let text = omnia_core::sanitize_utf8_lossy(&bytes);
    let stripped = text.strip_prefix('\u{FEFF}').unwrap_or(&text);
    let lines: Vec<&str> = stripped.lines().collect();
    let display_name = extract_yaml_scalar(&lines, "display_name").unwrap_or_default();
    let short_description = extract_yaml_scalar(&lines, "short_description").unwrap_or_default();
    let default_prompt = extract_yaml_scalar(&lines, "default_prompt").unwrap_or_default();
    if display_name.is_empty() && short_description.is_empty() && default_prompt.is_empty() {
        return None;
    }
    Some(OpenAiSkillInterface {
        display_name,
        short_description,
        default_prompt,
    })
}

fn extract_yaml_scalar(lines: &[&str], key: &str) -> Option<String> {
    let prefix = format!("{key}:");
    let mut idx = 0usize;
    while idx < lines.len() {
        let trimmed = lines[idx].trim_start();
        if let Some(after) = trimmed.strip_prefix(&prefix) {
            let val = after.trim();
            if matches!(val, ">" | "|-" | "|" | ">-") {
                let mut parts = Vec::new();
                idx += 1;
                while idx < lines.len() {
                    let next = lines[idx];
                    if !next.trim().is_empty() && !next.starts_with(' ') && !next.starts_with('\t')
                    {
                        break;
                    }
                    let t = next.trim();
                    if !t.is_empty() {
                        parts.push(t);
                    }
                    idx += 1;
                }
                return Some(parts.join(" "));
            }
            return Some(unquote_yaml_scalar(val));
        }
        idx += 1;
    }
    None
}

fn unquote_yaml_scalar(raw: &str) -> String {
    let s = raw.trim();
    if s.len() >= 2
        && ((s.starts_with('"') && s.ends_with('"')) || (s.starts_with('\'') && s.ends_with('\'')))
    {
        return s[1..s.len() - 1].replace("\\\"", "\"").replace("\\'", "'");
    }
    s.to_owned()
}

fn is_symlink_or_reparse(meta: &fs::Metadata) -> bool {
    if meta.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if (meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT) != 0 {
            return true;
        }
    }
    false
}

fn canonical_safe_dir(dir: &Path) -> Result<PathBuf, SkillError> {
    let meta = fs::symlink_metadata(dir)
        .map_err(|e| SkillError::IoError(format!("{}: {e}", dir.display())))?;
    if is_symlink_or_reparse(&meta) || !meta.is_dir() {
        return Err(SkillError::UnsafePath(dir.display().to_string()));
    }
    fs::canonicalize(dir).map_err(|e| SkillError::IoError(format!("{}: {e}", dir.display())))
}

fn strip_verbatim(p: &Path) -> String {
    let raw = p.to_string_lossy().replace('\\', "/");
    if let Some(rest) = raw.strip_prefix("//?/UNC/") {
        format!("//{rest}")
    } else if let Some(rest) = raw.strip_prefix("//?/") {
        rest.to_owned()
    } else {
        raw
    }
}

fn is_within_root(canonical_root: &Path, candidate: &Path) -> bool {
    let Ok(canon_cand) = fs::canonicalize(candidate) else {
        return false;
    };
    let root_str = strip_verbatim(canonical_root);
    let cand_str = strip_verbatim(&canon_cand);
    #[cfg(windows)]
    let (r, c) = (root_str.to_ascii_lowercase(), cand_str.to_ascii_lowercase());
    #[cfg(not(windows))]
    let (r, c) = (root_str, cand_str);
    r == c || (c.starts_with(&r) && c.as_bytes().get(r.len()) == Some(&b'/'))
}

fn mk_pipeline(id: &str, title: &str, category: &str, desc: &str, s2: &[&str]) -> PipelineSpec {
    PipelineSpec {
        id: id.into(),
        title: title.into(),
        category: category.into(),
        description: desc.into(),
        stages: vec![
            ExecutionDagStage {
                stage: "stage_1_preflight_framing".into(),
                skills: vec!["omnia-session-governance-handoff".into()],
                purpose: "Hydrate governance contracts and lock disjoint scope".into(),
            },
            ExecutionDagStage {
                stage: "stage_2_domain_execution".into(),
                skills: s2.iter().map(|s| (*s).to_string()).collect(),
                purpose: desc.into(),
            },
            ExecutionDagStage {
                stage: "stage_3_verification_gate".into(),
                skills: vec!["omni-deterministic-verifiers".into()],
                purpose: "Run machine-checked verification gates".into(),
            },
            ExecutionDagStage {
                stage: "stage_4_receipt_handoff".into(),
                skills: vec!["autonomous-power-continuity".into()],
                purpose: "Emit 6-state completion receipt and persist lessons".into(),
            },
        ],
    }
}

fn default_24_pipelines() -> Vec<PipelineSpec> {
    vec![
        mk_pipeline("omnia-deep-research", "Omnia Deep Research + Citations", "Research", "6-stage web/academic search, persistent RAG, [S###]/[G###] citations, Sources ledger", &["deep-research", "kdense-literature-review", "kdense-citation-management"]),
        mk_pipeline("omnia-deep-think", "Omnia Deep Think + Red-Team", "Reasoning", "Formal invariants, >=3 branches, executable falsification, distinct-family red-team", &["deep-think", "kdense-scientific-critical-thinking"]),
        mk_pipeline("omnia-workspace-governance", "Workspace 12-Artifact Lifecycle", "Governance", "Synchronize Goal, Spec, Blueprint, Plan, Todo, DoD, Progress, Handoff", &["goal-plan-loop-dod", "omnia-session-governance-handoff", "additive-steer-queue"]),
        mk_pipeline("omnia-rust-flagship-studio", "Full Native Rust Flagship Studio", "Engineering", "17-crate Rust workspace, Studio API, SolidJS ui-v5, Win32 Mica native QA", &["autonomous-power-continuity", "deep-general-graph-orchestration"]),
        mk_pipeline("omnia-memory-learn-evolve", "2-Tier Memory & Auto-Learn", "Knowledge", "Capture lessons, deduplicate semantic overlap, codify atomic skills", &["autonomous-power-continuity", "omni-bilingual-skill-router"]),
        mk_pipeline("triple-audit-release", "3-Round Cleanroom Release Gate", "QA", "Frozen snapshot, isolated clean clone, 3 consecutive zero-defect rounds", &["omni-deterministic-verifiers", "omnia-session-governance-handoff"]),
        mk_pipeline("q1-scientific-paper", "Q1 Scientific Manuscript & Figures", "Science", "Systematic review, citation verification, publication figures, manuscript draft", &["kdense-literature-review", "kdense-scientific-writing", "kdense-scientific-visualization", "kdense-citation-management"]),
        mk_pipeline("rfc-architecture-proposal", "Rigorous Engineering RFC / Proposal", "Architecture", "Multi-option tradeoff matrix, falsifiable hypotheses, rollback gates", &["deep-proposal", "deep-think"]),
        mk_pipeline("peer-mesh-swarm-delivery", "2-Way All-to-All Peer-Mesh Swarm", "Orchestration", "Disjoint ownership graph, duplex handoffs, independent verifier audit", &["deep-general-graph-orchestration", "autonomous-power-continuity"]),
        mk_pipeline("bilingual-vn-en-intent", "Bilingual Vietnamese-English Intent", "Language", "Normalize VNI/Telex/QWERTY typos without mutating code or paths", &["vietnamese-typo-intent-inference", "omni-bilingual-skill-router"]),
        mk_pipeline("repo-deep-clean-reclaim", "Safe Repository & Drive Deep Clean", "Operations", "Inventory, provenance, quarantine, reparse guards, physical reclaim receipt", &["deep-clean", "omni-deterministic-verifiers"]),
        mk_pipeline("codex-mcp-triage", "Codex MCP & Namespace Repair", "Diagnostics", "Diagnose SSE namespace stripping, cold-start timeouts, logs_2.sqlite warnings", &["codex-mcp-namespace-diagnostics"]),
        mk_pipeline("native-win32-cpp-rust", "Windows 11 Native UIA & DWM", "Native", "Out-of-source builds, winsqlite3 WAL leases, DWM Mica, COM UIA 112/114", &["deep-cpp-native", "omni-deterministic-verifiers"]),
        mk_pipeline("additive-steer-reconcile", "Additive Steer Queue Reconciliation", "Continuity", "Zero-drop queue intake, conflict reconciliation, unset token_budget", &["additive-steer-queue", "deep-steer"]),
        mk_pipeline("network-observatory-qa", "Network & Bufferbloat Telemetry QA", "Network", "NIC inventory, DNS benchmark, TLS waterfall, loaded bufferbloat A+..F", &["omni-deterministic-verifiers", "autonomous-power-continuity"]),
        mk_pipeline("ai-router-lab-audit", "Dynamic Provider Router Audit", "Routing", "Deterministic scoring, circuit breakers, quota honesty, redacted receipts", &["deep-proposal", "omni-deterministic-verifiers"]),
        mk_pipeline("atelier-notebook-grounding", "Atelier Notebook Grounded Q&A", "Research", "6-stage ingestion, BM25F grounding, strict citation verifier, Quote+BTW", &["kdense-citation-management", "deep-research"]),
        mk_pipeline("omnidrive-protocol-qa", "OmniDrive 128-Chunk Protocol QA", "Media", "Byte-Range probe, CRC32C, OMNF journal, ISO-BMFF, 3-gram SchemaDrift", &["omni-deterministic-verifiers"]),
        mk_pipeline("scientific-ideation-loop", "Adversarial Scientific Brainstorming", "Science", "Independent ideation, explicit assumptions, critical appraisal, decision log", &["kdense-scientific-brainstorming", "kdense-scientific-critical-thinking"]),
        mk_pipeline("security-secret-hardening", "Zero-Secret & Loopback Hardening", "Security", "Origin/Host/Sec-Fetch-Site 403, RFC 9110 cookies, secret scan, privacy mask", &["omni-deterministic-verifiers"]),
        mk_pipeline("benchmark-cleanroom-eval", "Coding-Agent Benchmark Evaluation", "Benchmarks", "Multi-axis tasks, Wilson CI, McNemar test, zero-leak trace audit", &["kdense-scientific-critical-thinking", "omni-deterministic-verifiers"]),
        mk_pipeline("skill-vault-doctor-sync", "Cross-Host Skill Vault Sync", "Skills", "3-way parity check, Merkle SHA-256 lock, <=110/<=3500 token ceilings", &["omni-bilingual-skill-router", "omni-deterministic-verifiers"]),
        mk_pipeline("ui-flagship-wcag-audit", "Flagship Studio WCAG 2.2 & CDP QA", "UI", "4 themes x 4 viewports, >=4.8:1 contrast, 0px overflow, 4x CPU continuity", &["omni-deterministic-verifiers"]),
        mk_pipeline("incident-autopsy-learn", "Incident Trajectory Autopsy -> Skill", "Reliability", "Root-cause forensics, regression test, lesson capture, skill promotion", &["goal-plan-loop-dod", "autonomous-power-continuity"]),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn synthetic_registry_for_golden_eval() -> SkillRegistry {
        let reg = SkillRegistry::new();
        let samples = [
            ("deep-research", "Use when performing active web search, deep research, extraction, RAG, citations, and sources ledger"),
            ("deep-think", "Use when running deep think multi-hypothesis reasoning, executable falsification, and red-team critique"),
            ("omnia-session-governance-handoff", "Use when governing session startup, handoff, checkpoint, canonical workspace artifacts, and 6-state receipts"),
            ("omni-deterministic-verifiers", "Use when running deterministic verifiers for UTF-8 LF, SHA-256, WCAG contrast, secrets, and audit receipts"),
            ("omni-bilingual-skill-router", "Use when routing bilingual Vietnamese English queries to skills, cold vault, and 4-stage DAG pipelines"),
            ("additive-steer-queue", "Use when handling mid-run user steer queue additive intake without dropping unfinished backlog"),
            ("deep-general-graph-orchestration", "Use when coordinating 2-way all-to-all peer-mesh swarm agents and Graphify bidirectional graphs"),
            ("deep-proposal", "Use when authoring engineering RFC proposals, trade-off matrices, non-goals, and rollback gates"),
            ("deep-clean", "Use when deep cleaning repository or drive artifacts via inventory, provenance, quarantine, and reclaim"),
            ("deep-cpp-native", "Use when building native Windows 11 C++20 MSVC Ninja UIA Mica Direct2D winsqlite3 apps"),
            ("goal-plan-loop-dod", "Use when structuring goals, plans, todos, loops, specs, blueprints, and definition of done gates"),
            ("vietnamese-typo-intent-inference", "Use when normalizing Vietnamese VNI Telex QWERTY typos and shorthand without mutating code"),
            ("kdense-literature-review", "Use when conducting systematic PRISMA literature reviews across arXiv OpenAlex PubMed"),
            ("kdense-citation-management", "Use when validating academic citations, DOIs, BibTeX, and bibliographic integrity"),
            ("kdense-scientific-visualization", "Use when designing publication-ready charts, figures, contrast, and multi-panel plots"),
            ("codex-mcp-namespace-diagnostics", "Use when diagnosing Codex MCP SSE namespace stripping, cold-start timeouts, and logs_2.sqlite"),
        ];
        let mut guard = reg.skills.lock().unwrap();
        for (name, desc) in samples {
            guard.push(build_indexed_skill(SkillMetadata {
                name: name.into(),
                description: desc.into(),
                path: format!(".agents/skills/{name}"),
                openai_interface: None,
                category: "Omnia".into(),
                canonical_artifacts: Vec::new(),
                sha256: sha256_hex(desc.as_bytes()),
                frontmatter_tokens: 45,
                body_tokens: 900,
                has_5phase_headers: true,
            }));
        }
        drop(guard);
        reg
    }

    /// 16-Case Bilingual Vietnamese-English Golden Routing Benchmark (`>= 95%` Top-5 Recall gate, `L4764..4781`).
    #[test]
    fn golden_16_bilingual_routing_benchmark_meets_95_percent_top5_recall() {
        let reg = synthetic_registry_for_golden_eval();
        let cases = [
            ("nghien cuu sau web search trich dan nguon", "deep-research"),
            ("suy luan nhieu gia thuyet phan bien red team", "deep-think"),
            ("ban giao phien checkpoint handoff 6-state", "omnia-session-governance-handoff"),
            ("kiem chung tuong phan wcag va lo bi mat", "omni-deterministic-verifiers"),
            ("dinh tuyen ky nang song ngu viet anh dag", "omni-bilingual-skill-router"),
            ("hang doi steer bo sung khong xoa viec cu", "additive-steer-queue"),
            ("da tac nhan do thi peer mesh song cong", "deep-general-graph-orchestration"),
            ("viet de xuat kien truc rfc tradeoff", "deep-proposal"),
            ("don dep o dia kho ma nguon an toan", "deep-clean"),
            ("bien dich c++20 native windows mica uia", "deep-cpp-native"),
            ("lap ke hoach muc tieu spec blueprint dod", "goal-plan-loop-dod"),
            ("sua loi go nham telex vni tieng viet", "vietnamese-typo-intent-inference"),
            ("tong quan tai lieu khoa hoc prisma arxiv", "kdense-literature-review"),
            ("kiem tra trich dan bibtex doi hoc thuat", "kdense-citation-management"),
            ("ve bieu do khoa hoc publication figure", "kdense-scientific-visualization"),
            ("sua loi codex mcp namespace timeout", "codex-mcp-namespace-diagnostics"),
        ];
        let mut hits = 0usize;
        for (query, expected) in cases {
            let res = reg.search(query, 5).unwrap();
            if res.iter().any(|m| m.skill.name == expected) {
                hits += 1;
            }
        }
        let recall = (hits as f64) / (cases.len() as f64);
        assert!(
            recall >= 0.95,
            "16-case golden bilingual Top-5 recall {recall:.3} ({hits}/16) < 0.95"
        );
        assert_eq!(reg.pipelines().len(), 24);
        assert!(reg.doctor().ok);
    }
}
