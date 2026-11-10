import { describe, expect, it } from "vitest";

import {
  assessNativeCompareReplay,
  desktop,
  requireNativeCompareReconciliation,
  type NativeCompareExecutePreparedResult,
} from "./desktop";

function result(
  statuses: Array<"completed" | "failed" | "cancelled" | "unknown">,
): NativeCompareExecutePreparedResult {
  return {
    schemaVersion: 1,
    compareId: "compare_preview",
    logicalInputSha256: "a".repeat(64),
    attempts: statuses.map((status, index) => ({
      attemptId: `compare_preview:route-${index}`,
      routeId: `route-${index}`,
      preparedAttemptId: `attempt_${index}`,
      providerId: `provider-${index}`,
      adapterId: "fixture",
      modelId: `model-${index}`,
      status,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    })),
    completedAtMs: 1,
  };
}

describe("native compare replay policy", () => {
  it("never labels a terminal compare as an automatic replay", () => {
    const assessment = assessNativeCompareReplay(result(["completed", "failed", "cancelled"]));

    expect(assessment.disposition).toBe("no_automatic_replay");
    expect(assessment.automaticRetryAllowed).toBe(false);
    expect(assessment.completedAttemptIds).toEqual(["compare_preview:route-0"]);
    expect(assessment.definitiveFailureAttemptIds).toEqual(["compare_preview:route-1"]);
    expect(assessment.cancelledAttemptIds).toEqual(["compare_preview:route-2"]);
    expect(requireNativeCompareReconciliation(result(["completed"]))).toMatchObject({
      automaticRetryAllowed: false,
      disposition: "no_automatic_replay",
    });
  });

  it("requires reconciliation when a provider was accepted but terminal outcome is unknown", () => {
    const projection = result(["unknown", "completed"]);
    const assessment = assessNativeCompareReplay(projection);

    expect(assessment.disposition).toBe("reconciliation_required");
    expect(assessment.unknownAttemptIds).toEqual(["compare_preview:route-0"]);
    expect(assessment.reason).toMatch(/terminal outcome is unknown/i);
    expect(() => requireNativeCompareReconciliation(projection)).toThrow(
      /terminal outcome is unknown/i,
    );
    try {
      requireNativeCompareReconciliation(projection);
    } catch (error) {
      expect(error).toMatchObject({
        name: "NativeCompareOutcomeUnknown",
        code: "compare_outcome_unknown",
        retryable: false,
        acceptance: "unknown",
      });
    }
  });

  it("keeps browser preview from pretending that native compare is available", async () => {
    await expect(
      desktop.executeNativeComparePrepared({ compareId: "compare_preview", routes: [] }),
    ).rejects.toThrow("requires the Tauri desktop runtime");
  });
});

