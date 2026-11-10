//! Minimal ZIP reader and text extraction for docx / xlsx / pptx files.

use std::collections::HashMap;
use std::io::Read;

use quick_xml::events::Event;
use quick_xml::Reader;

/// Maximum total decompressed bytes read from one archive (zip-bomb guard).
const MAX_TOTAL_BYTES: u64 = 50 * 1024 * 1024;

struct Entry {
    method: u16,
    compressed: u64,
    size: u64,
    local_offset: u64,
}

pub(crate) struct ZipArchive {
    data: Vec<u8>,
    entries: HashMap<String, Entry>,
    order: Vec<String>,
    total_read: u64,
}

fn u16_at(data: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes(data.get(at..at + 2)?.try_into().ok()?))
}

fn u32_at(data: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(data.get(at..at + 4)?.try_into().ok()?))
}

const BAD: &str = "corrupt or truncated ZIP archive";

impl ZipArchive {
    pub(crate) fn new(data: Vec<u8>) -> Result<Self, String> {
        // End of central directory record: at least 22 bytes, comment <= 65535.
        if data.len() < 22 {
            return Err("not a ZIP archive (too small)".into());
        }
        let last = data.len() - 22;
        let first = last.saturating_sub(65535);
        let eocd = (first..=last)
            .rev()
            .find(|&i| data.get(i..i + 4) == Some(&[0x50, 0x4b, 0x05, 0x06][..]))
            .ok_or("not a ZIP archive (no end-of-central-directory record)")?;
        let count = u16_at(&data, eocd + 10).ok_or(BAD)?;
        let cd_size = u32_at(&data, eocd + 12).ok_or(BAD)?;
        let cd_offset = u32_at(&data, eocd + 16).ok_or(BAD)?;
        if count == 0xFFFF || cd_size == 0xFFFF_FFFF || cd_offset == 0xFFFF_FFFF {
            return Err("ZIP64 archives are not supported".into());
        }
        let mut entries = HashMap::new();
        let mut order = Vec::new();
        let mut pos = cd_offset as usize;
        for _ in 0..count {
            if u32_at(&data, pos) != Some(0x0201_4b50) {
                return Err(BAD.into());
            }
            let flags = u16_at(&data, pos + 8).ok_or(BAD)?;
            let method = u16_at(&data, pos + 10).ok_or(BAD)?;
            let compressed = u32_at(&data, pos + 20).ok_or(BAD)?;
            let size = u32_at(&data, pos + 24).ok_or(BAD)?;
            let name_len = u16_at(&data, pos + 28).ok_or(BAD)? as usize;
            let extra_len = u16_at(&data, pos + 30).ok_or(BAD)? as usize;
            let comment_len = u16_at(&data, pos + 32).ok_or(BAD)? as usize;
            let local_offset = u32_at(&data, pos + 42).ok_or(BAD)?;
            let name_bytes = data.get(pos + 46..pos + 46 + name_len).ok_or(BAD)?;
            let name = String::from_utf8_lossy(name_bytes).into_owned();
            if compressed == 0xFFFF_FFFF || size == 0xFFFF_FFFF || local_offset == 0xFFFF_FFFF {
                return Err("ZIP64 archives are not supported".into());
            }
            if flags & 1 != 0 {
                return Err("encrypted ZIP archives are not supported".into());
            }
            order.push(name.clone());
            entries.insert(
                name,
                Entry {
                    method,
                    compressed: compressed as u64,
                    size: size as u64,
                    local_offset: local_offset as u64,
                },
            );
            pos += 46 + name_len + extra_len + comment_len;
        }
        Ok(Self {
            data,
            entries,
            order,
            total_read: 0,
        })
    }

    pub(crate) fn names(&self) -> &[String] {
        &self.order
    }

    pub(crate) fn contains(&self, name: &str) -> bool {
        self.entries.contains_key(name)
    }

    pub(crate) fn read(&mut self, name: &str) -> Result<Vec<u8>, String> {
        let entry = self
            .entries
            .get(name)
            .ok_or_else(|| format!("`{name}` not found in archive"))?;
        if entry.size > MAX_TOTAL_BYTES
            || self.total_read.saturating_add(entry.size) > MAX_TOTAL_BYTES
        {
            return Err("archive content exceeds the 50 MB decompression limit".into());
        }
        let local = entry.local_offset as usize;
        if u32_at(&self.data, local) != Some(0x0403_4b50) {
            return Err(BAD.into());
        }
        let name_len = u16_at(&self.data, local + 26).ok_or(BAD)? as usize;
        let extra_len = u16_at(&self.data, local + 28).ok_or(BAD)? as usize;
        let start = local + 30 + name_len + extra_len;
        let raw = self
            .data
            .get(start..start + entry.compressed as usize)
            .ok_or(BAD)?;
        let remaining = MAX_TOTAL_BYTES - self.total_read;
        let out = match entry.method {
            0 => raw.to_vec(),
            8 => {
                let mut out = Vec::new();
                flate2::read::DeflateDecoder::new(raw)
                    .take(remaining + 1)
                    .read_to_end(&mut out)
                    .map_err(|error| format!("cannot decompress `{name}`: {error}"))?;
                out
            }
            other => return Err(format!("unsupported ZIP compression method {other}")),
        };
        if out.len() as u64 > remaining {
            return Err("archive content exceeds the 50 MB decompression limit".into());
        }
        self.total_read += out.len() as u64;
        Ok(out)
    }
}

// ------------------------------------------------------------------- XML

enum Xml {
    Start(String, Vec<(String, String)>),
    End(String),
    Text(String),
}

fn local(name: &str) -> String {
    name.rsplit(':').next().unwrap_or("").to_string()
}

fn parse_xml(data: &[u8], mut on: impl FnMut(Xml)) -> Result<(), String> {
    let mut reader = Reader::from_reader(data);
    let attrs = |e: &quick_xml::events::BytesStart<'_>| -> Vec<(String, String)> {
        e.attributes()
            .flatten()
            .map(|a| {
                let value = a
                    .normalized_value(quick_xml::XmlVersion::default())
                    .map(|v| v.into_owned())
                    .unwrap_or_default();
                (local(a.key.as_ref()), value)
            })
            .collect()
    };
    loop {
        match reader
            .read_event()
            .map_err(|e| format!("invalid XML: {e}"))?
        {
            Event::Start(e) => on(Xml::Start(local(e.name().as_ref()), attrs(&e))),
            Event::Empty(e) => {
                let name = local(e.name().as_ref());
                on(Xml::Start(name.clone(), attrs(&e)));
                on(Xml::End(name));
            }
            Event::End(e) => on(Xml::End(local(e.name().as_ref()))),
            Event::Text(t) => on(Xml::Text(t.xml10_content().into_owned())),
            Event::CData(t) => on(Xml::Text(t.to_string())),
            Event::GeneralRef(r) => {
                let name = r.to_string();
                let text = match r.resolve_char_ref() {
                    Ok(Some(c)) => c.to_string(),
                    _ => quick_xml::escape::resolve_predefined_entity(&name)
                        .unwrap_or("")
                        .to_string(),
                };
                on(Xml::Text(text));
            }
            Event::Eof => return Ok(()),
            _ => {}
        }
    }
}

fn attr<'a>(attrs: &'a [(String, String)], key: &str) -> Option<&'a str> {
    attrs
        .iter()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.as_str())
}

// ------------------------------------------------------------------ docx

fn docx_text(xml: &[u8]) -> Result<String, String> {
    let mut lines: Vec<String> = Vec::new();
    let mut line = String::new();
    let mut in_t = false;
    parse_xml(xml, |ev| match ev {
        Xml::Start(name, _) => match name.as_str() {
            "t" => in_t = true,
            "tab" => line.push('\t'),
            "br" | "cr" => line.push('\n'),
            _ => {}
        },
        Xml::End(name) => match name.as_str() {
            "t" => in_t = false,
            "p" => lines.push(std::mem::take(&mut line)),
            _ => {}
        },
        Xml::Text(text) => {
            if in_t {
                line.push_str(&text);
            }
        }
    })?;
    Ok(lines.join("\n"))
}

// ------------------------------------------------------------------ xlsx

fn shared_strings(xml: &[u8]) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_t = false;
    let mut skip = 0usize; // inside phonetic runs
    parse_xml(xml, |ev| match ev {
        Xml::Start(name, _) => match name.as_str() {
            "t" => in_t = true,
            "rPh" => skip += 1,
            _ => {}
        },
        Xml::End(name) => match name.as_str() {
            "t" => in_t = false,
            "rPh" => skip = skip.saturating_sub(1),
            "si" => out.push(std::mem::take(&mut cur)),
            _ => {}
        },
        Xml::Text(text) => {
            if in_t && skip == 0 {
                cur.push_str(&text);
            }
        }
    })?;
    Ok(out)
}

/// 0-based column index from a cell reference such as `AB12`.
fn column_index(reference: &str) -> usize {
    let mut n = 0usize;
    for c in reference.chars().take_while(char::is_ascii_alphabetic) {
        n = n * 26 + (c.to_ascii_uppercase() as usize - 'A' as usize + 1);
    }
    n.saturating_sub(1)
}

fn sheet_rows(xml: &[u8], shared: &[String]) -> Result<Vec<String>, String> {
    let mut rows = Vec::new();
    let mut cells: Vec<(usize, String)> = Vec::new();
    let mut row_num = String::new();
    let (mut col, mut next_col) = (0usize, 0usize);
    let mut kind = String::new();
    let mut value = String::new();
    let mut inline = String::new();
    let (mut in_v, mut in_t, mut in_is) = (false, false, false);
    parse_xml(xml, |ev| match ev {
        Xml::Start(name, attrs) => match name.as_str() {
            "row" => {
                row_num = attr(&attrs, "r").unwrap_or("").to_string();
                cells.clear();
                next_col = 0;
            }
            "c" => {
                col = attr(&attrs, "r").map(column_index).unwrap_or(next_col);
                kind = attr(&attrs, "t").unwrap_or("").to_string();
                value.clear();
                inline.clear();
            }
            "v" => in_v = true,
            "is" => in_is = true,
            "t" => in_t = true,
            _ => {}
        },
        Xml::End(name) => match name.as_str() {
            "v" => in_v = false,
            "is" => in_is = false,
            "t" => in_t = false,
            "c" => {
                let text = match kind.as_str() {
                    "s" => value
                        .trim()
                        .parse::<usize>()
                        .ok()
                        .and_then(|i| shared.get(i).cloned())
                        .unwrap_or_default(),
                    "inlineStr" => inline.clone(),
                    "b" => if value.trim() == "1" { "TRUE" } else { "FALSE" }.to_string(),
                    _ => value.clone(),
                };
                if !text.is_empty() {
                    cells.push((col, text.replace(['\t', '\n', '\r'], " ")));
                }
                next_col = col + 1;
            }
            "row" if !cells.is_empty() => {
                let width = cells.iter().map(|(c, _)| c + 1).max().unwrap_or(0);
                let mut fields = vec![String::new(); width];
                for (c, t) in cells.drain(..) {
                    fields[c] = t;
                }
                rows.push(format!("R{row_num}\t{}", fields.join("\t")));
            }
            _ => {}
        },
        Xml::Text(text) => {
            if in_v {
                value.push_str(&text);
            } else if in_is && in_t {
                inline.push_str(&text);
            }
        }
    })?;
    Ok(rows)
}

fn resolve_target(base_dir: &str, target: &str) -> String {
    match target.strip_prefix('/') {
        Some(abs) => abs.to_string(),
        None => format!("{base_dir}{target}"),
    }
}

fn xlsx_text(zip: &mut ZipArchive) -> Result<String, String> {
    let shared = if zip.contains("xl/sharedStrings.xml") {
        shared_strings(&zip.read("xl/sharedStrings.xml")?)?
    } else {
        Vec::new()
    };
    let workbook = zip.read("xl/workbook.xml")?;
    let mut sheets: Vec<(String, String)> = Vec::new(); // name, rel id
    parse_xml(&workbook, |ev| {
        if let Xml::Start(name, attrs) = ev {
            if name == "sheet" {
                sheets.push((
                    attr(&attrs, "name").unwrap_or("").to_string(),
                    attr(&attrs, "id").unwrap_or("").to_string(),
                ));
            }
        }
    })?;
    let mut rels: HashMap<String, String> = HashMap::new();
    if zip.contains("xl/_rels/workbook.xml.rels") {
        let data = zip.read("xl/_rels/workbook.xml.rels")?;
        parse_xml(&data, |ev| {
            if let Xml::Start(name, attrs) = ev {
                if name == "Relationship" {
                    if let (Some(id), Some(target)) = (attr(&attrs, "Id"), attr(&attrs, "Target")) {
                        rels.insert(id.to_string(), resolve_target("xl/", target));
                    }
                }
            }
        })?;
    }
    if sheets.is_empty() {
        return Err("workbook contains no sheets".into());
    }
    let mut out = String::new();
    for (index, (name, rid)) in sheets.iter().enumerate() {
        let path = rels
            .get(rid)
            .cloned()
            .unwrap_or_else(|| format!("xl/worksheets/sheet{}.xml", index + 1));
        out.push_str(&format!("## Sheet: {name}\n"));
        if !zip.contains(&path) {
            out.push_str("(sheet data missing)\n\n");
            continue;
        }
        let rows = sheet_rows(&zip.read(&path)?, &shared)?;
        if rows.is_empty() {
            out.push_str("(empty)\n");
        }
        for row in rows {
            out.push_str(&row);
            out.push('\n');
        }
        out.push('\n');
    }
    Ok(out.trim_end().to_string())
}

// ------------------------------------------------------------------ pptx

fn slide_number(name: &str) -> Option<u32> {
    name.strip_prefix("ppt/slides/slide")?
        .strip_suffix(".xml")?
        .parse()
        .ok()
}

fn pptx_text(zip: &mut ZipArchive) -> Result<String, String> {
    let mut slides: Vec<(u32, String)> = zip
        .names()
        .iter()
        .filter_map(|n| slide_number(n).map(|i| (i, n.clone())))
        .collect();
    slides.sort();
    if slides.is_empty() {
        return Err("presentation contains no slides".into());
    }
    let mut out = String::new();
    for (number, name) in slides {
        out.push_str(&format!("## Slide {number}\n"));
        let xml = zip.read(&name)?;
        let mut line = String::new();
        let mut in_t = false;
        let mut lines: Vec<String> = Vec::new();
        parse_xml(&xml, |ev| match ev {
            Xml::Start(n, _) if n == "t" => in_t = true,
            Xml::End(n) if n == "t" => in_t = false,
            Xml::End(n) if n == "p" => lines.push(std::mem::take(&mut line)),
            Xml::Text(text) if in_t => line.push_str(&text),
            _ => {}
        })?;
        for l in lines.into_iter().filter(|l| !l.trim().is_empty()) {
            out.push_str(&l);
            out.push('\n');
        }
        out.push('\n');
    }
    Ok(out.trim_end().to_string())
}

/// Extracts readable text from a docx / xlsx / pptx file; `ext` is lower-case.
pub(crate) fn extract_text(ext: &str, data: Vec<u8>) -> Result<String, String> {
    let mut zip = ZipArchive::new(data)?;
    match ext {
        "docx" => docx_text(&zip.read("word/document.xml")?),
        "xlsx" => xlsx_text(&mut zip),
        "pptx" => pptx_text(&mut zip),
        other => Err(format!("unsupported Office format `{other}`")),
    }
}

#[cfg(test)]
pub(crate) mod testutil {
    use std::io::Write;

    fn crc32(data: &[u8]) -> u32 {
        let mut h = flate2::Crc::new();
        h.update(data);
        h.sum()
    }

    /// Builds a ZIP; entries flagged `deflate` use method 8, others stored.
    pub(crate) fn make_zip(files: &[(&str, &[u8], bool)]) -> Vec<u8> {
        let mut out = Vec::new();
        let mut central = Vec::new();
        for (name, data, deflate) in files {
            let (method, payload) = if *deflate {
                let mut enc =
                    flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
                enc.write_all(data).unwrap();
                (8u16, enc.finish().unwrap())
            } else {
                (0u16, data.to_vec())
            };
            let offset = out.len() as u32;
            let crc = crc32(data);
            out.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
            out.extend_from_slice(&[20, 0, 0, 0]);
            out.extend_from_slice(&method.to_le_bytes());
            out.extend_from_slice(&[0; 4]);
            out.extend_from_slice(&crc.to_le_bytes());
            out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
            out.extend_from_slice(&(data.len() as u32).to_le_bytes());
            out.extend_from_slice(&(name.len() as u16).to_le_bytes());
            out.extend_from_slice(&[0, 0]);
            out.extend_from_slice(name.as_bytes());
            out.extend_from_slice(&payload);

            central.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
            central.extend_from_slice(&[20, 0, 20, 0, 0, 0]);
            central.extend_from_slice(&method.to_le_bytes());
            central.extend_from_slice(&[0; 4]);
            central.extend_from_slice(&crc.to_le_bytes());
            central.extend_from_slice(&(payload.len() as u32).to_le_bytes());
            central.extend_from_slice(&(data.len() as u32).to_le_bytes());
            central.extend_from_slice(&(name.len() as u16).to_le_bytes());
            central.extend_from_slice(&[0; 12]);
            central.extend_from_slice(&offset.to_le_bytes());
            central.extend_from_slice(name.as_bytes());
        }
        let cd_offset = out.len() as u32;
        out.extend_from_slice(&central);
        out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
        out.extend_from_slice(&[0; 4]);
        out.extend_from_slice(&(files.len() as u16).to_le_bytes());
        out.extend_from_slice(&(files.len() as u16).to_le_bytes());
        out.extend_from_slice(&(central.len() as u32).to_le_bytes());
        out.extend_from_slice(&cd_offset.to_le_bytes());
        out.extend_from_slice(&[0, 0]);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::testutil::make_zip;
    use super::*;

    #[test]
    fn docx_paragraphs() {
        let xml = br#"<?xml version="1.0"?><w:document xmlns:w="x"><w:body>
<w:p><w:r><w:t>Hello</w:t></w:r><w:r><w:tab/><w:t xml:space="preserve"> world &amp; co</w:t></w:r></w:p>
<w:p><w:r><w:t>Second</w:t></w:r></w:p></w:body></w:document>"#;
        let zip = make_zip(&[("word/document.xml", xml, true)]);
        let text = extract_text("docx", zip).unwrap();
        assert!(text.contains("Hello\t world & co"), "{text}");
        assert!(text.contains("Second"));
    }

    #[test]
    fn xlsx_sheets() {
        let wb = br#"<workbook xmlns:r="r"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>"#;
        let rels = br#"<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>"#;
        let ss = br#"<sst><si><t>Name</t></si><si><r><t>Al</t></r><r><t>ice</t></r></si></sst>"#;
        let sheet = br#"<worksheet><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="inlineStr"><is><t>inl</t></is></c></row>
<row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>42</v></c><c r="C2" t="b"><v>1</v></c></row>
</sheetData></worksheet>"#;
        let zip = make_zip(&[
            ("xl/workbook.xml", wb, false),
            ("xl/_rels/workbook.xml.rels", rels, false),
            ("xl/sharedStrings.xml", ss, false),
            ("xl/worksheets/sheet1.xml", sheet, true),
        ]);
        let text = extract_text("xlsx", zip).unwrap();
        assert!(text.contains("## Sheet: Data"), "{text}");
        assert!(text.contains("R1\tName\t\tinl"), "{text}");
        assert!(text.contains("R2\tAlice\t42\tTRUE"), "{text}");
    }

    #[test]
    fn pptx_slides_numeric_order() {
        let slide = |t: &str| {
            format!(
                r#"<p:sld xmlns:a="a" xmlns:p="p"><a:p><a:r><a:t>{t}</a:t></a:r></a:p></p:sld>"#
            )
            .into_bytes()
        };
        let (s2, s10) = (slide("two"), slide("ten"));
        let zip = make_zip(&[
            ("ppt/slides/slide10.xml", &s10, false),
            ("ppt/slides/slide2.xml", &s2, false),
        ]);
        let text = extract_text("pptx", zip).unwrap();
        let (a, b) = (text.find("two").unwrap(), text.find("ten").unwrap());
        assert!(a < b, "{text}");
        assert!(text.contains("## Slide 10"));
    }

    #[test]
    fn rejects_bad_archives() {
        assert!(ZipArchive::new(b"hello".to_vec()).is_err());
        let mut zip = make_zip(&[("a.txt", b"x", false)]);
        // set the general-purpose flag "encrypted" in the central directory entry
        let cd = zip
            .windows(4)
            .position(|w| w == [0x50, 0x4b, 0x01, 0x02])
            .unwrap();
        zip[cd + 8] |= 1;
        match ZipArchive::new(zip) {
            Err(error) => assert!(error.contains("encrypted"), "{error}"),
            Ok(_) => panic!("expected an error"),
        }
    }

    #[test]
    fn bomb_is_rejected() {
        let big = vec![0u8; 51 * 1024 * 1024];
        let mut zip = ZipArchive::new(make_zip(&[("big.bin", &big, true)])).unwrap();
        assert!(zip.read("big.bin").unwrap_err().contains("50 MB"));
    }
}
