import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type JsonRecord = Record<string, unknown>;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const specRoot = join(repoRoot, "docs", "omnia-ultra");
const validator = join(specRoot, "tools", "validate-agent-catalog.mjs");

function readBundle(root: string, relativePath: string): JsonRecord {
  return JSON.parse(readFileSync(join(root, relativePath), "utf8")) as JsonRecord;
}

function writeBundle(root: string, relativePath: string, value: JsonRecord): void {
  writeFileSync(join(root, relativePath), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function runCatalogMutation(
  mutate: (catalog: JsonRecord, roles: JsonRecord, personas: JsonRecord) => void,
): JsonRecord {
  const root = mkdtempSync(join(tmpdir(), "omnia-agent-catalog-"));
  try {
    cpSync(specRoot, root, { recursive: true });
    const catalog = readBundle(root, "harness/catalog/agent-catalog.json");
    const roles = readBundle(root, "harness/catalog/role-profiles.json");
    const personas = readBundle(root, "harness/catalog/persona-packs.json");
    mutate(catalog, roles, personas);
    writeBundle(root, "harness/catalog/agent-catalog.json", catalog);
    writeBundle(root, "harness/catalog/role-profiles.json", roles);
    writeBundle(root, "harness/catalog/persona-packs.json", personas);

    const result = spawnSync(
      process.execPath,
      [validator, "--json", "--root", root],
      { encoding: "utf8" },
    );
    if (result.error) throw result.error;
    return JSON.parse(result.stdout) as JsonRecord;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function firstRole(roles: JsonRecord): JsonRecord {
  const profiles = roles.profiles;
  if (!Array.isArray(profiles) || !profiles[0] || typeof profiles[0] !== "object") {
    throw new Error("role fixture is empty");
  }
  return profiles[0] as JsonRecord;
}

function firstPersona(personas: JsonRecord): JsonRecord {
  const records = personas.personas;
  if (!Array.isArray(records) || !records[0] || typeof records[0] !== "object") {
    throw new Error("persona fixture is empty");
  }
  return records[0] as JsonRecord;
}

function profileRefs(catalog: JsonRecord): JsonRecord[] {
  return (catalog.profileRefs as JsonRecord[]) ?? [];
}

function personaRefs(catalog: JsonRecord): JsonRecord[] {
  return (catalog.personaRefs as JsonRecord[]) ?? [];
}

describe("Omnia specialist agent/persona catalog validator", () => {
  it("accepts the checked-in catalog and reports deterministic counts", () => {
    const report = runCatalogMutation(() => {
      // No mutation: this executes the checked-in fixture in an isolated copy.
    });

    expect(report.ok).toBe(true);
    expect(report.counts).toMatchObject({
      enabledRoleProfiles: 10,
      enabledPersonaPacks: 6,
      duplicateCanonicalProfiles: 0,
      duplicateCanonicalPersonas: 0,
    });
  });

  it.each([
    ["nonGoals", "non-goals"],
    ["inputContract", "typed input contract"],
    ["outputContract", "typed output contract"],
    ["failureModes", "failure modes"],
    ["evidence", "evidence"],
  ] as const)("rejects a role without %s", (field) => {
    const report = runCatalogMutation((_catalog, roles) => {
      delete firstRole(roles)[field];
    });

    expect(report.ok).toBe(false);
    expect((report.errors as JsonRecord[]).some((error) => error.code === "missing-field")).toBe(true);
  });

  it.each([
    "toolIds",
    "grantIds",
    "secretRefs",
    "sessionId",
    "environmentId",
    "approvalId",
  ])("rejects persona authority field %s", (field) => {
    const report = runCatalogMutation((_catalog, _roles, personas) => {
      firstPersona(personas)[field] = ["fixture.value"];
    });

    expect(report.ok).toBe(false);
    expect((report.errors as JsonRecord[]).some((error) => error.code === "persona-authority-field")).toBe(true);
  });

  it("rejects duplicate canonical role contracts even when IDs differ", () => {
    const report = runCatalogMutation((catalog, roles) => {
      const profiles = roles.profiles as JsonRecord[];
      const duplicate = structuredClone(profiles[0]) as JsonRecord;
      duplicate.profileId = "role.fixture-duplicate";
      duplicate.revisionId = "role.fixture-duplicate:20260910";
      profiles.push(duplicate);

      const refs = profileRefs(catalog);
      const source = refs[0];
      refs.push({
        ...structuredClone(source),
        id: duplicate.profileId,
        revisionId: duplicate.revisionId,
      });
    });

    expect(report.ok).toBe(false);
    expect((report.errors as JsonRecord[]).some((error) => error.code === "duplicate-canonical-role")).toBe(true);
  });

  it("excludes disabled, deprecated, draft and aliases from enabled counts", () => {
    const report = runCatalogMutation((catalog, roles, personas) => {
      const profile = firstRole(roles);
      const persona = firstPersona(personas);
      const roleRef = profileRefs(catalog)[0];
      const personaRef = personaRefs(catalog)[0];

      profile.lifecycle = "disabled";
      roleRef.lifecycle = "disabled";
      roleRef.alias = false;
      roleRef.evidenceStatus = "current";

      persona.lifecycle = "deprecated";
      personaRef.lifecycle = "deprecated";
      personaRef.alias = false;
      personaRef.evidenceStatus = "current";

      catalog.derivedCounts = {
        ...(catalog.derivedCounts as JsonRecord),
        enabledRoleProfiles: 9,
        enabledPersonaPacks: 5,
        excludedRoleProfiles: 1,
        excludedPersonaPacks: 1,
      };
    });

    expect(report.ok).toBe(true);
    expect(report.counts).toMatchObject({
      enabledRoleProfiles: 9,
      enabledPersonaPacks: 5,
      excludedRoleProfiles: 1,
      excludedPersonaPacks: 1,
    });
  });

  it("accepts a valid alias and excludes it from enabled counts", () => {
    const report = runCatalogMutation((catalog) => {
      const ref = profileRefs(catalog)[0];
      ref.alias = true;
      ref.aliasOf = "role.goal-architect";
      catalog.derivedCounts = {
        ...(catalog.derivedCounts as JsonRecord),
        enabledRoleProfiles: 9,
        excludedRoleProfiles: 1,
      };
    });

    expect(report.ok).toBe(true);
    expect(report.counts).toMatchObject({ enabledRoleProfiles: 9, excludedRoleProfiles: 1 });
  });

  it("rejects an alias that does not declare its target", () => {
    const report = runCatalogMutation((catalog) => {
      const ref = profileRefs(catalog)[0];
      ref.alias = true;
      delete ref.aliasOf;
    });

    expect(report.ok).toBe(false);
    expect((report.errors as JsonRecord[]).some((error) => error.code === "alias-target-missing")).toBe(true);
  });

  it("rejects an alias whose target is missing from the source bundle", () => {
    const report = runCatalogMutation((catalog) => {
      const ref = profileRefs(catalog)[0];
      ref.alias = true;
      ref.aliasOf = "role.fixture-missing";
    });

    expect(report.ok).toBe(false);
    expect((report.errors as JsonRecord[]).some((error) => error.code === "alias-target-dangling")).toBe(true);
  });

  it("rejects duplicate catalog references even when their hashes differ", () => {
    const report = runCatalogMutation((catalog) => {
      const refs = profileRefs(catalog);
      refs.push({
        ...structuredClone(refs[0]),
        canonicalHash: refs[1].canonicalHash,
        differentiationHash: refs[1].differentiationHash,
      });
    });

    expect(report.ok).toBe(false);
    expect((report.errors as JsonRecord[]).some((error) => error.code === "duplicate-id" && error.label === "role reference ID")).toBe(true);
  });

  it("rejects unsupported catalog reference fields", () => {
    const report = runCatalogMutation((catalog) => {
      profileRefs(catalog)[0].runtimeAuthority = "fixture-forbidden";
    });

    expect(report.ok).toBe(false);
    expect((report.errors as JsonRecord[]).some((error) => error.code === "unknown-reference-field")).toBe(true);
  });

  it("rejects a source bundle with the wrong catalog kind", () => {
    const report = runCatalogMutation((_catalog, roles) => {
      roles.catalogKind = "persona-packs";
    });

    expect(report.ok).toBe(false);
    expect((report.errors as JsonRecord[]).some((error) => error.code === "invalid-bundle-kind")).toBe(true);
  });

  it("rejects a catalog reference with a mismatched source revision", () => {
    const report = runCatalogMutation((catalog) => {
      profileRefs(catalog)[0].revisionId = "role.goal-architect:stale";
    });

    expect(report.ok).toBe(false);
    expect((report.errors as JsonRecord[]).some((error) => error.code === "revision-mismatch")).toBe(true);
  });

  it("keeps derived counts deterministic when an entry is excluded for stale evidence", () => {
    const report = runCatalogMutation((catalog) => {
      const ref = personaRefs(catalog)[0];
      ref.evidenceStatus = "stale";
      catalog.derivedCounts = {
        ...(catalog.derivedCounts as JsonRecord),
        enabledPersonaPacks: 5,
        excludedPersonaPacks: 1,
      };
    });

    expect(report.ok).toBe(false);
    expect((report.errors as JsonRecord[]).some((error) => error.code === "evidence-status-mismatch")).toBe(true);
  });
});
