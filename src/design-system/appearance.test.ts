import { describe, expect, it } from "vitest";

import {
  applyAppearance,
  DEFAULT_APPEARANCE,
  normalizeAppearance,
  readStoredAppearance,
  resolveEffectiveTheme,
  WORKSPACE_PREFERENCE_STORAGE_KEY,
} from "./appearance";

describe("appearance bootstrap", () => {
  it("reads only allowlisted persisted appearance values", () => {
    const storage = {
      getItem: (key: string) =>
        key === WORKSPACE_PREFERENCE_STORAGE_KEY
          ? JSON.stringify({
              version: 4,
              state: {
                theme: "light",
                density: "touch",
                motion: "reduced",
                providerApiKey: "must-not-be-read",
              },
            })
          : null,
    };

    expect(readStoredAppearance(storage)).toEqual({
      theme: "light",
      density: "touch",
      motion: "reduced",
    });
  });

  it("fails closed to the default appearance for malformed storage", () => {
    expect(readStoredAppearance({ getItem: () => "not-json" })).toEqual(DEFAULT_APPEARANCE);
    expect(
      readStoredAppearance({
        getItem: () => JSON.stringify({ state: { theme: "neon", density: 0, motion: true } }),
      }),
    ).toEqual(DEFAULT_APPEARANCE);
  });

  it("resolves system theme and applies all appearance attributes before render", () => {
    const themeColor = document.createElement("meta");
    themeColor.name = "theme-color";
    document.head.append(themeColor);
    const root = document.createElement("html");
    applyAppearance(
      root,
      { theme: "system", density: "compact", motion: "reduced" },
      true,
    );

    expect(resolveEffectiveTheme("system", false)).toBe("dark");
    expect(root.dataset.theme).toBe("light");
    expect(root.dataset.density).toBe("compact");
    expect(root.dataset.motion).toBe("reduced");
    expect(root.style.colorScheme).toBe("light");
    expect(themeColor.content).toBe("#f4f7fc");
    themeColor.remove();
  });

  it("normalizes only the appearance allowlist while retaining valid sibling values", () => {
    expect(normalizeAppearance({ theme: "neon" as never, density: "touch", motion: "always" as never })).toEqual({
      theme: "system",
      density: "touch",
      motion: "system",
    });
  });
});
