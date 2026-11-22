//! `omnia-downloader`: Full Native Rust multi-stream segmented HTTP & Google Drive downloader.
//!
//! Skeleton crate registered in Wave 1 for disjoint Wave 2 implementation.

#![forbid(unsafe_code)]

/// Crate identity string for diagnostics.
pub const CRATE_NAME: &str = "omnia-downloader";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skeleton_identity() {
        assert_eq!(CRATE_NAME, "omnia-downloader");
    }
}
