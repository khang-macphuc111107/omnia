//! Git Temporal Co-Change & Churn Gravity Forensics.
//!
//! Computes symmetric temporal co-change Jaccard coupling from recent commit history
//! (`git --no-optional-locks log -n 200 --name-only --pretty=format:---`), skipping
//! bulk commits touching `> 25` files (merges/reformats) and caching per `HEAD` OID.
//! Non-git workspaces return `None` immediately with zero subprocess overhead.

use crate::path_guard::sanitize_windows_path;
use crate::supervisor::spawn_supervised_command;
use anyhow::{bail, Context, Result};
use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::LazyLock;

const MAX_FILES_PER_COMMIT: usize = 25;
const MIN_SHARED_COMMITS: u32 = 2;
const MIN_JACCARD: f64 = 0.25;

static GIT_BIN: LazyLock<PathBuf> = LazyLock::new(|| {
    if let Ok(found) = which::which("git") {
        return found;
    }
    #[cfg(windows)]
    {
        for cand in [
            r"C:\Program Files\Git\cmd\git.exe",
            r"C:\Program Files\Git\bin\git.exe",
            r"C:\Program Files (x86)\Git\cmd\git.exe",
        ] {
            let p = PathBuf::from(cand);
            if p.is_file() {
                return p;
            }
        }
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            let p = PathBuf::from(local)
                .join("Programs")
                .join("Git")
                .join("cmd")
                .join("git.exe");
            if p.is_file() {
                return p;
            }
        }
    }
    PathBuf::from("git")
});

pub fn run_git(repo_path: &Path, args: &[&str]) -> Result<String> {
    let bytes = run_git_bytes(repo_path, args)?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Run git cleanly with `--no-optional-locks`, `GIT_TERMINAL_PROMPT=0`, and Win32 hidden supervision.
pub fn run_git_bytes(repo_path: &Path, args: &[&str]) -> Result<Vec<u8>> {
    let clean = sanitize_windows_path(repo_path);
    let mut cmd = Command::new(GIT_BIN.as_path());
    cmd.arg("--no-optional-locks")
        .args(args)
        .current_dir(&clean)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let (child, _sup) = spawn_supervised_command(&mut cmd)
        .with_context(|| format!("failed to spawn git {:?}", args))?;
    let out = child.wait_with_output()?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        bail!("git {} failed: {}", args.join(" "), stderr.trim());
    }
    Ok(out.stdout)
}

/// Run git passing arbitrary bytes on stdin (e.g., `git apply` with a patch buffer).
pub fn run_git_with_stdin(repo_path: &Path, args: &[&str], stdin_bytes: &[u8]) -> Result<String> {
    use std::io::Write;
    let clean = sanitize_windows_path(repo_path);
    let mut cmd = Command::new(GIT_BIN.as_path());
    cmd.arg("--no-optional-locks")
        .args(args)
        .current_dir(&clean)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let (mut child, _sup) = spawn_supervised_command(&mut cmd)
        .with_context(|| format!("failed to spawn git {:?}", args))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(stdin_bytes)?;
    }
    let out = child.wait_with_output()?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        bail!("git {} failed: {}", args.join(" "), stderr.trim());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

#[derive(Debug, Clone, PartialEq)]
pub struct CoChangeEdge {
    pub a: String,
    pub b: String,
    pub shared_commits: u32,
    pub jaccard: f64,
}

#[derive(Debug, Clone)]
pub struct GitForensicsReport {
    pub head_oid: String,
    pub file_commits: HashMap<String, u32>,
    pub cochange_edges: Vec<CoChangeEdge>,
}

/// Fast zero-spawn check + `git rev-parse HEAD` probe.
pub fn probe_git_head_oid(repo_path: &Path) -> Option<String> {
    if !repo_path.join(".git").exists() {
        return None;
    }
    let out = run_git(repo_path, &["rev-parse", "HEAD"]).ok()?;
    let trimmed = out.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// Compute Git temporal co-change edges & per-file commit churn for a repository.
/// Returns `None` immediately with zero process spawns if `repo_path` is not a Git repository.
pub fn compute_git_cochange(repo_path: &Path, max_commits: usize) -> Option<GitForensicsReport> {
    let head_oid = probe_git_head_oid(repo_path)?;
    let n_arg = max_commits.clamp(10, 500).to_string();
    let raw = run_git(
        repo_path,
        &["log", "-n", &n_arg, "--name-only", "--pretty=format:---"],
    )
    .ok()?;
    let (file_commits, cochange_edges) = parse_cochange_log(&raw);
    Some(GitForensicsReport {
        head_oid,
        file_commits,
        cochange_edges,
    })
}

/// Pure parser for `git log --name-only --pretty=format:---` output.
pub fn parse_cochange_log(raw: &str) -> (HashMap<String, u32>, Vec<CoChangeEdge>) {
    let mut file_commits: HashMap<String, u32> = HashMap::new();
    let mut pair_counts: HashMap<(String, String), u32> = HashMap::new();

    for block in raw.split("---") {
        let mut files: BTreeSet<String> = BTreeSet::new();
        for line in block.lines() {
            let trimmed = line.trim().replace('\\', "/");
            if !trimmed.is_empty() {
                files.insert(trimmed);
            }
        }
        if files.is_empty() || files.len() > MAX_FILES_PER_COMMIT {
            continue;
        }
        let ordered: Vec<String> = files.into_iter().collect();
        for f in &ordered {
            *file_commits.entry(f.clone()).or_insert(0) += 1;
        }
        for i in 0..ordered.len() {
            for j in (i + 1)..ordered.len() {
                let key = (ordered[i].clone(), ordered[j].clone());
                *pair_counts.entry(key).or_insert(0) += 1;
            }
        }
    }

    let mut edges = Vec::new();
    for ((a, b), shared) in pair_counts {
        if shared < MIN_SHARED_COMMITS {
            continue;
        }
        let na = file_commits.get(&a).copied().unwrap_or(shared);
        let nb = file_commits.get(&b).copied().unwrap_or(shared);
        let union = na.saturating_add(nb).saturating_sub(shared);
        if union == 0 {
            continue;
        }
        let jaccard = shared as f64 / union as f64;
        if jaccard >= MIN_JACCARD {
            edges.push(CoChangeEdge {
                a,
                b,
                shared_commits: shared,
                jaccard,
            });
        }
    }

    edges.sort_by(|x, y| {
        y.jaccard
            .total_cmp(&x.jaccard)
            .then_with(|| y.shared_commits.cmp(&x.shared_commits))
            .then_with(|| x.a.cmp(&y.a))
    });
    (file_commits, edges)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn git_cochange_extracts_jaccard_edges_and_skips_bulk_commits_over_25_files() {
        let mut bulk = String::from("---\n");
        for i in 0..30 {
            bulk.push_str(&format!("bulk/file_{i}.py\n"));
        }
        let log = format!(
            "---\nsrc/compiler.py\nschema.json\n\
---\nsrc/compiler.py\nschema.json\ntests/test_compiler.py\n\
---\nsrc/compiler.py\nschema.json\n\
---\nsrc/unrelated.py\n\
{bulk}"
        );

        let (churn, edges) = parse_cochange_log(&log);
        assert!(!churn.contains_key("bulk/file_0.py"));
        assert_eq!(churn.get("src/compiler.py"), Some(&3));
        assert_eq!(churn.get("schema.json"), Some(&3));

        let top = edges
            .iter()
            .find(|e| {
                (e.a == "schema.json" && e.b == "src/compiler.py")
                    || (e.b == "schema.json" && e.a == "src/compiler.py")
            })
            .expect("expected co-change edge between schema.json and src/compiler.py");
        assert_eq!(top.shared_commits, 3);
        assert!((top.jaccard - 1.0).abs() < 1e-6);

        let tmp = std::env::temp_dir().join(format!("omni_nongit_{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        assert!(compute_git_cochange(&tmp, 50).is_none());
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
