import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import {
  Activity,
  AlertTriangle,
  GitGraph,
  MessageSquare,
  Network,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Send,
  ShieldCheck,
} from 'lucide-solid';
import { api } from '@/api/client';
import { isReducedMotionActive, privacyMask, themePref } from '@/state/studio';
import { maskText } from '@/utils/privacy';

interface PulseAnim {
  from: string;
  to: string;
  startedAt: number;
  durationMs: number;
}

interface PeerNode {
  id: string;
  role: string;
  state?: string;
  epoch?: number;
  leaseOwner?: string;
  disjoint_paths?: string[];
  disjointPaths?: string[];
}

interface PeerEdge {
  from: string;
  to: string;
  kind?: string;
  duplex?: boolean;
  bidirectional?: boolean;
  channel?: string;
}

interface PeerMessageRow {
  seq: number;
  from: string;
  to: string;
  payload: string;
  epoch?: number;
  hop?: number;
  maxHops?: number;
  timestampMs?: number;
}

interface DisjointConflict {
  peerA: string;
  peerB: string;
  pathA: string;
  pathB: string;
  reason: string;
}

function normalizePattern(raw: string): string {
  return raw.trim().replace(/\\/g, '/').replace(/\/+$/, '');
}

function stripWildcardSuffix(pattern: string): string {
  return pattern.replace(/\/\*\*$/, '').replace(/\/\*$/, '').replace(/\*+$/, '');
}

function detectDisjointPathConflicts(peerList: PeerNode[]): DisjointConflict[] {
  const conflicts: DisjointConflict[] = [];
  const entries = peerList.map((p) => ({
    id: p.id,
    paths: (p.disjointPaths ?? p.disjoint_paths ?? []).map(normalizePattern).filter(Boolean),
  }));

  for (const e of entries) {
    for (const p of e.paths) {
      if (p.includes('..')) {
        conflicts.push({
          peerA: e.id,
          peerB: e.id,
          pathA: p,
          pathB: p,
          reason: 'parent-traversal-rejected',
        });
      }
    }
  }

  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      for (const pa of entries[i].paths) {
        const baseA = stripWildcardSuffix(pa).toLowerCase();
        for (const pb of entries[j].paths) {
          const baseB = stripWildcardSuffix(pb).toLowerCase();
          if (!baseA || !baseB) continue;
          const exact = pa.toLowerCase() === pb.toLowerCase();
          const aContainsB = pa.includes('*') && (baseB === baseA || baseB.startsWith(`${baseA}/`));
          const bContainsA = pb.includes('*') && (baseA === baseB || baseA.startsWith(`${baseB}/`));
          if (exact || aContainsB || bContainsA) {
            conflicts.push({
              peerA: entries[i].id,
              peerB: entries[j].id,
              pathA: pa,
              pathB: pb,
              reason: exact ? 'exact-path-collision' : 'glob-prefix-overlap',
            });
          }
        }
      }
    }
  }
  return conflicts;
}

function normalizeNodes(raw: unknown): PeerNode[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    const x = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    return {
      id: String(x.id ?? x.agent_id ?? x.agentId ?? 'peer'),
      role: String(x.role ?? 'worker'),
      state: x.state ? String(x.state) : undefined,
      epoch: typeof x.epoch === 'number' ? x.epoch : undefined,
      leaseOwner: x.leaseOwner ? String(x.leaseOwner) : x.lease_owner ? String(x.lease_owner) : undefined,
      disjoint_paths: Array.isArray(x.disjoint_paths) ? x.disjoint_paths.map(String) : undefined,
      disjointPaths: Array.isArray(x.disjointPaths) ? x.disjointPaths.map(String) : undefined,
    };
  });
}

function normalizeEdges(raw: unknown): PeerEdge[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    const x = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    return {
      from: String(x.from ?? x.from_id ?? x.fromId ?? ''),
      to: String(x.to ?? x.to_id ?? x.toId ?? ''),
      kind: x.kind ? String(x.kind) : x.channel ? String(x.channel) : undefined,
      duplex: Boolean(x.duplex ?? x.bidirectional ?? false),
      bidirectional: Boolean(x.bidirectional ?? x.duplex ?? false),
      channel: x.channel ? String(x.channel) : undefined,
    };
  });
}

function normalizeMessages(raw: unknown): PeerMessageRow[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item, idx) => {
    const x = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    const rawPayload = x.payload ?? x.body ?? x.message ?? x.text ?? '';
    return {
      seq: Number(x.seq ?? x.sequence ?? idx + 1) || idx + 1,
      from: String(x.from ?? x.from_id ?? x.fromId ?? x.sender ?? 'peer'),
      to: String(x.to ?? x.to_id ?? x.toId ?? x.recipient ?? 'all'),
      payload: typeof rawPayload === 'string' ? rawPayload : JSON.stringify(rawPayload),
      epoch: typeof x.epoch === 'number' ? x.epoch : undefined,
      hop: typeof x.hop === 'number' ? x.hop : typeof x.hops === 'number' ? x.hops : undefined,
      maxHops: typeof x.maxHops === 'number' ? x.maxHops : typeof x.max_hops === 'number' ? x.max_hops : undefined,
      timestampMs: Number(x.timestampMs ?? x.timestamp_ms ?? x.createdAtMs ?? Date.now()) || Date.now(),
    };
  });
}

export function SwarmView() {
  const [nodes, setNodes] = createSignal<PeerNode[]>([]);
  const [edges, setEdges] = createSignal<PeerEdge[]>([]);
  const [liveMessages, setLiveMessages] = createSignal<PeerMessageRow[]>([]);
  const [backendLeases, setBackendLeases] = createSignal<Array<Record<string, unknown>>>([]);
  const [convergence, setConvergence] = createSignal<Record<string, unknown> | null>(null);

  // Live cursor polling (/api/graph/peers/poll?since=<seq>)
  const [lastSeq, setLastSeq] = createSignal(0);
  const [autoPoll, setAutoPoll] = createSignal(true);
  const [pollStatus, setPollStatus] = createSignal<'idle' | 'live' | 'fallback' | 'error'>('idle');
  const [lastPollAt, setLastPollAt] = createSignal('');

  const [fromPeer, setFromPeer] = createSignal('coordinator');
  const [toPeer, setToPeer] = createSignal('verifier');
  const [maxHops, setMaxHops] = createSignal(4);
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
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  const effectiveNodes = createMemo<PeerNode[]>(() =>
    nodes().length > 0
      ? nodes()
      : [
          { id: 'coordinator', role: 'Coordinator', state: 'working', epoch: 1, disjoint_paths: ['docs/workspace/**'] },
          { id: 'studio-net-api', role: 'Backend/Net', state: 'working', epoch: 1, disjoint_paths: ['rust/omnia-studio/**'] },
          { id: 'ui-arena-canvas', role: 'UI/Arena', state: 'working', epoch: 1, disjoint_paths: ['ui-v5/src/styles/**'] },
          { id: 'harness-opt', role: 'Agent/TUI', state: 'waiting', epoch: 1, disjoint_paths: ['rust/omnia-agent/src/engine.rs'] },
          { id: 'build-gate', role: 'Build/Git', state: 'waiting', epoch: 1, disjoint_paths: ['Cargo.toml'] },
          { id: 'verifier', role: 'Verifier', state: 'waiting', epoch: 1, disjoint_paths: ['D:\\OmniaData\\qa\\**'] },
        ],
  );

  const disjointConflicts = createMemo(() => detectDisjointPathConflicts(effectiveNodes()));

  const topologyStats = createMemo(() => {
    const nList = effectiveNodes();
    const eList = edges();
    const duplexPairs = new Set<string>();
    let unidirectional = 0;
    for (const e of eList) {
      const hasRev = e.duplex || e.bidirectional || eList.some((r) => r.from === e.to && r.to === e.from);
      if (hasRev) {
        const key = [e.from, e.to].sort().join('<->');
        duplexPairs.add(key);
      } else {
        unidirectional++;
      }
    }
    const implicitDuplex = eList.length === 0 ? (nList.length * (nList.length - 1)) / 2 : duplexPairs.size;
    const workingCount = nList.filter((n) => (n.state || '').toLowerCase() === 'working').length;
    const stalledCount = nList.filter((n) => (n.state || '').toLowerCase() === 'stalled').length;
    const maxEpoch = nList.reduce((acc, n) => Math.max(acc, n.epoch ?? 1), 1);
    return {
      peers: nList.length,
      duplexLinks: implicitDuplex,
      unidirectional,
      workingCount,
      stalledCount,
      maxEpoch,
    };
  });

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
    const conflictPeerSet = new Set(disjointConflicts().flatMap((c) => [c.peerA, c.peerB]));
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
    const coralColor = cs.getPropertyValue('--status-coral').trim() || '#FB7185';
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

    // Active duplex A<->B animated pulses (respects OS & UI reduced-motion kill-switch)
    const activePulses = pulses().filter((p) => nowMs - p.startedAt < p.durationMs);
    for (const pulse of activePulses) {
      const a = pos.get(pulse.from);
      const b = pos.get(pulse.to);
      if (!a || !b) continue;
      const t = Math.min(1, (nowMs - pulse.startedAt) / pulse.durationMs);
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
      const isConflict = conflictPeerSet.has(n.id) || (n.state || '').toLowerCase() === 'stalled';
      ctx.fillStyle = panelFill;
      ctx.strokeStyle = isConflict
        ? coralColor
        : n.id === 'verifier' || n.role.toLowerCase() === 'verifier'
          ? amberColor
          : n.id === 'coordinator' || n.role.toLowerCase() === 'coordinator'
            ? emeraldColor
            : cyanColor;
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
    if (isReducedMotionActive()) {
      drawMesh();
      return;
    }
    setPulses((prev) => [...prev.slice(-8), { from, to, startedAt: performance.now(), durationMs: 1400 }]);
    cancelAnimationFrame(pulseRaf);
    pulseRaf = requestAnimationFrame((ts) => drawMesh(ts));
  };

  const mergeIncomingMessages = (incoming: PeerMessageRow[], animateNew: boolean) => {
    if (incoming.length === 0) return;
    const prevSeq = lastSeq();
    const existingSeqs = new Set(liveMessages().map((m) => m.seq));
    const fresh = incoming.filter((m) => !existingSeqs.has(m.seq));
    if (fresh.length === 0) return;
    const merged = [...liveMessages(), ...fresh].sort((a, b) => a.seq - b.seq).slice(-80);
    setLiveMessages(merged);
    const maxObserved = merged.reduce((acc, m) => Math.max(acc, m.seq), prevSeq);
    if (maxObserved > prevSeq) setLastSeq(maxObserved);
    if (animateNew) {
      const latest = fresh[fresh.length - 1];
      if (latest && latest.from && latest.to) {
        triggerPulse(latest.from, latest.to);
      }
    }
  };

  const applyGraphPayload = (data: Record<string, unknown>, animateNew: boolean) => {
    const rawNodes = data.nodes ?? data.peers ?? data.agents;
    const rawEdges = data.links ?? data.edges;
    const rawMsgs = data.messages ?? data.events;
    if (Array.isArray(rawNodes)) setNodes(normalizeNodes(rawNodes));
    if (Array.isArray(rawEdges)) setEdges(normalizeEdges(rawEdges));
    if (Array.isArray(rawMsgs)) mergeIncomingMessages(normalizeMessages(rawMsgs), animateNew);
    if (Array.isArray(data.leases)) setBackendLeases(data.leases as Array<Record<string, unknown>>);
    if (data.convergence && typeof data.convergence === 'object') {
      setConvergence(data.convergence as Record<string, unknown>);
    }
    const nextCursor = Number(data.headSeq ?? data.head_seq ?? data.seq ?? data.nextSeq ?? data.next_seq ?? NaN);
    if (Number.isFinite(nextCursor) && nextCursor > lastSeq()) {
      setLastSeq(nextCursor);
    }
  };

  const refreshGraph = async () => {
    const res = await api.getGraphSnapshot();
    if (res.ok) {
      applyGraphPayload(res.data, false);
    }
    drawMesh();
  };

  const pollPeers = async (animateNew = true) => {
    const since = lastSeq();
    try {
      const res = await fetch(`/api/graph/peers/poll?since=${encodeURIComponent(String(since))}`);
      if (res.ok) {
        const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        applyGraphPayload(data, animateNew);
        setPollStatus('live');
        setLastPollAt(new Date().toISOString().slice(11, 19));
        drawMesh();
        return;
      }
      if (res.status === 404 || res.status === 405) {
        // Fallback cleanly to GET /api/graph/peers when poll endpoint isn't mounted yet
        const fb = await fetch('/api/graph/peers');
        if (fb.ok) {
          const data = (await fb.json().catch(() => ({}))) as Record<string, unknown>;
          applyGraphPayload(data, animateNew);
          setPollStatus('fallback');
          setLastPollAt(new Date().toISOString().slice(11, 19));
          drawMesh();
          return;
        }
      }
      setPollStatus('error');
    } catch {
      setPollStatus('error');
    }
  };

  onMount(() => {
    void refreshGraph().then(() => void pollPeers(false));
    pollTimer = setInterval(() => {
      if (autoPoll()) void pollPeers(true);
    }, 2500);
  });

  onCleanup(() => {
    cancelAnimationFrame(pulseRaf);
    if (pollTimer) clearInterval(pollTimer);
  });

  createEffect(() => {
    themePref();
    effectiveNodes();
    edges();
    disjointConflicts();
    drawMesh();
  });

  const handleDispatch = async () => {
    if (!msgPayload().trim()) return;
    const res = await api.sendPeerMessage(fromPeer(), toPeer(), msgPayload(), maxHops());
    if (res.ok) {
      setStatusMsg(`Dispatched duplex message ${fromPeer()} <-> ${toPeer()} (max_hops=${maxHops()})`);
      triggerPulse(fromPeer(), toPeer());
      setMsgPayload('');
      await pollPeers(false);
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
      await pollPeers(false);
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
      {/* 2-Way PeerMeshGraph Canvas + Live Poll + Lease/Disjoint Conflict Monitor + Dispatch */}
      <div class="omnia-surface-panel rounded-lg p-3.5 flex flex-col gap-3 min-w-0">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="flex items-center gap-2 font-bold text-[13.5px] min-w-0">
            <Network class="w-4 h-4 text-[var(--accent-cyan)] shrink-0" />
            <span class="truncate">2-Way All-to-All PeerMeshGraph</span>
          </div>
          <div class="flex flex-wrap items-center gap-1.5">
            <div class="omp-segmented text-[10.5px]">
              <button type="button" aria-pressed={texMode() === 'mesh'} onClick={() => setTexMode('mesh')}>
                Mesh
              </button>
              <button type="button" aria-pressed={texMode() === 'tex_mcts'} onClick={() => setTexMode('tex_mcts')}>
                TEX/MCTS
              </button>
            </div>
            <button
              type="button"
              data-testid="swarm-poll-toggle"
              aria-pressed={autoPoll()}
              class="omnia-btn text-[10.5px]"
              onClick={() => setAutoPoll((v) => !v)}
              title="Toggle live /api/graph/peers/poll cursor polling"
            >
              <Show when={autoPoll()} fallback={<Play class="w-3 h-3" />}>
                <Pause class="w-3 h-3 text-[var(--status-emerald)]" />
              </Show>
              <span>{autoPoll() ? 'Live Poll' : 'Paused'}</span>
            </button>
            <button
              type="button"
              data-testid="swarm-poll-now"
              class="omnia-btn text-[11px]"
              onClick={() => void pollPeers(true)}
              title="Poll /api/graph/peers/poll now"
            >
              <RefreshCw class="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* 2-Way Peer-Mesh Topology Badges */}
        <div data-testid="swarm-topology-badges" class="flex flex-wrap items-center gap-1.5 text-[10.5px] font-mono-num">
          <span class="omnia-badge text-[var(--accent-cyan)]">Peers: {topologyStats().peers}</span>
          <span class="omnia-badge text-[var(--status-emerald)]">
            Duplex A&lt;-&gt;B: {topologyStats().duplexLinks}
          </span>
          <Show when={topologyStats().unidirectional > 0}>
            <span class="omnia-badge text-[var(--accent-amber)]">1-Way: {topologyStats().unidirectional}</span>
          </Show>
          <span class="omnia-badge">epoch:{topologyStats().maxEpoch}</span>
          <span class="omnia-badge">seq:#{lastSeq()}</span>
          <span
            class="omnia-badge"
            classList={{
              'text-[var(--status-emerald)]': pollStatus() === 'live',
              'text-[var(--accent-amber)]': pollStatus() === 'fallback',
              'text-[var(--status-coral)]': pollStatus() === 'error',
            }}
          >
            <Activity class="w-3 h-3" />
            <span>
              {pollStatus() === 'live'
                ? `poll:live ${lastPollAt()}`
                : pollStatus() === 'fallback'
                  ? `peers:fallback ${lastPollAt()}`
                  : pollStatus()}
            </span>
          </span>
          <Show when={convergence()?.converged !== undefined}>
            <span class="omnia-badge text-[var(--status-emerald)]">
              converged:{String(convergence()?.converged)}
            </span>
          </Show>
        </div>

        <canvas ref={canvasRef} class="w-full h-60 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)]" />

        <Show when={texMode() === 'tex_mcts'}>
          <div class="p-2.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] text-[11px] font-mono-num flex flex-wrap items-center justify-between gap-2">
            <span class="text-[var(--accent-cyan)] font-semibold">TEX / MCTS Test-Time Scaling</span>
            <span class="text-[var(--ink-secondary)]">
              UCB1 Exploration · Verifier-Guided Pruning · Cycle Guard max_hops={maxHops()}
            </span>
          </div>
        </Show>

        {/* Lease & Disjoint-Path Conflict Monitor */}
        <div data-testid="swarm-lease-conflict-monitor" class="space-y-1.5">
          <div class="flex flex-wrap items-center justify-between gap-2 text-[10.5px] font-semibold uppercase text-[var(--ink-muted)]">
            <div class="flex items-center gap-1">
              <ShieldCheck class="w-3.5 h-3.5 text-[var(--status-emerald)]" />
              <span>Lease &amp; Disjoint Write Ownership Monitor (`disjoint_paths`)</span>
            </div>
            <span
              class="omnia-badge"
              classList={{
                'text-[var(--status-emerald)]': disjointConflicts().length === 0,
                'text-[var(--status-coral)]': disjointConflicts().length > 0,
              }}
            >
              {disjointConflicts().length === 0
                ? '0 Conflicts · Disjoint Clean'
                : `${disjointConflicts().length} Disjoint Conflict(s)`}
            </span>
          </div>

          <Show when={disjointConflicts().length > 0}>
            <div class="space-y-1 text-[11px] font-mono-num">
              <For each={disjointConflicts()}>
                {(cf) => (
                  <div class="px-2.5 py-1.5 rounded border border-[var(--status-coral)] bg-[var(--status-coral-dim)] text-[var(--status-coral)] flex items-center justify-between gap-2">
                    <div class="flex items-center gap-1.5 min-w-0">
                      <AlertTriangle class="w-3.5 h-3.5 shrink-0" />
                      <span class="truncate">
                        {cf.peerA} ({cf.pathA}) vs {cf.peerB} ({cf.pathB})
                      </span>
                    </div>
                    <span class="shrink-0 font-semibold">{cf.reason}</span>
                  </div>
                )}
              </For>
            </div>
          </Show>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-1.5 max-h-32 overflow-y-auto text-[11px] font-mono-num">
            <For each={effectiveNodes()}>
              {(n) => {
                const paths = n.disjointPaths ?? n.disjoint_paths ?? [];
                return (
                  <div class="px-2 py-1.5 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] flex items-center justify-between gap-2 min-w-0">
                    <div class="flex items-center gap-1.5 min-w-0">
                      <span class="font-semibold text-[var(--accent-cyan)] shrink-0">{n.id}</span>
                      <Show when={n.state}>
                        <span class="text-[10px] text-[var(--status-emerald)] shrink-0">[{n.state}]</span>
                      </Show>
                    </div>
                    <span class="text-[var(--ink-muted)] truncate">
                      {paths.length > 0 ? maskText(paths.join(', '), privacyMask()) : n.role}
                    </span>
                  </div>
                );
              }}
            </For>
          </div>

          <Show when={backendLeases().length > 0}>
            <div class="flex flex-wrap gap-1.5 text-[10.5px] font-mono-num">
              <For each={backendLeases()}>
                {(ls) => (
                  <span class="omnia-badge text-[var(--accent-amber)]">
                    lease:{String(ls.resource ?? ls.id ?? 'lock')} -&gt; {String(ls.owner ?? ls.peer ?? 'peer')}
                  </span>
                )}
              </For>
            </div>
          </Show>
        </div>

        {/* Interactive Duplex Message Dispatch */}
        <div class="flex flex-wrap gap-1.5 text-[12px]">
          <datalist id="swarm-peer-options">
            <For each={effectiveNodes()}>{(n) => <option value={n.id} />}</For>
          </datalist>
          <input
            type="text"
            list="swarm-peer-options"
            aria-label="From peer"
            value={fromPeer()}
            onInput={(e) => setFromPeer(e.currentTarget.value)}
            class="w-28 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1 font-mono-num"
          />
          <span class="self-center text-[var(--ink-muted)] font-mono-num">&lt;-&gt;</span>
          <input
            type="text"
            list="swarm-peer-options"
            aria-label="To peer"
            value={toPeer()}
            onInput={(e) => setToPeer(e.currentTarget.value)}
            class="w-28 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1 font-mono-num"
          />
          <input
            type="number"
            min={1}
            max={8}
            aria-label="Max hops"
            title="max_hops cycle guard"
            value={maxHops()}
            onInput={(e) => setMaxHops(Math.max(1, Math.min(8, Number(e.currentTarget.value) || 4)))}
            class="w-14 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-1.5 py-1 font-mono-num text-center"
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

        {/* Live Duplex Message Feed (`read_since(seq)`) */}
        <div data-testid="swarm-live-messages" class="space-y-1">
          <div class="text-[10.5px] font-semibold uppercase text-[var(--ink-muted)] flex items-center justify-between gap-2">
            <span class="flex items-center gap-1">
              <MessageSquare class="w-3.5 h-3.5 text-[var(--accent-cyan)]" />
              <span>Live Duplex Board Feed ({liveMessages().length})</span>
            </span>
            <span class="font-mono-num">read_since({lastSeq()})</span>
          </div>
          <div class="max-h-36 overflow-y-auto space-y-1 text-[11px] font-mono-num">
            <Show
              when={liveMessages().length > 0}
              fallback={
                <div class="px-2.5 py-2 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] text-[var(--ink-muted)]">
                  Listening on /api/graph/peers/poll?since={lastSeq()}. Dispatch a duplex message above to stream live events.
                </div>
              }
            >
              <For each={[...liveMessages()].reverse().slice(0, 20)}>
                {(m) => (
                  <div class="px-2.5 py-1.5 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] flex items-start justify-between gap-2">
                    <div class="min-w-0">
                      <span class="text-[var(--ink-muted)]">#{m.seq}</span>{' '}
                      <span class="text-[var(--accent-cyan)] font-semibold">{m.from}</span>
                      <span class="text-[var(--ink-muted)]"> &lt;-&gt; </span>
                      <span class="text-[var(--accent-amber)] font-semibold">{m.to}</span>:{' '}
                      <span class="text-[var(--ink-primary)] break-words">{maskText(m.payload, privacyMask())}</span>
                    </div>
                    <Show when={m.epoch !== undefined}>
                      <span class="omnia-badge shrink-0">e{m.epoch}</span>
                    </Show>
                  </div>
                )}
              </For>
            </Show>
          </div>
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
      <div class="omnia-surface-panel rounded-lg p-3.5 flex flex-col gap-3 min-w-0">
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
