//! Shared Super-Workflow Engine State (`.agents/super/engine_state.json`) and
//! 2-Tier Global Lessons Mirror (`D:\OmniaData\memory\global_lessons.md`) used by
//! `omnia learn`, `omnia proceed`, and TUI `/super-plan`, `/super-run`, `/auto-proceed`,
//! and `/learn --global`.

use anyhow::{bail, Result};
use omnia_agent::{default_omnia_data_dir, redact_secrets};
use omnia_harness::artifact_os::{ArtifactOs, LessonRecord};
use omnia_harness::research_vault::atomic_write_with_retry;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

pub const GLOBAL_LESSONS_MAX_ENTRIES: usize = 100;
pub const ENGINE_STATE_SCHEMA: &str = "omnia.super-engine-state.v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AutoProceedMode {
    #[default]
    Off,
    RecommendedOnly,
    Full,
}

impl AutoProceedMode {
    pub fn try_parse(raw: &str) -> Result<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "off" | "false" | "0" | "disabled" | "no" => Ok(Self::Off),
            "recommended-only" | "recommended" | "safe" => Ok(Self::RecommendedOnly),
            "full" | "on" | "true" | "1" | "enabled" | "yes" | "auto" => Ok(Self::Full),
            other => bail!(
                "invalid proceed mode '{other}' (expected: status | on | off | recommended-only | full)"
            ),
        }
    }

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::RecommendedOnly => "recommended-only",
            Self::Full => "full",
        }
    }

    #[must_use]
    pub const fn is_enabled(self) -> bool {
        !matches!(self, Self::Off)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuperEngineState {
    pub schema: String,
    pub mode: String,
    pub auto_proceed: AutoProceedMode,
    pub auto_proceed_enabled: bool,
    pub active_goal: Option<String>,
    /// Uncapped token budget invariant (`Z-07`): always serialized as `null`.
    pub token_budget: Option<u64>,
    pub updated_at_ms: i64,
}

impl Default for SuperEngineState {
    fn default() -> Self {
        Self {
            schema: ENGINE_STATE_SCHEMA.to_string(),
            mode: "idle".to_string(),
            auto_proceed: AutoProceedMode::Off,
            auto_proceed_enabled: false,
            active_goal: None,
            token_budget: None,
            updated_at_ms: 0,
        }
    }
}

#[must_use]
pub fn engine_state_path(workspace: &Path) -> PathBuf {
    workspace
        .join(".agents")
        .join("super")
        .join("engine_state.json")
}

#[must_use]
pub fn project_lessons_path(workspace: &Path) -> PathBuf {
    workspace.join(".agents").join("memory").join("lessons.md")
}

#[must_use]
pub fn global_lessons_path() -> PathBuf {
    default_omnia_data_dir()
        .join("memory")
        .join("global_lessons.md")
}

/// Dynamically resolves the user-home global lessons mirror without hardcoding any username.
#[must_use]
pub fn discover_cross_host_lessons_path() -> Option<PathBuf> {
    let home = env::var("USERPROFILE")
        .or_else(|_| env::var("HOME"))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())?;
    let path = PathBuf::from(home)
        .join(".gemini")
        .join("config")
        .join("skills")
        .join("global-lessons")
        .join("references")
        .join("lessons.md");
    if path.parent().is_some_and(Path::is_dir) {
        Some(path)
    } else {
        None
    }
}

#[must_use]
pub fn read_engine_state(workspace: &Path) -> SuperEngineState {
    let path = engine_state_path(workspace);
    let mut state = fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str::<SuperEngineState>(&raw).ok())
        .unwrap_or_default();
    if state.schema.trim().is_empty() {
        state.schema = ENGINE_STATE_SCHEMA.to_string();
    }
    if state.mode.trim().is_empty() {
        state.mode = "idle".to_string();
    }
    state.auto_proceed_enabled = state.auto_proceed.is_enabled();
    state.token_budget = None;
    state
}

pub fn write_engine_state(workspace: &Path, state: &mut SuperEngineState) -> Result<PathBuf> {
    state.schema = ENGINE_STATE_SCHEMA.to_string();
    state.auto_proceed_enabled = state.auto_proceed.is_enabled();
    state.token_budget = None;
    state.updated_at_ms = omnia_core::now_epoch_ms();
    if let Some(ref goal) = state.active_goal {
        state.active_goal = Some(redact_secrets(goal.trim()));
    }
    let path = engine_state_path(workspace);
    let mut text = serde_json::to_string_pretty(state)?;
    text = text.replace("\r\n", "\n");
    if !text.ends_with('\n') {
        text.push('\n');
    }
    atomic_write_with_retry(&path, text.as_bytes()).map_err(|e| anyhow::anyhow!(e))?;
    Ok(path)
}

pub fn set_auto_proceed(
    workspace: &Path,
    mode: AutoProceedMode,
) -> Result<(SuperEngineState, PathBuf)> {
    let mut state = read_engine_state(workspace);
    state.auto_proceed = mode;
    let path = write_engine_state(workspace, &mut state)?;
    Ok((state, path))
}

pub fn set_super_workflow_mode(
    workspace: &Path,
    mode: &str,
    goal: Option<&str>,
    os: Option<&ArtifactOs>,
) -> Result<(SuperEngineState, PathBuf)> {
    let mut state = read_engine_state(workspace);
    state.mode = mode.trim().to_string();
    if let Some(g) = goal.map(str::trim).filter(|s| !s.is_empty()) {
        state.active_goal = Some(redact_secrets(g));
    }
    let path = write_engine_state(workspace, &mut state)?;
    if let Some(aos) = os {
        let _ = aos.update_super_state(json!({ "phase": state.mode }), false);
    }
    Ok((state, path))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedMarkdownLesson {
    pub title: String,
    pub id: Option<String>,
    pub root_cause: String,
    pub invariant: String,
    pub verify_cmd: String,
}

/// Parses `## <title> (\`<id>\`)` sections from a Markdown lessons ledger.
#[must_use]
pub fn parse_lessons_from_markdown(md: &str) -> Vec<ParsedMarkdownLesson> {
    let mut out = Vec::new();
    let mut current: Option<ParsedMarkdownLesson> = None;

    for raw_line in md.replace("\r\n", "\n").lines() {
        let line = raw_line.trim();
        if let Some(rest) = line.strip_prefix("## ") {
            if let Some(prev) = current.take().filter(|p| !p.title.is_empty()) {
                out.push(prev);
            }
            let (title, id) = split_heading_and_id(rest.trim());
            current = Some(ParsedMarkdownLesson {
                title,
                id,
                root_cause: String::new(),
                invariant: String::new(),
                verify_cmd: String::new(),
            });
            continue;
        }
        let Some(ref mut cur) = current else {
            continue;
        };
        if let Some(v) = line.strip_prefix("- **Root Cause**:") {
            cur.root_cause = v.trim().to_string();
        } else if let Some(v) = line.strip_prefix("- **Invariant**:") {
            cur.invariant = v.trim().to_string();
        } else if let Some(v) = line.strip_prefix("- **Verify**:") {
            cur.verify_cmd = v.trim().trim_matches('`').to_string();
        }
    }
    if let Some(prev) = current.take().filter(|p| !p.title.is_empty()) {
        out.push(prev);
    }
    out
}

fn split_heading_and_id(heading: &str) -> (String, Option<String>) {
    if let Some(idx) = heading.rfind(" (`") {
        let tail = &heading[idx + 3..];
        if let Some(end) = tail.strip_suffix("`)") {
            let title = heading[..idx].trim().to_string();
            let id = end.trim().to_string();
            if !title.is_empty() && !id.is_empty() {
                return (title, Some(id));
            }
        }
    }
    (heading.to_string(), None)
}

fn normalize_lesson_key(title: &str) -> String {
    title
        .trim()
        .to_ascii_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Atomically mirrors verified lessons into a pure UTF-8 LF Markdown ledger,
/// redacting secrets, deduplicating by normalized title, and capping at `cap` entries.
pub fn mirror_lessons_markdown(
    path: &Path,
    header: &str,
    lessons: &[LessonRecord],
    cap: usize,
) -> Result<usize> {
    let limit = cap.clamp(1, 500);
    let mut seen: HashSet<String> = HashSet::new();
    let mut merged: Vec<ParsedMarkdownLesson> = Vec::new();

    for l in lessons {
        let title = redact_secrets(l.title.trim());
        let key = normalize_lesson_key(&title);
        if key.is_empty() || !seen.insert(key) {
            continue;
        }
        let root_cause = redact_secrets(if l.root_cause.trim().is_empty() {
            l.title.trim()
        } else {
            l.root_cause.trim()
        });
        let invariant = redact_secrets(if l.invariant.trim().is_empty() {
            l.title.trim()
        } else {
            l.invariant.trim()
        });
        let verify_cmd = redact_secrets(l.verify_cmd.trim());
        merged.push(ParsedMarkdownLesson {
            title,
            id: Some(l.id.clone()),
            root_cause,
            invariant,
            verify_cmd,
        });
        if merged.len() >= limit {
            break;
        }
    }

    if let Some(existing_md) = (merged.len() < limit)
        .then(|| fs::read_to_string(path).ok())
        .flatten()
    {
        for ex in parse_lessons_from_markdown(&existing_md) {
            let title = redact_secrets(ex.title.trim());
            let key = normalize_lesson_key(&title);
            if key.is_empty() || !seen.insert(key) {
                continue;
            }
            merged.push(ParsedMarkdownLesson {
                title,
                id: ex.id,
                root_cause: redact_secrets(ex.root_cause.trim()),
                invariant: redact_secrets(ex.invariant.trim()),
                verify_cmd: redact_secrets(ex.verify_cmd.trim()),
            });
            if merged.len() >= limit {
                break;
            }
        }
    }

    let mut out = format!("# {header}\n");
    for item in &merged {
        if let Some(ref id) = item.id {
            out.push_str(&format!("\n## {} (`{}`)\n", item.title, id));
        } else {
            out.push_str(&format!("\n## {}\n", item.title));
        }
        let rc = if item.root_cause.is_empty() {
            item.title.as_str()
        } else {
            item.root_cause.as_str()
        };
        let inv = if item.invariant.is_empty() {
            item.title.as_str()
        } else {
            item.invariant.as_str()
        };
        out.push_str(&format!("- **Root Cause**: {rc}\n"));
        out.push_str(&format!("- **Invariant**: {inv}\n"));
        if !item.verify_cmd.is_empty() {
            out.push_str(&format!("- **Verify**: `{}`\n", item.verify_cmd));
        }
    }
    let clean_lf = out.replace("\r\n", "\n").replace('\r', "\n");
    atomic_write_with_retry(path, clean_lf.as_bytes()).map_err(|e| anyhow::anyhow!(e))?;
    Ok(merged.len())
}

/// Bidirectionally synchronizes lessons between `ArtifactOs`, workspace `.agents/memory/lessons.md`,
/// `global_lessons.md`, and an optional cross-host mirror file.
pub fn sync_lessons_to_paths(
    os: &ArtifactOs,
    workspace: &Path,
    global_path: &Path,
    cross_host_mirror: Option<&Path>,
) -> Result<Value> {
    let existing = os.list_lessons(None).map_err(|e| anyhow::anyhow!(e))?;
    let mut known_keys: HashSet<String> = existing
        .iter()
        .map(|l| normalize_lesson_key(&l.title))
        .collect();

    let proj_path = project_lessons_path(workspace);
    let mut imported_from_disk = 0usize;

    for (src_path, scope) in [(proj_path.as_path(), "project"), (global_path, "global")] {
        if let Ok(raw) = fs::read_to_string(src_path) {
            for parsed in parse_lessons_from_markdown(&raw) {
                let key = normalize_lesson_key(&parsed.title);
                if key.is_empty() || !known_keys.insert(key) {
                    continue;
                }
                let invariant = if parsed.invariant.trim().is_empty() {
                    parsed.title.clone()
                } else {
                    parsed.invariant.clone()
                };
                let root_cause = if parsed.root_cause.trim().is_empty() {
                    parsed.title.clone()
                } else {
                    parsed.root_cause.clone()
                };
                let rec = LessonRecord {
                    id: parsed.id.unwrap_or_default(),
                    scope: scope.to_string(),
                    title: parsed.title,
                    symptom: root_cause.clone(),
                    root_cause,
                    invariant,
                    anti_pattern: String::new(),
                    verify_cmd: parsed.verify_cmd,
                    tags: vec!["synced".to_string()],
                    provenance_sha: String::new(),
                    promoted_skill_slug: None,
                    overlap_warning: None,
                    created_at_ms: 0,
                };
                if os.capture_lesson(rec, false).is_ok() {
                    imported_from_disk += 1;
                }
            }
        }
    }

    let all_lessons = os.list_lessons(None).map_err(|e| anyhow::anyhow!(e))?;
    let global_lessons: Vec<LessonRecord> = all_lessons
        .iter()
        .filter(|l| l.scope == "global")
        .cloned()
        .collect();
    let project_lessons: Vec<LessonRecord> = all_lessons
        .iter()
        .filter(|l| l.scope != "global")
        .cloned()
        .collect();

    let global_written = mirror_lessons_markdown(
        global_path,
        "Omnia Global Lessons",
        &global_lessons,
        GLOBAL_LESSONS_MAX_ENTRIES,
    )?;
    let project_written = if !project_lessons.is_empty() || proj_path.is_file() {
        mirror_lessons_markdown(
            &proj_path,
            "Workspace Lessons",
            &project_lessons,
            GLOBAL_LESSONS_MAX_ENTRIES,
        )?
    } else {
        0
    };
    let cross_host_written =
        if let Some(ch_path) = cross_host_mirror.filter(|p| !global_lessons.is_empty() || p.is_file())
        {
            mirror_lessons_markdown(
                ch_path,
                "Omnia Global Lessons",
                &global_lessons,
                GLOBAL_LESSONS_MAX_ENTRIES,
            )?
        } else {
            0
        };

    Ok(json!({
        "ok": true,
        "totalLessons": all_lessons.len(),
        "projectLessons": project_lessons.len(),
        "globalLessons": global_lessons.len(),
        "importedFromDisk": imported_from_disk,
        "globalMirrorPath": global_path.display().to_string(),
        "globalMirrorCount": global_written,
        "projectMirrorPath": proj_path.display().to_string(),
        "projectMirrorCount": project_written,
        "crossHostMirrorCount": cross_host_written,
        "cap": GLOBAL_LESSONS_MAX_ENTRIES,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir_for(tag: &str) -> PathBuf {
        let dir = env::temp_dir().join(format!(
            "omnia_cli_super_{}_{}_{}",
            tag,
            std::process::id(),
            &omnia_core::uuid_v4()[..8]
        ));
        let _ = fs::create_dir_all(&dir);
        dir
    }

    #[test]
    fn proceed_engine_state_roundtrips_modes_and_keeps_token_budget_null() {
        let ws = temp_dir_for("proceed");
        let initial = read_engine_state(&ws);
        assert_eq!(initial.auto_proceed, AutoProceedMode::Off);
        assert!(!initial.auto_proceed_enabled);
        assert!(initial.token_budget.is_none());

        let (st1, path1) = set_auto_proceed(&ws, AutoProceedMode::RecommendedOnly).unwrap();
        assert_eq!(st1.auto_proceed, AutoProceedMode::RecommendedOnly);
        assert!(st1.auto_proceed_enabled);
        assert!(st1.token_budget.is_none());
        assert!(path1.ends_with(Path::new(".agents").join("super").join("engine_state.json")));

        let raw = fs::read_to_string(&path1).unwrap();
        assert!(!raw.contains('\r'), "engine_state.json must be pure Unix LF");
        assert!(raw.contains("\"tokenBudget\": null"));

        let (st2, _) = set_super_workflow_mode(&ws, "super_plan", Some("Ship Wave 2"), None).unwrap();
        assert_eq!(st2.mode, "super_plan");
        assert_eq!(st2.active_goal.as_deref(), Some("Ship Wave 2"));
        assert_eq!(st2.auto_proceed, AutoProceedMode::RecommendedOnly);

        let (st3, _) = set_auto_proceed(&ws, AutoProceedMode::try_parse("on").unwrap()).unwrap();
        assert_eq!(st3.auto_proceed, AutoProceedMode::Full);
        assert!(AutoProceedMode::try_parse("invalid-mode").is_err());

        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn global_lessons_sync_dedups_redacts_and_caps_at_100() {
        let ws = temp_dir_for("lessons");
        let global_md = ws.join("global_lessons.md");
        let os = ArtifactOs::open_in_memory(&ws).unwrap();

        let rec = LessonRecord {
            id: "lsn-demo-1".into(),
            scope: "global".into(),
            title: "Guard MSVC delayload".into(),
            symptom: "Crash with sk-dummy-1234567890abcdef1234567890".into(),
            root_cause: "Dual casing WS2_32.dll".into(),
            invariant: "Never delayload ws2_32.dll".into(),
            anti_pattern: String::new(),
            verify_cmd: "cargo check".into(),
            tags: vec!["msvc".into()],
            provenance_sha: String::new(),
            promoted_skill_slug: None,
            overlap_warning: None,
            created_at_ms: 0,
        };
        os.capture_lesson(rec, false).unwrap();

        // Pre-seed disk file with an extra entry and a duplicate entry.
        fs::write(
            &global_md,
            "# Omnia Global Lessons\n\n## Guard MSVC delayload (`lsn-dup`)\n- **Root Cause**: dup\n- **Invariant**: dup\n\n## Imported Disk Lesson (`lsn-disk-1`)\n- **Root Cause**: disk cause\n- **Invariant**: disk invariant\n",
        )
        .unwrap();

        let rep = sync_lessons_to_paths(&os, &ws, &global_md, None).unwrap();
        assert_eq!(rep["ok"], json!(true));
        assert_eq!(rep["importedFromDisk"], json!(1));
        assert_eq!(rep["globalMirrorCount"], json!(2));

        let md = fs::read_to_string(&global_md).unwrap();
        assert!(!md.contains('\r'));
        assert!(md.contains("Guard MSVC delayload"));
        assert!(md.contains("Imported Disk Lesson"));
        assert!(!md.contains("sk-dummy-1234567890abcdef1234567890"));

        let _ = fs::remove_dir_all(&ws);
    }
}
