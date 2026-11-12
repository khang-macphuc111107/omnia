#include "test_support.hpp"

#include "omnia/core/json.hpp"
#include "omnia/core/redactor.hpp"
#include "omnia/core/sha256.hpp"
#include "omnia/core/utf8.hpp"

#include <iostream>
#include <string>
#include <vector>

namespace {

void test_sha256_vectors() {
    using omnia::core::sha256_hex;

    OMNIA_CHECK(
        sha256_hex("") ==
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    OMNIA_CHECK(
        sha256_hex("abc") ==
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    OMNIA_CHECK(
        sha256_hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq") ==
        "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
    );

    // 1 million 'a' characters NIST vector
    const std::string million_a(1000000, 'a');
    OMNIA_CHECK(
        sha256_hex(million_a) ==
        "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"
    );
}

void test_rfc8259_json() {
    using omnia::core::JsonArray;
    using omnia::core::JsonObject;
    using omnia::core::JsonValue;

    const std::string raw = R"JSON({
        "ok": true,
        "nil": null,
        "count": -42,
        "ratio": 3.25e2,
        "rocket": "\uD83D\uDE80",
        "vietnamese": "Ki\u1ebfn tr\u00fac C++20",
        "escapes": "line1\nline2\t\"quoted\"\\slash\/",
        "items": [1, 2, {"nested": "yes"}]
    })JSON";

    const JsonValue parsed = JsonValue::parse(raw);
    OMNIA_CHECK(parsed.is_object());
    OMNIA_CHECK(parsed.prop_bool("ok") == true);
    OMNIA_CHECK(parsed.find("nil") != nullptr && parsed.find("nil")->is_null());
    OMNIA_CHECK(parsed.prop_int64("count") == -42);
    OMNIA_CHECK(parsed.find("ratio")->as_double() == 325.0);
    OMNIA_CHECK(parsed.prop_string("rocket") == "\U0001F680");
    OMNIA_CHECK(parsed.prop_string("vietnamese") == "Ki\u1EBFn tr\u00FAc C++20");
    OMNIA_CHECK(parsed.find("items")->as_array().size() == 3);

    const std::string dumped = parsed.dump();
    const JsonValue reparsed = JsonValue::parse(dumped);
    OMNIA_CHECK(reparsed == parsed);

    // Reject invalid RFC-8259 inputs
    OMNIA_CHECK_THROWS(JsonValue::parse("{"));
    OMNIA_CHECK_THROWS(JsonValue::parse("01"));
    OMNIA_CHECK_THROWS(JsonValue::parse("\"\\uD83D\"")); // Unpaired high surrogate
    OMNIA_CHECK_THROWS(JsonValue::parse("\"\\uDE80\"")); // Lone low surrogate
    OMNIA_CHECK_THROWS(JsonValue::parse("{\"a\":1} trailing"));
    OMNIA_CHECK_THROWS(JsonValue::parse("{\"raw_tab\":\"\t\"}"));
}

void test_utf8_truncation() {
    using omnia::core::is_valid_utf8;
    using omnia::core::truncate_utf8_codepoints;
    using omnia::core::truncate_utf8_words;
    using omnia::core::utf8_codepoint_count;

    // Multi-byte Vietnamese + Math + 4-byte Emoji
    const std::string sample =
        "Ki\u1EBFn tr\u00FAc \u2211 \u222B \U0001F680 C++20 hi\u1EC7u n\u0103ng cao";
    OMNIA_CHECK(is_valid_utf8(sample));
    const std::size_t total_cp = utf8_codepoint_count(sample);
    OMNIA_CHECK(total_cp > 20);

    for (std::size_t cap = 1; cap <= total_cp + 2; ++cap) {
        const std::string cut_cp = truncate_utf8_codepoints(sample, cap);
        OMNIA_CHECK(is_valid_utf8(cut_cp));
        OMNIA_CHECK(utf8_codepoint_count(cut_cp) <= cap);

        const std::string cut_word = truncate_utf8_words(sample, cap, "...");
        OMNIA_CHECK(is_valid_utf8(cut_word));
        OMNIA_CHECK(utf8_codepoint_count(cut_word) <= cap);
    }
}

void test_secret_redactor() {
    using omnia::core::SecretRedactor;

    // Runtime-constructed synthetic tokens so static repository scanners never trigger false positives
    const std::string sk_tok = std::string("sk") + "-proj_" + std::string(20, 'A');
    const std::string ghp_tok = std::string("ghp") + "_" + std::string(24, 'b');
    const std::string pat_tok = std::string("github_pat") + "_" + std::string(24, '9');
    const std::string ggl_tok = std::string("AIza") + std::string(26, 'Z');
    const std::string bearer_hdr = std::string("Authorization: Bearer ") + "eyJhbGciOiJIUzI1NiJ9.payload";
    const std::string pem_block =
        std::string("-----BEGIN ") + "RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj34G\n" +
        std::string("-----END ") + "RSA PRIVATE KEY-----";

    const std::string combined =
        "k1=" + sk_tok + " k2=" + ghp_tok + " k3=" + pat_tok +
        " k4=" + ggl_tok + " " + bearer_hdr + " url=https://api.local/v1?api_key=myTopSecretValue123\n" +
        pem_block;

    OMNIA_CHECK(SecretRedactor::contains_secret(combined));
    const std::string clean = SecretRedactor::redact(combined);
    OMNIA_CHECK(!SecretRedactor::contains_secret(clean));
    OMNIA_CHECK(clean.find(sk_tok) == std::string::npos);
    OMNIA_CHECK(clean.find(ghp_tok) == std::string::npos);
    OMNIA_CHECK(clean.find(pat_tok) == std::string::npos);
    OMNIA_CHECK(clean.find(ggl_tok) == std::string::npos);
    OMNIA_CHECK(clean.find("eyJhbGciOiJIUzI1NiJ9") == std::string::npos);
    OMNIA_CHECK(clean.find("myTopSecretValue123") == std::string::npos);
    OMNIA_CHECK(clean.find("MIIBOgIBAAJBAKj34G") == std::string::npos);
    OMNIA_CHECK(clean.find("Bearer [REDACTED_SECRET]") != std::string::npos);
    OMNIA_CHECK(clean.find("[REDACTED_PEM_KEY]") != std::string::npos);
}

} // namespace

int main() {
    test_sha256_vectors();
    test_rfc8259_json();
    test_utf8_truncation();
    test_secret_redactor();
    std::cout << "[PASS] test_omnia_core (SHA-256, RFC-8259 JSON, UTF-8, SecretRedactor)\n";
    return 0;
}
