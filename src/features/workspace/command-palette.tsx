import {
  Archive,
  ArrowLeft,
  BookOpen,
  Brain,
  Check,
  Clock3,
  CornerDownLeft,
  Cpu,
  Library,
  Gauge,
  LayoutTemplate,
  FileText,
  FolderKanban,
  FolderInput,
  KeyRound,
  Mail,
  MailOpen,
  MessageSquareText,
  MessageCircleMore,
  Monitor,
  Moon,
  PanelLeft,
  PanelRight,
  Pin,
  Plus,
  RotateCcw,
  Search,
  Server,
  SlidersHorizontal,
  Sun,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";

import { ModalSurface } from "@/components/modal-surface";

import { COMMAND_ACTIVITIES, activityIcon } from "./activity-registry";
import {
  clearCommandHistory,
  getCommandHistory,
  recordCommandInvocation,
  type CommandHistoryGroup,
  type CommandHistoryEntry,
} from "./command-history-session";
import { openWorkspaceOverlay } from "./overlay-store";
import { useWorkspaceStore } from "./store";
import type { ActivityId } from "./types";

interface CommandItem {
  id: string;
  title: string;
  description: string;
  group: CommandHistoryGroup;
  /** Human-readable renderer location; this is context, not a deep-link authority. */
  breadcrumb?: readonly string[];
  icon: ReactNode;
  keywords: string;
  action: () => void;
  shortcut?: string;
  status?: "available" | "preview" | "planned";
}

type PaletteScope = "all" | "commands" | "conversations" | "messages" | "projects" | "files" | "memory" | "skills" | "library" | "providers" | "models";

interface MoveDestination {
  id: string;
  projectId: string | null;
  label: string;
  description: string;
  recent: boolean;
  available: boolean;
  unavailableReason?: string;
}

const PALETTE_SCOPES: Array<{
  id: PaletteScope;
  label: string;
  shortLabel: string;
}> = [
  { id: "all", label: "All", shortLabel: "All" },
  { id: "commands", label: "Commands", shortLabel: "Commands" },
  { id: "conversations", label: "Chats", shortLabel: "Chats" },
  { id: "messages", label: "Messages", shortLabel: "Messages" },
  { id: "projects", label: "Projects", shortLabel: "Projects" },
  { id: "files", label: "Files", shortLabel: "Files" },
  { id: "memory", label: "Memory", shortLabel: "Memory" },
  { id: "skills", label: "Skills", shortLabel: "Skills" },
  { id: "library", label: "Library", shortLabel: "Library" },
  { id: "providers", label: "Providers", shortLabel: "Providers" },
  { id: "models", label: "Models", shortLabel: "Models" },
];

const GROUP_FOR_SCOPE: Record<Exclude<PaletteScope, "all">, CommandItem["group"]> = {
  commands: "Commands",
  conversations: "Conversations",
  messages: "Messages",
  projects: "Projects",
  files: "Files",
  memory: "Memory",
  skills: "Skills",
  library: "Library",
  providers: "Providers",
  models: "Models",
};

function commandMatchesScope(item: CommandItem, scope: PaletteScope): boolean {
  return scope === "all" || item.group === GROUP_FOR_SCOPE[scope];
}

function paletteScopeLabel(scope: PaletteScope): string {
  return PALETTE_SCOPES.find((candidate) => candidate.id === scope)?.label ?? "All";
}

function parsePaletteQuery(rawQuery: string, selectedScope: PaletteScope): {
  term: string;
  scope: PaletteScope;
  prefix: string | null;
} {
  const trimmed = rawQuery.trimStart();
  const prefix = trimmed[0];
  if (prefix === ">" || prefix === "@" || prefix === "#") {
    const scope = prefix === ">" ? "commands" : prefix === "@" ? "conversations" : "projects";
    return { term: trimmed.slice(1).trim(), scope, prefix };
  }
  if (prefix === "!" || prefix === "%" || prefix === "&" || prefix === ":" || prefix === "^" || prefix === "?" || prefix === "~") {
    const scope = prefix === "!" ? "library" : prefix === "%" ? "memory" : prefix === "&" ? "skills" : prefix === ":" ? "providers" : prefix === "^" ? "models" : prefix === "?" ? "messages" : "files";
    return { term: trimmed.slice(1).trim(), scope, prefix };
  }
  return { term: rawQuery.trim(), scope: selectedScope, prefix: null };
}

function shortcutLabel(value: string): string {
  const platform = typeof navigator === "undefined" ? "" : navigator.platform.toLowerCase();
  return value.replace(/Cmd|Ctrl/g, platform.includes("mac") ? "⌘" : "Ctrl");
}

function resultIdForItem(item: CommandItem): string {
  return `command-result-${item.id}`;
}

export function CommandPalette() {
  const open = useWorkspaceStore((state) => state.commandPaletteOpen);
  const conversations = useWorkspaceStore((state) => state.conversations);
  const activeConversationId = useWorkspaceStore((state) => state.activeConversationId);
  const activeConversation = conversations.find((conversation) => conversation.id === activeConversationId);
  const projects = useWorkspaceStore((state) => state.projects);
  const memories = useWorkspaceStore((state) => state.memories);
  const skills = useWorkspaceStore((state) => state.skills);
  const artifacts = useWorkspaceStore((state) => state.artifacts);
  const providers = useWorkspaceStore((state) => state.providers);
  const activeProject = useWorkspaceStore((state) =>
    state.projects.find((project) => project.id === state.activeProjectId),
  );
  const setOpen = useWorkspaceStore((state) => state.setCommandPaletteOpen);
  const setActivity = useWorkspaceStore((state) => state.setActivity);
  const selectConversation = useWorkspaceStore((state) => state.selectConversation);
  const requestMessageNavigation = useWorkspaceStore((state) => state.requestMessageNavigation);
  const selectProject = useWorkspaceStore((state) => state.selectProject);
  const toggleConversationPinned = useWorkspaceStore((state) => state.toggleConversationPinned);
  const setConversationArchived = useWorkspaceStore((state) => state.setConversationArchived);
  const setConversationUnread = useWorkspaceStore((state) => state.setConversationUnread);
  const moveConversationToProject = useWorkspaceStore((state) => state.moveConversationToProject);
  const toggleSidebar = useWorkspaceStore((state) => state.toggleSidebar);
  const toggleInspector = useWorkspaceStore((state) => state.toggleInspector);
  const setInspectorTab = useWorkspaceStore((state) => state.setInspectorTab);
  const setComposerMode = useWorkspaceStore((state) => state.setComposerMode);
  const setTheme = useWorkspaceStore((state) => state.setTheme);
  const setDensity = useWorkspaceStore((state) => state.setDensity);
  const setMotion = useWorkspaceStore((state) => state.setMotion);
  const resetParameters = useWorkspaceStore((state) => state.resetParameters);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<PaletteScope>("all");
  const [activeIndex, setActiveIndex] = useState(0);
  const [movePickerOpen, setMovePickerOpen] = useState(false);
  const [moveQuery, setMoveQuery] = useState("");
  const [selectedMoveProjectId, setSelectedMoveProjectId] = useState<string | null>(null);
  const [moveActiveIndex, setMoveActiveIndex] = useState(0);
  const [moveStatus, setMoveStatus] = useState<string | null>(null);
  const [recentCommands, setRecentCommands] = useState<readonly CommandHistoryEntry[]>(() => getCommandHistory());
  const inputRef = useRef<HTMLInputElement>(null);
  const moveSearchRef = useRef<HTMLInputElement>(null);
  const moveDestinationRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const resultRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const runCommand = (item: CommandItem) => {
    recordCommandInvocation({ id: item.id, title: item.title, group: item.group });
    setRecentCommands(getCommandHistory());
    item.action();
  };

  const clearRecentCommands = () => {
    clearCommandHistory();
    setRecentCommands([]);
  };

  const navigate = (activity: ActivityId) => {
    setActivity(activity);
    setOpen(false);
  };

  const openActiveChatMovePicker = () => {
    if (!activeConversation) return;
    setSelectedMoveProjectId(activeConversation.projectId);
    setMoveQuery("");
    setMoveActiveIndex(0);
    setMoveStatus(null);
    setMovePickerOpen(true);
  };

  const destinationLabel = (projectId: string | null): string => {
    if (!projectId) return "Standalone / Inbox";
    return projects.find((project) => project.id === projectId)?.name ?? "Unavailable Project";
  };

  const moveDestinations = useMemo<MoveDestination[]>(() => {
    if (!activeConversation) return [];
    const normalizedQuery = moveQuery.trim().toLowerCase();
    const standalone: MoveDestination = {
      id: "__standalone__",
      projectId: null,
      label: "Standalone / Inbox",
      description: "Keep this Chat outside a Project",
      recent: activeConversation.projectId === null,
      available: true,
    };
    const projectDestinations = projects
      .map<MoveDestination>((project) => ({
        id: project.id,
        projectId: project.id,
        label: project.name,
        description: project.archived
          ? `${project.description || "Project Chat destination"} · Project is archived`
          : project.contextHealth === "missing-access"
            ? `${project.description || "Project Chat destination"} · workspace access unavailable`
            : project.description || "Project Chat destination",
        recent: project.id === activeConversation.projectId || project.pinned,
        available: project.contextHealth !== "missing-access" && project.archived !== true,
        ...(project.archived
          ? { unavailableReason: "This Project is archived and cannot receive Chat ownership." }
          : project.contextHealth === "missing-access"
            ? { unavailableReason: "Workspace access is unavailable for this Project." }
            : {}),
      }))
      .sort((left, right) => {
        if (left.recent !== right.recent) return left.recent ? -1 : 1;
        if (left.projectId === activeConversation.projectId) return -1;
        if (right.projectId === activeConversation.projectId) return 1;
        return left.label.localeCompare(right.label);
      });
    const destinations = [standalone, ...projectDestinations];
    if (!normalizedQuery) return destinations;
    return destinations.filter((destination) =>
      `${destination.label} ${destination.description}`.toLowerCase().includes(normalizedQuery),
    );
  }, [activeConversation, moveQuery, projects]);

  useEffect(() => {
    if (!movePickerOpen) return;
    const selectedIndex = moveDestinations.findIndex((destination) => destination.projectId === selectedMoveProjectId);
    setMoveActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
  }, [moveDestinations, movePickerOpen, selectedMoveProjectId]);

  useEffect(() => {
    if (!movePickerOpen) return;
    const activeDestination = moveDestinationRefs.current[moveActiveIndex];
    if (activeDestination && typeof activeDestination.scrollIntoView === "function") {
      activeDestination.scrollIntoView({ block: "nearest" });
    }
  }, [moveActiveIndex, movePickerOpen]);

  const moveDestinationKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setMovePickerOpen(false);
      setMoveStatus(null);
      return;
    }
    let nextIndex: number | null = null;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") nextIndex = (index + 1) % moveDestinations.length;
    if (event.key === "ArrowUp" || event.key === "ArrowLeft") nextIndex = (index - 1 + moveDestinations.length) % moveDestinations.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = moveDestinations.length - 1;
    if (nextIndex !== null && moveDestinations.length > 0) {
      event.preventDefault();
      setMoveActiveIndex(nextIndex);
      moveDestinationRefs.current[nextIndex]?.focus({ preventScroll: true });
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const destination = moveDestinations[index];
      if (!destination) return;
      if (!destination.available) {
        setMoveStatus(`${destination.label} is unavailable. ${destination.unavailableReason ?? "Choose another destination."}`);
        return;
      }
      setMoveStatus(null);
      setSelectedMoveProjectId(destination.projectId);
    }
  };

  const confirmActiveChatMove = () => {
    if (!activeConversation) return;
    if (selectedMoveProjectId === activeConversation.projectId) {
      setMoveStatus("Choose a different destination before confirming the Chat move.");
      return;
    }
    const currentProjects = useWorkspaceStore.getState().projects;
    if (selectedMoveProjectId !== null && !currentProjects.some((project) => project.id === selectedMoveProjectId)) {
      setMoveStatus(
        `The selected Project is no longer available. “${activeConversation.title}” stayed in ${destinationLabel(activeConversation.projectId)}; no ownership change was applied.`,
      );
      return;
    }
    const selectedProject = selectedMoveProjectId === null
      ? null
      : currentProjects.find((project) => project.id === selectedMoveProjectId);
    if (selectedProject?.archived === true) {
      setMoveStatus(
        `The selected Project is archived and cannot receive Chat ownership. “${activeConversation.title}” stayed in ${destinationLabel(activeConversation.projectId)}; no ownership change was applied.`,
      );
      return;
    }
    if (selectedProject?.contextHealth === "missing-access") {
      setMoveStatus(
        `The selected Project is unavailable because workspace access is missing. “${activeConversation.title}” stayed in ${destinationLabel(activeConversation.projectId)}; no ownership change was applied.`,
      );
      return;
    }
    moveConversationToProject(activeConversation.id, selectedMoveProjectId);
    setMoveStatus(
      `Moved “${activeConversation.title}” from ${destinationLabel(activeConversation.projectId)} to ${destinationLabel(selectedMoveProjectId)} in this renderer preview. History, branches, artifacts, and run receipts stayed attached.`,
    );
    setMovePickerOpen(false);
    setOpen(false);
  };

  const items = useMemo<CommandItem[]>(
    () => [
      {
        id: "new-chat",
        title: "New conversation",
        description: "Start with a clean context",
        group: "Commands",
        breadcrumb: ["Commands", "Create", "New conversation"],
        icon: <Plus size={17} />,
        keywords: "create chat new conversation",
        shortcut: "Ctrl+N",
        action: () => {
          openWorkspaceOverlay({ kind: "start-conversation" });
          setOpen(false);
        },
      },
      {
        id: "new-project",
        title: "New project",
        description: "Open the project setup dialog",
        group: "Commands",
        breadcrumb: ["Commands", "Create", "New project"],
        icon: <FolderInput size={17} />,
        keywords: "create project workspace folder instructions",
        shortcut: "Ctrl+Shift+P",
        action: () => {
          openWorkspaceOverlay({ kind: "create-project" });
          setOpen(false);
        },
      },
      ...(activeProject
        ? [
            {
              id: "new-chat-in-project",
              title: `New chat in ${activeProject.name}`,
              description: "Start a conversation scoped to the active project",
              group: "Commands" as const,
              breadcrumb: ["Commands", "Create", "Project chat", activeProject.name],
              icon: <FolderKanban size={17} />,
              keywords: `create chat project ${activeProject.name}`,
              status: "available" as const,
              action: () => {
                openWorkspaceOverlay({ kind: "start-conversation", projectId: activeProject.id });
                setOpen(false);
              },
            },
          ]
        : []),
      ...(activeConversation
        ? [
            {
              id: "active-chat-open",
              title: `Open active chat: ${activeConversation.title}`,
              description: "Return focus to the currently selected conversation",
              group: "Commands" as const,
              breadcrumb: ["Commands", "Chat", activeConversation.title, "Open"],
              icon: <MessageSquareText size={17} />,
              keywords: `chat conversation active ${activeConversation.title}`,
              action: () => {
                selectConversation(activeConversation.id);
                setOpen(false);
              },
            },
            {
              id: "active-chat-pin",
              title: activeConversation.pinned ? "Unpin active chat" : "Pin active chat",
              description: "Update the selected Chat's renderer preview state",
              group: "Commands" as const,
              breadcrumb: ["Commands", "Chat", activeConversation.title, activeConversation.pinned ? "Unpin" : "Pin"],
              icon: <Pin size={17} />,
              keywords: "chat pin pinned favorite active",
              status: "preview" as const,
              action: () => {
                toggleConversationPinned(activeConversation.id);
                setOpen(false);
              },
            },
            {
              id: "active-chat-unread",
              title: activeConversation.unread ? "Mark active chat read" : "Mark active chat unread",
              description: "Toggle the selected Chat's unread indicator",
              group: "Commands" as const,
              breadcrumb: ["Commands", "Chat", activeConversation.title, activeConversation.unread ? "Mark read" : "Mark unread"],
              icon: activeConversation.unread ? <MailOpen size={17} /> : <Mail size={17} />,
              keywords: "chat read unread attention active",
              status: "preview" as const,
              action: () => {
                setConversationUnread(activeConversation.id, !activeConversation.unread);
                setOpen(false);
              },
            },
            ...(activeConversation.runState !== "streaming"
              ? [
                  {
                    id: "active-chat-archive",
                    title: activeConversation.archived ? "Restore active chat" : "Archive active chat",
                    description: activeConversation.archived
                      ? "Remove the selected Chat from the archived view"
                      : "Move the selected Chat out of the active list",
                    group: "Commands" as const,
                    breadcrumb: ["Commands", "Chat", activeConversation.title, activeConversation.archived ? "Restore" : "Archive"],
                    icon: <Archive size={17} />,
                    keywords: "chat archive restore archived active",
                    status: "preview" as const,
                    action: () => {
                      setConversationArchived(activeConversation.id, !activeConversation.archived);
                      setOpen(false);
                    },
                  },
                ]
              : []),
            {
              id: "active-chat-move",
              title: "Move active chat…",
              description: "Choose Standalone / Inbox or a Project, then confirm the scope change",
              group: "Commands" as const,
              breadcrumb: ["Commands", "Chat", activeConversation.title, "Move"],
              icon: <FolderInput size={17} />,
              keywords: "chat inbox standalone project move detach attach active destination confirm",
              status: "preview" as const,
              action: openActiveChatMovePicker,
            },
            ...(activeConversation.projectId
              ? [
                  {
                    id: "active-project-open",
                    title: `Open active Project: ${activeConversation.projectName ?? "Project"}`,
                    description: "Open the Project surface that owns this Chat",
                    group: "Commands" as const,
                    breadcrumb: ["Commands", "Navigate", activeConversation.projectName ?? "Project"],
                    icon: <FolderKanban size={17} />,
                    keywords: `project active chat ${activeConversation.projectName ?? ""}`,
                    action: () => {
                      selectProject(activeConversation.projectId as string);
                      setOpen(false);
                    },
                  },
                ]
              : []),
          ]
        : []),
      ...COMMAND_ACTIVITIES.map<CommandItem>((activity) => ({
        id: `activity-${activity.id}`,
        title: activity.command.title,
        description: activity.command.description,
        group: "Commands",
        breadcrumb: ["Commands", "Navigate", activity.command.title],
        icon: activityIcon(activity, 17),
        keywords: activity.command.keywords,
        ...(activity.shortcut ? { shortcut: activity.shortcut } : {}),
        status: activity.id === "memory" || activity.id === "skills" || activity.id === "work" ? "preview" : "available",
        action: () => navigate(activity.id),
      })),
      {
        id: "toggle-sidebar",
        title: "Toggle object sidebar",
        description: "Show or hide the conversation/project list",
        group: "Commands",
        breadcrumb: ["Commands", "Layout", "Object sidebar"],
        icon: <PanelLeft size={17} />,
        keywords: "sidebar panel",
        shortcut: "Ctrl+Shift+B",
        action: () => {
          toggleSidebar();
          setOpen(false);
        },
      },
      {
        id: "focus-chat-search",
        title: "Focus Chat search",
        description: "Search conversations and project chats",
        group: "Commands",
        breadcrumb: ["Commands", "Focus", "Chat search"],
        icon: <Search size={17} />,
        keywords: "search chats conversations projects focus filter",
        shortcut: "Ctrl+Shift+F",
        action: () => {
          setActivity("chats");
          const nextState = useWorkspaceStore.getState();
          if (!nextState.sidebarOpen) nextState.toggleSidebar();
          setOpen(false);
          window.requestAnimationFrame(() => document.getElementById("conversation-search")?.focus());
        },
      },
      {
        id: "focus-composer",
        title: "Focus composer",
        description: "Jump to the current Chat message composer",
        group: "Commands",
        breadcrumb: ["Commands", "Focus", "Composer"],
        icon: <MessageSquareText size={17} />,
        keywords: "composer draft message write focus",
        shortcut: "Ctrl+L",
        action: () => {
          setActivity("chats");
          setOpen(false);
          window.requestAnimationFrame(() => document.querySelector<HTMLElement>('[aria-label="Message Omnia"]')?.focus());
        },
      },
      {
        id: "toggle-inspector",
        title: "Toggle context inspector",
        description: "Open preview status, run state, and available parameters",
        group: "Commands",
        breadcrumb: ["Commands", "Layout", "Context inspector"],
        icon: <PanelRight size={17} />,
        keywords: "inspector context run parameters",
        shortcut: "Ctrl+Shift+I",
        action: () => {
          toggleInspector();
          setOpen(false);
        },
      },
      {
        id: "theme-dark",
        title: "Use dark theme",
        description: "Switch this profile to the dark color scheme",
        group: "Commands",
        breadcrumb: ["Commands", "Appearance", "Dark theme"],
        icon: <Moon size={17} />,
        keywords: "theme dark appearance",
        action: () => {
          setTheme("dark");
          setOpen(false);
        },
      },
      {
        id: "theme-light",
        title: "Use light theme",
        description: "Switch this profile to the light color scheme",
        group: "Commands",
        breadcrumb: ["Commands", "Appearance", "Light theme"],
        icon: <Sun size={17} />,
        keywords: "theme light appearance",
        action: () => {
          setTheme("light");
          setOpen(false);
        },
      },
      {
        id: "theme-system",
        title: "Use system theme",
        description: "Follow the Windows light or dark appearance preference",
        group: "Commands",
        breadcrumb: ["Commands", "Appearance", "System theme"],
        icon: <Monitor size={17} />,
        keywords: "theme system appearance automatic",
        action: () => {
          setTheme("system");
          setOpen(false);
        },
      },
      {
        id: "open-context-inspector",
        title: "Open context inspector",
        description: "Review the context scope and evidence for this chat",
        group: "Commands",
        breadcrumb: ["Commands", "Inspector", "Context"],
        icon: <PanelRight size={17} />,
        keywords: "inspector context evidence scope",
        action: () => {
          setInspectorTab("context");
          setOpen(false);
        },
      },
      {
        id: "open-run-inspector",
        title: "Open run inspector",
        description: "Review run status, stages, and receipts",
        group: "Commands",
        breadcrumb: ["Commands", "Inspector", "Run"],
        icon: <Gauge size={17} />,
        keywords: "inspector run status timeline receipts",
        action: () => {
          setInspectorTab("run");
          setOpen(false);
        },
      },
      {
        id: "open-parameters-inspector",
        title: "Open model parameters",
        description: "Review provider parameters before the next request",
        group: "Commands",
        breadcrumb: ["Commands", "Inspector", "Parameters"],
        icon: <SlidersHorizontal size={17} />,
        keywords: "inspector parameters model provider temperature top p",
        action: () => {
          setInspectorTab("parameters");
          setOpen(false);
        },
      },
      {
        id: "reset-parameters",
        title: "Reset model parameters",
        description: "Restore the current parameter draft to its defaults",
        group: "Commands",
        breadcrumb: ["Commands", "Inspector", "Reset parameters"],
        icon: <RotateCcw size={17} />,
        keywords: "parameters reset defaults undo clear",
        action: () => {
          resetParameters();
          setOpen(false);
        },
      },
      {
        id: "composer-ask",
        title: "Use Ask composer mode",
        description: "Select the default text-chat mode",
        group: "Commands",
        breadcrumb: ["Commands", "Composer", "Ask"],
        icon: <MessageSquareText size={17} />,
        keywords: "composer mode ask chat",
        action: () => {
          setComposerMode("ask");
          setOpen(false);
        },
      },
      {
        id: "composer-create",
        title: "Preview Create composer mode",
        description: "Select the drafting mode preview; native execution is planned",
        group: "Commands",
        breadcrumb: ["Commands", "Composer", "Create"],
        icon: <LayoutTemplate size={17} />,
        keywords: "composer mode create draft artifact planned",
        status: "preview",
        action: () => {
          setComposerMode("create");
          setOpen(false);
        },
      },
      {
        id: "composer-research",
        title: "Preview Research composer mode",
        description: "Select the research mode preview; retrieval is planned",
        group: "Commands",
        breadcrumb: ["Commands", "Composer", "Research"],
        icon: <Search size={17} />,
        keywords: "composer mode research sources citations planned",
        status: "preview",
        action: () => {
          setComposerMode("research");
          setOpen(false);
        },
      },
      {
        id: "composer-discuss",
        title: "Preview Discuss composer mode",
        description: "Stage multiple perspectives; native agent orchestration is planned",
        group: "Commands",
        breadcrumb: ["Commands", "Composer", "Discuss"],
        icon: <MessageCircleMore size={17} />,
        keywords: "composer mode discuss debate perspectives synthesis agents planned",
        status: "preview",
        action: () => {
          setComposerMode("discuss");
          setOpen(false);
        },
      },
      {
        id: "density-compact",
        title: "Use compact density",
        description: "Fit more navigation and inspector content on screen",
        group: "Commands",
        breadcrumb: ["Commands", "Appearance", "Compact density"],
        icon: <Gauge size={17} />,
        keywords: "density compact layout appearance",
        action: () => {
          setDensity("compact");
          setOpen(false);
        },
      },
      {
        id: "density-comfortable",
        title: "Use comfortable density",
        description: "Use the balanced default spacing profile",
        group: "Commands",
        breadcrumb: ["Commands", "Appearance", "Comfortable density"],
        icon: <Gauge size={17} />,
        keywords: "density comfortable layout appearance default",
        action: () => {
          setDensity("comfortable");
          setOpen(false);
        },
      },
      {
        id: "density-touch",
        title: "Use touch density",
        description: "Increase hit targets for touch-friendly interaction",
        group: "Commands",
        breadcrumb: ["Commands", "Appearance", "Touch density"],
        icon: <Gauge size={17} />,
        keywords: "density touch layout accessibility",
        action: () => {
          setDensity("touch");
          setOpen(false);
        },
      },
      {
        id: "motion-reduced",
        title: "Reduce interface motion",
        description: "Prefer reduced transitions and animation",
        group: "Commands",
        breadcrumb: ["Commands", "Accessibility", "Reduced motion"],
        icon: <Gauge size={17} />,
        keywords: "motion reduced accessibility animation",
        action: () => {
          setMotion("reduced");
          setOpen(false);
        },
      },
      ...conversations.map<CommandItem>((conversation) => ({
        id: `conversation-${conversation.id}`,
        title: conversation.title,
        description: `${conversation.projectName ?? "Local history"} · ${conversation.excerpt}`,
        group: "Conversations",
        breadcrumb: ["Chats", conversation.projectName ?? "Standalone", conversation.title],
        icon: <MessageSquareText size={17} />,
        keywords: `${conversation.title} ${conversation.excerpt} ${conversation.projectName ?? ""} ${conversation.draft} ${conversation.messages.map((message) => `${message.content} ${message.attachments.map((attachment) => attachment.name).join(" ")}`).join(" ")}`,
        status: conversation.archived ? "preview" : "available",
        action: () => {
          selectConversation(conversation.id);
          setOpen(false);
        },
      })),
      ...conversations.flatMap((conversation) => conversation.messages.map<CommandItem>((message) => ({
        id: `message-${conversation.id}-${message.id}`,
        title: message.content.trim().slice(0, 76) || `${message.role} message`,
        description: `Jump to message · ${conversation.title} · ${message.role} · ${message.status}`,
        group: "Messages",
        breadcrumb: ["Chats", conversation.title, message.role === "assistant" ? "Assistant message" : "User message"],
        icon: <MessageSquareText size={17} />,
        keywords: `${message.content} ${message.role} ${message.status} ${conversation.title} ${conversation.projectName ?? ""} ${message.attachments.map((attachment) => attachment.name).join(" ")}`,
        status: "preview",
        action: () => {
          selectConversation(conversation.id);
          requestMessageNavigation(conversation.id, message.id);
          setOpen(false);
        },
      }))),
      ...projects.map<CommandItem>((project) => ({
        id: `project-${project.id}`,
        title: project.name,
        description: project.description,
        group: "Projects",
        breadcrumb: ["Projects", project.name],
        icon: <FolderKanban size={17} />,
        keywords: `${project.name} ${project.description}`,
        status: project.contextHealth === "ready" ? "available" : "preview",
        action: () => {
          selectProject(project.id);
          setOpen(false);
        },
      })),
      ...projects.flatMap((project) => project.folders.map<CommandItem>((folder) => ({
        id: `file-${project.id}-${folder.id}`,
        title: folder.displayName,
        description: `${project.name} · ${folder.canonicalPath} · ${folder.state}`,
        group: "Files",
        breadcrumb: ["Projects", project.name, "Files", folder.displayName],
        icon: <FileText size={17} />,
        keywords: `${folder.displayName} ${folder.canonicalPath} ${folder.scope} ${folder.state} ${project.name} ${project.description}`,
        status: "preview",
        action: () => {
          selectProject(project.id);
          setOpen(false);
        },
      }))),
      ...memories.map<CommandItem>((memory) => ({
        id: `memory-${memory.id}`,
        title: memory.title || memory.content.slice(0, 58) || "Untitled memory",
        description: `${memory.scopeLabel} · ${memory.kind} · ${memory.status}`,
        group: "Memory",
        breadcrumb: ["Memory", memory.scopeLabel, memory.kind],
        icon: <Brain size={17} />,
        keywords: `${memory.title ?? ""} ${memory.content} ${memory.scopeLabel} ${memory.kind} ${memory.status} ${memory.origin} ${memory.sourceLabel}`,
        status: "preview",
        action: () => {
          setActivity("memory");
          setOpen(false);
        },
      })),
      ...skills.map<CommandItem>((skill) => ({
        id: `skill-${skill.id}`,
        title: skill.name,
        description: `${skill.scope} · ${skill.version} · ${skill.trust}`,
        group: "Skills",
        breadcrumb: ["Skills", skill.scope, skill.name],
        icon: <BookOpen size={17} />,
        keywords: `${skill.name} ${skill.description} ${skill.version} ${skill.source} ${skill.trust} ${skill.permissions.join(" ")}`,
        status: "preview",
        action: () => {
          setActivity("skills");
          setOpen(false);
        },
      })),
      ...artifacts.map<CommandItem>((artifact) => ({
        id: `artifact-${artifact.id}`,
        title: artifact.name,
        description: `${artifact.type} · ${artifact.projectName} · ${artifact.versionCount} revisions`,
        group: "Library",
        breadcrumb: ["Library", artifact.projectName, artifact.name],
        icon: <Library size={17} />,
        keywords: `${artifact.name} ${artifact.type} ${artifact.projectName} ${artifact.sizeLabel} ${artifact.updatedLabel}`,
        status: "preview",
        action: () => {
          setActivity("library");
          setOpen(false);
        },
      })),
      ...providers.flatMap<CommandItem>((provider) => [
        {
          id: `provider-${provider.id}`,
          title: provider.name,
          description: `${provider.kind} · ${provider.state} · ${provider.modelCount} models`,
          group: "Providers",
          breadcrumb: ["Settings", "Providers", provider.name],
          icon: <Server size={17} />,
          keywords: `${provider.name} ${provider.kind} ${provider.providerType} ${provider.endpoint} ${provider.state} ${provider.source}`,
          status: "preview",
          action: () => {
            setActivity("settings");
            setOpen(false);
          },
        },
        ...provider.models.map<CommandItem>((model) => ({
          id: `model-${provider.id}-${model.id}`,
          title: model.displayName,
          description: `${provider.name} · ${model.providerModelId} · ${model.contextLabel} context`,
          group: "Models",
          breadcrumb: ["Settings", "Providers", provider.name, model.displayName],
          icon: <Cpu size={17} />,
          keywords: `${model.displayName} ${model.providerModelId} ${provider.name} ${provider.kind} ${model.status} ${model.capabilities.join(" ")} ${model.contextLabel} ${model.speed}`,
          status: "preview",
          action: () => {
            setActivity("settings");
            setOpen(false);
          },
        })),
      ]),
    ],
    [
      conversations,
      activeConversation,
      activeProject,
      moveConversationToProject,
      projects,
      memories,
      skills,
      artifacts,
      providers,
      selectConversation,
      requestMessageNavigation,
      selectProject,
      resetParameters,
      setConversationArchived,
      setConversationUnread,
      setComposerMode,
      setDensity,
      setInspectorTab,
      setMotion,
      setOpen,
      setTheme,
      toggleConversationPinned,
      toggleInspector,
      toggleSidebar,
      openActiveChatMovePicker,
    ],
  );

  const recentItems = useMemo(
    () => recentCommands
      .map((entry) => items.find((item) => item.id === entry.id))
      .filter((item): item is CommandItem => Boolean(item)),
    [items, recentCommands],
  );

  const parsedQuery = useMemo(() => parsePaletteQuery(query, scope), [query, scope]);
  const changePaletteScope = (nextScope: PaletteScope) => {
    // A typed operator is a convenient shorthand, but an explicit scope-tab
    // or keyboard choice should be able to take over without making the user
    // manually erase that operator first.
    if (parsedQuery.prefix) setQuery(parsedQuery.term);
    setScope(nextScope);
  };
  const filtered = useMemo(() => {
    const normalized = parsedQuery.term.toLowerCase();
    const terms = normalized.split(/\s+/).filter(Boolean);
    const candidates = items.filter((item) => commandMatchesScope(item, parsedQuery.scope));
    if (terms.length === 0) return candidates.slice(0, 24);

    return candidates
      .map((item, index) => {
        const haystack = `${item.title} ${item.description} ${item.keywords}`.toLowerCase();
        const title = item.title.toLowerCase();
        const matches = terms.every((term) => haystack.includes(term));
        const score = !matches
          ? Number.POSITIVE_INFINITY
          : (title === normalized ? 0 : title.startsWith(normalized) ? 1 : haystack.indexOf(normalized) >= 0 ? 2 : 3) * 1000 + index;
        return { item, score };
      })
      .filter((entry) => Number.isFinite(entry.score))
      .sort((left, right) => left.score - right.score)
      .map((entry) => entry.item)
      .slice(0, 24);
  }, [items, parsedQuery]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setScope("all");
    setActiveIndex(0);
    setMovePickerOpen(false);
    setMoveQuery("");
    setMoveStatus(null);
  }, [open]);

  useEffect(() => {
    setActiveIndex(0);
    resultRefs.current = [];
  }, [query, scope]);

  useEffect(() => {
    if (activeIndex < filtered.length) return;
    setActiveIndex(Math.max(filtered.length - 1, 0));
  }, [activeIndex, filtered.length]);

  useEffect(() => {
    resultRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  if (!open) return null;

  return (
    <ModalSurface
      className="command-palette"
      scrimClassName="command-scrim"
      ariaLabel="Omnia search and command palette"
      initialFocusRef={movePickerOpen ? moveSearchRef : inputRef}
      onClose={() => setOpen(false)}
    >
      {movePickerOpen ? (
        <div className="command-palette__move-picker">
          <header className="command-palette__move-header">
            <button
              type="button"
              className="command-palette__move-back"
              onClick={() => {
                setMovePickerOpen(false);
                setMoveStatus(null);
              }}
              aria-label="Back to commands"
              title="Back to commands"
            >
              <ArrowLeft size={16} aria-hidden="true" />
            </button>
            <div>
              <strong>Move active Chat</strong>
              <small>Choose Standalone / Inbox or a Project, then confirm the scope change.</small>
            </div>
          </header>
          <label className="command-palette__move-search">
            <Search size={16} aria-hidden="true" />
            <input
              ref={moveSearchRef}
              value={moveQuery}
              onChange={(event) => setMoveQuery(event.target.value)}
              placeholder="Search Project destinations…"
              aria-label="Search Chat move destinations"
            />
          </label>
          <div
            className="command-palette__move-destinations"
            role="listbox"
            aria-label="Chat move destinations"
          >
            {moveDestinations.length > 0 ? moveDestinations.map((destination, destinationIndex) => {
              const selected = destination.projectId === selectedMoveProjectId;
              return (
                <button
                  key={destination.id}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  aria-disabled={!destination.available}
                  aria-posinset={destinationIndex + 1}
                  aria-setsize={moveDestinations.length}
                  tabIndex={destinationIndex === moveActiveIndex ? 0 : -1}
                  ref={(element) => {
                    moveDestinationRefs.current[destinationIndex] = element;
                  }}
                  className={selected ? "command-palette__move-destination is-selected" : "command-palette__move-destination"}
                  onFocus={() => setMoveActiveIndex(destinationIndex)}
                  onKeyDown={(event) => moveDestinationKeyDown(event, destinationIndex)}
                  onClick={() => {
                    if (!destination.available) {
                      setMoveStatus(`${destination.label} is unavailable. ${destination.unavailableReason ?? "Choose another destination."}`);
                      return;
                    }
                    setMoveStatus(null);
                    setSelectedMoveProjectId(destination.projectId);
                    setMoveActiveIndex(destinationIndex);
                  }}
                >
                  <span className="command-palette__move-destination-copy">
                    <strong>{destination.label}</strong>
                    <small>{destination.description}</small>
                  </span>
                  <span className="command-palette__move-badges">
                    {destination.recent ? <small>Recent</small> : null}
                    {!destination.available ? <small>Unavailable</small> : null}
                    {selected ? (
                      <small>
                        <Check size={11} aria-hidden="true" />
                        {destination.projectId === activeConversation?.projectId ? "Current" : "Selected"}
                      </small>
                    ) : null}
                  </span>
                </button>
              );
            }) : (
              <div className="command-palette__move-empty">No destinations match “{moveQuery}”.</div>
            )}
          </div>
          <div className="command-palette__move-summary" role="status" aria-live="polite">
            <span>From <strong>{activeConversation ? destinationLabel(activeConversation.projectId) : "Unavailable"}</strong></span>
            <span aria-hidden="true">→</span>
            <span>To <strong>{destinationLabel(selectedMoveProjectId)}</strong></span>
          </div>
          <div className="command-palette__move-diff">
            <div><strong>Changes</strong><span>Project instructions, memory, skills, and model defaults recalculate.</span></div>
            <div><strong>Unchanged</strong><span>History, branches, artifacts, and run receipts stay attached.</span></div>
          </div>
          <p className="command-palette__move-boundary">Preview only · renderer-local · no durable write. Ownership changes only after Confirm move.</p>
          {moveStatus ? <p className="command-palette__move-status" role="status">{moveStatus}</p> : null}
          <footer className="command-palette__move-actions">
            <button
              type="button"
              className="button button--ghost"
              onClick={() => {
                setMovePickerOpen(false);
                setMoveStatus(null);
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="button button--primary"
              onClick={confirmActiveChatMove}
              disabled={!activeConversation || selectedMoveProjectId === activeConversation.projectId}
            >
              Confirm move
            </button>
          </footer>
        </div>
      ) : (
        <>
        <label className="command-palette__input">
          <Search size={19} />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter commands, chats, projects, memory, skills, library, providers, or models…"
            role="combobox"
            aria-label="Filter commands, chats, projects, memory, skills, library, providers, and models"
            aria-autocomplete="list"
            aria-controls="command-palette-results"
            aria-expanded="true"
            aria-activedescendant={filtered[activeIndex] ? resultIdForItem(filtered[activeIndex]) : undefined}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActiveIndex((index) => Math.min(index + 1, Math.max(filtered.length - 1, 0)));
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setActiveIndex((index) => Math.max(index - 1, 0));
              }
              if (event.key === "Home") {
                event.preventDefault();
                setActiveIndex(0);
              }
              if (event.key === "End") {
                event.preventDefault();
                setActiveIndex(Math.max(filtered.length - 1, 0));
              }
              if (event.key === "PageDown") {
                event.preventDefault();
                setActiveIndex((index) => Math.min(index + 5, Math.max(filtered.length - 1, 0)));
              }
              if (event.key === "PageUp") {
                event.preventDefault();
                setActiveIndex((index) => Math.max(index - 5, 0));
              }
              if (event.altKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
                event.preventDefault();
                const current = PALETTE_SCOPES.findIndex((candidate) => candidate.id === parsedQuery.scope);
                const direction = event.key === "ArrowRight" ? 1 : -1;
                const nextIndex = (current + direction + PALETTE_SCOPES.length) % PALETTE_SCOPES.length;
                changePaletteScope(PALETTE_SCOPES[nextIndex]?.id ?? "all");
              }
              if (event.key === "Enter") {
                event.preventDefault();
                const item = filtered[activeIndex];
                if (item) runCommand(item);
              }
            }}
          />
          <kbd>Esc</kbd>
        </label>
        <div className="command-palette__scope-bar" role="tablist" aria-label="Command palette scope">
          {PALETTE_SCOPES.map((candidate) => {
            const active = parsedQuery.scope === candidate.id;
            const count = items.filter((item) => commandMatchesScope(item, candidate.id)).length;
            return (
              <button
                key={candidate.id}
                type="button"
                role="tab"
                aria-selected={active}
                className={active ? "command-scope command-scope--active" : "command-scope"}
                onClick={() => {
                  changePaletteScope(candidate.id);
                  inputRef.current?.focus();
                }}
              >
                <span>{candidate.shortLabel}</span>
                <small>{count}</small>
              </button>
            );
          })}
          {parsedQuery.prefix ? (
            <span className="command-query-mode" title="A prefix limits the active scope">
              {parsedQuery.prefix} {paletteScopeLabel(parsedQuery.scope)}
            </span>
          ) : (
            <span className="command-query-hint">Use <kbd>&gt;</kbd> commands · <kbd>@</kbd> chats · <kbd>#</kbd> projects · <kbd>?</kbd> messages · <kbd>~</kbd> files · <kbd>^</kbd> models</span>
          )}
        </div>
        {query.trim() === "" && scope === "all" && recentItems.length > 0 ? (
          <section className="command-palette__recent" aria-label="Recently used commands">
            <div className="command-palette__recent-heading">
              <span><Clock3 size={13} aria-hidden="true" /> Recent in this tab</span>
              <button type="button" className="command-palette__recent-clear" onClick={clearRecentCommands}>
                <Trash2 size={12} aria-hidden="true" />
                Clear
              </button>
            </div>
            <div className="command-palette__recent-list">
              {recentItems.slice(0, 5).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="command-palette__recent-item"
                  onClick={() => runCommand(item)}
                >
                  <span className="command-palette__recent-icon">{item.icon}</span>
                  <span><strong>{item.title}</strong><small>{item.description}</small></span>
                </button>
              ))}
            </div>
            <p className="command-palette__recent-boundary">Renderer-local · session-only · not a durable command log.</p>
          </section>
        ) : null}
        <div id="command-palette-results" className="command-palette__results" role="listbox" aria-label="Search results">
          {filtered.length > 0 ? (
            Array.from(new Set(filtered.map((item) => item.group))).map((group) => (
              <div key={group} role="group" aria-label={group}>
                <span className="command-group-label" aria-hidden="true">{group}</span>
                {filtered.filter((item) => item.group === group).map((item) => {
                  const flatIndex = filtered.indexOf(item);
                  return (
                    <button
                      key={item.id}
                      id={resultIdForItem(item)}
                      ref={(element) => {
                        resultRefs.current[flatIndex] = element;
                      }}
                      type="button"
                      role="option"
                      className={flatIndex === activeIndex ? "command-result command-result--active" : "command-result"}
                      aria-selected={flatIndex === activeIndex}
                      onMouseEnter={() => setActiveIndex(flatIndex)}
                      onFocus={() => setActiveIndex(flatIndex)}
                       onClick={() => runCommand(item)}
                    >
                      <span className="command-result__icon">{item.icon}</span>
                      <span>
                        <strong>{item.title}</strong>
                        <small>{item.description}</small>
                        <em
                          className="command-result__breadcrumb"
                          aria-label={`Location: ${(item.breadcrumb ?? [item.group, item.title]).join(" / ")}`}
                        >
                          {(item.breadcrumb ?? [item.group, item.title]).join(" / ")}
                        </em>
                      </span>
                      <span className="command-result__end">
                        {item.status && item.status !== "available" ? (
                          <em className={`command-result__status command-result__status--${item.status}`}>
                            {item.status === "planned" ? "Planned" : "Preview"}
                          </em>
                        ) : null}
                        {item.shortcut ? <kbd>{shortcutLabel(item.shortcut)}</kbd> : null}
                        <CornerDownLeft size={14} className="command-enter" />
                      </span>
                    </button>
                  );
                })}
              </div>
            ))
          ) : (
            <div className="command-empty"><FileText size={22} /><strong>No results</strong><p>Try a conversation title, project name, or command.</p></div>
          )}
        </div>
        <footer className="command-palette__footer">
          <span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span>
          <span><kbd>PgUp</kbd><kbd>PgDn</kbd> Jump</span>
          <span><kbd>↵</kbd> Open</span>
          <span><KeyRound size={12} /> <span className="command-palette__footer-muted">Shortcut customization planned</span></span>
        </footer>
        </>
      )}
    </ModalSurface>
  );
}
