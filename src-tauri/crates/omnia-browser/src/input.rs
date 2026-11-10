//! Element targeting and synthetic input (mouse, keyboard, forms).

use std::path::PathBuf;
use std::time::Duration;

use serde_json::{json, Value};

use crate::error::{BrowserError, Result};
use crate::keys::{self, KeyCombo};
use crate::tab::{check_exception, Tab};

/// How an action picks its element.
#[derive(Debug, Clone, PartialEq)]
pub enum Target {
    /// A ref from the latest snapshot (`e12`).
    Ref(String),
    /// A CSS selector (first match, main document).
    Selector(String),
    /// Viewport coordinates in CSS pixels.
    Point(f64, f64),
}

impl Target {
    /// Builds a target from optional tool arguments; ref wins over selector over point.
    pub fn from_args(
        r#ref: Option<&str>,
        selector: Option<&str>,
        x: Option<f64>,
        y: Option<f64>,
    ) -> Option<Target> {
        if let Some(r) = r#ref.filter(|r| !r.trim().is_empty()) {
            return Some(Target::Ref(r.trim().trim_start_matches('@').to_string()));
        }
        if let Some(s) = selector.filter(|s| !s.trim().is_empty()) {
            return Some(Target::Selector(s.to_string()));
        }
        match (x, y) {
            (Some(x), Some(y)) => Some(Target::Point(x, y)),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum MouseButton {
    #[default]
    Left,
    Right,
    Middle,
}

impl MouseButton {
    fn name(self) -> &'static str {
        match self {
            Self::Left => "left",
            Self::Right => "right",
            Self::Middle => "middle",
        }
    }

    fn mask(self) -> u8 {
        match self {
            Self::Left => 1,
            Self::Right => 2,
            Self::Middle => 4,
        }
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct ClickOptions {
    pub button: MouseButton,
    pub double: bool,
    pub modifiers: u8,
}

/// Where an element ended up after scrolling it into view.
#[derive(Debug, Clone, PartialEq)]
pub struct ElementBox {
    /// Viewport coordinates of the click point (top-level frame).
    pub x: f64,
    pub y: f64,
    /// Top-left of the element in document coordinates, plus its size.
    pub page_x: f64,
    pub page_y: f64,
    pub width: f64,
    pub height: f64,
    /// Description of an element covering the click point, if any.
    pub covered_by: Option<String>,
}

const CENTER_FN: &str = r#"function(){
  const el = this;
  if (!el.isConnected) return {error: 'detached'};
  try { el.scrollIntoView({block: 'center', inline: 'center', behavior: 'instant'}); } catch (e) {}
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) {
    return {error: 'noSize', hiddenInput: el.tagName === 'INPUT' && ['checkbox', 'radio', 'file'].includes(el.type)};
  }
  const win = el.ownerDocument.defaultView;
  const l = Math.max(r.left, 0), t = Math.max(r.top, 0);
  const rr = Math.min(r.right, win.innerWidth), b = Math.min(r.bottom, win.innerHeight);
  let x = (l + rr) / 2, y = (t + b) / 2;
  let left = r.left, top = r.top;
  let covered = null;
  try {
    const hit = el.ownerDocument.elementFromPoint(x, y);
    if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) {
      const root = el.getRootNode();
      if (!(root.host && (root.host === hit || hit.shadowRoot === root))) {
        covered = hit.tagName.toLowerCase() + (hit.id ? '#' + hit.id : '');
      }
    }
  } catch (e) {}
  let w = win;
  try {
    while (w !== w.top && w.frameElement) {
      const fr = w.frameElement.getBoundingClientRect();
      const cs = w.parent.getComputedStyle(w.frameElement);
      const ox = fr.left + parseFloat(cs.borderLeftWidth || 0) + parseFloat(cs.paddingLeft || 0);
      const oy = fr.top + parseFloat(cs.borderTopWidth || 0) + parseFloat(cs.paddingTop || 0);
      x += ox; y += oy; left += ox; top += oy;
      w = w.parent;
    }
  } catch (e) {}
  return {x: x, y: y, pageX: left + w.scrollX, pageY: top + w.scrollY, width: r.width, height: r.height, covered: covered};
}"#;

const FOCUS_FN: &str = r#"function(clear){
  const el = this;
  try { el.scrollIntoView({block: 'center', inline: 'center', behavior: 'instant'}); } catch (e) {}
  el.focus({preventScroll: true});
  const tag = el.tagName;
  const textual = tag === 'INPUT' || tag === 'TEXTAREA';
  if (clear) {
    if (textual) { try { el.select(); } catch (e) {} }
    else if (el.isContentEditable) {
      const doc = el.ownerDocument;
      const range = doc.createRange(); range.selectNodeContents(el);
      const sel = doc.defaultView.getSelection(); sel.removeAllRanges(); sel.addRange(range);
    }
  } else if (textual) {
    try { const n = el.value.length; el.setSelectionRange(n, n); } catch (e) {}
  }
  return {tag: tag.toLowerCase(), editable: textual || el.isContentEditable || el.getAttribute('role') === 'textbox' || el.getAttribute('role') === 'combobox'};
}"#;

const SELECT_FN: &str = r#"function(values){
  const el = this;
  if (el.tagName !== 'SELECT') return {error: 'notSelect', tag: el.tagName.toLowerCase()};
  const want = new Set(values);
  const chosen = [];
  let picked = false;
  for (const o of el.options) {
    const match = want.has(o.value) || want.has(o.label) || want.has(o.text.trim());
    if (el.multiple) { o.selected = match; if (match) chosen.push(o.text.trim()); }
    else if (match && !picked) { o.selected = true; picked = true; chosen.push(o.text.trim()); }
  }
  if (chosen.length === 0) return {error: 'noMatch', options: Array.from(el.options).slice(0, 30).map(o => o.text.trim())};
  el.dispatchEvent(new Event('input', {bubbles: true}));
  el.dispatchEvent(new Event('change', {bubbles: true}));
  return {selected: chosen};
}"#;

const CLICK_FALLBACK_FN: &str = "function(){ this.click(); return true; }";

impl Tab {
    /// Resolves a target to a remote object id (for `Target::Ref`/`Selector`).
    async fn resolve_object(&self, target: &Target) -> Result<String> {
        let (expression, what) = match target {
            Target::Ref(r) => (
                format!(
                    "(window.__omnia && window.__omnia.get({})) || null",
                    Value::String(r.clone())
                ),
                format!("ref `{r}`"),
            ),
            Target::Selector(s) => (
                format!("document.querySelector({})", Value::String(s.clone())),
                format!("selector `{s}`"),
            ),
            Target::Point(..) => {
                return Err(BrowserError::Invalid(
                    "a coordinate target has no element".into(),
                ))
            }
        };
        let response = self
            .send(
                "Runtime.evaluate",
                json!({"expression": expression, "returnByValue": false, "objectGroup": "omnia"}),
            )
            .await?;
        check_exception(&response)?;
        match response["result"]["objectId"].as_str() {
            Some(id) => Ok(id.to_string()),
            None => Err(BrowserError::NotFound(match target {
                Target::Ref(_) => format!(
                    "{what} not found: the page changed or the ref is stale. Take a fresh browser_snapshot and use its refs."
                ),
                _ => format!("{what} matched no element"),
            })),
        }
    }

    async fn call_on(&self, object_id: &str, function: &str, args: Vec<Value>) -> Result<Value> {
        let arguments: Vec<Value> = args.into_iter().map(|v| json!({"value": v})).collect();
        let response = self
            .send(
                "Runtime.callFunctionOn",
                json!({
                    "objectId": object_id,
                    "functionDeclaration": function,
                    "arguments": arguments,
                    "returnByValue": true,
                    "awaitPromise": true,
                    "userGesture": true,
                }),
            )
            .await?;
        check_exception(&response)?;
        Ok(response["result"]
            .get("value")
            .cloned()
            .unwrap_or(Value::Null))
    }

    async fn release(&self) {
        let _ = self
            .send(
                "Runtime.releaseObjectGroup",
                json!({"objectGroup": "omnia"}),
            )
            .await;
    }

    /// Runs `function` (with `this` = the element) on a ref/selector target and returns its JSON result.
    pub async fn call_on_target(&self, target: &Target, function: &str) -> Result<Value> {
        let object = self.resolve_object(target).await?;
        let result = self.call_on(&object, function, vec![]).await;
        self.release().await;
        result
    }

    /// Scrolls an element into view and measures it. `Err(Invalid)` when it has no size.
    pub async fn locate(&self, target: &Target) -> Result<ElementBox> {
        if let Target::Point(x, y) = target {
            return Ok(ElementBox {
                x: *x,
                y: *y,
                page_x: *x,
                page_y: *y,
                width: 0.0,
                height: 0.0,
                covered_by: None,
            });
        }
        let object = self.resolve_object(target).await?;
        let result = self.call_on(&object, CENTER_FN, vec![]).await;
        self.release().await;
        let value = result?;
        if let Some(error) = value["error"].as_str() {
            return Err(BrowserError::Invalid(match error {
                "detached" => "element is no longer attached to the page; take a fresh browser_snapshot".into(),
                _ => "element has no size (hidden or collapsed); it cannot be interacted with by position".into(),
            }));
        }
        Ok(ElementBox {
            x: value["x"].as_f64().unwrap_or(0.0),
            y: value["y"].as_f64().unwrap_or(0.0),
            page_x: value["pageX"].as_f64().unwrap_or(0.0),
            page_y: value["pageY"].as_f64().unwrap_or(0.0),
            width: value["width"].as_f64().unwrap_or(0.0),
            height: value["height"].as_f64().unwrap_or(0.0),
            covered_by: value["covered"].as_str().map(str::to_string),
        })
    }

    #[allow(clippy::too_many_arguments)] // mirrors the persisted record layout; bundling into a struct would be a larger refactor
    async fn mouse(
        &self,
        kind: &str,
        x: f64,
        y: f64,
        button: &str,
        buttons: u8,
        count: u32,
        modifiers: u8,
    ) -> Result<()> {
        self.send(
            "Input.dispatchMouseEvent",
            json!({
                "type": kind, "x": x, "y": y, "button": button,
                "buttons": buttons, "clickCount": count, "modifiers": modifiers,
            }),
        )
        .await
        .map(|_| ())
    }

    /// Clicks an element (or point). Returns a note when something covers the target.
    pub async fn click(&self, target: &Target, options: ClickOptions) -> Result<Option<String>> {
        let located = match self.locate(target).await {
            Ok(b) => b,
            Err(BrowserError::Invalid(m)) if m.starts_with("element has no size") => {
                // Visually hidden checkboxes/radios/file inputs are toggled via their DOM click().
                let object = self.resolve_object(target).await?;
                let hidden_ok = self
                    .call_on(&object, "function(){ return this.tagName === 'INPUT' && ['checkbox','radio'].includes(this.type); }", vec![])
                    .await
                    .map(|v| v.as_bool().unwrap_or(false))
                    .unwrap_or(false);
                if hidden_ok {
                    let r = self.call_on(&object, CLICK_FALLBACK_FN, vec![]).await;
                    self.release().await;
                    r?;
                    return Ok(Some("element had no box; toggled via DOM click()".into()));
                }
                self.release().await;
                return Err(BrowserError::Invalid(m));
            }
            Err(e) => return Err(e),
        };
        let button = options.button.name();
        let mask = options.button.mask();
        self.mouse(
            "mouseMoved",
            located.x,
            located.y,
            "none",
            0,
            0,
            options.modifiers,
        )
        .await?;
        let presses = if options.double { 2 } else { 1 };
        for count in 1..=presses {
            self.mouse(
                "mousePressed",
                located.x,
                located.y,
                button,
                mask,
                count,
                options.modifiers,
            )
            .await?;
            self.mouse(
                "mouseReleased",
                located.x,
                located.y,
                button,
                0,
                count,
                options.modifiers,
            )
            .await?;
        }
        Ok(located.covered_by.map(|c| {
            format!("note: the click point was covered by <{c}>; if nothing happened, close the overlay or scroll")
        }))
    }

    pub async fn hover(&self, target: &Target) -> Result<()> {
        let located = self.locate(target).await?;
        self.mouse("mouseMoved", located.x, located.y, "none", 0, 0, 0)
            .await
    }

    /// Scrolls the page by a delta in CSS pixels (positive y scrolls down).
    pub async fn scroll_by(&self, dx: f64, dy: f64) -> Result<ScrollPosition> {
        let size = self
            .evaluate("JSON.stringify([window.innerWidth, window.innerHeight])")
            .await?;
        let dims: Vec<f64> =
            serde_json::from_str(size.as_str().unwrap_or("[800,600]")).unwrap_or_default();
        let (w, h) = (
            dims.first().copied().unwrap_or(800.0),
            dims.get(1).copied().unwrap_or(600.0),
        );
        self.send(
            "Input.dispatchMouseEvent",
            json!({"type": "mouseWheel", "x": w / 2.0, "y": h / 2.0, "deltaX": dx, "deltaY": dy}),
        )
        .await?;
        tokio::time::sleep(Duration::from_millis(200)).await;
        self.scroll_position().await
    }

    pub async fn scroll_position(&self) -> Result<ScrollPosition> {
        let value = self
            .evaluate("JSON.stringify([Math.round(scrollX), Math.round(scrollY), document.documentElement.scrollHeight, innerHeight])")
            .await?;
        let v: Vec<f64> = serde_json::from_str(value.as_str().unwrap_or("[]")).unwrap_or_default();
        Ok(ScrollPosition {
            x: v.first().copied().unwrap_or(0.0),
            y: v.get(1).copied().unwrap_or(0.0),
            page_height: v.get(2).copied().unwrap_or(0.0),
            viewport_height: v.get(3).copied().unwrap_or(0.0),
        })
    }

    /// Scrolls an element to the center of the viewport.
    pub async fn scroll_into_view(&self, target: &Target) -> Result<ScrollPosition> {
        self.locate(target).await?;
        self.scroll_position().await
    }

    async fn key_event(
        &self,
        kind: &str,
        combo: &KeyCombo,
        key: &keys::KeyDef,
        modifiers: u8,
        with_text: bool,
    ) -> Result<()> {
        let text = if with_text {
            combo.effective_text()
        } else {
            None
        };
        let mut params = json!({
            "type": kind,
            "modifiers": modifiers,
            "key": key.key,
            "code": key.code,
            "windowsVirtualKeyCode": key.vk,
            "nativeVirtualKeyCode": key.vk,
        });
        if let Some(text) = text {
            params["text"] = Value::String(text.to_string());
            params["unmodifiedText"] = Value::String(text.to_string());
        }
        if kind != "keyUp" {
            let commands = combo.commands();
            if !commands.is_empty() {
                params["commands"] = json!(commands);
            }
        }
        self.send("Input.dispatchKeyEvent", params)
            .await
            .map(|_| ())
    }

    /// Presses one combo: modifier downs, key down/up, modifier ups.
    pub async fn press_combo(&self, combo: &KeyCombo) -> Result<()> {
        let mods = keys::modifier_keys(combo.modifiers);
        let mut held = 0u8;
        for (bit, def) in &mods {
            held |= bit;
            self.key_event("rawKeyDown", combo, def, held, false)
                .await?;
        }
        let is_modifier_key =
            matches!(combo.key.key.as_str(), "Shift" | "Control" | "Alt" | "Meta");
        let has_text = combo.effective_text().is_some();
        let down = if has_text { "keyDown" } else { "rawKeyDown" };
        if !is_modifier_key || mods.is_empty() {
            self.key_event(down, combo, &combo.key, combo.modifiers, true)
                .await?;
            self.key_event("keyUp", combo, &combo.key, combo.modifiers, false)
                .await?;
        }
        for (bit, def) in mods.iter().rev() {
            held &= !bit;
            self.key_event("keyUp", combo, def, held, false).await?;
        }
        Ok(())
    }

    /// Presses a whitespace-separated sequence like `ctrl+a Backspace`.
    pub async fn press_keys(&self, spec: &str) -> Result<()> {
        let combos = keys::parse_sequence(spec).map_err(BrowserError::Invalid)?;
        for combo in &combos {
            self.press_combo(combo).await?;
        }
        Ok(())
    }

    /// Focuses an element, optionally replaces its content, and types `text`.
    /// Returns a warning when the element does not look editable.
    pub async fn type_text(
        &self,
        target: &Target,
        text: &str,
        clear: bool,
        submit: bool,
    ) -> Result<Option<String>> {
        let mut warning = None;
        match target {
            Target::Point(..) => {
                self.click(target, ClickOptions::default()).await?;
            }
            _ => {
                let object = self.resolve_object(target).await?;
                let result = self
                    .call_on(&object, FOCUS_FN, vec![Value::Bool(clear)])
                    .await;
                self.release().await;
                let info = result?;
                if info["editable"].as_bool() == Some(false) {
                    warning = Some(format!(
                        "note: <{}> does not look like a text field; typing may have had no effect",
                        info["tag"].as_str().unwrap_or("element")
                    ));
                }
            }
        }
        if text.is_empty() {
            if clear {
                self.press_keys("Delete").await?;
            }
        } else {
            self.send("Input.insertText", json!({"text": text})).await?;
        }
        if submit {
            self.press_keys("Enter").await?;
        }
        Ok(warning)
    }

    /// Selects `<select>` options by value or visible label.
    pub async fn select_options(&self, target: &Target, values: &[String]) -> Result<Vec<String>> {
        let object = self.resolve_object(target).await?;
        let result = self.call_on(&object, SELECT_FN, vec![json!(values)]).await;
        self.release().await;
        let value = result?;
        match value["error"].as_str() {
            Some("notSelect") => Err(BrowserError::Invalid(format!(
                "element is a <{}>, not a <select>; click it and pick the option instead",
                value["tag"].as_str().unwrap_or("element")
            ))),
            Some(_) => Err(BrowserError::NotFound(format!(
                "no option matched {values:?}; available: {}",
                value["options"]
                    .as_array()
                    .map(|o| o
                        .iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join(" | "))
                    .unwrap_or_default()
            ))),
            None => Ok(value["selected"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default()),
        }
    }

    /// Sets files on an `<input type=file>` (absolute paths).
    pub async fn upload_files(&self, target: &Target, paths: &[PathBuf]) -> Result<()> {
        let object = self.resolve_object(target).await?;
        let files: Vec<String> = paths
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect();
        let result = self
            .send(
                "DOM.setFileInputFiles",
                json!({"files": files, "objectId": object}),
            )
            .await;
        self.release().await;
        result.map(|_| ())
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ScrollPosition {
    pub x: f64,
    pub y: f64,
    pub page_height: f64,
    pub viewport_height: f64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn target_priority() {
        assert_eq!(
            Target::from_args(Some("@e5"), Some("a"), Some(1.0), Some(2.0)),
            Some(Target::Ref("e5".into()))
        );
        assert_eq!(
            Target::from_args(None, Some("#go"), Some(1.0), Some(2.0)),
            Some(Target::Selector("#go".into()))
        );
        assert_eq!(
            Target::from_args(Some(" "), None, Some(1.0), Some(2.0)),
            Some(Target::Point(1.0, 2.0))
        );
        assert_eq!(Target::from_args(None, None, Some(1.0), None), None);
    }
}
