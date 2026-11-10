//! OCR result types, coordinate mapping, text matching and formatting (pure,
//! platform independent). The Windows.Media.Ocr call itself lives in `ocr_win`.

use crate::geometry::ImageMap;
use crate::types::Rect;

/// Axis-aligned box in pixels of some coordinate space.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BBox {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl BBox {
    pub fn new(x: f64, y: f64, w: f64, h: f64) -> Self {
        Self { x, y, w, h }
    }

    pub fn center(&self) -> (f64, f64) {
        (self.x + self.w / 2.0, self.y + self.h / 2.0)
    }

    pub fn union(&self, o: &BBox) -> BBox {
        let (l, t) = (self.x.min(o.x), self.y.min(o.y));
        let (r, b) = (
            (self.x + self.w).max(o.x + o.w),
            (self.y + self.h).max(o.y + o.h),
        );
        BBox::new(l, t, r - l, b - t)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct OcrWord {
    pub text: String,
    pub bbox: BBox,
}

#[derive(Debug, Clone, PartialEq)]
pub struct OcrLine {
    pub text: String,
    pub bbox: BBox,
    pub words: Vec<OcrWord>,
}

/// Build a line from the engine's text and word boxes (line box = union of words).
pub fn line_from_words(text: String, words: Vec<OcrWord>) -> Option<OcrLine> {
    let bbox = words.iter().map(|w| w.bbox).reduce(|a, b| a.union(&b))?;
    Some(OcrLine { text, bbox, words })
}

/// Bitmap pixel box (OCR ran on a capture whose pixel (0,0) is physical screen
/// `origin`, 1 bitmap px = 1 physical px) -> box in screenshot space of `map`.
pub fn bitmap_to_image(b: BBox, origin: (i32, i32), map: &ImageMap) -> BBox {
    let (x0, y0) = map.to_image_f(origin.0 as f64 + b.x, origin.1 as f64 + b.y);
    let (x1, y1) = map.to_image_f(origin.0 as f64 + b.x + b.w, origin.1 as f64 + b.y + b.h);
    BBox::new(x0, y0, x1 - x0, y1 - y0)
}

/// Map a whole line (and its words) from bitmap space into screenshot space.
pub fn map_line(line: &OcrLine, origin: (i32, i32), map: &ImageMap) -> OcrLine {
    OcrLine {
        text: line.text.clone(),
        bbox: bitmap_to_image(line.bbox, origin, map),
        words: line
            .words
            .iter()
            .map(|w| OcrWord {
                text: w.text.clone(),
                bbox: bitmap_to_image(w.bbox, origin, map),
            })
            .collect(),
    }
}

/// Region `[x0,y0,x1,y1]` in screenshot space -> physical rect (not clipped).
pub fn region_to_physical(map: &ImageMap, region: [f64; 4]) -> Result<Rect, String> {
    if region.iter().any(|v| !v.is_finite()) {
        return Err("region must contain finite numbers".into());
    }
    let (x0, x1) = (region[0].min(region[2]), region[0].max(region[2]));
    let (y0, y1) = (region[1].min(region[3]), region[1].max(region[3]));
    if x1 - x0 < 1.0 || y1 - y0 < 1.0 {
        return Err("region [x0,y0,x1,y1] must have positive width and height".into());
    }
    let (px0, py0) = map.to_physical(x0, y0);
    let (px1, py1) = map.to_physical(x1, y1);
    Ok(Rect::from_ltrb(
        px0,
        py0,
        px1.max(px0 + 1),
        py1.max(py0 + 1),
    ))
}

// ------------------------------------------------------------------ matching

#[derive(Debug, Clone, PartialEq)]
pub struct TextMatch {
    /// Matched words joined by a space.
    pub text: String,
    pub line: String,
    pub bbox: BBox,
}

fn fold(s: &str) -> Vec<char> {
    s.chars()
        .map(|c| c.to_lowercase().next().unwrap_or(c))
        .collect()
}

fn normalize(s: &str) -> Vec<char> {
    fold(&s.split_whitespace().collect::<Vec<_>>().join(" "))
}

fn find_all(hay: &[char], needle: &[char]) -> Vec<usize> {
    let mut out = Vec::new();
    if needle.is_empty() || needle.len() > hay.len() {
        return out;
    }
    let mut i = 0;
    while i + needle.len() <= hay.len() {
        if hay[i..i + needle.len()] == *needle {
            out.push(i);
            i += needle.len();
        } else {
            i += 1;
        }
    }
    out
}

/// Case-insensitive search of `needle` across `lines`. A match covers the
/// words it touches (so the box is that of whole words, never half a word).
/// Falls back to the whole line when word boxes cannot be used.
pub fn find_matches(lines: &[OcrLine], needle: &str) -> Vec<TextMatch> {
    let n = normalize(needle);
    let mut out = Vec::new();
    if n.is_empty() {
        return out;
    }
    for line in lines {
        let whole_line = || TextMatch {
            text: line.text.clone(),
            line: line.text.clone(),
            bbox: line.bbox,
        };
        if line.words.is_empty() {
            if !find_all(&normalize(&line.text), &n).is_empty() {
                out.push(whole_line());
            }
            continue;
        }
        // Join words with single spaces, remembering each word's char range.
        let mut joined: Vec<char> = Vec::new();
        let mut spans = Vec::new();
        for (i, w) in line.words.iter().enumerate() {
            if i > 0 {
                joined.push(' ');
            }
            let start = joined.len();
            joined.extend(fold(&w.text));
            spans.push((start, joined.len()));
        }
        let hits = find_all(&joined, &n);
        if hits.is_empty() {
            // Engines for CJK scripts return unspaced text: try the line text.
            if !find_all(&normalize(&line.text), &n).is_empty() {
                out.push(whole_line());
            }
            continue;
        }
        for h in hits {
            let end = h + n.len();
            let hit_words: Vec<&OcrWord> = line
                .words
                .iter()
                .zip(&spans)
                .filter(|(_, (s, e))| *s < end && *e > h)
                .map(|(w, _)| w)
                .collect();
            let Some(bbox) = hit_words.iter().map(|w| w.bbox).reduce(|a, b| a.union(&b)) else {
                continue;
            };
            out.push(TextMatch {
                text: hit_words
                    .iter()
                    .map(|w| w.text.as_str())
                    .collect::<Vec<_>>()
                    .join(" "),
                line: line.text.clone(),
                bbox,
            });
        }
    }
    out
}

// ---------------------------------------------------------------- formatting

fn r(v: f64) -> i64 {
    v.round() as i64
}

fn clip(s: &str, n: usize) -> String {
    if s.chars().count() > n {
        format!("{}...", s.chars().take(n).collect::<String>())
    } else {
        s.to_string()
    }
}

fn coord_note(map: &ImageMap) -> String {
    format!(
        "Boxes are (x,y,w,h) in pixels of the {}x{} screenshot space; pass the centre as x,y to computer_click.",
        map.img_w, map.img_h
    )
}

pub fn format_ocr(
    label: &str,
    lines: &[OcrLine],
    map: &ImageMap,
    max_lines: usize,
    max_chars: usize,
) -> String {
    if lines.is_empty() {
        return format!("OCR of {label}: no text recognized.");
    }
    let mut out = format!(
        "OCR of {label}: {} line(s). {}\n",
        lines.len(),
        coord_note(map)
    );
    for (i, l) in lines.iter().take(max_lines).enumerate() {
        let (cx, cy) = l.bbox.center();
        out.push_str(&format!(
            "{}. \"{}\" box=({},{},{},{}) center=({},{})\n",
            i + 1,
            clip(&l.text, 300),
            r(l.bbox.x),
            r(l.bbox.y),
            r(l.bbox.w),
            r(l.bbox.h),
            r(cx),
            r(cy)
        ));
    }
    if lines.len() > max_lines {
        out.push_str(&format!(
            "... {} more line(s) omitted; use `region` to narrow.\n",
            lines.len() - max_lines
        ));
    }
    let full = lines
        .iter()
        .map(|l| l.text.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    out.push_str("Full text:\n");
    if full.chars().count() > max_chars {
        out.push_str(&full.chars().take(max_chars).collect::<String>());
        out.push_str("\n... (truncated)");
    } else {
        out.push_str(&full);
    }
    out
}

pub fn format_matches(
    label: &str,
    needle: &str,
    matches: &[TextMatch],
    map: &ImageMap,
    max: usize,
) -> String {
    if matches.is_empty() {
        return format!(
            "No text matching \"{}\" found in {label}. Try a shorter phrase, a `region`, or computer_screenshot to look.",
            clip(needle, 100)
        );
    }
    let mut out = format!(
        "{} match(es) for \"{}\" in {label}. {}\n",
        matches.len(),
        clip(needle, 100),
        coord_note(map)
    );
    for (i, m) in matches.iter().take(max).enumerate() {
        let (cx, cy) = m.bbox.center();
        out.push_str(&format!(
            "{}. \"{}\" box=({},{},{},{}) center=({},{}) in line \"{}\"\n",
            i + 1,
            clip(&m.text, 200),
            r(m.bbox.x),
            r(m.bbox.y),
            r(m.bbox.w),
            r(m.bbox.h),
            r(cx),
            r(cy),
            clip(&m.line, 120)
        ));
    }
    if matches.len() > max {
        out.push_str(&format!(
            "... {} more match(es) omitted.\n",
            matches.len() - max
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn w(t: &str, x: f64, y: f64, wd: f64, h: f64) -> OcrWord {
        OcrWord {
            text: t.into(),
            bbox: BBox::new(x, y, wd, h),
        }
    }

    fn sample() -> Vec<OcrLine> {
        vec![
            line_from_words(
                "Save As".into(),
                vec![
                    w("Save", 10.0, 10.0, 40.0, 20.0),
                    w("As", 55.0, 10.0, 25.0, 20.0),
                ],
            )
            .unwrap(),
            line_from_words(
                "Do not save changes".into(),
                vec![
                    w("Do", 10.0, 40.0, 20.0, 20.0),
                    w("not", 35.0, 40.0, 25.0, 20.0),
                    w("save", 65.0, 40.0, 40.0, 20.0),
                    w("changes", 110.0, 40.0, 70.0, 20.0),
                ],
            )
            .unwrap(),
        ]
    }

    #[test]
    fn line_box_is_union_of_words() {
        let l = &sample()[0];
        assert_eq!(l.bbox, BBox::new(10.0, 10.0, 70.0, 20.0));
        assert!(line_from_words("x".into(), vec![]).is_none());
    }

    #[test]
    fn maps_with_origin_and_downscale() {
        // 3840x2160 physical capture (150% DPI monitor) shown at 1920x1080, monitor at x=1920.
        let map = ImageMap {
            origin: (1920, 0),
            src_w: 3840,
            src_h: 2160,
            img_w: 1920,
            img_h: 1080,
        };
        let b = bitmap_to_image(BBox::new(200.0, 100.0, 400.0, 60.0), (1920, 0), &map);
        assert_eq!(b, BBox::new(100.0, 50.0, 200.0, 30.0));
    }

    #[test]
    fn maps_region_capture_offset() {
        // Region capture starting at physical (1000,500).
        let map = ImageMap {
            origin: (0, 0),
            src_w: 2000,
            src_h: 1000,
            img_w: 1000,
            img_h: 500,
        };
        let b = bitmap_to_image(BBox::new(20.0, 10.0, 100.0, 40.0), (1000, 500), &map);
        assert_eq!(b, BBox::new(510.0, 255.0, 50.0, 20.0));
    }

    #[test]
    fn map_line_maps_words() {
        let map = ImageMap {
            origin: (0, 0),
            src_w: 200,
            src_h: 100,
            img_w: 100,
            img_h: 50,
        };
        let l = map_line(&sample()[0], (0, 0), &map);
        assert_eq!(l.bbox, BBox::new(5.0, 5.0, 35.0, 10.0));
        assert_eq!(l.words[1].bbox, BBox::new(27.5, 5.0, 12.5, 10.0));
    }

    #[test]
    fn region_conversion() {
        let map = ImageMap {
            origin: (100, 50),
            src_w: 2000,
            src_h: 1000,
            img_w: 1000,
            img_h: 500,
        };
        assert_eq!(
            region_to_physical(&map, [10.0, 20.0, 110.0, 70.0]).unwrap(),
            Rect::new(120, 90, 200, 100)
        );
        // corners in any order
        assert_eq!(
            region_to_physical(&map, [110.0, 70.0, 10.0, 20.0]).unwrap(),
            Rect::new(120, 90, 200, 100)
        );
        assert!(region_to_physical(&map, [5.0, 5.0, 5.0, 50.0]).is_err());
        assert!(region_to_physical(&map, [f64::NAN, 0.0, 1.0, 1.0]).is_err());
    }

    #[test]
    fn finds_words_case_insensitively() {
        let m = find_matches(&sample(), "SAVE");
        assert_eq!(m.len(), 2);
        assert_eq!(m[0].bbox, BBox::new(10.0, 10.0, 40.0, 20.0));
        assert_eq!(m[1].bbox, BBox::new(65.0, 40.0, 40.0, 20.0));
    }

    #[test]
    fn finds_phrases_across_words_and_partial_words() {
        let m = find_matches(&sample(), "  save   as ");
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].text, "Save As");
        assert_eq!(m[0].bbox, BBox::new(10.0, 10.0, 70.0, 20.0));
        let p = find_matches(&sample(), "chang");
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].bbox, BBox::new(110.0, 40.0, 70.0, 20.0));
        assert!(find_matches(&sample(), "nothing").is_empty());
        assert!(find_matches(&sample(), "   ").is_empty());
    }

    #[test]
    fn falls_back_to_line_for_unspaced_scripts() {
        let l = OcrLine {
            text: "保存文件".into(),
            bbox: BBox::new(0.0, 0.0, 80.0, 20.0),
            words: vec![
                w("保", 0.0, 0.0, 20.0, 20.0),
                w("存", 20.0, 0.0, 20.0, 20.0),
                w("文", 40.0, 0.0, 20.0, 20.0),
                w("件", 60.0, 0.0, 20.0, 20.0),
            ],
        };
        let m = find_matches(&[l], "保存");
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].bbox.w, 80.0);
    }

    #[test]
    fn formats_results() {
        let map = ImageMap {
            origin: (0, 0),
            src_w: 100,
            src_h: 100,
            img_w: 100,
            img_h: 100,
        };
        let s = format_ocr("monitor 0", &sample(), &map, 50, 1000);
        assert!(s.contains("2 line(s)"));
        assert!(s.contains("1. \"Save As\" box=(10,10,70,20) center=(45,20)"));
        assert!(s.contains("Full text:\nSave As\nDo not save changes"));
        assert!(format_ocr("x", &[], &map, 5, 5).contains("no text recognized"));
        let t = format_ocr("x", &sample(), &map, 1, 4);
        assert!(t.contains("1 more line(s) omitted") && t.contains("(truncated)"));
        let m = format_matches(
            "monitor 0",
            "save",
            &find_matches(&sample(), "save"),
            &map,
            10,
        );
        assert!(m.contains("2 match(es)") && m.contains("center=(30,20)"));
        assert!(format_matches("w", "zzz", &[], &map, 10).contains("No text matching"));
    }
}
