export type BrowserShortcutAction =
  | "focus-address"
  | "new-tab"
  | "close-tab"
  | "reload"
  | "next-tab"
  | "previous-tab"
  | "back"
  | "forward"
  | "toggle-sidebar"
  | "toggle-devtools"
  | "toggle-device-toolbar"
  | "toggle-inspect"
  | "close-drawers";

// Modifier bits: Control = 1, Meta = 2, Alt = 4, Shift = 8.
// The proxy serializes this same whitelist; webpage messages never name actions.
export const BROWSER_SHORTCUT_BINDINGS: Readonly<Record<string, BrowserShortcutAction>> = {
  "1:l": "focus-address",
  "2:l": "focus-address",
  "4:d": "focus-address",
  "0:f6": "focus-address",
  "1:t": "new-tab",
  "2:t": "new-tab",
  "1:w": "close-tab",
  "2:w": "close-tab",
  "1:r": "reload",
  "2:r": "reload",
  "1:tab": "next-tab",
  "9:tab": "previous-tab",
  "1:pagedown": "next-tab",
  "1:pageup": "previous-tab",
  "4:arrowleft": "back",
  "4:arrowright": "forward",
  "5:b": "toggle-sidebar",
  "0:f12": "toggle-devtools",
  "9:m": "toggle-device-toolbar",
  "10:m": "toggle-device-toolbar",
  "9:c": "toggle-inspect",
  "10:c": "toggle-inspect",
  "0:escape": "close-drawers",
};

export function getBrowserShortcutAction(input: unknown): BrowserShortcutAction | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const event = input as Record<string, unknown>;
  if (typeof event.key !== "string" || event.key.length > 16
    || typeof event.ctrlKey !== "boolean"
    || typeof event.metaKey !== "boolean"
    || typeof event.altKey !== "boolean"
    || typeof event.shiftKey !== "boolean"
    || (event.repeat !== undefined && event.repeat !== false)
    || (event.defaultPrevented !== undefined && event.defaultPrevented !== false)
    || (event.isComposing !== undefined && event.isComposing !== false)
    || event.keyCode === 229) return null;
  const modifiers = (event.ctrlKey ? 1 : 0) | (event.metaKey ? 2 : 0)
    | (event.altKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
  return BROWSER_SHORTCUT_BINDINGS[`${modifiers}:${event.key.toLowerCase()}`] ?? null;
}
