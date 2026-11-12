#pragma once

#include <cstddef>
#include <cstdint>
#include <map>
#include <mutex>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <vector>

namespace omnia::harness {

struct ScientificTemplate {
    std::string id;
    std::string category; // "Mathematics", "Physics", "Chemistry"
    std::string title;
    std::string symbol;
    std::string latex;
    std::string description;
    std::vector<std::string> placeholders;
};

enum class PasteDestination : std::uint8_t {
    InlineAtCaret = 0,
    AttachmentTray = 1,
    Cancel = 2
};

struct InlineAttachmentChip {
    std::string instance_id;
    std::string payload_sha256;
    std::string file_name;
    std::size_t caret_offset = 0;
};

struct TrayAttachmentItem {
    std::string attachment_id;
    std::string payload_sha256;
    std::string file_name;
};

struct PdfInspectionResult {
    bool is_pdf = false;
    bool is_encrypted = false;
    std::string status; // Starts with "UNREADABLE:" when /Encrypt is detected
    std::optional<std::string> extracted_preview;
};

struct PasteOutcome {
    bool mutated = false;
    bool deduplicated = false;
    std::string payload_sha256;
    std::string status;
};

class ComposerModel {
public:
    ComposerModel();

    static const std::vector<ScientificTemplate>& templates();

    void set_draft(std::string text, std::size_t caret_offset);
    const std::string& draft_text() const noexcept { return draft_text_; }
    std::size_t caret_offset() const noexcept { return caret_offset_; }

    bool insert_template_at_caret(std::string_view template_id);

    /// Handles paste/drop of file bytes with `InlineAtCaret`, `AttachmentTray`, or `Cancel`.
    /// `PasteDestination::Cancel` guarantees 100% zero mutation of draft, caret, inline chips,
    /// tray items, and stored payload blobs. Identical payloads across inline & tray are
    /// deduplicated by BCrypt SHA-256.
    PasteOutcome handle_attachment_paste(
        std::string_view file_name,
        std::string_view mime_type,
        std::span<const std::uint8_t> bytes,
        PasteDestination destination
    );

    /// Honest PDF inspection guard: detects `/Encrypt` dictionary in PDF bytes and returns
    /// an explicit `UNREADABLE:` diagnostic rather than fabricating extracted text.
    static PdfInspectionResult inspect_pdf_bytes(std::span<const std::uint8_t> bytes);

    std::size_t unique_payload_count() const noexcept { return payloads_.size(); }
    const std::vector<InlineAttachmentChip>& inline_chips() const noexcept { return inline_chips_; }
    const std::vector<TrayAttachmentItem>& tray_items() const noexcept { return tray_items_; }

private:
    struct PayloadBlob {
        std::string sha256;
        std::string mime_type;
        std::uint64_t byte_len = 0;
        std::string extraction_status;
    };

    std::string draft_text_;
    std::size_t caret_offset_ = 0;
    std::map<std::string, PayloadBlob, std::less<>> payloads_;
    std::vector<InlineAttachmentChip> inline_chips_;
    std::vector<TrayAttachmentItem> tray_items_;
    std::uint64_t seq_ = 0;
};

// ---------------------------------------------------------------------------
// Additive Steer Queue (`ADDITIVE_INTAKE`, Zero-Drop, `token_budget = null`)
// ---------------------------------------------------------------------------

enum class SteerMode : std::uint8_t {
    AdditiveIntake = 0,
    BoundaryCorrection = 1,
    ExplicitStopOrReplace = 2
};

std::string steer_mode_to_string(SteerMode mode);
SteerMode parse_steer_mode(std::string_view raw);

struct SteerItem {
    std::string id;
    std::uint64_t seq = 0;
    std::string text;
    SteerMode mode = SteerMode::AdditiveIntake;
    std::string status = "queued"; // "in_progress", "queued", "completed", "cancelled"
    std::int64_t created_at_ms = 0;
};

class SteerQueue {
public:
    SteerQueue() = default;

    /// Appends a new steer item (`ADDITIVE_INTAKE` default) without dropping, cancelling,
    /// or overwriting any existing `in_progress` or `queued` item.
    SteerItem enqueue(
        std::string_view text,
        SteerMode mode = SteerMode::AdditiveIntake,
        std::int64_t now_ms = 0,
        std::string_view initial_status = "queued"
    );

    bool mark_status(std::string_view id, std::string_view new_status);
    std::vector<SteerItem> items() const;

    /// Global invariant: artificial token budgets are NEVER imposed (`nullopt` -> JSON `null`).
    std::optional<std::uint64_t> token_budget() const noexcept { return std::nullopt; }

private:
    mutable std::mutex mutex_;
    std::vector<SteerItem> items_;
    std::uint64_t seq_ = 0;
};

} // namespace omnia::harness
