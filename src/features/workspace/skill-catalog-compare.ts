import type { SkillView } from "./types";

export interface SkillCatalogComparisonRow {
  readonly key: "version" | "description" | "source" | "trust" | "scope" | "permissions" | "tokenFootprint";
  readonly label: string;
  readonly baseline: string;
  readonly candidate: string;
  readonly changed: boolean;
  readonly added?: readonly string[];
  readonly removed?: readonly string[];
  readonly detail?: string;
}

function permissionDelta(baseline: readonly string[], candidate: readonly string[]) {
  const left = new Set(baseline);
  const right = new Set(candidate);
  return {
    added: [...right].filter((permission) => !left.has(permission)).sort((a, b) => a.localeCompare(b)),
    removed: [...left].filter((permission) => !right.has(permission)).sort((a, b) => a.localeCompare(b)),
  };
}

export function buildSkillCatalogComparison(
  baseline: SkillView,
  candidate: SkillView,
): SkillCatalogComparisonRow[] {
  const permissions = permissionDelta(baseline.permissions, candidate.permissions);
  const baselineTokens = Math.max(0, baseline.tokenFootprint);
  const candidateTokens = Math.max(0, candidate.tokenFootprint);
  const tokenDelta = candidateTokens - baselineTokens;
  const tokenDetail = tokenDelta === 0
    ? "Same estimated footprint"
    : `${Math.abs(tokenDelta).toLocaleString()} ${tokenDelta > 0 ? "more" : "fewer"} estimated tokens in candidate`;

  const rows: Omit<SkillCatalogComparisonRow, "changed">[] = [
    { key: "version", label: "Version", baseline: baseline.version, candidate: candidate.version },
    { key: "description", label: "Description", baseline: baseline.description, candidate: candidate.description },
    { key: "source", label: "Source", baseline: baseline.source, candidate: candidate.source },
    { key: "trust", label: "Trust", baseline: baseline.trust, candidate: candidate.trust },
    { key: "scope", label: "Scope", baseline: baseline.scope, candidate: candidate.scope },
    {
      key: "permissions",
      label: "Requested permissions",
      baseline: [...new Set(baseline.permissions)].sort((a, b) => a.localeCompare(b)).join(", ") || "None listed",
      candidate: [...new Set(candidate.permissions)].sort((a, b) => a.localeCompare(b)).join(", ") || "None listed",
      ...permissions,
    },
    {
      key: "tokenFootprint",
      label: "Token footprint",
      baseline: `${baselineTokens.toLocaleString()} tokens`,
      candidate: `${candidateTokens.toLocaleString()} tokens`,
      detail: tokenDetail,
    },
  ];

  return rows.map((row) => ({
    ...row,
    changed: row.baseline !== row.candidate,
  }));
}
