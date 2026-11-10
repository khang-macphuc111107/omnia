//! Recorded steps and their translation to a Playwright test.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Page-side description of an element, gathered right before an action runs.
/// Called with `this` = the element.
pub const PROBE_FN: &str = r#"function(){
  const el = this;
  try { el.scrollIntoView({block: 'center', inline: 'center', behavior: 'instant'}); } catch (e) {}
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const tag = el.tagName.toLowerCase();
  const type = (el.getAttribute('type') || '').toLowerCase();
  let role = el.getAttribute('role');
  if (role) role = role.split(/\s+/)[0];
  else if (tag === 'a' && el.hasAttribute('href')) role = 'link';
  else if (tag === 'button') role = 'button';
  else if (tag === 'select') role = el.multiple || el.size > 1 ? 'listbox' : 'combobox';
  else if (tag === 'textarea') role = 'textbox';
  else if (/^h[1-6]$/.test(tag)) role = 'heading';
  else if (tag === 'img') role = 'img';
  else if (tag === 'input') {
    if (['button', 'submit', 'reset', 'image'].includes(type)) role = 'button';
    else if (type === 'checkbox') role = 'checkbox';
    else if (type === 'radio') role = 'radio';
    else if (type === 'range') role = 'slider';
    else if (type === 'number') role = 'spinbutton';
    else if (type === 'search') role = 'searchbox';
    else if (['', 'text', 'email', 'tel', 'url'].includes(type)) role = el.hasAttribute('list') ? 'combobox' : 'textbox';
    else role = null;
  } else role = null;
  let label = '';
  try { if (el.labels && el.labels.length) label = clean(el.labels[0].innerText); } catch (e) {}
  let name = clean(el.getAttribute('aria-label'));
  if (!name) {
    const by = el.getAttribute('aria-labelledby');
    if (by) name = clean(by.split(/\s+/).map((id) => { const n = document.getElementById(id); return n ? n.innerText : ''; }).join(' '));
  }
  if (!name && label) name = label;
  if (!name && tag === 'img') name = clean(el.getAttribute('alt'));
  if (!name && tag === 'input' && ['button', 'submit', 'reset'].includes(type)) name = clean(el.value);
  if (!name && (['button', 'a', 'summary', 'option'].includes(tag) || /^h[1-6]$/.test(tag) || ['button', 'link', 'menuitem', 'tab', 'option', 'heading', 'checkbox', 'radio', 'switch'].includes(role || ''))) name = clean(el.innerText || el.textContent);
  if (!name) name = clean(el.getAttribute('title'));
  let css = '';
  try {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      if (node.id && document.querySelectorAll('#' + CSS.escape(node.id)).length === 1) { parts.unshift('#' + CSS.escape(node.id)); break; }
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = parent;
    }
    css = parts.join(' > ');
  } catch (e) {}
  const r = el.getBoundingClientRect();
  const win = el.ownerDocument.defaultView;
  return {
    tag, inputType: type, id: el.id || '', testId: el.getAttribute('data-testid') || el.getAttribute('data-test-id') || '',
    role: role || '', name, label, placeholder: el.getAttribute('placeholder') || '', css,
    password: tag === 'input' && (type === 'password' || /password/i.test(el.getAttribute('autocomplete') || '')),
    cx: r.left + r.width / 2, cy: r.top + r.height / 2, vw: win.innerWidth, vh: win.innerHeight,
  };
}"#;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct ElementInfo {
    pub tag: String,
    pub input_type: String,
    pub id: String,
    pub test_id: String,
    pub role: String,
    pub name: String,
    pub label: String,
    pub placeholder: String,
    pub css: String,
    pub password: bool,
    pub cx: f64,
    pub cy: f64,
    pub vw: f64,
    pub vh: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    pub index: usize,
    pub tool: String,
    /// Tool input with secrets replaced by placeholders.
    pub input: Value,
    /// Page URL after the action.
    pub url: String,
    pub at_ms: u64,
    pub timestamp: u64,
    /// Playwright locator expression, when the target was an element.
    pub locator: Option<String>,
    pub element: Option<ElementInfo>,
    /// Environment variable that holds the redacted secret value.
    pub secret: Option<String>,
}

/// JS single-quoted string literal.
pub fn js_str(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '\'' => out.push_str("\\'"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\u{2028}' => out.push_str("\\u2028"),
            '\u{2029}' => out.push_str("\\u2029"),
            c => out.push(c),
        }
    }
    out.push('\'');
    out
}

fn css_escape_id(id: &str) -> String {
    let mut out = String::new();
    for (i, c) in id.chars().enumerate() {
        if c.is_ascii_alphanumeric() || c == '-' || c == '_' || (c as u32) > 0x7f {
            if i == 0 && c.is_ascii_digit() {
                out.push_str(&format!("\\{:x} ", c as u32));
            } else {
                out.push(c);
            }
        } else {
            out.push('\\');
            out.push(c);
        }
    }
    out
}

/// Most robust Playwright locator for the element: role+name, then label or
/// placeholder, then test id, then id, then a CSS path.
pub fn locator_code(info: &ElementInfo) -> String {
    if !info.role.is_empty() && !info.name.is_empty() {
        return format!(
            "page.getByRole({}, {{ name: {} }})",
            js_str(&info.role),
            js_str(&info.name)
        );
    }
    if !info.label.is_empty() && info.role.is_empty() {
        return format!("page.getByLabel({})", js_str(&info.label));
    }
    if !info.placeholder.is_empty() {
        return format!("page.getByPlaceholder({})", js_str(&info.placeholder));
    }
    if !info.test_id.is_empty() {
        return format!("page.getByTestId({})", js_str(&info.test_id));
    }
    if !info.id.is_empty() {
        return format!(
            "page.locator({})",
            js_str(&format!("#{}", css_escape_id(&info.id)))
        );
    }
    if !info.css.is_empty() {
        return format!("page.locator({})", js_str(&info.css));
    }
    format!("page.locator({})", js_str(&info.tag))
}

pub fn selector_locator(selector: &str) -> String {
    format!("page.locator({})", js_str(selector))
}

/// Token that stands in for redacted printable keys in a recorded `press`.
pub const SECRET_KEYS: &str = "{SECRET}";

fn playwright_key(combo: &str) -> String {
    combo
        .split('+')
        .map(|part| match part.to_ascii_lowercase().as_str() {
            "ctrl" | "control" => "Control".into(),
            "cmd" | "meta" | "super" | "win" | "command" => "Meta".into(),
            "alt" | "option" => "Alt".into(),
            "shift" => "Shift".into(),
            "esc" | "escape" => "Escape".into(),
            "enter" | "return" => "Enter".into(),
            "del" | "delete" => "Delete".into(),
            "space" => "Space".into(),
            _ => part.to_string(),
        })
        .collect::<Vec<String>>()
        .join("+")
}

/// Redacts printable single-character combos of a `press` typed into a password field.
pub fn redact_press(keys: &str) -> (String, bool) {
    let mut out: Vec<&str> = Vec::new();
    let mut redacted = false;
    for combo in keys.split_whitespace() {
        if combo.chars().count() == 1 {
            redacted = true;
            if out.last() != Some(&SECRET_KEYS) {
                out.push(SECRET_KEYS);
            }
        } else {
            out.push(combo);
        }
    }
    (out.join(" "), redacted)
}

fn modifiers_list(value: &Value) -> Vec<String> {
    let names: Vec<String> = match value {
        Value::String(s) => s.split('+').map(str::to_string).collect(),
        Value::Array(items) => items
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect(),
        _ => vec![],
    };
    names
        .iter()
        .filter(|n| !n.is_empty())
        .map(|n| playwright_key(n))
        .collect()
}

fn num(value: &Value) -> Option<f64> {
    value.as_f64()
}

fn fmt_num(n: f64) -> String {
    if n.fract() == 0.0 {
        format!("{}", n as i64)
    } else {
        format!("{n:.1}")
    }
}

fn secret_expr(secret: &str) -> String {
    format!("process.env.{secret} ?? ''")
}

/// Playwright statements for one step (without indentation).
pub fn step_lines(step: &Step, previous_url: Option<&str>) -> Vec<String> {
    let input = &step.input;
    let loc = step.locator.clone();
    let point = match (num(&input["x"]), num(&input["y"])) {
        (Some(x), Some(y)) => Some((x, y)),
        _ => None,
    };
    let mut lines: Vec<String> = Vec::new();
    let mut maybe_navigated = false;
    let unresolved = || {
        vec![format!(
            "// {}: target could not be resolved; add a locator by hand",
            step.tool
        )]
    };
    match step.tool.as_str() {
        "browser_navigate" => {
            let url = input["url"].as_str().unwrap_or("about:blank");
            if input["new_tab"].as_bool().unwrap_or(false) {
                lines.push("page = await context.newPage();".into());
            }
            lines.push(format!("await page.goto({});", js_str(url)));
            lines.push("await page.waitForLoadState('domcontentloaded');".into());
        }
        "browser_click" => {
            let button = input["button"].as_str().filter(|b| *b != "left");
            let double = input["double"].as_bool().unwrap_or(false);
            let mods = modifiers_list(&input["modifiers"]);
            if let Some(loc) = &loc {
                let mut opts = Vec::new();
                if let Some(b) = button {
                    opts.push(format!("button: {}", js_str(b)));
                }
                if !mods.is_empty() {
                    opts.push(format!(
                        "modifiers: [{}]",
                        mods.iter()
                            .map(|m| js_str(m))
                            .collect::<Vec<_>>()
                            .join(", ")
                    ));
                }
                let opts = if opts.is_empty() {
                    String::new()
                } else {
                    format!("{{ {} }}", opts.join(", "))
                };
                lines.push(format!(
                    "await {loc}.{}({opts});",
                    if double { "dblclick" } else { "click" }
                ));
            } else if let Some((x, y)) = point {
                let mut opts = Vec::new();
                if let Some(b) = button {
                    opts.push(format!("button: {}", js_str(b)));
                }
                if double {
                    opts.push("clickCount: 2".into());
                }
                let opts = if opts.is_empty() {
                    String::new()
                } else {
                    format!(", {{ {} }}", opts.join(", "))
                };
                lines.push(format!(
                    "await page.mouse.click({}, {}{opts});",
                    fmt_num(x),
                    fmt_num(y)
                ));
            } else {
                lines.extend(unresolved());
            }
            maybe_navigated = true;
        }
        "browser_type" => {
            let clear = input["clear"].as_bool().unwrap_or(true);
            let submit = input["submit"].as_bool().unwrap_or(false);
            if let Some(loc) = &loc {
                let value = match &step.secret {
                    Some(secret) => secret_expr(secret),
                    None => js_str(input["text"].as_str().unwrap_or("")),
                };
                lines.push(format!(
                    "await {loc}.{}({value});",
                    if clear { "fill" } else { "pressSequentially" }
                ));
                if submit {
                    lines.push(format!("await {loc}.press('Enter');"));
                }
            } else {
                lines.extend(unresolved());
            }
            maybe_navigated = submit;
        }
        "browser_press" => {
            let keys = input["keys"].as_str().unwrap_or("");
            for combo in keys.split_whitespace() {
                if combo == SECRET_KEYS {
                    let secret = step
                        .secret
                        .clone()
                        .unwrap_or_else(|| "OMNIA_SECRET_1".into());
                    lines.push(format!(
                        "await page.keyboard.type({});",
                        secret_expr(&secret)
                    ));
                } else {
                    lines.push(format!(
                        "await page.keyboard.press({});",
                        js_str(&playwright_key(combo))
                    ));
                }
            }
            maybe_navigated = keys.to_ascii_lowercase().contains("enter");
        }
        "browser_hover" => match (&loc, point) {
            (Some(loc), _) => lines.push(format!("await {loc}.hover();")),
            (None, Some((x, y))) => lines.push(format!(
                "await page.mouse.move({}, {});",
                fmt_num(x),
                fmt_num(y)
            )),
            _ => lines.extend(unresolved()),
        },
        "browser_scroll" => {
            if let Some(loc) = &loc {
                lines.push(format!("await {loc}.scrollIntoViewIfNeeded();"));
            } else {
                let amount = num(&input["amount"]).unwrap_or(600.0);
                let (dx, dy) = match input["direction"].as_str() {
                    Some("up") => (0.0, -amount),
                    Some("left") => (-amount, 0.0),
                    Some("right") => (amount, 0.0),
                    _ => (0.0, amount),
                };
                lines.push(format!(
                    "await page.mouse.wheel({}, {});",
                    fmt_num(dx),
                    fmt_num(dy)
                ));
            }
        }
        "browser_select" => {
            let values: Vec<String> = input["values"]
                .as_array()
                .map(|v| v.iter().filter_map(Value::as_str).map(js_str).collect())
                .unwrap_or_default();
            match &loc {
                Some(loc) => lines.push(format!(
                    "await {loc}.selectOption([{}]);",
                    values.join(", ")
                )),
                None => lines.extend(unresolved()),
            }
        }
        "browser_upload" => {
            let paths: Vec<String> = input["paths"]
                .as_array()
                .map(|v| v.iter().filter_map(Value::as_str).map(js_str).collect())
                .unwrap_or_default();
            match &loc {
                Some(loc) => lines.push(format!(
                    "await {loc}.setInputFiles([{}]);",
                    paths.join(", ")
                )),
                None => lines.extend(unresolved()),
            }
        }
        "browser_wait" => {
            if let Some(t) = input["text"].as_str() {
                lines.push(format!(
                    "await expect(page.getByText({})).toBeVisible();",
                    js_str(t)
                ));
            } else if let Some(t) = input["text_gone"].as_str() {
                lines.push(format!(
                    "await expect(page.getByText({})).toBeHidden();",
                    js_str(t)
                ));
            } else if let Some(s) = input["selector"].as_str() {
                lines.push(format!("await page.locator({}).waitFor();", js_str(s)));
            } else if let Some(ms) = num(&input["ms"]) {
                lines.push(format!("await page.waitForTimeout({});", fmt_num(ms)));
            }
        }
        other => lines.push(format!("// {other}: not replayed")),
    }
    if maybe_navigated && previous_url.is_some_and(|p| p != step.url) && !step.url.is_empty() {
        lines.push("await page.waitForLoadState('domcontentloaded');".into());
    }
    lines
}

/// Whole `replay.spec.ts`.
pub fn playwright_spec(name: &str, steps: &[Step], secrets: &[String]) -> String {
    let mut out = String::new();
    out.push_str("// Generated by Omnia browser_record. Selectors were captured at action time and may need tuning.\n");
    if secrets.is_empty() {
        out.push_str("// No secrets were typed during this recording.\n");
    } else {
        out.push_str("// Values typed into password fields were NOT recorded. Provide them as environment variables:\n");
        for s in secrets {
            out.push_str(&format!("//   {s}\n"));
        }
    }
    out.push_str("import { test, expect } from '@playwright/test';\n\n");
    out.push_str(&format!(
        "test({}, async ({{ page, context }}) => {{\n",
        js_str(name)
    ));
    let mut previous: Option<&str> = None;
    for step in steps {
        out.push_str(&format!("  // step {}: {}\n", step.index + 1, step.tool));
        for line in step_lines(step, previous) {
            out.push_str("  ");
            out.push_str(&line);
            out.push('\n');
        }
        previous = Some(step.url.as_str());
    }
    out.push_str("});\n");
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn step(tool: &str, input: Value, locator: Option<&str>) -> Step {
        Step {
            index: 0,
            tool: tool.into(),
            input,
            url: "https://a.test/".into(),
            at_ms: 0,
            timestamp: 0,
            locator: locator.map(str::to_string),
            element: None,
            secret: None,
        }
    }

    #[test]
    fn locator_preference_order() {
        let mut info = ElementInfo {
            role: "button".into(),
            name: "Save it's".into(),
            id: "x".into(),
            ..Default::default()
        };
        assert_eq!(
            locator_code(&info),
            "page.getByRole('button', { name: 'Save it\\'s' })"
        );
        info.role.clear();
        info.name.clear();
        info.placeholder = "Email".into();
        assert_eq!(locator_code(&info), "page.getByPlaceholder('Email')");
        info.placeholder.clear();
        info.test_id = "go".into();
        assert_eq!(locator_code(&info), "page.getByTestId('go')");
        info.test_id.clear();
        assert_eq!(locator_code(&info), "page.locator('#x')");
        info.id.clear();
        info.css = "main > div:nth-of-type(2) > a".into();
        assert_eq!(
            locator_code(&info),
            "page.locator('main > div:nth-of-type(2) > a')"
        );
        info.label = "Name".into();
        assert_eq!(locator_code(&info), "page.getByLabel('Name')");
        assert_eq!(css_escape_id("a.b"), "a\\.b");
    }

    #[test]
    fn each_step_kind_generates_code() {
        let l = Some("page.getByRole('link', { name: 'Go' })");
        let nav = step(
            "browser_navigate",
            json!({"url": "https://a.test/x", "new_tab": true}),
            None,
        );
        assert_eq!(
            step_lines(&nav, None),
            [
                "page = await context.newPage();",
                "await page.goto('https://a.test/x');",
                "await page.waitForLoadState('domcontentloaded');"
            ]
        );
        let click = step(
            "browser_click",
            json!({"ref": "e1", "double": true, "button": "right", "modifiers": ["ctrl"]}),
            l,
        );
        assert_eq!(
            step_lines(&click, Some("https://a.test/")),
            ["await page.getByRole('link', { name: 'Go' }).dblclick({ button: 'right', modifiers: ['Control'] });"]
        );
        let mut moved = step("browser_click", json!({"ref": "e1"}), l);
        moved.url = "https://a.test/next".into();
        assert_eq!(
            step_lines(&moved, Some("https://a.test/")).last().unwrap(),
            "await page.waitForLoadState('domcontentloaded');"
        );
        assert_eq!(
            step_lines(
                &step("browser_click", json!({"x": 10.0, "y": 20.5}), None),
                None
            ),
            ["await page.mouse.click(10, 20.5);"]
        );
        let ty = step(
            "browser_type",
            json!({"text": "hi\n", "submit": true}),
            Some("page.locator('#q')"),
        );
        assert_eq!(
            step_lines(&ty, None),
            [
                "await page.locator('#q').fill('hi\\n');",
                "await page.locator('#q').press('Enter');"
            ]
        );
        let append = step(
            "browser_type",
            json!({"text": "x", "clear": false}),
            Some("page.locator('#q')"),
        );
        assert_eq!(
            step_lines(&append, None),
            ["await page.locator('#q').pressSequentially('x');"]
        );
        assert_eq!(
            step_lines(
                &step("browser_press", json!({"keys": "ctrl+a Backspace"}), None),
                None
            ),
            [
                "await page.keyboard.press('Control+a');",
                "await page.keyboard.press('Backspace');"
            ]
        );
        assert_eq!(
            step_lines(
                &step("browser_hover", json!({}), Some("page.locator('#h')")),
                None
            ),
            ["await page.locator('#h').hover();"]
        );
        assert_eq!(
            step_lines(
                &step(
                    "browser_scroll",
                    json!({"direction": "up", "amount": 300}),
                    None
                ),
                None
            ),
            ["await page.mouse.wheel(0, -300);"]
        );
        assert_eq!(
            step_lines(
                &step(
                    "browser_scroll",
                    json!({"ref": "e2"}),
                    Some("page.locator('#s')")
                ),
                None
            ),
            ["await page.locator('#s').scrollIntoViewIfNeeded();"]
        );
        assert_eq!(
            step_lines(
                &step(
                    "browser_select",
                    json!({"values": ["a", "b"]}),
                    Some("page.locator('#s')")
                ),
                None
            ),
            ["await page.locator('#s').selectOption(['a', 'b']);"]
        );
        assert_eq!(
            step_lines(
                &step(
                    "browser_upload",
                    json!({"paths": ["f.txt"]}),
                    Some("page.locator('#u')")
                ),
                None
            ),
            ["await page.locator('#u').setInputFiles(['f.txt']);"]
        );
        assert_eq!(
            step_lines(&step("browser_wait", json!({"text": "Done"}), None), None),
            ["await expect(page.getByText('Done')).toBeVisible();"]
        );
        assert_eq!(
            step_lines(&step("browser_wait", json!({"ms": 500}), None), None),
            ["await page.waitForTimeout(500);"]
        );
    }

    #[test]
    fn passwords_become_env_placeholders() {
        let mut ty = step(
            "browser_type",
            json!({"text": "[redacted]"}),
            Some("page.getByLabel('Password')"),
        );
        ty.secret = Some("OMNIA_SECRET_1".into());
        assert_eq!(
            step_lines(&ty, None),
            ["await page.getByLabel('Password').fill(process.env.OMNIA_SECRET_1 ?? '');"]
        );
        let (keys, redacted) = redact_press("h u n t e r Enter");
        assert!(redacted);
        assert_eq!(keys, "{SECRET} Enter");
        let mut press = step("browser_press", json!({"keys": keys}), None);
        press.secret = Some("OMNIA_SECRET_2".into());
        assert_eq!(
            step_lines(&press, None),
            [
                "await page.keyboard.type(process.env.OMNIA_SECRET_2 ?? '');",
                "await page.keyboard.press('Enter');"
            ]
        );
        let spec = playwright_spec("t", &[ty], &["OMNIA_SECRET_1".into()]);
        assert!(spec.contains("import { test, expect } from '@playwright/test';"));
        assert!(spec.contains("//   OMNIA_SECRET_1"));
        assert!(!spec.contains("hunter"));
    }
}
