use span_index::{apply_replacements, excerpt_around, merge_intervals, subtract_intervals, Replacement, Span};

#[test]
fn test_ascii_excerpt() {
    assert_eq!(excerpt_around("hello world", 5, 3), "llo wo");
}

#[test]
fn test_disjoint_merge() {
    let res = merge_intervals(&[Span::new(0, 3), Span::new(10, 12)]);
    assert_eq!(res, vec![Span::new(0, 3), Span::new(10, 12)]);
}

#[test]
fn test_simple_subtract_prefix() {
    let res = subtract_intervals(&[Span::new(0, 10)], &[Span::new(0, 4)]);
    assert_eq!(res, vec![Span::new(4, 10)]);
}

#[test]
fn test_single_replacement() {
    let r = apply_replacements(
        "abcdef",
        &[Replacement { span: Span::new(1, 4), text: "XYZ".into() }],
    ).unwrap();
    assert_eq!(r, "aXYZef");
}
