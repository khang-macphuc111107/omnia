#pragma once

#include <string>
#include <string_view>

namespace omnia::core {

class SecretRedactor {
public:
    /// Redacts API keys (`sk-*`, `ghp_*`, `github_pat_*`, `AIza*`, `AKIA*`),
    /// `Bearer <token>` authorization credentials, URL query tokens, and PEM private keys.
    static std::string redact(std::string_view input);

    /// Returns true if `input` contains any unredacted secret pattern.
    static bool contains_secret(std::string_view input);
};

} // namespace omnia::core
