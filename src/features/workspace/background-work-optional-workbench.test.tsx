import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { BackgroundWorkRow } from "./background-work-inspector";
import { BackgroundWorkOptionalWorkbench } from "./background-work-optional-workbench";

const rows: readonly BackgroundWorkRow[] = [
  {
    id: "run-optional-preview",
    kind: "run",
    name: "Optional work preview",
    state: "working",
    summary: "A renderer-local row passed into the selected workbench.",
    createdAt: "2026-09-21T08:00:00.000Z",
    stageLabel: "Writing",
    eventCount: 2,
  },
];

const descriptors = [
  ["Task inspector", "Goals, tasks, agents, tools, and approvals"],
  ["Board", "Stage board & flow map"],
  ["Agent Mesh", "Agent Mesh & coordination"],
  ["Inbox", "Inbox triage cockpit"],
  ["Supervisor", "Agent Mesh supervisor"],
  ["Reconciliation", "Reconciliation Studio"],
  ["Worktree coordination", "Worktree coordination"],
  ["Harness", "Make the harness boundary inspectable"],
  ["Provider faults", "Inspect deterministic failure boundaries"],
] as const;

function optionalTab(label: string): HTMLElement {
  const tablist = screen.getByRole("tablist", { name: "Background Work optional surfaces" });
  return within(tablist).getByRole("tab", { name: new RegExp(`^${label}\\b`, "i") });
}

describe("BackgroundWorkOptionalWorkbench", () => {
  it("keeps the optional stage closed until requested and exposes one keyboard entry point", () => {
    render(<BackgroundWorkOptionalWorkbench rows={rows} />);

    const tablist = screen.getByRole("tablist", { name: "Background Work optional surfaces" });
    expect(within(tablist).getAllByRole("tab")).toHaveLength(descriptors.length);
    expect(screen.getByRole("region", { name: "Optional workbench closed" })).toHaveTextContent(
      "Reopen Reconciliation",
    );
    expect(screen.queryByRole("tabpanel")).not.toBeInTheDocument();

    expect(optionalTab("Reconciliation")).toHaveAttribute("aria-selected", "false");
    expect(optionalTab("Reconciliation")).toHaveAttribute("tabindex", "0");
    expect(optionalTab("Board")).toHaveAttribute("tabindex", "-1");
  });

  it("reopens the default workbench, keeps the panel linked, and passes visible rows through", async () => {
    render(<BackgroundWorkOptionalWorkbench rows={rows} />);

    fireEvent.click(screen.getByRole("button", { name: "Reopen Reconciliation" }));

    const panel = await screen.findByRole("tabpanel");
    expect(panel).toHaveAttribute("aria-label", "Reconciliation workbench preview");
    expect(panel).toHaveAttribute("aria-labelledby", "background-work-optional-tab-reconciliation");
    expect(panel).toHaveTextContent("Renderer-local · no durable write");
    expect(await screen.findByRole("heading", { name: "Reconciliation Studio" })).toBeInTheDocument();

    fireEvent.click(optionalTab("Board"));
    expect(await screen.findByRole("heading", { name: "Stage board & flow map" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Background work stage board preview" })).toHaveTextContent(
      "Optional work preview",
    );
  });

  it("covers every lazy descriptor and preserves the renderer-only boundary", async () => {
    render(<BackgroundWorkOptionalWorkbench rows={rows} />);

    for (const [label, heading] of descriptors) {
      fireEvent.click(optionalTab(label));
      expect(await screen.findByRole("heading", { name: heading }, { timeout: 15_000 })).toBeInTheDocument();
      expect(screen.getByText("Renderer-local · no durable write")).toBeInTheDocument();
      expect(optionalTab(label)).toHaveAttribute("aria-selected", "true");
      expect(optionalTab(label)).toHaveAttribute("tabindex", "0");
    }
  }, 30_000);

  it("supports wrapped roving keyboard navigation while opening the target workbench", async () => {
    render(<BackgroundWorkOptionalWorkbench rows={rows} />);

    const reconciliation = optionalTab("Reconciliation");
    reconciliation.focus();
    fireEvent.keyDown(reconciliation, { key: "ArrowRight" });

    const worktree = optionalTab("Worktree coordination");
    expect(worktree).toHaveFocus();
    expect(worktree).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByRole("heading", { name: "Worktree coordination" })).toBeInTheDocument();

    fireEvent.keyDown(worktree, { key: "End" });
    const provider = optionalTab("Provider faults");
    expect(provider).toHaveFocus();
    expect(await screen.findByRole("heading", { name: "Inspect deterministic failure boundaries" })).toBeInTheDocument();

    fireEvent.keyDown(provider, { key: "Home" });
    const taskInspector = optionalTab("Task inspector");
    expect(taskInspector).toHaveFocus();
    await waitFor(() => expect(screen.getByRole("heading", { name: "Goals, tasks, agents, tools, and approvals" })).toBeInTheDocument());
  });
});
