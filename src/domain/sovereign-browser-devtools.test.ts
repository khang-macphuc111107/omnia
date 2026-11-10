import { describe, expect, it } from "vitest";
import {
  buildAntiDetectStealthScript,
  buildBrowserProfileLaunchCommand,
  buildCookieHeaderString,
  buildIframeAllowAttribute,
  captureAccessibilityAndSomTree,
  computePagePerformanceMetrics,
  createDefaultCookies,
  createDefaultSovereignNetworkEntries,
  createDefaultSovereignTabs,
  createDefaultStealthFingerprintConfig,
  createDefaultStorageEntries,
  createDefaultUserscripts,
  createSovereignPermissionPolicy,
  DEFAULT_BROWSER_PROFILE_PRESETS,
  deleteCookieEntry,
  deleteStorageEntry,
  deleteUserscriptEntry,
  detectCaptchaOrChallengeInHtml,
  DEVICE_VIEWPORT_PRESETS,
  duplicateSovereignTab,
  evaluateSovereignConsoleCommand,
  exportCookiesToNetscapeFormat,
  extractDownloadableMediaFromNetworkLog,
  flattenDomInspectorTree,
  generateCurlCommandFromNetworkEntry,
  generateFetchCodeFromNetworkEntry,
  matchUserscriptsForUrl,
  mutateDomInspectorNode,
  navigateSovereignTab,
  parseHtmlIntoDomInspectorTree,
  parseImportedCookies,
  parseUserscriptHeaderMetadata,
  queryDomInspectorNodes,
  replayAndMutateNetworkEntry,
  resolveSovereignOmniboxInput,
  serializeDomInspectorTreeToHtml,
  setSovereignPermissionFlag,
  stepSovereignTabHistory,
  synthesizePageHtmlForUrl,
  toggleSovereignAllowAllMaster,
  toggleUserscriptEntry,
  upsertCookieEntry,
  upsertStorageEntry,
  upsertUserscriptEntry,
} from "./sovereign-browser-devtools";

describe("sovereign-browser-devtools domain engine", () => {
  describe("resolveSovereignOmniboxInput", () => {
    it("resolves full https, localhost, file, data, and omnia protocol URLs", () => {
      expect(
        resolveSovereignOmniboxInput("https://example.com/docs?page=2"),
      ).toMatchObject({
        resolvedUrl: "https://example.com/docs?page=2",
        kind: "url",
      });

      expect(
        resolveSovereignOmniboxInput("http://localhost:1420/workspace"),
      ).toMatchObject({
        resolvedUrl: "http://localhost:1420/workspace",
        kind: "local",
      });

      expect(resolveSovereignOmniboxInput("localhost:3000/api")).toMatchObject({
        resolvedUrl: "http://localhost:3000/api",
        kind: "local",
      });

      expect(
        resolveSovereignOmniboxInput("file:///D:/Omnia/index.html"),
      ).toMatchObject({
        resolvedUrl: "file:///D:/Omnia/index.html",
        kind: "file",
      });

      expect(
        resolveSovereignOmniboxInput("D:\\Omnia\\demo.html"),
      ).toMatchObject({
        resolvedUrl: "file:///D:/Omnia/demo.html",
        kind: "file",
      });

      expect(
        resolveSovereignOmniboxInput("data:text/html,<h1>Hello</h1>"),
      ).toMatchObject({
        resolvedUrl: "data:text/html,<h1>Hello</h1>",
        kind: "data",
      });

      expect(
        resolveSovereignOmniboxInput("omnia://devtools-playground"),
      ).toMatchObject({
        resolvedUrl: "omnia://devtools-playground",
        kind: "protocol",
      });
    });

    it("resolves domain shorthands and search queries across search engines", () => {
      expect(resolveSovereignOmniboxInput("github.com")).toMatchObject({
        resolvedUrl: "https://github.com",
        kind: "domain-shorthand",
      });

      expect(
        resolveSovereignOmniboxInput("news.ycombinator.com/newest"),
      ).toMatchObject({
        resolvedUrl: "https://news.ycombinator.com/newest",
        kind: "domain-shorthand",
      });

      const ddg = resolveSovereignOmniboxInput(
        "rust webview2 cdp protocol",
        "duckduckgo",
      );
      expect(ddg.kind).toBe("search-query");
      expect(ddg.resolvedUrl).toBe(
        "https://duckduckgo.com/?q=rust%20webview2%20cdp%20protocol",
      );

      const brave = resolveSovereignOmniboxInput("hls m3u8 parser", "brave");
      expect(brave.resolvedUrl).toContain("https://search.brave.com/search?q=");

      const gh = resolveSovereignOmniboxInput("tauri", "github");
      expect(gh.resolvedUrl).toContain("https://github.com/search?q=tauri");

      const pplx = resolveSovereignOmniboxInput("zero copymse", "perplexity");
      expect(pplx.resolvedUrl).toContain("https://www.perplexity.ai/search?q=");
    });
  });

  describe("SovereignPermissionPolicy & Multi-Tab Navigation", () => {
    it("supports Sovereign Allow-All master mode and granular permission flags", () => {
      const unrestricted = createSovereignPermissionPolicy(true);
      expect(unrestricted.allowAllSovereignUnrestricted).toBe(true);
      expect(unrestricted.corsAndCrossOriginFetch).toBe(true);
      expect(unrestricted.isolatedVirtualInput).toBe(true);

      const allowAttr = buildIframeAllowAttribute(unrestricted);
      expect(allowAttr).toContain("clipboard-read; clipboard-write");
      expect(allowAttr).toContain("camera; microphone; display-capture");
      expect(allowAttr).toContain("geolocation");

      const partial = setSovereignPermissionFlag(
        unrestricted,
        "geolocation",
        false,
      );
      expect(partial.geolocation).toBe(false);
      expect(partial.allowAllSovereignUnrestricted).toBe(false);

      const restored = setSovereignPermissionFlag(partial, "geolocation", true);
      expect(restored.allowAllSovereignUnrestricted).toBe(true);

      const lockedDown = toggleSovereignAllowAllMaster(restored, false);
      expect(lockedDown.allowAllSovereignUnrestricted).toBe(false);
      expect(lockedDown.cspBypass).toBe(false);
    });

    it("navigates tabs, steps history back/forward, and duplicates tabs", () => {
      const tabs = createDefaultSovereignTabs();
      const firstTab = tabs[0]!;
      const navigated = navigateSovereignTab(
        firstTab,
        "news.ycombinator.com",
        "google",
      );
      expect(navigated.url).toBe("https://news.ycombinator.com");
      expect(navigated.historyIndex).toBe(2);

      const steppedBack = stepSovereignTabHistory(navigated, -1);
      expect(steppedBack.url).toBe(
        "https://stream-vault.omnia.local/watch/4k-master-hdr",
      );
      expect(steppedBack.historyIndex).toBe(1);

      const steppedForward = stepSovereignTabHistory(steppedBack, 1);
      expect(steppedForward.url).toBe("https://news.ycombinator.com");

      const copy = duplicateSovereignTab(steppedForward, "tab-copy-1");
      expect(copy.id).toBe("tab-copy-1");
      expect(copy.pinned).toBe(false);
      expect(copy.url).toBe("https://news.ycombinator.com");
    });
  });

  describe("Elements / DOM Inspector Tree & Box Model", () => {
    it("parses HTML into hierarchical DomInspectorNode tree with computed box model", () => {
      const html = synthesizePageHtmlForUrl(
        "https://stream-vault.omnia.local/watch/4k-master-hdr",
        "4K Media Hub",
      );
      const tree = parseHtmlIntoDomInspectorTree(html);
      expect(tree.length).toBeGreaterThan(0);

      const root = tree[0]!;
      expect(root.tag).toBe("body");
      expect(root.elementId).toBe("sovereign-root");
      expect(root.boxModel.contentWidth).toBe(1280);
      expect(root.boxModel.padding.top).toBe(24);

      const flat = flattenDomInspectorTree(tree);
      expect(flat.length).toBeGreaterThanOrEqual(7);

      const videoNodes = queryDomInspectorNodes(tree, "video#primary-video-stream");
      expect(videoNodes).toHaveLength(1);
      expect(videoNodes[0]?.boxModel.contentWidth).toBe(920);
      expect(videoNodes[0]?.boxModel.contentHeight).toBe(480);
      expect(videoNodes[0]?.boxModel.border.top).toBe(2);
    });

    it("supports live attribute/style mutation and CSS selector queries", () => {
      const tree = parseHtmlIntoDomInspectorTree(
        `<div id="card-1" class="card featured" style="width: 400px; height: 200px; margin: 10px; padding: 12px;"><button class="cta" data-role="download">Get Stream</button></div>`,
      );
      const button = queryDomInspectorNodes(tree, 'button[data-role="download"]')[0]!;
      expect(button).toBeDefined();

      const mutatedTree = mutateDomInspectorNode(tree, button.id, {
        attributes: { "data-role": "instant-idm", class: "cta active" },
        inlineStyles: { width: "260px", height: "52px", "margin-top": "18px" },
        textContent: "Download 4K Now",
      });

      const updatedBtn = queryDomInspectorNodes(
        mutatedTree,
        "div.featured button.active",
      )[0]!;
      expect(updatedBtn).toBeDefined();
      expect(updatedBtn.attributes["data-role"]).toBe("instant-idm");
      expect(updatedBtn.textContent).toBe("Download 4K Now");
      expect(updatedBtn.boxModel.contentWidth).toBe(260);
      expect(updatedBtn.boxModel.contentHeight).toBe(52);
      expect(updatedBtn.boxModel.margin.top).toBe(18);

      const serialized = serializeDomInspectorTreeToHtml(mutatedTree);
      expect(serialized).toContain("Download 4K Now");
      expect(serialized).toContain('data-role="instant-idm"');
    });
  });

  describe("Console REPL Engine", () => {
    it("evaluates JS expressions and built-in DevTools helpers ($0, $, $$, $_, copy, extractLinks, extractMediaStreams, extractStorage)", () => {
      const domTree = parseHtmlIntoDomInspectorTree(
        synthesizePageHtmlForUrl("https://stream-vault.omnia.local/watch/4k"),
      );
      const cookies = createDefaultCookies();
      const storage = createDefaultStorageEntries();
      const networkEntries = createDefaultSovereignNetworkEntries();
      const videoNode = queryDomInspectorNodes(domTree, "video")[0]!;

      const baseContext = {
        url: "https://stream-vault.omnia.local/watch/4k",
        title: "4K Stream Hub",
        domTree,
        selectedNodeId: videoNode.id,
        cookies,
        localStorage: storage.filter((s) => s.storageArea === "localStorage"),
        sessionStorage: storage.filter((s) => s.storageArea === "sessionStorage"),
        networkEntries,
      };

      const dollarZeroEval = evaluateSovereignConsoleCommand("$0.tag", baseContext);
      expect(dollarZeroEval.lastResult).toBe("video");

      const prevEval = evaluateSovereignConsoleCommand(
        "$_ + '-verified'",
        { ...baseContext, lastResult: dollarZeroEval.lastResult },
      );
      expect(prevEval.lastResult).toBe("video-verified");

      const linksEval = evaluateSovereignConsoleCommand(
        "extractLinks()",
        baseContext,
      );
      expect(Array.isArray(linksEval.lastResult)).toBe(true);
      expect((linksEval.lastResult as unknown[]).length).toBeGreaterThanOrEqual(3);

      const streamsEval = evaluateSovereignConsoleCommand(
        "extractMediaStreams()",
        baseContext,
      );
      const streamsData = streamsEval.lastResult as {
        sniffedNetworkStreams: unknown[];
        domMediaNodes: unknown[];
      };
      expect(streamsData.sniffedNetworkStreams.length).toBeGreaterThanOrEqual(4);
      expect(streamsData.domMediaNodes.length).toBeGreaterThanOrEqual(1);

      const storageEval = evaluateSovereignConsoleCommand(
        "extractStorage()",
        baseContext,
      );
      expect(storageEval.lastResult).toHaveProperty("cookies");
      expect(storageEval.lastResult).toHaveProperty("localStorage");

      const copyEval = evaluateSovereignConsoleCommand(
        "copy(document.cookie)",
        baseContext,
      );
      expect(copyEval.copiedText).toContain("omnia_sovereign_session=");

      const errEval = evaluateSovereignConsoleCommand(
        "nonExistentSymbolXYZ()",
        baseContext,
      );
      expect(errEval.entries[0]?.level).toBe("error");
      expect(errEval.entries[0]?.output).toContain("Uncaught EvalError");
    });
  });

  describe("Network Waterfall, cURL/fetch Generator & Media Sniffer", () => {
    it("generates cURL and fetch() snippets and ranks downloadable media streams", () => {
      const entries = createDefaultSovereignNetworkEntries();
      const postEntry = entries.find((e) => e.id === "net-api-graphql")!;

      const curlCmd = generateCurlCommandFromNetworkEntry(postEntry);
      expect(curlCmd).toContain("curl -X POST 'https://api.omnia.local/v2/graphql'");
      expect(curlCmd).toContain("Authorization: Bearer sov_unrestricted_token_99x");
      expect(curlCmd).toContain("--data-raw");

      const fetchCode = generateFetchCodeFromNetworkEntry(postEntry);
      expect(fetchCode).toContain('await fetch("https://api.omnia.local/v2/graphql"');
      expect(fetchCode).toContain('"method": "POST"');

      const media = extractDownloadableMediaFromNetworkLog(entries);
      expect(media.length).toBeGreaterThanOrEqual(4);
      expect(media[0]?.streamKind).toBe("hls-m3u8");
      expect(media[0]?.priorityScore).toBe(100);
      expect(media.some((m) => m.streamKind === "dash-mpd")).toBe(true);
      expect(media.some((m) => m.streamKind === "blob-stream")).toBe(true);

      const replayed = replayAndMutateNetworkEntry(postEntry, {
        method: "PUT",
        requestBody: '{"override":true}',
      });
      expect(replayed.method).toBe("PUT");
      expect(replayed.requestBody).toBe('{"override":true}');
      expect(replayed.responsePreview).toContain("Omnia Sovereign Network Interceptor");
    });
  });

  describe("Application Storage, Cookies & Userscripts CRUD", () => {
    it("manages cookies, localStorage/sessionStorage, and Tampermonkey userscripts", () => {
      const initialCookies = createDefaultCookies();
      const withAdded = upsertCookieEntry(initialCookies, {
        name: "custom_auth",
        value: "xyz987",
        domain: ".omnia.local",
        path: "/",
        expires: "Session",
        httpOnly: false,
        secure: true,
        sameSite: "Lax",
      });
      expect(withAdded).toHaveLength(initialCookies.length + 1);

      const updatedCookies = upsertCookieEntry(withAdded, {
        name: "custom_auth",
        value: "updated_123",
        domain: ".omnia.local",
        path: "/",
        expires: "Session",
        httpOnly: false,
        secure: true,
        sameSite: "Lax",
      });
      expect(updatedCookies).toHaveLength(withAdded.length);
      expect(
        updatedCookies.find((c) => c.name === "custom_auth")?.value,
      ).toBe("updated_123");

      const afterDeleteCookie = deleteCookieEntry(
        updatedCookies,
        updatedCookies[0]!.id,
      );
      expect(afterDeleteCookie).toHaveLength(updatedCookies.length - 1);

      const initialStorage = createDefaultStorageEntries();
      const addedStorage = upsertStorageEntry(initialStorage, {
        storageArea: "localStorage",
        key: "sovereign.theme",
        value: "cyber-obsidian",
      });
      expect(addedStorage).toHaveLength(initialStorage.length + 1);
      const removedStorage = deleteStorageEntry(
        addedStorage,
        addedStorage[0]!.id,
      );
      expect(removedStorage).toHaveLength(addedStorage.length - 1);

      const scripts = createDefaultUserscripts();
      const meta = parseUserscriptHeaderMetadata(scripts[0]!.code);
      expect(meta.name).toContain("Unlock Right-Click");
      expect(meta.matchPattern).toBe("*://*/*");
      expect(meta.runAt).toBe("document-start");

      const matched = matchUserscriptsForUrl(
        scripts,
        "https://stream-vault.omnia.local/watch/4k",
      );
      expect(matched).toHaveLength(3);

      const toggled = toggleUserscriptEntry(scripts, scripts[2]!.id, false);
      expect(
        matchUserscriptsForUrl(
          toggled,
          "https://stream-vault.omnia.local/watch/4k",
        ),
      ).toHaveLength(2);

      const upsertedScripts = upsertUserscriptEntry(toggled, {
        name: "Custom Ad & Overlay Stripper",
        matchPattern: "*://*/*",
        runAt: "document-idle",
        enabled: true,
        description: "Removes fixed overlays",
        code: "// custom script",
      });
      expect(upsertedScripts).toHaveLength(4);
      expect(
        deleteUserscriptEntry(upsertedScripts, upsertedScripts[0]!.id),
      ).toHaveLength(3);
    });
  });

  describe("Browser Profile Linker & Native Launcher (Edge, Chrome Canary, Chrome, Brave)", () => {
    it("exports host browser presets for Edge, Chrome Canary, Chrome, Brave, and Omnia Dedicated Profile", () => {
      expect(DEFAULT_BROWSER_PROFILE_PRESETS.length).toBeGreaterThanOrEqual(5);

      const edgePreset = DEFAULT_BROWSER_PROFILE_PRESETS.find(
        (p) => p.flavor === "edge",
      )!;
      expect(edgePreset).toBeDefined();
      expect(edgePreset.executablePath).toBe(
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      );
      expect(edgePreset.userDataDir).toBe(
        "C:\\Users\\khang\\AppData\\Local\\Microsoft\\Edge\\User Data",
      );
      expect(edgePreset.profileDirectory).toBe("Default");

      const canaryPreset = DEFAULT_BROWSER_PROFILE_PRESETS.find(
        (p) => p.flavor === "chrome-canary",
      )!;
      expect(canaryPreset).toBeDefined();
      expect(canaryPreset.executablePath).toBe(
        "C:\\Users\\khang\\AppData\\Local\\Google\\Chrome SxS\\Application\\chrome.exe",
      );
      expect(canaryPreset.userDataDir).toBe(
        "C:\\Users\\khang\\AppData\\Local\\Google\\Chrome SxS\\User Data",
      );

      const chromePreset = DEFAULT_BROWSER_PROFILE_PRESETS.find(
        (p) => p.flavor === "chrome",
      )!;
      expect(chromePreset.executablePath).toBe(
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      );

      const bravePreset = DEFAULT_BROWSER_PROFILE_PRESETS.find(
        (p) => p.flavor === "brave",
      )!;
      expect(bravePreset.executablePath).toBe(
        "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
      );
    });

    it("builds PowerShell launch command and CDP WebSocket endpoint with anti-automation & F12 flags", () => {
      const canary = DEFAULT_BROWSER_PROFILE_PRESETS.find(
        (p) => p.flavor === "chrome-canary",
      )!;
      const plan = buildBrowserProfileLaunchCommand(
        {
          ...canary,
          profileDirectory: "Profile 1",
          remoteDebuggingPort: 9223,
        },
        "https://www.google.com/search?q=omnia",
      );

      expect(plan.powershellCommand).toBe(
        '& "C:\\Users\\khang\\AppData\\Local\\Google\\Chrome SxS\\Application\\chrome.exe" --user-data-dir="C:\\Users\\khang\\AppData\\Local\\Google\\Chrome SxS\\User Data" --profile-directory="Profile 1" --remote-debugging-port=9223 --disable-blink-features=AutomationControlled --auto-open-devtools-for-tabs "https://www.google.com/search?q=omnia"',
      );
      expect(plan.cdpWebSocketEndpoint).toBe(
        "ws://127.0.0.1:9223/devtools/browser",
      );
      expect(plan.explanation).toContain("AutomationControlled");
      expect(plan.explanation).toContain("cf_clearance");
    });
  });

  describe("Universal Cookie Importer / Exporter (Netscape, JSON Array, HTTP Header)", () => {
    it("parses Netscape cookies.txt format, JSON Cookie Array, and raw HTTP Cookie header strings", () => {
      // 1. Netscape cookies.txt
      const netscapeInput = [
        "# Netscape HTTP Cookie File",
        "#HttpOnly_.google.com\tTRUE\t/\tTRUE\t1800000000\tSID\tgoogle_sid_token_123",
        ".cloudflare.com\tTRUE\t/\tTRUE\t1800000000\tcf_clearance\tcf_human_pass_999",
      ].join("\n");

      const fromNetscape = parseImportedCookies(netscapeInput);
      expect(fromNetscape).toHaveLength(2);
      expect(fromNetscape[0]).toMatchObject({
        name: "SID",
        value: "google_sid_token_123",
        domain: ".google.com",
        httpOnly: true,
        secure: true,
      });
      expect(fromNetscape[1]).toMatchObject({
        name: "cf_clearance",
        value: "cf_human_pass_999",
        domain: ".cloudflare.com",
        httpOnly: false,
        secure: true,
      });

      // 2. JSON Cookie Array (Chrome / Edge F12 / Cookie-Editor)
      const jsonInput = JSON.stringify([
        {
          name: "__Secure-1PSID",
          value: "canary_psid_abc",
          domain: ".google.com",
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "no_restriction",
          expirationDate: 1893456000,
        },
        {
          name: "NID",
          value: "511=google_trust_nid",
          domain: ".google.com",
          path: "/",
          secure: true,
          httpOnly: false,
          sameSite: "Lax",
        },
      ]);

      const fromJson = parseImportedCookies(jsonInput);
      expect(fromJson).toHaveLength(2);
      expect(fromJson[0]).toMatchObject({
        name: "__Secure-1PSID",
        value: "canary_psid_abc",
        domain: ".google.com",
        sameSite: "None",
        httpOnly: true,
      });
      expect(fromJson[1]?.name).toBe("NID");

      // 3. Raw HTTP Cookie: Header
      const headerInput =
        "Cookie: cf_clearance=xyz_human_verified; SID=abc_session; __Secure-1PSID=def_secure";
      const fromHeader = parseImportedCookies(headerInput, ".google.com");
      expect(fromHeader).toHaveLength(3);
      expect(fromHeader.map((c) => c.name)).toEqual([
        "cf_clearance",
        "SID",
        "__Secure-1PSID",
      ]);
      expect(fromHeader[0]?.domain).toBe(".google.com");

      // Export to Netscape format and build Cookie header string for Fetch & IDM+
      const netscapeExported = exportCookiesToNetscapeFormat(fromJson);
      expect(netscapeExported).toContain("# Netscape HTTP Cookie File");
      expect(netscapeExported).toContain("__Secure-1PSID\tcanary_psid_abc");

      const headerStr = buildCookieHeaderString(
        fromJson,
        "https://www.google.com/search?q=test",
      );
      expect(headerStr).toBe(
        "__Secure-1PSID=canary_psid_abc; NID=511=google_trust_nid",
      );
    });
  });

  describe("CAPTCHA / Turnstile Detection & Clearance Helper", () => {
    it("detects Cloudflare Turnstile, Google reCAPTCHA, hCaptcha, and 403 challenge pages", () => {
      const turnstileDetection = detectCaptchaOrChallengeInHtml(
        '<html><body><div class="cf-turnstile" data-sitekey="0x4AAAAAA"></div><script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script></body></html>',
      );
      expect(turnstileDetection.detected).toBe(true);
      expect(turnstileDetection.challengeType).toBe("cloudflare-turnstile");
      expect(turnstileDetection.clearanceCookieNames).toEqual([
        "cf_clearance",
        "__cf_bm",
        "NID",
      ]);

      const recaptchaDetection = detectCaptchaOrChallengeInHtml(
        '<div class="g-recaptcha" data-sitekey="6Lc..."></div>',
      );
      expect(recaptchaDetection.detected).toBe(true);
      expect(recaptchaDetection.challengeType).toBe("recaptcha");

      const hcaptchaDetection = detectCaptchaOrChallengeInHtml(
        '<div class="h-captcha" data-sitekey="10000000-ffff-ffff-ffff-000000000001"></div>',
      );
      expect(hcaptchaDetection.detected).toBe(true);
      expect(hcaptchaDetection.challengeType).toBe("hcaptcha");

      const cleanDetection = detectCaptchaOrChallengeInHtml(
        "<html><body><h1>Clean Open Web Article</h1></body></html>",
      );
      expect(cleanDetection.detected).toBe(false);
      expect(cleanDetection.challengeType).toBe("none");
    });
  });

  describe("Device Emulation Presets & Anti-Detect Stealth Script Generator", () => {
    it("exports Chrome DevTools responsive viewport presets (Desktop 1080p, MacBook Pro 16, iPhone 16 Pro, iPad Pro 13, 4K Studio Display)", () => {
      expect(DEVICE_VIEWPORT_PRESETS).toHaveLength(5);

      const desktop = DEVICE_VIEWPORT_PRESETS.find(
        (p) => p.id === "desktop-1080p",
      )!;
      expect(desktop.width).toBe(1920);
      expect(desktop.height).toBe(1080);
      expect(desktop.hasTouch).toBe(false);

      const macbook = DEVICE_VIEWPORT_PRESETS.find(
        (p) => p.id === "macbook-pro-16",
      )!;
      expect(macbook.width).toBe(1728);
      expect(macbook.height).toBe(1117);

      const iphone = DEVICE_VIEWPORT_PRESETS.find(
        (p) => p.id === "iphone-16-pro",
      )!;
      expect(iphone.width).toBe(402);
      expect(iphone.height).toBe(874);
      expect(iphone.isMobile).toBe(true);
      expect(iphone.hasTouch).toBe(true);
      expect(iphone.userAgentPreset).toBe("mobile-iphone-safari");

      const ipad = DEVICE_VIEWPORT_PRESETS.find((p) => p.id === "ipad-pro-13")!;
      expect(ipad.width).toBe(1032);
      expect(ipad.height).toBe(1376);

      const studio4k = DEVICE_VIEWPORT_PRESETS.find(
        (p) => p.id === "studio-display-4k",
      )!;
      expect(studio4k.width).toBe(3840);
      expect(studio4k.height).toBe(2160);
    });

    it("generates anti-detect stealth injection script spoofing navigator.webdriver, NVIDIA GTX 1650 Ti WebGL, Canvas, AudioContext, and chrome.runtime", () => {
      const defaultStealth = createDefaultStealthFingerprintConfig();
      expect(defaultStealth.enabled).toBe(true);
      expect(defaultStealth.webglRenderer).toContain("NVIDIA GeForce GTX 1650 Ti");

      const script = buildAntiDetectStealthScript(defaultStealth);
      expect(script).toContain("Object.defineProperty(navigator, 'webdriver'");
      expect(script).toContain("NVIDIA GeForce GTX 1650 Ti");
      expect(script).toContain("window.chrome.runtime");
      expect(script).toContain("HTMLCanvasElement.prototype.toDataURL");
      expect(script).toContain("AudioBuffer.prototype.getChannelData");
      expect(script).toContain("window.__OMNIA_STEALTH_ACTIVE__ = true;");

      const disabledScript = buildAntiDetectStealthScript({ enabled: false });
      expect(disabledScript).toContain("Disabled");
    });
  });

  describe("Accessibility / Set-of-Marks (SoM) Tree & Page Performance Metrics", () => {
    it("extracts interactive [SoM #1]..[#N] marks and computes Web Vitals & Flamechart spans", () => {
      const html = synthesizePageHtmlForUrl(
        "https://stream-vault.omnia.local/watch/4k-master-hdr",
        "4K Media Hub",
      );
      const tree = parseHtmlIntoDomInspectorTree(html);
      const somSnapshot = captureAccessibilityAndSomTree(
        tree,
        "https://stream-vault.omnia.local/watch/4k-master-hdr",
      );

      expect(somSnapshot.totalDomNodes).toBeGreaterThanOrEqual(7);
      expect(somSnapshot.interactiveMarksCount).toBeGreaterThanOrEqual(5);
      expect(somSnapshot.marks[0]?.markLabel).toBe("[SoM #1]");
      expect(somSnapshot.marks.some((m) => m.tag === "video")).toBe(true);
      expect(somSnapshot.marks.some((m) => m.tag === "button")).toBe(true);
      expect(somSnapshot.agentPromptSummary).toContain("[SoM #1]");

      const networkEntries = createDefaultSovereignNetworkEntries();
      const perf = computePagePerformanceMetrics(tree, networkEntries);
      expect(perf.lcpMs).toBeGreaterThan(0);
      expect(perf.ttfbMs).toBe(28);
      expect(perf.clsScore).toBeLessThan(0.1);
      expect(perf.inpMs).toBeLessThanOrEqual(50);
      expect(perf.jsHeapUsedMb).toBeGreaterThan(30);
      expect(perf.flamechartSpans.length).toBeGreaterThanOrEqual(5);
    });
  });
});


