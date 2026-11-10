import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { ResolvedRunControlOperation, RunTelemetrySnapshot } from "@/lib/desktop";

import { ContextInspectorPanel } from "./inspector";
import { projectResolvedRunControlOperation } from "./run-control-projection";
import { useWorkspaceStore } from "./store";
import type { ConversationView } from "./types";

const initialState = useWorkspaceStore.getState();

function conversation(): ConversationView {
  return {
    id: "conversation_telemetry",
    activeBranchId: "branch_telemetry",
    title: "Telemetry test",
    excerpt: "Telemetry test",
    updatedAt: "2026-08-14T00:00:00.000Z",
    updatedLabel: "Now",
    projectId: null,
    projectName: null,
    pinned: false,
    archived: false,
    hasDraft: false,
    unread: false,
    runState: null,
    draft: "",
    messages: [
      {
        id: "message_telemetry",
        role: "assistant",
        content: "Observed answer",
        createdAt: "2026-08-14T00:00:01.000Z",
        status: "complete",
        modelLabel: "prepared-model",
        runId: "run_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        attachments: [],
        branchIndex: 1,
        branchCount: 1,
      },
    ],
  };
}

function telemetry(): RunTelemetrySnapshot {
  return {
    schemaVersion: 1,
    runId: "run_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    attempts: [
      {
        attemptId: "attempt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ordinal: 1,
        providerProfileId: "provider_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        modelId: "prepared-model",
        state: "complete",
        acceptedByProvider: "true",
        errorCode: null,
        startedAtMs: 1_786_800_000_000,
        completedAtMs: 1_786_800_000_120,
        createdAtMs: 1_786_800_000_000,
        timingObservations: [],
        usageLedger: [
          {
            sequence: 1,
            source: "provider-incremental",
            authoritative: false,
            coverage: "partial",
            observedAtMs: 1_786_800_000_100,
            counters: {
              inputTokens: 21,
              cacheReadInputTokens: 5,
              cacheWriteInputTokens: null,
              outputTokens: 13,
              reasoningTokens: 3,
              visibleOutputTokens: null,
            },
            costStatementCount: 0,
          },
        ],
      },
    ],
    readAtMs: 1_786_800_000_200,
  };
}

function runControlReceipt(): ResolvedRunControlOperation {
  return {
    schemaVersion: 2,
    operationId: "operation_continue_aaaaaaaaaaaaaaaaaaaaaa",
    receiptId: "receipt_continue_aaaaaaaaaaaaaaaaaaaaaaa",
    authorityContinuityRecordId: null,
    kind: "continue",
    operationState: "resolved",
    conversationId: "conversation_telemetry",
    branchId: "branch_telemetry",
    sourceRunId: "run_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    sourceAttemptId: null,
    sourceMessageId: null,
    sourcePromptRevisionId: null,
    stateBase: {
      mode: "current-state",
      sourceStateRevisionId: null,
      requestedHeadStateRevisionId: null,
      resolvedStateRevisionId: "state_revision_telemetry",
      resolvedStateDigest: {
        algorithm: "sha-256",
        canonicalizationRevision: "run-control-test-v1",
        value: "a".repeat(64),
      },
      selectedDeltaIds: [],
      contextManifestId: null,
      resolutionReason: "current-branch-head",
      resolvedAt: "2026-08-14T00:00:02.000Z",
      resolvedAtCursors: [],
    },
    editRevisionId: null,
    continuationIntent: "unfinished-answer",
    activeRunPolicy: "queue-after-terminal",
    expectedActiveRunId: null,
    expectedConversationVersion: null,
    expectedBranchCursor: null,
    compareStateRevisionIds: [],
    mergeStateRevisionIds: [],
    result: {
      resultStateRevisionId: null,
      resultRunId: "run_result_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      resultAttemptId: "attempt_result_aaaaaaaaaaaaaaaaaaaaaaaa",
      resultCheckpointId: null,
      resultBranchId: null,
      blockedReason: null,
      diagnosticId: "diagnostic_aaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
    actor: { kind: "user", id: "test-user" },
    idempotencyKey: "idempotency_continue_aaaaaaaaaaaaaaa",
    createdAt: "2026-08-14T00:00:02.000Z",
  };
}

describe("Run inspector native telemetry projection", () => {
  afterEach(() => {
    useWorkspaceStore.setState(initialState, true);
    document.body.innerHTML = "";
  });

  it("shows real partial provider usage while keeping missing timing and cost explicit", () => {
    const active = conversation();
    useWorkspaceStore.setState({
      activeConversationId: active.id,
      conversations: [active],
      activeRun: null,
      inspectorOpen: true,
      inspectorTab: "run",
      runTelemetryByRunId: { [telemetry().runId]: telemetry() },
    });

    render(<ContextInspectorPanel />);

    expect(screen.getByText("Provider stream usage")).toBeInTheDocument();
    expect(screen.getByText(/provider-incremental · partial · non-authoritative/)).toBeInTheDocument();
    expect(screen.getByText("No native statement")).toBeInTheDocument();
    expect(screen.getByText("21")).toBeInTheDocument();
    expect(screen.getByText(/Timing, throughput, RPM\/TPM, quota\/health/)).toBeInTheDocument();
    expect(screen.queryByText("Not calculated")).not.toBeInTheDocument();
  });

  it("keeps a counter-bearing provider-final observation visible when a later invoice is cost-only", () => {
    const active = conversation();
    const base = telemetry();
    const finalObservation = {
      ...base.attempts[0]!.usageLedger[0]!,
      sequence: 2,
      source: "provider-final" as const,
      authoritative: true,
      coverage: "complete" as const,
      counters: {
        inputTokens: 34,
        cacheReadInputTokens: 8,
        cacheWriteInputTokens: 3,
        outputTokens: 21,
        reasoningTokens: 5,
        visibleOutputTokens: 16,
      },
      costStatementCount: 0,
    };
    const invoiceObservation = {
      ...finalObservation,
      sequence: 3,
      source: "provider-invoice" as const,
      counters: {
        inputTokens: null,
        cacheReadInputTokens: null,
        cacheWriteInputTokens: null,
        outputTokens: null,
        reasoningTokens: null,
        visibleOutputTokens: null,
      },
      costStatementCount: 1,
    };
    const snapshot: RunTelemetrySnapshot = {
      ...base,
      attempts: [{ ...base.attempts[0]!, usageLedger: [finalObservation, invoiceObservation] }],
    };
    useWorkspaceStore.setState({
      activeConversationId: active.id,
      conversations: [active],
      activeRun: null,
      inspectorOpen: true,
      inspectorTab: "run",
      runTelemetryByRunId: { [snapshot.runId]: snapshot },
    });

    render(<ContextInspectorPanel />);

    const usage = screen.getByTestId("run-usage-observation");
    expect(usage).toHaveTextContent("provider-final · complete · authoritative · sequence 2");
    expect(usage).toHaveTextContent("34");
    expect(usage).toHaveTextContent("21");
    expect(usage).not.toHaveTextContent("provider-invoice · complete · authoritative · sequence 3");
  });

  it("shows native run-control receipts without turning them into active controls", () => {
    const active = conversation();
    const operation = projectResolvedRunControlOperation(runControlReceipt());
    useWorkspaceStore.setState({
      activeConversationId: active.id,
      conversations: [active],
      activeRun: null,
      inspectorOpen: true,
      inspectorTab: "run",
      runControlOperationsById: { [operation.operation.operationId]: operation },
    });

    render(<ContextInspectorPanel />);

    expect(screen.getByTestId("run-control-receipts")).toBeInTheDocument();
    expect(screen.getByText("Run-control receipts")).toBeInTheDocument();
    expect(screen.getByText("continue")).toBeInTheDocument();
    expect(screen.getByText("resolved")).toBeInTheDocument();
    expect(screen.getByText("unknown")).toBeInTheDocument();
    expect(screen.getByText("receipt_continue_aaaaaaaaaaaaaaaaaaaaaaa")).toBeInTheDocument();
    expect(screen.getByText("current-state")).toBeInTheDocument();
    expect(screen.getByText("current-branch-head")).toBeInTheDocument();
    expect(screen.getByText("run_result_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBeInTheDocument();
    expect(screen.getByText("attempt_result_aaaaaaaaaaaaaaaaaaaaaaaa")).toBeInTheDocument();
    expect(screen.getByText("diagnostic_aaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBeInTheDocument();
    expect(screen.getByText("Cursors", { exact: true })).toBeInTheDocument();
    expect(screen.getByText("Created", { exact: true })).toBeInTheDocument();
    expect(screen.getByText("Resolved", { exact: true })).toBeInTheDocument();
    expect(screen.getByText(/Controls remain unavailable until a complete native receipt/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /pause|resume|continue|retry/i })).not.toBeInTheDocument();
  });
});
