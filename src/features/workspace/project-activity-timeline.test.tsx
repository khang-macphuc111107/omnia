import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useWorkspaceStore } from "./store";
import {
  ProjectActivityTimeline,
  buildProjectActivityEvents,
  filterProjectActivityEvents,
  serializeProjectActivity,
  sortProjectActivityEvents,
} from "./project-activity-timeline";

const initialState = useWorkspaceStore.getState();

describe("ProjectActivityTimeline", () => {
  afterEach(() => {
    useWorkspaceStore.setState(initialState, true);
    document.body.innerHTML = "";
  });

  it("projects visible project and chat signals with truthful filters", () => {
    const state = useWorkspaceStore.getState();
    const project = state.projects[0]!;
    const conversations = state.conversations.filter((conversation) => conversation.projectId === project.id);
    const events = buildProjectActivityEvents(project, conversations);

    render(<ProjectActivityTimeline project={project} conversations={conversations} />);

    expect(screen.getByRole("complementary", { name: "Selected project activity detail" })).toBeInTheDocument();
    expect(screen.getByText("A readable trail of Project work")).toBeInTheDocument();
    expect(screen.getByText(`${events.length} shown · ${events.length} total`)).toBeInTheDocument();

    fireEvent.change(screen.getByRole("combobox", { name: "Filter project activity status" }), {
      target: { value: "planned" },
    });
    expect(within(screen.getByLabelText("Project activity summary")).getByText(/planned gaps/i)).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Project activity events" })).getByText(/Project Twin refresh remains pending|No project chats are visible/i)).toBeInTheDocument();
  });

  it("filters by source and searches actor/related metadata", () => {
    const state = useWorkspaceStore.getState();
    const project = state.projects[0]!;
    const conversations = state.conversations.filter((conversation) => conversation.projectId === project.id);
    const events = buildProjectActivityEvents(project, conversations);

    expect(filterProjectActivityEvents(events, { sourceLabel: "Context health" })).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "context.status" })]),
    );
    expect(filterProjectActivityEvents(events, { query: "renderer projection" }).length).toBeGreaterThan(0);
    expect(filterProjectActivityEvents(events, { query: "not-a-real-activity" })).toHaveLength(0);
  });

  it("keeps sort choices deterministic without mutating the source projection", () => {
    const source: Parameters<typeof sortProjectActivityEvents>[0] = [
      {
        id: "b",
        kind: "chat",
        type: "chat.metadata",
        title: "Zeta chat",
        detail: "Visible",
        occurredAt: "Current selection",
        actor: "Renderer projection",
        status: "preview",
        sourceLabel: "Project chat metadata",
        relatedId: null,
        relatedLabel: null,
      },
      {
        id: "a",
        kind: "project",
        type: "project.snapshot",
        title: "Alpha project",
        detail: "Visible",
        occurredAt: "Current selection",
        actor: "Renderer projection",
        status: "planned",
        sourceLabel: "Project metadata",
        relatedId: null,
        relatedLabel: null,
      },
    ];

    expect(sortProjectActivityEvents(source, "title").map((event) => event.id)).toEqual(["a", "b"]);
    expect(sortProjectActivityEvents(source, "status").map((event) => event.id)).toEqual(["b", "a"]);
    expect(source.map((event) => event.id)).toEqual(["b", "a"]);
  });

  it("exposes source and sort controls while preserving preview boundaries", () => {
    const state = useWorkspaceStore.getState();
    const project = state.projects[0]!;
    const conversations = state.conversations.filter((conversation) => conversation.projectId === project.id);

    render(<ProjectActivityTimeline project={project} conversations={conversations} />);

    fireEvent.change(screen.getByRole("combobox", { name: "Filter project activity source" }), {
      target: { value: "Context health" },
    });
    expect(screen.getByText(/1 shown ·/i)).toBeInTheDocument();

    fireEvent.change(screen.getByRole("combobox", { name: "Sort project activity" }), {
      target: { value: "title" },
    });
    expect(screen.getAllByText(/renderer-local/i).length).toBeGreaterThan(0);
    expect(screen.getByText("Preview only")).toBeInTheDocument();
  });

  it("opens a related chat through an explicit renderer-preview action", () => {
    const state = useWorkspaceStore.getState();
    const project = state.projects[0]!;
    const conversations = state.conversations.filter((conversation) => conversation.projectId === project.id);
    const relatedChat = conversations[0];
    if (!relatedChat) return;
    const onOpenRelated = vi.fn();

    render(
      <ProjectActivityTimeline
        project={project}
        conversations={conversations}
        onOpenRelated={onOpenRelated}
      />,
    );

    const chatEvent = screen.getByRole("button", { name: new RegExp(relatedChat.title.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")) });
    fireEvent.click(chatEvent);
    const detail = screen.getByRole("complementary", { name: "Selected project activity detail" });
    const openButton = within(detail).getByRole("button", { name: "Open related chat preview" });
    fireEvent.click(openButton);

    expect(onOpenRelated).toHaveBeenCalledWith(expect.objectContaining({
      kind: "chat",
      relatedId: relatedChat.id,
    }));
  });

  it("filters bookmarked events and exports session bookmark notes", () => {
    const state = useWorkspaceStore.getState();
    const project = state.projects[0]!;
    const conversations = state.conversations.filter((conversation) => conversation.projectId === project.id);
    const events = buildProjectActivityEvents(project, conversations);
    const bookmarks = { [events[0]!.id]: "Review this boundary in the next pass" };

    expect(filterProjectActivityEvents(events, {
      bookmarkedOnly: true,
      bookmarkedIds: new Set(Object.keys(bookmarks)),
    })).toEqual([events[0]]);

    const json = JSON.parse(serializeProjectActivity(events, "json", bookmarks)) as {
      bookmarkCount: number;
      bookmarks: Record<string, string>;
      events: Array<{ id: string; bookmarked: boolean; bookmarkNote: string | null }>;
    };
    expect(json.bookmarkCount).toBe(1);
    expect(json.bookmarks[events[0]!.id]).toBe("Review this boundary in the next pass");
    expect(json.events.find((event) => event.id === events[0]!.id)).toMatchObject({
      bookmarked: true,
      bookmarkNote: "Review this boundary in the next pass",
    });
    expect(serializeProjectActivity(events, "markdown", bookmarks)).toContain("- Bookmark note: Review this boundary in the next pass");
  });

  it("toggles a renderer-local bookmark, edits its note, and filters to it", () => {
    const state = useWorkspaceStore.getState();
    const project = state.projects[0]!;
    const conversations = state.conversations.filter((conversation) => conversation.projectId === project.id);

    render(<ProjectActivityTimeline project={project} conversations={conversations} />);

    fireEvent.click(screen.getAllByRole("button", { name: "Bookmark activity" })[0]!);
    expect(screen.getByText("session bookmarks").previousElementSibling).toHaveTextContent("1");
    const bookmarkFilter = screen.getByRole("button", { name: "Bookmarks (1)" });
    expect(bookmarkFilter).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(bookmarkFilter);
    expect(screen.getByRole("button", { name: "Bookmarked only" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText(/1 shown · 6 total/i)).toBeInTheDocument();

    const note = screen.getByRole("textbox", { name: "Bookmark note" });
    fireEvent.change(note, { target: { value: "Keep this visible in the handoff" } });
    expect(note).toHaveValue("Keep this visible in the handoff");
  });
});
