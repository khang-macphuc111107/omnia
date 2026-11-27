//! Batch URL pattern expander (`[01-20]`, `[a-z]`), IDM `.ef2` parser & serializer,
//! 5-category download router, [`BatchPlanner`], and [`DownloadScheduler`].

use std::collections::VecDeque;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Timelike, Utc};
use serde::{Deserialize, Serialize};

use crate::types::{
    safe_output_filename, validate_safe_local_path, DownloaderError, SecurityPolicy, DRM_SUPPORTED,
};

/// Hard safety limit on expanded batch URLs to prevent combinatorial DoS.
pub const MAX_BATCH_EXPANSION: usize = 10_000;

/// Five IDM-parity auto-routing categories + fallback General.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DownloadCategory {
    Documents,
    Compressed,
    Music,
    Video,
    Programs,
    General,
}

impl DownloadCategory {
    /// Classifies a filename into one of the 5 standard IDM categories (or `General`).
    #[must_use]
    pub fn classify_filename(filename: &str) -> Self {
        let ext = Path::new(filename)
            .extension()
            .and_then(|e| e.to_str())
            .map(str::to_ascii_lowercase)
            .unwrap_or_default();
        match ext.as_str() {
            "pdf" | "doc" | "docx" | "xls" | "xlsx" | "ppt" | "pptx" | "txt" | "md" | "csv"
            | "epub" | "rtf" | "odt" | "ipynb" => Self::Documents,
            "zip" | "7z" | "rar" | "tar" | "gz" | "bz2" | "xz" | "zst" | "tgz" => Self::Compressed,
            "mp3" | "wav" | "flac" | "aac" | "m4a" | "ogg" | "opus" | "wma" => Self::Music,
            "mp4" | "mkv" | "webm" | "mov" | "avi" | "m4v" | "ts" | "m3u8" | "mpd" => Self::Video,
            "exe" | "msi" | "msix" | "dmg" | "pkg" | "deb" | "rpm" | "appimage" | "whl" => {
                Self::Programs
            }
            _ => Self::General,
        }
    }

    /// Subfolder name for category-routed downloads.
    #[must_use]
    pub const fn subfolder(self) -> &'static str {
        match self {
            Self::Documents => "Documents",
            Self::Compressed => "Compressed",
            Self::Music => "Music",
            Self::Video => "Video",
            Self::Programs => "Programs",
            Self::General => "General",
        }
    }
}

/// Expands IDM-compatible bracket range expressions inside a URL pattern.
///
/// Supported patterns:
/// - Zero-padded or unpadded numeric ranges: `[01-20]`, `[1-5]`, `[000-010:2]` (optional `:step`)
/// - Single-character alphabetic ranges: `[a-z]`, `[A-F]`, `[a-g:2]`
/// - Multiple ranges per URL expand in deterministic lexicographic Cartesian order up to [`MAX_BATCH_EXPANSION`].
pub fn expand_batch_pattern(pattern: &str) -> Result<Vec<String>, DownloaderError> {
    let trimmed = pattern.trim();
    if trimmed.is_empty() {
        return Err(DownloaderError::InvalidInput("batch pattern is empty".into()));
    }

    let mut current = vec![trimmed.to_string()];

    while let Some((open, close)) = find_expandable_bracket(&current[0]) {
        let expr = &current[0][open + 1..close];
        let values = parse_range_expr(expr)?;
        let next_total = current.len().saturating_mul(values.len());
        if next_total > MAX_BATCH_EXPANSION {
            return Err(DownloaderError::InvalidInput(format!(
                "batch pattern expansion exceeds cap {MAX_BATCH_EXPANSION}"
            )));
        }

        let mut expanded = Vec::with_capacity(next_total);
        for template in &current {
            let prefix = &template[..open];
            let suffix = &template[close + 1..];
            for val in &values {
                expanded.push(format!("{prefix}{val}{suffix}"));
            }
        }
        current = expanded;
    }

    Ok(current)
}

fn find_expandable_bracket(s: &str) -> Option<(usize, usize)> {
    // Skip IPv6 host literals `[::1]` by searching only after authority or verifying range syntax `-`.
    let mut offset = 0usize;
    while let Some(rel_open) = s[offset..].find('[') {
        let open = offset + rel_open;
        if let Some(rel_close) = s[open + 1..].find(']') {
            let close = open + 1 + rel_close;
            let inner = &s[open + 1..close];
            if inner.contains('-') && parse_range_expr(inner).is_ok() {
                return Some((open, close));
            }
            offset = close + 1;
        } else {
            break;
        }
    }
    None
}

fn parse_range_expr(expr: &str) -> Result<Vec<String>, DownloaderError> {
    let (range_part, step) = match expr.split_once(':') {
        Some((r, s)) => {
            let step_val = s.parse::<usize>().map_err(|_| {
                DownloaderError::InvalidInput(format!("invalid batch range step `{s}`"))
            })?;
            if step_val == 0 {
                return Err(DownloaderError::InvalidInput(
                    "batch range step must be >= 1".into(),
                ));
            }
            (r, step_val)
        }
        None => (expr, 1usize),
    };

    let (start_s, end_s) = range_part.split_once('-').ok_or_else(|| {
        DownloaderError::InvalidInput(format!("invalid batch range expression `[{expr}]`"))
    })?;

    // Numeric range (e.g. `01-20` or `1-5`)
    if !start_s.is_empty()
        && !end_s.is_empty()
        && start_s.bytes().all(|b| b.is_ascii_digit())
        && end_s.bytes().all(|b| b.is_ascii_digit())
    {
        let start_n = start_s.parse::<u64>().map_err(|_| {
            DownloaderError::InvalidInput(format!("invalid numeric range start `{start_s}`"))
        })?;
        let end_n = end_s.parse::<u64>().map_err(|_| {
            DownloaderError::InvalidInput(format!("invalid numeric range end `{end_s}`"))
        })?;
        if start_n > end_n {
            return Err(DownloaderError::InvalidInput(format!(
                "descending numeric range `[{expr}]` is invalid"
            )));
        }
        let pad_width = if start_s.starts_with('0') && start_s.len() > 1 {
            start_s.len()
        } else {
            0
        };
        let mut out = Vec::new();
        let mut cur = start_n;
        while cur <= end_n {
            if out.len() >= MAX_BATCH_EXPANSION {
                return Err(DownloaderError::InvalidInput(format!(
                    "numeric range `[{expr}]` exceeds cap {MAX_BATCH_EXPANSION}"
                )));
            }
            if pad_width > 0 {
                out.push(format!("{cur:0pad_width$}"));
            } else {
                out.push(cur.to_string());
            }
            match cur.checked_add(step as u64) {
                Some(next) => cur = next,
                None => break,
            }
        }
        return Ok(out);
    }

    // Single ASCII alphabetic range (e.g. `a-z` or `A-Z`)
    if start_s.len() == 1 && end_s.len() == 1 {
        let a = start_s.as_bytes()[0];
        let b = end_s.as_bytes()[0];
        let same_case = (a.is_ascii_lowercase() && b.is_ascii_lowercase())
            || (a.is_ascii_uppercase() && b.is_ascii_uppercase());
        if same_case && a <= b {
            let mut out = Vec::new();
            let mut cur = a;
            while cur <= b {
                out.push((cur as char).to_string());
                match cur.checked_add(step as u8) {
                    Some(next) => cur = next,
                    None => break,
                }
            }
            return Ok(out);
        }
    }

    Err(DownloaderError::InvalidInput(format!(
        "unsupported batch range expression `[{expr}]`"
    )))
}

/// Entry parsed from or written to an IDM `.ef2` batch export file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Ef2Entry {
    pub url: String,
    pub filename: Option<String>,
    pub referer: Option<String>,
    pub user_agent: Option<String>,
    pub description: Option<String>,
}

/// Parses an IDM `.ef2` text file (`<` ... `>` bracketed blocks).
///
/// Security note: strips/ignores `cookie:` and `postdata:` credentials from persisted entries
/// so `.ef2` import never leaks raw cookies into receipts, and sanitizes filenames.
pub fn parse_ef2(content: &str) -> Result<Vec<Ef2Entry>, DownloaderError> {
    let mut entries = Vec::new();
    let mut in_block = false;
    let mut url: Option<String> = None;
    let mut filename: Option<String> = None;
    let mut referer: Option<String> = None;
    let mut user_agent: Option<String> = None;
    let mut description: Option<String> = None;

    for raw_line in content.lines() {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }
        if line == "<" {
            in_block = true;
            url = None;
            filename = None;
            referer = None;
            user_agent = None;
            description = None;
            continue;
        }
        if line == ">" {
            if in_block {
                if let Some(u) = url.take() {
                    let safe_fn = match filename.take() {
                        Some(raw_fn) => Some(safe_output_filename(&raw_fn)?),
                        None => None,
                    };
                    entries.push(Ef2Entry {
                        url: u,
                        filename: safe_fn,
                        referer: referer.take(),
                        user_agent: user_agent.take(),
                        description: description.take(),
                    });
                }
            }
            in_block = false;
            continue;
        }
        if !in_block {
            continue;
        }

        if url.is_none()
            && (line.starts_with("http://") || line.starts_with("https://"))
        {
            url = Some(line.to_string());
            continue;
        }
        if let Some((key, val)) = line.split_once(':') {
            let v = val.trim();
            if v.is_empty() {
                continue;
            }
            match key.trim().to_ascii_lowercase().as_str() {
                "filename" => filename = Some(v.to_string()),
                "referer" => referer = Some(v.to_string()),
                "useragent" | "user-agent" => user_agent = Some(v.to_string()),
                "description" => description = Some(v.to_string()),
                // Deliberately ignore raw `cookie:` / `postdata:` fields in `.ef2`!
                _ => {}
            }
        }
    }

    Ok(entries)
}

/// Serializes [`Ef2Entry`] items into standard IDM `.ef2` LF-normalized format.
#[must_use]
pub fn serialize_ef2(entries: &[Ef2Entry]) -> String {
    let mut out = String::new();
    for entry in entries {
        out.push_str("<\n");
        out.push_str(&entry.url);
        out.push('\n');
        if let Some(ref f) = entry.filename {
            out.push_str("filename: ");
            out.push_str(f);
            out.push('\n');
        }
        if let Some(ref r) = entry.referer {
            out.push_str("referer: ");
            out.push_str(r);
            out.push('\n');
        }
        if let Some(ref ua) = entry.user_agent {
            out.push_str("useragent: ");
            out.push_str(ua);
            out.push('\n');
        }
        if let Some(ref d) = entry.description {
            out.push_str("description: ");
            out.push_str(d);
            out.push('\n');
        }
        out.push_str(">\n");
    }
    out
}

/// Single planned item inside a [`BatchPlan`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BatchItem {
    pub url: String,
    pub filename: Option<String>,
    pub destination_dir: PathBuf,
    pub expected_sha256: Option<String>,
    pub expected_size: Option<u64>,
    pub description: Option<String>,
}

/// Validated batch download plan ready for execution or scheduling.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BatchPlan {
    pub plan_id: String,
    pub items: Vec<BatchItem>,
    pub drm_supported: bool,
}

/// High-level batch planner supporting pattern expansion, `.ef2` import/export, and 5-category routing.
pub struct BatchPlanner {
    policy: SecurityPolicy,
}

impl Default for BatchPlanner {
    fn default() -> Self {
        Self::new()
    }
}

impl BatchPlanner {
    /// Creates a batch planner enforcing strict production SSRF & path policies.
    #[must_use]
    pub const fn new() -> Self {
        Self {
            policy: SecurityPolicy::strict(),
        }
    }

    /// Test-only constructor permitting loopback URLs.
    #[cfg(test)]
    #[must_use]
    pub const fn with_test_policy() -> Self {
        Self {
            policy: SecurityPolicy::allow_loopback_for_tests(),
        }
    }

    /// Expands a URL pattern (`[01-20]`, `[a-z]`), validates every URL and destination path,
    /// and optionally routes items into 5-category subfolders.
    pub fn plan_from_pattern(
        &self,
        pattern: &str,
        staging_dir: &Path,
        workspace_root: Option<&Path>,
        categorize_subfolders: bool,
    ) -> Result<BatchPlan, DownloaderError> {
        let safe_staging = validate_safe_local_path(staging_dir, workspace_root)?;
        let urls = expand_batch_pattern(pattern)?;
        let mut items = Vec::with_capacity(urls.len());
        for url in urls {
            self.policy.validate_url(&url)?;
            let derived_name = url
                .split('?')
                .next()
                .unwrap_or(&url)
                .rsplit('/')
                .next()
                .filter(|s| !s.is_empty())
                .and_then(|raw| safe_output_filename(raw).ok());
            let destination_dir = if categorize_subfolders {
                let cat = derived_name
                    .as_deref()
                    .map_or(DownloadCategory::General, DownloadCategory::classify_filename);
                safe_staging.join(cat.subfolder())
            } else {
                safe_staging.clone()
            };
            items.push(BatchItem {
                url,
                filename: derived_name,
                destination_dir,
                expected_sha256: None,
                expected_size: None,
                description: None,
            });
        }
        Ok(BatchPlan {
            plan_id: omnia_core::uuid_v4(),
            items,
            drm_supported: DRM_SUPPORTED,
        })
    }

    /// Builds a validated [`BatchPlan`] from an IDM `.ef2` manifest string.
    pub fn plan_from_ef2(
        &self,
        ef2_text: &str,
        staging_dir: &Path,
        workspace_root: Option<&Path>,
        categorize_subfolders: bool,
    ) -> Result<BatchPlan, DownloaderError> {
        let safe_staging = validate_safe_local_path(staging_dir, workspace_root)?;
        let entries = parse_ef2(ef2_text)?;
        let mut items = Vec::with_capacity(entries.len());
        for entry in entries {
            self.policy.validate_url(&entry.url)?;
            let destination_dir = if categorize_subfolders {
                let cat = entry
                    .filename
                    .as_deref()
                    .map_or(DownloadCategory::General, DownloadCategory::classify_filename);
                safe_staging.join(cat.subfolder())
            } else {
                safe_staging.clone()
            };
            items.push(BatchItem {
                url: entry.url,
                filename: entry.filename,
                destination_dir,
                expected_sha256: None,
                expected_size: None,
                description: entry.description,
            });
        }
        Ok(BatchPlan {
            plan_id: omnia_core::uuid_v4(),
            items,
            drm_supported: DRM_SUPPORTED,
        })
    }
}

/// Optional daily UTC active schedule window (`[start_hour_utc, end_hour_utc)`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScheduleWindow {
    pub start_hour_utc: u32,
    pub end_hour_utc: u32,
}

impl ScheduleWindow {
    /// Returns `true` when `now` falls inside this schedule window (supports midnight wrap).
    #[must_use]
    pub fn is_active_at(&self, now: DateTime<Utc>) -> bool {
        let h = now.hour();
        if self.start_hour_utc == self.end_hour_utc {
            return true;
        }
        if self.start_hour_utc < self.end_hour_utc {
            h >= self.start_hour_utc && h < self.end_hour_utc
        } else {
            h >= self.start_hour_utc || h < self.end_hour_utc
        }
    }
}

/// Scheduler configuration controlling queue concurrency and active time window.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SchedulerConfig {
    pub max_concurrent_jobs: usize,
    pub window: Option<ScheduleWindow>,
}

impl Default for SchedulerConfig {
    fn default() -> Self {
        Self {
            max_concurrent_jobs: 3,
            window: None,
        }
    }
}

/// Priority-ordered download queue scheduler with active concurrency slot tracking.
#[derive(Debug)]
pub struct DownloadScheduler {
    config: SchedulerConfig,
    queued: VecDeque<BatchItem>,
    active_count: usize,
}

impl Default for DownloadScheduler {
    fn default() -> Self {
        Self::new(SchedulerConfig::default())
    }
}

impl DownloadScheduler {
    #[must_use]
    pub fn new(config: SchedulerConfig) -> Self {
        Self {
            config: SchedulerConfig {
                max_concurrent_jobs: config.max_concurrent_jobs.clamp(1, 32),
                window: config.window,
            },
            queued: VecDeque::new(),
            active_count: 0,
        }
    }

    pub fn enqueue(&mut self, item: BatchItem) {
        self.queued.push_back(item);
    }

    pub fn enqueue_plan(&mut self, plan: BatchPlan) {
        for item in plan.items {
            self.queued.push_back(item);
        }
    }

    /// Pops the next runnable item if inside the schedule window and under `max_concurrent_jobs`.
    pub fn next_dispatch_at(&mut self, now: DateTime<Utc>) -> Option<BatchItem> {
        if let Some(ref win) = self.config.window {
            if !win.is_active_at(now) {
                return None;
            }
        }
        if self.active_count >= self.config.max_concurrent_jobs {
            return None;
        }
        let item = self.queued.pop_front()?;
        self.active_count += 1;
        Some(item)
    }

    /// Releases a concurrency slot after a dispatched job finishes or pauses.
    pub fn mark_finished(&mut self) {
        self.active_count = self.active_count.saturating_sub(1);
    }

    #[must_use]
    pub fn pending_len(&self) -> usize {
        self.queued.len()
    }

    #[must_use]
    pub const fn active_count(&self) -> usize {
        self.active_count
    }

    #[must_use]
    pub const fn config(&self) -> &SchedulerConfig {
        &self.config
    }
}

/// Non-credential per-host connection cap and pacing rule (`*.example.com` wildcard supported).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SiteRule {
    pub host_pattern: String,
    pub max_connections_per_host: usize,
    #[serde(default)]
    pub default_pacing: Option<String>,
    #[serde(default)]
    pub note: String,
}

/// Thread-safe policy registry enforcing per-host connection caps without storing plaintext credentials.
#[derive(Debug, Default, Clone)]
pub struct SitePolicyRegistry {
    rules: Vec<SiteRule>,
}

impl SitePolicyRegistry {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn upsert_rule(&mut self, mut rule: SiteRule) -> Result<SiteRule, DownloaderError> {
        let pat = rule.host_pattern.trim().to_ascii_lowercase();
        if pat.is_empty() || pat.len() > 253 || pat.chars().any(char::is_control) {
            return Err(DownloaderError::InvalidInput(
                "invalid site rule host_pattern".into(),
            ));
        }
        rule.host_pattern = pat.clone();
        rule.max_connections_per_host = rule.max_connections_per_host.clamp(1, 128);
        if let Some(existing) = self.rules.iter_mut().find(|r| r.host_pattern == pat) {
            *existing = rule.clone();
        } else {
            self.rules.push(rule.clone());
        }
        Ok(rule)
    }

    #[must_use]
    pub fn list_rules(&self) -> &[SiteRule] {
        &self.rules
    }

    #[must_use]
    pub fn resolve_for_host(&self, host: &str) -> Option<&SiteRule> {
        let h = host.trim().to_ascii_lowercase();
        if h.is_empty() {
            return None;
        }
        // Exact match first, then longest suffix wildcard (`*.example.com`).
        if let Some(exact) = self.rules.iter().find(|r| r.host_pattern == h) {
            return Some(exact);
        }
        self.rules
            .iter()
            .filter(|r| {
                if let Some(suffix) = r.host_pattern.strip_prefix("*.") {
                    h == suffix || h.ends_with(&format!(".{suffix}"))
                } else {
                    false
                }
            })
            .max_by_key(|r| r.host_pattern.len())
    }
}

/// Path-safe `auto_group_series` resolver: extracts a sanitized series subfolder name
/// from episode filenames (e.g. `"Show Name Season 2 - Ep 06.mp4"` -> `"Show Name Season 2"`).
/// Strictly strips traversal, control characters, and Win32 reserved device names.
#[must_use]
pub fn resolve_series_subfolder(filename: &str) -> Option<String> {
    let stem = Path::new(filename)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(filename)
        .trim();
    if stem.is_empty() {
        return None;
    }
    let lower = stem.to_ascii_lowercase();
    let markers = [
        " - ep ", " - ep.", " ep ", " episode ", " - tap ", " tap ", " - tập ", " tập ",
        " s01e", " s02e", " s03e", " s04e", " s05e", " s06e", " s07e", " s08e", " s09e",
        " s10e", ".s01e", ".s02e", ".s03e", "_s01e", "_s02e",
    ];
    let mut cut_idx: Option<usize> = None;
    for marker in markers {
        if let Some(pos) = lower.find(marker) {
            if pos >= 2 {
                cut_idx = Some(match cut_idx {
                    Some(prev) => prev.min(pos),
                    None => pos,
                });
            }
        }
    }
    let raw_prefix = match cut_idx {
        Some(idx) if stem.is_char_boundary(idx) => &stem[..idx],
        _ => return None,
    };
    let cleaned = safe_output_filename(raw_prefix.trim_matches(|c: char| {
        matches!(c, ' ' | '-' | '_' | '.' | '[' | ']' | '(' | ')')
    }))
    .ok()?;
    let trimmed = cleaned.trim().to_string();
    if trimmed.len() < 2 || trimmed == "download" {
        return None;
    }
    Some(trimmed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn expands_numeric_padded_and_alpha_batch_patterns() {
        let nums = expand_batch_pattern("https://cdn.example.org/part_[01-20].bin").unwrap();
        assert_eq!(nums.len(), 20);
        assert_eq!(nums[0], "https://cdn.example.org/part_01.bin");
        assert_eq!(nums[19], "https://cdn.example.org/part_20.bin");

        let alpha = expand_batch_pattern("https://cdn.example.org/vol_[a-e].tar").unwrap();
        assert_eq!(
            alpha,
            vec![
                "https://cdn.example.org/vol_a.tar",
                "https://cdn.example.org/vol_b.tar",
                "https://cdn.example.org/vol_c.tar",
                "https://cdn.example.org/vol_d.tar",
                "https://cdn.example.org/vol_e.tar",
            ]
        );

        let cartesian = expand_batch_pattern("https://cdn.example.org/[a-b]_[01-03:2].mp4").unwrap();
        assert_eq!(
            cartesian,
            vec![
                "https://cdn.example.org/a_01.mp4",
                "https://cdn.example.org/a_03.mp4",
                "https://cdn.example.org/b_01.mp4",
                "https://cdn.example.org/b_03.mp4",
            ]
        );
    }

    #[test]
    fn ef2_roundtrips_and_strips_raw_cookies() {
        let raw_ef2 = "\
<
https://cdn.example.org/files/report.pdf
filename: report.pdf
referer: https://example.org/docs
cookie: SESSION=dummy_cookie_should_be_dropped
description: Quarterly report
>
<
https://cdn.example.org/files/archive.zip
filename: archive.zip
>
";
        let entries = parse_ef2(raw_ef2).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].filename.as_deref(), Some("report.pdf"));
        assert_eq!(entries[0].referer.as_deref(), Some("https://example.org/docs"));

        let serialized = serialize_ef2(&entries);
        assert!(!serialized.contains("dummy_cookie_should_be_dropped"));
        let reparsed = parse_ef2(&serialized).unwrap();
        assert_eq!(reparsed, entries);
    }

    #[test]
    fn scheduler_respects_concurrency_and_window() {
        let mut sched = DownloadScheduler::new(SchedulerConfig {
            max_concurrent_jobs: 2,
            window: Some(ScheduleWindow {
                start_hour_utc: 22,
                end_hour_utc: 6,
            }),
        });
        for i in 1..=3 {
            sched.enqueue(BatchItem {
                url: format!("https://cdn.example.org/f{i}.bin"),
                filename: Some(format!("f{i}.bin")),
                destination_dir: PathBuf::from(r"D:\OmniaData\downloads"),
                expected_sha256: None,
                expected_size: None,
                description: None,
            });
        }

        let midday = Utc.with_ymd_and_hms(2026, 11, 22, 12, 0, 0).unwrap();
        assert!(sched.next_dispatch_at(midday).is_none());

        let night = Utc.with_ymd_and_hms(2026, 11, 22, 23, 30, 0).unwrap();
        assert!(sched.next_dispatch_at(night).is_some());
        assert!(sched.next_dispatch_at(night).is_some());
        // 3rd blocked by max_concurrent_jobs=2
        assert!(sched.next_dispatch_at(night).is_none());
        sched.mark_finished();
        assert!(sched.next_dispatch_at(night).is_some());
    }

    #[test]
    fn site_policy_registry_and_auto_group_series_enforce_safety() {
        let mut reg = SitePolicyRegistry::new();
        reg.upsert_rule(SiteRule {
            host_pattern: "*.example.org".into(),
            max_connections_per_host: 8,
            default_pacing: Some("adaptive".into()),
            note: "cdn rule".into(),
        })
        .unwrap();
        let resolved = reg.resolve_for_host("media.cdn.example.org").unwrap();
        assert_eq!(resolved.max_connections_per_host, 8);

        assert_eq!(
            resolve_series_subfolder("Black Clover Season 2 - Ep 06.mp4").as_deref(),
            Some("Black Clover Season 2")
        );
        assert_eq!(
            resolve_series_subfolder("Course_Lecture_S01E04.mkv").as_deref(),
            Some("Course_Lecture")
        );
        assert!(resolve_series_subfolder("../../CON - Ep 01.mp4")
            .is_none_or(|s| !s.contains("..")));
    }
}
