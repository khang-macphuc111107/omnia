import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import ObservabilityPreview from "./observability-preview";

describe("ObservabilityPreview", () => {
  it("filters run observations and keeps evidence labels visible", () => {
    render(<ObservabilityPreview />);
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "active" } });
    expect(screen.getByText("Research notebook draft")).toBeInTheDocument();
    expect(screen.queryByText("Project control review")).not.toBeInTheDocument();
    expect(screen.getByText(/native read planned/i)).toBeInTheDocument();
  });

  it("keeps missing provider evidence explicitly unknown", () => {
    render(<ObservabilityPreview />);
    const truth = screen.getByRole("region", { name: /observability evidence truth surface/i });
    expect(within(truth).getByText("Provider health")).toBeInTheDocument();
    expect(within(truth).getAllByText("Unknown").length).toBeGreaterThanOrEqual(2);
    expect(within(truth).getByText(/unknown is not unlimited/i)).toBeInTheDocument();
    expect(within(truth).queryByText("Healthy")).not.toBeInTheDocument();
  });

  it("exports a renderer-local preview", () => {
    render(<ObservabilityPreview />);
    const region = screen.getByRole("region", { name: /observability export preview/i });
    expect(within(region).getByRole("code")).toHaveTextContent(/omnia\.observability\.preview\.v1/);
    expect(within(region).getByRole("code")).toHaveTextContent(/\"evidence\"/);
    fireEvent.change(within(region).getByLabelText(/format/i), { target: { value: "markdown" } });
    expect(within(region).getByRole("code")).toHaveTextContent(/renderer-demo/i);
    expect(within(region).getByRole("code")).toHaveTextContent(/Evidence truth surface/i);
    expect(screen.getByText(/does not query provider health/i)).toBeInTheDocument();
  });

  it("keeps time-series query dimensions explicit and interactive", () => {
    render(<ObservabilityPreview />);
    const series = screen.getByRole("region", { name: /observability time-series analytics preview/i });
    expect(within(series).getByText("Time-series analytics preview")).toBeInTheDocument();
    expect(within(series).getByText(/Unresolved preview anchor/i)).toBeInTheDocument();

    fireEvent.change(within(series).getByLabelText("Series metric"), { target: { value: "cost" } });
    fireEvent.change(within(series).getByLabelText("Series aggregation"), { target: { value: "moving-average" } });
    fireEvent.change(within(series).getByLabelText("Series window"), { target: { value: "24h" } });
    fireEvent.change(within(series).getByLabelText("Series comparison"), { target: { value: "previous-window" } });
    fireEvent.change(within(series).getByLabelText("Series bucket"), { target: { value: "1h" } });
    fireEvent.change(within(series).getByLabelText("Series timezone"), { target: { value: "utc" } });

    expect(within(series).getByText(/Exact preview values for Cost estimate/i)).toBeInTheDocument();
    expect(within(series).getByText(/synthetic, session-scoped and partial/i)).toBeInTheDocument();
    expect(within(series).getByRole("img", { name: /Cost estimate moving-average chart in 24h window/i })).toBeInTheDocument();
    expect(within(series).getByRole("status")).toHaveTextContent(/Latest delta:.*previous window/i);
    expect(within(series).getByText(/Bucket: 1h/i)).toBeInTheDocument();
    expect(within(series).getByText(/Timezone: utc/i)).toBeInTheDocument();
  });

  it("offers explicit throughput and cost-rate metrics with unambiguous demo units", () => {
    render(<ObservabilityPreview />);
    const series = screen.getByRole("region", { name: /observability time-series analytics preview/i });

    fireEvent.change(within(series).getByLabelText("Series metric"), { target: { value: "generated-tps" } });
    expect(within(series).getByText("Generated output token rate")).toBeInTheDocument();
    expect(within(series).getByText("Unit: demo tokens/s")).toBeInTheDocument();
    expect(within(series).getByText(/synthetic renderer values, not a provider timing observation/i)).toBeInTheDocument();

    fireEvent.change(within(series).getByLabelText("Series metric"), { target: { value: "cost-per-hour" } });
    expect(within(series).getByText("Unit: demo credits/hour")).toBeInTheDocument();
    expect(within(series).getByText(/currency, provider pricing, and invoice evidence are not connected/i)).toBeInTheDocument();

    const exportRegion = screen.getByRole("region", { name: /observability export preview/i });
    expect(within(exportRegion).getByRole("code")).toHaveTextContent(/"namespace": "cost\.currency_per_hour"/);
    expect(within(exportRegion).getByRole("code")).toHaveTextContent(/"unit": "demo credits\/hour"/);

    fireEvent.change(within(series).getByLabelText("Series metric"), { target: { value: "visible-characters-per-second" } });
    expect(within(series).getByText("Unit: demo characters/s")).toBeInTheDocument();
    expect(within(exportRegion).getByRole("code")).toHaveTextContent(/"namespace": "characters\.visible_per_second"/);
  });

  it("includes one-day and one-week windows in addition to the hourly presets", () => {
    render(<ObservabilityPreview />);
    const series = screen.getByRole("region", { name: /observability time-series analytics preview/i });
    const windowSelect = within(series).getByLabelText("Series window");

    fireEvent.change(windowSelect, { target: { value: "1d" } });
    expect(windowSelect).toHaveValue("1d");
    expect(within(series).getByRole("img", { name: /chart in 1d window/i })).toBeInTheDocument();

    fireEvent.change(windowSelect, { target: { value: "1w" } });
    expect(windowSelect).toHaveValue("1w");
    expect(within(series).getByRole("img", { name: /chart in 1w window/i })).toBeInTheDocument();
  });

  it("includes time-series provenance and missing native query evidence in exports", () => {
    render(<ObservabilityPreview />);
    const exportRegion = screen.getByRole("region", { name: /observability export preview/i });
    expect(within(exportRegion).getByRole("code")).toHaveTextContent(/"timeSeries"/);
    expect(within(exportRegion).getByRole("code")).toHaveTextContent(/"resolution": "renderer-preview-only"/);
    expect(within(exportRegion).getByRole("code")).toHaveTextContent(/"comparison": null/);
    expect(within(exportRegion).getByRole("code")).toHaveTextContent(/"bucket": "auto"/);
    expect(within(exportRegion).getByRole("code")).toHaveTextContent(/"timezone": "local"/);
    expect(within(exportRegion).getByRole("code")).toHaveTextContent(/native anchor resolution/);
  });

  it("does not invent a percentage when a comparison denominator is zero", () => {
    render(<ObservabilityPreview />);
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "planned" } });
    const series = screen.getByRole("region", { name: /observability time-series analytics preview/i });
    fireEvent.change(within(series).getByLabelText("Series metric"), { target: { value: "active-runs" } });
    fireEvent.change(within(series).getByLabelText("Series comparison"), { target: { value: "previous-window" } });

    expect(within(series).getByRole("status")).toHaveTextContent(/percentage unavailable: comparison denominator is zero/i);
  });

  it("keeps custom windows, anchor references and dimensions visible in the preview export", () => {
    render(<ObservabilityPreview />);
    const series = screen.getByRole("region", { name: /observability time-series analytics preview/i });
    fireEvent.change(within(series).getByLabelText("Series window"), { target: { value: "custom" } });
    fireEvent.change(within(series).getByLabelText("Custom series window length"), { target: { value: "90" } });
    fireEvent.change(within(series).getByLabelText("Custom series window unit"), { target: { value: "m" } });
    fireEvent.change(within(series).getByLabelText("Series anchor"), { target: { value: "attempt" } });
    fireEvent.change(within(series).getByLabelText("Series anchor reference"), { target: { value: "attempt-7" } });
    fireEvent.change(within(series).getByLabelText("Series aggregation"), { target: { value: "p95" } });
    fireEvent.change(within(series).getByLabelText("Series dimension"), { target: { value: "provider" } });

    expect(within(series).getByText(/Window: 90 minutes/i)).toBeInTheDocument();
    expect(within(series).getByText(/Anchor: Provider attempt/i)).toBeInTheDocument();
    expect(within(series).getByText(/Dimension: Provider/i)).toBeInTheDocument();
    const exportRegion = screen.getByRole("region", { name: /observability export preview/i });
    expect(within(exportRegion).getByRole("code")).toHaveTextContent(/"namespace": "usage\.demo_units"/);
    expect(within(exportRegion).getByRole("code")).toHaveTextContent(/"reference": "attempt-7"/);
    expect(within(exportRegion).getByRole("code")).toHaveTextContent(/"kind": "provider"/);
    expect(within(exportRegion).getByRole("code")).toHaveTextContent(/"aggregation": "p95"/);
  });

  it("supports an absolute start/end range with independent boundary anchors", () => {
    render(<ObservabilityPreview />);
    const series = screen.getByRole("region", { name: /observability time-series analytics preview/i });
    fireEvent.change(within(series).getByLabelText("Series window"), { target: { value: "absolute" } });

    expect(within(series).getByRole("group", { name: /absolute series range controls/i })).toBeInTheDocument();
    fireEvent.change(within(series).getByLabelText("Absolute range start"), { target: { value: "2026-09-29T08:00" } });
    fireEvent.change(within(series).getByLabelText("Absolute range end"), { target: { value: "2026-09-30T08:00" } });
    fireEvent.change(within(series).getByLabelText("Absolute range start anchor"), { target: { value: "prompt" } });
    fireEvent.change(within(series).getByLabelText("Absolute range start reference"), { target: { value: "prompt-3" } });
    fireEvent.change(within(series).getByLabelText("Absolute range end anchor"), { target: { value: "request" } });
    fireEvent.change(within(series).getByLabelText("Absolute range end reference"), { target: { value: "request-8" } });

    expect(within(series).getByText(/Valid preview range:/i)).toBeInTheDocument();
    expect(within(series).getByText(/Prompt → Request/i)).toBeInTheDocument();
    const exportRegion = screen.getByRole("region", { name: /observability export preview/i });
    expect(within(exportRegion).getByRole("code")).toHaveTextContent(/"window": "absolute"/);
    expect(within(exportRegion).getByRole("code")).toHaveTextContent(/"start": "2026-09-29T08:00"/);
    expect(within(exportRegion).getByRole("code")).toHaveTextContent(/"end": "2026-09-30T08:00"/);
    expect(within(exportRegion).getByRole("code")).toHaveTextContent(/"reference": "prompt-3"/);
    expect(within(exportRegion).getByRole("code")).toHaveTextContent(/"reference": "request-8"/);
  });

  it("keeps an incomplete absolute range visibly unresolved instead of inventing validity", () => {
    render(<ObservabilityPreview />);
    const series = screen.getByRole("region", { name: /observability time-series analytics preview/i });
    fireEvent.change(within(series).getByLabelText("Series window"), { target: { value: "absolute" } });
    fireEvent.change(within(series).getByLabelText("Absolute range start"), { target: { value: "2026-09-30T10:00" } });
    fireEvent.change(within(series).getByLabelText("Absolute range end"), { target: { value: "2026-09-30T09:00" } });

    const absoluteControls = within(series).getByRole("group", { name: /absolute series range controls/i });
    expect(within(absoluteControls).getByRole("status")).toHaveTextContent(/Start must be earlier than end/i);
    expect(within(series).getByText(/Absolute range unresolved/i)).toBeInTheDocument();
    const exportRegion = screen.getByRole("region", { name: /observability export preview/i });
    expect(within(exportRegion).getByRole("code")).toHaveTextContent(/"valid": false/);
    expect(within(exportRegion).getByRole("code")).toHaveTextContent(/"error": "start-must-precede-end"/);
  });

  it("can reset the query builder without implying a durable write", () => {
    render(<ObservabilityPreview />);
    const series = screen.getByRole("region", { name: /observability time-series analytics preview/i });
    fireEvent.change(within(series).getByLabelText("Series metric"), { target: { value: "coverage" } });
    fireEvent.change(within(series).getByLabelText("Series aggregation"), { target: { value: "p95" } });
    fireEvent.change(within(series).getByLabelText("Series dimension"), { target: { value: "provider" } });
    fireEvent.click(within(series).getByRole("button", { name: /reset time-series query/i }));

    expect(within(series).getByLabelText("Series metric")).toHaveValue("usage");
    expect(within(series).getByLabelText("Series aggregation")).toHaveValue("raw");
    expect(within(series).getByLabelText("Series dimension")).toHaveValue("none");
    expect(screen.getByText(/reset the renderer-local time-series query/i)).toBeInTheDocument();
  });
});
