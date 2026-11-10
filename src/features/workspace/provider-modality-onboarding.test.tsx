import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { initialProviders } from "./mock-data";
import { ProviderModalityOnboarding, providerModalityStatus } from "./provider-modality-onboarding";

const browserRuntime = { tauri: false } as const;

describe("ProviderModalityOnboarding", () => {
  it("keeps media and voice endpoint capabilities explicit when the catalog does not report them", () => {
    render(
      <ProviderModalityOnboarding
        providers={initialProviders}
        selectedProvider={initialProviders[0]!}
        modelProfileId="auto"
        runtime={browserRuntime}
        onConnectProvider={vi.fn()}
        onDiscoverModels={vi.fn()}
        onReviewRoute={vi.fn()}
      />,
    );

    const matrix = screen.getByRole("region", { name: "Provider modality onboarding" });
    expect(within(matrix).getByText("Text chat")).toBeInTheDocument();
    expect(within(matrix).getByText("Image generation")).toBeInTheDocument();
    expect(within(matrix).getByText("Video generation")).toBeInTheDocument();
    expect(within(matrix).getByText("Live voice")).toBeInTheDocument();
    expect(within(matrix).getAllByText("Not reported").length).toBeGreaterThanOrEqual(4);
    expect(within(matrix).getAllByText(/browser preview does not prove provider dispatch/i).length).toBeGreaterThan(0);
  });

  it("shows a catalog action for an empty provider setup and calls the correct callback", () => {
    const onConnectProvider = vi.fn();
    render(
      <ProviderModalityOnboarding
        providers={[]}
        selectedProvider={null}
        modelProfileId="auto"
        runtime={browserRuntime}
        onConnectProvider={onConnectProvider}
        onDiscoverModels={vi.fn()}
        onReviewRoute={vi.fn()}
      />,
    );

    const action = screen.getByRole("button", { name: /Connect provider/i });
    fireEvent.click(action);
    expect(onConnectProvider).toHaveBeenCalledOnce();
    expect(screen.getByRole("status")).toHaveTextContent(/0 ready/);
  });

  it("derives vision readiness from model metadata but preserves browser preview state", () => {
    expect(providerModalityStatus("vision", initialProviders, initialProviders[0]!, "auto", browserRuntime)).toBe("preview");
    expect(providerModalityStatus("image-generation", initialProviders, initialProviders[0]!, "auto", browserRuntime)).toBe("not-reported");
    expect(providerModalityStatus("chat", [], null, "auto", browserRuntime)).toBe("needs-catalog");
  });
});
