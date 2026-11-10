import { useEffect, useMemo, useRef, useState } from "react";
import { desktop, isDesktopRuntime, type CreateProjectRequest, type ProjectRecord } from "@/lib/desktop";

export interface WorkspaceProjectPort {
  available: boolean;
  initialize: () => Promise<unknown>;
  list: () => Promise<ProjectRecord[]>;
  create: (request: CreateProjectRequest) => Promise<ProjectRecord>;
}

export const nativeWorkspaceProjectPort: WorkspaceProjectPort = {
  available: isDesktopRuntime(),
  initialize: () => desktop.runtimeInfo().then(info => desktop.initializeCore(info.appVersion)),
  list: () => desktop.listProjects(),
  create: request => desktop.createProject(request),
};

function validProject(value: unknown): value is ProjectRecord {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<ProjectRecord>;
  return typeof row.id === "string" && row.id.trim().length > 0 && typeof row.name === "string" && row.name.trim().length > 0;
}

export function WorkspaceProjects({ port = nativeWorkspaceProjectPort, selected, onSelect }: { port?: WorkspaceProjectPort; selected: ProjectRecord | null; onSelect: (project: ProjectRecord | null) => void }) {
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unknown, setUnknown] = useState(false);
  const [generation, setGeneration] = useState(0);
  const epoch = useRef(0);
  const stablePort = useMemo(() => port, [port]);
  useEffect(() => {
    let live = true; const current = ++epoch.current;
    setLoading(true); setError(null); setCreating(false);
    if (!stablePort.available) { setLoading(false); return () => { live = false; ++epoch.current; }; }
    void stablePort.initialize().then(() => stablePort.list()).then(rows => {
      if (!live || current !== epoch.current) return;
      if (!Array.isArray(rows) || !rows.every(validProject)) throw new Error("Invalid native project record received.");
      setProjects(rows); setLoading(false); setUnknown(false);
    }).catch(cause => {
      if (!live || current !== epoch.current) return;
      setLoading(false); setError(cause instanceof Error ? cause.message : "Invalid native project response.");
    });
    return () => { live = false; ++epoch.current; };
  }, [stablePort, generation]);
  const reload = () => setGeneration(value => value + 1);
  const submit = async () => {
    const trimmed = name.trim(); if (!trimmed || creating || unknown || !stablePort.available) return;
    const token = epoch.current;
    setCreating(true); setError(null);
    try {
      const created = await stablePort.create({ name: trimmed });
      if (token !== epoch.current) return;
      if (!validProject(created)) throw new Error("Invalid native project response.");
      setProjects(rows => [...rows.filter(row => row.id !== created.id), created]); setName(""); onSelect(created);
    } catch (cause) {
      if (token !== epoch.current) return;
      setUnknown(true); setError(`Project creation outcome is unknown: ${cause instanceof Error ? cause.message : "native transport failed"}. Reload before retrying.`);
    } finally { if (token === epoch.current) setCreating(false); }
  };
  const status = !stablePort.available ? "Project selection requires the Tauri desktop runtime; browser preview cannot invent a project." : loading ? "Loading native projects…" : error ? error : projects.length ? "Native project scope is explicit; choose a project for context." : "No native projects yet. Create one when the task needs a durable scope.";
  return <section className="rb-project-picker" aria-label="Workspace project scope">
    <label htmlFor="rb-context-project">Project scope</label>
    <select id="rb-context-project" aria-label="Context project" value={selected?.id ?? ""} disabled={!stablePort.available || loading || Boolean(error)} onChange={event => onSelect(projects.find(row => row.id === event.target.value) ?? null)}>
      <option value="">No project · projectless chat</option>{projects.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}
    </select>
    <div className="rb-project-picker__create"><input aria-label="New project name" value={name} onChange={event => setName(event.target.value)} placeholder="New durable project" disabled={!stablePort.available || loading || unknown} /><button type="button" onClick={() => void submit()} disabled={!stablePort.available || loading || !name.trim() || creating || unknown}>Create project</button></div>
    <div className="rb-project-picker__status" role="status" aria-live="polite">{status}</div>
    {error ? <div role="alert" tabIndex={-1}>{error}</div> : null}
    {stablePort.available && (error || unknown) ? <button type="button" onClick={reload}>Reload projects</button> : null}
  </section>;
}
