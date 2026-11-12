#include "omnia/core/utf8.hpp"

#include <stdexcept>
#include <vector>

namespace omnia::core {

bool decode_next_utf8(std::string_view text, std::size_t& index, char32_t& out_cp) noexcept {
    if (index >= text.size()) {
        return false;
    }
    const auto b0 = static_cast<unsigned char>(text[index]);
    if (b0 < 0x80U) {
        out_cp = static_cast<char32_t>(b0);
        index += 1;
        return true;
    }
    if ((b0 & 0xE0U) == 0xC0U) {
        if (index + 1 >= text.size()) {
            return false;
        }
        const auto b1 = static_cast<unsigned char>(text[index + 1]);
        if ((b1 & 0xC0U) != 0x80U) {
            return false;
        }
        const char32_t cp = (static_cast<char32_t>(b0 & 0x1FU) << 6U) |
                            static_cast<char32_t>(b1 & 0x3FU);
        if (cp < 0x80U) {
            return false; // Overlong 2-byte encoding
        }
        out_cp = cp;
        index += 2;
        return true;
    }
    if ((b0 & 0xF0U) == 0xE0U) {
        if (index + 2 >= text.size()) {
            return false;
        }
        const auto b1 = static_cast<unsigned char>(text[index + 1]);
        const auto b2 = static_cast<unsigned char>(text[index + 2]);
        if ((b1 & 0xC0U) != 0x80U || (b2 & 0xC0U) != 0x80U) {
            return false;
        }
        const char32_t cp = (static_cast<char32_t>(b0 & 0x0FU) << 12U) |
                            (static_cast<char32_t>(b1 & 0x3FU) << 6U) |
                            static_cast<char32_t>(b2 & 0x3FU);
        if (cp < 0x800U || (cp >= 0xD800U && cp <= 0xDFFFU)) {
            return false; // Overlong or UTF-16 surrogate
        }
        out_cp = cp;
        index += 3;
        return true;
    }
    if ((b0 & 0xF8U) == 0xF0U) {
        if (index + 3 >= text.size()) {
            return false;
        }
        const auto b1 = static_cast<unsigned char>(text[index + 1]);
        const auto b2 = static_cast<unsigned char>(text[index + 2]);
        const auto b3 = static_cast<unsigned char>(text[index + 3]);
        if ((b1 & 0xC0U) != 0x80U || (b2 & 0xC0U) != 0x80U || (b3 & 0xC0U) != 0x80U) {
            return false;
        }
        const char32_t cp = (static_cast<char32_t>(b0 & 0x07U) << 18U) |
                            (static_cast<char32_t>(b1 & 0x3FU) << 12U) |
                            (static_cast<char32_t>(b2 & 0x3FU) << 6U) |
                            static_cast<char32_t>(b3 & 0x3FU);
        if (cp < 0x10000U || cp > 0x10FFFFU) {
            return false;
        }
        out_cp = cp;
        index += 4;
        return true;
    }
    return false;
}

void append_utf8(std::string& out, char32_t cp) {
    if (cp > 0x10FFFFU || (cp >= 0xD800U && cp <= 0xDFFFU)) {
        throw std::invalid_argument("Invalid Unicode scalar value for UTF-8 encoding");
    }
    if (cp < 0x80U) {
        out.push_back(static_cast<char>(cp));
    } else if (cp < 0x800U) {
        out.push_back(static_cast<char>(0xC0U | ((cp >> 6U) & 0x1FU)));
        out.push_back(static_cast<char>(0x80U | (cp & 0x3FU)));
    } else if (cp < 0x10000U) {
        out.push_back(static_cast<char>(0xE0U | ((cp >> 12U) & 0x0FU)));
        out.push_back(static_cast<char>(0x80U | ((cp >> 6U) & 0x3FU)));
        out.push_back(static_cast<char>(0x80U | (cp & 0x3FU)));
    } else {
        out.push_back(static_cast<char>(0xF0U | ((cp >> 18U) & 0x07U)));
        out.push_back(static_cast<char>(0x80U | ((cp >> 12U) & 0x3FU)));
        out.push_back(static_cast<char>(0x80U | ((cp >> 6U) & 0x3FU)));
        out.push_back(static_cast<char>(0x80U | (cp & 0x3FU)));
    }
}

bool is_valid_utf8(std::string_view text) noexcept {
    std::size_t idx = 0;
    char32_t cp = 0;
    while (idx < text.size()) {
        if (!decode_next_utf8(text, idx, cp)) {
            return false;
        }
    }
    return true;
}

std::size_t utf8_codepoint_count(std::string_view text) noexcept {
    std::size_t idx = 0;
    std::size_t count = 0;
    char32_t cp = 0;
    while (idx < text.size()) {
        if (decode_next_utf8(text, idx, cp)) {
            ++count;
        } else {
            ++idx;
            ++count;
        }
    }
    return count;
}

namespace {

bool is_word_break_cp(char32_t cp) noexcept {
    return cp == U' ' || cp == U'\t' || cp == U'\n' || cp == U'\r' ||
           cp == U',' || cp == U';' || cp == U'.' || cp == U':' ||
           cp == U'/' || cp == U'-' || cp == U'!' || cp == U'?';
}

struct CodepointSpan {
    std::size_t byte_start = 0;
    std::size_t byte_end = 0;
    char32_t cp = 0;
};

std::vector<CodepointSpan> scan_codepoints_safe(std::string_view text) {
    std::vector<CodepointSpan> spans;
    spans.reserve(text.size());
    std::size_t idx = 0;
    while (idx < text.size()) {
        const std::size_t start = idx;
        char32_t cp = 0;
        if (decode_next_utf8(text, idx, cp)) {
            spans.push_back(CodepointSpan{start, idx, cp});
        } else {
            // Skip invalid byte without including broken UTF-8 tail
            break;
        }
    }
    return spans;
}

} // namespace

std::string truncate_utf8_codepoints(
    std::string_view text,
    std::size_t max_codepoints,
    std::string_view suffix
) {
    if (max_codepoints == 0) {
        return {};
    }
    const auto spans = scan_codepoints_safe(text);
    const bool had_invalid_tail = !spans.empty()
        ? (spans.back().byte_end < text.size())
        : !text.empty();

    if (!had_invalid_tail && spans.size() <= max_codepoints) {
        return std::string(text);
    }
    if (spans.size() <= max_codepoints) {
        const std::size_t valid_end = spans.empty() ? 0 : spans.back().byte_end;
        return std::string(text.substr(0, valid_end));
    }

    const std::size_t suffix_cps = utf8_codepoint_count(suffix);
    if (suffix.empty() || suffix_cps >= max_codepoints) {
        const std::size_t cut_end = spans[max_codepoints - 1].byte_end;
        return std::string(text.substr(0, cut_end));
    }

    const std::size_t keep_cps = max_codepoints - suffix_cps;
    const std::size_t cut_end = keep_cps == 0 ? 0 : spans[keep_cps - 1].byte_end;
    std::string out;
    out.reserve(cut_end + suffix.size());
    out.append(text.substr(0, cut_end));
    out.append(suffix);
    return out;
}

std::string truncate_utf8_words(
    std::string_view text,
    std::size_t max_codepoints,
    std::string_view suffix
) {
    if (max_codepoints == 0) {
        return {};
    }
    const auto spans = scan_codepoints_safe(text);
    const bool had_invalid_tail = !spans.empty()
        ? (spans.back().byte_end < text.size())
        : !text.empty();
    if (!had_invalid_tail && spans.size() <= max_codepoints) {
        return std::string(text);
    }
    if (spans.size() <= max_codepoints) {
        const std::size_t valid_end = spans.empty() ? 0 : spans.back().byte_end;
        return std::string(text.substr(0, valid_end));
    }

    const std::size_t suffix_cps = utf8_codepoint_count(suffix);
    const std::size_t target_cps = (suffix.empty() || suffix_cps >= max_codepoints)
        ? max_codepoints
        : (max_codepoints - suffix_cps);

    if (target_cps == 0) {
        return truncate_utf8_codepoints(suffix, max_codepoints);
    }

    std::size_t best_break_idx = 0;
    bool found_break = false;
    // Scan up to target_cps (inclusive check on boundary right at target_cps)
    if (target_cps < spans.size() && is_word_break_cp(spans[target_cps].cp)) {
        best_break_idx = target_cps;
        found_break = true;
    } else {
        for (std::size_t i = target_cps; i > 0; --i) {
            if (is_word_break_cp(spans[i - 1].cp)) {
                best_break_idx = i - 1;
                found_break = true;
                break;
            }
        }
    }

    // Strip trailing whitespace before suffix
    if (found_break && best_break_idx > 0) {
        while (best_break_idx > 0 &&
               (spans[best_break_idx - 1].cp == U' ' ||
                spans[best_break_idx - 1].cp == U'\t' ||
                spans[best_break_idx - 1].cp == U'\n' ||
                spans[best_break_idx - 1].cp == U'\r')) {
            --best_break_idx;
        }
    }

    const std::size_t keep_cps = (found_break && best_break_idx > 0) ? best_break_idx : target_cps;
    const std::size_t cut_end = keep_cps == 0 ? 0 : spans[keep_cps - 1].byte_end;
    std::string out;
    out.reserve(cut_end + suffix.size());
    out.append(text.substr(0, cut_end));
    if (!suffix.empty() && suffix_cps < max_codepoints) {
        out.append(suffix);
    }
    return out;
}

} // namespace omnia::core
