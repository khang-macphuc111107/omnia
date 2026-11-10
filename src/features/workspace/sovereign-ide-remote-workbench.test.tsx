import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SOVEREIGN_IDE_REMOTE_STORAGE_KEY } from "@/domain/sovereign-ide-remote-desktop";
import { IDE_LAYOUT_STORAGE_KEY, SovereignIdeRemoteWorkbench } from "@/features/workspace/sovereign-ide-remote-workbench";
import { useWorkspaceStore } from "@/features/workspace/store";
import { desktop } from "@/lib/desktop";
import * as editorTransport from "./ide-editor-transport";

const initialWorkspaceState = useWorkspaceStore.getState();
const originalUserAgent = navigator.userAgent;
const originalLocalStorage = Object.getOwnPropertyDescriptor(window, "localStorage");

function enablePanel(name: string) {
  fireEvent.click(screen.getByRole("button", { name: "More panels" }));
  const box = within(screen.getByTestId("ide-more-panels-menu")).getByRole("checkbox", { name });
  if (!(box as HTMLInputElement).checked) fireEvent.click(box);
  fireEvent.keyDown(window, { key: "Escape" });
}

function stubLocalStorage(storage: Pick<Storage, "getItem" | "setItem" | "removeItem">) {
  vi.stubGlobal("localStorage", storage);
  Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
}

function memoryStorage() {
  const map = new Map<string, string>();
  return { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => void map.set(key, value), removeItem: (key: string) => void map.delete(key) };
}

function openAiSidebar() {
  fireEvent.click(screen.getByTestId("ide-toggle-agy-sidebar-btn"));
  return screen.getByTestId("ide-agy-ai-sidebar");
}

describe("SovereignIdeRemoteWorkbench", () => {
  afterEach(() => {
    if (originalLocalStorage) Object.defineProperty(window, "localStorage", originalLocalStorage);
    // Release listeners, capture streams, and store subscribers before reset.
    cleanup();
    useWorkspaceStore.setState(initialWorkspaceState, true);
    Object.defineProperty(navigator, "userAgent", { configurable: true, value: originalUserAgent });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    useWorkspaceStore.setState(initialWorkspaceState, true);
    window.localStorage?.removeItem?.(SOVEREIGN_IDE_REMOTE_STORAGE_KEY);
    window.localStorage?.removeItem?.(IDE_LAYOUT_STORAGE_KEY);
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it("renders all 4 tabs, edits polyglot code, runs terminal command, and sends buffer to active chat", () => {
    render(<SovereignIdeRemoteWorkbench />);

    expect(screen.getByTestId("sovereign-ide-remote-workbench")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Sovereign IDE & Remote Desktop" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("ide-panel-editor")).toHaveAttribute(
      "data-active",
      "true",
    );
    expect(
      screen.getByTestId("vscode-remote-host-drawer"),
    ).not.toHaveAttribute("open");
    const editorTabBar = screen.getByTestId("vscode-editor-tabbar");
    expect(editorTabBar).toContainElement(
      screen.getByTestId("ide-run-terminal-btn"),
    );
    expect(editorTabBar).toContainElement(
      screen.getByTestId("ide-send-to-chat-btn"),
    );
    expect(screen.getByTestId("ide-tab-editor")).toBeInTheDocument();
    expect(screen.getByTestId("ide-tab-remote-screen")).toBeInTheDocument();
    expect(screen.getByTestId("ide-tab-disk-explorer")).toBeInTheDocument();
    expect(screen.getByTestId("ide-tab-remote-daemon")).toBeInTheDocument();

    const editor = screen.getByTestId("ide-code-editor-textarea") as HTMLTextAreaElement;
    expect(editor.value).toContain("SovereignRuntimeProbe");

    fireEvent.change(editor, {
      target: {
        value: "export function computeMatrix() {\n  const ready = true;\n  return ready;\n}",
      },
    });

    expect(screen.getByTestId("ide-bracket-balance-indicator")).toHaveTextContent(
      "Delimiters balanced",
    );

    fireEvent.click(screen.getByTestId("ide-run-terminal-btn"));
    expect(screen.getByTestId("ide-terminal-output")).toHaveTextContent("npx vitest run");

    fireEvent.click(screen.getByTestId("ide-send-to-chat-btn"));
    expect(screen.getByTestId("ide-chat-sync-feedback")).toHaveTextContent(
      "Added src/domain/sovereign-ide-remote-desktop.ts",
    );

    const activeConvId = useWorkspaceStore.getState().activeConversationId;
    const activeConv = useWorkspaceStore
      .getState()
      .conversations.find((c) => c.id === activeConvId);
    expect(activeConv?.draft).toContain("computeMatrix");
  });

  it("switches multi-monitor and app-window capture surfaces, calls getDisplayMedia, and dispatches remote mouse & keyboard events", async () => {
    const getDisplayMediaMock = vi.fn().mockResolvedValue({ id: "mock-media-stream" });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getDisplayMedia: getDisplayMediaMock,
      },
    });

    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    const sendIsolatedSpy = vi
      .spyOn(desktop, "sendIsolatedInputEvent")
      .mockResolvedValue({
        accepted: true,
        channelId: "isolated-window-chrome-canary",
        reason: "ok",
      });

    render(<SovereignIdeRemoteWorkbench />);

    fireEvent.click(screen.getByTestId("ide-tab-remote-screen"));

    const surfaceSelect = screen.getByTestId("remote-surface-select") as HTMLSelectElement;
    expect(surfaceSelect.options).toHaveLength(7);

    fireEvent.change(surfaceSelect, { target: { value: "window-chrome-canary" } });
    expect(surfaceSelect.value).toBe("window-chrome-canary");

    fireEvent.click(screen.getByTestId("start-live-screen-share-btn"));
    await waitFor(() => {
      expect(getDisplayMediaMock).toHaveBeenCalledWith({
        video: true,
        audio: false,
      });
    });

    fireEvent.click(screen.getByTestId("remote-desktop-viewport"));
    expect(screen.getByTestId("remote-input-audit-log")).toHaveTextContent(
      "surface=window-chrome-canary type=mouse-click",
    );

    const keyboardInput = screen.getByTestId("remote-keyboard-text-input");
    fireEvent.change(keyboardInput, {
      target: { value: "npm run check" },
    });
    fireEvent.click(screen.getByTestId("send-remote-keys-btn"));

    expect(screen.getByTestId("remote-input-audit-log")).toHaveTextContent(
      'type=key-type chord=TextSequence text="npm run check"',
    );
    expect(sendIsolatedSpy).toHaveBeenCalled();

    sendIsolatedSpy.mockRestore();
  });

  it("explores C:\\, D:\\, and Z:\\ remote volumes, creates files, and executes Local <-> Remote disk transfers", () => {
    render(<SovereignIdeRemoteWorkbench />);

    fireEvent.click(screen.getByTestId("ide-tab-disk-explorer"));

    const remoteVolBtn = screen.getByTestId("disk-volume-btn-vol-remote-z");
    fireEvent.click(remoteVolBtn);
    expect(remoteVolBtn).toHaveTextContent("1420.00 GB free / 2048.00 GB");

    fireEvent.change(screen.getByTestId("disk-create-file-input"), {
      target: { value: "cluster-node-health.json" },
    });
    fireEvent.click(screen.getByTestId("disk-create-file-btn"));
    expect(
      screen.getByTestId("disk-entry-item-cluster-node-health.json"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("disk-transfer-file-btn"));
    expect(screen.getByTestId("disk-transfer-ledger")).toHaveTextContent(
      "Tailscale-QUIC-ZeroCopy",
    );
  });

  it("configures Omnia Remote Control Daemon permissions and copies attach token", async () => {
    render(<SovereignIdeRemoteWorkbench />);

    fireEvent.click(screen.getByTestId("ide-tab-remote-daemon"));

    const screenPermCheckbox = screen.getByTestId(
      "perm-toggle-screen-control",
    ) as HTMLInputElement;
    expect(screenPermCheckbox.checked).toBe(true);
    fireEvent.click(screenPermCheckbox);
    expect(screenPermCheckbox.checked).toBe(false);

    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
    fireEvent.click(screen.getByTestId("copy-remote-attach-token-btn"));
    await waitFor(() => {
      expect(screen.getByTestId("remote-daemon-token-banner")).toHaveTextContent(
        "Copied attach token",
      );
    });
  });

  it("renders VS Code Activity Bar with hover tooltips, AST Symbol Outline navigation, Ripgrep search, Inline Git Diff, and OmniParser SoM KVM marks", () => {
    render(<SovereignIdeRemoteWorkbench />);

    // Verify 7 Activity Bar buttons with data-tooltip attributes
    expect(screen.getByTestId("activity-bar-explorer")).toHaveAttribute(
      "data-tooltip",
      "Explorer (Ctrl+Shift+E)",
    );
    expect(screen.getByTestId("activity-bar-search")).toHaveAttribute(
      "data-tooltip",
      "Search & Ripgrep (Ctrl+Shift+F)",
    );
    expect(screen.getByTestId("activity-bar-scm")).toHaveAttribute(
      "data-tooltip",
      "Source Control Git Diff (Ctrl+Shift+G)",
    );
    expect(screen.getByTestId("activity-bar-debug")).toHaveAttribute(
      "data-tooltip",
      "Run & Debug / LSP Diagnostics (Ctrl+Shift+D)",
    );
    expect(screen.getByTestId("activity-bar-kvm")).toHaveAttribute(
      "data-tooltip",
      "Multi-Monitor KVM & OmniParser SoM (Ctrl+Shift+M)",
    );
    expect(screen.getByTestId("ide-tab-remote-disk")).toHaveAttribute(
      "data-tooltip",
      "Remote & Local Disk Commander (Ctrl+Shift+K)",
    );
    expect(screen.getByTestId("activity-bar-extensions")).toHaveAttribute(
      "data-tooltip",
      "MCP & Language Server Extensions (Ctrl+Shift+X)",
    );

    // Outline and search are opt-in panels behind "More panels".
    expect(screen.queryByTestId("ide-outline-tree")).not.toBeInTheDocument();
    enablePanel("Outline");
    enablePanel("Search & diff");

    // Click AST Symbol Outline entry to jump to Ln 13
    const verifyFnSymbol = screen.getByTestId(
      "ide-outline-symbol-verifySovereignBridge",
    );
    expect(verifyFnSymbol).toHaveTextContent("Ln 13");
    fireEvent.click(verifyFnSymbol);
    expect(screen.getByTestId("vscode-workbench-statusbar")).toHaveTextContent(
      "Ln 13, Col 1",
    );

    // Test Ripgrep live search in sidebar
    const ripgrepInput = screen.getByTestId("ide-ripgrep-search-input");
    fireEvent.change(ripgrepInput, {
      target: { value: "Win32IsolatedPostMessageFrame" },
    });
    expect(screen.getByTestId("ide-ripgrep-results")).toHaveTextContent(
      "isolated_input_win32.rs:Ln 1",
    );

    // Toggle Inline Git Unified Diff
    fireEvent.click(screen.getByTestId("ide-toggle-inline-diff-btn"));
    expect(screen.getByTestId("ide-inline-diff-view")).toHaveTextContent(
      "Unified Git Diff",
    );

    // Switch to KVM & SoM Vision perspective via Activity Bar icon
    fireEvent.click(screen.getByTestId("activity-bar-kvm"));
    expect(screen.getByTestId("omniparser-som-overlay")).toBeInTheDocument();
    expect(screen.getByTestId("som-mark-1")).toHaveTextContent("[#1]");
    expect(screen.getByTestId("som-mark-6")).toHaveTextContent("[#6]");

    // Click [#1] Set-of-Marks target to dispatch grounded click
    fireEvent.click(screen.getByTestId("som-mark-1"));
    expect(screen.getByTestId("remote-input-audit-log")).toHaveTextContent(
      "type=mouse-click",
    );

    // Run AI Computer-Use Planner
    fireEvent.click(screen.getByTestId("computer-use-plan-btn"));
    expect(screen.getByTestId("computer-use-plan-output")).toHaveTextContent(
      "[#1]",
    );
  });

  it("opens the real multi-root VS Code server after health verification and preserves it beside local buffers", async () => {
    Object.defineProperty(navigator, "userAgent", { configurable: true, value: "Mozilla/5.0 Chrome/140.0" });
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string) => url === "/__omnia_ide_server"
      ? { ok: true, status: 200, json: async () => ({ state: "ready", url: "http://127.0.0.1:1430" }) }
      : { ok: true, json: async () => ({ workspacePath: "D:\\Projects\\Omnia #1 & tools\\current.code-workspace", folders: [
        { name: "omnia-app", path: "D:\\Omnia\\repos\\omnia" },
        { name: "codex-runtime", path: "D:\\CodexBetaPatched" },
      ] }) }));
    render(<SovereignIdeRemoteWorkbench />);

    const iframe = await screen.findByTestId("real-vscode-workbench-iframe");
    await waitFor(() => expect(new URL(iframe.getAttribute("src")!).searchParams.get("workspace")).toBe("/d:/Projects/Omnia #1 & tools/current.code-workspace"));
    expect(iframe).toHaveAttribute("title", "Embedded VS Code Workbench");
    expect(iframe).toHaveAttribute("allow", "clipboard-read; clipboard-write; fullscreen");
    expect(screen.getByTestId("sovereign-ide-remote-workbench")).toHaveAttribute("data-native-editor", "true");
    expect(screen.getByTestId("workspace-mode-tab-chat")).toBeInTheDocument();
    expect(screen.getByTestId("workspace-mode-tab-browser")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "codex-runtime" }));
    const projectFrame = screen.getByTestId("real-vscode-workbench-iframe");
    expect(new URL(projectFrame.getAttribute("src")!).searchParams.get("folder")).toBe("/d:/CodexBetaPatched");
    fireEvent.click(screen.getByTestId("toggle-real-vscode-embed-btn"));
    expect(projectFrame).toBeInTheDocument();
    expect(projectFrame).not.toBeVisible();
    expect(screen.getByTestId("ide-code-editor-textarea")).toBeVisible();
    fireEvent.click(screen.getByTestId("toggle-real-vscode-embed-btn"));
    expect(screen.getByTestId("real-vscode-workbench-iframe")).toBe(projectFrame);
    expect(projectFrame).toBeVisible();
  });

  it("uses the native folder picker and removes folders by native-owned id in the installed application", async () => {
    vi.spyOn(editorTransport, "usesNativeEditorTransport").mockReturnValue(true);
    const pick = vi.spyOn(editorTransport, "pickEditorWorkspaceFolder").mockResolvedValue({
      workspacePath: "C:\\App Data\\editor\\omnia.code-workspace",
      folders: [{ id: "editor_selected", name: "Selected project", path: "D:\\Selected project" }],
    });
    const remove = vi.spyOn(editorTransport, "removeEditorWorkspaceFolder").mockResolvedValue({
      workspacePath: "C:\\App Data\\editor\\omnia.code-workspace", folders: [],
    });
    render(<SovereignIdeRemoteWorkbench />);
    expect(screen.queryByRole("button", { name: "codex-runtime" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open project folder" }));
    expect(await screen.findByRole("button", { name: "Choose folder…" })).toBeVisible();
    expect(screen.queryByTestId("ide-add-project-input")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Choose folder…" }));
    await waitFor(() => expect(pick).toHaveBeenCalledOnce());
    const removeButton = await screen.findByRole("button", { name: "Remove Selected project project folder" });
    expect(removeButton).toBeEnabled();
    fireEvent.click(removeButton);
    await waitFor(() => expect(remove).toHaveBeenCalledWith("editor_selected"));
  });

  it.each([true, false])("IDE resize reserves native gutters while preserving preview overlap (native=%s)", (native) => {
    vi.spyOn(editorTransport, "usesNativeEditorTransport").mockReturnValue(native);
    render(<SovereignIdeRemoteWorkbench />);
    openAiSidebar();
    for (const name of ["Resize primary sidebar", "Resize AI sidebar"]) {
      const separator = screen.getByRole("separator", { name });
      if (native) expect(separator).toHaveStyle({ marginInline: "0" });
      else expect(separator.style.marginInline).toBe("");
    }
  });

  it("IDE resize supports bounded keyboard operation on both sidebar separators", () => {
    render(<SovereignIdeRemoteWorkbench />);
    openAiSidebar();
    const primary = screen.getByRole("separator", { name: "Resize primary sidebar" });
    const ai = screen.getByRole("separator", { name: "Resize AI sidebar" });
    for (const [separator, minimum, maximum, grow, shrink] of [
      [primary, "180", "480", "ArrowRight", "ArrowLeft"],
      [ai, "260", "640", "ArrowLeft", "ArrowRight"],
    ] as const) {
      act(() => separator.focus());
      fireEvent.keyDown(separator, { key: "Home" });
      fireEvent.keyDown(separator, { key: shrink });
      expect(separator).toHaveAttribute("aria-valuenow", minimum);
      fireEvent.keyDown(separator, { key: grow });
      expect(separator).toHaveAttribute("aria-valuenow", String(Number(minimum) + 16));
      fireEvent.keyDown(separator, { key: "End" });
      fireEvent.keyDown(separator, { key: grow });
      expect(separator).toHaveAttribute("aria-valuenow", maximum);
      expect(separator).toHaveFocus();
      for (const modifiers of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }, { isComposing: true }, { keyCode: 229 }]) {
        fireEvent.keyDown(separator, { key: shrink, ...modifiers });
        expect(separator).toHaveAttribute("aria-valuenow", maximum);
      }
      const handled = new KeyboardEvent("keydown", { key: shrink, bubbles: true, cancelable: true });
      handled.preventDefault();
      fireEvent(separator, handled);
      expect(separator).toHaveAttribute("aria-valuenow", maximum);
    }
  });

  it.each(["pointerup", "pointercancel", "blur"])("IDE resize hides the native editor during dragging and restores it on %s", async (ending) => {
    Object.defineProperty(navigator, "userAgent", { configurable: true, value: "Mozilla/5.0 Chrome/140.0" });
    vi.spyOn(editorTransport, "usesNativeEditorTransport").mockReturnValue(true);
    vi.spyOn(editorTransport, "readEditorWorkspace").mockResolvedValue({ workspacePath: "C:\\App Data\\editor\\omnia.code-workspace", folders: [] });
    vi.spyOn(editorTransport, "readEditorServerStatus").mockResolvedValue({ state: "error", url: "http://127.0.0.1:1430/", message: "Test editor is offline" });
    render(<SovereignIdeRemoteWorkbench />);
    await screen.findByRole("heading", { name: "VS Code is offline" });
    openAiSidebar();
    const separator = screen.getByRole("separator", { name: "Resize AI sidebar" });
    const stage = screen.getByTestId("real-vscode-workbench-stage");
    expect(stage).not.toHaveAttribute("hidden");
    fireEvent(separator, new MouseEvent("pointerdown", { bubbles: true, cancelable: true, clientX: 1000 }));
    expect(stage).toHaveAttribute("hidden");
    fireEvent(window, new MouseEvent("pointermove", { clientX: 850 }));
    expect(separator).toHaveAttribute("aria-valuenow", "510");
    fireEvent(window, new MouseEvent("pointermove", { clientX: 0 }));
    expect(separator).toHaveAttribute("aria-valuenow", "640");
    fireEvent(window, new MouseEvent("pointermove", { clientX: 2000 }));
    expect(separator).toHaveAttribute("aria-valuenow", "260");
    fireEvent(window, new Event(ending));
    expect(stage).not.toHaveAttribute("hidden");
    expect(screen.getByTestId("sovereign-ide-remote-workbench")).not.toHaveAttribute("data-resizing");
    fireEvent(separator, new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 2, clientX: 1000 }));
    expect(screen.getByTestId("sovereign-ide-remote-workbench")).not.toHaveAttribute("data-resizing");
  });

  it.each([{ native: true, aiWidth: 280 }, { native: false, aiWidth: 300 }])("IDE resize accounts for reserved gutters before shrinking the editor (native=$native)", ({ native, aiWidth }) => {
    vi.spyOn(editorTransport, "usesNativeEditorTransport").mockReturnValue(native);
    const originalBounds = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("sovereign-ide-remote-workbench") ? new DOMRect(0, 0, 800, 600) : originalBounds.call(this);
    });
    render(<SovereignIdeRemoteWorkbench />);
    fireEvent.click(screen.getByTestId("ide-toggle-tree-btn"));
    openAiSidebar();
    expect(screen.getByTestId("ide-panel-editor").style.gridTemplateColumns).toBe("180px auto minmax(0, 1fr)");
    expect(screen.getByRole("separator", { name: "Resize AI sidebar" }).parentElement?.style.gridTemplateColumns).toBe(`minmax(0, 1fr) auto ${aiWidth}px`);
  });

  it("IDE resize clamps primary-sidebar pointer movement in both directions", () => {
    render(<SovereignIdeRemoteWorkbench />);
    const separator = screen.getByRole("separator", { name: "Resize primary sidebar" });
    fireEvent(separator, new MouseEvent("pointerdown", { bubbles: true, cancelable: true, clientX: 240 }));
    fireEvent(window, new MouseEvent("pointermove", { clientX: 440 }));
    expect(separator).toHaveAttribute("aria-valuenow", "440");
    fireEvent(window, new MouseEvent("pointermove", { clientX: 10000 }));
    expect(separator).toHaveAttribute("aria-valuenow", "480");
    fireEvent(window, new MouseEvent("pointermove", { clientX: 0 }));
    expect(separator).toHaveAttribute("aria-valuenow", "180");
    fireEvent(window, new Event("pointercancel"));
    expect(screen.getByTestId("sovereign-ide-remote-workbench")).not.toHaveAttribute("data-resizing");
  });

  it("IDE resize keeps the preview iframe visible and mounted during pointer resizing", async () => {
    Object.defineProperty(navigator, "userAgent", { configurable: true, value: "Mozilla/5.0 Chrome/140.0" });
    vi.spyOn(editorTransport, "usesNativeEditorTransport").mockReturnValue(false);
    vi.spyOn(editorTransport, "readEditorWorkspace").mockResolvedValue({ workspacePath: "D:\\Omnia\\omnia.code-workspace", folders: [] });
    vi.spyOn(editorTransport, "readEditorServerStatus").mockResolvedValue({ state: "ready", url: "http://127.0.0.1:1430/" });
    render(<SovereignIdeRemoteWorkbench />);
    const frame = await screen.findByTestId("real-vscode-workbench-iframe");
    openAiSidebar();
    fireEvent(screen.getByRole("separator", { name: "Resize AI sidebar" }), new MouseEvent("pointerdown", { bubbles: true, cancelable: true, clientX: 1000 }));
    expect(frame).toBeVisible();
    expect(screen.getByTestId("real-vscode-workbench-stage")).not.toHaveAttribute("hidden");
    fireEvent(window, new Event("pointerup"));
    expect(screen.getByTestId("real-vscode-workbench-iframe")).toBe(frame);
    expect(frame).toBeVisible();
  });

  it("preserves the selected project when the native folder picker returns an unchanged workspace", async () => {
    vi.spyOn(editorTransport, "usesNativeEditorTransport").mockReturnValue(true);
    const document = {
      workspacePath: "C:\\App Data\\editor\\omnia.code-workspace",
      folders: [{ id: "editor_selected", name: "Selected project", path: "D:\\Selected project" }],
    };
    const pick = vi.spyOn(editorTransport, "pickEditorWorkspaceFolder").mockResolvedValue(document);
    render(<SovereignIdeRemoteWorkbench />);
    fireEvent.click(screen.getByTestId("ide-open-project-folder-btn"));
    const sidebar = await screen.findByTestId("ide-agy-ai-sidebar");
    fireEvent.click(within(sidebar).getByRole("button", { name: "Choose folder…" }));
    const project = await screen.findByTestId("ide-project-pill-0");
    fireEvent.click(project);
    expect(project).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(within(sidebar).getByRole("button", { name: "Choose folder…" }));
    await waitFor(() => expect(pick).toHaveBeenCalledTimes(2));
    expect(project).toHaveAttribute("aria-pressed", "true");
  }, 20000);

  it("stages real agent context without fabricating a reply and applies only an actual assistant code block", async () => {
    render(<SovereignIdeRemoteWorkbench />);
    expect(screen.queryByTestId("real-vscode-workbench-iframe")).not.toBeInTheDocument();
    const sidebar = openAiSidebar();
    expect(sidebar.querySelectorAll('[role="tab"]')).toHaveLength(0);
    expect(within(sidebar).getByLabelText("Active chat")).toBeInTheDocument();
    expect(within(sidebar).getByPlaceholderText("Ask anything...")).toBeInTheDocument();
    expect(sidebar).not.toHaveTextContent("@workspace:multi-root");
    expect(sidebar).not.toHaveTextContent("@terminal");
    expect(sidebar).not.toHaveTextContent("@git-diff");
    fireEvent.change(screen.getByTestId("ide-agy-ai-input"), { target: { value: "Optimize the ring buffer" } });
    fireEvent.click(screen.getByTestId("ide-agy-ai-send-btn"));
    const state = useWorkspaceStore.getState();
    const active = state.conversations.find((item) => item.id === state.activeConversationId)!;
    expect(active.draft).toContain("Optimize the ring buffer");
    expect(active.draft).toContain("D:\\CodexBetaPatched");
    expect(screen.getByTestId("ide-agent-notice")).toHaveTextContent("requires the Omnia desktop runtime");
    expect(screen.queryByText(/Synthesized patch/)).not.toBeInTheDocument();

    // A real, pre-existing model message is the only allowed source of code.
    act(() => useWorkspaceStore.setState({ conversations: state.conversations.map((thread) => thread.id === active.id ? { ...thread, messages: [...thread.messages, { id: "verified-model-message", role: "assistant", content: "Reviewed implementation:\n```typescript\nexport const ringCapacity = 4096;\n```", createdAt: new Date().toISOString(), status: "complete", modelLabel: "Connected model", runId: null, attachments: [], branchIndex: 0, branchCount: 1 }] } : thread) }));
    fireEvent.click(within(sidebar).getAllByRole("button", { name: "Apply to editor" }).at(-1)!);
    await waitFor(() => expect((screen.getByTestId("ide-code-editor-textarea") as HTMLTextAreaElement).value).toContain("export const ringCapacity = 4096;"));
  });

  it("keeps one AI panel and discloses calculator and knowledge utilities from deliberate tools actions", () => {
    render(<SovereignIdeRemoteWorkbench />);
    const sidebar = openAiSidebar();
    expect(sidebar.querySelectorAll('[role="tab"]')).toHaveLength(0);
    expect(within(sidebar).queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByTestId("ide-agent-calc-input")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("ide-more-panels-btn"));
    fireEvent.click(within(screen.getByTestId("ide-more-panels-menu")).getByRole("button", { name: "Calculator and checks" }));
    fireEvent.change(screen.getByTestId("ide-agent-calc-input"), { target: { value: "6 * 7" } });
    fireEvent.click(screen.getByTestId("ide-agent-calc-btn"));
    expect(screen.getByTestId("ide-agent-tool-output")).toHaveTextContent('"value": 42');
    fireEvent.click(within(sidebar).getByRole("button", { name: "Close tools" }));
    expect(screen.queryByTestId("ide-agent-calc-input")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("ide-more-panels-btn"));
    fireEvent.click(within(screen.getByTestId("ide-more-panels-menu")).getByRole("button", { name: "Knowledge and model setup" }));
    expect((screen.getByTestId("ide-agent-harness-select") as HTMLSelectElement).options).toHaveLength(9);
    fireEvent.click(within(sidebar).getByRole("button", { name: "Inspect blueprint" }));
    expect(screen.getByTestId("ide-agent-local-blueprint")).toHaveTextContent("ollama");
    fireEvent.click(within(sidebar).getByRole("button", { name: "Close tools" }));
  }, 20000);

  it("discloses local session planning without dispatching and keeps the active chat draft", () => {
    render(<SovereignIdeRemoteWorkbench />);
    const sidebar = openAiSidebar();
    fireEvent.click(screen.getByTestId("ide-more-panels-btn"));
    fireEvent.click(within(screen.getByTestId("ide-more-panels-menu")).getByRole("button", { name: "Session tools" }));
    fireEvent.click(screen.getByTestId("ide-agent-plan-swarm-btn"));
    expect(screen.getByTestId("ide-agent-dfs-tree")).toHaveTextContent("planned");
    const before = useWorkspaceStore.getState().conversations.find((item) => item.id === useWorkspaceStore.getState().activeConversationId)?.draft;
    fireEvent.change(screen.getByLabelText("Ask about this selection"), { target: { value: "Why this data structure?" } });
    fireEvent.click(screen.getByTestId("ide-agent-btw-btn"));
    expect(sidebar).toHaveTextContent("Local request · not dispatched");
    expect(useWorkspaceStore.getState().conversations.find((item) => item.id === useWorkspaceStore.getState().activeConversationId)?.draft).toBe(before);
    fireEvent.keyDown(screen.getByTestId("ide-agy-ai-input"), { key: "b", ctrlKey: true, altKey: true });
    expect(screen.queryByTestId("ide-agy-ai-sidebar")).not.toBeInTheDocument();
  }, 20000);

  it("implements Images 21–23 with colored folder SVG pills and compact accessible secondary controls", () => {
    render(<SovereignIdeRemoteWorkbench />);
    const titlebar = screen.getByTestId("vscode-title-command-bar");
    expect(titlebar).not.toHaveTextContent(/Patched|127\.0\.0\.1|Multi-Root|omnia\.code-workspace/);
    const pills = screen.getByTestId("ide-project-pills");
    const expected = [["omnia-app", "#60a5fa"], ["omnia-root", "#34d399"], ["codex-runtime", "#a78bfa"]];
    for (const [name, color] of expected) {
      const pill = within(pills).getByRole("button", { name: name! });
      expect(pill.style.getPropertyValue("--project-accent")).toBe(color);
      expect(pill.querySelector('svg[stroke="currentColor"][fill="none"]')).not.toBeNull();
    }
    expect(within(pills).getByRole("button", { name: "Open project folder" })).toHaveAttribute("title", "Open project folder");
    expect(screen.queryByTestId("ide-workspace-select")).not.toBeInTheDocument();
    const sidebar = openAiSidebar();
    for (const name of ["New chat", "Chat history", "Toggle AI sidebar"]) {
      const button = within(sidebar).getByRole("button", { name });
      expect(button).toHaveAttribute("title", name);
      expect(button).toHaveTextContent("");
      expect(button.querySelector('svg[stroke-width="1.75"]')).not.toBeNull();
    }
    expect(sidebar).not.toHaveTextContent(/Cache Hit|tok\/s|Official Harnesses Ready|LOCAL SOVEREIGN AI|HOST DISPLAYS/);
    expect(within(sidebar).queryByRole("button", { name: "Apply Code to Editor" })).not.toBeInTheDocument();
    expect(within(sidebar).getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("adds and removes project folders through the real workspace bridge, and exposes a failed bridge instead of pretending success", async () => {
    const fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { folders: { name: string; path: string }[] };
      return { ok: true, json: async () => ({ folders: body.folders }) };
    });
    vi.stubGlobal("fetch", fetch);
    render(<SovereignIdeRemoteWorkbench />);
    fireEvent.click(screen.getByRole("button", { name: "Open project folder" }));
    fireEvent.change(screen.getByTestId("ide-add-project-input"), { target: { value: "D:\\Projects\\next-app" } });
    fireEvent.click(screen.getByTestId("ide-add-project-btn"));
    await waitFor(() => expect(within(screen.getByTestId("ide-project-pills")).getByRole("button", { name: "next-app" })).toBeInTheDocument());
    expect(fetch).toHaveBeenCalledWith("/__omnia_ide_workspace", expect.objectContaining({ method: "POST", headers: expect.objectContaining({ "X-Omnia-Workbench": "workspace-folder-update" }) }));
    fireEvent.click(screen.getByRole("button", { name: "Remove next-app project folder" }));
    await waitFor(() => expect(within(screen.getByTestId("ide-project-pills")).queryByRole("button", { name: "next-app" })).not.toBeInTheDocument());
    fetch.mockResolvedValue({ ok: false, json: async () => ({ error: "Folder does not exist" }) });
    fireEvent.change(screen.getByTestId("ide-add-project-input"), { target: { value: "D:\\Missing" } });
    fireEvent.click(screen.getByTestId("ide-add-project-btn"));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Folder does not exist"));
    expect(screen.getByTestId("ide-project-pills").querySelectorAll(".ide-project-pill")).toHaveLength(3);
  });
  it("starts with only the file tree and editor, and remembers More panels choices", () => {
    const storage = memoryStorage();
    stubLocalStorage(storage);
    const { unmount } = render(<SovereignIdeRemoteWorkbench />);
    expect(screen.getByTestId("vscode-primary-sidebar")).toBeInTheDocument();
    expect(screen.getByTestId("ide-code-editor-textarea")).toBeInTheDocument();
    expect(screen.getByTestId("vscode-bottom-panel")).not.toBeVisible();
    expect(screen.getByTestId("vscode-activity-bar")).not.toBeVisible();
    expect(screen.getByTestId("vscode-workbench-statusbar")).not.toBeVisible();
    expect(screen.queryByTestId("ide-agy-ai-sidebar")).not.toBeInTheDocument();
    expect(screen.queryByTestId("ide-outline-tree")).not.toBeInTheDocument();
    expect(screen.queryByTestId("ide-editor-minimap")).not.toBeInTheDocument();
    expect(screen.getByTestId("ide-more-panels-menu")).not.toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "More panels" }));
    const menu = screen.getByTestId("ide-more-panels-menu");
    expect(menu).toBeVisible();
    expect(screen.getByRole("button", { name: "More panels" })).toHaveAttribute("aria-controls", menu.id);
    expect(within(menu).getByRole("checkbox", { name: "File tree" })).toBeChecked();
    for (const name of ["Terminal & problems", "Search & diff", "Outline", "Activity bar (SCM, debug, remote)", "AI assistant"]) {
      expect(within(menu).getByRole("checkbox", { name })).not.toBeChecked();
    }
    fireEvent.click(within(menu).getByRole("checkbox", { name: "Terminal & problems" }));
    fireEvent.click(within(menu).getByRole("checkbox", { name: "File tree" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(menu).not.toBeVisible();
    expect(screen.getByTestId("vscode-bottom-panel")).toBeVisible();
    expect(screen.queryByTestId("vscode-primary-sidebar")).not.toBeInTheDocument();
    const saved = JSON.parse(storage.getItem(IDE_LAYOUT_STORAGE_KEY) ?? "{}") as { tree: boolean; panels: Record<string, boolean> };
    expect(saved.tree).toBe(false);
    expect(saved.panels.terminal).toBe(true);

    unmount();
    render(<SovereignIdeRemoteWorkbench />);
    expect(screen.getByTestId("vscode-bottom-panel")).toBeVisible();
    expect(screen.queryByTestId("vscode-primary-sidebar")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("ide-toggle-tree-btn"));
    expect(screen.getByTestId("vscode-primary-sidebar")).toBeInTheDocument();
  });

  it("keeps working when localStorage throws", () => {
    const fail = () => { throw new Error("denied"); };
    stubLocalStorage({ getItem: fail, setItem: fail, removeItem: fail });
    render(<SovereignIdeRemoteWorkbench />);
    enablePanel("Outline");
    expect(screen.getByTestId("ide-outline-tree")).toBeInTheDocument();
  });

  it("shows a small hint instead of an editor when no file is open", () => {
    render(<SovereignIdeRemoteWorkbench />);
    const tabs = within(screen.getByTestId("vscode-editor-tabbar")).getAllByRole("tab");
    expect(tabs).toHaveLength(1);
    fireEvent.click(within(screen.getByTestId("vscode-editor-tabbar")).getByRole("button", { name: /^Close / }));
    expect(screen.getByTestId("ide-empty-hint")).toHaveTextContent("Open a file from the tree, or Ctrl+P");
    expect(screen.getByTestId("ide-code-editor-textarea")).not.toBeVisible();
    const target = within(screen.getByTestId("vscode-primary-sidebar")).getAllByRole("button").find((button) => button.dataset.testid?.startsWith("ide-file-item-") && button.getAttribute("title")?.endsWith(".rs"))!;
    fireEvent.click(target);
    expect(screen.queryByTestId("ide-empty-hint")).not.toBeInTheDocument();
    const fileName = target.getAttribute("title")!.split("/").pop()!;
    expect(within(screen.getByTestId("vscode-editor-tabbar")).getByRole("tab", { selected: true })).toHaveTextContent(fileName);
  });

  it("uses roving focus and arrow/Home/End navigation for local open-file tabs", async () => {
    if (!HTMLElement.prototype.scrollIntoView) HTMLElement.prototype.scrollIntoView = () => undefined;
    const scrollIntoView = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => undefined);
    render(<SovereignIdeRemoteWorkbench />);
    const sidebar = screen.getByTestId("vscode-primary-sidebar");
    fireEvent.click(screen.getByTestId("ide-file-item-src-tauri/src/isolated_input_win32.rs"));
    fireEvent.click(screen.getByTestId("ide-file-item-scripts/verify-authoritative-root-contract.py"));
    const tablist = screen.getByRole("tablist", { name: "Open files" });
    const tabs = within(tablist).getAllByRole("tab");
    expect(tabs).toHaveLength(3);
    expect(tabs.filter((tab) => tab.getAttribute("tabindex") === "0")).toHaveLength(1);
    expect(tabs.find((tab) => tab.getAttribute("aria-selected") === "true")).toHaveAttribute("tabindex", "0");
    for (const tab of tabs) {
      expect(tab).toHaveAttribute("aria-controls", "ide-editor-tabpanel");
      expect(tab.id).toMatch(/^ide-editor-tab-/);
    }
    const selected = tabs.find((tab) => tab.getAttribute("aria-selected") === "true")!;
    fireEvent.keyDown(selected, { key: "ArrowLeft" });
    expect(within(tablist).getByRole("tab", { selected: true })).toHaveTextContent("isolated_input_win32.rs");
    expect(within(tablist).getByRole("tab", { selected: true })).toHaveFocus();
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
    fireEvent.keyDown(within(tablist).getByRole("tab", { selected: true }), { key: "End" });
    expect(within(tablist).getByRole("tab", { selected: true })).toHaveTextContent("verify-authoritative-root-contract.py");
    fireEvent.keyDown(within(tablist).getByRole("tab", { selected: true }), { key: "Home" });
    expect(within(tablist).getByRole("tab", { selected: true })).toHaveTextContent("sovereign-ide-remote-desktop.ts");
    for (const modifiers of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }, { isComposing: true }, { keyCode: 229 }]) {
      fireEvent.keyDown(within(tablist).getByRole("tab", { selected: true }), { key: "ArrowRight", ...modifiers });
      expect(within(tablist).getByRole("tab", { selected: true })).toHaveTextContent("sovereign-ide-remote-desktop.ts");
    }
    expect(sidebar).toBeInTheDocument();
  });

  it("returns focus to the adjacent local file tab after closing the selected file", async () => {
    render(<SovereignIdeRemoteWorkbench />);
    fireEvent.click(screen.getByTestId("ide-file-item-src-tauri/src/isolated_input_win32.rs"));
    const tablist = screen.getByRole("tablist", { name: "Open files" });
    const selected = within(tablist).getByRole("tab", { selected: true });
    expect(selected).toHaveTextContent("isolated_input_win32.rs");
    fireEvent.click(within(tablist).getByRole("button", { name: "Close isolated_input_win32.rs" }));
    await waitFor(() => {
      expect(within(tablist).getByRole("tab", { selected: true })).toHaveTextContent("sovereign-ide-remote-desktop.ts");
      expect(within(tablist).getByRole("tab", { selected: true })).toHaveFocus();
    });
    expect(within(tablist).getAllByRole("tab").filter((tab) => tab.getAttribute("tabindex") === "0")).toHaveLength(1);
  });

  it("uses roving focus and arrow/Home/End navigation for local bottom-panel tabs", () => {
    render(<SovereignIdeRemoteWorkbench />);
    fireEvent.click(screen.getByTestId("ide-run-terminal-btn"));
    const tablist = screen.getByRole("tablist", { name: "Panel" });
    const tabs = within(tablist).getAllByRole("tab");
    expect(tabs).toHaveLength(4);
    expect(tabs.filter((tab) => tab.getAttribute("tabindex") === "0")).toHaveLength(1);
    for (const tab of tabs) {
      expect(tab).toHaveAttribute("aria-controls", "ide-bottom-panel-tabpanel");
      expect(tab.id).toMatch(/^ide-bottom-panel-tab-/);
    }
    const selected = within(tablist).getByRole("tab", { selected: true });
    fireEvent.keyDown(selected, { key: "ArrowRight" });
    expect(within(tablist).getByRole("tab", { selected: true })).toHaveTextContent("Problems");
    expect(within(tablist).getByRole("tab", { selected: true })).toHaveFocus();
    fireEvent.keyDown(within(tablist).getByRole("tab", { selected: true }), { key: "End" });
    expect(within(tablist).getByRole("tab", { selected: true })).toHaveTextContent("Ports");
    fireEvent.keyDown(within(tablist).getByRole("tab", { selected: true }), { key: "Home" });
    expect(within(tablist).getByRole("tab", { selected: true })).toHaveTextContent("Terminal");
    expect(screen.getByTestId("ide-terminal-output")).toHaveAttribute("aria-labelledby", "ide-bottom-panel-tab-terminal");
  });

  it("opens Quick Open with Ctrl+P, wraps result navigation, and focuses the selected file", async () => {
    render(<SovereignIdeRemoteWorkbench />);
    const editor = screen.getByTestId("ide-code-editor-textarea");
    editor.focus();
    expect(fireEvent.keyDown(editor, { key: "p", ctrlKey: true })).toBe(false);
    const input = screen.getByRole("combobox", { name: "Quick Open" });
    await waitFor(() => expect(input).toHaveFocus());
    const results = within(screen.getByRole("listbox", { name: "Files in local buffers" })).getAllByRole("option");
    expect(results.length).toBeGreaterThan(1);
    expect(input).toHaveAttribute("aria-activedescendant", results[0]!.id);
    expect(results[0]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input).toHaveAttribute("aria-activedescendant", results.at(-1)!.id);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveAttribute("aria-activedescendant", results[0]!.id);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveAttribute("aria-activedescendant", results[1]!.id);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.queryByRole("dialog", { name: "Quick Open" })).not.toBeInTheDocument();
    expect(within(screen.getByRole("tablist", { name: "Open files" })).getByRole("tab", { selected: true })).toHaveAttribute("title", results[1]!.title);
    await waitFor(() => expect(editor).toHaveFocus());
  });

  it("keeps an empty Quick Open search open and filters Windows-style file paths", () => {
    render(<SovereignIdeRemoteWorkbench />);
    fireEvent.click(screen.getByTestId("ide-quick-open-trigger"));
    const input = screen.getByRole("combobox", { name: "Quick Open" });
    fireEvent.change(input, { target: { value: "not-a-file-anywhere" } });
    expect(screen.getByText("No matching files")).toBeInTheDocument();
    expect(input).not.toHaveAttribute("aria-activedescendant");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("dialog", { name: "Quick Open" })).toBeInTheDocument();
    fireEvent.change(input, { target: { value: "src-tauri\\src\\isolated_input_win32.rs" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(within(screen.getByRole("tablist", { name: "Open files" })).getByRole("tab", { selected: true })).toHaveTextContent("isolated_input_win32.rs");
  });

  it("opens @symbols with Ctrl+Shift+O and moves the editor caret to the actual symbol line", async () => {
    render(<SovereignIdeRemoteWorkbench />);
    const editor = screen.getByTestId("ide-code-editor-textarea") as HTMLTextAreaElement;
    editor.focus();
    fireEvent.keyDown(editor, { key: "O", ctrlKey: true, shiftKey: true });
    const input = screen.getByRole("combobox", { name: "Quick Open" });
    expect(input).toHaveValue("@");
    fireEvent.change(input, { target: { value: "@verifySovereignBridge" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("option")).toHaveTextContent(":13");
    fireEvent.keyDown(input, { key: "Enter" });
    const lineOffset = editor.value.split("\n").slice(0, 12).reduce((length, line) => length + line.length + 1, 0);
    await waitFor(() => expect(editor.selectionStart).toBe(lineOffset));
    expect(editor).toHaveFocus();
    expect(editor.selectionEnd).toBe(lineOffset);
    expect(screen.getByTestId("ide-breadcrumb-bar")).toHaveTextContent("Ln 13, Col 1");
  });

  it("opens >commands with Ctrl+Shift+P and executes real panel actions", () => {
    render(<SovereignIdeRemoteWorkbench />);
    fireEvent.keyDown(screen.getByTestId("ide-code-editor-textarea"), { key: "P", ctrlKey: true, shiftKey: true });
    const input = screen.getByRole("combobox", { name: "Quick Open" });
    expect(input).toHaveValue(">");
    fireEvent.change(input, { target: { value: ">terminal" } });
    expect(screen.getByRole("option")).toHaveTextContent("Show terminal and problems");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByTestId("vscode-bottom-panel")).toBeVisible();
    expect(screen.getByTestId("ide-terminal-output")).toHaveTextContent("No shell process is attached");
    fireEvent.click(screen.getByTestId("ide-quick-open-trigger"));
    fireEvent.change(screen.getByRole("combobox", { name: "Quick Open" }), { target: { value: ">Toggle AI" } });
    fireEvent.click(screen.getByRole("option"));
    expect(screen.getByTestId("ide-agy-ai-sidebar")).toBeInTheDocument();
  });

  it("restores focus on Escape and resets Quick Open when reopened", async () => {
    render(<SovereignIdeRemoteWorkbench />);
    const trigger = screen.getByTestId("ide-quick-open-trigger");
    trigger.focus();
    fireEvent.click(trigger);
    const input = screen.getByRole("combobox", { name: "Quick Open" });
    await waitFor(() => expect(input).toHaveFocus());
    fireEvent.change(input, { target: { value: "no matching file" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Quick Open" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    fireEvent.click(trigger);
    expect(screen.getByRole("combobox", { name: "Quick Open" })).toHaveValue("");
  });

  it("leaves composing keys and shortcuts in unrelated controls alone, and supports Cmd+P", () => {
    render(<><SovereignIdeRemoteWorkbench /><input aria-label="Unrelated field" /></>);
    const unrelated = screen.getByRole("textbox", { name: "Unrelated field" });
    expect(fireEvent.keyDown(unrelated, { key: "p", ctrlKey: true })).toBe(true);
    const editor = screen.getByTestId("ide-code-editor-textarea");
    fireEvent.keyDown(editor, { key: "p", ctrlKey: true, isComposing: true });
    fireEvent.keyDown(editor, { key: "p", ctrlKey: true, altKey: true });
    expect(screen.queryByRole("dialog", { name: "Quick Open" })).not.toBeInTheDocument();
    fireEvent.keyDown(editor, { key: "p", metaKey: true });
    expect(screen.getByRole("dialog", { name: "Quick Open" })).toBeInTheDocument();
    const input = screen.getByRole("combobox", { name: "Quick Open" });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.keyDown(input, { key: "Escape", isComposing: true });
    expect(screen.getByRole("dialog", { name: "Quick Open" })).toBeInTheDocument();
  });

  it("reveals the selected local buffer without destroying embedded VS Code", async () => {
    Object.defineProperty(navigator, "userAgent", { configurable: true, value: "Mozilla/5.0 Chrome/140.0" });
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string) => url === "/__omnia_ide_server"
      ? { ok: true, status: 200, json: async () => ({ state: "ready", url: "http://127.0.0.1:1430" }) }
      : { ok: false }));
    render(<SovereignIdeRemoteWorkbench />);
    const frame = await screen.findByTestId("real-vscode-workbench-iframe");
    fireEvent.click(screen.getByTestId("ide-quick-open-trigger"));
    const input = screen.getByRole("combobox", { name: "Quick Open" });
    fireEvent.keyDown(input, { key: "P", ctrlKey: true, shiftKey: true });
    expect(input).toHaveValue(">");
    fireEvent.keyDown(input, { key: "p", ctrlKey: true });
    expect(input).toHaveValue("");
    fireEvent.change(input, { target: { value: "isolated_input_win32" } });
    fireEvent.click(screen.getByRole("option"));
    expect(frame).toBeInTheDocument();
    expect(frame).not.toBeVisible();
    expect(screen.getByTestId("ide-code-editor-textarea")).toBeVisible();
    expect((screen.getByTestId("ide-code-editor-textarea") as HTMLTextAreaElement).value).toContain("Win32IsolatedPostMessageFrame");
    fireEvent.click(screen.getByTestId("toggle-real-vscode-embed-btn"));
    expect(screen.getByTestId("real-vscode-workbench-iframe")).toBe(frame);
    expect(frame).toBeVisible();
  });

  it("restores More panels focus on Escape and leaves outside controls focused", () => {
    render(<><SovereignIdeRemoteWorkbench /><input aria-label="Outside IDE" /></>);
    const trigger = screen.getByRole("button", { name: "More panels" });
    fireEvent.click(trigger);
    const checkbox = screen.getByRole("checkbox", { name: "File tree" });
    act(() => checkbox.focus());
    fireEvent.keyDown(checkbox, { key: "Escape" });
    expect(screen.getByTestId("ide-more-panels-menu")).not.toBeVisible();
    expect(trigger).toHaveFocus();
    fireEvent.click(trigger);
    const outside = screen.getByRole("textbox", { name: "Outside IDE" });
    act(() => outside.focus());
    fireEvent.pointerDown(outside);
    expect(screen.getByTestId("ide-more-panels-menu")).not.toBeVisible();
    expect(outside).toHaveFocus();
  });

  it("scopes the AI sidebar shortcut to the visible IDE and ignores composing or handled keys", () => {
    const { container } = render(<><SovereignIdeRemoteWorkbench /><input aria-label="Outside IDE" /></>);
    const toggle = screen.getByTestId("ide-toggle-agy-sidebar-btn");
    const editor = screen.getByTestId("ide-code-editor-textarea");
    const initial = toggle.getAttribute("aria-pressed");
    const chord = { key: "b", ctrlKey: true, altKey: true };
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Outside IDE" }), chord);
    fireEvent.keyDown(editor, { ...chord, isComposing: true });
    const handled = new KeyboardEvent("keydown", { ...chord, bubbles: true, cancelable: true });
    handled.preventDefault();
    fireEvent(editor, handled);
    expect(toggle).toHaveAttribute("aria-pressed", initial);
    container.hidden = true;
    fireEvent.keyDown(editor, chord);
    expect(toggle).toHaveAttribute("aria-pressed", initial);
    container.hidden = false;
    fireEvent.keyDown(editor, chord);
    expect(toggle).not.toHaveAttribute("aria-pressed", initial);
  });

  it("drops its own mode switcher and window controls inside the shell workspace bar", () => {
    const host = document.createElement("section");
    host.className = "ag-workspace";
    document.body.appendChild(host);
    render(<SovereignIdeRemoteWorkbench />, { container: host });
    const workbench = screen.getByTestId("sovereign-ide-remote-workbench");
    expect(workbench).toHaveAttribute("data-embedded-shell", "true");
    expect(within(workbench).queryByTestId("workspace-mode-switcher")).not.toBeInTheDocument();
    expect(screen.getByTestId("vscode-title-command-bar")).not.toHaveAttribute("data-tauri-drag-region");
    host.remove();
  });
});
