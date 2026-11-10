import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createGithubClient, formatSummary, monitorChecks, parseOptions, runCli } from "./check-github-status.mjs";

const monitorPath = fileURLToPath(new URL("./check-github-status.mjs", import.meta.url));

function command(args, extraEnvironment = {}) {
  const env = { ...process.env, ...extraEnvironment };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  return spawnSync(process.execPath, [monitorPath, ...args], {
    encoding: "utf8",
    env,
    windowsHide: true,
    timeout: 5000,
  });
}

test("CLI help works without credentials or a repository", () => {
  const result = command(["--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--repo/);
  assert.match(result.stdout, /--sha/);
  assert.match(result.stdout, /--pr/);
  assert.match(result.stdout, /--expect/);
  assert.match(result.stdout, /Exit codes/);
  assert.equal(result.stderr, "");
});

for (const args of [
  [],
  ["--sha", "a".repeat(40)],
  ["--repo", "khangmacphuc/omnia"],
  ["--repo", "khangmacphuc/omnia", "--sha", "main"],
  ["--repo", "khangmacphuc/omnia", "--sha", "abc1234"],
  ["--repo", "https://github.com/khangmacphuc/omnia", "--pr", "1"],
  ["--repo", "khangmacphuc/omnia", "--pr", "0"],
  ["--repo", "khangmacphuc/omnia", "--pr", "-1"],
  ["--repo", "khangmacphuc/omnia", "--pr", "1", "--timeout-seconds", "0"],
  ["--repo", "khangmacphuc/omnia", "--pr", "1", "--max-attempts", "0"],
  ["--repo", "khangmacphuc/omnia", "--pr", "1", "--interval-seconds", "61"],
  ["--repo", "khangmacphuc/omnia", "--pr", "1", "--unknown-option"],
  ["--repo", "khangmacphuc/omnia", "--pr", "1", "--pr", "2"],
  ["--repo", "khangmacphuc/omnia", "--pr", "1", "--expect", ""],
  ["--repo", "khangmacphuc/omnia", "--pr", "1", "--only-expected"],
]) {
  test(`CLI rejects unsafe or incomplete scope ${JSON.stringify(args)}`, () => {
    const result = command(args);
    assert.equal(result.status, 4, result.stderr);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /GitHub status monitor:/);
  });
}

const sha = "a".repeat(40);
const otherSha = "b".repeat(40);
const repo = "example/project";
const prefix = `/repos/${repo}/commits/${sha}`;

function options(args = []) {
  return parseOptions(["--repo", repo, "--sha", sha, ...args]);
}

function check(overrides = {}) {
  return {
    id: 10, name: "Renderer checks", head_sha: sha, status: "completed", conclusion: "success",
    app: { id: 1, slug: "github-actions" }, check_suite: { id: 20 },
    html_url: `https://github.com/${repo}/actions/runs/20/job/10`,
    ...overrides,
  };
}

function suite(overrides = {}) {
  return { id: 20, head_sha: sha, status: "completed", conclusion: "success", app: { id: 1, slug: "github-actions" }, ...overrides };
}

function commitStatus(overrides = {}) {
  return { id: 30, context: "external/build", state: "success", target_url: "https://ci.example.com/build/30", ...overrides };
}

// Only the HTTP boundary is replaced. Validation, pagination, classification,
// polling, scope checks, summaries, and CLI output are the actual production code.
function api({ runs = [check()], suites = [suite()], statuses = [], prHeads = [sha], override } = {}) {
  const calls = [];
  const counts = new Map();
  let prRead = 0;
  return {
    calls,
    fetchImpl: async (input, init) => {
      const url = new URL(input);
      const count = (counts.get(url.pathname) ?? 0) + 1;
      counts.set(url.pathname, count);
      calls.push({ url: url.href, init });
      const replacement = override?.(url, count, init);
      if (replacement !== undefined) return replacement;
      let body;
      if (url.pathname === `/repos/${repo}/pulls/7`) {
        body = { number: 7, base: { repo: { full_name: repo } }, head: { sha: prHeads[Math.min(prRead++, prHeads.length - 1)] } };
      } else if (url.pathname === prefix) body = { sha };
      else if (url.pathname === `${prefix}/check-runs`) {
        const values = typeof runs === "function" ? runs(count) : runs;
        const start = (Number(url.searchParams.get("page")) - 1) * 100;
        body = { total_count: values.length, check_runs: values.slice(start, start + 100) };
      } else if (url.pathname === `${prefix}/check-suites`) {
        const values = typeof suites === "function" ? suites(count) : suites;
        const start = (Number(url.searchParams.get("page")) - 1) * 100;
        body = { total_count: values.length, check_suites: values.slice(start, start + 100) };
      } else if (url.pathname === `${prefix}/statuses`) {
        const values = typeof statuses === "function" ? statuses(count) : statuses;
        const start = (Number(url.searchParams.get("page")) - 1) * 100;
        body = values.slice(start, start + 100);
      } else throw new Error(`Unexpected request ${url.pathname}`);
      return Response.json(body);
    },
  };
}

function clock() {
  let time = 1700000000000;
  const sleeps = [];
  return { now: () => time, sleeps, sleep: async (ms) => { sleeps.push(ms); time += ms; } };
}

test("all reported successful checks produce SHA-scoped success and useful links", async () => {
  const server = api({ statuses: [commitStatus()] });
  const result = await monitorChecks(options(["--expect", "Renderer checks", "--expect", "external/build"]), server);
  assert.equal(result.state, "success");
  assert.equal(result.exitCode, 0);
  assert.equal(result.sha, sha);
  assert.equal(result.attempts, 1);
  assert.equal(result.checks.length, 2);
  assert.equal(result.counts.success, 2);
  assert.deepEqual(result.missing, []);
  const summary = formatSummary(result);
  assert.match(summary, /SUCCESS/);
  assert.match(summary, /Renderer checks/);
  assert.ok(summary.includes(`https://github.com/${repo}/actions/runs/20/job/10`));
  for (const call of server.calls) {
    assert.equal(call.init.method, "GET");
    assert.equal(call.init.redirect, "error");
    assert.equal(new URL(call.url).origin, "https://api.github.com");
    assert.ok(new URL(call.url).pathname.startsWith(prefix));
  }
});

test("no checks is missing, never green", async () => {
  const result = await monitorChecks(options(), api({ runs: [], suites: [] }));
  assert.equal(result.state, "missing");
  assert.equal(result.exitCode, 3);
  assert.match(formatSummary(result), /No checks.*not success/);
});

test("an absent expected check stays missing even when another check passes", async () => {
  const result = await monitorChecks(options(["--expect", "Native checks"]), api());
  assert.equal(result.state, "missing");
  assert.deepEqual(result.missing, ["Native checks"]);
});

test("explicit expected scope excludes the release gate itself without excluding prerequisites", async () => {
  const result = await monitorChecks(options(["--expect", "Renderer checks", "--only-expected"]), api({
    runs: [check(), check({ id: 11, name: "Validate release candidate", status: "in_progress", conclusion: null })],
    suites: [suite({ status: "in_progress", conclusion: null })],
  }));
  assert.equal(result.state, "success");
  assert.equal(result.checks.length, 1);
  assert.equal(result.ignoredCount, 2);
  assert.match(result.coverage, /Only explicit expected names/);
});

test("explicit expected scope still fails closed for absent and failed prerequisites", async () => {
  const required = options(["--expect", "Native checks", "--only-expected"]);
  const missing = await monitorChecks(required, api());
  assert.equal(missing.state, "missing");
  assert.deepEqual(missing.missing, ["Native checks"]);
  const failed = await monitorChecks(required, api({ runs: [check({ name: "Native checks", conclusion: "failure" })] }));
  assert.equal(failed.state, "failure");
});

for (const status of ["queued", "in_progress", "pending", "waiting", "requested"]) {
  test(`a ${status} check remains pending with no conclusion`, async () => {
    const result = await monitorChecks(options(), api({ runs: [check({ status, conclusion: null })] }));
    assert.equal(result.state, "pending");
    assert.equal(result.exitCode, 2);
    assert.equal(result.checks[0].status, status);
  });
}

test("a queued suite with no job checks stays pending", async () => {
  const result = await monitorChecks(options(), api({ runs: [], suites: [suite({ status: "queued", conclusion: null })] }));
  assert.equal(result.state, "pending");
  assert.equal(result.checks[0].kind, "suite");
});

test("a suite startup failure is not hidden when no job checks exist", async () => {
  const result = await monitorChecks(options(), api({ runs: [], suites: [suite({ conclusion: "startup_failure" })] }));
  assert.equal(result.state, "failure");
  assert.equal(result.exitCode, 1);
});

for (const conclusion of ["failure", "cancelled", "timed_out", "action_required", "stale", "startup_failure"]) {
  test(`terminal ${conclusion} is a failure even alongside success`, async () => {
    const result = await monitorChecks(options(), api({ runs: [check(), check({ id: 11, name: "Native checks", conclusion })] }));
    assert.equal(result.state, "failure");
    assert.equal(result.counts.failure, 1);
  });
}

for (const conclusion of ["neutral", "skipped"]) {
  test(`${conclusion} follows GitHub pass semantics while retaining its explicit label`, async () => {
    const result = await monitorChecks(options(), api({ runs: [check({ conclusion })] }));
    assert.equal(result.state, "success");
    assert.equal(result.counts.success, 0);
    assert.equal(result.counts[conclusion], 1);
    assert.equal(result.checks[0].state, conclusion);
    assert.ok(formatSummary(result).includes(conclusion.toUpperCase()));
  });

  test(`an explicitly expected ${conclusion} check cannot establish verified success`, async () => {
    const result = await monitorChecks(options(["--expect", "Native checks"]), api({
      runs: [check(), check({ id: 11, name: "Native checks", conclusion })],
    }));
    assert.equal(result.state, "failure");
    assert.equal(result.exitCode, 1);
    assert.equal(result.counts[conclusion], 1);
    assert.deepEqual(result.missing, []);
    assert.ok(formatSummary(result).includes(conclusion.toUpperCase()));
  });

  test(`a successful expected check cannot hide a ${conclusion} match from another suite`, async () => {
    const result = await monitorChecks(options(["--expect", "Renderer checks"]), api({
      runs: [check(), check({ id: 11, check_suite: { id: 21 }, conclusion })],
    }));
    assert.equal(result.state, "failure");
    assert.equal(result.checks.length, 2);
  });
}

for (const bad of [{ status: "completed", conclusion: null }, { status: "surprise", conclusion: "success" }, { conclusion: "new-unknown-conclusion" }]) {
  test(`unknown check state fails closed ${JSON.stringify(bad)}`, async () => {
    const result = await monitorChecks(options(), api({ runs: [check(bad)] }));
    assert.equal(result.state, "error");
    assert.equal(result.exitCode, 4);
    assert.equal(result.checks[0].state, "unknown");
  });
}

test("a failing external commit status cannot be hidden by a passing check run", async () => {
  const result = await monitorChecks(options(), api({ statuses: [commitStatus({ state: "error" })] }));
  assert.equal(result.state, "failure");
  assert.equal(result.checks.find((row) => row.kind === "status").status, "error");
});

test("a newer status supersedes an older failure in the same context", async () => {
  const result = await monitorChecks(options(), api({ statuses: [commitStatus({ id: 29, state: "failure" }), commitStatus()] }));
  assert.equal(result.state, "success");
  assert.equal(result.checks.filter((row) => row.kind === "status").length, 1);
});

test("a newer check attempt replaces its stale failure within the same suite", async () => {
  const result = await monitorChecks(options(), api({ runs: [check({ id: 9, conclusion: "failure" }), check()] }));
  assert.equal(result.state, "success");
  assert.equal(result.checks.length, 1);
});

test("matching check names in distinct suites do not hide a failure", async () => {
  const result = await monitorChecks(options(), api({ runs: [check(), check({ id: 11, check_suite: { id: 21 }, conclusion: "failure" })] }));
  assert.equal(result.state, "failure");
  assert.equal(result.checks.length, 2);
});

test("check pagination discovers a failure after the first 100 checks", async () => {
  const runs = Array.from({ length: 101 }, (_, index) => check({ id: index + 100, name: `job ${index}`, conclusion: index === 100 ? "failure" : "success" }));
  const server = api({ runs });
  const result = await monitorChecks(options(), server);
  assert.equal(result.state, "failure");
  assert.equal(result.checks.length, 101);
  assert.ok(server.calls.some((call) => call.url.includes("check-runs") && call.url.includes("page=2")));
});

test("commit status pagination discovers contexts after the first page", async () => {
  const statuses = Array.from({ length: 101 }, (_, index) => commitStatus({ id: index + 100, context: `external ${index}`, state: index === 100 ? "pending" : "success" }));
  const result = await monitorChecks(options(), api({ statuses }));
  assert.equal(result.state, "pending");
  assert.equal(result.checks.length, 102);
});

for (const bad of [
  { runs: [check({ head_sha: otherSha })] },
  { suites: [suite({ head_sha: otherSha })] },
  { runs: [check({ app: null })] },
  { runs: [check({ id: "10" })] },
  { statuses: [commitStatus({ context: null })] },
]) {
  test(`invalid or cross-SHA API data cannot produce success ${JSON.stringify(bad)}`, async () => {
    const result = await monitorChecks(options(), api(bad));
    assert.equal(result.state, "error");
    assert.equal(result.exitCode, 4);
  });
}

for (const body of [
  { total_count: 1, check_runs: [] },
  { total_count: 0, check_runs: [check()] },
  { total_count: 1, check_runs: null },
]) {
  test(`incomplete or malformed pagination fails closed ${JSON.stringify(body)}`, async () => {
    const server = api({ override: (url) => url.pathname.endsWith("/check-runs") ? Response.json(body) : undefined });
    const result = await monitorChecks(options(), server);
    assert.equal(result.state, "error");
  });
}

test("PR scope resolves and verifies head before and after reading checks", async () => {
  const server = api();
  const result = await monitorChecks(parseOptions(["--repo", repo, "--pr", "7"]), server);
  assert.equal(result.state, "success");
  assert.equal(result.pr, 7);
  assert.equal(result.sha, sha);
  assert.equal(server.calls.filter((call) => call.url.endsWith("/pulls/7")).length, 2);
});

test("a mismatched explicit PR SHA fails before any check API read", async () => {
  const server = api();
  const result = await monitorChecks(parseOptions(["--repo", repo, "--sha", otherSha, "--pr", "7"]), server);
  assert.equal(result.state, "error");
  assert.equal(server.calls.length, 1);
});

test("PR head movement during a snapshot invalidates otherwise green checks", async () => {
  const result = await monitorChecks(parseOptions(["--repo", repo, "--pr", "7"]), api({ prHeads: [sha, otherSha] }));
  assert.equal(result.state, "error");
  assert.match(result.reason, /PR head changed/);
});

test("PR head movement between polls does not silently follow a new commit", async () => {
  const result = await monitorChecks(parseOptions(["--repo", repo, "--pr", "7", "--wait"]), {
    ...api({ runs: [check({ status: "queued", conclusion: null })], prHeads: [sha, sha, otherSha] }),
    ...clock(),
  });
  assert.equal(result.state, "error");
  assert.equal(result.sha, sha);
  assert.equal(result.attempts, 2);
});

test("wait polls pending checks to success with a bounded interval", async () => {
  const timer = clock();
  const result = await monitorChecks(options(["--wait"]), {
    ...api({ runs: (attempt) => [check(attempt === 1 ? { status: "queued", conclusion: null } : {})] }), ...timer,
  });
  assert.equal(result.state, "success");
  assert.equal(result.attempts, 2);
  assert.deepEqual(timer.sleeps, [15000]);
});

test("wait returns immediately on failure without blindly retrying", async () => {
  const timer = clock();
  const result = await monitorChecks(options(["--wait"]), { ...api({ runs: [check({ conclusion: "failure" })] }), ...timer });
  assert.equal(result.state, "failure");
  assert.equal(result.attempts, 1);
  assert.deepEqual(timer.sleeps, []);
});

test("missing expected checks keep waiting until max attempts and retain the missing list", async () => {
  const result = await monitorChecks(options(["--expect", "Missing native", "--wait", "--max-attempts", "2"]), { ...api(), ...clock() });
  assert.equal(result.state, "timeout");
  assert.equal(result.exitCode, 5);
  assert.equal(result.attempts, 2);
  assert.deepEqual(result.missing, ["Missing native"]);
});

test("total deadline bounds waiting and does not take another snapshot after expiry", async () => {
  const timer = clock();
  const result = await monitorChecks(options(["--wait", "--timeout-seconds", "1"]), {
    ...api({ runs: [], suites: [] }), ...timer,
  });
  assert.equal(result.state, "timeout");
  assert.equal(result.attempts, 1);
  assert.deepEqual(timer.sleeps, [1000]);
});

test("cancellation before monitoring makes no network requests", async () => {
  const controller = new AbortController();
  controller.abort();
  const server = api();
  const result = await monitorChecks(options(), { ...server, signal: controller.signal });
  assert.equal(result.state, "cancelled");
  assert.equal(result.exitCode, 130);
  assert.equal(server.calls.length, 0);
});

test("cancellation while polling ends before another snapshot", async () => {
  const controller = new AbortController();
  const result = await monitorChecks(options(["--wait"]), {
    ...api({ runs: [], suites: [] }), signal: controller.signal,
    sleep: async () => { controller.abort(); },
  });
  assert.equal(result.state, "cancelled");
  assert.equal(result.attempts, 1);
});

for (const status of [401, 403, 404, 429, 500]) {
  test(`HTTP ${status} stays an API error, not missing or a green result`, async () => {
    const server = api({ override: () => Response.json({ message: "secret error body" }, { status }) });
    const result = await monitorChecks(options(["--wait"]), server);
    assert.equal(result.state, "error");
    assert.match(result.reason, new RegExp(`HTTP ${status}`));
    assert.doesNotMatch(JSON.stringify(result), /secret error body/);
    assert.equal(result.attempts, 1);
  });
}

test("transport exceptions and malformed JSON cannot echo secrets", async () => {
  const secret = "private-token-in-error";
  for (const fetchImpl of [async () => { throw new Error(secret); }, async () => new Response(secret, { status: 200 })]) {
    const result = await monitorChecks(options(), { fetchImpl, token: secret });
    assert.equal(result.state, "error");
    assert.doesNotMatch(JSON.stringify(result), /private-token-in-error/);
  }
});

test("both environment tokens and token-like values are scrubbed from JSON and links", async () => {
  const firstSecret = "a-private-credential";
  const secondSecret = "another-private-credential";
  let output = "";
  let errorOutput = "";
  const server = api({ runs: [check({
    name: `${firstSecret} ${secondSecret} ghp_exampleToken123\u001b[31m`,
    html_url: `https://ci.example.com/${firstSecret}?access_token=${secondSecret}`,
  })] });
  const exit = await runCli(["--repo", repo, "--sha", sha, "--json"], {
    ...server, env: { GH_TOKEN: firstSecret, GITHUB_TOKEN: secondSecret },
    stdout: (value) => { output += value; }, stderr: (value) => { errorOutput += value; },
  });
  assert.equal(exit, 0);
  assert.equal(errorOutput, "");
  const result = JSON.parse(output);
  assert.equal(result.state, "success");
  for (const secret of [firstSecret, secondSecret, "ghp_exampleToken123", "access_token", "\u001b"]) assert.ok(!output.includes(secret));
  assert.match(output, /REDACTED/);
  for (const call of server.calls) assert.equal(call.init.headers.Authorization, `Bearer ${firstSecret}`);
});

test("untrusted non-HTTPS and credential-bearing links are omitted", async () => {
  for (const link of ["javascript:alert(1)", "http://insecure.example/", "https://name:password@example.com/"]) {
    const result = await monitorChecks(options(), api({ runs: [check({ html_url: link })] }));
    assert.equal(result.checks[0].url, null);
  }
});

test("per-request timeouts abort a stalled API request", async () => {
  const client = createGithubClient({
    requestTimeoutMs: 20,
    fetchImpl: (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    }),
  });
  // AbortSignal.timeout is unreferenced; keep this test alive independently.
  const keepAlive = setTimeout(() => {}, 200);
  try { await assert.rejects(client.get(prefix), /request timed out/); }
  finally { clearTimeout(keepAlive); }
});

test("overlapping check pages cannot double-count an ID and hide an unseen failure", async () => {
  const firstPage = Array.from({ length: 100 }, (_, index) => check({ id: index + 100, name: `job ${index}` }));
  const result = await monitorChecks(options(), api({ override: (url) => url.pathname.endsWith("/check-runs")
    ? Response.json({ total_count: 101, check_runs: url.searchParams.get("page") === "1" ? firstPage : [firstPage[0]] }) : undefined }));
  assert.equal(result.state, "error");
  assert.match(result.reason, /pagination|duplicate/i);
});

test("a shrinking collection during pagination cannot claim a complete green snapshot", async () => {
  const firstPage = Array.from({ length: 100 }, (_, index) => check({ id: index + 100, name: `job ${index}` }));
  const result = await monitorChecks(options(), api({ override: (url) => url.pathname.endsWith("/check-runs")
    ? Response.json(url.searchParams.get("page") === "1" ? { total_count: 101, check_runs: firstPage }
      : { total_count: 100, check_runs: [] }) : undefined }));
  assert.equal(result.state, "error");
});

test("token values cannot appear in validation failure output", async () => {
  let output = "";
  const secret = "ghp_neverPrintThisCredential";
  const exit = await runCli(["--repo", secret], { env: { GH_TOKEN: secret }, stderr: (value) => { output += value; } });
  assert.equal(exit, 4);
  assert.ok(!output.includes(secret));
});

test("cancelling an in-flight request aborts transport and reports cancellation", async () => {
  const controller = new AbortController();
  let invoked = 0;
  const result = await monitorChecks(options(), {
    signal: controller.signal,
    fetchImpl: async (url, init) => {
      invoked += 1;
      controller.abort();
      throw init.signal.reason;
    },
  });
  assert.equal(result.state, "cancelled");
  assert.equal(invoked, 1);
});

test("commit verification rejects an API response for another SHA", async () => {
  const result = await monitorChecks(options(), api({ override: (url) => url.pathname === prefix ? Response.json({ sha: otherSha }) : undefined }));
  assert.equal(result.state, "error");
  assert.match(result.reason, /outside the requested SHA/);
});

test("invalid repository or PR number returned by GitHub cannot establish PR scope", async () => {
  for (const body of [
    { number: 8, base: { repo: { full_name: repo } }, head: { sha } },
    { number: 7, base: { repo: { full_name: "other/project" } }, head: { sha } },
  ]) {
    const result = await monitorChecks(parseOptions(["--repo", repo, "--pr", "7"]), api({ override: () => Response.json(body) }));
    assert.equal(result.state, "error");
  }
});

test("valid repository names containing repeated dots remain readable", async () => {
  const client = createGithubClient({ fetchImpl: async () => Response.json({ sha }) });
  assert.deepEqual(await client.get(`/repos/example/project..archive/commits/${sha}`), { sha });
});

test("the API client rejects traversal segments before sending a request", async () => {
  let requests = 0;
  const client = createGithubClient({ fetchImpl: async () => { requests += 1; return Response.json({}); } });
  await assert.rejects(client.get("/repos/example/../pulls/7"), /Invalid GitHub API path/);
  assert.equal(requests, 0);
});

test("CLI entry point returns failure exit and serializable JSON for a failing check", () => {
  const fixtureCode = `globalThis.fetch=async(input)=>{const u=new URL(input);return Response.json(u.pathname.endsWith('/check-runs')?${JSON.stringify({ total_count: 1, check_runs: [check({ conclusion: "failure" })] })}:u.pathname.endsWith('/check-suites')?${JSON.stringify({ total_count: 1, check_suites: [suite({ conclusion: "failure" })] })}:u.pathname.endsWith('/statuses')?[]:{sha:'${sha}'})};`;
  const env = { ...process.env };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  const result = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(fixtureCode)}`, monitorPath,
    "--repo", repo, "--sha", sha, "--json"], { env, encoding: "utf8", windowsHide: true, timeout: 5000 });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stderr, "");
  const output = JSON.parse(result.stdout);
  assert.equal(output.state, "failure");
  assert.equal(output.sha, sha);
  assert.equal(output.exitCode, 1);
});
