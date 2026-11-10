import { useEffect, useRef, useState } from "react";
import { Code2, RefreshCw } from "lucide-react";
import { EDITOR_SERVER_ORIGIN } from "@/domain/editor-workspace-url";
import {
  connectedEditorUrl,
  readEditorServerStatus,
  usesNativeEditorTransport,
  type EditorServerStatus,
} from "./ide-editor-transport";
import { NativeVscodeSurface } from "./native-vscode-surface";

import "./embedded-vscode-stage.css";

type ServerState = "checking" | "ready" | "starting" | "unavailable" | "error";
interface ConnectionStatus {
  state: ServerState;
  url?: string;
  message?: string;
}

/** Keep the editor's browsing context alive while its local-buffer drawer is open. */
export function EmbeddedVscodeStage({
  workspaceUrl,
  workspaceKey,
  active,
  nativeFolderId = null,
}: {
  workspaceUrl: string;
  workspaceKey: string;
  active: boolean;
  nativeFolderId?: string | null;
}) {
  const nativeSurface = usesNativeEditorTransport();
  const [status, setStatus] = useState<ConnectionStatus>({ state: "checking" });
  const [request, setRequest] = useState({ id: 0, method: "GET" });
  const [connected, setConnected] = useState(false);
  const [serverUrl, setServerUrl] = useState(EDITOR_SERVER_ORIGIN);
  const [connectionEpoch, setConnectionEpoch] = useState(0);
  const [busy, setBusy] = useState(false);
  const pollingDeadline = useRef(0);
  const reconnecting = useRef(false);

  function handleNativeSurfaceError(message: string): void {
    // A native child can outlive the health response that created it. Treat a
    // failed attach/update as a connection failure so the user can restart
    // the owned editor group without leaving this route.
    reconnecting.current = true;
    setConnected(false);
    setStatus({ state: "error", message });
  }

  useEffect(() => {
    let disposed = false;
    let poll: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    if (request.method === "POST" || !pollingDeadline.current)
      pollingDeadline.current = Date.now() + 90_000;
    setBusy(true);
    void (async () => {
      try {
        const result: EditorServerStatus = await readEditorServerStatus(
          request.method === "POST",
          controller.signal,
        );
        if (disposed) return;
        if (
          result.state === "starting" &&
          Date.now() >= pollingDeadline.current
        ) {
          throw new Error(
            "The editor did not become ready. Retry the connection.",
          );
        }
        setStatus(result);
        if (result.state === "ready") {
          setServerUrl(result.url);
          setConnected(true);
          pollingDeadline.current = 0;
          if (reconnecting.current) setConnectionEpoch((epoch) => epoch + 1);
          reconnecting.current = false;
        } else if (result.state === "starting") {
          poll = setTimeout(
            () =>
              setRequest((current) => ({ id: current.id + 1, method: "GET" })),
            750,
          );
        }
      } catch (error) {
        if (!disposed)
          setStatus({
            state: "error",
            message: controller.signal.aborted
              ? "The editor connection timed out. Retry the connection."
              : error instanceof Error
                ? error.message
                : "The editor could not be connected.",
          });
      } finally {
        clearTimeout(timeout);
        if (!disposed) setBusy(false);
      }
    })();
    return () => {
      disposed = true;
      controller.abort();
      clearTimeout(timeout);
      clearTimeout(poll);
    };
  }, [request]);

  const waiting =
    busy || status.state === "checking" || status.state === "starting";
  return (
    <div
      data-testid="real-vscode-workbench-stage"
      className="embedded-vscode-stage"
      hidden={!active}
      inert={!active}
    >
      {connected && nativeSurface ? (
        <NativeVscodeSurface
          folderId={nativeFolderId}
          revision={`${workspaceKey}-${connectionEpoch}`}
          reconnect={connectionEpoch > 0}
          reconnectEpoch={connectionEpoch}
          active={active && status.state === "ready"}
          onError={handleNativeSurfaceError}
        />
      ) : null}
      {connected && !nativeSurface ? (
        <iframe
          key={`${workspaceKey}-${connectionEpoch}`}
          data-testid="real-vscode-workbench-iframe"
          src={connectedEditorUrl(serverUrl, workspaceUrl)}
          title="Embedded VS Code Workbench"
          allow="clipboard-read; clipboard-write; fullscreen"
          hidden={status.state !== "ready"}
          onLoad={() =>
            setRequest((current) => ({ id: current.id + 1, method: "GET" }))
          }
          onError={() =>
            setStatus({
              state: "error",
              message:
                "The editor page could not be loaded. Retry the connection.",
            })
          }
        />
      ) : null}
      {status.state !== "ready" ? (
        <div
          className="embedded-vscode-stage__status"
          role="status"
          aria-live="polite"
        >
          <Code2 size={24} aria-hidden="true" />
          <h2>{waiting ? "Connecting to VS Code" : "VS Code is offline"}</h2>
          <p>
            {waiting
              ? "Waiting for the local editor to become ready."
              : status.message || "The local editor server is not running."}
          </p>
          <button
            type="button"
            disabled={waiting}
            onClick={() => {
              reconnecting.current = connected;
              setRequest((current) => ({ id: current.id + 1, method: "POST" }));
            }}
          >
            <RefreshCw size={14} aria-hidden="true" />
            {waiting ? "Connecting…" : "Retry connection"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
