//! Read-only binary media container box inspector (`MediaBoxReport`).
//!
//! Inspects ISO-BMFF / MP4 / fMP4 (including read-only `pssh`/`encv`/`enca`/`sinf` DRM flags),
//! MPEG-TS (`0x47` stride), ADTS AAC (`0xFFF` sync), and WebM / Matroska EBML (`0x1A45DFA3`).
//!
//! Compliance invariant: `drm_supported` is ALWAYS `false`. This module performs strictly
//! read-only structural metadata inspection and NEVER decrypts commercial DRM payloads.

use std::fs::File;
use std::io::Read;
use std::path::Path;

use omnia_core::hex_encode;
use serde::{Deserialize, Serialize};

use crate::types::{validate_safe_local_path, DownloaderError, DRM_SUPPORTED};

/// Maximum bytes read from a file when inspecting container headers (2 MiB).
pub const MAX_INSPECT_FILE_BYTES: usize = 2 * 1024 * 1024;
const MAX_ISO_BOX_DEPTH: usize = 8;
const MAX_ISO_BOX_COUNT: usize = 4_096;

/// Identified binary media container format.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContainerFormat {
    IsoBmffMp4,
    MpegTs,
    AdtsAac,
    WebmMatroska,
    Unknown,
}

/// Read-only summary of a parsed ISO-BMFF box.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IsoBmffBoxInfo {
    pub box_type: String,
    pub offset: u64,
    pub size: u64,
    pub depth: usize,
}

/// Read-only metadata extracted from ISO-BMFF `pssh` / `schm` / `encv` / `enca` boxes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DrmBoxMetadata {
    pub box_type: String,
    pub system_id_uuid: Option<String>,
    pub system_name: Option<String>,
    pub offset: u64,
}

/// MPEG-TS structural probe summary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MpegTsInfo {
    pub packet_size: usize,
    pub packets_inspected: usize,
    pub distinct_pids: Vec<u16>,
    pub has_pat: bool,
    pub scrambled_packets: usize,
}

/// ADTS AAC structural probe summary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AdtsInfo {
    pub mpeg_version: String,
    pub profile: String,
    pub sample_rate_hz: u32,
    pub channels: u8,
    pub frames_inspected: usize,
}

/// WebM / Matroska EBML structural probe summary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WebmInfo {
    pub doc_type: Option<String>,
    pub has_content_encryption: bool,
}

/// Complete read-only media container inspection report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MediaBoxReport {
    pub format: ContainerFormat,
    pub bytes_inspected: usize,
    pub major_brand: Option<String>,
    pub compatible_brands: Vec<String>,
    pub is_fragmented_fmp4: bool,
    pub has_pssh: bool,
    pub drm_detected: bool,
    /// Hard compliance invariant — always `false`.
    pub drm_supported: bool,
    pub drm_boxes: Vec<DrmBoxMetadata>,
    pub iso_boxes: Vec<IsoBmffBoxInfo>,
    pub mpeg_ts: Option<MpegTsInfo>,
    pub adts: Option<AdtsInfo>,
    pub webm: Option<WebmInfo>,
}

impl MediaBoxReport {
    /// Returns `Err(DownloaderError::DrmUnsupported)` if commercial DRM was detected.
    pub fn enforce_no_drm(&self) -> Result<(), DownloaderError> {
        if self.drm_detected || self.has_pssh {
            let names: Vec<String> = self
                .drm_boxes
                .iter()
                .map(|b| {
                    b.system_name
                        .clone()
                        .or_else(|| b.system_id_uuid.clone())
                        .unwrap_or_else(|| b.box_type.clone())
                })
                .collect();
            return Err(DownloaderError::DrmUnsupported {
                detail: format!(
                    "read-only media inspection detected DRM/encryption markers ({}); drm_supported=false",
                    if names.is_empty() {
                        "encrypted_container".to_string()
                    } else {
                        names.join(", ")
                    }
                ),
            });
        }
        Ok(())
    }
}

/// Inspects up to [`MAX_INSPECT_FILE_BYTES`] from a local file in read-only mode.
pub fn inspect_media_file(path: &Path) -> Result<MediaBoxReport, DownloaderError> {
    let safe = validate_safe_local_path(path, None)?;
    let file = File::open(&safe)?;
    let mut buf = Vec::new();
    file.take(MAX_INSPECT_FILE_BYTES as u64)
        .read_to_end(&mut buf)?;
    Ok(inspect_media_bytes(&buf))
}

/// Read-only binary container inspector supporting ISO-BMFF/MP4/fMP4, MPEG-TS, ADTS, and WebM/EBML.
#[must_use]
pub fn inspect_media_bytes(bytes: &[u8]) -> MediaBoxReport {
    if bytes.len() >= 4 && bytes[0..4] == [0x1A, 0x45, 0xDF, 0xA3] {
        return inspect_ebml_webm(bytes);
    }
    if looks_like_iso_bmff(bytes) {
        return inspect_iso_bmff(bytes);
    }
    if let Some(ts) = inspect_mpeg_ts(bytes) {
        let drm_detected = ts.scrambled_packets > 0;
        return MediaBoxReport {
            format: ContainerFormat::MpegTs,
            bytes_inspected: bytes.len(),
            major_brand: None,
            compatible_brands: Vec::new(),
            is_fragmented_fmp4: false,
            has_pssh: false,
            drm_detected,
            drm_supported: DRM_SUPPORTED,
            drm_boxes: Vec::new(),
            iso_boxes: Vec::new(),
            mpeg_ts: Some(ts),
            adts: None,
            webm: None,
        };
    }
    if let Some(adts) = inspect_adts(bytes) {
        return MediaBoxReport {
            format: ContainerFormat::AdtsAac,
            bytes_inspected: bytes.len(),
            major_brand: None,
            compatible_brands: Vec::new(),
            is_fragmented_fmp4: false,
            has_pssh: false,
            drm_detected: false,
            drm_supported: DRM_SUPPORTED,
            drm_boxes: Vec::new(),
            iso_boxes: Vec::new(),
            mpeg_ts: None,
            adts: Some(adts),
            webm: None,
        };
    }

    MediaBoxReport {
        format: ContainerFormat::Unknown,
        bytes_inspected: bytes.len(),
        major_brand: None,
        compatible_brands: Vec::new(),
        is_fragmented_fmp4: false,
        has_pssh: false,
        drm_detected: false,
        drm_supported: DRM_SUPPORTED,
        drm_boxes: Vec::new(),
        iso_boxes: Vec::new(),
        mpeg_ts: None,
        adts: None,
        webm: None,
    }
}

fn looks_like_iso_bmff(bytes: &[u8]) -> bool {
    if bytes.len() < 8 {
        return false;
    }
    let fourcc = &bytes[4..8];
    matches!(
        fourcc,
        b"ftyp" | b"styp" | b"moov" | b"moof" | b"mdat" | b"free" | b"sidx" | b"pssh"
    )
}

fn inspect_iso_bmff(bytes: &[u8]) -> MediaBoxReport {
    let mut report = MediaBoxReport {
        format: ContainerFormat::IsoBmffMp4,
        bytes_inspected: bytes.len(),
        major_brand: None,
        compatible_brands: Vec::new(),
        is_fragmented_fmp4: false,
        has_pssh: false,
        drm_detected: false,
        drm_supported: DRM_SUPPORTED,
        drm_boxes: Vec::new(),
        iso_boxes: Vec::new(),
        mpeg_ts: None,
        adts: None,
        webm: None,
    };
    parse_iso_boxes(bytes, 0, bytes.len(), 0, &mut report);
    report
}

fn parse_iso_boxes(
    all: &[u8],
    start: usize,
    end: usize,
    depth: usize,
    report: &mut MediaBoxReport,
) {
    if depth > MAX_ISO_BOX_DEPTH {
        return;
    }
    let mut cursor = start;
    while cursor + 8 <= end && report.iso_boxes.len() < MAX_ISO_BOX_COUNT {
        let size32 = u32::from_be_bytes([
            all[cursor],
            all[cursor + 1],
            all[cursor + 2],
            all[cursor + 3],
        ]) as u64;
        let fourcc_bytes = &all[cursor + 4..cursor + 8];
        if !fourcc_bytes
            .iter()
            .all(|&b| b.is_ascii_graphic() || b == b' ')
        {
            break;
        }
        let fourcc = String::from_utf8_lossy(fourcc_bytes).into_owned();

        let (box_size, header_len) = if size32 == 1 {
            if cursor + 16 > end {
                break;
            }
            let sz64 = u64::from_be_bytes([
                all[cursor + 8],
                all[cursor + 9],
                all[cursor + 10],
                all[cursor + 11],
                all[cursor + 12],
                all[cursor + 13],
                all[cursor + 14],
                all[cursor + 15],
            ]);
            (sz64, 16usize)
        } else if size32 == 0 {
            ((end - cursor) as u64, 8usize)
        } else {
            (size32, 8usize)
        };

        if box_size < header_len as u64 {
            break;
        }
        let Some(box_end_u64) = (cursor as u64).checked_add(box_size) else {
            break;
        };
        let box_end = (box_end_u64 as usize).min(end);
        let payload_start = cursor + header_len;

        report.iso_boxes.push(IsoBmffBoxInfo {
            box_type: fourcc.clone(),
            offset: cursor as u64,
            size: box_size,
            depth,
        });

        match fourcc.as_str() {
            "ftyp" | "styp" => {
                if payload_start + 8 <= box_end {
                    let major =
                        String::from_utf8_lossy(&all[payload_start..payload_start + 4]).into_owned();
                    if report.major_brand.is_none() {
                        report.major_brand = Some(major);
                    }
                    let mut bpos = payload_start + 8;
                    while bpos + 4 <= box_end {
                        let brand = String::from_utf8_lossy(&all[bpos..bpos + 4]).into_owned();
                        if !report.compatible_brands.contains(&brand) {
                            report.compatible_brands.push(brand);
                        }
                        bpos += 4;
                    }
                }
            }
            "moof" | "mvex" | "sidx" => {
                report.is_fragmented_fmp4 = true;
            }
            "pssh" => {
                // FullBox: version(1) + flags(3) + SystemID(16)
                report.has_pssh = true;
                report.drm_detected = true;
                let (uuid_opt, name_opt) = if payload_start + 20 <= box_end {
                    let sys = &all[payload_start + 4..payload_start + 20];
                    let uuid = format_uuid_bytes(sys);
                    let name = known_drm_system_name(&uuid).map(str::to_string);
                    (Some(uuid), name)
                } else {
                    (None, None)
                };
                report.drm_boxes.push(DrmBoxMetadata {
                    box_type: "pssh".to_string(),
                    system_id_uuid: uuid_opt,
                    system_name: name_opt,
                    offset: cursor as u64,
                });
            }
            "encv" | "enca" | "sinf" | "schm" => {
                report.drm_detected = true;
                report.drm_boxes.push(DrmBoxMetadata {
                    box_type: fourcc.clone(),
                    system_id_uuid: None,
                    system_name: Some("ISO-BMFF encrypted sample / protection scheme".to_string()),
                    offset: cursor as u64,
                });
            }
            _ => {}
        }

        // Recurse into standard container boxes (skipping 8-byte FullBox header for `stsd` if needed).
        let container_child_start = match fourcc.as_str() {
            "moov" | "trak" | "mdia" | "minf" | "stbl" | "moof" | "traf" | "mvex" | "edts"
            | "udta" | "sinf" | "schi" => Some(payload_start),
            "stsd" if payload_start + 8 <= box_end => Some(payload_start + 8),
            _ => None,
        };
        if let Some(child_start) = container_child_start {
            parse_iso_boxes(all, child_start, box_end, depth + 1, report);
        }

        if box_end <= cursor {
            break;
        }
        cursor = box_end;
    }
}

fn format_uuid_bytes(b: &[u8]) -> String {
    let h = hex_encode(b);
    format!(
        "{}-{}-{}-{}-{}",
        &h[0..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..32]
    )
}

fn known_drm_system_name(uuid: &str) -> Option<&'static str> {
    match uuid {
        "edef8ba9-79d6-4ace-a3c8-27dcd51d21ed" => Some("Widevine"),
        "9a04f079-9840-4286-ab92-e65be0885f95" => Some("PlayReady"),
        "94ce86fb-07ff-4f43-adb8-93d2fa968ca2" => Some("FairPlay"),
        "1077efec-c0b2-4d02-ace3-3c1e52e2fb4b" => Some("CommonEncryption(W3C)"),
        _ => None,
    }
}

fn inspect_mpeg_ts(bytes: &[u8]) -> Option<MpegTsInfo> {
    for &stride in &[188usize, 192usize] {
        let offset = if stride == 192 { 4 } else { 0 };
        if bytes.len() < stride {
            continue;
        }
        if bytes[offset] != 0x47 {
            continue;
        }
        // Require at least 2 sync bytes when buffer is large enough.
        if bytes.len() >= stride * 2 && bytes[stride + offset] != 0x47 {
            continue;
        }
        let mut pids = Vec::new();
        let mut has_pat = false;
        let mut scrambled_packets = 0usize;
        let mut packets = 0usize;
        let mut pos = offset;
        while pos + 4 <= bytes.len() && packets < 2_048 {
            if bytes[pos] != 0x47 {
                break;
            }
            let pid = ((u16::from(bytes[pos + 1]) & 0x1F) << 8) | u16::from(bytes[pos + 2]);
            let tsc = (bytes[pos + 3] >> 6) & 0x03;
            if pid == 0x0000 {
                has_pat = true;
            }
            if !pids.contains(&pid) {
                pids.push(pid);
            }
            if tsc != 0 {
                scrambled_packets += 1;
            }
            packets += 1;
            pos += stride;
        }
        if packets >= 1 {
            pids.sort_unstable();
            return Some(MpegTsInfo {
                packet_size: stride,
                packets_inspected: packets,
                distinct_pids: pids,
                has_pat,
                scrambled_packets,
            });
        }
    }
    None
}

const ADTS_SAMPLE_RATES: [u32; 13] = [
    96_000, 88_200, 64_000, 48_000, 44_100, 32_000, 24_000, 22_050, 16_000, 12_000, 11_025, 8_000,
    7_350,
];

fn inspect_adts(bytes: &[u8]) -> Option<AdtsInfo> {
    if bytes.len() < 7 {
        return None;
    }
    if bytes[0] != 0xFF || (bytes[1] & 0xF6) != 0xF0 {
        return None;
    }
    let mpeg_version = if (bytes[1] & 0x08) == 0 {
        "MPEG-4"
    } else {
        "MPEG-2"
    };
    let profile_idx = (bytes[2] >> 6) & 0x03;
    let profile = match profile_idx {
        0 => "AAC-Main",
        1 => "AAC-LC",
        2 => "AAC-SSR",
        _ => "AAC-LTP",
    };
    let sr_idx = ((bytes[2] >> 2) & 0x0F) as usize;
    let sample_rate_hz = *ADTS_SAMPLE_RATES.get(sr_idx)?;
    let channels = ((bytes[2] & 0x01) << 2) | ((bytes[3] >> 6) & 0x03);

    let mut frames = 0usize;
    let mut pos = 0usize;
    while pos + 7 <= bytes.len() && frames < 1_024 {
        if bytes[pos] != 0xFF || (bytes[pos + 1] & 0xF6) != 0xF0 {
            break;
        }
        let frame_len = ((usize::from(bytes[pos + 3] & 0x03)) << 11)
            | (usize::from(bytes[pos + 4]) << 3)
            | (usize::from(bytes[pos + 5]) >> 5);
        if frame_len < 7 || pos + frame_len > bytes.len() {
            break;
        }
        frames += 1;
        pos += frame_len;
    }
    if frames == 0 {
        return None;
    }

    Some(AdtsInfo {
        mpeg_version: mpeg_version.to_string(),
        profile: profile.to_string(),
        sample_rate_hz,
        channels,
        frames_inspected: frames,
    })
}

fn inspect_ebml_webm(bytes: &[u8]) -> MediaBoxReport {
    let mut doc_type = None;
    // Locate EBML DocType element ID `0x42 0x82` inside header prefix (first 128 bytes).
    let hdr_scan_end = bytes.len().min(128);
    let mut i = 4usize;
    while i + 3 < hdr_scan_end {
        if bytes[i] == 0x42 && bytes[i + 1] == 0x82 {
            let size_byte = bytes[i + 2];
            if (size_byte & 0x80) != 0 {
                let len = (size_byte & 0x7F) as usize;
                let s_start = i + 3;
                let s_end = (s_start + len).min(bytes.len());
                let raw = String::from_utf8_lossy(&bytes[s_start..s_end])
                    .trim_end_matches('\0')
                    .to_string();
                if !raw.is_empty() {
                    doc_type = Some(raw);
                    break;
                }
            }
        }
        i += 1;
    }

    // Scan read-only for Matroska ContentEncodings (`0x6D 0x80`) + ContentEncryption (`0x50 0x35`).
    let has_content_encryption = bytes.windows(2).any(|w| w == [0x6D, 0x80])
        && bytes.windows(2).any(|w| w == [0x50, 0x35]);

    let drm_boxes = if has_content_encryption {
        vec![DrmBoxMetadata {
            box_type: "ebml:ContentEncryption".to_string(),
            system_id_uuid: None,
            system_name: Some("WebM/Matroska ContentEncryption".to_string()),
            offset: 0,
        }]
    } else {
        Vec::new()
    };

    MediaBoxReport {
        format: ContainerFormat::WebmMatroska,
        bytes_inspected: bytes.len(),
        major_brand: doc_type.clone(),
        compatible_brands: Vec::new(),
        is_fragmented_fmp4: false,
        has_pssh: false,
        drm_detected: has_content_encryption,
        drm_supported: DRM_SUPPORTED,
        drm_boxes,
        iso_boxes: Vec::new(),
        mpeg_ts: None,
        adts: None,
        webm: Some(WebmInfo {
            doc_type,
            has_content_encryption,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_box(fourcc: &[u8; 4], payload: &[u8]) -> Vec<u8> {
        let len = (8 + payload.len()) as u32;
        let mut out = Vec::with_capacity(len as usize);
        out.extend_from_slice(&len.to_be_bytes());
        out.extend_from_slice(fourcc);
        out.extend_from_slice(payload);
        out
    }

    #[test]
    fn inspects_mp4_with_read_only_pssh_widevine_flag_and_enforces_drm_unsupported() {
        let mut ftyp_payload = Vec::new();
        ftyp_payload.extend_from_slice(b"isom");
        ftyp_payload.extend_from_slice(&0u32.to_be_bytes());
        ftyp_payload.extend_from_slice(b"isomiso6mp41");

        // Widevine PSSH FullBox: version(0) + flags(0,0,0) + Widevine SystemID
        let mut pssh_payload = vec![0, 0, 0, 0];
        let widevine_id: [u8; 16] = [
            0xed, 0xef, 0x8b, 0xa9, 0x79, 0xd6, 0x4a, 0xce, 0xa3, 0xc8, 0x27, 0xdc, 0xd5, 0x1d,
            0x21, 0xed,
        ];
        pssh_payload.extend_from_slice(&widevine_id);
        pssh_payload.extend_from_slice(&0u32.to_be_bytes()); // data size 0

        let pssh = make_box(b"pssh", &pssh_payload);
        let moov = make_box(b"moov", &pssh);

        let mut mp4 = Vec::new();
        mp4.extend_from_slice(&make_box(b"ftyp", &ftyp_payload));
        mp4.extend_from_slice(&moov);

        let report = inspect_media_bytes(&mp4);
        assert_eq!(report.format, ContainerFormat::IsoBmffMp4);
        assert_eq!(report.major_brand.as_deref(), Some("isom"));
        assert!(report.has_pssh);
        assert!(report.drm_detected);
        assert!(!report.drm_supported);
        assert_eq!(
            report.drm_boxes[0].system_id_uuid.as_deref(),
            Some("edef8ba9-79d6-4ace-a3c8-27dcd51d21ed")
        );
        assert_eq!(report.drm_boxes[0].system_name.as_deref(), Some("Widevine"));
        assert!(matches!(
            report.enforce_no_drm(),
            Err(DownloaderError::DrmUnsupported { .. })
        ));
    }

    #[test]
    fn inspects_mpeg_ts_adts_and_webm_ebml() {
        // MPEG-TS: 2 packets x 188 bytes with PAT PID 0x0000
        let mut ts = vec![0u8; 376];
        ts[0] = 0x47;
        ts[1] = 0x40;
        ts[2] = 0x00;
        ts[3] = 0x10;
        ts[188] = 0x47;
        ts[189] = 0x01;
        ts[190] = 0x00;
        ts[191] = 0x10;
        let ts_rep = inspect_media_bytes(&ts);
        assert_eq!(ts_rep.format, ContainerFormat::MpegTs);
        assert!(ts_rep.mpeg_ts.as_ref().unwrap().has_pat);
        assert_eq!(ts_rep.mpeg_ts.as_ref().unwrap().packets_inspected, 2);
        assert!(!ts_rep.drm_detected);

        // ADTS AAC-LC 48kHz stereo frame (length = 7 bytes)
        let adts_frame: [u8; 7] = [0xFF, 0xF1, 0x4C, 0x80, 0x00, 0xE0, 0xFC];
        let adts_rep = inspect_media_bytes(&adts_frame);
        assert_eq!(adts_rep.format, ContainerFormat::AdtsAac);
        let adts_info = adts_rep.adts.unwrap();
        assert_eq!(adts_info.profile, "AAC-LC");
        assert_eq!(adts_info.sample_rate_hz, 48_000);
        assert_eq!(adts_info.channels, 2);

        // WebM EBML header with DocType = "webm"
        let webm: Vec<u8> = vec![
            0x1A, 0x45, 0xDF, 0xA3, 0x9F, 0x42, 0x82, 0x84, b'w', b'e', b'b', b'm',
        ];
        let webm_rep = inspect_media_bytes(&webm);
        assert_eq!(webm_rep.format, ContainerFormat::WebmMatroska);
        assert_eq!(
            webm_rep.webm.unwrap().doc_type.as_deref(),
            Some("webm")
        );
        assert!(!webm_rep.drm_detected);
    }
}
