//! Pure-Rust Zip-Bomb-Guarded Office (`.docx`/`.xlsx`/`.pptx`) & Jupyter Notebook (`.ipynb`) Reader.
//!
//! Uses only already-locked workspace dependencies (`flate2` + `serde_json`) with zero external
//! binaries, zero new Cargo dependencies, and a strict 50 MiB uncompressed extraction ceiling
//! enforced both on Central Directory metadata AND streaming during `DeflateDecoder` reads.

use anyhow::{bail, Context, Result};
use flate2::read::DeflateDecoder;
use serde_json::Value;
use std::collections::BTreeMap;
use std::io::Read;
use std::path::Path;

/// Strict 50 MiB hard ceiling on total uncompressed bytes extracted from any Office archive.
pub const OFFICE_MAX_UNCOMPRESSED_BYTES: usize = 50 * 1024 * 1024;
/// Maximum number of ZIP Central Directory entries admitted per document archive.
const MAX_ZIP_ENTRIES: usize = 4_096;

/// Returns `true` when `path` has a supported Office or Jupyter Notebook extension.
#[must_use]
pub fn is_supported_document_extension(path: &Path) -> bool {
    let Some(ext) = path.extension().and_then(|e| e.to_str()) else {
        return false;
    };
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "docx" | "xlsx" | "pptx" | "ipynb"
    )
}

/// Extracts readable UTF-8 text from `.docx`, `.xlsx`, `.pptx`, or `.ipynb` files enforcing
/// the default 50 MiB zip-bomb uncompressed cap. Returns `Ok(None)` for other extensions.
pub fn extract_document_text(path: &Path, raw_bytes: &[u8]) -> Result<Option<String>> {
    extract_document_text_with_limit(path, raw_bytes, OFFICE_MAX_UNCOMPRESSED_BYTES)
}

/// Same as [`extract_document_text`] with an explicit uncompressed-byte ceiling (used in tests).
pub fn extract_document_text_with_limit(
    path: &Path,
    raw_bytes: &[u8],
    max_uncompressed_bytes: usize,
) -> Result<Option<String>> {
    let Some(ext) = path.extension().and_then(|e| e.to_str()) else {
        return Ok(None);
    };
    match ext.to_ascii_lowercase().as_str() {
        "ipynb" => {
            if raw_bytes.len() > max_uncompressed_bytes {
                bail!(
                    "notebook exceeds {} byte safety cap ({} bytes)",
                    max_uncompressed_bytes,
                    raw_bytes.len()
                );
            }
            extract_ipynb_text(raw_bytes).map(Some)
        }
        "docx" => extract_docx_text(raw_bytes, max_uncompressed_bytes).map(Some),
        "xlsx" => extract_xlsx_text(raw_bytes, max_uncompressed_bytes).map(Some),
        "pptx" => extract_pptx_text(raw_bytes, max_uncompressed_bytes).map(Some),
        _ => Ok(None),
    }
}

// ============================================================================
// Minimal Pure-Rust Zip-Bomb-Guarded ZIP Reader (Stored + Deflate via flate2)
// ============================================================================

fn read_u16_le(buf: &[u8], off: usize) -> Result<u16> {
    let slice = buf
        .get(off..off + 2)
        .context("unexpected EOF reading ZIP u16")?;
    Ok(u16::from_le_bytes([slice[0], slice[1]]))
}

fn read_u32_le(buf: &[u8], off: usize) -> Result<u32> {
    let slice = buf
        .get(off..off + 4)
        .context("unexpected EOF reading ZIP u32")?;
    Ok(u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

/// Unpacks entries matching `want_entry(name)` from an OOXML ZIP archive while enforcing
/// `max_total_bytes` on BOTH declared sizes and actual inflated output (stopping zip bombs
/// before memory exhaustion).
pub fn extract_zip_entries_bounded<F>(
    bytes: &[u8],
    max_total_bytes: usize,
    mut want_entry: F,
) -> Result<BTreeMap<String, Vec<u8>>>
where
    F: FnMut(&str) -> bool,
{
    const EOCD_SIG: u32 = 0x0605_4b50;
    const CD_SIG: u32 = 0x0201_4b50;
    const LFH_SIG: u32 = 0x0403_4b50;

    if bytes.len() < 22 {
        bail!("invalid OOXML/ZIP archive: truncated (< 22 bytes)");
    }

    let search_start = bytes.len().saturating_sub(22 + 65_535);
    let mut eocd_off = None;
    for pos in (search_start..=bytes.len() - 22).rev() {
        if read_u32_le(bytes, pos)? == EOCD_SIG {
            let comment_len = read_u16_le(bytes, pos + 20)? as usize;
            if pos + 22 + comment_len == bytes.len() {
                eocd_off = Some(pos);
                break;
            }
        }
    }
    let eocd = eocd_off.context("invalid OOXML/ZIP archive: End-of-Central-Directory not found")?;

    let entry_count = read_u16_le(bytes, eocd + 10)? as usize;
    let cd_size = read_u32_le(bytes, eocd + 12)? as usize;
    let cd_offset = read_u32_le(bytes, eocd + 16)? as usize;

    if entry_count == 0xFFFF || cd_size == 0xFFFF_FFFF || cd_offset == 0xFFFF_FFFF {
        bail!("ZIP64 Office archive rejected by bounded reader");
    }
    if entry_count > MAX_ZIP_ENTRIES {
        bail!("OOXML archive exceeds maximum entry count ({MAX_ZIP_ENTRIES})");
    }
    let cd_end = cd_offset
        .checked_add(cd_size)
        .filter(|&end| end <= bytes.len())
        .context("corrupt OOXML Central Directory bounds")?;

    let mut out = BTreeMap::new();
    let mut total_uncompressed = 0usize;
    let mut cursor = cd_offset;

    for _ in 0..entry_count {
        if cursor + 46 > cd_end || read_u32_le(bytes, cursor)? != CD_SIG {
            bail!("corrupt OOXML Central Directory entry header");
        }
        let flags = read_u16_le(bytes, cursor + 8)?;
        let method = read_u16_le(bytes, cursor + 10)?;
        let comp_size = read_u32_le(bytes, cursor + 20)? as usize;
        let uncomp_size = read_u32_le(bytes, cursor + 24)? as usize;
        let name_len = read_u16_le(bytes, cursor + 28)? as usize;
        let extra_len = read_u16_le(bytes, cursor + 30)? as usize;
        let comment_len = read_u16_le(bytes, cursor + 32)? as usize;
        let lfh_offset = read_u32_le(bytes, cursor + 42)? as usize;

        let name_start = cursor + 46;
        let name_end = name_start + name_len;
        if name_end > cd_end {
            bail!("corrupt OOXML Central Directory entry filename bounds");
        }
        let name = String::from_utf8_lossy(&bytes[name_start..name_end]).into_owned();
        cursor = name_end + extra_len + comment_len;

        if name.ends_with('/') {
            continue;
        }
        if (flags & 0x0001) != 0 {
            bail!("encrypted Office archive entry `{name}` cannot be read");
        }

        // Pre-check declared uncompressed size across ALL entries to reject obvious zip bombs early.
        if uncomp_size > max_total_bytes
            || total_uncompressed.saturating_add(uncomp_size) > max_total_bytes
        {
            bail!(
                "zip-bomb guard triggered: archive uncompressed size exceeds {} MiB limit (entry `{name}`)",
                max_total_bytes / (1024 * 1024)
            );
        }

        if !want_entry(&name) {
            continue;
        }

        if lfh_offset + 30 > bytes.len() || read_u32_le(bytes, lfh_offset)? != LFH_SIG {
            bail!("corrupt OOXML local file header for `{name}`");
        }
        let lfh_name_len = read_u16_le(bytes, lfh_offset + 26)? as usize;
        let lfh_extra_len = read_u16_le(bytes, lfh_offset + 28)? as usize;
        let data_start = lfh_offset + 30 + lfh_name_len + lfh_extra_len;
        let data_end = data_start
            .checked_add(comp_size)
            .filter(|&end| end <= bytes.len())
            .with_context(|| format!("corrupt compressed payload bounds for `{name}`"))?;
        let payload = &bytes[data_start..data_end];

        let remaining = max_total_bytes.saturating_sub(total_uncompressed);
        let decoded = match method {
            0 => {
                if payload.len() > remaining {
                    bail!(
                        "zip-bomb guard triggered: stored entry `{name}` exceeds {} byte budget",
                        max_total_bytes
                    );
                }
                payload.to_vec()
            }
            8 => {
                let mut decoder = DeflateDecoder::new(payload).take((remaining as u64) + 1);
                let mut buf = Vec::with_capacity(uncomp_size.min(remaining).min(1024 * 1024));
                decoder
                    .read_to_end(&mut buf)
                    .with_context(|| format!("deflate decompression failed for `{name}`"))?;
                if buf.len() > remaining {
                    bail!(
                        "zip-bomb guard triggered: inflated stream for `{name}` exceeded {} byte limit",
                        max_total_bytes
                    );
                }
                buf
            }
            other => bail!("unsupported ZIP compression method {other} for `{name}`"),
        };

        total_uncompressed = total_uncompressed.saturating_add(decoded.len());
        if total_uncompressed > max_total_bytes {
            bail!(
                "zip-bomb guard triggered: cumulative inflated bytes exceeded {max_total_bytes}"
            );
        }
        out.insert(name, decoded);
    }

    Ok(out)
}

// ============================================================================
// Pure-Rust Lightweight Streaming XML Tokenizer & Entity Decoder
// ============================================================================

#[derive(Debug)]
enum XmlEvent<'a> {
    Start {
        local_name: &'a str,
        attrs_raw: &'a str,
        self_closing: bool,
    },
    End {
        local_name: &'a str,
    },
    Text(String),
}

fn strip_xml_ns(tag: &str) -> &str {
    tag.rsplit_once(':').map_or(tag, |(_, local)| local)
}

fn unescape_xml(raw: &str) -> String {
    if !raw.contains('&') {
        return raw.to_owned();
    }
    let mut out = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        let after = &rest[amp + 1..];
        if let Some(semi) = after.find(';') {
            let entity = &after[..semi];
            let decoded = match entity {
                "amp" => Some('&'),
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('"'),
                "apos" => Some('\''),
                _ if entity.starts_with("#x") || entity.starts_with("#X") => {
                    u32::from_str_radix(&entity[2..], 16)
                        .ok()
                        .and_then(char::from_u32)
                }
                _ if entity.starts_with('#') => {
                    entity[1..].parse::<u32>().ok().and_then(char::from_u32)
                }
                _ => None,
            };
            if let Some(ch) = decoded {
                out.push(ch);
                rest = &after[semi + 1..];
                continue;
            }
        }
        out.push('&');
        rest = after;
    }
    out.push_str(rest);
    out
}

fn extract_xml_attr(attrs_raw: &str, attr_local: &str) -> Option<String> {
    let bytes = attrs_raw.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        let name_start = i;
        while i < bytes.len() && bytes[i] != b'=' && !bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        let name = attrs_raw.get(name_start..i)?.trim();
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= bytes.len() || bytes[i] != b'=' {
            continue;
        }
        i += 1;
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= bytes.len() || (bytes[i] != b'"' && bytes[i] != b'\'') {
            continue;
        }
        let quote = bytes[i];
        i += 1;
        let val_start = i;
        while i < bytes.len() && bytes[i] != quote {
            i += 1;
        }
        let val = attrs_raw.get(val_start..i)?;
        if i < bytes.len() {
            i += 1;
        }
        if strip_xml_ns(name) == attr_local {
            return Some(unescape_xml(val));
        }
    }
    None
}

fn scan_xml<'a>(xml: &'a str, mut on_event: impl FnMut(XmlEvent<'a>)) {
    let mut pos = 0usize;
    let len = xml.len();
    while pos < len {
        let rem = &xml[pos..];
        let Some(lt) = rem.find('<') else {
            if !rem.is_empty() {
                on_event(XmlEvent::Text(unescape_xml(rem)));
            }
            break;
        };
        if lt > 0 {
            on_event(XmlEvent::Text(unescape_xml(&rem[..lt])));
        }
        let tag_start = pos + lt;
        let after_lt = &xml[tag_start + 1..];

        if after_lt.starts_with("!--") {
            if let Some(end_c) = after_lt.find("-->") {
                pos = tag_start + 1 + end_c + 3;
                continue;
            }
            break;
        }
        if let Some(body) = after_lt.strip_prefix("![CDATA[") {
            if let Some(end_c) = body.find("]]>") {
                on_event(XmlEvent::Text(body[..end_c].to_owned()));
                pos = tag_start + 1 + 8 + end_c + 3;
                continue;
            }
            break;
        }
        if after_lt.starts_with('?') {
            if let Some(end_p) = after_lt.find("?>") {
                pos = tag_start + 1 + end_p + 2;
                continue;
            }
            break;
        }
        let Some(gt) = after_lt.find('>') else {
            break;
        };
        let inside = after_lt[..gt].trim();
        pos = tag_start + 1 + gt + 1;

        if inside.is_empty() || inside.starts_with('!') {
            continue;
        }
        if let Some(close_name) = inside.strip_prefix('/') {
            let name = close_name.split_whitespace().next().unwrap_or("");
            on_event(XmlEvent::End {
                local_name: strip_xml_ns(name),
            });
            continue;
        }
        let (body, self_closing) = match inside.strip_suffix('/') {
            Some(b) => (b.trim_end(), true),
            None => (inside, false),
        };
        let mut split_idx = body.len();
        for (idx, ch) in body.char_indices() {
            if ch.is_whitespace() {
                split_idx = idx;
                break;
            }
        }
        let tag_name = &body[..split_idx];
        let attrs_raw = body[split_idx..].trim();
        on_event(XmlEvent::Start {
            local_name: strip_xml_ns(tag_name),
            attrs_raw,
            self_closing,
        });
    }
}

// ============================================================================
// Format Extractors: DOCX, XLSX, PPTX, IPYNB
// ============================================================================

fn extract_docx_text(raw_bytes: &[u8], max_bytes: usize) -> Result<String> {
    let entries = extract_zip_entries_bounded(raw_bytes, max_bytes, |name| {
        name == "word/document.xml"
            || name == "word/footnotes.xml"
            || (name.starts_with("word/header") && name.ends_with(".xml"))
    })?;
    let doc_bytes = entries
        .get("word/document.xml")
        .context("invalid .docx: missing `word/document.xml`")?;
    let xml = String::from_utf8_lossy(doc_bytes);

    let mut out = String::new();
    let mut in_text = false;
    let mut in_cell = false;
    let mut cell_index = 0usize;

    scan_xml(&xml, |ev| match ev {
        XmlEvent::Start {
            local_name,
            self_closing,
            ..
        } => match local_name {
            "t" if !self_closing => in_text = true,
            "tab" => out.push('\t'),
            "br" | "cr" => out.push('\n'),
            "tr" => {
                cell_index = 0;
            }
            "tc" => {
                if cell_index > 0 {
                    out.push_str(" | ");
                }
                in_cell = true;
                cell_index += 1;
            }
            _ => {}
        },
        XmlEvent::End { local_name } => match local_name {
            "t" => in_text = false,
            "tc" => in_cell = false,
            "p" => {
                if !in_cell && !out.ends_with('\n') {
                    out.push('\n');
                }
            }
            "tr" if !out.ends_with('\n') => {
                out.push('\n');
            }
            _ => {}
        },
        XmlEvent::Text(txt) => {
            if in_text {
                out.push_str(&txt);
            }
        }
    });

    Ok(format!("[extracted .docx text]\n{}", out.trim()))
}

fn parse_xlsx_shared_strings(xml: &str) -> Vec<String> {
    let mut strings = Vec::new();
    let mut in_si = false;
    let mut in_t = false;
    let mut buf = String::new();
    scan_xml(xml, |ev| match ev {
        XmlEvent::Start {
            local_name,
            self_closing,
            ..
        } => match local_name {
            "si" if !self_closing => {
                in_si = true;
                buf.clear();
            }
            "t" if in_si && !self_closing => in_t = true,
            _ => {}
        },
        XmlEvent::End { local_name } => match local_name {
            "t" => in_t = false,
            "si" if in_si => {
                in_si = false;
                strings.push(std::mem::take(&mut buf));
            }
            _ => {}
        },
        XmlEvent::Text(txt) if in_si && in_t => buf.push_str(&txt),
        _ => {}
    });
    strings
}

fn parse_xlsx_sheet_names(xml: &str) -> Vec<String> {
    let mut names = Vec::new();
    scan_xml(xml, |ev| {
        if let XmlEvent::Start {
            local_name: "sheet",
            attrs_raw,
            ..
        } = ev
        {
            if let Some(name) = extract_xml_attr(attrs_raw, "name") {
                names.push(name);
            }
        }
    });
    names
}

fn trailing_digits_key(path: &str) -> (usize, String) {
    let stem = path.rsplit('/').next().unwrap_or(path);
    let digits: String = stem.chars().filter(|c| c.is_ascii_digit()).collect();
    let num = digits.parse::<usize>().unwrap_or(usize::MAX);
    (num, path.to_owned())
}

fn extract_xlsx_text(raw_bytes: &[u8], max_bytes: usize) -> Result<String> {
    let entries = extract_zip_entries_bounded(raw_bytes, max_bytes, |name| {
        name == "xl/sharedStrings.xml"
            || name == "xl/workbook.xml"
            || (name.starts_with("xl/worksheets/sheet") && name.ends_with(".xml"))
    })?;

    let shared = entries
        .get("xl/sharedStrings.xml")
        .map(|b| parse_xlsx_shared_strings(&String::from_utf8_lossy(b)))
        .unwrap_or_default();
    let sheet_names = entries
        .get("xl/workbook.xml")
        .map(|b| parse_xlsx_sheet_names(&String::from_utf8_lossy(b)))
        .unwrap_or_default();

    let mut sheets: Vec<(&String, &Vec<u8>)> = entries
        .iter()
        .filter(|(k, _)| k.starts_with("xl/worksheets/sheet") && k.ends_with(".xml"))
        .collect();
    sheets.sort_by_key(|(k, _)| trailing_digits_key(k));
    if sheets.is_empty() {
        bail!("invalid .xlsx: no worksheet XML files found");
    }

    let mut out = String::from("[extracted .xlsx workbook]\n");
    for (idx, (path, xml_bytes)) in sheets.into_iter().enumerate() {
        let title = sheet_names
            .get(idx)
            .cloned()
            .unwrap_or_else(|| path.rsplit('/').next().unwrap_or(path).to_owned());
        out.push_str(&format!("\n## Sheet {}: {title}\n", idx + 1));

        let xml = String::from_utf8_lossy(xml_bytes);
        let mut row_cells: Vec<String> = Vec::new();
        let mut cell_type = String::new();
        let mut cell_buf = String::new();
        let mut in_v = false;
        let mut in_t = false;

        scan_xml(&xml, |ev| match ev {
            XmlEvent::Start {
                local_name,
                attrs_raw,
                self_closing,
            } => match local_name {
                "row" => row_cells.clear(),
                "c" => {
                    cell_type = extract_xml_attr(attrs_raw, "t").unwrap_or_default();
                    cell_buf.clear();
                }
                "v" if !self_closing => in_v = true,
                "t" if !self_closing => in_t = true,
                _ => {}
            },
            XmlEvent::End { local_name } => match local_name {
                "v" => in_v = false,
                "t" => in_t = false,
                "c" => {
                    let val = if cell_type == "s" {
                        cell_buf
                            .trim()
                            .parse::<usize>()
                            .ok()
                            .and_then(|i| shared.get(i).cloned())
                            .unwrap_or_else(|| cell_buf.trim().to_owned())
                    } else {
                        cell_buf.trim().to_owned()
                    };
                    row_cells.push(val);
                    cell_buf.clear();
                }
                "row" => {
                    if row_cells.iter().any(|c| !c.is_empty()) {
                        out.push_str(&row_cells.join("\t"));
                        out.push('\n');
                    }
                    row_cells.clear();
                }
                _ => {}
            },
            XmlEvent::Text(txt) if in_v || in_t => cell_buf.push_str(&txt),
            _ => {}
        });
    }

    Ok(out.trim_end().to_owned())
}

fn extract_pptx_text(raw_bytes: &[u8], max_bytes: usize) -> Result<String> {
    let entries = extract_zip_entries_bounded(raw_bytes, max_bytes, |name| {
        name.starts_with("ppt/slides/slide") && name.ends_with(".xml")
    })?;
    let mut slides: Vec<(&String, &Vec<u8>)> = entries.iter().collect();
    slides.sort_by_key(|(k, _)| trailing_digits_key(k));
    if slides.is_empty() {
        bail!("invalid .pptx: no slide XML files found");
    }

    let mut out = String::from("[extracted .pptx presentation]\n");
    for (idx, (_, xml_bytes)) in slides.into_iter().enumerate() {
        out.push_str(&format!("\n## Slide {}\n", idx + 1));
        let xml = String::from_utf8_lossy(xml_bytes);
        let mut in_t = false;
        let mut para = String::new();
        scan_xml(&xml, |ev| match ev {
            XmlEvent::Start {
                local_name,
                self_closing,
                ..
            } => match local_name {
                "t" if !self_closing => in_t = true,
                "br" => para.push('\n'),
                _ => {}
            },
            XmlEvent::End { local_name } => match local_name {
                "t" => in_t = false,
                "p" => {
                    let trimmed = para.trim();
                    if !trimmed.is_empty() {
                        out.push_str(trimmed);
                        out.push('\n');
                    }
                    para.clear();
                }
                _ => {}
            },
            XmlEvent::Text(txt) if in_t => para.push_str(&txt),
            _ => {}
        });
    }

    Ok(out.trim_end().to_owned())
}

fn join_ipynb_lines(val: Option<&Value>) -> String {
    match val {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(arr)) => arr
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    }
}

fn extract_ipynb_text(raw_bytes: &[u8]) -> Result<String> {
    let doc: Value = serde_json::from_slice(raw_bytes).context("parse .ipynb JSON")?;
    let cells = doc
        .get("cells")
        .and_then(Value::as_array)
        .context("invalid .ipynb: missing `cells` array")?;
    let lang = doc
        .pointer("/metadata/kernelspec/language")
        .or_else(|| doc.pointer("/metadata/language_info/name"))
        .and_then(Value::as_str)
        .unwrap_or("python");

    let mut out = format!(
        "[extracted .ipynb notebook | language={lang} | cells={}]\n",
        cells.len()
    );
    for (idx, cell) in cells.iter().enumerate() {
        let cell_type = cell
            .get("cell_type")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let source = join_ipynb_lines(cell.get("source"));
        out.push_str(&format!("\n## Cell {} [{cell_type}]\n", idx + 1));
        if cell_type == "code" {
            out.push_str(&format!("```{lang}\n{}\n```\n", source.trim_end()));
        } else {
            out.push_str(source.trim_end());
            out.push('\n');
        }
        if let Some(outputs) = cell.get("outputs").and_then(Value::as_array) {
            for output in outputs.iter().take(4) {
                let text = join_ipynb_lines(output.get("text"))
                    .trim()
                    .to_owned();
                let plain = join_ipynb_lines(output.pointer("/data/text~1plain"))
                    .trim()
                    .to_owned();
                let rendered = if !text.is_empty() { text } else { plain };
                if !rendered.is_empty() {
                    let preview: String = rendered.chars().take(600).collect();
                    out.push_str(&format!("Output:\n{preview}\n"));
                }
            }
        }
    }

    Ok(out.trim_end().to_owned())
}

/// Builds a valid minimal ZIP archive (Stored or Deflate) for deterministic unit/eval tests.
#[cfg(test)]
pub(crate) fn build_test_zip(entries: &[(&str, &[u8], bool)]) -> Vec<u8> {
    use flate2::write::DeflateEncoder;
    use flate2::Compression;
    use std::io::Write;

    let mut archive = Vec::new();
    let mut cd = Vec::new();

    for &(name, data, deflate) in entries {
        let lfh_off = archive.len() as u32;
        let (method, compressed) = if deflate {
            let mut enc = DeflateEncoder::new(Vec::new(), Compression::best());
            enc.write_all(data).unwrap();
            (8u16, enc.finish().unwrap())
        } else {
            (0u16, data.to_vec())
        };
        let name_bytes = name.as_bytes();
        let uncomp_len = data.len() as u32;
        let comp_len = compressed.len() as u32;

        // Local file header
        archive.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        archive.extend_from_slice(&20u16.to_le_bytes()); // version
        archive.extend_from_slice(&0u16.to_le_bytes()); // flags
        archive.extend_from_slice(&method.to_le_bytes());
        archive.extend_from_slice(&0u16.to_le_bytes()); // mod time
        archive.extend_from_slice(&0u16.to_le_bytes()); // mod date
        archive.extend_from_slice(&0u32.to_le_bytes()); // crc32 (unused by reader)
        archive.extend_from_slice(&comp_len.to_le_bytes());
        archive.extend_from_slice(&uncomp_len.to_le_bytes());
        archive.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
        archive.extend_from_slice(&0u16.to_le_bytes()); // extra len
        archive.extend_from_slice(name_bytes);
        archive.extend_from_slice(&compressed);

        // Central directory record
        cd.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
        cd.extend_from_slice(&20u16.to_le_bytes()); // version made by
        cd.extend_from_slice(&20u16.to_le_bytes()); // version needed
        cd.extend_from_slice(&0u16.to_le_bytes()); // flags
        cd.extend_from_slice(&method.to_le_bytes());
        cd.extend_from_slice(&0u16.to_le_bytes());
        cd.extend_from_slice(&0u16.to_le_bytes());
        cd.extend_from_slice(&0u32.to_le_bytes());
        cd.extend_from_slice(&comp_len.to_le_bytes());
        cd.extend_from_slice(&uncomp_len.to_le_bytes());
        cd.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
        cd.extend_from_slice(&0u16.to_le_bytes()); // extra
        cd.extend_from_slice(&0u16.to_le_bytes()); // comment
        cd.extend_from_slice(&0u16.to_le_bytes()); // disk
        cd.extend_from_slice(&0u16.to_le_bytes()); // internal attrs
        cd.extend_from_slice(&0u32.to_le_bytes()); // external attrs
        cd.extend_from_slice(&lfh_off.to_le_bytes());
        cd.extend_from_slice(name_bytes);
    }

    let cd_off = archive.len() as u32;
    let cd_len = cd.len() as u32;
    archive.extend_from_slice(&cd);

    // EOCD
    archive.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    archive.extend_from_slice(&0u16.to_le_bytes());
    archive.extend_from_slice(&0u16.to_le_bytes());
    archive.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    archive.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    archive.extend_from_slice(&cd_len.to_le_bytes());
    archive.extend_from_slice(&cd_off.to_le_bytes());
    archive.extend_from_slice(&0u16.to_le_bytes());
    archive
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_docx_xlsx_pptx_and_ipynb_cleanly() {
        let docx_xml = br#"<?xml version="1.0"?><w:document><w:body><w:p><w:r><w:t>Hello &amp; Welcome</w:t></w:r></w:p><w:p><w:r><w:t>Second line</w:t></w:r></w:p></w:body></w:document>"#;
        let docx = build_test_zip(&[("word/document.xml", docx_xml, true)]);
        let txt = extract_document_text(Path::new("spec.docx"), &docx)
            .unwrap()
            .unwrap();
        assert!(txt.contains("Hello & Welcome"));
        assert!(txt.contains("Second line"));

        let shared = br#"<sst><si><t>Metric</t></si><si><t>Latency</t></si></sst>"#;
        let wb = br#"<workbook><sheets><sheet name="Perf"/></sheets></workbook>"#;
        let sh = br#"<worksheet><sheetData><row><c t="s"><v>0</v></c><c t="s"><v>1</v></c></row><row><c><v>12.5</v></c><c><v>99</v></c></row></sheetData></worksheet>"#;
        let xlsx = build_test_zip(&[
            ("xl/sharedStrings.xml", shared, true),
            ("xl/workbook.xml", wb, true),
            ("xl/worksheets/sheet1.xml", sh, true),
        ]);
        let xtxt = extract_document_text(Path::new("bench.xlsx"), &xlsx)
            .unwrap()
            .unwrap();
        assert!(xtxt.contains("Perf"));
        assert!(xtxt.contains("Metric\tLatency"));
        assert!(xtxt.contains("12.5\t99"));

        let s1 = br#"<p:sld><a:p><a:r><a:t>Omnia Deck</a:t></a:r></a:p></p:sld>"#;
        let pptx = build_test_zip(&[("ppt/slides/slide1.xml", s1, true)]);
        let ptxt = extract_document_text(Path::new("deck.pptx"), &pptx)
            .unwrap()
            .unwrap();
        assert!(ptxt.contains("## Slide 1"));
        assert!(ptxt.contains("Omnia Deck"));

        let nb = br##"{"cells":[{"cell_type":"markdown","source":["# Title"]},{"cell_type":"code","source":["print(42)"],"outputs":[{"text":["42\n"]}]}],"metadata":{"kernelspec":{"language":"python"}}}"##;
        let nb_txt = extract_document_text(Path::new("demo.ipynb"), nb)
            .unwrap()
            .unwrap();
        assert!(nb_txt.contains("## Cell 1 [markdown]"));
        assert!(nb_txt.contains("print(42)"));
        assert!(nb_txt.contains("42"));
    }

    #[test]
    fn zip_bomb_guard_blocks_oversized_deflate_payloads() {
        // Compress 256 KiB of zeros (~300 bytes compressed) and enforce a 64 KiB cap.
        let payload = vec![b'A'; 256 * 1024];
        let mut bomb = build_test_zip(&[("word/document.xml", &payload, true)]);
        assert!(bomb.len() < 4_096);
        let err = extract_document_text_with_limit(Path::new("bomb.docx"), &bomb, 64 * 1024)
            .unwrap_err();
        assert!(err.to_string().contains("zip-bomb guard"));

        // Even if the Central Directory lies about uncompressed_size (spoofing 10 bytes),
        // streaming `.take(remaining + 1)` STILL stops the inflated stream cleanly!
        let cd_pos = bomb
            .windows(4)
            .position(|w| w == 0x0201_4b50u32.to_le_bytes())
            .unwrap();
        bomb[cd_pos + 24..cd_pos + 28].copy_from_slice(&10u32.to_le_bytes());
        let err_spoof = extract_document_text_with_limit(Path::new("spoof.docx"), &bomb, 64 * 1024)
            .unwrap_err();
        assert!(err_spoof.to_string().contains("zip-bomb guard"));
    }
}
