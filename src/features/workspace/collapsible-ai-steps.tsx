import { ChevronRight } from "lucide-react";
import { useEffect, useId, useState, type ReactNode } from "react";

import { ComposerFileTypeIcon } from "./ai-panel-composer";
import "@/styles/review-message-content.css";

export interface AiStep {
  id: string;
  label: string;
  content?: ReactNode;
  status?: "running" | "completed" | "failed";
}

export interface CollapsibleAiStepsProps {
  steps: readonly AiStep[];
  className?: string;
}

interface ParsedAiStepLabel {
  verb: string;
  filePath: string;
  lineRange?: string;
  diffAdded?: string;
  diffRemoved?: string;
}

function parseAiStepLabel(label: string): ParsedAiStepLabel | null {
  const match = label
    .trim()
    .match(
      /^(Read|Reading|Edited|Editing|Created|Creating|Updated|Updating|Deleted|Deleting|Opened|Opening)\s+([^\s()]+)(?:\s+(?:\(lines\s+([^)]+)\)|\(\+(\d+)(?:\s+-(\d+))?\)))?$/i,
    );
  if (!match) return null;
  const [, verb, candidatePath, lineRange, diffAdded, diffRemoved] = match;
  if (!verb || !candidatePath || candidatePath.endsWith("...")) return null;
  if (!/[./\\]/.test(candidatePath)) return null;
  return {
    verb,
    filePath: candidatePath,
    ...(lineRange ? { lineRange } : {}),
    ...(diffAdded ? { diffAdded } : {}),
    ...(diffRemoved ? { diffRemoved } : {}),
  };
}

interface LinePreviewRow {
  lineNumber: string;
  kind: "context" | "add" | "del";
  prefix: string;
  text: string;
}

function buildDefaultStepLineRows(parsed: ParsedAiStepLabel): readonly LinePreviewRow[] {
  const isEdit = /^(Edited|Editing|Created|Creating|Updated|Updating|Deleted|Deleting)$/i.test(parsed.verb);
  if (isEdit) {
    return [
      {
        lineNumber: parsed.lineRange ?? "—",
        kind: "context",
        prefix: " ",
        text: `${parsed.verb} ${parsed.filePath} (inline diff not captured in step payload)`,
      },
      {
        lineNumber: "—",
        kind: "del",
        prefix: "-",
        text: parsed.diffRemoved
          ? `${parsed.diffRemoved} lines removed`
          : "Removed lines not captured in step payload",
      },
      {
        lineNumber: "—",
        kind: "add",
        prefix: "+",
        text: parsed.diffAdded
          ? `${parsed.diffAdded} lines added`
          : "Added lines not captured in step payload",
      },
    ];
  }

  return [
    {
      lineNumber: parsed.lineRange ?? "—",
      kind: "context",
      prefix: " ",
      text: `${parsed.verb} ${parsed.filePath}${parsed.lineRange ? ` (lines ${parsed.lineRange})` : ""} — inline excerpt not captured in step payload`,
    },
  ];
}

function parseMultilineStringToRows(raw: string, startLine = 1): readonly LinePreviewRow[] {
  const lines = raw.split(/\r?\n/);
  let currentLine = startLine;
  return lines.map((line) => {
    const numberedMatch = line.match(/^\s*(\d+)\s*[|:]\s?(.*)$/);
    if (numberedMatch) {
      const num = numberedMatch[1]!;
      const body = numberedMatch[2] ?? "";
      currentLine = Number.parseInt(num, 10) + 1;
      if (body.startsWith("+")) {
        return { lineNumber: num, kind: "add", prefix: "+", text: body.slice(1) };
      }
      if (body.startsWith("-")) {
        return { lineNumber: num, kind: "del", prefix: "-", text: body.slice(1) };
      }
      return { lineNumber: num, kind: "context", prefix: " ", text: body };
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      const row: LinePreviewRow = { lineNumber: String(currentLine), kind: "add", prefix: "+", text: line.slice(1) };
      currentLine += 1;
      return row;
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      return { lineNumber: String(currentLine), kind: "del", prefix: "-", text: line.slice(1) };
    }
    const row: LinePreviewRow = { lineNumber: String(currentLine), kind: "context", prefix: " ", text: line };
    currentLine += 1;
    return row;
  });
}

function renderStepExpandedContent(step: AiStep, parsed: ParsedAiStepLabel | null): ReactNode {
  if (typeof step.content === "string") {
    if (step.content.includes("\n")) {
      const startLine = parsed?.lineRange ? Number.parseInt(parsed.lineRange.split(/[-–]/)[0] ?? "1", 10) || 1 : 1;
      const rows = parseMultilineStringToRows(step.content, startLine);
      return (
        <div className="ai-step__line-viewer" role="region" aria-label={parsed ? `${parsed.verb} ${parsed.filePath}` : step.label}>
          {rows.map((row, idx) => (
            <div key={idx} className={`ai-step__code-line ai-step__code-line--${row.kind}`}>
              <span className="ai-step__line-num" aria-hidden="true">{row.lineNumber}</span>
              <span className="ai-step__line-prefix" aria-hidden="true">{row.prefix}</span>
              <span className="ai-step__line-text">{row.text}</span>
            </div>
          ))}
        </div>
      );
    }
    if (parsed) {
      const rows = buildDefaultStepLineRows(parsed);
      return (
        <>
          <div className="ai-step__summary-note">{step.content}</div>
          <div className="ai-step__line-viewer" role="region" aria-label={`${parsed.verb} ${parsed.filePath}`}>
            {rows.map((row, idx) => (
              <div key={idx} className={`ai-step__code-line ai-step__code-line--${row.kind}`}>
                <span className="ai-step__line-num" aria-hidden="true">{row.lineNumber}</span>
                <span className="ai-step__line-prefix" aria-hidden="true">{row.prefix}</span>
                <span className="ai-step__line-text">{row.text}</span>
              </div>
            ))}
          </div>
        </>
      );
    }
    return step.content;
  }

  if (step.content !== undefined && step.content !== null) {
    return step.content;
  }

  if (parsed) {
    const rows = buildDefaultStepLineRows(parsed);
    return (
      <div className="ai-step__line-viewer" role="region" aria-label={`${parsed.verb} ${parsed.filePath}`}>
        {rows.map((row, idx) => (
          <div key={idx} className={`ai-step__code-line ai-step__code-line--${row.kind}`}>
            <span className="ai-step__line-num" aria-hidden="true">{row.lineNumber}</span>
            <span className="ai-step__line-prefix" aria-hidden="true">{row.prefix}</span>
            <span className="ai-step__line-text">{row.text}</span>
          </div>
        ))}
      </div>
    );
  }

  return null;
}

/**
 * A stream is sequential even when several advisory events still say running.
 * Only its latest running step opens. A completed stream starts fully folded;
 * users can then inspect one step at a time without a wall of execution text.
 */
export function CollapsibleAiSteps({ steps, className }: CollapsibleAiStepsProps) {
  const id = useId();
  const runningId = [...steps].reverse().find((step) => step.status === "running")?.id ?? null;
  const [expandedId, setExpandedId] = useState<string | null>(null);
  useEffect(() => { setExpandedId(null); }, [runningId]);

  if (steps.length === 0) return null;
  return (
    <div className={className ? `ai-steps ${className}` : "ai-steps"} aria-label="Thinking and commands">
      {steps.map((step, index) => {
        const open = runningId !== null ? step.id === runningId : step.id === expandedId;
        const contentId = `${id}-step-${index}`;
        const parsed = parseAiStepLabel(step.label);
        return (
          <details className={`ai-step ai-step--${step.status ?? "completed"}`} key={step.id} open={open} data-step-id={step.id}>
            <summary
              aria-expanded={open}
              aria-controls={contentId}
              onClick={(event) => {
                event.preventDefault();
                if (runningId !== null) return;
                setExpandedId((current) => current === step.id ? null : step.id);
              }}
            >
              <ChevronRight className="ai-step__chevron" size={14} strokeWidth={1.75} aria-hidden="true" />
              {parsed ? (
                <span className="ai-step__file-icon" aria-hidden="true">
                  <ComposerFileTypeIcon name={parsed.filePath} />
                </span>
              ) : null}
              {parsed?.diffAdded ? (
                <>
                  <span className="ai-step__label">{`${parsed.verb} ${parsed.filePath}`}</span>{" "}
                  <span className="ai-step__diff-stats">
                    (<span className="ai-step__diff-add">+{parsed.diffAdded}</span>
                    {parsed.diffRemoved ? (
                      <>
                        {" "}
                        <span className="ai-step__diff-del">-{parsed.diffRemoved}</span>
                      </>
                    ) : null}
                    )
                  </span>
                </>
              ) : parsed?.lineRange ? (
                <>
                  <span className="ai-step__label">{`${parsed.verb} ${parsed.filePath}`}</span>{" "}
                  <span className="ai-step__line-range">{`(lines ${parsed.lineRange})`}</span>
                </>
              ) : (
                <span className="ai-step__label">{step.label}</span>
              )}
            </summary>
            <div id={contentId} className="ai-step__content">
              {renderStepExpandedContent(step, parsed)}
            </div>
          </details>
        );
      })}
    </div>
  );
}

