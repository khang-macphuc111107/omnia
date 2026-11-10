import {
  Bookmark,
  Check,
  CheckCircle2,
  CircleDot,
  Database,
  Download,
  FileArchive,
  HardDrive,
  Info,
  Laptop,
  LockKeyhole,
  Monitor,
  Plus,
  Redo2,
  RotateCcw,
  Search,
  Shield,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Undo2,
  Upload,
  Wifi,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AppRuntimeInfo } from "@/lib/desktop";
import { createDesktopSettingsPermissionsAdapter } from "@/lib/settings-permissions-persistence";
import {
  createSettingsPermissionsSnapshot,
  updateSettingsPermissionsSnapshot,
  type OmniaSettingsPermissionsSnapshot,
} from "@/domain/omnia-settings-permissions-adapter";

export type SettingsControlSection =
  | "privacy"
  | "storage"
  | "network"
  | "desktop"
  | "diagnostics";

type SettingValue = boolean | number | string;
type ControlKind = "toggle" | "select" | "text" | "number";

interface ControlOption {
  value: string;
  label: string;
}

interface ControlDefinition {
  id: string;
  label: string;
  description: string;
  kind: ControlKind;
  defaultValue: SettingValue;
  group: "Essentials" | "Advanced";
  options?: readonly ControlOption[];
  placeholder?: string;
  min?: number;
  max?: number;
  suffix?: string;
}

interface SectionDefinition {
  id: SettingsControlSection;
  label: string;
  eyebrow: string;
  description: string;
  boundary: string;
  icon: LucideIcon;
  accent: string;
  controls: readonly ControlDefinition[];
}

type SectionValues = Record<string, SettingValue>;

type SettingsPresetTone = "mint" | "amber" | "blue" | "coral" | "violet";

interface SettingsPreset {
  id: string;
  name: string;
  description: string;
  tone: SettingsPresetTone;
  section: SettingsControlSection;
  values: SectionValues;
  builtIn: boolean;
}

interface HistoryState {
  past: SectionValues[];
  present: SectionValues;
  future: SectionValues[];
}

const option = (value: string, label: string): ControlOption => ({ value, label });

const SECTIONS: readonly SectionDefinition[] = [
  {
    id: "privacy",
    label: "Privacy & memory",
    eyebrow: "Local-first controls",
    description: "Shape retention, memory proposals, and redaction defaults before native policy is connected.",
    boundary: "These switches only change this renderer preview. Native retention, encryption, memory writes, and audit receipts are not connected.",
    icon: Shield,
    accent: "mint",
    controls: [
      {
        id: "memoryRetention",
        label: "Memory retention",
        description: "How long a proposed memory stays eligible for review.",
        kind: "select",
        defaultValue: "90-days",
        group: "Essentials",
        options: [option("session", "Session only"), option("30-days", "30 days"), option("90-days", "90 days"), option("forever", "Until removed")],
      },
      {
        id: "proposeMemories",
        label: "Suggest memories from chats",
        description: "Show a review card when the assistant detects a reusable preference or fact.",
        kind: "toggle",
        defaultValue: true,
        group: "Essentials",
      },
      {
        id: "redactSensitive",
        label: "Redact sensitive fields in previews",
        description: "Mask likely tokens, email addresses, and local paths in renderer diagnostics.",
        kind: "toggle",
        defaultValue: true,
        group: "Essentials",
      },
      {
        id: "learningLog",
        label: "Keep a learning proposal log",
        description: "Preview the provenance trail without committing any memory to native storage.",
        kind: "toggle",
        defaultValue: true,
        group: "Advanced",
      },
      {
        id: "conversationIndexing",
        label: "Conversation indexing scope",
        description: "Choose which conversations the future retrieval index may consider.",
        kind: "select",
        defaultValue: "active-project",
        group: "Advanced",
        options: [option("active-chat", "Active chat"), option("active-project", "Active project"), option("all-local", "All local chats")],
      },
    ],
  },
  {
    id: "storage",
    label: "Storage & backup",
    eyebrow: "Durable data preview",
    description: "Make storage intent visible: workspace roots, attachment budgets, and recovery posture.",
    boundary: "No files are moved, deleted, uploaded, or persisted by these controls. Native database, blob, backup, and recovery services remain planned.",
    icon: HardDrive,
    accent: "amber",
    controls: [
      {
        id: "workspaceRoot",
        label: "Workspace root hint",
        description: "A renderer-only label for the folder you expect Omnia to use later.",
        kind: "text",
        defaultValue: "C:\\Users\\khang\\source\\repos\\omnia",
        group: "Essentials",
        placeholder: "Choose a workspace root later",
      },
      {
        id: "attachmentQuota",
        label: "Attachment budget",
        description: "Preview the maximum local attachment footprint for a project.",
        kind: "select",
        defaultValue: "2-gb",
        group: "Essentials",
        options: [option("512-mb", "512 MB"), option("2-gb", "2 GB"), option("10-gb", "10 GB"), option("unlimited", "No preview limit")],
      },
      {
        id: "snapshots",
        label: "Create recovery snapshots",
        description: "Show snapshot affordances in the UI before a native scheduler exists.",
        kind: "toggle",
        defaultValue: true,
        group: "Essentials",
      },
      {
        id: "backupFormat",
        label: "Preferred export format",
        description: "Select the future interchange format for projects and settings.",
        kind: "select",
        defaultValue: "zip-json",
        group: "Advanced",
        options: [option("zip-json", "ZIP + JSON manifest"), option("jsonl", "JSONL event log"), option("markdown", "Markdown bundle")],
      },
      {
        id: "keepVersions",
        label: "Keep previous versions",
        description: "Retain a visible revision history when native storage is implemented.",
        kind: "number",
        defaultValue: 12,
        group: "Advanced",
        min: 1,
        max: 100,
        suffix: "revisions",
      },
    ],
  },
  {
    id: "network",
    label: "Network & transport",
    eyebrow: "Provider boundary",
    description: "Preview timeout, proxy, TLS, and offline behavior without touching provider credentials.",
    boundary: "No network request is made from this panel. Provider credentials remain behind the native secret boundary; transport policy is not persisted here.",
    icon: Wifi,
    accent: "blue",
    controls: [
      {
        id: "transport",
        label: "Transport mode",
        description: "The future default route for provider requests.",
        kind: "select",
        defaultValue: "https-only",
        group: "Essentials",
        options: [option("https-only", "HTTPS only"), option("local-first", "Local first"), option("offline", "Offline preview")],
      },
      {
        id: "requestTimeout",
        label: "Request timeout",
        description: "How long a provider request may wait before becoming degraded.",
        kind: "number",
        defaultValue: 45,
        group: "Essentials",
        min: 5,
        max: 300,
        suffix: "seconds",
      },
      {
        id: "proxyMode",
        label: "Proxy strategy",
        description: "Keep proxy behavior explicit instead of silently inheriting credentials.",
        kind: "select",
        defaultValue: "system",
        group: "Essentials",
        options: [option("system", "Use Windows proxy"), option("direct", "Direct connection"), option("manual", "Manual endpoint")],
      },
      {
        id: "strictTls",
        label: "Require strict TLS",
        description: "Reject unsafe schemes and invalid certificates when native validation is available.",
        kind: "toggle",
        defaultValue: true,
        group: "Advanced",
      },
      {
        id: "offlineFallback",
        label: "Allow offline fallback",
        description: "Keep chat composition available when a provider is unavailable.",
        kind: "toggle",
        defaultValue: true,
        group: "Advanced",
      },
    ],
  },
  {
    id: "desktop",
    label: "Desktop & shortcuts",
    eyebrow: "Windows workspace",
    description: "Tune the desktop shell and keyboard affordances before native startup integration is enabled.",
    boundary: "No startup task, global hook, tray setting, or shortcut is changed by this preview. Native desktop integration remains separately gated.",
    icon: Laptop,
    accent: "coral",
    controls: [
      {
        id: "launchAtLogin",
        label: "Launch Omnia with Windows",
        description: "Preview the startup preference without registering a task.",
        kind: "toggle",
        defaultValue: false,
        group: "Essentials",
      },
      {
        id: "trayMode",
        label: "Window close behavior",
        description: "Choose the future default when the close button is pressed.",
        kind: "select",
        defaultValue: "ask",
        group: "Essentials",
        options: [option("ask", "Ask every time"), option("minimize", "Minimize to tray"), option("quit", "Quit Omnia")],
      },
      {
        id: "shortcut",
        label: "Command palette shortcut",
        description: "The keyboard chord shown in the shell preview.",
        kind: "text",
        defaultValue: "Ctrl+K",
        group: "Essentials",
        placeholder: "Example: Ctrl+K",
      },
      {
        id: "confirmDestructive",
        label: "Confirm destructive actions",
        description: "Keep an explicit confirmation step for remove, reset, and revoke actions.",
        kind: "toggle",
        defaultValue: true,
        group: "Advanced",
      },
      {
        id: "updateChannel",
        label: "Update channel",
        description: "Display the future release lane without downloading anything.",
        kind: "select",
        defaultValue: "stable",
        group: "Advanced",
        options: [option("stable", "Stable"), option("preview", "Preview"), option("nightly", "Nightly")],
      },
    ],
  },
  {
    id: "diagnostics",
    label: "Diagnostics & export",
    eyebrow: "Evidence and support",
    description: "Control what a future redacted diagnostics bundle could contain and how it is presented.",
    boundary: "Export actions in this panel are renderer-only previews. No prompt bodies, credentials, cookies, or raw secret material are collected.",
    icon: FileArchive,
    accent: "violet",
    controls: [
      {
        id: "logLevel",
        label: "Log detail",
        description: "Choose the amount of non-sensitive UI/runtime metadata to show.",
        kind: "select",
        defaultValue: "info",
        group: "Essentials",
        options: [option("errors", "Errors only"), option("info", "Info"), option("debug", "Debug preview")],
      },
      {
        id: "traceWindow",
        label: "Trace window",
        description: "The visible time window for renderer event summaries.",
        kind: "select",
        defaultValue: "15-min",
        group: "Essentials",
        options: [option("5-min", "5 minutes"), option("15-min", "15 minutes"), option("session", "Current session")],
      },
      {
        id: "includeUiEvents",
        label: "Include UI event summary",
        description: "Include route, tab, and render timings while excluding prompt contents.",
        kind: "toggle",
        defaultValue: true,
        group: "Essentials",
      },
      {
        id: "includeProviderMetadata",
        label: "Include provider metadata",
        description: "Include provider names and health states, never credentials or payloads.",
        kind: "toggle",
        defaultValue: true,
        group: "Advanced",
      },
      {
        id: "autoShareReports",
        label: "Automatically share reports",
        description: "Keep disabled until an explicit destination and consent flow exists.",
        kind: "toggle",
        defaultValue: false,
        group: "Advanced",
      },
    ],
  },
] as const;

const DEFAULTS: Record<SettingsControlSection, SectionValues> = Object.fromEntries(
  SECTIONS.map((definition) => [
    definition.id,
    Object.fromEntries(definition.controls.map((control) => [control.id, control.defaultValue])),
  ]),
) as Record<SettingsControlSection, SectionValues>;

function valuesWithDefaults(
  section: SettingsControlSection,
  overrides: SectionValues,
): SectionValues {
  return { ...DEFAULTS[section], ...overrides };
}

const BUILT_IN_PRESETS: Record<SettingsControlSection, readonly SettingsPreset[]> = {
  privacy: [
    {
      id: "privacy-review-friendly",
      name: "Review-friendly",
      description: "Keep proposals visible while limiting their default lifetime.",
      tone: "mint",
      section: "privacy",
      values: valuesWithDefaults("privacy", { memoryRetention: "30-days" }),
      builtIn: true,
    },
    {
      id: "privacy-minimal",
      name: "Minimal retention",
      description: "Session-only memory, active-chat indexing, and no learning log.",
      tone: "blue",
      section: "privacy",
      values: valuesWithDefaults("privacy", {
        memoryRetention: "session",
        proposeMemories: false,
        learningLog: false,
        conversationIndexing: "active-chat",
      }),
      builtIn: true,
    },
    {
      id: "privacy-research",
      name: "Research continuity",
      description: "Longer-lived proposals and broader local retrieval for research sessions.",
      tone: "violet",
      section: "privacy",
      values: valuesWithDefaults("privacy", {
        memoryRetention: "forever",
        conversationIndexing: "all-local",
      }),
      builtIn: true,
    },
  ],
  storage: [
    {
      id: "storage-portable-project",
      name: "Portable project",
      description: "A compact JSONL-friendly project setup with recovery snapshots on.",
      tone: "amber",
      section: "storage",
      values: valuesWithDefaults("storage", { backupFormat: "jsonl" }),
      builtIn: true,
    },
    {
      id: "storage-lean-local",
      name: "Lean local",
      description: "Small attachment budget and no snapshot preview for quick experiments.",
      tone: "blue",
      section: "storage",
      values: valuesWithDefaults("storage", {
        attachmentQuota: "512-mb",
        snapshots: false,
        backupFormat: "markdown",
        keepVersions: 3,
      }),
      builtIn: true,
    },
    {
      id: "storage-recovery-heavy",
      name: "Recovery-heavy",
      description: "More attachment headroom, ZIP manifests, and a deeper revision window.",
      tone: "mint",
      section: "storage",
      values: valuesWithDefaults("storage", {
        attachmentQuota: "10-gb",
        keepVersions: 40,
      }),
      builtIn: true,
    },
  ],
  network: [
    {
      id: "network-cloud-standard",
      name: "Cloud standard",
      description: "HTTPS-first transport with system proxy and offline composition fallback.",
      tone: "blue",
      section: "network",
      values: valuesWithDefaults("network", {}),
      builtIn: true,
    },
    {
      id: "network-local-first",
      name: "Local-first",
      description: "Prefer a local route while keeping strict TLS and a generous timeout.",
      tone: "mint",
      section: "network",
      values: valuesWithDefaults("network", {
        transport: "local-first",
        requestTimeout: 60,
      }),
      builtIn: true,
    },
    {
      id: "network-offline-handoff",
      name: "Offline handoff",
      description: "Make composition resilient when a provider is unavailable or intentionally paused.",
      tone: "amber",
      section: "network",
      values: valuesWithDefaults("network", {
        transport: "offline",
        requestTimeout: 15,
        proxyMode: "direct",
      }),
      builtIn: true,
    },
  ],
  desktop: [
    {
      id: "desktop-quiet",
      name: "Quiet desktop",
      description: "Ask before closing, keep confirmations, and stay on the stable update lane.",
      tone: "blue",
      section: "desktop",
      values: valuesWithDefaults("desktop", {}),
      builtIn: true,
    },
    {
      id: "desktop-power-user",
      name: "Power user",
      description: "Start with Windows, minimize to tray, and expose a fast command shortcut.",
      tone: "coral",
      section: "desktop",
      values: valuesWithDefaults("desktop", {
        launchAtLogin: true,
        trayMode: "minimize",
        shortcut: "Ctrl+Shift+K",
        confirmDestructive: false,
        updateChannel: "preview",
      }),
      builtIn: true,
    },
    {
      id: "desktop-cautious",
      name: "Cautious updates",
      description: "Keep the shell explicit and every destructive action behind confirmation.",
      tone: "amber",
      section: "desktop",
      values: valuesWithDefaults("desktop", {
        shortcut: "Ctrl+Alt+K",
        updateChannel: "stable",
      }),
      builtIn: true,
    },
  ],
  diagnostics: [
    {
      id: "diagnostics-support-safe",
      name: "Support-safe",
      description: "Show useful UI and provider metadata without sharing reports automatically.",
      tone: "mint",
      section: "diagnostics",
      values: valuesWithDefaults("diagnostics", {}),
      builtIn: true,
    },
    {
      id: "diagnostics-developer-trace",
      name: "Developer trace",
      description: "Open a session-wide debug window while keeping automatic sharing disabled.",
      tone: "violet",
      section: "diagnostics",
      values: valuesWithDefaults("diagnostics", {
        logLevel: "debug",
        traceWindow: "session",
      }),
      builtIn: true,
    },
    {
      id: "diagnostics-quiet",
      name: "Quiet diagnostics",
      description: "Keep only error-level summaries and the smallest visible trace window.",
      tone: "blue",
      section: "diagnostics",
      values: valuesWithDefaults("diagnostics", {
        logLevel: "errors",
        traceWindow: "5-min",
        includeUiEvents: false,
        includeProviderMetadata: false,
      }),
      builtIn: true,
    },
  ],
};

function cloneValues(values: SectionValues): SectionValues {
  return { ...values };
}

function createHistoryMap(): Record<SettingsControlSection, HistoryState> {
  const map = {} as Record<SettingsControlSection, HistoryState>;
  for (const definition of SECTIONS) {
    map[definition.id] = { past: [], present: cloneValues(DEFAULTS[definition.id]), future: [] };
  }
  return map;
}

function displayValue(value: SettingValue): string {
  if (typeof value === "boolean") return value ? "On" : "Off";
  return String(value);
}

type PreviewPayload = {
  scope: "renderer-preview";
  version: 1;
  section: SettingsControlSection;
  values: SectionValues;
  customPresets: PortablePreset[];
};

type PreviewBundlePayload = {
  scope: "renderer-preview-bundle";
  version: 1;
  sections: Record<SettingsControlSection, SectionValues>;
  customPresets: Record<SettingsControlSection, PortablePreset[]>;
};

type PortableScope = "section" | "all";

type PortablePreset = {
  id: string;
  name: string;
  description: string;
  tone: SettingsPresetTone;
  values: SectionValues;
};

const SETTINGS_PRESET_TONES: readonly SettingsPresetTone[] = ["mint", "amber", "blue", "coral", "violet"];

function toPortablePreset(preset: SettingsPreset): PortablePreset {
  return {
    id: preset.id,
    name: preset.name,
    description: preset.description,
    tone: preset.tone,
    values: cloneValues(preset.values),
  };
}

function portablePresets(presets: readonly SettingsPreset[]): PortablePreset[] {
  return presets.filter((preset) => !preset.builtIn).map(toPortablePreset);
}

function presetValuesEqual(left: SettingsPreset, right: SettingsPreset): boolean {
  return left.id === right.id
    && left.name === right.name
    && left.description === right.description
    && left.tone === right.tone
    && valuesEqual(left.values, right.values);
}

function presetListsEqual(left: readonly SettingsPreset[], right: readonly SettingsPreset[]): boolean {
  return left.length === right.length && left.every((preset, index) => {
    const candidate = right[index];
    return candidate !== undefined && presetValuesEqual(preset, candidate);
  });
}

function mergeCustomPresets(
  existing: readonly SettingsPreset[],
  incoming: readonly SettingsPreset[],
): SettingsPreset[] {
  const merged = existing.map((preset) => ({ ...preset, values: cloneValues(preset.values) }));
  for (const preset of incoming) {
    const duplicateIndex = merged.findIndex((candidate) => (
      candidate.id === preset.id
      || candidate.name.trim().toLowerCase() === preset.name.trim().toLowerCase()
    ));
    const next = { ...preset, builtIn: false, values: cloneValues(preset.values) };
    if (duplicateIndex >= 0) merged[duplicateIndex] = next;
    else merged.push(next);
  }
  return merged.slice(-12);
}

function normalizeImportedPresetId(rawId: unknown, name: string, definition: SectionDefinition): string {
  const source = typeof rawId === "string" ? rawId : "";
  const normalized = source.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96);
  const fallback = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "preset").slice(0, 72);
  const candidate = normalized || `imported-${fallback}`;
  const collidesWithBuiltIn = (BUILT_IN_PRESETS[definition.id] ?? []).some((preset) => preset.id === candidate);
  return collidesWithBuiltIn ? `imported-${candidate}` : candidate;
}

function validateImportedPreset(
  raw: unknown,
  definition: SectionDefinition,
): { ok: true; preset: SettingsPreset; warnings: string[] } | { ok: false; error: string } {
  if (!isRecord(raw)) return { ok: false, error: "A preset entry is not a JSON object." };
  const name = typeof raw.name === "string" ? raw.name.trim().slice(0, 80) : "";
  if (!name) return { ok: false, error: "A preset entry is missing a name." };
  const description = typeof raw.description === "string" && raw.description.trim()
    ? raw.description.trim().slice(0, 180)
    : "An imported renderer-local Control Center snapshot.";
  const tone = typeof raw.tone === "string" && SETTINGS_PRESET_TONES.includes(raw.tone as SettingsPresetTone)
    ? raw.tone as SettingsPresetTone
    : definition.accent as SettingsPresetTone;
  const result = validatePreviewPayload(
    { scope: "renderer-preview", version: 1, section: definition.id, values: raw.values },
    definition,
    DEFAULTS[definition.id],
  );
  if (!result.ok) return { ok: false, error: result.error };
  return {
    ok: true,
    preset: {
      id: normalizeImportedPresetId(raw.id, name, definition),
      name,
      description,
      tone,
      section: definition.id,
      values: result.values,
      builtIn: false,
    },
    warnings: result.warnings,
  };
}

function validateImportedPresets(
  raw: unknown,
  definition: SectionDefinition,
): { presets: SettingsPreset[]; warnings: string[]; present: boolean } {
  if (raw === undefined) return { presets: [], warnings: [], present: false };
  if (!Array.isArray(raw)) {
    return { presets: [], warnings: [`${definition.label}: customPresets must be an array`], present: true };
  }
  const presets: SettingsPreset[] = [];
  const warnings: string[] = [];
  for (const entry of raw.slice(0, 12)) {
    const result = validateImportedPreset(entry, definition);
    if (!result.ok) {
      warnings.push(`${definition.label}: ignored preset (${result.error})`);
      continue;
    }
    if (result.warnings.length > 0) {
      warnings.push(`${definition.label}: ${result.preset.name} used defaults for ${result.warnings.join(", ")}`);
    }
    presets.push(result.preset);
  }
  if (raw.length > 12) warnings.push(`${definition.label}: ignored ${raw.length - 12} presets beyond the 12-preset session limit`);
  return { presets, warnings, present: true };
}

function createPreviewPayload(
  section: SettingsControlSection,
  values: SectionValues,
  presets: readonly SettingsPreset[],
): PreviewPayload {
  return {
    scope: "renderer-preview",
    version: 1,
    section,
    values: cloneValues(values),
    customPresets: portablePresets(presets),
  };
}

function createPreviewBundlePayload(
  history: Record<SettingsControlSection, HistoryState>,
  customPresets: Record<SettingsControlSection, SettingsPreset[]>,
): PreviewBundlePayload {
  return {
    scope: "renderer-preview-bundle",
    version: 1,
    sections: Object.fromEntries(
      SECTIONS.map((definition) => [definition.id, cloneValues(history[definition.id].present)]),
    ) as Record<SettingsControlSection, SectionValues>,
    customPresets: Object.fromEntries(
      SECTIONS.map((definition) => [definition.id, portablePresets(customPresets[definition.id] ?? [])]),
    ) as Record<SettingsControlSection, PortablePreset[]>,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validatePreviewPayload(
  raw: unknown,
  definition: SectionDefinition,
  currentValues: SectionValues,
): { ok: true; values: SectionValues; warnings: string[] } | { ok: false; error: string } {
  if (!isRecord(raw)) return { ok: false, error: "The selected file is not a JSON object." };
  if (raw.scope !== "renderer-preview") {
    return { ok: false, error: "This file is not an Omnia renderer preview snapshot." };
  }
  if (raw.version !== 1) {
    return { ok: false, error: "This renderer preview snapshot uses an unsupported version." };
  }
  if (raw.section !== definition.id) {
    return { ok: false, error: `This snapshot belongs to ${String(raw.section ?? "another section")}, not ${definition.label}.` };
  }
  if (!isRecord(raw.values)) return { ok: false, error: "The preview snapshot does not contain a values object." };

  const values = cloneValues(currentValues);
  const warnings: string[] = [];
  for (const control of definition.controls) {
    if (!(control.id in raw.values)) continue;
    const candidate = raw.values[control.id];
    let valid = false;
    if (control.kind === "toggle") {
      valid = typeof candidate === "boolean";
    } else if (control.kind === "number") {
      valid = typeof candidate === "number" && Number.isFinite(candidate)
        && (control.min === undefined || candidate >= control.min)
        && (control.max === undefined || candidate <= control.max);
    } else if (control.kind === "select") {
      valid = typeof candidate === "string" && Boolean(control.options?.some((item) => item.value === candidate));
    } else {
      valid = typeof candidate === "string";
    }
    if (valid) values[control.id] = candidate as SettingValue;
    else warnings.push(control.label);
  }
  if (warnings.length > 0) {
    return { ok: true, values, warnings };
  }
  return { ok: true, values, warnings: [] };
}

function validatePreviewBundlePayload(
  raw: unknown,
  currentHistory: Record<SettingsControlSection, HistoryState>,
): {
  ok: true;
  valuesBySection: Partial<Record<SettingsControlSection, SectionValues>>;
  presetsBySection: Partial<Record<SettingsControlSection, SettingsPreset[]>>;
  presetPayloadPresent: boolean;
  warnings: string[];
} | { ok: false; error: string } {
  if (!isRecord(raw)) return { ok: false, error: "The selected file is not a JSON object." };
  if (raw.scope !== "renderer-preview-bundle") {
    return { ok: false, error: "This file is not an Omnia all-sections renderer preview bundle." };
  }
  if (raw.version !== 1) {
    return { ok: false, error: "This renderer preview bundle uses an unsupported version." };
  }
  if (!isRecord(raw.sections)) {
    return { ok: false, error: "The renderer preview bundle does not contain a sections object." };
  }

  const valuesBySection: Partial<Record<SettingsControlSection, SectionValues>> = {};
  const presetsBySection: Partial<Record<SettingsControlSection, SettingsPreset[]>> = {};
  const rawPresetSections = raw.customPresets;
  const hasPresetPayload = rawPresetSections !== undefined;
  if (hasPresetPayload && !isRecord(rawPresetSections)) {
    return { ok: false, error: "The renderer preview bundle customPresets field must be an object." };
  }
  const warnings: string[] = [];
  for (const definition of SECTIONS) {
    const sectionValues = raw.sections[definition.id];
    if (sectionValues === undefined) {
      warnings.push(`${definition.label} was not included`);
    } else {
      const result = validatePreviewPayload(
        { scope: "renderer-preview", version: 1, section: definition.id, values: sectionValues },
        definition,
        currentHistory[definition.id].present,
      );
      if (!result.ok) {
        warnings.push(`${definition.label}: ${result.error}`);
      } else {
        valuesBySection[definition.id] = result.values;
        warnings.push(...result.warnings.map((warning) => `${definition.label}: ignored ${warning}`));
      }
    }

    // Presets are independently portable from section values. A bundle may
    // intentionally carry only custom presets, or preserve presets even when
    // one section's values are malformed, so validate this field separately.
    const presetResult = validateImportedPresets(
      isRecord(rawPresetSections) ? rawPresetSections[definition.id] : undefined,
      definition,
    );
    if (presetResult.present) {
      presetsBySection[definition.id] = presetResult.presets;
      warnings.push(...presetResult.warnings);
    }
  }
  return {
    ok: true,
    valuesBySection,
    presetsBySection,
    presetPayloadPresent: hasPresetPayload,
    warnings,
  };
}

function valuesEqual(left: SectionValues, right: SectionValues): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].every((key) => Object.is(left[key], right[key]));
}

function readPreviewFile(file: File): Promise<string> {
  if (typeof file.text === "function") return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("The preview file could not be read."));
    reader.readAsText(file);
  });
}

export interface SettingsControlCenterProps {
  section: SettingsControlSection;
  /** Native persistence is opt-in so browser previews and tests stay renderer-local. */
  runtime?: AppRuntimeInfo;
}

function nativeSectionValues(
  snapshot: OmniaSettingsPermissionsSnapshot,
  section: SettingsControlSection,
): SectionValues | null {
  const candidate = snapshot.settings.values[section];
  if (!isRecord(candidate)) return null;
  const values: SectionValues = {};
  for (const [key, value] of Object.entries(candidate)) {
    if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
      values[key] = value;
    }
  }
  return values;
}

export function SettingsControlCenter({ section, runtime }: SettingsControlCenterProps) {
  const definition = SECTIONS.find((candidate) => candidate.id === section) ?? SECTIONS[0]!;
  const [history, setHistory] = useState<Record<SettingsControlSection, HistoryState>>(
    createHistoryMap,
  );
  const [customPresets, setCustomPresets] = useState<
    Record<SettingsControlSection, SettingsPreset[]>
  >(() =>
    Object.fromEntries(SECTIONS.map((candidate) => [candidate.id, []])) as unknown as Record<
      SettingsControlSection,
      SettingsPreset[]
    >,
  );
  const [customPresetName, setCustomPresetName] = useState("");
  const [filter, setFilter] = useState("");
  const [status, setStatus] = useState("Preview values stay in this panel until the page is reloaded.");
  const [portableScope, setPortableScope] = useState<PortableScope>("section");
  const importInputRef = useRef<HTMLInputElement>(null);
  const nativeAdapterRef = useRef<ReturnType<typeof createDesktopSettingsPermissionsAdapter> | null>(null);
  const nativeSnapshotRef = useRef<OmniaSettingsPermissionsSnapshot | null>(null);
  const nativeHydratedRef = useRef(false);
  const nativeHasPersistedRevisionRef = useRef(false);
  const nativeSaveTimerRef = useRef<number | null>(null);
  const nativePendingSaveRef = useRef<(() => void) | null>(null);
  const nativeSaveChainRef = useRef<Promise<void>>(Promise.resolve());
  const current = history[definition.id];
  const availablePresets = useMemo(
    () => [...(BUILT_IN_PRESETS[definition.id] ?? []), ...(customPresets[definition.id] ?? [])],
    [customPresets, definition.id],
  );
  const activePreset = availablePresets.find((preset) => valuesEqual(preset.values, current.present));
  const normalizedFilter = filter.trim().toLowerCase();
  const visibleControls = useMemo(
    () =>
      definition.controls.filter((control) =>
        `${control.label} ${control.description} ${control.group}`.toLowerCase().includes(normalizedFilter),
      ),
    [definition.controls, normalizedFilter],
  );
  const changedCount = definition.controls.filter(
    (control) => (current.present[control.id] ?? control.defaultValue) !== control.defaultValue,
  ).length;
  const allChangedCount = SECTIONS.reduce(
    (count, candidate) => count + (valuesEqual(history[candidate.id].present, DEFAULTS[candidate.id]) ? 0 : 1),
    0,
  );
  const portablePresetCount = portableScope === "all"
    ? SECTIONS.reduce((count, candidate) => count + (customPresets[candidate.id]?.length ?? 0), 0)
    : customPresets[definition.id]?.length ?? 0;
  const Icon = definition.icon;

  useEffect(() => {
    if (!runtime?.tauri) return;
    const adapter = createDesktopSettingsPermissionsAdapter();
    nativeAdapterRef.current = adapter;
    let active = true;
    setStatus("Loading native settings profile…");
    void adapter.load()
      .then((result) => {
        if (!active) return;
        let snapshot: OmniaSettingsPermissionsSnapshot;
        if (result.status === "loaded") {
          const hydratedValues = valuesWithDefaults(
            section,
            nativeSectionValues(result.snapshot, section) ?? DEFAULTS[section],
          );
          snapshot = {
            ...result.snapshot,
            settings: {
              ...result.snapshot.settings,
              values: {
                ...result.snapshot.settings.values,
                [section]: hydratedValues,
              },
            },
          };
          nativeHasPersistedRevisionRef.current = true;
          setHistory((previous) => ({
            ...previous,
            [section]: {
              past: [],
              present: hydratedValues,
              future: [],
            },
          }));
          setStatus("Native settings profile loaded.");
        } else {
          snapshot = createSettingsPermissionsSnapshot({
            values: { [section]: { ...DEFAULTS[section] } },
          });
          nativeHasPersistedRevisionRef.current = false;
          setStatus("Native settings profile is empty; defaults are ready to save.");
        }
        nativeSnapshotRef.current = snapshot;
        nativeHydratedRef.current = true;
      })
      .catch(() => {
        if (!active) return;
        nativeHydratedRef.current = false;
        nativeHasPersistedRevisionRef.current = false;
        setStatus("Native settings are unavailable; using renderer preview values.");
      });
    return () => {
      active = false;
      if (nativeSaveTimerRef.current !== null) {
        window.clearTimeout(nativeSaveTimerRef.current);
        nativeSaveTimerRef.current = null;
        nativePendingSaveRef.current?.();
      }
      nativePendingSaveRef.current = null;
      nativeAdapterRef.current = null;
    };
  }, [runtime?.tauri, section]);

  useEffect(() => {
    if (!runtime?.tauri || !nativeHydratedRef.current || !nativeAdapterRef.current) return;
    const initialSnapshot = nativeSnapshotRef.current;
    const persistedSectionValues = initialSnapshot
      ? valuesWithDefaults(section, nativeSectionValues(initialSnapshot, section) ?? DEFAULTS[section])
      : null;
    if (persistedSectionValues && valuesEqual(history[section].present, persistedSectionValues)) {
      return;
    }
    if (nativeSaveTimerRef.current !== null) window.clearTimeout(nativeSaveTimerRef.current);
    const adapter = nativeAdapterRef.current;
    const sectionValues = { ...history[section].present };
    const executeSave = () => {
      nativePendingSaveRef.current = null;
      nativeSaveChainRef.current = nativeSaveChainRef.current.then(async () => {
        const currentSnapshot = nativeSnapshotRef.current;
        if (!adapter || !currentSnapshot) return;
        const values = {
          ...currentSnapshot.settings.values,
          [section]: sectionValues,
        };
        const nextSnapshot = nativeHasPersistedRevisionRef.current
          ? updateSettingsPermissionsSnapshot(currentSnapshot, { values })
          : createSettingsPermissionsSnapshot({
              id: currentSnapshot.settings.id,
              scope: currentSnapshot.settings.scope,
              values,
              permissions: currentSnapshot.permissions,
            });
        const expectedRevision = nativeHasPersistedRevisionRef.current
          ? currentSnapshot.revision
          : undefined;
        try {
          const result = await adapter.save(nextSnapshot, expectedRevision);
          nativeHasPersistedRevisionRef.current = true;
          nativeSnapshotRef.current = { ...nextSnapshot, revision: result.revision };
          setStatus("Settings saved to the native profile.");
        } catch (error: unknown) {
          if (error instanceof Error && error.name === "SettingsPermissionsError") {
            setStatus("Native settings changed elsewhere; reload this section to retry.");
          } else {
            setStatus("Native settings save failed; renderer values are still available.");
          }
        }
      });
    };
    nativePendingSaveRef.current = executeSave;
    nativeSaveTimerRef.current = window.setTimeout(executeSave, 180);
    return () => {
      if (nativeSaveTimerRef.current !== null) {
        window.clearTimeout(nativeSaveTimerRef.current);
        nativeSaveTimerRef.current = null;
      }
    };
  }, [history, runtime?.tauri, section]);

  const updateValue = (control: ControlDefinition, value: SettingValue) => {
    const before = current.present[control.id] ?? control.defaultValue;
    if (Object.is(before, value)) {
      setStatus(`${control.label} is already ${displayValue(value)} in the renderer preview.`);
      return;
    }
    setHistory((previous) => {
      const before = previous[definition.id];
      return {
        ...previous,
        [definition.id]: {
          past: [...before.past, cloneValues(before.present)],
          present: { ...before.present, [control.id]: value },
          future: [],
        },
      };
    });
    setStatus(`${control.label} changed in the renderer preview.`);
  };

  const applyPreset = (preset: SettingsPreset) => {
    if (valuesEqual(current.present, preset.values)) {
      setStatus(`${preset.name} is already active in the renderer preview.`);
      return;
    }
    setHistory((previous) => {
      const before = previous[definition.id];
      return {
        ...previous,
        [definition.id]: {
          past: [...before.past, cloneValues(before.present)],
          present: cloneValues(preset.values),
          future: [],
        },
      };
    });
    setStatus(`${preset.name} applied to the renderer preview.`);
  };

  const saveCustomPreset = () => {
    const name = customPresetName.trim();
    if (!name) {
      setStatus("Enter a name before saving a renderer preview preset.");
      return;
    }
    const normalizedName = name.toLowerCase();
    const existing = (customPresets[definition.id] ?? []).find(
      (preset) => preset.name.toLowerCase() === normalizedName,
    );
    const nextPreset: SettingsPreset = {
      id: existing?.id ?? `custom-${Date.now()}-${normalizedName.replace(/[^a-z0-9]+/g, "-") || "preset"}`,
      name,
      description: "A renderer-local snapshot of the current Control Center choices.",
      tone: definition.accent as SettingsPresetTone,
      section: definition.id,
      values: cloneValues(current.present),
      builtIn: false,
    };
    setCustomPresets((previous) => ({
      ...previous,
      [definition.id]: existing
        ? previous[definition.id].map((preset) => (preset.id === existing.id ? nextPreset : preset))
        : [...previous[definition.id], nextPreset].slice(-12),
    }));
    setCustomPresetName("");
    setStatus(`${name} saved in this renderer session. Native profile persistence remains planned.`);
  };

  const removeCustomPreset = (preset: SettingsPreset) => {
    if (preset.builtIn) return;
    setCustomPresets((previous) => ({
      ...previous,
      [definition.id]: previous[definition.id].filter((candidate) => candidate.id !== preset.id),
    }));
    setStatus(`${preset.name} removed from this renderer session.`);
  };

  const undo = () => {
    setHistory((previous) => {
      const before = previous[definition.id];
      const snapshot = before.past.at(-1);
      if (!snapshot) return previous;
      return {
        ...previous,
        [definition.id]: {
          past: before.past.slice(0, -1),
          present: cloneValues(snapshot),
          future: [cloneValues(before.present), ...before.future],
        },
      };
    });
    setStatus("Undid the last preview change.");
  };

  const redo = () => {
    setHistory((previous) => {
      const before = previous[definition.id];
      const snapshot = before.future[0];
      if (!snapshot) return previous;
      return {
        ...previous,
        [definition.id]: {
          past: [...before.past, cloneValues(before.present)],
          present: cloneValues(snapshot),
          future: before.future.slice(1),
        },
      };
    });
    setStatus("Reapplied the next preview change.");
  };

  const resetSection = () => {
    if (valuesEqual(current.present, DEFAULTS[definition.id])) {
      setStatus(`${definition.label} is already at its preview defaults.`);
      return;
    }
    setHistory((previous) => {
      const before = previous[definition.id];
      return {
        ...previous,
        [definition.id]: {
          past: [...before.past, cloneValues(before.present)],
          present: cloneValues(DEFAULTS[definition.id]),
          future: [],
        },
      };
    });
    setStatus(`${definition.label} was reset to its preview defaults.`);
  };

  const resetControl = (control: ControlDefinition) => {
    const beforeValue = current.present[control.id] ?? control.defaultValue;
    if (Object.is(beforeValue, control.defaultValue)) {
      setStatus(`${control.label} is already at its preview default.`);
      return;
    }
    setHistory((previous) => {
      const before = previous[definition.id];
      return {
        ...previous,
        [definition.id]: {
          past: [...before.past, cloneValues(before.present)],
          present: { ...before.present, [control.id]: control.defaultValue },
          future: [],
        },
      };
    });
    setStatus(`${control.label} was reset to its preview default.`);
  };

  const resetAll = () => {
    if (allChangedCount === 0) {
      setStatus("All Control Center preview values are already at their defaults.");
      return;
    }
    setHistory((previous) => {
      const next = { ...previous };
      for (const candidate of SECTIONS) {
        const before = previous[candidate.id];
        if (valuesEqual(before.present, DEFAULTS[candidate.id])) continue;
        next[candidate.id] = {
          past: [...before.past, cloneValues(before.present)],
          present: cloneValues(DEFAULTS[candidate.id]),
          future: [],
        };
      }
      return next;
    });
    setStatus("All Control Center preview values were reset to defaults.");
  };

  const serializedPreview = () => JSON.stringify(
    portableScope === "all"
      ? createPreviewBundlePayload(history, customPresets)
      : createPreviewPayload(definition.id, current.present, customPresets[definition.id] ?? []),
    null,
    2,
  );

  const copyPreview = async () => {
    const payload = serializedPreview();
    if (!navigator.clipboard?.writeText) {
      setStatus("Clipboard access is unavailable in this surface; no data was exported.");
      return;
    }
    try {
      await navigator.clipboard.writeText(payload);
      setStatus(`${portableScope === "all" ? "All-sections" : "Section"} preview JSON copied. It contains no credentials or prompt bodies.`);
    } catch {
      setStatus("Preview JSON is ready, but clipboard access is unavailable in this surface.");
    }
  };

  const exportPreview = () => {
    const payload = serializedPreview();
    if (typeof URL.createObjectURL !== "function") {
      setStatus("File download is unavailable in this surface; no data was exported.");
      return;
    }
    const url = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = portableScope === "all" ? "omnia-control-center-preview.json" : `omnia-${definition.id}-preview.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    if (typeof URL.revokeObjectURL === "function") window.setTimeout(() => URL.revokeObjectURL(url), 0);
    setStatus(`${portableScope === "all" ? "All-sections" : "Section"} renderer preview JSON exported. Native settings remain untouched.`);
  };

  const importPreview = async (file: File) => {
    try {
      const parsed: unknown = JSON.parse(await readPreviewFile(file));
      if (portableScope === "all") {
        const result = validatePreviewBundlePayload(parsed, history);
        if (!result.ok) throw new Error(result.error);
        const changedSections = SECTIONS.filter((candidate) => {
          const next = result.valuesBySection[candidate.id];
          const nextPresets = result.presetsBySection[candidate.id];
          const mergedPresets = nextPresets === undefined
            ? customPresets[candidate.id] ?? []
            : mergeCustomPresets(customPresets[candidate.id] ?? [], nextPresets);
          return (next !== undefined && !valuesEqual(history[candidate.id].present, next))
            || (nextPresets !== undefined && !presetListsEqual(customPresets[candidate.id] ?? [], mergedPresets));
        });
        if (changedSections.length === 0) {
          setStatus(
            result.warnings.length > 0
              ? `No all-sections preview changes applied. ${result.warnings.join("; ")}.`
              : "The imported all-sections preview already matches the current renderer state.",
          );
          return;
        }
        setHistory((previous) => {
          const next = { ...previous };
          for (const candidate of changedSections) {
            const before = previous[candidate.id];
            const values = result.valuesBySection[candidate.id]!;
            next[candidate.id] = {
              past: [...before.past, cloneValues(before.present)],
              present: cloneValues(values),
              future: [],
            };
          }
          return next;
        });
        if (result.presetPayloadPresent) {
          setCustomPresets((previous) => {
            const next = { ...previous };
            for (const candidate of SECTIONS) {
              const incoming = result.presetsBySection[candidate.id];
              if (incoming === undefined) continue;
              next[candidate.id] = mergeCustomPresets(previous[candidate.id] ?? [], incoming);
            }
            return next;
          });
        }
        setStatus(
          result.warnings.length > 0
            ? `All-sections preview imported; ${changedSections.length} sections changed. ${result.warnings.join("; ")}.`
            : `All-sections renderer preview imported; ${changedSections.length} sections changed and ${Object.values(result.presetsBySection).reduce((count, presets) => count + (presets?.length ?? 0), 0)} custom presets merged. Native settings remain untouched.`,
        );
      } else {
        const result = validatePreviewPayload(parsed, definition, current.present);
        if (!result.ok) throw new Error(result.error);
        const parsedRecord = isRecord(parsed) ? parsed : undefined;
        const importedPresets = validateImportedPresets(parsedRecord?.customPresets, definition);
        const mergedPresets = importedPresets.present
          ? mergeCustomPresets(customPresets[definition.id] ?? [], importedPresets.presets)
          : customPresets[definition.id] ?? [];
        const valuesChanged = !valuesEqual(current.present, result.values);
        const presetsChanged = importedPresets.present
          && !presetListsEqual(customPresets[definition.id] ?? [], mergedPresets);
        const importedCount = importedPresets.present ? importedPresets.presets.length : 0;
        const warnings = [
          ...result.warnings.map((warning) => `ignored invalid values for ${warning}`),
          ...importedPresets.warnings,
        ];
        if (!valuesChanged && !presetsChanged) {
          setStatus(
            warnings.length > 0
              ? `No section preview changes applied; ${warnings.join("; ")}.`
              : "The imported section preview already matches the current renderer state.",
          );
          return;
        }
        if (valuesChanged) {
          setHistory((previous) => {
            const before = previous[definition.id];
            return {
              ...previous,
              [definition.id]: {
                past: [...before.past, cloneValues(before.present)],
                present: result.values,
                future: [],
              },
            };
          });
        }
        if (presetsChanged) {
          setCustomPresets((previous) => ({
            ...previous,
            [definition.id]: mergedPresets,
          }));
        }
        setStatus(
          warnings.length > 0
            ? `Preview imported${valuesChanged ? "" : " with no value changes"}; ${importedCount} custom presets merged. ${warnings.join("; ")}.`
            : `Renderer preview JSON imported; ${importedCount} custom presets merged. Native settings remain untouched.`,
        );
      }
    } catch (error) {
      setStatus(error instanceof Error ? `Preview import failed: ${error.message}` : "Preview import failed.");
    } finally {
      if (importInputRef.current) importInputRef.current.value = "";
    }
  };

  const groupedControls = (["Essentials", "Advanced"] as const).map((group) => ({
    group,
    controls: visibleControls.filter((control) => control.group === group),
  }));

  return (
    <section className={`control-center control-center--${definition.accent}`} aria-labelledby="control-center-title">
      <header className="control-center__header">
        <span className="control-center__hero-icon" aria-hidden="true">
          <Icon size={21} />
        </span>
        <div className="control-center__heading">
          <span className="eyebrow">{definition.eyebrow}</span>
          <h2 id="control-center-title">Omnia Control Center</h2>
          <p>{definition.description}</p>
        </div>
        <span className="control-center__status">
          <CircleDot size={13} /> Renderer preview
        </span>
      </header>

      <div className="control-center__section-line">
        <span className="control-center__section-label">{definition.label}</span>
        <span className="control-center__scope"><LockKeyhole size={12} /> Local scope</span>
      </div>

      <div className="control-center__metrics" aria-label="Control Center preview summary">
        <article><span><SlidersHorizontal size={14} /></span><strong>{definition.controls.length}</strong><small>Options</small></article>
        <article><span><Sparkles size={14} /></span><strong>{changedCount}</strong><small>Changed</small></article>
        <article><span><Database size={14} /></span><strong>{current.past.length}</strong><small>Undo steps</small></article>
        <article><span><Monitor size={14} /></span><strong>Preview</strong><small>Native state</small></article>
      </div>

      <section className="control-center__presets" aria-labelledby="control-center-presets-title">
        <header className="control-center__presets-header">
          <span className="control-center__presets-icon" aria-hidden="true"><Bookmark size={15} /></span>
          <div>
            <span className="eyebrow">Starting points</span>
            <h3 id="control-center-presets-title">Section presets</h3>
            <p>Apply a whole setting shape in one reversible step, then refine the individual options below.</p>
          </div>
          <span className="control-center__presets-status">{activePreset ? `${activePreset.name} active` : "Custom mix"}</span>
        </header>

        <div className="control-center__preset-grid" role="list" aria-label={`${definition.label} renderer preview presets`}>
          {availablePresets.map((preset) => {
            const selected = activePreset?.id === preset.id;
            return (
              <div className="control-center__preset-shell" role="listitem" key={preset.id}>
                <button
                  type="button"
                  className={`control-center__preset control-center__preset--${preset.tone}${selected ? " is-selected" : ""}`}
                  aria-label={`Apply ${preset.name} preset`}
                  aria-pressed={selected}
                  onClick={() => applyPreset(preset)}
                >
                  <span className="control-center__preset-top">
                    <strong>{preset.name}</strong>
                    {selected ? <Check size={14} /> : <Sparkles size={14} />}
                  </span>
                  <small>{preset.description}</small>
                  <span>{preset.builtIn ? "Built-in preview" : "Custom session preview"}</span>
                </button>
                {!preset.builtIn ? (
                  <button
                    type="button"
                    className="control-center__preset-remove"
                    aria-label={`Remove ${preset.name} custom preset`}
                    title={`Remove ${preset.name}`}
                    onClick={() => removeCustomPreset(preset)}
                  >
                    <Trash2 size={13} />
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>

        <div className="control-center__save-preset">
          <label>
            <span>Save current shape</span>
            <input
              type="text"
              value={customPresetName}
              onChange={(event) => setCustomPresetName(event.target.value)}
              placeholder="e.g. Team demo laptop"
              aria-label="Save current Control Center preset"
            />
          </label>
          <button
            type="button"
            className="button button--secondary"
            onClick={saveCustomPreset}
            disabled={!customPresetName.trim()}
          >
            <Plus size={14} /> Save preset
          </button>
          <small>Custom presets live only in this renderer session; export a JSON snapshot to carry them elsewhere.</small>
        </div>
      </section>

      <div className="control-center__toolbar" role="toolbar" aria-label="Control Center actions">
        <label className="control-center__search">
          <Search size={14} />
          <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter options" aria-label="Filter Control Center options" />
        </label>
        <button type="button" className="button button--secondary" onClick={undo} disabled={current.past.length === 0} title="Undo preview change" aria-label="Undo preview change"><Undo2 size={14} /> Undo</button>
        <button type="button" className="button button--secondary" onClick={redo} disabled={current.future.length === 0} title="Redo preview change" aria-label="Redo preview change"><Redo2 size={14} /> Redo</button>
        <button type="button" className="button button--secondary" onClick={resetSection} disabled={changedCount === 0}><RotateCcw size={14} /> Reset section</button>
        <button type="button" className="button button--ghost" onClick={resetAll} disabled={allChangedCount === 0}>Reset all</button>
      </div>

      <div className="control-center__status-line" role="status"><Info size={14} /> {status}</div>

      <div className="control-center__groups">
        {groupedControls.map(({ group, controls }) => (
          <section className="control-center__group" key={group} aria-labelledby={`control-center-group-${group.toLowerCase()}`}>
            <header>
              <div><h3 id={`control-center-group-${group.toLowerCase()}`}>{group}</h3><p>{group === "Essentials" ? "Safe defaults for everyday work." : "Advanced knobs that stay explicit and reversible."}</p></div>
              <span>{controls.length} visible</span>
            </header>
            <div className="control-center__fields">
              {controls.map((control) => {
                const value = current.present[control.id] ?? control.defaultValue;
                const isDefault = Object.is(value, control.defaultValue);
                return (
                  <div className="control-center__field" key={control.id}>
                    <span className="control-center__field-copy"><strong>{control.label}</strong><small>{control.description}</small></span>
                    <span className="control-center__field-control">
                      {control.kind === "toggle" ? (
                        <label className="mini-toggle hit-target-control">
                          <input type="checkbox" checked={value === true} onChange={(event) => updateValue(control, event.target.checked)} aria-label={control.label} />
                          <span />
                        </label>
                      ) : null}
                      {control.kind === "select" ? (
                        <select value={String(value)} onChange={(event) => updateValue(control, event.target.value)} aria-label={control.label}>
                          {control.options?.map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}
                        </select>
                      ) : null}
                      {control.kind === "text" ? (
                        <input type="text" value={String(value)} title={String(value)} placeholder={control.placeholder} onChange={(event) => updateValue(control, event.target.value)} aria-label={control.label} />
                      ) : null}
                      {control.kind === "number" ? (
                        <span className="control-center__number">
                          <input type="number" value={Number(value)} min={control.min} max={control.max} onChange={(event) => updateValue(control, Number(event.target.value))} aria-label={control.label} />
                          {control.suffix ? <small>{control.suffix}</small> : null}
                        </span>
                      ) : null}
                      <button
                        type="button"
                        className="control-center__field-reset"
                        onClick={() => resetControl(control)}
                        disabled={isDefault}
                        title={`Reset ${control.label} to default`}
                        aria-label={`Reset ${control.label} to default`}
                      >
                        <RotateCcw size={12} />
                      </button>
                    </span>
                  </div>
                );
              })}
              {controls.length === 0 ? <p className="control-center__empty">No options match “{filter}”.</p> : null}
            </div>
          </section>
        ))}
      </div>

      <div className="control-center__footer-grid">
        <aside className="control-center__boundary">
          <CheckCircle2 size={16} />
          <div><strong>Boundary: preview only</strong><p>{definition.boundary}</p></div>
        </aside>
        <aside className="control-center__export">
          <div><span className="eyebrow">Portable setup</span><strong>Keep your choices inspectable</strong><p>{portableScope === "all" ? "Move all " + SECTIONS.length + " preview sections as one redacted bundle." : "Move the current section as a redacted renderer snapshot."} Native persistence remains planned. <span className="control-center__portable-count">{portablePresetCount} custom preset{portablePresetCount === 1 ? "" : "s"} included.</span></p></div>
          <div className="control-center__export-actions">
            <label className="control-center__portable-scope"><span>Snapshot scope</span><select value={portableScope} onChange={(event) => setPortableScope(event.target.value as PortableScope)} aria-label="Control Center snapshot scope"><option value="section">Current section</option><option value="all">All sections</option></select></label>
            <button type="button" className="button button--secondary" onClick={() => void copyPreview()}><Download size={14} /> Copy JSON</button>
            <button type="button" className="button button--secondary" onClick={exportPreview}><Download size={14} /> Export JSON</button>
            <button type="button" className="button button--secondary" onClick={() => importInputRef.current?.click()}><Upload size={14} /> Import JSON</button>
            <input
              ref={importInputRef}
              className="sr-only"
              type="file"
              accept="application/json,.json"
              aria-label="Import Control Center preview JSON"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void importPreview(file);
              }}
            />
          </div>
        </aside>
      </div>

      <p className="control-center__fine-print"><Info size={12} /> Current values: {definition.controls.map((control) => `${control.label}=${displayValue(current.present[control.id] ?? control.defaultValue)}`).join(" · ")}</p>
    </section>
  );
}

export const SETTINGS_CONTROL_SECTIONS = SECTIONS.map((definition) => definition.id);
