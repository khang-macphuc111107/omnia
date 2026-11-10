import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./agent-api", () => ({
  errorMessage: (cause: unknown) => String(cause),
  agentApi: {
    listProfiles: vi.fn(async () => []),
    mcpServerStatus: vi.fn(async () => null),
    pluginsList: vi.fn(async () => []),
  },
}));

import {
  applyAgentAppearance,
  normalizeAgentAppearance,
  readAgentAppearance,
  startAgentAppearance,
  writeAgentAppearance,
} from "./appearance";
import { AppearanceSection } from "./settings-dialog";

function installStorage() {
  const data = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, String(v)),
      removeItem: (k: string) => void data.delete(k),
      clear: () => data.clear(),
    },
  });
}
installStorage();

const dark = { prefersLight: false, prefersMoreContrast: false };

function root() {
  const el = document.createElement("html");
  return el;
}

beforeEach(() => {
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.contrast;
});

describe("agent appearance", () => {
  it("applies explicit Light and Dark as data-theme", () => {
    const el = root();
    applyAgentAppearance(el, { theme: "light", density: "comfortable", fontScale: 100 }, dark);
    expect(el.dataset.theme).toBe("light");
    expect(el.dataset.contrast).toBeUndefined();
    applyAgentAppearance(el, { theme: "dark", density: "comfortable", fontScale: 100 }, dark);
    expect(el.dataset.theme).toBe("dark");
  });

  it("System follows the OS scheme and increased-contrast preference", () => {
    const el = root();
    const system = { theme: "system", density: "comfortable", fontScale: 100 } as const;
    applyAgentAppearance(el, system, { prefersLight: true, prefersMoreContrast: false });
    expect(el.dataset.theme).toBe("light");
    applyAgentAppearance(el, system, { prefersLight: false, prefersMoreContrast: true });
    expect(el.dataset.theme).toBe("dark");
    expect(el.dataset.contrast).toBe("more");
  });

  it("removes a stale contrast override when the OS preference is cleared", () => {
    const el = root();
    const appearance = { theme: "light", density: "comfortable", fontScale: 100 } as const;
    applyAgentAppearance(el, appearance, { prefersLight: false, prefersMoreContrast: true });
    expect(el.dataset.theme).toBe("light");
    expect(el.dataset.contrast).toBe("more");
    applyAgentAppearance(el, appearance, dark);
    expect(el.dataset.theme).toBe("light");
    expect(el.dataset.contrast).toBeUndefined();
  });

  it("High contrast is dark with the contrast overrides", () => {
    const el = root();
    applyAgentAppearance(el, { theme: "high-contrast", density: "compact", fontScale: 110 }, { prefersLight: true, prefersMoreContrast: false });
    expect(el.dataset.theme).toBe("dark");
    expect(el.dataset.agentTheme).toBe("high-contrast");
    expect(el.dataset.contrast).toBe("more");
    expect(el.dataset.agentDensity).toBe("compact");
    expect(el.style.getPropertyValue("--ag-font-scale")).toBe("1.1");
  });

  it("normalizes unknown values and clamps the font scale", () => {
    expect(normalizeAgentAppearance({ theme: "neon", density: "x", fontScale: 400 })).toEqual({ theme: "system", density: "comfortable", fontScale: 125 });
    expect(normalizeAgentAppearance({ fontScale: 10 }).fontScale).toBe(90);
    expect(normalizeAgentAppearance({ fontScale: "big" }).fontScale).toBe(100);
  });

  it("persists and restores the selection, applying it on start", () => {
    writeAgentAppearance({ theme: "high-contrast", density: "compact", fontScale: 120 });
    expect(readAgentAppearance()).toEqual({ theme: "high-contrast", density: "compact", fontScale: 120 });
    const stop = startAgentAppearance(document.documentElement);
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.dataset.contrast).toBe("more");
    stop();
  });

  it("hot reloads OS appearance changes and detaches both subscriptions on cleanup", () => {
    const media = new Map<string, { matches: boolean; listener: (() => void) | null; addEventListener: ReturnType<typeof vi.fn>; removeEventListener: ReturnType<typeof vi.fn> }>();
    for (const query of ["(prefers-color-scheme: light)", "(prefers-contrast: more)"]) {
      const state = {
        matches: false,
        listener: null as (() => void) | null,
        addEventListener: vi.fn((_event: string, listener: () => void) => { state.listener = listener; }),
        removeEventListener: vi.fn((_event: string, listener: () => void) => { if (state.listener === listener) state.listener = null; }),
      };
      media.set(query, state);
    }
    const previous = globalThis.matchMedia;
    Object.defineProperty(globalThis, "matchMedia", { configurable: true, writable: true, value: vi.fn((query: string) => media.get(query)) });
    try {
      writeAgentAppearance({ theme: "system" });
      const stop = startAgentAppearance(document.documentElement);
      expect(document.documentElement.dataset.theme).toBe("dark");
      media.get("(prefers-color-scheme: light)")!.matches = true;
      media.get("(prefers-color-scheme: light)")!.listener?.();
      expect(document.documentElement.dataset.theme).toBe("light");
      media.get("(prefers-contrast: more)")!.matches = true;
      media.get("(prefers-contrast: more)")!.listener?.();
      expect(document.documentElement.dataset.contrast).toBe("more");
      stop();
      for (const state of media.values()) {
        expect(state.addEventListener).toHaveBeenCalledTimes(1);
        expect(state.removeEventListener).toHaveBeenCalledTimes(1);
        expect(state.listener).toBeNull();
      }
    } finally {
      Object.defineProperty(globalThis, "matchMedia", { configurable: true, writable: true, value: previous });
    }
  });

  it("the Settings selector writes the choice, persists it and sets data-theme", () => {
    render(<AppearanceSection />);
    fireEvent.change(screen.getByLabelText("Theme"), { target: { value: "light" } });
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(readAgentAppearance().theme).toBe("light");
    fireEvent.change(screen.getByLabelText("Theme"), { target: { value: "high-contrast" } });
    expect(document.documentElement.dataset.contrast).toBe("more");
    fireEvent.change(screen.getByLabelText("Density"), { target: { value: "compact" } });
    expect(document.documentElement.dataset.agentDensity).toBe("compact");
    fireEvent.change(screen.getByLabelText(/Text size/), { target: { value: "125" } });
    expect(readAgentAppearance()).toMatchObject({ theme: "high-contrast", density: "compact", fontScale: 125 });
  });
});
