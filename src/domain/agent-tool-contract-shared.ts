import { assertDomain } from "./errors";
import type { ConcreteExecutionMode } from "./execution";
import type { EntityId } from "./ids";
import type { KernelCapability } from "./kernel-capability";

export type ToolVersionId = EntityId<"tool-version">;
export type ToolInvocationId = EntityId<"tool-invocation">;
export type ToolAuthorizationDecisionId =
  EntityId<"tool-authorization-decision">;
export type AgentInstanceId = EntityId<"agent-instance">;
export type AgentMailboxMessageId = EntityId<"agent-mailbox-message">;
export type AgentResultId = EntityId<"agent-result">;

export const KERNEL_CAPABILITY_VALUES: ReadonlySet<KernelCapability> = new Set([
  "pure_compute",
  "read_app_data",
  "read_workspace",
  "write_workspace",
  "execute_process",
  "use_network",
  "external_side_effect",
  "control_browser",
  "control_computer",
  "request_admin",
  "access_secret_handle",
]);

export const EXECUTION_MODE_VALUES: ReadonlySet<ConcreteExecutionMode> = new Set([
  "persistent",
  "isolated",
  "remote",
]);

export function uniqueValues<T>(
  values: readonly T[],
  label: string,
): readonly T[] {
  assertDomain(
    new Set(values).size === values.length,
    "invalid_argument",
    `${label} must be unique.`,
  );
  return Object.freeze([...values]);
}

export function assertPositiveSafeInteger(
  value: number,
  label: string,
): number {
  assertDomain(
    Number.isSafeInteger(value) && value > 0,
    "invalid_argument",
    `${label} must be a positive safe integer.`,
    { label, value },
  );
  return value;
}

export function assertNonNegativeSafeInteger(
  value: number,
  label: string,
): number {
  assertDomain(
    Number.isSafeInteger(value) && value >= 0,
    "invalid_argument",
    `${label} must be a non-negative safe integer.`,
    { label, value },
  );
  return value;
}

export function valuesAreSubset<T>(
  child: readonly T[],
  parent: readonly T[],
): boolean {
  const parentSet = new Set(parent);
  return child.every((value) => parentSet.has(value));
}

