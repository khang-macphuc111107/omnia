import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import process from "node:process";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const nodeExecutable = process.execPath;
const tscEntry = fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url));
const rendererBuild = fileURLToPath(new URL("./build-renderer-fast.mjs", import.meta.url));

const checks = [
  {
    label: "typecheck",
    args: [tscEntry, "-p", "tsconfig.app.json", "--noEmit", "--pretty", "false"],
  },
  {
    label: "renderer",
    args: [rendererBuild],
  },
];

let activeChild;
let shuttingDown = false;

function stopActiveChild() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (activeChild?.exitCode === null) activeChild.kill();
}

process.once("SIGINT", stopActiveChild);
process.once("SIGTERM", stopActiveChild);

function runCheck({ label, args }) {
  return new Promise((resolve) => {
    const child = spawn(nodeExecutable, args, {
      cwd: projectRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: false,
    });
    activeChild = child;
    const forward = (stream, writer) => {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        writer.write(String(chunk).replace(/^/gm, `[${label}] `));
      });
    };
    forward(child.stdout, process.stdout);
    forward(child.stderr, process.stderr);
    child.once("error", (error) => {
      process.stderr.write(`[${label}] failed to start: ${error.message}\n`);
      activeChild = undefined;
      resolve(1);
    });
    child.once("exit", (code, signal) => {
      activeChild = undefined;
      resolve(signal ? 1 : typeof code === "number" ? code : 1);
    });
  });
}

for (const check of checks) {
  const exitCode = await runCheck(check);
  if (exitCode !== 0) {
    process.exitCode = exitCode;
    break;
  }
}
