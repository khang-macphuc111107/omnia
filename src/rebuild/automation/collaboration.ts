import { AutomationDomainError, clone, expectedRevision, identifier, json, list, nonNegativeInteger, object, rawText, readReplay, sha256, text, uniqueIds, utf8Bytes, verifyReplay } from "./common";

export type AttemptStatus = "succeeded" | "failed" | "cancelled";
export interface AttemptInput { id: string; taskId?: string; model: string; prompt: string; status: AttemptStatus; output: string; error?: string; }
export interface AttemptRecord extends Omit<AttemptInput, "taskId"> { taskId: string; inputHash: string; outputHash: string; hashAlgorithm: "sha256"; revision: number; }
export interface SynthesisInput { id: string; selectedAttemptIds: string[]; output: string; rationale: string; }
export interface SynthesisAttemptLineage { attemptId: string; model: string; inputHash: string; outputHash: string; }
export interface SynthesisRecord extends SynthesisInput { taskId: string; selectedAttempts: SynthesisAttemptLineage[]; inputHash: string; outputHash: string; hashAlgorithm: "sha256"; revision: number; }
export interface CollaborationSnapshot { schemaVersion: 1; taskId: string; revision: number; status: "active" | "cancelled"; cancellationReason: string | null; attempts: AttemptRecord[]; syntheses: SynthesisRecord[]; }
type CollaborationCommand = { type: "attempt"; attempt: AttemptInput; expectedRevision: number } | { type: "synthesis"; synthesis: SynthesisInput; expectedRevision: number } | { type: "cancel"; reason: string; expectedRevision: number };

function parseAttempt(input: unknown, taskId: string): AttemptInput & { taskId: string } {
  const value = object(input, ["id", "taskId", "model", "prompt", "status", "output", "error"], "attempt");
  if (!["succeeded", "failed", "cancelled"].includes(value.status as string)) throw new AutomationDomainError("invalid_input", "Unknown attempt status");
  const scope = value.taskId === undefined ? taskId : identifier(value.taskId, "attempt task id");
  if (scope !== taskId) throw new AutomationDomainError("scope_denied", "Attempt belongs to a different task");
  const error = value.error === undefined ? undefined : text(value.error, "attempt error", 4_096, true);
  if ((value.status === "failed" && error === undefined) || (value.status === "succeeded" && error !== undefined)) throw new AutomationDomainError("invalid_input", "Only failed or cancelled attempts can contain errors; failed attempts need one");
  return { id: identifier(value.id, "attempt id"), taskId, model: text(value.model, "model identity", 512), prompt: rawText(value.prompt, "attempt prompt", 65_536), status: value.status as AttemptStatus, output: rawText(value.output, "attempt output", 262_144, value.status !== "succeeded"), ...(error === undefined ? {} : { error }) };
}

function parseSynthesis(input: unknown): SynthesisInput {
  const value = object(input, ["id", "selectedAttemptIds", "output", "rationale"], "synthesis");
  const selectedAttemptIds = list(value.selectedAttemptIds, "selected attempts", 64, (id) => identifier(id, "selected attempt id"), 1);
  uniqueIds(selectedAttemptIds, "selected attempt");
  return { id: identifier(value.id, "synthesis id"), selectedAttemptIds, output: rawText(value.output, "synthesis output", 262_144), rationale: text(value.rationale, "synthesis rationale", 8_192, true) };
}

/** Records observed attempts and a separate synthesis; it never calls a provider. */
export class CollaborationRun {
  readonly taskId: string;
  private revision = 0;
  private status: "active" | "cancelled" = "active";
  private cancellationReason: string | null = null;
  private readonly attempts: AttemptRecord[] = [];
  private readonly syntheses: SynthesisRecord[] = [];
  private readonly events: CollaborationCommand[] = [];

  constructor(taskId: string) { this.taskId = identifier(taskId, "task id"); }
  private active(expected: number): void { expectedRevision(this.revision, expected); if (this.status !== "active") throw new AutomationDomainError("terminal", "Collaboration run is terminal"); }
  private availableId(id: string): void { if ([...this.attempts, ...this.syntheses].some((entry) => entry.id === id)) throw new AutomationDomainError("duplicate_id", `duplicate attempt or synthesis id ${id}`); }
  private capacity(extraBytes: number): void {
    const used = this.attempts.reduce((size, entry) => size + utf8Bytes(entry.prompt) + utf8Bytes(entry.output), 0) + this.syntheses.reduce((size, entry) => size + utf8Bytes(entry.output), 0);
    if (used + extraBytes > 4 * 1024 * 1024) throw new AutomationDomainError("capacity", "Collaboration text capacity reached");
  }

  async recordAttempt(input: AttemptInput, expected: number): Promise<AttemptRecord> {
    this.active(expected);
    const attempt = parseAttempt(input, this.taskId);
    this.availableId(attempt.id);
    if (this.attempts.length >= 64) throw new AutomationDomainError("capacity", "Attempt count capacity reached");
    this.capacity(utf8Bytes(attempt.prompt) + utf8Bytes(attempt.output));
    const [inputHash, outputHash] = await Promise.all([
      sha256(json({ taskId: this.taskId, model: attempt.model, prompt: attempt.prompt })),
      sha256(attempt.output),
    ]);
    this.active(expected);
    this.events.push({ type: "attempt", attempt: clone(attempt), expectedRevision: expected }); this.revision += 1;
    const result: AttemptRecord = { ...attempt, inputHash, outputHash, hashAlgorithm: "sha256", revision: this.revision };
    this.attempts.push(result);
    return clone(result);
  }

  async synthesize(input: SynthesisInput, expected: number): Promise<SynthesisRecord> {
    this.active(expected);
    const synthesis = parseSynthesis(input);
    this.availableId(synthesis.id);
    if (this.syntheses.length >= 16) throw new AutomationDomainError("capacity", "Synthesis count capacity reached");
    this.capacity(utf8Bytes(synthesis.output));
    const selectedAttempts = synthesis.selectedAttemptIds.map((attemptId): SynthesisAttemptLineage => {
      const attempt = this.attempts.find((entry) => entry.id === attemptId);
      if (!attempt) throw new AutomationDomainError("unknown_attempt", "Synthesis references an unknown attempt");
      if (attempt.status !== "succeeded") throw new AutomationDomainError("invalid_input", "Synthesis can select only succeeded attempts");
      return { attemptId: attempt.id, model: attempt.model, inputHash: attempt.inputHash, outputHash: attempt.outputHash };
    });
    const [inputHash, outputHash] = await Promise.all([
      sha256(json({ taskId: this.taskId, selectedAttempts })),
      sha256(synthesis.output),
    ]);
    this.active(expected);
    this.events.push({ type: "synthesis", synthesis: clone(synthesis), expectedRevision: expected }); this.revision += 1;
    const result: SynthesisRecord = { ...synthesis, taskId: this.taskId, selectedAttempts, inputHash, outputHash, hashAlgorithm: "sha256", revision: this.revision };
    this.syntheses.push(result);
    return clone(result);
  }

  cancel(inputReason: string, expected: number): CollaborationSnapshot {
    this.active(expected);
    const reason = text(inputReason, "cancellation reason", 4_096, true);
    this.events.push({ type: "cancel", reason, expectedRevision: expected }); this.revision += 1;
    this.status = "cancelled"; this.cancellationReason = reason;
    return this.snapshot();
  }

  snapshot(): CollaborationSnapshot { return clone({ schemaVersion: 1, taskId: this.taskId, revision: this.revision, status: this.status, cancellationReason: this.cancellationReason, attempts: this.attempts, syntheses: this.syntheses }); }
  serialize(): string { return json({ schemaVersion: 1, kind: "collaboration", initial: { taskId: this.taskId }, events: this.events, state: this.snapshot() }); }

  static async restore(serialized: string): Promise<CollaborationRun> {
    const saved = readReplay(serialized, "collaboration");
    const initial = object(saved.initial, ["taskId"], "collaboration initial state");
    const run = new CollaborationRun(identifier(initial.taskId, "task id"));
    for (const entry of saved.events) {
      const event = object(entry, ["type", "attempt", "synthesis", "reason", "expectedRevision"], "collaboration command");
      const expected = nonNegativeInteger(event.expectedRevision, "expectedRevision");
      if (event.type === "attempt") { object(event, ["type", "attempt", "expectedRevision"], "attempt command"); await run.recordAttempt(parseAttempt(event.attempt, run.taskId), expected); }
      else if (event.type === "synthesis") { object(event, ["type", "synthesis", "expectedRevision"], "synthesis command"); await run.synthesize(parseSynthesis(event.synthesis), expected); }
      else if (event.type === "cancel") { object(event, ["type", "reason", "expectedRevision"], "cancel command"); run.cancel(text(event.reason, "reason", 4_096, true), expected); }
      else throw new AutomationDomainError("invalid_replay", "Unknown collaboration command");
    }
    verifyReplay(run.snapshot(), saved.state);
    return run;
  }
}
