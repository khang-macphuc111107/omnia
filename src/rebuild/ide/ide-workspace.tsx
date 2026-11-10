import { useEffect, useMemo, useRef, useState } from "react";
import { FileCode2, FileText, FolderOpen, RefreshCw, Save, Search, ShieldCheck, X } from "lucide-react";
import { createIdeAccess, type IdeAccess } from "./ide-access";
import { completeTabSave, createTab, describeIdeError, editTab, findInText, isTabDirty, languageForPath, serializeEditorText, tokenizeSource, type IdeEntry, type IdeRoot, type IdeTab } from "./ide-model";
import "./ide-workspace.css";

interface DirtyDecision { tab: IdeTab; action: "close" | "reload" }
function sameTab(left: IdeTab, right: IdeTab): boolean { return left.instanceId === right.instanceId; }
function codeOf(error: unknown): string { return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : ""; }

export function IdeWorkspace({ access }: { access?: IdeAccess }) {
  const resolvedAccess = useMemo(() => access ?? createIdeAccess(), [access]);
  const [roots, setRoots] = useState<IdeRoot[]>([]);
  const [root, setRoot] = useState<IdeRoot | null>(null);
  const [relativePath, setRelativePath] = useState("");
  const [entries, setEntries] = useState<IdeEntry[]>([]);
  const [tabs, setTabs] = useState<IdeTab[]>([]);
  const [activeId, setActiveId] = useState("");
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [decision, setDecision] = useState<DirtyDecision | null>(null);
  const [permissionBusy, setPermissionBusy] = useState(false);
  const tabsRef = useRef(tabs); tabsRef.current = tabs;
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const mirrorRef = useRef<HTMLPreElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const decisionRef = useRef<HTMLDivElement>(null);
  const saving = useRef(new Set<number>());
  const sourceChecks = useRef(new Map<number, number>());
  const directoryGeneration = useRef(0);
  const lifecycle = useRef(0);
  const active = tabs.find((tab) => tab.document.id === activeId) ?? tabs[0] ?? null;

  useEffect(() => {
    const generation = ++lifecycle.current;
    void resolvedAccess.listRoots().then((next) => { if (generation === lifecycle.current) setRoots(next); }).catch((error) => { if (generation === lifecycle.current) setNotice(describeIdeError(error)); });
    return () => { lifecycle.current += 1; directoryGeneration.current += 1; };
  }, [resolvedAccess]);
  useEffect(() => { if (decision) decisionRef.current?.querySelector<HTMLButtonElement>("button")?.focus(); }, [decision]);

  const updateTab = (target: IdeTab, update: (tab: IdeTab) => IdeTab) => setTabs((current) => current.map((tab) => sameTab(tab, target) ? update(tab) : tab));
  const refreshRoots = async () => { try { setRoots(await resolvedAccess.listRoots()); } catch (error) { setNotice(describeIdeError(error)); } };
  const openDirectory = async (nextRoot: IdeRoot, path: string) => {
    const generation = ++directoryGeneration.current;
    try {
      const listing = await resolvedAccess.listDirectory(nextRoot.id, path);
      if (generation !== directoryGeneration.current) return;
      setEntries(listing.entries); setRelativePath(listing.relativePath);
      setNotice(listing.truncated ? "Directory listing truncated at 2,000 entries." : null);
    } catch (error) { if (generation === directoryGeneration.current) setNotice(describeIdeError(error)); }
  };
  const openRoot = async (next: IdeRoot) => { setRoot(next); setEntries([]); setRelativePath(""); await openDirectory(next, ""); };
  const pick = async () => {
    try { const next = await resolvedAccess.pickFolder(); if (next) { setRoots((current) => [next, ...current.filter((item) => item.id !== next.id)]); await openRoot(next); } }
    catch (error) { setNotice(describeIdeError(error)); }
  };
  const openEntry = async (entry: IdeEntry) => {
    if (entry.kind === "directory") { if (root) await openDirectory(root, entry.relativePath); return; }
    const generation = lifecycle.current;
    try {
      const doc = await resolvedAccess.readFile(entry);
      if (generation !== lifecycle.current) return;
      setTabs((current) => current.some((tab) => tab.document.id === doc.id) ? current : [createTab(doc), ...current]);
      setActiveId(doc.id); setNotice(null);
    } catch (error) { if (generation === lifecycle.current) setNotice(describeIdeError(error)); }
  };

  const save = async (target: IdeTab | null = active): Promise<boolean> => {
    if (!target || target.saving || target.checking || saving.current.has(target.instanceId) || target.document.saveMode !== "original" || target.sourceState !== "current" || !isTabDirty(target)) return false;
    const generation = lifecycle.current;
    const submitted = target.content;
    saving.current.add(target.instanceId);
    updateTab(target, (tab) => ({ ...tab, saving: true }));
    try {
      const saved = await resolvedAccess.saveFile(target.document, target.document.content, serializeEditorText(submitted, target.document.content));
      if (generation !== lifecycle.current) return false;
      const current = tabsRef.current.find((tab) => sameTab(tab, target));
      updateTab(target, (tab) => completeTabSave(tab, saved, submitted));
      setNotice(current?.content === submitted ? "Saved snapshot verified by readback." : "Saved snapshot verified by readback. Newer edits remain in this tab.");
      return current?.content === submitted;
    } catch (error) {
      if (generation !== lifecycle.current) return false;
      const code = codeOf(error);
      updateTab(target, (tab) => ({ ...tab, document: code === "ide_write_permission_denied" ? { ...tab.document, saveMode: "copy" } : tab.document, saving: false, conflict: describeIdeError(error), sourceState: code === "source_missing" || code === "ide_source_missing" ? "missing" : code === "save_conflict" ? "changed" : ["permission_denied", "ide_write_permission_denied", "ide_permission_denied", "ide_file_in_use"].includes(code) ? tab.sourceState : "unknown" }));
      setNotice(describeIdeError(error)); return false;
    } finally { saving.current.delete(target.instanceId); }
  };

  const checkSource = async (target: IdeTab, discard = false) => {
    if (target.saving || saving.current.has(target.instanceId)) return;
    const check = (sourceChecks.current.get(target.instanceId) ?? 0) + 1;
    sourceChecks.current.set(target.instanceId, check);
    const generation = lifecycle.current;
    updateTab(target, (tab) => ({ ...tab, checking: true }));
    try {
      const doc = await resolvedAccess.readFile(target.document);
      if (generation !== lifecycle.current || sourceChecks.current.get(target.instanceId) !== check) return;
      updateTab(target, (tab) => {
        const editedDuringRead = tab.editRevision !== target.editRevision;
        if (doc.version === tab.document.version && doc.content === tab.document.content && !discard) return { ...tab, checking: false, sourceState: "current", sourceSnapshot: null, conflict: null };
        if (editedDuringRead || (isTabDirty(tab) && !discard)) return { ...tab, checking: false, sourceState: "changed", sourceSnapshot: doc, conflict: "Source changed outside Omnia; your dirty buffer is retained. Compare, export or reload after review." };
        return createTab(doc);
      });
    } catch (error) {
      if (generation !== lifecycle.current || sourceChecks.current.get(target.instanceId) !== check) return;
      const missing = ["source_missing", "ide_source_missing"].includes(codeOf(error));
      updateTab(target, (tab) => ({ ...tab, checking: false, sourceState: missing ? "missing" : "unknown", conflict: describeIdeError(error) }));
      setNotice(describeIdeError(error));
    }
  };

  const closeTab = (target: IdeTab) => {
    if (target.saving || target.checking) return;
    if (isTabDirty(target)) setDecision({ tab: target, action: "close" });
    else setTabs((current) => current.filter((tab) => !sameTab(tab, target)));
  };
  const reload = (target: IdeTab) => { if (isTabDirty(target)) setDecision({ tab: target, action: "reload" }); else void checkSource(target, true); };
  const dismissDecision = () => { setDecision(null); window.setTimeout(() => editorRef.current?.focus(), 0); };
  const discard = () => {
    if (!decision) return;
    const latest = tabsRef.current.find((tab) => sameTab(tab, decision.tab));
    if (latest && !latest.saving) {
      if (decision.action === "close") setTabs((current) => current.filter((tab) => !sameTab(tab, latest)));
      else void checkSource(latest, true);
    }
    dismissDecision();
  };
  const allowSaving = async (target: IdeTab) => {
    if (!resolvedAccess.requestWriteAccess || permissionBusy) return;
    setPermissionBusy(true);
    try {
      if (await resolvedAccess.requestWriteAccess(target.document.rootId)) {
        setTabs((current) => current.map((tab) => tab.document.rootId === target.document.rootId ? { ...tab, document: { ...tab.document, saveMode: "original" } } : tab));
        await refreshRoots(); setNotice("Saving allowed for this folder for the current app session.");
      } else setNotice("Write approval canceled. The folder remains read-only and your edits are retained.");
    } catch (error) { setNotice(describeIdeError(error)); }
    finally { setPermissionBusy(false); }
  };
  const revokeSaving = async (target: IdeTab) => {
    try { await resolvedAccess.revokeWriteAccess?.(target.document.rootId); }
    catch (error) { setNotice(describeIdeError(error)); }
    finally {
      setTabs((current) => current.map((tab) => tab.document.rootId === target.document.rootId ? { ...tab, document: { ...tab.document, saveMode: "copy" } } : tab));
      await refreshRoots();
    }
  };

  const filtered = entries.filter((entry) => !query || entry.relativePath.toLowerCase().includes(query.toLowerCase()));
  const tokens = useMemo(() => active ? tokenizeSource(active.content) : [], [active?.content]);
  return <section className="rb-ide" aria-label="Omnia local IDE workspace" onKeyDown={(event) => {
    if (decision) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void save(); }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") { event.preventDefault(); filterRef.current?.focus(); }
  }}>
    <header className="rb-ide-head">
      <div className="rb-ide-title"><FileCode2 size={17} /><strong>IDE</strong><span>{resolvedAccess.native ? "native grants" : "local handles"}</span></div>
      <div className="rb-ide-head-actions"><button type="button" className="rb-ide-button" onClick={() => void pick()}><FolderOpen size={14} /> Open folder</button><button type="button" className="rb-ide-icon" aria-label="Refresh roots" onClick={() => void refreshRoots()}><RefreshCw size={14} /></button></div>
    </header>
    <div className="rb-ide-rootbar">
      {roots.map((item) => <button key={item.id} type="button" className={`rb-ide-root ${item.id === root?.id ? "is-active" : ""}`} onClick={() => void openRoot(item)}>{item.name}<small>{item.readOnly ? "read only" : item.displayPath}</small></button>)}
      {root && relativePath ? <button type="button" className="rb-ide-icon" aria-label="Up one folder" onClick={() => void openDirectory(root, relativePath.split("/").slice(0, -1).join("/"))}>↑</button> : null}
      {!roots.length ? <span className="rb-ide-muted">No folder attached. Choose one to inspect local files.</span> : null}
    </div>
    <div className="rb-ide-body">
      <aside className="rb-ide-explorer" aria-label="File explorer">
        <div className="rb-ide-explorer-head"><span>Explorer{relativePath ? ` / ${relativePath}` : ""}</span><label><Search size={12} /><input ref={filterRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter" aria-label="Filter files" /></label></div>
        <div className="rb-ide-files">{filtered.map((entry) => <button key={entry.relativePath} type="button" className="rb-ide-file" onClick={() => void openEntry(entry)}><FileText size={13} /><span>{entry.name}</span></button>)}{root && !filtered.length ? <span className="rb-ide-muted">No matching files.</span> : null}</div>
      </aside>
      <div className="rb-ide-editor">
        <div className="rb-ide-tabs">{tabs.map((tab) => <div key={tab.instanceId} className={`rb-ide-tab-group ${sameTab(tab, active ?? tab) ? "is-active" : ""}`}><button type="button" className={`rb-ide-tab ${sameTab(tab, active ?? tab) ? "is-active" : ""}`} onClick={() => setActiveId(tab.document.id)}>{isTabDirty(tab) ? "● " : ""}{tab.document.name}</button><button type="button" className="rb-ide-close" disabled={tab.saving || tab.checking} aria-label={`Close ${tab.document.name}`} onClick={() => closeTab(tab)}><X size={12} /></button></div>)}</div>
        {active ? <>
          <div className="rb-ide-editor-bar">
            <span>{active.document.relativePath}</span><span>{languageForPath(active.document.relativePath)}</span>
            <button type="button" className="rb-ide-button" disabled={active.saving || active.checking} onClick={() => void checkSource(active)}>{active.checking ? "Checking" : "Check source"}</button>
            <button type="button" className="rb-ide-button" disabled={active.saving || active.checking || active.sourceState === "missing"} onClick={() => reload(active)}>Reload source</button>
            {active.document.saveMode === "copy" || active.sourceState !== "current" ? <button type="button" className="rb-ide-button" onClick={() => resolvedAccess.exportCopy(active.document, serializeEditorText(active.content, active.document.content))}>Export copy</button> : null}
            {active.document.origin === "native" && resolvedAccess.requestWriteAccess && active.document.saveMode === "copy" ? <button type="button" className="rb-ide-button" disabled={permissionBusy} onClick={() => void allowSaving(active)}>{permissionBusy ? "Awaiting approval" : "Allow saving"}</button> : null}
            {active.document.origin === "native" && active.document.saveMode === "original" && resolvedAccess.revokeWriteAccess ? <button type="button" className="rb-ide-button" disabled={active.saving} onClick={() => void revokeSaving(active)}>Revoke saving</button> : null}
            <button type="button" className="rb-ide-button" disabled={!isTabDirty(active) || active.saving || active.checking || active.document.saveMode === "copy" || active.sourceState !== "current"} onClick={() => void save()}><Save size={13} /> {active.saving ? "Saving" : "Save"}</button>
          </div>
          <div className="rb-ide-code"><textarea ref={editorRef} aria-label={`Code editor · ${active.document.name}`} value={active.content} onChange={(event) => { const content = event.target.value; updateTab(active, (tab) => editTab(tab, content)); }} onScroll={(event) => { if (mirrorRef.current) { mirrorRef.current.scrollTop = event.currentTarget.scrollTop; mirrorRef.current.scrollLeft = event.currentTarget.scrollLeft; } }} spellCheck={false} /><pre ref={mirrorRef} aria-hidden="true">{tokens.map((token, index) => <span className={`rb-token-${token.kind}`} key={`${index}-${token.text.slice(0, 4)}`}>{token.text}</span>)}</pre></div>
          {active.document.saveMode === "copy" ? <div className="rb-ide-status">Read grant active · edits are local until you export a copy</div> : <div className="rb-ide-status">{active.document.origin === "native" ? "Session write approval active · hash checked native save" : "Browser file handle · external changes checked before save"}</div>}
          {active.conflict ? <div className="rb-ide-conflict" role="status"><ShieldCheck size={14} /> {active.conflict}</div> : null}
          {active.sourceSnapshot ? <details className="rb-ide-compare"><summary>Compare source snapshot</summary><textarea aria-label="Changed source snapshot" value={active.sourceSnapshot.content} readOnly /></details> : null}
          <div className="rb-ide-status">{findInText(active.content, query).length} matches · edits stay in this tab until saved</div>
        </> : <div className="rb-ide-empty"><FileCode2 size={26} /><strong>Select a file to inspect</strong><span>Omnia keeps local source access scoped to the selected grant.</span></div>}
      </div>
    </div>
    {notice ? <div className="rb-ide-notice" role="status">{notice}</div> : null}
    {decision ? <div className="rb-ide-decision-backdrop"><div ref={decisionRef} className="rb-ide-decision" role="alertdialog" aria-modal="true" aria-label={`Discard edits to ${decision.tab.document.name}?`} onKeyDown={(event) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); dismissDecision(); }
      if (event.key === "Tab") {
        const buttons = decisionRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)");
        if (buttons?.length) { const first = buttons[0]; const last = buttons[buttons.length - 1]; if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); } }
      }
    }}><strong>Keep the unsaved edits?</strong><p>{decision.tab.document.name} has a dirty buffer. Export a copy or save it before discarding.</p><div><button type="button" className="rb-ide-button" onClick={dismissDecision}>Keep editing</button><button type="button" className="rb-ide-button" onClick={() => resolvedAccess.exportCopy(decision.tab.document, serializeEditorText(decision.tab.content, decision.tab.document.content))}>Export copy</button><button type="button" className="rb-ide-button" onClick={discard}>{decision.action === "close" ? "Discard and close" : "Discard and reload"}</button></div></div></div> : null}
  </section>;
}

export default IdeWorkspace;
