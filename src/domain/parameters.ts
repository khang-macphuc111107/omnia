import { assertDomain } from "./errors";
import type { IsoTimestamp, JsonValue } from "./shared";
import { freezeJson, uniqueStrings } from "./shared";

export type ParameterSupport = "native" | "translated" | "emulated" | "unsupported";

export type ParameterLayerName =
  | "product-default"
  | "provider-default"
  | "model-default"
  | "user-preset"
  | "project-override"
  | "assistant-override"
  | "conversation-override"
  | "compare-candidate-override"
  | "single-run-override";

export const PARAMETER_LAYER_PRECEDENCE: readonly ParameterLayerName[] = Object.freeze([
  "product-default",
  "provider-default",
  "model-default",
  "user-preset",
  "project-override",
  "assistant-override",
  "conversation-override",
  "compare-candidate-override",
  "single-run-override",
]);

export type ParameterValueType = "number" | "integer" | "boolean" | "string" | "string-list" | "json";

export interface ParameterValidRange {
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly enum?: readonly JsonValue[];
}

export interface ParameterCapability {
  readonly key: string;
  readonly valueType: ParameterValueType;
  readonly support: ParameterSupport;
  readonly providerField?: string;
  readonly validRange?: ParameterValidRange;
  readonly defaultValue?: JsonValue;
  readonly transform?: string;
  readonly emulationId?: string;
  /** Prevents user/model overrides even when the provider accepts the field. */
  readonly locked?: boolean;
}

export interface ParameterLayer {
  readonly name: ParameterLayerName;
  readonly values: Readonly<Record<string, JsonValue | undefined>>;
}

export interface ResolvedParameter<T extends JsonValue = JsonValue> {
  readonly key: string;
  readonly value?: T;
  readonly sourceLayer: ParameterLayerName | "unset";
  readonly support: ParameterSupport;
  readonly sent: boolean;
  readonly providerField?: string;
  readonly validRange?: ParameterValidRange;
  readonly transform?: string;
  readonly warning?: string;
}

export type ResolvedParameterSet = Readonly<Record<string, ResolvedParameter>>;

export interface ParameterConstraint {
  readonly key: string;
  readonly min?: number;
  readonly max?: number;
  readonly allowedValues?: readonly JsonValue[];
  readonly requiredValue?: JsonValue;
  readonly source: "organization-policy" | "provider-hard-bound";
}

export interface ResolveParametersInput {
  readonly layers: readonly ParameterLayer[];
  readonly capabilities: Readonly<Record<string, ParameterCapability>>;
  readonly constraints?: readonly ParameterConstraint[];
  readonly allowedEmulations?: readonly string[];
}

function jsonEquals(left: JsonValue, right: JsonValue): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertParameterType(
  key: string,
  value: JsonValue,
  valueType: ParameterValueType,
): void {
  const valid =
    valueType === "number"
      ? typeof value === "number" && Number.isFinite(value)
      : valueType === "integer"
        ? typeof value === "number" && Number.isInteger(value)
        : valueType === "boolean"
          ? typeof value === "boolean"
          : valueType === "string"
            ? typeof value === "string"
            : valueType === "string-list"
              ? Array.isArray(value) && value.every((entry) => typeof entry === "string")
              : true;
  assertDomain(valid, "invalid_parameter", `${key} has an invalid value type.`, {
    key,
    expected: valueType,
  });
}

function assertValidRange(key: string, value: JsonValue, range: ParameterValidRange): void {
  if (typeof value === "number") {
    assertDomain(
      range.min === undefined || value >= range.min,
      "invalid_parameter",
      `${key} is below the supported minimum.`,
      { key, value, minimum: range.min },
    );
    assertDomain(
      range.max === undefined || value <= range.max,
      "invalid_parameter",
      `${key} exceeds the supported maximum.`,
      { key, value, maximum: range.max },
    );
    if (range.step !== undefined && range.min !== undefined) {
      const quotient = (value - range.min) / range.step;
      assertDomain(
        Math.abs(quotient - Math.round(quotient)) < 1e-9,
        "invalid_parameter",
        `${key} does not align to the supported step.`,
        { key, value, step: range.step },
      );
    }
  }
  if (range.enum !== undefined) {
    assertDomain(
      range.enum.some((candidate) => jsonEquals(candidate, value)),
      "invalid_parameter",
      `${key} is not one of the supported values.`,
      { key },
    );
  }
}

/**
 * Resolves visible parameter provenance from least to most specific. Unknown
 * keys and explicit unsupported values are rejected instead of being silently
 * dropped by a provider adapter.
 */
export function resolveParameters(input: ResolveParametersInput): ResolvedParameterSet {
  const seenLayers = new Set<ParameterLayerName>();
  let lastPrecedence = -1;
  for (const layer of input.layers) {
    assertDomain(!seenLayers.has(layer.name), "conflict", "Parameter layer appears more than once.", {
      layer: layer.name,
    });
    const precedence = PARAMETER_LAYER_PRECEDENCE.indexOf(layer.name);
    assertDomain(precedence >= lastPrecedence, "invalid_argument", "Parameter layers are out of order.", {
      layer: layer.name,
    });
    seenLayers.add(layer.name);
    lastPrecedence = precedence;
  }

  const allowedEmulations = new Set(input.allowedEmulations ?? []);
  const selected = new Map<string, { value: JsonValue; sourceLayer: ParameterLayerName }>();
  for (const layer of input.layers) {
    for (const [key, value] of Object.entries(layer.values)) {
      if (value === undefined) continue;
      const capability = input.capabilities[key];
      assertDomain(capability !== undefined, "invalid_parameter", "Unknown model parameter.", {
        key,
        layer: layer.name,
      });
      assertDomain(!capability.locked, "permission_denied", "A policy-locked parameter cannot be overridden.", {
        key,
        layer: layer.name,
      });
      selected.set(key, { value, sourceLayer: layer.name });
    }
  }

  const constraintsByKey = new Map<string, ParameterConstraint[]>();
  for (const constraint of input.constraints ?? []) {
    const current = constraintsByKey.get(constraint.key) ?? [];
    current.push(constraint);
    constraintsByKey.set(constraint.key, current);
  }

  const result: Record<string, ResolvedParameter> = {};
  for (const [key, capability] of Object.entries(input.capabilities)) {
    const winner = selected.get(key);
    const value = winner?.value ?? capability.defaultValue;
    const sourceLayer: ResolvedParameter["sourceLayer"] =
      winner?.sourceLayer ?? (capability.defaultValue === undefined ? "unset" : "provider-default");

    if (value !== undefined) {
      assertParameterType(key, value, capability.valueType);
      if (capability.validRange !== undefined) assertValidRange(key, value, capability.validRange);
      for (const constraint of constraintsByKey.get(key) ?? []) {
        if (typeof value === "number") {
          assertDomain(
            constraint.min === undefined || value >= constraint.min,
            "invalid_parameter",
            `${key} violates its policy minimum.`,
            { key, source: constraint.source },
          );
          assertDomain(
            constraint.max === undefined || value <= constraint.max,
            "invalid_parameter",
            `${key} violates its policy maximum.`,
            { key, source: constraint.source },
          );
        }
        if (constraint.allowedValues !== undefined) {
          assertDomain(
            constraint.allowedValues.some((candidate) => jsonEquals(candidate, value)),
            "invalid_parameter",
            `${key} is disallowed by policy.`,
            { key, source: constraint.source },
          );
        }
        if (constraint.requiredValue !== undefined) {
          assertDomain(
            jsonEquals(constraint.requiredValue, value),
            "invalid_parameter",
            `${key} conflicts with a required policy value.`,
            { key, source: constraint.source },
          );
        }
      }
    }

    const emulationAllowed =
      capability.support !== "emulated" ||
      (capability.emulationId !== undefined && allowedEmulations.has(capability.emulationId));
    assertDomain(
      value === undefined || capability.support !== "unsupported",
      "unsupported_capability",
      `${key} is explicitly set but unsupported by the selected model.`,
      { key, sourceLayer },
    );
    assertDomain(
      value === undefined || emulationAllowed,
      "unsupported_capability",
      `${key} requires an emulation the user has not enabled.`,
      { key, emulationId: capability.emulationId },
    );

    result[key] = Object.freeze({
      key,
      ...(value === undefined ? {} : { value: freezeJson(value) }),
      sourceLayer,
      support: capability.support,
      sent: value !== undefined && capability.support !== "unsupported" && emulationAllowed,
      ...(capability.providerField === undefined ? {} : { providerField: capability.providerField }),
      ...(capability.validRange === undefined
        ? {}
        : {
            validRange: Object.freeze({
              ...capability.validRange,
              ...(capability.validRange.enum === undefined
                ? {}
                : { enum: Object.freeze([...capability.validRange.enum]) }),
            }),
          }),
      ...(capability.transform === undefined ? {} : { transform: capability.transform }),
      ...(value === undefined ? { warning: "not sent" } : {}),
    });
  }
  return Object.freeze(result);
}

export interface ParameterPresetSnapshot {
  readonly schemaVersion: 1;
  readonly name: string;
  readonly layers: readonly ParameterLayer[];
  readonly resolvedAt: IsoTimestamp;
  readonly warnings: readonly string[];
}

export function createParameterPresetSnapshot(
  name: string,
  layers: readonly ParameterLayer[],
  resolvedAt: IsoTimestamp,
  warnings: readonly string[] = [],
): ParameterPresetSnapshot {
  return Object.freeze({
    schemaVersion: 1,
    name,
    layers: Object.freeze(
      layers.map((layer) =>
        Object.freeze({ name: layer.name, values: Object.freeze({ ...layer.values }) }),
      ),
    ),
    resolvedAt,
    warnings: Object.freeze(uniqueStrings(warnings)),
  });
}
