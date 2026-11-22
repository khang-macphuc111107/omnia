//! `omnia-agent`: Full Native Rust SOTA v4 Autonomous Coding Agent Engine for Omnia.
//!
//! Skeleton crate registered in Wave 1 for disjoint Wave 2 implementation.

/// Crate identity string for diagnostics and startup checks.
pub const CRATE_NAME: &str = "omnia-agent";

/// Computes a fast 64-char hex BLAKE3 digest for prefix-cache and Merkle indexing.
#[must_use]
pub fn blake3_hex(input: &[u8]) -> String {
    blake3::hash(input).to_hex().to_string()
}

/// Computes a compact 3-hex-char XXH3 Hashline tag for a single source line.
#[must_use]
pub fn hashline_tag3(line: &str) -> String {
    let h = xxhash_rust::xxh3::xxh3_64(line.trim_end_matches('\r').as_bytes());
    format!("{:03x}", (h & 0x0fff) as u16)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skeleton_hash_primitives_work() {
        let digest = blake3_hex(b"omnia-agent");
        assert_eq!(digest.len(), 64);
        assert_eq!(hashline_tag3("fn main() {}").len(), 3);
    }
}
