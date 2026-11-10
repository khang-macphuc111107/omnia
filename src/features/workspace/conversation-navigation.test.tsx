import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ConversationNavigation } from "./conversation-navigation";
import {
  buildNavigationProjection,
  createRendererDeepLinkPreview,
  filterNavigationMarkers,
  firstMessageIndex,
  latestOutputIndex,
  nextIssueIndex,
  nextPromptIndex,
  parseRendererDeepLinkPreview,
  previousIssueIndex,
  previousPromptIndex,
  resolveRendererDeepLinkPreview,
} from "./conversation-navigation-model";
import type { ChatMessage } from "./types";

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "message-default",
    role: "user",
    content: "A message",
    createdAt: "2026-09-14T00:00:00.000Z",
    status: "complete",
    modelLabel: null,
    runId: null,
    attachments: [],
    branchIndex: 1,
    branchCount: 1,
    ...overrides,
  };
}

describe("conversation navigation projection", () => {
  it("preserves message order and classifies prompts, outputs and issues", () => {
    const projection = buildNavigationProjection([
      message({ id: "prompt-1", content: "First prompt" }),
      message({ id: "output-1", role: "assistant", content: "First output", modelLabel: "Local" }),
      message({ id: "failed-1", role: "assistant", status: "failed", content: "Provider failed" }),
      message({ id: "stopped-1", role: "assistant", status: "stopped", content: "Stopped run" }),
      message({ id: "streaming-1", role: "assistant", status: "streaming", content: "Partial output" }),
    ]);

    expect(projection.markers.map((marker) => [marker.messageId, marker.kind])).toEqual([
      ["prompt-1", "prompt"],
      ["output-1", "output"],
      ["failed-1", "issue"],
      ["stopped-1", "issue"],
      ["streaming-1", "output"],
    ]);
    expect(projection.promptCount).toBe(1);
    expect(projection.outputCount).toBe(2);
    expect(projection.issueCount).toBe(2);
    expect(projection.markers.at(-1)?.label).toMatch(/active run/);
  });

  it("retains branch metadata and bounds long excerpts", () => {
    const projection = buildNavigationProjection([
      message({
        id: "branched",
        content: "x".repeat(300),
        branchIndex: 2,
        branchCount: 4,
      }),
    ]);
    const marker = projection.markers[0];
    if (!marker) throw new Error("Expected one navigation marker.");
    expect(marker.excerpt.length).toBeLessThanOrEqual(108);
    expect(marker.label).toContain("branch 2/4");
  });

  it("navigates helper indices without wrapping at boundaries", () => {
    const projection = buildNavigationProjection([
      message({ id: "prompt-1" }),
      message({ id: "issue-1", role: "assistant", status: "failed" }),
      message({ id: "prompt-2" }),
      message({ id: "output-1", role: "assistant" }),
    ]);
    expect(firstMessageIndex(projection)).toBe(0);
    expect(latestOutputIndex(projection)).toBe(3);
    expect(nextPromptIndex(projection, 0)).toBe(2);
    expect(previousPromptIndex(projection, 2)).toBe(0);
    expect(nextIssueIndex(projection, 0)).toBe(1);
    expect(previousIssueIndex(projection, 3)).toBe(1);
    expect(nextPromptIndex(projection, 2)).toBeUndefined();
    expect(previousPromptIndex(projection, 0)).toBeUndefined();
  });

  it("handles an empty conversation", () => {
    const projection = buildNavigationProjection([]);
    expect(projection).toEqual({ markers: [], promptCount: 0, outputCount: 0, issueCount: 0 });
  });

  it("filters by typed facets and bounded query metadata without changing order", () => {
    const projection = buildNavigationProjection([
      message({ id: "prompt", content: "Plan the branch", attachments: [{ id: "attachment-1", name: "notes.md", kind: "document", size: "1 KB", state: "ready" }] }),
      message({ id: "active", role: "assistant", content: "Streaming answer", status: "streaming", modelLabel: "Reasoner", runId: "run-active" }),
      message({ id: "issue", role: "assistant", content: "Provider timeout", status: "failed" }),
      message({ id: "branch", role: "assistant", content: "Alternate path", branchIndex: 2, branchCount: 3 }),
    ]);

    expect(filterNavigationMarkers(projection.markers, { query: "reasoner", facet: "all" }).map((item) => item.messageId)).toEqual(["active"]);
    expect(filterNavigationMarkers(projection.markers, { query: "", facet: "issue" }).map((item) => item.messageId)).toEqual(["issue"]);
    expect(filterNavigationMarkers(projection.markers, { query: "", facet: "attached" }).map((item) => item.messageId)).toEqual(["prompt"]);
    expect(filterNavigationMarkers(projection.markers, { query: "", facet: "branched" }).map((item) => item.messageId)).toEqual(["branch"]);
    expect(filterNavigationMarkers(projection.markers, { query: "", facet: "with-run" }).map((item) => item.messageId)).toEqual(["active"]);
    expect(filterNavigationMarkers(projection.markers, { query: "", facet: "with-model" }).map((item) => item.messageId)).toEqual(["active"]);
  });

  it("creates a stable-looking preview deep link without embedding message content", () => {
    expect(createRendererDeepLinkPreview({ conversationId: "chat/one", branchId: "branch-a", messageId: "message-9", selectionId: "selection-2" })).toBe(
      "omnia://chat/chat%2Fone?branch=branch-a&message=message-9&selection=selection-2",
    );
    expect(createRendererDeepLinkPreview({ conversationId: "  " })).toBe("");
  });

  it("round-trips project context and typed run lineage through the preview URI", () => {
    const uri = createRendererDeepLinkPreview({
      projectId: "project-a",
      conversationId: "conversation-1",
      branchId: "branch-2",
      runId: "run-7",
      attemptId: "attempt-3",
      eventCursor: 18,
      sourceRevision: "rev-9",
      targetKind: "attempt",
    });
    expect(uri).toBe(
      "omnia://project/project-a/chat/conversation-1?branch=branch-2&run=run-7&attempt=attempt-3&cursor=18&revision=rev-9&target=attempt",
    );
    const parsed = parseRendererDeepLinkPreview(uri);
    expect(parsed.status).toBe("valid");
    expect(parsed.target).toMatchObject({
      scope: "project-chat",
      projectId: "project-a",
      conversationId: "conversation-1",
      branchId: "branch-2",
      runId: "run-7",
      attemptId: "attempt-3",
      eventCursor: 18,
      sourceRevision: "rev-9",
      targetKind: "attempt",
    });
  });

  it("rejects malformed or unknown deep-link parameters instead of guessing", () => {
    expect(parseRendererDeepLinkPreview("omnia://chat/conversation-1?message=message-1&message=").reason).toBe("duplicate-parameter");
    expect(parseRendererDeepLinkPreview("omnia://chat/conversation-1?unknown=value")).toMatchObject({ status: "unsupported", reason: "unknown-parameter" });
    expect(parseRendererDeepLinkPreview("omnia://chat/conversation-1?target=selection&selection=selection-1")).toMatchObject({ status: "malformed", reason: "target-requires-anchor" });
    expect(parseRendererDeepLinkPreview("https://example.test/chat/conversation-1")).toMatchObject({ status: "unsupported", reason: "unsupported-scheme" });
  });

  it("resolves a typed target or returns a safe stale/unsupported ancestor", () => {
    const parsed = parseRendererDeepLinkPreview(
      "omnia://project/project-a/chat/conversation-1?branch=branch-2&message=message-1&revision=rev-9&target=message",
    );
    if (!parsed.target) throw new Error("Expected a parsed target.");
    expect(resolveRendererDeepLinkPreview(parsed.target, {
      conversationId: "conversation-1",
      projectId: "project-a",
      branchId: "branch-2",
      sourceRevision: "rev-9",
      messageIds: ["message-1"],
    })).toMatchObject({ status: "resolved", nearestAncestor: "branch" });
    expect(resolveRendererDeepLinkPreview(parsed.target, {
      conversationId: "conversation-1",
      projectId: "project-a",
      branchId: "branch-2",
      sourceRevision: "rev-8",
      messageIds: ["message-1"],
    })).toMatchObject({ status: "stale", reason: "source-revision-mismatch", nearestAncestor: "branch" });
    expect(resolveRendererDeepLinkPreview(parsed.target, {
      conversationId: "conversation-1",
      projectId: "project-a",
      branchId: "branch-2",
    })).toMatchObject({ status: "unsupported", reason: "anchor-index-unavailable" });
  });

  it("validates optional anchor fingerprints and quote hashes without guessing", () => {
    const parsed = parseRendererDeepLinkPreview(
      "omnia://chat/conversation-1?message=message-1&fingerprint=fp-1&quoteHash=quote-1&target=message",
    );
    if (!parsed.target) throw new Error("Expected a parsed target.");

    expect(resolveRendererDeepLinkPreview(parsed.target, {
      conversationId: "conversation-1",
      messageIds: ["message-1"],
      messageFingerprints: { "message-1": "fp-1" },
      messageQuoteHashes: { "message-1": "quote-1" },
    })).toMatchObject({ status: "resolved" });

    expect(resolveRendererDeepLinkPreview(parsed.target, {
      conversationId: "conversation-1",
      messageIds: ["message-1"],
      messageFingerprints: { "message-1": "fp-old" },
      messageQuoteHashes: { "message-1": "quote-1" },
    })).toMatchObject({ status: "stale", reason: "fingerprint-mismatch" });

    expect(resolveRendererDeepLinkPreview(parsed.target, {
      conversationId: "conversation-1",
      messageIds: ["message-1"],
    })).toMatchObject({ status: "unsupported", reason: "fingerprint-index-unavailable" });
  });

  it("keeps message-revision links typed when the revision index is missing or stale", () => {
    const parsed = parseRendererDeepLinkPreview(
      "omnia://chat/conversation-1?message=message-1&messageRevision=revision-2&target=message",
    );
    if (!parsed.target) throw new Error("Expected a parsed target.");

    expect(resolveRendererDeepLinkPreview(parsed.target, {
      conversationId: "conversation-1",
      messageIds: ["message-1"],
      messageRevisionIds: ["revision-2"],
    })).toMatchObject({ status: "resolved" });
    expect(resolveRendererDeepLinkPreview(parsed.target, {
      conversationId: "conversation-1",
      messageIds: ["message-1"],
      messageRevisionIds: ["revision-1"],
    })).toMatchObject({ status: "stale", reason: "message-revision-missing" });
    expect(resolveRendererDeepLinkPreview(parsed.target, {
      conversationId: "conversation-1",
      messageIds: ["message-1"],
    })).toMatchObject({ status: "unsupported", reason: "anchor-index-unavailable" });
  });
});

describe("ConversationNavigation", () => {
  it("opens the local map and navigates to a mounted message anchor", async () => {
    const onNavigate = vi.fn();
    const messages = [
      message({ id: "prompt-1", content: "First prompt" }),
      message({ id: "output-1", role: "assistant", content: "First output" }),
    ];
    const { container } = render(
      <>
        <div id="message-prompt-1" data-message-id="prompt-1" />
        <div id="message-output-1" data-message-id="output-1" />
        <ConversationNavigation messages={messages} currentMessageId="prompt-1" onNavigate={onNavigate} />
      </>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open local conversation map" }));
    expect(screen.getByRole("dialog", { name: "Local conversation map" })).toBeInTheDocument();
    expect(screen.getByText("1 prompt")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Prompt 1: First prompt/ })).toHaveAttribute("aria-current", "true");

    fireEvent.click(screen.getByRole("button", { name: /Assistant output 1: First output/ }));
    expect(onNavigate).toHaveBeenCalledWith("output-1");
    expect(container.querySelector("#conversation-navigation-panel")).toBeNull();
  });

  it("closes on Escape and pointer interaction outside the panel", () => {
    render(<ConversationNavigation messages={[message()]} currentMessageId={null} onNavigate={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: "Open local conversation map" });
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "Local conversation map" })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Local conversation map" })).not.toBeInTheDocument();

    fireEvent.click(trigger);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog", { name: "Local conversation map" })).not.toBeInTheDocument();
  });

  it("moves focus into search on open and wires the search to the marker list", async () => {
    render(<ConversationNavigation messages={[message({ id: "prompt-1" })]} currentMessageId={null} onNavigate={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: "Open local conversation map" });
    fireEvent.click(trigger);

    const search = screen.getByRole("searchbox", { name: "Search conversation targets" });
    await waitFor(() => expect(search).toHaveFocus());
    expect(search).toHaveAttribute("aria-controls", "conversation-navigation-markers");
    expect(screen.getByRole("dialog", { name: "Local conversation map" })).toHaveAttribute("aria-label", "Local conversation map");
  });

  it("reports a stale or unavailable target accessibly", async () => {
    render(
      <ConversationNavigation
        messages={[message({ id: "missing", content: "Not mounted" })]}
        currentMessageId={null}
        onNavigate={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open local conversation map" }));
    await waitFor(() => expect(screen.getByText("Unavailable")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /target unavailable in this preview/i })).toBeInTheDocument();
  });

  it("filters targets, supports roving keyboard navigation, and keeps local history", () => {
    const onNavigate = vi.fn();
    const messages = [
      message({ id: "prompt-1", content: "First prompt" }),
      message({ id: "output-1", role: "assistant", content: "Reasoned output", modelLabel: "Reasoner" }),
      message({ id: "prompt-2", content: "Second prompt" }),
    ];
    render(
      <>
        {messages.map((item) => <div key={item.id} id={`message-${item.id}`} />)}
        <ConversationNavigation messages={messages} currentMessageId="prompt-1" conversationId="conversation-1" branchId="branch-1" onNavigate={onNavigate} />
      </>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open local conversation map" }));
    const search = screen.getByRole("searchbox", { name: "Search conversation targets" });
    fireEvent.change(search, { target: { value: "reasoner" } });
    expect(screen.getByRole("button", { name: /Assistant output 1: Reasoned output/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Prompt 1: First prompt/ })).not.toBeInTheDocument();

    fireEvent.change(search, { target: { value: "" } });
    const first = screen.getByRole("button", { name: /Prompt 1: First prompt/ });
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(screen.getByRole("button", { name: /Assistant output 1: Reasoned output/ })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("button", { name: /Assistant output 1: Reasoned output/ }), { key: "Enter" });
    expect(onNavigate).toHaveBeenLastCalledWith("output-1");

    fireEvent.click(screen.getByRole("button", { name: "Open local conversation map" }));
    fireEvent.click(screen.getByRole("button", { name: /Prompt 2: Second prompt/ }));
    fireEvent.click(screen.getByRole("button", { name: "Open local conversation map" }));
    fireEvent.click(screen.getByRole("button", { name: "Previous local target" }));
    expect(onNavigate).toHaveBeenLastCalledWith("output-1");
  });

  it("keeps the map open when changing target facets", () => {
    const messages = [
      message({ id: "prompt-1", content: "First prompt" }),
      message({ id: "output-1", role: "assistant", content: "First output" }),
    ];
    render(
      <>
        {messages.map((item) => <div key={item.id} id={`message-${item.id}`} />)}
        <ConversationNavigation messages={messages} currentMessageId="prompt-1" onNavigate={vi.fn()} />
      </>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open local conversation map" }));
    fireEvent.click(screen.getByRole("button", { name: "Prompts" }));

    expect(screen.getByRole("dialog", { name: "Local conversation map" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Prompts" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("button", { name: /Assistant output 1: First output/ })).not.toBeInTheDocument();
  });

  it("makes the filter affordance reveal and hide its facet group", () => {
    render(
      <ConversationNavigation
        messages={[message({ id: "prompt-1" }), message({ id: "output-1", role: "assistant" })]}
        currentMessageId="prompt-1"
        onNavigate={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open local conversation map" }));
    const filterButton = screen.getByRole("button", { name: "Conversation target filters" });
    expect(filterButton).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("group", { name: "Conversation target filters" })).toBeInTheDocument();

    fireEvent.click(filterButton);
    expect(filterButton).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("group", { name: "Conversation target filters" })).not.toBeInTheDocument();

    fireEvent.click(filterButton);
    expect(filterButton).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Prompts" })).toBeInTheDocument();
  });

  it("copies a renderer-local deep-link preview and reports clipboard boundaries", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(
      <>
        <div id="message-prompt-1" />
        <ConversationNavigation messages={[message({ id: "prompt-1", content: "First prompt" })]} currentMessageId="prompt-1" conversationId="conversation-1" branchId="branch-1" onNavigate={vi.fn()} />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open local conversation map" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("omnia://chat/conversation-1?branch=branch-1&message=prompt-1"));
    expect(screen.getByText(/Copied a renderer-local deep-link preview/)).toBeInTheDocument();
  });

  it("shows project-scoped target provenance without claiming native routing", () => {
    render(
      <>
        <div id="message-prompt-1" />
        <ConversationNavigation
          messages={[message({ id: "prompt-1", content: "Project prompt" })]}
          currentMessageId="prompt-1"
          conversationId="conversation-1"
          projectId="project-a"
          branchId="branch-1"
          onNavigate={vi.fn()}
        />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open local conversation map" }));
    expect(screen.getByText(/Chat target resolved in renderer preview/)).toBeInTheDocument();
    expect(screen.getByText(/nearest safe ancestor: branch/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy link" })).toHaveAttribute(
      "title",
      "omnia://project/project-a/chat/conversation-1?branch=branch-1&message=prompt-1",
    );
  });
});
