import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const workspace = process.cwd();
const stylesDirectory = path.join(workspace, "src", "styles");
const tokenSourcePath = path.join(workspace, "docs", "ui", "design-tokens.json");
const minimumUiTextPx = 10;
const literalFontSizePattern = /font-size\s*:\s*(-?(?:\d+\.?\d*|\.\d+))px\b/g;

const entries = await readdir(stylesDirectory, { withFileTypes: true });
const cssFiles = entries
  .filter((entry) => entry.isFile() && entry.name.endsWith(".css"))
  .map((entry) => path.join(stylesDirectory, entry.name))
  .sort();

const violations = [];
const tokenViolations = [];

let microTokenSize;
try {
  const tokenDocument = JSON.parse(await readFile(tokenSourcePath, "utf8"));
  const rawMicroToken = tokenDocument?.font?.size?.micro?.$value;
  const microTokenMatch = typeof rawMicroToken === "string"
    ? /^(\d+(?:\.\d+)?)px$/.exec(rawMicroToken)
    : null;

  if (!microTokenMatch) {
    tokenViolations.push("font.size.micro must be a positive pixel dimension");
  } else {
    microTokenSize = Number.parseFloat(microTokenMatch[1]);
    if (!Number.isFinite(microTokenSize) || microTokenSize < minimumUiTextPx) {
      tokenViolations.push(
        `font.size.micro resolves to ${rawMicroToken}, below the ${minimumUiTextPx}px minimum`,
      );
    }
  }
} catch (error) {
  tokenViolations.push(
    `unable to read ${path.relative(workspace, tokenSourcePath)} (${error instanceof Error ? error.message : "invalid JSON"})`,
  );
}

for (const filePath of cssFiles) {
  const contents = await readFile(filePath, "utf8");
  const lines = contents.split(/\r?\n/);

  for (const [lineIndex, line] of lines.entries()) {
    for (const match of line.matchAll(literalFontSizePattern)) {
      const size = Number.parseFloat(match[1]);
      if (!Number.isFinite(size) || size >= minimumUiTextPx) continue;

      violations.push({
        file: path.relative(workspace, filePath),
        line: lineIndex + 1,
        size,
        source: line.trim(),
      });
    }
  }
}

if (violations.length > 0 || tokenViolations.length > 0) {
  process.stderr.write(
    `Typography gate failed: ${violations.length} literal font-size declaration(s) are below ${minimumUiTextPx}px and ${tokenViolations.length} token issue(s).\n`,
  );
  for (const violation of violations) {
    process.stderr.write(
      `- ${violation.file}:${violation.line} uses ${violation.size}px (${violation.source})\n`,
    );
  }
  for (const tokenViolation of tokenViolations) {
    process.stderr.write(`- token: ${tokenViolation}\n`);
  }
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Typography gate OK: ${cssFiles.length} stylesheet(s), no literal font-size below ${minimumUiTextPx}px; font.size.micro=${microTokenSize}px.\n`,
  );
}
