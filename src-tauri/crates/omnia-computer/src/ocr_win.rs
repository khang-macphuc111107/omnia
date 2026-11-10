//! Windows.Media.Ocr on captured pixels. Blocking: call from a blocking thread.

use windows::core::HSTRING;
use windows::Globalization::Language;
use windows::Graphics::Imaging::{BitmapPixelFormat, SoftwareBitmap};
use windows::Media::Ocr::OcrEngine;
use windows::Storage::Streams::DataWriter;
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

use crate::ocr::{line_from_words, BBox, OcrLine, OcrWord};
use crate::types::RawImage;
use crate::ComputerError;

const INSTALL_HINT: &str = "Install a Windows OCR language pack: Settings > Time & language > Language & region > \
Add a language (with the \"Optical character recognition\" feature), or run in an elevated PowerShell: \
Add-WindowsCapability -Online -Name \"Language.OCR~~~en-US~0.0.1.0\" (replace en-US with your language tag).";

fn fail(what: &str, e: windows::core::Error) -> ComputerError {
    ComputerError::Failed(format!("OCR failed ({what}): {e}"))
}

fn engine(language: Option<&str>) -> Result<OcrEngine, ComputerError> {
    match language.map(str::trim).filter(|l| !l.is_empty()) {
        Some(tag) => {
            let lang = Language::CreateLanguage(&HSTRING::from(tag)).map_err(|_| {
                ComputerError::Invalid(format!(
                    "\"{tag}\" is not a valid BCP-47 language tag (e.g. en-US, vi, ja)"
                ))
            })?;
            if !OcrEngine::IsLanguageSupported(&lang).unwrap_or(false) {
                return Err(ComputerError::Failed(format!(
                    "OCR language \"{tag}\" is not installed or not supported. {INSTALL_HINT}"
                )));
            }
            OcrEngine::TryCreateFromLanguage(&lang).map_err(|e| {
                ComputerError::Failed(format!(
                    "could not create the OCR engine for \"{tag}\": {e}. {INSTALL_HINT}"
                ))
            })
        }
        None => OcrEngine::TryCreateFromUserProfileLanguages().map_err(|_| {
            ComputerError::Failed(format!(
                "no OCR engine is available for the languages in your user profile. {INSTALL_HINT}"
            ))
        }),
    }
}

/// Recognize text in `raw` (RGB). Boxes are in bitmap pixels.
pub fn recognize(raw: &RawImage, language: Option<&str>) -> Result<Vec<OcrLine>, ComputerError> {
    // Windows.* WinRT objects need COM; tolerate a thread that is already initialised.
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
    let engine = engine(language)?;
    let max = OcrEngine::MaxImageDimension().unwrap_or(10_000);
    if raw.width > max || raw.height > max {
        return Err(ComputerError::Invalid(format!(
            "the area is {}x{} px but the OCR engine accepts at most {max} px per side; pass a smaller `region`",
            raw.width, raw.height
        )));
    }
    if raw.width == 0
        || raw.height == 0
        || raw.rgb.len() < raw.width as usize * raw.height as usize * 3
    {
        return Err(ComputerError::Invalid("empty capture".into()));
    }
    let mut bgra = Vec::with_capacity(raw.width as usize * raw.height as usize * 4);
    #[allow(clippy::chunks_exact_to_as_chunks)]
    // as_chunks needs a newer toolchain than rust-version 1.77.2
    for px in raw.rgb.chunks_exact(3) {
        bgra.extend_from_slice(&[px[2], px[1], px[0], 255]);
    }
    let writer = DataWriter::new().map_err(|e| fail("DataWriter", e))?;
    writer
        .WriteBytes(&bgra)
        .map_err(|e| fail("WriteBytes", e))?;
    let buffer = writer.DetachBuffer().map_err(|e| fail("DetachBuffer", e))?;
    let bitmap = SoftwareBitmap::CreateCopyFromBuffer(
        &buffer,
        BitmapPixelFormat::Bgra8,
        raw.width as i32,
        raw.height as i32,
    )
    .map_err(|e| fail("SoftwareBitmap", e))?;
    let result = engine
        .RecognizeAsync(&bitmap)
        .and_then(|op| op.get())
        .map_err(|e| fail("recognize", e))?;
    let mut lines = Vec::new();
    for line in result.Lines().map_err(|e| fail("Lines", e))? {
        let mut words = Vec::new();
        for w in line.Words().map_err(|e| fail("Words", e))? {
            let r = w.BoundingRect().map_err(|e| fail("BoundingRect", e))?;
            words.push(OcrWord {
                text: w.Text().map_err(|e| fail("Text", e))?.to_string(),
                bbox: BBox::new(r.X as f64, r.Y as f64, r.Width as f64, r.Height as f64),
            });
        }
        let text = line.Text().map_err(|e| fail("Text", e))?.to_string();
        if let Some(l) = line_from_words(text, words) {
            lines.push(l);
        }
    }
    Ok(lines)
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::core::w;
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleDC, CreateDIBSection, CreateFontW, DeleteDC, DeleteObject, SelectObject,
        SetBkMode, SetTextColor, TextOutW, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
        FW_NORMAL, TRANSPARENT,
    };

    /// Black text on white, drawn with GDI into a DIB, as an RGB `RawImage`.
    fn render(text: &str, w_px: i32, h_px: i32) -> RawImage {
        unsafe {
            let dc = CreateCompatibleDC(None);
            let bi = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: w_px,
                    biHeight: -h_px,
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };
            let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
            let bmp =
                CreateDIBSection(Some(dc), &bi, DIB_RGB_COLORS, &mut bits, None, 0).expect("dib");
            let old = SelectObject(dc, bmp.into());
            let n = (w_px * h_px * 4) as usize;
            let buf = std::slice::from_raw_parts_mut(bits as *mut u8, n);
            buf.fill(255);
            let font = CreateFontW(
                48,
                0,
                0,
                0,
                FW_NORMAL.0 as i32,
                0,
                0,
                0,
                Default::default(),
                Default::default(),
                Default::default(),
                Default::default(),
                0,
                w!("Arial"),
            );
            let old_font = SelectObject(dc, font.into());
            SetBkMode(dc, TRANSPARENT);
            SetTextColor(dc, windows::Win32::Foundation::COLORREF(0));
            let wide: Vec<u16> = text.encode_utf16().collect();
            let _ = TextOutW(dc, 20, 20, &wide);
            let mut rgb = Vec::with_capacity((w_px * h_px * 3) as usize);
            #[allow(clippy::chunks_exact_to_as_chunks)]
            for px in buf.chunks_exact(4) {
                rgb.extend_from_slice(&[px[2], px[1], px[0]]);
            }
            SelectObject(dc, old_font);
            let _ = DeleteObject(font.into());
            SelectObject(dc, old);
            let _ = DeleteObject(bmp.into());
            let _ = DeleteDC(dc);
            RawImage {
                origin: (0, 0),
                width: w_px as u32,
                height: h_px as u32,
                rgb,
            }
        }
    }

    /// Needs an installed OCR language pack matching the user profile (en-US typically).
    #[test]
    #[ignore = "requires a Windows OCR language pack"]
    fn recognizes_gdi_rendered_text() {
        let img = render("Hello Omnia 2026", 640, 120);
        let lines = recognize(&img, None).expect("ocr");
        let all = lines
            .iter()
            .map(|l| l.text.to_lowercase())
            .collect::<Vec<_>>()
            .join(" ");
        assert!(
            all.contains("hello") && all.contains("omnia"),
            "got {all:?}"
        );
        let line = lines
            .iter()
            .find(|l| l.text.to_lowercase().contains("hello"))
            .unwrap();
        assert!(
            line.bbox.x >= 10.0 && line.bbox.y >= 10.0 && line.bbox.w > 100.0 && line.bbox.h > 20.0,
            "{:?}",
            line.bbox
        );
        let found = crate::ocr::find_matches(&lines, "OMNIA");
        assert_eq!(found.len(), 1);
    }

    #[test]
    fn rejects_bad_language_tag_or_reports_missing_pack() {
        let img = RawImage {
            origin: (0, 0),
            width: 4,
            height: 4,
            rgb: vec![255; 48],
        };
        let err = recognize(&img, Some("zz-ZZ-not-a-lang"))
            .unwrap_err()
            .to_string();
        assert!(err.contains("not"), "{err}");
    }
}
