export type StructuredOutputFieldType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "object"
  | "array"
  | "null";

export interface StructuredOutputField {
  readonly id: string;
  readonly name: string;
  readonly type: StructuredOutputFieldType;
  readonly required: boolean;
  readonly description: string;
  readonly defaultValue: string;
  readonly enumValues: string;
  readonly minimum: string;
  readonly maximum: string;
  /** Optional string constraints. Blank values are omitted from the generated schema. */
  readonly format?: string;
  readonly pattern?: string;
  readonly minLength?: string;
  readonly maxLength?: string;
  /** Optional array constraints. Blank values are omitted from the generated schema. */
  readonly minItems?: string;
  readonly maxItems?: string;
  readonly uniqueItems?: boolean;
  /** Optional nested JSON Schema fragments for array/object fields. */
  readonly itemsType?: StructuredOutputFieldType;
  readonly itemsSchema?: string;
  readonly propertiesSchema?: string;
}

export interface StructuredOutputBuilderOptions {
  readonly title?: string;
  readonly additionalProperties?: boolean;
}

export interface StructuredOutputBuilderIssue {
  readonly fieldId: string;
  readonly path: string;
  readonly message: string;
}

export interface StructuredOutputBuilderResult {
  readonly schema: Record<string, unknown>;
  readonly schemaText: string;
  readonly issues: readonly StructuredOutputBuilderIssue[];
}

export const STRUCTURED_OUTPUT_FIELD_TYPES: readonly { readonly id: StructuredOutputFieldType; readonly label: string }[] = [
  { id: "string", label: "String" },
  { id: "number", label: "Number" },
  { id: "integer", label: "Integer" },
  { id: "boolean", label: "Boolean" },
  { id: "object", label: "Object" },
  { id: "array", label: "Array" },
  { id: "null", label: "Null" },
];

export const DEFAULT_STRUCTURED_OUTPUT_FIELDS: readonly StructuredOutputField[] = [
  {
    id: "field-answer",
    name: "answer",
    type: "string",
    required: true,
    description: "Concise answer for the user.",
    defaultValue: "",
    enumValues: "",
    minimum: "",
    maximum: "",
  },
  {
    id: "field-confidence",
    name: "confidence",
    type: "number",
    required: true,
    description: "Model confidence from zero to one.",
    defaultValue: "0.84",
    enumValues: "",
    minimum: "0",
    maximum: "1",
  },
];

function issue(field: StructuredOutputField, path: string, message: string): StructuredOutputBuilderIssue {
  return { fieldId: field.id, path, message };
}

function coerceScalar(raw: string, type: StructuredOutputFieldType): unknown {
  const value = raw.trim();
  if (type === "string") return raw;
  if (type === "number" || type === "integer") {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new Error("not finite");
    return parsed;
  }
  if (type === "boolean") {
    if (value.toLowerCase() === "true") return true;
    if (value.toLowerCase() === "false") return false;
    throw new Error("not boolean");
  }
  if (type === "null") {
    if (value.toLowerCase() !== "null") throw new Error("not null");
    return null;
  }
  return JSON.parse(value) as unknown;
}

function parseNumeric(raw: string, field: StructuredOutputField, path: string, issues: StructuredOutputBuilderIssue[]): number | undefined {
  if (!raw.trim()) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    issues.push(issue(field, path, "Must be a finite number."));
    return undefined;
  }
  if (field.type === "integer" && !Number.isInteger(value)) {
    issues.push(issue(field, path, "Must be an integer for an integer field."));
    return undefined;
  }
  return value;
}

function parseNonNegativeInteger(raw: string, field: StructuredOutputField, path: string, issues: StructuredOutputBuilderIssue[]): number | undefined {
  if (!raw.trim()) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    issues.push(issue(field, path, "Must be a non-negative integer."));
    return undefined;
  }
  return value;
}

function parseJsonObject(raw: string, field: StructuredOutputField, path: string, issues: StructuredOutputBuilderIssue[]): Record<string, unknown> | undefined {
  if (!raw.trim()) return undefined;
  try {
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, "")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      issues.push(issue(field, path, "Must be a JSON object schema fragment."));
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch {
    issues.push(issue(field, path, "Must be valid JSON."));
    return undefined;
  }
}

function parseJsonSchemaNode(raw: string, field: StructuredOutputField, path: string, issues: StructuredOutputBuilderIssue[]): unknown {
  if (!raw.trim()) return undefined;
  try {
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, "")) as unknown;
    if (!parsed || typeof parsed !== "object") {
      issues.push(issue(field, path, "Must be a JSON object or tuple schema."));
      return undefined;
    }
    return parsed;
  } catch {
    issues.push(issue(field, path, "Must be valid JSON."));
    return undefined;
  }
}

function parseEnumValues(field: StructuredOutputField, issues: StructuredOutputBuilderIssue[]): unknown[] | undefined {
  if (!field.enumValues.trim()) return undefined;
  const trimmed = field.enumValues.trim();
  let values: string[];
  if ((field.type === "object" || field.type === "array") && trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!Array.isArray(parsed)) throw new Error("not array");
      return parsed;
    } catch {
      issues.push(issue(field, `properties.${field.name}.enum`, "Object/array enums must be a valid JSON array."));
      return undefined;
    }
  }
  values = field.enumValues.split(",").map((value) => value.trim()).filter(Boolean);
  if (!values.length) return undefined;
  const parsed: unknown[] = [];
  values.forEach((value, index) => {
    try {
      parsed.push(coerceScalar(value, field.type));
    } catch {
      issues.push(issue(field, `properties.${field.name}.enum[${index}]`, "Enum value is not valid for this field type."));
    }
  });
  return parsed.length ? parsed : undefined;
}

function fieldFromSchema(id: string, name: string, schema: Record<string, unknown>, required: readonly string[]): StructuredOutputField {
  const type = typeof schema.type === "string" && STRUCTURED_OUTPUT_FIELD_TYPES.some((entry) => entry.id === schema.type)
    ? schema.type as StructuredOutputFieldType
    : "string";
  const enumValues = Array.isArray(schema.enum)
    ? schema.enum.map((value) => typeof value === "string" ? value : JSON.stringify(value)).join(", ")
    : "";
  const defaultValue = schema.default === undefined
    ? ""
    : typeof schema.default === "string" ? schema.default : JSON.stringify(schema.default);
  const itemsType = schema.items && typeof schema.items === "object" && !Array.isArray(schema.items) && typeof (schema.items as Record<string, unknown>).type === "string" && STRUCTURED_OUTPUT_FIELD_TYPES.some((entry) => entry.id === (schema.items as Record<string, unknown>).type)
    ? (schema.items as Record<string, unknown>).type as StructuredOutputFieldType
    : undefined;
  return {
    id,
    name,
    type,
    required: required.includes(name),
    description: typeof schema.description === "string" ? schema.description : "",
    defaultValue,
    enumValues,
    minimum: typeof schema.minimum === "number" ? String(schema.minimum) : "",
    maximum: typeof schema.maximum === "number" ? String(schema.maximum) : "",
    format: typeof schema.format === "string" ? schema.format : "",
    pattern: typeof schema.pattern === "string" ? schema.pattern : "",
    minLength: typeof schema.minLength === "number" ? String(schema.minLength) : "",
    maxLength: typeof schema.maxLength === "number" ? String(schema.maxLength) : "",
    minItems: typeof schema.minItems === "number" ? String(schema.minItems) : "",
    maxItems: typeof schema.maxItems === "number" ? String(schema.maxItems) : "",
    uniqueItems: schema.uniqueItems === true,
    ...(itemsType ? { itemsType } : {}),
    itemsSchema: schema.items && typeof schema.items === "object" && !Array.isArray(schema.items) && Object.keys(schema.items as Record<string, unknown>).length > 1
      ? JSON.stringify(schema.items, null, 2)
      : "",
    propertiesSchema: schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
      ? JSON.stringify(schema.properties, null, 2)
      : "",
  };
}

/** Parse an object JSON Schema into editable builder rows. Invalid input returns null. */
export function structuredOutputFieldsFromSchema(schemaText: string): readonly StructuredOutputField[] | null {
  try {
    const parsed = JSON.parse(schemaText.replace(/^\uFEFF/, "")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const root = parsed as Record<string, unknown>;
    const properties = root.properties;
    if (!properties || typeof properties !== "object" || Array.isArray(properties)) return [];
    const required = Array.isArray(root.required) ? root.required.filter((value): value is string => typeof value === "string") : [];
    return Object.entries(properties as Record<string, unknown>).map(([name, value], index) => fieldFromSchema(`field-${name || index}`, name, value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}, required));
  } catch {
    return null;
  }
}

/** Build a small, provider-neutral object JSON Schema from editable rows. */
export function buildStructuredOutputSchema(
  fields: readonly StructuredOutputField[],
  options: StructuredOutputBuilderOptions = {},
): StructuredOutputBuilderResult {
  const issues: StructuredOutputBuilderIssue[] = [];
  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];
  const seen = new Set<string>();

  fields.forEach((field) => {
    const name = field.name.trim();
    if (!name) {
      issues.push(issue(field, "name", "Field name is required."));
      return;
    }
    if (seen.has(name)) {
      issues.push(issue(field, `properties.${name}`, "Field names must be unique."));
      return;
    }
    seen.add(name);

    const property: Record<string, unknown> = { type: field.type };
    if (field.description.trim()) property.description = field.description.trim();
    if (field.defaultValue.trim()) {
      try {
        property.default = coerceScalar(field.defaultValue, field.type);
        if ((field.type === "number" || field.type === "integer") && !Number.isFinite(property.default as number)) {
          throw new Error("not finite");
        }
        if (field.type === "integer" && !Number.isInteger(property.default as number)) throw new Error("not integer");
      } catch {
        issues.push(issue(field, `properties.${name}.default`, "Default value does not match the selected field type."));
      }
    }
    const enumValues = parseEnumValues(field, issues);
    if (enumValues?.length) property.enum = enumValues;
    if (field.type === "number" || field.type === "integer") {
      const minimum = parseNumeric(field.minimum, field, `properties.${name}.minimum`, issues);
      const maximum = parseNumeric(field.maximum, field, `properties.${name}.maximum`, issues);
      if (minimum !== undefined) property.minimum = minimum;
      if (maximum !== undefined) property.maximum = maximum;
      if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
        issues.push(issue(field, `properties.${name}`, "Minimum cannot be greater than maximum."));
      }
    }
    if (field.type === "string") {
      const minLength = parseNonNegativeInteger(field.minLength ?? "", field, `properties.${name}.minLength`, issues);
      const maxLength = parseNonNegativeInteger(field.maxLength ?? "", field, `properties.${name}.maxLength`, issues);
      if (minLength !== undefined) property.minLength = minLength;
      if (maxLength !== undefined) property.maxLength = maxLength;
      if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) {
        issues.push(issue(field, `properties.${name}`, "Minimum length cannot be greater than maximum length."));
      }
      if (field.pattern?.trim()) {
        try {
          new RegExp(field.pattern.trim());
          property.pattern = field.pattern.trim();
        } catch {
          issues.push(issue(field, `properties.${name}.pattern`, "Pattern must be a valid regular expression."));
        }
      }
      if (field.format?.trim()) property.format = field.format.trim();
    }
    if (field.type === "array") {
      const minItems = parseNonNegativeInteger(field.minItems ?? "", field, `properties.${name}.minItems`, issues);
      const maxItems = parseNonNegativeInteger(field.maxItems ?? "", field, `properties.${name}.maxItems`, issues);
      if (minItems !== undefined) property.minItems = minItems;
      if (maxItems !== undefined) property.maxItems = maxItems;
      if (minItems !== undefined && maxItems !== undefined && minItems > maxItems) {
        issues.push(issue(field, `properties.${name}`, "Minimum items cannot be greater than maximum items."));
      }
      if (field.uniqueItems) property.uniqueItems = true;
      const itemsSchema = parseJsonSchemaNode(field.itemsSchema ?? "", field, `properties.${name}.items`, issues);
      if (itemsSchema !== undefined) property.items = itemsSchema;
      else if (field.itemsType) property.items = { type: field.itemsType };
    }
    if (field.type === "object") {
      const propertiesSchema = parseJsonObject(field.propertiesSchema ?? "", field, `properties.${name}.properties`, issues);
      if (propertiesSchema !== undefined) property.properties = propertiesSchema;
    }
    properties[name] = property;
    if (field.required) required.push(name);
  });

  const schema: Record<string, unknown> = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: options.title?.trim() || "Omnia structured output",
    type: "object",
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: options.additionalProperties ?? false,
  };
  return { schema, schemaText: JSON.stringify(schema, null, 2), issues };
}
