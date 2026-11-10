import { describe, expect, it } from "vitest";
import { DiscussionChannel } from "./discussion";

const participants = [
  { agentId: "a", goalId: "g", role: "planner", allowedRecipientIds: ["b"] },
  { agentId: "b", goalId: "g", role: "reviewer", allowedRecipientIds: ["a"] },
  { agentId: "other", goalId: "other-goal", role: "reviewer", allowedRecipientIds: ["a"] },
];
const message = (patch: Record<string, unknown> = {}) => ({ id: "m1", senderId: "a", recipientId: "b", goalId: "g", role: "planner", body: "Please review", idempotencyKey: "k1", ...patch });

describe("goal scoped agent discussion", () => {
  it("delivers a sibling message with sender, recipient, role and goal evidence", () => {
    const channel = new DiscussionChannel("g", participants);
    const delivered = channel.send(message(), 0, "a");
    expect(delivered).toMatchObject({ id: "m1", senderId: "a", recipientId: "b", goalId: "g", role: "planner", sequence: 1 });
    expect(channel.snapshot().messages).toHaveLength(1);
  });

  it("denies cross-goal, spoofed-role, ungranted-recipient and self messages", () => {
    const channel = new DiscussionChannel("g", participants);
    expect(() => channel.send(message({ goalId: "other-goal" }), 0, "a")).toThrow(/goal/);
    expect(() => channel.send(message({ role: "reviewer" }), 0, "a")).toThrow(/role/);
    expect(() => channel.send(message({ recipientId: "other" }), 0, "a")).toThrow(/scope_denied/);
    expect(() => channel.send(message({ recipientId: "a" }), 0, "a")).toThrow(/self/);
  });

  it("keeps duplicate idempotent messages stable and rejects conflicting replays", () => {
    const channel = new DiscussionChannel("g", participants);
    const first = channel.send(message(), 0, "a");
    expect(channel.send(message(), 1, "a")).toEqual(first);
    expect(channel.send(message(), 0, "a")).toEqual(first);
    expect(() => channel.send(message({ body: "changed" }), 1, "a")).toThrow(/duplicate/);
    expect(channel.snapshot().revision).toBe(1);
  });

  it("rejects oversize messages and stale concurrent writes, then preserves cancel state on reload", () => {
    const channel = new DiscussionChannel("g", participants, { maxBytes: 32 });
    expect(() => channel.send(message({ body: "a".repeat(100) }), 0, "a")).toThrow(/size/);
    expect(() => channel.send(message(), 1, "a")).toThrow(/stale/);
    channel.cancel("goal stopped", 0);
    expect(() => channel.send(message({ id: "late" }), 1, "a")).toThrow(/terminal/);
    expect(DiscussionChannel.restore(channel.serialize()).snapshot()).toEqual(channel.snapshot());
  });

  it("bounds UTF-8 bytes, checks idempotency keys across IDs and preserves custom limits", () => {
    const channel = new DiscussionChannel("g", participants, { maxBytes: 32 });
    expect(() => channel.send(message({ body: "😀".repeat(9) }), 0, "a")).toThrow(/size/);
    channel.send(message(), 0, "a");
    expect(() => channel.send(message({ id: "m2", body: "Changed" }), 1, "a")).toThrow(/duplicate/);
    const restored = DiscussionChannel.restore(channel.serialize());
    expect(() => restored.send(message({ id: "m3", idempotencyKey: "new", body: "a".repeat(33) }), 1, "a")).toThrow(/size/);
  });

  it("rejects message spoofing against caller context and corrupt message reload", () => {
    const channel = new DiscussionChannel("g", participants);
    expect(() => channel.send(message(), 0, "b")).toThrow(/scope_denied/);
    channel.send(message(), 0, "a");
    const corrupt = JSON.parse(channel.serialize()); corrupt.state.messages[0].recipientId = "other";
    expect(() => DiscussionChannel.restore(JSON.stringify(corrupt))).toThrow(/replay|snapshot|scope/);
    channel.snapshot().participants[0]!.allowedRecipientIds.push("other");
    expect(channel.snapshot().participants[0]?.allowedRecipientIds).toEqual(["b"]);
    expect(channel.messagesForAgent("a")).toHaveLength(1);
    expect(() => channel.messagesForAgent("other")).toThrow(/scope_denied/);
  });

  it("denies same-goal recipients without a grant and bounds the message count", () => {
    const roster = [...participants, { agentId: "c", goalId: "g", role: "builder", allowedRecipientIds: [] }];
    const channel = new DiscussionChannel("g", roster, { maxMessages: 1 });
    expect(() => channel.send(message({ recipientId: "c" }), 0, "a")).toThrow(/scope_denied/);
    channel.send(message(), 0, "a");
    expect(() => channel.send(message({ id: "m2", idempotencyKey: "k2" }), 1, "a")).toThrow(/capacity/);
    expect(channel.messagesForAgent("c")).toEqual([]);
    for (const maxBytes of [0, -1, 65_537, 1.5]) expect(() => new DiscussionChannel("g", roster, { maxBytes })).toThrow();
  });
});
