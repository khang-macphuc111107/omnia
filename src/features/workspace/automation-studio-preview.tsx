import {
  BellRing,
  CalendarClock,
  Archive,
  Check,
  Clipboard,
  Copy,
  Clock3,
  Download,
  GitBranch,
  ListChecks,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Search,
  Settings2,
  Sparkles,
  Upload,
  WandSparkles,
  Zap,
} from "lucide-react";
import { useMemo, useState, type KeyboardEvent } from "react";

import { AutomationWorkflowPlanPreview } from "./automation-workflow-plan-preview";

type AutomationStatus = "active" | "paused" | "draft" | "archived";
type AutomationTrigger =
  | "schedule"
  | "cron"
  | "calendar"
  | "event"
  | "email"
  | "message"
  | "file"
  | "git"
  | "webhook"
  | "provider-health"
  | "budget"
  | "machine-state"
  | "artifact-completion"
  | "manual";
type AutomationAction = "chat" | "research" | "export" | "notify";
type AutomationScope = "chat" | "project" | "workspace";
type AutomationConnector = "none" | "google-calendar" | "microsoft-calendar" | "github" | "slack" | "email" | "webhook";
type AutomationConnectorPermission = "not-connected" | "read-only" | "draft-only" | "write-review";
type AutomationAudit = "session" | "30-days" | "forever-preview";
type AutomationApproval = "auto-preview" | "review-changes" | "always-ask";
type AutomationRetry = "none" | "once" | "three";
type AutomationMissedRun = "skip" | "catch-up" | "ask";
type AutomationConcurrency = "serial" | "parallel-2" | "parallel-4";
type AutomationNotification = "in-app" | "in-app-email" | "in-app-chat";
type StudioTab = "automations" | "calendar" | "runs";

type Automation = {
  id: string;
  name: string;
  description: string;
  status: AutomationStatus;
  trigger: AutomationTrigger;
  triggerLabel: string;
  triggerDetail: string;
  action: AutomationAction;
  actionLabel: string;
  scope: AutomationScope;
  connector: AutomationConnector;
  connectorPermission: AutomationConnectorPermission;
  connectorIdentity: string;
  auditRetention: AutomationAudit;
  approval: AutomationApproval;
  retry: AutomationRetry;
  missedRun: AutomationMissedRun;
  concurrency: AutomationConcurrency;
  notification: AutomationNotification;
  timezone: string;
  dependency: string;
  budget: string;
  cadence: string;
  nextRun: string;
  lastRun: string;
  runs: number;
  owner: string;
  tone: "blue" | "teal" | "amber" | "coral";
};

type AutomationRun = {
  id: string;
  automationId: string;
  automationName: string;
  status: "preview queued" | "preview complete" | "needs review";
  detail: string;
  occurredAt: string;
};

const seedAutomations: readonly Automation[] = [
  {
    id: "morning-digest",
    name: "Morning research digest",
    description: "Collect the visible research notebook and prepare a concise brief for review.",
    status: "active",
    trigger: "schedule",
    triggerLabel: "Weekdays · 08:30",
    triggerDetail: "At 08:30 in the local preview timezone",
    action: "research",
    actionLabel: "Synthesize notebook",
    scope: "workspace",
    connector: "none",
    connectorPermission: "not-connected",
    connectorIdentity: "No connector identity",
    auditRetention: "session",
    approval: "review-changes",
    retry: "once",
    missedRun: "catch-up",
    concurrency: "serial",
    notification: "in-app-email",
    timezone: "Local preview · UTC+07:00",
    dependency: "Research sources refreshed",
    budget: "$0.20 / run",
    cadence: "Weekdays",
    nextRun: "Tomorrow · 08:30",
    lastRun: "Today · preview complete",
    runs: 18,
    owner: "Research workspace",
    tone: "blue",
  },
  {
    id: "repo-watch",
    name: "Repository drift watch",
    description: "Compare the selected Project view with the last renderer snapshot and flag changes.",
    status: "active",
    trigger: "event",
    triggerLabel: "Project snapshot changed",
    triggerDetail: "When the selected project reports a visible snapshot change",
    action: "notify",
    actionLabel: "Create attention item",
    scope: "project",
    connector: "github",
    connectorPermission: "read-only",
    connectorIdentity: "Omnia · repository observer",
    auditRetention: "30-days",
    approval: "always-ask",
    retry: "none",
    missedRun: "skip",
    concurrency: "serial",
    notification: "in-app",
    timezone: "Project timezone",
    dependency: "No dependency",
    budget: "$0.05 / run",
    cadence: "On change",
    nextRun: "When a snapshot changes",
    lastRun: "Yesterday · needs review",
    runs: 7,
    owner: "Current project",
    tone: "teal",
  },
  {
    id: "weekly-export",
    name: "Weekly workspace export",
    description: "Assemble a portable Markdown manifest for the user to inspect before download.",
    status: "paused",
    trigger: "schedule",
    triggerLabel: "Friday · 17:00",
    triggerDetail: "At 17:00 every Friday in the local preview timezone",
    action: "export",
    actionLabel: "Prepare manifest",
    scope: "workspace",
    connector: "email",
    connectorPermission: "draft-only",
    connectorIdentity: "Omnia · export drafter",
    auditRetention: "30-days",
    approval: "always-ask",
    retry: "three",
    missedRun: "ask",
    concurrency: "serial",
    notification: "in-app-email",
    timezone: "Local preview · UTC+07:00",
    dependency: "After weekly backup rehearsal",
    budget: "$0.10 / run",
    cadence: "Weekly",
    nextRun: "Paused · no run scheduled",
    lastRun: "Sep 12 · preview queued",
    runs: 4,
    owner: "Personal workspace",
    tone: "amber",
  },
  {
    id: "prompt-review",
    name: "Prompt review checklist",
    description: "Run a visible checklist before a long prompt is sent to the active chat.",
    status: "draft",
    trigger: "manual",
    triggerLabel: "Run from Chat",
    triggerDetail: "Only when the user starts a rehearsal from the active chat",
    action: "chat",
    actionLabel: "Open preflight",
    scope: "chat",
    connector: "none",
    connectorPermission: "not-connected",
    connectorIdentity: "Current chat",
    auditRetention: "session",
    approval: "auto-preview",
    retry: "none",
    missedRun: "skip",
    concurrency: "parallel-2",
    notification: "in-app-chat",
    timezone: "Conversation timezone",
    dependency: "No dependency",
    budget: "$0.00 preview",
    cadence: "Manual",
    nextRun: "Not scheduled",
    lastRun: "Never run",
    runs: 0,
    owner: "Current chat",
    tone: "coral",
  },
];

const seedRuns: readonly AutomationRun[] = [
  {
    id: "run-18",
    automationId: "morning-digest",
    automationName: "Morning research digest",
    status: "preview complete",
    detail: "4 visible sources · 2 claims · 0 provider calls",
    occurredAt: "Today · 08:30",
  },
  {
    id: "run-17",
    automationId: "repo-watch",
    automationName: "Repository drift watch",
    status: "needs review",
    detail: "2 changed cards · no filesystem read",
    occurredAt: "Yesterday · 16:12",
  },
  {
    id: "run-16",
    automationId: "weekly-export",
    automationName: "Weekly workspace export",
    status: "preview queued",
    detail: "Markdown manifest · browser download not started",
    occurredAt: "Sep 12 · 17:00",
  },
];

const triggerLabels: Record<AutomationTrigger, string> = {
  schedule: "Schedule",
  cron: "Cron expression",
  calendar: "Calendar event",
  event: "Event",
  email: "Email received",
  message: "Message received",
  file: "File change",
  git: "Git / CI event",
  webhook: "Webhook",
  "provider-health": "Provider health",
  budget: "Budget threshold",
  "machine-state": "Machine state",
  "artifact-completion": "Artifact completed",
  manual: "Manual",
};

const actionLabels: Record<AutomationAction, string> = {
  chat: "Open preflight",
  research: "Synthesize notebook",
  export: "Prepare manifest",
  notify: "Create attention item",
};

const scopeLabels: Record<AutomationScope, string> = {
  chat: "Current chat",
  project: "Current project",
  workspace: "Personal workspace",
};

const connectorLabels: Record<AutomationConnector, string> = {
  none: "No external connector",
  "google-calendar": "Google Calendar",
  "microsoft-calendar": "Microsoft Calendar",
  github: "GitHub / GitLab",
  slack: "Slack / Teams",
  email: "Email draft",
  webhook: "Webhook",
};

const connectorPermissionLabels: Record<AutomationConnectorPermission, string> = {
  "not-connected": "Not connected",
  "read-only": "Read only",
  "draft-only": "Draft only",
  "write-review": "Write with review",
};

const auditRetentionLabels: Record<AutomationAudit, string> = {
  session: "Session only",
  "30-days": "30-day preview",
  "forever-preview": "Keep in preview",
};

const approvalLabels: Record<AutomationApproval, string> = {
  "auto-preview": "Auto-preview",
  "review-changes": "Review changes",
  "always-ask": "Always ask",
};

const retryLabels: Record<AutomationRetry, string> = {
  none: "No retry",
  once: "Retry once",
  three: "Retry up to 3x",
};

const missedRunLabels: Record<AutomationMissedRun, string> = {
  skip: "Skip missed run",
  "catch-up": "Catch up once",
  ask: "Ask before catch-up",
};

const concurrencyLabels: Record<AutomationConcurrency, string> = {
  serial: "Serial · one at a time",
  "parallel-2": "Parallel · up to 2",
  "parallel-4": "Parallel · up to 4",
};

const notificationLabels: Record<AutomationNotification, string> = {
  "in-app": "In-app only",
  "in-app-email": "In-app + email draft",
  "in-app-chat": "In-app + chat draft",
};

const actionIcons: Record<AutomationAction, typeof BellRing> = {
  chat: WandSparkles,
  research: GitBranch,
  export: Download,
  notify: BellRing,
};

const tabLabels: Record<StudioTab, string> = {
  automations: "Automations",
  calendar: "Schedule",
  runs: "Run history",
};

const statusLabel: Record<AutomationStatus, string> = {
  active: "Active",
  paused: "Paused",
  draft: "Draft",
  archived: "Archived",
};

const cadenceTriggers: readonly AutomationTrigger[] = ["schedule", "cron", "calendar"];

function usesCadence(trigger: AutomationTrigger): boolean {
  return cadenceTriggers.includes(trigger);
}

function nextStatus(status: AutomationStatus): AutomationStatus {
  if (status === "active") return "paused";
  if (status === "paused") return "active";
  if (status === "archived") return "draft";
  return "active";
}

function statusTone(status: AutomationStatus): string {
  return `automation-studio__status automation-studio__status--${status}`;
}

function formatExport(automations: readonly Automation[], runs: readonly AutomationRun[]): string {
  return JSON.stringify(
    {
      schema: "omnia.automation-studio.preview.v1",
      scope: "renderer-session",
      executionDisposition: "preview-only",
      automations,
      runs,
      boundary: [
        "No durable schedule or trigger persistence",
        "No provider request, filesystem read, or external notification",
        "No native queue, agent dispatch, or automation receipt",
        "Connector scopes, timezone, missed-run, concurrency, and budget values are preview metadata",
      ],
    },
    null,
    2,
  );
}

type AutomationImportResult =
  | { readonly ok: true; readonly automations: Automation[]; readonly runs: AutomationRun[] }
  | { readonly ok: false; readonly error: string };

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function enumValue<T extends string>(value: unknown, values: readonly T[], fallback: T): T {
  return typeof value === "string" && values.includes(value as T) ? value as T : fallback;
}

function parseAutomationPreview(input: string): AutomationImportResult {
  if (input.length > 512 * 1024) {
    return { ok: false, error: "Automation preview imports are limited to 512 KB." };
  }
  try {
    const parsed = JSON.parse(input) as unknown;
    const root = recordValue(parsed);
    if (!root || root.schema !== "omnia.automation-studio.preview.v1") {
      return { ok: false, error: "Expected an Omnia automation preview export (schema v1)." };
    }
    if (!Array.isArray(root.automations) || !Array.isArray(root.runs)) {
      return { ok: false, error: "The preview must contain automations and runs arrays." };
    }
    if (root.automations.length > 200 || root.runs.length > 1_000) {
      return { ok: false, error: "The preview is too large: limit is 200 automations and 1,000 run records." };
    }
    const triggerValues = Object.keys(triggerLabels) as AutomationTrigger[];
    const actionValues = Object.keys(actionLabels) as AutomationAction[];
    const scopeValues = Object.keys(scopeLabels) as AutomationScope[];
    const connectorValues = Object.keys(connectorLabels) as AutomationConnector[];
    const permissionValues = Object.keys(connectorPermissionLabels) as AutomationConnectorPermission[];
    const approvalValues = Object.keys(approvalLabels) as AutomationApproval[];
    const retryValues = Object.keys(retryLabels) as AutomationRetry[];
    const missedRunValues = Object.keys(missedRunLabels) as AutomationMissedRun[];
    const concurrencyValues = Object.keys(concurrencyLabels) as AutomationConcurrency[];
    const notificationValues = Object.keys(notificationLabels) as AutomationNotification[];
    const auditValues = Object.keys(auditRetentionLabels) as AutomationAudit[];
    const statusValues = Object.keys(statusLabel) as AutomationStatus[];
    const importedAutomations: Automation[] = [];
    for (const candidate of root.automations) {
      const item = recordValue(candidate);
      if (!item || typeof item.id !== "string" || typeof item.name !== "string") {
        return { ok: false, error: "Every automation needs a string id and name." };
      }
      const trigger = enumValue(item.trigger, triggerValues, "manual");
      const action = enumValue(item.action, actionValues, "chat");
      const scope = enumValue(item.scope, scopeValues, "chat");
      const connector = enumValue(item.connector, connectorValues, "none");
      importedAutomations.push({
        id: item.id,
        name: item.name,
        description: stringValue(item.description, "Imported workflow preview."),
        status: enumValue(item.status, statusValues, "draft"),
        trigger,
        triggerLabel: stringValue(item.triggerLabel, triggerLabels[trigger]),
        triggerDetail: stringValue(item.triggerDetail, triggerLabels[trigger]),
        action,
        actionLabel: stringValue(item.actionLabel, actionLabels[action]),
        scope,
        connector,
        connectorPermission: enumValue(item.connectorPermission, permissionValues, "not-connected"),
        connectorIdentity: stringValue(item.connectorIdentity, "No connector identity"),
        auditRetention: enumValue(item.auditRetention, auditValues, "session"),
        approval: enumValue(item.approval, approvalValues, "review-changes"),
        retry: enumValue(item.retry, retryValues, "none"),
        missedRun: enumValue(item.missedRun, missedRunValues, "ask"),
        concurrency: enumValue(item.concurrency, concurrencyValues, "serial"),
        notification: enumValue(item.notification, notificationValues, "in-app"),
        timezone: stringValue(item.timezone, "Local preview"),
        dependency: stringValue(item.dependency, "No dependency"),
        budget: stringValue(item.budget, "$0.00 preview"),
        cadence: stringValue(item.cadence, triggerLabels[trigger]),
        nextRun: stringValue(item.nextRun, "Not scheduled"),
        lastRun: stringValue(item.lastRun, "Never run"),
        runs: typeof item.runs === "number" && Number.isFinite(item.runs) ? item.runs : 0,
        owner: stringValue(item.owner, "Imported preview"),
        tone: enumValue(item.tone, ["blue", "teal", "amber", "coral"] as const, "coral"),
      });
    }
    const importedRuns: AutomationRun[] = [];
    for (const candidate of root.runs) {
      const item = recordValue(candidate);
      if (!item || typeof item.id !== "string" || typeof item.automationId !== "string" || typeof item.automationName !== "string") {
        return { ok: false, error: "Every run record needs a string id, automationId, and automationName." };
      }
      importedRuns.push({
        id: item.id,
        automationId: item.automationId,
        automationName: item.automationName,
        status: enumValue(item.status, ["preview queued", "preview complete", "needs review"] as const, "preview queued"),
        detail: stringValue(item.detail, "Imported renderer preview."),
        occurredAt: stringValue(item.occurredAt, "Imported · renderer preview"),
      });
    }
    return { ok: true, automations: importedAutomations, runs: importedRuns };
  } catch {
    return { ok: false, error: "The import is not valid JSON." };
  }
}

export function AutomationStudioPreview() {
  const [automations, setAutomations] = useState<Automation[]>([...seedAutomations]);
  const [runs, setRuns] = useState<AutomationRun[]>([...seedRuns]);
  const [selectedId, setSelectedId] = useState(seedAutomations[0]?.id ?? "");
  const [tab, setTab] = useState<StudioTab>("automations");
  const [triggerFilter, setTriggerFilter] = useState<AutomationTrigger | "all">("all");
  const [statusFilter, setStatusFilter] = useState<AutomationStatus | "all">("all");
  const [query, setQuery] = useState("");
  const [builderOpen, setBuilderOpen] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftTrigger, setDraftTrigger] = useState<AutomationTrigger>("schedule");
  const [draftTriggerDetail, setDraftTriggerDetail] = useState("At the chosen cadence in the local preview timezone");
  const [draftCadence, setDraftCadence] = useState("Weekdays · 09:00");
  const [draftAction, setDraftAction] = useState<AutomationAction>("chat");
  const [draftScope, setDraftScope] = useState<AutomationScope>("chat");
  const [draftConnector, setDraftConnector] = useState<AutomationConnector>("none");
  const [draftConnectorPermission, setDraftConnectorPermission] = useState<AutomationConnectorPermission>("not-connected");
  const [draftConnectorIdentity, setDraftConnectorIdentity] = useState("No connector identity");
  const [draftAuditRetention, setDraftAuditRetention] = useState<AutomationAudit>("session");
  const [draftApproval, setDraftApproval] = useState<AutomationApproval>("review-changes");
  const [draftRetry, setDraftRetry] = useState<AutomationRetry>("none");
  const [draftMissedRun, setDraftMissedRun] = useState<AutomationMissedRun>("ask");
  const [draftConcurrency, setDraftConcurrency] = useState<AutomationConcurrency>("serial");
  const [draftNotification, setDraftNotification] = useState<AutomationNotification>("in-app");
  const [draftTimezone, setDraftTimezone] = useState("Local preview · UTC+07:00");
  const [draftDependency, setDraftDependency] = useState("No dependency");
  const [draftBudget, setDraftBudget] = useState("$0.10 / run");
  const [status, setStatus] = useState("Renderer-local automation projection.");
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importStatus, setImportStatus] = useState("Paste an Omnia automation preview export to stage it in this session.");

  const selected = automations.find((automation) => automation.id === selectedId) ?? automations[0];
  const visibleAutomations = useMemo(
    () => {
      const normalizedQuery = query.trim().toLocaleLowerCase();
      return automations.filter((automation) => {
        const matchesTrigger = triggerFilter === "all" || automation.trigger === triggerFilter;
        const matchesStatus = statusFilter === "all" || automation.status === statusFilter;
        const matchesQuery = !normalizedQuery || [automation.name, automation.description, automation.owner, automation.triggerLabel, automation.actionLabel, connectorLabels[automation.connector]].join(" ").toLocaleLowerCase().includes(normalizedQuery);
        return matchesTrigger && matchesStatus && matchesQuery;
      });
    },
    [automations, query, statusFilter, triggerFilter],
  );
  const activeCount = automations.filter((automation) => automation.status === "active").length;
  const pausedCount = automations.filter((automation) => automation.status === "paused").length;
  const scheduledCount = automations.filter((automation) => usesCadence(automation.trigger)).length;
  const exportPayload = useMemo(() => formatExport(automations, runs), [automations, runs]);

  const selectTab = (next: StudioTab) => setTab(next);
  const moveTab = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const tabIds = Object.keys(tabLabels) as StudioTab[];
    const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? tabIds.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabIds.length) % tabIds.length;
    const next = tabIds[nextIndex];
    if (next) {
      selectTab(next);
      requestAnimationFrame(() => document.getElementById(`automation-studio-tab-${next}`)?.focus());
    }
  };

  const toggleAutomation = (automationId: string) => {
    setAutomations((current) => current.map((automation) => automation.id === automationId ? { ...automation, status: nextStatus(automation.status) } : automation));
    const automation = automations.find((item) => item.id === automationId);
    if (automation) setStatus(`${automation.name} changed to ${statusLabel[nextStatus(automation.status)].toLowerCase()} in the preview.`);
  };

  const archiveAutomation = (automation: Automation) => {
    const next = automation.status === "archived" ? "draft" : "archived";
    setAutomations((current) => current.map((item) => item.id === automation.id ? { ...item, status: next } : item));
    setStatus(`${automation.name} ${next === "archived" ? "archived" : "restored as a draft"} in the renderer preview.`);
  };

  const duplicateAutomation = (automation: Automation) => {
    const copy: Automation = {
      ...automation,
      id: `automation-copy-${Date.now()}`,
      name: `${automation.name} · copy`,
      description: "Duplicated workflow draft for this renderer session.",
      status: "draft",
      owner: "Current session",
      runs: 0,
      nextRun: usesCadence(automation.trigger) ? automation.cadence : "Not scheduled",
      lastRun: "Never run",
    };
    setAutomations((current) => [...current, copy]);
    setSelectedId(copy.id);
    setStatus(`Duplicated ${automation.name} as a draft in the renderer preview.`);
  };

  const runPreview = (automation: Automation) => {
    const run: AutomationRun = {
      id: `run-${Date.now()}`,
      automationId: automation.id,
      automationName: automation.name,
      status: "preview queued",
      detail: `${automation.actionLabel} · no endpoint called`,
      occurredAt: "Just now · renderer preview",
    };
    setRuns((current) => [run, ...current]);
    setAutomations((current) => current.map((item) => item.id === automation.id ? { ...item, runs: item.runs + 1, lastRun: "Just now · preview queued" } : item));
    setStatus(`${automation.name} queued a renderer-local run preview; no provider or scheduler was called.`);
    setTab("runs");
  };

  const addAutomation = () => {
    const trimmed = draftName.trim();
    if (!trimmed) {
      setStatus("Name the automation before adding it to the preview.");
      return;
    }
    const id = `automation-${Date.now()}`;
    const created: Automation = {
      id,
      name: trimmed,
      description: "Custom workflow draft for this renderer session.",
      status: "draft",
      trigger: draftTrigger,
      triggerLabel: usesCadence(draftTrigger) ? draftCadence : triggerLabels[draftTrigger],
      triggerDetail: usesCadence(draftTrigger) ? draftTriggerDetail || `At ${draftCadence} in the local preview timezone` : draftTriggerDetail || triggerLabels[draftTrigger],
      action: draftAction,
      actionLabel: actionLabels[draftAction],
      scope: draftScope,
      connector: draftConnector,
      connectorPermission: draftConnectorPermission,
      connectorIdentity: draftConnectorIdentity,
      auditRetention: draftAuditRetention,
      approval: draftApproval,
      retry: draftRetry,
      missedRun: draftMissedRun,
      concurrency: draftConcurrency,
      notification: draftNotification,
      timezone: draftTimezone,
      dependency: draftDependency,
      budget: draftBudget,
      cadence: usesCadence(draftTrigger) ? draftCadence : triggerLabels[draftTrigger],
      nextRun: usesCadence(draftTrigger) ? draftCadence : "Not scheduled",
      lastRun: "Never run",
      runs: 0,
      owner: "Current session",
      tone: "coral",
    };
    setAutomations((current) => [...current, created]);
    setSelectedId(id);
    setDraftName("");
    setDraftTriggerDetail("At the chosen cadence in the local preview timezone");
    setDraftAction("chat");
    setDraftScope("chat");
    setDraftConnector("none");
    setDraftConnectorPermission("not-connected");
    setDraftConnectorIdentity("No connector identity");
    setDraftAuditRetention("session");
    setDraftApproval("review-changes");
    setDraftRetry("none");
    setDraftMissedRun("ask");
    setDraftConcurrency("serial");
    setDraftNotification("in-app");
    setDraftTimezone("Local preview · UTC+07:00");
    setDraftDependency("No dependency");
    setDraftBudget("$0.10 / run");
    setBuilderOpen(false);
    setStatus(`Added ${trimmed} as a draft automation in the renderer preview.`);
  };

  const reset = () => {
    setAutomations([...seedAutomations]);
    setRuns([...seedRuns]);
    setSelectedId(seedAutomations[0]?.id ?? "");
    setTriggerFilter("all");
    setStatusFilter("all");
    setQuery("");
    setBuilderOpen(false);
    setStatus("Automation preview reset for this session.");
    setImportText("");
    setImportStatus("Paste an Omnia automation preview export to stage it in this session.");
  };

  const stageImport = () => {
    const result = parseAutomationPreview(importText);
    if (result.ok === false) {
      setImportStatus(result.error);
      return;
    }
    setAutomations(result.automations);
    setRuns(result.runs);
    setSelectedId(result.automations[0]?.id ?? "");
    setImportStatus(`Staged ${result.automations.length} automation${result.automations.length === 1 ? "" : "s"} and ${result.runs.length} run preview${result.runs.length === 1 ? "" : "s"}.`);
    setStatus("Imported automation preview staged locally; no durable workflow was created.");
    setImportOpen(false);
  };

  const loadCurrentExport = () => {
    setImportText(exportPayload);
    setImportStatus("Loaded the current renderer export for editing before staging.");
  };

  const copyExport = async () => {
    if (!navigator.clipboard?.writeText) {
      setStatus("Clipboard unavailable; no automation preview was copied.");
      return;
    }
    try {
      await navigator.clipboard.writeText(exportPayload);
      setStatus("Copied the automation JSON preview; no durable export was created.");
    } catch {
      setStatus("Clipboard access was denied; the automation preview remains renderer-local.");
    }
  };

  const downloadExport = () => {
    const url = URL.createObjectURL(new Blob([exportPayload], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "omnia-automation-preview.json";
    anchor.click();
    URL.revokeObjectURL(url);
    setStatus("Browser download started; no native automation receipt was created.");
  };

  return (
    <section className="automation-studio" aria-labelledby="automation-studio-heading">
      <header className="automation-studio__header">
        <div>
          <span className="eyebrow"><Zap size={13} /> Automations · schedules · workflows</span>
          <h2 id="automation-studio-heading">Automation Studio</h2>
          <p>Design repeatable workflows, inspect trigger timing, and rehearse runs before any native scheduler exists.</p>
        </div>
        <div className="automation-studio__header-actions">
          <span className="automation-studio__badge"><Sparkles size={13} /> Preview only</span>
          <button type="button" className="button button--secondary" onClick={() => setBuilderOpen((open) => !open)} aria-expanded={builderOpen} aria-controls="automation-studio-builder"><Plus size={14} /> {builderOpen ? "Close builder" : "New automation"}</button>
        </div>
      </header>

      <p className="automation-studio__boundary"><Settings2 size={14} /> Renderer-local · no durable write · no provider request · no native scheduler, queue, notification, or agent dispatch.</p>

      <div className="automation-studio__summary" aria-label="Automation summary">
        <article><span><Zap size={14} /> Active</span><strong>{activeCount}</strong><small>ready in preview</small></article>
        <article><span><CalendarClock size={14} /> Scheduled</span><strong>{scheduledCount}</strong><small>calendar triggers</small></article>
        <article><span><Pause size={14} /> Paused</span><strong>{pausedCount}</strong><small>held locally</small></article>
        <article><span><ListChecks size={14} /> Preview runs</span><strong>{runs.length}</strong><small>visible history</small></article>
      </div>

      {builderOpen ? (
        <div id="automation-studio-builder" className="automation-studio__builder" aria-label="New automation builder">
          <div><span className="eyebrow">Draft a workflow</span><h3>Compose the guardrails</h3><p>Choose the trigger, action, scope, review gate, and retry policy. Only this renderer draft changes; native scheduling remains Planned.</p></div>
          <label><span>Name</span><input aria-label="Automation name" value={draftName} onChange={(event) => setDraftName(event.target.value)} placeholder="e.g. Weekly project pulse" /></label>
          <label><span>Trigger</span><select aria-label="Automation trigger" value={draftTrigger} onChange={(event) => setDraftTrigger(event.target.value as AutomationTrigger)}>{(Object.keys(triggerLabels) as AutomationTrigger[]).map((trigger) => <option key={trigger} value={trigger}>{triggerLabels[trigger]}</option>)}</select></label>
          {usesCadence(draftTrigger) ? <label><span>{draftTrigger === "cron" ? "Cron / cadence" : "Cadence"}</span><input aria-label="Automation cadence" value={draftCadence} onChange={(event) => setDraftCadence(event.target.value)} placeholder={draftTrigger === "cron" ? "e.g. 0 8 * * 1-5" : "e.g. Weekdays · 09:00"} /></label> : null}
          {draftTrigger !== "manual" ? <label><span>Trigger detail</span><input aria-label="Automation trigger detail" value={draftTriggerDetail} onChange={(event) => setDraftTriggerDetail(event.target.value)} placeholder={draftTrigger === "event" ? "e.g. Project snapshot changed" : `e.g. ${triggerLabels[draftTrigger]} source`} /></label> : null}
          <label><span>Action</span><select aria-label="Automation action" value={draftAction} onChange={(event) => setDraftAction(event.target.value as AutomationAction)}>{(Object.keys(actionLabels) as AutomationAction[]).map((action) => <option key={action} value={action}>{actionLabels[action]}</option>)}</select></label>
          <label><span>Scope</span><select aria-label="Automation scope" value={draftScope} onChange={(event) => setDraftScope(event.target.value as AutomationScope)}>{(Object.keys(scopeLabels) as AutomationScope[]).map((scope) => <option key={scope} value={scope}>{scopeLabels[scope]}</option>)}</select></label>
          <label><span>Connector</span><select aria-label="Automation connector" value={draftConnector} onChange={(event) => setDraftConnector(event.target.value as AutomationConnector)}>{(Object.keys(connectorLabels) as AutomationConnector[]).map((connector) => <option key={connector} value={connector}>{connectorLabels[connector]}</option>)}</select></label>
          <label><span>Connector permission</span><select aria-label="Automation connector permission" value={draftConnectorPermission} onChange={(event) => setDraftConnectorPermission(event.target.value as AutomationConnectorPermission)}>{(Object.keys(connectorPermissionLabels) as AutomationConnectorPermission[]).map((permission) => <option key={permission} value={permission}>{connectorPermissionLabels[permission]}</option>)}</select></label>
          <label><span>Connector identity</span><input aria-label="Automation connector identity" value={draftConnectorIdentity} onChange={(event) => setDraftConnectorIdentity(event.target.value)} /></label>
          <label><span>Audit retention</span><select aria-label="Automation audit retention" value={draftAuditRetention} onChange={(event) => setDraftAuditRetention(event.target.value as AutomationAudit)}>{(Object.keys(auditRetentionLabels) as AutomationAudit[]).map((retention) => <option key={retention} value={retention}>{auditRetentionLabels[retention]}</option>)}</select></label>
          <label><span>Review gate</span><select aria-label="Automation approval" value={draftApproval} onChange={(event) => setDraftApproval(event.target.value as AutomationApproval)}>{(Object.keys(approvalLabels) as AutomationApproval[]).map((approval) => <option key={approval} value={approval}>{approvalLabels[approval]}</option>)}</select></label>
          <label><span>Recovery</span><select aria-label="Automation retry" value={draftRetry} onChange={(event) => setDraftRetry(event.target.value as AutomationRetry)}>{(Object.keys(retryLabels) as AutomationRetry[]).map((retry) => <option key={retry} value={retry}>{retryLabels[retry]}</option>)}</select></label>
          <label><span>Missed run</span><select aria-label="Automation missed run" value={draftMissedRun} onChange={(event) => setDraftMissedRun(event.target.value as AutomationMissedRun)}>{(Object.keys(missedRunLabels) as AutomationMissedRun[]).map((policy) => <option key={policy} value={policy}>{missedRunLabels[policy]}</option>)}</select></label>
          <label><span>Concurrency</span><select aria-label="Automation concurrency" value={draftConcurrency} onChange={(event) => setDraftConcurrency(event.target.value as AutomationConcurrency)}>{(Object.keys(concurrencyLabels) as AutomationConcurrency[]).map((policy) => <option key={policy} value={policy}>{concurrencyLabels[policy]}</option>)}</select></label>
          <label><span>Notification route</span><select aria-label="Automation notification" value={draftNotification} onChange={(event) => setDraftNotification(event.target.value as AutomationNotification)}>{(Object.keys(notificationLabels) as AutomationNotification[]).map((route) => <option key={route} value={route}>{notificationLabels[route]}</option>)}</select></label>
          <label><span>Timezone</span><input aria-label="Automation timezone" value={draftTimezone} onChange={(event) => setDraftTimezone(event.target.value)} /></label>
          <label><span>Dependency gate</span><input aria-label="Automation dependency" value={draftDependency} onChange={(event) => setDraftDependency(event.target.value)} /></label>
          <label><span>Budget hint</span><input aria-label="Automation budget" value={draftBudget} onChange={(event) => setDraftBudget(event.target.value)} /></label>
          <button type="button" className="button button--primary" onClick={addAutomation}><Plus size={14} /> Add draft</button>
        </div>
      ) : null}

      <div className="automation-studio__tabs" role="tablist" aria-label="Automation studio views" aria-orientation="horizontal">
        {(Object.keys(tabLabels) as StudioTab[]).map((tabId, index) => <button key={tabId} id={`automation-studio-tab-${tabId}`} type="button" role="tab" aria-selected={tab === tabId} aria-controls={`automation-studio-panel-${tabId}`} tabIndex={tab === tabId ? 0 : -1} onClick={() => selectTab(tabId)} onKeyDown={(event) => moveTab(event, index)}>{tabLabels[tabId]}{tabId === "automations" ? ` ${automations.length}` : tabId === "runs" ? ` ${runs.length}` : ""}</button>)}
      </div>

      {tab === "automations" ? (
        <div id="automation-studio-panel-automations" className="automation-studio__panel" role="tabpanel" tabIndex={0} aria-labelledby="automation-studio-tab-automations">
          <div className="automation-studio__toolbar"><label className="automation-studio__search"><span>Search workflows</span><span className="automation-studio__search-control"><Search size={13} aria-hidden="true" /><input aria-label="Search automations" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Name, owner, trigger, connector" /></span></label><label><span>Trigger filter</span><select aria-label="Automation trigger filter" value={triggerFilter} onChange={(event) => setTriggerFilter(event.target.value as AutomationTrigger | "all")}><option value="all">All triggers</option>{(Object.keys(triggerLabels) as AutomationTrigger[]).map((trigger) => <option key={trigger} value={trigger}>{triggerLabels[trigger]}</option>)}</select></label><label><span>Status filter</span><select aria-label="Automation status filter" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as AutomationStatus | "all")}><option value="all">All statuses</option>{(Object.keys(statusLabel) as AutomationStatus[]).map((value) => <option key={value} value={value}>{statusLabel[value]}</option>)}</select></label><span role="status" aria-label="Automation studio status" aria-live="polite">{status} · {visibleAutomations.length} shown</span><button type="button" className="button button--ghost" onClick={() => setImportOpen((open) => !open)} aria-expanded={importOpen} aria-controls="automation-studio-import"><Upload size={13} /> {importOpen ? "Close import" : "Import preview"}</button><button type="button" className="button button--ghost" onClick={reset}><RotateCcw size={13} /> Reset</button></div>
          {importOpen ? <section id="automation-studio-import" className="automation-studio__import" aria-label="Import automation preview"><div><span className="eyebrow">Stage a portable definition</span><h3>Import automation preview</h3><p>Paste a JSON export, edit its renderer metadata, then stage it for this session. No native workflow or connector grant is created.</p></div><textarea aria-label="Automation JSON import" value={importText} onChange={(event) => setImportText(event.target.value)} placeholder="Paste omnia.automation-studio.preview.v1 JSON here" /><div className="automation-studio__import-actions"><button type="button" className="button button--secondary" onClick={loadCurrentExport}>Use current export</button><button type="button" className="button button--primary" onClick={stageImport}>Stage import</button></div><p className="automation-studio__import-status" role="status" aria-live="polite">{importStatus}</p></section> : null}
          <div className="automation-studio__layout">
            <div className="automation-studio__list" role="list" aria-label="Automation definitions">
              {visibleAutomations.map((automation) => { const Icon = actionIcons[automation.action]; const archived = automation.status === "archived"; return <article key={automation.id} className={`automation-studio__card automation-studio__card--${automation.tone}`} role="listitem"><button type="button" className="automation-studio__card-select" onClick={() => setSelectedId(automation.id)} aria-pressed={selectedId === automation.id}><span className="automation-studio__card-icon"><Icon size={16} /></span><span className="automation-studio__card-copy"><strong>{automation.name}</strong><small>{automation.description}</small></span><span className={statusTone(automation.status)}>{statusLabel[automation.status]}</span></button><div className="automation-studio__card-meta"><span><Clock3 size={13} /> {automation.triggerLabel}</span><span><GitBranch size={13} /> {automation.actionLabel}</span><span>{automation.runs} runs</span></div><div className="automation-studio__card-actions"><button type="button" className="button button--ghost" onClick={() => runPreview(automation)} disabled={archived}><Play size={13} /> Run preview</button><button type="button" className="button button--ghost" onClick={() => toggleAutomation(automation.id)} disabled={archived} aria-label={`${automation.status === "active" ? "Pause" : "Activate"} ${automation.name}`}>{automation.status === "active" ? <Pause size={13} /> : <Check size={13} />}{automation.status === "active" ? "Pause" : "Activate"}</button><button type="button" className="button button--ghost" onClick={() => duplicateAutomation(automation)} aria-label={`Duplicate ${automation.name}`}><Copy size={13} /> Duplicate</button><button type="button" className="button button--ghost" onClick={() => archiveAutomation(automation)} aria-label={`${archived ? "Restore" : "Archive"} ${automation.name}`}><Archive size={13} /> {archived ? "Restore" : "Archive"}</button></div></article>; })}
              {visibleAutomations.length === 0 ? <div className="automation-studio__empty">No automations match this trigger filter.</div> : null}
            </div>
             {selected ? <aside className="automation-studio__detail" aria-label="Selected automation details"><span className="eyebrow">Selected workflow</span><h3>{selected.name}</h3><p>{selected.description}</p><div className="automation-studio__detail-grid"><div><span>Trigger</span><strong>{triggerLabels[selected.trigger]}</strong><small>{selected.triggerLabel}</small></div><div><span>Action</span><strong>{selected.actionLabel}</strong><small>{selected.owner}</small></div><div><span>Scope</span><strong>{scopeLabels[selected.scope]}</strong><small>Visible context boundary</small></div><div><span>Connector</span><strong>{connectorLabels[selected.connector]}</strong><small>OAuth/scope approval remains Planned</small></div><div><span>Connector permission</span><strong>{connectorPermissionLabels[selected.connectorPermission]}</strong><small>No token lookup or grant</small></div><div><span>Connector identity</span><strong>{selected.connectorIdentity}</strong><small>Persona/identity is preview metadata</small></div><div><span>Audit retention</span><strong>{auditRetentionLabels[selected.auditRetention]}</strong><small>No durable audit ledger</small></div><div><span>Review gate</span><strong>{approvalLabels[selected.approval]}</strong><small>Approval remains Planned</small></div><div><span>Recovery</span><strong>{retryLabels[selected.retry]}</strong><small>No native retry queue</small></div><div><span>Missed run</span><strong>{missedRunLabels[selected.missedRun]}</strong><small>Scheduler policy is Planned</small></div><div><span>Concurrency</span><strong>{concurrencyLabels[selected.concurrency]}</strong><small>No native lease</small></div><div><span>Notification</span><strong>{notificationLabels[selected.notification]}</strong><small>No external message sent</small></div><div><span>Timezone</span><strong>{selected.timezone}</strong><small>Preview metadata only</small></div><div><span>Dependency</span><strong>{selected.dependency}</strong><small>Not evaluated natively</small></div><div><span>Budget hint</span><strong>{selected.budget}</strong><small>No provider usage recorded</small></div><div><span>Next run</span><strong>{selected.nextRun}</strong><small>{selected.cadence}</small></div><div><span>Last run</span><strong>{selected.lastRun}</strong><small>{selected.runs} preview runs</small></div></div><div className="automation-studio__steps"><span className="eyebrow">Workflow steps</span><ol><li><span>1</span><div><strong>Receive trigger</strong><small>{selected.triggerDetail}</small></div></li><li><span>2</span><div><strong>Prepare visible context</strong><small>{scopeLabels[selected.scope]} · renderer projection only</small></div></li><li><span>3</span><div><strong>{selected.actionLabel}</strong><small>No endpoint or native receipt</small></div></li><li><span>4</span><div><strong>{approvalLabels[selected.approval]}</strong><small>{retryLabels[selected.retry]} · no native queue</small></div></li><li><span>5</span><div><strong>Route attention</strong><small>{notificationLabels[selected.notification]} · external delivery remains Planned</small></div></li></ol></div><AutomationWorkflowPlanPreview key={selected.id} automationName={selected.name} scopeLabel={scopeLabels[selected.scope]} actionLabel={selected.actionLabel} connectorLabel={connectorLabels[selected.connector]} approvalRoute={selected.approval} /><button type="button" className="button button--primary" onClick={() => runPreview(selected)}><Play size={14} /> Rehearse selected run</button></aside> : null}
          </div>
        </div>
      ) : null}

      {tab === "calendar" ? <div id="automation-studio-panel-calendar" className="automation-studio__panel" role="tabpanel" tabIndex={0} aria-labelledby="automation-studio-tab-calendar"><div className="automation-studio__calendar-heading"><div><span className="eyebrow">Upcoming schedule</span><h3>Trigger calendar</h3><p>These are planned moments in the renderer projection, not an active background scheduler.</p></div><span className="automation-studio__calendar-note"><CalendarClock size={14} /> Timezone: local preview</span></div><div className="automation-studio__calendar">{automations.filter((automation) => usesCadence(automation.trigger)).map((automation) => <button type="button" key={automation.id} className="automation-studio__calendar-row" onClick={() => { setSelectedId(automation.id); setTab("automations"); }}><span className="automation-studio__calendar-time"><strong>{automation.nextRun.split("·")[1]?.trim() ?? "--:--"}</strong><small>{automation.cadence}</small></span><span><strong>{automation.name}</strong><small>{automation.triggerLabel} · {automation.status === "paused" ? "held in preview" : "visible schedule"}</small></span><span className={statusTone(automation.status)}>{statusLabel[automation.status]}</span></button>)}<div className="automation-studio__calendar-footer"><BellRing size={14} /> Event and manual triggers appear when their source surface is opened.</div></div></div> : null}

      {tab === "runs" ? <div id="automation-studio-panel-runs" className="automation-studio__panel" role="tabpanel" tabIndex={0} aria-labelledby="automation-studio-tab-runs"><div className="automation-studio__calendar-heading"><div><span className="eyebrow">Rehearsal timeline</span><h3>Run history</h3><p>Review what a workflow would do before wiring a scheduler, provider, or external side effect.</p></div><span className="automation-studio__calendar-note"><Check size={14} /> No endpoint called</span></div><div className="automation-studio__runs">{runs.map((run) => <article key={run.id} className="automation-studio__run"><span className={`automation-studio__run-dot automation-studio__run-dot--${run.status.replace(" ", "-")}`}><Check size={13} /></span><div><strong>{run.automationName}</strong><small>{run.detail}</small></div><span className="automation-studio__run-status">{run.status}</span><time>{run.occurredAt}</time></article>)}</div><div className="automation-studio__export"><div><span className="eyebrow">Portable preview</span><h3>Take the workflow definition with you</h3><p>Export metadata and visible rehearsal history. Secrets, generated bytes, and native receipts are excluded.</p></div><div className="automation-studio__export-actions"><button type="button" className="button button--secondary" onClick={() => void copyExport()}><Clipboard size={13} /> Copy JSON</button><button type="button" className="button button--secondary" onClick={downloadExport}><Download size={13} /> Download</button></div><pre aria-label="Automation export JSON preview">{exportPayload}</pre></div></div> : null}
    </section>
  );
}

export default AutomationStudioPreview;
