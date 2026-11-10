import {
  Brain,
  Check,
  Clipboard,
  Download,
  FileOutput,
  FolderOpen,
  GitBranch,
  LockKeyhole,
  MessageSquareText,
  Paintbrush,
  Redo2,
  RotateCcw,
  Route,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Undo2,
  Upload,
} from "lucide-react";
import { useEffect, useMemo, useState, type ChangeEvent, type ReactNode } from "react";

import type { ConversationView, MemoryView, ProjectView, SkillView } from "./types";
import {
  PERMISSION_PREVIEW_BOUNDARY,
  PERMISSION_SCOPE_LABELS,
  permissionModeCounts,
  permissionPresetLabel,
  projectPermissionDraftContext,
  usePermissionSession,
} from "./session-permission-contract";

export type InheritanceScope = "app" | "profile" | "project" | "chat" | "run";
type InheritanceFieldId =
  | "model"
  | "parameters"
  | "permissions"
  | "memory"
  | "skills"
  | "workspace"
  | "style"
  | "export";

type PreviewState = "configured" | "preview-only" | "planned" | "unavailable";

type ScopeValue = {
  readonly value: string;
  readonly revision: string;
  readonly state: PreviewState;
};

type InheritanceField = {
  readonly id: InheritanceFieldId;
  readonly label: string;
  readonly description: string;
  readonly options: readonly string[];
  readonly baseline: Partial<Record<InheritanceScope, ScopeValue | undefined>>;
};

type OverrideState = Partial<Record<InheritanceFieldId, Partial<Record<InheritanceScope, string>>>>;

type HistoryState = {
  readonly past: OverrideState[];
  readonly present: OverrideState;
  readonly future: OverrideState[];
};

const scopes: readonly InheritanceScope[] = ["app", "profile", "project", "chat", "run"];

const scopeLabels: Record<InheritanceScope, string> = {
  app: "App default",
  profile: "Profile",
  project: "Project",
  chat: "Chat",
  run: "Run / turn",
};

const scopeShortLabels: Record<InheritanceScope, string> = {
  app: "App",
  profile: "Profile",
  project: "Project",
  chat: "Chat",
  run: "This run",
};

const fieldLabels: Record<InheritanceFieldId, string> = {
  model: "Model / provider route",
  parameters: "Generation parameters",
  permissions: "Permission preset",
  memory: "Memory policy",
  skills: "Skill set",
  workspace: "Workspace roots",
  style: "Style instructions",
  export: "Export policy",
};

const defaultOptions: Record<InheritanceFieldId, readonly string[]> = {
  model: ["Automatic route", "Quality first", "Balanced route", "Local & private"],
  parameters: ["Balanced", "Precise", "Creative", "Custom"],
  permissions: ["Ask every time", "Lockdown", "Research flow", "Allow all (preview)"],
  memory: ["Off", "Suggestions require approval", "Automatic with review log"],
  skills: ["No skills", "Evidence-first pack", "Project skill set"],
  workspace: ["No workspace roots", "Read-only roots", "Metadata-only roots", "Selected files"],
  style: ["Default style", "Evidence-first", "Concise", "Project instructions"],
  export: ["Session-only", "Redacted preview", "JSON + Markdown preview"],
};

function cloneOverrides(value: OverrideState): OverrideState {
  const next: OverrideState = {};
  for (const [fieldId, fieldScopes] of Object.entries(value)) {
    if (!fieldScopes) continue;
    next[fieldId as InheritanceFieldId] = { ...fieldScopes };
  }
  return next;
}

function fieldIcon(id: InheritanceFieldId): ReactNode {
  if (id === "model") return <Route size={14} aria-hidden="true" />;
  if (id === "parameters") return <SlidersHorizontal size={14} aria-hidden="true" />;
  if (id === "permissions") return <LockKeyhole size={14} aria-hidden="true" />;
  if (id === "memory") return <Brain size={14} aria-hidden="true" />;
  if (id === "skills") return <Sparkles size={14} aria-hidden="true" />;
  if (id === "workspace") return <FolderOpen size={14} aria-hidden="true" />;
  if (id === "style") return <Paintbrush size={14} aria-hidden="true" />;
  return <FileOutput size={14} aria-hidden="true" />;
}

function makeScopeValue(value: string, scope: InheritanceScope, fieldId: InheritanceFieldId): ScopeValue {
  return {
    value,
    revision: `preview:${scope}:${fieldId}`,
    state: scope === "run" ? "planned" : "preview-only",
  };
}

function optionalScopeValue(
  value: string | undefined,
  revision: string,
  state: PreviewState = "preview-only",
): ScopeValue | undefined {
  return value ? { value, revision, state } : undefined;
}

function buildFields(
  project: ProjectView,
  conversation: ConversationView | null,
  memories: readonly MemoryView[],
  skills: readonly SkillView[],
): InheritanceField[] {
  const activeMemories = memories.filter(
    (memory) => memory.status === "active" && (memory.scopeLabel === "Global" || memory.scopeLabel.includes(project.name)),
  );
  const activeSkills = skills.filter((skill) => skill.enabled && (skill.scope === "Global" || skill.scope === "Project"));
  const projectModel = project.modelProfileId && project.modelProfileId !== "auto" ? project.modelProfileId : undefined;
  const projectInstructions = project.instructions.trim() ? "Project instructions" : undefined;
  const projectWorkspace = project.folders.length > 0 ? `${project.folders.length} referenced folder${project.folders.length === 1 ? "" : "s"}` : undefined;
  const projectMemories = activeMemories.length > 0 ? `${activeMemories.length} active project candidate${activeMemories.length === 1 ? "" : "s"}` : undefined;
  const projectSkills = activeSkills.length > 0 ? `${activeSkills.length} enabled project skill${activeSkills.length === 1 ? "" : "s"}` : undefined;
  const conversationLabel = conversation ? `Chat-specific: ${conversation.title}` : undefined;

  return [
    {
      id: "model",
      label: fieldLabels.model,
      description: "The route selected for a future text run.",
      options: [...defaultOptions.model, ...(projectModel ? [projectModel] : [])],
      baseline: {
        app: { value: "Automatic route", revision: "app:model:r1", state: "configured" },
        profile: { value: "Research profile", revision: "profile:research:r2", state: "configured" },
        project: optionalScopeValue(projectModel, `project:${project.id}:model`),
      },
    },
    {
      id: "parameters",
      label: fieldLabels.parameters,
      description: "Provider-neutral generation preferences before provider translation.",
      options: defaultOptions.parameters,
      baseline: {
        app: { value: "Balanced", revision: "app:parameters:r1", state: "configured" },
        profile: { value: "Precise", revision: "profile:research:r2", state: "configured" },
      },
    },
    {
      id: "permissions",
      label: fieldLabels.permissions,
      description: "A scoped capability preset; it does not bypass native approval or OS boundaries.",
      options: defaultOptions.permissions,
      baseline: {
        app: { value: "Ask every time", revision: "app:permissions:r1", state: "configured" },
        profile: { value: "Research flow", revision: "profile:research:r2", state: "configured" },
        project: optionalScopeValue(projectWorkspace ? "Read-only workspace" : undefined, `project:${project.id}:permissions`),
      },
    },
    {
      id: "memory",
      label: fieldLabels.memory,
      description: "Retrieval candidates remain preview-only until a native policy and receipt exist.",
      options: defaultOptions.memory,
      baseline: {
        app: { value: "Off", revision: "app:memory:r1", state: "configured" },
        profile: { value: "Suggestions require approval", revision: "profile:research:r2", state: "configured" },
        project: optionalScopeValue(projectMemories, `project:${project.id}:memory`, "planned"),
      },
    },
    {
      id: "skills",
      label: fieldLabels.skills,
      description: "Enabled skills are a renderer projection, not native package activation or provider injection.",
      options: defaultOptions.skills,
      baseline: {
        app: { value: "No skills", revision: "app:skills:r1", state: "configured" },
        profile: { value: "Evidence-first pack", revision: "profile:research:r2", state: "configured" },
        project: optionalScopeValue(projectSkills, `project:${project.id}:skills`, "planned"),
      },
    },
    {
      id: "workspace",
      label: fieldLabels.workspace,
      description: "Folder references remain read-only and not indexed in this browser preview.",
      options: [...defaultOptions.workspace, ...(projectWorkspace ? [projectWorkspace] : [])],
      baseline: {
        app: { value: "No workspace roots", revision: "app:workspace:r1", state: "configured" },
        profile: { value: "Read-only roots", revision: "profile:research:r2", state: "configured" },
        project: optionalScopeValue(projectWorkspace, `project:${project.id}:workspace`, project.contextHealth === "missing-access" ? "unavailable" : "preview-only"),
      },
    },
    {
      id: "style",
      label: fieldLabels.style,
      description: "Instruction precedence is visible here; no prompt body is sent by this preview.",
      options: defaultOptions.style,
      baseline: {
        app: { value: "Default style", revision: "app:style:r1", state: "configured" },
        profile: { value: "Evidence-first", revision: "profile:research:r2", state: "configured" },
        project: optionalScopeValue(projectInstructions, `project:${project.id}:instructions`),
        chat: optionalScopeValue(conversationLabel, conversation ? `chat:${conversation.id}:instructions` : "", "preview-only"),
      },
    },
    {
      id: "export",
      label: fieldLabels.export,
      description: "Controls only this renderer-session export preview; native export receipts remain planned.",
      options: defaultOptions.export,
      baseline: {
        app: { value: "Session-only", revision: "app:export:r1", state: "configured" },
        profile: { value: "Redacted preview", revision: "profile:research:r2", state: "configured" },
      },
    },
  ];
}

function resolveField(field: InheritanceField, overrides: OverrideState): { scope: InheritanceScope; value: ScopeValue; overridden: boolean } {
  const fieldOverrides = overrides[field.id] ?? {};
  for (let index = scopes.length - 1; index >= 0; index -= 1) {
    const scope = scopes[index]!;
    const override = fieldOverrides[scope];
    if (override) return { scope, value: makeScopeValue(override, scope, field.id), overridden: true };
    const baseline = field.baseline[scope];
    if (baseline) return { scope, value: baseline, overridden: false };
  }
  return {
    scope: "app",
    value: { value: "Unavailable", revision: "unknown", state: "unavailable" },
    overridden: false,
  };
}

function parentScope(scope: InheritanceScope): InheritanceScope | null {
  const index = scopes.indexOf(scope);
  return index > 0 ? scopes[index - 1]! : null;
}

function serializeOverrides(overrides: OverrideState): Record<string, Record<string, string>> {
  const payload: Record<string, Record<string, string>> = {};
  for (const [fieldId, fieldScopes] of Object.entries(overrides)) {
    if (!fieldScopes) continue;
    payload[fieldId] = Object.fromEntries(Object.entries(fieldScopes).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  }
  return payload;
}

function parseOverrides(value: unknown): OverrideState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const parsed: OverrideState = {};
  for (const [fieldId, fieldScopes] of Object.entries(value)) {
    if (!Object.prototype.hasOwnProperty.call(fieldLabels, fieldId) || !fieldScopes || typeof fieldScopes !== "object" || Array.isArray(fieldScopes)) continue;
    const cleanScopes: Partial<Record<InheritanceScope, string>> = {};
    for (const [scope, setting] of Object.entries(fieldScopes)) {
      if (scopes.includes(scope as InheritanceScope) && typeof setting === "string" && setting.trim()) cleanScopes[scope as InheritanceScope] = setting;
    }
    if (Object.keys(cleanScopes).length > 0) parsed[fieldId as InheritanceFieldId] = cleanScopes;
  }
  return parsed;
}

export function ProjectScopeInheritancePreview({
  project,
  conversations = [],
  memories = [],
  skills = [],
}: {
  readonly project: ProjectView;
  readonly conversations?: readonly ConversationView[];
  readonly memories?: readonly MemoryView[];
  readonly skills?: readonly SkillView[];
}) {
  const projectConversations = useMemo(
    () => conversations.filter((conversation) => conversation.projectId === project.id && !conversation.archived),
    [conversations, project.id],
  );
  const [conversationId, setConversationId] = useState(projectConversations[0]?.id ?? "");
  const [editScope, setEditScope] = useState<InheritanceScope>("project");
  const [history, setHistory] = useState<HistoryState>({ past: [], present: {}, future: [] });
  const [presetOpen, setPresetOpen] = useState(false);
  const [status, setStatus] = useState("Every value stays in this renderer until native scope storage is attached.");
  const permissionContext = projectPermissionDraftContext(project.id);
  const permissionSession = usePermissionSession(permissionContext);
  const projectPermissionValues = permissionSession.valuesByScope.project;
  const permissionCounts = useMemo(() => permissionModeCounts(projectPermissionValues), [projectPermissionValues]);
  const permissionPreset = permissionPresetLabel(projectPermissionValues);

  useEffect(() => {
    setConversationId(projectConversations[0]?.id ?? "");
    setHistory({ past: [], present: {}, future: [] });
    setPresetOpen(false);
    setStatus("Scope preview reset for the selected project; no native state changed.");
  }, [project.id, projectConversations]);

  const selectedConversation = projectConversations.find((conversation) => conversation.id === conversationId) ?? null;
  const fields = useMemo(() => buildFields(project, selectedConversation, memories, skills), [memories, project, selectedConversation, skills]);
  const overrides = history.present;

  const presetPayload = useMemo(() => JSON.stringify({
    schema: "omnia.project-scope-inheritance-preview.v1",
    scope: "renderer-session",
    projectId: project.id,
    projectName: project.name,
    conversationId: selectedConversation?.id ?? null,
    editScope,
    overrides: serializeOverrides(overrides),
    permissionPolicy: {
      preset: permissionPreset,
      scope: "project",
      scopeLabel: PERMISSION_SCOPE_LABELS.project,
      counts: permissionCounts,
    },
    boundary: "Preview only; renderer-local; no native scope write, provider request, retrieval, permission grant, or durable export receipt.",
  }, null, 2), [editScope, overrides, permissionCounts, permissionPreset, project.id, project.name, selectedConversation?.id]);

  const commitOverrides = (next: OverrideState, message: string) => {
    setHistory((current) => ({
      past: [...current.past, cloneOverrides(current.present)],
      present: next,
      future: [],
    }));
    setStatus(message);
  };

  const updateOverride = (fieldId: InheritanceFieldId, value: string) => {
    const next = cloneOverrides(overrides);
    const fieldOverrides = { ...(next[fieldId] ?? {}) };
    if (!value) delete fieldOverrides[editScope];
    else fieldOverrides[editScope] = value;
    if (Object.keys(fieldOverrides).length === 0) delete next[fieldId];
    else next[fieldId] = fieldOverrides;
    commitOverrides(next, value ? `${fieldLabels[fieldId]} overridden at ${scopeLabels[editScope]} in the renderer preview.` : `${fieldLabels[fieldId]} now inherits its parent scope.`);
  };

  const resetField = (fieldId: InheritanceFieldId) => updateOverride(fieldId, "");

  const resetAll = () => commitOverrides({}, "All scope overrides reset to their parent values in the renderer preview.");

  const undo = () => {
    setHistory((current) => {
      const snapshot = current.past.at(-1);
      if (!snapshot) return current;
      return { past: current.past.slice(0, -1), present: cloneOverrides(snapshot), future: [cloneOverrides(current.present), ...current.future] };
    });
    setStatus("Undid the last scope preview change.");
  };

  const redo = () => {
    setHistory((current) => {
      const snapshot = current.future[0];
      if (!snapshot) return current;
      return { past: [...current.past, cloneOverrides(current.present)], present: cloneOverrides(snapshot), future: current.future.slice(1) };
    });
    setStatus("Reapplied the next scope preview change.");
  };

  const copyPreset = async () => {
    if (!navigator.clipboard?.writeText) {
      setStatus("Clipboard access is unavailable; no inheritance preset was copied.");
      return;
    }
    try {
      await navigator.clipboard.writeText(presetPayload);
      setStatus("Copied the renderer-local inheritance preset; no native state changed.");
    } catch {
      setStatus("Clipboard access was denied; no inheritance preset was copied.");
    }
  };

  const downloadPreset = () => {
    if (typeof URL.createObjectURL !== "function") {
      setStatus("File download is unavailable; no inheritance preset was exported.");
      return;
    }
    const url = URL.createObjectURL(new Blob([presetPayload], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "omnia-project-scope-inheritance-preview.json";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    if (typeof URL.revokeObjectURL === "function") window.setTimeout(() => URL.revokeObjectURL(url), 0);
    setStatus("Downloaded the renderer-local inheritance preset; no native scope state changed.");
  };

  const importPreset = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > 512 * 1024) {
      setStatus("Import rejected: inheritance preset exceeds the 512 KB preview limit.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result).replace(/^\uFEFF/, "")) as { schema?: unknown; overrides?: unknown; editScope?: unknown };
        if (parsed.schema !== "omnia.project-scope-inheritance-preview.v1") throw new Error("schema");
        const parsedOverrides = parseOverrides(parsed.overrides);
        if (!parsedOverrides) throw new Error("overrides");
        const importedScope = scopes.includes(parsed.editScope as InheritanceScope) ? parsed.editScope as InheritanceScope : editScope;
        setEditScope(importedScope);
        commitOverrides(parsedOverrides, "Imported a renderer-local scope preset for review; no native state changed.");
      } catch {
        setStatus("Import rejected: expected an Omnia project scope inheritance preview bundle.");
      }
    };
    reader.onerror = () => setStatus("Import failed: the inheritance preset could not be read.");
    reader.readAsText(file);
  };

  const currentScopeOverride = (field: InheritanceField) => overrides[field.id]?.[editScope] ?? "";
  const selectedScopeIndex = scopes.indexOf(editScope);
  const parent = parentScope(editScope);

  return (
    <section className="project-scope-inheritance" aria-labelledby="project-scope-inheritance-title">
      <header className="project-scope-inheritance__header">
        <span className="project-scope-inheritance__icon"><GitBranch size={17} aria-hidden="true" /></span>
        <div>
          <span className="eyebrow">Renderer-local preview</span>
          <h2 id="project-scope-inheritance-title">Project scope inheritance</h2>
          <p>See which project, chat and run values win before a future native context compile.</p>
        </div>
        <span className="project-scope-inheritance__status"><ShieldAlert size={13} aria-hidden="true" /> Preview only</span>
      </header>

      <div className="project-scope-inheritance__summary" role="status" aria-live="polite">
        <div>
          <strong>{project.name}</strong>
          <small>{selectedConversation ? `Inspecting ${selectedConversation.title}` : "No project chat selected"}</small>
        </div>
        <span><ShieldCheck size={13} aria-hidden="true" /> No native scope write</span>
      </div>

      <section className="project-scope-inheritance__permission-bridge" aria-label="Project permission draft preview">
        <div className="project-scope-inheritance__permission-bridge-heading">
          <div><span className="eyebrow">Project-scoped renderer draft</span><strong>{permissionPreset}</strong><small>Settings Permission Control Center keeps a separate draft for {project.name}.</small></div>
          <span className="project-scope-inheritance__preview-chip"><ShieldCheck size={12} aria-hidden="true" /> Preview only</span>
        </div>
        <div className="project-scope-inheritance__permission-bridge-metrics" aria-label="Shared permission policy counts">
          <span><strong>{permissionCounts.allow}</strong><small>allow</small></span>
          <span><strong>{permissionCounts.prompt}</strong><small>ask</small></span>
          <span><strong>{permissionCounts.deny}</strong><small>deny</small></span>
          <span><strong>{PERMISSION_SCOPE_LABELS.project}</strong><small>source</small></span>
        </div>
        <p><LockKeyhole size={13} aria-hidden="true" /> {PERMISSION_PREVIEW_BOUNDARY} Project inheritance can describe precedence, but it cannot grant or widen capability.</p>
      </section>

      <div className="project-scope-inheritance__selectors">
        <label>
          <span>Project chat</span>
          <select aria-label="Inheritance preview project chat" value={conversationId} onChange={(event) => setConversationId(event.target.value)}>
            <option value="">Standalone / no chat</option>
            {projectConversations.map((conversation) => <option key={conversation.id} value={conversation.id}>{conversation.title}</option>)}
          </select>
        </label>
        <label>
          <span>Edit scope</span>
          <select aria-label="Inheritance preview edit scope" value={editScope} onChange={(event) => setEditScope(event.target.value as InheritanceScope)}>
            {scopes.map((scope) => <option key={scope} value={scope} disabled={scope === "chat" && !selectedConversation}>{scopeLabels[scope]}{scope === "run" ? " · rehearsal" : ""}</option>)}
          </select>
        </label>
        <span className="project-scope-inheritance__scope-note"><LockKeyhole size={13} aria-hidden="true" /> {editScope === "run" ? "Run overrides are planned and renderer-local." : parent ? `Reset returns to ${scopeLabels[parent]}.` : "Reset returns to factory defaults."}</span>
      </div>

      <div className="project-scope-inheritance__chain" aria-label="Project scope inheritance precedence chain">
        {scopes.map((scope, index) => (
          <div key={scope} className={scope === editScope ? "project-scope-inheritance__chain-node is-active" : "project-scope-inheritance__chain-node"}>
            <span className="project-scope-inheritance__chain-index">{index + 1}</span>
            <span><strong>{scopeLabels[scope]}</strong><small>{scope === editScope ? "Editing" : index === selectedScopeIndex ? "Selected" : "Inherited"}</small></span>
            {index < scopes.length - 1 ? <span className="project-scope-inheritance__chain-arrow" aria-hidden="true">→</span> : null}
          </div>
        ))}
      </div>

      <div className="project-scope-inheritance__toolbar" role="toolbar" aria-label="Scope inheritance preview history and export">
        <span className="project-scope-inheritance__toolbar-copy"><strong>Effective values</strong><small>{status}</small></span>
        <span className="project-scope-inheritance__history-count" aria-label={`${history.past.length} undo steps and ${history.future.length} redo steps`}>{history.past.length + history.future.length} steps</span>
        <button type="button" className="button button--ghost" onClick={undo} disabled={history.past.length === 0} aria-label="Undo scope inheritance preview change"><Undo2 size={13} aria-hidden="true" /> Undo</button>
        <button type="button" className="button button--ghost" onClick={redo} disabled={history.future.length === 0} aria-label="Redo scope inheritance preview change"><Redo2 size={13} aria-hidden="true" /> Redo</button>
        <button type="button" className="button button--ghost" onClick={resetAll} aria-label="Reset all scope overrides"><RotateCcw size={13} aria-hidden="true" /> Reset all</button>
        <button type="button" className="button button--secondary" onClick={() => setPresetOpen((value) => !value)} aria-expanded={presetOpen} aria-controls="project-scope-inheritance-preset"><FileOutput size={13} aria-hidden="true" /> {presetOpen ? "Hide preset" : "Preview preset"}</button>
      </div>

      {presetOpen ? (
        <section id="project-scope-inheritance-preset" className="project-scope-inheritance__preset" aria-label="Project scope inheritance preset preview">
          <header><div><span className="eyebrow">Renderer-session bundle</span><h3>Inheritance preset diff</h3></div><span className="project-scope-inheritance__preview-chip">No durable write</span></header>
          <pre><code>{presetPayload}</code></pre>
          <div className="project-scope-inheritance__preset-actions">
            <button type="button" className="button button--ghost" onClick={() => void copyPreset()}><Clipboard size={13} aria-hidden="true" /> Copy JSON</button>
            <button type="button" className="button button--ghost" onClick={downloadPreset}><Download size={13} aria-hidden="true" /> Download</button>
            <label className="button button--ghost project-scope-inheritance__file-button"><Upload size={13} aria-hidden="true" /> Import JSON<input type="file" accept="application/json,.json" onChange={importPreset} /></label>
          </div>
          <p className="project-scope-inheritance__boundary"><ShieldCheck size={13} aria-hidden="true" /> Preset import/export is renderer-local. It does not grant permissions, retrieve memory, activate skills, freeze context, send a provider request or create a native revision.</p>
        </section>
      ) : null}

      <div className="project-scope-inheritance__fields">
        {fields.map((field) => {
          const resolved = resolveField(field, overrides);
          const fieldOverride = currentScopeOverride(field);
          const scopeUnavailable = editScope === "chat" && !selectedConversation;
          const stateLabel = resolved.value.state === "preview-only" ? "Preview only" : resolved.value.state === "configured" ? "Configured" : resolved.value.state === "planned" ? "Planned" : "Unavailable";
          const sourceLabel =
            resolved.scope === "run"
              ? "This run"
              : resolved.overridden
                ? `Override · ${scopeShortLabels[resolved.scope]}`
                : `Inherited · ${scopeShortLabels[resolved.scope]}`;
          const fieldParent = parentScope(editScope);
          return (
            <article className="project-scope-inheritance__field" key={field.id}>
              <header>
                <span className="project-scope-inheritance__field-icon">{fieldIcon(field.id)}</span>
                <div><strong>{field.label}</strong><small>{field.description}</small></div>
                <span className={`project-scope-inheritance__state project-scope-inheritance__state--${resolved.value.state}`}>{stateLabel}</span>
              </header>
              <div className="project-scope-inheritance__effective">
                <div><span>Effective value</span><strong>{resolved.value.value}</strong></div>
                <div><span>Source</span><strong>{sourceLabel}</strong><code>{resolved.value.revision}</code></div>
              </div>
              <div className="project-scope-inheritance__edit-row">
                <label>
                  <span>{scopeLabels[editScope]} value</span>
                  <select aria-label={`${field.label} ${scopeLabels[editScope]} override`} value={fieldOverride} disabled={scopeUnavailable} onChange={(event) => updateOverride(field.id, event.target.value)}>
                    <option value="">Inherit {fieldParent ? scopeLabels[fieldParent] : "factory defaults"}</option>
                    {field.options.map((option) => <option key={option} value={option}>{option}</option>)}
                  </select>
                </label>
                <button type="button" className="button button--ghost" onClick={() => resetField(field.id)} disabled={!fieldOverride || scopeUnavailable} aria-label={`Reset ${field.label} to parent`}><RotateCcw size={12} aria-hidden="true" /> Reset to {fieldParent ? scopeLabels[fieldParent] : "default"}</button>
              </div>
              {scopeUnavailable ? <p className="project-scope-inheritance__unavailable"><ShieldAlert size={13} aria-hidden="true" /> Select a project chat before editing Chat scope.</p> : null}
            </article>
          );
        })}
      </div>

      <footer className="project-scope-inheritance__footer"><span><MessageSquareText size={13} aria-hidden="true" /> Inheritance is previewed from current renderer data; revisions, approvals and native context snapshots remain separate.</span><span><Check size={13} aria-hidden="true" /> Resetting a scope never changes history, branches, artifacts or run receipts.</span></footer>
    </section>
  );
}
