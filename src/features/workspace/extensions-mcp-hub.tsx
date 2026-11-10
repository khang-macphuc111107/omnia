import {
  Activity,
  AlertTriangle,
  BadgeCheck,
  Blocks,
  Check,
  Clipboard,
  Cloud,
  Code2,
  Download,
  FileJson2,
  FlaskConical,
  KeyRound,
  LockKeyhole,
  Network,
  PackageCheck,
  PlugZap,
  RefreshCw,
  RotateCcw,
  Search,
  ServerCog,
  ShieldAlert,
  ShieldCheck,
  TerminalSquare,
  Undo2,
  Redo2,
  Upload,
  X,
  type LucideIcon,
} from "lucide-react";
import { useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";

import {
  buildExtensionPermissionReviewItems,
  classifyExtensionPermissionRisk,
  defaultExtensionPermissionReview,
  normalizeExtensionPermissionReview,
  serializeExtensionPermissionReview,
  type ExtensionPermissionExpiry,
  type ExtensionPermissionReviewDraft,
  type ExtensionPermissionRisk,
  type ExtensionPermissionScope,
} from "./extensions-mcp-permission-review-contract";

type ExtensionKind = "MCP server" | "Plugin" | "LSP server" | "Formatter" | "Connector";
type ExtensionLifecycle = "Discovered" | "Installed" | "Trusted" | "Enabled" | "Blocked";
type ExtensionTrust = "Verified" | "Reviewed" | "Unreviewed";
type ExtensionTransport = "stdio" | "SSE" | "HTTPS";
type GrantMode = "Allow" | "Ask every time" | "Deny";
type GrantPreset = "custom" | "deny-all" | "ask-all" | "read-only";
type HubView = "catalog" | "inspector" | "grants" | "review" | "lifecycle";
type ManifestFormat = "json" | "markdown";

export interface ExtensionRecord {
  readonly id: string;
  readonly name: string;
  readonly kind: ExtensionKind;
  readonly source: string;
  readonly version: string;
  readonly summary: string;
  readonly transport: ExtensionTransport;
  readonly endpoint: string;
  readonly trust: ExtensionTrust;
  readonly lifecycle: ExtensionLifecycle;
  readonly capabilities: readonly string[];
  readonly effects: readonly string[];
  readonly tools: readonly string[];
  readonly resources: number;
  readonly prompts: number;
  readonly schemaDigest: string;
  readonly dependencies: readonly string[];
  readonly updateAvailable: boolean;
}

interface HubSnapshot {
  readonly records: ExtensionRecord[];
  readonly grants: Record<string, GrantMode>;
  readonly permissionReviews?: Record<string, ExtensionPermissionReviewDraft>;
}

interface HubHistory {
  readonly past: HubSnapshot[];
  readonly future: HubSnapshot[];
}

const MAX_MANIFEST_BYTES = 512 * 1024;

export const EXTENSION_SEED: readonly ExtensionRecord[] = [
  {
    id: "mcp-files-readonly",
    name: "Workspace Files (read-only)",
    kind: "MCP server",
    source: "Omnia catalog",
    version: "0.4.2",
    summary: "Inspect bounded workspace files and symbols without granting mutation.",
    transport: "stdio",
    endpoint: "stdio://omnia.workspace.files",
    trust: "Verified",
    lifecycle: "Enabled",
    capabilities: ["workspace.read", "artifact.inspect"],
    effects: ["Reads selected files", "Returns structured symbols"],
    tools: ["list_files", "read_text", "find_symbol"],
    resources: 2,
    prompts: 1,
    schemaDigest: "sha256:7b2c…0e91",
    dependencies: [],
    updateAvailable: false,
  },
  {
    id: "mcp-research-sources",
    name: "Research Sources",
    kind: "MCP server",
    source: "Imported manifest",
    version: "1.8.0",
    summary: "Expose citation-shaped source records for research workbench previews.",
    transport: "SSE",
    endpoint: "https://preview.invalid/mcp/research",
    trust: "Reviewed",
    lifecycle: "Trusted",
    capabilities: ["network.read", "citation.create"],
    effects: ["Contacts a declared endpoint", "Returns untrusted source text"],
    tools: ["search_sources", "open_source", "extract_claims"],
    resources: 8,
    prompts: 2,
    schemaDigest: "sha256:4e18…a611",
    dependencies: ["network policy"],
    updateAvailable: true,
  },
  {
    id: "plugin-git-insights",
    name: "Git Insights",
    kind: "Plugin",
    source: "Local package proposal",
    version: "0.9.1",
    summary: "Summarize branch and diff metadata while keeping writes disabled.",
    transport: "stdio",
    endpoint: "plugin://omnia.git-insights",
    trust: "Reviewed",
    lifecycle: "Installed",
    capabilities: ["workspace.read", "git.inspect"],
    effects: ["Reads repository metadata", "May observe branch names"],
    tools: ["status", "diff_summary", "branch_graph"],
    resources: 1,
    prompts: 0,
    schemaDigest: "sha256:9ac0…b1d3",
    dependencies: ["git executable"],
    updateAvailable: false,
  },
  {
    id: "lsp-typescript",
    name: "TypeScript Language Service",
    kind: "LSP server",
    source: "Workspace proposal",
    version: "5.8.2",
    summary: "Offer diagnostics and symbol navigation after an explicit workspace grant.",
    transport: "stdio",
    endpoint: "lsp://typescript",
    trust: "Unreviewed",
    lifecycle: "Discovered",
    capabilities: ["workspace.read", "process.child"],
    effects: ["Starts a long-lived process", "Reads source buffers"],
    tools: ["diagnostics", "definition", "references"],
    resources: 0,
    prompts: 0,
    schemaDigest: "sha256:pending",
    dependencies: ["node runtime", "workspace grant"],
    updateAvailable: false,
  },
  {
    id: "formatter-markdown",
    name: "Markdown Formatter",
    kind: "Formatter",
    source: "Repository proposal",
    version: "2.1.0",
    summary: "Suggest formatting changes; mutation remains disabled until a future receipt path exists.",
    transport: "stdio",
    endpoint: "formatter://markdown",
    trust: "Unreviewed",
    lifecycle: "Blocked",
    capabilities: ["workspace.read", "workspace.write"],
    effects: ["Can propose file patches", "Would mutate files when enabled"],
    tools: ["check", "format"],
    resources: 0,
    prompts: 0,
    schemaDigest: "sha256:blocked",
    dependencies: ["formatter binary"],
    updateAvailable: true,
  },
  {
    id: "connector-browser-session",
    name: "Browser Session Bridge",
    kind: "Connector",
    source: "Future connector catalog",
    version: "0.2.0",
    summary: "Reserved for an explicit browser attachment with tab-scoped authority.",
    transport: "HTTPS",
    endpoint: "connector://browser-session",
    trust: "Unreviewed",
    lifecycle: "Discovered",
    capabilities: ["browser.tab.read", "network.read"],
    effects: ["Could observe a selected tab", "Requires explicit attach and expiry"],
    tools: ["inspect_tab", "capture_text"],
    resources: 0,
    prompts: 0,
    schemaDigest: "sha256:future",
    dependencies: ["browser broker"],
    updateAvailable: false,
  },
];

const KIND_OPTIONS: readonly ExtensionKind[] = ["MCP server", "Plugin", "LSP server", "Formatter", "Connector"];
const LIFECYCLE_OPTIONS: readonly ExtensionLifecycle[] = ["Discovered", "Installed", "Trusted", "Enabled", "Blocked"];
const GRANT_ORDER: readonly GrantMode[] = ["Deny", "Ask every time", "Allow"];
const GRANT_PRESETS: readonly { id: Exclude<GrantPreset, "custom">; label: string; description: string }[] = [
  { id: "deny-all", label: "Deny all", description: "Fail closed until each capability is reviewed." },
  { id: "ask-all", label: "Ask every time", description: "Keep every operation behind an explicit prompt." },
  { id: "read-only", label: "Read-only safe", description: "Allow read/inspect capabilities; deny mutation and process effects." },
];

const kindIcons: Record<ExtensionKind, LucideIcon> = {
  "MCP server": ServerCog,
  Plugin: PlugZap,
  "LSP server": Code2,
  Formatter: Blocks,
  Connector: Network,
};

const lifecycleTone: Record<ExtensionLifecycle, string> = {
  Discovered: "extensions-hub__chip extensions-hub__chip--blue",
  Installed: "extensions-hub__chip extensions-hub__chip--teal",
  Trusted: "extensions-hub__chip extensions-hub__chip--amber",
  Enabled: "extensions-hub__chip extensions-hub__chip--green",
  Blocked: "extensions-hub__chip extensions-hub__chip--red",
};

const permissionRiskTone: Record<ExtensionPermissionRisk, string> = {
  low: "extensions-hub__chip extensions-hub__chip--green",
  medium: "extensions-hub__chip extensions-hub__chip--blue",
  high: "extensions-hub__chip extensions-hub__chip--amber",
  critical: "extensions-hub__chip extensions-hub__chip--red",
};

const permissionScopeLabel: Record<ExtensionPermissionScope, string> = {
  operation: "Single operation",
  conversation: "Current conversation",
  project: "Current project",
  workspace: "Workspace",
};

const permissionExpiryLabel: Record<ExtensionPermissionExpiry, string> = {
  operation: "Until operation ends",
  session: "Current session",
  project: "Until project changes",
  manual: "Until manually revoked",
};

function cloneSnapshot(snapshot: HubSnapshot): HubSnapshot {
  return {
    records: snapshot.records.map((record) => ({ ...record, capabilities: [...record.capabilities], effects: [...record.effects], tools: [...record.tools], dependencies: [...record.dependencies] })),
    grants: { ...snapshot.grants },
    permissionReviews: Object.fromEntries(Object.entries(snapshot.permissionReviews ?? {}).map(([key, review]) => [key, { ...review }])),
  };
}

function createInitialSnapshot(): HubSnapshot {
  return {
    records: EXTENSION_SEED.map((record) => ({ ...record, capabilities: [...record.capabilities], effects: [...record.effects], tools: [...record.tools], dependencies: [...record.dependencies] })),
    grants: Object.fromEntries(EXTENSION_SEED.flatMap((record) => record.capabilities.map((capability) => [`${record.id}:${capability}`, capability.includes("write") ? "Deny" : "Ask every time"]))) as Record<string, GrantMode>,
    permissionReviews: {},
  };
}

export function serializeExtensionManifest(snapshot: HubSnapshot, format: ManifestFormat): string {
  const payload = {
    schema: "omnia.extensions-mcp-hub-preview.v1",
    scope: "renderer-session",
    generatedAt: new Date().toISOString(),
    extensions: snapshot.records.map((record) => ({
      id: record.id,
      name: record.name,
      kind: record.kind,
      source: record.source,
      version: record.version,
      lifecycle: record.lifecycle,
      trust: record.trust,
      transport: record.transport,
      endpoint: record.endpoint,
      summary: record.summary,
      tools: record.tools,
      resources: record.resources,
      prompts: record.prompts,
      dependencies: record.dependencies,
      updateAvailable: record.updateAvailable,
      capabilities: record.capabilities,
      effects: record.effects,
      schemaDigest: record.schemaDigest,
      permissionReviews: Object.fromEntries(record.capabilities.map((capability) => {
        const key = `${record.id}:${capability}`;
        const risk = classifyExtensionPermissionRisk(capability, record.effects);
        return [capability, snapshot.permissionReviews?.[key] ?? defaultExtensionPermissionReview(risk)];
      })),
      grants: Object.fromEntries(record.capabilities.map((capability) => [capability, snapshot.grants[`${record.id}:${capability}`] ?? "Deny"])),
    })),
  };
  if (format === "markdown") {
    return [
      "# Omnia Extensions & MCP Hub preview",
      "",
      "> Renderer-local registry snapshot. Discovery, installation, trust, grants, and execution remain separate native operations.",
      "",
      ...snapshot.records.map((record) => `- **${record.name}** v${record.version} · ${record.kind} · ${record.lifecycle} · ${record.trust}`),
    ].join("\n");
  }
  return JSON.stringify(payload, null, 2);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, fallback: string, max = 512): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim().slice(0, max) : fallback;
}

function stringList(value: unknown, fallback: readonly string[] = [], maxItems = 32): string[] {
  if (!Array.isArray(value)) return [...fallback];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, maxItems).map((item) => item.trim().slice(0, 256));
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? value as T : fallback;
}

/**
 * Parse a previously exported JSON manifest into a renderer-local snapshot.
 * This intentionally never resolves packages, endpoints, credentials, or native grants.
 */
export function parseExtensionManifest(raw: string): HubSnapshot | null {
  if (raw.length > MAX_MANIFEST_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.schema !== "omnia.extensions-mcp-hub-preview.v1" || !Array.isArray(parsed.extensions)) return null;

  const records: ExtensionRecord[] = [];
  const grants: Record<string, GrantMode> = {};
  const permissionReviews: Record<string, ExtensionPermissionReviewDraft> = {};
  parsed.extensions.slice(0, 64).forEach((entry, index) => {
    if (!isRecord(entry)) return;
    const seed = EXTENSION_SEED.find((record) => record.id === entry.id);
    const id = boundedString(entry.id, `imported-extension-${index + 1}`, 96).replace(/[^a-zA-Z0-9._:-]/g, "-");
    const name = boundedString(entry.name, seed?.name ?? `Imported extension ${index + 1}`, 160);
    const kind = enumValue(entry.kind, KIND_OPTIONS, seed?.kind ?? "MCP server");
    const transport = enumValue(entry.transport, ["stdio", "SSE", "HTTPS"] as const, seed?.transport ?? "stdio");
    const lifecycle = enumValue(entry.lifecycle, LIFECYCLE_OPTIONS, seed?.lifecycle ?? "Discovered");
    const trust = enumValue(entry.trust, ["Verified", "Reviewed", "Unreviewed"] as const, seed?.trust ?? "Unreviewed");
    const capabilities = stringList(entry.capabilities, seed?.capabilities ?? [], 24);
    const record: ExtensionRecord = {
      id,
      name,
      kind,
      source: boundedString(entry.source, "Imported manifest", 160),
      version: boundedString(entry.version, seed?.version ?? "0.0.0", 64),
      summary: boundedString(entry.summary, seed?.summary ?? "Imported renderer-local extension metadata.", 400),
      transport,
      endpoint: boundedString(entry.endpoint, seed?.endpoint ?? `${transport.toLowerCase()}://imported.invalid`, 256),
      trust,
      lifecycle,
      capabilities,
      effects: stringList(entry.effects, seed?.effects ?? [], 24),
      tools: stringList(entry.tools, seed?.tools ?? [], 48),
      resources: typeof entry.resources === "number" && Number.isFinite(entry.resources) ? Math.max(0, Math.min(999, Math.trunc(entry.resources))) : seed?.resources ?? 0,
      prompts: typeof entry.prompts === "number" && Number.isFinite(entry.prompts) ? Math.max(0, Math.min(999, Math.trunc(entry.prompts))) : seed?.prompts ?? 0,
      schemaDigest: boundedString(entry.schemaDigest, seed?.schemaDigest ?? "sha256:pending", 128),
      dependencies: stringList(entry.dependencies, seed?.dependencies ?? [], 24),
      updateAvailable: typeof entry.updateAvailable === "boolean" ? entry.updateAvailable : seed?.updateAvailable ?? false,
    };
    records.push(record);
    const grantPayload = isRecord(entry.grants) ? entry.grants : {};
    const reviewPayload = isRecord(entry.permissionReviews) ? entry.permissionReviews : {};
    capabilities.forEach((capability) => {
      grants[`${id}:${capability}`] = enumValue(grantPayload[capability], GRANT_ORDER, "Deny");
      const risk = classifyExtensionPermissionRisk(capability, record.effects);
      permissionReviews[`${id}:${capability}`] = normalizeExtensionPermissionReview(reviewPayload[capability], defaultExtensionPermissionReview(risk));
    });
  });
  return records.length > 0 ? { records, grants, permissionReviews } : null;
}

function downloadManifest(payload: string, format: ManifestFormat): boolean {
  if (typeof URL.createObjectURL !== "function") return false;
  const url = URL.createObjectURL(new Blob([payload], { type: format === "json" ? "application/json" : "text/markdown" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `omnia-extensions-mcp-renderer-preview.${format === "json" ? "json" : "md"}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  if (typeof URL.revokeObjectURL === "function") window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

function Boundary({ children }: { readonly children: ReactNode }) {
  return <p className="extensions-hub__boundary"><LockKeyhole size={14} /><span>{children}</span></p>;
}

function Stat({ icon, value, label }: { readonly icon: ReactNode; readonly value: string; readonly label: string }) {
  return <div className="extensions-hub__stat"><span>{icon}</span><strong>{value}</strong><small>{label}</small></div>;
}

function extensionAction(record: ExtensionRecord): { label: string; target: ExtensionLifecycle } | null {
  if (record.lifecycle === "Discovered") return { label: "Install in preview", target: "Installed" };
  if (record.lifecycle === "Installed") return { label: "Trust in preview", target: "Trusted" };
  if (record.lifecycle === "Trusted") return { label: "Enable in preview", target: "Enabled" };
  if (record.lifecycle === "Enabled") return { label: "Disable in preview", target: "Trusted" };
  return { label: "Re-open validation", target: "Installed" };
}

export function ExtensionsMcpHub() {
  const [snapshot, setSnapshot] = useState<HubSnapshot>(createInitialSnapshot);
  const [history, setHistory] = useState<HubHistory>({ past: [], future: [] });
  const [view, setView] = useState<HubView>("catalog");
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<ExtensionKind | "all">("all");
  const [lifecycle, setLifecycle] = useState<ExtensionLifecycle | "all">("all");
  const [trust, setTrust] = useState<ExtensionTrust | "all">("all");
  const [updateFilter, setUpdateFilter] = useState<"all" | "updates" | "current">("all");
  const [selectedId, setSelectedId] = useState(EXTENSION_SEED[0]?.id ?? "");
  const [selectedTool, setSelectedTool] = useState(EXTENSION_SEED[0]?.tools[0] ?? "");
  const [toolDraft, setToolDraft] = useState("{}\n");
  const [toolDraftStatus, setToolDraftStatus] = useState("Tool draft is local only; no MCP call has been sent.");
  const [manifestOpen, setManifestOpen] = useState(false);
  const [manifestFormat, setManifestFormat] = useState<ManifestFormat>("json");
  const [grantQuery, setGrantQuery] = useState("");
  const [grantFilter, setGrantFilter] = useState<GrantMode | "all">("all");
  const [grantPreset, setGrantPreset] = useState<GrantPreset>("custom");
  const [reviewQuery, setReviewQuery] = useState("");
  const [reviewFilter, setReviewFilter] = useState<"all" | "needs-review" | "high-risk" | "reviewed">("all");
  const [reviewSelection, setReviewSelection] = useState<string | null>(null);
  const [reviewExportOpen, setReviewExportOpen] = useState(false);
  const [reviewExportFormat, setReviewExportFormat] = useState<"json" | "markdown">("json");
  const [status, setStatus] = useState("Registry is a renderer-local preview; no extension process is running.");
  const importInputRef = useRef<HTMLInputElement>(null);

  const records = snapshot.records;
  const selected = records.find((record) => record.id === selectedId) ?? records[0] ?? null;
  const selectedToolName = selected?.tools.includes(selectedTool) ? selectedTool : selected?.tools[0] ?? "";
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return records.filter((record) => {
      const haystack = `${record.name} ${record.kind} ${record.source} ${record.summary} ${record.capabilities.join(" ")} ${record.effects.join(" ")}`.toLowerCase();
      return (!normalized || haystack.includes(normalized)) && (kind === "all" || record.kind === kind) && (lifecycle === "all" || record.lifecycle === lifecycle) && (trust === "all" || record.trust === trust) && (updateFilter === "all" || (updateFilter === "updates" ? record.updateAvailable : !record.updateAvailable));
    });
  }, [kind, lifecycle, query, records, trust, updateFilter]);

  const enabledCount = records.filter((record) => record.lifecycle === "Enabled").length;
  const mcpCount = records.filter((record) => record.kind === "MCP server").length;
  const updateCount = records.filter((record) => record.updateAvailable).length;
  const grantCount = Object.values(snapshot.grants).filter((value) => value === "Allow").length;
  const filteredGrantRecords = useMemo(() => {
    const normalized = grantQuery.trim().toLowerCase();
    return records.map((record) => ({
      record,
      capabilities: record.capabilities.filter((capability) => {
        const grant = snapshot.grants[`${record.id}:${capability}`] ?? "Deny";
        return (!normalized || `${record.name} ${record.kind} ${capability}`.toLowerCase().includes(normalized)) && (grantFilter === "all" || grant === grantFilter);
      }),
    })).filter(({ capabilities }) => capabilities.length > 0);
  }, [grantFilter, grantQuery, records, snapshot.grants]);
  const visibleGrantCount = filteredGrantRecords.reduce((total, item) => total + item.capabilities.length, 0);
  const permissionReviewItems = useMemo(() => buildExtensionPermissionReviewItems(records.flatMap((record) => record.capabilities.map((capability) => ({
    extensionId: record.id,
    extensionName: record.name,
    kind: record.kind,
    lifecycle: record.lifecycle,
    trust: record.trust,
    capability,
    effects: record.effects,
    grant: snapshot.grants[`${record.id}:${capability}`] ?? "Deny",
  }))), snapshot.permissionReviews), [records, snapshot.grants, snapshot.permissionReviews]);
  const filteredPermissionReviewItems = useMemo(() => {
    const normalized = reviewQuery.trim().toLowerCase();
    return permissionReviewItems.filter((item) => {
      const haystack = `${item.extensionName} ${item.kind} ${item.capability} ${item.effects.join(" ")} ${item.riskLabel}`.toLowerCase();
      return (!normalized || haystack.includes(normalized)) && (reviewFilter === "all" || (reviewFilter === "needs-review" ? item.review.state === "needs-review" : reviewFilter === "reviewed" ? item.review.state === "reviewed" : item.risk === "high" || item.risk === "critical"));
    });
  }, [permissionReviewItems, reviewFilter, reviewQuery]);
  const selectedReviewItem = permissionReviewItems.find((item) => item.key === reviewSelection) ?? filteredPermissionReviewItems[0] ?? permissionReviewItems[0] ?? null;
  const reviewedPermissionCount = permissionReviewItems.filter((item) => item.review.state === "reviewed").length;
  const highRiskPermissionCount = permissionReviewItems.filter((item) => item.risk === "high" || item.risk === "critical").length;
  const reviewExportPayload = useMemo(() => serializeExtensionPermissionReview(permissionReviewItems, reviewExportFormat), [permissionReviewItems, reviewExportFormat]);
  const manifestPayload = useMemo(() => serializeExtensionManifest(snapshot, manifestFormat), [manifestFormat, snapshot]);

  const announce = (message: string) => {
    setStatus(message);
    window.setTimeout(() => setStatus((current) => current === message ? "Registry is a renderer-local preview; no extension process is running." : current), 2800);
  };

  const commit = (next: HubSnapshot, message: string) => {
    setHistory((current) => ({ past: [...current.past, cloneSnapshot(snapshot)], future: [] }));
    setSnapshot(cloneSnapshot(next));
    announce(message);
  };

  const transition = (record: ExtensionRecord) => {
    const action = extensionAction(record);
    if (!action) return;
    commit({ ...snapshot, records: records.map((item) => item.id === record.id ? { ...item, lifecycle: action.target } : item) }, `${record.name}: ${action.target} is visible in preview only; native install/trust/enable did not run.`);
  };

  const cycleGrant = (record: ExtensionRecord, capability: string) => {
    const key = `${record.id}:${capability}`;
    const current = snapshot.grants[key] ?? "Deny";
    const next = GRANT_ORDER[(GRANT_ORDER.indexOf(current) + 1) % GRANT_ORDER.length]!;
    commit({ ...snapshot, grants: { ...snapshot.grants, [key]: next } }, `${record.name} · ${capability} is now ${next} in the renderer preview.`);
    setGrantPreset("custom");
  };

  const applyGrantPreset = (preset: Exclude<GrantPreset, "custom">) => {
    const grants = Object.fromEntries(records.flatMap((record) => record.capabilities.map((capability) => {
      const isReadOnly = /(?:\.read$|\.inspect$|\.references$|\.definition$|\.search$)/i.test(capability) && !/(?:write|process|execute|delete|network)/i.test(capability);
      const grant: GrantMode = preset === "deny-all" ? "Deny" : preset === "ask-all" ? "Ask every time" : isReadOnly ? "Allow" : "Deny";
      return [`${record.id}:${capability}`, grant];
    })));
    commit({ ...snapshot, grants }, `Applied the ${GRANT_PRESETS.find((item) => item.id === preset)?.label ?? "custom"} capability preset to this renderer preview.`);
    setGrantPreset(preset);
  };

  const updatePermissionReview = (key: string, patch: Partial<ExtensionPermissionReviewDraft>, message: string) => {
    const current = permissionReviewItems.find((item) => item.key === key);
    const fallback = current?.review ?? defaultExtensionPermissionReview(current?.risk ?? "medium");
    const nextReview = normalizeExtensionPermissionReview({ ...fallback, ...patch }, fallback);
    commit({ ...snapshot, permissionReviews: { ...(snapshot.permissionReviews ?? {}), [key]: nextReview } }, message);
  };

  const markVisibleReviews = (state: ExtensionPermissionReviewDraft["state"]) => {
    const nextReviews = { ...(snapshot.permissionReviews ?? {}) };
    filteredPermissionReviewItems.forEach((item) => {
      nextReviews[item.key] = { ...item.review, state };
    });
    commit({ ...snapshot, permissionReviews: nextReviews }, `${filteredPermissionReviewItems.length} visible permission review${filteredPermissionReviewItems.length === 1 ? "" : "s"} marked ${state === "reviewed" ? "reviewed" : "back in queue"} in this preview.`);
  };

  const undo = () => {
    const previous = history.past.at(-1);
    if (!previous) return;
    setHistory((current) => ({ past: current.past.slice(0, -1), future: [cloneSnapshot(snapshot), ...current.future] }));
    setSnapshot(cloneSnapshot(previous));
    announce("Undid the last extension registry preview change.");
  };

  const redo = () => {
    const next = history.future[0];
    if (!next) return;
    setHistory((current) => ({ past: [...current.past, cloneSnapshot(snapshot)], future: current.future.slice(1) }));
    setSnapshot(cloneSnapshot(next));
    announce("Reapplied the next extension registry preview change.");
  };

  const reset = () => {
    commit(createInitialSnapshot(), "Reset extensions and MCP grants to seeded preview defaults.");
    setGrantPreset("custom");
  };

  const importManifest = (file?: File) => {
    if (!file) return;
    if (file.size > MAX_MANIFEST_BYTES) {
      announce("This manifest exceeds 512 KB; no extension registry changes were applied.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const imported = parseExtensionManifest(String(reader.result ?? ""));
      if (!imported) {
        announce("Manifest validation failed; expected an Omnia Extensions & MCP JSON preview.");
        return;
      }
      commit(imported, `Imported ${imported.records.length} extension record${imported.records.length === 1 ? "" : "s"} into the renderer preview; no native activation ran.`);
      setSelectedId(imported.records[0]?.id ?? "");
      setSelectedTool(imported.records[0]?.tools[0] ?? "");
      setToolDraft("{}\n");
      setToolDraftStatus("Tool draft is local only; no MCP call has been sent.");
      setGrantPreset("custom");
      setView("catalog");
      setManifestOpen(false);
    };
    reader.onerror = () => announce("The selected manifest could not be read; no extension registry changes were applied.");
    reader.readAsText(file);
  };

  const selectView = (event: ReactKeyboardEvent<HTMLButtonElement>, current: HubView) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const views: HubView[] = ["catalog", "inspector", "grants", "review", "lifecycle"];
    const index = views.indexOf(current);
    const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? views.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + views.length) % views.length;
    const next = views[nextIndex]!;
    setView(next);
    document.getElementById(`extensions-hub-tab-${next}`)?.focus();
  };

  const copyManifest = async () => {
    if (!navigator.clipboard?.writeText) {
      announce("Clipboard access is unavailable; no extension manifest was copied.");
      return;
    }
    try {
      await navigator.clipboard.writeText(manifestPayload);
      announce(`Copied the ${manifestFormat.toUpperCase()} extension registry preview.`);
    } catch {
      announce("Clipboard access was denied; no extension manifest was copied.");
    }
  };

  const validateToolDraft = () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(toolDraft);
    } catch {
      setToolDraftStatus("Draft JSON is invalid; no MCP call was sent.");
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      setToolDraftStatus("Tool arguments must be a JSON object; no MCP call was sent.");
      return;
    }
    setToolDraftStatus(`${selectedToolName || "Tool"} draft is valid JSON; no MCP call was sent.`);
  };

  const copyToolDraft = async () => {
    if (!navigator.clipboard?.writeText) {
      setToolDraftStatus("Clipboard access is unavailable; no tool draft was copied.");
      return;
    }
    try {
      await navigator.clipboard.writeText(toolDraft);
      setToolDraftStatus("Copied the renderer-local tool draft; no MCP call was sent.");
    } catch {
      setToolDraftStatus("Clipboard access was denied; no tool draft was copied.");
    }
  };

  const copyPermissionReview = async () => {
    if (!navigator.clipboard?.writeText) {
      announce("Clipboard access is unavailable; permission review export was not copied.");
      return;
    }
    try {
      await navigator.clipboard.writeText(reviewExportPayload);
      announce(`Copied the ${reviewExportFormat.toUpperCase()} permission review preview; no native approval receipt was created.`);
    } catch {
      announce("Clipboard access was denied; permission review export was not copied.");
    }
  };

  return (
    <section className="extensions-hub" aria-label="Extensions and MCP hub preview">
      <header className="extensions-hub__header">
        <span className="extensions-hub__hero"><PlugZap size={24} /></span>
        <div><span className="eyebrow">Composable integration control room</span><h2>Extensions &amp; MCP Hub</h2><p>Inspect discovery, trust, capability grants, and lifecycle stages before native activation exists.</p></div>
        <span className="extensions-hub__status"><Activity size={13} /> Preview only</span>
      </header>

      <div className="extensions-hub__stats" role="status" aria-label="Extension registry summary">
        <Stat icon={<ServerCog size={14} />} value={`${mcpCount}`} label="MCP servers" />
        <Stat icon={<PackageCheck size={14} />} value={`${enabledCount}`} label="enabled preview" />
        <Stat icon={<RefreshCw size={14} />} value={`${updateCount}`} label="updates visible" />
        <Stat icon={<ShieldCheck size={14} />} value={`${grantCount}`} label="allow grants" />
      </div>

      <nav className="extensions-hub__tabs" role="tablist" aria-label="Extensions hub views">
        {([["catalog", "Catalog", Blocks], ["inspector", "MCP inspector", ServerCog], ["grants", "Capability grants", ShieldCheck], ["review", "Permission review", KeyRound], ["lifecycle", "Lifecycle", Activity]] as const).map(([id, label, Icon]) => (
          <button key={id} id={`extensions-hub-tab-${id}`} type="button" role="tab" aria-selected={view === id} aria-controls={`extensions-hub-panel-${id}`} tabIndex={view === id ? 0 : -1} className={view === id ? "active" : ""} onClick={() => setView(id)} onKeyDown={(event) => selectView(event, id)}><Icon size={14} /> {label}</button>
        ))}
      </nav>

      <div className="extensions-hub__toolbar" role="toolbar" aria-label="Extension registry preview actions">
        <span><strong>Reversible registry preview</strong><small>{history.past.length} undo · {history.future.length} redo</small></span>
        <button type="button" className="button button--ghost" onClick={undo} disabled={history.past.length === 0} aria-label="Undo extension registry preview change"><Undo2 size={13} /> Undo</button>
        <button type="button" className="button button--ghost" onClick={redo} disabled={history.future.length === 0} aria-label="Redo extension registry preview change"><Redo2 size={13} /> Redo</button>
        <button type="button" className="button button--ghost" onClick={reset} aria-label="Reset extension registry preview"><RotateCcw size={13} /> Reset</button>
        <button type="button" className="button button--ghost" onClick={() => importInputRef.current?.click()}><Upload size={13} /> Import manifest</button>
        <input ref={importInputRef} type="file" accept="application/json,.json" hidden aria-label="Import extension manifest JSON" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importManifest(file); event.currentTarget.value = ""; }} />
        <button type="button" className="button button--secondary" onClick={() => setManifestOpen((current) => !current)} aria-expanded={manifestOpen} aria-controls="extensions-hub-manifest"><FileJson2 size={13} /> {manifestOpen ? "Hide manifest" : "Preview manifest"}</button>
      </div>

      <div className="extensions-hub__status" role="status" aria-live="polite"><Check size={14} /> {status}</div>

      {manifestOpen ? <section id="extensions-hub-manifest" className="extensions-hub__manifest" aria-label="Extension registry manifest preview">
        <header><div><span className="eyebrow">Renderer-local manifest</span><h3>Registry snapshot · no native activation</h3></div><span className="extensions-hub__chip extensions-hub__chip--amber">Preview</span></header>
        <div className="extensions-hub__manifest-toolbar" role="toolbar" aria-label="Extension manifest actions">
          <label><span>Format</span><select value={manifestFormat} onChange={(event) => setManifestFormat(event.target.value as ManifestFormat)} aria-label="Extension manifest format"><option value="json">JSON</option><option value="markdown">Markdown</option></select></label>
          <button type="button" className="button button--ghost" onClick={() => void copyManifest()}><Clipboard size={14} /> Copy</button>
          <button type="button" className="button button--secondary" onClick={() => announce(downloadManifest(manifestPayload, manifestFormat) ? "Downloaded a browser-only extension manifest preview." : "File download is unavailable; no extension manifest was exported.")}><Download size={14} /> Download</button>
        </div>
        <pre className="extensions-hub__manifest-code" tabIndex={0}><code>{manifestPayload}</code></pre>
        <Boundary>This manifest captures the current renderer selection. It does not install packages, start processes, grant capabilities, or call a provider.</Boundary>
      </section> : null}

      <div id={`extensions-hub-panel-${view}`} role="tabpanel" className="extensions-hub__panel" aria-labelledby={`extensions-hub-tab-${view}`}>
        {view === "catalog" ? <>
          <div className="extensions-hub__filters">
            <label className="extensions-hub__search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search extensions, tools, effects" aria-label="Search extensions" />{query ? <button type="button" aria-label="Clear extension search" onClick={() => setQuery("")}><X size={13} /></button> : null}</label>
            <label><span>Type</span><select value={kind} onChange={(event) => setKind(event.target.value as ExtensionKind | "all")} aria-label="Filter extension type"><option value="all">All types</option>{KIND_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}</select></label>
            <label><span>Lifecycle</span><select value={lifecycle} onChange={(event) => setLifecycle(event.target.value as ExtensionLifecycle | "all")} aria-label="Filter extension lifecycle"><option value="all">All stages</option>{LIFECYCLE_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}</select></label>
            <label><span>Trust</span><select value={trust} onChange={(event) => setTrust(event.target.value as ExtensionTrust | "all")} aria-label="Filter extension trust"><option value="all">All trust levels</option><option value="Verified">Verified</option><option value="Reviewed">Reviewed</option><option value="Unreviewed">Unreviewed</option></select></label>
            <label><span>Updates</span><select value={updateFilter} onChange={(event) => setUpdateFilter(event.target.value as "all" | "updates" | "current")} aria-label="Filter extension updates"><option value="all">All update states</option><option value="updates">Updates available</option><option value="current">Up to date</option></select></label>
            <div className="extensions-hub__filter-summary"><span>{filtered.length} visible integration{filtered.length === 1 ? "" : "s"}</span><button type="button" className="button button--ghost" onClick={() => { setQuery(""); setKind("all"); setLifecycle("all"); setTrust("all"); setUpdateFilter("all"); }} disabled={!query && kind === "all" && lifecycle === "all" && trust === "all" && updateFilter === "all"} aria-label="Reset extension catalog filters"><RotateCcw size={13} /> Reset filters</button></div>
          </div>
          <div className="extensions-hub__catalog-layout">
            <div className="extensions-hub__list" role="list" aria-label="Extension catalog">
              {filtered.length === 0 ? <div className="extensions-hub__empty"><Search size={22} /><strong>No extension matches</strong><span>Adjust the query or lifecycle filters.</span></div> : null}
              {filtered.map((record) => {
                const Icon = kindIcons[record.kind];
                return <button key={record.id} type="button" role="listitem" aria-pressed={record.id === selected?.id} className={`extensions-hub__card${record.id === selected?.id ? " extensions-hub__card--selected" : ""}`} onClick={() => setSelectedId(record.id)}><span className="extensions-hub__card-icon"><Icon size={17} /></span><span className="extensions-hub__card-copy"><strong>{record.name}</strong><small>{record.kind} · v{record.version} · {record.source}</small><span><em className={lifecycleTone[record.lifecycle]}>{record.lifecycle}</em><em className="extensions-hub__chip">{record.trust}</em>{record.updateAvailable ? <em className="extensions-hub__chip extensions-hub__chip--amber">Update</em> : null}</span></span><span className="extensions-hub__card-chevron"><ChevronRightIcon /></span></button>;
              })}
            </div>
            <aside className="extensions-hub__detail" aria-label="Selected extension details">
              {selected ? <>
                <div className="extensions-hub__detail-heading"><div><span className="eyebrow">Selected integration</span><h3>{selected.name}</h3><small>{selected.kind} · {selected.transport}</small></div><span className={lifecycleTone[selected.lifecycle]}>{selected.lifecycle}</span></div>
                <p className="extensions-hub__detail-summary">{selected.summary}</p>
                <div className="extensions-hub__facts"><div><span>Trust</span><strong>{selected.trust}</strong></div><div><span>Tools</span><strong>{selected.tools.length}</strong></div><div><span>Resources</span><strong>{selected.resources}</strong></div><div><span>Schema</span><strong>{selected.schemaDigest}</strong></div></div>
                <div className="extensions-hub__detail-section"><span className="eyebrow">Effects declared by manifest</span><div className="extensions-hub__chips">{selected.effects.map((effect) => <span key={effect} className="extensions-hub__chip"><ShieldAlert size={11} /> {effect}</span>)}</div></div>
                <div className="extensions-hub__detail-section"><span className="eyebrow">Lifecycle rehearsal</span><div className="extensions-hub__actions"><button type="button" className="button button--primary" onClick={() => transition(selected)}><PackageCheck size={14} /> {extensionAction(selected)?.label ?? "Review"}</button><button type="button" className="button button--ghost" onClick={() => setView("inspector")}><ServerCog size={14} /> Inspect MCP</button></div></div>
                <Boundary>Discovery, installation, trust, enablement, capability grants, and execution are separate native operations. This button changes only the renderer preview.</Boundary>
              </> : <div className="extensions-hub__empty"><Blocks size={22} /><strong>Select an integration</strong><span>Its manifest and lifecycle will appear here.</span></div>}
            </aside>
          </div>
        </> : null}

        {view === "inspector" && selected ? <div className="extensions-hub__inspector">
          <div className="extensions-hub__inspector-head"><div><span className="eyebrow">MCP server inspector</span><h3>{selected.name}</h3><p>{selected.endpoint}</p></div><span className={lifecycleTone[selected.lifecycle]}>{selected.lifecycle}</span></div>
          <div className="extensions-hub__inspector-grid"><article><span className="eyebrow">Transport</span><strong>{selected.transport}</strong><small>Endpoint is metadata only in this preview.</small></article><article><span className="eyebrow">Schema digest</span><strong>{selected.schemaDigest}</strong><small>Schema drift invalidates trust in the native lifecycle.</small></article><article><span className="eyebrow">Dependencies</span><strong>{selected.dependencies.length || "None"}</strong><small>{selected.dependencies.join(" · ") || "No external dependency listed."}</small></article></div>
          <div className="extensions-hub__tool-table" role="table" aria-label="MCP tool schema preview"><div role="row" className="extensions-hub__tool-row extensions-hub__tool-row--head"><span role="columnheader">Tool</span><span role="columnheader">Effect</span><span role="columnheader">State</span></div>{selected.tools.map((tool, index) => <div role="row" className={`extensions-hub__tool-row${tool === selectedToolName ? " extensions-hub__tool-row--selected" : ""}`} key={tool}><span role="cell"><button type="button" className="extensions-hub__tool-select" aria-pressed={tool === selectedToolName} onClick={() => { setSelectedTool(tool); setToolDraft("{}\n"); setToolDraftStatus("Tool draft is local only; no MCP call has been sent."); }}><TerminalSquare size={13} /> {tool}</button></span><span role="cell">{selected.effects[index % selected.effects.length] ?? "Declared operation"}</span><span role="cell"><em className="extensions-hub__chip extensions-hub__chip--blue">Schema preview</em></span></div>)}</div>
          <section className="extensions-hub__tool-rehearsal" aria-label="MCP tool call rehearsal"><div className="extensions-hub__tool-rehearsal-head"><div><span className="eyebrow">Tool-call rehearsal</span><h3>Draft arguments before native admission</h3><p>Choose a schema-preview tool and shape its arguments locally.</p></div><span className="extensions-hub__chip extensions-hub__chip--amber">No call sent</span></div><div className="extensions-hub__tool-rehearsal-grid"><label><span>Tool</span><select value={selectedToolName} onChange={(event) => { setSelectedTool(event.target.value); setToolDraft("{}\n"); setToolDraftStatus("Tool draft is local only; no MCP call has been sent."); }} aria-label="MCP tool to rehearse">{selected.tools.map((tool) => <option key={tool} value={tool}>{tool}</option>)}</select></label><label><span>Arguments JSON</span><textarea value={toolDraft} onChange={(event) => setToolDraft(event.target.value)} aria-label="MCP tool arguments JSON" spellCheck={false} rows={5} /></label></div><div className="extensions-hub__tool-rehearsal-actions"><button type="button" className="button button--primary" onClick={validateToolDraft}><Check size={14} /> Validate draft</button><button type="button" className="button button--ghost" onClick={() => void copyToolDraft()}><Clipboard size={14} /> Copy draft</button><span role="status" aria-live="polite">{toolDraftStatus}</span></div><Boundary>Arguments are parsed in the renderer only. No endpoint request, server process, tool execution, approval receipt, or durable call history was created.</Boundary></section>
          <div className="extensions-hub__inspector-actions"><button type="button" className="button button--secondary" onClick={() => announce("Probe is planned; no endpoint request was sent.")}><FlaskConical size={14} /> Probe endpoint (planned)</button><button type="button" className="button button--ghost" onClick={() => announce("Refresh is renderer-local; no manifest or binary was re-read.")}><RefreshCw size={14} /> Refresh metadata</button></div>
          <Boundary>MCP descriptions and tool schemas are untrusted input. No server process, network request, child process, secret, or tool call was started by this inspector.</Boundary>
        </div> : null}

        {view === "grants" ? <div className="extensions-hub__grants"><div className="extensions-hub__section-heading"><div><span className="eyebrow">Capability policy rehearsal</span><h3>Review each declared effect before enablement</h3><p className="extensions-hub__section-summary">{visibleGrantCount} visible {visibleGrantCount === 1 ? "capability" : "capabilities"} · renderer-local policy draft</p></div><KeyRound size={20} /></div><div className="extensions-hub__grant-controls" role="toolbar" aria-label="Capability grant filters and presets"><label className="extensions-hub__search"><Search size={15} /><input value={grantQuery} onChange={(event) => setGrantQuery(event.target.value)} placeholder="Search capabilities" aria-label="Search capability grants" />{grantQuery ? <button type="button" aria-label="Clear capability grant search" onClick={() => setGrantQuery("")}><X size={13} /></button> : null}</label><label><span>Mode</span><select value={grantFilter} onChange={(event) => setGrantFilter(event.target.value as GrantMode | "all")} aria-label="Filter capability grant mode"><option value="all">All modes</option>{GRANT_ORDER.map((option) => <option key={option} value={option}>{option}</option>)}</select></label><label><span>Preset</span><select value={grantPreset} onChange={(event) => { const next = event.target.value as GrantPreset; if (next !== "custom") applyGrantPreset(next); else setGrantPreset("custom"); }} aria-label="Capability grant preset"><option value="custom">Custom current policy</option>{GRANT_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}</select></label></div><div className="extensions-hub__grant-preset-hints" aria-label="Capability preset descriptions">{GRANT_PRESETS.map((preset) => <button type="button" key={preset.id} className={`extensions-hub__grant-preset${grantPreset === preset.id ? " extensions-hub__grant-preset--active" : ""}`} onClick={() => applyGrantPreset(preset.id)}><strong>{preset.label}</strong><span>{preset.description}</span></button>)}</div>{filteredGrantRecords.length === 0 ? <div className="extensions-hub__empty"><Search size={22} /><strong>No capability matches</strong><span>Adjust the search or grant mode filter.</span></div> : filteredGrantRecords.map(({ record, capabilities }) => <article className="extensions-hub__grant-card" key={record.id}><header><div><strong>{record.name}</strong><small>{record.kind} · {record.lifecycle}</small></div><span className={lifecycleTone[record.lifecycle]}>{record.trust}</span></header><div className="extensions-hub__grant-rows">{capabilities.map((capability) => { const grant = snapshot.grants[`${record.id}:${capability}`] ?? "Deny"; return <button type="button" key={capability} className={`extensions-hub__grant-row extensions-hub__grant-row--${grant === "Allow" ? "allow" : grant === "Deny" ? "deny" : "ask"}`} onClick={() => cycleGrant(record, capability)}><span><ShieldCheck size={13} /><strong>{capability}</strong></span><em>{grant}</em><small>Click to cycle</small></button>; })}</div></article>)}</div> : null}

        {view === "review" ? <div className="extensions-hub__permission-review">
          <div className="extensions-hub__section-heading"><div><span className="eyebrow">Permission review queue</span><h3>Review risk, scope, and expiry before granting access</h3><p className="extensions-hub__section-summary">{reviewedPermissionCount}/{permissionReviewItems.length} reviewed · {highRiskPermissionCount} high or critical risk · renderer-local draft</p><p className="extensions-hub__section-summary">Risk levels are heuristic signals from declared capability/effect text, not a package security audit.</p></div><KeyRound size={20} /></div>
          <div className="extensions-hub__review-toolbar" role="toolbar" aria-label="Permission review filters and actions">
            <label className="extensions-hub__search"><Search size={15} /><input value={reviewQuery} onChange={(event) => setReviewQuery(event.target.value)} placeholder="Search extension, capability, risk" aria-label="Search permission reviews" />{reviewQuery ? <button type="button" aria-label="Clear permission review search" onClick={() => setReviewQuery("")}><X size={13} /></button> : null}</label>
            <label><span>Queue</span><select value={reviewFilter} onChange={(event) => setReviewFilter(event.target.value as typeof reviewFilter)} aria-label="Filter permission review queue"><option value="all">All review items</option><option value="needs-review">Needs review</option><option value="high-risk">High or critical risk</option><option value="reviewed">Reviewed</option></select></label>
            <button type="button" className="button button--ghost" onClick={() => markVisibleReviews("reviewed")} disabled={filteredPermissionReviewItems.length === 0}>Mark visible reviewed</button>
            <button type="button" className="button button--ghost" onClick={() => markVisibleReviews("needs-review")} disabled={filteredPermissionReviewItems.length === 0}>Return visible to queue</button>
            <button type="button" className="button button--secondary" onClick={() => setReviewExportOpen((current) => !current)} aria-expanded={reviewExportOpen} aria-controls="extensions-hub-permission-review-export">{reviewExportOpen ? "Hide review export" : "Preview review export"}</button>
          </div>
          {reviewExportOpen ? <section id="extensions-hub-permission-review-export" className="extensions-hub__review-export" aria-label="Permission review export preview"><header><div><span className="eyebrow">Renderer-local review package</span><h3>No native approval receipt</h3></div><span className="extensions-hub__chip extensions-hub__chip--amber">Preview</span></header><div className="extensions-hub__review-export-toolbar"><label><span>Format</span><select value={reviewExportFormat} onChange={(event) => setReviewExportFormat(event.target.value as "json" | "markdown")} aria-label="Permission review export format"><option value="json">JSON</option><option value="markdown">Markdown</option></select></label><button type="button" className="button button--ghost" onClick={() => void copyPermissionReview()}>Copy preview</button></div><pre className="extensions-hub__review-export-code" tabIndex={0}><code>{reviewExportPayload}</code></pre><Boundary>This review package includes the full renderer-session review list. It does not grant capabilities, start a plugin or MCP process, call an endpoint, or write durable policy.</Boundary></section> : null}
          <div className="extensions-hub__review-summary" role="status" aria-label="Permission review summary"><span>{filteredPermissionReviewItems.length} visible item{filteredPermissionReviewItems.length === 1 ? "" : "s"}</span><span>{permissionReviewItems.filter((item) => item.review.state === "needs-review").length} need review</span><span>{highRiskPermissionCount} high/critical</span></div>
          <div className="extensions-hub__review-layout"><div className="extensions-hub__review-list" role="list" aria-label="Permission review items">{filteredPermissionReviewItems.length === 0 ? <div className="extensions-hub__empty"><Search size={22} /><strong>No permission review matches</strong><span>Adjust the search or queue filter.</span></div> : filteredPermissionReviewItems.map((item) => <button type="button" role="listitem" aria-pressed={item.key === selectedReviewItem?.key} key={item.key} className={`extensions-hub__review-item${item.key === selectedReviewItem?.key ? " extensions-hub__review-item--selected" : ""}`} onClick={() => setReviewSelection(item.key)}><span className="extensions-hub__review-item-copy"><strong>{item.extensionName}</strong><small>{item.kind} · {item.capability}</small><span><em className={permissionRiskTone[item.risk]}>{item.riskLabel}</em><em className={`extensions-hub__chip extensions-hub__chip--${item.review.state === "reviewed" ? "green" : "amber"}`}>{item.review.state === "reviewed" ? "Reviewed" : "Needs review"}</em></span></span><span className="extensions-hub__review-item-grant">{item.grant}</span></button>)}</div><aside className="extensions-hub__review-detail" aria-label="Selected permission review details">{selectedReviewItem ? <><header><div><span className="eyebrow">Selected permission</span><h3>{selectedReviewItem.extensionName}</h3><small>{selectedReviewItem.kind} · {selectedReviewItem.capability}</small></div><span className={permissionRiskTone[selectedReviewItem.risk]}>{selectedReviewItem.riskLabel} risk</span></header><p className="extensions-hub__review-detail-summary">{selectedReviewItem.effects.join(" · ") || "No effect description was declared."}</p><div className="extensions-hub__review-facts"><div><span>Decision</span><strong>{selectedReviewItem.grant}</strong></div><div><span>Scope</span><strong>{permissionScopeLabel[selectedReviewItem.review.scope]}</strong></div><div><span>Expiry</span><strong>{permissionExpiryLabel[selectedReviewItem.review.expiry]}</strong></div><div><span>Trust</span><strong>{selectedReviewItem.trust}</strong></div></div><div className="extensions-hub__review-form"><label><span>Decision</span><select value={selectedReviewItem.grant} onChange={(event) => { const next = event.target.value as GrantMode; commit({ ...snapshot, grants: { ...snapshot.grants, [selectedReviewItem.key]: next } }, `${selectedReviewItem.extensionName} · ${selectedReviewItem.capability} is now ${next} in the renderer preview.`); }} aria-label="Selected permission decision"><option value="Allow">Allow</option><option value="Ask every time">Ask every time</option><option value="Deny">Deny</option></select></label><label><span>Scope</span><select value={selectedReviewItem.review.scope} onChange={(event) => updatePermissionReview(selectedReviewItem.key, { scope: event.target.value as ExtensionPermissionScope }, "Permission scope updated in the renderer review preview.")} aria-label="Selected permission scope">{Object.entries(permissionScopeLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label><span>Expiry</span><select value={selectedReviewItem.review.expiry} onChange={(event) => updatePermissionReview(selectedReviewItem.key, { expiry: event.target.value as ExtensionPermissionExpiry }, "Permission expiry updated in the renderer review preview.")} aria-label="Selected permission expiry">{Object.entries(permissionExpiryLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label><span>Rationale<small>Optional note for the future native approval receipt.</small></span><input value={selectedReviewItem.review.rationale} onChange={(event) => updatePermissionReview(selectedReviewItem.key, { rationale: event.target.value }, "Permission review rationale updated in the renderer preview.")} aria-label="Selected permission rationale" /></label></div><div className="extensions-hub__review-actions"><button type="button" className="button button--primary" onClick={() => updatePermissionReview(selectedReviewItem.key, { state: "reviewed" }, "Permission marked reviewed in the renderer preview; no native grant was issued.")}>Mark reviewed</button><button type="button" className="button button--ghost" onClick={() => updatePermissionReview(selectedReviewItem.key, { state: "needs-review" }, "Permission returned to the review queue in the renderer preview.")}>Return to queue</button></div><Boundary>Review metadata is renderer-local. Scope, expiry, rationale, and decision are not enforced by native policy, endpoint admission, process isolation, or durable storage.</Boundary></> : <div className="extensions-hub__empty"><KeyRound size={22} /><strong>Select a permission</strong><span>Risk, scope, expiry, and rationale will appear here.</span></div>}</aside></div>
        </div> : null}

        {view === "lifecycle" ? <div className="extensions-hub__lifecycle"><div className="extensions-hub__section-heading"><div><span className="eyebrow">Staged activation model</span><h3>Every integration advances through explicit gates</h3></div><BadgeCheck size={20} /></div><div className="extensions-hub__pipeline">{([["1", "Discover", "Read catalog metadata only"], ["2", "Install", "Verify package identity and dependencies"], ["3", "Trust", "Review manifest, digest, and declared effects"], ["4", "Grant", "Select scoped capabilities and destinations"], ["5", "Enable", "Admit only after native policy revalidation"], ["6", "Execute", "Create an auditable operation receipt"]] as const).map(([number, title, description], index) => <article key={number} className={`extensions-hub__pipeline-step${index < 1 ? " extensions-hub__pipeline-step--preview" : ""}`}><span>{number}</span><div><strong>{title}</strong><p>{description}</p></div><em>{index === 0 ? "Preview" : "Planned"}</em></article>)}</div><div className="extensions-hub__policy-grid"><article><Cloud size={16} /><strong>Remote config may propose</strong><p>Repository or remote manifests never silently activate executable integrations.</p></article><article><AlertTriangle size={16} /><strong>Updates invalidate trust</strong><p>Binary, dependency, schema, effect, or destination changes require a fresh review.</p></article><article><KeyRound size={16} /><strong>Grant is operation-specific</strong><p>A capability grant does not approve every future tool call or destination.</p></article></div><Boundary>The lifecycle board is a design preview. Native package verification, process isolation, approval receipts, cancellation, crash recovery, and durable state are not connected.</Boundary></div> : null}
      </div>
    </section>
  );
}

function ChevronRightIcon() {
  return <span aria-hidden="true">›</span>;
}

export default ExtensionsMcpHub;
