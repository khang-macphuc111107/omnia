import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  GlobalObjectSearchPreview,
  buildGlobalSearchResults,
  buildGlobalSearchCommands,
  parseGlobalSearchQuery,
  rankGlobalSearchResults,
} from "./global-object-search-preview";
import type { ArtifactView, ConversationView, MemoryView, ProjectView, ProviderView, SkillView } from "./types";

const conversation: ConversationView = {
  id: "chat-1",
  activeBranchId: "branch-1",
  title: "Rust compiler notes",
  excerpt: "Review borrow checker diagnostics",
  updatedAt: "2026-09-20T08:00:00.000Z",
  updatedLabel: "Today",
  projectId: "project-1",
  projectName: "Omnia Core",
  pinned: true,
  archived: false,
  hasDraft: false,
  unread: true,
  runState: null,
  draft: "",
  messages: [],
};

const project: ProjectView = {
  id: "project-1",
  name: "Omnia Core",
  description: "Compiler and renderer workspace",
  accent: "#6aa9ff",
  instructions: "Prefer typed Rust and TypeScript boundaries.",
  modelProfileId: "model-1",
  conversationCount: 1,
  contextHealth: "ready",
  pinned: true,
  folders: [],
};

const memory: MemoryView = {
  id: "memory-1",
  title: "Prefer small smoke checks",
  content: "Keep UI feedback fast and let the user test the browser preview.",
  scopeLabel: "Workspace",
  kind: "preference",
  status: "active",
  origin: "explicit",
  confidence: 0.95,
  sourceLabel: "User note",
  lastUsedLabel: "Today",
};

const skill: SkillView = {
  id: "skill-1",
  name: "Rust review",
  description: "Review production Rust changes.",
  version: "1.0.0",
  icon: "🦀",
  source: "Built in",
  trust: "Verified",
  enabled: true,
  scope: "Global",
  tokenFootprint: 420,
  permissions: ["read workspace"],
};

const artifact: ArtifactView = {
  id: "artifact-1",
  name: "compiler-notes.md",
  type: "Markdown",
  projectName: "Omnia Core",
  updatedLabel: "Today",
  sizeLabel: "12 KB",
  versionCount: 3,
};

const provider: ProviderView = {
  id: "provider-1",
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
  models: [],
};

function renderSearch(overrides: Partial<React.ComponentProps<typeof GlobalObjectSearchPreview>> = {}) {
  return render(
    <GlobalObjectSearchPreview
      conversations={[conversation]}
      projects={[project]}
      memories={[memory]}
      skills={[skill]}
      artifacts={[artifact]}
      providers={[provider]}
      onOpenConversation={vi.fn()}
      onOpenProject={vi.fn()}
      onNavigate={vi.fn()}
      onClose={vi.fn()}
      {...overrides}
    />,
  );
}

describe("GlobalObjectSearchPreview", () => {
  it("builds searchable results across all visible object families", () => {
    const results = buildGlobalSearchResults({
      conversations: [conversation],
      projects: [project],
      memories: [memory],
      skills: [skill],
      artifacts: [artifact],
      providers: [provider],
    });

    expect(results).toHaveLength(6);
    expect(results.find((result) => result.kind === "chat")?.subtitle).toBe("Omnia Core");
    expect(results.find((result) => result.kind === "provider")?.statusLabel).toBe("configuration-validated");
  });

  it("exposes command-center commands and power-user aliases", () => {
    const commands = buildGlobalSearchCommands();
    expect(commands.map((result) => result.id)).toEqual(expect.arrayContaining(["command:new-chat", "command:open-settings"]));
    expect(commands.find((result) => result.id === "command:new-chat")?.breadcrumb).toEqual(["Commands", "Create", "New conversation"]);

    expect(parseGlobalSearchQuery("type:model local", "all", "all").kind).toBe("model");
    expect(parseGlobalSearchQuery("@commands new", "all", "all").kind).toBe("command");
  });

  it("activates renderer-local navigation commands from the unified search surface", () => {
    const onNavigate = vi.fn();
    const onClose = vi.fn();
    renderSearch({ onNavigate, onClose });

    fireEvent.click(screen.getByRole("tab", { name: /Commands/i }));
    expect(screen.getByRole("option", { name: /Open Control Center/i })).toBeInTheDocument();
    expect(screen.getByText(/Commands \/ Navigate \/ Control Center/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: /Open Control Center/i }));

    expect(onNavigate).toHaveBeenCalledWith("settings");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("surfaces provider model metadata with a settings breadcrumb", () => {
    const modelProvider: ProviderView = {
      ...provider,
      models: [{
        id: "model-1",
        connectionId: provider.id,
        displayName: "Reasoning 32B",
        providerName: provider.name,
        providerModelId: "reasoning-32b",
        status: "available",
        capabilities: ["reasoning", "tools"],
        contextLabel: "128k",
        speed: "Thorough",
        favorite: true,
      }],
    };
    const results = buildGlobalSearchResults({
      conversations: [],
      projects: [],
      memories: [],
      skills: [],
      artifacts: [],
      providers: [modelProvider],
    });
    const model = results.find((result) => result.kind === "model");

    expect(model?.title).toBe("Reasoning 32B");
    expect(model?.keywords).toContain("reasoning-32b");
    expect(model?.breadcrumb).toEqual(["Settings", "Providers", "Local gateway", "Reasoning 32B"]);
  });

  it("indexes messages and project file roots as separate universal-search targets", () => {
    const onOpenConversation = vi.fn();
    const onOpenProject = vi.fn();
    const results = buildGlobalSearchResults({
      conversations: [{
        ...conversation,
        messages: [{
          id: "message-1",
          role: "assistant",
          content: "The invariant is preserved after the compiler pass.",
          createdAt: "2026-09-21T08:00:00.000Z",
          status: "complete",
          modelLabel: "Reasoning 32B",
          runId: "run-1",
          attachments: [],
          branchIndex: 1,
          branchCount: 1,
        }],
      }],
      projects: [{
        ...project,
        folders: [{
          id: "folder-1",
          displayName: "src",
          canonicalPath: "C:/work/omnia/src",
          state: "ready",
          scope: "read-only",
          fileCount: 42,
          chunkCount: 120,
          lastIndexedAt: "2026-09-21T08:00:00.000Z",
          localOnly: true,
        }],
      }],
      memories: [],
      skills: [],
      artifacts: [],
      providers: [],
    });

    expect(results.find((result) => result.kind === "message")?.breadcrumb).toEqual(["Chats", "Rust compiler notes", "Assistant message"]);
    expect(results.find((result) => result.kind === "file")?.detail).toContain("42 files");

    renderSearch({
      conversations: [{
        ...conversation,
        messages: [{
          id: "message-1",
          role: "assistant",
          content: "The invariant is preserved after the compiler pass.",
          createdAt: "2026-09-21T08:00:00.000Z",
          status: "complete",
          modelLabel: "Reasoning 32B",
          runId: "run-1",
          attachments: [],
          branchIndex: 1,
          branchCount: 1,
        }],
      }],
      projects: [{
        ...project,
        folders: [{
          id: "folder-1",
          displayName: "src",
          canonicalPath: "C:/work/omnia/src",
          state: "ready",
          scope: "read-only",
          fileCount: 42,
          chunkCount: 120,
          lastIndexedAt: "2026-09-21T08:00:00.000Z",
          localOnly: true,
        }],
      }],
      onOpenConversation,
      onOpenProject,
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Search visible workspace objects" }), { target: { value: "invariant" } });
    fireEvent.click(screen.getByRole("option", { name: /invariant is preserved/i }));
    expect(onOpenConversation).toHaveBeenCalledWith("chat-1");

    fireEvent.change(screen.getByRole("textbox", { name: "Search visible workspace objects" }), { target: { value: "src" } });
    fireEvent.click(screen.getByRole("option", { name: /^src/ }));
    expect(onOpenProject).toHaveBeenCalledWith("project-1");
  });

  it("filters and activates a chat result with keyboard navigation", () => {
    const onOpenConversation = vi.fn();
    const onClose = vi.fn();
    renderSearch({ onOpenConversation, onClose });

    fireEvent.change(screen.getByRole("textbox", { name: "Search visible workspace objects" }), { target: { value: "borrow" } });
    const resultList = screen.getByRole("listbox", { name: "Global object search results" });
    expect(within(resultList).getByRole("option", { name: /Rust compiler notes/i })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Search visible workspace objects" }), { key: "Enter" });

    expect(onOpenConversation).toHaveBeenCalledWith("chat-1");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("switches object filters and keeps the preview boundary visible", () => {
    const onNavigate = vi.fn();
    renderSearch({ onNavigate });

    fireEvent.click(screen.getByRole("tab", { name: /Skills/i }));
    expect(screen.getByRole("listbox", { name: "Global object search results" })).toHaveTextContent("Rust review");
    fireEvent.click(screen.getByRole("option", { name: /Rust review/i }));
    expect(onNavigate).toHaveBeenCalledWith("skills");
    expect(screen.getByText("Preview only")).toBeInTheDocument();
    expect(screen.getByText(/Renderer-local.*No durable write/i)).toBeInTheDocument();
  });

  it("parses type/status operators and ranks message content without a native index", () => {
    const parsed = parseGlobalSearchQuery("type:chat status:attention borrow", "project", "all");
    expect(parsed.kind).toBe("chat");
    expect(parsed.status).toBe("attention");
    expect(parsed.terms).toEqual(["borrow"]);

    const results = buildGlobalSearchResults({
      conversations: [{
        ...conversation,
        messages: [{
          id: "message-1",
          role: "user",
          content: "borrow checker invariant",
          createdAt: "2026-09-20T08:00:00.000Z",
          status: "complete",
          modelLabel: null,
          runId: null,
          attachments: [],
          branchIndex: 1,
          branchCount: 1,
        }],
      }],
      projects: [project],
      memories: [memory],
      skills: [skill],
      artifacts: [artifact],
      providers: [provider],
    });
    const ranked = rankGlobalSearchResults(results.filter((result) => result.kind === "chat"), { terms: ["invariant"] }, "relevance");
    expect(ranked[0]?.id).toBe("chat:chat-1");
  });

  it("supports status/sort controls, query reset, and recent search chips", () => {
    const onClose = vi.fn();
    renderSearch({ onClose });
    const input = screen.getByRole("textbox", { name: "Search visible workspace objects" });
    fireEvent.change(input, { target: { value: "compiler" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Clear global search" }));
    expect(screen.getByRole("button", { name: /compiler/ })).toBeInTheDocument();

    fireEvent.change(screen.getByRole("combobox", { name: "Global search status" }), { target: { value: "ready" } });
    expect(screen.getByText(/visible result/)).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Global search sort" }), { target: { value: "title" } });
    expect(screen.getByRole("button", { name: "Reset filters" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reset filters" }));
    expect(screen.queryByRole("button", { name: "Reset filters" })).not.toBeInTheDocument();
  });

  it("saves, reapplies, updates, and removes named global search views for the current session", () => {
    renderSearch();
    const searchInput = screen.getByRole("textbox", { name: "Search visible workspace objects" });
    const viewNameInput = screen.getByRole("textbox", { name: "Saved global search view name" });
    const savedViewSelect = screen.getByRole("combobox", { name: "Saved global search view" });

    fireEvent.change(searchInput, { target: { value: "compiler" } });
    fireEvent.click(screen.getByRole("tab", { name: /Projects/i }));
    fireEvent.change(screen.getByRole("combobox", { name: "Global search status" }), { target: { value: "attention" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Global search sort" }), { target: { value: "title" } });
    fireEvent.change(viewNameInput, { target: { value: "Global search QA" } });
    fireEvent.click(screen.getByRole("button", { name: "Save as" }));

    const savedViewId = (savedViewSelect as HTMLSelectElement).value;
    expect(savedViewId).toContain("global-search-view-");
    expect(screen.getByText(/Saved “Global search QA” for this session/)).toBeInTheDocument();

    fireEvent.change(searchInput, { target: { value: "different query" } });
    fireEvent.change(savedViewSelect, { target: { value: "" } });
    fireEvent.change(savedViewSelect, { target: { value: savedViewId } });

    expect(searchInput).toHaveValue("compiler");
    expect(screen.getByRole("tab", { name: /Projects/i })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("combobox", { name: "Global search status" })).toHaveValue("attention");
    expect(screen.getByRole("combobox", { name: "Global search sort" })).toHaveValue("title");

    fireEvent.change(searchInput, { target: { value: "updated query" } });
    fireEvent.change(viewNameInput, { target: { value: "Project follow-up" } });
    fireEvent.click(screen.getByRole("button", { name: "Update view" }));
    expect(screen.getByRole("option", { name: "Project follow-up" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Global search QA" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Delete saved global search view" }));
    expect(screen.queryByRole("option", { name: "Project follow-up" })).not.toBeInTheDocument();
    expect(screen.getByText(/No durable write/i)).toBeInTheDocument();
  });

  it("keeps typed kind/status operators synchronized with the visible controls", () => {
    renderSearch();
    const input = screen.getByRole("textbox", { name: "Search visible workspace objects" });

    fireEvent.change(input, { target: { value: "type:project compiler" } });
    expect(screen.getByRole("tab", { name: /Projects/i })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("tab", { name: /Chats/i }));

    expect(input).toHaveValue("compiler");
    expect(screen.getByRole("tab", { name: /Chats/i })).toHaveAttribute("aria-selected", "true");

    fireEvent.change(input, { target: { value: "status:attention compiler" } });
    const statusSelect = screen.getByRole("combobox", { name: "Global search status" });
    expect(statusSelect).toHaveValue("attention");
    fireEvent.change(statusSelect, { target: { value: "ready" } });

    expect(input).toHaveValue("compiler");
    expect(statusSelect).toHaveValue("ready");
  });

  it("keeps keyboard filter changes aligned with the query operator", () => {
    renderSearch();
    const input = screen.getByRole("textbox", { name: "Search visible workspace objects" });
    const chatsTab = screen.getByRole("tab", { name: /Chats/i });

    fireEvent.change(input, { target: { value: "type:chat compiler" } });
    fireEvent.keyDown(chatsTab, { key: "ArrowRight" });

    expect(input).toHaveValue("compiler");
    expect(screen.getByRole("tab", { name: /Messages/i })).toHaveAttribute("aria-selected", "true");
  });
});
