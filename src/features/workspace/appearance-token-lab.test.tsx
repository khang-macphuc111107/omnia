import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AppearanceTokenLab } from "./appearance-token-lab";

describe("AppearanceTokenLab", () => {
  it("shows the semantic map and supports family filtering", () => {
    render(<AppearanceTokenLab roleColors={["#23C6B8", "#38BDF8", "#F5B94C", "#FF7A7A"]} surface="graphite" />);

    expect(screen.getByRole("heading", { name: /selected look maps onto a coder-native UI/i })).toBeInTheDocument();
    expect(screen.getByText(/13 of 13 tokens/)).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(13);

    fireEvent.change(screen.getByRole("combobox", { name: "Semantic token family" }), { target: { value: "signals" } });
    expect(screen.getByText(/4 of 13 tokens/)).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(4);
    expect(screen.getByText("--omnia-accent-primary: #23C6B8;")).toBeInTheDocument();
    expect(screen.queryByText("--omnia-surface: #0E1726;")).not.toBeInTheDocument();
  });

  it("reports clipboard boundaries without changing tokens", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<AppearanceTokenLab roleColors={["#23C6B8", "#38BDF8", "#F5B94C", "#FF7A7A"]} surface="ink" />);

    fireEvent.click(screen.getByRole("button", { name: "Copy CSS map" }));
    expect(await screen.findByText(/Copied the renderer-local token proposal/i)).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("--omnia-accent-primary"));
    expect(screen.getByText(/no global token mutation/i)).toBeInTheDocument();
  });
});
