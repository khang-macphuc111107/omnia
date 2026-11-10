//! Device, user-agent and media-feature emulation over CDP `Emulation.*`.

use serde_json::{json, Value};

use crate::error::{BrowserError, Result};
use crate::tab::Tab;

/// Names accepted as presets (matching ignores case, spaces and dashes).
pub const PRESET_NAMES: [&str; 3] = ["iPhone 15", "Pixel 8", "iPad"];

#[derive(Debug, Clone, PartialEq)]
pub struct DeviceProfile {
    pub width: u32,
    pub height: u32,
    pub dpr: f64,
    pub mobile: bool,
    pub user_agent: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColorScheme {
    Light,
    Dark,
}

impl ColorScheme {
    pub fn as_str(self) -> &'static str {
        match self {
            ColorScheme::Light => "light",
            ColorScheme::Dark => "dark",
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct EmulationRequest {
    pub device: Option<DeviceProfile>,
    pub color_scheme: Option<ColorScheme>,
    pub reduced_motion: Option<bool>,
    /// Clear every override first (and apply the rest, if any, afterwards).
    pub reset: bool,
}

const UA_IPHONE: &str = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const UA_PIXEL: &str = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";
const UA_IPAD: &str = "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

fn normalize(name: &str) -> String {
    name.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_lowercase())
        .collect()
}

/// Looks up a device preset by name; returns its canonical name too.
pub fn preset(name: &str) -> Option<(&'static str, DeviceProfile)> {
    let profile = |width, height, dpr, ua: &str| DeviceProfile {
        width,
        height,
        dpr,
        mobile: true,
        user_agent: Some(ua.to_string()),
    };
    match normalize(name).as_str() {
        "iphone15" | "iphone" => Some(("iPhone 15", profile(393, 852, 3.0, UA_IPHONE))),
        "pixel8" | "pixel" => Some(("Pixel 8", profile(412, 915, 2.625, UA_PIXEL))),
        "ipad" => Some(("iPad", profile(820, 1180, 2.0, UA_IPAD))),
        _ => None,
    }
}

/// Parses the `device` argument: a preset name or `{width,height,dpr,mobile,user_agent}`.
pub fn parse_device(value: &Value) -> std::result::Result<DeviceProfile, String> {
    match value {
        Value::String(name) => preset(name).map(|(_, p)| p).ok_or_else(|| {
            format!(
                "unknown device preset `{name}` (available: {}; or pass {{width,height,dpr,mobile,user_agent}})",
                PRESET_NAMES.join(", ")
            )
        }),
        Value::Object(map) => {
            let dimension = |key: &str| -> std::result::Result<u32, String> {
                let n = map
                    .get(key)
                    .and_then(Value::as_u64)
                    .ok_or_else(|| format!("device.{key} is required (integer)"))?;
                if !(50..=10_000).contains(&n) {
                    return Err(format!("device.{key} must be between 50 and 10000"));
                }
                Ok(n as u32)
            };
            let dpr = match map.get("dpr") {
                None | Some(Value::Null) => 1.0,
                Some(v) => v.as_f64().ok_or("device.dpr must be a number")?,
            };
            if !(0.5..=8.0).contains(&dpr) {
                return Err("device.dpr must be between 0.5 and 8".into());
            }
            let user_agent = match map.get("user_agent") {
                None | Some(Value::Null) => None,
                Some(Value::String(ua)) if ua.trim().is_empty() => None,
                Some(Value::String(ua)) => Some(ua.clone()),
                Some(_) => return Err("device.user_agent must be a string".into()),
            };
            Ok(DeviceProfile {
                width: dimension("width")?,
                height: dimension("height")?,
                dpr,
                mobile: map.get("mobile").and_then(Value::as_bool).unwrap_or(false),
                user_agent,
            })
        }
        _ => Err("`device` must be a preset name or an object {width,height,dpr,mobile,user_agent}".into()),
    }
}

impl Tab {
    /// Applies (or resets) emulation on this tab; returns what was done.
    pub async fn emulate(&self, request: &EmulationRequest) -> Result<Vec<String>> {
        let mut done = Vec::new();
        if request.reset {
            self.send("Emulation.clearDeviceMetricsOverride", json!({}))
                .await?;
            // An empty user agent restores the browser default.
            self.send("Emulation.setUserAgentOverride", json!({"userAgent": ""}))
                .await?;
            self.send(
                "Emulation.setTouchEmulationEnabled",
                json!({"enabled": false}),
            )
            .await?;
            self.send(
                "Emulation.setEmulatedMedia",
                json!({"media": "", "features": []}),
            )
            .await?;
            done.push("cleared all emulation overrides".to_string());
        }
        if let Some(device) = &request.device {
            let landscape = device.width > device.height;
            self.send(
                "Emulation.setDeviceMetricsOverride",
                json!({
                    "width": device.width,
                    "height": device.height,
                    "deviceScaleFactor": device.dpr,
                    "mobile": device.mobile,
                    "screenWidth": device.width,
                    "screenHeight": device.height,
                    "screenOrientation": if landscape {
                        json!({"type": "landscapePrimary", "angle": 90})
                    } else {
                        json!({"type": "portraitPrimary", "angle": 0})
                    },
                }),
            )
            .await?;
            self.send(
                "Emulation.setTouchEmulationEnabled",
                json!({"enabled": device.mobile, "maxTouchPoints": if device.mobile { 5 } else { 1 }}),
            )
            .await?;
            if let Some(ua) = &device.user_agent {
                self.send("Emulation.setUserAgentOverride", json!({"userAgent": ua}))
                    .await?;
            }
            done.push(format!(
                "viewport {}x{} @{}x{}{}",
                device.width,
                device.height,
                device.dpr,
                if device.mobile {
                    ", mobile + touch"
                } else {
                    ""
                },
                if device.user_agent.is_some() {
                    ", custom user agent"
                } else {
                    ""
                }
            ));
        }
        let mut features = Vec::new();
        if let Some(scheme) = request.color_scheme {
            features.push(json!({"name": "prefers-color-scheme", "value": scheme.as_str()}));
            done.push(format!("prefers-color-scheme: {}", scheme.as_str()));
        }
        if let Some(reduced) = request.reduced_motion {
            let value = if reduced { "reduce" } else { "no-preference" };
            features.push(json!({"name": "prefers-reduced-motion", "value": value}));
            done.push(format!("prefers-reduced-motion: {value}"));
        }
        if !features.is_empty() {
            self.send("Emulation.setEmulatedMedia", json!({"features": features}))
                .await?;
        }
        if done.is_empty() {
            return Err(BrowserError::Invalid(
                "nothing to emulate: give `device`, `color_scheme`, `reduced_motion` or `reset`"
                    .into(),
            ));
        }
        Ok(done)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn presets_match_loosely() {
        for name in ["iPhone 15", "iphone-15", "IPHONE15", "iphone"] {
            assert_eq!(preset(name).unwrap().0, "iPhone 15", "{name}");
        }
        let (_, pixel) = preset("Pixel 8").unwrap();
        assert_eq!(
            (pixel.width, pixel.height, pixel.dpr, pixel.mobile),
            (412, 915, 2.625, true)
        );
        assert!(preset("ipad")
            .unwrap()
            .1
            .user_agent
            .unwrap()
            .contains("iPad"));
        assert!(preset("nokia 3310").is_none());
        for name in PRESET_NAMES {
            assert!(preset(name).is_some(), "{name}");
        }
    }

    #[test]
    fn parses_device_values() {
        assert_eq!(parse_device(&json!("iPad")).unwrap().width, 820);
        let custom = parse_device(
            &json!({"width": 600, "height": 800, "dpr": 1.5, "mobile": true, "user_agent": "X/1"}),
        )
        .unwrap();
        assert_eq!(
            custom,
            DeviceProfile {
                width: 600,
                height: 800,
                dpr: 1.5,
                mobile: true,
                user_agent: Some("X/1".into())
            }
        );
        let minimal = parse_device(&json!({"width": 1024, "height": 768})).unwrap();
        assert_eq!(
            (minimal.dpr, minimal.mobile, minimal.user_agent),
            (1.0, false, None)
        );
        assert!(parse_device(&json!("unknown"))
            .unwrap_err()
            .contains("iPhone 15"));
        assert!(parse_device(&json!({"width": 600})).is_err());
        assert!(parse_device(&json!({"width": 5, "height": 800})).is_err());
        assert!(parse_device(&json!({"width": 600, "height": 800, "dpr": 40})).is_err());
        assert!(parse_device(&json!(3)).is_err());
    }
}
