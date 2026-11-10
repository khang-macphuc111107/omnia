import { Activity, FileJson2, LockKeyhole, X } from "lucide-react";

import type { AppRuntimeInfo } from "@/lib/desktop";

import { DiagnosticsSessionWorkbench } from "./diagnostics-session-workbench";
import type { MemoryView } from "./types";

export interface MemoryDiagnosticsPreviewProps {
  readonly runtime: AppRuntimeInfo;
  readonly allMemories: readonly MemoryView[];
  readonly visibleMemories: readonly MemoryView[];
  readonly retrievableMemories: readonly MemoryView[];
  readonly locallySuppressedCount: number;
  readonly importedCount: number;
  readonly onClose: () => void;
}

/**
 * Memory-specific framing around the shared diagnostics timeline.
 *
 * The summary is intentionally derived from renderer projections. It must not
 * be read as proof that native memory retrieval, storage, or telemetry ran.
 */
export function MemoryDiagnosticsPreview({
  runtime,
  allMemories,
  visibleMemories,
  retrievableMemories,
  locallySuppressedCount,
  importedCount,
  onClose,
}: MemoryDiagnosticsPreviewProps) {
  return (
    <section
      id="memory-diagnostics-preview"
      className="memory-diagnostics-preview"
      aria-label="Memory diagnostics inspector"
    >
      <header className="memory-diagnostics-preview__header">
        <span className="memory-diagnostics-preview__icon" aria-hidden="true">
          <Activity size={18} />
        </span>
        <div>
          <span className="eyebrow">Renderer-local inspector</span>
          <h3>Memory diagnostics inspector</h3>
          <p>
            Inspect safe memory health markers and a redacted session timeline before a native memory collector exists.
          </p>
        </div>
        <button
          type="button"
          className="button button--ghost"
          onClick={onClose}
          aria-label="Close memory diagnostics preview"
        >
          <X size={14} /> Close
        </button>
      </header>

      <div className="memory-diagnostics-preview__metrics" role="status" aria-label="Memory diagnostics summary">
        <article>
          <strong>{allMemories.length}</strong>
          <small>Source projections</small>
        </article>
        <article>
          <strong>{visibleMemories.length}</strong>
          <small>Visible after policy</small>
        </article>
        <article className="memory-diagnostics-preview__metric--success">
          <strong>{retrievableMemories.length}</strong>
          <small>Eligible in preview</small>
        </article>
        <article className={locallySuppressedCount > 0 ? "memory-diagnostics-preview__metric--warning" : ""}>
          <strong>{locallySuppressedCount}</strong>
          <small>Locally suppressed</small>
        </article>
      </div>

      <div className="memory-diagnostics-preview__facts" aria-label="Memory diagnostics evidence summary">
        <div>
          <FileJson2 size={15} aria-hidden="true" />
          <span><strong>Imported preview entries</strong><small>{importedCount} staged in this renderer session</small></span>
        </div>
        <div>
          <Activity size={15} aria-hidden="true" />
          <span><strong>Retrieval route</strong><small>{retrievableMemories.length} candidates; no provider request started</small></span>
        </div>
        <div>
          <LockKeyhole size={15} aria-hidden="true" />
          <span><strong>Native receipt</strong><small>Unavailable · durable memory diagnostics remain planned</small></span>
        </div>
      </div>

      <DiagnosticsSessionWorkbench runtime={runtime} />

      <p className="memory-diagnostics-preview__boundary" role="note" aria-label="Memory diagnostics boundary">
        <LockKeyhole size={14} aria-hidden="true" />
        <span>
          Preview only · Renderer-local · No durable write. Counts come from visible memory projections; no native retrieval, storage read, provider request, filesystem read, or execution was started.
        </span>
      </p>
    </section>
  );
}

