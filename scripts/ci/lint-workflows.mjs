#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const VERSION = "1.7.12";
const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024;
const RELEASES = Object.freeze({
  "win32-x64": {
    asset: `actionlint_${VERSION}_windows_amd64.zip`,
    sha256: "6e7241b51e6817ea6a047693d8e6fed13b31819c9a0dd6c5a726e1592d22f6e9",
    executable: "actionlint.exe",
  },
  "linux-x64": {
    asset: `actionlint_${VERSION}_linux_amd64.tar.gz`,
    sha256: "8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8",
    executable: "actionlint",
  },
});

export function selectRelease(platform = process.platform, arch = process.arch) {
  const release = RELEASES[`${platform}-${arch}`];
  if (!release) throw new Error(`Unsupported actionlint platform: ${platform}-${arch}`);
  return {
    ...release,
    version: VERSION,
    url: `https://github.com/rhysd/actionlint/releases/download/v${VERSION}/${release.asset}`,
  };
}

export function verifyArchive(bytes, release) {
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== release.sha256) throw new Error("Pinned actionlint archive checksum mismatch");
  return digest;
}

export async function downloadArchive(release, { fetchImpl = globalThis.fetch } = {}) {
  const response = await fetchImpl(release.url, {
    signal: AbortSignal.timeout(60_000),
    headers: { "User-Agent": "omnia-workflow-lint" },
  });
  if (!response.ok) throw new Error(`Actionlint download HTTP ${response.status}`);
  const advertisedLength = Number(response.headers?.get("content-length") ?? 0);
  if (advertisedLength > MAX_ARCHIVE_BYTES) throw new Error("Actionlint archive exceeds size limit");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_ARCHIVE_BYTES) throw new Error("Actionlint archive exceeds size limit");
  verifyArchive(bytes, release);
  return bytes;
}

export async function lintWorkflows({ cwd = process.cwd() } = {}) {
  const startedAt = new Date().toISOString();
  const release = selectRelease();
  const outputDir = path.join(cwd, "artifacts", "ci", "workflow-lint");
  await mkdir(outputDir, { recursive: true });
  const toolDir = await mkdtemp(path.join(os.tmpdir(), "omnia-actionlint-"));
  const archive = path.join(toolDir, release.asset);
  const bytes = await downloadArchive(release);
  await writeFile(archive, bytes);
  // Extract only the known executable from the checksum-verified release.
  // No downloaded setup script or shell command is executed.
  if (process.platform === "win32") {
    const quotePowerShell = (value) => `'${value.replaceAll("'", "''")}'`;
    await exec("pwsh", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      `Expand-Archive -LiteralPath ${quotePowerShell(archive)} -DestinationPath ${quotePowerShell(toolDir)} -Force`,
    ], { windowsHide: true, timeout: 30_000 });
  } else {
    await exec("tar", ["-xzf", archive, "-C", toolDir, release.executable], {
      windowsHide: true, timeout: 30_000,
    });
  }
  const executable = path.join(toolDir, release.executable);
  const { stdout: versionOutput } = await exec(executable, ["-version"], {
    windowsHide: true, timeout: 10_000,
  });
  if (versionOutput.trim().split(/\r?\n/u)[0] !== VERSION) {
    throw new Error("Pinned actionlint executable returned an unexpected version");
  }
  const workflows = (await readdir(path.join(cwd, ".github", "workflows")))
    .filter((name) => /\.ya?ml$/u.test(name))
    .sort()
    .map((name) => `.github/workflows/${name}`);
  if (!workflows.length) throw new Error("No workflow files found");
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  try {
    const result = await exec(executable, ["-color", ...workflows], {
      cwd, windowsHide: true, timeout: 120_000, maxBuffer: 5 * 1024 * 1024,
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    stdout = error.stdout ?? "";
    stderr = error.stderr ?? "";
    exitCode = Number.isInteger(error.code) ? error.code : 1;
  }
  await writeFile(path.join(outputDir, "actionlint.txt"), `${versionOutput}\n${stdout}${stderr}`, "utf8");
  const report = {
    schemaVersion: 1,
    result: exitCode === 0 ? "passed" : "failed",
    scope: "GitHub Actions syntax, expression and workflow semantic analysis",
    startedAt,
    recordedAt: new Date().toISOString(),
    release: { ...release, archiveBytes: bytes.length },
    command: ["actionlint", "-color", ...workflows],
    exitCode,
    limitations: [
      "Third-party action behavior, hosted-runner execution and branch protection require separate remote checks.",
      "Optional ShellCheck/Pyflakes checks run only when those tools are available; this does not replace application tests.",
      "The verified executable is retained only in the OS temporary directory for this invocation.",
    ],
  };
  await writeFile(path.join(outputDir, "receipt.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  console.log(`actionlint ${VERSION}: ${report.result}; ${workflows.length} workflows`);
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = (await lintWorkflows()).exitCode;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Workflow lint failed");
    process.exitCode = 1;
  }
}
