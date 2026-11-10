import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { buildProjectContextAvailability } from "./project-context-availability-contract";
import {
  buildProjectRuntimePosture,
  ProjectRuntimePosture,
  type ProjectRuntimePostureTarget,
} from "./project-runtime-posture";

const contextAvailability = buildProjectContextAvailability({
  health: "ready",
  folders: [],
});

const telemetrySnapshot = {
  schemaVersion: 1 as const,
  runId: "run-runtime-posture",
  readAtMs: 100,
  attempts: [
    {
      attemptId: "attempt-1",
      ordinal: 1,
      providerProfileId: "provider-preview",
      modelId: "preview-model",
      state: "complete" as const,
      acceptedByProvider: "true" as const,
      errorCode: null,
      startedAtMs: 10,
      completedAtMs: 80,
      createdAtMs: 5,
      timingObservations: [],
      usageLedger: [
        {
          sequence: 1,
          source: "provider-incremental" as const,
          authoritative: false,
          coverage: "partial" as const,
          observedAtMs: 60,
          counters: {
            inputTokens: 260,
            cacheReadInputTokens: 100,
            cacheWriteInputTokens: null,
            outputTokens: 30,
            reasoningTokens: null,
            visibleOutputTokens: 30,
          },
          costStatementCount: 0,
        },
        {
          sequence: 2,
          source: "provider-final" as const,
          authoritative: true,
          coverage: "complete" as const,
          observedAtMs: 80,
          counters: {
            inputTokens: 300,
            cacheReadInputTokens: 120,
            cacheWriteInputTokens: 40,
            outputTokens: 50,
            reasoningTokens: null,
            visibleOutputTokens: 50,
          },
          costStatementCount: 1,
        },
      ],
    },
  ],
};

describe("Project runtime posture", () => {
  it("keeps local reuse separate from provider-reported cache evidence", () => {
    const projection = buildProjectRuntimePosture(contextAvailability, 0, 0, []);

    expect(projection.cache.label).toBe("No provider cache evidence");
    expect(projection.cache.detail).toMatch(/Local reuse is not instrumented/i);
    expect(projection.telemetry.label).toBe("No telemetry observed");
  });

  it("summarizes authoritative provider cache counters when they are present", () => {
    const projection = buildProjectRuntimePosture(contextAvailability, 1, 2, [telemetrySnapshot]);

    expect(projection.cache.label).toBe("Provider cache reported");
    expect(projection.cache.providerReadTokens).toBe(120);
    expect(projection.cache.providerWriteTokens).toBe(40);
    expect(projection.cache.authority).toBe("authoritative");
    expect(projection.cache.authoritative).toBe(true);
    expect(projection.telemetry.detail).toContain("1 attempt");
  });

  it("does not upgrade mixed provider observations to an authoritative aggregate", () => {
    const nonAuthoritativeAttempt = {
      ...telemetrySnapshot.attempts[0]!,
      attemptId: "attempt-2",
      usageLedger: [
        {
          ...telemetrySnapshot.attempts[0]!.usageLedger[1]!,
          authoritative: false,
          source: "provider-final" as const,
        },
      ],
    };
    const projection = buildProjectRuntimePosture(contextAvailability, 2, 0, [
      {
        ...telemetrySnapshot,
        attempts: [telemetrySnapshot.attempts[0]!, nonAuthoritativeAttempt],
      },
    ]);

    expect(projection.cache.authority).toBe("mixed");
    expect(projection.cache.authoritative).toBe(false);
    expect(projection.cache.detail).toContain("mixed authority");
  });

  it("keeps provider-final cache counters when a later invoice is cost-only", () => {
    const invoiceOnly = {
      ...telemetrySnapshot,
      attempts: [{
        ...telemetrySnapshot.attempts[0]!,
        usageLedger: [
          telemetrySnapshot.attempts[0]!.usageLedger[1]!,
          {
            ...telemetrySnapshot.attempts[0]!.usageLedger[1]!,
            sequence: 3,
            source: "provider-invoice" as const,
            counters: {
              inputTokens: null,
              cacheReadInputTokens: null,
              cacheWriteInputTokens: null,
              outputTokens: null,
              reasoningTokens: null,
              visibleOutputTokens: null,
            },
          },
        ],
      }],
    };
    const projection = buildProjectRuntimePosture(contextAvailability, 1, 0, [invoiceOnly]);

    expect(projection.cache.providerReadTokens).toBe(120);
    expect(projection.cache.providerWriteTokens).toBe(40);
    expect(projection.cache.authority).toBe("authoritative");
  });

  it("navigates each posture card to the corresponding workbench", () => {
    const targets: ProjectRuntimePostureTarget[] = [];
    render(
      <ProjectRuntimePosture
        projectName="Omnia"
        contextAvailability={contextAvailability}
        runCount={0}
        timelineEventCount={0}
        telemetrySnapshots={[]}
        onNavigate={(target) => targets.push(target)}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Open context workbench/i }));
    fireEvent.click(screen.getByRole("button", { name: /Open signal center: No provider cache evidence/i }));
    fireEvent.click(screen.getByRole("button", { name: /Open signal center: No telemetry observed/i }));

    expect(targets).toEqual(["context", "signals", "signals"]);
    expect(screen.getByText(/Provider cache is claimed only from provider-reported counters/i)).toBeInTheDocument();
  });
});
