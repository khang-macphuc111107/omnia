import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Copy, FileCode2, Folder, FolderPlus, FolderTree, GitBranch, HardDrive, Monitor, MoreHorizontal, PanelLeft, PanelRight, Play, Search, Send, SplitSquareHorizontal, Terminal, Workflow, X } from "lucide-react";

import { ModalSurface } from "@/components/modal-surface";
import { editorWorkspaceUrl } from "@/domain/editor-workspace-url";

import "@/styles/sovereign-ide-workbench.css";

import {
  analyzeIdeCodeBuffer,
  computeUnifiedDiffLines,
  createDiskTransferJob,
  createRemoteInputPacket,
  DEFAULT_DISK_VOLUMES,
  DEFAULT_IDE_WORKSPACE_FILES,
  DEFAULT_OMNIA_REMOTE_DAEMON_CONFIG,
  DEFAULT_REMOTE_CAPTURE_SURFACES,
  extractCodeOutlineSymbols,
  findRemoteCaptureSurface,
  generateOmniParserSomTargets,
  inferIdeLanguageFromPath,
  planComputerUseActionSequence,
  searchWorkspaceFilesRipgrep,
  SOVEREIGN_IDE_REMOTE_STORAGE_KEY,
  toDesktopIsolatedInputEvent,
  type ComputerUseActionPlanStep,
  type DiskDirectoryEntry,
  type DiskTransferDirection,
  type DiskTransferJob,
  type DiskVolumeNode,
  type IdeLanguage,
  type IdeVirtualFile,
  type OmniaRemoteDaemonConfig,
  type OmniaRemoteDaemonPermissions,
  type OmniParserSomTarget,
  type RemoteInputDeliveryMethod,
  type RemoteInputEventSpec,
} from "@/domain/sovereign-ide-remote-desktop";
import { useWorkspaceStore } from "@/features/workspace/store";
import { desktop, isDesktopRuntime } from "@/lib/desktop";
import { DEFAULT_IDE_PROJECT_FOLDERS, IdeAgentSidebar, type IdeProjectFolder } from "./ide-agent-sidebar";
import { WorkspaceModeSwitcher } from "./workspace-mode-switcher";
import { WorkbenchWindowControls } from "./workbench-window-controls";
import { OPEN_CODE_IN_IDE_EVENT, takePendingCodeInIdeRequest, type OpenCodeInIdeRequest } from "./markdown";
import { ComputerUseVideoOverlayPanel } from "./computer-use-video-overlay";
import { EmbeddedVscodeStage } from "./embedded-vscode-stage";
import { pickEditorWorkspaceFolder, readEditorWorkspace, removeEditorWorkspaceFolder, updatePreviewWorkspaceFolders, usesNativeEditorTransport, type EditorWorkspace } from "./ide-editor-transport";

export type SovereignWorkbenchTabId =
  | "editor"
  | "remote-screen"
  | "disk-explorer"
  | "remote-daemon";

export type VsCodeActivityViewId =
  | "explorer"
  | "search"
  | "scm"
  | "debug"
  | "kvm"
  | "disk"
  | "extensions";

export type VsCodeBottomPanelTabId =
  | "terminal"
  | "problems"
  | "output"
  | "ports";

interface IdeQuickOpenItem {
  id: string;
  label: string;
  detail: string;
  kind: "file" | "symbol" | "command";
  run: () => void;
}

interface PersistedSovereignWorkbenchState {
  activeTab: SovereignWorkbenchTabId;
  files: IdeVirtualFile[];
  selectedFilePath: string;
  selectedSurfaceId: string;
  selectedDeliveryMethod: RemoteInputDeliveryMethod;
  remoteInputLog: RemoteInputEventSpec[];
  selectedVolumeId: string;
  diskVolumes: DiskVolumeNode[];
  transferJobs: DiskTransferJob[];
  daemonConfig: OmniaRemoteDaemonConfig;
  browserUrl: string;
  splitBrowserOpen: boolean;
}

/**
 * Low-learning-curve layout: only the file tree and the editor are visible by
 * default. Everything else is opt-in from the single "More panels" menu and the
 * choice is remembered per browser profile.
 */
export const IDE_LAYOUT_STORAGE_KEY = "omnia.ide.layout.v1";
export type IdeOptionalPanelId = "terminal" | "search" | "outline" | "openEditors" | "activity" | "ai" | "minimap" | "statusbar";
export const IDE_OPTIONAL_PANELS: readonly { id: IdeOptionalPanelId; label: string; testId?: string }[] = [
  { id: "terminal", label: "Terminal & problems", testId: "ide-toggle-bottom-panel-btn" },
  { id: "search", label: "Search & diff" },
  { id: "outline", label: "Outline" },
  { id: "openEditors", label: "Open editors list" },
  { id: "activity", label: "Activity bar (SCM, debug, remote)" },
  { id: "ai", label: "AI assistant" },
  { id: "minimap", label: "Minimap" },
  { id: "statusbar", label: "Status bar" },
];
interface IdeLayoutPrefs { tree: boolean; treeWidth: number; aiWidth: number; panels: Record<IdeOptionalPanelId, boolean> }
const DEFAULT_IDE_LAYOUT: IdeLayoutPrefs = {
  tree: true,
  treeWidth: 240,
  aiWidth: 360,
  panels: { terminal: false, search: false, outline: false, openEditors: false, activity: false, ai: false, minimap: false, statusbar: false },
};
const IDE_EDITOR_MIN_WIDTH = 320;
const IDE_TREE_AUTO_COLLAPSE_WIDTH = 900;

function localEditorTabId(path: string): string {
  return `ide-editor-tab-${encodeURIComponent(path).replaceAll("%", "_")}`;
}

function localPanelTabId(id: VsCodeBottomPanelTabId): string {
  return `ide-bottom-panel-tab-${id}`;
}

function clampWidth(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
}

function loadIdeLayoutPrefs(): IdeLayoutPrefs {
  try {
    const raw = window.localStorage?.getItem?.(IDE_LAYOUT_STORAGE_KEY);
    if (!raw) return DEFAULT_IDE_LAYOUT;
    const parsed = JSON.parse(raw) as Partial<IdeLayoutPrefs>;
    const panels = { ...DEFAULT_IDE_LAYOUT.panels };
    for (const id of Object.keys(panels) as IdeOptionalPanelId[]) {
      if (typeof parsed.panels?.[id] === "boolean") panels[id] = parsed.panels[id];
    }
    return {
      tree: typeof parsed.tree === "boolean" ? parsed.tree : DEFAULT_IDE_LAYOUT.tree,
      treeWidth: clampWidth(parsed.treeWidth, 180, 480, DEFAULT_IDE_LAYOUT.treeWidth),
      aiWidth: clampWidth(parsed.aiWidth, 260, 640, DEFAULT_IDE_LAYOUT.aiWidth),
      panels,
    };
  } catch {
    return DEFAULT_IDE_LAYOUT;
  }
}

function saveIdeLayoutPrefs(prefs: IdeLayoutPrefs): void {
  try {
    window.localStorage?.setItem?.(IDE_LAYOUT_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Storage can be unavailable (private mode, quota); the layout still works.
  }
}

const QUICK_REMOTE_CHORDS: readonly { label: string; chord: string }[] = [
  { label: "F12 DevTools", chord: "F12" },
  { label: "Ctrl+Shift+I", chord: "Ctrl+Shift+I" },
  { label: "Alt+Tab", chord: "Alt+Tab" },
  { label: "Win+D", chord: "Win+D" },
  { label: "Ctrl+C", chord: "Ctrl+C" },
  { label: "Ctrl+V", chord: "Ctrl+V" },
];

const LANGUAGE_BADGE_MAP: Record<
  IdeLanguage,
  { badge: string; color: string; bg: string }
> = {
  typescript: {
    badge: "TS",
    color: "var(--ide-fg)",
    bg: "var(--ide-raised)",
  },
  rust: {
    badge: "RS",
    color: "var(--ide-fg)",
    bg: "var(--ide-raised)",
  },
  python: {
    badge: "PY",
    color: "var(--ide-fg)",
    bg: "var(--ide-raised)",
  },
  powershell: {
    badge: "PS1",
    color: "var(--ide-fg)",
    bg: "var(--ide-raised)",
  },
  json: {
    badge: "JSON",
    color: "var(--ide-fg)",
    bg: "var(--ide-raised)",
  },
  markdown: {
    badge: "MD",
    color: "var(--ide-fg)",
    bg: "var(--ide-raised)",
  },
};

function loadInitialPersistedState(): PersistedSovereignWorkbenchState {
  const fallback: PersistedSovereignWorkbenchState = {
    activeTab: "editor",
    files: [...DEFAULT_IDE_WORKSPACE_FILES],
    selectedFilePath: DEFAULT_IDE_WORKSPACE_FILES[0]!.path,
    selectedSurfaceId: DEFAULT_REMOTE_CAPTURE_SURFACES[0]!.id,
    selectedDeliveryMethod: "win32-postmessage-isolated",
    remoteInputLog: [],
    selectedVolumeId: DEFAULT_DISK_VOLUMES[1]!.volumeId,
    diskVolumes: DEFAULT_DISK_VOLUMES.map((vol) => ({
      ...vol,
      entries: [...vol.entries],
    })),
    transferJobs: [],
    daemonConfig: {
      ...DEFAULT_OMNIA_REMOTE_DAEMON_CONFIG,
      permissions: { ...DEFAULT_OMNIA_REMOTE_DAEMON_CONFIG.permissions },
    },
    browserUrl: "http://127.0.0.1:1420/sovereign-preview",
    splitBrowserOpen: false,
  };

  if (typeof window === "undefined") {
    return fallback;
  }

  try {
    const storage =
      typeof window !== "undefined" ? window.localStorage : undefined;
    const raw =
      storage && typeof storage.getItem === "function"
        ? storage.getItem(SOVEREIGN_IDE_REMOTE_STORAGE_KEY)
        : null;
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<PersistedSovereignWorkbenchState>;
    return {
      activeTab: parsed.activeTab ?? fallback.activeTab,
      files:
        Array.isArray(parsed.files) && parsed.files.length > 0
          ? parsed.files
          : fallback.files,
      selectedFilePath: parsed.selectedFilePath ?? fallback.selectedFilePath,
      selectedSurfaceId: parsed.selectedSurfaceId ?? fallback.selectedSurfaceId,
      selectedDeliveryMethod:
        parsed.selectedDeliveryMethod ?? fallback.selectedDeliveryMethod,
      remoteInputLog: Array.isArray(parsed.remoteInputLog)
        ? parsed.remoteInputLog
        : fallback.remoteInputLog,
      selectedVolumeId: parsed.selectedVolumeId ?? fallback.selectedVolumeId,
      diskVolumes:
        Array.isArray(parsed.diskVolumes) && parsed.diskVolumes.length > 0
          ? parsed.diskVolumes
          : fallback.diskVolumes,
      transferJobs: Array.isArray(parsed.transferJobs)
        ? parsed.transferJobs
        : fallback.transferJobs,
      daemonConfig: parsed.daemonConfig
        ? {
            ...fallback.daemonConfig,
            ...parsed.daemonConfig,
            permissions: {
              ...fallback.daemonConfig.permissions,
              ...(parsed.daemonConfig.permissions ?? {}),
            },
          }
        : fallback.daemonConfig,
      browserUrl: parsed.browserUrl ?? fallback.browserUrl,
      splitBrowserOpen:
        typeof parsed.splitBrowserOpen === "boolean"
          ? parsed.splitBrowserOpen
          : fallback.splitBrowserOpen,
    };
  } catch {
    return fallback;
  }
}

export function SovereignIdeRemoteWorkbench(): React.JSX.Element {
  const activeConversationId = useWorkspaceStore(
    (state) => state.activeConversationId,
  );
  const updateDraft = useWorkspaceStore((state) => state.updateDraft);

  const initialState = useMemo(() => loadInitialPersistedState(), []);

  const [activeTab, setActiveTab] = useState<SovereignWorkbenchTabId>(
    initialState.activeTab,
  );
  const [realVsCodeEmbedOpen, setRealVsCodeEmbedOpen] = useState<boolean>(true);
  const initialLayout = useMemo(() => loadIdeLayoutPrefs(), []);
  const [panels, setPanels] = useState<Record<IdeOptionalPanelId, boolean>>(initialLayout.panels);
  const setPanel = (id: IdeOptionalPanelId, next: boolean | ((open: boolean) => boolean)): void => {
    setPanels((prev) => {
      const value = typeof next === "function" ? next(prev[id]) : next;
      return prev[id] === value ? prev : { ...prev, [id]: value };
    });
  };
  const agySidebarOpen = panels.ai;
  const setAgySidebarOpen = (next: boolean | ((open: boolean) => boolean)): void => setPanel("ai", next);
  const nativeEditor = usesNativeEditorTransport();
  const [projectFolders, setProjectFolders] = useState<readonly IdeProjectFolder[]>(() => nativeEditor ? [] : DEFAULT_IDE_PROJECT_FOLDERS);
  const [workspaceTarget, setWorkspaceTarget] = useState("multi-root");
  const [workspaceRevision, setWorkspaceRevision] = useState(0);
  const [workspacePath, setWorkspacePath] = useState<string | null>(null);
  const [projectPanelRequest, setProjectPanelRequest] = useState(0);
  const [agentUtilityPanel, setAgentUtilityPanel] = useState<"projects" | "sessions" | "knowledge" | "tools">("projects");
  const [toolsMenuOpen, setToolsMenuOpen] = useState(false);
  const toolsMenuRef = useRef<HTMLDivElement | null>(null);
  const toolsMenuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [selectedCode, setSelectedCode] = useState("");
  const screenStreamRef = useRef<MediaStream | null>(null);
  const screenVideoRef = useRef<HTMLVideoElement | null>(null);
  const [activityView, setActivityView] =
    useState<VsCodeActivityViewId>("explorer");
  const [primarySidebarOpen, setPrimarySidebarOpenState] = useState<boolean>(initialLayout.tree);
  const [primarySidebarWidth, setPrimarySidebarWidth] = useState<number>(initialLayout.treeWidth);
  const [agySidebarWidth, setAgySidebarWidth] = useState<number>(initialLayout.aiWidth);
  // Root geometry drives the editor-first layout guards (tree auto-collapse,
  // never squeezing the editor below IDE_EDITOR_MIN_WIDTH).
  const rootRef = useRef<HTMLElement | null>(null);
  const [rootWidth, setRootWidth] = useState(0);
  const [embeddedInShell, setEmbeddedInShell] = useState(false);
  // Below the auto-collapse width the tree hides unless the user re-opens it.
  const [narrowTreeOverride, setNarrowTreeOverride] = useState(false);
  const isNarrow = rootWidth > 0 && rootWidth < IDE_TREE_AUTO_COLLAPSE_WIDTH;
  const treeVisible = primarySidebarOpen && (!isNarrow || narrowTreeOverride);
  const setPrimarySidebarOpen = (next: boolean | ((open: boolean) => boolean)): void => {
    const value = typeof next === "function" ? next(treeVisible) : next;
    if (isNarrow) setNarrowTreeOverride(value);
    if (!isNarrow || value) setPrimarySidebarOpenState(value);
  };
  const [openTabPaths, setOpenTabPaths] = useState<readonly string[]>(() =>
    initialState.files.some((file) => file.path === initialState.selectedFilePath) ? [initialState.selectedFilePath] : [],
  );
  const editorTabListRef = useRef<HTMLDivElement | null>(null);
  const editorTabRefs = useRef(new Map<string, HTMLButtonElement>());
  const bottomPanelTabRefs = useRef(new Map<VsCodeBottomPanelTabId, HTMLButtonElement>());
  const pendingEditorTabFocusRef = useRef<string | null>(null);
  const [isResizingIdePanel, setIsResizingIdePanel] = useState<boolean>(false);
  const ideResizeRef = useRef<{
    kind: "primary" | "ai";
    startX: number;
    startWidth: number;
  } | null>(null);
  const bottomPanelOpen = panels.terminal;
  const setBottomPanelOpen = (next: boolean | ((open: boolean) => boolean)): void => setPanel("terminal", next);
  const [bottomPanelTab, setBottomPanelTab] =
    useState<VsCodeBottomPanelTabId>("terminal");
  const [remoteDrawerOpen, setRemoteDrawerOpen] = useState<boolean>(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState<boolean>(false);
  const [commandPaletteQuery, setCommandPaletteQuery] = useState<string>("");
  const [commandPaletteIndex, setCommandPaletteIndex] = useState(0);
  const quickOpenId = useId();
  const quickOpenContentRef = useRef<HTMLDivElement | null>(null);
  const quickOpenListRef = useRef<HTMLDivElement | null>(null);
  const codeEditorRef = useRef<HTMLTextAreaElement | null>(null);
  const pendingEditorNavigationRef = useRef<{ path: string; line: number } | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (event.defaultPrevented || event.isComposing || event.altKey || !(event.ctrlKey || event.metaKey) || !(key === "p" || (key === "o" && event.shiftKey))) return;
      const root = rootRef.current;
      if (!root || root.closest('[hidden], [inert], [aria-hidden="true"]')) return;
      // An unrelated modal owns its shortcuts. VS Code inside the iframe keeps
      // its native Quick Open because iframe key events do not bubble here.
      if (event.target instanceof Node && event.target !== document.body && event.target !== document.documentElement && !root.contains(event.target) && !quickOpenContentRef.current?.contains(event.target)) return;
      event.preventDefault();
      setCommandPaletteQuery(key === "o" ? "@" : event.shiftKey ? ">" : "");
      setCommandPaletteIndex(0);
      setToolsMenuOpen(false);
      setCommandPaletteOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!isResizingIdePanel) return undefined;
    const onMove = (event: PointerEvent) => {
      const active = ideResizeRef.current;
      if (!active) return;
      if (active.kind === "primary") {
        const next = Math.min(480, Math.max(180, active.startWidth + (event.clientX - active.startX)));
        setPrimarySidebarWidth(Math.round(next));
      } else {
        const next = Math.min(640, Math.max(260, active.startWidth + (active.startX - event.clientX)));
        setAgySidebarWidth(Math.round(next));
      }
    };
    const onUp = () => {
      ideResizeRef.current = null;
      setIsResizingIdePanel(false);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    window.addEventListener("blur", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      window.removeEventListener("blur", onUp);
    };
  }, [isResizingIdePanel]);

  const startIdePanelResize = (kind: "primary" | "ai", event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.focus();
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // Synthetic pointer events in WebView2/automation may not have an active pointerId
    }
    ideResizeRef.current = {
      kind,
      startX: event.clientX,
      startWidth: kind === "primary" ? primarySidebarWidth : agySidebarWidth,
    };
    setIsResizingIdePanel(true);
  };
  const handleIdePanelResizeKeyDown = (kind: "primary" | "ai", event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229
      || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    const minimum = kind === "primary" ? 180 : 260;
    const maximum = kind === "primary" ? 480 : 640;
    const growKey = kind === "primary" ? "ArrowRight" : "ArrowLeft";
    const shrinkKey = kind === "primary" ? "ArrowLeft" : "ArrowRight";
    if (![growKey, shrinkKey, "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const update = (width: number): number => event.key === "Home" ? minimum : event.key === "End" ? maximum
      : Math.min(maximum, Math.max(minimum, width + (event.key === growKey ? 16 : -16)));
    if (kind === "primary") setPrimarySidebarWidth(update);
    else setAgySidebarWidth(update);
  };
  const isAutomatedTestEnv = typeof navigator !== "undefined" && /jsdom|happy-dom/i.test(navigator.userAgent ?? "");
  const isPureEmbeddedVsCode = realVsCodeEmbedOpen && !isAutomatedTestEnv && !(remoteDrawerOpen && activeTab !== "editor");
  const activeProject = projectFolders.find((folder) => folder.path === workspaceTarget);
  const vscodeWorkspaceUrl = editorWorkspaceUrl(workspaceTarget === "multi-root" || !activeProject
    ? { workspacePath, folderPath: projectFolders[0]?.path ?? null }
    : { folderPath: activeProject.path });

  useEffect(() => {
    if (isAutomatedTestEnv) return;
    const controller = new AbortController();
    void readEditorWorkspace(controller.signal).then((document) => {
      if (typeof document.workspacePath === "string" && document.workspacePath.trim()) setWorkspacePath(document.workspacePath);
      if (Array.isArray(document.folders) && (document.folders.length || nativeEditor)) setProjectFolders(document.folders.map((folder) => ({ ...folder, name: nativeEditor ? folder.name : DEFAULT_IDE_PROJECT_FOLDERS.find((known) => known.path.toLowerCase() === folder.path.toLowerCase())?.name ?? folder.name })));
    }).catch(() => undefined);
    return () => controller.abort();
  }, [isAutomatedTestEnv, nativeEditor]);

  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      const root = rootRef.current;
      if (event.defaultPrevented || event.isComposing || !root || root.closest('[hidden], [inert], [aria-hidden="true"]')) return;
      const target = event.target instanceof Node ? event.target : document.activeElement;
      if (!target || !root.contains(target)) return;
      if (target instanceof Element && target.closest('[role="dialog"][aria-modal="true"]')) return;
      if (event.ctrlKey && event.altKey && !event.metaKey && !event.shiftKey && event.key.toLowerCase() === "b") {
        event.preventDefault(); setAgySidebarOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, []);

  useEffect(() => () => { screenStreamRef.current?.getTracks?.().forEach((track) => track.stop()); }, []);

  async function saveWorkspaceFolders(folders: readonly IdeProjectFolder[]): Promise<void> {
    const document = await updatePreviewWorkspaceFolders(folders);
    if (!Array.isArray(document.folders) || !document.folders.length) throw new Error("The workspace bridge did not return valid folders.");
    applyWorkspace(document);
  }

  function applyWorkspace(document: EditorWorkspace): void {
    const unchanged = document.workspacePath === workspacePath && document.folders.length === projectFolders.length
      && document.folders.every((folder, index) => {
        const current = projectFolders[index];
        return current?.id === folder.id && current?.name === folder.name && current?.path === folder.path;
      });
    if (unchanged) return;
    if (typeof document.workspacePath === "string" && document.workspacePath.trim()) setWorkspacePath(document.workspacePath);
    setProjectFolders(document.folders); setWorkspaceTarget("multi-root"); setWorkspaceRevision((revision) => revision + 1);
  }

  async function pickProjectFolder(): Promise<void> {
    applyWorkspace(await pickEditorWorkspaceFolder());
  }

  async function removeProjectFolder(folderPath: string): Promise<void> {
    if (!nativeEditor) return saveWorkspaceFolders(projectFolders.filter((folder) => folder.path !== folderPath));
    const folder = projectFolders.find((item) => item.path === folderPath);
    if (!folder?.id) throw new Error("Select this workspace folder again before removing it.");
    applyWorkspace(await removeEditorWorkspaceFolder(folder.id));
  }

  async function addProjectFolder(folderPath: string): Promise<void> {
    const normalized = folderPath.trim().replaceAll("/", "\\").replace(/\\$/, "");
    if (!/^[A-Za-z]:\\/.test(normalized)) throw new Error("Enter an absolute project folder, for example D:\\Projects\\app.");
    if (projectFolders.some((folder) => folder.path.toLowerCase() === normalized.toLowerCase())) throw new Error("This folder is already in the workspace.");
    await saveWorkspaceFolders([...projectFolders, { name: normalized.split("\\").at(-1) || normalized, path: normalized }]);
  }

  function openRemotePanel(tab: SovereignWorkbenchTabId): void {
    setActiveTab(tab); setRemoteDrawerOpen(tab !== "editor"); setToolsMenuOpen(false);
  }

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    setEmbeddedInShell(Boolean(root.closest(".ag-workspace, .vf-shell__workspace")));
    const measure = () => setRootWidth(Math.round(root.getBoundingClientRect().width));
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!isNarrow) setNarrowTreeOverride(false);
  }, [isNarrow]);

  useEffect(() => {
    if (isResizingIdePanel) return;
    saveIdeLayoutPrefs({ tree: primarySidebarOpen, treeWidth: primarySidebarWidth, aiWidth: agySidebarWidth, panels });
  }, [primarySidebarOpen, primarySidebarWidth, agySidebarWidth, panels, isResizingIdePanel]);

  useEffect(() => {
    if (!toolsMenuOpen) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target instanceof Node ? event.target : document.activeElement;
      if (target && target !== document.body && !toolsMenuRef.current?.contains(target)) return;
      event.preventDefault();
      setToolsMenuOpen(false);
      if (toolsMenuRef.current?.contains(document.activeElement)) toolsMenuTriggerRef.current?.focus();
    };
    const onPointer = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || !toolsMenuRef.current?.contains(event.target)) setToolsMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("pointerdown", onPointer); };
  }, [toolsMenuOpen]);


  const [files, setFiles] = useState<IdeVirtualFile[]>(initialState.files);
  const [selectedFilePath, setSelectedFilePathState] = useState<string>(
    initialState.selectedFilePath,
  );
  useEffect(() => {
    if (commandPaletteOpen || !pendingEditorNavigationRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      const navigation = pendingEditorNavigationRef.current;
      const editor = codeEditorRef.current;
      if (!navigation || !editor || navigation.path !== selectedFilePath) return;
      pendingEditorNavigationRef.current = null;
      const offset = editor.value.split("\n").slice(0, navigation.line - 1).reduce((length, line) => length + line.length + 1, 0);
      editor.focus();
      editor.setSelectionRange(offset, offset);
      const lineHeight = Number.parseFloat(window.getComputedStyle(editor).lineHeight) || 18;
      editor.scrollTop = Math.max(0, (navigation.line - 3) * lineHeight);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [commandPaletteOpen, selectedFilePath]);
  /** Opening a file selects it and adds an editor tab (one tab per file). */
  function openFile(path: string): void {
    setSelectedFilePathState(path);
    setOpenTabPaths((prev) => (prev.includes(path) ? prev : [...prev, path]));
  }

  function focusEditorTab(path: string): void {
    const focus = () => {
      const tab = editorTabRefs.current.get(path);
      tab?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
      tab?.focus();
    };
    // The next tab already exists in the tablist, so restore focus immediately
    // for keyboard users. A frame later also covers a close/remount where the
    // selected button was recreated by React.
    focus();
    if (typeof window.requestAnimationFrame === "function") window.requestAnimationFrame(focus);
  }

  function handleEditorTabKeyDown(path: string, event: React.KeyboardEvent<HTMLButtonElement>): void {
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229
      || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const index = openTabPaths.indexOf(path);
    if (index < 0 || openTabPaths.length < 2) return;
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % openTabPaths.length;
    if (event.key === "ArrowLeft") nextIndex = (index - 1 + openTabPaths.length) % openTabPaths.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = openTabPaths.length - 1;
    if (nextIndex === null || nextIndex === index) return;
    event.preventDefault();
    event.stopPropagation();
    const nextPath = openTabPaths[nextIndex]!;
    openFile(nextPath);
    focusEditorTab(nextPath);
  }

  function closeFileTab(path: string): void {
    setOpenTabPaths((prev) => {
      const index = prev.indexOf(path);
      if (index < 0) return prev;
      const next = prev.filter((item) => item !== path);
      if (path === selectedFilePath) {
        const nextPath = next.length ? next[Math.min(index, next.length - 1)]! : "";
        pendingEditorTabFocusRef.current = nextPath;
        if (nextPath) setSelectedFilePathState(nextPath);
      }
      return next;
    });
  }

  useEffect(() => {
    const pending = pendingEditorTabFocusRef.current;
    if (pending === null) return;
    pendingEditorTabFocusRef.current = null;
    if (pending && openTabPaths.includes(pending)) focusEditorTab(pending);
    else editorTabListRef.current?.focus();
  }, [openTabPaths]);

  function handleBottomPanelTabKeyDown(id: VsCodeBottomPanelTabId, event: React.KeyboardEvent<HTMLButtonElement>): void {
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229
      || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const panelIds: VsCodeBottomPanelTabId[] = ["terminal", "problems", "output", "ports"];
    const index = panelIds.indexOf(id);
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % panelIds.length;
    if (event.key === "ArrowLeft") nextIndex = (index - 1 + panelIds.length) % panelIds.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = panelIds.length - 1;
    if (nextIndex === null || nextIndex === index) return;
    event.preventDefault();
    event.stopPropagation();
    const nextId = panelIds[nextIndex]!;
    setBottomPanelTab(nextId);
    setBottomPanelOpen(true);
    bottomPanelTabRefs.current.get(nextId)?.focus();
  }
  const [cursorLine, setCursorLine] = useState<number>(1);
  const [cursorCol, setCursorCol] = useState<number>(1);
  const [showInlineDiff, setShowInlineDiff] = useState<boolean>(false);
  const [ripgrepQuery, setRipgrepQuery] = useState<string>("Sovereign");
  const [ripgrepRegex, setRipgrepRegex] = useState<boolean>(false);
  const [newIdeFilePath, setNewIdeFilePath] = useState<string>("");
  const [terminalLogs, setTerminalLogs] = useState<string[]>([
    "[Local command planner] No shell process is attached. Use the real VS Code terminal to execute commands.",
  ]);
  const [chatSyncFeedback, setChatSyncFeedback] = useState<string | null>(null);
  const [codeNavigationPreview, setCodeNavigationPreview] = useState<OpenCodeInIdeRequest | null>(null);
  const [codePreviewError, setCodePreviewError] = useState<string | null>(null);
  // The code action is navigation, never implicit permission to apply a patch.
  // Consume the pending request when lazy mounting, and listen while mounted.
  const navigableFilesRef = useRef(files);
  navigableFilesRef.current = files;
  useEffect(() => {
    const navigate = (request: OpenCodeInIdeRequest | null) => {
      if (!request || typeof request.code !== "string" || typeof request.language !== "string") return;
      const locator = typeof request.filename === "string" ? request.filename.replaceAll("\\", "/").replace(/^\.\//, "") : null;
      const existing = locator ? navigableFilesRef.current.find((file) => file.path.replaceAll("\\", "/") === locator) : null;
      setActiveTab("editor");
      setRemoteDrawerOpen(false);
      setCodePreviewError(null);
      if (existing) {
        openFile(existing.path);
        setRealVsCodeEmbedOpen(false);
        setCursorLine(Math.max(1, Number.parseInt(request.lineRange ?? "1", 10) || 1));
        setCursorCol(1);
        setCodeNavigationPreview(null);
      } else {
        // A fenced filename is not proof of a disk file. Show its exact source
        // read-only rather than creating/overwriting a project buffer.
        setCodeNavigationPreview(request);
      }
    };
    const onRequest = (event: Event) => {
      const pending = takePendingCodeInIdeRequest();
      navigate(pending ?? (event as CustomEvent<OpenCodeInIdeRequest>).detail);
    };
    window.addEventListener(OPEN_CODE_IN_IDE_EVENT, onRequest);
    navigate(takePendingCodeInIdeRequest());
    return () => window.removeEventListener(OPEN_CODE_IN_IDE_EVENT, onRequest);
  }, []);
  const [splitBrowserOpen, setSplitBrowserOpen] = useState<boolean>(
    initialState.splitBrowserOpen,
  );
  const [browserUrl, setBrowserUrl] = useState<string>(initialState.browserUrl);
  const [browserDomInspection, setBrowserDomInspection] = useState<string>(
    "Preview not inspected. Open Browser mode for live page inspection.",
  );

  // Perspective 2: Multi-Monitor & App Window Screen Share + OmniParser SoM + Remote Input
  const [selectedSurfaceId, setSelectedSurfaceId] = useState<string>(
    initialState.selectedSurfaceId,
  );
  const [selectedDeliveryMethod, setSelectedDeliveryMethod] =
    useState<RemoteInputDeliveryMethod>(initialState.selectedDeliveryMethod);
  const [screenShareActive, setScreenShareActive] = useState<boolean>(false);
  const [screenShareStatus, setScreenShareStatus] = useState<string>(
    "Idle — Start screen sharing to request capture permission",
  );
  const [somOverlayEnabled, setSomOverlayEnabled] = useState<boolean>(true);
  const [_selectedSomMark, setSelectedSomMark] = useState<number>(1);
  const [computerUseGoal, setComputerUseGoal] = useState<string>(
    "npx vitest run --changed",
  );
  const [computerUsePlan, setComputerUsePlan] = useState<
    ComputerUseActionPlanStep[]
  >([]);
  const [remoteKeyboardText, setRemoteKeyboardText] = useState<string>("");
  const [remoteInputLog, setRemoteInputLog] = useState<RemoteInputEventSpec[]>(
    initialState.remoteInputLog,
  );

  // Perspective 3: Remote & Local Disk Explorer
  const [diskVolumes, setDiskVolumes] = useState<DiskVolumeNode[]>(
    initialState.diskVolumes,
  );
  const [selectedVolumeId, setSelectedVolumeId] = useState<string>(
    initialState.selectedVolumeId,
  );
  const [selectedDiskEntryPath, setSelectedDiskEntryPath] = useState<string>(
    initialState.diskVolumes[1]?.entries[2]?.path ??
      "D:\\Omnia\\repos\\omnia\\package.json",
  );
  const [newDiskFileName, setNewDiskFileName] = useState<string>("");
  const [transferDirection, setTransferDirection] =
    useState<DiskTransferDirection>("local-to-remote");
  const [transferJobs, setTransferJobs] = useState<DiskTransferJob[]>(
    initialState.transferJobs,
  );

  // Perspective 4: Omnia Remote Control Daemon
  const [daemonConfig, setDaemonConfig] = useState<OmniaRemoteDaemonConfig>(
    initialState.daemonConfig,
  );
  const [tokenCopiedBanner, setTokenCopiedBanner] = useState<string | null>(
    null,
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const storage = window.localStorage;
      if (!storage || typeof storage.setItem !== "function") return;
      const snapshot: PersistedSovereignWorkbenchState = {
        activeTab,
        files,
        selectedFilePath,
        selectedSurfaceId,
        selectedDeliveryMethod,
        remoteInputLog: remoteInputLog.slice(0, 50),
        selectedVolumeId,
        diskVolumes,
        transferJobs: transferJobs.slice(0, 30),
        daemonConfig,
        browserUrl,
        splitBrowserOpen,
      };
      storage.setItem(
        SOVEREIGN_IDE_REMOTE_STORAGE_KEY,
        JSON.stringify(snapshot),
      );
    } catch {
      // Ignore storage quota errors in constrained environments
    }
  }, [
    activeTab,
    files,
    selectedFilePath,
    selectedSurfaceId,
    selectedDeliveryMethod,
    remoteInputLog,
    selectedVolumeId,
    diskVolumes,
    transferJobs,
    daemonConfig,
    browserUrl,
    splitBrowserOpen,
  ]);

  const activeFile = useMemo(
    () =>
      files.find((file) => file.path === selectedFilePath) ??
      files[0] ??
      DEFAULT_IDE_WORKSPACE_FILES[0]!,
    [files, selectedFilePath],
  );

  const baselineFileContent = useMemo(() => {
    const baseline = DEFAULT_IDE_WORKSPACE_FILES.find(
      (file) => file.path === activeFile.path,
    );
    return baseline ? baseline.content : "";
  }, [activeFile.path]);

  const codeAnalysis = useMemo(
    () => analyzeIdeCodeBuffer(activeFile),
    [activeFile],
  );

  const outlineSymbols = useMemo(
    () => extractCodeOutlineSymbols(activeFile.content, activeFile.language),
    [activeFile.content, activeFile.language],
  );

  const unifiedDiffLines = useMemo(
    () => computeUnifiedDiffLines(baselineFileContent, activeFile.content),
    [baselineFileContent, activeFile.content],
  );

  const diffStats = useMemo(() => {
    let added = 0;
    let removed = 0;
    for (const line of unifiedDiffLines) {
      if (line.kind === "added") added += 1;
      else if (line.kind === "removed") removed += 1;
    }
    return { added, removed };
  }, [unifiedDiffLines]);

  const ripgrepMatches = useMemo(
    () =>
      searchWorkspaceFilesRipgrep(files, ripgrepQuery, {
        regex: ripgrepRegex,
        caseSensitive: false,
      }),
    [files, ripgrepQuery, ripgrepRegex],
  );

  const selectedSurface = useMemo(
    () =>
      findRemoteCaptureSurface(
        selectedSurfaceId,
        DEFAULT_REMOTE_CAPTURE_SURFACES,
      ),
    [selectedSurfaceId],
  );

  const somTargets = useMemo(
    () => generateOmniParserSomTargets(selectedSurface),
    [selectedSurface],
  );

  const selectedVolume = useMemo(
    () =>
      diskVolumes.find((vol) => vol.volumeId === selectedVolumeId) ??
      diskVolumes[0] ??
      DEFAULT_DISK_VOLUMES[0]!,
    [diskVolumes, selectedVolumeId],
  );

  const selectedDiskEntry = useMemo(
    () =>
      selectedVolume.entries.find(
        (entry) => entry.path === selectedDiskEntryPath,
      ) ??
      selectedVolume.entries[0] ??
      null,
    [selectedVolume, selectedDiskEntryPath],
  );

  const activeOutlineSymbol = useMemo(() => {
    if (outlineSymbols.length === 0) return null;
    let current = outlineSymbols[0]!;
    for (const sym of outlineSymbols) {
      if (sym.line <= cursorLine) {
        current = sym;
      }
    }
    return current;
  }, [outlineSymbols, cursorLine]);

  const activeFileLines = useMemo(() => {
    const content = activeFile.content ?? "";
    return content.length === 0 ? [""] : content.split(/\r?\n/);
  }, [activeFile.content]);

  const modifiedFilesCount = useMemo(
    () => files.filter((f) => f.isModified).length,
    [files],
  );

  function handleCodeChange(nextContent: string): void {
    const nextLineCount =
      nextContent.length === 0 ? 1 : nextContent.split(/\r?\n/).length;
    const nowIso = new Date().toISOString();
    setFiles((current) =>
      current.map((file) =>
        file.path === activeFile.path
          ? {
              ...file,
              content: nextContent,
              isModified: true,
              lineCount: nextLineCount,
              lastSavedAt: nowIso,
            }
          : file,
      ),
    );
  }

  function handleCreateIdeFile(): void {
    const trimmed = newIdeFilePath.trim();
    if (!trimmed) return;
    if (files.some((f) => f.path === trimmed)) {
      openFile(trimmed);
      setNewIdeFilePath("");
      return;
    }
    const language = inferIdeLanguageFromPath(trimmed);
    const created: IdeVirtualFile = {
      path: trimmed,
      language,
      content: `// Sovereign IDE File: ${trimmed}\n`,
      isModified: true,
      lineCount: 2,
      lastSavedAt: new Date().toISOString(),
    };
    setFiles((prev) => [...prev, created]);
    openFile(trimmed);
    setNewIdeFilePath("");
  }

  function handleRunInTerminal(): void {
    const cmd = codeAnalysis.quickRunCommand;
    const statusLine = `[Local command plan ${new Date().toISOString()}] $ ${cmd} — Not executed. Run this command in the embedded VS Code terminal.`;
    setBottomPanelOpen(true);
    setBottomPanelTab("terminal");
    setTerminalLogs((prev) => [statusLine, ...prev.slice(0, 19)]);
  }

  function handleSendFileToActiveChat(): void {
    const payload = [
      `### Sovereign IDE Buffer (\`${activeFile.path}\` • ${activeFile.language})`,
      `- Symbols: ${codeAnalysis.symbolCount} | Lines: ${codeAnalysis.lineCount} | Brackets: ${codeAnalysis.bracketBalance.summary}`,
      `\`\`\`${activeFile.language}`,
      activeFile.content,
      `\`\`\``,
    ].join("\n");

    updateDraft(payload);
    setChatSyncFeedback(
      `Added ${activeFile.path} (${codeAnalysis.lineCount} lines) to Chat ${activeConversationId || "active"}`,
    );
  }

  async function handleStartLiveScreenShare(): Promise<void> {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      setScreenShareActive(false);
      setScreenShareStatus("Screen capture unavailable. Use a secure browser context or a configured native capture adapter.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      screenStreamRef.current?.getTracks?.().forEach((track) => track.stop());
      screenStreamRef.current = stream;
      if (screenVideoRef.current) screenVideoRef.current.srcObject = stream;
      stream.getVideoTracks?.().forEach((track) => track.addEventListener("ended", () => {
        setScreenShareActive(false); setScreenShareStatus("Screen sharing ended.");
      }, { once: true }));
      setScreenShareActive(true);
      setScreenShareStatus("Live browser screen capture. The display/window is selected in the system permission prompt; the capture preset is not a native target receipt.");
    } catch (error) {
      setScreenShareActive(false);
      setScreenShareStatus(error instanceof Error ? `Screen sharing did not start: ${error.message}` : "Screen sharing permission denied.");
    }
  }

  function dispatchRemotePacket(packet: RemoteInputEventSpec): void {
    setRemoteInputLog((prev) => [packet, ...prev.slice(0, 49)]);

    if (isDesktopRuntime()) {
      const desktopEvent = toDesktopIsolatedInputEvent(packet);
      void Promise.resolve(
        desktop.sendIsolatedInputEvent({
          channelId: `isolated-${packet.surfaceId}`,
          event: desktopEvent,
        }),
      ).then((receipt) => {
        setScreenShareStatus(receipt.accepted ? "Native isolated-input event accepted." : `Native input rejected: ${receipt.reason}`);
      }).catch((error: unknown) => setScreenShareStatus(error instanceof Error ? error.message : "Native input delivery failed."));
    } else {
      setScreenShareStatus("Input packet recorded locally; no native isolated-input runtime is connected.");
    }
  }

  function handleViewportClick(
    event: React.MouseEvent<HTMLDivElement>,
  ): void {
    const rect = event.currentTarget.getBoundingClientRect();
    const relX =
      rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0.5;
    const relY =
      rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0.5;

    const targetX =
      rect.width > 0
        ? Math.round(relX * selectedSurface.resolutionWidth)
        : Math.round(selectedSurface.resolutionWidth * 0.4);
    const targetY =
      rect.height > 0
        ? Math.round(relY * selectedSurface.resolutionHeight)
        : Math.round(selectedSurface.resolutionHeight * 0.4);

    const packet = createRemoteInputPacket({
      surfaceId: selectedSurface.id,
      type: "mouse-click",
      x: targetX,
      y: targetY,
      deliveryMethod: selectedDeliveryMethod,
    });

    dispatchRemotePacket(packet);
  }

  function handleSomTargetClick(
    event: React.MouseEvent<HTMLButtonElement>,
    target: OmniParserSomTarget,
  ): void {
    event.stopPropagation();
    setSelectedSomMark(target.markNumber);
    const packet = createRemoteInputPacket({
      surfaceId: selectedSurface.id,
      type: "mouse-click",
      x: target.centerX,
      y: target.centerY,
      deliveryMethod: selectedDeliveryMethod,
    });
    dispatchRemotePacket(packet);
  }

  function handlePlanComputerUseSequence(): void {
    const plan = planComputerUseActionSequence(
      computerUseGoal,
      somTargets,
      selectedDeliveryMethod,
    );
    setComputerUsePlan(plan);
    // Planning is side-effect free. The user chooses each input action explicitly.
  }

  function handleSendRemoteChord(chord: string): void {
    const packet = createRemoteInputPacket({
      surfaceId: selectedSurface.id,
      type: "key-chord",
      keyOrChord: chord,
      deliveryMethod: selectedDeliveryMethod,
    });
    dispatchRemotePacket(packet);
  }

  function handleSendRemoteKeysText(): void {
    const textToSend = remoteKeyboardText.trim() || "omnia --status";
    const packet = createRemoteInputPacket({
      surfaceId: selectedSurface.id,
      type: "key-type",
      keyOrChord: "TextSequence",
      text: textToSend,
      deliveryMethod: selectedDeliveryMethod,
    });
    dispatchRemotePacket(packet);
    setRemoteKeyboardText("");
  }

  function handleUpdateDiskEntryPreview(nextPreview: string): void {
    if (!selectedDiskEntry) return;
    setDiskVolumes((prev) =>
      prev.map((vol) =>
        vol.volumeId === selectedVolume.volumeId
          ? {
              ...vol,
              entries: vol.entries.map((entry) =>
                entry.path === selectedDiskEntry.path
                  ? {
                      ...entry,
                      previewContent: nextPreview,
                      sizeBytes: nextPreview.length,
                      modifiedAt: new Date().toISOString(),
                    }
                  : entry,
              ),
            }
          : vol,
      ),
    );
  }

  function handleCreateDiskFile(): void {
    const trimmed = newDiskFileName.trim();
    if (!trimmed) return;
    const separator = selectedVolume.mountPoint.includes("Z:\\")
      ? "Z:\\sovereign-cluster\\"
      : `${selectedVolume.mountPoint}`;
    const fullPath = trimmed.includes(":\\")
      ? trimmed
      : `${separator}${trimmed}`;

    const newEntry: DiskDirectoryEntry = {
      path: fullPath,
      name: trimmed,
      kind: "file",
      sizeBytes: 128,
      modifiedAt: new Date().toISOString(),
      previewContent: `// Created on ${selectedVolume.mountPoint} at ${new Date().toISOString()}`,
    };

    setDiskVolumes((prev) =>
      prev.map((vol) =>
        vol.volumeId === selectedVolume.volumeId
          ? { ...vol, entries: [...vol.entries, newEntry] }
          : vol,
      ),
    );
    setSelectedDiskEntryPath(fullPath);
    setNewDiskFileName("");
  }

  function handleTransferDiskFile(): void {
    const sourceEntry =
      selectedDiskEntry ??
      selectedVolume.entries[0] ??
      DEFAULT_DISK_VOLUMES[1]!.entries[2]!;
    const destinationPath =
      transferDirection === "local-to-remote"
        ? `Z:\\sovereign-cluster\\synced\\${sourceEntry.name}`
        : transferDirection === "remote-to-local"
          ? `D:\\Omnia\\repos\\omnia\\remote-sync\\${sourceEntry.name}`
          : `D:\\Omnia\\backups\\${sourceEntry.name}`;

    const job = createDiskTransferJob({
      sourcePath: sourceEntry.path,
      destinationPath,
      sizeBytes: Math.max(1024, sourceEntry.sizeBytes),
      direction: transferDirection,
    });

    setTransferJobs((prev) => [job, ...prev]);
  }

  function handleTogglePermission(
    key: keyof OmniaRemoteDaemonPermissions,
  ): void {
    setDaemonConfig((prev) => ({
      ...prev,
      permissions: {
        ...prev.permissions,
        [key]: !prev.permissions[key],
      },
    }));
  }

  async function handleCopyAttachToken(): Promise<void> {
    if (!navigator.clipboard?.writeText) {
      setTokenCopiedBanner("Clipboard unavailable. Select the attach token and copy it manually.");
      return;
    }
    try {
      await navigator.clipboard.writeText(daemonConfig.attachToken);
      setTokenCopiedBanner("Copied attach token");
    } catch {
      setTokenCopiedBanner("Clipboard permission denied. Select the attach token and copy it manually.");
    }
  }

  function handleSelectActivity(view: VsCodeActivityViewId): void {
    setActivityView(view);
    if (view === "kvm") {
      setActiveTab("remote-screen");
      setRemoteDrawerOpen(true);
    } else if (view === "disk") {
      setActiveTab("disk-explorer");
      setRemoteDrawerOpen(true);
    } else if (view === "extensions") {
      setActiveTab("remote-daemon");
      setRemoteDrawerOpen(true);
    } else {
      setActiveTab("editor");
      setRemoteDrawerOpen(false);
      if (view === "scm") {
        setShowInlineDiff(true);
      }
      if (view === "search" || view === "scm") setPanel("search", true);
      if (view === "debug") { setPanel("terminal", true); setBottomPanelTab("problems"); }
      if (!treeVisible) {
        setPrimarySidebarOpen(true);
      }
    }
  }

  function navigateQuickOpen(path: string, line = 1): void {
    pendingEditorNavigationRef.current = { path, line };
    openFile(path);
    setCursorLine(line);
    setCursorCol(1);
    setRealVsCodeEmbedOpen(false);
    openRemotePanel("editor");
  }

  const quickOpenMode = commandPaletteQuery.trimStart().startsWith(">") ? "command"
    : commandPaletteQuery.trimStart().startsWith("@") ? "symbol" : "file";
  const quickOpenSearch = (quickOpenMode === "file" ? commandPaletteQuery : commandPaletteQuery.trimStart().slice(1)).trim().toLowerCase().replaceAll("\\", "/");
  const quickOpenCommands: IdeQuickOpenItem[] = [
    { id: "show-tree", label: "Show file tree", detail: "Explorer", kind: "command", run: () => { setRealVsCodeEmbedOpen(false); openRemotePanel("editor"); setPrimarySidebarOpen(true); } },
    { id: "show-search", label: "Search buffers", detail: "Search & diff", kind: "command", run: () => { setRealVsCodeEmbedOpen(false); handleSelectActivity("search"); } },
    { id: "show-terminal", label: "Show terminal and problems", detail: "Local code & terminal", kind: "command", run: () => { setRealVsCodeEmbedOpen(false); openRemotePanel("editor"); setBottomPanelOpen(true); setBottomPanelTab("terminal"); } },
    { id: "toggle-ai", label: "Toggle AI sidebar", detail: "Assistant", kind: "command", run: () => setAgySidebarOpen((open) => !open) },
    { id: "show-projects", label: "Show workspace folders", detail: "Projects", kind: "command", run: () => { setAgySidebarOpen(true); setAgentUtilityPanel("projects"); setProjectPanelRequest((value) => value + 1); } },
    { id: "show-remote", label: "Show remote desktop", detail: "Remote desktop & monitors", kind: "command", run: () => openRemotePanel("remote-screen") },
    { id: "show-disk", label: "Open disk explorer", detail: "Local & remote volumes", kind: "command", run: () => openRemotePanel("disk-explorer") },
  ];
  const quickOpenItems: IdeQuickOpenItem[] = (quickOpenMode === "command" ? quickOpenCommands
    : quickOpenMode === "symbol" ? outlineSymbols.map((symbol) => ({ id: symbol.id, label: symbol.name, detail: `${symbol.kind} · ${activeFile.path}:${symbol.line}`, kind: "symbol" as const, run: () => navigateQuickOpen(activeFile.path, symbol.line) }))
    : files.map((file) => ({ id: file.path, label: file.path.split(/[\\/]/).at(-1) ?? file.path, detail: file.path, kind: "file" as const, run: () => navigateQuickOpen(file.path) })))
    .filter((item) => `${item.label} ${item.detail}`.toLowerCase().replaceAll("\\", "/").includes(quickOpenSearch));
  const quickOpenSelectedIndex = Math.min(commandPaletteIndex, Math.max(0, quickOpenItems.length - 1));
  const quickOpenHeading = quickOpenMode === "command" ? "Commands" : quickOpenMode === "symbol" ? `Symbols in ${activeFile.path.split(/[\\/]/).at(-1)}` : "Files in local buffers";

  function runQuickOpenItem(item: IdeQuickOpenItem): void {
    setCommandPaletteOpen(false);
    item.run();
  }

  useEffect(() => {
    if (!commandPaletteOpen) return;
    quickOpenListRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest" });
  }, [commandPaletteOpen, quickOpenSelectedIndex, commandPaletteQuery]);

  // Editor-first geometry: optional columns shrink (then the tree hides) before
  // the editor would drop below IDE_EDITOR_MIN_WIDTH. JSDOM reports width 0.
  const showActivityRail = panels.activity && !isPureEmbeddedVsCode;
  let effectiveTreeWidth = primarySidebarWidth;
  let effectiveAiWidth = agySidebarWidth;
  let treeFits = treeVisible && !isPureEmbeddedVsCode;
  if (rootWidth > 0) {
    // Native child WebViews cover DOM hit targets. Their resize handles occupy
    // a real 10px column, so include those gutters in the editor-width budget.
    const resizeGutterWidth = nativeEditor ? 10 : 0;
    let spare = rootWidth - (showActivityRail ? 40 : 0) - IDE_EDITOR_MIN_WIDTH - (agySidebarOpen ? resizeGutterWidth : 0);
    if (agySidebarOpen) {
      effectiveAiWidth = Math.max(260, Math.min(agySidebarWidth, spare - (treeFits ? 180 + resizeGutterWidth : 0)));
      spare -= effectiveAiWidth;
    }
    if (treeFits) {
      if (spare < 180 + resizeGutterWidth) treeFits = false;
      else effectiveTreeWidth = Math.min(primarySidebarWidth, spare - resizeGutterWidth);
    }
  }
  const noFileOpen = openTabPaths.length === 0;
  const openTabFiles = openTabPaths.map((path) => files.find((file) => file.path === path)).filter((file): file is IdeVirtualFile => Boolean(file));

  const breadcrumbSegments = useMemo(() => {
    const parts = activeFile.path.split(/[\\/]/).filter(Boolean);
    return ["repos", "omnia", ...parts];
  }, [activeFile.path]);

  const hasExternalIdeHeading =
    typeof document !== "undefined" &&
    Array.from(document.querySelectorAll("h1, h2, h3")).some(
      (el) =>
        !el.hasAttribute("data-ide-sr-heading") &&
        el.textContent?.trim() === "Sovereign IDE & Remote Desktop",
    );

  return (
    <section
      ref={rootRef}
      data-testid="sovereign-ide-remote-workbench"
      aria-label="VS Code Workbench"
      data-embedded-shell={embeddedInShell ? "true" : undefined}
      data-narrow={isNarrow ? "true" : undefined}
      className="sw-workbench-root sovereign-ide-remote-workbench"
      data-runtime={isAutomatedTestEnv ? "test" : "live"}
      data-native-editor={isPureEmbeddedVsCode ? "true" : "false"}
      data-resizing={isResizingIdePanel ? "true" : undefined}
      style={{
        display: "flex",
        flexDirection: "column",
        width: "100%",
        height: "100%",
        minHeight: 0,
        padding: 0,
        gap: 0,
        borderRadius: 0,
        border: 0,
        background: "#1e1e1e",
        color: "var(--text)",
        overflow: "hidden",
        boxShadow: "none",
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      }}
    >
      {!hasExternalIdeHeading ? (
        <h2 data-ide-sr-heading="true" className="sr-only">
          Sovereign IDE &amp; Remote Desktop
        </h2>
      ) : null}
      <style>{`
        .sw-workbench-root [data-tooltip] {
          position: relative;
        }
        .sw-workbench-root [data-tooltip]:hover::after {
          content: attr(data-tooltip);
          position: absolute;
          z-index: 90;
          left: 50%;
          bottom: calc(100% + 6px);
          transform: translateX(-50%);
          padding: 4px 8px;
          border-radius: 5px;
          background: #18181b;
          border: 1px solid #3f3f46;
          color: #f4f4f6;
          font-size: 10px;
          font-weight: 600;
          white-space: nowrap;
          pointer-events: none;
          box-shadow: 0 6px 18px rgba(0, 0, 0, 0.65);
        }
        .sw-activity-rail [data-tooltip]:hover::after {
          left: calc(100% + 8px);
          bottom: auto;
          top: 50%;
          transform: translateY(-50%);
        }
        .sw-accordion > summary {
          list-style: none;
          cursor: pointer;
          user-select: none;
        }
        .sw-accordion > summary::-webkit-details-marker {
          display: none;
        }
      `}</style>

      <header className="sw-topbar" data-testid="vscode-title-command-bar" data-tauri-drag-region={embeddedInShell ? undefined : "deep"}>
        {/* The shell top bar already names the view and owns window controls. */}
        {embeddedInShell ? null : <WorkspaceModeSwitcher />}
        <button type="button" className="ide-icon-button" data-testid="ide-toggle-tree-btn" aria-label={treeVisible ? "Hide file tree" : "Show file tree"} title={treeVisible ? "Hide file tree" : "Show file tree"} aria-pressed={treeVisible} hidden={isPureEmbeddedVsCode} onClick={() => setPrimarySidebarOpen((open) => !open)}><PanelLeft size={16} strokeWidth={1.75} aria-hidden="true" /></button>
        <nav className="ide-project-pills" data-testid="ide-project-pills" aria-label="Project folders">
          {projectFolders.map((folder, index) => (
            <button key={folder.path} type="button" className="ide-project-pill" data-testid={`ide-project-pill-${index}`} data-project-accent={index % 3} style={{ "--project-accent": ["#60a5fa", "#34d399", "#a78bfa"][index % 3] } as React.CSSProperties} aria-pressed={workspaceTarget === folder.path} title={folder.path} onClick={() => { setWorkspaceTarget(folder.path); openRemotePanel("editor"); setRealVsCodeEmbedOpen(true); }}>
              <Folder size={14} strokeWidth={1.75} aria-hidden="true" /><span>{folder.name}</span>
            </button>
          ))}
          <button type="button" className="ide-icon-button" data-testid="ide-open-project-folder-btn" title="Open project folder" aria-label="Open project folder" onClick={() => { setAgySidebarOpen(true); setAgentUtilityPanel("projects"); setProjectPanelRequest((value) => value + 1); }}><FolderPlus size={16} strokeWidth={1.75} aria-hidden="true" /></button>
        </nav>
        <div className="ide-title-actions">
          <button type="button" className="ide-icon-button" data-testid="ide-quick-open-trigger" aria-label="Quick Open (Ctrl+P)" title="Quick Open (Ctrl+P)" aria-keyshortcuts="Control+P Meta+P" aria-haspopup="dialog" aria-expanded={commandPaletteOpen} onClick={() => { setCommandPaletteQuery(""); setCommandPaletteIndex(0); setToolsMenuOpen(false); setCommandPaletteOpen((open) => !open); }}><Search size={16} strokeWidth={1.75} aria-hidden="true" /></button>
          <button type="button" className="ide-icon-button" data-testid="toggle-real-vscode-embed-btn" aria-label={realVsCodeEmbedOpen ? "Show local code and terminal drawer" : "Return to editor"} title={realVsCodeEmbedOpen ? "Show local code and terminal drawer" : "Return to editor"} aria-pressed={!realVsCodeEmbedOpen} onClick={() => { setRealVsCodeEmbedOpen((open) => !open); openRemotePanel("editor"); }}><SplitSquareHorizontal size={16} strokeWidth={1.75} aria-hidden="true" /></button>
          <div className="ide-tools-menu-anchor" ref={toolsMenuRef}>
            <button ref={toolsMenuTriggerRef} type="button" data-testid="ide-more-panels-btn" aria-label="More panels" title="More panels" aria-haspopup="true" aria-expanded={toolsMenuOpen} aria-controls="ide-more-panels-menu" onClick={() => setToolsMenuOpen((open) => !open)}><MoreHorizontal size={16} aria-hidden="true" /></button>
            <div id="ide-more-panels-menu" className="ide-tools-menu" data-testid="ide-more-panels-menu" role="group" aria-label="More panels" hidden={!toolsMenuOpen}>
              <p className="ide-tools-menu__label">Panels</p>
              <label className="ide-tools-menu__check"><input type="checkbox" data-testid="ide-toggle-sidebar-btn" checked={treeVisible} onChange={(event) => setPrimarySidebarOpen(event.target.checked)} />File tree</label>
              {IDE_OPTIONAL_PANELS.map((panel) => (
                <label key={panel.id} className="ide-tools-menu__check"><input type="checkbox" data-testid={panel.testId ?? `ide-panel-toggle-${panel.id}`} checked={panels[panel.id]} onChange={(event) => setPanel(panel.id, event.target.checked)} />{panel.label}</label>
              ))}
              <label className="ide-tools-menu__check"><input type="checkbox" data-testid="ide-split-browser-toggle-btn" checked={splitBrowserOpen} onChange={(event) => setSplitBrowserOpen(event.target.checked)} />Browser preview</label>
              <p className="ide-tools-menu__label">Tools</p>
              <button type="button" onClick={() => { setWorkspaceTarget("multi-root"); openRemotePanel("editor"); setRealVsCodeEmbedOpen(true); }}><FolderTree size={14} aria-hidden="true" /> Open all projects</button>
              {([['projects', 'Workspace folders'], ['sessions', 'Session tools'], ['knowledge', 'Knowledge and model setup'], ['tools', 'Calculator and checks']] as const).map(([panel, label]) => <button key={panel} type="button" onClick={() => { setAgentUtilityPanel(panel); setProjectPanelRequest((value) => value + 1); setAgySidebarOpen(true); setToolsMenuOpen(false); }}><Workflow size={14} aria-hidden="true" />{label}</button>)}
              <button type="button" data-testid="ide-tab-remote" onClick={() => openRemotePanel("remote-screen")}><Monitor size={14} aria-hidden="true" /> Remote desktop & monitors</button>
              <button type="button" data-testid="ide-tab-disk" onClick={() => openRemotePanel("disk-explorer")}><HardDrive size={14} aria-hidden="true" /> Disk explorer</button>
              <button type="button" data-testid="ide-tab-split" onClick={() => { setRealVsCodeEmbedOpen(false); openRemotePanel("editor"); }}><Terminal size={14} aria-hidden="true" /> Local code & terminal</button>
              <button type="button" onClick={() => openRemotePanel("remote-daemon")}><Workflow size={14} aria-hidden="true" /> Remote daemon</button>
            </div>
          </div>
          <button type="button" data-testid="ide-toggle-agy-sidebar-btn" aria-label="Toggle AI sidebar" aria-keyshortcuts="Control+Alt+B" aria-pressed={agySidebarOpen} title="Toggle AI sidebar" onClick={() => setAgySidebarOpen((open) => !open)}><PanelRight size={16} aria-hidden="true" /></button>
        </div>
        {embeddedInShell ? null : <WorkbenchWindowControls />}
      </header>

      {/* Quick Open owns focus while the embedded editor keeps its native shortcuts. */}
      {commandPaletteOpen && (
        <ModalSurface
          className="ide-quick-open"
          scrimClassName="ide-quick-open-scrim"
          title="Quick Open"
          onClose={() => setCommandPaletteOpen(false)}
        >
          <div ref={quickOpenContentRef} data-testid="ide-command-palette">
            <div className="ide-quick-open__input-row">
              <Search size={16} aria-hidden="true" />
              <input
                type="text"
                role="combobox"
                aria-label="Quick Open"
                aria-autocomplete="list"
                aria-expanded="true"
                aria-controls={`${quickOpenId}-results`}
                aria-activedescendant={quickOpenItems.length ? `${quickOpenId}-option-${quickOpenSelectedIndex}` : undefined}
                aria-describedby={`${quickOpenId}-help`}
                autoComplete="off"
                spellCheck={false}
                data-dialog-initial-focus
                data-testid="ide-command-palette-input"
                value={commandPaletteQuery}
                onChange={(event) => { setCommandPaletteQuery(event.target.value); setCommandPaletteIndex(0); }}
                placeholder="Type file name, @symbol, or >command..."
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing) { event.stopPropagation(); return; }
                  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault();
                    const step = event.key === "ArrowDown" ? 1 : -1;
                    setCommandPaletteIndex(quickOpenItems.length ? (quickOpenSelectedIndex + step + quickOpenItems.length) % quickOpenItems.length : 0);
                  } else if (event.key === "Enter") {
                    event.preventDefault();
                    const selected = quickOpenItems[quickOpenSelectedIndex];
                    if (selected) runQuickOpenItem(selected);
                  }
                }}
              />
              <button type="button" aria-label="Close Quick Open" title="Close Quick Open (Esc)" onClick={() => setCommandPaletteOpen(false)}><X size={15} aria-hidden="true" /></button>
            </div>
            <p className="ide-quick-open__heading">{quickOpenHeading}</p>
            <div ref={quickOpenListRef} id={`${quickOpenId}-results`} className="ide-quick-open__results" role="listbox" aria-label={quickOpenHeading}>
              {quickOpenItems.map((item, index) => (
                <button
                  key={item.id}
                  id={`${quickOpenId}-option-${index}`}
                  type="button"
                  role="option"
                  aria-selected={index === quickOpenSelectedIndex}
                  tabIndex={-1}
                  title={item.detail}
                  onMouseEnter={() => setCommandPaletteIndex(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => runQuickOpenItem(item)}
                >
                  {item.kind === "file" ? <FileCode2 size={16} aria-hidden="true" /> : item.kind === "symbol" ? <Workflow size={16} aria-hidden="true" /> : <Terminal size={16} aria-hidden="true" />}
                  <span><strong>{item.label}</strong><small>{item.detail}</small></span>
                </button>
              ))}
              {quickOpenItems.length === 0 ? <p className="ide-quick-open__empty">No matching {quickOpenMode === "file" ? "files" : quickOpenMode === "symbol" ? "symbols" : "commands"}</p> : null}
            </div>
            <footer className="ide-quick-open__footer">
              <span id={`${quickOpenId}-help`}>↑↓ navigate · Enter open · Esc close</span>
              <span aria-live="polite" aria-atomic="true">{quickOpenItems.length} {quickOpenItems.length === 1 ? "result" : "results"}</span>
            </footer>
          </div>
        </ModalSurface>
      )}

      {/* MAIN WORKBENCH BODY: Activity Rail (40px) + Active Perspective Layer */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `${showActivityRail ? "40px " : ""}minmax(0, 1fr)${agySidebarOpen ? ` auto ${effectiveAiWidth}px` : ""}`,
          minHeight: 0,
          flex: 1,
          overflow: "hidden",
        }}
      >
        {/* 2. LEFT 40px VS CODE ACTIVITY BAR (.sw-activity-rail) */}
        <aside
          className="sw-activity-rail"
          data-testid="vscode-activity-bar"
          aria-label="VS Code Activity Bar"
          style={{
            display: showActivityRail ? "flex" : "none",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "8px 0",
            background: "var(--ide-chrome)",
            borderRight: "1px solid var(--ide-border)",
          }}
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: "6px",
              width: "100%",
            }}
          >
            {/* 1. Explorer */}
            <button
              type="button"
              data-testid="activity-bar-explorer"
              data-tooltip="Explorer (Ctrl+Shift+E)"
              title="Explorer (Ctrl+Shift+E)"
              aria-label="Explorer (Ctrl+Shift+E)"
              onClick={() => handleSelectActivity("explorer")}
              style={{
                position: "relative",
                width: "32px",
                height: "32px",
                borderRadius: "6px",
                border: "none",
                borderLeft:
                  activeTab === "editor" && activityView === "explorer"
                    ? "2px solid var(--ide-border)"
                    : "2px solid transparent",
                background:
                  activeTab === "editor" && activityView === "explorer"
                    ? "var(--ide-raised)"
                    : "transparent",
                color:
                  activeTab === "editor" && activityView === "explorer"
                    ? "var(--ide-fg)"
                    : "var(--text-secondary)",
                fontSize: "14px",
                cursor: "pointer",
              }}
            >
              <FolderTree size={16} aria-hidden="true" />
              <span
                aria-hidden="true"
                style={{
                  display: "none",
                }}
              >
                {files.length}
              </span>
            </button>

            {/* 2. Search & Ripgrep */}
            <button
              type="button"
              data-testid="activity-bar-search"
              data-tooltip="Search & Ripgrep (Ctrl+Shift+F)"
              title="Search & Ripgrep (Ctrl+Shift+F)"
              aria-label="Search & Ripgrep (Ctrl+Shift+F)"
              onClick={() => handleSelectActivity("search")}
              style={{
                position: "relative",
                width: "32px",
                height: "32px",
                borderRadius: "6px",
                border: "none",
                borderLeft:
                  activeTab === "editor" && activityView === "search"
                    ? "2px solid var(--ide-border)"
                    : "2px solid transparent",
                background:
                  activeTab === "editor" && activityView === "search"
                    ? "var(--ide-raised)"
                    : "transparent",
                color:
                  activeTab === "editor" && activityView === "search"
                    ? "var(--ide-fg)"
                    : "var(--text-secondary)",
                fontSize: "14px",
                cursor: "pointer",
              }}
            >
              <Search size={16} aria-hidden="true" />
              <span
                aria-hidden="true"
                style={{
                  display: "none",
                }}
              >
                {ripgrepMatches.length}
              </span>
            </button>

            {/* 3. Source Control Git Diff */}
            <button
              type="button"
              data-testid="activity-bar-scm"
              data-tooltip="Source Control Git Diff (Ctrl+Shift+G)"
              title="Source Control Git Diff (Ctrl+Shift+G)"
              aria-label="Source Control Git Diff (Ctrl+Shift+G)"
              onClick={() => handleSelectActivity("scm")}
              style={{
                position: "relative",
                width: "32px",
                height: "32px",
                borderRadius: "6px",
                border: "none",
                borderLeft:
                  activeTab === "editor" && activityView === "scm"
                    ? "2px solid var(--ide-border)"
                    : "2px solid transparent",
                background:
                  activeTab === "editor" && activityView === "scm"
                    ? "var(--ide-raised)"
                    : "transparent",
                color:
                  activeTab === "editor" && activityView === "scm"
                    ? "var(--ide-fg)"
                    : "var(--text-secondary)",
                fontSize: "14px",
                cursor: "pointer",
              }}
            >
              <GitBranch size={16} aria-hidden="true" />
              <span
                aria-hidden="true"
                style={{
                  display: "none",
                }}
              >
                {modifiedFilesCount}
              </span>
            </button>

            {/* 4. Run & Debug / LSP Diagnostics */}
            <button
              type="button"
              data-testid="activity-bar-debug"
              data-tooltip="Run & Debug / LSP Diagnostics (Ctrl+Shift+D)"
              title="Run & Debug / LSP Diagnostics (Ctrl+Shift+D)"
              aria-label="Run & Debug / LSP Diagnostics (Ctrl+Shift+D)"
              onClick={() => handleSelectActivity("debug")}
              style={{
                position: "relative",
                width: "32px",
                height: "32px",
                borderRadius: "6px",
                border: "none",
                borderLeft:
                  activeTab === "editor" && activityView === "debug"
                    ? "2px solid var(--ide-border)"
                    : "2px solid transparent",
                background:
                  activeTab === "editor" && activityView === "debug"
                    ? "var(--ide-raised)"
                    : "transparent",
                color:
                  activeTab === "editor" && activityView === "debug"
                    ? "var(--ide-fg)"
                    : "var(--text-secondary)",
                fontSize: "14px",
                cursor: "pointer",
              }}
            >
              <Play size={16} aria-hidden="true" />
              <span
                aria-hidden="true"
                style={{
                  display: "none",
                }}
              >
                {codeAnalysis.diagnostics.length}
              </span>
            </button>

            {/* 5. Multi-Monitor KVM & OmniParser SoM */}
            <button
              type="button"
              data-testid="activity-bar-kvm"
              data-tooltip="Multi-Monitor KVM & OmniParser SoM (Ctrl+Shift+M)"
              title="Multi-Monitor KVM & OmniParser SoM (Ctrl+Shift+M)"
              aria-label="Multi-Monitor KVM & OmniParser SoM (Ctrl+Shift+M)"
              onClick={() => handleSelectActivity("kvm")}
              style={{
                position: "relative",
                width: "32px",
                height: "32px",
                borderRadius: "6px",
                border: "none",
                borderLeft:
                  activeTab === "remote-screen"
                    ? "2px solid var(--ide-border)"
                    : "2px solid transparent",
                background:
                  activeTab === "remote-screen"
                    ? "var(--ide-raised)"
                    : "transparent",
                color: activeTab === "remote-screen" ? "var(--ide-fg)" : "var(--text-secondary)",
                fontSize: "14px",
                cursor: "pointer",
              }}
            >
              <Monitor size={16} aria-hidden="true" />
              <span
                aria-hidden="true"
                style={{
                  display: "none",
                }}
              >
                {DEFAULT_REMOTE_CAPTURE_SURFACES.length}
              </span>
            </button>

            {/* 6. Remote & Local Disk Commander */}
            <button
              type="button"
              data-testid="ide-tab-remote-disk"
              data-tooltip="Remote & Local Disk Commander (Ctrl+Shift+K)"
              title="Remote & Local Disk Commander (Ctrl+Shift+K)"
              aria-label="Remote & Local Disk Commander (Ctrl+Shift+K)"
              onClick={() => handleSelectActivity("disk")}
              style={{
                position: "relative",
                width: "32px",
                height: "32px",
                borderRadius: "6px",
                border: "none",
                borderLeft:
                  activeTab === "disk-explorer"
                    ? "2px solid var(--ide-border)"
                    : "2px solid transparent",
                background:
                  activeTab === "disk-explorer"
                    ? "var(--ide-raised)"
                    : "transparent",
                color: activeTab === "disk-explorer" ? "var(--ide-fg)" : "var(--text-secondary)",
                fontSize: "14px",
                cursor: "pointer",
              }}
            >
              <HardDrive size={16} aria-hidden="true" />
              <span
                aria-hidden="true"
                style={{
                  display: "none",
                }}
              >
                {diskVolumes.length}
              </span>
            </button>

            {/* 7. MCP & Language Server Extensions */}
            <button
              type="button"
              data-testid="activity-bar-extensions"
              data-tooltip="MCP & Language Server Extensions (Ctrl+Shift+X)"
              title="MCP & Language Server Extensions (Ctrl+Shift+X)"
              aria-label="MCP & Language Server Extensions (Ctrl+Shift+X)"
              onClick={() => handleSelectActivity("extensions")}
              style={{
                position: "relative",
                width: "32px",
                height: "32px",
                borderRadius: "6px",
                border: "none",
                borderLeft:
                  activeTab === "remote-daemon"
                    ? "2px solid var(--ide-border)"
                    : "2px solid transparent",
                background:
                  activeTab === "remote-daemon"
                    ? "var(--ide-raised)"
                    : "transparent",
                color: activeTab === "remote-daemon" ? "var(--ide-fg)" : "var(--text-secondary)",
                fontSize: "14px",
                cursor: "pointer",
              }}
            >
              <Workflow size={16} aria-hidden="true" />
              <span
                aria-hidden="true"
                style={{
                  display: "none",
                }}
              >
                {daemonConfig.connectedPeers}
              </span>
            </button>
          </div>
        </aside>

        {/* ACTIVE PERSPECTIVE CONTAINER */}
        <div className="ide-main-stage" style={{ display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0 }}>
          {/* ================================================================ */}
          {/* LAYER 1: PURE VS CODE WORKBENCH (EDITOR + SIDEBAR + PANEL)       */}
          {/* ================================================================ */}
          <div
            data-testid="ide-panel-editor"
            data-active={activeTab === "editor" || !remoteDrawerOpen ? "true" : "false"}
            style={{
              display: activeTab === "editor" || !remoteDrawerOpen ? "grid" : "none",
              gridTemplateColumns: treeFits ? `${effectiveTreeWidth}px auto minmax(0, 1fr)` : "minmax(0, 1fr)",
              flex: 1,
              minHeight: 0,
              overflow: "hidden",
            }}
          >
            {/* 3. COLLAPSIBLE LEFT PRIMARY SIDEBAR (240px, .sw-sidebar) */}
            {treeFits && (
              <aside
                className="sw-sidebar"
                data-testid="vscode-primary-sidebar"
                style={{
                  display: isPureEmbeddedVsCode ? "none" : "flex",
                  flexDirection: "column",
                  gap: "6px",
                  padding: "8px",
                  background: "var(--ide-chrome)",
                  borderRight: "1px solid var(--ide-border)",
                  overflowY: "auto",
                  maxHeight: "620px",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    fontSize: "12px",
                    fontWeight: 700,
                    letterSpacing: "0.06em",
                    color: "var(--text-secondary)",
                    padding: "2px 4px",
                  }}
                >
                  <span>Files</span>
                  <span>{files.length}</span>
                </div>

                {/* Accordion 1: OPEN EDITORS (opt-in from More panels) */}
                {panels.openEditors && (
                <details className="sw-accordion" open>
                  <summary
                  >
                    <span>Open editors</span>
                    <span>{openTabFiles.length}</span>
                  </summary>
                  <div
                  >
                    {openTabFiles.map((file) => {
                      const langMeta = LANGUAGE_BADGE_MAP[file.language];
                      const shortName = file.path.split("/").pop() ?? file.path;
                      return (
                        <button
                          key={`open-${file.path}`}
                          type="button"
                          onClick={() => openFile(file.path)}
                        >
                          <span
                          >
                            <span
                            >
                              {langMeta.badge}
                            </span>
                            <span>{shortName}</span>
                          </span>
                          {file.isModified && (
                            <span >
                              Modified
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </details>
                )}

                {/* Accordion 2: WORKSPACE EXPLORER */}
                <details className="sw-accordion" open>
                  <summary
                  >
                    <span>Explorer</span>
                    <span>{files.length}</span>
                  </summary>
                  <div
                  >
                    {files.map((file) => {
                      const langMeta = LANGUAGE_BADGE_MAP[file.language];
                      return (
                        <button
                          key={file.path}
                          type="button"
                          data-testid={`ide-file-item-${file.path}`}
                          className="ide-tree-item"
                          title={file.path}
                          aria-current={openTabPaths.includes(file.path) && file.path === activeFile.path ? "true" : undefined}
                          onClick={() => openFile(file.path)}
                        >
                          <span className="ide-tree-item__badge">{langMeta.badge}</span>
                          <span className="ide-tree-item__name">{file.path}</span>
                          {file.isModified ? <span className="ide-tree-item__dot" aria-label="Modified" /> : null}
                        </button>
                      );
                    })}

                    <div
                    >
                      <input
                        type="text"
                        data-testid="ide-new-file-input"
                        value={newIdeFilePath}
                        onChange={(e) => setNewIdeFilePath(e.target.value)}
                        placeholder="src/domain/new-module.ts"
                      />
                      <button
                        type="button"
                        data-testid="ide-create-file-btn"
                        data-tooltip="Create New Polyglot File"
                        onClick={handleCreateIdeFile}
                      >
                        + File
                      </button>
                    </div>
                  </div>
                </details>

                {/* Accordion 3: OUTLINE (AST SYMBOLS, opt-in) */}
                {panels.outline && (
                <details
                  className="sw-accordion"
                  data-testid="ide-outline-tree"
                  open
                >
                  <summary
                  >
                    <span>Outline</span>
                    <span>{outlineSymbols.length}</span>
                  </summary>
                  <div
                  >
                    {outlineSymbols.length === 0 ? (
                      <div
                      >
                        No top-level symbols detected.
                      </div>
                    ) : (
                      outlineSymbols.map((sym) => (
                        <button
                          key={sym.id}
                          type="button"
                          data-testid={`ide-outline-symbol-${sym.name}`}
                          onClick={() => setCursorLine(sym.line)}
                        >
                          <span
                          >
                            <strong >
                              {sym.detail}
                            </strong>{" "}
                            {sym.name}
                          </span>
                          <span >
                            {sym.lineLabel}
                          </span>
                        </button>
                      ))
                    )}
                  </div>
                </details>
                )}

                {/* Accordion 4: SEARCH / RIPGREP & GIT DIFF (opt-in) */}
                {panels.search && (
                <details
                  className="sw-accordion"
                  open
                >
                  <summary
                  >
                    <span>Search &amp; diff</span>
                    <span>
                      +{diffStats.added} / -{diffStats.removed}
                    </span>
                  </summary>
                  <div
                  >
                    <div >
                      <input
                        type="text"
                        data-testid="ide-ripgrep-search-input"
                        value={ripgrepQuery}
                        onChange={(e) => setRipgrepQuery(e.target.value)}
                        placeholder="Ripgrep workspace..."
                      />
                      <button
                        type="button"
                        data-testid="ide-ripgrep-regex-toggle"
                        data-tooltip="Use Regular Expression (.*)"
                        onClick={() => setRipgrepRegex((prev) => !prev)}
                      >
                        .*
                      </button>
                    </div>
                    <div
                      data-testid="ide-ripgrep-results"
                    >
                      {ripgrepMatches.slice(0, 6).map((match, idx) => (
                        <button
                          key={`${match.path}-${match.line}-${idx}`}
                          type="button"
                          onClick={() => {
                            openFile(match.path);
                            setCursorLine(match.line);
                          }}
                        >
                          <div >
                            {match.path.split("/").pop()}:Ln {match.line}
                          </div>
                          <div
                          >
                            {match.snippet}
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                </details>
                )}
              </aside>
            )}
            {treeFits && (
              <div
                className="ide-panel-resizer"
                data-testid="ide-primary-sidebar-resizer"
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize primary sidebar"
                aria-valuemin={180}
                aria-valuemax={480}
                aria-valuenow={primarySidebarWidth}
                aria-valuetext={`${primarySidebarWidth} pixels`}
                tabIndex={0}
                style={nativeEditor ? { marginInline: 0 } : undefined}
                onPointerDown={(event) => startIdePanelResize("primary", event)}
                onDoubleClick={() => setPrimarySidebarWidth(240)}
                onKeyDown={(event) => handleIdePanelResizeKeyDown("primary", event)}
              />
            )}

            {/* 4. CENTER EDITOR GROUP + SPLIT BROWSER + COLLAPSIBLE BOTTOM PANEL */}
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                minWidth: 0,
                background: "var(--surface-selected)",
              }}
            >
              {!isAutomatedTestEnv ? <EmbeddedVscodeStage
                workspaceUrl={vscodeWorkspaceUrl}
                workspaceKey={`${workspaceTarget}-${workspaceRevision}`}
                nativeFolderId={activeProject?.id ?? null}
                active={realVsCodeEmbedOpen && (!nativeEditor || (isPureEmbeddedVsCode && !commandPaletteOpen && !toolsMenuOpen && !isResizingIdePanel))}
              /> : null}

              {/* Fallback Polyglot Buffer (Hidden when Pure Patched VS Code is active in live browser) */}
              <div
                style={{
                  display: isPureEmbeddedVsCode ? "none" : "flex",
                  flexDirection: "column",
                  flex: 1,
                  minWidth: 0,
                }}
              >
              {/* Editor Tab Bar: one row of open-file tabs + compact actions. */}
              <div
                data-testid="vscode-editor-tabbar"
                className="ide-editor-tabbar"
              >
                <div ref={editorTabListRef} className="ide-editor-tabs" role="tablist" aria-label="Open files" aria-orientation="horizontal" tabIndex={-1}>
                  {openTabFiles.map((file) => {
                    const fileName = file.path.split("/").pop() ?? file.path;
                    const selected = file.path === activeFile.path;
                    const tabId = localEditorTabId(file.path);
                    return (
                      <div key={`tab-${file.path}`} className="ide-editor-tab" data-active={selected ? "true" : undefined}>
                        <button
                          type="button"
                          role="tab"
                          id={tabId}
                          aria-selected={selected}
                          aria-controls="ide-editor-tabpanel"
                          tabIndex={selected ? 0 : -1}
                          title={file.path}
                          ref={(element) => {
                            if (element) editorTabRefs.current.set(file.path, element);
                            else editorTabRefs.current.delete(file.path);
                          }}
                          onClick={() => openFile(file.path)}
                          onKeyDown={(event) => handleEditorTabKeyDown(file.path, event)}
                        >
                          <span className="ide-editor-tab__name">{fileName}</span>
                          {file.isModified ? <span className="ide-tree-item__dot" aria-label="Modified" /> : null}
                        </button>
                        <button type="button" className="ide-editor-tab__close" tabIndex={-1} aria-label={`Close ${fileName}`} title={`Close ${fileName}`} onClick={() => closeFileTab(file.path)}><X size={12} aria-hidden="true" /></button>
                      </div>
                    );
                  })}
                </div>

                {/* Right-aligned editor actions; labels collapse to icons when narrow. */}
                <div className="ide-editor-actions" hidden={noFileOpen}>
                  <button type="button" data-testid="ide-toggle-inline-diff-btn" aria-label="Toggle Inline Git Diff" title="Toggle Inline Git Diff" aria-pressed={showInlineDiff} onClick={() => setShowInlineDiff((open) => !open)}><GitBranch size={14} aria-hidden="true" /><span className="ide-action-label">Diff</span></button>
                  <button
                    type="button"
                    data-testid="ide-run-terminal-btn"
                    aria-label="Plan command"
                    title={`Run (${codeAnalysis.quickRunCommand})`}
                    onClick={handleRunInTerminal}
                  >
                    <Play size={14} aria-hidden="true" /><span className="ide-action-label">Plan command</span>
                  </button>

                  <button
                    type="button"
                    data-testid="ide-send-to-chat-btn"
                    aria-label="Send to Chat"
                    title="Send active file to chat"
                    onClick={handleSendFileToActiveChat}
                  >
                    <Send size={14} aria-hidden="true" /><span className="ide-action-label">Send to Chat</span>
                  </button>
                </div>
              </div>

              {noFileOpen ? (
                <div className="ide-empty-hint" data-testid="ide-empty-hint" role="status">
                  Open a file from the tree, or <kbd>Ctrl+P</kbd>
                </div>
              ) : null}

              {/* Breadcrumb Bar */}
              <div
                data-testid="ide-breadcrumb-bar"
                className="ide-breadcrumb-bar"
                hidden={noFileOpen}
              >
                <div className="ide-breadcrumb-bar__path">
                  {breadcrumbSegments.map((seg, idx) => (
                    <React.Fragment key={`${seg}-${idx}`}>
                      <span>{seg}</span>
                      <ChevronRight size={12} aria-hidden="true" />
                    </React.Fragment>
                  ))}
                  <strong >
                    {activeOutlineSymbol?.name ?? "module"}
                  </strong>
                </div>
                <span >
                  Ln {cursorLine}, Col {cursorCol}
                </span>
              </div>

              {/* Main Split Surface: Code Editor (Gutter + Textarea + Minimap) + Optional Split Sovereign Browser */}
              <div
                id="ide-editor-tabpanel"
                role="tabpanel"
                aria-labelledby={openTabFiles.length ? localEditorTabId(activeFile.path) : undefined}
                tabIndex={0}
                hidden={noFileOpen}
                style={{
                  display: noFileOpen ? "none" : "grid",
                  gridTemplateColumns: splitBrowserOpen
                    ? "minmax(0, 1.55fr) minmax(240px, 1fr)"
                    : "minmax(0, 1fr)",
                  flex: 1,
                  minHeight: "160px",
                  borderBottom: "1px solid var(--ide-border)",
                }}
              >
                {/* Left/Center: Code Editor Surface */}
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: panels.minimap ? "38px minmax(0, 1fr) 48px" : "38px minmax(0, 1fr)",
                    background: "var(--ide-chrome)",
                    minHeight: "160px",
                  }}
                >
                  {/* Line-Numbered Gutter */}
                  <div
                    data-testid="ide-line-gutter"
                    style={{
                      padding: "10px 4px",
                      textAlign: "right",
                      fontFamily: "monospace",
                      fontSize: "12px",
                      lineHeight: "1.5",
                      color: "var(--ide-fg)",
                      background: "var(--ide-chrome)",
                      borderRight: "1px solid var(--ide-border)",
                      userSelect: "none",
                    }}
                  >
                    {activeFileLines.map((_, idx) => {
                      const ln = idx + 1;
                      return (
                        <div
                          key={`ln-${ln}`}
                          style={{
                            color: ln === cursorLine ? "var(--ide-fg)" : "var(--ide-muted)",
                            fontWeight: ln === cursorLine ? 700 : 400,
                          }}
                        >
                          {ln}
                        </div>
                      );
                    })}
                  </div>

                  {/* Monospace Code Textarea + Optional Inline Git Diff Overlay */}
                  <div style={{ display: "flex", flexDirection: "column" }}>
                    <textarea
                      ref={codeEditorRef}
                      data-testid="ide-code-editor-textarea"
                      onSelect={(event) => { const editor = event.currentTarget; setSelectedCode(editor.value.slice(editor.selectionStart, editor.selectionEnd)); }}
                      aria-label="Polyglot IDE Code Editor"
                      value={activeFile.content}
                      onChange={(e) => handleCodeChange(e.target.value)}
                      onClick={(e) => {
                        const target = e.currentTarget;
                        const uptoCursor = target.value.slice(
                          0,
                          target.selectionStart ?? 0,
                        );
                        const linesBefore = uptoCursor.split(/\r?\n/);
                        setCursorLine(linesBefore.length);
                        setCursorCol(
                          (linesBefore[linesBefore.length - 1]?.length ?? 0) + 1,
                        );
                      }}
                      rows={9}
                      style={{
                        width: "100%",
                        flex: 1,
                        fontFamily:
                          "'JetBrains Mono', 'Fira Code', Consolas, monospace",
                        fontSize: "12px",
                        lineHeight: "1.5",
                        padding: "10px",
                        border: "none",
                        outline: "none",
                        background: "var(--ide-chrome)",
                        color: "var(--text)",
                        resize: "vertical",
                      }}
                    />

                    {/* Inline Unified Git Diff / AI Ghost Patch Drawer */}
                    {showInlineDiff && (
                      <div
                        data-testid="ide-inline-diff-view"
                      >
                        <div
                        >
                          Unified Git Diff ({activeFile.path}) — +{diffStats.added}{" "}
                          / -{diffStats.removed}
                        </div>
                        {unifiedDiffLines.map((dLine) => (
                          <div
                            key={`diff-${dLine.lineNumber}-${dLine.prefix}`}
                          >
                            {dLine.prefix} {dLine.content}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Right-Hand Minimap Strip (opt-in) */}
                  {panels.minimap && (
                  <div
                    data-testid="ide-editor-minimap"
                    aria-label="Code Minimap"
                  >
                    {activeFileLines.slice(0, 28).map((_lineText, idx) => {
                      const ln = idx + 1;
                      return (
                        <div
                          key={`mm-${ln}`}
                        />
                      );
                    })}
                  </div>
                  )}
                </div>

                {/* Right Split: Embedded Sovereign Browser + F12 CDP Inspector */}
                {splitBrowserOpen && (
                  <div
                    data-testid="ide-split-browser-preview"
                  >
                    <div
                    >
                      <span
                      >
                        Browser preview URL:
                      </span>
                      <input
                        type="text"
                        data-testid="ide-browser-url-input"
                        value={browserUrl}
                        onChange={(e) => setBrowserUrl(e.target.value)}
                      />
                      <button
                        type="button"
                        data-testid="ide-browser-inspect-f12-btn"
                        data-tooltip="Show page inspection availability"
                        onClick={() =>
                          setBrowserDomInspection(
                            `No DOM receipt exists for ${browserUrl}. Open Browser mode to navigate and inspect the real page.`,
                          )
                        }
                      >
                        Inspect F12 DOM
                      </button>
                    </div>
                    <div
                    >
                      {browserDomInspection}
                    </div>
                  </div>
                )}
              </div>

              {chatSyncFeedback && (
                <div
                  data-testid="ide-chat-sync-feedback"
                >
                  {chatSyncFeedback}
                </div>
              )}

              {/* Symbol & Bracket-Balance Status Strip */}
              <div
                data-testid="ide-status-bar"
                className="ide-analysis-strip"
                hidden={!bottomPanelOpen}
              >
                <span>
                  Lines: <strong>{codeAnalysis.lineCount}</strong> • Chars:{" "}
                  <strong>{codeAnalysis.characterCount}</strong> • Symbols:{" "}
                  <strong>{codeAnalysis.symbolCount}</strong> (fn/function:{" "}
                  {codeAnalysis.symbols.functions + codeAnalysis.symbols.rustFns},
                  const: {codeAnalysis.symbols.consts}, export:{" "}
                  {codeAnalysis.symbols.exports}, struct:{" "}
                  {codeAnalysis.symbols.structs}, def:{" "}
                  {codeAnalysis.symbols.pythonDefs})
                </span>
                <span
                  data-testid="ide-bracket-balance-indicator"
                >
                  {codeAnalysis.bracketBalance.summary}
                </span>
              </div>

              {/* Collapsible VS Code Bottom Panel (PROBLEMS | OUTPUT | TERMINAL | PORTS) */}
              <div
                data-testid="vscode-bottom-panel"
                className="ide-bottom-panel"
                hidden={!bottomPanelOpen}
              >
                <div className="ide-bottom-panel__header"
                >
                  <div className="ide-bottom-panel__tabs" role="tablist" aria-label="Panel" aria-orientation="horizontal">
                    {(
                      [
                        {
                          id: "terminal",
                          label: "Terminal",
                        },
                        {
                          id: "problems",
                          label: `Problems (${codeAnalysis.diagnostics.length})`,
                        },
                        {
                          id: "output",
                          label: "Output",
                        },
                        {
                          id: "ports",
                          label: "Ports",
                        },
                      ] as const
                    ).map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        role="tab"
                        id={localPanelTabId(item.id)}
                        aria-selected={bottomPanelTab === item.id}
                        aria-controls="ide-bottom-panel-tabpanel"
                        tabIndex={bottomPanelTab === item.id ? 0 : -1}
                        ref={(element) => {
                          if (element) bottomPanelTabRefs.current.set(item.id, element);
                          else bottomPanelTabRefs.current.delete(item.id);
                        }}
                        onClick={() => {
                          setBottomPanelTab(item.id);
                          setBottomPanelOpen(true);
                        }}
                        onKeyDown={(event) => handleBottomPanelTabKeyDown(item.id, event)}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>

                  <button
                    type="button"
                    aria-label="Close panel"
                    title="Close panel"
                    onClick={() => setBottomPanelOpen(false)}
                  >
                    <X size={14} aria-hidden="true" />
                  </button>
                </div>

                {/* Integrated Terminal Output (kept in DOM for test reliability) */}
                <div
                  id="ide-bottom-panel-tabpanel"
                  role="tabpanel"
                  aria-labelledby={localPanelTabId(bottomPanelTab)}
                  tabIndex={0}
                  data-testid="ide-terminal-output"
                  style={{
                    display: "block",
                    padding: "8px 10px",
                    fontFamily: "monospace",
                    fontSize: "12px",
                    color: "var(--ide-fg)",
                    maxHeight: "100px",
                    overflowY: "auto",
                  }}
                >
                  {bottomPanelTab === "problems" &&
                  codeAnalysis.diagnostics.length > 0 ? (
                    codeAnalysis.diagnostics.map((diag, idx) => (
                      <div key={`diag-${idx}`} >
                        [Problem] {diag}
                      </div>
                    ))
                  ) : bottomPanelTab === "ports" ? (
                    <div>
                      [Port 1420] Sovereign Vite/Tauri Workbench -&gt;READY •
                      [Port 9443] Tailscale Mesh Daemon -&gt;{" "}
                      {daemonConfig.sessionEndpoint}
                    </div>
                  ) : null}
                  {terminalLogs.map((entry, idx) => (
                    <div key={`${idx}-${entry}`}>{entry}</div>
                  ))}
                </div>
              </div>
              </div>
            </div>


          </div>

          {/* ================================================================ */}
          {/* COLLAPSIBLE ON-DEMAND REMOTE HOST DRAWER (KVM / DISK / TUNNEL)   */}
          {/* Triggered via VS Code Activity Bar or Status Bar; collapsed      */}
          {/* by default so primary view is 100% pure Embedded VS Code.        */}
          {/* ================================================================ */}
          <details
            className="sw-accordion"
            data-testid="vscode-remote-host-drawer"
            open={remoteDrawerOpen}
          >
            <summary
              onClick={(e) => {
                e.preventDefault();
                setRemoteDrawerOpen((prev) => {
                  const next = !prev;
                  if (next && activeTab === "editor") {
                    setActiveTab("remote-screen");
                  }
                  return next;
                });
              }}
            >
              <span >
                {remoteDrawerOpen ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />} Remote Host &amp; Device Tools
                (On-Demand Drawer)
              </span>
              <span
              >
                Focus Editor · Screen Share · Disk Mounts · SSH / Tunnel
              </span>
            </summary>

            {/* Drawer Body Header: 4 Perspective Tab Buttons mounted inside the drawer body */}
            <div
            >
              <nav
                role="tablist"
                aria-label="VS Code Remote Extension Panels"
              >
                <button
                  type="button"
                  role="tab"
                  data-testid="ide-tab-editor"
                  aria-selected={activeTab === "editor" && !remoteDrawerOpen}
                  onClick={() => {
                    setActiveTab("editor");
                    setRemoteDrawerOpen(false);
                  }}
                >
                  Focus Editor
                </button>
                <button
                  type="button"
                  role="tab"
                  data-testid="ide-tab-remote-screen"
                  aria-selected={
                    remoteDrawerOpen && activeTab === "remote-screen"
                  }
                  onClick={() => {
                    setActiveTab("remote-screen");
                    setRemoteDrawerOpen(true);
                  }}
                  style={{
                    padding: "2px 7px",
                    minHeight: "22px",
                    borderRadius: "4px",
                    border: "1px solid var(--ide-border)",
                    background:
                      remoteDrawerOpen && activeTab === "remote-screen"
                        ? "var(--ide-raised)"
                        : "transparent",
                    color:
                      remoteDrawerOpen && activeTab === "remote-screen"
                        ? "var(--text)"
                        : "var(--text-secondary)",
                    fontSize: "12px",
                    cursor: "pointer",
                  }}
                >
                  Screen Share
                </button>
                <button
                  type="button"
                  role="tab"
                  data-testid="ide-tab-disk-explorer"
                  aria-selected={
                    remoteDrawerOpen && activeTab === "disk-explorer"
                  }
                  onClick={() => {
                    setActiveTab("disk-explorer");
                    setRemoteDrawerOpen(true);
                  }}
                  style={{
                    padding: "2px 7px",
                    minHeight: "22px",
                    borderRadius: "4px",
                    border: "1px solid var(--ide-border)",
                    background:
                      remoteDrawerOpen && activeTab === "disk-explorer"
                        ? "var(--ide-raised)"
                        : "transparent",
                    color:
                      remoteDrawerOpen && activeTab === "disk-explorer"
                        ? "var(--text)"
                        : "var(--text-secondary)",
                    fontSize: "12px",
                    cursor: "pointer",
                  }}
                >
                  Disk Mounts
                </button>
                <button
                  type="button"
                  role="tab"
                  data-testid="ide-tab-remote-daemon"
                  aria-selected={
                    remoteDrawerOpen && activeTab === "remote-daemon"
                  }
                  onClick={() => {
                    setActiveTab("remote-daemon");
                    setRemoteDrawerOpen(true);
                  }}
                  style={{
                    padding: "2px 7px",
                    minHeight: "22px",
                    borderRadius: "4px",
                    border: "1px solid var(--ide-border)",
                    background:
                      remoteDrawerOpen && activeTab === "remote-daemon"
                        ? "var(--ide-raised)"
                        : "transparent",
                    color:
                      remoteDrawerOpen && activeTab === "remote-daemon"
                        ? "var(--text)"
                        : "var(--text-secondary)",
                    fontSize: "12px",
                    cursor: "pointer",
                  }}
                >
                  SSH / Tunnel
                </button>
              </nav>
            </div>

          {/* ================================================================ */}
          {/* LAYER 2: MULTI-MONITOR KVM & OMNIPARSER v2 SET-OF-MARKS (SoM)    */}
          {/* ================================================================ */}
          <div
            data-testid="ide-panel-remote-screen"
            data-active={activeTab === "remote-screen" ? "true" : "false"}
            style={{
              display: activeTab === "remote-screen" ? "flex" : "none",
              flexDirection: "column",
              gap: "10px",
              padding: "10px",
              background: "var(--surface-selected)",
              flex: 1,
            }}
          >
            {/* Top KVM Control Bar */}
            <div
            >
              <div
              >
                <label
                  htmlFor="remote-surface-select"
                >
                  Capture Surface:
                </label>
                <select
                  id="remote-surface-select"
                  data-testid="remote-surface-select"
                  value={selectedSurfaceId}
                  onChange={(e) => setSelectedSurfaceId(e.target.value)}
                >
                  {DEFAULT_REMOTE_CAPTURE_SURFACES.map((surface) => (
                    <option key={surface.id} value={surface.id}>
                      {surface.label}
                    </option>
                  ))}
                </select>

                <select
                  aria-label="Remote Input Delivery Method"
                  data-testid="remote-delivery-method-select"
                  value={selectedDeliveryMethod}
                  onChange={(e) =>
                    setSelectedDeliveryMethod(
                      e.target.value as RemoteInputDeliveryMethod,
                    )
                  }
                >
                  <option value="win32-postmessage-isolated">
                    Win32 PostMessageW Isolated (No Cursor Hijack)
                  </option>
                  <option value="sendinput-global">
                    Win32 SendInput Global Desktop
                  </option>
                  <option value="webrtc-data-channel">
                    WebRTC Low-Latency DataChannel
                  </option>
                </select>
              </div>

              <div >
                <button
                  type="button"
                  data-testid="toggle-omniparser-som-btn"
                  data-tooltip="Toggle OmniParser v2 Set-of-Marks ([#1]..[#6]) Bounding-Box Grounding"
                  onClick={() => setSomOverlayEnabled((prev) => !prev)}
                >
                  {somOverlayEnabled
                    ? "SoM Overlay: ON ([#1]..[#6])"
                    : "SoM Overlay: OFF"}
                </button>

                <button
                  type="button"
                  data-testid="start-live-screen-share-btn"
                  onClick={() => void handleStartLiveScreenShare()}
                >
                  Start Live Screen/Window Share (getDisplayMedia)
                </button>
              </div>
            </div>

            <div
              data-testid="screen-share-status-banner"
              style={{
                fontSize: "12px",
                color: screenShareActive ? "var(--ide-fg)" : "var(--text-secondary)",
              }}
            >
              {screenShareStatus}
            </div>

            <ComputerUseVideoOverlayPanel
              surfaceId={selectedSurface.id}
              surfaceLabel={selectedSurface.label}
              processName={selectedSurface.processName}
              testIdPrefix="ide-computer-use-video"
            />

            {/* 3-Column Progressive Disclosure KVM Layout: Left Surface Rail + Center SoM Viewport + Right Telemetry Drawer */}
            <div
            >
              {/* Left Compact Surface List */}
              <div
              >
                <div
                >
                  DISPLAY &amp; HWND MATRIX
                </div>
                {DEFAULT_REMOTE_CAPTURE_SURFACES.map((surf) => (
                  <button
                    key={`card-${surf.id}`}
                    type="button"
                    onClick={() => setSelectedSurfaceId(surf.id)}
                  >
                    <div >
                      {surf.kind === "multi-monitor-panorama"
                        ? "All Monitors 5760×2160"
                        : surf.kind === "single-display"
                          ? `Display ${surf.monitorIndex}: ${surf.refreshRateHz}Hz`
                          : `Window ${surf.processName} (${surf.windowHandleHex})`}
                    </div>{" "}
                    <div >
                      {surf.resolutionWidth}×{surf.resolutionHeight} @{" "}
                      {surf.refreshRateHz}Hz
                    </div>
                  </button>
                ))}
              </div>

              {/* Center Interactive KVM Viewport Canvas + OmniParser v2 Set-of-Marks Overlay */}
              <div
                data-testid="remote-desktop-viewport"
                role="region"
                aria-label="Interactive Remote Desktop and Window Control Viewport"
                onClick={handleViewportClick}
              >
                <video ref={screenVideoRef} autoPlay muted playsInline aria-label="Live shared screen" style={{ display: screenShareActive ? "block" : "none", width: "100%", maxHeight: "420px", objectFit: "contain" }} />
                <div>
                  <div
                  >
                    Capture preset: {selectedSurface.label}
                  </div>
                  <div >
                    Bounds: {selectedSurface.resolutionWidth}×
                    {selectedSurface.resolutionHeight} @{" "}
                    {selectedSurface.refreshRateHz}Hz •{" "}
                    {selectedSurface.windowHandleHex
                      ? `HWND: ${selectedSurface.windowHandleHex} (${selectedSurface.processName})`
                      : "Desktop Duplication"}
                  </div>
                </div>

                {/* OmniParser v2 Set-of-Marks ([#1]..[#6]) Visual Grounding Grid */}
                {somOverlayEnabled && (
                  <div
                    data-testid="omniparser-som-overlay"
                  >
                    {somTargets.map((target) => (
                      <button
                        key={target.id}
                        type="button"
                        data-testid={`som-mark-${target.markNumber}`}
                        data-tooltip={`${target.tag} ${target.label} (${target.bounds.x},${target.bounds.y} ${target.bounds.width}×${target.bounds.height})`}
                        onClick={(e) => handleSomTargetClick(e, target)}
                      >
                        <div
                        >
                          <span
                          >
                            {target.tag} {target.role.toUpperCase()}
                          </span>
                          <span >
                            {Math.round(target.confidence * 100)}%
                          </span>
                        </div>
                        <div
                        >
                          {target.label}
                        </div>
                        <div >
                          center=({target.centerX}, {target.centerY}) •{" "}
                          {target.hwnd}
                        </div>
                      </button>
                    ))}
                  </div>
                )}

                <div >
                  The Set-of-Marks targets below are a local planning overlay, not live vision detections. Native input requires a configured isolated channel; web preview records packets without controlling the host.
                </div>
              </div>

              {/* Right Collapsible Remote Input & Telemetry Drawer */}
              <div
              >
                {/* Computer-Use Action Planner */}
                <details className="sw-accordion" open>
                  <summary
                  >
                    Computer-use action planner
                  </summary>
                  <div
                  >
                    <div >
                      <input
                        type="text"
                        data-testid="computer-use-goal-input"
                        value={computerUseGoal}
                        onChange={(e) => setComputerUseGoal(e.target.value)}
                        placeholder="Agent Computer-Use goal..."
                      />
                      <button
                        type="button"
                        data-testid="computer-use-plan-btn"
                        onClick={handlePlanComputerUseSequence}
                      >
                        Plan &amp; Ground
                      </button>
                    </div>
                    {computerUsePlan.length > 0 && (
                      <div
                        data-testid="computer-use-plan-output"
                      >
                        {computerUsePlan.map((step) => (
                          <div key={`plan-${step.step}`}>
                            {step.step}. {step.description}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </details>

                {/* Remote Keyboard & Chord Dispatcher */}
                <details className="sw-accordion" open>
                  <summary
                  >
                    Keyboard &amp; Win32 chords
                  </summary>
                  <div
                  >
                    <div
                    >
                      {QUICK_REMOTE_CHORDS.map((item) => (
                        <button
                          key={item.chord}
                          type="button"
                          data-testid={`remote-chord-btn-${item.chord}`}
                          onClick={() => handleSendRemoteChord(item.chord)}
                        >
                          {item.label}
                        </button>
                      ))}
                    </div>

                    <div >
                      <input
                        type="text"
                        data-testid="remote-keyboard-text-input"
                        aria-label="Remote Keyboard Text Sequence"
                        value={remoteKeyboardText}
                        onChange={(e) => setRemoteKeyboardText(e.target.value)}
                        placeholder="Type remote command..."
                      />

                      <button
                        type="button"
                        data-testid="send-remote-keys-btn"
                        onClick={handleSendRemoteKeysText}
                      >
                        Send Keys
                      </button>
                    </div>
                  </div>
                </details>

                {/* Live Remote Input Audit Log */}
                <div
                  data-testid="remote-input-audit-log"
                >
                  <div
                  >
                    PostMessageW Audit ({remoteInputLog.length})
                  </div>
                  {remoteInputLog.length === 0 ? (
                    <div>No remote input packets dispatched yet.</div>
                  ) : (
                    remoteInputLog.slice(0, 6).map((pkt) => (
                      <div key={`${pkt.id}-${pkt.timestamp}`}>
                        [{pkt.id}] surface={pkt.surfaceId} type={pkt.type}{" "}
                        {typeof pkt.x === "number"
                          ? `coords=(${pkt.x}, ${pkt.y})`
                          : ""}{" "}
                        {pkt.keyOrChord ? `chord=${pkt.keyOrChord}` : ""}{" "}
                        {pkt.text ? `text="${pkt.text}"` : ""} •{" "}
                        {pkt.win32MessageHex} lParam={pkt.lParamHex} via{" "}
                        {pkt.deliveryMethod}
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* ================================================================ */}
          {/* LAYER 3: DUAL-PANE REMOTE & LOCAL DISK COMMANDER (C:\ / D:\ / Z:\)*/}
          {/* ================================================================ */}
          <div
            data-testid="ide-panel-disk-explorer"
            data-active={activeTab === "disk-explorer" ? "true" : "false"}
            style={{
              display: activeTab === "disk-explorer" ? "flex" : "none",
              flexDirection: "column",
              gap: "10px",
              padding: "10px",
              background: "var(--surface-selected)",
              flex: 1,
            }}
          >
            <p className="ide-fallback-boundary">Local disk planning data. Entries and free-space figures are workspace samples, not a live host-volume receipt. Creating an entry or transfer plan here does not perform filesystem I/O. Use the real VS Code Explorer for files.</p>
            <div
            >
              <div >
                {diskVolumes.map((vol) => (
                  <button
                    key={vol.volumeId}
                    type="button"
                    data-testid={`disk-volume-btn-${vol.volumeId}`}
                    onClick={() => {
                      setSelectedVolumeId(vol.volumeId);
                      if (vol.entries[0]) {
                        setSelectedDiskEntryPath(vol.entries[0].path);
                      }
                    }}
                  >
                    {vol.mountPoint} — {vol.freeGb.toFixed(2)} GB free /{" "}
                    {vol.totalGb.toFixed(2)} GB ({vol.location})
                  </button>
                ))}
              </div>

              <div >
                <select
                  aria-label="Disk Transfer Direction"
                  data-testid="disk-transfer-direction-select"
                  value={transferDirection}
                  onChange={(e) =>
                    setTransferDirection(
                      e.target.value as DiskTransferDirection,
                    )
                  }
                >
                  <option value="local-to-remote">
                    Local (C:\ / D:\) -&gt; Remote (Z:\ NVMe)
                  </option>
                  <option value="remote-to-local">
                    Remote (Z:\ NVMe) -&gt; Local (D:\)
                  </option>
                  <option value="local-copy">Local NVMe Copy</option>
                </select>

                <button
                  type="button"
                  data-testid="disk-transfer-file-btn"
                  onClick={handleTransferDiskFile}
                >
                  Transfer File (Local &lt;-&gt; Remote)
                </button>
              </div>
            </div>

            {/* Dual-Pane Directory Entries + File Content Inspector */}
            <div
            >
              <div
              >
                {selectedVolume.entries.map((entry) => (
                  <button
                    key={entry.path}
                    type="button"
                    data-testid={`disk-entry-item-${entry.name}`}
                    onClick={() => setSelectedDiskEntryPath(entry.path)}
                  >
                    <div >{entry.path}</div>{" "}
                    <div >
                      {entry.kind.toUpperCase()} •{" "}
                      {entry.sizeBytes.toLocaleString()} bytes
                    </div>
                  </button>
                ))}

                <div >
                  <input
                    type="text"
                    data-testid="disk-create-file-input"
                    value={newDiskFileName}
                    onChange={(e) => setNewDiskFileName(e.target.value)}
                    placeholder="new-remote-config.json"
                  />
                  <button
                    type="button"
                    data-testid="disk-create-file-btn"
                    onClick={handleCreateDiskFile}
                  >
                    + Create local entry
                  </button>
                </div>
              </div>

              <div
              >
                <div
                >
                  Disk Entry Inspector:{" "}
                  <code>{selectedDiskEntry?.path ?? "None selected"}</code>
                </div>
                <textarea
                  data-testid="disk-entry-preview-textarea"
                  value={
                    selectedDiskEntry?.previewContent ??
                    `[Directory Mount] ${selectedDiskEntry?.path ?? ""}`
                  }
                  onChange={(e) => handleUpdateDiskEntryPreview(e.target.value)}
                  rows={5}
                />

                {/* Zero-Copy Transfer Ledger */}
                <div
                  data-testid="disk-transfer-ledger"
                >
                  <div >
                    Disk transfer plans ({transferJobs.length})
                  </div>
                  {transferJobs.length === 0 ? (
                    <div>No disk transfer plans. This view does not perform file I/O.</div>
                  ) : (
                    transferJobs.slice(0, 4).map((job) => (
                      <div key={`${job.id}-${job.createdAt}`}>
                        [{job.id}] {job.sourcePath} -&gt; {job.destinationPath}{" "}
                        ({job.direction} • {job.protocol} • planned, not transferred)
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* ================================================================ */}
          {/* LAYER 4: OMNIA REMOTE CONTROL DAEMON (WEBRTC / TAILSCALE MESH)   */}
          {/* ================================================================ */}
          <div
            data-testid="ide-panel-remote-daemon"
            data-active={activeTab === "remote-daemon" ? "true" : "false"}
            style={{
              display: activeTab === "remote-daemon" ? "flex" : "none",
              flexDirection: "column",
              gap: "10px",
              padding: "12px",
              background: "var(--surface-selected)",
              flex: 1,
            }}
          >
            <p className="ide-fallback-boundary">Remote adapter configuration preview. Editing these settings does not connect a daemon or grant operating-system permission. Native input dispatch still requires an accepted isolated channel.</p>
            <div
            >
              <div
              >
                <span >
                  Omnia Remote Session URI:
                </span>
                <input
                  type="text"
                  data-testid="remote-daemon-endpoint-input"
                  value={daemonConfig.sessionEndpoint}
                  onChange={(e) =>
                    setDaemonConfig((prev) => ({
                      ...prev,
                      sessionEndpoint: e.target.value,
                    }))
                  }
                />

                <select
                  aria-label="Omnia Remote Transport"
                  data-testid="remote-daemon-transport-select"
                  value={daemonConfig.transport}
                  onChange={(e) =>
                    setDaemonConfig((prev) => ({
                      ...prev,
                      transport: e.target
                        .value as OmniaRemoteDaemonConfig["transport"],
                    }))
                  }
                >
                  <option value="tailscale-mesh">
                    Tailscale mesh (configuration only)
                  </option>
                  <option value="webrtc-p2p">WebRTC P2P (configuration only)</option>
                  <option value="ws-tunnel">WebSocket tunnel (configuration only)</option>
                </select>
              </div>

              <button
                type="button"
                data-testid="copy-remote-attach-token-btn"
                onClick={() => void handleCopyAttachToken()}
              >
                Copy configured attach token
              </button>
            </div>

            {/* Remote Control Permission Toggles */}
            <div
            >
              <label
              >
                <input
                  type="checkbox"
                  data-testid="perm-toggle-screen-control"
                  checked={daemonConfig.permissions.allowRemoteScreenControl}
                  onChange={() =>
                    handleTogglePermission("allowRemoteScreenControl")
                  }
                />
                Allow Remote Screen Control
              </label>

              <label
              >
                <input
                  type="checkbox"
                  data-testid="perm-toggle-mouse-keyboard"
                  checked={daemonConfig.permissions.allowRemoteMouseKeyboard}
                  onChange={() =>
                    handleTogglePermission("allowRemoteMouseKeyboard")
                  }
                />
                Allow Remote Mouse/Keyboard
              </label>

              <label
              >
                <input
                  type="checkbox"
                  data-testid="perm-toggle-disk-rw"
                  checked={daemonConfig.permissions.allowRemoteDiskReadWrite}
                  onChange={() =>
                    handleTogglePermission("allowRemoteDiskReadWrite")
                  }
                />
                Allow Remote Disk Read/Write
              </label>

              <label
              >
                <input
                  type="checkbox"
                  data-testid="perm-toggle-subagent-spawn"
                  checked={daemonConfig.permissions.allowRemoteSubagentSpawn}
                  onChange={() =>
                    handleTogglePermission("allowRemoteSubagentSpawn")
                  }
                />
                Allow Remote Subagent Spawn
              </label>
            </div>

            {tokenCopiedBanner && (
              <div
                data-testid="remote-daemon-token-banner"
              >
                {tokenCopiedBanner}
              </div>
            )}
          </div>
          </details>
        </div>
        {agySidebarOpen && (
          <div
            className="ide-panel-resizer"
            data-testid="ide-ai-sidebar-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize AI sidebar"
            aria-valuemin={260}
            aria-valuemax={640}
            aria-valuenow={agySidebarWidth}
            aria-valuetext={`${agySidebarWidth} pixels`}
            tabIndex={0}
            style={nativeEditor ? { marginInline: 0 } : undefined}
            onPointerDown={(event) => startIdePanelResize("ai", event)}
            onDoubleClick={() => setAgySidebarWidth(360)}
            onKeyDown={(event) => handleIdePanelResizeKeyDown("ai", event)}
          />
        )}
        {agySidebarOpen && <IdeAgentSidebar
          activeFile={activeFile}
          selectedCode={selectedCode}
          projects={projectFolders}
          projectPanelRequest={projectPanelRequest}
          utilityPanel={agentUtilityPanel}
          terminalContext={terminalLogs.join("\n")}
          gitDiff={unifiedDiffLines.map((line) => `${line.prefix}${line.content}`).join("\n")}
          onClose={() => setAgySidebarOpen(false)}
          onApplyCode={(code) => { handleCodeChange(`${activeFile.content.trimEnd()}\n\n${code}\n`); setChatSyncFeedback(`Applied assistant code to local buffer ${activeFile.path}; embedded VS Code file is unchanged.`); }}
          onAddProject={addProjectFolder}
          {...(nativeEditor ? { onPickProject: pickProjectFolder } : {})}
          allowEmptyWorkspace={nativeEditor}
          onRemoveProject={removeProjectFolder}
          onOpenRemote={() => openRemotePanel("remote-screen")}
          onOpenDisk={() => openRemotePanel("disk-explorer")}
          onOpenSplit={() => { setRealVsCodeEmbedOpen(false); openRemotePanel("editor"); }}
        />}
      </div>

      {/* 6. BOTTOM 22px VS CODE STATUS BAR (.sw-statusbar) */}
      <footer
        className="sw-statusbar"
        data-testid="vscode-workbench-statusbar"
        style={{
          minHeight: "22px",
          display: panels.statusbar && !isPureEmbeddedVsCode ? "flex" : "none",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "8px",
          padding: "2px 10px",
          background: "var(--ide-chrome)",
          color: "var(--ide-fg)",
          fontSize: "12px",
          fontWeight: 600,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <button
            type="button"
            data-testid="vscode-statusbar-remote-trigger"
            onClick={() => {
              setRemoteDrawerOpen((prev) => !prev);
              if (activeTab === "editor") {
                setActiveTab("remote-screen");
              }
            }}
            style={{
              border: "none",
              background: "var(--ide-raised)",
              color: "var(--ide-fg)",
              fontSize: "12px",
              fontWeight: 700,
              padding: "1px 6px",
              borderRadius: "3px",
              cursor: "pointer",
            }}
          >
            &gt;&lt; WSL / Remote Host
          </button>
          <span><GitBranch size={14} aria-hidden="true" /> main*</span>
          <span>
            {codeAnalysis.diagnostics.length} Buffer diagnostics
          </span>
          <span>Local buffer analysis</span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <span>
            Ln {cursorLine}, Col {cursorCol}
          </span>
          <span>Spaces: 2</span>
          <span>UTF-8</span>
          <span>CRLF</span>
          <span>{activeFile.language.toUpperCase()}</span>
        </div>
      </footer>
      {codeNavigationPreview ? (
        <ModalSurface className="ide-code-navigation-preview" ariaLabel="Code preview" title="Code preview" onClose={() => setCodeNavigationPreview(null)}>
          <header>
            <FileCode2 size={16} strokeWidth={1.75} aria-hidden="true" />
            <strong>{codeNavigationPreview.filename ?? codeNavigationPreview.language}{codeNavigationPreview.lineRange ? `:${codeNavigationPreview.lineRange}` : ""}</strong>
            <button type="button" className="icon-button" title="Copy code" aria-label="Copy code" onClick={() => {
              if (!navigator.clipboard?.writeText) { setCodePreviewError("Clipboard is unavailable."); return; }
              void navigator.clipboard.writeText(codeNavigationPreview.code).catch(() => setCodePreviewError("Couldn't copy code. Select it and copy manually."));
            }}><Copy size={15} strokeWidth={1.75} aria-hidden="true" /></button>
            <button type="button" className="icon-button" title="Close code preview" aria-label="Close code preview" onClick={() => setCodeNavigationPreview(null)}><X size={16} strokeWidth={1.75} aria-hidden="true" /></button>
          </header>
          <p>Read-only snippet. Your project files are unchanged.</p>
          <textarea aria-label="Read-only code snippet" spellCheck={false} readOnly value={codeNavigationPreview.code} />
          {codePreviewError ? <p role="alert">{codePreviewError}</p> : null}
        </ModalSurface>
      ) : null}
    </section>
  );
}

export default SovereignIdeRemoteWorkbench;
