import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import SessionDfsExplorer, {
  DFS_NODES_STORAGE_KEY,
  SessionDfsExplorer as NamedSessionDfsExplorer,
} from "./session-dfs-explorer";
import { useWorkspaceStore } from "./store";

const initialWorkspaceState = useWorkspaceStore.getState();

describe("SessionDfsExplorer", () => {
  beforeEach(() => {
    if (typeof window !== "undefined" && typeof window.localStorage?.removeItem === "function") {
      window.localStorage.removeItem(DFS_NODES_STORAGE_KEY);
    }
    useWorkspaceStore.setState(initialWorkspaceState, true);
  });

  afterEach(() => {
    if (typeof window !== "undefined" && typeof window.localStorage?.removeItem === "function") {
      window.localStorage.removeItem(DFS_NODES_STORAGE_KEY);
    }
    useWorkspaceStore.setState(initialWorkspaceState, true);
  });

  it("exports both named SessionDfsExplorer and default export", () => {
    expect(NamedSessionDfsExplorer).toBeDefined();
    expect(SessionDfsExplorer).toBe(NamedSessionDfsExplorer);
  });

  it("renders Active Live Session URI Bar with copyable omnia:// and codex:// URIs and 1-click Copy Live Session URI", () => {
    const onCopyUri = vi.fn();
    render(<SessionDfsExplorer onCopyUri={onCopyUri} />);

    expect(screen.getByTestId("active-omnia-uri")).toHaveTextContent("omnia://sessions/session-a");
    expect(screen.getByTestId("active-codex-uri")).toHaveTextContent("codex://threads/session-a");

    fireEvent.click(screen.getByTestId("copy-live-session-uri-btn"));
    expect(onCopyUri).toHaveBeenCalledWith("omnia://sessions/session-a");
    expect(screen.getByTestId("copy-uri-feedback")).toHaveTextContent("Copied omnia://sessions/session-a");

    fireEvent.click(screen.getByTestId("copy-codex-thread-uri-btn"));
    expect(onCopyUri).toHaveBeenCalledWith("codex://threads/session-a");
  });

  it("renders pre-order A -> B -> C DFS hierarchy with depth, role badge, live streaming status, and token count", () => {
    render(<SessionDfsExplorer />);

    expect(screen.getByTestId("dfs-sequence-chain")).toHaveTextContent(
      "session-a -> session-b1 -> session-c1 -> session-c2 -> session-b2",
    );

    expect(screen.getByTestId("dfs-index-session-a")).toHaveTextContent("DFS #0 (depth 0)");
    expect(screen.getByTestId("dfs-index-session-b1")).toHaveTextContent("DFS #1 (depth 1)");
    expect(screen.getByTestId("dfs-index-session-c1")).toHaveTextContent("DFS #2 (depth 2)");
    expect(screen.getByTestId("dfs-role-session-b1")).toHaveTextContent("researcher");
    expect(screen.getByTestId("dfs-status-session-b1")).toHaveTextContent("LIVE STREAMING");
    expect(screen.getByTestId("dfs-tokens-session-a")).toHaveTextContent("8,420 tokens");
  });

  it("attaches pasted codex://threads/... or omnia://sessions/... URIs into the DFS session graph", () => {
    render(<SessionDfsExplorer />);

    const input = screen.getByTestId("external-session-uri-input");
    fireEvent.change(input, { target: { value: "codex://threads/session-ext-99" } });
    fireEvent.click(screen.getByTestId("attach-session-uri-btn"));

    expect(screen.getByTestId("uri-linker-status")).toHaveTextContent(
      "Attached codex://threads/session-ext-99 under session-a in pre-order DFS graph.",
    );
    expect(screen.getByTestId("dfs-sequence-chain")).toHaveTextContent("session-ext-99");
    expect(screen.getByTestId("inspected-session-id")).toHaveTextContent("session-ext-99");
  });

  it("surfaces a clear error when an invalid URI is submitted to the linker", () => {
    render(<SessionDfsExplorer />);

    const input = screen.getByTestId("external-session-uri-input");
    fireEvent.change(input, { target: { value: "https://not-a-session-uri.example" } });
    fireEvent.click(screen.getByTestId("attach-session-uri-btn"));

    expect(screen.getByTestId("uri-linker-error")).toHaveTextContent(/Invalid live session URI/i);
  });

  it("supports 1-click Inspect Node, Spawn Child Sub-Session, and Compile Full A->B->C DFS Context Digest", () => {
    const onInspectNode = vi.fn();
    const onSpawnChildSession = vi.fn();
    const onCompileDigest = vi.fn();

    render(
      <SessionDfsExplorer
        onInspectNode={onInspectNode}
        onSpawnChildSession={onSpawnChildSession}
        onCompileDigest={onCompileDigest}
      />,
    );

    // 1. Inspect Node
    fireEvent.click(screen.getByTestId("inspect-node-btn-session-c1"));
    expect(onInspectNode).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("inspected-session-id")).toHaveTextContent("session-c1");
    expect(screen.getByTestId("active-omnia-uri")).toHaveTextContent("omnia://sessions/session-c1");

    // 2. Spawn Child Sub-Session under session-c1
    fireEvent.click(screen.getByTestId("spawn-child-btn-session-c1"));
    expect(onSpawnChildSession).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("dfs-sequence-chain")).toHaveTextContent(
      "session-a -> session-b1 -> session-c1 -> session-c1-sub-1 -> session-c2 -> session-b2",
    );

    // 3. Compile Full A->B->C DFS Context Digest
    fireEvent.click(screen.getByTestId("compile-dfs-digest-btn"));
    expect(onCompileDigest).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("compiled-dfs-context-markdown")).toHaveTextContent(
      "[DFS #3] session-a -> session-b1 -> session-c1 -> session-c1-sub-1",
    );
  });

  it("merges live conversations from useWorkspaceStore, scans message URIs, persists nodes to localStorage, and injects A->B->C digest into active chat draft", () => {
    const baseConv = useWorkspaceStore.getState().conversations[0]!;
    useWorkspaceStore.setState({
      activeConversationId: baseConv.id,
      conversations: [
        {
          ...baseConv,
          draft: "Initial user draft.",
          messages: [
            ...baseConv.messages,
            {
              id: "msg-dfs-uri-scan",
              role: "user",
              content:
                "Please synthesize findings from codex://threads/session-live-77 and claude://sessions/session-c1.",
              createdAt: "2026-10-18T18:00:00Z",
              status: "complete",
              modelLabel: null,
              runId: null,
              attachments: [],
              branchIndex: 1,
              branchCount: 1,
            },
          ],
        },
      ],
    });

    render(<SessionDfsExplorer />);

    // Switch root session to the live conversation from useWorkspaceStore
    fireEvent.change(screen.getByTestId("dfs-root-session-select"), {
      target: { value: baseConv.id },
    });

    expect(screen.getByTestId("dfs-sequence-chain")).toHaveTextContent(
      `${baseConv.id} -> session-live-77 -> session-c1`,
    );

    // Inject compiled A->B->C digest into active chat draft
    fireEvent.click(screen.getByTestId("dfs-inject-into-chat-btn"));
    expect(screen.getByTestId("uri-linker-status")).toHaveTextContent(
      `Injected A->B->C DFS digest`,
    );

    const updatedConv = useWorkspaceStore
      .getState()
      .conversations.find((c) => c.id === baseConv.id);
    expect(updatedConv?.draft).toContain("Initial user draft.");
    expect(updatedConv?.draft).toContain("session-live-77");

    if (typeof window !== "undefined" && typeof window.localStorage?.getItem === "function") {
      expect(window.localStorage.getItem(DFS_NODES_STORAGE_KEY)).toBeTruthy();
    }
  });

  it("links a Multi-Parent AI Council to a shared child subagent and spawns an unlimited 50-agent swarm", () => {
    render(<SessionDfsExplorer />);

    // Link Multi-Parent Council (session-a + session-b1 -> session-c1)
    fireEvent.click(screen.getByTestId("link-multi-parent-btn"));
    expect(screen.getByTestId("uri-linker-status")).toHaveTextContent(
      /Linked Multi-Parent AI Council/i,
    );
    expect(screen.getByTestId("inspected-parent-sessions")).toHaveTextContent("session-b1, session-a");

    // Spawn 50-Agent Swarm with 1 click (unlimited cap)
    fireEvent.click(screen.getByTestId("spawn-50-subagent-swarm-btn"));
    expect(screen.getByTestId("uri-linker-status")).toHaveTextContent(
      /Spawned 50 swarm subagents/i,
    );
    expect(screen.getByTestId("dfs-total-nodes-badge")).toHaveTextContent("55 Sessions in DFS");
  });

  it("renders Adaptive Spawn Policy Advisor deciding between 0 agents (Direct Execution), Focused Squad, and Massive Swarm", () => {
    render(<SessionDfsExplorer />);

    // Default state shows multi-agent recommendation with Cap: UNLIMITED
    expect(screen.getByTestId("spawn-policy-decision-badge")).toHaveTextContent(/Cap: UNLIMITED/i);

    // Switch to Tightly-Coupled preset -> 0 agents — Direct Execution
    fireEvent.click(screen.getByTestId("policy-preset-no-spawn-btn"));
    expect(screen.getByTestId("spawn-policy-decision-badge")).toHaveTextContent(
      "0 agents — Direct Execution (single-agent-direct)",
    );

    // Switch to Massive Swarm preset -> 60+ agents
    fireEvent.click(screen.getByTestId("policy-preset-massive-swarm-btn"));
    expect(screen.getByTestId("spawn-policy-decision-badge")).toHaveTextContent(
      /massive-unlimited-swarm/i,
    );
  });

  it("supports Selection Quote, Targeted Reply, Ephemeral /btw Side-Chat, Promote to Main Chat, and Cross-Harness Slash Commands", () => {
    render(<SessionDfsExplorer />);

    const quoteInput = screen.getByTestId("selection-quote-input");
    const btwQuestion = screen.getByTestId("btw-question-input");

    fireEvent.change(quoteInput, {
      target: { value: "Pinned immutable prefix cache across all 9 official harnesses" },
    });
    fireEvent.change(btwQuestion, {
      target: { value: "Can we share this prefix cache across 50 subagents?" },
    });

    // 1. Ask in /btw Side Chat (does not pollute main draft)
    fireEvent.click(screen.getByTestId("ask-btw-side-chat-btn"));
    expect(screen.getByTestId("uri-linker-status")).toHaveTextContent(
      /Answered in ephemeral \/btw side-chat/i,
    );
    expect(screen.getAllByTestId("btw-latest-answer")[0]).toHaveTextContent(
      /Can we share this prefix cache across 50 subagents\?/i,
    );

    // 2. Promote /btw Answer to Main Chat
    fireEvent.click(screen.getByTestId("promote-btw-to-chat-btn"));
    expect(screen.getByTestId("uri-linker-status")).toHaveTextContent(
      /Promoted \/btw side-chat answer/i,
    );

    // 3. Quote and Reply in Active Chat
    fireEvent.click(screen.getByTestId("selection-quote-to-chat-btn"));
    expect(screen.getByTestId("uri-linker-status")).toHaveTextContent(
      /Quoted selection from/i,
    );

    fireEvent.click(screen.getByTestId("selection-reply-to-chat-btn"));
    expect(screen.getByTestId("uri-linker-status")).toHaveTextContent(
      /Inserted targeted reply to/i,
    );

    // 4. Cross-Harness Slash Command Bar (/btw, /council, /idm, /browser)
    fireEvent.click(screen.getByTestId("slash-cmd-btn-btw"));
    expect(screen.getByTestId("slash-command-feedback")).toHaveTextContent(/Activated \/btw/i);

    fireEvent.click(screen.getByTestId("slash-cmd-btn-idm"));
    expect(screen.getByTestId("slash-command-feedback")).toHaveTextContent(/Activated \/idm/i);
  });

  it("renders Chrome DevTools / Linear 4-Layer Icon Tab Bar and 2026 AI Architecture Telemetry (A2A, PRM Verifier, RadixAttention KV-Cache Tree)", () => {
    render(<SessionDfsExplorer />);

    // Verify 4-layer progressive disclosure tabstrip with data-tooltip hover labels
    const tabstrip = screen.getByTestId("dfs-devtools-tabstrip");
    expect(tabstrip).toBeInTheDocument();
    expect(screen.getByTestId("dfs-layer-tab-inspector")).toHaveAttribute("data-tooltip");
    expect(screen.getByTestId("dfs-layer-tab-swarm")).toHaveAttribute("data-tooltip");
    expect(screen.getByTestId("dfs-layer-tab-btw")).toHaveAttribute("data-tooltip");
    expect(screen.getByTestId("dfs-layer-tab-nextgen")).toHaveAttribute("data-tooltip");

    fireEvent.click(screen.getByTestId("dfs-layer-tab-nextgen"));
    expect(screen.getByTestId("session-dfs-explorer")).toHaveAttribute(
      "data-active-layer",
      "nextgen-ai-2026",
    );

    // 1. RadixAttention Shared Prefix KV-Cache Tree
    expect(screen.getByTestId("nextgen-ai-architecture-panel")).toBeInTheDocument();
    expect(screen.getByTestId("radix-kv-cache-panel")).toBeInTheDocument();
    expect(screen.getByTestId("radix-overall-sharing-badge")).toHaveTextContent(/% Shared Prefix/i);
    expect(screen.getByTestId("radix-ttft-saved-badge")).toHaveTextContent(/ms TTFT Saved/i);

    // 2. PRM Step-by-Step Reasoning Verifier & MCTS Branch Pruner
    expect(screen.getByTestId("prm-verifier-panel")).toBeInTheDocument();
    expect(screen.getByTestId("prm-pruned-count-badge")).toHaveTextContent("1 Branches Pruned");
    expect(screen.getByTestId("prm-step-verdict-1")).toHaveTextContent("backtrack-branch");

    // 3. A2A Agent Cards & MCP 2026 Streamable HTTP Envelope Dispatch
    expect(screen.getByTestId("a2a-agent-cards-panel")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("a2a-dispatch-envelope-btn"));
    expect(screen.getByTestId("uri-linker-status")).toHaveTextContent(/Dispatched A2A envelope/i);
    expect(screen.getByTestId("a2a-envelope-preview")).toHaveTextContent(
      "A2A-2026.1+MCP-Streamable-HTTP",
    );
  });
});


