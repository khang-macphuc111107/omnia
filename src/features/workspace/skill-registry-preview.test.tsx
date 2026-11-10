import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import SkillRegistryPreview, { buildSkillRegistrySnapshot, serializeSkillRegistrySnapshot } from "./skill-registry-preview";
import type { SkillView } from "./types";

const skills: SkillView[] = [
  {
    id: "skill-review",
    name: "Review helper",
    description: "Review code with evidence.",
    version: "1.2.0",
    icon: "R",
    source: "Built in",
    trust: "Verified",
    enabled: true,
    scope: "Global",
    tokenFootprint: 180,
    permissions: ["read workspace"],
  },
  {
    id: "skill-imported",
    name: "Imported helper",
    description: "A user supplied package.",
    version: "0.4.0",
    icon: "I",
    source: "Imported",
    trust: "Unreviewed",
    enabled: false,
    scope: "Project",
    tokenFootprint: 240,
    permissions: ["read workspace", "network request"],
  },
];

describe("Skill registry preview", () => {
  it("builds truthful renderer-session counts and entries", () => {
    const snapshot = buildSkillRegistrySnapshot(skills, new Set(["skill-review"]));

    expect(snapshot.schema).toBe("omnia.skill-registry-preview.v1");
    expect(snapshot.scope).toBe("renderer-session");
    expect(snapshot.total).toBe(2);
    expect(snapshot.enabled).toBe(1);
    expect(snapshot.attention).toBe(1);
    expect(snapshot.tokenFootprint).toBe(420);
    expect(snapshot.permissionTypes).toBe(2);
    expect(snapshot.sourceCounts.Imported).toBe(1);
    expect(snapshot.trustCounts.Unreviewed).toBe(1);
    expect(snapshot.entries[0]?.enabled).toBe(true);
  });

  it("serializes JSON and Markdown without implying native activation", () => {
    const snapshot = buildSkillRegistrySnapshot(skills);
    const json = serializeSkillRegistrySnapshot(snapshot, "json");
    const markdown = serializeSkillRegistrySnapshot(snapshot, "markdown");

    expect(json).toContain("omnia.skill-registry-preview.v1");
    expect(json).toContain("renderer-session");
    expect(markdown).toContain("# Omnia skill registry preview");
    expect(markdown).toContain("Native installation, loading, permission grants");
  });

  it("filters attention and enabled entries while keeping an export preview", () => {
    render(<SkillRegistryPreview skills={skills} enabledIds={new Set(["skill-review"])} />);

    expect(screen.getByRole("heading", { name: /registry health/i })).toBeInTheDocument();
    expect(screen.getByText("Review attention")).toBeInTheDocument();
    const list = screen.getByRole("list", { name: "all skill registry entries" });
    expect(within(list).getByText("Review helper")).toBeInTheDocument();
    expect(within(list).getByText("Imported helper")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("combobox", { name: "Skill registry filter" }), { target: { value: "attention" } });
    const attentionList = screen.getByRole("list", { name: "attention skill registry entries" });
    expect(within(attentionList).getByText("Imported helper")).toBeInTheDocument();
    expect(within(attentionList).queryByText("Review helper")).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("combobox", { name: "Skill registry export format" }), { target: { value: "markdown" } });
    expect(screen.getByRole("code")).toHaveTextContent(/# Omnia skill registry preview/);
    expect(screen.getByText(/no native registry read/i)).toBeInTheDocument();
  });
});

