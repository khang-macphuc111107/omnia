export type ThemeLabSurface = "graphite" | "slate" | "ink";

export type ThemeLabVision =
  | "default"
  | "high-contrast"
  | "protanopia"
  | "deuteranopia"
  | "tritanopia";

export type ThemeLabRole = "primary" | "support" | "alert" | "focus";

export interface ThemeLabColorCheck {
  role: ThemeLabRole;
  label: string;
  sourceColor: string;
  displayColor: string;
  contrast: number;
  grade: "AAA" | "AA" | "UI" | "Review";
  passesText: boolean;
  passesUi: boolean;
}

export interface ThemeLabSnapshot {
  surface: ThemeLabSurface;
  surfaceColor: string;
  vision: ThemeLabVision;
  checks: readonly ThemeLabColorCheck[];
  uniqueHueCount: number;
  chromaSpread: number;
  diversityLabel: "Focused" | "Balanced" | "Expressive";
  passingChecks: number;
  recommendation: string;
}

const SURFACE_COLORS: Record<ThemeLabSurface, string> = {
  graphite: "#111923",
  slate: "#17212B",
  ink: "#0B1017",
};

const ROLE_METADATA: readonly { role: ThemeLabRole; label: string }[] = [
  { role: "primary", label: "Primary" },
  { role: "support", label: "Support" },
  { role: "alert", label: "Alert" },
  { role: "focus", label: "Focus" },
];

type Rgb = { r: number; g: number; b: number };

function clamp(value: number, minimum = 0, maximum = 255): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function parseHex(value: string): Rgb {
  const normalized = value.trim().replace(/^#/, "");
  if (!/^[0-9a-f]{6}$/i.test(normalized)) return { r: 128, g: 128, b: 128 };
  return {
    r: Number.parseInt(normalized.slice(0, 2), 16),
    g: Number.parseInt(normalized.slice(2, 4), 16),
    b: Number.parseInt(normalized.slice(4, 6), 16),
  };
}

function toHex(rgb: Rgb): string {
  return `#${[rgb.r, rgb.g, rgb.b]
    .map((channel) => clamp(Math.round(channel)).toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase()}`;
}

function srgbToLinear(channel: number): number {
  const normalized = channel / 255;
  return normalized <= 0.04045
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex: string): number {
  const rgb = parseHex(hex);
  return 0.2126 * srgbToLinear(rgb.r)
    + 0.7152 * srgbToLinear(rgb.g)
    + 0.0722 * srgbToLinear(rgb.b);
}

export function contrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function rgbToHsl(rgb: Rgb): { hue: number; saturation: number; lightness: number } {
  const r = rgb.r / 255;
  const g = rgb.g / 255;
  const b = rgb.b / 255;
  const maximum = Math.max(r, g, b);
  const minimum = Math.min(r, g, b);
  const delta = maximum - minimum;
  const lightness = (maximum + minimum) / 2;
  if (delta === 0) return { hue: 0, saturation: 0, lightness };

  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  let hue = 0;
  if (maximum === r) hue = 60 * (((g - b) / delta) % 6);
  else if (maximum === g) hue = 60 * ((b - r) / delta + 2);
  else hue = 60 * ((r - g) / delta + 4);
  return { hue: hue < 0 ? hue + 360 : hue, saturation, lightness };
}

function simulateVision(hex: string, vision: ThemeLabVision): string {
  if (vision === "default") return hex.toUpperCase();
  const { r, g, b } = parseHex(hex);
  if (vision === "high-contrast") {
    return relativeLuminance(hex) > 0.42 ? "#FFFFFF" : "#38BDF8";
  }

  // These matrices are deliberately labelled a visual approximation in the
  // UI; they are useful for a quick renderer preview, not a clinical test.
  const matrix: Record<Exclude<ThemeLabVision, "default" | "high-contrast">, readonly number[]> = {
    protanopia: [0.567, 0.433, 0, 0.558, 0.442, 0, 0, 0.242, 0.758],
    deuteranopia: [0.625, 0.375, 0, 0.7, 0.3, 0, 0, 0.3, 0.7],
    tritanopia: [0.95, 0.05, 0, 0, 0.433, 0.567, 0, 0.475, 0.525],
  };
  const transform = matrix[vision];
  return toHex({
    r: transform[0]! * r + transform[1]! * g + transform[2]! * b,
    g: transform[3]! * r + transform[4]! * g + transform[5]! * b,
    b: transform[6]! * r + transform[7]! * g + transform[8]! * b,
  });
}

function gradeContrast(ratio: number): ThemeLabColorCheck["grade"] {
  if (ratio >= 7) return "AAA";
  if (ratio >= 4.5) return "AA";
  if (ratio >= 3) return "UI";
  return "Review";
}

export function visionLabel(vision: ThemeLabVision): string {
  switch (vision) {
    case "high-contrast": return "High contrast simulation";
    case "protanopia": return "Protanopia simulation";
    case "deuteranopia": return "Deuteranopia simulation";
    case "tritanopia": return "Tritanopia simulation";
    default: return "Default signal view";
  }
}

export function buildThemeLabSnapshot(
  roleColors: readonly [string, string, string, string],
  surface: ThemeLabSurface,
  vision: ThemeLabVision = "default",
): ThemeLabSnapshot {
  const surfaceColor = SURFACE_COLORS[surface];
  const checks = ROLE_METADATA.map(({ role, label }, index) => {
    const sourceColor = roleColors[index] ?? "#808080";
    const displayColor = simulateVision(sourceColor, vision);
    const contrast = contrastRatio(displayColor, surfaceColor);
    return {
      role,
      label,
      sourceColor: sourceColor.toUpperCase(),
      displayColor,
      contrast,
      grade: gradeContrast(contrast),
      passesText: contrast >= 4.5,
      passesUi: contrast >= 3,
    } satisfies ThemeLabColorCheck;
  });

  const hslValues = roleColors.map((color) => rgbToHsl(parseHex(color)));
  const hueBuckets = new Set(hslValues
    .filter((value) => value.saturation >= 0.15)
    .map((value) => Math.round(value.hue / 24)));
  const saturations = hslValues.map((value) => value.saturation);
  const chromaSpread = Math.round((Math.max(...saturations) - Math.min(...saturations)) * 100);
  const uniqueHueCount = hueBuckets.size;
  const diversityLabel = uniqueHueCount >= 4 || chromaSpread >= 48
    ? "Expressive"
    : uniqueHueCount >= 2 || chromaSpread >= 22
      ? "Balanced"
      : "Focused";
  const passingChecks = checks.filter((check) => check.passesText).length;
  const recommendation = passingChecks === checks.length
    ? `${diversityLabel} spectrum with text-safe signal contrast on ${surface}.`
    : `${diversityLabel} spectrum; tune ${checks.filter((check) => !check.passesText).map((check) => check.label.toLowerCase()).join(", ")} before shipping.`;

  return {
    surface,
    surfaceColor,
    vision,
    checks,
    uniqueHueCount,
    chromaSpread,
    diversityLabel,
    passingChecks,
    recommendation,
  };
}

export function themeLabSurfaceLabel(surface: ThemeLabSurface): string {
  return surface[0]!.toUpperCase() + surface.slice(1);
}

