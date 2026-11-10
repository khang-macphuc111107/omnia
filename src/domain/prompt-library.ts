import { assertDomain } from "./errors";
import type { PromptTemplateId } from "./ids";
import {
  assertIsoTimestamp,
  assertNonBlank,
  freezeJson,
  stableSort,
  type IsoTimestamp,
  type JsonObject,
} from "./shared";

/**
 * Durable, provider-independent prompt library records.
 *
 * The renderer preview has its own prompt contract, but native persistence,
 * import/export, search and usage accounting need an ID-branded domain shape.
 * This module intentionally stops at prompt resolution; it never performs a
 * provider request or grants execution permission.
 */
export type PromptLibraryVariableType =
  | "short-text"
  | "long-text"
  | "number"
  | "choice"
  | "boolean"
  | "date"
  | "context-ref";

export type PromptLibraryVariableValue = string | number | boolean;

export interface PromptLibraryVariableOption {
  readonly label: string;
  readonly value: string;
}

export interface PromptLibraryVariableValidation {
  readonly min?: number;
  readonly max?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
}

export interface PromptLibraryVariable {
  readonly id: string;
  readonly name: string;
  readonly label: string;
  readonly type: PromptLibraryVariableType;
  readonly required: boolean;
  readonly defaultValue?: PromptLibraryVariableValue;
  readonly options?: readonly PromptLibraryVariableOption[];
  readonly validation?: PromptLibraryVariableValidation;
}

export interface PromptLibraryVersion {
  readonly version: string;
  readonly body: string;
  readonly variableIds: readonly string[];
  readonly changeNote: string;
  readonly createdAt: IsoTimestamp;
}

export type PromptLibrarySource =
  | "built-in"
  | "user"
  | "import"
  | "generated"
  | "marketplace";

export interface PromptLibraryFolder {
  readonly id: string;
  readonly name: string;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export interface PromptLibraryTemplate {
  readonly id: PromptTemplateId;
  readonly name: string;
  readonly description: string;
  readonly body: string;
  readonly variables: readonly PromptLibraryVariable[];
  readonly tags: readonly string[];
  readonly folderId?: string;
  readonly favorite: boolean;
  readonly archived: boolean;
  readonly source: PromptLibrarySource;
  readonly version: string;
  readonly versions: readonly PromptLibraryVersion[];
  readonly useCount: number;
  readonly lastUsedAt?: IsoTimestamp;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly metadata: JsonObject;
}

export interface PromptLibrary {
  readonly schemaVersion: 1;
  readonly templates: readonly PromptLibraryTemplate[];
  readonly folders: readonly PromptLibraryFolder[];
  readonly updatedAt: IsoTimestamp;
}

export interface CreatePromptLibraryTemplateInput {
  readonly id: PromptTemplateId;
  readonly name: string;
  readonly description?: string;
  readonly body: string;
  readonly variables?: readonly PromptLibraryVariable[];
  readonly tags?: readonly string[];
  readonly folderId?: string;
  readonly favorite?: boolean;
  readonly archived?: boolean;
  readonly source?: PromptLibrarySource;
  readonly version?: string;
  readonly changeNote?: string;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt?: IsoTimestamp;
  readonly metadata?: JsonObject;
}

export interface UpdatePromptLibraryTemplateInput {
  readonly name?: string;
  readonly description?: string;
  readonly body?: string;
  readonly variables?: readonly PromptLibraryVariable[];
  readonly tags?: readonly string[];
  readonly folderId?: string | null;
  readonly favorite?: boolean;
  readonly archived?: boolean;
  readonly metadata?: JsonObject;
  readonly changeNote?: string;
  readonly versionBump?: "patch" | "minor" | "major";
  readonly now: IsoTimestamp;
}

export interface PromptLibrarySearchOptions {
  readonly query?: string;
  readonly tag?: string;
  readonly folderId?: string | null;
  readonly includeArchived?: boolean;
  readonly favoritesOnly?: boolean;
  readonly source?: PromptLibrarySource;
  readonly sort?: "updated" | "name" | "usage" | "relevance";
  readonly limit?: number;
}

export interface PromptLibraryResolution {
  readonly templateId: PromptTemplateId;
  readonly templateVersion: string;
  readonly values: Readonly<Record<string, PromptLibraryVariableValue>>;
  readonly resolvedPrompt: string;
  readonly missingVariableIds: readonly string[];
  readonly warnings: readonly string[];
}

export interface PromptLibraryPortableBundle {
  readonly schema: "omnia.prompt-library.v1";
  readonly exportedAt: IsoTimestamp;
  readonly library: PromptLibrary;
}

export const PROMPT_LIBRARY_SCHEMA = "omnia.prompt-library.v1" as const;
export const PROMPT_LIBRARY_MAX_BYTES = 2 * 1024 * 1024;

const VARIABLE_TYPES: ReadonlySet<PromptLibraryVariableType> = new Set([
  "short-text",
  "long-text",
  "number",
  "choice",
  "boolean",
  "date",
  "context-ref",
]);
const SOURCES: ReadonlySet<PromptLibrarySource> = new Set([
  "built-in",
  "user",
  "import",
  "generated",
  "marketplace",
]);
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const VARIABLE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;
const PLACEHOLDER_PATTERN = /{{\s*([A-Za-z][A-Za-z0-9_-]*)\s*}}/g;
const MAX_VARIABLES = 128;
const MAX_TAGS = 128;
const MAX_VERSIONS = 256;

function cloneVariable(variable: PromptLibraryVariable): PromptLibraryVariable {
  const options = variable.options?.map((option) => Object.freeze({ ...option }));
  const validation = variable.validation === undefined ? undefined : Object.freeze({ ...variable.validation });
  return Object.freeze({
    ...variable,
    ...(options === undefined ? {} : { options: Object.freeze(options) }),
    ...(validation === undefined ? {} : { validation }),
  });
}

function normalizeTags(tags: readonly string[]): readonly string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const value of tags) {
    const tag = assertNonBlank(value, "prompt tag", 80).toLowerCase();
    if (!seen.has(tag)) {
      seen.add(tag);
      normalized.push(tag);
    }
  }
  assertDomain(normalized.length <= MAX_TAGS, "invalid_argument", "A prompt can have at most 128 tags.");
  return Object.freeze(normalized);
}

function validateVersion(version: string): string {
  const normalized = assertNonBlank(version, "prompt version", 32);
  assertDomain(VERSION_PATTERN.test(normalized), "invalid_argument", "Prompt version must use MAJOR.MINOR.PATCH format.");
  return normalized;
}

function validateVariable(variable: PromptLibraryVariable, index: number): PromptLibraryVariable {
  const id = assertNonBlank(variable.id, `prompt variable ${index + 1} ID`, 160);
  const name = assertNonBlank(variable.name, `prompt variable ${index + 1} name`, 160);
  assertDomain(VARIABLE_NAME_PATTERN.test(name), "invalid_argument", "Prompt variable names must be identifier-like.", { name });
  const label = assertNonBlank(variable.label, `prompt variable ${index + 1} label`, 240);
  assertDomain(VARIABLE_TYPES.has(variable.type), "invalid_argument", "Prompt variable type is not supported.", { type: variable.type });
  if (variable.type === "choice") {
    assertDomain((variable.options?.length ?? 0) > 0, "invalid_argument", "Choice prompt variables require at least one option.", { name });
  } else {
    assertDomain(variable.options === undefined, "invalid_argument", "Only choice prompt variables may define options.", { name });
  }
  const optionValues = new Set<string>();
  const options = variable.options?.map((option) => {
    const normalized = Object.freeze({
      label: assertNonBlank(option.label, "prompt option label", 240),
      value: assertNonBlank(option.value, "prompt option value", 240),
    });
    assertDomain(!optionValues.has(normalized.value), "conflict", "Prompt choice values must be unique.", { name, value: normalized.value });
    optionValues.add(normalized.value);
    return normalized;
  });
  const validation = variable.validation;
  if (validation !== undefined) {
    for (const [label, value] of [
      ["min", validation.min],
      ["max", validation.max],
    ] as const) {
      assertDomain(value === undefined || (typeof value === "number" && Number.isFinite(value)), "invalid_argument", `Prompt variable ${label} must be finite.`);
    }
    for (const [label, value] of [
      ["minLength", validation.minLength],
      ["maxLength", validation.maxLength],
    ] as const) {
      assertDomain(value === undefined || (Number.isSafeInteger(value) && value >= 0), "invalid_argument", `Prompt variable ${label} must be a non-negative integer.`);
    }
    assertDomain(
      validation.min === undefined || validation.max === undefined || validation.min <= validation.max,
      "invalid_argument",
      "Prompt variable minimum cannot exceed maximum.",
    );
    assertDomain(
      validation.minLength === undefined || validation.maxLength === undefined || validation.minLength <= validation.maxLength,
      "invalid_argument",
      "Prompt variable minimum length cannot exceed maximum length.",
    );
    if (validation.pattern !== undefined) {
      assertDomain(validation.pattern.length <= 512, "invalid_argument", "Prompt variable pattern is too long.");
      try {
        new RegExp(validation.pattern);
      } catch {
        assertDomain(false, "invalid_argument", "Prompt variable pattern must be a valid regular expression.");
      }
    }
  }
  return Object.freeze({
    id,
    name,
    label,
    type: variable.type,
    required: variable.required,
    ...(variable.defaultValue === undefined ? {} : { defaultValue: variable.defaultValue }),
    ...(options === undefined ? {} : { options: Object.freeze(options) }),
    ...(validation === undefined ? {} : { validation: Object.freeze({ ...validation }) }),
  });
}

function validateBodyAndVariables(body: string, variables: readonly PromptLibraryVariable[]): void {
  const names = new Set<string>();
  const ids = new Set<string>();
  for (const [index, variable] of variables.entries()) {
    const validated = validateVariable(variable, index);
    assertDomain(!ids.has(validated.id), "conflict", "Prompt variable IDs must be unique.", { id: validated.id });
    assertDomain(!names.has(validated.name), "conflict", "Prompt variable names must be unique.", { name: validated.name });
    ids.add(validated.id);
    names.add(validated.name);
  }
  const placeholders = new Set<string>();
  for (const match of body.matchAll(PLACEHOLDER_PATTERN)) placeholders.add(match[1] ?? "");
  for (const placeholder of placeholders) {
    assertDomain(names.has(placeholder), "invalid_argument", `Prompt body references unknown variable {{${placeholder}}}.`);
  }
  for (const name of names) {
    assertDomain(placeholders.has(name), "invalid_argument", `Prompt variable ${name} is not used in the prompt body.`);
  }
}

function freezeVersion(version: PromptLibraryVersion): PromptLibraryVersion {
  assertIsoTimestamp(version.createdAt, "prompt version creation time");
  return Object.freeze({
    version: validateVersion(version.version),
    body: assertNonBlank(version.body, "prompt version body", 1_000_000),
    variableIds: Object.freeze([...version.variableIds]),
    changeNote: assertNonBlank(version.changeNote, "prompt version change note", 2_000),
    createdAt: version.createdAt,
  });
}

function versionParts(version: string): [number, number, number] {
  const [major, minor, patch] = version.split(".").map((part) => Number(part));
  return [major ?? 0, minor ?? 0, patch ?? 0];
}

function bumpVersion(version: string, bump: "patch" | "minor" | "major"): string {
  const [major, minor, patch] = versionParts(version);
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

function normalizeTemplateInput(input: CreatePromptLibraryTemplateInput): PromptLibraryTemplate {
  assertIsoTimestamp(input.createdAt, "prompt creation time");
  const updatedAt = input.updatedAt ?? input.createdAt;
  assertIsoTimestamp(updatedAt, "prompt update time");
  const name = assertNonBlank(input.name, "prompt name", 240);
  const description = (input.description ?? "").trim();
  assertDomain(description.length <= 4_000, "invalid_argument", "Prompt description is too long.");
  const body = assertNonBlank(input.body, "prompt body", 1_000_000);
  const variables = Object.freeze((input.variables ?? []).map(validateVariable));
  assertDomain(variables.length <= MAX_VARIABLES, "invalid_argument", "A prompt can have at most 128 variables.");
  validateBodyAndVariables(body, variables);
  const version = validateVersion(input.version ?? "1.0.0");
  const versionRecord = freezeVersion({
    version,
    body,
    variableIds: variables.map((variable) => variable.id),
    changeNote: input.changeNote ?? "Initial prompt version",
    createdAt: input.createdAt,
  });
  const source = input.source ?? "user";
  assertDomain(SOURCES.has(source), "invalid_argument", "Prompt source is not recognized.");
  return Object.freeze({
    id: input.id,
    name,
    description,
    body,
    variables,
    tags: normalizeTags(input.tags ?? []),
    ...(input.folderId === undefined ? {} : { folderId: assertNonBlank(input.folderId, "prompt folder ID", 160) }),
    favorite: input.favorite ?? false,
    archived: input.archived ?? false,
    source,
    version,
    versions: Object.freeze([versionRecord]),
    useCount: 0,
    createdAt: input.createdAt,
    updatedAt,
    metadata: freezeJson(input.metadata ?? {}),
  });
}

function assertUniqueTemplateIds(templates: readonly PromptLibraryTemplate[]): void {
  const seen = new Set<PromptTemplateId>();
  for (const template of templates) {
    assertDomain(!seen.has(template.id), "conflict", "Prompt template IDs must be unique.", { id: template.id });
    seen.add(template.id);
  }
}

function assertFolderExists(library: PromptLibrary, folderId: string | undefined): void {
  if (folderId === undefined) return;
  assertDomain(library.folders.some((folder) => folder.id === folderId), "not_found", "Prompt folder was not found.", { folderId });
}

function cloneTemplate(template: PromptLibraryTemplate): PromptLibraryTemplate {
  return Object.freeze({
    ...template,
    variables: Object.freeze(template.variables.map(cloneVariable)),
    tags: Object.freeze([...template.tags]),
    versions: Object.freeze(template.versions.map(freezeVersion)),
    metadata: freezeJson(template.metadata),
  });
}

export function createPromptLibrary(
  templates: readonly PromptLibraryTemplate[] = [],
  folders: readonly PromptLibraryFolder[] = [],
  updatedAt = new Date().toISOString(),
): PromptLibrary {
  assertIsoTimestamp(updatedAt, "prompt library update time");
  assertUniqueTemplateIds(templates);
  const folderIds = new Set<string>();
  const normalizedFolders = folders.map((folder) => {
    assertIsoTimestamp(folder.createdAt, "prompt folder creation time");
    assertIsoTimestamp(folder.updatedAt, "prompt folder update time");
    const id = assertNonBlank(folder.id, "prompt folder ID", 160);
    assertDomain(!folderIds.has(id), "conflict", "Prompt folder IDs must be unique.", { id });
    folderIds.add(id);
    return Object.freeze({
      id,
      name: assertNonBlank(folder.name, "prompt folder name", 160),
      createdAt: folder.createdAt,
      updatedAt: folder.updatedAt,
    });
  });
  for (const template of templates) assertFolderExists({ schemaVersion: 1, templates, folders: normalizedFolders, updatedAt }, template.folderId);
  return Object.freeze({
    schemaVersion: 1,
    templates: Object.freeze(templates.map(cloneTemplate)),
    folders: Object.freeze(normalizedFolders),
    updatedAt,
  });
}

export function addPromptLibraryTemplate(
  library: PromptLibrary,
  input: CreatePromptLibraryTemplateInput,
  now = input.updatedAt ?? input.createdAt,
): PromptLibrary {
  assertIsoTimestamp(now, "prompt library update time");
  assertDomain(!library.templates.some((template) => template.id === input.id), "conflict", "Prompt template ID already exists.", { id: input.id });
  const template = normalizeTemplateInput(input);
  assertFolderExists(library, template.folderId);
  return Object.freeze({ ...library, templates: Object.freeze([...library.templates, template]), updatedAt: now });
}

export function createPromptLibraryFolder(
  library: PromptLibrary,
  id: string,
  name: string,
  now: IsoTimestamp,
): PromptLibrary {
  assertIsoTimestamp(now, "prompt folder creation time");
  const folderId = assertNonBlank(id, "prompt folder ID", 160);
  assertDomain(!library.folders.some((folder) => folder.id === folderId), "conflict", "Prompt folder ID already exists.", { folderId });
  const folder = Object.freeze({
    id: folderId,
    name: assertNonBlank(name, "prompt folder name", 160),
    createdAt: now,
    updatedAt: now,
  });
  return Object.freeze({ ...library, folders: Object.freeze([...library.folders, folder]), updatedAt: now });
}

export function renamePromptLibraryFolder(
  library: PromptLibrary,
  folderId: string,
  name: string,
  now: IsoTimestamp,
): PromptLibrary {
  assertIsoTimestamp(now, "prompt folder update time");
  assertDomain(library.folders.some((folder) => folder.id === folderId), "not_found", "Prompt folder was not found.", { folderId });
  return Object.freeze({
    ...library,
    folders: Object.freeze(
      library.folders.map((folder) =>
        folder.id === folderId
          ? Object.freeze({ ...folder, name: assertNonBlank(name, "prompt folder name", 160), updatedAt: now })
          : folder,
      ),
    ),
    updatedAt: now,
  });
}

/** Removes a folder while keeping its templates safe and unfiled. */
export function removePromptLibraryFolder(
  library: PromptLibrary,
  folderId: string,
  now: IsoTimestamp,
): PromptLibrary {
  assertIsoTimestamp(now, "prompt folder removal time");
  assertDomain(library.folders.some((folder) => folder.id === folderId), "not_found", "Prompt folder was not found.", { folderId });
  return Object.freeze({
    ...library,
    folders: Object.freeze(library.folders.filter((folder) => folder.id !== folderId)),
    templates: Object.freeze(
      library.templates.map((template) => {
        if (template.folderId !== folderId) return template;
        const unfiled = { ...template };
        delete unfiled.folderId;
        return Object.freeze(unfiled);
      }),
    ),
    updatedAt: now,
  });
}

export function removePromptLibraryTemplate(
  library: PromptLibrary,
  templateId: PromptTemplateId,
  now: IsoTimestamp,
): PromptLibrary {
  assertIsoTimestamp(now, "prompt template removal time");
  assertDomain(library.templates.some((template) => template.id === templateId), "not_found", "Prompt template was not found.", { templateId });
  return Object.freeze({
    ...library,
    templates: Object.freeze(library.templates.filter((template) => template.id !== templateId)),
    updatedAt: now,
  });
}

export function clonePromptLibraryTemplate(
  library: PromptLibrary,
  sourceId: PromptTemplateId,
  cloneId: PromptTemplateId,
  now: IsoTimestamp,
): PromptLibrary {
  assertIsoTimestamp(now, "prompt template clone time");
  const source = library.templates.find((template) => template.id === sourceId);
  assertDomain(source !== undefined, "not_found", "Prompt template was not found.", { sourceId });
  assertDomain(!library.templates.some((template) => template.id === cloneId), "conflict", "Prompt template ID already exists.", { cloneId });
  const sourceWithoutUsageTimestamp = { ...cloneTemplate(source) };
  delete sourceWithoutUsageTimestamp.lastUsedAt;
  const copy: PromptLibraryTemplate = Object.freeze({
    ...sourceWithoutUsageTimestamp,
    id: cloneId,
    name: `${source.name} copy`,
    source: "user",
    favorite: false,
    useCount: 0,
    createdAt: now,
    updatedAt: now,
    metadata: freezeJson(source.metadata),
  });
  const copyWithoutUsageTimestamp = { ...copy };
  delete copyWithoutUsageTimestamp.lastUsedAt;
  return Object.freeze({
    ...library,
    templates: Object.freeze([...library.templates, Object.freeze(copyWithoutUsageTimestamp)]),
    updatedAt: now,
  });
}

export interface PromptLibraryStats {
  readonly templateCount: number;
  readonly activeCount: number;
  readonly archivedCount: number;
  readonly favoriteCount: number;
  readonly folderCount: number;
  readonly totalUseCount: number;
  readonly tagCounts: Readonly<Record<string, number>>;
}

export function summarizePromptLibrary(library: PromptLibrary): PromptLibraryStats {
  const tagCounts: Record<string, number> = {};
  let archivedCount = 0;
  let favoriteCount = 0;
  let totalUseCount = 0;
  for (const template of library.templates) {
    if (template.archived) archivedCount += 1;
    if (template.favorite) favoriteCount += 1;
    totalUseCount += template.useCount;
    for (const tag of template.tags) tagCounts[tag] = (tagCounts[tag] ?? 0) + 1;
  }
  return Object.freeze({
    templateCount: library.templates.length,
    activeCount: library.templates.length - archivedCount,
    archivedCount,
    favoriteCount,
    folderCount: library.folders.length,
    totalUseCount,
    tagCounts: Object.freeze(tagCounts),
  });
}

export function updatePromptLibraryTemplate(
  library: PromptLibrary,
  templateId: PromptTemplateId,
  input: UpdatePromptLibraryTemplateInput,
): PromptLibrary {
  assertIsoTimestamp(input.now, "prompt template update time");
  const current = library.templates.find((template) => template.id === templateId);
  assertDomain(current !== undefined, "not_found", "Prompt template was not found.", { templateId });
  const nextBody = input.body === undefined ? current.body : assertNonBlank(input.body, "prompt body", 1_000_000);
  const nextVariables = Object.freeze((input.variables ?? current.variables).map(validateVariable));
  validateBodyAndVariables(nextBody, nextVariables);
  const nextVersion = input.changeNote === undefined && input.versionBump === undefined
    ? current.version
    : bumpVersion(current.version, input.versionBump ?? "patch");
  const versions = nextVersion === current.version
    ? current.versions
    : Object.freeze([
        ...current.versions,
        freezeVersion({
          version: nextVersion,
          body: nextBody,
          variableIds: nextVariables.map((variable) => variable.id),
          changeNote: input.changeNote ?? "Updated prompt template",
          createdAt: input.now,
        }),
      ]);
  assertDomain(versions.length <= MAX_VERSIONS, "invalid_argument", "Prompt version history is full.");
  const folderId = input.folderId === null ? undefined : input.folderId ?? current.folderId;
  assertFolderExists(library, folderId);
  const nextTemplateDraft = {
    ...current,
    ...(input.name === undefined ? {} : { name: assertNonBlank(input.name, "prompt name", 240) }),
    ...(input.description === undefined ? {} : { description: input.description.trim() }),
    body: nextBody,
    variables: nextVariables,
    ...(input.tags === undefined ? {} : { tags: normalizeTags(input.tags) }),
    ...(folderId === undefined ? {} : { folderId }),
    ...(input.favorite === undefined ? {} : { favorite: input.favorite }),
    ...(input.archived === undefined ? {} : { archived: input.archived }),
    ...(input.metadata === undefined ? {} : { metadata: freezeJson(input.metadata) }),
    version: nextVersion,
    versions,
    updatedAt: input.now,
  };
  if (input.folderId === null) delete nextTemplateDraft.folderId;
  const nextTemplate: PromptLibraryTemplate = Object.freeze(nextTemplateDraft);
  const templates = library.templates.map((template) => (template.id === templateId ? nextTemplate : template));
  return Object.freeze({ ...library, templates: Object.freeze(templates), updatedAt: input.now });
}

export function recordPromptLibraryUsage(
  library: PromptLibrary,
  templateId: PromptTemplateId,
  usedAt: IsoTimestamp,
): PromptLibrary {
  assertIsoTimestamp(usedAt, "prompt usage time");
  const found = library.templates.some((template) => template.id === templateId);
  assertDomain(found, "not_found", "Prompt template was not found.", { templateId });
  return Object.freeze({
    ...library,
    templates: Object.freeze(
      library.templates.map((template) =>
        template.id === templateId
          ? Object.freeze({ ...template, useCount: template.useCount + 1, lastUsedAt: usedAt })
          : template,
      ),
    ),
    updatedAt: usedAt,
  });
}

export function archivePromptLibraryTemplate(
  library: PromptLibrary,
  templateId: PromptTemplateId,
  archived: boolean,
  now: IsoTimestamp,
): PromptLibrary {
  return updatePromptLibraryTemplate(library, templateId, { archived, now });
}

export function togglePromptLibraryFavorite(
  library: PromptLibrary,
  templateId: PromptTemplateId,
  now: IsoTimestamp,
): PromptLibrary {
  const template = library.templates.find((candidate) => candidate.id === templateId);
  assertDomain(template !== undefined, "not_found", "Prompt template was not found.", { templateId });
  return updatePromptLibraryTemplate(library, templateId, { favorite: !template.favorite, now });
}

export function searchPromptLibrary(
  library: PromptLibrary,
  options: PromptLibrarySearchOptions = {},
): readonly PromptLibraryTemplate[] {
  const query = options.query?.trim().toLowerCase() ?? "";
  const tag = options.tag?.trim().toLowerCase();
  const includeArchived = options.includeArchived ?? false;
  const limit = options.limit ?? 100;
  assertDomain(Number.isSafeInteger(limit) && limit > 0 && limit <= 1_000, "invalid_argument", "Prompt search limit must be between 1 and 1000.");
  const candidates = library.templates.filter((template) => {
    if (!includeArchived && template.archived) return false;
    if (options.favoritesOnly && !template.favorite) return false;
    if (options.source !== undefined && template.source !== options.source) return false;
    if (options.folderId !== undefined && (options.folderId === null ? template.folderId !== undefined : template.folderId !== options.folderId)) return false;
    if (tag !== undefined && !template.tags.includes(tag)) return false;
    if (!query) return true;
    return [template.name, template.description, template.body, ...template.tags].join(" ").toLowerCase().includes(query);
  });
  const sort = options.sort ?? "updated";
  const ranked = stableSort(candidates, (left, right) => {
    if (sort === "name") return left.name.localeCompare(right.name);
    if (sort === "usage") return right.useCount - left.useCount || right.updatedAt.localeCompare(left.updatedAt);
    if (sort === "relevance" && query) {
      const score = (template: PromptLibraryTemplate): number => {
        let value = 0;
        const name = template.name.toLowerCase();
        if (name === query) value += 10;
        if (name.includes(query)) value += 5;
        if (template.tags.some((entry) => entry === query)) value += 4;
        if (template.description.toLowerCase().includes(query)) value += 2;
        return value;
      };
      return score(right) - score(left) || right.updatedAt.localeCompare(left.updatedAt);
    }
    return right.updatedAt.localeCompare(left.updatedAt);
  });
  return Object.freeze(ranked.slice(0, limit));
}

function validatePromptValue(variable: PromptLibraryVariable, value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return variable.required ? `${variable.label} is required.` : undefined;
  const rules = variable.validation;
  switch (variable.type) {
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) return `${variable.label} must be a finite number.`;
      if (rules?.min !== undefined && value < rules.min) return `${variable.label} must be at least ${rules.min}.`;
      if (rules?.max !== undefined && value > rules.max) return `${variable.label} must be at most ${rules.max}.`;
      break;
    case "boolean":
      if (typeof value !== "boolean") return `${variable.label} must be true or false.`;
      break;
    case "choice":
      if (typeof value !== "string" || !variable.options?.some((option) => option.value === value)) return `${variable.label} must be one of the listed choices.`;
      break;
    case "date":
      if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) return `${variable.label} must use YYYY-MM-DD.`;
      break;
    case "short-text":
    case "long-text":
    case "context-ref":
      if (typeof value !== "string") return `${variable.label} must be text.`;
      if (variable.type === "context-ref" && value.trim().length === 0) return `${variable.label} must not be empty.`;
      if (rules?.minLength !== undefined && value.length < rules.minLength) return `${variable.label} must be at least ${rules.minLength} characters.`;
      if (rules?.maxLength !== undefined && value.length > rules.maxLength) return `${variable.label} must be at most ${rules.maxLength} characters.`;
      if (rules?.pattern !== undefined && !new RegExp(rules.pattern).test(value)) return `${variable.label} does not match its required format.`;
      break;
  }
  return undefined;
}

export function resolvePromptLibraryTemplate(
  template: PromptLibraryTemplate,
  values: Readonly<Record<string, unknown>> = {},
): PromptLibraryResolution {
  const resolvedValues: Record<string, PromptLibraryVariableValue> = {};
  const missingVariableIds: string[] = [];
  const warnings: string[] = [];
  for (const variable of template.variables) {
    const supplied = Object.prototype.hasOwnProperty.call(values, variable.name) ? values[variable.name] : variable.defaultValue;
    const issue = validatePromptValue(variable, supplied);
    if (issue !== undefined) {
      warnings.push(issue);
      if (variable.required) missingVariableIds.push(variable.id);
      continue;
    }
    if (supplied !== undefined && supplied !== null && supplied !== "") resolvedValues[variable.name] = supplied as PromptLibraryVariableValue;
  }
  const resolvedPrompt = template.body.replace(PLACEHOLDER_PATTERN, (_match, name: string) => {
    const value = resolvedValues[name];
    return value === undefined ? `{{${name}}}` : String(value);
  });
  return Object.freeze({
    templateId: template.id,
    templateVersion: template.version,
    values: Object.freeze(resolvedValues),
    resolvedPrompt,
    missingVariableIds: Object.freeze(missingVariableIds),
    warnings: Object.freeze([...new Set(warnings)]),
  });
}

export function serializePromptLibrary(library: PromptLibrary, exportedAt = new Date().toISOString()): string {
  assertIsoTimestamp(exportedAt, "prompt library export time");
  const bundle: PromptLibraryPortableBundle = { schema: PROMPT_LIBRARY_SCHEMA, exportedAt, library };
  return JSON.stringify(bundle, null, 2);
}

export function parsePromptLibraryBundle(raw: string): PromptLibrary {
  const normalized = raw.replace(/^\uFEFF/, "");
  assertDomain(new TextEncoder().encode(normalized).byteLength <= PROMPT_LIBRARY_MAX_BYTES, "invalid_argument", "Prompt library bundle exceeds the 2 MB limit.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(normalized);
  } catch {
    assertDomain(false, "invalid_argument", "Prompt library bundle is not valid JSON.");
  }
  assertDomain(typeof parsed === "object" && parsed !== null && !Array.isArray(parsed), "invalid_argument", "Prompt library bundle must be an object.");
  const bundle = parsed as { schema?: unknown; exportedAt?: unknown; library?: unknown };
  assertDomain(bundle.schema === PROMPT_LIBRARY_SCHEMA, "invalid_argument", "Unsupported prompt library schema.");
  assertDomain(typeof bundle.exportedAt === "string", "invalid_argument", "Prompt library export timestamp is required.");
  assertIsoTimestamp(bundle.exportedAt, "prompt library export time");
  assertDomain(typeof bundle.library === "object" && bundle.library !== null && !Array.isArray(bundle.library), "invalid_argument", "Prompt library payload is required.");
  const library = bundle.library as PromptLibrary;
  assertDomain(library.schemaVersion === 1 && Array.isArray(library.templates) && Array.isArray(library.folders), "invalid_argument", "Prompt library payload is malformed.");
  return createPromptLibrary(library.templates, library.folders, library.updatedAt);
}
