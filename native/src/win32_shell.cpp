#include "omnia_native/win32_shell.hpp"
#include "omnia_native/composer.hpp"
#include "omnia_native/session_panel.hpp"
#include "omnia_native/uia_provider.hpp"

#include <windows.h>
#include <commctrl.h>
#include <d2d1.h>
#include <dwrite.h>
#include <dwmapi.h>
#include <objbase.h>
#include <uxtheme.h>
#include <wrl/client.h>

#include <algorithm>
#include <array>
#include <memory>
#include <string>
#include <vector>

namespace omnia::native {

namespace {

using Microsoft::WRL::ComPtr;

constexpr wchar_t kShellClassName[] = L"OmniaNativeShell";
constexpr wchar_t kShellWindowTitle[] = L"Omnia \u2014 native C++20";

constexpr COLORREF kWindowBgColor = RGB(14, 19, 27);
constexpr COLORREF kCardBgColor = RGB(21, 30, 43);
constexpr COLORREF kInputBgColor = RGB(13, 19, 28);
constexpr COLORREF kFooterBgColor = RGB(14, 19, 27);

constexpr COLORREF kTextPrimary = RGB(236, 242, 250);
constexpr COLORREF kTextMuted = RGB(148, 163, 184);
constexpr COLORREF kTextBadge = RGB(125, 211, 252);

struct ShellHandles {
    std::array<HWND, 3> buttons{nullptr, nullptr, nullptr};
    HWND heading{nullptr};
    HWND composer_cmd{nullptr};
    std::array<HWND, 3> sym_buttons{nullptr, nullptr, nullptr};
    HWND composer_badge{nullptr};
    HWND draft_label{nullptr};
    HWND draft{nullptr};
    HWND status{nullptr};
    HWND sessions{nullptr};
};

struct ShellLayoutMetrics {
    RECT top_bar{};
    RECT active_pill{};
    RECT left_card{};
    RECT mode_card{};
    RECT composer_card{};
    int footer_line_y{0};
};

struct WindowState {
    ShellHandles handles;
    HFONT font{nullptr};
    HFONT bold_font{nullptr};
    HBRUSH card_brush{nullptr};
    HBRUSH input_brush{nullptr};
    HBRUSH footer_brush{nullptr};
    Mode active_mode{Mode::Chat};
    std::shared_ptr<RichComposer> composer{std::make_shared<RichComposer>()};
    ComPtr<ID2D1Factory> d2d_factory;
    ComPtr<ID2D1DCRenderTarget> dc_target;
    ComPtr<IDWriteFactory> dwrite_factory;
    ComPtr<IDWriteTextFormat> badge_format;

    ~WindowState() {
        if (font) {
            DeleteObject(font);
        }
        if (bold_font) {
            DeleteObject(bold_font);
        }
        if (card_brush) {
            DeleteObject(card_brush);
        }
        if (input_brush) {
            DeleteObject(input_brush);
        }
        if (footer_brush) {
            DeleteObject(footer_brush);
        }
    }
};

struct ComApartmentGuard {
    bool initialized{false};
    ~ComApartmentGuard() {
        if (initialized) {
            CoUninitialize();
        }
    }
};

std::string read_window_text_utf8(HWND hwnd) {
    const int len = GetWindowTextLengthW(hwnd);
    if (len <= 0) {
        return {};
    }
    std::wstring buf(static_cast<size_t>(len) + 1, L'\0');
    const int copied = GetWindowTextW(hwnd, buf.data(), static_cast<int>(buf.size()));
    if (copied <= 0) {
        return {};
    }
    buf.resize(static_cast<size_t>(copied));
    return wide_to_utf8(buf);
}

void set_window_text_utf8(HWND hwnd, std::string_view text) {
    const std::wstring wide = utf8_to_wide(text);
    SetWindowTextW(hwnd, wide.c_str());
}

Result<HFONT> create_scaled_font(uint32_t dpi, int weight = FW_NORMAL, int pt_px = 16) {
    const int pixel_height = -scale_px(pt_px, dpi);
    HFONT font = CreateFontW(
        pixel_height,
        0,
        0,
        0,
        weight,
        FALSE,
        FALSE,
        FALSE,
        DEFAULT_CHARSET,
        OUT_DEFAULT_PRECIS,
        CLIP_DEFAULT_PRECIS,
        CLEARTYPE_QUALITY,
        DEFAULT_PITCH | FF_DONTCARE,
        L"Segoe UI Variable Text");
    if (!font) {
        font = CreateFontW(
            pixel_height,
            0,
            0,
            0,
            weight,
            FALSE,
            FALSE,
            FALSE,
            DEFAULT_CHARSET,
            OUT_DEFAULT_PRECIS,
            CLIP_DEFAULT_PRECIS,
            CLEARTYPE_QUALITY,
            DEFAULT_PITCH | FF_DONTCARE,
            L"Segoe UI");
    }
    if (!font) {
        return Result<HFONT>::err(NativeError::make(
            "win32_font_failed",
            "CreateFontW failed with Win32 error " + std::to_string(GetLastError())));
    }
    return Result<HFONT>::ok(font);
}

void apply_dwm_studio_attributes(HWND hwnd) {
    const BOOL dark_mode = TRUE;
    (void)DwmSetWindowAttribute(
        hwnd,
        static_cast<DWMWINDOWATTRIBUTE>(20), // DWMWA_USE_IMMERSIVE_DARK_MODE
        &dark_mode,
        sizeof(dark_mode));

    const int corner_pref = 2; // DWMWCP_ROUND
    (void)DwmSetWindowAttribute(
        hwnd,
        static_cast<DWMWINDOWATTRIBUTE>(33), // DWMWA_WINDOW_CORNER_PREFERENCE
        &corner_pref,
        sizeof(corner_pref));

    const COLORREF caption_color = RGB(15, 20, 29);
    (void)DwmSetWindowAttribute(
        hwnd,
        static_cast<DWMWINDOWATTRIBUTE>(35), // DWMWA_CAPTION_COLOR
        &caption_color,
        sizeof(caption_color));

    const COLORREF text_color = RGB(236, 242, 250);
    (void)DwmSetWindowAttribute(
        hwnd,
        static_cast<DWMWINDOWATTRIBUTE>(36), // DWMWA_TEXT_COLOR
        &text_color,
        sizeof(text_color));

    const COLORREF border_color = RGB(40, 55, 77);
    (void)DwmSetWindowAttribute(
        hwnd,
        static_cast<DWMWINDOWATTRIBUTE>(34), // DWMWA_BORDER_COLOR
        &border_color,
        sizeof(border_color));

    const int backdrop_mica = 2; // DWMSBT_MAINWINDOW
    (void)DwmSetWindowAttribute(
        hwnd,
        static_cast<DWMWINDOWATTRIBUTE>(38), // DWMWA_SYSTEMBACKDROP_TYPE
        &backdrop_mica,
        sizeof(backdrop_mica));
}

void init_d2d_resources(WindowState& state, uint32_t dpi) {
    if (!state.d2d_factory) {
        ID2D1Factory* raw_factory = nullptr;
        if (SUCCEEDED(D2D1CreateFactory(
                D2D1_FACTORY_TYPE_SINGLE_THREADED,
                __uuidof(ID2D1Factory),
                nullptr,
                reinterpret_cast<void**>(&raw_factory)))) {
            state.d2d_factory.Attach(raw_factory);
        }
    }
    if (state.d2d_factory && !state.dc_target) {
        const D2D1_RENDER_TARGET_PROPERTIES props = D2D1::RenderTargetProperties(
            D2D1_RENDER_TARGET_TYPE_DEFAULT,
            D2D1::PixelFormat(DXGI_FORMAT_B8G8R8A8_UNORM, D2D1_ALPHA_MODE_IGNORE),
            96.0f,
            96.0f,
            D2D1_RENDER_TARGET_USAGE_NONE,
            D2D1_FEATURE_LEVEL_DEFAULT);
        state.d2d_factory->CreateDCRenderTarget(&props, &state.dc_target);
    }
    if (!state.dwrite_factory) {
        IUnknown* raw_dw = nullptr;
        if (SUCCEEDED(DWriteCreateFactory(
                DWRITE_FACTORY_TYPE_SHARED,
                __uuidof(IDWriteFactory),
                &raw_dw))) {
            state.dwrite_factory.Attach(static_cast<IDWriteFactory*>(raw_dw));
        }
    }
    if (state.dwrite_factory) {
        state.badge_format.Reset();
        const float font_px = static_cast<float>(scale_px(12, dpi));
        if (FAILED(state.dwrite_factory->CreateTextFormat(
                L"Segoe UI Variable Text",
                nullptr,
                DWRITE_FONT_WEIGHT_SEMI_BOLD,
                DWRITE_FONT_STYLE_NORMAL,
                DWRITE_FONT_STRETCH_NORMAL,
                font_px,
                L"en-us",
                &state.badge_format))) {
            state.dwrite_factory->CreateTextFormat(
                L"Segoe UI",
                nullptr,
                DWRITE_FONT_WEIGHT_SEMI_BOLD,
                DWRITE_FONT_STYLE_NORMAL,
                DWRITE_FONT_STRETCH_NORMAL,
                font_px,
                L"en-us",
                &state.badge_format);
        }
        if (state.badge_format) {
            state.badge_format->SetTextAlignment(DWRITE_TEXT_ALIGNMENT_TRAILING);
            state.badge_format->SetParagraphAlignment(DWRITE_PARAGRAPH_ALIGNMENT_CENTER);
        }
    }
}

Result<HWND> create_child(
    HWND parent,
    const wchar_t* class_name,
    std::string_view label,
    DWORD style,
    uint16_t id) {
    const std::wstring wlabel = utf8_to_wide(label);
    const HWND hwnd = CreateWindowExW(
        0,
        class_name,
        wlabel.c_str(),
        WS_CHILD | WS_VISIBLE | style,
        0,
        0,
        0,
        0,
        parent,
        reinterpret_cast<HMENU>(static_cast<uintptr_t>(id)),
        GetModuleHandleW(nullptr),
        nullptr);
    if (!hwnd) {
        return Result<HWND>::err(NativeError::make(
            "win32_child_failed",
            "CreateWindowExW failed for control " + std::to_string(id) +
                " with Win32 error " + std::to_string(GetLastError())));
    }
    return Result<HWND>::ok(hwnd);
}

ShellLayoutMetrics compute_layout(HWND hwnd, Mode active_mode, const ShellHandles* apply_handles) {
    ShellLayoutMetrics metrics{};
    RECT rect{};
    if (!GetClientRect(hwnd, &rect)) {
        return metrics;
    }
    const uint32_t dpi = window_dpi(hwnd);
    const auto s = [dpi](int32_t v) { return scale_px(v, dpi); };

    const int width = std::max<int>(rect.right - rect.left, 1);
    const int height = std::max<int>(rect.bottom - rect.top, 1);

    metrics.top_bar = RECT{0, 0, width, s(62)};

    const int mode_idx = static_cast<int>(active_mode);
    for (int i = 0; i < 3; ++i) {
        const int bx = s(22) + i * s(112);
        const int by = s(13);
        const int bw = s(104);
        const int bh = s(34);
        if (apply_handles && apply_handles->buttons[static_cast<size_t>(i)]) {
            MoveWindow(apply_handles->buttons[static_cast<size_t>(i)], bx, by, bw, bh, TRUE);
        }
        if (i == mode_idx) {
            metrics.active_pill = RECT{bx + s(8), by + bh + s(4), bx + bw - s(8), by + bh + s(7)};
        }
    }

    const int footer_y = std::max<int>(height - s(34), s(380));
    metrics.footer_line_y = footer_y - s(6);

    const int cards_top = s(72);
    const int cards_bottom = footer_y - s(12);

    const int left_card_x = s(18);
    const int left_card_w = s(306);
    metrics.left_card = RECT{left_card_x, cards_top, left_card_x + left_card_w, cards_bottom};

    const int panel_x = left_card_x + s(12);
    const int panel_y = cards_top + s(10);
    const int panel_w = s(282);
    const int panel_h = std::max<int>(cards_bottom - panel_y - s(8), s(560));

    const int right_card_x = left_card_x + left_card_w + s(14);
    const int right_card_w = std::max<int>(width - right_card_x - s(18), s(200));
    const int right_x = right_card_x + s(16);
    const int right_w = std::max<int>(right_card_w - s(32), 1);

    const int draft_h = s(124);
    const int draft_y = std::max<int>(cards_bottom - draft_h - s(14), s(250));
    const int draft_label_y = std::max<int>(draft_y - s(24), s(220));
    const int toolbar_y = std::max<int>(draft_label_y - s(36), s(180));

    const int composer_card_top = toolbar_y - s(14);
    const int mode_card_bottom = std::max<int>(composer_card_top - s(12), cards_top + s(80));
    metrics.mode_card = RECT{right_card_x, cards_top, right_card_x + right_card_w, mode_card_bottom};
    metrics.composer_card = RECT{right_card_x, composer_card_top, right_card_x + right_card_w, cards_bottom};

    const int heading_y = cards_top + s(14);
    const int heading_h = std::max<int>(mode_card_bottom - heading_y - s(12), s(64));

    if (apply_handles) {
        MoveWindow(apply_handles->heading, right_x, heading_y, right_w, heading_h, TRUE);

        const int cmd_w = std::min<int>(s(220), std::max<int>(right_w / 3, s(120)));
        MoveWindow(apply_handles->composer_cmd, right_x, toolbar_y, cmd_w, s(28), TRUE);

        const int btn_w = s(78);
        int cur_x = right_x + cmd_w + s(8);
        for (HWND sym_btn : apply_handles->sym_buttons) {
            MoveWindow(sym_btn, cur_x, toolbar_y, btn_w, s(28), TRUE);
            cur_x += btn_w + s(6);
        }
        const int badge_w = std::max<int>(right_x + right_w - cur_x, s(60));
        MoveWindow(apply_handles->composer_badge, cur_x, toolbar_y + s(4), badge_w, s(22), TRUE);

        MoveWindow(apply_handles->draft_label, right_x, draft_label_y, right_w, s(20), TRUE);
        MoveWindow(apply_handles->draft, right_x, draft_y, right_w, draft_h, TRUE);
        MoveWindow(
            apply_handles->status,
            s(22),
            footer_y,
            std::max<int>(width - s(44), 1),
            s(22),
            TRUE);
        MoveWindow(apply_handles->sessions, panel_x, panel_y, panel_w, panel_h, TRUE);
    }

    return metrics;
}

void paint_shell(HWND hwnd, HDC hdc, WindowState& state) {
    RECT client{};
    if (!GetClientRect(hwnd, &client)) {
        return;
    }
    const uint32_t dpi = window_dpi(hwnd);
    const ShellLayoutMetrics m = compute_layout(hwnd, state.active_mode, nullptr);

    if (!state.dc_target) {
        init_d2d_resources(state, dpi);
    }

    bool painted_d2d = false;
    if (state.dc_target && SUCCEEDED(state.dc_target->BindDC(hdc, &client))) {
        state.dc_target->BeginDraw();
        state.dc_target->Clear(D2D1::ColorF(0x0E131B));

        ComPtr<ID2D1SolidColorBrush> top_brush;
        ComPtr<ID2D1SolidColorBrush> card_brush;
        ComPtr<ID2D1SolidColorBrush> border_brush;
        ComPtr<ID2D1SolidColorBrush> accent_brush;
        ComPtr<ID2D1SolidColorBrush> subtle_text_brush;

        state.dc_target->CreateSolidColorBrush(D2D1::ColorF(0x131B26), &top_brush);
        state.dc_target->CreateSolidColorBrush(D2D1::ColorF(0x151E2B), &card_brush);
        state.dc_target->CreateSolidColorBrush(D2D1::ColorF(0x28374D), &border_brush);
        state.dc_target->CreateSolidColorBrush(D2D1::ColorF(0x38BDF8), &accent_brush);
        state.dc_target->CreateSolidColorBrush(D2D1::ColorF(0x7DD3FC, 0.85f), &subtle_text_brush);

        const auto to_d2d = [](const RECT& r) {
            return D2D1::RectF(
                static_cast<float>(r.left),
                static_cast<float>(r.top),
                static_cast<float>(r.right),
                static_cast<float>(r.bottom));
        };

        if (top_brush) {
            state.dc_target->FillRectangle(to_d2d(m.top_bar), top_brush.Get());
        }
        if (border_brush) {
            const float top_line_y = static_cast<float>(m.top_bar.bottom) - 0.5f;
            state.dc_target->DrawLine(
                D2D1::Point2F(0.0f, top_line_y),
                D2D1::Point2F(static_cast<float>(client.right), top_line_y),
                border_brush.Get(),
                1.0f);

            const float footer_line_y = static_cast<float>(m.footer_line_y) + 0.5f;
            state.dc_target->DrawLine(
                D2D1::Point2F(static_cast<float>(scale_px(18, dpi)), footer_line_y),
                D2D1::Point2F(static_cast<float>(client.right - scale_px(18, dpi)), footer_line_y),
                border_brush.Get(),
                1.0f);
        }

        if (accent_brush) {
            const float radius = static_cast<float>(scale_px(2, dpi));
            state.dc_target->FillRoundedRectangle(
                D2D1::RoundedRect(to_d2d(m.active_pill), radius, radius),
                accent_brush.Get());
        }

        const float card_radius = static_cast<float>(scale_px(8, dpi));
        for (const RECT& rc : {m.left_card, m.mode_card, m.composer_card}) {
            const D2D1_ROUNDED_RECT rr = D2D1::RoundedRect(to_d2d(rc), card_radius, card_radius);
            if (card_brush) {
                state.dc_target->FillRoundedRectangle(rr, card_brush.Get());
            }
            if (border_brush) {
                state.dc_target->DrawRoundedRectangle(rr, border_brush.Get(), 1.0f);
            }
        }

        if (state.badge_format && subtle_text_brush && client.right > scale_px(620, dpi)) {
            constexpr wchar_t kHeaderBadge[] =
                L"OMNIA STUDIO  \u00B7  C++20 / DWM MICA / DIRECT2D / UIA";
            const D2D1_RECT_F badge_rect = D2D1::RectF(
                static_cast<float>(scale_px(380, dpi)),
                static_cast<float>(scale_px(12, dpi)),
                static_cast<float>(client.right - scale_px(24, dpi)),
                static_cast<float>(scale_px(50, dpi)));
            state.dc_target->DrawText(
                kHeaderBadge,
                static_cast<UINT32>(std::char_traits<wchar_t>::length(kHeaderBadge)),
                state.badge_format.Get(),
                badge_rect,
                subtle_text_brush.Get(),
                D2D1_DRAW_TEXT_OPTIONS_CLIP);
        }

        const HRESULT end_hr = state.dc_target->EndDraw();
        if (SUCCEEDED(end_hr)) {
            painted_d2d = true;
        } else if (end_hr == static_cast<HRESULT>(D2DERR_RECREATE_TARGET)) {
            state.dc_target.Reset();
        }
    }

    if (!painted_d2d) {
        HBRUSH bg = CreateSolidBrush(kWindowBgColor);
        FillRect(hdc, &client, bg);
        DeleteObject(bg);
        for (const RECT& rc : {m.left_card, m.mode_card, m.composer_card}) {
            FillRect(hdc, &rc, state.card_brush);
        }
    }
}

void insert_domain_symbol(
    const ShellHandles& handles,
    RichComposer& composer,
    SymbolDomain domain) {
    const std::string filter = read_window_text_utf8(handles.composer_cmd);
    auto matches = search_symbol_palette(filter, domain);
    if (matches.empty()) {
        matches = search_symbol_palette("", domain);
    }
    if (matches.empty()) {
        return;
    }
    const SymbolEntry* entry = matches.front();

    const std::string current_draft = read_window_text_utf8(handles.draft);
    composer.set_plain_text(current_draft);
    const size_t caret = utf8_char_count(current_draft);
    auto inserted = composer.insert_symbol_at_caret(entry->id, caret, false);
    if (inserted.is_ok()) {
        const std::string updated = composer.plain_text_projection();
        set_window_text_utf8(handles.draft, updated);
        const std::string badge =
            "Inserted " + std::string(entry->glyph_preview) + " (" +
            std::string(entry->title) + ") \xE2\x80\xA2 Tray: " +
            std::to_string(composer.tray.size());
        set_window_text_utf8(handles.composer_badge, badge);
    }
}

Result<std::unique_ptr<WindowState>> initialize_shell(HWND hwnd) {
    apply_dwm_studio_attributes(hwnd);

    auto state = std::make_unique<WindowState>();
    state->card_brush = CreateSolidBrush(kCardBgColor);
    state->input_brush = CreateSolidBrush(kInputBgColor);
    state->footer_brush = CreateSolidBrush(kFooterBgColor);

    auto btn_chat = create_child(hwnd, L"BUTTON", "Chat", WS_TABSTOP | BS_PUSHBUTTON, 101);
    if (btn_chat.is_err()) return Result<std::unique_ptr<WindowState>>::err(btn_chat.error());
    auto btn_browser = create_child(hwnd, L"BUTTON", "Browser", WS_TABSTOP | BS_PUSHBUTTON, 102);
    if (btn_browser.is_err()) return Result<std::unique_ptr<WindowState>>::err(btn_browser.error());
    auto btn_ide = create_child(hwnd, L"BUTTON", "IDE", WS_TABSTOP | BS_PUSHBUTTON, 103);
    if (btn_ide.is_err()) return Result<std::unique_ptr<WindowState>>::err(btn_ide.error());

    uia::attach_button(btn_chat.value(), "101", "Chat");
    uia::attach_button(btn_browser.value(), "102", "Browser");
    uia::attach_button(btn_ide.value(), "103", "IDE");
    for (HWND b : {btn_chat.value(), btn_browser.value(), btn_ide.value()}) {
        SetWindowTheme(b, L"DarkMode_Explorer", nullptr);
    }

    auto heading = create_child(hwnd, L"STATIC", mode_description(Mode::Chat), 0, 110);
    if (heading.is_err()) return Result<std::unique_ptr<WindowState>>::err(heading.error());

    // Single-line accessible composer symbol/equation input (ID = 114), exposing
    // server-side UIA ControlType.Edit (50004) + ValuePattern while keeping
    // multiline draft (ID = 112) as standard ControlType.Document + TextPattern.
    auto composer_cmd = create_child(
        hwnd, L"EDIT", "", WS_TABSTOP | WS_BORDER | ES_AUTOHSCROLL, 114);
    if (composer_cmd.is_err()) return Result<std::unique_ptr<WindowState>>::err(composer_cmd.error());
    SendMessageW(composer_cmd.value(), EM_SETLIMITTEXT, 512, 0);
    uia::attach_edit(composer_cmd.value(), "114", "Rich composer symbol & command input");
    SetWindowTheme(composer_cmd.value(), L"DarkMode_Explorer", nullptr);

    auto sym_math = create_child(hwnd, L"BUTTON", "\xE2\x88\x91 Math", WS_TABSTOP | BS_PUSHBUTTON, 115);
    if (sym_math.is_err()) return Result<std::unique_ptr<WindowState>>::err(sym_math.error());
    auto sym_phys = create_child(hwnd, L"BUTTON", "\xE2\x84\x8F Phys", WS_TABSTOP | BS_PUSHBUTTON, 116);
    if (sym_phys.is_err()) return Result<std::unique_ptr<WindowState>>::err(sym_phys.error());
    auto sym_chem = create_child(hwnd, L"BUTTON", "\xE2\x87\x8C Chem", WS_TABSTOP | BS_PUSHBUTTON, 117);
    if (sym_chem.is_err()) return Result<std::unique_ptr<WindowState>>::err(sym_chem.error());

    uia::attach_button(sym_math.value(), "115", "\xE2\x88\x91 Math");
    uia::attach_button(sym_phys.value(), "116", "\xE2\x84\x8F Phys");
    uia::attach_button(sym_chem.value(), "117", "\xE2\x87\x8C Chem");
    for (HWND b : {sym_math.value(), sym_phys.value(), sym_chem.value()}) {
        SetWindowTheme(b, L"DarkMode_Explorer", nullptr);
    }

    auto composer_badge = create_child(
        hwnd,
        L"STATIC",
        "Palette: 15 Math/Phys/Chem templates \xE2\x80\xA2 Tray: 0",
        0,
        118);
    if (composer_badge.is_err()) {
        return Result<std::unique_ptr<WindowState>>::err(composer_badge.error());
    }

    auto draft_label = create_child(
        hwnd,
        L"STATIC",
        "Shared scratch draft \xE2\x80\x94 kept across modes, not saved to a session",
        0,
        111);
    if (draft_label.is_err()) return Result<std::unique_ptr<WindowState>>::err(draft_label.error());

    auto draft = create_child(
        hwnd,
        L"EDIT",
        "",
        WS_TABSTOP | WS_BORDER | WS_VSCROLL | ES_MULTILINE | ES_AUTOVSCROLL | ES_WANTRETURN,
        112);
    if (draft.is_err()) return Result<std::unique_ptr<WindowState>>::err(draft.error());
    SendMessageW(draft.value(), EM_SETLIMITTEXT, 64 * 1024, 0);
    SetWindowTheme(draft.value(), L"DarkMode_Explorer", nullptr);

    auto status = create_child(
        hwnd,
        L"STATIC",
        "C++20 / Win32  \xE2\x80\xA2  DWM Mica + Direct2D  \xE2\x80\xA2  Server-Side UIA  \xE2\x80\xA2  No WebView / No Node runtime",
        0,
        113);
    if (status.is_err()) return Result<std::unique_ptr<WindowState>>::err(status.error());

    const uint32_t dpi = window_dpi(hwnd);
    auto font = create_scaled_font(dpi, FW_NORMAL, 16);
    if (font.is_err()) return Result<std::unique_ptr<WindowState>>::err(font.error());
    state->font = font.value();

    auto bold_font = create_scaled_font(dpi, FW_SEMIBOLD, 16);
    if (bold_font.is_err()) return Result<std::unique_ptr<WindowState>>::err(bold_font.error());
    state->bold_font = bold_font.value();

    init_d2d_resources(*state, dpi);

    for (HWND b : {btn_chat.value(), btn_browser.value(), btn_ide.value()}) {
        SendMessageW(b, WM_SETFONT, reinterpret_cast<WPARAM>(state->bold_font), TRUE);
    }
    for (HWND ctrl : {
             heading.value(),
             composer_cmd.value(),
             sym_math.value(),
             sym_phys.value(),
             sym_chem.value(),
             composer_badge.value(),
             draft_label.value(),
             draft.value(),
             status.value(),
         }) {
        SendMessageW(ctrl, WM_SETFONT, reinterpret_cast<WPARAM>(state->font), TRUE);
    }

    auto sessions = create_session_panel(hwnd, state->font, state->bold_font);
    if (sessions.is_err()) {
        return Result<std::unique_ptr<WindowState>>::err(sessions.error());
    }

    state->handles = ShellHandles{
        {btn_chat.value(), btn_browser.value(), btn_ide.value()},
        heading.value(),
        composer_cmd.value(),
        {sym_math.value(), sym_phys.value(), sym_chem.value()},
        composer_badge.value(),
        draft_label.value(),
        draft.value(),
        status.value(),
        sessions.value(),
    };

    return Result<std::unique_ptr<WindowState>>::ok(std::move(state));
}

LRESULT CALLBACK shell_window_proc(HWND hwnd, UINT message, WPARAM wparam, LPARAM lparam) {
    switch (message) {
        case WM_CREATE: {
            auto initialized = initialize_shell(hwnd);
            if (initialized.is_err()) {
                show_startup_error(initialized.error().message);
                return -1;
            }
            auto* raw = initialized.value().release();
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(raw));
            (void)compute_layout(hwnd, raw->active_mode, &raw->handles);
            SetFocus(raw->handles.draft);
            return 0;
        }
        case WM_GETMINMAXINFO: {
            const uint32_t dpi = window_dpi(hwnd);
            auto* info = reinterpret_cast<MINMAXINFO*>(lparam);
            info->ptMinTrackSize.x = scale_px(1000, dpi);
            info->ptMinTrackSize.y = scale_px(820, dpi);
            return 0;
        }
        case WM_SIZE: {
            if (auto* state = reinterpret_cast<WindowState*>(GetWindowLongPtrW(hwnd, GWLP_USERDATA))) {
                (void)compute_layout(hwnd, state->active_mode, &state->handles);
                InvalidateRect(hwnd, nullptr, FALSE);
            }
            return 0;
        }
        case WM_DPICHANGED: {
            const uint32_t new_dpi = std::max<uint32_t>(HIWORD(wparam), 96u);
            if (auto* state = reinterpret_cast<WindowState*>(GetWindowLongPtrW(hwnd, GWLP_USERDATA))) {
                auto new_font = create_scaled_font(new_dpi, FW_NORMAL, 16);
                auto new_bold = create_scaled_font(new_dpi, FW_SEMIBOLD, 16);
                if (new_font.is_ok() && new_bold.is_ok()) {
                    const HFONT old_font = state->font;
                    const HFONT old_bold = state->bold_font;
                    state->font = new_font.value();
                    state->bold_font = new_bold.value();
                    init_d2d_resources(*state, new_dpi);

                    for (HWND b : state->handles.buttons) {
                        SendMessageW(b, WM_SETFONT, reinterpret_cast<WPARAM>(state->bold_font), TRUE);
                    }
                    for (HWND ctrl : {
                             state->handles.heading,
                             state->handles.composer_cmd,
                             state->handles.sym_buttons[0],
                             state->handles.sym_buttons[1],
                             state->handles.sym_buttons[2],
                             state->handles.composer_badge,
                             state->handles.draft_label,
                             state->handles.draft,
                             state->handles.status,
                         }) {
                        SendMessageW(ctrl, WM_SETFONT, reinterpret_cast<WPARAM>(state->font), TRUE);
                    }
                    session_panel_apply_fonts_and_relayout(
                        state->handles.sessions, state->font, state->bold_font);
                    if (old_font) DeleteObject(old_font);
                    if (old_bold) DeleteObject(old_bold);
                } else {
                    if (new_font.is_ok()) DeleteObject(new_font.value());
                    if (new_bold.is_ok()) DeleteObject(new_bold.value());
                }

                if (lparam != 0) {
                    const auto* suggested = reinterpret_cast<const RECT*>(lparam);
                    SetWindowPos(
                        hwnd,
                        nullptr,
                        suggested->left,
                        suggested->top,
                        suggested->right - suggested->left,
                        suggested->bottom - suggested->top,
                        SWP_NOZORDER | SWP_NOACTIVATE);
                }
                (void)compute_layout(hwnd, state->active_mode, &state->handles);
                InvalidateRect(hwnd, nullptr, FALSE);
            }
            return 0;
        }
        case WM_ERASEBKGND:
            return 1;
        case WM_PAINT: {
            PAINTSTRUCT ps{};
            const HDC hdc = BeginPaint(hwnd, &ps);
            if (auto* state = reinterpret_cast<WindowState*>(GetWindowLongPtrW(hwnd, GWLP_USERDATA))) {
                paint_shell(hwnd, hdc, *state);
            }
            EndPaint(hwnd, &ps);
            return 0;
        }
        case WM_PRINTCLIENT: {
            if (auto* state = reinterpret_cast<WindowState*>(GetWindowLongPtrW(hwnd, GWLP_USERDATA))) {
                paint_shell(hwnd, reinterpret_cast<HDC>(wparam), *state);
                return 0;
            }
            break;
        }
        case WM_CTLCOLORSTATIC: {
            if (auto* state = reinterpret_cast<WindowState*>(GetWindowLongPtrW(hwnd, GWLP_USERDATA))) {
                const HDC hdc = reinterpret_cast<HDC>(wparam);
                const HWND ctrl = reinterpret_cast<HWND>(lparam);
                SetBkMode(hdc, OPAQUE);
                if (ctrl == state->handles.status) {
                    SetBkColor(hdc, kFooterBgColor);
                    SetTextColor(hdc, kTextMuted);
                    return reinterpret_cast<LRESULT>(state->footer_brush);
                }
                SetBkColor(hdc, kCardBgColor);
                if (ctrl == state->handles.composer_badge) {
                    SetTextColor(hdc, kTextBadge);
                } else if (ctrl == state->handles.draft_label) {
                    SetTextColor(hdc, kTextMuted);
                } else {
                    SetTextColor(hdc, kTextPrimary);
                }
                return reinterpret_cast<LRESULT>(state->card_brush);
            }
            break;
        }
        case WM_CTLCOLOREDIT: {
            if (auto* state = reinterpret_cast<WindowState*>(GetWindowLongPtrW(hwnd, GWLP_USERDATA))) {
                const HDC hdc = reinterpret_cast<HDC>(wparam);
                SetBkMode(hdc, OPAQUE);
                SetBkColor(hdc, kInputBgColor);
                SetTextColor(hdc, kTextPrimary);
                return reinterpret_cast<LRESULT>(state->input_brush);
            }
            break;
        }
        case WM_COMMAND: {
            if (auto* state = reinterpret_cast<WindowState*>(GetWindowLongPtrW(hwnd, GWLP_USERDATA))) {
                if (HIWORD(wparam) == BN_CLICKED) {
                    const uint16_t id = static_cast<uint16_t>(LOWORD(wparam));
                    const HWND sender = reinterpret_cast<HWND>(lparam);
                    if (auto mode = mode_from_command(id)) {
                        const size_t idx = static_cast<size_t>(id - 101);
                        if (idx < state->handles.buttons.size() &&
                            state->handles.buttons[idx] == sender) {
                            state->active_mode = *mode;
                            set_window_text_utf8(state->handles.heading, mode_description(*mode));
                            InvalidateRect(hwnd, nullptr, FALSE);
                            SetFocus(state->handles.draft);
                        }
                    } else if (id == 115 && state->handles.sym_buttons[0] == sender) {
                        insert_domain_symbol(state->handles, *state->composer, SymbolDomain::Mathematics);
                    } else if (id == 116 && state->handles.sym_buttons[1] == sender) {
                        insert_domain_symbol(state->handles, *state->composer, SymbolDomain::Physics);
                    } else if (id == 117 && state->handles.sym_buttons[2] == sender) {
                        insert_domain_symbol(state->handles, *state->composer, SymbolDomain::Chemistry);
                    }
                }
            }
            return 0;
        }
        case WM_CLOSE: {
            if (auto* state = reinterpret_cast<WindowState*>(GetWindowLongPtrW(hwnd, GWLP_USERDATA))) {
                const ShellHandles handles = state->handles;
                if (!session_panel_can_close(handles.sessions)) {
                    return 0;
                }
                if (GetWindowTextLengthW(handles.draft) > 0) {
                    const int choice = uia::modal_message_box(
                        hwnd,
                        L"This draft is not saved. Close and discard it?",
                        L"Omnia \u2014 unsaved draft",
                        MB_YESNO | MB_ICONWARNING | MB_DEFBUTTON2);
                    if (choice != IDYES) {
                        return 0;
                    }
                }
            }
            DestroyWindow(hwnd);
            return 0;
        }
        case WM_DESTROY:
            PostQuitMessage(0);
            return 0;
        case WM_NCDESTROY: {
            auto* state = reinterpret_cast<WindowState*>(GetWindowLongPtrW(hwnd, GWLP_USERDATA));
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
            delete state;
            return DefWindowProcW(hwnd, message, wparam, lparam);
        }
        default:
            break;
    }
    return DefWindowProcW(hwnd, message, wparam, lparam);
}

} // namespace

void show_startup_error(std::string_view message) {
    const std::wstring wide = utf8_to_wide(message);
    MessageBoxW(
        nullptr,
        wide.c_str(),
        L"Omnia native startup error",
        MB_OK | MB_ICONERROR);
}

Result<void> run_native_shell() {
    const HRESULT com_hr = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    if (FAILED(com_hr)) {
        return Result<void>::err(NativeError::make(
            "com_init_failed",
            "CoInitializeEx failed with HRESULT " + std::to_string(com_hr)));
    }
    ComApartmentGuard com_guard{true};

    INITCOMMONCONTROLSEX icc{};
    icc.dwSize = sizeof(icc);
    icc.dwICC = ICC_STANDARD_CLASSES | ICC_WIN95_CLASSES;
    InitCommonControlsEx(&icc);

    const HINSTANCE instance = GetModuleHandleW(nullptr);
    WNDCLASSEXW wc{};
    wc.cbSize = sizeof(wc);
    wc.lpfnWndProc = &shell_window_proc;
    wc.hInstance = instance;
    wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    wc.hIcon = LoadIconW(nullptr, IDI_APPLICATION);
    wc.hIconSm = LoadIconW(nullptr, IDI_APPLICATION);
    wc.hbrBackground = nullptr;
    wc.lpszClassName = kShellClassName;

    if (RegisterClassExW(&wc) == 0 && GetLastError() != ERROR_CLASS_ALREADY_EXISTS) {
        return Result<void>::err(NativeError::make(
            "win32_register_failed",
            "RegisterClassExW failed with Win32 error " + std::to_string(GetLastError())));
    }

    const HWND hwnd = CreateWindowExW(
        0,
        kShellClassName,
        kShellWindowTitle,
        WS_OVERLAPPEDWINDOW | WS_CLIPCHILDREN,
        CW_USEDEFAULT,
        CW_USEDEFAULT,
        1220,
        820,
        nullptr,
        nullptr,
        instance,
        nullptr);
    if (!hwnd) {
        return Result<void>::err(NativeError::make(
            "win32_window_failed",
            "CreateWindowExW failed with Win32 error " + std::to_string(GetLastError())));
    }

    ShowWindow(hwnd, SW_SHOW);
    UpdateWindow(hwnd);

    MSG message{};
    while (true) {
        const BOOL res = GetMessageW(&message, nullptr, 0, 0);
        if (res == -1) {
            return Result<void>::err(NativeError::make(
                "win32_message_loop_failed",
                "GetMessageW failed with Win32 error " + std::to_string(GetLastError())));
        }
        if (res == 0) {
            return Result<void>::ok();
        }
        if (!IsDialogMessageW(hwnd, &message)) {
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    }
}

} // namespace omnia::native
