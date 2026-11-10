import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");

describe("right-panel narrow layout", () => {
  it.each([
    ["./diff-pane.css", ".ag-diff"],
    ["./artifacts-panel.css", ".ag-artifacts"],
    ["./agent.css", ".ag-downloads"],
  ])("%s overlays the transcript at narrow widths", (file, selector) => {
    const text = css(file);
    const media = text.slice(text.indexOf("@media (max-width: 1100px)"));
    expect(media).toContain(`${selector} {`);
    expect(media).toMatch(/position: absolute/);
  });

  it("keeps long diff and download content inside its container", () => {
    expect(css("./diff-pane.css")).toMatch(/\.ag-diff__text \{[^}]*overflow-wrap: anywhere/);
    expect(css("./agent.css")).toMatch(/\.ag-dl-media__name \{[^}]*text-overflow: ellipsis/);
  });
});
