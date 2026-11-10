import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CollapsibleAiSteps } from "./collapsible-ai-steps";

describe("CollapsibleAiSteps", () => {
  it("puts completed thinking and command steps on separate collapsed disclosures", () => {
    render(<CollapsibleAiSteps steps={[
      { id: "thought", label: "Thought for 4s", content: "Consider the change.", status: "completed" },
      { id: "read", label: "Read src/App.tsx", content: "Read the requested file.", status: "completed" },
      { id: "edit", label: "Edited src/App.tsx (+18 -4)", content: "Updated the editor.", status: "completed" },
    ]} />);
    expect(document.querySelectorAll("details")).toHaveLength(3);
    expect(document.querySelectorAll("details[open]")).toHaveLength(0);
    fireEvent.click(screen.getByText("Thought for 4s"));
    expect(screen.getByText("Consider the change.")).toBeVisible();
    fireEvent.click(screen.getByText("Read src/App.tsx"));
    expect(screen.getByText("Consider the change.")).not.toBeVisible();
    expect(screen.getByText("Read the requested file.")).toBeVisible();
  });

  it("auto-collapses previous work and opens only the current running step", () => {
    const { rerender } = render(<CollapsibleAiSteps steps={[
      { id: "think", label: "Thinking...", content: "Thinking content", status: "running" },
      { id: "read", label: "Reading file...", content: "Read content", status: "running" },
    ]} />);
    expect(document.querySelectorAll("details[open]")).toHaveLength(1);
    expect(document.querySelector("details[open]")).toHaveAttribute("data-step-id", "read");
    fireEvent.click(screen.getByText("Thinking..."));
    expect(document.querySelector("details[open]")).toHaveAttribute("data-step-id", "read");
    rerender(<CollapsibleAiSteps steps={[
      { id: "think", label: "Thought for 3s", content: "Thinking content", status: "completed" },
      { id: "read", label: "Read src/App.tsx", content: "Read content", status: "completed" },
    ]} />);
    expect(document.querySelectorAll("details[open]")).toHaveLength(0);
  });

  it("renders no execution wrapper when there are no real steps", () => {
    const { container } = render(<CollapsibleAiSteps steps={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders color-coded file icons, highlights +add/-del diff stats, and shows numbered lines when expanded", () => {
    const { container } = render(<CollapsibleAiSteps steps={[
      { id: "read", label: "Read PRODUCT_SPEC.md (lines 1-140)", status: "completed" },
      { id: "edit", label: "Edited src/domain/run-envelope.ts (+18 -4)", status: "completed" },
    ]} />);
    expect(container.querySelectorAll(".ai-step__file-icon svg")).toHaveLength(2);
    expect(screen.getByText("+18")).toHaveClass("ai-step__diff-add");
    expect(screen.getByText("-4")).toHaveClass("ai-step__diff-del");
    fireEvent.click(screen.getByText("Edited src/domain/run-envelope.ts"));
    expect(container.querySelector(".ai-step[open] .ai-step__line-viewer")).not.toBeNull();
    expect(container.querySelector(".ai-step[open] .ai-step__code-line--add")).not.toBeNull();
    expect(container.querySelector(".ai-step[open] .ai-step__code-line--del")).not.toBeNull();
    expect(container.textContent).not.toContain("const [activeTabId");
    expect(container.textContent).toContain("inline diff not captured in step payload");
  });
});
