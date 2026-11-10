import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { CommandPalette } from "./command-palette";
import { useWorkspaceStore } from "./store";

const initialState = useWorkspaceStore.getState();

describe("command center object scopes", () => {
  afterEach(() => {
    useWorkspaceStore.setState(initialState, true);
    document.body.innerHTML = "";
  });

  it("searches renderer-visible memory and library records from Ctrl+K", () => {
    useWorkspaceStore.setState({
      commandPaletteOpen: true,
      memories: [{
        id: "memory-command-center",
        title: "Prefer fast smoke checks",
        content: "Keep UI feedback fast and let the user test the browser preview.",
        scopeLabel: "Workspace",
        kind: "preference",
        status: "active",
        origin: "explicit",
        confidence: 0.95,
        sourceLabel: "User note",
        lastUsedLabel: "Today",
      }],
      artifacts: [{
        id: "artifact-command-center",
        name: "research-notes.md",
        type: "Markdown",
        projectName: "Omnia Core",
        updatedLabel: "Today",
        sizeLabel: "12 KB",
        versionCount: 2,
      }],
    });

    render(<CommandPalette />);
    fireEvent.click(screen.getByRole("tab", { name: /Memory/ }));
    expect(screen.getByRole("option", { name: /Prefer fast smoke checks/ })).toHaveTextContent("Preview");

    fireEvent.click(screen.getByRole("tab", { name: /Library/ }));
    expect(screen.getByRole("option", { name: /research-notes.md/ })).toHaveTextContent("Preview");
  });

  it("surfaces provider and model scopes while keeping navigation renderer-local", () => {
    useWorkspaceStore.setState({
      commandPaletteOpen: true,
      activeActivity: "home",
      providers: [{
        id: "provider-command-center",
        name: "Local gateway",
        kind: "Local",
        providerType: "OpenAI-compatible",
        endpoint: "http://localhost:9000",
        authScheme: "opaque-ref",
        state: "configuration-validated",
        modelCount: 1,
        enabled: true,
        credentialState: "not-required",
        source: "preview",
        organizationId: null,
        remoteProjectId: null,
        lastCheckedAt: null,
        latencyMs: null,
        errorMessage: null,
        models: [{
          id: "model-command-center",
          connectionId: "provider-command-center",
          displayName: "Reasoning 32B",
          providerName: "Local gateway",
          providerModelId: "reasoning-32b",
          status: "available",
          capabilities: ["reasoning", "tools"],
          contextLabel: "128k",
          speed: "Thorough",
          favorite: true,
        }],
      }],
    });

    render(<CommandPalette />);
    fireEvent.click(screen.getByRole("tab", { name: /Models/ }));
    expect(screen.getByRole("option", { name: /Reasoning 32B/ })).toHaveTextContent("Preview");
    fireEvent.click(screen.getByRole("option", { name: /Reasoning 32B/ }));

    expect(useWorkspaceStore.getState().activeActivity).toBe("settings");
    expect(useWorkspaceStore.getState().commandPaletteOpen).toBe(false);
  });

  it("accepts power prefixes for model, provider, memory, skills, and library scopes", () => {
    useWorkspaceStore.setState({
      commandPaletteOpen: true,
      memories: [{
        id: "memory-prefix",
        title: "Prefix memory",
        content: "Searchable memory fixture",
        scopeLabel: "Workspace",
        kind: "preference",
        status: "active",
        origin: "explicit",
        confidence: 0.9,
        sourceLabel: "Fixture",
        lastUsedLabel: "Now",
      }],
    });

    render(<CommandPalette />);
    const input = screen.getByRole("combobox", { name: "Filter commands, chats, projects, memory, skills, library, providers, and models" });
    fireEvent.change(input, { target: { value: "%prefix memory" } });
    expect(screen.getByRole("option", { name: /Prefix memory/ })).toBeInTheDocument();
    expect(screen.getByText("% Memory")).toBeInTheDocument();
  });

  it("keeps message and file roots available as distinct command-center scopes", () => {
    useWorkspaceStore.setState({
      commandPaletteOpen: true,
      conversations: [{
        id: "conversation-message-scope",
        activeBranchId: "branch-message-scope",
        title: "Searchable conversation",
        excerpt: "Message scope fixture",
        updatedAt: "2026-09-21T00:00:00.000Z",
        updatedLabel: "Today",
        projectId: "project-file-scope",
        projectName: "File scope project",
        pinned: false,
        archived: false,
        hasDraft: false,
        unread: false,
        runState: null,
        draft: "",
        messages: [{
          id: "message-scope",
          role: "assistant",
          content: "Search this exact message target",
          createdAt: "2026-09-21T00:00:00.000Z",
          status: "complete",
          modelLabel: "Preview model",
          runId: null,
          attachments: [],
          branchIndex: 1,
          branchCount: 1,
        }],
      }],
      projects: [{
        id: "project-file-scope",
        name: "File scope project",
        description: "Folder root fixture",
        accent: "#2563eb",
        instructions: "",
        modelProfileId: "auto",
        conversationCount: 1,
        contextHealth: "ready",
        pinned: false,
        folders: [{
          id: "folder-scope",
          displayName: "src",
          canonicalPath: "C:/work/omnia/src",
          state: "ready",
          scope: "read-only",
          fileCount: 4,
          chunkCount: 8,
          lastIndexedAt: "2026-09-21T00:00:00.000Z",
          localOnly: true,
        }],
      }],
    });

    render(<CommandPalette />);
    const input = screen.getByRole("combobox", { name: "Filter commands, chats, projects, memory, skills, library, providers, and models" });
    fireEvent.change(input, { target: { value: "?exact message target" } });
    expect(screen.getByRole("option", { name: /Search this exact message target/ })).toBeInTheDocument();
    fireEvent.change(input, { target: { value: "~src" } });
    expect(screen.getByRole("option", { name: /^src/ })).toBeInTheDocument();
  });

  it("shows renderer location breadcrumbs for Chats, exact messages, projects, and file roots", () => {
    useWorkspaceStore.setState({
      commandPaletteOpen: true,
      conversations: [{
        id: "conversation-breadcrumbs",
        activeBranchId: "branch-breadcrumbs",
        title: "Breadcrumb chat",
        excerpt: "Palette breadcrumb fixture",
        updatedAt: "2026-09-27T00:00:00.000Z",
        updatedLabel: "Today",
        projectId: "project-breadcrumbs",
        projectName: "Omnia Core",
        pinned: false,
        archived: false,
        hasDraft: false,
        unread: false,
        runState: null,
        draft: "",
        messages: [{
          id: "message-breadcrumbs",
          role: "assistant",
          content: "Find this exact breadcrumb target",
          createdAt: "2026-09-27T00:00:00.000Z",
          status: "complete",
          modelLabel: "Preview model",
          runId: null,
          attachments: [],
          branchIndex: 1,
          branchCount: 1,
        }],
      }],
      projects: [{
        id: "project-breadcrumbs",
        name: "Omnia Core",
        description: "Palette breadcrumb project fixture",
        accent: "#2563eb",
        instructions: "",
        modelProfileId: "auto",
        conversationCount: 1,
        contextHealth: "ready",
        pinned: false,
        folders: [{
          id: "folder-breadcrumbs",
          displayName: "src",
          canonicalPath: "C:/work/omnia/src",
          state: "ready",
          scope: "read-only",
          fileCount: 4,
          chunkCount: 8,
          lastIndexedAt: "2026-09-27T00:00:00.000Z",
          localOnly: true,
        }],
      }],
    });

    render(<CommandPalette />);
    const input = screen.getByRole("combobox", { name: "Filter commands, chats, projects, memory, skills, library, providers, and models" });

    fireEvent.change(input, { target: { value: "@Breadcrumb chat" } });
    expect(screen.getByLabelText("Location: Chats / Omnia Core / Breadcrumb chat")).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "?exact breadcrumb target" } });
    expect(screen.getByLabelText("Location: Chats / Breadcrumb chat / Assistant message")).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "#omnia core" } });
    expect(screen.getByLabelText("Location: Projects / Omnia Core")).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "~src" } });
    expect(screen.getByLabelText("Location: Projects / Omnia Core / Files / src")).toBeInTheDocument();
  });

  it("gives built-in power commands stable command breadcrumbs", () => {
    useWorkspaceStore.setState({ commandPaletteOpen: true });
    render(<CommandPalette />);

    const input = screen.getByRole("combobox", { name: "Filter commands, chats, projects, memory, skills, library, providers, and models" });
    fireEvent.change(input, { target: { value: ">new conversation" } });

    expect(screen.getByLabelText("Location: Commands / Create / New conversation")).toBeInTheDocument();
    expect(screen.getByText("Commands / Create / New conversation")).toBeInTheDocument();
  });

  it("lets explicit scope tabs and Alt+Arrow scope navigation override a typed prefix", () => {
    useWorkspaceStore.setState({
      commandPaletteOpen: true,
      conversations: [{
        id: "conversation-scope-override",
        activeBranchId: "branch-scope-override",
        title: "Needle chat",
        excerpt: "A result for the Chats scope",
        updatedAt: "2026-09-27T00:00:00.000Z",
        updatedLabel: "Today",
        projectId: null,
        projectName: null,
        pinned: false,
        archived: false,
        hasDraft: false,
        unread: false,
        runState: null,
        draft: "",
        messages: [],
      }],
      projects: [{
        id: "project-scope-override",
        name: "Needle project",
        description: "A result for the Projects scope",
        accent: "#2563eb",
        instructions: "",
        modelProfileId: "auto",
        conversationCount: 0,
        contextHealth: "ready",
        pinned: false,
        folders: [],
      }],
    });

    render(<CommandPalette />);
    const input = screen.getByRole("combobox", { name: "Filter commands, chats, projects, memory, skills, library, providers, and models" });
    fireEvent.change(input, { target: { value: "@Needle" } });
    fireEvent.click(screen.getByRole("tab", { name: /Projects/ }));

    expect(input).toHaveValue("Needle");
    expect(screen.getByRole("tab", { name: /Projects/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("option", { name: /Needle project/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Needle chat/ })).not.toBeInTheDocument();

    fireEvent.change(input, { target: { value: "@Needle" } });
    fireEvent.keyDown(input, { key: "ArrowRight", altKey: true });

    expect(input).toHaveValue("Needle");
    expect(screen.getByRole("tab", { name: /Messages/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("option", { name: /Needle project/ })).not.toBeInTheDocument();
  });
});
