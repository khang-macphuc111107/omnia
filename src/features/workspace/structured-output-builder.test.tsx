import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { StructuredOutputBuilder } from "./structured-output-builder";

describe("StructuredOutputBuilder", () => {
  it("adds a field and applies the generated schema", () => {
    let applied = "";
    render(<StructuredOutputBuilder schemaText={JSON.stringify({ type: "object", properties: {} })} onApplySchema={(value) => { applied = value; }} />);

    fireEvent.click(screen.getByRole("button", { name: "Open builder" }));
    fireEvent.click(screen.getByRole("button", { name: "Add field" }));
    expect(screen.getByRole("textbox", { name: "Field 1 name" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Field 1 name" }), { target: { value: "summary" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply to schema editor" }));
    expect(applied).toContain('"summary"');
    expect(screen.getByRole("status")).toHaveTextContent(/Applied the visual schema/i);
  });

  it("shows duplicate-name issues and prevents applying", () => {
    let applied = false;
    render(<StructuredOutputBuilder schemaText={JSON.stringify({ type: "object", properties: {} })} onApplySchema={() => { applied = true; }} />);
    fireEvent.click(screen.getByRole("button", { name: "Open builder" }));
    fireEvent.click(screen.getByRole("button", { name: "Add field" }));
    fireEvent.click(screen.getByRole("button", { name: "Add field" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Field 1 name" }), { target: { value: "same" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Field 2 name" }), { target: { value: "same" } });
    const generated = screen.getByRole("region", { name: "Structured output schema builder" });
    expect(within(generated).getByText(/Field names must be unique/i)).toBeInTheDocument();
    expect(within(generated).getByRole("button", { name: "Apply to schema editor" })).toBeDisabled();
    expect(applied).toBe(false);
  });
});
