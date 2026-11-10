import {
  BookOpen,
  ArrowLeftRight,
  BrainCircuit,
  Check,
  ChevronRight,
  Clipboard,
  Code2,
  Database,
  Download,
  Filter,
  FileJson2,
  FileText,
  FileDiff,
  FileCheck2,
  FlaskConical,
  Gauge,
  Globe2,
  History,
  KeyRound,
  Layers3,
  LoaderCircle,
  LockKeyhole,
  PackageOpen,
  PackageSearch,
  PlugZap,
  Plus,
  Redo2,
  RotateCcw,
  Search,
  ShieldCheck,
  Sparkles,
  Undo2,
  Wrench,
  X,
} from "lucide-react";
import {
  Suspense,
  lazy,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";

import { ProductIcon } from "@/components/product-icons";
import { LazyLoadBoundary } from "@/components/lazy-load-boundary";

import type { ActivityScreenProps } from "../activity-registry";
import { useWorkspaceStore } from "../store";
import type { SkillView } from "../types";
import { ScreenHeader } from "../screen-header";
import type { SkillDraftPreview } from "../skill-authoring-preview";
import { buildSkillCatalogComparison } from "../skill-catalog-compare";
import { SkillActivationMatrix, type ProjectSkillActivation } from "../skill-activation-matrix";
import {
  isSkillActivationReviewComplete,
  skillActivationReviewChecks,
  skillActivationReviewKey,
  type SkillActivationReviewCheckId,
} from "../skill-activation-review";

type SkillSurfaceModule<Props extends object> = {
  default: ComponentType<Props>;
};

const loadSkillAuthoring = () => import("../skill-authoring-preview");
const loadSkillRegistry = () => import("../skill-registry-preview");
const loadSkillDomains = () => import("../skills-domain-catalog");
const loadSkillPackageReview = () => import("../skill-package-review-preview");
const loadSpecialistCatalog = () => import("../specialist-catalog-preview");
const loadPluginCatalog = () => import("../plugin-catalog-preview");
const loadExtensionsHub = () => import("../extensions-mcp-hub");

function SkillSurfaceLoading({ label }: { readonly label: string }) {
  return (
    <div className="skill-studio__surface-loading settings-surface-loading" role="status" aria-live="polite">
      <span className="settings-surface-loading__dot" aria-hidden="true" />
      <span>Loading {label} preview…</span>
    </div>
  );
}

function SkillLazySurface<Props extends object>({
  label,
  load,
  props,
}: {
  readonly label: string;
  readonly load: () => Promise<SkillSurfaceModule<Props>>;
  readonly props: Props;
}) {
  const [retryKey, setRetryKey] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const Surface = useMemo(() => lazy(load), [load, retryKey]);

  if (dismissed) return null;

  return (
    <LazyLoadBoundary
      label={label}
      resetKey={`${label}:${retryKey}`}
      onDismiss={() => setDismissed(true)}
      onRetry={() => setRetryKey((value) => value + 1)}
    >
      <Suspense fallback={<SkillSurfaceLoading label={label} />}>
        <Surface {...props} />
      </Suspense>
    </LazyLoadBoundary>
  );
}

type SkillsTab = "catalog" | "installed" | "matrix" | "domains" | "specialists" | "plugins" | "extensions" | "permissions" | "loading" | "registry" | "review";
type SkillDetailTab = "overview" | "instructions" | "resources" | "permissions" | "tests" | "versions";
type SourceFilter = "all" | SkillView["source"];
type TrustFilter = "all" | SkillView["trust"];
type ScopeFilter = "all" | SkillView["scope"];
type SkillManifestFormat = "json" | "markdown";

type SkillVersionSnapshot = {
  id: string;
  label: string;
  version: string;
  name: string;
  description: string;
  source: SkillView["source"];
  trust: SkillView["trust"];
  scope: SkillView["scope"];
  tokenFootprint: number;
  permissions: string[];
};

type SkillVersionDiffRow = {
  key: string;
  label: string;
  baseline: string;
  current: string;
  changed: boolean;
};

const tabs: Array<[SkillsTab, string, typeof Layers3]> = [
  ["catalog", "Catalog", Layers3],
  ["installed", "Installed", PackageOpen],
  ["matrix", "Project matrix", Layers3],
  ["domains", "Domains", Globe2],
  ["specialists", "Specialists", BrainCircuit],
  ["plugins", "Plugins", PackageSearch],
  ["extensions", "Extensions & MCP", PlugZap],
  ["permissions", "Permissions", KeyRound],
  ["loading", "Loading", LoaderCircle],
  ["registry", "Registry", Database],
  ["review", "Package review", FileCheck2],
];

const detailTabs: Array<[SkillDetailTab, string, typeof Layers3]> = [
  ["overview", "Overview", Layers3],
  ["instructions", "Instructions", FileText],
  ["resources", "Resources", Code2],
  ["permissions", "Permissions", KeyRound],
  ["tests", "Tests", FlaskConical],
  ["versions", "Versions", History],
];

const sourceOptions: Array<SkillView["source"]> = ["Built in", "Local", "Imported"];
const trustOptions: Array<SkillView["trust"]> = ["Verified", "Reviewed", "Unreviewed"];
const scopeOptions: Array<SkillView["scope"]> = ["Global", "Project", "Manual"];

const trustTone: Record<SkillView["trust"], string> = {
  Verified: "skill-studio__chip--teal",
  Reviewed: "skill-studio__chip--blue",
  Unreviewed: "skill-studio__chip--amber",
};

function Boundary({ children }: { readonly children: ReactNode }) {
  return (
    <p className="skill-studio__boundary">
      <LockKeyhole size={14} />
      <span>{children}</span>
    </p>
  );
}

function SkillMark() {
  return (
    <span className="skill-studio__mark" aria-hidden="true">
      <ProductIcon name="skill" size={16} />
    </span>
  );
}

function Metric({ value, label, icon }: { readonly value: string; readonly label: string; readonly icon: ReactNode }) {
  return (
    <div className="skill-studio__metric">
      <span>{icon}</span>
      <strong>{value}</strong>
      <small>{label}</small>
    </div>
  );
}

function serializeSkillManifest(skills: SkillView[], enabledIds: Set<string>, format: SkillManifestFormat): string {
  const selected = skills.filter((skill) => enabledIds.has(skill.id));
  if (format === "markdown") {
    return [
      "# Omnia skill stack preview",
      "",
      "> Renderer-local manifest. Native activation and provider injection are not performed.",
      "",
      ...selected.map((skill) => `- **${skill.name}** v${skill.version} — ${skill.scope} · ${skill.trust} · ${skill.permissions.join(", ") || "no permissions listed"}`),
    ].join("\n");
  }
  return JSON.stringify({
    schema: "omnia.skill-stack-preview.v1",
    scope: "renderer-session",
    generatedAt: new Date().toISOString(),
    skills: selected.map((skill) => ({
      id: skill.id,
      name: skill.name,
      version: skill.version,
      source: skill.source,
      trust: skill.trust,
      scope: skill.scope,
      tokenFootprint: skill.tokenFootprint,
      permissions: skill.permissions,
    })),
  }, null, 2);
}

function downloadSkillManifest(payload: string, format: SkillManifestFormat): boolean {
  if (typeof URL.createObjectURL !== "function") return false;
  const url = URL.createObjectURL(new Blob([payload], { type: format === "json" ? "application/json" : "text/markdown" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `omnia-skill-stack-renderer-preview.${format === "json" ? "json" : "md"}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  if (typeof URL.revokeObjectURL === "function") window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

function buildSkillVersionSnapshots(skill: SkillView): SkillVersionSnapshot[] {
  const [major = "0"] = skill.version.split(".");
  const initialVersion = `${major}.0.0`;
  const current: SkillVersionSnapshot = {
    id: `${skill.id}:current`,
    label: "Current catalog revision",
    version: skill.version,
    name: skill.name,
    description: skill.description,
    source: skill.source,
    trust: skill.trust,
    scope: skill.scope,
    tokenFootprint: skill.tokenFootprint,
    permissions: [...skill.permissions],
  };
  if (skill.version === initialVersion) return [current];
  return [
    {
      id: `${skill.id}:initial`,
      label: "Initial package",
      version: initialVersion,
      name: skill.name,
      description: `Initial package for ${skill.name}.`,
      source: skill.source,
      trust: skill.trust,
      scope: skill.scope,
      tokenFootprint: Math.max(0, skill.tokenFootprint - 120),
      permissions: skill.permissions.slice(0, 1),
    },
    current,
  ];
}

function buildSkillVersionDiffRows(baseline: SkillVersionSnapshot, current: SkillVersionSnapshot): SkillVersionDiffRow[] {
  const values: Array<[string, string, string, string]> = [
    ["description", "Description", baseline.description, current.description],
    ["source", "Source", baseline.source, current.source],
    ["trust", "Trust", baseline.trust, current.trust],
    ["scope", "Scope", baseline.scope, current.scope],
    ["tokenFootprint", "Token footprint", `${baseline.tokenFootprint.toLocaleString()} tokens`, `${current.tokenFootprint.toLocaleString()} tokens`],
    ["permissions", "Permissions", baseline.permissions.join(", ") || "None listed", current.permissions.join(", ") || "None listed"],
  ];
  return values.map(([key, label, baselineValue, currentValue]) => ({
    key,
    label,
    baseline: baselineValue,
    current: currentValue,
    changed: baselineValue !== currentValue,
  }));
}

export default function SkillsScreen(_props: Partial<ActivityScreenProps>) {
  const skills = useWorkspaceStore((state) => state.skills);
  const projects = useWorkspaceStore((state) => state.projects);
  const activeProjectId = useWorkspaceStore((state) => state.activeProjectId);
  const [tab, setTab] = useState<SkillsTab>("catalog");
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<SourceFilter>("all");
  const [trust, setTrust] = useState<TrustFilter>("all");
  const [scope, setScope] = useState<ScopeFilter>("all");
  const [enabledOnly, setEnabledOnly] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(skills[0]?.id ?? null);
  const [detailTab, setDetailTab] = useState<SkillDetailTab>("overview");
  const [enabledIds, setEnabledIds] = useState<Set<string>>(
    () => new Set(skills.filter((skill) => skill.enabled && skill.trust !== "Unreviewed").map((skill) => skill.id)),
  );
  const [reviewedSkillIds, setReviewedSkillIds] = useState<Set<string>>(() => new Set());
  const [reviewChecksByKey, setReviewChecksByKey] = useState<Record<string, SkillActivationReviewCheckId[]>>({});
  const [reviewPanelKey, setReviewPanelKey] = useState<string | null>(null);
  const [projectActivation, setProjectActivation] = useState<ProjectSkillActivation>(() => {
    const initialProjectId = activeProjectId || projects[0]?.id || "";
    return Object.fromEntries(
      projects.map((project) => [
        project.id,
        Object.fromEntries(
          skills
            .filter((skill) => skill.scope === "Project" && skill.enabled && project.id === initialProjectId)
            .map((skill) => [skill.id, true]),
        ),
      ]),
    );
  });
  const [projectActivationHistory, setProjectActivationHistory] = useState<readonly ProjectSkillActivation[]>([]);
  const [enabledHistory, setEnabledHistory] = useState<{ past: string[][]; future: string[][] }>({ past: [], future: [] });
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimeoutRef = useRef<number | null>(null);
  const [manifestOpen, setManifestOpen] = useState(false);
  const [manifestFormat, setManifestFormat] = useState<SkillManifestFormat>("json");
  const [manifestStatus, setManifestStatus] = useState("Enabled skills are ready for a renderer-local manifest preview.");
  const [authoringOpen, setAuthoringOpen] = useState(false);
  const [authoringDraft, setAuthoringDraft] = useState<Partial<SkillDraftPreview> | null>(null);
  const [skillOverrides, setSkillOverrides] = useState<Record<string, SkillView>>({});
  const [comparisonIds, setComparisonIds] = useState<string[]>([]);

  const projectedSkills = useMemo(
    () => skills.map((skill) => skillOverrides[skill.id] ?? skill),
    [skillOverrides, skills],
  );

  const defaultEnabledIds = useMemo(
    () => new Set(projectedSkills.filter((skill) => skill.enabled && skill.trust !== "Unreviewed").map((skill) => skill.id)),
    [projectedSkills],
  );

  const activeSkills = useMemo(
    () => projectedSkills.filter((skill) => enabledIds.has(skill.id)),
    [enabledIds, projectedSkills],
  );

  const comparisonSkills = comparisonIds
    .map((id) => projectedSkills.find((skill) => skill.id === id))
    .filter((skill): skill is SkillView => Boolean(skill));
  const comparisonRows = comparisonSkills.length === 2
    ? buildSkillCatalogComparison(comparisonSkills[0]!, comparisonSkills[1]!)
    : [];

  const filteredSkills = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return projectedSkills.filter((skill) => {
      const haystack = `${skill.name} ${skill.description} ${skill.source} ${skill.scope} ${skill.permissions.join(" ")}`.toLowerCase();
      return (
        (!normalized || haystack.includes(normalized)) &&
        (source === "all" || skill.source === source) &&
        (trust === "all" || skill.trust === trust) &&
        (scope === "all" || skill.scope === scope) &&
        (!enabledOnly || enabledIds.has(skill.id))
      );
    });
  }, [enabledIds, enabledOnly, query, projectedSkills, scope, source, trust]);

  const installedSkills = useMemo(
    () => filteredSkills.filter((skill) => enabledIds.has(skill.id)),
    [enabledIds, filteredSkills],
  );

  const selected =
    filteredSkills.find((skill) => skill.id === selectedId) ??
    projectedSkills.find((skill) => skill.id === selectedId) ??
    filteredSkills[0] ??
    null;

  const selectedReviewKey = selected ? skillActivationReviewKey(selected) : "";
  const selectedReviewChecks = selected ? reviewChecksByKey[selectedReviewKey] ?? [] : [];
  const selectedReviewComplete = isSkillActivationReviewComplete(selectedReviewChecks);
  const selectedReviewed = Boolean(selected && reviewedSkillIds.has(selected.id));

  const versionSnapshots = useMemo(
    () => (selected ? buildSkillVersionSnapshots(selected) : []),
    [selected],
  );
  const [baselineVersionId, setBaselineVersionId] = useState<string | null>(null);
  const [currentVersionId, setCurrentVersionId] = useState<string | null>(null);
  const baselineVersion = versionSnapshots.find((snapshot) => snapshot.id === baselineVersionId) ?? versionSnapshots[0] ?? null;
  const currentVersion = versionSnapshots.find((snapshot) => snapshot.id === currentVersionId) ?? versionSnapshots.at(-1) ?? null;
  const versionDiffRows = baselineVersion && currentVersion
    ? buildSkillVersionDiffRows(baselineVersion, currentVersion)
    : [];
  const changedVersionFields = versionDiffRows.filter((row) => row.changed).length;

  const permissionRows = useMemo(() => {
    const counts = new Map<string, number>();
    projectedSkills.forEach((skill) => skill.permissions.forEach((permission) => counts.set(permission, (counts.get(permission) ?? 0) + 1)));
    return Array.from(counts.entries()).sort((left, right) => right[1] - left[1]);
  }, [projectedSkills]);

  const resetFilters = () => {
    setQuery("");
    setSource("all");
    setTrust("all");
    setScope("all");
    setEnabledOnly(false);
  };

  const toggleComparisonSkill = (skill: SkillView) => {
    setComparisonIds((current) => {
      if (current.includes(skill.id)) return current.filter((id) => id !== skill.id);
      if (current.length >= 2) {
        announce("Comparison holds two skills; remove one before adding another.");
        return current;
      }
      return [...current, skill.id];
    });
  };

  const openAuthoring = (draft: Partial<SkillDraftPreview> | null = null) => {
    setAuthoringDraft(draft);
    setAuthoringOpen(true);
  };

  const buildSkillDraft = (skill: SkillView): Partial<SkillDraftPreview> => ({
    id: skill.id,
    name: skill.name,
    version: skill.version,
    summary: skill.description,
    scope: skill.scope,
    trust: skill.trust,
    icon: skill.icon,
    instructions: `# ${skill.name}\n\n## Goal\n${skill.description}\n\n## Workflow\n1. Inspect the request and available context.\n2. Apply the skill guidance within the selected scope.\n3. Return an auditable result with assumptions called out.\n\n## Boundary\nKeep provider dispatch, native installation, and permission grants outside this renderer preview.`,
    permissions: skill.permissions,
    resources: ["Prompt template", "Examples and constraints"],
    tags: [skill.scope.toLowerCase(), skill.source.toLowerCase()],
    source: skill.source,
    enabled: skill.enabled,
    tokenFootprint: skill.tokenFootprint,
  });

  const stageSkillDraft = (draft: SkillDraftPreview) => {
    const projected: SkillView = {
      id: draft.id,
      name: draft.name,
      description: draft.summary,
      version: draft.version,
      icon: draft.icon,
      source: draft.source ?? "Imported",
      trust: draft.trust,
      enabled: draft.enabled ?? false,
      scope: draft.scope,
      tokenFootprint: draft.tokenFootprint ?? Math.max(0, Math.ceil(draft.instructions.length / 4)),
      permissions: [...draft.permissions],
    };
    setSkillOverrides((current) => ({ ...current, [projected.id]: projected }));
    setSelectedId(projected.id);
    setAuthoringOpen(false);
    setAuthoringDraft(null);
    announce(`${projected.name} staged in this renderer preview only; native catalog is unchanged.`);
  };

  const announce = (message: string) => {
    if (noticeTimeoutRef.current !== null && typeof window !== "undefined") {
      window.clearTimeout(noticeTimeoutRef.current);
    }
    setNotice(message);
    if (typeof window === "undefined") return;
    noticeTimeoutRef.current = window.setTimeout(() => {
      noticeTimeoutRef.current = null;
      setNotice(null);
    }, 2600);
  };

  useEffect(() => () => {
    if (noticeTimeoutRef.current !== null && typeof window !== "undefined") {
      window.clearTimeout(noticeTimeoutRef.current);
      noticeTimeoutRef.current = null;
    }
  }, []);

  const toggleSkill = (skill: SkillView) => {
    const reviewKey = skillActivationReviewKey(skill);
    const reviewApproved = reviewedSkillIds.has(skill.id) && isSkillActivationReviewComplete(reviewChecksByKey[reviewKey] ?? []);
    if (!enabledIds.has(skill.id) && skill.trust === "Unreviewed" && !reviewApproved) {
      announce(`${skill.name} needs an explicit review before it can be enabled in preview.`);
      return;
    }
    setEnabledIds((current) => {
      const next = new Set(current);
      if (next.has(skill.id)) next.delete(skill.id);
      else next.add(skill.id);
      setEnabledHistory((history) => ({ past: [...history.past, [...current]], future: [] }));
      return next;
    });
    announce(`${skill.name} changed in this renderer preview only.`);
  };

  const toggleProjectSkill = (skill: SkillView, projectId: string) => {
    if (skill.scope !== "Project") {
      announce(`${skill.name} follows its ${skill.scope.toLowerCase()} scope and cannot be overridden per project.`);
      return;
    }
    const reviewKey = skillActivationReviewKey(skill);
    const reviewApproved = reviewedSkillIds.has(skill.id) && isSkillActivationReviewComplete(reviewChecksByKey[reviewKey] ?? []);
    if (skill.trust === "Unreviewed" && !reviewApproved) {
      announce(`${skill.name} needs an explicit review before it can be enabled in preview.`);
      return;
    }
    setProjectActivationHistory((history) => [...history, projectActivation]);
    setProjectActivation((current) => {
      const projectState = current[projectId] ?? {};
      return {
        ...current,
        [projectId]: {
          ...projectState,
          [skill.id]: projectState[skill.id] !== true,
        },
      };
    });
    const projectName = projects.find((project) => project.id === projectId)?.name ?? "selected project";
    announce(`${skill.name} project activation changed for ${projectName}; renderer preview only.`);
  };

  const reviewSkill = (skill: SkillView) => {
    const reviewKey = skillActivationReviewKey(skill);
    setReviewedSkillIds((current) => {
      const next = new Set(current);
      next.add(skill.id);
      return next;
    });
    setReviewChecksByKey((current) => ({
      ...current,
      [reviewKey]: skillActivationReviewChecks.map(({ id }) => id),
    }));
    setReviewPanelKey(reviewKey);
    announce(`${skill.name} was reviewed in this renderer preview; native trust was not changed.`);
  };

  const toggleReviewCheck = (skill: SkillView, checkId: SkillActivationReviewCheckId) => {
    const reviewKey = skillActivationReviewKey(skill);
    setReviewChecksByKey((current) => {
      const existing = current[reviewKey] ?? [];
      const nextChecks = existing.includes(checkId)
        ? existing.filter((value) => value !== checkId)
        : [...existing, checkId];
      if (isSkillActivationReviewComplete(nextChecks)) {
        setReviewedSkillIds((reviewed) => new Set(reviewed).add(skill.id));
      } else {
        setReviewedSkillIds((reviewed) => {
          const next = new Set(reviewed);
          next.delete(skill.id);
          return next;
        });
      }
      return { ...current, [reviewKey]: nextChecks };
    });
  };

  const undoEnabledChange = () => {
    setEnabledHistory((history) => {
      const snapshot = history.past.at(-1);
      if (!snapshot) return history;
      setEnabledIds(new Set(snapshot));
      return { past: history.past.slice(0, -1), future: [[...enabledIds], ...history.future] };
    });
    announce("Undid the last skill activation preview change.");
  };

  const redoEnabledChange = () => {
    setEnabledHistory((history) => {
      const snapshot = history.future[0];
      if (!snapshot) return history;
      setEnabledIds(new Set(snapshot));
      return { past: [...history.past, [...enabledIds]], future: history.future.slice(1) };
    });
    announce("Reapplied the next skill activation preview change.");
  };

  const resetEnabledSkills = () => {
    setEnabledHistory((history) => ({ past: [...history.past, [...enabledIds]], future: [] }));
    setEnabledIds(new Set(defaultEnabledIds));
    announce("Skill activation preview reset to seeded defaults.");
  };

  const manifestPayload = useMemo(() => serializeSkillManifest(projectedSkills, enabledIds, manifestFormat), [enabledIds, manifestFormat, projectedSkills]);

  const copyManifest = async () => {
    if (!navigator.clipboard?.writeText) {
      setManifestStatus("Clipboard access is unavailable; no skill manifest was copied.");
      return;
    }
    try {
      await navigator.clipboard.writeText(manifestPayload);
      setManifestStatus(`Copied ${activeSkills.length} renderer-local skills as ${manifestFormat.toUpperCase()}.`);
    } catch {
      setManifestStatus("Clipboard access was denied; no skill manifest was copied.");
    }
  };

  const downloadManifest = () => {
    setManifestStatus(
      downloadSkillManifest(manifestPayload, manifestFormat)
        ? `Downloaded ${activeSkills.length} renderer-local skills. Native activation was not changed.`
        : "File download is unavailable in this surface; no skill manifest was exported.",
    );
  };

  const list = tab === "installed" ? installedSkills : filteredSkills;
  const panelId = `skill-studio-panel-${tab}`;

  const selectAdjacentTab = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? tabs.length - 1
        : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    const nextTab = tabs[nextIndex]![0];
    setTab(nextTab);
    document.getElementById(`skill-studio-tab-${nextTab}`)?.focus();
  };

  const selectAdjacentDetailTab = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? detailTabs.length - 1
        : (index + (event.key === "ArrowRight" ? 1 : -1) + detailTabs.length) % detailTabs.length;
    const nextTab = detailTabs[nextIndex]![0];
    setDetailTab(nextTab);
    document.getElementById(`skill-detail-tab-${nextTab}`)?.focus();
  };

  return (
    <div className="screen-scroll">
      <ScreenHeader
        title="Skills Studio"
        action={
          <button type="button" className="button button--primary" title="Create or import a skill in the renderer preview" onClick={() => openAuthoring()} aria-expanded={authoringOpen} aria-controls="skill-authoring-preview">
            <Plus size={16} /> Create skill
          </button>
        }
      />

      {authoringOpen ? (
        <section id="skill-authoring-preview" className="skill-studio__authoring-shell" aria-label="Skill authoring workspace">
          <div className="skill-studio__authoring-toolbar">
            <span><Sparkles size={14} /> Authoring Lab is open above the catalog</span>
            <button type="button" className="button button--ghost" onClick={() => setAuthoringOpen(false)} aria-label="Close skill authoring lab"><X size={14} /> Close</button>
          </div>
          <SkillLazySurface
            key={authoringDraft?.id ?? "new-skill-draft"}
            label="Skill authoring"
            load={loadSkillAuthoring}
            props={{
              initialDraft: authoringDraft,
              ...(authoringDraft ? { onStage: stageSkillDraft } : {}),
            }}
          />
        </section>
      ) : null}

      <section className="skill-studio" aria-label="Skills studio preview">
        <div className="skill-studio__metrics" role="status" aria-label="Skills summary">
          <Metric value={`${projectedSkills.length}`} label="catalog skills" icon={<Layers3 size={14} />} />
          <Metric value={`${activeSkills.length}`} label="preview enabled" icon={<Check size={14} />} />
          <Metric value={`${permissionRows.length}`} label="permission types" icon={<KeyRound size={14} />} />
          <Metric value={`${projectedSkills.reduce((sum, skill) => sum + skill.tokenFootprint, 0).toLocaleString()}`} label="tokens in catalog" icon={<Gauge size={14} />} />
        </div>

        <nav className="skill-studio__tabs" role="tablist" aria-label="Skills studio views">
          {tabs.map(([id, label, Icon]) => (
            <button
              key={id}
              id={`skill-studio-tab-${id}`}
              type="button"
              role="tab"
              aria-selected={tab === id}
              title={`Open Skills Studio ${label} view`}
              aria-controls={`skill-studio-panel-${id}`}
              tabIndex={tab === id ? 0 : -1}
              className={tab === id ? "active" : ""}
              onClick={() => setTab(id)}
              onKeyDown={(event) => selectAdjacentTab(event, tabs.findIndex(([tabId]) => tabId === id))}
            >
              <Icon size={14} /> {label}
            </button>
          ))}
        </nav>

        {notice ? <div className="skill-studio__notice" role="status" aria-live="polite"><Check size={14} /> {notice}</div> : null}

        <div className="skill-studio__preview-tools" role="toolbar" aria-label="Skill activation preview history">
          <span><strong>Reversible activation preview</strong><small>{enabledHistory.past.length} undo · {enabledHistory.future.length} redo</small></span>
          <button type="button" className="button button--ghost" onClick={undoEnabledChange} disabled={enabledHistory.past.length === 0} aria-label="Undo skill activation preview change" title="Undo the last renderer-local skill activation change"><Undo2 size={13} /> Undo</button>
          <button type="button" className="button button--ghost" onClick={redoEnabledChange} disabled={enabledHistory.future.length === 0} aria-label="Redo skill activation preview change" title="Redo the next renderer-local skill activation change"><Redo2 size={13} /> Redo</button>
          <button type="button" className="button button--ghost" title="Reset skill activation preview to defaults" onClick={resetEnabledSkills} aria-label="Reset skill activation preview"><RotateCcw size={13} /> Reset</button>
          <button type="button" className="button button--secondary" title={manifestOpen ? "Hide the renderer-local skill manifest" : "Preview the renderer-local skill manifest"} onClick={() => setManifestOpen((current) => !current)} aria-expanded={manifestOpen} aria-controls="skill-manifest-preview"><FileJson2 size={13} /> {manifestOpen ? "Hide manifest" : "Preview manifest"}</button>
        </div>

        {manifestOpen ? (
          <section id="skill-manifest-preview" className="skill-studio__manifest-preview" aria-label="Skill stack manifest preview">
            <header><h3 className="ws-section-label">{activeSkills.length} enabled preview skills</h3><span className="skill-studio__chip skill-studio__chip--teal">No native activation</span></header>
            <div className="skill-studio__manifest-toolbar" role="toolbar" aria-label="Skill manifest preview actions">
              <label><span>Format</span><select value={manifestFormat} onChange={(event) => setManifestFormat(event.target.value as SkillManifestFormat)} aria-label="Skill manifest format"><option value="json">JSON</option><option value="markdown">Markdown</option></select></label>
              <span className="skill-studio__manifest-status" role="status" aria-live="polite">{manifestStatus}</span>
              <button type="button" className="button button--ghost" onClick={() => void copyManifest()}><Clipboard size={14} /> Copy</button>
              <button type="button" className="button button--secondary" onClick={downloadManifest}><Download size={14} /> Download</button>
            </div>
            <pre className="skill-studio__manifest-code" tabIndex={0}><code>{manifestPayload}</code></pre>
            <Boundary>This manifest describes the current renderer selection only. It does not install, load, authorize, or inject a skill into a provider request.</Boundary>
          </section>
        ) : null}

        <div id={panelId} role="tabpanel" className="skill-studio__panel" aria-labelledby={`skill-studio-tab-${tab}`}>
          {tab === "loading" ? (
            <div className="skill-studio__loading">
              <div className="skill-studio__section-heading"><h3 className="ws-section-label">Progressive loading plan</h3><span className="skill-studio__chip skill-studio__chip--amber">Planned</span></div>
              <div className="skill-studio__loading-grid">
                {[
                  ["1", "Resolve scope", "Match global, project, or manual activation to the current chat."],
                  ["2", "Check trust", "Require review state and preserve the skill version in provenance."],
                  ["3", "Budget tokens", "Compile only the selected package within the context budget."],
                  ["4", "Request permissions", "Revalidate each capability natively before a provider call."],
                ].map(([number, title, description], index) => (
                  <article key={number} className={`skill-studio__loading-step${index === 0 ? " skill-studio__loading-step--current" : ""}`}>
                    <span>{number}</span><div><strong>{title}</strong><p>{description}</p></div><em>{index === 0 ? "Preview" : "Planned"}</em>
                  </article>
                ))}
              </div>
              <Boundary>Skill activation, context compilation, and permission enforcement are not connected to the native bridge in this preview.</Boundary>
            </div>
          ) : null}

          {tab === "matrix" ? (
            <SkillActivationMatrix
              skills={projectedSkills}
              projects={projects}
              activeProjectId={activeProjectId}
              enabledIds={enabledIds}
              reviewedSkillIds={reviewedSkillIds}
              projectActivation={projectActivation}
              selectedSkillId={selected?.id ?? null}
              onSelectSkill={(skillId) => {
                setSelectedId(skillId);
              }}
              onToggleGlobal={toggleSkill}
              onToggleProject={toggleProjectSkill}
              canUndoProject={projectActivationHistory.length > 0}
              onUndoProject={() => {
                const previous = projectActivationHistory.at(-1);
                if (!previous) return;
                setProjectActivation(previous);
                setProjectActivationHistory((history) => history.slice(0, -1));
                announce("Undid the last project activation preview change.");
              }}
              onResetProjects={() => {
                setProjectActivationHistory((history) => [...history, projectActivation]);
                setProjectActivation({});
                announce("Reset project cells in this renderer preview only.");
              }}
            />
          ) : null}

          {tab === "registry" ? (
            <SkillLazySurface
              label="Skill registry"
              load={loadSkillRegistry}
              props={{ skills: projectedSkills, enabledIds }}
            />
          ) : null}

          {tab === "review" ? (
            <SkillLazySurface
              label="Skill package review"
              load={loadSkillPackageReview}
              props={{ skills: projectedSkills, enabledIds }}
            />
          ) : null}

          {tab === "domains" ? <SkillLazySurface label="Skill domains" load={loadSkillDomains} props={{}} /> : null}

          {tab === "specialists" ? <SkillLazySurface label="Specialist catalog" load={loadSpecialistCatalog} props={{}} /> : null}

          {tab === "plugins" ? <SkillLazySurface label="Plugin catalog" load={loadPluginCatalog} props={{}} /> : null}

          {tab === "extensions" ? <SkillLazySurface label="Extensions & MCP" load={loadExtensionsHub} props={{}} /> : null}

          {tab === "permissions" ? (
            <div className="skill-studio__permissions">
              <div className="skill-studio__section-heading"><h3 className="ws-section-label">Requested permissions across the catalog</h3><ShieldCheck size={20} /></div>
              <div className="skill-studio__permission-grid">
                {permissionRows.map(([permission, count]) => (
                  <article key={permission} className="skill-studio__permission-card"><span className="skill-studio__permission-icon"><KeyRound size={15} /></span><div><strong>{permission}</strong><small>{count} skill{count === 1 ? "" : "s"} request this capability</small></div><span className="skill-studio__chip">Catalog</span></article>
                ))}
              </div>
              <div className="skill-studio__permission-footer"><Wrench size={15} /><span>Native permission prompts and audit receipts are planned. This panel only summarizes seeded metadata.</span></div>
            </div>
          ) : null}

          {tab === "catalog" || tab === "installed" ? (
            <div className="skill-studio__catalog">
              <div className="skill-studio__controls">
                <label className="skill-studio__search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search skills, scope, or permission" aria-label="Search skills" />{query ? <button type="button" aria-label="Clear search" title="Clear the skill catalog search" onClick={() => setQuery("")}><X size={13} /></button> : null}</label>
                <label><span>Source</span><select value={source} onChange={(event) => setSource(event.target.value as SourceFilter)}><option value="all">All sources</option>{sourceOptions.map((option) => <option key={option} value={option}>{option}</option>)}</select></label>
                <label><span>Trust</span><select value={trust} onChange={(event) => setTrust(event.target.value as TrustFilter)}><option value="all">All trust</option>{trustOptions.map((option) => <option key={option} value={option}>{option}</option>)}</select></label>
                <label><span>Scope</span><select value={scope} onChange={(event) => setScope(event.target.value as ScopeFilter)}><option value="all">All scopes</option>{scopeOptions.map((option) => <option key={option} value={option}>{option}</option>)}</select></label>
                <label className="skill-studio__toggle"><input type="checkbox" checked={enabledOnly} onChange={(event) => setEnabledOnly(event.target.checked)} aria-label="Show enabled skills only" /><span>Enabled only</span></label>
                <button type="button" className="button button--ghost" onClick={resetFilters}><Filter size={14} /> Reset</button>
              </div>

              <section className="skill-studio__compare" aria-label="Skill catalog comparison">
                <header className="skill-studio__compare-toolbar">
                  <span><strong><ArrowLeftRight size={14} /> Compare catalog entries</strong><small>{comparisonIds.length}/2 selected · compare metadata, permissions, and estimated context cost</small></span>
                  <div>
                    {comparisonIds.length ? <button type="button" className="button button--ghost" title="Remove all skills from the comparison preview" onClick={() => setComparisonIds([])}>Clear selection</button> : null}
                    <span className="skill-studio__chip">Preview only</span>
                  </div>
                </header>
                {comparisonSkills.length === 2 ? (
                  <div className="skill-studio__compare-results">
                    <div className="skill-studio__compare-summary" role="status" aria-live="polite">
                      <span><strong>{comparisonRows.filter((row) => row.changed).length} changed fields</strong><small>Baseline → candidate · renderer-local metadata</small></span>
                      <span className="skill-studio__compare-names"><strong>{comparisonSkills[0]!.name}</strong><ArrowLeftRight size={13} /><strong>{comparisonSkills[1]!.name}</strong></span>
                    </div>
                    <div className="skill-studio__compare-table-wrap">
                      <table className="skill-studio__compare-table">
                        <thead><tr><th scope="col">Field</th><th scope="col">Baseline · {comparisonSkills[0]!.name}</th><th scope="col">Candidate · {comparisonSkills[1]!.name}</th></tr></thead>
                        <tbody>{comparisonRows.map((row) => (
                          <tr key={row.key} className={row.changed ? "is-changed" : ""}>
                            <th scope="row"><span>{row.label}</span><em className={`skill-studio__chip${row.changed ? " skill-studio__chip--amber" : " skill-studio__chip--teal"}`}>{row.changed ? "Changed" : "Same"}</em></th>
                            <td><span>{row.baseline}</span>{row.removed?.length ? <small className="skill-studio__compare-delta">Only in baseline: {row.removed.join(", ")}</small> : null}</td>
                            <td><span>{row.candidate}</span>{row.added?.length ? <small className="skill-studio__compare-delta">Only in candidate: {row.added.join(", ")}</small> : null}{row.detail ? <small className="skill-studio__compare-delta">{row.detail}</small> : null}</td>
                          </tr>
                        ))}</tbody>
                      </table>
                    </div>
                    <Boundary>Comparison uses renderer-visible catalog metadata only. It does not execute either skill, verify package provenance, grant permissions, call a provider, or write durable history.</Boundary>
                  </div>
                ) : <p className="skill-studio__compare-empty">Choose two skills below using <strong>Add to comparison</strong>; the first selection is the baseline.</p>}
              </section>

              <div className="skill-studio__catalog-layout">
                <div className="skill-studio__list" role="list" aria-label={`${tab} skills`}>
                  {list.length === 0 ? <div className="skill-studio__empty"><PackageOpen size={22} /><strong>{tab === "installed" ? "No enabled skills match" : "No skills match"}</strong><span>Adjust the filters or reset the renderer preview.</span></div> : null}
                  {list.map((skill) => {
                    const active = enabledIds.has(skill.id);
                    return (
                      <div key={skill.id} className="skill-studio__list-item" role="listitem">
                        <button type="button" aria-pressed={skill.id === selected?.id} className={`skill-studio__card${skill.id === selected?.id ? " skill-studio__card--selected" : ""}${active ? " skill-studio__card--enabled" : ""}`} onClick={() => setSelectedId(skill.id)}>
                          <SkillMark />
                          <span className="skill-studio__card-copy"><strong>{skill.name}</strong><small>{skill.source} · v{skill.version}</small><span className="skill-studio__badges"><em className={`skill-studio__chip ${trustTone[skill.trust]}`}>{skill.trust}</em><em className="skill-studio__chip">{skill.scope}</em></span></span>
                          <span className={`skill-studio__enable-dot${active ? " is-active" : ""}`} aria-label={active ? "Enabled in preview" : "Disabled in preview"} />
                          <ChevronRight size={14} />
                        </button>
                        <button
                          type="button"
                          className={`button button--ghost skill-studio__compare-toggle${comparisonIds.includes(skill.id) ? " is-selected" : ""}`}
                          aria-pressed={comparisonIds.includes(skill.id)}
                          aria-label={`${comparisonIds.includes(skill.id) ? "Remove" : "Add"} ${skill.name} ${comparisonIds.includes(skill.id) ? "from" : "to"} comparison`}
                          title={`${comparisonIds.includes(skill.id) ? "Remove" : "Add"} ${skill.name} ${comparisonIds.includes(skill.id) ? "from" : "to"} the comparison preview`}
                          onClick={() => toggleComparisonSkill(skill)}
                        >
                          <ArrowLeftRight size={12} /> {comparisonIds.includes(skill.id) ? "In compare" : "Compare"}
                        </button>
                      </div>
                    );
                  })}
                </div>

                <aside className="skill-studio__detail" aria-label="Selected skill details">
                  {selected ? (
                    <>
                      <div className="skill-studio__detail-heading"><h3 className="ws-section-label">{selected.name}</h3><SkillMark /></div>
                      <nav className="skill-studio__detail-tabs" role="tablist" aria-label="Selected skill detail views">
                        {detailTabs.map(([id, label, Icon], index) => (
                          <button key={id} id={`skill-detail-tab-${id}`} type="button" role="tab" aria-selected={detailTab === id} aria-controls={`skill-detail-panel-${id}`} tabIndex={detailTab === id ? 0 : -1} className={detailTab === id ? "active" : ""} onClick={() => setDetailTab(id)} onKeyDown={(event) => selectAdjacentDetailTab(event, index)}>
                            <Icon size={12} /> {id === "permissions" ? "Skill permissions" : label}
                          </button>
                        ))}
                      </nav>
                      <div id={`skill-detail-panel-${detailTab}`} role="region" aria-labelledby={`skill-detail-tab-${detailTab}`} className="skill-studio__detail-panel">
                        {detailTab === "overview" ? <>
                          <p className="skill-studio__detail-description">{selected.description}</p>
                          <div className="skill-studio__detail-facts"><div><span>Source</span><strong>{selected.source}</strong></div><div><span>Trust</span><strong>{selected.trust}</strong></div><div><span>Scope</span><strong>{selected.scope}</strong></div><div><span>Footprint</span><strong>{selected.tokenFootprint.toLocaleString()} tokens</strong></div></div>
                          <div className="skill-studio__detail-section"><span className="eyebrow">Permissions</span><div className="skill-studio__permission-chips">{selected.permissions.map((permission) => <span key={permission} className="skill-studio__chip"><KeyRound size={11} /> {permission}</span>)}</div></div>
                          <div className="skill-studio__detail-section">
                            <span className="eyebrow">Quick activation</span>
                            <div className="skill-studio__detail-actions">
                              {selected.trust === "Unreviewed" && !selectedReviewed ? <button type="button" className="button button--secondary" title="Review this unreviewed skill package before enabling it in the renderer preview" onClick={() => reviewSkill(selected)}><ShieldCheck size={14} /> Review in preview</button> : null}
                              <button type="button" className="button button--ghost" title={reviewPanelKey === selectedReviewKey ? "Hide the skill activation review checklist" : "Open the skill activation review checklist"} onClick={() => setReviewPanelKey(reviewPanelKey === selectedReviewKey ? null : selectedReviewKey)} aria-expanded={reviewPanelKey === selectedReviewKey} aria-controls="skill-activation-review-panel"><FileCheck2 size={14} /> {reviewPanelKey === selectedReviewKey ? "Hide review checklist" : "Review checklist"}</button>
                              <button type="button" className={enabledIds.has(selected.id) ? "button button--secondary" : "button button--primary"} title={`${enabledIds.has(selected.id) ? "Disable" : "Enable"} ${selected.name} in this renderer preview`} onClick={() => toggleSkill(selected)}><Check size={14} /> {enabledIds.has(selected.id) ? "Disable in preview" : "Enable in preview"}</button>
                              <button type="button" className="button button--ghost" title={`Open ${selected.name} in the renderer-local authoring preview`} onClick={() => openAuthoring(buildSkillDraft(selected))}><BookOpen size={14} /> Edit in preview</button>
                            </div>
                            {selected.trust === "Unreviewed" && !selectedReviewed ? <small className="skill-studio__detail-note">Review is required before this imported or generated package can be enabled, even in preview.</small> : selectedReviewed ? <small className="skill-studio__detail-note">Reviewed in this renderer session; native trust and installation remain unchanged.</small> : null}
                            {reviewPanelKey === selectedReviewKey ? (
                              <section id="skill-activation-review-panel" className="skill-studio__activation-review" aria-label="Skill activation review checklist">
                                <header><div><span className="eyebrow">Activation review</span><strong>{selectedReviewComplete ? "Checklist complete" : "Checklist in progress"}</strong></div><span className={`skill-studio__chip ${selectedReviewComplete ? "skill-studio__chip--teal" : "skill-studio__chip--amber"}`}>{selectedReviewChecks.length}/{skillActivationReviewChecks.length} checked</span></header>
                                <p>Confirm the renderer-visible package before allowing an unreviewed skill into this session. These checks do not change native trust.</p>
                                <div className="skill-studio__activation-review-list" role="group" aria-label="Skill activation review checks">
                                  {skillActivationReviewChecks.map((check) => <label key={check.id}><input type="checkbox" checked={selectedReviewChecks.includes(check.id)} onChange={() => toggleReviewCheck(selected, check.id)} /><span><strong>{check.label}</strong><small>{check.id === "permissions" ? `${selected.permissions.length} requested permission${selected.permissions.length === 1 ? "" : "s"}` : check.id === "scope" ? `${selected.scope} · ${selected.tokenFootprint.toLocaleString()} tokens` : check.id === "identity" ? `${selected.source} · v${selected.version}` : "Instruction text stays in this renderer preview."}</small></span></label>)}
                                </div>
                                <p className="skill-studio__boundary"><LockKeyhole size={14} /><span>Renderer-local review marker for this exact package metadata. No install, permission grant, provider injection, or durable trust change is performed.</span></p>
                              </section>
                            ) : null}
                          </div>
                        </> : null}
                        {detailTab === "instructions" ? <div className="skill-studio__detail-section"><span className="eyebrow">Instruction package</span><pre className="skill-studio__instruction-preview"><code>{`# ${selected.name}\n\nGoal\n${selected.description}\n\nWorkflow\n1. Inspect the request and available context.\n2. Apply the skill guidance within the selected scope.\n3. Return an auditable result with assumptions called out.`}</code></pre><Boundary>Instruction text is a renderer preview. It is not injected into a provider request.</Boundary></div> : null}
                        {detailTab === "resources" ? <div className="skill-studio__detail-section"><span className="eyebrow">Attached resources</span><div className="skill-studio__resource-list"><div><FileText size={14} /><span><strong>Prompt template</strong><small>Renderer preview · 1 text resource</small></span><em className="skill-studio__chip">Preview</em></div><div><Code2 size={14} /><span><strong>Examples and constraints</strong><small>Resolved from seeded catalog metadata</small></span><em className="skill-studio__chip skill-studio__chip--blue">Read-only</em></div></div><Boundary>Resource loading, file reads, and project attachments are not connected to the native bridge.</Boundary></div> : null}
                        {detailTab === "permissions" ? <div className="skill-studio__detail-section"><span className="eyebrow">Requested capabilities</span><div className="skill-studio__permission-chips">{selected.permissions.length ? selected.permissions.map((permission) => <span key={permission} className="skill-studio__chip"><KeyRound size={11} /> {permission}</span>) : <span className="skill-studio__chip">No permissions listed</span>}</div><Boundary>Permission prompts and audit receipts are planned. Catalog metadata never grants authority.</Boundary></div> : null}
                        {detailTab === "tests" ? <div className="skill-studio__detail-section"><span className="eyebrow">Validation preview</span><div className="skill-studio__test-list"><div><span className="skill-studio__test-status skill-studio__test-status--pass"><Check size={12} /></span><span><strong>Manifest schema</strong><small>Passed · required fields are present</small></span><em className="skill-studio__chip skill-studio__chip--teal">Preview</em></div><div><span className="skill-studio__test-status"><FlaskConical size={12} /></span><span><strong>Provider smoke test</strong><small>Not run · native dispatch unavailable</small></span><em className="skill-studio__chip skill-studio__chip--amber">Planned</em></div></div><Boundary>These rows describe local UI checks only; they do not execute a skill or call a model.</Boundary></div> : null}
                        {detailTab === "versions" ? (
                          <div className="skill-studio__detail-section">
                            <div className="skill-studio__version-heading">
                              <div><span className="eyebrow">Version history</span><strong>Compare renderer revisions</strong></div>
                              <span className="skill-studio__chip skill-studio__chip--blue"><FileDiff size={11} /> {changedVersionFields} changed</span>
                            </div>
                            <div className="skill-studio__version-list">
                              {versionSnapshots.map((snapshot, index) => (
                                <div key={snapshot.id} className={`skill-studio__version-row${index === versionSnapshots.length - 1 ? " skill-studio__version-row--current" : ""}`}>
                                  <span>v{snapshot.version}</span>
                                  <span><strong>{snapshot.label}</strong><small>{index === versionSnapshots.length - 1 ? `${snapshot.trust} · ${snapshot.source}` : "Historical marker · seeded metadata"}</small></span>
                                  <em className={`skill-studio__chip${index === versionSnapshots.length - 1 ? " skill-studio__chip--teal" : ""}`}>{index === versionSnapshots.length - 1 ? "Selected" : "Read-only"}</em>
                                </div>
                              ))}
                            </div>
                            <div className="skill-studio__version-controls" aria-label="Skill version comparison controls">
                              <label><span>Baseline</span><select aria-label="Skill version baseline" value={baselineVersion?.id ?? ""} onChange={(event) => setBaselineVersionId(event.target.value)}>{versionSnapshots.map((snapshot) => <option key={snapshot.id} value={snapshot.id}>v{snapshot.version} · {snapshot.label}</option>)}</select></label>
                              <span className="skill-studio__version-arrow" aria-hidden="true">→</span>
                              <label><span>Current</span><select aria-label="Skill version current" value={currentVersion?.id ?? ""} onChange={(event) => setCurrentVersionId(event.target.value)}>{versionSnapshots.map((snapshot) => <option key={snapshot.id} value={snapshot.id}>v{snapshot.version} · {snapshot.label}</option>)}</select></label>
                            </div>
                            <div className="skill-studio__version-summary" role="status" aria-live="polite">
                              <FileDiff size={14} />
                              <span><strong>{changedVersionFields} changed field{changedVersionFields === 1 ? "" : "s"}</strong><small>Comparing v{baselineVersion?.version ?? "—"} with v{currentVersion?.version ?? "—"} in this renderer session.</small></span>
                            </div>
                            <div className="skill-studio__version-diff" role="list" aria-label="Skill version field differences">
                              {versionDiffRows.map((row) => (
                                <div key={row.key} className={`skill-studio__version-diff-row${row.changed ? " is-changed" : ""}`} role="listitem">
                                  <div><strong>{row.label}</strong><span className={`skill-studio__chip${row.changed ? " skill-studio__chip--amber" : " skill-studio__chip--teal"}`}>{row.changed ? "Changed" : "Same"}</span></div>
                                  <div className="skill-studio__version-values"><span><small>Baseline</small><code>{row.baseline}</code></span><span><small>Current</small><code>{row.current}</code></span></div>
                                </div>
                              ))}
                            </div>
                            <Boundary>This diff is derived from seeded renderer metadata and historical markers. It does not install, rollback, write version provenance, or authorize provider injection.</Boundary>
                          </div>
                        ) : null}
                      </div>
                      <Boundary>Toggle changes exist only in this renderer session. Native activation, version writes, and provider injection remain unavailable.</Boundary>
                    </>
                  ) : <div className="skill-studio__empty"><Layers3 size={22} /><strong>Select a skill</strong><span>Its trust, scope, and permissions will appear here.</span></div>}
                </aside>
              </div>
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}
