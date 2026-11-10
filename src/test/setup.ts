import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Keep each jsdom test isolated when Vitest runs files in a shared worker.
// React Testing Library does not register global cleanup in every execution
// mode, so the suite owns the lifecycle explicitly.
afterEach(() => {
  cleanup();

  // Some native-session tests intentionally define this bridge property with
  // `Object.defineProperty` (whose default is non-writable). Remove the
  // descriptor between files so later tests can install their own runtime
  // fixture with ordinary assignment.
  delete window.__TAURI_INTERNALS__;
});
