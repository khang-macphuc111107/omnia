import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { initialConversations, initialProjects, initialProviders } from "./mock-data";
import { useWorkspaceStore } from "./store";
import { buildChatSignalProjection, ChatSignalStrip } from "./chat-signal-strip";
import {
  DEFAULT_SIGNAL_PREFERENCES,
  resetSignalPreferencesSession,
  updateSignalPreferences,
} from "./session-signal-contract";
import type { RunTimelineEventView } from "./evidence-types";

const initialState = useWorkspaceStore.getState();

const timelineEvent: RunTimelineEventView = {
  id: "timeline-chat-signal",
  runId: "run-chat-signal",
  parentEventId: null,
  sequence: 1,
  type: "provider.complete",
  stage: "provider",
  status: "complete",
  summary: "Provider response completed",
  detail: "A renderer-visible run receipt is available for inspection.",
  startedAt: "2026-09-21T09:00:00.000Z",
  endedAt: "2026-09-21T09:00:02.000Z",
  source: "provider",
  providerLabel: "Preview provider",
  attemptOrdinal: 1,
  citationIds: [],
};

describe("ChatSignalStrip", () => {
  afterEach(() => {
    useWorkspaceStore.setState(initialState, true);
    resetSignalPreferencesSession();
    document.body.innerHTML = "";
  });

  it("projects selected-chat attention and active state without a durable event journal", () => {
    const conversation = {
      ...initialConversations[0]!,
      unread: true,
      runState: "streaming" as const,
    };
    const projection = buildChatSignalProjection({
      conversation,
      conversations: [conversation],
      generatedAt: "2026-09-21T09:00:00.000Z",
    });

    expect(projection.counts.attention).toBe(1);
    expect(projection.counts.active).toBe(1);
    expect(projection.events.map((event) => event.title)).toEqual(expect.arrayContaining([
      "Unread chat activity",
      conversation.title,
    ]));
    expect(projection.boundary.rendererOnly).toBe(true);
    expect(projection.boundary.noDurableWrite).toBe(true);
  });

  it("keeps run timeline signals scoped to the active conversation", () => {
    const conversation = {
      ...initialConversations[0]!,
      messages: [
        ...initialConversations[0]!.messages,
        {
          ...initialConversations[0]!.messages[0]!,
          id: "message-chat-signal-run",
          role: "assistant" as const,
          runId: timelineEvent.runId,
        },
      ],
    };
    const otherConversation = { ...initialConversations[1]!, runState: "streaming" as const };
    const projection = buildChatSignalProjection({
      conversation,
      conversations: [conversation, otherConversation],
      runTimelineEvents: [timelineEvent],
      generatedAt: "2026-09-21T09:00:00.000Z",
    });

    expect(projection.events.some((event) => event.runId === timelineEvent.runId)).toBe(true);
    expect(projection.events.every((event) => event.conversationId === conversation.id || event.runId === timelineEvent.runId)).toBe(true);
    expect(projection.events.some((event) => event.title === otherConversation.title)).toBe(false);
  });

  it("filters visible signals and rehearses run-inspector navigation in the renderer", () => {
    const conversation = {
      ...initialConversations[0]!,
      unread: true,
      runState: "streaming" as const,
      messages: [
        ...initialConversations[0]!.messages,
        {
          ...initialConversations[0]!.messages[0]!,
          id: "message-chat-signal-run-ui",
          role: "assistant" as const,
          runId: timelineEvent.runId,
        },
      ],
    };
    const onOpenRunInspector = vi.fn();
    useWorkspaceStore.setState({
      conversations: [conversation],
      projects: initialProjects,
      providers: initialProviders,
      runTimelineEvents: [timelineEvent],
    });

    render(<ChatSignalStrip conversation={conversation} onOpenRunInspector={onOpenRunInspector} />);

    expect(screen.getByRole("region", { name: "Chat signal strip" })).toBeInTheDocument();
    expect(screen.getByText("Renderer-local")).toBeInTheDocument();
    expect(screen.getByText("Unread chat activity")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /Done/i }));
    expect(screen.getByRole("tab", { name: /Done/i })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByText("Unread chat activity")).not.toBeInTheDocument();

    const event = screen.getByRole("listitem", { name: /Provider response completed: A renderer-visible run receipt/i });
    fireEvent.click(event);
    expect(onOpenRunInspector).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status")).toHaveTextContent(/no native acknowledgement/i);

    const footer = screen.getByRole("status");
    expect(within(footer).getByRole("button", { name: /Open run inspector/i })).toBeInTheDocument();
  });

  it("offers a bounded JSON/Markdown export from the Chat signal surface", () => {
    const conversation = {
      ...initialConversations[0]!,
      unread: true,
    };
    useWorkspaceStore.setState({
      conversations: [conversation],
      projects: initialProjects,
      providers: initialProviders,
    });

    render(<ChatSignalStrip conversation={conversation} />);

    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    expect(screen.getByRole("group", { name: "Chat signal export preview" })).toBeInTheDocument();
    expect(screen.getByLabelText("JSON Chat signal export preview")).toHaveTextContent(
      '"schema": "omnia.unified-event.preview.v1"',
    );

    fireEvent.change(screen.getByLabelText("Chat signal export format"), {
      target: { value: "markdown" },
    });
    expect(screen.getByLabelText("Markdown Chat signal export preview")).toHaveTextContent(
      "# Omnia unified event preview",
    );
    expect(screen.getByText(/Preview only · renderer-local · no durable write/i)).toBeInTheDocument();
  });

  it("does not hide additional signals behind the compact four-item preview", () => {
    const events = [0, 1, 2].map((index) => ({
      ...timelineEvent,
      id: `timeline-chat-signal-${index}`,
      runId: `run-chat-signal-${index}`,
      sequence: index + 1,
      summary: `Provider response ${index + 1}`,
    }));
    const conversation = {
      ...initialConversations[0]!,
      messages: [
        ...initialConversations[0]!.messages,
        ...events.map((event, index) => ({
          ...initialConversations[0]!.messages[0]!,
          id: `message-chat-signal-${index}`,
          role: "assistant" as const,
          runId: event.runId,
        })),
      ],
    };
    useWorkspaceStore.setState({
      conversations: [conversation],
      projects: initialProjects,
      providers: initialProviders,
      runTimelineEvents: events,
    });

    render(<ChatSignalStrip conversation={conversation} />);

    const list = screen.getByRole("list", { name: /Chat signals/i });
    expect(within(list).getAllByRole("listitem")).toHaveLength(4);
    fireEvent.click(screen.getByRole("button", { name: /Show all 6 signals/i }));
    expect(within(list).getAllByRole("listitem")).toHaveLength(6);
    expect(screen.getByRole("button", { name: "Show fewer signals" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("supports roving keyboard navigation across signal filters", () => {
    const conversation = { ...initialConversations[0]!, unread: true };
    useWorkspaceStore.setState({
      conversations: [conversation],
      projects: initialProjects,
      providers: initialProviders,
    });

    render(<ChatSignalStrip conversation={conversation} />);

    const all = screen.getByRole("tab", { name: /All/i });
    const unread = screen.getByRole("tab", { name: /Unread/i });
    const attention = screen.getByRole("tab", { name: /Attention/i });
    expect(all).toHaveAttribute("tabindex", "0");
    expect(attention).toHaveAttribute("tabindex", "-1");

    fireEvent.keyDown(all, { key: "ArrowRight" });
    expect(unread).toHaveFocus();
    expect(unread).toHaveAttribute("aria-selected", "true");
    expect(unread).toHaveAttribute("tabindex", "0");

    fireEvent.keyDown(unread, { key: "End" });
    expect(screen.getByRole("tab", { name: /Failures/i })).toHaveFocus();
    expect(screen.getByRole("tab", { name: /Failures/i })).toHaveAttribute("aria-selected", "true");
  });

  it("maps every shared default filter that Chat can display instead of collapsing unread and planned into all", () => {
    const conversation = { ...initialConversations[0]!, unread: true };
    useWorkspaceStore.setState({ conversations: [conversation], projects: initialProjects, providers: initialProviders });

    updateSignalPreferences({ ...DEFAULT_SIGNAL_PREFERENCES, defaultFilter: "unread" });
    const unreadView = render(<ChatSignalStrip conversation={conversation} />);
    expect(screen.getByRole("tab", { name: /Unread/i })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Unread chat activity")).toBeInTheDocument();
    unreadView.unmount();

    updateSignalPreferences({ defaultFilter: "planned" });
    render(<ChatSignalStrip conversation={conversation} />);
    expect(screen.getByRole("tab", { name: /Planned/i })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText(/No signals match this filter/i)).toBeInTheDocument();
  });

  it("honors shared source visibility in the Chat-local projection", () => {
    const conversation = { ...initialConversations[0]!, unread: true };
    updateSignalPreferences({
      ...DEFAULT_SIGNAL_PREFERENCES,
      enabledSources: { ...DEFAULT_SIGNAL_PREFERENCES.enabledSources, chat: false },
    });
    useWorkspaceStore.setState({ conversations: [conversation], projects: initialProjects, providers: initialProviders });

    render(<ChatSignalStrip conversation={conversation} />);

    expect(screen.getByText(/No signals match this filter/i)).toBeInTheDocument();
    expect(screen.queryByText("Unread chat activity")).not.toBeInTheDocument();
  });
});
