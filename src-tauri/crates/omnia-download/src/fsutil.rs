//! Filesystem helpers: safe names, collision avoidance, positional writes.

use std::fs::File;
use std::io;
use std::path::{Path, PathBuf};

/// Make a string safe to use as a single file name on Windows and Unix.
pub fn sanitize_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    let trimmed = cleaned
        .trim()
        .trim_end_matches(['.', ' '])
        .trim_start_matches('.');
    let mut out = trimmed.to_string();
    if out.len() > 180 {
        // Keep the extension when truncating (on a char boundary).
        let ext = Path::new(&out)
            .extension()
            .and_then(|e| e.to_str())
            .filter(|e| e.len() <= 10)
            .map(|e| format!(".{e}"))
            .unwrap_or_default();
        let keep = 180 - ext.len();
        let mut cut = keep;
        while !out.is_char_boundary(cut) {
            cut -= 1;
        }
        out = format!("{}{}", &out[..cut], ext);
    }
    let upper = out.to_ascii_uppercase();
    let stem = upper.split('.').next().unwrap_or("");
    let reserved = matches!(stem, "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.as_bytes()[3].is_ascii_digit());
    if reserved {
        out.insert(0, '_');
    }
    if out.is_empty() {
        "download".to_string()
    } else {
        out
    }
}

/// `dir/name`, or `dir/name (1).ext`, `(2)`... when it already exists.
pub fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let candidate = dir.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let p = Path::new(name);
    let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or(name);
    let ext = p.extension().and_then(|s| s.to_str());
    for i in 1..10_000 {
        let n = match ext {
            Some(e) => format!("{stem} ({i}).{e}"),
            None => format!("{stem} ({i})"),
        };
        let c = dir.join(n);
        if !c.exists() {
            return c;
        }
    }
    candidate
}

/// Append a suffix to the full file name (`a.mp4` + `.part` -> `a.mp4.part`).
pub fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut s = path.as_os_str().to_os_string();
    s.push(suffix);
    PathBuf::from(s)
}

/// Write the whole buffer at `offset` without touching a shared cursor.
pub fn write_all_at(file: &File, mut buf: &[u8], mut offset: u64) -> io::Result<()> {
    while !buf.is_empty() {
        #[cfg(windows)]
        let n = std::os::windows::fs::FileExt::seek_write(file, buf, offset)?;
        #[cfg(unix)]
        let n = std::os::unix::fs::FileExt::write_at(file, buf, offset)?;
        if n == 0 {
            return Err(io::Error::new(io::ErrorKind::WriteZero, "failed to write"));
        }
        buf = &buf[n..];
        offset += n as u64;
    }
    Ok(())
}

/// Move a file, falling back to copy+delete across volumes.
pub fn move_file(from: &Path, to: &Path) -> io::Result<()> {
    if std::fs::rename(from, to).is_ok() {
        return Ok(());
    }
    std::fs::copy(from, to)?;
    std::fs::remove_file(from)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes() {
        assert_eq!(sanitize_file_name("a/b:c?.mp4"), "a_b_c_.mp4");
        assert_eq!(sanitize_file_name("..hidden. "), "hidden");
        assert_eq!(sanitize_file_name("CON.txt"), "_CON.txt");
        assert_eq!(sanitize_file_name(""), "download");
    }

    #[test]
    fn unique_names() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("a.bin"), b"x").unwrap();
        assert_eq!(unique_path(d.path(), "a.bin"), d.path().join("a (1).bin"));
        std::fs::write(d.path().join("a (1).bin"), b"x").unwrap();
        assert_eq!(unique_path(d.path(), "a.bin"), d.path().join("a (2).bin"));
        assert_eq!(unique_path(d.path(), "b.bin"), d.path().join("b.bin"));
    }
}
