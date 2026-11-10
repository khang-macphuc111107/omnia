import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ThemeLabPreview } from "./theme-lab-preview";

describe("ThemeLabPreview", () => {
  it("renders contrast cards and keeps simulation renderer-local", () => {
    render(<ThemeLabPreview roleColors={["#2563EB", "#0F766E", "#D97706", "#E11D48"]} surface="graphite" />);

    expect(screen.getByRole("heading", { name: /Check the spectrum before you ship the look/i })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Theme Lab vision simulation" })).toHaveValue("default");
    expect(screen.getByText(/Renderer-local heuristic and simulated vision preview/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Contrast/)).toHaveLength(4);
  });

  it("updates the selected vision simulation without mutating the supplied palette", () => {
    render(<ThemeLabPreview roleColors={["#2563EB", "#0F766E", "#D97706", "#E11D48"]} surface="slate" />);

    fireEvent.change(screen.getByRole("combobox", { name: "Theme Lab vision simulation" }), {
      target: { value: "deuteranopia" },
    });

    expect(screen.getByRole("combobox", { name: "Theme Lab vision simulation" })).toHaveValue("deuteranopia");
    expect(screen.getByText(/Deuteranopia simulation.*Slate surface/i)).toBeInTheDocument();
    expect(screen.getByText(/does not certify every component state/i)).toBeInTheDocument();
  });
});
