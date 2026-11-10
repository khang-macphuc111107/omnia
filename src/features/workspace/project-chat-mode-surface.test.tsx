import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ProjectChatModeSurface } from "./project-chat-mode-surface";

describe("ProjectChatModeSurface", () => {
  it("makes Project and Chat the explicit primary choices", () => {
    render(
      <ProjectChatModeSurface
        mode="project"
        projectCount={2}
        chatCount={5}
        projectLabel="Omnia Desktop"
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("radiogroup", { name: "Project or Chat mode" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Project mode" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Chat mode" })).not.toBeChecked();
    expect(screen.getByText("Project scope selected · Chat will open inside this workspace.")).toBeInTheDocument();
    expect(screen.getByText(/Preview only/)).toBeInTheDocument();
  });

  it("emits a mode change and exposes a standalone Chat selection", () => {
    const onChange = vi.fn();
    render(
      <ProjectChatModeSurface
        mode="project"
        projectCount={0}
        chatCount={1}
        projectDisabled
        onChange={onChange}
      />,
    );

    expect(screen.getByRole("radio", { name: "Project mode" })).toBeDisabled();
    fireEvent.click(screen.getByRole("radio", { name: "Chat mode" }));
    expect(onChange).toHaveBeenCalledWith("chat");
  });
});
