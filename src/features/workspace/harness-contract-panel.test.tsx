import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { HarnessContractPanel } from "./harness-contract-panel";

describe("HarnessContractPanel", () => {
  it("renders contract slices with explicit preview boundaries", () => {
    render(<HarnessContractPanel />);

    expect(screen.getByRole("heading", { name: "Make the harness boundary inspectable" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Harness contract slices" })).toHaveTextContent("Run intent and freeze");
    expect(screen.getByRole("list", { name: "Harness contract slices" })).toHaveTextContent("Agent identity and lineage");
    expect(screen.getByRole("region", { name: "Make the harness boundary inspectable" })).toHaveTextContent("Renderer-local contract map");
    const summary = screen.getByLabelText("Harness contract summary");
    expect(within(summary).getByText("0")).toBeInTheDocument();
    expect(within(summary).getByText("native grants here")).toBeInTheDocument();
  });

  it("filters the catalog and exposes a selected contract's evidence gaps", () => {
    render(<HarnessContractPanel />);

    fireEvent.change(screen.getByRole("combobox", { name: "Harness contract domain" }), { target: { value: "Agents" } });
    const list = screen.getByRole("list", { name: "Harness contract slices" });
    expect(within(list).getByRole("button", { name: /Agent identity and lineage\. Planned/i })).toBeInTheDocument();
    expect(within(list).queryByRole("button", { name: /Run intent and freeze/i })).not.toBeInTheDocument();

    fireEvent.click(within(list).getByRole("button", { name: /Agent identity and lineage\. Planned/i }));
    const detail = screen.getByRole("complementary", { name: "Selected harness contract" });
    expect(detail).toHaveTextContent("Native scheduler");
    expect(detail).toHaveTextContent("Durable mailbox");
    expect(detail).toHaveTextContent("Admit one typed native identity/lease slice");
  });

  it("previews a portable contract export without claiming native writes", () => {
    render(<HarnessContractPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Preview contract" }));
    const exportRegion = screen.getByRole("region", { name: "Selected harness contract export preview" });
    expect(exportRegion).toHaveTextContent('"schema": "omnia.harness-contract.preview.v1"');
    expect(exportRegion).toHaveTextContent("No native authority, provider dispatch, tool grant, or durable write");

    fireEvent.change(within(exportRegion).getByRole("combobox", { name: "Harness contract export format" }), { target: { value: "markdown" } });
    expect(exportRegion).toHaveTextContent("# Run intent and freeze");
    expect(exportRegion).toHaveTextContent("Renderer-local contract preview");
  });
});
