import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import PluginCatalogPreview, { PLUGIN_SEED, serializePluginManifest } from "./plugin-catalog-preview";

describe("Plugin Catalog Preview", () => {
  it("renders a searchable catalog and keeps lifecycle changes renderer-local", () => {
    render(<PluginCatalogPreview />);

    expect(screen.getByRole("heading", { name: "Plugin Catalog" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Plugin catalog" })).toHaveTextContent("Git Workbench");
    expect(screen.getByRole("complementary", { name: "Selected plugin details" })).toHaveTextContent("Declared capabilities");

    fireEvent.change(screen.getByRole("textbox", { name: "Search plugins" }), { target: { value: "citation" } });
    expect(screen.getByRole("list", { name: "Plugin catalog" })).toHaveTextContent("Citation Canvas");
    expect(screen.getByRole("list", { name: "Plugin catalog" })).not.toHaveTextContent("Git Workbench");
  });

  it("supports preview lifecycle, favorites, and configuration rehearsal", () => {
    render(<PluginCatalogPreview />);

    const list = screen.getByRole("list", { name: "Plugin catalog" });
    fireEvent.click(within(list).getByText("Command Palette Plus").closest("button")!);
    const detail = screen.getByRole("complementary", { name: "Selected plugin details" });
    fireEvent.click(within(detail).getByRole("button", { name: /install in preview/i }));
    expect(within(detail).getByRole("button", { name: /enable in preview/i })).toBeInTheDocument();
    fireEvent.click(within(detail).getByRole("button", { name: /add favorite/i }));
    expect(within(detail).getByRole("button", { name: /favorited/i })).toBeInTheDocument();
    fireEvent.change(within(detail).getByRole("combobox", { name: "Result limit" }), { target: { value: "20" } });
    expect(within(detail).getByRole("combobox", { name: "Result limit" })).toHaveValue("20");
    expect(screen.getByText(/renderer preview only/i)).toBeInTheDocument();
  });

  it("exports a truthful JSON or Markdown manifest preview", () => {
    const snapshot = {
      records: [...PLUGIN_SEED],
      favorites: [PLUGIN_SEED[0]!.id],
      configValues: Object.fromEntries(PLUGIN_SEED.map((record) => [record.id, Object.fromEntries(record.config.map((field) => [field.key, field.defaultValue]))])),
    };
    expect(serializePluginManifest(snapshot, "json")).toMatch(/omnia\.plugin-catalog-preview\.v1/);
    expect(serializePluginManifest(snapshot, "markdown")).toMatch(/package installation, process loading/i);

    render(<PluginCatalogPreview />);
    fireEvent.click(screen.getByRole("button", { name: "Preview manifest" }));
    const manifest = screen.getByRole("region", { name: "Plugin catalog manifest preview" });
    expect(within(manifest).getByRole("code")).toHaveTextContent(/omnia\.plugin-catalog-preview\.v1/);
    fireEvent.change(within(manifest).getByRole("combobox", { name: "Plugin manifest format" }), { target: { value: "markdown" } });
    expect(within(manifest).getByRole("code")).toHaveTextContent(/# Omnia plugin catalog preview/);
  });
});
