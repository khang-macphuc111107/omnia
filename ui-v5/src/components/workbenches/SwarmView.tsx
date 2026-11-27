import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { GitGraph, Network, Plus, RefreshCw, Send, ShieldCheck } from 'lucide-solid';
import { api } from '@/api/client';
import { privacyMask, themePref } from '@/state/studio';
import { maskText } from '@/utils/privacy';

interface PulseAnim {
  from: string;
  to: string;
  startedAt: number;
  durationMs: number;
}

export function SwarmView() {
  const [nodes, setNodes] = createSignal<
    Array<{ id: string; role: string; state?: string; disjoint_paths?: string[]; disjointPaths?: string[] }>
  >([]);
  const [edges, setEdges] = createSignal<Array<{ from: string; to: string; kind?: string }>>([]);
  const [fromPeer, setFromPeer] = createSignal('coordinator');
  const [toPeer, setToPeer] = createSignal('verifier');
  const [msgPayload, setMsgPayload] = createSignal('');
  const [newPeerId, setNewPeerId] = createSignal('');
  const [newPeerRole, setNewPeerRole] = createSignal('worker');
  const [newPeerPaths, setNewPeerPaths] = createSignal('');
  const [graphifyNode, setGraphifyNode] = createSignal('NativeSuperEngine');
  const [graphifyDir, setGraphifyDir] = createSignal<'forward' | 'reverse' | 'both'>('both');
  const [graphifyResult, setGraphifyResult] = createSignal<Record<string, unknown> | null>(null);
  const [statusMsg, setStatusMsg] = createSignal('');
  const [pulses, setPulses] = createSignal<PulseAnim[]>([]);
  const [texMode, setTexMode] = createSignal<'mesh' | 'tex_mcts'>('mesh');

  let canvasRef: HTMLCanvasElement | undefined;
  let pulseRaf = 0;

  const effectiveNodes = createMemo(() =>
    nodes().length > 0
      ? nodes()
      : [
          { id: 'coordinator', role: 'Coordinator', disjoint_paths: ['docs/workspace/**'] },
          { id: 'studio-net-api', role: 'Backend/Net', disjoint_paths: ['rust/omnia-studio/**'] },
          { id: 'ui-native-flagship', role: 'UI/Native', disjoint_paths: ['ui-v5/src/**'] },
          { id: 'harness-opt', role: 'Agent/TUI', disjoint_paths: ['rust/omnia-agent/src/engine.rs'] },
          { id: 'build-gate', role: 'Build/Git', disjoint_paths: ['Cargo.toml'] },
          { id: 'verifier', role: 'Verifier', disjoint_paths: ['D:\\OmniaData\\qa\\**'] },
        ],
  );

  const drawMesh = (nowMs = performance.now()) => {
    if (!canvasRef) return;
    const ctx = canvasRef.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvasRef.clientWidth || 640;
    const h = canvasRef.clientHeight || 300;
    if (canvasRef.width !== Math.round(w * dpr) || canvasRef.height !== Math.round(h * dpr)) {
      canvasRef.width = Math.round(w * dpr);
      canvasRef.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const list = effectiveNodes();
    const eList = edges();
    const cx = w / 2;
    const cy = h / 2 - 4;
    const rx = Math.max(105, w * 0.36);
    const ry = Math.max(80, h * 0.31);
    const pos = new Map<string, { x: number; y: number }>();

    list.forEach((n, idx) => {
      const angle = (idx / list.length) * Math.PI * 2 - Math.PI / 2;
      pos.set(n.id, { x: cx + Math.cos(angle) * rx, y: cy + Math.sin(angle) * ry });
    });

    const cs = getComputedStyle(document.documentElement);
    const canvasBg = cs.getPropertyValue('--bg-canvas').trim() || '#080A0F';
    const panelFill = cs.getPropertyValue('--bg-panel').trim() || '#111621';
    const inkColor = cs.getPropertyValue('--ink-primary').trim() || '#F2F5FA';
    const cyanColor = cs.getPropertyValue('--accent-cyan').trim() || '#38BDF8';
    const amberColor = cs.getPropertyValue('--accent-amber').trim() || '#F0B44C';
    const emeraldColor = cs.getPropertyValue('--status-emerald').trim() || '#34D399';
    const borderColor = cs.getPropertyValue('--border-accent').trim() || 'rgba(56, 189, 248, 0.38)';

    // Bidirectional duplex edges
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = 1.25;
    if (eList.length > 0) {
      for (const e of eList) {
        const a = pos.get(e.from);
        const b = pos.get(e.to);
        if (a && b) {
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
    } else {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = pos.get(list[i].id)!;
          const b = pos.get(list[j].id)!;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
    }

    // Active duplex A<->B animated pulses (respects prefers-reduced-motion)
    const activePulses = pulses().filter((p) => nowMs - p.startedAt < p.durationMs);
    for (const pulse of activePulses) {
      const a = pos.get(pulse.from);
      const b = pos.get(pulse.to);
      if (!a || !b) continue;
      const t = Math.min(1, (nowMs - pulse.startedAt) / pulse.durationMs);
      // Forward pulse A->B and return echo B->A
      const fx = a.x + (b.x - a.x) * t;
      const fy = a.y + (b.y - a.y) * t;
      const rxp = b.x + (a.x - b.x) * t;
      const ryp = b.y + (a.y - b.y) * t;

      ctx.strokeStyle = emeraldColor;
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();

      ctx.fillStyle = amberColor;
      ctx.beginPath();
      ctx.arc(fx, fy, 5, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = cyanColor;
      ctx.beginPath();
      ctx.arc(rxp, ryp, 4, 0, Math.PI * 2);
      ctx.fill();
    }

    for (const n of list) {
      const p = pos.get(n.id)!;
      ctx.fillStyle = panelFill;
      ctx.strokeStyle = n.id === 'verifier' ? amberColor : n.id === 'coordinator' ? emeraldColor : cyanColor;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 17, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      ctx.font = '600 11px "JetBrains Mono", Consolas, monospace';
      const tw = ctx.measureText(n.id).width;
      const ly = p.y + 30;
      ctx.fillStyle = canvasBg;
      ctx.fillRect(p.x - tw / 2 - 4, ly - 10, tw + 8, 14);
      ctx.fillStyle = inkColor;
      ctx.textAlign = 'center';
      ctx.fillText(n.id, p.x, ly);
    }

    if (activePulses.length > 0) {
      pulseRaf = requestAnimationFrame((ts) => drawMesh(ts));
    } else if (pulses().length > 0) {
      setPulses([]);
    }
  };

  const triggerPulse = (from: string, to: string) => {
    const reduced =
      typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      drawMesh();
      return;
    }
    setPulses((prev) => [...prev, { from, to, startedAt: performance.now(), durationMs: 1400 }]);
    cancelAnimationFrame(pulseRaf);
    pulseRaf = requestAnimationFrame((ts) => drawMesh(ts));
  };

  const refreshGraph = async () => {
    const res = await api.getGraphSnapshot();
    if (res.ok) {
      const n = Array.isArray(res.data.nodes) ? (res.data.nodes as Array<Record<string, unknown>>) : [];
      const e = Array.isArray(res.data.edges) ? (res.data.edges as Array<Record<string, unknown>>) : [];
      setNodes(
        n.map((x) => ({
          id: String(x.id ?? 'peer'),
          role: String(x.role ?? 'worker'),
          state: x.state ? String(x.state) : undefined,
          disjoint_paths: Array.isArray(x.disjoint_paths) ? x.disjoint_paths.map(String) : undefined,
          disjointPaths: Array.isArray(x.disjointPaths) ? x.disjointPaths.map(String) : undefined,
        })),
      );
      setEdges(
        e.map((x) => ({
          from: String(x.from ?? ''),
          to: String(x.to ?? ''),
          kind: x.kind ? String(x.kind) : undefined,
        })),
      );
    }
    drawMesh();
  };

  onMount(() => {
    void refreshGraph();
  });

  onCleanup(() => {
    cancelAnimationFrame(pulseRaf);
  });

  createEffect(() => {
    themePref();
    effectiveNodes();
    edges();
    drawMesh();
  });

  const handleDispatch = async () => {
    if (!msgPayload().trim()) return;
    const res = await api.sendPeerMessage(fromPeer(), toPeer(), msgPayload(), 4);
    if (res.ok) {
      setStatusMsg(`Dispatched duplex message ${fromPeer()} <-> ${toPeer()}`);
      triggerPulse(fromPeer(), toPeer());
      setMsgPayload('');
      await refreshGraph();
    } else {
      setStatusMsg(`Dispatch error (${res.error.code}): ${res.error.message}`);
    }
  };

  const handleRegisterPeer = async () => {
    if (!newPeerId().trim()) return;
    const paths = newPeerPaths()
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const res = await api.registerPeer(newPeerId().trim(), newPeerRole(), paths);
    if (res.ok) {
      setStatusMsg(`Registered peer "${newPeerId().trim()}" (${paths.length} disjoint paths)`);
      setNewPeerId('');
      setNewPeerPaths('');
      await refreshGraph();
    } else {
      setStatusMsg(`Register error (${res.error.code}): ${res.error.message}`);
    }
  };

  const handleTraverse = async () => {
    const res = await api.traverseGraphify(graphifyNode(), graphifyDir(), 2);
    if (res.ok) {
      setGraphifyResult(res.data);
    } else {
      setGraphifyResult({ error: res.error.code, message: res.error.message });
    }
  };

  const graphifyEdges = createMemo(() => {
    const r = graphifyResult();
    if (!r) return [];
    const list = (r.edges ?? r.relationships ?? r.matches ?? []) as Array<Record<string, unknown>>;
    return Array.isArray(list) ? list : [];
  });

  return (
    <div
      data-testid="swarm-workbench"
      class="flex-1 min-h-0 overflow-y-auto p-4 grid grid-cols-1 lg:grid-cols-2 gap-4 bg-[var(--bg-canvas)]"
    >
      {/* 2-Way PeerMeshGraph Canvas + Disjoint Paths + TEX/MCTS + Dispatch */}
      <div class="omnia-surface-panel rounded-lg p-3.5 flex flex-col gap-3">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="flex items-center gap-2 font-bold text-[13.5px]">
            <Network class="w-4 h-4 text-[var(--accent-cyan)]" />
            <span>2-Way All-to-All PeerMeshGraph (max_hops & epoch)</span>
          </div>
          <div class="flex items-center gap-1.5">
            <div class="omp-segmented text-[10.5px]">
              <button type="button" aria-pressed={texMode() === 'mesh'} onClick={() => setTexMode('mesh')}>
                Mesh
              </button>
              <button type="button" aria-pressed={texMode() === 'tex_mcts'} onClick={() => setTexMode('tex_mcts')}>
                TEX/MCTS
              </button>
            </div>
            <button type="button" class="omnia-btn text-[11px]" onClick={() => void refreshGraph()}>
              <RefreshCw class="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        <canvas ref={canvasRef} class="w-full h-64 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)]" />

        <Show when={texMode() === 'tex_mcts'}>
          <div class="p-2.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] text-[11px] font-mono-num flex flex-wrap items-center justify-between gap-2">
            <span class="text-[var(--accent-cyan)] font-semibold">TEX / MCTS Test-Time Scaling</span>
            <span class="text-[var(--ink-secondary)]">UCB1 Exploration · Verifier-Guided Pruning · Cycle Guard max_hops=4</span>
          </div>
        </Show>

        {/* Disjoint Ownership Guard Pills */}
        <div class="space-y-1">
          <div class="text-[10.5px] font-semibold uppercase text-[var(--ink-muted)] flex items-center gap-1">
            <ShieldCheck class="w-3.5 h-3.5 text-[var(--status-emerald)]" />
            <span>Disjoint Write Ownership (`disjoint_paths`)</span>
          </div>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-1.5 max-h-32 overflow-y-auto text-[11px] font-mono-num">
            <For each={effectiveNodes()}>
              {(n) => {
                const paths = n.disjointPaths ?? n.disjoint_paths ?? [];
                return (
                  <div class="px-2 py-1.5 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] flex items-center justify-between gap-2">
                    <span class="font-semibold text-[var(--accent-cyan)] shrink-0">{n.id}</span>
                    <span class="text-[var(--ink-muted)] truncate">
                      {paths.length > 0 ? maskText(paths.join(', '), privacyMask()) : n.role}
                    </span>
                  </div>
                );
              }}
            </For>
          </div>
        </div>

        {/* Duplex Message Dispatch */}
        <div class="flex flex-wrap gap-2 text-[12px]">
          <input
            type="text"
            value={fromPeer()}
            onInput={(e) => setFromPeer(e.currentTarget.value)}
            class="w-28 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1 font-mono-num"
          />
          <span class="self-center text-[var(--ink-muted)]">&lt;-&gt;</span>
          <input
            type="text"
            value={toPeer()}
            onInput={(e) => setToPeer(e.currentTarget.value)}
            class="w-28 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1 font-mono-num"
          />
          <input
            type="text"
            placeholder="Duplex message..."
            value={msgPayload()}
            onInput={(e) => setMsgPayload(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleDispatch();
            }}
            class="flex-1 min-w-[140px] rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1"
          />
          <button type="button" class="omnia-btn omnia-btn-primary text-[11.5px]" onClick={() => void handleDispatch()}>
            <Send class="w-3.5 h-3.5" />
            <span>Pulse</span>
          </button>
        </div>

        {/* Register Peer */}
        <div class="pt-2 border-t border-[var(--border-subtle)] flex flex-wrap gap-1.5 text-[11.5px]">
          <input
            type="text"
            placeholder="New peer ID"
            value={newPeerId()}
            onInput={(e) => setNewPeerId(e.currentTarget.value)}
            class="w-28 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1 font-mono-num"
          />
          <select
            value={newPeerRole()}
            onChange={(e) => setNewPeerRole(e.currentTarget.value)}
            class="rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1"
          >
            <option value="worker">worker</option>
            <option value="specialist">specialist</option>
            <option value="verifier">verifier</option>
          </select>
          <input
            type="text"
            placeholder="disjoint_paths (comma-separated)"
            value={newPeerPaths()}
            onInput={(e) => setNewPeerPaths(e.currentTarget.value)}
            class="flex-1 min-w-[140px] rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1 font-mono-num"
          />
          <button type="button" class="omnia-btn text-[11px]" onClick={() => void handleRegisterPeer()}>
            <Plus class="w-3.5 h-3.5" />
            <span>Add Peer</span>
          </button>
        </div>

        <Show when={statusMsg()}>
          <div class="text-[11px] font-mono-num text-[var(--status-emerald)]">{statusMsg()}</div>
        </Show>
      </div>

      {/* Graphify Bidirectional AST/Doc Provenance Traversal */}
      <div class="omnia-surface-panel rounded-lg p-3.5 flex flex-col gap-3">
        <div class="flex items-center gap-2 font-bold text-[13.5px]">
          <GitGraph class="w-4 h-4 text-[var(--accent-amber)]" />
          <span>Graphify Bidirectional Index (`EXTRACTED` / `INFERRED` / `AMBIGUOUS`)</span>
        </div>

        <div class="flex flex-wrap gap-2 text-[12px]">
          <input
            type="text"
            value={graphifyNode()}
            onInput={(e) => setGraphifyNode(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleTraverse();
            }}
            placeholder="Symbol or file node..."
            class="flex-1 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2.5 py-1 font-mono-num"
          />
          <select
            value={graphifyDir()}
            onChange={(e) => setGraphifyDir(e.currentTarget.value as 'forward' | 'reverse' | 'both')}
            class="rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1"
          >
            <option value="forward">Forward</option>
            <option value="reverse">Reverse</option>
            <option value="both">Both</option>
          </select>
          <button type="button" class="omnia-btn omnia-btn-primary text-[11.5px]" onClick={() => void handleTraverse()}>
            Traverse
          </button>
        </div>

        <Show when={graphifyEdges().length > 0}>
          <div class="space-y-1 max-h-40 overflow-y-auto text-[11px] font-mono-num">
            <For each={graphifyEdges().slice(0, 30)}>
              {(ed) => {
                const prov = String(ed.provenance ?? ed.confidence ?? 'EXTRACTED').toUpperCase();
                return (
                  <div class="px-2.5 py-1.5 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] flex items-center justify-between gap-2">
                    <span class="truncate text-[var(--ink-primary)]">
                      {String(ed.from ?? ed.source ?? '')} → {String(ed.to ?? ed.target ?? '')}
                    </span>
                    <span
                      class="omnia-badge shrink-0"
                      classList={{
                        'text-[var(--status-emerald)]': prov === 'EXTRACTED',
                        'text-[var(--accent-cyan)]': prov === 'INFERRED',
                        'text-[var(--accent-amber)]': prov === 'AMBIGUOUS',
                      }}
                    >
                      {prov}
                    </span>
                  </div>
                );
              }}
            </For>
          </div>
        </Show>

        <pre class="flex-1 min-h-[220px] p-3 rounded border border-[var(--border-subtle)] bg-[var(--bg-code)] text-[11.5px] font-mono-num overflow-auto whitespace-pre-wrap">
          {JSON.stringify(
            graphifyResult() ?? {
              hint: 'Run Graphify traversal to inspect deterministic CST edges & quarantined AMBIGUOUS links.',
            },
            null,
            2,
          )}
        </pre>
      </div>
    </div>
  );
}
