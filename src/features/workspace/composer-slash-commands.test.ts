import { describe, expect, it } from "vitest";

import {
  applyComposerSlashCommand,
  findComposerSlashCommands,
  getComposerSlashContext,
} from "./composer-slash-commands";

describe("composer slash commands", () => {
  it("opens only for a slash token at the current line start", () => {
    expect(getComposerSlashContext("/rep", 4, 4)).toMatchObject({ query: "rep", slashStart: 0, slashEnd: 4 });
    expect(getComposerSlashContext("hello /rep", 10, 10)).toBeNull();
    expect(getComposerSlashContext("/rep", 0, 4)).toBeNull();
  });

  it("filters commands by command, label, description, and keywords", () => {
    expect(findComposerSlashCommands("check").map((command) => command.id)).toContain("checklist");
    expect(findComposerSlashCommands("formula").map((command) => command.id)).toEqual(["math"]);
    expect(findComposerSlashCommands("sources").map((command) => command.id)).toContain("research");
  });

  it("replaces the slash token and positions the caret inside the scaffold", () => {
    const change = applyComposerSlashCommand("/code", 5, 5, "code");

    expect(change.value).toBe("```typescript\n\n```");
    expect(change.value.slice(change.selectionStart)).toBe("\n```");
    expect(change.handled).toBe(true);
  });

  it("preserves leading indentation across multi-line scaffolds", () => {
    const change = applyComposerSlashCommand("  /math", 7, 7, "math");

    expect(change.value).toBe("  $$\n  \n  $$");
    expect(change.value.slice(change.selectionStart)).toBe("\n  $$");
  });
});
