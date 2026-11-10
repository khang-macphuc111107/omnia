import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SignalPreferencesPreview } from "./signal-preferences-preview";

describe("SignalPreferencesPreview", () => {
  it("offers source, ordering, review, and display options with reversible history", () => {
    render(<SignalPreferencesPreview />);

    expect(screen.getByRole("heading", { name: "Tune the signal stream for this session" })).toBeInTheDocument();
    expect(screen.getByText("Preview only")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /Chat/i })).toBeChecked();

    fireEvent.click(screen.getByRole("checkbox", { name: /Notifications/i }));
    expect(screen.getByRole("button", { name: "Undo signal preference change" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Undo signal preference change" }));
    expect(screen.getByRole("checkbox", { name: /Notifications/i })).toBeChecked();

    fireEvent.change(screen.getByRole("combobox", { name: "Signal default filter" }), { target: { value: "attention" } });
    expect(screen.getByRole("combobox", { name: "Signal default filter" })).toHaveValue("attention");
    fireEvent.click(screen.getByRole("button", { name: "Preview export" }));

    const exportRegion = screen.getByRole("region", { name: "Signal preferences export preview" });
    expect(within(exportRegion).getByRole("code")).toHaveTextContent(/omnia\.signal-preferences\.preview\.v1/i);
    fireEvent.change(within(exportRegion).getByRole("combobox", { name: "Signal preferences export format" }), { target: { value: "markdown" } });
    expect(within(exportRegion).getByRole("code")).toHaveTextContent(/Omnia signal preferences preview/i);

    fireEvent.click(within(exportRegion).getByRole("button", { name: "Import preview" }));
    fireEvent.change(within(exportRegion).getByRole("textbox", { name: "Signal preferences import payload" }), {
      target: { value: JSON.stringify({ preferences: { enabledSources: ["chat"], defaultFilter: "unread", compactMode: true } }) },
    });
    fireEvent.click(within(exportRegion).getByRole("button", { name: "Apply import preview" }));
    expect(screen.getByRole("checkbox", { name: /Chat/i })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Notifications/i })).not.toBeChecked();
    expect(screen.getByText(/Imported JSON signal preferences/i)).toBeInTheDocument();
  });

  it("keeps the native boundary visible and resets to defaults", () => {
    render(<SignalPreferencesPreview />);

    fireEvent.click(screen.getByRole("checkbox", { name: "Compact signal cards" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset signal preferences" }));

    expect(screen.getByRole("checkbox", { name: "Compact signal cards" })).not.toBeChecked();
    expect(screen.getByText(/does not persist settings/i)).toBeInTheDocument();
  });

  it("offers reversible voice delivery rehearsal settings without starting speech", () => {
    render(<SignalPreferencesPreview />);

    fireEvent.change(screen.getByRole("combobox", { name: "Signal voice mode" }), { target: { value: "queue-preview" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Signal voice preset" }), { target: { value: "calm" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Signal voice rate" }), { target: { value: "1.2" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Signal voice priority" }), { target: { value: "high-or-urgent" } });

    expect(screen.getByText(/queued for a later voice preview/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Rehearse settings/i }));
    expect(screen.getByRole("status")).toHaveTextContent(/no speech was started/i);
  });
});
