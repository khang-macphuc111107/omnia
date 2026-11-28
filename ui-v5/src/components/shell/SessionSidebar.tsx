import { For, Show, createMemo, createSignal } from 'solid-js';
import {
  BookOpen,
  Compass,
  Cpu,
  Database,
  Download,
  Edit3,
  FolderGit2,
  GitFork,
  History,
  ListOrdered,
  MessageSquarePlus,
  Minimize2,
  Network,
  Plus,
  Search,
  Sparkles,
  Swords,
  Trash2,
  Trophy,
} from 'lucide-solid';
import { api } from '@/api/client';
import {
  activeSessionId,
  compactActiveSession,
  exportActiveSession,
  flashNotice,
  messages,
  openObservabilityTab,
  openRewindPreview,
  openWorkbench,
  privacyMask,
  selectAndLoadSession,
  sessions,
  setSessions,
  setSteerDrawerOpen,
  steerQueue,
  topMode,
  workbenchTab,
  workspaceRoot,
} from '@/state/studio';
import type { SessionRecord, WorkbenchTab } from '@/types';
import { maskText } from '@/utils/privacy';

const SURFACE_ITEMS: Array<{ id: WorkbenchTab; label: string; icon: () => any }> = [
  { id: 'chat', label: 'Agent Chat', icon: () => <MessageSquarePlus class="w-3.5 h-3.5" /> },
  { id: 'arena', label: 'AI Studio & Arena', icon: () => <Swords class="w-3.5 h-3.5" /> },
  { id: 'lifecycle', label: 'Mission Lifecycle', icon: () => <Compass class="w-3.5 h-3.5" /> },
  { id: 'atelier', label: 'Atelier Studio', icon: () => <BookOpen class="w-3.5 h-3.5" /> },
  { id: 'omnidrive', label: 'OmniDrive Pro', icon: () => <Download class="w-3.5 h-3.5" /> },
  { id: 'swarm', label: 'Peer-Mesh Swarm', icon: () => <Network class="w-3.5 h-3.5" /> },
  { id: 'observability', label: 'Observatory & Net', icon: () => <Cpu class="w-3.5 h-3.5" /> },
  { id: 'knowledge', label: 'Memory & MCP', icon: () => <Database class="w-3.5 h-3.5" /> },
  { id: 'benchmarks', label: 'Benchmarks v5', icon: () => <Trophy class="w-3.5 h-3.5" /> },
];

export function SessionSidebar() {
  const [filter, setFilter] = createSignal('');
  const [renamingId, setRenamingId] = createSignal<string | null>(null);
  const [renameText, setRenameText] = createSignal('');
  const [rewindTurn, setRewindTurn] = createSignal<number>(0);

  const filteredSessions = createMemo(() => {
    const q = filter().trim().toLowerCase();
    const ws = workspaceRoot() || undefined;
    const list =
      sessions.length > 0
        ? sessions
        : [
            {
              id: activeSessionId(),
              title: 'Current Workspace Session',
              kind: ws ? ('project' as const) : ('standalone' as const),
              workspace: ws,
            },
          ];
    if (!q) return list;
    return list.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        (s.project_name || '').toLowerCase().includes(q) ||
        (s.workspace || '').toLowerCase().includes(q),
    );
  });

  const projectSessions = createMemo(() =>
    filteredSessions().filter((s) => s.kind !== 'standalone' && Boolean(s.workspace || s.project_name)),
  );
  const standaloneSessions = createMemo(() =>
    filteredSessions().filter((s) => s.kind === 'standalone' || (!s.workspace && !s.project_name)),
  );

  const handleCreate = async () => {
    const title = `Session ${new Date().toLocaleTimeString('vi-VN', { hour12: false })}`;
    const ws = workspaceRoot() || undefined;
    const res = await api.createSession(title, ws);
    if (res.ok && res.data.session) {
      setSessions([res.data.session, ...sessions]);
      await selectAndLoadSession(res.data.session.id);
      flashNotice(`Created session "${title}"`);
    } else {
      const local: SessionRecord = {
        id: `session-${Date.now()}`,
        title,
        workspace: ws,
        kind: ws ? 'project' : 'standalone',
        created_at: Date.now(),
      };
      setSessions([local, ...sessions]);
      await selectAndLoadSession(local.id);
      if (!res.ok) flashNotice(`Local session fallback (${res.error.code})`);
    }
  };

  const commitRename = async (id: string) => {
    const next = renameText().trim();
    setRenamingId(null);
    if (!next) return;
    setSessions((s) => s.id === id, 'title', next);
    const res = await api.renameSession(id, next);
    if (!res.ok) flashNotice(`Rename error (${res.error.code}): ${res.error.message}`);
  };

  const handleFork = async (s: SessionRecord) => {
    const res = await api.forkSession(s.id);
    if (res.ok && res.data.session) {
      setSessions([res.data.session, ...sessions]);
      await selectAndLoadSession(res.data.session.id);
      flashNotice(`Forked "${s.title}"`);
    } else if (!res.ok) {
      flashNotice(`Fork failed (${res.error.code}): ${res.error.message}`);
    }
  };

  const handleDelete = async (id: string) => {
    setSessions(sessions.filter((s) => s.id !== id));
    const res = await api.deleteSession(id);
    if (!res.ok) flashNotice(`Delete error (${res.error.code}): ${res.error.message}`);
  };

  const renderSessionRow = (s: SessionRecord) => (
    <div
      class="group flex items-center justify-between gap-1.5 px-2 py-1.5 rounded text-[12px] cursor-pointer border"
      classList={{
        'bg-[var(--bg-elevated)] border-[var(--border-accent)] text-[var(--ink-primary)]':
          activeSessionId() === s.id,
        'bg-transparent border-transparent text-[var(--ink-secondary)] hover:bg-[var(--bg-elevated)]':
          activeSessionId() !== s.id,
      }}
      onClick={() => void selectAndLoadSession(s.id)}
    >
      <div class="min-w-0 flex-1">
        <Show when={renamingId() === s.id} fallback={<div class="truncate font-medium">{s.title}</div>}>
          <input
            type="text"
            value={renameText()}
            onInput={(e) => setRenameText(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void commitRename(s.id);
              if (e.key === 'Escape') setRenamingId(null);
            }}
            onBlur={() => void commitRename(s.id)}
            class="w-full bg-[var(--bg-canvas)] border border-[var(--border-accent)] rounded px-1.5 py-0.5 text-[12px] outline-none"
            autofocus
          />
        </Show>
        <Show when={s.workspace}>
          <div class="text-[10px] font-mono-num text-[var(--ink-muted)] truncate">
            {maskText(s.workspace || '', privacyMask())}
          </div>
        </Show>
      </div>
      <div class="hidden group-hover:flex items-center gap-0.5 shrink-0" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          class="p-1 rounded hover:bg-[var(--bg-interactive)] text-[var(--ink-muted)] hover:text-[var(--ink-primary)]"
          title="Rename Session"
          onClick={() => {
            setRenamingId(s.id);
            setRenameText(s.title);
          }}
        >
          <Edit3 class="w-3 h-3" />
        </button>
        <button
          type="button"
          class="p-1 rounded hover:bg-[var(--bg-interactive)] text-[var(--ink-muted)] hover:text-[var(--ink-primary)]"
          title="Fork Session"
          onClick={() => void handleFork(s)}
        >
          <GitFork class="w-3 h-3" />
        </button>
        <button
          type="button"
          class="p-1 rounded hover:bg-[var(--status-coral-dim)] text-[var(--ink-muted)] hover:text-[var(--status-coral)]"
          title="Delete Session"
          onClick={() => void handleDelete(s.id)}
        >
          <Trash2 class="w-3 h-3" />
        </button>
      </div>
    </div>
  );

  return (
    <aside class="w-64 shrink-0 h-full flex flex-col bg-[var(--bg-rail)] border-r border-[var(--border-subtle)] select-none">
      {/* Header + New Chat */}
      <div class="p-2.5 border-b border-[var(--border-subtle)] flex items-center justify-between gap-2">
        <div class="flex items-center gap-1.5 min-w-0">
          <Sparkles class="w-4 h-4 text-[var(--accent-amber)] shrink-0" />
          <span class="text-[12.5px] font-bold tracking-tight truncate">Omnia Studio</span>
        </div>
        <button
          type="button"
          class="omnia-btn omnia-btn-primary px-2 py-1 text-[11px]"
          onClick={() => void handleCreate()}
        >
          <Plus class="w-3.5 h-3.5" />
          <span>New</span>
        </button>
      </div>

      {/* Surface Navigation */}
      <div class="p-2 border-b border-[var(--border-subtle)] grid grid-cols-1 gap-0.5">
        <div class="px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--ink-muted)]">
          Workbenches
        </div>
        <For each={SURFACE_ITEMS}>
          {(item) => (
            <button
              type="button"
              data-nav-workbench={item.id}
              onClick={() =>
                item.id === 'benchmarks'
                  ? openObservabilityTab('benchmarks')
                  : item.id === 'observability'
                    ? openObservabilityTab('telemetry')
                    : openWorkbench(item.id)
              }
              class="flex items-center gap-2 px-2 py-1.5 rounded text-[12px] font-medium cursor-pointer text-left"
              classList={{
                'bg-[var(--bg-elevated)] text-[var(--accent-cyan)] border border-[var(--border-subtle)]':
                  topMode() === 'chat' && workbenchTab() === item.id,
                'text-[var(--ink-secondary)] hover:bg-[var(--bg-panel)] border border-transparent':
                  !(topMode() === 'chat' && workbenchTab() === item.id),
              }}
            >
              {item.icon()}
              <span>{item.label}</span>
            </button>
          )}
        </For>
      </div>

      {/* Unified SQLite Session Tree Search */}
      <div class="p-2 border-b border-[var(--border-subtle)]">
        <div class="flex items-center gap-1.5 px-2 py-1 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)]">
          <Search class="w-3.5 h-3.5 text-[var(--ink-muted)]" />
          <input
            type="text"
            placeholder="Filter SQLite sessions..."
            value={filter()}
            onInput={(e) => setFilter(e.currentTarget.value)}
            class="w-full bg-transparent text-[12px] text-[var(--ink-primary)] placeholder-[var(--ink-muted)] outline-none"
          />
        </div>
      </div>

      {/* Session Groups */}
      <div class="flex-1 overflow-y-auto p-2 space-y-3">
        <div>
          <div class="flex items-center gap-1.5 px-1.5 pb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--ink-muted)]">
            <FolderGit2 class="w-3 h-3" />
            <span>Project Chats ({projectSessions().length})</span>
          </div>
          <div class="space-y-0.5">
            <For each={projectSessions()}>{renderSessionRow}</For>
          </div>
        </div>

        <Show when={standaloneSessions().length > 0}>
          <div>
            <div class="px-1.5 pb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--ink-muted)]">
              Standalone ({standaloneSessions().length})
            </div>
            <div class="space-y-0.5">
              <For each={standaloneSessions()}>{renderSessionRow}</For>
            </div>
          </div>
        </Show>
      </div>

      {/* Session Controls: Compact, Export, Steer Queue & /rewind Preview Scrubber */}
      <div class="p-2.5 border-t border-[var(--border-subtle)] bg-[var(--bg-panel)] space-y-2">
        <div class="grid grid-cols-3 gap-1">
          <button
            type="button"
            class="omnia-btn justify-center px-1.5 py-1 text-[10.5px]"
            title="Lakeview Anchored Context Compaction (/compact)"
            onClick={() => void compactActiveSession()}
          >
            <Minimize2 class="w-3 h-3 text-[var(--accent-cyan)]" />
            <span>Compact</span>
          </button>
          <button
            type="button"
            class="omnia-btn justify-center px-1.5 py-1 text-[10.5px]"
            title="Export Active Session Markdown (honors Privacy Mask)"
            onClick={() => exportActiveSession('markdown')}
          >
            <Download class="w-3 h-3 text-[var(--status-emerald)]" />
            <span>Export</span>
          </button>
          <button
            type="button"
            class="omnia-btn justify-center px-1.5 py-1 text-[10.5px]"
            title="Open Additive Steer Queue Drawer"
            onClick={() => setSteerDrawerOpen(true)}
          >
            <ListOrdered class="w-3 h-3 text-[var(--accent-amber)]" />
            <span>Steer ({steerQueue.length})</span>
          </button>
        </div>

        <div class="space-y-1">
          <div class="flex items-center justify-between text-[11px] text-[var(--ink-secondary)]">
            <span class="flex items-center gap-1 font-semibold">
              <History class="w-3.5 h-3.5 text-[var(--accent-amber)]" />
              <span>/rewind Preview</span>
            </span>
            <span class="font-mono-num text-[var(--ink-muted)]">
              T{rewindTurn()} / {Math.max(messages.length - 1, 0)}
            </span>
          </div>
          <div class="flex items-center gap-2">
            <input
              type="range"
              min="0"
              max={Math.max(messages.length - 1, 0)}
              value={rewindTurn()}
              onInput={(e) => setRewindTurn(Number(e.currentTarget.value))}
              class="flex-1 accent-[var(--accent-amber)] cursor-pointer"
            />
            <button
              type="button"
              data-testid="sidebar-rewind-preview-btn"
              class="omnia-btn px-2 py-0.5 text-[11px]"
              onClick={() => void openRewindPreview(rewindTurn())}
            >
              Preview
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
}
