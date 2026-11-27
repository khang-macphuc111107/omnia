import { For, Show, createEffect, createSignal, onMount } from 'solid-js';
import { Download, FileSpreadsheet, FileText, GitCompare, KeyRound, Plus, ShieldCheck, Trash2 } from 'lucide-solid';
import { api } from '@/api/client';
import { privacyMask, triggerV5Export } from '@/state/studio';
import { maskJson, maskSensitiveField } from '@/utils/privacy';

export function VaultDiffExportPanel(props: { refreshSeq: number }) {
  // CredMan state
  const [credentials, setCredentials] = createSignal<
    Array<{ target: string; kind: string; label: string; maskedHint: string }>
  >([]);
  const [credTarget, setCredTarget] = createSignal('');
  const [credKind, setCredKind] = createSignal('api_key');
  const [credLabel, setCredLabel] = createSignal('');
  const [credValue, setCredValue] = createSignal('');
  const [credNote, setCredNote] = createSignal('');

  // Side-by-side Diff state
  const [diffKind, setDiffKind] = createSignal<'sessions' | 'speedtests' | 'models' | 'benchmarks'>('sessions');
  const [leftId, setLeftId] = createSignal('');
  const [rightId, setRightId] = createSignal('');
  const [diffData, setDiffData] = createSignal<Record<string, unknown> | null>(null);
  const [diffNote, setDiffNote] = createSignal('');

  const loadCreds = async () => {
    const cRes = await api.listCredentials(privacyMask());
    if (cRes.ok && Array.isArray(cRes.data.credentials)) {
      setCredentials(
        cRes.data.credentials.map((c) => ({
          target: c.target,
          kind: c.kind || 'api_key',
          label: c.label || c.target,
          maskedHint: String(c.maskedHint ?? c.masked_hint ?? '••••'),
        })),
      );
    }
  };

  onMount(() => {
    void loadCreds();
  });

  createEffect(() => {
    props.refreshSeq;
    privacyMask();
    void loadCreds();
  });

  const handleSaveCred = async () => {
    if (!credTarget().trim() || !credValue().trim()) {
      setCredNote('Target and secret value are required.');
      return;
    }
    const res = await api.saveCredential(
      credTarget().trim(),
      credKind(),
      credLabel().trim() || credTarget().trim(),
      credValue(),
    );
    setCredValue('');
    if (res.ok) {
      setCredNote(`Saved credential target "${credTarget().trim()}" into Windows Credential Manager`);
      setCredTarget('');
      setCredLabel('');
      await loadCreds();
    } else {
      setCredNote(`Save error (${res.error.code}): ${res.error.message}`);
    }
  };

  const handleDeleteCred = async (target: string) => {
    const res = await api.deleteCredential(target);
    if (res.ok) {
      setCredNote(`Deleted "${target}"`);
      await loadCreds();
    } else {
      setCredNote(`Delete error (${res.error.code}): ${res.error.message}`);
    }
  };

  const handleRunDiff = async () => {
    const res = await api.getDiff(diffKind(), leftId().trim(), rightId().trim(), privacyMask());
    if (res.ok) {
      setDiffData(res.data);
      setDiffNote(`Loaded ${diffKind()} comparison`);
    } else {
      setDiffNote(`Diff error (${res.error.code}): ${res.error.message}`);
    }
  };

  return (
    <div data-testid="obs-vault-panel" class="space-y-4">
      {/* One-Click Exports Strip (Honors Privacy Mask) */}
      <div class="omnia-surface-panel rounded-lg p-4 space-y-2.5">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="font-bold text-[13.5px] flex items-center gap-2">
            <Download class="w-4 h-4 text-[var(--accent-cyan)]" />
            <span>One-Click Observatory Exports</span>
          </div>
          <span
            class="omnia-badge font-mono-num"
            classList={{
              'text-[var(--accent-amber)]': privacyMask(),
              'text-[var(--status-emerald)]': !privacyMask(),
            }}
          >
            <ShieldCheck class="w-3.5 h-3.5" />
            <span>Privacy Mask: {privacyMask() ? 'ON (Masked)' : 'OFF (Raw)'}</span>
          </span>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
          <button
            type="button"
            data-testid="export-json-btn"
            class="omnia-btn justify-center py-2 text-[12px]"
            onClick={() => void triggerV5Export('json')}
          >
            <Download class="w-3.5 h-3.5 text-[var(--accent-cyan)]" />
            <span>Export JSON</span>
          </button>
          <button
            type="button"
            data-testid="export-csv-btn"
            class="omnia-btn justify-center py-2 text-[12px]"
            onClick={() => void triggerV5Export('csv')}
          >
            <FileSpreadsheet class="w-3.5 h-3.5 text-[var(--status-emerald)]" />
            <span>Export CSV</span>
          </button>
          <button
            type="button"
            data-testid="export-md-btn"
            class="omnia-btn justify-center py-2 text-[12px]"
            onClick={() => void triggerV5Export('markdown')}
          >
            <FileText class="w-3.5 h-3.5 text-[var(--accent-amber)]" />
            <span>Markdown Executive Report</span>
          </button>
          <button
            type="button"
            data-testid="export-diag-btn"
            class="omnia-btn omnia-btn-primary justify-center py-2 text-[12px]"
            onClick={() => void triggerV5Export('diagnostic')}
          >
            <ShieldCheck class="w-3.5 h-3.5" />
            <span>Redacted Diagnostic Snapshot</span>
          </button>
        </div>
      </div>

      {/* CredMan Vault + Side-by-Side Diff Viewer */}
      <div class="grid grid-cols-1 xl:grid-cols-2 gap-4">
        {/* Windows Credential Manager */}
        <div class="omnia-surface-panel rounded-lg p-4 space-y-3">
          <div class="flex items-center gap-2 font-bold text-[13.5px]">
            <KeyRound class="w-4 h-4 text-[var(--accent-amber)]" />
            <span>Windows Credential Manager (`omnia:*` · Masked Hints Only)</span>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[12px]">
            <input
              type="text"
              placeholder="Target (e.g. htmustc)"
              value={credTarget()}
              onInput={(e) => setCredTarget(e.currentTarget.value)}
              class="rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2.5 py-1.5"
            />
            <select
              aria-label="Credential Kind"
              value={credKind()}
              onChange={(e) => setCredKind(e.currentTarget.value)}
              class="rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2.5 py-1.5"
            >
              <option value="api_key">API Key</option>
              <option value="bearer">HTTP Auth Header</option>
              <option value="oauth_token">OAuth Credential</option>
              <option value="management_key">Management Key</option>
              <option value="proxy_auth">Proxy Auth</option>
            </select>
            <input
              type="text"
              placeholder="Label"
              value={credLabel()}
              onInput={(e) => setCredLabel(e.currentTarget.value)}
              class="rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2.5 py-1.5"
            />
            <input
              type="password"
              placeholder="Secret value (never echoed)"
              value={credValue()}
              onInput={(e) => setCredValue(e.currentTarget.value)}
              class="rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2.5 py-1.5"
            />
          </div>

          <div class="flex items-center justify-between gap-2">
            <span class="text-[11px] font-mono-num text-[var(--accent-cyan)] truncate">{credNote()}</span>
            <button type="button" class="omnia-btn omnia-btn-primary text-[12px] shrink-0" onClick={() => void handleSaveCred()}>
              <Plus class="w-3.5 h-3.5" />
              <span>Save Credential</span>
            </button>
          </div>

          <div class="space-y-1.5 pt-2 border-t border-[var(--border-subtle)] max-h-64 overflow-y-auto">
            <Show
              when={credentials().length > 0}
              fallback={<div class="text-[11.5px] font-mono-num text-[var(--ink-muted)]">No stored `omnia:*` credentials visible.</div>}
            >
              <For each={credentials()}>
                {(c) => (
                  <div class="p-2.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] flex items-center justify-between gap-2 text-[12px] font-mono-num">
                    <div class="min-w-0 truncate">
                      <span class="font-bold text-[var(--accent-cyan)]">{c.target}</span>{' '}
                      <span class="omnia-badge">{c.kind}</span>{' '}
                      <span>{c.label}</span> ·{' '}
                      <span class="text-[var(--ink-muted)]">{maskSensitiveField(c.maskedHint, privacyMask())}</span>
                    </div>
                    <button
                      type="button"
                      class="omnia-btn omnia-btn-danger px-2 py-0.5 text-[11px] shrink-0"
                      onClick={() => void handleDeleteCred(c.target)}
                    >
                      <Trash2 class="w-3 h-3" />
                    </button>
                  </div>
                )}
              </For>
            </Show>
          </div>
        </div>

        {/* Side-by-Side Diff Viewer */}
        <div class="omnia-surface-panel rounded-lg p-4 space-y-3">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div class="font-bold text-[13.5px] flex items-center gap-2">
              <GitCompare class="w-4 h-4 text-[var(--accent-cyan)]" />
              <span>Side-by-Side Diff Viewer</span>
            </div>
            <div class="omp-segmented text-[11px]">
              {(['sessions', 'speedtests', 'models', 'benchmarks'] as const).map((k) => (
                <button type="button" aria-pressed={diffKind() === k} onClick={() => setDiffKind(k)}>
                  {k}
                </button>
              ))}
            </div>
          </div>

          <div class="flex flex-wrap items-center gap-2 text-[12px]">
            <input
              type="text"
              placeholder="Left ID (A, optional = latest)"
              value={leftId()}
              onInput={(e) => setLeftId(e.currentTarget.value)}
              class="flex-1 min-w-[120px] rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2.5 py-1.5 font-mono-num"
            />
            <span class="text-[var(--ink-muted)]">vs</span>
            <input
              type="text"
              placeholder="Right ID (B, optional = previous)"
              value={rightId()}
              onInput={(e) => setRightId(e.currentTarget.value)}
              class="flex-1 min-w-[120px] rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2.5 py-1.5 font-mono-num"
            />
            <button type="button" class="omnia-btn omnia-btn-primary text-[11.5px]" onClick={() => void handleRunDiff()}>
              Compare
            </button>
          </div>

          <Show when={diffNote()}>
            <div class="text-[11px] font-mono-num text-[var(--accent-cyan)]">{diffNote()}</div>
          </Show>

          <pre class="p-3 rounded border border-[var(--border-subtle)] bg-[var(--bg-code)] text-[11.5px] font-mono-num max-h-72 overflow-auto whitespace-pre-wrap">
            {JSON.stringify(
              maskJson(
                diffData() ?? {
                  hint: `Select ${diffKind()} A vs B and press Compare to inspect side-by-side metric deltas.`,
                },
                privacyMask(),
              ),
              null,
              2,
            )}
          </pre>
        </div>
      </div>
    </div>
  );
}
