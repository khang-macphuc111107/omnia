import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ComposerMediaPreview } from "./composer-media-preview";

describe("composer media preview", () => {
  it("exposes image, video, and audio affordances without pretending to ingest files", () => {
    render(<ComposerMediaPreview />);

    expect(screen.getByRole("region", { name: "Media input preview" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Image input preview" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Video input preview" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Audio input preview" })).toBeInTheDocument();
    expect(screen.getByText(/No file is read or uploaded/i)).toBeInTheDocument();
  });

  it("shows removable queued chips for selected media types", () => {
    render(<ComposerMediaPreview />);

    fireEvent.click(screen.getByRole("button", { name: "Image input preview" }));
    fireEvent.click(screen.getByRole("button", { name: "Video input preview" }));

    expect(screen.getByText("Image input")).toBeInTheDocument();
    expect(screen.getByText("Video input")).toBeInTheDocument();
    expect(screen.getAllByText("Queued")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Remove image media preview" }));
    expect(screen.queryByText("Image input")).not.toBeInTheDocument();
    expect(screen.getByText("Video input")).toBeInTheDocument();
  });

  it("keeps controls disabled while the active run owns the composer", () => {
    render(<ComposerMediaPreview disabled />);

    expect(screen.getByRole("button", { name: "Image input preview" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Video input preview" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Audio input preview" })).toBeDisabled();
  });

  it("supports a controlled queue so toolbar affordances can share one selection", () => {
    const selections: string[][] = [];
    const { rerender } = render(
      <ComposerMediaPreview
        selectedKinds={[]}
        onSelectionChange={(next) => selections.push(next)}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Image input preview" }));
    expect(selections).toEqual([["image"]]);

    rerender(
      <ComposerMediaPreview
        selectedKinds={["image"]}
        onSelectionChange={(next) => selections.push(next)}
      />,
    );
    expect(screen.getByText("Image input")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Remove image media preview" }));
    expect(selections).toEqual([["image"], []]);
  });
});
