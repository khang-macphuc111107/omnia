import { describe, expect, it } from "vitest";
import { DomainError } from "./errors";
import { createRun } from "./run";
import {
  assertEventCursor,
  createOutputRoute,
  freezeOutputRoute,
  isOutputRoute,
  outputRouteKey,
  outputRoutesEqual,
  parseEventCursor,
  parseOutputRoute,
  type OutputRoute,
} from "./output-route";
import type {
  BranchId,
  ConversationId,
  MessageId,
  ProfileId,
  ProjectId,
  RunId,
  TaskId,
} from "./ids";

const id = <T extends string>(value: string) => value as T;
type OutputRouteOverrides = {
  readonly [Key in keyof OutputRoute]?: OutputRoute[Key] | undefined;
};

function input(overrides: OutputRouteOverrides = {}): OutputRoute {
  const base: OutputRoute = {
    profileId: id<ProfileId>("profile_01"),
    projectId: id<ProjectId>("project_01"),
    conversationId: id<ConversationId>("conversation_01"),
    branchId: id<BranchId>("branch_01"),
    taskId: id<TaskId>("task_01"),
    runId: id<RunId>("run_01"),
    producerId: "producer_01",
    createdAtCursor: 42,
  };
  // The test helper intentionally permits `undefined` only for the optional
  // project/task fields. Keep the production route contract strict while
  // making TypeScript understand that invariant at this boundary.
  return { ...base, ...overrides } as OutputRoute;
}

describe("output route", () => {
  it("captures all destination fields as a frozen route", () => {
    const route = createOutputRoute(input());

    expect(Object.isFrozen(route)).toBe(true);
    expect(route).toEqual(input());
    expect(() => {
      (route as unknown as { branchId: BranchId }).branchId = id<BranchId>("branch_02");
    }).toThrow(TypeError);
    expect(route.branchId).toBe(id<BranchId>("branch_01"));
    expect(freezeOutputRoute(route)).toEqual(route);
  });

  it("accepts only non-negative safe event cursors", () => {
    expect(parseEventCursor(0)).toBe(0);
    expect(parseEventCursor(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => assertEventCursor(-1)).toThrow(DomainError);
    expect(() => assertEventCursor(Number.POSITIVE_INFINITY)).toThrow(DomainError);
  });

  it("supports profile-scoped routes without project or task", () => {
    const route = createOutputRoute(input({ projectId: undefined, taskId: undefined }));

    expect(route.projectId).toBeUndefined();
    expect(route.taskId).toBeUndefined();
    expect(Object.keys(route)).toEqual([
      "profileId",
      "conversationId",
      "branchId",
      "runId",
      "producerId",
      "createdAtCursor",
    ]);
  });

  it("parses and freezes an IPC-shaped route", () => {
    const route = parseOutputRoute({ ...input() });

    expect(isOutputRoute(route)).toBe(true);
    expect(Object.isFrozen(route)).toBe(true);
    expect(outputRoutesEqual(route, parseOutputRoute({ ...route }))).toBe(true);
  });

  it("normalizes surrounding whitespace before retaining a route", () => {
    const route = createOutputRoute(input({ producerId: "  producer_01  " }));

    expect(route.producerId).toBe("producer_01");
  });

  it("rejects unknown fields and invalid creation cursors", () => {
    expect(() => parseOutputRoute({ ...input(), activeBranchId: "branch_02" })).toThrow(DomainError);
    expect(() => parseOutputRoute({ ...input(), createdAtCursor: -1 })).toThrow(DomainError);
    expect(() => parseOutputRoute({ ...input(), createdAtCursor: Number.MAX_SAFE_INTEGER + 1 })).toThrow(DomainError);
    expect(isOutputRoute({ ...input(), createdAtCursor: 1.5 })).toBe(false);
  });

  it("includes the cursor and producer in the deterministic route identity", () => {
    const first = createOutputRoute(input());
    const nextCursor = createOutputRoute(input({ createdAtCursor: 43 }));
    const nextProducer = createOutputRoute(input({ producerId: "producer_02" }));

    expect(outputRouteKey(first)).not.toBe(outputRouteKey(nextCursor));
    expect(outputRouteKey(first)).not.toBe(outputRouteKey(nextProducer));
    expect(outputRoutesEqual(first, { ...first })).toBe(true);
  });

  it("binds an optional route to its run scope at creation", () => {
    const route = createOutputRoute(input());
    const run = createRun({
      id: route.runId,
      conversationId: route.conversationId,
      branchId: route.branchId,
      ...(route.projectId === undefined ? {} : { projectId: route.projectId }),
      outputRoute: route,
      userMessageId: id<MessageId>("message_01"),
      now: "2026-11-07T00:00:00.000Z",
    });

    expect(run.outputRoute).toEqual(route);
    expect(Object.isFrozen(run.outputRoute)).toBe(true);
    expect(() =>
      createRun({
        id: route.runId,
        conversationId: route.conversationId,
        branchId: id<BranchId>("branch_02"),
        ...(route.projectId === undefined ? {} : { projectId: route.projectId }),
        outputRoute: route,
        userMessageId: id<MessageId>("message_01"),
        now: "2026-11-07T00:00:00.000Z",
      }),
    ).toThrow(DomainError);
  });
});

