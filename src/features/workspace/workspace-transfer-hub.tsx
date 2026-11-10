import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpFromLine,
  Check,
  Clipboard,
  Download,
  FileArchive,
  History,
  RotateCcw,
  ShieldCheck,
  Undo2,
  Redo2,
  Upload,
} from "lucide-react";
import { useMemo, useState } from "react";

import { useWorkspaceStore } from "./store";
import {
  buildWorkspaceTransferManifest,
  DEFAULT_WORKSPACE_TRANSFER_SELECTION,
  parseWorkspaceTransferManifest,
  serializeWorkspaceTransferManifest,
  type WorkspaceTransferFormat,
  type WorkspaceTransferManifest,
  type WorkspaceTransferMode,
  type WorkspaceTransferProfile,
  type WorkspaceTransferRedaction,
  type WorkspaceTransferScope,
  type WorkspaceTransferSelection,
} from "./workspace-transfer-contract";

type TransferDraft = {
  mode: WorkspaceTransferMode;
  scope: WorkspaceTransferScope;
  profile: WorkspaceTransferProfile;
  format: WorkspaceTransferFormat;
  redaction: WorkspaceTransferRedaction;
  target: string;
  selection: WorkspaceTransferSelection;
};

type TransferHistory = {
  past: TransferDraft[];
  present: TransferDraft;
  future: TransferDraft[];
};

const DEFAULT_DRAFT: TransferDraft = {
  mode: "handoff",
  scope: "active-project",
  profile: "portable",
  format: "json",
  redaction: "safe",
  target: "Omnia workspace",
  selection: { ...DEFAULT_WORKSPACE_TRANSFER_SELECTION },
};

const PROFILE_META: Record<WorkspaceTransferProfile, { label: string; description: string; detail: string }> = {
  portable: {
    label: "Portable handoff",
    description: "Small, readable metadata package for moving work between Omnia previews.",
    detail: "Secrets, file bytes, and provider payloads stay excluded.",
  },
  support: {
    label: "Support bundle",
    description: "Adds redacted diagnostics and run evidence for troubleshooting.",
    detail: "Use safe redaction; local paths and credentials remain omitted.",
  },
  recovery: {
    label: "Recovery plan",
    description: "Describes a future backup/restore package without creating one yet.",
    detail: "Native snapshot, archive, encryption, and restore are Planned.",
  },
};

const SELECTION_META: Array<{ key: keyof WorkspaceTransferSelection; label: string; description: string }> = [
  { key: "conversations", label: "Chats & drafts", description: "Titles, status, message counts" },
  { key: "projects", label: "Projects", description: "Names, instructions, folder metadata" },
  { key: "memoryCandidates", label: "Memory candidates", description: "Reviewable metadata, not raw memory" },
  { key: "skills", label: "Skills catalog", description: "Trust, scope, versions, permissions" },
  { key: "artifacts", label: "Artifacts", description: "Names, types, revisions, provenance" },
  { key: "attachments", label: "Attachment metadata", description: "Names, MIME, size, state only" },
  { key: "runEvidence", label: "Run evidence", description: "Redacted timeline and receipt posture" },
];

const SCOPE_LABELS: Record<WorkspaceTransferScope, string> = {
  "active-chat": "Active chat",
  "active-project": "Active project",
  workspace: "Entire workspace",
  custom: "Custom selection",
};

function cloneDraft(draft: TransferDraft): TransferDraft {
  return { ...draft, selection: { ...draft.selection } };
}

function countForScope(
  scope: WorkspaceTransferScope,
  activeProjectId: string,
  activeConversationId: string,
  projects: ReturnType<typeof useWorkspaceStore.getState>["projects"],
  conversations: ReturnType<typeof useWorkspaceStore.getState>["conversations"],
  memories: ReturnType<typeof useWorkspaceStore.getState>["memories"],
  skills: ReturnType<typeof useWorkspaceStore.getState>["skills"],
  artifacts: ReturnType<typeof useWorkspaceStore.getState>["artifacts"],
  attachments: ReturnType<typeof useWorkspaceStore.getState>["attachments"],
  runTimelineEvents: ReturnType<typeof useWorkspaceStore.getState>["runTimelineEvents"],
): Record<keyof WorkspaceTransferSelection, number> {
  const activeProject = projects.find((project) => project.id === activeProjectId);
  const activeConversation = conversations.find((conversation) => conversation.id === activeConversationId);
  const projectConversations = conversations.filter((conversation) => conversation.projectId === activeProjectId);
  const chatAttachmentIds = new Set(
    activeConversation?.messages.flatMap((message) => message.attachments.map((attachment) => attachment.id)) ?? [],
  );
  const scopedRunIds = new Set(
    (scope === "active-chat" ? [activeConversation] : projectConversations)
      .flatMap((conversation) => conversation?.messages ?? [])
      .map((message) => message.runId)
      .filter((runId): runId is string => typeof runId === "string" && runId.length > 0),
  );
  const scopedEvents = scope === "active-chat" || scope === "active-project"
    ? runTimelineEvents.filter((event) => scopedRunIds.has(event.runId))
    : runTimelineEvents;
  const scopedArtifacts = scope === "active-project"
    ? artifacts.filter((artifact) => artifact.projectName === activeProject?.name)
    : artifacts;
  const scopedAttachments = scope === "active-project"
    ? attachments.filter((attachment) => attachment.projectId === activeProjectId)
    : attachments;
  return {
    conversations: scope === "active-chat" ? (activeConversation ? 1 : 0) : scope === "active-project" ? projectConversations.length : conversations.length,
    projects: scope === "active-chat" ? (activeConversation?.projectId ? 1 : 0) : scope === "active-project" ? (activeProject ? 1 : 0) : projects.length,
    memoryCandidates: scope === "workspace" || scope === "custom" ? memories.length : memories.filter((memory) => memory.scopeLabel.includes(activeProject?.name ?? "__none__")).length,
    skills: scope === "workspace" || scope === "custom" ? skills.length : skills.filter((skill) => skill.scope === "Global" || skill.enabled).length,
    artifacts: scope === "active-project" ? scopedArtifacts.length : scope === "active-chat" ? 0 : artifacts.length,
    attachments: scope === "active-chat" ? chatAttachmentIds.size : scope === "active-project" ? scopedAttachments.length : attachments.length,
    runEvidence: scopedEvents.length,
  };
}

function estimateBytes(counts: Record<keyof WorkspaceTransferSelection, number>, selection: WorkspaceTransferSelection): number {
  const weights: Record<keyof WorkspaceTransferSelection, number> = {
    conversations: 640,
    projects: 520,
    memoryCandidates: 380,
    skills: 320,
    artifacts: 460,
    attachments: 180,
    runEvidence: 260,
  };
  return Math.max(420, Object.keys(weights).reduce((sum, key) => {
    const typedKey = key as keyof WorkspaceTransferSelection;
    return sum + (selection[typedKey] ? counts[typedKey] * weights[typedKey] : 0);
  }, 0));
}

function downloadManifest(payload: string, format: WorkspaceTransferFormat): boolean {
  if (typeof URL.createObjectURL !== "function") return false;
  const url = URL.createObjectURL(new Blob([payload], { type: format === "markdown" ? "text/markdown" : "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `omnia-transfer-preview.${format === "markdown" ? "md" : format}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  if (typeof URL.revokeObjectURL === "function") window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

export default function WorkspaceTransferHub() {
  const activeProjectId = useWorkspaceStore((state) => state.activeProjectId);
  const activeConversationId = useWorkspaceStore((state) => state.activeConversationId);
  const projects = useWorkspaceStore((state) => state.projects);
  const conversations = useWorkspaceStore((state) => state.conversations);
  const memories = useWorkspaceStore((state) => state.memories);
  const skills = useWorkspaceStore((state) => state.skills);
  const artifacts = useWorkspaceStore((state) => state.artifacts);
  const attachments = useWorkspaceStore((state) => state.attachments);
  const runTimelineEvents = useWorkspaceStore((state) => state.runTimelineEvents);
  const [history, setHistory] = useState<TransferHistory>({ past: [], present: cloneDraft(DEFAULT_DRAFT), future: [] });
  const [manifest, setManifest] = useState<WorkspaceTransferManifest | null>(null);
  const [importText, setImportText] = useState("");
  const [status, setStatus] = useState("Choose a transfer direction and prepare a renderer-local manifest.");
  const draft = history.present;
  const counts = useMemo(
    () => countForScope(draft.scope, activeProjectId, activeConversationId, projects, conversations, memories, skills, artifacts, attachments, runTimelineEvents),
    [activeConversationId, activeProjectId, artifacts, attachments, conversations, draft.scope, memories, projects, runTimelineEvents, skills],
  );
  const selectedRecordCount = useMemo(
    () => SELECTION_META.reduce((sum, item) => sum + (draft.selection[item.key] ? counts[item.key] : 0), 0),
    [counts, draft.selection],
  );
  const estimatedBytes = useMemo(() => estimateBytes(counts, draft.selection), [counts, draft.selection]);
  const payload = manifest ? serializeWorkspaceTransferManifest(manifest, draft.format) : "";

  const commit = (patch: Partial<TransferDraft>, nextStatus?: string) => {
    setHistory((current) => {
      const next = cloneDraft({ ...current.present, ...patch, selection: patch.selection ? { ...patch.selection } : current.present.selection });
      return { past: [...current.past, cloneDraft(current.present)].slice(-20), present: next, future: [] };
    });
    setManifest(null);
    if (nextStatus) setStatus(nextStatus);
  };

  const setSelection = (key: keyof WorkspaceTransferSelection, value: boolean) => {
    commit({ selection: { ...draft.selection, [key]: value } }, `${value ? "Included" : "Excluded"} ${SELECTION_META.find((item) => item.key === key)?.label ?? key}.`);
  };

  const prepare = () => {
    const warnings = [
      "This manifest describes metadata only; raw file bytes, secrets, and provider payloads are excluded.",
      draft.mode === "import" ? "Staging does not mutate chats, projects, files, memory, or settings." : "Native export, backup, restore, and archive receipts remain Planned.",
    ];
    if (draft.profile === "support") warnings.push("Support profile expects redacted diagnostics; no telemetry upload is performed.");
    if (draft.profile === "recovery") warnings.push("Recovery profile is a plan preview; no encrypted package or restore point is created.");
    if (draft.redaction === "full-metadata") warnings.push("Full metadata preview is still renderer-local and never includes raw credentials.");
    const nextManifest = buildWorkspaceTransferManifest({
      mode: draft.mode,
      scope: draft.scope,
      profile: draft.profile,
      format: draft.format,
      redaction: draft.redaction,
      target: draft.target,
      selection: draft.selection,
      counts,
      estimatedBytes,
      records: selectedRecordCount,
      warnings,
    });
    setManifest(nextManifest);
    setStatus(`${draft.mode === "import" ? "Staged" : "Prepared"} ${nextManifest.records} visible records in a renderer-local transfer preview.`);
  };

  const undo = () => {
    setHistory((current) => {
      const previous = current.past.at(-1);
      if (!previous) return current;
      return { past: current.past.slice(0, -1), present: cloneDraft(previous), future: [cloneDraft(current.present), ...current.future] };
    });
    setManifest(null);
    setStatus("Undid the last transfer setting change.");
  };

  const redo = () => {
    setHistory((current) => {
      const next = current.future[0];
      if (!next) return current;
      return { past: [...current.past, cloneDraft(current.present)], present: cloneDraft(next), future: current.future.slice(1) };
    });
    setManifest(null);
    setStatus("Reapplied the next transfer setting change.");
  };

  const reset = () => {
    setHistory({ past: [], present: cloneDraft(DEFAULT_DRAFT), future: [] });
    setManifest(null);
    setImportText("");
    setStatus("Reset transfer direction, scope, profile, and selection to defaults.");
  };

  const copy = async () => {
    if (!manifest) {
      setStatus("Prepare a transfer preview before copying it.");
      return;
    }
    if (!navigator.clipboard?.writeText) {
      setStatus("Clipboard unavailable; no transfer manifest was copied.");
      return;
    }
    try {
      await navigator.clipboard.writeText(payload);
      setStatus(`Copied ${draft.format.toUpperCase()} transfer preview; no durable file was written.`);
    } catch {
      setStatus("Clipboard write failed; no transfer manifest was copied.");
    }
  };

  const download = () => {
    if (!manifest) {
      setStatus("Prepare a transfer preview before downloading it.");
      return;
    }
    setStatus(downloadManifest(payload, draft.format) ? "Browser download started; no native archive was created." : "Browser download is unavailable; no file was written.");
  };

  const stageImportedManifest = () => {
    const result = parseWorkspaceTransferManifest(importText);
    if (!result.ok) {
      setStatus(result.error);
      return;
    }
    const imported = result.manifest;
    setHistory((current) => ({
      past: [...current.past, cloneDraft(current.present)].slice(-20),
      present: {
        mode: imported.mode,
        scope: imported.scope,
        profile: imported.profile,
        format: imported.format,
        redaction: imported.redaction,
        target: imported.target,
        selection: { ...imported.selection },
      },
      future: [],
    }));
    setManifest(imported);
    setStatus(`Staged ${imported.records} records from an Omnia transfer manifest in this renderer session.`);
  };

  const selectedProject = projects.find((project) => project.id === activeProjectId);
  const selectedConversation = conversations.find((conversation) => conversation.id === activeConversationId);

  return (
    <section className="workspace-transfer-hub settings-section" aria-labelledby="workspace-transfer-title">
      <header className="workspace-transfer-hub__header">
        <div>
          <span className="eyebrow">Move work · preserve control</span>
          <h2 id="workspace-transfer-title">Workspace Transfer Hub</h2>
          <p>Prepare an inspectable handoff, support bundle, or recovery plan before any native transfer capability exists.</p>
        </div>
        <span className="workspace-transfer-hub__badge"><FileArchive size={14} /> Preview only</span>
      </header>

      <div className="workspace-transfer-hub__boundary" role="note">
        <ShieldCheck size={16} />
        <span>Renderer-local · metadata-only · no durable write · no provider request · no filesystem read · native import/export/restore remains Planned.</span>
      </div>

      <div className="workspace-transfer-hub__flow" aria-label="Transfer direction">
        <button type="button" className={draft.mode === "export" ? "workspace-transfer-hub__flow-card workspace-transfer-hub__flow-card--active" : "workspace-transfer-hub__flow-card"} onClick={() => commit({ mode: "export" }, "Export direction selected; no native export has started.")}>
          <ArrowUpFromLine size={17} /><strong>Export</strong><small>Package renderer-visible metadata</small>
        </button>
        <ArrowRight className="workspace-transfer-hub__flow-arrow" size={18} aria-hidden="true" />
        <button type="button" className={draft.mode === "handoff" ? "workspace-transfer-hub__flow-card workspace-transfer-hub__flow-card--active" : "workspace-transfer-hub__flow-card"} onClick={() => commit({ mode: "handoff" }, "Handoff direction selected; no native sync has started.")}>
          <History size={17} /><strong>Handoff</strong><small>Prepare a portable collaboration manifest</small>
        </button>
        <ArrowRight className="workspace-transfer-hub__flow-arrow" size={18} aria-hidden="true" />
        <button type="button" className={draft.mode === "import" ? "workspace-transfer-hub__flow-card workspace-transfer-hub__flow-card--active" : "workspace-transfer-hub__flow-card"} onClick={() => commit({ mode: "import" }, "Import direction selected; choose a manifest to stage locally.")}>
          <ArrowDownToLine size={17} /><strong>Import</strong><small>Stage a manifest for review</small>
        </button>
      </div>

      <div className="workspace-transfer-hub__controls">
        <label><span>Scope</span><select aria-label="Workspace transfer scope" value={draft.scope} onChange={(event) => commit({ scope: event.target.value as WorkspaceTransferScope }, `${SCOPE_LABELS[event.target.value as WorkspaceTransferScope]} selected.`)}>{(Object.entries(SCOPE_LABELS) as Array<[WorkspaceTransferScope, string]>).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label><span>Package profile</span><select aria-label="Workspace transfer profile" value={draft.profile} onChange={(event) => commit({ profile: event.target.value as WorkspaceTransferProfile }, `${PROFILE_META[event.target.value as WorkspaceTransferProfile].label} selected.`)}>{(Object.entries(PROFILE_META) as Array<[WorkspaceTransferProfile, typeof PROFILE_META[WorkspaceTransferProfile]]>).map(([value, meta]) => <option key={value} value={value}>{meta.label}</option>)}</select></label>
        <label><span>Format</span><select aria-label="Workspace transfer format" value={draft.format} onChange={(event) => commit({ format: event.target.value as WorkspaceTransferFormat }, `Transfer format changed to ${event.target.value.toUpperCase()}.`)}><option value="json">JSON manifest</option><option value="jsonl">JSONL stream</option><option value="markdown">Markdown brief</option></select></label>
        <label><span>Redaction</span><select aria-label="Workspace transfer redaction" value={draft.redaction} onChange={(event) => commit({ redaction: event.target.value as WorkspaceTransferRedaction }, `Redaction changed to ${event.target.value}.`)}><option value="safe">Safe preview</option><option value="developer">Developer trace</option><option value="full-metadata">Full metadata preview</option></select></label>
      </div>

      <div className="workspace-transfer-hub__target-row">
        <label><span>Target label</span><input aria-label="Workspace transfer target" value={draft.target} onChange={(event) => commit({ target: event.target.value })} placeholder="e.g. Omnia desktop, teammate, support ticket" /></label>
        <div className="workspace-transfer-hub__context"><span>Current context</span><strong>{selectedProject?.name ?? "Standalone"}</strong><small>{selectedConversation?.title ?? "No active chat selected"}</small></div>
      </div>

      <section className="workspace-transfer-hub__profile" aria-label="Selected transfer profile">
        <div><span className="eyebrow">{PROFILE_META[draft.profile].label}</span><p>{PROFILE_META[draft.profile].description}</p></div>
        <span>{PROFILE_META[draft.profile].detail}</span>
      </section>

      <section className="workspace-transfer-hub__selection" aria-labelledby="workspace-transfer-selection-title">
        <header><div><span className="eyebrow">Contents</span><h3 id="workspace-transfer-selection-title">Choose what travels</h3></div><span>{selectedRecordCount} records · ~{Math.ceil(estimatedBytes / 1024)} KB</span></header>
        <div className="workspace-transfer-hub__selection-grid">
          {SELECTION_META.map((item) => <label className={draft.selection[item.key] ? "workspace-transfer-option workspace-transfer-option--active" : "workspace-transfer-option"} key={item.key}><input type="checkbox" aria-label={item.label} checked={draft.selection[item.key]} onChange={(event) => setSelection(item.key, event.target.checked)} /><span><strong>{item.label}</strong><small>{item.description}</small></span><b>{counts[item.key]}</b></label>)}
        </div>
      </section>

      {draft.mode === "import" ? <section className="workspace-transfer-hub__import" aria-label="Stage transfer manifest"><header><div><span className="eyebrow">Import rehearsal</span><h3>Stage a manifest</h3></div><Upload size={17} /></header><textarea aria-label="Workspace transfer manifest import" value={importText} onChange={(event) => setImportText(event.target.value)} placeholder="Paste an Omnia workspace transfer JSON manifest here…" /><button type="button" className="button button--secondary" onClick={stageImportedManifest}><Check size={14} /> Stage manifest in preview</button></section> : null}

      <div className="workspace-transfer-hub__actions">
        <button type="button" className="button button--primary" onClick={prepare}>{draft.mode === "import" ? <Upload size={14} /> : <FileArchive size={14} />}{draft.mode === "import" ? "Prepare import preview" : "Generate transfer preview"}</button>
        <button type="button" className="button button--ghost" onClick={undo} disabled={history.past.length === 0} aria-label="Undo workspace transfer change"><Undo2 size={14} /> Undo</button>
        <button type="button" className="button button--ghost" onClick={redo} disabled={history.future.length === 0} aria-label="Redo workspace transfer change"><Redo2 size={14} /> Redo</button>
        <button type="button" className="button button--ghost" onClick={reset}><RotateCcw size={14} /> Reset</button>
        {manifest ? <><button type="button" className="button button--ghost" onClick={() => void copy()}><Clipboard size={14} /> Copy {draft.format.toUpperCase()}</button><button type="button" className="button button--secondary" onClick={download}><Download size={14} /> Download</button></> : null}
      </div>

      {manifest ? <section className="workspace-transfer-hub__preview" role="region" aria-label="Workspace transfer manifest preview"><header><div><span className="eyebrow">Manifest ready</span><h3>{manifest.records} records staged in preview</h3></div><span className="workspace-transfer-hub__status-chip">{manifest.executionDisposition}</span></header><div className="workspace-transfer-hub__summary"><div><span>Mode</span><strong>{manifest.mode}</strong></div><div><span>Scope</span><strong>{SCOPE_LABELS[manifest.scope]}</strong></div><div><span>Profile</span><strong>{PROFILE_META[manifest.profile].label}</strong></div><div><span>Size estimate</span><strong>{Math.ceil(manifest.estimatedBytes / 1024)} KB</strong></div></div><details open><summary>Inspect manifest</summary><pre><code>{payload}</code></pre></details><ul>{manifest.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></section> : null}

      <p className="workspace-transfer-hub__status" role="status" aria-live="polite">{status}</p>
    </section>
  );
}
