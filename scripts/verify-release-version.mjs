#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

// Rebuild milestones retain the stable application version in all manifests.
// No other prerelease or build-metadata spelling is an allowed release tag.
const releaseTagPattern = /^v((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))(?:-rebuild-([0-9]{4}))?$/;

function readManifest(relativePath) {
  try {
    return readFileSync(path.resolve(relativePath), "utf8").replace(/^\uFEFF/, "");
  } catch (error) {
    throw new Error(`Cannot read ${relativePath}: ${error.message}`);
  }
}

function readJsonVersion(relativePath) {
  let manifest;
  try {
    manifest = JSON.parse(readManifest(relativePath));
  } catch (error) {
    throw new Error(`Cannot parse ${relativePath}: ${error.message}`);
  }
  if (!manifest || Array.isArray(manifest) || typeof manifest.version !== "string" || !manifest.version) {
    throw new Error(`${relativePath} must contain an explicit string version`);
  }
  return manifest.version;
}

function readCargoPackageVersion() {
  const relativePath = "src-tauri/Cargo.toml";
  let packageSections = 0;
  let inPackage = false;
  const versions = [];
  // Read only an explicit [package] version. Dependency and workspace versions
  // must never accidentally satisfy this check; Cargo validates the full TOML.
  for (const line of readManifest(relativePath).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) {
      inPackage = /^\[\s*package\s*\]\s*(?:#.*)?$/.test(trimmed);
      if (inPackage) packageSections += 1;
    } else if (inPackage && /^version\s*=/.test(trimmed)) {
      const match = /^version\s*=\s*(?:"([^"]+)"|'([^']+)')\s*(?:#.*)?$/.exec(trimmed);
      if (!match) throw new Error(`${relativePath} has an unsupported [package] version`);
      versions.push(match[1] ?? match[2]);
    }
  }
  if (packageSections !== 1 || versions.length !== 1) {
    throw new Error(`${relativePath} must contain exactly one explicit [package] version`);
  }
  return versions[0];
}

try {
  const args = process.argv.slice(2);
  if (args.length > 1) throw new Error("Usage: node scripts/verify-release-version.mjs [TAG] (or set RELEASE_TAG)");
  const tag = args[0] ?? process.env.RELEASE_TAG;
  const match = typeof tag === "string" ? releaseTagPattern.exec(tag) : null;
  // JavaScript's end anchor can match before a final newline; require the
  // complete supplied value so whitespace is never silently normalized.
  if (!match || match[0] !== tag) {
    throw new Error("Release tag must use vMAJOR.MINOR.PATCH or vMAJOR.MINOR.PATCH-rebuild-NNNN (four digits)");
  }
  const expected = match[1];
  const versions = {
    package: readJsonVersion("package.json"),
    tauri: readJsonVersion("src-tauri/tauri.conf.json"),
    cargo: readCargoPackageVersion(),
  };
  const details = Object.entries(versions).map(([name, version]) => `${name}=${version}`).join(", ");
  if (Object.values(versions).some((version) => version !== expected)) {
    throw new Error(`Tag ${tag} does not match manifest versions (${details}); expected base ${expected}`);
  }
  console.log(`Release version verified: ${tag} (${details})`);
} catch (error) {
  console.error(`Release version check failed: ${error.message}`);
  process.exitCode = 1;
}
