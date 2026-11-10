import { createResearchExecutionPlan, type ResearchExecutionPlan, type ResearchExecutionPolicy } from "../domain/upstream-research-adapter";
import { createWorkflowPlan, type WorkflowPlan } from "./workflow-contract";

/** A reviewable atomic workflow for the real gateway adapter; no search runs while planning. */
export function createGroundedResearchWorkflow(input: {
  readonly prompt: string;
  readonly now: string;
  readonly planIterations?: number;
  readonly policy?: Partial<ResearchExecutionPolicy>;
  readonly additionalQueries?: readonly string[];
}): { readonly execution: ResearchExecutionPlan; readonly workflow: WorkflowPlan } {
  const execution = createResearchExecutionPlan(input);
  const workflow = createWorkflowPlan(input.prompt, [
    { id: `${execution.id}:search`, title: "Search independent query intents", ownerRole: "researcher", dependsOn: [], criteria: [
      { id: "query-receipts", label: `Retain a terminal receipt for all ${execution.queries.length} planned queries`, minimum: `${execution.queries.length}/${execution.queries.length} query receipts`, verified: false },
      { id: "external-authority", label: "Use the approved external-read gateway", minimum: "adapter ID and authority receipt retained", verified: false },
    ] },
    { id: `${execution.id}:capture`, title: "Capture source text with publication and retrieval times", ownerRole: "researcher", dependsOn: [`${execution.id}:search`], criteria: [
      { id: "source-receipts", label: "Record every selected and omitted source disposition", minimum: "content hash, truncation, omission and gateway receipts", verified: false },
      { id: "context-budget", label: "Respect the source and total context budgets", minimum: `≤${execution.policy.maxSources} captures; ≤${execution.policy.maxTotalCharacters} retained characters`, verified: false },
    ] },
    { id: `${execution.id}:ground`, title: "Bind answer claims to exact retained source spans", ownerRole: "verifier", dependsOn: [`${execution.id}:capture`], criteria: [
      { id: "span-verification", label: "Validate every cited quote against its source hash and span", minimum: "100% of cited spans match retained text", verified: false },
      { id: "unverified-claims", label: "Report ungrounded claims explicitly", minimum: "span-verified/total claims and remaining uncertainties", verified: false },
    ] },
    { id: `${execution.id}:report`, title: "Report evidence, disagreements and research coverage", ownerRole: "reviewer", dependsOn: [`${execution.id}:ground`], criteria: [
      { id: "bounded-report", label: "Report actual external execution and citation coverage", minimum: "query/source receipts, dates, budgets, captured/omitted counts", verified: false },
      { id: "truth-boundary", label: "Keep span grounding distinct from semantic verification", minimum: "no hostname or confidence heuristic counted as truth verification", verified: false },
    ] },
  ], input.planIterations ?? 3, Date.parse(input.now));
  return Object.freeze({ execution, workflow });
}
