import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MediaGenerationStudio } from "./media-generation-studio";

describe("Media capability preview", () => {
  it("keeps the selected image capability catalog read-only and truthful", () => {
    render(<MediaGenerationStudio />);

    const capability = screen.getByRole("region", { name: "Media capability preview" });
    expect(within(capability).getByRole("heading", { name: "Capability & constraints" })).toBeInTheDocument();
    expect(within(capability).getByText("Not observed")).toBeInTheDocument();
    expect(within(capability).getByRole("table", { name: "Image operation capability rehearsal" })).toBeInTheDocument();
    expect(within(capability).getByText("Text to image")).toBeInTheDocument();
    expect(within(capability).getByText("Authorized overlay cleanup")).toBeInTheDocument();
    expect(within(capability).getByText(/No endpoint probe, upload, secret lookup/i)).toBeInTheDocument();
  });

  it("follows the selected modality without claiming provider support", () => {
    render(<MediaGenerationStudio />);

    fireEvent.click(screen.getByRole("tab", { name: /Video Motion studies/i }));
    let capability = screen.getByRole("region", { name: "Media capability preview" });
    expect(within(capability).getByText("Text to video")).toBeInTheDocument();
    expect(within(capability).getByText("Storyboard / shots")).toBeInTheDocument();
    expect(within(capability).queryByText("Text to image")).not.toBeInTheDocument();
    expect(within(capability).getByText("Omnia preview route")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /Audio Voice & sound/i }));
    capability = screen.getByRole("region", { name: "Media capability preview" });
    expect(within(capability).getByText("Audio compose")).toBeInTheDocument();
    expect(within(capability).getByText("Renderer extension")).toBeInTheDocument();
    expect(within(capability).queryByText("Text to video")).not.toBeInTheDocument();
  });
});
