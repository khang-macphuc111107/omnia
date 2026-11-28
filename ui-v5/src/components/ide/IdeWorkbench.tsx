import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import {
  Bug,
  Check,
  Columns,
  FileCode2,
  FolderTree,
  GitBranch,
  GitCompare,
  GitGraph,
  ListTree,
  Play,
  Plus,
  RefreshCw,
  Save,
  Search,
  Square,
  Terminal as TerminalIcon,
  X,
} from 'lucide-solid';
import { EditorState } from '@codemirror/state';
import { EditorView, highlightActiveLine, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { rust } from '@codemirror/lang-rust';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { json as jsonLang } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { html as htmlLang } from '@codemirror/lang-html';
import { css as cssLang } from '@codemirror/lang-css';
import { oneDark } from '@codemirror/theme-one-dark';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { api } from '@/api/client';
import { Composer } from '@/components/chat/Composer';
import { DiffCard } from '@/components/chat/DiffCard';
import { Transcript } from '@/components/chat/Transcript';
import {
  activeTabPath,
  ideChatDrawerOpen,
  ideGitStatus,
  openTabs,
  privacyMask,
  setActiveTabPath,
  setIdeGitStatus,
  setOpenTabs,
  setWorkspaceRoot,
  setWorkspaceTree,
  themePref,
  workspaceRoot,
  workspaceTree,
} from '@/state/studio';
import type { OpenEditorTab, WorkspaceEntry } from '@/types';
import { renderRichMarkdown } from '@/utils/markdown';
import { maskText } from '@/utils/privacy';

type ActivitySection = 'explorer' | 'search' | 'git' | 'lsp' | 'debug';

function langExtensionForPath(filePath: string) {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.rs')) return rust();
  if (lower.endsWith('.ts') || lower.endsWith('.tsx')) return javascript({ typescript: true, jsx: true });
  if (lower.endsWith('.js') || lower.endsWith('.jsx')) return javascript({ jsx: true });
  if (lower.endsWith('.py')) return python();
  if (lower.endsWith('.json')) return jsonLang();
  if (lower.endsWith('.md')) return markdown();
  if (lower.endsWith('.html')) return htmlLang();
  if (lower.endsWith('.css')) return cssLang();
  return [];
}

function terminalThemeForPref(pref: string) {
  if (pref === 'alabaster') {
    return { background: '#F1EFE8', foreground: '#11141C', cursor: '#0A539B' };
  }
  if (pref === 'titanium') {
    return { background: '#1B1F24', foreground: '#EDF0F2', cursor: '#9AC6D6' };
  }
  if (pref === 'blueprint') {
    return { background: '#081020', foreground: '#EDF5FF', cursor: '#4CC9FF' };
  }
  return { background: '#080A0F', foreground: '#F2F5FA', cursor: '#38BDF8' };
}

export function IdeWorkbench() {
  const [activity, setActivity] = createSignal<ActivitySection>('explorer');
  const [searchQuery, setSearchQuery] = createSignal('');
  const [diffMode, setDiffMode] = createSignal(false);
  const [previewSplit, setPreviewSplit] = createSignal(false);
  const [terminalOpen, setTerminalOpen] = createSignal(true);
  const [gitDiffPatch, setGitDiffPatch] = createSignal('');
  const [lspData, setLspData] = createSignal<Record<string, unknown>>({});
  const [graphJumpData, setGraphJumpData] = createSignal<Record<string, unknown> | null>(null);
  const [dapSessions, setDapSessions] = createSignal<Array<Record<string, unknown>>>([]);
  const [dapAdapter, setDapAdapter] = createSignal('lldb');
  const [dapProgram, setDapProgram] = createSignal('');
  const [dapStatus, setDapStatus] = createSignal('');
  const [termTabs, setTermTabs] = createSignal<Array<{ id: string; label: string }>>([]);
  const [activeTermId, setActiveTermId] = createSignal<string | null>(null);
  const [saveNote, setSaveNote] = createSignal('');
  const [gitWorktrees, setGitWorktrees] = createSignal<
    Array<{
      path: string;
      head?: string;
      branch?: string;
      bare?: boolean;
      detached?: boolean;
      locked?: boolean;
      prunable?: boolean;
    }>
  >([]);
  const [commitMessage, setCommitMessage] = createSignal('');
  const [commitStageAll, setCommitStageAll] = createSignal(true);
  const [commitBusy, setCommitBusy] = createSignal(false);
  const [gitActionNote, setGitActionNote] = createSignal('');

  let editorHostRef: HTMLDivElement | undefined;
  let editorView: EditorView | null = null;
  let termHostRef: HTMLDivElement | undefined;
  let xtermInstance: Terminal | null = null;
  let fitAddon: FitAddon | null = null;
  let wsHandle: ReturnType<typeof api.connectMultiplexedWs> | null = null;

  const activeTab = () => openTabs.find((t) => t.path === activeTabPath()) ?? null;

  const refreshExplorer = async () => {
    const [treeRes, gitRes, dapRes, wtRes] = await Promise.all([
      api.getWorkspaceTree('', 3),
      api.getGitStatus(),
      api.listDapSessions(),
      api.safeJson<{
        ok?: boolean;
        isGitRepo?: boolean;
        worktrees?: Array<{
          path: string;
          head?: string;
          branch?: string;
          bare?: boolean;
          detached?: boolean;
          locked?: boolean;
          prunable?: boolean;
        }>;
      }>('/api/git/worktrees'),
    ]);
    if (treeRes.ok) {
      if (treeRes.data.root) setWorkspaceRoot(treeRes.data.root);
      if (Array.isArray(treeRes.data.entries)) setWorkspaceTree(treeRes.data.entries);
    }
    if (gitRes.ok) {
      setIdeGitStatus(gitRes.data);
    }
    if (dapRes.ok) {
      const list = (dapRes.data.sessions ?? dapRes.data.items) as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(list)) setDapSessions(list);
    }
    if (wtRes.ok && Array.isArray(wtRes.data.worktrees)) {
      setGitWorktrees(wtRes.data.worktrees);
    }
  };

  const handleGitCommit = async () => {
    const msg = commitMessage().trim();
    if (!msg || commitBusy()) return;
    setCommitBusy(true);
    setGitActionNote('Committing...');
    const res = await api.safeJson<{
      ok?: boolean;
      commitSha?: string;
      branch?: string;
      summary?: string;
    }>('/api/git/commit', {
      method: 'POST',
      body: JSON.stringify({
        message: msg,
        stageAll: commitStageAll(),
      }),
    });
    setCommitBusy(false);
    if (res.ok) {
      setCommitMessage('');
      const sha = res.data.commitSha ? String(res.data.commitSha).slice(0, 8) : 'ok';
      const br = res.data.branch ? ` (${res.data.branch})` : '';
      setGitActionNote(`Committed ${sha}${br}${res.data.summary ? ` — ${res.data.summary}` : ''}`);
      await refreshExplorer();
    } else {
      setGitActionNote(`Commit failed (${res.error.code}): ${res.error.message}`);
    }
  };

  const openFile = async (entry: WorkspaceEntry) => {
    if (entry.kind === 'dir') return;
    const existing = openTabs.find((t) => t.path === entry.relativePath);
    if (existing) {
      setActiveTabPath(existing.path);
      return;
    }
    const res = await api.readWorkspaceFile(entry.relativePath);
    const content = res.ok ? res.data.content : `// Failed to read ${entry.relativePath}: ${res.error.message}`;
    const tab: OpenEditorTab = {
      path: entry.relativePath,
      name: entry.name,
      content,
      originalContent: content,
      dirty: false,
    };
    setOpenTabs([...openTabs, tab]);
    setActiveTabPath(tab.path);

    if (ideGitStatus()?.isGitRepo === true) {
      void api.getGitDiff(entry.relativePath).then((d) => {
        if (d.ok) setGitDiffPatch(d.data.diff ?? '');
      });
    } else {
      setGitDiffPatch('');
    }
    void api.queryLsp('outline', entry.relativePath).then((l) => {
      if (l.ok) setLspData(l.data);
    });
  };

  const openRelativePath = async (relPath: string) => {
    const clean = relPath.trim();
    if (!clean) return;
    const name = clean.split(/[\\/]/).pop() || clean;
    await openFile({ name, path: clean, relativePath: clean, kind: 'file', bytes: 0, depth: 0 });
  };

  const saveActiveTab = async () => {
    const tab = activeTab();
    if (!tab) return;
    const res = await api.writeWorkspaceFile(tab.path, tab.content);
    if (res.ok) {
      setOpenTabs((t) => t.path === tab.path, { dirty: false, originalContent: tab.content });
      setSaveNote(`Saved ${tab.name}`);
      setTimeout(() => setSaveNote(''), 1800);
    } else {
      setSaveNote(`Save error: ${res.error.message}`);
    }
  };

  const acceptDiff = async () => {
    await saveActiveTab();
    setDiffMode(false);
  };

  const rejectDiff = () => {
    const tab = activeTab();
    if (!tab) return;
    setOpenTabs((t) => t.path === tab.path, { content: tab.originalContent, dirty: false });
    setDiffMode(false);
  };

  const spawnTerminalTab = async () => {
    const cols = xtermInstance?.cols ?? 100;
    const rows = xtermInstance?.rows ?? 24;
    const res = await api.createTerminal(workspaceRoot() || undefined, cols, rows);
    if (res.ok) {
      const id = res.data.terminal?.ptyId ?? res.data.ptyId ?? res.data.id ?? res.data.terminal_id ?? null;
      if (id) {
        const nextNum = termTabs().length + 1;
        setTermTabs([...termTabs(), { id, label: `PTY #${nextNum}` }]);
        setActiveTermId(id);
        xtermInstance?.writeln(`\r\n[Connected ConPTY ${id}]`);
      }
    } else {
      xtermInstance?.writeln(`\r\n[ConPTY error: ${res.error.code} — ${res.error.message}]`);
    }
  };

  const killTerminalTab = async (id: string) => {
    await api.killTerminal(id);
    const remaining = termTabs().filter((t) => t.id !== id);
    setTermTabs(remaining);
    if (activeTermId() === id) {
      setActiveTermId(remaining[0]?.id ?? null);
    }
  };

  const handleLspAction = async (action: 'problems' | 'outline' | 'hover' | 'definition') => {
    const res = await api.queryLsp(action, activeTabPath() ?? undefined, 1, 0);
    if (res.ok) {
      setLspData(res.data);
    } else {
      setLspData({ error: res.error.code, message: res.error.message });
    }
  };

  const handleGraphifyJump = async () => {
    const target = activeTab()?.name.replace(/\.[^.]+$/, '') || 'omnia-studio';
    const res = await api.traverseGraphify(target, 'both', 2);
    if (res.ok) {
      setGraphJumpData(res.data);
    } else {
      setGraphJumpData({ error: res.error.code, message: res.error.message });
    }
  };

  const handleLaunchDap = async () => {
    const prog = dapProgram().trim() || activeTabPath() || 'omnia-cli';
    const res = await api.launchDap(dapAdapter(), prog, workspaceRoot() || undefined);
    if (res.ok) {
      setDapStatus(`Launched ${dapAdapter()} on ${prog}`);
      const list = await api.listDapSessions();
      if (list.ok && Array.isArray(list.data.sessions)) {
        setDapSessions(list.data.sessions as Array<Record<string, unknown>>);
      }
    } else {
      setDapStatus(`DAP (${res.error.code}): ${res.error.message}`);
    }
  };

  const handleTerminateDap = async (sessionId: string) => {
    const res = await api.terminateDap(sessionId);
    setDapStatus(res.ok ? `Terminated DAP ${sessionId}` : `Terminate error: ${res.error.message}`);
    const list = await api.listDapSessions();
    if (list.ok && Array.isArray(list.data.sessions)) {
      setDapSessions(list.data.sessions as Array<Record<string, unknown>>);
    }
  };

  const changedGitFiles = createMemo(() => {
    const st = ideGitStatus();
    const arr = (st.files ?? st.changedFiles ?? st.modified ?? []) as unknown[];
    return Array.isArray(arr)
      ? arr.map((f) => (typeof f === 'string' ? f : String((f as Record<string, unknown>).path ?? '')))
      : [];
  });

  // Mount/update CodeMirror 6 instance when active tab or theme changes
  createEffect(() => {
    const tab = activeTab();
    const theme = themePref();
    if (!editorHostRef) return;

    editorView?.destroy();
    editorView = null;
    if (!tab) return;

    const extensions = [
      lineNumbers(),
      highlightActiveLine(),
      history(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      langExtensionForPath(tab.path),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          const val = update.state.doc.toString();
          setOpenTabs((t) => t.path === tab.path, {
            content: val,
            dirty: val !== tab.originalContent,
          });
        }
      }),
      EditorView.theme({
        '&': { height: '100%', fontSize: '13px', fontFamily: '"JetBrains Mono", Consolas, monospace' },
        '.cm-scroller': { overflow: 'auto' },
      }),
    ];
    if (theme !== 'alabaster') {
      extensions.push(oneDark);
    }

    editorView = new EditorView({
      state: EditorState.create({ doc: tab.content, extensions }),
      parent: editorHostRef,
    });
  });

  // Keep xterm.js palette synced with all 4 WCAG themes
  createEffect(() => {
    const pref = themePref();
    if (xtermInstance) {
      xtermInstance.options.theme = terminalThemeForPref(pref);
    }
  });

  // Mount WebGL/Canvas ConPTY xterm.js terminal
  onMount(() => {
    void refreshExplorer();

    if (termHostRef) {
      const term = new Terminal({
        fontFamily: '"JetBrains Mono", "Cascadia Mono", Consolas, monospace',
        fontSize: 12.5,
        cursorBlink: true,
        theme: terminalThemeForPref(themePref()),
      });
      fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(termHostRef);
      try {
        term.loadAddon(new WebglAddon());
      } catch {
        // Software canvas fallback in headless environments
      }
      fitAddon.fit();
      xtermInstance = term;
      term.writeln('Omnia ConPTY Multi-Tab Terminal ready (pure-Rust PTY host).');

      wsHandle = api.connectMultiplexedWs(
        (msg) => {
          if (msg.channel === 'pty' && typeof msg.payload === 'object' && msg.payload) {
            const data = (msg.payload as Record<string, unknown>).data;
            if (typeof data === 'string') term.write(data);
          } else if (msg.channel === 'workspace' && msg.event === 'lsp_diagnostics') {
            setLspData(msg.payload as Record<string, unknown>);
          }
        },
        (bytes) => {
          const payload = bytes[0] === 0x01 ? bytes.slice(1) : bytes;
          term.write(new TextDecoder().decode(payload));
        },
      );

      term.onData((data) => {
        const id = activeTermId();
        if (id && wsHandle) {
          wsHandle.sendPtyStdin(id, data);
        }
      });

      void spawnTerminalTab();
    }
  });

  onCleanup(() => {
    editorView?.destroy();
    xtermInstance?.dispose();
    wsHandle?.close();
  });

  return (
    <div data-testid="ide-workbench" class="flex-1 min-h-0 flex overflow-hidden bg-[var(--bg-canvas)]">
      {/* VS Code Activity Bar */}
      <div class="w-11 shrink-0 bg-[var(--bg-rail)] border-r border-[var(--border-subtle)] flex flex-col items-center py-2 gap-1.5">
        {(
          [
            { id: 'explorer', label: 'Explorer (.gitignore aware)', icon: FolderTree },
            { id: 'search', label: 'Search Workspace', icon: Search },
            { id: 'git', label: 'Git & git_forensics', icon: GitCompare },
            { id: 'lsp', label: 'LSP + Tree-sitter + Graphify', icon: ListTree },
            { id: 'debug', label: 'Run & Debug (DAP)', icon: Bug },
          ] as const
        ).map((item) => {
          const IconComp = item.icon;
          return (
            <button
              type="button"
              title={item.label}
              onClick={() => setActivity(item.id)}
              class="w-8 h-8 rounded flex items-center justify-center cursor-pointer border"
              classList={{
                'bg-[var(--bg-elevated)] text-[var(--accent-cyan)] border-[var(--border-accent)]':
                  activity() === item.id,
                'text-[var(--ink-muted)] hover:text-[var(--ink-primary)] border-transparent':
                  activity() !== item.id,
              }}
            >
              <IconComp class="w-4 h-4" />
            </button>
          );
        })}
        <div class="mt-auto">
          <button
            type="button"
            title="Toggle Multi-Tab ConPTY Terminal"
            onClick={() => setTerminalOpen(!terminalOpen())}
            class="w-8 h-8 rounded flex items-center justify-center cursor-pointer border"
            classList={{
              'bg-[var(--bg-elevated)] text-[var(--accent-amber)] border-[var(--border-subtle)]':
                terminalOpen(),
              'text-[var(--ink-muted)] border-transparent': !terminalOpen(),
            }}
          >
            <TerminalIcon class="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Left IDE Drawer */}
      <div class="w-60 shrink-0 border-r border-[var(--border-subtle)] bg-[var(--bg-panel)] flex flex-col overflow-hidden">
        <div class="px-3 py-2 border-b border-[var(--border-subtle)] flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-[var(--ink-secondary)]">
          <span>{activity()}</span>
          <button type="button" class="omnia-btn px-1.5 py-0.5" onClick={() => void refreshExplorer()}>
            <RefreshCw class="w-3 h-3" />
          </button>
        </div>

        <div class="flex-1 overflow-y-auto p-2 text-[12px]">
          <Show when={activity() === 'explorer'}>
            <div class="space-y-0.5">
              <For each={workspaceTree}>
                {(entry) => (
                  <button
                    type="button"
                    onClick={() => void openFile(entry)}
                    style={{ 'padding-left': `${8 + entry.depth * 12}px` }}
                    class="w-full text-left py-1 pr-2 rounded hover:bg-[var(--bg-elevated)] flex items-center gap-1.5 truncate cursor-pointer text-[var(--ink-secondary)]"
                  >
                    <FileCode2 class="w-3.5 h-3.5 shrink-0 text-[var(--accent-cyan)]" />
                    <span class="truncate">{entry.name}</span>
                  </button>
                )}
              </For>
              <Show when={workspaceTree.length === 0}>
                <div class="p-2 text-[var(--ink-muted)] text-[11.5px]">
                  Click Refresh to load `.gitignore`-filtered workspace tree from `/api/workspace/tree`.
                </div>
              </Show>
            </div>
          </Show>

          <Show when={activity() === 'search'}>
            <div class="space-y-2">
              <input
                type="text"
                placeholder="Filter workspace files..."
                value={searchQuery()}
                onInput={(e) => setSearchQuery(e.currentTarget.value)}
                class="w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1 text-[12px] outline-none"
              />
              <For each={workspaceTree.filter((e) => e.name.toLowerCase().includes(searchQuery().toLowerCase())).slice(0, 50)}>
                {(entry) => (
                  <button
                    type="button"
                    onClick={() => void openFile(entry)}
                    class="w-full text-left px-2 py-1 rounded hover:bg-[var(--bg-elevated)] text-[11.5px] font-mono-num truncate cursor-pointer"
                  >
                    {entry.relativePath}
                  </button>
                )}
              </For>
            </div>
          </Show>

          <Show when={activity() === 'git'}>
            <div class="space-y-2 text-[11.5px] font-mono-num">
              <div class="p-2 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] space-y-0.5">
                <div>Branch: <strong class="text-[var(--accent-cyan)]">{String(ideGitStatus()?.branch ?? 'unknown')}</strong></div>
                <div>Dirty: {changedGitFiles().length} files · Worktrees: {gitWorktrees().length}</div>
              </div>

              {/* 1-Click Git Commit Bar */}
              <div
                data-testid="ide-git-commit-bar"
                class="p-2 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] space-y-1.5 font-sans"
              >
                <div class="text-[10.5px] font-semibold uppercase tracking-wider text-[var(--ink-secondary)]">
                  1-Click Commit
                </div>
                <input
                  type="text"
                  data-testid="ide-git-commit-input"
                  placeholder="Commit message (type(scope): summary)..."
                  value={commitMessage()}
                  onInput={(e) => setCommitMessage(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void handleGitCommit();
                    }
                  }}
                  class="w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-panel)] px-2 py-1 text-[11.5px] outline-none"
                />
                <div class="flex items-center justify-between gap-2">
                  <label class="flex items-center gap-1 text-[10.5px] text-[var(--ink-secondary)] cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={commitStageAll()}
                      onChange={(e) => setCommitStageAll(e.currentTarget.checked)}
                    />
                    <span>Stage all</span>
                  </label>
                  <button
                    type="button"
                    data-testid="ide-git-commit-btn"
                    disabled={commitBusy() || !commitMessage().trim()}
                    onClick={() => void handleGitCommit()}
                    class="omnia-btn omnia-btn-primary px-2 py-0.5 text-[10.5px]"
                  >
                    <Check class="w-3 h-3" />
                    <span>{commitBusy() ? 'Committing...' : 'Commit'}</span>
                  </button>
                </div>
                <Show when={gitActionNote()}>
                  <div class="text-[10.5px] font-mono-num text-[var(--status-emerald)] break-words">
                    {maskText(gitActionNote(), privacyMask())}
                  </div>
                </Show>
              </div>

              {/* Active Worktrees */}
              <Show when={gitWorktrees().length > 0}>
                <div
                  data-testid="ide-git-worktrees"
                  class="p-2 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] space-y-1"
                >
                  <div class="text-[10.5px] font-semibold uppercase tracking-wider text-[var(--ink-secondary)] flex items-center gap-1 font-sans">
                    <GitBranch class="w-3 h-3 text-[var(--accent-cyan)]" />
                    <span>Worktrees ({gitWorktrees().length})</span>
                  </div>
                  <div class="space-y-1 max-h-32 overflow-y-auto">
                    <For each={gitWorktrees()}>
                      {(wt) => (
                        <div class="px-1.5 py-1 rounded bg-[var(--bg-panel)] border border-[var(--border-subtle)] text-[10.5px]">
                          <div class="flex items-center justify-between gap-1">
                            <span class="font-semibold text-[var(--accent-cyan)] truncate">
                              {wt.branch || (wt.detached ? 'detached' : wt.bare ? 'bare' : 'HEAD')}
                            </span>
                            <span class="text-[9.5px] text-[var(--ink-muted)] shrink-0">
                              {wt.head ? wt.head.slice(0, 7) : ''}
                              {wt.locked ? ' · locked' : ''}
                            </span>
                          </div>
                          <div class="text-[10px] text-[var(--ink-muted)] truncate">
                            {maskText(wt.path, privacyMask())}
                          </div>
                        </div>
                      )}
                    </For>
                  </div>
                </div>
              </Show>

              <For each={changedGitFiles().slice(0, 40)}>
                {(file) => (
                  <button
                    type="button"
                    onClick={async () => {
                      await openRelativePath(file);
                      setDiffMode(true);
                    }}
                    class="w-full text-left px-2 py-1 rounded hover:bg-[var(--bg-elevated)] text-[11px] truncate text-[var(--accent-amber)] cursor-pointer"
                  >
                    {maskText(file, privacyMask())}
                  </button>
                )}
              </For>
              <pre class="whitespace-pre-wrap text-[10.5px] text-[var(--ink-muted)]">
                {JSON.stringify(ideGitStatus(), null, 2)}
              </pre>
            </div>
          </Show>

          <Show when={activity() === 'lsp'}>
            <div class="space-y-2 text-[11.5px] font-mono-num">
              <div class="grid grid-cols-2 gap-1">
                <button type="button" class="omnia-btn justify-center text-[10.5px]" onClick={() => void handleLspAction('problems')}>
                  Problems
                </button>
                <button type="button" class="omnia-btn justify-center text-[10.5px]" onClick={() => void handleLspAction('outline')}>
                  Outline
                </button>
                <button type="button" class="omnia-btn justify-center text-[10.5px]" onClick={() => void handleLspAction('hover')}>
                  Hover
                </button>
                <button type="button" class="omnia-btn justify-center text-[10.5px]" onClick={() => void handleLspAction('definition')}>
                  Definition
                </button>
              </div>
              <button
                type="button"
                class="omnia-btn omnia-btn-primary w-full justify-center text-[11px]"
                onClick={() => void handleGraphifyJump()}
              >
                <GitGraph class="w-3.5 h-3.5" />
                <span>Tree-sitter + Graphify Jump</span>
              </button>
              <Show when={graphJumpData()}>
                <pre class="p-2 rounded bg-[var(--bg-code)] border border-[var(--border-subtle)] whitespace-pre-wrap text-[10.5px] max-h-40 overflow-auto">
                  {JSON.stringify(graphJumpData(), null, 2)}
                </pre>
              </Show>
              <pre class="p-2 rounded bg-[var(--bg-code)] border border-[var(--border-subtle)] whitespace-pre-wrap text-[10.5px] text-[var(--ink-secondary)] max-h-60 overflow-auto">
                {JSON.stringify(lspData(), null, 2)}
              </pre>
            </div>
          </Show>

          <Show when={activity() === 'debug'}>
            <div class="space-y-2 text-[11.5px]">
              <div class="text-[var(--ink-muted)] font-mono-num">Real DAP Adapters (`/api/dap/*`)</div>
              <select
                value={dapAdapter()}
                onChange={(e) => setDapAdapter(e.currentTarget.value)}
                class="w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1 text-[11.5px]"
              >
                <option value="lldb">lldb-dap (Rust / Native)</option>
                <option value="debugpy">debugpy (Python)</option>
                <option value="dlv">dlv (Go)</option>
              </select>
              <input
                type="text"
                placeholder="Target binary or script..."
                value={dapProgram()}
                onInput={(e) => setDapProgram(e.currentTarget.value)}
                class="w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1 text-[11.5px] font-mono-num"
              />
              <button
                type="button"
                data-testid="dap-launch-btn"
                class="omnia-btn omnia-btn-primary w-full justify-center text-[11.5px]"
                onClick={() => void handleLaunchDap()}
              >
                <Play class="w-3.5 h-3.5" />
                <span>Launch DAP Session</span>
              </button>
              <Show when={dapStatus()}>
                <div class="text-[11px] font-mono-num text-[var(--accent-cyan)]">{dapStatus()}</div>
              </Show>
              <div class="space-y-1 pt-1 border-t border-[var(--border-subtle)]">
                <For each={dapSessions()}>
                  {(s) => {
                    const sid = String(s.sessionId ?? s.id ?? 'dap');
                    return (
                      <div class="p-2 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] flex items-center justify-between gap-1 text-[11px] font-mono-num">
                        <span class="truncate">{String(s.adapter ?? 'dap')} · {sid.slice(0, 8)}</span>
                        <button
                          type="button"
                          class="omnia-btn omnia-btn-danger px-1.5 py-0.5 text-[10px]"
                          onClick={() => void handleTerminateDap(sid)}
                        >
                          <Square class="w-2.5 h-2.5" />
                        </button>
                      </div>
                    );
                  }}
                </For>
              </div>
            </div>
          </Show>
        </div>
      </div>

      {/* Center Multi-Tab CodeMirror 6 + Diff + Preview + Bottom Multi-Tab ConPTY Terminal */}
      <div class="flex-1 min-w-0 flex flex-col overflow-hidden">
        {/* Editor Tabs & Actions */}
        <div class="h-9 shrink-0 bg-[var(--bg-rail)] border-b border-[var(--border-subtle)] flex items-center justify-between px-2 gap-2">
          <div class="flex items-center gap-1 overflow-x-auto min-w-0">
            <For each={openTabs}>
              {(tab) => (
                <div
                  onClick={() => setActiveTabPath(tab.path)}
                  class="flex items-center gap-1.5 px-2.5 py-1 rounded text-[12px] cursor-pointer border shrink-0"
                  classList={{
                    'bg-[var(--bg-canvas)] text-[var(--ink-primary)] border-[var(--border-accent)]':
                      activeTabPath() === tab.path,
                    'bg-[var(--bg-panel)] text-[var(--ink-muted)] border-transparent':
                      activeTabPath() !== tab.path,
                  }}
                >
                  <span>
                    {tab.name}
                    {tab.dirty ? ' *' : ''}
                  </span>
                  <button
                    type="button"
                    class="hover:text-[var(--status-coral)]"
                    onClick={(e) => {
                      e.stopPropagation();
                      const next = openTabs.filter((t) => t.path !== tab.path);
                      setOpenTabs(next);
                      if (activeTabPath() === tab.path) setActiveTabPath(next[0]?.path ?? null);
                    }}
                  >
                    <X class="w-3 h-3" />
                  </button>
                </div>
              )}
            </For>
          </div>

          <div class="flex items-center gap-1.5 shrink-0">
            <Show when={saveNote()}>
              <span class="text-[11px] font-mono-num text-[var(--status-emerald)]">{saveNote()}</span>
            </Show>
            <button
              type="button"
              data-testid="ide-worktree-pill"
              class="omnia-btn text-[10.5px] font-mono-num"
              title="Open Git Commit & Worktrees panel"
              onClick={() => setActivity('git')}
            >
              <GitBranch class="w-3 h-3 text-[var(--accent-cyan)]" />
              <span class="max-w-[110px] truncate">{String(ideGitStatus()?.branch ?? 'git')}</span>
              <Show when={gitWorktrees().length > 0}>
                <span class="text-[var(--ink-muted)]">({gitWorktrees().length} wt)</span>
              </Show>
            </button>
            <button type="button" class="omnia-btn text-[11px]" onClick={() => setDiffMode(!diffMode())}>
              <GitCompare class="w-3.5 h-3.5 text-[var(--accent-amber)]" />
              <span>Diff</span>
            </button>
            <button type="button" class="omnia-btn text-[11px]" onClick={() => setPreviewSplit(!previewSplit())}>
              <Columns class="w-3.5 h-3.5 text-[var(--accent-cyan)]" />
              <span>Preview</span>
            </button>
            <button type="button" class="omnia-btn omnia-btn-primary text-[11px]" onClick={() => void saveActiveTab()}>
              <Save class="w-3.5 h-3.5" />
              <span>Save</span>
            </button>
          </div>
        </div>

        {/* Editor / Diff / Live Preview Area */}
        <div class="flex-1 min-h-0 flex overflow-hidden">
          <div class="flex-1 min-w-0 relative overflow-hidden">
            <Show when={diffMode()}>
              <div class="absolute inset-0 z-10 bg-[var(--bg-canvas)] overflow-y-auto p-3">
                <div class="flex items-center justify-between mb-2">
                  <span class="text-[12px] font-semibold">Inline Hunk Review</span>
                  <div class="flex gap-2">
                    <button type="button" class="omnia-btn omnia-btn-primary text-[11px]" onClick={() => void acceptDiff()}>
                      <Check class="w-3.5 h-3.5" />
                      <span>Accept All</span>
                    </button>
                    <button type="button" class="omnia-btn omnia-btn-danger text-[11px]" onClick={rejectDiff}>
                      Reject
                    </button>
                  </div>
                </div>
                <Show
                  when={gitDiffPatch().trim().length > 0}
                  fallback={
                    <div class="p-4 rounded border border-[var(--border-subtle)] bg-[var(--bg-panel)] text-[12px] font-mono-num text-[var(--ink-muted)]">
                      Working copy matches HEAD for {activeTabPath() || 'active file'} (0 uncommitted diff hunks).
                    </div>
                  }
                >
                  <DiffCard patch={gitDiffPatch()} path={activeTabPath() ?? undefined} />
                </Show>
              </div>
            </Show>
            <div ref={editorHostRef} class="h-full w-full" classList={{ hidden: !activeTab() }} />
            <Show when={!activeTab()}>
              <div class="h-full flex items-center justify-center text-[13px] text-[var(--ink-muted)]">
                Select a file from Explorer or ask the Chat/Builder sidebar to open or edit files.
              </div>
            </Show>
          </div>

          <Show when={previewSplit() && activeTab()}>
            {(tab) => (
              <div class="w-1/2 border-l border-[var(--border-subtle)] bg-[var(--bg-panel)] overflow-y-auto p-4">
                <div class="text-[11px] font-mono-num text-[var(--ink-muted)] mb-2 uppercase">
                  Live Preview — {tab().name}
                </div>
                <Show
                  when={tab().name.endsWith('.html')}
                  fallback={<div class="omnia-prose" innerHTML={renderRichMarkdown(tab().content)} />}
                >
                  <iframe
                    sandbox=""
                    srcdoc={tab().content}
                    class="w-full h-[70vh] rounded border border-[var(--border-subtle)] bg-white"
                  />
                </Show>
              </div>
            )}
          </Show>
        </div>

        {/* Bottom Multi-Tab ConPTY Terminal (Theme-Synced) */}
        <Show when={terminalOpen()}>
          <div class="h-52 shrink-0 border-t border-[var(--border-subtle)] bg-[var(--bg-code)] flex flex-col">
            <div class="h-7 px-2 border-b border-[var(--border-subtle)] bg-[var(--bg-rail)] flex items-center justify-between gap-2 text-[11px] font-mono-num">
              <div class="flex items-center gap-1 overflow-x-auto min-w-0">
                <For each={termTabs()}>
                  {(t) => (
                    <div
                      onClick={() => setActiveTermId(t.id)}
                      class="flex items-center gap-1 px-2 py-0.5 rounded border cursor-pointer shrink-0"
                      classList={{
                        'bg-[var(--bg-elevated)] border-[var(--border-accent)] text-[var(--accent-cyan)]':
                          activeTermId() === t.id,
                        'bg-transparent border-transparent text-[var(--ink-muted)]': activeTermId() !== t.id,
                      }}
                    >
                      <span>{t.label}</span>
                      <button
                        type="button"
                        class="hover:text-[var(--status-coral)]"
                        onClick={(e) => {
                          e.stopPropagation();
                          void killTerminalTab(t.id);
                        }}
                      >
                        <X class="w-2.5 h-2.5" />
                      </button>
                    </div>
                  )}
                </For>
                <button
                  type="button"
                  class="omnia-btn px-1.5 py-0.5 text-[10px]"
                  title="New ConPTY Terminal Tab"
                  onClick={() => void spawnTerminalTab()}
                >
                  <Plus class="w-3 h-3" />
                </button>
              </div>
              <button type="button" class="omnia-btn px-2 py-0.5 text-[10px] shrink-0" onClick={() => fitAddon?.fit()}>
                Fit
              </button>
            </div>
            <div ref={termHostRef} class="flex-1 min-h-0 p-1" />
          </div>
        </Show>
      </div>

      {/* Collapsible Chat & Agent Sidebar inside IDE Mode */}
      <Show when={ideChatDrawerOpen()}>
        <div
          data-testid="ide-chat-sidebar"
          class="w-96 shrink-0 border-l border-[var(--border-subtle)] bg-[var(--bg-rail)] flex flex-col min-h-0"
        >
          <div class="px-3 py-2 border-b border-[var(--border-subtle)] text-[11.5px] font-semibold flex items-center justify-between">
            <span>Agent Sidebar (Chat / Builder / SOLO)</span>
          </div>
          <Transcript compact={true} />
          <Composer />
        </div>
      </Show>
    </div>
  );
}
