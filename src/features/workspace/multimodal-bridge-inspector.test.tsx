import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ContextInspectorPanel } from "./inspector";
import { MultimodalBridgeInspector } from "./multimodal-bridge-inspector";
import {
  bridgePlanProjectionFromNativeState,
  type NativeMultimodalBridgeState,
} from "./multimodal-bridge-projection";
import { useWorkspaceStore } from "./store";
import type { ConversationView } from "./types";

const initialState = useWorkspaceStore.getState();

function conversation(): ConversationView {
  return {
    id: "conversation_bridge_projection",
    activeBranchId: "branch_bridge_projection",
    title: "Bridge projection",
    excerpt: "Bridge projection",
    updatedAt: "2026-08-15T00:00:00.000Z",
    updatedLabel: "Now",
    projectId: null,
    projectName: null,
    pinned: false,
    archived: false,
    hasDraft: false,
    unread: false,
    runState: "streaming",
    draft: "",
    messages: [
      {
        id: "message_bridge_projection",
        role: "assistant",
        content: "Preparing bridge evidence",
        createdAt: "2026-08-15T00:00:00.000Z",
        status: "streaming",
        modelLabel: "Bridge test model",
        runId: "run_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        attachments: [],
        branchIndex: 1,
        branchCount: 1,
      },
    ],
  };
}

function bridgeState(): NativeMultimodalBridgeState {
  const digest = (character: string) => character.repeat(64);
  const planId = "bridge_plan_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  return {
    plan: {
      id: planId,
      schemaVersion: 1,
      contractRevision: 2,
      runId: "run_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      attemptId: "attempt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      frozenProviderInputId: "provider_input_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      supersedesPlanId: null,
      requestedMode: "auto",
      resolvedMode: "local-transform",
      disposition: "ready-with-degradation",
      sourceManifestSha256: digest("a"),
      capabilitySnapshotRevisionId: "capability_snapshot_20260815",
      policyRevisionId: "policy_revision_20260815",
      dataBoundary: "local-only",
      egressDecision: "not-required",
      selectedReasonCodes: ["local-fidelity-degraded"],
      rejectedAlternatives: [
        { mode: "direct-native", reasonCodes: ["provider-egress-not-approved"] },
      ],
      decisiveFidelityDimensions: ["layout", "provenance"],
      fidelityProfile: "semantic-only",
      planSha256: digest("b"),
      createdAtMs: 1_786_905_600_000,
    },
    artifacts: [
      {
        planId,
        ordinal: 0,
        attachmentId: "attachment_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        sourceSha256: digest("c"),
        sourceSelector: "page:7",
        modality: "pdf",
        mediaType: "application/pdf",
        byteSize: 2048,
        createdAtMs: 1_786_905_600_000,
      },
    ],
    stageReceipts: [
      {
        id: "bridge_stage_receipt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        schemaVersion: 1,
        planId,
        stageId: "local-transform",
        attemptNo: 1,
        stageKind: "local-transform",
        status: "running",
        boundary: "local-only",
        sourceManifestSha256: digest("a"),
        outputManifestSha256: null,
        capabilitySnapshotRevisionId: "capability_snapshot_20260815",
        policyRevisionId: "policy_revision_20260815",
        providerAcceptance: "not-applicable",
        reconciliationStatus: "not-required",
        derivativeSha256: [],
        fidelityDisposition: "processing",
        receiptSha256: digest("d"),
        startedAtMs: 1_786_905_600_100,
        completedAtMs: null,
        createdAtMs: 1_786_905_600_100,
      },
    ],
  };
}

describe("multimodal bridge inspector projection", () => {
  afterEach(() => {
    useWorkspaceStore.setState(initialState, true);
    document.body.innerHTML = "";
  });

  it("shows a live, expanded native plan without falsely reporting provider acceptance", () => {
    const active = conversation();
    const projection = bridgePlanProjectionFromNativeState(bridgeState());
    useWorkspaceStore.setState({
      activeConversationId: active.id,
      conversations: [active],
      activeRun: {
        id: projection.runId,
        conversationId: active.id,
        assistantMessageId: "message_bridge_projection",
        stage: "routing",
        startedAt: "2026-08-15T00:00:00.000Z",
      },
      inspectorOpen: true,
      inspectorTab: "run",
      multimodalBridgePlansByRunId: { [projection.runId]: projection },
    });

    render(<ContextInspectorPanel />);

    const bridgeInspector = screen.getByTestId("multimodal-bridge-inspector");
    expect(bridgeInspector).toBeInTheDocument();
    expect(within(bridgeInspector).getAllByText("Transforming locally")).toHaveLength(3);
    expect(within(bridgeInspector).getByText("Multimodal bridge")).toBeInTheDocument();
    expect(within(bridgeInspector).getByText("Provider acceptance")).toBeInTheDocument();
    expect(within(bridgeInspector).getByRole("region", { name: "Bridge stage timeline" })).toBeInTheDocument();
    expect(within(bridgeInspector).getByText("1 stage · receipt-derived")).toBeInTheDocument();
    expect(within(bridgeInspector).getAllByText("Not observed")).toHaveLength(2);
    expect(within(bridgeInspector).getByText(/generic model capability/i)).toBeInTheDocument();
    expect(within(bridgeInspector).getByText("Bridge evidence").closest("details")).toHaveAttribute("open");
    expect(within(bridgeInspector).queryByText(/provider cost/i)).not.toBeInTheDocument();
    const liveRegions = within(bridgeInspector).getAllByRole("status");
    expect(liveRegions).toHaveLength(1);
    expect(liveRegions[0]).toHaveAttribute("aria-atomic", "true");
  });

  it("keeps a stored bridge plan collapsed until the user expands it", () => {
    const stored = {
      ...conversation(),
      runState: null,
      messages: conversation().messages.map((message) => ({ ...message, status: "complete" as const })),
    };
    const projection = bridgePlanProjectionFromNativeState(bridgeState());
    useWorkspaceStore.setState({
      activeConversationId: stored.id,
      conversations: [stored],
      activeRun: null,
      inspectorOpen: true,
      inspectorTab: "run",
      multimodalBridgePlansByRunId: { [projection.runId]: projection },
    });

    render(<ContextInspectorPanel />);

    expect(screen.getByText("Bridge evidence").closest("details")).not.toHaveAttribute("open");
  });

  it("resets the disclosure default when the projected plan identity changes", () => {
    const first = bridgePlanProjectionFromNativeState(bridgeState());
    const second = {
      ...first,
      planId: "bridge_plan_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      runId: "run_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    };
    const view = render(<MultimodalBridgeInspector projection={first} active />);

    expect(screen.getByText("Bridge evidence").closest("details")).toHaveAttribute("open");

    view.rerender(<MultimodalBridgeInspector projection={second} active={false} />);

    expect(screen.getByText("Bridge evidence").closest("details")).not.toHaveAttribute("open");
  });
});
