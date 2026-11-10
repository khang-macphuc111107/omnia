import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { initialConversations, initialProjects } from "./mock-data";
import {
  DEFAULT_MISSION_CONTROL_SIGNAL_REFINEMENTS,
  MissionControlSignalCenter,
  matchesMissionControlSignalRefinements,
  unifiedEventsFromMissionControlSources,
} from "./mission-control-signal-center";
import type { NotificationItem } from "./notification-center-contract";
import {
  DEFAULT_SIGNAL_PREFERENCES,
  resetSignalPreferencesSession,
  updateSignalPreferences,
} from "./session-signal-contract";

const notification: NotificationItem = {
  id: "mission-control-approval",
  dedupeKey: "mission-control-approval",
  kind: "approval",
  title: "Review the project route",
  summary: "A renderer-visible approval candidate is ready for review.",
  status: "unread",
  priority: "urgent",
  occurredAt: "2026-09-21T09:10:00.000Z",
  sourceLabel: "Project route preview",
  projectId: "project-omnia",
  requiresInput: true,
  channels: ["in-app"],
  actions: [{ id: "review", label: "Review", kind: "review", disposition: "available" }],
};

describe("MissionControlSignalCenter", () => {
  afterEach(() => {
    vi.useRealTimers();
    resetSignalPreferencesSession();
  });

  it("adapts Chat, Project, and notification facts without claiming a durable journal", () => {
    const conversation = {
      ...initialConversations[0]!,
      unread: true,
      runState: "failed" as const,
    };
    const events = unifiedEventsFromMissionControlSources({
      conversations: [conversation],
      projects: [initialProjects[0]!],
      notifications: [notification],
    });

    expect(events.map((event) => event.source)).toEqual(expect.arrayContaining(["chat", "project", "notification"]));
    expect(events.find((event) => event.source === "chat")).toMatchObject({
      state: "failed",
      requiresInput: true,
      durability: "renderer-session",
    });
    expect(events.find((event) => event.source === "notification")).toMatchObject({
      state: "attention",
      requiresInput: true,
    });
  });

  it("exposes composable metadata refinements for a Project Deck signal slice", () => {
    const conversation = {
      ...initialConversations[0]!,
      unread: true,
      runState: "streaming" as const,
    };
    const events = unifiedEventsFromMissionControlSources({
      conversations: [conversation],
      projects: [initialProjects[0]!],
      notifications: [notification],
    });
    const urgent = events.find((event) => event.id === notification.id)!;
    const chat = events.find((event) => event.source === "chat")!;

    expect(matchesMissionControlSignalRefinements(
      urgent,
      { ...DEFAULT_MISSION_CONTROL_SIGNAL_REFINEMENTS, priority: "urgent" },
    )).toBe(true);
    expect(matchesMissionControlSignalRefinements(
      chat,
      { ...DEFAULT_MISSION_CONTROL_SIGNAL_REFINEMENTS, priority: "urgent" },
    )).toBe(false);
    expect(matchesMissionControlSignalRefinements(
      urgent,
      { ...DEFAULT_MISSION_CONTROL_SIGNAL_REFINEMENTS, input: "required" },
    )).toBe(true);
    expect(matchesMissionControlSignalRefinements(
      chat,
      { ...DEFAULT_MISSION_CONTROL_SIGNAL_REFINEMENTS, input: "not-required" },
    )).toBe(true);
    expect(matchesMissionControlSignalRefinements(
      urgent,
      { ...DEFAULT_MISSION_CONTROL_SIGNAL_REFINEMENTS, review: "reviewed" },
      new Set(),
    )).toBe(false);
    expect(matchesMissionControlSignalRefinements(
      urgent,
      { ...DEFAULT_MISSION_CONTROL_SIGNAL_REFINEMENTS, review: "reviewed" },
      new Set([urgent.id]),
    )).toBe(true);
  });

  it("filters Project Deck signals by priority, input state, and review state", () => {
    const conversation = {
      ...initialConversations[0]!,
      unread: true,
      runState: "streaming" as const,
    };
    render(
      <MissionControlSignalCenter
        conversations={[conversation]}
        projects={[initialProjects[0]!]} 
        notifications={[notification]}
      />,
    );

    fireEvent.change(screen.getByRole("combobox", { name: "Signal priority filter" }), { target: { value: "urgent" } });
    expect(screen.getByRole("heading", { name: notification.title })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: conversation.title })).not.toBeInTheDocument();
    expect(screen.getByText("1 visible after refinements")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("combobox", { name: "Signal input filter" }), { target: { value: "not-required" } });
    expect(screen.getByText(/No signals match this view\./i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear Mission Control signal refinements" }));
    expect(screen.getByRole("heading", { name: notification.title })).toBeInTheDocument();

    const selectedDetail = screen.getByRole("complementary", { name: /Selected signal Review the project route/i });
    fireEvent.click(within(selectedDetail).getByRole("button", { name: /^Mark reviewed$/ }));
    fireEvent.change(screen.getByRole("combobox", { name: "Signal review filter" }), { target: { value: "reviewed" } });
    expect(screen.getByRole("heading", { name: notification.title })).toBeInTheDocument();
    expect(screen.getByText("1 visible after refinements")).toBeInTheDocument();
  });

  it("filters, opens a renderer callback, and keeps review/snooze session-local", () => {
    const onOpenEvent = vi.fn();
    const conversation = {
      ...initialConversations[0]!,
      unread: true,
      runState: "failed" as const,
    };

    render(
      <MissionControlSignalCenter
        conversations={[conversation]}
        projects={[initialProjects[0]!]}
        notifications={[notification]}
        onOpenEvent={onOpenEvent}
      />,
    );

    expect(screen.getByRole("region", { name: "Mission Control signal center" })).toBeInTheDocument();
    expect(screen.getByText("Renderer-local")).toBeInTheDocument();
    expect(screen.getByText(/durable run journal/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Attention" }));
    expect(screen.getByRole("tab", { name: "Attention" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("heading", { name: "Review the project route" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Notifications" }));
    expect(screen.getByRole("tab", { name: "Notifications" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("heading", { name: "Review the project route" })).toBeInTheDocument();

    const detail = screen.getByRole("complementary", { name: /Selected signal Review the project route/i });
    fireEvent.click(within(detail).getByRole("button", { name: "Open project preview" }));
    expect(onOpenEvent).toHaveBeenCalledWith(expect.objectContaining({ projectId: "project-omnia" }));
    expect(screen.getByRole("status")).toHaveTextContent(/no native dispatch was started/i);

    fireEvent.click(screen.getByRole("button", { name: "Snooze session" }));
    expect(screen.getByRole("status")).toHaveTextContent(/session only/i);
  });

  it("lets a renderer-session snooze expire without a durable acknowledgement", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-21T10:00:00.000Z"));
    const conversation = {
      ...initialConversations[0]!,
      unread: true,
      runState: "failed" as const,
    };

    render(<MissionControlSignalCenter conversations={[conversation]} />);
    const title = conversation.title;
    const signalList = screen.getByRole("list", { name: "Mission Control signals" });
    expect(within(signalList).getByText(title)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Snooze session" }));
    expect(within(signalList).queryByText(title)).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(30 * 60_000 + 15_000);
    });
    expect(within(screen.getByRole("list", { name: "Mission Control signals" })).getByText(title)).toBeInTheDocument();
    expect(screen.getByText(/durable run journal/i)).toBeInTheDocument();
  });

  it("consumes source visibility from the shared renderer-session preference contract", () => {
    const conversation = {
      ...initialConversations[0]!,
      unread: true,
      runState: "streaming" as const,
    };
    updateSignalPreferences({
      ...DEFAULT_SIGNAL_PREFERENCES,
      enabledSources: { ...DEFAULT_SIGNAL_PREFERENCES.enabledSources, chat: false },
    });

    render(<MissionControlSignalCenter conversations={[conversation]} projects={[initialProjects[0]!]} />);

    expect(screen.queryByText(conversation.title)).not.toBeInTheDocument();
    expect(screen.getAllByText(initialProjects[0]!.name).length).toBeGreaterThan(0);
  });

  it("keeps labelled signal regions unique when Home and Project surfaces coexist", () => {
    render(
      <>
        <MissionControlSignalCenter title="Workspace signal center" />
        <MissionControlSignalCenter title="Project signal center" />
      </>,
    );

    const regions = Array.from(document.querySelectorAll<HTMLElement>(".mission-control-signal-center"));
    expect(regions).toHaveLength(2);
    const labelledBy = regions.map((region) => region.getAttribute("aria-labelledby"));
    expect(labelledBy.every((value) => value)).toBe(true);
    expect(new Set(labelledBy).size).toBe(2);
    expect(labelledBy.map((value) => document.getElementById(value!))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ textContent: "Workspace signal center" }),
        expect.objectContaining({ textContent: "Project signal center" }),
      ]),
    );
  });
});
