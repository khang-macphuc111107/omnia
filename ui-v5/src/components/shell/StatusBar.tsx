import { Show, createMemo } from 'solid-js';
import { composerDraft, globalNotice, health, modelConfig, privacyMask, topMode } from '@/state/studio';
import { sha256HexSync } from '@/utils/crypto';
import { maskText } from '@/utils/privacy';

export function StatusBar() {
  const draftStats = createMemo(() => {
    const text = composerDraft();
    const bytes = new TextEncoder().encode(text).length;
    const digest = text ? sha256HexSync(text).slice(0, 10) : '0000000000';
    return { bytes, digest };
  });

  return (
    <footer
      data-testid="studio-status-bar"
      class="omnia-statusbar h-7 px-3 flex items-center justify-between gap-3 text-[11px] font-mono-num text-[var(--ink-muted)] select-none overflow-hidden"
    >
      <div class="flex items-center gap-2 min-w-0 flex-1 overflow-hidden">
        <span class="text-[var(--ink-secondary)] uppercase font-semibold shrink-0">{topMode()}</span>
        <span class="shrink-0">|</span>
        <span class="truncate max-w-[160px]">
          branch:{maskText(health.branch || 'omnia-sota-harness', privacyMask())}
        </span>
        <span class="hidden md:inline shrink-0">|</span>
        <span class="hidden md:inline truncate max-w-[260px]">
          main:{modelConfig.mainModel} [{modelConfig.mainEffort}]
        </span>
        <Show when={globalNotice()}>
          <span class="hidden lg:inline shrink-0">|</span>
          <span class="hidden lg:inline truncate text-[var(--accent-cyan)]">
            {maskText(globalNotice(), privacyMask())}
          </span>
        </Show>
      </div>

      <div class="flex items-center gap-2 shrink-0 whitespace-nowrap">
        <Show when={privacyMask()}>
          <span data-testid="status-privacy-pill" class="text-[var(--accent-amber)] font-semibold">
            MASK:ON
          </span>
        </Show>
        <span>draft:{draftStats().bytes}B</span>
        <span class="hidden md:inline">sha256:{draftStats().digest}</span>
        <span class="text-[var(--status-emerald)]">budget:UNBOUNDED</span>
      </div>
    </footer>
  );
}
