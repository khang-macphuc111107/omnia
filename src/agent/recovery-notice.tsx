import { useRef, useState } from "react";
import type { LiveState } from "./transcript";
import "./recovery-notice.css";

export function RecoveryNotice({ live, onFork }: { live: LiveState; onFork: () => Promise<void> }) {
  // An acknowledgement only applies to the recovery details that were reviewed.
  const recoveryKey = JSON.stringify([live.recoveryRequired, live.runStatus, live.unknownSideEffects]);
  const [reviewedKey, setReviewedKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  if (!live.recoveryRequired) return null;
  const reviewed = reviewedKey === recoveryKey;

  const fork = async () => {
    if (!reviewed || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      await onFork();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  return (
    <section className="ag-notice-bar ag-recovery-notice" aria-label="Interrupted run recovery">
      <strong>Run status: {live.runStatus}. Manual reconciliation required.</strong>
      <p>The tool journal contains work not saved in the conversation checkpoint. Nothing will be rerun automatically. Inspect the transcript and actual files or external effects before forking; the fork starts from the saved checkpoint, not the recovered journal.</p>
      {live.unknownSideEffects.length ? <p>Tools with unknown outcomes: {live.unknownSideEffects.join(", ")}</p> : null}
      <label className="ag-row ag-recovery-notice__review">
        <input type="checkbox" checked={reviewed} disabled={busy} onChange={(event) => setReviewedKey(event.target.checked ? recoveryKey : null)} />
        <span>I reconciled the tool effects and will explain the current state in the fork.</span>
      </label>
      <button type="button" className="ag-btn" disabled={!reviewed} aria-disabled={busy || undefined} onClick={() => { void fork(); }}>
        {busy ? "Forking…" : "Fork after reconciliation"}
      </button>
      <span className="ag-recovery-notice__status" role="status">{busy ? "Creating a fork from the saved checkpoint…" : ""}</span>
      {error ? <p role="alert">Could not fork: {error}</p> : null}
    </section>
  );
}
