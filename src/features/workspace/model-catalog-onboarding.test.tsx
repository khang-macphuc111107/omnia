import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { initialProviders } from "./mock-data";
import { ModelCatalogOnboarding } from "./model-catalog-onboarding";

const browserRuntime = { tauri: false } as const;

describe("ModelCatalogOnboarding", () => {
  it("guides an empty workspace to provider setup without implying a live request", () => {
    const onConnectProvider = vi.fn();
    render(
      <ModelCatalogOnboarding
        providers={[]}
        selectedProvider={null}
        modelProfileId="auto"
        runtime={browserRuntime}
        onConnectProvider={onConnectProvider}
        onDiscoverModels={vi.fn()}
        onReviewRoute={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: "Set up your first model route" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("0/3 complete");
    expect(screen.getByText(/Browser preview onboarding uses session metadata only/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Connect provider/i }));
    expect(onConnectProvider).toHaveBeenCalledOnce();
  });

  it("exposes the discovery action when a provider exists without a catalog", () => {
    const onDiscoverModels = vi.fn();
    const provider = {
      ...initialProviders[0]!,
      state: "configuration-validated" as const,
      modelCount: 0,
      models: [],
    };

    render(
      <ModelCatalogOnboarding
        providers={[provider]}
        selectedProvider={provider}
        modelProfileId="auto"
        runtime={browserRuntime}
        onConnectProvider={vi.fn()}
        onDiscoverModels={onDiscoverModels}
        onReviewRoute={vi.fn()}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("1/3 complete");
    expect(screen.getByText(/Validate the selected provider/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Test & discover" }));
    expect(onDiscoverModels).toHaveBeenCalledWith(provider);
  });

  it("marks a preview catalog route as visible while preserving the no-dispatch boundary", () => {
    const onReviewRoute = vi.fn();
    render(
      <ModelCatalogOnboarding
        providers={initialProviders}
        selectedProvider={initialProviders[0]!}
        modelProfileId="auto"
        runtime={browserRuntime}
        onConnectProvider={vi.fn()}
        onDiscoverModels={vi.fn()}
        onReviewRoute={onReviewRoute}
      />,
    );

    expect(screen.getByRole("heading", { name: "Model route visible" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("3/3 complete");
    expect(screen.getByText(/no provider request or dispatch is proven here/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Review Chat route" }));
    expect(onReviewRoute).toHaveBeenCalledOnce();
  });
});

