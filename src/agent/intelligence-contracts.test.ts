import { describe, expect, it } from "vitest";

import { DEFAULT_RUNTIME_SETTINGS, createRuntimeSettingsController, normalizeRuntimeSettings } from "./runtime-settings";
import { resolveModelRoute } from "./model-routing";
import { createWorkflowPlan, transitionTask, verifyCriterion, workflowCoverage, workflowMarkdown } from "./workflow-contract";
import { summarizeMetrics } from "./observability";
import { exportSessionJson, exportSessionMarkdown, normalizePortableSession } from "./session-portability";
import { contentFingerprint, reconcileProjectPointers } from "./project-file-pointers";

describe("runtime settings", () => {
  it("normalizes untrusted values to bounded defaults", () => {
    const settings = normalizeRuntimeSettings({ contextWindowTokens: -5, toolOutputLimitChars: 999999999, planIterations: 99, browser: { domDepth: 99 } });
    expect(settings.contextWindowTokens).toBe(8_192);
    expect(settings.toolOutputLimitChars).toBe(200_000);
    expect(settings.planIterations).toBe(10);
    expect(settings.browser.domDepth).toBe(12);
  });
  it("hot reloads subscribers", () => {
    const controller = createRuntimeSettingsController();
    const observed: number[] = [];
    const stop = controller.subscribe((next) => observed.push(next.planIterations));
    controller.update({ planIterations: 5 });
    stop();
    controller.update({ planIterations: 6 });
    expect(observed).toEqual([5]);
    expect(controller.get().contextWindowTokens).toBe(DEFAULT_RUNTIME_SETTINGS.contextWindowTokens);
  });
});

describe("model routing", () => {
  it("downgrades ultra to the highest supported effort and marks dynamic workflow", () => {
    const result = resolveModelRoute({ effort: "ultra", candidates: [{ model: "local", provider: "ollama", supportedEfforts: ["low", "high"] }] });
    expect(result.resolvedEffort).toBe("high");
    expect(result.dynamicWorkflow).toBe(true);
    expect(result.downgraded).toBe(true);
  });
});

describe("workflow contracts", () => {
  it("tracks quantified criterion coverage and exports markdown", () => {
    const plan = createWorkflowPlan("Ship slice", [{ id: "task-1", title: "Build", dependsOn: [], criteria: [{ id: "c1", label: "Build passes", minimum: "typecheck", verified: false }] }], 3, 100);
    const verified = verifyCriterion(transitionTask(plan, "task-1", "done", 101), "task-1", "c1", "npm run typecheck", 102);
    expect(workflowCoverage(verified)).toMatchObject({ tasksDone: 1, criteriaVerified: 1, percent: 100 });
    expect(workflowMarkdown(verified)).toContain("[x] Build passes");
  });
});

describe("observability", () => {
  it("aggregates token, throughput, and cost metrics", () => {
    const summary = summarizeMetrics([{ id: "r", sessionId: "s", startedAtMs: 0, finishedAtMs: 1000, inputTokens: 100, outputTokens: 50, estimatedCostUsd: 0.01, status: "completed" }], 2000);
    expect(summary).toMatchObject({ runs: 1, completed: 1, inputTokens: 100, outputTokens: 50, estimatedCostUsd: 0.01 });
    expect(summary.tokensPerSecond).toBeGreaterThan(0);
  });
});

describe("portable sessions and pointer storage", () => {
  it("redacts secrets and exports both portable formats", () => {
    const session = normalizePortableSession({ id: "s", title: "Demo", messages: [{ role: "user", content: "api_key=secret-value" }] });
    expect(session.messages[0]?.content).toContain("[redacted]");
    expect(exportSessionJson(session)).toContain('"schemaVersion": 1');
    expect(exportSessionMarkdown(session)).toContain("# Demo");
  });
  it("keeps a latest snapshot after a source is deleted", () => {
    const first = reconcileProjectPointers("p", [], [{ path: "src/a.ts", content: "one" }], 1);
    const second = reconcileProjectPointers("p", first, [], 2);
    expect(second[0]).toMatchObject({ sourceExists: false, content: "one", contentSha256: contentFingerprint("one") });
  });
});
