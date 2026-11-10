import type { PreparedProviderInputReceipt } from "@/lib/desktop";

export interface PreparedRunScope {
  attemptId: string;
  runId: string;
  providerProfileId: string;
  model: string;
}

export interface OpaquePreparedAttemptDispatch {
  attemptId: string;
  frozenProviderInputId: string;
}

/**
 * Converts a native preparation receipt into the complete renderer dispatch
 * payload. Keep this contract intentionally tiny: provider input, parameters,
 * destinations, credentials, and conversation history stay native-owned.
 */
export function opaquePreparedAttemptDispatch(
  receipt: PreparedProviderInputReceipt,
  expected: PreparedRunScope,
): OpaquePreparedAttemptDispatch {
  if (
    receipt.attemptId !== expected.attemptId ||
    receipt.runId !== expected.runId ||
    receipt.providerProfileId !== expected.providerProfileId ||
    receipt.model !== expected.model
  ) {
    throw new Error("Native run preparation returned a receipt outside the requested run scope.");
  }

  return {
    attemptId: expected.attemptId,
    frozenProviderInputId: receipt.id,
  };
}
