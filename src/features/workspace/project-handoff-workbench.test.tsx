import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ProjectHandoffWorkbench } from "./project-handoff-workbench";
import type { ProjectHandoffSeed } from "./project-handoff-seed";
import type { ConversationView, ProjectView } from "./types";

const project: ProjectView = {
  id: "handoff-project",
  name: "Handoff lab",
  description: "A project used to rehearse a bounded handoff.",
  accent: "#4f8cff",
  instructions: "Keep evidence explicit.",
  modelProfileId: "auto",
  conversationCount: 1,
  contextHealth: "ready",
  pinned: false,
  folders: [],
};

const conversation: ConversationView = {
  id: "handoff-chat",
  activeBranchId: "branch-handoff",
  title: "Next implementation step",
  excerpt: "Review the next dependency-complete step.",
  updatedAt: "2026-09-24T09:30:00.000Z",
  updatedLabel: "just now",
  projectId: project.id,
  projectName: project.name,
  archived: false,
  pinned: false,
  hasDraft: false,
  unread: true,
  runState: null,
  draft: "",
  messages: [],
};

const projectWithOverview: ProjectView = {
  ...project,
  folders: [{
    id: "folder-source",
    displayName: "src",
    canonicalPath: "D:\\workspace\\src",
    state: "ready",
    scope: "selected-files",
    fileCount: 12,
    chunkCount: 8,
    lastIndexedAt: "2026-09-24T09:00:00.000Z",
    localOnly: true,
  }],
  overview: {
    overviewRevisionId: "overview-1",
    projectTwinRevisionId: "twin-1",
    sourceEventWatermark: 12,
    status: "candidate",
    title: "Current work",
    subtitle: null,
    summary: "Implementation is ready for review.",
    goal: "Ship a bounded handoff.",
    nonGoals: [],
    phase: "Preview",
    milestone: "Handoff",
    nextTask: "Review exported records",
    activeBranch: "main",
    workspaceRootCount: 1,
    repositoryBranch: "main",
    worktree: null,
    verifiedEvidence: [{ id: "evidence-1", label: "Renderer preview", status: "verified", freshnessLabel: "current", sourceLabel: "test" }],
    staleNodeCount: 0,
    runtimeLabel: "renderer",
    modelProfileId: null,
    contextRevisionId: null,
    budgetLabel: null,
    backgroundWorkLabel: null,
    approvalsLabel: null,
    attentionItems: ["Native handoff is not connected."],
    recentChanges: [{ id: "change-1", label: "Added package records", changedAtLabel: "today", sourceLabel: "renderer" }],
  },
};

const planSeed: ProjectHandoffSeed = {
  schema: "omnia.project-handoff-seed.preview.v1",
  taskId: "task-handoff",
  taskTitle: "Prepare the handoff brief",
  phaseId: "phase-foundation",
  phaseTitle: "Foundation",
  status: "active",
  owner: "Planner",
  artifact: "Handoff brief",
  acceptance: "The next owner can review the brief.",
  risk: "Native approval is not hydrated.",
  dependencies: [{ id: "task-scope", title: "Map the scope" }],
  brief: "Continue the handoff task with its acceptance and dependency context.",
  boundary: "Renderer-local plan-to-handoff seed only; no native mutation was created.",
};

describe("ProjectHandoffWorkbench", () => {
  it("keeps audience, readiness, and package export inside the renderer preview", () => {
    render(<ProjectHandoffWorkbench project={project} conversations={[conversation]} />);

    const region = screen.getByRole("region", { name: "Project handoff package preview" });
    expect(screen.getByRole("heading", { name: "Package the next move without losing context" })).toBeInTheDocument();
    expect(screen.getByText("Preview only")).toBeInTheDocument();
    expect(screen.getByText("Referenced · not indexed")).toBeInTheDocument();
    expect(screen.getByText(/Handoff preparation is renderer-local/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: /Reviewer \/ tester/i }));
    fireEvent.change(screen.getByRole("textbox", { name: "Handoff note" }), { target: { value: "Review the visible evidence first." } });
    fireEvent.click(screen.getByRole("button", { name: "Prepare handoff" }));

    expect(screen.getByText("Ready for review")).toBeInTheDocument();
    expect(screen.getByText(/Handoff draft prepared with .* checklist items/i)).toBeInTheDocument();

    fireEvent.change(within(region).getByRole("combobox", { name: "Project handoff export format" }), { target: { value: "markdown" } });
    expect(within(region).getByRole("code")).toHaveTextContent(/Handoff lab project handoff/i);
    expect(within(region).getByRole("code")).toHaveTextContent(/No durable write/i);
  });

  it("resets the rehearsal without mutating project input", () => {
    render(<ProjectHandoffWorkbench project={project} conversations={[conversation]} />);

    fireEvent.click(screen.getByRole("radio", { name: /Another agent/i }));
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));

    expect(screen.getByRole("radio", { name: /My next session/i })).toBeChecked();
    expect(screen.getByText("Draft")).toBeInTheDocument();
    expect(project.name).toBe("Handoff lab");
  });

  it("shows a selected plan task and carries it into the portable package", () => {
    render(<ProjectHandoffWorkbench project={project} conversations={[conversation]} planSeed={planSeed} />);

    expect(screen.getByRole("region", { name: "Selected project plan handoff seed" })).toBeInTheDocument();
    expect(screen.getByText("Prepare the handoff brief")).toBeInTheDocument();
    expect(screen.getByText("Planner", { exact: true })).toBeInTheDocument();
    expect(screen.getAllByText(/plan-to-handoff seed only/i).length).toBeGreaterThan(0);

    const packageRegion = screen.getByRole("region", { name: "Project handoff package preview" });
    expect(within(packageRegion).getByRole("code")).toHaveTextContent(/task-handoff/i);
    expect(within(packageRegion).getByRole("code")).toHaveTextContent(/Prepare the handoff brief/i);

    fireEvent.click(screen.getByRole("checkbox", { name: "Plan and next-step direction" }));
    expect(within(packageRegion).getByRole("code")).toHaveTextContent(/"planSeed": null/i);
  });

  it("exports visible chat, folder, and signal records only while their includes are enabled", () => {
    render(<ProjectHandoffWorkbench project={projectWithOverview} conversations={[conversation]} />);

    const packageCode = screen.getByRole("region", { name: "Project handoff package preview" }).querySelector("code")!;
    const readPayload = () => JSON.parse(packageCode.textContent ?? "{}") as {
      project: { folderGrants: Array<{ id: string }> };
      handoff: { chats: Array<{ id: string; excerpt: string }>; signals: { projectOverview: { summary: string } } | null };
    };

    expect(readPayload().handoff.chats).toEqual([expect.objectContaining({ id: "handoff-chat", excerpt: "Review the next dependency-complete step." })]);
    expect(readPayload().project.folderGrants).toEqual([expect.objectContaining({ id: "folder-source", displayName: "src" })]);
    expect(readPayload().handoff.signals?.projectOverview.summary).toBe("Implementation is ready for review.");

    fireEvent.click(screen.getByRole("checkbox", { name: /Chats and recent activity/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Unified signal summary/i }));

    expect(readPayload().handoff.chats).toEqual([]);
    expect(readPayload().handoff.signals).toBeNull();
  });

  it("supports a metadata-only chat package without dropping the selected chat record", () => {
    render(<ProjectHandoffWorkbench project={projectWithOverview} conversations={[conversation]} />);

    const packageRegion = screen.getByRole("region", { name: "Project handoff package preview" });
    const packageCode = packageRegion.querySelector("code")!;
    const readPayload = () => JSON.parse(packageCode.textContent ?? "{}") as {
      handoff: {
        included: { chats: boolean; chatExcerpts: boolean };
        chats: Array<{ id: string; excerpt: string }>;
      };
    };

    expect(readPayload().handoff.included).toMatchObject({ chats: true, chatExcerpts: true });
    expect(readPayload().handoff.chats).toEqual([expect.objectContaining({ id: "handoff-chat", excerpt: conversation.excerpt })]);

    fireEvent.click(screen.getByRole("checkbox", { name: /Chat excerpts/i }));

    expect(readPayload().handoff.included).toMatchObject({ chats: true, chatExcerpts: false });
    expect(readPayload().handoff.chats).toEqual([expect.objectContaining({ id: "handoff-chat", excerpt: "" })]);
    expect(screen.getByText(/Metadata only; excerpt text is omitted/i)).toBeInTheDocument();
  });

  it("exports only individually selected chats and workspace grants", () => {
    const secondConversation: ConversationView = {
      ...conversation,
      id: "handoff-chat-private",
      title: "Exclude this chat",
      excerpt: "This record should stay out of the package.",
      unread: true,
    };
    const secondFolder = {
      ...projectWithOverview.folders[0]!,
      id: "folder-tests",
      displayName: "tests",
    };
    const scopedProject = {
      ...projectWithOverview,
      folders: [...projectWithOverview.folders, secondFolder],
    };

    render(<ProjectHandoffWorkbench project={scopedProject} conversations={[conversation, secondConversation]} />);

    fireEvent.click(screen.getByRole("checkbox", { name: /Exclude this chat/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: /tests/i }));

    const packageCode = screen.getByRole("region", { name: "Project handoff package preview" }).querySelector("code")!;
    const payload = JSON.parse(packageCode.textContent ?? "{}") as {
      schema: string;
      project: { folderGrants: Array<{ id: string }> };
      handoff: {
        chats: Array<{ id: string }>;
        includedRecordIds: { chats: string[]; folderGrants: string[] };
        includedRecordCounts: { chats: number; folderGrants: number };
        signals: { attentionChats: Array<{ chatId: string }> };
      };
    };

    expect(payload.schema).toBe("omnia.project-handoff.preview.v3");
    expect(payload.handoff.includedRecordIds.chats).toEqual(["handoff-chat"]);
    expect(payload.handoff.includedRecordIds.folderGrants).toEqual(["folder-source"]);
    expect(payload.handoff.includedRecordCounts).toMatchObject({ chats: 1, folderGrants: 1 });
    expect(payload.handoff.chats.map((chat) => chat.id)).toEqual(["handoff-chat"]);
    expect(payload.project.folderGrants.map((folder) => folder.id)).toEqual(["folder-source"]);
    expect(payload.handoff.signals.attentionChats.map((chat) => chat.chatId)).toEqual(["handoff-chat"]);
  });

  it("filters large record sets and changes only the visible selection", () => {
    const secondConversation: ConversationView = {
      ...conversation,
      id: "handoff-chat-private",
      title: "Exclude this chat",
      excerpt: "This record should stay out of the package.",
      unread: false,
    };
    const secondFolder = {
      ...projectWithOverview.folders[0]!,
      id: "folder-tests",
      displayName: "tests",
    };
    const scopedProject = {
      ...projectWithOverview,
      folders: [...projectWithOverview.folders, secondFolder],
    };

    render(<ProjectHandoffWorkbench project={scopedProject} conversations={[conversation, secondConversation]} />);

    const chatSearch = screen.getByRole("searchbox", { name: "Search project chats" });
    fireEvent.change(chatSearch, { target: { value: "Exclude this" } });
    expect(screen.getByRole("checkbox", { name: /Exclude this chat/i })).toBeChecked();
    expect(screen.queryByRole("checkbox", { name: /Next implementation step/i })).toBeNull();

    fireEvent.click(within(screen.getByRole("group", { name: "Chat selection actions" })).getByRole("button", { name: "Clear visible" }));
    expect(screen.getByRole("checkbox", { name: /Exclude this chat/i })).not.toBeChecked();

    fireEvent.change(chatSearch, { target: { value: "" } });
    expect(screen.getByRole("checkbox", { name: /Next implementation step/i })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Exclude this chat/i })).not.toBeChecked();

    const grantSearch = screen.getByRole("searchbox", { name: "Search workspace grants" });
    fireEvent.change(grantSearch, { target: { value: "tests" } });
    const grantActions = screen.getByRole("group", { name: "Workspace grant selection actions" });
    fireEvent.click(within(grantActions).getByRole("button", { name: "Clear visible" }));
    expect(screen.getByRole("checkbox", { name: /tests/i })).not.toBeChecked();
    fireEvent.click(within(grantActions).getByRole("button", { name: "Select visible" }));
    expect(screen.getByRole("checkbox", { name: /tests/i })).toBeChecked();
  });

  it("shows a semantic diff after a prepared baseline changes", () => {
    render(<ProjectHandoffWorkbench project={projectWithOverview} conversations={[conversation]} />);

    const diffRegion = screen.getByRole("region", { name: "Handoff semantic diff preview" });
    expect(within(diffRegion).getByText(/No prepared baseline yet/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Prepare handoff" }));
    expect(within(diffRegion).getByText(/No semantic changes since the prepared baseline/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: /Chats and recent activity/i }));
    expect(within(diffRegion).getAllByText("1", { selector: "strong" })).toHaveLength(2);
    expect(within(diffRegion).getByText("Removed")).toBeInTheDocument();
    expect(within(diffRegion).getByText(/Chat · Next implementation step/i)).toBeInTheDocument();
    expect(screen.getByText(/changed since the last prepared baseline/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Prepare handoff" }));
    expect(within(diffRegion).getByText(/No semantic changes since the prepared baseline/i)).toBeInTheDocument();
  });
});
