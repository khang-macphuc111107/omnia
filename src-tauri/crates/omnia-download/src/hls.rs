//! HLS playlist parsing (master + media) and variant selection.
//!
//! DRM policy: `SAMPLE-AES`, `SAMPLE-AES-CTR` and any `KEYFORMAT` other than `identity`
//! (Widevine / PlayReady / FairPlay key formats) make parsing fail with
//! [`DownloadError::DrmProtected`]. Plain `AES-128` with an identity key is standard
//! encryption and is supported.

use crate::error::{DownloadError, Result};
use crate::types::{pick_by_quality, ByteRange, Quality};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use url::Url;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HlsVariant {
    pub url: String,
    pub bandwidth: u64,
    pub average_bandwidth: Option<u64>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub frame_rate: Option<f64>,
    pub codecs: Option<String>,
    pub audio_group: Option<String>,
    pub subtitles_group: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HlsRendition {
    /// AUDIO, VIDEO, SUBTITLES or CLOSED-CAPTIONS.
    pub media_type: String,
    pub group_id: String,
    pub name: String,
    pub language: Option<String>,
    /// Absent when the rendition is muxed into the variant stream.
    pub url: Option<String>,
    pub is_default: bool,
    pub autoselect: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HlsMaster {
    pub variants: Vec<HlsVariant>,
    pub renditions: Vec<HlsRendition>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HlsKey {
    pub url: String,
    /// Explicit IV; `None` means "use the segment's media sequence number".
    pub iv: Option<[u8; 16]>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HlsMap {
    pub url: String,
    pub byte_range: Option<ByteRange>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HlsSegment {
    pub sequence: u64,
    pub duration: f64,
    pub url: String,
    pub byte_range: Option<ByteRange>,
    /// A discontinuity precedes this segment.
    pub discontinuity: bool,
    pub key: Option<HlsKey>,
    pub map: Option<HlsMap>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HlsMedia {
    pub version: Option<u32>,
    pub target_duration: f64,
    pub media_sequence: u64,
    pub playlist_type: Option<String>,
    pub end_list: bool,
    pub total_duration: f64,
    pub segments: Vec<HlsSegment>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum HlsPlaylist {
    Master(HlsMaster),
    Media(HlsMedia),
}

/// Parse an attribute list (`KEY=value,KEY2="quoted, value"`), keys upper-cased.
pub fn parse_attributes(s: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() {
        while i < b.len() && (b[i] == b',' || b[i].is_ascii_whitespace()) {
            i += 1;
        }
        let ks = i;
        while i < b.len() && b[i] != b'=' && b[i] != b',' {
            i += 1;
        }
        let key = s[ks..i].trim().to_ascii_uppercase();
        if i >= b.len() || b[i] != b'=' {
            continue;
        }
        i += 1;
        let value = if i < b.len() && b[i] == b'"' {
            i += 1;
            let vs = i;
            while i < b.len() && b[i] != b'"' {
                i += 1;
            }
            let v = s[vs..i].to_string();
            i = (i + 1).min(b.len());
            v
        } else {
            let vs = i;
            while i < b.len() && b[i] != b',' {
                i += 1;
            }
            s[vs..i].trim().to_string()
        };
        if !key.is_empty() {
            map.insert(key, value);
        }
    }
    map
}

fn parse_iv(s: &str) -> Option<[u8; 16]> {
    let hex = s.trim().trim_start_matches("0x").trim_start_matches("0X");
    if hex.is_empty() || hex.len() > 32 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let padded = format!("{hex:0>32}");
    let mut out = [0u8; 16];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&padded[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}

fn parse_byterange(raw: &str, next_offset: u64) -> Option<ByteRange> {
    let mut it = raw.trim().trim_matches('"').split('@');
    let length: u64 = it.next()?.trim().parse().ok()?;
    let offset = match it.next() {
        Some(o) => o.trim().parse().ok()?,
        None => next_offset,
    };
    Some(ByteRange { offset, length })
}

fn resolve(base: &Url, uri: &str) -> Result<String> {
    base.join(uri.trim())
        .map(|u| u.to_string())
        .map_err(|e| DownloadError::Parse(format!("bad URI {uri:?}: {e}")))
}

/// Reject DRM-protected key declarations; returns `true` when an AES-128 key is declared.
fn check_key_attrs(attrs: &HashMap<String, String>, tag: &str) -> Result<bool> {
    let method = attrs
        .get("METHOD")
        .map(|m| m.to_ascii_uppercase())
        .unwrap_or_default();
    if let Some(kf) = attrs.get("KEYFORMAT") {
        if !kf.eq_ignore_ascii_case("identity") && method != "NONE" {
            return Err(DownloadError::DrmProtected(format!(
                "{tag} uses KEYFORMAT {kf:?} (DRM key system)"
            )));
        }
    }
    match method.as_str() {
        "NONE" => Ok(false),
        "AES-128" => Ok(true),
        "SAMPLE-AES" | "SAMPLE-AES-CTR" => Err(DownloadError::DrmProtected(format!(
            "{tag} METHOD={method} (sample-level DRM encryption)"
        ))),
        other => Err(DownloadError::Unsupported(format!(
            "{tag} METHOD={other:?}"
        ))),
    }
}

/// Parse a playlist body. `base` is the playlist URL used to resolve relative URIs.
pub fn parse_playlist(text: &str, base: &Url) -> Result<HlsPlaylist> {
    let text = text.trim_start_matches('\u{feff}');
    let first = text.lines().map(str::trim).find(|l| !l.is_empty());
    if first != Some("#EXTM3U") {
        return Err(DownloadError::Parse(
            "not an M3U8 playlist (missing #EXTM3U)".into(),
        ));
    }
    let is_master = text.contains("#EXT-X-STREAM-INF");

    // DRM check over the whole file, including master-only session keys.
    for line in text.lines().map(str::trim) {
        if let Some(rest) = line.strip_prefix("#EXT-X-SESSION-KEY:") {
            check_key_attrs(&parse_attributes(rest), "#EXT-X-SESSION-KEY")?;
        } else if let Some(rest) = line.strip_prefix("#EXT-X-KEY:") {
            check_key_attrs(&parse_attributes(rest), "#EXT-X-KEY")?;
        }
    }

    if is_master {
        parse_master(text, base).map(HlsPlaylist::Master)
    } else {
        parse_media(text, base).map(HlsPlaylist::Media)
    }
}

fn parse_master(text: &str, base: &Url) -> Result<HlsMaster> {
    let mut variants = Vec::new();
    let mut renditions = Vec::new();
    let mut pending: Option<HashMap<String, String>> = None;
    for line in text.lines().map(str::trim).filter(|l| !l.is_empty()) {
        if let Some(rest) = line.strip_prefix("#EXT-X-STREAM-INF:") {
            pending = Some(parse_attributes(rest));
        } else if let Some(rest) = line.strip_prefix("#EXT-X-MEDIA:") {
            let a = parse_attributes(rest);
            let url = match a.get("URI") {
                Some(u) => Some(resolve(base, u)?),
                None => None,
            };
            renditions.push(HlsRendition {
                media_type: a
                    .get("TYPE")
                    .cloned()
                    .unwrap_or_default()
                    .to_ascii_uppercase(),
                group_id: a.get("GROUP-ID").cloned().unwrap_or_default(),
                name: a.get("NAME").cloned().unwrap_or_default(),
                language: a.get("LANGUAGE").cloned(),
                url,
                is_default: a
                    .get("DEFAULT")
                    .is_some_and(|v| v.eq_ignore_ascii_case("YES")),
                autoselect: a
                    .get("AUTOSELECT")
                    .is_some_and(|v| v.eq_ignore_ascii_case("YES")),
            });
        } else if line.starts_with('#') {
            continue;
        } else if let Some(a) = pending.take() {
            let (width, height) = a
                .get("RESOLUTION")
                .and_then(|r| {
                    let (w, h) = r.split_once(['x', 'X'])?;
                    Some((w.trim().parse().ok()?, h.trim().parse().ok()?))
                })
                .map_or((None, None), |(w, h)| (Some(w), Some(h)));
            variants.push(HlsVariant {
                url: resolve(base, line)?,
                bandwidth: a.get("BANDWIDTH").and_then(|v| v.parse().ok()).unwrap_or(0),
                average_bandwidth: a.get("AVERAGE-BANDWIDTH").and_then(|v| v.parse().ok()),
                width,
                height,
                frame_rate: a.get("FRAME-RATE").and_then(|v| v.parse().ok()),
                codecs: a.get("CODECS").cloned(),
                audio_group: a.get("AUDIO").cloned(),
                subtitles_group: a.get("SUBTITLES").cloned(),
            });
        }
    }
    if variants.is_empty() {
        return Err(DownloadError::Parse(
            "master playlist has no variants".into(),
        ));
    }
    Ok(HlsMaster {
        variants,
        renditions,
    })
}

fn parse_media(text: &str, base: &Url) -> Result<HlsMedia> {
    let mut version = None;
    let mut target_duration = 0.0;
    let mut media_sequence = 0u64;
    let mut playlist_type = None;
    let mut end_list = false;
    let mut segments: Vec<HlsSegment> = Vec::new();

    let mut key: Option<HlsKey> = None;
    let mut map: Option<HlsMap> = None;
    let mut pending_dur: Option<f64> = None;
    let mut pending_range: Option<ByteRange> = None;
    let mut next_offset = 0u64;
    let mut discontinuity = false;
    let mut seq = 0u64;

    for line in text.lines().map(str::trim).filter(|l| !l.is_empty()) {
        if let Some(rest) = line.strip_prefix('#') {
            if let Some(v) = rest.strip_prefix("EXT-X-VERSION:") {
                version = v.trim().parse().ok();
            } else if let Some(v) = rest.strip_prefix("EXT-X-TARGETDURATION:") {
                target_duration = v.trim().parse().unwrap_or(0.0);
            } else if let Some(v) = rest.strip_prefix("EXT-X-MEDIA-SEQUENCE:") {
                media_sequence = v.trim().parse().unwrap_or(0);
                seq = media_sequence;
            } else if let Some(v) = rest.strip_prefix("EXT-X-PLAYLIST-TYPE:") {
                playlist_type = Some(v.trim().to_string());
            } else if rest.starts_with("EXT-X-ENDLIST") {
                end_list = true;
            } else if rest.starts_with("EXT-X-DISCONTINUITY")
                && !rest.starts_with("EXT-X-DISCONTINUITY-")
            {
                discontinuity = true;
            } else if let Some(v) = rest.strip_prefix("EXT-X-KEY:") {
                let a = parse_attributes(v);
                key = if check_key_attrs(&a, "#EXT-X-KEY")? {
                    let uri = a
                        .get("URI")
                        .ok_or_else(|| DownloadError::Parse("AES-128 key without URI".into()))?;
                    Some(HlsKey {
                        url: resolve(base, uri)?,
                        iv: a.get("IV").and_then(|s| parse_iv(s)),
                    })
                } else {
                    None
                };
            } else if let Some(v) = rest.strip_prefix("EXT-X-MAP:") {
                let a = parse_attributes(v);
                let uri = a
                    .get("URI")
                    .ok_or_else(|| DownloadError::Parse("EXT-X-MAP without URI".into()))?;
                map = Some(HlsMap {
                    url: resolve(base, uri)?,
                    byte_range: a.get("BYTERANGE").and_then(|b| parse_byterange(b, 0)),
                });
            } else if let Some(v) = rest.strip_prefix("EXT-X-BYTERANGE:") {
                pending_range = parse_byterange(v, next_offset);
            } else if let Some(v) = rest.strip_prefix("EXTINF:") {
                pending_dur = Some(
                    v.split(',')
                        .next()
                        .unwrap_or("0")
                        .trim()
                        .parse()
                        .unwrap_or(0.0),
                );
            }
            continue;
        }
        // URI line.
        let range = pending_range.take();
        if let Some(r) = range {
            next_offset = r.offset + r.length;
        }
        segments.push(HlsSegment {
            sequence: seq,
            duration: pending_dur.take().unwrap_or(0.0),
            url: resolve(base, line)?,
            byte_range: range,
            discontinuity: std::mem::take(&mut discontinuity),
            key: key.clone(),
            map: map.clone(),
        });
        seq += 1;
    }
    let total_duration = segments.iter().map(|s| s.duration).sum();
    Ok(HlsMedia {
        version,
        target_duration,
        media_sequence,
        playlist_type,
        end_list,
        total_duration,
        segments,
    })
}

/// Pick a variant from a master playlist.
pub fn select_variant(master: &HlsMaster, quality: Quality) -> Option<&HlsVariant> {
    let cands: Vec<(u64, Option<u32>)> = master
        .variants
        .iter()
        .map(|v| (v.bandwidth, v.height))
        .collect();
    pick_by_quality(&cands, quality).map(|i| &master.variants[i])
}

/// Separate audio rendition for a variant, if it references an AUDIO group whose
/// renditions have their own playlists (i.e. audio is not muxed into the variant).
pub fn audio_rendition_for<'a>(
    master: &'a HlsMaster,
    variant: &HlsVariant,
) -> Option<&'a HlsRendition> {
    let group = variant.audio_group.as_deref()?;
    let all: Vec<&HlsRendition> = master
        .renditions
        .iter()
        .filter(|r| r.media_type == "AUDIO" && r.group_id == group && r.url.is_some())
        .collect();
    all.iter()
        .find(|r| r.is_default)
        .or_else(|| all.iter().find(|r| r.autoselect))
        .or_else(|| all.first())
        .copied()
}

/// AES-128-CBC IV for a segment: explicit IV, otherwise the media sequence number big-endian.
pub fn segment_iv(key: &HlsKey, sequence: u64) -> [u8; 16] {
    key.iv.unwrap_or_else(|| {
        let mut iv = [0u8; 16];
        iv[8..].copy_from_slice(&sequence.to_be_bytes());
        iv
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> Url {
        Url::parse("http://h.test/v/index.m3u8").unwrap()
    }

    const MASTER: &str = "#EXTM3U\n#EXT-X-VERSION:4\n\
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"aud\",NAME=\"English\",LANGUAGE=\"en\",DEFAULT=YES,AUTOSELECT=YES,URI=\"audio/en.m3u8\"\n\
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID=\"subs\",NAME=\"EN\",URI=\"subs/en.m3u8\"\n\
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS=\"avc1.4d401e,mp4a.40.2\",AUDIO=\"aud\"\n360/p.m3u8\n\
#EXT-X-STREAM-INF:BANDWIDTH=3000000,AVERAGE-BANDWIDTH=2500000,RESOLUTION=1920x1080,FRAME-RATE=29.97,AUDIO=\"aud\"\n1080/p.m3u8\n\
#EXT-X-STREAM-INF:BANDWIDTH=1400000,RESOLUTION=1280x720\nhttp://cdn.test/720/p.m3u8\n";

    #[test]
    fn master_and_selection() {
        let HlsPlaylist::Master(m) = parse_playlist(MASTER, &base()).unwrap() else {
            panic!()
        };
        assert_eq!(m.variants.len(), 3);
        assert_eq!(m.variants[0].url, "http://h.test/v/360/p.m3u8");
        assert_eq!(
            m.variants[0].codecs.as_deref(),
            Some("avc1.4d401e,mp4a.40.2")
        );
        assert_eq!(m.variants[2].url, "http://cdn.test/720/p.m3u8");
        assert_eq!(m.renditions.len(), 2);
        let h = |q| select_variant(&m, q).unwrap().height;
        assert_eq!(h(Quality::Best), Some(1080));
        assert_eq!(h(Quality::Worst), Some(360));
        assert_eq!(h(Quality::MaxHeight(720)), Some(720));
        assert_eq!(h(Quality::MaxHeight(100)), Some(360));
        assert_eq!(h(Quality::Bandwidth(1_500_000)), Some(720));
        assert_eq!(h(Quality::Bandwidth(10)), Some(360));
        let best = select_variant(&m, Quality::Best).unwrap();
        let audio = audio_rendition_for(&m, best).unwrap();
        assert_eq!(audio.url.as_deref(), Some("http://h.test/v/audio/en.m3u8"));
        let muxed = select_variant(&m, Quality::MaxHeight(720)).unwrap();
        assert!(audio_rendition_for(&m, muxed).is_none());
    }

    #[test]
    fn media_with_everything() {
        let text = "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:10\n\
#EXT-X-MAP:URI=\"init.mp4\",BYTERANGE=\"720@0\"\n\
#EXT-X-KEY:METHOD=AES-128,URI=\"k.bin\",IV=0x000102030405060708090a0b0c0d0e0f\n\
#EXTINF:6.0,\n#EXT-X-BYTERANGE:1000@0\nmedia.mp4\n\
#EXTINF:5.5,\n#EXT-X-BYTERANGE:500\nmedia.mp4\n\
#EXT-X-DISCONTINUITY\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:4,\nplain.mp4\n#EXT-X-ENDLIST\n";
        let HlsPlaylist::Media(m) = parse_playlist(text, &base()).unwrap() else {
            panic!()
        };
        assert!(m.end_list);
        assert_eq!(m.media_sequence, 10);
        assert_eq!(m.segments.len(), 3);
        assert_eq!(
            m.segments[0].byte_range,
            Some(ByteRange {
                offset: 0,
                length: 1000
            })
        );
        assert_eq!(
            m.segments[1].byte_range,
            Some(ByteRange {
                offset: 1000,
                length: 500
            })
        );
        assert_eq!(m.segments[1].sequence, 11);
        assert!(m.segments[2].discontinuity && m.segments[2].key.is_none());
        let k = m.segments[0].key.as_ref().unwrap();
        assert_eq!(k.url, "http://h.test/v/k.bin");
        assert_eq!(k.iv.unwrap()[15], 0x0f);
        assert_eq!(
            m.segments[0].map.as_ref().unwrap().byte_range,
            Some(ByteRange {
                offset: 0,
                length: 720
            })
        );
        assert!((m.total_duration - 15.5).abs() < 1e-9);
        let nokey = HlsKey {
            url: String::new(),
            iv: None,
        };
        assert_eq!(segment_iv(&nokey, 0x0102)[14..], [1, 2]);
    }

    #[test]
    fn drm_is_refused() {
        for key in [
            "#EXT-X-KEY:METHOD=SAMPLE-AES,URI=\"skd://x\",KEYFORMAT=\"com.apple.streamingkeydelivery\"",
            "#EXT-X-KEY:METHOD=SAMPLE-AES-CTR,URI=\"data:text/plain;base64,AA==\"",
            "#EXT-X-KEY:METHOD=AES-128,URI=\"k\",KEYFORMAT=\"urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed\"",
        ] {
            let text = format!("#EXTM3U\n#EXT-X-TARGETDURATION:4\n{key}\n#EXTINF:4,\ns.ts\n");
            assert!(matches!(parse_playlist(&text, &base()), Err(DownloadError::DrmProtected(_))), "{key}");
        }
        let master = "#EXTM3U\n#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI=\"skd://a\",KEYFORMAT=\"com.apple.streamingkeydelivery\"\n\
#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8\n";
        assert!(matches!(
            parse_playlist(master, &base()),
            Err(DownloadError::DrmProtected(_))
        ));
        // identity keyformat is fine
        let ok = "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"k\",KEYFORMAT=\"identity\"\n#EXTINF:4,\ns.ts\n";
        assert!(parse_playlist(ok, &base()).is_ok());
    }

    #[test]
    fn rejects_non_m3u8() {
        assert!(parse_playlist("<html></html>", &base()).is_err());
    }
}
