pub mod sha256;

pub fn sign_v2(key: &str, method: &str, path: &str, ts_sec: i64, nonce: &str, body: &[u8]) -> String {
    let _ = (key, method, path, ts_sec, nonce, body);
    String::from("unimplemented")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn test_sha_helper() {
        assert_eq!(sha256::hex_encode(&sha256::sha256(b"")), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    }
}
