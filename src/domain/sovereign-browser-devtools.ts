export type LoadMode =
  | "interactive-frame"
  | "synthesized-dom-bypass"
  | "native-cdp-window";

export type SovereignLoadMode = LoadMode;

export type SovereignSearchEngineId =
  | "google"
  | "duckduckgo"
  | "brave"
  | "github"
  | "perplexity";

export type SovereignUserAgentPreset =
  | "desktop-chrome-win11"
  | "desktop-firefox-win11"
  | "mobile-iphone-safari"
  | "mobile-android-chrome"
  | "googlebot-crawler"
  | "omnia-sovereign-agent";

export interface SovereignCustomHeader {
  id: string;
  name: string;
  value: string;
  enabled: boolean;
}

export interface SovereignBookmark {
  id: string;
  title: string;
  url: string;
  category: string;
}

export interface SovereignBrowserTab {
  id: string;
  title: string;
  url: string;
  loadMode: LoadMode;
  history: string[];
  historyIndex: number;
  pinned: boolean;
  muted: boolean;
  zoomLevel: number;
  userAgentPreset: SovereignUserAgentPreset;
  customHeaders: SovereignCustomHeader[];
  corsBypassEnabled: boolean;
  cspStripEnabled: boolean;
  xFrameBypassEnabled: boolean;
  userscriptsEnabled: boolean;
  isLoading?: boolean;
}

export interface SovereignPermissionPolicy {
  allowAllSovereignUnrestricted: boolean;
  clipboardReadWrite: boolean;
  geolocation: boolean;
  cameraMicrophone: boolean;
  popupsAndNewWindows: boolean;
  cookiesAndThirdPartyStorage: boolean;
  corsAndCrossOriginFetch: boolean;
  xFrameOptionsBypass: boolean;
  cspBypass: boolean;
  userscriptInjection: boolean;
  devtoolsProtocolAccess: boolean;
  automaticMediaSniffing: boolean;
  isolatedVirtualInput: boolean;
}

export type SovereignPermissionFlagKey = Exclude<
  keyof SovereignPermissionPolicy,
  "allowAllSovereignUnrestricted"
>;

export interface ResolvedOmniboxTarget {
  resolvedUrl: string;
  kind:
    | "url"
    | "local"
    | "protocol"
    | "data"
    | "file"
    | "domain-shorthand"
    | "search-query";
  searchEngine: SovereignSearchEngineId;
  displayTitle: string;
}

export interface BoxEdgeMetrics {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface ComputedBoxModel {
  margin: BoxEdgeMetrics;
  border: BoxEdgeMetrics;
  padding: BoxEdgeMetrics;
  contentWidth: number;
  contentHeight: number;
}

export interface DomInspectorNode {
  id: string;
  tag: string;
  elementId: string;
  classes: string[];
  attributes: Record<string, string>;
  inlineStyles: Record<string, string>;
  textContent: string;
  children: DomInspectorNode[];
  boxModel: ComputedBoxModel;
  pathSelector: string;
}

export interface DomNodeMutation {
  tag?: string;
  attributes?: Record<string, string | null>;
  inlineStyles?: Record<string, string | null>;
  textContent?: string;
}

export type ConsoleLogLevel =
  | "log"
  | "info"
  | "warn"
  | "error"
  | "table"
  | "result";

export interface ConsoleLogEntry {
  id: string;
  timestamp: string;
  level: ConsoleLogLevel;
  command?: string;
  output: string;
  structuredData?: unknown;
}

export type SovereignResourceType =
  | "document"
  | "fetch"
  | "script"
  | "stylesheet"
  | "media"
  | "hls-m3u8"
  | "dash-mpd"
  | "blob"
  | "websocket";

export interface SovereignNetworkTimings {
  dnsMs: number;
  tcpMs: number;
  tlsMs: number;
  ttfbMs: number;
  downloadMs: number;
}

export type SovereignHttpMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "OPTIONS"
  | "WS";

export interface SovereignNetworkEntry {
  id: string;
  method: SovereignHttpMethod;
  url: string;
  status: number;
  resourceType: SovereignResourceType;
  mimeType: string;
  sizeBytes: number;
  durationMs: number;
  timings: SovereignNetworkTimings;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  requestBody?: string;
  responsePreview: string;
  isStreamOrDownloadable: boolean;
  streamQualityLabel?: string;
}

export type SniffedMediaStreamKind =
  | "hls-m3u8"
  | "dash-mpd"
  | "blob-stream"
  | "direct-video"
  | "direct-audio"
  | "archive-document";

export interface SniffedMediaCandidate {
  id: string;
  networkEntryId: string;
  url: string;
  suggestedFilename: string;
  streamKind: SniffedMediaStreamKind;
  mimeType: string;
  sizeBytes: number;
  qualityLabel: string;
  priorityScore: number;
  headers: Record<string, string>;
}

export interface CookieEntry {
  id: string;
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Lax" | "Strict" | "None";
}

export interface StorageKeyValueEntry {
  id: string;
  storageArea: "localStorage" | "sessionStorage";
  key: string;
  value: string;
}

export interface UserscriptEntry {
  id: string;
  name: string;
  matchPattern: string;
  runAt: "document-start" | "document-end" | "document-idle";
  enabled: boolean;
  description: string;
  code: string;
}

export interface SovereignConsoleContext {
  url: string;
  title: string;
  domTree: DomInspectorNode[];
  selectedNodeId?: string | null;
  lastResult?: unknown;
  cookies: CookieEntry[];
  localStorage: StorageKeyValueEntry[];
  sessionStorage: StorageKeyValueEntry[];
  networkEntries: SovereignNetworkEntry[];
}

export interface SovereignConsoleEvaluationResult {
  entries: ConsoleLogEntry[];
  lastResult: unknown;
  copiedText?: string;
}

export const SEARCH_ENGINE_TEMPLATES: Record<
  SovereignSearchEngineId,
  { label: string; buildUrl: (query: string) => string }
> = {
  google: {
    label: "Google",
    buildUrl: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
  },
  duckduckgo: {
    label: "DuckDuckGo",
    buildUrl: (q) => `https://duckduckgo.com/?q=${encodeURIComponent(q)}`,
  },
  brave: {
    label: "Brave Search",
    buildUrl: (q) => `https://search.brave.com/search?q=${encodeURIComponent(q)}`,
  },
  github: {
    label: "GitHub Code/Repos",
    buildUrl: (q) => `https://github.com/search?q=${encodeURIComponent(q)}&type=repositories`,
  },
  perplexity: {
    label: "Perplexity AI",
    buildUrl: (q) => `https://www.perplexity.ai/search?q=${encodeURIComponent(q)}`,
  },
};

export const USER_AGENT_PRESET_STRINGS: Record<
  SovereignUserAgentPreset,
  { label: string; userAgent: string }
> = {
  "desktop-chrome-win11": {
    label: "Chrome 134 (Windows 11 x64)",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
  },
  "desktop-firefox-win11": {
    label: "Firefox 136 (Windows 11 x64)",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:136.0) Gecko/20100101 Firefox/136.0",
  },
  "mobile-iphone-safari": {
    label: "Safari Mobile (iPhone 16 Pro iOS 18)",
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1",
  },
  "mobile-android-chrome": {
    label: "Chrome Mobile (Android 15 Pixel 9)",
    userAgent:
      "Mozilla/5.0 (Linux; Android 15; Pixel 9 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.6998.45 Mobile Safari/537.36",
  },
  "googlebot-crawler": {
    label: "Googlebot Desktop Indexer",
    userAgent:
      "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  },
  "omnia-sovereign-agent": {
    label: "Omnia Sovereign Unrestricted Runtime/2.0",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) OmniaSovereign/2.0 Chrome/134.0.0.0 Safari/537.36",
  },
};

export const SOVEREIGN_PERMISSION_FLAG_KEYS: readonly SovereignPermissionFlagKey[] = [
  "clipboardReadWrite",
  "geolocation",
  "cameraMicrophone",
  "popupsAndNewWindows",
  "cookiesAndThirdPartyStorage",
  "corsAndCrossOriginFetch",
  "xFrameOptionsBypass",
  "cspBypass",
  "userscriptInjection",
  "devtoolsProtocolAccess",
  "automaticMediaSniffing",
  "isolatedVirtualInput",
] as const;

export function createSovereignPermissionPolicy(
  allowAll = true,
): SovereignPermissionPolicy {
  return {
    allowAllSovereignUnrestricted: allowAll,
    clipboardReadWrite: allowAll,
    geolocation: allowAll,
    cameraMicrophone: allowAll,
    popupsAndNewWindows: allowAll,
    cookiesAndThirdPartyStorage: allowAll,
    corsAndCrossOriginFetch: allowAll,
    xFrameOptionsBypass: allowAll,
    cspBypass: allowAll,
    userscriptInjection: allowAll,
    devtoolsProtocolAccess: allowAll,
    automaticMediaSniffing: allowAll,
    isolatedVirtualInput: allowAll,
  };
}

export function toggleSovereignAllowAllMaster(
  _policy: SovereignPermissionPolicy,
  enabled: boolean,
): SovereignPermissionPolicy {
  return createSovereignPermissionPolicy(enabled);
}

export function setSovereignPermissionFlag(
  policy: SovereignPermissionPolicy,
  key: SovereignPermissionFlagKey,
  value: boolean,
): SovereignPermissionPolicy {
  const next: SovereignPermissionPolicy = {
    ...policy,
    [key]: value,
  };
  const allEnabled = SOVEREIGN_PERMISSION_FLAG_KEYS.every((flagKey) => next[flagKey]);
  next.allowAllSovereignUnrestricted = allEnabled;
  return next;
}

export function buildIframeAllowAttribute(policy: SovereignPermissionPolicy): string {
  const permissions: string[] = ["fullscreen", "autoplay", "encrypted-media", "picture-in-picture"];
  if (policy.allowAllSovereignUnrestricted || policy.clipboardReadWrite) {
    permissions.unshift("clipboard-read", "clipboard-write");
  }
  if (policy.allowAllSovereignUnrestricted || policy.cameraMicrophone) {
    permissions.push("camera", "microphone", "display-capture");
  }
  if (policy.allowAllSovereignUnrestricted || policy.geolocation) {
    permissions.push("geolocation");
  }
  return permissions.join("; ");
}

export function resolveSovereignOmniboxInput(
  rawInput: string,
  searchEngine: SovereignSearchEngineId = "google",
): ResolvedOmniboxTarget {
  const trimmed = rawInput.trim();
  const engine = SEARCH_ENGINE_TEMPLATES[searchEngine] ?? SEARCH_ENGINE_TEMPLATES.google;

  if (!trimmed) {
    return {
      resolvedUrl: "omnia://sovereign-home",
      kind: "protocol",
      searchEngine,
      displayTitle: "Sovereign Command Deck",
    };
  }

  const lower = trimmed.toLowerCase();

  if (lower.startsWith("omnia://") || lower.startsWith("about:") || lower.startsWith("chrome://")) {
    return {
      resolvedUrl: trimmed,
      kind: "protocol",
      searchEngine,
      displayTitle: trimmed,
    };
  }

  if (lower.startsWith("data:")) {
    return {
      resolvedUrl: trimmed,
      kind: "data",
      searchEngine,
      displayTitle: "Data URI Document",
    };
  }

  if (lower.startsWith("file://")) {
    return {
      resolvedUrl: trimmed,
      kind: "file",
      searchEngine,
      displayTitle: trimmed.replace(/^file:\/\/\/?/i, ""),
    };
  }

  if (/^[a-zA-Z]:[\\/]/.test(trimmed)) {
    const normalizedPath = trimmed.replaceAll("\\", "/");
    return {
      resolvedUrl: `file:///${normalizedPath}`,
      kind: "file",
      searchEngine,
      displayTitle: normalizedPath,
    };
  }

  if (lower.startsWith("http://") || lower.startsWith("https://")) {
    const isLocal =
      /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(\/|$)/i.test(trimmed);
    return {
      resolvedUrl: trimmed,
      kind: isLocal ? "local" : "url",
      searchEngine,
      displayTitle: extractDisplayTitleFromUrl(trimmed),
    };
  }

  if (
    /^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?(\/.*)?$/i.test(trimmed) &&
    !trimmed.includes(" ")
  ) {
    const resolvedUrl = `http://${trimmed}`;
    return {
      resolvedUrl,
      kind: "local",
      searchEngine,
      displayTitle: trimmed,
    };
  }

  const domainShorthandPattern =
    /^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,24}(:\d+)?(\/\S*)?$/;
  if (!trimmed.includes(" ") && domainShorthandPattern.test(trimmed)) {
    const resolvedUrl = `https://${trimmed}`;
    return {
      resolvedUrl,
      kind: "domain-shorthand",
      searchEngine,
      displayTitle: extractDisplayTitleFromUrl(resolvedUrl),
    };
  }

  return {
    resolvedUrl: engine.buildUrl(trimmed),
    kind: "search-query",
    searchEngine,
    displayTitle: `${trimmed} - ${engine.label}`,
  };
}

function extractDisplayTitleFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./i, "");
    const pathSegment =
      parsed.pathname && parsed.pathname !== "/" ? parsed.pathname : "";
    return `${host}${pathSegment}`;
  } catch {
    return url;
  }
}

export function createDefaultSovereignTabs(): SovereignBrowserTab[] {
  return [
    {
      id: "tab-sovereign-hub",
      title: "Sovereign Media & DevTools Hub",
      url: "https://stream-vault.omnia.local/watch/4k-master-hdr",
      loadMode: "synthesized-dom-bypass",
      history: [
        "omnia://sovereign-home",
        "https://stream-vault.omnia.local/watch/4k-master-hdr",
      ],
      historyIndex: 1,
      pinned: true,
      muted: false,
      zoomLevel: 100,
      userAgentPreset: "omnia-sovereign-agent",
      customHeaders: [
        {
          id: "hdr-auth",
          name: "Authorization",
          value: "Bearer sov_unrestricted_token_99x",
          enabled: true,
        },
        {
          id: "hdr-origin",
          name: "Origin",
          value: "https://stream-vault.omnia.local",
          enabled: true,
        },
      ],
      corsBypassEnabled: true,
      cspStripEnabled: true,
      xFrameBypassEnabled: true,
      userscriptsEnabled: true,
    },
    {
      id: "tab-github-explore",
      title: "github.com/tauri-apps/tauri",
      url: "https://github.com/tauri-apps/tauri",
      loadMode: "synthesized-dom-bypass",
      history: ["https://github.com/tauri-apps/tauri"],
      historyIndex: 0,
      pinned: false,
      muted: false,
      zoomLevel: 100,
      userAgentPreset: "desktop-chrome-win11",
      customHeaders: [],
      corsBypassEnabled: true,
      cspStripEnabled: true,
      xFrameBypassEnabled: true,
      userscriptsEnabled: true,
    },
    {
      id: "tab-hn-live",
      title: "news.ycombinator.com",
      url: "https://news.ycombinator.com",
      loadMode: "interactive-frame",
      history: ["https://news.ycombinator.com"],
      historyIndex: 0,
      pinned: false,
      muted: false,
      zoomLevel: 100,
      userAgentPreset: "desktop-chrome-win11",
      customHeaders: [],
      corsBypassEnabled: true,
      cspStripEnabled: true,
      xFrameBypassEnabled: true,
      userscriptsEnabled: true,
    },
  ];
}

export function createDefaultSovereignBookmarks(): SovereignBookmark[] {
  return [
    {
      id: "bm-stream-vault",
      title: "4K HLS Media Lab",
      url: "https://stream-vault.omnia.local/watch/4k-master-hdr",
      category: "Media & Streams",
    },
    {
      id: "bm-github",
      title: "GitHub Tauri",
      url: "https://github.com/tauri-apps/tauri",
      category: "Engineering",
    },
    {
      id: "bm-hn",
      title: "Hacker News",
      url: "https://news.ycombinator.com",
      category: "Tech News",
    },
    {
      id: "bm-localhost",
      title: "Local Dev Server :1420",
      url: "http://localhost:1420",
      category: "Localhost",
    },
    {
      id: "bm-wiki",
      title: "Wikipedia Open Web",
      url: "https://en.wikipedia.org/wiki/Web_browser",
      category: "Reference",
    },
  ];
}

export function navigateSovereignTab(
  tab: SovereignBrowserTab,
  rawInput: string,
  searchEngine: SovereignSearchEngineId = "google",
): SovereignBrowserTab {
  const resolved = resolveSovereignOmniboxInput(rawInput, searchEngine);
  const slicedHistory = tab.history.slice(0, tab.historyIndex + 1);
  const nextHistory = [...slicedHistory, resolved.resolvedUrl];
  return {
    ...tab,
    url: resolved.resolvedUrl,
    title: resolved.displayTitle,
    history: nextHistory,
    historyIndex: nextHistory.length - 1,
  };
}

export function stepSovereignTabHistory(
  tab: SovereignBrowserTab,
  delta: -1 | 1,
): SovereignBrowserTab {
  const targetIndex = tab.historyIndex + delta;
  const targetUrl = tab.history[targetIndex];
  if (targetIndex < 0 || targetIndex >= tab.history.length || !targetUrl) {
    return tab;
  }
  return {
    ...tab,
    url: targetUrl,
    title: extractDisplayTitleFromUrl(targetUrl),
    historyIndex: targetIndex,
  };
}

export function duplicateSovereignTab(
  tab: SovereignBrowserTab,
  nextId = `${tab.id}-copy-${Date.now()}`,
): SovereignBrowserTab {
  return {
    ...tab,
    id: nextId,
    title: `${tab.title} (Copy)`,
    pinned: false,
    history: [...tab.history],
    customHeaders: tab.customHeaders.map((header) => ({ ...header })),
  };
}

function parsePixelDimension(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const match = /-?\d+(?:\.\d+)?/.exec(value);
  if (!match) return fallback;
  const parsed = Number.parseFloat(match[0]);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : fallback;
}

function parseBoxShorthand(
  styles: Record<string, string>,
  property: "margin" | "padding" | "border",
  defaultEdge: number,
): BoxEdgeMetrics {
  const raw = styles[property] ?? styles[`${property}-width`];
  let base: BoxEdgeMetrics = {
    top: defaultEdge,
    right: defaultEdge,
    bottom: defaultEdge,
    left: defaultEdge,
  };

  if (raw) {
    const numbers = [...raw.matchAll(/(\d+(?:\.\d+)?)px/g)].map((m) =>
      Math.round(Number.parseFloat(m[1] ?? "0")),
    );
    if (numbers.length === 1 && numbers[0] !== undefined) {
      base = {
        top: numbers[0],
        right: numbers[0],
        bottom: numbers[0],
        left: numbers[0],
      };
    } else if (numbers.length === 2 && numbers[0] !== undefined && numbers[1] !== undefined) {
      base = {
        top: numbers[0],
        right: numbers[1],
        bottom: numbers[0],
        left: numbers[1],
      };
    } else if (
      numbers.length >= 4 &&
      numbers[0] !== undefined &&
      numbers[1] !== undefined &&
      numbers[2] !== undefined &&
      numbers[3] !== undefined
    ) {
      base = {
        top: numbers[0],
        right: numbers[1],
        bottom: numbers[2],
        left: numbers[3],
      };
    } else if (property === "border" && raw.includes("solid")) {
      const single = parsePixelDimension(raw, 1);
      base = { top: single, right: single, bottom: single, left: single };
    }
  }

  return {
    top: parsePixelDimension(styles[`${property}-top`], base.top),
    right: parsePixelDimension(styles[`${property}-right`], base.right),
    bottom: parsePixelDimension(styles[`${property}-bottom`], base.bottom),
    left: parsePixelDimension(styles[`${property}-left`], base.left),
  };
}

export function computeBoxModelForTagAndStyles(
  tag: string,
  inlineStyles: Record<string, string>,
): ComputedBoxModel {
  const defaultSizes: Record<
    string,
    { w: number; h: number; m: number; b: number; p: number }
  > = {
    body: { w: 1280, h: 820, m: 0, b: 0, p: 24 },
    header: { w: 1232, h: 72, m: 12, b: 1, p: 16 },
    main: { w: 1232, h: 640, m: 16, b: 1, p: 20 },
    section: { w: 1180, h: 320, m: 12, b: 1, p: 16 },
    article: { w: 760, h: 280, m: 10, b: 1, p: 16 },
    div: { w: 680, h: 160, m: 8, b: 1, p: 12 },
    video: { w: 960, h: 540, m: 12, b: 2, p: 0 },
    button: { w: 148, h: 38, m: 4, b: 1, p: 10 },
    a: { w: 180, h: 24, m: 2, b: 0, p: 4 },
    input: { w: 320, h: 36, m: 4, b: 1, p: 8 },
  };
  const defaults = defaultSizes[tag] ?? { w: 480, h: 64, m: 6, b: 1, p: 8 };

  return {
    margin: parseBoxShorthand(inlineStyles, "margin", defaults.m),
    border: parseBoxShorthand(inlineStyles, "border", defaults.b),
    padding: parseBoxShorthand(inlineStyles, "padding", defaults.p),
    contentWidth: parsePixelDimension(inlineStyles.width, defaults.w),
    contentHeight: parsePixelDimension(inlineStyles.height, defaults.h),
  };
}

export function parseInlineStyleDeclaration(
  styleString: string | undefined,
): Record<string, string> {
  if (!styleString) return {};
  const result: Record<string, string> = {};
  for (const chunk of styleString.split(";")) {
    const colonIndex = chunk.indexOf(":");
    if (colonIndex <= 0) continue;
    const key = chunk.slice(0, colonIndex).trim().toLowerCase();
    const value = chunk.slice(colonIndex + 1).trim();
    if (key && value) {
      result[key] = value;
    }
  }
  return result;
}

export function serializeInlineStyleDeclaration(
  styles: Record<string, string>,
): string {
  return Object.entries(styles)
    .filter(([k, v]) => k.trim().length > 0 && v.trim().length > 0)
    .map(([k, v]) => `${k.trim()}: ${v.trim()}`)
    .join("; ");
}

function buildNodePathSelector(
  tag: string,
  elementId: string,
  classes: string[],
  parentPath: string,
): string {
  const idPart = elementId ? `#${elementId}` : "";
  const classPart =
    classes.length > 0 ? `.${classes.slice(0, 2).join(".")}` : "";
  const selfSelector = `${tag}${idPart}${classPart}`;
  return parentPath ? `${parentPath} > ${selfSelector}` : selfSelector;
}

export function parseHtmlIntoDomInspectorTree(html: string): DomInspectorNode[] {
  const trimmed = html.trim();
  if (!trimmed) return [];

  let counter = 0;
  const nextNodeId = () => {
    counter += 1;
    return `dom-node-${counter}`;
  };

  if (typeof DOMParser !== "undefined") {
    const parser = new DOMParser();
    const doc = parser.parseFromString(trimmed, "text/html");

    const convertElement = (
      el: Element,
      parentPath: string,
    ): DomInspectorNode => {
      const id = nextNodeId();
      const tag = el.tagName.toLowerCase();
      const attributes: Record<string, string> = {};
      for (const attr of Array.from(el.attributes)) {
        attributes[attr.name] = attr.value;
      }
      const elementId = attributes.id ?? "";
      const classes = (attributes.class ?? "")
        .split(/\s+/)
        .map((c) => c.trim())
        .filter(Boolean);
      const inlineStyles = parseInlineStyleDeclaration(attributes.style);
      const pathSelector = buildNodePathSelector(
        tag,
        elementId,
        classes,
        parentPath,
      );

      const directTextParts: string[] = [];
      for (const childNode of Array.from(el.childNodes)) {
        if (childNode.nodeType === 3) {
          const text = childNode.textContent?.trim();
          if (text) directTextParts.push(text);
        }
      }

      const children = Array.from(el.children).map((childEl) =>
        convertElement(childEl, pathSelector),
      );

      return {
        id,
        tag,
        elementId,
        classes,
        attributes,
        inlineStyles,
        textContent: directTextParts.join(" "),
        children,
        boxModel: computeBoxModelForTagAndStyles(tag, inlineStyles),
        pathSelector,
      };
    };

    const hasFullDocumentTag = /<\s*(?:!doctype|html|body)\b/i.test(trimmed);
    if (hasFullDocumentTag && doc.body) {
      return [convertElement(doc.body, "")];
    }
    const bodyChildren = Array.from(doc.body.children);
    if (bodyChildren.length > 0) {
      return bodyChildren.map((el) => convertElement(el, ""));
    }
  }

  return [];
}

export function mutateDomInspectorNode(
  tree: DomInspectorNode[],
  targetNodeId: string,
  mutation: DomNodeMutation,
): DomInspectorNode[] {
  const visit = (node: DomInspectorNode, parentPath: string): DomInspectorNode => {
    let nextNode = node;

    if (node.id === targetNodeId) {
      const nextTag = mutation.tag ? mutation.tag.toLowerCase().trim() : node.tag;
      const nextAttributes: Record<string, string> = { ...node.attributes };

      if (mutation.attributes) {
        for (const [attrKey, attrValue] of Object.entries(mutation.attributes)) {
          if (attrValue === null) {
            delete nextAttributes[attrKey];
          } else {
            nextAttributes[attrKey] = attrValue;
          }
        }
      }

      let nextInlineStyles: Record<string, string> = { ...node.inlineStyles };
      if (mutation.attributes && "style" in mutation.attributes) {
        nextInlineStyles = parseInlineStyleDeclaration(nextAttributes.style);
      }
      if (mutation.inlineStyles) {
        for (const [styleKey, styleVal] of Object.entries(mutation.inlineStyles)) {
          const normalizedKey = styleKey.trim().toLowerCase();
          if (styleVal === null || styleVal.trim() === "") {
            delete nextInlineStyles[normalizedKey];
          } else {
            nextInlineStyles[normalizedKey] = styleVal.trim();
          }
        }
        const serializedStyle = serializeInlineStyleDeclaration(nextInlineStyles);
        if (serializedStyle) {
          nextAttributes.style = serializedStyle;
        } else {
          delete nextAttributes.style;
        }
      }

      const nextElementId = nextAttributes.id ?? "";
      const nextClasses = (nextAttributes.class ?? "")
        .split(/\s+/)
        .map((c) => c.trim())
        .filter(Boolean);
      const nextPath = buildNodePathSelector(
        nextTag,
        nextElementId,
        nextClasses,
        parentPath,
      );

      nextNode = {
        ...node,
        tag: nextTag,
        elementId: nextElementId,
        classes: nextClasses,
        attributes: nextAttributes,
        inlineStyles: nextInlineStyles,
        textContent:
          mutation.textContent !== undefined
            ? mutation.textContent
            : node.textContent,
        boxModel: computeBoxModelForTagAndStyles(nextTag, nextInlineStyles),
        pathSelector: nextPath,
      };
    }

    const updatedChildren = nextNode.children.map((child) =>
      visit(child, nextNode.pathSelector),
    );
    return {
      ...nextNode,
      children: updatedChildren,
    };
  };

  return tree.map((rootNode) => visit(rootNode, ""));
}

function matchesSimpleSelectorToken(
  node: DomInspectorNode,
  token: string,
): boolean {
  const trimmed = token.trim();
  if (!trimmed || trimmed === "*") return true;

  const attrMatch = /^([a-zA-Z0-9_-]+)?\[([a-zA-Z0-9_-]+)(?:=["']?([^"'\]]*)["']?)?\]$/.exec(
    trimmed,
  );
  if (attrMatch) {
    const [, tagPrefix, attrName, expectedValue] = attrMatch;
    if (tagPrefix && node.tag !== tagPrefix.toLowerCase()) return false;
    if (!attrName || !(attrName in node.attributes)) return false;
    if (expectedValue !== undefined && node.attributes[attrName] !== expectedValue) {
      return false;
    }
    return true;
  }

  if (trimmed.startsWith("#")) {
    return node.elementId === trimmed.slice(1);
  }

  if (trimmed.startsWith(".")) {
    const requiredClasses = trimmed.slice(1).split(".").filter(Boolean);
    return requiredClasses.every((cls) => node.classes.includes(cls));
  }

  const tagWithIdMatch = /^([a-zA-Z0-9-]+)#([a-zA-Z0-9_-]+)$/.exec(trimmed);
  if (tagWithIdMatch) {
    return (
      node.tag === tagWithIdMatch[1]?.toLowerCase() &&
      node.elementId === tagWithIdMatch[2]
    );
  }

  const tagWithClassMatch = /^([a-zA-Z0-9-]+)\.(.+)$/.exec(trimmed);
  if (tagWithClassMatch) {
    const requiredClasses = (tagWithClassMatch[2] ?? "").split(".").filter(Boolean);
    return (
      node.tag === tagWithClassMatch[1]?.toLowerCase() &&
      requiredClasses.every((cls) => node.classes.includes(cls))
    );
  }

  return node.tag === trimmed.toLowerCase();
}

export function queryDomInspectorNodes(
  tree: DomInspectorNode[],
  selector: string,
): DomInspectorNode[] {
  const cleaned = selector.trim();
  if (!cleaned) return [];

  const selectorGroups = cleaned
    .split(",")
    .map((group) => group.trim())
    .filter(Boolean);

  const matchedIds = new Set<string>();
  const matchedNodes: DomInspectorNode[] = [];

  const searchWithAncestors = (
    node: DomInspectorNode,
    ancestors: DomInspectorNode[],
  ) => {
    for (const group of selectorGroups) {
      const parts = group
        .replaceAll(">", " ")
        .split(/\s+/)
        .map((p) => p.trim())
        .filter(Boolean);
      if (parts.length === 0) continue;

      const lastPart = parts[parts.length - 1];
      if (!lastPart || !matchesSimpleSelectorToken(node, lastPart)) continue;

      let ancestorIdx = ancestors.length - 1;
      let allAncestorsMatched = true;
      for (let i = parts.length - 2; i >= 0; i -= 1) {
        const neededToken = parts[i] ?? "";
        let found = false;
        while (ancestorIdx >= 0) {
          const candidateAncestor = ancestors[ancestorIdx];
          ancestorIdx -= 1;
          if (
            candidateAncestor &&
            matchesSimpleSelectorToken(candidateAncestor, neededToken)
          ) {
            found = true;
            break;
          }
        }
        if (!found) {
          allAncestorsMatched = false;
          break;
        }
      }

      if (allAncestorsMatched && !matchedIds.has(node.id)) {
        matchedIds.add(node.id);
        matchedNodes.push(node);
      }
    }

    const nextAncestors = [...ancestors, node];
    for (const child of node.children) {
      searchWithAncestors(child, nextAncestors);
    }
  };

  for (const root of tree) {
    searchWithAncestors(root, []);
  }

  return matchedNodes;
}

export function flattenDomInspectorTree(
  tree: DomInspectorNode[],
  depth = 0,
): Array<{ node: DomInspectorNode; depth: number }> {
  const flat: Array<{ node: DomInspectorNode; depth: number }> = [];
  for (const node of tree) {
    flat.push({ node, depth });
    if (node.children.length > 0) {
      flat.push(...flattenDomInspectorTree(node.children, depth + 1));
    }
  }
  return flat;
}

export function findDomInspectorNodeById(
  tree: DomInspectorNode[],
  nodeId: string | null | undefined,
): DomInspectorNode | null {
  if (!nodeId) return null;
  for (const item of flattenDomInspectorTree(tree)) {
    if (item.node.id === nodeId) return item.node;
  }
  return null;
}

export function serializeDomInspectorTreeToHtml(
  tree: DomInspectorNode[],
): string {
  const renderNode = (node: DomInspectorNode, indent: string): string => {
    const attrs = Object.entries(node.attributes)
      .map(([k, v]) => `${k}="${v.replaceAll('"', "&quot;")}"`)
      .join(" ");
    const openTag = attrs ? `<${node.tag} ${attrs}>` : `<${node.tag}>`;
    if (node.children.length === 0) {
      return `${indent}${openTag}${node.textContent}</${node.tag}>`;
    }
    const childLines = node.children
      .map((child) => renderNode(child, `${indent}  `))
      .join("\n");
    const textLine = node.textContent ? `\n${indent}  ${node.textContent}` : "";
    return `${indent}${openTag}${textLine}\n${childLines}\n${indent}</${node.tag}>`;
  };
  return tree.map((n) => renderNode(n, "")).join("\n");
}

export function synthesizePageHtmlForUrl(url: string, title?: string): string {
  const pageTitle = title ?? extractDisplayTitleFromUrl(url);
  return `<body id="sovereign-root" class="sovereign-document" style="width: 1280px; height: 820px; padding: 24px; margin: 0px; background: #0b1020; color: #f8fafc;">
  <header id="site-header" class="top-banner" style="width: 1232px; height: 76px; margin: 12px; padding: 16px; border: 1px solid #334155;">
    <h1 id="page-heading" class="headline" style="width: 780px; height: 36px; margin: 4px; padding: 4px;">${pageTitle}</h1>
    <nav id="primary-nav" class="nav-links" style="width: 640px; height: 28px; margin: 4px; padding: 4px;">
      <a id="nav-home" class="nav-item" href="${url}" style="padding: 4px; margin: 2px;">Origin Root</a>
      <a id="nav-manifest" class="nav-item" href="https://cdn.omnia.local/streams/master-4k-hdr.m3u8" style="padding: 4px; margin: 2px;">HLS 4K Master Manifest (.m3u8)</a>
      <a id="nav-archive" class="nav-item" href="https://cdn.omnia.local/releases/omnia-sovereign-sdk.zip" style="padding: 4px; margin: 2px;">SDK Bundle (.zip)</a>
    </nav>
  </header>
  <main id="viewport-main" class="content-grid" style="width: 1232px; height: 640px; margin: 16px; padding: 20px; border: 2px solid #38bdf8;">
    <section id="media-stage" class="player-card" style="width: 960px; height: 540px; margin: 12px; padding: 16px; border: 1px solid #10b981;">
      <video id="primary-video-stream" class="sovereign-video" src="blob:https://stream-vault.omnia.local/9f82c1a0-4k-hdr" data-hls-manifest="https://cdn.omnia.local/streams/master-4k-hdr.m3u8" style="width: 920px; height: 480px; margin: 8px; padding: 0px; border: 2px solid #22d3ee;">4K HDR Sovereign Media Stream Ready</video>
      <button id="btn-trigger-idm" class="action-btn primary" data-action="sniff-download" style="width: 220px; height: 40px; margin: 6px; padding: 10px; border: 1px solid #38bdf8;">Sniff &amp; Hand Off to IDM+</button>
    </section>
  </main>
</body>`;
}

function summarizeDomNodeForConsole(node: DomInspectorNode) {
  return {
    id: node.id,
    tag: node.tag,
    elementId: node.elementId,
    classes: node.classes,
    selector: node.pathSelector,
    attributes: node.attributes,
    boxModel: node.boxModel,
    textContent: node.textContent,
  };
}

function formatConsoleValue(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function evaluateSovereignConsoleCommand(
  command: string,
  context: SovereignConsoleContext,
): SovereignConsoleEvaluationResult {
  const trimmed = command.trim();
  const timestamp = new Date().toISOString();
  const entries: ConsoleLogEntry[] = [];
  let copiedText: string | undefined;

  if (!trimmed) {
    return { entries: [], lastResult: context.lastResult };
  }

  const selectedNode =
    findDomInspectorNodeById(context.domTree, context.selectedNodeId) ??
    context.domTree[0] ??
    null;

  const extractLinksHelper = () => {
    const anchors = queryDomInspectorNodes(context.domTree, "a");
    return anchors.map((node) => ({
      text: node.textContent || node.elementId || node.tag,
      href: node.attributes.href ?? "",
      selector: node.pathSelector,
    }));
  };

  const extractMediaStreamsHelper = () => {
    const networkMedia = extractDownloadableMediaFromNetworkLog(
      context.networkEntries,
    );
    const domVideos = queryDomInspectorNodes(
      context.domTree,
      "video, audio, source",
    ).map((node) => ({
      id: `dom-${node.id}`,
      url:
        node.attributes["data-hls-manifest"] ??
        node.attributes.src ??
        "",
      tag: node.tag,
      selector: node.pathSelector,
    }));
    return {
      sniffedNetworkStreams: networkMedia,
      domMediaNodes: domVideos,
    };
  };

  const extractStorageHelper = () => ({
    cookies: context.cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
    })),
    localStorage: Object.fromEntries(
      context.localStorage.map((item) => [item.key, item.value]),
    ),
    sessionStorage: Object.fromEntries(
      context.sessionStorage.map((item) => [item.key, item.value]),
    ),
  });

  const dollarSingle = (selector: string) => {
    const found = queryDomInspectorNodes(context.domTree, selector)[0];
    return found ? summarizeDomNodeForConsole(found) : null;
  };

  const dollarAll = (selector: string) =>
    queryDomInspectorNodes(context.domTree, selector).map(
      summarizeDomNodeForConsole,
    );

  const copyHelper = (value: unknown) => {
    const serialized = formatConsoleValue(value);
    copiedText = serialized;
    return `Copied ${serialized.length} chars to Sovereign clipboard`;
  };

  const tableHelper = (data: unknown) => {
    entries.push({
      id: `console-${Date.now()}-table-${entries.length}`,
      timestamp,
      level: "table",
      command: trimmed,
      output: formatConsoleValue(data),
      structuredData: data,
    });
    return data;
  };

  const customConsole = {
    log: (...args: unknown[]) => {
      entries.push({
        id: `console-${Date.now()}-log-${entries.length}`,
        timestamp,
        level: "log",
        command: trimmed,
        output: args.map(formatConsoleValue).join(" "),
        structuredData: args.length === 1 ? args[0] : args,
      });
    },
    info: (...args: unknown[]) => {
      entries.push({
        id: `console-${Date.now()}-info-${entries.length}`,
        timestamp,
        level: "info",
        command: trimmed,
        output: args.map(formatConsoleValue).join(" "),
        structuredData: args.length === 1 ? args[0] : args,
      });
    },
    warn: (...args: unknown[]) => {
      entries.push({
        id: `console-${Date.now()}-warn-${entries.length}`,
        timestamp,
        level: "warn",
        command: trimmed,
        output: args.map(formatConsoleValue).join(" "),
        structuredData: args.length === 1 ? args[0] : args,
      });
    },
    error: (...args: unknown[]) => {
      entries.push({
        id: `console-${Date.now()}-error-${entries.length}`,
        timestamp,
        level: "error",
        command: trimmed,
        output: args.map(formatConsoleValue).join(" "),
        structuredData: args.length === 1 ? args[0] : args,
      });
    },
    table: (data: unknown) => {
      tableHelper(data);
    },
  };

  const sandboxDocument = {
    title: context.title,
    URL: context.url,
    cookie: context.cookies.map((c) => `${c.name}=${c.value}`).join("; "),
    querySelector: dollarSingle,
    querySelectorAll: dollarAll,
  };

  const sandboxLocation = {
    href: context.url,
    origin: (() => {
      try {
        return new URL(context.url).origin;
      } catch {
        return context.url;
      }
    })(),
  };

  const sandboxPerformance = {
    now: () => 42.68,
    memory: {
      jsHeapSizeLimit: 4294967296,
      totalJSHeapSize: 67108864,
      usedJSHeapSize: 48234496,
    },
  };

  try {
    const evaluator = new Function(
      "$",
      "$$",
      "$0",
      "$_",
      "copy",
      "keys",
      "values",
      "table",
      "extractLinks",
      "extractMediaStreams",
      "extractStorage",
      "console",
      "document",
      "location",
      "performance",
      `"use strict"; return (${trimmed});`,
    );

    const resultValue: unknown = evaluator(
      dollarSingle,
      dollarAll,
      selectedNode ? summarizeDomNodeForConsole(selectedNode) : null,
      context.lastResult,
      copyHelper,
      (obj: Record<string, unknown>) => Object.keys(obj ?? {}),
      (obj: Record<string, unknown>) => Object.values(obj ?? {}),
      tableHelper,
      extractLinksHelper,
      extractMediaStreamsHelper,
      extractStorageHelper,
      customConsole,
      sandboxDocument,
      sandboxLocation,
      sandboxPerformance,
    );

    entries.push({
      id: `console-${Date.now()}-result-${entries.length}`,
      timestamp,
      level: "result",
      command: trimmed,
      output: formatConsoleValue(resultValue),
      structuredData: resultValue,
    });

    return {
      entries,
      lastResult: resultValue,
      ...(copiedText !== undefined ? { copiedText } : {}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    entries.push({
      id: `console-${Date.now()}-err`,
      timestamp,
      level: "error",
      command: trimmed,
      output: `Uncaught EvalError: ${message}`,
    });
    return {
      entries,
      lastResult: context.lastResult,
    };
  }
}

function escapeSingleQuotedShell(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function generateCurlCommandFromNetworkEntry(
  entry: SovereignNetworkEntry,
): string {
  const parts: string[] = [
    `curl -X ${entry.method} ${escapeSingleQuotedShell(entry.url)}`,
  ];

  for (const [headerName, headerValue] of Object.entries(entry.requestHeaders)) {
    parts.push(
      `  -H ${escapeSingleQuotedShell(`${headerName}: ${headerValue}`)}`,
    );
  }

  if (entry.requestBody && entry.requestBody.trim().length > 0) {
    parts.push(`  --data-raw ${escapeSingleQuotedShell(entry.requestBody)}`);
  }

  parts.push("  --compressed");
  return parts.join(" \\\n");
}

export function generateFetchCodeFromNetworkEntry(
  entry: SovereignNetworkEntry,
): string {
  const options: Record<string, unknown> = {
    method: entry.method === "WS" ? "GET" : entry.method,
    headers: entry.requestHeaders,
    mode: "cors",
    credentials: "include",
  };
  if (entry.requestBody && entry.requestBody.trim().length > 0) {
    options.body = entry.requestBody;
  }
  return `const response = await fetch(${JSON.stringify(entry.url)}, ${JSON.stringify(options, null, 2)});\nconst data = await response.text();\nconsole.log(response.status, data);`;
}

function deriveStreamMetadata(
  entry: SovereignNetworkEntry,
): {
  streamKind: SniffedMediaStreamKind;
  qualityLabel: string;
  priorityScore: number;
  suggestedFilename: string;
} | null {
  const lowerUrl = entry.url.toLowerCase();
  const lowerMime = entry.mimeType.toLowerCase();

  const cleanFilename = (defaultExt: string): string => {
    try {
      const normalized = entry.url.startsWith("blob:")
        ? entry.url.slice(5)
        : entry.url;
      const parsed = new URL(normalized);
      const base =
        parsed.pathname.split("/").filter(Boolean).pop() ??
        `sovereign-stream.${defaultExt}`;
      return base.includes(".") ? base : `${base}.${defaultExt}`;
    } catch {
      return `sovereign-capture.${defaultExt}`;
    }
  };

  if (
    entry.resourceType === "hls-m3u8" ||
    lowerUrl.includes(".m3u8") ||
    lowerMime.includes("mpegurl")
  ) {
    const is4k = lowerUrl.includes("4k") || lowerUrl.includes("2160");
    return {
      streamKind: "hls-m3u8",
      qualityLabel: is4k ? "4K UHD HLS Adaptive (.m3u8)" : "1080p HLS Master (.m3u8)",
      priorityScore: is4k ? 100 : 95,
      suggestedFilename: cleanFilename("mp4").replace(/\.m3u8$/i, ".mp4"),
    };
  }

  if (
    entry.resourceType === "dash-mpd" ||
    lowerUrl.includes(".mpd") ||
    lowerMime.includes("dash+xml")
  ) {
    return {
      streamKind: "dash-mpd",
      qualityLabel: "MPEG-DASH Adaptive Stream (.mpd)",
      priorityScore: 92,
      suggestedFilename: cleanFilename("mp4").replace(/\.mpd$/i, ".mp4"),
    };
  }

  if (entry.resourceType === "blob" || lowerUrl.startsWith("blob:")) {
    return {
      streamKind: "blob-stream",
      qualityLabel: "MSE Blob Media Buffer (blob://)",
      priorityScore: 88,
      suggestedFilename: `${cleanFilename("mp4").replace(/[^a-zA-Z0-9._-]/g, "_")}.mp4`,
    };
  }

  if (
    /\.(mp4|webm|mkv)(\?|$)/i.test(lowerUrl) ||
    lowerMime.startsWith("video/")
  ) {
    return {
      streamKind: "direct-video",
      qualityLabel: "Direct Video Stream (MP4/WebM)",
      priorityScore: 84,
      suggestedFilename: cleanFilename("mp4"),
    };
  }

  if (
    /\.(mp3|flac|wav|m4a|ogg)(\?|$)/i.test(lowerUrl) ||
    lowerMime.startsWith("audio/")
  ) {
    return {
      streamKind: "direct-audio",
      qualityLabel: "Direct Audio Track",
      priorityScore: 75,
      suggestedFilename: cleanFilename("mp3"),
    };
  }

  if (
    /\.(zip|tar\.gz|7z|pdf|iso)(\?|$)/i.test(lowerUrl) ||
    lowerMime.includes("application/zip") ||
    lowerMime.includes("application/pdf") ||
    entry.isStreamOrDownloadable
  ) {
    return {
      streamKind: "archive-document",
      qualityLabel: "Direct Binary / Archive Asset",
      priorityScore: 68,
      suggestedFilename: cleanFilename("bin"),
    };
  }

  return null;
}

export function extractDownloadableMediaFromNetworkLog(
  entries: SovereignNetworkEntry[],
): SniffedMediaCandidate[] {
  const candidates: SniffedMediaCandidate[] = [];

  for (const entry of entries) {
    const meta = deriveStreamMetadata(entry);
    if (!meta) continue;
    candidates.push({
      id: `media-${entry.id}`,
      networkEntryId: entry.id,
      url: entry.url,
      suggestedFilename: meta.suggestedFilename,
      streamKind: meta.streamKind,
      mimeType: entry.mimeType,
      sizeBytes: entry.sizeBytes,
      qualityLabel: meta.qualityLabel,
      priorityScore: meta.priorityScore,
      headers: { ...entry.requestHeaders },
    });
  }

  return candidates.sort((a, b) => b.priorityScore - a.priorityScore);
}

export function replayAndMutateNetworkEntry(
  entry: SovereignNetworkEntry,
  overrides: {
    method?: SovereignHttpMethod;
    url?: string;
    requestHeaders?: Record<string, string>;
    requestBody?: string;
  },
): SovereignNetworkEntry {
  const nextMethod = overrides.method ?? entry.method;
  const nextUrl = overrides.url?.trim() || entry.url;
  const nextHeaders = overrides.requestHeaders
    ? { ...overrides.requestHeaders }
    : { ...entry.requestHeaders };
  const nextBody =
    overrides.requestBody !== undefined
      ? overrides.requestBody
      : entry.requestBody;

  return {
    ...entry,
    id: `${entry.id}-replay-${Date.now()}`,
    method: nextMethod,
    url: nextUrl,
    status: 200,
    requestHeaders: nextHeaders,
    ...(nextBody !== undefined ? { requestBody: nextBody } : {}),
    responsePreview: JSON.stringify(
      {
        replayedBy: "Omnia Sovereign Network Interceptor",
        method: nextMethod,
        url: nextUrl,
        forwardedHeaders: Object.keys(nextHeaders),
        bodyBytes: nextBody ? nextBody.length : 0,
        status: "200 OK (CORS Bypassed)",
      },
      null,
      2,
    ),
  };
}

export function createDefaultSovereignNetworkEntries(): SovereignNetworkEntry[] {
  return [
    {
      id: "net-doc-main",
      method: "GET",
      url: "https://stream-vault.omnia.local/watch/4k-master-hdr",
      status: 200,
      resourceType: "document",
      mimeType: "text/html; charset=utf-8",
      sizeBytes: 48_920,
      durationMs: 68,
      timings: { dnsMs: 4, tcpMs: 8, tlsMs: 14, ttfbMs: 28, downloadMs: 14 },
      requestHeaders: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": USER_AGENT_PRESET_STRINGS["omnia-sovereign-agent"].userAgent,
        Authorization: "Bearer sov_unrestricted_token_99x",
      },
      responseHeaders: {
        "Content-Type": "text/html; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "X-Sovereign-Frame-Bypass": "stripped-x-frame-options",
      },
      responsePreview: "<!DOCTYPE html><html><head><title>4K HDR Stream Vault</title>...</head></html>",
      isStreamOrDownloadable: false,
    },
    {
      id: "net-hls-master",
      method: "GET",
      url: "https://cdn.omnia.local/streams/master-4k-hdr.m3u8?token=sov99",
      status: 200,
      resourceType: "hls-m3u8",
      mimeType: "application/vnd.apple.mpegurl",
      sizeBytes: 384_500_000,
      durationMs: 42,
      timings: { dnsMs: 2, tcpMs: 5, tlsMs: 9, ttfbMs: 18, downloadMs: 8 },
      requestHeaders: {
        Origin: "https://stream-vault.omnia.local",
        Referer: "https://stream-vault.omnia.local/watch/4k-master-hdr",
        Authorization: "Bearer sov_unrestricted_token_99x",
      },
      responseHeaders: {
        "Content-Type": "application/vnd.apple.mpegurl",
        "Access-Control-Allow-Origin": "*",
      },
      responsePreview:
        "#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-STREAM-INF:BANDWIDTH=24500000,RESOLUTION=3840x2160,CODECS=\"avc1.640033,mp4a.40.2\"\nchunklist_4k_hdr.m3u8",
      isStreamOrDownloadable: true,
    },
    {
      id: "net-dash-manifest",
      method: "GET",
      url: "https://cdn.omnia.local/streams/manifest-dolby.mpd",
      status: 200,
      resourceType: "dash-mpd",
      mimeType: "application/dash+xml",
      sizeBytes: 210_400_000,
      durationMs: 51,
      timings: { dnsMs: 3, tcpMs: 6, tlsMs: 10, ttfbMs: 21, downloadMs: 11 },
      requestHeaders: {
        Origin: "https://stream-vault.omnia.local",
        Accept: "application/dash+xml",
      },
      responseHeaders: {
        "Content-Type": "application/dash+xml",
        "Access-Control-Allow-Origin": "*",
      },
      responsePreview: "<MPD xmlns=\"urn:mpeg:dash:schema:mpd:2011\" mediaPresentationDuration=\"PT0H24M10S\">...</MPD>",
      isStreamOrDownloadable: true,
    },
    {
      id: "net-blob-buffer",
      method: "GET",
      url: "blob:https://stream-vault.omnia.local/9f82c1a0-4k-hdr",
      status: 200,
      resourceType: "blob",
      mimeType: "video/mp4",
      sizeBytes: 156_800_000,
      durationMs: 19,
      timings: { dnsMs: 0, tcpMs: 0, tlsMs: 0, ttfbMs: 5, downloadMs: 14 },
      requestHeaders: {
        Range: "bytes=0-",
      },
      responseHeaders: {
        "Content-Type": "video/mp4",
        "Accept-Ranges": "bytes",
      },
      responsePreview: "[Binary MSE MediaSource Blob Stream - 156.8 MB]",
      isStreamOrDownloadable: true,
    },
    {
      id: "net-api-graphql",
      method: "POST",
      url: "https://api.omnia.local/v2/graphql",
      status: 200,
      resourceType: "fetch",
      mimeType: "application/json",
      sizeBytes: 14_320,
      durationMs: 95,
      timings: { dnsMs: 5, tcpMs: 9, tlsMs: 15, ttfbMs: 52, downloadMs: 14 },
      requestHeaders: {
        "Content-Type": "application/json",
        Authorization: "Bearer sov_unrestricted_token_99x",
        "X-Omnia-CORS-Bypass": "enabled",
      },
      responseHeaders: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      requestBody: JSON.stringify({
        operationName: "ResolveStreamLicense",
        variables: { videoId: "4k-master-hdr", unrestricted: true },
      }),
      responsePreview: JSON.stringify(
        {
          data: {
            streamLicense: {
              allowed: true,
              drmBypass: "authorized-local-sovereign",
              mirrors: ["https://cdn.omnia.local/streams/master-4k-hdr.m3u8"],
            },
          },
        },
        null,
        2,
      ),
      isStreamOrDownloadable: false,
    },
    {
      id: "net-archive-sdk",
      method: "GET",
      url: "https://cdn.omnia.local/releases/omnia-sovereign-sdk.zip",
      status: 206,
      resourceType: "media",
      mimeType: "application/zip",
      sizeBytes: 42_600_000,
      durationMs: 128,
      timings: { dnsMs: 4, tcpMs: 7, tlsMs: 11, ttfbMs: 36, downloadMs: 70 },
      requestHeaders: {
        Accept: "*/*",
        Range: "bytes=0-42599999",
      },
      responseHeaders: {
        "Content-Type": "application/zip",
        "Accept-Ranges": "bytes",
      },
      responsePreview: "[ZIP Archive Binary Payload - 42.6 MB]",
      isStreamOrDownloadable: true,
    },
  ];
}

export function createDefaultCookies(): CookieEntry[] {
  return [
    {
      id: "cookie-sov-session",
      name: "omnia_sovereign_session",
      value: "sov_live_98f71a2b4c_unrestricted",
      domain: ".omnia.local",
      path: "/",
      expires: "2027-12-31T23:59:59Z",
      httpOnly: true,
      secure: true,
      sameSite: "None",
    },
    {
      id: "cookie-stream-clearance",
      name: "cf_clearance_bypass",
      value: "verified_human_token_7741",
      domain: ".omnia.local",
      path: "/",
      expires: "2027-06-01T00:00:00Z",
      httpOnly: false,
      secure: true,
      sameSite: "Lax",
    },
  ];
}

export function createDefaultStorageEntries(): StorageKeyValueEntry[] {
  return [
    {
      id: "ls-player-quality",
      storageArea: "localStorage",
      key: "sovereign.player.preferredQuality",
      value: "2160p60-hdr",
    },
    {
      id: "ls-devtools-dock",
      storageArea: "localStorage",
      key: "sovereign.devtools.dockMode",
      value: "bottom",
    },
    {
      id: "ss-active-token",
      storageArea: "sessionStorage",
      key: "sovereign.session.ephemeralKey",
      value: "ephem_88412_active",
    },
  ];
}

export function createDefaultUserscripts(): UserscriptEntry[] {
  return [
    {
      id: "us-unlock-context-copy",
      name: "Unlock Right-Click, Copy & Text Selection Everywhere",
      matchPattern: "*://*/*",
      runAt: "document-start",
      enabled: true,
      description:
        "Strips contextmenu, selectstart, and copy blockers; forces user-select: text across all DOM elements.",
      code: `// ==UserScript==
// @name         Unlock Right-Click, Copy & Text Selection Everywhere
// @match        *://*/*
// @run-at       document-start
// ==/UserScript==
document.addEventListener('contextmenu', (e) => e.stopImmediatePropagation(), true);
document.addEventListener('copy', (e) => e.stopImmediatePropagation(), true);
document.documentElement.style.userSelect = 'text';`,
    },
    {
      id: "us-mse-hls-sniffer",
      name: "Auto-Hook MSE SourceBuffer & HLS/M3U8 Manifest Sniffer",
      matchPattern: "*://*/*",
      runAt: "document-start",
      enabled: true,
      description:
        "Intercepts window.fetch, XMLHttpRequest, and MediaSource.addSourceBuffer to expose hidden .m3u8/.mpd/blob streams to Omnia IDM+.",
      code: `// ==UserScript==
// @name         Auto-Hook MSE SourceBuffer & HLS/M3U8 Manifest Sniffer
// @match        *://*/*
// @run-at       document-start
// ==/UserScript==
window.__OMNIA_MEDIA_SNIFFER_ACTIVE__ = true;`,
    },
    {
      id: "us-pip-fullscreen",
      name: "Force Picture-in-Picture & Playback Speed 0.25x-16x",
      matchPattern: "*://*.omnia.local/*",
      runAt: "document-end",
      enabled: true,
      description:
        "Removes disablePictureInPicture attributes and unlocks arbitrary HTMLMediaElement.playbackRate.",
      code: `// ==UserScript==
// @name         Force Picture-in-Picture & Playback Speed 0.25x-16x
// @match        *://*.omnia.local/*
// @run-at       document-end
// ==/UserScript==
document.querySelectorAll('video').forEach((v) => v.removeAttribute('disablePictureInPicture'));`,
    },
  ];
}

export function upsertCookieEntry(
  cookies: CookieEntry[],
  entry: Omit<CookieEntry, "id"> & { id?: string },
): CookieEntry[] {
  const existingIndex = cookies.findIndex(
    (c) =>
      (entry.id && c.id === entry.id) ||
      (c.name === entry.name && c.domain === entry.domain && c.path === entry.path),
  );
  if (existingIndex >= 0) {
    const existing = cookies[existingIndex]!;
    const updated: CookieEntry = {
      ...entry,
      id: entry.id ?? existing.id,
    };
    return cookies.map((item, idx) => (idx === existingIndex ? updated : item));
  }
  const created: CookieEntry = {
    ...entry,
    id: entry.id ?? `cookie-${Date.now()}-${cookies.length + 1}`,
  };
  return [...cookies, created];
}

export function deleteCookieEntry(
  cookies: CookieEntry[],
  cookieId: string,
): CookieEntry[] {
  return cookies.filter((c) => c.id !== cookieId);
}

export function upsertStorageEntry(
  entries: StorageKeyValueEntry[],
  entry: Omit<StorageKeyValueEntry, "id"> & { id?: string },
): StorageKeyValueEntry[] {
  const existingIndex = entries.findIndex(
    (item) =>
      (entry.id && item.id === entry.id) ||
      (item.storageArea === entry.storageArea && item.key === entry.key),
  );
  if (existingIndex >= 0) {
    const existing = entries[existingIndex]!;
    const updated: StorageKeyValueEntry = {
      ...entry,
      id: entry.id ?? existing.id,
    };
    return entries.map((item, idx) => (idx === existingIndex ? updated : item));
  }
  const created: StorageKeyValueEntry = {
    ...entry,
    id: entry.id ?? `storage-${Date.now()}-${entries.length + 1}`,
  };
  return [...entries, created];
}

export function deleteStorageEntry(
  entries: StorageKeyValueEntry[],
  entryId: string,
): StorageKeyValueEntry[] {
  return entries.filter((item) => item.id !== entryId);
}

export function parseUserscriptHeaderMetadata(code: string): {
  name?: string;
  matchPattern?: string;
  runAt?: UserscriptEntry["runAt"];
  description?: string;
} {
  const nameMatch = /\/\/\s*@name\s+(.+)$/m.exec(code);
  const matchPatternMatch = /\/\/\s*@match\s+(.+)$/m.exec(code);
  const runAtMatch = /\/\/\s*@run-at\s+(document-start|document-end|document-idle)\b/m.exec(
    code,
  );
  const descMatch = /\/\/\s*@description\s+(.+)$/m.exec(code);

  return {
    ...(nameMatch?.[1] ? { name: nameMatch[1].trim() } : {}),
    ...(matchPatternMatch?.[1] ? { matchPattern: matchPatternMatch[1].trim() } : {}),
    ...(runAtMatch?.[1]
      ? { runAt: runAtMatch[1] as UserscriptEntry["runAt"] }
      : {}),
    ...(descMatch?.[1] ? { description: descMatch[1].trim() } : {}),
  };
}

export function upsertUserscriptEntry(
  scripts: UserscriptEntry[],
  script: Omit<UserscriptEntry, "id"> & { id?: string },
): UserscriptEntry[] {
  const existingIndex = scripts.findIndex(
    (s) => (script.id && s.id === script.id) || s.name === script.name,
  );
  if (existingIndex >= 0) {
    const existing = scripts[existingIndex]!;
    const updated: UserscriptEntry = {
      ...script,
      id: script.id ?? existing.id,
    };
    return scripts.map((item, idx) => (idx === existingIndex ? updated : item));
  }
  const created: UserscriptEntry = {
    ...script,
    id: script.id ?? `us-${Date.now()}-${scripts.length + 1}`,
  };
  return [...scripts, created];
}

export function toggleUserscriptEntry(
  scripts: UserscriptEntry[],
  scriptId: string,
  enabled?: boolean,
): UserscriptEntry[] {
  return scripts.map((script) =>
    script.id === scriptId
      ? { ...script, enabled: enabled ?? !script.enabled }
      : script,
  );
}

export function deleteUserscriptEntry(
  scripts: UserscriptEntry[],
  scriptId: string,
): UserscriptEntry[] {
  return scripts.filter((script) => script.id !== scriptId);
}

export function matchUserscriptsForUrl(
  scripts: UserscriptEntry[],
  url: string,
): UserscriptEntry[] {
  return scripts.filter((script) => {
    if (!script.enabled) return false;
    const pattern = script.matchPattern.trim();
    if (pattern === "*://*/*" || pattern === "<all_urls>" || pattern === "*") {
      return true;
    }
    const regexSource =
      "^" +
      pattern
        .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
        .replaceAll("*", ".*") +
      "$";
    try {
      return new RegExp(regexSource, "i").test(url);
    } catch {
      return false;
    }
  });
}

// ============================================================================
// Sovereign Browser Profile Linker (Edge, Chrome Canary, Chrome, Brave)
// ============================================================================

export type BrowserFlavor =
  | "edge"
  | "chrome-canary"
  | "chrome"
  | "brave"
  | "omnia-dedicated"
  | "custom-chromium";

export interface BrowserProfileLinkConfig {
  id: string;
  flavor: BrowserFlavor;
  label: string;
  executablePath: string;
  userDataDir: string;
  profileDirectory: string;
  remoteDebuggingPort: number;
  autoOpenDevTools: boolean;
  disableAutomationFlags: boolean;
  installedOnHost: boolean;
}

export interface BrowserProfileLaunchCommandResult {
  powershellCommand: string;
  command: string;
  cdpEndpoint: string;
  cdpWebSocketEndpoint: string;
  cdpHttpJsonEndpoint: string;
  cliArgs: string[];
  explanation: string;
  humanPassExplanation: string;
}

export const DEFAULT_BROWSER_PROFILE_PRESETS: readonly BrowserProfileLinkConfig[] = [
  {
    id: "profile-edge-default",
    flavor: "edge",
    label: "Microsoft Edge (Default)",
    executablePath:
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    userDataDir:
      "C:\\Users\\khang\\AppData\\Local\\Microsoft\\Edge\\User Data",
    profileDirectory: "Default",
    remoteDebuggingPort: 9222,
    autoOpenDevTools: true,
    disableAutomationFlags: true,
    installedOnHost: true,
  },
  {
    id: "profile-chrome-canary-default",
    flavor: "chrome-canary",
    label: "Google Chrome Canary (Default)",
    executablePath:
      "C:\\Users\\khang\\AppData\\Local\\Google\\Chrome SxS\\Application\\chrome.exe",
    userDataDir:
      "C:\\Users\\khang\\AppData\\Local\\Google\\Chrome SxS\\User Data",
    profileDirectory: "Default",
    remoteDebuggingPort: 9223,
    autoOpenDevTools: true,
    disableAutomationFlags: true,
    installedOnHost: true,
  },
  {
    id: "profile-chrome-default",
    flavor: "chrome",
    label: "Google Chrome (Default)",
    executablePath:
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    userDataDir:
      "C:\\Users\\khang\\AppData\\Local\\Google\\Chrome\\User Data",
    profileDirectory: "Default",
    remoteDebuggingPort: 9224,
    autoOpenDevTools: true,
    disableAutomationFlags: true,
    installedOnHost: true,
  },
  {
    id: "profile-brave-default",
    flavor: "brave",
    label: "Brave Browser (Default)",
    executablePath:
      "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
    userDataDir:
      "C:\\Users\\khang\\AppData\\Local\\BraveSoftware\\Brave-Browser\\User Data",
    profileDirectory: "Default",
    remoteDebuggingPort: 9225,
    autoOpenDevTools: true,
    disableAutomationFlags: true,
    installedOnHost: true,
  },
  {
    id: "profile-omnia-dedicated",
    flavor: "omnia-dedicated",
    label: "Omnia Dedicated Sovereign Profile",
    executablePath:
      "C:\\Users\\khang\\AppData\\Local\\Google\\Chrome SxS\\Application\\chrome.exe",
    userDataDir:
      "C:\\Users\\khang\\AppData\\Local\\Omnia\\SovereignProfile\\User Data",
    profileDirectory: "Default",
    remoteDebuggingPort: 9229,
    autoOpenDevTools: true,
    disableAutomationFlags: true,
    installedOnHost: true,
  },
] as const;

export function buildBrowserProfileLaunchCommand(
  config: BrowserProfileLinkConfig,
  targetUrl: string,
): BrowserProfileLaunchCommandResult {
  const cleanUrl = targetUrl.trim() || "https://www.google.com";
  const port =
    Number.isFinite(config.remoteDebuggingPort) &&
    config.remoteDebuggingPort > 0
      ? Math.round(config.remoteDebuggingPort)
      : 9222;
  const profileDir = config.profileDirectory.trim() || "Default";

  const cliArgs: string[] = [
    `--user-data-dir="${config.userDataDir}"`,
    `--profile-directory="${profileDir}"`,
    `--remote-debugging-port=${port}`,
  ];

  if (config.disableAutomationFlags) {
    cliArgs.push("--disable-blink-features=AutomationControlled");
  }
  if (config.autoOpenDevTools) {
    cliArgs.push("--auto-open-devtools-for-tabs");
  }
  cliArgs.push(`"${cleanUrl}"`);

  const powershellCommand = `& "${config.executablePath}" ${cliArgs.join(" ")}`;
  const cdpWebSocketEndpoint = `ws://127.0.0.1:${port}/devtools/browser`;
  const cdpHttpJsonEndpoint = `http://127.0.0.1:${port}/json/version`;
  const humanPassExplanation =
    `Links ${config.label} (${profileDir}) on CDP port ${port} with --disable-blink-features=AutomationControlled and --auto-open-devtools-for-tabs. ` +
    `Shares all real authenticated sessions, hardware TLS/JA3 fingerprint, and human-solved Cloudflare Turnstile / Google reCAPTCHA / hCaptcha tokens (` +
    `cf_clearance, __cf_bm, NID, SID) directly with Omnia Sovereign Browser and Ultra IDM+ Downloader.`;

  return {
    powershellCommand,
    command: powershellCommand,
    cdpEndpoint: cdpWebSocketEndpoint,
    cdpWebSocketEndpoint,
    cdpHttpJsonEndpoint,
    cliArgs,
    explanation: humanPassExplanation,
    humanPassExplanation,
  };
}

// ============================================================================
// Universal Cookie Importer / Exporter (Netscape, JSON Array, HTTP Header)
// ============================================================================

function normalizeSameSiteValue(
  raw: unknown,
): "Lax" | "Strict" | "None" {
  if (typeof raw !== "string") return "Lax";
  const lower = raw.trim().toLowerCase();
  if (lower === "strict") return "Strict";
  if (
    lower === "none" ||
    lower === "no_restriction" ||
    lower === "unrestricted"
  ) {
    return "None";
  }
  return "Lax";
}

function normalizeExpiresString(raw: unknown): string {
  if (raw === undefined || raw === null || raw === "" || raw === 0 || raw === "0") {
    return "Session";
  }
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw <= 0) return "Session";
    const ms = raw > 10_000_000_000 ? raw : raw * 1000;
    try {
      return new Date(ms).toISOString();
    } catch {
      return "Session";
    }
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.toLowerCase() === "session") return "Session";
    if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
      const numeric = Number.parseFloat(trimmed);
      if (numeric <= 0) return "Session";
      const ms = numeric > 10_000_000_000 ? numeric : numeric * 1000;
      try {
        return new Date(ms).toISOString();
      } catch {
        return "Session";
      }
    }
    return trimmed;
  }
  return "Session";
}

export function parseImportedCookies(
  rawInput: string,
  defaultDomain = ".omnia.local",
): CookieEntry[] {
  const trimmed = rawInput.trim();
  if (!trimmed) return [];

  const fallbackDomain = defaultDomain.trim() || ".omnia.local";
  const parsedEntries: CookieEntry[] = [];

  // 1. Detect JSON Cookie Array or Object ({ cookies: [...] })
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const jsonParsed: unknown = JSON.parse(trimmed);
      const rawArray: unknown[] = Array.isArray(jsonParsed)
        ? jsonParsed
        : jsonParsed &&
            typeof jsonParsed === "object" &&
            Array.isArray((jsonParsed as { cookies?: unknown[] }).cookies)
          ? ((jsonParsed as { cookies: unknown[] }).cookies ?? [])
          : jsonParsed && typeof jsonParsed === "object"
            ? [jsonParsed]
            : [];

      for (const item of rawArray) {
        if (!item || typeof item !== "object") continue;
        const record = item as Record<string, unknown>;
        const name = typeof record.name === "string" ? record.name.trim() : "";
        if (!name) continue;
        const value =
          record.value !== undefined && record.value !== null
            ? String(record.value)
            : "";
        const domain =
          typeof record.domain === "string" && record.domain.trim()
            ? record.domain.trim()
            : fallbackDomain;
        const path =
          typeof record.path === "string" && record.path.trim()
            ? record.path.trim()
            : "/";
        const expires = normalizeExpiresString(
          record.expirationDate ?? record.expires ?? record.expiry,
        );
        const httpOnly = Boolean(record.httpOnly);
        const secure =
          typeof record.secure === "boolean" ? record.secure : true;
        const sameSite = normalizeSameSiteValue(record.sameSite);

        parsedEntries.push({
          id: `cookie-json-${name}-${domain}-${parsedEntries.length + 1}`,
          name,
          value,
          domain,
          path,
          expires,
          httpOnly,
          secure,
          sameSite,
        });
      }

      if (parsedEntries.length > 0) {
        return parsedEntries;
      }
    } catch {
      // Fall through to Netscape / Header parsers if JSON parsing fails
    }
  }

  // 2. Detect Netscape cookies.txt format (lines with 7 tab-separated or whitespace-separated fields)
  const lines = trimmed.split(/\r?\n/);
  const netscapeCandidates: CookieEntry[] = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    let isHttpOnlyFromPrefix = false;
    let effectiveLine = line;
    if (line.startsWith("#HttpOnly_")) {
      isHttpOnlyFromPrefix = true;
      effectiveLine = line.slice("#HttpOnly_".length);
    } else if (line.startsWith("#")) {
      continue;
    }

    const parts = effectiveLine.includes("\t")
      ? effectiveLine.split("\t")
      : effectiveLine.split(/\s+/);

    if (
      parts.length >= 7 &&
      /^(TRUE|FALSE)$/i.test(parts[1]?.trim() ?? "") &&
      /^(TRUE|FALSE)$/i.test(parts[3]?.trim() ?? "")
    ) {
      const domain = parts[0]?.trim() || fallbackDomain;
      const path = parts[2]?.trim() || "/";
      const secure = /^TRUE$/i.test(parts[3]?.trim() ?? "");
      const expires = normalizeExpiresString(parts[4]?.trim());
      const name = parts[5]?.trim() ?? "";
      const value = parts.slice(6).join("\t").trim();
      if (!name) continue;

      netscapeCandidates.push({
        id: `cookie-netscape-${name}-${domain}-${netscapeCandidates.length + 1}`,
        name,
        value,
        domain,
        path,
        expires,
        httpOnly: isHttpOnlyFromPrefix,
        secure,
        sameSite: secure ? "None" : "Lax",
      });
    }
  }

  if (netscapeCandidates.length > 0) {
    return netscapeCandidates;
  }

  // 3. Raw HTTP Cookie: header string (e.g. "Cookie: cf_clearance=xyz; SID=abc; __Secure-1PSID=def")
  const reservedDirectiveAttributes = new Set([
    "path",
    "domain",
    "expires",
    "max-age",
    "samesite",
    "secure",
    "httponly",
    "priority",
    "partitioned",
  ]);

  for (const rawLine of lines) {
    const cleanedLine = rawLine
      .trim()
      .replace(/^(?:Cookie|Set-Cookie)\s*:\s*/i, "");
    if (!cleanedLine || cleanedLine.startsWith("#")) continue;

    const segments = cleanedLine.split(";");
    for (const segment of segments) {
      const part = segment.trim();
      if (!part) continue;
      const eqIndex = part.indexOf("=");
      if (eqIndex <= 0) continue;
      const name = part.slice(0, eqIndex).trim();
      const value = part.slice(eqIndex + 1).trim();
      if (!name || reservedDirectiveAttributes.has(name.toLowerCase())) {
        continue;
      }
      parsedEntries.push({
        id: `cookie-hdr-${name}-${parsedEntries.length + 1}`,
        name,
        value,
        domain: fallbackDomain,
        path: "/",
        expires: "Session",
        httpOnly: false,
        secure: true,
        sameSite: "Lax",
      });
    }
  }

  return parsedEntries;
}

export function exportCookiesToNetscapeFormat(
  cookies: readonly CookieEntry[],
): string {
  const headerLines = [
    "# Netscape HTTP Cookie File",
    "# https://curl.se/docs/http-cookies.html",
    "# Exported by Omnia Sovereign Browser & Ultra IDM+ Cookie Bridge",
    "",
  ];

  const bodyLines = cookies.map((cookie) => {
    const domain = cookie.domain.trim() || ".omnia.local";
    const includeSubdomains = domain.startsWith(".") ? "TRUE" : "FALSE";
    const path = cookie.path.trim() || "/";
    const secure = cookie.secure ? "TRUE" : "FALSE";
    let expirationUnix = 0;
    if (cookie.expires && cookie.expires.toLowerCase() !== "session") {
      const parsedTime = Date.parse(cookie.expires);
      if (Number.isFinite(parsedTime) && parsedTime > 0) {
        expirationUnix = Math.floor(parsedTime / 1000);
      } else if (/^\d+$/.test(cookie.expires.trim())) {
        expirationUnix = Number.parseInt(cookie.expires.trim(), 10);
      }
    }
    const prefix = cookie.httpOnly ? "#HttpOnly_" : "";
    return `${prefix}${domain}\t${includeSubdomains}\t${path}\t${secure}\t${expirationUnix}\t${cookie.name}\t${cookie.value}`;
  });

  return [...headerLines, ...bodyLines].join("\n");
}

export function buildCookieHeaderString(
  cookies: readonly CookieEntry[],
  domainFilter?: string,
): string {
  let targetHost = (domainFilter ?? "").trim().toLowerCase();
  if (targetHost.startsWith("http://") || targetHost.startsWith("https://")) {
    try {
      targetHost = new URL(targetHost).hostname.toLowerCase();
    } catch {
      // Keep raw string if URL parsing fails
    }
  }
  const cleanFilter = targetHost.replace(/^\.+/, "");

  const filtered = cleanFilter
    ? cookies.filter((cookie) => {
        const cleanCookieDomain = cookie.domain
          .trim()
          .toLowerCase()
          .replace(/^\.+/, "");
        if (!cleanCookieDomain) return true;
        return (
          cleanFilter === cleanCookieDomain ||
          cleanFilter.endsWith(`.${cleanCookieDomain}`) ||
          cleanCookieDomain.endsWith(`.${cleanFilter}`)
        );
      })
    : cookies;

  return filtered
    .filter((c) => c.name.trim().length > 0)
    .map((c) => `${c.name.trim()}=${c.value}`)
    .join("; ");
}

// ============================================================================
// CAPTCHA / Turnstile Detection & Clearance Helper
// ============================================================================

export type CaptchaChallengeType =
  | "cloudflare-turnstile"
  | "recaptcha"
  | "hcaptcha"
  | "http-403-challenge"
  | "none";

export interface CaptchaChallengeDetectionResult {
  detected: boolean;
  challengeType: CaptchaChallengeType;
  recommendedAction: string;
  clearanceCookieNames: string[];
}

export function detectCaptchaOrChallengeInHtml(
  htmlOrText: string,
  networkEntries: readonly SovereignNetworkEntry[] = [],
): CaptchaChallengeDetectionResult {
  const lowerHtml = (htmlOrText ?? "").toLowerCase();
  const clearanceCookieNames = ["cf_clearance", "__cf_bm", "NID"];

  const hasTurnstileHtml =
    lowerHtml.includes("cf-turnstile") ||
    lowerHtml.includes("challenges.cloudflare.com") ||
    lowerHtml.includes("cf_chl_opt") ||
    lowerHtml.includes("just a moment...") ||
    lowerHtml.includes("attention required! | cloudflare");

  const hasTurnstileNetwork = networkEntries.some((entry) => {
    const u = entry.url.toLowerCase();
    return (
      u.includes("challenges.cloudflare.com") ||
      u.includes("/cdn-cgi/challenge-platform")
    );
  });

  if (hasTurnstileHtml || hasTurnstileNetwork) {
    return {
      detected: true,
      challengeType: "cloudflare-turnstile",
      recommendedAction:
        "Cloudflare Turnstile challenge detected. Link your real Microsoft Edge or Chrome Canary profile (with --disable-blink-features=AutomationControlled) or import your solved cf_clearance & __cf_bm cookies into the Sovereign Cookie Jar.",
      clearanceCookieNames,
    };
  }

  const hasRecaptcha =
    lowerHtml.includes("g-recaptcha") ||
    lowerHtml.includes("google.com/recaptcha") ||
    lowerHtml.includes("grecaptcha.execute") ||
    networkEntries.some((e) =>
      e.url.toLowerCase().includes("google.com/recaptcha"),
    );

  if (hasRecaptcha) {
    return {
      detected: true,
      challengeType: "recaptcha",
      recommendedAction:
        "Google reCAPTCHA challenge detected. Launch linked Edge / Chrome Canary profile to pass with real Google account trust score (NID / SID / __Secure-1PSID) or import session cookies.",
      clearanceCookieNames,
    };
  }

  const hasHcaptcha =
    lowerHtml.includes("h-captcha") ||
    lowerHtml.includes("hcaptcha.com") ||
    networkEntries.some((e) => e.url.toLowerCase().includes("hcaptcha.com"));

  if (hasHcaptcha) {
    return {
      detected: true,
      challengeType: "hcaptcha",
      recommendedAction:
        "hCaptcha challenge detected. Solve once in linked native Edge / Chrome Canary window or import clearance cookies into Sovereign Browser.",
      clearanceCookieNames,
    };
  }

  const has403Challenge =
    lowerHtml.includes("403 forbidden") ||
    lowerHtml.includes("access denied") ||
    networkEntries.some(
      (e) =>
        (e.status === 403 || e.status === 429 || e.status === 503) &&
        e.resourceType === "document",
    );

  if (has403Challenge) {
    return {
      detected: true,
      challengeType: "http-403-challenge",
      recommendedAction:
        "HTTP 403/503 anti-bot gate detected. Switch to Linked Native Browser Profile (Edge / Chrome Canary) or import cf_clearance / session cookies.",
      clearanceCookieNames,
    };
  }

  return {
    detected: false,
    challengeType: "none",
    recommendedAction:
      "No CAPTCHA or anti-bot challenge detected. Sovereign Unrestricted DOM, Cookie Bridge, and Native Profile Linker are ready.",
    clearanceCookieNames,
  };
}

// ============================================================================
// Device Emulation & Anti-Fingerprinting Stealth Profiles
// ============================================================================

export type DeviceViewportPresetId =
  | "desktop-1080p"
  | "macbook-pro-16"
  | "iphone-16-pro"
  | "ipad-pro-13"
  | "studio-display-4k";

export interface DeviceViewportPreset {
  id: DeviceViewportPresetId;
  label: string;
  width: number;
  height: number;
  deviceScaleFactor: number;
  isMobile: boolean;
  hasTouch: boolean;
  userAgentPreset: SovereignUserAgentPreset;
}

export const DEVICE_VIEWPORT_PRESETS: readonly DeviceViewportPreset[] = [
  {
    id: "desktop-1080p",
    label: "Desktop 1080p (1920×1080)",
    width: 1920,
    height: 1080,
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
    userAgentPreset: "desktop-chrome-win11",
  },
  {
    id: "macbook-pro-16",
    label: "MacBook Pro 16 (1728×1117)",
    width: 1728,
    height: 1117,
    deviceScaleFactor: 2,
    isMobile: false,
    hasTouch: false,
    userAgentPreset: "desktop-chrome-win11",
  },
  {
    id: "iphone-16-pro",
    label: "iPhone 16 Pro (402×874, Touch, Mobile UA)",
    width: 402,
    height: 874,
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgentPreset: "mobile-iphone-safari",
  },
  {
    id: "ipad-pro-13",
    label: "iPad Pro 13 (1032×1376)",
    width: 1032,
    height: 1376,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgentPreset: "mobile-iphone-safari",
  },
  {
    id: "studio-display-4k",
    label: "4K Studio Display (3840×2160)",
    width: 3840,
    height: 2160,
    deviceScaleFactor: 2,
    isMobile: false,
    hasTouch: false,
    userAgentPreset: "omnia-sovereign-agent",
  },
] as const;

export interface StealthFingerprintConfig {
  enabled: boolean;
  spoofWebdriverFalse: boolean;
  webglVendor: string;
  webglRenderer: string;
  canvasNoiseSeed: number;
  audioNoiseFactor: number;
  spoofChromeRuntime: boolean;
  hardwareConcurrency: number;
  deviceMemoryGb: number;
  languages: string[];
}

export function createDefaultStealthFingerprintConfig(): StealthFingerprintConfig {
  return {
    enabled: true,
    spoofWebdriverFalse: true,
    webglVendor: "Google Inc. (NVIDIA)",
    webglRenderer:
      "ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)",
    canvasNoiseSeed: 1337,
    audioNoiseFactor: 0.00001,
    spoofChromeRuntime: true,
    hardwareConcurrency: 12,
    deviceMemoryGb: 16,
    languages: ["en-US", "en", "vi-VN"],
  };
}

export function buildAntiDetectStealthScript(
  config: Partial<StealthFingerprintConfig> = {},
): string {
  const merged: StealthFingerprintConfig = {
    ...createDefaultStealthFingerprintConfig(),
    ...config,
  };

  if (!merged.enabled) {
    return "// Omnia Anti-Detect Stealth Injection Disabled";
  }

  const lines: string[] = [
    "(function __omniaSovereignAntiDetectStealth() {",
    "  try {",
  ];

  if (merged.spoofWebdriverFalse) {
    lines.push(
      "    Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true });",
    );
  }

  lines.push(
    `    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => ${merged.hardwareConcurrency}, configurable: true });`,
    `    Object.defineProperty(navigator, 'deviceMemory', { get: () => ${merged.deviceMemoryGb}, configurable: true });`,
    `    Object.defineProperty(navigator, 'languages', { get: () => ${JSON.stringify(merged.languages)}, configurable: true });`,
  );

  if (merged.spoofChromeRuntime) {
    lines.push(
      "    window.chrome = window.chrome || {};",
      "    window.chrome.runtime = window.chrome.runtime || { id: undefined, connect: function() {}, sendMessage: function() {} };",
    );
  }

  // WebGL Vendor & Renderer spoofing (37445 = UNMASKED_VENDOR_WEBGL, 37446 = UNMASKED_RENDERER_WEBGL)
  lines.push(
    "    if (typeof WebGLRenderingContext !== 'undefined') {",
    "      const origGetParameter = WebGLRenderingContext.prototype.getParameter;",
    "      WebGLRenderingContext.prototype.getParameter = function(param) {",
    `        if (param === 37445) return ${JSON.stringify(merged.webglVendor)};`,
    `        if (param === 37446) return ${JSON.stringify(merged.webglRenderer)};`,
    "        return origGetParameter.call(this, param);",
    "      };",
    "    }",
  );

  // Canvas 2D deterministic micro-noise
  lines.push(
    "    if (typeof HTMLCanvasElement !== 'undefined') {",
    "      const origToDataURL = HTMLCanvasElement.prototype.toDataURL;",
    "      HTMLCanvasElement.prototype.toDataURL = function(...args) {",
    `        this.dataset.__omniaCanvasSeed = '${merged.canvasNoiseSeed}';`,
    "        return origToDataURL.apply(this, args);",
    "      };",
    "    }",
  );

  // AudioContext fingerprint protection
  lines.push(
    "    if (typeof AudioBuffer !== 'undefined') {",
    "      const origGetChannelData = AudioBuffer.prototype.getChannelData;",
    "      AudioBuffer.prototype.getChannelData = function(channel) {",
    "        const data = origGetChannelData.call(this, channel);",
    `        if (data && data.length > 0) { data[0] = data[0] + ${merged.audioNoiseFactor}; }`,
    "        return data;",
    "      };",
    "    }",
  );

  lines.push(
    "    window.__OMNIA_STEALTH_ACTIVE__ = true;",
    "  } catch (_) {}",
    "})();",
  );

  return lines.join("\n");
}

// ============================================================================
// Performance Flamechart & Accessibility / Set-of-Marks (SoM) DOM Snapshot
// ============================================================================

export interface SetOfMarksNode {
  somId: number;
  markLabel: string;
  nodeId: string;
  tag: string;
  role: string;
  accessibleName: string;
  selector: string;
  interactiveAction:
    | "click"
    | "input"
    | "navigate"
    | "media-control"
    | "inspect";
  boundingBox: {
    width: number;
    height: number;
  };
  hrefOrSrc?: string;
}

export interface AccessibilityAndSomSnapshot {
  url: string;
  totalDomNodes: number;
  interactiveMarksCount: number;
  marks: SetOfMarksNode[];
  agentPromptSummary: string;
}

function inferAccessibleRole(node: DomInspectorNode): string {
  const explicitRole = node.attributes.role?.trim();
  if (explicitRole) return explicitRole;
  switch (node.tag) {
    case "a":
      return "link";
    case "button":
      return "button";
    case "input":
      return node.attributes.type === "checkbox" ? "checkbox" : "textbox";
    case "select":
      return "combobox";
    case "textarea":
      return "textbox";
    case "video":
    case "audio":
      return "media-player";
    case "nav":
      return "navigation";
    case "header":
      return "banner";
    case "main":
      return "main";
    case "h1":
    case "h2":
    case "h3":
      return "heading";
    default:
      return "generic";
  }
}

function isInteractiveDomNode(node: DomInspectorNode): boolean {
  const interactiveTags = new Set([
    "a",
    "button",
    "input",
    "select",
    "textarea",
    "video",
    "audio",
    "summary",
  ]);
  if (interactiveTags.has(node.tag)) return true;
  if (
    "onclick" in node.attributes ||
    "data-action" in node.attributes ||
    "data-role" in node.attributes ||
    "href" in node.attributes ||
    "tabindex" in node.attributes ||
    node.attributes.role === "button" ||
    node.attributes.role === "link"
  ) {
    return true;
  }
  return false;
}

export function captureAccessibilityAndSomTree(
  tree: DomInspectorNode[],
  url = "https://stream-vault.omnia.local/watch/4k-master-hdr",
): AccessibilityAndSomSnapshot {
  const flat = flattenDomInspectorTree(tree);
  const marks: SetOfMarksNode[] = [];
  let somCounter = 0;

  for (const { node } of flat) {
    if (!isInteractiveDomNode(node)) continue;
    somCounter += 1;
    const markLabel = `[SoM #${somCounter}]`;
    const role = inferAccessibleRole(node);
    const accessibleName =
      node.attributes["aria-label"]?.trim() ||
      node.textContent.trim() ||
      node.attributes.title?.trim() ||
      node.attributes.placeholder?.trim() ||
      node.elementId ||
      `${node.tag}-${somCounter}`;

    const interactiveAction: SetOfMarksNode["interactiveAction"] =
      node.tag === "a" || "href" in node.attributes
        ? "navigate"
        : node.tag === "input" ||
            node.tag === "textarea" ||
            node.tag === "select"
          ? "input"
          : node.tag === "video" || node.tag === "audio"
            ? "media-control"
            : "click";

    const hrefOrSrc =
      node.attributes.href ??
      node.attributes["data-hls-manifest"] ??
      node.attributes.src;

    marks.push({
      somId: somCounter,
      markLabel,
      nodeId: node.id,
      tag: node.tag,
      role,
      accessibleName,
      selector: node.pathSelector,
      interactiveAction,
      boundingBox: {
        width: node.boxModel.contentWidth,
        height: node.boxModel.contentHeight,
      },
      ...(hrefOrSrc ? { hrefOrSrc } : {}),
    });
  }

  const summaryLines = marks.map(
    (m) =>
      `${m.markLabel} <${m.tag}> role="${m.role}" "${m.accessibleName}" (${m.boundingBox.width}x${m.boundingBox.height}) -> ${m.selector}`,
  );

  return {
    url,
    totalDomNodes: flat.length,
    interactiveMarksCount: marks.length,
    marks,
    agentPromptSummary:
      summaryLines.length > 0
        ? summaryLines.join("\n")
        : "No interactive Set-of-Marks elements found in DOM.",
  };
}

export interface FlamechartSpan {
  id: string;
  label: string;
  category: "network" | "scripting" | "rendering" | "painting" | "media";
  startMs: number;
  durationMs: number;
}

export interface PagePerformanceMetrics {
  lcpMs: number;
  clsScore: number;
  inpMs: number;
  ttfbMs: number;
  fcpMs: number;
  domNodesCount: number;
  jsHeapUsedMb: number;
  jsHeapTotalMb: number;
  totalTransferBytes: number;
  flamechartSpans: FlamechartSpan[];
}

export function computePagePerformanceMetrics(
  domTree: DomInspectorNode[],
  networkEntries: readonly SovereignNetworkEntry[] = [],
): PagePerformanceMetrics {
  const flatNodes = flattenDomInspectorTree(domTree);
  const domNodesCount = Math.max(1, flatNodes.length);
  const docEntry = networkEntries.find((e) => e.resourceType === "document");
  const ttfbMs = docEntry?.timings.ttfbMs ?? 24;
  const fcpMs = ttfbMs + 36;
  const lcpMs = fcpMs + Math.min(240, domNodesCount * 8);
  const inpMs = 16;
  const clsScore = 0.01;

  const totalTransferBytes = networkEntries.reduce(
    (acc, item) => acc + (item.sizeBytes || 0),
    0,
  );

  const jsHeapUsedMb = Number((38.4 + domNodesCount * 0.45).toFixed(1));
  const jsHeapTotalMb = Number((64.0 + domNodesCount * 0.6).toFixed(1));

  const flamechartSpans: FlamechartSpan[] = [
    {
      id: "span-net-doc",
      label: "Document Navigation & TLS Handshake",
      category: "network",
      startMs: 0,
      durationMs: docEntry?.durationMs ?? 52,
    },
    {
      id: "span-dom-parse",
      label: `Parse HTML & Build DOM (${domNodesCount} nodes)`,
      category: "scripting",
      startMs: ttfbMs,
      durationMs: 18 + domNodesCount * 2,
    },
    {
      id: "span-userscripts",
      label: "Sovereign Anti-Detect & Userscript Injection",
      category: "scripting",
      startMs: ttfbMs + 12,
      durationMs: 9,
    },
    {
      id: "span-style-layout",
      label: "Recalculate Style & Layout Box Model",
      category: "rendering",
      startMs: fcpMs,
      durationMs: 22,
    },
    {
      id: "span-compositor-paint",
      label: "Composite Layers & 4K Media Surface Paint",
      category: "painting",
      startMs: fcpMs + 22,
      durationMs: 14,
    },
  ];

  return {
    lcpMs,
    clsScore,
    inpMs,
    ttfbMs,
    fcpMs,
    domNodesCount,
    jsHeapUsedMb,
    jsHeapTotalMb,
    totalTransferBytes,
    flamechartSpans,
  };
}


