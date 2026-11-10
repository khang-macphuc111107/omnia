import { ArrowUp, FolderOpen, FolderPlus, LayoutGrid, MessageSquarePlus } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import "./home-start.css";

import type { ProviderProfileRecord } from "@/lib/desktop";

import { agentApi, errorMessage } from "./agent-api";
import { useAgentStore } from "./agent-store";
import { folderName, relativeTime } from "./format";
import { readPrefs, rememberFolder, writePrefs } from "./prefs";
import { HarnessStatus } from "./harness-status";
import type { ShellView } from "./shell-view";
import type { PermissionMode } from "./types";

const CHOOSE = "\u0000choose";
const RECENT_LIMIT = 5;

/** The Home hub with no session open: a composer that creates a session from its first message. */
export function HomeStart({ onNavigate, onOpenSettings }: { onNavigate: (view: ShellView) => void; onOpenSettings?: () => void }) {
  const sessions = useAgentStore((state) => state.sessions);
  const [prefs] = useState(readPrefs);
  const [extraFolders, setExtraFolders] = useState<string[]>(prefs.recentFolders);
  const [cwd, setCwd] = useState("");
  const [profiles, setProfiles] = useState<ProviderProfileRecord[]>([]);
  const [profileId, setProfileId] = useState(prefs.profileId ?? "");
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState(prefs.model ?? "");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const byRecency = useMemo(() => [...sessions].sort((a, b) => b.updatedAtMs - a.updatedAtMs), [sessions]);
  const projects = useMemo(() => [...new Set(byRecency.map((session) => session.cwd).filter(Boolean))], [byRecency]);
  const runningNow = useMemo(() => byRecency.filter((session) => session.running), [byRecency]);
  const folders = useMemo(() => [...new Set([...projects, ...extraFolders])], [projects, extraFolders]);

  // Default the folder to the most recent one once anything is known; never override a choice.
  useEffect(() => {
    if (!cwd && folders[0]) setCwd(folders[0]);
  }, [cwd, folders]);

  useEffect(() => {
    let live = true;
    agentApi
      .listProfiles()
      .then((list) => {
        if (!live) return;
        const enabled = list.filter((profile) => profile.enabled);
        setProfiles(enabled);
        setProfileId((current) => (enabled.some((p) => p.id === current) ? current : (enabled[0]?.id ?? "")));
      })
      .catch((cause) => live && setError(errorMessage(cause)));
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!profileId) return;
    let live = true;
    agentApi
      .listModels(profileId)
      .then((list) => {
        if (!live) return;
        const ids = list.map((entry) => entry.id);
        setModels(ids);
        setModel((current) => (current && (ids.length === 0 || ids.includes(current)) ? current : (ids[0] ?? current)));
      })
      .catch(() => live && setModels([]));
    return () => {
      live = false;
    };
  }, [profileId]);

  const chooseFolder = async () => {
    try {
      const picked = await agentApi.pickFolder();
      if (picked && alive.current) {
        setCwd(picked);
        setExtraFolders(rememberFolder(picked));
      }
    } catch (cause) {
      if (alive.current) setError(errorMessage(cause));
    }
  };

  const prompt = text.trim();
  const missing = !cwd ? "Choose a project folder to start" : !profileId ? "Add a provider profile in Settings to start" : !model.trim() ? "Choose a model to start" : null;
  const ready = !missing && prompt.length > 0 && !busy;

  const send = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const store = useAgentStore.getState();
      const permissionMode = (prefs.permissionMode as PermissionMode | undefined) ?? "ask_writes";
      await store.create({ cwd, profileId, model: model.trim(), permissionMode });
      rememberFolder(cwd);
      writePrefs({ profileId, model: model.trim() });
      const sessionId = useAgentStore.getState().activeId;
      if (!sessionId) throw new Error("The new session did not open.");
      await useAgentStore.getState().send(prompt, [], sessionId);
      if (alive.current) setText("");
    } catch (cause) {
      if (alive.current) setError(errorMessage(cause));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const modelOptions = model && !models.includes(model) ? [model, ...models] : models;

  return (
    <div className="ag-home">
      <div className="ag-home__inner">
        <h2 className="ag-home__title" id={`${id}-title`}>What should we work on?</h2>

        <form
          className="ag-home__composer"
          aria-labelledby={`${id}-title`}
          aria-busy={busy}
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <textarea
            ref={promptRef}
            className="ag-home__prompt"
            aria-label="Prompt"
            rows={4}
            value={text}
            disabled={busy}
            placeholder={missing ? `${missing}, then describe the task` : "Describe the task. Enter sends, Shift+Enter adds a line."}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.shiftKey) return;
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              event.preventDefault();
              void send();
            }}
          />
          <div className="ag-home__bar">
            <label className="ag-home__pick ag-home__pick--folder" title={cwd || undefined}>
              <FolderOpen size={14} aria-hidden="true" />
              <select
                aria-label="Project folder"
                value={cwd}
                disabled={busy}
                onChange={(event) => {
                  if (event.target.value === CHOOSE) void chooseFolder();
                  else setCwd(event.target.value);
                }}
              >
                {!cwd ? <option value="">No folder</option> : null}
                {folders.map((folder) => (
                  <option key={folder} value={folder} title={folder}>
                    {folderName(folder)}
                  </option>
                ))}
                <option value={CHOOSE}>Choose folder…</option>
              </select>
            </label>
            {profiles.length > 1 ? (
              <label className="ag-home__pick">
                <select aria-label="Provider" value={profileId} disabled={busy} onChange={(event) => setProfileId(event.target.value)}>
                  {profiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.displayName}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <label className="ag-home__pick" title={model || undefined}>
              {modelOptions.length > 0 ? (
                <select aria-label="Model" value={model} disabled={busy} onChange={(event) => setModel(event.target.value)}>
                  {modelOptions.map((entry) => (
                    <option key={entry} value={entry}>
                      {entry}
                    </option>
                  ))}
                </select>
              ) : (
                <input aria-label="Model" value={model} placeholder="Model id" disabled={busy || !profileId} onChange={(event) => setModel(event.target.value)} />
              )}
            </label>
            <span className="ag-spacer" />
            <button type="submit" className="ag-btn ag-btn--primary ag-home__send" disabled={!ready} aria-label="Send" title={missing ?? (prompt ? "Send" : "Type a prompt to send")}>
              <ArrowUp size={16} aria-hidden="true" />
            </button>
          </div>
        </form>
        {error ? <p className="ag-error" role="alert">{error}</p> : null}

        <div className="ag-home__actions">
          <button type="button" className="ag-btn ag-btn--ghost" onClick={() => promptRef.current?.focus()}>
            <MessageSquarePlus size={14} aria-hidden="true" /> New chat
          </button>
          <button type="button" className="ag-btn ag-btn--ghost" onClick={() => void chooseFolder()}>
            <FolderPlus size={14} aria-hidden="true" /> New project
          </button>
          <button type="button" className="ag-btn ag-btn--ghost" onClick={() => onNavigate("projects")}>
            <LayoutGrid size={14} aria-hidden="true" /> Open Projects
          </button>
        </div>

        <HarnessStatus {...(onOpenSettings ? { onOpenSettings } : {})} />

        {runningNow.length > 0 ? (
          <section className="ag-home__section" aria-labelledby={`${id}-running`}>
            <h3 className="ag-home__heading" id={`${id}-running`}>Running now</h3>
            <div className="ag-home__chips">
              {runningNow.map((session) => (
                <button
                  key={session.id}
                  type="button"
                  className="ag-chip ag-home__running"
                  title={`${session.title}
${session.cwd}`}
                  onClick={() => void useAgentStore.getState().open(session.id)}
                >
                  <span className="ag-home__dot" aria-hidden="true" />
                  <span className="ag-chip__text">{session.title || "Untitled"}</span>
                </button>
              ))}
            </div>
          </section>
        ) : null}

        {byRecency.length > 0 ? (
          <section className="ag-home__section" aria-labelledby={`${id}-recent`}>
            <h3 className="ag-home__heading" id={`${id}-recent`}>Recent</h3>
            <ul className="ag-home__recent">
              {byRecency.slice(0, RECENT_LIMIT).map((session) => (
                <li key={session.id}>
                  <button type="button" className="ag-home__session" title={`${session.title}\n${session.cwd}`} onClick={() => void useAgentStore.getState().open(session.id)}>
                    <span className="ag-home__session-title">{session.title || "Untitled"}</span>
                    <span className="ag-home__session-folder ag-muted">{folderName(session.cwd)}</span>
                    <span className="ag-home__session-time ag-muted">{relativeTime(session.updatedAtMs)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

      </div>
    </div>
  );
}
