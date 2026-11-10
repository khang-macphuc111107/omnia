import { describe, expect, it } from "vitest";

import type { PreparedProviderInputReceipt } from "@/lib/desktop";

import { opaquePreparedAttemptDispatch } from "./prepared-run-dispatch";

const receipt: PreparedProviderInputReceipt = {
  id: "provider_input_0123456789abcdef0123456789abcdef",
  attemptId: "attempt_0123456789abcdef0123456789abcdef",
  runId: "run_0123456789abcdef0123456789abcdef",
  providerProfileId: "provider_0123456789abcdef0123456789abcdef",
  model: "model-1",
  contentSha256: "a".repeat(64),
  messageCount: 3,
  createdAtMs: 1_786_582_800_000,
};

const expectedScope = {
  attemptId: receipt.attemptId,
  runId: receipt.runId,
  providerProfileId: receipt.providerProfileId,
  model: receipt.model,
};

describe("prepared provider input dispatch boundary", () => {
  it("returns only the opaque attempt and frozen-input identifiers", () => {
    const dispatch = opaquePreparedAttemptDispatch(receipt, expectedScope);

    expect(dispatch).toEqual({
      attemptId: receipt.attemptId,
      frozenProviderInputId: receipt.id,
    });
    expect(Object.keys(dispatch).sort()).toEqual(["attemptId", "frozenProviderInputId"]);
    expect(JSON.stringify(dispatch)).not.toContain(receipt.model);
    expect(JSON.stringify(dispatch)).not.toContain(receipt.providerProfileId);
    expect(JSON.stringify(dispatch)).not.toContain(receipt.contentSha256);
  });

  it.each([
    ["attempt", { attemptId: "attempt_ffffffffffffffffffffffffffffffff" }],
    ["run", { runId: "run_ffffffffffffffffffffffffffffffff" }],
    ["provider profile", { providerProfileId: "provider_ffffffffffffffffffffffffffffffff" }],
    ["model", { model: "model-2" }],
  ])("fails closed when the native receipt has the wrong %s scope", (_label, patch) => {
    expect(() => opaquePreparedAttemptDispatch({ ...receipt, ...patch }, expectedScope)).toThrow(
      "outside the requested run scope",
    );
  });
});
