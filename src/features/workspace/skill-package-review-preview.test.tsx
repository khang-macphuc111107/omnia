import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import SkillPackageReviewPreview from "./skill-package-review-preview";
import type { SkillView } from "./types";

const skills: SkillView[] = [{
  id: "skill-review",
  name: "Review helper",
  description: "Review code with evidence.",
  version: "1.2.0",
  icon: "R",
  source: "Built in",
  trust: "Verified",
  enabled: true,
  scope: "Project",
  tokenFootprint: 200,
  permissions: ["read workspace"],
}];

describe("Skill package review preview", () => {
  it("shows checks, version review, permission diff, and truthful boundary", () => {
    render(<SkillPackageReviewPreview skills={skills} enabledIds={new Set(["skill-review"])} />);

    expect(screen.getByRole("heading", { name: /review before catalog change/i })).toBeInTheDocument();
    expect(screen.getByText("Same version")).toBeInTheDocument();
    expect(screen.getByText(/does not install, update, remove, trust/i)).toBeInTheDocument();

    const editor = screen.getByRole("textbox", { name: "Skill package JSON" });
    fireEvent.change(editor, { target: { value: "not json" } });
    fireEvent.click(screen.getByRole("button", { name: /run local review/i }));
    expect(screen.getByText(/package needs attention/i)).toBeInTheDocument();
    expect(screen.getByText(/could not parse package json/i)).toBeInTheDocument();
  });

  it("keeps staging disabled when the package has local validation failures", () => {
    render(<SkillPackageReviewPreview skills={skills} />);
    const editor = screen.getByRole("textbox", { name: "Skill package JSON" });
    fireEvent.change(editor, { target: { value: JSON.stringify({ schema: "wrong", scope: "renderer-session" }) } });
    fireEvent.click(screen.getByRole("button", { name: /inspect payload/i }));
    expect(screen.getByRole("button", { name: /stage in preview/i })).toBeDisabled();
    const checks = screen.getByRole("region", { name: "Skill package review preview" });
    expect(within(checks).getByText("Review")).toBeInTheDocument();
  });
});

