import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { initialProviders } from "./mock-data";
import { selectableModelProfiles } from "./provider-catalog";
import { applyFallbackScenario, evaluateFallbackChain, ProviderFallbackRehearsal } from "./provider-fallback-rehearsal";

const routes = selectableModelProfiles(initialProviders).filter((model) => model.id !== "auto").slice(0, 3).map((model, index) => ({
  id: model.id,
  modelLabel: model.displayName,
  providerLabel: model.providerName,
  connectionId: model.connectionId,
  outcome: index === 0 ? "timeout" as const : "available" as const,
}));

describe("provider fallback rehearsal", () => {
  it("selects the first permitted available route and records the failed primary", () => {
    const result = evaluateFallbackChain(routes, "approved-connections");
    expect(result.terminalState).toBe("selected");
    expect(result.winnerId).toBe(routes[1]!.id);
    expect(result.audits[0]).toMatchObject({ decision: "failed" });
    expect(result.audits[1]).toMatchObject({ decision: "selected" });
  });

  it("blocks cross-connection fallback under same-connection consent", () => {
    const result = evaluateFallbackChain([
      routes[0]!,
      { ...routes[1]!, connectionId: "different-connection" },
    ], "same-connection");
    expect(result.terminalState).toBe("fallback-disabled");
    expect(result.winnerId).toBeNull();
    expect(result.reason).toMatch(/different connection/i);
  });

  it("stops on unknown acceptance instead of authorizing a blind retry", () => {
    const result = evaluateFallbackChain([
      { ...routes[0]!, outcome: "unknown" },
      { ...routes[1]!, outcome: "available" },
    ], "approved-connections");
    expect(result.terminalState).toBe("ambiguous");
    expect(result.winnerId).toBeNull();
    expect(result.audits[0]).toMatchObject({ decision: "ambiguous" });
  });

  it("applies deterministic scenario presets without mutating the source routes", () => {
    const source = routes.map((route) => ({ ...route, outcome: "available" as const }));
    const unknown = applyFallbackScenario(source, "unknown-acceptance");
    expect(unknown.map((route) => route.outcome)).toEqual(["unknown", "available", "available"]);
    expect(source.every((route) => route.outcome === "available")).toBe(true);

    const failures = applyFallbackScenario(source, "all-failures");
    expect(failures.map((route) => route.outcome)).toEqual(["timeout", "auth-failure", "rate-limited"]);
  });

  it("lets the user reorder outcomes and rehearse the local chain", () => {
    render(<ProviderFallbackRehearsal candidates={selectableModelProfiles(initialProviders)} consent="approved-connections" />);

    expect(screen.getByRole("heading", { name: "Fallback rehearsal" })).toBeInTheDocument();
    const firstRoute = screen.getAllByRole("combobox", { name: /^Outcome for / })[0]!;
    fireEvent.change(firstRoute, { target: { value: "timeout" } });
    fireEvent.click(screen.getByRole("button", { name: "Rehearse chain" }));
    expect(screen.getByRole("status")).toHaveTextContent(/Winner:|No route selected|Reconciliation required/i);
    expect(screen.getByText(/no endpoint call/i)).toBeInTheDocument();
  });

  it("supports a scenario preset and keeps a capped renderer-session run history", () => {
    render(<ProviderFallbackRehearsal candidates={selectableModelProfiles(initialProviders)} consent="approved-connections" />);

    fireEvent.change(screen.getByRole("combobox", { name: "Fallback scenario preset" }), { target: { value: "unknown-acceptance" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply scenario" }));
    expect(screen.getByText(/Unknown acceptance → stop applied/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Rehearse chain" }));
    expect(screen.getByRole("region", { name: "Fallback rehearsal history" })).toHaveTextContent(/ambiguous/i);

    fireEvent.click(screen.getByRole("button", { name: "Clear history" }));
    expect(screen.queryByRole("region", { name: "Fallback rehearsal history" })).not.toBeInTheDocument();
  });
});
