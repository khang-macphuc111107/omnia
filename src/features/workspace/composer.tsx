import {
  AlertTriangle,
  Bold,
  Braces,
  CircleHelp,
  ChevronDown,
  Code2,
  Eye,
  FilePlus2,
  Heading2,
  Image,
  Italic,
  IndentDecrease,
  IndentIncrease,
  Layers3,
  Link2,
  List,
  ListChecks,
  ListOrdered,
  Mic,
  MessageCircleMore,
  Music2,
  PencilLine,
  Plus,
  Quote,
  Search,
  Send,
  Settings2,
  SlidersHorizontal,
  Square,
  SplitSquareHorizontal,
  Strikethrough,
  Video,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent } from "react";

import { ProductIcon } from "@/components/product-icons";
import { desktop, isDesktopRuntime } from "@/lib/desktop";
import { ComposerPromptAssistBar, ComposerRouteControls } from "./ai-panel-composer";
import "../../styles/review-composer.css";

import {
  ComposerAttachmentTray,
  composerAttachmentBlockReason,
  composerAttachmentFromView,
  summarizeComposerAttachments,
  type ComposerAttachmentItem,
} from "./composer-attachments";
import { ComposerAttachmentCompatibility } from "./composer-attachment-compatibility";
import { ComposerAttachmentAdmissionReview } from "./composer-attachment-admission-review";
import { attachmentKind, attachmentViewFromDesktopRecord, formatAttachmentSize } from "./attachment-catalog";
import { conversationFromNativeSnapshot } from "./conversation-catalog";
import {
  ComposerMediaPreview,
  type ComposerMediaKind,
} from "./composer-media-preview";
import { useComposerDraftHistory } from "./composer-draft-history";
import { ComposerBlockInsertStudio } from "./composer-block-insert-studio";
import { ComposerDraftStudio } from "./composer-draft-studio";
import {
  analyzeComposerPreview,
  ComposerRichPreview,
  type ComposerPreviewBlock,
} from "./composer-rich-preview";
import ContextPreflightPreview, {
  type ContextPreflightSource,
  type ContextPreflightSourceStatus,
} from "./context-preflight-preview";
import { buildProjectContextAvailabilityForProject } from "./project-context-availability-contract";
import {
  continueMarkdownCodeBlockAtSelection,
  continueMarkdownListAtSelection,
  indentMarkdownSelection,
  insertMarkdownLink,
  isMarkdownInlineActive,
  isMarkdownLinePrefixActive,
  isMarkdownListActive,
  toggleMarkdownHeading,
  toggleMarkdownInline,
  toggleMarkdownLinePrefix,
  toggleMarkdownListPrefix,
  type ComposerListStyle,
} from "./composer-editor";
import {
  applyComposerSlashCommand,
  collectCrossAgentPromptHistory,
  computeLivePromptSuggestion,
  enhancePromptDraft,
  findComposerSlashCommands,
  getComposerSlashContext,
  recallCrossAgentPromptHistory,
  type ComposerSlashCommand,
  type ComposerSlashContext,
} from "./composer-slash-commands";
import {
  assessComposerPaste,
  formatComposerPasteNotice,
  insertTextAtSelection,
  type ComposerPasteAssessment,
} from "./composer-paste";
import { ComposerPastePreview } from "./composer-paste-preview";
import { ComposerModeControlsPreview } from "./composer-mode-controls-preview";
import {
  ComposerEditorWorkbench,
  DEFAULT_COMPOSER_EDITOR_PREFERENCES,
  type ComposerEditorPreferences,
} from "./composer-editor-workbench";
import { openWorkspaceOverlay } from "./overlay-store";
import { opaquePreparedAttemptDispatch } from "./prepared-run-dispatch";
import { selectableModelProfiles } from "./provider-catalog";
import {
  preflightProviderParameters,
  resolveRoutedProviderModel,
  supportsProviderParameter,
} from "./provider-parameters";
import type { ContextDeliveryMode } from "./model-route-preset-contract";
import {
  applyRunStreamEventToStore,
  subscribeRunEvents,
} from "./run-event-broker";
import {
  SelectionReferenceTray,
  selectionReferencePromptPreview,
} from "./selection-reference-surface";
import { useSelectionReferenceStore } from "./selection-reference-store";
import { createId, useWorkspaceStore } from "./store";
import {
  createVoiceRecognition,
  formatVoiceRecognitionError,
  formatVoiceRecognitionInterruption,
  getSpeechRecognitionFactory,
  resolveVoiceLanguage,
  transcriptFromSpeechResults,
  type VoiceRecognitionLike,
} from "./voice-input";
import {
  VoiceInputPreview,
  type VoiceInsertMode,
} from "./voice-input-preview";

function mockBrowserResponse(prompt: string): string {
  const topic = prompt.length > 90 ? `${prompt.slice(0, 87)}…` : prompt;
  return `I received your request: **${topic}**\n\nThis is a preview response, not an AI-generated answer. Connect a provider in Settings to chat with a model.`;
}

/**
 * Renderer-only attachment token heuristic used by context preflight.
 *
 * Native attachment bytes never cross this boundary, so this is deliberately
 * a conservative size estimate rather than a provider-tokenizer result. The
 * native compiler must recalculate the estimate from its immutable extraction
 * record before dispatch.
 */
function estimateAttachmentContextTokens(attachment: { byteSize?: number }): number {
  if (!Number.isSafeInteger(attachment.byteSize) || (attachment.byteSize ?? 0) <= 0) return 0;
  return Math.max(1, Math.ceil((attachment.byteSize ?? 0) / 4));
}

export function ChatComposer() {
  const activeConversationId = useWorkspaceStore((state) => state.activeConversationId);
  const conversation = useWorkspaceStore((state) =>
    state.conversations.find((item) => item.id === activeConversationId),
  );
  const projects = useWorkspaceStore((state) => state.projects);
  const memories = useWorkspaceStore((state) => state.memories);
  const activeRun = useWorkspaceStore((state) => state.activeRun);
  const setActivity = useWorkspaceStore((state) => state.setActivity);
  const composerMode = useWorkspaceStore((state) => state.composerMode);
  const setComposerMode = useWorkspaceStore((state) => state.setComposerMode);
  const modelProfileId = useWorkspaceStore((state) => state.modelProfileId);
  const providers = useWorkspaceStore((state) => state.providers);
  const parameters = useWorkspaceStore((state) => state.parameters);
  const setModelProfile = useWorkspaceStore((state) => state.setModelProfile);
  const setParameter = useWorkspaceStore((state) => state.setParameter);
  const skills = useWorkspaceStore((state) => state.skills);
  const attachments = useWorkspaceStore((state) => state.attachments);
  const draftAttachmentIds = useWorkspaceStore(
    (state) => state.draftAttachmentIdsByConversation[activeConversationId],
  );
  const draftAttachments = useMemo(() => {
    const selectedIds = new Set(draftAttachmentIds ?? []);
    return attachments.filter((attachment) => selectedIds.has(attachment.id));
  }, [attachments, draftAttachmentIds]);
  const enabledSkills = useMemo(() => skills.filter((skill) => skill.enabled), [skills]);
  const updateDraft = useWorkspaceStore((state) => state.updateDraft);
  const startRun = useWorkspaceStore((state) => state.startRun);
  const setRunStage = useWorkspaceStore((state) => state.setRunStage);
  const appendRunDelta = useWorkspaceStore((state) => state.appendRunDelta);
  const finishRun = useWorkspaceStore((state) => state.finishRun);
  const failRun = useWorkspaceStore((state) => state.failRun);
  const upsertConversation = useWorkspaceStore((state) => state.upsertConversation);
  const detachDraftAttachment = useWorkspaceStore((state) => state.detachDraftAttachment);
  const selectionReferences = useSelectionReferenceStore((state) => state.references);
  const setReferenceConversation = useSelectionReferenceStore((state) => state.setConversation);
  const clearSelectionReferences = useSelectionReferenceStore((state) => state.clearReferences);
  const draftHistory = useComposerDraftHistory({
    conversationId: conversation?.id ?? activeConversationId ?? "no-active-conversation",
    value: conversation?.draft ?? "",
    onChange: updateDraft,
  });
  const [preflightError, setPreflightError] = useState<string | null>(null);
  const [largePasteNotice, setLargePasteNotice] = useState<string | null>(null);
  const [largePasteAssessment, setLargePasteAssessment] = useState<ComposerPasteAssessment | null>(null);
  const [voiceState, setVoiceState] = useState<"idle" | "listening" | "error">("idle");
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [voiceLanguage, setVoiceLanguage] = useState(() => resolveVoiceLanguage());
  const [voiceInsertMode, setVoiceInsertMode] = useState<VoiceInsertMode>("append");
  const [attachmentPickerBusy, setAttachmentPickerBusy] = useState(false);
  const [browserPreviewAttachments, setBrowserPreviewAttachments] = useState<ComposerAttachmentItem[]>([]);
  const [fileDragActive, setFileDragActive] = useState(false);
  const [composerView, setComposerView] = useState<"write" | "split" | "preview">("write");
  const [editorSelection, setEditorSelection] = useState({ start: 0, end: 0 });
  const [editorPreferences, setEditorPreferences] = useState<ComposerEditorPreferences>(
    DEFAULT_COMPOSER_EDITOR_PREFERENCES,
  );
  const [contextPreflightOpen, setContextPreflightOpen] = useState(false);
  const [contextDeliveryMode, setContextDeliveryMode] = useState<ContextDeliveryMode>("auto");
  const [formatMenuOpen, setFormatMenuOpen] = useState(false);
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [modeControlsOpen, setModeControlsOpen] = useState(false);
  const [blockStudioOpen, setBlockStudioOpen] = useState(false);
  const [advancedInputsOpen, setAdvancedInputsOpen] = useState(false);
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const [composerNotice, setComposerNotice] = useState<string | null>(null);
  const [selectedMediaKinds, setSelectedMediaKinds] = useState<ComposerMediaKind[]>([]);
  const allConversations = useWorkspaceStore((state) => state.conversations);
  const [slashContext, setSlashContext] = useState<ComposerSlashContext | null>(null);
  const [slashActiveIndex, setSlashActiveIndex] = useState(0);
  const [historyRecallIndex, setHistoryRecallIndex] = useState<number | null>(null);
  const [automationsOpen, setAutomationsOpen] = useState(false);
  const [scheduleCron, setScheduleCron] = useState("*/15 * * * *");
  const [schedulePrompt, setSchedulePrompt] = useState("");
  const [scheduledJobs, setScheduledJobs] = useState<
    Array<{ id: string; cron: string; prompt: string; enabled: boolean }>
  >([
    {
      id: "sched_default_ci",
      cron: "0 * * * *",
      prompt: "Audit build health and run test verification suite",
      enabled: true,
    },
  ]);
  const crossAgentPromptHistory = useMemo(
    () => collectCrossAgentPromptHistory(allConversations),
    [allConversations],
  );
  const slashSelectionRef = useRef<{ value: string; start: number; end: number } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const browserAttachmentInputRef = useRef<HTMLInputElement>(null);
  const attachMenuRef = useRef<HTMLDivElement>(null);
  const browserPreviewAttachmentsRef = useRef(browserPreviewAttachments);
  const browserPreviewConversationIdRef = useRef(conversation?.id ?? null);
  const fileDragDepthRef = useRef(0);
  const modeMenuAnchorRef = useRef<HTMLDivElement>(null);
  const modeTriggerRef = useRef<HTMLButtonElement>(null);
  const modeControlsTriggerRef = useRef<HTMLButtonElement>(null);
  const contextPreflightRef = useRef<HTMLDivElement>(null);
  const pendingPasteCursorRef = useRef<number | null>(null);
  const pendingEditorSelectionRef = useRef<{ start: number; end: number } | null>(null);
  const editorSelectionRef = useRef({ start: 0, end: 0 });
  const voiceRecognitionRef = useRef<VoiceRecognitionLike | null>(null);
  const voiceSessionRef = useRef(0);
  const voiceDraftBaseRef = useRef("");
  const clearLargePastePreview = () => {
    setLargePasteNotice(null);
    setLargePasteAssessment(null);
  };
  browserPreviewAttachmentsRef.current = browserPreviewAttachments;
  const models = useMemo(() => selectableModelProfiles(providers), [providers]);
  const selectedModel = models.find((profile) => profile.id === modelProfileId) ?? models[0];
  const route = resolveRoutedProviderModel(providers, selectedModel);
  const routedModel = route?.model;
  const contextProject = useMemo(
    // A Chat's context scope belongs to its durable projectId. The active
    // sidebar project is navigation state and must not silently turn a
    // standalone conversation into a project-scoped draft.
    () => projects.find((project) => project.id === conversation?.projectId) ?? null,
    [conversation?.projectId, projects],
  );
  const contextProjectMissing = Boolean(conversation?.projectId && !contextProject);
  const contextScopeLabel = contextProject?.name
    ?? (contextProjectMissing ? conversation?.projectName ?? "Unavailable project" : "Standalone chat");
  const contextAvailability = useMemo(
    () => contextProject
      ? buildProjectContextAvailabilityForProject(contextProject)
      : null,
    [contextProject],
  );
  const contextScopeStatus = contextProjectMissing
    ? "Project not in snapshot"
    : contextAvailability?.shortLabel ?? "Conversation-local";
  const contextScopeTitle = contextProjectMissing
    ? "This Chat points to a Project missing from the current renderer snapshot."
    : contextAvailability?.reason ?? "No Project is attached; this draft stays in conversation-local preview.";
  const contextProjectName = contextProjectMissing
    ? `${contextScopeLabel} · unavailable`
    : contextScopeLabel;
  // A project folder is represented by the native workspace grant id in the
  // renderer projection.  Only ready/referenced read-only grants are eligible
  // for the prepare-plus-retrieve path; missing access and renderer-only
  // previews remain fail-closed.  The native command revalidates project
  // ownership, canonical path, index policy, hashes, and snapshot lineage.
  const contextAdmissionGrantId = useMemo(() => {
    if (!isDesktopRuntime() || !contextProject || contextDeliveryMode === "manifest-only") return null;
    const candidate = contextProject.folders.find((folder) =>
      (folder.state === "ready" || folder.state === "referenced")
      && (folder.scope === "read-only" || folder.scope === "full-index" || folder.scope === "selected-files"),
    );
    return candidate?.id ?? null;
  }, [contextDeliveryMode, contextProject]);
  const modeDefinition = composerMode === "ask"
    ? { label: "Ask", description: "Normal text conversation", icon: <CircleHelp size={15} /> }
    : composerMode === "create"
      ? { label: "Create", description: "Drafting preview · native execution planned", icon: <FilePlus2 size={15} /> }
      : composerMode === "research"
        ? { label: "Research", description: "Research preview · retrieval planned", icon: <Search size={15} /> }
        : { label: "Discuss", description: "Multi-perspective preview · orchestration planned", icon: <MessageCircleMore size={15} /> };

  useEffect(() => {
    if (!attachMenuOpen) return;
    const closeOnOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !attachMenuRef.current?.contains(event.target)) setAttachMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setAttachMenuOpen(false);
      attachMenuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    };
    document.addEventListener("pointerdown", closeOnOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [attachMenuOpen]);

  useEffect(() => {
    if (!modeMenuOpen && !modeControlsOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && !modeMenuAnchorRef.current?.contains(target)) {
        setModeMenuOpen(false);
        setModeControlsOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setModeMenuOpen(false);
      setModeControlsOpen(false);
      modeTriggerRef.current?.focus({ preventScroll: true });
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [modeControlsOpen, modeMenuOpen]);

  useEffect(() => {
    if (!formatMenuOpen && !blockStudioOpen && !contextPreflightOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setFormatMenuOpen(false);
      setBlockStudioOpen(false);
      setContextPreflightOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [blockStudioOpen, contextPreflightOpen, formatMenuOpen]);

  useEffect(() => {
    if (!contextPreflightOpen) return;
    // The preflight panel is intentionally rendered below the compact shell.
    // On short chat panes that row can be below the composer scroll viewport,
    // which made a successful chevron click look like a no-op. Bring the
    // newly-opened panel into the nearest visible scroll position without
    // jumping the whole page.
    window.requestAnimationFrame(() => {
      const panel = contextPreflightRef.current;
      if (panel && typeof panel.scrollIntoView === "function") {
        panel.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
    });
  }, [contextPreflightOpen]);

  const contextDraft = conversation?.draft ?? "";
  const contextPreflightSources = useMemo<readonly ContextPreflightSource[]>(() => {
    const projectName = contextProject?.name;
    const scopedMemories = memories.filter((memory) =>
      memory.status === "active"
      && (memory.scopeLabel === "Global" || (projectName ? memory.scopeLabel.includes(projectName) : false)),
    );
    const scopedSkills = skills.filter((skill) => skill.enabled && (skill.scope === "Global" || skill.scope === "Project"));
    const folders = contextProject?.folders ?? [];
    const nativeAttachmentCount = draftAttachments.length;
    const browserPreviewAttachmentCount = browserPreviewAttachments.length;
    const attachmentCount = nativeAttachmentCount + browserPreviewAttachmentCount;
    const attachmentTokens = draftAttachments.reduce(
      (total, attachment) => total + estimateAttachmentContextTokens(attachment),
      0,
    );
    const blockedNativeAttachments = draftAttachments.filter((attachment) =>
      attachment.state !== "ready"
      || (attachment.extractionStatus !== undefined && attachment.extractionStatus !== "complete"),
    ).length;
    const attachmentStatus: ContextPreflightSourceStatus = attachmentCount === 0
      ? "excluded"
      : browserPreviewAttachmentCount > 0 || blockedNativeAttachments > 0
        ? "blocked"
        : "planned";
    const folderStatus: ContextPreflightSourceStatus = contextProject?.contextHealth === "missing-access"
      || folders.some((folder) => folder.state === "permission-lost" || folder.state === "offline")
      ? "blocked"
      : folders.some((folder) => folder.state !== "ready") || folders.length === 0
        ? "review"
        : "ready";
    const draftTokens = contextDraft.trim() ? Math.max(1, Math.ceil(contextDraft.length / 4)) : 0;
    return [
      {
        id: "draft",
        label: "Current draft",
        count: contextDraft.trim() ? 1 : 0,
        estimatedTokens: draftTokens,
        selected: contextDraft.trim().length > 0,
        required: true,
        status: contextDraft.trim() ? "ready" : "excluded",
        detail: contextDraft.trim()
          ? "The current draft stays in this renderer session until a future native context freeze."
          : "Type a message to include the draft in this rehearsal.",
      },
      {
        id: "folders",
        label: "Workspace folders",
        count: folders.length,
        estimatedTokens: folders.length * 450,
        selected: folders.length > 0,
        status: folderStatus,
        detail: folders.length === 0
          ? "No folder grant is selected for this conversation."
          : folderStatus === "blocked"
            ? "Folder access still needs a native grant before a read can occur."
            : folderStatus === "review"
              ? "Folder scope or indexing state still needs native evidence."
              : "Folder references are represented in the renderer projection only.",
      },
      {
        id: "attachments",
        label: "Attachments",
        count: attachmentCount,
        estimatedTokens: attachmentTokens,
        selected: attachmentCount > 0,
        status: attachmentStatus,
        detail: attachmentCount === 0
          ? "No native or browser-preview attachments are selected for this draft."
          : browserPreviewAttachmentCount > 0
            ? `${browserPreviewAttachmentCount} browser-preview file${browserPreviewAttachmentCount === 1 ? " remains" : "s remain"} renderer-only and cannot be admitted to a native context freeze.`
            : blockedNativeAttachments > 0
              ? `${blockedNativeAttachments} native attachment${blockedNativeAttachments === 1 ? " is" : "s are"} still processing or failed extraction; dispatch remains blocked.`
              : "Native attachment metadata is selected, but extraction, provider representation, and immutable context freeze remain unverified in this renderer preview.",
      },
      {
        id: "instructions",
        label: "Project instructions",
        count: contextProject?.instructions.trim() ? 1 : 0,
        estimatedTokens: contextProject?.instructions.trim() ? 600 : 0,
        selected: Boolean(contextProject?.instructions.trim()),
        status: contextProject?.instructions.trim() ? "ready" : "excluded",
        detail: contextProject?.instructions.trim()
          ? "Instructions are shown for review; revision and authority remain unverified."
          : "No project instructions are selected.",
      },
      {
        id: "memories",
        label: "Relevant memories",
        count: scopedMemories.length,
        estimatedTokens: scopedMemories.length * 160,
        selected: scopedMemories.length > 0,
        status: scopedMemories.length > 0 ? "planned" : "excluded",
        detail: scopedMemories.length > 0
          ? "Renderer candidates only; retrieval and admission are still planned."
          : "No active memories are scoped to this conversation preview.",
      },
      {
        id: "skills",
        label: "Enabled skills",
        count: scopedSkills.length,
        estimatedTokens: scopedSkills.reduce((total, skill) => total + skill.tokenFootprint, 0),
        selected: scopedSkills.length > 0,
        status: scopedSkills.length > 0 ? "planned" : "excluded",
        detail: scopedSkills.length > 0
          ? "Renderer selection only; native skill activation is not connected."
          : "No enabled skills are selected for this rehearsal.",
      },
    ];
  }, [browserPreviewAttachments.length, contextDraft, contextProject, draftAttachments, memories, skills]);
  const contextEstimatedTokens = contextAvailability?.health === "missing-access" || contextAvailability?.health === "over-budget"
    ? null
    : contextPreflightSources.reduce((total, source) => total + (source.selected ? source.estimatedTokens : 0), 0);
  const composerAttachments = useMemo(
    () => [
      ...draftAttachments.map(composerAttachmentFromView),
      ...browserPreviewAttachments,
    ],
    [browserPreviewAttachments, draftAttachments],
  );
  const attachmentSummary = useMemo(
    () => summarizeComposerAttachments(composerAttachments),
    [composerAttachments],
  );

  useEffect(() => () => {
    for (const attachment of browserPreviewAttachmentsRef.current) {
      if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
    }
  }, []);

  useEffect(() => {
    if (browserPreviewConversationIdRef.current === conversation?.id) return;
    browserPreviewConversationIdRef.current = conversation?.id ?? null;
    setBrowserPreviewAttachments((current) => {
      for (const attachment of current) {
        if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
      }
      return [];
    });
    fileDragDepthRef.current = 0;
    setFileDragActive(false);
  }, [conversation?.id]);

  useEffect(() => {
    setPreflightError(null);
  }, [parameters, routedModel?.id]);

  useEffect(() => {
    setReferenceConversation(conversation?.id ?? null);
  }, [conversation?.id, setReferenceConversation]);

  useEffect(() => {
    slashSelectionRef.current = null;
    setSlashContext(null);
    setSlashActiveIndex(0);
    setSelectedMediaKinds([]);
    setContextPreflightOpen(false);
    setContextDeliveryMode("auto");
    setBlockStudioOpen(false);
    setAdvancedInputsOpen(false);
    setAttachMenuOpen(false);
    setEditorPreferences(DEFAULT_COMPOSER_EDITOR_PREFERENCES);
  }, [conversation?.id]);

  useEffect(() => {
    const unsubscribe = subscribeRunEvents(applyRunStreamEventToStore);
    return unsubscribe;
  }, []);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 96)}px`;
  }, [conversation?.draft]);

  useEffect(() => {
    // A paste projection belongs to the draft that produced it. Do not carry
    // a file-like preview into another conversation when the active chat
    // changes underneath the composer.
    setLargePasteNotice(null);
    setLargePasteAssessment(null);
  }, [activeConversationId]);

  useEffect(() => {
    const cursor = pendingPasteCursorRef.current;
    const textarea = textareaRef.current;
    if (cursor === null || !textarea) return;
    textarea.setSelectionRange(cursor, cursor);
    pendingPasteCursorRef.current = null;
  }, [conversation?.draft]);

  useEffect(() => {
    const pending = pendingEditorSelectionRef.current;
    const textarea = textareaRef.current;
    if (!pending || !textarea) return;
    const start = Math.min(pending.start, textarea.value.length);
    const end = Math.min(pending.end, textarea.value.length);
    textarea.setSelectionRange(start, end);
    pendingEditorSelectionRef.current = null;
  }, [conversation?.draft]);

  useEffect(() => {
    return () => {
      voiceSessionRef.current += 1;
      voiceRecognitionRef.current?.abort();
      voiceRecognitionRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!slashContext) return;
    window.dispatchEvent(new CustomEvent("omnia:close-floating-menus", { detail: { source: "chat-composer" } }));
    const command = findComposerSlashCommands(slashContext.query, { includeExtended: true })[slashActiveIndex];
    if (command) document.getElementById(`composer-slash-option-${command.id}`)?.scrollIntoView?.({ block: "nearest" });
  }, [slashActiveIndex, slashContext]);

  useEffect(() => {
    if (!attachMenuOpen && !modeMenuOpen && !formatMenuOpen) return;
    window.dispatchEvent(new CustomEvent("omnia:close-floating-menus", { detail: { source: "chat-composer" } }));
  }, [attachMenuOpen, formatMenuOpen, modeMenuOpen]);

  useEffect(() => {
    const handleCloseFloating = (event: Event) => {
      const detail = (event as CustomEvent<{ source?: string }>).detail;
      if (detail?.source !== "chat-composer") {
        setSlashContext(null);
        setAttachMenuOpen(false);
        setModeMenuOpen(false);
        setModeControlsOpen(false);
        setFormatMenuOpen(false);
        setBlockStudioOpen(false);
      }
    };
    window.addEventListener("omnia:close-floating-menus", handleCloseFloating);
    return () => window.removeEventListener("omnia:close-floating-menus", handleCloseFloating);
  }, []);

  if (!conversation) return null;

  const voiceAvailable = Boolean(getSpeechRecognitionFactory());

  const stopVoiceInput = () => {
    voiceSessionRef.current += 1;
    const recognition = voiceRecognitionRef.current;
    voiceRecognitionRef.current = null;
    setVoiceState("idle");
    if (!recognition) return;
    try {
      recognition.stop();
    } catch {
      // The browser can throw when recognition has already ended. The draft
      // is already updated from the last result, so stopping remains safe.
    }
  };

  const startVoiceInput = () => {
    if (voiceState === "listening") {
      stopVoiceInput();
      return;
    }
    if (!voiceAvailable) {
      setVoiceError("Voice input is not available in this browser. Typed input remains available.");
      setVoiceState("error");
      return;
    }

    const recognition = createVoiceRecognition(globalThis, voiceLanguage);
    if (!recognition) {
      setVoiceError("Voice input is not available in this browser. Typed input remains available.");
      setVoiceState("error");
      return;
    }

    const session = voiceSessionRef.current + 1;
    voiceSessionRef.current = session;
    voiceDraftBaseRef.current = voiceInsertMode === "replace" ? "" : conversation.draft;
    setVoiceError(null);
    setVoiceState("listening");
    voiceRecognitionRef.current = recognition;
    // Some browsers end a recognition session without emitting `error`.
    // Keep this per-recognizer so a normal user stop (which invalidates the
    // session above) remains quiet while an unexpected end is recoverable.
    let endedWithError = false;
    recognition.onstart = () => {
      if (voiceSessionRef.current === session) setVoiceState("listening");
    };
    recognition.onresult = (event) => {
      if (voiceSessionRef.current !== session) return;
      const transcript = transcriptFromSpeechResults(event.results);
      if (!transcript) return;
      const base = voiceDraftBaseRef.current;
      const separator = base.length > 0 && !/\s$/.test(base) ? " " : "";
      // `event.results` contains the complete current recognition buffer,
      // including final results delivered by earlier events. Replace the
      // recognition-owned suffix instead of appending it on every event, or
      // interim/final updates would duplicate already-rendered words.
      clearLargePastePreview();
      draftHistory.update(`${base}${separator}${transcript}`, "voice");
    };
    recognition.onerror = (event) => {
      if (voiceSessionRef.current !== session) return;
      endedWithError = true;
      voiceRecognitionRef.current = null;
      setVoiceError(formatVoiceRecognitionError(event.error));
      setVoiceState("error");
    };
    recognition.onend = () => {
      if (voiceSessionRef.current !== session) return;
      voiceRecognitionRef.current = null;
      if (endedWithError) {
        // SpeechRecognition normally emits `end` after `error`. Preserve the
        // actionable error instead of clearing it as the service tears down.
        setVoiceState("error");
        return;
      }
      // A service timeout/webview interruption may emit only `end`. The
      // transcript already merged into the draft remains available for
      // review and retry.
      setVoiceError(formatVoiceRecognitionInterruption());
      setVoiceState("error");
    };
    try {
      recognition.start();
    } catch (cause) {
      if (voiceSessionRef.current !== session) return;
      voiceRecognitionRef.current = null;
      setVoiceError(
        cause instanceof Error
          ? `Voice input could not start: ${cause.message}`
          : "Voice input could not start. Typed input remains available.",
      );
      setVoiceState("error");
    }
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const plainText = event.clipboardData.getData("text/plain");
    if (!plainText) return;

    // Always insert the exact plain-text payload ourselves. This prevents a
    // browser from interpreting rich clipboard HTML and gives the cursor a
    // deterministic source mapping. Native paste-to-file conversion is not
    // available yet, so a threshold crossing remains an inline fallback with
    // an explicit notice rather than a fabricated attachment.
    event.preventDefault();
    const richText = event.clipboardData.getData("text/html") || null;
    const selectionStart = event.currentTarget.selectionStart ?? conversation.draft.length;
    const selectionEnd = event.currentTarget.selectionEnd ?? selectionStart;
    const insertion = insertTextAtSelection(
      conversation.draft,
      plainText,
      selectionStart,
      selectionEnd,
    );
    pendingPasteCursorRef.current = insertion.cursor;
    draftHistory.update(insertion.value, "paste");
    // Thresholds apply to the resulting composer input, not only to the
    // clipboard fragment. A small paste can still push a near-limit draft
    // over the character/token/byte/line budget.
    const resultingAssessment = assessComposerPaste(insertion.value, richText);
    const notice = formatComposerPasteNotice(resultingAssessment);
    setLargePasteNotice(notice || null);
    setLargePasteAssessment(notice ? resultingAssessment : null);
  };

  const addBrowserPreviewFiles = (files: readonly File[]) => {
    const remaining = Math.max(0, 20 - draftAttachments.length - browserPreviewAttachments.length);
    const accepted = files.slice(0, remaining);
    const additions: ComposerAttachmentItem[] = accepted.map((file): ComposerAttachmentItem => {
      const imageByName = /\.(avif|bmp|gif|jpe?g|png|webp)$/i.test(file.name);
      const videoByName = /\.(avi|m4v|mov|mp4|ogv|webm)$/i.test(file.name);
      const previewType: "image" | "video" | undefined = file.type.startsWith("image/") || imageByName
        ? "image"
        : file.type.startsWith("video/") || videoByName
          ? "video"
          : undefined;
      const mediaType = file.type || (previewType ? `${previewType}/*` : "application/octet-stream");
      const canCreatePreview = Boolean(previewType && typeof URL.createObjectURL === "function");
      return {
        id: createId("browser_attachment"),
        name: file.name,
        kind: previewType === "image" ? "image" : attachmentKind(file.name, mediaType),
        mediaType,
        sizeLabel: formatAttachmentSize(file.size),
        state: "preview",
        statusDetail: "Renderer-local browser preview only; the file is not stored or sent to a provider.",
        ...(canCreatePreview && previewType ? { previewUrl: URL.createObjectURL(file), previewType } : {}),
      };
    });

    if (accepted.length > 0) setBrowserPreviewAttachments((current) => [...current, ...additions]);
    if (files.length > accepted.length) {
      setComposerNotice("The composer preview is limited to 20 files at a time. Remove a file before adding more.");
    } else if (accepted.length > 0) {
      setComposerNotice("Browser file preview added. It remains in this tab only and is not uploaded, stored, or sent.");
    }
  };

  const pickAttachments = async () => {
    if (attachmentPickerBusy || activeRun) return;
    if (!isDesktopRuntime()) {
      browserAttachmentInputRef.current?.click();
      return;
    }
    setAttachmentPickerBusy(true);
    setPreflightError(null);
    try {
      const draft = await desktop.pickAttachments({
        conversationId: conversation.id,
        branchId: conversation.activeBranchId,
        maxFiles: 20,
      });
      if (!draft) return;

      // Only durable, renderer-safe metadata crosses this boundary. The draft
      // remains local and the provider dispatch guard below still blocks it
      // until native multimodal admission returns a frozen bridge receipt.
      for (const record of draft.attachments) {
        const attachment = attachmentViewFromDesktopRecord(record);
        useWorkspaceStore.getState().upsertAttachment(attachment);
        useWorkspaceStore.getState().attachDraftAttachment(conversation.id, attachment.id);
      }
    } catch (cause) {
      setPreflightError(
        cause instanceof Error
          ? `Files could not be added: ${cause.message}`
          : "Files could not be added from the native picker.",
      );
    } finally {
      setAttachmentPickerBusy(false);
    }
  };

  const removeAttachment = async (attachmentId: string) => {
    const browserAttachment = browserPreviewAttachments.find((attachment) => attachment.id === attachmentId);
    if (browserAttachment) {
      if (browserAttachment.previewUrl) URL.revokeObjectURL(browserAttachment.previewUrl);
      setBrowserPreviewAttachments((current) => current.filter((attachment) => attachment.id !== attachmentId));
      return;
    }
    const selected = draftAttachments.find((attachment) => attachment.id === attachmentId);
    if (isDesktopRuntime() && selected?.draftId) {
      const siblingDraftAttachments = draftAttachments.filter(
        (attachment) => attachment.draftId === selected.draftId,
      );
      try {
        if (siblingDraftAttachments.length > 1) {
          await desktop.removeAttachmentFromDraft(selected.draftId, attachmentId);
        } else {
          // Native drafts cannot be left empty. Abandon the final draft member
          // so a dismissed composer does not retain a mutable orphan draft.
          await desktop.abandonAttachmentDraft(selected.draftId);
        }
        useWorkspaceStore.getState().removeAttachment(attachmentId);
      } catch (cause) {
        setPreflightError(
          cause instanceof Error
            ? `The file could not be removed: ${cause.message}`
            : "The file could not be removed from the native draft.",
        );
        return;
      }
    }
    detachDraftAttachment(conversation.id, attachmentId);
  };

  const containsFileTransfer = (event: DragEvent<HTMLElement>) =>
    Array.from(event.dataTransfer.types).includes("Files");
  const handleFileDragEnter = (event: DragEvent<HTMLDivElement>) => {
    if (isDesktopRuntime() || !containsFileTransfer(event)) return;
    event.preventDefault();
    fileDragDepthRef.current += 1;
    setFileDragActive(true);
  };
  const handleFileDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (isDesktopRuntime() || !containsFileTransfer(event)) return;
    event.preventDefault();
    fileDragDepthRef.current = Math.max(0, fileDragDepthRef.current - 1);
    if (fileDragDepthRef.current === 0) setFileDragActive(false);
  };
  const handleFileDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (isDesktopRuntime() || !containsFileTransfer(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };
  const handleFileDrop = (event: DragEvent<HTMLDivElement>) => {
    if (isDesktopRuntime() || !containsFileTransfer(event)) return;
    event.preventDefault();
    fileDragDepthRef.current = 0;
    setFileDragActive(false);
    if (activeRun) {
      setComposerNotice("Wait for the current response to finish before adding a browser-preview file.");
      return;
    }
    addBrowserPreviewFiles(Array.from(event.dataTransfer.files));
  };

  const isThisConversationRunning = activeRun?.conversationId === conversation.id;
  const submit = async () => {
    if (composerMode !== "ask") {
      setComposerNotice(`${modeDefinition.label} mode is a renderer preview; return to Ask to send.`);
      return;
    }
    const draftPrompt = conversation.draft.trim();
    if (!draftPrompt || activeRun) return;
    if (/^\/btw(?:\b|\s|$)/i.test(draftPrompt)) {
      const btwQuestion = draftPrompt.replace(/^\/btw\b\s*/i, "").trim() || "Quick side question (/btw)";
      const nowIso = new Date().toISOString();
      const btwConvId = createId("conv_btw");
      const btwUserMsgId = createId("message");
      const btwReplyMsgId = createId("message");
      const btwBranchId = createId("branch");
      const btwChildConversation = {
        id: btwConvId,
        title: `[/btw] ${btwQuestion.slice(0, 48)}`,
        excerpt: `[Zero-Pollution Side-Chat (/btw)] ${btwQuestion}`,
        updatedLabel: "Just now",
        projectId: conversation.projectId,
        projectName: conversation.projectName,
        workspacePath: `omnia://sessions/${conversation.id}`,
        pinned: false,
        archived: false,
        temporary: false,
        hasDraft: false,
        unread: false,
        runState: null,
        createdAt: nowIso,
        updatedAt: nowIso,
        modelLabel: selectedModel?.displayName ?? conversation.modelLabel ?? null,
        activeBranchId: btwBranchId,
        branches: [
          {
            id: btwBranchId,
            label: "side-chat",
            headMessageId: btwReplyMsgId,
            active: true,
          },
        ],
        draft: "",
        messages: [
          {
            id: btwUserMsgId,
            role: "user" as const,
            content: btwQuestion,
            createdAt: nowIso,
            status: "complete" as const,
            modelLabel: null,
            runId: null,
            attachments: [],
            branchIndex: 1,
            branchCount: 1,
          },
          {
            id: btwReplyMsgId,
            role: "assistant" as const,
            content: `[Zero-Pollution Side-Chat (/btw) · Parent Prefix Locked]\n\nAnswered "${btwQuestion}" using read-only snapshot of "${conversation.title}" without mutating the main conversation history or evicting the KV-cache prefix.`,
            createdAt: nowIso,
            status: "complete" as const,
            modelLabel: selectedModel?.displayName ?? conversation.modelLabel ?? null,
            runId: null,
            attachments: [],
            branchIndex: 1,
            branchCount: 1,
          },
        ],
      };
      useWorkspaceStore.setState((current) => ({
        conversations: [
          btwChildConversation,
          ...current.conversations.filter((item) => item.id !== btwConvId),
        ],
      }));
      draftHistory.update("", "typing");
      draftHistory.clearHistory();
      setSlashContext(null);
      window.dispatchEvent(
        new CustomEvent("omnia:open-btw-side-chat", {
          detail: { question: btwQuestion, parentConversationId: conversation.id, childConversationId: btwConvId },
        }),
      );
      return;
    }
    setPreflightError(null);
    if (isDesktopRuntime() && selectionReferences.length > 0) {
      setPreflightError(
        "Selection references are captured in the renderer, but native context binding has not yet issued a frozen receipt. Remove the references or use the browser preview before dispatching.",
      );
      return;
    }
    const prompt =
      !isDesktopRuntime() && selectionReferences.length > 0
        ? `${selectionReferencePromptPreview(selectionReferences)}\n\n${draftPrompt}`
        : draftPrompt;
    const attachmentBlockReason = composerAttachmentBlockReason(attachmentSummary);
    if (attachmentBlockReason) {
      setPreflightError(attachmentBlockReason);
      return;
    }
    if (draftAttachments.length > 0) {
      setPreflightError(
        "Attachment dispatch is fail-closed in this build because native run preparation has not yet bound these files to a frozen context snapshot. Remove them to send a text-only request.",
      );
      return;
    }
    if (isDesktopRuntime() && !routedModel?.connectionId) {
      openWorkspaceOverlay({ kind: "connect-provider" });
      return;
    }
    const providerPreflight = route ? preflightProviderParameters(parameters, route) : null;
    if (isDesktopRuntime() && providerPreflight && providerPreflight.errors.length > 0) {
      setPreflightError(providerPreflight.errors.join(" "));
      return;
    }
    const runId = createId("run");
    const attemptId = createId("attempt");
    const assistantMessageId = createId("message");
    const userMessageId = createId("message");
    let preparedAttemptDispatch: ReturnType<typeof opaquePreparedAttemptDispatch> | null = null;

    if (isDesktopRuntime() && routedModel?.connectionId) {
      try {
        const prepared = await desktop.prepareConversationRun({
          conversationId: conversation.id,
          branchId: conversation.activeBranchId,
          runId,
          attemptId,
          userMessageId,
          assistantMessageId,
          prompt,
          providerProfileId: routedModel.connectionId,
          model: routedModel.providerModelId,
          requestParametersJson: JSON.stringify(providerPreflight?.parameters ?? {}),
          ...(contextAdmissionGrantId
            ? {
                contextAdmission: {
                  grantId: contextAdmissionGrantId,
                  query: prompt,
                  retrievalOptions: {
                    tokenBudget: 8_000,
                    maxResults: 12,
                    maxResultsPerSource: 3,
                  },
                },
              }
            : {}),
        });
        preparedAttemptDispatch = opaquePreparedAttemptDispatch(prepared.providerInput, {
          attemptId,
          runId,
          providerProfileId: routedModel.connectionId,
          model: routedModel.providerModelId,
        });
        const durableConversation = conversationFromNativeSnapshot(
          prepared.conversation,
          useWorkspaceStore.getState().projects,
          useWorkspaceStore.getState().providers,
          useWorkspaceStore.getState().attachments.map((attachment) =>
            draftAttachments.some((candidate) => candidate.id === attachment.id)
              ? { ...attachment, messageId: userMessageId }
              : attachment,
          ),
        );
        upsertConversation({
          ...durableConversation,
          messages: durableConversation.messages.map((message) =>
            message.id === assistantMessageId
              ? { ...message, modelLabel: routedModel.displayName }
              : message,
          ),
        });
      } catch (cause) {
        setPreflightError(
          cause instanceof Error
            ? `The message could not be saved locally: ${cause.message}`
            : "The message could not be saved locally.",
        );
        return;
      }
    }

    startRun({
      conversationId: conversation.id,
      runId,
      assistantMessageId,
      userMessageId,
      prompt,
      attachments: draftAttachments,
      alreadyPersisted: isDesktopRuntime() && Boolean(routedModel?.connectionId),
    });
    // Sending clears the draft in the workspace store. Clear the local history
    // as well so Undo cannot resurrect a prompt that has already been sent.
    draftHistory.clearHistory();
    if (!isDesktopRuntime() && selectionReferences.length > 0) clearSelectionReferences();
    setRunStage(runId, "routing");

    if (isDesktopRuntime() && routedModel?.connectionId) {
      try {
        if (!preparedAttemptDispatch) {
          throw new Error("Native run preparation did not return a frozen provider input receipt.");
        }
        await desktop.startPreparedAttempt(preparedAttemptDispatch);
      } catch (cause) {
        // Only the native gateway may terminalize the durable run it resolves
        // from the frozen input. The renderer updates its local projection but
        // never supplies a run ID for a dispatch failure.
        failRun(runId, cause instanceof Error ? cause.message : "Provider run could not start");
      }
      return;
    }

    const tokens = mockBrowserResponse(prompt).split(/(?<=\s)/);
    let sequence = 0;
    const timer = window.setInterval(() => {
      const token = tokens[sequence];
      if (token === undefined) {
        window.clearInterval(timer);
        finishRun(runId, "stop");
        return;
      }
      appendRunDelta(runId, token);
      sequence += 1;
    }, 24);
  };

  const stop = async () => {
    if (!activeRun) return;
    if (isDesktopRuntime()) {
      await desktop.cancelRun(activeRun.id);
    } else {
      finishRun(activeRun.id, "cancelled");
    }
  };

  const insertComposerSnippet = (before: string, after = "", fallback = "") => {
    const textarea = textareaRef.current;
    // Read the live DOM value as the source of truth for toolbar actions. A
    // controlled textarea can receive a store update in the same event turn
    // that opened a formatting affordance; using the render-time closure here
    // could otherwise drop the newest list continuation or pasted text.
    const value = textarea?.value ?? conversation.draft;
    const { start: selectionStart, end: selectionEnd } = readComposerSelection(textarea, value.length);
    const selected = value.slice(selectionStart, selectionEnd);
    const body = selected || fallback;
    const insertion = `${before}${body}${after}`;
    const nextValue = `${value.slice(0, selectionStart)}${insertion}${value.slice(selectionEnd)}`;
    const nextCursorStart = selectionStart + before.length;
    const nextCursorEnd = nextCursorStart + body.length;
    draftHistory.update(nextValue, "format");
    setEditorSelection({ start: nextCursorStart, end: nextCursorEnd });
    clearLargePastePreview();
    setComposerNotice(null);
    setFormatMenuOpen(false);
    window.requestAnimationFrame(() => {
      const nextTextarea = textareaRef.current;
      if (!nextTextarea) return;
      nextTextarea.focus();
      nextTextarea.setSelectionRange(nextCursorStart, nextCursorEnd);
    });
  };

  const applyInlineComposerFormat = (marker: "**" | "*" | "~~" | "`", fallback: string) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const { start, end } = readComposerSelection(textarea);
    applyEditorChange(
      toggleMarkdownInline(
        textarea.value,
        start,
        end,
        marker,
        fallback,
      ),
    );
  };

  const applyLinePrefixComposerFormat = (prefix: string) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const { start, end } = readComposerSelection(textarea);
    applyEditorChange(
      toggleMarkdownLinePrefix(
        textarea.value,
        start,
        end,
        prefix,
      ),
    );
  };

  const applyListComposerFormat = (style: ComposerListStyle) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const marker = style === "checklist"
      ? "- [ ] "
      : style === "numbered"
        ? "1. "
        : style === "lettered"
          ? "a. "
          : "- ";
    const { start, end } = readComposerSelection(textarea);
    const selected = textarea.value.slice(start, end);
    // Preserve the editor's useful list-continuation affordance when the
    // selection includes an unfinished marker at the end. In that state the
    // user is usually choosing the next list family for the current draft,
    // not asking us to rewrite every already-authored line. The insertion
    // path also keeps the existing selection contract used by the composer.
    const lastSelectedLine = selected.split("\n").at(-1)?.trim() ?? "";
    if (/^(?:[-+*]|\d+[.)]|[A-Za-z]+[.)])\s*(?:\[[ xX]\])?\s*$/.test(lastSelectedLine)) {
      insertComposerSnippet(marker, "", style === "checklist" ? "task item" : "list item");
      return;
    }
    applyEditorChange(
      toggleMarkdownListPrefix(
        textarea.value,
        start,
        end,
        style,
      ),
    );
  };

  const applyHeadingLevel = (level: 1 | 2 | 3 | 4 | 5 | 6) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const { start, end } = readComposerSelection(textarea);
    applyEditorChange(
      toggleMarkdownHeading(
        textarea.value,
        start,
        end,
        level,
      ),
    );
    setFormatMenuOpen(false);
    announceComposerNotice(`Heading ${level} applied to the renderer-session draft.`);
  };

  const applyMarkdownLink = () => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const { start, end } = readComposerSelection(textarea);
    applyEditorChange(
      insertMarkdownLink(
        textarea.value,
        start,
        end,
      ),
    );
    setFormatMenuOpen(false);
    announceComposerNotice("Link inserted; the URL placeholder is selected for editing.");
  };

  const insertComposerBlock = (block: string) => {
    const textarea = textareaRef.current;
    const value = textarea?.value ?? conversation.draft;
    const { start: selectionStart, end: selectionEnd } = readComposerSelection(textarea, value.length);
    const before = selectionStart > 0 && !value.slice(0, selectionStart).endsWith("\n") ? "\n\n" : "";
    const after = selectionEnd < value.length && !value.slice(selectionEnd).startsWith("\n") ? "\n\n" : "";
    const insertion = `${before}${block}${after}`;
    const nextValue = `${value.slice(0, selectionStart)}${insertion}${value.slice(selectionEnd)}`;
    const cursor = selectionStart + before.length + block.length;
    draftHistory.update(nextValue, "format");
    setEditorSelection({ start: cursor, end: cursor });
    clearLargePastePreview();
    setComposerNotice(null);
    setFormatMenuOpen(false);
    setBlockStudioOpen(false);
    window.requestAnimationFrame(() => {
      const nextTextarea = textareaRef.current;
      if (!nextTextarea) return;
      nextTextarea.focus();
      nextTextarea.setSelectionRange(cursor, cursor);
    });
  };

  const applyEditorChange = (change: ReturnType<typeof continueMarkdownListAtSelection>) => {
    if (!change.handled) return false;

    pendingEditorSelectionRef.current = {
      start: change.selectionStart,
      end: change.selectionEnd,
    };
    draftHistory.update(change.value, "format");
    clearLargePastePreview();
    setLargePasteNotice(null);
    setLargePasteAssessment(null);
    setEditorSelection({ start: change.selectionStart, end: change.selectionEnd });
    if (voiceState !== "listening") voiceDraftBaseRef.current = change.value;
    window.requestAnimationFrame(() => {
      const nextTextarea = textareaRef.current;
      if (!nextTextarea) return;
      nextTextarea.focus();
      nextTextarea.setSelectionRange(change.selectionStart, change.selectionEnd);
    });
    return true;
  };

  const syncSlashMenu = (value: string, selectionStart: number, selectionEnd: number) => {
    // Browsers can emit select after a handled arrow key even though the caret
    // did not move. Do not reset the user's highlighted command on that event
    // (or reopen a menu just dismissed with Escape).
    const previous = slashSelectionRef.current;
    if (previous?.value === value && previous.start === selectionStart && previous.end === selectionEnd) return;
    slashSelectionRef.current = { value, start: selectionStart, end: selectionEnd };
    const nextContext = getComposerSlashContext(value, selectionStart, selectionEnd);
    setSlashContext(nextContext);
    setSlashActiveIndex(0);
  };

  const slashCommands = slashContext
    ? findComposerSlashCommands(slashContext.query, { includeExtended: true })
    : [];
  const slashMenuOpen = Boolean(slashContext && slashCommands.length > 0);

  const applySlashCommand = (command: ComposerSlashCommand, context: ComposerSlashContext | null = slashContext) => {
    if (!context) return false;
    const change = applyComposerSlashCommand(
      conversation.draft,
      context.slashEnd,
      context.slashEnd,
      command.id,
    );
    if (!change.handled) return false;
    draftHistory.update(change.value, "format");
    clearLargePastePreview();
    setSlashContext(null);
    setSlashActiveIndex(0);
    setEditorSelection({ start: change.selectionStart, end: change.selectionEnd });
    setComposerNotice(`${command.label} inserted.`);
    window.requestAnimationFrame(() => {
      const nextTextarea = textareaRef.current;
      if (!nextTextarea) return;
      nextTextarea.focus();
      nextTextarea.setSelectionRange(change.selectionStart, change.selectionEnd);
    });
    return true;
  };

  const announceComposerNotice = (message: string) => {
    setComposerNotice(message);
    setFormatMenuOpen(false);
  };

  const applyDraftHistoryShortcut = (action: "undo" | "redo") => {
    const textarea = textareaRef.current;
    const selectionStart = textarea?.selectionStart ?? conversation.draft.length;
    const selectionEnd = textarea?.selectionEnd ?? selectionStart;
    const canApply = action === "undo" ? draftHistory.canUndo : draftHistory.canRedo;
    if (!canApply) return false;

    if (action === "undo") draftHistory.undo();
    else draftHistory.redo();

    setComposerNotice(
      `${action === "undo" ? "Undo" : "Redo"} applied to this renderer-session draft.`,
    );
    window.requestAnimationFrame(() => {
      const nextTextarea = textareaRef.current;
      if (!nextTextarea) return;
      nextTextarea.focus();
      const nextStart = Math.min(selectionStart, nextTextarea.value.length);
      const nextEnd = Math.min(selectionEnd, nextTextarea.value.length);
      nextTextarea.setSelectionRange(nextStart, nextEnd);
      syncEditorSelection(nextTextarea);
    });
    return true;
  };

  const toggleMediaKind = (kind: ComposerMediaKind) => {
    if (activeRun || attachmentPickerBusy) return;
    setSelectedMediaKinds((current) =>
      current.includes(kind)
        ? current.filter((item) => item !== kind)
        : [...current, kind],
    );
    const label = kind === "image" ? "Image" : kind === "video" ? "Video" : "Audio";
    announceComposerNotice(
      `${label} input preview ${selectedMediaKinds.includes(kind) ? "removed" : "queued"}. No file was read or uploaded.`,
    );
  };

  const syncEditorSelection = (textarea: HTMLTextAreaElement) => {
    const nextSelection = { start: textarea.selectionStart, end: textarea.selectionEnd };
    editorSelectionRef.current = nextSelection;
    setEditorSelection(nextSelection);
  };

  /**
   * Toolbar clicks intentionally keep focus in the textarea, but browser
   * event ordering can still collapse the live DOM selection before the
   * button's click handler runs.  Prefer the last selection observed from
   * select/key events when the live range has collapsed, so Bold/Italic/list
   * actions wrap the text the user actually selected instead of appending a
   * fallback phrase.
   */
  const readComposerSelection = (textarea: HTMLTextAreaElement | null, fallbackPosition = conversation.draft.length) => {
    const liveStart = textarea?.selectionStart ?? fallbackPosition;
    const liveEnd = textarea?.selectionEnd ?? liveStart;
    const snapshot = editorSelectionRef.current;
    const valueLength = textarea?.value.length ?? conversation.draft.length;
    const snapshotValid = snapshot.start >= 0
      && snapshot.end >= snapshot.start
      && snapshot.end <= valueLength;
    if (liveStart === liveEnd && snapshotValid && snapshot.start !== snapshot.end) {
      return snapshot;
    }
    return { start: liveStart, end: liveEnd };
  };

  const jumpToComposerBlock = (block: ComposerPreviewBlock, index: number) => {
    const content = conversation.draft;
    if (!block.source) return;

    // Duplicate blocks are resolved by their outline occurrence, so clicking
    // the second identical paragraph does not always jump to the first one.
    const analysis = analyzeComposerPreview(content);
    const duplicateIndex = analysis.blocks
      .slice(0, index)
      .filter((candidate) => candidate.source === block.source)
      .length;
    let cursor = 0;
    let start = -1;
    for (let occurrence = 0; occurrence <= duplicateIndex; occurrence += 1) {
      start = content.indexOf(block.source, cursor);
      if (start < 0) break;
      cursor = start + block.source.length;
    }
    if (start < 0) return;

    if (composerView === "preview") setComposerView("write");
    setEditorSelection({ start, end: start + block.source.length });
    setComposerNotice(`Selected ${block.title ?? block.detail ?? block.kind.replace("-", " ")} in the source editor.`);
    window.requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(start, start + block.source.length);
    });
  };

  const replaceComposerBlock = (block: ComposerPreviewBlock, index: number, replacement: string) => {
    const content = conversation.draft;
    if (!block.source) return;

    const analysis = analyzeComposerPreview(content);
    const duplicateIndex = analysis.blocks
      .slice(0, index)
      .filter((candidate) => candidate.source === block.source)
      .length;
    let cursor = 0;
    let start = -1;
    for (let occurrence = 0; occurrence <= duplicateIndex; occurrence += 1) {
      start = content.indexOf(block.source, cursor);
      if (start < 0) break;
      cursor = start + block.source.length;
    }
    if (start < 0) return;

    const nextValue = `${content.slice(0, start)}${replacement}${content.slice(start + block.source.length)}`;
    draftHistory.update(nextValue, "format");
    clearLargePastePreview();
    const nextCursor = start + replacement.length;
    setEditorSelection({ start: nextCursor, end: nextCursor });
    setComposerNotice("Block replacement applied to this renderer-session draft.");
    window.requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(nextCursor, nextCursor);
    });
  };

  // The DOM selection is the source of truth while applying a command, but
  // toolbar state should render from the selection snapshot we update with
  // each formatter action. Reading the textarea ref during render can lag one
  // React turn behind a controlled draft update and make an active list look
  // inactive immediately after clicking its toggle.
  const editorValue = conversation.draft;
  const selectionStart = editorSelection.start;
  const selectionEnd = editorSelection.end;
  const inlineFormatIsActive = (marker: "**" | "*" | "~~" | "`") =>
    isMarkdownInlineActive(editorValue, selectionStart, selectionEnd, marker);

  return (
    <section className="composer-region composer-region--review" aria-label="Message composer">
      <div
        className={`composer-shell${fileDragActive ? " composer-shell--file-drag-active" : ""}`}
        onDragEnter={handleFileDragEnter}
        onDragLeave={handleFileDragLeave}
        onDragOver={handleFileDragOver}
        onDrop={handleFileDrop}
      >
        {fileDragActive ? (
          <div className="composer-file-drop-overlay" role="status" aria-live="polite">
            <strong>Drop files to preview</strong>
            <span>Browser-only · not uploaded, stored, or sent</span>
          </div>
        ) : null}
        {preflightError ? (
          <div className="composer-preflight-error" role="alert">
            <AlertTriangle size={15} />
            <span>
              <strong>Request blocked before dispatch</strong>
              <small>{preflightError}</small>
            </span>
            <button type="button" onClick={() => setPreflightError(null)} aria-label="Dismiss parameter error" title="Dismiss parameter error">
              <X size={13} />
            </button>
          </div>
        ) : null}
        {largePasteNotice ? (
          largePasteAssessment ? (
            <ComposerPastePreview
              assessment={largePasteAssessment}
              notice={largePasteNotice}
              onDismiss={() => {
                setLargePasteNotice(null);
                setLargePasteAssessment(null);
              }}
            />
          ) : (
            <div className="composer-paste-notice" role="status" aria-live="polite">
              <AlertTriangle size={15} aria-hidden="true" />
              <span>
                <strong>Paste retained inline</strong>
                <small>{largePasteNotice}</small>
              </span>
              <button
                type="button"
                onClick={() => setLargePasteNotice(null)}
                aria-label="Dismiss large paste notice"
                title="Dismiss large paste notice"
              >
                <X size={13} />
              </button>
            </div>
          )
        ) : null}
        {voiceState === "listening" ? (
          <div className="composer-voice-status" role="status" aria-live="polite">
            <Mic size={14} aria-hidden="true" />
            <span>Listening… speak naturally. Press the microphone button to stop.</span>
          </div>
        ) : null}
        {voiceError ? (
          <div className="composer-voice-error" role="alert">
            <AlertTriangle size={15} aria-hidden="true" />
            <span>{voiceError}</span>
            <button
              type="button"
              onClick={() => {
                setVoiceError(null);
                setVoiceState("idle");
              }}
              aria-label="Dismiss voice input message"
              title="Dismiss voice input message"
            >
              <X size={13} />
            </button>
          </div>
        ) : null}
        {conversation.temporary ? (
          <div
            className="composer-temporary-notice"
            role="status"
            aria-label="Temporary Chat preview policy"
          >
            <strong>Temporary Chat preview</strong>
            <span>Native retention, deletion, and history isolation are planned; this marker does not enforce them yet.</span>
          </div>
        ) : null}
        <ComposerAttachmentTray
          attachments={composerAttachments}
          onRemove={(attachmentId) => void removeAttachment(attachmentId)}
          disabled={Boolean(activeRun) || attachmentPickerBusy}
          boundaryMessage={browserPreviewAttachments.length > 0
            ? "Preview only. These files stay in this tab; remove them to send a text-only message."
            : undefined}
        />
        <SelectionReferenceTray />
        {advancedInputsOpen ? (
          <div className="composer-advanced-inputs" id="composer-advanced-inputs" aria-label="Optional chat inputs">
            <ComposerAttachmentCompatibility attachments={composerAttachments} route={route} />
            <ComposerAttachmentAdmissionReview attachments={composerAttachments} route={route} />
            <ComposerMediaPreview
              disabled={Boolean(activeRun) || attachmentPickerBusy}
              selectedKinds={selectedMediaKinds}
              onSelectionChange={setSelectedMediaKinds}
            />
            <ComposerDraftStudio
              conversationId={conversation.id}
              draft={conversation.draft}
              controller={draftHistory}
              disabled={false}
              initiallyExpanded={false}
            />
          </div>
        ) : null}
        <div className="composer-editor-bar" aria-label="Composer view and formatting" hidden={!advancedInputsOpen}>
          <div className="composer-editor-tabs" role="tablist" aria-label="Draft view">
            <button
              type="button"
              role="tab"
              id="composer-write-tab"
              aria-selected={composerView === "write"}
              aria-controls="composer-write-panel"
              className={composerView === "write" ? "composer-editor-tab composer-editor-tab--active" : "composer-editor-tab"}
              title="Edit Markdown source"
              onClick={() => setComposerView("write")}
            >
              <PencilLine size={13} />
              Write
            </button>
            <button
              type="button"
              role="tab"
              id="composer-split-tab"
              aria-selected={composerView === "split"}
              aria-controls="composer-split-panel"
              className={composerView === "split" ? "composer-editor-tab composer-editor-tab--active" : "composer-editor-tab"}
              title="Edit source and preview side by side"
              onClick={() => setComposerView("split")}
            >
              <SplitSquareHorizontal size={13} />
              Split
            </button>
            <button
              type="button"
              role="tab"
              id="composer-preview-tab"
              aria-selected={composerView === "preview"}
              aria-controls="composer-preview-panel"
              className={composerView === "preview" ? "composer-editor-tab composer-editor-tab--active" : "composer-editor-tab"}
              title="Preview rendered Markdown"
              onClick={() => setComposerView("preview")}
            >
              <Eye size={13} />
              Preview
            </button>
          </div>
          <span className="composer-editor-meta">
            <span className="composer-editor-badge">Markdown</span>
            <span>{conversation.draft.length.toLocaleString()} chars</span>
          </span>
        </div>
        {composerView !== "preview" ? (
          <div
            id={composerView === "split" ? "composer-split-panel" : "composer-write-panel"}
            className={composerView === "split" ? "composer-editor-layout composer-editor-layout--split" : "composer-editor-layout"}
            role="tabpanel"
            aria-labelledby={composerView === "split" ? "composer-split-tab" : "composer-write-tab"}
            aria-label={composerView === "split" ? "Split draft editor" : "Draft editor"}
          >
            <section className="composer-editor-layout__write" aria-label="Markdown source editor">
            <div className="composer-format-strip" role="toolbar" aria-label="Formatting tools" hidden={!advancedInputsOpen}>
              <button type="button" className={inlineFormatIsActive("**") ? "composer-format-button composer-format-button--active" : "composer-format-button"} title="Bold (Ctrl/Cmd+B)" aria-label="Bold" aria-pressed={inlineFormatIsActive("**")} aria-keyshortcuts="Control+B Meta+B" onMouseDown={(event) => event.preventDefault()} onClick={() => applyInlineComposerFormat("**", "bold text")}>
                <Bold size={15} />
              </button>
              <button type="button" className={inlineFormatIsActive("*") ? "composer-format-button composer-format-button--active" : "composer-format-button"} title="Italic (Ctrl/Cmd+I)" aria-label="Italic" aria-pressed={inlineFormatIsActive("*")} aria-keyshortcuts="Control+I Meta+I" onMouseDown={(event) => event.preventDefault()} onClick={() => applyInlineComposerFormat("*", "italic text")}>
                <Italic size={15} />
              </button>
              <button type="button" className={inlineFormatIsActive("~~") ? "composer-format-button composer-format-button--active" : "composer-format-button"} title="Strikethrough (Ctrl/Cmd+Shift+X)" aria-label="Strikethrough" aria-pressed={inlineFormatIsActive("~~")} aria-keyshortcuts="Control+Shift+X Meta+Shift+X" onMouseDown={(event) => event.preventDefault()} onClick={() => applyInlineComposerFormat("~~", "strikethrough text")}>
                <Strikethrough size={15} />
              </button>
              <button type="button" className={inlineFormatIsActive("`") ? "composer-format-button composer-format-button--active" : "composer-format-button"} title="Inline code" aria-label="Inline code" aria-pressed={inlineFormatIsActive("`")} onMouseDown={(event) => event.preventDefault()} onClick={() => applyInlineComposerFormat("`", "code")}>
                <Code2 size={15} />
              </button>
              <button type="button" className="composer-format-button" title="Insert link" aria-label="Insert link" onMouseDown={(event) => event.preventDefault()} onClick={applyMarkdownLink}>
                <Link2 size={15} />
              </button>
              <button type="button" className={isMarkdownListActive(editorValue, selectionStart, selectionEnd, "bullet") ? "composer-format-button composer-format-button--active" : "composer-format-button"} title="Bullet list" aria-label="Bullet list" aria-pressed={isMarkdownListActive(editorValue, selectionStart, selectionEnd, "bullet")} onMouseDown={(event) => event.preventDefault()} onClick={() => applyListComposerFormat("bullet")}>
                <List size={15} />
              </button>
              <button type="button" className={isMarkdownListActive(editorValue, selectionStart, selectionEnd, "numbered") ? "composer-format-button composer-format-button--active" : "composer-format-button"} title="Numbered list" aria-label="Numbered list" aria-pressed={isMarkdownListActive(editorValue, selectionStart, selectionEnd, "numbered")} onMouseDown={(event) => event.preventDefault()} onClick={() => applyListComposerFormat("numbered")}>
                <ListOrdered size={15} />
              </button>
              <button type="button" className={isMarkdownListActive(editorValue, selectionStart, selectionEnd, "lettered") ? "composer-format-button composer-format-button--active" : "composer-format-button"} title="Lettered list" aria-label="Lettered list" aria-pressed={isMarkdownListActive(editorValue, selectionStart, selectionEnd, "lettered")} onMouseDown={(event) => event.preventDefault()} onClick={() => applyListComposerFormat("lettered")}>
                <span className="composer-format-letter-icon" aria-hidden="true">a.</span>
              </button>
              <button type="button" className={isMarkdownListActive(editorValue, selectionStart, selectionEnd, "checklist") ? "composer-format-button composer-format-button--active" : "composer-format-button"} title="Checklist" aria-label="Checklist" aria-pressed={isMarkdownListActive(editorValue, selectionStart, selectionEnd, "checklist")} onMouseDown={(event) => event.preventDefault()} onClick={() => applyListComposerFormat("checklist")}>
                <ListChecks size={15} />
              </button>
              <button type="button" className={isMarkdownLinePrefixActive(editorValue, selectionStart, selectionEnd, "> ") ? "composer-format-button composer-format-button--active" : "composer-format-button"} title="Blockquote" aria-label="Blockquote" aria-pressed={isMarkdownLinePrefixActive(editorValue, selectionStart, selectionEnd, "> ")} onMouseDown={(event) => event.preventDefault()} onClick={() => applyLinePrefixComposerFormat("> ")}>
                <Quote size={15} />
              </button>
              <button type="button" className="composer-format-button" title="Indent selection" aria-label="Indent selection" onMouseDown={(event) => event.preventDefault()} onClick={() => {
                const textarea = textareaRef.current;
                if (!textarea) return;
                applyEditorChange(indentMarkdownSelection(textarea.value, textarea.selectionStart, textarea.selectionEnd, "indent"));
              }}>
                <IndentIncrease size={15} />
              </button>
              <button type="button" className="composer-format-button" title="Outdent selection" aria-label="Outdent selection" onMouseDown={(event) => event.preventDefault()} onClick={() => {
                const textarea = textareaRef.current;
                if (!textarea) return;
                applyEditorChange(indentMarkdownSelection(textarea.value, textarea.selectionStart, textarea.selectionEnd, "outdent"));
              }}>
                <IndentDecrease size={15} />
              </button>
              <span className="composer-format-divider" aria-hidden="true" />
              <div className="popover-anchor">
                <button
                  type="button"
                  className={formatMenuOpen ? "composer-format-button composer-format-button--active" : "composer-format-button"}
                  title="More formatting"
                  aria-label="More formatting"
                  aria-expanded={formatMenuOpen}
                  aria-controls={formatMenuOpen ? "composer-format-menu" : undefined}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    setFormatMenuOpen((value) => !value);
                    setBlockStudioOpen(false);
                    setModeMenuOpen(false);
                    setModeControlsOpen(false);
                    setContextPreflightOpen(false);
                  }}
                >
                  <Braces size={15} />
                  <span className="composer-format-button__label">More</span>
                  <ChevronDown size={11} />
                </button>
                {formatMenuOpen ? (
                  <div id="composer-format-menu" className="composer-popover composer-format-menu" role="menu" aria-label="More Markdown formatting">
                    <div className="composer-format-menu__header">
                      <span>
                        <strong>More formatting</strong>
                        <small>Markdown blocks and math</small>
                      </span>
                      <button
                        type="button"
                        className="composer-format-menu__close"
                        aria-label="Close more formatting"
                        title="Close more formatting"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => setFormatMenuOpen(false)}
                      >
                        <X size={14} aria-hidden="true" />
                      </button>
                    </div>
                    <div className="composer-format-menu__group" role="group" aria-label="Heading levels">
                      <span className="composer-format-menu__group-label"><Heading2 size={13} aria-hidden="true" /><strong>Heading level</strong><small>Apply to selected lines</small></span>
                      <div className="composer-format-menu__heading-grid">
                        {([1, 2, 3, 4, 5, 6] as const).map((level) => (
                          <button
                            key={`heading-${level}`}
                            type="button"
                            role="menuitem"
                            aria-label={`Heading ${level}`}
                            title={`Apply heading level ${level}`}
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => applyHeadingLevel(level)}
                          >
                            <strong>H{level}</strong>
                            <small>{level === 1 ? "Page" : level === 2 ? "Section" : "Subsection"}</small>
                          </button>
                        ))}
                      </div>
                    </div>
                    <button type="button" role="menuitem" title="Insert a fenced Markdown code block" onMouseDown={(event) => event.preventDefault()} onClick={() => insertComposerSnippet("```text\n", "\n```", "code block")}>
                      <span><strong>Code block</strong><small>Fenced Markdown block</small></span>
                    </button>
                    <button type="button" role="menuitem" title="Insert a block LaTeX equation" onMouseDown={(event) => event.preventDefault()} onClick={() => insertComposerSnippet("$$\n", "\n$$", "x = y")}>
                      <span><strong>LaTeX equation</strong><small>Math notation preview</small></span>
                    </button>
                    <button type="button" role="menuitem" title="Insert inline LaTeX math" onMouseDown={(event) => event.preventDefault()} onClick={() => insertComposerSnippet("$", "$", "x^2")}>
                      <span><strong>Inline LaTeX</strong><small>Inline math in a sentence</small></span>
                    </button>
                    <button type="button" role="menuitem" title="Insert a Markdown horizontal rule" onMouseDown={(event) => event.preventDefault()} onClick={() => insertComposerBlock("---")}>
                      <span><strong>Horizontal rule</strong><small>Visual section divider</small></span>
                    </button>
                    <button type="button" role="menuitem" title="Insert a Markdown table starter" onMouseDown={(event) => event.preventDefault()} onClick={() => insertComposerBlock("| Column | Value |\n| --- | --- |\n| Item | Detail |")}>
                      <span><strong>Table starter</strong><small>GitHub-flavored Markdown table</small></span>
                    </button>
                  </div>
                ) : null}
              </div>
              <div className="popover-anchor">
                <button
                  type="button"
                  className={blockStudioOpen ? "composer-format-button composer-format-button--active" : "composer-format-button"}
                  title="Block insert studio"
                  aria-label="Block insert studio"
                  aria-expanded={blockStudioOpen}
                  aria-controls={blockStudioOpen ? "composer-block-insert-studio" : undefined}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    setBlockStudioOpen((value) => !value);
                    setFormatMenuOpen(false);
                    setModeMenuOpen(false);
                    setModeControlsOpen(false);
                    setContextPreflightOpen(false);
                  }}
                >
                  <Plus size={15} />
                  <span className="composer-format-button__label">Blocks</span>
                </button>
                {blockStudioOpen ? (
                  <ComposerBlockInsertStudio
                    id="composer-block-insert-studio"
                    disabled={Boolean(activeRun)}
                    onClose={() => setBlockStudioOpen(false)}
                    onInsert={(block) => {
                      insertComposerBlock(block);
                      setComposerNotice("Block inserted from the renderer-local studio.");
                    }}
                  />
                ) : null}
              </div>
              <span className="composer-format-spacer" />
              <button
                type="button"
                className={`composer-format-button composer-format-button--media${selectedMediaKinds.includes("image") ? " composer-format-button--active" : ""}`}
                title="Image input preview"
                aria-label="Image input preview"
                aria-pressed={selectedMediaKinds.includes("image")}
                disabled={Boolean(activeRun) || attachmentPickerBusy}
                onClick={() => toggleMediaKind("image")}
              >
                <Image size={15} />
              </button>
              <button
                type="button"
                className={`composer-format-button composer-format-button--media${selectedMediaKinds.includes("video") ? " composer-format-button--active" : ""}`}
                title="Video input preview"
                aria-label="Video input preview"
                aria-pressed={selectedMediaKinds.includes("video")}
                disabled={Boolean(activeRun) || attachmentPickerBusy}
                onClick={() => toggleMediaKind("video")}
              >
                <Video size={15} />
              </button>
              <button
                type="button"
                className={`composer-format-button composer-format-button--media${selectedMediaKinds.includes("audio") ? " composer-format-button--active" : ""}`}
                title="Audio input preview"
                aria-label="Audio input preview"
                aria-pressed={selectedMediaKinds.includes("audio")}
                disabled={Boolean(activeRun) || attachmentPickerBusy}
                onClick={() => toggleMediaKind("audio")}
              >
                <Music2 size={15} />
              </button>
              <ComposerEditorWorkbench
                draft={conversation.draft}
                selectionStart={editorSelection.start}
                selectionEnd={editorSelection.end}
                preferences={editorPreferences}
                onPreferencesChange={setEditorPreferences}
                onResetPreferences={() => setEditorPreferences(DEFAULT_COMPOSER_EDITOR_PREFERENCES)}
              />
            </div>
            {composerNotice ? (
              <div className={advancedInputsOpen ? "composer-format-notice" : "review-composer-sr-only"} role="status" aria-live="polite">
                <span>{composerNotice}</span>
                <button type="button" onClick={() => setComposerNotice(null)} aria-label="Dismiss composer notice" title="Dismiss composer notice">
                  <X size={13} />
                </button>
              </div>
            ) : null}
            <textarea
              ref={textareaRef}
              spellCheck={editorPreferences.spellCheck}
              wrap={editorPreferences.wrap === "soft" ? "soft" : "off"}
              className={editorPreferences.wrap === "off" ? "composer-textarea composer-textarea--no-wrap" : "composer-textarea"}
              value={conversation.draft}
              onChange={(event) => {
                setHistoryRecallIndex(null);
                draftHistory.update(event.target.value, "typing");
                clearLargePastePreview();
                if (voiceState !== "listening") voiceDraftBaseRef.current = event.target.value;
                syncSlashMenu(event.target.value, event.target.selectionStart, event.target.selectionEnd);
                syncEditorSelection(event.currentTarget);
              }}
              onPaste={handlePaste}
              onSelect={(event) => {
                syncSlashMenu(event.currentTarget.value, event.currentTarget.selectionStart, event.currentTarget.selectionEnd);
                syncEditorSelection(event.currentTarget);
              }}
              onBlur={() => { setSlashContext(null); slashSelectionRef.current = null; }}
              onKeyUp={(event) => syncEditorSelection(event.currentTarget)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;

                if ((event.ctrlKey || event.metaKey) && !event.altKey) {
                  const shortcut = event.key.toLowerCase();
                  if (shortcut === "z") {
                    event.preventDefault();
                    applyDraftHistoryShortcut(event.shiftKey ? "redo" : "undo");
                    return;
                  }
                  if (shortcut === "y" && !event.shiftKey) {
                    event.preventDefault();
                    applyDraftHistoryShortcut("redo");
                    return;
                  }
                  if (!event.shiftKey && (shortcut === "b" || shortcut === "i")) {
                    event.preventDefault();
                    applyInlineComposerFormat(shortcut === "b" ? "**" : "*", shortcut === "b" ? "bold text" : "italic text");
                    return;
                  }
                  if (event.shiftKey && shortcut === "x") {
                    event.preventDefault();
                    applyInlineComposerFormat("~~", "strikethrough text");
                    return;
                  }
                }

                const currentContext = getComposerSlashContext(
                  event.currentTarget.value,
                  event.currentTarget.selectionStart,
                  event.currentTarget.selectionEnd,
                );
                const currentCommands = currentContext
                  ? findComposerSlashCommands(currentContext.query, { includeExtended: true })
                  : [];

                if (slashMenuOpen && currentContext && currentCommands.length > 0) {
                  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault();
                    setSlashContext(currentContext);
                    setSlashActiveIndex((current) => {
                      const delta = event.key === "ArrowDown" ? 1 : -1;
                      return (current + delta + currentCommands.length) % currentCommands.length;
                    });
                    return;
                  }

                  if (event.key === "Escape") {
                    event.preventDefault();
                    setSlashContext(null);
                    setSlashActiveIndex(0);
                    return;
                  }
                  if (event.key === "Enter" || event.key === "Tab") {
                    event.preventDefault();
                    const selected = currentCommands[Math.min(slashActiveIndex, currentCommands.length - 1)];
                    if (selected) applySlashCommand(selected, currentContext);
                    return;
                  }
                }

                if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                  const liveHistory = collectCrossAgentPromptHistory(
                    allConversations,
                    crossAgentPromptHistory,
                  );
                  if (
                    liveHistory.length > 0 &&
                    (event.currentTarget.value.trim() === "" || historyRecallIndex !== null)
                  ) {
                    event.preventDefault();
                    const recalled = recallCrossAgentPromptHistory({
                      history: liveHistory,
                      currentIndex: historyRecallIndex ?? -1,
                      direction: event.key === "ArrowUp" ? "up" : "down",
                      currentValue: event.currentTarget.value,
                      savedDraft: "",
                    });
                    if (recalled) {
                      setHistoryRecallIndex(recalled.nextHistoryIndex === -1 ? null : recalled.nextHistoryIndex);
                      draftHistory.update(recalled.nextValue, "typing");
                    }
                    return;
                  }
                }

                if (event.key === "Tab") {
                  event.preventDefault();
                  if (
                    !event.shiftKey &&
                    event.currentTarget.selectionStart === event.currentTarget.selectionEnd &&
                    !/^(?:\s*[-+*]|\s*\d+[.)]|\s*[A-Za-z]+[.)])/.test(event.currentTarget.value)
                  ) {
                    const liveSuggestion = computeLivePromptSuggestion(event.currentTarget.value);
                    if (liveSuggestion) {
                      draftHistory.update(`${event.currentTarget.value.trimEnd()} — ${liveSuggestion}`, "format");
                      return;
                    }
                  }
                  const change = indentMarkdownSelection(
                    event.currentTarget.value,
                    event.currentTarget.selectionStart,
                    event.currentTarget.selectionEnd,
                    event.shiftKey ? "outdent" : "indent",
                  );
                  applyEditorChange(change);
                  return;
                }

                if (event.key === "Enter" && !event.shiftKey) {
                  if (editorPreferences.autoContinue) {
                    const codeBlockChange = continueMarkdownCodeBlockAtSelection(
                      event.currentTarget.value,
                      event.currentTarget.selectionStart,
                      event.currentTarget.selectionEnd,
                    );
                    if (applyEditorChange(codeBlockChange)) {
                      event.preventDefault();
                      return;
                    }

                    const change = continueMarkdownListAtSelection(
                      event.currentTarget.value,
                      event.currentTarget.selectionStart,
                      event.currentTarget.selectionEnd,
                    );
                    if (applyEditorChange(change)) {
                      event.preventDefault();
                      return;
                    }
                  }

                  event.preventDefault();
                  void submit();
                }
              }}
              placeholder="Ask anything..."
              aria-label="Message Omnia"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={slashMenuOpen}
              aria-controls={slashMenuOpen ? "composer-slash-command-list" : undefined}
              aria-activedescendant={slashMenuOpen ? `composer-slash-option-${slashCommands[Math.min(slashActiveIndex, slashCommands.length - 1)]?.id}` : undefined}
              readOnly={voiceState === "listening"}
              rows={1}
            />
            {(() => {
              const liveSuggestion = slashMenuOpen
                ? null
                : computeLivePromptSuggestion(conversation.draft);
              if (!liveSuggestion) return null;
              return (
                <div className="composer-live-suggestion" data-testid="composer-live-prompt-suggestion">
                  <span className="composer-live-suggestion__text">Suggestion: {liveSuggestion}</span>
                  <button
                    type="button"
                    className="composer-live-suggestion__accept"
                    data-testid="composer-accept-suggestion-btn"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                      const nextDraft = liveSuggestion.startsWith(" + ")
                        ? `${conversation.draft}${liveSuggestion}`
                        : liveSuggestion;
                      draftHistory.update(nextDraft, "format");
                      setComposerNotice("Live prompt suggestion applied.");
                    }}
                  >
                    Apply
                  </button>
                </div>
              );
            })()}
            {slashMenuOpen ? (
              <div className="composer-slash-menu" id="composer-slash-command-list" role="listbox" aria-label="Draft commands">
                <div className="composer-slash-menu__header">
                  <span>Commands</span>
                  <kbd>Tab ↵</kbd>
                </div>
                <div className="composer-slash-menu__options">
                  {slashCommands.map((command, index) => (
                    <div
                      key={command.id}
                      id={`composer-slash-option-${command.id}`}
                      role="option"
                      aria-selected={index === slashActiveIndex}
                      className={index === slashActiveIndex ? "composer-slash-option composer-slash-option--active" : "composer-slash-option"}
                      onMouseDown={(event) => event.preventDefault()}
                      onMouseEnter={() => setSlashActiveIndex(index)}
                      onClick={() => applySlashCommand(command)}
                    >
                      <span className="composer-slash-option__command">{command.command}</span>
                      <span className="composer-slash-option__copy">
                        <strong>{command.label}</strong>
                        <small>{command.description}</small>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
            </section>
            {composerView === "split" ? (
              <section className="composer-editor-layout__preview" aria-label="Live split preview">
                <ComposerRichPreview content={conversation.draft} onBlockSelect={jumpToComposerBlock} onBlockReplace={replaceComposerBlock} />
              </section>
            ) : null}
          </div>
        ) : (
          <div id="composer-preview-panel" className="composer-preview" role="tabpanel" aria-labelledby="composer-preview-tab" aria-label="Draft preview">
            <ComposerRichPreview content={conversation.draft} onBlockSelect={jumpToComposerBlock} onBlockReplace={replaceComposerBlock} />
          </div>
        )}
        <div className="review-composer-extra-controls" hidden={!advancedInputsOpen} aria-label="Additional composer controls">
            <button type="button" className="composer-tool" aria-label={contextPreflightOpen ? "Hide context preflight" : "Context preflight"} title="Context preflight" aria-expanded={contextPreflightOpen} aria-controls="composer-context-preflight" onClick={() => { setContextPreflightOpen((open) => !open); setFormatMenuOpen(false); setBlockStudioOpen(false); setModeMenuOpen(false); setModeControlsOpen(false); }}>
              <Layers3 size={15} strokeWidth={1.75} aria-hidden="true" />
            </button>
            <div className="popover-anchor" ref={modeMenuAnchorRef}>
              <button
                type="button"
                ref={modeTriggerRef}
                className={modeMenuOpen ? "composer-select composer-select--active" : "composer-select"}
                aria-label="Choose composer mode"
                title={`Composer mode: ${modeDefinition.label}`}
                aria-haspopup="menu"
                aria-expanded={modeMenuOpen}
                aria-controls={modeMenuOpen ? "composer-mode-menu" : undefined}
                onClick={() => {
                  setModeMenuOpen((open) => !open);
                  setModeControlsOpen(false);
                  setFormatMenuOpen(false);
                  setBlockStudioOpen(false);
                  setContextPreflightOpen(false);
                }}
              >
                {modeDefinition.icon}
                {modeDefinition.label}
                <ChevronDown size={11} />
              </button>
              {modeMenuOpen ? (
                <div id="composer-mode-menu" className="composer-popover composer-mode-menu" role="menu" aria-label="Composer modes">
                  {([
                    ["ask", "Ask", "Normal text conversation", CircleHelp],
                    ["create", "Create", "Drafting preview · native execution planned", FilePlus2],
                    ["research", "Research", "Research preview · retrieval planned", Search],
                    ["discuss", "Discuss", "Multi-perspective preview · orchestration planned", MessageCircleMore],
                  ] as const).map(([mode, label, description, Icon]) => (
                    <button
                      key={mode}
                      type="button"
                      role="menuitemradio"
                      aria-checked={composerMode === mode}
                      className={composerMode === mode ? "composer-mode-option composer-mode-option--active" : "composer-mode-option"}
                      title={`${label} mode: ${description}`}
                      onKeyDown={(event) => {
                        const options = modeMenuAnchorRef.current
                          ? Array.from(modeMenuAnchorRef.current.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'))
                          : [];
                        const currentIndex = options.indexOf(event.currentTarget);
                        if (event.key === "Escape") {
                          event.preventDefault();
                          setModeMenuOpen(false);
                          modeTriggerRef.current?.focus({ preventScroll: true });
                          return;
                        }
                        if (currentIndex < 0 || options.length === 0) return;
                        let nextIndex: number | null = null;
                        if (event.key === "ArrowDown" || event.key === "ArrowRight") nextIndex = (currentIndex + 1) % options.length;
                        if (event.key === "ArrowUp" || event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + options.length) % options.length;
                        if (event.key === "Home") nextIndex = 0;
                        if (event.key === "End") nextIndex = options.length - 1;
                        if (nextIndex === null) return;
                        event.preventDefault();
                        options[nextIndex]?.focus({ preventScroll: true });
                      }}
                    onClick={() => {
                      setComposerMode(mode);
                      setModeMenuOpen(false);
                      setModeControlsOpen(false);
                      if (mode !== "ask") setComposerNotice(`${label} mode is a renderer preview; return to Ask to send.`);
                      else setComposerNotice("Ask mode is ready for the current preview.");
                      }}
                    >
                      <Icon size={14} aria-hidden="true" />
                      <span><strong>{label}</strong><small>{description}</small></span>
                    </button>
                  ))}
                </div>
              ) : null}
              <button
                type="button"
                ref={modeControlsTriggerRef}
                className={modeControlsOpen ? "composer-tool composer-tool--active composer-mode-controls-trigger" : "composer-tool composer-mode-controls-trigger"}
                aria-label="Open mode controls"
                title="Tune the selected mode (renderer preview)"
                aria-haspopup="dialog"
                aria-expanded={modeControlsOpen}
              aria-controls="composer-mode-controls"
                onClick={() => {
                  setModeControlsOpen((open) => !open);
                  setModeMenuOpen(false);
                  setFormatMenuOpen(false);
                  setBlockStudioOpen(false);
                  setContextPreflightOpen(false);
                }}
              >
                <SlidersHorizontal size={15} />
              </button>
              <div
                id="composer-mode-controls"
                className="composer-popover composer-mode-controls-popover"
                role="dialog"
                aria-label="Composer mode controls"
                hidden={!modeControlsOpen}
              >
                <ComposerModeControlsPreview mode={composerMode} onClose={() => setModeControlsOpen(false)} />
              </div>
            </div>
            <button
              type="button"
              className={`composer-scope-chip composer-scope-chip--${contextAvailability?.tone ?? (contextProjectMissing ? "danger" : "neutral")}`}
              aria-label={`Context scope: ${contextScopeLabel}`}
              aria-expanded={contextPreflightOpen}
              aria-controls="composer-context-preflight"
              title={contextScopeTitle}
              onClick={() => {
                setContextPreflightOpen((value) => !value);
                setFormatMenuOpen(false);
                setBlockStudioOpen(false);
                setModeMenuOpen(false);
                setModeControlsOpen(false);
              }}
            >
              <Layers3 size={14} aria-hidden="true" />
              <span className="composer-scope-chip__copy">
                <strong>{contextScopeLabel}</strong>
                <small>{contextScopeStatus}</small>
              </span>
              <ChevronDown className={contextPreflightOpen ? "composer-scope-chip__chevron composer-scope-chip__chevron--open" : "composer-scope-chip__chevron"} size={11} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="composer-select"
              aria-label={`${enabledSkills.length} enabled skills`}
              title="Open Skills Studio"
              onClick={() => setActivity("skills")}
            >
              <ProductIcon name="skill" size={15} />
              {enabledSkills.length} skills
            </button>
            <button
              type="button"
              className="composer-select"
              data-testid="composer-advanced-enhance-prompt-btn"
              aria-label="Enhance prompt (advanced)"
              title="Rewrite draft into a structured prompt with explicit constraints and verification"
              onClick={() => {
                const enhanced = enhancePromptDraft(conversation.draft || "Analyze and verify the active workspace");
                draftHistory.update(enhanced, "format");
                setComposerNotice("Prompt enhanced with structured goal, constraints, and verification criteria.");
              }}
            >
              Enhance Prompt
            </button>
            <button
              type="button"
              className={automationsOpen ? "composer-select composer-select--active" : "composer-select"}
              data-testid="composer-automations-toggle"
              aria-label="Automations and schedule"
              title="Open Automations, Customizations, and Schedule"
              aria-expanded={automationsOpen}
              onClick={() => setAutomationsOpen((open) => !open)}
            >
              Automations ({scheduledJobs.filter((j) => j.enabled).length})
            </button>
            {voiceAvailable || voiceState === "listening" ? (
              <VoiceInputPreview
                available={voiceAvailable}
                state={voiceState}
                language={voiceLanguage}
                insertMode={voiceInsertMode}
                error={voiceError}
                onLanguageChange={setVoiceLanguage}
                onInsertModeChange={setVoiceInsertMode}
                onToggleListening={startVoiceInput}
              />
            ) : null}
        </div>
        <ComposerPromptAssistBar
          value={conversation.draft}
          onChange={(nextDraft) => draftHistory.update(nextDraft, "format")}
          disabled={Boolean(activeRun)}
          providers={providers.map((provider) => ({ id: provider.id, label: provider.name }))}
          providerId={routedModel?.connectionId ?? providers[0]?.id}
          providerLabel={routedModel?.providerName ?? providers[0]?.name}
          onProviderChange={(nextProviderId) => {
            const candidate = models.find(
              (model) => model.connectionId === nextProviderId || model.id.startsWith(`${nextProviderId}:`),
            );
            if (candidate) setModelProfile(candidate.id);
          }}
          modelLabel={selectedModel?.displayName ?? "Model"}
          effortLabel={parameters.reasoningEffort}
          testIdPrefix="composer"
        />
        <div className="composer-toolbar review-composer-footer">
          <div className="review-composer-footer__left">
            <div className="review-composer-attach-anchor" ref={attachMenuRef}>
              <input
                ref={browserAttachmentInputRef}
                type="file"
                accept="*/*"
                multiple
                hidden
                aria-label="Choose files for browser preview"
                disabled={Boolean(activeRun)}
                onChange={(event) => {
                  addBrowserPreviewFiles(Array.from(event.currentTarget.files ?? []));
                  event.currentTarget.value = "";
                }}
              />
              <button
                type="button"
                className="review-composer-icon"
                aria-label="Attach files"
                title="Attach files"
                aria-haspopup="menu"
                aria-expanded={attachMenuOpen}
                aria-controls={attachMenuOpen ? "composer-attach-menu" : undefined}
                disabled={attachmentPickerBusy}
                aria-busy={attachmentPickerBusy}
                onClick={() => setAttachMenuOpen((open) => !open)}
              >
                <Plus size={16} strokeWidth={1.75} aria-hidden="true" />
              </button>
              {attachMenuOpen ? (
                <div id="composer-attach-menu" className="review-composer-attach-menu" role="menu" aria-label="Composer tools">
                  <button type="button" role="menuitem" title="Attach files" disabled={Boolean(activeRun) || attachmentPickerBusy} onClick={() => { setAttachMenuOpen(false); void pickAttachments(); }}>
                    <FilePlus2 size={15} strokeWidth={1.75} aria-hidden="true" />
                    Attach files
                  </button>
                  <button type="button" role="menuitem" aria-label={advancedInputsOpen ? "Hide more composer tools" : "Show more composer tools"} title={advancedInputsOpen ? "Hide editor tools" : "Editor tools"} onClick={() => { setAdvancedInputsOpen((open) => !open); setAttachMenuOpen(false); }}>
                    <Settings2 size={15} strokeWidth={1.75} aria-hidden="true" />
                    {advancedInputsOpen ? "Hide editor tools" : "Editor tools"}
                  </button>
                  <button type="button" role="menuitem" title="Context preflight" onClick={() => { setContextPreflightOpen((open) => !open); setAttachMenuOpen(false); setFormatMenuOpen(false); setBlockStudioOpen(false); setModeMenuOpen(false); setModeControlsOpen(false); }}>
                    <Layers3 size={15} strokeWidth={1.75} aria-hidden="true" />
                    {contextPreflightOpen ? "Hide context preflight" : "Context preflight"}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    title="Enhance prompt"
                    onClick={() => {
                      const enhanced = enhancePromptDraft(conversation.draft || "Analyze and verify the active workspace");
                      draftHistory.update(enhanced, "format");
                      setComposerNotice("Prompt enhanced with structured goal, constraints, and verification criteria.");
                      setAttachMenuOpen(false);
                    }}
                  >
                    <PencilLine size={15} strokeWidth={1.75} aria-hidden="true" />
                    Enhance prompt
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    title="Automations and schedule"
                    onClick={() => {
                      setAutomationsOpen((open) => !open);
                      setAttachMenuOpen(false);
                    }}
                  >
                    <SlidersHorizontal size={15} strokeWidth={1.75} aria-hidden="true" />
                    Automations and schedule
                  </button>
                </div>
              ) : null}
            </div>
            <ComposerRouteControls
              providers={providers.map((provider) => ({ id: provider.id, label: provider.name }))}
              providerId={routedModel?.connectionId ?? providers[0]?.id}
              providerLabel={routedModel?.providerName ?? providers[0]?.name}
              onProviderChange={(nextProviderId) => {
                const candidate = models.find(
                  (model) => model.connectionId === nextProviderId || model.id.startsWith(`${nextProviderId}:`),
                );
                if (candidate) setModelProfile(candidate.id);
              }}
              models={models.map((model) => ({ id: model.id, label: model.displayName }))}
              modelId={selectedModel?.id ?? ""}
              onModelChange={setModelProfile}
              efforts={
                supportsProviderParameter(route, "reasoning")
                  ? [
                      { id: "off", label: "Off" },
                      { id: "low", label: "Low" },
                      { id: "medium", label: "Medium" },
                      { id: "high", label: "High" },
                      { id: "max", label: "Max" },
                    ]
                  : [{ id: "off", label: "Off" }]
              }
              effortId={supportsProviderParameter(route, "reasoning") ? parameters.reasoningEffort : "off"}
              effortLabel="Effort"
              effortDisabled={!supportsProviderParameter(route, "reasoning")}
              onEffortChange={(effort) => setParameter("reasoningEffort", effort as typeof parameters.reasoningEffort)}
              disabled={Boolean(activeRun)}
            />
          </div>
          <div className="review-composer-footer__right">
            {isThisConversationRunning ? (
              <button type="button" className="send-button send-button--stop" onClick={() => void stop()} aria-label="Stop response" title="Stop response">
                <Square size={13} strokeWidth={1.75} aria-hidden="true" />
                <span>Stop</span>
              </button>
            ) : (
              <button
                type="button"
                className="send-button"
                disabled={
                  !conversation.draft.trim() ||
                  activeRun !== null ||
                  attachmentSummary.blocksSubmission ||
                  composerMode !== "ask"
                }
                onClick={() => void submit()}
                aria-label="Send message"
                title="Send"
              >
                <Send size={14} strokeWidth={1.75} aria-hidden="true" />
                <span>Send</span>
              </button>
            )}
          </div>
        </div>
      </div>
      {automationsOpen ? (
        <div className="composer-automations-panel" data-testid="composer-automations-panel" aria-label="Automations, Customizations, and Schedule">
          <div className="composer-automations-panel__header">
            <strong>Automations, Customizations &amp; Schedule</strong>
            <button type="button" onClick={() => setAutomationsOpen(false)} aria-label="Close automations">
              Close
            </button>
          </div>
          <div className="composer-automations-panel__form">
            <input
              type="text"
              value={scheduleCron}
              onChange={(event) => setScheduleCron(event.target.value)}
              placeholder="*/15 * * * *"
              aria-label="Cron schedule expression"
              data-testid="composer-schedule-cron-input"
            />
            <input
              type="text"
              value={schedulePrompt}
              onChange={(event) => setSchedulePrompt(event.target.value)}
              placeholder="Scheduled prompt or automation task..."
              aria-label="Scheduled automation prompt"
              data-testid="composer-schedule-prompt-input"
            />
            <button
              type="button"
              data-testid="composer-schedule-add-btn"
              onClick={() => {
                const trimmed = (schedulePrompt || conversation.draft).trim();
                if (!trimmed) return;
                setScheduledJobs((prev) => [
                  ...prev,
                  {
                    id: createId("sched"),
                    cron: scheduleCron.trim() || "*/15 * * * *",
                    prompt: trimmed,
                    enabled: true,
                  },
                ]);
                setSchedulePrompt("");
              }}
            >
              Add Schedule
            </button>
          </div>
          <div className="composer-automations-panel__jobs" data-testid="composer-scheduled-jobs-list">
            {scheduledJobs.map((job) => (
              <div key={job.id} className="composer-automations-panel__job" data-testid={`scheduled-job-${job.id}`}>
                <code>{job.cron}</code>
                <span>{job.prompt}</span>
                <button
                  type="button"
                  onClick={() =>
                    setScheduledJobs((prev) =>
                      prev.map((candidate) =>
                        candidate.id === job.id ? { ...candidate, enabled: !candidate.enabled } : candidate,
                      ),
                    )
                  }
                >
                  {job.enabled ? "Active" : "Paused"}
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {contextPreflightOpen ? (
        <div ref={contextPreflightRef} className="composer-context-preflight" id="composer-context-preflight">
          <ContextPreflightPreview
            projectName={contextProjectName}
            projectHealth={contextProject?.contextHealth ?? "not-compiled"}
            sources={contextPreflightSources}
            estimatedTokens={contextEstimatedTokens}
            budgetTokens={3200}
            deliveryMode={contextDeliveryMode}
            onDeliveryModeChange={setContextDeliveryMode}
          />
        </div>
      ) : null}
    </section>
  );
}
