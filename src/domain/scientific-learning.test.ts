import { describe, expect, it } from "vitest";

import { DomainError } from "./errors";
import type {
  ContextSnapshotId,
  LearningEvidenceId,
  LearningObjectiveId,
  ResearchClaimId,
  RunId,
} from "./ids";
import {
  checkDimensionalConsistency,
  compileScientificLearningRoute,
  createScientificDerivation,
  createScientificInvestigation,
  divideDimensions,
  multiplyDimensions,
  raiseDimension,
  type ScientificDerivationId,
  type ScientificDerivationStepId,
  type ScientificHypothesisId,
  type ScientificInvestigationId,
  type ScientificLearningBlockCandidate,
  type ScientificLearningBlockId,
  type ScientificLearningRouteId,
} from "./scientific-learning";

const id = <T extends string>(value: string) => value as T;
const hash = (character: string) => character.repeat(64);
const now = "2026-08-13T10:00:00.000Z";
const objectiveId = id<LearningObjectiveId>("01K2J000000000000000000101");
const contextSnapshotId = id<ContextSnapshotId>("01K2J000000000000000000102");
const runId = id<RunId>("01K2J000000000000000000103");
const claimId = id<ResearchClaimId>("01K2J000000000000000000104");
const evidenceId = id<LearningEvidenceId>("01K2J000000000000000000105");
const derivationId = id<ScientificDerivationId>("01K2J000000000000000000106");
const definitionStepId = id<ScientificDerivationStepId>("01K2J000000000000000000107");
const conclusionStepId = id<ScientificDerivationStepId>("01K2J000000000000000000108");

describe("scientific dimensions", () => {
  it("composes dimensions and detects an invalid physical equality", () => {
    const length = { length: 1 } as const;
    const time = { time: 1 } as const;
    const velocity = divideDimensions(length, time);
    const acceleration = divideDimensions(velocity, time);
    const mass = { mass: 1 } as const;
    const force = multiplyDimensions(mass, acceleration);
    expect(force).toEqual({ length: 1, mass: 1, time: -2 });
    expect(raiseDimension(velocity, 2)).toEqual({ length: 2, time: -2 });
    expect(checkDimensionalConsistency("equality", force, { mass: 1 })).toMatchObject({
      compatible: false,
      leftKey: "length^1*mass^1*time^-2",
      rightKey: "mass^1",
    });
  });
});

describe("scientific derivation ledger", () => {
  it("creates a verified dependency chain with assumption and dimensional provenance", () => {
    const derivation = createScientificDerivation({
      id: derivationId,
      title: "Newtonian force dimensions",
      objectiveIds: [objectiveId],
      assumptions: [
        {
          id: "classical-regime",
          statement: "Velocity is sufficiently below the relativistic regime.",
          scope: "model",
          status: "active",
          evidenceIds: [evidenceId],
        },
      ],
      steps: [
        {
          id: definitionStepId,
          sequence: 1,
          kind: "definition",
          statement: "Acceleration is the rate of change of velocity.",
          expression: "a = dv/dt",
          justification: "Definition of acceleration.",
          dependsOnStepIds: [],
          assumptionIds: [],
          claimIds: [claimId],
          evidenceIds: [evidenceId],
          verificationState: "verified",
          verificationMethod: "Definition checked against the frozen source span.",
        },
        {
          id: conclusionStepId,
          sequence: 2,
          kind: "theorem-application",
          statement: "Force has dimensions mass times length divided by time squared.",
          expression: "[F] = M L T^-2",
          justification: "Substitute acceleration dimensions into F = ma.",
          dependsOnStepIds: [definitionStepId],
          assumptionIds: ["classical-regime"],
          claimIds: [claimId],
          evidenceIds: [evidenceId],
          verificationState: "verified",
          verificationMethod: "Symbolic substitution plus dimensional equality.",
          dimensionalCheck: checkDimensionalConsistency(
            "equality",
            { length: 1, mass: 1, time: -2 },
            { mass: 1, length: 1, time: -2 },
          ),
        },
      ],
      conclusionStepId,
      status: "verified",
      contextSnapshotId,
      createdByRunId: runId,
      createdAt: now,
      metadata: { policyVersion: "scientific-derivation-v1" },
    });

    expect(derivation.status).toBe("verified");
    expect(derivation.steps.map((step) => step.id)).toEqual([definitionStepId, conclusionStepId]);
    expect(derivation.steps[1]?.dimensionalCheck?.compatible).toBe(true);
    expect(Object.isFrozen(derivation.metadata)).toBe(true);
  });

  it("rejects a verified conclusion that depends on an unverified or dimensionally invalid step", () => {
    expect(() =>
      createScientificDerivation({
        id: derivationId,
        title: "Invalid derivation",
        objectiveIds: [objectiveId],
        assumptions: [],
        steps: [
          {
            id: definitionStepId,
            sequence: 1,
            kind: "algebra",
            statement: "Add unlike physical quantities.",
            justification: "This step is intentionally invalid.",
            dependsOnStepIds: [],
            assumptionIds: [],
            claimIds: [],
            evidenceIds: [],
            verificationState: "verified",
            verificationMethod: "No valid method exists.",
            dimensionalCheck: checkDimensionalConsistency("addition", { length: 1 }, { time: 1 }),
          },
        ],
        conclusionStepId: definitionStepId,
        status: "verified",
        contextSnapshotId,
        createdByRunId: runId,
        createdAt: now,
        metadata: {},
      }),
    ).toThrowError(DomainError);
  });

  it("requires every approximation to state where it is valid", () => {
    expect(() =>
      createScientificDerivation({
        id: derivationId,
        title: "Unbounded approximation",
        objectiveIds: [objectiveId],
        assumptions: [],
        steps: [
          {
            id: definitionStepId,
            sequence: 1,
            kind: "approximation",
            statement: "Use sin(x) approximately equal to x.",
            justification: "A small-angle approximation was proposed.",
            dependsOnStepIds: [],
            assumptionIds: [],
            claimIds: [],
            evidenceIds: [],
            verificationState: "unverified",
          },
        ],
        conclusionStepId: definitionStepId,
        status: "draft",
        contextSnapshotId,
        createdByRunId: runId,
        createdAt: now,
        metadata: {},
      }),
    ).toThrowError(DomainError);
  });
});

describe("scientific investigation receipt", () => {
  const investigationId = id<ScientificInvestigationId>("01K2J000000000000000000109");
  const hypothesisId = id<ScientificHypothesisId>("01K2J000000000000000000110");

  it("pins protocol, data, tools, parameters, environment, and randomness for a simulation", () => {
    const investigation = createScientificInvestigation({
      id: investigationId,
      title: "Projectile integration convergence",
      question: "How does integration step size affect trajectory error?",
      mode: "simulation",
      intent: "confirmatory",
      state: "planned",
      objectiveIds: [objectiveId],
      hypotheses: [
        {
          id: hypothesisId,
          statement: "Halving the step size reduces global error for the selected integrator.",
          rationale: "The integrator has a known convergence order.",
          predictions: [
            {
              id: "prediction-error-decreases",
              statement: "Measured endpoint error decreases as step size is halved.",
              conditions: ["Fixed initial state", "Fixed solver implementation"],
              outcomeVariableIds: ["endpoint-error"],
              expectedDirection: "decrease",
            },
          ],
          falsificationCriteria: ["Endpoint error does not decrease across the predeclared step-size sequence."],
          claimIds: [claimId],
        },
      ],
      variables: [
        {
          id: "step-size",
          name: "Integration step size",
          role: "independent",
          operationalDefinition: "The fixed delta-t passed to the integrator.",
          unit: "s",
          dimension: { time: 1 },
        },
        {
          id: "endpoint-error",
          name: "Endpoint position error",
          role: "dependent",
          operationalDefinition: "Euclidean distance from the analytical endpoint at fixed final time.",
          unit: "m",
          dimension: { length: 1 },
          measurementMethod: "Compare the simulated endpoint with the analytical reference.",
          uncertaintyModel: "Floating-point roundoff plus analytical reference tolerance.",
        },
      ],
      protocolSteps: [
        {
          id: "run-grid",
          ordinal: 1,
          title: "Run the fixed step-size grid",
          procedure: "Run the same initial state for each predeclared step size.",
          dependsOnStepIds: [],
          inputVariableIds: ["step-size"],
          outputVariableIds: ["endpoint-error"],
          safetyNotes: [],
          requiredCapabilities: ["compute.execute.bounded"],
        },
      ],
      derivationIds: [derivationId],
      claimIds: [claimId],
      evidenceIds: [evidenceId],
      reproducibility: {
        environmentHash: hash("a"),
        protocolHash: hash("b"),
        parameterHash: hash("c"),
        toolVersionHashes: { "python-runtime": hash("d") },
        dataVersionHashes: {},
        sourceVersionHashes: { "analytical-reference": hash("e") },
        randomness: { kind: "seeded", seed: "20260813", generator: "PCG64" },
        capturedAt: now,
      },
      contextSnapshotId,
      createdByRunId: runId,
      createdAt: now,
      metadata: {},
    });

    expect(investigation.reproducibility?.randomness).toEqual({
      kind: "seeded",
      seed: "20260813",
      generator: "PCG64",
    });
    expect(investigation.protocolSteps[0]?.requiredCapabilities).toEqual(["compute.execute.bounded"]);
  });

  it("rejects an unfalsifiable hypothesis and uncontrolled simulation randomness", () => {
    expect(() =>
      createScientificInvestigation({
        id: investigationId,
        title: "Invalid simulation",
        question: "Does this simulation reproduce its result?",
        mode: "simulation",
        intent: "confirmatory",
        state: "planned",
        objectiveIds: [objectiveId],
        hypotheses: [
          {
            id: hypothesisId,
            statement: "The result will be correct.",
            rationale: "No falsifiable rationale is retained.",
            predictions: [],
            falsificationCriteria: [],
            claimIds: [],
          },
        ],
        variables: [],
        protocolSteps: [],
        derivationIds: [],
        claimIds: [],
        evidenceIds: [],
        reproducibility: {
          environmentHash: hash("a"),
          protocolHash: hash("b"),
          parameterHash: hash("c"),
          toolVersionHashes: { runtime: hash("d") },
          dataVersionHashes: {},
          sourceVersionHashes: {},
          randomness: { kind: "uncontrolled", reason: "Unknown", impact: "Unknown" },
          capturedAt: now,
        },
        contextSnapshotId,
        createdByRunId: runId,
        createdAt: now,
        metadata: {},
      }),
    ).toThrowError(DomainError);
  });
});

describe("scientific learning route compiler", () => {
  const blockId = (suffix: string) => id<ScientificLearningBlockId>(`01K2J00000000000000000${suffix}`);
  const routeId = id<ScientificLearningRouteId>("01K2J000000000000000000199");

  function block(
    suffix: string,
    input: Partial<ScientificLearningBlockCandidate> & Pick<ScientificLearningBlockCandidate, "kind">,
  ): ScientificLearningBlockCandidate {
    return {
      id: blockId(suffix),
      kind: input.kind,
      objectiveIds: input.objectiveIds ?? [objectiveId],
      dependsOnBlockIds: input.dependsOnBlockIds ?? [],
      contentRef: input.contentRef ?? `content:${suffix}`,
      contentHash: input.contentHash ?? hash("f"),
      estimatedMinutes: input.estimatedMinutes ?? 5,
      estimatedOutputTokens: input.estimatedOutputTokens ?? 500,
      priority: input.priority ?? 0.7,
      masteryGap: input.masteryGap ?? 0.6,
      required: input.required ?? false,
      ...(input.excludedByUser === undefined
        ? {}
        : { excludedByUser: input.excludedByUser }),
      requiresVerifiedEvidence: input.requiresVerifiedEvidence ?? false,
      evidenceIds: input.evidenceIds ?? [],
    };
  }

  it("keeps dependencies ordered, prioritizes misconception repair, and locks solutions until an attempt", () => {
    const definitionId = blockId("120");
    const practiceId = blockId("121");
    const solutionId = blockId("122");
    const route = compileScientificLearningRoute({
      id: routeId,
      objectiveIds: [objectiveId],
      contextSnapshotId,
      candidates: [
        block("120", { kind: "definition", required: true, priority: 1 }),
        block("121", { kind: "practice", dependsOnBlockIds: [definitionId], priority: 0.8 }),
        block("122", {
          kind: "solution",
          dependsOnBlockIds: [practiceId],
          priority: 0.6,
        }),
        block("123", {
          kind: "misconception-repair",
          dependsOnBlockIds: [definitionId],
          masteryGap: 1,
          priority: 1,
        }),
        block("124", {
          kind: "evidence-map",
          dependsOnBlockIds: [definitionId],
          requiresVerifiedEvidence: true,
          evidenceIds: [],
          priority: 1,
        }),
      ],
      timeBudgetMinutes: 20,
      outputTokenBudget: 2_000,
      maximumBlocks: 4,
      disclosurePolicy: "attempt-first",
      attentionRefreshInterval: 2,
      now,
    });

    expect(route.serializedBlockIds[0]).toBe(definitionId);
    expect(route.selectedBlockIds).toContain(practiceId);
    expect(route.decisions.find((decision) => decision.candidate.id === solutionId)?.presentation).toBe(
      "locked-until-attempt",
    );
    expect(route.decisions.find((decision) => decision.candidate.id === blockId("124"))?.reason).toBe(
      "omitted-evidence",
    );
    expect(route.refreshBeforeBlockIds.length).toBe(1);
  });

  it("fails closed when required blocks do not fit instead of silently truncating them", () => {
    expect(() =>
      compileScientificLearningRoute({
        id: routeId,
        objectiveIds: [objectiveId],
        contextSnapshotId,
        candidates: [
          block("130", {
            kind: "proof",
            required: true,
            estimatedMinutes: 30,
            estimatedOutputTokens: 4_000,
          }),
        ],
        timeBudgetMinutes: 10,
        outputTokenBudget: 1_000,
        maximumBlocks: 1,
        disclosurePolicy: "guided",
        now,
      }),
    ).toThrowError(DomainError);
  });

  it("rejects hint and solution blocks that are not attached to an attemptable problem", () => {
    expect(() =>
      compileScientificLearningRoute({
        id: routeId,
        objectiveIds: [objectiveId],
        contextSnapshotId,
        candidates: [block("140", { kind: "solution" })],
        timeBudgetMinutes: 10,
        outputTokenBudget: 1_000,
        maximumBlocks: 1,
        disclosurePolicy: "open",
        now,
      }),
    ).toThrowError(DomainError);
  });
});
