#pragma once

#include "omnia_native/store.hpp"

#include <cstdint>
#include <filesystem>
#include <map>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <vector>

namespace omnia::native {

enum class SymbolDomain : uint8_t {
    Mathematics = 0,
    Physics = 1,
    Chemistry = 2,
};

struct SymbolEntry {
    std::string_view id;
    SymbolDomain domain{SymbolDomain::Mathematics};
    std::string_view glyph_preview;
    std::string_view title;
    std::string_view latex_template;
    std::vector<std::string_view> placeholders;
    std::vector<std::string_view> keywords;
};

const std::vector<SymbolEntry>& symbol_palette();
std::vector<const SymbolEntry*> search_symbol_palette(
    std::string_view query,
    std::optional<SymbolDomain> domain = std::nullopt);

struct TextStyle {
    bool bold{false};
    bool italic{false};
    bool underline{false};
    bool inline_code{false};
    bool inline_latex{false};
    std::optional<std::string> font_family;
    std::optional<uint16_t> font_size_pt;
    std::optional<std::string> color_hex;

    bool operator==(const TextStyle&) const = default;
};

struct BlockFormat {
    enum class Kind : uint8_t {
        Paragraph = 0,
        Title = 1,
        Heading = 2,
        BulletListItem = 3,
        NumberedListItem = 4,
        ChecklistItem = 5,
        LatexEquationBlock = 6,
        MarkdownCodeBlock = 7,
    };

    Kind kind{Kind::Paragraph};
    uint8_t indent_level{0};
    uint8_t heading_level{1};
    uint32_t list_index{1};
    bool checked{false};
    std::string language;

    bool operator==(const BlockFormat&) const = default;

    static BlockFormat paragraph(uint8_t indent = 0) {
        BlockFormat b;
        b.kind = Kind::Paragraph;
        b.indent_level = indent;
        return b;
    }

    static BlockFormat heading(uint8_t level) {
        BlockFormat b;
        b.kind = Kind::Heading;
        b.heading_level = level;
        return b;
    }
};

struct ComposerTable {
    std::vector<std::string> headers;
    std::vector<std::vector<std::string>> rows;

    bool operator==(const ComposerTable&) const = default;
    std::string to_markdown() const;
};

struct ComposerNode {
    enum class Kind : uint8_t {
        TextSpan = 0,
        Table = 1,
        InlineAttachment = 2,
    };

    Kind kind{Kind::TextSpan};
    std::string text;
    TextStyle style;
    BlockFormat block;
    ComposerTable table;
    std::string instance_id;
    std::string payload_id;
    std::optional<std::string> alt_label;

    bool operator==(const ComposerNode&) const = default;

    static ComposerNode make_text(std::string txt, TextStyle st = {}, BlockFormat blk = {}) {
        ComposerNode n;
        n.kind = Kind::TextSpan;
        n.text = std::move(txt);
        n.style = std::move(st);
        n.block = std::move(blk);
        return n;
    }

    static ComposerNode make_table(ComposerTable tbl) {
        ComposerNode n;
        n.kind = Kind::Table;
        n.table = std::move(tbl);
        return n;
    }

    static ComposerNode make_inline_attachment(
        std::string inst,
        std::string pid,
        std::optional<std::string> alt) {
        ComposerNode n;
        n.kind = Kind::InlineAttachment;
        n.instance_id = std::move(inst);
        n.payload_id = std::move(pid);
        n.alt_label = std::move(alt);
        return n;
    }
};

enum class AttachmentMediaKind : uint8_t {
    Image = 0,
    Screenshot = 1,
    Pdf = 2,
    Markdown = 3,
    SourceCode = 4,
    StructuredData = 5,
    OfficeDocument = 6,
    Archive = 7,
    AudioVideo = 8,
    EncryptedOrProtected = 9,
    UnsupportedBinary = 10,
};

struct ConversionStatus {
    enum class Kind : uint8_t {
        Ready = 0,
        Pending = 1,
        Running = 2,
        Complete = 3,
        Failed = 4,
        Cancelled = 5,
        UnsupportedOrEncrypted = 6,
    };

    Kind kind{Kind::Ready};
    uint8_t progress_pct{0};
    std::string detail;
    bool retryable{false};

    bool operator==(const ConversionStatus&) const = default;
    std::string debug_label() const;

    static ConversionStatus ready() { return ConversionStatus{Kind::Ready, 0, {}, false}; }
    static ConversionStatus pending() { return ConversionStatus{Kind::Pending, 0, {}, false}; }
    static ConversionStatus running(uint8_t pct) { return ConversionStatus{Kind::Running, pct, {}, false}; }
    static ConversionStatus complete() { return ConversionStatus{Kind::Complete, 0, {}, false}; }
    static ConversionStatus cancelled() { return ConversionStatus{Kind::Cancelled, 0, {}, false}; }
    static ConversionStatus failed(std::string err, bool retry) {
        return ConversionStatus{Kind::Failed, 0, std::move(err), retry};
    }
    static ConversionStatus unsupported(std::string reason) {
        return ConversionStatus{Kind::UnsupportedOrEncrypted, 0, std::move(reason), false};
    }
};

struct DerivedRepresentation {
    std::string kind;
    std::string mime_type;
    std::string derived_sha256;
    std::string converter;
    std::optional<std::string> text_preview;

    bool operator==(const DerivedRepresentation&) const = default;
};

struct AttachmentPayload {
    std::string payload_id;
    std::string original_sha256;
    std::string file_name;
    std::string mime_type;
    uint64_t byte_len{0};
    AttachmentMediaKind media_kind{AttachmentMediaKind::UnsupportedBinary};
    std::optional<std::string> raw_bytes_base64;
    std::optional<std::string> extracted_text;
    ConversionStatus conversion_status{ConversionStatus::ready()};
    std::vector<DerivedRepresentation> derived;
    bool failure_acknowledged{false};

    bool operator==(const AttachmentPayload&) const = default;
};

struct IncomingAttachment {
    std::string file_name;
    std::string mime_type;
    std::vector<uint8_t> bytes;
    bool is_screenshot{false};
    bool is_encrypted{false};

    AttachmentMediaKind classify_media_kind() const;
};

struct TrayAttachmentRef {
    std::string tray_item_id;
    std::string payload_id;

    bool operator==(const TrayAttachmentRef&) const = default;
};

enum class PasteDestination : uint8_t {
    InlineAtCaret = 0,
    AttachmentTray = 1,
    Cancel = 2,
};

struct PendingPastePrompt {
    std::string paste_id;
    size_t caret_char_offset{0};
    std::vector<IncomingAttachment> candidate_files;
};

struct DropZone {
    enum class Kind : uint8_t {
        EditableContent = 0,
        ApplicationOutsideInput = 1,
        OutsideApplication = 2,
    };
    Kind kind{Kind::OutsideApplication};
    size_t caret_char_offset{0};

    static DropZone editable_content(size_t offset) {
        return DropZone{Kind::EditableContent, offset};
    }
    static DropZone application_outside_input() {
        return DropZone{Kind::ApplicationOutsideInput, 0};
    }
    static DropZone outside_application() {
        return DropZone{Kind::OutsideApplication, 0};
    }
};

struct DropIndicator {
    enum class Kind : uint8_t {
        InlineCaret = 0,
        AttachmentTrayHighlight = 1,
    };
    Kind kind{Kind::InlineCaret};
    size_t caret_char_offset{0};

    bool operator==(const DropIndicator&) const = default;
};

struct SendReadiness {
    enum class Kind : uint8_t {
        Ready = 0,
        BlockedEmptyDraft = 1,
        BlockedPendingConversions = 2,
        BlockedUnacknowledgedFailures = 3,
    };
    Kind kind{Kind::BlockedEmptyDraft};
    std::vector<std::string> payload_ids;

    bool operator==(const SendReadiness&) const = default;
};

struct LivePreviewOutput {
    std::string rendered_markdown;
    std::vector<std::string> latex_expressions;
    std::vector<std::string> inline_attachment_chips;
    std::vector<std::string> tray_attachment_chips;
};

struct UploadManifestEntry {
    std::string payload_id;
    std::string original_sha256;
    std::string file_name;
    std::string mime_type;
    uint64_t byte_len{0};
    bool used_inline{false};
    bool used_in_tray{false};
};

struct SerializedComposerTurn {
    WireMessage message;
    std::vector<UploadManifestEntry> upload_manifest;
    bool used_non_multimodal_fallback{false};
};

class RichComposer {
public:
    RichComposer() = default;

    std::vector<ComposerNode> document;
    std::vector<TrayAttachmentRef> tray;
    std::map<std::string, AttachmentPayload, std::less<>> payloads;
    std::optional<PendingPastePrompt> pending_paste;
    std::optional<DropIndicator> live_drop_indicator;

    bool undo();
    bool redo();
    size_t undo_depth() const noexcept { return undo_stack_.size(); }
    size_t redo_depth() const noexcept { return redo_stack_.size(); }

    void set_plain_text(std::string_view text);
    void append_styled_span(std::string text, TextStyle style, BlockFormat block);
    void append_table(ComposerTable table);

    size_t total_logical_positions() const noexcept;
    std::string plain_text_projection() const;

    Result<std::string> insert_symbol_at_caret(
        std::string_view symbol_id,
        size_t caret_offset,
        bool as_latex);

    PendingPastePrompt begin_paste(
        std::vector<IncomingAttachment> files,
        size_t caret_char_offset);

    Result<std::vector<std::string>> resolve_paste(
        std::string_view paste_id,
        PasteDestination choice);

    void handle_drag_over(DropZone zone);
    std::vector<std::string> handle_drop(DropZone zone, std::vector<IncomingAttachment> files);

    std::vector<std::string> insert_attachments_inline(
        size_t caret_char_offset,
        std::vector<IncomingAttachment> files);

    std::vector<std::string> add_attachments_to_tray(std::vector<IncomingAttachment> files);

    Result<std::string> move_inline_to_tray(std::string_view instance_id);
    Result<std::string> copy_tray_to_inline(std::string_view payload_id, size_t caret_char_offset);
    bool remove_inline(std::string_view instance_id);
    bool remove_from_tray(std::string_view payload_id);

    Result<void> complete_conversion(
        std::string_view payload_id,
        std::string extracted_text,
        std::string_view converter);
    Result<void> fail_conversion(
        std::string_view payload_id,
        std::string error,
        bool retryable);
    Result<void> cancel_conversion(std::string_view payload_id);
    Result<void> retry_conversion(std::string_view payload_id);
    Result<void> acknowledge_failed_conversion(std::string_view payload_id);

    std::vector<std::string> referenced_payload_ids() const;
    SendReadiness evaluate_send_readiness() const;
    LivePreviewOutput render_live_preview() const;
    Result<SerializedComposerTurn> serialize_for_provider(bool supports_multimodal) const;

    Result<void> save_to_path(const std::filesystem::path& path) const;
    static Result<RichComposer> load_from_path(const std::filesystem::path& path);

private:
    struct Snapshot {
        std::vector<ComposerNode> document;
        std::vector<TrayAttachmentRef> tray;
        std::map<std::string, AttachmentPayload, std::less<>> payloads;
    };

    Snapshot capture_snapshot() const;
    void record_undo_checkpoint();
    std::string ingest_payload(IncomingAttachment incoming);
    void insert_nodes_at_offset(size_t caret_char_offset, const std::vector<ComposerNode>& nodes);
    void gc_unreferenced_payloads();

    std::vector<Snapshot> undo_stack_;
    std::vector<Snapshot> redo_stack_;
    size_t max_undo_depth_{128};
};

} // namespace omnia::native
