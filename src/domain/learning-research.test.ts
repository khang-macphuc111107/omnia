import { describe, expect, it } from "vitest";

import { DomainError } from "./errors";
import type {
  ContextSnapshotId,
  LearningAssessmentId,
  LearningEvidenceId,
  LearningObjectiveId,
  LearningPlanId,
  MessageId,
  ProfileId,
  ResearchClaimId,
  ResearchQuestionId,
  RunId,
} from "./ids";
import {
  auditResearchCoverage,
  createLearningContinuationCheckpoint,
  createLearningPlan,
  createResearchLedger,
  projectObjectiveMastery,
  selectNextLearningObjectives,
  type LearningAssessmentResult,
  type LearningObjective,
  type LearningPlan,
} from "./learning-research";

const id = <T extends string>(value: string) => value as T;
const now = "2026-08-13T08:00:00.000Z";
const hash = (character: string) => character.repeat(64);
const profileId = id<ProfileId>("01K2H000000000000000000201");
const planId = id<LearningPlanId>("01K2H000000000000000000202");
const foundationId = id<LearningObjectiveId>("01K2H000000000000000000203");
const applicationId = id<LearningObjectiveId>("01K2H000000000000000000204");
const transferId = id<LearningObjectiveId>("01K2H000000000000000000205");
const questionOneId = id<ResearchQuestionId>("01K2H000000000000000000206");
const questionTwoId = id<ResearchQuestionId>("01K2H000000000000000000207");
const claimOneId = id<ResearchClaimId>("01K2H000000000000000000208");
const claimTwoId = id<ResearchClaimId>("01K2H000000000000000000209");
const evidenceOneId = id<LearningEvidenceId>("01K2H000000000000000000210");
const evidenceTwoId = id<LearningEvidenceId>("01K2H000000000000000000211");
const runId = id<RunId>("01K2H000000000000000000212");
const snapshotId = id<ContextSnapshotId>("01K2H000000000000000000213");

function objective(
  input: Pick<LearningObjective, "id" | "title" | "prerequisiteIds"> &
    Partial<LearningObjective>,
): LearningObjective {
  return {
    id: input.id,
    title: input.title,
    description: input.description ?? `Understand ${input.title} precisely and apply it.`,
    kind: input.kind ?? "concept",
    depth: input.depth ?? "foundation",
    prerequisiteIds: input.prerequisiteIds,
    masterySignals: input.masterySignals ?? ["explain", "apply"],
    state: input.state ?? "planned",
    importance: input.importance ?? 0.8,
    estimatedMinutes: input.estimatedMinutes ?? 30,
    sourceQuestionIds: input.sourceQuestionIds ?? [],
    metadata: input.metadata ?? {},
  };
}

function plan(): LearningPlan {
  return createLearningPlan({
    id: planId,
    profileId,
    title: "Graph foundations",
    learnerGoal: "Learn graph algorithms from definitions through novel problem transfer.",
    assumedBackground: ["Basic programming"],
    constraints: ["Show derivations before templates"],
    objectives: [
      objective({ id: foundationId, title: "Graph representation", prerequisiteIds: [] }),
      objective({
        id: applicationId,
        title: "Shortest paths",
        kind: "problem-pattern",
        depth: "working",
        prerequisiteIds: [foundationId],
      }),
      objective({
        id: transferId,
        title: "Novel graph modeling",
        kind: "transfer",
        depth: "advanced",
        prerequisiteIds: [applicationId],
      }),
    ],
    now,
  });
}

describe("learning plan", () => {
  it("creates an immutable prerequisite graph with observable mastery signals", () => {
    const created = plan();
    expect(created.objectiveIds).toEqual([foundationId, applicationId, transferId]);
    expect(Object.isFrozen(created)).toBe(true);
    expect(Object.isFrozen(created.objectives[0])).toBe(true);
    expect(created.objectives[1]?.masterySignals).toEqual(["explain", "apply"]);
  });

  it("rejects missing prerequisites and cycles", () => {
    const missing = id<LearningObjectiveId>("01K2H000000000000000000299");
    expect(() =>
      createLearningPlan({
        id: planId,
        profileId,
        title: "Invalid plan",
        learnerGoal: "Detect a malformed dependency graph.",
        objectives: [objective({ id: foundationId, title: "A", prerequisiteIds: [missing] })],
        now,
      }),
    ).toThrowError(DomainError);

    expect(() =>
      createLearningPlan({
        id: planId,
        profileId,
        title: "Cyclic plan",
        learnerGoal: "Detect a cyclic dependency graph.",
        objectives: [
          objective({ id: foundationId, title: "A", prerequisiteIds: [applicationId] }),
          objective({ id: applicationId, title: "B", prerequisiteIds: [foundationId] }),
        ],
        now,
      }),
    ).toThrowError(DomainError);
  });
});

describe("research evidence ledger", () => {
  it("derives coverage from verified evidence and keeps gaps visible", () => {
    const learningPlan = plan();
    const ledger = createResearchLedger({
      questions: [
        {
          id: questionOneId,
          text: "What representation preserves the required graph operations?",
          state: "answered",
          priority: 1,
          prerequisiteQuestionIds: [],
          learningObjectiveIds: [foundationId],
          answerClaimIds: [claimOneId],
        },
        {
          id: questionTwoId,
          text: "When should Dijkstra be replaced by another shortest-path method?",
          state: "searching",
          priority: 0.9,
          prerequisiteQuestionIds: [questionOneId],
          learningObjectiveIds: [applicationId],
          answerClaimIds: [claimTwoId],
        },
      ],
      evidence: [
        {
          id: evidenceOneId,
          sourceId: "source-a",
          sourceVersionId: "version-a",
          sourceKind: "attachment",
          sourceContentHash: hash("a"),
          contextSnapshotId: snapshotId,
          start: 4,
          end: 42,
          stance: "supports",
          verificationState: "verified",
          retrievedAt: now,
        },
        {
          id: evidenceTwoId,
          sourceId: "source-b",
          sourceVersionId: "version-b",
          sourceKind: "web",
          sourceContentHash: hash("b"),
          contextSnapshotId: snapshotId,
          start: 2,
          end: 20,
          stance: "contextualizes",
          verificationState: "unverified",
          retrievedAt: now,
        },
      ],
      claims: [
        {
          id: claimOneId,
          text: "Adjacency lists preserve sparse-neighbor traversal with linear storage in vertices and edges.",
          kind: "principle",
          status: "supported",
          confidence: 0.93,
          questionIds: [questionOneId],
          objectiveIds: [foundationId],
          evidenceIds: [evidenceOneId],
          createdByRunId: runId,
          createdAt: now,
        },
        {
          id: claimTwoId,
          text: "The current sources do not yet establish every shortest-path boundary condition.",
          kind: "open-question",
          status: "unsupported",
          confidence: 0.3,
          questionIds: [questionTwoId],
          objectiveIds: [applicationId],
          evidenceIds: [evidenceTwoId],
          createdByRunId: runId,
          createdAt: now,
        },
      ],
    });

    const coverage = auditResearchCoverage(learningPlan, ledger);
    expect(coverage.questionCoverage).toBe(0.5);
    expect(coverage.objectiveCoverage).toBeCloseTo(1 / 3);
    expect(coverage.supportedClaimRate).toBe(0.5);
    expect(coverage.unansweredQuestionIds).toEqual([questionTwoId]);
    expect(coverage.uncoveredObjectiveIds).toEqual([applicationId, transferId]);
    expect(coverage.sourceDiversity).toBe(2);
    expect(coverage.verifiedEvidenceRate).toBe(0.5);
  });

  it("fails closed when a supported claim lacks verified supporting evidence", () => {
    expect(() =>
      createResearchLedger({
        questions: [
          {
            id: questionOneId,
            text: "What evidence supports this claim?",
            state: "answered",
            priority: 1,
            prerequisiteQuestionIds: [],
            learningObjectiveIds: [foundationId],
            answerClaimIds: [claimOneId],
          },
        ],
        evidence: [
          {
            id: evidenceOneId,
            sourceId: "source-a",
            sourceVersionId: "version-a",
            sourceKind: "web",
            sourceContentHash: hash("a"),
            contextSnapshotId: snapshotId,
            start: 0,
            end: 10,
            stance: "supports",
            verificationState: "unverified",
            retrievedAt: now,
          },
        ],
        claims: [
          {
            id: claimOneId,
            text: "This claim must not be presented as supported yet.",
            kind: "fact",
            status: "supported",
            confidence: 0.8,
            questionIds: [questionOneId],
            objectiveIds: [foundationId],
            evidenceIds: [evidenceOneId],
            createdByRunId: runId,
            createdAt: now,
          },
        ],
      }),
    ).toThrowError(DomainError);
  });
});

describe("mastery and continuation", () => {
  it("requires transfer evidence before projecting mastery", () => {
    const foundation = plan().objectives[0]!;
    const retrieval: LearningAssessmentResult = {
      id: id<LearningAssessmentId>("01K2H000000000000000000214"),
      objectiveId: foundationId,
      kind: "retrieval",
      score: 0.94,
      confidence: 0.9,
      misconceptionTags: [],
      evidenceMessageIds: [id<MessageId>("01K2H000000000000000000215")],
      sourceRunId: runId,
      completedAt: now,
    };
    const withoutTransfer = projectObjectiveMastery({ objective: foundation, assessments: [retrieval], now });
    expect(withoutTransfer.state).toBe("practicing");

    const transfer: LearningAssessmentResult = {
      ...retrieval,
      id: id<LearningAssessmentId>("01K2H000000000000000000216"),
      kind: "transfer",
      score: 0.9,
      confidence: 0.95,
    };
    const withTransfer = projectObjectiveMastery({ objective: foundation, assessments: [retrieval, transfer], now });
    expect(withTransfer.state).toBe("mastered");
    expect(withTransfer.nextReviewAt).toBe("2026-08-27T08:00:00.000Z");
  });

  it("selects only the teachable frontier and prioritizes revisits", () => {
    const objectives = plan().objectives;
    const selected = selectNextLearningObjectives(
      [
        { objective: { ...objectives[0]!, state: "mastered" } },
        { objective: { ...objectives[1]!, state: "revisit" } },
        { objective: objectives[2]! },
      ],
      3,
    );
    expect(selected.map((item) => item.id)).toEqual([applicationId]);
  });

  it("creates monotonic continuation receipts and rejects coverage regression", () => {
    const first = createLearningContinuationCheckpoint({
      parentRunId: runId,
      completedObjectiveIds: [foundationId],
      remainingObjectiveIds: [applicationId, transferId],
      completedClaimIds: [claimOneId],
      unresolvedQuestionIds: [questionTwoId],
      contextSnapshotId: snapshotId,
      reason: "output-limit",
      createdAt: now,
    });
    const second = createLearningContinuationCheckpoint({
      previous: first,
      parentRunId: runId,
      completedObjectiveIds: [foundationId, applicationId],
      remainingObjectiveIds: [transferId],
      completedClaimIds: [claimOneId, claimTwoId],
      unresolvedQuestionIds: [],
      contextSnapshotId: snapshotId,
      reason: "coverage-gap",
      createdAt: "2026-08-13T08:10:00.000Z",
    });
    expect(second.sequence).toBe(2);

    expect(() =>
      createLearningContinuationCheckpoint({
        previous: second,
        parentRunId: runId,
        completedObjectiveIds: [foundationId],
        remainingObjectiveIds: [applicationId, transferId],
        completedClaimIds: [],
        unresolvedQuestionIds: [],
        contextSnapshotId: snapshotId,
        reason: "verification-revision",
        createdAt: "2026-08-13T08:20:00.000Z",
      }),
    ).toThrowError(DomainError);
  });
});
