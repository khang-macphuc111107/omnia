use omnia_core::{
    base64_decode, base64_encode, canonical_json, compact_json, hex_decode, hex_encode,
    is_valid_utf8, now_epoch_ms, parse_json, pretty_json, sanitize_utf8_lossy, sha256_bytes,
    sha256_hex, truncate_utf8_bytes, truncate_utf8_codepoints, truncate_utf8_word_safe,
    try_parse_json, utf8_codepoint_count, utf8_has_control_chars, uuid_v4, uuid_v4_simple,
    SecretRedactor,
};
use serde_json::{json, Value};

#[test]
fn sha256_matches_nist_vectors() {
    assert_eq!(
        sha256_hex(b""),
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    assert_eq!(
        sha256_hex(b"abc"),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    assert_eq!(
        sha256_hex(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
        "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
    );
    let raw = sha256_bytes(b"abc");
    assert_eq!(hex_encode(&raw), sha256_hex(b"abc"));
}

#[test]
fn hex_and_base64_roundtrip_and_reject_malformed_inputs() {
    let bytes = [0x00u8, 0x0f, 0x7f, 0x80, 0xab, 0xff];
    let encoded = hex_encode(&bytes);
    assert_eq!(encoded, "000f7f80abff");
    assert_eq!(hex_decode(&encoded).expect("decode lower"), bytes);
    assert_eq!(hex_decode("000F7F80ABFF").expect("decode upper"), bytes);
    assert!(hex_decode("abc").is_err());
    assert!(hex_decode("0g").is_err());

    let rfc_vectors = [
        ("", ""),
        ("f", "Zg=="),
        ("fo", "Zm8="),
        ("foo", "Zm9v"),
        ("foob", "Zm9vYg=="),
        ("fooba", "Zm9vYmE="),
        ("foobar", "Zm9vYmFy"),
    ];
    for (plain, expected_b64) in rfc_vectors {
        assert_eq!(base64_encode(plain.as_bytes()), expected_b64);
        assert_eq!(
            base64_decode(expected_b64).expect("decode valid b64"),
            plain.as_bytes()
        );
    }
    assert!(base64_decode("!!!").is_err());
}

#[test]
fn uuid_and_epoch_clock_conform_to_format() {
    let u1 = uuid_v4();
    let u2 = uuid_v4();
    assert_ne!(u1, u2);
    assert_eq!(u1.len(), 36);
    assert_eq!(u1.as_bytes()[8], b'-');
    assert_eq!(u1.as_bytes()[13], b'-');
    assert_eq!(u1.as_bytes()[14], b'4');
    assert_eq!(u1.as_bytes()[18], b'-');
    assert!(matches!(u1.as_bytes()[19], b'8' | b'9' | b'a' | b'b'));
    assert_eq!(u1.as_bytes()[23], b'-');

    let simple = uuid_v4_simple();
    assert_eq!(simple.len(), 32);
    assert!(simple
        .bytes()
        .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')));

    assert!(now_epoch_ms() > 1_700_000_000_000);
}

#[test]
fn utf8_validation_sanitization_and_truncation_preserve_codepoints() {
    assert!(is_valid_utf8("Tiếng Việt 🚀".as_bytes()));
    assert!(!is_valid_utf8(&[0xFF, 0xFE, b'a']));
    assert!(!is_valid_utf8(&[0xC3, 0x28]));

    let sanitized = sanitize_utf8_lossy(&[b'o', b'k', 0xFF, b'!']);
    assert_eq!(sanitized, "ok\u{FFFD}!");
    assert!(is_valid_utf8(sanitized.as_bytes()));

    let viet = "Xin chào thế giới 🚀";
    assert_eq!(utf8_codepoint_count(viet), 19);
    assert_eq!(truncate_utf8_codepoints(viet, 8), "Xin chào");
    assert_eq!(truncate_utf8_codepoints(viet, 0), "");
    assert_eq!(truncate_utf8_codepoints(viet, 100), viet);

    assert_eq!(truncate_utf8_word_safe("hello world foo", 10), "hello");
    assert_eq!(truncate_utf8_word_safe("hello world foo", 5), "hello");
    assert_eq!(truncate_utf8_word_safe("supercalifragilistic", 5), "super");

    let byte_cut = truncate_utf8_bytes("ab🚀cd", 5, "...");
    assert!(byte_cut.len() <= 5);
    assert!(is_valid_utf8(byte_cut.as_bytes()));

    assert!(utf8_has_control_chars("bad\x07title"));
    assert!(!utf8_has_control_chars("Tiếng Việt ok"));
}

#[test]
fn json_parsing_canonical_ordering_and_strict_limits() {
    let parsed = parse_json(r#"{"b":1,"a":{"d":true,"c":[3,2,1]}}"#).expect("valid json");
    assert_eq!(
        canonical_json(&parsed),
        r#"{"a":{"c":[3,2,1],"d":true},"b":1}"#
    );
    assert!(compact_json(&parsed).is_ok());
    assert!(pretty_json(&parsed).expect("pretty").contains('\n'));

    assert!(try_parse_json(r#"{"a":01}"#).is_none());
    assert!(try_parse_json(r#"{"a":1} trailing"#).is_none());
    assert!(parse_json("{\n").is_err());

    let mut deep = String::new();
    for _ in 0..200 {
        deep.push('[');
    }
    for _ in 0..200 {
        deep.push(']');
    }
    assert!(parse_json(&deep).is_err());
}

#[test]
fn secret_redactor_scrubs_credentials_while_preserving_benign_token_metrics() {
    // Build synthetic tokens dynamically so static scanners never confuse test fixtures with secrets.
    let openai_like = ["sk", "proj", "0123456789abcdefXYZ"].join("-");
    let anthropic_like = ["sk", "ant", "api03", "9876543210fedcbaXYZ"].join("-");
    let gh_like = format!("{}{}", "ghp_", "0123456789abcdefghijKLMN");
    let google_like = format!("{}{}", "AIza", "SyTest0123456789abcdefghijk");
    let jwt_like = format!(
        "{}.{}.{}",
        "eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3OCJ9", "signature_segment_12345"
    );
    let url_like = [
        "ht",
        "tps://",
        "omnia_user:",
        "s3cr3t_pass",
        "@example.com/hook?api_key=",
        "my_secret_query_key_99",
        "&mode=fast",
    ]
    .concat();
    let bearer_label = ["Bea", "rer"].concat();
    let bearer_header = format!("Authorization: {bearer_label} {openai_like}");
    let cookie_line = ["Coo", "kie: sess=xyz123"].concat();
    let pem_block = format!(
        "{}\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSj\n{}",
        "-----BEGIN PRIVATE KEY-----", "-----END PRIVATE KEY-----"
    );

    let combined = format!(
        "{bearer_header}\n{cookie_line}\nok=token_budget:4096\n{anthropic_like}\n{gh_like}\n{google_like}\n{jwt_like}\n{url_like}\n{pem_block}"
    );
    let redacted = SecretRedactor::redact(&combined);

    assert!(!redacted.contains(&openai_like));
    assert!(!redacted.contains(&anthropic_like));
    assert!(!redacted.contains(&gh_like));
    assert!(!redacted.contains(&google_like));
    assert!(!redacted.contains(&jwt_like));
    assert!(!redacted.contains("s3cr3t_pass"));
    assert!(!redacted.contains("my_secret_query_key_99"));
    assert!(!redacted.contains("MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSj"));
    assert!(!redacted.contains("sess=xyz123"));
    let expected_bearer = format!("Authorization: {bearer_label} [REDACTED]");
    assert!(redacted.contains(&expected_bearer));
    assert!(redacted.contains("token_budget:4096"));
    assert!(redacted.contains("mode=fast"));
    assert!(redacted.contains("[REDACTED_PRIVATE_KEY]"));
    assert!(SecretRedactor::contains_secret(&combined));
    assert!(!SecretRedactor::contains_secret(
        "normal message token_budget=8192"
    ));

    let nested_url = [
        "ht",
        "tps://",
        "omnia_u",
        ":",
        "omnia_pw",
        "@host.internal/api?",
        "access_token=",
        "tok_abcdef123456",
    ]
    .concat();
    let expected_nested = [
        "ht",
        "tps://[REDACTED]@host.internal/api?",
        "access_token=[REDACTED]",
    ]
    .concat();
    let payload: Value = json!({
        "token_budget": 120000,
        "input_tokens": 1234,
        "output_tokens": 567,
        "max_output_tokens": 8192,
        "prompt_tokens": 1000,
        "completion_tokens": 200,
        "total_tokens": 1200,
        "tokens_used": 1200,
        "reserved_tokens": 4096,
        "remaining_tokens": 114704,
        "api_key": openai_like,
        "headers": {
            "Authorization": format!("{bearer_label} {gh_like}"),
            "Content-Type": "application/json"
        },
        "nested": [
            nested_url
        ]
    });

    let redacted_json = SecretRedactor::redact_json(&payload);
    assert_eq!(redacted_json["token_budget"], 120000);
    assert_eq!(redacted_json["input_tokens"], 1234);
    assert_eq!(redacted_json["output_tokens"], 567);
    assert_eq!(redacted_json["max_output_tokens"], 8192);
    assert_eq!(redacted_json["prompt_tokens"], 1000);
    assert_eq!(redacted_json["completion_tokens"], 200);
    assert_eq!(redacted_json["total_tokens"], 1200);
    assert_eq!(redacted_json["tokens_used"], 1200);
    assert_eq!(redacted_json["reserved_tokens"], 4096);
    assert_eq!(redacted_json["remaining_tokens"], 114704);
    assert_eq!(redacted_json["api_key"], "[REDACTED]");
    assert_eq!(redacted_json["headers"]["Authorization"], "[REDACTED]");
    assert_eq!(redacted_json["headers"]["Content-Type"], "application/json");
    assert_eq!(redacted_json["nested"][0], expected_nested);
}
