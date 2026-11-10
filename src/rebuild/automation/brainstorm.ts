import { AutomationDomainError, clone, evidenceList, expectedRevision, identifier, json, list, nonNegativeInteger, object, readReplay, text, uniqueIds, utf8Bytes, verifyReplay } from "./common";

export type BrainstormAction = "fix" | "add" | "optimize" | "remove" | "no_action";
export interface BrainstormDecision { action: BrainstormAction; summary: string; evidence: string[]; }
export interface BrainstormPass { id: string; decisions: BrainstormDecision[]; }
export type BrainstormStatus = "active" | "stopped" | "cancelled";
export interface BrainstormSnapshot { schemaVersion: 1; goalId: string; maxPasses: number; revision: number; status: BrainstormStatus; stopReason: "disabled" | "pass_limit" | "no_new_decision" | "cancelled" | null; cancellationReason: string | null; passes: BrainstormPass[]; }
type BrainstormCommand = { type: "pass"; pass: BrainstormPass; expectedRevision: number } | { type: "cancel"; reason: string; expectedRevision: number };

function parsePass(input: unknown): BrainstormPass {
  const pass = object(input, ["id", "decisions"], "brainstorm pass");
  const decisions = list(pass.decisions, "pass decisions", 32, (entry): BrainstormDecision => {
    const decision = object(entry, ["action", "summary", "evidence"], "brainstorm decision");
    if (!["fix", "add", "optimize", "remove", "no_action"].includes(decision.action as string)) throw new AutomationDomainError("invalid_input", "Unknown brainstorm action");
    return { action: decision.action as BrainstormAction, summary: text(decision.summary, "decision summary", 8_192, true), evidence: evidenceList(decision.evidence) };
  }, 1);
  if (decisions.some((decision) => decision.action === "no_action") && decisions.length !== 1) throw new AutomationDomainError("invalid_input", "no_action must be the only decision");
  uniqueIds(decisions.map(fingerprint), "decision");
  const result = { id: identifier(pass.id, "pass id"), decisions };
  if (utf8Bytes(json(result)) > 262_144) throw new AutomationDomainError("capacity", "Brainstorm pass exceeds 262144 UTF-8 bytes");
  return result;
}

function fingerprint(decision: BrainstormDecision): string { return json([decision.action, decision.summary.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ")]); }

export class BrainstormSession {
  readonly goalId: string;
  readonly maxPasses: number;
  private revision = 0;
  private status: BrainstormStatus;
  private stopReason: BrainstormSnapshot["stopReason"];
  private cancellationReason: string | null = null;
  private readonly passes: BrainstormPass[] = [];
  private readonly events: BrainstormCommand[] = [];

  constructor(goalId: string, maxPasses = 3) {
    this.goalId = identifier(goalId, "goal id");
    if (!Number.isSafeInteger(maxPasses) || maxPasses < 0 || maxPasses > 10) throw new AutomationDomainError("invalid_input", "maxPasses must be an integer from 0 through 10");
    this.maxPasses = maxPasses;
    this.status = maxPasses === 0 ? "stopped" : "active";
    this.stopReason = maxPasses === 0 ? "disabled" : null;
  }

  private active(expected: number): void { expectedRevision(this.revision, expected); if (this.status !== "active") throw new AutomationDomainError("terminal", "Brainstorm session is terminal"); }

  recordPass(input: BrainstormPass, expected: number): BrainstormSnapshot {
    this.active(expected);
    const pass = parsePass(input);
    if (this.passes.some((entry) => entry.id === pass.id)) throw new AutomationDomainError("duplicate_id", "Duplicate brainstorm pass id");
    const previous = new Set(this.passes.flatMap((entry) => entry.decisions.map(fingerprint)));
    const hasNewDecision = pass.decisions.some((decision) => decision.action !== "no_action" && !previous.has(fingerprint(decision)));
    this.events.push({ type: "pass", pass: clone(pass), expectedRevision: expected }); this.revision += 1;
    this.passes.push(pass);
    if (!hasNewDecision) { this.status = "stopped"; this.stopReason = "no_new_decision"; }
    else if (this.passes.length === this.maxPasses) { this.status = "stopped"; this.stopReason = "pass_limit"; }
    return this.snapshot();
  }

  cancel(inputReason: string, expected: number): BrainstormSnapshot {
    this.active(expected);
    const reason = text(inputReason, "cancellation reason", 4_096, true);
    this.events.push({ type: "cancel", reason, expectedRevision: expected }); this.revision += 1;
    this.status = "cancelled"; this.stopReason = "cancelled"; this.cancellationReason = reason;
    return this.snapshot();
  }

  snapshot(): BrainstormSnapshot { return clone({ schemaVersion: 1, goalId: this.goalId, maxPasses: this.maxPasses, revision: this.revision, status: this.status, stopReason: this.stopReason, cancellationReason: this.cancellationReason, passes: this.passes }); }
  serialize(): string { return json({ schemaVersion: 1, kind: "brainstorm", initial: { goalId: this.goalId, maxPasses: this.maxPasses }, events: this.events, state: this.snapshot() }); }

  static restore(serialized: string): BrainstormSession {
    const saved = readReplay(serialized, "brainstorm");
    const initial = object(saved.initial, ["goalId", "maxPasses"], "brainstorm initial state");
    const session = new BrainstormSession(identifier(initial.goalId, "goal id"), nonNegativeInteger(initial.maxPasses, "maxPasses"));
    for (const entry of saved.events) {
      const event = object(entry, ["type", "pass", "reason", "expectedRevision"], "brainstorm command");
      const expected = nonNegativeInteger(event.expectedRevision, "expectedRevision");
      if (event.type === "pass") { object(event, ["type", "pass", "expectedRevision"], "pass command"); session.recordPass(parsePass(event.pass), expected); }
      else if (event.type === "cancel") { object(event, ["type", "reason", "expectedRevision"], "cancel command"); session.cancel(text(event.reason, "reason", 4_096, true), expected); }
      else throw new AutomationDomainError("invalid_replay", "Unknown brainstorm command");
    }
    verifyReplay(session.snapshot(), saved.state);
    return session;
  }
}
