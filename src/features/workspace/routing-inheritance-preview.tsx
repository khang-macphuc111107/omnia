import { GitBranch, Layers3, MessageSquareText, PlayCircle, RotateCcw, Route, ShieldCheck, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { selectableModelProfiles } from "./provider-catalog";
import { useWorkspaceStore } from "./store";
import type { ProviderView } from "./types";

const INHERIT = "inherit";

const routeProfilePresets = [
  { id: "routing-default", label: "Automatic", modelProfileId: "auto", detail: "Use the workspace automatic route." },
  { id: "routing-quality", label: "Quality first", modelProfileId: "quality", detail: "Prefer the quality-oriented model route." },
  { id: "routing-local", label: "Local & private", modelProfileId: "local-fast", detail: "Prefer the local model route when available." },
] as const;

function profileLabel(profiles: ReturnType<typeof selectableModelProfiles>, profileId: string) {
  const profile = profiles.find((candidate) => candidate.id === profileId);
  return profile
    ? `${profile.displayName} · ${profile.providerName}`
    : profileId === "auto"
      ? "Automatic route"
      : `Unavailable profile · ${profileId}`;
}

function profileShortLabel(profiles: ReturnType<typeof selectableModelProfiles>, profileId: string) {
  if (profileId === "auto") return "Automatic";
  return profiles.find((candidate) => candidate.id === profileId)?.displayName ?? `Unavailable · ${profileId}`;
}

function explicitProjectValue(value: string | undefined) {
  return value && value !== "auto" ? value : INHERIT;
}

export function RoutingInheritancePreview({
  providers,
  modelProfileId,
  onModelProfileChange,
  projectId: scopeProjectId,
}: {
  readonly providers: ProviderView[];
  readonly modelProfileId: string;
  readonly onModelProfileChange: (profileId: string) => void;
  /**
   * Optional host scope.  Project Deck passes its project explicitly so the
   * inheritance preview cannot silently resolve against the workspace's
   * currently active project or a chat owned by another project.
   */
  readonly projectId?: string | null;
}) {
  const projects = useWorkspaceStore((state) => state.projects);
  const conversations = useWorkspaceStore((state) => state.conversations);
  const activeProjectId = useWorkspaceStore((state) => state.activeProjectId);
  const activeConversationId = useWorkspaceStore((state) => state.activeConversationId);
  const scopedProjects = useMemo(
    () => scopeProjectId ? projects.filter((project) => project.id === scopeProjectId) : projects,
    [projects, scopeProjectId],
  );
  const isProjectScoped = Boolean(scopeProjectId && scopedProjects.some((project) => project.id === scopeProjectId));
  const initialProjectId = scopeProjectId && scopedProjects.some((project) => project.id === scopeProjectId)
    ? scopeProjectId
    : activeProjectId && scopedProjects.some((project) => project.id === activeProjectId)
      ? activeProjectId
      : scopedProjects[0]?.id || "";
  const [projectId, setProjectId] = useState(initialProjectId);
  const [conversationId, setConversationId] = useState(activeConversationId || "");
  const [profileOverride, setProfileOverride] = useState(INHERIT);
  const [turnOverride, setTurnOverride] = useState(INHERIT);
  const [projectOverrides, setProjectOverrides] = useState<Record<string, string>>(() =>
    Object.fromEntries(projects.map((project) => [project.id, explicitProjectValue(project.modelProfileId)])),
  );
  const [chatOverrides, setChatOverrides] = useState<Record<string, string>>({});

  const profiles = useMemo(() => selectableModelProfiles(providers), [providers]);
  const selectedProject = scopedProjects.find((project) => project.id === projectId) ?? null;
  const availableConversations = useMemo(
    () => conversations.filter((conversation) => {
      if (conversation.archived) return false;
      // A project-hosted preview must only expose chats owned by that project.
      // In standalone routing workbench usage, selecting an empty project
      // keeps the original all-chat preview behavior.
      if (!projectId) return true;
      return conversation.projectId === projectId;
    }),
    [conversations, projectId],
  );
  const selectedConversation = availableConversations.find((conversation) => conversation.id === conversationId) ?? null;
  const projectValue = selectedProject ? projectOverrides[selectedProject.id] ?? explicitProjectValue(selectedProject.modelProfileId) : INHERIT;
  const chatValue = selectedConversation ? chatOverrides[selectedConversation.id] ?? INHERIT : INHERIT;
  const projectProfileIsKnown = projectValue === INHERIT || profiles.some((profile) => profile.id === projectValue);
  const profileRoute = routeProfilePresets.find((preset) => preset.id === profileOverride) ?? null;
  const effectiveProfileId = turnOverride !== INHERIT
    ? turnOverride
    : chatValue !== INHERIT
      ? chatValue
      : projectValue !== INHERIT
        ? projectValue
        : profileRoute?.modelProfileId ?? modelProfileId;
  const source = turnOverride !== INHERIT
    ? "Run/turn override"
    : chatValue !== INHERIT
      ? "Chat override"
      : projectValue !== INHERIT
        ? "Project override"
        : profileRoute
          ? "Profile preset"
          : "App default";
  const isAutomatic = effectiveProfileId === "auto";

  useEffect(() => {
    const preferredProjectId = scopeProjectId && scopedProjects.some((project) => project.id === scopeProjectId)
      ? scopeProjectId
      : activeProjectId && scopedProjects.some((project) => project.id === activeProjectId)
        ? activeProjectId
        : scopedProjects[0]?.id ?? "";
    setProjectId((current) => current === preferredProjectId ? current : preferredProjectId);
  }, [activeProjectId, scopeProjectId, scopedProjects]);

  useEffect(() => {
    const preferredConversationId = activeConversationId && availableConversations.some((conversation) => conversation.id === activeConversationId)
      ? activeConversationId
      : availableConversations.some((conversation) => conversation.id === conversationId)
        ? conversationId
        : availableConversations[0]?.id ?? "";
    setConversationId((current) => current === preferredConversationId ? current : preferredConversationId);
  }, [activeConversationId, availableConversations, conversationId]);

  const updateProjectOverride = (value: string) => {
    if (!selectedProject) return;
    setProjectOverrides((current) => ({ ...current, [selectedProject.id]: value }));
  };

  const updateChatOverride = (value: string) => {
    if (!selectedConversation) return;
    setChatOverrides((current) => ({ ...current, [selectedConversation.id]: value }));
  };

  const resetProjectOverride = () => {
    if (!selectedProject) return;
    setProjectOverrides((current) => ({ ...current, [selectedProject.id]: INHERIT }));
  };

  const resetChatOverride = () => {
    if (!selectedConversation) return;
    setChatOverrides((current) => ({ ...current, [selectedConversation.id]: INHERIT }));
  };

  const resetPreview = () => {
    setProjectOverrides(Object.fromEntries(projects.map((project) => [project.id, explicitProjectValue(project.modelProfileId)])));
    setChatOverrides({});
    setProfileOverride(INHERIT);
    setTurnOverride(INHERIT);
    onModelProfileChange("auto");
  };

  return (
    <section className="routing-inheritance" aria-labelledby="routing-inheritance-title">
      <header className="routing-inheritance__header">
        <span className="routing-inheritance__icon"><GitBranch size={16} /></span>
        <span>
          <span className="eyebrow">Renderer-local preview</span>
          <h3 id="routing-inheritance-title">Route inheritance</h3>
          <p>Preview which scope wins before a chat run. The nearest explicit override takes precedence.</p>
        </span>
        <span className="routing-inheritance__badge"><Layers3 size={12} /> App default → Profile → Project → Chat → Run</span>
      </header>

      <div className="routing-inheritance__selectors">
        <label>
          <span>Project scope</span>
          <select aria-label="Inheritance preview project" value={projectId} disabled={isProjectScoped} onChange={(event) => setProjectId(event.target.value)}>
            {!isProjectScoped ? <option value="">No project / standalone chat</option> : null}
            {scopedProjects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        </label>
        <label>
          <span>Chat scope</span>
          <select aria-label="Inheritance preview chat" value={conversationId} onChange={(event) => setConversationId(event.target.value)}>
            <option value="">No chat selected</option>
            {availableConversations.map((conversation) => <option key={conversation.id} value={conversation.id}>{conversation.title}</option>)}
          </select>
        </label>
      </div>

      <div className="routing-inheritance__chain" aria-label="Route inheritance chain">
        <label className="routing-inheritance__node">
          <span className="routing-inheritance__node-top"><span><Route size={13} /> App default</span><span className="routing-inheritance__node-actions"><em>Workspace-wide</em><button type="button" className="routing-inheritance__reset" onClick={() => onModelProfileChange("auto")} aria-label="Reset App default route" title="Reset App default route"><RotateCcw size={11} /></button></span></span>
          <select aria-label="App default route" value={modelProfileId} onChange={(event) => onModelProfileChange(event.target.value)}>
            {!profiles.some((profile) => profile.id === modelProfileId) ? <option value={modelProfileId}>Unavailable profile · {modelProfileId}</option> : null}
            {profiles.map((profile) => <option key={profile.id} value={profile.id}>Current · {profile.displayName}</option>)}
          </select>
          <small>Default for every project and chat that inherits.</small>
        </label>
        <span className="routing-inheritance__arrow" aria-hidden="true">→</span>
        <label className="routing-inheritance__node">
          <span className="routing-inheritance__node-top"><span><Sparkles size={13} /> Profile</span><span className="routing-inheritance__node-actions"><em>Optional</em><button type="button" className="routing-inheritance__reset" onClick={() => setProfileOverride(INHERIT)} aria-label="Reset profile route override" title="Reset profile route override"><RotateCcw size={11} /></button></span></span>
          <select aria-label="Profile route override" value={profileOverride} onChange={(event) => setProfileOverride(event.target.value)}>
            <option value={INHERIT}>Inherit App default</option>
            {routeProfilePresets.map((preset) => <option key={preset.id} value={preset.id}>Profile · {preset.label}</option>)}
          </select>
          <small>{profileRoute?.detail ?? "Use the workspace route unless a profile is selected."}</small>
        </label>
        <span className="routing-inheritance__arrow" aria-hidden="true">→</span>
        <label className="routing-inheritance__node">
          <span className="routing-inheritance__node-top"><span><Layers3 size={13} /> Project</span><span className="routing-inheritance__node-actions"><em>{selectedProject ? "Optional" : "Not selected"}</em><button type="button" className="routing-inheritance__reset" onClick={resetProjectOverride} disabled={!selectedProject} aria-label="Reset project route override" title="Reset project route override"><RotateCcw size={11} /></button></span></span>
          <select aria-label="Project route override" value={projectValue} onChange={(event) => updateProjectOverride(event.target.value)} disabled={!selectedProject}>
            <option value={INHERIT}>Inherit profile</option>
            {!projectProfileIsKnown ? <option value={projectValue}>Unavailable · {projectValue}</option> : null}
            {profiles.filter((profile) => profile.id !== "auto").map((profile) => <option key={profile.id} value={profile.id}>Override · {profile.displayName}</option>)}
          </select>
          <small>{selectedProject ? selectedProject.name : "Choose a project to preview a project override."}</small>
        </label>
        <span className="routing-inheritance__arrow" aria-hidden="true">→</span>
        <label className="routing-inheritance__node">
          <span className="routing-inheritance__node-top"><span><MessageSquareText size={13} /> Chat</span><span className="routing-inheritance__node-actions"><em>{selectedConversation ? "Optional" : "Not selected"}</em><button type="button" className="routing-inheritance__reset" onClick={resetChatOverride} disabled={!selectedConversation} aria-label="Reset chat route override" title="Reset chat route override"><RotateCcw size={11} /></button></span></span>
          <select aria-label="Chat route override" value={chatValue} onChange={(event) => updateChatOverride(event.target.value)} disabled={!selectedConversation}>
            <option value={INHERIT}>Inherit project</option>
            {profiles.filter((profile) => profile.id !== "auto").map((profile) => <option key={profile.id} value={profile.id}>Override · {profile.displayName}</option>)}
          </select>
          <small>{selectedConversation ? selectedConversation.title : "Choose a chat to preview a chat override."}</small>
        </label>
        <span className="routing-inheritance__arrow" aria-hidden="true">→</span>
        <label className="routing-inheritance__node">
          <span className="routing-inheritance__node-top"><span><PlayCircle size={13} /> Run / turn</span><span className="routing-inheritance__node-actions"><em>Optional</em><button type="button" className="routing-inheritance__reset" onClick={() => setTurnOverride(INHERIT)} aria-label="Reset run or turn route override" title="Reset run or turn route override"><RotateCcw size={11} /></button></span></span>
          <select aria-label="Run or turn route override" value={turnOverride} onChange={(event) => setTurnOverride(event.target.value)}>
            <option value={INHERIT}>Inherit chat</option>
            {profiles.filter((profile) => profile.id !== "auto").map((profile) => <option key={profile.id} value={profile.id}>Override · {profile.displayName}</option>)}
          </select>
          <small>Use a one-off route without changing the selected Chat.</small>
        </label>
      </div>

      <div className="routing-inheritance__resolved" role="status" aria-label={`Effective route: ${profileShortLabel(profiles, effectiveProfileId)}; selected by ${source.toLowerCase()}`}>
        <span className="routing-inheritance__resolved-mark"><Route size={15} /></span>
        <span><strong>Effective route: {profileShortLabel(profiles, effectiveProfileId)}</strong><small>{profileLabel(profiles, effectiveProfileId)} · selected by {source.toLowerCase()}</small></span>
        <em>{isAutomatic ? "Automatic" : "Pinned in preview"}</em>
      </div>

      <div className="routing-inheritance__footer">
        <span><ShieldCheck size={13} /> No native project/chat settings are written. Clearing an override restores inheritance immediately.</span>
        <button type="button" className="button button--ghost" onClick={resetPreview} aria-label="Reset route inheritance preview"><RotateCcw size={13} /> Reset preview</button>
      </div>
    </section>
  );
}
