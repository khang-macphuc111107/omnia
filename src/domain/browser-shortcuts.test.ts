import { describe, expect, it } from "vitest";
import { BROWSER_SHORTCUT_BINDINGS, getBrowserShortcutAction } from "./browser-shortcuts";

const keyboard = (key: string, extra: Record<string, unknown> = {}) => ({
  key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...extra,
});

describe("browser shortcut whitelist", () => {
  it.each(Object.entries(BROWSER_SHORTCUT_BINDINGS))("recognizes %s as %s", (binding, action) => {
    const [mask, key] = binding.split(":");
    const modifiers = Number(mask);
    expect(getBrowserShortcutAction(keyboard(key!.toUpperCase(), {
      ctrlKey: Boolean(modifiers & 1), metaKey: Boolean(modifiers & 2),
      altKey: Boolean(modifiers & 4), shiftKey: Boolean(modifiers & 8),
    }))).toBe(action);
  });

  it.each(Object.keys(BROWSER_SHORTCUT_BINDINGS))("ignores held-key repeat for %s", (binding) => {
    const [mask, key] = binding.split(":");
    const modifiers = Number(mask);
    expect(getBrowserShortcutAction(keyboard(key!, {
      ctrlKey: Boolean(modifiers & 1), metaKey: Boolean(modifiers & 2),
      altKey: Boolean(modifiers & 4), shiftKey: Boolean(modifiers & 8), repeat: true,
    }))).toBeNull();
  });

  it.each([null, "false", 0, 1, {}])("rejects malformed repeat state: %j", (repeat) => {
    expect(getBrowserShortcutAction(keyboard("w", { ctrlKey: true, repeat }))).toBeNull();
  });

  it("accepts an explicit initial key press while preserving older non-repeat envelopes", () => {
    expect(getBrowserShortcutAction(keyboard("w", { ctrlKey: true, repeat: false }))).toBe("close-tab");
    expect(getBrowserShortcutAction(keyboard("w", { ctrlKey: true }))).toBe("close-tab");
  });

  it.each([
    null, [], "F12", {}, { action: "reload" },
    { key: "F12" }, keyboard("F12", { ctrlKey: "false" }),
    keyboard("F12", { shiftKey: undefined }), keyboard("F12", { defaultPrevented: true }),
    keyboard("F12", { isComposing: true }), keyboard("F12", { isComposing: "false" }),
    keyboard("F12", { keyCode: 229 }), keyboard("a".repeat(100)),
    keyboard("a"), keyboard("c", { ctrlKey: true }), keyboard("v", { metaKey: true }),
    keyboard("1", { ctrlKey: true }), keyboard("2", { ctrlKey: true }), keyboard("3", { ctrlKey: true }),
    keyboard("l", { ctrlKey: true, metaKey: true }),
    keyboard("PageDown", { ctrlKey: true, shiftKey: true }),
    keyboard("F12", { altKey: true }), keyboard("Escape", { shiftKey: true }),
  ])("rejects ordinary keys, unsupported combinations and malformed input: %j", (input) => {
    expect(getBrowserShortcutAction(input)).toBeNull();
  });
});
