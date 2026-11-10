import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { initialProviders } from "./mock-data";
import {
  buildProviderRouteCompareRows,
  filterProviderRouteCompareRows,
  PROVIDER_ROUTE_COMPARE_SCHEMA,
  ProviderRouteComparePreview,
  serializeProviderRouteComparison,
} from "./provider-route-compare-preview";

describe("provider route comparison preview", () => {
  it("projects provider and model metadata without treating it as dispatch evidence", () => {
    const rows = buildProviderRouteCompareRows(initialProviders);
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows[0]).toMatchObject({
      providerLabel: expect.any(String),
      modelLabel: expect.any(String),
      routeDisposition: "eligible-preview",
    });
    expect(rows[0]?.dispositionReason).toMatch(/metadata/i);
  });

  it("serializes only selected routes and keeps a prepared plan explicitly not run", () => {
    const rows = buildProviderRouteCompareRows(initialProviders);
    const selected = rows.slice(0, 2).map((row) => row.id);
    const payload = JSON.parse(serializeProviderRouteComparison(rows, selected, true, "json")) as {
      schema: string;
      fanoutPlan: { state: string; attempts: { outcome: string }[] };
      routes: unknown[];
      boundary: string[];
    };
    expect(payload.schema).toBe(PROVIDER_ROUTE_COMPARE_SCHEMA);
    expect(payload.routes).toHaveLength(2);
    expect(payload.fanoutPlan.state).toBe("prepared-not-run");
    expect(payload.fanoutPlan.attempts.every((attempt) => attempt.outcome === "not-run")).toBe(true);
    expect(payload.boundary.join(" ")).toMatch(/No provider request/i);
  });

  it("filters by provider and route readiness, then sorts missing latency last", () => {
    const rows = buildProviderRouteCompareRows(initialProviders);
    const provider = rows[0]!.providerLabel;
    expect(filterProviderRouteCompareRows(rows, { provider }).every((row) => row.providerLabel === provider)).toBe(true);
    expect(filterProviderRouteCompareRows(rows, { disposition: "eligible-preview" }).every((row) => row.routeDisposition === "eligible-preview")).toBe(true);

    const latencyRows = [
      { ...rows[0]!, id: "slow", latencyMs: 120 },
      { ...rows[0]!, id: "unknown", latencyMs: null },
      { ...rows[0]!, id: "fast", latencyMs: 20 },
    ];
    expect(filterProviderRouteCompareRows(latencyRows, { sort: "latency-low" }).map((row) => row.id)).toEqual(["fast", "slow", "unknown"]);
  });

  it("limits selection, prepares a renderer-only fan-out plan, and can make one route active", () => {
    const onModelProfileChange = vi.fn();
    render(<ProviderRouteComparePreview providers={initialProviders} modelProfileId="auto" onModelProfileChange={onModelProfileChange} />);

    expect(screen.getByRole("heading", { name: "Compare provider routes" })).toBeInTheDocument();
    expect(screen.getByText(/2 selected/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Prepare fan-out plan" }));
    expect(screen.getByText(/Prepared 2 renderer-only route attempts/i)).toBeInTheDocument();
    expect(screen.getByText("Planned · not run")).toBeInTheDocument();
    expect(screen.getByLabelText("Provider route comparison export preview")).toHaveTextContent(/No provider request/i);

    const routeButtons = screen.getAllByRole("button", { name: /Use .* as active route/i });
    fireEvent.click(routeButtons[0]!);
    expect(onModelProfileChange).toHaveBeenCalledTimes(1);

    const checkboxes = screen.getAllByRole("checkbox", { name: /Compare .* route/i });
    checkboxes.slice(2, 6).forEach((checkbox) => fireEvent.click(checkbox));
    expect(screen.getByText(/4 selected/i)).toBeInTheDocument();
  });

  it("filters routes and keeps the portable preview honest", () => {
    render(<ProviderRouteComparePreview providers={initialProviders} modelProfileId="auto" onModelProfileChange={() => undefined} />);

    fireEvent.change(screen.getByRole("textbox", { name: "Search provider routes" }), { target: { value: "local" } });
    expect(screen.getByRole("list", { name: "Provider routes available for comparison" })).toHaveTextContent(/Local runtime/i);
    expect(screen.getByLabelText("Provider route comparison export preview")).toHaveTextContent(PROVIDER_ROUTE_COMPARE_SCHEMA);
    fireEvent.change(screen.getByRole("combobox", { name: "Provider route comparison export format" }), { target: { value: "markdown" } });
    expect(screen.getByLabelText("Provider route comparison export preview")).toHaveTextContent("# Omnia provider route comparison (preview)");
    expect(screen.getByText(/do not call a provider/i)).toBeInTheDocument();
  });

  it("offers provider/readiness/sort controls and bounds select-visible to four routes", () => {
    render(<ProviderRouteComparePreview providers={initialProviders} modelProfileId="auto" onModelProfileChange={() => undefined} />);

    fireEvent.change(screen.getByRole("combobox", { name: "Filter routes by readiness" }), { target: { value: "blocked-preview" } });
    expect(screen.getByRole("status", { name: "Provider route visibility summary" })).toHaveTextContent(/2 selected · 0 visible/i);
    fireEvent.change(screen.getByRole("combobox", { name: "Filter routes by readiness" }), { target: { value: "all" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Sort provider routes" }), { target: { value: "latency-low" } });
    fireEvent.click(screen.getByRole("button", { name: "Select visible provider routes" }));

    expect(screen.getByText(/4 selected/i)).toBeInTheDocument();
    expect(screen.getByText(/Added .* visible route/i)).toBeInTheDocument();
  });

  it("exposes a validated compare receipt inspector without dispatching a provider", () => {
    render(<ProviderRouteComparePreview providers={initialProviders} modelProfileId="auto" onModelProfileChange={() => undefined} />);
    fireEvent.click(screen.getByText(/Inspect compare run receipt/i));
    expect(screen.getByRole("button", { name: "Validate compare snapshot" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Compare snapshot JSON" }), { target: { value: "{\"schema\":\"bad\"}" } });
    fireEvent.click(screen.getByRole("button", { name: "Validate compare snapshot" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/schema|snapshot/i);
    expect(screen.getByText(/No provider request was sent/i)).toBeInTheDocument();
  });
});
