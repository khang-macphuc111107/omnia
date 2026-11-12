#include "omnia/core/json.hpp"
#include "omnia/core/utf8.hpp"

#include <charconv>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <limits>

namespace omnia::core {

namespace {

constexpr std::size_t kMaxJsonDepth = 128;

class Parser {
public:
    explicit Parser(std::string_view src) noexcept : src_(src) {}

    JsonValue parse_root() {
        skip_ws();
        JsonValue val = parse_value(0);
        skip_ws();
        if (pos_ != src_.size()) {
            fail("Unexpected trailing token after root JSON value");
        }
        return val;
    }

private:
    std::string_view src_;
    std::size_t pos_ = 0;

    [[noreturn]] void fail(const char* msg) const {
        throw JsonParseError(msg, pos_);
    }

    void skip_ws() noexcept {
        while (pos_ < src_.size()) {
            const char c = src_[pos_];
            if (c == ' ' || c == '\t' || c == '\r' || c == '\n') {
                ++pos_;
            } else {
                break;
            }
        }
    }

    char peek() const {
        if (pos_ >= src_.size()) {
            fail("Unexpected end of JSON input");
        }
        return src_[pos_];
    }

    JsonValue parse_value(std::size_t depth) {
        if (depth > kMaxJsonDepth) {
            fail("JSON nesting depth exceeds maximum limit");
        }
        skip_ws();
        const char c = peek();
        switch (c) {
            case 'n': return parse_null();
            case 't': return parse_true();
            case 'f': return parse_false();
            case '"': return JsonValue(parse_string());
            case '[': return parse_array(depth + 1);
            case '{': return parse_object(depth + 1);
            default:
                if (c == '-' || (c >= '0' && c <= '9')) {
                    return parse_number();
                }
                fail("Invalid token in JSON value");
        }
    }

    JsonValue parse_null() {
        if (src_.substr(pos_, 4) != "null") {
            fail("Invalid literal, expected 'null'");
        }
        pos_ += 4;
        return JsonValue(nullptr);
    }

    JsonValue parse_true() {
        if (src_.substr(pos_, 4) != "true") {
            fail("Invalid literal, expected 'true'");
        }
        pos_ += 4;
        return JsonValue(true);
    }

    JsonValue parse_false() {
        if (src_.substr(pos_, 5) != "false") {
            fail("Invalid literal, expected 'false'");
        }
        pos_ += 5;
        return JsonValue(false);
    }

    std::uint16_t parse_hex4() {
        if (pos_ + 4 > src_.size()) {
            fail("Incomplete \\uXXXX escape in JSON string");
        }
        std::uint16_t val = 0;
        for (int i = 0; i < 4; ++i) {
            const char ch = src_[pos_ + static_cast<std::size_t>(i)];
            val = static_cast<std::uint16_t>(val << 4U);
            if (ch >= '0' && ch <= '9') {
                val = static_cast<std::uint16_t>(val | static_cast<std::uint16_t>(ch - '0'));
            } else if (ch >= 'a' && ch <= 'f') {
                val = static_cast<std::uint16_t>(val | static_cast<std::uint16_t>(10 + (ch - 'a')));
            } else if (ch >= 'A' && ch <= 'F') {
                val = static_cast<std::uint16_t>(val | static_cast<std::uint16_t>(10 + (ch - 'A')));
            } else {
                fail("Invalid hex digit in \\uXXXX escape");
            }
        }
        pos_ += 4;
        return val;
    }

    std::string parse_string() {
        if (peek() != '"') {
            fail("Expected '\"' to start JSON string");
        }
        ++pos_;
        std::string out;
        while (pos_ < src_.size()) {
            const auto uc = static_cast<unsigned char>(src_[pos_]);
            if (uc == '"') {
                ++pos_;
                if (!is_valid_utf8(out)) {
                    fail("Invalid UTF-8 byte sequence in JSON string");
                }
                return out;
            }
            if (uc < 0x20U) {
                fail("Unescaped control character in JSON string");
            }
            if (uc != '\\') {
                out.push_back(static_cast<char>(uc));
                ++pos_;
                continue;
            }
            ++pos_;
            if (pos_ >= src_.size()) {
                fail("Unterminated escape sequence in JSON string");
            }
            const char esc = src_[pos_++];
            switch (esc) {
                case '"': out.push_back('"'); break;
                case '\\': out.push_back('\\'); break;
                case '/': out.push_back('/'); break;
                case 'b': out.push_back('\b'); break;
                case 'f': out.push_back('\f'); break;
                case 'n': out.push_back('\n'); break;
                case 'r': out.push_back('\r'); break;
                case 't': out.push_back('\t'); break;
                case 'u': {
                    const std::uint16_t code1 = parse_hex4();
                    if (code1 >= 0xD800U && code1 <= 0xDBFFU) {
                        // High surrogate must be followed by \uDC00..\uDFFF
                        if (pos_ + 2 > src_.size() || src_[pos_] != '\\' || src_[pos_ + 1] != 'u') {
                            fail("Unpaired high UTF-16 surrogate in JSON string");
                        }
                        pos_ += 2;
                        const std::uint16_t code2 = parse_hex4();
                        if (code2 < 0xDC00U || code2 > 0xDFFFU) {
                            fail("Invalid low UTF-16 surrogate in JSON string");
                        }
                        const char32_t cp = 0x10000U +
                            ((static_cast<char32_t>(code1 - 0xD800U) << 10U) |
                             static_cast<char32_t>(code2 - 0xDC00U));
                        append_utf8(out, cp);
                    } else if (code1 >= 0xDC00U && code1 <= 0xDFFFU) {
                        fail("Unexpected lone low UTF-16 surrogate in JSON string");
                    } else {
                        append_utf8(out, static_cast<char32_t>(code1));
                    }
                    break;
                }
                default:
                    fail("Invalid escape character in JSON string");
            }
        }
        fail("Unterminated JSON string");
    }

    JsonValue parse_number() {
        const std::size_t start = pos_;
        if (src_[pos_] == '-') {
            ++pos_;
            if (pos_ >= src_.size()) {
                fail("Incomplete negative number");
            }
        }
        if (src_[pos_] == '0') {
            ++pos_;
            if (pos_ < src_.size() && src_[pos_] >= '0' && src_[pos_] <= '9') {
                fail("Leading zeros are not permitted in JSON numbers");
            }
        } else if (src_[pos_] >= '1' && src_[pos_] <= '9') {
            while (pos_ < src_.size() && src_[pos_] >= '0' && src_[pos_] <= '9') {
                ++pos_;
            }
        } else {
            fail("Invalid integer part in JSON number");
        }

        bool is_float = false;
        if (pos_ < src_.size() && src_[pos_] == '.') {
            is_float = true;
            ++pos_;
            if (pos_ >= src_.size() || src_[pos_] < '0' || src_[pos_] > '9') {
                fail("Expected digit after decimal point in JSON number");
            }
            while (pos_ < src_.size() && src_[pos_] >= '0' && src_[pos_] <= '9') {
                ++pos_;
            }
        }
        if (pos_ < src_.size() && (src_[pos_] == 'e' || src_[pos_] == 'E')) {
            is_float = true;
            ++pos_;
            if (pos_ < src_.size() && (src_[pos_] == '+' || src_[pos_] == '-')) {
                ++pos_;
            }
            if (pos_ >= src_.size() || src_[pos_] < '0' || src_[pos_] > '9') {
                fail("Expected digit in JSON exponent");
            }
            while (pos_ < src_.size() && src_[pos_] >= '0' && src_[pos_] <= '9') {
                ++pos_;
            }
        }

        const std::string_view token = src_.substr(start, pos_ - start);
        if (!is_float) {
            std::int64_t ival = 0;
            const auto [ptr, ec] = std::from_chars(token.data(), token.data() + token.size(), ival);
            if (ec == std::errc{} && ptr == token.data() + token.size()) {
                return JsonValue(ival);
            }
        }

        double dval = 0.0;
        const auto [ptr, ec] = std::from_chars(token.data(), token.data() + token.size(), dval);
        if (ec != std::errc{} || ptr != token.data() + token.size() || !std::isfinite(dval)) {
            fail("JSON number out of representable finite range");
        }
        return JsonValue(dval);
    }

    JsonValue parse_array(std::size_t depth) {
        ++pos_; // consume '['
        skip_ws();
        JsonArray arr;
        if (peek() == ']') {
            ++pos_;
            return JsonValue(std::move(arr));
        }
        while (true) {
            arr.push_back(parse_value(depth));
            skip_ws();
            const char c = peek();
            if (c == ']') {
                ++pos_;
                return JsonValue(std::move(arr));
            }
            if (c != ',') {
                fail("Expected ',' or ']' in JSON array");
            }
            ++pos_;
            skip_ws();
        }
    }

    JsonValue parse_object(std::size_t depth) {
        ++pos_; // consume '{'
        skip_ws();
        JsonObject obj;
        if (peek() == '}') {
            ++pos_;
            return JsonValue(std::move(obj));
        }
        while (true) {
            if (peek() != '"') {
                fail("Expected string key in JSON object");
            }
            std::string key = parse_string();
            skip_ws();
            if (peek() != ':') {
                fail("Expected ':' after key in JSON object");
            }
            ++pos_;
            JsonValue val = parse_value(depth);
            obj.insert_or_assign(std::move(key), std::move(val));
            skip_ws();
            const char c = peek();
            if (c == '}') {
                ++pos_;
                return JsonValue(std::move(obj));
            }
            if (c != ',') {
                fail("Expected ',' or '}' in JSON object");
            }
            ++pos_;
            skip_ws();
        }
    }
};

void escape_json_string(std::string_view s, std::string& out) {
    static constexpr char kHex[] = "0123456789abcdef";
    out.push_back('"');
    for (const char ch : s) {
        const auto uc = static_cast<unsigned char>(ch);
        switch (uc) {
            case '"': out.append("\\\""); break;
            case '\\': out.append("\\\\"); break;
            case '\b': out.append("\\b"); break;
            case '\f': out.append("\\f"); break;
            case '\n': out.append("\\n"); break;
            case '\r': out.append("\\r"); break;
            case '\t': out.append("\\t"); break;
            default:
                if (uc < 0x20U) {
                    out.append("\\u00");
                    out.push_back(kHex[(uc >> 4U) & 0x0FU]);
                    out.push_back(kHex[uc & 0x0FU]);
                } else {
                    out.push_back(ch);
                }
                break;
        }
    }
    out.push_back('"');
}

void dump_impl(const JsonValue& v, std::string& out, int indent, int level) {
    if (v.is_null()) {
        out.append("null");
        return;
    }
    if (v.is_bool()) {
        out.append(v.as_bool() ? "true" : "false");
        return;
    }
    if (v.is_int()) {
        char buf[32]{};
        const auto [ptr, ec] = std::to_chars(buf, buf + sizeof(buf), v.as_int64());
        if (ec == std::errc{}) {
            out.append(buf, static_cast<std::size_t>(ptr - buf));
        } else {
            out.append("0");
        }
        return;
    }
    if (v.is_double()) {
        const double d = v.as_double();
        if (!std::isfinite(d)) {
            out.append("null");
            return;
        }
        char buf[64]{};
        const auto [ptr, ec] = std::to_chars(buf, buf + sizeof(buf), d);
        if (ec == std::errc{}) {
            const std::string_view sv(buf, static_cast<std::size_t>(ptr - buf));
            out.append(sv);
            if (sv.find('.') == std::string_view::npos &&
                sv.find('e') == std::string_view::npos &&
                sv.find('E') == std::string_view::npos) {
                out.append(".0");
            }
        } else {
            out.append("0.0");
        }
        return;
    }
    if (v.is_string()) {
        escape_json_string(v.as_string(), out);
        return;
    }
    if (v.is_array()) {
        const auto& arr = v.as_array();
        if (arr.empty()) {
            out.append("[]");
            return;
        }
        out.push_back('[');
        for (std::size_t i = 0; i < arr.size(); ++i) {
            if (i > 0) {
                out.push_back(',');
            }
            if (indent >= 0) {
                out.push_back('\n');
                out.append(static_cast<std::size_t>((level + 1) * indent), ' ');
            }
            dump_impl(arr[i], out, indent, level + 1);
        }
        if (indent >= 0) {
            out.push_back('\n');
            out.append(static_cast<std::size_t>(level * indent), ' ');
        }
        out.push_back(']');
        return;
    }
    if (v.is_object()) {
        const auto& obj = v.as_object();
        if (obj.empty()) {
            out.append("{}");
            return;
        }
        out.push_back('{');
        bool first = true;
        for (const auto& [k, child] : obj) {
            if (!first) {
                out.push_back(',');
            }
            first = false;
            if (indent >= 0) {
                out.push_back('\n');
                out.append(static_cast<std::size_t>((level + 1) * indent), ' ');
            }
            escape_json_string(k, out);
            out.push_back(':');
            if (indent >= 0) {
                out.push_back(' ');
            }
            dump_impl(child, out, indent, level + 1);
        }
        if (indent >= 0) {
            out.push_back('\n');
            out.append(static_cast<std::size_t>(level * indent), ' ');
        }
        out.push_back('}');
    }
}

} // namespace

JsonValue JsonValue::parse(std::string_view input) {
    Parser p(input);
    return p.parse_root();
}

std::optional<JsonValue> JsonValue::try_parse(std::string_view input) noexcept {
    try {
        return parse(input);
    } catch (...) {
        return std::nullopt;
    }
}

std::string JsonValue::dump(int indent) const {
    std::string out;
    dump_impl(*this, out, indent, 0);
    return out;
}

} // namespace omnia::core
