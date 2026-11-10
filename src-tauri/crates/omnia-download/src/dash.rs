//! MPEG-DASH manifest (MPD) parsing and track selection.
//!
//! DRM policy: any `<ContentProtection>` element (CENC, Widevine, PlayReady, ...) makes
//! parsing fail with [`DownloadError::DrmProtected`].
//!
//! Supported addressing: `SegmentTemplate` (`$Number$`, `$Time$`, `$Bandwidth$`,
//! `$RepresentationID$`, `%0Nd` widths, `SegmentTimeline` incl. `r` repeats), `SegmentList`,
//! `SegmentBase` / plain `BaseURL` (single file). Only one period is downloaded (the
//! longest); live (`type="dynamic"`) manifests are treated as a snapshot of what is listed.

use crate::error::{DownloadError, Result};
use crate::types::{pick_by_quality, ByteRange, Quality};
use quick_xml::events::Event;
use quick_xml::Reader;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use url::Url;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TrackKind {
    Video,
    Audio,
    Text,
    Other,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DashSegment {
    pub url: String,
    pub range: Option<ByteRange>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DashRepresentation {
    pub id: String,
    pub bandwidth: u64,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub codecs: Option<String>,
    pub mime_type: Option<String>,
    pub kind: TrackKind,
    pub lang: Option<String>,
    pub init: Option<DashSegment>,
    pub segments: Vec<DashSegment>,
    /// The representation is one complete file (BaseURL / SegmentBase), no init needed.
    pub single_file: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DashManifest {
    pub is_dynamic: bool,
    pub duration_secs: Option<f64>,
    pub period_count: usize,
    /// Representations of the selected period.
    pub representations: Vec<DashRepresentation>,
}

// ---------------------------------------------------------------- minimal DOM

#[derive(Default, Debug)]
struct El {
    name: String,
    attrs: HashMap<String, String>,
    kids: Vec<El>,
    text: String,
}

impl El {
    fn attr(&self, k: &str) -> Option<&str> {
        self.attrs.get(k).map(String::as_str)
    }
    fn child(&self, n: &str) -> Option<&El> {
        self.kids.iter().find(|k| k.name == n)
    }
    fn children<'a>(&'a self, n: &'a str) -> impl Iterator<Item = &'a El> {
        self.kids.iter().filter(move |k| k.name == n)
    }
    fn any_named(&self, n: &str) -> Option<&El> {
        if self.name == n {
            return Some(self);
        }
        self.kids.iter().find_map(|k| k.any_named(n))
    }
}

fn make_el(e: &quick_xml::events::BytesStart<'_>) -> Result<El> {
    let name = e.local_name().as_ref().to_owned();
    let mut attrs = HashMap::new();
    for a in e.attributes() {
        let a = a.map_err(|e| DownloadError::Parse(format!("xml attribute: {e}")))?;
        let key = a.key.local_name().as_ref().to_owned();
        let val = a
            .normalized_value(quick_xml::XmlVersion::default())
            .map_err(|e| DownloadError::Parse(format!("xml value: {e}")))?
            .into_owned();
        attrs.insert(key, val);
    }
    Ok(El {
        name,
        attrs,
        kids: Vec::new(),
        text: String::new(),
    })
}

fn parse_xml(text: &str) -> Result<El> {
    let mut reader = Reader::from_str(text);
    reader.config_mut().trim_text(true);
    let mut stack: Vec<El> = Vec::new();
    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => stack.push(make_el(&e)?),
            Ok(Event::Empty(e)) => {
                let el = make_el(&e)?;
                match stack.last_mut() {
                    Some(p) => p.kids.push(el),
                    None => return Ok(el),
                }
            }
            Ok(Event::End(_)) => {
                let el = stack
                    .pop()
                    .ok_or_else(|| DownloadError::Parse("unbalanced xml".into()))?;
                match stack.last_mut() {
                    Some(p) => p.kids.push(el),
                    None => return Ok(el),
                }
            }
            Ok(Event::Text(t)) => {
                if let Some(top) = stack.last_mut() {
                    top.text.push_str(&t.xml10_content());
                }
            }
            Ok(Event::CData(t)) => {
                if let Some(top) = stack.last_mut() {
                    top.text.push_str(&t.xml10_content());
                }
            }
            Ok(Event::GeneralRef(r)) => {
                if let Some(top) = stack.last_mut() {
                    let name = r.into_inner();
                    match name.as_ref() {
                        "amp" => top.text.push('&'),
                        "lt" => top.text.push('<'),
                        "gt" => top.text.push('>'),
                        "quot" => top.text.push('"'),
                        "apos" => top.text.push('\''),
                        n => {
                            let code = n
                                .strip_prefix("#x")
                                .and_then(|h| u32::from_str_radix(h, 16).ok())
                                .or_else(|| n.strip_prefix('#').and_then(|d| d.parse().ok()));
                            if let Some(c) = code.and_then(char::from_u32) {
                                top.text.push(c);
                            }
                        }
                    }
                }
            }
            Ok(Event::Eof) => return Err(DownloadError::Parse("unexpected end of xml".into())),
            Ok(_) => {}
            Err(e) => return Err(DownloadError::Parse(format!("xml: {e}"))),
        }
    }
}

// ---------------------------------------------------------------- helpers

/// Parse an ISO-8601 duration such as `PT1H2M3.5S` / `P1DT2H`.
pub fn parse_iso_duration(s: &str) -> Option<f64> {
    let s = s.trim().strip_prefix('P')?;
    let (date, time) = match s.split_once('T') {
        Some((d, t)) => (d, t),
        None => (s, ""),
    };
    let mut total = 0.0;
    let mut num = String::new();
    for c in date.chars() {
        if c.is_ascii_digit() || c == '.' {
            num.push(c);
        } else {
            let v: f64 = num.parse().ok()?;
            num.clear();
            total += match c {
                'Y' => v * 365.0 * 86400.0,
                'M' => v * 30.0 * 86400.0,
                'W' => v * 7.0 * 86400.0,
                'D' => v * 86400.0,
                _ => return None,
            };
        }
    }
    for c in time.chars() {
        if c.is_ascii_digit() || c == '.' {
            num.push(c);
        } else {
            let v: f64 = num.parse().ok()?;
            num.clear();
            total += match c {
                'H' => v * 3600.0,
                'M' => v * 60.0,
                'S' => v,
                _ => return None,
            };
        }
    }
    Some(total)
}

/// Expand `$Number$`, `$Time$`, `$Bandwidth$`, `$RepresentationID$` (with optional `%0Nd`).
pub fn expand_template(tpl: &str, rep_id: &str, bandwidth: u64, number: u64, time: u64) -> String {
    let mut out = String::with_capacity(tpl.len() + 16);
    let mut parts = tpl.split('$');
    out.push_str(parts.next().unwrap_or(""));
    let mut in_var = true;
    for part in parts {
        if in_var {
            if part.is_empty() {
                out.push('$'); // "$$" escape
            } else {
                let (name, fmt) = part
                    .split_once('%')
                    .map_or((part, None), |(n, f)| (n, Some(f)));
                let value = match name {
                    "RepresentationID" => Some(rep_id.to_string()),
                    "Number" => Some(number.to_string()),
                    "Bandwidth" => Some(bandwidth.to_string()),
                    "Time" => Some(time.to_string()),
                    _ => None,
                };
                match value {
                    Some(v) => {
                        let width = fmt
                            .and_then(|f| f.strip_suffix('d'))
                            .and_then(|f| f.trim_start_matches('0').parse::<usize>().ok())
                            .unwrap_or(0);
                        if name == "RepresentationID" {
                            out.push_str(&v);
                        } else {
                            out.push_str(&format!("{v:0>width$}"));
                        }
                    }
                    None => {
                        out.push('$');
                        out.push_str(part);
                        out.push('$');
                    }
                }
            }
        } else {
            out.push_str(part);
        }
        in_var = !in_var;
    }
    out
}

fn next_base(base: &Url, el: &El) -> Url {
    el.child("BaseURL")
        .and_then(|b| base.join(b.text.trim()).ok())
        .unwrap_or_else(|| base.clone())
}

fn parse_range(s: &str) -> Option<ByteRange> {
    let (a, b) = s.split_once('-')?;
    let a: u64 = a.trim().parse().ok()?;
    let b: u64 = b.trim().parse().ok()?;
    (b >= a).then_some(ByteRange {
        offset: a,
        length: b - a + 1,
    })
}

fn num<T: std::str::FromStr>(el: &El, k: &str) -> Option<T> {
    el.attr(k).and_then(|v| v.trim().parse().ok())
}

#[derive(Clone, Default)]
struct Tpl {
    media: Option<String>,
    init: Option<String>,
    start_number: Option<u64>,
    timescale: Option<u64>,
    duration: Option<u64>,
    timeline: Vec<(Option<u64>, u64, i64)>,
}

fn read_tpl(el: &El) -> Option<Tpl> {
    let st = el.child("SegmentTemplate")?;
    let mut timeline = Vec::new();
    if let Some(tl) = st.child("SegmentTimeline") {
        for s in tl.children("S") {
            timeline.push((
                num::<u64>(s, "t"),
                num::<u64>(s, "d").unwrap_or(0),
                num::<i64>(s, "r").unwrap_or(0),
            ));
        }
    }
    Some(Tpl {
        media: st.attr("media").map(str::to_string),
        init: st.attr("initialization").map(str::to_string),
        start_number: num(st, "startNumber"),
        timescale: num(st, "timescale"),
        duration: num(st, "duration"),
        timeline,
    })
}

fn merge_tpl(outer: Option<Tpl>, inner: Option<Tpl>) -> Option<Tpl> {
    match (outer, inner) {
        (None, None) => None,
        (Some(t), None) | (None, Some(t)) => Some(t),
        (Some(o), Some(i)) => Some(Tpl {
            media: i.media.or(o.media),
            init: i.init.or(o.init),
            start_number: i.start_number.or(o.start_number),
            timescale: i.timescale.or(o.timescale),
            duration: i.duration.or(o.duration),
            timeline: if i.timeline.is_empty() {
                o.timeline
            } else {
                i.timeline
            },
        }),
    }
}

fn join(base: &Url, rel: &str) -> Result<String> {
    base.join(rel)
        .map(|u| u.to_string())
        .map_err(|e| DownloadError::Parse(format!("bad URL {rel:?}: {e}")))
}

struct Ctx<'a> {
    base: &'a Url,
    id: &'a str,
    bandwidth: u64,
    period_secs: Option<f64>,
}

fn expand_segments(tpl: &Tpl, c: &Ctx) -> Result<(Option<DashSegment>, Vec<DashSegment>)> {
    let media = tpl
        .media
        .as_deref()
        .ok_or_else(|| DownloadError::Parse("SegmentTemplate without media attribute".into()))?;
    let init = match &tpl.init {
        Some(i) => Some(DashSegment {
            url: join(c.base, &expand_template(i, c.id, c.bandwidth, 0, 0))?,
            range: None,
        }),
        None => None,
    };
    let timescale = tpl.timescale.unwrap_or(1).max(1);
    let start = tpl.start_number.unwrap_or(1);
    let mut segs = Vec::new();
    let mut push = |n: u64, t: u64| -> Result<()> {
        segs.push(DashSegment {
            url: join(c.base, &expand_template(media, c.id, c.bandwidth, n, t))?,
            range: None,
        });
        Ok(())
    };
    if !tpl.timeline.is_empty() {
        let mut number = start;
        let mut cursor = 0u64;
        for &(t, d, r) in &tpl.timeline {
            if d == 0 {
                return Err(DownloadError::Parse("SegmentTimeline S with d=0".into()));
            }
            cursor = t.unwrap_or(cursor);
            let count = if r >= 0 {
                r as u64 + 1
            } else {
                let end = c
                    .period_secs
                    .map(|p| (p * timescale as f64) as u64)
                    .ok_or_else(|| {
                        DownloadError::Unsupported(
                            "open-ended SegmentTimeline without period duration".into(),
                        )
                    })?;
                end.saturating_sub(cursor).div_ceil(d).max(1)
            };
            for _ in 0..count {
                push(number, cursor)?;
                number += 1;
                cursor += d;
            }
        }
    } else if let Some(d) = tpl.duration.filter(|d| *d > 0) {
        let secs = c.period_secs.ok_or_else(|| {
            DownloadError::Unsupported(
                "SegmentTemplate@duration without a known period duration (live DASH?)".into(),
            )
        })?;
        let count = ((secs * timescale as f64) / d as f64).ceil() as u64;
        for i in 0..count {
            push(start + i, i * d)?;
        }
    } else {
        return Err(DownloadError::Parse(
            "SegmentTemplate has neither timeline nor duration".into(),
        ));
    }
    Ok((init, segs))
}

fn kind_of(mime: Option<&str>, content_type: Option<&str>) -> TrackKind {
    let s = content_type
        .or_else(|| mime.and_then(|m| m.split('/').next()))
        .unwrap_or("");
    match s {
        "video" => TrackKind::Video,
        "audio" => TrackKind::Audio,
        "text" | "application" => TrackKind::Text,
        _ => TrackKind::Other,
    }
}

/// Parse an MPD. `mpd_url` resolves relative `BaseURL`s.
pub fn parse_mpd(text: &str, mpd_url: &Url) -> Result<DashManifest> {
    let root = parse_xml(text)?;
    if root.name != "MPD" {
        return Err(DownloadError::Parse("root element is not MPD".into()));
    }
    if let Some(cp) = root.any_named("ContentProtection") {
        let scheme = cp.attr("schemeIdUri").unwrap_or("?");
        return Err(DownloadError::DrmProtected(format!(
            "MPD contains <ContentProtection schemeIdUri=\"{scheme}\">"
        )));
    }
    let is_dynamic = root
        .attr("type")
        .is_some_and(|t| t.eq_ignore_ascii_case("dynamic"));
    let total = root
        .attr("mediaPresentationDuration")
        .and_then(parse_iso_duration);
    let mpd_base = next_base(mpd_url, &root);

    // Pick the longest period.
    let periods: Vec<&El> = root.children("Period").collect();
    if periods.is_empty() {
        return Err(DownloadError::Parse("MPD has no Period".into()));
    }
    let starts: Vec<f64> = periods
        .iter()
        .map(|p| p.attr("start").and_then(parse_iso_duration).unwrap_or(0.0))
        .collect();
    let durations: Vec<Option<f64>> = periods
        .iter()
        .enumerate()
        .map(|(i, p)| {
            p.attr("duration")
                .and_then(parse_iso_duration)
                .or_else(|| match periods.get(i + 1) {
                    Some(_) => Some(starts[i + 1] - starts[i]),
                    None => total.map(|t| t - starts[i]),
                })
        })
        .collect();
    let chosen = (0..periods.len())
        .max_by(|&a, &b| {
            durations[a]
                .unwrap_or(0.0)
                .partial_cmp(&durations[b].unwrap_or(0.0))
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(b.cmp(&a))
        })
        .unwrap_or(0);
    let period = periods[chosen];
    let period_secs = durations[chosen];
    let period_base = next_base(&mpd_base, period);

    let mut reps = Vec::new();
    for aset in period.children("AdaptationSet") {
        let aset_base = next_base(&period_base, aset);
        let aset_tpl = read_tpl(aset);
        for rep in aset.children("Representation") {
            let base = next_base(&aset_base, rep);
            let id = rep.attr("id").unwrap_or("").to_string();
            let bandwidth: u64 = num(rep, "bandwidth").unwrap_or(0);
            let mime = rep
                .attr("mimeType")
                .or_else(|| aset.attr("mimeType"))
                .map(str::to_string);
            let kind = kind_of(
                mime.as_deref(),
                aset.attr("contentType").or_else(|| rep.attr("contentType")),
            );
            let c = Ctx {
                base: &base,
                id: &id,
                bandwidth,
                period_secs,
            };

            let (init, segments, single_file) =
                if let Some(tpl) = merge_tpl(aset_tpl.clone(), read_tpl(rep)) {
                    let (i, s) = expand_segments(&tpl, &c)?;
                    (i, s, false)
                } else if let Some(list) = rep
                    .child("SegmentList")
                    .or_else(|| aset.child("SegmentList"))
                {
                    let init = list.child("Initialization").and_then(|i| {
                        let url = i
                            .attr("sourceURL")
                            .map_or_else(|| Ok(base.to_string()), |u| join(&base, u));
                        url.ok().map(|url| DashSegment {
                            url,
                            range: i.attr("range").and_then(parse_range),
                        })
                    });
                    let mut segs = Vec::new();
                    for s in list.children("SegmentURL") {
                        let url = s
                            .attr("media")
                            .map_or_else(|| Ok(base.to_string()), |m| join(&base, m))?;
                        segs.push(DashSegment {
                            url,
                            range: s.attr("mediaRange").and_then(parse_range),
                        });
                    }
                    (init, segs, false)
                } else {
                    // SegmentBase or bare BaseURL: the representation is a single complete file.
                    (
                        None,
                        vec![DashSegment {
                            url: base.to_string(),
                            range: None,
                        }],
                        true,
                    )
                };
            reps.push(DashRepresentation {
                id,
                bandwidth,
                width: num(rep, "width").or_else(|| num(aset, "width")),
                height: num(rep, "height").or_else(|| num(aset, "height")),
                codecs: rep
                    .attr("codecs")
                    .or_else(|| aset.attr("codecs"))
                    .map(str::to_string),
                mime_type: mime,
                kind,
                lang: aset.attr("lang").map(str::to_string),
                init,
                segments,
                single_file,
            });
        }
    }
    if reps.is_empty() {
        return Err(DownloadError::Parse("MPD has no Representation".into()));
    }
    Ok(DashManifest {
        is_dynamic,
        duration_secs: total,
        period_count: periods.len(),
        representations: reps,
    })
}

/// Choose `(video, audio)` representations. Video follows `quality`; audio is the best
/// available (the worst when `Quality::Worst`).
pub fn select_tracks(
    m: &DashManifest,
    quality: Quality,
) -> (Option<&DashRepresentation>, Option<&DashRepresentation>) {
    let pick = |kind: TrackKind, q: Quality| {
        let list: Vec<&DashRepresentation> = m
            .representations
            .iter()
            .filter(|r| r.kind == kind)
            .collect();
        let cands: Vec<(u64, Option<u32>)> = list.iter().map(|r| (r.bandwidth, r.height)).collect();
        pick_by_quality(&cands, q).map(|i| list[i])
    };
    let audio_q = if quality == Quality::Worst {
        Quality::Worst
    } else {
        Quality::Best
    };
    (
        pick(TrackKind::Video, quality),
        pick(TrackKind::Audio, audio_q),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> Url {
        Url::parse("http://h.test/dash/manifest.mpd").unwrap()
    }

    #[test]
    fn template_expansion() {
        assert_eq!(
            expand_template("seg-$Number%05d$.m4s", "v1", 1000, 7, 0),
            "seg-00007.m4s"
        );
        assert_eq!(
            expand_template(
                "$RepresentationID$/$Bandwidth$/$Time$-$$.m4s",
                "v1",
                1000,
                7,
                4200
            ),
            "v1/1000/4200-$.m4s"
        );
        assert_eq!(expand_template("a$Number$b", "x", 0, 12, 0), "a12b");
    }

    #[test]
    fn iso_durations() {
        assert_eq!(parse_iso_duration("PT1H2M3.5S"), Some(3723.5));
        assert_eq!(parse_iso_duration("PT30S"), Some(30.0));
        assert_eq!(parse_iso_duration("P1DT1S"), Some(86401.0));
        assert_eq!(parse_iso_duration("bogus"), None);
    }

    const MPD_TEMPLATE: &str = r#"<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT20S">
 <BaseURL>media/</BaseURL>
 <Period>
  <AdaptationSet contentType="video" mimeType="video/mp4">
   <SegmentTemplate timescale="1000" initialization="$RepresentationID$/init.mp4" media="$RepresentationID$/s-$Number%05d$.m4s" startNumber="1">
    <SegmentTimeline><S t="0" d="4000" r="2"/><S d="2000"/></SegmentTimeline>
   </SegmentTemplate>
   <Representation id="lo" bandwidth="500000" width="640" height="360" codecs="avc1.42c01e"/>
   <Representation id="hi" bandwidth="3000000" width="1920" height="1080"/>
  </AdaptationSet>
  <AdaptationSet contentType="audio" mimeType="audio/mp4" lang="en">
   <Representation id="a1" bandwidth="128000">
     <SegmentTemplate timescale="1" duration="5" initialization="a/init.mp4" media="a/$Number$.m4s"/>
   </Representation>
  </AdaptationSet>
 </Period>
</MPD>"#;

    #[test]
    fn template_timeline_and_duration() {
        let m = parse_mpd(MPD_TEMPLATE, &base()).unwrap();
        assert_eq!(m.representations.len(), 3);
        let hi = m.representations.iter().find(|r| r.id == "hi").unwrap();
        assert_eq!(
            hi.init.as_ref().unwrap().url,
            "http://h.test/dash/media/hi/init.mp4"
        );
        let urls: Vec<_> = hi
            .segments
            .iter()
            .map(|s| s.url.rsplit('/').next().unwrap())
            .collect();
        assert_eq!(
            urls,
            ["s-00001.m4s", "s-00002.m4s", "s-00003.m4s", "s-00004.m4s"]
        );
        let a = m.representations.iter().find(|r| r.id == "a1").unwrap();
        assert_eq!(a.segments.len(), 4); // 20 s / 5 s
        assert_eq!(a.segments[3].url, "http://h.test/dash/media/a/4.m4s");
        let (v, au) = select_tracks(&m, Quality::Best);
        assert_eq!(
            (v.unwrap().id.as_str(), au.unwrap().id.as_str()),
            ("hi", "a1")
        );
        assert_eq!(
            select_tracks(&m, Quality::MaxHeight(480)).0.unwrap().id,
            "lo"
        );
    }

    #[test]
    fn time_substitution_and_open_repeat() {
        let mpd = r#"<MPD type="static" mediaPresentationDuration="PT10S"><Period><AdaptationSet mimeType="video/mp4">
<SegmentTemplate timescale="90000" media="t$Time$.m4s"><SegmentTimeline><S t="900" d="270000" r="-1"/></SegmentTimeline></SegmentTemplate>
<Representation id="v" bandwidth="1"/></AdaptationSet></Period></MPD>"#;
        let m = parse_mpd(mpd, &base()).unwrap();
        let segs = &m.representations[0].segments;
        assert_eq!(segs.len(), 4); // 900000 ticks / 270000, rounded up from t=900
        assert!(segs[0].url.ends_with("t900.m4s"));
        assert!(segs[1].url.ends_with("t270900.m4s"));
    }

    #[test]
    fn segment_list_and_single_file() {
        let mpd = r#"<MPD mediaPresentationDuration="PT8S"><Period>
<AdaptationSet mimeType="video/mp4"><Representation id="l" bandwidth="1"><BaseURL>v/</BaseURL>
 <SegmentList><Initialization sourceURL="i.mp4" range="0-99"/><SegmentURL media="1.m4s"/><SegmentURL media="all.m4s" mediaRange="100-199"/></SegmentList>
</Representation></AdaptationSet>
<AdaptationSet mimeType="audio/mp4"><Representation id="s" bandwidth="1"><BaseURL>audio.m4a</BaseURL><SegmentBase indexRange="0-50"/></Representation></AdaptationSet>
</Period></MPD>"#;
        let m = parse_mpd(mpd, &base()).unwrap();
        let l = &m.representations[0];
        assert_eq!(
            l.init.as_ref().unwrap().range,
            Some(ByteRange {
                offset: 0,
                length: 100
            })
        );
        assert_eq!(
            l.segments[1].range,
            Some(ByteRange {
                offset: 100,
                length: 100
            })
        );
        assert_eq!(l.segments[0].url, "http://h.test/dash/v/1.m4s");
        let s = &m.representations[1];
        assert!(s.single_file);
        assert_eq!(s.segments[0].url, "http://h.test/dash/audio.m4a");
    }

    #[test]
    fn content_protection_is_refused() {
        let mpd = r#"<MPD mediaPresentationDuration="PT8S"><Period><AdaptationSet mimeType="video/mp4">
<ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/>
<Representation id="v" bandwidth="1"><BaseURL>v.mp4</BaseURL></Representation></AdaptationSet></Period></MPD>"#;
        assert!(matches!(
            parse_mpd(mpd, &base()),
            Err(DownloadError::DrmProtected(_))
        ));
    }
}
