import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ContextManifestPreview from "./context-manifest-preview";
import { buildContextEstimate } from "./context-estimate";

describe("ContextManifestPreview", () => {
  it("updates the estimate when source toggles change", () => {
    const onMemories = vi.fn();
    render(<ContextManifestPreview projectName="Omnia" folderCount={2} instructionCount={1} memoryCount={3} skillCount={2} includeMemories onIncludeMemoriesChange={onMemories} includeSkills onIncludeSkillsChange={vi.fn()} />);
    expect(screen.getByText(/estimated tokens/i)).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/memories \(3\)/i));
    expect(onMemories).toHaveBeenCalledWith(false);
  });

  it("renders a truthful export contract", () => {
    render(<ContextManifestPreview projectName="Omnia" folderCount={1} instructionCount={1} memoryCount={0} skillCount={0} includeMemories={false} onIncludeMemoriesChange={vi.fn()} includeSkills={false} onIncludeSkillsChange={vi.fn()} />);
    const region = screen.getByRole("region", { name: /context manifest preview/i });
    expect(within(region).getByRole("code")).toHaveTextContent(/omnia\.context-manifest\.preview\.v1/);
    expect(within(region).getByText(/No file read/i)).toBeInTheDocument();
  });

  it("exports an explicit withheld estimate when context access is blocked", () => {
    render(<ContextManifestPreview projectName="Omnia" folderCount={1} instructionCount={1} memoryCount={0} skillCount={0} includeMemories={false} onIncludeMemoriesChange={vi.fn()} includeSkills={false} onIncludeSkillsChange={vi.fn()} estimate={buildContextEstimate({ estimatedTokens: 1050, projectHealth: "missing-access" })} />);
    const region = screen.getByRole("region", { name: /context manifest preview/i });
    expect(region).toHaveTextContent(/Withheld/i);
    expect(region).toHaveTextContent(/Context access is blocked/i);
    expect(within(region).getByRole("code")).toHaveTextContent('"estimatedTokens": null');
    expect(within(region).getByRole("code")).toHaveTextContent('"estimateStatus": "withheld"');
  });
});
