import { ChevronDown, ChevronRight, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { agentApi, errorMessage } from "./agent-api";
import type { DiffFile, DiffHunk, WorkspaceDiff } from "./types";

import "./diff-pane.css";

interface DiffPaneProps {
  sessionId: string;
  /** True while an agent run is active; the pane refreshes when it ends. */
  running: boolean;
  onClose: () => void;
}

const hunkKey = (file: DiffFile, hunk: DiffHunk) => `${file.path}::${hunk.id}`;

export function DiffPane({ sessionId, running, onClose }: DiffPaneProps) {
  const [diff, setDiff] = useState<WorkspaceDiff | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const latest = useRef(0);

  const load = useCallback(async () => {
    const ticket = ++latest.current;
    setLoading(true);
    try {
      const next = await agentApi.workspaceDiff(sessionId);
      if (ticket !== latest.current) return;
      setDiff(next);
      setError(null);
    } catch (cause) {
      if (ticket === latest.current) setError(errorMessage(cause));
    } finally {
      if (ticket === latest.current) setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    setDiff(null);
    setConfirming(null);
    setCollapsed(new Set());
    void load();
  }, [load]);

  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running) void load();
    wasRunning.current = running;
  }, [running, load]);

  const act = async (kind: "stage" | "revert", file: DiffFile, hunk: DiffHunk) => {
    setBusy(hunkKey(file, hunk));
    setConfirming(null);
    try {
      const next =
        kind === "stage"
          ? await agentApi.hunkStage(sessionId, file.path, hunk.id)
          : await agentApi.hunkRevert(sessionId, file.path, hunk.id);
      latest.current++;
      setDiff(next);
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  const toggle = (path: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(path)) next.add(path);
      return next;
    });

  const total = diff?.files.length ?? 0;
  return (
    <aside className="ag-diff" aria-label="Changes">
      <header className="ag-diff__head">
        <h2 className="ag-diff__title">
          Changes{total ? <span className="ag-muted"> · {total}</span> : null}
        </h2>
        <span className="ag-spacer" />
        <button type="button" className="ag-icon-btn" aria-label="Refresh changes" disabled={loading} onClick={() => void load()}>
          <RefreshCw size={14} aria-hidden="true" />
        </button>
        <button type="button" className="ag-icon-btn" aria-label="Close changes" onClick={onClose}>
          <X size={14} aria-hidden="true" />
        </button>
      </header>
      {error ? <p className="ag-error ag-diff__note" role="alert">{error}</p> : null}
      <div className="ag-diff__body">
        {!diff ? (
          loading ? <p className="ag-muted ag-diff__note" role="status">Loading changes…</p> : null
        ) : !diff.git ? (
          <p className="ag-muted ag-diff__note">
            {diff.error ?? "This folder is not a git repository, so changes cannot be shown."}
          </p>
        ) : diff.files.length === 0 ? (
          <p className="ag-muted ag-diff__note">No changes</p>
        ) : (
          <>
            {diff.files.map((file) => {
              const isCollapsed = collapsed.has(file.path);
              return (
                <section className="ag-diff__file" key={file.path}>
                  <button
                    type="button"
                    className="ag-diff__file-head"
                    aria-expanded={!isCollapsed}
                    onClick={() => toggle(file.path)}
                  >
                    {isCollapsed ? <ChevronRight size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
                    <span className="ag-diff__path" title={file.path}>{file.path}</span>
                    {file.untracked ? (
                      <span className="ag-diff__tag">new</span>
                    ) : file.status === "deleted" ? (
                      <span className="ag-diff__tag">deleted</span>
                    ) : null}
                    <span className="ag-diff__count ag-diff__count--add">+{file.additions}</span>
                    <span className="ag-diff__count ag-diff__count--del">-{file.deletions}</span>
                  </button>
                  {isCollapsed ? null : file.hunks.length === 0 ? (
                    <p className="ag-muted ag-diff__note">
                      {file.binary ? "Binary or large file; no preview." : "No line changes."}
                    </p>
                  ) : (
                    file.hunks.map((hunk) => {
                      const key = hunkKey(file, hunk);
                      const working = busy === key;
                      return (
                        <div className="ag-diff__hunk" key={hunk.id}>
                          <div className="ag-diff__hunk-head">
                            <code className="ag-diff__hunk-title" title={hunk.header}>{hunk.header}</code>
                            {confirming === key ? (
                              <span className="ag-diff__confirm" role="group" aria-label="Confirm revert">
                                <span>Revert this hunk?</span>
                                <button type="button" className="ag-btn ag-btn--danger" disabled={working} onClick={() => void act("revert", file, hunk)}>
                                  Confirm revert
                                </button>
                                <button type="button" className="ag-btn" onClick={() => setConfirming(null)}>
                                  Cancel
                                </button>
                              </span>
                            ) : (
                              <>
                                <button
                                  type="button"
                                  className="ag-btn"
                                  aria-label={`Stage hunk ${hunk.header} in ${file.path}`}
                                  disabled={working}
                                  onClick={() => void act("stage", file, hunk)}
                                >
                                  Stage
                                </button>
                                {file.untracked ? null : (
                                  <button
                                    type="button"
                                    className="ag-btn"
                                    aria-label={`Revert hunk ${hunk.header} in ${file.path}`}
                                    disabled={working || running}
                                    title={running ? "Wait for the agent run to finish" : undefined}
                                    onClick={() => setConfirming(key)}
                                  >
                                    Revert
                                  </button>
                                )}
                              </>
                            )}
                          </div>
                          <table className="ag-diff__lines">
                            <tbody>
                              {hunk.lines.map((line, index) => (
                                <tr key={index} className={`ag-diff__line ag-diff__line--${line.kind}`}>
                                  <td className="ag-diff__no" aria-hidden="true">{line.oldNo ?? ""}</td>
                                  <td className="ag-diff__no" aria-hidden="true">{line.newNo ?? ""}</td>
                                  <td className="ag-diff__sign" aria-hidden="true">
                                    {line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}
                                  </td>
                                  <td className="ag-diff__text">{line.text}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      );
                    })
                  )}
                </section>
              );
            })}
            {diff.truncated ? <p className="ag-muted ag-diff__note">Showing the first part of a large diff.</p> : null}
          </>
        )}
      </div>
    </aside>
  );
}
