//! Content-Addressed BLAKE3 + Deflate Turn Checkpointing, Atomic `/rewind`,
//! and Execution Regression Detector (D2, `arXiv:2611.14960` / SWE-Search).
//!
//! - Captures Copy-on-Write pre-mutation snapshots ONLY for files actually touched in a turn
//!   (never full-repo scans, never writes any file inside user workspaces!).
//! - Rewinds all file mutations after turn `t_k` atomically in $O(|\Delta|)$ time.
//! - Parses test pass/fail counts (`pytest`, `cargo test`, `jest`/`vitest`/`bun test`) and
//!   emits an immediate `[Regression Alert]` if an edit breaks a previously passing test suite.

use crate::agent_store::AgentStore;
use crate::cache_guard::blake3_hex;
use crate::edit::FileReadTracker;
use crate::path_guard::ensure_within_workspace;
use crate::sanitizer::atomic_write_bytes;
use anyhow::{Context, Result};
use flate2::read::DeflateDecoder;
use flate2::write::DeflateEncoder;
use flate2::Compression;
use regex::Regex;
use rustc_hash::FxHashMap;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::OnceLock;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct TestPassCounts {
    pub passed: u32,
    pub failed: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TurnCheckpoint {
    pub session_id: String,
    pub turn_idx: u32,
    /// Map of `rel_path` -> `Some(blake3_hex)` if file existed before mutation, or `None` if newly created.
    pub pre_files: BTreeMap<String, Option<String>>,
    pub test_summary: Option<TestPassCounts>,
}

#[derive(Clone)]
pub struct TurnCheckpointStore {
    session_id: String,
    db: Option<AgentStore>,
    mem_blobs: FxHashMap<String, Vec<u8>>,
    turns: BTreeMap<u32, TurnCheckpoint>,
    /// Best verified green/highest-pass state observed: `(turn_idx, passed, failed)`
    pub best_verified: Option<(u32, u32, u32)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TestOutcomeTransition {
    /// Suite transitioned from previously failing tests to 0 failures (Anti-Termination-Lag stop signal!).
    FailToPass { prev_failed: u32, passed: u32 },
    /// First observed all-green test run (`passed > 0 && failed == 0`).
    AllGreen { passed: u32 },
    /// Suite regressed relative to `best_verified`.
    Regression(String),
    /// Non-terminal or still-failing run.
    Neutral,
}

impl TurnCheckpointStore {
    pub fn new(session_id: impl Into<String>, db: Option<AgentStore>) -> Self {
        Self {
            session_id: session_id.into(),
            db,
            mem_blobs: FxHashMap::default(),
            turns: BTreeMap::new(),
            best_verified: None,
        }
    }

    /// Rehydrate persisted turn checkpoints for `session_id` from `AgentStore` (for CLI `omnia rewind`).
    pub fn load_from_store(session_id: impl Into<String>, db: AgentStore) -> Result<Self> {
        let sid = session_id.into();
        let rows = db.load_turn_checkpoints(&sid)?;
        let mut turns = BTreeMap::new();
        for (turn_idx, manifest_json) in rows {
            if let Ok(cp) = serde_json::from_str::<TurnCheckpoint>(&manifest_json) {
                turns.insert(turn_idx, cp);
            }
        }
        Ok(Self {
            session_id: sid,
            db: Some(db),
            mem_blobs: FxHashMap::default(),
            turns,
            best_verified: None,
        })
    }

    /// Detailed test transition tracker powering BOTH `[Regression Alert]` AND
    /// Anti-Termination-Lag (`arXiv:2611.14960`) `FAIL -> PASS` convergence signaling!
    pub fn record_test_outcome_detailed(
        &mut self,
        turn_idx: u32,
        shell_output: &str,
    ) -> TestOutcomeTransition {
        let Some(counts) = parse_test_pass_counts(shell_output) else {
            return TestOutcomeTransition::Neutral;
        };
        if let Some(cp) = self.turns.get_mut(&turn_idx) {
            cp.test_summary = Some(counts);
        }

        if let Some((best_t, best_p, best_f)) = self.best_verified {
            let regressed = (best_f == 0 && counts.failed > 0)
                || (counts.passed < best_p && counts.failed >= best_f);
            if regressed && turn_idx > best_t {
                return TestOutcomeTransition::Regression(format!(
                    "[Regression Alert] Turn {turn_idx} degraded tests ({best_p} passed/{best_f} failed at Turn {best_t} -> {} passed/{} failed). Inspect your last diff or revert to Turn {best_t}.",
                    counts.passed, counts.failed
                ));
            }
            if counts.failed == 0 && counts.passed > 0 && best_f > 0 {
                self.best_verified = Some((turn_idx, counts.passed, 0));
                return TestOutcomeTransition::FailToPass {
                    prev_failed: best_f,
                    passed: counts.passed,
                };
            }
            if counts.failed < best_f || (counts.failed == best_f && counts.passed >= best_p) {
                self.best_verified = Some((turn_idx, counts.passed, counts.failed));
            }
            if counts.failed == 0 && counts.passed > 0 {
                return TestOutcomeTransition::AllGreen {
                    passed: counts.passed,
                };
            }
        } else if counts.passed > 0 || counts.failed > 0 {
            self.best_verified = Some((turn_idx, counts.passed, counts.failed));
            if counts.failed == 0 && counts.passed > 0 {
                return TestOutcomeTransition::AllGreen {
                    passed: counts.passed,
                };
            }
        }
        TestOutcomeTransition::Neutral
    }

    /// Snapshot original bytes BEFORE a file is modified/created/deleted in `turn_idx`.
    /// Idempotent per `(turn_idx, rel_path)` so multiple edits to the same file in one turn
    /// always preserve its true pre-turn state.
    pub fn record_pre_mutation(&mut self, turn_idx: u32, rel_path: &str, abs_path: &Path) {
        let norm = rel_path.trim().replace('\\', "/");
        if norm.is_empty() {
            return;
        }
        let cp = self
            .turns
            .entry(turn_idx)
            .or_insert_with(|| TurnCheckpoint {
                session_id: self.session_id.clone(),
                turn_idx,
                pre_files: BTreeMap::new(),
                test_summary: None,
            });
        if cp.pre_files.contains_key(&norm) {
            return;
        }

        let pre_hash = if abs_path.is_file() {
            if let Ok(raw) = fs::read(abs_path) {
                let hex = blake3_hex(&raw);
                if !self.mem_blobs.contains_key(&hex) {
                    if let Ok(compressed) = deflate_bytes(&raw) {
                        if let Some(ref db) = self.db {
                            let _ = db.put_checkpoint_blob(&hex, &compressed, raw.len());
                        }
                        self.mem_blobs.insert(hex.clone(), compressed);
                    }
                }
                Some(hex)
            } else {
                None
            }
        } else {
            None
        };

        cp.pre_files.insert(norm, pre_hash);
        if let Some(ref db) = self.db {
            if let Ok(manifest_json) = serde_json::to_string(cp) {
                let _ = db.save_turn_checkpoint(&self.session_id, turn_idx, &manifest_json);
            }
        }
    }

    /// Parse test pass/fail counts from `shell` output and return a `[Regression Alert]`
    /// if the suite regressed relative to `best_verified`.
    pub fn record_test_outcome(&mut self, turn_idx: u32, shell_output: &str) -> Option<String> {
        let counts = parse_test_pass_counts(shell_output)?;
        if let Some(cp) = self.turns.get_mut(&turn_idx) {
            cp.test_summary = Some(counts);
        }

        if let Some((best_t, best_p, best_f)) = self.best_verified {
            let regressed = (best_f == 0 && counts.failed > 0)
                || (counts.passed < best_p && counts.failed >= best_f);
            if regressed && turn_idx > best_t {
                return Some(format!(
                    "[Regression Alert] Turn {turn_idx} degraded tests ({best_p} passed/{best_f} failed at Turn {best_t} -> {} passed/{} failed). Inspect your last diff or revert to Turn {best_t}.",
                    counts.passed, counts.failed
                ));
            }
            // Promote best_verified if strictly better (fewer failures, or equal failures and >= passes)
            if counts.failed < best_f || (counts.failed == best_f && counts.passed >= best_p) {
                self.best_verified = Some((turn_idx, counts.passed, counts.failed));
            }
        } else if counts.passed > 0 || counts.failed > 0 {
            self.best_verified = Some((turn_idx, counts.passed, counts.failed));
        }
        None
    }

    /// Atomically rewind all workspace mutations made in turns `> target_turn`.
    pub fn rollback_to_turn(
        &mut self,
        target_turn: u32,
        workspace_root: &Path,
        tracker: &FileReadTracker,
    ) -> Result<Vec<String>> {
        // Walk turns > target_turn in reverse chronological order so earliest pre-state wins!
        let later_turns: Vec<u32> = self
            .turns
            .keys()
            .copied()
            .filter(|&t| t > target_turn)
            .collect();
        let mut restore_plan: BTreeMap<String, Option<String>> = BTreeMap::new();
        for &t in later_turns.iter().rev() {
            if let Some(cp) = self.turns.get(&t) {
                for (rel, pre_hash) in &cp.pre_files {
                    restore_plan.insert(rel.clone(), pre_hash.clone());
                }
            }
        }

        let mut restored = Vec::new();
        for (rel, pre_hash_opt) in restore_plan {
            let abs = ensure_within_workspace(workspace_root, &rel)?;
            match pre_hash_opt {
                Some(hex) => {
                    let compressed = self
                        .mem_blobs
                        .get(&hex)
                        .cloned()
                        .or_else(|| {
                            self.db
                                .as_ref()
                                .and_then(|d| d.get_checkpoint_blob(&hex).ok().flatten())
                        })
                        .with_context(|| format!("missing checkpoint blob {hex} for '{rel}'"))?;
                    let raw = inflate_bytes(&compressed)?;
                    atomic_write_bytes(&abs, &raw)?;
                    tracker.record_read(&abs, &raw);
                }
                None => {
                    if abs.exists() {
                        let _ = fs::remove_file(&abs);
                    }
                }
            }
            restored.push(rel);
        }

        for t in later_turns {
            self.turns.remove(&t);
        }
        if let Some((bt, _, _)) = self.best_verified {
            if bt > target_turn {
                self.best_verified = None;
            }
        }
        Ok(restored)
    }

    pub fn checkpoint_count(&self) -> usize {
        self.turns.len()
    }
}

fn deflate_bytes(raw: &[u8]) -> Result<Vec<u8>> {
    let mut enc = DeflateEncoder::new(Vec::new(), Compression::fast());
    enc.write_all(raw)?;
    Ok(enc.finish()?)
}

fn inflate_bytes(compressed: &[u8]) -> Result<Vec<u8>> {
    let mut dec = DeflateDecoder::new(compressed);
    let mut out = Vec::new();
    dec.read_to_end(&mut out)?;
    Ok(out)
}

/// Extract `(passed, failed)` counts from `pytest`, `cargo test`, `jest`/`vitest`/`bun test`, or Python `unittest`.
pub fn parse_test_pass_counts(output: &str) -> Option<TestPassCounts> {
    static CARGO_RE: OnceLock<Regex> = OnceLock::new();
    static PYTEST_PASS_RE: OnceLock<Regex> = OnceLock::new();
    static PYTEST_FAIL_RE: OnceLock<Regex> = OnceLock::new();
    static JEST_PASS_RE: OnceLock<Regex> = OnceLock::new();
    static JEST_FAIL_RE: OnceLock<Regex> = OnceLock::new();
    static UNITTEST_RE: OnceLock<Regex> = OnceLock::new();

    // 1. Cargo test: `test result: ok. 12 passed; 0 failed;`
    let cargo_re = CARGO_RE.get_or_init(|| {
        Regex::new(r"test result:\s*(?:ok|FAILED)\.\s*(\d+)\s+passed;\s*(\d+)\s+failed").unwrap()
    });
    let mut cargo_p = 0u32;
    let mut cargo_f = 0u32;
    let mut saw_cargo = false;
    for cap in cargo_re.captures_iter(output) {
        saw_cargo = true;
        cargo_p += cap[1].parse::<u32>().unwrap_or(0);
        cargo_f += cap[2].parse::<u32>().unwrap_or(0);
    }
    if saw_cargo {
        return Some(TestPassCounts {
            passed: cargo_p,
            failed: cargo_f,
        });
    }

    // 2. Jest / Vitest: `Tests: 2 failed, 14 passed, 16 total`
    let jest_p =
        JEST_PASS_RE.get_or_init(|| Regex::new(r"(?i)Tests:\s*.*?(\d+)\s+passed").unwrap());
    let jest_f =
        JEST_FAIL_RE.get_or_init(|| Regex::new(r"(?i)Tests:\s*.*?(\d+)\s+failed").unwrap());
    if let Some(line) = output.lines().rev().find(|l| l.contains("Tests:")) {
        let p = jest_p
            .captures(line)
            .and_then(|c| c[1].parse::<u32>().ok())
            .unwrap_or(0);
        let f = jest_f
            .captures(line)
            .and_then(|c| c[1].parse::<u32>().ok())
            .unwrap_or(0);
        if p > 0 || f > 0 {
            return Some(TestPassCounts {
                passed: p,
                failed: f,
            });
        }
    }

    // 3. Pytest summary line (`=== 5 passed, 1 failed in 0.23s ===` or `12 passed in 0.4s`)
    let py_p = PYTEST_PASS_RE.get_or_init(|| Regex::new(r"\b(\d+)\s+passed\b").unwrap());
    let py_f =
        PYTEST_FAIL_RE.get_or_init(|| Regex::new(r"\b(\d+)\s+(?:failed|error|errors)\b").unwrap());
    for line in output.lines().rev().take(15) {
        if line.contains("passed") || line.contains("failed") || line.contains("error") {
            let p = py_p
                .captures(line)
                .and_then(|c| c[1].parse::<u32>().ok())
                .unwrap_or(0);
            let f = py_f
                .captures(line)
                .and_then(|c| c[1].parse::<u32>().ok())
                .unwrap_or(0);
            if p > 0 || f > 0 {
                return Some(TestPassCounts {
                    passed: p,
                    failed: f,
                });
            }
        }
    }

    // 4. Python unittest: `Ran 8 tests in 0.01s` + `OK` or `FAILED (failures=2)`
    let ut_re = UNITTEST_RE.get_or_init(|| Regex::new(r"Ran\s+(\d+)\s+tests?\s+in\b").unwrap());
    if let Some(cap) = ut_re.captures(output) {
        let total = cap[1].parse::<u32>().unwrap_or(0);
        if total > 0 {
            let failed = if output.contains("FAILED (") {
                Regex::new(r"(?:failures|errors)=(\d+)")
                    .unwrap()
                    .captures_iter(output)
                    .filter_map(|c| c[1].parse::<u32>().ok())
                    .sum::<u32>()
                    .max(1)
            } else {
                0
            };
            return Some(TestPassCounts {
                passed: total.saturating_sub(failed),
                failed,
            });
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checkpoint_restores_modified_created_and_deleted_files_atomically() {
        let tmp = std::env::temp_dir().join(format!("omni_cp_test_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&tmp).unwrap();
        let f_mod = tmp.join("mod.py");
        let f_del = tmp.join("del.py");
        let f_new = tmp.join("new.py");
        fs::write(&f_mod, "v = 1\n").unwrap();
        fs::write(&f_del, "keep_me = True\n").unwrap();

        let db = AgentStore::open_in_memory().unwrap();
        let mut store = TurnCheckpointStore::new("sess-cp", Some(db));
        let tracker = FileReadTracker::new();

        // Turn 2 mutates mod.py, deletes del.py, creates new.py
        store.record_pre_mutation(2, "mod.py", &f_mod);
        fs::write(&f_mod, "v = 2\n").unwrap();
        store.record_pre_mutation(2, "del.py", &f_del);
        fs::remove_file(&f_del).unwrap();
        store.record_pre_mutation(2, "new.py", &f_new);
        fs::write(&f_new, "created = 1\n").unwrap();

        // Turn 3 edits mod.py again
        store.record_pre_mutation(3, "mod.py", &f_mod);
        fs::write(&f_mod, "v = 3\n").unwrap();

        // Rewind back to Turn 1 (undoing Turn 2 & Turn 3!)
        let restored = store.rollback_to_turn(1, &tmp, &tracker).unwrap();
        assert_eq!(restored.len(), 3);
        assert_eq!(fs::read_to_string(&f_mod).unwrap(), "v = 1\n");
        assert_eq!(fs::read_to_string(&f_del).unwrap(), "keep_me = True\n");
        assert!(
            !f_new.exists(),
            "newly created file must be removed on rewind"
        );

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn regression_detector_emits_alert_when_passing_suite_regresses_after_edit() {
        let mut store = TurnCheckpointStore::new("sess-reg", None);
        assert!(store
            .record_test_outcome(2, "=== 14 passed in 0.41s ===")
            .is_none());
        assert_eq!(store.best_verified, Some((2, 14, 0)));

        let alert = store
            .record_test_outcome(4, "=== 12 passed, 2 failed in 0.55s ===")
            .expect("regression from 14/0 to 12/2 must emit Regression Alert");
        assert!(alert.contains("[Regression Alert]"));
        assert!(alert.contains("Turn 2"));
        assert!(alert.contains("14 passed/0 failed"));
    }

    #[test]
    fn test_outcome_transition_detects_fail_to_pass_convergence_and_regression() {
        let mut store = TurnCheckpointStore::new("sess-atl", None);
        let t1 = store.record_test_outcome_detailed(1, "=== 5 passed, 2 failed in 0.2s ===");
        assert_eq!(t1, TestOutcomeTransition::Neutral);

        // FAIL -> PASS transition emits immediate FailToPass Anti-Termination-Lag signal!
        let t2 = store.record_test_outcome_detailed(2, "=== 7 passed in 0.2s ===");
        assert_eq!(
            t2,
            TestOutcomeTransition::FailToPass {
                prev_failed: 2,
                passed: 7
            }
        );

        // Subsequent all-green run stays AllGreen
        let t3 = store.record_test_outcome_detailed(3, "=== 7 passed in 0.2s ===");
        assert_eq!(t3, TestOutcomeTransition::AllGreen { passed: 7 });

        // Regressing from 7/0 -> 6/1 emits Regression + alert
        let t4 = store.record_test_outcome_detailed(4, "=== 6 passed, 1 failed in 0.2s ===");
        assert!(
            matches!(t4, TestOutcomeTransition::Regression(ref msg) if msg.contains("[Regression Alert]"))
        );
    }

    #[test]
    fn checkpoint_store_persists_and_rewinds_across_winsqlite_reload() {
        let tmp = std::env::temp_dir().join(format!("omni_cp_reload_{}", uuid::Uuid::new_v4()));
        let data_dir = tmp.join("db");
        let ws = tmp.join("ws");
        fs::create_dir_all(&data_dir).unwrap();
        fs::create_dir_all(&ws).unwrap();
        let app = ws.join("app.py");
        fs::write(&app, "version = 1\n").unwrap();

        {
            let db = AgentStore::open(&data_dir).unwrap();
            let mut store = TurnCheckpointStore::new("sess-persist", Some(db));
            store.record_pre_mutation(2, "app.py", &app);
            fs::write(&app, "version = 2\n").unwrap();
        }

        // Re-open from SQLite WAL in a fresh TurnCheckpointStore and rewind!
        let db2 = AgentStore::open(&data_dir).unwrap();
        assert_eq!(
            db2.latest_checkpoint_session().unwrap().as_deref(),
            Some("sess-persist")
        );
        let mut reloaded = TurnCheckpointStore::load_from_store("sess-persist", db2).unwrap();
        let tracker = FileReadTracker::new();
        let restored = reloaded.rollback_to_turn(1, &ws, &tracker).unwrap();
        assert_eq!(restored, vec!["app.py".to_string()]);
        assert_eq!(fs::read_to_string(&app).unwrap(), "version = 1\n");

        let _ = fs::remove_dir_all(&tmp);
    }
}
