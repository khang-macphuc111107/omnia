//! UI Automation: compact accessibility-tree snapshots with refs, and actions on refs.
//!
//! Everything here runs on the dedicated worker thread (COM MTA); the element
//! table never leaves it.

use std::collections::HashMap;

use windows::core::{Interface, BSTR};
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};
use windows::Win32::System::Variant::VARIANT;
use windows::Win32::UI::Accessibility::*;

use crate::format::{
    classify, format_nodes, has_useful_children, parse_ref, role_name, Kind, Node, PatternFlags,
};
use crate::input;
use crate::keys::parse_chord;
use crate::types::{
    ElementAction, InputTiming, MouseButton, Rect, Snapshot, SnapshotOptions, WindowInfo,
};
use crate::winapi;
use crate::ComputerError;

const STALE: &str = "element is gone or stale; take a new computer_snapshot and use the new ref";

fn fail(what: &str, e: impl std::fmt::Display) -> ComputerError {
    ComputerError::Failed(format!("UI Automation {what}: {e}"))
}

struct Table {
    hwnd: isize,
    elems: Vec<IUIAutomationElement>,
}

pub struct Uia {
    auto: IUIAutomation,
    cache: IUIAutomationCacheRequest,
    next_slot: u32,
    tables: HashMap<u32, Table>,
    by_hwnd: HashMap<isize, u32>,
}

fn v_bool(v: &VARIANT) -> Option<bool> {
    bool::try_from(v).ok()
}

fn v_i32(v: &VARIANT) -> Option<i32> {
    i32::try_from(v).ok()
}

fn v_string(v: &VARIANT) -> Option<String> {
    BSTR::try_from(v).ok().map(|b| b.to_string())
}

fn cached_bool(el: &IUIAutomationElement, id: UIA_PROPERTY_ID) -> bool {
    unsafe { el.GetCachedPropertyValue(id) }
        .ok()
        .and_then(|v| v_bool(&v))
        .unwrap_or(false)
}

fn cached_i32(el: &IUIAutomationElement, id: UIA_PROPERTY_ID) -> Option<i32> {
    unsafe { el.GetCachedPropertyValue(id) }
        .ok()
        .and_then(|v| v_i32(&v))
}

fn cached_string(el: &IUIAutomationElement, id: UIA_PROPERTY_ID) -> Option<String> {
    unsafe { el.GetCachedPropertyValue(id) }
        .ok()
        .and_then(|v| v_string(&v))
}

fn pattern<T: Interface>(el: &IUIAutomationElement, id: UIA_PATTERN_ID) -> Option<T> {
    unsafe { el.GetCurrentPatternAs::<T>(id) }.ok()
}

impl Uia {
    pub fn new() -> Result<Self, ComputerError> {
        unsafe {
            let auto: IUIAutomation = CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)
                .map_err(|e| fail("init", e))?;
            let cache = auto.CreateCacheRequest().map_err(|e| fail("cache", e))?;
            for id in [
                UIA_NamePropertyId,
                UIA_ControlTypePropertyId,
                UIA_BoundingRectanglePropertyId,
                UIA_IsEnabledPropertyId,
                UIA_IsOffscreenPropertyId,
                UIA_AutomationIdPropertyId,
                UIA_HasKeyboardFocusPropertyId,
                UIA_IsInvokePatternAvailablePropertyId,
                UIA_IsValuePatternAvailablePropertyId,
                UIA_IsTogglePatternAvailablePropertyId,
                UIA_IsSelectionItemPatternAvailablePropertyId,
                UIA_IsExpandCollapsePatternAvailablePropertyId,
                UIA_IsTextPatternAvailablePropertyId,
                UIA_ValueValuePropertyId,
                UIA_ToggleToggleStatePropertyId,
                UIA_SelectionItemIsSelectedPropertyId,
                UIA_ExpandCollapseExpandCollapseStatePropertyId,
            ] {
                cache.AddProperty(id).map_err(|e| fail("cache", e))?;
            }
            cache
                .SetTreeScope(TreeScope(TreeScope_Element.0 | TreeScope_Children.0))
                .map_err(|e| fail("cache", e))?;
            if let Ok(cond) = auto.ControlViewCondition() {
                let _ = cache.SetTreeFilter(&cond);
            }
            Ok(Self {
                auto,
                cache,
                next_slot: 1,
                tables: HashMap::new(),
                by_hwnd: HashMap::new(),
            })
        }
    }

    // ------------------------------------------------------------ snapshot

    pub fn snapshot(
        &mut self,
        window: &WindowInfo,
        opts: &SnapshotOptions,
    ) -> Result<Snapshot, ComputerError> {
        let root = unsafe {
            self.auto
                .ElementFromHandleBuildCache(winapi::hwnd_of(window.hwnd), &self.cache)
                .map_err(|e| fail("ElementFromHandle", e))?
        };
        let slot = self.next_slot;
        self.next_slot += 1;
        let mut w = Walk {
            opts,
            slot,
            nodes: Vec::new(),
            elems: Vec::new(),
            visited: 0,
            truncated: false,
            text_reads: 0,
        };
        self.walk(&root, 0, 0, &mut w);
        if let Some(old) = self.by_hwnd.insert(window.hwnd, slot) {
            self.tables.remove(&old);
        }
        let ref_count = w.elems.len();
        self.tables.insert(
            slot,
            Table {
                hwnd: window.hwnd,
                elems: w.elems,
            },
        );
        let node_count = w.nodes.len();
        let (text, _) = format_nodes(&w.nodes, opts.max_chars);
        Ok(Snapshot {
            window: window.clone(),
            text,
            node_count,
            ref_count,
            truncated: w.truncated,
        })
    }

    fn walk(&self, parent: &IUIAutomationElement, depth: usize, emit_depth: usize, w: &mut Walk) {
        let Ok(children) = (unsafe { parent.GetCachedChildren() }) else {
            return;
        };
        let len = unsafe { children.Length() }.unwrap_or(0);
        for i in 0..len {
            if w.visited >= w.opts.max_nodes {
                w.truncated = true;
                return;
            }
            let Ok(el) = (unsafe { children.GetElement(i) }) else {
                continue;
            };
            w.visited += 1;
            if unsafe { el.CachedIsOffscreen() }
                .map(|b| b.as_bool())
                .unwrap_or(false)
            {
                continue;
            }
            let ct = unsafe { el.CachedControlType() }.map(|c| c.0).unwrap_or(0);
            let rect = unsafe { el.CachedBoundingRectangle() }
                .map(|r| Rect::from_ltrb(r.left, r.top, r.right, r.bottom))
                .unwrap_or_default();
            let name = unsafe { el.CachedName() }
                .map(|b| b.to_string())
                .unwrap_or_default();
            let flags = PatternFlags {
                invoke: cached_bool(&el, UIA_IsInvokePatternAvailablePropertyId),
                value: cached_bool(&el, UIA_IsValuePatternAvailablePropertyId),
                toggle: cached_bool(&el, UIA_IsTogglePatternAvailablePropertyId),
                selection_item: cached_bool(&el, UIA_IsSelectionItemPatternAvailablePropertyId),
                expand_collapse: cached_bool(&el, UIA_IsExpandCollapsePatternAvailablePropertyId),
                text: cached_bool(&el, UIA_IsTextPatternAvailablePropertyId),
            };
            let mut emitted = false;
            if !rect.is_empty() {
                let kind = classify(ct, name.trim().is_empty(), &flags);
                let show = match kind {
                    Kind::Interactive => true,
                    Kind::Text | Kind::Container => !w.opts.interactive_only,
                    Kind::Skip => false,
                };
                if show {
                    let ref_id = (kind == Kind::Interactive)
                        .then(|| format!("w{}e{}", w.slot, w.elems.len()));
                    let node = self.build_node(&el, ct, name, rect, &flags, emit_depth, ref_id, w);
                    if node.ref_id.is_some() {
                        w.elems.push(el.clone());
                    }
                    w.nodes.push(node);
                    emitted = true;
                }
            }
            if depth < w.opts.max_depth && has_useful_children(ct) {
                if let Ok(upd) = unsafe { el.BuildUpdatedCache(&self.cache) } {
                    self.walk(&upd, depth + 1, emit_depth + usize::from(emitted), w);
                }
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn build_node(
        &self,
        el: &IUIAutomationElement,
        ct: i32,
        name: String,
        rect: Rect,
        flags: &PatternFlags,
        depth: usize,
        ref_id: Option<String>,
        w: &mut Walk,
    ) -> Node {
        let mut states: Vec<&'static str> = Vec::new();
        if flags.toggle {
            match cached_i32(el, UIA_ToggleToggleStatePropertyId) {
                Some(1) => states.push("checked"),
                Some(2) => states.push("indeterminate"),
                Some(_) => states.push("unchecked"),
                None => {}
            }
        }
        if flags.selection_item && cached_bool(el, UIA_SelectionItemIsSelectedPropertyId) {
            states.push("selected");
        }
        if flags.expand_collapse {
            match cached_i32(el, UIA_ExpandCollapseExpandCollapseStatePropertyId) {
                Some(0) => states.push("collapsed"),
                Some(1) => states.push("expanded"),
                _ => {}
            }
        }
        if !unsafe { el.CachedIsEnabled() }
            .map(|b| b.as_bool())
            .unwrap_or(true)
        {
            states.push("disabled");
        }
        if cached_bool(el, UIA_HasKeyboardFocusPropertyId) {
            states.push("focused");
        }
        let mut value = if flags.value {
            cached_string(el, UIA_ValueValuePropertyId)
        } else {
            None
        };
        let editable_text = matches!(ct, 50004 | 50030);
        if editable_text
            && value.as_deref().unwrap_or("").is_empty()
            && flags.text
            && w.text_reads < 8
        {
            w.text_reads += 1;
            value = read_text(el, 4000);
        }
        Node {
            depth,
            role: role_name(ct),
            name,
            auto_id: cached_string(el, UIA_AutomationIdPropertyId).unwrap_or_default(),
            ref_id,
            rect,
            value,
            states,
        }
    }

    // ------------------------------------------------------------- actions

    fn lookup(&self, r: &str) -> Result<(IUIAutomationElement, isize), ComputerError> {
        let (slot, idx) = parse_ref(r).ok_or_else(|| {
            ComputerError::Invalid(format!("`{r}` is not a valid ref (expected like w3e17)"))
        })?;
        let table = self.tables.get(&slot).ok_or_else(|| {
            ComputerError::NotFound(format!(
                "ref {r} is stale (that window was re-snapshotted); take a new computer_snapshot"
            ))
        })?;
        let el = table
            .elems
            .get(idx)
            .ok_or_else(|| ComputerError::NotFound(format!("ref {r} does not exist")))?;
        Ok((el.clone(), table.hwnd))
    }

    /// Fresh on-screen rect and owning top-level window of a ref.
    pub fn element_info(&self, r: &str) -> Result<(Rect, isize), ComputerError> {
        let (el, hwnd) = self.lookup(r)?;
        let rc = unsafe { el.CurrentBoundingRectangle() }
            .map_err(|_| ComputerError::NotFound(STALE.into()))?;
        Ok((Rect::from_ltrb(rc.left, rc.top, rc.right, rc.bottom), hwnd))
    }

    fn click_center(
        &self,
        el: &IUIAutomationElement,
        hwnd: isize,
        t: &InputTiming,
    ) -> Result<(), ComputerError> {
        let rc = unsafe { el.CurrentBoundingRectangle() }
            .map_err(|_| ComputerError::NotFound(STALE.into()))?;
        let rect = Rect::from_ltrb(rc.left, rc.top, rc.right, rc.bottom);
        if rect.is_empty() {
            return Err(ComputerError::Invalid(
                "element has no on-screen area".into(),
            ));
        }
        winapi::set_foreground(hwnd)?;
        let (x, y) = rect.center();
        input::click(x, y, MouseButton::Left, 1, &[], t)
    }

    pub fn act(
        &mut self,
        r: &str,
        action: ElementAction,
        value: Option<&str>,
        t: &InputTiming,
    ) -> Result<String, ComputerError> {
        let (el, hwnd) = self.lookup(r)?;
        let gone = |_e: windows::core::Error| ComputerError::NotFound(STALE.into());
        match action {
            ElementAction::Invoke => {
                if let Some(p) = pattern::<IUIAutomationInvokePattern>(&el, UIA_InvokePatternId) {
                    if unsafe { p.Invoke() }.is_ok() {
                        return Ok("invoked".into());
                    }
                }
                self.click_center(&el, hwnd, t)?;
                Ok("clicked element center (no InvokePattern)".into())
            }
            ElementAction::SetValue => {
                let text = value.ok_or_else(|| {
                    ComputerError::Invalid("`value` is required for set_value".into())
                })?;
                if let Some(p) = pattern::<IUIAutomationValuePattern>(&el, UIA_ValuePatternId) {
                    let writable = !unsafe { p.CurrentIsReadOnly() }
                        .map(|b| b.as_bool())
                        .unwrap_or(true);
                    if writable && unsafe { p.SetValue(&BSTR::from(text)) }.is_ok() {
                        return Ok("value set".into());
                    }
                }
                winapi::set_foreground(hwnd)?;
                unsafe { el.SetFocus() }.map_err(gone)?;
                std::thread::sleep(std::time::Duration::from_millis(60));
                input::press_keys(&[parse_chord("ctrl+a").map_err(ComputerError::Invalid)?], t)?;
                if text.is_empty() {
                    input::press_keys(
                        &[parse_chord("delete").map_err(ComputerError::Invalid)?],
                        t,
                    )?;
                } else {
                    input::type_text(text, t)?;
                }
                Ok("value set by typing (no writable ValuePattern)".into())
            }
            ElementAction::Toggle => {
                let p = pattern::<IUIAutomationTogglePattern>(&el, UIA_TogglePatternId)
                    .ok_or_else(|| ComputerError::Invalid("element is not toggleable".into()))?;
                unsafe { p.Toggle() }.map_err(|e| fail("toggle", e))?;
                let state = unsafe { p.CurrentToggleState() }.map(|s| s.0).unwrap_or(-1);
                Ok(format!(
                    "toggled; now {}",
                    match state {
                        1 => "checked",
                        2 => "indeterminate",
                        0 => "unchecked",
                        _ => "unknown",
                    }
                ))
            }
            ElementAction::Select => {
                let p =
                    pattern::<IUIAutomationSelectionItemPattern>(&el, UIA_SelectionItemPatternId)
                        .ok_or_else(|| ComputerError::Invalid("element is not selectable".into()))?;
                unsafe { p.Select() }.map_err(|e| fail("select", e))?;
                Ok("selected".into())
            }
            ElementAction::Expand | ElementAction::Collapse => {
                let p =
                    pattern::<IUIAutomationExpandCollapsePattern>(&el, UIA_ExpandCollapsePatternId)
                        .ok_or_else(|| {
                            ComputerError::Invalid("element cannot expand/collapse".into())
                        })?;
                if action == ElementAction::Expand {
                    unsafe { p.Expand() }.map_err(|e| fail("expand", e))?;
                    Ok("expanded".into())
                } else {
                    unsafe { p.Collapse() }.map_err(|e| fail("collapse", e))?;
                    Ok("collapsed".into())
                }
            }
            ElementAction::ScrollIntoView => {
                let p = pattern::<IUIAutomationScrollItemPattern>(&el, UIA_ScrollItemPatternId)
                    .ok_or_else(|| {
                        ComputerError::Invalid("element does not support scroll-into-view".into())
                    })?;
                unsafe { p.ScrollIntoView() }.map_err(|e| fail("scroll", e))?;
                Ok("scrolled into view".into())
            }
            ElementAction::Focus => {
                winapi::set_foreground(hwnd)?;
                unsafe { el.SetFocus() }.map_err(gone)?;
                Ok("focused".into())
            }
        }
    }
}

struct Walk<'a> {
    opts: &'a SnapshotOptions,
    slot: u32,
    nodes: Vec<Node>,
    elems: Vec<IUIAutomationElement>,
    visited: usize,
    truncated: bool,
    text_reads: usize,
}

fn read_text(el: &IUIAutomationElement, max: i32) -> Option<String> {
    let p = pattern::<IUIAutomationTextPattern>(el, UIA_TextPatternId)?;
    let range = unsafe { p.DocumentRange() }.ok()?;
    unsafe { range.GetText(max) }.ok().map(|b| b.to_string())
}
