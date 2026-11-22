/// BUGGY: slices at raw byte indices without snapping to UTF-8 char boundaries.
pub fn excerpt_around(s: &str, byte_pos: usize, radius_bytes: usize) -> &str {
    let pos = byte_pos.min(s.len());
    let start = pos.saturating_sub(radius_bytes);
    let end = pos.saturating_add(radius_bytes).min(s.len());
    &s[start..end]
}
