import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import ExtensionsMcpHub, { EXTENSION_SEED, parseExtensionManifest, serializeExtensionManifest } from "./extensions-mcp-hub";
import {
  buildExtensionPermissionReviewItems,
  classifyExtensionPermissionRisk,
  createExtensionPermissionReviewExport,
  defaultExtensionPermissionReview,
  normalizeExtensionPermissionReview,
  serializeExtensionPermissionReview,
} from "./extensions-mcp-permission-review-contract";

function seedSnapshot() {
  return {
    records: EXTENSION_SEED.slice(0, 2).map((record) => ({
      ...record,
      capabilities: [...record.capabilities],
      effects: [...record.effects],
      tools: [...record.tools],
      dependencies: [...record.dependencies],
    })),
    grants: {
      [`${EXTENSION_SEED[0]!.id}:${EXTENSION_SEED[0]!.capabilities[0]!}`]: "Allow" as const,
      [`${EXTENSION_SEED[1]!.id}:${EXTENSION_SEED[1]!.capabilities[0]!}`]: "Ask every time" as const,
    },
  };
}

describe("Extensions & MCP Hub preview", () => {
  it("renders catalog, filters integrations, and keeps lifecycle changes renderer-local", () => {
    render(<ExtensionsMcpHub />);

    expect(screen.getByRole("heading", { name: "Extensions & MCP Hub" })).toBeInTheDocument();
    const stats = screen.getByRole("status", { name: "Extension registry summary" });
    expect(within(stats).getAllByText("2", { selector: "strong" }).length).toBeGreaterThan(0);

    fireEvent.change(screen.getByRole("textbox", { name: "Search extensions" }), { target: { value: "TypeScript" } });
    const typescriptCard = screen.getByText("TypeScript Language Service").closest("button");
    expect(typescriptCard).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Extension catalog" })).queryByText("Workspace Files (read-only)")).not.toBeInTheDocument();

    fireEvent.click(typescriptCard!);
    fireEvent.click(screen.getByRole("button", { name: "Install in preview" }));
    expect(screen.getByText(/native install\/trust\/enable did not run/i)).toBeInTheDocument();
    expect(screen.getByText("Installed", { selector: "em" })).toBeInTheDocument();
  });

  it("exposes grants, lifecycle gates, and a portable manifest preview", () => {
    render(<ExtensionsMcpHub />);

    fireEvent.click(screen.getByRole("tab", { name: "Capability grants" }));
    const grantsPanel = screen.getByRole("tabpanel");
    expect(within(grantsPanel).getByRole("heading", { name: /Review each declared effect/i })).toBeInTheDocument();
    const grantButton = within(grantsPanel).getAllByRole("button", { name: /workspace\.read/i })[0]!;
    fireEvent.click(grantButton);
    expect(grantButton).toHaveTextContent(/Allow|Ask every time|Deny/);

    fireEvent.click(screen.getByRole("tab", { name: "Lifecycle" }));
    expect(screen.getByText("Every integration advances through explicit gates")).toBeInTheDocument();
    expect(screen.getByRole("tabpanel")).toHaveTextContent(/Native package verification, process isolation, approval receipts, cancellation, crash recovery, and durable state are not connected/i);

    fireEvent.click(screen.getByRole("button", { name: "Preview manifest" }));
    const manifest = screen.getByRole("region", { name: "Extension registry manifest preview" });
    expect(within(manifest).getByRole("code")).toHaveTextContent(/omnia\.extensions-mcp-hub-preview\.v1/);
    fireEvent.change(within(manifest).getByRole("combobox", { name: "Extension manifest format" }), { target: { value: "markdown" } });
    expect(within(manifest).getByRole("code")).toHaveTextContent(/# Omnia Extensions & MCP Hub preview/);
    expect(within(manifest).getByText(/does not install packages/i)).toBeInTheDocument();
  });

  it("round-trips exported JSON and rejects malformed manifests", () => {
    const raw = serializeExtensionManifest(seedSnapshot(), "json");
    const parsed = parseExtensionManifest(raw);
    expect(parsed?.records).toHaveLength(2);
    expect(parsed?.records[0]).toMatchObject({ id: EXTENSION_SEED[0]!.id, name: EXTENSION_SEED[0]!.name });
    expect(parsed?.grants[`${EXTENSION_SEED[0]!.id}:${EXTENSION_SEED[0]!.capabilities[0]!}`]).toBe("Allow");
    expect(parseExtensionManifest("{}")) .toBeNull();
    expect(parseExtensionManifest("not-json")).toBeNull();
  });

  it("imports a selected JSON manifest into the reversible preview", async () => {
    render(<ExtensionsMcpHub />);
    const importedRecord = { ...EXTENSION_SEED[2]!, id: "imported-git", name: "Imported Git Insights" };
    const raw = serializeExtensionManifest({ records: [importedRecord], grants: {} }, "json");
    const file = new File([raw], "omnia-extensions.json", { type: "application/json" });

    fireEvent.change(screen.getByLabelText("Import extension manifest JSON"), { target: { files: [file] } });
    await waitFor(() => expect(screen.getByText(/Imported 1 extension record into the renderer preview/i)).toBeInTheDocument());
    expect(screen.getByRole("heading", { name: "Imported Git Insights" })).toBeInTheDocument();
    expect(screen.getByText(/no native activation ran/i)).toBeInTheDocument();
  });

  it("keeps MCP tool-call rehearsal renderer-local and validates object drafts", () => {
    render(<ExtensionsMcpHub />);
    fireEvent.click(screen.getByRole("tab", { name: "MCP inspector" }));

    expect(screen.getByRole("region", { name: "MCP tool call rehearsal" })).toBeInTheDocument();
    const args = screen.getByRole("textbox", { name: "MCP tool arguments JSON" });
    const validate = screen.getByRole("button", { name: /Validate draft/i });

    fireEvent.change(args, { target: { value: "not-json" } });
    fireEvent.click(validate);
    expect(screen.getByText(/Draft JSON is invalid; no MCP call was sent/i)).toBeInTheDocument();

    fireEvent.change(args, { target: { value: '[1, 2]' } });
    fireEvent.click(validate);
    expect(screen.getByText(/must be a JSON object; no MCP call was sent/i)).toBeInTheDocument();

    fireEvent.change(args, { target: { value: '{"path":"README.md"}' } });
    fireEvent.click(validate);
    expect(screen.getByText(/draft is valid JSON; no MCP call was sent/i)).toBeInTheDocument();
  });

  it("filters capability grants and applies reversible renderer-local presets", () => {
    render(<ExtensionsMcpHub />);
    fireEvent.click(screen.getByRole("tab", { name: "Capability grants" }));

    expect(screen.getByRole("textbox", { name: "Search capability grants" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Search capability grants" }), { target: { value: "workspace.write" } });
    expect(screen.getByRole("button", { name: /workspace\.write/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /workspace\.read/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Deny all/i }));
    expect(screen.getByText(/Applied the Deny all capability preset/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /workspace\.write/i })).toHaveTextContent("Deny");

    fireEvent.change(screen.getByRole("combobox", { name: "Filter capability grant mode" }), { target: { value: "Allow" } });
    expect(screen.getByText(/No capability matches/i)).toBeInTheDocument();

    fireEvent.change(screen.getByRole("combobox", { name: "Capability grant preset" }), { target: { value: "ask-all" } });
    expect(screen.getByText(/Applied the Ask every time capability preset/i)).toBeInTheDocument();
  });

  it("provides per-capability risk, scope, expiry, rationale, and reversible review actions", () => {
    render(<ExtensionsMcpHub />);
    fireEvent.click(screen.getByRole("tab", { name: "Permission review" }));

    expect(screen.getByRole("heading", { name: /Review risk, scope, and expiry/i })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "High or critical risk" })).toBeInTheDocument();
    const detail = screen.getByRole("complementary", { name: "Selected permission review details" });
    expect(within(detail).getByRole("combobox", { name: "Selected permission scope" })).toBeInTheDocument();
    expect(within(detail).getByRole("combobox", { name: "Selected permission expiry" })).toBeInTheDocument();

    fireEvent.change(within(detail).getByRole("combobox", { name: "Selected permission scope" }), { target: { value: "conversation" } });
    fireEvent.change(within(detail).getByRole("textbox", { name: "Selected permission rationale" }), { target: { value: "Only needed for this chat." } });
    fireEvent.click(within(detail).getByRole("button", { name: "Mark reviewed" }));
    expect(screen.getByText(/1\/12 reviewed/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Undo extension registry preview change" }));
    expect(screen.getByText(/0\/12 reviewed/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Preview review export" }));
    const reviewExport = screen.getByRole("region", { name: "Permission review export preview" });
    expect(within(reviewExport).getByRole("code")).toHaveTextContent(/omnia\.extensions-mcp-permission-review\.preview\.v1/);
    expect(within(reviewExport).getByText(/no native grant/i)).toBeInTheDocument();
  });

  it("classifies high-impact permission requests conservatively and bounds review imports", () => {
    expect(classifyExtensionPermissionRisk("workspace.write")).toBe("high");
    expect(classifyExtensionPermissionRisk("shell.execute")).toBe("critical");
    expect(classifyExtensionPermissionRisk("workspace.read")).toBe("medium");
    const risk = classifyExtensionPermissionRisk("workspace.write");
    const fallback = defaultExtensionPermissionReview(risk);
    expect(fallback).toMatchObject({ scope: "operation", expiry: "operation", state: "needs-review" });
    expect(normalizeExtensionPermissionReview({ scope: "workspace", expiry: "manual", rationale: "x".repeat(500), state: "reviewed" }, fallback).rationale).toHaveLength(300);

    const items = buildExtensionPermissionReviewItems([{ extensionId: "sample", extensionName: "Sample", kind: "Plugin", lifecycle: "Installed", trust: "Unreviewed", capability: "workspace.write", effects: ["Can propose patches"], grant: "Deny" }]);
    expect(createExtensionPermissionReviewExport(items, "2026-09-24T00:00:00.000Z")).toMatchObject({ scope: "renderer-session", items: [{ risk: "high", review: { state: "needs-review" } }] });
    expect(serializeExtensionPermissionReview(items, "markdown", "2026-09-24T00:00:00.000Z")).toMatch(/permission review preview/);
  });

  it("filters catalog by trust and update state, then resets the filter draft", () => {
    render(<ExtensionsMcpHub />);
    const catalog = () => screen.getByRole("list", { name: "Extension catalog" });
    fireEvent.change(screen.getByRole("combobox", { name: "Filter extension trust" }), { target: { value: "Unreviewed" } });
    expect(within(catalog()).getByText("TypeScript Language Service")).toBeInTheDocument();
    expect(within(catalog()).queryByText("Workspace Files (read-only)")).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("combobox", { name: "Filter extension updates" }), { target: { value: "updates" } });
    expect(within(catalog()).getByText("Markdown Formatter")).toBeInTheDocument();
    expect(within(catalog()).queryByText("TypeScript Language Service")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Reset extension catalog filters" }));
    expect(within(catalog()).getByText("Workspace Files (read-only)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset extension catalog filters" })).toBeDisabled();
  });
});
