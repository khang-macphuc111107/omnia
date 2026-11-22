use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use omnia_core::truncate_utf8_codepoints;
use serde::Serialize;
use serde_json::{json, Value};

use crate::proactive_rag::{fold_vietnamese_ascii, tokenize_folded};

const MAX_SKILLS_PER_ROOT: usize = 1024;
const MAX_SKILL_FILE_BYTES: u64 = 256 * 1024;
const MAX_DESCRIPTION_CODEPOINTS: usize = 1024;

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
}

impl SkillMetadata {
    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "name": self.name,
            "description": self.description,
            "path": self.path,
            "openai_interface": self.openai_interface.as_ref().map(OpenAiSkillInterface::to_json),
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

/// Thread-safe skill catalog reading `.agents/skills.json`, `SKILL.md` frontmatter,
/// and `agents/openai.yaml` with accent-folded bilingual EN/VN BM25 search.
#[derive(Debug, Default)]
pub struct SkillRegistry {
    skills: Mutex<Vec<IndexedSkill>>,
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
            let text = omnia_core::sanitize_utf8_lossy(&bytes);
            let stripped = text.strip_prefix('\u{FEFF}').unwrap_or(&text);
            let Some((raw_name, raw_desc)) = parse_frontmatter(stripped) else {
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
            let name = if raw_name.is_empty() {
                fallback_name
            } else {
                raw_name
            };
            let description = truncate_utf8_codepoints(&raw_desc, MAX_DESCRIPTION_CODEPOINTS);
            let openai_interface = load_openai_yaml(&canonical_root, &child);

            let meta = SkillMetadata {
                name,
                description,
                path: child.to_string_lossy().replace('\\', "/"),
                openai_interface,
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

            for term in &query_terms {
                let tf = doc.term_freqs.get(term.as_str()).copied().unwrap_or(0) as f64;
                if tf <= 0.0 {
                    continue;
                }
                matched.push(term.clone());
                let df = doc_freq.get(term.as_str()).copied().unwrap_or(0) as f64;
                let idf = ((n_docs - df + 0.5) / (df + 0.5) + 1.0).ln();
                let denom = tf + k1 * (1.0 - b + b * (dl / avgdl));
                score += idf * ((tf * (k1 + 1.0)) / denom.max(1e-9));
            }
            if score > 0.0 {
                let folded_name = fold_vietnamese_ascii(&doc.meta.name);
                if query_terms.iter().any(|t| folded_name.contains(t.as_str())) {
                    score += 1.5;
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
}

fn expand_skill_query_terms(query: &str) -> BTreeSet<String> {
    let mut terms = tokenize_folded(query);
    let folded = format!(" {} ", fold_vietnamese_ascii(query));
    if folded.contains(" tieng viet ") || folded.contains(" viet ") || folded.contains(" telex ") {
        for extra in ["vietnamese", "bilingual", "telex", "vni", "typo"] {
            terms.insert(extra.to_owned());
        }
    }
    if folded.contains("c++") || folded.contains(" cpp ") {
        for extra in ["cpp", "cpp20", "native", "msvc", "cmake"] {
            terms.insert(extra.to_owned());
        }
    }
    if folded.contains(" hang doi ") || folded.contains(" steer ") {
        for extra in ["steer", "queue", "additive", "backlog"] {
            terms.insert(extra.to_owned());
        }
    }
    if folded.contains(" de xuat ") || folded.contains(" proposal ") {
        for extra in ["proposal", "rfc", "spec"] {
            terms.insert(extra.to_owned());
        }
    }
    terms
}

fn build_indexed_skill(meta: SkillMetadata) -> IndexedSkill {
    let mut bag = format!("{} {} {}", meta.name, meta.name, meta.description);
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

fn parse_frontmatter(content: &str) -> Option<(String, String)> {
    let mut lines = content.lines();
    if lines.next()?.trim() != "---" {
        return None;
    }
    let mut fm_lines = Vec::new();
    let mut closed = false;
    for line in lines {
        if line.trim() == "---" {
            closed = true;
            break;
        }
        fm_lines.push(line);
    }
    if !closed {
        return None;
    }
    let name = extract_yaml_scalar(&fm_lines, "name").unwrap_or_default();
    let desc = extract_yaml_scalar(&fm_lines, "description").unwrap_or_default();
    if desc.is_empty() && name.is_empty() {
        return None;
    }
    Some((name, desc))
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
