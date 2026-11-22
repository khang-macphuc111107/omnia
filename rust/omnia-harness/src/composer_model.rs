use omnia_core::sha256_hex;
use serde::Serialize;
use serde_json::{json, Value};

/// Prebuilt Math/Physics/Chemistry scientific template exposed by [`ComposerModel`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SymbolTemplate {
    pub id: String,
    pub category: String,
    pub label: String,
    pub latex_snippet: String,
    pub unicode_preview: String,
    pub display_mode: bool,
}

impl SymbolTemplate {
    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "category": self.category,
            "label": self.label,
            "latex_snippet": self.latex_snippet,
            "unicode_preview": self.unicode_preview,
            "display_mode": self.display_mode,
        })
    }
}

/// User choice when pasting or dropping a file into the prompt composer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttachmentPlacement {
    InlineAtCaret,
    AttachmentTray,
    Cancel,
}

impl AttachmentPlacement {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::InlineAtCaret => "InlineAtCaret",
            Self::AttachmentTray => "AttachmentTray",
            Self::Cancel => "Cancel",
        }
    }
}

/// Attachment entry tracked either inline within the prompt draft or inside the attachment tray.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComposerAttachment {
    pub id: String,
    pub filename: String,
    pub mime_type: String,
    pub byte_size: usize,
    pub sha256_hex: String,
    pub placement: AttachmentPlacement,
    pub inline_token: String,
    pub is_encrypted: bool,
    pub status: String,
}

impl ComposerAttachment {
    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "filename": self.filename,
            "mime_type": self.mime_type,
            "byte_size": self.byte_size,
            "sha256_hex": self.sha256_hex,
            "placement": self.placement.as_str(),
            "inline_token": self.inline_token,
            "is_encrypted": self.is_encrypted,
            "status": self.status,
        })
    }
}

/// Result returned by [`ComposerModel::inspect_pdf_bytes`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PdfInspection {
    pub valid_header: bool,
    pub is_encrypted: bool,
    pub status: String,
    pub extracted_preview: Option<String>,
}

impl PdfInspection {
    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "valid_header": self.valid_header,
            "is_encrypted": self.is_encrypted,
            "status": self.status,
            "extracted_preview": self.extracted_preview,
        })
    }
}

/// Outcome of handling a file paste/drop into [`ComposerModel`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PasteDecisionResult {
    pub accepted: bool,
    pub deduplicated: bool,
    pub placement: AttachmentPlacement,
    pub draft_text: String,
    pub attachment: Option<ComposerAttachment>,
}

impl PasteDecisionResult {
    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "accepted": self.accepted,
            "deduplicated": self.deduplicated,
            "placement": self.placement.as_str(),
            "draft_text": self.draft_text,
            "attachment": self.attachment.as_ref().map(ComposerAttachment::to_json),
        })
    }
}

/// Lightweight headless scientific composer state model backing [`ComposerModel`].
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ComposerModel {
    draft_text: String,
    caret_codepoint: usize,
    inline_attachments: Vec<ComposerAttachment>,
    tray_attachments: Vec<ComposerAttachment>,
}

impl ComposerModel {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Return the canonical catalog of 15 Math (`6`), Physics (`5`), and Chemistry (`4`) templates.
    #[must_use]
    pub fn templates() -> Vec<SymbolTemplate> {
        vec![
            SymbolTemplate {
                id: "math-fraction".to_owned(),
                category: "Math".to_owned(),
                label: "Fraction".to_owned(),
                latex_snippet: r"\frac{a}{b}".to_owned(),
                unicode_preview: "a/b".to_owned(),
                display_mode: false,
            },
            SymbolTemplate {
                id: "math-integral".to_owned(),
                category: "Math".to_owned(),
                label: "Definite Integral".to_owned(),
                latex_snippet: r"\int_{a}^{b} f(x)\,dx".to_owned(),
                unicode_preview: "\u{222b}_a^b f(x) dx".to_owned(),
                display_mode: true,
            },
            SymbolTemplate {
                id: "math-summation".to_owned(),
                category: "Math".to_owned(),
                label: "Summation".to_owned(),
                latex_snippet: r"\sum_{i=1}^{n} x_i".to_owned(),
                unicode_preview: "\u{2211}_{i=1}^n x_i".to_owned(),
                display_mode: true,
            },
            SymbolTemplate {
                id: "math-matrix-2x2".to_owned(),
                category: "Math".to_owned(),
                label: "2x2 Matrix".to_owned(),
                latex_snippet: r"\begin{bmatrix} a & b \\ c & d \end{bmatrix}".to_owned(),
                unicode_preview: "[a b; c d]".to_owned(),
                display_mode: true,
            },
            SymbolTemplate {
                id: "math-partial".to_owned(),
                category: "Math".to_owned(),
                label: "Partial Derivative".to_owned(),
                latex_snippet: r"\frac{\partial f}{\partial x}".to_owned(),
                unicode_preview: "\u{2202}f/\u{2202}x".to_owned(),
                display_mode: false,
            },
            SymbolTemplate {
                id: "math-limit".to_owned(),
                category: "Math".to_owned(),
                label: "Limit".to_owned(),
                latex_snippet: r"\lim_{x \to \infty} f(x)".to_owned(),
                unicode_preview: "lim_{x\u{2192}\u{221e}} f(x)".to_owned(),
                display_mode: false,
            },
            SymbolTemplate {
                id: "phys-schrodinger".to_owned(),
                category: "Physics".to_owned(),
                label: "Schrodinger Equation".to_owned(),
                latex_snippet: r"i\hbar \frac{\partial \Psi}{\partial t} = \hat{H}\Psi".to_owned(),
                unicode_preview: "i\u{210f} \u{2202}\u{03a8}/\u{2202}t = H\u{0302}\u{03a8}"
                    .to_owned(),
                display_mode: true,
            },
            SymbolTemplate {
                id: "phys-maxwell-curl".to_owned(),
                category: "Physics".to_owned(),
                label: "Maxwell Faraday Curl".to_owned(),
                latex_snippet:
                    r"\nabla \times \mathbf{E} = -\frac{\partial \mathbf{B}}{\partial t}".to_owned(),
                unicode_preview: "\u{2207}\u{00d7}E = -\u{2202}B/\u{2202}t".to_owned(),
                display_mode: true,
            },
            SymbolTemplate {
                id: "phys-lorentz".to_owned(),
                category: "Physics".to_owned(),
                label: "Lorentz Force".to_owned(),
                latex_snippet: r"\mathbf{F} = q(\mathbf{E} + \mathbf{v} \times \mathbf{B})"
                    .to_owned(),
                unicode_preview: "F = q(E + v\u{00d7}B)".to_owned(),
                display_mode: false,
            },
            SymbolTemplate {
                id: "phys-einstein-energy".to_owned(),
                category: "Physics".to_owned(),
                label: "Energy-Momentum Relation".to_owned(),
                latex_snippet: r"E^2 = (pc)^2 + (mc^2)^2".to_owned(),
                unicode_preview: "E\u{00b2} = (pc)\u{00b2} + (mc\u{00b2})\u{00b2}".to_owned(),
                display_mode: false,
            },
            SymbolTemplate {
                id: "phys-boltzmann".to_owned(),
                category: "Physics".to_owned(),
                label: "Boltzmann Entropy".to_owned(),
                latex_snippet: r"S = k_B \ln \Omega".to_owned(),
                unicode_preview: "S = k_B ln \u{03a9}".to_owned(),
                display_mode: false,
            },
            SymbolTemplate {
                id: "chem-reaction-eq".to_owned(),
                category: "Chemistry".to_owned(),
                label: "Reversible Reaction".to_owned(),
                latex_snippet: r"\mathrm{a\,A + b\,B \rightleftharpoons c\,C + d\,D}".to_owned(),
                unicode_preview: "aA + bB \u{21cc} cC + dD".to_owned(),
                display_mode: true,
            },
            SymbolTemplate {
                id: "chem-gibbs".to_owned(),
                category: "Chemistry".to_owned(),
                label: "Gibbs Free Energy".to_owned(),
                latex_snippet: r"\Delta G = \Delta H - T\Delta S".to_owned(),
                unicode_preview: "\u{0394}G = \u{0394}H - T\u{0394}S".to_owned(),
                display_mode: false,
            },
            SymbolTemplate {
                id: "chem-nernst".to_owned(),
                category: "Chemistry".to_owned(),
                label: "Nernst Equation".to_owned(),
                latex_snippet: r"E = E^{\circ} - \frac{RT}{nF}\ln Q".to_owned(),
                unicode_preview: "E = E\u{00b0} - (RT/nF) ln Q".to_owned(),
                display_mode: true,
            },
            SymbolTemplate {
                id: "chem-equilibrium".to_owned(),
                category: "Chemistry".to_owned(),
                label: "Equilibrium Constant".to_owned(),
                latex_snippet: r"K_c = \frac{[C]^c[D]^d}{[A]^a[B]^b}".to_owned(),
                unicode_preview: "K_c = [C]^c[D]^d / [A]^a[B]^b".to_owned(),
                display_mode: true,
            },
        ]
    }

    pub fn set_draft(&mut self, text: impl Into<String>, caret_codepoint: usize) {
        self.draft_text = text.into();
        let max_cp = self.draft_text.chars().count();
        self.caret_codepoint = caret_codepoint.min(max_cp);
    }

    #[must_use]
    pub fn draft_text(&self) -> &str {
        &self.draft_text
    }

    #[must_use]
    pub fn caret_codepoint(&self) -> usize {
        self.caret_codepoint
    }

    #[must_use]
    pub fn inline_attachments(&self) -> &[ComposerAttachment] {
        &self.inline_attachments
    }

    #[must_use]
    pub fn tray_attachments(&self) -> &[ComposerAttachment] {
        &self.tray_attachments
    }

    pub fn insert_template_at_caret(&mut self, template_id: &str) -> bool {
        let Some(tmpl) = Self::templates().into_iter().find(|t| t.id == template_id) else {
            return false;
        };
        let snippet = if tmpl.display_mode {
            format!("$${}$$", tmpl.latex_snippet)
        } else {
            format!("${}$", tmpl.latex_snippet)
        };
        self.insert_text_at_caret(&snippet);
        true
    }

    pub fn insert_text_at_caret(&mut self, text: &str) {
        let byte_idx = codepoint_to_byte_idx(&self.draft_text, self.caret_codepoint);
        self.draft_text.insert_str(byte_idx, text);
        self.caret_codepoint += text.chars().count();
    }

    /// Inspect raw PDF bytes for valid header and non-comment `/Encrypt` dictionary token.
    /// Never extracts plaintext when encrypted.
    #[must_use]
    pub fn inspect_pdf_bytes(bytes: &[u8]) -> PdfInspection {
        let text = String::from_utf8_lossy(bytes);
        let valid_header = text.starts_with("%PDF-");
        if !valid_header {
            return PdfInspection {
                valid_header: false,
                is_encrypted: false,
                status: "UNREADABLE: invalid PDF header".to_owned(),
                extracted_preview: None,
            };
        }
        let has_encrypt = contains_pdf_encrypt_token(&text);
        if has_encrypt {
            return PdfInspection {
                valid_header: true,
                is_encrypted: true,
                status: "UNREADABLE: encrypted PDF requires password; content was not extracted"
                    .to_owned(),
                extracted_preview: None,
            };
        }
        PdfInspection {
            valid_header: true,
            is_encrypted: false,
            status: "ready".to_owned(),
            extracted_preview: Some(omnia_core::truncate_utf8_word_safe(&text, 120)),
        }
    }

    /// Handle pasted or dropped payload into either inline caret mode, tray mode, or Cancel.
    /// `AttachmentPlacement::Cancel` guarantees strict zero mutation across text, caret, and attachments.
    pub fn handle_attachment_paste(
        &mut self,
        filename: &str,
        mime_type: &str,
        bytes: &[u8],
        choice: AttachmentPlacement,
    ) -> PasteDecisionResult {
        if choice == AttachmentPlacement::Cancel {
            return PasteDecisionResult {
                accepted: false,
                deduplicated: false,
                placement: AttachmentPlacement::Cancel,
                draft_text: self.draft_text.clone(),
                attachment: None,
            };
        }

        let digest = sha256_hex(bytes);
        if let Some(existing) = self
            .inline_attachments
            .iter()
            .chain(self.tray_attachments.iter())
            .find(|a| a.sha256_hex == digest)
            .cloned()
        {
            return PasteDecisionResult {
                accepted: true,
                deduplicated: true,
                placement: existing.placement,
                draft_text: self.draft_text.clone(),
                attachment: Some(existing),
            };
        }

        let is_pdf = mime_type.eq_ignore_ascii_case("application/pdf")
            || filename.to_ascii_lowercase().ends_with(".pdf");
        let (is_encrypted, status) = if is_pdf {
            let insp = Self::inspect_pdf_bytes(bytes);
            (insp.is_encrypted, insp.status)
        } else {
            (false, "ready".to_owned())
        };

        let next_idx = self.inline_attachments.len() + self.tray_attachments.len() + 1;
        let att_id = format!("att-{next_idx}");
        let token = if choice == AttachmentPlacement::InlineAtCaret {
            format!("[attachment:{filename}#{att_id}]")
        } else {
            String::new()
        };

        let att = ComposerAttachment {
            id: att_id,
            filename: filename.to_owned(),
            mime_type: mime_type.to_owned(),
            byte_size: bytes.len(),
            sha256_hex: digest,
            placement: choice,
            inline_token: token.clone(),
            is_encrypted,
            status,
        };

        match choice {
            AttachmentPlacement::InlineAtCaret => {
                self.insert_text_at_caret(&token);
                self.inline_attachments.push(att.clone());
            }
            AttachmentPlacement::AttachmentTray => {
                self.tray_attachments.push(att.clone());
            }
            AttachmentPlacement::Cancel => {}
        }

        PasteDecisionResult {
            accepted: true,
            deduplicated: false,
            placement: choice,
            draft_text: self.draft_text.clone(),
            attachment: Some(att),
        }
    }

    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "draft_text": self.draft_text,
            "caret_codepoint": self.caret_codepoint,
            "inline_attachments": self.inline_attachments.iter().map(ComposerAttachment::to_json).collect::<Vec<_>>(),
            "tray_attachments": self.tray_attachments.iter().map(ComposerAttachment::to_json).collect::<Vec<_>>(),
        })
    }
}

impl Serialize for ComposerModel {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.to_json().serialize(serializer)
    }
}

fn codepoint_to_byte_idx(s: &str, cp: usize) -> usize {
    s.char_indices().nth(cp).map_or(s.len(), |(idx, _)| idx)
}

fn contains_pdf_encrypt_token(text: &str) -> bool {
    for raw_line in text.lines() {
        let code_part = match raw_line.find('%') {
            Some(pos) if !raw_line.starts_with("%PDF-") => &raw_line[..pos],
            Some(_) => "",
            None => raw_line,
        };
        let mut rest = code_part;
        while let Some(pos) = rest.find("/Encrypt") {
            let after = &rest[pos + "/Encrypt".len()..];
            let next_ok = after.chars().next().is_none_or(|c| {
                c.is_ascii_whitespace() || matches!(c, '0'..='9' | '/' | '[' | '<' | '(' | '>')
            });
            if next_ok {
                return true;
            }
            rest = after;
        }
    }
    false
}
