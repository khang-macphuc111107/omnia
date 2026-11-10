import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ModelDiscoveryPanel } from "./ModelDiscoveryPanel";
import type { ModelDiscoveryService } from "./model-discovery";

const profile = { id: "native-profile", displayName: "My local provider", providerType: "openai-compatible", enabled: true, credentialStatus: "missing" };
const model = { id: "local-model", displayName: "Local model", ownedBy: null, createdAt: null, capabilities: { streaming: true, tools: true, vision: null, reasoning: false, source: "provider-metadata" } };
const bridge = (available = true): ModelDiscoveryService => ({ available, listProfiles: vi.fn().mockResolvedValue([profile]), listModels: vi.fn().mockResolvedValue({ profileId: profile.id, discoveredAt: "2026-11-08T04:30:00.000Z", models: [model] }) });

describe("ModelDiscoveryPanel", () => {
  it("labels preview as unavailable and does not fabricate a catalog", () => {
    const service = bridge(false); render(<ModelDiscoveryPanel service={service} currentModel="auto" currentProfileId="" onChooseModel={vi.fn()} />);
    expect(screen.getByText(/Native model discovery is unavailable in browser preview/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Discover models" })).toBeDisabled();
    expect(service.listModels).not.toHaveBeenCalled();
  });

  it("discovers on request, shows provenance and applies the selected model immediately", async () => {
    const service = bridge(); const choose = vi.fn();
    render(<ModelDiscoveryPanel service={service} currentModel="auto" currentProfileId="" onChooseModel={choose} />);
    await waitFor(() => expect(screen.getByRole("option", { name: /My local provider/ })).toBeInTheDocument());
    expect(service.listModels).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Discovery provider"), { target: { value: profile.id } });
    fireEvent.click(screen.getByRole("button", { name: "Discover models" }));
    await waitFor(() => expect(screen.getByLabelText("Discovered model")).not.toBeDisabled());
    expect(screen.getByText(/provider-metadata/)).toBeInTheDocument();
    expect(screen.getByText(/Vision unknown/)).toBeInTheDocument();
    expect(screen.getByText(/Effort values are not supplied/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Discovered model"), { target: { value: model.id } });
    expect(choose).toHaveBeenCalledWith({ profileId: profile.id, modelId: model.id });
    expect(screen.getByText(/2026/).closest("time")).toHaveAttribute("datetime", "2026-11-08T04:30:00.000Z");
  });

  it("allows stopping the wait and states the native cancellation limit", async () => {
    const service = bridge(); service.listModels = () => new Promise(() => undefined);
    render(<ModelDiscoveryPanel service={service} currentModel="auto" currentProfileId="" onChooseModel={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("option", { name: /My local provider/ })).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Discovery provider"), { target: { value: profile.id } });
    fireEvent.click(screen.getByRole("button", { name: "Discover models" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop waiting for discovery" }));
    expect(screen.getByText(/A native request may still finish/)).toBeInTheDocument();
  });

  it("disables unsupported models and reports a selected model that disappeared after refresh", async () => {
    const unsupportedModel = { ...model, id: "unsupported-model", capabilities: { ...model.capabilities, streaming: false } };
    const service = bridge();
    service.listModels = vi.fn()
      .mockResolvedValueOnce({ profileId: profile.id, discoveredAt: "2026-11-08T04:30:00.000Z", models: [model, unsupportedModel] })
      .mockResolvedValueOnce({ profileId: profile.id, discoveredAt: "2026-11-08T04:31:00.000Z", models: [model] });
    const choose = vi.fn();
    const { rerender } = render(<ModelDiscoveryPanel service={service} currentModel={unsupportedModel.id} currentProfileId={profile.id} onChooseModel={choose} />);
    await waitFor(() => expect(screen.getByRole("option", { name: /My local provider/ })).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Discovery provider"), { target: { value: profile.id } });
    fireEvent.click(screen.getByRole("button", { name: "Discover models" }));
    await waitFor(() => expect(screen.getByRole("option", { name: /unsupported-model/ })).toBeInTheDocument());
    expect(screen.getByRole("option", { name: /unsupported-model/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Discover models" }));
    await waitFor(() => expect(service.listModels).toHaveBeenCalledTimes(2));
    rerender(<ModelDiscoveryPanel service={service} currentModel={unsupportedModel.id} currentProfileId={profile.id} onChooseModel={choose} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/unavailable|unsupported|disappeared/i);
    expect(choose).not.toHaveBeenCalled();
  });
});
