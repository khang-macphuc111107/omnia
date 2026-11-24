import { createMemo } from 'solid-js';
import { composerDraft, health, modelConfig, topMode } from '@/state/studio';
import { sha256HexSync } from '@/utils/crypto';

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
      class="omnia-statusbar h-7 px-3 flex items-center justify-between gap-4 text-[11px] font-mono-num text-[var(--ink-muted)] select-none overflow-hidden"
    >
      <div class="flex items-center gap-2.5 min-w-0 flex-1 overflow-hidden">
        <span class="text-[var(--ink-secondary)] uppercase font-semibold shrink-0">{topMode()}</span>
        <span class="shrink-0">|</span>
        <span class="truncate">branch:{health.branch || 'omnia-sota-harness'}</span>
        <span class="hidden sm:inline shrink-0">|</span>
        <span class="hidden sm:inline truncate">
          main:{modelConfig.mainModel} [{modelConfig.mainEffort}]
        </span>
        <span class="hidden xl:inline shrink-0">|</span>
        <span class="hidden xl:inline truncate">
          sub:{modelConfig.subagentModel} [{modelConfig.subagentEffort}]
        </span>
      </div>

      <div class="flex items-center gap-2.5 shrink-0 whitespace-nowrap">
        <span>draft:{draftStats().bytes}B</span>
        <span class="hidden sm:inline">sha256:{draftStats().digest}</span>
        <span class="text-[var(--status-emerald)]">budget:UNBOUNDED</span>
      </div>
    </footer>
  );
}
