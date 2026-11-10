import {
  Activity,
  ArchiveRestore,
  Check,
  CheckCircle2,
  Clipboard,
  Database,
  Download,
  FileCheck2,
  HardDrive,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Timer,
  Undo2,
  Redo2,
  AlertTriangle,
} from "lucide-react";
import { useMemo, useState } from "react";

import { useWorkspaceStore } from "./store";

type StorageScope = "active-project" | "workspace";
type BackupCadence = "manual" | "daily" | "weekly";
type IntegrityMode = "manifest" | "hash-plan" | "encrypted-plan";

type StorageDraft = {
  scope: StorageScope;
  cadence: BackupCadence;
  retention: number;
  integrity: IntegrityMode;
  includeAttachments: boolean;
  includeDiagnostics: boolean;
};

type StorageHistory = {
  past: StorageDraft[];
  present: StorageDraft;
  future: StorageDraft[];
};

type StorageFacts = {
  projectCount: number;
  conversationCount: number;
  attachmentCount: number;
  readyAttachments: number;
  warningAttachments: number;
  failedAttachments: number;
  estimatedBytes: number;
  activeProjectName: string | null;
};

const defaultDraft: StorageDraft = {
  scope: "active-project",
  cadence: "manual",
  retention: 5,
  integrity: "manifest",
  includeAttachments: true,
  includeDiagnostics: false,
};

const scopeLabels: Record<StorageScope, string> = {
  "active-project": "Active project",
  workspace: "Entire workspace",
};

const cadenceLabels: Record<BackupCadence, string> = {
  manual: "Manual / on demand",
  daily: "Daily preview",
  weekly: "Weekly preview",
};

const integrityLabels: Record<IntegrityMode, string> = {
  manifest: "Manifest only",
  "hash-plan": "Hash verification plan",
  "encrypted-plan": "Encrypted package plan",
};

function cloneDraft(draft: StorageDraft): StorageDraft {
  return { ...draft };
}

function sameDraft(left: StorageDraft, right: StorageDraft): boolean {
  return (
    left.scope === right.scope &&
    left.cadence === right.cadence &&
    left.retention === right.retention &&
    left.integrity === right.integrity &&
    left.includeAttachments === right.includeAttachments &&
    left.includeDiagnostics === right.includeDiagnostics
  );
}

function parseSizeLabel(value: string): number {
  const match = value.trim().match(/([\d.]+)\s*(kb|mb|gb|tb|b)?/i);
  if (!match) return 0;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return 0;
  const unit = match[2]?.toLowerCase() ?? "b";
  const multiplier = unit === "tb" ? 1024 ** 4 : unit === "gb" ? 1024 ** 3 : unit === "mb" ? 1024 ** 2 : unit === "kb" ? 1024 : 1;
  return Math.round(amount * multiplier);
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "Not measured";
  if (bytes < 1024) return `${bytes} B est.`;
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} KB est.`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB est.`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB est.`;
}

function factsForScope(
  scope: StorageScope,
  activeProjectId: string,
  projects: ReturnType<typeof useWorkspaceStore.getState>["projects"],
  conversations: ReturnType<typeof useWorkspaceStore.getState>["conversations"],
  attachments: ReturnType<typeof useWorkspaceStore.getState>["attachments"],
): StorageFacts {
  const activeProject = projects.find((project) => project.id === activeProjectId) ?? null;
  const scopedProjects = scope === "workspace" ? projects : activeProject ? [activeProject] : [];
  const scopedProjectIds = new Set(scopedProjects.map((project) => project.id));
  const scopedConversations = conversations.filter((conversation) =>
    scope === "workspace" ? true : conversation.projectId === activeProjectId,
  );
  const scopedAttachments = attachments.filter((attachment) =>
    scope === "workspace" || attachment.projectId === activeProjectId ||
    (attachment.projectId == null && scopedConversations.some((conversation) =>
      conversation.messages.some((message) => message.attachments.some((item) => item.id === attachment.id)),
    )),
  );
  const estimatedBytes = scopedAttachments.reduce(
    (total, attachment) => total + (attachment.byteSize ?? parseSizeLabel(attachment.size)),
    0,
  );

  return {
    projectCount: scopedProjectIds.size,
    conversationCount: scopedConversations.length,
    attachmentCount: scopedAttachments.length,
    readyAttachments: scopedAttachments.filter((attachment) => attachment.state === "ready").length,
    warningAttachments: scopedAttachments.filter((attachment) => attachment.state === "warning").length,
    failedAttachments: scopedAttachments.filter((attachment) => attachment.state === "failed").length,
    estimatedBytes,
    activeProjectName: activeProject?.name ?? null,
  };
}

function createPayload(draft: StorageDraft, facts: StorageFacts, generatedAt: string) {
  return {
    schema: "omnia.storage-health-preview.v1",
    scope: "renderer-session",
    generatedAt,
    target: {
      kind: draft.scope,
      label: scopeLabels[draft.scope],
      projectName: facts.activeProjectName,
    },
    inventory: {
      projects: facts.projectCount,
      conversations: facts.conversationCount,
      attachments: draft.includeAttachments ? facts.attachmentCount : 0,
      estimatedAttachmentBytes: draft.includeAttachments ? facts.estimatedBytes : null,
    },
    backupPlan: {
      cadence: draft.cadence,
      retentionRevisions: draft.retention,
      integrity: draft.integrity,
      includeDiagnostics: draft.includeDiagnostics,
    },
    checks: {
      rendererProjection: "ready",
      nativeDatabase: "planned",
      filesystemUsage: "not-measured",
      backupRestore: "not-run",
    },
    boundary:
      "Renderer-local storage health and backup planning preview only; no filesystem read, native database probe, backup write, restore point, or scheduler action was created.",
  } as const;
}

function serializePayload(payload: ReturnType<typeof createPayload>, format: "json" | "markdown"): string {
  if (format === "json") return JSON.stringify(payload, null, 2);
  return [
    "# Omnia storage health preview",
    "",
    "> Renderer-local preview only; no storage probe or backup write was performed.",
    "",
    `- Scope: ${payload.target.label}`,
    `- Projects: ${payload.inventory.projects}`,
    `- Conversations: ${payload.inventory.conversations}`,
    `- Attachments: ${payload.inventory.attachments}`,
    `- Estimated attachment bytes: ${payload.inventory.estimatedAttachmentBytes === null ? "excluded" : formatBytes(payload.inventory.estimatedAttachmentBytes)}`,
    `- Cadence: ${cadenceLabels[payload.backupPlan.cadence]}`,
    `- Retention: ${payload.backupPlan.retentionRevisions} revisions`,
    `- Integrity: ${integrityLabels[payload.backupPlan.integrity]}`,
    `- Native database: ${payload.checks.nativeDatabase}`,
    `- Filesystem usage: ${payload.checks.filesystemUsage}`,
    `- Backup/restore: ${payload.checks.backupRestore}`,
  ].join("\n");
}

function downloadText(payload: string, format: "json" | "markdown"): boolean {
  if (typeof URL.createObjectURL !== "function") return false;
  const url = URL.createObjectURL(new Blob([payload], { type: format === "json" ? "application/json" : "text/markdown" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `omnia-storage-health-preview.${format === "json" ? "json" : "md"}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  if (typeof URL.revokeObjectURL === "function") window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

export function StorageHealthPreview() {
  const activeProjectId = useWorkspaceStore((state) => state.activeProjectId);
  const projects = useWorkspaceStore((state) => state.projects);
  const conversations = useWorkspaceStore((state) => state.conversations);
  const attachments = useWorkspaceStore((state) => state.attachments);
  const [history, setHistory] = useState<StorageHistory>({ past: [], present: cloneDraft(defaultDraft), future: [] });
  const [reportOpen, setReportOpen] = useState(false);
  const [format, setFormat] = useState<"json" | "markdown">("json");
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [status, setStatus] = useState("Review renderer-visible storage facts before native storage is connected.");
  const [exportStatus, setExportStatus] = useState("No storage report has been exported.");
  const draft = history.present;
  const facts = useMemo(
    () => factsForScope(draft.scope, activeProjectId, projects, conversations, attachments),
    [activeProjectId, attachments, conversations, draft.scope, projects],
  );
  const reportPayload = useMemo(
    () => createPayload(draft, facts, generatedAt ?? "not-generated"),
    [draft, facts, generatedAt],
  );
  const serialized = useMemo(() => serializePayload(reportPayload, format), [format, reportPayload]);

  const commit = (patch: Partial<StorageDraft>, nextStatus: string) => {
    setHistory((current) => {
      const next = { ...current.present, ...patch };
      if (sameDraft(next, current.present)) return current;
      return { past: [...current.past, cloneDraft(current.present)], present: next, future: [] };
    });
    setStatus(nextStatus);
  };

  const undo = () => {
    setHistory((current) => {
      const previous = current.past.at(-1);
      if (!previous) return current;
      return { past: current.past.slice(0, -1), present: cloneDraft(previous), future: [cloneDraft(current.present), ...current.future] };
    });
    setStatus("Undid the last storage health preview change.");
  };

  const redo = () => {
    setHistory((current) => {
      const next = current.future[0];
      if (!next) return current;
      return { past: [...current.past, cloneDraft(current.present)], present: cloneDraft(next), future: current.future.slice(1) };
    });
    setStatus("Reapplied the next storage health preview change.");
  };

  const reset = () => {
    setHistory((current) => {
      if (sameDraft(current.present, defaultDraft)) return current;
      return { past: [...current.past, cloneDraft(current.present)], present: cloneDraft(defaultDraft), future: [] };
    });
    setStatus("Storage health preview reset to safe defaults.");
  };

  const refresh = () => {
    setGeneratedAt(new Date().toISOString());
    setStatus("Refreshed renderer-visible storage facts. Native storage was not probed.");
  };

  const generateReport = () => {
    setGeneratedAt(new Date().toISOString());
    setReportOpen(true);
    setStatus("Generated a renderer-local storage health and backup report.");
  };

  const copyReport = async () => {
    if (!navigator.clipboard?.writeText) {
      setExportStatus("Clipboard access is unavailable; no storage report was copied.");
      return;
    }
    try {
      await navigator.clipboard.writeText(serialized);
      setExportStatus(`Copied the renderer-local ${format.toUpperCase()} storage report.`);
    } catch {
      setExportStatus("Clipboard access was denied; no storage report was copied.");
    }
  };

  const downloadReport = () => {
    setExportStatus(
      downloadText(serialized, format)
        ? "Started a browser download of the renderer-local storage report."
        : "Browser download is unavailable; no storage report file was written.",
    );
  };

  const totalChecks = 4;
  const readyChecks = 1;
  const healthLabel = facts.failedAttachments > 0 ? "Review" : facts.warningAttachments > 0 ? "Attention" : "Preview ready";

  return (
    <section className="storage-health-preview" aria-labelledby="storage-health-preview-title">
      <header className="storage-health-preview__header">
        <span className="storage-health-preview__mark" aria-hidden="true"><HardDrive size={18} /></span>
        <div>
          <span className="eyebrow">Storage observability</span>
          <h3 id="storage-health-preview-title">Storage health &amp; backup preview</h3>
          <p>See what the renderer can summarize now, and what still needs a native storage probe.</p>
        </div>
        <span className="storage-health-preview__status"><Sparkles size={13} /> Renderer preview</span>
      </header>

      <div className="storage-health-preview__history" role="toolbar" aria-label="Storage health preview history">
        <span role="status" aria-live="polite">{status}</span>
        <span>{history.past.length + history.future.length} preview steps</span>
        <button type="button" className="button button--ghost" onClick={undo} disabled={history.past.length === 0} aria-label="Undo storage health preview change"><Undo2 size={14} /> Undo</button>
        <button type="button" className="button button--ghost" onClick={redo} disabled={history.future.length === 0} aria-label="Redo storage health preview change"><Redo2 size={14} /> Redo</button>
        <button type="button" className="button button--ghost" onClick={reset} disabled={sameDraft(draft, defaultDraft)} aria-label="Reset storage health preview"><RotateCcw size={14} /> Reset</button>
      </div>

      <div className="storage-health-preview__metrics" aria-label="Storage health preview summary">
        <article><Database size={15} /><strong>{formatBytes(facts.estimatedBytes)}</strong><small>Estimated attachment footprint</small></article>
        <article><ArchiveRestore size={15} /><strong>{facts.attachmentCount}</strong><small>Attachment records in scope</small></article>
        <article><CheckCircle2 size={15} /><strong>{readyChecks}/{totalChecks}</strong><small>Checks evidenced here</small></article>
        <article className={facts.failedAttachments > 0 ? "is-warning" : ""}><Activity size={15} /><strong>{healthLabel}</strong><small>Renderer posture</small></article>
      </div>

      <div className="storage-health-preview__controls">
        <label><span>Health scope</span><select value={draft.scope} onChange={(event) => commit({ scope: event.target.value as StorageScope }, `${scopeLabels[event.target.value as StorageScope]} selected for the storage preview.`)} aria-label="Storage health scope"><option value="active-project">Active project</option><option value="workspace">Entire workspace</option></select></label>
        <label><span>Backup cadence</span><select value={draft.cadence} onChange={(event) => commit({ cadence: event.target.value as BackupCadence }, `${cadenceLabels[event.target.value as BackupCadence]} selected as a preview.`)} aria-label="Backup cadence preview"><option value="manual">Manual / on demand</option><option value="daily">Daily preview</option><option value="weekly">Weekly preview</option></select></label>
        <label><span>Retention window</span><select value={draft.retention} onChange={(event) => commit({ retention: Number(event.target.value) }, `Retention set to ${event.target.value} revisions in the preview.`)} aria-label="Backup retention revisions"><option value="3">3 revisions</option><option value="5">5 revisions</option><option value="12">12 revisions</option><option value="40">40 revisions</option></select></label>
        <label><span>Integrity posture</span><select value={draft.integrity} onChange={(event) => commit({ integrity: event.target.value as IntegrityMode }, `${integrityLabels[event.target.value as IntegrityMode]} selected for the preview.`)} aria-label="Backup integrity posture"><option value="manifest">Manifest only</option><option value="hash-plan">Hash verification plan</option><option value="encrypted-plan">Encrypted package plan</option></select></label>
      </div>

      <div className="storage-health-preview__checks" role="list" aria-label="Storage health checks">
        <article role="listitem" className="storage-health-preview__check storage-health-preview__check--ready"><span className="storage-health-preview__check-icon"><Check size={14} /></span><div><strong>Renderer inventory</strong><small>{facts.projectCount} project · {facts.conversationCount} conversation · {facts.attachmentCount} attachment records summarized from mounted preview state.</small></div><span className="storage-health-preview__check-state">Ready</span></article>
        <article role="listitem" className="storage-health-preview__check"><span className="storage-health-preview__check-icon"><HardDrive size={14} /></span><div><strong>Filesystem usage</strong><small>Not measured. The browser preview does not inspect workspace folders or disk free space.</small></div><span className="storage-health-preview__check-state">Unknown</span></article>
        <article role="listitem" className="storage-health-preview__check"><span className="storage-health-preview__check-icon"><Database size={14} /></span><div><strong>Native database</strong><small>SQLite health, WAL state, migrations, and recovery journal need the desktop bridge.</small></div><span className="storage-health-preview__check-state">Planned</span></article>
        <article role="listitem" className="storage-health-preview__check"><span className="storage-health-preview__check-icon"><ShieldCheck size={14} /></span><div><strong>Backup / restore rehearsal</strong><small>Retention and integrity are only a plan preview; no archive, hash, encryption, or restore point exists.</small></div><span className="storage-health-preview__check-state">Not run</span></article>
      </div>

      <div className="storage-health-preview__facts" aria-label="Attachment readiness summary">
        <span><FileCheck2 size={14} /><strong>{facts.readyAttachments}</strong> ready</span>
        <span><AlertTriangle size={14} /><strong>{facts.warningAttachments}</strong> warning</span>
        <span><Timer size={14} /><strong>{facts.failedAttachments}</strong> failed</span>
        <span><span className="storage-health-preview__fact-note">Estimated sizes only; native bytes are not read.</span></span>
      </div>

      <div className="storage-health-preview__actions">
        <span><strong>{generatedAt ? `Last preview ${new Date(generatedAt).toLocaleTimeString()}` : "No preview generated yet"}</strong><small>{scopeLabels[draft.scope]} · {cadenceLabels[draft.cadence]} · {integrityLabels[draft.integrity]}</small></span>
        <div><button type="button" className="button button--secondary" onClick={refresh}><RefreshCw size={14} /> Refresh facts</button><button type="button" className="button button--primary" onClick={generateReport}><ArchiveRestore size={14} /> Generate backup plan</button></div>
      </div>

      {reportOpen ? (
        <section className="storage-health-preview__report" aria-label="Storage health report preview">
          <div className="storage-health-preview__report-toolbar">
            <span><strong>Portable storage report</strong><small>{exportStatus}</small></span>
            <label><span>Format</span><select value={format} onChange={(event) => setFormat(event.target.value as "json" | "markdown")} aria-label="Storage health report format"><option value="json">JSON</option><option value="markdown">Markdown</option></select></label>
            <button type="button" className="button button--secondary" onClick={() => void copyReport()}><Clipboard size={14} /> Copy</button>
            <button type="button" className="button button--secondary" onClick={downloadReport}><Download size={14} /> Browser download</button>
          </div>
          <pre><code>{serialized}</code></pre>
          <p><ShieldCheck size={12} /> This report contains renderer-visible metadata and planning choices only. Native storage health, backup bytes, restore points, and verification receipts remain unavailable.</p>
        </section>
      ) : null}

      <aside className="storage-health-preview__boundary" role="note" aria-label="Storage health preview boundary"><ShieldCheck size={16} /><div><strong>Boundary: preview only</strong><p>No filesystem read, disk probe, SQLite query, archive write, encryption operation, restore, scheduler action, or provider request occurs here.</p></div></aside>
    </section>
  );
}

export default StorageHealthPreview;
