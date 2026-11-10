import { describe, expect, it } from "vitest";

import {
  bridgeActionAvailability,
  bridgeAnnouncement,
  bridgeBadgeFromPlan,
  bridgeInspectorSections,
  bridgePlanProjectionFromNativeState,
  bridgeStageTimeline,
  type NativeMultimodalBridgeState,
} from "./multimodal-bridge-projection";

const digest = (character: string) => character.repeat(64);

function bridgeState(overrides: Partial<NativeMultimodalBridgeState["plan"]> = {}): NativeMultimodalBridgeState {
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
      resolvedMode: "direct-native",
      disposition: "ready",
      sourceManifestSha256: digest("a"),
      capabilitySnapshotRevisionId: "capability_snapshot_20260815",
      policyRevisionId: "policy_revision_20260815",
      dataBoundary: "approved-provider",
      egressDecision: "approved",
      selectedReasonCodes: ["native-capability-exact-match"],
      rejectedAlternatives: [
        {
          mode: "local-transform",
          reasonCodes: ["higher-ranked-route-selected"],
        },
      ],
      decisiveFidelityDimensions: ["content", "provenance"],
      fidelityProfile: "semantic-and-visual",
      planSha256: digest("b"),
      createdAtMs: 1_786_905_600_000,
      ...overrides,
    },
    artifacts: [
      {
        planId: "bridge_plan_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ordinal: 0,
        attachmentId: "attachment_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        sourceSha256: digest("c"),
        sourceSelector: "page:2",
        modality: "pdf",
        mediaType: "application/pdf",
        byteSize: 2048,
        createdAtMs: 1_786_905_600_000,
      },
    ],
    stageReceipts: [],
  };
}

function stageReceipt(
  plan: NativeMultimodalBridgeState["plan"],
  overrides: Partial<NativeMultimodalBridgeState["stageReceipts"][number]> = {},
): NativeMultimodalBridgeState["stageReceipts"][number] {
  return {
    id: "bridge_stage_receipt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    schemaVersion: 1,
    planId: plan.id,
    stageId: "local-transform",
    attemptNo: 1,
    stageKind: "local-transform",
    status: "planned",
    boundary: "local-only",
    sourceManifestSha256: plan.sourceManifestSha256,
    outputManifestSha256: null,
    capabilitySnapshotRevisionId: plan.capabilitySnapshotRevisionId,
    policyRevisionId: plan.policyRevisionId,
    providerAcceptance: "not-applicable",
    reconciliationStatus: "not-required",
    derivativeSha256: [],
    fidelityDisposition: "planned",
    receiptSha256: digest("d"),
    startedAtMs: plan.createdAtMs,
    completedAtMs: null,
    createdAtMs: plan.createdAtMs,
    ...overrides,
  };
}

describe("renderer-safe multimodal bridge projection", () => {
  it.each([
    "direct-native",
    "local-transform",
    "specialist-bridge-model",
    "hybrid-ensemble",
    "surrogate-to-primary",
    "human-review",
    "unsupported",
  ])("retains canonical resolved mode %s and never persists auto as resolved", (resolvedMode) => {
    const disposition = resolvedMode === "unsupported" ? "unsupported" : "ready";
    const projection = bridgePlanProjectionFromNativeState(
      bridgeState({ resolvedMode, disposition }),
    );

    expect(projection.resolvedMode).toBe(resolvedMode);
    expect(projection.resolvedMode).not.toBe("auto");
    expect(projection.requestedMode).toBe("auto");
  });

  it.each([
    ["ready", "Bridge ready"],
    ["ready-with-degradation", "Ready with disclosed limits"],
    ["review-required", "Review required"],
    ["blocked", "Blocked by policy or authority"],
    ["failed", "Bridge plan failed"],
    ["unsupported", "Unsupported for current route"],
  ] as const)("maps disposition %s to a truthful compact status", (disposition, label) => {
    const resolvedMode = disposition === "unsupported" ? "unsupported" : "local-transform";
    const projection = bridgePlanProjectionFromNativeState(
      bridgeState({ resolvedMode, disposition, egressDecision: "not-required", dataBoundary: "local-only" }),
    );

    expect(bridgeBadgeFromPlan(projection).label).toBe(label);
  });

  it("does not infer provider acceptance or capability freshness from a direct-native plan", () => {
    const projection = bridgePlanProjectionFromNativeState(bridgeState());
    const sections = bridgeInspectorSections(projection);
    const execution = sections.find((section) => section.id === "execution");

    expect(projection.providerAcceptance).toBe("not-observed");
    expect(projection.capabilityFreshness).toBe("not-observed");
    expect(bridgeBadgeFromPlan(projection)).toMatchObject({ label: "Bridge ready", tone: "info" });
    expect(execution?.rows).toContainEqual({ label: "Provider acceptance", value: "Not observed" });
    expect(bridgeAnnouncement(projection)).toMatch(/Provider acceptance has not been observed/i);
  });

  it("fails closed when a stage receipt drifts from its frozen plan or asserts impossible local acceptance", () => {
    const base = bridgeState({
      resolvedMode: "local-transform",
      disposition: "blocked",
      dataBoundary: "local-only",
      egressDecision: "not-required",
    });

    expect(() =>
      bridgePlanProjectionFromNativeState({
        ...base,
        stageReceipts: [
          stageReceipt(base.plan, {
            sourceManifestSha256: digest("e"),
          }),
        ],
      }),
    ).toThrow(/source manifest/i);
    expect(() =>
      bridgePlanProjectionFromNativeState({
        ...base,
        stageReceipts: [
          stageReceipt(base.plan, {
            capabilitySnapshotRevisionId: "capability_snapshot_other",
          }),
        ],
      }),
    ).toThrow(/capability revision/i);
    expect(() =>
      bridgePlanProjectionFromNativeState({
        ...base,
        stageReceipts: [
          stageReceipt(base.plan, {
            providerAcceptance: "accepted",
          }),
        ],
      }),
    ).toThrow(/non-provider stage/i);
    expect(() =>
      bridgePlanProjectionFromNativeState({
        ...base,
        stageReceipts: [
          stageReceipt(base.plan, {
            status: "completed",
          }),
        ],
      }),
    ).toThrow(/completed stage/i);
  });

  it("rejects a renderer projection whose MIME is canonical but unclassified", () => {
    expect(() =>
      bridgePlanProjectionFromNativeState(
        bridgeState({
          resolvedMode: "unsupported",
          disposition: "unsupported",
        }),
      ),
    ).not.toThrow();

    expect(() =>
      bridgePlanProjectionFromNativeState({
        ...bridgeState(),
        artifacts: [
          {
            ...bridgeState().artifacts[0]!,
            mediaType: "application/octet-stream",
            modality: "document",
          },
        ],
      }),
    ).toThrow(/trusted native modality/i);
  });

  it("rejects a renderer projection whose declared modality disagrees with MIME", () => {
    expect(() =>
      bridgePlanProjectionFromNativeState({
        ...bridgeState(),
        artifacts: [
          {
            ...bridgeState().artifacts[0]!,
            mediaType: "image/png",
            modality: "document",
          },
        ],
      }),
    ).toThrow(/does not match/i);
  });

  it("does not turn a provider-bound planning receipt with not-applicable acceptance into an acceptance claim", () => {
    const base = bridgeState();
    const projection = bridgePlanProjectionFromNativeState({
      ...base,
      stageReceipts: [
        stageReceipt(base.plan, {
          boundary: "approved-provider",
          stageKind: "direct-deliver",
          stageId: "direct-deliver",
          providerAcceptance: "not-applicable",
        }),
      ],
    });

    expect(projection.providerAcceptance).toBe("not-observed");
    expect(bridgeAnnouncement(projection)).toMatch(/has not been observed/i);
  });

  it("derives provider acceptance only from an approved provider-boundary receipt", () => {
    const base = bridgeState();
    const state: NativeMultimodalBridgeState = {
      ...base,
      stageReceipts: [
      {
        id: "bridge_stage_receipt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        schemaVersion: 1,
        planId: base.plan.id,
        stageId: "primary-deliver",
        attemptNo: 1,
        stageKind: "primary-deliver",
        status: "completed",
        boundary: "approved-provider",
        sourceManifestSha256: base.plan.sourceManifestSha256,
        outputManifestSha256: digest("d"),
        capabilitySnapshotRevisionId: base.plan.capabilitySnapshotRevisionId,
        policyRevisionId: base.plan.policyRevisionId,
        providerAcceptance: "accepted",
        reconciliationStatus: "not-required",
        derivativeSha256: [digest("e")],
        fidelityDisposition: "ready",
        receiptSha256: digest("f"),
        startedAtMs: base.plan.createdAtMs + 100,
        completedAtMs: base.plan.createdAtMs + 500,
        createdAtMs: base.plan.createdAtMs + 500,
      },
      ],
    };

    const projection = bridgePlanProjectionFromNativeState(state);

    expect(projection.providerAcceptance).toBe("accepted");
    expect(bridgeBadgeFromPlan(projection).label).toBe("Bridge stage recorded");
    expect(bridgeAnnouncement(projection)).toMatch(/Provider acceptance is accepted/i);
  });

  it("prioritizes outcome-unknown reconciliation and disables blind retry", () => {
    const base = bridgeState({ resolvedMode: "surrogate-to-primary" });
    const state: NativeMultimodalBridgeState = {
      ...base,
      stageReceipts: [
      {
        id: "bridge_stage_receipt_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        schemaVersion: 1,
        planId: base.plan.id,
        stageId: "primary-deliver",
        attemptNo: 1,
        stageKind: "primary-deliver",
        status: "outcome-unknown",
        boundary: "approved-provider",
        sourceManifestSha256: base.plan.sourceManifestSha256,
        outputManifestSha256: null,
        capabilitySnapshotRevisionId: base.plan.capabilitySnapshotRevisionId,
        policyRevisionId: base.plan.policyRevisionId,
        providerAcceptance: "unknown",
        reconciliationStatus: "pending",
        derivativeSha256: [],
        fidelityDisposition: "processing",
        receiptSha256: digest("d"),
        startedAtMs: base.plan.createdAtMs + 100,
        completedAtMs: null,
        createdAtMs: base.plan.createdAtMs + 300,
      },
      ],
    };

    const projection = bridgePlanProjectionFromNativeState(state);

    expect(projection.reconciliationRequired).toBe(true);
    expect(bridgeBadgeFromPlan(projection)).toMatchObject({
      label: "Outcome unknown — reconciling",
      tone: "warning",
    });
    expect(bridgeActionAvailability(projection).retry).toMatchObject({
      available: false,
      reason: expect.stringMatching(/Blind retry is disabled/i),
    });
  });

  it("uses the newest attempt for one stage so a resolved retry does not retain stale reconciliation state", () => {
    const base = bridgeState();
    const projection = bridgePlanProjectionFromNativeState({
      ...base,
      stageReceipts: [
        stageReceipt(base.plan, {
          id: "bridge_stage_receipt_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          stageId: "primary-deliver",
          attemptNo: 1,
          stageKind: "primary-deliver",
          status: "outcome-unknown",
          boundary: "approved-provider",
          providerAcceptance: "unknown",
          reconciliationStatus: "pending",
          fidelityDisposition: "processing",
          startedAtMs: base.plan.createdAtMs + 10,
          createdAtMs: base.plan.createdAtMs + 10,
        }),
        stageReceipt(base.plan, {
          id: "bridge_stage_receipt_cccccccccccccccccccccccccccccccc",
          stageId: "primary-deliver",
          attemptNo: 2,
          stageKind: "primary-deliver",
          status: "completed",
          boundary: "approved-provider",
          outputManifestSha256: digest("e"),
          providerAcceptance: "accepted",
          reconciliationStatus: "reconciled",
          fidelityDisposition: "ready",
          startedAtMs: base.plan.createdAtMs + 20,
          completedAtMs: base.plan.createdAtMs + 30,
          createdAtMs: base.plan.createdAtMs + 30,
        }),
      ],
    });

    expect(projection.reconciliationRequired).toBe(false);
    expect(projection.providerAcceptance).toBe("accepted");
    expect(bridgeBadgeFromPlan(projection).label).toBe("Bridge stage recorded");
  });

  it("projects receipt-derived stage order while grouping retries under one stage", () => {
    const base = bridgeState({
      resolvedMode: "local-transform",
      disposition: "ready",
      egressDecision: "not-required",
      dataBoundary: "local-only",
    });
    const projection = bridgePlanProjectionFromNativeState({
      ...base,
      stageReceipts: [
        stageReceipt(base.plan, {
          id: "bridge_stage_receipt_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          stageId: "admit",
          stageKind: "admit",
          createdAtMs: base.plan.createdAtMs + 10,
          startedAtMs: base.plan.createdAtMs + 10,
        }),
        stageReceipt(base.plan, {
          id: "bridge_stage_receipt_cccccccccccccccccccccccccccccccc",
          stageId: "local-transform",
          stageKind: "local-transform",
          attemptNo: 1,
          createdAtMs: base.plan.createdAtMs + 20,
          startedAtMs: base.plan.createdAtMs + 20,
        }),
        stageReceipt(base.plan, {
          id: "bridge_stage_receipt_dddddddddddddddddddddddddddddddd",
          stageId: "local-transform",
          stageKind: "local-transform",
          attemptNo: 2,
          status: "completed",
          outputManifestSha256: digest("e"),
          fidelityDisposition: "ready",
          createdAtMs: base.plan.createdAtMs + 40,
          startedAtMs: base.plan.createdAtMs + 30,
          completedAtMs: base.plan.createdAtMs + 40,
        }),
      ],
    });

    expect(bridgeStageTimeline(projection)).toMatchObject([
      {
        stageId: "admit",
        attemptCount: 1,
        latestAttemptNo: 1,
        latestStatus: "planned",
      },
      {
        stageId: "local-transform",
        attemptCount: 2,
        latestAttemptNo: 2,
        latestStatus: "completed",
        latestReceiptId: "bridge_stage_receipt_dddddddddddddddddddddddddddddddd",
      },
    ]);
  });

  it("retains safe source lineage but rejects filesystem-shaped selectors before rendering", () => {
    const projection = bridgePlanProjectionFromNativeState(bridgeState());
    const serialized = JSON.stringify(projection);

    expect(serialized).toContain("page:2");
    expect(serialized).not.toMatch(/file:\/\//i);
    expect(serialized).not.toMatch(/[a-z]:\\\\/i);

    const base = bridgeState();
    const unsafe: NativeMultimodalBridgeState = {
      ...base,
      artifacts: [{ ...base.artifacts[0]!, sourceSelector: "C:\\Users\\khang\\private.pdf" }],
    };
    expect(() => bridgePlanProjectionFromNativeState(unsafe)).toThrow(/filesystem path/i);
  });

  it("keeps composite page and region selectors instead of treating their separator as a path", () => {
    const base = bridgeState();
    const projection = bridgePlanProjectionFromNativeState({
      ...base,
      artifacts: [
        {
          ...base.artifacts[0]!,
          sourceSelector: "page:7/region:x=96;y=48;width=720;height=420",
        },
      ],
    });

    expect(projection.artifacts[0]?.sourceSelector).toBe(
      "page:7/region:x=96;y=48;width=720;height=420",
    );
  });

  it("rejects URL, path, unknown-scheme, relative, backslash, and control selectors", () => {
    const base = bridgeState();
    for (const sourceSelector of [
      "file:/C:/Users/khang/private.pdf",
      "file:C:/Users/khang/private.pdf",
      "https:private.example/secret",
      "data:text/plain,private-content",
      "blob:opaque",
      "../private.pdf",
      "\\\\server\\share\\private.pdf",
      "/var/private.pdf",
      "page:7\\private.pdf",
      "page:7\nregion:full",
    ]) {
      expect(() =>
        bridgePlanProjectionFromNativeState({
          ...base,
          artifacts: [{ ...base.artifacts[0]!, sourceSelector }],
        }),
      ).toThrow(/source selector|coordinate|filesystem path|URL/i);
    }
  });

  it("keeps parallel same-kind bridge stages distinguishable in the inspector", () => {
    const base = bridgeState({
      resolvedMode: "local-transform",
      disposition: "ready",
      egressDecision: "not-required",
      dataBoundary: "local-only",
    });
    const firstReceipt = {
      id: "bridge_stage_receipt_cccccccccccccccccccccccccccccccc",
      schemaVersion: 1,
      planId: base.plan.id,
      attemptNo: 1,
      stageKind: "local-transform",
      status: "completed",
      boundary: "local-only",
      sourceManifestSha256: base.plan.sourceManifestSha256,
      outputManifestSha256: digest("d"),
      capabilitySnapshotRevisionId: base.plan.capabilitySnapshotRevisionId,
      policyRevisionId: base.plan.policyRevisionId,
      providerAcceptance: "not-applicable",
      reconciliationStatus: "not-required",
      derivativeSha256: [],
      fidelityDisposition: "ready",
      receiptSha256: digest("e"),
      startedAtMs: base.plan.createdAtMs + 100,
      completedAtMs: base.plan.createdAtMs + 300,
      createdAtMs: base.plan.createdAtMs + 300,
    } as const;
    const projection = bridgePlanProjectionFromNativeState({
      ...base,
      stageReceipts: [
        { ...firstReceipt, stageId: "local-transform-page-1" },
        {
          ...firstReceipt,
          id: "bridge_stage_receipt_dddddddddddddddddddddddddddddddd",
          stageId: "local-transform-page-2",
          receiptSha256: digest("f"),
          createdAtMs: firstReceipt.createdAtMs + 1,
        },
      ],
    });
    const execution = bridgeInspectorSections(projection).find((section) => section.id === "execution");
    const labels = execution?.rows.map((row) => row.label) ?? [];

    expect(labels).toContain("Transforming locally · local-transform-page-1 · attempt 1");
    expect(labels).toContain("Transforming locally · local-transform-page-2 · attempt 1");
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("does not present a cancelled stage as a ready bridge", () => {
    const base = bridgeState({
      resolvedMode: "local-transform",
      disposition: "ready",
      egressDecision: "not-required",
      dataBoundary: "local-only",
    });
    const projection = bridgePlanProjectionFromNativeState({
      ...base,
      stageReceipts: [
        {
          id: "bridge_stage_receipt_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
          schemaVersion: 1,
          planId: base.plan.id,
          stageId: "local-transform-page-1",
          attemptNo: 1,
          stageKind: "local-transform",
          status: "cancelled",
          boundary: "local-only",
          sourceManifestSha256: base.plan.sourceManifestSha256,
          outputManifestSha256: null,
          capabilitySnapshotRevisionId: base.plan.capabilitySnapshotRevisionId,
          policyRevisionId: base.plan.policyRevisionId,
          providerAcceptance: "not-applicable",
          reconciliationStatus: "not-required",
          derivativeSha256: [],
          fidelityDisposition: "planned",
          receiptSha256: digest("f"),
          startedAtMs: base.plan.createdAtMs + 100,
          completedAtMs: null,
          createdAtMs: base.plan.createdAtMs + 200,
        },
      ],
    });

    expect(bridgeBadgeFromPlan(projection)).toMatchObject({
      label: "Bridge stage cancelled",
      tone: "warning",
    });
  });
});
