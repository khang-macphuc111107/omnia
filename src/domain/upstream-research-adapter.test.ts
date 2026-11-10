import { describe, expect, it } from "vitest";
import { createResearchExecutionPlan, executeGroundedResearch, createResearchCitationReceipt, type GroundedResearchGateway } from "./upstream-research-adapter";
import { sha256Hex } from "./omnia-official-harness-adapters";

const now = "2026-11-07T12:00:00.000Z";
const later = "2026-11-07T12:01:00.000Z";
function gateway(overrides: Partial<GroundedResearchGateway> = {}): GroundedResearchGateway {
  return {
    adapterId: "native-web-gateway", authorityReceiptId: "authority_external_read_1", permission: "external-read-approved",
    search: async () => ({ receiptId: "search_receipt", hits: [{ url: "https://example.org/paper#section", title: "Primary source" }] }),
    capture: async (url) => ({ receiptId: "capture_receipt", finalUrl: url, text: "A retained exact source quote with documented limitations.", retrievedAt: later, truncated: false }),
    ...overrides,
  };
}

describe("upstream grounded research adapter", () => {
  it("creates bounded deterministic query fan-out with a dynamic freshness date", () => {
    const plan = createResearchExecutionPlan({ prompt: "Compare latest RAG research vs retrieval in Vietnamese", now, additionalQueries: ["Compare latest RAG research vs retrieval in Vietnamese"], policy: { maxQueries: 5 } });
    expect(plan).toEqual(createResearchExecutionPlan({ prompt: "Compare latest RAG research vs retrieval in Vietnamese", now, additionalQueries: ["Compare latest RAG research vs retrieval in Vietnamese"], policy: { maxQueries: 5 } }));
    expect(plan.queries.map((query) => query.intent)).toEqual(["original", "academic", "comparison", "freshness", "primary"]);
    expect(plan.queries.find((query) => query.intent === "freshness")?.text).toContain("2026-11-07");
    expect(Object.isFrozen(plan.queries[0])).toBe(true);
    expect(Object.isFrozen(plan.policy)).toBe(true);
    expect(() => createResearchExecutionPlan({ prompt: "x", now, policy: { concurrency: 100 } })).toThrow(/concurrency/);
  });

  it("uses the real gateway, deduplicates URL/source content and retains content-free receipts", async () => {
    const plan = createResearchExecutionPlan({ prompt: "source prompt private", now, policy: { maxQueries: 2, concurrency: 2 } });
    let active = 0; let maximum = 0; const capturedUrls: string[] = [];
    const result = await executeGroundedResearch(plan, gateway({
      search: async (query, maxResults, context) => {
        active++; maximum = Math.max(maximum, active);
        await Promise.resolve(); active--;
        expect(maxResults).toBe(plan.policy.maxResultsPerQuery);
        expect(context.authorityReceiptId).toBe("authority_external_read_1");
        return { receiptId: `search_${query.id}`, hits: [{ url: "https://example.org/paper#section", title: "A" }, { url: "https://example.org/mirror", title: "B" }] };
      },
      capture: async (url) => { capturedUrls.push(url); return { receiptId: "captured", finalUrl: url, text: "private retained text", retrievedAt: later, truncated: false }; },
    }), { now: () => later });
    expect(maximum).toBe(2);
    expect(capturedUrls).toEqual(["https://example.org/paper", "https://example.org/mirror"]);
    expect(result.sources).toHaveLength(1);
    expect(result.receipt.sources.map((source) => source.disposition)).toEqual(["completed", "duplicate-content"]);
    expect(result.receipt.sources[0]?.queryIds).toHaveLength(2);
    expect(result.receipt.retainedCharacters).toBe("private retained text".length);
    const json = JSON.stringify(result.receipt);
    expect(json).not.toContain("source prompt private");
    expect(json).not.toContain("private retained text");
    expect(json).not.toContain("https:");
    expect(Object.isFrozen(result.receipt.sources[0]?.queryIds)).toBe(true);
    const { receiptSha256, ...body } = result.receipt;
    expect(receiptSha256).toBe(sha256Hex(JSON.stringify(body)));
  });

  it("bounds source admissions and trims content deterministically in search order", async () => {
    const plan = createResearchExecutionPlan({ prompt: "bounded", now, policy: { maxQueries: 1, maxSources: 2, concurrency: 2, maxCharactersPerSource: 200, maxTotalCharacters: 250 } });
    const result = await executeGroundedResearch(plan, gateway({
      search: async () => ({ receiptId: "search", hits: ["a", "b", "c"].map((id) => ({ url: `https://example.org/${id}`, title: id })) }),
      capture: async (url) => ({ receiptId: "capture", finalUrl: url, text: url.endsWith("a") ? "a".repeat(300) : "b".repeat(300), retrievedAt: later, truncated: false }),
    }), { now: () => later });
    expect(result.receipt.retainedCharacters).toBe(250);
    expect(result.sources.map((source) => source.text.length)).toEqual([200, 50]);
    expect(result.sources.every((source) => source.truncated)).toBe(true);
    expect(result.receipt.sources[2]?.disposition).toBe("source-limit");
    expect(result.receipt.sources[1]?.contentSha256).toBe(sha256Hex("b".repeat(50)));
  });

  it("isolates bad URLs, gateway errors and invalid capture receipts without retaining raw errors", async () => {
    const plan = createResearchExecutionPlan({ prompt: "failure", now, policy: { maxQueries: 2 } });
    const result = await executeGroundedResearch(plan, gateway({
      search: async (query) => {
        if (query.intent !== "original") throw new Error("Bearer SECRET_RAW_TOKEN");
        return { receiptId: "search", hits: [
          { url: "https://user:SECRET@example.org/", title: "Credential" },
          { url: "file:///C:/secret", title: "Local" },
          { url: "https://example.org/fail", title: "Fail" },
        ] };
      },
      capture: async () => { throw new Error("PRIVATE_SESSION_COOKIE"); },
    }), { now: () => later });
    expect(result.receipt.status).toBe("partial");
    expect(result.receipt.queries.map((query) => query.status)).toEqual(["completed", "failed"]);
    expect(result.receipt.sources.map((source) => source.disposition)).toEqual(["invalid-url", "invalid-url", "failed"]);
    expect(JSON.stringify(result.receipt)).not.toMatch(/SECRET|PRIVATE_SESSION_COOKIE/);
    expect(result.sources).toHaveLength(0);
  });

  it("passes cancellation to admitted calls and admits no work after abort", async () => {
    const controller = new AbortController(); controller.abort();
    let searchCalls = 0; let captureCalls = 0;
    const plan = createResearchExecutionPlan({ prompt: "cancel", now });
    const result = await executeGroundedResearch(plan, gateway({ search: async () => { searchCalls++; throw new Error("unreachable"); }, capture: async () => { captureCalls++; throw new Error("unreachable"); } }), { signal: controller.signal, now: () => later });
    expect(searchCalls).toBe(0); expect(captureCalls).toBe(0);
    expect(result.receipt.status).toBe("cancelled");
    expect(result.receipt.queries.every((query) => query.status === "cancelled")).toBe(true);
  });

  it("rejects changed plan and missing permission before invoking any gateway", async () => {
    const plan = createResearchExecutionPlan({ prompt: "scope", now });
    await expect(executeGroundedResearch({ ...plan, promptSha256: "f".repeat(64) }, gateway(), { now: () => later })).rejects.toThrow(/identity changed/);
    await expect(executeGroundedResearch(plan, gateway({ permission: "denied" as never }), { now: () => later })).rejects.toThrow(/approved external-read/);
  });

  it("verifies exact quote spans without declaring claim truth from a matching quote", async () => {
    const plan = createResearchExecutionPlan({ prompt: "citation", now, policy: { maxQueries: 1 } });
    const result = await executeGroundedResearch(plan, gateway(), { now: () => later });
    const source = result.sources[0]!;
    const span = { sourceId: source.id, start: 2, end: 10, quote: source.text.slice(2, 10) };
    const receipt = createResearchCitationReceipt(result, [
      { id: "claim-1", text: "A grounded inference", spans: [span] },
      { id: "claim-2", text: "An unsupported assertion", spans: [] },
    ]);
    expect(receipt.spanVerifiedClaims).toBe(1); expect(receipt.totalClaims).toBe(2);
    expect(receipt.claims.map((claim) => claim.grounding)).toEqual(["span-verified", "unverified"]);
    expect(JSON.stringify(receipt)).not.toContain("A grounded inference");
    expect(JSON.stringify(receipt)).not.toContain(span.quote);
    expect(() => createResearchCitationReceipt(result, [{ id: "bad", text: "Bad", spans: [{ ...span, quote: "wrong" }] }])).toThrow(/does not match/);
    expect(() => createResearchCitationReceipt(result, [{ id: "bad", text: "Bad", spans: [{ ...span, end: 9_999 }] }])).toThrow(/outside/);
    expect(() => createResearchCitationReceipt(result, [{ id: "bad", text: "Bad", spans: [span, span] }])).toThrow(/more than once/);
  });
});
