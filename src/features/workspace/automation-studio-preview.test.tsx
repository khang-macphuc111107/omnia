import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AutomationStudioPreview } from "./automation-studio-preview";

describe("Automation Studio preview", () => {
  it("shows trigger-aware workflows and an explicit renderer boundary", () => {
    render(<AutomationStudioPreview />);

    expect(screen.getByRole("heading", { name: "Automation Studio" })).toBeInTheDocument();
    expect(screen.getByText(/Renderer-local · no durable write/i)).toBeInTheDocument();
    expect(screen.getByText("Morning research digest", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getAllByText("Weekdays · 08:30").length).toBeGreaterThan(0);

    fireEvent.change(screen.getByRole("combobox", { name: "Automation trigger filter" }), { target: { value: "event" } });
    expect(screen.getByText("Repository drift watch", { selector: "strong" })).toBeInTheDocument();
    expect(screen.queryByText("Morning research digest", { selector: "strong" })).not.toBeInTheDocument();
  });

  it("adds a renderer-local draft automation through the builder", () => {
    render(<AutomationStudioPreview />);

    fireEvent.click(screen.getByRole("button", { name: "New automation" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Automation name" }), { target: { value: "Weekly project pulse" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Automation trigger" }), { target: { value: "manual" } });
    fireEvent.click(screen.getByRole("button", { name: /Add draft/i }));

    expect(screen.getByText("Weekly project pulse", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByText(/Added Weekly project pulse as a draft automation/i)).toBeInTheDocument();
    expect(screen.getAllByText("Draft", { selector: "span" }).length).toBeGreaterThan(0);
  });

  it("lets a draft compose action, scope, review, recovery, and trigger detail options", () => {
    render(<AutomationStudioPreview />);

    fireEvent.click(screen.getByRole("button", { name: "New automation" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Automation name" }), { target: { value: "Project pulse" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Automation trigger" }), { target: { value: "event" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Automation trigger detail" }), { target: { value: "Project status changed" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Automation action" }), { target: { value: "export" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Automation scope" }), { target: { value: "workspace" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Automation connector" }), { target: { value: "github" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Automation approval" }), { target: { value: "always-ask" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Automation retry" }), { target: { value: "three" } });
    fireEvent.click(screen.getByRole("button", { name: /Add draft/i }));

    expect(screen.getByRole("heading", { name: "Project pulse" })).toBeInTheDocument();
    expect(screen.getAllByText("Prepare manifest", { selector: "strong" }).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Personal workspace", { selector: "strong" }).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Always ask", { selector: "strong" }).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Retry up to 3x", { selector: "strong" }).length).toBeGreaterThan(0);
    expect(screen.getAllByText("GitHub / GitLab", { selector: "strong" }).length).toBeGreaterThan(0);
    expect(screen.getByText("Project status changed")).toBeInTheDocument();
  });

  it("queues a run rehearsal without calling an endpoint", () => {
    render(<AutomationStudioPreview />);

    const runButton = screen.getAllByRole("button", { name: /Run preview/i })[0];
    expect(runButton).toBeDefined();
    fireEvent.click(runButton as HTMLElement);

    const runsTab = screen.getByRole("tab", { name: /Run history/i });
    expect(runsTab).toHaveAttribute("aria-selected", "true");
    const panel = screen.getByRole("tabpanel", { name: /Run history/i });
    expect(within(panel).getAllByText(/no endpoint called/i).length).toBeGreaterThan(0);
    expect(within(panel).getAllByText(/renderer preview/i).length).toBeGreaterThan(0);
  });

  it("keeps the schedule and run panels keyboard-addressable", async () => {
    render(<AutomationStudioPreview />);

    const automationTab = screen.getByRole("tab", { name: /Automations 4/i });
    automationTab.focus();
    fireEvent.keyDown(automationTab, { key: "ArrowRight" });
    const scheduleTab = screen.getByRole("tab", { name: "Schedule" });
    await waitFor(() => expect(scheduleTab).toHaveFocus());
    expect(scheduleTab).toHaveAttribute("aria-controls", "automation-studio-panel-calendar");

    fireEvent.click(scheduleTab);
    expect(screen.getByRole("tabpanel", { name: "Schedule" })).toHaveTextContent(/Trigger calendar/i);
    fireEvent.keyDown(scheduleTab, { key: "End" });
    await waitFor(() => expect(screen.getByRole("tab", { name: /Run history/i })).toHaveFocus());
  });

  it("exposes connector-style triggers and execution policy controls in the draft builder", () => {
    render(<AutomationStudioPreview />);

    fireEvent.click(screen.getByRole("button", { name: "New automation" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Automation name" }), { target: { value: "CI artifact handoff" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Automation trigger" }), { target: { value: "artifact-completion" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Automation trigger detail" }), { target: { value: "Artifact build completed" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Automation missed run" }), { target: { value: "catch-up" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Automation concurrency" }), { target: { value: "parallel-2" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Automation notification" }), { target: { value: "in-app-chat" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Automation connector" }), { target: { value: "webhook" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Automation connector permission" }), { target: { value: "write-review" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Automation connector identity" }), { target: { value: "Omnia delivery bot" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Automation audit retention" }), { target: { value: "30-days" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Automation timezone" }), { target: { value: "UTC" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Automation dependency" }), { target: { value: "After CI green" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Automation budget" }), { target: { value: "$0.50 / run" } });
    fireEvent.click(screen.getByRole("button", { name: /Add draft/i }));

    expect(screen.getByRole("heading", { name: "CI artifact handoff" })).toBeInTheDocument();
    expect(screen.getByText("Artifact completed", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByText("Catch up once", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByText("Parallel · up to 2", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByText("In-app + chat draft", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByText("Webhook", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByText("Write with review", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByText("Omnia delivery bot", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByText("30-day preview", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByText("After CI green", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByText("$0.50 / run", { selector: "strong" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Rehearse selected run" }));
    expect(screen.getByRole("tab", { name: /Run history/i })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("Automation export JSON preview")).toHaveTextContent(/connectorPermission/);
    expect(screen.getByLabelText("Automation export JSON preview")).toHaveTextContent(/Omnia delivery bot/);
  });

  it("filters the expanded trigger catalog without leaving the renderer boundary", () => {
    render(<AutomationStudioPreview />);

    fireEvent.change(screen.getByRole("combobox", { name: "Automation trigger filter" }), { target: { value: "schedule" } });
    expect(screen.getByText("Morning research digest", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByText(/no durable write.*no provider request/i)).toBeInTheDocument();
    expect(screen.queryByText("Repository drift watch", { selector: "strong" })).not.toBeInTheDocument();
  });

  it("searches workflow metadata and filters by status", () => {
    render(<AutomationStudioPreview />);

    fireEvent.change(screen.getByRole("searchbox", { name: "Search automations" }), { target: { value: "repository" } });
    expect(screen.getByText("Repository drift watch", { selector: "strong" })).toBeInTheDocument();
    expect(screen.queryByText("Morning research digest", { selector: "strong" })).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox", { name: "Search automations" }), { target: { value: "" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Automation status filter" }), { target: { value: "paused" } });
    expect(screen.getByText("Weekly workspace export", { selector: "strong" })).toBeInTheDocument();
    expect(screen.queryByText("Morning research digest", { selector: "strong" })).not.toBeInTheDocument();
  });

  it("stages an edited JSON preview without creating a native workflow", () => {
    render(<AutomationStudioPreview />);

    fireEvent.click(screen.getByRole("button", { name: "Import preview" }));
    fireEvent.click(screen.getByRole("button", { name: "Use current export" }));
    const importBox = screen.getByRole("textbox", { name: "Automation JSON import" });
    expect((importBox as HTMLTextAreaElement).value).toContain("omnia.automation-studio.preview.v1");
    fireEvent.change(importBox, { target: { value: (importBox as HTMLTextAreaElement).value.replace("Morning research digest", "Morning digest (edited)") } });
    fireEvent.click(screen.getByRole("button", { name: "Stage import" }));

    expect(screen.getByText("Morning digest (edited)", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Automation studio status" })).toHaveTextContent(/Imported automation preview staged locally/i);
    expect(screen.getByText(/no durable write.*no provider request/i)).toBeInTheDocument();
  });

  it("rejects malformed automation imports with an honest local error", () => {
    render(<AutomationStudioPreview />);

    fireEvent.click(screen.getByRole("button", { name: "Import preview" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Automation JSON import" }), { target: { value: "{\"not\":\"omnia\"}" } });
    fireEvent.click(screen.getByRole("button", { name: "Stage import" }));
    const importRegion = screen.getByRole("region", { name: "Import automation preview" });
    expect(within(importRegion).getByRole("status")).toHaveTextContent(/Expected an Omnia automation preview export/i);
    expect(screen.getByText("Morning research digest", { selector: "strong" })).toBeInTheDocument();
  });

  it("rejects oversized imports and malformed run rows instead of dropping them", () => {
    render(<AutomationStudioPreview />);
    fireEvent.click(screen.getByRole("button", { name: "Import preview" }));
    const importBox = screen.getByRole("textbox", { name: "Automation JSON import" });

    fireEvent.change(importBox, { target: { value: "x".repeat(512 * 1024 + 1) } });
    fireEvent.click(screen.getByRole("button", { name: "Stage import" }));
    const importRegion = screen.getByRole("region", { name: "Import automation preview" });
    expect(within(importRegion).getByRole("status")).toHaveTextContent(/limited to 512 KB/i);

    fireEvent.change(importBox, { target: { value: JSON.stringify({
      schema: "omnia.automation-studio.preview.v1",
      automations: [],
      runs: [{ id: "broken" }],
    }) } });
    fireEvent.click(screen.getByRole("button", { name: "Stage import" }));
    expect(within(importRegion).getByRole("status")).toHaveTextContent(/Every run record needs/i);
  });

  it("counts cron and calendar triggers as scheduled work in the preview", () => {
    render(<AutomationStudioPreview />);
    fireEvent.click(screen.getByRole("button", { name: "New automation" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Automation name" }), { target: { value: "Calendar digest" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Automation trigger" }), { target: { value: "calendar" } });
    fireEvent.click(screen.getByRole("button", { name: /Add draft/i }));

    const scheduledCard = screen.getByText("Scheduled").closest("article");
    expect(scheduledCard).toHaveTextContent("3");
  });

  it("duplicates a workflow and archives/restores it locally", () => {
    render(<AutomationStudioPreview />);
    const original = screen.getByText("Morning research digest", { selector: "strong" });
    const card = original.closest("article");
    expect(card).not.toBeNull();
    fireEvent.click(within(card as HTMLElement).getByRole("button", { name: "Duplicate Morning research digest" }));
    expect(screen.getByText("Morning research digest · copy", { selector: "strong" })).toBeInTheDocument();

    fireEvent.click(within(card as HTMLElement).getByRole("button", { name: "Archive Morning research digest" }));
    expect(within(card as HTMLElement).getByText("Archived")).toBeInTheDocument();
    expect(within(card as HTMLElement).getByRole("button", { name: "Restore Morning research digest" })).toBeInTheDocument();
    fireEvent.click(within(card as HTMLElement).getByRole("button", { name: "Restore Morning research digest" }));
    expect(within(card as HTMLElement).getByText("Draft")).toBeInTheDocument();
  });

  it("keeps archived workflows visible through the status filter but does not rehearse them", () => {
    render(<AutomationStudioPreview />);
    const card = screen.getByText("Weekly workspace export", { selector: "strong" }).closest("article");
    expect(card).not.toBeNull();
    fireEvent.click(within(card as HTMLElement).getByRole("button", { name: "Archive Weekly workspace export" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Automation status filter" }), { target: { value: "archived" } });
    expect(screen.getByText("Weekly workspace export", { selector: "strong" })).toBeInTheDocument();
    expect(within(screen.getByText("Weekly workspace export", { selector: "strong" }).closest("article") as HTMLElement).getByRole("button", { name: "Run preview" })).toBeDisabled();
  });
});
