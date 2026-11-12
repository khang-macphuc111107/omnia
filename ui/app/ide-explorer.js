"use strict";

(function initIdeExplorerModule(global) {
  const Studio = (global.OmniaStudio = global.OmniaStudio || {});
  const { escapeHtml, highlightCpp20 } = Studio.utils;

  const CPP_MODULES = [
    {
      id: "omnia_core",
      title: "omnia_core",
      kind: "Static C++20 Library",
      paths: "cpp/include/omnia/core/ • cpp/src/core/",
      sdkLibs: ["bcrypt.lib (CNG SHA-256)"],
      summary: "Zero-dependency foundation: BCrypt SHA-256 hex hashing, full RFC-8259 JsonValue parser & serializer, UTF-8 codepoint-safe truncation, and SecretRedactor.",
      code:
        "namespace omnia::core {\n" +
        "[[nodiscard]] std::string sha256_hex(std::span<const uint8_t> bytes);\n" +
        "[[nodiscard]] std::string redact_secrets(std::string_view text);\n" +
        "class JsonValue final {\n" +
        "public:\n" +
        "  static JsonValue parse(std::string_view utf8_json);\n" +
        "  [[nodiscard]] std::string dump(int indent = -1) const;\n" +
        "};\n" +
        "}"
    },
    {
      id: "omnia_storage",
      title: "omnia_storage",
      kind: "Static C++20 Library",
      paths: "cpp/include/omnia/storage/ • cpp/src/storage/",
      sdkLibs: ["winsqlite3.lib (Windows 11 SDK)"],
      summary: "RAII winsqlite3 WAL SessionStore with cooperative process ownership lease (acquire_lease, heartbeat, release_lease), paged sessions, and SHA-256 deduplicated attachments.",
      code:
        "namespace omnia::storage {\n" +
        "struct LeaseStatus {\n" +
        "  bool acquired{false};\n" +
        "  uint32_t owner_pid{0};\n" +
        "  uint64_t lease_epoch{0};\n" +
        "};\n" +
        "class SessionStore final {\n" +
        "public:\n" +
        "  explicit SessionStore(std::string_view db_path);\n" +
        "  LeaseStatus acquire_lease(std::string_view holder, uint32_t pid);\n" +
        "};\n" +
        "}"
    },
    {
      id: "omnia_routing",
      title: "omnia_routing",
      kind: "Static C++20 Library",
      paths: "cpp/include/omnia/routing/ • cpp/src/routing/",
      sdkLibs: ["omnia_core", "std::mutex"],
      summary: "Deterministic DynamicProviderRouter: capability/privacy filtering, QuotaState::{Known,Unknown,Stale,Contradictory} (never coercing Unknown to 0), circuit breakers, and redacted receipts.",
      code:
        "namespace omnia::routing {\n" +
        "enum class QuotaState { Known, Unknown, Stale, Contradictory };\n" +
        "enum class CircuitState { Closed, Open, HalfOpen };\n" +
        "struct RouteDecisionReceipt {\n" +
        "  std::string receipt_id;\n" +
        "  std::string policy_hash;\n" +
        "  std::optional<std::string> selected_route;\n" +
        "};\n" +
        "}"
    },
    {
      id: "omnia_graph",
      title: "omnia_graph",
      kind: "Static C++20 Library",
      paths: "cpp/include/omnia/graph/ • cpp/src/graph/",
      sdkLibs: ["omnia_core"],
      summary: "Symmetric 2-way PeerMeshGraph (A <-> B duplex arcs, disjoint_paths guard, epoch/max_hops fencing) + GraphifyIndex (EXTRACTED, INFERRED, quarantined AMBIGUOUS).",
      code:
        "namespace omnia::graph {\n" +
        "enum class EdgeProvenance { Extracted, Inferred, Ambiguous };\n" +
        "enum class TraverseDirection { Forward, Reverse, Both };\n" +
        "class PeerMeshGraph final {\n" +
        "public:\n" +
        "  bool add_duplex_link(std::string_view peer_a, std::string_view peer_b);\n" +
        "  uint64_t send_peer(std::string_view from, std::string_view to, std::string_view body);\n" +
        "};\n" +
        "}"
    },
    {
      id: "omnia_harness",
      title: "omnia_harness",
      kind: "Static C++20 Library",
      paths: "cpp/include/omnia/harness/ • cpp/src/harness/",
      sdkLibs: ["omnia_core", "omnia_graph", "std::filesystem"],
      summary: "Hierarchical MemoryGraph with plaintext-free SHA-256 ErasureReceipt, bilingual EN/VN ProactiveRag uncertainty detector, SkillRegistry, ComposerModel, and SteerQueue.",
      code:
        "namespace omnia::harness {\n" +
        "struct ErasureReceipt {\n" +
        "  std::string receipt_id;\n" +
        "  std::string previous_digest_sha256;\n" +
        "  bool verified_plaintext_free{true};\n" +
        "};\n" +
        "struct SteerState {\n" +
        "  std::nullptr_t token_budget{nullptr}; // Never artificially capped\n" +
        "};\n" +
        "}"
    },
    {
      id: "omnia-native",
      title: "omnia-native.exe",
      kind: "Win32 + Direct2D + COM UIA Executable",
      paths: "native/CMakeLists.txt • native/src/",
      sdkLibs: ["dwmapi.lib", "d2d1.lib", "dwrite.lib", "uiautomationcore.lib", "winsqlite3.lib"],
      summary: "Native Windows 11 desktop shell with DWM Dark/Mica backdrop, server-side COM IRawElementProviderSimple + IValueProvider + WH_CBT #32770 modal IInvokeProvider.",
      code:
        "// Server-side COM UIA provider exposing ControlType.Edit (UIA_EditControlTypeId)\n" +
        "IFACEMETHODIMP ComposerEditProvider::get_ProviderOptions(ProviderOptions* ret) {\n" +
        "  *ret = static_cast<ProviderOptions>(ProviderOptions_ServerSideProvider | ProviderOptions_UseComThreading);\n" +
        "  return S_OK;\n" +
        "}"
    },
    {
      id: "omnia-studio",
      title: "omnia-studio.exe",
      kind: "Loopback HTTP + WebView2 Studio Host",
      paths: "cpp/apps/omnia_studio/main.cpp • ui/",
      sdkLibs: ["ws2_32.lib", "psapi.lib", "omnia_routing", "omnia_graph", "omnia_harness"],
      summary: "Zero-Node/zero-Electron C++20 loopback server on 127.0.0.1:<port> with strict Origin allowlist (403 on foreign POST) serving Obsidian Kinetic Atelier UI.",
      code:
        "// Strict 127.0.0.1 loopback bind + Cross-Origin POST mutation rejection\n" +
        "if (req.method == \"POST\" && !is_loopback_origin(req.origin_header)) {\n" +
        "  return HttpResponse{403, \"{\\\"ok\\\":false,\\\"error\\\":\\\"forbidden_origin\\\"}\"};\n" +
        "}"
    }
  ];

  let selectedModId = "omnia_storage";

  function renderCppExplorer() {
    const tabsEl = document.getElementById("cppModuleSelectorList");
    const detailEl = document.getElementById("cppModuleDetailCard");
    if (!tabsEl || !detailEl) return;

    tabsEl.innerHTML = CPP_MODULES.map((m) => (
      '<button type="button" class="btn ' + (m.id === selectedModId ? "btn-primary" : "btn-subtle") +
        '" style="min-height:32px;" data-cpp-mod="' + escapeHtml(m.id) + '">' +
        escapeHtml(m.title) +
      "</button>"
    )).join("");

    const mod = CPP_MODULES.find((m) => m.id === selectedModId) || CPP_MODULES[0];
    detailEl.innerHTML =
      '<div class="row-between">' +
        '<div>' +
          '<div style="font-size:1.05rem;font-weight:700;">' + escapeHtml(mod.title) + "</div>" +
          '<div class="mono muted" style="font-size:11px;">' + escapeHtml(mod.paths) + "</div>" +
        "</div>" +
        '<span class="badge badge-amber">' + escapeHtml(mod.kind) + "</span>" +
      "</div>" +
      '<p style="margin:8px 0;font-size:13px;color:var(--ink-secondary);line-height:1.55;">' + escapeHtml(mod.summary) + "</p>" +
      '<div class="row-wrap" style="margin-bottom:8px;">' +
        mod.sdkLibs.map((lib) => '<span class="badge badge-cyan">⚙ ' + escapeHtml(lib) + "</span>").join("") +
      "</div>" +
      '<div class="code-frame">' +
        '<div class="code-frame-bar">' +
          '<span>C++20 Interface Contract (/std:c++20 /W4 /WX)</span>' +
          '<button type="button" class="btn btn-subtle" style="min-height:24px;padding:0 8px;font-size:11px;" id="btnJumpGraphifyFromMod" data-target-entity="' + escapeHtml(mod.id) + '">Traverse in Graphify ↗</button>' +
        "</div>" +
        '<pre class="code-pre">' + highlightCpp20(mod.code) + "</pre>" +
      "</div>";

    const jumpBtn = document.getElementById("btnJumpGraphifyFromMod");
    if (jumpBtn) {
      jumpBtn.addEventListener("click", () => {
        if (Studio.switchView) Studio.switchView("graph", mod.id);
      });
    }
  }

  function renderRagPlanResult(plan) {
    const out = document.getElementById("ragAnalysisOutput");
    if (!out || !plan) return;
    const pct = Math.round((Number(plan.uncertaintyScore) || 0) * 100);

    const triggersHtml = (plan.triggers || []).map((t) => (
      '<span class="badge badge-amber">⚡ ' + escapeHtml(t) + "</span>"
    )).join("");

    const subQHtml = (plan.subQueries || []).map((sq, idx) => (
      '<div class="atelier-card" style="padding:8px 10px;">' +
        '<div class="mono" style="font-size:11px;color:var(--accent-cyan);">Angle ' + (idx + 1) + " • " + escapeHtml(sq.angle || "Sub-query") + "</div>" +
        '<div style="font-size:12.5px;margin-top:2px;">' + escapeHtml(sq.query || String(sq)) + "</div>" +
      "</div>"
    )).join("");

    const citedHtml = (plan.citedSources || []).map((src) => (
      '<div class="atelier-card" style="padding:8px 10px;">' +
        '<div class="row-between">' +
          '<strong style="font-size:12px;">' + escapeHtml(src.title) + "</strong>" +
          '<span class="badge ' + (src.provenance === "EXTRACTED" ? "badge-extracted" : "badge-inferred") + '">' +
            escapeHtml(src.provenance || "EXTRACTED") + " • " + escapeHtml(src.score ?? 0.9) +
          "</span>" +
        "</div>" +
        '<div class="mono muted" style="font-size:10.5px;margin:2px 0;">' + escapeHtml(src.locator) + "</div>" +
        '<div style="font-size:12px;color:var(--ink-secondary);">' + escapeHtml(src.snippet || "") + "</div>" +
      "</div>"
    )).join("");

    const unusedHtml = (plan.unusedSources || []).map((u) => (
      '<div style="padding:7px 10px;border:1px solid var(--status-coral-border);background:var(--status-coral-tint);border-radius:4px;font-size:11.5px;">' +
        '<div class="row-between">' +
          '<strong class="mono">' + escapeHtml(u.title) + "</strong>" +
          '<span class="badge badge-coral">QUARANTINED / UNUSED</span>' +
        "</div>" +
        '<div class="muted mono" style="font-size:10.5px;">' + escapeHtml(u.locator || "") + "</div>" +
        '<div style="margin-top:2px;">' + escapeHtml(u.reason) + "</div>" +
      "</div>"
    )).join("");

    out.innerHTML =
      '<div class="atelier-card-elevated stack-sm">' +
        '<div class="row-between">' +
          '<div class="row-wrap">' +
            '<span class="badge ' + (plan.shouldRetrieve ? "badge-emerald" : "badge-cyan") + '">' +
              (plan.shouldRetrieve ? "PROACTIVE RETRIEVAL TRIGGERED" : "LOW UNCERTAINTY • DIRECT") +
            "</span>" +
            '<span class="badge badge-cyan">Lang: ' + escapeHtml(plan.language) + "</span>" +
          "</div>" +
          '<span class="mono" style="font-weight:700;">Uncertainty: ' + pct + "% (" + escapeHtml(plan.uncertaintyScore) + ")</span>" +
        "</div>" +
        '<div class="meter-bar"><div class="meter-fill" style="width:' + pct + '%;background:' + (pct >= 55 ? "var(--accent-amber)" : "var(--status-emerald)") + ';"></div></div>' +
        '<div class="row-wrap">' + triggersHtml + "</div>" +
      "</div>" +

      '<div class="stack-xs">' +
        '<div class="section-eyebrow">Decomposed Multi-Angle Sub-Queries (' + (plan.subQueries || []).length + ")</div>" +
        subQHtml +
      "</div>" +

      '<div class="stack-xs">' +
        '<div class="section-eyebrow">Cited Grounded Sources (' + (plan.citedSources || []).length + ")</div>" +
        citedHtml +
      "</div>" +

      '<div class="stack-xs">' +
        '<div class="section-eyebrow">Explicit Quarantined / Unused Sources (' + (plan.unusedSources || []).length + ")</div>" +
        unusedHtml +
      "</div>";
  }

  async function runRagAnalyzer(queryOverride) {
    const input = document.getElementById("ragQueryInput");
    if (queryOverride && input) input.value = queryOverride;
    const q = input ? input.value.trim() : "";
    if (!q) return;
    const plan = await Studio.api.planRag(q);
    renderRagPlanResult(plan);
  }

  async function init() {
    renderCppExplorer();

    const modList = document.getElementById("cppModuleSelectorList");
    if (modList) {
      modList.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-cpp-mod]");
        if (!btn) return;
        selectedModId = btn.getAttribute("data-cpp-mod");
        renderCppExplorer();
      });
    }

    const ragForm = document.getElementById("ragAnalyzeForm");
    if (ragForm) {
      ragForm.addEventListener("submit", (e) => {
        e.preventDefault();
        runRagAnalyzer();
      });
    }

    document.querySelectorAll("[data-rag-sample]").forEach((btn) => {
      btn.addEventListener("click", () => {
        runRagAnalyzer(btn.getAttribute("data-rag-sample"));
      });
    });

    await runRagAnalyzer(
      "Tại sao cửa sổ modal #32770 cần WH_CBT hook để UIA InvokePattern chạy nền ổn định mà không cần từ khóa tìm kiếm?"
    );
  }

  Studio.ideExplorer = {
    init,
    selectModule(modId) {
      if (CPP_MODULES.some((m) => m.id === modId)) {
        selectedModId = modId;
        renderCppExplorer();
      }
    },
    runRagAnalyzer
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
