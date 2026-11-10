export const ACADEMIC_CITATION_BUNDLE_SCOPE = "omnia-academic-citation-bundle-preview" as const;
export const ACADEMIC_CITATION_BUNDLE_VERSION = 1 as const;
export const ACADEMIC_CITATION_BUNDLE_MAX_BYTES = 512_000;
export const ACADEMIC_CITATION_BUNDLE_MAX_CITATIONS = 500;
export const ACADEMIC_CITATION_LABEL_MAX_LENGTH = 500;
export const ACADEMIC_CITATION_TEXT_MAX_LENGTH = 4_000;

export type AcademicCitationStatus = "placeholder" | "needs review" | "reviewed in session";
export type AcademicCitationBundleFormat = "json" | "markdown";
export type AcademicCitationBundleImportSource = "json" | "markdown" | "plain-markdown";

export interface AcademicCitationBundleCitation {
  id: string;
  label: string;
  status: AcademicCitationStatus;
  text: string;
}

export interface AcademicCitationBundle {
  scope: typeof ACADEMIC_CITATION_BUNDLE_SCOPE;
  version: typeof ACADEMIC_CITATION_BUNDLE_VERSION;
  exportedAt: string;
  title: string;
  citationStyle: string;
  citations: AcademicCitationBundleCitation[];
}

export type AcademicCitationBundleResult =
  | { ok: true; source: AcademicCitationBundleImportSource; bundle: AcademicCitationBundle }
  | { ok: false; errors: string[] };

const citationStatuses = new Set<AcademicCitationStatus>([
  "placeholder",
  "needs review",
  "reviewed in session",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidDate(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function normalizeId(value: unknown, index: number, used: Set<string>): string {
  const candidate = typeof value === "string" ? value.trim().slice(0, 120) : "";
  const base = candidate || `citation-${index + 1}`;
  let id = base;
  let suffix = 2;
  while (used.has(id)) id = `${base}-${suffix++}`;
  used.add(id);
  return id;
}

function createBundle(input: {
  title: string;
  citationStyle: string;
  citations: readonly AcademicCitationBundleCitation[];
  exportedAt?: string;
}): AcademicCitationBundle {
  return {
    scope: ACADEMIC_CITATION_BUNDLE_SCOPE,
    version: ACADEMIC_CITATION_BUNDLE_VERSION,
    exportedAt: input.exportedAt ?? new Date().toISOString(),
    title: input.title.trim() || "Untitled academic draft",
    citationStyle: input.citationStyle.trim() || "IEEE",
    citations: input.citations.map((citation) => ({ ...citation })),
  };
}

function validateBundle(value: unknown): AcademicCitationBundleResult {
  if (!isRecord(value)) return { ok: false, errors: ["Citation bundle must be a JSON object."] };

  const errors: string[] = [];
  if (value.scope !== ACADEMIC_CITATION_BUNDLE_SCOPE) errors.push("Unsupported academic citation bundle scope.");
  if (value.version !== ACADEMIC_CITATION_BUNDLE_VERSION) errors.push("Unsupported academic citation bundle version.");
  if (typeof value.exportedAt !== "string" || !isValidDate(value.exportedAt)) errors.push("Citation bundle exportedAt must be a valid date string.");
  if (typeof value.title !== "string" || value.title.trim().length === 0 || value.title.length > 180) errors.push("Citation bundle title must be a short string.");
  if (typeof value.citationStyle !== "string" || value.citationStyle.trim().length === 0 || value.citationStyle.length > 80) errors.push("Citation bundle citationStyle must be a short string.");
  if (!Array.isArray(value.citations)) {
    errors.push("Citation bundle citations must be an array.");
  } else if (value.citations.length > ACADEMIC_CITATION_BUNDLE_MAX_CITATIONS) {
    errors.push(`Citation bundle cannot contain more than ${ACADEMIC_CITATION_BUNDLE_MAX_CITATIONS} citations.`);
  }

  const citations: AcademicCitationBundleCitation[] = [];
  const usedIds = new Set<string>();
  if (Array.isArray(value.citations)) {
    value.citations.forEach((rawCitation, index) => {
      if (!isRecord(rawCitation)) {
        errors.push(`Citation ${index + 1} must be an object.`);
        return;
      }
      const label = typeof rawCitation.label === "string" ? rawCitation.label.trim() : "";
      const text = typeof rawCitation.text === "string" ? rawCitation.text.trim() : "";
      const status = rawCitation.status;
      if (!label || label.length > ACADEMIC_CITATION_LABEL_MAX_LENGTH) errors.push(`Citation ${index + 1} label is missing or too long.`);
      if (!text || text.length > ACADEMIC_CITATION_TEXT_MAX_LENGTH) errors.push(`Citation ${index + 1} text is missing or too long.`);
      if (typeof status !== "string" || !citationStatuses.has(status as AcademicCitationStatus)) errors.push(`Citation ${index + 1} status is not supported.`);
      if (!label || !text || typeof status !== "string" || !citationStatuses.has(status as AcademicCitationStatus)) return;
      citations.push({
        id: normalizeId(rawCitation.id, index, usedIds),
        label,
        text,
        status: status as AcademicCitationStatus,
      });
    });
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    source: "json",
    bundle: {
      scope: ACADEMIC_CITATION_BUNDLE_SCOPE,
      version: ACADEMIC_CITATION_BUNDLE_VERSION,
      exportedAt: value.exportedAt as string,
      title: (value.title as string).trim(),
      citationStyle: (value.citationStyle as string).trim(),
      citations,
    },
  };
}

export function serializeAcademicCitationBundle(input: {
  title: string;
  citationStyle: string;
  citations: readonly AcademicCitationBundleCitation[];
  exportedAt?: string;
}): string {
  return JSON.stringify(createBundle(input), null, 2);
}

export function serializeAcademicCitationMarkdown(input: {
  title: string;
  citationStyle: string;
  citations: readonly AcademicCitationBundleCitation[];
  exportedAt?: string;
}): string {
  const bundle = createBundle(input);
  const citationLines = bundle.citations.length === 0
    ? "- No citation entries yet."
    : bundle.citations.map((citation) => `- ${citation.label} — ${citation.status}: ${citation.text}`).join("\n");
  return `<!-- omnia-academic-citation-bundle-meta\n${JSON.stringify(bundle, null, 2)}\n-->\n\n# ${bundle.title}\n\n- Citation style: ${bundle.citationStyle}\n\n## Citation review queue\n\n${citationLines}\n\n> Renderer-local citation bundle. Sources require human verification.\n`;
}

function importMarkedMarkdown(source: string): AcademicCitationBundleResult | null {
  const marker = source.match(/^<!-- omnia-academic-citation-bundle-meta\r?\n([\s\S]*?)\r?\n-->\r?\n(?:\r?\n)?[\s\S]*$/);
  if (!marker) return null;
  let metadata: unknown;
  try {
    metadata = JSON.parse(marker[1]!);
  } catch {
    return { ok: false, errors: ["Citation bundle Markdown metadata is not valid JSON."] };
  }
  const result = validateBundle(metadata);
  return result.ok ? { ...result, source: "markdown" } : result;
}

function importPlainMarkdown(source: string): AcademicCitationBundleResult {
  const lines = source.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^[-*]\s+/.test(line));
  const citations = lines.map((line, index) => ({
    id: `citation-${index + 1}`,
    label: `[${index + 1}] Imported Markdown entry`,
    status: "placeholder" as AcademicCitationStatus,
    text: line.replace(/^[-*]\s+/, "").trim(),
  })).filter((citation) => citation.text.length > 0);
  if (citations.length === 0) return { ok: false, errors: ["No citation list entries were found in the Markdown preview."] };
  return {
    ok: true,
    source: "plain-markdown",
    bundle: createBundle({ title: "Imported citation bundle", citationStyle: "IEEE", citations }),
  };
}

export function importAcademicCitationBundle(raw: string): AcademicCitationBundleResult {
  const source = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  if (source.length > ACADEMIC_CITATION_BUNDLE_MAX_BYTES) return { ok: false, errors: [`Citation bundle exceeds the ${Math.round(ACADEMIC_CITATION_BUNDLE_MAX_BYTES / 1000)} KB renderer preview limit.`] };
  if (source.trimStart().startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch {
      return { ok: false, errors: ["Citation bundle JSON is not valid."] };
    }
    return validateBundle(parsed);
  }
  return importMarkedMarkdown(source) ?? importPlainMarkdown(source);
}
