//! Truthful Windows 11 desktop isolation, per-process audio/video capture, headless PTY,
//! and background browser automation capability matrix.
//!
//! Explicitly separates documented user-mode Windows APIs from undocumented internal COM GUIDs,
//! cross-desktop pointer hijacking (`OutOfScope`), and security/DRM boundary bypasses (`Forbidden`).

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{json, Value};
use std::str::FromStr;

/// Schema version identifier for [`DesktopCapabilityMatrix`] JSON exports.
pub const DESKTOP_ISOLATION_SCHEMA_VERSION: &str = "omnia.desktop-isolation-matrix.v1";

/// Classification of whether an isolation or automation surface is supported, undocumented,
/// out of scope, or strictly forbidden.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum IsolationSurfaceSupport {
    /// Documented, supported Windows user-mode API contract.
    DocumentedUserMode,
    /// Relies on undocumented private COM GUIDs or OS-unsupported foreign-process mutations.
    UnsupportedOrUndocumented,
    /// Explicitly excluded from Omnia desktop automation to protect user desktop isolation.
    OutOfScope,
    /// Security boundary, privilege escalation, kernel/DSE, or DRM protection bypass (never permitted).
    Forbidden,
}

impl IsolationSurfaceSupport {
    /// Returns the canonical wire tag for this support classification.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::DocumentedUserMode => "documented_user_mode",
            Self::UnsupportedOrUndocumented => "unsupported_or_undocumented",
            Self::OutOfScope => "out_of_scope",
            Self::Forbidden => "forbidden",
        }
    }

    /// Returns `true` strictly for documented user-mode APIs.
    pub const fn is_permitted(self) -> bool {
        matches!(self, Self::DocumentedUserMode)
    }
}

impl FromStr for IsolationSurfaceSupport {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "documented_user_mode" => Ok(Self::DocumentedUserMode),
            "unsupported_or_undocumented" => Ok(Self::UnsupportedOrUndocumented),
            "out_of_scope" => Ok(Self::OutOfScope),
            "forbidden" => Ok(Self::Forbidden),
            other => Err(format!("unknown isolation surface support: {other}")),
        }
    }
}

impl Serialize for IsolationSurfaceSupport {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for IsolationSurfaceSupport {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        Self::from_str(&raw).map_err(serde::de::Error::custom)
    }
}

/// Functional domain of an isolation capability entry.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum IsolationDomain {
    VirtualDesktop,
    WindowCapture,
    AudioLoopback,
    TerminalPty,
    BrowserAutomation,
    InputIsolation,
    SecurityBoundary,
}

impl IsolationDomain {
    /// Returns the canonical `snake_case` domain identifier.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::VirtualDesktop => "virtual_desktop",
            Self::WindowCapture => "window_capture",
            Self::AudioLoopback => "audio_loopback",
            Self::TerminalPty => "terminal_pty",
            Self::BrowserAutomation => "browser_automation",
            Self::InputIsolation => "input_isolation",
            Self::SecurityBoundary => "security_boundary",
        }
    }
}

impl FromStr for IsolationDomain {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "virtual_desktop" => Ok(Self::VirtualDesktop),
            "window_capture" => Ok(Self::WindowCapture),
            "audio_loopback" => Ok(Self::AudioLoopback),
            "terminal_pty" => Ok(Self::TerminalPty),
            "browser_automation" => Ok(Self::BrowserAutomation),
            "input_isolation" => Ok(Self::InputIsolation),
            "security_boundary" => Ok(Self::SecurityBoundary),
            other => Err(format!("unknown isolation domain: {other}")),
        }
    }
}

impl Serialize for IsolationDomain {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for IsolationDomain {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        Self::from_str(&raw).map_err(serde::de::Error::custom)
    }
}

/// Single entry inside [`DesktopCapabilityMatrix`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DesktopIsolationCapability {
    /// Stable entry identifier.
    pub id: String,
    /// Functional isolation domain.
    pub domain: IsolationDomain,
    /// Concise human-readable capability title.
    pub title: String,
    /// Exact Windows COM, WinRT, Win32, or protocol API surface.
    pub api_surface: String,
    /// Minimum Windows version or protocol requirement.
    pub min_os: String,
    /// Truthful support classification.
    pub support: IsolationSurfaceSupport,
    /// True strictly when backed by official public Microsoft/W3C documentation.
    pub documented: bool,
    /// True when the API operates strictly on calling-process-owned windows/resources.
    pub same_process_only: bool,
    /// True if the surface would require elevated/system privilege (always disallowed for user-mode).
    pub requires_elevation: bool,
    /// True strictly when a documented user-mode surface was actively verified at runtime.
    pub source_verified: bool,
    /// Technical explanation of guarantees, constraints, or why the surface is restricted.
    pub detail: String,
    /// Recommended safe user-mode alternative when the entry is restricted or out of scope.
    pub safe_alternative: Option<String>,
}

impl DesktopIsolationCapability {
    /// Returns `true` strictly when the surface is `DocumentedUserMode`.
    pub const fn is_permitted(&self) -> bool {
        self.support.is_permitted()
    }
}

impl Serialize for DesktopIsolationCapability {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        json!({
            "id": self.id,
            "domain": self.domain,
            "title": self.title,
            "api_surface": self.api_surface,
            "min_os": self.min_os,
            "support": self.support,
            "documented": self.documented,
            "same_process_only": self.same_process_only,
            "requires_elevation": self.requires_elevation,
            "source_verified": self.source_verified,
            "detail": self.detail,
            "safe_alternative": self.safe_alternative,
        })
        .serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for DesktopIsolationCapability {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let val = Value::deserialize(deserializer)?;
        let obj = val.as_object().ok_or_else(|| {
            serde::de::Error::custom("DesktopIsolationCapability must be a JSON object")
        })?;
        let req_str = |k: &str| -> Result<String, D::Error> {
            obj.get(k)
                .and_then(Value::as_str)
                .map(ToString::to_string)
                .ok_or_else(|| serde::de::Error::custom(format!("missing string `{k}`")))
        };
        let req_bool = |k: &str| -> Result<bool, D::Error> {
            obj.get(k)
                .and_then(Value::as_bool)
                .ok_or_else(|| serde::de::Error::custom(format!("missing bool `{k}`")))
        };
        let domain: IsolationDomain = serde_json::from_value(
            obj.get("domain")
                .cloned()
                .ok_or_else(|| serde::de::Error::custom("missing domain"))?,
        )
        .map_err(serde::de::Error::custom)?;
        let support: IsolationSurfaceSupport = serde_json::from_value(
            obj.get("support")
                .cloned()
                .ok_or_else(|| serde::de::Error::custom("missing support"))?,
        )
        .map_err(serde::de::Error::custom)?;
        let safe_alternative = match obj.get("safe_alternative") {
            None | Some(Value::Null) => None,
            Some(Value::String(s)) => Some(s.clone()),
            _ => {
                return Err(serde::de::Error::custom(
                    "safe_alternative must be string or null",
                ))
            }
        };

        let raw_verified = req_bool("source_verified")?;
        // Non-documented or restricted surfaces can never carry `source_verified == true`.
        let source_verified = raw_verified && support.is_permitted();

        Ok(Self {
            id: req_str("id")?,
            domain,
            title: req_str("title")?,
            api_surface: req_str("api_surface")?,
            min_os: req_str("min_os")?,
            support,
            documented: req_bool("documented")?,
            same_process_only: req_bool("same_process_only")?,
            requires_elevation: req_bool("requires_elevation")?,
            source_verified,
            detail: req_str("detail")?,
            safe_alternative,
        })
    }
}

/// Truthful Windows 11 desktop isolation, per-process AV capture, ConPTY, and browser bridge
/// capability catalog.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DesktopCapabilityMatrix {
    /// Versioned schema identifier (`omnia.desktop-isolation-matrix.v1`).
    pub schema_version: String,
    /// Target platform scope (`windows-11-user-mode`).
    pub platform: String,
    /// Ordered list of documented and explicitly restricted/out-of-scope capability entries.
    pub capabilities: Vec<DesktopIsolationCapability>,
}

impl Default for DesktopCapabilityMatrix {
    fn default() -> Self {
        Self::windows_11_truthful_default()
    }
}

impl DesktopCapabilityMatrix {
    /// Returns the baseline Windows 11 truthful capability matrix with `source_verified = false`
    /// across all entries until runtime probe verification updates individual documented surfaces.
    pub fn windows_11_truthful_default() -> Self {
        Self {
            schema_version: DESKTOP_ISOLATION_SCHEMA_VERSION.to_string(),
            platform: "windows-11-user-mode".to_string(),
            capabilities: vec![
                DesktopIsolationCapability {
                    id: "virtual_desktop_same_process".to_string(),
                    domain: IsolationDomain::VirtualDesktop,
                    title: "IVirtualDesktopManager (Same-Process Window Placement & Query)".to_string(),
                    api_surface: "IVirtualDesktopManager::{MoveWindowToDesktop, IsWindowOnCurrentVirtualDesktop, GetWindowDesktopId}".to_string(),
                    min_os: "Windows 10 1507+ / Windows 11".to_string(),
                    support: IsolationSurfaceSupport::DocumentedUserMode,
                    documented: true,
                    same_process_only: true,
                    requires_elevation: false,
                    source_verified: false,
                    detail: "Official ShObjIdl COM contract; MoveWindowToDesktop is strictly documented for windows owned by the calling process, while IsWindowOnCurrentVirtualDesktop and GetWindowDesktopId query window desktop state.".to_string(),
                    safe_alternative: None,
                },
                DesktopIsolationCapability {
                    id: "windows_graphics_capture".to_string(),
                    domain: IsolationDomain::WindowCapture,
                    title: "Windows.Graphics.Capture (Per-HWND/Monitor Border & Cursor Controls)".to_string(),
                    api_surface: "Windows.Graphics.Capture::{GraphicsCaptureItem, GraphicsCaptureSession::IsBorderRequired, GraphicsCaptureSession::IsCursorCaptureEnabled}".to_string(),
                    min_os: "Windows 10 1903+ (IsCursorCaptureEnabled 2004+, IsBorderRequired 2104+ / Windows 11)".to_string(),
                    support: IsolationSurfaceSupport::DocumentedUserMode,
                    documented: true,
                    same_process_only: false,
                    requires_elevation: false,
                    source_verified: false,
                    detail: "Documented WinRT capture API capable of capturing non-minimized target windows without stealing physical pointer focus, with explicit capability checks before toggling IsBorderRequired or IsCursorCaptureEnabled.".to_string(),
                    safe_alternative: None,
                },
                DesktopIsolationCapability {
                    id: "wasapi_process_loopback".to_string(),
                    domain: IsolationDomain::AudioLoopback,
                    title: "WASAPI Per-Process Audio Loopback Isolation".to_string(),
                    api_surface: "ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS)".to_string(),
                    min_os: "Windows 10 Build 20348+ / Windows 11".to_string(),
                    support: IsolationSurfaceSupport::DocumentedUserMode,
                    documented: true,
                    same_process_only: false,
                    requires_elevation: false,
                    source_verified: false,
                    detail: "Official user-mode WASAPI activation path capturing or excluding audio for a targeted process tree without virtual audio driver installation.".to_string(),
                    safe_alternative: None,
                },
                DesktopIsolationCapability {
                    id: "conpty_headless_terminal".to_string(),
                    domain: IsolationDomain::TerminalPty,
                    title: "ConPTY Isolated Pseudo-Console Sessions".to_string(),
                    api_surface: "kernel32::{CreatePseudoConsole, ResizePseudoConsole, ClosePseudoConsole}".to_string(),
                    min_os: "Windows 10 1809+ / Windows 11".to_string(),
                    support: IsolationSurfaceSupport::DocumentedUserMode,
                    documented: true,
                    same_process_only: false,
                    requires_elevation: false,
                    source_verified: false,
                    detail: "Documented headless pseudo-console host isolating interactive CLI/agent terminals from the user's active desktop focus and console windows.".to_string(),
                    safe_alternative: None,
                },
                DesktopIsolationCapability {
                    id: "browser_cdp_and_webdriver_bidi".to_string(),
                    domain: IsolationDomain::BrowserAutomation,
                    title: "Chrome/Edge CDP & WebDriver BiDi Background Browser Bridge".to_string(),
                    api_surface: "Loopback Chrome DevTools Protocol (CDP /json/version, /json/list, WebSocket) & W3C WebDriver BiDi".to_string(),
                    min_os: "Windows 10 / Windows 11 (Edge/Chromium loopback)".to_string(),
                    support: IsolationSurfaceSupport::DocumentedUserMode,
                    documented: true,
                    same_process_only: false,
                    requires_elevation: false,
                    source_verified: false,
                    detail: "Provides deterministic background tab DOM inspection, Fetch/Network interception, and synthetic input without focus theft, directly resolving Codex Windows Chrome IUIAutomation gaps.".to_string(),
                    safe_alternative: None,
                },
                DesktopIsolationCapability {
                    id: "virtual_desktop_foreign_process_undocumented".to_string(),
                    domain: IsolationDomain::VirtualDesktop,
                    title: "Foreign-Process MoveWindowToDesktop via Undocumented Internal COM GUIDs".to_string(),
                    api_surface: "Undocumented IVirtualDesktopManagerInternal / IApplicationViewCollection private shell COM GUIDs".to_string(),
                    min_os: "Unstable across Windows 11 Insider/22H2/23H2/24H2 builds".to_string(),
                    support: IsolationSurfaceSupport::UnsupportedOrUndocumented,
                    documented: false,
                    same_process_only: false,
                    requires_elevation: false,
                    source_verified: false,
                    detail: "Microsoft explicitly limits documented IVirtualDesktopManager::MoveWindowToDesktop to same-process windows; private explorer shell IIDs break unpredictably across Windows 11 updates and are not used.".to_string(),
                    safe_alternative: Some("virtual_desktop_same_process, conpty_headless_terminal, or browser_cdp_and_webdriver_bidi".to_string()),
                },
                DesktopIsolationCapability {
                    id: "physical_cursor_stealing_cross_desktop".to_string(),
                    domain: IsolationDomain::InputIsolation,
                    title: "Physical Cursor Stealing Across Win+Tab Virtual Desktops".to_string(),
                    api_surface: "Global SetCursorPos / SendInput across active Win+Tab virtual desktops".to_string(),
                    min_os: "N/A".to_string(),
                    support: IsolationSurfaceSupport::OutOfScope,
                    documented: false,
                    same_process_only: false,
                    requires_elevation: false,
                    source_verified: false,
                    detail: "Hijacking the shared physical mouse cursor or desktop focus across Win+Tab virtual desktops disrupts the user session and violates Omnia low-disruption isolation.".to_string(),
                    safe_alternative: Some("browser_cdp_and_webdriver_bidi or scoped background process control".to_string()),
                },
                DesktopIsolationCapability {
                    id: "setcb_privilege_and_uipi_bypass".to_string(),
                    domain: IsolationDomain::SecurityBoundary,
                    title: "SeTcbPrivilege Elevation & UIPI Cross-Integrity Bypass".to_string(),
                    api_surface: "SeTcbPrivilege token elevation / uiAccess=true spoofing / UIPI message filter bypass".to_string(),
                    min_os: "N/A".to_string(),
                    support: IsolationSurfaceSupport::Forbidden,
                    documented: false,
                    same_process_only: false,
                    requires_elevation: true,
                    source_verified: false,
                    detail: "Bypassing User Interface Privilege Isolation (UIPI) or acquiring SeTcbPrivilege violates OS privilege boundaries and is strictly forbidden.".to_string(),
                    safe_alternative: Some("Run within standard Medium-IL user boundaries using documented per-process APIs".to_string()),
                },
                DesktopIsolationCapability {
                    id: "unsigned_kernel_driver_injection".to_string(),
                    domain: IsolationDomain::SecurityBoundary,
                    title: "Unsigned Kernel Driver / DSE Bypass Input or Capture Hooks".to_string(),
                    api_surface: "Unsigned .sys kernel filter drivers or Driver Signature Enforcement bypass".to_string(),
                    min_os: "N/A".to_string(),
                    support: IsolationSurfaceSupport::Forbidden,
                    documented: false,
                    same_process_only: false,
                    requires_elevation: true,
                    source_verified: false,
                    detail: "Unsigned kernel drivers, kernel hooking, and DSE bypasses undermine Windows security integrity and are strictly forbidden.".to_string(),
                    safe_alternative: Some("windows_graphics_capture and documented HID/WM_INPUT user-mode registration".to_string()),
                },
                DesktopIsolationCapability {
                    id: "drm_and_flag_secure_bypass".to_string(),
                    domain: IsolationDomain::SecurityBoundary,
                    title: "DRM Protected Media Path / WDA_EXCLUDEFROMCAPTURE / FLAG_SECURE Bypass".to_string(),
                    api_surface: "SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE) / Protected Media Path / HDCP / FLAG_SECURE circumvention".to_string(),
                    min_os: "N/A".to_string(),
                    support: IsolationSurfaceSupport::Forbidden,
                    documented: false,
                    same_process_only: false,
                    requires_elevation: false,
                    source_verified: false,
                    detail: "Attempting to bypass DRM content protection, WDA_EXCLUDEFROMCAPTURE, or FLAG_SECURE display-affinity guarantees is strictly forbidden.".to_string(),
                    safe_alternative: Some("Respect OS display affinity and mark DRM-protected capture targets as Blocked".to_string()),
                },
            ],
        }
    }

    /// Looks up an entry by stable identifier `id`.
    pub fn get(&self, id: &str) -> Option<&DesktopIsolationCapability> {
        self.capabilities.iter().find(|entry| entry.id == id)
    }

    /// Returns `true` strictly when `id` exists and is classified as `DocumentedUserMode`.
    pub fn is_permitted(&self, id: &str) -> bool {
        self.get(id).is_some_and(|entry| entry.is_permitted())
    }

    /// Returns all entries backed by documented user-mode APIs.
    pub fn documented_user_mode_entries(&self) -> Vec<&DesktopIsolationCapability> {
        self.capabilities
            .iter()
            .filter(|entry| entry.support == IsolationSurfaceSupport::DocumentedUserMode)
            .collect()
    }

    /// Returns all entries marked `UnsupportedOrUndocumented`, `OutOfScope`, or `Forbidden`.
    pub fn restricted_entries(&self) -> Vec<&DesktopIsolationCapability> {
        self.capabilities
            .iter()
            .filter(|entry| !entry.support.is_permitted())
            .collect()
    }

    /// Records a runtime verification observation for `id`.
    ///
    /// Returns `false` and keeps `source_verified == false` if `id` is unknown or not
    /// classified as `DocumentedUserMode`.
    pub fn record_runtime_verification(
        &mut self,
        id: &str,
        verified_available: bool,
        note: impl Into<String>,
    ) -> bool {
        let Some(entry) = self.capabilities.iter_mut().find(|c| c.id == id) else {
            return false;
        };
        if !entry.support.is_permitted() {
            entry.source_verified = false;
            return false;
        }
        entry.source_verified = verified_available;
        let note_str = note.into();
        if !note_str.trim().is_empty() {
            entry.detail = note_str;
        }
        verified_available
    }

    /// Exports the full capability matrix plus summary counts as a [`serde_json::Value`].
    pub fn to_json(&self) -> Value {
        let documented_count = self.documented_user_mode_entries().len();
        let restricted_count = self.restricted_entries().len();
        let verified_count = self
            .capabilities
            .iter()
            .filter(|c| c.source_verified && c.support.is_permitted())
            .count();
        json!({
            "schema_version": self.schema_version,
            "platform": self.platform,
            "summary": {
                "total": self.capabilities.len(),
                "documented_user_mode": documented_count,
                "restricted_or_forbidden": restricted_count,
                "source_verified": verified_count,
            },
            "capabilities": self.capabilities,
        })
    }
}

impl Serialize for DesktopCapabilityMatrix {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.to_json().serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for DesktopCapabilityMatrix {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let val = Value::deserialize(deserializer)?;
        let obj = val.as_object().ok_or_else(|| {
            serde::de::Error::custom("DesktopCapabilityMatrix must be a JSON object")
        })?;
        let schema_version = obj
            .get("schema_version")
            .and_then(Value::as_str)
            .ok_or_else(|| serde::de::Error::custom("missing schema_version"))?
            .to_string();
        let platform = obj
            .get("platform")
            .and_then(Value::as_str)
            .ok_or_else(|| serde::de::Error::custom("missing platform"))?
            .to_string();
        let caps_val = obj
            .get("capabilities")
            .cloned()
            .ok_or_else(|| serde::de::Error::custom("missing capabilities array"))?;
        let capabilities: Vec<DesktopIsolationCapability> =
            serde_json::from_value(caps_val).map_err(serde::de::Error::custom)?;
        Ok(Self {
            schema_version,
            platform,
            capabilities,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_matrix_separates_documented_user_mode_apis_from_restricted_surfaces() {
        let matrix = DesktopCapabilityMatrix::windows_11_truthful_default();
        assert_eq!(matrix.schema_version, DESKTOP_ISOLATION_SCHEMA_VERSION);
        assert_eq!(matrix.documented_user_mode_entries().len(), 5);
        assert_eq!(matrix.restricted_entries().len(), 5);

        // Every entry starts unverified until observed at runtime.
        assert!(matrix.capabilities.iter().all(|c| !c.source_verified));

        // Documented user-mode entries.
        for id in [
            "virtual_desktop_same_process",
            "windows_graphics_capture",
            "wasapi_process_loopback",
            "conpty_headless_terminal",
            "browser_cdp_and_webdriver_bidi",
        ] {
            let entry = matrix.get(id).expect(id);
            assert_eq!(entry.support, IsolationSurfaceSupport::DocumentedUserMode);
            assert!(entry.documented);
            assert!(!entry.requires_elevation);
            assert!(matrix.is_permitted(id));
        }

        // Same-process restriction explicitly documented on IVirtualDesktopManager.
        let vdm_same = matrix.get("virtual_desktop_same_process").unwrap();
        assert!(vdm_same.same_process_only);
        assert!(vdm_same.api_surface.contains("MoveWindowToDesktop"));
        assert!(vdm_same
            .api_surface
            .contains("IsWindowOnCurrentVirtualDesktop"));
        assert!(vdm_same.api_surface.contains("GetWindowDesktopId"));

        // WGC, WASAPI 20348+, ConPTY, and CDP/WebDriver BiDi Chrome IUIAutomation gap details.
        let wgc = matrix.get("windows_graphics_capture").unwrap();
        assert!(wgc.api_surface.contains("IsBorderRequired"));
        assert!(wgc.api_surface.contains("IsCursorCaptureEnabled"));

        let wasapi = matrix.get("wasapi_process_loopback").unwrap();
        assert!(wasapi
            .api_surface
            .contains("VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK"));
        assert!(wasapi.min_os.contains("20348"));

        let browser = matrix.get("browser_cdp_and_webdriver_bidi").unwrap();
        assert!(browser.detail.contains("IUIAutomation"));

        // Unsupported / OutOfScope / Forbidden entries.
        let vdm_foreign = matrix
            .get("virtual_desktop_foreign_process_undocumented")
            .unwrap();
        assert_eq!(
            vdm_foreign.support,
            IsolationSurfaceSupport::UnsupportedOrUndocumented
        );
        assert!(!vdm_foreign.documented);
        assert!(!matrix.is_permitted("virtual_desktop_foreign_process_undocumented"));

        let cursor_steal = matrix
            .get("physical_cursor_stealing_cross_desktop")
            .unwrap();
        assert_eq!(cursor_steal.support, IsolationSurfaceSupport::OutOfScope);
        assert!(!matrix.is_permitted("physical_cursor_stealing_cross_desktop"));

        for forbidden_id in [
            "setcb_privilege_and_uipi_bypass",
            "unsigned_kernel_driver_injection",
            "drm_and_flag_secure_bypass",
        ] {
            let entry = matrix.get(forbidden_id).expect(forbidden_id);
            assert_eq!(entry.support, IsolationSurfaceSupport::Forbidden);
            assert!(!entry.documented);
            assert!(!matrix.is_permitted(forbidden_id));
        }

        let exported = matrix.to_json();
        assert_eq!(exported["summary"]["documented_user_mode"], 5);
        assert_eq!(exported["summary"]["restricted_or_forbidden"], 5);
        assert_eq!(exported["summary"]["source_verified"], 0);
    }

    #[test]
    fn matrix_blocks_runtime_verification_on_forbidden_and_neutralizes_forged_json() {
        let mut matrix = DesktopCapabilityMatrix::windows_11_truthful_default();
        assert!(!matrix.record_runtime_verification(
            "drm_and_flag_secure_bypass",
            true,
            "attempted bypass"
        ));
        assert!(
            !matrix
                .get("drm_and_flag_secure_bypass")
                .unwrap()
                .source_verified
        );

        assert!(matrix.record_runtime_verification(
            "conpty_headless_terminal",
            true,
            "CreatePseudoConsole smoke verified on Windows 11"
        ));
        assert!(
            matrix
                .get("conpty_headless_terminal")
                .unwrap()
                .source_verified
        );

        // Deserializing a forged `source_verified: true` on a forbidden entry must sanitize it.
        let mut raw_json = matrix.to_json();
        let caps = raw_json["capabilities"].as_array_mut().unwrap();
        for item in caps.iter_mut() {
            if item["id"] == "setcb_privilege_and_uipi_bypass" {
                item["source_verified"] = json!(true);
            }
        }
        let decoded: DesktopCapabilityMatrix = serde_json::from_value(raw_json).unwrap();
        assert!(
            !decoded
                .get("setcb_privilege_and_uipi_bypass")
                .unwrap()
                .source_verified
        );
        assert!(
            decoded
                .get("conpty_headless_terminal")
                .unwrap()
                .source_verified
        );
    }
}
