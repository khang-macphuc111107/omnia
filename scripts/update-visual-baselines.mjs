import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const reasonFlag = process.argv.find((argument) => argument.startsWith("--reason="));
const reason = reasonFlag?.slice("--reason=".length).trim();

if (!reason || reason.length < 12) {
  process.stderr.write(
    "Visual baseline updates require --reason=\"a specific review reason\" (at least 12 characters).\n",
  );
  process.exit(2);
}

if (process.env.CI) {
  process.stderr.write("Visual baselines cannot be updated from CI.\n");
  process.exit(2);
}

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const snapshotRoot = path.join(repositoryRoot, "tests", "visual", "__screenshots__");
const evidenceRoot = path.join(repositoryRoot, "artifacts", "visual");

function runPlaywright() {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["exec", "--", "playwright", "test", "--config", "playwright.visual.config.ts", "tests/visual/visual-regression.spec.ts"],
      {
        cwd: repositoryRoot,
        env: { ...process.env, OMNIA_VISUAL_UPDATE: "1" },
        stdio: "inherit",
      },
    );
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Playwright exited with ${signal ? `signal ${signal}` : `code ${code}`}.`));
    });
  });
}

async function walkPngs(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walkPngs(absolute)));
    else if (entry.isFile() && entry.name.endsWith(".png")) files.push(absolute);
  }
  return files.sort((left, right) => left.localeCompare(right));
}

await runPlaywright();

const screenshots = await walkPngs(snapshotRoot);
const manifest = [];
for (const screenshot of screenshots) {
  const content = await readFile(screenshot);
  manifest.push({
    path: path.relative(repositoryRoot, screenshot).replaceAll(path.sep, "/"),
    bytes: content.byteLength,
    sha256: createHash("sha256").update(content).digest("hex"),
  });
}

await mkdir(evidenceRoot, { recursive: true });
const receipt = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  reason,
  platform: process.platform,
  architecture: process.arch,
  nodeVersion: process.version,
  screenshotCount: manifest.length,
  screenshots: manifest,
};
await writeFile(
  path.join(evidenceRoot, "baseline-update-receipt.json"),
  `${JSON.stringify(receipt, null, 2)}\n`,
  "utf8",
);

process.stdout.write(
  `Updated ${manifest.length} reviewed visual baseline(s). Evidence receipt: artifacts/visual/baseline-update-receipt.json\n`,
);
