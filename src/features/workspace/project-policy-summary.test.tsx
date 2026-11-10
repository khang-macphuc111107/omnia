import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { buildProjectContextAvailability } from "./project-context-availability-contract";
import { initialProjects, initialProviders } from "./mock-data";
import { ProjectPolicySummary } from "./project-policy-summary";
import { selectableModelProfiles } from "./provider-catalog";

function renderPolicy() {
  const project = initialProjects[0]!;
  const contextAvailability = buildProjectContextAvailability({
    health: project.contextHealth,
    folders: project.folders,
  });
  return render(
    <ProjectPolicySummary
      projectName={project.name}
      providers={initialProviders}
      initialMainModelProfileId={project.modelProfileId}
      contextAvailability={contextAvailability}
      contextSourceCount={contextAvailability.folders.total}
      contextSelectedCount={contextAvailability.folders.referenced}
      contextEstimatedTokens={1_240}
    />,
  );
}

describe("Project policy summary preview", () => {
  it("keeps main-agent and subagent model selections independent and reversible", () => {
    renderPolicy();
    const profiles = selectableModelProfiles(initialProviders).filter((profile) => profile.id !== "auto");
    const main = screen.getByRole("combobox", { name: "Main-agent model preview" });
    const subagent = screen.getByRole("combobox", { name: "Subagent model preview" });

    fireEvent.change(main, { target: { value: profiles[0]!.id } });
    fireEvent.change(subagent, { target: { value: profiles.at(-1)!.id } });
    expect(main).toHaveValue(profiles[0]!.id);
    expect(subagent).toHaveValue(profiles.at(-1)!.id);

    fireEvent.click(screen.getByRole("button", { name: "Undo Project policy preview change" }));
    expect(subagent).toHaveValue("auto");
    expect(main).toHaveValue(profiles[0]!.id);
    fireEvent.click(screen.getByRole("button", { name: "Redo Project policy preview change" }));
    expect(subagent).toHaveValue(profiles.at(-1)!.id);
  });

  it("keeps main-agent and subagent context delivery modes independent and exportable", () => {
    renderPolicy();
    const mainContext = screen.getByRole("combobox", { name: "Context delivery mode preview" });
    const subagentContext = screen.getByRole("combobox", { name: "Subagent context delivery mode preview" });

    fireEvent.change(mainContext, { target: { value: "full" } });
    fireEvent.change(subagentContext, { target: { value: "manifest-only" } });
    expect(mainContext).toHaveValue("full");
    expect(subagentContext).toHaveValue("manifest-only");

    fireEvent.click(screen.getByRole("button", { name: "Undo Project policy preview change" }));
    expect(mainContext).toHaveValue("full");
    expect(subagentContext).toHaveValue("partial");
    fireEvent.click(screen.getByRole("button", { name: "Redo Project policy preview change" }));
    expect(subagentContext).toHaveValue("manifest-only");

    fireEvent.click(screen.getByRole("button", { name: "Inspect policy JSON" }));
    const preview = screen.getByLabelText("Project policy JSON preview");
    expect(preview).toHaveTextContent('"mainMode": "full"');
    expect(preview).toHaveTextContent('"subagentMode": "manifest-only"');
  });

  it("shows context, cache and compaction controls with an explicit evidence boundary", () => {
    renderPolicy();
    fireEvent.change(screen.getByRole("combobox", { name: "Context delivery mode preview" }), { target: { value: "manifest-only" } });
    expect(screen.getByText(/Manifest only ·/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Evidence and authority boundary/i }));
    expect(screen.getByText("Unknown · not inspected by this draft")).toBeInTheDocument();
    expect(screen.getByText(/No authority increase/i)).toBeInTheDocument();
    expect(screen.getByText(/Compaction is only a renderer draft; no trigger runs/i)).toBeInTheDocument();
    expect(within(screen.getByRole("combobox", { name: "Compaction trigger preview" })).getByRole("option", { name: "Disabled" })).toBeInTheDocument();
  });

  it("edits all compaction threshold dimensions and exports schema-aligned units", () => {
    renderPolicy();
    const tokenThreshold = screen.getByRole("spinbutton", { name: "Compaction token threshold preview" });
    const costThreshold = screen.getByRole("spinbutton", { name: "Compaction cost threshold preview" });
    const latencyThreshold = screen.getByRole("spinbutton", { name: "Compaction latency threshold preview" });

    fireEvent.change(tokenThreshold, { target: { value: "64000" } });
    fireEvent.change(costThreshold, { target: { value: "500000" } });
    fireEvent.change(latencyThreshold, { target: { value: "30000" } });
    expect(tokenThreshold).toHaveValue(64000);
    expect(costThreshold).toHaveValue(500000);
    expect(latencyThreshold).toHaveValue(30000);

    fireEvent.click(screen.getByRole("button", { name: "Inspect policy JSON" }));
    const preview = screen.getByLabelText("Project policy JSON preview");
    const payload = JSON.parse(preview.textContent ?? "{}") as { context: { compaction: Record<string, unknown> } };
    expect(payload.context.compaction).toMatchObject({
      mode: "threshold",
      tokenThreshold: 64000,
      contextPercentageThreshold: 0.78,
      costThresholdMicrounits: 500000,
      latencyThresholdMs: 30000,
    });

    fireEvent.change(screen.getByRole("combobox", { name: "Project policy export format" }), { target: { value: "markdown" } });
    const markdown = screen.getByLabelText("Project policy Markdown preview");
    expect(markdown).toHaveTextContent(/64[,.]000 tokens/);
    expect(markdown).toHaveTextContent(/500[,.]000 microunits/);
    expect(markdown).toHaveTextContent(/30[,.]000 ms/);
  });

  it("keeps optional compaction limits null and disables them with compaction", () => {
    renderPolicy();
    const tokenThreshold = screen.getByRole("spinbutton", { name: "Compaction token threshold preview" });
    const costThreshold = screen.getByRole("spinbutton", { name: "Compaction cost threshold preview" });
    const latencyThreshold = screen.getByRole("spinbutton", { name: "Compaction latency threshold preview" });
    expect(tokenThreshold).toHaveValue(null);
    expect(costThreshold).toHaveValue(null);
    expect(latencyThreshold).toHaveValue(null);

    fireEvent.change(screen.getByRole("combobox", { name: "Compaction trigger preview" }), { target: { value: "disabled" } });
    expect(tokenThreshold).toBeDisabled();
    expect(costThreshold).toBeDisabled();
    expect(latencyThreshold).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Inspect policy JSON" }));
    const preview = screen.getByLabelText("Project policy JSON preview");
    const payload = JSON.parse(preview.textContent ?? "{}") as { context: { compaction: Record<string, unknown> } };
    expect(payload.context.compaction).toMatchObject({
      mode: "disabled",
      tokenThreshold: null,
      contextPercentageThreshold: 0.78,
      costThresholdMicrounits: null,
      latencyThresholdMs: null,
    });
  });

  it("keeps user-side cache planning separate from provider cache evidence", () => {
    renderPolicy();
    fireEvent.change(screen.getByRole("combobox", { name: "Cache handoff rehearsal preview" }), { target: { value: "provider-hint-when-supported" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Cache key strategy preview" }), { target: { value: "source-revision" } });

    fireEvent.click(screen.getByRole("button", { name: "Evidence and authority boundary" }));
    expect(screen.getByText("Unknown · not inspected by this draft")).toBeInTheDocument();
    expect(screen.getByText(/does not send a provider hint/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Inspect policy JSON" }));
    const preview = screen.getByLabelText("Project policy JSON preview");
    expect(preview).toHaveTextContent('"handoffMode": "provider-hint-when-supported"');
    expect(preview).toHaveTextContent('"keyStrategy": "source-revision"');
    expect(preview).toHaveTextContent('"status": "unknown"');
  });

  it("keeps route evidence visible and distinguishes preview candidates from unresolved auto routing", () => {
    renderPolicy();
    expect(screen.getByText("Route evidence")).toBeInTheDocument();
    expect(screen.getByText("Main agent")).toBeInTheDocument();
    expect(screen.getByText("Subagent")).toBeInTheDocument();
    expect(screen.getByText("Auto candidate")).toBeInTheDocument();
    expect(screen.getAllByText("Preview catalog").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Inspect policy JSON" }));
    const preview = screen.getByLabelText("Project policy JSON preview");
    expect(preview).toHaveTextContent('"autoCandidate"');
    expect(preview).toHaveTextContent('"stateLabel": "Preview catalog"');
    expect(preview).toHaveTextContent('"detail":');
  });

  it("coalesces range drags into one undo and restores defaults", () => {
    renderPolicy();
    const budget = screen.getByRole("slider", { name: "Context input budget preview" });
    fireEvent.change(budget, { target: { value: "5000" } });
    fireEvent.change(budget, { target: { value: "6800" } });
    expect(budget).toHaveValue("6800");
    fireEvent.click(screen.getByRole("button", { name: "Undo Project policy preview change" }));
    expect(budget).toHaveValue("3200");

    fireEvent.change(screen.getByRole("combobox", { name: "User-side cache reuse policy preview" }), { target: { value: "aggressive-reuse" } });
    expect(screen.getByRole("combobox", { name: "User-side cache reuse policy preview" })).toHaveValue("aggressive-reuse");
    fireEvent.click(screen.getByRole("button", { name: "Reset Project policy preview" }));
    expect(screen.getByRole("combobox", { name: "User-side cache reuse policy preview" })).toHaveValue("safe-reuse");
  });

  it("inspects a portable JSON preview without credentials, prompts or raw content", () => {
    renderPolicy();
    fireEvent.click(screen.getByRole("button", { name: "Inspect policy JSON" }));
    const preview = screen.getByLabelText("Project policy JSON preview");
    const payload = within(preview).getByText(/omnia\.project-policy-preview\.v1/i).textContent ?? "";
    expect(payload).toContain("omnia.project-policy-preview.v1");
    expect(preview).toHaveTextContent("renderer-session");
    expect(preview).toHaveTextContent("providerReported");
    expect(payload).toContain("Credential bytes, raw prompt/response bodies, cookies, file bytes and local paths are excluded.");
    expect(payload).not.toMatch(/Bearer\s+|sk-[A-Za-z0-9]|api[_-]?key/i);
  });

  it("switches the portable inspection preview to Markdown without exposing raw content", () => {
    renderPolicy();
    fireEvent.change(screen.getByRole("combobox", { name: "Project policy export format" }), { target: { value: "markdown" } });
    fireEvent.click(screen.getByRole("button", { name: "Inspect policy Markdown" }));
    const preview = screen.getByLabelText("Project policy Markdown preview");
    expect(preview).toHaveTextContent("# Omnia project policy preview");
    expect(preview).toHaveTextContent("renderer-session");
    expect(preview).toHaveTextContent("Provider-reported cache: Unknown — not inspected by this draft");
    expect(preview).not.toHaveTextContent("No credentials, prompts, responses");
    expect(preview.textContent ?? "").not.toMatch(/Bearer\s+|sk-[A-Za-z0-9]|api[_-]?key/i);
  });

  it("marks blocked context estimates as unknown and disables an irrelevant compaction threshold", () => {
    const project = initialProjects[0]!;
    const contextAvailability = buildProjectContextAvailability({
      health: "missing-access",
      folders: project.folders,
    });
    render(
      <ProjectPolicySummary
        projectName={project.name}
        providers={initialProviders}
        initialMainModelProfileId={project.modelProfileId}
        contextAvailability={contextAvailability}
        contextSourceCount={contextAvailability.folders.total}
        contextSelectedCount={contextAvailability.folders.referenced}
        contextEstimatedTokens={null}
      />,
    );

    expect(screen.getAllByText(/token estimate withheld · context is blocked/i)).toHaveLength(2);
    const threshold = screen.getByRole("slider", { name: "Compaction threshold preview" });
    expect(threshold).not.toBeDisabled();
    fireEvent.change(screen.getByRole("combobox", { name: "Compaction trigger preview" }), { target: { value: "disabled" } });
    expect(threshold).toBeDisabled();
    expect(screen.getByText(/Threshold is ignored while compaction is disabled/i)).toBeInTheDocument();
  });

  it("withholds a stale numeric estimate when the project is over budget", () => {
    const project = initialProjects[0]!;
    const contextAvailability = buildProjectContextAvailability({
      health: "over-budget",
      folders: project.folders,
    });
    render(
      <ProjectPolicySummary
        projectName={project.name}
        providers={initialProviders}
        initialMainModelProfileId={project.modelProfileId}
        contextAvailability={contextAvailability}
        contextSourceCount={contextAvailability.folders.total}
        contextSelectedCount={contextAvailability.folders.referenced}
        // A host may still have a pre-blocking estimate. The policy surface
        // must fail closed instead of treating it as current admission data.
        contextEstimatedTokens={6_400}
      />,
    );

    expect(screen.getAllByText(/token estimate withheld · context is blocked/i)).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Inspect policy JSON" }));
    const preview = screen.getByLabelText("Project policy JSON preview");
    expect(preview).toHaveTextContent('"estimatedInputTokens": null');
    expect(preview).toHaveTextContent('"status": "withheld"');
    expect(preview).not.toHaveTextContent('"status": "heuristic"');
  });

  it("reports clipboard denial instead of implying that export succeeded", async () => {
    renderPolicy();
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
    fireEvent.click(screen.getByRole("button", { name: "Copy renderer-local policy JSON to the clipboard" }));
    expect(await screen.findByText(/Clipboard access was denied/i)).toBeInTheDocument();
  });
});
