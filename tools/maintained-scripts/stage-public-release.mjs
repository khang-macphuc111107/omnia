import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(
  process.env.OMNIA_WORKSPACE_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), "../.."),
);
const source = path.resolve(process.env.OMNIA_SOURCE_ROOT || workspaceRoot);
const destination = path.resolve(
  process.env.OMNIA_EXPORT_DESTINATION ||
    path.join(workspaceRoot, "artifacts", "exports", `omnia-${new Date().toISOString().replace(/[:.]/g, "-")}`),
);
const files = [
  ".editorconfig", ".env.example", ".gitignore", "index.html", "package.json", "package-lock.json",
  "playwright.visual.config.ts", "README.md", "tsconfig.app.json", "tsconfig.context-c0.json", "tsconfig.json",
  "tsconfig.node.json", "vite.config.ts", "omnia.code-workspace",
];
const directories = [".github", "design", "docs", "scripts", "src", "src-tauri", "tests"];
const ignored = new Set(["target", "target-ide", "node_modules", ".git", ".pytest_cache", ".pytest-cache"]);

if (!fs.existsSync(path.join(source, "package.json")) ||
    !fs.existsSync(path.join(source, "src-tauri", "Cargo.toml"))) {
  throw new Error(`Product source not found at ${source}; set OMNIA_SOURCE_ROOT to the reviewed source snapshot.`);
}
if (source === destination || source.startsWith(`${destination}${path.sep}`)) {
  throw new Error("Export destination must not contain the source tree.");
}
// mkdir without recursive on the leaf reserves a fresh destination. Never erase
// an existing checkout, release, or recovery snapshot to stage an export.
fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.mkdirSync(destination);
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
console.log(`Staged export at ${destination}. Review privacy, licenses, and contents before publishing.`);




