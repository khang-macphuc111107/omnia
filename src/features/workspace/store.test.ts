import { describe, expect, it } from "vitest";

import {
  activeDraftAttachments,
  createId,
  draftAttachmentsForConversation,
  useWorkspaceStore,
} from "./store";
import type { AttachmentView } from "./types";
import type {
  ContinuationIntent,
  MessageRevision,
  ResolvedRunControlOperation,
  RunCheckpointRecord,
  RunTelemetrySnapshot,
} from "@/lib/desktop";
import {
  bridgePlanProjectionFromNativeState,
  type NativeMultimodalBridgeState,
} from "./multimodal-bridge-projection";
import {
  projectResolvedRunControlOperation,
  projectRunControlApply,
} from "./run-control-projection";
import { pendingRunJournalHandoff } from "./run-journal-handoff";

const rendererOwnedKeys = [
  "activeActivity",
  "modelProfileId",
  "composerMode",
  "theme",
  "density",
  "motion",
  "sidebarOpen",
  "inspectorOpen",
  "inspectorTab",
  "parameters",
];

describe("workspace store persistence boundary", () => {
  it("prepares a Project Chat draft only for an empty, available Chat without changing the active Chat", () => {
    const previous = useWorkspaceStore.getState();
    const projectId = previous.projects[0]!.id;
    const source = previous.conversations[0]!;
    const empty = { ...source, id: "empty-project-chat", projectId, draft: "", hasDraft: false, archived: false, runState: null };
    const occupied = { ...source, id: "occupied-project-chat", projectId, draft: "Keep my work", hasDraft: true, archived: false, runState: null };
    const elsewhere = { ...source, id: "other-project-chat", projectId: "other-project", draft: "", hasDraft: false, archived: false, runState: null };
    try {
      useWorkspaceStore.setState({ conversations: [empty, occupied, elsewhere], activeConversationId: occupied.id });
      const store = useWorkspaceStore.getState();
      expect(store.prepareConversationDraft(empty.id, "other-project", "Task draft")).toBe("wrong-project");
      expect(store.prepareConversationDraft(occupied.id, projectId, "Task draft")).toBe("occupied");
      expect(store.prepareConversationDraft(elsewhere.id, projectId, "Task draft")).toBe("wrong-project");
      expect(store.prepareConversationDraft(elsewhere.id, "other-project", "Task draft")).toBe("unavailable");
      expect(store.prepareConversationDraft("missing-chat", projectId, "Task draft")).toBe("missing-chat");
      expect(store.prepareConversationDraft(empty.id, projectId, "Task draft")).toBe("prepared");
      expect(store.prepareConversationDraft(empty.id, projectId, "Again")).toBe("occupied");
      expect(useWorkspaceStore.getState().activeConversationId).toBe(occupied.id);
      expect(useWorkspaceStore.getState().conversations.map((chat) => [chat.id, chat.draft])).toEqual([
        [empty.id, "Task draft"], [occupied.id, "Keep my work"], [elsewhere.id, ""],
      ]);
    } finally {
      useWorkspaceStore.setState(previous, true);
    }
  });

  it.each(["run", "message", "attempt"])(
    "creates native-compatible %s identifiers",
    (prefix) => {
      expect(createId(prefix)).toMatch(new RegExp(`^${prefix}_[a-f0-9]{32}$`, "i"));
    },
  );

  it("persists presentation settings without duplicating native-owned records", () => {
    const partialize = useWorkspaceStore.persist.getOptions().partialize;
    expect(partialize).toBeTypeOf("function");

    const persisted = partialize!(useWorkspaceStore.getState()) as Record<string, unknown>;
    expect(Object.keys(persisted).sort()).toEqual([...rendererOwnedKeys].sort());
    expect(persisted).not.toHaveProperty("conversations");
    expect(persisted).not.toHaveProperty("projects");
    expect(persisted).not.toHaveProperty("providers");
    expect(persisted).not.toHaveProperty("memories");
    expect(persisted).not.toHaveProperty("skills");
    expect(persisted).not.toHaveProperty("artifacts");
    expect(persisted).not.toHaveProperty("attachments");
    expect(persisted).not.toHaveProperty("citations");
    expect(persisted).not.toHaveProperty("runTimelineEvents");
    expect(persisted).not.toHaveProperty("draftAttachmentIdsByConversation");
    expect(persisted).not.toHaveProperty("activeRun");
    expect(persisted).not.toHaveProperty("runTelemetryByRunId");
    expect(persisted).not.toHaveProperty("runControlOperationsById");
    expect(persisted).not.toHaveProperty("checkpointsByRunId");
    expect(persisted).not.toHaveProperty("continuationIntentsById");
    expect(persisted).not.toHaveProperty("messageRevisionsByMessageId");
    expect(persisted).not.toHaveProperty("multimodalBridgePlansByRunId");
  });

  it("drops native-owned records while migrating legacy renderer state", async () => {
    const migrate = useWorkspaceStore.persist.getOptions().migrate;
    expect(migrate).toBeTypeOf("function");

    const migrated = await migrate!(
      {
        activeActivity: "settings",
        theme: "dark",
        conversations: [{ id: "conversation-sensitive", draft: "private prompt" }],
        projects: [{ id: "project-sensitive" }],
        providers: [{ id: "provider-sensitive", endpoint: "https://private.example" }],
        parameters: { temperature: 0.2 },
      },
      3,
    );

    expect(migrated).toMatchObject({
      activeActivity: "settings",
      theme: "dark",
      parameters: expect.objectContaining({ temperature: 0.2, topP: 0.95 }),
    });
    expect(migrated).not.toHaveProperty("conversations");
    expect(migrated).not.toHaveProperty("projects");
    expect(migrated).not.toHaveProperty("providers");
  });

  it("normalizes malformed current-version appearance values during persisted-state merge", () => {
    const merge = useWorkspaceStore.persist.getOptions().merge;
    expect(merge).toBeTypeOf("function");

    const merged = merge!(
      { theme: "neon", density: "huge", motion: "always" },
      useWorkspaceStore.getState(),
    );

    expect(merged).toMatchObject({
      theme: "system",
      density: "comfortable",
      motion: "system",
    });
  });

  it("does not restore one-shot Project settings context from stored preferences", () => {
    const merge = useWorkspaceStore.persist.getOptions().merge;
    expect(merge).toBeTypeOf("function");
    const project = useWorkspaceStore.getState().projects[0]!;
    const merged = merge!(
      { activeActivity: "settings", settingsProjectId: project.id },
      useWorkspaceStore.getState(),
    );
    expect(merged).toMatchObject({ activeActivity: "settings", settingsProjectId: null });
  });

  it("drops a Project settings context when the authoritative Project disappears", () => {
    const previous = useWorkspaceStore.getState();
    const [selected] = previous.projects;
    expect(selected).toBeDefined();
    try {
      previous.openProjectSettings(selected!.id);
      useWorkspaceStore.getState().replaceProjects([...previous.projects]);
      expect(useWorkspaceStore.getState().settingsProjectId).toBe(selected!.id);

      useWorkspaceStore.getState().replaceProjects(previous.projects.filter((project) => project.id !== selected!.id));
      expect(useWorkspaceStore.getState().settingsProjectId).toBeNull();
    } finally {
      useWorkspaceStore.setState(previous, true);
    }
  });

  it("clears preview-owned data before native hydration", () => {
    const operation = projectResolvedRunControlOperation(nativeRunControlOperation());
    const checkpoint = nativeCheckpoint();
    const continuationIntent = nativeContinuationIntent();
    const messageRevision = nativeMessageRevision();
    const project = useWorkspaceStore.getState().projects[0]!;
    useWorkspaceStore.setState({ settingsProjectId: project.id });
    useWorkspaceStore.setState({
      runControlOperationsById: { [operation.operation.operationId]: operation },
      checkpointsByRunId: { [checkpoint.runId]: {
        checkpoint: checkpoint,
        resumable: true,
        reconciliationRequired: false,
        warning: null,
      } },
      continuationIntentsById: { [continuationIntent.intentId]: continuationIntent },
      messageRevisionsByMessageId: { [messageRevision.messageId]: [messageRevision] },
    });
    useWorkspaceStore.getState().prepareDesktopPreview();
    const state = useWorkspaceStore.getState();

    expect(state.activeConversationId).toBe("");
    expect(state.activeProjectId).toBe("");
    expect(state.settingsProjectId).toBeNull();
    expect(state.conversations).toEqual([]);
    expect(state.projects).toEqual([]);
    expect(state.providers).toEqual([]);
    expect(state.memories).toEqual([]);
    expect(state.skills).toEqual([]);
    expect(state.artifacts).toEqual([]);
    expect(state.attachments).toEqual([]);
    expect(state.citations).toEqual([]);
    expect(state.runTimelineEvents).toEqual([]);
    expect(state.runTelemetryByRunId).toEqual({});
    expect(state.runControlOperationsById).toEqual({});
    expect(state.checkpointsByRunId).toEqual({});
    expect(state.continuationIntentsById).toEqual({});
    expect(state.messageRevisionsByMessageId).toEqual({});
    expect(state.multimodalBridgePlansByRunId).toEqual({});
    expect(state.draftAttachmentIdsByConversation).toEqual({});
    expect(state.activeRun).toBeNull();
  });

  it("replaces native telemetry snapshots by run without persisting them", () => {
    const previous = useWorkspaceStore.getState().runTelemetryByRunId;
    const first: RunTelemetrySnapshot = {
      schemaVersion: 1,
      runId: "run_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      attempts: [],
      readAtMs: 1_786_800_000_000,
    };
    const replacement: RunTelemetrySnapshot = {
      ...first,
      readAtMs: first.readAtMs + 1,
    };

    useWorkspaceStore.getState().upsertRunTelemetry(first);
    useWorkspaceStore.getState().upsertRunTelemetry(replacement);

    expect(useWorkspaceStore.getState().runTelemetryByRunId).toEqual({
      [first.runId]: replacement,
    });
    const persisted = useWorkspaceStore.persist.getOptions().partialize!(
      useWorkspaceStore.getState(),
    ) as Record<string, unknown>;
    expect(persisted).not.toHaveProperty("runTelemetryByRunId");

    useWorkspaceStore.setState({ runTelemetryByRunId: previous });
  });

  it("keeps replay-to-live handoff health renderer-local and replaceable", () => {
    const previous = useWorkspaceStore.getState().runJournalCoverage;
    const runId = "run_handoff_0123456789abcdef0123456789abcdef";
    try {
      useWorkspaceStore.getState().setRunJournalHandoff(
        runId,
        pendingRunJournalHandoff({ events: [], overflowed: false, conflict: null }),
      );
      expect(useWorkspaceStore.getState().runJournalCoverage[runId]).toMatchObject({
        coverage: "legacy-partial",
        handoff: { status: "pending" },
      });

      useWorkspaceStore.getState().setRunJournalHandoff(runId, null);
      expect(useWorkspaceStore.getState().runJournalCoverage[runId]?.handoff).toBeNull();
    } finally {
      useWorkspaceStore.setState({ runJournalCoverage: previous });
    }
  });

  it("keeps metadata-only bridge evidence transient and keyed by native run", () => {
    const previous = useWorkspaceStore.getState().multimodalBridgePlansByRunId;
    const projection = bridgePlanProjectionFromNativeState(nativeBridgeState());

    useWorkspaceStore.getState().upsertMultimodalBridgePlan(projection);

    expect(useWorkspaceStore.getState().multimodalBridgePlansByRunId).toEqual({
      [projection.runId]: projection,
    });
    const persisted = useWorkspaceStore.persist.getOptions().partialize!(
      useWorkspaceStore.getState(),
    ) as Record<string, unknown>;
    expect(persisted).not.toHaveProperty("multimodalBridgePlansByRunId");

    useWorkspaceStore.setState({ multimodalBridgePlansByRunId: previous });
  });

  it("keeps duplicate native run-control replays idempotent under one operation ID", () => {
    const previous = useWorkspaceStore.getState().runControlOperationsById;
    const resolved = projectResolvedRunControlOperation(nativeRunControlOperation());
    const replayed = projectRunControlApply({
      operation: {
        ...resolved.operation,
        operationState: "applied",
        result: {
          resultStateRevisionId: "state_revision_result",
          resultRunId: "run_control_result",
        },
      },
      durable: true,
      stateRevisionId: "state_revision_result",
      replayed: true,
      diagnostic: "idempotent replay",
    });

    const actions = useWorkspaceStore.getState();
    actions.upsertRunControlOperation(resolved);
    actions.upsertRunControlOperation(replayed);
    actions.upsertRunControlOperation(replayed);

    const state = useWorkspaceStore.getState();
    expect(Object.keys(state.runControlOperationsById)).toEqual([resolved.operation.operationId]);
    expect(state.runControlOperationsById[resolved.operation.operationId]).toMatchObject({
      status: "already-applied",
      durability: "replayed",
      stateRevisionId: "state_revision_result",
    });

    useWorkspaceStore.setState({ runControlOperationsById: previous });
  });

  it("keeps a checkpoint ID immutable and retains the newest checkpoint read", () => {
    const previous = useWorkspaceStore.getState().checkpointsByRunId;
    const runId = "run_checkpoint_store";
    const first = nativeCheckpoint({
      runId,
      checkpointId: "checkpoint_first",
      createdAt: "2026-08-12T00:00:00.000Z",
    });
    const successor = nativeCheckpoint({
      runId,
      checkpointId: "checkpoint_successor",
      createdAt: "2026-08-12T00:00:01.000Z",
      stateRevisionId: "state_revision_successor",
    });
    const driftedSameId = nativeCheckpoint({
      ...first,
      status: "invalidated",
      createdAt: "2026-08-12T00:00:02.000Z",
    });
    const actions = useWorkspaceStore.getState();

    actions.upsertRunCheckpoint(first);
    const firstProjection = useWorkspaceStore.getState().checkpointsByRunId[runId];
    actions.upsertRunCheckpoint(driftedSameId);
    expect(useWorkspaceStore.getState().checkpointsByRunId[runId]).toBe(firstProjection);
    expect(useWorkspaceStore.getState().checkpointsByRunId[runId]?.checkpoint.status).toBe("paused");

    actions.upsertRunCheckpoint(successor);
    expect(useWorkspaceStore.getState().checkpointsByRunId[runId]?.checkpoint.checkpointId).toBe(
      successor.checkpointId,
    );
    actions.upsertRunCheckpoint(first);
    expect(useWorkspaceStore.getState().checkpointsByRunId[runId]?.checkpoint.checkpointId).toBe(
      successor.checkpointId,
    );

    useWorkspaceStore.setState({ checkpointsByRunId: previous });
  });

  it("stores continuation intents once and preserves immutable message revisions", () => {
    const previousIntents = useWorkspaceStore.getState().continuationIntentsById;
    const previousRevisions = useWorkspaceStore.getState().messageRevisionsByMessageId;
    const intent = nativeContinuationIntent();
    const revision = nativeMessageRevision();
    const actions = useWorkspaceStore.getState();

    actions.upsertContinuationIntent(intent);
    actions.upsertContinuationIntent({ ...intent });
    actions.upsertContinuationIntent({ ...intent, stateRevisionId: "state_revision_conflicting" });
    expect(Object.keys(useWorkspaceStore.getState().continuationIntentsById)).toEqual([intent.intentId]);
    expect(useWorkspaceStore.getState().continuationIntentsById[intent.intentId]).toBe(intent);

    actions.upsertMessageRevision(revision);
    actions.upsertMessageRevision({ ...revision });
    actions.upsertMessageRevision({
      ...revision,
      contentHash: "b".repeat(64),
    });
    expect(useWorkspaceStore.getState().messageRevisionsByMessageId[revision.messageId]).toEqual([revision]);

    useWorkspaceStore.setState({
      continuationIntentsById: previousIntents,
      messageRevisionsByMessageId: previousRevisions,
    });
  });

  it("treats equivalent message-revision payloads with reordered keys as the same replay", () => {
    const previousRevisions = useWorkspaceStore.getState().messageRevisionsByMessageId;
    const revision = nativeMessageRevision();
    const reordered = {
      createdAt: revision.createdAt,
      redactionClass: revision.redactionClass,
      contentHash: revision.contentHash,
      destinationBranchId: revision.destinationBranchId,
      sourceCursor: revision.sourceCursor,
      parentRevisionId: revision.parentRevisionId,
      effect: revision.effect,
      kind: revision.kind,
      messageId: revision.messageId,
      revisionId: revision.revisionId,
      schemaVersion: revision.schemaVersion,
    } satisfies MessageRevision;
    const actions = useWorkspaceStore.getState();

    actions.upsertMessageRevision(revision);
    actions.upsertMessageRevision(reordered);

    expect(useWorkspaceStore.getState().messageRevisionsByMessageId[revision.messageId]).toEqual([revision]);
    useWorkspaceStore.setState({ messageRevisionsByMessageId: previousRevisions });
  });

  it("does not let a stale bridge read erase immutable receipts or replace a successor plan", () => {
    const previous = useWorkspaceStore.getState().multimodalBridgePlansByRunId;
    const base = nativeBridgeState();
    const stale = bridgePlanProjectionFromNativeState(base);
    const observed = bridgePlanProjectionFromNativeState({
      ...base,
      stageReceipts: [
        {
          id: "bridge_stage_receipt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          schemaVersion: 1,
          planId: base.plan.id,
          stageId: "local-transform",
          attemptNo: 1,
          stageKind: "local-transform",
          status: "planned",
          boundary: "local-only",
          sourceManifestSha256: base.plan.sourceManifestSha256,
          outputManifestSha256: null,
          capabilitySnapshotRevisionId: base.plan.capabilitySnapshotRevisionId,
          policyRevisionId: base.plan.policyRevisionId,
          providerAcceptance: "not-applicable",
          reconciliationStatus: "not-required",
          derivativeSha256: [],
          fidelityDisposition: "planned",
          receiptSha256: "d".repeat(64),
          startedAtMs: base.plan.createdAtMs,
          completedAtMs: null,
          createdAtMs: base.plan.createdAtMs,
        },
      ],
    });
    const successorState = {
      ...base,
      plan: {
        ...base.plan,
        id: "bridge_plan_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        supersedesPlanId: base.plan.id,
        planSha256: "e".repeat(64),
        createdAtMs: base.plan.createdAtMs + 1,
      },
      artifacts: base.artifacts.map((artifact) => ({
        ...artifact,
        planId: "bridge_plan_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        createdAtMs: artifact.createdAtMs + 1,
      })),
    } satisfies NativeMultimodalBridgeState;
    const successor = bridgePlanProjectionFromNativeState(successorState);

    const actions = useWorkspaceStore.getState();
    actions.upsertMultimodalBridgePlan(observed);
    actions.upsertMultimodalBridgePlan(stale);
    expect(useWorkspaceStore.getState().multimodalBridgePlansByRunId[observed.runId]).toBe(observed);

    actions.upsertMultimodalBridgePlan({ ...observed, planSha256: "f".repeat(64) });
    expect(useWorkspaceStore.getState().multimodalBridgePlansByRunId[observed.runId]).toBe(observed);

    actions.upsertMultimodalBridgePlan(successor);
    expect(useWorkspaceStore.getState().multimodalBridgePlansByRunId[observed.runId]).toBe(successor);

    useWorkspaceStore.setState({ multimodalBridgePlansByRunId: previous });
  });

  it("keeps draft attachment selection scoped to one conversation", () => {
    const first = attachment("attachment_first");
    const second = attachment("attachment_second");
    useWorkspaceStore.setState({
      activeConversationId: "conversation_first",
      attachments: [first, second],
      draftAttachmentIdsByConversation: {},
    });

    const actions = useWorkspaceStore.getState();
    actions.attachDraftAttachment("conversation_first", first.id);
    actions.attachDraftAttachment("conversation_first", first.id);
    actions.attachDraftAttachment("conversation_second", second.id);

    expect(draftAttachmentsForConversation(useWorkspaceStore.getState(), "conversation_first")).toEqual([
      first,
    ]);
    expect(draftAttachmentsForConversation(useWorkspaceStore.getState(), "conversation_second")).toEqual([
      second,
    ]);
    expect(activeDraftAttachments(useWorkspaceStore.getState())).toEqual([first]);
  });

  it("removes a deleted native attachment from every draft selection", () => {
    const selected = attachment("attachment_selected");
    useWorkspaceStore.setState({
      attachments: [selected],
      draftAttachmentIdsByConversation: {
        conversation_first: [selected.id],
        conversation_second: [selected.id],
      },
    });

    useWorkspaceStore.getState().upsertAttachment({
      ...selected,
      deletedAt: "2026-08-12T00:00:00.000Z",
    });

    expect(useWorkspaceStore.getState().attachments).toEqual([]);
    expect(useWorkspaceStore.getState().draftAttachmentIdsByConversation).toEqual({});
  });

  it("reconciles catalog refreshes and prunes stale draft references", () => {
    const retained = attachment("attachment_retained", "2026-08-12T00:00:00.000Z");
    const newest = attachment("attachment_newest", "2026-08-12T00:00:01.000Z");
    useWorkspaceStore.setState({
      attachments: [retained],
      draftAttachmentIdsByConversation: {
        conversation_first: [retained.id, "attachment_missing"],
      },
    });

    useWorkspaceStore.getState().replaceAttachments([retained, newest]);

    expect(useWorkspaceStore.getState().attachments.map((item) => item.id)).toEqual([
      newest.id,
      retained.id,
    ]);
    expect(useWorkspaceStore.getState().draftAttachmentIdsByConversation).toEqual({
      conversation_first: [retained.id],
    });
  });

  it("hydrates open draft selections only for the conversation's active branch", () => {
    const retained = attachment("attachment_retained");
    const foreign = attachment("attachment_foreign");
    const conversation = {
      id: "conversation_hydrate",
      activeBranchId: "branch_current",
      title: "Hydration",
      excerpt: "",
      updatedAt: "2026-08-12T00:00:00.000Z",
      updatedLabel: "Now",
      projectId: null,
      projectName: null,
      pinned: false,
      archived: false,
      hasDraft: true,
      unread: false,
      runState: null,
      draft: "",
      messages: [],
    };
    useWorkspaceStore.setState({
      conversations: [conversation],
      attachments: [retained, foreign],
      draftAttachmentIdsByConversation: {
        conversation_hydrate: [foreign.id],
      },
    });

    useWorkspaceStore.getState().hydrateDraftAttachmentSelections([
      {
        conversationId: conversation.id,
        branchId: conversation.activeBranchId,
        attachmentIds: [retained.id, retained.id, "attachment_missing"],
      },
    ]);

    expect(useWorkspaceStore.getState().draftAttachmentIdsByConversation).toEqual({
      conversation_hydrate: [retained.id],
    });

    useWorkspaceStore.getState().hydrateDraftAttachmentSelections([
      {
        conversationId: conversation.id,
        branchId: "branch_foreign",
        attachmentIds: [foreign.id],
      },
    ]);
    expect(useWorkspaceStore.getState().draftAttachmentIdsByConversation).toEqual({});
  });

  it("drops draft selections when native conversation hydration changes the active branch", () => {
    const selected = attachment("attachment_branch_selected");
    const previous = {
      id: "conversation_branch_hydration",
      activeBranchId: "branch_before",
      title: "Branch",
      excerpt: "",
      updatedAt: "2026-08-12T00:00:00.000Z",
      updatedLabel: "Now",
      projectId: null,
      projectName: null,
      pinned: false,
      archived: false,
      hasDraft: true,
      unread: false,
      runState: null,
      draft: "",
      messages: [],
    };
    useWorkspaceStore.setState({
      conversations: [previous],
      attachments: [selected],
      draftAttachmentIdsByConversation: {
        [previous.id]: [selected.id],
      },
    });

    useWorkspaceStore.getState().upsertConversation({
      ...previous,
      activeBranchId: "branch_after",
    });

    expect(useWorkspaceStore.getState().draftAttachmentIdsByConversation).toEqual({});
  });

  it("moves selected draft attachments onto the submitted user message", () => {
    const selected = attachment("attachment_selected");
    useWorkspaceStore.setState({
      activeConversationId: "conversation_first",
      conversations: [
        {
          id: "conversation_first",
          activeBranchId: "branch_first",
          title: "Untitled conversation",
          excerpt: "Start a new conversation",
          updatedAt: "2026-08-12T00:00:00.000Z",
          updatedLabel: "Saved locally",
          projectId: null,
          projectName: null,
          pinned: false,
          archived: false,
          hasDraft: true,
          unread: false,
          runState: null,
          draft: "Inspect the source",
          messages: [],
        },
      ],
      attachments: [selected],
      draftAttachmentIdsByConversation: { conversation_first: [selected.id] },
      activeRun: null,
    });

    useWorkspaceStore.getState().startRun({
      conversationId: "conversation_first",
      runId: "run_first",
      userMessageId: "message_user",
      assistantMessageId: "message_assistant",
      prompt: "Inspect the source",
      attachments: [selected],
    });

    const state = useWorkspaceStore.getState();
    expect(state.draftAttachmentIdsByConversation).toEqual({});
    expect(state.attachments[0]?.messageId).toBe("message_user");
    expect(state.conversations[0]?.messages[0]?.attachments).toEqual([
      expect.objectContaining({ id: selected.id, messageId: "message_user" }),
    ]);
  });

  it("keeps a prepared run attached to its initiating conversation after navigation", () => {
    const previous = useWorkspaceStore.getState();
    const first = {
      ...previous.conversations[0]!,
      id: "conversation_first",
      title: "Untitled conversation",
      excerpt: "Start a new conversation",
      draft: "Inspect the source",
      hasDraft: true,
      runState: null,
      messages: [],
    };
    const second = {
      ...previous.conversations[0]!,
      id: "conversation_second",
      title: "Other conversation",
      excerpt: "Existing work",
      draft: "",
      hasDraft: false,
      runState: null,
      messages: [],
    };
    const selected = attachment("attachment_race");

    try {
      useWorkspaceStore.setState({
        activeConversationId: second.id,
        conversations: [first, second],
        attachments: [selected],
        draftAttachmentIdsByConversation: {
          [first.id]: [selected.id],
          [second.id]: [selected.id],
        },
        activeRun: null,
      });

      useWorkspaceStore.getState().startRun({
        conversationId: first.id,
        runId: "run_race",
        userMessageId: "message_race_user",
        assistantMessageId: "message_race_assistant",
        prompt: first.draft,
        attachments: [selected],
      });

      const state = useWorkspaceStore.getState();
      const firstAfter = state.conversations.find((conversation) => conversation.id === first.id);
      const secondAfter = state.conversations.find((conversation) => conversation.id === second.id);

      expect(state.activeRun?.conversationId).toBe(first.id);
      expect(firstAfter?.runState).toBe("streaming");
      expect(firstAfter?.messages.map((message) => message.id)).toEqual([
        "message_race_user",
        "message_race_assistant",
      ]);
      expect(secondAfter).toEqual(second);
      expect(state.draftAttachmentIdsByConversation).toEqual({
        [second.id]: [selected.id],
      });
    } finally {
      useWorkspaceStore.setState(previous, true);
    }
  });
});

function attachment(id: string, createdAt = "2026-08-12T00:00:00.000Z"): AttachmentView {
  return {
    id,
    projectId: null,
    messageId: null,
    blobId: "a".repeat(64),
    name: `${id}.pdf`,
    kind: "document",
    mediaType: "application/pdf",
    byteSize: 1024,
    size: "1.0 KB",
    state: "processing",
    extractionStatus: "pending",
    contentHash: "a".repeat(64),
    extractedContentHash: null,
    extractionVersion: null,
    origin: "picker",
    createdAt,
    deletedAt: null,
  };
}

function nativeBridgeState(): NativeMultimodalBridgeState {
  const digest = (character: string) => character.repeat(64);
  return {
    plan: {
      id: "bridge_plan_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      schemaVersion: 1,
      contractRevision: 2,
      runId: "run_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      attemptId: "attempt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      frozenProviderInputId: "provider_input_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      supersedesPlanId: null,
      requestedMode: "auto",
      resolvedMode: "local-transform",
      disposition: "ready",
      sourceManifestSha256: digest("a"),
      capabilitySnapshotRevisionId: "capability_snapshot_20260815",
      policyRevisionId: "policy_revision_20260815",
      dataBoundary: "local-only",
      egressDecision: "not-required",
      selectedReasonCodes: ["local-transform-approved"],
      rejectedAlternatives: [],
      decisiveFidelityDimensions: ["content"],
      fidelityProfile: "semantic-only",
      planSha256: digest("b"),
      createdAtMs: 1_786_905_600_000,
    },
    artifacts: [
      {
        planId: "bridge_plan_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ordinal: 0,
        attachmentId: "attachment_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        sourceSha256: digest("c"),
        sourceSelector: "page:1",
        modality: "pdf",
        mediaType: "application/pdf",
        byteSize: 512,
        createdAtMs: 1_786_905_600_000,
      },
    ],
    stageReceipts: [],
  };
}

function nativeRunControlOperation(): ResolvedRunControlOperation {
  return {
    schemaVersion: 2,
    operationId: "operation_retry_aaaaaaaaaaaaaaaaaaaaaaaa",
    receiptId: "receipt_retry_aaaaaaaaaaaaaaaaaaaaaaaa",
    authorityContinuityRecordId: null,
    kind: "retry",
    operationState: "resolved",
    conversationId: "conversation_run_control",
    branchId: "branch_run_control",
    sourceRunId: "run_run_control",
    sourceAttemptId: "attempt_run_control",
    sourceMessageId: "message_run_control",
    sourcePromptRevisionId: "revision_run_control",
    stateBase: {
      mode: "current-state",
      sourceStateRevisionId: "state_revision_source",
      requestedHeadStateRevisionId: "state_revision_requested",
      resolvedStateRevisionId: "state_revision_resolved",
      resolvedStateDigest: {
        algorithm: "sha-256",
        canonicalizationRevision: "run-control-test-v1",
        value: "a".repeat(64),
      },
      selectedDeltaIds: [],
      contextManifestId: null,
      resolutionReason: "current-branch-head",
      resolvedAt: "2026-08-12T00:00:00.000Z",
      resolvedAtCursors: [],
    },
    editRevisionId: null,
    continuationIntent: "none",
    activeRunPolicy: "not-applicable",
    expectedActiveRunId: null,
    expectedConversationVersion: null,
    expectedBranchCursor: null,
    compareStateRevisionIds: [],
    mergeStateRevisionIds: [],
    result: null,
    actor: { kind: "user", id: "test-user" },
    idempotencyKey: "idempotency_retry_aaaaaaaaaaaaaaaaaaaa",
    createdAt: "2026-08-12T00:00:00.000Z",
  };
}

function nativeCheckpoint(overrides: Partial<RunCheckpointRecord> = {}): RunCheckpointRecord {
  return {
    schemaVersion: 1,
    checkpointId: "checkpoint_default",
    runId: "run_checkpoint_default",
    attemptId: "attempt_checkpoint_default",
    agentInstanceId: "agent_checkpoint_default",
    stateRevisionId: "state_revision_checkpoint",
    status: "paused",
    disposition: "cooperative-checkpoint",
    cursor: 10,
    partialOutputPolicy: "durable-only",
    frozenProviderInputId: "provider_input_checkpoint_default",
    providerAcceptance: "accepted",
    pendingReconciliationIds: [],
    leaseEpoch: 1,
    telemetryWatermark: 10,
    contentHash: "a".repeat(64),
    idempotencyKey: "checkpoint_idempotency_default",
    createdAt: "2026-08-12T00:00:00.000Z",
    ...overrides,
  };
}

function nativeContinuationIntent(): ContinuationIntent {
  return {
    schemaVersion: 1,
    intentId: "intent_store_aaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    rootKind: "run",
    rootId: "run_checkpoint_default",
    intentKind: "unfinished-answer",
    stateRevisionId: "state_revision_checkpoint",
    executionMode: "execute",
    modelProfileId: "auto",
    effort: "deep",
    allowedToolIds: ["calculator"],
    budget: { maxTokens: 1000 },
    loopGuard: {
      chainId: "continuation_chain_aaaaaaaaaaaaaaaaaaaa",
      duplicateSignature: "duplicate_signature_store",
      maxAutomaticSegments: 5,
      progressScore: "0",
      noProgressCount: 0,
    },
    approvalPolicyRevision: "approval_policy_store_v1",
    createdAt: "2026-08-12T00:00:00.000Z",
  };
}

function nativeMessageRevision(): MessageRevision {
  return {
    schemaVersion: 1,
    revisionId: "message_revision_store_aaaaaaaaaaaaaaaa",
    messageId: "message_store_aaaaaaaaaaaaaaaaaaaaaaaa",
    kind: "assistant",
    effect: "retry-current-state",
    parentRevisionId: null,
    sourceCursor: 10,
    destinationBranchId: "branch_run_control",
    contentHash: "a".repeat(64),
    redactionClass: "none",
    createdAt: "2026-08-12T00:00:00.000Z",
  };
}
