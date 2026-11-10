import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import TelemetryInspectorPreview, {
  TELEMETRY_INSPECTOR_RECORDS,
  serializeTelemetryInspector,
} from "./telemetry-inspector-preview";

describe("TelemetryInspectorPreview", () => {
  it("renders a bounded event stream with an explicit renderer boundary", () => {
    render(<TelemetryInspectorPreview />);

    expect(screen.getByRole("heading", { name: "Telemetry inspector" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Telemetry inspector events" }).querySelectorAll("[role=\"listitem\"]")).toHaveLength(TELEMETRY_INSPECTOR_RECORDS.length);
    expect(screen.getByRole("complementary", { name: "Selected telemetry record" })).toHaveTextContent(/Run lifecycle envelope/i);
    expect(screen.getByRole("note", { name: "Telemetry inspector boundary" })).toHaveTextContent(/Observed means renderer-visible only/i);
  });

  it("filters by kind and status while keeping unknown evidence visible", () => {
    render(<TelemetryInspectorPreview />);

    fireEvent.change(screen.getByRole("combobox", { name: "Telemetry inspector kind" }), { target: { value: "health" } });
    const list = screen.getByRole("list", { name: "Telemetry inspector events" });
    expect(within(list).getByText(/Provider health snapshot/i)).toBeInTheDocument();
    expect(within(list).queryByText(/Usage ledger observation/i)).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Telemetry inspector status" }), { target: { value: "unknown" } });
    expect(within(list).getByText(/Provider health snapshot/i)).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Selected telemetry record" })).toHaveTextContent(/No observation collected/i);
  });

  it("supports search, pinning, and Markdown export", () => {
    render(<TelemetryInspectorPreview />);

    fireEvent.change(screen.getByRole("textbox", { name: "Search telemetry records" }), { target: { value: "checkpoint" } });
    expect(screen.getByRole("list", { name: "Telemetry inspector events" })).toHaveTextContent(/Durable checkpoint receipt/i);
    fireEvent.click(screen.getByRole("button", { name: "Pin record" }));
    expect(screen.getByRole("button", { name: "Unpin record" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Telemetry inspector export format" }), { target: { value: "markdown" } });
    expect(screen.getByRole("code")).toHaveTextContent(/# Omnia telemetry inspector preview/);
    expect(screen.getByRole("code")).toHaveTextContent(/Pinned: 1/);
    expect(screen.getByRole("code")).toHaveTextContent(/native telemetry receipt/i);
  });

  it("saves, restores, and removes a custom triage view in the renderer session", () => {
    render(<TelemetryInspectorPreview />);

    fireEvent.change(screen.getByRole("combobox", { name: "Telemetry inspector kind" }), { target: { value: "health" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Telemetry inspector status" }), { target: { value: "unknown" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Saved telemetry view name" }), { target: { value: "Health gaps" } });
    fireEvent.click(screen.getByRole("button", { name: "Save current filters" }));

    expect(screen.getByRole("status")).toHaveTextContent(/Saved “Health gaps”/);
    const savedViewOption = screen.getByRole("option", { name: /Health gaps · session/i }) as HTMLOptionElement;
    const savedViewId = savedViewOption.value;

    fireEvent.change(screen.getByRole("combobox", { name: "Telemetry inspector kind" }), { target: { value: "all" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Telemetry inspector status" }), { target: { value: "all" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Load saved telemetry view" }), { target: { value: savedViewId } });
    expect(screen.getByRole("combobox", { name: "Telemetry inspector kind" })).toHaveValue("health");
    expect(screen.getByRole("combobox", { name: "Telemetry inspector status" })).toHaveValue("unknown");

    fireEvent.click(screen.getByRole("button", { name: "Delete custom view" }));
    expect(screen.getByRole("status")).toHaveTextContent(/Removed “Health gaps”/);
    expect(screen.queryByRole("option", { name: /Health gaps · session/i })).not.toBeInTheDocument();
  });

  it("exports selected filters and preserves the unknown boundary", () => {
    const json = serializeTelemetryInspector(TELEMETRY_INSPECTOR_RECORDS.slice(0, 1), {
      scope: "run",
      kind: "timing",
      status: "unknown",
      query: "first byte",
      selectedId: "telemetry-timing-marks",
      pinnedIds: ["telemetry-timing-marks"],
      format: "json",
    });

    expect(json).toContain("omnia.telemetry-inspector.preview.v1");
    expect(json).toContain('"selectedId": "telemetry-timing-marks"');
    expect(json).toContain('"status": "unknown"');
    expect(json).toContain("Unknown is not zero");
  });

  it("reports clipboard status without creating a native write", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<TelemetryInspectorPreview />);

    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("status")).toHaveTextContent(/Copied JSON telemetry inspector preview/i);
    });
    expect(screen.getByRole("note", { name: "Telemetry inspector boundary" })).toHaveTextContent(/does not query providers/i);
  });
});
