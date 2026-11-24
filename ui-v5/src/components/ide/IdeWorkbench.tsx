import { For, Show, createEffect, createSignal, onCleanup, onMount } from 'solid-js';
import {
  Bug,
  Check,
  Columns,
  FileCode2,
  FolderTree,
  GitCompare,
  ListTree,
  Play,
  RefreshCw,
  Save,
  Search,
  Terminal as TerminalIcon,
  X,
} from 'lucide-solid';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
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
import { DiffCard } from '@/components/chat/DiffCard';
import { Composer } from '@/components/chat/Composer';
import { Transcript } from '@/components/chat/Transcript';
import {
  activeTabPath,
  ideChatDrawerOpen,
  ideGitStatus,
  openTabs,
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

export function IdeWorkbench() {
  const [activity, setActivity] = createSignal<ActivitySection>('explorer');
  const [searchQuery, setSearchQuery] = createSignal('');
  const [diffMode, setDiffMode] = createSignal(false);
  const [previewSplit, setPreviewSplit] = createSignal(false);
  const [terminalOpen, setTerminalOpen] = createSignal(true);
  const [gitDiffPatch, setGitDiffPatch] = createSignal('');
  const [lspData, setLspData] = createSignal<Record<string, unknown>>({});
  const [activeTermId, setActiveTermId] = createSignal<string | null>(null);
  const [saveNote, setSaveNote] = createSignal('');

  let editorHostRef: HTMLDivElement | undefined;
  let editorView: EditorView | null = null;
  let termHostRef: HTMLDivElement | undefined;
  let xtermInstance: Terminal | null = null;
  let fitAddon: FitAddon | null = null;
  let wsHandle: ReturnType<typeof api.connectMultiplexedWs> | null = null;

  const activeTab = () => openTabs.find((t) => t.path === activeTabPath()) ?? null;

  const refreshExplorer = async () => {
    const [treeRes, gitRes] = await Promise.all([api.getWorkspaceTree('', 2), api.getGitStatus()]);
    if (treeRes.ok) {
      if (treeRes.data.root) setWorkspaceRoot(treeRes.data.root);
      if (Array.isArray(treeRes.data.entries)) setWorkspaceTree(treeRes.data.entries);
    }
    if (gitRes.ok) {
      setIdeGitStatus(gitRes.data);
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

    // Fetch diff & LSP outline for this file (skip diff on non-git workspaces)
    if (ideGitStatus()?.isGitRepo === true) {
      void api.getGitDiff(entry.relativePath).then((d) => {
        if (d.ok && d.data.diff) setGitDiffPatch(d.data.diff);
      });
    }
    void api.queryLsp('outline', entry.relativePath).then((l) => {
      if (l.ok) setLspData(l.data);
    });
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

  // Mount WebGL/Canvas ConPTY xterm.js terminal
  onMount(() => {
    void refreshExplorer();

    if (termHostRef) {
      const term = new Terminal({
        fontFamily: '"JetBrains Mono", "Cascadia Mono", Consolas, monospace',
        fontSize: 12.5,
        cursorBlink: true,
        theme: {
          background: '#080A0F',
          foreground: '#F2F5FA',
          cursor: '#38BDF8',
        },
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
      term.writeln('Omnia ConPTY Terminal ready (pure-Rust PTY host).');

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
          // Binary frame [0x01 | pty bytes]
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

      void api.createTerminal(workspaceRoot() || undefined, term.cols, term.rows).then((res) => {
        if (res.ok) {
          const id = res.data.terminal?.ptyId ?? res.data.ptyId ?? res.data.id ?? res.data.terminal_id ?? null;
          if (id) setActiveTermId(id);
        }
      });
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
            { id: 'explorer', label: 'Explorer', icon: FolderTree },
            { id: 'search', label: 'Search', icon: Search },
            { id: 'git', label: 'Source Control', icon: GitCompare },
            { id: 'lsp', label: 'LSP Outline & Problems', icon: ListTree },
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
            title="Toggle ConPTY Terminal"
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
                  Click Refresh to load workspace tree from `/api/workspace/tree`.
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
              <For each={workspaceTree.filter((e) => e.name.toLowerCase().includes(searchQuery().toLowerCase())).slice(0, 40)}>
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
              <pre class="whitespace-pre-wrap text-[var(--ink-secondary)]">
                {JSON.stringify(ideGitStatus(), null, 2)}
              </pre>
            </div>
          </Show>

          <Show when={activity() === 'lsp'}>
            <div class="space-y-2 text-[11.5px] font-mono-num">
              <button
                type="button"
                class="omnia-btn w-full justify-center text-[11px]"
                onClick={() => void api.queryLsp('problems', activeTabPath() ?? undefined).then((r) => r.ok && setLspData(r.data))}
              >
                Query rust-analyzer / LSP
              </button>
              <pre class="whitespace-pre-wrap text-[var(--ink-secondary)]">{JSON.stringify(lspData(), null, 2)}</pre>
            </div>
          </Show>

          <Show when={activity() === 'debug'}>
            <div class="space-y-2 text-[12px]">
              <div class="text-[var(--ink-muted)]">DAP Adapters: debugpy · lldb · dlv</div>
              <button
                type="button"
                class="omnia-btn omnia-btn-primary w-full justify-center text-[11.5px]"
                onClick={() => void api.queryLsp('problems')}
              >
                <Play class="w-3.5 h-3.5" />
                <span>Inspect Debug Targets</span>
              </button>
            </div>
          </Show>
        </div>
      </div>

      {/* Center Multi-Tab CodeMirror 6 + Diff + Preview + Bottom WebGL ConPTY Terminal */}
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
                  <span>{tab.name}{tab.dirty ? ' *' : ''}</span>
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
            <Show when={diffMode() && gitDiffPatch()}>
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
                <DiffCard patch={gitDiffPatch()} path={activeTabPath() ?? undefined} />
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
                <div class="text-[11px] font-mono-num text-[var(--ink-muted)] mb-2 uppercase">Live Preview — {tab().name}</div>
                <Show
                  when={tab().name.endsWith('.html')}
                  fallback={<div class="omnia-prose" innerHTML={renderRichMarkdown(tab().content)} />}
                >
                  <iframe sandbox="" srcdoc={tab().content} class="w-full h-[70vh] rounded border border-[var(--border-subtle)] bg-white" />
                </Show>
              </div>
            )}
          </Show>
        </div>

        {/* Bottom ConPTY Terminal */}
        <Show when={terminalOpen()}>
          <div class="h-52 shrink-0 border-t border-[var(--border-subtle)] bg-[#080A0F] flex flex-col">
            <div class="h-7 px-3 border-b border-[var(--border-subtle)] bg-[var(--bg-rail)] flex items-center justify-between text-[11px] font-mono-num">
              <span class="text-[var(--ink-secondary)]">
                ConPTY Terminal {activeTermId() ? `(${activeTermId()})` : ''}
              </span>
              <button
                type="button"
                class="omnia-btn px-2 py-0.5 text-[10px]"
                onClick={() => fitAddon?.fit()}
              >
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
