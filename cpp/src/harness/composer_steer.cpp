#include "omnia/harness/composer_steer.hpp"
#include "omnia/core/sha256.hpp"
#include "omnia/core/utf8.hpp"

#include <algorithm>
#include <cctype>
#include <stdexcept>

namespace omnia::harness {

namespace {

std::string to_lower_ascii(std::string_view s) {
    std::string out(s);
    for (char& c : out) {
        c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    }
    return out;
}

} // namespace

ComposerModel::ComposerModel() = default;

const std::vector<ScientificTemplate>& ComposerModel::templates() {
    static const std::vector<ScientificTemplate> kCatalog = {
        // Mathematics (6)
        {
            "math-sum",
            "Mathematics",
            "Finite Summation",
            "\xE2\x88\x91\xE1\xB5\xA2\xE2\x82\x8C\xE2\x82\x81\xE2\x81\xBF x\xE1\xB5\xA2",
            "\\sum_{i=1}^{n} x_i",
            "Indexed discrete series summation",
            {"i=1", "n", "x_i"}
        },
        {
            "math-integral",
            "Mathematics",
            "Improper Integral",
            "\xE2\x88\xAB\xE2\x82\x80^\xE2\x88\x9E f(x) dx",
            "\\int_0^\\infty f(x)\\,dx",
            "Continuous integral over [0, infinity)",
            {"0", "\\infty", "f(x)"}
        },
        {
            "math-partial",
            "Mathematics",
            "Partial Derivative",
            "\xE2\x88\x82" "f / \xE2\x88\x82x",
            "\\frac{\\partial f}{\\partial x}",
            "First-order multivariable partial derivative",
            {"f", "x"}
        },
        {
            "math-nabla",
            "Mathematics",
            "Vector Divergence",
            "\xE2\x88\x87\xC2\xB7" "F",
            "\\nabla \\cdot \\mathbf{F}",
            "Del operator dot product with vector field F",
            {"\\mathbf{F}"}
        },
        {
            "math-matrix-2x2",
            "Mathematics",
            "2x2 Bracket Matrix",
            "[a b; c d]",
            "\\begin{bmatrix} a & b \\\\ c & d \\end{bmatrix}",
            "Linear operator 2x2 bracketed matrix",
            {"a", "b", "c", "d"}
        },
        {
            "math-limit",
            "Mathematics",
            "Asymptotic Sequence Limit",
            "lim(n\xE2\x86\x92\xE2\x88\x9E) a_n",
            "\\lim_{n \\to \\infty} a_n",
            "Convergence limit as index approaches infinity",
            {"n", "\\infty", "a_n"}
        },
        // Physics (5)
        {
            "phys-schrodinger",
            "Physics",
            "Time-Dependent Schrodinger Equation",
            "i\xE2\x84\x8F \xE2\x88\x82\xCE\xA8/\xE2\x88\x82t = \xC4\xA4\xCE\xA8",
            "i\\hbar \\frac{\\partial}{\\partial t}\\Psi = \\hat{H}\\Psi",
            "Non-relativistic quantum state evolution",
            {"\\Psi", "\\hat{H}"}
        },
        {
            "phys-maxwell-curl",
            "Physics",
            "Maxwell-Faraday Induction",
            "\xE2\x88\x87 \xC3\x97 E = \xE2\x88\x92\xE2\x88\x82" "B/\xE2\x88\x82t",
            "\\nabla \\times \\mathbf{E} = -\\frac{\\partial \\mathbf{B}}{\\partial t}",
            "Curl of electric field induced by time-varying magnetic field",
            {"\\mathbf{E}", "\\mathbf{B}"}
        },
        {
            "phys-photon-energy",
            "Physics",
            "Planck-Einstein Photon Energy",
            "\xCE\x94" "E = h\xCE\xBD = hc/\xCE\xBB",
            "\\Delta E = h\\nu = \\frac{hc}{\\lambda}",
            "Quantized electromagnetic transition energy",
            {"\\Delta E", "\\nu", "\\lambda"}
        },
        {
            "phys-braket",
            "Physics",
            "Dirac Bra-Ket Expectation",
            "\xE2\x9F\xA8\xCF\x88|\xC3\x94|\xCF\x86\xE2\x9F\xA9",
            "\\langle \\psi \\mid \\hat{O} \\mid \\phi \\rangle",
            "Hermitian operator matrix element in Hilbert space",
            {"\\psi", "\\hat{O}", "\\phi"}
        },
        {
            "phys-maxwell-flux",
            "Physics",
            "Magnetic Surface Flux",
            "\xCE\xA6_B = \xE2\x88\xAC B\xC2\xB7" "dA",
            "\\Phi_B = \\iint_{S} \\mathbf{B} \\cdot d\\mathbf{A}",
            "Magnetic flux integrated across open surface S",
            {"S", "\\mathbf{B}"}
        },
        // Chemistry (4)
        {
            "chem-equilibrium",
            "Chemistry",
            "Reversible Chemical Equilibrium",
            "aA + bB \xE2\x87\x8C cC + dD",
            "a\\text{A} + b\\text{B} \\rightleftharpoons c\\text{C} + d\\text{D}",
            "Stoichiometric reversible reaction equilibrium",
            {"a\\text{A}", "b\\text{B}", "c\\text{C}", "d\\text{D}"}
        },
        {
            "chem-catalytic-arrow",
            "Chemistry",
            "Catalyzed Thermal Reaction",
            "R \xE2\x86\x92[\xCE\x94, Pt] P",
            "\\text{Reactants} \\xrightarrow[\\text{Pt}]{\\Delta} \\text{Products}",
            "Heterogeneous Pt-catalyzed thermal reaction pathway",
            {"\\text{Reactants}", "\\text{Pt}", "\\text{Products}"}
        },
        {
            "chem-pka",
            "Chemistry",
            "Acid Dissociation Constant (pKa)",
            "pK_a = \xE2\x88\x92log\xE2\x82\x81\xE2\x82\x80 K_a",
            "\\text{p}K_a = -\\log_{10} K_a",
            "Logarithmic measure of Bronsted acid strength",
            {"K_a"}
        },
        {
            "chem-gibbs",
            "Chemistry",
            "Gibbs Free Energy",
            "\xCE\x94G\xC2\xB0 = \xCE\x94H\xC2\xB0 \xE2\x88\x92 T\xCE\x94S\xC2\xB0",
            "\\Delta G^\\circ = \\Delta H^\\circ - T\\Delta S^\\circ",
            "Thermodynamic spontaneity criterion at constant T, P",
            {"\\Delta H^\\circ", "T", "\\Delta S^\\circ"}
        }
    };
    return kCatalog;
}

void ComposerModel::set_draft(std::string text, std::size_t caret_offset) {
    draft_text_ = std::move(text);
    caret_offset_ = std::min(caret_offset, draft_text_.size());
}

bool ComposerModel::insert_template_at_caret(std::string_view template_id) {
    for (const auto& t : templates()) {
        if (t.id == template_id) {
            const std::string snippet = "$" + t.latex + "$";
            const std::size_t pos = std::min(caret_offset_, draft_text_.size());
            draft_text_.insert(pos, snippet);
            caret_offset_ = pos + snippet.size();
            return true;
        }
    }
    return false;
}

PdfInspectionResult ComposerModel::inspect_pdf_bytes(std::span<const std::uint8_t> bytes) {
    const std::string_view raw(
        reinterpret_cast<const char*>(bytes.data()),
        bytes.size()
    );
    if (raw.size() < 5 || raw.substr(0, 5) != "%PDF-") {
        return PdfInspectionResult{false, false, "READY: non-PDF payload", std::nullopt};
    }

    // Honest /Encrypt guard: scan PDF dictionary tokens without claiming encrypted bytes were read
    std::size_t pos = 0;
    while (pos < raw.size()) {
        const std::size_t hit = raw.find("/Encrypt", pos);
        if (hit == std::string_view::npos) {
            break;
        }
        const std::size_t after = hit + 8;
        const bool token_end = (after >= raw.size()) ||
            std::isalnum(static_cast<unsigned char>(raw[after])) == 0;
        // Ignore if preceded on the same line by '%' PDF comment
        std::size_t line_start = hit;
        while (line_start > 0 && raw[line_start - 1] != '\n' && raw[line_start - 1] != '\r') {
            --line_start;
        }
        const std::string_view line_prefix = raw.substr(line_start, hit - line_start);
        if (token_end && line_prefix.find('%') == std::string_view::npos) {
            return PdfInspectionResult{
                true,
                true,
                "UNREADABLE: encrypted PDF (/Encrypt dictionary detected); password-protected contents were not extracted",
                std::nullopt
            };
        }
        pos = after;
    }

    // Extract simple literal ASCII text spans inside (...) if present, otherwise honest structural status
    std::string preview;
    for (std::size_t i = 0; i < raw.size() && preview.size() < 160; ++i) {
        if (raw[i] == '(') {
            ++i;
            while (i < raw.size() && raw[i] != ')' && preview.size() < 160) {
                const auto uc = static_cast<unsigned char>(raw[i]);
                if (uc >= 0x20U && uc < 0x7FU) {
                    preview.push_back(raw[i]);
                }
                ++i;
            }
            if (!preview.empty() && preview.back() != ' ') {
                preview.push_back(' ');
            }
        }
    }
    return PdfInspectionResult{
        true,
        false,
        "READY: unencrypted PDF verified",
        preview.empty() ? std::nullopt : std::optional<std::string>(preview)
    };
}

PasteOutcome ComposerModel::handle_attachment_paste(
    std::string_view file_name,
    std::string_view mime_type,
    std::span<const std::uint8_t> bytes,
    PasteDestination destination
) {
    // Zero-mutation invariant on Cancel (Esc / Cancel dialog)
    if (destination == PasteDestination::Cancel) {
        return PasteOutcome{false, false, "", "CANCELLED: zero draft mutation"};
    }

    const std::string digest = core::sha256_hex(bytes);
    const PdfInspectionResult pdf_check = inspect_pdf_bytes(bytes);

    const bool already_stored = (payloads_.find(digest) != payloads_.end());
    if (!already_stored) {
        payloads_.insert_or_assign(
            digest,
            PayloadBlob{
                digest,
                std::string(mime_type),
                static_cast<std::uint64_t>(bytes.size()),
                pdf_check.status
            }
        );
    }

    ++seq_;
    if (destination == PasteDestination::InlineAtCaret) {
        const std::size_t pos = std::min(caret_offset_, draft_text_.size());
        const std::string marker =
            "[[attachment:" + std::string(file_name) + "#" + digest.substr(0, 8) + "]]";
        inline_chips_.push_back(InlineAttachmentChip{
            "inline-" + std::to_string(seq_),
            digest,
            std::string(file_name),
            pos
        });
        draft_text_.insert(pos, marker);
        caret_offset_ = pos + marker.size();
    } else {
        tray_items_.push_back(TrayAttachmentItem{
            "tray-" + std::to_string(seq_),
            digest,
            std::string(file_name)
        });
    }

    return PasteOutcome{true, already_stored, digest, pdf_check.status};
}

std::string steer_mode_to_string(SteerMode mode) {
    switch (mode) {
        case SteerMode::AdditiveIntake: return "ADDITIVE_INTAKE";
        case SteerMode::BoundaryCorrection: return "BOUNDARY_CORRECTION";
        case SteerMode::ExplicitStopOrReplace: return "EXPLICIT_STOP_OR_REPLACE";
    }
    return "ADDITIVE_INTAKE";
}

SteerMode parse_steer_mode(std::string_view raw) {
    const std::string low = to_lower_ascii(raw);
    if (low == "boundary_correction") return SteerMode::BoundaryCorrection;
    if (low == "explicit_stop_or_replace" || low == "cancel") {
        return SteerMode::ExplicitStopOrReplace;
    }
    return SteerMode::AdditiveIntake;
}

SteerItem SteerQueue::enqueue(
    std::string_view text,
    SteerMode mode,
    std::int64_t now_ms,
    std::string_view initial_status
) {
    if (text.empty()) {
        throw std::invalid_argument("Steer item text must be non-empty");
    }
    std::lock_guard<std::mutex> lock(mutex_);
    ++seq_;
    SteerItem item{};
    item.id = "steer-" + std::to_string(seq_);
    item.seq = seq_;
    item.text = std::string(text);
    item.mode = mode;
    item.status = initial_status.empty() ? "queued" : std::string(initial_status);
    item.created_at_ms = now_ms;
    items_.push_back(item);
    return item;
}

bool SteerQueue::mark_status(std::string_view id, std::string_view new_status) {
    std::lock_guard<std::mutex> lock(mutex_);
    for (auto& item : items_) {
        if (item.id == id) {
            item.status = std::string(new_status);
            return true;
        }
    }
    return false;
}

std::vector<SteerItem> SteerQueue::items() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return items_;
}

} // namespace omnia::harness
