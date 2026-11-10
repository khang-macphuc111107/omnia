import { Braces, Cpu, GitBranch, Layers3, Route, Settings2, Sparkles, Waypoints } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";

import { BranchRevisionWorkbench } from "./branch-revision-workbench";
import { CapabilityMatrixWorkbench } from "./capability-matrix-workbench";
import { RoutingWorkbench } from "./routing-workbench";
import { ProfilePresetsWorkbench } from "./profile-presets-workbench";
import { ProjectContextWorkbench } from "./project-context-workbench";
import { StructuredIoWorkbench } from "./structured-io-workbench";
import { StateBaseCursorWorkbench } from "./state-base-cursor-workbench";
import { useWorkspaceStore } from "./store";
import { isDesktopRuntime } from "@/lib/desktop";

type WorkbenchId = "route" | "branches" | "context" | "presets" | "structured" | "capabilities" | "state-base";

const tabs: Array<{ id: WorkbenchId; label: string; icon: typeof Route }> = [
  { id: "route", label: "Route", icon: Route },
  { id: "branches", label: "Branches", icon: GitBranch },
  { id: "context", label: "Context", icon: Layers3 },
  { id: "presets", label: "Presets", icon: Settings2 },
  { id: "structured", label: "Structured I/O", icon: Braces },
  { id: "state-base", label: "State base", icon: Waypoints },
  { id: "capabilities", label: "Capabilities", icon: Cpu },
];

function PreviewNotice({ children }: { readonly children: React.ReactNode }) {
  return <p className="workbench-deck__notice"><Sparkles size={13} />{children}</p>;
}

function ContextPanel() {
  const project = useWorkspaceStore((state) => state.projects.find((item) => item.id === state.activeProjectId));
  const memories = useWorkspaceStore((state) => state.memories);
  const skills = useWorkspaceStore((state) => state.skills);
  if (!project) {
    return <div className="workbench-deck__panel"><div className="workbench-deck__metric"><strong>0</strong><span>active project</span></div><PreviewNotice>Select a Project to inspect its context sources.</PreviewNotice></div>;
  }
  return <ProjectContextWorkbench project={project} memories={memories} skills={skills} />;
}

export function WorkbenchDeck() {
  const [active, setActive] = useState<WorkbenchId>("route");
  const tabRefs = useRef<Record<WorkbenchId, HTMLButtonElement | null>>({
    route: null,
    branches: null,
    context: null,
    presets: null,
    structured: null,
    capabilities: null,
    "state-base": null,
  });
  const providers = useWorkspaceStore((state) => state.providers);
  const activeConversationId = useWorkspaceStore((state) => state.activeConversationId);
  const activeBranchId = useWorkspaceStore((state) => state.conversations.find((conversation) => conversation.id === activeConversationId)?.activeBranchId ?? null);
  const runControlOperations = useWorkspaceStore((state) => state.runControlOperationsById);
  const modelProfileId = useWorkspaceStore((state) => state.modelProfileId);
  const setModelProfile = useWorkspaceStore((state) => state.setModelProfile);
  const latestStateBaseOperation = useMemo(
    () => Object.values(runControlOperations)
      .filter((projection) => projection.operation.conversationId === activeConversationId)
      .filter((projection) => !activeBranchId || projection.operation.branchId === activeBranchId)
      .sort((left, right) => right.operation.createdAt.localeCompare(left.operation.createdAt))[0] ?? null,
    [activeBranchId, activeConversationId, runControlOperations],
  );
  const activePanel = useMemo(() => tabs.find((tab) => tab.id === active)!, [active]);
  const focusTab = (id: WorkbenchId) => {
    setActive(id);
    tabRefs.current[id]?.focus();
  };
  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, currentId: WorkbenchId) => {
    const index = tabs.findIndex((tab) => tab.id === currentId);
    let nextIndex: number | undefined;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = (index + 1) % tabs.length;
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = (index - 1 + tabs.length) % tabs.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = tabs.length - 1;
    if (nextIndex === undefined) return;
    const nextTab = tabs[nextIndex];
    if (!nextTab) return;
    event.preventDefault();
    focusTab(nextTab.id);
  };
  return <section className="workbench-deck" aria-label="Advanced workbenches">
    <header className="workbench-deck__header"><div><span className="eyebrow">Phase 3 surface</span><h2>Advanced workbenches</h2><p>Explore routing, project context, revisions, presets, and capability coverage in one compact deck.</p></div><span className="workbench-deck__badge">Preview</span></header>
    <div className="workbench-deck__tabs" role="tablist" aria-label="Advanced workbench views">{tabs.map(({ id, label, icon: Icon }) => <button key={id} ref={(node) => { tabRefs.current[id] = node; }} id={`workbench-tab-${id}`} type="button" role="tab" aria-selected={active === id} aria-controls={`workbench-panel-${id}`} tabIndex={active === id ? 0 : -1} className={active === id ? "workbench-deck__tab workbench-deck__tab--active" : "workbench-deck__tab"} onClick={() => focusTab(id)} onKeyDown={(event) => handleTabKeyDown(event, id)}><Icon size={14} />{label}</button>)}</div>
    <div id={`workbench-panel-${activePanel.id}`} role="tabpanel" aria-labelledby={`workbench-tab-${activePanel.id}`} tabIndex={0} className="workbench-deck__content">
      {active === "route" ? <RoutingWorkbench providers={providers} modelProfileId={modelProfileId} onModelProfileChange={setModelProfile} /> : null}
      {active === "branches" ? <BranchRevisionWorkbench /> : null}
      {active === "context" ? <ContextPanel /> : null}
      {active === "presets" ? <ProfilePresetsWorkbench /> : null}
      {active === "structured" ? <StructuredIoWorkbench /> : null}
      {active === "capabilities" ? <CapabilityMatrixWorkbench providers={providers} modelProfileId={modelProfileId} onModelProfileChange={setModelProfile} /> : null}
      {active === "state-base" ? <StateBaseCursorWorkbench operation={latestStateBaseOperation} runtime={isDesktopRuntime() ? "desktop" : "browser-preview"} /> : null}
    </div>
  </section>;
}
