import { describe, expect, it } from "vitest";

import {
  ACTIVITY_IDS,
  ACTIVITY_REGISTRY,
  COMMAND_ACTIVITIES,
  LAZY_ACTIVITIES,
  PRIMARY_ACTIVITIES,
  SECONDARY_ACTIVITIES,
  activityDescriptor,
  activityForShortcut,
} from "./activity-registry";

describe("workspace activity registry", () => {
  it("contains each canonical activity exactly once", () => {
    const ids = ACTIVITY_REGISTRY.map((activity) => activity.id);
    expect(ids).toEqual(ACTIVITY_IDS);
    expect(new Set(ids).size).toBe(ACTIVITY_IDS.length);
    expect(new Set(ACTIVITY_REGISTRY.map((activity) => activity.command.title)).size).toBe(
      ACTIVITY_REGISTRY.length,
    );
  });

  it("keeps chats eager and gives every non-chat activity one lazy screen", () => {
    expect(activityDescriptor("chats").screen).toEqual({ kind: "conversation" });
    expect(LAZY_ACTIVITIES.map((activity) => activity.id)).toEqual([
      "home",
      "projects",
      "work",
      "library",
      "memory",
      "skills",
      "settings",
    ]);
    for (const activity of LAZY_ACTIVITIES) {
      expect(activity.screen.kind).toBe("lazy");
      expect(activity.screen.load).toBeTypeOf("function");
    }
  });

  it("exposes every activity to command navigation", () => {
    expect(COMMAND_ACTIVITIES.map((activity) => activity.id)).toEqual(ACTIVITY_IDS);
  });

  it("has explicit rail placement and truthful sidebar metadata", () => {
    expect(PRIMARY_ACTIVITIES.map((activity) => activity.id)).toEqual([
      "home",
      "chats",
      "projects",
      "work",
      "library",
      "memory",
      "skills",
    ]);
    expect(SECONDARY_ACTIVITIES.map((activity) => activity.id)).toEqual(["settings"]);
    expect(activityDescriptor("chats").sidebar.mode).toBe("conversations");
    expect(activityDescriptor("projects").sidebar.mode).toBe("projects");
    expect(activityDescriptor("memory").sidebar).toMatchObject({
      mode: "context",
      description: expect.stringContaining("provenance"),
    });
    expect(activityDescriptor("skills").command.title).toBe("Open Skills Studio");
    expect(activityDescriptor("work").command.title).toBe("Open Background Work");
    expect(activityDescriptor("work").sidebar).toMatchObject({
      mode: "context",
      description: expect.stringMatching(/attention/i),
    });
    expect(activityDescriptor("settings").command.title).toBe("Open Omnia Control Center");
  });

  it("keeps direct navigation shortcuts aligned with the activity registry", () => {
    expect(ACTIVITY_REGISTRY.map((activity) => activity.shortcut)).toEqual([
      "Alt+1",
      "Alt+2",
      "Alt+3",
      "Alt+4",
      "Alt+5",
      "Alt+6",
      "Alt+7",
      "Alt+8",
    ]);
    expect(activityForShortcut(new KeyboardEvent("keydown", { altKey: true, key: "1" }))).toBe("home");
    expect(activityForShortcut(new KeyboardEvent("keydown", { altKey: true, key: "4" }))).toBe("work");
    expect(activityForShortcut(new KeyboardEvent("keydown", { altKey: true, key: "1", ctrlKey: true }))).toBeNull();
    expect(activityForShortcut(new KeyboardEvent("keydown", { key: "1" }))).toBeNull();
  });
});
