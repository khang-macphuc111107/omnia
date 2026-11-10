import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PerformanceSignalStrip } from "./performance-signal-strip";

describe("PerformanceSignalStrip", () => {
  it("shows an honest unknown baseline when no runner receipt is supplied", () => {
    render(<PerformanceSignalStrip />);

    expect(screen.getByRole("region", { name: "Performance signals" })).toBeInTheDocument();
    expect(screen.getByText(/No runner samples supplied/)).toBeInTheDocument();
    expect(screen.getByText(/10 signals/)).toBeInTheDocument();
    expect(screen.getByText("Renderer preview")).toBeInTheDocument();
    expect(screen.getByText(/Samples must come from an external runner/i)).toBeInTheDocument();
    expect(screen.getAllByText("Unknown").length).toBeGreaterThan(0);
  });

  it("filters measured and attention signals and exposes selected evidence", () => {
    const onOpenDiagnostics = vi.fn();
    render(
      <PerformanceSignalStrip
        sourceSnapshot="perf-receipt-2026-09-21"
        metrics={[
          { id: "localSendFeedbackMs", samples: [40, 42, 101], source: "runner" },
          { id: "longTaskCount", samples: [0, 1], source: "PerformanceObserver" },
        ]}
        onOpenDiagnostics={onOpenDiagnostics}
      />,
    );

    expect(screen.getByRole("tab", { name: /Measured 2/ })).toBeInTheDocument();
    expect(screen.getByText(/1 signal need review/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: /Measured/i }));
    const list = screen.getByRole("list", { name: "2 visible performance signals" });
    expect(within(list).getByText("Local send feedback")).toBeInTheDocument();
    expect(within(list).getByText("Long tasks")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /Attention/i }));
    expect(screen.getByRole("list", { name: "2 visible performance signals" })).toHaveTextContent("Local send feedback");
    expect(screen.getByText("Selected signal")).toBeInTheDocument();
    expect(screen.getByText("runner")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Open diagnostics/i }));
    expect(onOpenDiagnostics).toHaveBeenCalledTimes(1);
  });

  it("exports a renderer-local projection without requiring native writes", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<PerformanceSignalStrip metrics={[{ id: "warmInteractiveShellMs", samples: [1000, 1200] }]} />);

    fireEvent.change(screen.getByLabelText("Performance signal export format"), { target: { value: "markdown" } });
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));

    return waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(expect.stringContaining("# Omnia performance signals preview"));
      expect(screen.getByRole("status")).toHaveTextContent(/copied/i);
    });
  });
});
