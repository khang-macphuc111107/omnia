import { assertDomain } from "./errors";
import type {
  ContextSnapshotId,
  LearningAssessmentId,
  LearningEvidenceId,
  LearningObjectiveId,
  LearningPlanId,
  MessageId,
  ProfileId,
  ProjectId,
  ResearchClaimId,
  ResearchQuestionId,
  RunId,
} from "./ids";
import {
  assertIsoTimestamp,
  assertNonBlank,
  assertSha256,
  stableSort,
  type IsoTimestamp,
  type JsonObject,
} from "./shared";

export type LearningDepth = "orientation" | "foundation" | "working" | "advanced" | "frontier";
export type LearningObjectiveKind =
  | "concept"
  | "principle"
  | "procedure"
  | "problem-pattern"
  | "proof"
  | "implementation"
  | "transfer";
export type LearningObjectiveState = "planned" | "learning" | "practicing" | "mastered" | "revisit";
export type MasterySignal =
  | "explain"
  | "recognize"
  | "derive"
  | "apply"
  | "debug"
  | "compare"
  | "teach"
  | "transfer";

export interface LearningObjective {
  readonly id: LearningObjectiveId;
  readonly title: string;
  readonly description: string;
  readonly kind: LearningObjectiveKind;
  readonly depth: LearningDepth;
  readonly prerequisiteIds: readonly LearningObjectiveId[];
  readonly masterySignals: readonly MasterySignal[];
  readonly state: LearningObjectiveState;
  readonly importance: number;
  readonly estimatedMinutes?: number;
  readonly sourceQuestionIds: readonly ResearchQuestionId[];
  readonly metadata: JsonObject;
}

export interface LearningPlan {
  readonly schemaVersion: 1;
  readonly id: LearningPlanId;
  readonly profileId: ProfileId;
  readonly projectId?: ProjectId;
  readonly title: string;
  readonly learnerGoal: string;
  readonly assumedBackground: readonly string[];
  readonly constraints: readonly string[];
  readonly objectiveIds: readonly LearningObjectiveId[];
  readonly objectives: readonly LearningObjective[];
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly metadata: JsonObject;
}

export interface CreateLearningPlanInput {
  readonly id: LearningPlanId;
  readonly profileId: ProfileId;
  readonly projectId?: ProjectId;
  readonly title: string;
  readonly learnerGoal: string;
  readonly assumedBackground?: readonly string[];
  readonly constraints?: readonly string[];
  readonly objectives: readonly LearningObjective[];
  readonly now: IsoTimestamp;
  readonly metadata?: JsonObject;
}

function normalizedUniqueStrings(values: readonly string[], label: string): readonly string[] {
  const normalized = values.map((value) => assertNonBlank(value, label, 2_000));
  assertDomain(
    new Set(normalized.map((value) => value.toLocaleLowerCase())).size === normalized.length,
    "conflict",
    `${label} appears more than once.`,
  );
  return Object.freeze(normalized);
}

function normalizedDistinctStrings(values: readonly string[], label: string): readonly string[] {
  const normalized = values.map((value) => assertNonBlank(value, label, 2_000));
  return Object.freeze(
    normalized.filter(
      (value, index) =>
        normalized.findIndex((candidate) => candidate.toLocaleLowerCase() === value.toLocaleLowerCase()) === index,
    ),
  );
}

function assertUnitInterval(value: number, label: string): number {
  assertDomain(
    Number.isFinite(value) && value >= 0 && value <= 1,
    "invalid_argument",
    `${label} must be between zero and one.`,
    { label, value },
  );
  return value;
}

function assertObjectiveGraph(objectives: readonly LearningObjective[]): void {
  assertDomain(objectives.length > 0, "invalid_argument", "A learning plan requires at least one objective.");
  const byId = new Map<LearningObjectiveId, LearningObjective>();
  for (const objective of objectives) {
    assertDomain(!byId.has(objective.id), "conflict", "Learning objective ID appears more than once.", {
      objectiveId: objective.id,
    });
    assertNonBlank(objective.title, "learning objective title", 500);
    assertNonBlank(objective.description, "learning objective description", 4_000);
    assertUnitInterval(objective.importance, "learning objective importance");
    assertDomain(
      objective.estimatedMinutes === undefined ||
        (Number.isSafeInteger(objective.estimatedMinutes) && objective.estimatedMinutes > 0),
      "invalid_argument",
      "Estimated learning time must be a positive integer when provided.",
      { objectiveId: objective.id },
    );
    assertDomain(
      objective.masterySignals.length > 0,
      "invalid_argument",
      "Every learning objective requires at least one observable mastery signal.",
      { objectiveId: objective.id },
    );
    assertDomain(
      new Set(objective.prerequisiteIds).size === objective.prerequisiteIds.length,
      "conflict",
      "A prerequisite cannot be listed more than once.",
      { objectiveId: objective.id },
    );
    assertDomain(
      new Set(objective.masterySignals).size === objective.masterySignals.length,
      "conflict",
      "A mastery signal cannot be listed more than once.",
      { objectiveId: objective.id },
    );
    byId.set(objective.id, objective);
  }
  for (const objective of objectives) {
    for (const prerequisiteId of objective.prerequisiteIds) {
      assertDomain(prerequisiteId !== objective.id, "invalid_argument", "An objective cannot depend on itself.", {
        objectiveId: objective.id,
      });
      assertDomain(byId.has(prerequisiteId), "not_found", "A learning prerequisite was not found in the plan.", {
        objectiveId: objective.id,
        prerequisiteId,
      });
    }
  }

  const visiting = new Set<LearningObjectiveId>();
  const visited = new Set<LearningObjectiveId>();
  const visit = (objectiveId: LearningObjectiveId): void => {
    if (visited.has(objectiveId)) return;
    assertDomain(!visiting.has(objectiveId), "invalid_argument", "Learning objective prerequisites contain a cycle.", {
      objectiveId,
    });
    visiting.add(objectiveId);
    const objective = byId.get(objectiveId);
    assertDomain(objective !== undefined, "not_found", "Learning objective was not found.", { objectiveId });
    for (const prerequisiteId of objective.prerequisiteIds) visit(prerequisiteId);
    visiting.delete(objectiveId);
    visited.add(objectiveId);
  };
  for (const objective of objectives) visit(objective.id);
}

function freezeObjective(objective: LearningObjective): LearningObjective {
  return Object.freeze({
    ...objective,
    title: assertNonBlank(objective.title, "learning objective title", 500),
    description: assertNonBlank(objective.description, "learning objective description", 4_000),
    prerequisiteIds: Object.freeze([...objective.prerequisiteIds]),
    masterySignals: Object.freeze([...objective.masterySignals]),
    sourceQuestionIds: Object.freeze([...objective.sourceQuestionIds]),
    metadata: Object.freeze({ ...objective.metadata }),
  });
}

/** Creates an inspectable prerequisite DAG instead of an opaque model-authored syllabus. */
export function createLearningPlan(input: CreateLearningPlanInput): LearningPlan {
  assertIsoTimestamp(input.now, "learning plan creation time");
  assertObjectiveGraph(input.objectives);
  const objectives = Object.freeze(input.objectives.map(freezeObjective));
  return Object.freeze({
    schemaVersion: 1,
    id: input.id,
    profileId: input.profileId,
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    title: assertNonBlank(input.title, "learning plan title", 500),
    learnerGoal: assertNonBlank(input.learnerGoal, "learner goal", 8_000),
    assumedBackground: normalizedUniqueStrings(input.assumedBackground ?? [], "assumed background item"),
    constraints: normalizedUniqueStrings(input.constraints ?? [], "learning constraint"),
    objectiveIds: Object.freeze(objectives.map((objective) => objective.id)),
    objectives,
    createdAt: input.now,
    updatedAt: input.now,
    metadata: Object.freeze({ ...(input.metadata ?? {}) }),
  });
}

export type ResearchQuestionState = "planned" | "searching" | "answered" | "blocked" | "superseded";

export interface ResearchQuestion {
  readonly id: ResearchQuestionId;
  readonly text: string;
  readonly state: ResearchQuestionState;
  readonly priority: number;
  readonly prerequisiteQuestionIds: readonly ResearchQuestionId[];
  readonly learningObjectiveIds: readonly LearningObjectiveId[];
  readonly answerClaimIds: readonly ResearchClaimId[];
}

export type ResearchSourceKind =
  | "web"
  | "attachment"
  | "workspace"
  | "connected-source"
  | "conversation"
  | "artifact";
export type EvidenceStance = "supports" | "contradicts" | "contextualizes";
export type EvidenceVerificationState = "verified" | "unverified" | "mismatch" | "unavailable";

export interface LearningEvidence {
  readonly id: LearningEvidenceId;
  readonly sourceId: string;
  readonly sourceVersionId: string;
  readonly sourceKind: ResearchSourceKind;
  readonly sourceContentHash: string;
  readonly contextSnapshotId: ContextSnapshotId;
  readonly start: number;
  readonly end: number;
  readonly stance: EvidenceStance;
  readonly verificationState: EvidenceVerificationState;
  readonly retrievedAt: IsoTimestamp;
}

export type ResearchClaimKind = "fact" | "definition" | "principle" | "inference" | "recommendation" | "open-question";
export type ResearchClaimStatus = "draft" | "supported" | "disputed" | "unsupported" | "superseded";

export interface ResearchClaim {
  readonly id: ResearchClaimId;
  readonly text: string;
  readonly kind: ResearchClaimKind;
  readonly status: ResearchClaimStatus;
  readonly confidence: number;
  readonly questionIds: readonly ResearchQuestionId[];
  readonly objectiveIds: readonly LearningObjectiveId[];
  readonly evidenceIds: readonly LearningEvidenceId[];
  readonly supersedesClaimId?: ResearchClaimId;
  readonly createdByRunId: RunId;
  readonly createdAt: IsoTimestamp;
}

export interface ResearchLedger {
  readonly schemaVersion: 1;
  readonly questions: readonly ResearchQuestion[];
  readonly evidence: readonly LearningEvidence[];
  readonly claims: readonly ResearchClaim[];
}

export interface CreateResearchLedgerInput {
  readonly questions: readonly ResearchQuestion[];
  readonly evidence?: readonly LearningEvidence[];
  readonly claims?: readonly ResearchClaim[];
}

function assertUniqueIds<T extends { readonly id: string }>(items: readonly T[], label: string): void {
  const ids = items.map((item) => item.id);
  assertDomain(new Set(ids).size === ids.length, "conflict", `${label} ID appears more than once.`);
}

function assertResearchLedger(ledger: CreateResearchLedgerInput): void {
  assertUniqueIds(ledger.questions, "Research question");
  assertUniqueIds(ledger.evidence ?? [], "Research evidence");
  assertUniqueIds(ledger.claims ?? [], "Research claim");
  const questionIds = new Set(ledger.questions.map((question) => question.id));
  const evidenceIds = new Set((ledger.evidence ?? []).map((evidence) => evidence.id));
  const claimIds = new Set((ledger.claims ?? []).map((claim) => claim.id));

  for (const question of ledger.questions) {
    assertNonBlank(question.text, "research question", 4_000);
    assertUnitInterval(question.priority, "research question priority");
    for (const prerequisiteId of question.prerequisiteQuestionIds) {
      assertDomain(prerequisiteId !== question.id, "invalid_argument", "A research question cannot depend on itself.");
      assertDomain(questionIds.has(prerequisiteId), "not_found", "A prerequisite research question was not found.", {
        questionId: question.id,
        prerequisiteId,
      });
    }
    for (const claimId of question.answerClaimIds) {
      assertDomain(claimIds.has(claimId), "not_found", "A research question references an unknown claim.", {
        questionId: question.id,
        claimId,
      });
    }
  }

  for (const evidence of ledger.evidence ?? []) {
    assertNonBlank(evidence.sourceId, "evidence source ID", 1_000);
    assertNonBlank(evidence.sourceVersionId, "evidence source version ID", 1_000);
    assertSha256(evidence.sourceContentHash, "research evidence content hash");
    assertIsoTimestamp(evidence.retrievedAt, "evidence retrieval time");
    assertDomain(
      Number.isSafeInteger(evidence.start) &&
        Number.isSafeInteger(evidence.end) &&
        evidence.start >= 0 &&
        evidence.end > evidence.start,
      "invalid_argument",
      "Research evidence must retain a positive source span.",
      { evidenceId: evidence.id },
    );
  }

  for (const claim of ledger.claims ?? []) {
    assertNonBlank(claim.text, "research claim", 8_000);
    assertUnitInterval(claim.confidence, "research claim confidence");
    assertIsoTimestamp(claim.createdAt, "research claim creation time");
    for (const questionId of claim.questionIds) {
      assertDomain(questionIds.has(questionId), "not_found", "A research claim references an unknown question.", {
        claimId: claim.id,
        questionId,
      });
    }
    for (const evidenceId of claim.evidenceIds) {
      assertDomain(evidenceIds.has(evidenceId), "not_found", "A research claim references unknown evidence.", {
        claimId: claim.id,
        evidenceId,
      });
    }
    assertDomain(
      claim.supersedesClaimId === undefined ||
        (claim.supersedesClaimId !== claim.id && claimIds.has(claim.supersedesClaimId)),
      "not_found",
      "A superseded research claim was not found.",
      { claimId: claim.id, supersedesClaimId: claim.supersedesClaimId },
    );
    const linkedEvidence = (ledger.evidence ?? []).filter((evidence) => claim.evidenceIds.includes(evidence.id));
    const verifiedSupport = linkedEvidence.some(
      (evidence) => evidence.stance === "supports" && evidence.verificationState === "verified",
    );
    const verifiedContradiction = linkedEvidence.some(
      (evidence) => evidence.stance === "contradicts" && evidence.verificationState === "verified",
    );
    assertDomain(
      claim.status !== "supported" || (verifiedSupport && !verifiedContradiction),
      "invalid_state_transition",
      "A supported research claim requires verified support and no verified contradiction.",
      { claimId: claim.id },
    );
    assertDomain(
      claim.status !== "disputed" || verifiedContradiction,
      "invalid_state_transition",
      "A disputed research claim requires verified contradicting evidence.",
      { claimId: claim.id },
    );
  }
}

/** Builds a frozen evidence ledger. Claim status is derived from retained evidence, never presentation text. */
export function createResearchLedger(input: CreateResearchLedgerInput): ResearchLedger {
  assertResearchLedger(input);
  return Object.freeze({
    schemaVersion: 1,
    questions: Object.freeze(
      input.questions.map((question) =>
        Object.freeze({
          ...question,
          text: assertNonBlank(question.text, "research question", 4_000),
          prerequisiteQuestionIds: Object.freeze([...question.prerequisiteQuestionIds]),
          learningObjectiveIds: Object.freeze([...question.learningObjectiveIds]),
          answerClaimIds: Object.freeze([...question.answerClaimIds]),
        }),
      ),
    ),
    evidence: Object.freeze((input.evidence ?? []).map((evidence) => Object.freeze({ ...evidence }))),
    claims: Object.freeze(
      (input.claims ?? []).map((claim) =>
        Object.freeze({
          ...claim,
          text: assertNonBlank(claim.text, "research claim", 8_000),
          questionIds: Object.freeze([...claim.questionIds]),
          objectiveIds: Object.freeze([...claim.objectiveIds]),
          evidenceIds: Object.freeze([...claim.evidenceIds]),
        }),
      ),
    ),
  });
}

export interface ResearchCoverageReport {
  readonly questionCoverage: number;
  readonly objectiveCoverage: number;
  readonly supportedClaimRate: number;
  readonly disputedClaimIds: readonly ResearchClaimId[];
  readonly unsupportedClaimIds: readonly ResearchClaimId[];
  readonly unansweredQuestionIds: readonly ResearchQuestionId[];
  readonly uncoveredObjectiveIds: readonly LearningObjectiveId[];
  readonly sourceDiversity: number;
  readonly verifiedEvidenceRate: number;
}

/** Computes honest coverage without interpreting an unanswered item as model failure or silently dropping it. */
export function auditResearchCoverage(
  plan: LearningPlan,
  ledger: ResearchLedger,
): ResearchCoverageReport {
  const claimsById = new Map(ledger.claims.map((claim) => [claim.id, claim]));
  const answeredQuestionIds = new Set(
    ledger.questions
      .filter((question) =>
        question.answerClaimIds.some((claimId) => {
          const claim = claimsById.get(claimId);
          return claim !== undefined && claim.status !== "draft" && claim.status !== "unsupported";
        }),
      )
      .map((question) => question.id),
  );
  const coveredObjectiveIds = new Set<LearningObjectiveId>();
  for (const claim of ledger.claims) {
    if (claim.status === "supported" || claim.status === "disputed") {
      for (const objectiveId of claim.objectiveIds) coveredObjectiveIds.add(objectiveId);
    }
  }
  const supportedClaims = ledger.claims.filter((claim) => claim.status === "supported");
  const disputedClaimIds = ledger.claims.filter((claim) => claim.status === "disputed").map((claim) => claim.id);
  const unsupportedClaimIds = ledger.claims.filter((claim) => claim.status === "unsupported").map((claim) => claim.id);
  const evidenceSourceCount = new Set(
    ledger.evidence.map((evidence) => `${evidence.sourceKind}:${evidence.sourceId}:${evidence.sourceVersionId}`),
  ).size;
  const verifiedEvidenceCount = ledger.evidence.filter((evidence) => evidence.verificationState === "verified").length;
  const ratio = (numerator: number, denominator: number): number =>
    denominator === 0 ? 0 : numerator / denominator;

  return Object.freeze({
    questionCoverage: ratio(answeredQuestionIds.size, ledger.questions.length),
    objectiveCoverage: ratio(
      plan.objectiveIds.filter((objectiveId) => coveredObjectiveIds.has(objectiveId)).length,
      plan.objectiveIds.length,
    ),
    supportedClaimRate: ratio(supportedClaims.length, ledger.claims.length),
    disputedClaimIds: Object.freeze(disputedClaimIds),
    unsupportedClaimIds: Object.freeze(unsupportedClaimIds),
    unansweredQuestionIds: Object.freeze(
      ledger.questions.filter((question) => !answeredQuestionIds.has(question.id)).map((question) => question.id),
    ),
    uncoveredObjectiveIds: Object.freeze(
      plan.objectiveIds.filter((objectiveId) => !coveredObjectiveIds.has(objectiveId)),
    ),
    sourceDiversity: evidenceSourceCount,
    verifiedEvidenceRate: ratio(verifiedEvidenceCount, ledger.evidence.length),
  });
}

export type LearningAssessmentKind = "diagnostic" | "retrieval" | "worked-example" | "transfer" | "self-explanation";

export interface LearningAssessmentResult {
  readonly id: LearningAssessmentId;
  readonly objectiveId: LearningObjectiveId;
  readonly kind: LearningAssessmentKind;
  readonly score: number;
  readonly confidence: number;
  readonly misconceptionTags: readonly string[];
  readonly evidenceMessageIds: readonly MessageId[];
  readonly sourceRunId: RunId;
  readonly completedAt: IsoTimestamp;
}

function assertAssessmentResult(assessment: LearningAssessmentResult): void {
  assertUnitInterval(assessment.score, "learning assessment score");
  assertUnitInterval(assessment.confidence, "learning assessment confidence");
  assertIsoTimestamp(assessment.completedAt, "learning assessment completion time");
  assertDomain(
    new Set(assessment.evidenceMessageIds).size === assessment.evidenceMessageIds.length,
    "conflict",
    "Learning assessment evidence message ID appears more than once.",
    { assessmentId: assessment.id },
  );
}

export interface ObjectiveMasteryProjection {
  readonly objectiveId: LearningObjectiveId;
  readonly state: LearningObjectiveState;
  readonly mastery: number;
  readonly evidenceCount: number;
  readonly misconceptionTags: readonly string[];
  readonly nextReviewAt: IsoTimestamp | null;
}

const ASSESSMENT_WEIGHT: Readonly<Record<LearningAssessmentKind, number>> = Object.freeze({
  diagnostic: 0.55,
  retrieval: 1,
  "worked-example": 0.75,
  transfer: 1.25,
  "self-explanation": 0.9,
});

export interface ProjectMasteryInput {
  readonly objective: LearningObjective;
  readonly assessments: readonly LearningAssessmentResult[];
  readonly now: IsoTimestamp;
  readonly revisitThreshold?: number;
  readonly masteryThreshold?: number;
}

/** Projects mastery from observable assessments; confidence scales evidence weight rather than becoming mastery itself. */
export function projectObjectiveMastery(input: ProjectMasteryInput): ObjectiveMasteryProjection {
  assertIsoTimestamp(input.now, "mastery projection time");
  const revisitThreshold = input.revisitThreshold ?? 0.55;
  const masteryThreshold = input.masteryThreshold ?? 0.82;
  assertUnitInterval(revisitThreshold, "revisit threshold");
  assertUnitInterval(masteryThreshold, "mastery threshold");
  assertDomain(revisitThreshold < masteryThreshold, "invalid_argument", "Revisit threshold must be below mastery threshold.");
  const matching = input.assessments.filter((assessment) => assessment.objectiveId === input.objective.id);
  let weightedScore = 0;
  let totalWeight = 0;
  for (const assessment of matching) {
    assertAssessmentResult(assessment);
    const weight = ASSESSMENT_WEIGHT[assessment.kind] * Math.max(assessment.confidence, 0.1);
    weightedScore += assessment.score * weight;
    totalWeight += weight;
  }
  const mastery = totalWeight === 0 ? 0 : weightedScore / totalWeight;
  const misconceptionTags = normalizedDistinctStrings(
    matching.flatMap((assessment) => assessment.misconceptionTags),
    "misconception tag",
  );
  let state: LearningObjectiveState;
  if (matching.length === 0) state = input.objective.state === "planned" ? "planned" : "learning";
  else if (mastery >= masteryThreshold && !matching.some((assessment) => assessment.kind === "transfer")) state = "practicing";
  else if (mastery >= masteryThreshold) state = "mastered";
  else if (mastery < revisitThreshold) state = "revisit";
  else state = "practicing";

  const reviewDelayDays = state === "mastered" ? 14 : state === "practicing" ? 3 : state === "revisit" ? 1 : 0;
  const nextReviewAt =
    reviewDelayDays === 0 ? null : new Date(Date.parse(input.now) + reviewDelayDays * 86_400_000).toISOString();
  return Object.freeze({
    objectiveId: input.objective.id,
    state,
    mastery,
    evidenceCount: matching.length,
    misconceptionTags,
    nextReviewAt,
  });
}

export type ContinuationReason = "output-limit" | "coverage-gap" | "user-requested-depth" | "verification-revision";

export interface LearningContinuationCheckpoint {
  readonly sequence: number;
  readonly parentRunId: RunId;
  readonly completedObjectiveIds: readonly LearningObjectiveId[];
  readonly remainingObjectiveIds: readonly LearningObjectiveId[];
  readonly completedClaimIds: readonly ResearchClaimId[];
  readonly unresolvedQuestionIds: readonly ResearchQuestionId[];
  readonly contextSnapshotId: ContextSnapshotId;
  readonly reason: ContinuationReason;
  readonly createdAt: IsoTimestamp;
}

export interface CreateContinuationCheckpointInput extends Omit<LearningContinuationCheckpoint, "sequence"> {
  readonly previous?: LearningContinuationCheckpoint;
}

/** Creates a monotonic continuation receipt so multi-answer lessons resume from explicit coverage, not prose guesses. */
export function createLearningContinuationCheckpoint(
  input: CreateContinuationCheckpointInput,
): LearningContinuationCheckpoint {
  assertIsoTimestamp(input.createdAt, "learning continuation time");
  assertDomain(
    new Set(input.completedObjectiveIds).size === input.completedObjectiveIds.length &&
      new Set(input.remainingObjectiveIds).size === input.remainingObjectiveIds.length,
    "conflict",
    "Continuation objective IDs must be unique.",
  );
  assertDomain(
    new Set(input.completedClaimIds).size === input.completedClaimIds.length &&
      new Set(input.unresolvedQuestionIds).size === input.unresolvedQuestionIds.length,
    "conflict",
    "Continuation claim and question IDs must be unique.",
  );
  const completed = new Set(input.completedObjectiveIds);
  assertDomain(
    !input.remainingObjectiveIds.some((objectiveId) => completed.has(objectiveId)),
    "invalid_argument",
    "An objective cannot be both completed and remaining.",
  );
  if (input.previous !== undefined) {
    assertDomain(
      Date.parse(input.createdAt) >= Date.parse(input.previous.createdAt),
      "invalid_state_transition",
      "A continuation cannot predate its parent checkpoint.",
    );
    const previousCompleted = new Set(input.previous.completedObjectiveIds);
    const previousScope = new Set([
      ...input.previous.completedObjectiveIds,
      ...input.previous.remainingObjectiveIds,
    ]);
    const nextScope = new Set([...input.completedObjectiveIds, ...input.remainingObjectiveIds]);
    assertDomain(
      input.completedObjectiveIds.every(
        (objectiveId) => previousCompleted.has(objectiveId) || input.previous?.remainingObjectiveIds.includes(objectiveId),
      ),
      "scope_violation",
      "A continuation cannot introduce objectives outside its parent checkpoint.",
    );
    assertDomain(
      input.previous.completedObjectiveIds.every((objectiveId) => completed.has(objectiveId)),
      "invalid_state_transition",
      "A continuation cannot mark a completed objective as incomplete.",
    );
    assertDomain(
      nextScope.size === previousScope.size && [...nextScope].every((objectiveId) => previousScope.has(objectiveId)),
      "scope_violation",
      "A continuation must preserve the objective scope of its parent checkpoint.",
    );
  }
  return Object.freeze({
    sequence: (input.previous?.sequence ?? 0) + 1,
    parentRunId: input.parentRunId,
    completedObjectiveIds: Object.freeze([...input.completedObjectiveIds]),
    remainingObjectiveIds: Object.freeze([...input.remainingObjectiveIds]),
    completedClaimIds: Object.freeze([...input.completedClaimIds]),
    unresolvedQuestionIds: Object.freeze([...input.unresolvedQuestionIds]),
    contextSnapshotId: input.contextSnapshotId,
    reason: input.reason,
    createdAt: input.createdAt,
  });
}

export interface NextLearningObjectiveCandidate {
  readonly objective: LearningObjective;
  readonly mastery?: ObjectiveMasteryProjection;
}

/** Deterministically selects the next teachable frontier while respecting prerequisites. */
export function selectNextLearningObjectives(
  candidates: readonly NextLearningObjectiveCandidate[],
  maximumObjectives: number,
): readonly LearningObjective[] {
  assertDomain(
    Number.isSafeInteger(maximumObjectives) && maximumObjectives >= 0,
    "invalid_argument",
    "Maximum learning objectives must be a non-negative safe integer.",
  );
  const byId = new Map(candidates.map((candidate) => [candidate.objective.id, candidate]));
  assertDomain(byId.size === candidates.length, "conflict", "Learning objective candidate appears more than once.");
  const masteredIds = new Set(
    candidates
      .filter((candidate) => candidate.mastery?.state === "mastered" || candidate.objective.state === "mastered")
      .map((candidate) => candidate.objective.id),
  );
  const frontier = candidates.filter((candidate) => {
    const state = candidate.mastery?.state ?? candidate.objective.state;
    return (
      state !== "mastered" &&
      candidate.objective.prerequisiteIds.every((id) => {
        assertDomain(
          byId.has(id),
          "not_found",
          "A learning frontier prerequisite is missing from the candidate set.",
          { objectiveId: candidate.objective.id, prerequisiteId: id },
        );
        return masteredIds.has(id);
      })
    );
  });
  const stateRank: Readonly<Record<LearningObjectiveState, number>> = Object.freeze({
    revisit: 0,
    practicing: 1,
    learning: 2,
    planned: 3,
    mastered: 4,
  });
  return Object.freeze(
    stableSort(frontier, (left, right) => {
      const leftState = left.mastery?.state ?? left.objective.state;
      const rightState = right.mastery?.state ?? right.objective.state;
      return (
        stateRank[leftState] - stateRank[rightState] ||
        right.objective.importance - left.objective.importance ||
        left.objective.title.localeCompare(right.objective.title) ||
        left.objective.id.localeCompare(right.objective.id)
      );
    })
      .slice(0, maximumObjectives)
      .map((candidate) => candidate.objective),
  );
}
