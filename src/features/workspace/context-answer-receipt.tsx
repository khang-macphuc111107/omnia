import {
  CircleDashed,
  FileSearch,
  Link2,
  ShieldAlert,
  ShieldCheck,
  XCircle,
} from "lucide-react";

import {
  effectiveCitationVerification,
  orderCitations,
  type CitationVerificationState,
  type CitationView,
} from "./evidence-types";

export type AnswerReceiptRowState = "verified" | "review" | "unavailable";

export interface AnswerReceiptRow {
  readonly id: string;
  readonly index: number;
  readonly title: string;
  readonly sourceLabel: string;
  readonly locatorLabel: string;
  readonly verification: CitationVerificationState;
  readonly state: AnswerReceiptRowState;
  readonly excerpt: string;
}

export interface AnswerReceiptModel {
  readonly messageId: string | null;
  readonly runId: string | null;
  readonly rows: readonly AnswerReceiptRow[];
  readonly verifiedCount: number;
  readonly reviewCount: number;
  readonly unavailableCount: number;
  readonly scopeLabel: string;
  readonly boundary: string;
}

function sourceLabel(sourceType: CitationView["sourceType"]): string {
  switch (sourceType) {
    case "workspace":
      return "Workspace";
    case "web":
      return "Web";
    case "connected-source":
      return "Connected source";
    case "conversation":
      return "Conversation";
    case "artifact":
      return "Artifact";
    default:
      return "Attachment";
  }
}

function rowState(verification: CitationVerificationState): AnswerReceiptRowState {
  if (verification === "verified") return "verified";
  if (verification === "unavailable") return "unavailable";
  return "review";
}

export function buildAnswerReceiptModel({
  citations,
  messageId,
  runId,
}: {
  readonly citations: readonly CitationView[];
  readonly messageId: string | null;
  readonly runId: string | null;
}): AnswerReceiptModel {
  const scoped = messageId
    ? citations.filter((citation) => citation.messageId === messageId && (!runId || citation.runId === runId))
    : [];
  const rows = orderCitations(scoped).map((citation) => {
    const verification = effectiveCitationVerification(citation);
    return {
      id: citation.id,
      index: citation.displayIndex,
      title: citation.title,
      sourceLabel: sourceLabel(citation.sourceType),
      locatorLabel: citation.locatorLabel,
      verification,
      state: rowState(verification),
      excerpt: citation.excerpt,
    };
  });
  const verifiedCount = rows.filter((row) => row.verification === "verified").length;
  const unavailableCount = rows.filter((row) => row.verification === "unavailable").length;
  const reviewCount = rows.length - verifiedCount - unavailableCount;

  return {
    messageId,
    runId,
    rows,
    verifiedCount,
    reviewCount,
    unavailableCount,
    scopeLabel: messageId
      ? runId
        ? `Answer ${messageId} · run ${runId}`
        : `Answer ${messageId}`
      : "No assistant answer selected",
    boundary: rows.length > 0
      ? "Renderer projection of persisted citation records. Omnia does not infer sources from links or answer text; retrieval, provider payload, and new verification are not running here."
      : "No persisted citation records are linked to this answer. Missing evidence is not proof that the answer used no sources.",
  };
}

function VerificationIcon({ state }: { readonly state: AnswerReceiptRowState }) {
  if (state === "verified") return <ShieldCheck size={14} />;
  if (state === "unavailable") return <XCircle size={14} />;
  return <ShieldAlert size={14} />;
}

function verificationLabel(state: AnswerReceiptRowState): string {
  if (state === "verified") return "Verified span";
  if (state === "unavailable") return "Unavailable";
  return "Review needed";
}

export function ContextAnswerReceipt({
  citations,
  messageId,
  runId,
}: {
  readonly citations: readonly CitationView[];
  readonly messageId: string | null;
  readonly runId: string | null;
}) {
  const model = buildAnswerReceiptModel({ citations, messageId, runId });
  return (
    <section className="inspector-section answer-evidence-receipt" data-testid="answer-evidence-receipt">
      <header>
        <div>
          <span className="inspector-section__icon inspector-section__icon--blue"><Link2 size={15} /></span>
          <span>
            <strong>Used in this answer</strong>
            <small>{model.rows.length ? `${model.rows.length} persisted source${model.rows.length === 1 ? "" : "s"}` : "No persisted source records"}</small>
          </span>
        </div>
        <span className="answer-evidence-receipt__scope">{model.runId ? "Run-linked" : model.messageId ? "Answer-linked" : "Unscoped"}</span>
      </header>

      {model.rows.length > 0 ? (
        <>
          <div className="answer-evidence-receipt__summary" aria-label="Answer evidence summary">
            <span><strong>{model.verifiedCount}</strong> verified</span>
            <span><strong>{model.reviewCount}</strong> review</span>
            <span><strong>{model.unavailableCount}</strong> unavailable</span>
          </div>
          <div className="answer-evidence-receipt__rows">
            {model.rows.map((row) => (
              <article key={row.id} className={`answer-evidence-receipt__row answer-evidence-receipt__row--${row.state}`}>
                <span className="answer-evidence-receipt__icon" aria-hidden="true"><VerificationIcon state={row.state} /></span>
                <span className="answer-evidence-receipt__copy">
                  <strong><span className="answer-evidence-receipt__index">[{row.index}]</span> {row.title}</strong>
                  <small>{row.sourceLabel} · {row.locatorLabel}</small>
                  {row.excerpt ? <em>{row.excerpt}</em> : null}
                </span>
                <span className={`answer-evidence-receipt__state answer-evidence-receipt__state--${row.state}`}>{verificationLabel(row.state)}</span>
              </article>
            ))}
          </div>
        </>
      ) : (
        <div className="answer-evidence-receipt__empty">
          <FileSearch size={15} />
          <span>No harness-persisted citation evidence is linked to this answer.</span>
        </div>
      )}

      <p className="answer-evidence-receipt__boundary"><CircleDashed size={13} /><span>{model.boundary}</span></p>
    </section>
  );
}

export default ContextAnswerReceipt;
