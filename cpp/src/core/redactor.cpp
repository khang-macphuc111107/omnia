#include "omnia/core/redactor.hpp"

#include <algorithm>
#include <cctype>

namespace omnia::core {

namespace {

bool is_token_char(char c) noexcept {
    const auto uc = static_cast<unsigned char>(c);
    return std::isalnum(uc) != 0 || c == '_' || c == '-';
}

bool is_bearer_token_char(char c) noexcept {
    const auto uc = static_cast<unsigned char>(c);
    return std::isalnum(uc) != 0 || c == '_' || c == '-' || c == '.' ||
           c == '~' || c == '+' || c == '/' || c == '=';
}

bool is_boundary_before(std::string_view s, std::size_t idx) noexcept {
    if (idx == 0) {
        return true;
    }
    const auto prev = static_cast<unsigned char>(s[idx - 1]);
    return std::isalnum(prev) == 0 && s[idx - 1] != '_';
}

bool starts_with_icase(std::string_view s, std::size_t pos, std::string_view needle) noexcept {
    if (pos + needle.size() > s.size()) {
        return false;
    }
    for (std::size_t i = 0; i < needle.size(); ++i) {
        const auto a = static_cast<unsigned char>(s[pos + i]);
        const auto b = static_cast<unsigned char>(needle[i]);
        if (std::tolower(a) != std::tolower(b)) {
            return false;
        }
    }
    return true;
}

std::size_t match_prefixed_token(
    std::string_view s,
    std::size_t pos,
    std::string_view prefix,
    std::size_t min_tail
) noexcept {
    if (!is_boundary_before(s, pos)) {
        return 0;
    }
    if (s.substr(pos, prefix.size()) != prefix) {
        return 0;
    }
    std::size_t cur = pos + prefix.size();
    while (cur < s.size() && is_token_char(s[cur])) {
        ++cur;
    }
    if (cur - (pos + prefix.size()) < min_tail) {
        return 0;
    }
    return cur - pos;
}

} // namespace

std::string SecretRedactor::redact(std::string_view input) {
    std::string out;
    out.reserve(input.size());

    std::size_t i = 0;
    while (i < input.size()) {
        // 1. PEM Private Key block: -----BEGIN ... PRIVATE KEY-----
        if (input.substr(i, 11) == "-----BEGIN ") {
            const std::size_t header_end = input.find("PRIVATE KEY-----", i + 11);
            if (header_end != std::string_view::npos && (header_end - i) <= 64) {
                const std::size_t footer_pos = input.find("-----END ", header_end + 16);
                if (footer_pos != std::string_view::npos) {
                    const std::size_t footer_end = input.find("PRIVATE KEY-----", footer_pos + 9);
                    if (footer_end != std::string_view::npos) {
                        out.append("[REDACTED_PEM_KEY]");
                        i = footer_end + 16;
                        continue;
                    }
                }
                out.append("[REDACTED_PEM_KEY]");
                i = input.size();
                continue;
            }
        }

        // 2. Bearer <token>
        if (is_boundary_before(input, i) && starts_with_icase(input, i, "bearer")) {
            std::size_t ws = i + 6;
            if (ws < input.size() && (input[ws] == ' ' || input[ws] == '\t')) {
                while (ws < input.size() && (input[ws] == ' ' || input[ws] == '\t')) {
                    ++ws;
                }
                if (input.substr(ws, 17) != "[REDACTED_SECRET]") {
                    std::size_t tok_end = ws;
                    while (tok_end < input.size() && is_bearer_token_char(input[tok_end])) {
                        ++tok_end;
                    }
                    if (tok_end - ws >= 8) {
                        out.append("Bearer [REDACTED_SECRET]");
                        i = tok_end;
                        continue;
                    }
                }
            }
        }

        // 3. Prefixed API keys: sk-*, ghp_*, gho_*, ghs_*, github_pat_*, AIza*, AKIA*
        std::size_t matched = match_prefixed_token(input, i, "github_pat_", 16);
        if (matched == 0) matched = match_prefixed_token(input, i, "ghp_", 16);
        if (matched == 0) matched = match_prefixed_token(input, i, "gho_", 16);
        if (matched == 0) matched = match_prefixed_token(input, i, "ghs_", 16);
        if (matched == 0) matched = match_prefixed_token(input, i, "sk-", 12);
        if (matched == 0) matched = match_prefixed_token(input, i, "AIza", 20);
        if (matched == 0) matched = match_prefixed_token(input, i, "AKIA", 16);
        if (matched > 0) {
            out.append("[REDACTED_SECRET]");
            i += matched;
            continue;
        }

        // 4. Query / key=value secrets: api_key=..., access_token=..., client_secret=...
        constexpr std::string_view kQueryKeys[] = {
            "api_key=", "apikey=", "access_token=", "client_secret="
        };
        bool query_redacted = false;
        for (const auto qk : kQueryKeys) {
            if (is_boundary_before(input, i) && starts_with_icase(input, i, qk)) {
                const std::size_t val_start = i + qk.size();
                if (input.substr(val_start, 17) != "[REDACTED_SECRET]") {
                    std::size_t val_end = val_start;
                    while (val_end < input.size() &&
                           input[val_end] != '&' &&
                           input[val_end] != ' ' &&
                           input[val_end] != '\t' &&
                           input[val_end] != '\r' &&
                           input[val_end] != '\n' &&
                           input[val_end] != '"' &&
                           input[val_end] != '\'') {
                        ++val_end;
                    }
                    if (val_end > val_start) {
                        out.append(input.substr(i, qk.size()));
                        out.append("[REDACTED_SECRET]");
                        i = val_end;
                        query_redacted = true;
                        break;
                    }
                }
            }
        }
        if (query_redacted) {
            continue;
        }

        out.push_back(input[i]);
        ++i;
    }

    return out;
}

bool SecretRedactor::contains_secret(std::string_view input) {
    return redact(input) != input;
}

} // namespace omnia::core
