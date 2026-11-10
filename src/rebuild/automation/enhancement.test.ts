import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { PromptEnhancement } from "./enhancement";

const context = [{ id: "file-1", label: "app.ts", content: "export const answer = 42;" }, { id: "note", label: "Note", content: "Prefer a small change." }];

describe("explicit prompt enhancement", () => {
  it("preserves original and selected context and requires explicit acceptance", async () => {
    const enhancement = new PromptEnhancement("  Keep this exact text  ", context);
    const proposal = await enhancement.propose({ id: "p1", proposedPrompt: "Keep this exact text and add tests", selectedContextIds: ["file-1"], rationale: "Adds verification" }, 0);
    expect(proposal.originalPrompt).toBe("  Keep this exact text  ");
    expect(proposal.selectedContextIds).toEqual(["file-1"]);
    expect(proposal.originalHash).toBe(createHash("sha256").update("  Keep this exact text  ").digest("hex"));
    expect(proposal.contextHash).toBe(createHash("sha256").update(JSON.stringify([context[0]])).digest("hex"));
    expect(enhancement.snapshot().status).toBe("pending");
    const accepted = enhancement.decide({ action: "accept" }, 1);
    expect(accepted).toMatchObject({ status: "accepted", dispatchRequested: false, prompt: "Keep this exact text and add tests" });
  });

  it("supports edit/reject/cancel and never auto-dispatches", async () => {
    const edited = new PromptEnhancement("Original", []);
    await edited.propose({ id: "p1", proposedPrompt: "Suggested", selectedContextIds: [], rationale: "Improve clarity" }, 0);
    expect(edited.decide({ action: "edit", editedPrompt: "User version" }, 1)).toMatchObject({ status: "edited", prompt: "User version", dispatchRequested: false });
    expect(edited.snapshot().decision?.dispatchRequested).toBe(false);
  });

  it("records edit, rejection and cancellation with revision guards", async () => {
    const edit = new PromptEnhancement("Original", []);
    await edit.propose({ id: "p1", proposedPrompt: "Suggested", selectedContextIds: [], rationale: "Improve clarity" }, 0);
    expect(edit.decide({ action: "edit", editedPrompt: "User version" }, 1)).toMatchObject({ status: "edited", prompt: "User version", dispatchRequested: false });
    const reject = new PromptEnhancement("Original", []);
    await reject.propose({ id: "p1", proposedPrompt: "Suggested", selectedContextIds: [], rationale: "Improve clarity" }, 0);
    expect(reject.decide({ action: "reject" }, 1)).toMatchObject({ status: "rejected", dispatchRequested: false });
    const cancel = new PromptEnhancement("Original", []);
    await cancel.propose({ id: "p1", proposedPrompt: "Suggested", selectedContextIds: [], rationale: "Improve clarity" }, 0);
    expect(cancel.cancel("user stopped", 1)).toMatchObject({ status: "cancelled", dispatchRequested: false });
    expect(() => cancel.decide({ action: "accept" }, 2)).toThrow(/terminal/);
  });

  it("rejects unknown context, empty edits, duplicate proposals and forged reload", async () => {
    const enhancement = new PromptEnhancement("Original", context);
    await expect(enhancement.propose({ id: "p1", proposedPrompt: "Suggested", selectedContextIds: ["missing"], rationale: "Reason" }, 0)).rejects.toThrow(/context/);
    await enhancement.propose({ id: "p1", proposedPrompt: "Suggested", selectedContextIds: ["note"], rationale: "Reason" }, 0);
    await expect(enhancement.propose({ id: "p1", proposedPrompt: "Changed", selectedContextIds: [], rationale: "Reason" }, 1)).rejects.toThrow(/duplicate/);
    expect(() => enhancement.decide({ action: "edit", editedPrompt: "" }, 1)).toThrow(/prompt/);
    const corrupt = JSON.parse(enhancement.serialize()); corrupt.state.revision = 99;
    await expect(PromptEnhancement.restore(JSON.stringify(corrupt))).rejects.toThrow(/invalid_replay/);
  });

  it("supports large original prompts, reload decisions and rejects forged prompt hashes", async () => {
    const enhancement = new PromptEnhancement("a".repeat(128 * 1024), context);
    await enhancement.propose({ id: "p", proposedPrompt: "a".repeat(128 * 1024), selectedContextIds: ["note"], rationale: "Preserved content" }, 0);
    enhancement.decide({ action: "reject" }, 1);
    expect((await PromptEnhancement.restore(enhancement.serialize())).snapshot()).toEqual(enhancement.snapshot());
    const corrupt = JSON.parse(enhancement.serialize()); corrupt.state.proposal.originalHash = "0".repeat(64);
    await expect(PromptEnhancement.restore(JSON.stringify(corrupt))).rejects.toThrow(/hash|snapshot|replay/);
    expect(() => new PromptEnhancement("a".repeat(256 * 1024 + 1), [])).toThrow(/prompt/);
  });

  it("cancels before a proposal hash resolves and rejects competing proposal writes", async () => {
    const enhancement = new PromptEnhancement("Original", context);
    const pending = enhancement.propose({ id: "p1", proposedPrompt: "Suggested", selectedContextIds: [], rationale: "Reason" }, 0);
    enhancement.cancel("Stopped", 0);
    await expect(pending).rejects.toThrow(/terminal|stale/);
    expect(enhancement.snapshot()).toMatchObject({ status: "cancelled", proposal: null });
    const race = new PromptEnhancement("Original", []);
    const results = await Promise.allSettled([
      race.propose({ id: "p1", proposedPrompt: "First", selectedContextIds: [], rationale: "Reason" }, 0),
      race.propose({ id: "p2", proposedPrompt: "Second", selectedContextIds: [], rationale: "Reason" }, 0),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it("rejects blank intent, contradictory decisions and stale acceptance", async () => {
    expect(() => new PromptEnhancement(" \n\t ", [])).toThrow(/prompt/);
    const enhancement = new PromptEnhancement("Original", context);
    await enhancement.propose({ id: "p1", proposedPrompt: "Suggested", selectedContextIds: [], rationale: "Reason" }, 0);
    expect(() => enhancement.decide({ action: "accept" }, 0)).toThrow(/stale/);
    expect(() => enhancement.decide({ action: "accept", editedPrompt: "Unreviewed" } as never, 1)).toThrow(/unknown/);
    enhancement.contexts[0]!.content = "Mutated";
    expect(enhancement.snapshot().contexts[0]?.content).toBe(context[0]?.content);
    expect(enhancement.decide({ action: "accept" }, 1).dispatchRequested).toBe(false);
  });
});
