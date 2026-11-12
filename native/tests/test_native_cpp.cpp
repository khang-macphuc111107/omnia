#include "omnia_native/composer.hpp"
#include "omnia_native/session_panel.hpp"
#include "omnia_native/sessions.hpp"
#include "omnia_native/store.hpp"
#include "omnia_native/types.hpp"

#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <winsqlite/winsqlite3.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iostream>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

namespace {

using namespace omnia::native;

#define OMNIA_REQUIRE(...)                                                                \
    do {                                                                                  \
        if (!(__VA_ARGS__)) {                                                             \
            throw std::runtime_error(                                                     \
                std::string("Assertion failed at line ") + std::to_string(__LINE__) +     \
                ": " #__VA_ARGS__);                                                       \
        }                                                                                 \
    } while (false)

class TempDir {
public:
    TempDir() {
        path_ = std::filesystem::temp_directory_path() /
                ("omnia-cpp-native-test-" + uuid_v4_simple());
        std::filesystem::create_directories(path_);
    }

    ~TempDir() {
        std::error_code ec;
        std::filesystem::remove_all(path_, ec);
    }

    TempDir(const TempDir&) = delete;
    TempDir& operator=(const TempDir&) = delete;

    const std::filesystem::path& path() const noexcept { return path_; }

private:
    std::filesystem::path path_;
};

std::vector<uint8_t> read_file_bytes(const std::filesystem::path& p) {
    std::ifstream in(p, std::ios::binary);
    OMNIA_REQUIRE(in.good());
    return std::vector<uint8_t>(
        std::istreambuf_iterator<char>(in),
        std::istreambuf_iterator<char>());
}

// ---------------------------------------------------------------------------
// 1..2: Mode & Command Routing
// ---------------------------------------------------------------------------

void test_default_is_projectless_chat_projection() {
    OMNIA_REQUIRE(default_mode() == Mode::Chat);
    const std::string_view desc = mode_description(default_mode());
    OMNIA_REQUIRE(desc.starts_with("Chat / No project\n"));
    OMNIA_REQUIRE(desc.find("not persisted") != std::string_view::npos);
}

void test_command_routing_rejects_unknown_commands() {
    OMNIA_REQUIRE(mode_from_command(100) == std::nullopt);
    OMNIA_REQUIRE(mode_from_command(101) == Mode::Chat);
    OMNIA_REQUIRE(mode_from_command(102) == Mode::Browser);
    OMNIA_REQUIRE(mode_from_command(103) == Mode::Ide);
    OMNIA_REQUIRE(mode_from_command(104) == std::nullopt);
    OMNIA_REQUIRE(mode_description(Mode::Browser).starts_with("Browser\n"));
    OMNIA_REQUIRE(mode_description(Mode::Ide).starts_with("IDE\n"));
}

// ---------------------------------------------------------------------------
// 3..5: SessionForm Dirty State
// ---------------------------------------------------------------------------

SessionForm sample_form() {
    return SessionForm{"Native QA", "local/model", size_t{3}};
}

void test_unchanged_rendered_default_is_clean() {
    const auto baseline = std::optional<SessionForm>(sample_form());
    OMNIA_REQUIRE(!sample_form().changed_from(baseline));
    OMNIA_REQUIRE(!sample_form().changed_from(std::nullopt));
}

void test_every_field_is_preserved_exactly() {
    const auto baseline = std::optional<SessionForm>(sample_form());

    SessionForm space_title = sample_form();
    space_title.title = "Native QA ";
    OMNIA_REQUIRE(space_title.changed_from(baseline));

    SessionForm unicode_title = sample_form();
    unicode_title.title = "Phien thu nghiem \xF0\x9F\xA6\x80";
    OMNIA_REQUIRE(unicode_title.changed_from(baseline));

    SessionForm diff_model = sample_form();
    diff_model.model = "local/other";
    OMNIA_REQUIRE(diff_model.changed_from(baseline));

    SessionForm diff_effort = sample_form();
    diff_effort.effort_index = size_t{6};
    OMNIA_REQUIRE(diff_effort.changed_from(baseline));

    SessionForm empty_effort = sample_form();
    empty_effort.effort_index = std::nullopt;
    OMNIA_REQUIRE(empty_effort.changed_from(baseline));
}

void test_reverting_or_accepting_new_baseline_clears_dirty_state() {
    const SessionForm original = sample_form();
    SessionForm edited = original;
    edited.model = "local/unsaved";
    OMNIA_REQUIRE(edited.changed_from(std::optional<SessionForm>(original)));
    OMNIA_REQUIRE(!original.changed_from(std::optional<SessionForm>(original)));
    OMNIA_REQUIRE(!edited.changed_from(std::optional<SessionForm>(edited)));
}

// ---------------------------------------------------------------------------
// 6..9: RichComposer, Math/Phys/Chem Palette, Attachments & Persistence
// ---------------------------------------------------------------------------

IncomingAttachment make_sample_png(std::string_view name, std::span<const uint8_t> bytes) {
    return IncomingAttachment{
        std::string(name),
        "image/png",
        std::vector<uint8_t>(bytes.begin(), bytes.end()),
        false,
        false,
    };
}

void test_symbol_palette_covers_math_physics_and_chemistry_with_unicode_previews() {
    const auto& all = symbol_palette();
    OMNIA_REQUIRE(all.size() >= 15);
    OMNIA_REQUIRE(!search_symbol_palette("", SymbolDomain::Mathematics).empty());
    OMNIA_REQUIRE(!search_symbol_palette("", SymbolDomain::Physics).empty());
    OMNIA_REQUIRE(!search_symbol_palette("", SymbolDomain::Chemistry).empty());

    const auto eq_hits = search_symbol_palette("equilibrium", std::nullopt);
    OMNIA_REQUIRE(std::any_of(eq_hits.begin(), eq_hits.end(), [](const SymbolEntry* e) {
        return e->id == "chem-equilibrium";
    }));

    RichComposer composer;
    composer.set_plain_text("Reaction: ");
    const size_t caret = composer.total_logical_positions();
    auto inserted = composer.insert_symbol_at_caret("chem-equilibrium", caret, true);
    OMNIA_REQUIRE(inserted.is_ok());
    OMNIA_REQUIRE(inserted.value().find("\\rightleftharpoons") != std::string::npos);

    const auto preview = composer.render_live_preview();
    OMNIA_REQUIRE(preview.rendered_markdown.find("\\rightleftharpoons") != std::string::npos);
    OMNIA_REQUIRE(std::any_of(
        preview.latex_expressions.begin(),
        preview.latex_expressions.end(),
        [](const std::string& expr) {
            return expr.find("\\rightleftharpoons") != std::string::npos;
        }));
}

void test_paste_cancel_never_mutates_draft_while_inline_and_tray_share_deduped_payload() {
    RichComposer composer;
    composer.set_plain_text("Inspect diagram: ");
    const auto baseline_doc = composer.document;

    const uint8_t raw_bytes[] = {0x89, (uint8_t)'P', (uint8_t)'N', (uint8_t)'G', 1, 2, 3, 4};
    auto prompt = composer.begin_paste({make_sample_png("arch.png", raw_bytes)}, 8);
    auto cancelled = composer.resolve_paste(prompt.paste_id, PasteDestination::Cancel);
    OMNIA_REQUIRE(cancelled.is_ok());
    OMNIA_REQUIRE(cancelled.value().empty());
    OMNIA_REQUIRE(composer.document == baseline_doc);
    OMNIA_REQUIRE(composer.payloads.empty());
    OMNIA_REQUIRE(composer.tray.empty());

    const size_t caret = composer.total_logical_positions();
    auto prompt2 = composer.begin_paste({make_sample_png("arch.png", raw_bytes)}, caret);
    auto pids = composer.resolve_paste(prompt2.paste_id, PasteDestination::InlineAtCaret);
    OMNIA_REQUIRE(pids.is_ok());
    OMNIA_REQUIRE(pids.value().size() == 1);
    OMNIA_REQUIRE(composer.payloads.size() == 1);
    OMNIA_REQUIRE(composer.tray.empty());

    auto tray_pids = composer.add_attachments_to_tray({make_sample_png("arch-copy.png", raw_bytes)});
    OMNIA_REQUIRE(tray_pids == pids.value());
    OMNIA_REQUIRE(composer.payloads.size() == 1);
    OMNIA_REQUIRE(composer.tray.size() == 1);

    std::string inline_instance;
    for (const auto& node : composer.document) {
        if (node.kind == ComposerNode::Kind::InlineAttachment) {
            inline_instance = node.instance_id;
            break;
        }
    }
    OMNIA_REQUIRE(!inline_instance.empty());
    auto moved = composer.move_inline_to_tray(inline_instance);
    OMNIA_REQUIRE(moved.is_ok());
    OMNIA_REQUIRE(composer.tray.size() == 1);
    OMNIA_REQUIRE(composer.payloads.size() == 1);

    auto copied = composer.copy_tray_to_inline(pids.value()[0], 0);
    OMNIA_REQUIRE(copied.is_ok());
    OMNIA_REQUIRE(composer.payloads.size() == 1);
}

void test_drag_drop_zones_and_start_end_multi_file_ordering() {
    RichComposer composer;
    composer.set_plain_text(" middle ");

    composer.handle_drag_over(DropZone::editable_content(0));
    OMNIA_REQUIRE(composer.live_drop_indicator.has_value());
    OMNIA_REQUIRE(composer.live_drop_indicator->kind == DropIndicator::Kind::InlineCaret);
    OMNIA_REQUIRE(composer.live_drop_indicator->caret_char_offset == 0);

    composer.handle_drag_over(DropZone::application_outside_input());
    OMNIA_REQUIRE(composer.live_drop_indicator.has_value());
    OMNIA_REQUIRE(composer.live_drop_indicator->kind == DropIndicator::Kind::AttachmentTrayHighlight);

    composer.handle_drag_over(DropZone::outside_application());
    OMNIA_REQUIRE(!composer.live_drop_indicator.has_value());

    const uint8_t b1[] = {1};
    const uint8_t b2[] = {2};
    const uint8_t b3[] = {3};
    const uint8_t b4[] = {4};

    auto start_ids = composer.handle_drop(
        DropZone::editable_content(0),
        {make_sample_png("first.png", b1), make_sample_png("second.png", b2)});
    OMNIA_REQUIRE(start_ids.size() == 2);

    const size_t end_pos = composer.total_logical_positions();
    auto end_ids = composer.handle_drop(
        DropZone::editable_content(end_pos),
        {make_sample_png("penultimate.png", b3), make_sample_png("last.png", b4)});
    OMNIA_REQUIRE(end_ids.size() == 2);

    OMNIA_REQUIRE(composer.document.front().kind == ComposerNode::Kind::InlineAttachment);
    OMNIA_REQUIRE(composer.document.front().payload_id == start_ids[0]);
    OMNIA_REQUIRE(composer.document.back().kind == ComposerNode::Kind::InlineAttachment);
    OMNIA_REQUIRE(composer.document.back().payload_id == end_ids[1]);

    const uint8_t b5[] = {5};
    auto ignored = composer.handle_drop(
        DropZone::outside_application(),
        {make_sample_png("ignored.png", b5)});
    OMNIA_REQUIRE(ignored.empty());
}

void test_conversion_states_send_readiness_encrypted_honesty_undo_redo_and_restart_persistence() {
    TempDir dir;
    const auto draft_path = dir.path() / "composer-draft.json";

    RichComposer composer;
    TextStyle bold_style;
    bold_style.bold = true;
    composer.append_styled_span("Quarterly Spec", bold_style, BlockFormat::heading(2));
    composer.append_table(ComposerTable{
        {"Metric", "Target"},
        {{"Latency", "< 25ms"}, {"Fidelity", "100%"}},
    });

    const IncomingAttachment pdf_in{
        "paper.pdf", "application/pdf", {'%', 'P', 'D', 'F', '-', '1', '.', '7'}, false, false};
    const IncomingAttachment enc_in{
        "vault.docx",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        {0x50, 0x4B, 0x03, 0x04},
        false,
        true,
    };

    const auto ids = composer.add_attachments_to_tray({pdf_in, enc_in});
    const std::string pdf_id = ids[0];
    const std::string enc_id = ids[1];

    const auto r1 = composer.evaluate_send_readiness();
    OMNIA_REQUIRE(r1.kind == SendReadiness::Kind::BlockedPendingConversions);
    OMNIA_REQUIRE(r1.payload_ids == std::vector<std::string>{pdf_id});
    OMNIA_REQUIRE(composer.serialize_for_provider(true).is_err());

    OMNIA_REQUIRE(composer.fail_conversion(pdf_id, "OCR worker timeout", true).is_ok());
    const auto r2 = composer.evaluate_send_readiness();
    OMNIA_REQUIRE(r2.kind == SendReadiness::Kind::BlockedUnacknowledgedFailures);
    OMNIA_REQUIRE(r2.payload_ids == std::vector<std::string>{pdf_id, enc_id});

    OMNIA_REQUIRE(composer.retry_conversion(pdf_id).is_ok());
    OMNIA_REQUIRE(
        composer
            .complete_conversion(pdf_id, "Extracted Theorem 1: Convergence holds.", "native-pdf-v1")
            .is_ok());

    const auto r3 = composer.evaluate_send_readiness();
    OMNIA_REQUIRE(r3.kind == SendReadiness::Kind::BlockedUnacknowledgedFailures);
    OMNIA_REQUIRE(r3.payload_ids == std::vector<std::string>{enc_id});

    OMNIA_REQUIRE(composer.acknowledge_failed_conversion(enc_id).is_ok());
    OMNIA_REQUIRE(composer.evaluate_send_readiness().kind == SendReadiness::Kind::Ready);

    const uint8_t img_bytes[] = {0x89, (uint8_t)'P', (uint8_t)'N', (uint8_t)'G', 9, 9};
    const auto caret = composer.total_logical_positions();
    (void)composer.insert_attachments_inline(caret, {make_sample_png("plot.png", img_bytes)});
    OMNIA_REQUIRE(composer.evaluate_send_readiness().kind == SendReadiness::Kind::Ready);

    const auto multi = composer.serialize_for_provider(true);
    OMNIA_REQUIRE(multi.is_ok());
    OMNIA_REQUIRE(!multi.value().used_non_multimodal_fallback);
    OMNIA_REQUIRE(
        std::any_of(
            multi.value().message.content.begin(),
            multi.value().message.content.end(),
            [](const WireBlock& b) {
                return b.kind == WireBlock::Kind::Image && b.media_type == "image/png";
            }));
    OMNIA_REQUIRE(multi.value().upload_manifest.size() == 3);

    const auto text_only = composer.serialize_for_provider(false);
    OMNIA_REQUIRE(text_only.is_ok());
    OMNIA_REQUIRE(text_only.value().used_non_multimodal_fallback);
    OMNIA_REQUIRE(
        std::all_of(
            text_only.value().message.content.begin(),
            text_only.value().message.content.end(),
            [](const WireBlock& b) { return b.kind == WireBlock::Kind::Text; }));

    const size_t before_undo_nodes = composer.document.size();
    OMNIA_REQUIRE(composer.undo());
    OMNIA_REQUIRE(composer.document.size() < before_undo_nodes);
    OMNIA_REQUIRE(composer.redo());
    OMNIA_REQUIRE(composer.document.size() == before_undo_nodes);

    OMNIA_REQUIRE(composer.save_to_path(draft_path).is_ok());
    const auto reloaded = RichComposer::load_from_path(draft_path);
    OMNIA_REQUIRE(reloaded.is_ok());
    OMNIA_REQUIRE(reloaded.value().document == composer.document);
    OMNIA_REQUIRE(reloaded.value().tray == composer.tray);
    OMNIA_REQUIRE(reloaded.value().payloads == composer.payloads);
}

// ---------------------------------------------------------------------------
// 10..15: SessionWorker, Keyset Paging, Shared Schema, Ownership & CAS
// ---------------------------------------------------------------------------

SessionSnapshot wait_worker_ok(SessionWorker& worker) {
    auto res = worker.wait_response(std::chrono::seconds(5));
    OMNIA_REQUIRE(res.has_value());
    OMNIA_REQUIRE(res->is_ok());
    return std::move(res->value());
}

void test_worker_returns_durable_state_without_ui_thread_database_calls() {
    TempDir dir;
    const auto database = dir.path() / "worker.sqlite3";
    auto notify_count = std::make_shared<std::atomic<size_t>>(0);

    std::string created_id;
    {
        auto started = SessionWorker::start(database, [notify_count]() {
            notify_count->fetch_add(1, std::memory_order_relaxed);
        });
        OMNIA_REQUIRE(started.is_ok());
        auto worker = std::move(started.value());

        const auto initial = wait_worker_ok(*worker);
        OMNIA_REQUIRE(initial.rows.empty());
        OMNIA_REQUIRE(!initial.active.has_value());
        OMNIA_REQUIRE(initial.navigation_revision == 0);

        OMNIA_REQUIRE(worker->submit(SessionCommand::create(initial.navigation_revision)).is_ok());
        const auto created = wait_worker_ok(*worker);
        created_id = created.active.value().id;
        OMNIA_REQUIRE(created.rows.size() == 1);
        OMNIA_REQUIRE(created.navigation_revision == 1);

        OMNIA_REQUIRE(
            worker
                ->submit(SessionCommand::update(
                    created_id, 1, "Worker session", "local/worker", "high"))
                .is_ok());
        const auto updated = wait_worker_ok(*worker);
        const auto& active = updated.active.value();
        OMNIA_REQUIRE(active.title == "Worker session");
        OMNIA_REQUIRE(active.model == "local/worker");
        OMNIA_REQUIRE(active.reasoning_effort == std::optional<std::string>("high"));
        OMNIA_REQUIRE(active.settings_revision == 2);
        OMNIA_REQUIRE(notify_count->load(std::memory_order_relaxed) >= 3);

        worker->stop_and_wait();
    }

    auto reopened = Sessions::open(database);
    OMNIA_REQUIRE(reopened.is_ok());
    const auto snap = reopened.value().snapshot();
    OMNIA_REQUIRE(snap.is_ok());
    OMNIA_REQUIRE(snap.value().active.value().id == created_id);
    OMNIA_REQUIRE(snap.value().active.value().model == "local/worker");
}

void test_command_queue_is_bounded_and_drop_cancels_pending_work() {
    auto cancelled = std::make_shared<std::atomic<bool>>(false);
    auto worker = SessionWorker::create_unbacked_for_queue_test(cancelled);
    OMNIA_REQUIRE(worker->submit(SessionCommand::refresh()).is_ok());
    const auto second = worker->submit(SessionCommand::refresh());
    OMNIA_REQUIRE(second.is_err());
    OMNIA_REQUIRE(second.error().code == "session_worker_busy");
    worker.reset();
    OMNIA_REQUIRE(cancelled->load(std::memory_order_acquire));
}

void test_native_page_is_bounded_and_preserves_off_page_active_metadata() {
    TempDir dir;
    const auto database = dir.path() / "paged.sqlite3";
    auto store_res = HarnessStore::open(database);
    OMNIA_REQUIRE(store_res.is_ok());
    auto store = store_res.value();
    Sessions service = Sessions::from_shared(store);

    auto active_res = service.create("Off-page active");
    OMNIA_REQUIRE(active_res.is_ok());
    AgentSessionSummary active = active_res.value();
    OMNIA_REQUIRE(service.select(active.id, 0).is_ok());
    active.updated_at_ms = 1;
    OMNIA_REQUIRE(store->save_summary(active).is_ok());

    char id_buf[32]{};
    char title_buf[48]{};
    for (int index = 0; index < 120; ++index) {
        std::snprintf(id_buf, sizeof(id_buf), "session-%03d", index);
        std::snprintf(title_buf, sizeof(title_buf), "Session %03d", index);
        AgentSessionSummary row = active;
        row.id = id_buf;
        row.title = title_buf;
        row.updated_at_ms = 100;
        OMNIA_REQUIRE(store->save_summary(row).is_ok());
    }

    const auto first = service.snapshot().value();
    OMNIA_REQUIRE(first.rows.size() == 50);
    OMNIA_REQUIRE(first.active.value().id == active.id);
    OMNIA_REQUIRE(std::none_of(first.rows.begin(), first.rows.end(), [&](const auto& r) {
        return r.id == active.id;
    }));
    OMNIA_REQUIRE(first.next_cursor.has_value());

    const auto second = service.page(first.next_cursor).value();
    OMNIA_REQUIRE(second.rows.size() == 50);
    OMNIA_REQUIRE(second.next_cursor.has_value());

    const auto third = service.page(second.next_cursor).value();
    OMNIA_REQUIRE(third.rows.size() == 21);
    OMNIA_REQUIRE(!third.next_cursor.has_value());
    OMNIA_REQUIRE(third.rows.back().id == active.id);
}

void test_native_sessions_reopen_with_exact_shared_schema_and_navigation() {
    TempDir dir;
    const auto database = dir.path() / "sessions.sqlite3";

    std::string created_id;
    {
        auto service_res = Sessions::open(database);
        OMNIA_REQUIRE(service_res.is_ok());
        auto& service = service_res.value();
        const auto created = service.create("Native evaluation").value();
        created_id = created.id;
        OMNIA_REQUIRE(created.scope == SessionScope::Projectless);
        OMNIA_REQUIRE(created.cwd.empty());

        const auto nav = service.select(created.id, 0).value();
        OMNIA_REQUIRE(nav.is_saved());

        const auto updated =
            service.update_settings(created.id, 1, "Updated title", "local/test-model", "high").value();
        OMNIA_REQUIRE(updated.settings_revision == 2);
        OMNIA_REQUIRE(updated.reasoning_effort == std::optional<std::string>("high"));

        const auto conflict = service.open(database);
        OMNIA_REQUIRE(conflict.is_err());
        OMNIA_REQUIRE(conflict.error().code == "harness_store_busy");
    }

    auto reopened = HarnessStore::open(database).value();
    const auto loaded = reopened->summary(created_id).value();
    OMNIA_REQUIRE(loaded.title == "Updated title");
    OMNIA_REQUIRE(loaded.model == "local/test-model");
    OMNIA_REQUIRE(loaded.reasoning_effort == std::optional<std::string>("high"));
    OMNIA_REQUIRE(loaded.settings_revision == 2);

    const auto nav = reopened->load_session_navigation().value();
    OMNIA_REQUIRE(nav.snapshot.active_id == std::optional<std::string>(created_id));
}

void test_native_metadata_view_shares_admission_owner_without_recovery() {
    TempDir dir;
    const auto database = dir.path() / "shared-owner.sqlite3";
    auto store = HarnessStore::open(database).value();
    RunCoordinator coordinator(store);
    Sessions sessions = Sessions::from_shared(coordinator.store());

    const auto created = sessions.create("Shared owner").value();
    const auto admitted = coordinator.admit(created.id).value();
    OMNIA_REQUIRE(admitted.history.empty());

    const auto updated =
        sessions.update_settings(created.id, 1, "Shared owner", "local/model", "medium").value();
    OMNIA_REQUIRE(updated.settings_revision == 2);
    OMNIA_REQUIRE(coordinator.runs().remove_current(admitted.ticket).value());
    OMNIA_REQUIRE(coordinator.runs().is_empty().value());
    OMNIA_REQUIRE(Sessions::open(database).error().code == "harness_store_busy");
}

void test_stale_and_invalid_settings_do_not_overwrite_committed_values() {
    TempDir dir;
    const auto database = dir.path() / "sessions.sqlite3";
    auto service = Sessions::open(database).value();
    const auto created = service.create("Initial").value();
    const auto committed =
        service.update_settings(created.id, 1, "Committed", "model-a", "medium").value();

    OMNIA_REQUIRE(
        service.update_settings(created.id, 1, "Stale", "model-b", "low").error().code ==
        "agent_session_revision_conflict");
    OMNIA_REQUIRE(
        service.update_settings(created.id, committed.settings_revision, "   ", "model-b", "low")
            .is_err());
    OMNIA_REQUIRE(
        service
            .update_settings(created.id, committed.settings_revision, "Bad\nline", "model-b", "low")
            .is_err());
    OMNIA_REQUIRE(
        service
            .update_settings(created.id, committed.settings_revision, "Valid", "model-b", "ultra")
            .is_err());

    const auto current = service.summary(created.id).value();
    OMNIA_REQUIRE(current.title == "Committed");
    OMNIA_REQUIRE(current.model == "model-a");
    OMNIA_REQUIRE(current.reasoning_effort == std::optional<std::string>("medium"));
    OMNIA_REQUIRE(current.settings_revision == 2);
}

// ---------------------------------------------------------------------------
// 16..21: Provider Profiles, Secret Broker & Provider Routing
// ---------------------------------------------------------------------------

constexpr std::string_view kProviderFixtureId = "provider_0123456789abcdef0123456789abcdef";

void seed_provider_profiles(const SqliteConnection& conn) {
    OMNIA_REQUIRE(
        conn.exec_batch(
                "CREATE TABLE provider_profiles ("
                " id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, provider_type TEXT NOT NULL,"
                " display_name TEXT NOT NULL, normalized_base_url TEXT NOT NULL,"
                " auth_scheme TEXT NOT NULL, organization_id TEXT, remote_project_id TEXT,"
                " credential_ref TEXT, egress_policy_json TEXT NOT NULL, enabled INTEGER NOT NULL,"
                " created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL, deleted_at_ms INTEGER"
                ");"
                "INSERT INTO provider_profiles VALUES ("
                " 'provider_0123456789abcdef0123456789abcdef', 'profile_default', 'openai',"
                " 'native fixture', 'https://example.invalid', 'bearer', NULL, NULL,"
                " 'opaque-fixture-reference', '{}', 1, 1, 2, NULL"
                ");")
            .is_ok());
}

void test_native_repository_reads_read_only_connection_without_recovery_or_writes() {
    TempDir dir;
    const auto path = dir.path() / "profiles.sqlite3";
    {
        auto rw = SqliteConnection::open_read_write(path);
        OMNIA_REQUIRE(rw.is_ok());
        seed_provider_profiles(rw.value());
    }
    const auto before = read_file_bytes(path);
    {
        auto ro = SqliteConnection::open_read_only(path);
        OMNIA_REQUIRE(ro.is_ok());
        ProviderProfileRepository repository(ro.value(), "profile_default");
        const auto listed = repository.list().value();
        OMNIA_REQUIRE(listed.size() == 1);

        const auto snapshot = repository.credential_snapshot(kProviderFixtureId).value();
        OMNIA_REQUIRE(snapshot.profile.id == kProviderFixtureId);
        OMNIA_REQUIRE(snapshot.profile.credential_status == CredentialStatus::Present);
        OMNIA_REQUIRE(
            snapshot.credential_ref == std::optional<std::string>("opaque-fixture-reference"));

        OMNIA_REQUIRE(ro.value().exec_batch("DELETE FROM provider_profiles;").is_err());

        const std::string json = snapshot.profile.to_redacted_json();
        OMNIA_REQUIRE(json.find("opaque-fixture-reference") == std::string::npos);
        OMNIA_REQUIRE(json.find("credentialRef") == std::string::npos);
        OMNIA_REQUIRE(ro.value().is_autocommit());
    }
    OMNIA_REQUIRE(before == read_file_bytes(path));
    size_t file_count = 0;
    for (const auto& entry : std::filesystem::directory_iterator(dir.path())) {
        (void)entry;
        ++file_count;
    }
    OMNIA_REQUIRE(file_count == 1);
}

void test_native_repository_observes_callers_transaction_and_app_profile_scope() {
    auto conn = SqliteConnection::open_in_memory().value();
    seed_provider_profiles(conn);

    {
        bool tx_ok = false;
        NativeError tx_err;
        SqliteTransaction tx(conn, SqliteTxBehavior::Deferred, tx_ok, tx_err);
        OMNIA_REQUIRE(tx_ok);
        OMNIA_REQUIRE(
            conn.exec_batch(
                    "UPDATE provider_profiles SET normalized_base_url = 'https://changed.invalid',"
                    " credential_ref = NULL WHERE id = 'provider_0123456789abcdef0123456789abcdef';")
                .is_ok());

        ProviderProfileRepository repo(tx.connection(), "profile_default");
        const auto snap = repo.credential_snapshot(kProviderFixtureId).value();
        OMNIA_REQUIRE(snap.profile.normalized_base_url == "https://changed.invalid");
        OMNIA_REQUIRE(!snap.credential_ref.has_value());
        OMNIA_REQUIRE(snap.profile.credential_status == CredentialStatus::Missing);
        OMNIA_REQUIRE(tx.rollback().is_ok());
    }

    ProviderProfileRepository repo(conn, "profile_default");
    OMNIA_REQUIRE(
        repo.get(kProviderFixtureId).value().normalized_base_url == "https://example.invalid");

    ProviderProfileRepository other(conn, "profile_other");
    OMNIA_REQUIRE(other.list().value().empty());
    OMNIA_REQUIRE(other.active(kProviderFixtureId).error().code == "provider_profile_missing");
    OMNIA_REQUIRE(
        other.credential_snapshot(kProviderFixtureId).error().code == "provider_profile_missing");
    OMNIA_REQUIRE(
        other.credential_ref(kProviderFixtureId).error().code == "provider_profile_missing");
}

ProviderProfileInput sample_profile_input(std::string_view provider_type) {
    return ProviderProfileInput{
        std::string(provider_type),
        "not a URL",
        "api-key-header",
        std::string("fixture-org"),
        std::string("fixture-project"),
        true,
        false,
    };
}

void test_native_selection_retains_adapter_and_routing_policy() {
    const auto s1 = provider_selection(sample_profile_input(" OpenAI Compatible ")).value();
    OMNIA_REQUIRE(s1.family == AdapterFamily::OpenAiChat);
    OMNIA_REQUIRE(s1.auth == AuthScheme::ApiKeyHeader);
    OMNIA_REQUIRE(s1.organization == std::optional<std::string>("fixture-org"));
    OMNIA_REQUIRE(s1.project == std::optional<std::string>("fixture-project"));

    const auto s2 = provider_selection(sample_profile_input("deepseek")).value();
    OMNIA_REQUIRE(!s2.organization.has_value());
    OMNIA_REQUIRE(!s2.project.has_value());

    const auto s3 = provider_selection(sample_profile_input("openai")).value();
    OMNIA_REQUIRE(s3.family == AdapterFamily::OpenAiResponses);
}

void test_native_disabled_and_missing_secret_fail_before_destination_work() {
    auto disabled = sample_profile_input("unsupported");
    disabled.enabled = false;
    const auto err1 = build_provider(disabled, std::nullopt).error();
    OMNIA_REQUIRE(err1.code == "provider_disabled");

    const auto err2 = build_provider(sample_profile_input("openai"), std::nullopt).error();
    OMNIA_REQUIRE(err2.code == "secret_missing");
    OMNIA_REQUIRE(!err2.retryable);
}

void test_malformed_reference_is_rejected_before_secret_callback() {
    SecretBroker broker;
    bool called = false;
    const std::string bad_ref = std::string("raw") + "-credential-ref";
    const auto res = broker.with_secret(
        SecretPurpose::ProviderCredential,
        bad_ref,
        [&](std::string_view) -> Result<void> {
            called = true;
            return Result<void>::ok();
        });
    OMNIA_REQUIRE(!called);
    OMNIA_REQUIRE(res.is_err());
    OMNIA_REQUIRE(res.error().code == "invalid_input");
}

void test_invalid_secret_is_rejected_before_creating_credential() {
    SecretBroker broker;
    OMNIA_REQUIRE(broker.put(SecretPurpose::ProviderCredential, "  ").is_err());
    OMNIA_REQUIRE(
        broker.put(SecretPurpose::ProviderCredential, std::string(16 * 1024 + 1, 'x')).is_err());
}

// ---------------------------------------------------------------------------
// 22..24: Run Event Journal & Approval Readiness
// ---------------------------------------------------------------------------

void test_native_event_is_committed_before_notification_and_replays_after_reopen() {
    TempDir dir;
    const auto database = dir.path() / "events.sqlite3";

    std::string session_id;
    {
        auto store = HarnessStore::open(database).value();
        Sessions sessions = Sessions::from_shared(store);
        const auto session = sessions.create("Native events").value();
        session_id = session.id;

        RunEventState state;
        CancellationToken cancel;
        bool notified = false;
        const auto event = AgentEvent::plan_presented("plan", "Inspect, implement, verify");

        const auto published = publish_run_event(
            event,
            state,
            cancel,
            [](std::string_view) -> bool {
                throw std::runtime_error("non-approval events must not consult readiness");
            },
            [&](const JsonValue& val) -> Result<void> {
                auto stored = store->publish_event(
                    session_id,
                    val,
                    [&](const StoredAgentEvent& ev) {
                        const auto replay = store->replay(session_id).value();
                        OMNIA_REQUIRE(replay.event_cursor == ev.sequence);
                        OMNIA_REQUIRE(replay.events.back().event == ev.event);
                        notified = true;
                        return false;
                    });
                if (stored.is_err()) return Result<void>::err(stored.error());
                return Result<void>::ok();
            });
        OMNIA_REQUIRE(published.is_ok());
        OMNIA_REQUIRE(published.value());
        OMNIA_REQUIRE(notified);
        OMNIA_REQUIRE(!cancel.is_cancelled());
    }

    auto reopened = HarnessStore::open(database).value();
    const auto replay = reopened->replay(session_id).value();
    OMNIA_REQUIRE(replay.events.size() == 1);
    OMNIA_REQUIRE(replay.events[0].event.find("type")->as_string_view() == "plan_presented");
}

void test_native_journal_rejection_cancels_without_notifying_or_creating_an_event() {
    TempDir dir;
    const auto database = dir.path() / "events.sqlite3";

    {
        auto store = HarnessStore::open(database).value();
        RunEventState state;
        CancellationToken cancel;
        bool notified = false;

        const auto res = publish_run_event(
            AgentEvent::turn_started(1),
            state,
            cancel,
            [](std::string_view) { return true; },
            [&](const JsonValue& val) -> Result<void> {
                auto stored = store->publish_event("missing-session", val, [&](const StoredAgentEvent&) {
                    notified = true;
                    return true;
                });
                if (stored.is_err()) return Result<void>::err(stored.error());
                return Result<void>::ok();
            });

        OMNIA_REQUIRE(res.is_err());
        OMNIA_REQUIRE(res.error().code == "harness_storage_failed");
        OMNIA_REQUIRE(cancel.is_cancelled());
        OMNIA_REQUIRE(!notified);
        {
            std::lock_guard<std::mutex> lock(state.persistence_error_mutex);
            OMNIA_REQUIRE(state.persistence_error == std::optional<std::string>(res.error().to_string()));
        }
    }

    auto reopened = HarnessStore::open(database).value();
    OMNIA_REQUIRE(reopened->summary("missing-session").is_err());
    const auto replay = reopened->replay("missing-session").value();
    OMNIA_REQUIRE(replay.status == "idle");
    OMNIA_REQUIRE(replay.events.empty());
    OMNIA_REQUIRE(replay.event_cursor == 0);
}

void test_native_nested_approval_is_published_only_after_sender_readiness() {
    TempDir dir;
    auto store = HarnessStore::open(dir.path() / "events.sqlite3").value();
    Sessions sessions = Sessions::from_shared(store);
    const auto session = sessions.create("Approval publication").value();

    RunEventState state;
    CancellationToken cancel;
    const auto event = AgentEvent::subagent(
        "child",
        AgentEvent::approval_requested(ApprovalRequest{
            "approval",
            "fixture",
            JsonValue(JsonValue::Object{}),
            "Readiness fixture only; no tool invocation",
            1,
            1,
        }));

    bool ready = false;
    const auto publish_fn = [&](const JsonValue& val) -> Result<void> {
        auto stored = store->publish_event(session.id, val, [](const StoredAgentEvent&) { return true; });
        if (stored.is_err()) return Result<void>::err(stored.error());
        return Result<void>::ok();
    };
    const auto readiness_fn = [&](std::string_view id) {
        OMNIA_REQUIRE(id == "approval");
        return ready;
    };

    OMNIA_REQUIRE(!publish_run_event(event, state, cancel, readiness_fn, publish_fn).value());
    OMNIA_REQUIRE(store->replay(session.id).value().events.empty());

    ready = true;
    OMNIA_REQUIRE(publish_run_event(event, state, cancel, readiness_fn, publish_fn).value());
    OMNIA_REQUIRE(store->replay(session.id).value().events.size() == 1);
    OMNIA_REQUIRE(!cancel.is_cancelled());
}

// ---------------------------------------------------------------------------
// 25..28: Loopback HTTP SSE Consumer Execution & Persistence
// ---------------------------------------------------------------------------

enum class ExecutionScenario : uint8_t {
    Success = 0,
    AuthenticationFailure = 1,
    CancelOnUsage = 2,
    RecordedPersistenceFailure = 3,
};

void run_http_execution_fixture(ExecutionScenario scenario) {
    WSADATA wsa{};
    OMNIA_REQUIRE(WSAStartup(MAKEWORD(2, 2), &wsa) == 0);

    TempDir dir;
    const auto database = dir.path() / "native-execution.sqlite3";

    std::string session_id;
    std::vector<WireMessage> durable;

    {
        auto store = HarnessStore::open(database).value();
        RunCoordinator runtime(store);
        Sessions sessions = Sessions::from_shared(runtime.store());
        auto summary = sessions.create("Native execution fixture").value();
        summary = sessions
                      .update_settings(summary.id, 1, "Fixture", "fixture/model", "high")
                      .value();
        session_id = summary.id;

        const auto admitted = runtime.admit(summary.id).value();
        std::vector<WireMessage> history = admitted.history;

        SOCKET listen_sock = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
        OMNIA_REQUIRE(listen_sock != INVALID_SOCKET);

        sockaddr_in addr{};
        addr.sin_family = AF_INET;
        addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        addr.sin_port = 0;
        OMNIA_REQUIRE(bind(listen_sock, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) == 0);
        int addr_len = sizeof(addr);
        OMNIA_REQUIRE(getsockname(listen_sock, reinterpret_cast<sockaddr*>(&addr), &addr_len) == 0);
        const uint16_t port = ntohs(addr.sin_port);
        OMNIA_REQUIRE(listen(listen_sock, 1) == 0);

        CancellationToken cancel;
        CancellationToken server_cancel = cancel;

        std::thread server([listen_sock, scenario, server_cancel]() mutable {
            SOCKET client = accept(listen_sock, nullptr, nullptr);
            closesocket(listen_sock);
            if (client == INVALID_SOCKET) {
                return;
            }
            DWORD timeout_ms = 8000;
            setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<const char*>(&timeout_ms), sizeof(timeout_ms));

            std::string req;
            size_t head_end = std::string::npos;
            size_t content_len = 0;
            char buf[1024];
            while (true) {
                const int n = recv(client, buf, sizeof(buf), 0);
                if (n <= 0) break;
                req.append(buf, static_cast<size_t>(n));
                head_end = req.find("\r\n\r\n");
                if (head_end != std::string::npos) {
                    const std::string_view headers(req.data(), head_end);
                    size_t pos = 0;
                    while (pos < headers.size()) {
                        const size_t eol = headers.find("\r\n", pos);
                        const auto line = headers.substr(
                            pos, eol == std::string_view::npos ? std::string_view::npos : eol - pos);
                        const size_t colon = line.find(':');
                        if (colon != std::string_view::npos) {
                            const auto hname = to_lower_utf8(trim_ascii(line.substr(0, colon)));
                            if (hname == "content-length") {
                                const auto hval = trim_ascii(line.substr(colon + 1));
                                content_len = static_cast<size_t>(std::stoull(std::string(hval)));
                            }
                        }
                        if (eol == std::string_view::npos) break;
                        pos = eol + 2;
                    }
                    break;
                }
            }
            while (head_end != std::string::npos && req.size() - (head_end + 4) < content_len) {
                const int n = recv(client, buf, sizeof(buf), 0);
                if (n <= 0) break;
                req.append(buf, static_cast<size_t>(n));
            }

            if (head_end != std::string::npos) {
                const std::string_view body_sv(req.data() + head_end + 4, content_len);
                const auto parsed = JsonValue::parse(body_sv);
                if (parsed.is_ok()) {
                    const auto* model_v = parsed.value().find("model");
                    if (!model_v || model_v->as_string_view() != "fixture/model") {
                        closesocket(client);
                        return;
                    }
                }
            }

            const auto send_str = [client](std::string_view data) {
                (void)send(client, data.data(), static_cast<int>(data.size()), 0);
            };

            if (scenario == ExecutionScenario::AuthenticationFailure) {
                send_str("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            } else {
                const std::string events =
                    "data: {\"choices\":[{\"delta\":{\"content\":\"native answer\"}}]}\n\n"
                    "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":2}}\n\n";
                if (scenario == ExecutionScenario::CancelOnUsage) {
                    send_str("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n");
                    send_str(events);
                    for (int i = 0; i < 200 && !server_cancel.is_cancelled(); ++i) {
                        std::this_thread::sleep_for(std::chrono::milliseconds(10));
                    }
                } else {
                    const std::string body =
                        events +
                        "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n"
                        "data: [DONE]\n\n";
                    const std::string resp =
                        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: " +
                        std::to_string(body.size()) + "\r\nConnection: close\r\n\r\n" + body;
                    send_str(resp);
                }
            }
            closesocket(client);
        });

        ProviderProfileInput pinput;
        pinput.provider_type = "local";
        pinput.base_url = "http://127.0.0.1:" + std::to_string(port);
        pinput.auth_scheme = "none";
        pinput.enabled = true;
        pinput.local_network_grant = true;

        const auto provider = build_provider(pinput, std::nullopt).value();
        PreparedSessionConfig config = prepare_session_config(summary, dir.path());
        config.max_retries = 0;

        RunEventState event_state;
        size_t observed_events = 0;

        const auto result = execute_prepared_http_run(
            runtime.store(),
            summary.id,
            provider,
            config,
            cancel,
            history,
            {WireBlock::make_text("native fixture prompt")},
            "native fixture prompt",
            event_state,
            [&](const AgentEvent& ev) {
                ++observed_events;
                if (scenario == ExecutionScenario::CancelOnUsage &&
                    ev.kind == AgentEvent::Kind::StreamUsage) {
                    cancel.cancel();
                }
                const auto pub_res = publish_run_event(
                    ev,
                    event_state,
                    cancel,
                    [](std::string_view) { return true; },
                    [&](const JsonValue& v) -> Result<void> {
                        const std::string_view target =
                            (scenario == ExecutionScenario::RecordedPersistenceFailure &&
                             ev.kind == AgentEvent::Kind::StreamUsage)
                                ? std::string_view("missing-session")
                                : std::string_view(summary.id);
                        auto stored = runtime.store()->publish_event(
                            target, v, [](const StoredAgentEvent&) { return true; });
                        if (stored.is_err()) return Result<void>::err(stored.error());
                        return Result<void>::ok();
                    });
                (void)pub_res;
            });

        server.join();

        JsonValue terminal;
        if (scenario == ExecutionScenario::RecordedPersistenceFailure) {
            OMNIA_REQUIRE(result.is_err());
            OMNIA_REQUIRE(result.error().code == "harness_storage_failed");
            JsonValue::Object obj;
            obj["type"] = "run_finished";
            obj["status"] = "failed";
            terminal = JsonValue(std::move(obj));
        } else {
            OMNIA_REQUIRE(result.is_ok());
            terminal = result.value();
            const std::string_view expected =
                (scenario == ExecutionScenario::Success)
                    ? "completed"
                    : (scenario == ExecutionScenario::AuthenticationFailure ? "failed" : "interrupted");
            OMNIA_REQUIRE(terminal.find("status")->as_string_view() == expected);
        }

        OMNIA_REQUIRE(
            runtime.store()
                ->publish_event(summary.id, terminal, [](const StoredAgentEvent&) { return true; })
                .is_ok());
        OMNIA_REQUIRE(runtime.runs().remove_current(admitted.ticket).value());
        OMNIA_REQUIRE(runtime.runs().is_empty().value());
        OMNIA_REQUIRE(event_state.run_tokens.load() == 0);

        durable = runtime.store()->messages(summary.id).value();
        OMNIA_REQUIRE(durable == history);
        OMNIA_REQUIRE(!durable.empty());

        const uint64_t expected_tokens =
            (scenario == ExecutionScenario::AuthenticationFailure) ? 0 : 5;
        OMNIA_REQUIRE(runtime.store()->summary(summary.id).value().tokens_used == expected_tokens);

        if (scenario == ExecutionScenario::Success) {
            OMNIA_REQUIRE(
                durable.back().content ==
                std::vector<WireBlock>{WireBlock::make_text("native answer")});
        }
        OMNIA_REQUIRE(observed_events > 0);
    }

    auto reopened = HarnessStore::open(database).value();
    OMNIA_REQUIRE(reopened->messages(session_id).value() == durable);
    OMNIA_REQUIRE(reopened->replay(session_id).value().status != "running");
}

void test_native_consumer_executes_http_stream_and_reopens_durable_transcript() {
    run_http_execution_fixture(ExecutionScenario::Success);
}

void test_native_consumer_preserves_failed_provider_turn_without_retry() {
    run_http_execution_fixture(ExecutionScenario::AuthenticationFailure);
}

void test_native_consumer_cancels_pending_stream_and_saves_observed_spend() {
    run_http_execution_fixture(ExecutionScenario::CancelOnUsage);
}

void test_native_consumer_does_not_report_success_after_recorded_persistence_failure() {
    run_http_execution_fixture(ExecutionScenario::RecordedPersistenceFailure);
}

// ---------------------------------------------------------------------------
// 29: Shared Session Preparation
// ---------------------------------------------------------------------------

void test_shared_preparation_reads_current_native_settings_without_a_second_store() {
    TempDir dir;
    const auto database = dir.path() / "sessions.sqlite3";
    auto store = HarnessStore::open(database).value();
    RunCoordinator runtime(store);
    Sessions sessions = Sessions::from_shared(runtime.store());

    const auto session = sessions.create("Native preparation").value();
    const auto updated1 =
        sessions.update_settings(session.id, 1, "First config", "local/first", "high").value();
    const auto first = prepare_session_config(updated1, dir.path());
    OMNIA_REQUIRE(first.model == "local/first");
    OMNIA_REQUIRE(first.reasoning_effort == std::optional<std::string>("high"));

    const auto updated2 =
        sessions.update_settings(session.id, 2, "Second config", "local/second", "minimal").value();
    const auto second = prepare_session_config(updated2, dir.path());
    OMNIA_REQUIRE(second.model == "local/second");
    OMNIA_REQUIRE(second.reasoning_effort == std::optional<std::string>("minimal"));
    OMNIA_REQUIRE(first.model == "local/first");

    OMNIA_REQUIRE(
        sessions.update_settings(session.id, 2, "Stale", "local/stale", "max").error().code ==
        "agent_session_revision_conflict");
    OMNIA_REQUIRE(sessions.summary(session.id).value().model == "local/second");
    OMNIA_REQUIRE(runtime.runs().is_empty().value());
    OMNIA_REQUIRE(Sessions::open(database).error().code == "harness_store_busy");
}

struct TestEntry {
    std::string_view name;
    void (*fn)();
};

const std::vector<TestEntry>& registry() {
    static const std::vector<TestEntry> kTests = {
        {"default_is_projectless_chat_projection", &test_default_is_projectless_chat_projection},
        {"command_routing_rejects_unknown_commands", &test_command_routing_rejects_unknown_commands},
        {"unchanged_rendered_default_is_clean", &test_unchanged_rendered_default_is_clean},
        {"every_field_is_preserved_exactly", &test_every_field_is_preserved_exactly},
        {"reverting_or_accepting_new_baseline_clears_dirty_state", &test_reverting_or_accepting_new_baseline_clears_dirty_state},
        {"symbol_palette_covers_math_physics_and_chemistry_with_unicode_previews", &test_symbol_palette_covers_math_physics_and_chemistry_with_unicode_previews},
        {"paste_cancel_never_mutates_draft_while_inline_and_tray_share_deduped_payload", &test_paste_cancel_never_mutates_draft_while_inline_and_tray_share_deduped_payload},
        {"drag_drop_zones_and_start_end_multi_file_ordering", &test_drag_drop_zones_and_start_end_multi_file_ordering},
        {"conversion_states_send_readiness_encrypted_honesty_undo_redo_and_restart_persistence", &test_conversion_states_send_readiness_encrypted_honesty_undo_redo_and_restart_persistence},
        {"worker_returns_durable_state_without_ui_thread_database_calls", &test_worker_returns_durable_state_without_ui_thread_database_calls},
        {"command_queue_is_bounded_and_drop_cancels_pending_work", &test_command_queue_is_bounded_and_drop_cancels_pending_work},
        {"native_page_is_bounded_and_preserves_off_page_active_metadata", &test_native_page_is_bounded_and_preserves_off_page_active_metadata},
        {"native_sessions_reopen_with_exact_shared_schema_and_navigation", &test_native_sessions_reopen_with_exact_shared_schema_and_navigation},
        {"native_metadata_view_shares_admission_owner_without_recovery", &test_native_metadata_view_shares_admission_owner_without_recovery},
        {"stale_and_invalid_settings_do_not_overwrite_committed_values", &test_stale_and_invalid_settings_do_not_overwrite_committed_values},
        {"native_repository_reads_read_only_connection_without_recovery_or_writes", &test_native_repository_reads_read_only_connection_without_recovery_or_writes},
        {"native_repository_observes_callers_transaction_and_app_profile_scope", &test_native_repository_observes_callers_transaction_and_app_profile_scope},
        {"native_selection_retains_adapter_and_routing_policy", &test_native_selection_retains_adapter_and_routing_policy},
        {"native_disabled_and_missing_secret_fail_before_destination_work", &test_native_disabled_and_missing_secret_fail_before_destination_work},
        {"malformed_reference_is_rejected_before_secret_callback", &test_malformed_reference_is_rejected_before_secret_callback},
        {"invalid_secret_is_rejected_before_creating_credential", &test_invalid_secret_is_rejected_before_creating_credential},
        {"native_event_is_committed_before_notification_and_replays_after_reopen", &test_native_event_is_committed_before_notification_and_replays_after_reopen},
        {"native_journal_rejection_cancels_without_notifying_or_creating_an_event", &test_native_journal_rejection_cancels_without_notifying_or_creating_an_event},
        {"native_nested_approval_is_published_only_after_sender_readiness", &test_native_nested_approval_is_published_only_after_sender_readiness},
        {"native_consumer_executes_http_stream_and_reopens_durable_transcript", &test_native_consumer_executes_http_stream_and_reopens_durable_transcript},
        {"native_consumer_preserves_failed_provider_turn_without_retry", &test_native_consumer_preserves_failed_provider_turn_without_retry},
        {"native_consumer_cancels_pending_stream_and_saves_observed_spend", &test_native_consumer_cancels_pending_stream_and_saves_observed_spend},
        {"native_consumer_does_not_report_success_after_recorded_persistence_failure", &test_native_consumer_does_not_report_success_after_recorded_persistence_failure},
        {"shared_preparation_reads_current_native_settings_without_a_second_store", &test_shared_preparation_reads_current_native_settings_without_a_second_store},
    };
    return kTests;
}

} // namespace

int main(int argc, char* argv[]) {
    std::optional<std::string_view> filter;
    for (int i = 1; i < argc; ++i) {
        const std::string_view arg(argv[i]);
        if (arg == "--test" && i + 1 < argc) {
            filter = std::string_view(argv[++i]);
        } else {
            std::cerr << "Usage: omnia_native_tests [--test <case_name>]\n";
            return 2;
        }
    }

    const auto& tests = registry();
    size_t executed = 0;
    size_t failed = 0;

    for (const auto& entry : tests) {
        if (filter.has_value() && entry.name != *filter) {
            continue;
        }
        ++executed;
        try {
            entry.fn();
            std::cout << "[PASS] " << entry.name << "\n";
        } catch (const std::exception& ex) {
            ++failed;
            std::cerr << "[FAIL] " << entry.name << ": " << ex.what() << "\n";
        } catch (...) {
            ++failed;
            std::cerr << "[FAIL] " << entry.name << ": unknown exception\n";
        }
    }

    if (executed == 0) {
        std::cerr << "No matching test found.\n";
        return 2;
    }
    if (failed > 0) {
        std::cerr << failed << " of " << executed << " test(s) failed.\n";
        return 1;
    }
    std::cout << "All " << executed << " native C++20 test(s) passed.\n";
    return 0;
}
