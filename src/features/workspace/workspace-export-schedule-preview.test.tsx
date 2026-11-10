import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  computeNextWorkspaceExportOccurrence,
  INITIAL_WORKSPACE_EXPORT_SCHEDULE,
  WorkspaceExportSchedulePreview,
  type WorkspaceExportScheduleConfig,
} from "./workspace-export-schedule-preview";

const baseConfig = (patch: Partial<WorkspaceExportScheduleConfig> = {}): WorkspaceExportScheduleConfig => ({
  ...INITIAL_WORKSPACE_EXPORT_SCHEDULE,
  enabled: true,
  startDate: "2026-09-24",
  localTime: "09:00",
  ...patch,
});

describe("workspace export schedule preview", () => {
  it("computes the next daily occurrence from the local schedule draft", () => {
    const result = computeNextWorkspaceExportOccurrence({
      config: baseConfig({ cadence: "daily", interval: 2 }),
      now: new Date(2026, 8, 25, 10, 0),
    });

    expect(result).not.toBeNull();
    expect(result?.getFullYear()).toBe(2026);
    expect(result?.getMonth()).toBe(8);
    expect(result?.getDate()).toBe(26);
    expect(result?.getHours()).toBe(9);
  });

  it("supports weekly and monthly cadence without creating a scheduler", () => {
    const weekly = computeNextWorkspaceExportOccurrence({
      config: baseConfig({ cadence: "weekly", weekday: 1 }),
      now: new Date(2026, 8, 25, 10, 0),
    });
    const monthly = computeNextWorkspaceExportOccurrence({
      config: baseConfig({ cadence: "monthly", monthDay: 1 }),
      now: new Date(2026, 8, 25, 10, 0),
    });

    expect(weekly?.getDate()).toBe(28);
    expect(monthly?.getMonth()).toBe(9);
    expect(monthly?.getDate()).toBe(1);
    expect(computeNextWorkspaceExportOccurrence({ config: baseConfig({ enabled: false }), now: new Date(2026, 8, 25) })).toBeNull();
  });

  it("renders editable schedule controls and keeps the boundary explicit", () => {
    render(<WorkspaceExportSchedulePreview profiles={[{ id: "safe-handoff", name: "Safe handoff" }]} />);

    expect(screen.getByRole("heading", { name: "Schedule an export" })).toBeInTheDocument();
    expect(screen.getByText(/no timer, background task, automatic export, file write/i)).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/enable schedule draft/i));
    expect(screen.getByText(/Next occurrence preview/i)).toBeInTheDocument();
    expect(screen.getByLabelText("Export schedule cadence")).toHaveValue("weekly");

    fireEvent.change(screen.getByLabelText("Export schedule cadence"), { target: { value: "monthly" } });
    expect(screen.getByLabelText("Export schedule month day")).toBeInTheDocument();
    expect(screen.queryByLabelText("Export schedule weekday")).not.toBeInTheDocument();
  });

  it("supports bounded renderer-local undo, redo, reset, and JSON draft import", () => {
    render(<WorkspaceExportSchedulePreview profiles={[{ id: "safe-handoff", name: "Safe handoff" }]} />);
    const cadence = screen.getByLabelText("Export schedule cadence");

    fireEvent.change(cadence, { target: { value: "daily" } });
    expect(cadence).toHaveValue("daily");
    fireEvent.click(screen.getByRole("button", { name: "Undo schedule change" }));
    expect(cadence).toHaveValue("weekly");
    fireEvent.click(screen.getByRole("button", { name: "Redo schedule change" }));
    expect(cadence).toHaveValue("daily");
    fireEvent.click(screen.getByRole("button", { name: /reset defaults/i }));
    expect(cadence).toHaveValue("weekly");

    const exported = JSON.parse(screen.getByLabelText("Schedule JSON export preview").textContent ?? "{}") as { schema: string; config: WorkspaceExportScheduleConfig };
    expect(exported.schema).toBe("omnia.workspace-export-schedule.preview.v1");
    expect(exported.config.cadence).toBe("weekly");

    fireEvent.click(screen.getByRole("button", { name: "Import JSON" }));
    fireEvent.change(screen.getByLabelText("Schedule JSON import"), { target: { value: JSON.stringify({ schema: exported.schema, config: { ...exported.config, cadence: "monthly", monthDay: 15 } }) } });
    fireEvent.click(screen.getByRole("button", { name: "Review and apply to draft" }));
    expect(screen.getByLabelText("Export schedule cadence")).toHaveValue("monthly");
    expect(screen.getByLabelText("Export schedule month day")).toHaveValue("15");
    expect(screen.getByRole("status")).toHaveTextContent(/renderer session/i);
  });

  it("fails closed for malformed schedule imports", () => {
    render(<WorkspaceExportSchedulePreview profiles={[{ id: "safe-handoff", name: "Safe handoff" }]} />);
    fireEvent.click(screen.getByRole("button", { name: "Import JSON" }));
    fireEvent.change(screen.getByLabelText("Schedule JSON import"), { target: { value: JSON.stringify({ schema: "unknown", config: {} }) } });
    fireEvent.click(screen.getByRole("button", { name: "Review and apply to draft" }));
    expect(screen.getByLabelText("Export schedule cadence")).toHaveValue("weekly");
    expect(screen.getByRole("status")).toHaveTextContent(/Import rejected/);
    fireEvent.change(screen.getByLabelText("Schedule JSON import"), { target: { value: JSON.stringify({
      schema: "omnia.workspace-export-schedule.preview.v1",
      config: { ...baseConfig(), unexpected: "not a schedule field" },
    }) } });
    fireEvent.click(screen.getByRole("button", { name: "Review and apply to draft" }));
    expect(screen.getByLabelText("Export schedule cadence")).toHaveValue("weekly");
    expect(screen.getByRole("status")).toHaveTextContent(/Import rejected/);
  });
});
