import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./agent-api", () => ({
  errorMessage: (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)),
  agentApi: {
    schedules: vi.fn(),
    saveSchedule: vi.fn(),
    deleteSchedule: vi.fn(),
    runScheduleNow: vi.fn(),
    previewSchedule: vi.fn(),
    listProfiles: vi.fn(),
    pickFolder: vi.fn(),
  },
}));
import { agentApi } from "./agent-api";
import { useAgentStore } from "./agent-store";
import { describeCron, SchedulesDialog } from "./schedules-dialog";
import type { AgentSchedule } from "./types";

const api = vi.mocked(agentApi);
const weekday: AgentSchedule = {
  id: "a", name: "Morning report", sessionId: "s1", newSession: null, prompt: "summarize",
  cron: "0 9 * * 1-5", intervalMinutes: null, enabled: true,
  lastRunAt: 1_700_000_000_000, nextRunAt: 1_700_086_400_000, lastStatus: "completed", lastMessage: null,
};
const paused: AgentSchedule = {
  id: "b", name: "Hourly", sessionId: "s1", newSession: null, prompt: "ping",
  cron: null, intervalMinutes: 60, enabled: false, lastStatus: "skipped: session busy",
};

beforeEach(() => {
  vi.clearAllMocks();
  useAgentStore.setState({
    sessions: [{ id: "s1", title: "Main work" } as never],
    activeId: "s1",
  });
  api.schedules.mockResolvedValue([weekday, paused]);
  api.previewSchedule.mockResolvedValue([1_700_000_000_000, 1_700_086_400_000, 1_700_172_800_000]);
  api.listProfiles.mockResolvedValue([]);
  api.saveSchedule.mockImplementation(async (s) => [{ ...(s as AgentSchedule), id: s.id ?? "new" }]);
  api.deleteSchedule.mockResolvedValue([paused]);
  api.runScheduleNow.mockResolvedValue(undefined);
});

describe("describeCron", () => {
  it("names common shapes and falls back to the raw expression", () => {
    expect(describeCron("0 9 * * 1-5")).toBe("Every weekday at 09:00");
    expect(describeCron("*/15 * * * *")).toBe("Every 15 minutes");
    expect(describeCron("30 6 * * 7")).toBe("Every Sunday at 06:30");
    expect(describeCron("5 14 * * *")).toBe("Every day at 14:05");
    expect(describeCron("0 0 1 * *")).toBe("Day 1 of every month at 00:00");
    expect(describeCron("0 0 1 1 *")).toBe("Cron 0 0 1 1 *");
  });
});

describe("SchedulesDialog", () => {
  it("focuses the editor, cancels it with Escape, and restores the originating control", async () => {
    const onClose = vi.fn();
    render(<SchedulesDialog onClose={onClose} />);
    const edit = await screen.findByRole("button", { name: "Morning report" });
    edit.focus();
    fireEvent.click(edit);
    expect(screen.getByRole("dialog", { name: "Edit schedule" })).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveFocus();
    fireEvent.keyDown(screen.getByLabelText("Name"), { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "Scheduled tasks" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Morning report" })).toHaveFocus();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("returns focus to New schedule on cancel and after saving", async () => {
    render(<SchedulesDialog onClose={vi.fn()} />);
    await screen.findByText("Morning report");
    fireEvent.click(screen.getByRole("button", { name: "New schedule" }));
    expect(screen.getByLabelText("Name")).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "New schedule" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "New schedule" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Saved" } });
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Work" } });
    fireEvent.click(screen.getByRole("button", { name: "Save schedule" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "New schedule" })).toHaveFocus());
  });

  it("keeps delete confirmation above the mounted list and Escape restores its trigger", async () => {
    const onClose = vi.fn();
    render(<SchedulesDialog onClose={onClose} />);
    const trigger = await screen.findByRole("button", { name: "Delete Morning report" });
    trigger.focus();
    fireEvent.click(trigger);
    const confirmation = screen.getByRole("dialog", { name: "Delete schedule?" });
    await waitFor(() => expect(within(confirmation).getByRole("button", { name: "Cancel" })).toHaveFocus());
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Delete schedule?" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(onClose).not.toHaveBeenCalled();
    expect(api.deleteSchedule).not.toHaveBeenCalled();
  });

  it("wraps Tab focus within the editor and restores outside focus on unmount", async () => {
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();
    const view = render(<SchedulesDialog onClose={vi.fn()} />);
    await screen.findByText("Morning report");
    fireEvent.click(screen.getByRole("button", { name: "New schedule" }));
    const first = screen.getByLabelText("Name");
    const cancel = screen.getByRole("button", { name: "Cancel" });
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(cancel).toHaveFocus();
    fireEvent.keyDown(cancel, { key: "Tab" });
    expect(first).toHaveFocus();
    view.unmount();
    expect(outside).toHaveFocus();
    outside.remove();
  });

  it("keeps long names and messages in the scroll body and actions outside it", async () => {
    const name = "schedule".repeat(100);
    const message = "failure".repeat(200);
    api.schedules.mockResolvedValue([{ ...weekday, name, lastMessage: message }]);
    render(<SchedulesDialog onClose={vi.fn()} />);
    const edit = await screen.findByRole("button", { name });
    const body = edit.closest(".ag-schedules__body");
    expect(body).not.toBeNull();
    expect(within(body as HTMLElement).getByText(new RegExp(message))).toBeInTheDocument();
    expect(body?.contains(screen.getByRole("button", { name: "New schedule" }))).toBe(false);
    fireEvent.click(edit);
    const nameInput = screen.getByLabelText("Name");
    expect(nameInput).toHaveValue(name);
    expect(nameInput.closest(".ag-schedules__body")?.contains(screen.getByRole("button", { name: "Save schedule" }))).toBe(false);
  });
  it("groups active and paused schedules and states the app-open rule", async () => {
    render(<SchedulesDialog onClose={vi.fn()} />);
    const active = await screen.findByRole("region", { name: "Active" });
    expect(within(active).getByText("Morning report")).toBeInTheDocument();
    expect(within(active).getByText(/Every weekday at 09:00/)).toBeInTheDocument();
    expect(within(active).getByText(/Last: completed/)).toBeInTheDocument();
    const pausedGroup = screen.getByRole("region", { name: "Paused" });
    expect(within(pausedGroup).getByText(/Last: skipped: session busy/)).toBeInTheDocument();
    expect(screen.getByText(/only while Omnia is open/)).toBeInTheDocument();
  });

  it("toggles, runs now and deletes after confirmation", async () => {
    render(<SchedulesDialog onClose={vi.fn()} />);
    await screen.findByText("Morning report");
    fireEvent.click(screen.getByLabelText("Enable Morning report"));
    await waitFor(() => expect(api.saveSchedule).toHaveBeenCalledWith(expect.objectContaining({ id: "a", enabled: false })));
    fireEvent.click(screen.getByLabelText("Run Morning report now"));
    await waitFor(() => expect(api.runScheduleNow).toHaveBeenCalledWith("a"));
    fireEvent.click(screen.getByLabelText("Delete Hourly"));
    expect(api.deleteSchedule).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() => expect(api.deleteSchedule).toHaveBeenCalledWith("b"));
  });

  it("creates a cron schedule for the active session with a live preview", async () => {
    render(<SchedulesDialog onClose={vi.fn()} />);
    await screen.findByText("Morning report");
    fireEvent.click(screen.getByRole("button", { name: "New schedule" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Nightly" } });
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "run tests" } });
    await waitFor(() => expect(api.previewSchedule).toHaveBeenCalledWith("0 9 * * 1-5"));
    expect(await screen.findByLabelText("Next runs")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save schedule" }));
    await waitFor(() =>
      expect(api.saveSchedule).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Nightly", sessionId: "s1", newSession: null, prompt: "run tests",
          cron: "0 9 * * 1-5", intervalMinutes: null, enabled: true,
        }),
      ),
    );
  });

  it("blocks saving while the backend rejects the cron expression", async () => {
    api.previewSchedule.mockRejectedValue(new Error("cron never fires (impossible date)"));
    render(<SchedulesDialog onClose={vi.fn()} />);
    await screen.findByText("Morning report");
    fireEvent.click(screen.getByRole("button", { name: "New schedule" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "x" } });
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "y" } });
    fireEvent.change(screen.getByLabelText(/^Cron/), { target: { value: "0 0 30 2 *" } });
    expect(await screen.findByText(/never fires/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save schedule" })).toBeDisabled();
  });

  it("builds an interval schedule with a new-session template", async () => {
    api.listProfiles.mockResolvedValue([{ id: "p1", displayName: "Main", enabled: true } as never]);
    render(<SchedulesDialog onClose={vi.fn()} />);
    await screen.findByText("Morning report");
    fireEvent.click(screen.getByRole("button", { name: "New schedule" }));
    fireEvent.change(screen.getByLabelText("Run in"), { target: { value: "__new__" } });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Poll" } });
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "check" } });
    fireEvent.change(await screen.findByLabelText("Folder"), { target: { value: "D:/work" } });
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "m1" } });
    fireEvent.change(screen.getByLabelText("Repeat"), { target: { value: "interval" } });
    fireEvent.change(screen.getByLabelText("Minutes between runs"), { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: "Save schedule" }));
    await waitFor(() =>
      expect(api.saveSchedule).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: null, cron: null, intervalMinutes: 30,
          newSession: expect.objectContaining({ cwd: "D:/work", profileId: "p1", model: "m1" }),
        }),
      ),
    );
  });
});
