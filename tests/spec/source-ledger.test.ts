import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type JsonRecord = Record<string, any>;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ledgerPath = join(repoRoot, "docs", "omnia-ultra", "delivery", "source-ledger.json");
const generator = join(repoRoot, "docs", "omnia-ultra", "tools", "generate-source-ledger.mjs");
const validator = join(repoRoot, "docs", "omnia-ultra", "tools", "validate-source-ledger.mjs");

function readLedger(): JsonRecord {
  return JSON.parse(readFileSync(ledgerPath, "utf8")) as JsonRecord;
}

function runValidator(mutate: (ledger: JsonRecord) => void): JsonRecord {
  const root = mkdtempSync(join(tmpdir(), "omnia-source-ledger-"));
  const mutated = readLedger();
  try {
    mutate(mutated);
    const candidate = join(root, "source-ledger.json");
    writeFileSync(candidate, `${JSON.stringify(mutated, null, 2)}\n`, "utf8");
    const result = spawnSync(
      process.execPath,
      [validator, "--json", "--check", "--root", repoRoot, "--ledger", candidate],
      { encoding: "utf8" },
    );
    if (result.error) throw result.error;
    return JSON.parse(result.stdout) as JsonRecord;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function firstLocalSource(ledger: JsonRecord): JsonRecord {
  const source = (ledger.sources as JsonRecord[]).find((entry) => entry.locator?.kind === "local-file");
  if (!source) throw new Error("fixture has no local source");
  return source;
}

function firstUrlSource(ledger: JsonRecord): JsonRecord {
  const source = (ledger.sources as JsonRecord[]).find((entry) => entry.locator?.kind === "url");
  if (!source) throw new Error("fixture has no URL source");
  return source;
}

describe("Omnia source ledger generator and validator", () => {
  it("keeps the checked-in projection deterministic and integrity-checked", () => {
    const result = spawnSync(process.execPath, [generator, "--check"], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("SOURCE_LEDGER_GENERATE: PASS");

    const report = runValidator(() => {
      // No mutation: validate the checked-in source register against the repo.
    });
    expect(report.ok).toBe(true);
    expect(report.counts).toMatchObject({
      sources: 96,
      withLocalHashes: 39,
      documentedOnlyUrls: 47,
      mappedSources: 0,
    });
  });

  it("rejects unsupported fields instead of silently widening the contract", () => {
    const report = runValidator((ledger) => {
      ledger.sources[0].privatePayload = "must-not-be-here";
    });

    expect(report.ok).toBe(false);
    expect((report.errors as JsonRecord[]).some((error) => error.code === "unknown-field")).toBe(true);
  });

  it("rejects duplicate source IDs", () => {
    const report = runValidator((ledger) => {
      ledger.sources[1].sourceId = ledger.sources[0].sourceId;
    });

    expect(report.ok).toBe(false);
    expect((report.errors as JsonRecord[]).some((error) => error.code === "duplicate-source-id")).toBe(true);
  });

  it("rejects local path traversal and absolute paths", () => {
    const report = runValidator((ledger) => {
      firstLocalSource(ledger).locator.path = "../../outside.txt";
    });

    expect(report.ok).toBe(false);
    expect((report.errors as JsonRecord[]).some((error) => error.code === "unsafe-local-path")).toBe(true);
  });

  it("rejects local content-hash drift", () => {
    const report = runValidator((ledger) => {
      firstLocalSource(ledger).integrity.contentHash = "0".repeat(64);
    });

    expect(report.ok).toBe(false);
    expect((report.errors as JsonRecord[]).some((error) => error.code === "content-hash-mismatch")).toBe(true);
  });

  it("rejects local directories without crashing the validator", () => {
    const report = runValidator((ledger) => {
      firstLocalSource(ledger).locator.path = "docs";
    });

    expect(report.ok).toBe(false);
    expect((report.errors as JsonRecord[]).some((error) => error.code === "non-regular-local-source")).toBe(true);
  });

  it("rejects a source class paired with the wrong locator kind", () => {
    const report = runValidator((ledger) => {
      firstLocalSource(ledger).sourceClass = "official-documentation";
    });

    expect(report.ok).toBe(false);
    expect((report.errors as JsonRecord[]).some((error) => error.code === "locator-class-mismatch")).toBe(true);
  });

  it("requires HTTPS for official documentation URLs", () => {
    const report = runValidator((ledger) => {
      firstUrlSource(ledger).locator.url = "http://example.invalid/docs";
    });

    expect(report.ok).toBe(false);
    expect((report.errors as JsonRecord[]).some((error) => error.code === "invalid-url")).toBe(true);
  });

  it("keeps URL review honest when reachability is not checked", () => {
    const report = runValidator((ledger) => {
      // No mutation: the checked-in URL entries intentionally remain documented-only.
    });
    expect(report.ok).toBe(true);
    expect(report.counts.documentedOnlyUrls).toBe(47);
  });
});
