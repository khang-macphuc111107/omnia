use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::Path;

use omnia_core::{
    base64_encode, hex_decode, hex_encode, is_valid_utf8, sanitize_utf8_lossy, sha256_hex, uuid_v4,
};
use serde::Serialize;
use serde_json::{json, Value};

use crate::composer_model::ComposerModel;
use crate::proactive_rag::fold_vietnamese_ascii;

const MAX_UNDO_DEPTH: usize = 128;
const DRAFT_MAGIC_HEADER: &str = "OMNIA_COMPOSER_DRAFT_V1";

/// Wire-level content block suitable for provider payloads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WireBlock {
    Text { text: String },
    Image { media_type: String, data: String },
}

impl WireBlock {
    #[must_use]
    pub fn to_json(&self) -> Value {
        match self {
            Self::Text { text } => json!({
                "type": "text",
                "text": text,
            }),
            Self::Image { media_type, data } => json!({
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": media_type,
                    "data": data,
                },
            }),
        }
    }

    pub fn from_json(value: &Value) -> Result<Self, String> {
        let kind = value
            .get("type")
            .and_then(Value::as_str)
            .ok_or_else(|| "wire block missing `type`".to_owned())?;
        match kind {
            "text" => Ok(Self::Text {
                text: value
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
            }),
            "image" => {
                let source = value.get("source").unwrap_or(value);
                Ok(Self::Image {
                    media_type: source
                        .get("media_type")
                        .and_then(Value::as_str)
                        .unwrap_or("image/png")
                        .to_owned(),
                    data: source
                        .get("data")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned(),
                })
            }
            other => Err(format!("unsupported wire block type `{other}`")),
        }
    }
}

/// Wire message container emitted by [`RichComposer::serialize_for_provider`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WireMessage {
    pub role: String,
    pub content: Vec<WireBlock>,
}

impl WireMessage {
    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "role": self.role,
            "content": self.content.iter().map(WireBlock::to_json).collect::<Vec<_>>(),
        })
    }

    pub fn from_json(value: &Value) -> Result<Self, String> {
        let role = value
            .get("role")
            .and_then(Value::as_str)
            .ok_or_else(|| "wire message missing `role`".to_owned())?
            .to_owned();
        let blocks = value
            .get("content")
            .and_then(Value::as_array)
            .ok_or_else(|| "wire message missing `content` array".to_owned())?;
        let mut content = Vec::with_capacity(blocks.len());
        for block in blocks {
            content.push(WireBlock::from_json(block)?);
        }
        Ok(Self { role, content })
    }
}

impl Serialize for WireMessage {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.to_json().serialize(serializer)
    }
}

/// Caret anchor inside [`RichComposer`] (`node_index` + UTF-8 codepoint offset inside text spans).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct DocumentAnchor {
    pub node_index: usize,
    pub codepoint_offset: usize,
}

impl DocumentAnchor {
    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "node_index": self.node_index,
            "codepoint_offset": self.codepoint_offset,
        })
    }
}

/// Scientific symbol entry shown in the Math/Physics/Chemistry palette (`15` items).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SymbolPaletteItem {
    pub id: String,
    pub category: String,
    pub label: String,
    pub latex: String,
    pub unicode_preview: String,
    pub keywords: Vec<String>,
    pub display_mode: bool,
}

impl SymbolPaletteItem {
    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "category": self.category,
            "label": self.label,
            "latex": self.latex,
            "unicode_preview": self.unicode_preview,
            "keywords": self.keywords,
            "display_mode": self.display_mode,
        })
    }
}

/// Return the 15-entry Math (`7`), Physics (`4`), and Chemistry (`4`) symbol palette.
#[must_use]
pub fn symbol_palette() -> Vec<SymbolPaletteItem> {
    vec![
        palette_entry(
            "math-fraction",
            "Math",
            "Fraction",
            r"\frac{a}{b}",
            "a/b",
            &["fraction", "divide", "phan so"],
            false,
        ),
        palette_entry(
            "math-sqrt",
            "Math",
            "Square Root",
            r"\sqrt{x}",
            "\u{221a}x",
            &["sqrt", "root", "can bac hai"],
            false,
        ),
        palette_entry(
            "math-integral",
            "Math",
            "Integral",
            r"\int_{a}^{b} f(x)\,dx",
            "\u{222b}_a^b f(x) dx",
            &["integral", "calculus", "tich phan"],
            true,
        ),
        palette_entry(
            "math-summation",
            "Math",
            "Summation",
            r"\sum_{i=1}^{n} x_i",
            "\u{2211}_{i=1}^n x_i",
            &["sum", "sigma", "tong"],
            true,
        ),
        palette_entry(
            "math-limit",
            "Math",
            "Limit",
            r"\lim_{x \to \infty} f(x)",
            "lim_{x\u{2192}\u{221e}} f(x)",
            &["limit", "gioi han"],
            false,
        ),
        palette_entry(
            "math-partial",
            "Math",
            "Partial Derivative",
            r"\frac{\partial f}{\partial x}",
            "\u{2202}f/\u{2202}x",
            &["partial", "derivative", "dao ham"],
            false,
        ),
        palette_entry(
            "math-matrix-2x2",
            "Math",
            "2x2 Matrix",
            r"\begin{bmatrix} a & b \\ c & d \end{bmatrix}",
            "[a b; c d]",
            &["matrix", "ma tran"],
            true,
        ),
        palette_entry(
            "phys-maxwell-curl",
            "Physics",
            "Maxwell Faraday Curl",
            r"\nabla \times \mathbf{E} = -\frac{\partial \mathbf{B}}{\partial t}",
            "\u{2207}\u{00d7}E = -\u{2202}B/\u{2202}t",
            &["maxwell", "curl", "electromagnetism", "dien tu"],
            true,
        ),
        palette_entry(
            "phys-schrodinger",
            "Physics",
            "Schrodinger Equation",
            r"i\hbar\frac{\partial \Psi}{\partial t} = \hat{H}\Psi",
            "i\u{210f} \u{2202}\u{03a8}/\u{2202}t = H\u{0302}\u{03a8}",
            &["quantum", "wavefunction", "luong tu"],
            true,
        ),
        palette_entry(
            "phys-einstein",
            "Physics",
            "Energy-Momentum Relation",
            r"E^2 = (pc)^2 + (mc^2)^2",
            "E\u{00b2} = (pc)\u{00b2} + (mc\u{00b2})\u{00b2}",
            &["relativity", "energy", "tuong doi"],
            false,
        ),
        palette_entry(
            "phys-lorentz",
            "Physics",
            "Lorentz Force",
            r"\mathbf{F} = q(\mathbf{E} + \mathbf{v} \times \mathbf{B})",
            "F = q(E + v\u{00d7}B)",
            &["lorentz", "force", "luc tu"],
            false,
        ),
        palette_entry(
            "chem-reaction",
            "Chemistry",
            "Reversible Reaction",
            r"\mathrm{a\,A + b\,B \rightleftharpoons c\,C + d\,D}",
            "aA + bB \u{21cc} cC + dD",
            &["reaction", "phan ung"],
            true,
        ),
        palette_entry(
            "chem-equilibrium",
            "Chemistry",
            "Equilibrium Constant",
            r"K_c = \frac{[C]^c[D]^d}{[A]^a[B]^b}",
            "K_c = [C]^c[D]^d / [A]^a[B]^b",
            &["equilibrium", "can bang"],
            true,
        ),
        palette_entry(
            "chem-enthalpy",
            "Chemistry",
            "Reaction Enthalpy",
            r"\Delta H^{\circ}_{\mathrm{rxn}} = \sum \Delta H^{\circ}_f(\text{prod}) - \sum \Delta H^{\circ}_f(\text{react})",
            "\u{0394}H\u{00b0}_rxn",
            &["enthalpy", "thermochemistry", "nhiet phan ung"],
            true,
        ),
        palette_entry(
            "chem-gibbs",
            "Chemistry",
            "Gibbs Free Energy",
            r"\Delta G = \Delta H - T\Delta S",
            "\u{0394}G = \u{0394}H - T\u{0394}S",
            &["gibbs", "entropy", "nang luong tu do"],
            false,
        ),
    ]
}

fn palette_entry(
    id: &str,
    category: &str,
    label: &str,
    latex: &str,
    unicode_preview: &str,
    keywords: &[&str],
    display_mode: bool,
) -> SymbolPaletteItem {
    SymbolPaletteItem {
        id: id.to_owned(),
        category: category.to_owned(),
        label: label.to_owned(),
        latex: latex.to_owned(),
        unicode_preview: unicode_preview.to_owned(),
        keywords: keywords.iter().map(|s| (*s).to_owned()).collect(),
        display_mode,
    }
}

/// Filter [`symbol_palette`] case- and Vietnamese-diacritic-insensitively.
#[must_use]
pub fn search_symbol_palette(query: &str) -> Vec<SymbolPaletteItem> {
    let needle = fold_vietnamese_ascii(query.trim());
    let all = symbol_palette();
    if needle.is_empty() {
        return all;
    }
    all.into_iter()
        .filter(|item| {
            fold_vietnamese_ascii(&item.id).contains(&needle)
                || fold_vietnamese_ascii(&item.category).contains(&needle)
                || fold_vietnamese_ascii(&item.label).contains(&needle)
                || fold_vietnamese_ascii(&item.latex).contains(&needle)
                || item
                    .keywords
                    .iter()
                    .any(|kw| fold_vietnamese_ascii(kw).contains(&needle))
        })
        .collect()
}

/// Block-level structural role for a rich text span.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum BlockFormat {
    #[default]
    Paragraph,
    Heading1,
    Heading2,
    Heading3,
    BulletList,
    OrderedList,
    BlockQuote,
    CodeBlock,
    DisplayMath,
}

impl BlockFormat {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Paragraph => "Paragraph",
            Self::Heading1 => "Heading1",
            Self::Heading2 => "Heading2",
            Self::Heading3 => "Heading3",
            Self::BulletList => "BulletList",
            Self::OrderedList => "OrderedList",
            Self::BlockQuote => "BlockQuote",
            Self::CodeBlock => "CodeBlock",
            Self::DisplayMath => "DisplayMath",
        }
    }

    #[must_use]
    pub fn from_label(s: &str) -> Self {
        match s {
            "Heading1" => Self::Heading1,
            "Heading2" => Self::Heading2,
            "Heading3" => Self::Heading3,
            "BulletList" => Self::BulletList,
            "OrderedList" => Self::OrderedList,
            "BlockQuote" => Self::BlockQuote,
            "CodeBlock" => Self::CodeBlock,
            "DisplayMath" => Self::DisplayMath,
            _ => Self::Paragraph,
        }
    }
}

/// Inline formatting flags attached to a text span inside [`ComposerNode::TextSpan`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct TextStyle {
    pub bold: bool,
    pub italic: bool,
    pub inline_code: bool,
    pub underline: bool,
    pub strikethrough: bool,
    pub inline_math: bool,
    pub block_format: BlockFormat,
}

impl TextStyle {
    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "bold": self.bold,
            "italic": self.italic,
            "inline_code": self.inline_code,
            "underline": self.underline,
            "strikethrough": self.strikethrough,
            "inline_math": self.inline_math,
            "block_format": self.block_format.as_str(),
        })
    }

    #[must_use]
    pub fn from_json(value: &Value) -> Self {
        Self {
            bold: value.get("bold").and_then(Value::as_bool).unwrap_or(false),
            italic: value
                .get("italic")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            inline_code: value
                .get("inline_code")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            underline: value
                .get("underline")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            strikethrough: value
                .get("strikethrough")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            inline_math: value
                .get("inline_math")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            block_format: BlockFormat::from_label(
                value
                    .get("block_format")
                    .and_then(Value::as_str)
                    .unwrap_or("Paragraph"),
            ),
        }
    }
}

/// Editable Markdown table embedded inline inside the rich composer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComposerTable {
    pub headers: Vec<String>,
    pub rows: Vec<Vec<String>>,
}

impl ComposerTable {
    #[must_use]
    pub fn new(cols: usize, rows: usize) -> Self {
        let col_count = cols.max(1);
        let headers = (1..=col_count).map(|c| format!("Col {c}")).collect();
        let body = (0..rows).map(|_| vec![String::new(); col_count]).collect();
        Self {
            headers,
            rows: body,
        }
    }

    pub fn set_cell(&mut self, row: usize, col: usize, value: impl Into<String>) -> bool {
        if let Some(target_row) = self.rows.get_mut(row) {
            if let Some(cell) = target_row.get_mut(col) {
                *cell = value.into();
                return true;
            }
        }
        false
    }

    #[must_use]
    pub fn to_markdown(&self) -> String {
        let cols = self.headers.len().max(1);
        let escape = |s: &str| s.replace('|', r"\|");
        let mut lines = Vec::new();
        let hdr: Vec<String> = self.headers.iter().map(|h| escape(h)).collect();
        lines.push(format!("| {} |", hdr.join(" | ")));
        lines.push(format!("| {} |", vec!["---"; cols].join(" | ")));
        for row in &self.rows {
            let mut cells = Vec::with_capacity(cols);
            for col in 0..cols {
                cells.push(escape(row.get(col).map_or("", String::as_str)));
            }
            lines.push(format!("| {} |", cells.join(" | ")));
        }
        lines.join("\n")
    }

    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "headers": self.headers,
            "rows": self.rows,
        })
    }

    #[must_use]
    pub fn from_json(value: &Value) -> Self {
        let headers = value
            .get("headers")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default();
        let rows = value
            .get("rows")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(Value::as_array)
                    .map(|row| {
                        row.iter()
                            .filter_map(Value::as_str)
                            .map(str::to_owned)
                            .collect()
                    })
                    .collect()
            })
            .unwrap_or_default();
        Self { headers, rows }
    }
}

/// Ordered node inside a [`RichComposer`] document.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ComposerNode {
    TextSpan { text: String, style: TextStyle },
    Table(ComposerTable),
    InlineAttachment { attachment_id: String },
}

impl ComposerNode {
    #[must_use]
    pub fn to_json(&self) -> Value {
        match self {
            Self::TextSpan { text, style } => json!({
                "kind": "text_span",
                "text": text,
                "style": style.to_json(),
            }),
            Self::Table(table) => json!({
                "kind": "table",
                "table": table.to_json(),
            }),
            Self::InlineAttachment { attachment_id } => json!({
                "kind": "inline_attachment",
                "attachment_id": attachment_id,
            }),
        }
    }

    pub fn from_json(value: &Value) -> Result<Self, String> {
        match value.get("kind").and_then(Value::as_str) {
            Some("text_span") => Ok(Self::TextSpan {
                text: value
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                style: value
                    .get("style")
                    .map(TextStyle::from_json)
                    .unwrap_or_default(),
            }),
            Some("table") => Ok(Self::Table(
                value
                    .get("table")
                    .map(ComposerTable::from_json)
                    .unwrap_or_else(|| ComposerTable::new(2, 1)),
            )),
            Some("inline_attachment") => Ok(Self::InlineAttachment {
                attachment_id: value
                    .get("attachment_id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "inline_attachment missing attachment_id".to_owned())?
                    .to_owned(),
            }),
            other => Err(format!("unknown composer node kind `{other:?}`")),
        }
    }
}

/// Detected media format for pasted or dropped payloads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttachmentMediaKind {
    ImagePng,
    ImageJpeg,
    ImageWebp,
    Pdf,
    PlainText,
    AudioWav,
    VideoMp4,
    Unsupported,
}

impl AttachmentMediaKind {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ImagePng => "ImagePng",
            Self::ImageJpeg => "ImageJpeg",
            Self::ImageWebp => "ImageWebp",
            Self::Pdf => "Pdf",
            Self::PlainText => "PlainText",
            Self::AudioWav => "AudioWav",
            Self::VideoMp4 => "VideoMp4",
            Self::Unsupported => "Unsupported",
        }
    }

    #[must_use]
    pub fn from_label(s: &str) -> Self {
        match s {
            "ImagePng" => Self::ImagePng,
            "ImageJpeg" => Self::ImageJpeg,
            "ImageWebp" => Self::ImageWebp,
            "Pdf" => Self::Pdf,
            "PlainText" => Self::PlainText,
            "AudioWav" => Self::AudioWav,
            "VideoMp4" => Self::VideoMp4,
            _ => Self::Unsupported,
        }
    }

    #[must_use]
    pub const fn default_mime(self) -> &'static str {
        match self {
            Self::ImagePng => "image/png",
            Self::ImageJpeg => "image/jpeg",
            Self::ImageWebp => "image/webp",
            Self::Pdf => "application/pdf",
            Self::PlainText => "text/plain",
            Self::AudioWav => "audio/wav",
            Self::VideoMp4 => "video/mp4",
            Self::Unsupported => "application/octet-stream",
        }
    }
}

/// Asynchronous extraction/conversion status for an attachment payload.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConversionStatus {
    Ready,
    Converting,
    Failed,
    Cancelled,
}

impl ConversionStatus {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Ready => "Ready",
            Self::Converting => "Converting",
            Self::Failed => "Failed",
            Self::Cancelled => "Cancelled",
        }
    }

    #[must_use]
    pub fn from_label(s: &str) -> Self {
        match s {
            "Ready" => Self::Ready,
            "Converting" => Self::Converting,
            "Failed" => Self::Failed,
            "Cancelled" => Self::Cancelled,
            _ => Self::Failed,
        }
    }
}

/// Extracted representation associated with a processed attachment.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct DerivedRepresentation {
    pub summary_text: String,
    pub extracted_text: String,
    pub media_blocks: Vec<WireBlock>,
    pub transcript_lines: Vec<String>,
    pub page_count: u32,
    pub width: u32,
    pub height: u32,
    pub duration_ms: u64,
}

impl DerivedRepresentation {
    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "summary_text": self.summary_text,
            "extracted_text": self.extracted_text,
            "media_blocks": self.media_blocks.iter().map(WireBlock::to_json).collect::<Vec<_>>(),
            "transcript_lines": self.transcript_lines,
            "page_count": self.page_count,
            "width": self.width,
            "height": self.height,
            "duration_ms": self.duration_ms,
        })
    }

    pub fn from_json(value: &Value) -> Result<Self, String> {
        let mut media_blocks = Vec::new();
        if let Some(arr) = value.get("media_blocks").and_then(Value::as_array) {
            for b in arr {
                media_blocks.push(WireBlock::from_json(b)?);
            }
        }
        let transcript_lines = value
            .get("transcript_lines")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default();
        Ok(Self {
            summary_text: value
                .get("summary_text")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            extracted_text: value
                .get("extracted_text")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            media_blocks,
            transcript_lines,
            page_count: value
                .get("page_count")
                .and_then(Value::as_u64)
                .and_then(|v| u32::try_from(v).ok())
                .unwrap_or(0),
            width: value
                .get("width")
                .and_then(Value::as_u64)
                .and_then(|v| u32::try_from(v).ok())
                .unwrap_or(0),
            height: value
                .get("height")
                .and_then(Value::as_u64)
                .and_then(|v| u32::try_from(v).ok())
                .unwrap_or(0),
            duration_ms: value
                .get("duration_ms")
                .and_then(Value::as_u64)
                .unwrap_or(0),
        })
    }
}

/// Raw incoming attachment prior to classification and insertion into [`RichComposer`].
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct IncomingAttachment {
    pub display_name: String,
    pub source_path: String,
    pub mime_type: String,
    pub raw_bytes: Vec<u8>,
}

impl IncomingAttachment {
    #[must_use]
    pub fn classify_media_kind(&self) -> AttachmentMediaKind {
        let bytes = self.raw_bytes.as_slice();
        if bytes.starts_with(b"\x89PNG\r\n\x1A\n") {
            return AttachmentMediaKind::ImagePng;
        }
        if bytes.starts_with(b"\xFF\xD8\xFF") {
            return AttachmentMediaKind::ImageJpeg;
        }
        if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
            return AttachmentMediaKind::ImageWebp;
        }
        if bytes.starts_with(b"%PDF-") {
            return AttachmentMediaKind::Pdf;
        }
        if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WAVE" {
            return AttachmentMediaKind::AudioWav;
        }
        if bytes.len() >= 8 && &bytes[4..8] == b"ftyp" {
            return AttachmentMediaKind::VideoMp4;
        }

        let mime = self.mime_type.to_ascii_lowercase();
        let ext = Path::new(&self.display_name)
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();

        if mime == "image/png" || ext == "png" {
            return AttachmentMediaKind::ImagePng;
        }
        if mime == "image/jpeg" || mime == "image/jpg" || ext == "jpg" || ext == "jpeg" {
            return AttachmentMediaKind::ImageJpeg;
        }
        if mime == "image/webp" || ext == "webp" {
            return AttachmentMediaKind::ImageWebp;
        }
        if mime == "application/pdf" || ext == "pdf" {
            return AttachmentMediaKind::Pdf;
        }
        if mime == "audio/wav" || mime == "audio/x-wav" || ext == "wav" {
            return AttachmentMediaKind::AudioWav;
        }
        if mime == "video/mp4" || ext == "mp4" {
            return AttachmentMediaKind::VideoMp4;
        }
        if mime.starts_with("text/")
            || mime == "application/json"
            || matches!(
                ext.as_str(),
                "txt"
                    | "md"
                    | "json"
                    | "csv"
                    | "rs"
                    | "cpp"
                    | "hpp"
                    | "py"
                    | "js"
                    | "toml"
                    | "yaml"
            )
            || (!bytes.is_empty() && !bytes.contains(&0) && is_valid_utf8(bytes))
        {
            return AttachmentMediaKind::PlainText;
        }
        AttachmentMediaKind::Unsupported
    }
}

/// Stored payload record shared by inline references and tray items inside [`RichComposer`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttachmentPayload {
    pub attachment_id: String,
    pub display_name: String,
    pub source_path: String,
    pub mime_type: String,
    pub media_kind: AttachmentMediaKind,
    pub byte_size: usize,
    pub sha256_hex: String,
    pub raw_bytes: Vec<u8>,
    pub status: ConversionStatus,
    pub error_message: String,
    pub failure_acknowledged: bool,
    pub derived: DerivedRepresentation,
}

impl AttachmentPayload {
    #[must_use]
    pub fn from_incoming(incoming: &IncomingAttachment, attachment_id: String) -> Self {
        let media_kind = incoming.classify_media_kind();
        let mime_type = if incoming.mime_type.trim().is_empty() {
            media_kind.default_mime().to_owned()
        } else {
            incoming.mime_type.clone()
        };
        let digest = sha256_hex(&incoming.raw_bytes);
        let mut derived = DerivedRepresentation::default();
        let mut status = ConversionStatus::Ready;
        let mut error_message = String::new();

        match media_kind {
            AttachmentMediaKind::ImagePng
            | AttachmentMediaKind::ImageJpeg
            | AttachmentMediaKind::ImageWebp => {
                let b64 = base64_encode(&incoming.raw_bytes);
                derived.media_blocks.push(WireBlock::Image {
                    media_type: mime_type.clone(),
                    data: b64,
                });
                derived.summary_text = format!(
                    "Image `{}` ({} bytes)",
                    incoming.display_name,
                    incoming.raw_bytes.len()
                );
            }
            AttachmentMediaKind::PlainText => {
                let text = sanitize_utf8_lossy(&incoming.raw_bytes);
                derived.extracted_text = text;
                derived.summary_text = format!(
                    "Text `{}` ({} bytes)",
                    incoming.display_name,
                    incoming.raw_bytes.len()
                );
            }
            AttachmentMediaKind::Pdf => {
                let insp = ComposerModel::inspect_pdf_bytes(&incoming.raw_bytes);
                if insp.is_encrypted {
                    status = ConversionStatus::Failed;
                    error_message = insp.status;
                } else {
                    status = ConversionStatus::Converting;
                    derived.summary_text = format!("PDF `{}`", incoming.display_name);
                }
            }
            AttachmentMediaKind::AudioWav | AttachmentMediaKind::VideoMp4 => {
                status = ConversionStatus::Converting;
                derived.summary_text =
                    format!("{} `{}`", media_kind.as_str(), incoming.display_name);
            }
            AttachmentMediaKind::Unsupported => {
                status = ConversionStatus::Failed;
                error_message = format!(
                    "UNREADABLE: unsupported attachment `{}`",
                    incoming.display_name
                );
            }
        }

        Self {
            attachment_id,
            display_name: incoming.display_name.clone(),
            source_path: incoming.source_path.clone(),
            mime_type,
            media_kind,
            byte_size: incoming.raw_bytes.len(),
            sha256_hex: digest,
            raw_bytes: incoming.raw_bytes.clone(),
            status,
            error_message,
            failure_acknowledged: false,
            derived,
        }
    }

    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "attachment_id": self.attachment_id,
            "display_name": self.display_name,
            "source_path": self.source_path,
            "mime_type": self.mime_type,
            "media_kind": self.media_kind.as_str(),
            "byte_size": self.byte_size,
            "sha256_hex": self.sha256_hex,
            "raw_bytes_hex": hex_encode(&self.raw_bytes),
            "status": self.status.as_str(),
            "error_message": self.error_message,
            "failure_acknowledged": self.failure_acknowledged,
            "derived": self.derived.to_json(),
        })
    }

    pub fn from_json(value: &Value) -> Result<Self, String> {
        let raw_hex = value
            .get("raw_bytes_hex")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let raw_bytes = hex_decode(raw_hex).map_err(|e| format!("invalid hex payload: {e:?}"))?;
        let derived = match value.get("derived") {
            Some(d) => DerivedRepresentation::from_json(d)?,
            None => DerivedRepresentation::default(),
        };
        Ok(Self {
            attachment_id: value
                .get("attachment_id")
                .and_then(Value::as_str)
                .ok_or_else(|| "attachment missing attachment_id".to_owned())?
                .to_owned(),
            display_name: value
                .get("display_name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            source_path: value
                .get("source_path")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            mime_type: value
                .get("mime_type")
                .and_then(Value::as_str)
                .unwrap_or("application/octet-stream")
                .to_owned(),
            media_kind: AttachmentMediaKind::from_label(
                value
                    .get("media_kind")
                    .and_then(Value::as_str)
                    .unwrap_or("Unsupported"),
            ),
            byte_size: value
                .get("byte_size")
                .and_then(Value::as_u64)
                .and_then(|v| usize::try_from(v).ok())
                .unwrap_or(raw_bytes.len()),
            sha256_hex: value
                .get("sha256_hex")
                .and_then(Value::as_str)
                .map_or_else(|| sha256_hex(&raw_bytes), str::to_owned),
            raw_bytes,
            status: ConversionStatus::from_label(
                value
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("Ready"),
            ),
            error_message: value
                .get("error_message")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            failure_acknowledged: value
                .get("failure_acknowledged")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            derived,
        })
    }
}

/// Entry stored inside the non-inline attachment tray.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrayAttachmentRef {
    pub attachment_id: String,
    pub display_name: String,
    pub media_kind: AttachmentMediaKind,
    pub sha256_hex: String,
}

impl TrayAttachmentRef {
    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "attachment_id": self.attachment_id,
            "display_name": self.display_name,
            "media_kind": self.media_kind.as_str(),
            "sha256_hex": self.sha256_hex,
        })
    }

    pub fn from_json(value: &Value) -> Result<Self, String> {
        Ok(Self {
            attachment_id: value
                .get("attachment_id")
                .and_then(Value::as_str)
                .ok_or_else(|| "tray ref missing attachment_id".to_owned())?
                .to_owned(),
            display_name: value
                .get("display_name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            media_kind: AttachmentMediaKind::from_label(
                value
                    .get("media_kind")
                    .and_then(Value::as_str)
                    .unwrap_or("Unsupported"),
            ),
            sha256_hex: value
                .get("sha256_hex")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
        })
    }
}

/// Interactive resolution choice for dual-mode paste confirmation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttachmentChoice {
    InlineAtCaret,
    MoveToTray,
    Cancel,
}

/// Staged paste request awaiting user placement confirmation without mutating the draft.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingPastePrompt {
    pub incoming: IncomingAttachment,
    pub caret_anchor: DocumentAnchor,
}

/// Target surface during drag-and-drop gestures.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum DropZone {
    #[default]
    None,
    InlineEditorCaret,
    AttachmentTray,
}

/// Visual drop indicator state computed on drag-over.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct DropIndicator {
    pub zone: DropZone,
    pub caret_anchor: DocumentAnchor,
    pub highlight_label: String,
}

/// Gate result computed before allowing a prompt submission.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SendReadiness {
    pub ready: bool,
    pub has_sendable_content: bool,
    pub converting_count: usize,
    pub unacknowledged_failed_count: usize,
    pub blocking_reasons: Vec<String>,
}

/// Rendered Markdown preview output + extracted LaTeX expressions.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct LivePreviewOutput {
    pub markdown_text: String,
    pub math_expressions: Vec<String>,
    pub attachment_badges: Vec<String>,
}

/// Metadata entry describing an attachment packaged inside a serialized provider turn.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UploadManifestEntry {
    pub attachment_id: String,
    pub display_name: String,
    pub mime_type: String,
    pub sha256_hex: String,
    pub byte_size: usize,
    pub placement: &'static str,
}

/// Final provider-ready turn output produced by [`RichComposer::serialize_for_provider`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SerializedComposerTurn {
    pub message: WireMessage,
    pub rendered_markdown: String,
    pub upload_manifest: Vec<UploadManifestEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ComposerSnapshot {
    document: Vec<ComposerNode>,
    attachments: BTreeMap<String, AttachmentPayload>,
    tray: Vec<TrayAttachmentRef>,
    caret: DocumentAnchor,
}

/// Native rich scientific & multimodal prompt composer with undo/redo, dual-mode
/// attachments, Markdown tables, LaTeX templates, send gating, and atomic LF persistence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RichComposer {
    document: Vec<ComposerNode>,
    attachments: BTreeMap<String, AttachmentPayload>,
    tray: Vec<TrayAttachmentRef>,
    caret: DocumentAnchor,
    pending_paste: Option<PendingPastePrompt>,
    drop_indicator: DropIndicator,
    undo_stack: Vec<ComposerSnapshot>,
    redo_stack: Vec<ComposerSnapshot>,
    next_attachment_seq: u64,
}

impl Default for RichComposer {
    fn default() -> Self {
        Self::new()
    }
}

impl RichComposer {
    #[must_use]
    pub fn new() -> Self {
        Self {
            document: Vec::new(),
            attachments: BTreeMap::new(),
            tray: Vec::new(),
            caret: DocumentAnchor::default(),
            pending_paste: None,
            drop_indicator: DropIndicator::default(),
            undo_stack: Vec::new(),
            redo_stack: Vec::new(),
            next_attachment_seq: 1,
        }
    }

    #[must_use]
    pub fn document(&self) -> &[ComposerNode] {
        &self.document
    }

    #[must_use]
    pub fn attachments(&self) -> &BTreeMap<String, AttachmentPayload> {
        &self.attachments
    }

    #[must_use]
    pub fn tray(&self) -> &[TrayAttachmentRef] {
        &self.tray
    }

    #[must_use]
    pub fn caret(&self) -> DocumentAnchor {
        self.caret
    }

    #[must_use]
    pub fn pending_paste(&self) -> Option<&PendingPastePrompt> {
        self.pending_paste.as_ref()
    }

    #[must_use]
    pub fn drop_indicator(&self) -> &DropIndicator {
        &self.drop_indicator
    }

    #[must_use]
    pub fn undo_depth(&self) -> usize {
        self.undo_stack.len()
    }

    #[must_use]
    pub fn redo_depth(&self) -> usize {
        self.redo_stack.len()
    }

    pub fn set_caret(&mut self, anchor: DocumentAnchor) {
        let clamped_node = anchor.node_index.min(self.document.len());
        let clamped_cp = match self.document.get(clamped_node) {
            Some(ComposerNode::TextSpan { text, .. }) => {
                anchor.codepoint_offset.min(text.chars().count())
            }
            _ => 0,
        };
        self.caret = DocumentAnchor {
            node_index: clamped_node,
            codepoint_offset: clamped_cp,
        };
    }

    pub fn set_plain_text(&mut self, text: impl Into<String>) {
        self.push_undo_snapshot();
        let s = text.into();
        let cp = s.chars().count();
        self.document.clear();
        if !s.is_empty() {
            self.document.push(ComposerNode::TextSpan {
                text: s,
                style: TextStyle::default(),
            });
            self.caret = DocumentAnchor {
                node_index: 0,
                codepoint_offset: cp,
            };
        } else {
            self.caret = DocumentAnchor::default();
        }
    }

    pub fn insert_text(&mut self, text: &str, style: TextStyle) {
        if text.is_empty() {
            return;
        }
        self.push_undo_snapshot();
        self.insert_text_at_caret_no_undo(text, style);
    }

    pub fn insert_symbol_at_caret(&mut self, symbol_id: &str) -> bool {
        let Some(item) = symbol_palette().into_iter().find(|p| p.id == symbol_id) else {
            return false;
        };
        self.push_undo_snapshot();
        let snippet = if item.display_mode {
            format!("$${}$$", item.latex)
        } else {
            format!("${}$", item.latex)
        };
        let style = TextStyle {
            inline_math: !item.display_mode,
            block_format: if item.display_mode {
                BlockFormat::DisplayMath
            } else {
                BlockFormat::Paragraph
            },
            ..TextStyle::default()
        };
        self.insert_text_at_caret_no_undo(&snippet, style);
        true
    }

    pub fn insert_table(&mut self, table: ComposerTable) {
        self.push_undo_snapshot();
        let idx = self.caret.node_index.min(self.document.len());
        self.document.insert(idx, ComposerNode::Table(table));
        self.caret = DocumentAnchor {
            node_index: idx + 1,
            codepoint_offset: 0,
        };
    }

    /// Stage an incoming paste without mutating document, tray, or undo history.
    pub fn begin_paste(&mut self, incoming: IncomingAttachment, caret_anchor: DocumentAnchor) {
        self.pending_paste = Some(PendingPastePrompt {
            incoming,
            caret_anchor,
        });
    }

    /// Resolve a staged paste prompt. `AttachmentChoice::Cancel` leaves zero mutations.
    pub fn resolve_paste(&mut self, choice: AttachmentChoice) -> Option<String> {
        let pending = self.pending_paste.take()?;
        match choice {
            AttachmentChoice::Cancel => None,
            AttachmentChoice::InlineAtCaret => {
                let ids =
                    self.insert_attachments_inline(vec![pending.incoming], pending.caret_anchor);
                ids.into_iter().next()
            }
            AttachmentChoice::MoveToTray => {
                let ids = self.add_attachments_to_tray(vec![pending.incoming]);
                ids.into_iter().next()
            }
        }
    }

    pub fn handle_drag_over(&mut self, zone: DropZone, caret_anchor: DocumentAnchor) {
        let label = match zone {
            DropZone::None => String::new(),
            DropZone::InlineEditorCaret => "Insert Inline at Caret".to_owned(),
            DropZone::AttachmentTray => "Add to Attachment Tray".to_owned(),
        };
        self.drop_indicator = DropIndicator {
            zone,
            caret_anchor,
            highlight_label: label,
        };
    }

    pub fn handle_drop(
        &mut self,
        zone: DropZone,
        attachments: Vec<IncomingAttachment>,
        caret_anchor: DocumentAnchor,
    ) -> Vec<String> {
        self.drop_indicator = DropIndicator::default();
        match zone {
            DropZone::None => Vec::new(),
            DropZone::InlineEditorCaret => {
                self.insert_attachments_inline(attachments, caret_anchor)
            }
            DropZone::AttachmentTray => self.add_attachments_to_tray(attachments),
        }
    }

    pub fn insert_attachments_inline(
        &mut self,
        incoming_list: Vec<IncomingAttachment>,
        anchor: DocumentAnchor,
    ) -> Vec<String> {
        if incoming_list.is_empty() {
            return Vec::new();
        }
        self.push_undo_snapshot();
        self.set_caret(anchor);

        let mut inserted_ids = Vec::with_capacity(incoming_list.len());
        let mut insert_pos = self.caret.node_index.min(self.document.len());

        // Split existing TextSpan if inserting mid-span
        if let Some(ComposerNode::TextSpan { text, style }) = self.document.get(insert_pos).cloned()
        {
            let cp = self.caret.codepoint_offset.min(text.chars().count());
            if cp == 0 {
                // Insert before this span
            } else if cp >= text.chars().count() {
                insert_pos += 1;
            } else {
                let byte_idx = text
                    .char_indices()
                    .nth(cp)
                    .map_or(text.len(), |(idx, _)| idx);
                let left = text[..byte_idx].to_owned();
                let right = text[byte_idx..].to_owned();
                self.document[insert_pos] = ComposerNode::TextSpan { text: left, style };
                self.document.insert(
                    insert_pos + 1,
                    ComposerNode::TextSpan { text: right, style },
                );
                insert_pos += 1;
            }
        }

        for incoming in incoming_list {
            let id = self.allocate_or_reuse_payload(&incoming);
            self.document.insert(
                insert_pos,
                ComposerNode::InlineAttachment {
                    attachment_id: id.clone(),
                },
            );
            insert_pos += 1;
            inserted_ids.push(id);
        }

        self.caret = DocumentAnchor {
            node_index: insert_pos,
            codepoint_offset: 0,
        };
        inserted_ids
    }

    pub fn add_attachments_to_tray(
        &mut self,
        incoming_list: Vec<IncomingAttachment>,
    ) -> Vec<String> {
        if incoming_list.is_empty() {
            return Vec::new();
        }
        self.push_undo_snapshot();
        let mut ids = Vec::with_capacity(incoming_list.len());
        for incoming in incoming_list {
            let id = self.allocate_or_reuse_payload(&incoming);
            if !self.tray.iter().any(|t| t.attachment_id == id) {
                if let Some(payload) = self.attachments.get(&id) {
                    self.tray.push(TrayAttachmentRef {
                        attachment_id: id.clone(),
                        display_name: payload.display_name.clone(),
                        media_kind: payload.media_kind,
                        sha256_hex: payload.sha256_hex.clone(),
                    });
                }
            }
            ids.push(id);
        }
        ids
    }

    pub fn move_inline_to_tray(&mut self, attachment_id: &str) -> bool {
        let has_inline = self.document.iter().any(|node| {
            matches!(
                node,
                ComposerNode::InlineAttachment { attachment_id: id } if id == attachment_id
            )
        });
        if !has_inline {
            return false;
        }
        self.push_undo_snapshot();
        self.document.retain(|node| {
            !matches!(
                node,
                ComposerNode::InlineAttachment { attachment_id: id } if id == attachment_id
            )
        });
        if !self.tray.iter().any(|t| t.attachment_id == attachment_id) {
            if let Some(payload) = self.attachments.get(attachment_id) {
                self.tray.push(TrayAttachmentRef {
                    attachment_id: payload.attachment_id.clone(),
                    display_name: payload.display_name.clone(),
                    media_kind: payload.media_kind,
                    sha256_hex: payload.sha256_hex.clone(),
                });
            }
        }
        self.clamp_caret();
        true
    }

    pub fn copy_tray_to_inline(&mut self, attachment_id: &str, anchor: DocumentAnchor) -> bool {
        if !self.tray.iter().any(|t| t.attachment_id == attachment_id) {
            return false;
        }
        if !self.attachments.contains_key(attachment_id) {
            return false;
        }
        self.push_undo_snapshot();
        let idx = anchor.node_index.min(self.document.len());
        self.document.insert(
            idx,
            ComposerNode::InlineAttachment {
                attachment_id: attachment_id.to_owned(),
            },
        );
        self.caret = DocumentAnchor {
            node_index: idx + 1,
            codepoint_offset: 0,
        };
        true
    }

    pub fn remove_inline(&mut self, attachment_id: &str) -> bool {
        let before = self.document.len();
        self.push_undo_snapshot();
        self.document.retain(|node| {
            !matches!(
                node,
                ComposerNode::InlineAttachment { attachment_id: id } if id == attachment_id
            )
        });
        if self.document.len() == before {
            self.undo_stack.pop();
            return false;
        }
        self.gc_unreferenced_payload(attachment_id);
        self.clamp_caret();
        true
    }

    pub fn remove_from_tray(&mut self, attachment_id: &str) -> bool {
        let before = self.tray.len();
        self.push_undo_snapshot();
        self.tray.retain(|t| t.attachment_id != attachment_id);
        if self.tray.len() == before {
            self.undo_stack.pop();
            return false;
        }
        self.gc_unreferenced_payload(attachment_id);
        true
    }

    pub fn complete_attachment_conversion(
        &mut self,
        attachment_id: &str,
        derived: DerivedRepresentation,
    ) -> bool {
        let Some(att) = self.attachments.get_mut(attachment_id) else {
            return false;
        };
        att.status = ConversionStatus::Ready;
        att.error_message.clear();
        att.failure_acknowledged = false;
        att.derived = derived;
        true
    }

    pub fn fail_attachment_conversion(
        &mut self,
        attachment_id: &str,
        error_message: impl Into<String>,
    ) -> bool {
        let Some(att) = self.attachments.get_mut(attachment_id) else {
            return false;
        };
        att.status = ConversionStatus::Failed;
        att.error_message = error_message.into();
        att.failure_acknowledged = false;
        true
    }

    pub fn cancel_attachment_conversion(&mut self, attachment_id: &str) -> bool {
        let Some(att) = self.attachments.get_mut(attachment_id) else {
            return false;
        };
        att.status = ConversionStatus::Cancelled;
        att.error_message = "Conversion cancelled by user".to_owned();
        true
    }

    pub fn retry_attachment_conversion(&mut self, attachment_id: &str) -> bool {
        let Some(att) = self.attachments.get_mut(attachment_id) else {
            return false;
        };
        if !matches!(
            att.status,
            ConversionStatus::Failed | ConversionStatus::Cancelled
        ) {
            return false;
        }
        att.status = ConversionStatus::Converting;
        att.error_message.clear();
        att.failure_acknowledged = false;
        true
    }

    pub fn acknowledge_failed_conversion(&mut self, attachment_id: &str) -> bool {
        let Some(att) = self.attachments.get_mut(attachment_id) else {
            return false;
        };
        if att.status != ConversionStatus::Failed {
            return false;
        }
        att.failure_acknowledged = true;
        true
    }

    pub fn undo(&mut self) -> bool {
        let Some(prev) = self.undo_stack.pop() else {
            return false;
        };
        self.redo_stack.push(self.capture_snapshot());
        self.restore_snapshot(prev);
        true
    }

    pub fn redo(&mut self) -> bool {
        let Some(next) = self.redo_stack.pop() else {
            return false;
        };
        self.undo_stack.push(self.capture_snapshot());
        self.restore_snapshot(next);
        true
    }

    #[must_use]
    pub fn evaluate_send_readiness(&self) -> SendReadiness {
        let mut converting_count = 0usize;
        let mut unacknowledged_failed_count = 0usize;
        let mut blocking_reasons = Vec::new();
        let mut has_sendable_content = false;

        for node in &self.document {
            match node {
                ComposerNode::TextSpan { text, .. } => {
                    if !text.trim().is_empty() {
                        has_sendable_content = true;
                    }
                }
                ComposerNode::Table(_) => {
                    has_sendable_content = true;
                }
                ComposerNode::InlineAttachment { attachment_id } => {
                    if let Some(att) = self.attachments.get(attachment_id) {
                        match att.status {
                            ConversionStatus::Ready => has_sendable_content = true,
                            ConversionStatus::Converting => {
                                converting_count += 1;
                                blocking_reasons.push(format!(
                                    "Inline attachment `{}` is still converting",
                                    att.display_name
                                ));
                            }
                            ConversionStatus::Failed => {
                                if att.failure_acknowledged {
                                    has_sendable_content = true;
                                } else {
                                    unacknowledged_failed_count += 1;
                                    blocking_reasons.push(format!(
                                        "Inline attachment `{}` failed: {}",
                                        att.display_name, att.error_message
                                    ));
                                }
                            }
                            ConversionStatus::Cancelled => {}
                        }
                    }
                }
            }
        }

        for tray_ref in &self.tray {
            if let Some(att) = self.attachments.get(&tray_ref.attachment_id) {
                match att.status {
                    ConversionStatus::Ready => has_sendable_content = true,
                    ConversionStatus::Converting => {
                        converting_count += 1;
                        blocking_reasons.push(format!(
                            "Tray attachment `{}` is still converting",
                            att.display_name
                        ));
                    }
                    ConversionStatus::Failed => {
                        if att.failure_acknowledged {
                            has_sendable_content = true;
                        } else {
                            unacknowledged_failed_count += 1;
                            blocking_reasons.push(format!(
                                "Tray attachment `{}` failed: {}",
                                att.display_name, att.error_message
                            ));
                        }
                    }
                    ConversionStatus::Cancelled => {}
                }
            }
        }

        if !has_sendable_content && blocking_reasons.is_empty() {
            blocking_reasons.push("Composer draft has no sendable content".to_owned());
        }

        SendReadiness {
            ready: has_sendable_content
                && converting_count == 0
                && unacknowledged_failed_count == 0,
            has_sendable_content,
            converting_count,
            unacknowledged_failed_count,
            blocking_reasons,
        }
    }

    #[must_use]
    pub fn render_live_preview(&self) -> LivePreviewOutput {
        let mut parts = Vec::new();
        let mut math_expressions = Vec::new();
        let mut attachment_badges = Vec::new();

        for node in &self.document {
            match node {
                ComposerNode::TextSpan { text, style } => {
                    if style.inline_math || style.block_format == BlockFormat::DisplayMath {
                        math_expressions.push(text.clone());
                    }
                    parts.push(render_styled_text(text, *style));
                }
                ComposerNode::Table(table) => {
                    parts.push(format!("\n{}\n", table.to_markdown()));
                }
                ComposerNode::InlineAttachment { attachment_id } => {
                    if let Some(att) = self.attachments.get(attachment_id) {
                        let badge =
                            format!("[Inline: {} ({})]", att.display_name, att.status.as_str());
                        attachment_badges.push(badge.clone());
                        parts.push(badge);
                    }
                }
            }
        }

        let markdown_text = parts.concat();
        for expr in extract_math_segments(&markdown_text) {
            if !math_expressions.contains(&expr) {
                math_expressions.push(expr);
            }
        }

        LivePreviewOutput {
            markdown_text,
            math_expressions,
            attachment_badges,
        }
    }

    pub fn serialize_for_provider(&self, role: &str) -> Result<SerializedComposerTurn, String> {
        let readiness = self.evaluate_send_readiness();
        if !readiness.ready {
            return Err(readiness.blocking_reasons.join("; "));
        }

        let mut text_sections = Vec::new();
        let mut blocks = Vec::new();
        let mut upload_manifest = Vec::new();
        let mut seen_attachment_blocks = HashMap::<String, ()>::new();

        for node in &self.document {
            match node {
                ComposerNode::TextSpan { text, style } => {
                    text_sections.push(render_styled_text(text, *style));
                }
                ComposerNode::Table(table) => {
                    text_sections.push(format!("\n{}\n", table.to_markdown()));
                }
                ComposerNode::InlineAttachment { attachment_id } => {
                    if let Some(att) = self.attachments.get(attachment_id) {
                        if att.status == ConversionStatus::Cancelled {
                            continue;
                        }
                        text_sections.push(format!("[attachment:{}]", att.display_name));
                        if seen_attachment_blocks
                            .insert(att.attachment_id.clone(), ())
                            .is_none()
                        {
                            append_attachment_wire_content(
                                att,
                                "inline",
                                &mut text_sections,
                                &mut blocks,
                                &mut upload_manifest,
                            );
                        }
                    }
                }
            }
        }

        for tray_ref in &self.tray {
            if let Some(att) = self.attachments.get(&tray_ref.attachment_id) {
                if att.status == ConversionStatus::Cancelled {
                    continue;
                }
                if seen_attachment_blocks
                    .insert(att.attachment_id.clone(), ())
                    .is_none()
                {
                    append_attachment_wire_content(
                        att,
                        "tray",
                        &mut text_sections,
                        &mut blocks,
                        &mut upload_manifest,
                    );
                }
            }
        }

        let rendered_markdown = text_sections.concat();
        let mut final_content = Vec::with_capacity(blocks.len() + 1);
        if !rendered_markdown.trim().is_empty() {
            final_content.push(WireBlock::Text {
                text: rendered_markdown.clone(),
            });
        }
        final_content.extend(blocks);

        Ok(SerializedComposerTurn {
            message: WireMessage {
                role: role.to_owned(),
                content: final_content,
            },
            rendered_markdown,
            upload_manifest,
        })
    }

    pub fn save_to_path(&self, path: &Path) -> Result<(), String> {
        let payload = json!({
            "version": 1,
            "caret": self.caret.to_json(),
            "next_attachment_seq": self.next_attachment_seq,
            "document": self.document.iter().map(ComposerNode::to_json).collect::<Vec<_>>(),
            "attachments": self.attachments.values().map(AttachmentPayload::to_json).collect::<Vec<_>>(),
            "tray": self.tray.iter().map(TrayAttachmentRef::to_json).collect::<Vec<_>>(),
        });
        let encoded_json =
            serde_json::to_string_pretty(&payload).map_err(|e| format!("serialize draft: {e}"))?;
        let normalized_lf = format!(
            "{DRAFT_MAGIC_HEADER}\n{}\n",
            encoded_json.replace("\r\n", "\n")
        );

        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent).map_err(|e| format!("create draft dir: {e}"))?;
            }
        }
        let tmp_path = path.with_extension(format!("tmp.{}", uuid_v4()));
        fs::write(&tmp_path, normalized_lf.as_bytes())
            .map_err(|e| format!("write tmp draft: {e}"))?;
        if path.exists() {
            let _ = fs::remove_file(path);
        }
        fs::rename(&tmp_path, path).map_err(|e| format!("rename tmp draft: {e}"))?;
        Ok(())
    }

    pub fn load_from_path(path: &Path) -> Result<Self, String> {
        let bytes = fs::read(path).map_err(|e| format!("read draft: {e}"))?;
        let raw = String::from_utf8(bytes).map_err(|e| format!("invalid UTF-8 draft: {e}"))?;
        let normalized = raw.replace("\r\n", "\n");
        let Some((header, body)) = normalized.split_once('\n') else {
            return Err("missing draft header".to_owned());
        };
        if header.trim() != DRAFT_MAGIC_HEADER {
            return Err(format!("unexpected draft header `{header}`"));
        }
        let val: Value =
            serde_json::from_str(body).map_err(|e| format!("invalid draft JSON: {e}"))?;
        let mut composer = Self::new();
        composer.next_attachment_seq = val
            .get("next_attachment_seq")
            .and_then(Value::as_u64)
            .unwrap_or(1);
        if let Some(docs) = val.get("document").and_then(Value::as_array) {
            for item in docs {
                composer.document.push(ComposerNode::from_json(item)?);
            }
        }
        if let Some(atts) = val.get("attachments").and_then(Value::as_array) {
            for item in atts {
                let att = AttachmentPayload::from_json(item)?;
                composer.attachments.insert(att.attachment_id.clone(), att);
            }
        }
        if let Some(tray) = val.get("tray").and_then(Value::as_array) {
            for item in tray {
                composer.tray.push(TrayAttachmentRef::from_json(item)?);
            }
        }
        if let Some(caret) = val.get("caret") {
            let anchor = DocumentAnchor {
                node_index: caret
                    .get("node_index")
                    .and_then(Value::as_u64)
                    .and_then(|v| usize::try_from(v).ok())
                    .unwrap_or(0),
                codepoint_offset: caret
                    .get("codepoint_offset")
                    .and_then(Value::as_u64)
                    .and_then(|v| usize::try_from(v).ok())
                    .unwrap_or(0),
            };
            composer.set_caret(anchor);
        }
        Ok(composer)
    }

    fn allocate_or_reuse_payload(&mut self, incoming: &IncomingAttachment) -> String {
        let digest = sha256_hex(&incoming.raw_bytes);
        if let Some(existing) = self
            .attachments
            .values()
            .find(|a| a.sha256_hex == digest && a.display_name == incoming.display_name)
        {
            return existing.attachment_id.clone();
        }
        let id = format!("att-{}", self.next_attachment_seq);
        self.next_attachment_seq = self.next_attachment_seq.saturating_add(1);
        let payload = AttachmentPayload::from_incoming(incoming, id.clone());
        self.attachments.insert(id.clone(), payload);
        id
    }

    fn gc_unreferenced_payload(&mut self, attachment_id: &str) {
        let still_inline = self.document.iter().any(|node| {
            matches!(
                node,
                ComposerNode::InlineAttachment { attachment_id: id } if id == attachment_id
            )
        });
        let still_tray = self.tray.iter().any(|t| t.attachment_id == attachment_id);
        if !still_inline && !still_tray {
            self.attachments.remove(attachment_id);
        }
    }

    fn insert_text_at_caret_no_undo(&mut self, text: &str, style: TextStyle) {
        let idx = self.caret.node_index.min(self.document.len());
        if let Some(ComposerNode::TextSpan {
            text: existing,
            style: existing_style,
        }) = self.document.get_mut(idx)
        {
            if *existing_style == style {
                let byte_idx = existing
                    .char_indices()
                    .nth(self.caret.codepoint_offset)
                    .map_or(existing.len(), |(b, _)| b);
                existing.insert_str(byte_idx, text);
                self.caret.codepoint_offset += text.chars().count();
                return;
            }
        }
        let cp = text.chars().count();
        self.document.insert(
            idx,
            ComposerNode::TextSpan {
                text: text.to_owned(),
                style,
            },
        );
        self.caret = DocumentAnchor {
            node_index: idx,
            codepoint_offset: cp,
        };
    }

    fn clamp_caret(&mut self) {
        let anchor = self.caret;
        self.set_caret(anchor);
    }

    fn capture_snapshot(&self) -> ComposerSnapshot {
        ComposerSnapshot {
            document: self.document.clone(),
            attachments: self.attachments.clone(),
            tray: self.tray.clone(),
            caret: self.caret,
        }
    }

    fn restore_snapshot(&mut self, snap: ComposerSnapshot) {
        self.document = snap.document;
        self.attachments = snap.attachments;
        self.tray = snap.tray;
        self.caret = snap.caret;
    }

    fn push_undo_snapshot(&mut self) {
        if self.undo_stack.len() >= MAX_UNDO_DEPTH {
            self.undo_stack.remove(0);
        }
        self.undo_stack.push(self.capture_snapshot());
        self.redo_stack.clear();
    }
}

fn render_styled_text(text: &str, style: TextStyle) -> String {
    let mut s = text.to_owned();
    if style.inline_code && !s.starts_with('`') {
        s = format!("`{s}`");
    }
    if style.bold && !s.starts_with("**") {
        s = format!("**{s}**");
    }
    if style.italic && !s.starts_with('*') {
        s = format!("*{s}*");
    }
    if style.strikethrough && !s.starts_with("~~") {
        s = format!("~~{s}~~");
    }
    match style.block_format {
        BlockFormat::Paragraph | BlockFormat::DisplayMath => s,
        BlockFormat::Heading1 => format!("# {s}"),
        BlockFormat::Heading2 => format!("## {s}"),
        BlockFormat::Heading3 => format!("### {s}"),
        BlockFormat::BulletList => format!("- {s}"),
        BlockFormat::OrderedList => format!("1. {s}"),
        BlockFormat::BlockQuote => format!("> {s}"),
        BlockFormat::CodeBlock => format!("```\n{s}\n```"),
    }
}

fn extract_math_segments(markdown: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = markdown;
    while let Some(pos) = rest.find("$$") {
        let after = &rest[pos + 2..];
        let Some(end) = after.find("$$") else {
            break;
        };
        let expr = after[..end].trim();
        if !expr.is_empty() {
            out.push(expr.to_owned());
        }
        rest = &after[end + 2..];
    }
    out
}

fn append_attachment_wire_content(
    att: &AttachmentPayload,
    placement: &'static str,
    text_sections: &mut Vec<String>,
    blocks: &mut Vec<WireBlock>,
    manifest: &mut Vec<UploadManifestEntry>,
) {
    manifest.push(UploadManifestEntry {
        attachment_id: att.attachment_id.clone(),
        display_name: att.display_name.clone(),
        mime_type: att.mime_type.clone(),
        sha256_hex: att.sha256_hex.clone(),
        byte_size: att.byte_size,
        placement,
    });
    if att.status == ConversionStatus::Failed && att.failure_acknowledged {
        text_sections.push(format!(
            "\n[Attachment `{}` unavailable: {}]\n",
            att.display_name, att.error_message
        ));
        return;
    }
    if !att.derived.extracted_text.is_empty() {
        text_sections.push(format!(
            "\n--- Begin attachment: {} ---\n{}\n--- End attachment ---\n",
            att.display_name, att.derived.extracted_text
        ));
    } else if !att.derived.summary_text.is_empty() && att.derived.media_blocks.is_empty() {
        text_sections.push(format!(
            "\n[Attachment summary ({}): {}]\n",
            att.display_name, att.derived.summary_text
        ));
    }
    if !att.derived.transcript_lines.is_empty() {
        text_sections.push(format!(
            "\n[Transcript ({})]\n{}\n",
            att.display_name,
            att.derived.transcript_lines.join("\n")
        ));
    }
    for mb in &att.derived.media_blocks {
        blocks.push(mb.clone());
    }
}
