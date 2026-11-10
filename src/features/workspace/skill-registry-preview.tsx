import {
  AlertTriangle,
  Check,
  Clipboard,
  Database,
  Download,
  FileJson2,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { useMemo, useState } from "react";

import type { SkillView } from "./types";

export type SkillRegistryFilter = "all" | "attention" | "enabled";
export type SkillRegistryFormat = "json" | "markdown";

export interface SkillRegistrySnapshot {
  schema: "omnia.skill-registry-preview.v1";
  scope: "renderer-session";
  status: "empty" | "visible" | "attention";
  total: number;
  enabled: number;
  attention: number;
  tokenFootprint: number;
  sourceCounts: Record<SkillView["source"], number>;
  trustCounts: Record<SkillView["trust"], number>;
  scopeCounts: Record<SkillView["scope"], number>;
  permissionTypes: number;
  entries: Array<{
    id: string;
    name: string;
    version: string;
    source: SkillView["source"];
    trust: SkillView["trust"];
    scope: SkillView["scope"];
    enabled: boolean;
    tokenFootprint: number;
    permissions: string[];
  }>;
}

const emptyCounts = <T extends string>(values: readonly T[]) =>
  Object.fromEntries(values.map((value) => [value, 0])) as Record<T, number>;

export function buildSkillRegistrySnapshot(
  skills: readonly SkillView[],
  enabledIds?: ReadonlySet<string>,
): SkillRegistrySnapshot {
  const sourceCounts = emptyCounts<SkillView["source"]>(["Built in", "Local", "Imported"]);
  const trustCounts = emptyCounts<SkillView["trust"]>(["Verified", "Reviewed", "Unreviewed"]);
  const scopeCounts = emptyCounts<SkillView["scope"]>(["Global", "Project", "Manual"]);
  const permissionSet = new Set<string>();

  const entries = skills.map((skill) => {
    sourceCounts[skill.source] += 1;
    trustCounts[skill.trust] += 1;
    scopeCounts[skill.scope] += 1;
    skill.permissions.forEach((permission) => permissionSet.add(permission));
    return {
      id: skill.id,
      name: skill.name,
      version: skill.version,
      source: skill.source,
      trust: skill.trust,
      scope: skill.scope,
      enabled: enabledIds ? enabledIds.has(skill.id) : skill.enabled,
      tokenFootprint: skill.tokenFootprint,
      permissions: [...skill.permissions],
    };
  });

  const enabled = entries.filter((entry) => entry.enabled).length;
  const attention = entries.filter((entry) => entry.trust === "Unreviewed").length;
  return {
    schema: "omnia.skill-registry-preview.v1",
    scope: "renderer-session",
    status: entries.length === 0 ? "empty" : attention > 0 ? "attention" : "visible",
    total: entries.length,
    enabled,
    attention,
    tokenFootprint: entries.reduce((total, entry) => total + entry.tokenFootprint, 0),
    sourceCounts,
    trustCounts,
    scopeCounts,
    permissionTypes: permissionSet.size,
    entries,
  };
}

export function serializeSkillRegistrySnapshot(snapshot: SkillRegistrySnapshot, format: SkillRegistryFormat): string {
  const generatedAt = new Date().toISOString();
  if (format === "markdown") {
    const rows = snapshot.entries.length === 0
      ? ["_No skills are visible in this renderer session._"]
      : snapshot.entries.map((entry) =>
        `- **${entry.name}** v${entry.version} — ${entry.source} · ${entry.trust} · ${entry.scope} · ${entry.enabled ? "enabled preview" : "disabled preview"}`,
      );
    return [
      "# Omnia skill registry preview",
      "",
      "> Renderer-session snapshot. Native installation, loading, permission grants, and provider injection are not performed.",
      "",
      `- Generated: ${generatedAt}`,
      `- Entries: ${snapshot.total}`,
      `- Enabled preview: ${snapshot.enabled}`,
      `- Review attention: ${snapshot.attention}`,
      `- Token footprint: ${snapshot.tokenFootprint.toLocaleString()}`,
      `- Permission types: ${snapshot.permissionTypes}`,
      "",
      "## Entries",
      "",
      ...rows,
    ].join("\n");
  }
  return JSON.stringify({ ...snapshot, generatedAt }, null, 2);
}

function downloadSkillRegistry(payload: string, format: SkillRegistryFormat): boolean {
  if (typeof URL.createObjectURL !== "function") return false;
  const url = URL.createObjectURL(new Blob([payload], { type: format === "json" ? "application/json" : "text/markdown" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `omnia-skill-registry-renderer-preview.${format === "json" ? "json" : "md"}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  if (typeof URL.revokeObjectURL === "function") window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

function RegistryMetric({ label, value, tone = "" }: { readonly label: string; readonly value: string; readonly tone?: string }) {
  return (
    <div className={`skill-registry-preview__metric${tone ? ` skill-registry-preview__metric--${tone}` : ""}`}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

export interface SkillRegistryPreviewProps {
  readonly skills: readonly SkillView[];
  readonly enabledIds?: ReadonlySet<string>;
}

export default function SkillRegistryPreview({ skills, enabledIds }: SkillRegistryPreviewProps) {
  const [filter, setFilter] = useState<SkillRegistryFilter>("all");
  const [format, setFormat] = useState<SkillRegistryFormat>("json");
  const [status, setStatus] = useState("Snapshot reflects the current renderer session.");
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);
  const snapshot = useMemo(() => buildSkillRegistrySnapshot(skills, enabledIds), [enabledIds, skills]);
  const entries = useMemo(() => snapshot.entries.filter((entry) => {
    if (filter === "attention") return entry.trust === "Unreviewed";
    if (filter === "enabled") return entry.enabled;
    return true;
  }), [filter, snapshot.entries]);
  const payload = useMemo(() => serializeSkillRegistrySnapshot(snapshot, format), [format, snapshot]);

  const refresh = () => {
    const now = new Date();
    setRefreshedAt(now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
    setStatus("Re-read the current renderer projection; no native registry sync was requested.");
  };

  const copy = async () => {
    if (!navigator.clipboard?.writeText) {
      setStatus("Clipboard access is unavailable; no registry snapshot was copied.");
      return;
    }
    try {
      await navigator.clipboard.writeText(payload);
      setStatus(`Copied ${snapshot.total} renderer-local registry entries as ${format.toUpperCase()}.`);
    } catch {
      setStatus("Clipboard access was denied; no registry snapshot was copied.");
    }
  };

  const download = () => {
    setStatus(downloadSkillRegistry(payload, format)
      ? "Browser download started; no app-managed registry write occurred."
      : "File download is unavailable in this surface; no registry snapshot was exported.");
  };

  return (
    <section className="skill-registry-preview" aria-label="Skill registry preview">
      <header className="skill-registry-preview__header">
        <div>
          <span className="eyebrow">Catalog projection</span>
          <h3><Database size={16} /> Registry health</h3>
          <p>Inspect source coverage, trust attention, and preview activation without claiming a native registry sync.</p>
        </div>
        <span className={`skill-registry-preview__status skill-registry-preview__status--${snapshot.status}`}>
          {snapshot.status === "attention" ? <AlertTriangle size={13} /> : <ShieldCheck size={13} />}
          {snapshot.status === "empty" ? "Empty preview" : snapshot.status === "attention" ? "Review attention" : "Visible preview"}
        </span>
      </header>

      <div className="skill-registry-preview__metrics" role="status" aria-label="Skill registry summary">
        <RegistryMetric label="visible entries" value={String(snapshot.total)} />
        <RegistryMetric label="enabled preview" value={String(snapshot.enabled)} tone="teal" />
        <RegistryMetric label="review attention" value={String(snapshot.attention)} tone={snapshot.attention ? "amber" : "teal"} />
        <RegistryMetric label="permission types" value={String(snapshot.permissionTypes)} />
        <RegistryMetric label="token footprint" value={snapshot.tokenFootprint.toLocaleString()} />
      </div>

      <div className="skill-registry-preview__toolbar" role="toolbar" aria-label="Skill registry preview controls">
        <label><span>Show</span><select aria-label="Skill registry filter" value={filter} onChange={(event) => setFilter(event.target.value as SkillRegistryFilter)}><option value="all">All entries</option><option value="attention">Needs review</option><option value="enabled">Enabled preview</option></select></label>
        <label><span>Export format</span><select aria-label="Skill registry export format" value={format} onChange={(event) => setFormat(event.target.value as SkillRegistryFormat)}><option value="json">JSON</option><option value="markdown">Markdown</option></select></label>
        <span className="skill-registry-preview__toolbar-status" role="status" aria-live="polite">{status}{refreshedAt ? ` · refreshed ${refreshedAt}` : ""}</span>
        <button type="button" className="button button--ghost" onClick={refresh}><RefreshCw size={13} /> Refresh preview</button>
        <button type="button" className="button button--ghost" onClick={() => void copy()}><Clipboard size={13} /> Copy</button>
        <button type="button" className="button button--secondary" onClick={download}><Download size={13} /> Download</button>
      </div>

      <div className="skill-registry-preview__grid">
        <div className="skill-registry-preview__entries" role="list" aria-label={`${filter} skill registry entries`}>
          {entries.length === 0 ? <div className="skill-registry-preview__empty"><Database size={20} /><strong>No registry entries match</strong><span>Try another filter or add a renderer draft in Authoring Lab.</span></div> : null}
          {entries.map((entry) => (
            <article key={entry.id} className="skill-registry-preview__entry" role="listitem">
              <div className="skill-registry-preview__entry-main"><strong>{entry.name}</strong><small>{entry.id} · v{entry.version}</small></div>
              <div className="skill-registry-preview__entry-badges"><span className="skill-registry-preview__chip">{entry.source}</span><span className={`skill-registry-preview__chip skill-registry-preview__chip--${entry.trust === "Unreviewed" ? "amber" : "teal"}`}>{entry.trust}</span><span className="skill-registry-preview__chip">{entry.scope}</span></div>
              <span className={`skill-registry-preview__entry-state${entry.enabled ? " is-enabled" : ""}`}>{entry.enabled ? <Check size={12} /> : null}{entry.enabled ? "Enabled preview" : "Disabled preview"}</span>
            </article>
          ))}
        </div>

        <aside className="skill-registry-preview__snapshot" aria-label="Skill registry export preview">
          <div className="skill-registry-preview__snapshot-heading"><div><span className="eyebrow">Snapshot payload</span><strong>{snapshot.schema}</strong></div><FileJson2 size={16} /></div>
          <pre tabIndex={0} aria-label="Skill registry snapshot payload"><code>{payload}</code></pre>
        </aside>
      </div>

      <p className="skill-registry-preview__boundary"><ShieldCheck size={14} /><span>Preview only · renderer-session · no native registry read, package install, trust update, permission grant, provider injection, or durable write.</span></p>
    </section>
  );
}

