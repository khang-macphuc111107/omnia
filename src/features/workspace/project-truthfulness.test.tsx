import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { AppRuntimeInfo } from "@/lib/desktop";

import { ProjectDialog } from "./dialogs";
import { initialProjects } from "./mock-data";
import ProjectsScreen from "./activities/projects-screen";
import { useWorkspaceStore } from "./store";

const initialState = useWorkspaceStore.getState();
const runtime: AppRuntimeInfo = {
  appName: "Omnia",
  appVersion: "0.1.0",
  platform: "windows",
  tauri: true,
  debug: true,
};
const browserRuntime: AppRuntimeInfo = { ...runtime, platform: "web", tauri: false };

describe("project preview truthfulness", () => {
  afterEach(() => {
    useWorkspaceStore.setState(initialState, true);
    delete window.__TAURI_INTERNALS__;
    document.body.innerHTML = "";
  });

  it("shows the native project as uncompiled with no enabled skills", () => {
    useWorkspaceStore.setState({
      activeProjectId: "project_native",
      projects: [
        {
          id: "project_native",
          name: "Native project",
          description: "Persisted project metadata",
          accent: "#8b82ff",
          instructions: "Prefer primary sources.",
          modelProfileId: "auto",
          conversationCount: 1,
          contextHealth: "not-compiled",
          pinned: false,
          folders: [
            {
              id: "workspace_native",
              displayName: "Omnia",
              canonicalPath: "C:\\Work\\Omnia",
              state: "referenced",
              scope: "read-only",
              fileCount: null,
              chunkCount: null,
              lastIndexedAt: null,
              localOnly: true,
            },
          ],
        },
      ],
    });

    render(<ProjectsScreen runtime={runtime} />);

    const detail = screen.getByText("Selected project").closest("section");
    expect(detail).not.toBeNull();
    const projectDetail = within(detail!);

    expect(projectDetail.getAllByText("Skills").length).toBeGreaterThan(0);
    expect(projectDetail.getAllByText("Not enabled").length).toBeGreaterThan(0);
    expect(projectDetail.getByText("Context compiler")).toBeInTheDocument();
    expect(projectDetail.getAllByText(/not compiled/i).length).toBeGreaterThan(0);
    expect(projectDetail.getByText(/Not indexed/)).toBeInTheDocument();
    expect(projectDetail.getByText(/read-only grant/)).toBeInTheDocument();
    expect(projectDetail.queryByText("Enabled skills")).not.toBeInTheDocument();
    expect(
      projectDetail.getByText("Context compiler").parentElement?.querySelector(".health-text")
        ?.textContent,
    ).not.toMatch(/^ready$/i);
  });

  it("labels project memory, skills, indexing, and context compilation as planned", () => {
    render(<ProjectDialog onClose={() => undefined} />);

    expect(
      screen.getByText(
        /Memory, skills, indexing, and context compilation are planned\./,
      ),
    ).toBeInTheDocument();
  });

  it("uses truthful project copy when the native project catalog is empty", () => {
    useWorkspaceStore.setState({ activeProjectId: "", projects: [] });

    render(<ProjectsScreen runtime={runtime} />);

    expect(screen.getByRole("heading", { name: "Projects", level: 1 })).toBeInTheDocument();
    expect(
      screen.getByText(/Memory, skills, indexing, and compiled context are not enabled/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/grounded in shared instructions, files, memory, and skills/i)).not.toBeInTheDocument();
  });

  it("does not present seeded browser project data as indexed or compiled", () => {
    useWorkspaceStore.setState({
      activeProjectId: "project-omnia",
      projects: initialProjects,
    });

    render(<ProjectsScreen runtime={browserRuntime} />);

    const detail = screen.getByText("Selected project").closest("section");
    expect(detail).not.toBeNull();
    const projectDetail = within(detail!);
    expect(projectDetail.getAllByText(/not compiled/i).length).toBeGreaterThan(0);
    expect(projectDetail.getByText(/Not indexed/)).toBeInTheDocument();
    expect(projectDetail.queryByText(/184 files/i)).not.toBeInTheDocument();
  });

  it("keeps project detail actions reversible and renderer-local", () => {
    useWorkspaceStore.setState({
      activeProjectId: "project-omnia",
      projects: initialProjects,
    });

    render(<ProjectsScreen runtime={runtime} />);

    const openActions = () =>
      screen.getByRole("button", {
        name: /Open preview actions for Omnia Desktop/i,
      });

    fireEvent.click(openActions());
    const menu = screen.getByRole("menu", {
      name: "Project actions for Omnia Desktop",
    });
    expect(within(menu).getByText(/Renderer-local only · no durable write/i)).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Unpin in preview" })).toBeInTheDocument();

    fireEvent.click(within(menu).getByRole("menuitem", { name: "Rename in preview" }));
    const renameInput = screen.getByRole("textbox", { name: "Rename project in preview" });
    expect(renameInput).toHaveValue("Omnia Desktop");
    fireEvent.change(renameInput, { target: { value: "Omnia Lab" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    expect(screen.getByRole("heading", { level: 2, name: "Omnia Lab" })).toBeInTheDocument();
    const overview = screen.getByRole("heading", { level: 3, name: "Omnia Lab" }).closest("section");
    expect(overview).not.toBeNull();
    expect(within(overview!).getByRole("heading", { level: 3, name: "Omnia Lab" })).toBeInTheDocument();
    expect(within(overview!).getByText("Renderer-local title override")).toBeInTheDocument();
    expect(within(overview!).getByText(/Native overview title remains Omnia Desktop/i)).toBeInTheDocument();
    expect(within(overview!).getByText(/preview-only/i)).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Open preview actions for Omnia Lab" }),
    );
    const renamedMenu = screen.getByRole("menu", { name: "Project actions for Omnia Lab" });
    fireEvent.click(within(renamedMenu).getByRole("menuitem", { name: "Unpin in preview" }));

    fireEvent.click(
      screen.getByRole("button", { name: "Open preview actions for Omnia Lab" }),
    );
    const unpinnedMenu = screen.getByRole("menu", { name: "Project actions for Omnia Lab" });
    expect(within(unpinnedMenu).getByRole("menuitem", { name: "Pin in preview" })).toBeInTheDocument();
    expect(within(unpinnedMenu).getByRole("menuitem", { name: "Reset preview changes" })).not.toBeDisabled();

    fireEvent.click(within(unpinnedMenu).getByRole("menuitem", { name: "Reset preview changes" }));

    expect(screen.getByRole("heading", { level: 2, name: "Omnia Desktop" })).toBeInTheDocument();
    expect(screen.queryByRole("menu", { name: /Project actions/i })).not.toBeInTheDocument();
    fireEvent.click(openActions());
    const resetMenu = screen.getByRole("menu", { name: "Project actions for Omnia Desktop" });
    expect(within(resetMenu).getByRole("menuitem", { name: "Unpin in preview" })).toBeInTheDocument();
    expect(within(resetMenu).getByRole("menuitem", { name: "Reset preview changes" })).toBeDisabled();
  }, 15000);

  it("keeps library project cards at parity with detail actions", () => {
    useWorkspaceStore.setState({
      activeProjectId: "project-omnia",
      projects: initialProjects,
    });

    render(<ProjectsScreen runtime={runtime} />);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Open project library actions for Writing studio",
      }),
    );
    const menu = screen.getByRole("menu", {
      name: "Project library actions for Writing studio",
    });
    expect(within(menu).getByText(/Renderer-local only · no durable write/i)).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Pin in preview" })).toBeInTheDocument();

    fireEvent.click(within(menu).getByRole("menuitem", { name: "Pin in preview" }));
    fireEvent.click(
      screen.getByRole("button", {
        name: "Open project library actions for Writing studio",
      }),
    );
    const pinnedMenu = screen.getByRole("menu", {
      name: "Project library actions for Writing studio",
    });
    expect(within(pinnedMenu).getByRole("menuitem", { name: "Unpin in preview" })).toBeInTheDocument();
    expect(within(pinnedMenu).getByRole("menuitem", { name: "Reset preview changes" })).not.toBeDisabled();
  });

  it("routes workspace-folder actions to the reversible Access preview", () => {
    useWorkspaceStore.setState({
      activeProjectId: "project-omnia",
      projects: initialProjects,
    });

    render(<ProjectsScreen runtime={runtime} />);

    fireEvent.click(screen.getByRole("button", { name: /Open workspace-grant preview actions for Omnia/i }));
    const menu = screen.getByRole("menu", { name: /Workspace-grant preview actions for Omnia/i });
    expect(within(menu).getByText(/no durable write/i)).toBeInTheDocument();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Open Access preview" }));

    expect(screen.getByRole("tab", { name: "Access" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("button", { name: "Add grant in preview" })).toBeInTheDocument();
  });

  it("labels browser-created project metadata as session-only", () => {
    delete window.__TAURI_INTERNALS__;
    render(<ProjectDialog onClose={() => undefined} />);

    expect(screen.getByText("Renderer preview metadata")).toBeInTheDocument();
    expect(screen.getByText("Session-only in this browser preview")).toBeInTheDocument();
    expect(screen.getByText("Renderer mock response; no provider request")).toBeInTheDocument();
    expect(screen.queryByText("Stored on this device")).not.toBeInTheDocument();
  });
});
