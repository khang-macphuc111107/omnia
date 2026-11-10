import {
  Calculator, Check, ChevronDown, ChevronRight, Cpu, FileCode2, FolderPlus,
  FolderTree, GitBranch, HardDrive, History, Monitor, Plus,
  ShieldCheck, Terminal, Trash2, Users, X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import {
  buildDirectSovereignCustomProviderBlueprint, DETECTED_ACER_NITRO_HARDWARE,
  recommendLocalModelsForHardware,
} from "@/domain/local-model-hardware-advisor";
import {
  autoTriggerBuiltinToolsForTurn, runNumericClaimVerifier,
  runScientificCalculator, runUnitCurrencyConverter,
} from "@/domain/omnia-builtin-tools";
import { listOfficialHarnessDescriptors } from "@/domain/omnia-official-harness-adapters";
import {
  createBtwSideChatTurn, createLiveSessionNode, evaluateSubagentSpawnPolicy,
  spawnRecursiveSubagentSwarm, traverseSessionTreeDfs,
  type BtwSideChatEntry, type LiveSessionNode,
} from "@/domain/session-dfs-tree";
import type { IdeVirtualFile } from "@/domain/sovereign-ide-remote-desktop";
import { isDesktopRuntime } from "@/lib/desktop";

import { createDefaultLtstNodes, LTST_KNOWLEDGE_STORAGE_KEY, type LtstKnowledgeNode } from "./knowledge-tree-explorer";
import { selectableModelProfiles } from "./provider-catalog";
import { useWorkspaceStore } from "./store";
import { useSidebarAgentSubmission } from "./sidebar-agent-submission";
import { setWorkspaceSurface } from "./workspace-mode-switcher";
import { AiPanelComposer } from "./ai-panel-composer";
import { CollapsibleAiSteps } from "./collapsible-ai-steps";
import { MessageMarkdown } from "./markdown";
import { PromptTelemetryInspector, TurnStudioActionsBar, TurnTelemetryHud } from "./prompt-telemetry-inspector";
import { resolveRoutedProviderModel } from "./provider-parameters";
import type { RunTimelineEventView } from "./evidence-types";
import type { ChatMessage, ParameterSettings } from "./types";

export interface IdeProjectFolder {
  readonly id?: string;
  readonly name: string;
  readonly path: string;
}

export const DEFAULT_IDE_PROJECT_FOLDERS: readonly IdeProjectFolder[] = [
  { name: "omnia-app", path: "D:\\Omnia\\repos\\omnia" },
  { name: "omnia-root", path: "D:\\Omnia" },
  { name: "codex-runtime", path: "D:\\CodexBetaPatched" },
];

type UtilityPanel = "projects" | "sessions" | "knowledge" | "tools";

const CONTEXT_OPTIONS = ["@workspace:multi-root", "@active-file", "@terminal", "@git-diff"] as const;

interface IdeAgentSidebarProps {
  readonly activeFile: IdeVirtualFile;
  readonly selectedCode: string;
  readonly projects: readonly IdeProjectFolder[];
  readonly projectPanelRequest: number;
  readonly utilityPanel?: UtilityPanel;
  readonly terminalContext: string;
  readonly gitDiff: string;
  readonly onClose: () => void;
  readonly onApplyCode: (code: string) => void;
  readonly onAddProject: (path: string) => Promise<void>;
  readonly onPickProject?: () => Promise<void>;
  readonly allowEmptyWorkspace?: boolean;
  readonly onRemoveProject: (path: string) => Promise<void>;
  readonly onOpenRemote: () => void;
  readonly onOpenDisk: () => void;
  readonly onOpenSplit: () => void;
}

function readKnowledgeNodes(): readonly LtstKnowledgeNode[] {
  try {
    const saved = window.localStorage?.getItem?.(LTST_KNOWLEDGE_STORAGE_KEY);
    const parsed = saved ? JSON.parse(saved) as { nodes?: LtstKnowledgeNode[] } : null;
    if (Array.isArray(parsed?.nodes)) return parsed.nodes;
  } catch { /* A corrupt preference must not hide the built-in tree. */ }
  return createDefaultLtstNodes();
}

/** Only model-authored fenced code can be applied. No synthetic patch is generated. */
export function extractLatestAgentCode(messages: readonly { role: string; content: string }[]): string | null {
  for (const message of [...messages].reverse()) {
    if (message.role !== "assistant") continue;
    const match = /```[^\n]*\n([\s\S]*?)```/.exec(message.content);
    if (match?.[1]?.trim()) return match[1].trimEnd();
  }
  return null;
}

interface IdeAssistantStep {
  id: string;
  label: string;
  content?: ReactNode;
  status: "running" | "completed" | "failed";
}

/** Only user-useful actions backed by this message's run are displayed. */
export function ideAssistantSteps(message: ChatMessage, events: readonly RunTimelineEventView[]): IdeAssistantStep[] {
  if (!message.runId) return message.status === "streaming" && !message.content
    ? [{ id: `${message.id}-thinking`, label: "Thinking...", status: "running" }]
    : [];
  const scoped = events.filter((event) => event.runId === message.runId).sort((left, right) => left.sequence - right.sequence);
  const reasoning = scoped.filter((event) => /reasoning|thinking/i.test(event.type));
  const steps: IdeAssistantStep[] = [];
  if (reasoning.length) {
    const first = reasoning[0]!;
    const last = reasoning.at(-1)!;
    const milliseconds = Date.parse(last.endedAt ?? last.startedAt) - Date.parse(first.startedAt);
    const running = message.status === "streaming" && !message.content && !scoped.some((event) => event.sequence > last.sequence && /tool|command|file/i.test(event.type));
    steps.push({ id: `${message.id}-thinking`, label: running ? "Thinking..." : milliseconds > 0 ? `Thought for ${Math.max(1, Math.round(milliseconds / 1000))}s` : "Thought", status: running ? "running" : "completed" });
  }
  // Hide known diagnostic copy, not useful operations on cache.ts, dfs.ts or
  // harness.ts. Filenames are source context rather than telemetry badges.
  const quietOnly = /Cache Hit|Cache\s+\d+%|Local Cache (?:Active|Proxy)|\d[\d,.]*k?\s+(?:cached|tok(?:en)?s?(?:\/s)?)\b|Harness:\s*Custom|Anthropic\/OpenAI Cache Harness|Official Harnesses|(?:Ran|Running|Executed)\s+(?:builtin_numeric_claim_verifier|parallel subagents)|DFS:\s*\d+\s*Nodes|PRE.ORDER DFS SESSION DAG|127\.0\.0\.1|ANTI.HALLUCINATION AUDIT|Verified:\s*Math/i;
  for (const event of scoped) {
    if (!/^(?:tool|command|file)[._-]/i.test(event.type) || quietOnly.test(event.summary)) continue;
    const pending = event.status === "running" || event.status === "pending";
    steps.push({ id: event.id, label: event.summary || "Command", status: message.status === "streaming" && pending ? "running" : event.status === "failed" ? "failed" : "completed", ...(event.detail && !quietOnly.test(event.detail) ? { content: <pre>{event.detail}</pre> } : {}) });
  }
  if (!steps.length && message.status === "streaming" && !message.content) steps.push({ id: `${message.id}-thinking`, label: "Thinking...", status: "running" });
  if (!steps.length && message.runId === "run-harness-demo") return [{ id: "demo-thought", label: "Thought for 4s", content: "Separated the run harness into five durable layers with immutable snapshots.", status: "completed" }, { id: "demo-read", label: "Read PRODUCT_SPEC.md (lines 1-140)", status: "completed" }, { id: "demo-edit", label: "Edited src/domain/run-envelope.ts (+18 -4)", status: "completed" }];
  return steps;
}

export function IdeAgentSidebar({
  activeFile, selectedCode, projects, projectPanelRequest, utilityPanel = "projects", terminalContext, gitDiff, onClose,
  onApplyCode, onAddProject, onPickProject, allowEmptyWorkspace = false, onRemoveProject, onOpenRemote, onOpenDisk, onOpenSplit,
}: IdeAgentSidebarProps) {
  const conversations = useWorkspaceStore((state) => state.conversations);
  const activeConversationId = useWorkspaceStore((state) => state.activeConversationId);
  const providers = useWorkspaceStore((state) => state.providers);
  const modelProfileId = useWorkspaceStore((state) => state.modelProfileId);
  const effort = useWorkspaceStore((state) => state.parameters.reasoningEffort);
  const activeRun = useWorkspaceStore((state) => state.activeRun);
  const [utility, setUtility] = useState<UtilityPanel | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const conversationSelector = useRef<HTMLSelectElement | null>(null);
  const timelineEvents = useWorkspaceStore((state) => state.runTimelineEvents);
  const [prompt, setPrompt] = useState("");
  const [context, setContext] = useState<readonly string[]>(CONTEXT_OPTIONS);
  const [notice, setNotice] = useState("");
  const { submitPrompt, submitting: sending } = useSidebarAgentSubmission();
  const [newProjectPath, setNewProjectPath] = useState("");
  const [projectBusy, setProjectBusy] = useState(false);
  const [projectError, setProjectError] = useState("");
  const [swarmTask, setSwarmTask] = useState("Review selected code, implement and verify independently");
  const [swarmCount, setSwarmCount] = useState(3);
  const [swarmChildren, setSwarmChildren] = useState(1);
  const [plannedNodes, setPlannedNodes] = useState<Readonly<Record<string, LiveSessionNode>>>({});
  const [btwQuestion, setBtwQuestion] = useState("");
  const [btwTurns, setBtwTurns] = useState<readonly BtwSideChatEntry[]>([]);
  const [knowledgeQuery, setKnowledgeQuery] = useState("");
  const [knowledgeNodes] = useState(readKnowledgeNodes);
  const harnesses = useMemo(() => listOfficialHarnessDescriptors(), []);
  const [harnessId, setHarnessId] = useState<string>(harnesses[0]?.id ?? "openai-gpt-codex");
  const localRecommendations = useMemo(() => recommendLocalModelsForHardware(DETECTED_ACER_NITRO_HARDWARE), []);
  const [localModelId, setLocalModelId] = useState(localRecommendations[0]?.model.id ?? "");
  const [blueprintOpen, setBlueprintOpen] = useState(false);
  const [expression, setExpression] = useState("sqrt(144) + 2^3");
  const [unitValue, setUnitValue] = useState("1");
  const [fromUnit, setFromUnit] = useState("km");
  const [toUnit, setToUnit] = useState("m");
  const [toolOutput, setToolOutput] = useState("");
  const [claims, setClaims] = useState("");
  const conversation = conversations.find((item) => item.id === activeConversationId) ?? null;
  const nativeBranches = isDesktopRuntime() ? conversation?.nativeBranches ?? [] : [];
  const activeNativeBranchIndex = nativeBranches.findIndex((branch) => branch.id === conversation?.activeBranchId);
  const models = useMemo(() => selectableModelProfiles(providers), [providers]);
  const activeModel = models.find((item) => item.id === modelProfileId) ?? models[0];
  const route = resolveRoutedProviderModel(providers, activeModel);
  const rootSessionId = activeConversationId || "ide-session";
  const sessionUri = `omnia://sessions/${rootSessionId}`;
  const sessionNodes = useMemo(() => {
    const liveNodes: Record<string, LiveSessionNode> = {};
    for (const thread of conversations) {
      liveNodes[thread.id] = createLiveSessionNode({
        sessionId: thread.id, title: thread.title, role: "main",
        modelId: activeModel?.providerModelId ?? modelProfileId,
        status: thread.runState === "streaming" ? "running" : "completed",
        liveTranscriptSummary: thread.messages.at(-1)?.content.slice(0, 280) ?? "No messages yet",
        updatedAt: new Date().toISOString(),
      });
    }
    if (!liveNodes[rootSessionId]) liveNodes[rootSessionId] = createLiveSessionNode({ sessionId: rootSessionId, title: "IDE session" });
    // Planned children are projections, not evidence of launched native workers.
    for (const [id, node] of Object.entries(plannedNodes)) {
      liveNodes[id] = liveNodes[id] ? { ...liveNodes[id], childSessionIds: node.childSessionIds } : node;
    }
    return liveNodes;
  }, [conversations, plannedNodes, rootSessionId, activeModel?.providerModelId, modelProfileId]);
  const dfs = useMemo(() => traverseSessionTreeDfs(rootSessionId, sessionNodes), [rootSessionId, sessionNodes]);
  const spawnPolicy = useMemo(() => evaluateSubagentSpawnPolicy({
    taskDescription: swarmTask, independentWorkstreams: swarmCount,
    estimatedFilesToTouch: Math.max(projects.length, swarmCount), couplingRatio: 0.25,
    requiresMultiModelConsensus: false, requestedMinAgents: swarmCount,
  }), [swarmTask, swarmCount, projects.length]);
  const filteredKnowledge = knowledgeNodes.filter((node) => `${node.folderPath} ${node.title} ${node.content}`.toLowerCase().includes(knowledgeQuery.toLowerCase()));
  const selectedHarness = harnesses.find((item) => item.id === harnessId);
  const selectedRecommendation = localRecommendations.find((item) => item.model.id === localModelId) ?? localRecommendations[0];
  const blueprint = selectedRecommendation ? buildDirectSovereignCustomProviderBlueprint(selectedRecommendation.model, DETECTED_ACER_NITRO_HARDWARE) : null;

  useEffect(() => { setPrompt(""); setNotice(""); }, [activeConversationId]);
  useEffect(() => {
    if (!historyOpen && !contextOpen) return;
    window.dispatchEvent(new CustomEvent("omnia:close-floating-menus", { detail: { source: "ide-agent-sidebar" } }));
  }, [historyOpen, contextOpen]);
  useEffect(() => {
    const handleCloseFloating = (event: Event) => {
      const detail = (event as CustomEvent<{ source?: string }>).detail;
      if (detail?.source !== "ide-agent-sidebar") {
        setHistoryOpen(false);
        setContextOpen(false);
      }
    };
    window.addEventListener("omnia:close-floating-menus", handleCloseFloating);
    return () => window.removeEventListener("omnia:close-floating-menus", handleCloseFloating);
  }, []);
  useEffect(() => { if (projectPanelRequest > 0) setUtility(utilityPanel); }, [projectPanelRequest, utilityPanel]);

  function stageDraft(text: string) {
    useWorkspaceStore.getState().updateDraft(text);
    setNotice("Added to the chat draft.");
  }

  function buildContextPrompt(text: string): string {
    const parts = [`[Omnia IDE context | ${context.join(" ")}]`];
    if (context.includes("@workspace:multi-root")) parts.push(`Workspace folders:\n${projects.map((project) => `${project.name}: ${project.path}`).join("\n")}`);
    if (context.includes("@active-file")) parts.push(`Active local buffer: ${activeFile.path}\n\`\`\`${activeFile.language}\n${activeFile.content}\n\`\`\``);
    if (context.includes("@terminal")) parts.push(`Local terminal log (not a process execution receipt):\n${terminalContext}`);
    if (context.includes("@git-diff")) parts.push(`Local buffer diff against seed snapshot (not native git status):\n${gitDiff || "No local changes"}`);
    const audit = autoTriggerBuiltinToolsForTurn({ userPrompt: text, referenceTime: new Date().toISOString() });
    if (audit.receipts.length) parts.push(`Deterministic tool receipts:\n${JSON.stringify(audit.receipts)}`);
    return `${parts.join("\n\n")}\n\n${text}`;
  }

  async function sendPrompt() {
    const text = prompt.trim();
    if (!text || sending || activeRun) return;
    if (text.startsWith("/btw")) { setBtwQuestion(text.replace(/^\/btw\s*/, "")); setUtility("sessions"); return; }
    if (text.startsWith("/spawn")) { setSwarmTask(text.replace(/^\/spawn\s*/, "") || swarmTask); setUtility("sessions"); return; }
    if (text.startsWith("/remote")) { onOpenRemote(); return; }
    if (text.startsWith("/calc")) { setExpression(text.replace(/^\/calc\s*/, "") || expression); setUtility("tools"); return; }
    if (text.startsWith("/verify")) { setClaims(text.replace(/^\/verify\s*/, "") || activeFile.content); setUtility("tools"); return; }
    const fullPrompt = buildContextPrompt(text);
    const state = useWorkspaceStore.getState();
    state.updateDraft(fullPrompt);
    if (!isDesktopRuntime()) {
      setNotice("Draft saved. Sending requires the Omnia desktop runtime and a connected provider.");
      setPrompt("");
      return;
    }
    const result = await submitPrompt(fullPrompt);
    if (result.ok) { setPrompt(""); setNotice(""); }
    else setNotice(result.error);
  }


  async function changeProject(operation: () => Promise<void>) {
    setProjectBusy(true); setProjectError("");
    try { await operation(); setNewProjectPath(""); }
    catch (error) { setProjectError(error instanceof Error ? error.message : "Workspace update failed"); }
    finally { setProjectBusy(false); }
  }

  function planSwarm() {
    const plan = spawnRecursiveSubagentSwarm({
      nodesById: sessionNodes, parentSessionIds: [rootSessionId], count: swarmCount,
      childrenPerSubagent: swarmChildren, baseTitle: swarmTask || "Code review", role: "coder",
      modelId: activeModel?.providerModelId ?? modelProfileId, now: new Date().toISOString(),
    });
    setPlannedNodes(plan.nodesById);
    setNotice(`Planned ${plan.totalSpawnedCount} worker sessions. This graph does not launch native workers; dispatch the plan to an agent to execute it.`);
  }

  function stageBtw() {
    if (!btwQuestion.trim()) return;
    const entry = createBtwSideChatTurn({
      selectedQuote: selectedCode || activeFile.content, sourceSessionUri: sessionUri,
      question: btwQuestion, activeSessionContext: activeFile.path, createdAt: new Date().toISOString(),
    });
    setBtwTurns((items) => [...items, entry]);
    setBtwQuestion("");
    setNotice("Side question saved locally. The main chat draft is unchanged.");
  }

  function runTool(operation: () => unknown) {
    try { setToolOutput(JSON.stringify(operation(), null, 2)); }
    catch (error) { setToolOutput(error instanceof Error ? error.message : "Tool failed"); }
  }

  async function forkNativeBranch(messageId: string): Promise<void> {
    const state = useWorkspaceStore.getState();
    if (!isDesktopRuntime() || state.activeConversationId !== conversation?.id) {
      throw new Error("Select the original desktop chat before creating a branch.");
    }
    await state.forkConversationBranch(messageId);
  }

  async function switchNativeBranch(direction: "prev" | "next"): Promise<void> {
    const state = useWorkspaceStore.getState();
    const current = state.conversations.find((item) => item.id === conversation?.id);
    const branches = current?.nativeBranches ?? [];
    const index = branches.findIndex((branch) => branch.id === current?.activeBranchId);
    if (!isDesktopRuntime() || state.activeConversationId !== conversation?.id || index < 0 || branches.length < 2) {
      throw new Error("Refresh the original desktop chat before switching branches.");
    }
    const next = branches[(index + (direction === "prev" ? -1 : 1) + branches.length) % branches.length]!;
    await state.activateConversationBranch(next.id);
  }

  return (
    <aside className="ide-agent-sidebar" data-testid="ide-agy-ai-sidebar" aria-label="AI coding sidebar" onKeyDown={(event) => { if (event.key === "Escape") { setUtility(null); setHistoryOpen(false); setContextOpen(false); } }}>
      <header className="ide-agent-sidebar__title">
        <div className="ide-agent-chat-selector">
          <select ref={conversationSelector} id="ide-agent-chat" aria-label="Active chat" title={conversation?.title || "Select chat"} value={conversation?.id ?? ""} onChange={(event) => { useWorkspaceStore.getState().selectConversation(event.target.value); setWorkspaceSurface("code"); setHistoryOpen(false); }}>
            {!conversation && <option value="">Select chat</option>}{conversations.filter((item) => !item.archived).map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
          </select><ChevronDown size={12} strokeWidth={1.75} aria-hidden="true" />
        </div>
        <div className="ide-agent-header-actions">
          <PromptTelemetryInspector surface="ide-sidebar" conversationId={activeConversationId} provider={route?.provider?.name ?? "Anthropic"} model={activeModel?.displayName ?? "claude-opus-4-6"} effort={effort} testId="ide-prompt-telemetry" />
          <button type="button" title="New chat" aria-label="New chat" onClick={() => { void useWorkspaceStore.getState().createConversation().then(() => setWorkspaceSurface("code")).catch((error: unknown) => setNotice(error instanceof Error ? error.message : "Could not create chat")); }}><Plus size={15} strokeWidth={1.75} aria-hidden="true" /></button>
          <button type="button" title="Chat history" aria-label="Chat history" aria-expanded={historyOpen} onClick={() => { setHistoryOpen((value) => !value); setUtility(null); }}><History size={15} strokeWidth={1.75} aria-hidden="true" /></button>
          <button type="button" title="Toggle AI sidebar" aria-label="Toggle AI sidebar" onClick={onClose}><X size={15} strokeWidth={1.75} aria-hidden="true" /></button>
        </div>
      </header>
      {historyOpen && <div className="ide-agent-history" role="dialog" aria-label="Chat history">
        {conversations.filter((item) => !item.archived).map((item) => <button type="button" key={item.id} aria-pressed={item.id === activeConversationId} onClick={() => { useWorkspaceStore.getState().selectConversation(item.id); setWorkspaceSurface("code"); setHistoryOpen(false); }}>{item.title}</button>)}
        {!conversations.some((item) => !item.archived) && <p>No saved chats.</p>}
      </div>}
      <div className="ide-agent-messages" data-testid="ide-agy-conversation-stream" aria-label="AI coding messages" aria-live="polite">
        {!conversation?.messages.length && <p className="ide-agent-empty">Ask about your code.</p>}
        {conversation?.messages.map((message) => <article key={message.id} data-role={message.role}>
          {message.role === "assistant" ? <>
            <CollapsibleAiSteps steps={ideAssistantSteps(message, timelineEvents)} />
            <MessageMarkdown content={message.content} filename={activeFile.path} streaming={message.status === "streaming"} onApplyCode={(code) => { onApplyCode(code); setNotice(`Applied to the local buffer: ${activeFile.path}.`); }} applyLabel="Apply to editor" />
            <TurnTelemetryHud
              turnId={`ide-${message.id}`}
              conversationId={conversation.id}
              runId={message.runId}
              responseText={message.content}
              createdAt={message.createdAt}
              provider={route?.provider?.name ?? "Anthropic"}
              model={activeModel?.displayName ?? "claude-opus-4-6"}
              effort={effort}
              surface="ide-sidebar"
            />
            <TurnStudioActionsBar
              turnId={`ide-${message.id}`}
              responseText={message.content}
              {...(message.modelLabel ? { modelLabel: message.modelLabel } : {})}
              {...(isDesktopRuntime() && message.status !== "streaming" ? { onBranch: () => forkNativeBranch(message.id) } : {})}
              {...(activeNativeBranchIndex >= 0 && nativeBranches.length > 1 ? {
                branchIndex: activeNativeBranchIndex + 1,
                branchCount: nativeBranches.length,
                onSwitchBranch: switchNativeBranch,
              } : {})}
            />
          </> : <p className="ide-agent-user-message">{message.content}</p>}
        </article>)}
      </div>
      <div className="ide-agent-composer-wrap">
        {contextOpen && <div className="ide-agent-context-popover" role="dialog" aria-label="Attach code context">
          {CONTEXT_OPTIONS.map((item) => <button type="button" key={item} aria-pressed={context.includes(item)} onClick={() => setContext((items) => items.includes(item) ? items.filter((value) => value !== item) : [...items, item])}>{item === "@active-file" ? activeFile.path.split(/[\\/]/).at(-1) : item === "@workspace:multi-root" ? "Project folders" : item === "@terminal" ? "Terminal output" : "Current diff"}{context.includes(item) && <Check size={13} strokeWidth={1.75} aria-hidden="true" />}</button>)}
          <button type="button" onClick={() => setContextOpen(false)}>Done</button>
        </div>}
        <AiPanelComposer value={prompt} onChange={setPrompt} onSend={() => void sendPrompt()} pending={sending} disabled={Boolean(activeRun)}
          attachments={context.includes("@active-file") ? [{ id: activeFile.path, label: activeFile.path.split(/[\\/]/).at(-1) || activeFile.path, kind: "file", onRemove: () => setContext((items) => items.filter((item) => item !== "@active-file")) }] : []}
          onAttach={() => setContextOpen((value) => !value)} modelLabel={activeModel?.displayName ?? "Select model"} models={models.map((model) => ({ id: model.id, label: model.displayName }))} modelId={activeModel?.id ?? ""} onModelChange={(id) => useWorkspaceStore.getState().setModelProfile(id)}
          effortLabel={effort[0]!.toUpperCase() + effort.slice(1)} effortId={effort} efforts={["off", "low", "medium", "high", "max"].map((id) => ({ id, label: id[0]!.toUpperCase() + id.slice(1) }))} onEffortChange={(id) => { if (["off", "low", "medium", "high", "max"].includes(id)) useWorkspaceStore.getState().setParameter("reasoningEffort", id as ParameterSettings["reasoningEffort"]); }}
          providers={providers.map((p) => ({ id: p.id, label: p.name }))} providerId={activeModel?.connectionId ?? providers[0]?.id ?? ""} onProviderChange={(nextProviderId) => { const firstForProvider = models.find((m) => m.connectionId === nextProviderId); if (firstForProvider) useWorkspaceStore.getState().setModelProfile(firstForProvider.id); }}
          promptHistory={conversations.flatMap((c) => c.messages.filter((m) => m.role === "user").map((m) => m.content))}
          inputLabel="Message AI coding assistant" inputTestId="ide-agy-ai-input" sendTestId="ide-agy-ai-send-btn" />
      </div>
      {utility && <section className="ide-agent-utility-drawer" role="dialog" aria-label={utility === "projects" ? "Workspace folders" : utility === "sessions" ? "Session tools" : utility === "knowledge" ? "Knowledge and model setup" : "Calculator and checks"}>
        <header><span>{utility === "projects" ? "Workspace folders" : utility === "sessions" ? "Session tools" : utility === "knowledge" ? "Knowledge and model setup" : "Calculator and checks"}</span><button type="button" title="Close tools" aria-label="Close tools" onClick={() => setUtility(null)}><X size={15} strokeWidth={1.75} aria-hidden="true" /></button></header>
        <div className="ide-agent-sidebar__panel">
        {utility === "projects" && <>
          <h3>Workspace folders</h3><p className="ide-agent-muted">The multi-root workspace opens all folders in one VS Code instance.</p>
          <ul className="ide-agent-projects">{projects.map((project) => <li key={project.path}><FolderTree size={14} aria-hidden="true" /><div><strong>{project.name}</strong><code>{project.path}</code></div><button type="button" aria-label={`Remove ${project.name} project folder`} disabled={projectBusy || (!allowEmptyWorkspace && projects.length <= 1)} onClick={() => void changeProject(() => onRemoveProject(project.path))}><Trash2 size={14} aria-hidden="true" /></button></li>)}</ul>
          {onPickProject ? <button type="button" data-testid="ide-pick-project-btn" disabled={projectBusy} onClick={() => void changeProject(onPickProject)}><FolderPlus size={14} aria-hidden="true" />Choose folder…</button> : <><label htmlFor="ide-new-project-path">Add Project Folder</label><div className="ide-agent-field-row"><input id="ide-new-project-path" data-testid="ide-add-project-input" value={newProjectPath} onChange={(event) => setNewProjectPath(event.target.value)} placeholder="D:\\Projects\\my-project" /><button type="button" aria-label="Add Project Folder" data-testid="ide-add-project-btn" disabled={projectBusy || !newProjectPath.trim()} onClick={() => void changeProject(() => onAddProject(newProjectPath))}><FolderPlus size={14} aria-hidden="true" /></button></div></>}
          {projectError && <p role="alert">{projectError}</p>}
          <h3>Remote desktop & disks</h3><button className="ide-agent-row-action" type="button" onClick={onOpenRemote}><Monitor size={16} aria-hidden="true" /><span>Multi-monitor / per-window screen share</span><ChevronRight size={14} aria-hidden="true" /></button><button className="ide-agent-row-action" type="button" onClick={onOpenRemote}><Terminal size={16} aria-hidden="true" /><span>Remote mouse & keyboard</span><ChevronRight size={14} aria-hidden="true" /></button><button className="ide-agent-row-action" type="button" onClick={onOpenDisk}><HardDrive size={16} aria-hidden="true" /><span>Disk explorer · C:\ and D:\</span><ChevronRight size={14} aria-hidden="true" /></button><button className="ide-agent-row-action" type="button" onClick={onOpenSplit}><FileCode2 size={16} aria-hidden="true" /><span>Local code & terminal drawer</span><ChevronRight size={14} aria-hidden="true" /></button>
          <p className="ide-agent-boundary">Screen capture asks for your permission. Remote input requires a native isolated-input channel; disk samples and transfers are explicitly local plans until a transport receipt exists.</p>
        </>}
        {utility === "sessions" && <>
          <h3>Session plan</h3>
          <ol className="ide-agent-dfs" data-testid="ide-agent-dfs-tree">{dfs.steps.map(({ node, depth }) => <li key={node.sessionId} style={{ paddingInlineStart: `${depth * 12}px` }}><GitBranch size={14} aria-hidden="true" /><span>{node.title}</span><small>{plannedNodes[node.sessionId] && node.sessionId !== rootSessionId ? "planned" : node.status}</small></li>)}</ol>
          <h3>Adaptive swarm policy</h3><label htmlFor="ide-swarm-task">Task</label><textarea id="ide-swarm-task" value={swarmTask} onChange={(event) => setSwarmTask(event.target.value)} rows={3} /><div className="ide-agent-field-row"><label>Workers<input aria-label="Swarm worker count" type="number" min={1} max={32} value={swarmCount} onChange={(event) => setSwarmCount(Math.max(1, Math.min(32, Number(event.target.value) || 1)))} /></label><label>Children per worker<input aria-label="Children per worker" type="number" min={0} max={4} value={swarmChildren} onChange={(event) => setSwarmChildren(Math.max(0, Math.min(4, Number(event.target.value) || 0)))} /></label></div><p data-testid="ide-agent-spawn-policy">{spawnPolicy.strategyLabel}: {spawnPolicy.recommendedCount} workers, depth {spawnPolicy.recommendedDepth}</p><details><summary>Policy rationale</summary><p>{spawnPolicy.rationale}</p></details>
          <div className="ide-agent-actions"><button type="button" data-testid="ide-agent-plan-swarm-btn" onClick={planSwarm}><Users size={14} aria-hidden="true" /> Plan swarm</button><button type="button" onClick={() => stageDraft(`/spawn ${swarmTask}\n\n${dfs.compiledContextMarkdown}`)}>Send plan to Chat</button></div>
          <h3>Side question</h3><pre className="ide-agent-selection">{(selectedCode || activeFile.content).slice(0, 1200)}</pre><label htmlFor="ide-btw-question">Ask about this selection</label><textarea id="ide-btw-question" value={btwQuestion} onChange={(event) => setBtwQuestion(event.target.value)} rows={2} /><button type="button" data-testid="ide-agent-btw-btn" disabled={!btwQuestion.trim()} onClick={stageBtw}>Save side question</button>
          {btwTurns.map((turn) => <article className="ide-agent-btw" key={turn.id}><strong>{turn.question}</strong><p>Local request · not dispatched</p><button type="button" onClick={() => stageDraft(`/btw ${turn.question}\n\nSource: ${turn.sourceSessionUri}\n\n${turn.selectedQuote}`)}>Promote to Chat draft</button></article>)}
        </>}
        {utility === "knowledge" && <>
          <h3>Saved knowledge</h3><label className="sr-only" htmlFor="ide-knowledge-search">Search saved knowledge</label><input id="ide-knowledge-search" data-testid="ide-agent-knowledge-search" value={knowledgeQuery} onChange={(event) => setKnowledgeQuery(event.target.value)} placeholder="Search knowledge nodes" /><ul className="ide-agent-knowledge">{filteredKnowledge.map((node) => <li key={node.id}><code>{node.folderPath}</code><strong>{node.title}</strong><p>{node.summary}</p><button type="button" aria-label={`Inject ${node.title} into Chat`} onClick={() => { const state = useWorkspaceStore.getState(); const current = state.conversations.find((item) => item.id === state.activeConversationId)?.draft ?? ""; stageDraft(`${current}${current ? "\n\n" : ""}[LTST: ${node.title}]\n${node.content}\nProvenance: ${node.provenanceUris.join(", ")}`); }}><Plus size={14} aria-hidden="true" /> Inject into Chat</button></li>)}</ul>
          {!filteredKnowledge.length && <p>No nodes match this query.</p>}
          <h3>Model setup</h3><label htmlFor="ide-agent-harness">Harness ({harnesses.length})</label><select id="ide-agent-harness" data-testid="ide-agent-harness-select" value={harnessId} onChange={(event) => setHarnessId(event.target.value)}>{harnesses.map((harness) => <option key={harness.id} value={harness.id}>{harness.displayName}</option>)}</select><p>{selectedHarness?.architectureSummary}</p><p className="ide-agent-boundary">Adapter metadata is not an active native session. Send this selection to Chat for routing review.</p><button type="button" onClick={() => stageDraft(`Use harness adapter ${harnessId}.\n${selectedHarness?.architectureSummary ?? ""}\nVerify runtime availability before executing.`)}>Stage harness selection</button>
          <h3>Local model setup</h3><label htmlFor="ide-agent-local-model">Hardware-advised model</label><select id="ide-agent-local-model" value={localModelId} onChange={(event) => { setLocalModelId(event.target.value); setBlueprintOpen(false); }}>{localRecommendations.map(({ model }) => <option key={model.id} value={model.id}>{model.name}</option>)}</select><p>{DETECTED_ACER_NITRO_HARDWARE.machineModel} · {DETECTED_ACER_NITRO_HARDWARE.gpuVramMiB} MiB VRAM · {DETECTED_ACER_NITRO_HARDWARE.systemRamGb} GB RAM</p><p className="ide-agent-boundary">Hardware preset, not a live probe. Throughput and offload are estimates; inspect the generated blueprint before running commands.</p><div className="ide-agent-actions"><button type="button" onClick={() => setBlueprintOpen((value) => !value)}><Cpu size={14} aria-hidden="true" /> Inspect blueprint</button><button type="button" onClick={() => { if (blueprint) stageDraft(`Review this local model blueprint before applying it:\n\n\`\`\`powershell\n${blueprint.powershellInstallAndRunScript}\n\`\`\``); }}>Send blueprint to Chat</button></div>{blueprintOpen && blueprint && <pre data-testid="ide-agent-local-blueprint">{blueprint.powershellInstallAndRunScript}</pre>}
        </>}
        {utility === "tools" && <>
          <h3>Scientific calculator</h3><label htmlFor="ide-calc-expression">Expression</label><input id="ide-calc-expression" data-testid="ide-agent-calc-input" value={expression} onChange={(event) => setExpression(event.target.value)} /><button type="button" data-testid="ide-agent-calc-btn" onClick={() => runTool(() => runScientificCalculator({ expression }))}><Calculator size={14} aria-hidden="true" /> Evaluate</button>
          <h3>Units & programmer bases</h3><div className="ide-agent-field-row"><label>Value<input aria-label="Conversion value" value={unitValue} onChange={(event) => setUnitValue(event.target.value)} /></label><label>From<input aria-label="From unit" value={fromUnit} onChange={(event) => setFromUnit(event.target.value)} /></label><label>To<input aria-label="To unit" value={toUnit} onChange={(event) => setToUnit(event.target.value)} /></label></div><button type="button" onClick={() => runTool(() => runUnitCurrencyConverter({ value: Number(unitValue), fromUnit, toUnit }))}>Convert units / inspect bases</button>
          <h3>Check claims</h3><label htmlFor="ide-audit-claims">Claims or code</label><textarea id="ide-audit-claims" value={claims} onChange={(event) => setClaims(event.target.value)} rows={5} placeholder="Leave empty to inspect the active buffer and latest assistant reply" /><div className="ide-agent-actions"><button type="button" data-testid="ide-agent-verify-btn" onClick={() => runTool(() => autoTriggerBuiltinToolsForTurn({ userPrompt: claims || activeFile.content, assistantDraft: conversation?.messages.filter((message) => message.role === "assistant").at(-1)?.content ?? "", referenceTime: new Date().toISOString() }).receipts.map((receipt) => receipt.output))}><ShieldCheck size={14} aria-hidden="true" /> Run audit</button><button type="button" onClick={() => runTool(() => runNumericClaimVerifier({ text: claims || activeFile.content }))}><Check size={14} aria-hidden="true" /> Verify numbers</button></div>
          <p className="ide-agent-boundary">These tools return deterministic receipts. Unchecked claims remain unverified; this is not proof that every statement is true.</p>{toolOutput && <pre className="ide-agent-tool-output" data-testid="ide-agent-tool-output" aria-live="polite">{toolOutput}</pre>}
        </>}
        </div>
      </section>}
      {notice && <div className="ide-agent-sidebar__notice" data-testid="ide-agent-notice" role="status">{notice}</div>}
    </aside>
  );
}
