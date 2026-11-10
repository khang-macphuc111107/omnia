export const ARTIFACT_DOCUMENT_BUNDLE_SCOPE = "omnia-artifact-document-preview" as const;
export const ARTIFACT_DOCUMENT_BUNDLE_VERSION = 1 as const;
export const ARTIFACT_DOCUMENT_MAX_BYTES = 2_000_000;
export const ARTIFACT_DOCUMENT_MAX_CONTENT_LENGTH = 1_000_000;

export type ArtifactDocumentPortableFormat = "json" | "markdown";
export type ArtifactDocumentImportSource = "json" | "markdown" | "plain-markdown";

export interface ArtifactDocumentBundle {
  scope: typeof ARTIFACT_DOCUMENT_BUNDLE_SCOPE;
  version: typeof ARTIFACT_DOCUMENT_BUNDLE_VERSION;
  exportedAt: string;
  artifactName: string;
  projectName: string;
  revision: number;
  content: string;
}

export type ArtifactDocumentImportResult =
  | { ok: true; source: ArtifactDocumentImportSource; bundle: ArtifactDocumentBundle }
  | { ok: false; errors: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDate(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function documentTitle(source: string): string {
  const heading = source.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/m)?.[1]?.trim();
  return heading && heading.length <= 180 ? heading : "Imported document";
}

function createBundle(input: {
  artifactName: string;
  projectName: string;
  revision: number;
  content: string;
  exportedAt?: string;
}): ArtifactDocumentBundle {
  return {
    scope: ARTIFACT_DOCUMENT_BUNDLE_SCOPE,
    version: ARTIFACT_DOCUMENT_BUNDLE_VERSION,
    exportedAt: input.exportedAt ?? new Date().toISOString(),
    artifactName: input.artifactName.trim() || "Untitled artifact",
    projectName: input.projectName.trim() || "Current project",
    revision: Number.isInteger(input.revision) && input.revision > 0 ? input.revision : 1,
    content: input.content,
  };
}

function validateBundle(value: unknown): ArtifactDocumentImportResult {
  if (!isRecord(value)) return { ok: false, errors: ["Artifact document bundle must be a JSON object."] };

  const errors: string[] = [];
  if (value.scope !== ARTIFACT_DOCUMENT_BUNDLE_SCOPE) errors.push("Unsupported artifact document scope.");
  if (value.version !== ARTIFACT_DOCUMENT_BUNDLE_VERSION) errors.push("Unsupported artifact document bundle version.");
  if (typeof value.exportedAt !== "string" || !isDate(value.exportedAt)) errors.push("Bundle exportedAt must be a valid date string.");
  if (typeof value.artifactName !== "string" || value.artifactName.length === 0 || value.artifactName.length > 180) errors.push("Bundle artifactName must be a short string.");
  if (typeof value.projectName !== "string" || value.projectName.length === 0 || value.projectName.length > 180) errors.push("Bundle projectName must be a short string.");
  if (typeof value.revision !== "number" || !Number.isInteger(value.revision) || value.revision < 1) errors.push("Bundle revision must be a positive integer.");
  if (typeof value.content !== "string" || value.content.length > ARTIFACT_DOCUMENT_MAX_CONTENT_LENGTH) errors.push("Bundle content is missing or exceeds the 1 MB renderer preview limit.");
  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    source: "json",
    bundle: {
      scope: ARTIFACT_DOCUMENT_BUNDLE_SCOPE,
      version: ARTIFACT_DOCUMENT_BUNDLE_VERSION,
      exportedAt: value.exportedAt as string,
      artifactName: value.artifactName as string,
      projectName: value.projectName as string,
      revision: value.revision as number,
      content: value.content as string,
    },
  };
}

export function serializeArtifactDocumentBundle(input: {
  artifactName: string;
  projectName: string;
  revision: number;
  content: string;
  exportedAt?: string;
}): string {
  return JSON.stringify(createBundle(input), null, 2);
}

export function serializeArtifactDocumentMarkdown(input: {
  artifactName: string;
  projectName: string;
  revision: number;
  content: string;
  exportedAt?: string;
}): string {
  const bundle = createBundle(input);
  const { content, ...metadata } = bundle;
  return `<!-- omnia-artifact-document-meta\n${JSON.stringify(metadata, null, 2)}\n-->\n\n${content}`;
}

function importMarkdown(source: string): ArtifactDocumentImportResult | null {
  const marker = source.match(/^<!-- omnia-artifact-document-meta\r?\n([\s\S]*?)\r?\n-->\r?\n(?:\r?\n)?([\s\S]*)$/);
  if (!marker) return null;

  let metadata: unknown;
  try {
    metadata = JSON.parse(marker[1]!);
  } catch {
    return { ok: false, errors: ["Artifact document Markdown metadata is not valid JSON."] };
  }
  return validateBundle({ ...(isRecord(metadata) ? metadata : {}), content: marker[2] ?? "" });
}

export function importArtifactDocument(raw: string): ArtifactDocumentImportResult {
  const source = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  if (source.length > ARTIFACT_DOCUMENT_MAX_BYTES) return { ok: false, errors: ["Artifact document exceeds the 2 MB renderer preview limit."] };

  if (source.trimStart().startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch {
      return { ok: false, errors: ["Artifact document JSON is not valid."] };
    }
    return validateBundle(parsed);
  }

  const marked = importMarkdown(source);
  if (marked) return marked.ok ? { ...marked, source: "markdown" } : marked;
  if (source.length > ARTIFACT_DOCUMENT_MAX_CONTENT_LENGTH) return { ok: false, errors: ["Markdown content exceeds the 1 MB renderer preview limit."] };

  return {
    ok: true,
    source: "plain-markdown",
    bundle: createBundle({ artifactName: documentTitle(source), projectName: "Imported preview", revision: 1, content: source }),
  };
}
