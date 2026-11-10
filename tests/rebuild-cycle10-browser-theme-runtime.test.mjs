import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = new URL("../", import.meta.url);
const defaultWindowsBinary = path.join(process.env.APPDATA ?? "", "npm/node_modules/agent-browser/bin/agent-browser-win32-x64.exe");
const executable = process.env.AGENT_BROWSER_BIN ?? (process.platform === "win32" && existsSync(defaultWindowsBinary) ? defaultWindowsBinary : "agent-browser");
const session = `omnia-browser-theme-runtime-${process.pid}`;

function command(args, input, timeout = 30_000) {
  const response = execFileSync(executable, ["--session", session, "--json", ...args], {
    encoding: "utf8", input, timeout, maxBuffer: 1024 * 1024,
  });
  const parsed = JSON.parse(response.trim());
  assert.equal(parsed.success, true, response);
  return parsed.data;
}

/**
 * Browser cleanup must not turn a successful style assertion into a false
 * negative when a saturated Windows runner leaves the daemon unresponsive.
 * A timed-out close is followed by a bounded daemon-tree kill; real command
 * failures still propagate so the harness cannot report a false green.
 */
function closeBestEffort() {
  try {
    command(["close"], undefined, 5_000);
    return;
  } catch (error) {
    if (error?.code !== "ETIMEDOUT") throw error;
  }
  try {
    const raw = execFileSync(executable, ["--session", session, "--json", "session", "info"], {
      encoding: "utf8", timeout: 3_000, maxBuffer: 256 * 1024,
    });
    const info = JSON.parse(raw.trim());
    const pid = Number(info?.data?.pid);
    if (!Number.isInteger(pid) || pid <= 0) return;
    if (process.platform === "win32") {
      try {
        execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
          encoding: "utf8", timeout: 5_000, stdio: "ignore",
        });
      } catch {
        // The daemon may have exited between `session info` and taskkill.
      }
    } else {
      try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
    }
  } catch {
    // No daemon metadata is available; the timed-out close already killed its
    // request process, and the next test run uses a fresh session identity.
  }
}

test("Chromium applies dark/light browser chrome, status/capture contrast and live focus colors", async () => {
  const css = (await readFile(new URL("src/rebuild/rebuild-app.css", root), "utf8"))
    + (await readFile(new URL("src/rebuild/browser/browser-workspace.css", root), "utf8"));
  const fixture = `<main aria-label="Stylesheet verification fixture"><section class="rb-browser" style="height:600px" aria-label="Browser stylesheet fixture">
    <header class="rb-browser__header"><span class="rb-browser__availability is-live">Native</span><span class="rb-browser__availability is-preview">Preview</span></header>
    <div class="rb-browser__toolbar"><form class="rb-browser__address"><input aria-label="Address" value="https://example.com/"></form><button class="rb-browser__tool-button">Capture</button></div>
    <div class="rb-browser__surface-wrap"><div class="rb-browser__surface"><div class="rb-browser__surface-state"><strong>Native unavailable</strong><p>Bounded source verification</p><span class="rb-browser__state-code">unavailable</span><button class="rb-browser__retry">Retry</button></div></div><div class="rb-browser__notice">Permission notice</div></div>
    <aside class="rb-browser__capture"><strong>Capture receipt</strong><p>Captured text</p><footer>Receipt metadata</footer><button aria-label="Close capture">Close</button></aside>
    <footer class="rb-browser__footer">Source and platform boundary</footer>
  </section></main>`;
  closeBestEffort();
  command(["open", "about:blank"]);
  try {
    const result = command(["eval", "--stdin"], `(() => {
      document.documentElement.lang = "en";
      document.title = "Omnia Browser stylesheet verification fixture";
      document.head.innerHTML = "<style>" + ${JSON.stringify(css)} + "</style>";
      document.body.innerHTML = ${JSON.stringify(fixture)};
      function rgba(value) {
        const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
        const context = canvas.getContext("2d"); context.fillStyle = value; context.fillRect(0,0,1,1);
        return Array.from(context.getImageData(0,0,1,1).data);
      }
      function luminance(value) { const [r,g,b] = rgba(value).slice(0,3).map(c => { const v=c/255; return v <= 0.04045 ? v/12.92 : ((v+0.055)/1.055)**2.4; }); return 0.2126*r+0.7152*g+0.0722*b; }
      function contrast(a,b) { const x=luminance(a), y=luminance(b); return (Math.max(x,y)+0.05)/(Math.min(x,y)+0.05); }
      const selectors = [".rb-browser", ".rb-browser__header", ".rb-browser__toolbar", ".rb-browser__address", ".rb-browser__surface", ".rb-browser__state-code", ".rb-browser__footer", ".rb-browser__notice", ".rb-browser__capture", ".rb-browser__retry", ".is-live", ".is-preview"];
      const samples = ["dark", "light", "dark"].map(theme => {
        document.documentElement.dataset.rebuildTheme=theme;
        const colors=Object.fromEntries(selectors.map(selector => { const style=getComputedStyle(document.querySelector(selector)); return [selector, {background:style.backgroundColor, foreground:style.color, ratio:contrast(style.color,style.backgroundColor)}]; }));
        const input=document.querySelector("input"); input.focus();
        const focus=getComputedStyle(input), address=getComputedStyle(input.closest("form"));
        return {theme,colors,focus:{visible:input.matches(":focus-visible"),width:focus.outlineWidth,style:focus.outlineStyle,color:focus.outlineColor,addressBorder:address.borderColor,panelRatio:contrast(focus.outlineColor,colors[".rb-browser__toolbar"].background)}};
      });
      return JSON.stringify({scope:"stylesheet fixture using actual current CSS; not an app/native/live-provider capture",userAgent:navigator.userAgent,samples});
    })()`);
    const observed = JSON.parse(result.result);
    assert.equal(observed.samples.length, 3);
    assert.equal(observed.samples[0].colors[".rb-browser"].background, "rgb(11, 16, 21)");
    assert.equal(observed.samples[1].colors[".rb-browser"].background, "rgb(246, 248, 250)");
    assert.equal(observed.samples[0].colors[".rb-browser__toolbar"].background, "rgb(17, 25, 35)");
    assert.equal(observed.samples[1].colors[".rb-browser__toolbar"].background, "rgb(255, 255, 255)");
    for (const sample of observed.samples) {
      for (const [selector, colors] of Object.entries(sample.colors)) {
        assert.ok(colors.ratio >= 7, `${sample.theme} ${selector}: ${colors.ratio}`);
      }
      assert.equal(sample.focus.visible, true);
      assert.equal(sample.focus.width, "2px");
      assert.equal(sample.focus.style, "solid");
      assert.equal(sample.focus.color, sample.focus.addressBorder);
      assert.ok(sample.focus.panelRatio >= 3, `${sample.theme} focus ring: ${sample.focus.panelRatio}`);
    }
    assert.deepEqual(observed.samples[0].colors, observed.samples[2].colors, "hot theme roundtrip must be reversible");
    console.log(JSON.stringify(observed));
  } finally {
    closeBestEffort();
  }
});
