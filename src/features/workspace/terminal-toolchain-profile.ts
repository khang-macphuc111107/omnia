export type TerminalToolchainId = "node" | "python" | "rust" | "cpp";
export type TerminalTargetId = "dev" | "test" | "build" | "lint";
export type TerminalBuildProfile = "debug" | "release" | "research";
export type TerminalToolchainProfileExportFormat = "json" | "markdown";

export type TerminalToolchainProfile = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly toolchainId: TerminalToolchainId;
  readonly target: TerminalTargetId;
  readonly command: string;
  readonly buildProfile: TerminalBuildProfile;
  readonly sandbox: boolean;
  readonly network: boolean;
  readonly cache: boolean;
  readonly watch: boolean;
  readonly custom?: true;
};

export type TerminalToolchainProfileExport = {
  readonly current: Omit<TerminalToolchainProfile, "id" | "custom"> & { readonly source: "active-preview" };
  readonly savedProfiles: ReadonlyArray<Omit<TerminalToolchainProfile, "id"> & { readonly source: "built-in-preview" | "renderer-session" }>;
};

export type TerminalToolchainProfileImportResult = {
  readonly profiles: readonly TerminalToolchainProfile[];
  readonly warnings: readonly string[];
};

export const BUILT_IN_TERMINAL_TOOLCHAIN_PROFILES: readonly TerminalToolchainProfile[] = [
  {
    id: "terminal-node-test",
    name: "Node test loop",
    description: "Fast JavaScript or TypeScript feedback with the focused test target.",
    toolchainId: "node",
    target: "test",
    command: "npm run test -- src/main.test.ts",
    buildProfile: "debug",
    sandbox: true,
    network: false,
    cache: true,
    watch: false,
  },
  {
    id: "terminal-python-data",
    name: "Python data check",
    description: "A bounded Python test rehearsal for data and notebook-oriented work.",
    toolchainId: "python",
    target: "test",
    command: "python -m pytest",
    buildProfile: "research",
    sandbox: true,
    network: false,
    cache: true,
    watch: false,
  },
  {
    id: "terminal-rust-tauri",
    name: "Rust Tauri build",
    description: "Debug-oriented Rust/Tauri compile planning with local-only inputs.",
    toolchainId: "rust",
    target: "build",
    command: "cargo test",
    buildProfile: "debug",
    sandbox: true,
    network: false,
    cache: true,
    watch: false,
  },
  {
    id: "terminal-cpp-systems",
    name: "C++ systems release",
    description: "An optimized CMake rehearsal for systems-oriented projects.",
    toolchainId: "cpp",
    target: "build",
    command: "cmake --build build",
    buildProfile: "release",
    sandbox: true,
    network: false,
    cache: false,
    watch: false,
  },
];

type CurrentTerminalToolchainProfile = Omit<TerminalToolchainProfile, "id" | "custom">;

const TERMINAL_TOOLCHAIN_IDS: readonly TerminalToolchainId[] = ["node", "python", "rust", "cpp"];
const TERMINAL_TARGET_IDS: readonly TerminalTargetId[] = ["dev", "test", "build", "lint"];
const TERMINAL_BUILD_PROFILES: readonly TerminalBuildProfile[] = ["debug", "release", "research"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asBoundedString(value: unknown, fallback: string, maxLength = 512): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim().slice(0, maxLength) : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeImportedProfile(value: unknown, index: number): TerminalToolchainProfile | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.name !== "string" || !value.name.trim() || value.name.length > 120 ||
    typeof value.command !== "string" || !value.command.trim() || value.command.length > 512 ||
    typeof value.toolchainId !== "string" || !TERMINAL_TOOLCHAIN_IDS.includes(value.toolchainId as TerminalToolchainId) ||
    typeof value.target !== "string" || !TERMINAL_TARGET_IDS.includes(value.target as TerminalTargetId) ||
    typeof value.buildProfile !== "string" || !TERMINAL_BUILD_PROFILES.includes(value.buildProfile as TerminalBuildProfile) ||
    typeof value.sandbox !== "boolean" || typeof value.network !== "boolean" ||
    typeof value.cache !== "boolean" || typeof value.watch !== "boolean"
  ) return null;
  if (value.description !== undefined && (typeof value.description !== "string" || value.description.length > 320)) return null;
  return {
    id: `terminal-import-${index + 1}`,
    name: asBoundedString(value.name, `Imported profile ${index + 1}`, 120),
    description: asBoundedString(value.description, "Imported renderer-local toolchain profile.", 320),
    toolchainId: value.toolchainId as TerminalToolchainId,
    target: value.target as TerminalTargetId,
    command: asBoundedString(value.command, "npm run test", 512),
    buildProfile: value.buildProfile as TerminalBuildProfile,
    sandbox: asBoolean(value.sandbox, true),
    network: asBoolean(value.network, false),
    cache: asBoolean(value.cache, true),
    watch: asBoolean(value.watch, false),
    custom: true,
  };
}

/**
 * Parse a JSON profile export without trusting ids, source labels, or extra fields.
 * This is intentionally renderer-local: it never reads files itself and never
 * implies that a native compiler, shell, or durable settings store exists.
 */
export function parseTerminalToolchainProfiles(raw: string): TerminalToolchainProfileImportResult {
  const warnings: string[] = [];
  if (new TextEncoder().encode(raw).byteLength > 32 * 1024) return { profiles: [], warnings: ["Import rejected: profile JSON exceeds the 32 KB preview limit."] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { profiles: [], warnings: ["Import rejected: the file is not valid JSON."] };
  }
  if (!isRecord(parsed) || parsed.schema !== "omnia.terminal-toolchain-profile-preview.v1" || parsed.scope !== "renderer-session" || parsed.executionDisposition !== "preview-only") {
    return { profiles: [], warnings: ["Import rejected: unsupported terminal profile schema."] };
  }

  if (!Array.isArray(parsed.savedProfiles)) return { profiles: [], warnings: ["Import rejected: savedProfiles must be a JSON array."] };
  if (parsed.savedProfiles.length > 32) return { profiles: [], warnings: ["Import rejected: a maximum of 32 saved profiles is allowed per import."] };
  const savedProfiles = parsed.savedProfiles;
  const profiles = savedProfiles
    .map((value, index) => normalizeImportedProfile(value, index))
    .filter((profile): profile is TerminalToolchainProfile => profile !== null);
  if (savedProfiles.length !== profiles.length) warnings.push("Some saved profile entries were skipped because they were incomplete.");

  const current = normalizeImportedProfile(parsed.current, profiles.length);
  if (current) {
    profiles.unshift({ ...current, id: "terminal-import-current", name: `${current.name} (imported current)` });
  } else {
    warnings.push("The export did not contain an importable active preview.");
  }
  if (profiles.length === 0) warnings.push("No importable terminal profiles were found.");
  return { profiles, warnings };
}

export function serializeTerminalToolchainProfiles(
  current: CurrentTerminalToolchainProfile,
  savedProfiles: readonly TerminalToolchainProfile[],
  format: TerminalToolchainProfileExportFormat,
): string {
  const payload: TerminalToolchainProfileExport = {
    current: { ...current, source: "active-preview" },
    savedProfiles: savedProfiles.map((profile) => ({
      ...profile,
      source: profile.custom ? "renderer-session" : "built-in-preview",
    })),
  };
  const boundary = [
    "Renderer-session preview only",
    "No shell or process was started",
    "No compiler, network request, or filesystem write was performed",
    "No durable toolchain profile or run receipt was created",
  ];

  if (format === "json") {
    return JSON.stringify({
      schema: "omnia.terminal-toolchain-profile-preview.v1",
      scope: "renderer-session",
      executionDisposition: "preview-only",
      ...payload,
      boundary,
    }, null, 2);
  }

  const describe = (profile: Omit<TerminalToolchainProfile, "id"> & { readonly source: string }) => [
    `- ${profile.name} (${profile.source})`,
    `  - ${profile.toolchainId} · ${profile.target} · ${profile.buildProfile}`,
    `  - ${profile.command}`,
    `  - sandbox=${profile.sandbox}, network=${profile.network}, cache=${profile.cache}, watch=${profile.watch}`,
  ].join("\n");
  return [
    "# Omnia terminal toolchain profile preview",
    "",
    "## Active preview",
    describe(payload.current),
    "",
    "## Saved profiles",
    payload.savedProfiles.length > 0 ? payload.savedProfiles.map(describe).join("\n") : "- No saved profiles in this renderer session.",
    "",
    "## Boundary",
    ...boundary.map((entry) => `- ${entry}`),
  ].join("\n");
}
