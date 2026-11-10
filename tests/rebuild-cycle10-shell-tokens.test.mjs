import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const root = new URL("../", import.meta.url);
function relativeLuminance(hex) {
  const channels = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const linear = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}
function contrast(a, b) {
  const first = relativeLuminance(a); const second = relativeLuminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}
test("shell has one dark and one light palette matching the canonical specification", async () => {
  const css = await readFile(new URL("src/rebuild/rebuild-app.css", root), "utf8");
  const spec = (await readFile(new URL("docs/rebuild/SPEC.md", root), "utf8")).toLowerCase();
  for (const token of ["canvas", "panel", "raised", "text", "muted", "line", "accent"]) {
    const definitions = [...css.matchAll(new RegExp(`--rb-${token}\\s*:\\s*(#[0-9a-f]+)`, "gi"))];
    assert.equal(definitions.length, 2, `${token} must not be silently overridden by a second palette`);
    for (const [, color] of definitions) {
      const expanded = color.length === 4 ? `#${[...color.slice(1)].map(x => x + x).join("")}` : color;
      assert.ok(spec.includes(expanded.toLowerCase()), `${token} ${expanded} must be documented in ${fileURLToPath(new URL("docs/rebuild/SPEC.md", root))}`);
    }
  }
  assert.match(css, /--rb-bg\s*:\s*var\(--rb-canvas\)/);
  assert.ok(contrast("#9bacba", "#111923") >= 7, "dark muted body text must meet the 7:1 target");
  assert.ok(contrast("#46545f", "#ffffff") >= 7, "light muted body text must meet the 7:1 target");
});

test("compact viewport gives the empty chat state room beside the composer", async () => {
  const css = await readFile(new URL("src/rebuild/chat/chat-view.css", root), "utf8");
  assert.match(css, /@media\s*\(max-height:\s*700px\)/, "chat needs a compact-height rule");
  assert.match(css, /@media\s*\(max-height:\s*700px\)[\s\S]*\.rb-chat-empty\{[^}]*min-height\s*:\s*(?:0|1[0-9]{1,2}px)/, "empty state must be shrinkable");
  assert.match(css, /@media\s*\(max-height:\s*700px\)[\s\S]*\.rb-chat-hero\{[^}]*padding/, "hero must compact at short heights");
});
