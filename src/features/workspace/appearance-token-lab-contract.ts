import type { ThemeLabSurface } from "./theme-lab-preview-contract";

export type AppearanceTokenLabCategory = "all" | "signals" | "surfaces" | "text" | "borders";

export type AppearanceTokenLabToken = {
  id: string;
  label: string;
  cssName: string;
  category: Exclude<AppearanceTokenLabCategory, "all">;
  value: string;
  usage: string;
};

export type AppearanceTokenLabInput = {
  roleColors: readonly [string, string, string, string];
  surface: ThemeLabSurface;
};

const SURFACE_TOKENS: Record<ThemeLabSurface, readonly [string, string, string, string]> = {
  graphite: ["#0A111C", "#0E1726", "#17263A", "#1A2B41"],
  slate: ["#0B1421", "#142337", "#1D3150", "#233C5C"],
  ink: ["#080D14", "#0D131D", "#152131", "#1D3048"],
};

const TEXT_TOKENS: readonly [string, string, string] = ["#F4F8FF", "#C0D0E2", "#A8B9CF"];

const BORDER_TOKENS: readonly [string, string] = ["#29435E", "rgba(255, 255, 255, 0.063)"];

function normalizedColor(value: string): string {
  return value.trim().toUpperCase();
}

/**
 * Builds the semantic role map shown by the renderer-only Appearance Token Lab.
 * These values are an inspectable proposal; they never mutate the generated
 * production token source or global document styles.
 */
export function buildAppearanceTokenRows({ roleColors, surface }: AppearanceTokenLabInput): readonly AppearanceTokenLabToken[] {
  const [canvas, surfaceColor, raised, interactive] = SURFACE_TOKENS[surface];
  const [primary, support, alert, focus] = roleColors;
  return [
    { id: "accent-primary", label: "Primary signal", cssName: "--omnia-accent-primary", category: "signals", value: normalizedColor(primary), usage: "Main actions, selected navigation, and the active project marker." },
    { id: "accent-support", label: "Support signal", cssName: "--omnia-accent-support", category: "signals", value: normalizedColor(support), usage: "Secondary actions, context links, and supporting metadata." },
    { id: "accent-alert", label: "Alert signal", cssName: "--omnia-accent-alert", category: "signals", value: normalizedColor(alert), usage: "Attention states, warnings, and recoverable interruptions." },
    { id: "accent-focus", label: "Focus signal", cssName: "--omnia-accent-focus", category: "signals", value: normalizedColor(focus), usage: "Keyboard focus, active outlines, and transient emphasis." },
    { id: "canvas", label: "Canvas", cssName: "--omnia-canvas", category: "surfaces", value: canvas, usage: "Window background and the lowest visual layer." },
    { id: "surface", label: "Surface", cssName: "--omnia-surface", category: "surfaces", value: surfaceColor, usage: "Primary cards, workbench panels, and readable content wells." },
    { id: "surface-raised", label: "Raised surface", cssName: "--omnia-surface-raised", category: "surfaces", value: raised, usage: "Dialogs, inspector cards, and elevated navigation groups." },
    { id: "surface-interactive", label: "Interactive surface", cssName: "--omnia-surface-interactive", category: "surfaces", value: interactive, usage: "Hover, pressed, and control backgrounds with clear affordance." },
    { id: "text-primary", label: "Primary text", cssName: "--omnia-text-primary", category: "text", value: TEXT_TOKENS[0], usage: "Headings, command labels, and the strongest reading hierarchy." },
    { id: "text-secondary", label: "Secondary text", cssName: "--omnia-text-secondary", category: "text", value: TEXT_TOKENS[1], usage: "Body copy, metadata, and normal control labels." },
    { id: "text-tertiary", label: "Tertiary text", cssName: "--omnia-text-tertiary", category: "text", value: TEXT_TOKENS[2], usage: "Hints, timestamps, helper copy, and low-emphasis context." },
    { id: "border", label: "Strong border", cssName: "--omnia-border", category: "borders", value: BORDER_TOKENS[0], usage: "Primary separators and component boundaries." },
    { id: "border-subtle", label: "Subtle border", cssName: "--omnia-border-subtle", category: "borders", value: BORDER_TOKENS[1], usage: "Quiet grouping lines that should not compete with content." },
  ];
}

export function filterAppearanceTokenRows(
  rows: readonly AppearanceTokenLabToken[],
  category: AppearanceTokenLabCategory,
): readonly AppearanceTokenLabToken[] {
  return category === "all" ? rows : rows.filter((row) => row.category === category);
}

export function serializeAppearanceTokenMap(rows: readonly AppearanceTokenLabToken[]): string {
  return [
    ":root {",
    ...rows.map((row) => `  ${row.cssName}: ${row.value};`),
    "}",
    "",
    "/* Renderer-local Omnia appearance token proposal. */",
  ].join("\n");
}
