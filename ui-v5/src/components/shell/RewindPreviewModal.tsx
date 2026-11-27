import { For, Show } from 'solid-js';
import { AlertTriangle, FileDiff, History, X } from 'lucide-solid';
import { DiffCard } from '@/components/chat/DiffCard';
import { confirmRewindExecution, privacyMask, rewindPreview, setRewindPreview } from '@/state/studio';
import { maskText } from '@/utils/privacy';

export function RewindPreviewModal() {
  return (
    <Show when={rewindPreview()}>
      {(preview) => (
        <div
          data-testid="rewind-preview-modal"
          class="fixed inset-0 z-50 bg-black/65 flex items-center justify-center p-4"
          onClick={() => setRewindPreview(null)}
        >
          <div
            class="w-full max-w-2xl rounded-lg border border-[var(--border-strong)] bg-[var(--bg-panel)] shadow-[var(--shadow-md)] overflow-hidden flex flex-col max-h-[84vh]"
            onClick={(e) => e.stopPropagation()}
          >
            <div class="px-4 py-3 border-b border-[var(--border-subtle)] bg-[var(--bg-elevated)] flex items-center justify-between">
              <div class="flex items-center gap-2 font-bold text-[13.5px]">
                <History class="w-4 h-4 text-[var(--accent-amber)]" />
                <span>Checkpoint /rewind Diff Preview — Turn T{preview().targetTurn}</span>
              </div>
              <button type="button" class="omnia-btn px-1.5 py-1" onClick={() => setRewindPreview(null)}>
                <X class="w-3.5 h-3.5" />
              </button>
            </div>

            <div class="p-4 overflow-y-auto space-y-3 text-[12.5px]">
              <div class="p-3 rounded border border-[var(--accent-amber)] bg-[var(--accent-amber-dim)] flex items-start gap-2.5">
                <AlertTriangle class="w-4 h-4 text-[var(--accent-amber)] shrink-0 mt-0.5" />
                <div class="space-y-1">
                  <div class="font-semibold text-[var(--ink-primary)]">
                    {maskText(preview().summary, privacyMask())}
                  </div>
                  <div class="text-[11.5px] font-mono-num text-[var(--ink-secondary)]">
                    Turns dropped: {preview().turnsToDrop} · Total turns: {preview().totalTurns}
                    <Show when={preview().checkpointHash}>
                      {' · '}BLAKE3:{preview().checkpointHash!.slice(0, 12)}
                    </Show>
                  </div>
                </div>
              </div>

              <Show when={preview().affectedFiles.length > 0}>
                <div class="space-y-1.5">
                  <div class="text-[11px] font-semibold uppercase text-[var(--ink-muted)] flex items-center gap-1.5">
                    <FileDiff class="w-3.5 h-3.5 text-[var(--accent-cyan)]" />
                    <span>Affected Workspace Files ({preview().affectedFiles.length})</span>
                  </div>
                  <div class="flex flex-wrap gap-1.5">
                    <For each={preview().affectedFiles}>
                      {(f) => <span class="omnia-badge font-mono-num">{maskText(f, privacyMask())}</span>}
                    </For>
                  </div>
                </div>
              </Show>

              <Show
                when={preview().diffPatch.trim().length > 0}
                fallback={
                  <div class="p-3 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] text-[12px] text-[var(--ink-muted)] font-mono-num">
                    No file patch hunks recorded for this checkpoint boundary; only conversation transcript turns after T{preview().targetTurn} will be truncated.
                  </div>
                }
              >
                <DiffCard
                  patch={maskText(preview().diffPatch, privacyMask())}
                  path={`checkpoint-T${preview().targetTurn}.patch`}
                />
              </Show>
            </div>

            <div class="px-4 py-3 border-t border-[var(--border-subtle)] bg-[var(--bg-rail)] flex items-center justify-end gap-2">
              <button type="button" class="omnia-btn text-[12px]" onClick={() => setRewindPreview(null)}>
                Cancel
              </button>
              <button
                type="button"
                data-testid="confirm-rewind-btn"
                class="omnia-btn omnia-btn-danger text-[12px]"
                onClick={() => void confirmRewindExecution()}
              >
                <History class="w-3.5 h-3.5" />
                <span>Confirm Rewind to T{preview().targetTurn}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </Show>
  );
}
