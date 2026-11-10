import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { initialProviders } from "./mock-data";
import { ModelEndpointWorkbench } from "./model-endpoint-workbench";

describe("ModelEndpointWorkbench", () => {
  it("shows a renderer-local endpoint snapshot with explicit boundaries", () => {
    render(<ModelEndpointWorkbench providers={initialProviders} />);

    expect(screen.getByRole("heading", { name: "Model Endpoint Workbench" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Endpoint/i })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("Endpoint base URL")).toHaveValue("https://api.example.invalid/v1");
    expect(screen.getByText(/Preview only · Renderer-local · No provider request/i)).toBeInTheDocument();
  });

  it("keeps operation selection and support level reversible in the preview", () => {
    render(<ModelEndpointWorkbench providers={initialProviders} />);

    fireEvent.click(screen.getByRole("tab", { name: /Operations/i }));
    const images = screen.getByRole("button", { name: /Image generation/i });
    fireEvent.click(images);
    expect(images).toHaveAttribute("aria-pressed", "true");

    fireEvent.change(screen.getByRole("combobox", { name: "Selected operation support level" }), { target: { value: "model-gated" } });
    expect(screen.getByRole("combobox", { name: "Selected operation support level" })).toHaveValue("model-gated");

    fireEvent.click(screen.getByRole("button", { name: "Undo endpoint preview change" }));
    expect(screen.getByRole("combobox", { name: "Selected operation support level" })).toHaveValue("bridge-required");
  });

  it("tracks parameter inheritance and exposes portable evidence export", () => {
    render(<ModelEndpointWorkbench providers={initialProviders} />);

    fireEvent.click(screen.getByRole("tab", { name: /Parameters/i }));
    const temperatureSource = screen.getByRole("combobox", { name: "Temperature source" });
    fireEvent.change(temperatureSource, { target: { value: "request" } });
    expect(temperatureSource).toHaveValue("request");

    fireEvent.click(screen.getByRole("tab", { name: /Evidence & export/i }));
    expect(screen.getByRole("combobox", { name: "Endpoint evidence freshness" })).toHaveValue("unknown");
    expect(screen.getByRole("button", { name: "Copy JSON" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy Markdown" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download" })).toBeInTheDocument();
    expect(within(screen.getByRole("tabpanel")).getByRole("textbox", { name: "Endpoint evidence note" })).toHaveValue("No native capability snapshot is available in the browser preview.");
  });

  it("applies a protocol preset and shows a renderer-only route review", () => {
    render(<ModelEndpointWorkbench providers={initialProviders} />);

    fireEvent.change(screen.getByRole("combobox", { name: "Endpoint preset" }), { target: { value: "google-gemini" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply endpoint preset" }));

    expect(screen.getByRole("combobox", { name: "Endpoint protocol family" })).toHaveValue("google-gemini");
    expect(screen.getByRole("textbox", { name: "Endpoint base URL" })).toHaveValue("https://generativelanguage.googleapis.com/v1beta");
    expect(screen.getByText("Request route preview")).toBeInTheDocument();
    expect(screen.getAllByText(/generateContent/).length).toBeGreaterThan(0);
    expect(screen.getByText(/No provider request · No durable write/i)).toBeInTheDocument();
  });

  it("surfaces endpoint review errors without blocking editable preview fields", () => {
    render(<ModelEndpointWorkbench providers={initialProviders} />);

    fireEvent.change(screen.getByLabelText("Endpoint base URL"), { target: { value: "http://remote.example.test/v1" } });

    expect(screen.getByText("Needs endpoint fixes")).toBeInTheDocument();
    expect(screen.getByText(/Use HTTPS for remote endpoints/i)).toBeInTheDocument();
    expect(screen.getByLabelText("Endpoint base URL")).toHaveValue("http://remote.example.test/v1");
  });
});
