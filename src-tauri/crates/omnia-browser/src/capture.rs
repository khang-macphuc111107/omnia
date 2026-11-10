//! Screenshots, PDF export and in-page blob reading.

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde_json::{json, Value};

use crate::error::{BrowserError, Result};
use crate::input::Target;
use crate::tab::Tab;

/// Longest page height (CSS px) captured in a full-page screenshot.
const MAX_FULL_PAGE_HEIGHT: f64 = 16_000.0;
/// Raw bytes per blob chunk; base64 of this stays under 1 MB.
const BLOB_CHUNK: usize = 786_432;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageFormat {
    Png,
    Jpeg,
}

#[derive(Debug, Clone)]
pub struct ScreenshotOptions {
    pub format: ImageFormat,
    /// JPEG quality 1-100.
    pub quality: u8,
    pub full_page: bool,
    /// Capture just this element.
    pub target: Option<Target>,
    /// Downscale so the longer side is at most this many pixels.
    pub max_dimension: Option<u32>,
}

impl Default for ScreenshotOptions {
    fn default() -> Self {
        Self {
            format: ImageFormat::Png,
            quality: 70,
            full_page: false,
            target: None,
            max_dimension: None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct Screenshot {
    pub data: Vec<u8>,
    pub mime: &'static str,
    pub width: u32,
    pub height: u32,
}

/// Reads width/height from PNG or JPEG bytes.
pub fn image_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() > 24 && bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        let w = u32::from_be_bytes(bytes[16..20].try_into().ok()?);
        let h = u32::from_be_bytes(bytes[20..24].try_into().ok()?);
        return Some((w, h));
    }
    if bytes.starts_with(&[0xFF, 0xD8]) {
        let mut i = 2;
        while i + 9 < bytes.len() {
            if bytes[i] != 0xFF {
                i += 1;
                continue;
            }
            let marker = bytes[i + 1];
            if (0xC0..=0xCF).contains(&marker) && !matches!(marker, 0xC4 | 0xC8 | 0xCC) {
                let h = u16::from_be_bytes([bytes[i + 5], bytes[i + 6]]) as u32;
                let w = u16::from_be_bytes([bytes[i + 7], bytes[i + 8]]) as u32;
                return Some((w, h));
            }
            if marker == 0xD8 || marker == 0x01 || (0xD0..=0xD7).contains(&marker) || marker == 0xFF
            {
                i += if marker == 0xFF { 1 } else { 2 };
                continue;
            }
            let len = u16::from_be_bytes([bytes[i + 2], bytes[i + 3]]) as usize;
            i += 2 + len;
        }
    }
    None
}

/// Scale factor so the longer side of `width`x`height` device px fits `max`.
pub fn fit_scale(width: f64, height: f64, max: Option<u32>) -> f64 {
    match max {
        Some(max) if width.max(height) > 0.0 => (max as f64 / width.max(height)).min(1.0),
        _ => 1.0,
    }
}

impl Tab {
    pub async fn screenshot(&self, options: &ScreenshotOptions) -> Result<Screenshot> {
        let metrics = self.send("Page.getLayoutMetrics", json!({})).await?;
        let viewport = metrics
            .get("cssVisualViewport")
            .or_else(|| metrics.get("visualViewport"))
            .cloned()
            .unwrap_or(Value::Null);
        let content = metrics
            .get("cssContentSize")
            .or_else(|| metrics.get("contentSize"))
            .cloned()
            .unwrap_or(Value::Null);
        let dpr = self
            .evaluate("window.devicePixelRatio")
            .await
            .ok()
            .and_then(|v| v.as_f64())
            .filter(|d| *d > 0.0)
            .unwrap_or(1.0);

        // Region in CSS pixels, document coordinates.
        let (x, y, w, h, beyond) = if let Some(target) = &options.target {
            let b = self.locate(target).await?;
            if matches!(target, Target::Point(..)) {
                return Err(BrowserError::Invalid(
                    "screenshot target must be a ref or selector".into(),
                ));
            }
            (b.page_x, b.page_y, b.width, b.height, true)
        } else if options.full_page {
            let cw = content["width"].as_f64().unwrap_or(0.0);
            let ch = content["height"]
                .as_f64()
                .unwrap_or(0.0)
                .min(MAX_FULL_PAGE_HEIGHT);
            (0.0, 0.0, cw, ch, true)
        } else {
            (
                viewport["pageX"].as_f64().unwrap_or(0.0),
                viewport["pageY"].as_f64().unwrap_or(0.0),
                viewport["clientWidth"].as_f64().unwrap_or(0.0),
                viewport["clientHeight"].as_f64().unwrap_or(0.0),
                false,
            )
        };
        if w < 1.0 || h < 1.0 {
            return Err(BrowserError::Invalid(
                "nothing to capture (zero-sized page or element)".into(),
            ));
        }
        let scale = fit_scale(w * dpr, h * dpr, options.max_dimension);
        let mut params = json!({
            "format": match options.format { ImageFormat::Png => "png", ImageFormat::Jpeg => "jpeg" },
            "fromSurface": true,
            "captureBeyondViewport": beyond,
            "clip": {"x": x, "y": y, "width": w, "height": h, "scale": scale},
        });
        if options.format == ImageFormat::Jpeg {
            params["quality"] = json!(options.quality.clamp(1, 100));
        }
        let response = self.send("Page.captureScreenshot", params).await?;
        let encoded = response["data"]
            .as_str()
            .ok_or_else(|| BrowserError::Invalid("browser returned no screenshot data".into()))?;
        let data = STANDARD
            .decode(encoded)
            .map_err(|e| BrowserError::Invalid(format!("bad screenshot encoding: {e}")))?;
        let (width, height) = image_dimensions(&data).unwrap_or((0, 0));
        Ok(Screenshot {
            data,
            mime: match options.format {
                ImageFormat::Png => "image/png",
                ImageFormat::Jpeg => "image/jpeg",
            },
            width,
            height,
        })
    }

    /// Renders the page to PDF (works in headless mode only on most builds).
    pub async fn print_to_pdf(&self) -> Result<Vec<u8>> {
        let response = self
            .send(
                "Page.printToPDF",
                json!({"printBackground": true, "preferCSSPageSize": true}),
            )
            .await?;
        let encoded = response["data"]
            .as_str()
            .ok_or_else(|| BrowserError::Invalid("browser returned no PDF data".into()))?;
        STANDARD
            .decode(encoded)
            .map_err(|e| BrowserError::Invalid(format!("bad PDF encoding: {e}")))
    }

    /// Serializes the page and its subresources as MHTML (`Page.captureSnapshot`).
    pub async fn capture_mhtml(&self) -> Result<Vec<u8>> {
        let response = self
            .send("Page.captureSnapshot", json!({"format": "mhtml"}))
            .await?;
        response["data"]
            .as_str()
            .map(|data| data.as_bytes().to_vec())
            .ok_or_else(|| BrowserError::Invalid("browser returned no snapshot data".into()))
    }

    /// The current DOM as an HTML document (doctype included).
    pub async fn page_html(&self) -> Result<Vec<u8>> {
        let value = self
            .evaluate(
                "(document.doctype ? new XMLSerializer().serializeToString(document.doctype) + '\\n' : '') + document.documentElement.outerHTML",
            )
            .await?;
        value
            .as_str()
            .map(|html| html.as_bytes().to_vec())
            .ok_or_else(|| BrowserError::Invalid("page returned no HTML".into()))
    }

    /// Reads a `blob:` URL by fetching it inside the page and pulling the bytes
    /// out in chunks (each under 1 MB of base64) to avoid giant CDP messages.
    pub async fn read_blob(&self, blob_url: &str) -> Result<Vec<u8>> {
        let load = format!(
            "(async () => {{ const r = await fetch({}); const b = new Uint8Array(await (await r.blob()).arrayBuffer()); \
             Object.defineProperty(window, '__omniaBlob', {{value: b, configurable: true, writable: true}}); return b.length; }})()",
            Value::String(blob_url.to_string())
        );
        let total = self.evaluate(&load).await?.as_u64().unwrap_or(0) as usize;
        let mut out = Vec::with_capacity(total);
        let mut offset = 0usize;
        while offset < total {
            let chunk = format!(
                "(() => {{ const b = window.__omniaBlob; let s = ''; const end = Math.min(b.length, {offset} + {BLOB_CHUNK}); \
                 for (let i = {offset}; i < end; i += 0x8000) {{ s += String.fromCharCode.apply(null, b.subarray(i, Math.min(i + 0x8000, end))); }} \
                 return btoa(s); }})()"
            );
            let value = self.evaluate(&chunk).await;
            let value = match value {
                Ok(v) => v,
                Err(e) => {
                    let _ = self.evaluate("delete window.__omniaBlob").await;
                    return Err(e);
                }
            };
            let bytes = STANDARD
                .decode(value.as_str().unwrap_or(""))
                .map_err(|e| BrowserError::Invalid(format!("bad blob chunk: {e}")))?;
            if bytes.is_empty() {
                break;
            }
            offset += bytes.len();
            out.extend_from_slice(&bytes);
        }
        let _ = self.evaluate("delete window.__omniaBlob").await;
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn png_dimensions() {
        let mut png = vec![
            0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, b'I', b'H', b'D', b'R',
        ];
        png.extend_from_slice(&640u32.to_be_bytes());
        png.extend_from_slice(&480u32.to_be_bytes());
        png.extend_from_slice(&[8, 6, 0, 0, 0]);
        assert_eq!(image_dimensions(&png), Some((640, 480)));
    }

    #[test]
    fn jpeg_dimensions() {
        // SOI, APP0 (len 4), SOF0 with 300x200.
        let jpeg = [
            0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x04, 0x00, 0x00, 0xFF, 0xC0, 0x00, 0x11, 0x08, 0x00,
            0xC8, 0x01, 0x2C, 0x03,
        ];
        assert_eq!(image_dimensions(&jpeg), Some((300, 200)));
        assert_eq!(image_dimensions(b"nope"), None);
    }

    #[test]
    fn scale_fits_long_side() {
        assert_eq!(fit_scale(800.0, 600.0, Some(1568)), 1.0);
        let s = fit_scale(3136.0, 1000.0, Some(1568));
        assert!((s - 0.5).abs() < 1e-9);
        assert_eq!(fit_scale(100.0, 100.0, None), 1.0);
    }
}
