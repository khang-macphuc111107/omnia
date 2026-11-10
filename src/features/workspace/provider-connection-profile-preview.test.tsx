import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { initialProviders } from "./mock-data";
import { ProviderConnectionProfilePreview } from "./provider-connection-profile-preview";

describe("ProviderConnectionProfilePreview", () => {
  it("shows reusable profile drafts and keeps secret values out of the renderer", () => {
    render(<ProviderConnectionProfilePreview providers={initialProviders} />);

    expect(screen.getByRole("heading", { name: "Connection profiles" })).toBeInTheDocument();
    expect(screen.getAllByText("Custom lab · Cloud")).not.toHaveLength(0);
    expect(screen.getAllByText("0", { selector: "strong" })).not.toHaveLength(0);
    expect(screen.getByText(/credentials stay opaque/i)).toBeInTheDocument();
    expect(screen.getByText(/No provider request/i)).toBeInTheDocument();
  });

  it("supports duplicate, edit, undo, and local preflight actions", () => {
    render(<ProviderConnectionProfilePreview providers={initialProviders} />);

    fireEvent.click(screen.getByRole("button", { name: "Duplicate profile" }));
    expect(screen.getAllByText(/copy$/i)).not.toHaveLength(0);

    const editor = screen.getByRole("heading", { name: /copy$/i }).closest("section");
    expect(editor).not.toBeNull();
    const nameInput = within(editor!).getByLabelText("Profile name");
    fireEvent.change(nameInput, { target: { value: "Local coding" } });
    expect(nameInput).toHaveValue("Local coding");

    fireEvent.click(within(editor!).getByRole("button", { name: "Undo connection profile change" }));
    expect(within(editor!).getByLabelText("Profile name")).toHaveValue("Custom lab · Cloud copy");

    fireEvent.click(within(editor!).getByRole("button", { name: "Run local preflight" }));
    expect(screen.getByText(/No provider request was sent/i)).toBeInTheDocument();
  });

  it("stages a JSON bundle and exposes portable export actions", () => {
    render(<ProviderConnectionProfilePreview providers={initialProviders} />);

    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    fireEvent.change(screen.getByLabelText(/Paste a profile bundle/i), {
      target: {
        value: JSON.stringify({ profiles: [{ name: "Imported local", endpoint: "http://127.0.0.1:11434/v1" }] }),
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Stage import" }));

    expect(screen.getAllByText("Imported local")).not.toHaveLength(0);
    expect(screen.getByRole("button", { name: "Copy JSON" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy Markdown" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download" })).toBeInTheDocument();
  });
});
