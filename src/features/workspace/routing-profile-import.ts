export const ROUTING_PROFILE_PREVIEW_SCHEMA = "omnia.routing-profile-preview.v1" as const;
export const MAX_ROUTING_PROFILE_IMPORT_BYTES = 64 * 1024;
export const MAX_IMPORTED_ROUTING_PROFILES = 24;

export type ImportedRoutingProfile = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly preference: "auto" | "quality" | "balanced" | "local";
  readonly consent: "never" | "same-connection" | "approved-connections";
  readonly modelProfileId: string;
  readonly custom: true;
};

export type RoutingProfileImportResult =
  | { readonly ok: true; readonly profiles: ImportedRoutingProfile[] }
  | { readonly ok: false; readonly reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPreference(value: unknown): value is ImportedRoutingProfile["preference"] {
  return value === "auto" || value === "quality" || value === "balanced" || value === "local";
}

function isConsent(value: unknown): value is ImportedRoutingProfile["consent"] {
  return value === "never" || value === "same-connection" || value === "approved-connections";
}

export function parseRoutingProfilePreviewImport(text: string): RoutingProfileImportResult {
  if (new TextEncoder().encode(text).byteLength > MAX_ROUTING_PROFILE_IMPORT_BYTES) {
    return { ok: false, reason: `Import is larger than ${MAX_ROUTING_PROFILE_IMPORT_BYTES / 1024} KB.` };
  }

  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    return { ok: false, reason: "Import must be valid JSON." };
  }

  if (!isRecord(input) || input.schema !== ROUTING_PROFILE_PREVIEW_SCHEMA || !Array.isArray(input.savedProfiles)) {
    return { ok: false, reason: "This is not a supported Omnia routing profile preview bundle." };
  }
  if (input.scope !== "renderer-session" || input.executionDisposition !== "preview-only") {
    return { ok: false, reason: "The bundle must declare renderer-session and preview-only scope." };
  }
  if (input.savedProfiles.length === 0 || input.savedProfiles.length > MAX_IMPORTED_ROUTING_PROFILES) {
    return { ok: false, reason: `Choose between 1 and ${MAX_IMPORTED_ROUTING_PROFILES} routing profiles.` };
  }

  const profiles: ImportedRoutingProfile[] = [];
  const names = new Set<string>();
  for (const [index, candidate] of input.savedProfiles.entries()) {
    if (!isRecord(candidate)
      || typeof candidate.name !== "string"
      || !candidate.name.trim()
      || candidate.name.trim().length > 80
      || !isPreference(candidate.preference)
      || !isConsent(candidate.fallbackConsent)
      || typeof candidate.modelProfileId !== "string"
      || candidate.modelProfileId.length > 160) {
      return { ok: false, reason: `Routing profile ${index + 1} has invalid or missing fields.` };
    }
    const name = candidate.name.trim();
    const normalizedName = name.toLocaleLowerCase();
    if (names.has(normalizedName)) {
      return { ok: false, reason: `The import contains duplicate profile name “${name}”.` };
    }
    names.add(normalizedName);
    const description = typeof candidate.description === "string" && candidate.description.trim()
      ? candidate.description.trim().slice(0, 240)
      : "Imported renderer-local routing preview.";
    profiles.push({
      id: `routing-import-${index}-${normalizedName.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "profile"}`,
      name,
      description,
      preference: candidate.preference,
      consent: candidate.fallbackConsent,
      modelProfileId: candidate.modelProfileId,
      custom: true,
    });
  }

  return { ok: true, profiles };
}
