#include "omnia_native/types.hpp"

#include <windows.h>
#include <bcrypt.h>

#include <array>
#include <charconv>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <random>
#include <set>

namespace omnia::native {

Mode default_mode() noexcept {
    return Mode::Chat;
}

std::optional<Mode> mode_from_command(uint16_t id) noexcept {
    switch (id) {
        case 101:
            return Mode::Chat;
        case 102:
            return Mode::Browser;
        case 103:
            return Mode::Ide;
        default:
            return std::nullopt;
    }
}

std::string_view mode_description(Mode mode) noexcept {
    switch (mode) {
        case Mode::Chat:
            return "Chat / No project\n\nNative scratch workspace. Session metadata is managed in the native session panel. Provider delivery is not connected; this draft is not persisted.";
        case Mode::Browser:
            return "Browser\n\nNo browser engine is running. Native browser tabs, navigation and permissions are pending service integration.\n\nYour chat draft remains available below.";
        case Mode::Ide:
            return "IDE\n\nNative editor service integration is pending. No files are opened or changed by this shell.\n\nYour chat draft remains available below.";
    }
    return "";
}

// ---------------------------------------------------------------------------
// UTF-8 / UTF-16 & Text Utilities
// ---------------------------------------------------------------------------

std::wstring utf8_to_wide(std::string_view utf8) {
    if (utf8.empty()) {
        return {};
    }
    const int needed = MultiByteToWideChar(
        CP_UTF8, 0, utf8.data(), static_cast<int>(utf8.size()), nullptr, 0);
    if (needed <= 0) {
        return {};
    }
    std::wstring out(static_cast<size_t>(needed), L'\0');
    MultiByteToWideChar(
        CP_UTF8, 0, utf8.data(), static_cast<int>(utf8.size()), out.data(), needed);
    return out;
}

std::string wide_to_utf8(std::wstring_view wide) {
    if (wide.empty()) {
        return {};
    }
    const int needed = WideCharToMultiByte(
        CP_UTF8, 0, wide.data(), static_cast<int>(wide.size()), nullptr, 0, nullptr, nullptr);
    if (needed <= 0) {
        return {};
    }
    std::string out(static_cast<size_t>(needed), '\0');
    WideCharToMultiByte(
        CP_UTF8,
        0,
        wide.data(),
        static_cast<int>(wide.size()),
        out.data(),
        needed,
        nullptr,
        nullptr);
    return out;
}

static bool decode_next_codepoint(std::string_view s, size_t& pos, uint32_t& cp) noexcept {
    if (pos >= s.size()) {
        return false;
    }
    const uint8_t b0 = static_cast<uint8_t>(s[pos]);
    if (b0 < 0x80) {
        cp = b0;
        pos += 1;
        return true;
    }
    if ((b0 & 0xE0) == 0xC0) {
        if (pos + 1 >= s.size()) return false;
        const uint8_t b1 = static_cast<uint8_t>(s[pos + 1]);
        if ((b1 & 0xC0) != 0x80) return false;
        cp = ((static_cast<uint32_t>(b0 & 0x1F)) << 6) | static_cast<uint32_t>(b1 & 0x3F);
        if (cp < 0x80) return false;
        pos += 2;
        return true;
    }
    if ((b0 & 0xF0) == 0xE0) {
        if (pos + 2 >= s.size()) return false;
        const uint8_t b1 = static_cast<uint8_t>(s[pos + 1]);
        const uint8_t b2 = static_cast<uint8_t>(s[pos + 2]);
        if ((b1 & 0xC0) != 0x80 || (b2 & 0xC0) != 0x80) return false;
        cp = ((static_cast<uint32_t>(b0 & 0x0F)) << 12) |
             ((static_cast<uint32_t>(b1 & 0x3F)) << 6) |
             static_cast<uint32_t>(b2 & 0x3F);
        if (cp < 0x800 || (cp >= 0xD800 && cp <= 0xDFFF)) return false;
        pos += 3;
        return true;
    }
    if ((b0 & 0xF8) == 0xF0) {
        if (pos + 3 >= s.size()) return false;
        const uint8_t b1 = static_cast<uint8_t>(s[pos + 1]);
        const uint8_t b2 = static_cast<uint8_t>(s[pos + 2]);
        const uint8_t b3 = static_cast<uint8_t>(s[pos + 3]);
        if ((b1 & 0xC0) != 0x80 || (b2 & 0xC0) != 0x80 || (b3 & 0xC0) != 0x80) return false;
        cp = ((static_cast<uint32_t>(b0 & 0x07)) << 18) |
             ((static_cast<uint32_t>(b1 & 0x3F)) << 12) |
             ((static_cast<uint32_t>(b2 & 0x3F)) << 6) |
             static_cast<uint32_t>(b3 & 0x3F);
        if (cp < 0x10000 || cp > 0x10FFFF) return false;
        pos += 4;
        return true;
    }
    return false;
}

static void append_utf8_codepoint(std::string& out, uint32_t cp) {
    if (cp <= 0x7F) {
        out.push_back(static_cast<char>(cp));
    } else if (cp <= 0x7FF) {
        out.push_back(static_cast<char>(0xC0 | ((cp >> 6) & 0x1F)));
        out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    } else if (cp <= 0xFFFF) {
        out.push_back(static_cast<char>(0xE0 | ((cp >> 12) & 0x0F)));
        out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
        out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    } else if (cp <= 0x10FFFF) {
        out.push_back(static_cast<char>(0xF0 | ((cp >> 18) & 0x07)));
        out.push_back(static_cast<char>(0x80 | ((cp >> 12) & 0x3F)));
        out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
        out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    }
}

bool is_valid_utf8(std::string_view s) noexcept {
    size_t pos = 0;
    uint32_t cp = 0;
    while (pos < s.size()) {
        if (!decode_next_codepoint(s, pos, cp)) {
            return false;
        }
    }
    return true;
}

bool utf8_has_control_chars(std::string_view s) noexcept {
    size_t pos = 0;
    uint32_t cp = 0;
    while (pos < s.size()) {
        if (!decode_next_codepoint(s, pos, cp)) {
            pos += 1;
            continue;
        }
        if (cp <= 0x1F || (cp >= 0x7F && cp <= 0x9F)) {
            return true;
        }
    }
    return false;
}

std::string_view trim_ascii(std::string_view s) noexcept {
    while (!s.empty() && (s.front() == ' ' || s.front() == '\t' || s.front() == '\r' || s.front() == '\n')) {
        s.remove_prefix(1);
    }
    while (!s.empty() && (s.back() == ' ' || s.back() == '\t' || s.back() == '\r' || s.back() == '\n')) {
        s.remove_suffix(1);
    }
    return s;
}

std::string to_lower_utf8(std::string_view s) {
    if (s.empty()) {
        return {};
    }
    std::wstring wide = utf8_to_wide(s);
    if (!wide.empty()) {
        CharLowerBuffW(wide.data(), static_cast<DWORD>(wide.size()));
        return wide_to_utf8(wide);
    }
    std::string out(s);
    for (char& c : out) {
        if (c >= 'A' && c <= 'Z') {
            c = static_cast<char>(c - 'A' + 'a');
        }
    }
    return out;
}

size_t utf8_char_count(std::string_view s) noexcept {
    size_t count = 0;
    size_t pos = 0;
    uint32_t cp = 0;
    while (pos < s.size()) {
        if (!decode_next_codepoint(s, pos, cp)) {
            pos += 1;
        }
        count += 1;
    }
    return count;
}

std::pair<std::string, std::string> utf8_split_at_char(std::string_view s, size_t char_index) {
    size_t count = 0;
    size_t pos = 0;
    uint32_t cp = 0;
    while (pos < s.size() && count < char_index) {
        if (!decode_next_codepoint(s, pos, cp)) {
            pos += 1;
        }
        count += 1;
    }
    return {std::string(s.substr(0, pos)), std::string(s.substr(pos))};
}

std::string utf8_take_chars(std::string_view s, size_t max_chars) {
    return utf8_split_at_char(s, max_chars).first;
}

// ---------------------------------------------------------------------------
// Crypto & Encoding (Windows CNG BCrypt + FIPS-180-4)
// ---------------------------------------------------------------------------

std::string hex_encode(std::span<const uint8_t> bytes) {
    static constexpr char kHex[] = "0123456789abcdef";
    std::string out;
    out.reserve(bytes.size() * 2);
    for (const uint8_t b : bytes) {
        out.push_back(kHex[(b >> 4) & 0x0F]);
        out.push_back(kHex[b & 0x0F]);
    }
    return out;
}

std::string hex_encode(std::string_view text) {
    return hex_encode(std::span<const uint8_t>(
        reinterpret_cast<const uint8_t*>(text.data()), text.size()));
}

static int hex_nibble(char c) noexcept {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return 10 + (c - 'a');
    if (c >= 'A' && c <= 'F') return 10 + (c - 'A');
    return -1;
}

Result<std::vector<uint8_t>> hex_decode(std::string_view hex) {
    if (hex.size() % 2 != 0) {
        return Result<std::vector<uint8_t>>::err(
            NativeError::make("invalid_hex", "odd hex length"));
    }
    std::vector<uint8_t> out;
    out.reserve(hex.size() / 2);
    for (size_t i = 0; i < hex.size(); i += 2) {
        const int hi = hex_nibble(hex[i]);
        const int lo = hex_nibble(hex[i + 1]);
        if (hi < 0 || lo < 0) {
            return Result<std::vector<uint8_t>>::err(
                NativeError::make("invalid_hex", "invalid hex digit"));
        }
        out.push_back(static_cast<uint8_t>((hi << 4) | lo));
    }
    return Result<std::vector<uint8_t>>::ok(std::move(out));
}

Result<std::string> decode_hex_utf8(std::string_view hex) {
    auto decoded = hex_decode(hex);
    if (decoded.is_err()) {
        return Result<std::string>::err(decoded.error());
    }
    const auto& vec = decoded.value();
    std::string s(reinterpret_cast<const char*>(vec.data()), vec.size());
    if (!is_valid_utf8(s)) {
        return Result<std::string>::err(
            NativeError::make("invalid_utf8", "invalid utf-8 in draft record"));
    }
    return Result<std::string>::ok(std::move(s));
}

std::string sha256_hex(std::span<const uint8_t> bytes) {
    std::array<uint8_t, 32> digest{};
    BCRYPT_ALG_HANDLE alg = nullptr;
    if (BCryptOpenAlgorithmProvider(&alg, BCRYPT_SHA256_ALGORITHM, nullptr, 0) == 0 && alg != nullptr) {
        BCRYPT_HASH_HANDLE hash = nullptr;
        if (BCryptCreateHash(alg, &hash, nullptr, 0, nullptr, 0, 0) == 0 && hash != nullptr) {
            const ULONG len = static_cast<ULONG>(bytes.size());
            PUCHAR ptr = bytes.empty() ? nullptr : const_cast<PUCHAR>(bytes.data());
            const NTSTATUS s1 = BCryptHashData(hash, ptr, len, 0);
            const NTSTATUS s2 = BCryptFinishHash(hash, digest.data(), static_cast<ULONG>(digest.size()), 0);
            BCryptDestroyHash(hash);
            BCryptCloseAlgorithmProvider(alg, 0);
            if (s1 == 0 && s2 == 0) {
                return hex_encode(digest);
            }
        } else {
            BCryptCloseAlgorithmProvider(alg, 0);
        }
    }

    static constexpr uint32_t k256[64] = {
        0x428a2f98u, 0x71374491u, 0xb5c0fbcfu, 0xe9b5dba5u, 0x3956c25bu, 0x59f111f1u, 0x923f82a4u, 0xab1c5ed5u,
        0xd807aa98u, 0x12835b01u, 0x243185beu, 0x550c7dc3u, 0x72be5d74u, 0x80deb1feu, 0x9bdc06a7u, 0xc19bf174u,
        0xe49b69c1u, 0xefbe4786u, 0x0fc19dc6u, 0x240ca1ccu, 0x2de92c6fu, 0x4a7484aau, 0x5cb0a9dcu, 0x76f988dau,
        0x983e5152u, 0xa831c66du, 0xb00327c8u, 0xbf597fc7u, 0xc6e00bf3u, 0xd5a79147u, 0x06ca6351u, 0x14292967u,
        0x27b70a85u, 0x2e1b2138u, 0x4d2c6dfcu, 0x53380d13u, 0x650a7354u, 0x766a0abbu, 0x81c2c92eu, 0x92722c85u,
        0xa2bfe8a1u, 0xa81a664bu, 0xc24b8b70u, 0xc76c51a3u, 0xd192e819u, 0xd6990624u, 0xf40e3585u, 0x106aa070u,
        0x19a4c116u, 0x1e376c08u, 0x2748774cu, 0x34b0bcb5u, 0x391c0cb3u, 0x4ed8aa4au, 0x5b9cca4fu, 0x682e6ff3u,
        0x748f82eeu, 0x78a5636fu, 0x84c87814u, 0x8cc70208u, 0x90befffau, 0xa4506cebu, 0xbef9a3f7u, 0xc67178f2u,
    };
    auto rotr = [](uint32_t x, uint32_t n) noexcept { return (x >> n) | (x << (32u - n)); };
    uint32_t h[8] = {
        0x6a09e667u, 0xbb67ae85u, 0x3c6ef372u, 0xa54ff53au,
        0x510e527fu, 0x9b05688cu, 0x1f83d9abu, 0x5be0cd19u,
    };
    std::vector<uint8_t> msg(bytes.begin(), bytes.end());
    const uint64_t bit_len = static_cast<uint64_t>(bytes.size()) * 8ULL;
    msg.push_back(0x80u);
    while ((msg.size() % 64u) != 56u) {
        msg.push_back(0u);
    }
    for (int s = 56; s >= 0; s -= 8) {
        msg.push_back(static_cast<uint8_t>((bit_len >> s) & 0xFFu));
    }
    for (size_t offset = 0; offset < msg.size(); offset += 64u) {
        uint32_t w[64]{};
        for (size_t i = 0; i < 16u; ++i) {
            const size_t o = offset + i * 4u;
            w[i] = (static_cast<uint32_t>(msg[o]) << 24) |
                   (static_cast<uint32_t>(msg[o + 1]) << 16) |
                   (static_cast<uint32_t>(msg[o + 2]) << 8) |
                   static_cast<uint32_t>(msg[o + 3]);
        }
        for (size_t i = 16u; i < 64u; ++i) {
            const uint32_t s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >> 3);
            const uint32_t s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16] + s0 + w[i - 7] + s1;
        }
        uint32_t a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
        for (size_t i = 0; i < 64u; ++i) {
            const uint32_t s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
            const uint32_t ch = (e & f) ^ ((~e) & g);
            const uint32_t temp1 = hh + s1 + ch + k256[i] + w[i];
            const uint32_t s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
            const uint32_t maj = (a & b) ^ (a & c) ^ (b & c);
            const uint32_t temp2 = s0 + maj;
            hh = g;
            g = f;
            f = e;
            e = d + temp1;
            d = c;
            c = b;
            b = a;
            a = temp1 + temp2;
        }
        h[0] += a; h[1] += b; h[2] += c; h[3] += d;
        h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
    }
    for (size_t i = 0; i < 8u; ++i) {
        digest[i * 4 + 0] = static_cast<uint8_t>((h[i] >> 24) & 0xFFu);
        digest[i * 4 + 1] = static_cast<uint8_t>((h[i] >> 16) & 0xFFu);
        digest[i * 4 + 2] = static_cast<uint8_t>((h[i] >> 8) & 0xFFu);
        digest[i * 4 + 3] = static_cast<uint8_t>(h[i] & 0xFFu);
    }
    return hex_encode(digest);
}

std::string sha256_hex(std::string_view text) {
    return sha256_hex(std::span<const uint8_t>(
        reinterpret_cast<const uint8_t*>(text.data()), text.size()));
}

std::string base64_encode(std::span<const uint8_t> bytes) {
    static constexpr char kTable[] =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out;
    out.reserve(((bytes.size() + 2u) / 3u) * 4u);
    for (size_t i = 0; i < bytes.size(); i += 3u) {
        const uint32_t b0 = bytes[i];
        const uint32_t b1 = (i + 1u < bytes.size()) ? bytes[i + 1u] : 0u;
        const uint32_t b2 = (i + 2u < bytes.size()) ? bytes[i + 2u] : 0u;
        const uint32_t triple = (b0 << 16) | (b1 << 8) | b2;
        out.push_back(kTable[(triple >> 18) & 0x3Fu]);
        out.push_back(kTable[(triple >> 12) & 0x3Fu]);
        out.push_back((i + 1u < bytes.size()) ? kTable[(triple >> 6) & 0x3Fu] : '=');
        out.push_back((i + 2u < bytes.size()) ? kTable[triple & 0x3Fu] : '=');
    }
    return out;
}

static std::array<uint8_t, 16> random_uuid_bytes() {
    std::array<uint8_t, 16> raw{};
    if (BCryptGenRandom(
            nullptr,
            raw.data(),
            static_cast<ULONG>(raw.size()),
            BCRYPT_USE_SYSTEM_PREFERRED_RNG) != 0) {
        std::random_device rd;
        for (size_t i = 0; i < raw.size(); ++i) {
            raw[i] = static_cast<uint8_t>(rd() & 0xFFu);
        }
    }
    raw[6] = static_cast<uint8_t>((raw[6] & 0x0Fu) | 0x40u);
    raw[8] = static_cast<uint8_t>((raw[8] & 0x3Fu) | 0x80u);
    return raw;
}

std::string uuid_v4_simple() {
    const auto raw = random_uuid_bytes();
    return hex_encode(raw);
}

std::string uuid_v4() {
    const std::string s = uuid_v4_simple();
    std::string out;
    out.reserve(36);
    out.append(s, 0, 8);
    out.push_back('-');
    out.append(s, 8, 4);
    out.push_back('-');
    out.append(s, 12, 4);
    out.push_back('-');
    out.append(s, 16, 4);
    out.push_back('-');
    out.append(s, 20, 12);
    return out;
}

Result<int64_t> now_epoch_ms() {
    const auto now = std::chrono::system_clock::now().time_since_epoch();
    const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(now).count();
    if (ms <= 0) {
        return Result<int64_t>::err(
            NativeError::make("invalid_clock", "System clock is before the supported epoch"));
    }
    return Result<int64_t>::ok(static_cast<int64_t>(ms));
}

// ---------------------------------------------------------------------------
// RFC-8259 JSON Serializer & Parser
// ---------------------------------------------------------------------------

static void dump_string(std::string& out, std::string_view sv) {
    out.push_back('"');
    for (const char ch : sv) {
        const uint8_t b = static_cast<uint8_t>(ch);
        switch (ch) {
            case '"': out.append("\\\""); break;
            case '\\': out.append("\\\\"); break;
            case '\b': out.append("\\b"); break;
            case '\f': out.append("\\f"); break;
            case '\n': out.append("\\n"); break;
            case '\r': out.append("\\r"); break;
            case '\t': out.append("\\t"); break;
            default:
                if (b < 0x20) {
                    char buf[8]{};
                    std::snprintf(buf, sizeof(buf), "\\u%04x", static_cast<unsigned>(b));
                    out.append(buf);
                } else {
                    out.push_back(ch);
                }
                break;
        }
    }
    out.push_back('"');
}

static void dump_impl(std::string& out, const JsonValue& v) {
    if (v.is_null()) {
        out.append("null");
    } else if (v.is_bool()) {
        out.append(v.as_bool() ? "true" : "false");
    } else if (v.is_int()) {
        out.append(std::to_string(v.as_int64()));
    } else if (v.is_double()) {
        const double d = std::get<double>(v.storage);
        if (!std::isfinite(d)) {
            out.append("null");
        } else {
            char buf[64]{};
            std::snprintf(buf, sizeof(buf), "%.17g", d);
            out.append(buf);
        }
    } else if (v.is_string()) {
        dump_string(out, v.as_string_view());
    } else if (const auto* arr = v.as_array_ptr()) {
        out.push_back('[');
        for (size_t i = 0; i < arr->size(); ++i) {
            if (i > 0) out.push_back(',');
            dump_impl(out, (*arr)[i]);
        }
        out.push_back(']');
    } else if (const auto* obj = v.as_object_ptr()) {
        out.push_back('{');
        bool first = true;
        for (const auto& [k, val] : *obj) {
            if (!first) out.push_back(',');
            first = false;
            dump_string(out, k);
            out.push_back(':');
            dump_impl(out, val);
        }
        out.push_back('}');
    }
}

std::string JsonValue::dump() const {
    std::string out;
    dump_impl(out, *this);
    return out;
}

namespace {

class JsonParser {
public:
    explicit JsonParser(std::string_view src) : src_(src) {}

    Result<JsonValue> parse_root() {
        skip_ws();
        auto val = parse_value(0);
        if (val.is_err()) return val;
        skip_ws();
        if (pos_ != src_.size()) {
            return Result<JsonValue>::err(
                NativeError::make("json_parse_error", "trailing characters after JSON value"));
        }
        return val;
    }

private:
    std::string_view src_;
    size_t pos_{0};

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

    bool consume(std::string_view lit) noexcept {
        if (src_.substr(pos_).starts_with(lit)) {
            pos_ += lit.size();
            return true;
        }
        return false;
    }

    Result<uint16_t> parse_hex4() {
        if (pos_ + 4 > src_.size()) {
            return Result<uint16_t>::err(
                NativeError::make("json_parse_error", "truncated unicode escape"));
        }
        uint16_t val = 0;
        for (int i = 0; i < 4; ++i) {
            const int n = hex_nibble(src_[pos_++]);
            if (n < 0) {
                return Result<uint16_t>::err(
                    NativeError::make("json_parse_error", "invalid hex in unicode escape"));
            }
            val = static_cast<uint16_t>((val << 4) | n);
        }
        return Result<uint16_t>::ok(val);
    }

    Result<std::string> parse_string() {
        if (pos_ >= src_.size() || src_[pos_] != '"') {
            return Result<std::string>::err(
                NativeError::make("json_parse_error", "expected string quote"));
        }
        ++pos_;
        std::string out;
        while (pos_ < src_.size()) {
            const char c = src_[pos_++];
            if (c == '"') {
                if (!is_valid_utf8(out)) {
                    return Result<std::string>::err(
                        NativeError::make("json_parse_error", "invalid UTF-8 in JSON string"));
                }
                return Result<std::string>::ok(std::move(out));
            }
            if (static_cast<uint8_t>(c) < 0x20) {
                return Result<std::string>::err(
                    NativeError::make("json_parse_error", "unescaped control character"));
            }
            if (c != '\\') {
                out.push_back(c);
                continue;
            }
            if (pos_ >= src_.size()) {
                return Result<std::string>::err(
                    NativeError::make("json_parse_error", "unterminated escape"));
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
                    auto u1 = parse_hex4();
                    if (u1.is_err()) return Result<std::string>::err(u1.error());
                    uint32_t cp = u1.value();
                    if (cp >= 0xD800 && cp <= 0xDBFF) {
                        if (!consume("\\u")) {
                            return Result<std::string>::err(
                                NativeError::make("json_parse_error", "missing low surrogate"));
                        }
                        auto u2 = parse_hex4();
                        if (u2.is_err()) return Result<std::string>::err(u2.error());
                        const uint32_t low = u2.value();
                        if (low < 0xDC00 || low > 0xDFFF) {
                            return Result<std::string>::err(
                                NativeError::make("json_parse_error", "invalid low surrogate"));
                        }
                        cp = 0x10000u + (((cp - 0xD800u) << 10) | (low - 0xDC00u));
                    } else if (cp >= 0xDC00 && cp <= 0xDFFF) {
                        return Result<std::string>::err(
                            NativeError::make("json_parse_error", "lone low surrogate"));
                    }
                    append_utf8_codepoint(out, cp);
                    break;
                }
                default:
                    return Result<std::string>::err(
                        NativeError::make("json_parse_error", "unknown escape character"));
            }
        }
        return Result<std::string>::err(
            NativeError::make("json_parse_error", "unterminated string"));
    }

    Result<JsonValue> parse_number() {
        const size_t start = pos_;
        if (pos_ < src_.size() && src_[pos_] == '-') ++pos_;
        if (pos_ >= src_.size() || src_[pos_] < '0' || src_[pos_] > '9') {
            return Result<JsonValue>::err(
                NativeError::make("json_parse_error", "invalid number"));
        }
        if (src_[pos_] == '0') {
            ++pos_;
        } else {
            while (pos_ < src_.size() && src_[pos_] >= '0' && src_[pos_] <= '9') ++pos_;
        }
        bool is_float = false;
        if (pos_ < src_.size() && src_[pos_] == '.') {
            is_float = true;
            ++pos_;
            if (pos_ >= src_.size() || src_[pos_] < '0' || src_[pos_] > '9') {
                return Result<JsonValue>::err(
                    NativeError::make("json_parse_error", "invalid fraction"));
            }
            while (pos_ < src_.size() && src_[pos_] >= '0' && src_[pos_] <= '9') ++pos_;
        }
        if (pos_ < src_.size() && (src_[pos_] == 'e' || src_[pos_] == 'E')) {
            is_float = true;
            ++pos_;
            if (pos_ < src_.size() && (src_[pos_] == '+' || src_[pos_] == '-')) ++pos_;
            if (pos_ >= src_.size() || src_[pos_] < '0' || src_[pos_] > '9') {
                return Result<JsonValue>::err(
                    NativeError::make("json_parse_error", "invalid exponent"));
            }
            while (pos_ < src_.size() && src_[pos_] >= '0' && src_[pos_] <= '9') ++pos_;
        }
        const std::string_view token = src_.substr(start, pos_ - start);
        if (!is_float) {
            int64_t iv = 0;
            const auto [ptr, ec] = std::from_chars(token.data(), token.data() + token.size(), iv);
            if (ec == std::errc{} && ptr == token.data() + token.size()) {
                return Result<JsonValue>::ok(JsonValue(iv));
            }
        }
        std::string tmp(token);
        char* endp = nullptr;
        const double dv = std::strtod(tmp.c_str(), &endp);
        if (endp != tmp.c_str() + tmp.size() || !std::isfinite(dv)) {
            return Result<JsonValue>::err(
                NativeError::make("json_parse_error", "number out of range"));
        }
        return Result<JsonValue>::ok(JsonValue(dv));
    }

    Result<JsonValue> parse_value(int depth) {
        if (depth > 64) {
            return Result<JsonValue>::err(
                NativeError::make("json_parse_error", "JSON nesting depth exceeded"));
        }
        skip_ws();
        if (pos_ >= src_.size()) {
            return Result<JsonValue>::err(
                NativeError::make("json_parse_error", "unexpected end of input"));
        }
        const char c = src_[pos_];
        if (c == 'n') {
            if (consume("null")) return Result<JsonValue>::ok(JsonValue(nullptr));
            return Result<JsonValue>::err(NativeError::make("json_parse_error", "invalid literal"));
        }
        if (c == 't') {
            if (consume("true")) return Result<JsonValue>::ok(JsonValue(true));
            return Result<JsonValue>::err(NativeError::make("json_parse_error", "invalid literal"));
        }
        if (c == 'f') {
            if (consume("false")) return Result<JsonValue>::ok(JsonValue(false));
            return Result<JsonValue>::err(NativeError::make("json_parse_error", "invalid literal"));
        }
        if (c == '"') {
            auto s = parse_string();
            if (s.is_err()) return Result<JsonValue>::err(s.error());
            return Result<JsonValue>::ok(JsonValue(std::move(s.value())));
        }
        if (c == '[') {
            ++pos_;
            JsonValue::Array arr;
            skip_ws();
            if (pos_ < src_.size() && src_[pos_] == ']') {
                ++pos_;
                return Result<JsonValue>::ok(JsonValue(std::move(arr)));
            }
            while (true) {
                auto elem = parse_value(depth + 1);
                if (elem.is_err()) return elem;
                arr.push_back(std::move(elem.value()));
                skip_ws();
                if (pos_ < src_.size() && src_[pos_] == ',') {
                    ++pos_;
                    continue;
                }
                if (pos_ < src_.size() && src_[pos_] == ']') {
                    ++pos_;
                    return Result<JsonValue>::ok(JsonValue(std::move(arr)));
                }
                return Result<JsonValue>::err(
                    NativeError::make("json_parse_error", "expected ',' or ']' in array"));
            }
        }
        if (c == '{') {
            ++pos_;
            JsonValue::Object obj;
            skip_ws();
            if (pos_ < src_.size() && src_[pos_] == '}') {
                ++pos_;
                return Result<JsonValue>::ok(JsonValue(std::move(obj)));
            }
            while (true) {
                skip_ws();
                auto key = parse_string();
                if (key.is_err()) return Result<JsonValue>::err(key.error());
                skip_ws();
                if (pos_ >= src_.size() || src_[pos_] != ':') {
                    return Result<JsonValue>::err(
                        NativeError::make("json_parse_error", "expected ':' after object key"));
                }
                ++pos_;
                auto val = parse_value(depth + 1);
                if (val.is_err()) return val;
                obj[std::move(key.value())] = std::move(val.value());
                skip_ws();
                if (pos_ < src_.size() && src_[pos_] == ',') {
                    ++pos_;
                    continue;
                }
                if (pos_ < src_.size() && src_[pos_] == '}') {
                    ++pos_;
                    return Result<JsonValue>::ok(JsonValue(std::move(obj)));
                }
                return Result<JsonValue>::err(
                    NativeError::make("json_parse_error", "expected ',' or '}' in object"));
            }
        }
        return parse_number();
    }
};

} // namespace

Result<JsonValue> JsonValue::parse(std::string_view input) {
    JsonParser parser(input);
    return parser.parse_root();
}

// ---------------------------------------------------------------------------
// Canonical Domain Serialization (CamelCase parity with HarnessStore)
// ---------------------------------------------------------------------------

static std::string_view scope_to_str(SessionScope s) noexcept {
    return s == SessionScope::Projectless ? "projectless" : "project";
}

static SessionScope scope_from_str(std::string_view s) noexcept {
    return s == "projectless" ? SessionScope::Projectless : SessionScope::Project;
}

static std::string_view perm_to_str(PermissionMode m) noexcept {
    switch (m) {
        case PermissionMode::AskAll: return "ask-all";
        case PermissionMode::AutoEdit: return "auto-edit";
        case PermissionMode::AutoAll: return "auto-all";
    }
    return "ask-all";
}

static PermissionMode perm_from_str(std::string_view s) noexcept {
    if (s == "auto-edit" || s == "autoEdit") return PermissionMode::AutoEdit;
    if (s == "auto-all" || s == "autoAll") return PermissionMode::AutoAll;
    return PermissionMode::AskAll;
}

JsonValue AgentSessionSummary::to_json_value() const {
    JsonValue::Object obj;
    obj["id"] = JsonValue(id);
    obj["title"] = JsonValue(title);
    obj["scope"] = JsonValue(scope_to_str(scope));
    obj["cwd"] = JsonValue(cwd);
    obj["profileId"] = JsonValue(profile_id);
    obj["model"] = JsonValue(model);
    obj["permissionMode"] = JsonValue(perm_to_str(permission_mode));
    obj["rules"] = JsonValue(rules);
    obj["reasoningEffort"] = reasoning_effort.has_value()
        ? JsonValue(*reasoning_effort)
        : JsonValue(nullptr);
    JsonValue::Array fallbacks;
    for (const auto& f : fallback_models) {
        fallbacks.emplace_back(f);
    }
    obj["fallbackModels"] = JsonValue(std::move(fallbacks));
    obj["tokenBudget"] = token_budget.has_value()
        ? JsonValue(*token_budget)
        : JsonValue(nullptr);
    obj["tokensUsed"] = JsonValue(tokens_used);
    obj["systemPrompt"] = system_prompt.has_value()
        ? *system_prompt
        : JsonValue(nullptr);
    obj["parentId"] = parent_id.has_value()
        ? JsonValue(*parent_id)
        : JsonValue(nullptr);
    obj["settingsRevision"] = JsonValue(settings_revision);
    obj["messageCount"] = JsonValue(static_cast<uint64_t>(message_count));
    obj["createdAtMs"] = JsonValue(created_at_ms);
    obj["updatedAtMs"] = JsonValue(updated_at_ms);
    return JsonValue(std::move(obj));
}

std::string AgentSessionSummary::to_json() const {
    return to_json_value().dump();
}

Result<AgentSessionSummary> AgentSessionSummary::from_json(std::string_view raw) {
    auto parsed = JsonValue::parse(raw);
    if (parsed.is_err()) {
        return Result<AgentSessionSummary>::err(parsed.error());
    }
    const auto* obj = parsed.value().as_object_ptr();
    if (!obj) {
        return Result<AgentSessionSummary>::err(
            NativeError::make("session_page_invalid", "Session summary is not a JSON object"));
    }
    const auto* id_v = parsed.value().find("id");
    const auto* title_v = parsed.value().find("title");
    if (!id_v || !id_v->is_string() || !title_v || !title_v->is_string()) {
        return Result<AgentSessionSummary>::err(
            NativeError::make("session_page_invalid", "Session summary missing required string fields"));
    }

    AgentSessionSummary out;
    out.id = id_v->as_string();
    out.title = title_v->as_string();
    if (const auto* sv = parsed.value().find("scope"); sv && sv->is_string()) {
        out.scope = scope_from_str(sv->as_string_view());
    }
    if (const auto* cv = parsed.value().find("cwd"); cv && cv->is_string()) {
        out.cwd = cv->as_string();
    }
    if (const auto* pv = parsed.value().find("profileId"); pv && pv->is_string()) {
        out.profile_id = pv->as_string();
    }
    if (const auto* mv = parsed.value().find("model"); mv && mv->is_string()) {
        out.model = mv->as_string();
    }
    if (const auto* pmv = parsed.value().find("permissionMode"); pmv && pmv->is_string()) {
        out.permission_mode = perm_from_str(pmv->as_string_view());
    }
    if (const auto* rv = parsed.value().find("rules"); rv && rv->is_array()) {
        out.rules = *rv->as_array_ptr();
    }
    if (const auto* ev = parsed.value().find("reasoningEffort"); ev && ev->is_string()) {
        out.reasoning_effort = ev->as_string();
    }
    if (const auto* fv = parsed.value().find("fallbackModels"); fv && fv->is_array()) {
        for (const auto& item : *fv->as_array_ptr()) {
            if (item.is_string()) out.fallback_models.push_back(item.as_string());
        }
    }
    if (const auto* tb = parsed.value().find("tokenBudget"); tb && tb->is_int()) {
        out.token_budget = tb->as_uint64();
    }
    if (const auto* tu = parsed.value().find("tokensUsed"); tu && tu->is_int()) {
        out.tokens_used = tu->as_uint64();
    }
    if (const auto* sp = parsed.value().find("systemPrompt"); sp && !sp->is_null()) {
        out.system_prompt = *sp;
    }
    if (const auto* pid = parsed.value().find("parentId"); pid && pid->is_string()) {
        out.parent_id = pid->as_string();
    }
    if (const auto* sr = parsed.value().find("settingsRevision"); sr && sr->is_int()) {
        out.settings_revision = sr->as_uint64(1);
    } else {
        out.settings_revision = 1;
    }
    if (const auto* mc = parsed.value().find("messageCount"); mc && mc->is_int()) {
        out.message_count = static_cast<size_t>(mc->as_uint64(0));
    }
    if (const auto* ca = parsed.value().find("createdAtMs"); ca && ca->is_int()) {
        out.created_at_ms = ca->as_int64();
    }
    if (const auto* ua = parsed.value().find("updatedAtMs"); ua && ua->is_int()) {
        out.updated_at_ms = ua->as_int64();
    }
    return Result<AgentSessionSummary>::ok(std::move(out));
}

std::string AgentSessionNavigationSnapshot::to_json() const {
    JsonValue::Object obj;
    obj["schemaVersion"] = JsonValue(static_cast<int64_t>(schema_version));
    obj["revision"] = JsonValue(revision);
    JsonValue::Array ids;
    for (const auto& id : open_ids) {
        ids.emplace_back(id);
    }
    obj["openIds"] = JsonValue(std::move(ids));
    obj["activeId"] = active_id.has_value() ? JsonValue(*active_id) : JsonValue(nullptr);
    obj["updatedAtMs"] = JsonValue(updated_at_ms);
    return JsonValue(std::move(obj)).dump();
}

Result<AgentSessionNavigationSnapshot> AgentSessionNavigationSnapshot::from_json(std::string_view raw) {
    auto parsed = JsonValue::parse(raw);
    if (parsed.is_err()) {
        return Result<AgentSessionNavigationSnapshot>::err(
            NativeError::make("session_navigation_invalid", "The stored navigation snapshot is invalid"));
    }
    const auto* obj = parsed.value().as_object_ptr();
    if (!obj) {
        return Result<AgentSessionNavigationSnapshot>::err(
            NativeError::make("session_navigation_invalid", "The stored navigation snapshot is invalid"));
    }
    static const std::set<std::string_view> kAllowed = {
        "schemaVersion", "revision", "openIds", "activeId", "updatedAtMs"
    };
    for (const auto& [k, _] : *obj) {
        if (!kAllowed.contains(k)) {
            return Result<AgentSessionNavigationSnapshot>::err(
                NativeError::make("session_navigation_invalid", "Unknown field in navigation snapshot"));
        }
    }
    const auto* sv = parsed.value().find("schemaVersion");
    const auto* rv = parsed.value().find("revision");
    const auto* oi = parsed.value().find("openIds");
    const auto* ua = parsed.value().find("updatedAtMs");
    if (!sv || !sv->is_int() || !rv || !rv->is_int() || !oi || !oi->is_array() || !ua || !ua->is_int()) {
        return Result<AgentSessionNavigationSnapshot>::err(
            NativeError::make("session_navigation_invalid", "The stored navigation snapshot is invalid"));
    }
    AgentSessionNavigationSnapshot snap;
    snap.schema_version = static_cast<uint32_t>(sv->as_uint64());
    snap.revision = rv->as_int64();
    for (const auto& item : *oi->as_array_ptr()) {
        if (!item.is_string()) {
            return Result<AgentSessionNavigationSnapshot>::err(
                NativeError::make("session_navigation_invalid", "Invalid openIds entry"));
        }
        snap.open_ids.push_back(item.as_string());
    }
    if (const auto* ai = parsed.value().find("activeId"); ai && !ai->is_null()) {
        if (!ai->is_string()) {
            return Result<AgentSessionNavigationSnapshot>::err(
                NativeError::make("session_navigation_invalid", "Invalid activeId"));
        }
        snap.active_id = ai->as_string();
    }
    snap.updated_at_ms = ua->as_int64();
    return Result<AgentSessionNavigationSnapshot>::ok(std::move(snap));
}

Result<SaveAgentSessionNavigationRequest> SaveAgentSessionNavigationRequest::from_json_strict(
    const JsonValue& val) {
    const auto* obj = val.as_object_ptr();
    if (!obj) {
        return Result<SaveAgentSessionNavigationRequest>::err(
            NativeError::invalid("request", "must be a JSON object"));
    }
    static const std::set<std::string_view> kAllowed = {
        "expectedRevision", "openIds", "activeId"
    };
    for (const auto& [k, _] : *obj) {
        if (!kAllowed.contains(k)) {
            return Result<SaveAgentSessionNavigationRequest>::err(
                NativeError::invalid(k, "unknown field"));
        }
    }
    const auto* er = val.find("expectedRevision");
    const auto* oi = val.find("openIds");
    if (!er || !er->is_int() || !oi || !oi->is_array()) {
        return Result<SaveAgentSessionNavigationRequest>::err(
            NativeError::invalid("request", "missing required fields"));
    }
    SaveAgentSessionNavigationRequest req;
    req.expected_revision = er->as_int64();
    for (const auto& item : *oi->as_array_ptr()) {
        if (!item.is_string()) {
            return Result<SaveAgentSessionNavigationRequest>::err(
                NativeError::invalid("openIds", "must contain strings"));
        }
        req.open_ids.push_back(item.as_string());
    }
    if (const auto* ai = val.find("activeId"); ai && !ai->is_null()) {
        if (!ai->is_string()) {
            return Result<SaveAgentSessionNavigationRequest>::err(
                NativeError::invalid("activeId", "must be string or null"));
        }
        req.active_id = ai->as_string();
    }
    return Result<SaveAgentSessionNavigationRequest>::ok(std::move(req));
}

} // namespace omnia::native
