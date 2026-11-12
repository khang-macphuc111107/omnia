#include "test_support.hpp"

#include "omnia/core/utf8.hpp"
#include "omnia/harness/composer_steer.hpp"
#include "omnia/harness/memory_graph.hpp"
#include "omnia/harness/proactive_rag.hpp"
#include "omnia/harness/skill_registry.hpp"

#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>

namespace {

using namespace omnia::harness;

void test_memory_graph() {
    MemoryGraph mem;

    OMNIA_CHECK(MemoryGraph::is_valid_namespace("architecture/cpp20/routing"));
    OMNIA_CHECK(!MemoryGraph::is_valid_namespace("../escape"));
    OMNIA_CHECK(!MemoryGraph::is_valid_namespace("bad\\backslash"));
    OMNIA_CHECK(!MemoryGraph::is_valid_namespace("C:/drive"));
    OMNIA_CHECK_THROWS(mem.upsert("../escape", "k", "secret", MemoryTier::Working));

    // Cyclic links A <-> B
    const auto n_a = mem.upsert(
        "architecture/graph",
        "node-a",
        "Sensitive design note linking to [[architecture/graph/node-b]]",
        MemoryTier::Durable,
        {},
        1000
    );
    (void)mem.upsert(
        "architecture/graph",
        "node-b",
        "Peer note linking back to [[architecture/graph/node-a]]",
        MemoryTier::Working,
        {},
        1010
    );

    const auto trav = mem.traverse_cyclic_safe(n_a.id, 4);
    OMNIA_CHECK(trav.visited_ids.size() == 2);
    OMNIA_CHECK(!trav.detected_cycles.empty());

    // Cryptographic plaintext-free erasure receipt
    const auto receipt = mem.erase(n_a.id, 2000);
    OMNIA_CHECK(receipt.has_value());
    OMNIA_CHECK(receipt->verified_plaintext_free);
    OMNIA_CHECK(receipt->previous_digest_sha256 == n_a.content_sha256);
    OMNIA_CHECK(!mem.get(n_a.id).has_value());
}

void test_proactive_rag_bilingual() {
    ProactiveRag rag;

    // Vietnamese architectural/diagnostic query WITHOUT any "search" / "tim kiem" keyword
    const auto vn_plan = rag.plan(
        "T\u1EA1i sao m\u1EA1ch ng\u1EAFt router v\u00E0 h\u1EA1n m\u1EE9c quota trong ki\u1EBFn tr\u00FAc C++20 hi\u1EC7n t\u1EA1i c\u1EA7n ph\u00E2n bi\u1EC7t tr\u1EA1ng th\u00E1i stale?"
    );
    OMNIA_CHECK(vn_plan.should_retrieve);
    OMNIA_CHECK(vn_plan.language == "vi" || vn_plan.language == "bilingual");
    OMNIA_CHECK(vn_plan.sub_queries.size() >= 3);
    OMNIA_CHECK(!vn_plan.cited_sources.empty());
    OMNIA_CHECK(!vn_plan.unused_sources.empty());

    bool saw_quarantined = false;
    for (const auto& u : vn_plan.unused_sources) {
        if (u.reason == "quarantined_ambiguous_provenance") {
            saw_quarantined = true;
        }
    }
    OMNIA_CHECK(saw_quarantined);

    // English comparative prompt without "search"
    const auto en_plan = rag.plan(
        "How does winsqlite3 WAL cooperative lease recovery compare vs LockFileEx in 2026?"
    );
    OMNIA_CHECK(en_plan.should_retrieve);
    OMNIA_CHECK(!en_plan.cited_sources.empty());
}

void test_skill_registry(const std::filesystem::path& repo_root) {
    SkillRegistry reg;
    if (!repo_root.empty() && std::filesystem::exists(repo_root / ".agents" / "skills")) {
        const std::size_t count = reg.load_from_directory(repo_root / ".agents" / "skills");
        OMNIA_CHECK(count >= 10);
        const auto hits = reg.search("cpp20 winsqlite3 cmake", 10);
        OMNIA_CHECK(!hits.empty());
    }

    // Verify 1024-codepoint UTF-8 boundary truncation on synthetic skill folder
    const auto stamp = std::chrono::steady_clock::now().time_since_epoch().count();
    const auto tmp_root = std::filesystem::temp_directory_path() /
                          ("omnia-skill-test-" + std::to_string(stamp));
    const auto skill_dir = tmp_root / "long-utf8-skill";
    std::filesystem::create_directories(skill_dir);

    std::string long_vn_desc;
    for (int i = 0; i < 400; ++i) {
        long_vn_desc += "Ki\u1EBFn "; // 5 codepoints per repetition -> 2000 codepoints
    }
    {
        std::ofstream ofs(skill_dir / "SKILL.md", std::ios::binary);
        ofs << "---\nname: long-utf8-skill\ndescription: \"" << long_vn_desc << "\"\n---\n# Body\n";
    }

    SkillRegistry tmp_reg;
    OMNIA_CHECK(tmp_reg.load_from_directory(tmp_root) == 1);
    const auto& loaded = tmp_reg.all().front();
    OMNIA_CHECK(omnia::core::is_valid_utf8(loaded.description));
    OMNIA_CHECK(
        omnia::core::utf8_codepoint_count(loaded.description) ==
        SkillRegistry::kMaxDescriptionCodepoints
    );

    std::error_code ec;
    std::filesystem::remove_all(tmp_root, ec);
}

void test_composer_and_steer_queue() {
    OMNIA_CHECK(ComposerModel::templates().size() == 15);

    ComposerModel comp;
    comp.set_draft("Hello world", 5);
    const std::vector<std::uint8_t> img_bytes = {0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A};

    // Cancel must produce 100% zero mutation
    const auto cancelled = comp.handle_attachment_paste(
        "shot.png", "image/png", img_bytes, PasteDestination::Cancel
    );
    OMNIA_CHECK(!cancelled.mutated);
    OMNIA_CHECK(comp.draft_text() == "Hello world");
    OMNIA_CHECK(comp.caret_offset() == 5);
    OMNIA_CHECK(comp.unique_payload_count() == 0);

    // Inline + Tray paste of identical bytes deduplicate to 1 stored payload
    const auto inl = comp.handle_attachment_paste(
        "shot.png", "image/png", img_bytes, PasteDestination::InlineAtCaret
    );
    OMNIA_CHECK(inl.mutated && !inl.deduplicated);
    const auto tr = comp.handle_attachment_paste(
        "shot-copy.png", "image/png", img_bytes, PasteDestination::AttachmentTray
    );
    OMNIA_CHECK(tr.mutated && tr.deduplicated);
    OMNIA_CHECK(comp.unique_payload_count() == 1);
    OMNIA_CHECK(comp.inline_chips().size() == 1);
    OMNIA_CHECK(comp.tray_items().size() == 1);

    // Encrypted PDF honest UNREADABLE guard
    const std::string enc_pdf = "%PDF-1.7\n1 0 obj << /Filter /Standard /Encrypt 2 0 R >> endobj\n";
    const auto* enc_ptr = reinterpret_cast<const std::uint8_t*>(enc_pdf.data());
    const auto pdf_res = ComposerModel::inspect_pdf_bytes({enc_ptr, enc_pdf.size()});
    OMNIA_CHECK(pdf_res.is_pdf && pdf_res.is_encrypted);
    OMNIA_CHECK(pdf_res.status.substr(0, 11) == "UNREADABLE:");
    OMNIA_CHECK(!pdf_res.extracted_preview.has_value());

    // SteerQueue ADDITIVE_INTAKE & token_budget == null invariant
    SteerQueue sq;
    OMNIA_CHECK(!sq.token_budget().has_value());
    (void)sq.enqueue("Task 1", SteerMode::AdditiveIntake, 100, "in_progress");
    (void)sq.enqueue("Mid-run steer 2", SteerMode::AdditiveIntake, 200, "queued");
    const auto items = sq.items();
    OMNIA_CHECK(items.size() == 2);
    OMNIA_CHECK(items[0].status == "in_progress"); // Never dropped or overwritten!
    OMNIA_CHECK(items[1].status == "queued");
    OMNIA_CHECK(!sq.token_budget().has_value());
}

} // namespace

int main(int argc, char* argv[]) {
    std::filesystem::path repo_root;
    if (argc >= 3) {
        repo_root = std::filesystem::path(argv[2]);
    }
    test_memory_graph();
    test_proactive_rag_bilingual();
    test_skill_registry(repo_root);
    test_composer_and_steer_queue();
    std::cout << "[PASS] test_omnia_harness (MemoryGraph, ProactiveRag, SkillRegistry, Composer, SteerQueue)\n";
    return 0;
}
