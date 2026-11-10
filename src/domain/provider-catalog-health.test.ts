import { describe, expect, it } from "vitest";

import { DomainError } from "./errors";
import type { ModelProfileId, ProfileId, ProviderConnectionId } from "./ids";
import type {
  CapabilityValue,
  ModelCapabilities,
  ModelDescriptor,
} from "./provider";
import {
  createModelCatalogRefreshReceipt,
  createModelCatalogSnapshot,
  freezeCatalogModelSelection,
  projectProviderCatalogHealth,
  resolveCatalogModel,
  resolveModelCatalog,
  type CatalogModelRevision,
  type CreateModelCatalogSnapshotInput,
  type ModelCatalogFallbackReceiptId,
  type ModelCatalogRefreshReceiptId,
  type ModelCatalogSnapshotId,
  type ModelDescriptorRevisionId,
} from "./provider-catalog-health";
import {
  createProviderHealthObservation,
  type ProviderHealthObservation,
  type TelemetryObservationId,
} from "./telemetry";

const id = <T extends string>(value: string) => value as T;
const providerConnectionId = id<ProviderConnectionId>("provider_01");
const profileId = id<ProfileId>("profile_01");
const modelAId = id<ModelProfileId>("model_profile_a");
const modelBId = id<ModelProfileId>("model_profile_b");
const snapshotId = id<ModelCatalogSnapshotId>("catalog_snapshot_01");
const hash = (character: string) => character.repeat(64);
const t0 = "2026-08-13T00:00:00.000Z";
const t1 = "2026-08-13T00:05:00.000Z";
const t2 = "2026-08-13T00:10:00.000Z";
const t3 = "2026-08-13T00:15:00.000Z";

function capability<T>(value: T): CapabilityValue<T> {
  return {
    value,
    source: "provider_live",
    observedAt: t0,
    confidence: "verified",
  };
}

function capabilities(): ModelCapabilities {
  return {
    inputModalities: capability(["text"]),
    outputModalities: capability(["text"]),
    streaming: capability(true),
    tools: capability(true),
    parallelTools: capability(false),
    structuredOutput: capability(true),
    jsonSchema: capability(true),
    reasoning: capability(false),
    promptCaching: capability(true),
    backgroundMode: capability(false),
    contextWindowTokens: capability(128_000),
    maxOutputTokens: capability(16_384),
    supportedRoles: capability(["system", "user", "assistant"]),
    native: {},
  };
}

function descriptor(
  modelProfileId: ModelProfileId,
  providerModelId: string,
  overrides: Partial<ModelDescriptor> = {},
): ModelDescriptor {
  return {
    id: modelProfileId,
    connectionId: providerConnectionId,
    providerModelId,
    displayName: providerModelId,
    capabilities: capabilities(),
    favorite: false,
    hidden: false,
    discoveredAt: t0,
    expiresAt: t3,
    extensions: {},
    ...overrides,
  };
}

function revision(
  modelProfileId: ModelProfileId,
  providerModelId: string,
  character: string,
  overrides: Partial<CatalogModelRevision> = {},
): CatalogModelRevision {
  return {
    revisionId: id<ModelDescriptorRevisionId>(
      `descriptor_revision_${character}`,
    ),
    descriptorSha256: hash(character),
    aliases: [],
    descriptor: descriptor(modelProfileId, providerModelId),
    ...overrides,
  };
}

function snapshotInput(
  overrides: Partial<CreateModelCatalogSnapshotInput> = {},
): CreateModelCatalogSnapshotInput {
  return {
    id: snapshotId,
    providerConnectionId,
    providerDefinitionRevisionId: "provider-definition-7",
    providerDefinitionSha256: hash("d"),
    endpointFingerprintSha256: hash("e"),
    adapterVersion: "openai-compatible/7",
    catalogRevision: "catalog/42",
    contentSha256: hash("c"),
    source: "provider-live",
    observedAt: t0,
    expiresAt: t1,
    models: [
      revision(modelBId, "z-model", "b"),
      revision(modelAId, "a-model", "a"),
    ],
    metadata: { etagHash: hash("f") },
    ...overrides,
  };
}

function resolveInput(
  snapshots = [createModelCatalogSnapshot(snapshotInput())],
  overrides: Partial<Parameters<typeof resolveModelCatalog>[0]> = {},
): Parameters<typeof resolveModelCatalog>[0] {
  return {
    providerConnectionId,
    providerDefinitionRevisionId: "provider-definition-7",
    providerDefinitionSha256: hash("d"),
    endpointFingerprintSha256: hash("e"),
    adapterVersion: "openai-compatible/7",
    now: t0,
    snapshots,
    refreshReceipts: [],
    ...overrides,
  };
}

describe("provider catalog and health contract", () => {
  it("creates a canonical immutable snapshot with exact descriptor revisions", () => {
    const snapshot = createModelCatalogSnapshot(snapshotInput());

    expect(
      snapshot.models.map((model) => model.descriptor.providerModelId),
    ).toEqual(["a-model", "z-model"]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.models)).toBe(true);
    expect(Object.isFrozen(snapshot.models[0]?.descriptor.capabilities)).toBe(
      true,
    );
    expect(Object.isFrozen(snapshot.metadata)).toBe(true);
  });

  it("rejects duplicate models, credential fields, and prototype-related keys", () => {
    expect(() =>
      createModelCatalogSnapshot(
        snapshotInput({
          models: [
            revision(modelAId, "same", "a"),
            revision(modelBId, "same", "b"),
          ],
        }),
      ),
    ).toThrowError(DomainError);

    expect(() =>
      createModelCatalogSnapshot(
        snapshotInput({
          models: [
            revision(modelAId, "a-model", "a", {
              descriptor: descriptor(modelAId, "a-model", {
                extensions: { authorizationToken: "must-not-enter-catalog" },
              }),
            }),
          ],
        }),
      ),
    ).toThrowError(DomainError);

    expect(() =>
      createModelCatalogSnapshot(
        snapshotInput({
          metadata: JSON.parse('{"constructor":{"polluted":true}}'),
        }),
      ),
    ).toThrowError(DomainError);
  });

  it("allows non-secret tokenizer metadata without weakening credential checks", () => {
    const snapshot = createModelCatalogSnapshot(
      snapshotInput({
        metadata: {
          tokenizerVersion: "tiktoken/2026-08",
          tokenizer_family: "bpe",
          tokenBudget: 128_000,
        },
      }),
    );

    expect(snapshot.metadata).toEqual({
      tokenizerVersion: "tiktoken/2026-08",
      tokenizer_family: "bpe",
      tokenBudget: 128_000,
    });
    expect(() =>
      createModelCatalogSnapshot(
        snapshotInput({ metadata: { refreshToken: "must-not-persist" } }),
      ),
    ).toThrowError(DomainError);
  });

  it("keeps 304 revalidation as separate evidence without mutating the snapshot", () => {
    const snapshot = createModelCatalogSnapshot(snapshotInput());
    const receipt = createModelCatalogRefreshReceipt({
      id: id<ModelCatalogRefreshReceiptId>("refresh_01"),
      providerConnectionId,
      providerDefinitionRevisionId: snapshot.providerDefinitionRevisionId,
      providerDefinitionSha256: snapshot.providerDefinitionSha256,
      endpointFingerprintSha256: snapshot.endpointFingerprintSha256,
      adapterVersion: snapshot.adapterVersion,
      startedAt: t1,
      finishedAt: t1,
      outcome: "not-modified",
      snapshotId: snapshot.id,
      revalidatedUntil: t3,
    });
    const resolved = resolveModelCatalog(
      resolveInput([snapshot], { now: t2, refreshReceipts: [receipt] }),
    );

    expect(resolved.state).toBe("fresh");
    if (resolved.state === "fresh") {
      expect(resolved.effectiveExpiresAt).toBe(t3);
      expect(resolved.snapshot.expiresAt).toBe(t1);
      expect(resolved.latestRefreshReceipt?.id).toBe(receipt.id);
    }
  });

  it("never uses stale last-known-good catalog data without an explicit decision receipt", () => {
    const snapshot = createModelCatalogSnapshot(snapshotInput());
    const failedRefresh = createModelCatalogRefreshReceipt({
      id: id<ModelCatalogRefreshReceiptId>("refresh_failed"),
      providerConnectionId,
      providerDefinitionRevisionId: snapshot.providerDefinitionRevisionId,
      providerDefinitionSha256: snapshot.providerDefinitionSha256,
      endpointFingerprintSha256: snapshot.endpointFingerprintSha256,
      adapterVersion: snapshot.adapterVersion,
      startedAt: t1,
      finishedAt: t1,
      outcome: "failed",
      errorClass: "transport",
      diagnosticCode: "catalog_transport_failure",
    });
    const denied = resolveModelCatalog(
      resolveInput([snapshot], { now: t2, refreshReceipts: [failedRefresh] }),
    );
    expect(denied).toEqual({
      state: "unavailable",
      reason: "stale-fallback-not-authorized",
    });

    const allowed = resolveModelCatalog(
      resolveInput([snapshot], {
        now: t2,
        refreshReceipts: [failedRefresh],
        staleFallback: {
          receiptId: id<ModelCatalogFallbackReceiptId>("fallback_01"),
          decisionRef: "routing-policy/provider-stale-fallback/v3",
          maxStaleMs: 10 * 60 * 1_000,
        },
      }),
    );
    expect(allowed.state).toBe("stale-last-known-good");
    if (allowed.state === "stale-last-known-good") {
      expect(allowed.fallbackReceipt.reason).toBe("refresh-failed");
      expect(allowed.fallbackReceipt.triggeringRefreshReceiptId).toBe(
        failedRefresh.id,
      );
      expect(allowed.fallbackReceipt.decisionRef).toBe(
        "routing-policy/provider-stale-fallback/v3",
      );
    }
  });

  it("rejects arbitrary runtime catalog refresh error classes", () => {
    expect(() =>
      createModelCatalogRefreshReceipt({
        id: id<ModelCatalogRefreshReceiptId>("refresh_invalid_class"),
        providerConnectionId,
        providerDefinitionRevisionId: "provider-definition-1",
        providerDefinitionSha256: hash("a"),
        endpointFingerprintSha256: hash("b"),
        adapterVersion: "openai-compatible/1",
        startedAt: t1,
        finishedAt: t1,
        outcome: "failed",
        errorClass: "provider-owned-upstream-code" as never,
      }),
    ).toThrowError(DomainError);
  });

  it("fails closed on provider definition, endpoint, adapter, and stale-window drift", () => {
    const snapshot = createModelCatalogSnapshot(snapshotInput());
    expect(
      resolveModelCatalog(
        resolveInput([snapshot], {
          providerDefinitionRevisionId: "provider-definition-8",
        }),
      ),
    ).toEqual({ state: "unavailable", reason: "provider-definition-drift" });
    expect(
      resolveModelCatalog(
        resolveInput([snapshot], { endpointFingerprintSha256: hash("9") }),
      ),
    ).toEqual({ state: "unavailable", reason: "endpoint-drift" });
    expect(
      resolveModelCatalog(
        resolveInput([snapshot], { adapterVersion: "openai-compatible/8" }),
      ),
    ).toEqual({ state: "unavailable", reason: "adapter-version-drift" });
    expect(
      resolveModelCatalog(
        resolveInput([snapshot], {
          now: t3,
          staleFallback: {
            receiptId: id<ModelCatalogFallbackReceiptId>("fallback_too_old"),
            decisionRef: "routing-policy/provider-stale-fallback/v3",
            maxStaleMs: 60_000,
          },
        }),
      ),
    ).toEqual({ state: "unavailable", reason: "stale-window-exceeded" });
  });

  it("treats catalog and model expiry timestamps as exclusive boundaries", () => {
    const snapshot = createModelCatalogSnapshot(snapshotInput());
    const catalogAtExpiry = resolveModelCatalog(
      resolveInput([snapshot], { now: snapshot.expiresAt }),
    );
    expect(catalogAtExpiry).toEqual({
      state: "unavailable",
      reason: "stale-fallback-not-authorized",
    });

    const freshCatalog = resolveModelCatalog(resolveInput([snapshot]));
    const modelAtExpiry = resolveCatalogModel(freshCatalog, modelAId, t3);
    expect(modelAtExpiry).toEqual({
      state: "unavailable",
      reason: "model-descriptor-expired",
    });
  });

  it("rejects malformed resolver definition, endpoint, and adapter inputs", () => {
    for (const overrides of [
      { providerDefinitionRevisionId: "   " },
      { providerDefinitionSha256: "not-a-sha256" },
      { endpointFingerprintSha256: "also-not-a-sha256" },
      { adapterVersion: "   " },
    ]) {
      expect(() =>
        resolveModelCatalog(resolveInput(undefined, overrides)),
      ).toThrowError(DomainError);
    }
  });

  it("rejects deeply nested provider-native capability JSON before freezing", () => {
    let nested: unknown = "leaf";
    for (let depth = 0; depth < 30; depth += 1) nested = { child: nested };
    const unsafeCapabilities = capabilities();
    (
      unsafeCapabilities.native as Record<string, CapabilityValue<unknown>>
    ).deep = capability(nested);

    expect(() =>
      createModelCatalogSnapshot(
        snapshotInput({
          models: [
            revision(modelAId, "a-model", "a", {
              descriptor: descriptor(modelAId, "a-model", {
                capabilities: unsafeCapabilities,
              }),
            }),
          ],
        }),
      ),
    ).toThrowError(DomainError);
  });

  it("does not replace a missing requested model with another catalog entry", () => {
    const catalog = resolveModelCatalog(resolveInput());
    const missing = resolveCatalogModel(
      catalog,
      id<ModelProfileId>("model_profile_missing"),
      t0,
    );
    expect(missing).toEqual({
      state: "unavailable",
      reason: "requested-model-missing",
    });
  });

  it("freezes exact catalog, definition, model revision, and stale fallback provenance", () => {
    const snapshot = createModelCatalogSnapshot(snapshotInput());
    const catalog = resolveModelCatalog(
      resolveInput([snapshot], {
        now: t2,
        staleFallback: {
          receiptId: id<ModelCatalogFallbackReceiptId>("fallback_02"),
          decisionRef: "user-choice-27",
          maxStaleMs: 15 * 60 * 1_000,
        },
      }),
    );
    const model = resolveCatalogModel(catalog, modelAId, t2);
    const frozen = freezeCatalogModelSelection(model, t2);

    expect(frozen).toMatchObject({
      providerConnectionId,
      providerDefinitionRevisionId: "provider-definition-7",
      catalogSnapshotId: snapshot.id,
      catalogContentSha256: snapshot.contentSha256,
      catalogFreshness: "stale-last-known-good",
      modelProfileId: modelAId,
      providerModelId: "a-model",
      modelDescriptorRevisionId: id<ModelDescriptorRevisionId>(
        "descriptor_revision_a",
      ),
      modelDescriptorSha256: hash("a"),
      fallbackReceiptId: id<ModelCatalogFallbackReceiptId>("fallback_02"),
      fallbackDecisionRef: "user-choice-27",
    });
  });

  it("keeps connection and exact-model health separate without cross-model contamination", () => {
    const observation = (
      idValue: string,
      modelProfileId: ModelProfileId | undefined,
      outcome: "pass" | "fail",
    ): ProviderHealthObservation =>
      createProviderHealthObservation({
        id: id<TelemetryObservationId>(idValue),
        scope: {
          profileId,
          providerConnectionId,
          ...(modelProfileId === undefined ? {} : { modelProfileId }),
        },
        dimension: modelProfileId === undefined ? "transport" : "model",
        outcome,
        ...(outcome === "fail" ? { errorClass: "protocol" as const } : {}),
        latencyMs: 100,
        observedAt: t0,
      });
    const catalog = resolveModelCatalog(resolveInput());
    const projection = projectProviderCatalogHealth({
      catalog,
      observations: [
        observation("health_connection", undefined, "pass"),
        observation("health_model_a", modelAId, "pass"),
        observation("health_model_b", modelBId, "fail"),
      ],
      providerConnectionId,
      modelProfileId: modelAId,
      policy: {
        now: t0,
        freshnessMs: 60_000,
        minimumSamples: 1,
        degradedFailureRate: 0.25,
        unavailableFailureRate: 0.75,
      },
    });

    expect(projection.state).toBe("healthy");
    expect(projection.connection.state).toBe("healthy");
    expect(projection.model?.state).toBe("healthy");
    expect(projection.reasons).toEqual([]);
  });

  it("reports stale catalogs and missing health evidence independently", () => {
    const snapshot = createModelCatalogSnapshot(snapshotInput());
    const stale = resolveModelCatalog(
      resolveInput([snapshot], {
        now: t2,
        staleFallback: {
          receiptId: id<ModelCatalogFallbackReceiptId>("fallback_health"),
          decisionRef: "operator-choice-2",
          maxStaleMs: 15 * 60 * 1_000,
        },
      }),
    );
    const projection = projectProviderCatalogHealth({
      catalog: stale,
      observations: [],
      providerConnectionId,
      modelProfileId: null,
      policy: {
        now: t2,
        freshnessMs: 60_000,
        minimumSamples: 1,
        degradedFailureRate: 0.25,
        unavailableFailureRate: 0.75,
      },
    });

    expect(projection.state).toBe("unknown");
    expect(projection.reasons).toEqual([
      "catalog-stale",
      "connection-health-unknown",
    ]);
  });
});
