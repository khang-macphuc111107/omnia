import { useCallback, useEffect, useRef, useState } from "react";

import { agentApi, errorMessage } from "./agent-api";
import { readVoicePrefs, type VoiceEventPayload, type VoiceSettingsTarget } from "./voice";

export type DictationState = "idle" | "starting" | "listening" | "error";

export interface DictationError {
  message: string;
  /** Windows settings page that fixes this failure, when there is one. */
  settings: VoiceSettingsTarget | null;
}

/** Insert `piece` at the selection, adding a separating space when the neighbours need one. */
export function insertAtCaret(
  text: string,
  start: number,
  end: number,
  piece: string,
): { text: string; caret: number } {
  const from = Math.max(0, Math.min(start, text.length));
  const to = Math.max(from, Math.min(end, text.length));
  const before = text.slice(0, from);
  const after = text.slice(to);
  const clean = piece.trim();
  if (!clean) return { text, caret: from };
  const needsLead = before.length > 0 && !/\s$/.test(before) && !/^[,.;:!?)\]]/.test(clean);
  const needsTail = after.length > 0 && !/^\s/.test(after) && !/^[,.;:!?)\]]/.test(after);
  const inserted = `${needsLead ? " " : ""}${clean}${needsTail ? " " : ""}`;
  return { text: before + inserted + after, caret: before.length + inserted.length - (needsTail ? 1 : 0) };
}

export function dictationError(code: string | undefined, message: string): DictationError {
  const settings: VoiceSettingsTarget | null =
    code === "speech_privacy_declined" || code === "voice_speech_privacy_declined"
      ? "speech"
      : code === "microphone_denied" || code === "voice_microphone_denied" || code === "microphone_unavailable"
        ? "microphone"
        : null;
  return { message, settings };
}

function codeOf(cause: unknown): string | undefined {
  if (typeof cause === "object" && cause !== null && "code" in cause) {
    const code = (cause as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

/**
 * Drives one composer's dictation session. Only a hook that started a session reacts to
 * `omnia-voice` events, so split panes never both insert the same text.
 */
export function useDictation({ onFinal }: { onFinal: (text: string) => void }) {
  const [state, setState] = useState<DictationState>("idle");
  const [partial, setPartial] = useState("");
  const [error, setError] = useState<DictationError | null>(null);
  const stateRef = useRef<DictationState>("idle");
  const onFinalRef = useRef(onFinal);
  onFinalRef.current = onFinal;

  /** Re-read the ref so TypeScript does not narrow it across awaits and early returns. */
  const current = (): DictationState => stateRef.current;
  const update = useCallback((next: DictationState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let disposed = false;
    Promise.resolve()
      .then(() => agentApi.onVoiceEvent((event: VoiceEventPayload) => {
        if (stateRef.current === "idle" || stateRef.current === "error") return;
        if (event.kind === "partial") {
          setPartial(event.text);
        } else if (event.kind === "final") {
          setPartial("");
          if (event.text.trim()) onFinalRef.current(event.text);
        } else if (event.kind === "error") {
          setPartial("");
          setError(dictationError(event.code, event.text));
          update("error");
        } else {
          setPartial("");
          if (current() !== "error") update("idle");
        }
      }))
      .then((off) => {
        if (disposed) off();
        else unlisten = off;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [update]);

  const stop = useCallback(async () => {
    if (stateRef.current === "idle") return;
    if (stateRef.current !== "error") update("idle");
    setPartial("");
    try {
      await agentApi.voiceStop();
    } catch {
      /* already stopped */
    }
  }, [update]);

  const start = useCallback(async () => {
    if (stateRef.current === "starting" || stateRef.current === "listening") return;
    setError(null);
    setPartial("");
    update("starting");
    try {
      await agentApi.voiceStart(readVoicePrefs().language || undefined);
      // A stop (or end event) may have raced the start; only advance if still starting.
      if (current() === "starting") update("listening");
    } catch (cause) {
      setError(dictationError(codeOf(cause), errorMessage(cause)));
      update("error");
    }
  }, [update]);

  const toggle = useCallback(() => {
    if (stateRef.current === "starting" || stateRef.current === "listening") void stop();
    else void start();
  }, [start, stop]);

  const dismissError = useCallback(() => {
    setError(null);
    update("idle");
  }, [update]);

  const openSettings = useCallback(async (target: VoiceSettingsTarget) => {
    try {
      await agentApi.voiceOpenSettings(target);
    } catch (cause) {
      setError({ message: errorMessage(cause), settings: null });
    }
  }, []);

  // Never leave the microphone open when the composer goes away.
  useEffect(
    () => () => {
      if (stateRef.current === "starting" || stateRef.current === "listening") {
        void Promise.resolve().then(() => agentApi.voiceStop()).catch(() => undefined);
      }
    },
    [],
  );

  return { state, partial, error, start, stop, toggle, dismissError, openSettings };
}
