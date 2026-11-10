export type PromptVariableType =
  | "short-text"
  | "long-text"
  | "number"
  | "choice"
  | "boolean"
  | "date"
  | "context-ref";

export type PromptVariableValue = string | number | boolean;

export interface PromptVariableOption {
  label: string;
  value: string;
}

export interface PromptVariableValidation {
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
}

export interface PromptVariable {
  id: string;
  name: string;
  label: string;
  type: PromptVariableType;
  required: boolean;
  defaultValue?: PromptVariableValue;
  options?: PromptVariableOption[];
  validation?: PromptVariableValidation;
}

export interface PromptTemplateExample {
  id: string;
  label: string;
  values: Record<string, PromptVariableValue>;
  expectedPrefix?: string;
  note?: string;
}

export interface PromptTemplateVersion {
  version: string;
  createdAt: string;
  changeNote: string;
  body: string;
  variableIds: string[];
}

export interface PromptTemplateVersionDiff {
  currentVersion: string;
  inspectedVersion: string;
  bodyChanged: boolean;
  variablesAdded: string[];
  variablesRemoved: string[];
  summary: string[];
}

export interface PromptTemplate {
  id: string;
  name: string;
  description: string;
  tags: string[];
  body: string;
  variables: PromptVariable[];
  examples: PromptTemplateExample[];
  version: string;
  versions: PromptTemplateVersion[];
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PromptTemplateResolution {
  templateId: string;
  templateVersion: string;
  values: Record<string, PromptVariableValue>;
  resolvedPrompt: string;
  missingVariableIds: string[];
  warnings: string[];
}

export type PromptTemplateValidationCode =
  | "required"
  | "type"
  | "format"
  | "range"
  | "option"
  | "duplicate"
  | "invalid-definition"
  | "unknown-variable"
  | "body-placeholder";

export interface PromptTemplateValidationIssue {
  path: string;
  code: PromptTemplateValidationCode;
  message: string;
}

export interface PromptTemplatePortableBundle {
  schema: "omnia.prompt-template.preview.v1";
  scope: "renderer-session";
  exportedAt: string;
  template: PromptTemplate;
  boundary: {
    providerRequests: false;
    durableWrite: false;
    nativeVersionReceipt: false;
  };
}

export type PromptTemplateVersionBump = "patch" | "minor" | "major";

export const PROMPT_TEMPLATE_SCHEMA = "omnia.prompt-template.preview.v1" as const;
export const PROMPT_TEMPLATE_MAX_BYTES = 512 * 1024;
const MAX_TEMPLATE_VARIABLES = 64;
const MAX_TEMPLATE_EXAMPLES = 48;
const MAX_TEMPLATE_VERSIONS = 128;
const MAX_TEMPLATE_TAGS = 64;
const MAX_VARIABLE_OPTIONS = 100;

const VARIABLE_TYPES: readonly PromptVariableType[] = [
  "short-text",
  "long-text",
  "number",
  "choice",
  "boolean",
  "date",
  "context-ref",
];

const PLACEHOLDER_PATTERN = /{{\s*([a-zA-Z][a-zA-Z0-9_-]*)\s*}}/g;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPromptVariableType(value: unknown): value is PromptVariableType {
  return typeof value === "string" && VARIABLE_TYPES.includes(value as PromptVariableType);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function addIssue(issues: PromptTemplateValidationIssue[], path: string, code: PromptTemplateValidationCode, message: string): void {
  issues.push({ path, code, message });
}

function validateValue(variable: PromptVariable, value: unknown, path: string): PromptTemplateValidationIssue[] {
  const issues: PromptTemplateValidationIssue[] = [];
  if (value === undefined || value === null || value === "") {
    if (variable.required) addIssue(issues, path, "required", `${variable.label} is required.`);
    return issues;
  }

  const rules = variable.validation ?? {};
  switch (variable.type) {
    case "short-text":
      if (typeof value !== "string") addIssue(issues, path, "type", `${variable.label} must be text.`);
      else if (value.length > (rules.maxLength ?? 240)) addIssue(issues, path, "range", `${variable.label} must be at most ${rules.maxLength ?? 240} characters.`);
      break;
    case "long-text":
      if (typeof value !== "string") addIssue(issues, path, "type", `${variable.label} must be text.`);
      else if (value.length > (rules.maxLength ?? 10000)) addIssue(issues, path, "range", `${variable.label} must be at most ${rules.maxLength ?? 10000} characters.`);
      break;
    case "number":
      if (!isFiniteNumber(value)) addIssue(issues, path, "type", `${variable.label} must be a finite number.`);
      else {
        if (rules.min !== undefined && value < rules.min) addIssue(issues, path, "range", `${variable.label} must be at least ${rules.min}.`);
        if (rules.max !== undefined && value > rules.max) addIssue(issues, path, "range", `${variable.label} must be at most ${rules.max}.`);
      }
      break;
    case "choice":
      if (typeof value !== "string") addIssue(issues, path, "type", `${variable.label} must be one of the listed choices.`);
      else if (!variable.options?.some((option) => option.value === value)) addIssue(issues, path, "option", `${variable.label} is not a listed choice.`);
      break;
    case "boolean":
      if (typeof value !== "boolean") addIssue(issues, path, "type", `${variable.label} must be true or false.`);
      break;
    case "date":
      if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) addIssue(issues, path, "format", `${variable.label} must use YYYY-MM-DD.`);
      break;
    case "context-ref":
      if (typeof value !== "string" || value.trim().length === 0) addIssue(issues, path, "type", `${variable.label} must be a non-empty context reference.`);
      break;
  }

  if (typeof value === "string" && rules.minLength !== undefined && value.length < rules.minLength) addIssue(issues, path, "range", `${variable.label} must be at least ${rules.minLength} characters.`);
  if (typeof value === "string" && rules.maxLength !== undefined && value.length > rules.maxLength) addIssue(issues, path, "range", `${variable.label} must be at most ${rules.maxLength} characters.`);
  if (typeof value === "string" && rules.pattern) {
    try {
      if (!new RegExp(rules.pattern).test(value)) addIssue(issues, path, "format", `${variable.label} does not match its required format.`);
    } catch {
      addIssue(issues, `${path}.validation.pattern`, "invalid-definition", "Variable pattern is not a valid regular expression.");
    }
  }
  return issues;
}

export function validatePromptTemplate(template: PromptTemplate | unknown): PromptTemplateValidationIssue[] {
  const issues: PromptTemplateValidationIssue[] = [];
  if (!isRecord(template)) return [{ path: "template", code: "invalid-definition", message: "Prompt template must be an object." }];
  const candidate = template as unknown as Record<string, unknown>;
  if (typeof candidate.id !== "string" || !candidate.id.trim()) addIssue(issues, "id", "invalid-definition", "Template ID is required.");
  if (typeof candidate.name !== "string" || !candidate.name.trim()) addIssue(issues, "name", "invalid-definition", "Template name is required.");
  if (typeof candidate.description !== "string") addIssue(issues, "description", "invalid-definition", "Template description must be text.");
  if (typeof candidate.body !== "string" || !candidate.body.trim()) addIssue(issues, "body", "invalid-definition", "Template body is required.");
  if (!Array.isArray(candidate.variables)) addIssue(issues, "variables", "invalid-definition", "Variables must be an array.");
  if (!Array.isArray(candidate.tags)) addIssue(issues, "tags", "invalid-definition", "Tags must be an array.");
  if (!Array.isArray(candidate.examples)) addIssue(issues, "examples", "invalid-definition", "Examples must be an array.");
  if (typeof candidate.archived !== "boolean") addIssue(issues, "archived", "invalid-definition", "Archived must be true or false.");
  for (const field of ["createdAt", "updatedAt"] as const) {
    if (typeof candidate[field] !== "string" || Number.isNaN(Date.parse(candidate[field] as string))) addIssue(issues, field, "invalid-definition", `${field} must be a valid date/time.`);
  }

  const tags = Array.isArray(candidate.tags) ? candidate.tags : [];
  if (tags.length > MAX_TEMPLATE_TAGS) addIssue(issues, "tags", "invalid-definition", `Templates may contain at most ${MAX_TEMPLATE_TAGS} tags.`);
  const seenTags = new Set<string>();
  for (const [index, tag] of tags.slice(0, MAX_TEMPLATE_TAGS).entries()) {
    if (typeof tag !== "string" || !tag.trim()) addIssue(issues, `tags[${index}]`, "invalid-definition", "Tags must be non-empty text.");
    else if (seenTags.has(tag.toLowerCase())) addIssue(issues, `tags[${index}]`, "duplicate", `Duplicate tag ${tag}.`);
    else seenTags.add(tag.toLowerCase());
  }

  const variables = Array.isArray(candidate.variables) ? candidate.variables : [];
  if (variables.length > MAX_TEMPLATE_VARIABLES) addIssue(issues, "variables", "invalid-definition", `Templates may contain at most ${MAX_TEMPLATE_VARIABLES} variables.`);
  const names = new Set<string>();
  const ids = new Set<string>();
  const validVariables: PromptVariable[] = [];
  for (const [index, variable] of variables.slice(0, MAX_TEMPLATE_VARIABLES).entries()) {
    const path = `variables[${index}]`;
    if (!isRecord(variable)) {
      addIssue(issues, path, "invalid-definition", "Variable must be an object.");
      continue;
    }
    if (typeof variable.id !== "string" || !variable.id.trim()) addIssue(issues, `${path}.id`, "invalid-definition", "Variable ID is required.");
    else if (ids.has(variable.id)) addIssue(issues, `${path}.id`, "duplicate", `Duplicate variable ID ${variable.id}.`);
    else ids.add(variable.id);
    if (typeof variable.name !== "string" || !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(variable.name)) addIssue(issues, `${path}.name`, "invalid-definition", "Variable name must start with a letter and contain only letters, numbers, underscores, or hyphens.");
    else if (names.has(variable.name)) addIssue(issues, `${path}.name`, "duplicate", `Duplicate variable name ${variable.name}.`);
    else names.add(variable.name);
    if (typeof variable.label !== "string" || !variable.label.trim()) addIssue(issues, `${path}.label`, "invalid-definition", "Variable label is required.");
    const validType = isPromptVariableType(variable.type);
    if (!validType) addIssue(issues, `${path}.type`, "invalid-definition", "Variable type is not supported.");
    if (typeof variable.required !== "boolean") addIssue(issues, `${path}.required`, "invalid-definition", "Variable required must be true or false.");
    if (variable.type === "choice" && (!Array.isArray(variable.options) || variable.options.length === 0)) addIssue(issues, `${path}.options`, "invalid-definition", "Choice variables require at least one option.");
    if (variable.type !== "choice" && variable.options !== undefined) addIssue(issues, `${path}.options`, "invalid-definition", "Only choice variables may define options.");
    if (Array.isArray(variable.options)) {
      if (variable.options.length > MAX_VARIABLE_OPTIONS) addIssue(issues, `${path}.options`, "invalid-definition", `Choice variables may contain at most ${MAX_VARIABLE_OPTIONS} options.`);
      const optionValues = new Set<string>();
      for (const [optionIndex, option] of variable.options.slice(0, MAX_VARIABLE_OPTIONS).entries()) {
        if (!isRecord(option) || typeof option.label !== "string" || !option.label.trim() || typeof option.value !== "string" || !option.value.trim()) {
          addIssue(issues, `${path}.options[${optionIndex}]`, "invalid-definition", "Each choice option needs a non-empty label and value.");
        } else if (optionValues.has(option.value)) addIssue(issues, `${path}.options[${optionIndex}].value`, "duplicate", `Duplicate choice value ${option.value}.`);
        else optionValues.add(option.value);
      }
    }
    if (variable.validation !== undefined) {
      if (!isRecord(variable.validation)) addIssue(issues, `${path}.validation`, "invalid-definition", "Validation rules must be an object.");
      else {
        const rules = variable.validation;
        for (const key of ["min", "max"] as const) if (rules[key] !== undefined && !isFiniteNumber(rules[key])) addIssue(issues, `${path}.validation.${key}`, "invalid-definition", `${key} must be a finite number.`);
        for (const key of ["minLength", "maxLength"] as const) if (rules[key] !== undefined && (!Number.isInteger(rules[key]) || Number(rules[key]) < 0)) addIssue(issues, `${path}.validation.${key}`, "invalid-definition", `${key} must be a non-negative integer.`);
        if (isFiniteNumber(rules.min) && isFiniteNumber(rules.max) && rules.min > rules.max) addIssue(issues, `${path}.validation`, "invalid-definition", "Minimum value cannot exceed maximum value.");
        if (typeof rules.minLength === "number" && typeof rules.maxLength === "number" && rules.minLength > rules.maxLength) addIssue(issues, `${path}.validation`, "invalid-definition", "Minimum length cannot exceed maximum length.");
        if (rules.pattern !== undefined) {
          if (typeof rules.pattern !== "string" || rules.pattern.length > 256) addIssue(issues, `${path}.validation.pattern`, "invalid-definition", "Pattern must be text no longer than 256 characters.");
          else {
            try { new RegExp(rules.pattern); } catch { addIssue(issues, `${path}.validation.pattern`, "invalid-definition", "Variable pattern is not a valid regular expression."); }
          }
        }
      }
    }
    if (validType && typeof variable.name === "string" && typeof variable.id === "string" && typeof variable.label === "string" && typeof variable.required === "boolean") {
      validVariables.push(variable as unknown as PromptVariable);
      if (variable.defaultValue !== undefined) issues.push(...validateValue(variable as unknown as PromptVariable, variable.defaultValue, `${path}.defaultValue`));
    } else if (variable.defaultValue !== undefined && (typeof variable.defaultValue === "string" || typeof variable.defaultValue === "number" || typeof variable.defaultValue === "boolean")) {
      // Reject malformed definitions above without letting malformed option arrays reach value validation.
    } else if (variable.defaultValue !== undefined) addIssue(issues, `${path}.defaultValue`, "invalid-definition", "Default value must be text, a finite number, or a boolean.");
  }

  const placeholders = new Set<string>();
  const body = typeof candidate.body === "string" ? candidate.body : "";
  for (const match of body.matchAll(PLACEHOLDER_PATTERN)) placeholders.add(match[1]!);
  for (const name of placeholders) if (!names.has(name)) addIssue(issues, "body", "body-placeholder", `Body references unknown variable {{${name}}}.`);
  for (const name of names) if (!placeholders.has(name)) addIssue(issues, `variables.${name}`, "body-placeholder", `Variable ${name} is not used in the template body.`);

  const versions = Array.isArray(candidate.versions) ? candidate.versions : [];
  if (!Array.isArray(candidate.versions)) addIssue(issues, "versions", "invalid-definition", "Version history must be an array.");
  if (versions.length === 0 || versions.length > MAX_TEMPLATE_VERSIONS) addIssue(issues, "versions", "invalid-definition", `Version history must contain between 1 and ${MAX_TEMPLATE_VERSIONS} entries.`);
  const versionLabels = new Set<string>();
  for (const [index, version] of versions.slice(0, MAX_TEMPLATE_VERSIONS).entries()) {
    const path = `versions[${index}]`;
    if (!isRecord(version)) {
      addIssue(issues, path, "invalid-definition", "Version record must be an object.");
      continue;
    }
    if (typeof version.version !== "string" || !/^\d+\.\d+\.\d+$/.test(version.version)) addIssue(issues, `${path}.version`, "invalid-definition", "Version must use MAJOR.MINOR.PATCH format.");
    else if (versionLabels.has(version.version)) addIssue(issues, `${path}.version`, "duplicate", `Duplicate version ${version.version}.`);
    else versionLabels.add(version.version);
    if (typeof version.createdAt !== "string" || Number.isNaN(Date.parse(version.createdAt))) addIssue(issues, `${path}.createdAt`, "invalid-definition", "Version date must be valid.");
    if (typeof version.changeNote !== "string") addIssue(issues, `${path}.changeNote`, "invalid-definition", "Version change note must be text.");
    if (typeof version.body !== "string") addIssue(issues, `${path}.body`, "invalid-definition", "Version body must be text.");
    if (!Array.isArray(version.variableIds) || version.variableIds.some((id) => typeof id !== "string")) addIssue(issues, `${path}.variableIds`, "invalid-definition", "Version variable IDs must be a string array.");
  }
  if (typeof candidate.version !== "string" || !versionLabels.has(candidate.version)) addIssue(issues, "version", "invalid-definition", "Current version must exist in version history.");

  const examples = Array.isArray(candidate.examples) ? candidate.examples : [];
  if (examples.length > MAX_TEMPLATE_EXAMPLES) addIssue(issues, "examples", "invalid-definition", `Templates may contain at most ${MAX_TEMPLATE_EXAMPLES} examples.`);
  const exampleIds = new Set<string>();
  const variablesByName = new Map(validVariables.map((variable) => [variable.name, variable]));
  for (const [index, example] of examples.slice(0, MAX_TEMPLATE_EXAMPLES).entries()) {
    const path = `examples[${index}]`;
    if (!isRecord(example)) {
      addIssue(issues, path, "invalid-definition", "Example must be an object.");
      continue;
    }
    if (typeof example.id !== "string" || !example.id.trim()) addIssue(issues, `${path}.id`, "invalid-definition", "Example ID is required.");
    else if (exampleIds.has(example.id)) addIssue(issues, `${path}.id`, "duplicate", `Duplicate example ID ${example.id}.`);
    else exampleIds.add(example.id);
    if (typeof example.label !== "string" || !example.label.trim()) addIssue(issues, `${path}.label`, "invalid-definition", "Example label is required.");
    if (example.note !== undefined && typeof example.note !== "string") addIssue(issues, `${path}.note`, "invalid-definition", "Example note must be text.");
    if (example.expectedPrefix !== undefined && typeof example.expectedPrefix !== "string") addIssue(issues, `${path}.expectedPrefix`, "invalid-definition", "Expected prefix must be text.");
    if (!isRecord(example.values)) addIssue(issues, `${path}.values`, "invalid-definition", "Example values must be an object.");
    else for (const [name, value] of Object.entries(example.values)) {
      const variable = variablesByName.get(name);
      if (!variable) addIssue(issues, `${path}.values.${name}`, "unknown-variable", `Example references unknown variable ${name}.`);
      else issues.push(...validateValue(variable, value, `${path}.values.${name}`));
    }
  }
  return issues;
}

export function resolvePromptTemplate(template: PromptTemplate, values: Record<string, unknown>): PromptTemplateResolution {
  const issues = validatePromptTemplate(template);
  const variables = template.variables ?? [];
  const resolvedValues: Record<string, PromptVariableValue> = {};
  const warnings = issues.map((issue) => issue.message);
  const missingVariableIds: string[] = [];
  for (const variable of variables) {
    const supplied = hasOwn(values, variable.name) ? values[variable.name] : variable.defaultValue;
    const valueIssues = validateValue(variable, supplied, variable.name);
    warnings.push(...valueIssues.map((issue) => issue.message));
    if (valueIssues.some((issue) => issue.code === "required" || issue.code === "type" || issue.code === "format" || issue.code === "option" || issue.code === "range")) {
      if (variable.required) missingVariableIds.push(variable.id);
      continue;
    }
    if (supplied !== undefined && supplied !== null && supplied !== "") resolvedValues[variable.name] = supplied as PromptVariableValue;
  }

  const resolvedPrompt = template.body.replace(PLACEHOLDER_PATTERN, (_match, name: string) => {
    const value = resolvedValues[name];
    return value === undefined ? `{{${name}}}` : String(value);
  });
  return { templateId: template.id, templateVersion: template.version, values: resolvedValues, resolvedPrompt, missingVariableIds, warnings: [...new Set(warnings)] };
}

export function createPromptTemplateVersion(template: PromptTemplate, changeNote: string, createdAt = new Date().toISOString()): PromptTemplateVersion {
  return { version: template.version, createdAt, changeNote, body: template.body, variableIds: template.variables.map((variable) => variable.id) };
}

export function bumpPromptTemplateVersion(version: string, bump: PromptTemplateVersionBump = "patch"): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!match) throw new Error("Prompt template versions must use MAJOR.MINOR.PATCH format.");
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

export function appendPromptTemplateVersion(
  template: PromptTemplate,
  changeNote: string,
  bump: PromptTemplateVersionBump = "patch",
  createdAt = new Date().toISOString(),
): PromptTemplate {
  const nextVersion = bumpPromptTemplateVersion(template.version, bump);
  const nextVersionRecord: PromptTemplateVersion = {
    version: nextVersion,
    createdAt,
    changeNote,
    body: template.body,
    variableIds: template.variables.map((variable) => variable.id),
  };
  return {
    ...template,
    version: nextVersion,
    versions: [...template.versions, nextVersionRecord],
    updatedAt: createdAt,
  };
}

/**
 * Compare a historical renderer version with the currently selected template.
 * The version record intentionally contains only body text and variable IDs,
 * so this helper reports a deterministic preview diff without pretending that
 * a native rollback or durable revision exists.
 */
export function comparePromptTemplateVersion(template: PromptTemplate, version: PromptTemplateVersion): PromptTemplateVersionDiff {
  const currentIds = new Set(template.variables.map((variable) => variable.id));
  const inspectedIds = new Set(version.variableIds);
  const variablesAdded = template.variables.filter((variable) => !inspectedIds.has(variable.id)).map((variable) => variable.id);
  const variablesRemoved = version.variableIds.filter((id) => !currentIds.has(id));
  const bodyChanged = template.body !== version.body;
  const summary: string[] = [];
  if (bodyChanged) summary.push("Prompt body differs from the inspected version.");
  if (variablesAdded.length > 0) summary.push(`${variablesAdded.length} variable${variablesAdded.length === 1 ? "" : "s"} added after this version.`);
  if (variablesRemoved.length > 0) summary.push(`${variablesRemoved.length} variable${variablesRemoved.length === 1 ? "" : "s"} removed after this version.`);
  if (summary.length === 0) summary.push("No body or variable-set differences are visible in this preview.");
  return { currentVersion: template.version, inspectedVersion: version.version, bodyChanged, variablesAdded, variablesRemoved, summary };
}

export function serializePromptTemplate(template: PromptTemplate, exportedAt = new Date().toISOString()): string {
  const bundle: PromptTemplatePortableBundle = {
    schema: PROMPT_TEMPLATE_SCHEMA,
    scope: "renderer-session",
    exportedAt,
    template,
    boundary: { providerRequests: false, durableWrite: false, nativeVersionReceipt: false },
  };
  return JSON.stringify(bundle, null, 2);
}

export function parsePromptTemplateBundle(raw: string): PromptTemplate {
  const normalized = raw.replace(/^\uFEFF/, "");
  if (new TextEncoder().encode(normalized).byteLength > PROMPT_TEMPLATE_MAX_BYTES) throw new Error("Prompt template bundle exceeds the 512 KB preview limit.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(normalized);
  } catch {
    throw new Error("Prompt template bundle is not valid JSON.");
  }
  if (!isRecord(parsed) || parsed.schema !== PROMPT_TEMPLATE_SCHEMA || parsed.scope !== "renderer-session" || !isRecord(parsed.template)) throw new Error("Unsupported prompt template bundle.");
  const template = parsed.template as unknown as PromptTemplate;
  const issues = validatePromptTemplate(template);
  if (issues.length > 0) throw new Error(`Prompt template validation failed: ${issues[0]!.message}`);
  return template;
}
