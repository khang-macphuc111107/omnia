import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { BackgroundWorkRow } from "./background-work-inspector";
import {
  NotificationCenterPreview,
  notificationItemsFromBackgroundRows,
} from "./notification-center-preview";

const rows: readonly BackgroundWorkRow[] = [
  {
    id: "run-approval",
    kind: "run",
    name: "Review blocked run",
    state: "needs-input",
    summary: "Approval is required before continuing.",
    createdAt: "2026-09-20T09:50:00.000Z",
    sourceThreadId: "conversation-1",
    stageLabel: "Approval",
  },
  {
    id: "run-done",
    kind: "run",
    name: "Completed analysis",
    state: "completed",
    summary: "Run completed with visible evidence.",
    createdAt: "2026-09-20T09:30:00.000Z",
    stageLabel: "Finalization",
  },
];

describe("NotificationCenterPreview", () => {
  it("projects background work into attention items and keeps the boundary visible", () => {
    const items = notificationItemsFromBackgroundRows(rows);
    render(<NotificationCenterPreview items={items} />);

    expect(screen.getByRole("region", { name: "Notification center preview" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Notification center" })).toBeInTheDocument();
    expect(screen.getByText(/Native delivery, durable acknowledgement/i)).toBeInTheDocument();
    expect(screen.getAllByText("Review blocked run").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Completed analysis").length).toBeGreaterThan(0);
  });

  it("filters, searches, selects, and rehearses an action without native dispatch", () => {
    const onOpenItem = vi.fn();
    render(<NotificationCenterPreview items={notificationItemsFromBackgroundRows(rows)} onOpenItem={onOpenItem} />);

    fireEvent.click(screen.getByRole("tab", { name: "Approvals" }));
    expect(screen.getAllByText("Review blocked run").length).toBeGreaterThan(0);
    expect(screen.queryByText("Completed analysis")).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox", { name: "Search notifications" }), { target: { value: "blocked" } });
    expect(screen.getAllByText("Review blocked run").length).toBeGreaterThan(0);

    const item = screen.getByRole("listitem", { name: "Review blocked run" });
    fireEvent.click(within(item).getByRole("button", { name: /Open chat/i }));
    expect(onOpenItem).toHaveBeenCalledWith(expect.objectContaining({ title: "Review blocked run" }));
    expect(screen.getByRole("status")).toHaveTextContent(/rehearsed in the renderer session/i);
  });

  it("opens a portable export preview and switches formats", () => {
    render(<NotificationCenterPreview items={notificationItemsFromBackgroundRows(rows)} />);

    fireEvent.click(screen.getByRole("button", { name: /Preview export/i }));
    expect(screen.getByLabelText("JSON notification export preview")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Notification center export format" }), { target: { value: "markdown" } });
    expect(screen.getByLabelText("Markdown notification export preview")).toHaveTextContent("# Omnia notification center preview");
  });

  it("pins a renderer-session export and lets the user inspect or clear history", () => {
    render(<NotificationCenterPreview items={notificationItemsFromBackgroundRows(rows)} />);

    fireEvent.click(screen.getByRole("button", { name: /Preview export/i }));
    fireEvent.click(screen.getByRole("button", { name: "Pin snapshot" }));

    expect(screen.getByRole("button", { name: "Hide history" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Notification export history" })).toBeInTheDocument();
    const selectedHistory = screen.getByRole("region", { name: "Selected historical notification export" });
    expect(selectedHistory).toBeInTheDocument();
    expect(within(selectedHistory).getByText(/Pinned snapshot/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Return to current export" }));
    expect(screen.queryByRole("region", { name: "Selected historical notification export" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Clear history" }));
    expect(screen.getByText(/No export snapshots retained yet/i)).toBeInTheDocument();
  });

  it("selects visible notifications and rehearses bulk status actions in the session", () => {
    render(<NotificationCenterPreview items={notificationItemsFromBackgroundRows(rows)} />);

    fireEvent.click(screen.getByRole("button", { name: "Select visible" }));
    expect(screen.getByText("2 selected in view")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Select Review blocked run" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Select Completed analysis" })).toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: "Mark selected read" }));
    expect(screen.getByRole("status")).toHaveTextContent(/Marked selected notifications read/i);
    expect(screen.getByText("Select notifications for bulk actions")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Select Review blocked run" })).not.toBeChecked();
  });

  it("saves, reapplies, updates, and deletes a renderer-local triage view", () => {
    render(<NotificationCenterPreview items={notificationItemsFromBackgroundRows(rows)} />);

    fireEvent.click(screen.getByRole("button", { name: /Urgent & high$/i }));
    fireEvent.change(screen.getByRole("textbox", { name: "New notification triage view name" }), { target: { value: "Urgent queue" } });
    fireEvent.click(screen.getByRole("button", { name: /Save as/i }));

    const savedViews = screen.getByRole("region", { name: "Saved notification triage views" });
    expect(within(savedViews).getByText(/Saved “Urgent queue” for this renderer session/i)).toBeInTheDocument();
    const savedView = screen.getByRole("combobox", { name: "Saved notification triage view" }) as HTMLSelectElement;
    const savedViewOption = screen.getByRole("option", { name: "Urgent queue" });
    expect(savedViewOption).toBeInTheDocument();
    const savedViewId = savedViewOption.getAttribute("value");
    expect(savedViewId).toContain("triage-view-");

    fireEvent.click(screen.getByRole("button", { name: "Reset triage" }));
    fireEvent.change(savedView, { target: { value: savedViewId } });
    expect(screen.getByRole("button", { name: /Urgent & high$/i })).toHaveAttribute("aria-pressed", "true");
    expect(within(savedViews).getByText(/Applied “Urgent queue”/i)).toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: "New notification triage view name" }), { target: { value: "Urgent review queue" } });
    fireEvent.click(screen.getByRole("button", { name: /^Update$/i }));
    expect(screen.getByRole("option", { name: "Urgent review queue" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Delete saved notification triage view" }));
    expect(screen.queryByRole("option", { name: "Urgent review queue" })).not.toBeInTheDocument();
    expect(within(savedViews).getByText(/Deleted “Urgent review queue”/i)).toBeInTheDocument();
  });

  it("undoes and redoes saved triage-view collection changes in the renderer session", () => {
    render(<NotificationCenterPreview items={notificationItemsFromBackgroundRows(rows)} />);
    const savedViews = screen.getByRole("region", { name: "Saved notification triage views" });

    fireEvent.change(within(savedViews).getByRole("textbox", { name: "New notification triage view name" }), { target: { value: "Urgent queue" } });
    fireEvent.click(within(savedViews).getByRole("button", { name: /Save as/i }));
    expect(within(savedViews).getByRole("option", { name: "Urgent queue" })).toBeInTheDocument();

    fireEvent.click(within(savedViews).getByRole("button", { name: "Delete saved notification triage view" }));
    expect(within(savedViews).queryByRole("option", { name: "Urgent queue" })).not.toBeInTheDocument();

    fireEvent.click(within(savedViews).getByRole("button", { name: "Undo saved notification triage view change" }));
    expect(within(savedViews).getByRole("option", { name: "Urgent queue" })).toBeInTheDocument();
    expect(within(savedViews).getByText(/Undid the last saved triage-view change/i)).toBeInTheDocument();

    fireEvent.click(within(savedViews).getByRole("button", { name: "Redo saved notification triage view change" }));
    expect(within(savedViews).queryByRole("option", { name: "Urgent queue" })).not.toBeInTheDocument();
    expect(within(savedViews).getByText(/Redid the saved triage-view change/i)).toBeInTheDocument();
  });

  it("supports channel preference undo, redo, and reset in the renderer session", () => {
    render(<NotificationCenterPreview items={notificationItemsFromBackgroundRows(rows)} />);

    const toastChannel = screen.getByRole("checkbox", { name: "Enable Toast preview" });
    expect(toastChannel).toBeChecked();
    fireEvent.click(toastChannel);
    expect(toastChannel).not.toBeChecked();
    expect(screen.getByText(/Toast preview muted for this renderer session/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Undo channel preference change" }));
    expect(toastChannel).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Redo channel preference change" }));
    expect(toastChannel).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Reset channels" }));
    expect(toastChannel).toBeChecked();
    expect(screen.getByText(/channel preferences reset for this renderer session/i)).toBeInTheDocument();
  });
});
