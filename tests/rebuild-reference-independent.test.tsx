import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ReferenceWorkbench } from "../src/rebuild/reference/reference-workbench";

describe("independent reference workbench behavior", () => {
  it("closes the selected observation and allows reopening it", () => {
    render(<ReferenceWorkbench />);
    expect(screen.getByRole("complementary", { name: "Selected research observation" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close observation" }));
    expect(screen.queryByRole("complementary", { name: "Selected research observation" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Codex session continuity/u }));
    expect(screen.getByRole("complementary", { name: "Selected research observation" })).toBeInTheDocument();
  });

  it("clears search and category filters from the empty result state", () => {
    render(<ReferenceWorkbench />);
    fireEvent.change(screen.getByRole("textbox", { name: "Search observations" }), { target: { value: "no-reference-can-match-this" } });
    expect(screen.getByText("No observed contract matches this filter.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByRole("textbox", { name: "Search observations" })).toHaveValue("");
    expect(screen.queryByText("No observed contract matches this filter.")).not.toBeInTheDocument();
  });
});
