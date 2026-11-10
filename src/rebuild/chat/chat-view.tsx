import { useEffect, useMemo, useRef, useState } from "react";
import { Bot, ChevronDown, CircleStop, FolderOpen, GitBranch, MoreHorizontal, Paperclip, Play, Send, Settings2, ShieldAlert, Sparkles, SquarePen, X } from "lucide-react";
import type { ChatController, ChatEffort } from "./chat-controller";
import "./chat-view.css";

const efforts: ChatEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

export function ChatView({ controller, compact = false, onOpenSettings = () => undefined, onOpenIde = () => undefined }: { controller: ChatController; compact?: boolean; onOpenSettings?: () => void; onOpenIde?: () => void }) {
  const [showDetails, setShowDetails] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [rename, setRename] = useState(controller.activeSession.title);
  const [projectInput, setProjectInput] = useState("");
  const [projectPanelOpen, setProjectPanelOpen] = useState(false);
  const [questionDrafts, setQuestionDrafts] = useState<Record<string, string>>({});
  const [steerOpen, setSteerOpen] = useState(false);
  const [steer, setSteer] = useState("");
  const renameTriggerRef = useRef<HTMLButtonElement | null>(null);
  const renameDialogRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!renameOpen) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      const dialog = renameDialogRef.current;
      if (!dialog) return;
      if (event.key === "Escape") {
        event.preventDefault();
        setRenameOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])"));
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const active = document.activeElement;
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    const keepFocusInside = (event: FocusEvent) => {
      const dialog = renameDialogRef.current;
      if (!dialog || !(event.target instanceof Node) || dialog.contains(event.target)) return;
      const input = dialog.querySelector<HTMLInputElement>("#rb-rename-session");
      (input ?? dialog).focus();
    };
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("focusin", keepFocusInside);
    const firstInput = renameDialogRef.current?.querySelector<HTMLInputElement>("#rb-rename-session");
    firstInput?.focus();
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("focusin", keepFocusInside);
      if (renameTriggerRef.current && document.contains(renameTriggerRef.current)) renameTriggerRef.current.focus();
    };
  }, [renameOpen]);
  const canSend = Boolean(controller.draft.trim()) && !controller.activeSession.running;
  const statusText = useMemo(() => controller.status === "disconnected" ? "Core disconnected" : controller.status === "running" ? "Agent running" : controller.native ? "Native session ready" : "Draft workspace", [controller.native, controller.status]);
  const createProject = async () => {
    const cwd = projectInput.trim();
    // A project path is deliberately explicit. The clean-room preview has no
    // native picker, so never seed a fake workspace or silently attach one.
    if (!cwd || !(/^[a-zA-Z]:[\\/]/.test(cwd) || /^\\\\/.test(cwd) || /^\//.test(cwd))) return;
    await controller.createSession(cwd);
    setProjectInput("");
    setProjectPanelOpen(false);
  };
  return <div className={`rb-chat-view ${compact ? "rb-chat-view--compact" : ""}`}>
    <div className="rb-chat-toolbar">
      <div className="rb-chat-scope"><span className="rb-live-dot" /><span>{controller.activeSession.scope === "project" ? "Project session" : "Non-project chat"}</span><span className="rb-chat-status">{statusText}</span></div>
      <div className="rb-chat-actions"><button className="rb-quiet-button" type="button" onClick={() => setShowDetails((value) => !value)} aria-expanded={showDetails}><Sparkles size={14} /> Workflow <ChevronDown size={13} /></button><button className="rb-quiet-button" type="button" onClick={onOpenSettings}><Settings2 size={14} /> Settings</button></div>
    </div>
    <section className="rb-chat-hero" aria-label="Chat workspace">
      <div className="rb-chat-hero-mark"><Bot size={22} /></div><div><p className="rb-eyebrow">Omnia workspace</p><h1>{controller.activeSession.title}</h1><p className="rb-chat-subtitle">A single thread across projects, browser research and local files.</p></div>
      <button ref={renameTriggerRef} type="button" className="rb-icon-button" onClick={() => { setRename(controller.activeSession.title); setRenameOpen(true); }} aria-label="Rename session"><MoreHorizontal size={17} /></button>
    </section>
    {showDetails ? <div className="rb-workflow-strip"><div><strong>Plan</strong><span>Atomic task graph is visible as work starts.</span></div><div><strong>Evidence</strong><span>Done requires current source and runtime receipts.</span></div><div><strong>Context</strong><span>200k compact budget · 10k tool output.</span></div></div> : null}
    {controller.error ? <div className="rb-chat-notice" role="status"><ShieldAlert size={16} /><span>{controller.error}</span><button type="button" className="rb-icon-button" onClick={() => void controller.refresh()} aria-label="Retry connection"><Play size={14} /></button></div> : null}
    {!controller.messages.length ? <div className="rb-chat-empty"><div className="rb-empty-grid"><span>Ask for a plan</span><span>Inspect a repository</span><span>Research a paper</span><span>Review a diff</span></div><p>Start in a non-project thread, then attach folders or files only when the task needs them.</p></div> : <div className="rb-message-list" aria-live="polite">{controller.messages.map((message) => <article className={`rb-message rb-message--${message.role}`} key={message.id}><div className="rb-message-avatar">{message.role === "user" ? "you" : message.role === "tool" ? "tool" : "AI"}</div><div className="rb-message-body"><div className="rb-message-meta"><strong>{message.role === "user" ? "You" : message.role === "tool" ? "Tool" : "Omnia"}</strong><span>{message.timestamp ? new Date(message.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "replayed"}</span></div><p>{message.text || "…"}</p>{message.blocks?.filter((block) => block.kind !== "text").map((block, index) => <details className="rb-message-detail" key={`${message.id}-block-${index}`}><summary>{block.label ?? block.kind}</summary><pre>{block.text}</pre></details>)}</div></article>)}</div>}
    {controller.approvals.length ? <div className="rb-approval-stack">{controller.approvals.map((approval) => <div className="rb-approval" key={approval.id}><div><strong>Permission requested · {approval.tool}</strong><p>{approval.summary}</p></div><div className="rb-approval-actions"><button type="button" onClick={() => void controller.approve(approval.id, "deny")}>Deny</button><button type="button" className="rb-primary-button" onClick={() => void controller.approve(approval.id, "allow_once")}>Allow once</button></div></div>)}</div> : null}
    {controller.questions.length ? <div className="rb-question-stack">{controller.questions.map((question) => {
      const allowFreeText = question.allowFreeText === true;
      const draft = questionDrafts[question.id] ?? "";
      return <div className="rb-question" key={question.id}><strong>{question.prompt}</strong><div>{question.options.map((option) => <button key={option} type="button" className="rb-option-button" onClick={() => void controller.answerQuestion(question.id, option)}>{question.recommended?.includes(option) ? `Recommended · ${option}` : option}</button>)}{allowFreeText ? <><input aria-label={`Answer ${question.id}`} value={draft} onChange={(event) => setQuestionDrafts((current) => ({ ...current, [question.id]: event.target.value }))} placeholder="Or write your own answer…" /><button type="button" className="rb-primary-button" disabled={!draft.trim()} onClick={() => { void controller.answerQuestion(question.id, draft); setQuestionDrafts((current) => ({ ...current, [question.id]: "" })); }}>Submit</button></> : <span className="rb-question-capability" role="status">Free-text answers are disabled for this question.</span>}<button type="button" className="rb-quiet-button" onClick={() => void controller.answerQuestion(question.id, null)}>Cancel</button></div></div>;
    })}</div> : null}
    <div className="rb-composer-wrap"><div className="rb-composer-meta"><label>Model <select value={controller.activeSession.model} onChange={(event) => void controller.updateSettings({ model: event.target.value })}><option value="auto">Auto route</option><option value="local">Local model</option><option value="frontier">Frontier pool</option></select></label><label>Effort <select value={controller.activeSession.effort ?? "medium"} onChange={(event) => void controller.updateSettings({ effort: event.target.value as ChatEffort })}>{efforts.map((effort) => <option key={effort} value={effort}>{effort === "ultra" ? "ultra · dynamic" : effort}</option>)}</select></label><span className="rb-composer-scope">{controller.activeSession.scope === "project" ? controller.activeSession.cwd : "No folder attached"}</span></div><textarea value={controller.draft} onChange={(event) => controller.setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void controller.send(); } }} placeholder="Describe what you want Omnia to investigate or build…" aria-label="Message composer" /><div className="rb-composer-footer"><div className="rb-composer-tools"><button type="button" className="rb-icon-button" aria-label="Attach files" onClick={() => onOpenIde()}><Paperclip size={16} /></button><button type="button" className="rb-quiet-button" onClick={() => setSteerOpen((value) => !value)}><GitBranch size={14} /> {controller.activeSession.running ? "Steer" : "Queue"}</button><button type="button" className="rb-quiet-button" onClick={() => setProjectPanelOpen((value) => !value)} aria-expanded={projectPanelOpen}><FolderOpen size={14} /> Attach project</button></div><div className="rb-composer-submit"><span>Ctrl/⌘ + Enter</span>{controller.activeSession.running ? <button type="button" className="rb-stop-button" onClick={() => void controller.interrupt()}><CircleStop size={15} /> Stop</button> : <button type="button" className="rb-primary-button" disabled={!canSend} onClick={() => void controller.send()}><Send size={15} /> Send</button>}</div></div></div>
    {projectPanelOpen ? <div className="rb-inline-panel"><FolderOpen size={15} /><div className="rb-inline-copy"><strong>Attach a project folder</strong><small>Enter an absolute path. Native picker and permission receipt are available only in the connected desktop runtime.</small></div><input autoFocus value={projectInput} onChange={(event) => setProjectInput(event.target.value)} placeholder="C:\\workspaces\\project" aria-label="Project folder path" /><button type="button" className="rb-primary-button" disabled={!(/^[a-zA-Z]:[\\/]/.test(projectInput.trim()) || /^\\\\/.test(projectInput.trim()) || /^\//.test(projectInput.trim()))} onClick={() => void createProject()}>Open project</button><button type="button" className="rb-icon-button" onClick={() => { setProjectInput(""); setProjectPanelOpen(false); }} aria-label="Cancel project"><X size={14} /></button></div> : null}
    {steerOpen ? <div className="rb-inline-panel"><GitBranch size={15} /><input autoFocus value={steer} onChange={(event) => setSteer(event.target.value)} placeholder="Send a steering note while work runs" aria-label="Steering note" /><button type="button" className="rb-primary-button" onClick={() => { void controller.steer(steer); setSteer(""); setSteerOpen(false); }}>Add</button></div> : null}
    {renameOpen ? <div className="rb-modal-backdrop" role="presentation"><div ref={renameDialogRef} className="rb-modal" role="dialog" aria-modal="true" aria-labelledby="rb-rename-title" tabIndex={-1}><div className="rb-modal-head"><strong id="rb-rename-title">Rename session</strong><button type="button" className="rb-icon-button" onClick={() => setRenameOpen(false)} aria-label="Close rename dialog"><X size={15} /></button></div><label htmlFor="rb-rename-session">Session name</label><input id="rb-rename-session" autoFocus value={rename} onChange={(event) => setRename(event.target.value)} /><button type="button" className="rb-primary-button" onClick={() => { void controller.renameSession(rename); setRenameOpen(false); }}>Save name</button></div></div> : null}
  </div>;
}

export function SessionList({ controller }: { controller: ChatController }) { return <aside className="rb-session-list" aria-label="Sessions"><div className="rb-session-list-head"><span>Threads</span><button type="button" className="rb-icon-button" aria-label="New chat" onClick={() => void controller.createSession()}><SquarePen size={15} /></button></div><div className="rb-session-items">{controller.sessions.map((session) => <button key={session.id} type="button" className={`rb-session-row ${session.id === controller.activeId ? "is-active" : ""}`} onClick={() => controller.selectSession(session.id)}><span className={`rb-session-state ${session.running ? "is-running" : ""}`} /><span className="rb-session-copy"><strong>{session.title}</strong><small>{session.scope === "project" ? "project" : "non-project"} · {session.model}</small></span>{session.running ? <span className="rb-session-live">run</span> : null}</button>)}</div></aside>; }
