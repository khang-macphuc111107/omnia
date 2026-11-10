//! Execution of the browser tools.

use std::sync::Arc;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use omnia_harness::{Block, ToolContext};
use serde::Deserialize;
use serde_json::Value;

use super::schema::Kind;
use super::BrowserHandle;
use crate::browser::Browser;
use crate::capture::{ImageFormat, ScreenshotOptions};
use crate::input::{ClickOptions, MouseButton, Target};
use crate::keys;
use crate::network::NetworkFilter;
use crate::snapshot::SnapshotOptions;
use crate::tab::{NavigateOptions, Tab, TabInfo, WaitCondition};

pub(crate) type ToolResult = Result<Vec<Block>, String>;
type Out = Result<(Vec<Block>, Option<Tab>), String>;

const SCREENSHOT_MAX_SIDE: u32 = 1568;
const SCREENSHOT_QUALITY: u8 = 70;
const MAX_EVAL_CHARS: usize = 20_000;

fn parse<T: for<'de> Deserialize<'de>>(input: Value) -> Result<T, String> {
    serde_json::from_value(input).map_err(|e| format!("invalid arguments: {e}"))
}

fn text(s: impl Into<String>) -> Vec<Block> {
    vec![Block::text(s)]
}

/// Adds a scheme when missing (`http` for localhost/IPs, `https` otherwise).
pub fn normalize_url(raw: &str) -> String {
    let url = raw.trim();
    let lower = url.to_ascii_lowercase();
    if lower.contains("://")
        || [
            "about:",
            "data:",
            "blob:",
            "javascript:",
            "file:",
            "mailto:",
            "edge:",
            "chrome:",
        ]
        .iter()
        .any(|p| lower.starts_with(p))
    {
        return url.to_string();
    }
    let host = lower.split(['/', ':', '?', '#']).next().unwrap_or("");
    let local = host == "localhost"
        || host.parse::<std::net::Ipv4Addr>().is_ok()
        || host.ends_with(".localhost");
    format!("{}://{url}", if local { "http" } else { "https" })
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct TargetArgs {
    r#ref: Option<String>,
    selector: Option<String>,
    x: Option<f64>,
    y: Option<f64>,
}

impl TargetArgs {
    fn target(&self) -> Result<Target, String> {
        Target::from_args(
            self.r#ref.as_deref(),
            self.selector.as_deref(),
            self.x,
            self.y,
        )
        .ok_or_else(|| {
            "give a `ref` (from browser_snapshot), a CSS `selector`, or `x` and `y`".to_string()
        })
    }
}

/// Element details captured before an action while recording.
#[derive(Default)]
struct Probe {
    info: Option<crate::record::ElementInfo>,
    password_focus: bool,
    point: Option<(f64, f64)>,
    viewport: Option<(f64, f64)>,
}

pub(crate) struct Runner<'a> {
    pub handle: &'a BrowserHandle,
    pub ctx: &'a ToolContext,
}

async fn pick_tab(browser: &Browser, spec: Option<&str>) -> Result<Tab, String> {
    match spec.filter(|s| !s.trim().is_empty()) {
        Some(spec) => browser.find_tab(spec).map_err(|e| e.to_string()),
        None => browser.active_tab().await.map_err(|e| e.to_string()),
    }
}

impl Runner<'_> {
    /// Runs one tool; `report_state` appends the post-action page state.
    pub async fn run(&self, kind: Kind, input: Value, report_state: bool) -> ToolResult {
        if kind == Kind::Batch {
            return self.batch(input).await;
        }
        if kind == Kind::Record {
            return self.record(input).await;
        }
        let browser = self
            .handle
            .browser()
            .await
            .map_err(|e| format!("Could not start or reach the browser: {e}"))?;
        let tab_spec = input.get("tab").and_then(Value::as_str).map(str::to_string);
        let wants_new_tab = kind == Kind::Navigate && input["new_tab"].as_bool().unwrap_or(false);
        let pre = if matches!(kind, Kind::Tabs | Kind::Network | Kind::Batch) || wants_new_tab {
            None
        } else {
            Some(pick_tab(&browser, tab_spec.as_deref()).await?)
        };
        let before: Option<TabInfo> = pre.as_ref().map(Tab::info);
        let active_before = browser.active_tab_id();

        let recording = kind.is_action() && self.handle.recorder().is_active();
        let probe = if recording {
            self.probe(kind, &input, pre.as_ref()).await
        } else {
            Probe::default()
        };
        let recorded_input = recording.then(|| input.clone());

        let (mut blocks, used) = self.dispatch(&browser, kind, input, pre.clone()).await?;

        if let Some(recorded_input) = recorded_input {
            if let Some(tab) = used.as_ref().or(pre.as_ref()) {
                self.record_step(kind, recorded_input, probe, tab).await;
            }
        }

        if kind.is_action() {
            if let Some(tab) = used.or(pre) {
                let mut report_tab = tab.clone();
                let mut notes = Vec::new();
                let active_now = browser.active_tab_id();
                if active_now != active_before && active_now.as_deref() != Some(tab.id()) {
                    if let Some(new_tab) = active_now.as_deref().and_then(|id| browser.tab(id)) {
                        new_tab.settle(Duration::from_secs(5)).await;
                        notes.push(format!(
                            "A new tab opened and is now active (id {}).",
                            new_tab.id()
                        ));
                        report_tab = new_tab;
                    }
                }
                let tail = self
                    .page_report(
                        &report_tab,
                        before.as_ref(),
                        kind != Kind::Navigate,
                        report_state,
                    )
                    .await;
                notes.extend(tail);
                if !notes.is_empty() {
                    blocks.push(Block::text(notes.join("\n")));
                }
            }
        }
        Ok(blocks)
    }

    async fn dispatch(
        &self,
        browser: &Arc<Browser>,
        kind: Kind,
        input: Value,
        tab: Option<Tab>,
    ) -> Out {
        match kind {
            Kind::Navigate => self.navigate(browser, input, tab).await,
            Kind::Snapshot => self.snapshot(tab, input).await,
            Kind::Click => self.click(tab, input).await,
            Kind::Type => self.type_text(tab, input).await,
            Kind::Press => self.press(tab, input).await,
            Kind::Hover => self.hover(tab, input).await,
            Kind::Scroll => self.scroll(tab, input).await,
            Kind::Select => self.select(tab, input).await,
            Kind::Upload => self.upload(tab, input).await,
            Kind::Wait => self.wait(tab, input).await,
            Kind::Screenshot => self.screenshot(tab, input).await,
            Kind::Evaluate => self.evaluate(tab, input).await,
            Kind::GetText => self.get_text(tab, input).await,
            Kind::Tabs => self.tabs(browser, input).await,
            Kind::Console => self.console(tab, input),
            Kind::Network => self.network(browser, input),
            Kind::Pdf => self.pdf(tab, input).await,
            Kind::Emulate => self.emulate(tab, input).await,
            Kind::SavePage => self.save_page(tab, input).await,
            Kind::Batch | Kind::Record => Err("this tool cannot be run from here".into()),
        }
    }

    /// Page-change note plus a bounded fresh interactive snapshot.
    async fn page_report(
        &self,
        tab: &Tab,
        before: Option<&TabInfo>,
        note_change: bool,
        snapshot: bool,
    ) -> Vec<String> {
        let mut lines = Vec::new();
        for dialog in tab.take_dialogs() {
            lines.push(format!(
                "A JavaScript {} dialog (\"{}\") appeared and was {} automatically.",
                dialog.kind,
                dialog.message.chars().take(120).collect::<String>(),
                if dialog.accepted {
                    "accepted"
                } else {
                    "dismissed"
                }
            ));
        }
        let (url, title) = tab.page_state().await.unwrap_or_else(|_| {
            let info = tab.info();
            (info.url, info.title)
        });
        if note_change {
            match before {
                Some(b) if b.url != url || b.title != title => {
                    lines.push(format!("Page changed: \"{title}\" ({url})"));
                }
                _ => lines.push(format!("Page unchanged: \"{title}\" ({url})")),
            }
        }
        let chars = self.handle.config().post_action_snapshot_chars;
        if snapshot && chars > 0 {
            let options = SnapshotOptions {
                interactive_only: true,
                max_chars: chars,
                ..Default::default()
            };
            if let Ok(snap) = tab.snapshot(&options).await {
                lines.push(format!("Interactive elements:\n{}", snap.text));
            }
        }
        lines
    }

    // ------------------------------------------------------------ recording

    /// Gathers element details before an action (it may navigate away afterwards).
    async fn probe(&self, kind: Kind, input: &Value, tab: Option<&Tab>) -> Probe {
        let mut probe = Probe::default();
        let Some(tab) = tab else { return probe };
        let target = serde_json::from_value::<TargetArgs>(input.clone())
            .ok()
            .and_then(|a| a.target().ok());
        match (kind, target) {
            (Kind::Press, _) => {
                probe.password_focus = tab
                    .evaluate("(() => { const a = document.activeElement; return !!(a && a.tagName === 'INPUT' && a.type === 'password'); })()")
                    .await
                    .ok()
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
            }
            (
                Kind::Click | Kind::Type | Kind::Hover | Kind::Select | Kind::Upload | Kind::Scroll,
                Some(target @ (Target::Ref(_) | Target::Selector(_))),
            ) => {
                probe.info = tab
                    .call_on_target(&target, crate::record::codegen::PROBE_FN)
                    .await
                    .ok()
                    .and_then(|v| serde_json::from_value(v).ok());
            }
            (Kind::Click | Kind::Hover, Some(Target::Point(x, y))) => {
                probe.point = Some((x, y));
                probe.viewport = tab
                    .evaluate("[window.innerWidth, window.innerHeight]")
                    .await
                    .ok()
                    .and_then(|v| Some((v.get(0)?.as_f64()?, v.get(1)?.as_f64()?)));
            }
            _ => {}
        }
        probe
    }

    /// Appends the step, redacting password input, and captures an after-action frame.
    async fn record_step(&self, kind: Kind, mut input: Value, probe: Probe, tab: &Tab) {
        use crate::record::codegen::{locator_code, redact_press, selector_locator};
        let recorder = self.handle.recorder();
        let (url, _) = tab.page_state().await.unwrap_or_else(|_| {
            let info = tab.info();
            (info.url, info.title)
        });
        let mut secret = None;
        let password = probe.info.as_ref().is_some_and(|i| i.password);
        if kind == Kind::Type && password {
            secret = Some(recorder.next_secret());
            input["text"] = Value::String("[redacted]".into());
        } else if kind == Kind::Press && probe.password_focus {
            let (keys, redacted) = redact_press(input["keys"].as_str().unwrap_or(""));
            if redacted {
                secret = Some(recorder.next_secret());
                input["keys"] = Value::String(keys);
            }
        }
        let has_ref = input
            .get("ref")
            .and_then(Value::as_str)
            .is_some_and(|r| !r.trim().is_empty());
        let locator = match (&probe.info, input.get("selector").and_then(Value::as_str)) {
            (Some(info), _) => Some(locator_code(info)),
            (None, Some(selector)) if !has_ref => Some(selector_locator(selector)),
            _ => None,
        };
        let marker = if kind == Kind::Click {
            match (&probe.info, probe.point, probe.viewport) {
                (Some(i), _, _) if i.vw > 0.0 && i.vh > 0.0 => Some((i.cx / i.vw, i.cy / i.vh)),
                (None, Some((x, y)), Some((vw, vh))) if vw > 0.0 && vh > 0.0 => {
                    Some((x / vw, y / vh))
                }
                _ => None,
            }
        } else {
            None
        };
        recorder.push_step(kind.name(), input, url, locator, probe.info, secret);
        recorder.capture_frame(tab, marker, false).await;
    }

    async fn record(&self, input: Value) -> ToolResult {
        #[derive(Deserialize)]
        struct Args {
            action: String,
            name: Option<String>,
            fps: Option<f64>,
        }
        let args: Args = parse(input)?;
        let recorder = self.handle.recorder();
        match args.action.as_str() {
            "status" => Ok(text(recorder.status())),
            "start" => {
                let browser = self
                    .handle
                    .browser()
                    .await
                    .map_err(|e| format!("Could not start or reach the browser: {e}"))?;
                let dir = recorder.start(
                    &self.handle.recordings_dir(),
                    args.name.as_deref(),
                    args.fps,
                )?;
                recorder.start_idle(browser.clone());
                if let Ok(tab) = browser.active_tab().await {
                    recorder.capture_frame(&tab, None, false).await;
                }
                Ok(text(format!(
                    "Recording started. Every browser action is now captured; call browser_record with action \"stop\" to finish.\nOutput folder: {}",
                    dir.display()
                )))
            }
            "stop" => {
                let finished = recorder.stop().ok_or("not recording")?;
                let files = tokio::task::spawn_blocking(move || finished.write())
                    .await
                    .map_err(|e| e.to_string())??;
                let mut out = format!(
                    "Recording saved ({} steps, {} frames, {:.1} s).\nFolder: {}\nSteps: {}\nPlaywright test: {}\n",
                    files.steps,
                    files.frames,
                    files.duration_ms as f64 / 1000.0,
                    files.dir.display(),
                    files.steps_json.display(),
                    files.spec.display()
                );
                match (&files.gif, &files.gif_error) {
                    (Some(gif), _) => out.push_str(&format!("GIF: {}\n", gif.display())),
                    (None, error) => out.push_str(&format!(
                        "GIF not produced: {}\n",
                        error.as_deref().unwrap_or("unknown error")
                    )),
                }
                if files.dropped_frames > 0 {
                    out.push_str(&format!(
                        "{} frames were dropped at the {}-frame cap.\n",
                        files.dropped_frames,
                        crate::record::MAX_FRAMES
                    ));
                }
                if !files.secrets.is_empty() {
                    out.push_str(&format!(
                        "Password input was not recorded; set {} before running the spec.\n",
                        files.secrets.join(", ")
                    ));
                }
                Ok(text(out.trim_end()))
            }
            other => Err(format!("unknown action `{other}` (start, stop, status)")),
        }
    }

    async fn batch(&self, input: Value) -> ToolResult {
        #[derive(Deserialize)]
        struct Action {
            tool: String,
            #[serde(default)]
            input: Value,
        }
        #[derive(Deserialize)]
        struct Args {
            actions: Vec<Action>,
        }
        let args: Args = parse(input)?;
        if args.actions.is_empty() {
            return Err("`actions` is empty".into());
        }
        let total = args.actions.len();
        let mut blocks = Vec::new();
        for (index, action) in args.actions.into_iter().enumerate() {
            let kind = Kind::from_name(&action.tool)
                .filter(|k| *k != Kind::Batch)
                .ok_or_else(|| {
                    format!("action {} has unknown tool `{}`", index + 1, action.tool)
                })?;
            blocks.push(Block::text(format!(
                "[{}/{}] {}",
                index + 1,
                total,
                kind.name()
            )));
            let input = if action.input.is_null() {
                Value::Object(Default::default())
            } else {
                action.input
            };
            match Box::pin(self.run(kind, input, index + 1 == total)).await {
                Ok(out) => blocks.extend(out),
                Err(message) => {
                    blocks.push(Block::text(format!("Error: {message}")));
                    blocks.push(Block::text(format!(
                        "Stopped: action {} of {total} failed; the remaining actions were not run.",
                        index + 1
                    )));
                    return Err(join_blocks(&blocks));
                }
            }
        }
        Ok(blocks)
    }

    // ------------------------------------------------------------- actions

    async fn navigate(&self, browser: &Arc<Browser>, input: Value, tab: Option<Tab>) -> Out {
        #[derive(Deserialize)]
        struct Args {
            url: String,
            #[serde(default)]
            new_tab: bool,
        }
        let args: Args = parse(input)?;
        let url = normalize_url(&args.url);
        let tab = match tab {
            Some(tab) if !args.new_tab => tab,
            _ => {
                let tab = browser.new_tab(None).await.map_err(|e| e.to_string())?;
                browser
                    .select_tab(tab.id())
                    .await
                    .map_err(|e| e.to_string())?;
                tab
            }
        };
        let result = tab
            .navigate(&url, &NavigateOptions::default())
            .await
            .map_err(|e| e.to_string())?;
        let mut head = format!("Navigated to {}\nTitle: {}", result.url, result.title);
        if !result.loaded {
            head.push_str("\nWarning: the page was still loading when the wait timed out; wait or snapshot again.");
        }
        Ok((text(head), Some(tab)))
    }

    async fn snapshot(&self, tab: Option<Tab>, input: Value) -> Out {
        #[derive(Deserialize, Default)]
        #[serde(default)]
        struct Args {
            interactive_only: bool,
            visible_only: bool,
            selector: Option<String>,
            max_nodes: Option<usize>,
            max_chars: Option<usize>,
            capture_screenshot: bool,
        }
        let args: Args = parse(input.clone())?;
        let tab = tab.ok_or("no tab")?;
        let options = SnapshotOptions {
            interactive_only: args.interactive_only,
            visible_only: args.visible_only,
            selector: args.selector.clone(),
            max_nodes: args.max_nodes,
            max_chars: args
                .max_chars
                .unwrap_or(crate::snapshot::DEFAULT_MAX_CHARS)
                .max(500),
        };
        let snap = tab.snapshot(&options).await.map_err(|e| e.to_string())?;
        let mut out = format!("Page: {} ({})\n", snap.title, snap.url);
        if let Some(ref sel) = args.selector {
            out.push_str(&format!(
                "Scoped Region: {sel}
"
            ));
        }
        if snap.viewport.scroll_height > snap.viewport.height {
            out.push_str(&format!(
                "Scroll: y={} of {} (viewport {})\n",
                snap.viewport.scroll_y, snap.viewport.scroll_height, snap.viewport.height
            ));
        }
        out.push('\n');
        out.push_str(&snap.text);

        let mut blocks = vec![Block::text(out)];

        if args.capture_screenshot {
            let target = args
                .selector
                .as_deref()
                .map(|s| Target::Selector(s.to_string()));
            if let Ok(shot) = tab
                .screenshot(&ScreenshotOptions {
                    format: ImageFormat::Jpeg,
                    quality: SCREENSHOT_QUALITY,
                    full_page: false,
                    target,
                    max_dimension: Some(SCREENSHOT_MAX_SIDE),
                })
                .await
            {
                blocks.push(Block::Image {
                    media_type: shot.mime.into(),
                    data: STANDARD.encode(&shot.data),
                });
            }
        }

        Ok((blocks, Some(tab)))
    }

    async fn click(&self, tab: Option<Tab>, input: Value) -> Out {
        #[derive(Deserialize, Default)]
        #[serde(default)]
        struct Extra {
            button: Option<String>,
            double: bool,
            modifiers: Option<Value>,
        }
        let target = parse::<TargetArgs>(input.clone())?.target()?;
        let extra: Extra = parse(input)?;
        let tab = tab.ok_or("no tab")?;
        let button = match extra.button.as_deref() {
            None | Some("left") => MouseButton::Left,
            Some("right") => MouseButton::Right,
            Some("middle") => MouseButton::Middle,
            Some(other) => return Err(format!("unknown mouse button `{other}`")),
        };
        let modifiers = parse_modifiers(extra.modifiers)?;
        let note = tab
            .click(
                &target,
                ClickOptions {
                    button,
                    double: extra.double,
                    modifiers,
                },
            )
            .await
            .map_err(|e| e.to_string())?;
        tab.settle(Duration::from_secs(5)).await;
        let mut message = format!("Clicked {}.", describe_target(&target));
        if let Some(note) = note {
            message.push('\n');
            message.push_str(&note);
        }
        Ok((text(message), Some(tab)))
    }

    async fn type_text(&self, tab: Option<Tab>, input: Value) -> Out {
        #[derive(Deserialize)]
        struct Extra {
            text: String,
            #[serde(default)]
            submit: bool,
            clear: Option<bool>,
        }
        let target = parse::<TargetArgs>(input.clone())?.target()?;
        let extra: Extra = parse(input)?;
        let tab = tab.ok_or("no tab")?;
        let warning = tab
            .type_text(
                &target,
                &extra.text,
                extra.clear.unwrap_or(true),
                extra.submit,
            )
            .await
            .map_err(|e| e.to_string())?;
        tab.settle(Duration::from_secs(if extra.submit { 5 } else { 2 }))
            .await;
        let mut message = format!(
            "Typed {} characters into {}{}.",
            extra.text.chars().count(),
            describe_target(&target),
            if extra.submit {
                " and pressed Enter"
            } else {
                ""
            }
        );
        if let Some(w) = warning {
            message.push('\n');
            message.push_str(&w);
        }
        Ok((text(message), Some(tab)))
    }

    async fn press(&self, tab: Option<Tab>, input: Value) -> Out {
        #[derive(Deserialize)]
        struct Args {
            keys: String,
        }
        let args: Args = parse(input)?;
        let tab = tab.ok_or("no tab")?;
        tab.press_keys(&args.keys)
            .await
            .map_err(|e| e.to_string())?;
        tab.settle(Duration::from_secs(3)).await;
        Ok((text(format!("Pressed {}.", args.keys)), Some(tab)))
    }

    async fn hover(&self, tab: Option<Tab>, input: Value) -> Out {
        let target = parse::<TargetArgs>(input)?.target()?;
        let tab = tab.ok_or("no tab")?;
        tab.hover(&target).await.map_err(|e| e.to_string())?;
        tab.settle(Duration::from_secs(1)).await;
        Ok((
            text(format!("Hovered {}.", describe_target(&target))),
            Some(tab),
        ))
    }

    async fn scroll(&self, tab: Option<Tab>, input: Value) -> Out {
        #[derive(Deserialize, Default)]
        #[serde(default)]
        struct Extra {
            direction: Option<String>,
            amount: Option<f64>,
        }
        let targets: TargetArgs = parse(input.clone())?;
        let extra: Extra = parse(input)?;
        let tab = tab.ok_or("no tab")?;
        let position = if let Ok(target) = targets.target() {
            tab.scroll_into_view(&target)
                .await
                .map_err(|e| e.to_string())?
        } else {
            let direction = extra
                .direction
                .as_deref()
                .ok_or("give a `direction` or an element `ref`")?;
            let current = tab.scroll_position().await.map_err(|e| e.to_string())?;
            let amount = extra
                .amount
                .unwrap_or((current.viewport_height * 0.8).max(200.0));
            let (dx, dy) = match direction {
                "down" => (0.0, amount),
                "up" => (0.0, -amount),
                "right" => (amount, 0.0),
                "left" => (-amount, 0.0),
                other => return Err(format!("unknown direction `{other}`")),
            };
            tab.scroll_by(dx, dy).await.map_err(|e| e.to_string())?
        };
        tab.settle(Duration::from_millis(1500)).await;
        Ok((
            text(format!(
                "Scrolled. Position: y={} of {} (viewport {}).",
                position.y, position.page_height, position.viewport_height
            )),
            Some(tab),
        ))
    }

    async fn select(&self, tab: Option<Tab>, input: Value) -> Out {
        #[derive(Deserialize)]
        struct Extra {
            values: Vec<String>,
        }
        let target = parse::<TargetArgs>(input.clone())?.target()?;
        let extra: Extra = parse(input)?;
        let tab = tab.ok_or("no tab")?;
        let chosen = tab
            .select_options(&target, &extra.values)
            .await
            .map_err(|e| e.to_string())?;
        tab.settle(Duration::from_secs(2)).await;
        Ok((text(format!("Selected: {}.", chosen.join(", "))), Some(tab)))
    }

    async fn upload(&self, tab: Option<Tab>, input: Value) -> Out {
        #[derive(Deserialize)]
        struct Extra {
            paths: Vec<String>,
        }
        let target = parse::<TargetArgs>(input.clone())?.target()?;
        let extra: Extra = parse(input)?;
        let tab = tab.ok_or("no tab")?;
        let mut resolved = Vec::new();
        for path in &extra.paths {
            let full = self.ctx.resolve(path);
            if !full.is_file() {
                return Err(format!("file not found: {}", full.display()));
            }
            resolved.push(full);
        }
        tab.upload_files(&target, &resolved)
            .await
            .map_err(|e| e.to_string())?;
        tab.settle(Duration::from_secs(2)).await;
        Ok((
            text(format!("Attached {} file(s).", resolved.len())),
            Some(tab),
        ))
    }

    async fn wait(&self, tab: Option<Tab>, input: Value) -> Out {
        #[derive(Deserialize, Default)]
        #[serde(default)]
        struct Args {
            text: Option<String>,
            text_gone: Option<String>,
            selector: Option<String>,
            ms: Option<u64>,
            timeout_ms: Option<u64>,
        }
        let args: Args = parse(input)?;
        let tab = tab.ok_or("no tab")?;
        let condition = if let Some(t) = args.text {
            WaitCondition::Text(t)
        } else if let Some(t) = args.text_gone {
            WaitCondition::TextGone(t)
        } else if let Some(s) = args.selector {
            WaitCondition::Selector(s)
        } else if let Some(ms) = args.ms {
            WaitCondition::Delay(Duration::from_millis(ms.min(60_000)))
        } else {
            return Err("give `text`, `text_gone`, `selector` or `ms`".into());
        };
        let timeout = Duration::from_millis(args.timeout_ms.unwrap_or(10_000).min(120_000));
        tab.wait_for(&condition, timeout).await.map_err(|e| match e {
            crate::error::BrowserError::Timeout(_) => format!(
                "Timed out after {} ms waiting for {condition:?}. Take a browser_snapshot to see the current page.",
                timeout.as_millis()
            ),
            other => other.to_string(),
        })?;
        Ok((text("Condition met."), Some(tab)))
    }

    async fn screenshot(&self, tab: Option<Tab>, input: Value) -> Out {
        #[derive(Deserialize, Default)]
        #[serde(default)]
        struct Extra {
            full_page: bool,
        }
        let targets: TargetArgs = parse(input.clone())?;
        let extra: Extra = parse(input)?;
        let tab = tab.ok_or("no tab")?;
        let element = targets
            .target()
            .ok()
            .filter(|t| !matches!(t, Target::Point(..)));
        let shot = tab
            .screenshot(&ScreenshotOptions {
                format: ImageFormat::Jpeg,
                quality: SCREENSHOT_QUALITY,
                full_page: extra.full_page,
                target: element.clone(),
                max_dimension: Some(SCREENSHOT_MAX_SIDE),
            })
            .await
            .map_err(|e| e.to_string())?;
        let what = if element.is_some() {
            "element"
        } else if extra.full_page {
            "full page"
        } else {
            "viewport"
        };
        Ok((
            vec![
                Block::Image {
                    media_type: shot.mime.into(),
                    data: STANDARD.encode(&shot.data),
                },
                Block::text(format!(
                    "Screenshot of {what}: {}x{} px.",
                    shot.width, shot.height
                )),
            ],
            Some(tab),
        ))
    }

    async fn evaluate(&self, tab: Option<Tab>, input: Value) -> Out {
        #[derive(Deserialize)]
        struct Args {
            expression: String,
        }
        let args: Args = parse(input)?;
        let tab = tab.ok_or("no tab")?;
        let value = tab
            .evaluate(&args.expression)
            .await
            .map_err(|e| e.to_string())?;
        let mut rendered = match &value {
            Value::Null => "undefined or null".to_string(),
            Value::String(s) => s.clone(),
            other => serde_json::to_string_pretty(other).unwrap_or_default(),
        };
        if rendered.chars().count() > MAX_EVAL_CHARS {
            rendered =
                rendered.chars().take(MAX_EVAL_CHARS).collect::<String>() + "\n... [truncated]";
        }
        Ok((text(rendered), Some(tab)))
    }

    async fn get_text(&self, tab: Option<Tab>, input: Value) -> Out {
        #[derive(Deserialize, Default)]
        #[serde(default)]
        struct Args {
            max_chars: Option<usize>,
        }
        let args: Args = parse(input)?;
        let tab = tab.ok_or("no tab")?;
        let page = tab
            .get_text(args.max_chars.unwrap_or(20_000))
            .await
            .map_err(|e| e.to_string())?;
        Ok((text(page), Some(tab)))
    }

    async fn tabs(&self, browser: &Arc<Browser>, input: Value) -> Out {
        #[derive(Deserialize)]
        struct Args {
            action: String,
            url: Option<String>,
            tab: Option<String>,
        }
        let args: Args = parse(input)?;
        let mut message = String::new();
        match args.action.as_str() {
            "list" => {}
            "new" => {
                let url = args.url.as_deref().map(normalize_url);
                let tab = browser
                    .new_tab(url.as_deref())
                    .await
                    .map_err(|e| e.to_string())?;
                message.push_str(&format!("Opened tab {}.\n", tab.id()));
            }
            "select" => {
                let spec = args.tab.as_deref().ok_or("`tab` is required for select")?;
                let tab = browser.select_tab(spec).await.map_err(|e| e.to_string())?;
                message.push_str(&format!("Selected tab {}.\n", tab.id()));
            }
            "close" => {
                let spec = args.tab.as_deref().ok_or("`tab` is required for close")?;
                browser.close_tab(spec).await.map_err(|e| e.to_string())?;
                message.push_str("Closed tab.\n");
            }
            other => {
                return Err(format!(
                    "unknown action `{other}` (list, new, select, close)"
                ))
            }
        }
        let active = browser.active_tab_id();
        let tabs = browser.tabs();
        if tabs.is_empty() {
            message.push_str("No open tabs.");
        }
        for (index, info) in tabs.iter().enumerate() {
            message.push_str(&format!(
                "{}. [{}]{} \"{}\" {}\n",
                index + 1,
                info.id,
                if active.as_deref() == Some(info.id.as_str()) {
                    " (active)"
                } else {
                    ""
                },
                info.title,
                info.url
            ));
        }
        Ok((text(message.trim_end()), None))
    }

    fn console(&self, tab: Option<Tab>, input: Value) -> Out {
        #[derive(Deserialize, Default)]
        #[serde(default)]
        struct Args {
            level: Option<String>,
            limit: Option<usize>,
            clear: bool,
        }
        let args: Args = parse(input)?;
        let tab = tab.ok_or("no tab")?;
        let messages = tab.console(args.level.as_deref(), args.limit.unwrap_or(50));
        let mut out = String::new();
        for m in &messages {
            out.push_str(&format!("[{}] {}", m.level, m.text));
            if let Some(loc) = &m.location {
                out.push_str(&format!(" ({loc})"));
            }
            out.push('\n');
        }
        if messages.is_empty() {
            out.push_str("No console messages.");
        }
        if args.clear {
            tab.clear_console();
        }
        Ok((text(out.trim_end()), Some(tab)))
    }

    fn network(&self, browser: &Arc<Browser>, input: Value) -> Out {
        #[derive(Deserialize, Default)]
        #[serde(default)]
        struct Args {
            filter: Option<String>,
            resource_type: Option<String>,
            mime: Option<String>,
            limit: Option<usize>,
            tab: Option<String>,
        }
        let args: Args = parse(input)?;
        let tab_id = match args.tab.as_deref() {
            Some(spec) => Some(
                browser
                    .find_tab(spec)
                    .map_err(|e| e.to_string())?
                    .id()
                    .to_string(),
            ),
            None => None,
        };
        let requests = browser.captured_requests(&NetworkFilter {
            url_contains: args.filter,
            resource_type: args.resource_type,
            mime_contains: args.mime,
            tab_id,
            limit: Some(args.limit.unwrap_or(30)),
        });
        if requests.is_empty() {
            return Ok((text("No captured requests match."), None));
        }
        let mut out = String::from("id | method | status | type | mime | size | url\n");
        for r in &requests {
            let url: String = r.url.chars().take(200).collect();
            out.push_str(&format!(
                "{} | {} | {} | {} | {} | {} | {}{}\n",
                r.request_id,
                r.method,
                r.status.map_or("-".into(), |s| s.to_string()),
                r.resource_type,
                r.mime_type.as_deref().unwrap_or("-"),
                r.content_length.map_or("-".into(), |n| n.to_string()),
                url,
                r.error
                    .as_ref()
                    .map(|e| format!(" [{e}]"))
                    .unwrap_or_default()
            ));
        }
        Ok((text(out.trim_end()), None))
    }

    async fn emulate(&self, tab: Option<Tab>, input: Value) -> Out {
        #[derive(Deserialize, Default)]
        #[serde(default)]
        struct Args {
            device: Option<Value>,
            color_scheme: Option<String>,
            reduced_motion: Option<bool>,
            reset: bool,
        }
        let args: Args = parse(input)?;
        let tab = tab.ok_or("no tab")?;
        let device = match args.device.as_ref().filter(|v| !v.is_null()) {
            Some(value) => Some(crate::emulate::parse_device(value)?),
            None => None,
        };
        let color_scheme = match args.color_scheme.as_deref() {
            None => None,
            Some("light") => Some(crate::emulate::ColorScheme::Light),
            Some("dark") => Some(crate::emulate::ColorScheme::Dark),
            Some(other) => {
                return Err(format!(
                    "unknown color_scheme `{other}` (use light or dark)"
                ))
            }
        };
        let request = crate::emulate::EmulationRequest {
            device,
            color_scheme,
            reduced_motion: args.reduced_motion,
            reset: args.reset,
        };
        let done = tab.emulate(&request).await.map_err(|e| e.to_string())?;
        Ok((
            text(format!("Emulation applied: {}.", done.join("; "))),
            Some(tab),
        ))
    }

    async fn save_page(&self, tab: Option<Tab>, input: Value) -> Out {
        #[derive(Deserialize, Default)]
        #[serde(default)]
        struct Args {
            path: Option<String>,
            format: Option<String>,
        }
        let args: Args = parse(input)?;
        let tab = tab.ok_or("no tab")?;
        let (mhtml, extension) = match args.format.as_deref().unwrap_or("mhtml") {
            "mhtml" => (true, "mhtml"),
            "html" => (false, "html"),
            other => return Err(format!("unknown format `{other}` (use mhtml or html)")),
        };
        let bytes = if mhtml {
            tab.capture_mhtml()
                .await
                .map_err(|e| format!("cannot capture MHTML snapshot: {e}"))?
        } else {
            tab.page_html()
                .await
                .map_err(|e| format!("cannot read page HTML: {e}"))?
        };
        let relative = match args
            .path
            .as_deref()
            .map(str::trim)
            .filter(|p| !p.is_empty())
        {
            Some(path) => path.to_string(),
            None => format!(
                "downloads/page-{}.{extension}",
                crate::record::utc_stamp(unix_now())
            ),
        };
        let path = self.ctx.resolve(&relative);
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| e.to_string())?;
        }
        tokio::fs::write(&path, &bytes)
            .await
            .map_err(|e| format!("cannot write {}: {e}", path.display()))?;
        Ok((
            text(format!(
                "Saved page as {extension} ({} bytes) to {}.",
                bytes.len(),
                path.display()
            )),
            Some(tab),
        ))
    }

    async fn pdf(&self, tab: Option<Tab>, input: Value) -> Out {
        #[derive(Deserialize)]
        struct Args {
            path: String,
        }
        let args: Args = parse(input)?;
        let tab = tab.ok_or("no tab")?;
        let bytes = tab.print_to_pdf().await.map_err(|e| {
            format!("{e}. PDF export usually requires a headless browser (set headless in the browser settings).")
        })?;
        let path = self.ctx.resolve(&args.path);
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| e.to_string())?;
        }
        tokio::fs::write(&path, &bytes)
            .await
            .map_err(|e| format!("cannot write {}: {e}", path.display()))?;
        Ok((
            text(format!(
                "Saved PDF ({} bytes) to {}.",
                bytes.len(),
                path.display()
            )),
            Some(tab),
        ))
    }
}

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

fn parse_modifiers(value: Option<Value>) -> Result<u8, String> {
    match value {
        None | Some(Value::Null) => Ok(0),
        Some(Value::String(s)) => keys::parse_modifiers(
            &s.split('+')
                .map(str::to_string)
                .filter(|t| !t.is_empty())
                .collect::<Vec<_>>(),
        ),
        Some(Value::Array(items)) => {
            let names: Vec<String> = items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect();
            keys::parse_modifiers(&names)
        }
        Some(_) => Err("`modifiers` must be a list like [\"ctrl\"]".into()),
    }
}

fn describe_target(target: &Target) -> String {
    match target {
        Target::Ref(r) => format!("ref {r}"),
        Target::Selector(s) => format!("`{s}`"),
        Target::Point(x, y) => format!("({x}, {y})"),
    }
}

/// Flattens blocks to text (used for failed batches, where images are dropped).
fn join_blocks(blocks: &[Block]) -> String {
    blocks
        .iter()
        .filter_map(|b| match b {
            Block::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_urls() {
        assert_eq!(normalize_url("example.com/x"), "https://example.com/x");
        assert_eq!(normalize_url("localhost:3000"), "http://localhost:3000");
        assert_eq!(normalize_url("127.0.0.1:8080/a"), "http://127.0.0.1:8080/a");
        assert_eq!(normalize_url("https://a.b"), "https://a.b");
        assert_eq!(normalize_url("data:text/html,hi"), "data:text/html,hi");
        assert_eq!(normalize_url("about:blank"), "about:blank");
    }

    #[test]
    fn modifier_parsing() {
        assert_eq!(
            parse_modifiers(Some(serde_json::json!(["ctrl", "shift"]))).unwrap(),
            keys::CTRL | keys::SHIFT
        );
        assert_eq!(
            parse_modifiers(Some(serde_json::json!("alt+meta"))).unwrap(),
            keys::ALT | keys::META
        );
        assert!(parse_modifiers(Some(serde_json::json!(["nope"]))).is_err());
        assert_eq!(parse_modifiers(None).unwrap(), 0);
    }

    // ---------------------------------------------------- CDP mock tests

    use crate::cdp::CdpClient;
    use crate::tab::DialogPolicy;
    use futures_util::{SinkExt, StreamExt};
    use std::sync::Mutex;
    use tokio_tungstenite::tungstenite::Message;

    type Log = Arc<Mutex<Vec<(String, Value)>>>;

    /// A tab wired to a fake CDP endpoint that logs every command and answers
    /// with `reply(method)`.
    async fn mock_tab(reply: fn(&str) -> Value) -> (Tab, Log) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}", listener.local_addr().unwrap());
        let log: Log = Arc::default();
        let seen = log.clone();
        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
            while let Some(Ok(message)) = ws.next().await {
                let Message::Text(raw) = message else {
                    continue;
                };
                let Ok(request) = serde_json::from_str::<Value>(raw.as_str()) else {
                    continue;
                };
                let method = request["method"].as_str().unwrap_or("").to_string();
                seen.lock()
                    .unwrap()
                    .push((method.clone(), request["params"].clone()));
                let response = serde_json::json!({"id": request["id"], "result": reply(&method)});
                if ws
                    .send(Message::Text(response.to_string().into()))
                    .await
                    .is_err()
                {
                    break;
                }
            }
        });
        let client = CdpClient::connect(&url).await.unwrap();
        let tab = Tab::new(
            client,
            "T1".into(),
            "S1".into(),
            Arc::new(Mutex::new(DialogPolicy::default())),
            "https://example.test/".into(),
            "Example".into(),
        );
        (tab, log)
    }

    fn runner_parts() -> (BrowserHandle, ToolContext, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let handle = BrowserHandle::new(super::super::BrowserConfig::new("unused-profile"));
        let ctx = ToolContext::new(dir.path());
        (handle, ctx, dir)
    }

    fn methods(log: &Log) -> Vec<String> {
        log.lock().unwrap().iter().map(|(m, _)| m.clone()).collect()
    }

    fn params(log: &Log, method: &str) -> Value {
        log.lock()
            .unwrap()
            .iter()
            .find(|(m, _)| m == method)
            .map(|(_, p)| p.clone())
            .unwrap_or(Value::Null)
    }

    fn block_text(blocks: &[Block]) -> String {
        join_blocks(blocks)
    }

    #[tokio::test]
    async fn emulate_preset_color_scheme_and_motion() {
        let (tab, log) = mock_tab(|_| serde_json::json!({})).await;
        let (handle, ctx, _dir) = runner_parts();
        let runner = Runner {
            handle: &handle,
            ctx: &ctx,
        };
        let (blocks, _) = runner
            .emulate(
                Some(tab),
                serde_json::json!({"device": "iPhone 15", "color_scheme": "dark", "reduced_motion": true}),
            )
            .await
            .unwrap();
        let said = block_text(&blocks);
        assert!(
            said.contains("393x852") && said.contains("dark") && said.contains("reduce"),
            "{said}"
        );
        assert_eq!(
            methods(&log),
            [
                "Emulation.setDeviceMetricsOverride",
                "Emulation.setTouchEmulationEnabled",
                "Emulation.setUserAgentOverride",
                "Emulation.setEmulatedMedia"
            ]
        );
        let metrics = params(&log, "Emulation.setDeviceMetricsOverride");
        assert_eq!(metrics["width"], 393);
        assert_eq!(metrics["height"], 852);
        assert_eq!(metrics["deviceScaleFactor"], 3.0);
        assert_eq!(metrics["mobile"], true);
        assert_eq!(metrics["screenOrientation"]["type"], "portraitPrimary");
        assert_eq!(
            params(&log, "Emulation.setTouchEmulationEnabled")["enabled"],
            true
        );
        assert!(params(&log, "Emulation.setUserAgentOverride")["userAgent"]
            .as_str()
            .unwrap()
            .contains("iPhone"));
        let features = params(&log, "Emulation.setEmulatedMedia")["features"].clone();
        assert_eq!(
            features[0],
            serde_json::json!({"name": "prefers-color-scheme", "value": "dark"})
        );
        assert_eq!(
            features[1],
            serde_json::json!({"name": "prefers-reduced-motion", "value": "reduce"})
        );
    }

    #[tokio::test]
    async fn emulate_custom_device_and_reset() {
        let (tab, log) = mock_tab(|_| serde_json::json!({})).await;
        let (handle, ctx, _dir) = runner_parts();
        let runner = Runner {
            handle: &handle,
            ctx: &ctx,
        };
        runner
            .emulate(
                Some(tab.clone()),
                serde_json::json!({"device": {"width": 1024, "height": 600, "dpr": 2, "mobile": false}}),
            )
            .await
            .unwrap();
        // No user_agent given: no UA override. Landscape orientation. Touch off.
        assert!(!methods(&log).contains(&"Emulation.setUserAgentOverride".to_string()));
        assert_eq!(
            params(&log, "Emulation.setDeviceMetricsOverride")["screenOrientation"]["type"],
            "landscapePrimary"
        );
        assert_eq!(
            params(&log, "Emulation.setTouchEmulationEnabled")["enabled"],
            false
        );

        log.lock().unwrap().clear();
        let (blocks, _) = runner
            .emulate(Some(tab), serde_json::json!({"reset": true}))
            .await
            .unwrap();
        assert!(block_text(&blocks).contains("cleared"));
        assert_eq!(
            methods(&log),
            [
                "Emulation.clearDeviceMetricsOverride",
                "Emulation.setUserAgentOverride",
                "Emulation.setTouchEmulationEnabled",
                "Emulation.setEmulatedMedia"
            ]
        );
        assert_eq!(
            params(&log, "Emulation.setUserAgentOverride")["userAgent"],
            ""
        );
        assert_eq!(
            params(&log, "Emulation.setEmulatedMedia")["features"],
            serde_json::json!([])
        );
    }

    #[tokio::test]
    async fn emulate_rejects_bad_input_without_sending() {
        let (tab, log) = mock_tab(|_| serde_json::json!({})).await;
        let (handle, ctx, _dir) = runner_parts();
        let runner = Runner {
            handle: &handle,
            ctx: &ctx,
        };
        for bad in [
            serde_json::json!({}),
            serde_json::json!({"device": "Nokia"}),
            serde_json::json!({"color_scheme": "sepia"}),
            serde_json::json!({"device": {"width": 10}}),
        ] {
            assert!(runner.emulate(Some(tab.clone()), bad).await.is_err());
        }
        assert!(methods(&log).is_empty(), "{:?}", methods(&log));
    }

    #[tokio::test]
    async fn save_page_writes_mhtml_into_workspace() {
        let (tab, log) = mock_tab(|method| match method {
            "Page.captureSnapshot" => serde_json::json!({"data": "MIME-Version: 1.0\r\nContent-Type: multipart/related\r\n"}),
            _ => serde_json::json!({}),
        })
        .await;
        let (handle, ctx, dir) = runner_parts();
        let runner = Runner {
            handle: &handle,
            ctx: &ctx,
        };
        let (blocks, _) = runner
            .save_page(
                Some(tab.clone()),
                serde_json::json!({"path": "out/page.mhtml"}),
            )
            .await
            .unwrap();
        assert!(block_text(&blocks).contains("mhtml"));
        assert_eq!(params(&log, "Page.captureSnapshot")["format"], "mhtml");
        let written = std::fs::read_to_string(dir.path().join("out").join("page.mhtml")).unwrap();
        assert!(written.starts_with("MIME-Version: 1.0"));

        // Default path lands in <workspace>/downloads/page-<stamp>.mhtml.
        runner
            .save_page(Some(tab), serde_json::json!({}))
            .await
            .unwrap();
        let entries: Vec<_> = std::fs::read_dir(dir.path().join("downloads"))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(entries.len(), 1);
        assert!(
            entries[0].starts_with("page-") && entries[0].ends_with(".mhtml"),
            "{entries:?}"
        );
    }

    #[tokio::test]
    async fn save_page_html_format_and_errors() {
        let (tab, log) = mock_tab(|method| match method {
            "Runtime.evaluate" => serde_json::json!({"result": {"type": "string", "value": "<!DOCTYPE html>\n<html><body>hi</body></html>"}}),
            _ => serde_json::json!({}),
        })
        .await;
        let (handle, ctx, dir) = runner_parts();
        let runner = Runner {
            handle: &handle,
            ctx: &ctx,
        };
        runner
            .save_page(
                Some(tab.clone()),
                serde_json::json!({"path": "p.html", "format": "html"}),
            )
            .await
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.path().join("p.html")).unwrap(),
            "<!DOCTYPE html>\n<html><body>hi</body></html>"
        );
        assert!(!methods(&log).contains(&"Page.captureSnapshot".to_string()));
        assert!(runner
            .save_page(Some(tab), serde_json::json!({"format": "pdf"}))
            .await
            .is_err());
    }

    #[test]
    fn new_tools_are_registered_with_schemas() {
        let handle = BrowserHandle::new(super::super::BrowserConfig::new("unused-profile"));
        let tools = super::super::browser_tools(handle);
        for name in ["browser_emulate", "browser_save_page"] {
            let tool = tools
                .iter()
                .find(|t| t.spec().name == name)
                .unwrap_or_else(|| panic!("{name}"));
            assert_eq!(tool.spec().input_schema["type"], "object");
            assert_eq!(tool.effect(), omnia_harness::EffectClass::BrowserControl);
        }
        let emulate = tools
            .iter()
            .find(|t| t.spec().name == "browser_emulate")
            .unwrap();
        assert_eq!(
            emulate.describe(&serde_json::json!({"device": "Pixel 8", "color_scheme": "dark"})),
            "Emulate in the browser: device Pixel 8, dark color scheme"
        );
        assert_eq!(
            emulate.describe(&serde_json::json!({"reset": true})),
            "Reset browser emulation"
        );
        let save = tools
            .iter()
            .find(|t| t.spec().name == "browser_save_page")
            .unwrap();
        assert_eq!(
            save.describe(&serde_json::json!({"path": "a.html", "format": "html"})),
            "Save page as html to a.html"
        );
        assert!(save.describe(&serde_json::json!({})).contains("downloads"));
    }
}
