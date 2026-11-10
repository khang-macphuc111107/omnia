import { assertDomain } from "./errors";
import type {
  ContextSnapshotId,
  EntityId,
  LearningEvidenceId,
  LearningObjectiveId,
  ResearchClaimId,
  RunId,
} from "./ids";
import {
  assertIsoTimestamp,
  assertNonBlank,
  assertSha256,
  freezeJson,
  stableSort,
  type IsoTimestamp,
  type JsonObject,
} from "./shared";

export type ScientificInvestigationId = EntityId<"scientific-investigation">;
export type ScientificHypothesisId = EntityId<"scientific-hypothesis">;
export type ScientificDerivationId = EntityId<"scientific-derivation">;
export type ScientificDerivationStepId = EntityId<"scientific-derivation-step">;
export type ScientificLearningRouteId = EntityId<"scientific-learning-route">;
export type ScientificLearningBlockId = EntityId<"scientific-learning-block">;

function assertUnitInterval(value: number, label: string): number {
  assertDomain(
    Number.isFinite(value) && value >= 0 && value <= 1,
    "invalid_argument",
    `${label} must be between zero and one.`,
    { label, value },
  );
  return value;
}

function assertUniqueStrings(values: readonly string[], label: string): readonly string[] {
  const normalized = values.map((value) => assertNonBlank(value, label, 2_000));
  assertDomain(new Set(normalized).size === normalized.length, "conflict", `${label} appears more than once.`);
  return Object.freeze(normalized);
}

function assertUniqueIds<T extends string>(values: readonly T[], label: string): readonly T[] {
  assertDomain(new Set(values).size === values.length, "conflict", `${label} appears more than once.`);
  return Object.freeze([...values]);
}

export const SCIENTIFIC_BASE_DIMENSIONS = Object.freeze([
  "length",
  "mass",
  "time",
  "electric-current",
  "temperature",
  "amount-of-substance",
  "luminous-intensity",
  "information",
  "angle",
] as const);

export type ScientificBaseDimension = (typeof SCIENTIFIC_BASE_DIMENSIONS)[number];

/**
 * A provider-neutral dimensional vector. For example, velocity is
 * `{ length: 1, time: -1 }`. Units and scale factors are deliberately stored
 * elsewhere; this type only proves dimensional compatibility.
 */
export type DimensionVector = Readonly<Partial<Record<ScientificBaseDimension, number>>>;

export function normalizeDimensionVector(vector: DimensionVector): DimensionVector {
  const normalized: Partial<Record<ScientificBaseDimension, number>> = {};
  for (const dimension of SCIENTIFIC_BASE_DIMENSIONS) {
    const exponent = vector[dimension] ?? 0;
    assertDomain(
      Number.isFinite(exponent) && Math.abs(exponent) <= 64,
      "invalid_argument",
      "A dimension exponent must be finite and bounded.",
      { dimension, exponent },
    );
    if (Math.abs(exponent) > Number.EPSILON) normalized[dimension] = exponent;
  }
  return Object.freeze(normalized);
}

export function dimensionVectorKey(vector: DimensionVector): string {
  const normalized = normalizeDimensionVector(vector);
  const terms = SCIENTIFIC_BASE_DIMENSIONS.flatMap((dimension) => {
    const exponent = normalized[dimension];
    return exponent === undefined ? [] : [`${dimension}^${exponent}`];
  });
  return terms.length === 0 ? "dimensionless" : terms.join("*");
}

function combineDimensionVectors(
  left: DimensionVector,
  right: DimensionVector,
  rightMultiplier: 1 | -1,
): DimensionVector {
  const result: Partial<Record<ScientificBaseDimension, number>> = {};
  for (const dimension of SCIENTIFIC_BASE_DIMENSIONS) {
    const exponent = (left[dimension] ?? 0) + (right[dimension] ?? 0) * rightMultiplier;
    if (Math.abs(exponent) > Number.EPSILON) result[dimension] = exponent;
  }
  return normalizeDimensionVector(result);
}

export function multiplyDimensions(left: DimensionVector, right: DimensionVector): DimensionVector {
  return combineDimensionVectors(left, right, 1);
}

export function divideDimensions(left: DimensionVector, right: DimensionVector): DimensionVector {
  return combineDimensionVectors(left, right, -1);
}

export function raiseDimension(vector: DimensionVector, power: number): DimensionVector {
  assertDomain(Number.isFinite(power) && Math.abs(power) <= 64, "invalid_argument", "Dimension power is invalid.", {
    power,
  });
  const result: Partial<Record<ScientificBaseDimension, number>> = {};
  for (const dimension of SCIENTIFIC_BASE_DIMENSIONS) {
    const exponent = (vector[dimension] ?? 0) * power;
    if (Math.abs(exponent) > Number.EPSILON) result[dimension] = exponent;
  }
  return normalizeDimensionVector(result);
}

export interface DimensionalConsistencyCheck {
  readonly operation: "equality" | "addition" | "subtraction" | "comparison";
  readonly left: DimensionVector;
  readonly right: DimensionVector;
  readonly leftKey: string;
  readonly rightKey: string;
  readonly compatible: boolean;
}

/** Checks an operation whose operands must share one physical dimension. */
export function checkDimensionalConsistency(
  operation: DimensionalConsistencyCheck["operation"],
  left: DimensionVector,
  right: DimensionVector,
): DimensionalConsistencyCheck {
  const normalizedLeft = normalizeDimensionVector(left);
  const normalizedRight = normalizeDimensionVector(right);
  const leftKey = dimensionVectorKey(normalizedLeft);
  const rightKey = dimensionVectorKey(normalizedRight);
  return Object.freeze({
    operation,
    left: normalizedLeft,
    right: normalizedRight,
    leftKey,
    rightKey,
    compatible: leftKey === rightKey,
  });
}

export type ScientificAssumptionStatus = "active" | "tested" | "rejected" | "superseded";

export interface ScientificAssumption {
  readonly id: string;
  readonly statement: string;
  readonly scope: "local-step" | "model" | "domain";
  readonly status: ScientificAssumptionStatus;
  readonly evidenceIds: readonly LearningEvidenceId[];
}

export type ScientificDerivationStepKind =
  | "definition"
  | "assumption"
  | "algebra"
  | "calculus"
  | "logical-inference"
  | "theorem-application"
  | "approximation"
  | "unit-conversion"
  | "numerical-check";

export type ScientificVerificationState = "unverified" | "verified" | "disputed" | "invalid";

export interface ApproximationBoundary {
  readonly validityConditions: readonly string[];
  readonly errorBound?: string;
  readonly asymptoticOrder?: string;
}

export interface ScientificDerivationStep {
  readonly id: ScientificDerivationStepId;
  readonly sequence: number;
  readonly kind: ScientificDerivationStepKind;
  readonly statement: string;
  readonly expression?: string;
  readonly justification: string;
  readonly dependsOnStepIds: readonly ScientificDerivationStepId[];
  readonly assumptionIds: readonly string[];
  readonly claimIds: readonly ResearchClaimId[];
  readonly evidenceIds: readonly LearningEvidenceId[];
  readonly verificationState: ScientificVerificationState;
  readonly verificationMethod?: string;
  readonly dimensionalCheck?: DimensionalConsistencyCheck;
  readonly approximation?: ApproximationBoundary;
}

export type ScientificDerivationStatus = "draft" | "verified" | "disputed" | "invalid";

export interface ScientificDerivation {
  readonly schemaVersion: 1;
  readonly id: ScientificDerivationId;
  readonly title: string;
  readonly objectiveIds: readonly LearningObjectiveId[];
  readonly assumptions: readonly ScientificAssumption[];
  readonly steps: readonly ScientificDerivationStep[];
  readonly conclusionStepId: ScientificDerivationStepId;
  readonly status: ScientificDerivationStatus;
  readonly contextSnapshotId: ContextSnapshotId;
  readonly createdByRunId: RunId;
  readonly createdAt: IsoTimestamp;
  readonly metadata: JsonObject;
}

export interface CreateScientificDerivationInput extends Omit<ScientificDerivation, "schemaVersion"> {}

function reachableDerivationSteps(
  conclusionStepId: ScientificDerivationStepId,
  byId: ReadonlyMap<ScientificDerivationStepId, ScientificDerivationStep>,
): readonly ScientificDerivationStep[] {
  const visited = new Set<ScientificDerivationStepId>();
  const visit = (stepId: ScientificDerivationStepId): void => {
    if (visited.has(stepId)) return;
    const step = byId.get(stepId);
    assertDomain(step !== undefined, "not_found", "A derivation dependency was not found.", { stepId });
    visited.add(stepId);
    for (const dependencyId of step.dependsOnStepIds) visit(dependencyId);
  };
  visit(conclusionStepId);
  return Object.freeze([...visited].map((stepId) => byId.get(stepId)!));
}

/**
 * Builds an inspectable derivation ledger. A derivation marked verified must
 * have a completely verified dependency path to its conclusion.
 */
export function createScientificDerivation(input: CreateScientificDerivationInput): ScientificDerivation {
  assertIsoTimestamp(input.createdAt, "scientific derivation creation time");
  assertDomain(input.objectiveIds.length > 0, "invalid_argument", "A scientific derivation needs an objective.");
  const objectiveIds = assertUniqueIds(input.objectiveIds, "Scientific derivation objective ID");
  assertDomain(input.steps.length > 0, "invalid_argument", "A scientific derivation requires at least one step.");

  const assumptions = input.assumptions.map((assumption) =>
    Object.freeze({
      ...assumption,
      id: assertNonBlank(assumption.id, "scientific assumption ID", 500),
      statement: assertNonBlank(assumption.statement, "scientific assumption", 8_000),
      evidenceIds: assertUniqueIds(assumption.evidenceIds, "Scientific assumption evidence ID"),
    }),
  );
  assertDomain(
    new Set(assumptions.map((assumption) => assumption.id)).size === assumptions.length,
    "conflict",
    "Scientific assumption ID appears more than once.",
  );
  const assumptionIds = new Set(assumptions.map((assumption) => assumption.id));

  const sortedSteps = stableSort(input.steps, (left, right) => left.sequence - right.sequence);
  assertDomain(
    sortedSteps.every((step, index) => step.sequence === index + 1),
    "invalid_argument",
    "Scientific derivation step sequence must be gap-free and start at one.",
  );
  const byId = new Map<ScientificDerivationStepId, ScientificDerivationStep>();
  for (const step of sortedSteps) {
    assertDomain(!byId.has(step.id), "conflict", "Scientific derivation step ID appears more than once.", {
      stepId: step.id,
    });
    assertNonBlank(step.statement, "scientific derivation statement", 16_000);
    assertNonBlank(step.justification, "scientific derivation justification", 8_000);
    assertUniqueIds(step.dependsOnStepIds, "Scientific derivation dependency ID");
    assertUniqueStrings(step.assumptionIds, "scientific derivation assumption ID");
    assertUniqueIds(step.claimIds, "Scientific derivation claim ID");
    assertUniqueIds(step.evidenceIds, "Scientific derivation evidence ID");
    for (const dependencyId of step.dependsOnStepIds) {
      const dependency = byId.get(dependencyId);
      assertDomain(dependency !== undefined, "not_found", "A derivation step can only depend on an earlier step.", {
        stepId: step.id,
        dependencyId,
      });
    }
    for (const assumptionId of step.assumptionIds) {
      assertDomain(assumptionIds.has(assumptionId), "not_found", "A derivation assumption was not found.", {
        stepId: step.id,
        assumptionId,
      });
    }
    assertDomain(
      step.verificationState !== "verified" || step.verificationMethod !== undefined,
      "invalid_argument",
      "A verified derivation step must record its verification method.",
      { stepId: step.id },
    );
    if (step.verificationMethod !== undefined) {
      assertNonBlank(step.verificationMethod, "scientific verification method", 2_000);
    }
    assertDomain(
      step.verificationState !== "verified" || step.dimensionalCheck?.compatible !== false,
      "invalid_state_transition",
      "A dimensionally inconsistent derivation step cannot be verified.",
      { stepId: step.id },
    );
    if (step.kind === "approximation") {
      assertDomain(step.approximation !== undefined, "invalid_argument", "An approximation needs a validity boundary.", {
        stepId: step.id,
      });
      assertDomain(
        step.approximation.validityConditions.length > 0,
        "invalid_argument",
        "An approximation needs at least one validity condition.",
        { stepId: step.id },
      );
      assertUniqueStrings(step.approximation.validityConditions, "approximation validity condition");
    } else {
      assertDomain(
        step.approximation === undefined,
        "invalid_argument",
        "Approximation metadata is only valid on an approximation step.",
        { stepId: step.id },
      );
    }

    const frozenStep: ScientificDerivationStep = Object.freeze({
      ...step,
      statement: assertNonBlank(step.statement, "scientific derivation statement", 16_000),
      ...(step.expression === undefined
        ? {}
        : { expression: assertNonBlank(step.expression, "scientific expression", 16_000) }),
      justification: assertNonBlank(step.justification, "scientific derivation justification", 8_000),
      dependsOnStepIds: Object.freeze([...step.dependsOnStepIds]),
      assumptionIds: Object.freeze([...step.assumptionIds]),
      claimIds: Object.freeze([...step.claimIds]),
      evidenceIds: Object.freeze([...step.evidenceIds]),
      ...(step.dimensionalCheck === undefined
        ? {}
        : {
            dimensionalCheck: checkDimensionalConsistency(
              step.dimensionalCheck.operation,
              step.dimensionalCheck.left,
              step.dimensionalCheck.right,
            ),
          }),
      ...(step.approximation === undefined
        ? {}
        : {
            approximation: Object.freeze({
              ...step.approximation,
              validityConditions: Object.freeze([...step.approximation.validityConditions]),
            }),
          }),
    });
    byId.set(step.id, frozenStep);
  }

  assertDomain(byId.has(input.conclusionStepId), "not_found", "Scientific derivation conclusion step was not found.");
  const conclusionPath = reachableDerivationSteps(input.conclusionStepId, byId);
  if (input.status === "verified") {
    assertDomain(
      conclusionPath.every((step) => step.verificationState === "verified"),
      "invalid_state_transition",
      "A verified derivation requires every conclusion dependency to be verified.",
    );
  } else if (input.status === "disputed") {
    assertDomain(
      conclusionPath.some((step) => step.verificationState === "disputed"),
      "invalid_state_transition",
      "A disputed derivation must retain a disputed conclusion-path step.",
    );
  } else if (input.status === "invalid") {
    assertDomain(
      conclusionPath.some((step) => step.verificationState === "invalid"),
      "invalid_state_transition",
      "An invalid derivation must retain the invalid conclusion-path step.",
    );
  }

  return Object.freeze({
    schemaVersion: 1,
    id: input.id,
    title: assertNonBlank(input.title, "scientific derivation title", 1_000),
    objectiveIds,
    assumptions: Object.freeze(assumptions),
    steps: Object.freeze([...byId.values()]),
    conclusionStepId: input.conclusionStepId,
    status: input.status,
    contextSnapshotId: input.contextSnapshotId,
    createdByRunId: input.createdByRunId,
    createdAt: input.createdAt,
    metadata: freezeJson(input.metadata),
  });
}

export type ScientificInvestigationMode =
  | "theoretical"
  | "proof"
  | "empirical"
  | "observational"
  | "simulation"
  | "computational"
  | "data-analysis"
  | "engineering-validation";

export type ScientificInvestigationIntent = "exploratory" | "confirmatory" | "replication" | "model-comparison";
export type ScientificInvestigationState = "planned" | "running" | "analyzing" | "completed" | "blocked" | "invalidated";
export type ScientificVariableRole = "independent" | "dependent" | "controlled" | "confounder" | "observed" | "derived";

export interface ScientificVariable {
  readonly id: string;
  readonly name: string;
  readonly role: ScientificVariableRole;
  readonly operationalDefinition: string;
  readonly unit?: string;
  readonly dimension?: DimensionVector;
  readonly measurementMethod?: string;
  readonly uncertaintyModel?: string;
}

export interface ScientificPrediction {
  readonly id: string;
  readonly statement: string;
  readonly conditions: readonly string[];
  readonly outcomeVariableIds: readonly string[];
  readonly expectedDirection: "increase" | "decrease" | "equal" | "different" | "bounded" | "specified-value";
  readonly tolerance?: string;
}

export interface ScientificHypothesis {
  readonly id: ScientificHypothesisId;
  readonly statement: string;
  readonly rationale: string;
  readonly predictions: readonly ScientificPrediction[];
  readonly falsificationCriteria: readonly string[];
  readonly claimIds: readonly ResearchClaimId[];
}

export interface ScientificProtocolStep {
  readonly id: string;
  readonly ordinal: number;
  readonly title: string;
  readonly procedure: string;
  readonly dependsOnStepIds: readonly string[];
  readonly inputVariableIds: readonly string[];
  readonly outputVariableIds: readonly string[];
  readonly safetyNotes: readonly string[];
  /** Names only; this record never grants a capability. */
  readonly requiredCapabilities: readonly string[];
}

export type ScientificRandomnessDeclaration =
  | { readonly kind: "none" }
  | { readonly kind: "seeded"; readonly seed: string; readonly generator: string }
  | { readonly kind: "uncontrolled"; readonly reason: string; readonly impact: string };

export interface ScientificReproducibilityManifest {
  readonly environmentHash: string;
  readonly protocolHash: string;
  readonly parameterHash: string;
  readonly toolVersionHashes: Readonly<Record<string, string>>;
  readonly dataVersionHashes: Readonly<Record<string, string>>;
  readonly sourceVersionHashes: Readonly<Record<string, string>>;
  readonly randomness: ScientificRandomnessDeclaration;
  readonly capturedAt: IsoTimestamp;
}

export interface ScientificInvestigation {
  readonly schemaVersion: 1;
  readonly id: ScientificInvestigationId;
  readonly title: string;
  readonly question: string;
  readonly mode: ScientificInvestigationMode;
  readonly intent: ScientificInvestigationIntent;
  readonly state: ScientificInvestigationState;
  readonly objectiveIds: readonly LearningObjectiveId[];
  readonly hypotheses: readonly ScientificHypothesis[];
  readonly variables: readonly ScientificVariable[];
  readonly protocolSteps: readonly ScientificProtocolStep[];
  readonly controlStrategy?: string;
  readonly derivationIds: readonly ScientificDerivationId[];
  readonly claimIds: readonly ResearchClaimId[];
  readonly evidenceIds: readonly LearningEvidenceId[];
  readonly reproducibility?: ScientificReproducibilityManifest;
  readonly contextSnapshotId: ContextSnapshotId;
  readonly createdByRunId: RunId;
  readonly createdAt: IsoTimestamp;
  readonly metadata: JsonObject;
}

export interface CreateScientificInvestigationInput extends Omit<ScientificInvestigation, "schemaVersion"> {}

const REPRODUCIBLE_MODES = new Set<ScientificInvestigationMode>([
  "empirical",
  "observational",
  "simulation",
  "computational",
  "data-analysis",
  "engineering-validation",
]);

const COMPUTE_MODES = new Set<ScientificInvestigationMode>(["simulation", "computational", "data-analysis"]);

function freezeHashRecord(record: Readonly<Record<string, string>>, label: string): Readonly<Record<string, string>> {
  const entries = Object.entries(record).map(([rawKey, rawHash]) => {
    const key = assertNonBlank(rawKey, `${label} key`, 1_000);
    return [key, assertSha256(rawHash, `${label} for ${key}`)] as const;
  });
  assertDomain(new Set(entries.map(([key]) => key)).size === entries.length, "conflict", `${label} key is duplicated.`);
  return Object.freeze(Object.fromEntries(entries));
}

function freezeReproducibilityManifest(
  manifest: ScientificReproducibilityManifest,
  mode: ScientificInvestigationMode,
): ScientificReproducibilityManifest {
  assertIsoTimestamp(manifest.capturedAt, "reproducibility capture time");
  const toolVersionHashes = freezeHashRecord(manifest.toolVersionHashes, "tool version hash");
  const dataVersionHashes = freezeHashRecord(manifest.dataVersionHashes, "data version hash");
  const sourceVersionHashes = freezeHashRecord(manifest.sourceVersionHashes, "source version hash");
  assertDomain(
    !COMPUTE_MODES.has(mode) || Object.keys(toolVersionHashes).length > 0,
    "invalid_argument",
    "A computational investigation must pin at least one tool or runtime version.",
  );
  if (manifest.randomness.kind === "seeded") {
    assertNonBlank(manifest.randomness.seed, "scientific random seed", 1_000);
    assertNonBlank(manifest.randomness.generator, "scientific random generator", 1_000);
  } else if (manifest.randomness.kind === "uncontrolled") {
    assertNonBlank(manifest.randomness.reason, "uncontrolled randomness reason", 4_000);
    assertNonBlank(manifest.randomness.impact, "uncontrolled randomness impact", 4_000);
    assertDomain(
      !COMPUTE_MODES.has(mode),
      "invalid_argument",
      "Simulation, computation, and data analysis cannot leave randomness uncontrolled.",
      { mode },
    );
  }
  return Object.freeze({
    environmentHash: assertSha256(manifest.environmentHash, "scientific environment hash"),
    protocolHash: assertSha256(manifest.protocolHash, "scientific protocol hash"),
    parameterHash: assertSha256(manifest.parameterHash, "scientific parameter hash"),
    toolVersionHashes,
    dataVersionHashes,
    sourceVersionHashes,
    randomness: Object.freeze({ ...manifest.randomness }),
    capturedAt: manifest.capturedAt,
  });
}

/**
 * Creates a reproducible investigation receipt. It records opaque hashes and
 * source versions, never raw local paths, credentials, or environment secrets.
 */
export function createScientificInvestigation(
  input: CreateScientificInvestigationInput,
): ScientificInvestigation {
  assertIsoTimestamp(input.createdAt, "scientific investigation creation time");
  assertDomain(input.objectiveIds.length > 0, "invalid_argument", "A scientific investigation needs an objective.");
  const objectiveIds = assertUniqueIds(input.objectiveIds, "Scientific investigation objective ID");
  assertUniqueIds(input.derivationIds, "Scientific derivation ID");
  assertUniqueIds(input.claimIds, "Scientific investigation claim ID");
  assertUniqueIds(input.evidenceIds, "Scientific investigation evidence ID");

  assertDomain(
    input.intent === "exploratory" || input.hypotheses.length > 0,
    "invalid_argument",
    "A non-exploratory investigation requires at least one falsifiable hypothesis.",
  );
  const variables = input.variables.map((variable) => {
    const measurementRequired =
      REPRODUCIBLE_MODES.has(input.mode) &&
      (variable.role === "dependent" || variable.role === "observed" || variable.role === "derived");
    assertDomain(
      !measurementRequired || variable.measurementMethod !== undefined,
      "invalid_argument",
      "Every outcome variable needs an operational measurement method.",
      { variableId: variable.id, role: variable.role },
    );
    return Object.freeze({
      ...variable,
      id: assertNonBlank(variable.id, "scientific variable ID", 500),
      name: assertNonBlank(variable.name, "scientific variable name", 1_000),
      operationalDefinition: assertNonBlank(
        variable.operationalDefinition,
        "scientific variable operational definition",
        8_000,
      ),
      ...(variable.unit === undefined ? {} : { unit: assertNonBlank(variable.unit, "scientific unit", 500) }),
      ...(variable.dimension === undefined ? {} : { dimension: normalizeDimensionVector(variable.dimension) }),
      ...(variable.measurementMethod === undefined
        ? {}
        : { measurementMethod: assertNonBlank(variable.measurementMethod, "measurement method", 4_000) }),
      ...(variable.uncertaintyModel === undefined
        ? {}
        : { uncertaintyModel: assertNonBlank(variable.uncertaintyModel, "uncertainty model", 4_000) }),
    });
  });
  const variableById = new Map(variables.map((variable) => [variable.id, variable]));
  assertDomain(variableById.size === variables.length, "conflict", "Scientific variable ID appears more than once.");

  const hypothesisIds = new Set<ScientificHypothesisId>();
  const predictionIds = new Set<string>();
  const hypotheses = input.hypotheses.map((hypothesis) => {
    assertDomain(!hypothesisIds.has(hypothesis.id), "conflict", "Scientific hypothesis ID appears more than once.");
    hypothesisIds.add(hypothesis.id);
    assertDomain(
      hypothesis.predictions.length > 0,
      "invalid_argument",
      "Every scientific hypothesis needs at least one observable prediction.",
      { hypothesisId: hypothesis.id },
    );
    assertDomain(
      hypothesis.falsificationCriteria.length > 0,
      "invalid_argument",
      "Every scientific hypothesis needs an explicit falsification criterion.",
      { hypothesisId: hypothesis.id },
    );
    const predictions = hypothesis.predictions.map((prediction) => {
      const predictionId = assertNonBlank(prediction.id, "scientific prediction ID", 500);
      assertDomain(!predictionIds.has(predictionId), "conflict", "Scientific prediction ID appears more than once.");
      predictionIds.add(predictionId);
      assertDomain(
        prediction.outcomeVariableIds.length > 0,
        "invalid_argument",
        "A scientific prediction needs an observable outcome variable.",
        { predictionId },
      );
      for (const variableId of prediction.outcomeVariableIds) {
        const variable = variableById.get(variableId);
        assertDomain(variable !== undefined, "not_found", "A predicted outcome variable was not found.", {
          predictionId,
          variableId,
        });
        assertDomain(
          variable.role === "dependent" || variable.role === "observed" || variable.role === "derived",
          "invalid_argument",
          "A prediction must target a dependent, observed, or derived variable.",
          { predictionId, variableId, role: variable.role },
        );
      }
      return Object.freeze({
        ...prediction,
        id: predictionId,
        statement: assertNonBlank(prediction.statement, "scientific prediction", 8_000),
        conditions: assertUniqueStrings(prediction.conditions, "scientific prediction condition"),
        outcomeVariableIds: assertUniqueStrings(prediction.outcomeVariableIds, "prediction outcome variable ID"),
        ...(prediction.tolerance === undefined
          ? {}
          : { tolerance: assertNonBlank(prediction.tolerance, "scientific prediction tolerance", 2_000) }),
      });
    });
    return Object.freeze({
      ...hypothesis,
      statement: assertNonBlank(hypothesis.statement, "scientific hypothesis", 8_000),
      rationale: assertNonBlank(hypothesis.rationale, "scientific hypothesis rationale", 8_000),
      predictions: Object.freeze(predictions),
      falsificationCriteria: assertUniqueStrings(
        hypothesis.falsificationCriteria,
        "scientific falsification criterion",
      ),
      claimIds: assertUniqueIds(hypothesis.claimIds, "Scientific hypothesis claim ID"),
    });
  });

  const protocolSteps = stableSort(input.protocolSteps, (left, right) => left.ordinal - right.ordinal);
  if (REPRODUCIBLE_MODES.has(input.mode)) {
    assertDomain(protocolSteps.length > 0, "invalid_argument", "This investigation mode requires a protocol.", {
      mode: input.mode,
    });
    assertDomain(input.reproducibility !== undefined, "invalid_argument", "This investigation mode requires a reproducibility manifest.", {
      mode: input.mode,
    });
  }
  assertDomain(
    protocolSteps.every((step, index) => step.ordinal === index + 1),
    "invalid_argument",
    "Scientific protocol steps must be gap-free and start at one.",
  );
  const protocolById = new Map<string, ScientificProtocolStep>();
  for (const step of protocolSteps) {
    const stepId = assertNonBlank(step.id, "scientific protocol step ID", 500);
    assertDomain(!protocolById.has(stepId), "conflict", "Scientific protocol step ID appears more than once.");
    for (const dependencyId of step.dependsOnStepIds) {
      assertDomain(
        protocolById.has(dependencyId),
        "not_found",
        "A scientific protocol step can only depend on an earlier step.",
        { stepId, dependencyId },
      );
    }
    for (const variableId of [...step.inputVariableIds, ...step.outputVariableIds]) {
      assertDomain(variableById.has(variableId), "not_found", "A protocol variable was not found.", {
        stepId,
        variableId,
      });
    }
    protocolById.set(
      stepId,
      Object.freeze({
        ...step,
        id: stepId,
        title: assertNonBlank(step.title, "scientific protocol step title", 1_000),
        procedure: assertNonBlank(step.procedure, "scientific protocol procedure", 16_000),
        dependsOnStepIds: assertUniqueStrings(step.dependsOnStepIds, "protocol dependency ID"),
        inputVariableIds: assertUniqueStrings(step.inputVariableIds, "protocol input variable ID"),
        outputVariableIds: assertUniqueStrings(step.outputVariableIds, "protocol output variable ID"),
        safetyNotes: assertUniqueStrings(step.safetyNotes, "scientific safety note"),
        requiredCapabilities: assertUniqueStrings(step.requiredCapabilities, "required capability name"),
      }),
    );
  }

  if (input.intent === "confirmatory" && input.mode === "empirical") {
    assertDomain(
      input.controlStrategy !== undefined,
      "invalid_argument",
      "A confirmatory empirical investigation must state its control strategy.",
    );
  }
  const reproducibility =
    input.reproducibility === undefined ? undefined : freezeReproducibilityManifest(input.reproducibility, input.mode);

  return Object.freeze({
    schemaVersion: 1,
    id: input.id,
    title: assertNonBlank(input.title, "scientific investigation title", 1_000),
    question: assertNonBlank(input.question, "scientific investigation question", 8_000),
    mode: input.mode,
    intent: input.intent,
    state: input.state,
    objectiveIds,
    hypotheses: Object.freeze(hypotheses),
    variables: Object.freeze(variables),
    protocolSteps: Object.freeze([...protocolById.values()]),
    ...(input.controlStrategy === undefined
      ? {}
      : { controlStrategy: assertNonBlank(input.controlStrategy, "scientific control strategy", 8_000) }),
    derivationIds: Object.freeze([...input.derivationIds]),
    claimIds: Object.freeze([...input.claimIds]),
    evidenceIds: Object.freeze([...input.evidenceIds]),
    ...(reproducibility === undefined ? {} : { reproducibility }),
    contextSnapshotId: input.contextSnapshotId,
    createdByRunId: input.createdByRunId,
    createdAt: input.createdAt,
    metadata: freezeJson(input.metadata),
  });
}

export type ScientificLearningBlockKind =
  | "objective-map"
  | "prerequisite-recall"
  | "definition"
  | "first-principles-model"
  | "assumptions"
  | "derivation"
  | "proof"
  | "dimensional-check"
  | "worked-example"
  | "visualization"
  | "simulation"
  | "counterexample"
  | "misconception-repair"
  | "recognition-cues"
  | "practice"
  | "hint-ladder"
  | "solution"
  | "transfer-challenge"
  | "evidence-map"
  | "uncertainty"
  | "retrieval-check"
  | "recap"
  | "next-step";

export interface ScientificLearningBlockCandidate {
  readonly id: ScientificLearningBlockId;
  readonly kind: ScientificLearningBlockKind;
  readonly objectiveIds: readonly LearningObjectiveId[];
  readonly dependsOnBlockIds: readonly ScientificLearningBlockId[];
  readonly contentRef: string;
  readonly contentHash: string;
  readonly estimatedMinutes: number;
  readonly estimatedOutputTokens: number;
  readonly priority: number;
  readonly masteryGap: number;
  readonly required: boolean;
  readonly excludedByUser?: boolean;
  readonly requiresVerifiedEvidence: boolean;
  readonly evidenceIds: readonly LearningEvidenceId[];
}

export type ScientificLearningDisclosurePolicy = "attempt-first" | "guided" | "open";
export type ScientificLearningBlockPresentation = "visible" | "collapsed" | "locked-until-attempt";
export type ScientificLearningDecisionReason =
  | "selected-required"
  | "selected-prerequisite"
  | "selected-frontier"
  | "omitted-user"
  | "omitted-evidence"
  | "omitted-dependency"
  | "omitted-time-budget"
  | "omitted-token-budget"
  | "omitted-block-limit";

export interface ScientificLearningBlockDecision {
  readonly candidate: ScientificLearningBlockCandidate;
  readonly selected: boolean;
  readonly reason: ScientificLearningDecisionReason;
  readonly serializedOrder?: number;
  readonly presentation?: ScientificLearningBlockPresentation;
}

export interface ScientificLearningRoute {
  readonly schemaVersion: 1;
  readonly id: ScientificLearningRouteId;
  readonly objectiveIds: readonly LearningObjectiveId[];
  readonly contextSnapshotId: ContextSnapshotId;
  readonly decisions: readonly ScientificLearningBlockDecision[];
  readonly selectedBlockIds: readonly ScientificLearningBlockId[];
  readonly serializedBlockIds: readonly ScientificLearningBlockId[];
  readonly refreshBeforeBlockIds: readonly ScientificLearningBlockId[];
  readonly consumedMinutes: number;
  readonly consumedOutputTokens: number;
  readonly timeBudgetMinutes: number;
  readonly outputTokenBudget: number;
  readonly maximumBlocks: number;
  readonly disclosurePolicy: ScientificLearningDisclosurePolicy;
  readonly compiledAt: IsoTimestamp;
  readonly metadata: JsonObject;
}

export interface CompileScientificLearningRouteInput {
  readonly id: ScientificLearningRouteId;
  readonly objectiveIds: readonly LearningObjectiveId[];
  readonly contextSnapshotId: ContextSnapshotId;
  readonly candidates: readonly ScientificLearningBlockCandidate[];
  readonly timeBudgetMinutes: number;
  readonly outputTokenBudget: number;
  readonly maximumBlocks: number;
  readonly disclosurePolicy: ScientificLearningDisclosurePolicy;
  readonly attentionRefreshInterval?: number;
  readonly now: IsoTimestamp;
  readonly metadata?: JsonObject;
}

const BLOCK_KIND_ORDER: Readonly<Record<ScientificLearningBlockKind, number>> = Object.freeze({
  "objective-map": 0,
  "prerequisite-recall": 1,
  definition: 2,
  "first-principles-model": 3,
  assumptions: 4,
  derivation: 5,
  proof: 6,
  "dimensional-check": 7,
  "worked-example": 8,
  visualization: 9,
  simulation: 10,
  counterexample: 11,
  "misconception-repair": 12,
  "recognition-cues": 13,
  practice: 14,
  "hint-ladder": 15,
  solution: 16,
  "transfer-challenge": 17,
  "evidence-map": 18,
  uncertainty: 19,
  "retrieval-check": 20,
  recap: 21,
  "next-step": 22,
});

function candidateUtility(candidate: ScientificLearningBlockCandidate): number {
  const cost = Math.max(candidate.estimatedMinutes + candidate.estimatedOutputTokens / 500, 0.1);
  const repairBonus = candidate.kind === "misconception-repair" ? 1 : 0;
  const transferBonus = candidate.kind === "transfer-challenge" || candidate.kind === "retrieval-check" ? 0.5 : 0;
  return (candidate.priority * 2 + candidate.masteryGap * 2 + repairBonus + transferBonus) / cost;
}

function topologicallyOrderLearningBlocks(
  candidates: readonly ScientificLearningBlockCandidate[],
  includedIds: ReadonlySet<ScientificLearningBlockId>,
): readonly ScientificLearningBlockCandidate[] {
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const indegree = new Map<ScientificLearningBlockId, number>();
  const children = new Map<ScientificLearningBlockId, ScientificLearningBlockId[]>();
  for (const candidate of candidates) {
    if (!includedIds.has(candidate.id)) continue;
    const dependencies = candidate.dependsOnBlockIds.filter((dependencyId) => includedIds.has(dependencyId));
    indegree.set(candidate.id, dependencies.length);
    for (const dependencyId of dependencies) {
      const bucket = children.get(dependencyId) ?? [];
      bucket.push(candidate.id);
      children.set(dependencyId, bucket);
    }
  }
  const ready = candidates.filter((candidate) => includedIds.has(candidate.id) && indegree.get(candidate.id) === 0);
  const compare = (left: ScientificLearningBlockCandidate, right: ScientificLearningBlockCandidate): number =>
    (left.required === right.required ? 0 : left.required ? -1 : 1) ||
    candidateUtility(right) - candidateUtility(left) ||
    BLOCK_KIND_ORDER[left.kind] - BLOCK_KIND_ORDER[right.kind] ||
    left.id.localeCompare(right.id);
  const ordered: ScientificLearningBlockCandidate[] = [];
  while (ready.length > 0) {
    ready.sort(compare);
    const next = ready.shift();
    assertDomain(next !== undefined, "invalid_state_transition", "Learning block queue is empty.");
    ordered.push(next);
    for (const childId of children.get(next.id) ?? []) {
      const remaining = (indegree.get(childId) ?? 0) - 1;
      indegree.set(childId, remaining);
      if (remaining === 0) {
        const child = byId.get(childId);
        assertDomain(child !== undefined, "not_found", "Scientific learning block was not found.");
        ready.push(child);
      }
    }
  }
  assertDomain(
    ordered.length === includedIds.size,
    "invalid_argument",
    "Scientific learning block dependencies contain a cycle.",
  );
  return Object.freeze(ordered);
}

function presentationFor(
  candidate: ScientificLearningBlockCandidate,
  policy: ScientificLearningDisclosurePolicy,
): ScientificLearningBlockPresentation {
  if (candidate.kind !== "hint-ladder" && candidate.kind !== "solution") return "visible";
  if (policy === "attempt-first") return "locked-until-attempt";
  if (policy === "guided") return "collapsed";
  return "visible";
}

/**
 * Compiles a bounded, prerequisite-aware lesson route. Every candidate receives
 * an explicit selection or omission reason, so long answers cannot silently
 * drop a proof, counterexample, source check, or practice block.
 */
export function compileScientificLearningRoute(
  input: CompileScientificLearningRouteInput,
): ScientificLearningRoute {
  assertIsoTimestamp(input.now, "scientific learning route compilation time");
  assertDomain(input.objectiveIds.length > 0, "invalid_argument", "A learning route needs an objective.");
  const objectiveIds = assertUniqueIds(input.objectiveIds, "Scientific learning route objective ID");
  const objectiveScope = new Set(objectiveIds);
  assertDomain(
    Number.isSafeInteger(input.timeBudgetMinutes) && input.timeBudgetMinutes >= 0,
    "invalid_argument",
    "Scientific learning time budget must be a non-negative integer.",
  );
  assertDomain(
    Number.isSafeInteger(input.outputTokenBudget) && input.outputTokenBudget >= 0,
    "invalid_argument",
    "Scientific learning output budget must be a non-negative integer.",
  );
  assertDomain(
    Number.isSafeInteger(input.maximumBlocks) && input.maximumBlocks >= 0,
    "invalid_argument",
    "Scientific learning block limit must be a non-negative integer.",
  );
  const attentionRefreshInterval = input.attentionRefreshInterval ?? 5;
  assertDomain(
    Number.isSafeInteger(attentionRefreshInterval) && attentionRefreshInterval > 0,
    "invalid_argument",
    "Attention refresh interval must be a positive integer.",
  );

  const byId = new Map<ScientificLearningBlockId, ScientificLearningBlockCandidate>();
  const frozenCandidates = input.candidates.map((candidate) => {
    assertDomain(!byId.has(candidate.id), "conflict", "Scientific learning block ID appears more than once.");
    assertDomain(candidate.objectiveIds.length > 0, "invalid_argument", "A learning block needs an objective.", {
      blockId: candidate.id,
    });
    for (const objectiveId of candidate.objectiveIds) {
      assertDomain(objectiveScope.has(objectiveId), "scope_violation", "A learning block is outside route scope.", {
        blockId: candidate.id,
        objectiveId,
      });
    }
    assertUniqueIds(candidate.objectiveIds, "Scientific learning block objective ID");
    assertUniqueIds(candidate.dependsOnBlockIds, "Scientific learning block dependency ID");
    assertUniqueIds(candidate.evidenceIds, "Scientific learning block evidence ID");
    assertSha256(candidate.contentHash, "scientific learning block content hash");
    assertDomain(
      Number.isSafeInteger(candidate.estimatedMinutes) && candidate.estimatedMinutes >= 0,
      "invalid_argument",
      "Learning block duration must be a non-negative integer.",
      { blockId: candidate.id },
    );
    assertDomain(
      Number.isSafeInteger(candidate.estimatedOutputTokens) && candidate.estimatedOutputTokens >= 0,
      "invalid_argument",
      "Learning block output estimate must be a non-negative integer.",
      { blockId: candidate.id },
    );
    assertUnitInterval(candidate.priority, "scientific learning block priority");
    assertUnitInterval(candidate.masteryGap, "scientific learning mastery gap");
    const frozen: ScientificLearningBlockCandidate = Object.freeze({
      ...candidate,
      objectiveIds: Object.freeze([...candidate.objectiveIds]),
      dependsOnBlockIds: Object.freeze([...candidate.dependsOnBlockIds]),
      contentRef: assertNonBlank(candidate.contentRef, "scientific learning block content reference", 2_000),
      contentHash: assertSha256(candidate.contentHash, "scientific learning block content hash"),
      evidenceIds: Object.freeze([...candidate.evidenceIds]),
    });
    byId.set(candidate.id, frozen);
    return frozen;
  });

  for (const candidate of frozenCandidates) {
    for (const dependencyId of candidate.dependsOnBlockIds) {
      assertDomain(byId.has(dependencyId), "not_found", "A scientific learning dependency was not found.", {
        blockId: candidate.id,
        dependencyId,
      });
      assertDomain(dependencyId !== candidate.id, "invalid_argument", "A learning block cannot depend on itself.", {
        blockId: candidate.id,
      });
    }
    if (candidate.kind === "hint-ladder" || candidate.kind === "solution") {
      assertDomain(
        candidate.dependsOnBlockIds.some((dependencyId) => {
          const dependency = byId.get(dependencyId);
          return dependency?.kind === "practice" || dependency?.kind === "transfer-challenge";
        }),
        "invalid_argument",
        "A hint or solution must be attached to a practice or transfer block.",
        { blockId: candidate.id, kind: candidate.kind },
      );
    }
  }
  const allIds = new Set(frozenCandidates.map((candidate) => candidate.id));
  topologicallyOrderLearningBlocks(frozenCandidates, allIds);

  const requiredClosure = new Set<ScientificLearningBlockId>();
  const addRequired = (blockId: ScientificLearningBlockId): void => {
    if (requiredClosure.has(blockId)) return;
    const candidate = byId.get(blockId);
    assertDomain(candidate !== undefined, "not_found", "Required scientific learning block was not found.");
    requiredClosure.add(blockId);
    for (const dependencyId of candidate.dependsOnBlockIds) addRequired(dependencyId);
  };
  for (const candidate of frozenCandidates) if (candidate.required) addRequired(candidate.id);

  for (const blockId of requiredClosure) {
    const candidate = byId.get(blockId)!;
    assertDomain(!candidate.excludedByUser, "permission_denied", "A required learning block is explicitly excluded.", {
      blockId,
    });
    assertDomain(
      !candidate.requiresVerifiedEvidence || candidate.evidenceIds.length > 0,
      "invalid_state_transition",
      "A required evidence-dependent learning block has no verified evidence reference.",
      { blockId },
    );
  }
  const requiredOrder = topologicallyOrderLearningBlocks(frozenCandidates, requiredClosure);
  const requiredMinutes = requiredOrder.reduce((sum, candidate) => sum + candidate.estimatedMinutes, 0);
  const requiredTokens = requiredOrder.reduce((sum, candidate) => sum + candidate.estimatedOutputTokens, 0);
  assertDomain(
    requiredMinutes <= input.timeBudgetMinutes &&
      requiredTokens <= input.outputTokenBudget &&
      requiredOrder.length <= input.maximumBlocks,
    "context_overflow",
    "Required learning blocks do not fit the declared route budget.",
    {
      requiredMinutes,
      requiredTokens,
      requiredBlocks: requiredOrder.length,
      timeBudgetMinutes: input.timeBudgetMinutes,
      outputTokenBudget: input.outputTokenBudget,
      maximumBlocks: input.maximumBlocks,
    },
  );

  const fullOrder = topologicallyOrderLearningBlocks(frozenCandidates, allIds);
  const selected = new Set(requiredClosure);
  let consumedMinutes = requiredMinutes;
  let consumedOutputTokens = requiredTokens;
  for (const candidate of fullOrder) {
    if (selected.has(candidate.id) || candidate.excludedByUser) continue;
    if (candidate.requiresVerifiedEvidence && candidate.evidenceIds.length === 0) continue;
    if (candidate.dependsOnBlockIds.some((dependencyId) => !selected.has(dependencyId))) continue;
    if (selected.size >= input.maximumBlocks) continue;
    if (consumedMinutes + candidate.estimatedMinutes > input.timeBudgetMinutes) continue;
    if (consumedOutputTokens + candidate.estimatedOutputTokens > input.outputTokenBudget) continue;
    selected.add(candidate.id);
    consumedMinutes += candidate.estimatedMinutes;
    consumedOutputTokens += candidate.estimatedOutputTokens;
  }

  const serialized = topologicallyOrderLearningBlocks(frozenCandidates, selected);
  const serializedIndex = new Map(serialized.map((candidate, index) => [candidate.id, index]));
  const decisions = frozenCandidates.map((candidate): ScientificLearningBlockDecision => {
    const order = serializedIndex.get(candidate.id);
    if (order !== undefined) {
      const reason: ScientificLearningDecisionReason = candidate.required
        ? "selected-required"
        : requiredClosure.has(candidate.id)
          ? "selected-prerequisite"
          : "selected-frontier";
      return Object.freeze({
        candidate,
        selected: true,
        reason,
        serializedOrder: order,
        presentation: presentationFor(candidate, input.disclosurePolicy),
      });
    }
    let reason: ScientificLearningDecisionReason;
    if (candidate.excludedByUser) reason = "omitted-user";
    else if (candidate.requiresVerifiedEvidence && candidate.evidenceIds.length === 0) reason = "omitted-evidence";
    else if (candidate.dependsOnBlockIds.some((dependencyId) => !selected.has(dependencyId))) reason = "omitted-dependency";
    else if (selected.size >= input.maximumBlocks) reason = "omitted-block-limit";
    else if (consumedMinutes + candidate.estimatedMinutes > input.timeBudgetMinutes) reason = "omitted-time-budget";
    else reason = "omitted-token-budget";
    return Object.freeze({ candidate, selected: false, reason });
  });
  const refreshBeforeBlockIds = serialized
    .filter((_, index) => index > 0 && index % attentionRefreshInterval === 0)
    .map((candidate) => candidate.id);

  return Object.freeze({
    schemaVersion: 1,
    id: input.id,
    objectiveIds,
    contextSnapshotId: input.contextSnapshotId,
    decisions: Object.freeze(decisions),
    selectedBlockIds: Object.freeze(serialized.map((candidate) => candidate.id)),
    serializedBlockIds: Object.freeze(serialized.map((candidate) => candidate.id)),
    refreshBeforeBlockIds: Object.freeze(refreshBeforeBlockIds),
    consumedMinutes,
    consumedOutputTokens,
    timeBudgetMinutes: input.timeBudgetMinutes,
    outputTokenBudget: input.outputTokenBudget,
    maximumBlocks: input.maximumBlocks,
    disclosurePolicy: input.disclosurePolicy,
    compiledAt: input.now,
    metadata: freezeJson(input.metadata ?? {}),
  });
}
