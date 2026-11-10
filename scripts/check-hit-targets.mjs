import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");

const requiredContracts = [
  { file: "src/styles/base.css", selector: ".icon-button--small", property: "width" },
  { file: "src/styles/base.css", selector: ".icon-button--tiny", property: "height" },
  { file: "src/styles/shell.css", selector: ".command-trigger", property: "min-height" },
  { file: "src/styles/shell.css", selector: ".rail-button", property: "width" },
  { file: "src/styles/shell.css", selector: ".avatar-button", property: "height" },
  { file: "src/styles/shell.css", selector: ".sidebar-search button", property: "width" },
  { file: "src/styles/shell.css", selector: ".filter-pill", property: "min-height" },
  { file: "src/styles/shell.css", selector: ".sidebar-section-label button", property: "height" },
  { file: "src/styles/chat.css", selector: ".toolbar-model-button", property: "min-height" },
  { file: "src/styles/chat.css", selector: ".user-message-actions button", property: "width" },
  { file: "src/styles/chat.css", selector: ".code-block__actions button", property: "min-height" },
  { file: "src/styles/chat.css", selector: ".composer-preflight-error button", property: "height" },
  { file: "src/styles/chat.css", selector: ".composer-attachment__actions button", property: "width" },
  { file: "src/styles/chat.css", selector: ".context-chip", property: "min-height" },
  { file: "src/styles/chat.css", selector: ".composer-tool", property: "width" },
  { file: "src/styles/chat.css", selector: ".send-button", property: "height" },
  { file: "src/styles/chat.css", selector: ".inspector-tab", property: "min-height" },
  { file: "src/styles/chat.css", selector: ".context-source-list button", property: "width" },
  { file: "src/styles/chat.css", selector: ".segmented-control button", property: "min-height" },
  { file: "src/styles/chat.css", selector: '.parameter-field input[type="range"]', property: "height" },
  { file: "src/styles/screens.css", selector: ".view-switcher button", property: "width" },
  { file: "src/styles/screens.css", selector: ".library-search > button", property: "height" },
  { file: "src/styles/screens.css", selector: ".library-segments button", property: "min-height" },
  { file: "src/styles/screens.css", selector: ".library-detail__close", property: "width" },
  { file: "src/styles/screens.css", selector: ".skill-card footer button", property: "min-height" },
  { file: "src/styles/screens.css", selector: ".mini-toggle", property: "height" },
  { file: "src/styles/screens.css", selector: ".settings-row select", property: "min-height" },
  { file: "src/styles/overlays.css", selector: ".form-stack input", property: "min-height" },
  { file: "src/styles/overlays.css", selector: ".input-inline-action", property: "width" },
  { file: "src/styles/overlays.css", selector: ".input-with-icon", property: "min-height" },
];

const cache = new Map();
const failures = [];

for (const contract of requiredContracts) {
  let source = cache.get(contract.file);
  if (!source) {
    source = await readFile(path.join(repositoryRoot, contract.file), "utf8");
    cache.set(contract.file, source);
  }

  const blocks = [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  const matchingBlocks = blocks.filter((match) =>
    match[1]
      .split(",")
      .map((selector) => selector.trim())
      .includes(contract.selector),
  );
  const property = contract.property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const declarationPattern = new RegExp(
    `(?:^|;)\\s*${property}\\s*:\\s*var\\(--target-min\\)\\s*(?:;|$)`,
    "m",
  );

  if (!matchingBlocks.some((match) => declarationPattern.test(match[2]))) {
    failures.push(`${contract.file}: ${contract.selector} must declare ${contract.property}: var(--target-min)`);
  }
}

const semanticClassContracts = [
  {
    file: "src/features/workspace/inspector.tsx",
    minimumOccurrences: 5,
  },
  {
    file: "src/features/workspace/activities/settings-screen.tsx",
    minimumOccurrences: 2,
  },
  {
    file: "src/features/workspace/dialogs.tsx",
    minimumOccurrences: 1,
  },
];

for (const contract of semanticClassContracts) {
  const source = await readFile(path.join(repositoryRoot, contract.file), "utf8");
  const occurrences = source.match(/hit-target-control/g)?.length ?? 0;
  if (occurrences < contract.minimumOccurrences) {
    failures.push(
      `${contract.file}: expected at least ${contract.minimumOccurrences} semantic hit-target-control wrappers, found ${occurrences}`,
    );
  }
}

if (failures.length > 0) {
  process.stderr.write(`Hit-target contract failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Hit-target contract OK: ${requiredContracts.length} density-bound controls and ${semanticClassContracts.length} wrapper surfaces checked.\n`,
  );
}
