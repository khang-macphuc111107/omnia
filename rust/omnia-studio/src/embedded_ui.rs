//! Hybrid UI asset resolver: honors explicit on-disk `--ui-root` overrides and isolated test
//! fixtures, and on default launches serves Studio v5 (`D:\OmniaData\build\ui-dist`,
//! `<workspace>/ui-v5/dist`, or compile-time `rust-embed` `embed-ui`) before legacy `ui/`.

use std::fs;
use std::path::Path;

#[cfg(feature = "embed-ui")]
#[derive(rust_embed::RustEmbed)]
#[folder = "D:/OmniaData/build/ui-dist"]
struct EmbeddedUiDist;

/// Loads Studio v5 assets strictly from `D:\OmniaData\build\ui-dist`, `<workspace_root>/ui-v5/dist`,
/// or compile-time `EmbeddedUiDist` (`embed-ui` feature), with SPA `index.html` fallback for
/// extensionless client routes (`/`, `/atelier`, `/ide`, `/browser`, `/swarm`, `/omnidrive`).
#[must_use]
pub fn load_v5_ui_asset(workspace_root: &Path, rel_path: &str) -> Option<(Vec<u8>, &'static str)> {
    let clean_rel = rel_path.trim_start_matches('/').replace('\\', "/");
    let target_rel = if clean_rel.is_empty() {
        "index.html"
    } else {
        clean_rel.as_str()
    };

    if let Some(found) = try_load_v5_exact(workspace_root, target_rel) {
        return Some(found);
    }

    // SPA route fallback for extensionless paths (e.g. `/atelier`, `/ide`, `/browser`)
    let last_seg = target_rel.rsplit('/').next().unwrap_or(target_rel);
    if !target_rel.contains("..") && !last_seg.contains('.') {
        return try_load_v5_exact(workspace_root, "index.html");
    }

    None
}

/// Legacy signature kept for direct callers preferring explicit `primary_ui_dir` first.
#[must_use]
pub fn load_ui_asset_bytes(
    primary_ui_dir: &Path,
    workspace_root: &Path,
    rel_path: &str,
) -> Option<(Vec<u8>, &'static str)> {
    let clean_rel = rel_path.trim_start_matches('/').replace('\\', "/");
    let target_rel = if clean_rel.is_empty() {
        "index.html"
    } else {
        clean_rel.as_str()
    };
    if let Some(found) = read_disk_asset_strict(primary_ui_dir, target_rel) {
        return Some((found, mime_for_rel(target_rel)));
    }
    load_v5_ui_asset(workspace_root, target_rel)
}

fn try_load_v5_exact(workspace_root: &Path, target_rel: &str) -> Option<(Vec<u8>, &'static str)> {
    let external_dist = Path::new(r"D:\OmniaData\build\ui-dist");
    if let Some(found) = read_disk_asset_strict(external_dist, target_rel) {
        return Some((found, mime_for_rel(target_rel)));
    }

    let ws_dist = workspace_root.join("ui-v5").join("dist");
    if let Some(found) = read_disk_asset_strict(&ws_dist, target_rel) {
        return Some((found, mime_for_rel(target_rel)));
    }

    #[cfg(feature = "embed-ui")]
    {
        if let Some(asset) = EmbeddedUiDist::get(target_rel) {
            return Some((asset.data.into_owned(), mime_for_rel(target_rel)));
        }
    }

    None
}

fn read_disk_asset_strict(root: &Path, rel: &str) -> Option<Vec<u8>> {
    if rel.contains("..") || rel.contains('\0') {
        return None;
    }
    let canon_root = fs::canonicalize(root).ok()?;
    let candidate = root.join(rel);
    let meta = fs::symlink_metadata(&candidate).ok()?;
    if meta.file_type().is_symlink() || !meta.is_file() {
        return None;
    }
    let canon_file = fs::canonicalize(&candidate).ok()?;
    if !canon_file.starts_with(&canon_root) {
        return None;
    }
    fs::read(&canon_file).ok()
}

fn mime_for_rel(rel: &str) -> &'static str {
    let lower = rel.to_ascii_lowercase();
    if lower.ends_with(".html") || lower.ends_with(".htm") {
        "text/html; charset=utf-8"
    } else if lower.ends_with(".css") {
        "text/css; charset=utf-8"
    } else if lower.ends_with(".js") || lower.ends_with(".mjs") {
        "application/javascript; charset=utf-8"
    } else if lower.ends_with(".json") || lower.ends_with(".map") {
        "application/json; charset=utf-8"
    } else if lower.ends_with(".svg") {
        "image/svg+xml"
    } else if lower.ends_with(".png") {
        "image/png"
    } else if lower.ends_with(".woff2") {
        "font/woff2"
    } else if lower.ends_with(".woff") {
        "font/woff"
    } else if lower.ends_with(".ico") {
        "image/x-icon"
    } else if lower.ends_with(".wasm") {
        "application/wasm"
    } else {
        "application/octet-stream"
    }
}
