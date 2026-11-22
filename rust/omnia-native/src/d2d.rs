use std::ffi::c_void;
use std::ptr::{null, null_mut, NonNull};

use windows_sys::core::{GUID, HRESULT, PCWSTR};
use windows_sys::Win32::Foundation::{HWND, RECT};
use windows_sys::Win32::Graphics::Dwm::{
    DwmSetWindowAttribute, DWMWA_BORDER_COLOR, DWMWA_CAPTION_COLOR, DWMWA_SYSTEMBACKDROP_TYPE,
    DWMWA_TEXT_COLOR, DWMWA_USE_IMMERSIVE_DARK_MODE, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND,
};
use windows_sys::Win32::Graphics::Gdi::HDC;

use crate::dpi::{scale_px, ShellLayoutRects};
use crate::types::{
    utf8_to_wide, COLOR_ACCENT, COLOR_BORDER, COLOR_CARD_BG, COLOR_DWM_CAPTION, COLOR_TEXT_PRIMARY,
    COLOR_TOP_BAR_BG, COLOR_WINDOW_BG, STUDIO_BADGE_TEXT,
};

static IID_ID2D1_FACTORY: GUID = GUID {
    data1: 0x0615_2247,
    data2: 0x6F50,
    data3: 0x465A,
    data4: [0x92, 0x45, 0x11, 0x8B, 0xFD, 0x3B, 0x60, 0x07],
};

static IID_IDWRITE_FACTORY: GUID = GUID {
    data1: 0xB859_EE5A,
    data2: 0xD838,
    data3: 0x4B5B,
    data4: [0xA2, 0xE8, 0x1A, 0xDC, 0x7D, 0x93, 0xDB, 0x48],
};

const D2DERR_RECREATE_TARGET: HRESULT = 0x8899_000Cu32 as i32;
const D2D1_FACTORY_TYPE_SINGLE_THREADED: i32 = 0;
const DWRITE_FACTORY_TYPE_SHARED: i32 = 0;
const D2D1_RENDER_TARGET_TYPE_DEFAULT: i32 = 0;
const DXGI_FORMAT_B8G8R8A8_UNORM: i32 = 87;
const D2D1_ALPHA_MODE_IGNORE: i32 = 3;
const D2D1_RENDER_TARGET_USAGE_NONE: i32 = 0;
const D2D1_FEATURE_LEVEL_DEFAULT: i32 = 0;
const D2D1_DRAW_TEXT_OPTIONS_CLIP: u32 = 0x0000_0002;
const DWRITE_MEASURING_MODE_NATURAL: i32 = 0;
const DWRITE_FONT_WEIGHT_SEMI_BOLD: i32 = 600;
const DWRITE_FONT_STYLE_NORMAL: i32 = 0;
const DWRITE_FONT_STRETCH_NORMAL: i32 = 5;
const DWRITE_TEXT_ALIGNMENT_TRAILING: i32 = 1;
const DWRITE_PARAGRAPH_ALIGNMENT_CENTER: i32 = 2;
const DWRITE_WORD_WRAPPING_NO_WRAP: i32 = 1;
const DWMSBT_MAINWINDOW: i32 = 2;

#[repr(C)]
#[derive(Clone, Copy)]
struct D2D1PixelFormat {
    format: i32,
    alpha_mode: i32,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct D2D1RenderTargetProperties {
    target_type: i32,
    pixel_format: D2D1PixelFormat,
    dpi_x: f32,
    dpi_y: f32,
    usage: i32,
    min_level: i32,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct D2D1ColorF {
    r: f32,
    g: f32,
    b: f32,
    a: f32,
}

impl D2D1ColorF {
    const fn from_rgb(r: u8, g: u8, b: u8, a: f32) -> Self {
        Self {
            r: (r as f32) / 255.0,
            g: (g as f32) / 255.0,
            b: (b as f32) / 255.0,
            a,
        }
    }

    const fn from_colorref(colorref: u32, a: f32) -> Self {
        let r = (colorref & 0xFF) as u8;
        let g = ((colorref >> 8) & 0xFF) as u8;
        let b = ((colorref >> 16) & 0xFF) as u8;
        Self::from_rgb(r, g, b, a)
    }
}

#[repr(C)]
#[derive(Clone, Copy)]
struct D2D1RectF {
    left: f32,
    top: f32,
    right: f32,
    bottom: f32,
}

impl D2D1RectF {
    const fn from_px(r: crate::dpi::RectPx) -> Self {
        Self {
            left: r.left as f32,
            top: r.top as f32,
            right: r.right as f32,
            bottom: r.bottom as f32,
        }
    }
}

#[repr(C)]
#[derive(Clone, Copy)]
struct D2D1RoundedRect {
    rect: D2D1RectF,
    radius_x: f32,
    radius_y: f32,
}

#[link(name = "d2d1")]
unsafe extern "system" {
    fn D2D1CreateFactory(
        factory_type: i32,
        riid: *const GUID,
        factory_options: *const c_void,
        factory: *mut *mut c_void,
    ) -> HRESULT;
}

#[link(name = "dwrite")]
unsafe extern "system" {
    fn DWriteCreateFactory(
        factory_type: i32,
        iid: *const GUID,
        factory: *mut *mut c_void,
    ) -> HRESULT;
}

/// Owned RAII COM pointer calling `IUnknown::Release` (vtable slot 2) on drop.
pub struct ComPtr {
    ptr: NonNull<c_void>,
}

impl ComPtr {
    /// Wrap a non-null COM pointer whose reference count was already incremented by the producer.
    ///
    /// # Safety
    /// `raw` must point to a valid COM interface whose vtable slot 2 is `IUnknown::Release`.
    unsafe fn from_raw(raw: *mut c_void) -> Option<Self> {
        NonNull::new(raw).map(|ptr| Self { ptr })
    }

    #[inline]
    fn as_ptr(&self) -> *mut c_void {
        self.ptr.as_ptr()
    }

    #[inline]
    unsafe fn vtable_slot<T: Copy>(&self, index: usize) -> T {
        // SAFETY: Every COM object starts with a pointer to its vtable array of function pointers.
        unsafe {
            let vtbl = *self.ptr.as_ptr().cast::<*const T>();
            *vtbl.add(index)
        }
    }
}

impl Drop for ComPtr {
    fn drop(&mut self) {
        // SAFETY: Vtable slot 2 of any COM interface is `IUnknown::Release`.
        unsafe {
            let release: unsafe extern "system" fn(*mut c_void) -> u32 = self.vtable_slot(2);
            let _ = release(self.ptr.as_ptr());
        }
    }
}

/// Apply Windows 11 dark-mode, Mica backdrop, rounded corners, and dark caption/border attributes.
pub fn configure_dwm_shell_window(hwnd: HWND) {
    if hwnd.is_null() {
        return;
    }
    let dark_mode: i32 = 1;
    let round_corners: i32 = DWMWCP_ROUND;
    let backdrop: i32 = DWMSBT_MAINWINDOW;
    let caption_color: u32 = COLOR_DWM_CAPTION;
    let text_color: u32 = COLOR_TEXT_PRIMARY;
    let border_color: u32 = COLOR_BORDER;

    // SAFETY: Each call passes a pointer to a stack variable of exact documented size.
    unsafe {
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_USE_IMMERSIVE_DARK_MODE as u32,
            (&raw const dark_mode).cast(),
            core::mem::size_of::<i32>() as u32,
        );
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_WINDOW_CORNER_PREFERENCE as u32,
            (&raw const round_corners).cast(),
            core::mem::size_of::<i32>() as u32,
        );
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_CAPTION_COLOR as u32,
            (&raw const caption_color).cast(),
            core::mem::size_of::<u32>() as u32,
        );
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_TEXT_COLOR as u32,
            (&raw const text_color).cast(),
            core::mem::size_of::<u32>() as u32,
        );
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_BORDER_COLOR as u32,
            (&raw const border_color).cast(),
            core::mem::size_of::<u32>() as u32,
        );
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_SYSTEMBACKDROP_TYPE as u32,
            (&raw const backdrop).cast(),
            core::mem::size_of::<i32>() as u32,
        );
    }
}

/// Lazily initialized Direct2D / DirectWrite resources for crisp shell chrome rendering.
#[derive(Default)]
pub struct D2dShellPainter {
    d2d_factory: Option<ComPtr>,
    dwrite_factory: Option<ComPtr>,
    dc_target: Option<ComPtr>,
    badge_format: Option<ComPtr>,
    badge_text: Vec<u16>,
    cached_dpi: u32,
}

impl D2dShellPainter {
    /// Create a new uninitialized Direct2D painter.
    #[must_use]
    pub fn new() -> Self {
        let badge_wide = utf8_to_wide(STUDIO_BADGE_TEXT);
        Self {
            d2d_factory: None,
            dwrite_factory: None,
            dc_target: None,
            badge_format: None,
            badge_text: badge_wide[..badge_wide.len().saturating_sub(1)].to_vec(),
            cached_dpi: 0,
        }
    }

    /// Release cached device-dependent render target and DPI-sized text format (e.g. on DPI change or device loss).
    pub fn invalidate_device_resources(&mut self) {
        self.dc_target = None;
        self.badge_format = None;
        self.cached_dpi = 0;
    }

    fn ensure_resources(&mut self, dpi: u32) -> bool {
        if self.cached_dpi != dpi {
            self.dc_target = None;
            self.badge_format = None;
        }
        if self.d2d_factory.is_none() {
            let mut raw: *mut c_void = null_mut();
            // SAFETY: Output pointer `raw` receives AddRef'd `ID2D1Factory*` when S_OK.
            let hr = unsafe {
                D2D1CreateFactory(
                    D2D1_FACTORY_TYPE_SINGLE_THREADED,
                    &raw const IID_ID2D1_FACTORY,
                    null(),
                    &raw mut raw,
                )
            };
            if hr >= 0 {
                // SAFETY: `D2D1CreateFactory` succeeded and transferred one reference to `raw`.
                self.d2d_factory = unsafe { ComPtr::from_raw(raw) };
            }
        }
        if self.dwrite_factory.is_none() {
            let mut raw: *mut c_void = null_mut();
            // SAFETY: Output pointer `raw` receives AddRef'd `IDWriteFactory*` when S_OK.
            let hr = unsafe {
                DWriteCreateFactory(
                    DWRITE_FACTORY_TYPE_SHARED,
                    &raw const IID_IDWRITE_FACTORY,
                    &raw mut raw,
                )
            };
            if hr >= 0 {
                // SAFETY: `DWriteCreateFactory` succeeded and transferred one reference to `raw`.
                self.dwrite_factory = unsafe { ComPtr::from_raw(raw) };
            }
        }

        let Some(ref d2d_factory) = self.d2d_factory else {
            return false;
        };
        if self.dc_target.is_none() {
            let props = D2D1RenderTargetProperties {
                target_type: D2D1_RENDER_TARGET_TYPE_DEFAULT,
                pixel_format: D2D1PixelFormat {
                    format: DXGI_FORMAT_B8G8R8A8_UNORM,
                    alpha_mode: D2D1_ALPHA_MODE_IGNORE,
                },
                dpi_x: dpi as f32,
                dpi_y: dpi as f32,
                usage: D2D1_RENDER_TARGET_USAGE_NONE,
                min_level: D2D1_FEATURE_LEVEL_DEFAULT,
            };
            let mut raw_target: *mut c_void = null_mut();
            // SAFETY: `ID2D1Factory::CreateDCRenderTarget` is vtable slot 16 in `d2d1.h`.
            let hr = unsafe {
                let create_dc: unsafe extern "system" fn(
                    *mut c_void,
                    *const D2D1RenderTargetProperties,
                    *mut *mut c_void,
                ) -> HRESULT = d2d_factory.vtable_slot(16);
                create_dc(d2d_factory.as_ptr(), &raw const props, &raw mut raw_target)
            };
            if hr >= 0 {
                // SAFETY: `CreateDCRenderTarget` succeeded and transferred one reference.
                self.dc_target = unsafe { ComPtr::from_raw(raw_target) };
            }
        }

        if self.badge_format.is_none() {
            if let Some(ref dwrite_factory) = self.dwrite_factory {
                let family = utf8_to_wide("Segoe UI");
                let locale = utf8_to_wide("en-US");
                let mut raw_fmt: *mut c_void = null_mut();
                let font_size = (scale_px(12, dpi) as f32).max(11.0);
                // SAFETY: `IDWriteFactory::CreateTextFormat` is vtable slot 15 in `dwrite.h`.
                let hr = unsafe {
                    let create_fmt: unsafe extern "system" fn(
                        *mut c_void,
                        PCWSTR,
                        *mut c_void,
                        i32,
                        i32,
                        i32,
                        f32,
                        PCWSTR,
                        *mut *mut c_void,
                    ) -> HRESULT = dwrite_factory.vtable_slot(15);
                    create_fmt(
                        dwrite_factory.as_ptr(),
                        family.as_ptr(),
                        null_mut(),
                        DWRITE_FONT_WEIGHT_SEMI_BOLD,
                        DWRITE_FONT_STYLE_NORMAL,
                        DWRITE_FONT_STRETCH_NORMAL,
                        font_size,
                        locale.as_ptr(),
                        &raw mut raw_fmt,
                    )
                };
                if hr >= 0 {
                    // SAFETY: `CreateTextFormat` succeeded and transferred one reference.
                    self.badge_format = unsafe { ComPtr::from_raw(raw_fmt) };
                    if let Some(ref fmt) = self.badge_format {
                        // SAFETY: Slots 3 (`SetTextAlignment`), 4 (`SetParagraphAlignment`), 5 (`SetWordWrapping`) on `IDWriteTextFormat`.
                        unsafe {
                            let set_align: unsafe extern "system" fn(*mut c_void, i32) -> HRESULT =
                                fmt.vtable_slot(3);
                            let set_para: unsafe extern "system" fn(*mut c_void, i32) -> HRESULT =
                                fmt.vtable_slot(4);
                            let set_wrap: unsafe extern "system" fn(*mut c_void, i32) -> HRESULT =
                                fmt.vtable_slot(5);
                            let _ = set_align(fmt.as_ptr(), DWRITE_TEXT_ALIGNMENT_TRAILING);
                            let _ = set_para(fmt.as_ptr(), DWRITE_PARAGRAPH_ALIGNMENT_CENTER);
                            let _ = set_wrap(fmt.as_ptr(), DWRITE_WORD_WRAPPING_NO_WRAP);
                        }
                    }
                }
            }
        }

        self.cached_dpi = dpi;
        self.dc_target.is_some()
    }

    /// Paint background, top bar, rounded workspace cards, active mode pill, and badge via Direct2D.
    ///
    /// Returns `true` when Direct2D rendered successfully, or `false` so the caller uses GDI fallback.
    pub fn paint(
        &mut self,
        hdc: HDC,
        client_rect: RECT,
        layout: &ShellLayoutRects,
        dpi: u32,
    ) -> bool {
        if hdc.is_null() || !self.ensure_resources(dpi) {
            return false;
        }
        let Some(ref target) = self.dc_target else {
            return false;
        };

        // SAFETY: `ID2D1DCRenderTarget::BindDC` is vtable slot 57 in `d2d1.h`.
        let bind_hr = unsafe {
            let bind_dc: unsafe extern "system" fn(*mut c_void, HDC, *const RECT) -> HRESULT =
                target.vtable_slot(57);
            bind_dc(target.as_ptr(), hdc, &raw const client_rect)
        };
        if bind_hr < 0 {
            self.invalidate_device_resources();
            return false;
        }

        let create_brush = |target: &ComPtr, color: D2D1ColorF| -> Option<ComPtr> {
            let mut raw_brush: *mut c_void = null_mut();
            // SAFETY: `ID2D1RenderTarget::CreateSolidColorBrush` is vtable slot 8 in `d2d1.h`.
            let hr = unsafe {
                let fn_create: unsafe extern "system" fn(
                    *mut c_void,
                    *const D2D1ColorF,
                    *const c_void,
                    *mut *mut c_void,
                ) -> HRESULT = target.vtable_slot(8);
                fn_create(
                    target.as_ptr(),
                    &raw const color,
                    null(),
                    &raw mut raw_brush,
                )
            };
            if hr >= 0 {
                // SAFETY: Brush creation succeeded and returned an AddRef'd `ID2D1SolidColorBrush*`.
                unsafe { ComPtr::from_raw(raw_brush) }
            } else {
                None
            }
        };

        let bg_brush = create_brush(target, D2D1ColorF::from_colorref(COLOR_WINDOW_BG, 1.0));
        let top_brush = create_brush(target, D2D1ColorF::from_colorref(COLOR_TOP_BAR_BG, 1.0));
        let card_brush = create_brush(target, D2D1ColorF::from_colorref(COLOR_CARD_BG, 1.0));
        let border_brush = create_brush(target, D2D1ColorF::from_colorref(COLOR_BORDER, 1.0));
        let accent_brush = create_brush(target, D2D1ColorF::from_colorref(COLOR_ACCENT, 1.0));
        let badge_brush = create_brush(target, D2D1ColorF::from_rgb(125, 211, 252, 0.85));

        let (Some(bg), Some(top), Some(card), Some(border), Some(accent), Some(badge)) = (
            bg_brush,
            top_brush,
            card_brush,
            border_brush,
            accent_brush,
            badge_brush,
        ) else {
            return false;
        };

        let radius = (scale_px(10, dpi) as f32).max(6.0);
        let pill_radius = (scale_px(6, dpi) as f32).max(4.0);
        let stroke_w = (scale_px(1, dpi) as f32).max(1.0);

        // SAFETY: All `ID2D1RenderTarget` slot indices match exact `d2d1.h` layout verified against SDK 10.0.26100.0:
        // 48=BeginDraw, 47=Clear, 17=FillRectangle, 19=FillRoundedRectangle, 18=DrawRoundedRectangle, 27=DrawText, 49=EndDraw.
        let end_hr = unsafe {
            let begin_draw: unsafe extern "system" fn(*mut c_void) = target.vtable_slot(48);
            let clear: unsafe extern "system" fn(*mut c_void, *const D2D1ColorF) =
                target.vtable_slot(47);
            let fill_rect: unsafe extern "system" fn(*mut c_void, *const D2D1RectF, *mut c_void) =
                target.vtable_slot(17);
            let fill_round: unsafe extern "system" fn(
                *mut c_void,
                *const D2D1RoundedRect,
                *mut c_void,
            ) = target.vtable_slot(19);
            let draw_round: unsafe extern "system" fn(
                *mut c_void,
                *const D2D1RoundedRect,
                *mut c_void,
                f32,
                *mut c_void,
            ) = target.vtable_slot(18);
            let draw_text: unsafe extern "system" fn(
                *mut c_void,
                PCWSTR,
                u32,
                *mut c_void,
                *const D2D1RectF,
                *mut c_void,
                u32,
                i32,
            ) = target.vtable_slot(27);
            let end_draw: unsafe extern "system" fn(*mut c_void, *mut u64, *mut u64) -> HRESULT =
                target.vtable_slot(49);

            begin_draw(target.as_ptr());
            let clear_col = D2D1ColorF::from_colorref(COLOR_WINDOW_BG, 1.0);
            clear(target.as_ptr(), &raw const clear_col);

            let bg_rect = D2D1RectF::from_px(layout.client);
            fill_rect(target.as_ptr(), &raw const bg_rect, bg.as_ptr());

            let top_rect = D2D1RectF::from_px(layout.top_bar);
            fill_rect(target.as_ptr(), &raw const top_rect, top.as_ptr());

            let left_rr = D2D1RoundedRect {
                rect: D2D1RectF::from_px(layout.left_card),
                radius_x: radius,
                radius_y: radius,
            };
            fill_round(target.as_ptr(), &raw const left_rr, card.as_ptr());
            draw_round(
                target.as_ptr(),
                &raw const left_rr,
                border.as_ptr(),
                stroke_w,
                null_mut(),
            );

            let right_rr = D2D1RoundedRect {
                rect: D2D1RectF::from_px(layout.right_card),
                radius_x: radius,
                radius_y: radius,
            };
            fill_round(target.as_ptr(), &raw const right_rr, card.as_ptr());
            draw_round(
                target.as_ptr(),
                &raw const right_rr,
                border.as_ptr(),
                stroke_w,
                null_mut(),
            );

            let pill_rr = D2D1RoundedRect {
                rect: D2D1RectF::from_px(layout.active_pill),
                radius_x: pill_radius,
                radius_y: pill_radius,
            };
            draw_round(
                target.as_ptr(),
                &raw const pill_rr,
                accent.as_ptr(),
                (stroke_w * 2.0).max(2.0),
                null_mut(),
            );

            if layout.badge.width() > 40 {
                if let Some(ref fmt) = self.badge_format {
                    let badge_rect = D2D1RectF::from_px(layout.badge);
                    draw_text(
                        target.as_ptr(),
                        self.badge_text.as_ptr(),
                        self.badge_text.len() as u32,
                        fmt.as_ptr(),
                        &raw const badge_rect,
                        badge.as_ptr(),
                        D2D1_DRAW_TEXT_OPTIONS_CLIP,
                        DWRITE_MEASURING_MODE_NATURAL,
                    );
                }
            }

            end_draw(target.as_ptr(), null_mut(), null_mut())
        };

        if end_hr == D2DERR_RECREATE_TARGET || end_hr < 0 {
            self.invalidate_device_resources();
            return false;
        }
        true
    }
}
