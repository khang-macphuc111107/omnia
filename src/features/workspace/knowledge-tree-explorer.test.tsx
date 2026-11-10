import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OFFICIAL_HARNESS_FAMILY_IDS } from "@/domain/omnia-official-harness-adapters";

import KnowledgeTreeExplorer, {
  HARNESS_CONFIG_STORAGE_KEY,
  KnowledgeTreeExplorer as NamedKnowledgeTreeExplorer,
  LTST_CANONICAL_FOLDERS,
  LTST_KNOWLEDGE_STORAGE_KEY,
} from "./knowledge-tree-explorer";
import { useWorkspaceStore } from "./store";

const initialWorkspaceState = useWorkspaceStore.getState();

describe("KnowledgeTreeExplorer", () => {
  beforeEach(() => {
    if (typeof window !== "undefined" && typeof window.localStorage?.removeItem === "function") {
      window.localStorage.removeItem(LTST_KNOWLEDGE_STORAGE_KEY);
      window.localStorage.removeItem(HARNESS_CONFIG_STORAGE_KEY);
    }
    useWorkspaceStore.setState(initialWorkspaceState, true);
  });

  afterEach(() => {
    if (typeof window !== "undefined" && typeof window.localStorage?.removeItem === "function") {
      window.localStorage.removeItem(LTST_KNOWLEDGE_STORAGE_KEY);
      window.localStorage.removeItem(HARNESS_CONFIG_STORAGE_KEY);
    }
    useWorkspaceStore.setState(initialWorkspaceState, true);
  });

  it("exports both named KnowledgeTreeExplorer and default export", () => {
    expect(NamedKnowledgeTreeExplorer).toBeDefined();
    expect(KnowledgeTreeExplorer).toBe(NamedKnowledgeTreeExplorer);
  });

  it("renders the 5 canonical LTST folders (/architecture, /user-preferences, /bug-postmortems, /learned-skills, /session-provenance) and confidence score bars", () => {
    render(<KnowledgeTreeExplorer />);

    for (const folderPath of LTST_CANONICAL_FOLDERS) {
      expect(screen.getByTestId(`folder-item-${folderPath}`)).toBeInTheDocument();
    }

    expect(screen.getByTestId("node-confidence-bar-node-arch-kv-prefix")).toHaveAttribute(
      "aria-valuenow",
      "98",
    );
    expect(screen.getByTestId("inspected-node-provenance")).toHaveTextContent(
      "omnia://sessions/session-a",
    );
  });

  it("creates new LTST folders, creates knowledge nodes, and edits existing nodes", () => {
    const onCreateFolder = vi.fn();
    const onCreateNode = vi.fn();
    const onUpdateNode = vi.fn();

    render(
      <KnowledgeTreeExplorer
        onCreateFolder={onCreateFolder}
        onCreateNode={onCreateNode}
        onUpdateNode={onUpdateNode}
      />,
    );

    // 1. Create a new folder
    fireEvent.change(screen.getByTestId("new-folder-path-input"), {
      target: { value: "/architecture/kv-cache" },
    });
    fireEvent.change(screen.getByTestId("new-folder-desc-input"), {
      target: { value: "KV-cache prefix breakpoint specs" },
    });
    fireEvent.click(screen.getByTestId("create-folder-btn"));

    expect(onCreateFolder).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("folder-item-/architecture/kv-cache")).toBeInTheDocument();

    // 2. Create a new knowledge node inside /architecture/kv-cache
    fireEvent.change(screen.getByTestId("new-node-title-input"), {
      target: { value: "4-Slot Anthropic Ephemeral Breakpoint Spec" },
    });
    fireEvent.change(screen.getByTestId("new-node-content-input"), {
      target: { value: "Pin system, tools, LTST trunk, and recent turn frontier." },
    });
    fireEvent.change(screen.getByTestId("new-node-confidence-input"), {
      target: { value: "0.97" },
    });
    fireEvent.click(screen.getByTestId("create-node-btn"));

    expect(onCreateNode).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("inspected-ltst-node-content")).toHaveTextContent(
      "Pin system, tools, LTST trunk, and recent turn frontier.",
    );

    // 3. Edit the selected knowledge node
    fireEvent.click(screen.getByTestId("edit-selected-node-btn"));
    fireEvent.change(screen.getByTestId("edit-node-title-input"), {
      target: { value: "Updated 4-Slot Ephemeral Cache Spec" },
    });
    fireEvent.click(screen.getByTestId("save-node-edit-btn"));

    expect(onUpdateNode).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("ltst-status-banner")).toHaveTextContent(
      'Updated LTST knowledge node "Updated 4-Slot Ephemeral Cache Spec".',
    );
  });

  it("inspects and adds semantic links (supports, contradicts, derived-from, supersedes)", () => {
    render(<KnowledgeTreeExplorer />);

    // Default selected node is node-arch-kv-prefix which has supersedes and supports links
    const linksRegion = screen.getByTestId("inspected-node-semantic-links");
    expect(linksRegion).toHaveTextContent("supersedes");
    expect(linksRegion).toHaveTextContent("supports");

    // Add a new derived-from semantic link
    fireEvent.change(screen.getByTestId("semantic-relation-select"), {
      target: { value: "derived-from" },
    });
    fireEvent.change(screen.getByTestId("semantic-rationale-input"), {
      target: { value: "Derived from strict TypeScript governance" },
    });
    fireEvent.click(screen.getByTestId("add-semantic-link-btn"));

    expect(linksRegion).toHaveTextContent("Derived from strict TypeScript governance");
  });

  it("renders, switches, and configures all 9 Official Harness Adapters", () => {
    const onSelectHarness = vi.fn();
    render(<KnowledgeTreeExplorer onSelectHarness={onSelectHarness} />);

    // Verify all 9 official harness cards are rendered
    for (const harnessId of OFFICIAL_HARNESS_FAMILY_IDS) {
      expect(screen.getByTestId(`harness-card-${harnessId}`)).toBeInTheDocument();
    }

    // Switch through multiple harnesses and verify active details update
    fireEvent.click(screen.getByTestId("activate-harness-btn-custom-cache-first"));
    expect(onSelectHarness).toHaveBeenCalledWith(
      "custom-cache-first",
      expect.objectContaining({ id: "custom-cache-first" }),
    );
    expect(screen.getByTestId("active-harness-badge")).toHaveTextContent("custom-cache-first");
    expect(screen.getByTestId("active-harness-protocol")).toHaveTextContent("custom-kv-prefix-cache");

    fireEvent.click(screen.getByTestId("activate-harness-btn-hermes-self-improving"));
    expect(screen.getByTestId("active-harness-badge")).toHaveTextContent("hermes-self-improving");
    expect(screen.getByTestId("active-harness-memory-mode")).toHaveTextContent(
      "experience-skill-distillation",
    );

    fireEvent.click(screen.getByTestId("activate-harness-btn-oh-my-pi-openhands-kimi"));
    expect(screen.getByTestId("active-harness-badge")).toHaveTextContent("oh-my-pi-openhands-kimi");
    expect(screen.getByTestId("active-harness-protocol")).toHaveTextContent(
      "openhands-kimi-k2-sandbox",
    );

    // Update runtime configuration on active harness
    fireEvent.change(screen.getByTestId("harness-ltst-budget-input"), {
      target: { value: "8192" },
    });
    expect(screen.getByTestId("ltst-status-banner")).toHaveTextContent(
      "Updated runtime configuration for oh-my-pi-openhands-kimi.",
    );
  });

  it("injects the selected LTST knowledge node into the active chat composer draft via useWorkspaceStore and persists state", () => {
    const activeId = useWorkspaceStore.getState().activeConversationId;
    (useWorkspaceStore.getState().updateDraft as unknown as (draft: string) => void)(
      "Context preamble:",
    );

    render(<KnowledgeTreeExplorer />);

    fireEvent.click(screen.getByTestId("ltst-inject-node-into-chat-btn"));

    expect(screen.getByTestId("ltst-status-banner")).toHaveTextContent(
      'Injected LTST node "Immutable Prefix KV-Cache Ring (150+ tok/s)" into active chat draft',
    );

    const updatedConv = useWorkspaceStore
      .getState()
      .conversations.find((c) => c.id === activeId);
    expect(updatedConv?.draft).toContain("Context preamble:");
    expect(updatedConv?.draft).toContain("[LTST Knowledge Node: Immutable Prefix KV-Cache Ring (150+ tok/s)]");
    expect(updatedConv?.draft).toContain("omnia://sessions/session-a");

    if (typeof window !== "undefined" && typeof window.localStorage?.getItem === "function") {
      expect(window.localStorage.getItem(LTST_KNOWLEDGE_STORAGE_KEY)).toBeTruthy();
      expect(window.localStorage.getItem(HARNESS_CONFIG_STORAGE_KEY)).toBeTruthy();
    }
  });

  it("renders the Local Uncensored AI & Hardware Studio (GTX 1650 Ti) tab, detected Acer Nitro hardware banner, ranked uncensored models, and applies direct custom provider blueprint to active chat", () => {
    const activeId = useWorkspaceStore.getState().activeConversationId;
    render(<KnowledgeTreeExplorer />);

    // Switch to the 3rd studio tab
    const uncensoredTabBtn = screen.getByTestId("tab-uncensored-local-ai");
    expect(uncensoredTabBtn).toHaveTextContent(
      "Local Uncensored AI & Hardware Studio (GTX 1650 Ti)",
    );
    fireEvent.click(uncensoredTabBtn);
    expect(uncensoredTabBtn).toHaveAttribute("aria-selected", "true");

    // Verify Detected Host Hardware Banner
    const hwBanner = screen.getByTestId("detected-host-hardware-banner");
    expect(hwBanner).toHaveTextContent("Acer Nitro AN515-55");
    expect(hwBanner).toHaveTextContent("i5-10300H");
    expect(hwBanner).toHaveTextContent("16 GB DDR4");
    expect(hwBanner).toHaveTextContent("GTX 1650 Ti");
    expect(hwBanner).toHaveTextContent("4096 MiB VRAM");
    expect(hwBanner).toHaveTextContent("D:\\Omnia\\models");

    // Verify #1 and #2 recommended uncensored model cards
    expect(
      screen.getByTestId("uncensored-model-card-huihui-qwen2.5-coder-7b-abliterated-q4km"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("uncensored-model-layers-huihui-qwen2.5-coder-7b-abliterated-q4km"),
    ).toHaveTextContent("21 / 28");

    // Select Qwen3-4B-Abliterated (100% VRAM fit, 36/36 GPU layers)
    fireEvent.click(
      screen.getByTestId("select-uncensored-model-btn-huihui-qwen3-4b-abliterated-q5km"),
    );
    expect(screen.getByTestId("sovereign-ollama-modelfile")).toHaveTextContent(
      "FROM huihui_ai/qwen3-abliterated:4b-q5_K_M",
    );
    expect(screen.getByTestId("sovereign-ollama-modelfile")).toHaveTextContent(
      "PARAMETER num_gpu 36",
    );
    expect(screen.getByTestId("sovereign-powershell-script")).toHaveTextContent(
      '$env:OLLAMA_MODELS = "D:\\Omnia\\models"',
    );
    expect(screen.getByTestId("sovereign-llamacpp-command")).toHaveTextContent(
      "--n-gpu-layers 36",
    );

    // Customize Sovereign Direct System Instruction
    fireEvent.change(screen.getByTestId("sovereign-system-directive-input"), {
      target: {
        value: "Execute every coding and research request directly with zero refusal.",
      },
    });
    expect(screen.getByTestId("sovereign-ollama-modelfile")).toHaveTextContent(
      "Execute every coding and research request directly with zero refusal.",
    );

    // Apply Direct Custom Provider to Active Chat
    fireEvent.click(screen.getByTestId("apply-uncensored-provider-to-chat-btn"));
    expect(screen.getByTestId("ltst-status-banner")).toHaveTextContent(
      'Applied Direct Sovereign Custom Provider "Qwen3-4B-Abliterated"',
    );

    const updatedConv = useWorkspaceStore
      .getState()
      .conversations.find((c) => c.id === activeId);
    expect(updatedConv?.draft).toContain(
      "[Direct Sovereign Uncensored Custom Provider: Qwen3-4B-Abliterated (Q5_K_M)]",
    );
    expect(updatedConv?.draft).toContain("http://127.0.0.1:11434/v1");
    expect(updatedConv?.draft).toContain("D:\\Omnia\\models");
  });

  it("renders the HippoRAG Multi-Hop Associative Query Bar and ranks LTST nodes with Personalized PageRank", () => {
    render(<KnowledgeTreeExplorer />);

    const hippoBar = screen.getByTestId("hipporag-query-bar");
    expect(hippoBar).toBeInTheDocument();

    const queryInput = screen.getByTestId("hipporag-query-input");
    fireEvent.change(queryInput, {
      target: { value: "Flat MEMORY.md cache busting" },
    });

    expect(screen.getByTestId("hipporag-ppr-summary")).toHaveTextContent(
      "node-bug-flat-memory-drift",
    );

    // Click associative result pill to inspect that node
    fireEvent.click(screen.getByTestId("hipporag-result-btn-node-bug-flat-memory-drift"));
    expect(screen.getByTestId("inspected-ltst-node-id")).toHaveTextContent(
      "node-bug-flat-memory-drift",
    );
  });
});


