import { useState } from "react";
import { Clipboard, FileJson, Upload, X } from "lucide-react";

import {
  deserializeModelCompareRun,
  serializeModelCompareMergeReceipt,
  type ModelCompareRun,
} from "@/domain/model-compare";

const MAX_SNAPSHOT_BYTES = 24 * 1024 * 1024;

function reported(value: number | undefined): string {
  return value === undefined ? "Not reported" : value.toLocaleString("en-US");
}

/** Inspect a validated portable run without treating imported metadata as native execution authority. */
export function ModelCompareReceiptInspector() {
  const [source, setSource] = useState("");
  const [run, setRun] = useState<ModelCompareRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("Load an exported compare snapshot to inspect each attempt and its merge lineage.");
  const [loading, setLoading] = useState(false);

  const load = (payload: string) => {
    try {
      const restored = deserializeModelCompareRun(payload);
      setRun(restored);
      setError(null);
      setStatus(`Validated ${restored.attempts.length} candidate attempts from a portable snapshot.`);
    } catch (cause) {
      setRun(null);
      setError(cause instanceof Error ? cause.message : "The compare snapshot is invalid.");
      setStatus("The snapshot was rejected. No provider request was sent.");
    }
  };

  const copyMerge = async () => {
    if (!run?.mergeReceipt) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard is unavailable.");
      await navigator.clipboard.writeText(serializeModelCompareMergeReceipt(run.mergeReceipt));
      setStatus("Copied the merge receipt with output hashes and attempt lineage.");
    } catch {
      setStatus("Clipboard access is unavailable. The merge receipt remains visible below.");
    }
  };

  return (
    <details className="provider-route-compare__receipt-inspector">
      <summary><FileJson size={14} aria-hidden="true" /> Inspect compare run receipt</summary>
      <div className="provider-route-compare__receipt-body">
        <p>Inspect an exported run independently from route rehearsal. Snapshot validation checks structure and lineage; native execution authenticity is not established by an imported file.</p>
        <label className="provider-route-compare__receipt-file">
          <Upload size={13} aria-hidden="true" /> Import compare snapshot
          <input
            type="file"
            accept="application/json,.json"
            aria-label="Import compare snapshot file"
            disabled={loading}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (!file) return;
              if (file.size > MAX_SNAPSHOT_BYTES) {
                setRun(null);
                setError("The compare snapshot exceeds the 24 MiB limit.");
                return;
              }
              setLoading(true);
              void file.text().then(load).catch(() => {
                setRun(null);
                setError("The compare snapshot file could not be read.");
              }).finally(() => setLoading(false));
            }}
          />
        </label>
        <label className="provider-route-compare__receipt-source">
          <span>Compare snapshot JSON</span>
          <textarea value={source} onChange={(event) => setSource(event.target.value)} rows={4} spellCheck={false} maxLength={MAX_SNAPSHOT_BYTES} placeholder='{"schema":"omnia.model-compare.v1",...}' />
        </label>
        <div className="provider-route-compare__receipt-actions">
          <button type="button" className="button button--secondary" onClick={() => load(source)} disabled={!source.trim() || loading}>Validate compare snapshot</button>
          <button type="button" className="button button--ghost" onClick={() => { setSource(""); setRun(null); setError(null); setStatus("Compare snapshot inspection cleared."); }} disabled={loading}><X size={12} aria-hidden="true" /> Clear snapshot</button>
        </div>
        <p role="status" aria-live="polite">{loading ? "Reading compare snapshot…" : status}</p>
        {error ? <p role="alert" className="provider-route-compare__receipt-error">{error}</p> : null}
        {run ? (
          <section aria-label="Validated compare snapshot">
            <dl className="provider-route-compare__receipt-facts">
              <div><dt>Compare run</dt><dd>{run.id}</dd></div>
              <div><dt>Outcome</dt><dd>{run.status}</dd></div>
              <div><dt>Logical input SHA-256</dt><dd>{run.logicalInput.digest}</dd></div>
              <div><dt>Completion</dt><dd>{run.completedAt ?? "Not completed"}</dd></div>
            </dl>
            <div className="provider-route-compare__table-wrap">
              <table className="provider-route-compare__table">
                <caption>Independent candidate attempt receipts</caption>
                <thead><tr><th scope="col">Candidate</th><th scope="col">Outcome</th><th scope="col">Usage</th><th scope="col">Provider provenance</th></tr></thead>
                <tbody>{run.attempts.map((attempt) => (
                  <tr key={attempt.id}>
                    <th scope="row"><strong>{attempt.candidate.label ?? attempt.candidate.modelId}</strong><small>{attempt.candidate.providerId} · {attempt.id}</small></th>
                    <td>{attempt.status}<small>{attempt.completedAt ?? attempt.startedAt ?? "Not started"}</small>{attempt.error ? <small>{attempt.error}</small> : null}</td>
                    <td><span>Input: {reported(attempt.usage?.inputTokens)}</span><small>Output: {reported(attempt.usage?.outputTokens)}</small><small>Cached input: {reported(attempt.usage?.cachedInputTokens)}</small><small>Total: {reported(attempt.usage?.totalTokens)}</small><small>Cost (µ): {reported(attempt.usage?.costMicros)}</small></td>
                    <td><span>{attempt.provenance?.adapterId ?? "Adapter not reported"}</span><small>Request: {attempt.provenance?.providerRequestId ?? "Not reported"}</small><small>Response: {attempt.provenance?.providerResponseId ?? "Not reported"}</small><small>Receipt: {attempt.provenance?.receiptId ?? "Not reported"}</small></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
            {run.mergeReceipt ? (
              <section aria-label="Validated merge receipt">
                <h4>Merge receipt · {run.mergeReceipt.strategy}</h4>
                <p>{run.mergeReceipt.rationale}</p>
                <p>Selected: {run.mergeReceipt.selectedAttemptIds.join(", ")}</p>
                <button type="button" className="button button--ghost" onClick={() => void copyMerge()}><Clipboard size={12} aria-hidden="true" /> Copy merge receipt</button>
                <pre tabIndex={0} aria-label="Compare merge receipt JSON">{serializeModelCompareMergeReceipt(run.mergeReceipt)}</pre>
              </section>
            ) : <p>No merge receipt is recorded in this snapshot.</p>}
          </section>
        ) : null}
      </div>
    </details>
  );
}
