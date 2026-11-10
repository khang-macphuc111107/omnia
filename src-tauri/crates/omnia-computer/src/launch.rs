//! Launching apps by path, command or Start-menu name.

use std::path::{Path, PathBuf};

/// Higher is better; `None` = no match. Case-insensitive.
pub fn fuzzy_score(query: &str, name: &str) -> Option<u32> {
    let q = query.trim().to_lowercase();
    let n = name.trim().to_lowercase();
    if q.is_empty() || n.is_empty() {
        return None;
    }
    let penalty = (n.len().saturating_sub(q.len())).min(90) as u32;
    if n == q {
        return Some(1000);
    }
    if n.starts_with(&q) {
        return Some(800 - penalty);
    }
    if n.split(|c: char| !c.is_alphanumeric()).any(|w| w == q) {
        return Some(700 - penalty);
    }
    if n.contains(&q) {
        return Some(500 - penalty);
    }
    // all query chars in order
    let mut it = n.chars();
    if q.chars()
        .filter(|c| !c.is_whitespace())
        .all(|qc| it.any(|nc| nc == qc))
    {
        return Some(100u32.saturating_sub(penalty.min(90)).max(1));
    }
    None
}

pub fn start_menu_dirs() -> Vec<PathBuf> {
    ["ProgramData", "APPDATA"]
        .iter()
        .filter_map(std::env::var_os)
        .map(|base| PathBuf::from(base).join(r"Microsoft\Windows\Start Menu\Programs"))
        .filter(|p| p.is_dir())
        .collect()
}

fn collect_lnk(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in rd.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if depth < 4 {
                collect_lnk(&path, depth + 1, out);
            }
        } else if path
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("lnk"))
        {
            out.push(path);
        }
    }
}

/// Best `.lnk` in `dirs` for `query`; `exact_only` restricts to exact name matches.
pub fn find_shortcut(query: &str, dirs: &[PathBuf], exact_only: bool) -> Option<PathBuf> {
    let mut files = Vec::new();
    for d in dirs {
        collect_lnk(d, 0, &mut files);
    }
    files
        .into_iter()
        .filter_map(|p| {
            let stem = p.file_stem()?.to_string_lossy().to_string();
            if stem.to_lowercase().contains("uninstall") {
                return None;
            }
            let s = fuzzy_score(query, &stem)?;
            (!exact_only || s == 1000).then_some((s, p))
        })
        .max_by_key(|(s, _)| *s)
        .map(|(_, p)| p)
}

/// `name` or `name.exe` on `%PATH%` (first hit).
pub fn find_on_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    let file = if Path::new(name).extension().is_some() {
        name.to_string()
    } else {
        format!("{name}.exe")
    };
    std::env::split_paths(&path)
        .map(|d| d.join(&file))
        .find(|p| p.is_file())
}

/// What `launch` will hand to `ShellExecute`.
pub fn resolve_target(app: &str, dirs: &[PathBuf]) -> String {
    let p = Path::new(app);
    if p.is_absolute() || app.contains(['\\', '/', ':']) || p.extension().is_some() {
        return app.to_string();
    }
    if let Some(l) = find_shortcut(app, dirs, true) {
        return l.to_string_lossy().to_string();
    }
    if find_on_path(app).is_some() {
        return app.to_string();
    }
    if let Some(l) = find_shortcut(app, dirs, false) {
        return l.to_string_lossy().to_string();
    }
    app.to_string()
}

#[cfg(windows)]
pub use imp::launch;

#[cfg(windows)]
mod imp {
    use std::collections::HashSet;
    use std::time::{Duration, Instant};

    use windows::core::{w, HSTRING};
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::GetProcessId;
    use windows::Win32::UI::Shell::{
        ShellExecuteExW, SEE_MASK_FLAG_NO_UI, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW,
    };
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    use super::{resolve_target, start_menu_dirs};
    use crate::types::{LaunchResult, WindowInfo};
    use crate::winapi;
    use crate::ComputerError;

    fn stem(s: &str) -> String {
        let name = s.rsplit(['\\', '/']).next().unwrap_or(s).to_lowercase();
        name.strip_suffix(".exe")
            .or_else(|| name.strip_suffix(".lnk"))
            .map(str::to_string)
            .unwrap_or(name)
    }

    /// Start `app` (path, command, URI or Start-menu name) and wait for its window.
    pub fn launch(
        app: &str,
        args: Option<&str>,
        timeout_ms: u64,
    ) -> Result<LaunchResult, ComputerError> {
        let before: HashSet<isize> = winapi::list_windows()?.iter().map(|w| w.hwnd).collect();
        let target = resolve_target(app, &start_menu_dirs());
        let file = HSTRING::from(target.as_str());
        let params = args.map(HSTRING::from);
        let mut info = SHELLEXECUTEINFOW {
            cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
            fMask: SEE_MASK_NOCLOSEPROCESS | SEE_MASK_FLAG_NO_UI,
            lpVerb: w!("open"),
            lpFile: windows::core::PCWSTR(file.as_ptr()),
            lpParameters: params
                .as_ref()
                .map(|p| windows::core::PCWSTR(p.as_ptr()))
                .unwrap_or_default(),
            nShow: SW_SHOWNORMAL.0,
            ..Default::default()
        };
        unsafe { ShellExecuteExW(&mut info) }.map_err(|e| {
            ComputerError::Failed(format!(
                "could not launch `{app}` ({e}). Use a full path, an exe name on PATH, or a Start-menu app name."
            ))
        })?;
        let pid = if info.hProcess.is_invalid() {
            None
        } else {
            let p = unsafe { GetProcessId(info.hProcess) };
            unsafe {
                let _ = CloseHandle(info.hProcess);
            }
            (p != 0).then_some(p)
        };

        let wanted = stem(app);
        let target_stem = stem(&target);
        let started = Instant::now();
        let deadline = Duration::from_millis(timeout_ms);
        let mut found: Option<WindowInfo> = None;
        while started.elapsed() < deadline {
            let new: Vec<WindowInfo> = winapi::list_windows()?
                .into_iter()
                .filter(|w| !before.contains(&w.hwnd))
                .collect();
            let pick = new
                .iter()
                .find(|w| pid.is_some_and(|p| w.pid == p))
                .or_else(|| {
                    new.iter().find(|w| {
                        let ps = stem(&w.process);
                        ps == wanted
                            || ps == target_stem
                            || w.title.to_lowercase().contains(&wanted)
                    })
                })
                .or_else(|| {
                    // Packaged apps often start from a different process; accept any
                    // new window once the quick matches had a chance.
                    (started.elapsed() > Duration::from_millis(1500))
                        .then(|| new.first())
                        .flatten()
                });
            if let Some(w) = pick {
                found = Some(w.clone());
                break;
            }
            std::thread::sleep(Duration::from_millis(150));
        }
        if found.is_some() {
            std::thread::sleep(Duration::from_millis(250));
        }
        let found = found.and_then(|w| winapi::window_info(w.hwnd));
        Ok(LaunchResult {
            resolved: target,
            pid,
            window: found,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fuzzy_ordering() {
        let exact = fuzzy_score("notepad", "Notepad").unwrap();
        let prefix = fuzzy_score("notepad", "Notepad++").unwrap();
        let contains = fuzzy_score("pad", "Notepad++").unwrap();
        let subseq = fuzzy_score("ntpd", "Notepad").unwrap();
        assert!(exact > prefix && prefix > contains && contains > subseq);
        assert_eq!(fuzzy_score("zzz", "Notepad"), None);
        assert_eq!(fuzzy_score("", "x"), None);
        assert!(fuzzy_score("visual studio code", "Visual Studio Code").unwrap() == 1000);
    }

    #[test]
    fn shortcut_search_in_tree() {
        let tmp = tempfile::tempdir().unwrap();
        let sub = tmp.path().join("Accessories");
        std::fs::create_dir_all(&sub).unwrap();
        for n in ["Notepad++.lnk", "Calculator.lnk", "Uninstall Notepad.lnk"] {
            std::fs::write(sub.join(n), b"").unwrap();
        }
        let dirs = vec![tmp.path().to_path_buf()];
        let hit = find_shortcut("notepad", &dirs, false).unwrap();
        assert!(hit.ends_with("Notepad++.lnk"));
        assert!(find_shortcut("notepad", &dirs, true).is_none());
        assert!(find_shortcut("CALCULATOR", &dirs, true).is_some());
        assert_eq!(resolve_target(r"C:\x\y.exe", &dirs), r"C:\x\y.exe");
        assert!(resolve_target("calculator", &dirs).ends_with("Calculator.lnk"));
        assert_eq!(resolve_target("doesnotexist-zz", &dirs), "doesnotexist-zz");
    }
}
