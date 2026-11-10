/** A reversible, dark-only color trial. This never writes preferences or changes generated tokens. */
const PREVIEW_ROLE_PROPERTIES = [
  "--omnia-session-primary",
  "--omnia-session-primary-bright",
  "--omnia-session-on-primary",
  "--omnia-session-support",
  "--omnia-session-alert",
  "--omnia-session-focus",
] as const;

export type SessionPaletteColors = readonly [string, string, string, string];

const DARK_CANVAS = "#0A111C";

function rgb(hex: string): [number, number, number] {
  const value = hex.replace("#", "");
  return [0, 2, 4].map((index) => Number.parseInt(value.slice(index, index + 2), 16)) as [number, number, number];
}

function luminance(hex: string): number {
  const channels = rgb(hex).map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}

function contrast(first: string, second: string): number {
  const a = luminance(first);
  const b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function lighten(hex: string, fraction: number): string {
  return `#${rgb(hex).map((channel) =>
    Math.round(channel + (255 - channel) * fraction).toString(16).padStart(2, "0"),
  ).join("").toUpperCase()}`;
}

/** Lift text/focus accents when a selected palette is too dim against the dark canvas. */
export function readableDarkAccent(hex: string): string {
  const normalized = hex.toUpperCase();
  if (!/^#[0-9A-F]{6}$/.test(normalized)) throw new Error("A palette role requires a six-digit hex color.");
  if (contrast(normalized, DARK_CANVAS) >= 4.5) return normalized;
  let low = 0;
  let high = 1;
  for (let index = 0; index < 14; index += 1) {
    const middle = (low + high) / 2;
    if (contrast(lighten(normalized, middle), DARK_CANVAS) < 4.5) low = middle;
    else high = middle;
  }
  return lighten(normalized, high);
}

export function isSessionPalettePreviewActive(root: HTMLElement = document.documentElement): boolean {
  return root.dataset.omniaPreviewPalette === "active";
}

export function applySessionPalettePreview(
  colors: SessionPaletteColors,
  root: HTMLElement = document.documentElement,
): void {
  const [primary, support, alert, focus] = colors.map(readableDarkAccent);
  const bright = lighten(primary!, 0.3);
  const onPrimary = contrast(primary!, "#07111D") >= 4.5 ? "#07111D" : "#FFFFFF";
  [primary, bright, onPrimary, support, alert, focus].forEach((value, index) => {
    root.style.setProperty(PREVIEW_ROLE_PROPERTIES[index]!, value!);
  });
  // The CSS selector is dark-only; switching to light does not repaint light tokens.
  root.dataset.omniaPreviewPalette = "active";
}

export function clearSessionPalettePreview(root: HTMLElement = document.documentElement): void {
  delete root.dataset.omniaPreviewPalette;
  PREVIEW_ROLE_PROPERTIES.forEach((property) => root.style.removeProperty(property));
}
