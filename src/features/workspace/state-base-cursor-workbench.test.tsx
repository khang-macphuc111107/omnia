import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { StateRevisionGraphSnapshot } from "@/lib/desktop";

import type { RunControlOperationProjection } from "./run-control-projection";
import { StateBaseCursorWorkbench } from "./state-base-cursor-workbench";

const operation = {
  status: "applied",
  durability: "durable",
  stateRevisionId: "state_revision_result",
  resultRunId: "run_result",
  resultAttemptId: "attempt_result",
  checkpointId: null,
  blockedReason: null,
  diagnostic: null,
  operation: {
    schemaVersion: 2,
    operationId: "operation_state_base",
    receiptId: "receipt_state_base",
    kind: "continue",
    operationState: "applied",
    conversationId: "conversation-1",
    branchId: "branch-1",
    sourceRunId: "run-source",
    sourceAttemptId: "attempt-source",
    sourceMessageId: "message-source",
    sourcePromptRevisionId: null,
    stateBase: {
      mode: "exact-historical",
      sourceStateRevisionId: "state_revision_source",
      requestedHeadStateRevisionId: "state_revision_head",
      resolvedStateRevisionId: "state_revision_resolved",
      resolvedStateDigest: {
        algorithm: "sha-256",
        canonicalizationRevision: "state-c14n-v1",
        value: "abcdef0123456789abcdef0123456789",
      },
      selectedDeltaIds: ["delta-1"],
      contextManifestId: "context_manifest_1",
      resolutionReason: "exact-frozen",
      resolvedAt: "2026-09-19T08:30:00.000Z",
      resolvedAtCursors: [
        {
          streamKind: "branch",
          streamId: "branch-1",
          journalEpoch: "epoch-1",
          sequence: 14,
          eventId: "event-14",
          payloadHash: "hash-14",
        },
      ],
    },
    editRevisionId: null,
    continuationIntent: "unfinished-answer",
    activeRunPolicy: "queue-after-terminal",
    expectedActiveRunId: "run-source",
    expectedConversationVersion: 4,
    expectedBranchCursor: {
      streamKind: "branch",
      streamId: "branch-1",
      journalEpoch: "epoch-1",
      sequence: 13,
      eventId: "event-13",
      payloadHash: "hash-13",
    },
    compareStateRevisionIds: [],
    mergeStateRevisionIds: [],
    result: { resultStateRevisionId: "state_revision_result" },
    actor: { kind: "user", id: "user-1" },
    idempotencyKey: "idempotency-state-base",
    createdAt: "2026-09-19T08:29:00.000Z",
  },
} as unknown as RunControlOperationProjection;

const graph = {
  schemaVersion: 1,
  streamId: "stream-1",
  conversationId: "conversation-1",
  branchId: "branch-1",
  acceptedHeadStateRevisionId: "state_revision_2",
  acceptedHeadBranchSequence: 2,
  throughBranchSequence: 2,
  revisions: [
    { id: "state_revision_1", kind: "root", status: "accepted", branchSequence: 1, stateDigest: "digest-1", parentStateRevisionIds: [], observedHeadStateRevisionId: null, expectedHeadStateRevisionId: null, createdAtMs: Date.parse("2026-09-19T08:00:00.000Z") },
    { id: "state_revision_2", kind: "continuation", status: "accepted", branchSequence: 2, stateDigest: "digest-2", parentStateRevisionIds: ["state_revision_1"], observedHeadStateRevisionId: "state_revision_1", expectedHeadStateRevisionId: "state_revision_1", createdAtMs: Date.parse("2026-09-19T08:30:00.000Z") },
  ],
  edges: [{ id: "edge-1", kind: "continues-from", fromStateRevisionId: "state_revision_1", toStateRevisionId: "state_revision_2", operationId: "operation_state_base", policyRevisionId: "policy-1", createdAtMs: Date.parse("2026-09-19T08:30:00.000Z") }],
  integrity: "valid",
  revisionsHasMore: false,
  edgesHasMore: false,
  nextRevisionsCursor: null,
  nextEdgesCursor: null,
  revisionsLimit: 50,
  edgesLimit: 50,
  responseBytes: 1024,
} as unknown as StateRevisionGraphSnapshot;

describe("StateBaseCursorWorkbench", () => {
  it("keeps browser preview fail-closed when no native receipt exists", () => {
    render(<StateBaseCursorWorkbench />);

    expect(screen.getByRole("heading", { name: "State base & cursor workbench" })).toBeInTheDocument();
    expect(screen.getByText(/No canonical state base is hydrated/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Cursors" }));
    expect(screen.getByText(/No cursor provenance is hydrated/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "CAS guard" }));
    expect(screen.getByText(/No branch-head CAS receipt is hydrated/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Revision graph" }));
    expect(screen.getByText(/Browser preview does not call the native graph-read command/i)).toBeInTheDocument();
  });

  it("renders state-base, cursor, CAS, and fixed-watermark graph evidence from typed projections", () => {
    const onRefreshGraph = vi.fn();
    render(<StateBaseCursorWorkbench operation={operation} graph={graph} runtime="desktop" onRefreshGraph={onRefreshGraph} />);

    expect(screen.getByText("exact historical")).toBeInTheDocument();
    expect(screen.getByText("state_revision_resolved")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Cursors" }));
    expect(screen.getByText("Expected branch cursor")).toBeInTheDocument();
    expect(screen.getByText("seq 14")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "CAS guard" }));
    expect(screen.getByText("Expected")).toBeInTheDocument();
    expect(screen.getByText("state_revision_result")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Revision graph" }));
    const panel = screen.getByRole("tabpanel");
    expect(within(panel).getByText(/Fixed-watermark native projection/i)).toBeInTheDocument();
    expect(within(panel).getByText(/continues from/i)).toBeInTheDocument();
    expect(within(panel).getByText(/through sequence 2/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Request bounded graph read/i })).not.toBeInTheDocument();
    expect(onRefreshGraph).not.toHaveBeenCalled();
  });

  it("offers a bounded graph refresh affordance without implying a read occurred", () => {
    const onRefreshGraph = vi.fn();
    render(<StateBaseCursorWorkbench runtime="desktop" onRefreshGraph={onRefreshGraph} />);
    fireEvent.click(screen.getByRole("tab", { name: "Revision graph" }));
    fireEvent.click(screen.getByRole("button", { name: /Request bounded graph read/i }));
    expect(onRefreshGraph).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Graph unknown · no native read/i)).toBeInTheDocument();
  });

  it("supports roving keyboard navigation across state authority tabs", () => {
    render(<StateBaseCursorWorkbench />);

    const stateBaseTab = screen.getByRole("tab", { name: "State base" });
    stateBaseTab.focus();
    fireEvent.keyDown(stateBaseTab, { key: "ArrowRight" });
    const cursorsTab = screen.getByRole("tab", { name: "Cursors" });
    expect(cursorsTab).toHaveFocus();
    expect(cursorsTab).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(cursorsTab, { key: "End" });
    const graphTab = screen.getByRole("tab", { name: "Revision graph" });
    expect(graphTab).toHaveFocus();
    expect(graphTab).toHaveAttribute("tabindex", "0");
  });
});
