import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ProjectRecord } from "@/lib/desktop";
import { WorkspaceProjects, type WorkspaceProjectPort } from "./workspace-projects";

const project = (id = "p1", name = "Compiler research"): ProjectRecord => ({ id, name, description: null, instructions: null, createdAtMs: 1, updatedAtMs: 1 });
const port = (patch: Partial<WorkspaceProjectPort> = {}): WorkspaceProjectPort => ({ available: true, initialize: async () => undefined, list: async () => [project()], create: async ({ name }) => project("p2", name), ...patch });

describe("native workspace project selection", () => {
  it("keeps browser preview unavailable and never invents a native project", () => {
    const onSelect = vi.fn();
    render(<WorkspaceProjects port={port({ available: false })} selected={null} onSelect={onSelect} />);
    expect(screen.getByLabelText("Context project")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Create project" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(/desktop runtime/i);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("loads native records then selects only after an explicit choice", async () => {
    const onSelect = vi.fn();
    render(<WorkspaceProjects port={port()} selected={null} onSelect={onSelect} />);
    await screen.findByRole("option", { name: "Compiler research" });
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Context project"), { target: { value: "p1" } });
    expect(onSelect).toHaveBeenCalledWith(project());
  });

  it("creates one durable native project from a valid explicit submit", async () => {
    const onSelect = vi.fn(); const create = vi.fn(async ({ name }: { name: string }) => project("p2", name));
    render(<WorkspaceProjects port={port({ create })} selected={null} onSelect={onSelect} />);
    await screen.findByRole("option", { name: "Compiler research" });
    fireEvent.change(screen.getByLabelText("New project name"), { target: { value: "  RAG experiments  " } });
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith(project("p2", "RAG experiments")));
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({ name: "RAG experiments" });
  });

  it("preserves unknown create outcomes and requires reload before another create", async () => {
    const create = vi.fn(async () => { throw new Error("Transport disconnected"); });
    const adapter = port({ create });
    render(<WorkspaceProjects port={adapter} selected={null} onSelect={vi.fn()} />);
    await screen.findByRole("option", { name: "Compiler research" });
    fireEvent.change(screen.getByLabelText("New project name"), { target: { value: "Do not duplicate" } });
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/outcome is unknown/i);
    expect(screen.getByRole("button", { name: "Create project" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Reload projects" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Create project" })).toBeEnabled());
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("rejects a malformed native record rather than offering a false scope", async () => {
    render(<WorkspaceProjects port={port({ list: async () => [{ ...project(), id: "" }] })} selected={null} onSelect={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/invalid native project/i);
    expect(screen.queryByRole("option", { name: "Compiler research" })).not.toBeInTheDocument();
  });

  it("ignores a stale list after its adapter changes", async () => {
    let release!: (value: ProjectRecord[]) => void;
    const pending = new Promise<ProjectRecord[]>(resolve => { release = resolve; });
    const view = render(<WorkspaceProjects port={port({ list: () => pending })} selected={null} onSelect={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/loading/i));
    view.rerender(<WorkspaceProjects port={port({ list: async () => [project("p2", "Current")] })} selected={null} onSelect={vi.fn()} />);
    await screen.findByRole("option", { name: "Current" });
    release([project("old", "Stale")]);
    await waitFor(() => expect(screen.queryByRole("option", { name: "Stale" })).not.toBeInTheDocument());
  });

  it("does not select a project when an old create finishes after the panel is closed", async () => {
    let release!: (value: ProjectRecord) => void;
    const onSelect = vi.fn();
    const pending = new Promise<ProjectRecord>(resolve => { release = resolve; });
    const view = render(<WorkspaceProjects port={port({ create: () => pending })} selected={null} onSelect={onSelect} />);
    await screen.findByRole("option", { name: "Compiler research" });
    fireEvent.change(screen.getByLabelText("New project name"), { target: { value: "Late native response" } });
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));
    view.unmount(); release(project("late", "Late native response"));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(onSelect).not.toHaveBeenCalled();
  });
});
