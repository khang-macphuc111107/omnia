export type PaletteHarmonyMode =
  | "analogous"
  | "complementary"
  | "split-complementary"
  | "triadic"
  | "monochrome";

export type PaletteHarmonyTemperature = "cool" | "balanced" | "warm";

export type PaletteHarmonySnapshot = {
  mode: PaletteHarmonyMode;
  temperature: PaletteHarmonyTemperature;
  source: string;
  colors: readonly [string, string, string, string];
  labels: readonly [string, string, string, string];
  hueSpread: number;
  diversityLabel: "Focused" | "Balanced" | "Expressive";
  rationale: string;
};

const MODE_OFFSETS: Record<PaletteHarmonyMode, readonly [number, number, number, number]> = {
  analogous: [0, 28, -28, 56],
  complementary: [0, 180, 198, 162],
  "split-complementary": [0, 150, 210, 30],
  triadic: [0, 120, 240, 60],
  monochrome: [0, 0, 0, 0],
};

const MODE_LABELS: Record<PaletteHarmonyMode, string> = {
  analogous: "Analogous",
  complementary: "Complementary",
  "split-complementary": "Split complementary",
  triadic: "Triadic",
  monochrome: "Monochrome",
};

const TEMPERATURE_SHIFT: Record<PaletteHarmonyTemperature, number> = {
  cool: -14,
  balanced: 0,
  warm: 14,
};

const ROLE_LABELS = ["Primary", "Support", "Alert", "Focus"] as const;

type Rgb = { r: number; g: number; b: number };
type Hsl = { hue: number; saturation: number; lightness: number };

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function normalizeHue(value: number): number {
  return ((value % 360) + 360) % 360;
}

function parseHex(value: string): Rgb {
  const normalized = value.trim().replace(/^#/, "");
  if (!/^[0-9a-f]{6}$/i.test(normalized)) return { r: 35, g: 198, b: 184 };
  return {
    r: Number.parseInt(normalized.slice(0, 2), 16),
    g: Number.parseInt(normalized.slice(2, 4), 16),
    b: Number.parseInt(normalized.slice(4, 6), 16),
  };
}

function toHex({ r, g, b }: Rgb): string {
  return `#${[r, g, b].map((channel) => Math.round(Math.max(0, Math.min(255, channel))).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

function rgbToHsl({ r, g, b }: Rgb): Hsl {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const delta = maximum - minimum;
  const lightness = (maximum + minimum) / 2;
  if (delta === 0) return { hue: 0, saturation: 0, lightness };
  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  let hue = 0;
  if (maximum === red) hue = 60 * (((green - blue) / delta) % 6);
  else if (maximum === green) hue = 60 * ((blue - red) / delta + 2);
  else hue = 60 * ((red - green) / delta + 4);
  return { hue: normalizeHue(hue), saturation, lightness };
}

function hueToRgb(p: number, q: number, rawHue: number): number {
  const hue = normalizeHue(rawHue) / 360;
  if (hue < 1 / 6) return p + (q - p) * 6 * hue;
  if (hue < 1 / 2) return q;
  if (hue < 2 / 3) return p + (q - p) * (2 / 3 - hue) * 6;
  return p;
}

function hslToHex({ hue, saturation, lightness }: Hsl): string {
  if (saturation === 0) {
    const value = Math.round(lightness * 255);
    return toHex({ r: value, g: value, b: value });
  }
  const q = lightness < 0.5
    ? lightness * (1 + saturation)
    : lightness + saturation - lightness * saturation;
  const p = 2 * lightness - q;
  return toHex({
    r: hueToRgb(p, q, hue + 120) * 255,
    g: hueToRgb(p, q, hue) * 255,
    b: hueToRgb(p, q, hue - 120) * 255,
  });
}

function hueDistance(left: number, right: number): number {
  const distance = Math.abs(normalizeHue(left) - normalizeHue(right));
  return Math.min(distance, 360 - distance);
}

export function isPaletteHarmonyHex(value: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(value.trim());
}

export function paletteHarmonyModeLabel(mode: PaletteHarmonyMode): string {
  return MODE_LABELS[mode];
}

export function buildPaletteHarmonySnapshot(
  source: string,
  mode: PaletteHarmonyMode,
  temperature: PaletteHarmonyTemperature,
): PaletteHarmonySnapshot {
  const normalizedSource = isPaletteHarmonyHex(source) ? source.trim().toUpperCase() : "#23C6B8";
  const base = rgbToHsl(parseHex(normalizedSource));
  const offsets = MODE_OFFSETS[mode];
  const colors = offsets.map((offset, index) => {
    const hue = normalizeHue(base.hue + offset + TEMPERATURE_SHIFT[temperature]);
    const saturation = mode === "monochrome"
      ? clamp(Math.max(base.saturation, 0.22) - index * 0.035)
      : clamp(Math.max(base.saturation, 0.42) - index * 0.045);
    const lightness = mode === "monochrome"
      ? clamp(0.39 + index * 0.115)
      : clamp(0.48 + (index % 2 === 0 ? 0.06 : -0.02));
    return hslToHex({ hue, saturation, lightness });
  }) as [string, string, string, string];
  const hues = offsets.map((offset) => normalizeHue(base.hue + offset + TEMPERATURE_SHIFT[temperature]));
  const hueSpread = Math.round(Math.max(...hues.map((hue) => hueDistance(hue, base.hue))));
  const uniqueHueCount = new Set(hues.map((hue) => Math.round(hue / 18))).size;
  const diversityLabel = mode === "monochrome"
    ? "Focused"
    : uniqueHueCount >= 4 || hueSpread >= 150
      ? "Expressive"
      : "Balanced";
  const rationale = mode === "monochrome"
    ? "One hue family with stepped lightness keeps hierarchy calm for long coding sessions."
    : `${MODE_LABELS[mode]} spacing keeps the four roles distinct while ${temperature} temperature anchors the interface.`;
  return {
    mode,
    temperature,
    source: normalizedSource,
    colors,
    labels: ROLE_LABELS,
    hueSpread,
    diversityLabel,
    rationale,
  };
}

