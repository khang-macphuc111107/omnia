#!/usr/bin/env node

/**
 * Check the renderer/native Tauri command boundary without requiring Rust.
 *
 * Scan every production renderer module, including the agent API wrappers.
 * This check catches a common integration failure where a bridge
 * method is added before its native command is registered in
 * `tauri::generate_handler!`, or where a registered command no longer has a
 * production `#[tauri::command]` function.  It is static evidence only: the
 * Rust compiler and a packaged Windows runtime remain authoritative.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const rendererRoot = path.join(root, "src");
const nativeRoot = path.join(root, "src-tauri", "src");
const libPath = path.join(nativeRoot, "lib.rs");

function fail(message) {
  throw new Error(message);
}

function unique(values) {
  return [...new Set(values)].sort();
}

function difference(left, right) {
  const rightSet = new Set(right);
  return left.filter((value) => !rightSet.has(value));
}

function parseRendererCommands(source) {
  // Include both session-guarded application calls and the two pre-session
  // bootstrap calls (`runtime_info` and `core_initialize`).
  const commands = [];
  const pattern = /\binvoke(?:Core)?(?:\s*<[^;()]*?>)?\s*\(\s*["']([^"']+)["']/g;
  for (const match of source.matchAll(pattern)) commands.push(match[1]);
  return unique(commands);
}

function parseRegisteredCommands(source) {
  const handler = source.match(/tauri::generate_handler!\s*\[([\s\S]*?)\n\s*\]\s*\n/);
  if (!handler) fail("src-tauri/src/lib.rs is missing the core generate_handler block");

  const commands = [];
  for (const line of handler[1].split("\n")) {
    const withoutComment = line.replace(/\/\/.*$/, "").trim().replace(/,$/, "").trim();
    if (!withoutComment) continue;
    const match = withoutComment.match(/^(?:[A-Za-z_]\w*::)*([A-Za-z_]\w*)$/);
    if (!match) fail(`Unable to parse registered Tauri command entry: ${withoutComment}`);
    commands.push(match[1]);
  }
  return unique(commands);
}

function parseNativeCommands(sources) {
  const commands = [];
  // `ipc_session.rs` contains test-only command fixtures; it is deliberately
  // excluded so those names cannot be mistaken for production commands.
  for (const [relativePath, source] of sources) {
    if (relativePath === "ipc_session.rs") continue;
    const pattern = /#\s*\[\s*tauri::command(?:\s*\([^\]]*\))?\s*\][\s\r\n]*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/g;
    for (const match of source.matchAll(pattern)) commands.push(match[1]);
  }
  return unique(commands);
}

async function readNativeSources() {
  // Keep this discovery-based rather than maintaining a second hand-written
  // list whenever a new native capability module is added. Node 22's
  // recursive `readdir` is available in the supported runtime declared by
  // package.json. Test-only command fixtures stay excluded explicitly below.
  const entries = await readdir(nativeRoot, { withFileTypes: true, recursive: true });
  const sourceFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".rs"))
    .map((entry) => path.join(entry.parentPath ?? nativeRoot, entry.name))
    .filter((filePath) => !filePath.endsWith("ipc_session.rs"))
    .filter((filePath) => !filePath.endsWith("native_test_harness.rs"))
    .filter((filePath) => !filePath.endsWith("provider_fault_harness.rs"));

  return Promise.all(sourceFiles.map(async (filePath) => [
    path.relative(nativeRoot, filePath),
    await readFile(filePath, "utf8"),
  ]));
}

async function readRendererSources() {
  const entries = await readdir(rendererRoot, { withFileTypes: true, recursive: true });
  const files = entries
    .filter((entry) => entry.isFile() && /\.[cm]?[jt]sx?$/.test(entry.name))
    .filter((entry) => !/\.(?:test|spec)\./.test(entry.name))
    .map((entry) => path.join(entry.parentPath ?? rendererRoot, entry.name));
  return Promise.all(files.map((file) => readFile(file, "utf8")));
}

try {
  const [rendererSources, lib, nativeSources] = await Promise.all([
    readRendererSources(),
    readFile(libPath, "utf8"),
    readNativeSources(),
  ]);

  const renderer = unique(rendererSources.flatMap(parseRendererCommands));
  const registered = parseRegisteredCommands(lib);
  const native = parseNativeCommands(nativeSources);
  const missingRegistration = difference(renderer, registered);
  const missingDefinition = difference(registered, native);
  const unregisteredNative = difference(native, registered);

  if (missingRegistration.length || missingDefinition.length || unregisteredNative.length) {
    const details = [
      missingRegistration.length
        ? `renderer commands missing from generate_handler: ${missingRegistration.join(", ")}`
        : null,
      missingDefinition.length
        ? `registered commands missing production #[tauri::command] definition: ${missingDefinition.join(", ")}`
        : null,
      unregisteredNative.length
        ? `native #[tauri::command] definitions missing from generate_handler: ${unregisteredNative.join(", ")}`
        : null,
    ].filter(Boolean).join("; ");
    fail(details);
  }

  process.stdout.write(
    `Tauri command parity OK: ${renderer.length} renderer calls, ` +
      `${registered.length} registered commands, ${native.length} production command definitions.\n`,
  );
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Tauri command parity check failed: ${reason}\n`);
  process.exitCode = 1;
}
