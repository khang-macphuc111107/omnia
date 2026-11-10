import {
  Check,
  Clipboard,
  Download,
  Palette,
  Redo2,
  RotateCcw,
  Sparkles,
  Undo2,
} from "lucide-react";
import { useMemo, useRef, useState, type ChangeEvent, type CSSProperties } from "react";

import { ThemeLabPreview } from "./theme-lab-preview";
import { AppearanceTokenLab } from "./appearance-token-lab";
import { PaletteHarmonyLab } from "./palette-harmony-lab";
import {
  applySessionPalettePreview,
  clearSessionPalettePreview,
  isSessionPalettePreviewActive,
} from "./session-palette-preview";

type AppearanceExportFormat = "json" | "markdown" | "css";

type PaletteDirection = {
  id: string;
  index: number;
  name: string;
  description: string;
  colors: readonly [string, string, string, string];
};

type LogoDirection = {
  id: string;
  index: number;
  name: string;
  description: string;
  accent: string;
  kind:
    | "aperture"
    | "brackets"
    | "prompt"
    | "split-loop"
    | "chevrons"
    | "grid"
    | "corners"
    | "hex-cross"
    | "open-o"
    | "stack"
    | "window"
    | "diamond";
};

type AppearancePreview = {
  logoId: string;
  paletteId: string;
  customAccent: string | null;
  energy: "quiet" | "balanced" | "expressive";
  surface: "graphite" | "slate" | "ink";
  geometry: "sharp" | "soft" | "pill";
  signal: "solid" | "soft-glow" | "edge";
  customRoles: readonly [string | null, string | null, string | null, string | null];
};

type AppearanceHistory = {
  past: AppearancePreview[];
  present: AppearancePreview;
  future: AppearancePreview[];
};

const palettes: readonly PaletteDirection[] = [
  {
    id: "palette-1-steel-signal",
    index: 1,
    name: "Steel Signal",
    description: "Cool blue, sea glass, and a small amber edge for dense technical work.",
    colors: ["#4F8CFF", "#19B7A5", "#E7A83C", "#EE6D8A"],
  },
  {
    id: "palette-2-ember-grid",
    index: 2,
    name: "Ember Grid",
    description: "Burnished orange with navy, rose, and mint signal states.",
    colors: ["#E07A3F", "#3F7DFF", "#D95D83", "#48B86B"],
  },
  {
    id: "palette-3-tidal-spectrum",
    index: 3,
    name: "Tidal Spectrum",
    description: "The selected dark-first direction: cobalt, deep teal, amber, and coral in balance.",
    colors: ["#2563EB", "#0F766E", "#D97706", "#E11D48"],
  },
  {
    id: "palette-4-verdant-console",
    index: 4,
    name: "Verdant Console",
    description: "Forest and lime signals with restrained blue and copper accents.",
    colors: ["#238636", "#76C442", "#4F8CFF", "#C97A2B"],
  },
  {
    id: "palette-5-coral-terminal",
    index: 5,
    name: "Coral Terminal",
    description: "Warm coral and magenta signals grounded by cyan and slate.",
    colors: ["#E76F51", "#E45D9A", "#26A9D9", "#D6A13C"],
  },
  {
    id: "palette-6-night-orbit",
    index: 6,
    name: "Night Orbit",
    description: "Electric indigo paired with aqua, orchid, and soft citrus for research views.",
    colors: ["#6675F5", "#1DB5A4", "#A475E8", "#D6B53C"],
  },
  {
    id: "palette-7-terminal-teal",
    index: 7,
    name: "Terminal Teal",
    description: "Calm, precise, and IDE-native with a constructive mint support signal.",
    colors: ["#23C6B8", "#149E92", "#F5B94C", "#FF7A7A"],
  },
  {
    id: "palette-8-command-cyan",
    index: 8,
    name: "Command Cyan",
    description: "Crisp cyan contrast for command palettes, routing, and dense navigation.",
    colors: ["#38BDF8", "#0E9ED5", "#F5B94C", "#6EE7B7"],
  },
  {
    id: "palette-9-steel-blue",
    index: 9,
    name: "Steel Blue",
    description: "Reliable blue with a quiet mono edge for professional workspaces.",
    colors: ["#5CA9FF", "#3B82F6", "#D6DEE8", "#F5B94C"],
  },
  {
    id: "palette-10-mint-green",
    index: 10,
    name: "Mint Green",
    description: "Fresh progress signals for building, learning, and long sessions.",
    colors: ["#6EE7B7", "#34D399", "#5CA9FF", "#F5B94C"],
  },
  {
    id: "palette-11-build-amber",
    index: 11,
    name: "Build Amber",
    description: "Warm maker energy grounded by blue, graphite, and clear alert semantics.",
    colors: ["#F5B94C", "#D9941F", "#5CA9FF", "#FF7A7A"],
  },
  {
    id: "palette-12-editor-mono",
    index: 12,
    name: "Editor Mono",
    description: "Mature neutral surfaces with small cyan and amber signals for focus.",
    colors: ["#D6DEE8", "#9EABBA", "#38BDF8", "#F5B94C"],
  },
];

const logos: readonly LogoDirection[] = [
  { id: "logo-01-open-aperture", index: 1, name: "Open aperture", description: "A focused aperture with a neutral core; the selected direction for Omnia.", accent: "#23C6B8", kind: "aperture" },
  { id: "logo-02-bracket-scope", index: 2, name: "Bracket scope", description: "Code brackets framing a focused square for a direct developer-tool signal.", accent: "#38BDF8", kind: "brackets" },
  { id: "logo-03-cli-prompt", index: 3, name: "CLI prompt", description: "A terminal prompt inside a sturdy frame; compact and immediately familiar.", accent: "#F5B94C", kind: "prompt" },
  { id: "logo-04-split-loop", index: 4, name: "Split loop", description: "Two precise loops leave a calm center for context and collaboration.", accent: "#6EE7B7", kind: "split-loop" },
  { id: "logo-05-chevron-flow", index: 5, name: "Chevron flow", description: "Forward chevrons imply routing, automation, and continuous progress.", accent: "#5CA9FF", kind: "chevrons" },
  { id: "logo-06-grid-aperture", index: 6, name: "Grid aperture", description: "Structured corners with an open center for modular workspace surfaces.", accent: "#FF6B6B", kind: "grid" },
  { id: "logo-07-corner-frame", index: 7, name: "Corner frame", description: "Scope corners around a focused core; precise without looking robotic.", accent: "#B4E33A", kind: "corners" },
  { id: "logo-08-hex-ring", index: 8, name: "Hex ring", description: "A quiet systems-oriented silhouette that bridges the current mark.", accent: "#B8C7D9", kind: "hex-cross" },
  { id: "logo-09-open-o", index: 9, name: "Open O", description: "A monoline O with a deliberate command break for active work.", accent: "#FB8C4A", kind: "open-o" },
  { id: "logo-10-stacked-bars", index: 10, name: "Stacked bars", description: "Layered context, memory, and artifacts expressed as a readable stack.", accent: "#38BDF8", kind: "stack" },
  { id: "logo-11-signal-window", index: 11, name: "Signal window", description: "A desktop-native window with one clear pulse for observability.", accent: "#FF7A7A", kind: "window" },
  { id: "logo-12-diamond-gate", index: 12, name: "Diamond gate", description: "A sharper aperture evolution for a more infrastructure-led Omnia.", accent: "#D6A85F", kind: "diamond" },
];

const defaultPreview: AppearancePreview = {
  logoId: "logo-01-open-aperture",
  paletteId: "palette-3-tidal-spectrum",
  customAccent: null,
  energy: "balanced",
  surface: "graphite",
  geometry: "soft",
  signal: "soft-glow",
  customRoles: [null, null, null, null],
};

// The trial survives navigation within this renderer tab, not a page reload.
let activeLivePreview: AppearancePreview | null = null;

const roleLabels = ["Primary", "Support", "Alert", "Focus"] as const;

const stylePresets: readonly {
  id: string;
  name: string;
  description: string;
  patch: Pick<AppearancePreview, "surface" | "geometry" | "signal" | "energy">;
}[] = [
  {
    id: "terminal",
    name: "Terminal",
    description: "Dense, crisp, and high-signal for code-heavy sessions.",
    patch: { surface: "ink", geometry: "sharp", signal: "edge", energy: "expressive" },
  },
  {
    id: "studio",
    name: "Signal studio",
    description: "Balanced geometry with a restrained glow for everyday work.",
    patch: { surface: "graphite", geometry: "soft", signal: "soft-glow", energy: "balanced" },
  },
  {
    id: "research",
    name: "Research canvas",
    description: "Calmer contrast and rounded cards for long reading sessions.",
    patch: { surface: "slate", geometry: "pill", signal: "solid", energy: "quiet" },
  },
];

function LogoMark({ logo }: { logo: LogoDirection }) {
  const stroke = "currentColor";
  const common = { fill: "none", stroke, strokeWidth: 2.4, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  switch (logo.kind) {
    case "brackets":
      return <svg viewBox="0 0 32 32" aria-hidden="true"><path {...common} d="M12 7H7v7M7 18v7h5M20 7h5v7M25 18v7h-5" /><rect x="13" y="13" width="6" height="6" rx="1" fill="currentColor" stroke="none" /></svg>;
    case "prompt":
      return <svg viewBox="0 0 32 32" aria-hidden="true"><rect {...common} x="5" y="6" width="22" height="20" rx="5" /><path {...common} d="m10 12 5 4-5 4M18 20h5" /></svg>;
    case "split-loop":
      return <svg viewBox="0 0 32 32" aria-hidden="true"><path {...common} d="M15 8c-5 1-8 5-8 9s4 8 9 8c2 0 4-1 5-2M17 8c5 1 8 5 8 9s-4 8-9 8c-2 0-4-1-5-2" /><rect x="14" y="13" width="4" height="6" rx="1" fill="currentColor" stroke="none" /></svg>;
    case "chevrons":
      return <svg viewBox="0 0 32 32" aria-hidden="true"><path {...common} d="m5 8 6 8-6 8M12 8l6 8-6 8M19 8l6 8-6 8" /><path {...common} d="M8 16h17" strokeOpacity=".75" /></svg>;
    case "grid":
      return <svg viewBox="0 0 32 32" aria-hidden="true"><path {...common} d="M6 12V6h6M20 6h6v6M26 20v6h-6M12 26H6v-6" /><rect x="13" y="13" width="6" height="6" rx="1.5" fill="currentColor" stroke="none" /></svg>;
    case "corners":
      return <svg viewBox="0 0 32 32" aria-hidden="true"><path {...common} d="M11 6H6v5M21 6h5v5M26 21v5h-5M6 21v5h5" /><circle cx="16" cy="16" r="3.2" fill="currentColor" stroke="none" /></svg>;
    case "hex-cross":
      return <svg viewBox="0 0 32 32" aria-hidden="true"><path {...common} d="m16 4 10 6v12l-10 6L6 22V10l10-6Z" /><path {...common} d="M16 11v10M11 16h10" /></svg>;
    case "open-o":
      return <svg viewBox="0 0 32 32" aria-hidden="true"><path {...common} d="M21 10a8 8 0 1 0 0 12M21 10l4 1-2 4" /><circle cx="16" cy="16" r="2.8" fill="currentColor" stroke="none" /></svg>;
    case "stack":
      return <svg viewBox="0 0 32 32" aria-hidden="true"><path d="M8 9h16M11 16h13M14 23h10" stroke={stroke} strokeWidth="3" strokeLinecap="round" /><circle cx="7" cy="9" r="1.6" fill="currentColor" /><circle cx="10" cy="16" r="1.6" fill="currentColor" /><circle cx="13" cy="23" r="1.6" fill="currentColor" /></svg>;
    case "window":
      return <svg viewBox="0 0 32 32" aria-hidden="true"><rect {...common} x="6" y="6" width="20" height="20" rx="4" /><path {...common} d="M9 17h4l2-5 3 9 2-4h3" /></svg>;
    case "diamond":
      return <svg viewBox="0 0 32 32" aria-hidden="true"><path {...common} d="m16 4 10 6v12l-10 6L6 22V10l10-6Z" /><path d="m16 11 5 5-5 5-5-5 5-5Z" fill="currentColor" stroke="none" /></svg>;
    case "aperture":
    default:
      return <svg viewBox="0 0 32 32" aria-hidden="true"><path {...common} d="m16 4 10 6v12l-10 6L6 22V10l10-6Z" /><path d="m16 9 7 4v6l-7 4-7-4v-6l7-4Z" fill="currentColor" fillOpacity=".24" stroke="none" /><path d="m16 11 5 5-5 5-5-5 5-5Z" fill="currentColor" stroke="none" /></svg>;
  }
}

function clonePreview(preview: AppearancePreview): AppearancePreview {
  return { ...preview, customRoles: [...preview.customRoles] as AppearancePreview["customRoles"] };
}

function samePreview(left: AppearancePreview, right: AppearancePreview): boolean {
  return left.logoId === right.logoId
    && left.paletteId === right.paletteId
    && left.customAccent === right.customAccent
    && left.energy === right.energy
    && left.surface === right.surface
    && left.geometry === right.geometry
    && left.signal === right.signal
    && left.customRoles.every((color, index) => color === right.customRoles[index]);
}

function isHexColor(value: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(value.trim());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function enumOrFallback<T extends string>(value: unknown, values: readonly T[], fallback: T): T {
  return typeof value === "string" && values.includes(value as T) ? value as T : fallback;
}

function normalizeImportedHex(value: unknown): string | null {
  return typeof value === "string" && isHexColor(value) ? value.toUpperCase() : null;
}

function parseImportedPreview(raw: string): AppearancePreview | null {
  try {
    const parsed: unknown = JSON.parse(raw.replace(/^\uFEFF/, ""));
    if (!isRecord(parsed) || parsed.schema !== "omnia.appearance-preview.v1" || !isRecord(parsed.preview)) return null;
    const paletteRecord = isRecord(parsed.palette) ? parsed.palette : undefined;
    const importedPalette = paletteRecord && typeof paletteRecord.id === "string"
      ? palettes.find((candidate) => candidate.id === paletteRecord.id)
      : undefined;
    const previewRecord = parsed.preview;
    const importedLogo = typeof previewRecord.logoId === "string"
      ? logos.find((candidate) => candidate.id === previewRecord.logoId)
      : undefined;
    const customAccentValue = parsed.preview.customAccent;
    const customAccent = customAccentValue === null || customAccentValue === undefined
      ? null
      : typeof customAccentValue === "string" && isHexColor(customAccentValue)
        ? customAccentValue.toUpperCase()
        : null;
    const rawRoles = parsed.preview.roleColors;
    const customRoles: AppearancePreview["customRoles"] = Array.isArray(rawRoles) && rawRoles.length === 4
      ? [
        normalizeImportedHex(rawRoles[0]),
        normalizeImportedHex(rawRoles[1]),
        normalizeImportedHex(rawRoles[2]),
        normalizeImportedHex(rawRoles[3]),
      ]
      : [null, null, null, null];
    return {
      logoId: importedLogo?.id ?? defaultPreview.logoId,
      paletteId: importedPalette?.id ?? defaultPreview.paletteId,
      customAccent,
      energy: enumOrFallback(parsed.preview.energy, ["quiet", "balanced", "expressive"], defaultPreview.energy),
      surface: enumOrFallback(parsed.preview.surface, ["graphite", "slate", "ink"], defaultPreview.surface),
      geometry: enumOrFallback(parsed.preview.geometry, ["sharp", "soft", "pill"], defaultPreview.geometry),
      signal: enumOrFallback(parsed.preview.signal, ["solid", "soft-glow", "edge"], defaultPreview.signal),
      customRoles,
    };
  } catch {
    return null;
  }
}

async function readAppearanceFile(file: File): Promise<string> {
  if (typeof file.text === "function") return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(reader.error ?? new Error("Unable to read appearance preview file."));
    reader.readAsText(file);
  });
}

function serializeAppearancePreview(preview: AppearancePreview, palette: PaletteDirection, format: AppearanceExportFormat): string {
  const logo = logos.find((candidate) => candidate.id === preview.logoId) ?? logos[0]!;
  const accent = preview.customRoles[0] ?? preview.customAccent ?? palette.colors[0];
  const roleColors: PaletteDirection["colors"] = [
    preview.customRoles[0] ?? preview.customAccent ?? palette.colors[0],
    preview.customRoles[1] ?? palette.colors[1],
    preview.customRoles[2] ?? palette.colors[2],
    preview.customRoles[3] ?? palette.colors[3],
  ];
  const payload = {
    schema: "omnia.appearance-preview.v1",
    scope: "renderer-session",
    generatedAt: new Date().toISOString(),
    palette: {
      id: palette.id,
      index: palette.index,
      name: palette.name,
      colors: palette.colors,
    },
    logo: {
      id: logo.id,
      index: logo.index,
      name: logo.name,
      kind: logo.kind,
    },
    preview: {
      logoId: logo.id,
      accent,
      customAccent: preview.customAccent,
      roleColors,
      energy: preview.energy,
      surface: preview.surface,
      geometry: preview.geometry,
      signal: preview.signal,
    },
    boundary: "Renderer-local appearance preview only; it does not change global design tokens, native preferences, or durable profile settings.",
  };
  if (format === "json") return JSON.stringify(payload, null, 2);
  if (format === "css") {
    return [
      ":root {",
      `  --omnia-accent-primary: ${roleColors[0]};`,
      `  --omnia-accent-support: ${roleColors[1]};`,
      `  --omnia-accent-alert: ${roleColors[2]};`,
      `  --omnia-accent-focus: ${roleColors[3]};`,
      `  --omnia-surface: ${preview.surface};`,
      `  --omnia-geometry: ${preview.geometry};`,
      `  --omnia-signal-treatment: ${preview.signal};`,
      "}",
      "",
      "/* Renderer-local Omnia appearance preview only. */",
    ].join("\n");
  }
  return [
    "# Omnia appearance preview",
    "",
    "> Renderer-local appearance preview only; it does not change global design tokens, native preferences, or durable profile settings.",
    "",
    `- Palette: ${palette.index} · ${palette.name}`,
    `- Logo: ${logo.index} · ${logo.name}`,
    `- Accent: ${accent}`,
    `- Accent energy: ${preview.energy}`,
    `- Supporting colors: ${palette.colors.slice(1).join(", ")}`,
  ].join("\n");
}

function downloadAppearancePreview(payload: string, format: AppearanceExportFormat): boolean {
  if (typeof URL.createObjectURL !== "function") return false;
  const contentType = format === "json" ? "application/json" : format === "css" ? "text/css" : "text/markdown";
  const extension = format === "json" ? "json" : format === "css" ? "css" : "md";
  const url = URL.createObjectURL(new Blob([payload], { type: contentType }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `omnia-appearance-preview.${extension}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  if (typeof URL.revokeObjectURL === "function") window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

export function AppearancePreviewDeck() {
  const [history, setHistory] = useState<AppearanceHistory>({
    past: [],
    present: clonePreview(isSessionPalettePreviewActive() ? activeLivePreview ?? defaultPreview : defaultPreview),
    future: [],
  });
  const [customAccentInput, setCustomAccentInput] = useState("");
  const [status, setStatus] = useState(isSessionPalettePreviewActive() && activeLivePreview
    ? "Your dark palette trial is still active in this renderer tab."
    : "Palette 3 is ready as a renderer-local dark-first direction.");
  const [exportOpen, setExportOpen] = useState(false);
  const [exportFormat, setExportFormat] = useState<AppearanceExportFormat>("json");
  const [exportStatus, setExportStatus] = useState("Appearance preview is ready to inspect locally.");
  const [livePaletteActive, setLivePaletteActive] = useState(() => isSessionPalettePreviewActive());
  const importInputRef = useRef<HTMLInputElement>(null);

  const preview = history.present;
  const logo = logos.find((candidate) => candidate.id === preview.logoId) ?? logos[0]!;
  const palette = palettes.find((candidate) => candidate.id === preview.paletteId) ?? palettes[2]!;
  const roleColors = [0, 1, 2, 3].map((index) =>
    preview.customRoles[index] ?? (index === 0 ? preview.customAccent : null) ?? palette.colors[index],
  ) as [string, string, string, string];
  const accent = roleColors[0];
  const sampleStyle = {
    "--appearance-primary": accent,
    "--appearance-secondary": roleColors[1],
    "--appearance-tertiary": roleColors[2],
    "--appearance-quaternary": roleColors[3],
  } as CSSProperties;
  const payload = useMemo(
    () => serializeAppearancePreview(preview, palette, exportFormat),
    [exportFormat, palette, preview],
  );

  const commit = (patch: Partial<AppearancePreview>, nextStatus: string) => {
    setHistory((current) => {
      const next = { ...current.present, ...patch };
      if (samePreview(next, current.present)) return current;
      return {
        past: [...current.past, clonePreview(current.present)],
        present: next,
        future: [],
      };
    });
    setStatus(nextStatus);
  };

  const undo = () => {
    setHistory((current) => {
      const snapshot = current.past.at(-1);
      if (!snapshot) return current;
      return {
        past: current.past.slice(0, -1),
        present: clonePreview(snapshot),
        future: [clonePreview(current.present), ...current.future],
      };
    });
    setStatus("Undid the last appearance preview change.");
  };

  const redo = () => {
    setHistory((current) => {
      const snapshot = current.future[0];
      if (!snapshot) return current;
      return {
        past: [...current.past, clonePreview(current.present)],
        present: clonePreview(snapshot),
        future: current.future.slice(1),
      };
    });
    setStatus("Reapplied the next appearance preview change.");
  };

  const reset = () => {
    setHistory((current) => {
      if (samePreview(current.present, defaultPreview)) return current;
      return {
        past: [...current.past, clonePreview(current.present)],
        present: clonePreview(defaultPreview),
        future: [],
      };
    });
    setCustomAccentInput("");
    setStatus("Appearance preview reset to Palette 3 and balanced energy.");
  };

  const applyCustomAccent = () => {
    const value = customAccentInput.trim().toUpperCase();
    if (!isHexColor(value)) {
      setStatus("Use a six-digit hex color such as #22C55E for the custom accent preview.");
      return;
    }
    commit({ customAccent: value }, `Custom accent ${value} applied in the renderer preview.`);
  };

  const copyPreview = async () => {
    if (!navigator.clipboard?.writeText) {
      setExportStatus("Clipboard access is unavailable; no appearance preview was copied.");
      return;
    }
    try {
      await navigator.clipboard.writeText(payload);
      setExportStatus(`Copied the renderer-local appearance preview as ${exportFormat.toUpperCase()}.`);
    } catch {
      setExportStatus("Clipboard access was denied; no appearance preview was copied.");
    }
  };

  const downloadPreview = () => {
    setExportStatus(
      downloadAppearancePreview(payload, exportFormat)
        ? "Started a browser download of the renderer-local appearance preview."
        : "Browser download is unavailable in this preview; no appearance file was written.",
    );
  };

  const importPreview = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > 512_000) {
      setExportStatus("Import is limited to 512 KB; no appearance preview was changed.");
      return;
    }
    let imported: AppearancePreview | null;
    try {
      imported = parseImportedPreview(await readAppearanceFile(file));
    } catch {
      setExportStatus("The appearance preview file could not be read; no preview was changed.");
      return;
    }
    if (!imported) {
      setExportStatus("That file is not a valid Omnia appearance preview JSON bundle.");
      return;
    }
    setHistory((current) => ({
      past: [...current.past, clonePreview(current.present)],
      present: clonePreview(imported),
      future: [],
    }));
    setCustomAccentInput(imported.customAccent ?? "");
    setStatus("Imported an appearance preview into this renderer session; no durable settings changed.");
    setExportStatus(`Imported ${file.name} as a renderer-local appearance preview.`);
  };

  return (
    <section className="appearance-preview-deck" aria-labelledby="appearance-preview-deck-title">
      <header className="appearance-preview-deck__header">
        <span className="appearance-preview-deck__mark"><Palette size={17} /></span>
        <div>
          <span className="eyebrow">Color system sandbox</span>
          <h3 id="appearance-preview-deck-title">Shape a richer Omnia palette and mark before committing it</h3>
          <p>Mix many elegant accent families and coder-native logo directions without turning the workspace into a single-color AI surface.</p>
        </div>
        <span className="appearance-preview-deck__status"><Sparkles size={13} /> Renderer preview</span>
      </header>

      <div className="appearance-preview-deck__history" role="toolbar" aria-label="Appearance preview history">
        <span role="status" aria-live="polite">{status}</span>
        <span>{history.past.length + history.future.length} preview steps</span>
        <button type="button" className="button button--ghost" onClick={undo} disabled={history.past.length === 0} aria-label="Undo appearance preview change"><Undo2 size={14} /> Undo</button>
        <button type="button" className="button button--ghost" onClick={redo} disabled={history.future.length === 0} aria-label="Redo appearance preview change"><Redo2 size={14} /> Redo</button>
        <button type="button" className="button button--ghost" onClick={reset} aria-label="Reset appearance preview"><RotateCcw size={14} /> Reset</button>
      </div>

      <div className="appearance-preview-deck__live-trial">
        <div>
          <strong>Try these colors across Omnia</strong>
          <small>Dark theme only · renderer-session trial. No native setting or app icon changes; reload clears the trial.</small>
        </div>
        <button type="button" className="button button--secondary" onClick={() => {
          applySessionPalettePreview(roleColors);
          activeLivePreview = clonePreview(preview);
          setLivePaletteActive(true);
          setStatus(`Palette ${palette.index} colors are active across this renderer session; no durable setting changed.`);
        }}>Try palette in app</button>
        <button type="button" className="button button--ghost" disabled={!livePaletteActive} onClick={() => {
          clearSessionPalettePreview();
          activeLivePreview = null;
          setLivePaletteActive(false);
          setStatus("Stopped the live palette trial; Omnia's original colors are restored.");
        }}>Stop live preview</button>
        <span aria-live="polite">{livePaletteActive ? "Live colors on · session only" : "Original app colors"}</span>
      </div>

      <div className="appearance-preview-deck__identity-heading">
        <span className="eyebrow">Logo directions</span>
        <strong>Choose a mark that feels native to your workflow</strong>
        <small>Logo 1 is selected by default. Every direction is a renderer-local preview and can be swapped without changing the production app icon.</small>
      </div>
      <div className="appearance-preview-deck__logo-grid" role="list" aria-label="Omnia logo directions">
        {logos.map((candidate) => {
          const selected = candidate.id === preview.logoId;
          return (
            <div key={candidate.id} role="listitem">
              <button
                type="button"
                className={selected ? "appearance-logo-card is-selected" : "appearance-logo-card"}
                aria-pressed={selected}
                aria-label={`Use Logo ${candidate.index} · ${candidate.name}`}
                onClick={() => commit({ logoId: candidate.id }, `Logo ${candidate.index} · ${candidate.name} selected in the renderer preview.`)}
              >
                <span className="appearance-logo-card__top"><strong>Logo {candidate.index}</strong>{selected ? <Check size={14} /> : null}</span>
                <span className="appearance-logo-card__mark" style={{ color: candidate.accent }}><LogoMark logo={candidate} /></span>
                <span className="appearance-logo-card__copy"><b>{candidate.name}</b><small>{candidate.description}</small></span>
              </button>
            </div>
          );
        })}
      </div>

      <div className="appearance-preview-deck__palette-grid" role="list" aria-label="Omnia palette directions">
        {palettes.map((candidate) => {
          const selected = candidate.id === preview.paletteId;
          return (
            <div key={candidate.id} role="listitem">
              <button
                type="button"
                className={selected ? "appearance-palette-card is-selected" : "appearance-palette-card"}
                aria-pressed={selected}
                aria-label={`Use Palette ${candidate.index} · ${candidate.name}`}
                onClick={() => commit({ paletteId: candidate.id, customAccent: null }, `Palette ${candidate.index} · ${candidate.name} selected in the renderer preview.`)}
              >
                <span className="appearance-palette-card__top"><strong>Palette {candidate.index}</strong>{selected ? <Check size={14} /> : null}</span>
                <span className="appearance-palette-card__colors">{candidate.colors.map((color) => <i key={color} style={{ background: color }} />)}</span>
                <span className="appearance-palette-card__copy"><b>{candidate.name}</b><small>{candidate.description}</small></span>
              </button>
            </div>
          );
        })}
      </div>

      <div className="appearance-preview-deck__custom-row">
        <label>
          <span>Custom accent hex</span>
          <input value={customAccentInput} onChange={(event) => setCustomAccentInput(event.target.value)} placeholder="#22C55E" aria-label="Custom appearance accent hex" />
        </label>
        <button type="button" className="button button--secondary" onClick={applyCustomAccent}>Use custom accent</button>
        <label>
          <span>Accent energy</span>
          <select value={preview.energy} onChange={(event) => commit({ energy: event.target.value as AppearancePreview["energy"] }, `Accent energy set to ${event.target.value} in the renderer preview.`)} aria-label="Appearance accent energy">
            <option value="quiet">Quiet</option>
            <option value="balanced">Balanced</option>
            <option value="expressive">Expressive</option>
          </select>
        </label>
      </div>

      <div className="appearance-preview-deck__studio-row">
        <div className="appearance-preview-deck__studio-heading">
          <span className="eyebrow">Style controls</span>
          <strong>Make the interface feel like yours</strong>
          <small>These controls only reshape this renderer preview; they do not overwrite Omnia's global token system.</small>
        </div>
        <label>
          <span>Surface contrast</span>
          <select
            value={preview.surface}
            onChange={(event) => commit({ surface: event.target.value as AppearancePreview["surface"] }, `Surface contrast set to ${event.target.value} in the renderer preview.`)}
            aria-label="Appearance surface contrast"
          >
            <option value="graphite">Graphite</option>
            <option value="slate">Slate</option>
            <option value="ink">Ink</option>
          </select>
        </label>
        <label>
          <span>Interface geometry</span>
          <select
            value={preview.geometry}
            onChange={(event) => commit({ geometry: event.target.value as AppearancePreview["geometry"] }, `Interface geometry set to ${event.target.value} in the renderer preview.`)}
            aria-label="Appearance interface geometry"
          >
            <option value="sharp">Sharp</option>
            <option value="soft">Soft</option>
            <option value="pill">Pill</option>
          </select>
        </label>
        <label>
          <span>Signal treatment</span>
          <select
            value={preview.signal}
            onChange={(event) => commit({ signal: event.target.value as AppearancePreview["signal"] }, `Signal treatment set to ${event.target.value} in the renderer preview.`)}
            aria-label="Appearance signal treatment"
          >
            <option value="solid">Solid</option>
            <option value="soft-glow">Soft glow</option>
            <option value="edge">Edge signal</option>
          </select>
        </label>
      </div>

      <div className="appearance-preview-deck__preset-row" role="list" aria-label="Appearance mood presets">
        {stylePresets.map((preset) => (
          <button
            type="button"
            key={preset.id}
            className="appearance-mood-card"
            onClick={() => commit(preset.patch, `${preset.name} mood applied in the renderer preview.`)}
            aria-label={`Use ${preset.name} appearance mood`}
          >
            <strong>{preset.name}</strong>
            <small>{preset.description}</small>
          </button>
        ))}
      </div>

      <div className="appearance-preview-deck__role-row" aria-label="Appearance role color overrides">
        <div className="appearance-preview-deck__studio-heading">
          <span className="eyebrow">Role colors</span>
          <strong>Keep the palette varied without losing hierarchy</strong>
          <small>Pick a dedicated color for primary, support, alert, and focus states. Reset returns to the selected palette.</small>
        </div>
        {roleLabels.map((role, index) => {
          const roleColor = roleColors[index];
          return (
            <label key={role} className="appearance-role-color">
              <span>{role}</span>
              <input
                type="color"
                value={roleColor}
                onChange={(event) => {
                  const nextRoles = [...preview.customRoles] as [string | null, string | null, string | null, string | null];
                  nextRoles[index] = event.target.value.toUpperCase();
                  commit({ customRoles: nextRoles }, `${role} role color updated in the renderer preview.`);
                }}
                aria-label={`${role} role color`}
              />
              <code>HEX {roleColor}</code>
            </label>
          );
        })}
        <button
          type="button"
          className="button button--ghost appearance-preview-deck__role-reset"
          onClick={() => commit({ customRoles: [null, null, null, null] }, "Role colors reset to the selected palette in the renderer preview.")}
          disabled={preview.customRoles.every((color) => color === null)}
        >
          Reset role colors
        </button>
      </div>

      <PaletteHarmonyLab
        seedColor={roleColors[0]}
        onApply={(colors) => {
          commit(
            { customAccent: null, customRoles: [...colors] as AppearancePreview["customRoles"] },
            "Harmony recipe applied to all four role colors in the renderer preview.",
          );
        }}
      />

      <div className={`appearance-preview-deck__sample appearance-preview-deck__sample--${preview.energy} appearance-preview-deck__sample--${preview.surface} appearance-preview-deck__sample--${preview.geometry} appearance-preview-deck__sample--${preview.signal}`} style={sampleStyle} aria-label="Appearance palette sample">
        <div className="appearance-preview-deck__sample-sidebar"><span /><span /><span /><span /></div>
        <div className="appearance-preview-deck__sample-main">
          <div className="appearance-preview-deck__sample-header"><span className="appearance-preview-deck__sample-brand"><span className="appearance-preview-deck__sample-logo" style={{ color: logo.accent }}><LogoMark logo={logo} /></span>Omnia / research</span><i>Logo {logo.index} · Preview</i></div>
          <div className="appearance-preview-deck__sample-grid"><article><small>Primary</small><strong>{roleColors[0]}</strong></article><article><small>Support</small><strong>{roleColors[1]}</strong></article><article><small>Alert</small><strong>{roleColors[2]}</strong></article><article><small>Focus</small><strong>{roleColors[3]}</strong></article></div>
        </div>
      </div>

      <ThemeLabPreview roleColors={roleColors} surface={preview.surface} />

      <AppearanceTokenLab roleColors={roleColors} surface={preview.surface} />

      <div className="appearance-preview-deck__export-row">
        <span><strong>Portable palette preview</strong><small>Inspect or share the proposed palette before any durable preferences are connected.</small></span>
        <input ref={importInputRef} type="file" accept=".json,application/json" hidden aria-label="Import appearance preview JSON" onChange={(event) => void importPreview(event)} />
        <button type="button" className="button button--ghost" onClick={() => importInputRef.current?.click()}>Import JSON</button>
        <button type="button" className="button button--secondary" onClick={() => setExportOpen((value) => !value)} aria-expanded={exportOpen} aria-controls="appearance-preview-export">{exportOpen ? "Hide export" : "Preview export"}</button>
      </div>

      {exportOpen ? (
        <section id="appearance-preview-export" className="appearance-preview-deck__export" aria-label="Appearance export preview">
          <div className="appearance-preview-deck__export-toolbar" role="toolbar" aria-label="Appearance export preview actions">
            <label><span>Format</span><select value={exportFormat} onChange={(event) => setExportFormat(event.target.value as AppearanceExportFormat)} aria-label="Appearance export format"><option value="json">JSON</option><option value="markdown">Markdown</option><option value="css">CSS tokens</option></select></label>
            <span role="status" aria-live="polite">{exportStatus}</span>
            <button type="button" className="button button--ghost" onClick={() => void copyPreview()}><Clipboard size={14} /> Copy</button>
            <button type="button" className="button button--secondary" onClick={downloadPreview}><Download size={14} /> Download</button>
          </div>
          <pre tabIndex={0}><code>{payload}</code></pre>
          <p>Renderer-local palette preview only. It does not alter global design tokens, native preferences, or durable profile settings.</p>
        </section>
      ) : null}
    </section>
  );
}
