import { describe, expect, it } from "vitest";

import {
  buildComposerSlashCommandRegistrySnapshot,
  findComposerSlashCommands,
  getComposerSlashCommand,
  serializeComposerSlashCommandRegistry,
} from "./composer-slash-commands";

describe("composer slash command registry", () => {
  it("exposes searchable metadata for built-in commands", () => {
    expect(getComposerSlashCommand("code")).toMatchObject({
      command: "/code",
      category: "Code",
      status: "available",
      source: "built-in",
      insertMode: "code-block",
    });
    expect(getComposerSlashCommand("code")?.aliases).toContain("ts");
    expect(findComposerSlashCommands("ts")[0]?.id).toBe("code");
    expect(findComposerSlashCommands("", { category: "Structure" }).map((command) => command.id)).toEqual([
      "checklist",
      "numbered",
      "table",
    ]);
    expect(findComposerSlashCommands("", { source: "session-import" })).toEqual([]);
  });

  it("builds an honest renderer-session registry snapshot", () => {
    const snapshot = buildComposerSlashCommandRegistrySnapshot();

    expect(snapshot.schema).toBe("omnia.composer-slash-command-registry.preview.v1");
    expect(snapshot.scope).toBe("renderer-session");
    expect(snapshot.total).toBe(9);
    expect(snapshot.statuses.available).toBe(9);
    expect(snapshot.sources["built-in"]).toBe(9);
    expect(snapshot.categories).toMatchObject({
      Writing: 2,
      Research: 2,
      Code: 1,
      Structure: 3,
      Prompting: 1,
    });
    expect(snapshot.boundary).toEqual({
      nativeDispatch: false,
      providerRequest: false,
      durableWrite: false,
    });
  });

  it("serializes JSON and Markdown previews without execution claims", () => {
    const snapshot = buildComposerSlashCommandRegistrySnapshot();
    const json = JSON.parse(serializeComposerSlashCommandRegistry(snapshot, "json")) as {
      schema: string;
      generatedAt: string;
      commands: unknown[];
      boundary: { nativeDispatch: boolean; providerRequest: boolean; durableWrite: boolean };
    };
    const markdown = serializeComposerSlashCommandRegistry(snapshot, "markdown");

    expect(json.schema).toBe(snapshot.schema);
    expect(json.generatedAt).toMatch(/T/);
    expect(json.commands).toHaveLength(9);
    expect(json.boundary).toEqual(snapshot.boundary);
    expect(markdown).toContain("# Omnia slash-command registry preview");
    expect(markdown).toContain("/research");
    expect(markdown).toContain("Native command registration, provider requests, and durable writes are not performed.");
  });
});
