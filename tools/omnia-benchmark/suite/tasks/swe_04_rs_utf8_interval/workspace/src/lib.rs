pub mod interval;
pub mod text;

pub use interval::{merge_intervals, subtract_intervals, Span};
pub use text::excerpt_around;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Replacement {
    pub span: Span,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SpanError {
    InvalidBounds,
    Overlap,
}

/// BUGGY: applies edits sequentially without offset adjustment or overlap checking.
pub fn apply_replacements(input: &str, edits: &[Replacement]) -> Result<String, SpanError> {
    let mut out = input.to_string();
    for e in edits {
        if e.span.start > e.span.end || e.span.end > out.len() {
            return Err(SpanError::InvalidBounds);
        }
        out.replace_range(e.span.start..e.span.end, &e.text);
    }
    Ok(out)
}
