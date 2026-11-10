import { assertDomain } from "./errors";
import { sha256Hex } from "./omnia-official-harness-adapters";
import { assertIntegerInRange, assertIsoTimestamp, assertNonBlank, type IsoTimestamp } from "./shared";

/**
 * Omnia adapter for the fan-out/citation contracts inspected in
 * upstream_extractions/research/perplexity-synthesis. The extracted synthesis
 * engine accepts mockSources; this adapter executes an explicitly approved
 * gateway and never treats a search snippet, hostname or model confidence as
 * verification. Network/redirect/DNS policy remains owned by that gateway.
 */
export const UPSTREAM_RESEARCH_ADAPTER_VERSION = "omnia-grounded-research-v1" as const;
export const UPSTREAM_RESEARCH_PROVENANCE = Object.freeze([
  "research/perplexity-synthesis/src/query-fanout.ts",
  "research/perplexity-synthesis/src/citation-graph.ts",
  "research/orca-debate/src/judge-arbiter.ts",
]);

export type ResearchQueryIntent = "original" | "primary" | "academic" | "comparison" | "freshness" | "counter-evidence";
export interface ResearchExecutionPolicy {
  readonly maxQueries: number;
  readonly maxResultsPerQuery: number;
  readonly maxSources: number;
  readonly concurrency: number;
  readonly maxCharactersPerSource: number;
  readonly maxTotalCharacters: number;
}
const DEFAULT_POLICY: ResearchExecutionPolicy = Object.freeze({
  maxQueries: 6, maxResultsPerQuery: 8, maxSources: 12, concurrency: 4,
  maxCharactersPerSource: 32_000, maxTotalCharacters: 128_000,
});

export interface ResearchExecutionQuery {
  readonly id: string;
  readonly intent: ResearchQueryIntent;
  readonly text: string;
  readonly querySha256: string;
}
export interface ResearchExecutionPlan {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly adapterVersion: typeof UPSTREAM_RESEARCH_ADAPTER_VERSION;
  readonly promptSha256: string;
  readonly queries: readonly ResearchExecutionQuery[];
  readonly policy: ResearchExecutionPolicy;
  readonly createdAt: IsoTimestamp;
  readonly planSha256: string;
}

function normalizePolicy(input: Partial<ResearchExecutionPolicy> = {}): ResearchExecutionPolicy {
  const get = (key: keyof ResearchExecutionPolicy, maximum: number, minimum = 1) =>
    assertIntegerInRange(input[key] ?? DEFAULT_POLICY[key], `research ${key}`, minimum, maximum);
  return Object.freeze({
    maxQueries: get("maxQueries", 16), maxResultsPerQuery: get("maxResultsPerQuery", 100),
    maxSources: get("maxSources", 100), concurrency: get("concurrency", 16),
    maxCharactersPerSource: get("maxCharactersPerSource", 1_000_000, 100),
    maxTotalCharacters: get("maxTotalCharacters", 2_000_000, 100),
  });
}

function planHash(plan: Omit<ResearchExecutionPlan, "id" | "planSha256">): string {
  return sha256Hex(JSON.stringify(plan));
}

/** Query expansion is a plan, not proof that any external search occurred. */
export function createResearchExecutionPlan(input: {
  readonly prompt: string;
  readonly now: IsoTimestamp;
  readonly additionalQueries?: readonly string[];
  readonly policy?: Partial<ResearchExecutionPolicy>;
}): ResearchExecutionPlan {
  const prompt = assertNonBlank(input.prompt, "research prompt", 8_000);
  assertIsoTimestamp(input.now, "research plan time");
  const policy = normalizePolicy(input.policy);
  assertDomain((input.additionalQueries?.length ?? 0) <= 16, "invalid_argument", "Too many additional research queries.");
  const candidates: { intent: ResearchQueryIntent; text: string }[] = [{ intent: "original", text: prompt }];
  for (const query of input.additionalQueries ?? []) candidates.push({ intent: "primary", text: assertNonBlank(query, "additional research query", 8_000) });
  if (/\b(paper|research|arxiv|study|studies)\b|nghiên cứu|học thuật/iu.test(prompt)) candidates.push({ intent: "academic", text: `${prompt} primary paper methodology limitations` });
  if (/\b(compare|versus|vs|trade.?off)\b|so sánh/iu.test(prompt)) candidates.push({ intent: "comparison", text: `${prompt} reproducible benchmarks trade-offs` });
  if (/\b(latest|recent|current|today|news|update)\b|mới nhất|hiện tại|cập nhật|hôm nay/iu.test(prompt)) candidates.push({ intent: "freshness", text: `${prompt} updated as of ${input.now.slice(0, 10)}` });
  candidates.push({ intent: "primary", text: `${prompt} official documentation primary source` });
  candidates.push({ intent: "counter-evidence", text: `${prompt} limitations counter evidence corrections` });
  const seen = new Set<string>();
  const queries = candidates.filter((query) => {
    const key = query.text.normalize("NFKC").replace(/\s+/gu, " ").toLocaleLowerCase();
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).slice(0, policy.maxQueries).map((query) => {
    const hash = sha256Hex(query.text);
    return Object.freeze({ ...query, id: `research_query_${hash.slice(0, 24)}`, querySha256: hash });
  });
  const body = Object.freeze({ schemaVersion: 1 as const, adapterVersion: UPSTREAM_RESEARCH_ADAPTER_VERSION, promptSha256: sha256Hex(prompt), queries: Object.freeze(queries), policy, createdAt: input.now });
  const hash = planHash(body);
  return Object.freeze({ ...body, id: `research_plan_${hash.slice(0, 24)}`, planSha256: hash });
}

export interface ResearchSearchHit { readonly url: string; readonly title: string; }
export interface ResearchGatewaySearchResult {
  readonly receiptId: string;
  readonly hits: readonly ResearchSearchHit[];
}
export interface ResearchGatewayCapture {
  readonly receiptId: string;
  readonly finalUrl: string;
  readonly text: string;
  readonly retrievedAt: IsoTimestamp;
  readonly publishedAt?: IsoTimestamp;
  readonly updatedAt?: IsoTimestamp;
  readonly truncated: boolean;
}
export interface ResearchGatewayContext {
  readonly signal?: AbortSignal;
  readonly authorityReceiptId: string;
  readonly planId: string;
}
/** Implementations must enforce DNS, redirects, wire-byte limits and timeout at the transport boundary. */
export interface GroundedResearchGateway {
  readonly adapterId: string;
  readonly authorityReceiptId: string;
  readonly permission: "external-read-approved";
  search(query: ResearchExecutionQuery, maxResults: number, context: ResearchGatewayContext): Promise<ResearchGatewaySearchResult>;
  capture(url: string, maxCharacters: number, context: ResearchGatewayContext): Promise<ResearchGatewayCapture>;
}
export type ResearchStepStatus = "completed" | "failed" | "cancelled";
export interface ResearchQueryExecutionReceipt {
  readonly queryId: string;
  readonly querySha256: string;
  readonly status: ResearchStepStatus;
  readonly resultCount: number;
  readonly omittedResultCount: number;
  readonly gatewayReceiptId?: string;
}
export type ResearchSourceDisposition = ResearchStepStatus | "invalid-url" | "source-limit" | "context-budget" | "duplicate-content";
export interface ResearchSourceExecutionReceipt {
  readonly sourceId: string;
  readonly urlSha256: string;
  readonly queryIds: readonly string[];
  readonly disposition: ResearchSourceDisposition;
  readonly retainedCharacters: number;
  readonly truncated: boolean;
  readonly contentSha256?: string;
  readonly gatewayReceiptId?: string;
}
/** Content-free audit projection; raw queries, URLs, errors and source text live outside telemetry. */
export interface ResearchExecutionReceipt {
  readonly schemaVersion: 1;
  readonly planId: string;
  readonly planSha256: string;
  readonly adapterVersion: typeof UPSTREAM_RESEARCH_ADAPTER_VERSION;
  readonly gatewayAdapterId: string;
  readonly authorityReceiptId: string;
  readonly status: "completed" | "partial" | "cancelled";
  readonly queries: readonly ResearchQueryExecutionReceipt[];
  readonly sources: readonly ResearchSourceExecutionReceipt[];
  readonly retainedCharacters: number;
  readonly completedAt: IsoTimestamp;
  readonly receiptSha256: string;
}
export interface ResearchCapturedSource {
  readonly id: string;
  readonly url: string;
  readonly title: string;
  readonly text: string;
  readonly contentSha256: string;
  readonly queryIds: readonly string[];
  readonly retrievedAt: IsoTimestamp;
  readonly publishedAt?: IsoTimestamp;
  readonly updatedAt?: IsoTimestamp;
  readonly truncated: boolean;
}
export interface GroundedResearchResult {
  readonly plan: ResearchExecutionPlan;
  readonly sources: readonly ResearchCapturedSource[];
  readonly receipt: ResearchExecutionReceipt;
}

function safeWebUrl(value: string): string {
  assertDomain(typeof value === "string" && value.length <= 16_384, "invalid_argument", "Research URL is malformed or too long.");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Research URL is invalid."); }
  assertDomain((url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password, "permission_denied", "Research requires a credential-free HTTP(S) URL.");
  url.hash = "";
  return url.href;
}

/** All work is awaited; abort stops new calls and is passed to admitted calls. */
async function boundedMap<T, R>(values: readonly T[], concurrency: number, run: (value: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(values.length, concurrency) }, async () => {
    while (next < values.length) {
      const index = next++;
      results[index] = await run(values[index]!, index);
    }
  }));
  return results;
}

function validatePlan(plan: ResearchExecutionPlan): void {
  const { id, planSha256, ...body } = plan;
  assertDomain(plan.adapterVersion === UPSTREAM_RESEARCH_ADAPTER_VERSION && plan.schemaVersion === 1, "invalid_argument", "Unsupported research execution plan.");
  normalizePolicy(plan.policy);
  assertIsoTimestamp(plan.createdAt, "research plan time");
  assertDomain(plan.queries.length > 0 && plan.queries.length <= plan.policy.maxQueries, "invalid_argument", "Research query count exceeds policy.");
  const queryIds = new Set<string>();
  for (const query of plan.queries) {
    assertNonBlank(query.text, "research query", 8_256);
    assertDomain(query.querySha256 === sha256Hex(query.text) && query.id === `research_query_${query.querySha256.slice(0, 24)}` && !queryIds.has(query.id), "conflict", "Research query identity changed.");
    queryIds.add(query.id);
  }
  assertDomain(planSha256 === planHash(body) && id === `research_plan_${planSha256.slice(0, 24)}`, "conflict", "Research plan identity changed.");
}

/** Executes real search/capture callbacks and preserves deterministic admission order. */
export async function executeGroundedResearch(plan: ResearchExecutionPlan, gateway: GroundedResearchGateway, options: { readonly signal?: AbortSignal; readonly now?: () => IsoTimestamp } = {}): Promise<GroundedResearchResult> {
  validatePlan(plan);
  const adapterId = assertNonBlank(gateway.adapterId, "research gateway adapter ID", 200);
  const authorityReceiptId = assertNonBlank(gateway.authorityReceiptId, "research authority receipt ID", 200);
  assertDomain(gateway.permission === "external-read-approved", "permission_denied", "Research requires an approved external-read gateway.");
  const context: ResearchGatewayContext = Object.freeze({ authorityReceiptId, planId: plan.id, ...(options.signal === undefined ? {} : { signal: options.signal }) });
  const searched = await boundedMap(plan.queries, plan.policy.concurrency, async (query) => {
    const empty = (status: ResearchStepStatus) => ({ receipt: Object.freeze({ queryId: query.id, querySha256: query.querySha256, status, resultCount: 0, omittedResultCount: 0 }), hits: [] as readonly ResearchSearchHit[] });
    if (options.signal?.aborted) return empty("cancelled");
    try {
      const result = await gateway.search(query, plan.policy.maxResultsPerQuery, context);
      if (options.signal?.aborted) return empty("cancelled");
      const gatewayReceiptId = assertNonBlank(result.receiptId, "research search receipt ID", 200);
      assertDomain(Array.isArray(result.hits), "invalid_argument", "Research gateway returned malformed hits.");
      const hits = result.hits.slice(0, plan.policy.maxResultsPerQuery).map((hit) => Object.freeze({ url: hit.url, title: hit.title }));
      return { receipt: Object.freeze({ queryId: query.id, querySha256: query.querySha256, status: "completed" as const, resultCount: hits.length, omittedResultCount: result.hits.length - hits.length, gatewayReceiptId }), hits };
    } catch { return empty(options.signal?.aborted ? "cancelled" : "failed"); }
  });

  interface Candidate { id: string; url: string; title: string; queryIds: string[]; invalid: boolean; }
  const candidates: Candidate[] = [];
  const byUrl = new Map<string, Candidate>();
  searched.forEach((search, index) => {
    for (const hit of search.hits) {
      let url: string; let invalid = false;
      try { url = safeWebUrl(hit.url); assertNonBlank(hit.title, "research source title", 2_000); }
      catch { url = typeof hit.url === "string" ? hit.url.slice(0, 16_384) : "malformed-url"; invalid = true; }
      const key = `${invalid ? "invalid:" : ""}${url}`;
      const previous = byUrl.get(key);
      if (previous) { if (!previous.queryIds.includes(plan.queries[index]!.id)) previous.queryIds.push(plan.queries[index]!.id); continue; }
      const candidate = { id: `research_source_${sha256Hex(key).slice(0, 24)}`, url, title: typeof hit.title === "string" ? hit.title.trim().slice(0, 2_000) : "", queryIds: [plan.queries[index]!.id], invalid };
      byUrl.set(key, candidate); candidates.push(candidate);
    }
  });
  // Admission is decided before any await. This keeps source-limit receipts
  // deterministic even when individual gateway captures complete out of order.
  const admittedCandidates = candidates.slice(0, plan.policy.maxSources);
  const overflowReceipts = candidates.slice(plan.policy.maxSources).map((candidate) => Object.freeze({
    sourceId: candidate.id,
    urlSha256: sha256Hex(candidate.url),
    queryIds: Object.freeze([...candidate.queryIds]),
    disposition: "source-limit" as const,
    retainedCharacters: 0,
    truncated: false,
  }));
  const captures = await boundedMap<Candidate, { readonly receipt: ResearchSourceExecutionReceipt; readonly source?: ResearchCapturedSource }>(admittedCandidates, plan.policy.concurrency, async (candidate) => {
    const receipt = (disposition: ResearchSourceDisposition): ResearchSourceExecutionReceipt => Object.freeze({ sourceId: candidate.id, urlSha256: sha256Hex(candidate.url), queryIds: Object.freeze([...candidate.queryIds]), disposition, retainedCharacters: 0, truncated: false });
    if (options.signal?.aborted) return { receipt: receipt("cancelled") };
    if (candidate.invalid) return { receipt: receipt("invalid-url") };
    try {
      const captured = await gateway.capture(candidate.url, plan.policy.maxCharactersPerSource, context);
      if (options.signal?.aborted) return { receipt: receipt("cancelled") };
      const gatewayReceiptId = assertNonBlank(captured.receiptId, "research capture receipt ID", 200);
      const finalUrl = safeWebUrl(captured.finalUrl);
      assertIsoTimestamp(captured.retrievedAt, "research capture time");
      if (captured.publishedAt !== undefined) assertIsoTimestamp(captured.publishedAt, "research source publication time");
      if (captured.updatedAt !== undefined) assertIsoTimestamp(captured.updatedAt, "research source update time");
      assertDomain(typeof captured.text === "string" && captured.text.trim().length > 0 && typeof captured.truncated === "boolean", "invalid_argument", "Research gateway returned an empty or malformed capture.");
      const text = captured.text.slice(0, plan.policy.maxCharactersPerSource);
      const source: ResearchCapturedSource = Object.freeze({ id: candidate.id, url: finalUrl, title: candidate.title, text, contentSha256: sha256Hex(text), queryIds: Object.freeze([...candidate.queryIds]), retrievedAt: captured.retrievedAt, ...(captured.publishedAt === undefined ? {} : { publishedAt: captured.publishedAt }), ...(captured.updatedAt === undefined ? {} : { updatedAt: captured.updatedAt }), truncated: captured.truncated || text.length < captured.text.length });
      return { receipt: Object.freeze({ ...receipt("completed"), retainedCharacters: text.length, truncated: source.truncated, contentSha256: source.contentSha256, gatewayReceiptId }), source };
    } catch { return { receipt: receipt(options.signal?.aborted ? "cancelled" : "failed") }; }
  });
  let retainedCharacters = 0;
  const hashes = new Set<string>();
  const sources: ResearchCapturedSource[] = [];
  const sourceReceipts = [...captures.map(({ receipt, source }): ResearchSourceExecutionReceipt => {
    if (!source) return receipt;
    if (hashes.has(source.contentSha256)) return Object.freeze({ ...receipt, disposition: "duplicate-content", retainedCharacters: 0 });
    const remaining = plan.policy.maxTotalCharacters - retainedCharacters;
    if (remaining <= 0) return Object.freeze({ ...receipt, disposition: "context-budget", retainedCharacters: 0 });
    const text = source.text.slice(0, remaining);
    const retained = Object.freeze({ ...source, text, contentSha256: sha256Hex(text), truncated: source.truncated || text.length < source.text.length });
    hashes.add(source.contentSha256);
    retainedCharacters += text.length;
    sources.push(retained);
    return Object.freeze({ ...receipt, retainedCharacters: text.length, contentSha256: retained.contentSha256, truncated: retained.truncated });
  }), ...overflowReceipts];
  const queryReceipts = Object.freeze(searched.map((search) => search.receipt));
  const completedAt = options.now?.() ?? new Date().toISOString();
  assertIsoTimestamp(completedAt, "research completion time");
  assertDomain(Date.parse(completedAt) >= Date.parse(plan.createdAt), "invalid_argument", "Research completion cannot precede its plan.");
  const status = options.signal?.aborted ? "cancelled" : queryReceipts.some((receipt) => receipt.status !== "completed") || sourceReceipts.some((receipt) => receipt.disposition === "failed" || receipt.disposition === "invalid-url") || sources.length === 0 ? "partial" : "completed";
  const body = Object.freeze({ schemaVersion: 1 as const, planId: plan.id, planSha256: plan.planSha256, adapterVersion: UPSTREAM_RESEARCH_ADAPTER_VERSION, gatewayAdapterId: adapterId, authorityReceiptId, status, queries: queryReceipts, sources: Object.freeze(sourceReceipts), retainedCharacters, completedAt });
  return Object.freeze({ plan, sources: Object.freeze(sources), receipt: Object.freeze({ ...body, receiptSha256: sha256Hex(JSON.stringify(body)) }) });
}

export interface ResearchClaimSpan { readonly sourceId: string; readonly start: number; readonly end: number; readonly quote: string; }
export interface ResearchCitationClaim { readonly id: string; readonly text: string; readonly spans: readonly ResearchClaimSpan[]; }
/** Exact quote/span validation proves grounding, not the semantic truth of a claim. */
export function createResearchCitationReceipt(result: GroundedResearchResult, claims: readonly ResearchCitationClaim[]) {
  assertDomain(claims.length <= 1_000, "invalid_argument", "Research claim count exceeds the receipt limit.");
  const { receiptSha256, ...executionBody } = result.receipt;
  assertDomain(receiptSha256 === sha256Hex(JSON.stringify(executionBody)), "conflict", "Research execution receipt changed.");
  const ids = new Set<string>();
  const sources = new Map(result.sources.map((source) => [source.id, source]));
  assertDomain(sources.size === result.sources.length, "conflict", "Research captured source IDs must be unique.");
  for (const source of result.sources) {
    const admitted = result.receipt.sources.find((receipt) => receipt.sourceId === source.id && receipt.disposition === "completed");
    assertDomain(admitted !== undefined && admitted.contentSha256 === source.contentSha256 && admitted.retainedCharacters === source.text.length && source.contentSha256 === sha256Hex(source.text), "conflict", "Research source does not match its execution receipt.");
  }
  const entries = claims.map((claim) => {
    const id = assertNonBlank(claim.id, "research claim ID", 200);
    const text = assertNonBlank(claim.text, "research claim", 8_000);
    assertDomain(!ids.has(id), "conflict", "Research claim IDs must be unique."); ids.add(id);
    assertDomain(claim.spans.length <= 100, "invalid_argument", "Research claim span count exceeds the receipt limit.");
    const seenSpans = new Set<string>();
    const citations = claim.spans.map((span) => {
      const source = sources.get(span.sourceId);
      assertDomain(source !== undefined, "not_found", "Research citation references a source that was not captured.");
      assertDomain(source.contentSha256 === sha256Hex(source.text), "conflict", "Research source content changed after capture.");
      assertDomain(Number.isSafeInteger(span.start) && Number.isSafeInteger(span.end) && span.start >= 0 && span.end > span.start && span.end <= source.text.length, "invalid_argument", "Research citation span is outside retained source text.");
      assertDomain(span.quote.trim().length > 0 && source.text.slice(span.start, span.end) === span.quote, "conflict", "Research citation quote does not match its retained source span.");
      const key = `${span.sourceId}:${span.start}:${span.end}`;
      assertDomain(!seenSpans.has(key), "conflict", "Research citation span appears more than once."); seenSpans.add(key);
      return Object.freeze({ sourceId: source.id, sourceContentSha256: source.contentSha256, start: span.start, end: span.end, quoteSha256: sha256Hex(span.quote) });
    });
    return Object.freeze({ claimId: id, claimSha256: sha256Hex(text), grounding: citations.length > 0 ? "span-verified" as const : "unverified" as const, citations: Object.freeze(citations) });
  });
  const body = Object.freeze({ schemaVersion: 1 as const, executionReceiptSha256: result.receipt.receiptSha256, claims: Object.freeze(entries), spanVerifiedClaims: entries.filter((entry) => entry.grounding === "span-verified").length, totalClaims: entries.length });
  return Object.freeze({ ...body, receiptSha256: sha256Hex(JSON.stringify(body)) });
}
