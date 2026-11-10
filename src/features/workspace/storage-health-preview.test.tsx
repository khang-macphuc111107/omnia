import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { useWorkspaceStore } from "./store";
import { StorageHealthPreview } from "./storage-health-preview";

const initialState = useWorkspaceStore.getState();

describe("Storage health preview", () => {
  afterEach(() => {
    useWorkspaceStore.setState(initialState, true);
    document.body.innerHTML = "";
  });

  it("summarizes renderer-visible inventory and keeps native checks explicit", () => {
    render(<StorageHealthPreview />);

    expect(screen.getByRole("heading", { name: /Storage health & backup preview/i })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Storage health checks" })).toHaveTextContent(/Filesystem usage/i);
    expect(screen.getByRole("list", { name: "Storage health checks" })).toHaveTextContent(/Native database/i);
    expect(screen.getByRole("note", { name: "Storage health preview boundary" })).toHaveTextContent(
      /No filesystem read, disk probe, SQLite query/i,
    );
  });

  it("supports reversible backup-plan choices and generates an inspectable report", () => {
    render(<StorageHealthPreview />);

    fireEvent.change(screen.getByRole("combobox", { name: "Backup cadence preview" }), {
      target: { value: "daily" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Backup retention revisions" }), {
      target: { value: "12" },
    });
    expect(screen.getByRole("status")).toHaveTextContent(/Retention set to 12 revisions/i);

    fireEvent.click(screen.getByRole("button", { name: "Undo storage health preview change" }));
    expect(screen.getByRole("combobox", { name: "Backup retention revisions" })).toHaveValue("5");
    fireEvent.click(screen.getByRole("button", { name: "Redo storage health preview change" }));
    expect(screen.getByRole("combobox", { name: "Backup retention revisions" })).toHaveValue("12");

    fireEvent.click(screen.getByRole("button", { name: "Generate backup plan" }));
    const report = screen.getByRole("region", { name: "Storage health report preview" });
    expect(within(report).getByRole("code")).toHaveTextContent(/omnia\.storage-health-preview\.v1/i);
    expect(within(report).getByText(/Native storage health, backup bytes, restore points/i)).toBeInTheDocument();

    fireEvent.change(within(report).getByRole("combobox", { name: "Storage health report format" }), {
      target: { value: "markdown" },
    });
    expect(within(report).getByRole("code")).toHaveTextContent(/# Omnia storage health preview/i);
    expect(within(report).getByRole("code")).toHaveTextContent(/Daily preview/i);
  });
});
