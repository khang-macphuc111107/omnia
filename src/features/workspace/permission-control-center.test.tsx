import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { PermissionControlCenter } from "./permission-control-center";
import { resetPermissionSession } from "./session-permission-contract";

describe("Permission Control Center preview", () => {
  afterEach(() => resetPermissionSession());

  it("renders many capability rows and keeps Allow all explicitly renderer-local", () => {
    render(<PermissionControlCenter />);

    expect(screen.getByRole("heading", { name: "Permission Control Center" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Apply Allow all (preview) preset" })).toBeInTheDocument();
    expect(screen.getByText(/never grants native authority/i)).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Read project files permission mode" })).toHaveValue("allow");
    expect(screen.getByRole("combobox", { name: "Run terminal commands permission mode" })).toHaveValue("prompt");

    fireEvent.click(screen.getByRole("button", { name: "Apply Allow all (preview) preset" }));
    expect(screen.getByRole("combobox", { name: "Run terminal commands permission mode" })).toHaveValue("allow");
    expect(screen.getByRole("status")).toHaveTextContent(/renderer-only preview/i);

    fireEvent.click(screen.getByRole("button", { name: "Reset all" }));
    expect(screen.getByRole("combobox", { name: "Run terminal commands permission mode" })).toHaveValue("prompt");
    expect(screen.getByRole("status")).toHaveTextContent(/all permission scopes reset/i);

    fireEvent.click(screen.getByRole("button", { name: /Current project/i }));
    expect(screen.getByRole("combobox", { name: "Permission preview scope" })).toHaveValue("project");
  });

  it("exposes an explicit Allow all quick action for the active scope and every scope", () => {
    render(<PermissionControlCenter />);

    expect(screen.getByRole("heading", { name: "Allow all capabilities" })).toBeInTheDocument();
    expect(screen.getByText("14", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Allow all in Workspace default" })).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(screen.getByRole("button", { name: "Allow all in Workspace default" }));
    expect(screen.getByRole("button", { name: "Allow all in Workspace default" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("combobox", { name: "Run terminal commands permission mode" })).toHaveValue("allow");

    fireEvent.click(screen.getByRole("button", { name: "Allow all in every scope" }));
    expect(screen.getByRole("button", { name: "Allow all in every scope" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: /Current project/i }));
    expect(screen.getByRole("combobox", { name: "Run terminal commands permission mode" })).toHaveValue("allow");
  });

  it("marks the active preset and can preview it across every scope", () => {
    render(<PermissionControlCenter />);

    expect(screen.getByRole("button", { name: "Apply Balanced preset" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Apply Allow all (preview) preset to all permission scopes" }));

    expect(screen.getByRole("button", { name: "Apply Allow all (preview) preset" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("combobox", { name: "Run terminal commands permission mode" })).toHaveValue("allow");
    expect(screen.getByRole("status")).toHaveTextContent(/every permission scope/i);

    fireEvent.click(screen.getByRole("button", { name: /Current project/i }));
    expect(screen.getByRole("combobox", { name: "Run terminal commands permission mode" })).toHaveValue("allow");
  });

  it("filters capabilities and provides reversible per-row edits", () => {
    render(<PermissionControlCenter />);

    fireEvent.change(screen.getByRole("textbox", { name: "Search permission capabilities" }), { target: { value: "terminal" } });
    expect(screen.getByText("Run terminal commands")).toBeInTheDocument();
    expect(screen.queryByText("Read project files")).not.toBeInTheDocument();

    const terminalMode = screen.getByRole("combobox", { name: "Run terminal commands permission mode" });
    fireEvent.change(terminalMode, { target: { value: "allow" } });
    expect(terminalMode).toHaveValue("allow");
    fireEvent.click(screen.getByRole("button", { name: "Undo permission preview change" }));
    expect(terminalMode).toHaveValue("prompt");
    fireEvent.click(screen.getByRole("button", { name: "Redo permission preview change" }));
    expect(terminalMode).toHaveValue("allow");
  });

  it("reviews a narrower scope that proposes a more-permissive capability", () => {
    render(<PermissionControlCenter />);

    fireEvent.click(screen.getByRole("button", { name: /Current project/i }));
    fireEvent.change(screen.getByRole("combobox", { name: "Run terminal commands permission mode" }), { target: { value: "allow" } });

    expect(screen.getByRole("heading", { name: "Scope-expansion review" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Current project permission scope expansions" })).toHaveTextContent("Run terminal commands");
    expect(screen.getByText(/not an effective policy calculation or approval/i)).toBeInTheDocument();
  });

  it("shows the latest renderer-local permission history diff with risk signals", () => {
    render(<PermissionControlCenter />);

    fireEvent.change(screen.getByRole("combobox", { name: "Run terminal commands permission mode" }), { target: { value: "allow" } });

    expect(screen.getByRole("heading", { name: "Permission history diff" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Latest permission history diff" })).toHaveTextContent("Run terminal commands");
    expect(screen.getAllByText(/high-risk increases/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/need individual review before any future native promotion/i)).toBeInTheDocument();
  });

  it("triages the latest permission revision with pending and high-risk filters", () => {
    render(<PermissionControlCenter />);
    fireEvent.change(screen.getByRole("combobox", { name: "Run terminal commands permission mode" }), { target: { value: "allow" } });

    expect(screen.getByRole("heading", { name: "Permission review queue" })).toBeInTheDocument();
    expect(screen.getByText("1 pending · 1 changes in latest revision")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Permission changes to review" })).toHaveTextContent("Run terminal commands");

    fireEvent.click(screen.getByRole("button", { name: "Mark reviewed: Run terminal commands" }));
    expect(screen.getByText("0 pending · 1 changes in latest revision")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Pending review" }));
    expect(screen.getByText(/every change in the latest revision has been marked reviewed/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "All changes" }));
    fireEvent.click(screen.getByRole("button", { name: "Reopen: Run terminal commands" }));
    expect(screen.getByText("1 pending · 1 changes in latest revision")).toBeInTheDocument();
  });

  it("replaces the review queue when a new permission revision is created", () => {
    render(<PermissionControlCenter />);
    fireEvent.change(screen.getByRole("combobox", { name: "Run terminal commands permission mode" }), { target: { value: "allow" } });
    fireEvent.click(screen.getByRole("button", { name: "Mark reviewed: Run terminal commands" }));

    fireEvent.change(screen.getByRole("combobox", { name: "Write project files permission mode" }), { target: { value: "allow" } });

    expect(screen.getByText("1 pending · 1 changes in latest revision")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Permission changes to review" })).toHaveTextContent("Write project files");
    expect(screen.getByRole("list", { name: "Permission changes to review" })).not.toHaveTextContent("Run terminal commands");
    expect(screen.getByRole("button", { name: "Mark reviewed: Write project files" })).toBeInTheDocument();
  });

  it("imports a permission preview JSON bundle and changes its scope", async () => {
    render(<PermissionControlCenter />);
    const permissions = Object.fromEntries(
      [
        "files.read", "files.write", "files.delete", "network.public", "network.local", "execution.terminal", "execution.process", "desktop.browser", "desktop.computer", "media.microphone", "media.camera", "secrets.read", "workspace.index", "workspace.export",
      ].map((id) => [id, "deny"]),
    );
    const snapshot = new File([
      JSON.stringify({ scope: "renderer-permission-preview", version: 1, permissionScope: "project", permissions }),
    ], "omnia-permissions.json", { type: "application/json" });

    fireEvent.change(screen.getByLabelText("Import permission preview JSON"), { target: { files: [snapshot] } });
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Permission preview scope" })).toHaveValue("project"));
    expect(screen.getByRole("combobox", { name: "Read project files permission mode" })).toHaveValue("deny");
    expect(screen.getByRole("status")).toHaveTextContent(/permission preview JSON imported/i);
  });

  it("imports matching values into the bundle scope instead of skipping against the previously active scope", async () => {
    render(<PermissionControlCenter />);
    fireEvent.click(screen.getByRole("button", { name: "Apply Lockdown preset" }));
    const permissions = Object.fromEntries(
      [
        "files.read", "files.write", "files.delete", "network.public", "network.local", "execution.terminal", "execution.process", "desktop.browser", "desktop.computer", "media.microphone", "media.camera", "secrets.read", "workspace.index", "workspace.export",
      ].map((id) => [id, "deny"]),
    );
    const snapshot = new File([
      JSON.stringify({ scope: "renderer-permission-preview", version: 1, permissionScope: "project", permissions }),
    ], "omnia-project-permissions.json", { type: "application/json" });

    fireEvent.change(screen.getByLabelText("Import permission preview JSON"), { target: { files: [snapshot] } });

    await waitFor(() => expect(screen.getByRole("combobox", { name: "Permission preview scope" })).toHaveValue("project"));
    expect(screen.getByRole("combobox", { name: "Run terminal commands permission mode" })).toHaveValue("deny");
    expect(screen.getByRole("status")).toHaveTextContent(/imported into Current project/i);

    fireEvent.change(screen.getByRole("combobox", { name: "Permission preview scope" }), { target: { value: "workspace" } });
    expect(screen.getByRole("combobox", { name: "Run terminal commands permission mode" })).toHaveValue("deny");
    fireEvent.change(screen.getByRole("combobox", { name: "Permission preview scope" }), { target: { value: "project" } });
    expect(screen.getByRole("combobox", { name: "Run terminal commands permission mode" })).toHaveValue("deny");
  });

  it("keeps simultaneous Project settings permission drafts isolated by project id", () => {
    const view = render(
      <>
        <PermissionControlCenter projectId="project-alpha" />
        <PermissionControlCenter projectId="project-beta" />
      </>,
    );
    const terminalModes = screen.getAllByRole("combobox", { name: "Run terminal commands permission mode" });
    expect(terminalModes).toHaveLength(2);
    expect(terminalModes[0]).toHaveValue("prompt");
    expect(terminalModes[1]).toHaveValue("prompt");

    fireEvent.change(terminalModes[0]!, { target: { value: "allow" } });

    expect(terminalModes[0]).toHaveValue("allow");
    expect(terminalModes[1]).toHaveValue("prompt");
    expect(screen.getAllByText("Project draft · session-only")).toHaveLength(2);

    view.unmount();
    render(<PermissionControlCenter projectId="project-alpha" />);
    expect(screen.getByRole("combobox", { name: "Run terminal commands permission mode" })).toHaveValue("allow");
  });
});
