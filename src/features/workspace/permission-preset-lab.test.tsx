import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PermissionPresetLab } from "./permission-preset-lab";

describe("Permission Preset Lab preview", () => {
  it("stages and revokes an allow-all lifecycle preview", () => {
    render(<PermissionPresetLab />);

    fireEvent.click(screen.getByRole("button", { name: "Select Allow all (preview) permission preset" }));
    expect(screen.getByRole("button", { name: "Select Allow all (preview) permission preset" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Stage preview" }));
    expect(screen.getByRole("status")).toHaveTextContent(/staged for/i);
    expect(screen.getByRole("status")).toHaveTextContent(/No native grant was created/i);
    fireEvent.click(screen.getByRole("button", { name: "Revoke preview" }));
    expect(screen.getByRole("status")).toHaveTextContent(/revoked/i);
  });

  it("supports expiry/quota controls, undo/redo, and export preview", () => {
    render(<PermissionPresetLab />);

    fireEvent.change(screen.getByLabelText("Expiry"), { target: { value: "custom" } });
    expect(screen.getByLabelText("Custom expiry")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Quota"), { target: { value: "daily" } });
    fireEvent.change(screen.getByLabelText("Quota amount"), { target: { value: "12" } });
    expect(screen.getByText("12 actions / day")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Undo permission preset lifecycle change" }));
    expect(screen.getByLabelText("Quota amount")).toHaveValue(100);
    fireEvent.click(screen.getByRole("button", { name: "Redo permission preset lifecycle change" }));
    expect(screen.getByLabelText("Quota amount")).toHaveValue(12);
    expect(screen.getByRole("region", { name: "Lifecycle package" })).toBeInTheDocument();
    expect(screen.getByLabelText("Permission preset lifecycle export")).toBeInTheDocument();
  });

  it("shows a renderer-session history and diff after an edit", () => {
    render(<PermissionPresetLab />);
    fireEvent.change(screen.getByLabelText("Quota"), { target: { value: "daily" } });
    fireEvent.change(screen.getByLabelText("Quota amount"), { target: { value: "12" } });
    const history = screen.getByRole("region", { name: "History & diff" });
    expect(history).toHaveTextContent(/Previous revision/i);
    expect(history).toHaveTextContent(/Quota/i);
    expect(history).toHaveTextContent(/100 → 12/i);
    expect(history).toHaveTextContent(/renderer-session previews only/i);
  });

  it("imports a lifecycle JSON package and keeps the boundary visible", async () => {
    render(<PermissionPresetLab />);
    const snapshot = new File([JSON.stringify({
      scope: "omnia.permission-preset-lab.preview.v1",
      version: 1,
      presetId: "lockdown",
      presetLabel: "Lockdown",
      permissionScope: "session",
      scopeMode: "selected",
      lifecycle: { state: "staged", expiry: "session", customExpiry: "", quota: "per-run", quotaValue: 1, audit: "verbose", revoke: "after-run" },
      note: "imported",
    })], "permission-preset.json", { type: "application/json" });
    fireEvent.change(screen.getByLabelText("Import permission preset lifecycle JSON"), { target: { files: [snapshot] } });
    await waitFor(() => expect(screen.getByText("Lockdown")).toBeInTheDocument());
    expect(screen.getAllByText(/no native grant/i).length).toBeGreaterThan(0);
  });

  it("requires an explicit apply after showing an import diff", async () => {
    render(<PermissionPresetLab />);
    const snapshot = new File([JSON.stringify({
      scope: "omnia.permission-preset-lab.preview.v1",
      version: 1,
      presetId: "research",
      presetLabel: "Research",
      permissionScope: "project",
      scopeMode: "all",
      lifecycle: { state: "staged", expiry: "one-day", customExpiry: "", quota: "daily", quotaValue: 8, audit: "verbose", revoke: "on-expiry" },
      note: "reviewed import",
    })], "permission-preset-review.json", { type: "application/json" });
    fireEvent.change(screen.getByLabelText("Import permission preset lifecycle JSON"), { target: { files: [snapshot] } });
    expect(await screen.findByRole("heading", { name: /Research flow staged/i })).toBeInTheDocument();
    expect(screen.getByText(/Review the incoming lifecycle diff/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Apply imported preview" }));
    expect(screen.getByRole("status")).toHaveTextContent(/import applied/i);
    expect(screen.queryByRole("heading", { name: /Research flow staged/i })).not.toBeInTheDocument();
  });
});
