import { ImagePlus, Mic, MicOff, Square, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
} from "react";

import { agentApi, errorMessage } from "./agent-api";
import { useAgentStore } from "./agent-store";
import { EffortSelect } from "./effort-select";
import { Popover } from "./ui";
import { insertAtCaret, useDictation } from "./use-dictation";
import "./mentions.css";
import {
  PERMISSION_MODES,
  type AgentImageInput,
  type AgentSessionListItem,
  type CustomCommandInfo,
  type PermissionMode,
  type WorkspaceEntry,
} from "./types";

/** Holding the dictation shortcut at least this long turns it into push-to-talk. */
export const PUSH_TO_TALK_MS = 450;

function readImage(file: File): Promise<AgentImageInput | null> {
  return new Promise((resolve) => {
    if (!file.type.startsWith("image/")) return resolve(null);
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      resolve(comma < 0 ? null : { mediaType: file.type, data: result.slice(comma + 1) });
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

function ModelChip({
  session,
  onChange,
}: {
  session: AgentSessionListItem;
  onChange: (model: string) => void;
}) {
  const [models, setModels] = useState<string[]>([]);
  const [draft, setDraft] = useState(session.model);
  const listId = useId();
  return (
    <Popover
      label={`Model: ${session.model}. Change model`}
      className="ag-chip"
      trigger={<span className="ag-chip__text">{session.model}</span>}
      onOpen={() => {
        setDraft(session.model);
        agentApi
          .listModels(session.profileId)
          .then((list) => setModels(list.map((model) => model.id)))
          .catch(() => setModels([]));
      }}
    >
      {(close) => (
        <form
          className="ag-popover__form"
          onSubmit={(event) => {
            event.preventDefault();
            if (draft.trim()) onChange(draft.trim());
            close();
          }}
        >
          <label className="ag-label" htmlFor={`${listId}-input`}>
            Model id (applies from the next message)
          </label>
          <input
            id={`${listId}-input`}
            className="ag-input"
            list={listId}
            value={draft}
            autoFocus
            onChange={(event) => setDraft(event.target.value)}
          />
          <datalist id={listId}>
            {models.map((id) => (
              <option key={id} value={id} />
            ))}
          </datalist>
          <button type="submit" className="ag-btn ag-btn--primary">
            Use model
          </button>
        </form>
      )}
    </Popover>
  );
}

function ModeChip({ mode, onChange }: { mode: PermissionMode; onChange: (mode: PermissionMode) => void }) {
  const current = PERMISSION_MODES.find((entry) => entry.value === mode);
  return (
    <Popover
      label={`Permission mode: ${current?.label ?? mode}. Change mode`}
      className={`ag-chip${mode === "full" ? " ag-chip--warn" : ""}`}
      trigger={<span className="ag-chip__text">{current?.label ?? mode}</span>}
    >
      {(close) => (
        <ul className="ag-menu" role="menu">
          {PERMISSION_MODES.map((entry) => (
            <li key={entry.value} role="none">
              <button
                type="button"
                role="menuitemradio"
                aria-checked={entry.value === mode}
                className={`ag-menu__item${entry.value === "full" ? " ag-menu__item--warn" : ""}`}
                onClick={() => {
                  onChange(entry.value);
                  close();
                }}
              >
                <span>{entry.label}</span>
                <span className="ag-muted">{entry.description}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Popover>
  );
}

export function Composer({
  session,
  running,
  blocked = false,
  onSend,
  onStop,
  onModel,
  onMode,
  autoFocus = true,
}: {
  session: AgentSessionListItem;
  running: boolean;
  blocked?: boolean;
  onSend: (text: string, images: AgentImageInput[]) => void | Promise<void>;
  onStop: () => void;
  onModel: (model: string) => void;
  onMode: (mode: PermissionMode) => void;
  /** Focus the input on mount. A split view only does this for its focused pane. */
  autoFocus?: boolean;
}) {
  const draft = useAgentStore((state) => state.drafts[session.id]);
  const text = draft?.text ?? "";
  const images = draft?.images ?? [];
  const setText = (text: string) => useAgentStore.getState().setDraft(session.id, { text, images });
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  /** Last known caret, so dictated text lands where the user left it even after focus moved. */
  const caret = useRef<{ start: number; end: number } | null>(null);
  const [pendingCaret, setPendingCaret] = useState<number | null>(null);
  const sessionIdRef = useRef(session.id);
  sessionIdRef.current = session.id;
  const trackCaret = () => {
    const element = area.current;
    if (element) caret.current = { start: element.selectionStart, end: element.selectionEnd };
  };
  const dictation = useDictation({
    onFinal: (piece) => {
      const id = sessionIdRef.current;
      const store = useAgentStore.getState();
      const current = store.drafts[id] ?? { text: "", images: [] };
      const at = caret.current ?? { start: current.text.length, end: current.text.length };
      const next = insertAtCaret(current.text, at.start, at.end, piece);
      store.setDraft(id, { ...current, text: next.text });
      caret.current = { start: next.caret, end: next.caret };
      setPendingCaret(next.caret);
    },
  });
  const [commands, setCommands] = useState<{ sessionId: string; list: CustomCommandInfo[] } | null>(null);
  const [commandIndex, setCommandIndex] = useState(0);
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  const commandsRequested = useRef<string | null>(null);
  const commandsId = useId();

  const [mentionResult, setMentionResult] = useState<{ key: string; list: WorkspaceEntry[] } | null>(null);
  const mentionId = useId();
  const mentionQuery = /(?:^|\s)@(\S+)$/.exec(text)?.[1] ?? null;
  const mentionKey = mentionQuery === null ? null : `${session.id}|${mentionQuery}`;

  useEffect(() => {
    if (mentionQuery === null || mentionKey === null) return;
    const sessionId = session.id;
    let cancelled = false;
    const timer = setTimeout(() => {
      Promise.resolve()
        .then(() => agentApi.workspaceFiles(sessionId, mentionQuery, 50))
        .then((list) => { if (!cancelled) setMentionResult({ key: mentionKey, list }); })
        .catch(() => { if (!cancelled) setMentionResult({ key: mentionKey, list: [] }); });
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [mentionQuery, mentionKey, session.id]);

  const mentionMatches =
    mentionQuery !== null && mentionResult?.key === mentionKey && dismissedFor !== text ? mentionResult.list : [];
  const completeMention = (entry: WorkspaceEntry) => {
    setText(text.replace(/@\S+$/, `@${entry.path} `));
    setCommandIndex(0);
  };

  const slashToken = /^\/[^\s]*$/.test(text) ? text.slice(1) : null;

  useEffect(() => {
    if (slashToken === null || commandsRequested.current === session.id) return;
    commandsRequested.current = session.id;
    const sessionId = session.id;
    Promise.resolve()
      .then(() => agentApi.commandsList(sessionId))
      .then((list) => setCommands({ sessionId, list }))
      .catch(() => setCommands({ sessionId, list: [] }));
  }, [slashToken, session.id]);

  const matches =
    slashToken !== null && commands?.sessionId === session.id && dismissedFor !== text
      ? commands.list.filter((command) => command.name.toLowerCase().startsWith(slashToken.toLowerCase()))
      : [];
  const activeIndex = Math.min(commandIndex, Math.max(matches.length - 1, 0));
  const mentionActive = Math.min(commandIndex, Math.max(mentionMatches.length - 1, 0));
  const complete = (command: CustomCommandInfo) => {
    setText(`/${command.name} `);
    setCommandIndex(0);
  };

  useEffect(() => {
    const element = area.current;
    if (!element) return;
    const fit = () => {
      element.style.height = "auto";
      element.style.height = `${Math.min(element.scrollHeight, 220)}px`;
    };
    fit();
    if (typeof ResizeObserver === "undefined") return;
    let width = element.clientWidth;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth !== width) {
        width = element.clientWidth;
        fit();
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [text]);

  useEffect(() => {
    if (autoFocus) area.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id]);

  useEffect(() => {
    if (pendingCaret === null) return;
    const element = area.current;
    if (element && element.value.length >= pendingCaret) element.setSelectionRange(pendingCaret, pendingCaret);
    setPendingCaret(null);
  }, [pendingCaret, text]);

  // A dictation session belongs to one conversation: stop it when the session changes.
  const stopDictation = dictation.stop;
  useEffect(() => {
    caret.current = null;
    return () => void stopDictation();
  }, [session.id, stopDictation]);

  // Ctrl+Shift+Space: tap toggles dictation, press-and-hold is push-to-talk.
  const { toggle: toggleDictation, state: dictationState } = dictation;
  const dictationStateRef = useRef(dictationState);
  dictationStateRef.current = dictationState;
  useEffect(() => {
    if (!autoFocus) return;
    let heldSince: number | null = null;
    const onDown = (event: globalThis.KeyboardEvent) => {
      if (!(event.ctrlKey && event.shiftKey && event.code === "Space")) return;
      event.preventDefault();
      if (event.repeat) return;
      const active = dictationStateRef.current === "listening" || dictationStateRef.current === "starting";
      heldSince = active ? null : Date.now();
      toggleDictation();
    };
    const onUp = (event: globalThis.KeyboardEvent) => {
      if (heldSince === null) return;
      if (event.code !== "Space" && event.key !== "Control" && event.key !== "Shift") return;
      const heldFor = Date.now() - heldSince;
      heldSince = null;
      if (heldFor >= PUSH_TO_TALK_MS) toggleDictation();
    };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
    };
  }, [autoFocus, toggleDictation]);

  const addFiles = useCallback(async (files: File[]) => {
    const read = await Promise.all(files.map(readImage));
    // Capture the session at file selection, not FileReader completion.
    const store = useAgentStore.getState();
    const current = store.drafts[session.id] ?? { text: "", images: [] };
    store.setDraft(session.id, { ...current, images: [...current.images, ...read.filter((image): image is AgentImageInput => image !== null)] });
  }, [session.id]);

  const canSubmit = !blocked && !sending && (text.trim().length > 0 || images.length > 0);

  const submit = async () => {
    if (!canSubmit) return;
    setError(null);
    if (running && images.length) {
      setError("Image steering is not supported. Remove the images or wait for the run to stop.");
      return;
    }
    setSending(true);
    const submitted = useAgentStore.getState().drafts[session.id];
    try {
      await onSend(text, images);
      // Do not erase edits or attachments added while IPC was pending.
      if (useAgentStore.getState().drafts[session.id] === submitted) {
        useAgentStore.getState().setDraft(session.id, { text: "", images: [] });
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally { setSending(false); }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionMatches.length > 0 && !event.nativeEvent.isComposing) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : mentionMatches.length - 1;
        setCommandIndex((mentionActive + step) % mentionMatches.length);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissedFor(text);
        return;
      }
      const picked = mentionMatches[mentionActive];
      if (picked && (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey))) {
        event.preventDefault();
        completeMention(picked);
        return;
      }
    }
    if (matches.length > 0 && !event.nativeEvent.isComposing) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : matches.length - 1;
        setCommandIndex((activeIndex + step) % matches.length);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissedFor(text);
        return;
      }
      const chosen = matches[activeIndex];
      const exact = chosen?.name === slashToken;
      if (chosen && (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey && !exact))) {
        event.preventDefault();
        complete(chosen);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
    if (files.length > 0) {
      event.preventDefault();
      void addFiles(files);
    }
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    const files = Array.from(event.dataTransfer.files).filter((file) => file.type.startsWith("image/"));
    if (files.length > 0) {
      event.preventDefault();
      void addFiles(files);
    }
  };

  return (
    <div className="ag-composer" onDrop={onDrop} onDragOver={(event) => event.preventDefault()}>
      {images.length > 0 ? (
        <ul className="ag-attachments" aria-label="Attached images">
          {images.map((image, index) => (
            <li key={index} className="ag-attachment">
              <img src={`data:${image.mediaType};base64,${image.data}`} alt="Attached" />
              <button
                type="button"
                aria-label="Remove image"
                onClick={() => useAgentStore.getState().setDraft(session.id, { text, images: images.filter((_, i) => i !== index) })}
              >
                <X size={12} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {error ? <p className="ag-error" role="alert">{error}</p> : null}
      {dictation.error ? (
        <div className="ag-error ag-dictation-error" role="alert">
          <span>{dictation.error.message}</span>
          {dictation.error.settings ? (
            <button type="button" className="ag-btn" onClick={() => void dictation.openSettings(dictation.error!.settings!)}>
              {dictation.error.settings === "speech" ? "Open speech settings" : "Open microphone settings"}
            </button>
          ) : null}
          <button type="button" className="ag-btn ag-btn--ghost" onClick={dictation.dismissError}>
            Dismiss
          </button>
        </div>
      ) : null}
      {dictation.partial ? (
        <p className="ag-dictation-ghost" aria-live="polite" data-testid="dictation-ghost">
          {dictation.partial}
        </p>
      ) : null}
      {matches.length > 0 ? (
        <ul id={commandsId} className="ag-menu ag-command-list" role="listbox" aria-label="Slash commands">
          {matches.map((command, index) => (
            <li key={command.name} role="none">
              <button
                type="button"
                role="option"
                id={`${commandsId}-${index}`}
                aria-selected={index === activeIndex}
                className="ag-menu__item"
                tabIndex={-1}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  complete(command);
                  area.current?.focus();
                }}
              >
                <span>
                  /{command.name}
                  {command.argumentHint ? ` ${command.argumentHint}` : ""}
                </span>
                {command.description ? <span className="ag-muted">{command.description}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {mentionMatches.length > 0 ? (
        <ul id={mentionId} className="ag-menu ag-mention-list" role="listbox" aria-label="Workspace files">
          {mentionMatches.map((entry, index) => (
            <li key={entry.path} role="none">
              <button
                type="button"
                role="option"
                id={`${mentionId}-${index}`}
                aria-selected={index === mentionActive}
                className="ag-menu__item"
                tabIndex={-1}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  completeMention(entry);
                  area.current?.focus();
                }}
              >
                <span className="ag-mention__path">{entry.path}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <textarea
        ref={area}
        aria-controls={mentionMatches.length > 0 ? mentionId : matches.length > 0 ? commandsId : undefined}
        aria-activedescendant={
          mentionMatches.length > 0
            ? `${mentionId}-${mentionActive}`
            : matches.length > 0
              ? `${commandsId}-${activeIndex}`
              : undefined
        }
        className="ag-composer__input"
        aria-label={running ? "Steer the agent" : "Message the agent"}
        placeholder={running ? "Steer the agent while it works…" : "Ask the agent to work in this folder…"}
        rows={1}
        value={text}
        onChange={(event) => {
          setCommandIndex(0);
          setText(event.target.value);
        }}
        onKeyDown={onKeyDown}
        onKeyUp={trackCaret}
        onClick={trackCaret}
        onSelect={trackCaret}
        onBlur={trackCaret}
        onPaste={onPaste}
      />
      <div className="ag-composer__bar">
        <ModelChip session={session} onChange={onModel} />
        <ModeChip mode={session.permissionMode} onChange={onMode} />
        <EffortSelect value={session.reasoningEffort ?? null} onChange={(effort) => void useAgentStore.getState().setEffort(effort, session.id)} />
        <span className="ag-composer__actions">
        <button
          type="button"
          className={`ag-icon-btn ag-mic${dictation.state === "listening" ? " ag-mic--listening" : ""}${dictation.state === "error" ? " ag-mic--error" : ""}`}
          aria-label={dictation.state === "listening" || dictation.state === "starting" ? "Stop dictation" : "Start dictation"}
          aria-pressed={dictation.state === "listening" || dictation.state === "starting"}
          data-state={dictation.state}
          title="Dictate (Ctrl+Shift+Space; hold to push-to-talk)"
          disabled={dictation.state === "starting"}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            trackCaret();
            dictation.toggle();
          }}
        >
          {dictation.state === "error" ? <MicOff size={16} aria-hidden="true" /> : <Mic size={16} aria-hidden="true" />}
        </button>
        <label className="ag-icon-btn" aria-label="Attach image" title="Attach image">
          <ImagePlus size={16} aria-hidden="true" />
          <input
            type="file"
            accept="image/*"
            multiple
            className="sr-only"
            onChange={(event) => {
              void addFiles(Array.from(event.target.files ?? []));
              event.target.value = "";
            }}
          />
        </label>
        {running ? (
          <button type="button" className="ag-btn" onClick={onStop} aria-label="Stop">
            <Square size={12} aria-hidden="true" /> Stop
          </button>
        ) : null}
        <button type="button" className="ag-btn ag-btn--primary" disabled={!canSubmit} onClick={submit}>
          {running ? "Steer" : "Send"}
        </button>
        </span>
      </div>
    </div>
  );
}
