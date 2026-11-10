import { afterEach, describe, expect, it, vi } from "vitest";
import { BROWSER_SHORTCUT_BINDINGS } from "../src/domain/browser-shortcuts";
import { browserContextBridge } from "./browser-context-bridge";

const frames: HTMLIFrameElement[] = [];
afterEach(() => frames.splice(0).forEach((frame) => frame.remove()));

function installBridge(url = "https://example.com/page") {
  const frame = document.createElement("iframe");
  document.body.appendChild(frame);
  frames.push(frame);
  const realm = frame.contentWindow as Window & typeof globalThis;
  const doc = realm.document;
  doc.title = "Embedded page";
  doc.body.innerHTML = '<input aria-label="Page editor"><a href="/next">Next</a>';
  const postMessage = vi.fn();
  const markup = browserContextBridge(url);
  const script = markup.replace(/^<script[^>]*>/, "").replace(/<\/script>$/, "");
  // Run the exact injected script against a separate document and parent channel.
  new Function("window", "document", "parent", "Element", "HTMLFormElement", "FormData", "URL", script)(
    realm, doc, { postMessage }, realm.Element, realm.HTMLFormElement, realm.FormData, realm.URL,
  );
  const keydown = (init: KeyboardEventInit, target: Element = doc.querySelector("input")!, prevented = false) => {
    const event = new realm.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    if (prevented) event.preventDefault();
    target.dispatchEvent(event);
    return event;
  };
  const shortcuts = () => postMessage.mock.calls.map(([message]) => message)
    .filter((message) => message.type === "shortcut");
  return { frame, realm, doc, postMessage, markup, keydown, shortcuts };
}

describe("injected browser context bridge", () => {
  it("forwards exactly the shared shortcut whitelist through the existing context channel", () => {
    const bridge = installBridge();
    for (const [binding, action] of Object.entries(BROWSER_SHORTCUT_BINDINGS)) {
      const [mask, key] = binding.split(":");
      const modifiers = Number(mask);
      const keys = { key: key!.toUpperCase(), ctrlKey: Boolean(modifiers & 1), metaKey: Boolean(modifiers & 2), altKey: Boolean(modifiers & 4), shiftKey: Boolean(modifiers & 8), repeat: false };
      const event = bridge.keydown(keys);
      expect(event.defaultPrevented).toBe(action !== "close-drawers");
      expect(bridge.shortcuts().at(-1)).toEqual({
        channel: "omnia:browser-context", type: "shortcut", url: "https://example.com/page",
        title: "Embedded page", keyboard: keys,
      });
    }
    expect(bridge.shortcuts()).toHaveLength(Object.keys(BROWSER_SHORTCUT_BINDINGS).length);
  });

  it("does not forward or consume repeated keys from any browser shortcut binding", () => {
    const bridge = installBridge();
    for (const binding of Object.keys(BROWSER_SHORTCUT_BINDINGS)) {
      const [mask, key] = binding.split(":");
      const modifiers = Number(mask);
      const event = bridge.keydown({
        key: key!, ctrlKey: Boolean(modifiers & 1), metaKey: Boolean(modifiers & 2),
        altKey: Boolean(modifiers & 4), shiftKey: Boolean(modifiers & 8), repeat: true,
      });
      expect(event.defaultPrevented).toBe(false);
    }
    expect(bridge.shortcuts()).toHaveLength(0);
  });

  it("preserves typing, clipboard, mode switching, IME and keys already handled by the page", () => {
    const bridge = installBridge();
    for (const keys of [
      { key: "a" }, { key: "c", ctrlKey: true }, { key: "v", ctrlKey: true },
      { key: "1", ctrlKey: true }, { key: "2", ctrlKey: true }, { key: "3", ctrlKey: true },
      { key: "l", ctrlKey: true, metaKey: true }, { key: "PageDown", ctrlKey: true, shiftKey: true },
      { key: "F12", isComposing: true }, { key: "F12", keyCode: 229 },
    ]) expect(bridge.keydown(keys).defaultPrevented).toBe(false);
    bridge.keydown({ key: "F12" }, undefined, true);
    const input = bridge.doc.querySelector("input")!;
    input.addEventListener("keydown", (event) => event.preventDefault());
    expect(bridge.keydown({ key: "l", ctrlKey: true }).defaultPrevented).toBe(true);
    expect(bridge.shortcuts()).toHaveLength(0);
  });

  it("does not forward keys from page dialogs or inactive content", () => {
    const bridge = installBridge();
    for (const attributes of ['role="dialog"', 'role="alertdialog"', "hidden", "inert", 'aria-hidden="true"']) {
      bridge.doc.body.innerHTML = `<div ${attributes}><input></div>`;
      expect(bridge.keydown({ key: "F12" }).defaultPrevented).toBe(false);
    }
    bridge.doc.body.innerHTML = "<dialog open><input></dialog>";
    expect(bridge.keydown({ key: "F12" }).defaultPrevented).toBe(false);
    expect(bridge.shortcuts()).toHaveLength(0);
  });

  it("keeps page snapshots and intercepted navigation and safely encodes the upstream URL", () => {
    const url = 'https://example.com/</script><script>alert("injected")</script>';
    const bridge = installBridge(url);
    expect(bridge.markup.match(/<\/script>/g)).toHaveLength(1);
    bridge.realm.dispatchEvent(new bridge.realm.Event("load"));
    expect(bridge.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      channel: "omnia:browser-context", type: "loaded", url, title: "Embedded page",
      html: expect.stringContaining("Page editor"),
    }), "*");
    const click = new bridge.realm.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    bridge.doc.querySelector("a")!.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(bridge.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ type: "navigate", url: "https://example.com/next" }), "*");
  });
});
