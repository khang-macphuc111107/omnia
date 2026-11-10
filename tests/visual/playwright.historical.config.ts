import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";

import current from "../../playwright.visual.config";

if (!process.env.OMNIA_VISUAL_BASE_URL) {
  throw new Error("Set OMNIA_VISUAL_BASE_URL to the matching historical renderer/fixture host. The current src/rebuild app does not implement retired UI routes.");
}

export default defineConfig({
  ...current,
  testDir: fileURLToPath(new URL("./", import.meta.url)),
  testMatch: [
    "accessibility-matrix.spec.ts",
    "agent-shell-release.spec.ts",
    "full-window-workbenches.spec.ts",
    "shell-host-overflow.spec.ts",
    "visual-fixture-contract.spec.ts",
    "visual-regression.spec.ts",
  ],
  // Snapshot paths must keep resolving to the existing historical baselines.
  snapshotDir: fileURLToPath(new URL("./__screenshots__", import.meta.url)),
  outputDir: fileURLToPath(new URL("../../artifacts/visual/historical/test-results", import.meta.url)),
  webServer: undefined,
  metadata: { evidenceScope: "historical-renderer-fixture; not current original renderer" },
});
