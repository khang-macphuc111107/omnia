import {
  Check,
  Clipboard,
  Download,
  FileJson2,
  Filter,
  Globe2,
  LockKeyhole,
  Search,
  ShieldCheck,
  Sparkles,
  Users,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";

import {
  specialistRolePreviewCatalog,
  type SpecialistRolePreview,
} from "./specialist-catalog-preview";

export type SkillsDomainEvidenceFilter = "all" | "current" | "planned";
export type SkillsDomainFormat = "json" | "markdown";

export interface SkillsDomainPreview {
  readonly id: string;
  readonly label: string;
  readonly roleIds: readonly string[];
  readonly roleNames: readonly string[];
  readonly roleCount: number;
  readonly currentEvidenceCount: number;
  readonly plannedEvidenceCount: number;
  readonly lifecycle: "enabled" | "mixed" | "planned";
  readonly expertise: readonly string[];
}

export interface SkillsDomainCatalogSnapshot {
  readonly schema: "omnia.skill-domain-catalog-preview.v1";
  readonly scope: "renderer-session";
  readonly status: "empty" | "visible" | "attention";
  readonly domainCount: number;
  readonly roleCount: number;
  readonly currentEvidenceCount: number;
  readonly plannedEvidenceCount: number;
  readonly domains: readonly SkillsDomainPreview[];
}

function domainId(label: string): string {
  return `domain.${label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
}

/**
 * Aggregate the seeded specialist role projection into an inspectable domain
 * taxonomy. This intentionally does not resolve a runtime agent or mutate the
 * underlying catalog.
 */
export function buildSkillsDomainCatalog(
  roles: readonly SpecialistRolePreview[] = specialistRolePreviewCatalog,
): readonly SkillsDomainPreview[] {
  const groups = new Map<string, SpecialistRolePreview[]>();
  roles.forEach((role) => {
    const group = groups.get(role.category) ?? [];
    group.push(role);
    groups.set(role.category, group);
  });

  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([label, domainRoles]) => {
      const expertise = new Set<string>();
      domainRoles.forEach((role) => role.expertise.forEach((tag) => expertise.add(tag)));
      const currentEvidenceCount = domainRoles.filter((role) => role.evidence === "current").length;
      const plannedEvidenceCount = domainRoles.filter((role) => role.evidence === "planned").length;
      const enabledCount = domainRoles.filter((role) => role.lifecycle === "enabled").length;
      return Object.freeze({
        id: domainId(label),
        label,
        roleIds: Object.freeze(domainRoles.map((role) => role.id)),
        roleNames: Object.freeze(domainRoles.map((role) => role.name)),
        roleCount: domainRoles.length,
        currentEvidenceCount,
        plannedEvidenceCount,
        lifecycle: enabledCount === domainRoles.length ? "enabled" : enabledCount === 0 ? "planned" : "mixed",
        expertise: Object.freeze([...expertise].sort()),
      });
    });
}

export function buildSkillsDomainSnapshot(
  roles: readonly SpecialistRolePreview[] = specialistRolePreviewCatalog,
): SkillsDomainCatalogSnapshot {
  const domains = buildSkillsDomainCatalog(roles);
  const roleCount = domains.reduce((total, domain) => total + domain.roleCount, 0);
  const currentEvidenceCount = domains.reduce((total, domain) => total + domain.currentEvidenceCount, 0);
  const plannedEvidenceCount = domains.reduce((total, domain) => total + domain.plannedEvidenceCount, 0);
  return {
    schema: "omnia.skill-domain-catalog-preview.v1",
    scope: "renderer-session",
    status: domains.length === 0 ? "empty" : plannedEvidenceCount > 0 ? "attention" : "visible",
    domainCount: domains.length,
    roleCount,
    currentEvidenceCount,
    plannedEvidenceCount,
    domains,
  };
}

export function serializeSkillsDomainSnapshot(
  snapshot: SkillsDomainCatalogSnapshot,
  format: SkillsDomainFormat,
): string {
  const generatedAt = new Date().toISOString();
  if (format === "markdown") {
    const rows = snapshot.domains.length === 0
      ? ["_No domains are visible in this renderer session._"]
      : snapshot.domains.map((domain) =>
        `- **${domain.label}** — ${domain.roleCount} role${domain.roleCount === 1 ? "" : "s"} · ${domain.currentEvidenceCount} current evidence · ${domain.plannedEvidenceCount} planned evidence`,
      );
    return [
      "# Omnia skill domain catalog preview",
      "",
      "> Renderer-session taxonomy of seeded specialist role records. It does not resolve agents, grant authority, invoke providers, or persist catalog changes.",
      "",
      `- Generated: ${generatedAt}`,
      `- Domains: ${snapshot.domainCount}`,
      `- Roles mapped: ${snapshot.roleCount}`,
      `- Current evidence: ${snapshot.currentEvidenceCount}`,
      `- Planned evidence: ${snapshot.plannedEvidenceCount}`,
      "",
      "## Domains",
      "",
      ...rows,
    ].join("\n");
  }
  return JSON.stringify({ ...snapshot, generatedAt }, null, 2);
}

function downloadSkillsDomainSnapshot(payload: string, format: SkillsDomainFormat): boolean {
  if (typeof URL.createObjectURL !== "function") return false;
  const url = URL.createObjectURL(new Blob([payload], { type: format === "json" ? "application/json" : "text/markdown" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `omnia-skill-domain-catalog-preview.${format === "json" ? "json" : "md"}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  if (typeof URL.revokeObjectURL === "function") window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

function DomainMetric({ label, value, tone = "" }: { readonly label: string; readonly value: string; readonly tone?: string }) {
  return (
    <div className={`skills-domain-catalog__metric${tone ? ` skills-domain-catalog__metric--${tone}` : ""}`}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function evidenceLabel(domain: SkillsDomainPreview): string {
  if (domain.currentEvidenceCount > 0 && domain.plannedEvidenceCount > 0) return "Mixed evidence";
  return domain.currentEvidenceCount > 0 ? "Current" : "Planned";
}

export default function SkillsDomainCatalog() {
  const [query, setQuery] = useState("");
  const [evidence, setEvidence] = useState<SkillsDomainEvidenceFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [format, setFormat] = useState<SkillsDomainFormat>("json");
  const [exportOpen, setExportOpen] = useState(false);
  const [status, setStatus] = useState("Domain coverage is a renderer-local projection of seeded role records.");

  const snapshot = useMemo(() => buildSkillsDomainSnapshot(), []);
  const filteredDomains = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return snapshot.domains.filter((domain) => {
      const haystack = `${domain.label} ${domain.roleNames.join(" ")} ${domain.expertise.join(" ")}`.toLowerCase();
      const evidenceMatches = evidence === "all"
        || (evidence === "current" && domain.currentEvidenceCount > 0)
        || (evidence === "planned" && domain.plannedEvidenceCount > 0);
      return (!normalized || haystack.includes(normalized)) && evidenceMatches;
    });
  }, [evidence, query, snapshot.domains]);
  const selected = snapshot.domains.find((domain) => domain.id === selectedId) ?? filteredDomains[0] ?? null;
  const selectedRoles = useMemo(() => {
    if (!selected) return [];
    const roleSet = new Set(selected.roleIds);
    return specialistRolePreviewCatalog.filter((role) => roleSet.has(role.id));
  }, [selected]);
  const payload = useMemo(() => serializeSkillsDomainSnapshot(snapshot, format), [format, snapshot]);

  const resetFilters = () => {
    setQuery("");
    setEvidence("all");
    setSelectedId(null);
    setStatus("Domain filters reset; no native catalog state changed.");
  };

  const copy = async () => {
    if (!navigator.clipboard?.writeText) {
      setStatus("Clipboard access is unavailable; no domain snapshot was copied.");
      return;
    }
    try {
      await navigator.clipboard.writeText(payload);
      setStatus(`Copied ${snapshot.domainCount} renderer-local domains as ${format.toUpperCase()}.`);
    } catch {
      setStatus("Clipboard access was denied; no domain snapshot was copied.");
    }
  };

  const download = () => {
    setStatus(downloadSkillsDomainSnapshot(payload, format)
      ? "Browser download started; no app-managed catalog write occurred."
      : "File download is unavailable in this surface; no domain snapshot was exported.");
  };

  return (
    <section className="skills-domain-catalog" aria-label="Skill domain catalog">
      <header className="skills-domain-catalog__header">
        <div>
          <span className="eyebrow">Specialist taxonomy</span>
          <h3><Globe2 size={17} /> Map skill and specialist domains</h3>
          <p>Inspect which seeded role records cover each domain before any runtime resolution is considered.</p>
        </div>
        <span className={`skills-domain-catalog__status skills-domain-catalog__status--${snapshot.status}`}>
          {snapshot.status === "attention" ? <Sparkles size={13} /> : <ShieldCheck size={13} />}
          {snapshot.status === "attention" ? "Evidence attention" : snapshot.status === "empty" ? "Empty preview" : "Coverage preview"}
        </span>
      </header>

      <div className="skills-domain-catalog__metrics" role="status" aria-label="Skill domain summary">
        <DomainMetric label="domains in preview" value={String(snapshot.domainCount)} />
        <DomainMetric label="roles mapped" value={String(snapshot.roleCount)} tone="teal" />
        <DomainMetric label="current evidence" value={String(snapshot.currentEvidenceCount)} tone="teal" />
        <DomainMetric label="planned evidence" value={String(snapshot.plannedEvidenceCount)} tone={snapshot.plannedEvidenceCount ? "amber" : "teal"} />
      </div>

      <div className="skills-domain-catalog__toolbar" role="toolbar" aria-label="Skill domain catalog controls">
        <label className="skills-domain-catalog__search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search domains, roles, or expertise" aria-label="Search skill domains" />{query ? <button type="button" aria-label="Clear domain search" onClick={() => setQuery("")}><X size={13} /></button> : null}</label>
        <label><span>Evidence</span><select aria-label="Skill domain evidence" value={evidence} onChange={(event) => setEvidence(event.target.value as SkillsDomainEvidenceFilter)}><option value="all">All evidence</option><option value="current">Current</option><option value="planned">Planned</option></select></label>
        <button type="button" className="button button--ghost" onClick={resetFilters}><Filter size={14} /> Reset</button>
        <span className="skills-domain-catalog__toolbar-status" role="status" aria-live="polite">{status}</span>
      </div>

      <div className="skills-domain-catalog__body">
        <div className="skills-domain-catalog__list" role="list" aria-label="Skill domains">
          {filteredDomains.length === 0 ? <div className="skills-domain-catalog__empty"><Search size={19} /><strong>No domain entries match</strong><span>Reset filters or search another role or expertise tag.</span></div> : null}
          {filteredDomains.map((domain) => (
            <article key={domain.id} className={`skills-domain-catalog__card${domain.id === selected?.id ? " is-selected" : ""}`} role="listitem">
              <button type="button" className="skills-domain-catalog__card-button" aria-pressed={domain.id === selected?.id} onClick={() => setSelectedId(domain.id)}>
                <span className="skills-domain-catalog__card-icon" aria-hidden="true"><Globe2 size={15} /></span>
                <span className="skills-domain-catalog__card-copy"><strong>{domain.label}</strong><small>{domain.roleCount} role{domain.roleCount === 1 ? "" : "s"} · {domain.expertise.slice(0, 3).join(" · ")}</small><span><em className="skills-domain-catalog__chip">{evidenceLabel(domain)}</em><em className="skills-domain-catalog__chip">{domain.lifecycle}</em></span></span>
                <span className="skills-domain-catalog__card-count" aria-label={`${domain.roleCount} mapped roles`}><Users size={12} /> {domain.roleCount}</span>
              </button>
            </article>
          ))}
        </div>

        <aside className="skills-domain-catalog__detail" aria-label="Selected skill domain details">
          {selected ? (
            <>
              <header><div><span className="eyebrow">Selected domain</span><h4>{selected.label}</h4><code>{selected.id}</code></div><span className="skills-domain-catalog__chip skills-domain-catalog__chip--teal">{evidenceLabel(selected)}</span></header>
              <div className="skills-domain-catalog__facts"><div><span>Mapped roles</span><strong>{selected.roleCount}</strong></div><div><span>Current evidence</span><strong>{selected.currentEvidenceCount}</strong></div><div><span>Planned evidence</span><strong>{selected.plannedEvidenceCount}</strong></div></div>
              <div className="skills-domain-catalog__detail-section"><span className="eyebrow">Expertise coverage</span><div className="skills-domain-catalog__chips">{selected.expertise.map((tag) => <span key={tag} className="skills-domain-catalog__chip">{tag}</span>)}</div></div>
              <div className="skills-domain-catalog__detail-section"><span className="eyebrow">Role records</span><div className="skills-domain-catalog__roles" role="list" aria-label={`${selected.label} role records`}>{selectedRoles.map((role) => <article key={role.id} role="listitem"><span className="skills-domain-catalog__role-icon" aria-hidden="true"><Sparkles size={13} /></span><span><strong>{role.name}</strong><small>{role.id} · {role.budget}</small></span><em className={`skills-domain-catalog__chip${role.evidence === "planned" ? " skills-domain-catalog__chip--amber" : " skills-domain-catalog__chip--teal"}`}>{role.evidence}</em></article>)}</div></div>
              <p className="skills-domain-catalog__ceiling"><LockKeyhole size={13} /> Role ceilings remain bounded; a domain label never grants tools, secrets, permissions, or provider authority.</p>
            </>
          ) : <div className="skills-domain-catalog__empty"><Globe2 size={19} /><strong>Select a domain</strong><span>Its role coverage and evidence will appear here.</span></div>}
        </aside>
      </div>

      <div className="skills-domain-catalog__export-bar">
        <span><strong>{snapshot.domainCount} domains</strong><small>{status}</small></span>
        <button type="button" className="button button--secondary" onClick={() => setExportOpen((current) => !current)} aria-expanded={exportOpen} aria-controls="skills-domain-catalog-export"><FileJson2 size={13} /> {exportOpen ? "Hide export" : "Preview export"}</button>
      </div>
      {exportOpen ? <section id="skills-domain-catalog-export" className="skills-domain-catalog__export" aria-label="Skill domain catalog export preview"><header><div><span className="eyebrow">Renderer-local snapshot</span><strong>{snapshot.schema}</strong></div><span className="skills-domain-catalog__chip skills-domain-catalog__chip--teal">No native resolution</span></header><div className="skills-domain-catalog__export-toolbar"><label><span>Format</span><select aria-label="Skill domain export format" value={format} onChange={(event) => setFormat(event.target.value as SkillsDomainFormat)}><option value="json">JSON</option><option value="markdown">Markdown</option></select></label><span role="status" aria-live="polite">{status}</span><button type="button" className="button button--ghost" onClick={() => void copy()}><Clipboard size={13} /> Copy</button><button type="button" className="button button--secondary" onClick={download}><Download size={13} /> Download</button></div><pre tabIndex={0} aria-label="Skill domain catalog payload"><code>{payload}</code></pre><p className="skills-domain-catalog__boundary"><Check size={14} /> Taxonomy is preview-only and renderer-local. It does not install skills, resolve agents, grant permissions, invoke providers, or create a durable catalog revision.</p></section> : null}

      <p className="skills-domain-catalog__boundary"><ShieldCheck size={14} /> Domain coverage reflects the current seeded specialist projection. Native package loading, profile resolution, context injection, and audit receipts remain planned.</p>
    </section>
  );
}
