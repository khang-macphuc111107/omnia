import type { SkillPackageReview } from "./skill-package-review-contract";

export type SkillPackageDiffCategory = "identity" | "release" | "metadata" | "capability" | "content";
export type SkillPackageDiffStatus = "new" | "added" | "removed" | "changed" | "same" | "unavailable";

export interface SkillPackageDiffRow {
  readonly id: string;
  readonly category: SkillPackageDiffCategory;
  readonly label: string;
  readonly baseline: string;
  readonly candidate: string;
  readonly status: SkillPackageDiffStatus;
  readonly added: readonly string[];
  readonly removed: readonly string[];
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function fieldRow(
  id: string,
  category: SkillPackageDiffCategory,
  label: string,
  baseline: string | null,
  candidate: string,
): SkillPackageDiffRow {
  const status: SkillPackageDiffStatus = baseline === null ? "new" : baseline === candidate ? "same" : "changed";
  return { id, category, label, baseline: baseline ?? "Not installed", candidate, status, added: [], removed: [] };
}

function listRow(
  id: string,
  category: "metadata" | "capability",
  label: string,
  baseline: readonly string[] | null | undefined,
  candidate: readonly string[],
): SkillPackageDiffRow {
  const before = baseline == null ? [] : sortedUnique(baseline);
  const after = sortedUnique(candidate);
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  const added = after.filter((value) => !beforeSet.has(value));
  const removed = before.filter((value) => !afterSet.has(value));
  const status: SkillPackageDiffStatus = baseline === undefined
    ? "unavailable"
    : baseline === null
      ? "new"
    : added.length === 0 && removed.length === 0
      ? "same"
      : added.length > 0 && removed.length === 0
        ? "added"
        : removed.length > 0 && added.length === 0
          ? "removed"
          : "changed";
  return {
    id,
    category,
    label,
    baseline: baseline === undefined
      ? "Unavailable — this field is not included in the installed renderer projection"
      : baseline === null
        ? "Not installed"
        : before.join(", ") || "None",
    candidate: after.join(", ") || "None",
    status,
    added,
    removed,
  };
}

/**
 * Builds a display-only field diff. Installed instructions are intentionally
 * unavailable because SkillView does not contain package-body provenance.
 */
export function buildSkillPackageDiff(review: SkillPackageReview): SkillPackageDiffRow[] {
  const incoming = review.package;
  if (!incoming) return [];
  const baseline = review.existing;
  return [
    fieldRow("name", "identity", "Name", baseline?.name ?? null, incoming.name),
    fieldRow("version", "release", "Version", baseline?.version ?? null, incoming.version),
    fieldRow("summary", "metadata", "Summary", baseline?.description ?? null, incoming.summary),
    fieldRow("scope", "metadata", "Declared scope", baseline?.scope ?? null, incoming.declaredScope),
    fieldRow("trust", "metadata", "Declared trust", baseline?.trust ?? null, incoming.declaredTrust),
    listRow("permissions", "capability", "Requested permissions", baseline?.permissions ?? null, incoming.permissions),
     // SkillView does not carry installed resource/tag inventories. Treat
     // those fields as a first-seen candidate list rather than claiming that
     // a native baseline was observed; the body itself remains unavailable.
     listRow("resources", "metadata", "Resources", null, incoming.resources),
     listRow("tags", "metadata", "Tags", null, incoming.tags),
    {
      id: "instructions",
      category: "content",
      label: "Instructions body",
      baseline: baseline ? "Unavailable — installed package body is not in this renderer projection" : "No installed body baseline",
      candidate: `${incoming.instructions.length.toLocaleString()} incoming characters · body diff unavailable`,
      status: "unavailable",
      added: [],
      removed: [],
    },
  ];
}

export function serializeSkillPackageDiff(
  rows: readonly SkillPackageDiffRow[],
  format: "json" | "markdown",
): string {
  if (format === "markdown") {
    const statusLabel = (row: SkillPackageDiffRow) => row.status === "unavailable" ? "unavailable" : row.status;
    return [
      "# Omnia skill package diff",
      "",
      "> Renderer-local comparison only. It does not install, activate, authorize, or persist a package.",
      "",
      ...rows.map((row) => `- **${row.label}** (${statusLabel(row)}): ${row.baseline} → ${row.candidate}`),
    ].join("\n");
  }
  return JSON.stringify({
    schema: "omnia.skill-package-diff-preview.v1",
    scope: "renderer-session",
    packageBodyComparison: "unavailable",
    rows,
  }, null, 2);
}
