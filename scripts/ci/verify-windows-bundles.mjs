#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export async function verifyWindowsBundles({ dir, revision, now = new Date() } = {}) {
  if (!dir || !/^[a-f0-9]{40}$/u.test(revision ?? "")) {
    throw new Error("A bundle directory and immutable 40-character revision are required");
  }
  const root = await realpath(dir);
  const files = [];
  for (const [format, extension] of [["msi", ".msi"], ["nsis", ".exe"]]) {
    const formatDir = path.join(root, format);
    const metadata = await lstat(formatDir);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`${format} installer directory must be a real directory`);
    }
    const resolved = await realpath(formatDir);
    if (path.dirname(resolved) !== root) throw new Error(`${format} installer directory escapes bundle root`);
    const installers = (await readdir(formatDir)).filter((name) => name.toLowerCase().endsWith(extension)).sort();
    if (!installers.length) throw new Error(`Missing required ${format} installer`);
    for (const name of installers) {
      const installerPath = path.join(formatDir, name);
      const stat = await lstat(installerPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) {
        throw new Error(`${format} installer must be a nonempty regular file`);
      }
      const bytes = await readFile(installerPath);
      files.push({
        path: `${format}/${name}`, format, bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
  }
  const report = {
    schemaVersion: 1, result: "passed", revision, recordedAt: now.toISOString(),
    scope: "Nonempty MSI and NSIS payload presence and SHA-256; installer execution/signing require separate verification",
    files,
  };
  await writeFile(path.join(root, "SHA256SUMS.txt"),
    `${files.map((file) => `${file.sha256} *${file.path}`).join("\n")}\n`, "utf8");
  await writeFile(path.join(root, "bundle-manifest.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4) throw new Error("Usage: node scripts/ci/verify-windows-bundles.mjs DIRECTORY SHA");
    console.log(JSON.stringify(await verifyWindowsBundles({ dir: process.argv[2], revision: process.argv[3] }), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Windows bundle verification failed");
    process.exitCode = 1;
  }
}
