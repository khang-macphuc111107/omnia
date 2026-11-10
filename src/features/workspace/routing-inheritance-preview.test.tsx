import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { initialProviders } from "./mock-data";
import { RoutingInheritancePreview } from "./routing-inheritance-preview";

describe("RoutingInheritancePreview", () => {
  it("resolves the nearest explicit project and chat override", () => {
    render(
      <RoutingInheritancePreview
        providers={initialProviders}
        modelProfileId="auto"
        onModelProfileChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: "Route inheritance" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: /Effective route: Automatic/i })).toBeInTheDocument();

    fireEvent.change(screen.getByRole("combobox", { name: "Inheritance preview project" }), {
      target: { value: "project-research" },
    });
    expect(screen.getByRole("status", { name: /Effective route: Orion Long Context/i })).toBeInTheDocument();
    expect(screen.getByText(/selected by project override/i)).toBeInTheDocument();

    fireEvent.change(screen.getByRole("combobox", { name: "Profile route override" }), {
      target: { value: "routing-quality" },
    });
    expect(screen.getByRole("status", { name: /Effective route: Orion Long Context/i })).toBeInTheDocument();

    fireEvent.change(screen.getByRole("combobox", { name: "Project route override" }), {
      target: { value: "inherit" },
    });
    expect(screen.getByRole("status", { name: /Effective route: Atlas Reasoning/i })).toBeInTheDocument();
    expect(screen.getByText(/selected by profile preset/i)).toBeInTheDocument();

    fireEvent.change(screen.getByRole("combobox", { name: "Chat route override" }), {
      target: { value: "quality" },
    });
    expect(screen.getByRole("status", { name: /Effective route: Atlas Reasoning/i })).toBeInTheDocument();
    expect(screen.getByText(/selected by chat override/i)).toBeInTheDocument();

    fireEvent.change(screen.getByRole("combobox", { name: "Run or turn route override" }), {
      target: { value: "balanced" },
    });
    expect(screen.getByRole("status", { name: /Effective route: Nova Balanced/i })).toBeInTheDocument();
    expect(screen.getByText(/selected by run\/turn override/i)).toBeInTheDocument();
  });

  it("keeps workspace changes and reset renderer-local", () => {
    const onModelProfileChange = vi.fn();
    render(
      <RoutingInheritancePreview
        providers={initialProviders}
        modelProfileId="auto"
        onModelProfileChange={onModelProfileChange}
      />,
    );

    fireEvent.change(screen.getByRole("combobox", { name: "App default route" }), {
      target: { value: "quality" },
    });
    expect(onModelProfileChange).toHaveBeenCalledWith("quality");
    expect(screen.getByText(/No native project\/chat settings are written/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Reset route inheritance preview" }));
    expect(onModelProfileChange).toHaveBeenCalledWith("auto");
  });

  it("supports resetting one inheritance scope back to its parent", () => {
    render(
      <RoutingInheritancePreview
        providers={initialProviders}
        modelProfileId="auto"
        onModelProfileChange={() => undefined}
      />,
    );

    fireEvent.change(screen.getByRole("combobox", { name: "Project route override" }), {
      target: { value: "quality" },
    });
    expect(screen.getByRole("status", { name: /Effective route: Atlas Reasoning/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Reset project route override" }));
    expect(screen.getByRole("status", { name: /Effective route: Automatic/i })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Project route override" })).toHaveValue("inherit");

    fireEvent.change(screen.getByRole("combobox", { name: "Run or turn route override" }), {
      target: { value: "balanced" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Reset run or turn route override" }));
    expect(screen.getByRole("combobox", { name: "Run or turn route override" })).toHaveValue("inherit");
  });
});
