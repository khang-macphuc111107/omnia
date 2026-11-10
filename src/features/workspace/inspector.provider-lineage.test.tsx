import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProviderAttemptLineageReceipt, RunTelemetrySnapshot } from "@/lib/desktop";

const { readLineage } = vi.hoisted(() => ({ readLineage: vi.fn() }));
vi.mock("@/lib/desktop", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/desktop")>();
  return {
    ...actual,
    isDesktopRuntime: () => true,
    desktop: { ...actual.desktop, readProviderAttemptLineage: readLineage },
  };
});

import { ContextInspectorPanel } from "./inspector";
import { useWorkspaceStore } from "./store";
import type { ConversationView } from "./types";

const initialState = useWorkspaceStore.getState();
const runId = "run_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const attemptId = "attempt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function fixture() {
  const conversation: ConversationView = {
    id: "conversation_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    activeBranchId: "branch_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    title: "Lineage", excerpt: "Lineage", updatedAt: "2026-09-24T00:00:00Z",
    updatedLabel: "Now", projectId: null, projectName: null, pinned: false,
    archived: false, hasDraft: false, unread: false, runState: null, draft: "",
    messages: [{
      id: "message_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", role: "assistant",
      content: "Answer", createdAt: "2026-09-24T00:00:00Z", status: "complete",
      modelLabel: "example-model", runId, attachments: [], branchIndex: 1, branchCount: 1,
    }],
  };
  const telemetry: RunTelemetrySnapshot = {
    schemaVersion: 1, runId, readAtMs: 1_790_000_000_000,
    attempts: [{
      attemptId, ordinal: 1, providerProfileId: "provider_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      modelId: "example-model", state: "complete", acceptedByProvider: "true",
      errorCode: null, startedAtMs: null, completedAtMs: null,
      createdAtMs: 1_790_000_000_000, timingObservations: [], usageLedger: [],
    }],
  };
  useWorkspaceStore.setState({
    activeConversationId: conversation.id,
    conversations: [conversation],
    activeRun: null,
    inspectorOpen: true,
    inspectorTab: "run",
    runTelemetryByRunId: { [runId]: telemetry },
  });
  return conversation;
}

describe("Run inspector provider-attempt lineage", () => {
  afterEach(() => {
    readLineage.mockReset();
    useWorkspaceStore.setState(initialState, true);
    document.body.innerHTML = "";
  });

  it("reads the exact native attempt and shows only redacted historical provenance", async () => {
    const receipt: ProviderAttemptLineageReceipt = {
      schemaVersion: 1,
      lineageFactId: "provider_lineage_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      frozenProviderInputId: "provider_input_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      runId, attemptId,
      providerProfileId: "provider_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      modelId: "example-model", providerDefinitionSchemaVersion: 1,
      providerDefinitionSha256: "a".repeat(64),
      endpointFingerprintSha256: "b".repeat(64),
      adapterRevision: "omnia-native-provider-adapters-v1",
      requestedEffort: null, effectiveEffort: null,
      resolvedParametersSha256: "c".repeat(64),
      inputContentSha256: "d".repeat(64),
      createdAtMs: 1_790_000_000_000,
    };
    readLineage.mockResolvedValue(receipt);
    const conversation = fixture();

    render(<ContextInspectorPanel />);

    expect(readLineage).toHaveBeenCalledWith({
      conversationId: conversation.id, branchId: conversation.activeBranchId,
      runId, attemptId,
    });
    expect(await screen.findByText("Preparation provenance")).toBeInTheDocument();
    expect(await screen.findByText(receipt.adapterRevision)).toBeInTheDocument();
    expect(screen.getByText(/does not prove the current provider configuration is dispatchable/)).toBeInTheDocument();
    expect(screen.queryByText(/provider_secret_|https:\/\/api\.example\.com/)).not.toBeInTheDocument();
  });

  it("keeps unavailable lineage explicit without substituting current profile values", async () => {
    readLineage.mockRejectedValue(new Error("provider row missing"));
    fixture();
    render(<ContextInspectorPanel />);
    expect(await screen.findByText(/Native attempt lineage unavailable for this run/)).toBeInTheDocument();
    expect(screen.queryByText(/provider row missing/)).not.toBeInTheDocument();
  });
});
