import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import DeliveryEvidenceStatusPreview, { DELIVERY_EVIDENCE_ITEMS } from "./delivery-evidence-status-preview";

describe("DeliveryEvidenceStatusPreview", () => {
  it("shows honest status counts and a selected evidence detail", () => {
    render(<DeliveryEvidenceStatusPreview />);

    expect(screen.getByRole("heading", { name: "Delivery evidence status" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Delivery evidence checks" }).querySelectorAll("[role=\"listitem\"]")).toHaveLength(DELIVERY_EVIDENCE_ITEMS.length);
    expect(screen.getByRole("complementary", { name: "Selected delivery evidence detail" })).toHaveTextContent(/Spec and schema validation/i);
    expect(
      screen.getByRole("note", { name: "Delivery evidence boundary" }),
    ).toHaveTextContent(/Recorded checkpoints are not live command results/i);
  });

  it("filters to attention checks and updates the selected detail", () => {
    render(<DeliveryEvidenceStatusPreview />);

    fireEvent.change(screen.getByRole("combobox", { name: "Filter delivery evidence" }), { target: { value: "attention" } });

    const list = screen.getByRole("list", { name: "Delivery evidence checks" });
    expect(within(list).getByText(/Source ledger/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Spec and schema validation/i })).not.toBeInTheDocument();
    const detail = screen.getByRole("complementary", { name: "Selected delivery evidence detail" });
    expect(detail).toHaveTextContent(/Source ledger|Project Twin projection/i);
  });

  it("supports search and deterministic JSON export for the visible set", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<DeliveryEvidenceStatusPreview />);

    fireEvent.change(screen.getByRole("textbox", { name: "Search delivery evidence" }), { target: { value: "Rust, Tauri" } });
    const list = screen.getByRole("list", { name: "Delivery evidence checks" });
    expect(within(list).getByText(/Rust, Tauri, and provider runtime/i)).toBeInTheDocument();
    const toolbar = screen.getByRole("toolbar", { name: "Delivery evidence filters" });
    expect(within(toolbar).getByLabelText("1 of 7 checks")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Copy/i }));

    return vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(1);
      expect(writeText.mock.calls[0]?.[0]).toContain('"schema": "omnia.delivery-evidence.preview.v1"');
      expect(screen.getByRole("status")).toHaveTextContent(/Copied JSON delivery evidence preview/i);
    });
  });

  it("exports markdown when selected and resets filters without changing the fixture", () => {
    render(<DeliveryEvidenceStatusPreview />);

    fireEvent.change(screen.getByRole("combobox", { name: "Delivery evidence export format" }), { target: { value: "markdown" } });
    expect(screen.getByRole("code")).toHaveTextContent(/# Omnia delivery evidence preview/);
    fireEvent.change(screen.getByRole("textbox", { name: "Search delivery evidence" }), { target: { value: "release" } });
    fireEvent.click(screen.getByRole("button", { name: /Reset view/i }));
    const toolbar = screen.getByRole("toolbar", { name: "Delivery evidence filters" });
    expect(
      within(toolbar).getByLabelText(
        `${DELIVERY_EVIDENCE_ITEMS.length} of ${DELIVERY_EVIDENCE_ITEMS.length} checks`,
      ),
    ).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Delivery evidence export preview" })).getByRole("code")).toHaveTextContent(/Spec and schema validation/);
  });
});
