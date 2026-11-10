#!/usr/bin/env node

import process from "node:process";
import { pathToFileURL } from "node:url";

const SHA = /^[a-f0-9]{40}$/i;
const REPO = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;
export const EXIT_CODES = Object.freeze({ success: 0, failure: 1, pending: 2, missing: 3, error: 4, timeout: 5, cancelled: 130 });
const HELP = `Read-only GitHub check monitor (Node 22+; no GitHub CLI required).

Usage:
  node scripts/ci/check-github-status.mjs --repo OWNER/REPO --sha FULL_SHA [options]
  node scripts/ci/check-github-status.mjs --repo OWNER/REPO --pr NUMBER [--sha FULL_SHA] [options]

Options:
  --expect NAME             Expected check-run name or status context; repeatable
  --only-expected           Evaluate only explicit expected names (requires --expect)
  --wait                    Poll until terminal or a bound is reached
  --interval-seconds N      Poll interval, 1..60 (default 15)
  --timeout-seconds N       Total request/poll deadline, 1..3600 (default 600)
  --max-attempts N          Maximum snapshots, 1..240 (default 40)
  --request-timeout-seconds N  Per-request deadline, 1..60 (default 20)
  --json                    Print one JSON result, with no progress output
  --help                    Show this help

Authentication: optional GH_TOKEN or GITHUB_TOKEN environment variable. Tokens
are sent only to https://api.github.com. No comments, reruns, or other writes.
PR scope pins its current head SHA and rejects movement, including during reads.
Without --expect, success covers only reported checks; required-check policy is
not inferred. No checks is missing, and skipped/neutral results stay visible.
Expected checks must succeed; skipped/neutral expected checks fail. Release
gates can use --only-expected to exclude their own in-progress check while
requiring every named prerequisite at the same immutable SHA.

Exit codes: 0 success, 1 failed check, 2 pending, 3 missing checks,
            4 input/API/scope error, 5 polling deadline/attempt limit, 130 cancelled.
`;

class MonitorError extends Error {
  constructor(message, code = "error") {
    super(message);
    this.code = code;
  }
}

function boundedInteger(value, name, minimum, maximum) {
  if (!/^\d+$/.test(String(value))) throw new MonitorError(`${name} must be an integer from ${minimum} to ${maximum}`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new MonitorError(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return number;
}

export function parseOptions(args) {
  const options = {
    expected: [], wait: false, json: false, onlyExpected: false, intervalSeconds: 15,
    timeoutSeconds: 600, maxAttempts: 40, requestTimeoutSeconds: 20,
  };
  const values = new Map([
    ["--repo", "repo"], ["--sha", "sha"], ["--pr", "pr"], ["--expect", "expected"],
    ["--interval-seconds", "intervalSeconds"], ["--timeout-seconds", "timeoutSeconds"],
    ["--max-attempts", "maxAttempts"], ["--request-timeout-seconds", "requestTimeoutSeconds"],
  ]);
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (["--help", "--wait", "--json", "--only-expected"].includes(flag)) {
      options[flag === "--only-expected" ? "onlyExpected" : flag.slice(2)] = true;
      continue;
    }
    const key = values.get(flag);
    if (!key || index + 1 >= args.length || args[index + 1].startsWith("--")) {
      throw new MonitorError("Unknown option or missing value; use --help");
    }
    if (key !== "expected" && seen.has(key)) throw new MonitorError("Duplicate option; use --help");
    seen.add(key);
    const value = args[++index];
    if (key === "expected") options.expected.push(value);
    else options[key] = value;
  }
  if (options.help) return options;
  if (!REPO.test(options.repo ?? "") || options.repo.split("/").some((part) => part === "." || part === "..")) {
    throw new MonitorError("--repo must be OWNER/REPO");
  }
  if (!options.sha && !options.pr) throw new MonitorError("Provide an explicit --sha or --pr");
  if (options.sha && !SHA.test(options.sha)) throw new MonitorError("--sha must be a full 40-character commit SHA");
  if (options.sha) options.sha = options.sha.toLowerCase();
  if (options.pr !== undefined) options.pr = boundedInteger(options.pr, "--pr", 1, Number.MAX_SAFE_INTEGER);
  options.intervalSeconds = boundedInteger(options.intervalSeconds, "--interval-seconds", 1, 60);
  options.timeoutSeconds = boundedInteger(options.timeoutSeconds, "--timeout-seconds", 1, 3600);
  options.maxAttempts = boundedInteger(options.maxAttempts, "--max-attempts", 1, 240);
  options.requestTimeoutSeconds = boundedInteger(options.requestTimeoutSeconds, "--request-timeout-seconds", 1, 60);
  if (options.expected.some((name) => typeof name !== "string" || !name.trim() || name.length > 256 || /[\x00-\x1f\x7f]/.test(name))) {
    throw new MonitorError("--expect must contain a nonempty check name without control characters (maximum 256 characters)");
  }
  options.expected = [...new Set(options.expected)];
  if (options.onlyExpected && options.expected.length === 0) {
    throw new MonitorError("--only-expected requires at least one --expect name");
  }
  return options;
}

function safeText(value, secrets = []) {
  let result = String(value ?? "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
  for (const secret of secrets.filter(Boolean)) {
    for (const spelling of new Set([secret, encodeURIComponent(secret)])) result = result.split(spelling).join("[REDACTED]");
  }
  result = result.replace(/(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+/g, "[REDACTED]");
  return result.slice(0, 800);
}

function safeLink(value, secrets) {
  if (typeof value !== "string") return null;
  try {
    const link = new URL(value);
    if (link.protocol !== "https:" || link.username || link.password) return null;
    link.search = "";
    link.hash = "";
    return safeText(link.href, secrets);
  } catch {
    return null;
  }
}

export function createGithubClient({ token, secrets = [], fetchImpl = globalThis.fetch, signal, deadline, now = Date.now, requestTimeoutMs = 20000 } = {}) {
  const privateValues = [...new Set([token, ...secrets].filter(Boolean))];
  const scrub = (value) => safeText(value, privateValues);
  async function get(endpoint) {
    if (!endpoint.startsWith("/repos/") || endpoint.split("?")[0].split("/").some((part) => part === "." || part === "..") || endpoint.includes("\\")) {
      throw new MonitorError("Invalid GitHub API path");
    }
    if (signal?.aborted) throw new MonitorError("Monitoring cancelled", "cancelled");
    const remaining = deadline === undefined ? requestTimeoutMs : Math.min(requestTimeoutMs, deadline - now());
    if (remaining <= 0) throw new MonitorError("Monitoring deadline reached", "timeout");
    const timeoutSignal = AbortSignal.timeout(Math.max(1, Math.ceil(remaining)));
    const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    let response;
    try {
      response = await fetchImpl(`https://api.github.com${endpoint}`, {
        method: "GET", redirect: "error", signal: requestSignal,
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "omnia-read-only-ci-monitor",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });
      if (!response.ok) {
        const code = response.status;
        const reason = code === 401 ? "authentication rejected" : code === 403 || code === 429
          ? "permission denied or rate limited" : code === 404 ? "repository, PR, commit, or checks not accessible" : "request failed";
        // Deliberately omit response bodies and transport error strings: either
        // can echo authorization data or untrusted provider content.
        throw new MonitorError(`GitHub API HTTP ${code}: ${reason}`);
      }
      return await response.json();
    } catch (error) {
      if (signal?.aborted) throw new MonitorError("Monitoring cancelled", "cancelled");
      if (deadline !== undefined && now() >= deadline) throw new MonitorError("Monitoring deadline reached", "timeout");
      if (error instanceof MonitorError) throw error;
      if (timeoutSignal.aborted) throw new MonitorError("GitHub API request timed out");
      if (error instanceof SyntaxError) throw new MonitorError("GitHub API returned invalid JSON");
      throw new MonitorError("GitHub API transport failed");
    }
  }
  async function list(endpoint, key) {
    const result = [];
    const seenIds = new Set();
    let expectedTotal;
    for (let page = 1; page <= 100; page += 1) {
      const body = await get(`${endpoint}${endpoint.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
      const items = key ? body?.[key] : body;
      if (!Array.isArray(items)) throw new MonitorError("GitHub API returned an invalid collection");
      if (items.length > 100) throw new MonitorError("GitHub API returned inconsistent pagination");
      for (const item of items) {
        if (!Number.isSafeInteger(item?.id) || seenIds.has(item.id)) throw new MonitorError("GitHub API returned invalid or duplicate IDs during pagination");
        seenIds.add(item.id);
      }
      result.push(...items);
      const total = key ? body.total_count : undefined;
      if (key && (!Number.isSafeInteger(total) || total < 0 || total < result.length || (expectedTotal !== undefined && total !== expectedTotal))) {
        throw new MonitorError("GitHub API returned inconsistent pagination");
      }
      expectedTotal ??= total;
      if ((key && result.length >= total) || (!key && items.length < 100)) return result;
      if (items.length === 0) throw new MonitorError("GitHub API returned incomplete pagination");
    }
    throw new MonitorError("GitHub API pagination exceeded 100 pages; results are incomplete");
  }
  return { get, list, scrub, link: (value) => safeLink(value, privateValues) };
}

function requireSha(value) {
  if (typeof value !== "string" || !SHA.test(value)) throw new MonitorError("GitHub API returned an invalid commit SHA");
  return value.toLowerCase();
}

async function readPr(client, options, pinnedSha) {
  const pr = await client.get(`/repos/${options.repo}/pulls/${options.pr}`);
  if (pr?.number !== options.pr || pr?.base?.repo?.full_name?.toLowerCase() !== options.repo.toLowerCase()) {
    throw new MonitorError("GitHub API returned a PR outside the requested repository or number");
  }
  const sha = requireSha(pr?.head?.sha);
  if ((options.sha && options.sha !== sha) || (pinnedSha && pinnedSha !== sha)) {
    throw new MonitorError("PR head changed or does not match the requested SHA; restart monitoring the current head");
  }
  return sha;
}

function classify(status, conclusion) {
  if (["queued", "in_progress", "pending", "waiting", "requested"].includes(status)) return "pending";
  if (status !== "completed") return "unknown";
  if (["success", "neutral", "skipped"].includes(conclusion)) return conclusion;
  if (["failure", "cancelled", "timed_out", "action_required", "stale", "startup_failure"].includes(conclusion)) return "failure";
  return "unknown";
}

function newer(left, right) {
  return Number(left.id) > Number(right.id) ? left : right;
}

export async function collectSnapshot(client, options, pinnedSha) {
  const sha = options.pr ? await readPr(client, options, pinnedSha) : requireSha(options.sha);
  const prefix = `/repos/${options.repo}/commits/${sha}`;
  // These independent reads intentionally share the same immutable full SHA.
  const reads = await Promise.allSettled([
    client.get(prefix),
    client.list(`${prefix}/check-runs?filter=latest`, "check_runs"),
    client.list(`${prefix}/check-suites`, "check_suites"),
    client.list(`${prefix}/statuses`),
  ]);
  for (const result of reads) if (result.status === "rejected") throw result.reason;
  const [commit, runs, suites, statuses] = reads.map((result) => result.value);
  if (requireSha(commit?.sha) !== sha) throw new MonitorError("GitHub returned a commit outside the requested SHA");
  if (options.pr) await readPr(client, options, sha);
  let records = [];
  const latestRuns = new Map();
  for (const run of runs) {
    if (requireSha(run?.head_sha) !== sha) throw new MonitorError("GitHub returned a check outside the requested SHA");
    if (!Number.isSafeInteger(run?.id) || typeof run.name !== "string" || !run.name || !Number.isSafeInteger(run.app?.id) || !Number.isSafeInteger(run.check_suite?.id)) {
      throw new MonitorError("GitHub API returned an invalid check run");
    }
    const key = `${run.app.id}:${run.check_suite.id}:${run.name}`;
    latestRuns.set(key, latestRuns.has(key) ? newer(run, latestRuns.get(key)) : run);
  }
  for (const run of latestRuns.values()) records.push({
    kind: "check", id: run.id, name: client.scrub(run.name), matchName: run.name,
    app: client.scrub(run.app.slug ?? run.app.name ?? String(run.app.id)),
    state: classify(run.status, run.conclusion), status: client.scrub(run.status),
    conclusion: run.conclusion == null ? null : client.scrub(run.conclusion),
    url: client.link(run.html_url ?? run.details_url),
  });
  // A workflow can be queued, waiting, or fail to start before creating any jobs.
  for (const suite of suites) {
    if (requireSha(suite?.head_sha) !== sha) throw new MonitorError("GitHub returned a suite outside the requested SHA");
    if (!Number.isSafeInteger(suite.id) || !Number.isSafeInteger(suite.app?.id)) throw new MonitorError("GitHub API returned an invalid check suite");
    const state = classify(suite.status, suite.conclusion);
    if (state !== "success" && state !== "skipped" && state !== "neutral") records.push({
      kind: "suite", id: suite.id, name: client.scrub(`${suite.app.slug ?? suite.app.name ?? suite.app.id} suite ${suite.id}`),
      app: client.scrub(suite.app.slug ?? suite.app.name ?? String(suite.app.id)),
      state, status: client.scrub(suite.status), conclusion: suite.conclusion == null ? null : client.scrub(suite.conclusion),
      url: `https://github.com/${options.repo}/commit/${sha}/checks`,
    });
  }
  const latestStatuses = new Map();
  for (const status of statuses) {
    if (!Number.isSafeInteger(status?.id) || typeof status.context !== "string" || !status.context) throw new MonitorError("GitHub API returned an invalid commit status");
    latestStatuses.set(status.context, latestStatuses.has(status.context) ? newer(status, latestStatuses.get(status.context)) : status);
  }
  for (const status of latestStatuses.values()) records.push({
    kind: "status", id: status.id, name: client.scrub(status.context), matchName: status.context,
    app: "commit-status", state: status.state === "success" ? "success" : status.state === "pending"
      ? "pending" : ["failure", "error"].includes(status.state) ? "failure" : "unknown",
    status: client.scrub(status.state), conclusion: null, url: client.link(status.target_url),
  });
  const ignoredCount = options.onlyExpected
    ? records.filter((record) => !options.expected.includes(record.matchName)).length : 0;
  if (options.onlyExpected) records = records.filter((record) => options.expected.includes(record.matchName));
  const missing = options.expected.filter((name) => !records.some((record) => record.matchName === name));
  const counts = Object.fromEntries(["success", "neutral", "skipped", "failure", "pending", "unknown"].map((state) => [state, records.filter((record) => record.state === state).length]));
  const reported = records.filter((record) => record.kind !== "suite").length;
  // Neutral and skipped are useful descriptive states for informational
  // checks, but an explicitly expected required check must be successful.
  // Keep the original state in `checks` so the operator can diagnose why.
  const requiredNonSuccess = records.some((record) =>
    options.expected.includes(record.matchName) && ["neutral", "skipped"].includes(record.state));
  const state = counts.failure || requiredNonSuccess ? "failure" : counts.unknown ? "error" : counts.pending ? "pending"
    : missing.length || reported === 0 ? "missing" : "success";
  return {
    repo: options.repo, sha, pr: options.pr ?? null, state, counts, ignoredCount,
    expected: options.expected.map(client.scrub), missing: missing.map(client.scrub),
    checks: records.map(({ matchName, ...record }) => record).sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id),
    url: options.pr ? `https://github.com/${options.repo}/pull/${options.pr}/checks` : `https://github.com/${options.repo}/commit/${sha}/checks`,
    coverage: options.onlyExpected ? "Only explicit expected names at the pinned SHA; other checks and suites excluded; required branch policy is not inferred"
      : options.expected.length ? "Explicit expected names and all reported checks; required branch policy is not inferred"
      : "Reported checks only; required branch policy is not inferred",
  };
}

function pause(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new MonitorError("Monitoring cancelled", "cancelled"));
    const timer = setTimeout(finish, milliseconds);
    function finish() { signal?.removeEventListener("abort", cancel); resolve(); }
    function cancel() { clearTimeout(timer); reject(new MonitorError("Monitoring cancelled", "cancelled")); }
    signal?.addEventListener("abort", cancel, { once: true });
  });
}

export async function monitorChecks(options, dependencies = {}) {
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? pause;
  const started = now();
  const deadline = started + options.timeoutSeconds * 1000;
  const client = createGithubClient({ ...dependencies, deadline, now, requestTimeoutMs: options.requestTimeoutSeconds * 1000 });
  let last = null;
  let attempts = 0;
  const result = (state, reason) => ({
    ...(last ?? { repo: options.repo, sha: options.sha ?? null, pr: options.pr ?? null, checks: [], missing: [], expected: options.expected.map(client.scrub) }),
    state, exitCode: EXIT_CODES[state], reason, attempts, elapsedMs: Math.max(0, now() - started),
    observedAt: new Date(now()).toISOString(),
  });
  try {
    for (;;) {
      if (dependencies.signal?.aborted) return result("cancelled", "Monitoring cancelled");
      if (now() >= deadline) return result("timeout", "Monitoring deadline reached");
      attempts += 1;
      last = await collectSnapshot(client, options, last?.sha);
      dependencies.onSnapshot?.({ ...last, attempts });
      if (["success", "failure", "error"].includes(last.state) || !options.wait) {
        return result(last.state, last.state === "error" ? "A reported check has an unknown or incomplete terminal state" : "Snapshot collected");
      }
      if (attempts >= options.maxAttempts) return result("timeout", `Maximum ${options.maxAttempts} snapshots reached; last check state was ${last.state}`);
      const remaining = deadline - now();
      if (remaining <= 0) return result("timeout", "Monitoring deadline reached");
      await sleep(Math.min(options.intervalSeconds * 1000, remaining), dependencies.signal);
    }
  } catch (error) {
    const state = error instanceof MonitorError ? error.code : "error";
    return result(state, error instanceof MonitorError ? client.scrub(error.message) : "Monitoring failed without a complete snapshot");
  }
}

export function formatSummary(result) {
  const lines = [`GitHub checks: ${result.state.toUpperCase()} — ${result.repo}${result.pr ? ` PR #${result.pr}` : ""} @ ${result.sha ?? "unresolved"}`];
  lines.push(`${result.reason} (${result.attempts} snapshot(s), ${result.elapsedMs}ms)`);
  if (result.url) lines.push(result.url);
  for (const check of result.checks) {
    lines.push(`- ${check.state.toUpperCase()} ${check.name} [${check.app}; ${check.status}${check.conclusion ? `/${check.conclusion}` : ""}]${check.url ? `\n  ${check.url}` : ""}`);
  }
  if (result.missing.length) lines.push(`Missing expected checks: ${result.missing.join(", ")}`);
  if (!result.checks.length && result.state === "missing") lines.push("No checks or commit statuses were reported; this is not success.");
  if (result.coverage) lines.push(`Scope: ${result.coverage}`);
  return lines.join("\n");
}

export async function runCli(args, dependencies = {}) {
  const stdout = dependencies.stdout ?? ((value) => process.stdout.write(value));
  const stderr = dependencies.stderr ?? ((value) => process.stderr.write(value));
  let options;
  try { options = parseOptions(args); }
  catch (error) { stderr(`GitHub status monitor: ${error.message}\n`); return EXIT_CODES.error; }
  if (options.help) { stdout(HELP); return EXIT_CODES.success; }
  const env = dependencies.env ?? process.env;
  const result = await monitorChecks(options, {
    ...dependencies, token: env.GH_TOKEN || env.GITHUB_TOKEN,
    secrets: [env.GH_TOKEN, env.GITHUB_TOKEN],
  });
  stdout(options.json ? `${JSON.stringify(result, null, 2)}\n` : `${formatSummary(result)}\n`);
  return result.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try { process.exitCode = await runCli(process.argv.slice(2), { signal: controller.signal }); }
  finally { process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); }
}
