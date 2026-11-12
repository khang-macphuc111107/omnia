"use strict";

(function initMemoryVaultModule(global) {
  const Studio = (global.OmniaStudio = global.OmniaStudio || {});
  const { escapeHtml } = Studio.utils;

  const vaultState = {
    entries: [],
    erasures: [],
    namespacePrefix: "ALL",
    skills: [],
    selectedSkill: null
  };

  function renderMemoryList() {
    const listEl = document.getElementById("memoryEntriesList");
    const erasureEl = document.getElementById("memoryErasureReceipts");
    if (!listEl) return;

    const filtered = vaultState.entries.filter((e) => {
      if (vaultState.namespacePrefix === "ALL") return true;
      return String(e.namespace || "").startsWith(vaultState.namespacePrefix);
    });

    listEl.innerHTML = filtered.map((entry) => (
      '<div class="atelier-card stack-xs">' +
        '<div class="row-between">' +
          '<div class="row-wrap">' +
            '<span class="badge badge-cyan">' + escapeHtml(entry.namespace) + "</span>" +
            '<strong class="mono" style="font-size:12px;">' + escapeHtml(entry.key) + "</strong>" +
          "</div>" +
          '<div class="row-wrap">' +
            '<span class="badge ' + (entry.tier === "Durable" ? "badge-emerald" : "badge-amber") + '">' + escapeHtml(entry.tier || "Durable") + "</span>" +
            '<button type="button" class="btn btn-danger" style="min-height:26px;padding:0 8px;font-size:11px;" data-erase-mem="' + escapeHtml(entry.id) + '" data-erase-ns="' + escapeHtml(entry.namespace) + '">Cryptographic Erase</button>' +
          "</div>" +
        "</div>" +
        '<div style="font-size:12.5px;color:var(--ink-primary);line-height:1.5;">' + escapeHtml(entry.content) + "</div>" +
        '<div class="mono muted" style="font-size:10.5px;">SHA-256: ' + escapeHtml((entry.contentSha256 || "").slice(0, 24)) + "…</div>" +
      "</div>"
    )).join("") || '<div class="muted" style="font-size:12.5px;">No memory entries in this namespace slice.</div>';

    if (erasureEl) {
      erasureEl.innerHTML = vaultState.erasures.length === 0
        ? '<div class="muted mono" style="font-size:11px;">No cryptographic erasures executed in this session yet. Click "Cryptographic Erase" on any node above to generate a plaintext-free SHA-256 ErasureReceipt.</div>'
        : vaultState.erasures.map((rc) => (
          '<div style="padding:8px 10px;border:1px solid var(--status-emerald-border);background:var(--status-emerald-tint);border-radius:4px;" class="stack-xs">' +
            '<div class="row-between mono" style="font-size:11px;">' +
              '<strong style="color:var(--status-emerald);">✓ ErasureReceipt • ' + escapeHtml(rc.receiptId) + "</strong>" +
              '<span>Plaintext-Free: ' + escapeHtml(String(rc.verifiedPlaintextFree)) + "</span>" +
            "</div>" +
            '<div class="mono secondary" style="font-size:10.5px;">Namespace: ' + escapeHtml(rc.namespace) +
              " • Prior Digest SHA-256: " + escapeHtml((rc.previousDigestSha256 || "").slice(0, 28)) + "…</div>" +
          "</div>"
        )).join("");
    }
  }

  function renderSkillVault() {
    const countEl = document.getElementById("skillVaultCountBadge");
    const listEl = document.getElementById("skillVaultResults");
    if (!listEl) return;
    if (countEl) countEl.textContent = vaultState.skills.length + " Curated Skills";

    listEl.innerHTML = vaultState.skills.map((sk) => {
      const isOpen = vaultState.selectedSkill === sk.name;
      return (
        '<div class="atelier-card stack-xs" style="cursor:pointer;" data-skill-card="' + escapeHtml(sk.name) + '">' +
          '<div class="row-between">' +
            '<strong class="mono" style="font-size:12.5px;color:var(--accent-amber);">' + escapeHtml(sk.name) + "</strong>" +
            '<div class="row-wrap">' +
              '<span class="badge">' + escapeHtml(sk.category || "Omnia Skill") + "</span>" +
              '<span class="badge badge-emerald">BM25 ' + escapeHtml(sk.score ?? 9.0) + "</span>" +
            "</div>" +
          "</div>" +
          '<div style="font-size:12.5px;color:var(--ink-secondary);line-height:1.45;">' + escapeHtml(sk.description) + "</div>" +
          '<div class="mono muted" style="font-size:10.5px;">Locator: ' + escapeHtml(sk.path || (".agents/skills/" + sk.name + "/SKILL.md")) + " • Synced: Omnia ⇄ Codex ⇄ Antigravity</div>" +
          (isOpen
            ? '<div class="code-frame" style="margin-top:4px;"><pre class="code-pre" style="padding:8px;">python .agents/skills/omni-bilingual-skill-router/scripts/skill_router.py --skill ' + escapeHtml(sk.name) + "</pre></div>"
            : "") +
        "</div>"
      );
    }).join("") || '<div class="muted" style="font-size:12.5px;">No skills matched your bilingual query.</div>';
  }

  async function refreshMemory() {
    const data = await Studio.api.getMemory();
    vaultState.entries = data.entries || [];
    vaultState.erasures = data.erasures || [];
    renderMemoryList();
  }

  async function runSkillSearch(q) {
    const res = await Studio.api.searchSkills(q || "");
    vaultState.skills = res.skills || [];
    renderSkillVault();
  }

  async function init() {
    await refreshMemory();
    await runSkillSearch("");

    document.querySelectorAll("[data-ns-filter]").forEach((btn) => {
      btn.addEventListener("click", () => {
        vaultState.namespacePrefix = btn.getAttribute("data-ns-filter") || "ALL";
        document.querySelectorAll("[data-ns-filter]").forEach((b) => {
          b.setAttribute("aria-pressed", String(b === btn));
        });
        renderMemoryList();
      });
    });

    const upsertForm = document.getElementById("memoryUpsertForm");
    const feedbackEl = document.getElementById("memoryFormFeedback");
    if (upsertForm) {
      upsertForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const ns = document.getElementById("memNamespaceInput").value;
        const key = document.getElementById("memKeyInput").value;
        const tier = document.getElementById("memTierSelect").value;
        const content = document.getElementById("memContentInput").value;

        const res = await Studio.api.upsertMemory({ namespace: ns, key, tier, content });
        if (!res || res.ok === false) {
          if (feedbackEl) {
            feedbackEl.style.color = "var(--status-coral)";
            feedbackEl.textContent = (res && res.error) || "Rejected invalid namespace.";
          }
          return;
        }
        if (feedbackEl) {
          feedbackEl.style.color = "var(--status-emerald)";
          feedbackEl.textContent = "Committed '" + ns + "/" + key + "' • SHA-256:" + (res.entry.contentSha256 || "").slice(0, 12);
        }
        document.getElementById("memKeyInput").value = "";
        document.getElementById("memContentInput").value = "";
        await refreshMemory();
      });
    }

    const memList = document.getElementById("memoryEntriesList");
    if (memList) {
      memList.addEventListener("click", async (e) => {
        const eraseBtn = e.target.closest("[data-erase-mem]");
        if (!eraseBtn) return;
        const id = eraseBtn.getAttribute("data-erase-mem");
        const namespace = eraseBtn.getAttribute("data-erase-ns");
        const res = await Studio.api.eraseMemory({ id, namespace });
        if (res && res.receipt) {
          await refreshMemory();
          if (!vaultState.erasures.some((r) => r.receiptId === res.receipt.receiptId)) {
            vaultState.erasures.unshift(res.receipt);
            renderMemoryList();
          }
        }
      });
    }

    const skillInput = document.getElementById("skillSearchInput");
    if (skillInput) {
      skillInput.addEventListener("input", () => {
        runSkillSearch(skillInput.value);
      });
    }

    document.querySelectorAll("[data-skill-chip]").forEach((chip) => {
      chip.addEventListener("click", () => {
        const q = chip.getAttribute("data-skill-chip") || "";
        if (skillInput) skillInput.value = q === "ALL" ? "" : q;
        runSkillSearch(q === "ALL" ? "" : q);
      });
    });

    const skillList = document.getElementById("skillVaultResults");
    if (skillList) {
      skillList.addEventListener("click", (e) => {
        const card = e.target.closest("[data-skill-card]");
        if (!card) return;
        const name = card.getAttribute("data-skill-card");
        vaultState.selectedSkill = vaultState.selectedSkill === name ? null : name;
        renderSkillVault();
      });
    }
  }

  Studio.memoryVault = {
    init,
    runSkillSearch
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
