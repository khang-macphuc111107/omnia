//! Durable shell state (cwd + environment) across `shell` calls.
//!
//! No long-lived process: every call still spawns a fresh shell, but the user's
//! command is wrapped so that, once it finishes, the shell prints a unique
//! sentinel block with its final cwd, exit code and environment. The block is
//! captured out of band (never shown to the model); the cwd and the environment
//! *diff* are stored per (session, workspace root, shell kind) and re-applied
//! at the start of the next call.
//!
//! Wire format (every line starts with the per-call sentinel `S`):
//! * `S CWD:<path>`   final working directory
//! * `S RC:<n>`       exit status of the user's command
//! * `S A:<payload>`  environment before the command (bash/PowerShell)
//! * `S B:<payload>`  environment after the command (bash/PowerShell)
//! * `S SET` + raw `NAME=value` lines (cmd only) — environment after
//! * `S END`          block complete
//!
//! bash payloads are base64 of `env -0`; PowerShell payloads are compressed
//! JSON objects. If the command ends the shell itself (`exit`), no `END` line
//! is printed and the saved state stays unchanged.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use base64::Engine;
use serde_json::Value;

pub(crate) type EnvMap = BTreeMap<String, String>;

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub(crate) enum Kind {
    Bash,
    PowerShell,
    Cmd,
}

impl Kind {
    /// Kind for a (resolved) shell name; `None` when state is not tracked.
    pub(crate) fn of(shell: &str) -> Option<Kind> {
        match shell {
            "bash" => Some(Kind::Bash),
            "pwsh" | "powershell" => Some(Kind::PowerShell),
            "cmd" => Some(Kind::Cmd),
            _ => None,
        }
    }

    pub(crate) fn default_persist(self) -> bool {
        !matches!(self, Kind::Cmd)
    }

    pub(crate) fn name(self) -> &'static str {
        match self {
            Kind::Bash => "bash",
            Kind::PowerShell => "powershell",
            Kind::Cmd => "cmd",
        }
    }
}

/// Saved state for one shell kind.
#[derive(Clone, Default, Debug, PartialEq)]
pub(crate) struct SessionState {
    pub cwd: Option<PathBuf>,
    /// Variables set or changed relative to the harness environment.
    pub set: EnvMap,
    /// Variables removed relative to the harness environment.
    pub unset: Vec<String>,
}

type Key = (String, PathBuf, Kind);

fn store() -> &'static Mutex<HashMap<Key, SessionState>> {
    static STORE: OnceLock<Mutex<HashMap<Key, SessionState>>> = OnceLock::new();
    STORE.get_or_init(Default::default)
}

pub(crate) fn load(session_id: &str, root: &Path, kind: Kind) -> SessionState {
    store()
        .lock()
        .ok()
        .and_then(|m| {
            m.get(&(session_id.to_string(), root.to_path_buf(), kind))
                .cloned()
        })
        .unwrap_or_default()
}

pub(crate) fn save(session_id: &str, root: &Path, kind: Kind, state: SessionState) {
    if let Ok(mut m) = store().lock() {
        m.insert((session_id.to_string(), root.to_path_buf(), kind), state);
    }
}

/// Clears saved state (one kind or all); returns the kinds that had state.
pub(crate) fn reset(session_id: &str, root: &Path, kind: Option<Kind>) -> Vec<Kind> {
    let mut cleared = Vec::new();
    if let Ok(mut m) = store().lock() {
        for k in [Kind::Bash, Kind::PowerShell, Kind::Cmd] {
            if kind.is_some_and(|only| only != k) {
                continue;
            }
            if let Some(state) = m.remove(&(session_id.to_string(), root.to_path_buf(), k)) {
                if state != SessionState::default() {
                    cleared.push(k);
                }
            }
        }
    }
    cleared
}

// ------------------------------------------------------------------ env diff

fn key_eq(a: &str, b: &str) -> bool {
    if cfg!(windows) {
        a.eq_ignore_ascii_case(b)
    } else {
        a == b
    }
}

fn find_key<'a>(map: &'a EnvMap, key: &str) -> Option<(&'a String, &'a String)> {
    map.get_key_value(key)
        .or_else(|| map.iter().find(|(k, _)| key_eq(k, key)))
}

fn remove_key(map: &mut EnvMap, key: &str) {
    let found: Vec<String> = map.keys().filter(|k| key_eq(k, key)).cloned().collect();
    for k in found {
        map.remove(&k);
    }
}

fn ignored(kind: Kind, key: &str) -> bool {
    if key.is_empty() || key.starts_with('=') {
        return true;
    }
    kind == Kind::Bash && matches!(key, "_" | "SHLVL" | "PWD" | "OLDPWD")
}

/// Folds the change `before` -> `after` into `state`.
pub(crate) fn apply_env_diff(
    kind: Kind,
    state: &mut SessionState,
    before: &EnvMap,
    after: &EnvMap,
) {
    for (key, value) in after {
        if ignored(kind, key) {
            continue;
        }
        if find_key(before, key).is_some_and(|(_, old)| old == value) {
            continue;
        }
        remove_key(&mut state.set, key);
        state.unset.retain(|u| !key_eq(u, key));
        state.set.insert(key.clone(), value.clone());
    }
    for key in before.keys() {
        if ignored(kind, key) || find_key(after, key).is_some() {
            continue;
        }
        remove_key(&mut state.set, key);
        state.unset.retain(|u| !key_eq(u, key));
        state.unset.push(key.clone());
    }
}

/// The environment a child sees: harness environment + saved overrides.
pub(crate) fn effective_env(state: &SessionState) -> EnvMap {
    let mut env: EnvMap = std::env::vars().collect();
    for key in &state.unset {
        remove_key(&mut env, key);
    }
    for (key, value) in &state.set {
        remove_key(&mut env, key);
        env.insert(key.clone(), value.clone());
    }
    env
}

// ------------------------------------------------------------------ wrapping

pub(crate) fn new_sentinel() -> String {
    format!(
        "__OMNIA_{}__",
        &uuid::Uuid::new_v4().simple().to_string()[..12]
    )
}

fn valid_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn bash_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn ps_quote(value: &str) -> String {
    let mut out = String::from("'");
    for c in value.chars() {
        out.push(c);
        if matches!(c, '\'' | '\u{2018}' | '\u{2019}' | '\u{201a}' | '\u{201b}') {
            out.push(c);
        }
    }
    out.push('\'');
    out
}

/// Wraps `command` so the shell reports its final state (see module docs).
/// For cmd the saved env is applied through the process environment instead.
pub(crate) fn wrap_command(kind: Kind, command: &str, s: &str, state: &SessionState) -> String {
    match kind {
        Kind::Bash => {
            let mut out = String::new();
            for (k, v) in &state.set {
                if valid_name(k) {
                    out.push_str(&format!("export {k}={}\n", bash_quote(v)));
                }
            }
            for k in &state.unset {
                if valid_name(k) {
                    out.push_str(&format!("unset {k}\n"));
                }
            }
            out.push_str("__omnia_a=$(env -0 | base64 | tr -d '\\n')\n");
            out.push_str(command);
            out.push_str("\n__omnia_rc=$?\nprintf '\\n'\n");
            out.push_str(&format!(
                "printf '{s}CWD:%s\\n' \"$(pwd -W 2>/dev/null || pwd)\"\n\
                 printf '{s}RC:%s\\n' \"$__omnia_rc\"\n\
                 printf '{s}A:%s\\n' \"$__omnia_a\"\n\
                 printf '{s}B:%s\\n' \"$(env -0 | base64 | tr -d '\\n')\"\n\
                 printf '{s}END\\n'\n\
                 exit \"$__omnia_rc\"\n"
            ));
            out
        }
        Kind::PowerShell => {
            let mut out = String::new();
            for (k, v) in &state.set {
                out.push_str(&format!(
                    "[Environment]::SetEnvironmentVariable({}, {})\n",
                    ps_quote(k),
                    ps_quote(v)
                ));
            }
            for k in &state.unset {
                out.push_str(&format!(
                    "[Environment]::SetEnvironmentVariable({}, $null)\n",
                    ps_quote(k)
                ));
            }
            out.push_str(
                "$__omnia_envjson = { $h = [ordered]@{}; foreach ($e in Get-ChildItem env:) { $h[[string]$e.Name] = [string]$e.Value }; $h | ConvertTo-Json -Compress }\n\
                 $__omnia_a = & $__omnia_envjson\n",
            );
            out.push_str(command);
            out.push('\n');
            out.push_str(&format!(
                "$__omnia_ok = $?; $__omnia_lec = $LASTEXITCODE\n\
                 $__omnia_rc = if ($__omnia_ok) {{ 0 }} elseif ($__omnia_lec) {{ $__omnia_lec }} else {{ 1 }}\n\
                 ''\n\
                 '{s}CWD:' + (Get-Location -PSProvider FileSystem).Path\n\
                 '{s}RC:' + $__omnia_rc\n\
                 '{s}A:' + $__omnia_a\n\
                 '{s}B:' + (& $__omnia_envjson)\n\
                 '{s}END'\n"
            ));
            out
        }
        Kind::Cmd => format!(
            "{command} & echo.& call echo {s}RC:%^errorlevel%& call echo {s}CWD:%^cd%& echo {s}SET& set& echo {s}END"
        ),
    }
}

// ------------------------------------------------------------------- capture

/// Pulls the sentinel block out of a line stream.
pub(crate) struct StateCapture {
    sentinel: String,
    active: bool,
    pub lines: Vec<String>,
}

impl StateCapture {
    pub(crate) fn new(sentinel: &str) -> Self {
        Self {
            sentinel: sentinel.to_string(),
            active: false,
            lines: Vec::new(),
        }
    }

    /// Returns true when the line belongs to the state block (and must not be
    /// shown). Once the block starts, every later line is part of it.
    pub(crate) fn feed(&mut self, line: &str) -> bool {
        if !self.active && line.starts_with(&self.sentinel) {
            self.active = true;
        }
        if self.active {
            self.lines.push(line.trim_end_matches('\r').to_string());
        }
        self.active
    }
}

#[derive(Debug, PartialEq)]
pub(crate) struct StateBlock {
    pub cwd: String,
    pub rc: Option<i32>,
    /// Environment before the command (bash/PowerShell only).
    pub before: Option<EnvMap>,
    pub after: EnvMap,
}

fn parse_bash_env(payload: &str) -> Option<EnvMap> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload.trim())
        .ok()?;
    let text = String::from_utf8_lossy(&bytes);
    Some(
        text.split('\0')
            .filter_map(|entry| entry.split_once('='))
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect(),
    )
}

fn parse_ps_env(payload: &str) -> Option<EnvMap> {
    let value: Value = serde_json::from_str(payload.trim()).ok()?;
    Some(
        value
            .as_object()?
            .iter()
            .filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_string())))
            .collect(),
    )
}

fn parse_cmd_env(lines: &[&str]) -> EnvMap {
    lines
        .iter()
        .filter_map(|l| l.split_once('='))
        .filter(|(k, _)| !k.is_empty())
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

/// Parses captured lines. `None` when the block is absent or incomplete (the
/// command ended the shell, was killed, or the trailer failed).
pub(crate) fn parse_block(kind: Kind, sentinel: &str, lines: &[String]) -> Option<StateBlock> {
    let mut cwd = None;
    let mut rc = None;
    let mut before_raw = None;
    let mut after_raw = None;
    let mut set_lines: Vec<&str> = Vec::new();
    let mut in_set = false;
    let mut ended = false;
    for line in lines {
        let Some(rest) = line.strip_prefix(sentinel) else {
            if in_set {
                set_lines.push(line);
            }
            continue;
        };
        if let Some(v) = rest.strip_prefix("CWD:") {
            cwd = Some(v.to_string());
        } else if let Some(v) = rest.strip_prefix("RC:") {
            rc = v.trim().parse::<i32>().ok();
        } else if let Some(v) = rest.strip_prefix("A:") {
            before_raw = Some(v);
        } else if let Some(v) = rest.strip_prefix("B:") {
            after_raw = Some(v);
        } else if rest.trim() == "SET" {
            in_set = true;
        } else if rest.trim() == "END" {
            in_set = false;
            ended = true;
        }
    }
    if !ended {
        return None;
    }
    let cwd = cwd.filter(|c| !c.trim().is_empty())?;
    let (before, after) = match kind {
        Kind::Bash => (
            before_raw.and_then(parse_bash_env),
            after_raw.and_then(parse_bash_env)?,
        ),
        Kind::PowerShell => (
            before_raw.and_then(parse_ps_env),
            after_raw.and_then(parse_ps_env)?,
        ),
        Kind::Cmd => (None, parse_cmd_env(&set_lines)),
    };
    Some(StateBlock {
        cwd,
        rc,
        before,
        after,
    })
}

/// Folds a parsed block into the saved state. `fallback_before` is the
/// environment the child started with (used when the block has no `before`).
pub(crate) fn absorb(
    kind: Kind,
    state: &mut SessionState,
    block: &StateBlock,
    fallback_before: &EnvMap,
) {
    state.cwd = Some(PathBuf::from(&block.cwd));
    let before = block.before.as_ref().unwrap_or(fallback_before);
    apply_env_diff(kind, state, before, &block.after);
}

/// Same directory? (separator-, trailing-slash- and (on Windows) case-insensitive)
pub(crate) fn same_dir(a: &Path, b: &Path) -> bool {
    fn norm(p: &Path) -> String {
        let s = p.to_string_lossy().replace('\\', "/");
        let s = s.strip_prefix("//?/").unwrap_or(&s);
        let s = s.trim_end_matches('/');
        if cfg!(windows) {
            s.to_ascii_lowercase()
        } else {
            s.to_string()
        }
    }
    norm(a) == norm(b) || matches!((a.canonicalize(), b.canonicalize()), (Ok(x), Ok(y)) if x == y)
}

#[cfg(test)]
mod tests {
    use super::*;

    const S: &str = "__OMNIA_test__";

    fn b64(entries: &[(&str, &str)]) -> String {
        let mut raw = Vec::new();
        for (k, v) in entries {
            raw.extend_from_slice(format!("{k}={v}").as_bytes());
            raw.push(0);
        }
        base64::engine::general_purpose::STANDARD.encode(raw)
    }

    fn lines(v: &[String]) -> Vec<String> {
        v.to_vec()
    }

    #[test]
    fn capture_strips_block_and_passes_output() {
        let mut cap = StateCapture::new(S);
        let input = [
            "hello".to_string(),
            "".to_string(),
            format!("{S}CWD:/tmp"),
            format!("{S}END"),
        ];
        let shown: Vec<&String> = input.iter().filter(|l| !cap.feed(l)).collect();
        assert_eq!(shown, vec!["hello", ""]);
        assert_eq!(cap.lines.len(), 2);
    }

    #[test]
    fn parses_bash_block() {
        let block = vec![
            format!("{S}CWD:C:/work/sub"),
            format!("{S}RC:3"),
            format!("{S}A:{}", b64(&[("A", "1"), ("GONE", "x")])),
            format!("{S}B:{}", b64(&[("A", "1"), ("FOO", "a=b")])),
            format!("{S}END"),
        ];
        let parsed = parse_block(Kind::Bash, S, &lines(&block)).unwrap();
        assert_eq!(parsed.cwd, "C:/work/sub");
        assert_eq!(parsed.rc, Some(3));
        assert_eq!(parsed.after.get("FOO").map(String::as_str), Some("a=b"));
        let mut state = SessionState::default();
        absorb(Kind::Bash, &mut state, &parsed, &EnvMap::new());
        assert_eq!(state.cwd, Some(PathBuf::from("C:/work/sub")));
        assert_eq!(state.set.get("FOO").map(String::as_str), Some("a=b"));
        assert!(!state.set.contains_key("A"));
        assert_eq!(state.unset, vec!["GONE".to_string()]);
    }

    #[test]
    fn parses_powershell_block() {
        let block = vec![
            format!("{S}CWD:C:\\work\\sub"),
            format!("{S}RC:0"),
            format!("{S}A:{{\"X\":\"1\"}}"),
            format!("{S}B:{{\"X\":\"2\",\"Y\":\"\u{e9}\"}}"),
            format!("{S}END"),
        ];
        let parsed = parse_block(Kind::PowerShell, S, &lines(&block)).unwrap();
        let mut state = SessionState::default();
        absorb(Kind::PowerShell, &mut state, &parsed, &EnvMap::new());
        assert_eq!(state.cwd, Some(PathBuf::from("C:\\work\\sub")));
        assert_eq!(state.set.get("X").map(String::as_str), Some("2"));
        assert_eq!(state.set.get("Y").map(String::as_str), Some("\u{e9}"));
    }

    #[test]
    fn parses_cmd_block_with_fallback_before() {
        let block = vec![
            format!("{S}RC:1"),
            format!("{S}CWD:C:\\x"),
            format!("{S}SET"),
            "FOO=bar".to_string(),
            "=C:=C:\\x".to_string(),
            "KEEP=1".to_string(),
            format!("{S}END"),
        ];
        let parsed = parse_block(Kind::Cmd, S, &lines(&block)).unwrap();
        let before: EnvMap = [("KEEP", "1"), ("DROP", "z")]
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        let mut state = SessionState::default();
        absorb(Kind::Cmd, &mut state, &parsed, &before);
        assert_eq!(state.set.len(), 1);
        assert_eq!(state.set["FOO"], "bar");
        assert_eq!(state.unset, vec!["DROP".to_string()]);
    }

    #[test]
    fn absent_or_incomplete_block_is_none() {
        // `exit` in the command: the trailer never ran.
        assert!(parse_block(Kind::Bash, S, &[]).is_none());
        // Truncated block (no END) is ignored too.
        let partial = vec![format!("{S}CWD:/tmp"), format!("{S}RC:0")];
        assert!(parse_block(Kind::Bash, S, &partial).is_none());
        // Garbage env payload.
        let bad = vec![
            format!("{S}CWD:/tmp"),
            format!("{S}B:!!!"),
            format!("{S}END"),
        ];
        assert!(parse_block(Kind::Bash, S, &bad).is_none());
    }

    #[test]
    fn env_diff_accumulates_and_applies() {
        let env = |pairs: &[(&str, &str)]| -> EnvMap {
            pairs
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect()
        };
        let mut state = SessionState::default();
        apply_env_diff(
            Kind::Bash,
            &mut state,
            &env(&[("A", "1"), ("B", "2"), ("SHLVL", "1")]),
            &env(&[("A", "9"), ("C", "3"), ("SHLVL", "2")]),
        );
        assert_eq!(state.set, env(&[("A", "9"), ("C", "3")]));
        assert_eq!(state.unset, vec!["B".to_string()]);
        // A later call re-sets B and unsets C.
        apply_env_diff(
            Kind::Bash,
            &mut state,
            &env(&[("A", "9"), ("C", "3")]),
            &env(&[("A", "9"), ("B", "again")]),
        );
        assert_eq!(state.set, env(&[("A", "9"), ("B", "again")]));
        assert_eq!(state.unset, vec!["C".to_string()]);
        let eff = effective_env(&state);
        assert_eq!(eff.get("B").map(String::as_str), Some("again"));
        assert!(!eff.contains_key("C"));
    }

    #[test]
    fn wrapping_applies_saved_state_and_quotes() {
        let mut state = SessionState::default();
        state.set.insert("FOO".into(), "it's".into());
        state.unset.push("BAR".into());
        let bash = wrap_command(Kind::Bash, "echo hi", S, &state);
        assert!(bash.contains("export FOO='it'\\''s'\n"));
        assert!(bash.contains("unset BAR\n"));
        assert!(bash.contains("echo hi\n__omnia_rc=$?"));
        let ps = wrap_command(Kind::PowerShell, "Get-Date", S, &state);
        assert!(ps.contains("SetEnvironmentVariable('FOO', 'it''s')"));
        assert!(ps.contains("SetEnvironmentVariable('BAR', $null)"));
        let cmd = wrap_command(Kind::Cmd, "dir", S, &state);
        assert!(cmd.starts_with("dir & echo."));
    }

    #[test]
    fn reset_clears_only_requested_kind() {
        let root = Path::new("reset-test-root");
        let state = SessionState {
            cwd: Some(PathBuf::from("x")),
            ..Default::default()
        };
        save("reset-sess", root, Kind::Bash, state.clone());
        save("reset-sess", root, Kind::Cmd, state);
        assert_eq!(
            reset("reset-sess", root, Some(Kind::Bash)),
            vec![Kind::Bash]
        );
        assert!(load("reset-sess", root, Kind::Bash).cwd.is_none());
        assert!(load("reset-sess", root, Kind::Cmd).cwd.is_some());
        assert_eq!(reset("reset-sess", root, None), vec![Kind::Cmd]);
    }
}
