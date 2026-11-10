import {
  AlertTriangle,
  ChevronDown,
  FileText,
  History,
  Info,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useState } from "react";

import {
  bridgeAnnouncement,
  bridgeBadgeFromPlan,
  bridgeInspectorSections,
  bridgeStageTimeline,
  type MultimodalBridgePlanProjection,
} from "./multimodal-bridge-projection";

interface MultimodalBridgeInspectorProps {
  readonly projection: MultimodalBridgePlanProjection;
  /** Active requests default expanded; stored requests remain compact. */
  readonly active: boolean;
}

function BridgeStatusIcon({ tone }: { tone: "neutral" | "progress" | "info" | "warning" | "danger" }) {
  if (tone === "warning" || tone === "danger") return <AlertTriangle size={15} aria-hidden="true" />;
  if (tone === "progress") return <History size={15} aria-hidden="true" />;
  return <ShieldCheck size={15} aria-hidden="true" />;
}

/**
 * Read-only bridge evidence panel. This component consumes the common
 * renderer projection and intentionally owns no route, upload, retry, or
 * provider dispatch behavior.
 */
export function MultimodalBridgeInspector({
  projection,
  active,
}: MultimodalBridgeInspectorProps) {
  const [detailsOpen, setDetailsOpen] = useState(active);
  const status = bridgeBadgeFromPlan(projection);
  const sections = bridgeInspectorSections(projection);
  const timeline = bridgeStageTimeline(projection);

  useEffect(() => {
    setDetailsOpen(active);
  }, [active, projection.planId, projection.runId]);

  return (
    <section
      className={`inspector-section multimodal-bridge-card multimodal-bridge-card--${status.tone}`}
      data-testid="multimodal-bridge-inspector"
      aria-label="Multimodal bridge plan and execution evidence"
    >
      <header className="multimodal-bridge-card__header">
        <div>
          <span className="inspector-section__icon inspector-section__icon--violet">
            <FileText size={15} aria-hidden="true" />
          </span>
          <span>
            <strong>Multimodal bridge</strong>
            <small>Frozen native plan · metadata-only renderer projection</small>
          </span>
        </div>
        <span className={`multimodal-bridge-status multimodal-bridge-status--${status.tone}`}>
          <BridgeStatusIcon tone={status.tone} />
          {status.label}
        </span>
      </header>

      <p className="multimodal-bridge-card__detail">{status.detail}</p>
      {/**
       * Keep exactly one live region. The visible copy is intentionally not a
       * second status region, otherwise assistive technology announces the
       * same state twice whenever native evidence changes.
       */}
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {bridgeAnnouncement(projection)}
      </p>

      <details
        className="multimodal-bridge-card__details"
        open={detailsOpen}
        onToggle={(event) => setDetailsOpen(event.currentTarget.open)}
      >
        <summary>
          <span>
            <strong>Bridge evidence</strong>
            <small>
              {projection.stageReceipts.length === 0
                ? "Plan persisted; no stage receipts observed"
                : `${projection.stageReceipts.length} durable stage ${projection.stageReceipts.length === 1 ? "receipt" : "receipts"}`}
            </small>
          </span>
          <ChevronDown size={15} aria-hidden="true" />
        </summary>
        <div className="multimodal-bridge-card__sections">
          <section className="multimodal-bridge-evidence multimodal-bridge-stage-timeline" aria-label="Bridge stage timeline">
            <div className="multimodal-bridge-stage-timeline__heading">
              <h4>Stage timeline</h4>
              <small>{timeline.length === 0 ? "No stage receipts observed" : `${timeline.length} stage${timeline.length === 1 ? "" : "s"} · receipt-derived`}</small>
            </div>
            {timeline.length > 0 ? (
              <ol className="multimodal-bridge-stage-timeline__list">
                {timeline.map((entry, index) => {
                  const attention =
                    entry.latestStatus === "outcome-unknown" ||
                    entry.latestStatus === "reconcile-required" ||
                    entry.latestReconciliationStatus === "pending" ||
                    entry.latestReconciliationStatus === "blocked";
                  return (
                    <li
                      className={attention ? "multimodal-bridge-stage-timeline__item multimodal-bridge-stage-timeline__item--attention" : "multimodal-bridge-stage-timeline__item"}
                      key={entry.stageId}
                    >
                      <span className="multimodal-bridge-stage-timeline__marker" aria-hidden="true">{index + 1}</span>
                      <div className="multimodal-bridge-stage-timeline__copy">
                        <div className="multimodal-bridge-stage-timeline__title">
                          <strong>{entry.label}</strong>
                          <span>{entry.latestStatus}</span>
                        </div>
                        <small>
                          {entry.stageId} · attempt {entry.latestAttemptNo} · {entry.attemptCount} recorded · {entry.latestBoundary}
                        </small>
                        <small>
                          {attention ? `Reconciliation ${entry.latestReconciliationStatus}` : `Fidelity ${entry.latestFidelityDisposition}`} · receipt {entry.latestReceiptId}
                        </small>
                      </div>
                    </li>
                  );
                })}
              </ol>
            ) : (
              <p className="multimodal-bridge-stage-timeline__empty">A frozen plan exists, but native stage execution evidence has not been observed.</p>
            )}
            <p className="multimodal-bridge-stage-timeline__boundary">
              Receipt-derived order only. Dependency edges, dispatch authority, and provider execution remain native-owned and are not inferred here.
            </p>
          </section>
          {sections.map((section) => (
            <section className="multimodal-bridge-evidence" key={section.id}>
              <h4>{section.label}</h4>
              <dl>
                {section.rows.map((row) => (
                  <div key={`${section.id}-${row.label}`}>
                    <dt>{row.label}</dt>
                    <dd>{row.value}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
          <div className="multimodal-bridge-card__notice">
            <Info size={14} aria-hidden="true" />
            <p>
              This panel never treats a generic model capability, a frozen route plan, or a local transform as proof that a provider received the original file. Provider acceptance and cost appear only from durable provider-stage observations.
            </p>
          </div>
        </div>
      </details>
    </section>
  );
}
