import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const outputRoot = path.join(repoRoot, "artifacts", "brand-exploration-2026-09-15");
const logoDir = path.join(outputRoot, "logos");
const paletteDir = path.join(outputRoot, "palettes");
const sheetDir = path.join(outputRoot, "sheets");

for (const directory of [outputRoot, logoDir, paletteDir, sheetDir]) {
  fs.mkdirSync(directory, { recursive: true });
}

const esc = (value) => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;");

const palettes = [
  {
    id: "01-carbon-signal",
    short: "Carbon Signal",
    description: "Graphite terminal base with a clear cyan signal.",
    recommended: true,
    canvas: "#0D1117",
    surface: "#161B22",
    surfaceRaised: "#21262D",
    accent: "#2DD4D9",
    accentBright: "#67E8F9",
    accentPressed: "#16A7AE",
    success: "#47D18C",
    warning: "#F4B942",
    danger: "#F26D78",
    info: "#58A6FF",
    text: "#E6EDF3",
    textSecondary: "#9DA7B3",
    border: "#30363D",
  },
  {
    id: "02-graphite-mint",
    short: "Graphite Mint",
    description: "Calm green accent for long coding sessions.",
    recommended: true,
    canvas: "#101614",
    surface: "#18231F",
    surfaceRaised: "#22312B",
    accent: "#3BCB98",
    accentBright: "#7BE2BE",
    accentPressed: "#219A70",
    success: "#63D7A2",
    warning: "#E8BC5A",
    danger: "#F17C75",
    info: "#6BB5D8",
    text: "#E9F3EF",
    textSecondary: "#9DB3AA",
    border: "#30443B",
  },
  {
    id: "03-ink-amber",
    short: "Ink Amber",
    description: "Warm amber status light against an ink workspace.",
    canvas: "#141311",
    surface: "#211C15",
    surfaceRaised: "#30271B",
    accent: "#F2B84B",
    accentBright: "#FFD37A",
    accentPressed: "#C88922",
    success: "#6CCB8B",
    warning: "#F2B84B",
    danger: "#EA7667",
    info: "#67B7D9",
    text: "#F5EFE5",
    textSecondary: "#B8AA96",
    border: "#493D2C",
  },
  {
    id: "04-slate-sky",
    short: "Slate Sky",
    description: "Reliable blue accent familiar from developer tools.",
    canvas: "#0F1720",
    surface: "#182431",
    surfaceRaised: "#223343",
    accent: "#4FA3FF",
    accentBright: "#8CC8FF",
    accentPressed: "#2D7BC6",
    success: "#55C99A",
    warning: "#F0BC62",
    danger: "#F27984",
    info: "#4FA3FF",
    text: "#E9F2FB",
    textSecondary: "#9FB4C8",
    border: "#314456",
  },
  {
    id: "05-charcoal-coral",
    short: "Charcoal Coral",
    description: "Human, editorial warmth without neon or purple.",
    canvas: "#171415",
    surface: "#241A1B",
    surfaceRaised: "#342426",
    accent: "#F27763",
    accentBright: "#FFAD9D",
    accentPressed: "#C85649",
    success: "#63C79A",
    warning: "#E9B45B",
    danger: "#F27763",
    info: "#70B7D1",
    text: "#F7ECEA",
    textSecondary: "#BDA6A4",
    border: "#493437",
  },
  {
    id: "06-navy-lime",
    short: "Navy Lime",
    description: "High-recognition contrast for status and DAG views.",
    canvas: "#0B1421",
    surface: "#142337",
    surfaceRaised: "#1D3150",
    accent: "#B7E34A",
    accentBright: "#D9F58A",
    accentPressed: "#7DAA1E",
    success: "#75D59D",
    warning: "#F0C15E",
    danger: "#F27E7E",
    info: "#6BB6F1",
    text: "#EDF5FF",
    textSecondary: "#9DB2C9",
    border: "#2F4561",
  },
  {
    id: "07-oxide-orange",
    short: "Oxide Orange",
    description: "Confident orange for a tool that feels hands-on.",
    canvas: "#171311",
    surface: "#251B16",
    surfaceRaised: "#36271E",
    accent: "#FF8A3D",
    accentBright: "#FFC08D",
    accentPressed: "#CC6424",
    success: "#62CB8B",
    warning: "#F1B557",
    danger: "#F2766F",
    info: "#6EB9D3",
    text: "#FFF0E7",
    textSecondary: "#C2A99A",
    border: "#4B382D",
  },
  {
    id: "08-forest-aqua",
    short: "Forest Aqua",
    description: "Low-glare green-blue system for deep focus.",
    canvas: "#0E1715",
    surface: "#16251F",
    surfaceRaised: "#21352C",
    accent: "#40C4A0",
    accentBright: "#8AE8CB",
    accentPressed: "#218D70",
    success: "#6FD59A",
    warning: "#E7BB57",
    danger: "#F17B79",
    info: "#5DB7D0",
    text: "#EAF8F2",
    textSecondary: "#9DBAAF",
    border: "#2F4A3D",
  },
  {
    id: "09-stone-cobalt",
    short: "Stone Cobalt",
    description: "Light-first option with restrained blue controls.",
    recommended: true,
    canvas: "#F5F6F8",
    surface: "#FFFFFF",
    surfaceRaised: "#EEF1F5",
    accent: "#2F6FED",
    accentBright: "#5A8DF3",
    accentPressed: "#2356B7",
    success: "#18875B",
    warning: "#A66A00",
    danger: "#C74444",
    info: "#2F6FED",
    text: "#17202B",
    textSecondary: "#5F6C7B",
    border: "#D5DBE3",
  },
  {
    id: "10-paper-teal",
    short: "Paper Teal",
    description: "Bright, approachable canvas with a technical teal.",
    canvas: "#F7FAF9",
    surface: "#FFFFFF",
    surfaceRaised: "#EDF5F2",
    accent: "#0E9F91",
    accentBright: "#19BCAF",
    accentPressed: "#08766D",
    success: "#18794E",
    warning: "#9A6500",
    danger: "#C74646",
    info: "#1D78A8",
    text: "#14211F",
    textSecondary: "#5D706B",
    border: "#D1E0DB",
  },
  {
    id: "11-mono-red",
    short: "Mono Red",
    description: "Almost monochrome with one decisive action color.",
    canvas: "#121212",
    surface: "#1B1B1B",
    surfaceRaised: "#292929",
    accent: "#FF5A5F",
    accentBright: "#FF9B9F",
    accentPressed: "#C63B40",
    success: "#75C995",
    warning: "#E0B55B",
    danger: "#FF5A5F",
    info: "#7EA9C5",
    text: "#F2F2F2",
    textSecondary: "#A4A4A4",
    border: "#3A3A3A",
  },
  {
    id: "12-steel-blue",
    short: "Steel Blue",
    description: "Neutral industrial tone for a serious workspace.",
    canvas: "#11171D",
    surface: "#202A33",
    surfaceRaised: "#2D3A45",
    accent: "#7CB7D9",
    accentBright: "#B6DEEF",
    accentPressed: "#4E88A8",
    success: "#6AC995",
    warning: "#E7B65B",
    danger: "#ED7D82",
    info: "#7CB7D9",
    text: "#EEF4F7",
    textSecondary: "#A8B8C1",
    border: "#3D505C",
  },
  {
    id: "13-coffee-cyan",
    short: "Coffee Cyan",
    description: "Soft brown-black surfaces with a cool technical edge.",
    canvas: "#1B1714",
    surface: "#2A211C",
    surfaceRaised: "#3A2D25",
    accent: "#54C4C0",
    accentBright: "#9AE7E1",
    accentPressed: "#2E8E8B",
    success: "#73D19A",
    warning: "#E8B95B",
    danger: "#ED7E72",
    info: "#6FB2D2",
    text: "#F6EEE8",
    textSecondary: "#B9A99E",
    border: "#504137",
  },
  {
    id: "14-terminal-green",
    short: "Terminal Green",
    description: "Classic terminal cue, softened for everyday product UI.",
    canvas: "#0A100D",
    surface: "#101C15",
    surfaceRaised: "#1B2B20",
    accent: "#74D99B",
    accentBright: "#B2F0C7",
    accentPressed: "#3A9C63",
    success: "#74D99B",
    warning: "#E6B957",
    danger: "#F07875",
    info: "#67B7D0",
    text: "#EAF8EE",
    textSecondary: "#9FBBA8",
    border: "#2B4934",
  },
];

const logoDefs = [
  {
    id: "01-signal-aperture",
    short: "Signal Aperture",
    description: "Sharper evolution of the current aperture, with a terminal-like core.",
    recommended: true,
    render: (accent, ink) => `
      <path fill="${accent}" fill-rule="evenodd" d="M50 5 91 28.5v43L50 95 9 71.5v-43L50 5Zm0 16.5L23.5 36.7v26.6L50 78.5l26.5-15.2V36.7L50 21.5Z"/>
      <path fill="${ink}" d="m50 31 17 19-17 19-17-19 17-19Z"/>
      <path fill="${accent}" d="M50 38.5 57.5 50 50 61.5 42.5 50 50 38.5Z"/>
    `,
  },
  {
    id: "02-bracket-orbit",
    short: "Bracket Orbit",
    description: "Code brackets wrap a stable orbit: readable, familiar, not ornamental.",
    render: (accent, ink) => `
      <path fill="none" stroke="${accent}" stroke-width="9" stroke-linecap="round" stroke-linejoin="round" d="M29 13 13 25v50l16 12M71 13l16 12v50L71 87"/>
      <circle cx="50" cy="50" r="22" fill="none" stroke="${ink}" stroke-width="8"/>
      <circle cx="50" cy="50" r="6" fill="${accent}"/>
    `,
  },
  {
    id: "03-dag-nodes",
    short: "DAG Nodes",
    description: "Three connected nodes make the product's workflow identity explicit.",
    recommended: true,
    render: (accent, ink) => `
      <path fill="none" stroke="${accent}" stroke-width="8" stroke-linecap="round" d="M25 27 50 50 75 27M50 50v28"/>
      <circle cx="25" cy="27" r="12" fill="${ink}" stroke="${accent}" stroke-width="6"/>
      <circle cx="75" cy="27" r="12" fill="${ink}" stroke="${accent}" stroke-width="6"/>
      <circle cx="50" cy="78" r="12" fill="${accent}"/>
    `,
  },
  {
    id: "04-cursor-loop",
    short: "Cursor Loop",
    description: "A continuous loop with a prompt cursor: chat and action in one mark.",
    render: (accent, ink) => `
      <path fill="none" stroke="${accent}" stroke-width="9" stroke-linecap="round" stroke-dasharray="92 22" d="M50 12a38 38 0 1 1-27 11"/>
      <path fill="none" stroke="${ink}" stroke-width="8" stroke-linecap="round" stroke-linejoin="round" d="m35 39 14 11-14 11M56 61h14"/>
    `,
  },
  {
    id: "05-stack-frame",
    short: "Stack Frame",
    description: "Layered work surfaces suggest projects, context, and durable state.",
    render: (accent, ink) => `
      <rect x="17" y="24" width="56" height="42" rx="8" fill="none" stroke="${accent}" stroke-width="8"/>
      <path fill="none" stroke="${ink}" stroke-width="8" stroke-linecap="round" d="M27 76h38M27 14h38"/>
      <path fill="none" stroke="${accent}" stroke-width="6" stroke-linecap="round" d="M35 38h20M35 51h12"/>
    `,
  },
  {
    id: "06-nexus-cross",
    short: "Nexus Cross",
    description: "Four directional paths converge on a shared reasoning core.",
    render: (accent, ink) => `
      <path fill="none" stroke="${accent}" stroke-width="9" stroke-linecap="round" d="M19 19 39 39M81 19 61 39M19 81l20-20M81 81 61 61"/>
      <rect x="38" y="38" width="24" height="24" rx="7" fill="${ink}" stroke="${accent}" stroke-width="6"/>
    `,
  },
  {
    id: "07-cut-monogram",
    short: "Cut Monogram",
    description: "A compact O/N-inspired monogram with one decisive diagonal cut.",
    render: (accent, ink) => `
      <path fill="${accent}" fill-rule="evenodd" d="M50 10a40 40 0 1 0 0 80 40 40 0 0 0 0-80Zm0 15a25 25 0 1 1 0 50 25 25 0 0 1 0-50Z"/>
      <path fill="${ink}" d="m37 23 34 43-8 8-34-43 8-8Z"/>
    `,
  },
  {
    id: "08-grid-portal",
    short: "Grid Portal",
    description: "Four open corners leave room for a clear center and small-size legibility.",
    render: (accent, ink) => `
      <path fill="none" stroke="${accent}" stroke-width="8" stroke-linecap="round" d="M37 16H19v18M63 16h18v18M37 84H19V66M63 84h18V66"/>
      <circle cx="50" cy="50" r="14" fill="${ink}" stroke="${accent}" stroke-width="7"/>
      <circle cx="50" cy="50" r="4" fill="${accent}"/>
    `,
  },
  {
    id: "09-waveform-ring",
    short: "Waveform Ring",
    description: "A measured signal line inside an open ring, calm and technical.",
    render: (accent, ink) => `
      <path fill="none" stroke="${accent}" stroke-width="8" stroke-linecap="round" stroke-dasharray="190 40" d="M50 11a39 39 0 1 1-35 22"/>
      <path fill="none" stroke="${ink}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round" d="M24 52h10l6-16 9 30 7-18h13"/>
    `,
  },
  {
    id: "10-infinity-route",
    short: "Infinity Route",
    description: "A continuous route implies iteration, branching, and return paths.",
    render: (accent, ink) => `
      <path fill="none" stroke="${accent}" stroke-width="10" stroke-linecap="round" d="M18 50c0-18 23-25 32-7 9-18 32-11 32 7s-23 25-32 7c-9 18-32 11-32-7Z"/>
      <circle cx="50" cy="50" r="7" fill="${ink}"/>
    `,
  },
  {
    id: "11-chevron-core",
    short: "Chevron Core",
    description: "A forward chevron gives the mark momentum without looking like a bot badge.",
    render: (accent, ink) => `
      <path fill="${accent}" d="M50 8 89 30v40L50 92 11 70V30L50 8Z"/>
      <path fill="${ink}" fill-rule="evenodd" d="m38 28 23 22-23 22-8-8 15-14-15-14 8-8Z"/>
      <rect x="57" y="45" width="10" height="10" rx="3" fill="${accent}"/>
    `,
  },
  {
    id: "12-lens-grid",
    short: "Lens Grid",
    description: "A lens over a quiet grid suggests inspection, context, and clarity.",
    render: (accent, ink) => `
      <circle cx="44" cy="44" r="28" fill="none" stroke="${accent}" stroke-width="8"/>
      <path fill="none" stroke="${ink}" stroke-width="6" stroke-linecap="round" d="M30 44h28M44 30v28"/>
      <path fill="none" stroke="${accent}" stroke-width="9" stroke-linecap="round" d="m65 65 16 16"/>
    `,
  },
  {
    id: "13-terminal-window",
    short: "Terminal Window",
    description: "A compact shell window with a single prompt gesture.",
    render: (accent, ink) => `
      <rect x="12" y="20" width="76" height="60" rx="10" fill="none" stroke="${accent}" stroke-width="8"/>
      <circle cx="27" cy="34" r="4" fill="${accent}"/><circle cx="40" cy="34" r="4" fill="${accent}"/>
      <path fill="none" stroke="${ink}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round" d="m28 51 11 9-11 9M48 69h22"/>
    `,
  },
  {
    id: "14-constellation",
    short: "Constellation",
    description: "A sparse constellation balances human exploration with system structure.",
    render: (accent, ink) => `
      <path fill="none" stroke="${accent}" stroke-width="6" stroke-linecap="round" d="M24 66 43 28l30 18-49 20 45 0-26-38"/>
      <circle cx="24" cy="66" r="9" fill="${ink}" stroke="${accent}" stroke-width="5"/>
      <circle cx="43" cy="28" r="9" fill="${accent}"/>
      <circle cx="73" cy="46" r="9" fill="${ink}" stroke="${accent}" stroke-width="5"/>
      <circle cx="67" cy="66" r="7" fill="${accent}"/>
    `,
  },
];

const logoMark = (logo, x, y, size, accent, ink) =>
  `<g transform="translate(${x} ${y}) scale(${size / 100})">${logo.render(accent, ink)}</g>`;

const logoSvg = (logo, index) => {
  const darkAccent = palettes[0].accent;
  const darkInk = palettes[0].canvas;
  const lightAccent = palettes[8].accent;
  const lightInk = palettes[8].canvas;
  const slug = `${String(index + 1).padStart(2, "0")}-${logo.id.replace(/^\d+-/, "")}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="720" height="520" viewBox="0 0 720 520" role="img" aria-labelledby="title desc">
  <title id="title">Omnia logo option ${esc(logo.short)}</title>
  <desc id="desc">${esc(logo.description)}</desc>
  <rect width="720" height="520" rx="28" fill="#0B0E12"/>
  <rect x="24" y="24" width="672" height="290" rx="20" fill="#161B22" stroke="#30363D"/>
  ${logoMark(logo, 92, 74, 170, darkAccent, darkInk)}
  <text x="310" y="126" fill="#E6EDF3" font-family="Segoe UI, Arial, sans-serif" font-size="52" font-weight="650" letter-spacing="-1">omnia</text>
  <text x="312" y="168" fill="#9DA7B3" font-family="Segoe UI, Arial, sans-serif" font-size="18">${esc(logo.short)}</text>
  <text x="312" y="204" fill="#697586" font-family="Segoe UI, Arial, sans-serif" font-size="15">${esc(logo.description)}</text>
  <rect x="24" y="338" width="672" height="158" rx="20" fill="#FFFFFF" stroke="#D5DBE3"/>
  ${logoMark(logo, 70, 367, 104, lightAccent, "#F5F6F8")}
  <text x="218" y="416" fill="#17202B" font-family="Segoe UI, Arial, sans-serif" font-size="34" font-weight="650" letter-spacing="-.5">omnia</text>
  <text x="220" y="448" fill="#5F6C7B" font-family="Segoe UI, Arial, sans-serif" font-size="15">${esc(slug)}</text>
</svg>
`;
};

const paletteSvg = (palette, index) => {
  const slug = `${String(index + 1).padStart(2, "0")}-${palette.id.replace(/^\d+-/, "")}`;
  const swatches = [
    ["canvas", palette.canvas],
    ["surface", palette.surface],
    ["raised", palette.surfaceRaised],
    ["accent", palette.accent],
    ["bright", palette.accentBright],
    ["success", palette.success],
    ["warning", palette.warning],
    ["info", palette.info],
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="720" height="440" viewBox="0 0 720 440" role="img" aria-labelledby="title desc">
  <title id="title">Omnia palette ${esc(palette.short)}</title>
  <desc id="desc">${esc(palette.description)}</desc>
  <rect width="720" height="440" rx="28" fill="${palette.canvas}"/>
  <rect x="28" y="28" width="664" height="384" rx="22" fill="${palette.surface}" stroke="${palette.border}"/>
  <text x="58" y="82" fill="${palette.text}" font-family="Segoe UI, Arial, sans-serif" font-size="30" font-weight="650">${esc(palette.short)}</text>
  <text x="58" y="112" fill="${palette.textSecondary}" font-family="Segoe UI, Arial, sans-serif" font-size="15">${esc(palette.description)}</text>
  <rect x="58" y="143" width="604" height="74" rx="14" fill="${palette.surfaceRaised}"/>
  <rect x="78" y="164" width="28" height="28" rx="8" fill="${palette.accent}"/>
  <text x="124" y="185" fill="${palette.text}" font-family="Segoe UI, Arial, sans-serif" font-size="17" font-weight="600">Omnia workspace</text>
  <rect x="58" y="242" width="604" height="1" fill="${palette.border}"/>
  ${swatches.map(([name, color], swatchIndex) => {
    const x = 58 + (swatchIndex % 4) * 151;
    const y = 270 + Math.floor(swatchIndex / 4) * 61;
    return `<rect x="${x}" y="${y}" width="34" height="34" rx="9" fill="${color}" stroke="${palette.border}"/><text x="${x + 46}" y="${y + 14}" fill="${palette.textSecondary}" font-family="Segoe UI, Arial, sans-serif" font-size="12">${name}</text><text x="${x + 46}" y="${y + 30}" fill="${palette.text}" font-family="Cascadia Code, Consolas, monospace" font-size="11">${color}</text>`;
  }).join("\n  ")}
  <text x="58" y="398" fill="${palette.textSecondary}" font-family="Cascadia Code, Consolas, monospace" font-size="12">${esc(slug)}</text>
</svg>
`;
};

for (const [index, logo] of logoDefs.entries()) {
  const filename = `${String(index + 1).padStart(2, "0")}-${logo.id.replace(/^\d+-/, "")}.svg`;
  fs.writeFileSync(path.join(logoDir, filename), logoSvg(logo, index), "utf8");
}

for (const [index, palette] of palettes.entries()) {
  const filename = `${String(index + 1).padStart(2, "0")}-${palette.id.replace(/^\d+-/, "")}.svg`;
  fs.writeFileSync(path.join(paletteDir, filename), paletteSvg(palette, index), "utf8");
}

const logoTiles = logoDefs.map((logo, index) => {
  const filename = `logos/${String(index + 1).padStart(2, "0")}-${logo.id.replace(/^\d+-/, "")}.svg`;
  return `<article class="card logo-card"><img src="${filename}" alt="${esc(logo.short)} logo option"/><div class="card-copy"><div class="card-title"><span>${String(index + 1).padStart(2, "0")} · ${esc(logo.short)}</span>${logo.recommended ? '<span class="badge">gợi ý</span>' : ""}</div><p>${esc(logo.description)}</p><code>${filename}</code></div></article>`;
}).join("\n");

const paletteTiles = palettes.map((palette, index) => {
  const filename = `palettes/${String(index + 1).padStart(2, "0")}-${palette.id.replace(/^\d+-/, "")}.svg`;
  const swatches = [palette.canvas, palette.surface, palette.surfaceRaised, palette.accent, palette.accentBright, palette.success, palette.warning, palette.info];
  return `<article class="card palette-card"><div class="palette-preview" style="background:${palette.canvas};border-color:${palette.border}"><div class="palette-window" style="background:${palette.surface};border-color:${palette.border}"><div class="palette-dot" style="background:${palette.accent}"></div><span style="color:${palette.text}">Omnia workspace</span></div><div class="swatches">${swatches.map((color) => `<i style="background:${color};border-color:${palette.border}" title="${color}"></i>`).join("")}</div></div><div class="card-copy"><div class="card-title"><span>${String(index + 1).padStart(2, "0")} · ${esc(palette.short)}</span>${palette.recommended ? '<span class="badge">gợi ý</span>' : ""}</div><p>${esc(palette.description)}</p><code>${filename}</code><div class="hex-row">${swatches.slice(0, 5).map((color) => `<span>${color}</span>`).join(" · ")}</div></div></article>`;
}).join("\n");

const html = `<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Omnia · Brand exploration</title>
  <style>
    :root { color-scheme: dark; font-family: "Segoe UI Variable", "Segoe UI", system-ui, sans-serif; background:#0b0e12; color:#e6edf3; }
    * { box-sizing:border-box; }
    body { margin:0; background:linear-gradient(135deg,#0b0e12 0%,#10161d 55%,#0b0e12 100%); }
    main { max-width:1480px; margin:0 auto; padding:42px 34px 80px; }
    .eyebrow { color:#67e8f9; font:600 12px/1.2 "Cascadia Code",Consolas,monospace; letter-spacing:.12em; text-transform:uppercase; }
    h1 { margin:10px 0 12px; font-size:42px; letter-spacing:-.04em; }
    .lead { max-width:820px; margin:0; color:#a8b4c0; font-size:17px; line-height:1.6; }
    .notice { margin-top:22px; padding:16px 18px; border:1px solid #30404d; border-left:4px solid #2dd4d9; border-radius:12px; background:#121b22; color:#cbd6df; }
    .notice strong { color:#f2f7fa; }
    section { margin-top:46px; }
    h2 { margin:0 0 8px; font-size:26px; letter-spacing:-.025em; }
    .section-note { margin:0 0 20px; color:#8f9ca8; }
    .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(310px,1fr)); gap:18px; }
    .card { overflow:hidden; border:1px solid #2b3742; border-radius:16px; background:#141b22; box-shadow:0 12px 30px rgba(0,0,0,.16); }
    .card img { display:block; width:100%; height:auto; background:#0b0e12; }
    .card-copy { padding:15px 16px 16px; }
    .card-title { display:flex; align-items:center; justify-content:space-between; gap:10px; color:#f1f5f7; font-weight:650; }
    .card-copy p { min-height:42px; margin:8px 0 10px; color:#9ba9b5; font-size:13px; line-height:1.45; }
    code { color:#7dd3fc; font:11px/1.35 "Cascadia Code",Consolas,monospace; word-break:break-all; }
    .badge { padding:3px 7px; border:1px solid #2dd4d9; border-radius:999px; color:#8beef1; font:600 10px/1 "Cascadia Code",Consolas,monospace; text-transform:uppercase; }
    .palette-preview { padding:18px; border-bottom:1px solid; }
    .palette-window { display:flex; align-items:center; gap:10px; min-height:88px; padding:18px; border:1px solid; border-radius:12px; font-size:16px; font-weight:600; }
    .palette-dot { width:15px; height:15px; border-radius:5px; box-shadow:0 0 0 4px rgba(255,255,255,.08); }
    .swatches { display:flex; gap:7px; margin-top:14px; }
    .swatches i { width:28px; height:28px; border:1px solid; border-radius:8px; }
    .hex-row { margin-top:10px; color:#7f8d9a; font:10px/1.4 "Cascadia Code",Consolas,monospace; }
    .picks { display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:12px; margin-top:18px; }
    .pick { padding:14px 16px; border:1px solid #2d4249; border-radius:12px; background:#102027; }
    .pick strong { display:block; color:#9af2ee; }
    .pick span { display:block; margin-top:6px; color:#b7c5cc; font-size:13px; line-height:1.45; }
    footer { margin-top:54px; padding-top:20px; border-top:1px solid #27343e; color:#7e8b96; font-size:13px; line-height:1.6; }
    @media (max-width:720px) { main { padding:26px 16px 50px; } h1 { font-size:32px; } }
  </style>
</head>
<body>
  <main>
    <div class="eyebrow">OMNIA / BRAND EXPLORATION / 2026-09-15</div>
    <h1>Logo và bảng màu để chọn</h1>
    <p class="lead">Bộ này tập trung vào cảm giác quen thuộc với coder: bề mặt graphite/ink, tín hiệu cyan/green/amber/blue, hình học rõ ở kích thước nhỏ, và tránh gradient tím kiểu AI mặc định.</p>
    <div class="notice"><strong>Cách chọn:</strong> bạn chỉ cần nhắn ví dụ <code>logo 03 + palette 01</code>. Tôi sẽ đưa mark và token màu đó vào app; hiện tại chưa có phương án nào được áp tự động.</div>

    <section>
      <h2>Logo marks</h2>
      <p class="section-note">Mỗi thẻ có preview nền tối và sáng. Các file SVG gốc nằm trong thư mục <code>logos</code>.</p>
      <div class="grid">${logoTiles}</div>
    </section>

    <section>
      <h2>Bảng màu</h2>
      <p class="section-note">Mỗi palette đã tách sẵn canvas, surface, accent, trạng thái và text để áp vào design tokens.</p>
      <div class="grid">${paletteTiles}</div>
    </section>

    <section>
      <h2>Gợi ý nhanh của tôi</h2>
      <div class="picks">
        <div class="pick"><strong>Logo 03 + Palette 01</strong><span>DAG Nodes + Carbon Signal: nhận diện workflow rõ nhất và hợp với app desktop coder.</span></div>
        <div class="pick"><strong>Logo 01 + Palette 02</strong><span>Giữ chút DNA của mark hiện tại nhưng bớt “AI tím”, dịu mắt hơn khi dùng lâu.</span></div>
        <div class="pick"><strong>Logo 08 + Palette 04</strong><span>Grid Portal + Slate Sky: gọn, công cụ, rất dễ đọc ở rail 26 px.</span></div>
        <div class="pick"><strong>Logo 13 + Palette 14</strong><span>Terminal Window + Terminal Green: coder-native nhất, cá tính mạnh hơn.</span></div>
      </div>
    </section>

    <footer>Generated as deterministic SVG exploration assets for Omnia. Không thay đổi source app trong lượt này; chờ lựa chọn của bạn trước khi cập nhật logo/token.</footer>
  </main>
</body>
</html>
`;

fs.writeFileSync(path.join(outputRoot, "00-START-HERE.html"), html, "utf8");

const readme = `OMNIA BRAND EXPLORATION — 2026-09-15

Mở 00-START-HERE.html để xem toàn bộ logo và palette.

Chọn theo cú pháp: logo NN + palette NN
Ví dụ: logo 03 + palette 01

Logo gốc: logos\\
Palette gốc: palettes\\
Các file SVG là vector, không phải ảnh chụp UI. Chưa có phương án nào được áp vào app.
`;
fs.writeFileSync(path.join(outputRoot, "README.txt"), readme, "utf8");

const manifest = {
  generatedAt: "2026-09-15",
  purpose: "Omnia logo and palette exploration; preview-only until user selects.",
  logoOptions: logoDefs.map((logo, index) => ({
    number: index + 1,
    id: logo.id,
    name: logo.short,
    description: logo.description,
    recommended: Boolean(logo.recommended),
    file: `logos/${String(index + 1).padStart(2, "0")}-${logo.id.replace(/^\d+-/, "")}.svg`,
  })),
  paletteOptions: palettes.map((palette, index) => ({
    number: index + 1,
    id: palette.id,
    name: palette.short,
    description: palette.description,
    recommended: Boolean(palette.recommended),
    file: `palettes/${String(index + 1).padStart(2, "0")}-${palette.id.replace(/^\d+-/, "")}.svg`,
    tokens: {
      canvas: palette.canvas,
      surface: palette.surface,
      surfaceRaised: palette.surfaceRaised,
      accent: palette.accent,
      accentBright: palette.accentBright,
      accentPressed: palette.accentPressed,
      success: palette.success,
      warning: palette.warning,
      danger: palette.danger,
      info: palette.info,
      text: palette.text,
      textSecondary: palette.textSecondary,
      border: palette.border,
    },
  })),
};
fs.writeFileSync(path.join(outputRoot, "brand-options.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

const logoSheet = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="${Math.ceil(logoDefs.length / 4) * 380}" viewBox="0 0 1600 ${Math.ceil(logoDefs.length / 4) * 380}">
  <rect width="100%" height="100%" fill="#0B0E12"/>
  ${logoDefs.map((logo, index) => {
    const col = index % 4;
    const row = Math.floor(index / 4);
    const x = col * 400 + 20;
    const y = row * 380 + 20;
    return `<g transform="translate(${x} ${y})"><rect width="360" height="340" rx="18" fill="#161B22" stroke="#30363D"/><g transform="translate(130 24) scale(1.0)">${logo.render(palettes[0].accent, palettes[0].canvas)}</g><text x="22" y="220" fill="#E6EDF3" font-family="Segoe UI, Arial, sans-serif" font-size="21" font-weight="650">${String(index + 1).padStart(2, "0")} · ${esc(logo.short)}</text><text x="22" y="252" fill="#9DA7B3" font-family="Segoe UI, Arial, sans-serif" font-size="13">${esc(logo.description.slice(0, 46))}</text><text x="22" y="316" fill="#67E8F9" font-family="Cascadia Code, Consolas, monospace" font-size="12">${logo.recommended ? "RECOMMENDED" : "OPTION"}</text></g>`;
  }).join("\n  ")}
</svg>`;
fs.writeFileSync(path.join(sheetDir, "omnia-logo-options.svg"), logoSheet, "utf8");

const paletteSheet = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="${Math.ceil(palettes.length / 3) * 250}" viewBox="0 0 1600 ${Math.ceil(palettes.length / 3) * 250}">
  <rect width="100%" height="100%" fill="#0B0E12"/>
  ${palettes.map((palette, index) => {
    const col = index % 3;
    const row = Math.floor(index / 3);
    const x = col * 530 + 20;
    const y = row * 250 + 20;
    const swatches = [palette.canvas, palette.surface, palette.surfaceRaised, palette.accent, palette.accentBright, palette.success, palette.warning, palette.info];
    return `<g transform="translate(${x} ${y})"><rect width="490" height="210" rx="18" fill="${palette.surface}" stroke="${palette.border}"/><text x="20" y="38" fill="${palette.text}" font-family="Segoe UI, Arial, sans-serif" font-size="22" font-weight="650">${String(index + 1).padStart(2, "0")} · ${esc(palette.short)}</text><text x="20" y="65" fill="${palette.textSecondary}" font-family="Segoe UI, Arial, sans-serif" font-size="13">${esc(palette.description.slice(0, 52))}</text>${swatches.map((color, swatchIndex) => `<rect x="${20 + swatchIndex * 55}" y="98" width="42" height="42" rx="9" fill="${color}" stroke="${palette.border}"/>`).join("")}<text x="20" y="178" fill="${palette.accentBright}" font-family="Cascadia Code, Consolas, monospace" font-size="12">${palette.recommended ? "RECOMMENDED" : "OPTION"} · ${palette.accent}</text></g>`;
  }).join("\n  ")}
</svg>`;
fs.writeFileSync(path.join(sheetDir, "omnia-palette-options.svg"), paletteSheet, "utf8");

console.log(`Created brand exploration at ${outputRoot}`);
console.log(`Logos: ${logoDefs.length}; palettes: ${palettes.length}`);
