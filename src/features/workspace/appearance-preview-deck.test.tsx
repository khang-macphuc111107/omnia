import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { AppearancePreviewDeck } from "./appearance-preview-deck";
import { clearSessionPalettePreview } from "./session-palette-preview";

afterEach(() => clearSessionPalettePreview());

describe("Appearance Preview Deck", () => {
  it("offers multiple palette directions and keeps changes reversible in the renderer", () => {
    render(<AppearancePreviewDeck />);

    expect(screen.getByRole("heading", { name: /Shape a richer Omnia palette/i })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Use Palette/i })).toHaveLength(12);
    expect(screen.getAllByRole("button", { name: /Use Logo/i })).toHaveLength(12);
    expect(screen.getByRole("button", { name: "Use Logo 1 · Open aperture" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Use Palette 3 · Tidal Spectrum" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: "Use Palette 5 · Coral Terminal" }));
    expect(screen.getByRole("button", { name: "Use Palette 5 · Coral Terminal" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("status")).toHaveTextContent(/Palette 5.*selected/i);

    fireEvent.click(screen.getByRole("button", { name: "Undo appearance preview change" }));
    expect(screen.getByRole("button", { name: "Use Palette 3 · Tidal Spectrum" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: "Use Logo 9 · Open O" }));
    expect(screen.getByRole("button", { name: "Use Logo 9 · Open O" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Undo appearance preview change" }));
    expect(screen.getByRole("button", { name: "Use Logo 1 · Open aperture" })).toHaveAttribute("aria-pressed", "true");
  });

  it("supports a custom accent and a renderer-local JSON/Markdown export preview", () => {
    render(<AppearancePreviewDeck />);

    fireEvent.change(screen.getByRole("textbox", { name: "Custom appearance accent hex" }), {
      target: { value: "#22c55e" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Use custom accent" }));
    expect(screen.getByRole("status")).toHaveTextContent(/#22C55E.*renderer preview/i);

    fireEvent.click(screen.getByRole("button", { name: "Preview export" }));
    const exportRegion = screen.getByRole("region", { name: "Appearance export preview" });
    expect(within(exportRegion).getByRole("code")).toHaveTextContent(/omnia\.appearance-preview\.v1/i);
    expect(within(exportRegion).getByRole("code")).toHaveTextContent(/logo-01-open-aperture/i);

    fireEvent.change(within(exportRegion).getByRole("combobox", { name: "Appearance export format" }), {
      target: { value: "markdown" },
    });
    expect(within(exportRegion).getByRole("code")).toHaveTextContent(/# Omnia appearance preview/i);
    expect(within(exportRegion).getByText(/does not alter global design tokens/i)).toBeInTheDocument();

    fireEvent.change(within(exportRegion).getByRole("combobox", { name: "Appearance export format" }), {
      target: { value: "css" },
    });
    expect(within(exportRegion).getByRole("code")).toHaveTextContent(/--omnia-accent-primary/);
  });

  it("rejects malformed custom accents without changing the preview", () => {
    render(<AppearancePreviewDeck />);

    fireEvent.change(screen.getByRole("textbox", { name: "Custom appearance accent hex" }), {
      target: { value: "purple" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Use custom accent" }));
    expect(screen.getByRole("status")).toHaveTextContent(/six-digit hex color/i);
    expect(screen.getByText("#2563EB")).toBeInTheDocument();
  });

  it("trials the chosen palette across the dark workspace and restores it on demand", () => {
    const view = render(<AppearancePreviewDeck />);
    fireEvent.click(screen.getByRole("button", { name: "Use Palette 5 · Coral Terminal" }));
    fireEvent.click(screen.getByRole("button", { name: "Try palette in app" }));
    expect(document.documentElement).toHaveAttribute("data-omnia-preview-palette", "active");
    expect(document.documentElement.style.getPropertyValue("--omnia-session-primary")).toBe("#E76F51");
    expect(screen.getByText("Live colors on · session only")).toBeInTheDocument();

    view.unmount();
    render(<AppearancePreviewDeck />);
    expect(screen.getByRole("button", { name: "Use Palette 5 · Coral Terminal" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: "Stop live preview" }));
    expect(document.documentElement).not.toHaveAttribute("data-omnia-preview-palette");
    expect(screen.getByText("Original app colors")).toBeInTheDocument();
  });

  it("uses the custom accent for the live trial as well as the exported primary role", () => {
    render(<AppearancePreviewDeck />);
    fireEvent.change(screen.getByRole("textbox", { name: "Custom appearance accent hex" }), {
      target: { value: "#22c55e" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Use custom accent" }));
    fireEvent.click(screen.getByRole("button", { name: "Try palette in app" }));
    expect(document.documentElement.style.getPropertyValue("--omnia-session-primary")).toBe("#22C55E");
    fireEvent.click(screen.getByRole("button", { name: "Preview export" }));
    const exportText = within(screen.getByRole("region", { name: "Appearance export preview" })).getByRole("code").textContent ?? "";
    expect(JSON.parse(exportText).preview.roleColors[0]).toBe("#22C55E");
  });

  it("offers style moods and reversible role-color customization", () => {
    render(<AppearancePreviewDeck />);

    fireEvent.change(screen.getByRole("combobox", { name: "Appearance surface contrast" }), {
      target: { value: "ink" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Appearance interface geometry" }), {
      target: { value: "sharp" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Use Terminal appearance mood" }));

    expect(screen.getByRole("combobox", { name: "Appearance surface contrast" })).toHaveValue("ink");
    expect(screen.getByRole("combobox", { name: "Appearance interface geometry" })).toHaveValue("sharp");
    expect(screen.getByRole("combobox", { name: "Appearance signal treatment" })).toHaveValue("edge");

    fireEvent.change(screen.getByLabelText("Primary role color"), {
      target: { value: "#14B8A6" },
    });
    expect(screen.getByRole("status")).toHaveTextContent(/Primary role color updated/i);
    expect(screen.getByRole("button", { name: "Reset role colors" })).not.toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Reset role colors" }));
    expect(screen.getByRole("button", { name: "Reset role colors" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Undo appearance preview change" }));
    expect(screen.getByRole("button", { name: "Reset role colors" })).not.toBeDisabled();
  });

  it("imports a valid Omnia JSON preview without claiming durable settings", async () => {
    render(<AppearancePreviewDeck />);

    const file = new File([
      JSON.stringify({
        schema: "omnia.appearance-preview.v1",
        palette: { id: "palette-5-coral-terminal" },
        preview: {
          logoId: "logo-11-signal-window",
          customAccent: "#14B8A6",
          roleColors: ["#14B8A6", "#2563EB", "#E11D48", "#D97706"],
          energy: "expressive",
          surface: "ink",
          geometry: "sharp",
          signal: "edge",
        },
      }),
    ], "omnia-theme.json", { type: "application/json" });

    fireEvent.change(screen.getByLabelText("Import appearance preview JSON"), {
      target: { files: [file] },
    });

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/Imported an appearance preview/i));
    expect(screen.getByRole("button", { name: "Use Logo 11 · Signal window" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Use Palette 5 · Coral Terminal" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("#14B8A6")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Preview export" }));
    expect(screen.getByText(/does not alter global design tokens/i)).toBeInTheDocument();
  });
});
