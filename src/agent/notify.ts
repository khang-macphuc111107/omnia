import { readPrefs } from "./prefs";
import type { AgentWireEvent } from "./types";

/** Desktop notifications for finished runs and approval requests (Web Notification API). */

const MAX_BODY = 140;

export interface NotifyContext {
  focused: boolean;
  visible: boolean;
  selectedId: string | null;
  sessionId: string;
  enabled: boolean;
}

/** Notify only when enabled and the user is not already looking at this session. */
export function shouldNotify({ focused, visible, selectedId, sessionId, enabled }: NotifyContext): boolean {
  if (!enabled) return false;
  const watching = focused && visible;
  return !watching || selectedId !== sessionId;
}

export function notificationFor(event: AgentWireEvent, title: string): { title: string; body: string } | null {
  if (event.type === "approval_requested") return { title, body: "Waiting for your approval" };
  if (event.type !== "run_finished") return null;
  if (event.status === "completed") return { title, body: "Finished" };
  if (event.status === "failed") {
    const message = (event.message ?? "").trim().replace(/\s+/g, " ");
    const clipped = message.length > MAX_BODY ? `${message.slice(0, MAX_BODY - 1)}…` : message;
    return { title, body: clipped ? `Failed: ${clipped}` : "Failed" };
  }
  return null;
}

export interface NotifyHooks {
  title: string;
  selectedId: string | null;
  select: (sessionId: string) => void;
}

/** Best-effort: never throws, even without Notification support. */
export function maybeNotify(sessionId: string, event: AgentWireEvent, hooks: NotifyHooks): void {
  try {
    const content = notificationFor(event, hooks.title);
    if (!content || typeof Notification === "undefined") return;
    const proceed = shouldNotify({
      focused: typeof document !== "undefined" && document.hasFocus(),
      visible: typeof document === "undefined" || document.visibilityState !== "hidden",
      selectedId: hooks.selectedId,
      sessionId,
      enabled: readPrefs().notifyOnFinish !== false,
    });
    if (!proceed) return;
    const show = () => {
      try {
        const note = new Notification(content.title, { body: content.body });
        note.onclick = () => {
          try {
            window.focus();
            hooks.select(sessionId);
            note.close();
          } catch {
            /* ignore */
          }
        };
      } catch {
        /* ignore */
      }
    };
    if (Notification.permission === "granted") show();
    else if (Notification.permission === "default") {
      void Promise.resolve(Notification.requestPermission())
        .then((result) => {
          if (result === "granted") show();
        })
        .catch(() => undefined);
    }
  } catch {
    /* notifications are optional */
  }
}
