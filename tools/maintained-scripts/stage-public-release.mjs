import fs from "node:fs";
import path from "node:path";

const source = path.resolve(".");
const destination = path.resolve("..", "omnia-public");
const files = [
  ".editorconfig", ".env.example", ".gitignore", "index.html", "package.json", "package-lock.json",
  "playwright.visual.config.ts", "README.md", "tsconfig.app.json", "tsconfig.context-c0.json", "tsconfig.json",
  "tsconfig.node.json", "vite.config.ts", "omnia.code-workspace",
];
const directories = [".github", "design", "docs", "scripts", "src", "src-tauri", "tests"];
const ignored = new Set(["target", "target-ide", "node_modules", ".git", ".pytest_cache", ".pytest-cache"]);

fs.rmSync(destination, { recursive: true, force: true });
fs.mkdirSync(destination, { recursive: true });
for (const file of files) {
  const from = path.join(source, file);
  if (fs.existsSync(from)) fs.cpSync(from, path.join(destination, file), { recursive: true });
}
for (const directory of directories) {
  const from = path.join(source, directory);
  if (!fs.existsSync(from)) continue;
  fs.cpSync(from, path.join(destination, directory), {
    recursive: true,
    filter: (entry) => ![...ignored].some((part) => entry.split(path.sep).includes(part)),
  });
}
console.log(`Staged public release at ${destination}`);
