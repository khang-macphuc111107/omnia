//! Shared runtime and provider-neutral harness adapters.
mod exec;
pub mod schema;

use crate::{Browser, LaunchOptions, Result};
use async_trait::async_trait;
use omnia_harness::{EffectClass, HarnessResult, Tool, ToolContext, ToolOutput, ToolSpec};
use serde_json::Value;
use std::sync::Arc;

#[derive(Debug, Clone)]
pub struct BrowserConfig {
    pub launch: LaunchOptions,
    /// Explicit local DevTools endpoint; None launches the dedicated profile.
    pub endpoint: Option<String>,
    pub post_action_snapshot_chars: usize,
    /// Where `browser_record` writes recordings (default: a temp folder).
    pub recordings_dir: Option<std::path::PathBuf>,
}
impl BrowserConfig {
    pub fn new(profile_dir: impl Into<std::path::PathBuf>) -> Self {
        Self {
            launch: LaunchOptions::new(profile_dir),
            endpoint: None,
            post_action_snapshot_chars: 8000,
            recordings_dir: None,
        }
    }
}

/// Chooses the launch options (notably the profile directory) at launch time, so
/// a host can arbitrate one persistent profile between several handles.
pub type LaunchResolver = Arc<dyn Fn(&BrowserHandle) -> LaunchOptions + Send + Sync>;

struct Runtime {
    config: BrowserConfig,
    resolver: Option<LaunchResolver>,
    browser: tokio::sync::Mutex<Option<Arc<Browser>>>,
    actions: tokio::sync::Mutex<()>,
    recorder: Arc<crate::record::Recorder>,
}
/// Clone this handle into the desktop state, tool registry and download bridge.
#[derive(Clone)]
pub struct BrowserHandle(Arc<Runtime>);
impl BrowserHandle {
    pub fn new(config: BrowserConfig) -> Self {
        Self::build(config, None)
    }
    /// Like [`BrowserHandle::new`], but the launch options are resolved on every (re)launch.
    pub fn with_resolver(config: BrowserConfig, resolver: LaunchResolver) -> Self {
        Self::build(config, Some(resolver))
    }
    fn build(config: BrowserConfig, resolver: Option<LaunchResolver>) -> Self {
        Self(Arc::new(Runtime {
            config,
            resolver,
            browser: tokio::sync::Mutex::new(None),
            actions: tokio::sync::Mutex::new(()),
            recorder: Arc::default(),
        }))
    }
    pub fn config(&self) -> &BrowserConfig {
        &self.0.config
    }
    pub fn recorder(&self) -> &Arc<crate::record::Recorder> {
        &self.0.recorder
    }
    /// Folder that holds this handle's recordings.
    pub fn recordings_dir(&self) -> std::path::PathBuf {
        self.0
            .config
            .recordings_dir
            .clone()
            .unwrap_or_else(|| std::env::temp_dir().join("omnia-recordings"))
    }
    /// Lazy, single-flight launch; reconnects after a dead connection.
    pub async fn browser(&self) -> Result<Arc<Browser>> {
        let mut slot = self.0.browser.lock().await;
        if let Some(browser) = slot.as_ref().filter(|b| !b.is_closed()) {
            return Ok(browser.clone());
        }
        *slot = None;
        let browser = match &self.0.config.endpoint {
            Some(endpoint) => Browser::connect(endpoint).await?,
            None => Browser::launch(&self.resolve_launch()).await?,
        };
        let browser = Arc::new(browser);
        *slot = Some(browser.clone());
        Ok(browser)
    }
    /// The options the next launch will use (resolver result, or the static config).
    pub fn resolve_launch(&self) -> LaunchOptions {
        match &self.0.resolver {
            Some(resolve) => resolve(self),
            None => self.0.config.launch.clone(),
        }
    }
    /// True while a browser is running or a launch/close is in flight (conservative).
    pub fn is_live(&self) -> bool {
        match self.0.browser.try_lock() {
            Ok(slot) => slot.as_ref().is_some_and(|b| !b.is_closed()),
            Err(_) => true,
        }
    }
    /// The live browser if one was already launched; never launches one.
    pub async fn existing(&self) -> Option<Arc<Browser>> {
        self.0
            .browser
            .lock()
            .await
            .as_ref()
            .filter(|b| !b.is_closed())
            .cloned()
    }
    pub async fn close(&self) {
        let _action = self.0.actions.lock().await;
        drop(self.0.recorder.stop());
        let mut slot = self.0.browser.lock().await;
        if let Some(browser) = slot.take() {
            browser.close().await;
        }
    }
}
struct BrowserTool {
    handle: BrowserHandle,
    kind: schema::Kind,
}
#[async_trait]
impl Tool for BrowserTool {
    fn spec(&self) -> ToolSpec {
        self.kind.spec()
    }
    fn effect(&self) -> EffectClass {
        self.kind.effect()
    }
    fn describe(&self, input: &Value) -> String {
        // Approval descriptions must not leak URL credentials or query tokens.
        if self.kind == schema::Kind::Navigate {
            let clean = input
                .get("url")
                .and_then(Value::as_str)
                .and_then(|raw| url::Url::parse(raw).ok())
                .map(|mut u| {
                    let _ = u.set_username("");
                    let _ = u.set_password(None);
                    u.set_query(None);
                    u.set_fragment(None);
                    u.to_string()
                });
            return match clean {
                Some(url) => self.kind.describe(&serde_json::json!({"url": url})),
                None => "Navigate browser to requested URL".into(),
            };
        }
        self.kind.describe(input)
    }
    async fn call(&self, ctx: &ToolContext, input: Value) -> HarnessResult<ToolOutput> {
        let run = async {
            let _guard = self.handle.0.actions.lock().await;
            exec::Runner {
                handle: &self.handle,
                ctx,
            }
            .run(self.kind, input, true)
            .await
        };
        let output = tokio::select! {
            biased;
            _ = ctx.cancel.cancelled() => ToolOutput::error("Browser operation canceled; already dispatched actions may have completed."),
            result = run => match result {
                Ok(content) => ToolOutput { content, is_error: false },
                Err(message) => ToolOutput::error(message),
            }
        };
        Ok(output)
    }
}
/// Register each returned Arc with ToolRegistry::register. All share one runtime.
pub fn browser_tools(handle: BrowserHandle) -> Vec<Arc<dyn Tool>> {
    schema::ALL_KINDS
        .into_iter()
        .map(|kind| {
            Arc::new(BrowserTool {
                handle: handle.clone(),
                kind,
            }) as Arc<dyn Tool>
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn registration_is_lazy_and_cancel_prevents_launch() {
        let handle = BrowserHandle::new(BrowserConfig::new("unused-profile"));
        let tools = browser_tools(handle.clone());
        assert_eq!(tools.len(), 21);
        assert!(tools
            .iter()
            .all(|t| t.effect() == EffectClass::BrowserControl));
        let ctx = ToolContext::new(".");
        ctx.cancel.cancel();
        assert!(
            tools[0]
                .call(&ctx, serde_json::json!({"url":"http://localhost"}))
                .await
                .unwrap()
                .is_error
        );
        assert!(handle.0.browser.lock().await.is_none());
        handle.close().await;
    }
    #[test]
    fn navigate_description_shows_url_without_secrets() {
        let handle = BrowserHandle::new(BrowserConfig::new("unused-profile"));
        let tool = browser_tools(handle)
            .into_iter()
            .find(|t| t.spec().name == "browser_navigate")
            .unwrap();
        assert_eq!(
            tool.describe(&serde_json::json!({"url":"https://user:pw@example.com/a?token=s#frag"})),
            "Open https://example.com/a in the browser"
        );
    }
}
