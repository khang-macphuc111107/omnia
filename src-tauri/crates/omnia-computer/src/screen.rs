//! GDI screen capture (desktop region via BitBlt, single window via PrintWindow).

use windows::Win32::Foundation::{HWND, POINT, RECT};
use windows::Win32::Graphics::Gdi::{
    BitBlt, ClientToScreen, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject,
    GetDC, GetDIBits, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CAPTUREBLT,
    DIB_RGB_COLORS, HDC, SRCCOPY,
};
use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};

use crate::types::{RawImage, Rect};
use crate::winapi;
use crate::ComputerError;

const MAX_DIM: i32 = 16_384;
const PW_RENDERFULLCONTENT: u32 = 2;

fn fail(what: &str) -> ComputerError {
    ComputerError::Failed(format!("screen capture failed: {what}"))
}

/// Draw into an off-screen bitmap with `paint`, then read it back as RGB.
fn with_bitmap(
    w: i32,
    h: i32,
    paint: impl FnOnce(HDC) -> Result<(), ComputerError>,
) -> Result<Vec<u8>, ComputerError> {
    if w <= 0 || h <= 0 || w > MAX_DIM || h > MAX_DIM {
        return Err(ComputerError::Invalid(format!(
            "capture size {w}x{h} is out of range"
        )));
    }
    unsafe {
        let screen = GetDC(None);
        if screen.is_invalid() {
            return Err(fail("GetDC"));
        }
        let mem = CreateCompatibleDC(Some(screen));
        let bmp = CreateCompatibleBitmap(screen, w, h);
        let result = (|| {
            if mem.is_invalid() || bmp.is_invalid() {
                return Err(fail("create bitmap"));
            }
            let old = SelectObject(mem, bmp.into());
            let painted = paint(mem);
            let mut bi = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: w,
                    biHeight: -h,
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };
            let mut bgra = vec![0u8; w as usize * h as usize * 4];
            let lines = GetDIBits(
                mem,
                bmp,
                0,
                h as u32,
                Some(bgra.as_mut_ptr().cast()),
                &mut bi,
                DIB_RGB_COLORS,
            );
            SelectObject(mem, old);
            painted?;
            if lines == 0 {
                return Err(fail("GetDIBits"));
            }
            let mut rgb = Vec::with_capacity(w as usize * h as usize * 3);
            #[allow(clippy::chunks_exact_to_as_chunks)]
            // as_chunks needs a newer toolchain than rust-version 1.77.2
            for px in bgra.chunks_exact(4) {
                rgb.extend_from_slice(&[px[2], px[1], px[0]]);
            }
            Ok(rgb)
        })();
        let _ = DeleteObject(bmp.into());
        let _ = DeleteDC(mem);
        ReleaseDC(None, screen);
        result
    }
}

/// Capture a physical virtual-screen rectangle (what is visible on screen).
pub fn capture_rect(r: Rect) -> Result<RawImage, ComputerError> {
    let rgb = with_bitmap(r.w, r.h, |mem| unsafe {
        let screen = GetDC(None);
        let res = BitBlt(
            mem,
            0,
            0,
            r.w,
            r.h,
            Some(screen),
            r.x,
            r.y,
            SRCCOPY | CAPTUREBLT,
        );
        ReleaseDC(None, screen);
        res.map_err(|e| fail(&format!("BitBlt: {e}")))
    })?;
    Ok(RawImage {
        origin: (r.x, r.y),
        width: r.w as u32,
        height: r.h as u32,
        rgb,
    })
}

/// Capture one window's own pixels (works when partially occluded), cropped to
/// the visible frame so coordinates match `WindowInfo::bounds`.
pub fn capture_window(hwnd: isize) -> Result<RawImage, ComputerError> {
    let info = winapi::window_info(hwnd)
        .ok_or_else(|| ComputerError::NotFound(format!("window {hwnd} no longer exists")))?;
    if info.minimized {
        return Err(ComputerError::Invalid(
            "window is minimized; restore it first (computer_window restore)".into(),
        ));
    }
    let outer = winapi::outer_rect(hwnd);
    let frame = winapi::frame_rect(hwnd);
    let h = HWND(hwnd as *mut _);
    let rgb = with_bitmap(outer.w, outer.h, |mem| unsafe {
        if PrintWindow(h, mem, PRINT_WINDOW_FLAGS(PW_RENDERFULLCONTENT)).as_bool() {
            Ok(())
        } else {
            Err(fail("PrintWindow"))
        }
    })?;
    let crop = frame.intersect(&outer).unwrap_or(outer);
    let (ox, oy) = ((crop.x - outer.x) as usize, (crop.y - outer.y) as usize);
    let (cw, ch) = (crop.w as usize, crop.h as usize);
    let stride = outer.w as usize * 3;
    let mut out = Vec::with_capacity(cw * ch * 3);
    for row in 0..ch {
        let start = (oy + row) * stride + ox * 3;
        out.extend_from_slice(&rgb[start..start + cw * 3]);
    }
    Ok(RawImage {
        origin: (crop.x, crop.y),
        width: cw as u32,
        height: ch as u32,
        rgb: out,
    })
}

/// Client area of one window rendered with `PrintWindow(PW_RENDERFULLCONTENT)`
/// into an off-screen DIB. Works while the window is occluded or behind
/// others (not minimized). Pixel (0,0) is the client origin; `origin` is (0,0).
pub fn capture_window_client(hwnd: isize) -> Result<RawImage, ComputerError> {
    crate::bgwin::with_window_dpi(hwnd, || capture_window_client_inner(hwnd))
}

fn capture_window_client_inner(hwnd: isize) -> Result<RawImage, ComputerError> {
    let h = HWND(hwnd as *mut _);
    let mut cr = RECT::default();
    unsafe { windows::Win32::UI::WindowsAndMessaging::GetClientRect(h, &mut cr) }
        .map_err(|e| fail(&format!("GetClientRect: {e}")))?;
    let (cw, ch) = (cr.right - cr.left, cr.bottom - cr.top);
    if cw <= 0 || ch <= 0 {
        return Err(ComputerError::Invalid(
            "window has an empty client area (minimized or zero-sized)".into(),
        ));
    }
    let mut origin = POINT { x: 0, y: 0 };
    if !unsafe { ClientToScreen(h, &mut origin) }.as_bool() {
        return Err(fail("ClientToScreen"));
    }
    let outer = winapi::outer_rect(hwnd);
    let rgb = with_bitmap(outer.w, outer.h, |mem| unsafe {
        if PrintWindow(h, mem, PRINT_WINDOW_FLAGS(PW_RENDERFULLCONTENT)).as_bool() {
            Ok(())
        } else {
            Err(fail("PrintWindow"))
        }
    })?;
    let ox = (origin.x - outer.x).clamp(0, outer.w - 1) as usize;
    let oy = (origin.y - outer.y).clamp(0, outer.h - 1) as usize;
    let w = (cw as usize).min(outer.w as usize - ox);
    let hh = (ch as usize).min(outer.h as usize - oy);
    let stride = outer.w as usize * 3;
    let mut out = Vec::with_capacity(w * hh * 3);
    for row in 0..hh {
        let start = (oy + row) * stride + ox * 3;
        out.extend_from_slice(&rgb[start..start + w * 3]);
    }
    Ok(RawImage {
        origin: (0, 0),
        width: w as u32,
        height: hh as u32,
        rgb: out,
    })
}
