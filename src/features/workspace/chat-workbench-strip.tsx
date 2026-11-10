import {
  Activity,
  Check,
  CircleDot,
  Cpu,
  GitBranch,
  Layers3,
  PanelRight,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { useMemo, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";

import { isDesktopRuntime } from "@/lib/desktop";

import { useWorkspaceStore } from "./store";
import { hasNativeProviderConnection, providerStateLabel } from "./provider-catalog";
import { buildProjectContextAvailabilityForProject } from "./project-context-availability-contract";
import type { ConversationView, ModelProfileView, ProviderView } from "./types";
import { RunActionPreview, type RunActionPreviewState } from "./run-action-preview";

type ChatWorkbenchTab = "overview" | "route" | "context" | "run";

const tabs: Array<{ id: ChatWorkbenchTab; label: string; icon: typeof Layers3 }> = [
  { id: "overview", label: "Overview", icon: Activity },
  { id: "route", label: "Route", icon: Cpu },
  { id: "context", label: "Context", icon: Layers3 },
  { id: "run", label: "Run", icon: CircleDot },
];

interface ChatWorkbenchStripProps {
  readonly conversation: ConversationView;
  readonly model: ModelProfileView | undefined;
  readonly providers: readonly ProviderView[];
  readonly inspectorOpen: boolean;
  readonly onToggleInspector: () => void;
  readonly onOpenBranchMap?: () => void;
}

function stateLabel(value: string | null | undefined): string {
  if (!value) return "Not reported";
  return value.replaceAll("-", " ");
}

function StateChip({ tone = "neutral", children }: { readonly tone?: "neutral" | "good" | "warn" | "live"; readonly children: ReactNode }) {
  return <span className={`chat-workbench-strip__chip chat-workbench-strip__chip--${tone}`}>{children}</span>;
}

function MetricCard({ label, value, detail, icon: Icon, onClick }: { readonly label: string; readonly value: string; readonly detail: string; readonly icon: typeof Activity; readonly onClick?: () => void }) {
  const content = <><span className="chat-workbench-strip__metric-icon"><Icon size={14} aria-hidden="true" /></span><span><small>{label}</small><strong>{value}</strong><em>{detail}</em></span></>;
  const description = `${label}: ${value}. ${detail}.`;
  return onClick ? <button type="button" className="chat-workbench-strip__metric" aria-label={`${description} Open ${label.toLowerCase()} view.`} title={`${description} Open ${label.toLowerCase()} view.`} onClick={onClick}>{content}</button> : <div className="chat-workbench-strip__metric" title={description}>{content}</div>;
}

export function ChatWorkbenchStrip({ conversation, model, providers, inspectorOpen, onToggleInspector, onOpenBranchMap }: ChatWorkbenchStripProps) {
  const [tab, setTab] = useState<ChatWorkbenchTab>("overview");
  const setInspectorTab = useWorkspaceStore((state) => state.setInspectorTab);
  const projects = useWorkspaceStore((state) => state.projects);
  const memories = useWorkspaceStore((state) => state.memories);
  const skills = useWorkspaceStore((state) => state.skills);
  const activeRun = useWorkspaceStore((state) => state.activeRun);
  const runTelemetryByRunId = useWorkspaceStore((state) => state.runTelemetryByRunId);
  const runTimelineEvents = useWorkspaceStore((state) => state.runTimelineEvents);
  const runControlOperationsById = useWorkspaceStore((state) => state.runControlOperationsById);

  const project = useMemo(
    () => conversation.projectId ? projects.find((candidate) => candidate.id === conversation.projectId) ?? null : null,
    [conversation.projectId, projects],
  );
  const projectReferenceMissing = Boolean(conversation.projectId && !project);
  const contextScopeName = project?.name
    ?? (projectReferenceMissing ? conversation.projectName ?? "Unavailable project" : "Standalone Chat");
  const provider = model?.connectionId ? providers.find((candidate) => candidate.id === model.connectionId) ?? null : null;
  const branchCount = conversation.nativeBranches?.length
    ?? Math.max(1, ...conversation.messages.map((message) => message.branchCount));
  const enabledSkillCount = skills.filter((skill) => skill.enabled).length;
  const runForConversation = activeRun?.conversationId === conversation.id ? activeRun : null;
  const hasNativeRunReceipt = Boolean(
    runForConversation && (
      runTelemetryByRunId[runForConversation.id] ||
      runTimelineEvents.some((event) => event.runId === runForConversation.id) ||
      Object.values(runControlOperationsById).some(
        (projection) =>
          projection.operation.sourceRunId === runForConversation.id ||
          projection.resultRunId === runForConversation.id,
      )
    ),
  );
  const rendererRunLabel = isDesktopRuntime() ? "Renderer observed run" : "Renderer preview run";
  const routeSource = provider?.source === "native" ? "Native profile" : "Renderer catalog";
  const contextAvailability = project
    ? buildProjectContextAvailabilityForProject(project)
    : null;
  const contextState = contextAvailability?.label
    ?? (projectReferenceMissing ? "Project not in snapshot" : "Standalone chat");
  const contextReason = contextAvailability?.reason
    ?? (projectReferenceMissing
      ? "This Chat references a Project missing from the current renderer snapshot. Browse Projects before treating it as an active scope."
      : "No Project is attached; this Chat remains conversation-local in the renderer preview.");
  const contextTone = projectReferenceMissing ? "warn" : "neutral";
  const conversationState = conversation.runState === "streaming" ? "Streaming" : conversation.runState === "failed" ? "Needs attention" : conversation.hasDraft ? "Draft ready" : "Ready";
  const runActionState: RunActionPreviewState = conversation.runState === "streaming"
    ? "streaming"
    : conversation.runState === "failed"
      ? "failed"
      : conversation.runState === "queued"
        ? "queued"
        : runForConversation
          ? "streaming"
          : "idle";
  const panelId = `chat-workbench-panel-${tab}`;

  const showInspectorTab = (target: "context" | "run" | "parameters") => {
    // setInspectorTab also opens the inspector. Do not toggle here: doing so
    // from a closed panel would immediately close the panel again because the
    // selector value above is stale within this event.
    setInspectorTab(target);
  };

  const selectAdjacentTab = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    const next = tabs[nextIndex]!;
    setTab(next.id);
    document.getElementById(`chat-workbench-tab-${next.id}`)?.focus();
  };

  return (
    <section className="chat-workbench-strip" aria-label="Chat workbench">
      <header className="chat-workbench-strip__header">
        <div className="chat-workbench-strip__heading">
          <span className="chat-workbench-strip__mark"><Sparkles size={13} aria-hidden="true" /></span>
          <span><strong>Chat Workbench</strong><small>Route, context, and run controls at a glance</small></span>
        </div>
        <div className="chat-workbench-strip__actions">
          <StateChip tone="neutral">Renderer preview</StateChip>
          <button type="button" className={inspectorOpen ? "chat-workbench-strip__inspector-button is-active" : "chat-workbench-strip__inspector-button"} onClick={onToggleInspector} aria-expanded={inspectorOpen} aria-controls="context-inspector" aria-label={inspectorOpen ? "Inspector open" : "Open inspector"} title={inspectorOpen ? "Close the Chat context inspector" : "Open the Chat context inspector"}><PanelRight size={13} aria-hidden="true" /> {inspectorOpen ? "Inspector open" : "Open inspector"}</button>
        </div>
      </header>

      <div className="chat-workbench-strip__quick-actions" role="toolbar" aria-label="Chat quick actions">
        <span className="chat-workbench-strip__quick-label">Quick focus</span>
        <button type="button" className="chat-workbench-strip__quick-action" onClick={() => setTab("route")} title="Open route controls"><Cpu size={12} aria-hidden="true" /> Route</button>
        <button type="button" className="chat-workbench-strip__quick-action" onClick={() => setTab("context")} title="Open context controls"><Layers3 size={12} aria-hidden="true" /> Context</button>
        <button type="button" className="chat-workbench-strip__quick-action" onClick={() => setTab("run")} title="Open run status and controls"><CircleDot size={12} aria-hidden="true" /> Run</button>
        <button type="button" className="chat-workbench-strip__quick-action" onClick={() => showInspectorTab("parameters")} title="Open advanced model parameters"><Cpu size={12} aria-hidden="true" /> Tune parameters</button>
        <button type="button" className="chat-workbench-strip__quick-action" onClick={onOpenBranchMap} disabled={!onOpenBranchMap} title={conversation.nativeBranches?.length && isDesktopRuntime() ? "Inspect native Chat branches and switch paths" : "Open the renderer branch map preview"}><GitBranch size={12} aria-hidden="true" /> Branch map</button>
      </div>

      <nav className="chat-workbench-strip__tabs" role="tablist" aria-label="Chat workbench views">
        {tabs.map(({ id, label, icon: Icon }, index) => (
          <button key={id} id={`chat-workbench-tab-${id}`} type="button" role="tab" aria-label={label} aria-selected={tab === id} aria-controls={`chat-workbench-panel-${id}`} tabIndex={tab === id ? 0 : -1} className={tab === id ? "is-active" : ""} title={`Show ${label.toLowerCase()} workbench view`} onClick={() => setTab(id)} onKeyDown={(event) => selectAdjacentTab(event, index)}><Icon size={13} aria-hidden="true" />{label}</button>
        ))}
      </nav>

      <div id={panelId} className="chat-workbench-strip__panel" role="tabpanel" aria-labelledby={`chat-workbench-tab-${tab}`} tabIndex={0}>
        {tab === "overview" ? <div className="chat-workbench-strip__metrics">
          <MetricCard label="Route" value={model?.displayName ?? "Auto"} detail={provider?.name ?? "Automatic selection"} icon={Cpu} onClick={() => setTab("route")} />
          <MetricCard label="Context" value={contextState} detail={project ? `${project.folders.length} workspace folder${project.folders.length === 1 ? "" : "s"}` : projectReferenceMissing ? "Project reference unavailable" : "No project scope"} icon={Layers3} onClick={() => setTab("context")} />
          <MetricCard label="Run" value={conversationState} detail={hasNativeRunReceipt ? stateLabel(runForConversation?.stage) : runForConversation ? rendererRunLabel : "No native run receipt"} icon={Activity} onClick={() => setTab("run")} />
          <MetricCard label="Branches" value={`${branchCount}`} detail={conversation.nativeBranches?.length ? "Native Chat snapshot" : `${conversation.messages.length} message${conversation.messages.length === 1 ? "" : "s"} in view`} icon={GitBranch} />
        </div> : null}

        {tab === "route" ? <div className="chat-workbench-strip__detail-grid">
          <div className="chat-workbench-strip__hero-card"><span className="chat-workbench-strip__hero-icon"><Cpu size={17} aria-hidden="true" /></span><span><small>Selected model profile</small><strong>{model?.displayName ?? "Auto route"}</strong><em>{model?.providerName ?? "Provider selected at run time"}</em></span><StateChip tone={hasNativeProviderConnection(provider ?? { source: "preview", state: "not-configured" }) ? "good" : provider?.state === "degraded" || provider?.state === "error" ? "warn" : "neutral"}>{provider ? providerStateLabel(provider) : "Auto"}</StateChip></div>
          <div className="chat-workbench-strip__facts"><div><span>Source</span><strong>{routeSource}</strong></div><div><span>Context window</span><strong>{model?.contextLabel ?? "Not reported"}</strong></div><div><span>Speed profile</span><strong>{model?.speed ?? "Balanced"}</strong></div><div><span>Capabilities</span><strong>{model?.capabilities?.length ? model.capabilities.join(" · ") : "Text"}</strong></div></div>
          <div className="chat-workbench-strip__detail-actions"><button type="button" className="button button--secondary" onClick={() => showInspectorTab("parameters")} title="Open advanced parameter controls"><Cpu size={14} aria-hidden="true" /> Open parameter controls</button><span>Changing route settings remains renderer-local until native routing is connected.</span></div>
        </div> : null}

        {tab === "context" ? <div className="chat-workbench-strip__detail-grid">
          <div className="chat-workbench-strip__hero-card"><span className="chat-workbench-strip__hero-icon chat-workbench-strip__hero-icon--context"><Layers3 size={17} aria-hidden="true" /></span><span><small>Context scope</small><strong>{contextScopeName}</strong><em>{project ? `${project.description || "Project-scoped context"}` : projectReferenceMissing ? "Project reference is unavailable in this renderer snapshot" : "Conversation-local history"}</em></span><StateChip tone={contextTone}>Preview</StateChip></div>
          <div className="chat-workbench-strip__facts"><div><span>Project context</span><strong title={contextReason}>{contextState}</strong></div><div><span>Memory candidates</span><strong>{memories.length} visible projections</strong></div><div><span>Enabled skills</span><strong>{enabledSkillCount} renderer defaults</strong></div><div><span>Attachments</span><strong>{conversation.messages.reduce((total, message) => total + message.attachments.length, 0)} in transcript</strong></div></div>
            <div className="chat-workbench-strip__detail-actions"><button type="button" className="button button--secondary" onClick={() => showInspectorTab("context")} title="Open context inspector"><Layers3 size={14} aria-hidden="true" /> Open context inspector</button><span>Retrieval, compilation, and durable context snapshots are not claimed by this preview.</span></div>
        </div> : null}

        {tab === "run" ? <div className="chat-workbench-strip__detail-grid">
          <div className="chat-workbench-strip__hero-card"><span className="chat-workbench-strip__hero-icon chat-workbench-strip__hero-icon--run"><Activity size={17} aria-hidden="true" /></span><span><small>Conversation state</small><strong>{conversationState}</strong><em>{hasNativeRunReceipt ? `Run ${runForConversation?.id.slice(0, 12)}…` : runForConversation ? rendererRunLabel : "No active native run"}</em></span><StateChip tone={conversation.runState === "streaming" ? "live" : conversation.runState === "failed" ? "warn" : "neutral"}>{runForConversation ? stateLabel(runForConversation.stage) : "Idle"}</StateChip></div>
          <div className="chat-workbench-strip__facts"><div><span>Messages</span><strong>{conversation.messages.length}</strong></div><div><span>Draft</span><strong>{conversation.hasDraft ? "Unsaved text" : "Empty"}</strong></div><div><span>Streaming</span><strong>{conversation.runState === "streaming" ? "Active" : "Off"}</strong></div><div><span>Receipts</span><strong>{hasNativeRunReceipt ? "Native projection" : runForConversation ? "No native receipt" : "Not available"}</strong></div></div>
          <RunActionPreview state={runActionState} />
            <div className="chat-workbench-strip__detail-actions"><button type="button" className="button button--secondary" onClick={() => showInspectorTab("run")} title="Open run inspector"><Activity size={14} aria-hidden="true" /> Open run inspector</button><span>Run controls and receipts remain read-only unless the native desktop bridge reports them.</span></div>
        </div> : null}
      </div>

      <footer className="chat-workbench-strip__footer"><ShieldCheck size={13} aria-hidden="true" /><span>UI projection only · no provider request, context write, branch mutation, or durable setting change is sent from this strip.</span><span className="chat-workbench-strip__footer-check"><Check size={12} aria-hidden="true" /> Honest boundary</span></footer>
    </section>
  );
}
