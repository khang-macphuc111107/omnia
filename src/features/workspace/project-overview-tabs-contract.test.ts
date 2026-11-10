import { describe, expect, it } from "vitest";

import {
  buildProjectOverviewTabContracts,
  getProjectOverviewTabContract,
  PROJECT_OVERVIEW_TAB_IDS,
} from "./project-overview-tabs-contract";

describe("Project Overview six-tab contract", () => {
  it("keeps the canonical order and does not introduce a competing top-level mode", () => {
    const contracts = buildProjectOverviewTabContracts({ settingsAvailable: true });

    expect(contracts.map((entry) => entry.id)).toEqual([...PROJECT_OVERVIEW_TAB_IDS]);
    expect(contracts).toHaveLength(6);
    expect(contracts.map((entry) => entry.label)).toEqual([
      "Conversations",
      "Context",
      "Files",
      "Memory",
      "Skills",
      "Settings",
    ]);
  });

  it("records partial coverage for context and files without overclaiming native readiness", () => {
    const contracts = buildProjectOverviewTabContracts({ settingsAvailable: true });
    const context = contracts.find((entry) => entry.id === "context")!;
    const files = contracts.find((entry) => entry.id === "files")!;

    expect(context.status).toBe("Partial");
    expect(context.coverage).toBe("renderer-session");
    expect(context.nativeGap).toMatch(/frozen context|provider dispatch/i);
    expect(files.status).toBe("Partial");
    expect(files.coverage).toBe("renderer-session");
    expect(files.nativeGap).toMatch(/indexing|durable grant/i);
  });

  it("fails closed for Settings when the host callback is absent", () => {
    const settings = getProjectOverviewTabContract("settings");

    expect(settings.status).toBe("Unavailable");
    expect(settings.coverage).toBe("not-exposed");
    expect(settings.targetTab).toBeUndefined();
    expect(settings.description).toMatch(/not available/i);
  });

  it("only promotes Settings to a renderer preview when a callback exists", () => {
    const settings = getProjectOverviewTabContract("settings", { settingsAvailable: true });

    expect(settings.status).toBe("Preview");
    expect(settings.coverage).toBe("renderer-plus-host-callback");
    expect(settings.nativeGap).toMatch(/does not imply durable/i);
  });

  it("gives every tab an evidence source and a typed native gap", () => {
    const contracts = buildProjectOverviewTabContracts();

    for (const contract of contracts) {
      expect(contract.source.trim()).not.toBe("");
      expect(contract.description.trim()).not.toBe("");
      expect(contract.nativeGap.trim()).not.toBe("");
      expect(["Preview", "Partial", "Planned", "Unavailable"]).toContain(contract.status);
    }
  });
});

