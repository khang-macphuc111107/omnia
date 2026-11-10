import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import SkillsDomainCatalog, {
  buildSkillsDomainCatalog,
  buildSkillsDomainSnapshot,
  serializeSkillsDomainSnapshot,
} from "./skills-domain-catalog";
import { specialistRolePreviewCatalog } from "./specialist-catalog-preview";
import SkillsScreen from "./activities/skills-screen";

describe("Skills domain catalog preview", () => {
  it("aggregates role records into truthful domain coverage", () => {
    const domains = buildSkillsDomainCatalog(specialistRolePreviewCatalog);
    const snapshot = buildSkillsDomainSnapshot(specialistRolePreviewCatalog);

    expect(domains.length).toBeGreaterThan(10);
    expect(snapshot.schema).toBe("omnia.skill-domain-catalog-preview.v1");
    expect(snapshot.scope).toBe("renderer-session");
    expect(snapshot.roleCount).toBe(specialistRolePreviewCatalog.length);
    expect(domains.find((domain) => domain.label === "Software")?.roleCount).toBeGreaterThan(1);
    expect(snapshot.plannedEvidenceCount).toBeGreaterThan(0);
  });

  it("serializes JSON and Markdown with the preview boundary intact", () => {
    const snapshot = buildSkillsDomainSnapshot();
    const json = serializeSkillsDomainSnapshot(snapshot, "json");
    const markdown = serializeSkillsDomainSnapshot(snapshot, "markdown");

    expect(json).toContain("omnia.skill-domain-catalog-preview.v1");
    expect(json).toContain("renderer-session");
    expect(markdown).toContain("# Omnia skill domain catalog preview");
    expect(markdown).toContain("does not resolve agents, grant authority");
  });

  it("filters domains and exposes selected role coverage", () => {
    render(<SkillsDomainCatalog />);

    expect(screen.getByRole("heading", { name: /map skill and specialist domains/i })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Skill domains" })).toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: "Search skill domains" }), { target: { value: "rust" } });
    const list = screen.getByRole("list", { name: "Skill domains" });
    expect(within(list).getByText("Software")).toBeInTheDocument();
    expect(within(list).queryByText("Mathematics")).not.toBeInTheDocument();

    fireEvent.click(within(list).getByRole("button", { name: /Software/i }));
    const detail = screen.getByRole("complementary", { name: "Selected skill domain details" });
    expect(within(detail).getByText("Production Rust Engineer")).toBeInTheDocument();
    expect(within(detail).getByText(/Role ceilings remain bounded/i)).toBeInTheDocument();
  });

  it("is reachable from Skills Studio and keeps native resolution planned", async () => {
    render(<SkillsScreen />);

    fireEvent.click(screen.getByRole("tab", { name: "Domains" }));
    expect(await screen.findByRole("heading", { name: /map skill and specialist domains/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Preview export" }));
    expect(screen.getByRole("region", { name: "Skill domain catalog export preview" })).toHaveTextContent(/No native resolution/i);
    expect(screen.getByText(/does not install skills, resolve agents, grant permissions/i)).toBeInTheDocument();
  });
});
