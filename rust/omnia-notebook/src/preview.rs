//! 17-Format `RichPreviewService` classifying & generating safe structured previews with
//! mandatory `X-Content-Type-Options: nosniff` and forced `Content-Disposition: attachment`
//! protection for active web markup (`HTML` / `SVG`) and opaque binaries.

use std::io::Read;

use flate2::read::GzDecoder;
use omnia_connector_gateway::{
    artifact_intake::sanitize_download_filename, find_unsafe_prototype_key,
};
use omnia_core::{sha256_hex, SecretRedactor};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::NotebookError;
use crate::ingestion::{
    clean_html_to_text, extract_docx_markdown, extract_epub_markdown, extract_odt_markdown,
    extract_pptx_slides, extract_xlsx_sheets, extract_xml_text, inspect_and_extract_pdf,
    inspect_zip_archive_safe, is_likely_binary, normalize_utf8_and_lf, parse_delimited_table,
    parse_ipynb_cells, strip_rtf_to_text, ExtractedNotebookCell, ExtractedSheet, ExtractedSlide,
    PdfClassification,
};
use crate::policy::{
    extract_extension_lower, infer_mime_from_extension, requires_forced_attachment,
    validate_archive_entry_path, validate_archive_limits, validate_xml_safety,
    PreviewSecurityHeaders, MAX_ARCHIVE_TOTAL_UNCOMPRESSED_BYTES, MAX_BINARY_PREVIEW_BYTES,
    MAX_JAR_PREVIEW_CLASSES,
};

/// All 17 preview format classes supported by [`RichPreviewService`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PreviewFormat {
    /// 1. PDF summary & extracted text excerpt (with HTTP Range hint + encryption status).
    Pdf,
    /// 2. Spreadsheet grid (`xlsx`, `xls`, `ods`).
    SpreadsheetGrid,
    /// 3. Delimited tabular grid (`csv`, `tsv`).
    DelimitedTable,
    /// 4. Word document (`docx`).
    WordDocument,
    /// 5. Presentation slide deck (`pptx`).
    PresentationDeck,
    /// 6. EPUB e-book (`epub`).
    EpubBook,
    /// 7. OpenDocument Text (`odt`).
    OpenDocumentText,
    /// 8. Rich Text Format (`rtf`).
    RichText,
    /// 9. Jupyter Notebook cells (`ipynb`).
    JupyterNotebook,
    /// 10. Archive file tree (`zip`, `jar`, `tar`, `tgz`, `tar.gz`).
    ArchiveTree,
    /// 11. Syntax-tagged source code (60+ programming languages).
    SourceCode,
    /// 12. Markdown document (`md`, `mdx`, `markdown`).
    Markdown,
    /// 13. Structured data (`json`, `yaml`, `yml`, `toml`, `xml`).
    StructuredData,
    /// 14. HTML document (`html`, `htm`, `xhtml` — FORCED `attachment` disposition!).
    HtmlDocument,
    /// 15. SVG vector (`svg` — FORCED `attachment` disposition + XXE checked!).
    SvgVector,
    /// 16. Media asset metadata (image/audio/video magic-byte inspection).
    MediaAsset,
    /// 17. Binary 4 KiB hex + ASCII dump + SHA-256 fallback (FORCED `attachment` disposition!).
    BinaryHexFallback,
}

/// One entry in an archive tree preview.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArchiveTreeEntry {
    pub path: String,
    pub uncompressed_bytes: u64,
    pub compressed_bytes: u64,
    pub is_dir: bool,
}

/// Media asset header metadata parsed safely from magic bytes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MediaAssetMetadata {
    pub media_family: String,
    pub container: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub sample_rate_hz: Option<u32>,
    pub channels: Option<u16>,
    pub byte_size: usize,
}

/// Typed preview content payload tailored to each of the 17 formats.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PreviewContent {
    PdfSummary {
        classification: PdfClassification,
        pdf_version: Option<String>,
        estimated_pages: usize,
        is_encrypted: bool,
        supports_http_range: bool,
        text_excerpt: String,
    },
    Table {
        sheets: Vec<ExtractedSheet>,
    },
    Text {
        headings: Vec<String>,
        text: String,
        truncated: bool,
    },
    Slides {
        slides: Vec<ExtractedSlide>,
    },
    NotebookCells {
        cells: Vec<ExtractedNotebookCell>,
    },
    ArchiveTree {
        archive_kind: String,
        total_entries: usize,
        omitted_entries: usize,
        entries: Vec<ArchiveTreeEntry>,
    },
    Code {
        language: String,
        line_count: usize,
        snippet: String,
        truncated: bool,
    },
    MediaMetadata {
        metadata: MediaAssetMetadata,
    },
    BinaryHex {
        preview_bytes: usize,
        total_bytes: usize,
        hex_dump: String,
        sha256: String,
    },
}

/// Complete safe preview response (`PreviewPayload` public Wave 3 contract).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PreviewPayload {
    pub format: PreviewFormat,
    pub safe_filename: String,
    pub mime_type: String,
    pub byte_size: usize,
    pub sha256: String,
    pub blake3: String,
    pub headers: PreviewSecurityHeaders,
    pub content: PreviewContent,
    pub warnings: Vec<String>,
}

/// Stateless 17-format pure-Rust Rich Preview Service.
#[derive(Debug, Clone, Default)]
pub struct RichPreviewService {
    max_text_preview_chars: usize,
}

impl RichPreviewService {
    /// Create a preview service with the default 64 KiB text preview window.
    #[must_use]
    pub const fn new() -> Self {
        Self {
            max_text_preview_chars: 64 * 1024,
        }
    }

    /// Classify a file into one of the 17 [`PreviewFormat`] variants.
    #[must_use]
    pub fn classify(filename: &str, mime_type: Option<&str>, bytes: &[u8]) -> PreviewFormat {
        let ext = extract_extension_lower(filename);
        let mime = mime_type
            .map(|m| m.split(';').next().unwrap_or("").trim().to_ascii_lowercase())
            .unwrap_or_else(|| infer_mime_from_extension(&ext).to_string());

        if ext == "svg" || mime == "image/svg+xml" {
            return PreviewFormat::SvgVector;
        }
        if matches!(ext.as_str(), "html" | "htm" | "xhtml")
            || mime.starts_with("text/html")
            || mime.starts_with("application/xhtml")
        {
            return PreviewFormat::HtmlDocument;
        }
        if ext == "pdf" || mime == "application/pdf" || bytes.starts_with(b"%PDF-") {
            return PreviewFormat::Pdf;
        }
        if matches!(ext.as_str(), "xlsx" | "xls" | "ods") {
            return PreviewFormat::SpreadsheetGrid;
        }
        if matches!(ext.as_str(), "csv" | "tsv") {
            return PreviewFormat::DelimitedTable;
        }
        if ext == "docx" {
            return PreviewFormat::WordDocument;
        }
        if ext == "pptx" {
            return PreviewFormat::PresentationDeck;
        }
        if ext == "epub" {
            return PreviewFormat::EpubBook;
        }
        if ext == "odt" {
            return PreviewFormat::OpenDocumentText;
        }
        if ext == "rtf" || bytes.starts_with(b"{\\rtf") {
            return PreviewFormat::RichText;
        }
        if ext == "ipynb" || mime == "application/x-ipynb+json" {
            return PreviewFormat::JupyterNotebook;
        }
        if matches!(ext.as_str(), "zip" | "jar" | "tar" | "tgz" | "gz") {
            return PreviewFormat::ArchiveTree;
        }
        if matches!(ext.as_str(), "md" | "mdx" | "markdown") || mime == "text/markdown" {
            return PreviewFormat::Markdown;
        }
        if matches!(ext.as_str(), "json" | "yaml" | "yml" | "toml" | "xml")
            || mime == "application/json"
            || mime == "application/xml"
            || mime == "text/xml"
        {
            return PreviewFormat::StructuredData;
        }
        if matches!(
            ext.as_str(),
            "png" | "jpg" | "jpeg" | "webp" | "gif" | "mp3" | "wav" | "ogg" | "m4a" | "mp4"
                | "webm" | "mkv"
        ) || mime.starts_with("image/")
            || mime.starts_with("audio/")
            || mime.starts_with("video/")
        {
            return PreviewFormat::MediaAsset;
        }
        if detect_code_language(filename).is_some() && !is_likely_binary(bytes) {
            return PreviewFormat::SourceCode;
        }
        if !is_likely_binary(bytes) && matches!(ext.as_str(), "txt" | "log" | "rst" | "adoc" | "org" | "tex" | "bib") {
            return PreviewFormat::Markdown;
        }
        PreviewFormat::BinaryHexFallback
    }

    /// Generate a full safe [`PreviewPayload`] with mandatory `nosniff`, HTML/SVG forced `attachment`,
    /// XXE validation, and zip-bomb / archive-depth enforcement.
    pub fn generate_preview(
        &self,
        filename: &str,
        mime_type: Option<&str>,
        bytes: &[u8],
    ) -> Result<PreviewPayload, NotebookError> {
        let safe_filename = sanitize_download_filename(filename)?;
        let ext = extract_extension_lower(&safe_filename);
        let resolved_mime = mime_type
            .map(|m| m.split(';').next().unwrap_or("").trim().to_ascii_lowercase())
            .filter(|m| !m.is_empty())
            .unwrap_or_else(|| infer_mime_from_extension(&ext).to_string());

        let format = Self::classify(&safe_filename, Some(&resolved_mime), bytes);
        let sha256 = sha256_hex(bytes);
        let blake3 = blake3::hash(bytes).to_hex().to_string();
        let force_attachment = requires_forced_attachment(&ext, &resolved_mime)
            || matches!(
                format,
                PreviewFormat::HtmlDocument
                    | PreviewFormat::SvgVector
                    | PreviewFormat::BinaryHexFallback
            );
        let headers = PreviewSecurityHeaders::for_format(&safe_filename, force_attachment);
        let mut warnings = Vec::new();

        let content = match format {
            PreviewFormat::Pdf => {
                let pdf = inspect_and_extract_pdf(bytes);
                warnings.extend(pdf.warnings);
                let (excerpt, _) = self.truncate_preview(&SecretRedactor::redact(&pdf.extracted_text));
                PreviewContent::PdfSummary {
                    classification: pdf.classification,
                    pdf_version: pdf.pdf_version,
                    estimated_pages: pdf.estimated_pages,
                    is_encrypted: pdf.is_encrypted,
                    supports_http_range: true,
                    text_excerpt: excerpt,
                }
            }
            PreviewFormat::SpreadsheetGrid => {
                let sheets = extract_xlsx_sheets(bytes, 0)?;
                PreviewContent::Table { sheets }
            }
            PreviewFormat::DelimitedTable => {
                let delim = if ext == "tsv" { b'\t' } else { b',' };
                let text = SecretRedactor::redact(&normalize_utf8_and_lf(bytes));
                let sheet = parse_delimited_table(&safe_filename, &text, delim);
                PreviewContent::Table {
                    sheets: vec![sheet],
                }
            }
            PreviewFormat::WordDocument => {
                let md = SecretRedactor::redact(&extract_docx_markdown(bytes, 0)?);
                let headings = extract_markdown_headings(&md);
                let (text, truncated) = self.truncate_preview(&md);
                PreviewContent::Text {
                    headings,
                    text,
                    truncated,
                }
            }
            PreviewFormat::PresentationDeck => {
                let slides = extract_pptx_slides(bytes, 0)?;
                PreviewContent::Slides { slides }
            }
            PreviewFormat::EpubBook => {
                let md = SecretRedactor::redact(&extract_epub_markdown(bytes, 0)?);
                let headings = extract_markdown_headings(&md);
                let (text, truncated) = self.truncate_preview(&md);
                PreviewContent::Text {
                    headings,
                    text,
                    truncated,
                }
            }
            PreviewFormat::OpenDocumentText => {
                let md = SecretRedactor::redact(&extract_odt_markdown(bytes, 0)?);
                let (text, truncated) = self.truncate_preview(&md);
                PreviewContent::Text {
                    headings: Vec::new(),
                    text,
                    truncated,
                }
            }
            PreviewFormat::RichText => {
                let plain = SecretRedactor::redact(&strip_rtf_to_text(&normalize_utf8_and_lf(bytes)));
                let (text, truncated) = self.truncate_preview(&plain);
                PreviewContent::Text {
                    headings: Vec::new(),
                    text,
                    truncated,
                }
            }
            PreviewFormat::JupyterNotebook => {
                let cells = parse_ipynb_cells(bytes)?;
                PreviewContent::NotebookCells { cells }
            }
            PreviewFormat::ArchiveTree => {
                build_archive_tree_preview(&safe_filename, &ext, bytes, &mut warnings)?
            }
            PreviewFormat::SourceCode => {
                let language = detect_code_language(&safe_filename)
                    .unwrap_or("plaintext")
                    .to_string();
                let clean = SecretRedactor::redact(&normalize_utf8_and_lf(bytes));
                let line_count = clean.lines().count();
                let (snippet, truncated) = self.truncate_preview(&clean);
                PreviewContent::Code {
                    language,
                    line_count,
                    snippet,
                    truncated,
                }
            }
            PreviewFormat::Markdown => {
                let clean = SecretRedactor::redact(&normalize_utf8_and_lf(bytes));
                let headings = extract_markdown_headings(&clean);
                let (text, truncated) = self.truncate_preview(&clean);
                PreviewContent::Text {
                    headings,
                    text,
                    truncated,
                }
            }
            PreviewFormat::StructuredData => {
                let text_body = if ext == "xml" || resolved_mime.contains("xml") {
                    validate_xml_safety(bytes, &safe_filename)?;
                    SecretRedactor::redact(&extract_xml_text(bytes, &safe_filename)?)
                } else if ext == "json" || resolved_mime == "application/json" {
                    let val: Value = serde_json::from_slice(bytes)?;
                    if let Some(proto) = find_unsafe_prototype_key(&val, "$") {
                        return Err(NotebookError::SecurityRejected {
                            code: "UNSAFE_PROTOTYPE_KEY",
                            reason: format!("JSON preview rejected unsafe key '{proto}'"),
                        });
                    }
                    serde_json::to_string_pretty(&SecretRedactor::redact_json(&val))?
                } else {
                    SecretRedactor::redact(&normalize_utf8_and_lf(bytes))
                };
                let (text, truncated) = self.truncate_preview(&text_body);
                PreviewContent::Text {
                    headings: Vec::new(),
                    text,
                    truncated,
                }
            }
            PreviewFormat::HtmlDocument => {
                warnings.push(
                    "HTML active content neutralized: forced Content-Disposition: attachment + nosniff"
                        .to_string(),
                );
                let stripped = SecretRedactor::redact(&clean_html_to_text(&normalize_utf8_and_lf(bytes)));
                let (text, truncated) = self.truncate_preview(&stripped);
                PreviewContent::Text {
                    headings: Vec::new(),
                    text,
                    truncated,
                }
            }
            PreviewFormat::SvgVector => {
                validate_xml_safety(bytes, &safe_filename)?;
                warnings.push(
                    "SVG vector script risk neutralized: forced Content-Disposition: attachment + nosniff"
                        .to_string(),
                );
                let stripped = SecretRedactor::redact(&extract_xml_text(bytes, &safe_filename)?);
                let (text, truncated) = self.truncate_preview(&stripped);
                PreviewContent::Text {
                    headings: Vec::new(),
                    text,
                    truncated,
                }
            }
            PreviewFormat::MediaAsset => {
                let metadata = inspect_media_metadata(&ext, &resolved_mime, bytes);
                PreviewContent::MediaMetadata { metadata }
            }
            PreviewFormat::BinaryHexFallback => {
                let preview_len = bytes.len().min(MAX_BINARY_PREVIEW_BYTES);
                PreviewContent::BinaryHex {
                    preview_bytes: preview_len,
                    total_bytes: bytes.len(),
                    hex_dump: format_hex_dump(&bytes[..preview_len]),
                    sha256: sha256.clone(),
                }
            }
        };

        Ok(PreviewPayload {
            format,
            safe_filename,
            mime_type: resolved_mime,
            byte_size: bytes.len(),
            sha256,
            blake3,
            headers,
            content,
            warnings,
        })
    }

    fn truncate_preview(&self, text: &str) -> (String, bool) {
        let mut chars = text.chars();
        let taken: String = chars.by_ref().take(self.max_text_preview_chars).collect();
        let truncated = chars.next().is_some();
        (taken, truncated)
    }
}

fn build_archive_tree_preview(
    safe_filename: &str,
    ext: &str,
    bytes: &[u8],
    warnings: &mut Vec<String>,
) -> Result<PreviewContent, NotebookError> {
    if ext == "zip" || ext == "jar" {
        let safe_entries = inspect_zip_archive_safe(bytes, 0, safe_filename)?;
        let total = safe_entries.len();
        let mut class_count = 0usize;
        let mut omitted = 0usize;
        let mut entries = Vec::new();
        for e in safe_entries {
            if ext == "jar" && e.path.to_ascii_lowercase().ends_with(".class") {
                class_count += 1;
                if class_count > MAX_JAR_PREVIEW_CLASSES {
                    omitted += 1;
                    continue;
                }
            }
            entries.push(ArchiveTreeEntry {
                path: e.path,
                uncompressed_bytes: e.uncompressed_bytes,
                compressed_bytes: e.compressed_bytes,
                is_dir: e.is_dir,
            });
        }
        if omitted > 0 {
            warnings.push(format!(
                "JAR preview capped at {MAX_JAR_PREVIEW_CLASSES} .class files ({omitted} omitted)"
            ));
        }
        return Ok(PreviewContent::ArchiveTree {
            archive_kind: ext.to_string(),
            total_entries: total,
            omitted_entries: omitted,
            entries,
        });
    }

    // TAR / TAR.GZ / GZ safe inspection (pure-Rust USTAR 512-byte header walk).
    let tar_bytes = if ext == "tgz" || ext == "gz" || bytes.starts_with(&[0x1F, 0x8B]) {
        let dec = GzDecoder::new(bytes);
        let mut out = Vec::new();
        dec.take(MAX_ARCHIVE_TOTAL_UNCOMPRESSED_BYTES + 1)
            .read_to_end(&mut out)
            .map_err(|e| NotebookError::InvalidInput(format!("invalid gzip stream: {e}")))?;
        validate_archive_limits(1, bytes.len() as u64, out.len() as u64, 0, safe_filename)?;
        out
    } else {
        bytes.to_vec()
    };

    let entries = parse_ustar_entries(&tar_bytes, safe_filename)?;
    let total = entries.len();
    Ok(PreviewContent::ArchiveTree {
        archive_kind: ext.to_string(),
        total_entries: total,
        omitted_entries: 0,
        entries,
    })
}

fn parse_ustar_entries(data: &[u8], context: &str) -> Result<Vec<ArchiveTreeEntry>, NotebookError> {
    let mut entries = Vec::new();
    let mut offset = 0usize;
    let mut total_uncompressed: u64 = 0;

    while offset + 512 <= data.len() {
        let header = &data[offset..offset + 512];
        if header.iter().all(|&b| b == 0) {
            break;
        }
        let name_raw = read_tar_cstr(&header[0..100]);
        let prefix_raw = read_tar_cstr(&header[345..500]);
        let full_name = if prefix_raw.is_empty() {
            name_raw
        } else {
            format!("{prefix_raw}/{name_raw}")
        };
        if full_name.is_empty() {
            break;
        }
        let safe_path = validate_archive_entry_path(&full_name)?;
        let size_octal = read_tar_cstr(&header[124..136]);
        let file_size = u64::from_str_radix(size_octal.trim(), 8).unwrap_or(0);
        let typeflag = header[156];
        let is_dir = typeflag == b'5' || safe_path.ends_with('/');

        total_uncompressed = total_uncompressed.saturating_add(file_size);
        entries.push(ArchiveTreeEntry {
            path: safe_path,
            uncompressed_bytes: file_size,
            compressed_bytes: file_size,
            is_dir,
        });
        validate_archive_limits(
            entries.len(),
            data.len() as u64,
            total_uncompressed,
            0,
            context,
        )?;

        let blocks = file_size.div_ceil(512) as usize;
        offset = offset.saturating_add(512).saturating_add(blocks.saturating_mul(512));
    }
    Ok(entries)
}

fn read_tar_cstr(slice: &[u8]) -> String {
    let end = slice.iter().position(|&b| b == 0).unwrap_or(slice.len());
    String::from_utf8_lossy(&slice[..end]).trim().to_string()
}

fn inspect_media_metadata(ext: &str, mime_type: &str, bytes: &[u8]) -> MediaAssetMetadata {
    let mut width = None;
    let mut height = None;
    let mut sample_rate_hz = None;
    let mut channels = None;
    let mut container = ext.to_string();

    // PNG: 8-byte signature + IHDR width/height at offsets 16..24.
    if bytes.len() >= 24 && bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        container = "png".to_string();
        width = Some(u32::from_be_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]));
        height = Some(u32::from_be_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]));
    } else if bytes.len() >= 10 && (bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a")) {
        container = "gif".to_string();
        width = Some(u32::from(u16::from_le_bytes([bytes[6], bytes[7]])));
        height = Some(u32::from(u16::from_le_bytes([bytes[8], bytes[9]])));
    } else if bytes.len() >= 30 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        container = "webp".to_string();
    } else if bytes.len() >= 36 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WAVE" {
        container = "wav".to_string();
        channels = Some(u16::from_le_bytes([bytes[22], bytes[23]]));
        sample_rate_hz = Some(u32::from_le_bytes([
            bytes[24], bytes[25], bytes[26], bytes[27],
        ]));
    } else if bytes.starts_with(b"\xFF\xD8\xFF") {
        container = "jpeg".to_string();
        if let Some((w, h)) = parse_jpeg_dimensions(bytes) {
            width = Some(w);
            height = Some(h);
        }
    } else if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" {
        container = "mp4".to_string();
    } else if bytes.starts_with(&[0x1A, 0x45, 0xDF, 0xA3]) {
        container = "webm".to_string();
    } else if bytes.starts_with(b"ID3") || bytes.starts_with(&[0xFF, 0xFB]) {
        container = "mp3".to_string();
    } else if bytes.starts_with(b"OggS") {
        container = "ogg".to_string();
    }

    let media_family = if mime_type.starts_with("video/") || matches!(container.as_str(), "mp4" | "webm" | "mkv") {
        "video"
    } else if mime_type.starts_with("audio/") || matches!(container.as_str(), "wav" | "mp3" | "ogg" | "m4a") {
        "audio"
    } else {
        "image"
    }
    .to_string();

    MediaAssetMetadata {
        media_family,
        container,
        width,
        height,
        sample_rate_hz,
        channels,
        byte_size: bytes.len(),
    }
}

fn parse_jpeg_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    let mut i = 2usize;
    while i + 9 < bytes.len() {
        if bytes[i] != 0xFF {
            i += 1;
            continue;
        }
        let marker = bytes[i + 1];
        if matches!(marker, 0xC0..=0xC2) {
            let h = u16::from_be_bytes([bytes[i + 5], bytes[i + 6]]);
            let w = u16::from_be_bytes([bytes[i + 7], bytes[i + 8]]);
            return Some((u32::from(w), u32::from(h)));
        }
        if i + 4 >= bytes.len() {
            break;
        }
        let seg_len = u16::from_be_bytes([bytes[i + 2], bytes[i + 3]]) as usize;
        if seg_len < 2 {
            break;
        }
        i = i.saturating_add(2 + seg_len);
    }
    None
}

/// Format a deterministic canonical 16-byte-per-row hex + ASCII dump (up to 4 KiB).
#[must_use]
pub fn format_hex_dump(slice: &[u8]) -> String {
    let mut lines = Vec::new();
    for (row_idx, chunk) in slice.chunks(16).enumerate() {
        let offset = row_idx * 16;
        let mut hex_part = String::with_capacity(48);
        let mut ascii_part = String::with_capacity(16);
        for (i, &b) in chunk.iter().enumerate() {
            if i == 8 {
                hex_part.push(' ');
            }
            hex_part.push_str(&format!("{b:02x} "));
            ascii_part.push(if b.is_ascii_graphic() || b == b' ' {
                b as char
            } else {
                '.'
            });
        }
        lines.push(format!("{offset:08x}: {hex_part:<49} |{ascii_part}|"));
    }
    lines.join("\n")
}

fn extract_markdown_headings(md: &str) -> Vec<String> {
    md.lines()
        .filter_map(|line| {
            let trimmed = line.trim_start();
            trimmed
                .starts_with('#')
                .then(|| trimmed.trim_start_matches('#').trim().to_string())
                .filter(|h| !h.is_empty())
        })
        .take(64)
        .collect()
}

/// Detect syntax-highlighting language across **65+ programming & configuration languages**.
#[must_use]
pub fn detect_code_language(filename: &str) -> Option<&'static str> {
    let ext = extract_extension_lower(filename);
    match ext.as_str() {
        "rs" => Some("rust"),
        "ts" => Some("typescript"),
        "tsx" => Some("tsx"),
        "js" | "mjs" | "cjs" => Some("javascript"),
        "jsx" => Some("jsx"),
        "py" | "pyi" | "pyw" => Some("python"),
        "go" => Some("go"),
        "java" => Some("java"),
        "kt" | "kts" => Some("kotlin"),
        "c" => Some("c"),
        "h" => Some("c-header"),
        "cpp" | "cc" | "cxx" => Some("cpp"),
        "hpp" | "hh" | "hxx" => Some("cpp-header"),
        "cs" => Some("csharp"),
        "rb" => Some("ruby"),
        "php" => Some("php"),
        "swift" => Some("swift"),
        "scala" | "sc" => Some("scala"),
        "sh" => Some("shell"),
        "bash" => Some("bash"),
        "zsh" => Some("zsh"),
        "fish" => Some("fish"),
        "ps1" | "psm1" | "psd1" => Some("powershell"),
        "bat" | "cmd" => Some("batch"),
        "sql" => Some("sql"),
        "graphql" | "gql" => Some("graphql"),
        "proto" => Some("protobuf"),
        "css" => Some("css"),
        "scss" => Some("scss"),
        "sass" => Some("sass"),
        "less" => Some("less"),
        "vue" => Some("vue"),
        "svelte" => Some("svelte"),
        "astro" => Some("astro"),
        "lua" => Some("lua"),
        "r" => Some("r"),
        "jl" => Some("julia"),
        "dart" => Some("dart"),
        "ex" | "exs" => Some("elixir"),
        "erl" | "hrl" => Some("erlang"),
        "hs" => Some("haskell"),
        "ml" | "mli" => Some("ocaml"),
        "clj" | "cljs" | "cljc" => Some("clojure"),
        "fs" | "fsx" => Some("fsharp"),
        "zig" => Some("zig"),
        "nim" => Some("nim"),
        "v" => Some("vlang"),
        "sol" => Some("solidity"),
        "tf" | "tfvars" => Some("terraform"),
        "hcl" => Some("hcl"),
        "nix" => Some("nix"),
        "dockerfile" => Some("dockerfile"),
        "makefile" | "mk" => Some("makefile"),
        "cmake" => Some("cmake"),
        "groovy" | "gradle" => Some("groovy"),
        "pl" | "pm" => Some("perl"),
        "asm" | "s" => Some("assembly"),
        "m" | "mm" => Some("objective-c"),
        "f90" | "f95" | "for" => Some("fortran"),
        "cob" | "cbl" => Some("cobol"),
        "lisp" | "lsp" | "scm" => Some("lisp"),
        "rkt" => Some("racket"),
        "cr" => Some("crystal"),
        "gleam" => Some("gleam"),
        "wgsl" => Some("wgsl"),
        "glsl" | "vert" | "frag" => Some("glsl"),
        "hlsl" => Some("hlsl"),
        "prisma" => Some("prisma"),
        "thrift" => Some("thrift"),
        "capnp" => Some("capnp"),
        "ini" | "cfg" | "conf" => Some("ini"),
        _ => None,
    }
}
