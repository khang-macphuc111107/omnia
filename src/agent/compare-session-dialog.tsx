import { Check, Copy, GitCompareArrows, LoaderCircle, Play, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  attachModelCompareMergeReceipt,
  createModelCompareMergeReceipt,
  createModelCompareRun,
  recordModelCompareAttempt,
  type ModelCompareCandidate,
  type ModelCompareRun,
} from "@/domain/model-compare";

import { ModalSurface } from "@/components/modal-surface";
import { agentApi, errorMessage } from "./agent-api";
import { useAgentStore } from "./agent-store";
import { emptyLive } from "./transcript";
import type { AgentSessionListItem } from "./types";

import "./compare-session-dialog.css";

const MAX_CANDIDATES = 4;
const WAIT_TIMEOUT_MS = 15 * 60_000;

interface CompareRoute {
  readonly id: string;
  readonly profileId: string;
  readonly profileLabel: string;
  readonly model: string;
  readonly providerType: string;
}

type AttemptState = "planned" | "running" | "completed" | "failed";

function sha256(value: string): Promise<string> {
  if (typeof crypto === "undefined" || !crypto.subtle) return Promise.reject(new Error("Web Crypto SHA-256 is unavailable."));
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)).then((digest) =>
    Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
  );
}

function outputFor(sessionId: string): string {
  const live = useAgentStore.getState().live[sessionId];
  return live?.items.filter((item) => item.kind === "text").map((item) => item.text).join("\n") ?? "";
}

function waitForTerminal(sessionId: string): Promise<{ status: AttemptState; output: string; error?: string }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      const live = useAgentStore.getState().live[sessionId];
      if (!live) {
        resolve({ status: "failed", output: "", error: "Compare attempt session was removed." });
        return;
      }
      if (!live.running) {
        const status = live.runStatus === "completed" ? "completed" : "failed";
        const error = live.items.find((item) => item.kind === "error")?.message;
        resolve({ status, output: outputFor(sessionId), ...(error ? { error } : {}) });
        return;
      }
      if (Date.now() - started > WAIT_TIMEOUT_MS) {
        void useAgentStore.getState().interrupt(sessionId);
        resolve({ status: "failed", output: outputFor(sessionId), error: "Compare attempt exceeded the 15 minute execution limit." });
        return;
      }
      window.setTimeout(tick, 200);
    };
    tick();
  });
}

function routeKey(profileId: string, model: string): string {
  return `${profileId}:${model}`;
}

export function CompareSessionDialog({
  session,
  onClose,
}: {
  readonly session: AgentSessionListItem;
  readonly onClose: () => void;
}) {
  const [routes, setRoutes] = useState<CompareRoute[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [prompt, setPrompt] = useState("");
  const [run, setRun] = useState<ModelCompareRun | null>(null);
  const [selectedMerge, setSelectedMerge] = useState<string[]>([]);
  const [status, setStatus] = useState("Select two to four routes. Each route will run in an independent session.");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadingRoutes, setLoadingRoutes] = useState(true);
  const baseSessionIdRef = useRef(session.id);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const listed = (await agentApi.listProfiles()).filter((profile) => profile.enabled);
        const loaded: CompareRoute[] = [];
        await Promise.all(listed.map(async (profile) => {
          try {
            const models = await agentApi.listModels(profile.id);
            for (const model of models) {
              const modelId = model.id.trim();
              if (!modelId) continue;
              loaded.push({ id: routeKey(profile.id, modelId), profileId: profile.id, profileLabel: profile.displayName, model: modelId, providerType: profile.providerType });
            }
          } catch {
            // A profile with no model discovery result remains visible in the provider settings.
          }
        }));
        loaded.sort((left, right) => left.profileLabel.localeCompare(right.profileLabel) || left.model.localeCompare(right.model));
        if (!alive) return;
        setRoutes(loaded);
        const active = loaded.find((route) => route.profileId === session.profileId && route.model === session.model);
        setSelected(active ? [active.id] : loaded.slice(0, Math.min(2, MAX_CANDIDATES)).map((route) => route.id));
        setLoadingRoutes(false);
      } catch (cause) {
        if (!alive) return;
        setLoadingRoutes(false);
        setError(errorMessage(cause));
      }
    })();
    return () => { alive = false; };
  }, [session.model, session.profileId]);

  const selectedRoutes = useMemo(() => selected.map((id) => routes.find((route) => route.id === id)).filter((route): route is CompareRoute => Boolean(route)), [routes, selected]);

  const toggleRoute = (id: string) => {
    setSelected((current) => {
      if (current.includes(id)) return current.filter((candidate) => candidate !== id);
      if (current.length >= MAX_CANDIDATES) {
        setStatus(`A compare run is bounded to ${MAX_CANDIDATES} independent routes.`);
        return current;
      }
      return [...current, id];
    });
    setRun(null);
    setSelectedMerge([]);
  };

  const startCompare = async () => {
    const text = prompt.trim();
    if (!text) {
      setError("Enter a prompt for the independent compare attempts.");
      return;
    }
    if (selectedRoutes.length < 2 || selectedRoutes.length > MAX_CANDIDATES) {
      setError("Select two to four provider models before starting compare.");
      return;
    }
    setBusy(true);
    setError(null);
    setRun(null);
    setSelectedMerge([]);
    try {
      const inputDigest = await sha256(JSON.stringify({ role: "user", content: text }));
      const candidates: ModelCompareCandidate[] = selectedRoutes.map((route) => ({
        id: route.id.replace(/[^a-zA-Z0-9:_-]/g, "_").slice(0, 240),
        providerId: route.profileId,
        modelId: route.model,
        label: `${route.profileLabel} · ${route.model}`,
      }));
      let compare = createModelCompareRun({
        id: `compare_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        logicalInput: { id: `input_${Date.now()}`, digest: inputDigest, messages: [{ role: "user", content: text }] },
        candidates,
      });
      setRun(compare);
      setStatus(`Creating ${selectedRoutes.length} independent attempt sessions…`);

      const created = await Promise.all(selectedRoutes.map(async (route) => {
        const summary = await agentApi.create({
          cwd: session.cwd,
          profileId: route.profileId,
          model: route.model,
          permissionMode: session.permissionMode,
          ...(session.reasoningEffort !== undefined ? { reasoningEffort: session.reasoningEffort } : {}),
          title: `Compare · ${route.profileLabel} · ${route.model}`,
          ...(session.tokenBudget !== undefined ? { tokenBudget: session.tokenBudget } : {}),
        });
        useAgentStore.setState((state) => ({
          sessions: [{ ...summary, running: false }, ...state.sessions.filter((entry) => entry.id !== summary.id)],
          live: { ...state.live, [summary.id]: state.live[summary.id] ?? emptyLive() },
        }));
        return { route, summary };
      }));
      setStatus(`Dispatching ${created.length} independent provider attempts in parallel…`);

      const results = await Promise.all(created.map(async ({ summary }, index) => {
        const attemptId = compare.attempts[index]!.id;
        compare = recordModelCompareAttempt(compare, attemptId, { status: "running", startedAt: new Date().toISOString() });
        setRun(compare);
        try {
          await useAgentStore.getState().send(text, [], summary.id);
          return { attemptId, result: await waitForTerminal(summary.id) };
        } catch (cause) {
          return { attemptId, result: { status: "failed" as const, output: "", error: errorMessage(cause) } };
        }
      }));

      for (const { attemptId, result } of results) {
        const completedAt = new Date().toISOString();
        compare = recordModelCompareAttempt(compare, attemptId, {
          status: result.status,
          output: result.output || null,
          ...(result.error ? { error: result.error } : {}),
          completedAt,
        });
        setRun(compare);
      }
      const succeeded = compare.attempts.filter((attempt) => attempt.status === "completed");
      setSelectedMerge(succeeded.length ? [succeeded[0]!.id] : []);
      setStatus(`${succeeded.length} of ${compare.attempts.length} compare attempts completed. Select a completed answer to merge.`);
    } catch (cause) {
      setError(errorMessage(cause));
      setStatus("Compare did not start; no merge receipt was created.");
    } finally {
      setBusy(false);
      if (useAgentStore.getState().activeId !== baseSessionIdRef.current) void useAgentStore.getState().open(baseSessionIdRef.current);
    }
  };

  const merge = async () => {
    if (!run || selectedMerge.length === 0) return;
    const selectedOutput = run.attempts.find((attempt) => attempt.id === selectedMerge[0])?.output ?? "";
    try {
      const outputHash = await sha256(selectedOutput);
      const receipt = createModelCompareMergeReceipt({ run, selectedAttemptIds: selectedMerge, strategy: selectedMerge.length > 1 ? "consensus" : "best-of", rationale: selectedMerge.length > 1 ? "User selected multiple completed attempts for consensus review." : "User selected the completed attempt as best-of output.", finalOutputSha256: outputHash, createdAt: new Date().toISOString() });
      setRun(attachModelCompareMergeReceipt(run, receipt));
      setStatus("Immutable compare merge receipt created. Raw provider output remains in its independent attempt session.");
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  return (
    <ModalSurface className="ag-dialog ag-compare-dialog" scrimClassName="ag-scrim" titleId="compare-session-title" onClose={() => { if (!busy) onClose(); }}>
      <form onSubmit={(event) => { event.preventDefault(); void startCompare(); }}>
        <header className="ag-compare-dialog__header">
          <div><span className="ag-eyebrow">Agent compare</span><h2 id="compare-session-title" className="ag-dialog__title"><GitCompareArrows size={17} aria-hidden="true" /> Compare provider models</h2></div>
          <button type="button" className="ag-icon-btn" aria-label="Close compare dialog" onClick={onClose} disabled={busy}><X size={16} aria-hidden="true" /></button>
        </header>
        <p className="ag-muted">Runs the same prompt in separate sessions, preserves per-attempt provider lineage, then lets you choose an immutable merge receipt.</p>
        <label className="ag-field"><span className="ag-label">Prompt</span><textarea className="ag-input ag-compare-dialog__prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={4} disabled={busy} placeholder="Ask the same question across selected models…" /></label>
        <fieldset className="ag-compare-dialog__routes" disabled={busy || loadingRoutes}>
          <legend className="ag-label">Provider models · choose 2–4</legend>
          {loadingRoutes ? <p className="ag-muted" role="status">Loading provider models…</p> : routes.length === 0 ? <p className="ag-muted">No enabled provider model was discovered. Configure a provider in Settings first.</p> : <div className="ag-compare-dialog__route-list">{routes.map((route) => <label key={route.id} className={`ag-compare-dialog__route${selected.includes(route.id) ? " is-selected" : ""}`}><input type="checkbox" checked={selected.includes(route.id)} onChange={() => toggleRoute(route.id)} aria-label={`Compare ${route.profileLabel} ${route.model}`} /><span><strong>{route.model}</strong><small>{route.profileLabel} · {route.providerType}</small></span>{selected.includes(route.id) ? <Check size={14} aria-hidden="true" /> : null}</label>)}</div>}
          <span className="ag-muted" role="status">{selectedRoutes.length} selected · each attempt gets an independent session</span>
        </fieldset>
        {error ? <p className="ag-error" role="alert">{error}</p> : null}
        <p className="ag-muted" role="status" aria-live="polite">{status}</p>
        {run ? <section className="ag-compare-dialog__results" aria-label="Compare attempt results"><h3>Attempt results</h3>{run.attempts.map((attempt) => { const checked = selectedMerge.includes(attempt.id); const output = attempt.output ?? ""; return <article key={attempt.id} className="ag-compare-dialog__attempt"><header><label><input type="checkbox" checked={checked} disabled={attempt.status !== "completed" || Boolean(run.mergeReceipt)} onChange={(event) => setSelectedMerge((current) => event.target.checked ? [...current, attempt.id] : current.filter((id) => id !== attempt.id))} aria-label={`Select ${attempt.candidate.label ?? attempt.candidate.modelId} for merge`} /><strong>{attempt.candidate.label ?? attempt.candidate.modelId}</strong></label><span className={`ag-compare-dialog__attempt-status is-${attempt.status}`}>{attempt.status === "running" ? <LoaderCircle size={12} className="ag-compare-dialog__spin" aria-hidden="true" /> : null}{attempt.status}</span></header>{attempt.error ? <p className="ag-error">{attempt.error}</p> : null}<pre tabIndex={0} aria-label={`${attempt.candidate.modelId} compare output`}>{output || (attempt.status === "running" ? "Waiting for provider output…" : "No text output recorded.")}</pre></article>; })}</section> : null}
        <footer className="ag-dialog__actions"><button type="button" className="ag-btn" onClick={onClose} disabled={busy}>Cancel</button>{run?.mergeReceipt ? <span className="ag-muted">Merge receipt: {run.mergeReceipt.finalOutputSha256.slice(0, 12)}…</span> : <>{run ? <button type="button" className="ag-btn" onClick={() => void merge()} disabled={busy || selectedMerge.length === 0}><Copy size={13} aria-hidden="true" /> Create merge receipt</button> : null}<button type="submit" className="ag-btn ag-btn--primary" disabled={busy || loadingRoutes || selectedRoutes.length < 2 || !prompt.trim()}>{busy ? <LoaderCircle size={13} className="ag-compare-dialog__spin" aria-hidden="true" /> : <Play size={13} aria-hidden="true" />} {busy ? "Running compare…" : "Run compare"}</button></>}</footer>
      </form>
    </ModalSurface>
  );
}
