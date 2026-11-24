import { createEffect, createSignal, onCleanup } from 'solid-js';
import { FileDiff, parsePatchFiles } from '@pierre/diffs';
import { themePref } from '@/state/studio';

export function DiffCard(props: { patch: string; path?: string }) {
  let hostRef: HTMLDivElement | undefined;
  const [fallbackMode, setFallbackMode] = createSignal(false);

  createEffect(() => {
    const patch = props.patch;
    const theme = themePref();
    if (!hostRef || !patch) return;

    let instance: FileDiff | null = null;
    try {
      const parsed = parsePatchFiles(patch);
      const firstFile = parsed?.[0]?.files?.[0];
      if (!firstFile) {
        setFallbackMode(true);
        return;
      }
      setFallbackMode(false);
      hostRef.innerHTML = '';
      instance = new FileDiff({
        theme: theme === 'alabaster' ? 'github-light' : 'github-dark',
        diffStyle: 'unified',
        overflow: 'wrap',
        disableFileHeader: false,
      });
      instance.render({
        fileDiff: firstFile,
        fileContainer: hostRef,
      });
    } catch {
      setFallbackMode(true);
    }

    onCleanup(() => {
      try {
        instance?.cleanUp();
      } catch {
        // ignore cleanup error
      }
    });
  });

  return (
    <div class="mt-2 rounded border border-[var(--border-subtle)] bg-[var(--bg-code)] overflow-hidden">
      <div class="flex items-center justify-between px-2.5 py-1 border-b border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[11px] font-mono-num text-[var(--ink-secondary)]">
        <span>{props.path || 'patch diff'}</span>
        <span class="text-[var(--ink-muted)]">@pierre/diffs</span>
      </div>
      <div ref={hostRef} class="text-xs overflow-x-auto" classList={{ hidden: fallbackMode() }} />
      {fallbackMode() && (
        <pre class="p-2.5 text-[11.5px] font-mono-num overflow-x-auto m-0 leading-relaxed">
          {props.patch.split(/\r?\n/).map((line) => (
            <div
              classList={{
                'text-[var(--status-emerald)] bg-[var(--status-emerald-dim)]': line.startsWith('+') && !line.startsWith('+++'),
                'text-[var(--status-coral)] bg-[var(--status-coral-dim)]': line.startsWith('-') && !line.startsWith('---'),
                'text-[var(--accent-cyan)]': line.startsWith('@@'),
                'text-[var(--ink-secondary)]': !line.startsWith('+') && !line.startsWith('-') && !line.startsWith('@@'),
              }}
            >
              {line}
            </div>
          ))}
        </pre>
      )}
    </div>
  );
}
