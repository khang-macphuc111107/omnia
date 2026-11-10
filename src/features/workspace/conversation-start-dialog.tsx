import {
  Brain,
  Check,
  Clock3,
  FolderOpen,
  MessageSquarePlus,
  MessageCircleMore,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  X,
} from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import { ModalSurface } from "@/components/modal-surface";

import { selectableModelProfiles } from "./provider-catalog";
import type { WorkspaceOverlay } from "./overlay-store";
import {
  claimPlanChatIdempotencyKey,
  createPlanChatOperationReceipt,
  createPlanChatOperationPreview,
  evaluatePlanChatOperationPreflight,
  refreshPlanChatOperationDraft,
  resolvePlanChatOperation,
  updatePlanChatOperationPhase,
  type PlanChatOperationPreview,
  type PlanChatOperationReceipt,
} from "./plan-chat-operation";
import { useWorkspaceStore } from "./store";
import type { ComposerMode } from "./types";
import { ProjectChatModeSurface } from "./project-chat-mode-surface";

type StartDestination = "standalone" | string;
type ContextPolicy = "project" | "ask" | "none";
type MemoryPolicy = "enabled" | "off";
type RetentionPolicy = "standard" | "temporary";
type PlanDraft = Extract<WorkspaceOverlay, { kind: "start-conversation" }>["planDraft"];
const MAX_STARTER_DRAFT_LENGTH = 8192;

const modeOptions: ReadonlyArray<{
  id: ComposerMode;
  label: string;
  description: string;
  icon: typeof MessageSquarePlus;
}> = [
  { id: "ask", label: "Ask", description: "Normal conversation and quick answers.", icon: MessageSquarePlus },
  { id: "create", label: "Create", description: "Draft code, documents, and structured output.", icon: Sparkles },
  { id: "research", label: "Research", description: "Plan a research pass and cite sources later.", icon: SlidersHorizontal },
  { id: "discuss", label: "Discuss", description: "Stage multiple perspectives before a decision.", icon: MessageCircleMore },
];

const planOperationPhaseLabels: Record<PlanChatOperationReceipt["phase"], string> = {
  ready: "Ready for confirmation",
  "creating-chat": "Creating Chat",
  "staging-draft": "Staging task draft",
  staged: "Chat and draft staged",
  partial: "Partial — Chat created",
  failed: "Failed safely",
};

/**
 * Renderer-local setup for a new chat. The native create-conversation contract
 * currently accepts only an optional project id, so fields that need native
 * metadata remain explicit preview choices until the broker supports them.
 */
export function ConversationStartDialog({
  onClose,
  projectId,
  planDraft,
}: {
  onClose: () => void;
  projectId?: string;
  planDraft?: PlanDraft;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const projects = useWorkspaceStore((state) => state.projects);
  const conversations = useWorkspaceStore((state) => state.conversations);
  const providers = useWorkspaceStore((state) => state.providers);
  const currentModelProfileId = useWorkspaceStore((state) => state.modelProfileId);
  const currentComposerMode = useWorkspaceStore((state) => state.composerMode);
  const createConversation = useWorkspaceStore((state) => state.createConversation);
  const renameConversation = useWorkspaceStore((state) => state.renameConversation);
  const setConversationTemporary = useWorkspaceStore((state) => state.setConversationTemporary);
  const prepareConversationDraft = useWorkspaceStore((state) => state.prepareConversationDraft);
  const updateDraft = useWorkspaceStore((state) => state.updateDraft);
  const setComposerMode = useWorkspaceStore((state) => state.setComposerMode);
  const setModelProfile = useWorkspaceStore((state) => state.setModelProfile);
  const [destination, setDestination] = useState<StartDestination>(projectId ?? "standalone");
  const [mode, setMode] = useState<ComposerMode>(currentComposerMode);
  const [modelProfileId, setModelProfileId] = useState(currentModelProfileId || "auto");
  const [contextPolicy, setContextPolicy] = useState<ContextPolicy>(projectId ? "project" : "ask");
  const [memoryPolicy, setMemoryPolicy] = useState<MemoryPolicy>("enabled");
  const [retentionPolicy, setRetentionPolicy] = useState<RetentionPolicy>("standard");
  const [title, setTitle] = useState(() => planDraft ? `Task: ${planDraft.taskTitle}`.slice(0, 120) : "");
  const [starterPrompt, setStarterPrompt] = useState(() => planDraft?.text.slice(0, MAX_STARTER_DRAFT_LENGTH) ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attemptedPlanChatKeys = useRef(new Set<string>());
  const planOperation = useMemo<PlanChatOperationPreview | null>(() => {
    // An empty editable draft is no longer a Plan → Chat operation. Hide the
    // envelope instead of showing a stale fingerprint for text the user has
    // already removed; opening Chat remains available as a normal blank Chat.
    if (!planDraft || !starterPrompt.trim()) return null;
    const baseOperation = planDraft.operation ?? createPlanChatOperationPreview({
      projectId: planDraft.projectId,
      taskId: planDraft.taskId ?? "plan-task-unknown",
      taskTitle: planDraft.taskTitle,
      draft: planDraft.text,
    });
    return starterPrompt.trim() && starterPrompt !== planDraft.text
      ? refreshPlanChatOperationDraft(baseOperation, starterPrompt)
      : baseOperation;
  }, [planDraft, starterPrompt]);
  const [operationReceipt, setOperationReceipt] = useState<PlanChatOperationReceipt | null>(() => (
    planOperation ? createPlanChatOperationReceipt(planOperation) : null
  ));

  useEffect(() => {
    setOperationReceipt((current) => {
      if (!planOperation) return null;
      if (
        current?.operationId === planOperation.operationId
        && current.draftHash === planOperation.draftHash
        && current.idempotencyKey === planOperation.idempotencyKey
      ) return current;
      return createPlanChatOperationReceipt(planOperation);
    });
  }, [planOperation]);

  const eligibleProjects = useMemo(
    () => projects.filter((project) => project.archived !== true && project.contextHealth !== "missing-access"),
    [projects],
  );
  const models = useMemo(() => selectableModelProfiles(providers), [providers]);
  const selectedModel = models.find((model) => model.id === modelProfileId) ?? models[0];
  const selectedProject = eligibleProjects.find((project) => project.id === destination);
  const planPreflight = useMemo(() => {
    if (!planOperation) return null;
    return evaluatePlanChatOperationPreflight(operationReceipt ?? planOperation, {
      currentProjectId: destination === "standalone" ? null : destination,
      ...(planDraft?.taskId !== undefined ? { currentTaskId: planDraft.taskId } : {}),
      currentDraft: starterPrompt,
      destinationProjectExists: Boolean(selectedProject),
      destinationProjectArchived: selectedProject?.archived === true,
      targetConversationDraft: "",
    });
  }, [destination, operationReceipt, planDraft?.taskId, planOperation, selectedProject, starterPrompt]);
  const workspaceMode = destination === "standalone" ? "chat" : "project";
  const planDestinationAvailable = !planDraft || (projectId === planDraft.projectId && selectedProject?.id === planDraft.projectId);
  const selectedMode = modeOptions.find((option) => option.id === mode) ?? modeOptions[0]!;
  const selectedContextLabel = contextPolicy === "project"
    ? selectedProject?.name ?? "Project context"
    : contextPolicy === "none"
      ? "No project context"
      : "Ask before context is included";

  const start = async () => {
    if (!planDestinationAvailable) {
      setError("The source Project is unavailable. No Chat or task draft was created.");
      return;
    }
    if (planPreflight && !planPreflight.canProceed) {
      setError(planPreflight.blockingReason ?? "Plan → Chat preflight requires review before opening Chat.");
      return;
    }
    if (planOperation && !claimPlanChatIdempotencyKey(attemptedPlanChatKeys.current, planOperation.idempotencyKey)) {
      setError("This exact Plan → Chat intent already started in this setup session. Duplicate creation was blocked; native durable idempotency is Planned.");
      return;
    }
    setSaving(true);
    setError(null);
    if (planOperation) {
      setOperationReceipt(updatePlanChatOperationPhase(planOperation, "creating-chat"));
    }
    try {
      const conversationId = await createConversation(destination === "standalone" ? undefined : destination);
      // The current broker accepts no retention field. Preserve the user's
      // choice in the renderer projection while keeping the native boundary
      // explicit in the setup disclosure and Chat UI.
      setConversationTemporary(conversationId, retentionPolicy === "temporary");
      if (title.trim()) renameConversation(conversationId, title.trim());
      if (starterPrompt.trim()) {
        if (planDraft) {
          if (planOperation) setOperationReceipt((current) => current ? updatePlanChatOperationPhase(current, "staging-draft") : current);
          const result = prepareConversationDraft(conversationId, planDraft.projectId, starterPrompt);
          if (result !== "prepared") {
            const diagnostic = `Chat created, but the task draft was not staged (${result}). Review it in Chats; nothing was overwritten.`;
            if (planOperation) {
              setOperationReceipt(resolvePlanChatOperation(planOperation, "chat-created-draft-failed", {
                conversationId,
                diagnostic,
              }));
            }
            setError(diagnostic);
            return;
          }
          if (planOperation) setOperationReceipt(resolvePlanChatOperation(planOperation, "staged", { conversationId }));
        } else {
          updateDraft(starterPrompt);
        }
      }
      setComposerMode(mode);
      setModelProfile(modelProfileId);
      onClose();
    } catch (cause) {
      const diagnostic = cause instanceof Error ? cause.message : "The conversation could not be created.";
      if (planOperation) setOperationReceipt(resolvePlanChatOperation(planOperation, "failed", { diagnostic }));
      setError(diagnostic);
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalSurface
      className="conversation-start-dialog"
      title="Start a new conversation"
      description="Choose a project, mode, model, and renderer-local starting context before opening Chat."
      titleId={titleId}
      descriptionId={descriptionId}
      onClose={onClose}
    >
      <header className="conversation-start-dialog__header">
        <div className="conversation-start-dialog__hero-icon" aria-hidden="true"><MessageSquarePlus size={20} /></div>
        <div>
          <span className="eyebrow">Conversation setup</span>
          <h2 id={titleId}>Start a new conversation</h2>
          <p id={descriptionId}>Set the starting shape now. You can still change the composer mode and draft after Chat opens.</p>
        </div>
        <button type="button" className="icon-button" aria-label="Close dialog" onClick={onClose}><X size={17} /></button>
      </header>

      <div className="conversation-start-dialog__body">
        <section className="conversation-start-dialog__section">
          <div className="conversation-start-dialog__section-heading">
            <div><span className="eyebrow">Where</span><h3>Conversation destination</h3></div>
            <span className="conversation-start-dialog__badge"><FolderOpen size={13} /> {selectedProject?.name ?? "Standalone"}</span>
          </div>
          <ProjectChatModeSurface
            mode={workspaceMode}
            projectCount={eligibleProjects.length}
            chatCount={conversations.length}
            {...(selectedProject?.name ? { projectLabel: selectedProject.name } : {})}
            projectDisabled={eligibleProjects.length === 0}
            chatDisabled={Boolean(planDraft)}
            onChange={(nextMode) => {
              if (nextMode === "chat") {
                if (planDraft) return;
                setDestination("standalone");
                setContextPolicy("ask");
                return;
              }
              const nextProject = planDraft
                ? eligibleProjects.find((project) => project.id === planDraft.projectId)
                : selectedProject ?? eligibleProjects[0];
              if (nextProject) {
                setDestination(nextProject.id);
                setContextPolicy("project");
              }
            }}
          />
          <div className="conversation-start-dialog__field-grid">
            <label className="conversation-start-dialog__field">
              <span>Project</span>
              <select aria-label="Project" value={destination} disabled={Boolean(planDraft)} onChange={(event) => {
                const next = event.target.value;
                setDestination(next);
                if (next !== "standalone") setContextPolicy("project");
              }}>
                <option value="standalone">Standalone chat</option>
                {eligibleProjects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
              </select>
              <small>{planDraft ? "This task draft stays in its source Project." : selectedProject ? "Desktop Chat creation can persist Project membership; browser preview stays session-only." : "No project membership is selected."}</small>
            </label>
            <label className="conversation-start-dialog__field">
              <span>Chat title <em>optional</em></span>
              <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Untitled conversation" maxLength={120} />
              <small>Leave blank to keep the default title.</small>
            </label>
          </div>
        </section>

        <section className="conversation-start-dialog__section">
          <div className="conversation-start-dialog__section-heading"><div><span className="eyebrow">How</span><h3>Mode and model</h3></div><span className="conversation-start-dialog__badge"><selectedMode.icon size={13} /> {selectedMode.label}</span></div>
          <div className="conversation-start-dialog__mode-grid" role="radiogroup" aria-label="Conversation mode">
            {modeOptions.map((option) => {
              const Icon = option.icon;
              const active = mode === option.id;
              return <button key={option.id} type="button" className={active ? "conversation-start-dialog__mode is-active" : "conversation-start-dialog__mode"} role="radio" aria-checked={active} onClick={() => setMode(option.id)}><span className="conversation-start-dialog__mode-icon"><Icon size={16} /></span><span><strong>{option.label}</strong><small>{option.description}</small></span>{active ? <Check size={15} aria-hidden="true" /> : null}</button>;
            })}
          </div>
          <label className="conversation-start-dialog__field">
            <span>Model route</span>
            <select aria-label="Model route" value={modelProfileId} onChange={(event) => setModelProfileId(event.target.value)}>
              {models.map((model) => <option key={model.id} value={model.id}>{model.displayName}{model.providerName ? ` · ${model.providerName}` : ""}</option>)}
            </select>
            <small>{selectedModel?.contextLabel ?? "Automatic route"} · selection is applied when Chat opens.</small>
          </label>
        </section>

        <section className="conversation-start-dialog__section">
          <div className="conversation-start-dialog__section-heading"><div><span className="eyebrow">Context</span><h3>Starting context policy</h3></div><span className="conversation-start-dialog__badge"><Brain size={13} /> {selectedContextLabel}</span></div>
          <div className="conversation-start-dialog__field-grid conversation-start-dialog__field-grid--three">
            <label className="conversation-start-dialog__field"><span>Project context</span><select aria-label="Project context" value={contextPolicy} onChange={(event) => setContextPolicy(event.target.value as ContextPolicy)}><option value="project">Use selected project</option><option value="ask">Ask in Chat</option><option value="none">Start without context</option></select><small>Preview choice only; no context freeze is created.</small></label>
            <label className="conversation-start-dialog__field"><span>Memory</span><select aria-label="Memory" value={memoryPolicy} onChange={(event) => setMemoryPolicy(event.target.value as MemoryPolicy)}><option value="enabled">Use eligible memory</option><option value="off">Do not include memory</option></select><small>{memoryPolicy === "enabled" ? "Active memory stays reviewable." : "Memory is excluded from this preview."}</small></label>
            <label className="conversation-start-dialog__field"><span>Retention</span><select aria-label="Retention" value={retentionPolicy} onChange={(event) => setRetentionPolicy(event.target.value as RetentionPolicy)}><option value="standard">Standard chat</option><option value="temporary">Temporary chat</option></select><small>{retentionPolicy === "temporary" ? "Native temporary-chat metadata is planned." : "Normal renderer session behavior."}</small></label>
          </div>
        </section>

        <section className="conversation-start-dialog__section">
          <div className="conversation-start-dialog__section-heading"><div><span className="eyebrow">Starter</span><h3>Prompt to open with</h3></div><span className="conversation-start-dialog__counter">{starterPrompt.length}/{MAX_STARTER_DRAFT_LENGTH.toLocaleString()}</span></div>
          {planDraft ? <p className="conversation-start-dialog__plan-source" role="status">Project Plan task: {planDraft.taskTitle}. Review this editable draft before opening the Chat; it will not be sent automatically.</p> : null}
          {planOperation && operationReceipt ? <section className="conversation-start-dialog__operation" aria-label="Plan to Chat operation preview">
            <header>
              <div><span className="eyebrow">Plan → Chat operation</span><strong>{planOperationPhaseLabels[operationReceipt.phase]}</strong></div>
              <span className="conversation-start-dialog__operation-chip">Renderer-local</span>
            </header>
            <dl>
              <div><dt>Operation</dt><dd><code>{operationReceipt.operationId}</code></dd></div>
              <div><dt>Retry key (preview only)</dt><dd><code>{operationReceipt.idempotencyKey}</code></dd></div>
              <div><dt>Expected scope</dt><dd>{operationReceipt.expectedProjectId} · {operationReceipt.expectedTaskId}</dd></div>
              <div><dt>Plan revision</dt><dd>{operationReceipt.expectedPlanRevisionId ?? "Unavailable in preview"}</dd></div>
              <div><dt>Draft fingerprint</dt><dd>{operationReceipt.draftHash} · {operationReceipt.draftLength.toLocaleString()} chars</dd></div>
              <div><dt>Draft revision</dt><dd>{operationReceipt.draftRevision === 0 ? "Source Plan text" : `Edited draft ${operationReceipt.draftRevision}`}</dd></div>
              <div><dt>Atomic plan</dt><dd>{operationReceipt.atomicContract.steps.join(" → ")} · {operationReceipt.atomicContract.nativeAtomicity}</dd></div>
              <div><dt>Native transaction</dt><dd>Planned · not observed; create + draft staging are currently sequential.</dd></div>
              <div><dt>Replay guard</dt><dd>Same-key duplicate submissions blocked for this setup session only.</dd></div>
              <div><dt>Preconditions</dt><dd>{operationReceipt.atomicContract.destinationRule} · {operationReceipt.atomicContract.draftRule}</dd></div>
              <div><dt>Failure policy</dt><dd>{operationReceipt.atomicContract.partialFailurePolicy.replaceAll("-", " ")}</dd></div>
            </dl>
            {planPreflight ? <div className={`conversation-start-dialog__operation-preflight conversation-start-dialog__operation-preflight--${planPreflight.status}`} role="status" aria-label="Plan to Chat preflight">
              <div><span className="eyebrow">Preflight</span><strong>{planPreflight.status === "ready" ? "Ready for preview confirmation" : planPreflight.status === "review" ? "Review required" : "Blocked"}</strong></div>
              <ul>{planPreflight.checks.map((check) => <li key={check.id} data-state={check.state}><span aria-hidden="true">{check.state === "pass" ? "✓" : check.state === "review" ? "!" : "×"}</span><span><strong>{check.label}</strong><small>{check.detail}</small></span></li>)}</ul>
            </div> : null}
            <small>{operationReceipt.diagnostic ?? planOperation.boundary}</small>
          </section> : null}
          <textarea value={starterPrompt} onChange={(event) => setStarterPrompt(event.target.value.slice(0, MAX_STARTER_DRAFT_LENGTH))} placeholder="Optional: leave a draft ready in the composer…" rows={4} aria-label="Starter Chat draft" />
        </section>

        <div className="conversation-start-dialog__boundary"><ShieldCheck size={16} /><span><strong>Preview-only setup</strong><small>On desktop, opening Chat can create a native Chat record. Title, mode, model, and starter draft stay renderer-local. Context, memory, and temporary retention choices do not grant authority, call a provider, or create durable native metadata yet.</small></span></div>
        {error ? <div className="conversation-start-dialog__error" role="alert">{error}</div> : null}
      </div>

      <footer className="conversation-start-dialog__footer"><span><Clock3 size={14} /> {retentionPolicy === "temporary" ? "Temporary preview selected" : "Ready to open Chat"}</span><div><button type="button" className="button button--ghost" onClick={onClose}>Cancel</button><button type="button" className="button button--primary" disabled={saving || !planDestinationAvailable || Boolean(planOperation && !planPreflight?.canProceed)} onClick={() => void start()}>{saving ? "Opening…" : "Open Chat"}<MessageSquarePlus size={15} /></button></div></footer>
    </ModalSurface>
  );
}
