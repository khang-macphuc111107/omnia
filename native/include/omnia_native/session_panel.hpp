#pragma once

#include <windows.h>

#include "omnia_native/types.hpp"

#include <cstdint>
#include <filesystem>
#include <optional>
#include <string>
#include <vector>

namespace omnia::native {

uint32_t window_dpi(HWND hwnd) noexcept;
int32_t scale_px(int32_t px, uint32_t dpi) noexcept;

Result<std::optional<std::filesystem::path>> parse_session_db_args(
    const std::vector<std::wstring>& args);

Result<HWND> create_session_panel(HWND parent, HFONT font, HFONT bold_font);
void session_panel_apply_fonts_and_relayout(HWND panel, HFONT font, HFONT bold_font);
bool session_panel_can_close(HWND panel);

} // namespace omnia::native
