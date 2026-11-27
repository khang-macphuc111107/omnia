import { For, Show, createEffect, createSignal } from 'solid-js';
import { CheckCircle2, ListOrdered, Plus, RefreshCw, ShieldCheck, X, Zap } from 'lucide-solid';
import { api } from '@/api/client';
import {
  activeSessionId,
  enqueueAdditiveSteer,
  flashNotice,
  privacyMask,
  refreshSteerQueue,
  setSteerDrawerOpen,
  steerDrawerOpen,
  steerQueue,
} from '@/state/studio';
import { maskText } from '@/utils/privacy';

export function SteerQueueDrawer() {
  const [draft, setDraft] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [statusMsg, setStatusMsg] = createSignal('');

  createEffect(() => {
    if (steerDrawerOpen()) {
      void refreshSteerQueue();
    }
  });

  const handleEnqueue = async (mode: 'queue' | 'steer') => {
    const text = draft().trim();
    if (!text) return;
    setBusy(true);
    await enqueueAdditiveSteer(text, mode);
    setDraft('');
    setStatusMsg(`Queued via ${mode.toUpperCase()} (ADDITIVE_INTAKE · token_budget: NULL)`);
    setBusy(false);
  };

  const handleMarkDone = async (id: string) => {
    const res = await api.updateSteerStatus(id, 'done');
    if (res.ok) {
      setStatusMsg(`Marked ${id.slice(0, 10)} done`);
      await refreshSteerQueue();
    } else {
      setStatusMsg(`Status update note (${res.error.code}): ${res.error.message}`);
    }
  };

  const handleReconcile = async () => {
    setBusy(true);
    const res = await api.reconcileSteer(activeSessionId());
    if (res.ok) {
      setStatusMsg(String(res.data.summary ?? 'Steer queue reconciled with active deliverables'));
      flashNotice('Steer queue reconciled');
      await refreshSteerQueue();
    } else {
      setStatusMsg(`Reconcile note (${res.error.code}): ${res.error.message}`);
    }
    setBusy(false);
  };

  return (
    <Show when={steerDrawerOpen()}>
      <aside
        data-testid="steer-queue-drawer"
        class="w-96 max-w-[92vw] shrink-0 h-full border-l border-[var(--border-subtle)] bg-[var(--bg-rail)] flex flex-col"
      >
        <div class="p-3 border-b border-[var(--border-subtle)] flex items-center justify-between gap-2">
          <div class="flex items-center gap-2 font-semibold text-[13px] min-w-0">
            <ListOrdered class="w-4 h-4 text-[var(--accent-cyan)] shrink-0" />
            <span class="truncate">Steer Queue (ADDITIVE_INTAKE)</span>
          </div>
          <div class="flex items-center gap-1 shrink-0">
            <button
              type="button"
              class="omnia-btn px-1.5 py-1"
              title="Refresh Steer Queue"
              onClick={() => void refreshSteerQueue()}
            >
              <RefreshCw class="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              class="omnia-btn px-1.5 py-1"
              onClick={() => setSteerDrawerOpen(false)}
            >
              <X class="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        <div class="px-3 py-2 border-b border-[var(--border-subtle)] bg-[var(--bg-panel)] flex items-center justify-between text-[11px] font-mono-num">
          <span class="text-[var(--status-emerald)]">token_budget: NULL (Unbounded)</span>
          <button
            type="button"
            disabled={busy()}
            class="omnia-btn px-2 py-0.5 text-[10.5px]"
            onClick={() => void handleReconcile()}
          >
            <ShieldCheck class="w-3 h-3 text-[var(--accent-cyan)]" />
            <span>Reconcile</span>
          </button>
        </div>

        <Show when={statusMsg()}>
          <div class="px-3 py-1.5 border-b border-[var(--border-subtle)] bg-[var(--accent-dim)] text-[11px] font-mono-num text-[var(--accent-cyan)]">
            {statusMsg()}
          </div>
        </Show>

        <div class="flex-1 overflow-y-auto p-3 space-y-2">
          <Show
            when={steerQueue.length > 0}
            fallback={
              <div class="p-4 rounded border border-[var(--border-subtle)] bg-[var(--bg-panel)] text-[12px] text-[var(--ink-muted)] text-center">
                No queued additive steers yet. Add follow-up requirements below without interrupting or dropping active work.
              </div>
            }
          >
            <For each={steerQueue}>
              {(item, idx) => (
                <div class="p-2.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-panel)] space-y-1.5 text-[12px]">
                  <div class="flex items-center justify-between gap-2 text-[10.5px] font-mono-num">
                    <span class="text-[var(--accent-cyan)] font-semibold">
                      #{idx() + 1} · {item.mode}
                    </span>
                    <span
                      class="omnia-badge"
                      classList={{
                        'text-[var(--status-emerald)]': item.status === 'done' || item.status === 'reconciled',
                        'text-[var(--accent-amber)]': item.status === 'queued' || item.status === 'active',
                      }}
                    >
                      {item.status}
                    </span>
                  </div>
                  <div class="text-[var(--ink-primary)] whitespace-pre-wrap break-words">
                    {maskText(item.prompt, privacyMask())}
                  </div>
                  <div class="flex items-center justify-between text-[10.5px] font-mono-num text-[var(--ink-muted)] pt-1 border-t border-[var(--border-subtle)]">
                    <span>budget: NULL</span>
                    <Show when={item.status !== 'done'}>
                      <button
                        type="button"
                        class="omnia-btn px-2 py-0.5 text-[10.5px]"
                        onClick={() => void handleMarkDone(item.id)}
                      >
                        <CheckCircle2 class="w-3 h-3 text-[var(--status-emerald)]" />
                        <span>Complete</span>
                      </button>
                    </Show>
                  </div>
                </div>
              )}
            </For>
          </Show>
        </div>

        <div class="p-3 border-t border-[var(--border-subtle)] bg-[var(--bg-panel)] space-y-2">
          <textarea
            rows={2}
            placeholder="Append additive steer prompt (never cancels unfinished work)..."
            value={draft()}
            onInput={(e) => setDraft(e.currentTarget.value)}
            class="w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2.5 py-1.5 text-[12px] outline-none focus:border-[var(--border-accent)] resize-none"
          />
          <div class="flex items-center gap-2">
            <button
              type="button"
              disabled={busy() || !draft().trim()}
              class="omnia-btn omnia-btn-primary flex-1 justify-center text-[11.5px]"
              onClick={() => void handleEnqueue('queue')}
            >
              <Plus class="w-3.5 h-3.5" />
              <span>Add to Queue</span>
            </button>
            <button
              type="button"
              disabled={busy() || !draft().trim()}
              class="omnia-btn text-[11.5px]"
              onClick={() => void handleEnqueue('steer')}
            >
              <Zap class="w-3.5 h-3.5 text-[var(--accent-amber)]" />
              <span>Steer Now</span>
            </button>
          </div>
        </div>
      </aside>
    </Show>
  );
}
