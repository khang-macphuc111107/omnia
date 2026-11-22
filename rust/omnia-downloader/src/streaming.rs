//! HLS (`.m3u8`) and MPEG-DASH (`.mpd`) streaming manifest parsers + authorized
//! standard HLS `AES-128-CBC` decryption (`aes` + `cbc`).
//!
//! Strict compliance invariants:
//! - Commercial DRM (`SAMPLE-AES`, `SAMPLE-AES-CTR`, `SAMPLE-AES-CENC`, Widevine,
//!   PlayReady, FairPlay, DASH `<ContentProtection>` DRM schemes) is unconditionally
//!   rejected with [`DownloaderError::DrmUnsupported`] (`drm_supported = false`).
//! - DASH XML parsing enforces a strict XXE (`<!DOCTYPE`/`<!ENTITY`) guard before parsing.

use std::collections::BTreeMap;

use aes::Aes128;
use cbc::cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};
use omnia_core::hex_decode;
use quick_xml::events::Event;
use quick_xml::Reader;
use serde::{Deserialize, Serialize};
use url::Url;

use crate::types::{DownloaderError, DRM_SUPPORTED};

type Aes128CbcDec = cbc::Decryptor<Aes128>;

/// HLS variant stream entry from a Master playlist (`#EXT-X-STREAM-INF`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HlsVariant {
    pub uri: String,
    pub bandwidth: Option<u64>,
    pub resolution: Option<String>,
    pub codecs: Option<String>,
    pub audio_group: Option<String>,
}

/// Authorized HLS `AES-128` encryption parameters (`METHOD=AES-128` only; commercial DRM rejected).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HlsAes128Key {
    pub uri: String,
    /// Optional explicit 16-byte IV from `IV=0x...`; if `None`, RFC 8216 derives IV from media sequence.
    pub explicit_iv: Option<[u8; 16]>,
}

/// Optional `#EXT-X-BYTERANGE` slice (`length@offset`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct HlsByteRange {
    pub length: u64,
    pub offset: u64,
}

/// Individual HLS media segment parsed from a Media playlist.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HlsSegment {
    pub sequence: u64,
    pub uri: String,
    pub duration_secs: f64,
    pub byte_range: Option<HlsByteRange>,
    pub discontinuity: bool,
    pub init_map_uri: Option<String>,
    pub aes128_key: Option<HlsAes128Key>,
}

/// Parsed HLS `.m3u8` Master or Media manifest.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HlsManifest {
    pub is_master: bool,
    pub target_duration: Option<u64>,
    pub media_sequence: u64,
    pub end_list: bool,
    pub variants: Vec<HlsVariant>,
    pub segments: Vec<HlsSegment>,
    pub drm_supported: bool,
}

/// Parses an HLS `.m3u8` playlist relative to `base_url`.
///
/// Rejects commercial DRM (`METHOD=SAMPLE-AES*` or FairPlay/Widevine/PlayReady `KEYFORMAT`)
/// with [`DownloaderError::DrmUnsupported`].
pub fn parse_hls_manifest(content: &str, base_url: &str) -> Result<HlsManifest, DownloaderError> {
    let base = Url::parse(base_url)
        .map_err(|e| DownloaderError::InvalidInput(format!("invalid HLS base_url: {e}")))?;

    let mut lines = content.lines().map(str::trim).filter(|l| !l.is_empty());
    let first = lines.next().unwrap_or("");
    if first != "#EXTM3U" {
        return Err(DownloaderError::InvalidInput(
            "HLS playlist missing #EXTM3U header".into(),
        ));
    }

    let mut is_master = false;
    let mut target_duration = None;
    let mut media_sequence = 0u64;
    let mut current_seq = 0u64;
    let mut end_list = false;
    let mut variants = Vec::new();
    let mut segments = Vec::new();

    let mut pending_stream_inf: Option<BTreeMap<String, String>> = None;
    let mut pending_duration: Option<f64> = None;
    let mut pending_byterange: Option<HlsByteRange> = None;
    let mut last_byterange_end = 0u64;
    let mut pending_discontinuity = false;
    let mut current_map_uri: Option<String> = None;
    let mut current_key: Option<HlsAes128Key> = None;

    for line in lines {
        if let Some(rest) = line.strip_prefix("#EXT-X-STREAM-INF:") {
            is_master = true;
            pending_stream_inf = Some(parse_attribute_list(rest));
            continue;
        }
        if let Some(rest) = line.strip_prefix("#EXT-X-TARGETDURATION:") {
            target_duration = rest.trim().parse::<u64>().ok();
            continue;
        }
        if let Some(rest) = line.strip_prefix("#EXT-X-MEDIA-SEQUENCE:") {
            if let Ok(seq) = rest.trim().parse::<u64>() {
                media_sequence = seq;
                current_seq = seq;
            }
            continue;
        }
        if line == "#EXT-X-ENDLIST" {
            end_list = true;
            continue;
        }
        if line == "#EXT-X-DISCONTINUITY" {
            pending_discontinuity = true;
            continue;
        }
        if let Some(rest) = line.strip_prefix("#EXT-X-MAP:") {
            let attrs = parse_attribute_list(rest);
            if let Some(raw_uri) = attrs.get("URI") {
                current_map_uri = Some(resolve_relative_url(&base, raw_uri)?);
            }
            continue;
        }
        if let Some(rest) = line.strip_prefix("#EXT-X-KEY:") {
            let attrs = parse_attribute_list(rest);
            let method = attrs
                .get("METHOD")
                .map(|m| m.to_ascii_uppercase())
                .unwrap_or_else(|| "NONE".to_string());
            let keyformat = attrs
                .get("KEYFORMAT")
                .map(|k| k.to_ascii_lowercase())
                .unwrap_or_default();

            if method.starts_with("SAMPLE-AES")
                || keyformat.contains("streamingkeydelivery")
                || keyformat.contains("edef8ba9")
                || keyformat.contains("9a04f079")
                || keyformat.contains("94ce86fb")
            {
                return Err(DownloaderError::DrmUnsupported {
                    detail: format!(
                        "HLS commercial DRM key rejected (METHOD={method}, KEYFORMAT={keyformat}); drm_supported=false"
                    ),
                });
            }

            match method.as_str() {
                "NONE" => current_key = None,
                "AES-128" => {
                    let raw_uri = attrs.get("URI").ok_or_else(|| {
                        DownloaderError::InvalidInput("HLS AES-128 key missing URI".into())
                    })?;
                    let resolved_uri = resolve_relative_url(&base, raw_uri)?;
                    let explicit_iv = match attrs.get("IV") {
                        Some(iv_str) => Some(parse_hls_iv(iv_str)?),
                        None => None,
                    };
                    current_key = Some(HlsAes128Key {
                        uri: resolved_uri,
                        explicit_iv,
                    });
                }
                other => {
                    return Err(DownloaderError::DrmUnsupported {
                        detail: format!("unsupported HLS encryption method `{other}`"),
                    });
                }
            }
            continue;
        }
        if let Some(rest) = line.strip_prefix("#EXTINF:") {
            let dur_str = rest.split(',').next().unwrap_or("0").trim();
            pending_duration = Some(dur_str.parse::<f64>().unwrap_or(0.0));
            continue;
        }
        if let Some(rest) = line.strip_prefix("#EXT-X-BYTERANGE:") {
            let (len_s, off_s) = match rest.trim().split_once('@') {
                Some((l, o)) => (l, Some(o)),
                None => (rest.trim(), None),
            };
            let length = len_s.parse::<u64>().map_err(|_| {
                DownloaderError::InvalidInput(format!("invalid EXT-X-BYTERANGE `{rest}`"))
            })?;
            let offset = match off_s {
                Some(o) => o.parse::<u64>().map_err(|_| {
                    DownloaderError::InvalidInput(format!("invalid EXT-X-BYTERANGE offset `{o}`"))
                })?,
                None => last_byterange_end,
            };
            last_byterange_end = offset.saturating_add(length);
            pending_byterange = Some(HlsByteRange { length, offset });
            continue;
        }
        if line.starts_with('#') {
            continue;
        }

        // URI line
        let resolved = resolve_relative_url(&base, line)?;
        if let Some(attrs) = pending_stream_inf.take() {
            variants.push(HlsVariant {
                uri: resolved,
                bandwidth: attrs.get("BANDWIDTH").and_then(|v| v.parse::<u64>().ok()),
                resolution: attrs.get("RESOLUTION").cloned(),
                codecs: attrs.get("CODECS").cloned(),
                audio_group: attrs.get("AUDIO").cloned(),
            });
        } else if let Some(dur) = pending_duration.take() {
            segments.push(HlsSegment {
                sequence: current_seq,
                uri: resolved,
                duration_secs: dur,
                byte_range: pending_byterange.take(),
                discontinuity: pending_discontinuity,
                init_map_uri: current_map_uri.clone(),
                aes128_key: current_key.clone(),
            });
            pending_discontinuity = false;
            current_seq = current_seq.saturating_add(1);
        }
    }

    Ok(HlsManifest {
        is_master,
        target_duration,
        media_sequence,
        end_list,
        variants,
        segments,
        drm_supported: DRM_SUPPORTED,
    })
}

/// Derives RFC 8216 default 16-byte AES-128-CBC IV from a segment's media sequence number.
#[must_use]
pub fn hls_sequence_iv(media_sequence: u64) -> [u8; 16] {
    let mut iv = [0u8; 16];
    iv[8..16].copy_from_slice(&media_sequence.to_be_bytes());
    iv
}

/// Decrypts an authorized non-DRM HLS `AES-128-CBC` (PKCS#7 padded) segment payload.
pub fn decrypt_hls_aes128_cbc(
    ciphertext: &[u8],
    key: &[u8; 16],
    iv: &[u8; 16],
) -> Result<Vec<u8>, DownloaderError> {
    if ciphertext.is_empty() || !ciphertext.len().is_multiple_of(16) {
        return Err(DownloaderError::InvalidInput(format!(
            "AES-128-CBC ciphertext length {} must be a positive multiple of 16",
            ciphertext.len()
        )));
    }
    let mut buf = ciphertext.to_vec();
    let decrypted = Aes128CbcDec::new(key.into(), iv.into())
        .decrypt_padded_mut::<Pkcs7>(&mut buf)
        .map_err(|_| {
            DownloaderError::InvalidInput("HLS AES-128-CBC PKCS#7 unpadding failed".into())
        })?;
    Ok(decrypted.to_vec())
}

fn parse_hls_iv(raw: &str) -> Result<[u8; 16], DownloaderError> {
    let hex_str = raw
        .trim()
        .strip_prefix("0x")
        .or_else(|| raw.trim().strip_prefix("0X"))
        .unwrap_or(raw.trim());
    let decoded = hex_decode(hex_str)
        .map_err(|e| DownloaderError::InvalidInput(format!("invalid HLS IV hex `{raw}`: {e}")))?;
    if decoded.len() != 16 {
        return Err(DownloaderError::InvalidInput(format!(
            "HLS IV must be 16 bytes, got {}",
            decoded.len()
        )));
    }
    let mut iv = [0u8; 16];
    iv.copy_from_slice(&decoded);
    Ok(iv)
}

fn parse_attribute_list(input: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let bytes = input.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        while i < bytes.len() && (bytes[i] == b',' || bytes[i].is_ascii_whitespace()) {
            i += 1;
        }
        let key_start = i;
        while i < bytes.len() && bytes[i] != b'=' && bytes[i] != b',' {
            i += 1;
        }
        if i >= bytes.len() || bytes[i] != b'=' {
            break;
        }
        let key = input[key_start..i].trim().to_ascii_uppercase();
        i += 1; // skip '='

        let val = if i < bytes.len() && bytes[i] == b'"' {
            i += 1;
            let val_start = i;
            while i < bytes.len() && bytes[i] != b'"' {
                i += 1;
            }
            let v = input[val_start..i].to_string();
            if i < bytes.len() {
                i += 1; // closing quote
            }
            v
        } else {
            let val_start = i;
            while i < bytes.len() && bytes[i] != b',' {
                i += 1;
            }
            input[val_start..i].trim().to_string()
        };
        if !key.is_empty() {
            out.insert(key, val);
        }
    }
    out
}

/// Expanded DASH media segment descriptor.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DashSegment {
    pub number: u64,
    pub time: Option<u64>,
    pub duration: Option<u64>,
    pub uri: String,
}

/// Parsed MPEG-DASH `<Representation>` stream.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DashRepresentation {
    pub id: String,
    pub bandwidth: Option<u64>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub codecs: Option<String>,
    pub mime_type: Option<String>,
    pub timescale: Option<u64>,
    pub init_uri: Option<String>,
    pub segments: Vec<DashSegment>,
}

/// Parsed MPEG-DASH `<AdaptationSet>`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DashAdaptationSet {
    pub mime_type: Option<String>,
    pub content_type: Option<String>,
    pub lang: Option<String>,
    pub drm_schemes: Vec<String>,
    pub representations: Vec<DashRepresentation>,
}

/// Parsed MPEG-DASH `.mpd` manifest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DashManifest {
    pub manifest_type: String,
    pub media_presentation_duration: Option<String>,
    pub base_url: String,
    pub adaptation_sets: Vec<DashAdaptationSet>,
    pub drm_detected: bool,
    pub drm_supported: bool,
}

impl DashManifest {
    /// Rejects DRM-protected DASH manifests (`drm_supported = false`).
    pub fn enforce_no_drm(&self) -> Result<(), DownloaderError> {
        if self.drm_detected {
            return Err(DownloaderError::DrmUnsupported {
                detail: "MPEG-DASH manifest declares <ContentProtection> DRM; drm_supported=false"
                    .into(),
            });
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Default)]
struct SegmentTemplateCtx {
    media: Option<String>,
    initialization: Option<String>,
    timescale: u64,
    duration: Option<u64>,
    start_number: u64,
    timeline: Vec<(Option<u64>, u64, i64)>, // (t, d, r)
}

/// Parses an MPEG-DASH `.mpd` XML document relative to `base_url`.
///
/// Enforces XXE (`<!DOCTYPE`/`<!ENTITY`) rejection before XML parsing and flags
/// `<ContentProtection>` DRM elements strictly read-only (`drm_supported = false`).
pub fn parse_dash_manifest(xml_content: &str, base_url: &str) -> Result<DashManifest, DownloaderError> {
    let upper = xml_content.to_ascii_uppercase();
    if upper.contains("<!DOCTYPE") || upper.contains("<!ENTITY") {
        return Err(DownloaderError::SecurityRejected(
            "XXE DOCTYPE/ENTITY declaration rejected in DASH MPD manifest".into(),
        ));
    }

    let mut current_base = Url::parse(base_url)
        .map_err(|e| DownloaderError::InvalidInput(format!("invalid DASH base_url: {e}")))?;

    let mut reader = Reader::from_str(xml_content);
    reader.config_mut().trim_text(true);

    let mut manifest_type = "static".to_string();
    let mut duration_attr = None;
    let mut adaptation_sets: Vec<DashAdaptationSet> = Vec::new();
    let mut drm_detected = false;

    let mut in_base_url = false;
    let mut current_as: Option<DashAdaptationSet> = None;
    let mut as_template: Option<SegmentTemplateCtx> = None;
    let mut current_rep: Option<DashRepresentation> = None;
    let mut rep_template: Option<SegmentTemplateCtx> = None;
    let mut rep_segment_urls: Vec<String> = Vec::new();

    let mut buf = Vec::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) => {
                let name_bytes = e.local_name();
                let name = std::str::from_utf8(name_bytes.as_ref()).unwrap_or("");
                let attrs = collect_xml_attrs(e);
                match name {
                    "MPD" => {
                        if let Some(t) = attrs.get("type") {
                            manifest_type = t.clone();
                        }
                        duration_attr = attrs.get("mediaPresentationDuration").cloned();
                    }
                    "BaseURL" => in_base_url = true,
                    "AdaptationSet" => {
                        current_as = Some(DashAdaptationSet {
                            mime_type: attrs.get("mimeType").cloned(),
                            content_type: attrs.get("contentType").cloned(),
                            lang: attrs.get("lang").cloned(),
                            drm_schemes: Vec::new(),
                            representations: Vec::new(),
                        });
                        as_template = None;
                    }
                    "Representation" => {
                        current_rep = Some(DashRepresentation {
                            id: attrs
                                .get("id")
                                .cloned()
                                .unwrap_or_else(|| "rep-0".to_string()),
                            bandwidth: attrs.get("bandwidth").and_then(|v| v.parse().ok()),
                            width: attrs.get("width").and_then(|v| v.parse().ok()),
                            height: attrs.get("height").and_then(|v| v.parse().ok()),
                            codecs: attrs.get("codecs").cloned(),
                            mime_type: attrs.get("mimeType").cloned().or_else(|| {
                                current_as.as_ref().and_then(|a| a.mime_type.clone())
                            }),
                            timescale: None,
                            init_uri: None,
                            segments: Vec::new(),
                        });
                        rep_template = None;
                        rep_segment_urls.clear();
                    }
                    "ContentProtection" => {
                        if let Some(scheme) = attrs.get("schemeIdUri") {
                            if is_drm_scheme(scheme) {
                                drm_detected = true;
                                if let Some(ref mut a) = current_as {
                                    a.drm_schemes.push(scheme.clone());
                                }
                            }
                        }
                    }
                    "SegmentTemplate" => {
                        let tpl = parse_segment_template_attrs(&attrs);
                        if current_rep.is_some() {
                            rep_template = Some(tpl);
                        } else if current_as.is_some() {
                            as_template = Some(tpl);
                        }
                    }
                    "S" => {
                        if let Some(entry) = parse_timeline_s(&attrs) {
                            if let Some(ref mut tpl) = rep_template {
                                tpl.timeline.push(entry);
                            } else if let Some(ref mut tpl) = as_template {
                                tpl.timeline.push(entry);
                            }
                        }
                    }
                    "SegmentURL" => {
                        if let Some(media) = attrs.get("media") {
                            rep_segment_urls.push(media.clone());
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Empty(ref e)) => {
                let name_bytes = e.local_name();
                let name = std::str::from_utf8(name_bytes.as_ref()).unwrap_or("");
                let attrs = collect_xml_attrs(e);
                match name {
                    "Representation" => {
                        let mut rep = DashRepresentation {
                            id: attrs
                                .get("id")
                                .cloned()
                                .unwrap_or_else(|| "rep-0".to_string()),
                            bandwidth: attrs.get("bandwidth").and_then(|v| v.parse().ok()),
                            width: attrs.get("width").and_then(|v| v.parse().ok()),
                            height: attrs.get("height").and_then(|v| v.parse().ok()),
                            codecs: attrs.get("codecs").cloned(),
                            mime_type: attrs.get("mimeType").cloned().or_else(|| {
                                current_as.as_ref().and_then(|a| a.mime_type.clone())
                            }),
                            timescale: None,
                            init_uri: None,
                            segments: Vec::new(),
                        };
                        if let Some(ref tpl) = as_template {
                            populate_rep_from_template(&mut rep, tpl, &current_base)?;
                        }
                        if let Some(ref mut a) = current_as {
                            a.representations.push(rep);
                        }
                    }
                    "ContentProtection" => {
                        if let Some(scheme) = attrs.get("schemeIdUri") {
                            if is_drm_scheme(scheme) {
                                drm_detected = true;
                                if let Some(ref mut a) = current_as {
                                    a.drm_schemes.push(scheme.clone());
                                }
                            }
                        }
                    }
                    "SegmentTemplate" => {
                        let tpl = parse_segment_template_attrs(&attrs);
                        if current_rep.is_some() {
                            rep_template = Some(tpl);
                        } else if current_as.is_some() {
                            as_template = Some(tpl);
                        }
                    }
                    "S" => {
                        if let Some(entry) = parse_timeline_s(&attrs) {
                            if let Some(ref mut tpl) = rep_template {
                                tpl.timeline.push(entry);
                            } else if let Some(ref mut tpl) = as_template {
                                tpl.timeline.push(entry);
                            }
                        }
                    }
                    "SegmentURL" => {
                        if let Some(media) = attrs.get("media") {
                            rep_segment_urls.push(media.clone());
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Text(e)) if in_base_url => {
                if let Ok(txt) = e.unescape() {
                    let trimmed = txt.trim();
                    if !trimmed.is_empty() {
                        if let Ok(joined) = current_base.join(trimmed) {
                            current_base = joined;
                        }
                    }
                }
            }
            Ok(Event::End(ref e)) => {
                let name_bytes = e.local_name();
                let name = std::str::from_utf8(name_bytes.as_ref()).unwrap_or("");
                match name {
                    "BaseURL" => in_base_url = false,
                    "Representation" => {
                        if let Some(mut rep) = current_rep.take() {
                            let effective_tpl = rep_template.take().or_else(|| as_template.clone());
                            if let Some(tpl) = effective_tpl {
                                populate_rep_from_template(&mut rep, &tpl, &current_base)?;
                            }
                            if !rep_segment_urls.is_empty() {
                                for (idx, raw) in rep_segment_urls.drain(..).enumerate() {
                                    let uri = resolve_relative_url(&current_base, &raw)?;
                                    rep.segments.push(DashSegment {
                                        number: (idx as u64) + 1,
                                        time: None,
                                        duration: None,
                                        uri,
                                    });
                                }
                            }
                            if let Some(ref mut a) = current_as {
                                a.representations.push(rep);
                            }
                        }
                    }
                    "AdaptationSet" => {
                        if let Some(a) = current_as.take() {
                            adaptation_sets.push(a);
                        }
                        as_template = None;
                    }
                    _ => {}
                }
            }
            Ok(Event::Eof) => break,
            Err(err) => {
                return Err(DownloaderError::InvalidInput(format!(
                    "DASH MPD XML parse error: {err}"
                )));
            }
            _ => {}
        }
        buf.clear();
    }

    Ok(DashManifest {
        manifest_type,
        media_presentation_duration: duration_attr,
        base_url: current_base.to_string(),
        adaptation_sets,
        drm_detected,
        drm_supported: DRM_SUPPORTED,
    })
}

fn collect_xml_attrs(e: &quick_xml::events::BytesStart<'_>) -> BTreeMap<String, String> {
    let mut map = BTreeMap::new();
    for attr in e.attributes().flatten() {
        if let (Ok(k), Ok(v)) = (
            std::str::from_utf8(attr.key.as_ref()),
            attr.unescape_value(),
        ) {
            map.insert(k.to_string(), v.into_owned());
        }
    }
    map
}

fn parse_segment_template_attrs(attrs: &BTreeMap<String, String>) -> SegmentTemplateCtx {
    SegmentTemplateCtx {
        media: attrs.get("media").cloned(),
        initialization: attrs.get("initialization").cloned(),
        timescale: attrs
            .get("timescale")
            .and_then(|v| v.parse().ok())
            .unwrap_or(1),
        duration: attrs.get("duration").and_then(|v| v.parse().ok()),
        start_number: attrs
            .get("startNumber")
            .and_then(|v| v.parse().ok())
            .unwrap_or(1),
        timeline: Vec::new(),
    }
}

fn parse_timeline_s(attrs: &BTreeMap<String, String>) -> Option<(Option<u64>, u64, i64)> {
    let d = attrs.get("d")?.parse::<u64>().ok()?;
    let t = attrs.get("t").and_then(|v| v.parse::<u64>().ok());
    let r = attrs
        .get("r")
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(0);
    Some((t, d, r))
}

fn populate_rep_from_template(
    rep: &mut DashRepresentation,
    tpl: &SegmentTemplateCtx,
    base_url: &Url,
) -> Result<(), DownloaderError> {
    rep.timescale = Some(tpl.timescale);
    if let Some(ref init) = tpl.initialization {
        let substituted = substitute_dash_vars(init, &rep.id, rep.bandwidth, None, None);
        rep.init_uri = Some(resolve_relative_url(base_url, &substituted)?);
    }
    let Some(ref media_tpl) = tpl.media else {
        return Ok(());
    };

    if !tpl.timeline.is_empty() {
        let mut num = tpl.start_number;
        let mut time_cursor = 0u64;
        for &(t_opt, dur, repeat) in &tpl.timeline {
            if let Some(t) = t_opt {
                time_cursor = t;
            }
            let count = if repeat < 0 {
                1usize
            } else {
                (repeat as usize).saturating_add(1).min(4_096)
            };
            for _ in 0..count {
                let substituted = substitute_dash_vars(
                    media_tpl,
                    &rep.id,
                    rep.bandwidth,
                    Some(num),
                    Some(time_cursor),
                );
                let uri = resolve_relative_url(base_url, &substituted)?;
                rep.segments.push(DashSegment {
                    number: num,
                    time: Some(time_cursor),
                    duration: Some(dur),
                    uri,
                });
                num = num.saturating_add(1);
                time_cursor = time_cursor.saturating_add(dur);
            }
        }
    } else if tpl.duration.is_some() {
        let substituted = substitute_dash_vars(
            media_tpl,
            &rep.id,
            rep.bandwidth,
            Some(tpl.start_number),
            Some(0),
        );
        let uri = resolve_relative_url(base_url, &substituted)?;
        rep.segments.push(DashSegment {
            number: tpl.start_number,
            time: Some(0),
            duration: tpl.duration,
            uri,
        });
    }
    Ok(())
}

fn substitute_dash_vars(
    template: &str,
    rep_id: &str,
    bandwidth: Option<u64>,
    number: Option<u64>,
    time: Option<u64>,
) -> String {
    let mut s = template.replace("$RepresentationID$", rep_id);
    if let Some(bw) = bandwidth {
        s = s.replace("$Bandwidth$", &bw.to_string());
    }
    if let Some(n) = number {
        s = s.replace("$Number$", &n.to_string());
    }
    if let Some(t) = time {
        s = s.replace("$Time$", &t.to_string());
    }
    s
}

fn is_drm_scheme(scheme_uri: &str) -> bool {
    let low = scheme_uri.to_ascii_lowercase();
    low.contains("mp4protection")
        || low.contains("edef8ba9-79d6-4ace-a3c8-27dcd51d21ed")
        || low.contains("9a04f079-9840-4286-ab92-e65be0885f95")
        || low.contains("94ce86fb-07ff-4f43-adb8-93d2fa968ca2")
        || low.contains("urn:uuid:")
}

fn resolve_relative_url(base: &Url, raw: &str) -> Result<String, DownloaderError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(DownloaderError::InvalidInput("empty manifest URI".into()));
    }
    let joined = base
        .join(trimmed)
        .map_err(|e| DownloaderError::InvalidInput(format!("invalid manifest URI `{trimmed}`: {e}")))?;
    Ok(joined.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use cbc::cipher::BlockEncryptMut;

    #[test]
    fn parses_hls_aes128_and_decrypts_authorized_segment_while_rejecting_sample_aes() {
        let m3u8 = "\
#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:10
#EXT-X-KEY:METHOD=AES-128,URI=\"keys/seg.key\",IV=0x000102030405060708090a0b0c0d0e0f
#EXTINF:5.5,
seg_10.ts
#EXT-X-DISCONTINUITY
#EXTINF:6.0,
seg_11.ts
#EXT-X-ENDLIST
";
        let manifest =
            parse_hls_manifest(m3u8, "https://cdn.example.org/hls/index.m3u8").unwrap();
        assert!(!manifest.is_master);
        assert!(manifest.end_list);
        assert!(!manifest.drm_supported);
        assert_eq!(manifest.segments.len(), 2);
        assert_eq!(
            manifest.segments[0].uri,
            "https://cdn.example.org/hls/seg_10.ts"
        );
        assert_eq!(
            manifest.segments[0].aes128_key.as_ref().unwrap().uri,
            "https://cdn.example.org/hls/keys/seg.key"
        );
        assert!(manifest.segments[1].discontinuity);

        // Encrypt & decrypt test payload with AES-128-CBC + PKCS7
        let key: [u8; 16] = *b"0123456789abcdef";
        let iv: [u8; 16] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
        let plaintext = b"authorized hls segment payload!";
        let mut enc_buf = [0u8; 64];
        enc_buf[..plaintext.len()].copy_from_slice(plaintext);
        let ciphertext = cbc::Encryptor::<Aes128>::new((&key).into(), (&iv).into())
            .encrypt_padded_mut::<Pkcs7>(&mut enc_buf, plaintext.len())
            .unwrap()
            .to_vec();
        let decrypted = decrypt_hls_aes128_cbc(&ciphertext, &key, &iv).unwrap();
        assert_eq!(decrypted, plaintext);

        // Commercial SAMPLE-AES MUST fail closed with DrmUnsupported
        let drm_m3u8 = "\
#EXTM3U
#EXT-X-KEY:METHOD=SAMPLE-AES,URI=\"skd://fairplay\",KEYFORMAT=\"com.apple.streamingkeydelivery\"
#EXTINF:4.0,
seg0.ts
";
        let err = parse_hls_manifest(drm_m3u8, "https://cdn.example.org/drm/index.m3u8").unwrap_err();
        assert!(matches!(err, DownloaderError::DrmUnsupported { .. }));
    }

    #[test]
    fn parses_dash_mpd_timeline_and_rejects_xxe_and_drm_content_protection() {
        let mpd = r#"<?xml version="1.0" encoding="UTF-8"?>
<MPD type="static" mediaPresentationDuration="PT12S">
  <BaseURL>https://cdn.example.org/dash/</BaseURL>
  <Period>
    <AdaptationSet mimeType="video/mp4" contentType="video">
      <SegmentTemplate timescale="1000" initialization="init-$RepresentationID$.mp4" media="chunk-$RepresentationID$-$Number$.m4s" startNumber="1">
        <SegmentTimeline>
          <S t="0" d="4000" r="2"/>
        </SegmentTimeline>
      </SegmentTemplate>
      <Representation id="1080p" bandwidth="5000000" width="1920" height="1080" codecs="avc1.640028"/>
    </AdaptationSet>
  </Period>
</MPD>"#;

        let parsed = parse_dash_manifest(mpd, "https://cdn.example.org/dash/stream.mpd").unwrap();
        assert!(!parsed.drm_detected);
        assert!(!parsed.drm_supported);
        let rep = &parsed.adaptation_sets[0].representations[0];
        assert_eq!(
            rep.init_uri.as_deref(),
            Some("https://cdn.example.org/dash/init-1080p.mp4")
        );
        assert_eq!(rep.segments.len(), 3);
        assert_eq!(
            rep.segments[2].uri,
            "https://cdn.example.org/dash/chunk-1080p-3.m4s"
        );

        // XXE rejection
        let xxe = "<!DOCTYPE foo [<!ENTITY xxe SYSTEM \"file:///C:/Windows/win.ini\">]><MPD/>";
        assert!(matches!(
            parse_dash_manifest(xxe, "https://cdn.example.org/a.mpd"),
            Err(DownloaderError::SecurityRejected(_))
        ));

        // ContentProtection Widevine DRM detection + refusal
        let drm_mpd = r#"<MPD type="static"><Period><AdaptationSet mimeType="video/mp4"><ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/><Representation id="v1"/></AdaptationSet></Period></MPD>"#;
        let drm_parsed =
            parse_dash_manifest(drm_mpd, "https://cdn.example.org/drm.mpd").unwrap();
        assert!(drm_parsed.drm_detected);
        assert!(!drm_parsed.drm_supported);
        assert!(matches!(
            drm_parsed.enforce_no_drm(),
            Err(DownloaderError::DrmUnsupported { .. })
        ));
    }
}
