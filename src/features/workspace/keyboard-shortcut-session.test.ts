import { afterEach, describe, expect, it } from "vitest";

import {
  canActivateRendererShortcut,
  resolveSessionShortcut,
  setSessionShortcutOverrides,
} from "./keyboard-shortcut-session";

function chord(key: string, modifiers: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent("keydown", { key, ...modifiers });
}

afterEach(() => setSessionShortcutOverrides({}));

describe("renderer-session shortcut resolution", () => {
  it("uses defaults, then rebinds one action without leaving its previous chord active", () => {
    expect(resolveSessionShortcut(chord("k", { ctrlKey: true }))).toEqual({ kind: "command", id: "open-commands" });
    setSessionShortcutOverrides({ "open-commands": ["Ctrl", "J"] });
    expect(resolveSessionShortcut(chord("j", { ctrlKey: true }))).toEqual({ kind: "command", id: "open-commands" });
    expect(resolveSessionShortcut(chord("k", { ctrlKey: true }))).toBeNull();
  });

  it("fails closed on duplicate active chords and ignores composition/repeat", () => {
    setSessionShortcutOverrides({ "new-chat": ["Ctrl", "K"] });
    expect(resolveSessionShortcut(chord("k", { ctrlKey: true }))).toBeNull();
    expect(resolveSessionShortcut(chord("n", { ctrlKey: true }))).toBeNull();
    expect(resolveSessionShortcut(chord("j", { ctrlKey: true, repeat: true }))).toBeNull();
  });

  it("keeps plain keys and reserved browser chords outside active global bindings", () => {
    expect(canActivateRendererShortcut(["J"])).toBe(false);
    expect(canActivateRendererShortcut(["Ctrl", "W"])).toBe(false);
    expect(canActivateRendererShortcut(["Alt", "F4"])).toBe(false);
    expect(canActivateRendererShortcut(["Ctrl", "Shift", "J"])).toBe(true);
    setSessionShortcutOverrides({ "open-commands": ["J"] });
    expect(resolveSessionShortcut(chord("k", { ctrlKey: true }))).toEqual({ kind: "command", id: "open-commands" });
  });
});
