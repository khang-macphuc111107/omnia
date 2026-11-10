import {
  Ban,
  Bot,
  Check,
  ChevronRight,
  FileText,
  Globe,
  Layers,
  LoaderCircle,
  Pencil,
  Search,
  Square,
  Terminal,
  Wrench,
  X,
} from "lucide-react";
import { useId, useMemo, useState, type ReactNode } from "react";

import { prettyJson } from "./format";
import {
  DIFF_PREVIEW_LINES,
  describeTool,
  toolDiff,
  toolGroupLabel,
  type DiffLine,
  type ToolCategory,
  type ToolGroupItem,
  type ToolItem,
  type ToolStatus,
} from "./transcript";

import "./tool-row.css";

/** Output longer than this shows only its last (shell) or first (read/search) lines until expanded. */
export const PREVIEW_LINES = 8;
/** Hard cap on diff rows rendered even after "Show more"; the Changes panel has the rest. */
const DIFF_MAX_LINES = 400;

/** Event the shell listens for to open the Changes panel, optionally at one file. */
export const OPEN_CHANGES_EVENT = "omnia:open-changes";

export function openChanges(path?: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_CHANGES_EVENT, { detail: path ? { path } : {} }));
}

function ToolIcon({ category }: { category: ToolCategory }) {
  switch (category) {
    case "task":
      return <Bot size={14} aria-hidden="true" />;
    case "read":
      return <FileText size={14} aria-hidden="true" />;
    case "edit":
      return <Pencil size={14} aria-hidden="true" />;
    case "shell":
      return <Terminal size={14} aria-hidden="true" />;
    case "search":
      return <Search size={14} aria-hidden="true" />;
    case "web":
      return <Globe size={14} aria-hidden="true" />;
    default:
      return <Wrench size={14} aria-hidden="true" />;
  }
}

const STATUS_LABEL: Record<ToolStatus, string> = {
  streaming: "Preparing",
  pending: "Waiting",
  running: "Running",
  ok: "Done",
  error: "Failed",
  denied: "Denied",
  stopped: "Stopped",
};

function StatusIcon({ status }: { status: ToolStatus }) {
  const label = STATUS_LABEL[status];
  switch (status) {
    case "ok":
      return <Check size={14} className="ag-status ag-status--ok" aria-label={label} role="img" />;
    case "error":
      return <X size={14} className="ag-status ag-status--error" aria-label={label} role="img" />;
    case "denied":
      return <Ban size={14} className="ag-status ag-status--error" aria-label={label} role="img" />;
    case "stopped":
      return <Square size={12} className="ag-status" aria-label={label} role="img" />;
    default:
      return <LoaderCircle size={14} className="ag-status ag-spin" aria-label={label} role="img" />;
  }
}

/** Tool output, trimmed to its first or last lines until the user asks for all of it. */
function OutputPreview({ output, live, from }: { output: string; live: boolean; from: "head" | "tail" }) {
  const [showAll, setShowAll] = useState(false);
  const lines = output.split("\n");
  if (lines.at(-1) === "" && output.endsWith("\n")) lines.pop();
  const trimmed = !showAll && lines.length > PREVIEW_LINES;
  const shown = from === "tail" ? lines.slice(-PREVIEW_LINES) : lines.slice(0, PREVIEW_LINES);
  return (
    <>
      <div className="ag-tool__label">{live ? "Output (streaming)" : "Output"}</div>
      <pre className="ag-pre" aria-live={live ? "polite" : "off"}>{trimmed ? shown.join("\n") : output}</pre>
      {trimmed ? (
        <button type="button" className="ag-btn ag-btn--ghost ag-tool__more" onClick={() => setShowAll(true)}>
          Show all {lines.length} lines
        </button>
      ) : null}
    </>
  );
}

/** Changed lines only, with +/− gutters; "Show more" past DIFF_PREVIEW_LINES. */
export function DiffPreview({ lines, path }: { lines: DiffLine[]; path?: string | undefined }) {
  const [showAll, setShowAll] = useState(false);
  const limit = showAll ? DIFF_MAX_LINES : DIFF_PREVIEW_LINES;
  const shown = lines.slice(0, limit);
  return (
    <>
      <div className="ag-diff" role="group" aria-label="Diff preview">
        {shown.map((line, index) =>
          line.kind === "gap" ? (
            <div key={index} className="ag-diff__gap" aria-hidden="true">
              ⋯
            </div>
          ) : (
            <div key={index} className={`ag-diff__line ag-diff__line--${line.kind}`}>
              <span className="ag-diff__gutter" aria-hidden="true">
                {line.kind === "add" ? "+" : "−"}
              </span>
              <span className="ag-diff__text">{line.text || " "}</span>
            </div>
          ),
        )}
      </div>
      <div className="ag-tool__actions">
        {lines.length > shown.length && !showAll ? (
          <button type="button" className="ag-tool__link" onClick={() => setShowAll(true)}>
            Show more ({lines.length - shown.length})
          </button>
        ) : null}
        <button type="button" className="ag-tool__link" onClick={() => openChanges(path)}>
          Open in Changes
        </button>
      </div>
    </>
  );
}

function Delta({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="ag-tool__delta">
      {added ? <span className="ag-tool__add">+{added}</span> : null}
      {removed ? <span className="ag-tool__del">−{removed}</span> : null}
    </span>
  );
}

/**
 * One tool call as a single calm line: icon · verb · target · delta · status.
 * `defaultOpen` opens it until the user toggles it (used for the latest small edit).
 */
export function ToolRow({ item, children, defaultOpen = false }: { item: ToolItem; children?: ReactNode; defaultOpen?: boolean }) {
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const open = userOpen ?? defaultOpen;
  const info = useMemo(() => describeTool(item), [item]);
  const diff = useMemo(() => (open && info.category === "edit" ? toolDiff(item) : null), [open, info.category, item]);
  const isTask = item.sub !== null || item.name === "task";
  const output = item.output || item.progress;
  const live = item.status === "running" && !item.output;
  const status = STATUS_LABEL[item.status];
  const deltaText = info.delta ? `${info.delta.added ? `+${info.delta.added}` : ""} ${info.delta.removed ? `−${info.delta.removed}` : ""}` : "";
  const command = info.category === "shell" && typeof (item.input as { command?: unknown } | null)?.command === "string" ? (item.input as { command: string }).command : "";
  // An edit's output repeats its diff; show it only when there is no diff or the call failed.
  const showOutput = output && !(diff && diff.lines.length > 0 && item.status === "ok");
  return (
    <div className={`ag-tool${isTask ? " ag-tool--task" : ""}`} data-status={item.status} data-category={info.category}>
      <button
        type="button"
        className="ag-tool__head"
        aria-expanded={open}
        aria-label={`${info.verb} ${info.target} ${deltaText} ${status}`.replace(/\s+/g, " ").trim()}
        title={info.title ? `${info.verb} ${info.title}` : undefined}
        onClick={() => setUserOpen(!open)}
      >
        <ChevronRight size={12} className={`ag-chevron${open ? " ag-chevron--open" : ""}`} aria-hidden="true" />
        <ToolIcon category={info.category} />
        <span className="ag-tool__name">{info.verb}</span>
        <span className="ag-tool__summary">{info.target}</span>
        {info.delta ? <Delta {...info.delta} /> : null}
        <StatusIcon status={item.status} />
      </button>
      {open ? (
        <div className="ag-tool__body">
          {children}
          {diff && diff.lines.length > 0 ? <DiffPreview lines={diff.lines} path={diff.paths.length === 1 ? diff.paths[0] : undefined} /> : null}
          {command ? <pre className="ag-pre ag-tool__command">$ {command}</pre> : null}
          {showOutput ? <OutputPreview output={output} live={live} from={info.category === "shell" ? "tail" : "head"} /> : null}
          <button type="button" className="ag-tool__toggle" aria-expanded={detailsOpen} onClick={() => setDetailsOpen(!detailsOpen)}>
            <ChevronRight size={10} className={`ag-chevron${detailsOpen ? " ag-chevron--open" : ""}`} aria-hidden="true" />
            Details
          </button>
          {detailsOpen ? (
            <pre className="ag-pre">{item.partialJson && item.status === "streaming" ? item.partialJson : prettyJson(item.input)}</pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** A run of finished tool calls behind one row; the calls render as children when expanded. */
export function ToolGroup({ group, children }: { group: ToolGroupItem; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  return (
    <div className="ag-tool ag-tool-group" data-status="ok">
      <button
        type="button"
        className="ag-tool__head"
        aria-expanded={open}
        aria-controls={open ? bodyId : undefined}
        onClick={() => setOpen(!open)}
      >
        <ChevronRight size={12} className={`ag-chevron${open ? " ag-chevron--open" : ""}`} aria-hidden="true" />
        <Layers size={14} aria-hidden="true" />
        <span className="ag-tool__name">{toolGroupLabel(group)}</span>
        <span className="ag-tool__summary" />
        <StatusIcon status="ok" />
      </button>
      {open ? (
        <div id={bodyId} className="ag-tool-group__body">
          {children}
        </div>
      ) : null}
    </div>
  );
}
