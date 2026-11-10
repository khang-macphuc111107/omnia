export const COMPOSER_DRAFT_BUNDLE_SCOPE = "omnia-renderer-draft" as const;
export const COMPOSER_DRAFT_BUNDLE_VERSION = 1 as const;

export type ComposerDraftMode = "chat" | "report" | "code-note" | "research-note";
export type ComposerDraftPortableFormat = "json" | "markdown";
export type ComposerDraftImportSource = "json" | "markdown" | "plain-markdown";

export interface ComposerDraftModeOption {
  id: ComposerDraftMode;
  label: string;
  description: string;
  template: string;
  tone: "steel" | "teal" | "amber" | "coral";
}

export const COMPOSER_DRAFT_MODES: readonly ComposerDraftModeOption[] = [
  {
    id: "chat",
    label: "Chat",
    description: "A flexible prompt or conversation draft.",
    template: "",
    tone: "steel",
  },
  {
    id: "report",
    label: "Report",
    description: "A structured brief with findings and next steps.",
    template: "# Report\n\n## Objective\n\n## Findings\n\n## Evidence\n\n## Recommendation\n",
    tone: "teal",
  },
  {
    id: "code-note",
    label: "Code note",
    description: "A compact engineering note with a reproducible plan.",
    template: "# Code note\n\n## Context\n\n## Proposed change\n\n```text\nPaste code or pseudocode here\n```\n\n## Verification\n- [ ]\n",
    tone: "amber",
  },
  {
    id: "research-note",
    label: "Research note",
    description: "A question, hypotheses, sources, and open questions.",
    template: "# Research note\n\n## Question\n\n## Hypotheses\n\n## Sources to inspect\n\n## Open questions\n",
    tone: "coral",
  },
] as const;

export interface ComposerDraftBundle {
  scope: typeof COMPOSER_DRAFT_BUNDLE_SCOPE;
  version: typeof COMPOSER_DRAFT_BUNDLE_VERSION;
  exportedAt: string;
  conversationId: string;
  mode: ComposerDraftMode;
  title: string;
  content: string;
}

export type ComposerDraftBundleResult =
  | { ok: true; bundle: ComposerDraftBundle; source: ComposerDraftImportSource }
  | { ok: false; errors: string[] };

const modeIds = new Set<ComposerDraftMode>(COMPOSER_DRAFT_MODES.map((mode) => mode.id));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoDate(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

function validateComposerDraftBundle(value: unknown): ComposerDraftBundleResult {
  if (!isRecord(value)) return { ok: false, errors: ["Draft bundle must be a JSON object."] };

  const errors: string[] = [];
  if (value.scope !== COMPOSER_DRAFT_BUNDLE_SCOPE) {
    errors.push(`Unsupported draft scope: ${String(value.scope ?? "missing")}.`);
  }
  if (value.version !== COMPOSER_DRAFT_BUNDLE_VERSION) {
    errors.push(`Unsupported draft bundle version: ${String(value.version ?? "missing")}.`);
  }
  if (typeof value.exportedAt !== "string" || !isIsoDate(value.exportedAt)) {
    errors.push("Draft bundle exportedAt must be a valid date string.");
  }
  if (typeof value.conversationId !== "string" || value.conversationId.length > 180) {
    errors.push("Draft bundle conversationId must be a short string.");
  }
  if (typeof value.mode !== "string" || !modeIds.has(value.mode as ComposerDraftMode)) {
    errors.push("Draft bundle mode is not supported.");
  }
  if (typeof value.title !== "string" || value.title.length > 180) {
    errors.push("Draft bundle title must be a short string.");
  }
  if (typeof value.content !== "string" || value.content.length > 1_000_000) {
    errors.push("Draft bundle content is missing or exceeds the renderer preview limit.");
  }
  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    source: "json",
    bundle: {
      scope: COMPOSER_DRAFT_BUNDLE_SCOPE,
      version: COMPOSER_DRAFT_BUNDLE_VERSION,
      exportedAt: value.exportedAt as string,
      conversationId: value.conversationId as string,
      mode: value.mode as ComposerDraftMode,
      title: value.title as string,
      content: value.content as string,
    },
  };
}

function createComposerDraftBundle(input: {
  conversationId: string;
  mode: ComposerDraftMode;
  title?: string;
  content: string;
  exportedAt?: string;
}): ComposerDraftBundle {
  return {
    scope: COMPOSER_DRAFT_BUNDLE_SCOPE,
    version: COMPOSER_DRAFT_BUNDLE_VERSION,
    exportedAt: input.exportedAt ?? new Date().toISOString(),
    conversationId: input.conversationId,
    mode: input.mode,
    title: input.title?.trim() || "Untitled draft",
    content: input.content,
  };
}

export function serializeComposerDraftBundle(input: {
  conversationId: string;
  mode: ComposerDraftMode;
  title?: string;
  content: string;
  exportedAt?: string;
}): string {
  return JSON.stringify(createComposerDraftBundle(input), null, 2);
}

/**
 * Produces a human-readable Markdown document with a small Omnia metadata
 * comment. The content remains ordinary Markdown when opened elsewhere, while
 * Omnia can recover the original draft intent when the comment is preserved.
 */
export function serializeComposerDraftMarkdown(input: {
  conversationId: string;
  mode: ComposerDraftMode;
  title?: string;
  content: string;
  exportedAt?: string;
}): string {
  const bundle = createComposerDraftBundle(input);
  const { content, ...metadata } = bundle;
  return `<!-- omnia-draft-meta\n${JSON.stringify(metadata, null, 2)}\n-->\n\n${content}`;
}

export function importComposerDraftBundle(raw: string): ComposerDraftBundleResult {
  if (raw.length > 2_000_000) {
    return { ok: false, errors: ["Draft bundle is larger than the 2 MB renderer preview limit."] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, errors: ["Draft bundle is not valid JSON."] };
  }

  return validateComposerDraftBundle(parsed);
}

function importComposerDraftMarkdown(raw: string): ComposerDraftBundleResult | null {
  const marker = raw.match(/^<!-- omnia-draft-meta\r?\n([\s\S]*?)\r?\n-->\r?\n(?:\r?\n)?([\s\S]*)$/);
  if (!marker) return null;

  let metadata: unknown;
  try {
    metadata = JSON.parse(marker[1]!);
  } catch {
    return { ok: false, errors: ["Portable Markdown metadata is not valid JSON."] };
  }

  const result = validateComposerDraftBundle({
    ...(isRecord(metadata) ? metadata : {}),
    content: marker[2] ?? "",
  });
  return result.ok ? { ...result, source: "markdown" } : result;
}

function markdownTitle(raw: string): string {
  const heading = raw.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/m)?.[1]?.trim();
  return heading && heading.length <= 180 ? heading : "Imported Markdown";
}

/**
 * Imports Omnia JSON bundles, Omnia portable Markdown, or a normal Markdown
 * file. A plain Markdown file intentionally receives neutral local metadata;
 * no native conversation, profile, or storage state is recovered from it.
 */
export function importComposerPortableDraft(raw: string): ComposerDraftBundleResult {
  const source = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  if (source.length > 2_000_000) {
    return { ok: false, errors: ["Portable draft is larger than the 2 MB renderer preview limit."] };
  }

  if (source.trimStart().startsWith("{")) return importComposerDraftBundle(source);

  const markdownBundle = importComposerDraftMarkdown(source);
  if (markdownBundle) return markdownBundle;

  if (source.length > 1_000_000) {
    return { ok: false, errors: ["Markdown content exceeds the 1 MB renderer preview limit."] };
  }

  return {
    ok: true,
    source: "plain-markdown",
    bundle: createComposerDraftBundle({
      conversationId: "portable-markdown",
      mode: "chat",
      title: markdownTitle(source),
      content: source,
    }),
  };
}
