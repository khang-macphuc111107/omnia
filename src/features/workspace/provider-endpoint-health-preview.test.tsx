import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { initialProviders } from "./mock-data";
import { ProviderEndpointHealthPreview } from "./provider-endpoint-health-preview";

describe("ProviderEndpointHealthPreview", () => {
  it("shows a renderer-local health overview with visible provider records", () => {
    render(<ProviderEndpointHealthPreview providers={initialProviders} />);

    expect(screen.getByRole("heading", { name: "Endpoint Health" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Overview/i })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("button", { name: /Inspect Custom lab endpoint/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Inspect Local runtime endpoint/i })).toBeInTheDocument();
    expect(screen.getByText(/Preview only · Renderer-local · No live probe/i)).toBeInTheDocument();
  });

  it("rehearses a latency scenario and keeps the change undoable", () => {
    render(<ProviderEndpointHealthPreview providers={initialProviders} />);

    fireEvent.change(screen.getByRole("combobox", { name: "Probe scenario" }), { target: { value: "latency-warning" } });
    expect(screen.getByText("Response latency is above the preview warning threshold (500 ms).")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Probe scenario" })).toHaveValue("latency-warning");

    fireEvent.click(screen.getByRole("button", { name: "Undo endpoint health change" }));
    expect(screen.getByRole("combobox", { name: "Probe scenario" })).toHaveValue("catalog-observed");
  });

  it("exposes detail, history, and redacted export views", () => {
    render(<ProviderEndpointHealthPreview providers={initialProviders} />);

    fireEvent.click(screen.getByRole("tab", { name: /Selected route/i }));
    expect(screen.getByText("Endpoint shape")).toBeInTheDocument();
    expect(screen.getByText(/DNS, TLS, auth, quota, provider HTTP/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /Check history/i }));
    expect(screen.getByRole("heading", { name: "Endpoint check history" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /Export/i }));
    expect(screen.getByRole("button", { name: "Copy JSON" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy Markdown" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download" })).toBeInTheDocument();
    expect(screen.getByText(/omnia.provider-endpoint-health.preview.v1/i)).toBeInTheDocument();
  });
});
