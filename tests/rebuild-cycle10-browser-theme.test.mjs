import { readFile } from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";

const root = new URL("../", import.meta.url);
const browserCss = await readFile(new URL("src/rebuild/browser/browser-workspace.css", root), "utf8");
const shellCss = await readFile(new URL("src/rebuild/rebuild-app.css", root), "utf8");

function rule(selector) {
  const start = browserCss.indexOf(`${selector}{`);
  assert.notEqual(start, -1, `missing ${selector} rule`);
  return browserCss.slice(start + selector.length + 1, browserCss.indexOf("}", start));
}

function luminance(hex) {
  const full = hex.length === 4 ? `#${[...hex.slice(1)].map((c) => c + c).join("")}` : hex;
  const [r, g, b] = [1, 3, 5].map((offset) => {
    const value = parseInt(full.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(first, second) {
  const a = luminance(first);
  const b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test("Browser chrome inherits the current shell palette without a fixed dark override", () => {
  const aliases = {
    bg: "canvas", panel: "panel", "panel-2": "canvas", line: "line",
    text: "text", muted: "muted", accent: "accent",
  };
  const base = rule(".rb-browser");
  for (const [local, semantic] of Object.entries(aliases)) {
    assert.match(base, new RegExp(`--rb-browser-${local}:\\s*var\\(--rb-${semantic}\\)`));
  }
  assert.doesNotMatch(browserCss, /#[0-9a-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla)\(/i,
    "browser state colors must derive from semantic tokens, including shadow/status/capture colors");
  assert.doesNotMatch(browserCss, /color-scheme\s*:/,
    "Browser must not override the live shell color scheme");
});

test("Browser chrome surfaces and capture/status text remain theme-aware", () => {
  for (const selector of [
    ".rb-browser__header", ".rb-browser__address", ".rb-browser__surface-wrap",
    ".rb-browser__surface", ".rb-browser__state-code", ".rb-browser__retry",
    ".rb-browser__notice", ".rb-browser__capture", ".rb-browser__footer",
  ]) {
    assert.match(rule(selector), /background:\s*(?:var\(--rb-|color-mix\()/,
      `${selector} must use a theme-aware background`);
  }
  for (const selector of [
    ".rb-browser__availability.is-live", ".rb-browser__availability.is-preview",
    ".rb-browser__notice", ".rb-browser__capture strong", ".rb-browser__capture p",
    ".rb-browser__capture footer", ".rb-browser__retry",
  ]) {
    assert.match(rule(selector), /color:\s*var\(--rb-browser-(?:text|muted)\)/,
      `${selector} must use a readable foreground rather than a fixed pale color`);
  }
});

test("Browser focus uses the live accent and its 2px ring is preserved", () => {
  assert.match(rule(".rb-browser button:focus-visible,.rb-browser input:focus-visible"),
    /outline:2px solid var\(--rb-browser-accent\);outline-offset:2px/);
  assert.match(rule(".rb-browser__address:focus-within"), /border-color:var\(--rb-browser-accent\)/);
  const themes = [...shellCss.matchAll(/--rb-panel:(#[0-9a-f]+);[\s\S]*?--rb-accent:(#[0-9a-f]+);/gi)];
  assert.equal(themes.length, 2);
  for (const [, panel, accent] of themes) {
    assert.ok(contrast(panel, accent) >= 3, `${accent} focus on ${panel} must reach 3:1`);
  }
});

test("Browser default text and muted text meet the 7:1 target on its base surfaces", () => {
  const themes = [...shellCss.matchAll(/--rb-canvas:(#[0-9a-f]+);--rb-panel:(#[0-9a-f]+);--rb-raised:(#[0-9a-f]+);--rb-text:(#[0-9a-f]+);--rb-muted:(#[0-9a-f]+);/gi)];
  assert.equal(themes.length, 2);
  for (const [, canvas, panel, , textColor, muted] of themes) {
    for (const background of [canvas, panel]) {
      assert.ok(contrast(textColor, background) >= 7, `${textColor} text on ${background}`);
      assert.ok(contrast(muted, background) >= 7, `${muted} muted text on ${background}`);
    }
  }
});
