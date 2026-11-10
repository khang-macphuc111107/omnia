//! Language-server registry: built-in defaults plus `lsp.json` overrides.

use std::path::{Path, PathBuf};

use serde_json::Value;

#[derive(Debug, Clone, PartialEq)]
pub struct ServerSpec {
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    /// Lower-case extensions without the dot.
    pub extensions: Vec<String>,
    pub initialization_options: Option<Value>,
    pub source: SpecSource,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpecSource {
    Project,
    User,
    Default,
}

#[derive(Clone, Debug, Default)]
pub struct LoadedSpecs {
    /// Priority order: project, user, built-in.
    pub specs: Vec<ServerSpec>,
    pub warnings: Vec<String>,
}

fn spec(name: &str, command: &str, args: &[&str], exts: &[&str]) -> ServerSpec {
    ServerSpec {
        name: name.into(),
        command: command.into(),
        args: args.iter().map(|a| a.to_string()).collect(),
        extensions: exts.iter().map(|e| e.to_string()).collect(),
        initialization_options: None,
        source: SpecSource::Default,
    }
}

pub fn default_specs() -> Vec<ServerSpec> {
    vec![
        spec("rust-analyzer", "rust-analyzer", &[], &["rs"]),
        spec(
            "typescript-language-server",
            "typescript-language-server",
            &["--stdio"],
            &["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts"],
        ),
        spec(
            "pyright",
            "pyright-langserver",
            &["--stdio"],
            &["py", "pyi"],
        ),
        spec("pylsp", "pylsp", &[], &["py", "pyi"]),
        spec("gopls", "gopls", &[], &["go"]),
        spec(
            "clangd",
            "clangd",
            &[],
            &["c", "cc", "cpp", "cxx", "h", "hh", "hpp", "hxx"],
        ),
    ]
}

/// Install hint shown when no server handles `ext`.
pub fn install_hint(ext: &str) -> &'static str {
    match ext {
        "rs" => "Install rust-analyzer: `rustup component add rust-analyzer`.",
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" | "mts" | "cts" => {
            "Install: `npm i -g typescript-language-server typescript`."
        }
        "py" | "pyi" => "Install: `npm i -g pyright` or `pip install python-lsp-server`.",
        "go" => "Install: `go install golang.org/x/tools/gopls@latest`.",
        "c" | "cc" | "cpp" | "cxx" | "h" | "hh" | "hpp" | "hxx" => {
            "Install clangd (LLVM): https://clangd.llvm.org/installation."
        }
        _ => "No built-in server knows this extension.",
    }
}

/// LSP `languageId` for a file extension.
pub fn language_id(ext: &str) -> String {
    match ext {
        "rs" => "rust",
        "ts" | "mts" | "cts" => "typescript",
        "tsx" => "typescriptreact",
        "js" | "mjs" | "cjs" => "javascript",
        "jsx" => "javascriptreact",
        "py" | "pyi" => "python",
        "go" => "go",
        "c" => "c",
        "cc" | "cpp" | "cxx" | "h" | "hh" | "hpp" | "hxx" => "cpp",
        other => other,
    }
    .to_string()
}

fn parse_bytes(path: &Path, bytes: &[u8], source: SpecSource, out: &mut LoadedSpecs) {
    let text = match std::str::from_utf8(bytes) {
        Ok(text) => text,
        Err(error) => {
            out.warnings
                .push(format!("{}: invalid UTF-8 ({error})", path.display()));
            return;
        }
    };
    let root: Value = match serde_json::from_str(text.trim_start_matches('\u{feff}')) {
        Ok(value) => value,
        Err(error) => {
            out.warnings
                .push(format!("{}: invalid JSON ({error})", path.display()));
            return;
        }
    };
    let Some(servers) = root.get("servers").and_then(Value::as_object) else {
        out.warnings
            .push(format!("{}: missing `servers` object", path.display()));
        return;
    };
    for (name, entry) in servers {
        let command = entry.get("command").and_then(Value::as_str).unwrap_or("");
        let extensions: Vec<String> = entry
            .get("extensions")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(|e| e.trim_start_matches('.').to_ascii_lowercase())
                    .filter(|e| !e.is_empty())
                    .collect()
            })
            .unwrap_or_default();
        if command.is_empty() || extensions.is_empty() {
            out.warnings.push(format!(
                "{}: server `{name}` needs `command` and a non-empty `extensions`",
                path.display()
            ));
            continue;
        }
        out.specs.push(ServerSpec {
            name: name.clone(),
            command: command.to_string(),
            args: entry
                .get("args")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_str)
                        .map(String::from)
                        .collect()
                })
                .unwrap_or_default(),
            extensions,
            initialization_options: entry.get("initializationOptions").cloned(),
            source,
        });
    }
}

fn parse_file(path: &Path, source: SpecSource, out: &mut LoadedSpecs) {
    let Ok(bytes) = std::fs::read(path) else {
        return;
    };
    parse_bytes(path, &bytes, source, out);
}

/// Merges project (only when `trusted`), user and built-in servers. A server
/// name defined at a higher priority hides the same name below it.
/// Merges exact config bytes captured by the native trust snapshot. Missing
/// inputs mean the file was absent in that snapshot; no file is re-read here.
/// The caller must establish trust for project bytes before calling this.
pub fn load_specs_from_snapshot(
    cwd: &Path,
    project_bytes: Option<&[u8]>,
    user_config: Option<(&Path, &[u8])>,
) -> LoadedSpecs {
    let mut out = LoadedSpecs::default();
    let project = cwd.join(".omnia").join("lsp.json");
    if let Some(bytes) = project_bytes {
        parse_bytes(&project, bytes, SpecSource::Project, &mut out);
    }
    if let Some((path, bytes)) = user_config {
        parse_bytes(path, bytes, SpecSource::User, &mut out);
    }
    finish_specs(out)
}

pub fn load_specs(omnia_home: Option<&Path>, cwd: &Path, trusted: bool) -> LoadedSpecs {
    let mut out = LoadedSpecs::default();
    let project = cwd.join(".omnia").join("lsp.json");
    if project.is_file() {
        if trusted {
            parse_file(&project, SpecSource::Project, &mut out);
        } else {
            out.warnings.push(format!(
                "{} ignored: the workspace is not trusted",
                project.display()
            ));
        }
    }
    if let Some(home) = omnia_home {
        parse_file(&home.join("lsp.json"), SpecSource::User, &mut out);
    }
    finish_specs(out)
}

fn finish_specs(mut out: LoadedSpecs) -> LoadedSpecs {
    out.specs.extend(default_specs());
    let mut seen = std::collections::HashSet::new();
    out.specs.retain(|s| seen.insert(s.name.clone()));
    out
}

/// Resolves `command` to an executable, honouring Windows shims
/// (`.cmd`/`.bat`/`.exe`). `dirs` are the PATH entries.
pub fn resolve_command(command: &str, dirs: &[PathBuf]) -> Option<PathBuf> {
    let exts: &[&str] = if cfg!(windows) {
        &[".exe", ".cmd", ".bat", ".com"]
    } else {
        &[""]
    };
    let has_ext = Path::new(command).extension().is_some();
    let mut names: Vec<String> = Vec::new();
    if has_ext || !cfg!(windows) {
        names.push(command.to_string());
    }
    if cfg!(windows) {
        names.extend(exts.iter().map(|e| format!("{command}{e}")));
    }
    if command.contains('/') || command.contains('\\') {
        return names.iter().map(PathBuf::from).find(|p| p.is_file());
    }
    for dir in dirs {
        for name in &names {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

pub fn path_dirs() -> Vec<PathBuf> {
    std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default()
}

/// Specs that handle `ext`, in priority order.
pub fn specs_for_extension<'a>(specs: &'a [ServerSpec], ext: &str) -> Vec<&'a ServerSpec> {
    specs
        .iter()
        .filter(|s| s.extensions.iter().any(|e| e == ext))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn write(path: &Path, value: Value) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, value.to_string()).unwrap();
    }

    #[test]
    fn defaults_cover_common_languages() {
        let specs = default_specs();
        for ext in ["rs", "ts", "tsx", "js", "jsx", "py", "go", "c", "cpp", "h"] {
            assert!(!specs_for_extension(&specs, ext).is_empty(), "{ext}");
        }
        assert_eq!(specs_for_extension(&specs, "py").len(), 2);
    }

    #[test]
    fn merge_priority_and_trust_gating() {
        let home = tempfile::tempdir().unwrap();
        let cwd = tempfile::tempdir().unwrap();
        write(
            &home.path().join("lsp.json"),
            json!({"servers": {
                "gopls": {"command": "my-gopls", "extensions": [".GO"]},
                "zig": {"command": "zls", "extensions": ["zig"], "initializationOptions": {"a": 1}}
            }}),
        );
        write(
            &cwd.path().join(".omnia/lsp.json"),
            json!({"servers": {"gopls": {"command": "proj-gopls", "args": ["x"], "extensions": ["go"]},
                               "bad": {"command": "", "extensions": []}}}),
        );

        let untrusted = load_specs(Some(home.path()), cwd.path(), false);
        let go = specs_for_extension(&untrusted.specs, "go");
        assert_eq!(go[0].command, "my-gopls");
        assert_eq!(go[0].source, SpecSource::User);
        assert!(untrusted.warnings.iter().any(|w| w.contains("not trusted")));
        assert!(untrusted
            .specs
            .iter()
            .all(|s| s.source != SpecSource::Project));

        let trusted = load_specs(Some(home.path()), cwd.path(), true);
        let go = specs_for_extension(&trusted.specs, "go");
        assert_eq!(go.len(), 1, "same-name defaults are hidden");
        assert_eq!(go[0].command, "proj-gopls");
        assert_eq!(go[0].args, ["x"]);
        assert!(trusted.warnings.iter().any(|w| w.contains("`bad`")));
        let zig = &specs_for_extension(&trusted.specs, "zig")[0];
        assert_eq!(zig.initialization_options, Some(json!({"a": 1})));
        assert_eq!(language_id("zig"), "zig");
    }

    #[test]
    fn invalid_json_is_a_warning() {
        let cwd = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(cwd.path().join(".omnia")).unwrap();
        std::fs::write(cwd.path().join(".omnia/lsp.json"), "{nope").unwrap();
        let loaded = load_specs(None, cwd.path(), true);
        assert!(loaded.warnings[0].contains("invalid JSON"));
        assert_eq!(loaded.specs.len(), default_specs().len());
    }

    #[test]
    fn supplied_project_bytes_are_authoritative_over_disk_changes() {
        let cwd = tempfile::tempdir().unwrap();
        let project = cwd.path().join(".omnia/lsp.json");
        write(
            &project,
            json!({"servers": {"snapshot": {"command": "disk-command", "extensions": ["snap"]}}}),
        );
        let snapshot_bytes =
            br#"{"servers":{"snapshot":{"command":"approved-command","extensions":["snap"]}}}"#;
        let loaded = load_specs_from_snapshot(cwd.path(), Some(snapshot_bytes), None);
        std::fs::write(
            &project,
            json!({"servers": {"snapshot": {"command": "mutated-command", "extensions": ["snap"]}}}).to_string(),
        )
        .unwrap();
        let selected = specs_for_extension(&loaded.specs, "snap");
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].command, "approved-command");
    }

    #[test]
    fn absent_snapshot_file_stays_absent_and_user_snapshot_keeps_precedence() {
        let cwd = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        write(
            &cwd.path().join(".omnia/lsp.json"),
            json!({"servers": {"late": {"command": "unapproved-command", "extensions": ["late"]}}}),
        );
        let user_path = home.path().join("lsp.json");
        let user_bytes =
            br#"{"servers":{"gopls":{"command":"snapshot-user-gopls","extensions":["go"]}}}"#;
        write(
            &user_path,
            json!({"servers": {"gopls": {"command": "changed-user-command", "extensions": ["go"]}}}),
        );
        let loaded = load_specs_from_snapshot(cwd.path(), None, Some((&user_path, user_bytes)));
        assert!(specs_for_extension(&loaded.specs, "late").is_empty());
        let go = specs_for_extension(&loaded.specs, "go");
        assert_eq!(go.len(), 1);
        assert_eq!(go[0].command, "snapshot-user-gopls");
        assert_eq!(go[0].source, SpecSource::User);
    }

    #[test]
    fn resolves_windows_shims() {
        let dir = tempfile::tempdir().unwrap();
        let name = if cfg!(windows) { "tsls.cmd" } else { "tsls" };
        std::fs::write(dir.path().join(name), "").unwrap();
        let found = resolve_command("tsls", &[dir.path().to_path_buf()]).unwrap();
        assert_eq!(found, dir.path().join(name));
        assert!(resolve_command("missing-ls", &[dir.path().to_path_buf()]).is_none());
    }
}
