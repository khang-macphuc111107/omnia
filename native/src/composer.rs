//! Native rich composer, Math/Physics/Chemistry symbol palette, and dual-mode
//! (inline-at-caret + tray) content-addressed attachment engine.
//!
//! Implements `COMPOSER_REQUIREMENTS.md` (`PRODUCT-COMPOSER`, `PRODUCT-ATTACHMENTS`)
//! without introducing web runtimes or extra lockfile dependencies.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

use omnia_harness::{Block, Message, Role};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Self-Contained FIPS 180-4 SHA-256 & Base64 Helpers
// ---------------------------------------------------------------------------

const K256: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

pub fn sha256_hex(input: &[u8]) -> String {
    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];
    let bit_len = (input.len() as u64).wrapping_mul(8);
    let mut msg = input.to_vec();
    msg.push(0x80);
    while (msg.len() % 64) != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bit_len.to_be_bytes());

    for chunk in msg.chunks_exact(64) {
        let mut w = [0u32; 64];
        for (i, word) in w.iter_mut().take(16).enumerate() {
            let o = i * 4;
            *word = u32::from_be_bytes([chunk[o], chunk[o + 1], chunk[o + 2], chunk[o + 3]]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh] = h;
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let temp1 = hh
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K256[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = s0.wrapping_add(maj);

            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }
        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
        h[5] = h[5].wrapping_add(f);
        h[6] = h[6].wrapping_add(g);
        h[7] = h[7].wrapping_add(hh);
    }

    let mut out = String::with_capacity(64);
    for word in h {
        use std::fmt::Write as _;
        let _ = write!(&mut out, "{word:08x}");
    }
    out
}

const B64_TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn base64_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(B64_TABLE[((triple >> 18) & 0x3f) as usize] as char);
        out.push(B64_TABLE[((triple >> 12) & 0x3f) as usize] as char);
        if chunk.len() > 1 {
            out.push(B64_TABLE[((triple >> 6) & 0x3f) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(B64_TABLE[(triple & 0x3f) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        use std::fmt::Write as _;
        let _ = write!(&mut s, "{b:02x}");
    }
    s
}

fn hex_decode(hex: &str) -> Result<Vec<u8>, String> {
    if hex.len() % 2 != 0 {
        return Err("odd hex length".into());
    }
    let mut out = Vec::with_capacity(hex.len() / 2);
    let bytes = hex.as_bytes();
    for i in (0..bytes.len()).step_by(2) {
        let hi = (bytes[i] as char)
            .to_digit(16)
            .ok_or_else(|| "invalid hex digit".to_string())?;
        let lo = (bytes[i + 1] as char)
            .to_digit(16)
            .ok_or_else(|| "invalid hex digit".to_string())?;
        out.push(((hi << 4) | lo) as u8);
    }
    Ok(out)
}

fn decode_hex_utf8(hex: &str) -> Result<String, String> {
    let bytes = hex_decode(hex)?;
    String::from_utf8(bytes).map_err(|e| format!("invalid utf-8 in draft record: {e}"))
}

// ---------------------------------------------------------------------------
// Math / Physics / Chemistry Symbol & Equation Palette Catalog
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum SymbolDomain {
    Mathematics,
    Physics,
    Chemistry,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SymbolEntry {
    pub id: &'static str,
    pub domain: SymbolDomain,
    /// Rendered human-readable Unicode glyph/formula preview (never cryptic raw TeX alone).
    pub glyph_preview: &'static str,
    pub title: &'static str,
    pub latex_template: &'static str,
    pub placeholders: &'static [&'static str],
    pub keywords: &'static [&'static str],
}

pub const SYMBOL_PALETTE: &[SymbolEntry] = &[
    // Mathematics
    SymbolEntry {
        id: "math-sum",
        domain: SymbolDomain::Mathematics,
        glyph_preview: "∑ᵢ₌₁ⁿ xᵢ",
        title: "Summation",
        latex_template: "\\sum_{i=1}^{n} x_i",
        placeholders: &["i=1", "n", "x_i"],
        keywords: &["sum", "sigma", "series", "tổng"],
    },
    SymbolEntry {
        id: "math-integral",
        domain: SymbolDomain::Mathematics,
        glyph_preview: "∫ₐᵇ f(x) dx",
        title: "Definite Integral",
        latex_template: "\\int_{a}^{b} f(x)\\,dx",
        placeholders: &["a", "b", "f(x)", "x"],
        keywords: &["integral", "calculus", "area", "tích phân"],
    },
    SymbolEntry {
        id: "math-partial",
        domain: SymbolDomain::Mathematics,
        glyph_preview: "∂f / ∂x",
        title: "Partial Derivative",
        latex_template: "\\frac{\\partial f}{\\partial x}",
        placeholders: &["f", "x"],
        keywords: &["partial", "derivative", "gradient", "đạo hàm riêng"],
    },
    SymbolEntry {
        id: "math-nabla",
        domain: SymbolDomain::Mathematics,
        glyph_preview: "∇·F",
        title: "Divergence / Nabla",
        latex_template: "\\nabla \\cdot \\mathbf{F}",
        placeholders: &["F"],
        keywords: &["nabla", "divergence", "curl", "grad"],
    },
    SymbolEntry {
        id: "math-matrix-2x2",
        domain: SymbolDomain::Mathematics,
        glyph_preview: "[a b; c d]",
        title: "2×2 Matrix",
        latex_template: "\\begin{bmatrix} a & b \\\\ c & d \\end{bmatrix}",
        placeholders: &["a", "b", "c", "d"],
        keywords: &["matrix", "linear algebra", "ma trận"],
    },
    SymbolEntry {
        id: "math-limit",
        domain: SymbolDomain::Mathematics,
        glyph_preview: "limₙ→∞ aₙ",
        title: "Limit to Infinity",
        latex_template: "\\lim_{n \\to \\infty} a_n",
        placeholders: &["n", "\\infty", "a_n"],
        keywords: &["limit", "infinity", "giới hạn", "vô cực"],
    },
    SymbolEntry {
        id: "math-sqrt",
        domain: SymbolDomain::Mathematics,
        glyph_preview: "√(x² + y²)",
        title: "Euclidean Radical",
        latex_template: "\\sqrt{x^2 + y^2}",
        placeholders: &["x^2 + y^2"],
        keywords: &["sqrt", "root", "norm", "căn bậc hai"],
    },
    // Physics
    SymbolEntry {
        id: "phys-schrodinger",
        domain: SymbolDomain::Physics,
        glyph_preview: "iℏ ∂Ψ/∂t = ĤΨ",
        title: "Time-Dependent Schrödinger Equation",
        latex_template: "i\\hbar \\frac{\\partial}{\\partial t}\\Psi = \\hat{H}\\Psi",
        placeholders: &["\\Psi", "\\hat{H}"],
        keywords: &["hbar", "quantum", "wavefunction", "schrodinger", "lượng tử"],
    },
    SymbolEntry {
        id: "phys-photon-energy",
        domain: SymbolDomain::Physics,
        glyph_preview: "ΔE = hν = hc/λ",
        title: "Planck Photon Energy",
        latex_template: "\\Delta E = h\\nu = \\frac{hc}{\\lambda}",
        placeholders: &["\\Delta E", "\\nu", "\\lambda"],
        keywords: &["planck", "photon", "wavelength", "lambda", "bước sóng"],
    },
    SymbolEntry {
        id: "phys-braket",
        domain: SymbolDomain::Physics,
        glyph_preview: "⟨ψ|Ô|φ⟩",
        title: "Dirac Bra-Ket Expectation",
        latex_template: "\\langle \\psi \\mid \\hat{O} \\mid \\phi \\rangle",
        placeholders: &["\\psi", "\\hat{O}", "\\phi"],
        keywords: &["dirac", "braket", "operator", "quantum"],
    },
    SymbolEntry {
        id: "phys-maxwell-flux",
        domain: SymbolDomain::Physics,
        glyph_preview: "Φ_B = ∬ B·dA",
        title: "Magnetic Flux Surface Integral",
        latex_template: "\\Phi_B = \\iint_{S} \\mathbf{B} \\cdot d\\mathbf{A}",
        placeholders: &["S", "\\mathbf{B}"],
        keywords: &["flux", "magnetic", "maxwell", "faraday", "từ thông"],
    },
    // Chemistry
    SymbolEntry {
        id: "chem-equilibrium",
        domain: SymbolDomain::Chemistry,
        glyph_preview: "aA + bB ⇌ cC + dD",
        title: "Reversible Chemical Equilibrium",
        latex_template: "a\\text{A} + b\\text{B} \\rightleftharpoons c\\text{C} + d\\text{D}",
        placeholders: &["a\\text{A}", "b\\text{B}", "c\\text{C}", "d\\text{D}"],
        keywords: &["equilibrium", "reversible", "reaction", "cân bằng hóa học"],
    },
    SymbolEntry {
        id: "chem-catalytic-arrow",
        domain: SymbolDomain::Chemistry,
        glyph_preview: "R →[Δ, Pt] P",
        title: "Catalyzed Thermal Reaction",
        latex_template: "\\text{Reactants} \\xrightarrow[\\text{Pt}]{\\Delta} \\text{Products}",
        placeholders: &[
            "\\text{Reactants}",
            "\\text{Pt}",
            "\\Delta",
            "\\text{Products}",
        ],
        keywords: &["reaction", "catalyst", "heat", "phản ứng", "xúc tác"],
    },
    SymbolEntry {
        id: "chem-pka",
        domain: SymbolDomain::Chemistry,
        glyph_preview: "pKₐ = −log₁₀ Kₐ",
        title: "Acid Dissociation Constant (pKa)",
        latex_template: "\\text{p}K_a = -\\log_{10} K_a",
        placeholders: &["K_a"],
        keywords: &["acid", "pka", "ph", "buffer", "hằng số phân ly"],
    },
    SymbolEntry {
        id: "chem-enthalpy",
        domain: SymbolDomain::Chemistry,
        glyph_preview: "ΔH°_rxn = ∑ΔH°_f(prod) − ∑ΔH°_f(react)",
        title: "Standard Reaction Enthalpy",
        latex_template: "\\Delta H^\\circ_{\\text{rxn}}",
        placeholders: &["\\text{rxn}"],
        keywords: &["enthalpy", "thermodynamics", "hess", "nhiệt phản ứng"],
    },
];

pub fn search_symbol_palette(
    query: &str,
    domain: Option<SymbolDomain>,
) -> Vec<&'static SymbolEntry> {
    let needle = query.trim().to_lowercase();
    SYMBOL_PALETTE
        .iter()
        .filter(|entry| domain.is_none_or(|d| entry.domain == d))
        .filter(|entry| {
            needle.is_empty()
                || entry.id.contains(&needle)
                || entry.title.to_lowercase().contains(&needle)
                || entry.glyph_preview.to_lowercase().contains(&needle)
                || entry.latex_template.to_lowercase().contains(&needle)
                || entry
                    .keywords
                    .iter()
                    .any(|kw| kw.to_lowercase().contains(&needle))
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Rich Formatting, Document AST, and Attachment Provenance Models
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct TextStyle {
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub inline_code: bool,
    pub inline_latex: bool,
    pub font_family: Option<String>,
    pub font_size_pt: Option<u16>,
    pub color_hex: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BlockFormat {
    Paragraph { indent_level: u8 },
    Title,
    Heading { level: u8 },
    BulletListItem { indent_level: u8 },
    NumberedListItem { index: u32, indent_level: u8 },
    ChecklistItem { checked: bool, indent_level: u8 },
    LatexEquationBlock,
    MarkdownCodeBlock { language: String },
}

impl Default for BlockFormat {
    fn default() -> Self {
        Self::Paragraph { indent_level: 0 }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComposerTable {
    pub headers: Vec<String>,
    pub rows: Vec<Vec<String>>,
}

impl ComposerTable {
    pub fn to_markdown(&self) -> String {
        if self.headers.is_empty() {
            return String::new();
        }
        let mut out = String::new();
        out.push_str("| ");
        out.push_str(&self.headers.join(" | "));
        out.push_str(" |\n| ");
        out.push_str(
            &self
                .headers
                .iter()
                .map(|_| "---")
                .collect::<Vec<_>>()
                .join(" | "),
        );
        out.push_str(" |\n");
        for row in &self.rows {
            out.push_str("| ");
            let cells: Vec<&str> = (0..self.headers.len())
                .map(|idx| row.get(idx).map_or("", String::as_str))
                .collect();
            out.push_str(&cells.join(" | "));
            out.push_str(" |\n");
        }
        out
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ComposerNode {
    TextSpan {
        text: String,
        style: TextStyle,
        block: BlockFormat,
    },
    Table(ComposerTable),
    InlineAttachment {
        instance_id: String,
        payload_id: String,
        alt_label: Option<String>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttachmentMediaKind {
    Image,
    Screenshot,
    Pdf,
    Markdown,
    SourceCode,
    StructuredData,
    OfficeDocument,
    Archive,
    AudioVideo,
    EncryptedOrProtected,
    UnsupportedBinary,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConversionStatus {
    Ready,
    Pending,
    Running {
        progress_pct: u8,
    },
    Complete,
    Failed {
        error: String,
        retryable: bool,
    },
    Cancelled,
    /// Explicit honesty state: password-protected or unsupported formats never fake extraction.
    UnsupportedOrEncrypted {
        reason: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DerivedRepresentation {
    pub kind: String,
    pub mime_type: String,
    pub derived_sha256: String,
    pub converter: String,
    pub text_preview: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttachmentPayload {
    pub payload_id: String,
    pub original_sha256: String,
    pub file_name: String,
    pub mime_type: String,
    pub byte_len: u64,
    pub media_kind: AttachmentMediaKind,
    pub raw_bytes_base64: Option<String>,
    pub extracted_text: Option<String>,
    pub conversion_status: ConversionStatus,
    pub derived: Vec<DerivedRepresentation>,
    pub failure_acknowledged: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IncomingAttachment {
    pub file_name: String,
    pub mime_type: String,
    pub bytes: Vec<u8>,
    pub is_screenshot: bool,
    pub is_encrypted: bool,
}

impl IncomingAttachment {
    pub fn classify_media_kind(&self) -> AttachmentMediaKind {
        if self.is_encrypted || is_encrypted_container(&self.bytes, &self.file_name) {
            return AttachmentMediaKind::EncryptedOrProtected;
        }
        if self.is_screenshot {
            return AttachmentMediaKind::Screenshot;
        }
        let mime = self.mime_type.to_ascii_lowercase();
        let lower_name = self.file_name.to_ascii_lowercase();
        if mime.starts_with("image/") {
            AttachmentMediaKind::Image
        } else if mime == "application/pdf" || lower_name.ends_with(".pdf") {
            AttachmentMediaKind::Pdf
        } else if lower_name.ends_with(".md") || mime == "text/markdown" {
            AttachmentMediaKind::Markdown
        } else if lower_name.ends_with(".rs")
            || lower_name.ends_with(".ts")
            || lower_name.ends_with(".py")
            || lower_name.ends_with(".js")
            || lower_name.ends_with(".c")
            || lower_name.ends_with(".cpp")
        {
            AttachmentMediaKind::SourceCode
        } else if lower_name.ends_with(".json")
            || lower_name.ends_with(".csv")
            || lower_name.ends_with(".toml")
            || lower_name.ends_with(".yaml")
            || lower_name.ends_with(".yml")
        {
            AttachmentMediaKind::StructuredData
        } else if lower_name.ends_with(".docx")
            || lower_name.ends_with(".xlsx")
            || lower_name.ends_with(".pptx")
        {
            AttachmentMediaKind::OfficeDocument
        } else if lower_name.ends_with(".zip")
            || lower_name.ends_with(".7z")
            || lower_name.ends_with(".tar.gz")
        {
            AttachmentMediaKind::Archive
        } else if mime.starts_with("audio/") || mime.starts_with("video/") {
            AttachmentMediaKind::AudioVideo
        } else if mime.starts_with("text/") {
            AttachmentMediaKind::Markdown
        } else {
            AttachmentMediaKind::UnsupportedBinary
        }
    }
}

fn is_encrypted_container(bytes: &[u8], file_name: &str) -> bool {
    let lower = file_name.to_ascii_lowercase();
    if lower.contains(".encrypted.") || lower.ends_with(".gpg") || lower.ends_with(".age") {
        return true;
    }
    // Check PDF `/Encrypt` dictionary marker in raw header/trailer window.
    if (lower.ends_with(".pdf") || bytes.starts_with(b"%PDF-"))
        && bytes.windows(8).any(|w| w == b"/Encrypt")
    {
        return true;
    }
    false
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrayAttachmentRef {
    pub tray_item_id: String,
    pub payload_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PasteDestination {
    InlineAtCaret,
    AttachmentTray,
    Cancel,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingPastePrompt {
    pub paste_id: String,
    pub caret_char_offset: usize,
    pub candidate_files: Vec<IncomingAttachment>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DropZone {
    EditableContent { caret_char_offset: usize },
    ApplicationOutsideInput,
    OutsideApplication,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DropIndicator {
    InlineCaret { caret_char_offset: usize },
    AttachmentTrayHighlight,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SendReadiness {
    Ready,
    BlockedEmptyDraft,
    BlockedPendingConversions { payload_ids: Vec<String> },
    BlockedUnacknowledgedFailures { payload_ids: Vec<String> },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LivePreviewOutput {
    pub rendered_markdown: String,
    pub latex_expressions: Vec<String>,
    pub inline_attachment_chips: Vec<String>,
    pub tray_attachment_chips: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UploadManifestEntry {
    pub payload_id: String,
    pub original_sha256: String,
    pub file_name: String,
    pub mime_type: String,
    pub byte_len: u64,
    pub used_inline: bool,
    pub used_in_tray: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SerializedComposerTurn {
    pub message: Message,
    pub upload_manifest: Vec<UploadManifestEntry>,
    pub used_non_multimodal_fallback: bool,
}

// ---------------------------------------------------------------------------
// RichComposer State Machine (Undo/Redo, Paste/Drop, Persistence, Serialization)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
struct ComposerSnapshot {
    document: Vec<ComposerNode>,
    tray: Vec<TrayAttachmentRef>,
    payloads: BTreeMap<String, AttachmentPayload>,
}

#[derive(Debug, Clone)]
pub struct RichComposer {
    pub document: Vec<ComposerNode>,
    pub tray: Vec<TrayAttachmentRef>,
    pub payloads: BTreeMap<String, AttachmentPayload>,
    pub pending_paste: Option<PendingPastePrompt>,
    pub live_drop_indicator: Option<DropIndicator>,
    undo_stack: Vec<ComposerSnapshot>,
    redo_stack: Vec<ComposerSnapshot>,
    max_undo_depth: usize,
}

impl Default for RichComposer {
    fn default() -> Self {
        Self::new()
    }
}

impl RichComposer {
    pub fn new() -> Self {
        Self {
            document: Vec::new(),
            tray: Vec::new(),
            payloads: BTreeMap::new(),
            pending_paste: None,
            live_drop_indicator: None,
            undo_stack: Vec::new(),
            redo_stack: Vec::new(),
            max_undo_depth: 128,
        }
    }

    fn snapshot(&self) -> ComposerSnapshot {
        ComposerSnapshot {
            document: self.document.clone(),
            tray: self.tray.clone(),
            payloads: self.payloads.clone(),
        }
    }

    fn record_undo_checkpoint(&mut self) {
        if self.undo_stack.len() >= self.max_undo_depth {
            self.undo_stack.remove(0);
        }
        self.undo_stack.push(self.snapshot());
        self.redo_stack.clear();
    }

    pub fn undo(&mut self) -> bool {
        let Some(prev) = self.undo_stack.pop() else {
            return false;
        };
        self.redo_stack.push(self.snapshot());
        self.document = prev.document;
        self.tray = prev.tray;
        self.payloads = prev.payloads;
        true
    }

    pub fn redo(&mut self) -> bool {
        let Some(next) = self.redo_stack.pop() else {
            return false;
        };
        self.undo_stack.push(self.snapshot());
        self.document = next.document;
        self.tray = next.tray;
        self.payloads = next.payloads;
        true
    }

    pub fn undo_depth(&self) -> usize {
        self.undo_stack.len()
    }

    pub fn redo_depth(&self) -> usize {
        self.redo_stack.len()
    }

    /// Sets plain text while preserving existing inline attachments if empty, or replacing text spans.
    pub fn set_plain_text(&mut self, text: &str) {
        self.record_undo_checkpoint();
        self.document.clear();
        if !text.is_empty() {
            self.document.push(ComposerNode::TextSpan {
                text: text.to_string(),
                style: TextStyle::default(),
                block: BlockFormat::default(),
            });
        }
    }

    pub fn append_styled_span(
        &mut self,
        text: impl Into<String>,
        style: TextStyle,
        block: BlockFormat,
    ) {
        let text = text.into();
        if text.is_empty() {
            return;
        }
        self.record_undo_checkpoint();
        self.document
            .push(ComposerNode::TextSpan { text, style, block });
    }

    pub fn append_table(&mut self, table: ComposerTable) {
        self.record_undo_checkpoint();
        self.document.push(ComposerNode::Table(table));
    }

    /// Total UTF-8 scalar count across all `TextSpan`s in document order
    /// (each `InlineAttachment` or `Table` occupies 1 logical object slot).
    pub fn total_logical_positions(&self) -> usize {
        self.document
            .iter()
            .map(|node| match node {
                ComposerNode::TextSpan { text, .. } => text.chars().count(),
                ComposerNode::Table(_) | ComposerNode::InlineAttachment { .. } => 1,
            })
            .sum()
    }

    pub fn plain_text_projection(&self) -> String {
        let mut out = String::new();
        for node in &self.document {
            match node {
                ComposerNode::TextSpan { text, .. } => out.push_str(text),
                ComposerNode::Table(t) => out.push_str(&t.to_markdown()),
                ComposerNode::InlineAttachment { payload_id, .. } => {
                    let label = self
                        .payloads
                        .get(payload_id)
                        .map(|p| p.file_name.as_str())
                        .unwrap_or(payload_id.as_str());
                    out.push_str(&format!("[inline:{label}]"));
                }
            }
        }
        out
    }

    /// Inserts a symbol or LaTeX equation template from `SYMBOL_PALETTE` at `caret_offset`.
    pub fn insert_symbol_at_caret(
        &mut self,
        symbol_id: &str,
        caret_offset: usize,
        as_latex: bool,
    ) -> Result<String, String> {
        let entry = SYMBOL_PALETTE
            .iter()
            .find(|e| e.id == symbol_id)
            .ok_or_else(|| format!("unknown symbol palette id `{symbol_id}`"))?;
        let snippet = if as_latex {
            format!("${}$", entry.latex_template)
        } else {
            entry.glyph_preview.to_string()
        };
        let style = TextStyle {
            inline_latex: as_latex,
            ..TextStyle::default()
        };
        self.record_undo_checkpoint();
        self.insert_nodes_at_offset(
            caret_offset,
            vec![ComposerNode::TextSpan {
                text: snippet.clone(),
                style,
                block: BlockFormat::default(),
            }],
        );
        Ok(snippet)
    }

    // -----------------------------------------------------------------------
    // Attachment Registration, Deduplication, Paste Chooser & Drag-Drop Zones
    // -----------------------------------------------------------------------

    fn ingest_payload(&mut self, incoming: IncomingAttachment) -> String {
        let digest = sha256_hex(&incoming.bytes);
        let payload_id = format!("att-{}", &digest[..24]);
        if self.payloads.contains_key(&payload_id) {
            return payload_id;
        }

        let media_kind = incoming.classify_media_kind();
        let raw_bytes_base64 = matches!(
            media_kind,
            AttachmentMediaKind::Image | AttachmentMediaKind::Screenshot
        )
        .then(|| base64_encode(&incoming.bytes));

        let (extracted_text, conversion_status, derived) = match media_kind {
            AttachmentMediaKind::Image | AttachmentMediaKind::Screenshot => {
                (None, ConversionStatus::Ready, Vec::new())
            }
            AttachmentMediaKind::Markdown
            | AttachmentMediaKind::SourceCode
            | AttachmentMediaKind::StructuredData => {
                let text = String::from_utf8_lossy(&incoming.bytes).into_owned();
                let derived_hash = sha256_hex(text.as_bytes());
                let preview = text.chars().take(160).collect::<String>();
                (
                    Some(text),
                    ConversionStatus::Complete,
                    vec![DerivedRepresentation {
                        kind: "utf8_text".to_string(),
                        mime_type: "text/plain".to_string(),
                        derived_sha256: derived_hash,
                        converter: "native-utf8-decoder".to_string(),
                        text_preview: Some(preview),
                    }],
                )
            }
            AttachmentMediaKind::Pdf | AttachmentMediaKind::OfficeDocument => {
                (None, ConversionStatus::Pending, Vec::new())
            }
            AttachmentMediaKind::Archive | AttachmentMediaKind::AudioVideo => {
                (None, ConversionStatus::Pending, Vec::new())
            }
            AttachmentMediaKind::EncryptedOrProtected => (
                None,
                ConversionStatus::UnsupportedOrEncrypted {
                    reason: "Attachment is encrypted or password-protected; Omnia cannot inspect its contents without decryption."
                        .to_string(),
                },
                Vec::new(),
            ),
            AttachmentMediaKind::UnsupportedBinary => (
                None,
                ConversionStatus::UnsupportedOrEncrypted {
                    reason: format!(
                        "Unsupported binary format (`{}`); raw file metadata recorded without claiming content extraction.",
                        incoming.mime_type
                    ),
                },
                Vec::new(),
            ),
        };

        self.payloads.insert(
            payload_id.clone(),
            AttachmentPayload {
                payload_id: payload_id.clone(),
                original_sha256: digest,
                file_name: incoming.file_name,
                mime_type: incoming.mime_type,
                byte_len: incoming.bytes.len() as u64,
                media_kind,
                raw_bytes_base64,
                extracted_text,
                conversion_status,
                derived,
                failure_acknowledged: false,
            },
        );
        payload_id
    }

    /// Starts an explicit keyboard-navigable `Ctrl+V` paste chooser without mutating the draft.
    pub fn begin_paste(
        &mut self,
        files: Vec<IncomingAttachment>,
        caret_char_offset: usize,
    ) -> PendingPastePrompt {
        let prompt = PendingPastePrompt {
            paste_id: format!("paste-{}", Uuid::new_v4()),
            caret_char_offset,
            candidate_files: files,
        };
        self.pending_paste = Some(prompt.clone());
        prompt
    }

    /// Resolves a pending `Ctrl+V` paste prompt (`InlineAtCaret`, `AttachmentTray`, or `Cancel`).
    /// `Cancel` guarantees zero mutation to document, tray, payloads, and undo stack.
    pub fn resolve_paste(
        &mut self,
        paste_id: &str,
        choice: PasteDestination,
    ) -> Result<Vec<String>, String> {
        let pending = match &self.pending_paste {
            Some(p) if p.paste_id == paste_id => self.pending_paste.take().unwrap(),
            Some(_) => {
                return Err(format!(
                    "paste_id `{paste_id}` does not match active prompt"
                ))
            }
            None => return Err("no active paste prompt".into()),
        };

        match choice {
            PasteDestination::Cancel => Ok(Vec::new()),
            PasteDestination::InlineAtCaret => {
                Ok(self
                    .insert_attachments_inline(pending.caret_char_offset, pending.candidate_files))
            }
            PasteDestination::AttachmentTray => {
                Ok(self.add_attachments_to_tray(pending.candidate_files))
            }
        }
    }

    /// Updates live drag-over feedback per `COMPOSER_REQUIREMENTS.md` §3.
    pub fn handle_drag_over(&mut self, zone: DropZone) {
        self.live_drop_indicator = match zone {
            DropZone::EditableContent { caret_char_offset } => {
                Some(DropIndicator::InlineCaret { caret_char_offset })
            }
            DropZone::ApplicationOutsideInput => Some(DropIndicator::AttachmentTrayHighlight),
            DropZone::OutsideApplication => None,
        };
    }

    /// Routes dropped attachments according to the target drop zone:
    /// - Over editable content -> inline ordered node(s) at `caret_char_offset`
    /// - Over application outside input -> attachment tray
    /// - Outside application -> ignored with zero mutation
    pub fn handle_drop(&mut self, zone: DropZone, files: Vec<IncomingAttachment>) -> Vec<String> {
        self.live_drop_indicator = None;
        if files.is_empty() {
            return Vec::new();
        }
        match zone {
            DropZone::EditableContent { caret_char_offset } => {
                self.insert_attachments_inline(caret_char_offset, files)
            }
            DropZone::ApplicationOutsideInput => self.add_attachments_to_tray(files),
            DropZone::OutsideApplication => Vec::new(),
        }
    }

    pub fn insert_attachments_inline(
        &mut self,
        caret_char_offset: usize,
        files: Vec<IncomingAttachment>,
    ) -> Vec<String> {
        if files.is_empty() {
            return Vec::new();
        }
        self.record_undo_checkpoint();
        let mut ids = Vec::with_capacity(files.len());
        let mut nodes = Vec::with_capacity(files.len());
        for file in files {
            let label = file.file_name.clone();
            let pid = self.ingest_payload(file);
            ids.push(pid.clone());
            nodes.push(ComposerNode::InlineAttachment {
                instance_id: format!("inl-{}", Uuid::new_v4()),
                payload_id: pid,
                alt_label: Some(label),
            });
        }
        self.insert_nodes_at_offset(caret_char_offset, nodes);
        ids
    }

    pub fn add_attachments_to_tray(&mut self, files: Vec<IncomingAttachment>) -> Vec<String> {
        if files.is_empty() {
            return Vec::new();
        }
        self.record_undo_checkpoint();
        let mut ids = Vec::with_capacity(files.len());
        for file in files {
            let pid = self.ingest_payload(file);
            if !self.tray.iter().any(|t| t.payload_id == pid) {
                self.tray.push(TrayAttachmentRef {
                    tray_item_id: format!("tray-{}", Uuid::new_v4()),
                    payload_id: pid.clone(),
                });
            }
            ids.push(pid);
        }
        ids
    }

    fn insert_nodes_at_offset(&mut self, caret_char_offset: usize, new_nodes: Vec<ComposerNode>) {
        if self.document.is_empty() {
            self.document = new_nodes;
            return;
        }

        let mut remaining = caret_char_offset;
        let mut rebuilt = Vec::with_capacity(self.document.len() + new_nodes.len() + 1);
        let mut inserted = false;

        for node in self.document.drain(..) {
            if inserted {
                rebuilt.push(node);
                continue;
            }
            match node {
                ComposerNode::TextSpan { text, style, block } => {
                    let char_len = text.chars().count();
                    if remaining == 0 {
                        rebuilt.extend(new_nodes.clone());
                        rebuilt.push(ComposerNode::TextSpan { text, style, block });
                        inserted = true;
                    } else if remaining < char_len {
                        let prefix: String = text.chars().take(remaining).collect();
                        let suffix: String = text.chars().skip(remaining).collect();
                        rebuilt.push(ComposerNode::TextSpan {
                            text: prefix,
                            style: style.clone(),
                            block: block.clone(),
                        });
                        rebuilt.extend(new_nodes.clone());
                        rebuilt.push(ComposerNode::TextSpan {
                            text: suffix,
                            style,
                            block,
                        });
                        inserted = true;
                    } else {
                        remaining -= char_len;
                        rebuilt.push(ComposerNode::TextSpan { text, style, block });
                    }
                }
                other => {
                    if remaining == 0 {
                        rebuilt.extend(new_nodes.clone());
                        rebuilt.push(other);
                        inserted = true;
                    } else {
                        remaining -= 1;
                        rebuilt.push(other);
                    }
                }
            }
        }

        if !inserted {
            rebuilt.extend(new_nodes);
        }
        self.document = rebuilt;
    }

    /// Moves an inline attachment instance out of the prose flow into the tray,
    /// preserving the exact same deduplicated `payload_id`.
    pub fn move_inline_to_tray(&mut self, instance_id: &str) -> Result<String, String> {
        let pos = self
            .document
            .iter()
            .position(|n| {
                matches!(n, ComposerNode::InlineAttachment { instance_id: id, .. } if id == instance_id)
            })
            .ok_or_else(|| format!("inline attachment `{instance_id}` not found"))?;
        self.record_undo_checkpoint();
        let removed = self.document.remove(pos);
        let ComposerNode::InlineAttachment { payload_id, .. } = removed else {
            unreachable!()
        };
        if !self.tray.iter().any(|t| t.payload_id == payload_id) {
            self.tray.push(TrayAttachmentRef {
                tray_item_id: format!("tray-{}", Uuid::new_v4()),
                payload_id: payload_id.clone(),
            });
        }
        Ok(payload_id)
    }

    /// Inserts an inline reference at `caret_char_offset` sharing an existing tray `payload_id`
    /// without duplicating payload storage or uploads.
    pub fn copy_tray_to_inline(
        &mut self,
        payload_id: &str,
        caret_char_offset: usize,
    ) -> Result<String, String> {
        let payload = self
            .payloads
            .get(payload_id)
            .ok_or_else(|| format!("payload `{payload_id}` not found"))?;
        let alt = payload.file_name.clone();
        let instance_id = format!("inl-{}", Uuid::new_v4());
        self.record_undo_checkpoint();
        self.insert_nodes_at_offset(
            caret_char_offset,
            vec![ComposerNode::InlineAttachment {
                instance_id: instance_id.clone(),
                payload_id: payload_id.to_string(),
                alt_label: Some(alt),
            }],
        );
        Ok(instance_id)
    }

    pub fn remove_inline(&mut self, instance_id: &str) -> bool {
        if !self.document.iter().any(|n| {
            matches!(n, ComposerNode::InlineAttachment { instance_id: id, .. } if id == instance_id)
        }) {
            return false;
        }
        self.record_undo_checkpoint();
        self.document.retain(|n| {
            !matches!(n, ComposerNode::InlineAttachment { instance_id: id, .. } if id == instance_id)
        });
        self.gc_unreferenced_payloads();
        true
    }

    pub fn remove_from_tray(&mut self, payload_id: &str) -> bool {
        if !self.tray.iter().any(|t| t.payload_id == payload_id) {
            return false;
        }
        self.record_undo_checkpoint();
        self.tray.retain(|t| t.payload_id != payload_id);
        self.gc_unreferenced_payloads();
        true
    }

    pub fn replace_attachment_payload(
        &mut self,
        old_payload_id: &str,
        replacement: IncomingAttachment,
    ) -> Result<String, String> {
        if !self.payloads.contains_key(old_payload_id) {
            return Err(format!("payload `{old_payload_id}` not found"));
        }
        self.record_undo_checkpoint();
        let new_label = replacement.file_name.clone();
        let new_pid = self.ingest_payload(replacement);
        for node in &mut self.document {
            if let ComposerNode::InlineAttachment {
                payload_id,
                alt_label,
                ..
            } = node
            {
                if payload_id == old_payload_id {
                    *payload_id = new_pid.clone();
                    *alt_label = Some(new_label.clone());
                }
            }
        }
        for item in &mut self.tray {
            if item.payload_id == old_payload_id {
                item.payload_id = new_pid.clone();
            }
        }
        self.gc_unreferenced_payloads();
        Ok(new_pid)
    }

    fn gc_unreferenced_payloads(&mut self) {
        let mut active = BTreeSet::new();
        for node in &self.document {
            if let ComposerNode::InlineAttachment { payload_id, .. } = node {
                active.insert(payload_id.clone());
            }
        }
        for item in &self.tray {
            active.insert(item.payload_id.clone());
        }
        self.payloads.retain(|k, _| active.contains(k));
    }

    // -----------------------------------------------------------------------
    // Conversion Lifecycle & Send-Readiness Gate
    // -----------------------------------------------------------------------

    pub fn complete_conversion(
        &mut self,
        payload_id: &str,
        extracted_text: String,
        converter: &str,
    ) -> Result<(), String> {
        let payload = self
            .payloads
            .get_mut(payload_id)
            .ok_or_else(|| format!("payload `{payload_id}` not found"))?;
        let derived_sha256 = sha256_hex(extracted_text.as_bytes());
        let preview = extracted_text.chars().take(160).collect::<String>();
        payload.extracted_text = Some(extracted_text);
        payload.conversion_status = ConversionStatus::Complete;
        payload.derived.push(DerivedRepresentation {
            kind: "extracted_markdown".to_string(),
            mime_type: "text/markdown".to_string(),
            derived_sha256,
            converter: converter.to_string(),
            text_preview: Some(preview),
        });
        Ok(())
    }

    pub fn fail_conversion(
        &mut self,
        payload_id: &str,
        error: impl Into<String>,
        retryable: bool,
    ) -> Result<(), String> {
        let payload = self
            .payloads
            .get_mut(payload_id)
            .ok_or_else(|| format!("payload `{payload_id}` not found"))?;
        payload.conversion_status = ConversionStatus::Failed {
            error: error.into(),
            retryable,
        };
        payload.failure_acknowledged = false;
        Ok(())
    }

    pub fn cancel_conversion(&mut self, payload_id: &str) -> Result<(), String> {
        let payload = self
            .payloads
            .get_mut(payload_id)
            .ok_or_else(|| format!("payload `{payload_id}` not found"))?;
        payload.conversion_status = ConversionStatus::Cancelled;
        Ok(())
    }

    pub fn retry_conversion(&mut self, payload_id: &str) -> Result<(), String> {
        let payload = self
            .payloads
            .get_mut(payload_id)
            .ok_or_else(|| format!("payload `{payload_id}` not found"))?;
        payload.conversion_status = ConversionStatus::Pending;
        payload.failure_acknowledged = false;
        Ok(())
    }

    pub fn acknowledge_failed_conversion(&mut self, payload_id: &str) -> Result<(), String> {
        let payload = self
            .payloads
            .get_mut(payload_id)
            .ok_or_else(|| format!("payload `{payload_id}` not found"))?;
        payload.failure_acknowledged = true;
        Ok(())
    }

    pub fn referenced_payload_ids(&self) -> Vec<String> {
        let mut ordered = Vec::new();
        let mut seen = BTreeSet::new();
        for node in &self.document {
            if let ComposerNode::InlineAttachment { payload_id, .. } = node {
                if seen.insert(payload_id.clone()) {
                    ordered.push(payload_id.clone());
                }
            }
        }
        for item in &self.tray {
            if seen.insert(item.payload_id.clone()) {
                ordered.push(item.payload_id.clone());
            }
        }
        ordered
    }

    pub fn evaluate_send_readiness(&self) -> SendReadiness {
        if self.document.is_empty() && self.tray.is_empty() {
            return SendReadiness::BlockedEmptyDraft;
        }
        let mut pending = Vec::new();
        let mut failed = Vec::new();
        for pid in self.referenced_payload_ids() {
            if let Some(p) = self.payloads.get(&pid) {
                match &p.conversion_status {
                    ConversionStatus::Pending | ConversionStatus::Running { .. } => {
                        pending.push(pid);
                    }
                    ConversionStatus::Failed { .. } if !p.failure_acknowledged => {
                        failed.push(pid);
                    }
                    _ => {}
                }
            }
        }
        if !pending.is_empty() {
            return SendReadiness::BlockedPendingConversions {
                payload_ids: pending,
            };
        }
        if !failed.is_empty() {
            return SendReadiness::BlockedUnacknowledgedFailures {
                payload_ids: failed,
            };
        }
        SendReadiness::Ready
    }

    // -----------------------------------------------------------------------
    // Live Markdown + LaTeX Preview & Ordered Multimodal / Fallback Serialization
    // -----------------------------------------------------------------------

    pub fn render_live_preview(&self) -> LivePreviewOutput {
        let mut md = String::new();
        let mut latex_expressions = Vec::new();
        let mut inline_chips = Vec::new();

        for node in &self.document {
            match node {
                ComposerNode::TextSpan { text, style, block } => {
                    let mut formatted = text.clone();
                    if style.inline_latex {
                        latex_expressions.push(text.trim_matches('$').to_string());
                    } else if style.inline_code {
                        formatted = format!("`{formatted}`");
                    } else {
                        if style.bold {
                            formatted = format!("**{formatted}**");
                        }
                        if style.italic {
                            formatted = format!("*{formatted}*");
                        }
                        if style.underline {
                            formatted = format!("<u>{formatted}</u>");
                        }
                    }
                    match block {
                        BlockFormat::Paragraph { indent_level } => {
                            if *indent_level > 0 {
                                md.push_str(&"> ".repeat(*indent_level as usize));
                            }
                            md.push_str(&formatted);
                        }
                        BlockFormat::Title => md.push_str(&format!("# {formatted}\n")),
                        BlockFormat::Heading { level } => {
                            let hashes = "#".repeat((*level).clamp(1, 6) as usize);
                            md.push_str(&format!("{hashes} {formatted}\n"));
                        }
                        BlockFormat::BulletListItem { indent_level } => {
                            md.push_str(&"  ".repeat(*indent_level as usize));
                            md.push_str(&format!("- {formatted}\n"));
                        }
                        BlockFormat::NumberedListItem {
                            index,
                            indent_level,
                        } => {
                            md.push_str(&"  ".repeat(*indent_level as usize));
                            md.push_str(&format!("{index}. {formatted}\n"));
                        }
                        BlockFormat::ChecklistItem {
                            checked,
                            indent_level,
                        } => {
                            md.push_str(&"  ".repeat(*indent_level as usize));
                            let mark = if *checked { "x" } else { " " };
                            md.push_str(&format!("- [{mark}] {formatted}\n"));
                        }
                        BlockFormat::LatexEquationBlock => {
                            latex_expressions.push(text.clone());
                            md.push_str(&format!("\n$$\n{}\n$$\n", text.trim()));
                        }
                        BlockFormat::MarkdownCodeBlock { language } => {
                            md.push_str(&format!("\n```{language}\n{text}\n```\n"));
                        }
                    }
                }
                ComposerNode::Table(table) => {
                    md.push('\n');
                    md.push_str(&table.to_markdown());
                }
                ComposerNode::InlineAttachment {
                    payload_id,
                    alt_label,
                    ..
                } => {
                    let chip = if let Some(p) = self.payloads.get(payload_id) {
                        format!(
                            "[Inline: {} ({}, {} B, {:?})]",
                            alt_label.as_deref().unwrap_or(&p.file_name),
                            p.mime_type,
                            p.byte_len,
                            p.conversion_status
                        )
                    } else {
                        format!("[Inline: {payload_id}]")
                    };
                    inline_chips.push(chip.clone());
                    md.push_str(&chip);
                }
            }
        }

        let tray_chips = self
            .tray
            .iter()
            .map(|t| {
                if let Some(p) = self.payloads.get(&t.payload_id) {
                    format!(
                        "[Tray: {} ({}, {} B, {:?})]",
                        p.file_name, p.mime_type, p.byte_len, p.conversion_status
                    )
                } else {
                    format!("[Tray: {}]", t.payload_id)
                }
            })
            .collect();

        LivePreviewOutput {
            rendered_markdown: md,
            latex_expressions,
            inline_attachment_chips: inline_chips,
            tray_attachment_chips: tray_chips,
        }
    }

    /// Serializes the rich draft + inline/tray attachments into an ordered
    /// `omnia_harness::Message` and a deduplicated `upload_manifest`.
    pub fn serialize_for_provider(
        &self,
        supports_multimodal: bool,
    ) -> Result<SerializedComposerTurn, String> {
        match self.evaluate_send_readiness() {
            SendReadiness::Ready => {}
            SendReadiness::BlockedEmptyDraft => {
                return Err("cannot serialize empty draft".into());
            }
            SendReadiness::BlockedPendingConversions { payload_ids } => {
                return Err(format!(
                    "attachments still converting before send: {}",
                    payload_ids.join(", ")
                ));
            }
            SendReadiness::BlockedUnacknowledgedFailures { payload_ids } => {
                return Err(format!(
                    "failed attachments require retry, removal, or acknowledgement: {}",
                    payload_ids.join(", ")
                ));
            }
        }

        let inline_set: BTreeSet<&str> = self
            .document
            .iter()
            .filter_map(|n| match n {
                ComposerNode::InlineAttachment { payload_id, .. } => Some(payload_id.as_str()),
                _ => None,
            })
            .collect();
        let tray_set: BTreeSet<&str> = self.tray.iter().map(|t| t.payload_id.as_str()).collect();

        let mut upload_manifest = Vec::new();
        for pid in self.referenced_payload_ids() {
            if let Some(p) = self.payloads.get(&pid) {
                upload_manifest.push(UploadManifestEntry {
                    payload_id: p.payload_id.clone(),
                    original_sha256: p.original_sha256.clone(),
                    file_name: p.file_name.clone(),
                    mime_type: p.mime_type.clone(),
                    byte_len: p.byte_len,
                    used_inline: inline_set.contains(pid.as_str()),
                    used_in_tray: tray_set.contains(pid.as_str()),
                });
            }
        }

        let mut blocks: Vec<Block> = Vec::new();
        let mut text_accum = String::new();
        let flush_text = |buf: &mut String, out: &mut Vec<Block>| {
            if !buf.is_empty() {
                out.push(Block::text(std::mem::take(buf)));
            }
        };

        for (idx, node) in self.document.iter().enumerate() {
            match node {
                ComposerNode::TextSpan { text, .. } => text_accum.push_str(text),
                ComposerNode::Table(t) => {
                    if !text_accum.ends_with('\n') && !text_accum.is_empty() {
                        text_accum.push('\n');
                    }
                    text_accum.push_str(&t.to_markdown());
                }
                ComposerNode::InlineAttachment {
                    payload_id,
                    alt_label,
                    ..
                } => {
                    let Some(p) = self.payloads.get(payload_id) else {
                        continue;
                    };
                    let display = alt_label.as_deref().unwrap_or(&p.file_name);
                    if supports_multimodal {
                        if let Some(b64) = &p.raw_bytes_base64 {
                            flush_text(&mut text_accum, &mut blocks);
                            blocks.push(Block::Image {
                                media_type: p.mime_type.clone(),
                                data: b64.clone(),
                            });
                            continue;
                        }
                    }
                    text_accum.push_str(&render_attachment_fallback_marker(
                        "Inline Attachment",
                        idx + 1,
                        display,
                        p,
                    ));
                }
            }
        }

        // Append tray attachments after inline document stream without duplicating raw uploads in manifest.
        if !self.tray.is_empty() {
            if !text_accum.is_empty() && !text_accum.ends_with('\n') {
                text_accum.push('\n');
            }
            text_accum.push_str("\n[Tray Attachments]\n");
            for (t_idx, tray_ref) in self.tray.iter().enumerate() {
                let Some(p) = self.payloads.get(&tray_ref.payload_id) else {
                    continue;
                };
                if supports_multimodal && !inline_set.contains(p.payload_id.as_str()) {
                    if let Some(b64) = &p.raw_bytes_base64 {
                        text_accum.push_str(&format!(
                            "- Tray #{}: {} ({})\n",
                            t_idx + 1,
                            p.file_name,
                            p.payload_id
                        ));
                        flush_text(&mut text_accum, &mut blocks);
                        blocks.push(Block::Image {
                            media_type: p.mime_type.clone(),
                            data: b64.clone(),
                        });
                        continue;
                    }
                }
                text_accum.push_str(&render_attachment_fallback_marker(
                    "Tray Attachment",
                    t_idx + 1,
                    &p.file_name,
                    p,
                ));
                text_accum.push('\n');
            }
        }

        flush_text(&mut text_accum, &mut blocks);

        Ok(SerializedComposerTurn {
            message: Message {
                role: Role::User,
                content: blocks,
            },
            upload_manifest,
            used_non_multimodal_fallback: !supports_multimodal,
        })
    }

    // -----------------------------------------------------------------------
    // Atomic Restart Draft Persistence (Dependency-Free Hex-Framed Record Format)
    // -----------------------------------------------------------------------

    pub fn save_to_path(&self, path: &Path) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("cannot create draft directory: {e}"))?;
        }
        let mut out = String::from("OMNIA_COMPOSER_DRAFT_V1\n");

        for p in self.payloads.values() {
            let status_tag = match &p.conversion_status {
                ConversionStatus::Ready => "READY:".to_string(),
                ConversionStatus::Pending => "PENDING:".to_string(),
                ConversionStatus::Running { progress_pct } => format!("RUNNING:{progress_pct}"),
                ConversionStatus::Complete => "COMPLETE:".to_string(),
                ConversionStatus::Cancelled => "CANCELLED:".to_string(),
                ConversionStatus::Failed { error, retryable } => {
                    format!(
                        "FAILED:{}:{}",
                        u8::from(*retryable),
                        hex_encode(error.as_bytes())
                    )
                }
                ConversionStatus::UnsupportedOrEncrypted { reason } => {
                    format!("UNSUPPORTED:{}", hex_encode(reason.as_bytes()))
                }
            };
            let kind_code = media_kind_to_code(p.media_kind);
            let b64_hex = hex_encode(p.raw_bytes_base64.as_deref().unwrap_or("").as_bytes());
            let ext_hex = hex_encode(p.extracted_text.as_deref().unwrap_or("").as_bytes());
            out.push_str(&format!(
                "PAYLOAD\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\n",
                p.payload_id,
                p.original_sha256,
                hex_encode(p.file_name.as_bytes()),
                hex_encode(p.mime_type.as_bytes()),
                p.byte_len,
                kind_code,
                b64_hex,
                ext_hex,
                u8::from(p.failure_acknowledged),
                status_tag
            ));
        }

        for node in &self.document {
            match node {
                ComposerNode::TextSpan { text, style, block } => {
                    let flags = (u8::from(style.bold))
                        | (u8::from(style.italic) << 1)
                        | (u8::from(style.underline) << 2)
                        | (u8::from(style.inline_code) << 3)
                        | (u8::from(style.inline_latex) << 4);
                    let block_tag = encode_block_format(block);
                    out.push_str(&format!(
                        "TEXT\t{}\t{}\t{}\t{}\t{}\t{}\n",
                        flags,
                        hex_encode(style.font_family.as_deref().unwrap_or("").as_bytes()),
                        style.font_size_pt.unwrap_or(0),
                        hex_encode(style.color_hex.as_deref().unwrap_or("").as_bytes()),
                        block_tag,
                        hex_encode(text.as_bytes())
                    ));
                }
                ComposerNode::InlineAttachment {
                    instance_id,
                    payload_id,
                    alt_label,
                } => {
                    out.push_str(&format!(
                        "INLINE\t{}\t{}\t{}\n",
                        instance_id,
                        payload_id,
                        hex_encode(alt_label.as_deref().unwrap_or("").as_bytes())
                    ));
                }
                ComposerNode::Table(t) => {
                    let h_joined = t
                        .headers
                        .iter()
                        .map(|h| hex_encode(h.as_bytes()))
                        .collect::<Vec<_>>()
                        .join(",");
                    let r_joined = t
                        .rows
                        .iter()
                        .map(|r| {
                            r.iter()
                                .map(|c| hex_encode(c.as_bytes()))
                                .collect::<Vec<_>>()
                                .join(",")
                        })
                        .collect::<Vec<_>>()
                        .join(";");
                    out.push_str(&format!("TABLE\t{h_joined}\t{r_joined}\n"));
                }
            }
        }

        for t in &self.tray {
            out.push_str(&format!("TRAY\t{}\t{}\n", t.tray_item_id, t.payload_id));
        }

        let tmp = path.with_extension("draft.tmp");
        fs::write(&tmp, out).map_err(|e| format!("cannot write draft temp file: {e}"))?;
        fs::rename(&tmp, path).map_err(|e| format!("cannot atomically commit draft file: {e}"))
    }

    pub fn load_from_path(path: &Path) -> Result<Self, String> {
        let raw =
            fs::read_to_string(path).map_err(|e| format!("cannot read persisted draft: {e}"))?;
        let mut lines = raw.lines();
        let Some(header) = lines.next() else {
            return Err("empty persisted draft file".into());
        };
        if header != "OMNIA_COMPOSER_DRAFT_V1" {
            return Err(format!("unsupported draft header `{header}`"));
        }

        let mut composer = Self::new();
        for line in lines {
            if line.trim().is_empty() {
                continue;
            }
            let parts: Vec<&str> = line.split('\t').collect();
            match parts[0] {
                "PAYLOAD" if parts.len() == 11 => {
                    let payload_id = parts[1].to_string();
                    let original_sha256 = parts[2].to_string();
                    let file_name = decode_hex_utf8(parts[3])?;
                    let mime_type = decode_hex_utf8(parts[4])?;
                    let byte_len = parts[5]
                        .parse::<u64>()
                        .map_err(|_| "invalid byte_len in draft".to_string())?;
                    let media_kind = code_to_media_kind(parts[6]);
                    let b64 = decode_hex_utf8(parts[7])?;
                    let ext = decode_hex_utf8(parts[8])?;
                    let ack = parts[9] == "1";
                    let conversion_status = decode_conversion_status(parts[10])?;
                    composer.payloads.insert(
                        payload_id.clone(),
                        AttachmentPayload {
                            payload_id,
                            original_sha256,
                            file_name,
                            mime_type,
                            byte_len,
                            media_kind,
                            raw_bytes_base64: (!b64.is_empty()).then_some(b64),
                            extracted_text: (!ext.is_empty()).then_some(ext),
                            conversion_status,
                            derived: Vec::new(),
                            failure_acknowledged: ack,
                        },
                    );
                }
                "TEXT" if parts.len() == 7 => {
                    let flags = parts[1].parse::<u8>().unwrap_or(0);
                    let ff = decode_hex_utf8(parts[2])?;
                    let fsz = parts[3].parse::<u16>().unwrap_or(0);
                    let col = decode_hex_utf8(parts[4])?;
                    let block = decode_block_format(parts[5])?;
                    let text = decode_hex_utf8(parts[6])?;
                    composer.document.push(ComposerNode::TextSpan {
                        text,
                        style: TextStyle {
                            bold: (flags & 1) != 0,
                            italic: (flags & 2) != 0,
                            underline: (flags & 4) != 0,
                            inline_code: (flags & 8) != 0,
                            inline_latex: (flags & 16) != 0,
                            font_family: (!ff.is_empty()).then_some(ff),
                            font_size_pt: (fsz > 0).then_some(fsz),
                            color_hex: (!col.is_empty()).then_some(col),
                        },
                        block,
                    });
                }
                "INLINE" if parts.len() == 4 => {
                    let alt = decode_hex_utf8(parts[3])?;
                    composer.document.push(ComposerNode::InlineAttachment {
                        instance_id: parts[1].to_string(),
                        payload_id: parts[2].to_string(),
                        alt_label: (!alt.is_empty()).then_some(alt),
                    });
                }
                "TABLE" if parts.len() == 3 => {
                    let headers = if parts[1].is_empty() {
                        Vec::new()
                    } else {
                        parts[1]
                            .split(',')
                            .map(decode_hex_utf8)
                            .collect::<Result<Vec<_>, _>>()?
                    };
                    let rows = if parts[2].is_empty() {
                        Vec::new()
                    } else {
                        parts[2]
                            .split(';')
                            .map(|r| {
                                r.split(',')
                                    .map(decode_hex_utf8)
                                    .collect::<Result<Vec<_>, _>>()
                            })
                            .collect::<Result<Vec<_>, _>>()?
                    };
                    composer
                        .document
                        .push(ComposerNode::Table(ComposerTable { headers, rows }));
                }
                "TRAY" if parts.len() == 3 => {
                    composer.tray.push(TrayAttachmentRef {
                        tray_item_id: parts[1].to_string(),
                        payload_id: parts[2].to_string(),
                    });
                }
                other => return Err(format!("malformed draft record `{other}`")),
            }
        }
        Ok(composer)
    }
}

fn render_attachment_fallback_marker(
    prefix: &str,
    index: usize,
    display_name: &str,
    payload: &AttachmentPayload,
) -> String {
    let short_sha = &payload.original_sha256[..12.min(payload.original_sha256.len())];
    match &payload.conversion_status {
        ConversionStatus::UnsupportedOrEncrypted { reason } => format!(
            "[{prefix} #{index}: {display_name} ({}, {} B, sha256={short_sha}) — UNREADABLE: {reason}]",
            payload.mime_type, payload.byte_len
        ),
        _ => {
            if let Some(ext) = &payload.extracted_text {
                format!(
                    "[{prefix} #{index}: {display_name} ({}, {} B, sha256={short_sha})]\n<attachment_content id=\"{}\">\n{}\n</attachment_content>",
                    payload.mime_type,
                    payload.byte_len,
                    payload.payload_id,
                    ext.trim()
                )
            } else {
                format!(
                    "[{prefix} #{index}: {display_name} ({}, {} B, sha256={short_sha}, id={})]",
                    payload.mime_type, payload.byte_len, payload.payload_id
                )
            }
        }
    }
}

fn media_kind_to_code(kind: AttachmentMediaKind) -> &'static str {
    match kind {
        AttachmentMediaKind::Image => "img",
        AttachmentMediaKind::Screenshot => "shot",
        AttachmentMediaKind::Pdf => "pdf",
        AttachmentMediaKind::Markdown => "md",
        AttachmentMediaKind::SourceCode => "code",
        AttachmentMediaKind::StructuredData => "data",
        AttachmentMediaKind::OfficeDocument => "office",
        AttachmentMediaKind::Archive => "arch",
        AttachmentMediaKind::AudioVideo => "av",
        AttachmentMediaKind::EncryptedOrProtected => "enc",
        AttachmentMediaKind::UnsupportedBinary => "bin",
    }
}

fn code_to_media_kind(code: &str) -> AttachmentMediaKind {
    match code {
        "img" => AttachmentMediaKind::Image,
        "shot" => AttachmentMediaKind::Screenshot,
        "pdf" => AttachmentMediaKind::Pdf,
        "md" => AttachmentMediaKind::Markdown,
        "code" => AttachmentMediaKind::SourceCode,
        "data" => AttachmentMediaKind::StructuredData,
        "office" => AttachmentMediaKind::OfficeDocument,
        "arch" => AttachmentMediaKind::Archive,
        "av" => AttachmentMediaKind::AudioVideo,
        "enc" => AttachmentMediaKind::EncryptedOrProtected,
        _ => AttachmentMediaKind::UnsupportedBinary,
    }
}

fn encode_block_format(block: &BlockFormat) -> String {
    match block {
        BlockFormat::Paragraph { indent_level } => format!("P:{indent_level}"),
        BlockFormat::Title => "TITLE".to_string(),
        BlockFormat::Heading { level } => format!("H:{level}"),
        BlockFormat::BulletListItem { indent_level } => format!("UL:{indent_level}"),
        BlockFormat::NumberedListItem {
            index,
            indent_level,
        } => format!("OL:{index}:{indent_level}"),
        BlockFormat::ChecklistItem {
            checked,
            indent_level,
        } => format!("CHK:{}:{indent_level}", u8::from(*checked)),
        BlockFormat::LatexEquationBlock => "LATEX".to_string(),
        BlockFormat::MarkdownCodeBlock { language } => {
            format!("CODE:{}", hex_encode(language.as_bytes()))
        }
    }
}

fn decode_block_format(tag: &str) -> Result<BlockFormat, String> {
    if tag == "TITLE" {
        return Ok(BlockFormat::Title);
    }
    if tag == "LATEX" {
        return Ok(BlockFormat::LatexEquationBlock);
    }
    if let Some(rest) = tag.strip_prefix("P:") {
        return Ok(BlockFormat::Paragraph {
            indent_level: rest.parse().unwrap_or(0),
        });
    }
    if let Some(rest) = tag.strip_prefix("H:") {
        return Ok(BlockFormat::Heading {
            level: rest.parse().unwrap_or(1),
        });
    }
    if let Some(rest) = tag.strip_prefix("UL:") {
        return Ok(BlockFormat::BulletListItem {
            indent_level: rest.parse().unwrap_or(0),
        });
    }
    if let Some(rest) = tag.strip_prefix("OL:") {
        let mut sp = rest.split(':');
        let index = sp.next().unwrap_or("1").parse().unwrap_or(1);
        let indent_level = sp.next().unwrap_or("0").parse().unwrap_or(0);
        return Ok(BlockFormat::NumberedListItem {
            index,
            indent_level,
        });
    }
    if let Some(rest) = tag.strip_prefix("CHK:") {
        let mut sp = rest.split(':');
        let checked = sp.next() == Some("1");
        let indent_level = sp.next().unwrap_or("0").parse().unwrap_or(0);
        return Ok(BlockFormat::ChecklistItem {
            checked,
            indent_level,
        });
    }
    if let Some(rest) = tag.strip_prefix("CODE:") {
        return Ok(BlockFormat::MarkdownCodeBlock {
            language: decode_hex_utf8(rest)?,
        });
    }
    Ok(BlockFormat::default())
}

fn decode_conversion_status(tag: &str) -> Result<ConversionStatus, String> {
    if tag == "READY:" {
        return Ok(ConversionStatus::Ready);
    }
    if tag == "PENDING:" {
        return Ok(ConversionStatus::Pending);
    }
    if tag == "COMPLETE:" {
        return Ok(ConversionStatus::Complete);
    }
    if tag == "CANCELLED:" {
        return Ok(ConversionStatus::Cancelled);
    }
    if let Some(pct) = tag.strip_prefix("RUNNING:") {
        return Ok(ConversionStatus::Running {
            progress_pct: pct.parse().unwrap_or(0),
        });
    }
    if let Some(rest) = tag.strip_prefix("FAILED:") {
        let (flag, hex_err) = rest
            .split_once(':')
            .ok_or_else(|| "malformed FAILED status".to_string())?;
        return Ok(ConversionStatus::Failed {
            error: decode_hex_utf8(hex_err)?,
            retryable: flag == "1",
        });
    }
    if let Some(hex_reason) = tag.strip_prefix("UNSUPPORTED:") {
        return Ok(ConversionStatus::UnsupportedOrEncrypted {
            reason: decode_hex_utf8(hex_reason)?,
        });
    }
    Err(format!("unknown conversion status `{tag}`"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png_fixture(name: &str, seed: u8) -> IncomingAttachment {
        IncomingAttachment {
            file_name: name.to_string(),
            mime_type: "image/png".to_string(),
            bytes: vec![0x89, b'P', b'N', b'G', seed, 0x0d, 0x0a, 0x1a, 0x0a],
            is_screenshot: false,
            is_encrypted: false,
        }
    }

    #[test]
    fn symbol_palette_covers_math_physics_and_chemistry_with_unicode_previews() {
        for domain in [
            SymbolDomain::Mathematics,
            SymbolDomain::Physics,
            SymbolDomain::Chemistry,
        ] {
            let entries = search_symbol_palette("", Some(domain));
            assert!(
                entries.len() >= 3,
                "domain {domain:?} must have rich catalog"
            );
            for e in entries {
                assert!(!e.glyph_preview.is_empty());
                assert!(!e.latex_template.is_empty());
            }
        }
        assert!(!search_symbol_palette("schrodinger", None).is_empty());
        assert!(!search_symbol_palette("cân bằng hóa học", None).is_empty());
    }

    #[test]
    fn paste_cancel_never_mutates_draft_while_inline_and_tray_share_deduped_payload() {
        let mut comp = RichComposer::new();
        comp.set_plain_text("Phân tích biểu đồ ∑ x² tại đây.");
        let initial_text = comp.plain_text_projection();
        let initial_undo = comp.undo_depth();

        // 1. Begin Ctrl+V paste and cancel via Esc -> 0 mutation.
        let p_cancel = comp.begin_paste(vec![png_fixture("chart-a.png", 1)], 18);
        let cancelled = comp
            .resolve_paste(&p_cancel.paste_id, PasteDestination::Cancel)
            .unwrap();
        assert!(cancelled.is_empty());
        assert_eq!(comp.plain_text_projection(), initial_text);
        assert!(comp.payloads.is_empty());
        assert_eq!(comp.undo_depth(), initial_undo);

        // 2. Paste inline at middle of Vietnamese + math text.
        let p_inline = comp.begin_paste(vec![png_fixture("chart-a.png", 1)], 18);
        let inline_ids = comp
            .resolve_paste(&p_inline.paste_id, PasteDestination::InlineAtCaret)
            .unwrap();
        assert_eq!(inline_ids.len(), 1);
        assert_eq!(
            comp.plain_text_projection(),
            "Phân tích biểu đồ [inline:chart-a.png]∑ x² tại đây."
        );

        // 3. Paste exact same image bytes into Attachment Tray -> deduplicated payload_id!
        let p_tray = comp.begin_paste(vec![png_fixture("chart-a-copy.png", 1)], 0);
        let tray_ids = comp
            .resolve_paste(&p_tray.paste_id, PasteDestination::AttachmentTray)
            .unwrap();
        assert_eq!(tray_ids, inline_ids);
        assert_eq!(
            comp.payloads.len(),
            1,
            "identical bytes must deduplicate in payload store"
        );

        // 4. Multimodal serialization preserves reading order AND deduplicates upload_manifest!
        let turn = comp.serialize_for_provider(true).unwrap();
        assert_eq!(turn.upload_manifest.len(), 1);
        assert!(turn.upload_manifest[0].used_inline);
        assert!(turn.upload_manifest[0].used_in_tray);
        assert!(
            matches!(&turn.message.content[0], Block::Text { text } if text == "Phân tích biểu đồ ")
        );
        assert!(
            matches!(&turn.message.content[1], Block::Image { media_type, .. } if media_type == "image/png")
        );
        assert!(
            matches!(&turn.message.content[2], Block::Text { text } if text.starts_with("∑ x² tại đây."))
        );

        // 5. Non-multimodal fallback preserves explicit inline + tray markers without silent loss!
        let fallback = comp.serialize_for_provider(false).unwrap();
        assert!(fallback.used_non_multimodal_fallback);
        assert_eq!(fallback.message.content.len(), 1);
        let Block::Text { text: fb_text } = &fallback.message.content[0] else {
            panic!("expected text fallback block");
        };
        assert!(fb_text.contains("[Inline Attachment #2: chart-a.png"));
        assert!(fb_text.contains("[Tray Attachments]"));
    }

    #[test]
    fn drag_drop_zones_and_start_end_multi_file_ordering() {
        let mut comp = RichComposer::new();
        comp.set_plain_text("Middle");

        // Outside app -> ignored.
        comp.handle_drag_over(DropZone::OutsideApplication);
        assert_eq!(comp.live_drop_indicator, None);
        assert!(comp
            .handle_drop(
                DropZone::OutsideApplication,
                vec![png_fixture("ignored.png", 9)]
            )
            .is_empty());

        // Start of document (`caret_char_offset = 0`) with 2 ordered files.
        comp.handle_drag_over(DropZone::EditableContent {
            caret_char_offset: 0,
        });
        assert_eq!(
            comp.live_drop_indicator,
            Some(DropIndicator::InlineCaret {
                caret_char_offset: 0
            })
        );
        comp.handle_drop(
            DropZone::EditableContent {
                caret_char_offset: 0,
            },
            vec![png_fixture("first.png", 1), png_fixture("second.png", 2)],
        );

        // End of document (`caret_char_offset = usize::MAX`).
        comp.handle_drop(
            DropZone::EditableContent {
                caret_char_offset: usize::MAX,
            },
            vec![png_fixture("last.png", 3)],
        );
        assert_eq!(
            comp.plain_text_projection(),
            "[inline:first.png][inline:second.png]Middle[inline:last.png]"
        );

        // App area outside input -> tray.
        comp.handle_drop(
            DropZone::ApplicationOutsideInput,
            vec![png_fixture("tray-only.png", 4)],
        );
        assert_eq!(comp.tray.len(), 1);
    }

    #[test]
    fn conversion_states_send_readiness_encrypted_honesty_undo_redo_and_restart_persistence() {
        let mut comp = RichComposer::new();
        comp.append_styled_span(
            "Quarterly Review",
            TextStyle {
                bold: true,
                ..TextStyle::default()
            },
            BlockFormat::Heading { level: 2 },
        );
        comp.insert_symbol_at_caret("phys-schrodinger", usize::MAX, true)
            .unwrap();
        comp.append_table(ComposerTable {
            headers: vec!["Metric".into(), "Value".into()],
            rows: vec![vec!["p95".into(), "42ms".into()]],
        });

        // Add PDF (Pending conversion) + Encrypted PDF (UnsupportedOrEncrypted).
        let pdf = IncomingAttachment {
            file_name: "report.pdf".into(),
            mime_type: "application/pdf".into(),
            bytes: b"%PDF-1.7 normal body".to_vec(),
            is_screenshot: false,
            is_encrypted: false,
        };
        let enc_pdf = IncomingAttachment {
            file_name: "secret.pdf".into(),
            mime_type: "application/pdf".into(),
            bytes: b"%PDF-1.7 /Encrypt dictionary".to_vec(),
            is_screenshot: false,
            is_encrypted: false,
        };
        let ids = comp.add_attachments_to_tray(vec![pdf, enc_pdf]);
        let pdf_id = &ids[0];
        let enc_id = &ids[1];

        // While PDF is Pending, send must be blocked!
        assert!(matches!(
            comp.evaluate_send_readiness(),
            SendReadiness::BlockedPendingConversions { .. }
        ));
        assert!(comp.serialize_for_provider(true).is_err());

        // Fail conversion -> blocked until retried or acknowledged.
        comp.fail_conversion(pdf_id, "OCR worker timeout", true)
            .unwrap();
        assert!(matches!(
            comp.evaluate_send_readiness(),
            SendReadiness::BlockedUnacknowledgedFailures { .. }
        ));

        // Retry and complete conversion -> Ready!
        comp.retry_conversion(pdf_id).unwrap();
        comp.complete_conversion(pdf_id, "Extracted table summary.".into(), "pdf-extractor")
            .unwrap();
        assert_eq!(comp.evaluate_send_readiness(), SendReadiness::Ready);

        // Encrypted file must carry honest UNREADABLE notice in serialization, never fake extracted text!
        assert!(matches!(
            comp.payloads.get(enc_id).unwrap().conversion_status,
            ConversionStatus::UnsupportedOrEncrypted { .. }
        ));
        let serialized = comp.serialize_for_provider(false).unwrap();
        let Block::Text { text: wire_text } = &serialized.message.content[0] else {
            panic!("expected text");
        };
        assert!(wire_text.contains("Extracted table summary."));
        assert!(wire_text.contains("UNREADABLE:"));

        // Persist across simulated restart and reload!
        let dir = tempfile::tempdir().unwrap();
        let draft_path = dir.path().join("composer.draft");
        comp.save_to_path(&draft_path).unwrap();
        let restored = RichComposer::load_from_path(&draft_path).unwrap();
        assert_eq!(
            restored.plain_text_projection(),
            comp.plain_text_projection()
        );
        assert_eq!(restored.tray.len(), 2);
        assert_eq!(restored.evaluate_send_readiness(), SendReadiness::Ready);

        // Undo + redo roundtrip.
        let before_remove = comp.tray.len();
        assert!(comp.remove_from_tray(pdf_id));
        assert_eq!(comp.tray.len(), before_remove - 1);
        assert!(comp.undo());
        assert_eq!(comp.tray.len(), before_remove);
        assert!(comp.redo());
        assert_eq!(comp.tray.len(), before_remove - 1);
    }
}
