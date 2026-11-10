import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ConversationBranchRecord, MessageRevision } from "@/lib/desktop";

import {
  BranchRevisionWorkbenchView,
  buildBranchTopologyRows,
  branchRecordsFromConversation,
  buildBranchRevisionProjection,
} from "./branch-revision-workbench";
import type { ConversationView } from "./types";

const conversation: ConversationView = {
  id: "conversation-branches",
  activeBranchId: "branch-current",
  title: "Branch preview",
  excerpt: "Inspect alternate paths without pretending they are durable.",
  updatedAt: "2026-09-16T04:30:00.000Z",
  updatedLabel: "Now",
  projectId: "project-omnia",
  projectName: "Omnia",
  pinned: false,
  archived: false,
  hasDraft: false,
  unread: false,
  runState: null,
  draft: "",
  messages: [
    {
      id: "message-user",
      role: "user",
      content: "Explore a local-only route before we change the active plan.",
      createdAt: "2026-09-16T04:24:00.000Z",
      status: "complete",
      modelLabel: null,
      runId: null,
      attachments: [],
      branchIndex: 1,
      branchCount: 3,
    },
    {
      id: "message-assistant",
      role: "assistant",
      content: "I can compare the local route against the quality route with a separate branch.",
      createdAt: "2026-09-16T04:25:00.000Z",
      status: "complete",
      modelLabel: "Atlas Reasoning",
      runId: "run-branches",
      attachments: [],
      branchIndex: 2,
      branchCount: 3,
    },
  ],
};

const revisions: Record<string, MessageRevision[]> = {
  "message-assistant": [
    {
      schemaVersion: 1,
      revisionId: "revision-retry",
      messageId: "message-assistant",
      kind: "assistant",
      effect: "retry-current-state",
      parentRevisionId: "revision-draft",
      sourceCursor: 8,
      destinationBranchId: "branch-current",
      contentHash: "2ec87c50a39c875c2e4a93b4edb201da",
      redactionClass: "none",
      createdAt: "2026-09-16T04:25:30.000Z",
    },
    {
      schemaVersion: 1,
      revisionId: "revision-draft",
      messageId: "message-assistant",
      kind: "assistant",
      effect: "edit-draft",
      parentRevisionId: null,
      sourceCursor: 4,
      destinationBranchId: null,
      contentHash: "b7d168bc45f05f05423f0e96243e226b",
      redactionClass: "none",
      createdAt: "2026-09-16T04:25:10.000Z",
    },
  ],
};

const nativeBranches: ConversationBranchRecord[] = [
  {
    id: "branch-experiment",
    conversationId: conversation.id,
    parentBranchId: "branch-current",
    forkedFromMessageId: "message-user",
    name: "Local routing experiment",
    createdAtMs: 1_789_424_100_000,
  },
  {
    id: "branch-current",
    conversationId: conversation.id,
    parentBranchId: null,
    forkedFromMessageId: null,
    name: null,
    createdAtMs: 1_789_424_000_000,
  },
];

describe("BranchRevisionWorkbench", () => {
  it("keeps renderer-estimated branch slots distinct from hydrated native lineage", () => {
    const preview = buildBranchRevisionProjection(conversation, [], revisions);

    expect(preview.branches).toHaveLength(3);
    expect(preview.branches.map((branch) => branch.source)).toEqual(["renderer", "renderer", "renderer"]);
    expect(preview.branches[1]).toMatchObject({
      id: "branch-current",
      label: "Current branch",
      active: true,
      messageCount: 1,
    });
    expect(preview.revisions.map((item) => item.revision.revisionId)).toEqual(["revision-draft", "revision-retry"]);

    const hydrated = buildBranchRevisionProjection(conversation, nativeBranches, revisions);
    expect(hydrated.branches).toHaveLength(2);
    expect(hydrated.branches.map((branch) => branch.id)).toEqual(["branch-current", "branch-experiment"]);
    expect(hydrated.branches[1]).toMatchObject({
      label: "Local routing experiment",
      parentBranchId: "branch-current",
      forkedFromMessageId: "message-user",
      source: "native",
    });
  });

  it("maps native ConversationView branch metadata without fabricating sibling messages", () => {
    expect(branchRecordsFromConversation(conversation)).toEqual([]);

    const nativeConversation = { ...conversation, nativeBranches: nativeBranches.map(({ conversationId: _conversationId, ...branch }) => branch) };
    expect(branchRecordsFromConversation(nativeConversation)).toEqual(nativeBranches);
  });

  it("builds a lineage map and surfaces malformed parent metadata", () => {
    const hydrated = buildBranchRevisionProjection(conversation, nativeBranches, revisions);
    const rows = buildBranchTopologyRows(hydrated.branches);

    expect(rows.map((row) => [row.label, row.depth, row.relation])).toEqual([
      ["Branch 1", 0, "root"],
      ["Local routing experiment", 1, "child"],
    ]);
    expect(rows[1]?.lineagePath).toEqual(["branch-current", "branch-experiment"]);

    const malformed = buildBranchTopologyRows([
      { ...hydrated.branches[0]!, id: "orphan", parentBranchId: "missing-parent" },
      { ...hydrated.branches[0]!, id: "cycle-a", parentBranchId: "cycle-b" },
      { ...hydrated.branches[0]!, id: "cycle-b", parentBranchId: "cycle-a" },
    ]);
    expect(malformed.find((row) => row.id === "orphan")).toMatchObject({ relation: "orphan", depth: 1 });
    expect(malformed.filter((row) => row.relation === "cycle").map((row) => row.id).sort()).toEqual(["cycle-a", "cycle-b"]);
  });

  it("links the active tab to its panel and labels renderer-only branch creation as planned", () => {
    render(<BranchRevisionWorkbenchView conversation={conversation} revisionsByMessageId={revisions} nativeAvailable={false} />);

    const topology = screen.getByRole("tab", { name: "Topology" });
    expect(topology).toHaveAttribute("aria-selected", "true");
    expect(topology).toHaveAttribute("aria-controls", "branch-revision-panel-topology");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("id", "branch-revision-panel-topology");
    expect(screen.getByText(/estimated from visible message metadata/i)).toBeInTheDocument();
    expect(screen.getByRole("tree", { name: "Branch lineage map" })).toBeInTheDocument();
    expect(screen.getByRole("treeitem", { name: /Current branch.*root path/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /branch from latest message/i }));
    fireEvent.change(screen.getByRole("textbox", { name: "Branch name" }), { target: { value: "Try local first" } });
    fireEvent.click(screen.getByRole("button", { name: "Create branch" }));

    expect(screen.getByText(/branch creation is planned until a native branch bridge is connected/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Revisions" }));
    expect(screen.getByRole("tab", { name: "Revisions" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("id", "branch-revision-panel-revisions");
    expect(
      within(screen.getByRole("complementary", { name: "Selected revision details" }))
        .getByText("Current-state retry"),
    ).toBeInTheDocument();
  });

  it("shows immutable revision metadata and a clearly limited comparison preview", () => {
    render(<BranchRevisionWorkbenchView conversation={conversation} revisionsByMessageId={revisions} nativeAvailable={false} />);

    fireEvent.click(screen.getByRole("tab", { name: "Revisions" }));
    expect(screen.getByText("Content hash")).toBeInTheDocument();
    expect(screen.getByText("Destination branch")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /compare revisions/i }));

    const compare = screen.getByRole("tab", { name: "Compare" });
    expect(compare).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("id", "branch-revision-panel-compare");
    expect(screen.getByLabelText("Revision comparison preview")).toBeInTheDocument();
    expect(screen.getByText(/native content diff, branch promotion, and rollback remain planned/i)).toBeInTheDocument();

    const [base] = screen.getAllByRole("combobox");
    fireEvent.change(base!, { target: { value: "revision-retry" } });
    expect(screen.getByText(/choose two different revisions/i)).toBeInTheDocument();
  });

  it("shows a bounded native branch metadata comparison when two branches are hydrated", () => {
    render(
      <BranchRevisionWorkbenchView
        conversation={conversation}
        branchRecords={nativeBranches}
        revisionsByMessageId={revisions}
        nativeAvailable
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Compare" }));

    expect(screen.getByRole("heading", { name: "Compare branches" })).toBeInTheDocument();
    expect(screen.getByLabelText("Native branch comparison preview")).toBeInTheDocument();
    expect(screen.getByText(/sibling message content, state revisions, live-follow cursors, promotion, merge, and rollback are not hydrated/i)).toBeInTheDocument();

    const branchSelects = screen.getAllByRole("combobox");
    expect(branchSelects[0]).toHaveValue("branch-current");
    expect(branchSelects[1]).toHaveValue("branch-experiment");

    fireEvent.change(branchSelects[1]!, { target: { value: "branch-current" } });
    expect(screen.getByText(/choose two different hydrated branches/i)).toBeInTheDocument();
  });

  it("forwards a desktop branch request only when a native bridge is explicitly supplied", async () => {
    const onRequestBranch = vi.fn().mockResolvedValue(undefined);
    render(
      <BranchRevisionWorkbenchView
        conversation={conversation}
        revisionsByMessageId={revisions}
        nativeAvailable
        onRequestBranch={onRequestBranch}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /branch from latest message/i }));
    fireEvent.change(screen.getByRole("textbox", { name: "Branch name" }), { target: { value: "  Native lane  " } });
    fireEvent.click(screen.getByRole("button", { name: "Create branch" }));

    await waitFor(() => {
      expect(onRequestBranch).toHaveBeenCalledWith("message-assistant", "Native lane");
    });
    expect(screen.getByText(/branch request accepted by the connected runtime/i)).toBeInTheDocument();
    expect(screen.queryByText(/branch creation is planned/i)).not.toBeInTheDocument();
  });
});
