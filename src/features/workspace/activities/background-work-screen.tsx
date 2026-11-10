import { Clipboard, Download, FileJson2 } from "lucide-react";
import { useMemo, useState } from "react";

import type { ActivityScreenProps } from "../activity-registry";
import {
  BackgroundWorkInspector,
  backgroundWorkRowsFromProjection,
} from "../background-work-inspector";
import { MissionControlSignalCenter } from "../mission-control-signal-center";
import { BackgroundWorkOptionalWorkbench } from "../background-work-optional-workbench";
import type { UnifiedEventRecord } from "../unified-event-contract";
import {
  NotificationCenterPreview,
  notificationItemsFromBackgroundRows,
} from "../notification-center-preview";
import { AgentMeshSupervisorPreview } from "../agent-mesh-supervisor-preview";
import { projectBackgroundWork } from "../background-work-projection";
import {
  downloadBackgroundWorkExport,
  serializeBackgroundWorkExport,
  type BackgroundWorkExportFormat,
} from "../background-work-export";
import { ScreenHeader } from "../screen-header";
import { useWorkspaceStore } from "../store";

/**
 * Activity entry point for the bounded background-work projection.
 *
 * This is intentionally a read-only renderer surface. Native scheduling,
 * agent leases, queue mutation, approvals, and cancellation remain outside
 * this activity until their authoritative bridge exists.
 */
export default function BackgroundWorkScreen(_props: Partial<ActivityScreenProps>) {
  const conversations = useWorkspaceStore((state) => state.conversations);
  const timelineEvents = useWorkspaceStore((state) => state.runTimelineEvents);
  const runControlOperationsById = useWorkspaceStore((state) => state.runControlOperationsById);
  const checkpointsByRunId = useWorkspaceStore((state) => state.checkpointsByRunId);
  const selectConversation = useWorkspaceStore((state) => state.selectConversation);
  const projects = useWorkspaceStore((state) => state.projects);
  const selectProject = useWorkspaceStore((state) => state.selectProject);
  const setActivity = useWorkspaceStore((state) => state.setActivity);

  const projection = projectBackgroundWork({
    conversations,
    runTimelineEvents: timelineEvents,
    runControlOperations: Object.values(runControlOperationsById),
    checkpoints: Object.values(checkpointsByRunId),
  });
  const rows = backgroundWorkRowsFromProjection(projection);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportFormat, setExportFormat] = useState<BackgroundWorkExportFormat>("json");
  const [exportStatus, setExportStatus] = useState("Renderer-session export; no durable write.");
  const exportPayload = useMemo(
    () => serializeBackgroundWorkExport({ projection, format: exportFormat }),
    [exportFormat, projection],
  );

  const copyExport = async () => {
    if (!navigator.clipboard?.writeText) {
      setExportStatus("Clipboard is unavailable in this preview environment.");
      return;
    }
    try {
      await navigator.clipboard.writeText(exportPayload);
      setExportStatus(`${exportFormat.toUpperCase()} preview copied; no durable write was made.`);
    } catch {
      setExportStatus("Clipboard write was unavailable; the preview remains renderer-local.");
    }
  };

  const downloadExport = () => {
    setExportStatus(
      downloadBackgroundWorkExport(exportPayload, exportFormat)
        ? `${exportFormat.toUpperCase()} browser download started; no native export receipt was created.`
        : "Browser download is unavailable in this preview environment.",
    );
  };

  const openSignal = (event: UnifiedEventRecord) => {
    if (event.conversationId) {
      selectConversation(event.conversationId);
      return;
    }
    if (event.projectId) {
      selectProject(event.projectId);
      return;
    }
    if (event.source === "chat") {
      setActivity("chats");
      return;
    }
    if (event.source === "project") {
      setActivity("projects");
      return;
    }
    setActivity("work");
  };

  return (
    <div className="screen-scroll background-work-screen">
      <ScreenHeader
        title="Background work"
        action={
          <button
            type="button"
            className="button button--secondary"
            title={exportOpen ? "Hide the background work export" : "Export the visible background work projection"}
            onClick={() => setExportOpen((value) => !value)}
            aria-expanded={exportOpen}
            aria-controls="background-work-export-preview"
          >
            <FileJson2 size={14} /> Export
          </button>
        }
      />
      {exportOpen ? (
        <section
          id="background-work-export-preview"
          className="background-work-export background-work-export__body"
          aria-label="Background work export preview"
        >
          <div className="background-work-export__toolbar" role="toolbar" aria-label="Background work export actions">
            <label><span>Format</span><select value={exportFormat} onChange={(event) => setExportFormat(event.target.value as BackgroundWorkExportFormat)} aria-label="Background work export format"><option value="json">JSON</option><option value="markdown">Markdown</option></select></label>
            <button type="button" className="button button--secondary" title="Copy the renderer-local background work export" onClick={() => void copyExport()}><Clipboard size={13} /> Copy</button>
            <button type="button" className="button button--secondary" title="Download the renderer-local background work export" onClick={downloadExport}><Download size={13} /> Download</button>
          </div>
          <pre role="region" className="background-work-export__code" aria-label={`${exportFormat === "json" ? "JSON" : "Markdown"} background work export preview`}>{exportPayload}</pre>
          <p className="background-work-export__status" role="status" aria-live="polite">{exportStatus}</p>
        </section>
      ) : null}
      <BackgroundWorkInspector
        rows={rows}
        onOpenThread={(row) => {
          if (row.sourceThreadId) selectConversation(row.sourceThreadId);
        }}
      />
      {/* The queue above is the live view; the cross-source signal stream repeats its counts, so it opens on demand. */}
      <details className="ws-disclosure">
        <summary>All signals (chats, projects, runs)</summary>
        <div className="ws-disclosure__body">
          <MissionControlSignalCenter
            title="Work signal bridge"
            conversations={conversations}
            projects={projects}
            backgroundWork={projection.items}
            runTimeline={timelineEvents}
            onOpenEvent={openSignal}
          />
        </div>
      </details>
      <details className="ws-disclosure">
        <summary>Notifications, supervisor and deeper views</summary>
        <div className="ws-disclosure__body">
          <NotificationCenterPreview
            items={notificationItemsFromBackgroundRows(rows)}
            onOpenItem={(item) => {
              if (item.conversationId) selectConversation(item.conversationId);
            }}
          />
          <AgentMeshSupervisorPreview linkedWorkCount={rows.length} />
          <BackgroundWorkOptionalWorkbench rows={rows} />
        </div>
      </details>
    </div>
  );
}
