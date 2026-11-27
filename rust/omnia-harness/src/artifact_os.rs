//! Unified 12-Artifact Proactive Cognitive & Engineering Lifecycle OS (`#![forbid(unsafe_code)]`).
//!
//! Manages and bidirectionally cross-links:
//! `Goal`, `Spec`, `Blueprint`, `Plan`, `Todo`, `Progress`, `Dod`, `Checkpoint`,
//! `Handoff` (preserving `<!-- AGENT_NOTES_START -->...<!-- AGENT_NOTES_END -->`),
//! `Memory` (persistent SQLite WAL backing for [`MemoryGraph`]), `Lesson` (2-tier project + global),
//! and `Skill`, plus `.agents/super/state.json`, Semantic Overlap Deduplicator,
//! Gap Radar Evolver, 6-State Completion Receipts, and deterministic [`verify_artifact_content`].

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use omnia_core::{now_epoch_ms, sha256_hex, uuid_v4, SecretRedactor};
use omnia_winsqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::memory_graph::{
    parse_wiki_links, MemoryEntry, MemoryGraph, MemoryKind, MemoryProvenance, MemoryScope,
    MemoryTier,
};
use crate::proactive_rag::tokenize_folded;
use crate::research_vault::{atomic_write_with_retry, ResearchVault};

/// Default external Global Lessons directory (never inside tracked repository tree).
pub const DEFAULT_GLOBAL_MEMORY_DIR: &str = r"D:\OmniaData\memory";

const AGENT_NOTES_START: &str = "<!-- AGENT_NOTES_START -->";
const AGENT_NOTES_END: &str = "<!-- AGENT_NOTES_END -->";

const ARTIFACT_OS_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS ao_artifacts (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    slug TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    scope TEXT NOT NULL DEFAULT 'project',
    body_md TEXT NOT NULL DEFAULT '',
    metadata_json TEXT NOT NULL DEFAULT '{}',
    file_path TEXT,
    sha256_hex TEXT NOT NULL,
    receipt_json TEXT,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    UNIQUE(kind, slug, scope)
);
CREATE INDEX IF NOT EXISTS idx_ao_artifacts_kind ON ao_artifacts(kind, updated_at_ms DESC);

CREATE TABLE IF NOT EXISTS ao_links (
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    relation TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    created_at_ms INTEGER NOT NULL,
    PRIMARY KEY(from_id, to_id, relation)
);

CREATE TABLE IF NOT EXISTS ao_lessons (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL DEFAULT 'project',
    title TEXT NOT NULL,
    symptom TEXT NOT NULL,
    root_cause TEXT NOT NULL,
    invariant_text TEXT NOT NULL,
    anti_pattern TEXT NOT NULL DEFAULT '',
    verify_cmd TEXT NOT NULL DEFAULT '',
    tags_json TEXT NOT NULL DEFAULT '[]',
    provenance_sha TEXT NOT NULL,
    promoted_skill_slug TEXT,
    overlap_warning TEXT,
    created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ao_lessons_scope ON ao_lessons(scope, created_at_ms DESC);

CREATE TABLE IF NOT EXISTS ao_gap_telemetry (
    id TEXT PRIMARY KEY,
    query TEXT NOT NULL,
    best_score REAL NOT NULL,
    retries INTEGER NOT NULL DEFAULT 0,
    reason TEXT NOT NULL DEFAULT '',
    recorded_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ao_super_state (
    singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
    payload_json TEXT NOT NULL,
    updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ao_memory_entries (
    id TEXT PRIMARY KEY,
    payload_json TEXT NOT NULL,
    updated_at_ms INTEGER NOT NULL
);
"#;

/// All 12 canonical proactive lifecycle & knowledge artifacts in Omnia.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactKind {
    Goal,
    Spec,
    Blueprint,
    Plan,
    Todo,
    Progress,
    Dod,
    Checkpoint,
    Handoff,
    Memory,
    Lesson,
    Skill,
}

impl ArtifactKind {
    pub const ALL: [Self; 12] = [
        Self::Goal,
        Self::Spec,
        Self::Blueprint,
        Self::Plan,
        Self::Todo,
        Self::Progress,
        Self::Dod,
        Self::Checkpoint,
        Self::Handoff,
        Self::Memory,
        Self::Lesson,
        Self::Skill,
    ];

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Goal => "goal",
            Self::Spec => "spec",
            Self::Blueprint => "blueprint",
            Self::Plan => "plan",
            Self::Todo => "todo",
            Self::Progress => "progress",
            Self::Dod => "dod",
            Self::Checkpoint => "checkpoint",
            Self::Handoff => "handoff",
            Self::Memory => "memory",
            Self::Lesson => "lesson",
            Self::Skill => "skill",
        }
    }

    #[must_use]
    pub fn from_str_lossy(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "goal" | "goals" => Some(Self::Goal),
            "spec" | "specs" => Some(Self::Spec),
            "blueprint" | "blueprints" => Some(Self::Blueprint),
            "plan" | "plans" => Some(Self::Plan),
            "todo" | "todos" | "task" | "tasks" => Some(Self::Todo),
            "progress" => Some(Self::Progress),
            "dod" | "definition_of_done" => Some(Self::Dod),
            "checkpoint" | "checkpoints" => Some(Self::Checkpoint),
            "handoff" | "handoffs" => Some(Self::Handoff),
            "memory" | "memories" => Some(Self::Memory),
            "lesson" | "lessons" | "learn" => Some(Self::Lesson),
            "skill" | "skills" => Some(Self::Skill),
            _ => None,
        }
    }
}

/// Typed bidirectional relationship between two lifecycle artifacts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LinkRelation {
    Satisfies,
    Blocks,
    DerivedFrom,
    Supersedes,
    LearnedFrom,
    Cites,
    Implements,
    Verifies,
}

impl LinkRelation {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Satisfies => "satisfies",
            Self::Blocks => "blocks",
            Self::DerivedFrom => "derived_from",
            Self::Supersedes => "supersedes",
            Self::LearnedFrom => "learned_from",
            Self::Cites => "cites",
            Self::Implements => "implements",
            Self::Verifies => "verifies",
        }
    }

    #[must_use]
    pub fn from_str_lossy(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "satisfies" => Self::Satisfies,
            "blocks" => Self::Blocks,
            "derived_from" | "derivedfrom" => Self::DerivedFrom,
            "supersedes" => Self::Supersedes,
            "learned_from" | "learnedfrom" => Self::LearnedFrom,
            "implements" => Self::Implements,
            "verifies" => Self::Verifies,
            _ => Self::Cites,
        }
    }
}

/// Honest 6-state completion receipt separating Inspected, Modified, and Runtime-Verified outcomes.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SixStateReceipt {
    #[serde(default)]
    pub verified: Vec<String>,
    #[serde(default)]
    pub partial: Vec<String>,
    #[serde(default)]
    pub unresolved: Vec<String>,
    #[serde(default)]
    pub blocked: Vec<String>,
    #[serde(default)]
    pub next: Vec<String>,
    #[serde(default)]
    pub exact_practical_limits: Vec<String>,
    #[serde(default)]
    pub verified_at_ms: i64,
    #[serde(default)]
    pub receipt_sha256: String,
}

impl SixStateReceipt {
    pub fn seal(&mut self) {
        if self.verified_at_ms <= 0 {
            self.verified_at_ms = now_epoch_ms();
        }
        let body = format!(
            "v:{:?}|p:{:?}|u:{:?}|b:{:?}|n:{:?}|l:{:?}|t:{}",
            self.verified,
            self.partial,
            self.unresolved,
            self.blocked,
            self.next,
            self.exact_practical_limits,
            self.verified_at_ms
        );
        self.receipt_sha256 = sha256_hex(body.as_bytes());
    }
}

/// Typed edge connecting two artifacts in [`ArtifactOs`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactLink {
    pub from_id: String,
    pub to_id: String,
    pub relation: LinkRelation,
    pub note: String,
}

/// First-class persisted lifecycle artifact record.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LifecycleArtifact {
    pub id: String,
    pub kind: ArtifactKind,
    pub slug: String,
    pub title: String,
    pub status: String,
    pub scope: String,
    pub body_md: String,
    pub metadata: Value,
    pub file_path: Option<String>,
    pub sha256_hex: String,
    pub receipt: Option<SixStateReceipt>,
    pub links: Vec<ArtifactLink>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

/// 2-Tier (project + global) verified engineering lesson record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LessonRecord {
    pub id: String,
    pub scope: String,
    pub title: String,
    pub symptom: String,
    pub root_cause: String,
    pub invariant: String,
    pub anti_pattern: String,
    pub verify_cmd: String,
    pub tags: Vec<String>,
    pub provenance_sha: String,
    pub promoted_skill_slug: Option<String>,
    pub overlap_warning: Option<String>,
    pub created_at_ms: i64,
}

/// Persisted `.agents/super/state.json` wave/strike/gate execution state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuperWorkflowState {
    pub phase: String,
    pub wave: u32,
    pub strike_count: u32,
    pub active_goal_id: Option<String>,
    pub active_spec_id: Option<String>,
    pub active_plan_id: Option<String>,
    pub open_todos: usize,
    pub verified_dod_gates: usize,
    pub total_dod_gates: usize,
    pub last_handoff_id: Option<String>,
    pub updated_at_ms: i64,
}

impl Default for SuperWorkflowState {
    fn default() -> Self {
        Self {
            phase: "idle".to_string(),
            wave: 1,
            strike_count: 0,
            active_goal_id: None,
            active_spec_id: None,
            active_plan_id: None,
            open_todos: 0,
            verified_dod_gates: 0,
            total_dod_gates: 0,
            last_handoff_id: None,
            updated_at_ms: now_epoch_ms(),
        }
    }
}

/// Deterministic Phase-3 machine verification receipt (`verify_artifact`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactVerifyReport {
    pub ok: bool,
    pub sha256_hex: String,
    pub byte_len: usize,
    pub estimated_tokens: usize,
    pub utf8_clean: bool,
    pub lf_only: bool,
    pub no_bom: bool,
    pub no_control_bytes: bool,
    pub secret_findings: usize,
    pub under_5k_token_guard: bool,
    pub citation_report: Option<Value>,
    pub contrast_ratio: Option<f64>,
    pub wcag_aa_pass: Option<bool>,
    pub issues: Vec<String>,
}

/// Rejects prototype-polluting JSON keys (`__proto__`, `constructor`, `prototype`) recursively.
pub fn validate_no_proto_pollution(value: &Value) -> Result<(), String> {
    match value {
        Value::Object(map) => {
            for (k, v) in map {
                if matches!(k.as_str(), "__proto__" | "constructor" | "prototype") {
                    return Err(format!("forbidden JSON key `{k}` rejected"));
                }
                validate_no_proto_pollution(v)?;
            }
            Ok(())
        }
        Value::Array(arr) => {
            for v in arr {
                validate_no_proto_pollution(v)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

/// Computes exact WCAG 2.1 contrast ratio (`1.0..=21.0`) between two `#RRGGBB` / `#RGB` colors.
#[must_use]
pub fn wcag_contrast_ratio(fg_hex: &str, bg_hex: &str) -> Option<f64> {
    let l1 = relative_luminance(parse_hex_rgb(fg_hex)?);
    let l2 = relative_luminance(parse_hex_rgb(bg_hex)?);
    let (hi, lo) = if l1 >= l2 { (l1, l2) } else { (l2, l1) };
    let ratio = (hi + 0.05) / (lo + 0.05);
    Some((ratio * 100.0).round() / 100.0)
}

/// Deterministic Phase-3 verifier checking byte/LF/BOM/control-bytes (`0x08` incl.), SHA-256,
/// secret redaction, `<5,000` token ceiling, optional WCAG contrast, and optional `[S###]`/`[G###]` citations.
#[must_use]
pub fn verify_artifact_content(
    content: &str,
    fg_hex: Option<&str>,
    bg_hex: Option<&str>,
    check_citations_in: Option<&ResearchVault>,
) -> ArtifactVerifyReport {
    let bytes = content.as_bytes();
    let no_bom = !bytes.starts_with(&[0xEF, 0xBB, 0xBF]);
    let lf_only = !bytes.contains(&b'\r');
    let no_control_bytes = !bytes
        .iter()
        .any(|&b| (b < 0x20 && !matches!(b, b'\n' | b'\t')) || b == 0x7F);
    let redacted = SecretRedactor::redact(content);
    let secret_findings = usize::from(redacted != content);
    let estimated_tokens = content.len().div_ceil(4);
    let under_5k_token_guard = estimated_tokens <= 5_000;
    let citation_report = check_citations_in.map(|v| v.verify_inline_citations(content));
    let contrast_ratio = match (fg_hex, bg_hex) {
        (Some(fg), Some(bg)) => wcag_contrast_ratio(fg, bg),
        _ => None,
    };
    let wcag_aa_pass = contrast_ratio.map(|r| r >= 4.5);

    let mut issues = Vec::new();
    if !no_bom {
        issues.push("UTF-8 BOM detected (must be BOM-free)".into());
    }
    if !lf_only {
        issues.push("CRLF/CR line endings detected (must be Unix LF)".into());
    }
    if !no_control_bytes {
        issues.push("Forbidden ASCII control byte detected (e.g. 0x00..0x08/0x7F)".into());
    }
    if secret_findings > 0 {
        issues.push("Secret or credential pattern detected by SecretRedactor".into());
    }
    if let Some(ref cr) = citation_report {
        if cr.get("valid").and_then(Value::as_bool) == Some(false) {
            issues.push(format!("Invalid inline citations: {}", cr["invalid"]));
        }
    }
    if wcag_aa_pass == Some(false) {
        issues.push(format!(
            "WCAG 2.1 contrast ratio {:.2}:1 is below 4.5:1 AA minimum",
            contrast_ratio.unwrap_or(0.0)
        ));
    }

    ArtifactVerifyReport {
        ok: issues.is_empty(),
        sha256_hex: sha256_hex(bytes),
        byte_len: bytes.len(),
        estimated_tokens,
        utf8_clean: true,
        lf_only,
        no_bom,
        no_control_bytes,
        secret_findings,
        under_5k_token_guard,
        citation_report,
        contrast_ratio,
        wcag_aa_pass,
        issues,
    }
}

/// Persistent SQLite WAL + atomic LF workspace 12-Artifact Lifecycle OS.
pub struct ArtifactOs {
    conn: Mutex<Connection>,
    workspace_root: PathBuf,
    global_memory_dir: Option<PathBuf>,
}

impl std::fmt::Debug for ArtifactOs {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ArtifactOs")
            .field("workspace_root", &self.workspace_root)
            .field("global_memory_dir", &self.global_memory_dir)
            .finish()
    }
}

impl ArtifactOs {
    pub fn open(
        workspace_root: &Path,
        db_path: &Path,
        global_memory_dir: Option<&Path>,
    ) -> Result<Self, String> {
        if let Some(parent) = db_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let conn = Connection::open_read_write(db_path)
            .map_err(|e| format!("open ArtifactOs db {}: {e}", db_path.display()))?;
        conn.exec_batch(ARTIFACT_OS_SCHEMA_SQL)
            .map_err(|e| format!("init ArtifactOs schema: {e}"))?;
        let gdir = global_memory_dir
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from(DEFAULT_GLOBAL_MEMORY_DIR));
        Ok(Self {
            conn: Mutex::new(conn),
            workspace_root: workspace_root.to_path_buf(),
            global_memory_dir: Some(gdir),
        })
    }

    pub fn open_in_memory(workspace_root: &Path) -> Result<Self, String> {
        let conn = Connection::open_in_memory().map_err(|e| e.to_string())?;
        conn.exec_batch(ARTIFACT_OS_SCHEMA_SQL)
            .map_err(|e| e.to_string())?;
        Ok(Self {
            conn: Mutex::new(conn),
            workspace_root: workspace_root.to_path_buf(),
            global_memory_dir: None,
        })
    }

    /// Creates or updates any of the 12 proactive lifecycle artifacts, auto-links `[[wiki]]` refs,
    /// and optionally projects atomically (UTF-8 LF) to disk.
    #[allow(clippy::too_many_arguments)]
    pub fn upsert_artifact(
        &self,
        kind: ArtifactKind,
        slug: &str,
        title: &str,
        status: &str,
        scope: &str,
        body_md: &str,
        metadata: Value,
        mut receipt: Option<SixStateReceipt>,
        sync_to_disk: bool,
    ) -> Result<LifecycleArtifact, String> {
        validate_no_proto_pollution(&metadata)?;
        let clean_slug = sanitize_slug(slug);
        let clean_title = SecretRedactor::redact(title.trim());
        let clean_status = if status.trim().is_empty() {
            "active".to_string()
        } else {
            status.trim().to_ascii_lowercase()
        };
        let clean_scope = if scope.eq_ignore_ascii_case("global") {
            "global".to_string()
        } else {
            "project".to_string()
        };
        let clean_body = SecretRedactor::redact(&body_md.replace("\r\n", "\n").replace('\r', "\n"));
        if let Some(ref mut r) = receipt {
            r.seal();
        }
        let digest = sha256_hex(clean_body.as_bytes());
        let now = now_epoch_ms();
        let artifact_id = format!("{}_{}", kind.as_str(), clean_slug);

        let file_path = if sync_to_disk {
            let p = self.artifact_disk_path(kind, &clean_slug, &clean_scope);
            let serialized = format!(
                "# {clean_title}\n\n- **ID**: `{artifact_id}`\n- **Kind**: `{}`\n- **Status**: `{clean_status}`\n- **SHA-256**: `{digest}`\n\n{clean_body}\n",
                kind.as_str()
            );
            atomic_write_with_retry(&p, serialized.as_bytes())?;
            Some(p.to_string_lossy().replace('\\', "/"))
        } else {
            None
        };

        let conn = self.conn.lock().map_err(|_| "artifact_os lock poisoned".to_string())?;
        let existing_created = get_artifact_created_at(&conn, &artifact_id)?;
        let created_at_ms = existing_created.unwrap_or(now);
        let meta_str = serde_json::to_string(&SecretRedactor::redact_json(&metadata))
            .unwrap_or_else(|_| "{}".into());
        let rcpt_str = receipt
            .as_ref()
            .and_then(|r| serde_json::to_string(r).ok());

        let mut stmt = conn
            .prepare(
                "INSERT OR REPLACE INTO ao_artifacts (
                    id, kind, slug, title, status, scope, body_md, metadata_json,
                    file_path, sha256_hex, receipt_json, created_at_ms, updated_at_ms
                 ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13);",
            )
            .map_err(|e| e.to_string())?;
        stmt.bind_text(1, &artifact_id).map_err(|e| e.to_string())?;
        stmt.bind_text(2, kind.as_str()).map_err(|e| e.to_string())?;
        stmt.bind_text(3, &clean_slug).map_err(|e| e.to_string())?;
        stmt.bind_text(4, &clean_title).map_err(|e| e.to_string())?;
        stmt.bind_text(5, &clean_status).map_err(|e| e.to_string())?;
        stmt.bind_text(6, &clean_scope).map_err(|e| e.to_string())?;
        stmt.bind_text(7, &clean_body).map_err(|e| e.to_string())?;
        stmt.bind_text(8, &meta_str).map_err(|e| e.to_string())?;
        stmt.bind_opt_text(9, file_path.as_deref()).map_err(|e| e.to_string())?;
        stmt.bind_text(10, &digest).map_err(|e| e.to_string())?;
        stmt.bind_opt_text(11, rcpt_str.as_deref()).map_err(|e| e.to_string())?;
        stmt.bind_int64(12, created_at_ms).map_err(|e| e.to_string())?;
        stmt.bind_int64(13, now).map_err(|e| e.to_string())?;
        stmt.step().map_err(|e| e.to_string())?;

        // Auto-extract [[wiki-link]] edges into ao_links.
        for (target, alias) in parse_wiki_links(&clean_body) {
            let mut lstmt = conn
                .prepare(
                    "INSERT OR REPLACE INTO ao_links (from_id, to_id, relation, note, created_at_ms)
                     VALUES (?1, ?2, 'cites', ?3, ?4);",
                )
                .map_err(|e| e.to_string())?;
            lstmt.bind_text(1, &artifact_id).map_err(|e| e.to_string())?;
            lstmt.bind_text(2, &target).map_err(|e| e.to_string())?;
            lstmt.bind_text(3, &alias).map_err(|e| e.to_string())?;
            lstmt.bind_int64(4, now).map_err(|e| e.to_string())?;
            let _ = lstmt.step();
        }

        let links = list_links_for_artifact_locked(&conn, &artifact_id)?;
        Ok(LifecycleArtifact {
            id: artifact_id,
            kind,
            slug: clean_slug,
            title: clean_title,
            status: clean_status,
            scope: clean_scope,
            body_md: clean_body,
            metadata: SecretRedactor::redact_json(&metadata),
            file_path,
            sha256_hex: digest,
            receipt,
            links,
            created_at_ms,
            updated_at_ms: now,
        })
    }

    pub fn list_artifacts(
        &self,
        kind: Option<ArtifactKind>,
        scope: Option<&str>,
    ) -> Result<Vec<LifecycleArtifact>, String> {
        let conn = self.conn.lock().map_err(|_| "artifact_os lock poisoned".to_string())?;
        let mut sql = String::from(
            "SELECT id, kind, slug, title, status, scope, body_md, metadata_json,
                    file_path, sha256_hex, receipt_json, created_at_ms, updated_at_ms
             FROM ao_artifacts WHERE 1=1",
        );
        if kind.is_some() {
            sql.push_str(" AND kind = ?1");
        }
        if scope.is_some() {
            let idx = if kind.is_some() { 2 } else { 1 };
            sql.push_str(&format!(" AND scope = ?{idx}"));
        }
        sql.push_str(" ORDER BY updated_at_ms DESC LIMIT 500;");

        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let mut b_idx = 1_i32;
        if let Some(k) = kind {
            stmt.bind_text(b_idx, k.as_str()).map_err(|e| e.to_string())?;
            b_idx += 1;
        }
        if let Some(sc) = scope {
            stmt.bind_text(b_idx, sc).map_err(|e| e.to_string())?;
        }
        let mut out = Vec::new();
        while stmt.step_row().map_err(|e| e.to_string())? {
            let id = stmt.column_text(0).unwrap_or_default();
            let k = ArtifactKind::from_str_lossy(&stmt.column_text(1).unwrap_or_default())
                .unwrap_or(ArtifactKind::Todo);
            let meta: Value =
                serde_json::from_str(&stmt.column_text(7).unwrap_or_else(|_| "{}".into()))
                    .unwrap_or_else(|_| json!({}));
            let rcpt: Option<SixStateReceipt> = stmt
                .column_opt_text(10)
                .ok()
                .flatten()
                .and_then(|s| serde_json::from_str(&s).ok());
            out.push(LifecycleArtifact {
                id,
                kind: k,
                slug: stmt.column_text(2).unwrap_or_default(),
                title: stmt.column_text(3).unwrap_or_default(),
                status: stmt.column_text(4).unwrap_or_default(),
                scope: stmt.column_text(5).unwrap_or_default(),
                body_md: stmt.column_text(6).unwrap_or_default(),
                metadata: meta,
                file_path: stmt.column_opt_text(8).ok().flatten(),
                sha256_hex: stmt.column_text(9).unwrap_or_default(),
                receipt: rcpt,
                links: Vec::new(),
                created_at_ms: stmt.column_int64(11).unwrap_or(0),
                updated_at_ms: stmt.column_int64(12).unwrap_or(0),
            });
        }
        for art in &mut out {
            art.links = list_links_for_artifact_locked(&conn, &art.id)?;
        }
        Ok(out)
    }

    pub fn list_all_links(&self) -> Result<Vec<ArtifactLink>, String> {
        let conn = self.conn.lock().map_err(|_| "artifact_os lock poisoned".to_string())?;
        let mut stmt = conn
            .prepare("SELECT from_id, to_id, relation, note FROM ao_links ORDER BY created_at_ms DESC LIMIT 1000;")
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        while stmt.step_row().map_err(|e| e.to_string())? {
            out.push(ArtifactLink {
                from_id: stmt.column_text(0).unwrap_or_default(),
                to_id: stmt.column_text(1).unwrap_or_default(),
                relation: LinkRelation::from_str_lossy(&stmt.column_text(2).unwrap_or_default()),
                note: stmt.column_text(3).unwrap_or_default(),
            });
        }
        Ok(out)
    }

    pub fn link_artifacts(
        &self,
        from_id: &str,
        to_id: &str,
        relation: LinkRelation,
        note: &str,
    ) -> Result<ArtifactLink, String> {
        let f = from_id.trim();
        let t = to_id.trim();
        if f.is_empty() || t.is_empty() {
            return Err("from_id and to_id are required".to_string());
        }
        let clean_note = SecretRedactor::redact(note.trim());
        let conn = self.conn.lock().map_err(|_| "artifact_os lock poisoned".to_string())?;
        let mut stmt = conn
            .prepare(
                "INSERT OR REPLACE INTO ao_links (from_id, to_id, relation, note, created_at_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5);",
            )
            .map_err(|e| e.to_string())?;
        stmt.bind_text(1, f).map_err(|e| e.to_string())?;
        stmt.bind_text(2, t).map_err(|e| e.to_string())?;
        stmt.bind_text(3, relation.as_str()).map_err(|e| e.to_string())?;
        stmt.bind_text(4, &clean_note).map_err(|e| e.to_string())?;
        stmt.bind_int64(5, now_epoch_ms()).map_err(|e| e.to_string())?;
        stmt.step().map_err(|e| e.to_string())?;
        Ok(ArtifactLink {
            from_id: f.to_string(),
            to_id: t.to_string(),
            relation,
            note: clean_note,
        })
    }

    pub fn update_todo_status(
        &self,
        id: &str,
        status: &str,
        evidence_receipt: Option<&str>,
    ) -> Result<LifecycleArtifact, String> {
        let mut art = self
            .get_artifact_by_id(id)?
            .ok_or_else(|| format!("todo artifact `{id}` not found"))?;
        let norm = status.trim().to_ascii_lowercase();
        if norm == "done" || norm == "verified" {
            let mut rcpt = art.receipt.unwrap_or_default();
            if let Some(ev) = evidence_receipt.map(str::trim).filter(|s| !s.is_empty()) {
                rcpt.verified.push(SecretRedactor::redact(ev));
            }
            rcpt.seal();
            art.receipt = Some(rcpt);
        }
        self.upsert_artifact(
            art.kind,
            &art.slug,
            &art.title,
            &norm,
            &art.scope,
            &art.body_md,
            art.metadata,
            art.receipt,
            false,
        )
    }

    /// Receipt-gated DoD gate update: refuses `passed = true` unless `receipt.verified` has fresh evidence!
    pub fn update_dod_gate(
        &self,
        id: &str,
        passed: bool,
        mut receipt: SixStateReceipt,
    ) -> Result<LifecycleArtifact, String> {
        if passed && receipt.verified.is_empty() {
            return Err(
                "DoD gate cannot be marked Verified/passed without fresh ExecutionReceipt evidence in receipt.verified"
                    .to_string(),
            );
        }
        receipt.seal();
        let art = self
            .get_artifact_by_id(id)?
            .ok_or_else(|| format!("DoD artifact `{id}` not found"))?;
        let new_status = if passed { "verified" } else { "open" };
        self.upsert_artifact(
            ArtifactKind::Dod,
            &art.slug,
            &art.title,
            new_status,
            &art.scope,
            &art.body_md,
            art.metadata,
            Some(receipt),
            false,
        )
    }

    /// Writes a Handoff artifact while strictly preserving any human/agent block between
    /// `<!-- AGENT_NOTES_START -->` and `<!-- AGENT_NOTES_END -->`.
    pub fn write_handoff_preserving_notes(
        &self,
        title: &str,
        body_md: &str,
        mut receipt: SixStateReceipt,
        sync_to_disk: bool,
    ) -> Result<LifecycleArtifact, String> {
        receipt.seal();
        let existing_notes = self
            .get_artifact_by_id("handoff_latest")?
            .and_then(|a| extract_preserved_agent_notes(&a.body_md))
            .or_else(|| {
                let disk_p = self.workspace_root.join(".agents").join("memory").join("HANDOFF.md");
                fs::read_to_string(disk_p)
                    .ok()
                    .and_then(|s| extract_preserved_agent_notes(&s))
            });

        let mut merged = SecretRedactor::redact(&body_md.replace("\r\n", "\n").replace('\r', "\n"));
        if let Some(notes) = existing_notes {
            if !merged.contains(AGENT_NOTES_START) {
                merged.push_str("\n\n");
                merged.push_str(AGENT_NOTES_START);
                merged.push('\n');
                merged.push_str(notes.trim());
                merged.push('\n');
                merged.push_str(AGENT_NOTES_END);
                merged.push('\n');
            }
        } else if !merged.contains(AGENT_NOTES_START) {
            merged.push_str(&format!("\n\n{AGENT_NOTES_START}\n{AGENT_NOTES_END}\n"));
        }

        let art = self.upsert_artifact(
            ArtifactKind::Handoff,
            "latest",
            if title.trim().is_empty() {
                "Session Handoff"
            } else {
                title.trim()
            },
            "active",
            "project",
            &merged,
            json!({ "preservesAgentNotes": true }),
            Some(receipt),
            sync_to_disk,
        )?;
        let _ = self.update_super_state(json!({ "lastHandoffId": art.id }), sync_to_disk);
        Ok(art)
    }

    /// Captures a 2-tier (project + global) Lesson with Semantic Overlap Deduplication.
    pub fn capture_lesson(
        &self,
        mut lesson: LessonRecord,
        sync_to_disk: bool,
    ) -> Result<LessonRecord, String> {
        if lesson.id.trim().is_empty() {
            lesson.id = format!("lsn_{}", &uuid_v4()[..12]);
        }
        lesson.scope = if lesson.scope.eq_ignore_ascii_case("global") {
            "global".to_string()
        } else {
            "project".to_string()
        };
        lesson.title = SecretRedactor::redact(lesson.title.trim());
        lesson.symptom = SecretRedactor::redact(lesson.symptom.trim());
        lesson.root_cause = SecretRedactor::redact(lesson.root_cause.trim());
        lesson.invariant = SecretRedactor::redact(lesson.invariant.trim());
        lesson.anti_pattern = SecretRedactor::redact(lesson.anti_pattern.trim());
        lesson.verify_cmd = SecretRedactor::redact(lesson.verify_cmd.trim());
        if lesson.title.is_empty() || lesson.invariant.is_empty() {
            return Err("lesson requires non-empty title and invariant".to_string());
        }
        if lesson.created_at_ms <= 0 {
            lesson.created_at_ms = now_epoch_ms();
        }
        lesson.provenance_sha = sha256_hex(
            format!("{}|{}|{}", lesson.title, lesson.root_cause, lesson.invariant).as_bytes(),
        );

        // Semantic Overlap Deduplicator (`deep-omni-conflict-deduplicator`).
        let existing = self.list_lessons(None)?;
        let new_tokens = tokenize_folded(&format!(
            "{} {} {}",
            lesson.title, lesson.root_cause, lesson.invariant
        ));
        let mut best_overlap = 0.0_f64;
        let mut best_match_title: Option<String> = None;
        for ex in &existing {
            if ex.id == lesson.id {
                continue;
            }
            let ex_tokens = tokenize_folded(&format!("{} {} {}", ex.title, ex.root_cause, ex.invariant));
            let inter = new_tokens.intersection(&ex_tokens).count() as f64;
            let union = new_tokens.union(&ex_tokens).count().max(1) as f64;
            let jaccard = inter / union;
            if jaccard > best_overlap {
                best_overlap = jaccard;
                best_match_title = Some(ex.title.clone());
            }
        }
        if best_overlap >= 0.55 {
            lesson.overlap_warning = Some(format!(
                "High semantic overlap ({:.0}%) with existing lesson `{}` — prefer updating/consolidating rather than duplicating",
                best_overlap * 100.0,
                best_match_title.unwrap_or_default()
            ));
        }

        let conn = self.conn.lock().map_err(|_| "artifact_os lock poisoned".to_string())?;
        let mut stmt = conn
            .prepare(
                "INSERT OR REPLACE INTO ao_lessons (
                    id, scope, title, symptom, root_cause, invariant_text, anti_pattern,
                    verify_cmd, tags_json, provenance_sha, promoted_skill_slug, overlap_warning, created_at_ms
                 ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13);",
            )
            .map_err(|e| e.to_string())?;
        stmt.bind_text(1, &lesson.id).map_err(|e| e.to_string())?;
        stmt.bind_text(2, &lesson.scope).map_err(|e| e.to_string())?;
        stmt.bind_text(3, &lesson.title).map_err(|e| e.to_string())?;
        stmt.bind_text(4, &lesson.symptom).map_err(|e| e.to_string())?;
        stmt.bind_text(5, &lesson.root_cause).map_err(|e| e.to_string())?;
        stmt.bind_text(6, &lesson.invariant).map_err(|e| e.to_string())?;
        stmt.bind_text(7, &lesson.anti_pattern).map_err(|e| e.to_string())?;
        stmt.bind_text(8, &lesson.verify_cmd).map_err(|e| e.to_string())?;
        stmt.bind_text(9, &serde_json::to_string(&lesson.tags).unwrap_or_else(|_| "[]".into()))
            .map_err(|e| e.to_string())?;
        stmt.bind_text(10, &lesson.provenance_sha).map_err(|e| e.to_string())?;
        stmt.bind_opt_text(11, lesson.promoted_skill_slug.as_deref())
            .map_err(|e| e.to_string())?;
        stmt.bind_opt_text(12, lesson.overlap_warning.as_deref())
            .map_err(|e| e.to_string())?;
        stmt.bind_int64(13, lesson.created_at_ms).map_err(|e| e.to_string())?;
        stmt.step().map_err(|e| e.to_string())?;
        drop(stmt);
        drop(conn);

        // Mirror as a cross-linkable Lesson artifact.
        let _ = self.upsert_artifact(
            ArtifactKind::Lesson,
            &lesson.id,
            &lesson.title,
            "verified",
            &lesson.scope,
            &format!(
                "- **Symptom**: {}\n- **Root Cause**: {}\n- **Invariant**: {}\n- **Anti-Pattern**: {}\n- **Verify**: `{}`",
                lesson.symptom, lesson.root_cause, lesson.invariant, lesson.anti_pattern, lesson.verify_cmd
            ),
            json!({ "tags": lesson.tags, "overlapWarning": lesson.overlap_warning }),
            None,
            false,
        );

        if sync_to_disk {
            let entry_md = format!(
                "\n## {} (`{}`)\n- **Root Cause**: {}\n- **Invariant**: {}\n- **Verify**: `{}`\n",
                lesson.title, lesson.id, lesson.root_cause, lesson.invariant, lesson.verify_cmd
            );
            let target = if lesson.scope == "global" {
                self.global_memory_dir
                    .as_ref()
                    .map(|d| d.join("global_lessons.md"))
            } else {
                Some(self.workspace_root.join(".agents").join("memory").join("lessons.md"))
            };
            if let Some(p) = target {
                let mut existing_md = fs::read_to_string(&p).unwrap_or_else(|_| "# Lessons\n".into());
                if !existing_md.contains(&lesson.id) {
                    existing_md.push_str(&entry_md);
                    let _ = atomic_write_with_retry(&p, existing_md.as_bytes());
                }
            }
        }
        Ok(lesson)
    }

    pub fn list_lessons(&self, scope: Option<&str>) -> Result<Vec<LessonRecord>, String> {
        let conn = self.conn.lock().map_err(|_| "artifact_os lock poisoned".to_string())?;
        let mut stmt = if scope.is_some() {
            conn.prepare(
                "SELECT id, scope, title, symptom, root_cause, invariant_text, anti_pattern,
                        verify_cmd, tags_json, provenance_sha, promoted_skill_slug, overlap_warning, created_at_ms
                 FROM ao_lessons WHERE scope = ?1 ORDER BY created_at_ms DESC LIMIT 300;",
            )
        } else {
            conn.prepare(
                "SELECT id, scope, title, symptom, root_cause, invariant_text, anti_pattern,
                        verify_cmd, tags_json, provenance_sha, promoted_skill_slug, overlap_warning, created_at_ms
                 FROM ao_lessons ORDER BY created_at_ms DESC LIMIT 300;",
            )
        }
        .map_err(|e| e.to_string())?;
        if let Some(sc) = scope {
            stmt.bind_text(1, sc).map_err(|e| e.to_string())?;
        }
        let mut out = Vec::new();
        while stmt.step_row().map_err(|e| e.to_string())? {
            let tags: Vec<String> = serde_json::from_str(&stmt.column_text(8).unwrap_or_default())
                .unwrap_or_default();
            out.push(LessonRecord {
                id: stmt.column_text(0).unwrap_or_default(),
                scope: stmt.column_text(1).unwrap_or_default(),
                title: stmt.column_text(2).unwrap_or_default(),
                symptom: stmt.column_text(3).unwrap_or_default(),
                root_cause: stmt.column_text(4).unwrap_or_default(),
                invariant: stmt.column_text(5).unwrap_or_default(),
                anti_pattern: stmt.column_text(6).unwrap_or_default(),
                verify_cmd: stmt.column_text(7).unwrap_or_default(),
                tags,
                provenance_sha: stmt.column_text(9).unwrap_or_default(),
                promoted_skill_slug: stmt.column_opt_text(10).ok().flatten(),
                overlap_warning: stmt.column_opt_text(11).ok().flatten(),
                created_at_ms: stmt.column_int64(12).unwrap_or(0),
            });
        }
        Ok(out)
    }

    pub fn mark_lesson_promoted(&self, lesson_id: &str, skill_slug: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|_| "artifact_os lock poisoned".to_string())?;
        let mut stmt = conn
            .prepare("UPDATE ao_lessons SET promoted_skill_slug = ?1 WHERE id = ?2;")
            .map_err(|e| e.to_string())?;
        stmt.bind_text(1, skill_slug).map_err(|e| e.to_string())?;
        stmt.bind_text(2, lesson_id).map_err(|e| e.to_string())?;
        stmt.step().map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Gap Radar Evolver (`deep-omni-gap-radar-evolver`): logs low-score queries / retry spikes.
    pub fn record_gap_telemetry(
        &self,
        query: &str,
        best_score: f64,
        retries: u32,
        reason: &str,
    ) -> Result<Value, String> {
        let id = format!("gap_{}", &uuid_v4()[..10]);
        let now = now_epoch_ms();
        let safe_q = SecretRedactor::redact(query.trim());
        let safe_r = SecretRedactor::redact(reason.trim());
        let conn = self.conn.lock().map_err(|_| "artifact_os lock poisoned".to_string())?;
        let mut stmt = conn
            .prepare(
                "INSERT INTO ao_gap_telemetry (id, query, best_score, retries, reason, recorded_at_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6);",
            )
            .map_err(|e| e.to_string())?;
        stmt.bind_text(1, &id).map_err(|e| e.to_string())?;
        stmt.bind_text(2, &safe_q).map_err(|e| e.to_string())?;
        stmt.bind_double(3, best_score).map_err(|e| e.to_string())?;
        stmt.bind_int64(4, i64::from(retries)).map_err(|e| e.to_string())?;
        stmt.bind_text(5, &safe_r).map_err(|e| e.to_string())?;
        stmt.bind_int64(6, now).map_err(|e| e.to_string())?;
        stmt.step().map_err(|e| e.to_string())?;
        Ok(json!({
            "id": id,
            "query": safe_q,
            "bestScore": best_score,
            "retries": retries,
            "reason": safe_r,
            "recordedAtMs": now,
        }))
    }

    pub fn gap_radar_report(&self) -> Result<Value, String> {
        let conn = self.conn.lock().map_err(|_| "artifact_os lock poisoned".to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT id, query, best_score, retries, reason, recorded_at_ms
                 FROM ao_gap_telemetry ORDER BY recorded_at_ms DESC LIMIT 100;",
            )
            .map_err(|e| e.to_string())?;
        let mut events = Vec::new();
        let mut term_counts: BTreeMap<String, usize> = BTreeMap::new();
        while stmt.step_row().map_err(|e| e.to_string())? {
            let q = stmt.column_text(1).unwrap_or_default();
            let score = stmt.column_double(2).unwrap_or(0.0);
            let retries = stmt.column_int64(3).unwrap_or(0);
            if score < 1.5 || retries >= 2 {
                for tok in tokenize_folded(&q) {
                    *term_counts.entry(tok).or_insert(0) += 1;
                }
            }
            events.push(json!({
                "id": stmt.column_text(0).unwrap_or_default(),
                "query": q,
                "bestScore": score,
                "retries": retries,
                "reason": stmt.column_text(4).unwrap_or_default(),
                "recordedAtMs": stmt.column_int64(5).unwrap_or(0),
            }));
        }
        let mut hotspots: Vec<(String, usize)> = term_counts.into_iter().collect();
        hotspots.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        let candidates: Vec<Value> = hotspots
            .into_iter()
            .take(8)
            .map(|(term, count)| {
                json!({
                    "topic": term,
                    "occurrences": count,
                    "recommendation": format!("Consider capturing a verified lesson or extending an existing atomic skill for `{term}`."),
                })
            })
            .collect();
        Ok(json!({
            "totalGapEvents": events.len(),
            "upgradeCandidates": candidates,
            "recentEvents": events,
        }))
    }

    pub fn super_state(&self) -> Result<SuperWorkflowState, String> {
        let mut state = {
            let conn = self.conn.lock().map_err(|_| "artifact_os lock poisoned".to_string())?;
            let mut stmt = conn
                .prepare("SELECT payload_json FROM ao_super_state WHERE singleton_id = 1;")
                .map_err(|e| e.to_string())?;
            if stmt.step_row().map_err(|e| e.to_string())? {
                serde_json::from_str::<SuperWorkflowState>(&stmt.column_text(0).unwrap_or_default())
                    .unwrap_or_default()
            } else {
                SuperWorkflowState::default()
            }
        };
        let todos = self.list_artifacts(Some(ArtifactKind::Todo), None)?;
        let dods = self.list_artifacts(Some(ArtifactKind::Dod), None)?;
        state.open_todos = todos
            .iter()
            .filter(|t| !matches!(t.status.as_str(), "done" | "verified" | "completed"))
            .count();
        state.total_dod_gates = dods.len();
        state.verified_dod_gates = dods
            .iter()
            .filter(|d| matches!(d.status.as_str(), "verified" | "done" | "passed"))
            .count();
        Ok(state)
    }

    pub fn update_super_state(
        &self,
        patch: Value,
        sync_to_disk: bool,
    ) -> Result<SuperWorkflowState, String> {
        validate_no_proto_pollution(&patch)?;
        let mut st = self.super_state()?;
        if let Some(p) = patch.get("phase").and_then(Value::as_str) {
            st.phase = p.trim().to_string();
        }
        if let Some(w) = patch.get("wave").and_then(Value::as_u64) {
            st.wave = w.min(1000) as u32;
        }
        if let Some(s) = patch
            .get("strikeCount")
            .or_else(|| patch.get("strike_count"))
            .and_then(Value::as_u64)
        {
            st.strike_count = s.min(100) as u32;
        }
        if let Some(v) = patch
            .get("activeGoalId")
            .or_else(|| patch.get("active_goal_id"))
            .and_then(Value::as_str)
        {
            st.active_goal_id = Some(v.to_string());
        }
        if let Some(v) = patch
            .get("activeSpecId")
            .or_else(|| patch.get("active_spec_id"))
            .and_then(Value::as_str)
        {
            st.active_spec_id = Some(v.to_string());
        }
        if let Some(v) = patch
            .get("activePlanId")
            .or_else(|| patch.get("active_plan_id"))
            .and_then(Value::as_str)
        {
            st.active_plan_id = Some(v.to_string());
        }
        if let Some(v) = patch
            .get("lastHandoffId")
            .or_else(|| patch.get("last_handoff_id"))
            .and_then(Value::as_str)
        {
            st.last_handoff_id = Some(v.to_string());
        }
        st.updated_at_ms = now_epoch_ms();

        let payload = serde_json::to_string_pretty(&st).map_err(|e| e.to_string())?;
        let conn = self.conn.lock().map_err(|_| "artifact_os lock poisoned".to_string())?;
        let mut stmt = conn
            .prepare(
                "INSERT OR REPLACE INTO ao_super_state (singleton_id, payload_json, updated_at_ms)
                 VALUES (1, ?1, ?2);",
            )
            .map_err(|e| e.to_string())?;
        stmt.bind_text(1, &payload).map_err(|e| e.to_string())?;
        stmt.bind_int64(2, st.updated_at_ms).map_err(|e| e.to_string())?;
        stmt.step().map_err(|e| e.to_string())?;

        if sync_to_disk {
            let p = self.workspace_root.join(".agents").join("super").join("state.json");
            let _ = atomic_write_with_retry(&p, format!("{payload}\n").as_bytes());
        }
        Ok(st)
    }

    /// Persists all entries from an in-memory [`MemoryGraph`] into SQLite WAL (`ao_memory_entries`).
    pub fn sync_memory_graph_to_db(&self, graph: &MemoryGraph) -> Result<usize, String> {
        let entries = graph.list_entries().map_err(|e| e.to_string())?;
        let mut conn = self.conn.lock().map_err(|_| "artifact_os lock poisoned".to_string())?;
        let tx = conn.begin_immediate().map_err(|e| e.to_string())?;
        tx.exec_batch("DELETE FROM ao_memory_entries;")
            .map_err(|e| e.to_string())?;
        let mut count = 0usize;
        for entry in &entries {
            let raw = serde_json::to_string(entry).map_err(|e| e.to_string())?;
            let mut ins = tx
                .prepare(
                    "INSERT OR REPLACE INTO ao_memory_entries (id, payload_json, updated_at_ms)
                     VALUES (?1, ?2, ?3);",
                )
                .map_err(|e| e.to_string())?;
            ins.bind_text(1, &entry.id).map_err(|e| e.to_string())?;
            ins.bind_text(2, &raw).map_err(|e| e.to_string())?;
            ins.bind_int64(3, entry.updated_at_ms).map_err(|e| e.to_string())?;
            ins.step().map_err(|e| e.to_string())?;
            count += 1;
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(count)
    }

    /// Hydrates a [`MemoryGraph`] from persisted SQLite WAL rows on Studio startup!
    pub fn hydrate_memory_graph_from_db(&self, graph: &MemoryGraph) -> Result<usize, String> {
        let conn = self.conn.lock().map_err(|_| "artifact_os lock poisoned".to_string())?;
        let mut stmt = conn
            .prepare("SELECT payload_json FROM ao_memory_entries ORDER BY updated_at_ms ASC LIMIT 2000;")
            .map_err(|e| e.to_string())?;
        let mut count = 0usize;
        while stmt.step_row().map_err(|e| e.to_string())? {
            let raw = stmt.column_text(0).unwrap_or_default();
            if let Ok(entry) = serde_json::from_str::<MemoryEntry>(&raw) {
                let _ = graph.upsert(
                    &entry.namespace_path,
                    &entry.key,
                    entry.tier,
                    &entry.content,
                    &entry.links,
                    Some(entry.updated_at_ms),
                );
                count += 1;
            }
        }
        Ok(count)
    }

    fn get_artifact_by_id(&self, id: &str) -> Result<Option<LifecycleArtifact>, String> {
        let conn = self.conn.lock().map_err(|_| "artifact_os lock poisoned".to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT id, kind, slug, title, status, scope, body_md, metadata_json,
                        file_path, sha256_hex, receipt_json, created_at_ms, updated_at_ms
                 FROM ao_artifacts WHERE id = ?1 LIMIT 1;",
            )
            .map_err(|e| e.to_string())?;
        stmt.bind_text(1, id).map_err(|e| e.to_string())?;
        if stmt.step_row().map_err(|e| e.to_string())? {
            let aid = stmt.column_text(0).unwrap_or_default();
            let k = ArtifactKind::from_str_lossy(&stmt.column_text(1).unwrap_or_default())
                .unwrap_or(ArtifactKind::Todo);
            let meta: Value =
                serde_json::from_str(&stmt.column_text(7).unwrap_or_else(|_| "{}".into()))
                    .unwrap_or_else(|_| json!({}));
            let rcpt: Option<SixStateReceipt> = stmt
                .column_opt_text(10)
                .ok()
                .flatten()
                .and_then(|s| serde_json::from_str(&s).ok());
            let links = list_links_for_artifact_locked(&conn, &aid)?;
            Ok(Some(LifecycleArtifact {
                id: aid,
                kind: k,
                slug: stmt.column_text(2).unwrap_or_default(),
                title: stmt.column_text(3).unwrap_or_default(),
                status: stmt.column_text(4).unwrap_or_default(),
                scope: stmt.column_text(5).unwrap_or_default(),
                body_md: stmt.column_text(6).unwrap_or_default(),
                metadata: meta,
                file_path: stmt.column_opt_text(8).ok().flatten(),
                sha256_hex: stmt.column_text(9).unwrap_or_default(),
                receipt: rcpt,
                links,
                created_at_ms: stmt.column_int64(11).unwrap_or(0),
                updated_at_ms: stmt.column_int64(12).unwrap_or(0),
            }))
        } else {
            Ok(None)
        }
    }

    fn artifact_disk_path(&self, kind: ArtifactKind, slug: &str, scope: &str) -> PathBuf {
        if scope == "global" {
            if let Some(ref g) = self.global_memory_dir {
                return g.join("artifacts").join(format!("{}_{slug}.md", kind.as_str()));
            }
        }
        if kind == ArtifactKind::Handoff && slug == "latest" {
            return self
                .workspace_root
                .join(".agents")
                .join("memory")
                .join("HANDOFF.md");
        }
        self.workspace_root
            .join(".agents")
            .join("lifecycle")
            .join(format!("{}_{slug}.md", kind.as_str()))
    }
}

fn get_artifact_created_at(conn: &Connection, id: &str) -> Result<Option<i64>, String> {
    let mut stmt = conn
        .prepare("SELECT created_at_ms FROM ao_artifacts WHERE id = ?1 LIMIT 1;")
        .map_err(|e| e.to_string())?;
    stmt.bind_text(1, id).map_err(|e| e.to_string())?;
    if stmt.step_row().map_err(|e| e.to_string())? {
        Ok(Some(stmt.column_int64(0).unwrap_or(0)))
    } else {
        Ok(None)
    }
}

fn list_links_for_artifact_locked(
    conn: &Connection,
    artifact_id: &str,
) -> Result<Vec<ArtifactLink>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT from_id, to_id, relation, note FROM ao_links
             WHERE from_id = ?1 OR to_id = ?1 ORDER BY created_at_ms DESC LIMIT 128;",
        )
        .map_err(|e| e.to_string())?;
    stmt.bind_text(1, artifact_id).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    while stmt.step_row().map_err(|e| e.to_string())? {
        out.push(ArtifactLink {
            from_id: stmt.column_text(0).unwrap_or_default(),
            to_id: stmt.column_text(1).unwrap_or_default(),
            relation: LinkRelation::from_str_lossy(&stmt.column_text(2).unwrap_or_default()),
            note: stmt.column_text(3).unwrap_or_default(),
        });
    }
    Ok(out)
}

fn extract_preserved_agent_notes(text: &str) -> Option<String> {
    let start = text.find(AGENT_NOTES_START)? + AGENT_NOTES_START.len();
    let end = text[start..].find(AGENT_NOTES_END)? + start;
    Some(text[start..end].to_string())
}

fn sanitize_slug(raw: &str) -> String {
    let s: String = raw
        .trim()
        .to_ascii_lowercase()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = s.trim_matches('-');
    if trimmed.is_empty() {
        format!("item-{}", &uuid_v4()[..6])
    } else {
        trimmed.chars().take(64).collect()
    }
}

fn parse_hex_rgb(raw: &str) -> Option<(u8, u8, u8)> {
    let h = raw.trim().trim_start_matches('#');
    if h.len() == 6 {
        let r = u8::from_str_radix(&h[0..2], 16).ok()?;
        let g = u8::from_str_radix(&h[2..4], 16).ok()?;
        let b = u8::from_str_radix(&h[4..6], 16).ok()?;
        Some((r, g, b))
    } else if h.len() == 3 {
        let r = u8::from_str_radix(&h[0..1], 16).ok()? * 17;
        let g = u8::from_str_radix(&h[1..2], 16).ok()? * 17;
        let b = u8::from_str_radix(&h[2..3], 16).ok()? * 17;
        Some((r, g, b))
    } else {
        None
    }
}

fn linearize_channel(c: u8) -> f64 {
    let s = f64::from(c) / 255.0;
    if s <= 0.04045 {
        s / 12.92
    } else {
        ((s + 0.055) / 1.055).powf(2.4)
    }
}

fn relative_luminance((r, g, b): (u8, u8, u8)) -> f64 {
    0.2126 * linearize_channel(r) + 0.7152 * linearize_channel(g) + 0.0722 * linearize_channel(b)
}

#[allow(dead_code)]
fn _touch_memory_enums(_k: MemoryKind, _s: MemoryScope, _p: MemoryProvenance, _t: MemoryTier) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lifecycle_12_artifacts_dod_gate_handoff_notes_and_overlap_dedup() {
        let os = ArtifactOs::open_in_memory(Path::new(".")).unwrap();
        let g = os
            .upsert_artifact(
                ArtifactKind::Goal,
                "steer-18",
                "Default-ON Deep Research",
                "active",
                "project",
                "Deliver [[spec_deep-research]] with zero slop.",
                json!({"priority": "P0"}),
                None,
                false,
            )
            .unwrap();
        assert!(g.links.iter().any(|l| l.to_id == "spec_deep-research"));

        let dod = os
            .upsert_artifact(
                ArtifactKind::Dod,
                "gate-1",
                "All unit tests pass",
                "open",
                "project",
                "Verify cargo test",
                json!({}),
                None,
                false,
            )
            .unwrap();
        // Receipt-gated DoD refuses empty verified evidence.
        assert!(os
            .update_dod_gate(&dod.id, true, SixStateReceipt::default())
            .is_err());

        let mut rcpt = SixStateReceipt::default();
        rcpt.verified.push("cargo test -p omnia-harness PASS".into());
        let verified_dod = os.update_dod_gate(&dod.id, true, rcpt.clone()).unwrap();
        assert_eq!(verified_dod.status, "verified");

        // Handoff preserves AGENT_NOTES_START..END block across updates.
        os.write_handoff_preserving_notes(
            "Handoff 1",
            "Summary 1\n<!-- AGENT_NOTES_START -->\nKeep this critical note!\n<!-- AGENT_NOTES_END -->",
            rcpt.clone(),
            false,
        )
        .unwrap();
        let h2 = os
            .write_handoff_preserving_notes("Handoff 2", "Summary 2", rcpt, false)
            .unwrap();
        assert!(h2.body_md.contains("Keep this critical note!"));

        // Lesson capture + Semantic Overlap Deduplicator.
        let l1 = os
            .capture_lesson(
                LessonRecord {
                    id: String::new(),
                    scope: "project".into(),
                    title: "Never delay-load ws2_32.dll on Windows MSVC".into(),
                    symptom: "Access violation 0xc0000005 on TcpStream".into(),
                    root_cause: "Dual casing WS2_32.dll vs ws2_32.dll breaks __delayLoadHelper2".into(),
                    invariant: "Never pass /DELAYLOAD:ws2_32.dll in build.rs".into(),
                    anti_pattern: "Delay loading Winsock DLL".into(),
                    verify_cmd: "omnia.exe --version".into(),
                    tags: vec!["windows".into(), "msvc".into()],
                    provenance_sha: String::new(),
                    promoted_skill_slug: None,
                    overlap_warning: None,
                    created_at_ms: 0,
                },
                false,
            )
            .unwrap();
        assert!(l1.overlap_warning.is_none());

        let l2 = os
            .capture_lesson(
                LessonRecord {
                    id: String::new(),
                    scope: "global".into(),
                    title: "Never delay-load ws2_32.dll on Windows MSVC".into(),
                    symptom: "Crash on socket".into(),
                    root_cause: "Dual casing WS2_32.dll vs ws2_32.dll breaks __delayLoadHelper2".into(),
                    invariant: "Never pass /DELAYLOAD:ws2_32.dll in build.rs".into(),
                    anti_pattern: "".into(),
                    verify_cmd: "omnia.exe --version".into(),
                    tags: vec!["windows".into()],
                    provenance_sha: String::new(),
                    promoted_skill_slug: None,
                    overlap_warning: None,
                    created_at_ms: 0,
                },
                false,
            )
            .unwrap();
        assert!(l2.overlap_warning.is_some());

        // MemoryGraph SQLite round-trip.
        let mem1 = MemoryGraph::new();
        mem1.upsert("omnia/core", "wal", MemoryTier::Durable, "Use WAL leases", &[], None)
            .unwrap();
        assert_eq!(os.sync_memory_graph_to_db(&mem1).unwrap(), 1);
        let mem2 = MemoryGraph::new();
        assert_eq!(os.hydrate_memory_graph_from_db(&mem2).unwrap(), 1);
        assert_eq!(mem2.list_entries().unwrap().len(), 1);

        // Deterministic verifier + WCAG contrast + proto-pollution guard.
        let rep = verify_artifact_content("Clean UTF-8 LF text\n", Some("#FAFAFA"), Some("#09090B"), None);
        assert!(rep.ok);
        assert!(rep.contrast_ratio.unwrap() > 19.0);
        assert_eq!(rep.wcag_aa_pass, Some(true));

        let bad_ctrl = verify_artifact_content("bad\x08byte", None, None, None);
        assert!(!bad_ctrl.ok);
        assert!(!bad_ctrl.no_control_bytes);

        assert!(validate_no_proto_pollution(&json!({"__proto__": {"admin": true}})).is_err());
    }
}
