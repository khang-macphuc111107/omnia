//! Scheduled agent tasks ("cron"): a JSON list in the app data dir plus a
//! background runner that fires due schedules through the harness bridge.
//! Schedules only run while the app is open; a run missed while it was
//! closed fires once at the next start (catch-up), never repeatedly.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use chrono::{Datelike, Local, LocalResult, NaiveDate, NaiveDateTime, TimeZone, Timelike, Utc};
use omnia_harness::permission::PermissionMode;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::error::{NativeError, NativeResult};
use crate::harness_bridge::{self, AgentSendRequest, AgentSessionCreateRequest, HarnessHub};
use crate::state::AppState;

const FILE_NAME: &str = "agent-schedules.json";
const MAX_SCHEDULES: usize = 100;
const MAX_NAME_CHARS: usize = 80;
const MAX_PROMPT_BYTES: usize = 64 * 1024;
const MAX_INTERVAL_MINUTES: u32 = 60 * 24 * 365;
const TICK: Duration = Duration::from_secs(30);
const RUN_CAP: Duration = Duration::from_secs(6 * 60 * 60);
const STATUS_BUSY: &str = "skipped: session busy";

// ---------------------------------------------------------------------------
// Cron parsing and next-run computation (pure)
// ---------------------------------------------------------------------------

/// A parsed 5-field cron expression (minute hour day-of-month month day-of-week).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CronSpec {
    minutes: u64,
    hours: u64,
    days: u64,
    months: u64,
    /// Bit 0 = Sunday (7 is folded into 0).
    weekdays: u64,
    dom_star: bool,
    dow_star: bool,
}

fn parse_number(text: &str, name: &str, min: u32, max: u32) -> Result<u32, String> {
    if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit()) || text.len() > 3 {
        return Err(format!("{name}: '{text}' is not a number"));
    }
    let value: u32 = text
        .parse()
        .map_err(|_| format!("{name}: '{text}' is not a number"))?;
    if value < min || value > max {
        return Err(format!("{name}: {value} is outside {min}-{max}"));
    }
    Ok(value)
}

/// Returns the bit set and whether the field starts with `*`.
fn parse_field(text: &str, name: &str, min: u32, max: u32) -> Result<(u64, bool), String> {
    if text.is_empty() {
        return Err(format!("{name}: empty field"));
    }
    let mut mask = 0u64;
    for item in text.split(',') {
        let (base, step) = match item.split_once('/') {
            Some((base, step)) => {
                let step = parse_number(step, name, 1, max)?;
                (base, Some(step))
            }
            None => (item, None),
        };
        let (lo, hi) = if base == "*" {
            (min, max)
        } else if let Some((a, b)) = base.split_once('-') {
            let (a, b) = (
                parse_number(a, name, min, max)?,
                parse_number(b, name, min, max)?,
            );
            if a > b {
                return Err(format!("{name}: range {a}-{b} is backwards"));
            }
            (a, b)
        } else {
            let n = parse_number(base, name, min, max)?;
            // "5/15" means 5 through the end of the field, every 15.
            (n, if step.is_some() { max } else { n })
        };
        let step = step.unwrap_or(1);
        let mut value = lo;
        while value <= hi {
            mask |= 1u64 << value;
            value += step;
        }
    }
    Ok((mask, text.starts_with('*')))
}

impl CronSpec {
    pub fn parse(expression: &str) -> Result<Self, String> {
        let fields: Vec<&str> = expression.split_whitespace().collect();
        if fields.len() != 5 {
            return Err(format!(
                "A cron expression needs 5 fields (minute hour day month weekday), found {}",
                fields.len()
            ));
        }
        let (minutes, _) = parse_field(fields[0], "minute", 0, 59)?;
        let (hours, _) = parse_field(fields[1], "hour", 0, 23)?;
        let (days, dom_star) = parse_field(fields[2], "day of month", 1, 31)?;
        let (months, _) = parse_field(fields[3], "month", 1, 12)?;
        let (mut weekdays, dow_star) = parse_field(fields[4], "day of week", 0, 7)?;
        if weekdays & (1 << 7) != 0 {
            weekdays = (weekdays & !(1 << 7)) | 1;
        }
        Ok(Self {
            minutes,
            hours,
            days,
            months,
            weekdays,
            dom_star,
            dow_star,
        })
    }

    fn day_matches(&self, date: NaiveDate) -> bool {
        if self.months & (1 << date.month()) == 0 {
            return false;
        }
        let dom = self.days & (1 << date.day()) != 0;
        let dow = self.weekdays & (1 << date.weekday().num_days_from_sunday()) != 0;
        // Vixie semantics: when both day fields are restricted, either may match.
        if self.dom_star || self.dow_star {
            dom && dow
        } else {
            dom || dow
        }
    }

    /// First matching minute strictly after `after` (wall-clock time).
    /// `None` when the expression can never fire (e.g. February 30).
    pub fn next_after(&self, after: NaiveDateTime) -> Option<NaiveDateTime> {
        let start = after.with_second(0)?.with_nanosecond(0)? + chrono::Duration::minutes(1);
        // Eight years covers the longest gap (February 29 across a skipped leap year).
        for offset in 0..=(366 * 8) {
            let date = start.date() + chrono::Duration::days(offset);
            if !self.day_matches(date) {
                continue;
            }
            let (first_hour, first_minute) = if offset == 0 {
                (start.hour(), start.minute())
            } else {
                (0, 0)
            };
            for hour in first_hour..24 {
                if self.hours & (1 << hour) == 0 {
                    continue;
                }
                let from = if hour == first_hour { first_minute } else { 0 };
                for minute in from..60 {
                    if self.minutes & (1 << minute) != 0 {
                        return date.and_hms_opt(hour, minute, 0);
                    }
                }
            }
        }
        None
    }
}

fn local_ms(naive: NaiveDateTime) -> Option<i64> {
    match Local.from_local_datetime(&naive) {
        LocalResult::Single(t) => Some(t.timestamp_millis()),
        LocalResult::Ambiguous(first, _) => Some(first.timestamp_millis()),
        LocalResult::None => None,
    }
}

fn naive_local(ms: i64) -> NaiveDateTime {
    Local
        .timestamp_millis_opt(ms)
        .single()
        .map(|t| t.naive_local())
        .unwrap_or_else(|| Utc::now().naive_utc())
}

/// Next `count` fire times (epoch ms) strictly after `after_ms`, local time.
pub fn next_runs(spec: &CronSpec, after_ms: i64, count: usize) -> Vec<i64> {
    let mut out = Vec::new();
    let mut cursor = naive_local(after_ms);
    while out.len() < count {
        let Some(next) = spec.next_after(cursor) else {
            break;
        };
        cursor = next;
        // Wall-clock times skipped by a DST jump simply do not fire.
        if let Some(ms) = local_ms(next) {
            if ms > after_ms {
                out.push(ms);
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Schedule model (pure helpers)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewSessionTemplate {
    pub cwd: String,
    pub profile_id: String,
    pub model: String,
    #[serde(default)]
    pub permission_mode: Option<PermissionMode>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Schedule {
    /// Empty on first save; the store assigns one.
    #[serde(default)]
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub new_session: Option<NewSessionTemplate>,
    pub prompt: String,
    #[serde(default)]
    pub cron: Option<String>,
    #[serde(default)]
    pub interval_minutes: Option<u32>,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub last_run_at: Option<i64>,
    #[serde(default)]
    pub next_run_at: Option<i64>,
    #[serde(default)]
    pub last_status: Option<String>,
    #[serde(default)]
    pub last_message: Option<String>,
}

/// Next fire time strictly after `from_ms`; `Ok(None)` if it can never fire.
pub fn compute_next(schedule: &Schedule, from_ms: i64) -> Result<Option<i64>, String> {
    match (&schedule.cron, schedule.interval_minutes) {
        (Some(cron), None) => Ok(next_runs(&CronSpec::parse(cron)?, from_ms, 1)
            .first()
            .copied()),
        (None, Some(minutes)) => Ok(Some(from_ms + i64::from(minutes) * 60_000)),
        _ => Err("Set either a cron expression or an interval".to_owned()),
    }
}

/// A schedule is due when enabled and its next run time has passed. Because a
/// claimed schedule is advanced from *now*, any number of missed slots (app
/// closed) collapse into one catch-up run.
pub fn is_due(schedule: &Schedule, now_ms: i64) -> bool {
    schedule.enabled && schedule.next_run_at.is_some_and(|next| next <= now_ms)
}

/// Normalizes and validates a schedule from the renderer. Does not touch
/// run bookkeeping (`last*`, `nextRunAt`).
pub fn validate(mut schedule: Schedule) -> NativeResult<Schedule> {
    schedule.name = schedule.name.trim().chars().take(MAX_NAME_CHARS).collect();
    if schedule.name.is_empty() {
        return Err(NativeError::invalid("name", "is empty"));
    }
    if schedule.prompt.trim().is_empty() {
        return Err(NativeError::invalid("prompt", "is empty"));
    }
    if schedule.prompt.len() > MAX_PROMPT_BYTES {
        return Err(NativeError::invalid("prompt", "is too long"));
    }
    schedule.session_id = schedule
        .session_id
        .map(|id| id.trim().to_owned())
        .filter(|id| !id.is_empty());
    match (&mut schedule.session_id, &mut schedule.new_session) {
        (Some(_), None) => {}
        (None, Some(template)) => {
            template.cwd = template.cwd.trim().to_owned();
            template.profile_id = template.profile_id.trim().to_owned();
            template.model = template.model.trim().to_owned();
            if template.cwd.is_empty() {
                return Err(NativeError::invalid("newSession.cwd", "is empty"));
            }
            if template.profile_id.is_empty() {
                return Err(NativeError::invalid("newSession.profileId", "is empty"));
            }
            if template.model.is_empty() {
                return Err(NativeError::invalid("newSession.model", "is empty"));
            }
        }
        _ => {
            return Err(NativeError::invalid(
                "target",
                "must be either an existing session or a new-session template",
            ))
        }
    }
    schedule.cron = schedule
        .cron
        .map(|c| c.trim().to_owned())
        .filter(|c| !c.is_empty());
    match (&schedule.cron, schedule.interval_minutes) {
        (Some(cron), None) => {
            let spec = CronSpec::parse(cron).map_err(|e| NativeError::invalid("cron", e))?;
            if next_runs(&spec, Utc::now().timestamp_millis(), 1).is_empty() {
                return Err(NativeError::invalid(
                    "cron",
                    "never fires (impossible date)",
                ));
            }
        }
        (None, Some(minutes)) => {
            if minutes == 0 || minutes > MAX_INTERVAL_MINUTES {
                return Err(NativeError::invalid(
                    "intervalMinutes",
                    "must be between 1 and 525600",
                ));
            }
        }
        _ => {
            return Err(NativeError::invalid(
                "schedule",
                "needs either cron or intervalMinutes",
            ))
        }
    }
    Ok(schedule)
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

pub struct ScheduleStore {
    file: PathBuf,
    lock: Mutex<()>,
    in_flight: Mutex<HashSet<String>>,
}

fn failed(what: &str) -> NativeError {
    NativeError::new("schedules_failed", format!("Could not {what} schedules"))
}

impl ScheduleStore {
    pub fn new(app_data_dir: &Path) -> Self {
        Self {
            file: app_data_dir.join(FILE_NAME),
            lock: Mutex::new(()),
            in_flight: Mutex::new(HashSet::new()),
        }
    }

    fn read(&self) -> Vec<Schedule> {
        std::fs::read(&self.file)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    fn write(&self, schedules: &[Schedule]) -> NativeResult<()> {
        let save = || -> std::io::Result<()> {
            if let Some(dir) = self.file.parent() {
                std::fs::create_dir_all(dir)?;
            }
            let tmp = self.file.with_extension("json.tmp");
            std::fs::write(
                &tmp,
                serde_json::to_vec_pretty(schedules).map_err(std::io::Error::other)?,
            )?;
            std::fs::rename(&tmp, &self.file)
        };
        save().map_err(|_| failed("save"))
    }

    fn guard(&self) -> std::sync::MutexGuard<'_, ()> {
        self.lock.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn list(&self) -> NativeResult<Vec<Schedule>> {
        let _guard = self.guard();
        Ok(self.read())
    }

    pub fn get(&self, id: &str) -> Option<Schedule> {
        let _guard = self.guard();
        self.read().into_iter().find(|s| s.id == id)
    }

    /// Inserts or replaces by id; recomputes `nextRunAt` from `now_ms` and
    /// keeps the stored run bookkeeping. Returns the full list.
    pub fn save(&self, schedule: Schedule, now_ms: i64) -> NativeResult<Vec<Schedule>> {
        let mut schedule = validate(schedule)?;
        let _guard = self.guard();
        let mut all = self.read();
        if schedule.id.trim().is_empty() {
            schedule.id = uuid::Uuid::new_v4().to_string();
        }
        let existing = all.iter().position(|s| s.id == schedule.id);
        if let Some(index) = existing {
            schedule.last_run_at = all[index].last_run_at;
            schedule.last_status = all[index].last_status.clone();
            schedule.last_message = all[index].last_message.clone();
        } else {
            schedule.last_run_at = None;
            schedule.last_status = None;
            schedule.last_message = None;
        }
        schedule.next_run_at = if schedule.enabled {
            compute_next(&schedule, now_ms).map_err(|e| NativeError::invalid("schedule", e))?
        } else {
            None
        };
        match existing {
            Some(index) => all[index] = schedule,
            None if all.len() >= MAX_SCHEDULES => {
                return Err(NativeError::invalid("schedule", "too many schedules"))
            }
            None => all.push(schedule),
        }
        self.write(&all)?;
        Ok(all)
    }

    pub fn delete(&self, id: &str) -> NativeResult<Vec<Schedule>> {
        let _guard = self.guard();
        let mut all = self.read();
        all.retain(|s| s.id != id);
        self.write(&all)?;
        Ok(all)
    }

    /// Applies `change` to one schedule under the lock (best effort).
    fn update(&self, id: &str, change: impl FnOnce(&mut Schedule)) {
        let _guard = self.guard();
        let mut all = self.read();
        if let Some(schedule) = all.iter_mut().find(|s| s.id == id) {
            change(schedule);
            let _ = self.write(&all);
        }
    }

    /// Returns the ids of due schedules, advancing each one's `nextRunAt` to
    /// the first slot after `now_ms` so a claimed schedule fires once.
    fn claim_due(&self, now_ms: i64) -> Vec<String> {
        let _guard = self.guard();
        let mut all = self.read();
        let mut claimed = Vec::new();
        for schedule in all.iter_mut().filter(|s| is_due(s, now_ms)) {
            schedule.next_run_at = compute_next(schedule, now_ms).ok().flatten();
            claimed.push(schedule.id.clone());
        }
        if !claimed.is_empty() {
            let _ = self.write(&all);
        }
        claimed
    }

    /// A run cut off by closing the app can never report back.
    fn reset_stale_running(&self) {
        let _guard = self.guard();
        let mut all = self.read();
        let mut changed = false;
        for schedule in all
            .iter_mut()
            .filter(|s| s.last_status.as_deref() == Some("running"))
        {
            schedule.last_status = Some("interrupted".to_owned());
            schedule.last_message = Some("The app was closed during this run".to_owned());
            changed = true;
        }
        if changed {
            let _ = self.write(&all);
        }
    }

    fn begin(&self, id: &str) -> bool {
        self.in_flight
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id.to_owned())
    }

    fn end(&self, id: &str) {
        self.in_flight
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(id);
    }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

/// Starts the background runner. Call once from the Tauri setup hook, after
/// `ScheduleStore` and `HarnessHub` are managed.
pub fn start(app: &AppHandle) {
    app.state::<ScheduleStore>().reset_stale_running();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // Let the window and harness settle before catch-up runs fire.
        tokio::time::sleep(Duration::from_secs(5)).await;
        loop {
            for id in app.state::<ScheduleStore>().claim_due(now_ms()) {
                let app = app.clone();
                tauri::async_runtime::spawn(async move { fire(app, id).await });
            }
            tokio::time::sleep(TICK).await;
        }
    });
}

async fn fire(app: AppHandle, id: String) {
    let store = app.state::<ScheduleStore>();
    if !store.begin(&id) {
        return;
    }
    if let Some(schedule) = store.get(&id) {
        let (status, message) = execute(&app, &schedule, &store).await;
        store.update(&id, |s| {
            s.last_status = Some(status);
            s.last_message = message;
        });
    }
    store.end(&id);
}

fn describe(error: &NativeError) -> String {
    error.message.chars().take(300).collect()
}

async fn execute(
    app: &AppHandle,
    schedule: &Schedule,
    store: &ScheduleStore,
) -> (String, Option<String>) {
    let hub = app.state::<HarnessHub>();
    let state = app.state::<AppState>();
    let session_id = match (&schedule.session_id, &schedule.new_session) {
        (Some(id), _) => {
            if hub.run_active(id) {
                return (STATUS_BUSY.to_owned(), None);
            }
            id.clone()
        }
        (None, Some(template)) => {
            let created = harness_bridge::create_session(
                &hub,
                AgentSessionCreateRequest {
                    cwd: template.cwd.clone(),
                    profile_id: template.profile_id.clone(),
                    model: template.model.clone(),
                    permission_mode: template.permission_mode,
                    reasoning_effort: None,
                    title: Some(schedule.name.clone()),
                    fallback_models: Vec::new(),
                    token_budget: None,
                    system_prompt: None,
                },
            );
            match created {
                Ok(summary) => summary.id,
                Err(error) => return ("failed".to_owned(), Some(describe(&error))),
            }
        }
        _ => {
            return (
                "failed".to_owned(),
                Some("Schedule has no target".to_owned()),
            )
        }
    };

    // Subscribe first so a fast run cannot finish unnoticed.
    let mut finished = hub.subscribe_finished();
    store.update(&schedule.id, |s| {
        s.last_run_at = Some(now_ms());
        s.last_status = Some("running".to_owned());
        s.last_message = None;
    });
    let sent = harness_bridge::send_message(
        app,
        &state,
        &hub,
        AgentSendRequest {
            session_id: session_id.clone(),
            text: schedule.prompt.clone(),
            images: Vec::new(),
        },
    )
    .await;
    if let Err(error) = sent {
        return ("failed".to_owned(), Some(describe(&error)));
    }
    let deadline = tokio::time::Instant::now() + RUN_CAP;
    let event = loop {
        match tokio::time::timeout_at(deadline, finished.recv()).await {
            Err(_) => {
                return (
                    "timeout".to_owned(),
                    Some("Still running after 6 hours".to_owned()),
                );
            }
            Ok(Ok(done)) if done.session_id == session_id => break Some(done.event),
            Ok(Ok(_)) => {}
            Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(_))) => {
                if !hub.run_active(&session_id) {
                    break None;
                }
            }
            Ok(Err(tokio::sync::broadcast::error::RecvError::Closed)) => break None,
        }
    };
    let status = event
        .as_ref()
        .and_then(|e| e.get("status"))
        .and_then(|v| v.as_str())
        .unwrap_or("completed")
        .to_owned();
    let message = event
        .as_ref()
        .and_then(|e| e.get("message"))
        .and_then(|v| v.as_str())
        .map(|m| m.chars().take(300).collect());
    (status, message)
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn agent_schedules_list(store: State<'_, ScheduleStore>) -> NativeResult<Vec<Schedule>> {
    store.list()
}

#[derive(Debug, Deserialize)]
pub struct AgentScheduleSaveRequest {
    pub schedule: Schedule,
}

#[tauri::command]
pub fn agent_schedule_save(
    store: State<'_, ScheduleStore>,
    request: AgentScheduleSaveRequest,
) -> NativeResult<Vec<Schedule>> {
    store.save(request.schedule, now_ms())
}

#[derive(Debug, Deserialize)]
pub struct AgentScheduleIdRequest {
    pub id: String,
}

#[tauri::command]
pub fn agent_schedule_delete(
    store: State<'_, ScheduleStore>,
    request: AgentScheduleIdRequest,
) -> NativeResult<Vec<Schedule>> {
    store.delete(&request.id)
}

/// Starts the run in the background and returns at once; progress shows in
/// the schedule's `lastStatus`.
#[tauri::command]
pub fn agent_schedule_run_now(
    app: AppHandle,
    store: State<'_, ScheduleStore>,
    request: AgentScheduleIdRequest,
) -> NativeResult<()> {
    let id = request.id;
    if store.get(&id).is_none() {
        return Err(NativeError::invalid("id", "is unknown"));
    }
    if store
        .in_flight
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .contains(&id)
    {
        return Err(NativeError::new(
            "schedule_running",
            "This schedule is already running",
        ));
    }
    tauri::async_runtime::spawn(async move { fire(app, id).await });
    Ok(())
}

#[derive(Debug, Deserialize)]
pub struct AgentSchedulePreviewRequest {
    pub cron: String,
}

/// The next three fire times (epoch ms, local time) of a cron expression.
#[tauri::command]
pub fn agent_schedule_preview(request: AgentSchedulePreviewRequest) -> NativeResult<Vec<i64>> {
    let spec = CronSpec::parse(request.cron.trim()).map_err(|e| NativeError::invalid("cron", e))?;
    let runs = next_runs(&spec, now_ms(), 3);
    if runs.is_empty() {
        return Err(NativeError::invalid(
            "cron",
            "never fires (impossible date)",
        ));
    }
    Ok(runs)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> NaiveDateTime {
        NaiveDate::from_ymd_opt(y, mo, d)
            .unwrap()
            .and_hms_opt(h, mi, 0)
            .unwrap()
    }

    fn next(expr: &str, after: NaiveDateTime) -> Option<NaiveDateTime> {
        CronSpec::parse(expr).unwrap().next_after(after)
    }

    fn sched(cron: Option<&str>, interval: Option<u32>) -> Schedule {
        Schedule {
            id: String::new(),
            name: "Nightly".into(),
            session_id: Some("s1".into()),
            new_session: None,
            prompt: "run tests".into(),
            cron: cron.map(str::to_owned),
            interval_minutes: interval,
            enabled: true,
            last_run_at: None,
            next_run_at: None,
            last_status: None,
            last_message: None,
        }
    }

    #[test]
    fn every_fifteen_minutes() {
        assert_eq!(
            next("*/15 * * * *", at(2026, 3, 4, 10, 0)),
            Some(at(2026, 3, 4, 10, 15))
        );
        assert_eq!(
            next("*/15 * * * *", at(2026, 3, 4, 10, 46)),
            Some(at(2026, 3, 4, 11, 0))
        );
        assert_eq!(
            next("*/15 * * * *", at(2026, 12, 31, 23, 59)),
            Some(at(2027, 1, 1, 0, 0))
        );
    }

    #[test]
    fn weekdays_at_nine() {
        // 2026-03-06 is a Friday; the next weekday 09:00 after 09:00 is Monday the 9th.
        assert_eq!(
            next("0 9 * * 1-5", at(2026, 3, 6, 9, 0)),
            Some(at(2026, 3, 9, 9, 0))
        );
        assert_eq!(
            next("0 9 * * 1-5", at(2026, 3, 6, 8, 59)),
            Some(at(2026, 3, 6, 9, 0))
        );
    }

    #[test]
    fn dow_seven_is_sunday() {
        let sunday = CronSpec::parse("30 6 * * 7").unwrap();
        assert_eq!(sunday, CronSpec::parse("30 6 * * 0").unwrap());
        // 2026-03-08 is a Sunday.
        assert_eq!(
            sunday.next_after(at(2026, 3, 4, 0, 0)),
            Some(at(2026, 3, 8, 6, 30))
        );
    }

    #[test]
    fn lists_ranges_and_steps() {
        assert_eq!(
            next("5,35 8-9 * * *", at(2026, 3, 4, 8, 5)),
            Some(at(2026, 3, 4, 8, 35))
        );
        assert_eq!(
            next("5,35 8-9 * * *", at(2026, 3, 4, 9, 35)),
            Some(at(2026, 3, 5, 8, 5))
        );
        assert_eq!(
            next("0-30/10 12 * * *", at(2026, 3, 4, 12, 10)),
            Some(at(2026, 3, 4, 12, 20))
        );
        assert_eq!(
            next("0 0 1 */3 *", at(2026, 1, 1, 0, 0)),
            Some(at(2026, 4, 1, 0, 0))
        );
    }

    #[test]
    fn day_of_month_or_weekday_when_both_restricted() {
        // Friday the 13th rule is OR: the 13th or any Friday.
        assert_eq!(
            next("0 0 13 * 5", at(2026, 3, 4, 0, 0)),
            Some(at(2026, 3, 6, 0, 0))
        );
        assert_eq!(
            next("0 0 13 * 5", at(2026, 3, 6, 0, 0)),
            Some(at(2026, 3, 13, 0, 0))
        );
    }

    #[test]
    fn impossible_dates_never_fire() {
        assert_eq!(next("0 0 30 2 *", at(2026, 1, 1, 0, 0)), None);
        assert_eq!(next("0 0 31 4 *", at(2026, 1, 1, 0, 0)), None);
        assert!(next_runs(&CronSpec::parse("0 0 30 2 *").unwrap(), 0, 3).is_empty());
        let rejected = validate(sched(Some("0 0 30 2 *"), None));
        assert!(rejected.is_err());
    }

    #[test]
    fn leap_day_is_found() {
        assert_eq!(
            next("0 12 29 2 *", at(2026, 1, 1, 0, 0)),
            Some(at(2028, 2, 29, 12, 0))
        );
    }

    #[test]
    fn invalid_expressions_are_rejected() {
        for bad in [
            "",
            "* * * *",
            "* * * * * *",
            "60 * * * *",
            "* 24 * * *",
            "* * 0 * *",
            "* * 32 * *",
            "* * * 13 *",
            "* * * * 8",
            "a * * * *",
            "*/0 * * * *",
            "5-1 * * * *",
            "1,,2 * * * *",
            "*/ * * * *",
            "-5 * * * *",
        ] {
            assert!(CronSpec::parse(bad).is_err(), "{bad:?} should be rejected");
        }
    }

    #[test]
    fn next_runs_are_increasing_local_times() {
        let spec = CronSpec::parse("*/15 * * * *").unwrap();
        let now = now_ms();
        let runs = next_runs(&spec, now, 3);
        assert_eq!(runs.len(), 3);
        assert!(runs[0] > now && runs[0] <= now + 15 * 60_000 + 3_600_000);
        assert!(runs[0] < runs[1] && runs[1] < runs[2]);
    }

    #[test]
    fn interval_and_cron_next() {
        let every_ten = sched(None, Some(10));
        assert_eq!(compute_next(&every_ten, 1_000), Ok(Some(1_000 + 600_000)));
        assert!(compute_next(&sched(None, None), 0).is_err());
        assert!(compute_next(&sched(Some("* * * * *"), Some(5)), 0).is_err());
    }

    #[test]
    fn catch_up_fires_once_after_downtime() {
        let now = 10_000_000_000i64;
        let mut s = sched(Some("*/15 * * * *"), None);
        // The app was closed for three days: next run is long overdue.
        s.next_run_at = Some(now - 3 * 24 * 3_600_000);
        assert!(is_due(&s, now));
        s.next_run_at = compute_next(&s, now).unwrap();
        assert!(s.next_run_at.unwrap() > now);
        assert!(
            !is_due(&s, now),
            "a claimed schedule must not fire again for the missed slots"
        );
        // Disabled and not-yet-due schedules never fire.
        s.next_run_at = Some(now - 1);
        s.enabled = false;
        assert!(!is_due(&s, now));
        s.enabled = true;
        s.next_run_at = Some(now + 1);
        assert!(!is_due(&s, now));
        s.next_run_at = None;
        assert!(!is_due(&s, now));
    }

    #[test]
    fn validation_rules() {
        assert!(validate(sched(Some("0 9 * * 1-5"), None)).is_ok());
        assert!(validate(sched(None, Some(30))).is_ok());
        assert!(validate(sched(None, Some(0))).is_err());
        assert!(validate(sched(None, None)).is_err());
        assert!(validate(sched(Some("* * * * *"), Some(5))).is_err());
        let mut blank = sched(None, Some(5));
        blank.prompt = "  ".into();
        assert!(validate(blank).is_err());
        let mut no_target = sched(None, Some(5));
        no_target.session_id = None;
        assert!(validate(no_target).is_err());
        let mut both = sched(None, Some(5));
        both.new_session = Some(NewSessionTemplate {
            cwd: "C:/x".into(),
            profile_id: "p".into(),
            model: "m".into(),
            permission_mode: None,
        });
        assert!(validate(both).is_err());
    }

    #[test]
    fn store_roundtrip_claim_and_stale_reset() {
        let dir = std::env::temp_dir().join(format!("omnia-sched-{}", uuid::Uuid::new_v4()));
        let store = ScheduleStore::new(&dir);
        assert!(store.list().unwrap().is_empty());
        let now = 1_700_000_000_000;
        let list = store.save(sched(None, Some(10)), now).unwrap();
        let id = list[0].id.clone();
        assert!(!id.is_empty());
        assert_eq!(list[0].next_run_at, Some(now + 600_000));

        // Not due yet, then due once, then claimed (advanced) so it is not due again.
        assert!(store.claim_due(now).is_empty());
        assert_eq!(store.claim_due(now + 3_600_000), vec![id.clone()]);
        assert!(store.claim_due(now + 3_600_000).is_empty());
        assert_eq!(
            store.get(&id).unwrap().next_run_at,
            Some(now + 3_600_000 + 600_000)
        );

        // Re-saving keeps run bookkeeping and recomputes next; disabling clears it.
        store.update(&id, |s| {
            s.last_status = Some("running".into());
            s.last_run_at = Some(5);
        });
        let mut edited = store.get(&id).unwrap();
        edited.enabled = false;
        edited.last_status = Some("forged".into());
        let list = store.save(edited, now).unwrap();
        assert_eq!(list[0].next_run_at, None);
        assert_eq!(list[0].last_status.as_deref(), Some("running"));
        assert_eq!(list[0].last_run_at, Some(5));

        ScheduleStore::new(&dir).reset_stale_running();
        let reloaded = ScheduleStore::new(&dir).get(&id).unwrap();
        assert_eq!(reloaded.last_status.as_deref(), Some("interrupted"));

        assert!(store.delete(&id).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn begin_is_exclusive_per_schedule() {
        let store = ScheduleStore::new(&std::env::temp_dir());
        assert!(store.begin("a"));
        assert!(!store.begin("a"));
        assert!(store.begin("b"));
        store.end("a");
        assert!(store.begin("a"));
    }
}
