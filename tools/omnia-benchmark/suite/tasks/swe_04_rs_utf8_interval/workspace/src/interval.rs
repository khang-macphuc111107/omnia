#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Span {
    pub start: usize,
    pub end: usize,
}

impl Span {
    pub fn new(start: usize, end: usize) -> Self {
        Self { start, end }
    }
    pub fn is_empty(&self) -> bool {
        self.start >= self.end
    }
}

/// BUGGY: ignores adjacency (uses > instead of >=) and overwrites end on nested spans.
pub fn merge_intervals(spans: &[Span]) -> Vec<Span> {
    let mut valid: Vec<Span> = spans.iter().copied().filter(|s| !s.is_empty()).collect();
    valid.sort_by_key(|s| (s.start, s.end));
    let mut out: Vec<Span> = Vec::new();
    for s in valid {
        if let Some(last) = out.last_mut() {
            if last.end > s.start {
                last.end = s.end;
                continue;
            }
        }
        out.push(s);
    }
    out
}

/// BUGGY: drops right-hand remainder when a removal splits a base interval in two.
pub fn subtract_intervals(base: &[Span], remove: &[Span]) -> Vec<Span> {
    let mut current = merge_intervals(base);
    let removals = merge_intervals(remove);
    for rem in removals {
        let mut next = Vec::new();
        for b in current {
            if rem.end <= b.start || rem.start >= b.end {
                next.push(b);
            } else if rem.start > b.start && rem.end < b.end {
                // BUG: forgets Span::new(rem.end, b.end)
                next.push(Span::new(b.start, rem.start));
            } else if rem.start <= b.start && rem.end < b.end {
                next.push(Span::new(rem.end, b.end));
            } else if rem.start > b.start && rem.end >= b.end {
                next.push(Span::new(b.start, rem.start));
            }
        }
        current = next;
    }
    current
}
