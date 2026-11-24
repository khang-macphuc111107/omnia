import { Show, createEffect, createSignal, onMount } from 'solid-js';
import { GitGraph, Network, RefreshCw, Send } from 'lucide-solid';
import { api } from '@/api/client';
import { themePref } from '@/state/studio';

export function SwarmView() {
  const [nodes, setNodes] = createSignal<Array<{ id: string; role: string; state?: string; disjoint_paths?: string[] }>>([]);
  const [edges, setEdges] = createSignal<Array<{ from: string; to: string; kind?: string }>>([]);
  const [fromPeer, setFromPeer] = createSignal('coordinator');
  const [toPeer, setToPeer] = createSignal('verifier');
  const [msgPayload, setMsgPayload] = createSignal('');
  const [graphifyNode, setGraphifyNode] = createSignal('NativeSuperEngine');
  const [graphifyDir, setGraphifyDir] = createSignal<'forward' | 'reverse' | 'both'>('both');
  const [graphifyResult, setGraphifyResult] = createSignal<Record<string, unknown> | null>(null);
  const [statusMsg, setStatusMsg] = createSignal('');

  let canvasRef: HTMLCanvasElement | undefined;

  const drawMesh = (nList: typeof nodes extends () => infer R ? R : never, eList: typeof edges extends () => infer R ? R : never) => {
    if (!canvasRef) return;
    const ctx = canvasRef.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvasRef.clientWidth || 640;
    const h = canvasRef.clientHeight || 320;
    canvasRef.width = w * dpr;
    canvasRef.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const list = nList.length > 0 ? nList : [
      { id: 'coordinator', role: 'Coordinator' },
      { id: 'wire-router', role: 'Wire & KV' },
      { id: 'tools-mcp-ptc', role: 'Tools/MCP' },
      { id: 'swarm-memory', role: 'Memory/Swarm' },
      { id: 'studio-backend', role: 'Backend' },
      { id: 'studio-ui-ide', role: 'UI/TUI/Native' },
      { id: 'verifier', role: 'Verifier' },
    ];

    const cx = w / 2;
    const cy = h / 2 - 4;
    const rx = Math.max(110, w * 0.36);
    const ry = Math.max(84, h * 0.31);
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
    const borderColor = cs.getPropertyValue('--border-accent').trim() || 'rgba(56, 189, 248, 0.45)';

    // Bidirectional duplex edges
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = 1.4;
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

    for (const n of list) {
      const p = pos.get(n.id)!;
      ctx.fillStyle = panelFill;
      ctx.strokeStyle = n.id === 'verifier' ? amberColor : cyanColor;
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
  };

  const refreshGraph = async () => {
    const res = await api.getGraphSnapshot();
    if (res.ok) {
      const n = Array.isArray(res.data.nodes) ? (res.data.nodes as any[]) : [];
      const e = Array.isArray(res.data.edges) ? (res.data.edges as any[]) : [];
      setNodes(n);
      setEdges(e);
      drawMesh(n, e);
    } else {
      drawMesh([], []);
    }
  };

  onMount(() => {
    void refreshGraph();
  });

  createEffect(() => {
    themePref();
    drawMesh(nodes(), edges());
  });

  const handleDispatch = async () => {
    if (!msgPayload().trim()) return;
    const res = await api.sendPeerMessage(fromPeer(), toPeer(), msgPayload(), 4);
    if (res.ok) {
      setStatusMsg(`Dispatched duplex message ${fromPeer()} <-> ${toPeer()}`);
      setMsgPayload('');
      await refreshGraph();
    } else {
      setStatusMsg(`Dispatch error: ${res.error.message}`);
    }
  };

  const handleTraverse = async () => {
    const res = await api.traverseGraphify(graphifyNode(), graphifyDir(), 2);
    if (res.ok) {
      setGraphifyResult(res.data);
    }
  };

  return (
    <div data-testid="swarm-workbench" class="flex-1 min-h-0 overflow-y-auto p-4 grid grid-cols-1 lg:grid-cols-2 gap-4 bg-[var(--bg-canvas)]">
      {/* 2-Way PeerMeshGraph Canvas + Dispatch */}
      <div class="omnia-surface-panel rounded-lg p-3.5 flex flex-col gap-3">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2 font-bold text-[13.5px]">
            <Network class="w-4 h-4 text-[var(--accent-cyan)]" />
            <span>2-Way All-to-All PeerMeshGraph (max_hops & epoch guarded)</span>
          </div>
          <button type="button" class="omnia-btn text-[11px]" onClick={() => void refreshGraph()}>
            <RefreshCw class="w-3.5 h-3.5" />
          </button>
        </div>

        <canvas ref={canvasRef} class="w-full h-72 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)]" />

        <div class="flex flex-wrap gap-2 text-[12px]">
          <input
            type="text"
            value={fromPeer()}
            onInput={(e) => setFromPeer(e.currentTarget.value)}
            class="w-32 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1 font-mono-num"
          />
          <span class="self-center text-[var(--ink-muted)]">&lt;-&gt;</span>
          <input
            type="text"
            value={toPeer()}
            onInput={(e) => setToPeer(e.currentTarget.value)}
            class="w-32 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1 font-mono-num"
          />
          <input
            type="text"
            placeholder="Duplex message..."
            value={msgPayload()}
            onInput={(e) => setMsgPayload(e.currentTarget.value)}
            class="flex-1 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1"
          />
          <button type="button" class="omnia-btn omnia-btn-primary text-[11.5px]" onClick={() => void handleDispatch()}>
            <Send class="w-3.5 h-3.5" />
            <span>Send</span>
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
          <span>Graphify Bidirectional Traversal (EXTRACTED / INFERRED / AMBIGUOUS)</span>
        </div>

        <div class="flex flex-wrap gap-2 text-[12px]">
          <input
            type="text"
            value={graphifyNode()}
            onInput={(e) => setGraphifyNode(e.currentTarget.value)}
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

        <pre class="flex-1 min-h-[240px] p-3 rounded border border-[var(--border-subtle)] bg-[var(--bg-code)] text-[11.5px] font-mono-num overflow-auto whitespace-pre-wrap">
          {JSON.stringify(graphifyResult() ?? { hint: 'Run Graphify traversal to inspect deterministic CST edges & quarantined AMBIGUOUS links.' }, null, 2)}
        </pre>
      </div>
    </div>
  );
}
