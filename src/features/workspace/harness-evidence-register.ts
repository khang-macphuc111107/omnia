import type { HarnessSynthesisSource } from "./harness-capability-synthesis";

/**
 * Provenance for the local source snapshots used by the renderer-only harness
 * synthesis panel. These records describe what was inspected; they do not
 * make the upstream projects runtime dependencies or grant Omnia authority.
 */
export type HarnessEvidenceStrength = "A · pinned repository" | "B · official public artifacts";

export type HarnessSourceEvidence = {
  readonly source: HarnessSynthesisSource;
  readonly repository: string;
  readonly revision: string;
  readonly revisionDate: string;
  readonly snapshotPath: string;
  readonly license: string;
  readonly strength: HarnessEvidenceStrength;
  readonly scope: string;
};

export const HARNESS_EVIDENCE_REFRESH = {
  refreshedAt: "2026-09-24",
  basis: "Local upstream snapshots inspected in the Omnia workspace",
  boundary: "Reference evidence only; no source is executed, installed, or treated as Omnia runtime authority.",
} as const;

/**
 * The revisions below are the exact local clone heads available during this
 * refresh. A clone head is intentionally labelled as a local snapshot rather
 * than being presented as the globally latest upstream release.
 */
export const HARNESS_SOURCE_EVIDENCE: readonly HarnessSourceEvidence[] = [
  {
    source: "DeepSeek Harness",
    repository: "deepseek-ai/deepseek-harness",
    revision: "477b4f420553e8a52c2fbccc464d7561b239c443",
    revisionDate: "2026-09-24",
    snapshotPath: "research/upstreams/deepseek-harness",
    license: "MIT",
    strength: "A · pinned repository",
    scope: "Open-source plugin architecture, session/event surfaces, agent coordination, extension lifecycle, approval wording, user-question waits, and profile/model-selection behavior.",
  },
  {
    source: "OpenAI Codex",
    repository: "openai/codex",
    revision: "339e981ba71b131eae3e2086a22b143f455a8cb8",
    revisionDate: "2026-09-24",
    snapshotPath: "research/upstreams/openai-codex",
    license: "Apache-2.0",
    strength: "A · pinned repository",
    scope: "Open-source CLI/app-server protocol, thread/turn/item lifecycle, tools, approvals, agent/worktree boundaries, MCP/Code Mode budgets, prompt suggestions, diagnostics, and executor capability discovery.",
  },
  {
    source: "Claude Code",
    repository: "anthropics/claude-code",
    revision: "684ffc4da0eaaddcafa61842dc719c6a8febc5c2",
    revisionDate: "2026-09-24",
    snapshotPath: "research/upstreams/claude-code-official",
    license: "Anthropic commercial terms",
    strength: "B · official public artifacts",
    scope: "Official public repository, plugins, changelog, and documentation signals, including AGENTS.md instruction loading, diff-pane lifecycle, hooks, and telemetry; proprietary runtime/desktop internals are not asserted.",
  },
] as const;

export function getHarnessSourceEvidence(source: HarnessSynthesisSource): HarnessSourceEvidence {
  // The catalog is a non-empty const registry; the non-null assertion keeps
  // `noUncheckedIndexedAccess` honest without widening the public return type
  // to `undefined`.
  return HARNESS_SOURCE_EVIDENCE.find((item) => item.source === source) ?? HARNESS_SOURCE_EVIDENCE[0]!;
}
