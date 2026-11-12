#include "omnia_native/composer.hpp"

#include <algorithm>
#include <charconv>
#include <fstream>
#include <set>
#include <sstream>

namespace omnia::native {

const std::vector<SymbolEntry>& symbol_palette() {
    static const std::vector<SymbolEntry> kPalette = {
        // Mathematics (7)
        SymbolEntry{
            "math-sum",
            SymbolDomain::Mathematics,
            "∑ᵢ₌₁ⁿ xᵢ",
            "Summation",
            "\\sum_{i=1}^{n} x_i",
            {"i=1", "n", "x_i"},
            {"sum", "sigma", "series", "tổng"},
        },
        SymbolEntry{
            "math-integral",
            SymbolDomain::Mathematics,
            "∫ₐᵇ f(x) dx",
            "Definite Integral",
            "\\int_{a}^{b} f(x)\\,dx",
            {"a", "b", "f(x)", "x"},
            {"integral", "calculus", "area", "tích phân"},
        },
        SymbolEntry{
            "math-partial",
            SymbolDomain::Mathematics,
            "∂f / ∂x",
            "Partial Derivative",
            "\\frac{\\partial f}{\\partial x}",
            {"f", "x"},
            {"partial", "derivative", "gradient", "đạo hàm riêng"},
        },
        SymbolEntry{
            "math-nabla",
            SymbolDomain::Mathematics,
            "∇·F",
            "Divergence / Nabla",
            "\\nabla \\cdot \\mathbf{F}",
            {"F"},
            {"nabla", "divergence", "curl", "grad"},
        },
        SymbolEntry{
            "math-matrix-2x2",
            SymbolDomain::Mathematics,
            "[a b; c d]",
            "2×2 Matrix",
            "\\begin{bmatrix} a & b \\\\ c & d \\end{bmatrix}",
            {"a", "b", "c", "d"},
            {"matrix", "linear algebra", "ma trận"},
        },
        SymbolEntry{
            "math-limit",
            SymbolDomain::Mathematics,
            "limₙ→∞ aₙ",
            "Limit to Infinity",
            "\\lim_{n \\to \\infty} a_n",
            {"n", "\\infty", "a_n"},
            {"limit", "infinity", "giới hạn", "vô cực"},
        },
        SymbolEntry{
            "math-sqrt",
            SymbolDomain::Mathematics,
            "√(x² + y²)",
            "Euclidean Radical",
            "\\sqrt{x^2 + y^2}",
            {"x^2 + y^2"},
            {"sqrt", "root", "norm", "căn bậc hai"},
        },
        // Physics (4)
        SymbolEntry{
            "phys-schrodinger",
            SymbolDomain::Physics,
            "iℏ ∂Ψ/∂t = ĤΨ",
            "Time-Dependent Schrödinger Equation",
            "i\\hbar \\frac{\\partial}{\\partial t}\\Psi = \\hat{H}\\Psi",
            {"\\Psi", "\\hat{H}"},
            {"hbar", "quantum", "wavefunction", "schrodinger", "lượng tử"},
        },
        SymbolEntry{
            "phys-photon-energy",
            SymbolDomain::Physics,
            "ΔE = hν = hc/λ",
            "Planck Photon Energy",
            "\\Delta E = h\\nu = \\frac{hc}{\\lambda}",
            {"\\Delta E", "\\nu", "\\lambda"},
            {"planck", "photon", "wavelength", "lambda", "bước sóng"},
        },
        SymbolEntry{
            "phys-braket",
            SymbolDomain::Physics,
            "⟨ψ|Ô|φ⟩",
            "Dirac Bra-Ket Expectation",
            "\\langle \\psi \\mid \\hat{O} \\mid \\phi \\rangle",
            {"\\psi", "\\hat{O}", "\\phi"},
            {"dirac", "braket", "operator", "quantum"},
        },
        SymbolEntry{
            "phys-maxwell-flux",
            SymbolDomain::Physics,
            "Φ_B = ∬ B·dA",
            "Magnetic Flux Surface Integral",
            "\\Phi_B = \\iint_{S} \\mathbf{B} \\cdot d\\mathbf{A}",
            {"S", "\\mathbf{B}"},
            {"flux", "magnetic", "maxwell", "faraday", "từ thông"},
        },
        // Chemistry (4)
        SymbolEntry{
            "chem-equilibrium",
            SymbolDomain::Chemistry,
            "aA + bB ⇌ cC + dD",
            "Reversible Chemical Equilibrium",
            "a\\text{A} + b\\text{B} \\rightleftharpoons c\\text{C} + d\\text{D}",
            {"a\\text{A}", "b\\text{B}", "c\\text{C}", "d\\text{D}"},
            {"equilibrium", "reversible", "reaction", "cân bằng hóa học"},
        },
        SymbolEntry{
            "chem-catalytic-arrow",
            SymbolDomain::Chemistry,
            "R →[Δ, Pt] P",
            "Catalyzed Thermal Reaction",
            "\\text{Reactants} \\xrightarrow[\\text{Pt}]{\\Delta} \\text{Products}",
            {"\\text{Reactants}", "\\text{Pt}", "\\Delta", "\\text{Products}"},
            {"reaction", "catalyst", "heat", "phản ứng", "xúc tác"},
        },
        SymbolEntry{
            "chem-pka",
            SymbolDomain::Chemistry,
            "pKₐ = −log₁₀ Kₐ",
            "Acid Dissociation Constant (pKa)",
            "\\text{p}K_a = -\\log_{10} K_a",
            {"K_a"},
            {"acid", "pka", "ph", "buffer", "hằng số phân ly"},
        },
        SymbolEntry{
            "chem-enthalpy",
            SymbolDomain::Chemistry,
            "ΔH°_rxn = ∑ΔH°_f(prod) − ∑ΔH°_f(react)",
            "Standard Reaction Enthalpy",
            "\\Delta H^\\circ_{\\text{rxn}}",
            {"\\text{rxn}"},
            {"enthalpy", "thermodynamics", "hess", "nhiệt phản ứng"},
        },
    };
    return kPalette;
}

std::vector<const SymbolEntry*> search_symbol_palette(
    std::string_view query,
    std::optional<SymbolDomain> domain) {
    const std::string needle = to_lower_utf8(trim_ascii(query));
    std::vector<const SymbolEntry*> matches;
    for (const auto& entry : symbol_palette()) {
        if (domain.has_value() && entry.domain != *domain) {
            continue;
        }
        if (needle.empty()) {
            matches.push_back(&entry);
            continue;
        }
        bool hit = (entry.id.find(needle) != std::string_view::npos) ||
                   (to_lower_utf8(entry.title).find(needle) != std::string::npos) ||
                   (to_lower_utf8(entry.glyph_preview).find(needle) != std::string::npos) ||
                   (to_lower_utf8(entry.latex_template).find(needle) != std::string::npos);
        if (!hit) {
            for (const auto kw : entry.keywords) {
                if (to_lower_utf8(kw).find(needle) != std::string::npos) {
                    hit = true;
                    break;
                }
            }
        }
        if (hit) {
            matches.push_back(&entry);
        }
    }
    return matches;
}

std::string ComposerTable::to_markdown() const {
    if (headers.empty()) {
        return {};
    }
    std::string out = "| ";
    for (size_t i = 0; i < headers.size(); ++i) {
        if (i > 0) out.append(" | ");
        out.append(headers[i]);
    }
    out.append(" |\n| ");
    for (size_t i = 0; i < headers.size(); ++i) {
        if (i > 0) out.append(" | ");
        out.append("---");
    }
    out.append(" |\n");
    for (const auto& row : rows) {
        out.append("| ");
        for (size_t i = 0; i < headers.size(); ++i) {
            if (i > 0) out.append(" | ");
            if (i < row.size()) out.append(row[i]);
        }
        out.append(" |\n");
    }
    return out;
}

std::string ConversionStatus::debug_label() const {
    switch (kind) {
        case Kind::Ready: return "Ready";
        case Kind::Pending: return "Pending";
        case Kind::Running: return "Running(" + std::to_string(progress_pct) + "%)";
        case Kind::Complete: return "Complete";
        case Kind::Failed: return "Failed(" + detail + ")";
        case Kind::Cancelled: return "Cancelled";
        case Kind::UnsupportedOrEncrypted: return "UnsupportedOrEncrypted";
    }
    return "Unknown";
}

namespace {

bool is_encrypted_container(std::span<const uint8_t> bytes, std::string_view file_name) {
    const std::string lower = to_lower_utf8(file_name);
    if (lower.find(".encrypted.") != std::string::npos ||
        lower.ends_with(".gpg") ||
        lower.ends_with(".age")) {
        return true;
    }
    const std::string_view raw_sv(reinterpret_cast<const char*>(bytes.data()), bytes.size());
    if ((lower.ends_with(".pdf") || raw_sv.starts_with("%PDF-")) &&
        raw_sv.find("/Encrypt") != std::string_view::npos) {
        return true;
    }
    return false;
}

std::string_view media_kind_to_code(AttachmentMediaKind kind) noexcept {
    switch (kind) {
        case AttachmentMediaKind::Image: return "img";
        case AttachmentMediaKind::Screenshot: return "shot";
        case AttachmentMediaKind::Pdf: return "pdf";
        case AttachmentMediaKind::Markdown: return "md";
        case AttachmentMediaKind::SourceCode: return "code";
        case AttachmentMediaKind::StructuredData: return "data";
        case AttachmentMediaKind::OfficeDocument: return "office";
        case AttachmentMediaKind::Archive: return "arch";
        case AttachmentMediaKind::AudioVideo: return "av";
        case AttachmentMediaKind::EncryptedOrProtected: return "enc";
        case AttachmentMediaKind::UnsupportedBinary: return "bin";
    }
    return "bin";
}

AttachmentMediaKind code_to_media_kind(std::string_view code) noexcept {
    if (code == "img") return AttachmentMediaKind::Image;
    if (code == "shot") return AttachmentMediaKind::Screenshot;
    if (code == "pdf") return AttachmentMediaKind::Pdf;
    if (code == "md") return AttachmentMediaKind::Markdown;
    if (code == "code") return AttachmentMediaKind::SourceCode;
    if (code == "data") return AttachmentMediaKind::StructuredData;
    if (code == "office") return AttachmentMediaKind::OfficeDocument;
    if (code == "arch") return AttachmentMediaKind::Archive;
    if (code == "av") return AttachmentMediaKind::AudioVideo;
    if (code == "enc") return AttachmentMediaKind::EncryptedOrProtected;
    return AttachmentMediaKind::UnsupportedBinary;
}

std::string render_attachment_fallback_marker(
    std::string_view prefix,
    size_t index,
    std::string_view display_name,
    const AttachmentPayload& payload) {
    const std::string_view short_sha =
        std::string_view(payload.original_sha256).substr(
            0, std::min<size_t>(12, payload.original_sha256.size()));
    std::ostringstream oss;
    if (payload.conversion_status.kind == ConversionStatus::Kind::UnsupportedOrEncrypted) {
        oss << "[" << prefix << " #" << index << ": " << display_name
            << " (" << payload.mime_type << ", " << payload.byte_len
            << " B, sha256=" << short_sha << ") — UNREADABLE: "
            << payload.conversion_status.detail << "]";
    } else if (payload.extracted_text.has_value()) {
        oss << "[" << prefix << " #" << index << ": " << display_name
            << " (" << payload.mime_type << ", " << payload.byte_len
            << " B, sha256=" << short_sha << ")]\n<attachment_content id=\""
            << payload.payload_id << "\">\n"
            << trim_ascii(*payload.extracted_text)
            << "\n</attachment_content>";
    } else {
        oss << "[" << prefix << " #" << index << ": " << display_name
            << " (" << payload.mime_type << ", " << payload.byte_len
            << " B, sha256=" << short_sha << ", id=" << payload.payload_id << ")]";
    }
    return oss.str();
}

std::string encode_block_format(const BlockFormat& b) {
    switch (b.kind) {
        case BlockFormat::Kind::Paragraph:
            return "P:" + std::to_string(b.indent_level);
        case BlockFormat::Kind::Title:
            return "TITLE";
        case BlockFormat::Kind::Heading:
            return "H:" + std::to_string(b.heading_level);
        case BlockFormat::Kind::BulletListItem:
            return "UL:" + std::to_string(b.indent_level);
        case BlockFormat::Kind::NumberedListItem:
            return "OL:" + std::to_string(b.list_index) + ":" + std::to_string(b.indent_level);
        case BlockFormat::Kind::ChecklistItem:
            return "CHK:" + std::to_string(b.checked ? 1 : 0) + ":" + std::to_string(b.indent_level);
        case BlockFormat::Kind::LatexEquationBlock:
            return "LATEX";
        case BlockFormat::Kind::MarkdownCodeBlock:
            return "CODE:" + hex_encode(b.language);
    }
    return "P:0";
}

Result<BlockFormat> decode_block_format(std::string_view tag) {
    if (tag == "TITLE") {
        BlockFormat b;
        b.kind = BlockFormat::Kind::Title;
        return Result<BlockFormat>::ok(b);
    }
    if (tag == "LATEX") {
        BlockFormat b;
        b.kind = BlockFormat::Kind::LatexEquationBlock;
        return Result<BlockFormat>::ok(b);
    }
    if (tag.starts_with("P:")) {
        uint32_t v = 0;
        const auto s = tag.substr(2);
        (void)std::from_chars(s.data(), s.data() + s.size(), v);
        return Result<BlockFormat>::ok(BlockFormat::paragraph(static_cast<uint8_t>(v)));
    }
    if (tag.starts_with("H:")) {
        uint32_t v = 1;
        const auto s = tag.substr(2);
        (void)std::from_chars(s.data(), s.data() + s.size(), v);
        return Result<BlockFormat>::ok(BlockFormat::heading(static_cast<uint8_t>(v)));
    }
    if (tag.starts_with("UL:")) {
        uint32_t v = 0;
        const auto s = tag.substr(3);
        (void)std::from_chars(s.data(), s.data() + s.size(), v);
        BlockFormat b;
        b.kind = BlockFormat::Kind::BulletListItem;
        b.indent_level = static_cast<uint8_t>(v);
        return Result<BlockFormat>::ok(b);
    }
    if (tag.starts_with("OL:")) {
        const auto rest = tag.substr(3);
        const size_t c = rest.find(':');
        BlockFormat b;
        b.kind = BlockFormat::Kind::NumberedListItem;
        if (c != std::string_view::npos) {
            uint32_t idx = 1, ind = 0;
            (void)std::from_chars(rest.data(), rest.data() + c, idx);
            (void)std::from_chars(rest.data() + c + 1, rest.data() + rest.size(), ind);
            b.list_index = idx;
            b.indent_level = static_cast<uint8_t>(ind);
        }
        return Result<BlockFormat>::ok(b);
    }
    if (tag.starts_with("CHK:")) {
        const auto rest = tag.substr(4);
        const size_t c = rest.find(':');
        BlockFormat b;
        b.kind = BlockFormat::Kind::ChecklistItem;
        if (c != std::string_view::npos) {
            uint32_t ind = 0;
            b.checked = (rest.substr(0, c) == "1");
            (void)std::from_chars(rest.data() + c + 1, rest.data() + rest.size(), ind);
            b.indent_level = static_cast<uint8_t>(ind);
        }
        return Result<BlockFormat>::ok(b);
    }
    if (tag.starts_with("CODE:")) {
        auto lang = decode_hex_utf8(tag.substr(5));
        if (lang.is_err()) return Result<BlockFormat>::err(lang.error());
        BlockFormat b;
        b.kind = BlockFormat::Kind::MarkdownCodeBlock;
        b.language = std::move(lang.value());
        return Result<BlockFormat>::ok(std::move(b));
    }
    return Result<BlockFormat>::ok(BlockFormat::paragraph(0));
}

Result<ConversionStatus> decode_conversion_status(std::string_view tag) {
    if (tag == "READY:") return Result<ConversionStatus>::ok(ConversionStatus::ready());
    if (tag == "PENDING:") return Result<ConversionStatus>::ok(ConversionStatus::pending());
    if (tag == "COMPLETE:") return Result<ConversionStatus>::ok(ConversionStatus::complete());
    if (tag == "CANCELLED:") return Result<ConversionStatus>::ok(ConversionStatus::cancelled());
    if (tag.starts_with("RUNNING:")) {
        uint32_t pct = 0;
        const auto s = tag.substr(8);
        (void)std::from_chars(s.data(), s.data() + s.size(), pct);
        return Result<ConversionStatus>::ok(ConversionStatus::running(static_cast<uint8_t>(pct)));
    }
    if (tag.starts_with("FAILED:")) {
        const auto rest = tag.substr(7);
        const size_t c = rest.find(':');
        if (c == std::string_view::npos) {
            return Result<ConversionStatus>::err(
                NativeError::make("invalid_draft", "malformed FAILED status"));
        }
        auto err = decode_hex_utf8(rest.substr(c + 1));
        if (err.is_err()) return Result<ConversionStatus>::err(err.error());
        return Result<ConversionStatus>::ok(
            ConversionStatus::failed(std::move(err.value()), rest.substr(0, c) == "1"));
    }
    if (tag.starts_with("UNSUPPORTED:")) {
        auto reason = decode_hex_utf8(tag.substr(12));
        if (reason.is_err()) return Result<ConversionStatus>::err(reason.error());
        return Result<ConversionStatus>::ok(
            ConversionStatus::unsupported(std::move(reason.value())));
    }
    return Result<ConversionStatus>::err(
        NativeError::make("invalid_draft", "unknown conversion status"));
}

std::vector<std::string_view> split_sv(std::string_view s, char delim) {
    std::vector<std::string_view> parts;
    size_t start = 0;
    while (true) {
        const size_t pos = s.find(delim, start);
        if (pos == std::string_view::npos) {
            parts.push_back(s.substr(start));
            break;
        }
        parts.push_back(s.substr(start, pos - start));
        start = pos + 1;
    }
    return parts;
}

} // namespace

AttachmentMediaKind IncomingAttachment::classify_media_kind() const {
    if (is_encrypted || is_encrypted_container(bytes, file_name)) {
        return AttachmentMediaKind::EncryptedOrProtected;
    }
    if (is_screenshot) {
        return AttachmentMediaKind::Screenshot;
    }
    const std::string mime = to_lower_utf8(mime_type);
    const std::string lower = to_lower_utf8(file_name);
    if (mime.starts_with("image/")) {
        return AttachmentMediaKind::Image;
    }
    if (mime == "application/pdf" || lower.ends_with(".pdf")) {
        return AttachmentMediaKind::Pdf;
    }
    if (lower.ends_with(".md") || mime == "text/markdown") {
        return AttachmentMediaKind::Markdown;
    }
    if (lower.ends_with(".rs") || lower.ends_with(".ts") || lower.ends_with(".py") ||
        lower.ends_with(".js") || lower.ends_with(".c") || lower.ends_with(".cpp") ||
        lower.ends_with(".hpp") || lower.ends_with(".h")) {
        return AttachmentMediaKind::SourceCode;
    }
    if (lower.ends_with(".json") || lower.ends_with(".csv") || lower.ends_with(".toml") ||
        lower.ends_with(".yaml") || lower.ends_with(".yml")) {
        return AttachmentMediaKind::StructuredData;
    }
    if (lower.ends_with(".docx") || lower.ends_with(".xlsx") || lower.ends_with(".pptx")) {
        return AttachmentMediaKind::OfficeDocument;
    }
    if (lower.ends_with(".zip") || lower.ends_with(".7z") || lower.ends_with(".tar.gz")) {
        return AttachmentMediaKind::Archive;
    }
    if (mime.starts_with("audio/") || mime.starts_with("video/")) {
        return AttachmentMediaKind::AudioVideo;
    }
    if (mime.starts_with("text/")) {
        return AttachmentMediaKind::Markdown;
    }
    return AttachmentMediaKind::UnsupportedBinary;
}

// ---------------------------------------------------------------------------
// RichComposer
// ---------------------------------------------------------------------------

RichComposer::Snapshot RichComposer::capture_snapshot() const {
    return Snapshot{document, tray, payloads};
}

void RichComposer::record_undo_checkpoint() {
    if (undo_stack_.size() >= max_undo_depth_) {
        undo_stack_.erase(undo_stack_.begin());
    }
    undo_stack_.push_back(capture_snapshot());
    redo_stack_.clear();
}

bool RichComposer::undo() {
    if (undo_stack_.empty()) {
        return false;
    }
    Snapshot prev = std::move(undo_stack_.back());
    undo_stack_.pop_back();
    redo_stack_.push_back(capture_snapshot());
    document = std::move(prev.document);
    tray = std::move(prev.tray);
    payloads = std::move(prev.payloads);
    return true;
}

bool RichComposer::redo() {
    if (redo_stack_.empty()) {
        return false;
    }
    Snapshot next = std::move(redo_stack_.back());
    redo_stack_.pop_back();
    undo_stack_.push_back(capture_snapshot());
    document = std::move(next.document);
    tray = std::move(next.tray);
    payloads = std::move(next.payloads);
    return true;
}

void RichComposer::set_plain_text(std::string_view text) {
    record_undo_checkpoint();
    document.clear();
    if (!text.empty()) {
        document.push_back(ComposerNode::make_text(std::string(text)));
    }
}

void RichComposer::append_styled_span(std::string text, TextStyle style, BlockFormat block) {
    if (text.empty()) {
        return;
    }
    record_undo_checkpoint();
    document.push_back(ComposerNode::make_text(std::move(text), std::move(style), std::move(block)));
}

void RichComposer::append_table(ComposerTable table) {
    record_undo_checkpoint();
    document.push_back(ComposerNode::make_table(std::move(table)));
}

size_t RichComposer::total_logical_positions() const noexcept {
    size_t sum = 0;
    for (const auto& node : document) {
        if (node.kind == ComposerNode::Kind::TextSpan) {
            sum += utf8_char_count(node.text);
        } else {
            sum += 1;
        }
    }
    return sum;
}

std::string RichComposer::plain_text_projection() const {
    std::string out;
    for (const auto& node : document) {
        switch (node.kind) {
            case ComposerNode::Kind::TextSpan:
                out.append(node.text);
                break;
            case ComposerNode::Kind::Table:
                out.append(node.table.to_markdown());
                break;
            case ComposerNode::Kind::InlineAttachment: {
                const auto it = payloads.find(node.payload_id);
                const std::string_view label =
                    (it != payloads.end()) ? std::string_view(it->second.file_name)
                                           : std::string_view(node.payload_id);
                out.append("[inline:");
                out.append(label);
                out.push_back(']');
                break;
            }
        }
    }
    return out;
}

Result<std::string> RichComposer::insert_symbol_at_caret(
    std::string_view symbol_id,
    size_t caret_offset,
    bool as_latex) {
    const SymbolEntry* found = nullptr;
    for (const auto& entry : symbol_palette()) {
        if (entry.id == symbol_id) {
            found = &entry;
            break;
        }
    }
    if (!found) {
        return Result<std::string>::err(
            NativeError::invalid("symbol_id", "unknown symbol palette id"));
    }
    std::string snippet = as_latex
        ? ("$" + std::string(found->latex_template) + "$")
        : std::string(found->glyph_preview);
    TextStyle st;
    st.inline_latex = as_latex;
    record_undo_checkpoint();
    insert_nodes_at_offset(caret_offset, {ComposerNode::make_text(snippet, st)});
    return Result<std::string>::ok(std::move(snippet));
}

std::string RichComposer::ingest_payload(IncomingAttachment incoming) {
    const std::string digest = sha256_hex(incoming.bytes);
    const std::string payload_id = "att-" + digest.substr(0, 24);
    if (payloads.contains(payload_id)) {
        return payload_id;
    }

    const AttachmentMediaKind media_kind = incoming.classify_media_kind();
    std::optional<std::string> raw_b64;
    if (media_kind == AttachmentMediaKind::Image || media_kind == AttachmentMediaKind::Screenshot) {
        raw_b64 = base64_encode(incoming.bytes);
    }

    std::optional<std::string> extracted;
    ConversionStatus conv = ConversionStatus::ready();
    std::vector<DerivedRepresentation> derived;

    switch (media_kind) {
        case AttachmentMediaKind::Image:
        case AttachmentMediaKind::Screenshot:
            conv = ConversionStatus::ready();
            break;
        case AttachmentMediaKind::Markdown:
        case AttachmentMediaKind::SourceCode:
        case AttachmentMediaKind::StructuredData: {
            std::string txt(
                reinterpret_cast<const char*>(incoming.bytes.data()),
                incoming.bytes.size());
            const std::string dhash = sha256_hex(txt);
            const std::string preview = utf8_take_chars(txt, 160);
            extracted = std::move(txt);
            conv = ConversionStatus::complete();
            derived.push_back(DerivedRepresentation{
                "utf8_text",
                "text/plain",
                dhash,
                "native-utf8-decoder",
                preview,
            });
            break;
        }
        case AttachmentMediaKind::Pdf:
        case AttachmentMediaKind::OfficeDocument:
        case AttachmentMediaKind::Archive:
        case AttachmentMediaKind::AudioVideo:
            conv = ConversionStatus::pending();
            break;
        case AttachmentMediaKind::EncryptedOrProtected:
            conv = ConversionStatus::unsupported(
                "Attachment is encrypted or password-protected; Omnia cannot inspect its contents without decryption.");
            break;
        case AttachmentMediaKind::UnsupportedBinary:
            conv = ConversionStatus::unsupported(
                "Unsupported binary format (`" + incoming.mime_type +
                "`); raw file metadata recorded without claiming content extraction.");
            break;
    }

    payloads.emplace(
        payload_id,
        AttachmentPayload{
            payload_id,
            digest,
            std::move(incoming.file_name),
            std::move(incoming.mime_type),
            static_cast<uint64_t>(incoming.bytes.size()),
            media_kind,
            std::move(raw_b64),
            std::move(extracted),
            std::move(conv),
            std::move(derived),
            false,
        });
    return payload_id;
}

PendingPastePrompt RichComposer::begin_paste(
    std::vector<IncomingAttachment> files,
    size_t caret_char_offset) {
    PendingPastePrompt prompt{
        "paste-" + uuid_v4(),
        caret_char_offset,
        std::move(files),
    };
    pending_paste = prompt;
    return prompt;
}

Result<std::vector<std::string>> RichComposer::resolve_paste(
    std::string_view paste_id,
    PasteDestination choice) {
    if (!pending_paste.has_value()) {
        return Result<std::vector<std::string>>::err(
            NativeError::invalid("paste_id", "no active paste prompt"));
    }
    if (pending_paste->paste_id != paste_id) {
        return Result<std::vector<std::string>>::err(
            NativeError::invalid("paste_id", "does not match active prompt"));
    }
    PendingPastePrompt pending = std::move(*pending_paste);
    pending_paste.reset();

    switch (choice) {
        case PasteDestination::Cancel:
            return Result<std::vector<std::string>>::ok({});
        case PasteDestination::InlineAtCaret:
            return Result<std::vector<std::string>>::ok(
                insert_attachments_inline(pending.caret_char_offset, std::move(pending.candidate_files)));
        case PasteDestination::AttachmentTray:
            return Result<std::vector<std::string>>::ok(
                add_attachments_to_tray(std::move(pending.candidate_files)));
    }
    return Result<std::vector<std::string>>::ok({});
}

void RichComposer::handle_drag_over(DropZone zone) {
    switch (zone.kind) {
        case DropZone::Kind::EditableContent:
            live_drop_indicator = DropIndicator{DropIndicator::Kind::InlineCaret, zone.caret_char_offset};
            break;
        case DropZone::Kind::ApplicationOutsideInput:
            live_drop_indicator = DropIndicator{DropIndicator::Kind::AttachmentTrayHighlight, 0};
            break;
        case DropZone::Kind::OutsideApplication:
            live_drop_indicator.reset();
            break;
    }
}

std::vector<std::string> RichComposer::handle_drop(
    DropZone zone,
    std::vector<IncomingAttachment> files) {
    live_drop_indicator.reset();
    if (files.empty()) {
        return {};
    }
    switch (zone.kind) {
        case DropZone::Kind::EditableContent:
            return insert_attachments_inline(zone.caret_char_offset, std::move(files));
        case DropZone::Kind::ApplicationOutsideInput:
            return add_attachments_to_tray(std::move(files));
        case DropZone::Kind::OutsideApplication:
            return {};
    }
    return {};
}

std::vector<std::string> RichComposer::insert_attachments_inline(
    size_t caret_char_offset,
    std::vector<IncomingAttachment> files) {
    if (files.empty()) {
        return {};
    }
    record_undo_checkpoint();
    std::vector<std::string> ids;
    std::vector<ComposerNode> nodes;
    ids.reserve(files.size());
    nodes.reserve(files.size());
    for (auto& file : files) {
        std::string label = file.file_name;
        std::string pid = ingest_payload(std::move(file));
        ids.push_back(pid);
        nodes.push_back(ComposerNode::make_inline_attachment(
            "inl-" + uuid_v4(),
            std::move(pid),
            std::move(label)));
    }
    insert_nodes_at_offset(caret_char_offset, nodes);
    return ids;
}

std::vector<std::string> RichComposer::add_attachments_to_tray(
    std::vector<IncomingAttachment> files) {
    if (files.empty()) {
        return {};
    }
    record_undo_checkpoint();
    std::vector<std::string> ids;
    ids.reserve(files.size());
    for (auto& file : files) {
        std::string pid = ingest_payload(std::move(file));
        const bool already = std::any_of(tray.begin(), tray.end(), [&](const TrayAttachmentRef& r) {
            return r.payload_id == pid;
        });
        if (!already) {
            tray.push_back(TrayAttachmentRef{"tray-" + uuid_v4(), pid});
        }
        ids.push_back(std::move(pid));
    }
    return ids;
}

void RichComposer::insert_nodes_at_offset(
    size_t caret_char_offset,
    const std::vector<ComposerNode>& new_nodes) {
    if (document.empty()) {
        document = new_nodes;
        return;
    }

    size_t remaining = caret_char_offset;
    std::vector<ComposerNode> rebuilt;
    rebuilt.reserve(document.size() + new_nodes.size() + 1);
    bool inserted = false;

    for (auto& node : document) {
        if (inserted) {
            rebuilt.push_back(std::move(node));
            continue;
        }
        if (node.kind == ComposerNode::Kind::TextSpan) {
            const size_t char_len = utf8_char_count(node.text);
            if (remaining == 0) {
                rebuilt.insert(rebuilt.end(), new_nodes.begin(), new_nodes.end());
                rebuilt.push_back(std::move(node));
                inserted = true;
            } else if (remaining < char_len) {
                auto [prefix, suffix] = utf8_split_at_char(node.text, remaining);
                rebuilt.push_back(ComposerNode::make_text(std::move(prefix), node.style, node.block));
                rebuilt.insert(rebuilt.end(), new_nodes.begin(), new_nodes.end());
                rebuilt.push_back(ComposerNode::make_text(std::move(suffix), std::move(node.style), std::move(node.block)));
                inserted = true;
            } else {
                remaining -= char_len;
                rebuilt.push_back(std::move(node));
            }
        } else {
            if (remaining == 0) {
                rebuilt.insert(rebuilt.end(), new_nodes.begin(), new_nodes.end());
                rebuilt.push_back(std::move(node));
                inserted = true;
            } else {
                remaining -= 1;
                rebuilt.push_back(std::move(node));
            }
        }
    }

    if (!inserted) {
        rebuilt.insert(rebuilt.end(), new_nodes.begin(), new_nodes.end());
    }
    document = std::move(rebuilt);
}

Result<std::string> RichComposer::move_inline_to_tray(std::string_view instance_id) {
    const auto it = std::find_if(document.begin(), document.end(), [&](const ComposerNode& n) {
        return n.kind == ComposerNode::Kind::InlineAttachment && n.instance_id == instance_id;
    });
    if (it == document.end()) {
        return Result<std::string>::err(
            NativeError::invalid("instance_id", "inline attachment not found"));
    }
    record_undo_checkpoint();
    std::string pid = it->payload_id;
    document.erase(it);
    const bool already = std::any_of(tray.begin(), tray.end(), [&](const TrayAttachmentRef& r) {
        return r.payload_id == pid;
    });
    if (!already) {
        tray.push_back(TrayAttachmentRef{"tray-" + uuid_v4(), pid});
    }
    return Result<std::string>::ok(std::move(pid));
}

Result<std::string> RichComposer::copy_tray_to_inline(
    std::string_view payload_id,
    size_t caret_char_offset) {
    const auto it = payloads.find(payload_id);
    if (it == payloads.end()) {
        return Result<std::string>::err(
            NativeError::invalid("payload_id", "payload not found"));
    }
    std::string inst = "inl-" + uuid_v4();
    record_undo_checkpoint();
    insert_nodes_at_offset(
        caret_char_offset,
        {ComposerNode::make_inline_attachment(inst, std::string(payload_id), it->second.file_name)});
    return Result<std::string>::ok(std::move(inst));
}

bool RichComposer::remove_inline(std::string_view instance_id) {
    const auto exists = std::any_of(document.begin(), document.end(), [&](const ComposerNode& n) {
        return n.kind == ComposerNode::Kind::InlineAttachment && n.instance_id == instance_id;
    });
    if (!exists) return false;
    record_undo_checkpoint();
    std::erase_if(document, [&](const ComposerNode& n) {
        return n.kind == ComposerNode::Kind::InlineAttachment && n.instance_id == instance_id;
    });
    gc_unreferenced_payloads();
    return true;
}

bool RichComposer::remove_from_tray(std::string_view payload_id) {
    const auto exists = std::any_of(tray.begin(), tray.end(), [&](const TrayAttachmentRef& r) {
        return r.payload_id == payload_id;
    });
    if (!exists) return false;
    record_undo_checkpoint();
    std::erase_if(tray, [&](const TrayAttachmentRef& r) {
        return r.payload_id == payload_id;
    });
    gc_unreferenced_payloads();
    return true;
}

void RichComposer::gc_unreferenced_payloads() {
    std::set<std::string, std::less<>> active;
    for (const auto& n : document) {
        if (n.kind == ComposerNode::Kind::InlineAttachment) {
            active.insert(n.payload_id);
        }
    }
    for (const auto& t : tray) {
        active.insert(t.payload_id);
    }
    for (auto it = payloads.begin(); it != payloads.end();) {
        if (!active.contains(it->first)) {
            it = payloads.erase(it);
        } else {
            ++it;
        }
    }
}

Result<void> RichComposer::complete_conversion(
    std::string_view payload_id,
    std::string extracted_text,
    std::string_view converter) {
    const auto it = payloads.find(payload_id);
    if (it == payloads.end()) {
        return Result<void>::err(NativeError::invalid("payload_id", "payload not found"));
    }
    const std::string dhash = sha256_hex(extracted_text);
    const std::string preview = utf8_take_chars(extracted_text, 160);
    it->second.extracted_text = std::move(extracted_text);
    it->second.conversion_status = ConversionStatus::complete();
    it->second.derived.push_back(DerivedRepresentation{
        "extracted_markdown",
        "text/markdown",
        dhash,
        std::string(converter),
        preview,
    });
    return Result<void>::ok();
}

Result<void> RichComposer::fail_conversion(
    std::string_view payload_id,
    std::string error,
    bool retryable) {
    const auto it = payloads.find(payload_id);
    if (it == payloads.end()) {
        return Result<void>::err(NativeError::invalid("payload_id", "payload not found"));
    }
    it->second.conversion_status = ConversionStatus::failed(std::move(error), retryable);
    it->second.failure_acknowledged = false;
    return Result<void>::ok();
}

Result<void> RichComposer::cancel_conversion(std::string_view payload_id) {
    const auto it = payloads.find(payload_id);
    if (it == payloads.end()) {
        return Result<void>::err(NativeError::invalid("payload_id", "payload not found"));
    }
    it->second.conversion_status = ConversionStatus::cancelled();
    return Result<void>::ok();
}

Result<void> RichComposer::retry_conversion(std::string_view payload_id) {
    const auto it = payloads.find(payload_id);
    if (it == payloads.end()) {
        return Result<void>::err(NativeError::invalid("payload_id", "payload not found"));
    }
    it->second.conversion_status = ConversionStatus::pending();
    it->second.failure_acknowledged = false;
    return Result<void>::ok();
}

Result<void> RichComposer::acknowledge_failed_conversion(std::string_view payload_id) {
    const auto it = payloads.find(payload_id);
    if (it == payloads.end()) {
        return Result<void>::err(NativeError::invalid("payload_id", "payload not found"));
    }
    it->second.failure_acknowledged = true;
    return Result<void>::ok();
}

std::vector<std::string> RichComposer::referenced_payload_ids() const {
    std::vector<std::string> ordered;
    std::set<std::string, std::less<>> seen;
    for (const auto& n : document) {
        if (n.kind == ComposerNode::Kind::InlineAttachment && seen.insert(n.payload_id).second) {
            ordered.push_back(n.payload_id);
        }
    }
    for (const auto& t : tray) {
        if (seen.insert(t.payload_id).second) {
            ordered.push_back(t.payload_id);
        }
    }
    return ordered;
}

SendReadiness RichComposer::evaluate_send_readiness() const {
    if (document.empty() && tray.empty()) {
        return SendReadiness{SendReadiness::Kind::BlockedEmptyDraft, {}};
    }
    std::vector<std::string> pending;
    std::vector<std::string> failed;
    for (const auto& pid : referenced_payload_ids()) {
        const auto it = payloads.find(pid);
        if (it == payloads.end()) continue;
        const auto k = it->second.conversion_status.kind;
        if (k == ConversionStatus::Kind::Pending || k == ConversionStatus::Kind::Running) {
            pending.push_back(pid);
        } else if (
            (k == ConversionStatus::Kind::Failed ||
             k == ConversionStatus::Kind::UnsupportedOrEncrypted) &&
            !it->second.failure_acknowledged) {
            failed.push_back(pid);
        }
    }
    if (!pending.empty()) {
        return SendReadiness{SendReadiness::Kind::BlockedPendingConversions, std::move(pending)};
    }
    if (!failed.empty()) {
        return SendReadiness{SendReadiness::Kind::BlockedUnacknowledgedFailures, std::move(failed)};
    }
    return SendReadiness{SendReadiness::Kind::Ready, {}};
}

LivePreviewOutput RichComposer::render_live_preview() const {
    LivePreviewOutput out;
    for (const auto& node : document) {
        if (node.kind == ComposerNode::Kind::TextSpan) {
            std::string formatted = node.text;
            if (node.style.inline_latex) {
                std::string_view stripped = node.text;
                while (!stripped.empty() && stripped.front() == '$') stripped.remove_prefix(1);
                while (!stripped.empty() && stripped.back() == '$') stripped.remove_suffix(1);
                out.latex_expressions.emplace_back(stripped);
            } else if (node.style.inline_code) {
                formatted = "`" + formatted + "`";
            } else {
                if (node.style.bold) formatted = "**" + formatted + "**";
                if (node.style.italic) formatted = "*" + formatted + "*";
                if (node.style.underline) formatted = "<u>" + formatted + "</u>";
            }
            switch (node.block.kind) {
                case BlockFormat::Kind::Paragraph:
                    for (uint8_t i = 0; i < node.block.indent_level; ++i) {
                        out.rendered_markdown.append("> ");
                    }
                    out.rendered_markdown.append(formatted);
                    break;
                case BlockFormat::Kind::Title:
                    out.rendered_markdown.append("# " + formatted + "\n");
                    break;
                case BlockFormat::Kind::Heading: {
                    const uint8_t lvl = std::clamp<uint8_t>(node.block.heading_level, 1, 6);
                    out.rendered_markdown.append(std::string(lvl, '#') + " " + formatted + "\n");
                    break;
                }
                case BlockFormat::Kind::BulletListItem:
                    out.rendered_markdown.append(std::string(node.block.indent_level * 2u, ' '));
                    out.rendered_markdown.append("- " + formatted + "\n");
                    break;
                case BlockFormat::Kind::NumberedListItem:
                    out.rendered_markdown.append(std::string(node.block.indent_level * 2u, ' '));
                    out.rendered_markdown.append(std::to_string(node.block.list_index) + ". " + formatted + "\n");
                    break;
                case BlockFormat::Kind::ChecklistItem:
                    out.rendered_markdown.append(std::string(node.block.indent_level * 2u, ' '));
                    out.rendered_markdown.append(std::string("- [") + (node.block.checked ? "x" : " ") + "] " + formatted + "\n");
                    break;
                case BlockFormat::Kind::LatexEquationBlock:
                    out.latex_expressions.push_back(node.text);
                    out.rendered_markdown.append("\n$$\n" + std::string(trim_ascii(node.text)) + "\n$$\n");
                    break;
                case BlockFormat::Kind::MarkdownCodeBlock:
                    out.rendered_markdown.append("\n```" + node.block.language + "\n" + node.text + "\n```\n");
                    break;
            }
        } else if (node.kind == ComposerNode::Kind::Table) {
            out.rendered_markdown.push_back('\n');
            out.rendered_markdown.append(node.table.to_markdown());
        } else if (node.kind == ComposerNode::Kind::InlineAttachment) {
            std::string chip;
            const auto it = payloads.find(node.payload_id);
            if (it != payloads.end()) {
                const auto& p = it->second;
                const std::string_view label = node.alt_label.has_value()
                    ? std::string_view(*node.alt_label)
                    : std::string_view(p.file_name);
                chip = "[Inline: " + std::string(label) + " (" + p.mime_type + ", " +
                       std::to_string(p.byte_len) + " B, " + p.conversion_status.debug_label() + ")]";
            } else {
                chip = "[Inline: " + node.payload_id + "]";
            }
            out.inline_attachment_chips.push_back(chip);
            out.rendered_markdown.append(chip);
        }
    }

    for (const auto& t : tray) {
        const auto it = payloads.find(t.payload_id);
        if (it != payloads.end()) {
            const auto& p = it->second;
            out.tray_attachment_chips.push_back(
                "[Tray: " + p.file_name + " (" + p.mime_type + ", " +
                std::to_string(p.byte_len) + " B, " + p.conversion_status.debug_label() + ")]");
        } else {
            out.tray_attachment_chips.push_back("[Tray: " + t.payload_id + "]");
        }
    }
    return out;
}

Result<SerializedComposerTurn> RichComposer::serialize_for_provider(bool supports_multimodal) const {
    const auto readiness = evaluate_send_readiness();
    if (readiness.kind == SendReadiness::Kind::BlockedEmptyDraft) {
        return Result<SerializedComposerTurn>::err(
            NativeError::invalid("draft", "cannot serialize empty draft"));
    }
    if (readiness.kind == SendReadiness::Kind::BlockedPendingConversions) {
        return Result<SerializedComposerTurn>::err(
            NativeError::make("conversion_pending", "attachments still converting before send"));
    }
    if (readiness.kind == SendReadiness::Kind::BlockedUnacknowledgedFailures) {
        return Result<SerializedComposerTurn>::err(
            NativeError::make("conversion_failed", "failed attachments require retry, removal, or acknowledgement"));
    }

    std::set<std::string_view> inline_set;
    for (const auto& n : document) {
        if (n.kind == ComposerNode::Kind::InlineAttachment) {
            inline_set.insert(n.payload_id);
        }
    }
    std::set<std::string_view> tray_set;
    for (const auto& t : tray) {
        tray_set.insert(t.payload_id);
    }

    std::vector<UploadManifestEntry> manifest;
    for (const auto& pid : referenced_payload_ids()) {
        const auto it = payloads.find(pid);
        if (it == payloads.end()) continue;
        const auto& p = it->second;
        manifest.push_back(UploadManifestEntry{
            p.payload_id,
            p.original_sha256,
            p.file_name,
            p.mime_type,
            p.byte_len,
            inline_set.contains(pid),
            tray_set.contains(pid),
        });
    }

    std::vector<WireBlock> blocks;
    std::string text_accum;
    auto flush_text = [&]() {
        if (!text_accum.empty()) {
            blocks.push_back(WireBlock::make_text(std::move(text_accum)));
            text_accum.clear();
        }
    };

    for (size_t idx = 0; idx < document.size(); ++idx) {
        const auto& node = document[idx];
        if (node.kind == ComposerNode::Kind::TextSpan) {
            text_accum.append(node.text);
        } else if (node.kind == ComposerNode::Kind::Table) {
            if (!text_accum.empty() && !text_accum.ends_with('\n')) {
                text_accum.push_back('\n');
            }
            text_accum.append(node.table.to_markdown());
        } else if (node.kind == ComposerNode::Kind::InlineAttachment) {
            const auto it = payloads.find(node.payload_id);
            if (it == payloads.end()) continue;
            const auto& p = it->second;
            const std::string_view display = node.alt_label.has_value()
                ? std::string_view(*node.alt_label)
                : std::string_view(p.file_name);
            if (supports_multimodal && p.raw_bytes_base64.has_value()) {
                flush_text();
                blocks.push_back(WireBlock::make_image(p.mime_type, *p.raw_bytes_base64));
                continue;
            }
            text_accum.append(
                render_attachment_fallback_marker("Inline Attachment", idx + 1, display, p));
        }
    }

    if (!tray.empty()) {
        if (!text_accum.empty() && !text_accum.ends_with('\n')) {
            text_accum.push_back('\n');
        }
        text_accum.append("\n[Tray Attachments]\n");
        for (size_t t_idx = 0; t_idx < tray.size(); ++t_idx) {
            const auto it = payloads.find(tray[t_idx].payload_id);
            if (it == payloads.end()) continue;
            const auto& p = it->second;
            if (supports_multimodal && !inline_set.contains(p.payload_id) && p.raw_bytes_base64.has_value()) {
                text_accum.append(
                    "- Tray #" + std::to_string(t_idx + 1) + ": " + p.file_name + " (" + p.payload_id + ")\n");
                flush_text();
                blocks.push_back(WireBlock::make_image(p.mime_type, *p.raw_bytes_base64));
                continue;
            }
            text_accum.append(
                render_attachment_fallback_marker("Tray Attachment", t_idx + 1, p.file_name, p));
            text_accum.push_back('\n');
        }
    }

    flush_text();

    return Result<SerializedComposerTurn>::ok(SerializedComposerTurn{
        WireMessage{"user", std::move(blocks)},
        std::move(manifest),
        !supports_multimodal,
    });
}

Result<void> RichComposer::save_to_path(const std::filesystem::path& path) const {
    std::error_code ec;
    if (path.has_parent_path()) {
        std::filesystem::create_directories(path.parent_path(), ec);
        if (ec) {
            return Result<void>::err(
                NativeError::make("io_error", "cannot create draft directory"));
        }
    }

    std::ostringstream out;
    out << "OMNIA_COMPOSER_DRAFT_V1\n";

    for (const auto& [_, p] : payloads) {
        std::string status_tag;
        switch (p.conversion_status.kind) {
            case ConversionStatus::Kind::Ready:
                status_tag = "READY:";
                break;
            case ConversionStatus::Kind::Pending:
                status_tag = "PENDING:";
                break;
            case ConversionStatus::Kind::Running:
                status_tag = "RUNNING:" + std::to_string(p.conversion_status.progress_pct);
                break;
            case ConversionStatus::Kind::Complete:
                status_tag = "COMPLETE:";
                break;
            case ConversionStatus::Kind::Cancelled:
                status_tag = "CANCELLED:";
                break;
            case ConversionStatus::Kind::Failed:
                status_tag = "FAILED:" + std::to_string(p.conversion_status.retryable ? 1 : 0) +
                             ":" + hex_encode(p.conversion_status.detail);
                break;
            case ConversionStatus::Kind::UnsupportedOrEncrypted:
                status_tag = "UNSUPPORTED:" + hex_encode(p.conversion_status.detail);
                break;
        }
        out << "PAYLOAD\t"
            << p.payload_id << '\t'
            << p.original_sha256 << '\t'
            << hex_encode(p.file_name) << '\t'
            << hex_encode(p.mime_type) << '\t'
            << p.byte_len << '\t'
            << media_kind_to_code(p.media_kind) << '\t'
            << hex_encode(p.raw_bytes_base64.value_or("")) << '\t'
            << hex_encode(p.extracted_text.value_or("")) << '\t'
            << (p.failure_acknowledged ? 1 : 0) << '\t'
            << status_tag << '\n';
        for (const auto& d : p.derived) {
            out << "DERIVED\t"
                << p.payload_id << '\t'
                << hex_encode(d.kind) << '\t'
                << hex_encode(d.mime_type) << '\t'
                << d.derived_sha256 << '\t'
                << hex_encode(d.converter) << '\t'
                << (d.text_preview.has_value() ? "1" : "0") << '\t'
                << hex_encode(d.text_preview.value_or("")) << '\n';
        }
    }

    for (const auto& node : document) {
        if (node.kind == ComposerNode::Kind::TextSpan) {
            const uint32_t flags =
                (node.style.bold ? 1u : 0u) |
                (node.style.italic ? 2u : 0u) |
                (node.style.underline ? 4u : 0u) |
                (node.style.inline_code ? 8u : 0u) |
                (node.style.inline_latex ? 16u : 0u);
            out << "TEXT\t"
                << flags << '\t'
                << hex_encode(node.style.font_family.value_or("")) << '\t'
                << node.style.font_size_pt.value_or(0) << '\t'
                << hex_encode(node.style.color_hex.value_or("")) << '\t'
                << encode_block_format(node.block) << '\t'
                << hex_encode(node.text) << '\n';
        } else if (node.kind == ComposerNode::Kind::InlineAttachment) {
            out << "INLINE\t"
                << node.instance_id << '\t'
                << node.payload_id << '\t'
                << hex_encode(node.alt_label.value_or("")) << '\n';
        } else if (node.kind == ComposerNode::Kind::Table) {
            std::string h_joined;
            for (size_t i = 0; i < node.table.headers.size(); ++i) {
                if (i > 0) h_joined.push_back(',');
                h_joined.append(hex_encode(node.table.headers[i]));
            }
            std::string r_joined;
            for (size_t r = 0; r < node.table.rows.size(); ++r) {
                if (r > 0) r_joined.push_back(';');
                for (size_t c = 0; c < node.table.rows[r].size(); ++c) {
                    if (c > 0) r_joined.push_back(',');
                    r_joined.append(hex_encode(node.table.rows[r][c]));
                }
            }
            out << "TABLE\t" << h_joined << '\t' << r_joined << '\n';
        }
    }

    for (const auto& t : tray) {
        out << "TRAY\t" << t.tray_item_id << '\t' << t.payload_id << '\n';
    }

    std::filesystem::path tmp = path;
    tmp.replace_extension(".draft.tmp");
    {
        std::ofstream ofs(tmp, std::ios::binary | std::ios::trunc);
        if (!ofs) {
            return Result<void>::err(
                NativeError::make("io_error", "cannot write draft temp file"));
        }
        const std::string content = out.str();
        ofs.write(content.data(), static_cast<std::streamsize>(content.size()));
        if (!ofs.good()) {
            return Result<void>::err(
                NativeError::make("io_error", "cannot flush draft temp file"));
        }
    }

    std::filesystem::rename(tmp, path, ec);
    if (ec) {
        return Result<void>::err(
            NativeError::make("io_error", "cannot atomically commit draft file"));
    }
    return Result<void>::ok();
}

Result<RichComposer> RichComposer::load_from_path(const std::filesystem::path& path) {
    std::ifstream ifs(path, std::ios::binary);
    if (!ifs) {
        return Result<RichComposer>::err(
            NativeError::make("io_error", "cannot read persisted draft"));
    }
    std::ostringstream ss;
    ss << ifs.rdbuf();
    const std::string raw = ss.str();

    const auto lines = split_sv(raw, '\n');
    if (lines.empty() || trim_ascii(lines[0]) != "OMNIA_COMPOSER_DRAFT_V1") {
        return Result<RichComposer>::err(
            NativeError::make("invalid_draft", "unsupported draft header"));
    }

    RichComposer comp;
    for (size_t i = 1; i < lines.size(); ++i) {
        std::string_view line = lines[i];
        if (!line.empty() && line.back() == '\r') line.remove_suffix(1);
        if (trim_ascii(line).empty()) continue;

        const auto parts = split_sv(line, '\t');
        if (parts[0] == "PAYLOAD" && parts.size() == 11) {
            auto fn = decode_hex_utf8(parts[3]);
            auto mt = decode_hex_utf8(parts[4]);
            auto b64 = decode_hex_utf8(parts[7]);
            auto ext = decode_hex_utf8(parts[8]);
            auto st = decode_conversion_status(parts[10]);
            if (fn.is_err() || mt.is_err() || b64.is_err() || ext.is_err() || st.is_err()) {
                return Result<RichComposer>::err(
                    NativeError::make("invalid_draft", "corrupt PAYLOAD record"));
            }
            uint64_t byte_len = 0;
            (void)std::from_chars(parts[5].data(), parts[5].data() + parts[5].size(), byte_len);
            std::string pid(parts[1]);
            comp.payloads.emplace(
                pid,
                AttachmentPayload{
                    pid,
                    std::string(parts[2]),
                    std::move(fn.value()),
                    std::move(mt.value()),
                    byte_len,
                    code_to_media_kind(parts[6]),
                    b64.value().empty() ? std::nullopt : std::optional<std::string>(std::move(b64.value())),
                    ext.value().empty() ? std::nullopt : std::optional<std::string>(std::move(ext.value())),
                    std::move(st.value()),
                    {},
                    parts[9] == "1",
                });
        } else if (parts[0] == "TEXT" && parts.size() == 7) {
            uint32_t flags = 0;
            uint32_t fsz = 0;
            (void)std::from_chars(parts[1].data(), parts[1].data() + parts[1].size(), flags);
            (void)std::from_chars(parts[3].data(), parts[3].data() + parts[3].size(), fsz);
            auto ff = decode_hex_utf8(parts[2]);
            auto col = decode_hex_utf8(parts[4]);
            auto blk = decode_block_format(parts[5]);
            auto txt = decode_hex_utf8(parts[6]);
            if (ff.is_err() || col.is_err() || blk.is_err() || txt.is_err()) {
                return Result<RichComposer>::err(
                    NativeError::make("invalid_draft", "corrupt TEXT record"));
            }
            TextStyle style;
            style.bold = (flags & 1u) != 0;
            style.italic = (flags & 2u) != 0;
            style.underline = (flags & 4u) != 0;
            style.inline_code = (flags & 8u) != 0;
            style.inline_latex = (flags & 16u) != 0;
            if (!ff.value().empty()) style.font_family = std::move(ff.value());
            if (fsz > 0) style.font_size_pt = static_cast<uint16_t>(fsz);
            if (!col.value().empty()) style.color_hex = std::move(col.value());
            comp.document.push_back(
                ComposerNode::make_text(std::move(txt.value()), std::move(style), std::move(blk.value())));
        } else if (parts[0] == "INLINE" && parts.size() == 4) {
            auto alt = decode_hex_utf8(parts[3]);
            if (alt.is_err()) return Result<RichComposer>::err(alt.error());
            comp.document.push_back(ComposerNode::make_inline_attachment(
                std::string(parts[1]),
                std::string(parts[2]),
                alt.value().empty() ? std::nullopt : std::optional<std::string>(std::move(alt.value()))));
        } else if (parts[0] == "TABLE" && parts.size() == 3) {
            ComposerTable tbl;
            if (!parts[1].empty()) {
                for (const auto h_hex : split_sv(parts[1], ',')) {
                    auto h = decode_hex_utf8(h_hex);
                    if (h.is_err()) return Result<RichComposer>::err(h.error());
                    tbl.headers.push_back(std::move(h.value()));
                }
            }
            if (!parts[2].empty()) {
                for (const auto r_part : split_sv(parts[2], ';')) {
                    std::vector<std::string> row;
                    for (const auto c_hex : split_sv(r_part, ',')) {
                        auto c = decode_hex_utf8(c_hex);
                        if (c.is_err()) return Result<RichComposer>::err(c.error());
                        row.push_back(std::move(c.value()));
                    }
                    tbl.rows.push_back(std::move(row));
                }
            }
            comp.document.push_back(ComposerNode::make_table(std::move(tbl)));
        } else if (parts[0] == "DERIVED" && parts.size() == 8) {
            auto dk = decode_hex_utf8(parts[2]);
            auto dm = decode_hex_utf8(parts[3]);
            auto dc = decode_hex_utf8(parts[5]);
            auto dp = decode_hex_utf8(parts[7]);
            if (dk.is_err() || dm.is_err() || dc.is_err() || dp.is_err()) {
                return Result<RichComposer>::err(
                    NativeError::make("invalid_draft", "corrupt DERIVED record"));
            }
            const auto pit = comp.payloads.find(parts[1]);
            if (pit != comp.payloads.end()) {
                pit->second.derived.push_back(DerivedRepresentation{
                    std::move(dk.value()),
                    std::move(dm.value()),
                    std::string(parts[4]),
                    std::move(dc.value()),
                    parts[6] == "1" ? std::optional<std::string>(std::move(dp.value())) : std::nullopt,
                });
            }
        } else if (parts[0] == "TRAY" && parts.size() == 3) {
            comp.tray.push_back(TrayAttachmentRef{std::string(parts[1]), std::string(parts[2])});
        } else {
            return Result<RichComposer>::err(
                NativeError::make("invalid_draft", "malformed draft record"));
        }
    }
    return Result<RichComposer>::ok(std::move(comp));
}

} // namespace omnia::native
