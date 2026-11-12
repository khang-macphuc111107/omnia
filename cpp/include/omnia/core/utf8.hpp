#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <string_view>

namespace omnia::core {

bool is_valid_utf8(std::string_view text) noexcept;
bool decode_next_utf8(std::string_view text, std::size_t& index, char32_t& out_cp) noexcept;
void append_utf8(std::string& out, char32_t cp);

std::size_t utf8_codepoint_count(std::string_view text) noexcept;

/// Truncates `text` to at most `max_codepoints` Unicode scalar values without ever
/// splitting a multi-byte UTF-8 sequence. If `suffix` is provided and truncation occurs,
/// `suffix` is appended while keeping total codepoints <= `max_codepoints` when possible.
std::string truncate_utf8_codepoints(
    std::string_view text,
    std::size_t max_codepoints,
    std::string_view suffix = ""
);

/// Truncates `text` on a word boundary (whitespace/punctuation) at or below `max_codepoints`
/// without splitting multi-byte UTF-8 codepoints. Falls back to codepoint boundary if a
/// single unbroken token exceeds the budget.
std::string truncate_utf8_words(
    std::string_view text,
    std::size_t max_codepoints,
    std::string_view suffix = "..."
);

} // namespace omnia::core
