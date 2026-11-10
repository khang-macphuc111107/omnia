import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import process from "node:process";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const viteEntry = fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url));

const child = spawn(process.execPath, [viteEntry, "build", ...process.argv.slice(2)], {
  cwd: projectRoot,
  env: {
    ...process.env,
    OMNIA_FAST_BUILD: "true",
  },
  stdio: "inherit",
  windowsHide: false,
});

let shuttingDown = false;
const stopChild = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  if (child.exitCode === null) child.kill();
};

process.once("SIGINT", stopChild);
process.once("SIGTERM", stopChild);

child.once("error", (error) => {
  process.stderr.write(`Fast renderer build failed to start: ${error.message}\n`);
  process.exitCode = 1;
});

child.once("exit", (code, signal) => {
  if (shuttingDown && signal) {
    process.exitCode = 1;
    return;
  }
  process.exitCode = typeof code === "number" ? code : 1;
});
