import {
  Archive,
  ChevronDown,
  ChevronRight,
  Circle,
  Folder,
  FolderInput,
  FolderKanban,
  MoreHorizontal,
  PanelLeftClose,
  Pin,
  Plus,
  Search,
  Settings2,
  Undo2,
  X,
} from "lucide-react";
import {
  useEffect,
  lazy,
  useMemo,
  useRef,
  useState,
  Suspense,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { usePanelDrawerFocus } from "@/components/panel-drawer";
import { activityDescriptor, activityIcon } from "./activity-registry";
import { openWorkspaceOverlay } from "./overlay-store";
import { useNarrowPanelViewport } from "./panel-layout";
import {
  buildProjectChatNavigation,
  CHAT_SEARCH_SCOPES,
  chatActionAvailability,
  chatSearchScopeLabel,
  type ProjectChatGroup,
  type ChatSearchScope,
} from "./project-chat-navigation";
import { createRendererDeepLinkPreview } from "./conversation-navigation-model";
import { useWorkspaceStore } from "./store";
import type { ActivityId, ConversationView } from "./types";

const LazyConversationActionsDialog = lazy(async () => {
  const module = await import("./conversation-actions-dialog");
  return { default: module.ConversationActionsDialog };
});

type ChatFilter = "all" | "pinned" | "unread" | "drafts" | "with-files" | "attention" | "archived";

const DEFAULT_SIDEBAR_WIDTH = 248;
const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 420;
const COLLAPSE_SIDEBAR_THRESHOLD = 196;

function initialSidebarWidth(): number {
  if (typeof window === "undefined") return DEFAULT_SIDEBAR_WIDTH;
  // An explicit drag width may be retained while changing activities. Do not
  // inherit the old generated token's wider default into the reviewed shell.
  const value = Number.parseFloat(document.documentElement.style.getPropertyValue("--sidebar-width"));
  return Number.isFinite(value) ? Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, value)) : DEFAULT_SIDEBAR_WIDTH;
}

function conversationHasFiles(conversation: ConversationView): boolean {
  return conversation.messages.some((message) => message.attachments.length > 0);
}

function matchesChatFilter(conversation: ConversationView, filter: ChatFilter): boolean {
  switch (filter) {
    case "pinned":
      return conversation.pinned;
    case "unread":
      return conversation.unread;
    case "drafts":
      return conversation.hasDraft;
    case "with-files":
      return conversationHasFiles(conversation);
    case "attention":
      return conversation.runState !== null;
    case "archived":
      return conversation.archived;
    case "all":
    default:
      return true;
  }
}

function chatFilterLabel(filter: ChatFilter): string {
  switch (filter) {
    case "pinned":
      return "Pinned";
    case "unread":
      return "Unread";
    case "drafts":
      return "Drafts";
    case "with-files":
      return "With files";
    case "attention":
      return "Running / attention";
    case "archived":
      return "Archived";
    case "all":
    default:
      return "";
  }
}

interface ConversationRowProps {
  conversation: ConversationView;
  compact?: boolean;
  actionsOpen?: boolean;
  onContextMenu?: ((event: ReactMouseEvent<HTMLButtonElement>, conversation: ConversationView) => void) | undefined;
  onOpenActions?: ((conversation: ConversationView, anchor: HTMLElement) => void) | undefined;
}

function ConversationRow({ conversation, compact = false, actionsOpen = false, onContextMenu, onOpenActions }: ConversationRowProps) {
  const activeConversationId = useWorkspaceStore((state) => state.activeConversationId);
  const conversations = useWorkspaceStore((state) => state.conversations);
  const selectConversation = useWorkspaceStore((state) => state.selectConversation);
  const updateDraft = useWorkspaceStore((state) => state.updateDraft);
  const isActive = activeConversationId === conversation.id;
  const status = conversation.runState === "streaming"
    ? "Writing"
    : conversation.runState === "failed"
      ? "Needs attention"
      : conversation.hasDraft
        ? "Draft"
        : conversation.archived
          ? "Archived"
          : "Ready";
  const scope = conversation.projectName ?? "Standalone";

  const btwSubchats = useMemo(() => {
    const items: { id: string; label: string; inheritedContext: string; targetConversationId?: string; promptText?: string }[] = [];
    for (const msg of conversation.messages) {
      const trimmed = msg.content.trim();
      if (trimmed.startsWith("/btw ")) {
        const question = trimmed.replace(/^\/btw\s+/, "").split("\n")[0]?.trim() || "Side chat";
        items.push({
          id: `btw-msg-${msg.id}`,
          label: `/btw ${question}`,
          inheritedContext: `Inherited context: ${conversation.title}`,
          targetConversationId: conversation.id,
          promptText: trimmed,
        });
      }
    }
    const sessionUri = `omnia://sessions/${conversation.id}`;
    for (const candidate of conversations) {
      if (candidate.id === conversation.id) continue;
      const isChildBtw =
        candidate.workspacePath === sessionUri ||
        (candidate.title.toLowerCase().startsWith("/btw") &&
          (candidate.draft.includes(sessionUri) ||
            candidate.messages.some((m) => m.content.includes(sessionUri))));
      if (isChildBtw) {
        items.push({
          id: `btw-conv-${candidate.id}`,
          label: candidate.title.startsWith("├─") ? candidate.title : `├─ ${candidate.title}`,
          inheritedContext: `Inherited context: ${conversation.title}`,
          targetConversationId: candidate.id,
        });
      }
    }
    return items;
  }, [conversation.id, conversation.messages, conversation.title, conversations]);

  return (
    <div className="conversation-row-tree-node">
      <div className="conversation-row-shell">
        <button
          type="button"
          className={`${isActive ? "conversation-row conversation-row--active" : "conversation-row"}${compact ? " conversation-row--compact" : ""}`}
          onClick={() => selectConversation(conversation.id)}
          onContextMenu={(event) => {
            event.preventDefault();
            onContextMenu?.(event, conversation);
          }}
          aria-current={isActive ? "page" : undefined}
          aria-label={`${conversation.title}. ${scope}. ${status}. Updated ${conversation.updatedLabel}.`}
          title="Open Chat · use the actions button for lifecycle actions"
        >
          <span className="conversation-row__topline">
            <strong>{conversation.title}</strong>
            <time>{conversation.updatedLabel}</time>
          </span>
          <span className="conversation-row__excerpt">{conversation.excerpt}</span>
          <span className="conversation-row__meta">
            {conversation.runState === "streaming" ? (
              <span className="run-dot run-dot--streaming">Writing</span>
            ) : null}
            {conversation.projectName ? (
              <span>
                <Folder size={11} />
                {conversation.projectName}
              </span>
            ) : null}
            {conversation.hasDraft ? <span className="draft-label">Draft</span> : null}
            {conversation.pinned ? <Pin size={11} aria-label="Pinned" /> : null}
            {conversation.unread ? <Circle className="unread-dot" size={8} fill="currentColor" aria-label="Unread" /> : null}
          </span>
        </button>
        <button
          type="button"
          className="conversation-row__actions"
          aria-label="Open Chat actions menu"
          aria-haspopup="menu"
          aria-expanded={actionsOpen}
          aria-controls={actionsOpen ? chatActionMenuId(conversation.id) : undefined}
          title={`Chat actions for ${conversation.title}`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onOpenActions?.(conversation, event.currentTarget);
          }}
        >
          <MoreHorizontal size={15} aria-hidden="true" />
        </button>
      </div>
      {btwSubchats.length > 0 ? (
        <div
          className="conversation-row__subchats"
          data-testid={`sidebar-btw-subchats-${conversation.id}`}
          style={{
            paddingInlineStart: "18px",
            marginInlineStart: "10px",
            borderInlineStart: "1px solid var(--border-subtle, #27272a)",
            display: "flex",
            flexDirection: "column",
            gap: "2px",
          }}
        >
          {btwSubchats.map((sub) => (
            <button
              key={sub.id}
              type="button"
              className="conversation-row conversation-row--compact conversation-row--subchat"
              data-testid={`sidebar-btw-subchat-${sub.id}`}
              title={sub.inheritedContext}
              onClick={() => {
                selectConversation(sub.targetConversationId ?? conversation.id);
                if (sub.promptText) {
                  updateDraft(sub.promptText);
                }
              }}
            >
              <span className="conversation-row__topline">
                <strong>{sub.label}</strong>
              </span>
              <span className="conversation-row__excerpt">{sub.inheritedContext}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

interface ChatContextMenuState {
  conversation: ConversationView;
  x: number;
  y: number;
  restoreFocus?: HTMLElement | null;
}

interface ConversationExportRequest {
  conversationId: string;
  restoreFocus: HTMLElement | null;
}

interface MoveUndoState {
  fromProjectId: string | null;
}

interface MoveDestination {
  id: string;
  projectId: string | null;
  label: string;
  description: string;
  recent: boolean;
  available: boolean;
  unavailableReason?: string;
}

function chatActionMenuId(conversationId: string): string {
  const encodedId = encodeURIComponent(conversationId);
  return `chat-actions-menu-${encodedId || "conversation"}`;
}

function ChatContextMenu({
  state,
  onClose,
  onOpenExport,
}: {
  state: ChatContextMenuState;
  onClose: () => void;
  onOpenExport: (conversation: ConversationView) => void;
}) {
  const conversationId = state.conversation.id;
  const conversation = useWorkspaceStore((store) =>
    store.conversations.find((candidate) => candidate.id === conversationId) ?? state.conversation,
  );
  // The sidebar and Project Deck share one action-state contract. The export
  // entry opens only the renderer-local preview; native export remains planned.
  const availability = chatActionAvailability(conversation);
  const archiveAvailability = availability[conversation.archived ? "restore" : "archive"];
  const projects = useWorkspaceStore((store) => store.projects);
  const renameConversation = useWorkspaceStore((store) => store.renameConversation);
  const toggleConversationPinned = useWorkspaceStore((store) => store.toggleConversationPinned);
  const setConversationArchived = useWorkspaceStore((store) => store.setConversationArchived);
  const setConversationUnread = useWorkspaceStore((store) => store.setConversationUnread);
  const moveConversationToProject = useWorkspaceStore((store) => store.moveConversationToProject);
  const firstActionRef = useRef<HTMLButtonElement>(null);
  const moveTriggerRef = useRef<HTMLButtonElement>(null);
  const moveSearchRef = useRef<HTMLInputElement>(null);
  const destinationRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const menuRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveQuery, setMoveQuery] = useState("");
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(conversation.projectId);
  const [moveUndo, setMoveUndo] = useState<MoveUndoState | null>(null);

  useEffect(() => {
    firstActionRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (!moveOpen) return;
    setMoveQuery("");
    setSelectedProjectId(conversation.projectId);
    moveSearchRef.current?.focus({ preventScroll: true });
  }, [conversation.projectId, moveOpen]);

  const rename = () => {
    const next = globalThis.prompt?.("Rename Chat", conversation.title);
    if (next !== null && next !== undefined) renameConversation(conversation.id, next);
    onClose();
  };

  const destinationLabel = (projectId: string | null) => {
    if (!projectId) return "Inbox / standalone";
    return projects.find((project) => project.id === projectId)?.name ?? "Unknown Project";
  };

  const destinations = useMemo(() => {
    const normalizedQuery = moveQuery.trim().toLowerCase();
    const standalone: MoveDestination = {
      id: "__standalone__",
      projectId: null as string | null,
      label: "Inbox / standalone",
      description: "Keep this Chat outside a Project",
      recent: conversation.projectId === null,
      available: true,
    };
    const projectDestinations = projects
      .map((project) => ({
        id: project.id,
        projectId: project.id,
        label: project.name,
        description: project.archived
          ? `${project.description || "Project Chat destination"} · Project is archived`
          : project.contextHealth === "missing-access"
            ? `${project.description || "Project Chat destination"} · workspace access unavailable`
            : project.description || "Project Chat destination",
        recent: project.id === conversation.projectId || project.pinned,
        available: project.contextHealth !== "missing-access" && project.archived !== true,
        ...(project.archived
          ? { unavailableReason: "This Project is archived and cannot receive Chat ownership." }
          : project.contextHealth === "missing-access"
            ? { unavailableReason: "Workspace access is unavailable for this Project." }
            : {}),
      }))
      .sort((left, right) => {
        if (left.recent !== right.recent) return left.recent ? -1 : 1;
        if (left.projectId === conversation.projectId) return -1;
        if (right.projectId === conversation.projectId) return 1;
        return left.label.localeCompare(right.label);
      });
    const allDestinations = [standalone, ...projectDestinations];
    if (!normalizedQuery) return allDestinations;
    return allDestinations.filter((destination) =>
      `${destination.label} ${destination.description}`.toLowerCase().includes(normalizedQuery),
    );
  }, [conversation.projectId, moveQuery, projects]);

  const openMovePicker = () => {
    setMoveOpen(true);
    setStatus(null);
  };

  const confirmMove = () => {
    if (selectedProjectId === conversation.projectId) {
      setStatus("Choose a different destination before confirming the Chat move.");
      return;
    }
    const currentProjects = useWorkspaceStore.getState().projects;
    if (selectedProjectId !== null && !currentProjects.some((project) => project.id === selectedProjectId)) {
      setSelectedProjectId(conversation.projectId);
      setStatus(
        `The selected Project is no longer available. “${conversation.title}” stayed in ${destinationLabel(conversation.projectId)}; no Chat ownership change was applied.`,
      );
      return;
    }
    const selectedProject = selectedProjectId === null
      ? null
      : currentProjects.find((project) => project.id === selectedProjectId);
    if (selectedProject?.archived === true) {
      setStatus(
        `The selected Project is archived and cannot receive Chat ownership. “${conversation.title}” stayed in ${destinationLabel(conversation.projectId)}; no Chat ownership change was applied.`,
      );
      return;
    }
    if (selectedProject?.contextHealth === "missing-access") {
      setStatus(
        `The selected Project is unavailable because workspace access is missing. “${conversation.title}” stayed in ${destinationLabel(conversation.projectId)}; no Chat ownership change was applied.`,
      );
      return;
    }
    const fromProjectId = conversation.projectId;
    const fromLabel = destinationLabel(fromProjectId);
    const toLabel = destinationLabel(selectedProjectId);
    moveConversationToProject(conversation.id, selectedProjectId);
    setMoveUndo({ fromProjectId });
    setMoveOpen(false);
    moveTriggerRef.current?.focus({ preventScroll: true });
    setStatus(`Moved “${conversation.title}” from ${fromLabel} to ${toLabel} in this renderer preview. Chat history was not duplicated.`);
  };

  const undoMove = () => {
    if (!moveUndo) return;
    moveConversationToProject(conversation.id, moveUndo.fromProjectId);
    setMoveUndo(null);
    setStatus(`Undid the move for “${conversation.title}” in this renderer preview.`);
  };

  const focusDestination = (index: number) => {
    const destination = destinations[index];
    if (!destination) return;
    if (!destination.available) {
      setStatus(`${destination.label} is unavailable. ${destination.unavailableReason ?? "Choose another destination."}`);
    } else {
      setSelectedProjectId(destination.projectId);
    }
    destinationRefs.current[destination.id]?.focus({ preventScroll: true });
  };

  const onDestinationKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setMoveOpen(false);
      moveTriggerRef.current?.focus({ preventScroll: true });
      return;
    }
    if (destinations.length === 0) return;
    let nextIndex: number | null = null;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      nextIndex = (index + 1) % destinations.length;
    } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      nextIndex = (index - 1 + destinations.length) % destinations.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = destinations.length - 1;
    }
    if (nextIndex === null) return;
    event.preventDefault();
    event.stopPropagation();
    focusDestination(nextIndex);
  };

  const copyDeepLink = async () => {
    const deepLink = createRendererDeepLinkPreview({
      conversationId: conversation.id,
      projectId: conversation.projectId,
    });
    if (!deepLink) {
      setStatus("Stable Chat identity is unavailable in this renderer preview; no link was written.");
      return;
    }
    if (!globalThis.navigator?.clipboard?.writeText) {
      setStatus("Clipboard access is unavailable in this renderer preview; no link was written.");
      return;
    }
    try {
      await globalThis.navigator.clipboard.writeText(deepLink);
      setStatus("Renderer-local Chat deep link copied to the clipboard.");
    } catch {
      setStatus("Clipboard access is unavailable in this renderer preview; no link was written.");
    }
  };

  const copySessionUri = async () => {
    const sessionUri = `omnia://sessions/${conversation.id}`;
    if (!globalThis.navigator?.clipboard?.writeText) {
      setStatus("Clipboard access is unavailable in this renderer preview; no session URI was copied.");
      return;
    }
    try {
      await globalThis.navigator.clipboard.writeText(sessionUri);
      setStatus("Session URI copied to the clipboard.");
    } catch {
      setStatus("Clipboard access is unavailable in this renderer preview; no session URI was copied.");
    }
  };

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLInputElement) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setMoveOpen(false);
        moveTriggerRef.current?.focus({ preventScroll: true });
      }
      return;
    }
    const menuItems = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'),
    );
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (menuItems.length === 0) return;
    const currentIndex = Math.max(0, menuItems.indexOf(document.activeElement as HTMLButtonElement));
    let nextIndex: number | null = null;
    if (event.key === "ArrowDown") nextIndex = (currentIndex + 1) % menuItems.length;
    if (event.key === "ArrowUp") nextIndex = (currentIndex - 1 + menuItems.length) % menuItems.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = menuItems.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    menuItems[nextIndex]?.focus({ preventScroll: true });
  };

  const left = Math.max(8, Math.min(state.x, (globalThis.innerWidth || 960) - 268));
  const top = Math.max(8, Math.min(state.y, (globalThis.innerHeight || 720) - 420));

  return (
    <div
      className="conversation-context-menu"
      id={chatActionMenuId(conversation.id)}
      role="menu"
      aria-label={`Chat actions for ${conversation.title}`}
      style={{ left, top }}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={onMenuKeyDown}
      ref={menuRef}
    >
      <div className="conversation-context-menu__title" title={conversation.title}>
        {conversation.title}
      </div>
      <button ref={firstActionRef} type="button" role="menuitem" onClick={rename}>
        Rename
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          toggleConversationPinned(conversation.id);
          onClose();
        }}
      >
        {conversation.pinned ? "Unpin" : "Pin"}
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          setConversationUnread(conversation.id, !conversation.unread);
          onClose();
        }}
      >
        Mark as {conversation.unread ? "read" : "unread"}
      </button>
      <button
        type="button"
        role="menuitem"
        disabled={archiveAvailability.state !== "enabled"}
        title={archiveAvailability.reason}
        onClick={() => {
          setConversationArchived(conversation.id, !conversation.archived);
          onClose();
        }}
      >
        {conversation.archived ? "Restore" : "Archive"}
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          openWorkspaceOverlay({
            kind: "start-conversation",
            ...(conversation.projectId ? { projectId: conversation.projectId } : {}),
          });
          onClose();
        }}
      >
        Continue in new Chat
      </button>
      <button
        ref={moveTriggerRef}
        type="button"
        role="menuitem"
        disabled={availability["move-to-project"].state !== "enabled"}
        title={availability["move-to-project"].reason}
        aria-expanded={moveOpen}
        aria-controls={moveOpen ? `${chatActionMenuId(conversation.id)}-move-panel` : undefined}
        onClick={openMovePicker}
      >
        <FolderInput size={13} aria-hidden="true" />
        Move to Project…
      </button>
      {moveOpen ? (
        <div
          id={`${chatActionMenuId(conversation.id)}-move-panel`}
          className="conversation-context-menu__move-panel"
          role="group"
          aria-label="Move Chat destination picker"
        >
          <div className="conversation-context-menu__section">
            Choose destination <span className="conversation-context-menu__section-note">Recent destinations appear first</span>
          </div>
          <label className="conversation-context-menu__move-search">
            <Search size={13} aria-hidden="true" />
            <input
              ref={moveSearchRef}
              value={moveQuery}
              onChange={(event) => setMoveQuery(event.target.value)}
              placeholder="Search Projects"
              aria-label="Search project destinations"
            />
            {moveQuery ? (
              <button
                type="button"
                className="conversation-context-menu__move-clear"
                aria-label="Clear project destination search"
                title="Clear search"
                onClick={() => setMoveQuery("")}
              >
                <X size={12} aria-hidden="true" />
              </button>
            ) : null}
          </label>
          <div
            className="conversation-context-menu__destination-list"
            role="listbox"
            aria-label="Project destinations"
            aria-orientation="vertical"
          >
            {destinations.length > 0 ? (() => {
              const hasVisibleSelection = destinations.some((candidate) => candidate.projectId === selectedProjectId);
              return destinations.map((destination, destinationIndex) => {
                const selected = destination.projectId === selectedProjectId;
              return (
                <button
                  key={destination.id}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  aria-disabled={!destination.available}
                  aria-posinset={destinationIndex + 1}
                  aria-setsize={destinations.length}
                  tabIndex={selected || (!hasVisibleSelection && destinationIndex === 0) ? 0 : -1}
                  ref={(element) => {
                    destinationRefs.current[destination.id] = element;
                  }}
                  className={selected ? "conversation-context-menu__destination conversation-context-menu__destination--selected" : "conversation-context-menu__destination"}
                  title={destination.unavailableReason}
                  onClick={() => {
                    if (!destination.available) {
                      setStatus(`${destination.label} is unavailable. ${destination.unavailableReason ?? "Choose another destination."}`);
                      return;
                    }
                    setSelectedProjectId(destination.projectId);
                  }}
                  onKeyDown={(event) => onDestinationKeyDown(event, destinationIndex)}
                >
                  <span className="conversation-context-menu__destination-copy">
                    <strong>{destination.label}</strong>
                    <small>{destination.description}</small>
                  </span>
                  {destination.recent ? <span className="conversation-context-menu__destination-badge">Recent</span> : null}
                  {!destination.available ? <span className="conversation-context-menu__destination-badge">Unavailable</span> : null}
                  {selected ? <span className="conversation-context-menu__destination-badge">Current</span> : null}
                </button>
              );
              });
            })() : (
              <div className="conversation-context-menu__destination-empty">No project destinations match “{moveQuery}”.</div>
            )}
          </div>
          <div
            id={`${chatActionMenuId(conversation.id)}-move-summary`}
            className="conversation-context-menu__move-summary"
            role="status"
            aria-live="polite"
          >
            <span>From <strong>{destinationLabel(conversation.projectId)}</strong></span>
            <span aria-hidden="true">→</span>
            <span>To <strong>{destinationLabel(selectedProjectId)}</strong></span>
          </div>
          <div className="conversation-context-menu__move-diff">
            <div>
              <strong>Changes</strong>
              <span>Project instructions, memory, skills, and model defaults recalculate.</span>
            </div>
            <div>
              <strong>Unchanged</strong>
              <span>History, branches, artifacts, and run receipts stay attached.</span>
            </div>
          </div>
          <p id={`${chatActionMenuId(conversation.id)}-move-boundary`} className="conversation-context-menu__move-boundary">
            Preview only · changes Chat ownership metadata and recalculates effective context; no native write is performed.
          </p>
          <div className="conversation-context-menu__move-actions">
            <button
              type="button"
              className="button button--ghost"
              onClick={() => {
                setMoveOpen(false);
                moveTriggerRef.current?.focus({ preventScroll: true });
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="button button--primary"
              onClick={confirmMove}
              disabled={selectedProjectId === conversation.projectId}
              aria-describedby={`${chatActionMenuId(conversation.id)}-move-summary ${chatActionMenuId(conversation.id)}-move-boundary`}
            >
              Confirm move
            </button>
          </div>
        </div>
      ) : null}
      <div className="conversation-context-menu__section">More</div>
      {moveUndo ? (
        <button type="button" role="menuitem" onClick={undoMove} title="Undo the last renderer-local Chat move">
          <Undo2 size={13} aria-hidden="true" />
          Undo move
        </button>
      ) : null}
      <button
        type="button"
        role="menuitem"
        disabled={availability.export.state !== "enabled"}
        title={availability.export.reason}
        onClick={() => {
          onOpenExport(conversation);
          onClose();
        }}
      >
        {availability.export.state === "enabled" ? "Export preview…" : `Export (${availability.export.state})`}
      </button>
      <button
        type="button"
        role="menuitem"
        data-testid={`copy-chat-uri-${conversation.id}`}
        title="Copy this Chat's Session URI"
        onClick={() => void copySessionUri()}
      >
        Copy Session URI
      </button>
      <button
        type="button"
        role="menuitem"
        title="Copy an omnia:// renderer-local deep link"
        onClick={() => void copyDeepLink()}
      >
        Copy deep link (preview)
      </button>
      <button type="button" role="menuitem" disabled={availability["open-in-new-window"].state !== "enabled"} title={availability["open-in-new-window"].reason}>
        Open in new window ({availability["open-in-new-window"].state})
      </button>
      <button type="button" role="menuitem" disabled title={availability["continue-in-new-worktree"].reason}>
        Continue in new worktree ({availability["continue-in-new-worktree"].state})
      </button>
      <button type="button" role="menuitem" disabled title={availability["compare-models"].reason}>
        Compare models ({availability["compare-models"].state})
      </button>
      <button type="button" role="menuitem" disabled title={availability["delete-permanently"].reason}>
        Delete permanently ({availability["delete-permanently"].state})
      </button>
      {status ? (
        <div className="conversation-context-menu__status" role="status" aria-live="polite">
          {status}
        </div>
      ) : null}
    </div>
  );
}

function ProjectGroupRow({
  group,
  onToggle,
  onContextMenu,
  onOpenActions,
  actionsOpenConversationId,
}: {
  group: ProjectChatGroup;
  onToggle: (projectId: string) => void;
  onContextMenu?: (event: ReactMouseEvent<HTMLButtonElement>, conversation: ConversationView) => void;
  onOpenActions?: (conversation: ConversationView, anchor: HTMLElement) => void;
  actionsOpenConversationId?: string | null;
}) {
  const selectProject = useWorkspaceStore((state) => state.selectProject);
  const chatsLabel = `${group.chats.length} ${group.chats.length === 1 ? "chat" : "chats"}`;

  return (
    <div className="project-tree__group">
      <div className={group.active ? "project-tree__project-row project-tree__project-row--active" : "project-tree__project-row"}>
        <button
          type="button"
          className="project-tree__toggle"
          aria-label={`${group.expanded ? "Collapse" : "Expand"} ${group.project.name}`}
          title={`${group.expanded ? "Collapse" : "Expand"} ${group.project.name} Chats`}
          aria-expanded={group.expanded}
          onClick={() => onToggle(group.project.id)}
        >
          {group.expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <button
          type="button"
          className="project-tree__project-button"
          title={`Open Project ${group.project.name}`}
          onClick={() => selectProject(group.project.id)}
          aria-current={group.active ? "page" : undefined}
        >
          <span className="project-mini__mark project-mini__mark--folder">
            <Folder size={14} strokeWidth={1.75} aria-hidden="true" />
          </span>
          <span>
            <strong>{group.project.name}</strong>
            <small>{chatsLabel}</small>
          </span>
        </button>
      </div>
      {group.expanded ? (
        <div className="project-tree__children">
          {group.chats.length > 0 ? (
            group.chats.map((conversation) => (
              <ConversationRow
                key={conversation.id}
                conversation={conversation}
                compact
                actionsOpen={actionsOpenConversationId === conversation.id}
                onContextMenu={onContextMenu}
                onOpenActions={onOpenActions}
              />
            ))
          ) : (
            <div className="project-tree__empty">No chats in this Project yet</div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function ChatsSidebar() {
  const conversations = useWorkspaceStore((state) => state.conversations);
  const projects = useWorkspaceStore((state) => state.projects);
  const activeProjectId = useWorkspaceStore((state) => state.activeProjectId);
  const [query, setQuery] = useState("");
  const [searchScope, setSearchScope] = useState<ChatSearchScope>("all");
  const [filter, setFilter] = useState<ChatFilter>("all");
  const [expandedProjectIds, setExpandedProjectIds] = useState<ReadonlySet<string>>(
    () => new Set(projects.map((project) => project.id)),
  );
  const [listActionsOpen, setListActionsOpen] = useState(false);
  const listActionsRef = useRef<HTMLDivElement>(null);
  const listActionsTriggerRef = useRef<HTMLButtonElement>(null);
  const [contextMenu, setContextMenu] = useState<ChatContextMenuState | null>(null);
  const [exportRequest, setExportRequest] = useState<ConversationExportRequest | null>(null);
  const closeContextMenu = () => {
    contextMenu?.restoreFocus?.focus({ preventScroll: true });
    setContextMenu(null);
  };
  useEffect(() => {
    if (!contextMenu) return undefined;
    const closeOnOutsidePointer = () => closeContextMenu();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeContextMenu();
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (!listActionsOpen) return undefined;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && listActionsRef.current?.contains(target)) return;
      setListActionsOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setListActionsOpen(false);
      listActionsTriggerRef.current?.focus({ preventScroll: true });
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [listActionsOpen]);
  useEffect(() => {
    if (!listActionsOpen && !contextMenu) return;
    window.dispatchEvent(new CustomEvent("omnia:close-floating-menus", { detail: { source: "object-sidebar" } }));
  }, [contextMenu, listActionsOpen]);
  useEffect(() => {
    const handleCloseFloating = (event: Event) => {
      const detail = (event as CustomEvent<{ source?: string }>).detail;
      if (detail?.source !== "object-sidebar") {
        setContextMenu(null);
        setListActionsOpen(false);
      }
    };
    window.addEventListener("omnia:close-floating-menus", handleCloseFloating);
    return () => window.removeEventListener("omnia:close-floating-menus", handleCloseFloating);
  }, []);
  useEffect(() => {
    if (!listActionsOpen) return;
    window.requestAnimationFrame(() => {
      listActionsRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus({ preventScroll: true });
    });
  }, [listActionsOpen]);
  const projection = useMemo(
    () =>
      buildProjectChatNavigation(projects, conversations, {
        query,
        searchScope,
        includeArchived: true,
        expandedProjectIds,
        activeProjectId,
      }),
    [activeProjectId, conversations, expandedProjectIds, projects, query, searchScope],
  );
  const activeChats = useMemo(
    () => [
      ...projection.standaloneChats,
      ...projection.projectGroups.flatMap((group) => group.chats),
      ...projection.orphanedChats,
    ],
    [projection],
  );
  const visibleIds = useMemo(() => {
    if (filter === "archived") return new Set(projection.archivedChats.map((conversation) => conversation.id));
    return new Set(activeChats.filter((conversation) => matchesChatFilter(conversation, filter)).map((conversation) => conversation.id));
  }, [activeChats, filter, projection.archivedChats]);
  const toggleProject = (projectId: string) => {
    setListActionsOpen(false);
    setExpandedProjectIds((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  };
  const openContextMenu = (event: ReactMouseEvent<HTMLButtonElement>, conversation: ConversationView) => {
    setContextMenu({ conversation, x: event.clientX, y: event.clientY, restoreFocus: event.currentTarget });
  };
  const openActionMenu = (conversation: ConversationView, anchor: HTMLElement) => {
    const rect = anchor.getBoundingClientRect();
    setContextMenu({
      conversation,
      x: rect.right,
      y: rect.bottom,
      restoreFocus: anchor,
    });
  };
  const isNestedBtwChild = (candidate: ConversationView): boolean => {
    const parentUri = candidate.workspacePath;
    if (!parentUri?.startsWith("omnia://sessions/")) return false;
    const parentId = parentUri.slice("omnia://sessions/".length);
    return conversations.some((item) => item.id === parentId);
  };
  const standalone = projection.standaloneChats.filter(
    (conversation) => visibleIds.has(conversation.id) && !isNestedBtwChild(conversation),
  );
  const orphaned = projection.orphanedChats.filter(
    (conversation) => visibleIds.has(conversation.id) && !isNestedBtwChild(conversation),
  );
  const archived = projection.archivedChats.filter((conversation) => visibleIds.has(conversation.id));
  const groups = projection.projectGroups
    .map((group) => ({
      ...group,
      chats: group.chats.filter(
        (conversation) => visibleIds.has(conversation.id) && !isNestedBtwChild(conversation),
      ),
    }))
    .filter(
      (group) =>
        filter !== "archived" &&
        (group.chats.length > 0 || (filter === "all" && query.trim().length === 0)),
    );
  const hasActiveFilters = query.trim().length > 0 || searchScope !== "all" || filter !== "all";
  const clearFilters = () => {
    setQuery("");
    setSearchScope("all");
    setFilter("all");
    setListActionsOpen(false);
    listActionsTriggerRef.current?.focus({ preventScroll: true });
  };
  const expandAllProjects = () => {
    setExpandedProjectIds(new Set(projects.map((project) => project.id)));
    setListActionsOpen(false);
    listActionsTriggerRef.current?.focus({ preventScroll: true });
  };
  const collapseAllProjects = () => {
    setExpandedProjectIds(new Set());
    setListActionsOpen(false);
    listActionsTriggerRef.current?.focus({ preventScroll: true });
  };
  const showArchivedChats = () => {
    setFilter("archived");
    setListActionsOpen(false);
    listActionsTriggerRef.current?.focus({ preventScroll: true });
  };
  const visibleChatCount = filter === "archived"
    ? archived.length
    : standalone.length + groups.reduce((total, group) => total + group.chats.length, 0) + orphaned.length;
  const searchStatus = query.trim().length > 0
    ? `${visibleChatCount} Chat${visibleChatCount === 1 ? "" : "s"} shown from ${projection.counts.total} matching ${chatSearchScopeLabel(searchScope).toLowerCase()} search result${projection.counts.total === 1 ? "" : "s"}.`
    : `${visibleChatCount} Chat${visibleChatCount === 1 ? "" : "s"} shown.`;

  return (
    <>
      <div className="sidebar-actions">
        <button type="button" className="button button--primary button--full" onClick={() => openWorkspaceOverlay({ kind: "start-conversation" })}>
          <Plus size={16} />
          New chat
          <kbd>Ctrl N</kbd>
        </button>
      </div>
      <label className="sidebar-search">
        <Search size={15} />
        <input
          id="conversation-search"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && (query || searchScope !== "all")) {
              event.preventDefault();
              setQuery("");
              setSearchScope("all");
            }
          }}
          placeholder="Search chats..."
          aria-label="Search chats"
        />
        <button
          type="button"
          title={hasActiveFilters ? "Clear Chat search and filters" : "Chat filters"}
          aria-label={hasActiveFilters ? "Clear Chat search and filters" : "Chat filters"}
          onClick={clearFilters}
          disabled={!hasActiveFilters}
        >
          {hasActiveFilters ? <X size={14} /> : <Settings2 size={14} />}
        </button>
      </label>
      <label className="sidebar-search-scope sr-only">
        <span>Search in</span>
        <select
          aria-label="Search Chat fields"
          value={searchScope}
          onChange={(event) => setSearchScope(event.target.value as ChatSearchScope)}
        >
          {CHAT_SEARCH_SCOPES.map((scope) => (
            <option key={scope} value={scope}>{chatSearchScopeLabel(scope)}</option>
          ))}
        </select>
      </label>
      <div className="sidebar-section-label">
        {filter !== "all" ? <span>{chatFilterLabel(filter === "archived" ? "archived" : filter)}</span> : null}
        <div ref={listActionsRef} className="sidebar-list-actions">
          <button
            ref={listActionsTriggerRef}
            type="button"
            className={listActionsOpen ? "is-open" : undefined}
            title="Open Chat list actions"
            aria-label="Open Chat list actions"
            aria-haspopup="menu"
            aria-expanded={listActionsOpen}
            aria-controls={listActionsOpen ? "chat-list-actions-menu" : undefined}
            onClick={() => setListActionsOpen((open) => !open)}
          >
            <MoreHorizontal size={15} aria-hidden="true" />
          </button>
          {listActionsOpen ? (
            <div
              id="chat-list-actions-menu"
              className="sidebar-list-actions__menu"
              role="menu"
              aria-label="Chat list actions"
              onKeyDown={(event) => {
                const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'));
                if (event.key === "Escape") {
                  event.preventDefault();
                  setListActionsOpen(false);
                  listActionsTriggerRef.current?.focus({ preventScroll: true });
                  return;
                }
                if (items.length === 0) return;
                const currentIndex = Math.max(0, items.indexOf(document.activeElement as HTMLButtonElement));
                const nextIndex = event.key === "ArrowDown"
                  ? (currentIndex + 1) % items.length
                  : event.key === "ArrowUp"
                    ? (currentIndex - 1 + items.length) % items.length
                    : event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? items.length - 1
                        : null;
                if (nextIndex === null) return;
                event.preventDefault();
                items[nextIndex]?.focus({ preventScroll: true });
              }}
            >
              <button type="button" role="menuitem" onClick={expandAllProjects} disabled={projects.length === 0} title="Expand every Project Chat group">
                Expand all Projects
              </button>
              <button type="button" role="menuitem" onClick={collapseAllProjects} disabled={projects.length === 0} title="Collapse every Project Chat group">
                Collapse all Projects
              </button>
              <button type="button" role="menuitem" onClick={showArchivedChats} disabled={projection.counts.archived === 0} title={projection.counts.archived > 0 ? "Show archived Chats" : "No archived Chats are available in this preview"}>
                Show archived Chats
              </button>
              <button type="button" role="menuitem" onClick={clearFilters} disabled={!hasActiveFilters} title="Clear Chat search and filters">
                Clear search and filters
              </button>
            </div>
          ) : null}
        </div>
      </div>
      <div className="conversation-list">
        {filter === "archived" ? archived.map((conversation) => (
          <ConversationRow key={conversation.id} conversation={conversation} actionsOpen={contextMenu?.conversation.id === conversation.id} onContextMenu={openContextMenu} onOpenActions={openActionMenu} />
        )) : null}
        {filter !== "archived" && standalone.length > 0 ? standalone.map((conversation) => (
          <ConversationRow key={conversation.id} conversation={conversation} actionsOpen={contextMenu?.conversation.id === conversation.id} onContextMenu={openContextMenu} onOpenActions={openActionMenu} />
        )) : null}
        {filter !== "archived" && groups.length > 0 ? (
          <>
            <div className="sidebar-section-label sidebar-section-label--nested"><span>Projects</span></div>
            {groups.map((group) => (
              <ProjectGroupRow
                key={group.project.id}
                group={group}
                onToggle={toggleProject}
                onContextMenu={openContextMenu}
                onOpenActions={openActionMenu}
                actionsOpenConversationId={contextMenu?.conversation.id ?? null}
              />
            ))}
          </>
        ) : null}
        {filter !== "archived" && orphaned.length > 0 ? (
          <>
            <div className="sidebar-section-label sidebar-section-label--nested"><span>Needs review</span></div>
            {orphaned.map((conversation) => (
              <ConversationRow key={conversation.id} conversation={conversation} actionsOpen={contextMenu?.conversation.id === conversation.id} onContextMenu={openContextMenu} onOpenActions={openActionMenu} />
            ))}
          </>
        ) : null}
        {visibleChatCount === 0 ? (
          <div className="sidebar-empty">
            <Search size={20} />
            <p>{filter === "all" ? "No matching Chats" : `No ${chatFilterLabel(filter).toLowerCase()} Chats`}</p>
            <span>{query.trim().length > 0 ? `No chats match “${query.trim()}” in ${chatSearchScopeLabel(searchScope).toLowerCase()}.` : "Try another filter or start a new chat."}</span>
          </div>
        ) : null}
      </div>
      <div className="sidebar-search-status sr-only" aria-live="polite">
        {searchStatus}
      </div>
      <button
        type="button"
        className="sidebar-footer-link"
        aria-label="Show archived Chats"
        title="Show archived Chats"
        onClick={() => setFilter(filter === "archived" ? "all" : "archived")}
      >
        <Archive size={15} />
        Archived <span>{projection.counts.archived}</span>
      </button>
      {contextMenu ? (
        <ChatContextMenu
          key={contextMenu.conversation.id}
          state={contextMenu}
          onClose={closeContextMenu}
          onOpenExport={(conversation) => setExportRequest({ conversationId: conversation.id, restoreFocus: contextMenu.restoreFocus ?? null })}
        />
      ) : null}
      {exportRequest ? (() => {
        const exportConversation = conversations.find((candidate) => candidate.id === exportRequest.conversationId);
        return exportConversation ? (
          <Suspense fallback={<div className="modal-scrim" role="presentation"><div role="status">Loading Chat export preview…</div></div>}>
            <LazyConversationActionsDialog
              conversation={exportConversation}
              initialView="export"
              exportOnly
              onClose={() => {
                const restoreFocus = exportRequest.restoreFocus;
                setExportRequest(null);
                if (restoreFocus?.isConnected) restoreFocus.focus({ preventScroll: true });
              }}
            />
          </Suspense>
        ) : null;
      })() : null}
    </>
  );
}

function ProjectsSidebar() {
  const projects = useWorkspaceStore((state) => state.projects);
  const conversations = useWorkspaceStore((state) => state.conversations);
  const activeProjectId = useWorkspaceStore((state) => state.activeProjectId);
  const [expandedProjectIds, setExpandedProjectIds] = useState<ReadonlySet<string>>(
    () => new Set(projects.map((project) => project.id)),
  );
  const [contextMenu, setContextMenu] = useState<ChatContextMenuState | null>(null);
  const [exportRequest, setExportRequest] = useState<ConversationExportRequest | null>(null);
  const closeContextMenu = () => {
    contextMenu?.restoreFocus?.focus({ preventScroll: true });
    setContextMenu(null);
  };
  useEffect(() => {
    if (!contextMenu) return undefined;
    const closeOnOutsidePointer = () => closeContextMenu();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeContextMenu();
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [contextMenu]);
  const projection = useMemo(
    () =>
      buildProjectChatNavigation(projects, conversations, {
        expandedProjectIds,
        activeProjectId,
      }),
    [activeProjectId, conversations, expandedProjectIds, projects],
  );
  const toggleProject = (projectId: string) => {
    setExpandedProjectIds((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  };
  const openContextMenu = (event: ReactMouseEvent<HTMLButtonElement>, conversation: ConversationView) => {
    setContextMenu({ conversation, x: event.clientX, y: event.clientY, restoreFocus: event.currentTarget });
  };
  const openActionMenu = (conversation: ConversationView, anchor: HTMLElement) => {
    const rect = anchor.getBoundingClientRect();
    setContextMenu({ conversation, x: rect.right, y: rect.bottom, restoreFocus: anchor });
  };

  return (
    <>
      <div className="sidebar-actions">
        <button type="button" className="button button--primary button--full" onClick={() => openWorkspaceOverlay({ kind: "create-project" })}>
          <Plus size={16} />
          New project
        </button>
      </div>
      <div className="sidebar-section-label">
        <span>Your projects</span>
      </div>
      <div className="project-mini-list">
        {projection.projectGroups.map((group) => (
          <ProjectGroupRow
            key={group.project.id}
            group={group}
            onToggle={toggleProject}
            onContextMenu={openContextMenu}
            onOpenActions={openActionMenu}
            actionsOpenConversationId={contextMenu?.conversation.id ?? null}
          />
        ))}
        {projection.standaloneChats.length > 0 ? (
          <>
            <div className="sidebar-section-label sidebar-section-label--nested"><span>Standalone Chats</span></div>
            {projection.standaloneChats.map((conversation) => (
              <ConversationRow
                key={conversation.id}
                conversation={conversation}
                compact
                actionsOpen={contextMenu?.conversation.id === conversation.id}
                onContextMenu={openContextMenu}
                onOpenActions={openActionMenu}
              />
            ))}
          </>
        ) : null}
        {projects.length === 0 ? (
          <div className="sidebar-empty">
            <FolderKanban size={20} />
            <p>No projects yet</p>
            <span>Create one for conversations, instructions, and explicit read-only workspace grants.</span>
          </div>
        ) : null}
      </div>
      {contextMenu ? (
        <ChatContextMenu
          key={contextMenu.conversation.id}
          state={contextMenu}
          onClose={closeContextMenu}
          onOpenExport={(conversation) => setExportRequest({ conversationId: conversation.id, restoreFocus: contextMenu.restoreFocus ?? null })}
        />
      ) : null}
      {exportRequest ? (() => {
        const exportConversation = conversations.find((candidate) => candidate.id === exportRequest.conversationId);
        return exportConversation ? (
          <Suspense fallback={<div className="modal-scrim" role="presentation"><div role="status">Loading Chat export preview…</div></div>}>
            <LazyConversationActionsDialog
              conversation={exportConversation}
              initialView="export"
              exportOnly
              onClose={() => {
                const restoreFocus = exportRequest.restoreFocus;
                setExportRequest(null);
                if (restoreFocus?.isConnected) restoreFocus.focus({ preventScroll: true });
              }}
            />
          </Suspense>
        ) : null;
      })() : null}
    </>
  );
}

function SimpleSidebar({ activity }: { activity: Exclude<ActivityId, "chats" | "projects"> }) {
  const descriptor = activityDescriptor(activity);
  const description = descriptor.sidebar.mode === "context"
    ? descriptor.sidebar.description
    : "Open the activity to inspect its workspace objects.";

  return (
    <div className="sidebar-context-card">
      <span className="sidebar-context-card__icon">
        {activityIcon(descriptor, 18)}
      </span>
      <p>{description}</p>
      <span>Global object search is planned; Ctrl+K currently opens navigation and commands.</span>
    </div>
  );
}

export function ObjectSidebar() {
  const activeActivity = useWorkspaceStore((state) => state.activeActivity);
  const activeDescriptor = activityDescriptor(activeActivity);
  const sidebarOpen = useWorkspaceStore((state) => state.sidebarOpen);
  const toggleSidebar = useWorkspaceStore((state) => state.toggleSidebar);
  const narrowPanels = useNarrowPanelViewport();
  const [sidebarWidth, setSidebarWidth] = useState(initialSidebarWidth);
  const [isResizing, setIsResizing] = useState(false);
  const resizeRef = useRef<{
    startX: number;
    startWidth: number;
    pointerId: number;
    collapseOnRelease: boolean;
  } | null>(null);
  const panelRef = usePanelDrawerFocus<HTMLElement>(
    sidebarOpen,
    narrowPanels,
    toggleSidebar,
    "sidebar-toggle",
  );

  useEffect(() => {
    document.documentElement.style.setProperty("--sidebar-width", `${sidebarWidth}px`);
    document.documentElement.style.setProperty("--chat-sidebar-width", `${sidebarWidth}px`);
  }, [sidebarWidth]);

  useEffect(() => {
    if (!isResizing) return undefined;

    const handlePointerMove = (event: PointerEvent) => {
      const resize = resizeRef.current;
      if (!resize) return;
      const requestedWidth = resize.startWidth + event.clientX - resize.startX;
      resize.collapseOnRelease = requestedWidth <= COLLAPSE_SIDEBAR_THRESHOLD;
      const nextWidth = Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, requestedWidth));
      setSidebarWidth(Math.round(nextWidth));
    };
    const handlePointerUp = () => {
      const resize = resizeRef.current;
      resizeRef.current = null;
      setIsResizing(false);
      if (resize?.collapseOnRelease) toggleSidebar();
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };
  }, [isResizing]);

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (narrowPanels) return;
    event.preventDefault();
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // Synthetic pointer events in WebView2/automation may not have an active pointerId
    }
    resizeRef.current = {
      startX: event.clientX,
      startWidth: sidebarWidth,
      pointerId: event.pointerId,
      collapseOnRelease: false,
    };
    setIsResizing(true);
  };

  /* Keep a handle-local fallback in addition to the window listener. Some
     browser automation and embedded webviews deliver captured pointer moves
     back to the handle but do not bubble them to window. Handling both paths
     makes drag resizing work consistently without changing the keyboard path. */
  const resizeFromPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const resize = resizeRef.current;
    if (!resize || event.pointerId !== resize.pointerId) return;
    const requestedWidth = resize.startWidth + event.clientX - resize.startX;
    resize.collapseOnRelease = requestedWidth <= COLLAPSE_SIDEBAR_THRESHOLD;
    const nextWidth = Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, requestedWidth));
    setSidebarWidth(Math.round(nextWidth));
  };

  const finishPointerResize = (event?: ReactPointerEvent<HTMLDivElement>) => {
    const resize = resizeRef.current;
    if (event && resize && event.pointerId !== resize.pointerId) return;
    resizeRef.current = null;
    setIsResizing(false);
    if (resize?.collapseOnRelease) toggleSidebar();
  };

  const resizeWithKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (narrowPanels) return;
    let nextWidth: number | null = null;
    if (event.key === "ArrowLeft") nextWidth = sidebarWidth - 16;
    if (event.key === "ArrowRight") nextWidth = sidebarWidth + 16;
    if (event.key === "Home") nextWidth = MIN_SIDEBAR_WIDTH;
    if (event.key === "End") nextWidth = MAX_SIDEBAR_WIDTH;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggleSidebar();
      return;
    }
    if (event.key === "ArrowLeft" && sidebarWidth <= MIN_SIDEBAR_WIDTH) {
      event.preventDefault();
      toggleSidebar();
      return;
    }
    if (nextWidth === null) return;
    event.preventDefault();
    setSidebarWidth(Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, nextWidth)));
  };

  const resetSidebarWidth = () => setSidebarWidth(DEFAULT_SIDEBAR_WIDTH);

  if (!sidebarOpen) return null;

  return (
    <aside
      ref={panelRef}
      id="object-sidebar"
      className={isResizing ? "object-sidebar object-sidebar--resizing" : "object-sidebar"}
      aria-label={`${activeDescriptor.label} sidebar`}
      aria-modal={narrowPanels ? "true" : undefined}
      role={narrowPanels ? "dialog" : "complementary"}
      tabIndex={-1}
    >
      <div className="object-sidebar__header">
        <div>
          <h2>{activeDescriptor.label}</h2>
        </div>
        <button type="button" className="icon-button icon-button--small" onClick={toggleSidebar} aria-label="Close sidebar" title="Hide the workspace sidebar">
          <PanelLeftClose size={16} />
        </button>
      </div>
      <div
        className="object-sidebar__resize-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        aria-valuemin={MIN_SIDEBAR_WIDTH}
        aria-valuemax={MAX_SIDEBAR_WIDTH}
        aria-valuenow={sidebarWidth}
        tabIndex={narrowPanels ? -1 : 0}
        onPointerDown={startResize}
        onPointerMove={resizeFromPointer}
        onPointerUp={finishPointerResize}
        onPointerCancel={finishPointerResize}
        onLostPointerCapture={() => finishPointerResize()}
        onKeyDown={resizeWithKeyboard}
        onDoubleClick={resetSidebarWidth}
      />
      {activeActivity === "chats" ? <ChatsSidebar /> : null}
      {activeActivity === "projects" ? <ProjectsSidebar /> : null}
      {activeActivity !== "chats" && activeActivity !== "projects" ? (
        <SimpleSidebar activity={activeActivity} />
      ) : null}
    </aside>
  );
}
