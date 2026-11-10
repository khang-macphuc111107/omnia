import { ArrowDown, ArrowUp, MessageCircle, Pause, Play, Plus, Sparkles, Trash2 } from "lucide-react";
import { useState } from "react";

type Mode = "queue" | "steer" | "btw" | "discuss";
type Item = { id: number; title: string; goal: string; mode: Mode };

/** Renderer-only prompt orchestration rehearsal; no native scheduling or model call. */
export function GoalOrchestrationRail({ goal, announceStatus = true }: { goal: string; announceStatus?: boolean }) {
  const [items, setItems] = useState<Item[]>([]);
  const [active, setActive] = useState<Item | null>(null);
  const [sideNotes, setSideNotes] = useState<Item[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [nextId, setNextId] = useState(1);
  const [prompt, setPrompt] = useState("");
  const [message, setMessage] = useState("Queue and steer are renderer-local previews.");
  const selectedIndex = items.findIndex((item) => item.id === selectedId);
  const selected = items[selectedIndex];
  const enqueue = (mode: Mode) => {
    const title = prompt.trim();
    if (!title) { setMessage("Enter a prompt first."); return; }
    const item: Item = { id: nextId, title, goal, mode };
    if (mode === "steer") {
      // A steered preview occupies its own slot; it must not also appear in the queue.
      if (active) setItems((current) => [{ ...active, mode: "queue" }, ...current]);
      setActive(item);
      setSelectedId(active?.id ?? selectedId);
    } else if (mode === "btw" || mode === "discuss") {
      setSideNotes((current) => [...current, item]);
    } else {
      setItems((current) => [...current, item]);
      setSelectedId(item.id);
    }
    setNextId((value) => value + 1);
    setPrompt("");
    setMessage(`${mode === "steer" ? "Moved to active preview slot" : mode === "queue" ? "Added to preview queue" : "Added to the separate side-notes lane"}: ${title}`);
  };
  const move = (delta: number) => {
    const target = selectedIndex + delta;
    if (selectedIndex < 0 || target < 0 || target >= items.length) return;
    setItems((current) => {
      const next = [...current];
      const currentItem = next[selectedIndex];
      const targetItem = next[target];
      if (!currentItem || !targetItem) return current;
      [next[selectedIndex], next[target]] = [targetItem, currentItem];
      return next;
    });
    setMessage("Queue order changed in this renderer session.");
  };
  const steerSelected = () => {
    if (!selected) return;
    const remaining = items.filter((item) => item.id !== selected.id);
    setItems(active ? [{ ...active, mode: "queue" }, ...remaining] : remaining);
    setActive({ ...selected, mode: "steer" });
    setSelectedId(active?.id ?? remaining[0]?.id ?? null);
    setMessage(`Active preview slot: ${selected.title}`);
  };
  const returnActive = () => {
    if (!active) return;
    setItems((current) => [{ ...active, mode: "queue" }, ...current]);
    setSelectedId(active.id);
    setMessage(`Returned ${active.title} to the front of the preview queue.`);
    setActive(null);
  };
  const promoteSideNote = (note: Item) => {
    setSideNotes((current) => current.filter((item) => item.id !== note.id));
    setItems((current) => [...current, { ...note, mode: "queue" }]);
    setSelectedId(note.id);
    setMessage(`Promoted ${note.title} to the preview queue; no model was called.`);
  };
  const removeSelected = () => {
    if (!selected) return;
    const next = items.filter((item) => item.id !== selected.id);
    setItems(next);
    setSelectedId(next[Math.min(selectedIndex, next.length - 1)]?.id ?? null);
    setMessage(`Removed ${selected.title} from the preview.`);
  };
  return (
    <section className="goal-orchestration-rail" aria-label="Goal prompt orchestration">
      <header><div><span className="eyebrow"><Sparkles size={13} /> Prompt control</span><h3>Queue · Steer · Btw · Discuss</h3></div><span className="goal-orchestration-rail__counter" title="Selected queued item / queued total">{items.length ? selectedIndex + 1 : 0}/{items.length}</span></header>
      <label>Prompt for {goal}<textarea aria-label="Goal orchestration prompt" rows={2} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Write naturally, then choose how to route it…" /></label>
      <div className="goal-orchestration-rail__actions">
        <button type="button" className="button button--secondary" title="Add prompt to the end of the preview queue" onClick={() => enqueue("queue")}><Plus size={13} /> Queue</button>
        <button type="button" className="button button--ghost" title="Move prompt to the active preview slot; return the previous preview item to the front of the queue" onClick={() => enqueue("steer")}><Play size={13} /> Steer</button>
        <button type="button" className="button button--ghost" title="Keep a side note separate until you explicitly promote it" onClick={() => enqueue("btw")}><Sparkles size={13} /> Btw</button>
        <button type="button" className="button button--ghost" title="Keep a discussion prompt in side notes without dispatching a model" onClick={() => enqueue("discuss")}><MessageCircle size={13} /> Discuss</button>
      </div>
      <div className="goal-orchestration-rail__active" role="group" aria-label="Active preview slot">
        <span className="eyebrow">Active preview slot · no execution</span>
        {active ? <div><strong>{active.title}</strong><small>{active.goal} · steer preview</small><button type="button" className="button button--ghost" onClick={returnActive} title="Return the active preview item to the front of the queue">Return to queue</button></div> : <p>No steered prompt.</p>}
      </div>
      <div className="goal-orchestration-rail__queue" role="group" aria-label="Queued goal prompts">
        {items.length ? items.map((item, index) => (
          <button key={item.id} type="button" className={`goal-orchestration-rail__item${item.id === selectedId ? " is-selected" : ""}`} aria-pressed={item.id === selectedId} onClick={() => setSelectedId(item.id)} title={`Select ${item.mode} item ${index + 1}`}>
            <span>{index + 1}</span><strong>{item.title}</strong><small>{item.goal} · queued</small>
          </button>
        )) : <p>No queued prompt yet.</p>}
      </div>
      <details className="goal-orchestration-rail__side-notes"><summary title="Show Btw and Discuss notes, kept outside the queue">Side notes · {sideNotes.length}</summary>{sideNotes.length ? <ul>{sideNotes.map((note) => <li key={note.id}><div><strong>{note.title}</strong><small>{note.goal} · {note.mode}</small></div><button type="button" className="button button--ghost" title={`Promote ${note.title} into the preview queue`} onClick={() => promoteSideNote(note)}>Queue</button><button type="button" className="button button--ghost" title={`Remove side note ${note.title}`} onClick={() => { setSideNotes((current) => current.filter((item) => item.id !== note.id)); setMessage(`Removed side note: ${note.title}`); }}>Remove</button></li>)}</ul> : <p>Side questions and discussions stay here until promoted.</p>}</details>
      <div className="goal-orchestration-rail__queue-tools">
        <button type="button" className="button button--ghost" title="Move the selected item earlier" aria-label="Move selected goal prompt up" disabled={selectedIndex <= 0} onClick={() => move(-1)}><ArrowUp size={13} /></button>
        <button type="button" className="button button--ghost" title="Move the selected item later" aria-label="Move selected goal prompt down" disabled={selectedIndex < 0 || selectedIndex >= items.length - 1} onClick={() => move(1)}><ArrowDown size={13} /></button>
        <button type="button" className="button button--ghost" title="Promote selected item to the active preview slot" disabled={!selected} onClick={steerSelected}><Play size={13} /> Steer selected</button>
        <button type="button" className="button button--ghost" title="Remove selected preview item" aria-label="Remove selected goal prompt" disabled={!selected} onClick={removeSelected}><Trash2 size={13} /></button>
      </div>
      <p role={announceStatus ? "status" : undefined} aria-live="polite">{message}</p>
      <p className="goal-orchestration-rail__boundary"><Pause size={13} /> UI preview only: no model, agent, scheduler, durable queue, or goal mutation is wired here.</p>
    </section>
  );

}
