import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  HARNESS_CAPABILITY_SYNTHESIS,
  HarnessCapabilitySynthesisPanel,
  filterHarnessCapabilitySynthesis,
  serializeHarnessCapabilitySynthesis,
} from "./harness-capability-synthesis";
import { HARNESS_EVIDENCE_REFRESH, HARNESS_SOURCE_EVIDENCE } from "./harness-evidence-register";

describe("harness capability synthesis", () => {
  it("keeps the cross-harness source signals explicit and bounded", () => {
    expect(HARNESS_CAPABILITY_SYNTHESIS.length).toBeGreaterThanOrEqual(7);
    expect(HARNESS_CAPABILITY_SYNTHESIS.every((item) => item.signals.length === 3)).toBe(true);
    expect(HARNESS_CAPABILITY_SYNTHESIS.every((item) => {
      const boundary = item.boundary.toLowerCase();
      return boundary.includes("renderer") || boundary.includes("preview");
    })).toBe(true);
    expect(filterHarnessCapabilitySynthesis({ source: "OpenAI Codex" })).toHaveLength(HARNESS_CAPABILITY_SYNTHESIS.length);
    expect(filterHarnessCapabilitySynthesis({ recommendation: "Defer" })).toHaveLength(1);
  });

  it("filters decisions and renders source evidence in the detail pane", () => {
    render(<HarnessCapabilitySynthesisPanel />);

    expect(screen.getByRole("heading", { name: "Signals into Omnia decisions" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Cross-harness capability signals" })).toHaveTextContent("Durable event log and typed projections");

    fireEvent.change(screen.getByRole("combobox", { name: "Synthesis recommendation" }), { target: { value: "Defer" } });
    const list = screen.getByRole("list", { name: "Cross-harness capability signals" });
    expect(within(list).getByRole("button", { name: /Background and remote session lifecycle\. Defer/i })).toBeInTheDocument();
    expect(within(list).queryByRole("button", { name: /Durable event log and typed projections/i })).not.toBeInTheDocument();

    fireEvent.click(within(list).getByRole("button", { name: /Background and remote session lifecycle\. Defer/i }));
    const detail = screen.getByRole("complementary", { name: "Selected cross-harness synthesis" });
    expect(detail).toHaveTextContent("DeepSeek Harness");
    expect(detail).toHaveTextContent("Remote Control");
    expect(detail).toHaveTextContent("Define a native job lifecycle");
    expect(detail).toHaveTextContent("deepseek-ai/deepseek-harness");
    expect(detail).toHaveTextContent("477b4f420553");
  });

  it("exports filtered synthesis without implying native authority", () => {
    render(<HarnessCapabilitySynthesisPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Preview synthesis" }));
    const exportRegion = screen.getByRole("region", { name: "Cross-harness synthesis export preview" });
    expect(exportRegion).toHaveTextContent('"schema": "omnia.harness-capability-synthesis.preview.v1"');
    expect(exportRegion).toHaveTextContent("No native authority, provider dispatch, tool grant, agent spawn, or durable write");

    fireEvent.change(within(exportRegion).getByRole("combobox", { name: "Synthesis export format" }), { target: { value: "markdown" } });
    expect(exportRegion).toHaveTextContent("# Omnia cross-harness capability synthesis");
    expect(exportRegion).toHaveTextContent("Renderer-local research projection");
  });

  it("serializes an empty selection as a valid portable preview", () => {
    const payload = serializeHarnessCapabilitySynthesis([], "json");
    const firstEvidence = HARNESS_SOURCE_EVIDENCE.find(() => true);
    expect(payload).toContain('"items": []');
    expect(payload).toContain("renderer-session");
    expect(payload).toContain(HARNESS_EVIDENCE_REFRESH.refreshedAt);
    expect(firstEvidence?.revision).toBeTruthy();
    expect(payload).toContain(firstEvidence?.revision ?? "");
  });

  it("keeps every source signal tied to a bounded local evidence snapshot", () => {
    expect(HARNESS_SOURCE_EVIDENCE).toHaveLength(3);
    expect(HARNESS_SOURCE_EVIDENCE.every((evidence) => evidence.revision.match(/^[0-9a-f]{40}$/))).toBe(true);
    expect(HARNESS_SOURCE_EVIDENCE.every((evidence) => evidence.snapshotPath.startsWith("research/upstreams/"))).toBe(true);
    expect(HARNESS_SOURCE_EVIDENCE.find((evidence) => evidence.source === "Claude Code")?.strength).toContain("official public artifacts");
  });
});
