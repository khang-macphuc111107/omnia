import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ProjectScopeInheritancePreview } from "./project-scope-inheritance-preview";
import {
  projectPermissionDraftContext,
  resetPermissionSession,
  setPermissionScope,
  updatePermissionValues,
} from "./session-permission-contract";
import type { ConversationView, ProjectView } from "./types";

const project: ProjectView = {
  id: "scope-project",
  name: "Research workspace",
  description: "A project used to inspect scope precedence.",
  accent: "#2563eb",
  instructions: "Prefer evidence-backed answers.",
  modelProfileId: "auto",
  conversationCount: 1,
  contextHealth: "not-compiled",
  pinned: false,
  folders: [{
    id: "scope-folder",
    displayName: "Research files",
    canonicalPath: "C:\\Research",
    state: "referenced",
    scope: "read-only",
    fileCount: null,
    chunkCount: null,
    lastIndexedAt: null,
    localOnly: true,
  }],
};

const conversation: ConversationView = {
  id: "scope-chat",
  activeBranchId: "scope-branch",
  title: "Evidence chat",
  excerpt: "Inspect inherited context.",
  updatedAt: "2026-09-19T00:00:00.000Z",
  updatedLabel: "Today",
  projectId: project.id,
  projectName: project.name,
  pinned: false,
  archived: false,
  hasDraft: false,
  unread: false,
  runState: null,
  draft: "",
  messages: [],
};

describe("ProjectScopeInheritancePreview", () => {
  it("reflects only this Project's renderer draft without treating it as authority", () => {
    const permissionContext = projectPermissionDraftContext(project.id);
    resetPermissionSession(permissionContext);
    // The Project overview consumes the Project scope, not the context's workspace default.
    setPermissionScope("project", permissionContext);
    updatePermissionValues({ "files.read": "deny", "network.public": "allow" }, permissionContext);
    const { rerender } = render(<ProjectScopeInheritancePreview project={project} conversations={[conversation]} />);

    const draft = screen.getByRole("region", { name: "Project permission draft preview" });
    expect(draft).toHaveTextContent("Custom policy");
    expect(draft).toHaveTextContent(/no native grant/i);
    expect(draft).toHaveTextContent("1");

    rerender(<ProjectScopeInheritancePreview project={{ ...project, id: "another-project" }} conversations={[]} />);
    expect(screen.getByRole("region", { name: "Project permission draft preview" })).toHaveTextContent("Balanced");
    resetPermissionSession();
  });

  it("resolves project and chat values, supports reset-to-parent, and keeps edits reversible", () => {
    render(
      <ProjectScopeInheritancePreview
        project={project}
        conversations={[conversation]}
        memories={[]}
        skills={[]}
      />,
    );

    expect(screen.getByRole("heading", { name: "Project scope inheritance" })).toBeInTheDocument();
    expect(screen.getByLabelText("Project scope inheritance precedence chain")).toHaveTextContent(
      "1App defaultInherited→2ProfileInherited→3ProjectEditing→4ChatInherited→5Run / turnInherited",
    );
    expect(screen.getByText("Read-only workspace")).toBeInTheDocument();
    const workspaceField = screen.getByText("Read-only workspace").closest("article");
    expect(workspaceField).not.toBeNull();
    expect(within(workspaceField as HTMLElement).getByText("Inherited · Project")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("combobox", { name: "Inheritance preview edit scope" }), {
      target: { value: "chat" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Model / provider route Chat override" }), {
      target: { value: "Quality first" },
    });

    const modelFieldWithChatOverride = screen.getByText("Model / provider route").closest("article");
    expect(modelFieldWithChatOverride).not.toBeNull();
    expect(within(modelFieldWithChatOverride as HTMLElement).getAllByText("Quality first")[0]).toBeInTheDocument();
    expect(within(modelFieldWithChatOverride as HTMLElement).getByText("Override · Chat")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reset Model / provider route to parent" }));
    const modelField = screen.getByText("Model / provider route").closest("article");
    expect(modelField).not.toBeNull();
    expect(within(modelField as HTMLElement).getByText("Inherited · Profile")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("combobox", { name: "Inheritance preview edit scope" }), {
      target: { value: "run" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Permission preset Run / turn override" }), {
      target: { value: "Lockdown" },
    });
    const permissionsField = screen.getByText("Permission preset").closest("article");
    expect(permissionsField).not.toBeNull();
    expect(within(permissionsField as HTMLElement).getAllByText("Lockdown")[0]).toBeInTheDocument();
    expect(within(permissionsField as HTMLElement).getByText("This run")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Undo scope inheritance preview change" }));
    expect(permissionsField?.querySelector(".project-scope-inheritance__effective strong")).not.toHaveTextContent("Lockdown");
    fireEvent.click(screen.getByRole("button", { name: "Redo scope inheritance preview change" }));
    expect(permissionsField?.querySelector(".project-scope-inheritance__effective strong")).toHaveTextContent("Lockdown");

    fireEvent.click(screen.getByRole("button", { name: "Preview preset" }));
    const preset = screen.getByRole("region", { name: "Project scope inheritance preset preview" });
    expect(within(preset).getByText(/omnia\.project-scope-inheritance-preview\.v1/i)).toBeInTheDocument();
    expect(within(preset).getByText(/no native scope write/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Reset all scope overrides" }));
    expect(permissionsField?.querySelector(".project-scope-inheritance__effective strong")).not.toHaveTextContent("Lockdown");
    expect(screen.getByText(/All scope overrides reset/i)).toBeInTheDocument();
  });

  it("fails closed when Chat scope has no project chat", () => {
    render(<ProjectScopeInheritancePreview project={{ ...project, id: "empty-project", conversationCount: 0 }} conversations={[]} />);

    fireEvent.change(screen.getByRole("combobox", { name: "Inheritance preview edit scope" }), {
      target: { value: "chat" },
    });

    expect(screen.getAllByText(/Select a project chat before editing Chat scope/i).length).toBeGreaterThan(0);
    expect(screen.getByRole("combobox", { name: "Model / provider route Chat override" })).toBeDisabled();
    expect(screen.getByRole("option", { name: "Chat" })).toBeDisabled();
  });
});
