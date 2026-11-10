import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

/**
 * Split the screenshots produced by audit-actual-app-headless.mjs into small,
 * deterministic tiles.  This intentionally uses only Node built-ins so it can
 * run in a clean checkout and does not need ImageMagick, Python, or a desktop
 * browser.  The output is an evidence index rather than a replacement for DOM
 * inspection: each tile records the source coordinates and lightweight image
 * metrics that help a reviewer find blank, clipped, or suspiciously uniform
 * regions quickly.
 *
 * Usage:
 *   node scripts/crop-headless-captures.mjs \
 *     --input artifacts/headless-actual-app-2026-10-14-r2 \
 *     --output artifacts/headless-actual-app-2026-10-14-r2-crops
 *
 * Environment aliases are also supported:
 *   OMNIA_CROP_INPUT_DIR, OMNIA_CROP_OUTPUT_DIR, OMNIA_CROP_TILE_WIDTH,
 *   OMNIA_CROP_TILE_HEIGHT, OMNIA_CROP_OVERLAP, OMNIA_CROP_MAX_TILES.
 */

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultInput = path.resolve(projectRoot, "artifacts/headless-actual-app-2026-10-14-r2");
const defaultOutput = path.resolve(projectRoot, "artifacts/headless-crops-2026-10-14-r2");

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      args[key] = next;
      index += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function numberOption(value, fallback, minimum = 1) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum ? Math.floor(parsed) : fallback;
}

const args = parseArgs(process.argv);
const inputDir = path.resolve(
  args.input ?? process.env.OMNIA_CROP_INPUT_DIR ?? process.env.OMNIA_HEADLESS_OUTPUT_DIR ?? defaultInput,
);
const outputDir = path.resolve(args.output ?? process.env.OMNIA_CROP_OUTPUT_DIR ?? defaultOutput);
const tileWidth = numberOption(args.tileWidth ?? process.env.OMNIA_CROP_TILE_WIDTH, 480, 64);
const tileHeight = numberOption(args.tileHeight ?? process.env.OMNIA_CROP_TILE_HEIGHT, 300, 64);
const overlap = Math.min(
  numberOption(args.overlap ?? process.env.OMNIA_CROP_OVERLAP, 12, 0),
  Math.floor(Math.min(tileWidth, tileHeight) / 3),
);
const maxTiles = numberOption(args.maxTiles ?? process.env.OMNIA_CROP_MAX_TILES, 5000, 1);

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function u32(value) {
  return Buffer.from([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  return Buffer.concat([u32(data.length), typeBuffer, data, u32(crc32(Buffer.concat([typeBuffer, data])))]);
}

function paeth(a, b, c) {
  const estimate = a + b - c;
  const pa = Math.abs(estimate - a);
  const pb = Math.abs(estimate - b);
  const pc = Math.abs(estimate - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(pngSignature)) throw new Error("Unsupported image: PNG signature missing");
  let offset = 8;
  let width;
  let height;
  let bitDepth;
  let colorType;
  let interlace;
  const compressed = [];
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += length + 12;
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") {
      compressed.push(data);
    } else if (type === "IEND") {
      break;
    }
  }
  if (!width || !height || bitDepth !== 8 || ![2, 6].includes(colorType) || interlace !== 0) {
    throw new Error(`Unsupported PNG format (${width}x${height}, depth=${bitDepth}, color=${colorType}, interlace=${interlace})`);
  }
  const bytesPerPixel = colorType === 6 ? 4 : 3;
  const rowBytes = width * bytesPerPixel;
  const inflated = zlib.inflateSync(Buffer.concat(compressed));
  const pixels = Buffer.alloc(width * height * 4);
  let sourceOffset = 0;
  let previous = Buffer.alloc(rowBytes);
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[sourceOffset];
    sourceOffset += 1;
    const row = Buffer.from(inflated.subarray(sourceOffset, sourceOffset + rowBytes));
    sourceOffset += rowBytes;
    for (let x = 0; x < rowBytes; x += 1) {
      const left = x >= bytesPerPixel ? row[x - bytesPerPixel] : 0;
      const above = previous[x] ?? 0;
      const upperLeft = x >= bytesPerPixel ? (previous[x - bytesPerPixel] ?? 0) : 0;
      if (filter === 1) row[x] = (row[x] + left) & 0xff;
      else if (filter === 2) row[x] = (row[x] + above) & 0xff;
      else if (filter === 3) row[x] = (row[x] + Math.floor((left + above) / 2)) & 0xff;
      else if (filter === 4) row[x] = (row[x] + paeth(left, above, upperLeft)) & 0xff;
      else if (filter !== 0) throw new Error(`Unsupported PNG filter ${filter}`);
    }
    for (let x = 0; x < width; x += 1) {
      const source = x * bytesPerPixel;
      const destination = (y * width + x) * 4;
      pixels[destination] = row[source];
      pixels[destination + 1] = row[source + 1];
      pixels[destination + 2] = row[source + 2];
      pixels[destination + 3] = colorType === 6 ? row[source + 3] : 255;
    }
    previous = row;
  }
  return { width, height, pixels };
}

function encodePng(image) {
  const { width, height, pixels } = image;
  const rowBytes = width * 4;
  const raw = Buffer.alloc((rowBytes + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const destination = y * (rowBytes + 1);
    raw[destination] = 0;
    pixels.copy(raw, destination + 1, y * rowBytes, (y + 1) * rowBytes);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([pngSignature, chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 6 })), chunk("IEND", Buffer.alloc(0))]);
}

function crop(image, x, y, width, height) {
  const pixels = Buffer.alloc(width * height * 4);
  const sourceStride = image.width * 4;
  const destinationStride = width * 4;
  for (let row = 0; row < height; row += 1) {
    image.pixels.copy(
      pixels,
      row * destinationStride,
      (y + row) * sourceStride + x * 4,
      (y + row) * sourceStride + (x + width) * 4,
    );
  }
  return { width, height, pixels };
}

function colorDistance(a, b) {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) + Math.abs(a[3] - b[3]);
}

function metrics(image) {
  const { width, height, pixels } = image;
  const sampleStep = Math.max(1, Math.floor(Math.sqrt((width * height) / 12_000)));
  const corner = [pixels[0], pixels[1], pixels[2], pixels[3]];
  let samples = 0;
  let nonBackground = 0;
  let alphaPixels = 0;
  let sum = 0;
  let sumSquare = 0;
  for (let y = 0; y < height; y += sampleStep) {
    for (let x = 0; x < width; x += sampleStep) {
      const offset = (y * width + x) * 4;
      const red = pixels[offset];
      const green = pixels[offset + 1];
      const blue = pixels[offset + 2];
      const alpha = pixels[offset + 3];
      const luminance = (red * 2126 + green * 7152 + blue * 722) / 10_000;
      samples += 1;
      sum += luminance;
      sumSquare += luminance * luminance;
      if (alpha > 8) alphaPixels += 1;
      if (colorDistance([red, green, blue, alpha], corner) > 30) nonBackground += 1;
    }
  }
  const meanLuma = samples ? sum / samples : 0;
  const variance = samples ? Math.max(0, sumSquare / samples - meanLuma * meanLuma) : 0;
  const border = [];
  for (let x = 0; x < width; x += Math.max(1, Math.floor(width / 100))) {
    border.push((0 * width + x) * 4, ((height - 1) * width + x) * 4);
  }
  for (let y = 0; y < height; y += Math.max(1, Math.floor(height / 100))) {
    border.push((y * width) * 4, (y * width + width - 1) * 4);
  }
  const edgeChanged = border.filter((offset) => colorDistance([...pixels.subarray(offset, offset + 4)], corner) > 30).length;
  return {
    sampleCount: samples,
    nonBackgroundRatio: Number((nonBackground / Math.max(1, samples)).toFixed(4)),
    alphaCoverage: Number((alphaPixels / Math.max(1, samples)).toFixed(4)),
    meanLuminance: Number(meanLuma.toFixed(2)),
    luminanceVariance: Number(variance.toFixed(2)),
    borderChangeRatio: Number((edgeChanged / Math.max(1, border.length)).toFixed(4)),
    likelyBlank: nonBackground / Math.max(1, samples) < 0.01,
    likelyUniform: variance < 4,
  };
}

function safeName(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 110) || "capture";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function relativePath(filePath) {
  const candidate = path.relative(inputDir, filePath);
  // The audit report may contain the physical D: junction target while the
  // caller supplied the C: junction path. Keep the manifest portable in that
  // case by using the capture filename instead of leaking an absolute path.
  if (candidate && !candidate.startsWith("..") && !path.isAbsolute(candidate)) {
    return candidate.replaceAll(path.sep, "/");
  }
  return path.basename(filePath);
}

async function resolveInputs() {
  const reportPath = path.join(inputDir, "report.json");
  const files = new Set();
  try {
    const report = JSON.parse(await fs.readFile(reportPath, "utf8"));
    for (const capture of [...(report.desktop?.captures ?? []), ...(report.narrow?.captures ?? [])]) {
      if (!capture.path) continue;
      const candidate = path.resolve(capture.path);
      if (candidate.toLowerCase().endsWith(".png")) files.add(candidate);
    }
  } catch {
    // A directory without report.json is still a valid input; fall back to PNGs.
  }
  if (files.size === 0) {
    for (const entry of await fs.readdir(inputDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".png")) files.add(path.join(inputDir, entry.name));
    }
  }
  return [...files].sort((a, b) => a.localeCompare(b));
}

async function main() {
  await fs.mkdir(outputDir, { recursive: true });
  const inputs = await resolveInputs();
  if (inputs.length === 0) throw new Error(`No PNG captures found under ${inputDir}`);
  const manifest = {
    generatedAt: new Date().toISOString(),
    inputDir,
    outputDir,
    tile: { width: tileWidth, height: tileHeight, overlap, maxTiles },
    sourceCount: inputs.length,
    sources: [],
    tiles: [],
    warnings: [],
  };
  let tileCount = 0;
  for (const sourcePath of inputs) {
    if (tileCount >= maxTiles) {
      manifest.warnings.push(`Tile cap ${maxTiles} reached; remaining captures were skipped.`);
      break;
    }
    let image;
    try {
      image = decodePng(await fs.readFile(sourcePath));
    } catch (error) {
      manifest.warnings.push(`Skipped ${relativePath(sourcePath)}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const source = {
      path: sourcePath,
      relativePath: relativePath(sourcePath),
      width: image.width,
      height: image.height,
      tiles: [],
    };
    const stepX = Math.max(1, tileWidth - overlap);
    const stepY = Math.max(1, tileHeight - overlap);
    const columns = Math.max(1, Math.ceil(Math.max(0, image.width - overlap) / stepX));
    const rows = Math.max(1, Math.ceil(Math.max(0, image.height - overlap) / stepY));
    for (let row = 0; row < rows && tileCount < maxTiles; row += 1) {
      for (let column = 0; column < columns && tileCount < maxTiles; column += 1) {
        const x = Math.min(column * stepX, Math.max(0, image.width - tileWidth));
        const y = Math.min(row * stepY, Math.max(0, image.height - tileHeight));
        const width = Math.min(tileWidth, image.width - x);
        const height = Math.min(tileHeight, image.height - y);
        const tile = crop(image, x, y, width, height);
        const sourceStem = safeName(path.basename(sourcePath, ".png"));
        const name = `${sourceStem}--r${String(row).padStart(2, "0")}c${String(column).padStart(2, "0")}.png`;
        const outputPath = path.join(outputDir, name);
        await fs.writeFile(outputPath, encodePng(tile));
        const tileRecord = {
          id: tileCount,
          source: source.relativePath,
          output: path.relative(outputDir, outputPath).replaceAll(path.sep, "/"),
          x,
          y,
          width,
          height,
          row,
          column,
          metrics: metrics(tile),
        };
        source.tiles.push(tileRecord.output);
        manifest.tiles.push(tileRecord);
        tileCount += 1;
      }
    }
    manifest.sources.push(source);
  }
  manifest.tileCount = manifest.tiles.length;
  manifest.blankTileCount = manifest.tiles.filter((tile) => tile.metrics.likelyBlank).length;
  manifest.uniformTileCount = manifest.tiles.filter((tile) => tile.metrics.likelyUniform).length;
  await fs.writeFile(path.join(outputDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  const markdown = [
    "# Omnia headless capture crop index",
    "",
    `- Generated: ${manifest.generatedAt}`,
    `- Input: ${manifest.inputDir}`,
    `- Source captures: ${manifest.sourceCount}`,
    `- Tiles: ${manifest.tileCount}`,
    `- Tile size: ${tileWidth}×${tileHeight} (overlap ${overlap}px)` ,
    `- Likely blank tiles: ${manifest.blankTileCount}`,
    `- Likely uniform tiles: ${manifest.uniformTileCount}`,
    "",
    "Each tile keeps its source filename and pixel coordinates in `manifest.json`.",
    "Metrics are triage hints only; DOM/layout evidence remains authoritative for clipping and accessible-name findings.",
    "",
    "## Tiles needing a closer visual pass",
    "",
    ...manifest.tiles
      .filter((tile) => tile.metrics.likelyBlank || tile.metrics.likelyUniform || tile.metrics.borderChangeRatio > 0.85)
      .slice(0, 200)
      .map((tile) => `- [${tile.output}](./${tile.output}) — source \`${tile.source}\`, x=${tile.x}, y=${tile.y}, ${tile.width}×${tile.height}; blank=${tile.metrics.likelyBlank}, uniform=${tile.metrics.likelyUniform}, borderChange=${tile.metrics.borderChangeRatio}`),
    "",
    "## Warnings",
    "",
    ...(manifest.warnings.length ? manifest.warnings.map((warning) => `- ${warning}`) : ["- None"]),
  ].join("\n");
  await fs.writeFile(path.join(outputDir, "manifest.md"), markdown, "utf8");
  const tileByOutput = new Map(manifest.tiles.map((tile) => [tile.output, tile]));
  const groupedTiles = manifest.sources
    .map((source) => {
      const cards = source.tiles
        .map((tileName) => tileByOutput.get(tileName))
        .filter(Boolean)
        .map((tile) => {
          const flags = [
            tile.metrics.likelyBlank ? "blank" : "",
            tile.metrics.likelyUniform ? "uniform" : "",
            tile.metrics.borderChangeRatio > 0.85 ? "edge-change" : "",
          ].filter(Boolean);
          return `<article class="tile ${flags.join(" ")}"><a href="${escapeHtml(tile.output)}"><img loading="lazy" src="${escapeHtml(tile.output)}" alt="${escapeHtml(tile.source)} at ${tile.x},${tile.y}" /></a><div class="meta"><code>${escapeHtml(tile.output)}</code><span>${tile.width}×${tile.height} · x=${tile.x}, y=${tile.y}${flags.length ? ` · ${escapeHtml(flags.join(", "))}` : ""}</span></div></article>`;
        })
        .join("\n");
      return `<details open><summary><code>${escapeHtml(source.relativePath)}</code> · ${source.width}×${source.height} · ${source.tiles.length} tiles</summary><div class="grid">${cards}</div></details>`;
    })
    .join("\n");
  const indexHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>Omnia headless crop index</title>
<style> :root{color-scheme:dark;font-family:ui-sans-serif,system-ui,sans-serif;background:#0d1117;color:#e6edf3}body{margin:0;padding:24px;line-height:1.35}h1{margin:0 0 8px;font-size:22px}p{color:#9da7b3}details{margin:16px 0;border:1px solid #30363d;border-radius:10px;background:#161b22;overflow:hidden}summary{cursor:pointer;padding:10px 12px;position:sticky;top:0;background:#161b22;border-bottom:1px solid #30363d;z-index:1}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px;padding:12px}.tile{border:1px solid #30363d;border-radius:8px;background:#0d1117;overflow:hidden}.tile img{display:block;width:100%;aspect-ratio:16/10;object-fit:contain;background:#010409}.meta{padding:7px 8px;display:grid;gap:3px;font-size:11px;color:#8b949e}.meta code{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#c9d1d9}.tile.blank{border-color:#6e7681}.tile.uniform{outline:1px dashed #d29922}.tile.edge-change{box-shadow:inset 0 0 0 2px #f85149}</style></head>
<body><h1>Omnia headless capture crop index</h1><p>${manifest.sourceCount} source captures · ${manifest.tileCount} tiles · ${tileWidth}×${tileHeight} tiles with ${overlap}px overlap. Blank/uniform/edge markers are triage hints, not confirmed defects.</p>${groupedTiles}</body></html>`;
  await fs.writeFile(path.join(outputDir, "index.html"), indexHtml, "utf8");
  process.stdout.write(JSON.stringify({ outputDir, sourceCount: manifest.sourceCount, tileCount: manifest.tileCount, blankTileCount: manifest.blankTileCount, uniformTileCount: manifest.uniformTileCount, warnings: manifest.warnings }, null, 2));
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
