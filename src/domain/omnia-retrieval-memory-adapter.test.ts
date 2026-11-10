import { describe, expect, it } from "vitest";

import { createMemoryRevision } from "./memory";
import {
  appendMemoryRevisionToStore,
  createOmniaMemoryStore,
} from "./omnia-memory-store";
import type {
  FileVersionId,
  IndexedSourceId,
  MemoryId,
  MemoryRevisionId,
  ProfileId,
  ProjectId,
  SourceChunkId,
} from "./ids";
import {
  buildRetrievalMemoryPlan,
  projectRetrievalMemoryPlanToContextItems,
} from "./omnia-retrieval-memory-adapter";
import {
  createRetrievalCatalog,
  deserializeRetrievalCatalog,
  registerRetrievalConnector,
  searchRetrievalCatalog,
  upsertIndexedRetrievalSource,
  upsertRetrievalSourceChunk,
  upsertRetrievalSourceVersion,
  type RetrievalCatalog,
} from "./omnia-retrieval-registry";

const now = "2026-08-12T00:00:00.000Z";
const profile = "profile-a" as ProfileId;
const otherProfile = "profile-b" as ProfileId;
const project = "project-a" as ProjectId;
const otherProject = "project-b" as ProjectId;

function digest(character: string): string {
  return character.repeat(64);
}

function retrievalCatalog(): RetrievalCatalog {
  let catalog = registerRetrievalConnector(createRetrievalCatalog(), {
    id: "workspace",
    label: "Workspace",
    kind: "workspace",
    version: "1",
    capabilities: ["lexical"],
    enabled: true,
    readOnly: true,
    scope: "profile",
    updatedAt: now,
    metadata: {},
  });
  const addSource = (sourceId: string, sourceProfile: ProfileId, sourceProject: ProjectId | undefined, text: string, hashCharacter: string) => {
    catalog = upsertIndexedRetrievalSource(catalog, {
      id: sourceId as IndexedSourceId,
      connectorId: "workspace",
      profileId: sourceProfile,
      ...(sourceProject === undefined ? {} : { projectId: sourceProject }),
      kind: "workspace_file",
      displayName: sourceId,
      sourceKeySha256: digest(hashCharacter),
      state: "active",
      createdAt: now,
      updatedAt: now,
      metadata: {},
    });
    catalog = upsertRetrievalSourceVersion(catalog, {
      id: `${sourceId}-v1` as FileVersionId,
      sourceId: sourceId as IndexedSourceId,
      ordinal: 1,
      contentSha256: digest(hashCharacter),
      mediaType: "text/plain",
      byteSize: text.length,
      extractorId: "test",
      extractorVersion: "1",
      createdAt: now,
      metadata: {},
    });
    catalog = upsertRetrievalSourceChunk(catalog, {
      id: `${sourceId}-chunk` as SourceChunkId,
      sourceVersionId: `${sourceId}-v1` as FileVersionId,
      sourceId: sourceId as IndexedSourceId,
      ordinal: 0,
      text,
      contentSha256: digest(hashCharacter),
      sourceContentSha256: digest(hashCharacter),
      startByte: 0,
      endByte: Math.max(1, text.length),
      tokenEstimate: 2,
      tokenEstimatorVersion: "test",
      createdAt: now,
      metadata: {},
    });
  };
  addSource("global-a", profile, undefined, "alpha global evidence", "a");
  addSource("project-a", profile, project, "alpha project evidence", "b");
  addSource("project-b", profile, otherProject, "alpha other project evidence", "c");
  addSource("global-b", otherProfile, undefined, "alpha other profile evidence", "d");
  return catalog;
}

function memoryStore() {
  const revision = createMemoryRevision({
    id: "memory-revision-a" as MemoryRevisionId,
    memoryId: "memory-a" as MemoryId,
    scope: { scope: "global", profileId: profile },
    kind: "fact",
    content: "Use citations for every research answer.",
    contentHash: digest("e"),
    confidence: 1,
    status: "active",
    userApproved: true,
    validFrom: now,
    createdAt: now,
  });
  return appendMemoryRevisionToStore(createOmniaMemoryStore(profile, now), revision, now);
}

describe("retrieval and memory bridge scope", () => {
  it("includes global and selected-project chunks while excluding other projects and profiles", () => {
    const plan = buildRetrievalMemoryPlan({ profileId: profile, projectId: project, query: "alpha", tokenBudget: 20, now }, memoryStore(), retrievalCatalog());
    expect(plan.selected.filter((candidate) => candidate.kind === "retrieval").map((candidate) => candidate.sourceId)).toEqual(["global-a", "project-a"]);
  });

  it("does not leak project-scoped chunks into a profile-only query", () => {
    const plan = buildRetrievalMemoryPlan({ profileId: profile, query: "alpha", tokenBudget: 20, now }, memoryStore(), retrievalCatalog());
    expect(plan.selected.filter((candidate) => candidate.kind === "retrieval").map((candidate) => candidate.sourceId)).toEqual(["global-a"]);
  });

  it("filters profile before applying the retrieval limit", () => {
    const plan = buildRetrievalMemoryPlan({ profileId: profile, query: "alpha", retrievalLimit: 1, tokenBudget: 20, now }, memoryStore(), retrievalCatalog());
    expect(plan.selected.some((candidate) => candidate.sourceId === "global-b")).toBe(false);
    expect(plan.stats.retrievalCandidateCount).toBe(1);
  });

  it("matches multi-term memory queries without requiring a contiguous phrase", () => {
    const plan = buildRetrievalMemoryPlan({ profileId: profile, query: "research citations", tokenBudget: 20, now }, memoryStore(), createRetrievalCatalog());
    expect(plan.selected.map((candidate) => candidate.kind)).toEqual(["memory"]);
    expect(projectRetrievalMemoryPlanToContextItems(plan)[0]?.kind).toBe("memory");
  });

  it("rejects malformed imported catalogs instead of trusting cast records", () => {
    const catalog = retrievalCatalog();
    const payload = JSON.parse(JSON.stringify(catalog)) as { sources: Array<Record<string, unknown>> };
    delete payload.sources[0]?.connectorId;
    expect(() => deserializeRetrievalCatalog(payload)).toThrow();
  });

  it("does not return chunks from superseded source versions", () => {
    const catalog = retrievalCatalog();
    const superseded = JSON.parse(JSON.stringify(catalog)) as RetrievalCatalog;
    const version = superseded.sourceVersions.find((candidate) => candidate.id === "global-a-v1");
    if (!version) throw new Error("test version missing");
    const withSupersededVersion: RetrievalCatalog = {
      ...superseded,
      sourceVersions: superseded.sourceVersions.map((candidate) => candidate.id === version.id ? { ...candidate, supersededAt: "2026-08-13T00:00:00.000Z" } : candidate),
    };
    expect(searchRetrievalCatalog(withSupersededVersion, "alpha", { profileId: profile }).some((candidate) => candidate.chunk.id === "global-a-chunk")).toBe(false);
  });
});
