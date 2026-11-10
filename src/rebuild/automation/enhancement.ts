import { AutomationDomainError, clone, expectedRevision, identifier, json, list, nonNegativeInteger, object, rawText, readReplay, sha256, text, uniqueIds, utf8Bytes, verifyReplay } from "./common";

export interface PromptContext { id: string; label: string; content: string; }
export interface EnhancementProposalInput { id: string; proposedPrompt: string; selectedContextIds: string[]; rationale: string; }
export interface EnhancementProposal extends EnhancementProposalInput { originalPrompt: string; originalHash: string; proposedHash: string; contextHash: string; revision: number; }
export type EnhancementStatus = "idle" | "pending" | "accepted" | "edited" | "rejected" | "cancelled";
export type EnhancementDecisionInput = { action: "accept" | "reject" } | { action: "edit"; editedPrompt: string };
export interface EnhancementDecision { status: Exclude<EnhancementStatus, "idle" | "pending">; prompt: string | null; dispatchRequested: false; revision: number; proposalId: string | null; }
export interface EnhancementSnapshot { schemaVersion: 1; revision: number; status: EnhancementStatus; originalPrompt: string; contexts: PromptContext[]; proposal: EnhancementProposal | null; decision: EnhancementDecision | null; cancellationReason: string | null; }
type EnhancementCommand = { type: "propose"; proposal: EnhancementProposalInput; expectedRevision: number } | { type: "decide"; decision: EnhancementDecisionInput; expectedRevision: number } | { type: "cancel"; reason: string; expectedRevision: number };

function parseContext(input: unknown): PromptContext {
  const value = object(input, ["id", "label", "content"], "prompt context");
  return { id: identifier(value.id, "context id"), label: text(value.label, "context label", 1_024), content: rawText(value.content, "context content", 65_536, true) };
}

function parseProposal(input: unknown): EnhancementProposalInput {
  const value = object(input, ["id", "proposedPrompt", "selectedContextIds", "rationale"], "enhancement proposal");
  const selectedContextIds = list(value.selectedContextIds, "selected context", 32, (entry) => identifier(entry, "selected context id"));
  uniqueIds(selectedContextIds, "selected context");
  return { id: identifier(value.id, "proposal id"), proposedPrompt: rawText(value.proposedPrompt, "proposed prompt"), selectedContextIds, rationale: text(value.rationale, "proposal rationale", 8_192, true) };
}

function parseDecision(input: unknown): EnhancementDecisionInput {
  const value = object(input, ["action", "editedPrompt"], "enhancement decision");
  if (value.action === "edit") return { action: "edit", editedPrompt: rawText(value.editedPrompt, "edited prompt") };
  object(input, ["action"], "enhancement decision");
  if (value.action !== "accept" && value.action !== "reject") throw new AutomationDomainError("invalid_input", "Unknown enhancement decision");
  return { action: value.action };
}

/** Local review state only. Accepting or editing returns text and never dispatches it. */
export class PromptEnhancement {
  readonly originalPrompt: string;
  private readonly contextEntries: PromptContext[];
  private revision = 0;
  private status: EnhancementStatus = "idle";
  private proposal: EnhancementProposal | null = null;
  private decision: EnhancementDecision | null = null;
  private cancellationReason: string | null = null;
  private readonly events: EnhancementCommand[] = [];

  constructor(originalPrompt: string, contexts: readonly PromptContext[]) {
    this.originalPrompt = rawText(originalPrompt, "original prompt");
    this.contextEntries = list(contexts, "context entries", 32, parseContext);
    uniqueIds(this.contextEntries.map((entry) => entry.id), "context");
    if (this.contextEntries.reduce((size, entry) => size + utf8Bytes(entry.content), 0) > 524_288) throw new AutomationDomainError("capacity", "Prompt context exceeds 524288 UTF-8 bytes");
  }

  get contexts(): PromptContext[] { return clone(this.contextEntries); }
  private expected(expected: number): void { expectedRevision(this.revision, expected); }

  async propose(input: EnhancementProposalInput, expected: number): Promise<EnhancementProposal> {
    this.expected(expected);
    if (this.status !== "idle") throw new AutomationDomainError(this.status === "pending" ? "duplicate_id" : "terminal", "Enhancement already has a proposal or is terminal");
    const proposal = parseProposal(input);
    const selected = proposal.selectedContextIds.map((contextId) => {
      const context = this.contextEntries.find((entry) => entry.id === contextId);
      if (!context) throw new AutomationDomainError("scope_denied", "Proposal references unknown context");
      return context;
    });
    const [originalHash, proposedHash, contextHash] = await Promise.all([
      sha256(this.originalPrompt), sha256(proposal.proposedPrompt), sha256(json(selected)),
    ]);
    this.expected(expected);
    if (this.status !== "idle") throw new AutomationDomainError("terminal", "Enhancement is no longer idle");
    this.events.push({ type: "propose", proposal: clone(proposal), expectedRevision: expected }); this.revision += 1;
    this.proposal = { ...proposal, originalPrompt: this.originalPrompt, originalHash, proposedHash, contextHash, revision: this.revision };
    this.status = "pending";
    return clone(this.proposal);
  }

  decide(input: EnhancementDecisionInput, expected: number): EnhancementDecision {
    this.expected(expected);
    if (this.status !== "pending" || this.proposal === null) throw new AutomationDomainError("terminal", "Enhancement is not pending");
    const decision = parseDecision(input);
    this.events.push({ type: "decide", decision: clone(decision), expectedRevision: expected }); this.revision += 1;
    const status = decision.action === "accept" ? "accepted" : decision.action === "edit" ? "edited" : "rejected";
    const prompt = decision.action === "accept" ? this.proposal.proposedPrompt : decision.action === "edit" ? decision.editedPrompt : null;
    this.decision = { status, prompt, dispatchRequested: false, revision: this.revision, proposalId: this.proposal.id };
    this.status = status;
    return clone(this.decision);
  }

  cancel(inputReason: string, expected: number): EnhancementDecision {
    this.expected(expected);
    if (this.status !== "idle" && this.status !== "pending") throw new AutomationDomainError("terminal", "Enhancement is terminal");
    const reason = text(inputReason, "cancellation reason", 4_096, true);
    this.events.push({ type: "cancel", reason, expectedRevision: expected }); this.revision += 1;
    this.status = "cancelled"; this.cancellationReason = reason;
    this.decision = { status: "cancelled", prompt: null, dispatchRequested: false, revision: this.revision, proposalId: this.proposal?.id ?? null };
    return clone(this.decision);
  }

  snapshot(): EnhancementSnapshot { return clone({ schemaVersion: 1, revision: this.revision, status: this.status, originalPrompt: this.originalPrompt, contexts: this.contextEntries, proposal: this.proposal, decision: this.decision, cancellationReason: this.cancellationReason }); }
  serialize(): string { return json({ schemaVersion: 1, kind: "enhancement", initial: { originalPrompt: this.originalPrompt, contexts: this.contextEntries }, events: this.events, state: this.snapshot() }); }

  static async restore(serialized: string): Promise<PromptEnhancement> {
    const saved = readReplay(serialized, "enhancement");
    const initial = object(saved.initial, ["originalPrompt", "contexts"], "enhancement initial state");
    const enhancement = new PromptEnhancement(rawText(initial.originalPrompt, "original prompt"), list(initial.contexts, "contexts", 32, parseContext));
    for (const entry of saved.events) {
      const event = object(entry, ["type", "proposal", "decision", "reason", "expectedRevision"], "enhancement command");
      const expected = nonNegativeInteger(event.expectedRevision, "expectedRevision");
      if (event.type === "propose") { object(event, ["type", "proposal", "expectedRevision"], "proposal command"); await enhancement.propose(parseProposal(event.proposal), expected); }
      else if (event.type === "decide") { object(event, ["type", "decision", "expectedRevision"], "decision command"); enhancement.decide(parseDecision(event.decision), expected); }
      else if (event.type === "cancel") { object(event, ["type", "reason", "expectedRevision"], "cancel command"); enhancement.cancel(text(event.reason, "reason", 4_096, true), expected); }
      else throw new AutomationDomainError("invalid_replay", "Unknown enhancement command");
    }
    verifyReplay(enhancement.snapshot(), saved.state);
    return enhancement;
  }
}
