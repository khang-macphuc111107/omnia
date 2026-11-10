import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const sourcePath = path.join(repositoryRoot, "docs", "ui", "design-tokens.json");
const cssOutputPath = path.join(repositoryRoot, "src", "styles", "tokens.generated.css");
const typescriptOutputPath = path.join(repositoryRoot, "src", "design-system", "tokens.generated.ts");

const CHECK_MODE = process.argv.includes("--check");

function tokenValue(token, tokenPath) {
  if (!token || typeof token !== "object" || !("$value" in token)) {
    throw new Error(`Missing token value at ${tokenPath}.`);
  }
  return token.$value;
}

function requireString(token, tokenPath) {
  const value = tokenValue(token, tokenPath);
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Expected a non-empty string token at ${tokenPath}.`);
  }
  return value;
}

function requireNumber(token, tokenPath) {
  const value = tokenValue(token, tokenPath);
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Expected a finite number token at ${tokenPath}.`);
  }
  return value;
}

function cssFamily(token, tokenPath) {
  const value = tokenValue(token, tokenPath);
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string")) {
    throw new Error(`Expected a non-empty font family array at ${tokenPath}.`);
  }
  return value.map((item) => (item.includes(" ") ? `"${item}"` : item)).join(", ");
}

function dimensionPixels(token, tokenPath) {
  const value = requireString(token, tokenPath);
  const match = /^(\d+(?:\.\d+)?)px$/.exec(value);
  if (!match) throw new Error(`Expected a pixel dimension at ${tokenPath}, received ${value}.`);
  return Number(match[1]);
}

function colorToCss(token, tokenPath) {
  const value = requireString(token, tokenPath);
  const match = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(value);
  if (!match) throw new Error(`Expected a six- or eight-digit hex color at ${tokenPath}.`);
  if (!match[2]) return `#${match[1].toLowerCase()}`;
  const [red, green, blue] = match[1].match(/.{2}/g).map((channel) => Number.parseInt(channel, 16));
  const alpha = Number((Number.parseInt(match[2], 16) / 255).toFixed(3));
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function shadowToCss(token, tokenPath) {
  const value = tokenValue(token, tokenPath);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected a shadow object at ${tokenPath}.`);
  }
  return ["offsetX", "offsetY", "blur", "spread"].map((field) => {
    const fieldValue = value[field];
    if (typeof fieldValue !== "string") throw new Error(`Missing ${field} at ${tokenPath}.`);
    return fieldValue;
  }).concat(colorToCss({ $value: value.color }, `${tokenPath}.color`)).join(" ");
}

function easingToCss(token, tokenPath) {
  const value = tokenValue(token, tokenPath);
  if (!Array.isArray(value) || value.length !== 4 || value.some((item) => typeof item !== "number")) {
    throw new Error(`Expected four numeric cubic-bezier coordinates at ${tokenPath}.`);
  }
  return `cubic-bezier(${value.join(", ")})`;
}

function themeVariables(theme) {
  const color = theme.color;
  return [
    ["canvas", color.canvas],
    ["chrome", color.chrome],
    ["surface", color.surface],
    ["surface-subtle", color.surfaceSubtle],
    ["surface-elevated", color.surfaceElevated],
    ["surface-interactive", color.surfaceInteractive],
    ["surface-interactive-strong", color.surfaceInteractiveStrong],
    ["surface-hover", color.surfaceHover],
    ["surface-selected", color.surfaceSelected],
    ["text", color.text],
    ["text-secondary", color.textSecondary],
    ["text-tertiary", color.textTertiary],
    ["text-disabled", color.textDisabled],
    ["border", color.border],
    ["border-subtle", color.borderSubtle],
    ["border-strong", color.borderStrong],
    ["brand", color.brand],
    ["brand-bright", color.brandBright],
    ["brand-hover", color.brandHover],
    ["brand-pressed", color.brandPressed],
    ["brand-muted", color.brandMuted],
    ["brand-muted-strong", color.brandMutedStrong],
    ["on-brand", color.onBrand],
    ["focus", color.focus],
    ["success", color.success],
    ["success-muted", color.successMuted],
    ["warning", color.warning],
    ["warning-muted", color.warningMuted],
    ["danger", color.danger],
    ["danger-muted", color.dangerMuted],
    ["info", color.info],
    ["info-muted", color.infoMuted],
    ["scrim", color.scrim],
    ["selection", color.selection],
  ].map(([name, token]) => `  --${name}: ${colorToCss(token, `theme.color.${name}`)};`).join("\n");
}

function generateCss(tokens) {
  const font = tokens.font;
  const size = tokens.size;
  const compactTarget = requireString(size.targetInline, "size.targetInline");
  const comfortableTarget = requireString(size.targetComfortable, "size.targetComfortable");
  const touchTarget = requireString(size.targetTouch, "size.targetTouch");
  return `/* This file is generated by scripts/generate-design-tokens.mjs. Do not edit directly. */
:root {
  --font-ui: ${cssFamily(font.family.ui, "font.family.ui")};
  --font-mono: ${cssFamily(font.family.mono, "font.family.mono")};
  --font-micro: ${requireString(font.size.micro, "font.size.micro")};
  --font-caption: ${requireString(font.size.caption, "font.size.caption")};
  --font-control: ${requireString(font.size.control, "font.size.control")};
  --font-body: ${requireString(font.size.body, "font.size.body")};
  --font-body-lg: ${requireString(font.size.bodyLarge, "font.size.bodyLarge")};
  --font-title-sm: ${requireString(font.size.titleSmall, "font.size.titleSmall")};
  --font-title: ${requireString(font.size.title, "font.size.title")};
  --font-display: ${requireString(font.size.display, "font.size.display")};
  --font-small: var(--font-micro);
  --font-secondary: var(--font-caption);

  --font-weight-regular: ${requireNumber(font.weight.regular, "font.weight.regular")};
  --font-weight-medium: ${requireNumber(font.weight.medium, "font.weight.medium")};
  --font-weight-semibold: ${requireNumber(font.weight.semibold, "font.weight.semibold")};
  --line-height-compact: ${requireNumber(font.lineHeight.compact, "font.lineHeight.compact")};
  --line-height-body: ${requireNumber(font.lineHeight.body, "font.lineHeight.body")};
  --line-height-reading: ${requireNumber(font.lineHeight.reading, "font.lineHeight.reading")};

  --space-1: ${requireString(tokens.space["1"], "space.1")};
  --space-2: ${requireString(tokens.space["2"], "space.2")};
  --space-3: ${requireString(tokens.space["3"], "space.3")};
  --space-4: ${requireString(tokens.space["4"], "space.4")};
  --space-5: ${requireString(tokens.space["5"], "space.5")};
  --space-6: ${requireString(tokens.space["6"], "space.6")};
  --space-8: ${requireString(tokens.space["8"], "space.8")};
  --space-10: ${requireString(tokens.space["10"], "space.10")};
  --space-12: ${requireString(tokens.space["12"], "space.12")};
  --space-16: ${requireString(tokens.space["16"], "space.16")};

  --radius-sm: ${requireString(tokens.radius.controlSmall, "radius.controlSmall")};
  --radius-control: ${requireString(tokens.radius.control, "radius.control")};
  --radius-surface: ${requireString(tokens.radius.surface, "radius.surface")};
  --radius-dialog: ${requireString(tokens.radius.dialog, "radius.dialog")};
  --radius-pill: ${requireString(tokens.radius.pill, "radius.pill")};

  --activity-rail-width: ${requireString(size.activityRail, "size.activityRail")};
  --titlebar-height: ${requireString(size.titlebar, "size.titlebar")};
  --status-height: ${requireString(size.status, "size.status")};
  --toolbar-height: ${requireString(size.toolbar, "size.toolbar")};
  --sidebar-width: ${requireString(size.sidebarDefault, "size.sidebarDefault")};
  --inspector-width: ${requireString(size.inspectorDefault, "size.inspectorDefault")};
  --reading-width: ${requireString(size.readingColumn, "size.readingColumn")};
  --control-height: ${requireString(size.control, "size.control")};
  --target-min: ${comfortableTarget};
  --target-inline: ${compactTarget};
  --target-comfortable: ${comfortableTarget};
  --target-touch: ${touchTarget};

  --stroke-hairline: ${requireString(tokens.stroke.hairline, "stroke.hairline")};
  --stroke-focus: ${requireString(tokens.stroke.focus, "stroke.focus")};
  --duration-instant: ${requireString(tokens.duration.instant, "duration.instant")};
  --duration-fast: ${requireString(tokens.duration.fast, "duration.fast")};
  --duration-normal: ${requireString(tokens.duration.normal, "duration.normal")};
  --duration-panel: ${requireString(tokens.duration.panel, "duration.panel")};
  --ease-standard: ${easingToCss(tokens.easing.standard, "easing.standard")};
  --ease-exit: ${easingToCss(tokens.easing.exit, "easing.exit")};
}

:root,
:root[data-theme="dark"] {
${themeVariables(tokens.theme.dark)}
  --shadow-popover-base: ${shadowToCss(tokens.elevation.dark.popover, "elevation.dark.popover")};
  --shadow-dialog-base: ${shadowToCss(tokens.elevation.dark.dialog, "elevation.dark.dialog")};
  --shadow-composer-base: ${shadowToCss(tokens.elevation.dark.composer, "elevation.dark.composer")};
}

:root[data-theme="light"] {
${themeVariables(tokens.theme.light)}
  --shadow-popover-base: ${shadowToCss(tokens.elevation.light.popover, "elevation.light.popover")};
  --shadow-dialog-base: ${shadowToCss(tokens.elevation.light.dialog, "elevation.light.dialog")};
  --shadow-composer-base: ${shadowToCss(tokens.elevation.light.composer, "elevation.light.composer")};
}

:root[data-density="compact"] {
  --control-height: ${requireString(size.controlCompact, "size.controlCompact")};
  --target-min: ${compactTarget};
}

:root[data-density="touch"] {
  --control-height: ${requireString(size.controlTouch, "size.controlTouch")};
  --target-min: ${touchTarget};
}
`;
}

function generateTypescript(tokens) {
  const breakpoints = Object.fromEntries(
    Object.entries(tokens.breakpoint).map(([name, token]) => [name, dimensionPixels(token, `breakpoint.${name}`)]),
  );
  const densityTargets = {
    compact: dimensionPixels(tokens.size.targetInline, "size.targetInline"),
    comfortable: dimensionPixels(tokens.size.targetComfortable, "size.targetComfortable"),
    touch: dimensionPixels(tokens.size.targetTouch, "size.targetTouch"),
  };
  return `/* This file is generated by scripts/generate-design-tokens.mjs. Do not edit directly. */
export const BREAKPOINTS = ${JSON.stringify(breakpoints, null, 2)} as const;

export const DENSITY_TARGETS = ${JSON.stringify(densityTargets, null, 2)} as const;

export function maxWidthMediaQuery(value: number): string {
  return \`(max-width: \${value}px)\`;
}

export const NARROW_SHELL_MEDIA_QUERY = maxWidthMediaQuery(BREAKPOINTS.compact);
`;
}

async function assertOrWrite(outputPath, content) {
  if (!CHECK_MODE) {
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, content, "utf8");
    return;
  }
  let current;
  try {
    current = await readFile(outputPath, "utf8");
  } catch {
    throw new Error(`${path.relative(repositoryRoot, outputPath)} is missing. Run npm run tokens:generate.`);
  }
  // Git may check out generated text as CRLF on Windows. Compare line endings
  // consistently while preserving every other byte-level content difference.
  if (current.replace(/\r\n/g, "\n") !== content.replace(/\r\n/g, "\n")) {
    throw new Error(`${path.relative(repositoryRoot, outputPath)} has drifted. Run npm run tokens:generate.`);
  }
}

const tokens = JSON.parse(await readFile(sourcePath, "utf8"));
await assertOrWrite(cssOutputPath, generateCss(tokens));
await assertOrWrite(typescriptOutputPath, generateTypescript(tokens));

if (CHECK_MODE) {
  process.stdout.write("Design token outputs match docs/ui/design-tokens.json.\n");
}
