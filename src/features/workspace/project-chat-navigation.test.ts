import { describe, expect, it } from "vitest";

import {
  buildProjectChatNavigation,
  chatActionAvailability,
  createProjectChatDeepLinkPreview,
  navigationScopeForChat,
  resolveProjectChatDeepLinkPreview,
} from "./project-chat-navigation";
import type { ConversationView, ProjectView } from "./types";

function chat(
  id: string,
  overrides: Partial<ConversationView> = {},
): ConversationView {
  return {
    id,
    activeBranchId: `branch-${id}`,
    title: id,
    excerpt: `${id} excerpt`,
    updatedAt: `2026-09-16T0${id.endsWith("1") ? "2" : "1"}:00:00.000Z`,
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
    ...overrides,
  };
}

function project(id: string): ProjectView {
  return {
    id,
    name: id,
    description: "",
    accent: "#4b9cd3",
    instructions: "",
    modelProfileId: "auto",
    conversationCount: 0,
    contextHealth: "not-compiled",
    pinned: false,
    folders: [],
  };
}

describe("Project → Chat navigation projection", () => {
  it("keeps standalone, project-owned, archived and orphaned chats visible in typed buckets", () => {
    const projects = [project("project-a"), project("project-b")];
    const conversations = [
      chat("chat-1", { projectId: null }),
      chat("chat-2", { projectId: "project-a", projectName: "project-a", pinned: true }),
      chat("chat-3", { projectId: "project-b", projectName: "project-b", archived: true }),
      chat("chat-4", { projectId: "missing-project", projectName: "Old project" }),
    ];

    const projection = buildProjectChatNavigation(projects, conversations);

    expect(projection.standaloneChats.map((item) => item.id)).toEqual(["chat-1"]);
    expect(projection.projectGroups.map((group) => [group.project.id, group.chats.map((item) => item.id)])).toEqual([
      ["project-a", ["chat-2"]],
      ["project-b", []],
    ]);
    expect(projection.archivedChats.map((item) => item.id)).toEqual(["chat-3"]);
    expect(projection.orphanedChats.map((item) => item.id)).toEqual(["chat-4"]);
    expect(projection.pinnedChats.map((item) => item.id)).toEqual(["chat-2"]);
    expect(projection.counts).toEqual({
      total: 4,
      active: 3,
      standalone: 1,
      projectOwned: 2,
      pinned: 1,
      archived: 1,
      orphaned: 1,
    });

    const activeProjection = buildProjectChatNavigation(projects, conversations, {
      activeProjectId: "project-b",
    });
    expect(activeProjection.projectGroups.map((group) => group.active)).toEqual([false, true]);
  });

  it("filters by title, excerpt or project name without mutating input", () => {
    const projects = [project("project-a")];
    const source = [
      chat("alpha", { projectId: "project-a", projectName: "Project Atlas" }),
      chat("beta", { excerpt: "Searchable phrase" }),
    ];

    const projection = buildProjectChatNavigation(projects, source, { query: "atlas" });

    expect(projection.projectGroups[0]?.chats.map((item) => item.id)).toEqual(["alpha"]);
    expect(source.map((item) => item.id)).toEqual(["alpha", "beta"]);
  });

  it("supports bounded message, draft, and model search scopes", () => {
    const source = [
      chat("message-hit", {
        draft: "draft-only phrase",
        messages: [
          {
            id: "message-hit-1",
            role: "assistant",
            content: "The hidden transcript phrase is searchable.",
            createdAt: "2026-09-16T02:00:00.000Z",
            status: "complete",
            modelLabel: "Research model",
            runId: "run-message-hit",
            attachments: [],
            branchIndex: 1,
            branchCount: 1,
          },
        ],
      }),
      chat("other", {
        messages: [
          {
            id: "other-1",
            role: "assistant",
            content: "Unrelated response",
            createdAt: "2026-09-16T02:00:00.000Z",
            status: "complete",
            modelLabel: "Fast model",
            runId: "run-other",
            attachments: [],
            branchIndex: 1,
            branchCount: 1,
          },
        ],
      }),
    ];

    expect(buildProjectChatNavigation([], source, { query: "hidden transcript", searchScope: "messages" }).standaloneChats.map((item) => item.id)).toEqual(["message-hit"]);
    expect(buildProjectChatNavigation([], source, { query: "draft-only", searchScope: "drafts" }).standaloneChats.map((item) => item.id)).toEqual(["message-hit"]);
    expect(buildProjectChatNavigation([], source, { query: "research model", searchScope: "models" }).standaloneChats.map((item) => item.id)).toEqual(["message-hit"]);
    expect(buildProjectChatNavigation([], source, { query: "hidden transcript", searchScope: "chat" }).standaloneChats).toHaveLength(0);
  });

  it("does not offer archive for a currently streaming Chat", () => {
    const availability = chatActionAvailability({ archived: false, projectId: null, runState: "streaming" });
    expect(availability.archive).toEqual({
      state: "unavailable",
      reason: "Stop or finish the active run before archiving this Chat.",
    });
    expect(availability.rename.state).toBe("enabled");
  });

  it("labels native-only actions honestly", () => {
    const availability = chatActionAvailability(
      { archived: false, projectId: "project-a", runState: null },
      { hasFilesystemWorkspace: true, nativeHost: true },
    );
    expect(availability["continue-in-new-worktree"]).toMatchObject({ state: "planned" });
    expect(availability["open-in-new-window"]).toEqual({ state: "enabled" });
    expect(availability.export.state).toBe("enabled");
    expect(availability.export.reason).toMatch(/renderer-local export preview is available/i);
    expect(availability.export.reason).toMatch(/native export.*planned/i);
  });

  it("maps archived and standalone ownership to canonical scopes", () => {
    expect(navigationScopeForChat({ archived: true, projectId: null })).toBe("archived");
    expect(navigationScopeForChat({ archived: false, projectId: null })).toBe("standalone");
    expect(navigationScopeForChat({ archived: false, projectId: "project-a" })).toBe("project");
  });

  it("creates and resolves a Project-context Chat deep link without claiming native routing", () => {
    const projects = [project("project-a")];
    const conversations = [chat("chat-1", { projectId: "project-a" })];
    const uri = createProjectChatDeepLinkPreview("project-a", "chat-1");

    expect(uri).toBe("omnia://project/project-a/chat/chat-1?target=chat");
    expect(resolveProjectChatDeepLinkPreview(uri, projects, conversations)).toMatchObject({
      status: "resolved",
      parseStatus: "valid",
      projectId: "project-a",
      conversationId: "chat-1",
      nearestAncestor: "chat",
      label: "Project Chat target resolved in renderer preview",
    });
  });

  it("returns a typed stale result when a Chat keeps an old Project context", () => {
    const uri = createProjectChatDeepLinkPreview("project-a", "chat-1");
    const result = resolveProjectChatDeepLinkPreview(
      uri,
      [project("project-a")],
      [chat("chat-1", { projectId: "project-b" })],
    );

    expect(result).toMatchObject({
      status: "stale",
      reason: "project-context-mismatch",
      nearestAncestor: "chat",
      label: "Project context does not match this preview target",
    });
  });

  it("keeps missing, archived, and malformed Project Chat targets explicit", () => {
    const projects = [project("project-a")];
    const missingChat = resolveProjectChatDeepLinkPreview(
      createProjectChatDeepLinkPreview("project-a", "missing-chat"),
      projects,
      [],
    );
    expect(missingChat).toMatchObject({
      status: "missing",
      reason: "conversation-missing",
      nearestAncestor: "project",
    });

    const archived = resolveProjectChatDeepLinkPreview(
      createProjectChatDeepLinkPreview("project-a", "chat-archived"),
      projects,
      [chat("chat-archived", { projectId: "project-a", archived: true })],
    );
    expect(archived).toMatchObject({
      status: "stale",
      reason: "archived",
      nearestAncestor: "chat",
      label: "Chat is archived in this preview",
    });

    const malformed = resolveProjectChatDeepLinkPreview("omnia://project/project-a/chat", projects, []);
    expect(malformed).toMatchObject({
      status: "unsupported",
      parseStatus: "malformed",
      reason: "invalid-path",
      nearestAncestor: "chats",
    });
  });
});
