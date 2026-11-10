import { describe, expect, it } from "vitest";

import {
  buildAppearanceTokenRows,
  filterAppearanceTokenRows,
  serializeAppearanceTokenMap,
} from "./appearance-token-lab-contract";

describe("appearance token lab contract", () => {
  const input = {
    roleColors: ["#23C6B8", "#38BDF8", "#F5B94C", "#FF7A7A"] as const,
    surface: "graphite" as const,
  };

  it("builds colorful semantic signals on neutral surface layers", () => {
    const rows = buildAppearanceTokenRows(input);
    expect(rows).toHaveLength(13);
    expect(rows.slice(0, 4).map((row) => row.category)).toEqual(["signals", "signals", "signals", "signals"]);
    expect(rows.find((row) => row.cssName === "--omnia-accent-primary")?.value).toBe("#23C6B8");
    expect(rows.find((row) => row.cssName === "--omnia-canvas")?.value).toBe("#0A111C");
  });

  it("filters families without changing the source map", () => {
    const rows = buildAppearanceTokenRows(input);
    expect(filterAppearanceTokenRows(rows, "signals")).toHaveLength(4);
    expect(filterAppearanceTokenRows(rows, "surfaces")).toHaveLength(4);
    expect(filterAppearanceTokenRows(rows, "text")).toHaveLength(3);
    expect(filterAppearanceTokenRows(rows, "borders")).toHaveLength(2);
    expect(filterAppearanceTokenRows(rows, "all")).toHaveLength(rows.length);
  });

  it("serializes a portable CSS map with a renderer-only boundary", () => {
    const css = serializeAppearanceTokenMap(buildAppearanceTokenRows(input));
    expect(css).toContain("--omnia-accent-primary: #23C6B8;");
    expect(css).toContain("--omnia-surface: #0E1726;");
    expect(css).toContain("Renderer-local Omnia appearance token proposal");
  });
});
