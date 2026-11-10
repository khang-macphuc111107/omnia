import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import DataLineageStudio, {
  DATA_LINEAGE_EXPORT_PRESETS,
  buildDataLineageEvidenceLedger,
  seedDataLineageEdges,
  seedDataLineageNodes,
  selectDataLineageEvidence,
  selectDataLineageExportScope,
  selectVisibleDataLineage,
  serializeDataLineage,
} from "./data-lineage-studio";

describe("DataLineageStudio", () => {
  it("renders a truthful source-to-evaluation lineage surface", () => {
    render(<DataLineageStudio />);

    expect(screen.getByRole("region", { name: "Data lineage studio" })).toBeInTheDocument();
    expect(screen.getByText(/no hidden collection or training is running here/i)).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Sources lane" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Transformations lane" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Artifacts lane" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Evaluations lane" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Data lineage summary" })).toHaveTextContent(/Graph coverage/i);
  });

  it("filters nodes and exposes selected-record edge details", () => {
    render(<DataLineageStudio />);

    fireEvent.change(screen.getByRole("combobox", { name: "Lineage node kind" }), { target: { value: "transform" } });
    const transformLane = screen.getByRole("region", { name: "Transformations lane" });
    expect(within(transformLane).getByRole("button", { name: /Redaction policy/i })).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Sources lane" })).getByText(/No matching sources/i)).toBeInTheDocument();

    fireEvent.change(screen.getByRole("combobox", { name: "Lineage node kind" }), { target: { value: "all" } });
    fireEvent.click(screen.getByRole("button", { name: /Quality review batch/i }));
    const detail = screen.getByRole("complementary", { name: "Selected data lineage record" });
    expect(within(detail).getByText(/renderer-local candidate set/i)).toBeInTheDocument();
    expect(within(detail).getByText(/Connected edges/i)).toBeInTheDocument();
  });

  it("supports sensitivity and edge-evidence filters without changing the preview boundary", () => {
    render(<DataLineageStudio />);

    fireEvent.change(screen.getByRole("combobox", { name: "Lineage sensitivity" }), { target: { value: "high" } });
    expect(within(screen.getByRole("region", { name: "Sources lane" })).getByRole("button", { name: /UI-first workflow preference/i })).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Artifacts lane" })).getByText(/No matching artifacts/i)).toBeInTheDocument();

    fireEvent.change(screen.getByRole("combobox", { name: "Lineage sensitivity" }), { target: { value: "all" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Lineage edge evidence" }), { target: { value: "missing" } });
    fireEvent.click(screen.getByRole("button", { name: /Quality review batch/i }));
    expect(screen.getByRole("complementary", { name: "Selected data lineage record" })).toHaveTextContent(/preview edge does not prove native persistence/i);
  });

  it("opens a portable export preview without claiming a durable write", () => {
    render(<DataLineageStudio />);

    fireEvent.click(screen.getByRole("button", { name: /export lineage/i }));
    const exportRegion = screen.getByRole("region", { name: "Data lineage export preview" });
    expect(within(exportRegion).getByRole("code")).toHaveTextContent(/omnia\.data-lineage-studio\.preview\.v1/i);
    expect(exportRegion).toHaveTextContent(/No durable write/i);

    fireEvent.change(within(exportRegion).getByRole("combobox", { name: "Data lineage export format" }), { target: { value: "markdown" } });
    expect(within(exportRegion).getByRole("code")).toHaveTextContent(/# Omnia data lineage studio preview/i);
  });

  it("opens an evidence ledger with fail-closed review controls", () => {
    render(<DataLineageStudio />);

    fireEvent.click(screen.getByRole("button", { name: /Evidence ledger/i }));
    const ledger = screen.getByRole("region", { name: "Data lineage evidence ledger" });
    expect(ledger).toHaveTextContent(/Relationship evidence ledger/i);
    expect(ledger).toHaveTextContent(/Missing evidence/i);

    fireEvent.change(within(ledger).getByRole("combobox", { name: "Evidence strength" }), { target: { value: "missing" } });
    expect(within(ledger).getByText(/No supporting receipt is present/i)).toBeInTheDocument();

    fireEvent.click(within(ledger).getByRole("button", { name: /Mark reviewed/i }));
    expect(within(ledger).getByRole("button", { name: /^Reopen$/i })).toBeInTheDocument();
  });

  it("batch reviews only filtered evidence rows and can reopen that visible batch", () => {
    render(<DataLineageStudio />);

    fireEvent.click(screen.getByRole("button", { name: /Evidence ledger/i }));
    const ledger = screen.getByRole("region", { name: "Data lineage evidence ledger" });
    fireEvent.change(within(ledger).getByRole("combobox", { name: "Evidence strength" }), { target: { value: "missing" } });
    expect(within(ledger).getByRole("button", { name: "Mark 1 visible reviewed" })).toBeEnabled();

    fireEvent.click(within(ledger).getByRole("button", { name: "Mark 1 visible reviewed" }));
    expect(within(ledger).getByRole("button", { name: "Reopen 1 visible" })).toBeEnabled();
    expect(within(ledger).getByText(/1 reviewed/i)).toBeInTheDocument();

    fireEvent.click(within(ledger).getByRole("button", { name: "Reopen 1 visible" }));
    expect(within(ledger).getByRole("button", { name: "Mark 1 visible reviewed" })).toBeEnabled();
    expect(within(ledger).getByText(/0 reviewed/i)).toBeInTheDocument();
  });

  it("offers bounded export presets and keeps a session-only export history", async () => {
    render(<DataLineageStudio />);

    fireEvent.click(screen.getByRole("button", { name: /export lineage/i }));
    const exportRegion = screen.getByRole("region", { name: "Data lineage export preview" });
    expect(within(exportRegion).getByRole("combobox", { name: "Data lineage export preset" })).toHaveValue("all-visible");

    fireEvent.change(within(exportRegion).getByRole("combobox", { name: "Data lineage export preset" }), { target: { value: "selected-neighborhood" } });
    expect(within(exportRegion).getByRole("heading", { level: 4 })).toHaveTextContent(/2 nodes · 1 edges/i);
    expect(within(exportRegion).getByRole("code")).toHaveTextContent(/Selected neighborhood/i);

    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => undefined } });
    fireEvent.click(within(exportRegion).getByRole("button", { name: /copy/i }));
    await waitFor(() => expect(within(exportRegion).getByRole("region", { name: "Data lineage export history" })).toHaveTextContent(/1 session export/i));
  });
});

describe("data-lineage helpers", () => {
  it("keeps only nodes and edges matching a filter", () => {
    const result = selectVisibleDataLineage(seedDataLineageNodes, seedDataLineageEdges, "eligibility gate", "all", "all");
    expect(result.visibleNodes.map((node) => node.id)).toEqual(["lineage-transform-consent"]);
    expect(result.visibleEdges).toHaveLength(0);

    const sensitive = selectVisibleDataLineage(seedDataLineageNodes, seedDataLineageEdges, "", "all", "all", "high");
    expect(sensitive.visibleNodes.map((node) => node.id)).toEqual(["lineage-source-memory"]);

    const missingEdges = selectVisibleDataLineage(seedDataLineageNodes, seedDataLineageEdges, "", "all", "all", "all", "missing");
    expect(missingEdges.visibleEdges.map((edge) => edge.id)).toEqual(["lineage-edge-8"]);
  });

  it("projects export presets without mutating the source graph", () => {
    expect(DATA_LINEAGE_EXPORT_PRESETS).toHaveLength(4);

    const reviewQueue = selectDataLineageExportScope("review-queue", seedDataLineageNodes, seedDataLineageEdges);
    expect(reviewQueue.nodes.every((node) => ["review", "blocked", "planned"].includes(node.status))).toBe(true);
    expect(reviewQueue.edges.every((edge) => reviewQueue.nodes.some((node) => node.id === edge.from) && reviewQueue.nodes.some((node) => node.id === edge.to))).toBe(true);

    const neighborhood = selectDataLineageExportScope("selected-neighborhood", seedDataLineageNodes, seedDataLineageEdges, "lineage-source-feedback");
    expect(neighborhood.nodes.map((node) => node.id)).toEqual(["lineage-source-feedback", "lineage-transform-redact"]);
    expect(neighborhood.edges.map((edge) => edge.id)).toEqual(["lineage-edge-1"]);

    const gaps = selectDataLineageExportScope("evidence-gaps", seedDataLineageNodes, seedDataLineageEdges);
    expect(gaps.edges.every((edge) => edge.status !== "observed")).toBe(true);
    expect(gaps.nodes.length).toBeGreaterThan(0);
  });

  it("serializes JSON and Markdown with the preview boundary", () => {
    const json = serializeDataLineage("json", seedDataLineageNodes.slice(0, 1), [], "feedback", { presetId: "review-queue" });
    expect(json).toMatch(/omnia\.data-lineage-studio\.preview\.v1/);
    expect(json).toMatch(/renderer-session/);
    expect(json).toMatch(/Review queue/);

    const markdown = serializeDataLineage("markdown", seedDataLineageNodes.slice(0, 1), [], "feedback", { presetId: "evidence-gaps" });
    expect(markdown).toMatch(/Omnia data lineage studio preview/);
    expect(markdown).toMatch(/Preview only/);
    expect(markdown).toMatch(/Evidence gaps/);
  });

  it("projects edge status into explicit evidence strength and review filters", () => {
    const records = buildDataLineageEvidenceLedger(seedDataLineageNodes, seedDataLineageEdges, new Set(["lineage-edge-1"]));
    expect(records.find((record) => record.id === "lineage-edge-1")?.strength).toBe("strong");
    expect(records.find((record) => record.id === "lineage-edge-8")?.strength).toBe("missing");
    expect(selectDataLineageEvidence(records, "rubric", "missing", "all").map((record) => record.id)).toEqual(["lineage-edge-8"]);
    expect(selectDataLineageEvidence(records, "", "all", "reviewed").map((record) => record.id)).toEqual(["lineage-edge-1"]);
  });
});
