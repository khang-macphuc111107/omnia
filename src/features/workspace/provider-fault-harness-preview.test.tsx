import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ProviderFaultHarnessPreview } from "./provider-fault-harness-preview";

describe("ProviderFaultHarnessPreview", () => {
  it("renders the complete catalogue summary and truthful test-only boundary", () => {
    render(<ProviderFaultHarnessPreview />);

    expect(screen.getByRole("heading", { name: "Inspect deterministic failure boundaries" })).toBeInTheDocument();
    expect(screen.getByLabelText("Provider fault harness summary")).toHaveTextContent("40");
    expect(screen.getByRole("list", { name: "Provider fault catalogue" })).toHaveTextContent("Before connection / request");
    expect(screen.getByRole("region", { name: "Inspect deterministic failure boundaries" })).toHaveTextContent("cfg(test)");
    expect(screen.getByRole("button", { name: /Run native harness/i })).toBeDisabled();
  });

  it("filters by protocol and exposes the selected assertion", () => {
    render(<ProviderFaultHarnessPreview />);

    fireEvent.change(screen.getByRole("combobox", { name: "Provider fault domain" }), { target: { value: "Protocol" } });
    const list = screen.getByRole("list", { name: "Provider fault catalogue" });
    expect(within(list).getByRole("button", { name: /PF-014\. OpenAI finish reason without \[DONE\]/i })).toBeInTheDocument();
    expect(within(list).queryByRole("button", { name: /PF-027\. Cancel before HTTP poll/i })).not.toBeInTheDocument();

    fireEvent.click(within(list).getByRole("button", { name: /PF-014\. OpenAI finish reason without \[DONE\]/i }));
    const detail = screen.getByRole("complementary", { name: "Selected provider fault" });
    expect(detail).toHaveTextContent("Complete only when the frozen adapter contract accepts the finish reason");
    expect(detail).toHaveTextContent("openai");
  });

  it("prepares a scenario preview with custom provider and fragmentation settings", () => {
    render(<ProviderFaultHarnessPreview />);

    fireEvent.change(screen.getByRole("combobox", { name: "Provider fault domain" }), { target: { value: "Recovery" } });
    fireEvent.click(screen.getByRole("button", { name: /PF-031\. Timeout or reset after possible send/i }));
    fireEvent.change(screen.getByLabelText("Provider family"), { target: { value: "anthropic" } });
    fireEvent.change(screen.getByLabelText("Fragmentation"), { target: { value: "seeded" } });
    fireEvent.change(screen.getByLabelText("Replay seed"), { target: { value: "test-seed-031" } });
    fireEvent.click(screen.getByRole("button", { name: /Prepare scenario preview/i }));

    const exportRegion = screen.getByRole("region", { name: "Provider fault scenario export preview" });
    expect(exportRegion).toHaveTextContent('"scenarioId": "PF-031"');
    expect(exportRegion).toHaveTextContent('"providerFamily": "anthropic"');
    expect(exportRegion).toHaveTextContent('"fragmentation": "seeded"');
    expect(exportRegion).toHaveTextContent('"seed": "test-seed-031"');
    expect(screen.getByRole("status", { name: "Provider fault harness status" })).toHaveTextContent("no listener, provider request, or native test was started");
  });

  it("supports a portable markdown preview without claiming durable output", () => {
    render(<ProviderFaultHarnessPreview />);

    fireEvent.click(screen.getByRole("button", { name: /Prepare scenario preview/i }));
    const exportRegion = screen.getByRole("region", { name: "Provider fault scenario export preview" });
    fireEvent.change(within(exportRegion).getByRole("combobox", { name: "Provider fault export format" }), { target: { value: "markdown" } });
    expect(exportRegion).toHaveTextContent("# PF-001");
    expect(exportRegion).toHaveTextContent("renderer-local");
    expect(exportRegion).toHaveTextContent("no durable write");
  });
});
