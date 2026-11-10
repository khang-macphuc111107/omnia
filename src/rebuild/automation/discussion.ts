import { AutomationDomainError, clone, expectedRevision, identifier, journalCapacity, json, list, nonNegativeInteger, object, readReplay, stableJson, text, uniqueIds, utf8Bytes, verifyReplay } from "./common";

export interface DiscussionParticipant { agentId: string; goalId: string; role: string; allowedRecipientIds: string[]; }
export interface DiscussionMessageInput { id: string; senderId: string; recipientId: string; goalId: string; role: string; body: string; idempotencyKey: string; }
export interface DiscussionMessage extends DiscussionMessageInput { sequence: number; revision: number; }
export interface DiscussionOptions { maxBytes?: number; maxMessages?: number; }
export interface DiscussionSnapshot { schemaVersion: 1; goalId: string; revision: number; closed: boolean; cancellationReason: string | null; maxBytes: number; maxMessages: number; participants: DiscussionParticipant[]; messages: DiscussionMessage[]; }
type DiscussionCommand = { type: "send"; message: DiscussionMessageInput; callerAgentId: string; expectedRevision: number } | { type: "cancel"; reason: string; expectedRevision: number };

function parseParticipant(input: unknown): DiscussionParticipant {
  const value = object(input, ["agentId", "goalId", "role", "allowedRecipientIds"], "participant");
  const allowedRecipientIds = list(value.allowedRecipientIds, "recipient grants", 128, (entry) => identifier(entry, "recipient id"));
  uniqueIds(allowedRecipientIds, "recipient");
  return { agentId: identifier(value.agentId, "participant id"), goalId: identifier(value.goalId, "participant goal id"), role: identifier(value.role, "participant role", 128), allowedRecipientIds };
}

function parseMessage(input: unknown): DiscussionMessageInput {
  const value = object(input, ["id", "senderId", "recipientId", "goalId", "role", "body", "idempotencyKey"], "discussion message");
  return { id: identifier(value.id, "message id"), senderId: identifier(value.senderId, "sender id"), recipientId: identifier(value.recipientId, "recipient id"), goalId: identifier(value.goalId, "message goal id"), role: identifier(value.role, "message role", 128), body: text(value.body, "message body", 65_536, true), idempotencyKey: identifier(value.idempotencyKey, "idempotency key") };
}

/** The host supplies a trusted roster and caller identity; this ledger is not an authentication transport. */
export class DiscussionChannel {
  readonly goalId: string;
  readonly maxBytes: number;
  readonly maxMessages: number;
  private revision = 0;
  private closed = false;
  private cancellationReason: string | null = null;
  private readonly participants: DiscussionParticipant[];
  private readonly messages: DiscussionMessage[] = [];
  private readonly events: DiscussionCommand[] = [];
  private journalBytes: number;

  constructor(goalId: string, roster: readonly DiscussionParticipant[], options: DiscussionOptions = {}) {
    this.goalId = identifier(goalId, "goal id");
    const config = object(options, ["maxBytes", "maxMessages"], "discussion options");
    this.maxBytes = config.maxBytes === undefined ? 16_384 : nonNegativeInteger(config.maxBytes, "maxBytes");
    this.maxMessages = config.maxMessages === undefined ? 256 : nonNegativeInteger(config.maxMessages, "maxMessages");
    if (this.maxBytes < 1 || this.maxBytes > 65_536 || this.maxMessages < 1 || this.maxMessages > 1_024) throw new AutomationDomainError("invalid_input", "Discussion limits must be 1 through 65536 bytes and 1 through 1024 messages");
    this.participants = list(roster, "participant roster", 128, parseParticipant, 1);
    uniqueIds(this.participants.map((participant) => participant.agentId), "participant");
    this.journalBytes = journalCapacity(0, this.participants);
  }

  private active(expected: number): void { expectedRevision(this.revision, expected); if (this.closed) throw new AutomationDomainError("terminal", "Discussion channel is terminal"); }
  private participant(id: string): DiscussionParticipant {
    const participant = this.participants.find((entry) => entry.agentId === identifier(id, "agent id"));
    if (!participant || participant.goalId !== this.goalId) throw new AutomationDomainError("scope_denied", "Participant is outside this goal");
    return participant;
  }

  send(input: DiscussionMessageInput, expected: number, callerAgentId: string): DiscussionMessage {
    if (this.closed) throw new AutomationDomainError("terminal", "Discussion channel is terminal");
    nonNegativeInteger(expected, "expectedRevision");
    const message = parseMessage(input);
    const caller = this.participant(callerAgentId);
    if (caller.agentId !== message.senderId || message.goalId !== this.goalId) throw new AutomationDomainError("scope_denied", "Caller may only send as itself within its goal");
    const recipient = this.participant(message.recipientId);
    if (caller.agentId === recipient.agentId) throw new AutomationDomainError("scope_denied", "A self message is not permitted");
    if (message.role !== caller.role) throw new AutomationDomainError("scope_denied", "Message role does not match caller role");
    if (!caller.allowedRecipientIds.includes(recipient.agentId)) throw new AutomationDomainError("scope_denied", "Caller has no recipient grant");
    if (utf8Bytes(message.body) > this.maxBytes) throw new AutomationDomainError("size_limit", "Message exceeds the UTF-8 size limit");
    const duplicate = this.messages.find((entry) => entry.id === message.id || (entry.senderId === message.senderId && entry.idempotencyKey === message.idempotencyKey));
    if (duplicate) {
      const { sequence: _sequence, revision: _revision, ...original } = duplicate;
      if (stableJson(original) !== stableJson(message)) throw new AutomationDomainError("duplicate_id", "duplicate message id or idempotency key conflicts with prior content");
      if (expected > this.revision) throw new AutomationDomainError("stale_revision", "Idempotent message has a future expected revision");
      return clone(duplicate);
    }
    this.active(expected);
    if (this.messages.length >= this.maxMessages) throw new AutomationDomainError("capacity", "Discussion message capacity reached");
    const command: DiscussionCommand = { type: "send", message: clone(message), callerAgentId: caller.agentId, expectedRevision: expected };
    this.journalBytes = journalCapacity(this.journalBytes, command);
    this.events.push(command); this.revision += 1;
    const delivered = { ...message, sequence: this.messages.length + 1, revision: this.revision };
    this.messages.push(delivered);
    return clone(delivered);
  }

  messagesForAgent(callerAgentId: string): DiscussionMessage[] {
    const caller = this.participant(callerAgentId);
    return clone(this.messages.filter((message) => message.senderId === caller.agentId || message.recipientId === caller.agentId));
  }

  cancel(inputReason: string, expected: number): DiscussionSnapshot {
    this.active(expected);
    const reason = text(inputReason, "cancellation reason", 4_096, true);
    const command: DiscussionCommand = { type: "cancel", reason, expectedRevision: expected };
    this.journalBytes = journalCapacity(this.journalBytes, command);
    this.events.push(command); this.revision += 1;
    this.closed = true; this.cancellationReason = reason;
    return this.snapshot();
  }

  snapshot(): DiscussionSnapshot { return clone({ schemaVersion: 1, goalId: this.goalId, revision: this.revision, closed: this.closed, cancellationReason: this.cancellationReason, maxBytes: this.maxBytes, maxMessages: this.maxMessages, participants: this.participants, messages: this.messages }); }
  serialize(): string { return json({ schemaVersion: 1, kind: "discussion", initial: { goalId: this.goalId, participants: this.participants, options: { maxBytes: this.maxBytes, maxMessages: this.maxMessages } }, events: this.events, state: this.snapshot() }); }

  static restore(serialized: string): DiscussionChannel {
    const saved = readReplay(serialized, "discussion");
    const initial = object(saved.initial, ["goalId", "participants", "options"], "discussion initial state");
    const channel = new DiscussionChannel(identifier(initial.goalId, "goal id"), list(initial.participants, "participants", 128, parseParticipant, 1), initial.options as DiscussionOptions);
    for (const entry of saved.events) {
      const event = object(entry, ["type", "message", "callerAgentId", "reason", "expectedRevision"], "discussion command");
      const expected = nonNegativeInteger(event.expectedRevision, "expectedRevision");
      if (event.type === "send") { object(event, ["type", "message", "callerAgentId", "expectedRevision"], "send command"); channel.send(parseMessage(event.message), expected, identifier(event.callerAgentId, "caller id")); }
      else if (event.type === "cancel") { object(event, ["type", "reason", "expectedRevision"], "cancel command"); channel.cancel(text(event.reason, "reason", 4_096, true), expected); }
      else throw new AutomationDomainError("invalid_replay", "Unknown discussion command");
    }
    verifyReplay(channel.snapshot(), saved.state);
    return channel;
  }
}
