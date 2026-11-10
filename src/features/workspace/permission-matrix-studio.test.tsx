import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { PermissionMatrixStudio } from "./permission-matrix-studio";
import { resetPermissionSession } from "./session-permission-contract";

describe("Permission Matrix Studio preview", () => {
  afterEach(() => resetPermissionSession());

  it("renders all scopes and the seeded capability rows", () => {
    render(<PermissionMatrixStudio />);

    expect(screen.getByRole("heading", { name: "Permission Matrix Studio" })).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Permission scope matrix" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Select Current session permission scope/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Select Current chat permission scope/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Select Current project permission scope/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Select Workspace default permission scope" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("combobox", { name: "Read project files in Workspace default" })).toHaveValue("allow");
    expect(screen.getByText(/renderer-local preview/i)).toBeInTheDocument();
  });

  it("edits a single scope cell and can reveal only split rows", () => {
    render(<PermissionMatrixStudio />);

    const chatNetwork = screen.getByRole("combobox", { name: "Reach public network in Current chat" });
    fireEvent.change(chatNetwork, { target: { value: "allow" } });
    expect(chatNetwork).toHaveValue("allow");
    expect(screen.getByRole("status")).toHaveTextContent(/Current chat.*set to allow/i);

    fireEvent.click(screen.getByRole("checkbox", { name: "Only show differences" }));
    expect(screen.getByRole("combobox", { name: "Reach public network in Current chat" })).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Read project files in Current chat" })).not.toBeInTheDocument();
  });

  it("supports high-risk filtering and preset application across every scope", () => {
    render(<PermissionMatrixStudio />);

    fireEvent.click(screen.getByRole("checkbox", { name: "High-risk only" }));
    expect(screen.getByRole("combobox", { name: "Run terminal commands in Workspace default" })).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Read project files in Workspace default" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Apply Allow all (preview) to every scope" }));
    expect(screen.getByRole("combobox", { name: "Run terminal commands in Workspace default" })).toHaveValue("allow");
    expect(screen.getByRole("combobox", { name: "Control the desktop in Current session" })).toHaveValue("allow");
    expect(screen.getByRole("status")).toHaveTextContent(/applied to every scope/i);
  });

  it("selects an active scope and copies that draft to all scopes", () => {
    render(<PermissionMatrixStudio />);

    fireEvent.change(screen.getByRole("combobox", { name: "Write project files in Current project" }), { target: { value: "allow" } });
    fireEvent.click(screen.getByRole("button", { name: "Select Current project permission scope" }));
    expect(screen.getByRole("button", { name: "Select Current project permission scope" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Copy Current project to all scopes" }));

    expect(screen.getByRole("combobox", { name: "Write project files in Workspace default" })).toHaveValue("allow");
    expect(screen.getByRole("combobox", { name: "Write project files in Current session" })).toHaveValue("allow");
    expect(screen.getByRole("status")).toHaveTextContent(/copied to every scope/i);
  });

  it("resets a changed matrix while keeping the preview boundary visible", () => {
    render(<PermissionMatrixStudio />);

    fireEvent.click(screen.getByRole("button", { name: "Apply Allow all (preview) to every scope" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset matrix" }));
    expect(screen.getByRole("combobox", { name: "Run terminal commands in Workspace default" })).toHaveValue("prompt");
    expect(screen.getByRole("combobox", { name: "Read project files in Workspace default" })).toHaveValue("allow");
    expect(screen.getByText(/do not grant native authority/i)).toBeInTheDocument();
  });
});
