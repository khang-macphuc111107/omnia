import { COMMAND_ACTIVITIES, type ActivityId } from "./activity-registry";

export type RendererCommandShortcut =
  | "open-commands"
  | "new-chat"
  | "new-project"
  | "focus-search"
  | "focus-composer"
  | "toggle-sidebar"
  | "toggle-inspector";

export type RendererShortcutAction =
  | { kind: "activity"; id: ActivityId }
  | { kind: "command"; id: RendererCommandShortcut };

export type ShortcutOverrides = Record<string, readonly string[]>;

const commandDefaults: Record<RendererCommandShortcut, readonly string[]> = {
  "open-commands": ["Ctrl", "K"],
  "new-chat": ["Ctrl", "N"],
  "new-project": ["Ctrl", "Shift", "P"],
  "focus-search": ["Ctrl", "Shift", "F"],
  "focus-composer": ["Ctrl", "L"],
  "toggle-sidebar": ["Ctrl", "Shift", "B"],
  "toggle-inspector": ["Ctrl", "Shift", "I"],
};

const actions: readonly { id: string; keys: readonly string[]; action: RendererShortcutAction }[] = [
  ...COMMAND_ACTIVITIES.filter((activity) => activity.shortcut).map((activity) => ({
    id: `activity-${activity.id}`,
    keys: activity.shortcut!.split("+"),
    action: { kind: "activity" as const, id: activity.id },
  })),
  ...Object.entries(commandDefaults).map(([id, keys]) => ({
    id,
    keys,
    action: { kind: "command" as const, id: id as RendererCommandShortcut },
  })),
];

const actionableIds = new Set(actions.map((action) => action.id));
let sessionOverrides: ShortcutOverrides = {};

export function isActiveRendererShortcut(id: string): boolean {
  return actionableIds.has(id);
}

function normalizedKey(key: string): string {
  if (key === " ") return "Space";
  if (key === "ArrowUp") return "↑";
  if (key === "ArrowDown") return "↓";
  if (key === "ArrowLeft") return "←";
  if (key === "ArrowRight") return "→";
  return key.length === 1 ? key.toUpperCase() : key;
}

function signature(keys: readonly string[]): string {
  return keys.map((key) => key.toLowerCase()).join("+");
}

/** Plain letters/Enter and OS-only chords remain outside global renderer binding. */
export function canActivateRendererShortcut(keys: readonly string[]): boolean {
  return keys.length >= 2
    && keys.length <= 4
    && (keys[0] === "Ctrl" || keys[0] === "Alt")
    && keys.every((key) => typeof key === "string" && key.length > 0 && key.length < 25)
    && !(keys[0] === "Ctrl" && ["W", "R"].includes(keys.at(-1) ?? ""))
    && !(keys[0] === "Alt" && keys.at(-1) === "F4")
    && !(keys[0] === "Alt" && keys.at(-1) === "Tab");
}

export function getSessionShortcutOverrides(): ShortcutOverrides {
  return Object.fromEntries(Object.entries(sessionOverrides).map(([id, keys]) => [id, [...keys]]));
}

/** Undo/redo/import changes apply only to supported renderer actions in this tab. */
export function setSessionShortcutOverrides(overrides: ShortcutOverrides): void {
  sessionOverrides = Object.fromEntries(Object.entries(overrides)
    .filter(([id, keys]) => !actionableIds.has(id) || canActivateRendererShortcut(keys))
    .map(([id, keys]) => [id, [...keys]]));
}

export function resolveSessionShortcut(event: KeyboardEvent): RendererShortcutAction | null {
  if (event.defaultPrevented || event.isComposing || event.repeat) return null;
  const pressed = [
    ...(event.ctrlKey || event.metaKey ? ["Ctrl"] : []),
    ...(event.altKey ? ["Alt"] : []),
    ...(event.shiftKey ? ["Shift"] : []),
    normalizedKey(event.key),
  ];
  const pressedSignature = signature(pressed);
  const matched = actions.filter(({ id, keys }) =>
    signature(sessionOverrides[id] ?? keys) === pressedSignature,
  );
  // Conflicting global bindings must never select one operation by array order.
  return matched.length === 1 ? matched[0]!.action : null;
}
