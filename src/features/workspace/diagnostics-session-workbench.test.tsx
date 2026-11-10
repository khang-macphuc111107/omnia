import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { AppRuntimeInfo } from "@/lib/desktop";

import {
  redactDiagnosticText,
  serializeDiagnosticPreview,
  type DiagnosticPreviewEvent,
} from "./diagnostics-session-contract";
import {
  DiagnosticsSessionWorkbench,
  filterDiagnosticsHistory,
  type DiagnosticsHistoryEntry,
} from "./diagnostics-session-workbench";

const browserRuntime: AppRuntimeInfo = {
  appName: "Omnia",
  appVersion: "0.1.0",
  platform: "windows",
  tauri: false,
  debug: true,
};

describe("Diagnostics Session Log Workbench", () => {
  it("filters the renderer-only event timeline without claiming native evidence", () => {
    render(<DiagnosticsSessionWorkbench runtime={browserRuntime} />);

    expect(screen.getByRole("heading", { name: "Session Log Workbench" })).toBeInTheDocument();
    const exportPreview = screen.getByRole("region", { name: "Diagnostics export preview" });
    expect(exportPreview).toHaveTextContent(/review before download/i);
    expect(exportPreview).toHaveTextContent(/download only/i);
    expect(exportPreview).toHaveTextContent(/prompt and response bodies/i);
    expect(screen.getByRole("note", { name: "Diagnostics privacy boundary" })).toHaveTextContent(
      /native crash logs.*remain planned/i,
    );
    expect(screen.getAllByRole("listitem")).toHaveLength(4);

    fireEvent.change(screen.getByRole("combobox", { name: "Diagnostic level" }), {
      target: { value: "warning" },
    });
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByRole("button", { name: /Provider payload logging excluded/i })).toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: "Search diagnostic preview events" }), {
      target: { value: "not-present" },
    });
    expect(screen.getByRole("note", { name: "Empty diagnostics preview" })).toHaveTextContent(
      /no preview events match/i,
    );
  });

  it("supports renderer checkpoints, clear, and reset without deleting native logs", () => {
    render(<DiagnosticsSessionWorkbench runtime={browserRuntime} />);

    fireEvent.click(screen.getByRole("button", { name: "Add checkpoint" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(5);
    expect(screen.getByRole("status")).toHaveTextContent(/renderer-local checkpoint/i);

    fireEvent.click(screen.getByRole("button", { name: "Clear preview" }));
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
    expect(screen.getByRole("status")).toHaveTextContent(/no native logs were deleted/i);

    fireEvent.click(screen.getByRole("button", { name: "Reset preview" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(4);
  });

  it("saves, applies, and removes renderer-local diagnostics views", () => {
    render(<DiagnosticsSessionWorkbench runtime={browserRuntime} />);

    const savedView = screen.getByRole("combobox", { name: "Saved diagnostics view" });
    fireEvent.change(savedView, { target: { value: "provider-boundary" } });
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveTextContent(/Applied the renderer-local diagnostics view/i);

    fireEvent.change(screen.getByRole("textbox", { name: "Saved view name" }), {
      target: { value: "My provider view" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save view" }));
    expect(screen.getByRole("status")).toHaveTextContent(/Saved “My provider view”/i);
    expect(screen.getByRole("option", { name: "My provider view" })).toBeInTheDocument();

    fireEvent.change(savedView, { target: { value: "all-events" } });
    expect(screen.getAllByRole("listitem")).toHaveLength(4);
    const customOption = screen.getByRole("option", { name: "My provider view" }) as HTMLOptionElement;
    fireEvent.change(savedView, { target: { value: customOption.value } });
    expect(screen.getAllByRole("listitem")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Delete saved diagnostics view" }));
    expect(screen.queryByRole("option", { name: "My provider view" })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/Removed the renderer-local diagnostics view/i);
  });

  it("redacts sensitive-looking values before JSON and JSONL export", () => {
    const unsafe: DiagnosticPreviewEvent = {
      id: "event-1",
      occurredAt: "2026-09-16T00:00:00.000Z",
      level: "error",
      category: "provider",
      title: "Request for dev@example.com",
      detail: "Authorization: Bearer sk-super-secret-token C:\\Users\\khang\\secret.txt",
      source: "provider-test",
    };

    const redacted = redactDiagnosticText(`${unsafe.title} ${unsafe.detail}`);
    expect(redacted).not.toContain("dev@example.com");
    expect(redacted).not.toContain("sk-super-secret-token");
    expect(redacted).not.toContain("C:\\Users\\khang");

    const json = serializeDiagnosticPreview([unsafe], "json", "2026-09-16T00:00:01.000Z");
    const jsonl = serializeDiagnosticPreview([unsafe], "jsonl", "2026-09-16T00:00:01.000Z");
    for (const payload of [json, jsonl]) {
      expect(payload).toContain("omnia-renderer-diagnostics-preview");
      expect(payload).not.toContain("dev@example.com");
      expect(payload).not.toContain("sk-super-secret-token");
      expect(payload).not.toContain("C:\\Users\\khang");
    }
  });

  it("offers an explicit all-events export scope alongside the visible filtered scope", () => {
    render(<DiagnosticsSessionWorkbench runtime={browserRuntime} />);

    fireEvent.change(screen.getByRole("combobox", { name: "Diagnostic level" }), {
      target: { value: "warning" },
    });
    expect(screen.getByRole("button", { name: "Copy visible" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export visible JSON" })).toBeInTheDocument();

    fireEvent.change(screen.getByRole("combobox", { name: "Diagnostic export scope" }), {
      target: { value: "all" },
    });
    expect(screen.getByRole("button", { name: "Copy all" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export all JSON" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Diagnostic export scope" })).toHaveValue("all");
  });

  it("records renderer activity history and restores a selected filter context", () => {
    render(<DiagnosticsSessionWorkbench runtime={browserRuntime} />);

    fireEvent.change(screen.getByRole("textbox", { name: "Search diagnostic preview events" }), {
      target: { value: "provider" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add checkpoint" }));

    expect(screen.getByRole("region", { name: "Diagnostics activity history" })).toHaveTextContent(/1 \/ 24 retained/i);
    expect(screen.getByRole("button", { name: /Checkpoint.*Added a renderer-local checkpoint/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Checkpoint" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restore filters" })).toBeInTheDocument();

    fireEvent.change(screen.getByRole("combobox", { name: "Diagnostics history action" }), {
      target: { value: "checkpoint" },
    });
    expect(screen.getByRole("button", { name: /Checkpoint.*Added a renderer-local checkpoint/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Clear history" }));
    expect(screen.getByRole("region", { name: "Diagnostics activity history" })).toHaveTextContent(/0 \/ 24 retained/i);
    expect(screen.getByText(/No activity entries match this filter/i)).toBeInTheDocument();
  });

  it("filters redacted diagnostics history deterministically", () => {
    const entries: DiagnosticsHistoryEntry[] = [
      {
        id: "a",
        occurredAt: "2026-09-27T00:00:00.000Z",
        action: "export",
        summary: "Exported provider preview",
        eventCount: 2,
        query: "provider",
        level: "warning",
        category: "provider",
        format: "json",
        exportScope: "visible",
      },
      {
        id: "b",
        occurredAt: "2026-09-27T00:01:00.000Z",
        action: "checkpoint",
        summary: "Added runtime checkpoint",
        eventCount: 5,
        query: "",
        level: "all",
        category: "all",
        format: "jsonl",
        exportScope: "all",
      },
    ];

    expect(filterDiagnosticsHistory(entries, "provider", "all").map((entry) => entry.id)).toEqual(["a"]);
    expect(filterDiagnosticsHistory(entries, "", "checkpoint").map((entry) => entry.id)).toEqual(["b"]);
  });
});
