import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as editorTransport from "./ide-editor-transport";
import * as nativeSurface from "./native-vscode-surface";

import { EmbeddedVscodeStage } from "./embedded-vscode-stage";

const workspaceUrl = "http://127.0.0.1:1430/?folder=/d:/Omnia";
const props = { workspaceUrl, workspaceKey: "omnia-0", active: true };
const response = (state: string, message?: string) => ({
  ok: true,
  status: 200,
  json: async () => ({ state, message, url: "http://127.0.0.1:1430" }),
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("EmbeddedVscodeStage", () => {
  it("checks real server status before mounting the editor", async () => {
    const fetchStatus = vi.fn().mockResolvedValue(response("ready"));
    vi.stubGlobal("fetch", fetchStatus);
    render(<EmbeddedVscodeStage {...props} />);
    expect(screen.queryByTestId("real-vscode-workbench-iframe")).toBeNull();
    const frame = await screen.findByTitle("Embedded VS Code Workbench");
    expect(new URL(frame.getAttribute("src")!).searchParams.get("folder")).toBe(
      "/d:/Omnia",
    );
    expect(fetchStatus).toHaveBeenCalledWith(
      "/__omnia_ide_server",
      expect.objectContaining({ method: "GET", cache: "no-store" }),
    );
  });

  it("reports an unavailable runtime without showing a broken frame, then explicitly retries startup", async () => {
    const fetchStatus = vi
      .fn()
      .mockResolvedValueOnce(
        response("unavailable", "Install a local VS Code web runtime."),
      )
      .mockResolvedValueOnce(response("ready"));
    vi.stubGlobal("fetch", fetchStatus);
    render(<EmbeddedVscodeStage {...props} />);
    expect(await screen.findByText("VS Code is offline")).toBeVisible();
    expect(
      screen.getByText("Install a local VS Code web runtime."),
    ).toBeVisible();
    expect(screen.queryByTitle("Embedded VS Code Workbench")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry connection" }));
    expect(
      await screen.findByTitle("Embedded VS Code Workbench"),
    ).toBeInTheDocument();
    expect(fetchStatus).toHaveBeenLastCalledWith(
      "/__omnia_ide_server",
      expect.objectContaining({
        method: "POST",
        headers: { "x-omnia-workbench": "editor-server-start" },
      }),
    );
  });

  it("preserves the iframe when hidden and shown beside local buffers", async () => {
    const fetchStatus = vi.fn().mockResolvedValue(response("ready"));
    vi.stubGlobal("fetch", fetchStatus);
    const { rerender } = render(<EmbeddedVscodeStage {...props} />);
    const frame = await screen.findByTitle("Embedded VS Code Workbench");
    rerender(<EmbeddedVscodeStage {...props} active={false} />);
    expect(frame).toBeInTheDocument();
    expect(frame).not.toBeVisible();
    expect(screen.getByTestId("real-vscode-workbench-stage")).toHaveAttribute(
      "inert",
    );
    rerender(<EmbeddedVscodeStage {...props} />);
    expect(screen.getByTitle("Embedded VS Code Workbench")).toBe(frame);
    expect(frame).toBeVisible();
    expect(fetchStatus).toHaveBeenCalledTimes(1);
  });

  it("polls a starting service until it is ready", async () => {
    vi.useFakeTimers();
    const fetchStatus = vi
      .fn()
      .mockResolvedValueOnce(response("starting"))
      .mockResolvedValue(response("ready"));
    vi.stubGlobal("fetch", fetchStatus);
    await act(async () => {
      render(<EmbeddedVscodeStage {...props} />);
    });
    expect(screen.getByText("Connecting to VS Code")).toBeVisible();
    expect(screen.queryByTitle("Embedded VS Code Workbench")).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(750);
    });
    expect(screen.getByTitle("Embedded VS Code Workbench")).toBeInTheDocument();
    expect(fetchStatus).toHaveBeenCalledTimes(2);
  });

  it("stops polling after a bounded startup window", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response("starting")));
    await act(async () => {
      render(<EmbeddedVscodeStage {...props} />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(90_000);
    });
    expect(screen.getByText("VS Code is offline")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Retry connection" }),
    ).toBeEnabled();
    expect(screen.queryByTitle("Embedded VS Code Workbench")).toBeNull();
  });

  it("surfaces missing or invalid health services without pretending the editor loaded", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 404 }),
    );
    render(<EmbeddedVscodeStage {...props} />);
    expect(
      await screen.findByText(
        "The editor connection service is unavailable in this build.",
      ),
    ).toBeVisible();
    expect(screen.queryByTitle("Embedded VS Code Workbench")).toBeNull();
  });

  it("aborts an in-flight check on unmount", () => {
    const fetchStatus = vi
      .fn()
      .mockImplementation(() => new Promise(() => undefined));
    vi.stubGlobal("fetch", fetchStatus);
    const { unmount } = render(<EmbeddedVscodeStage {...props} />);
    const signal = fetchStatus.mock.calls[0]![1].signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    unmount();
    expect(signal.aborted).toBe(true);
  });

  it("recreates a failed editor frame only after an explicit successful reconnect", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(response("ready"))
        .mockResolvedValueOnce(response("error", "The editor server stopped."))
        .mockResolvedValue(response("ready")),
    );
    render(<EmbeddedVscodeStage {...props} />);
    const frame = await screen.findByTitle("Embedded VS Code Workbench");
    // Browsers fire load even for iframe connection-error pages. Recheck the
    // actual service rather than relying on an iframe error event.
    fireEvent.load(frame);
    expect(await screen.findByText("The editor server stopped.")).toBeVisible();
    expect(frame).toBeInTheDocument();
    expect(frame).not.toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Retry connection" }));
    await waitFor(() => {
      expect(screen.getByTestId("real-vscode-workbench-iframe")).not.toBe(
        frame,
      );
      expect(screen.getByTestId("real-vscode-workbench-iframe")).toBeVisible();
    });
  });

  it("routes the installed editor through a native surface and passes only its folder id and lifecycle state", async () => {
    vi.spyOn(editorTransport, "usesNativeEditorTransport").mockReturnValue(
      true,
    );
    vi.spyOn(editorTransport, "readEditorServerStatus").mockResolvedValue({
      state: "ready",
      url: "http://127.0.0.1:1430/?tkn=temporary-test-token",
    });
    const surface = vi
      .spyOn(nativeSurface, "NativeVscodeSurface")
      .mockImplementation(({ folderId, revision, active }) => (
        <div
          data-testid="test-native-surface"
          data-folder-id={folderId}
          data-revision={revision}
          hidden={!active}
        />
      ));
    const view = render(
      <EmbeddedVscodeStage {...props} nativeFolderId="editor_selected" />,
    );
    const host = await screen.findByTestId("test-native-surface");
    expect(host).toHaveAttribute("data-folder-id", "editor_selected");
    expect(host).toHaveAttribute("data-revision", "omnia-0-0");
    expect(surface.mock.calls.at(-1)?.[0]).not.toHaveProperty("url");
    expect(surface.mock.calls.at(-1)?.[0]).not.toHaveProperty("workspaceUrl");
    expect(screen.queryByTitle("Embedded VS Code Workbench")).toBeNull();
    view.rerender(
      <EmbeddedVscodeStage
        {...props}
        nativeFolderId="editor_selected"
        active={false}
      />,
    );
    expect(screen.getByTestId("test-native-surface")).toBe(host);
    expect(host).not.toBeVisible();
    view.rerender(
      <EmbeddedVscodeStage {...props} nativeFolderId="editor_selected" />,
    );
    expect(host).toBeVisible();
    expect(editorTransport.readEditorServerStatus).toHaveBeenCalledOnce();
  });

  it("returns a native child failure to the connection status so retry can restart the editor", async () => {
    vi.spyOn(editorTransport, "usesNativeEditorTransport").mockReturnValue(
      true,
    );
    vi.spyOn(editorTransport, "readEditorServerStatus").mockResolvedValue({
      state: "ready",
      url: "http://127.0.0.1:1430",
    });
    let reportFailure!: (message: string) => void;
    vi.spyOn(nativeSurface, "NativeVscodeSurface").mockImplementation(
      ({ onError, active }) => {
        reportFailure = onError!;
        return <div data-testid="test-native-surface" hidden={!active} />;
      },
    );
    render(<EmbeddedVscodeStage {...props} />);
    await screen.findByTestId("test-native-surface");
    act(() => reportFailure("The editor view is unavailable."));
    expect(
      await screen.findByText("The editor view is unavailable."),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Retry connection" }),
    ).toBeEnabled();
  });
});
