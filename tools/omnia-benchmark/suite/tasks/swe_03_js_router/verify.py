#!/usr/bin/env python3
"""Hidden verification script for swe_03_js_router."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys


TASK_ID = "swe_03_js_router"

NODE_HARNESS = r"""
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const workspace = process.env.VERIFY_WORKSPACE;
const routerUrl = pathToFileURL(path.join(workspace, 'src', 'router.mjs')).href;
const mod = await import(routerUrl);
const { Router, runPipeline } = mod;

const checks = [];

async function runCheck(name, group, fn) {
  try {
    await fn();
    checks.push({ name, passed: true, group, detail: 'ok' });
  } catch (err) {
    checks.push({
      name,
      passed: false,
      group,
      detail: `${err?.name || 'Error'}: ${err?.message || String(err)}`,
    });
  }
}

// --- PASS_TO_PASS ---
await runCheck('p2p_query_root_methods_and_400', 'pass_to_pass', async () => {
  const router = new Router();
  router.get('/', (_req, res) => res.json({ root: true }));
  router.post('/items', (req, res) => res.status(201).json({ body: req.body, tags: req.query.tag }));
  router.delete('/items/:id', (req, res) => res.status(204).send(null));

  const rRoot = await router.handle({ method: 'GET', url: '/' });
  assert.equal(rRoot.status, 200);
  assert.deepEqual(rRoot.body, { root: true });

  const rPost = await router.handle({
    method: 'POST',
    url: '/items?tag=a&tag=b',
    body: { x: 1 },
  });
  assert.equal(rPost.status, 201);
  assert.deepEqual(rPost.body, { body: { x: 1 }, tags: ['a', 'b'] });

  const rDel = await router.handle({ method: 'DELETE', url: '/items/99' });
  assert.equal(rDel.status, 204);

  const rBad = await router.handle({ method: 'GET', url: '/items/%ZZ' });
  assert.equal(rBad.status, 400);
});

await runCheck('p2p_sync_middleware_and_unhandled_500', 'pass_to_pass', async () => {
  const router = new Router();
  router.use((req, _res, next) => {
    req.steps = ['g1'];
    next();
  });
  router.get('/boom', () => {
    throw new Error('unhandled_sync');
  });
  const res = await router.handle({ method: 'GET', url: '/boom' });
  assert.equal(res.status, 500);
  assert.equal(res.body.error, 'unhandled_sync');
});

// --- FAIL_TO_PASS ---
await runCheck('f2p_static_dead_end_backtracks_to_param', 'fail_to_pass', async () => {
  const router = new Router();
  router.get('/users/profile/settings', (_req, res) => res.json({ route: 'static' }));
  router.get('/users/:id/posts', (req, res) => res.json({ route: 'param', id: req.params.id }));

  const rStatic = await router.handle({ method: 'GET', url: '/users/profile/settings' });
  assert.equal(rStatic.status, 200);
  assert.deepEqual(rStatic.body, { route: 'static' });

  const rBacktrack = await router.handle({ method: 'GET', url: '/users/profile/posts' });
  assert.equal(rBacktrack.status, 200);
  assert.deepEqual(rBacktrack.body, { route: 'param', id: 'profile' });
  assert.deepEqual(rBacktrack.params, { id: 'profile' });
});

await runCheck('f2p_method_and_deep_backtrack_to_param_and_wildcard', 'fail_to_pass', async () => {
  const router = new Router();
  router.post('/items/special', (_req, res) => res.json({ route: 'post-static' }));
  router.get('/items/:id', (req, res) => res.json({ route: 'get-param', id: req.params.id }));
  router.get('/api/v1/health', (_req, res) => res.json({ route: 'health' }));
  router.get('/api/*rest', (req, res) => res.json({ route: 'wildcard', rest: req.params.rest }));
  router.get('/v2/:tenant/billing/invoices', (req, res) =>
    res.json({ route: 'invoices', tenant: req.params.tenant })
  );
  router.get('/v2/*fallback', (req, res) =>
    res.json({ route: 'fallback', fallback: req.params.fallback, keys: Object.keys(req.params) })
  );

  const r1 = await router.handle({ method: 'GET', url: '/items/special' });
  assert.equal(r1.status, 200);
  assert.deepEqual(r1.body, { route: 'get-param', id: 'special' });

  const r2 = await router.handle({ method: 'GET', url: '/api/v1/unknown' });
  assert.equal(r2.status, 200);
  assert.deepEqual(r2.body, { route: 'wildcard', rest: 'v1/unknown' });

  const r3 = await router.handle({ method: 'GET', url: '/api/v1/health' });
  assert.equal(r3.status, 200);
  assert.deepEqual(r3.body, { route: 'health' });

  const r4 = await router.handle({ method: 'GET', url: '/v2/acme/billing/unknown' });
  assert.equal(r4.status, 200);
  assert.deepEqual(r4.body, {
    route: 'fallback',
    fallback: 'acme/billing/unknown',
    keys: ['fallback'],
  });
});

await runCheck('f2p_param_precedence_over_wildcard', 'fail_to_pass', async () => {
  const router = new Router();
  // Register wildcard FIRST to ensure precedence is structural, not insertion order
  router.get('/files/*path', (req, res) => res.json({ route: 'wildcard', path: req.params.path }));
  router.get('/files/:id', (req, res) => res.json({ route: 'param', id: req.params.id }));

  const rSingle = await router.handle({ method: 'GET', url: '/files/doc1' });
  assert.equal(rSingle.status, 200);
  assert.deepEqual(rSingle.body, { route: 'param', id: 'doc1' });

  const rNested = await router.handle({ method: 'GET', url: '/files/dir/doc1' });
  assert.equal(rNested.status, 200);
  assert.deepEqual(rNested.body, { route: 'wildcard', path: 'dir/doc1' });
});

await runCheck('f2p_percent_2f_decoded_per_segment', 'fail_to_pass', async () => {
  const router = new Router();
  router.get('/files/:filename/meta', (req, res) =>
    res.json({ filename: req.params.filename, dl: req.query.dl })
  );
  router.get('/repos/:owner/:repo/commits/:ref', (req, res) => res.json(req.params));

  const r1 = await router.handle({
    method: 'GET',
    url: '/files/docs%2F2026%2Freport.pdf/meta?dl=1',
  });
  assert.equal(r1.status, 200);
  assert.deepEqual(r1.body, { filename: 'docs/2026/report.pdf', dl: '1' });

  const r2 = await router.handle({
    method: 'GET',
    url: '/repos/org%2Fsub/my%2Frepo/commits/feat%2Ffix%201',
  });
  assert.equal(r2.status, 200);
  assert.deepEqual(r2.body, {
    owner: 'org/sub',
    repo: 'my/repo',
    ref: 'feat/fix 1',
  });
});

await runCheck('f2p_async_throw_and_reject_reach_error_middleware', 'fail_to_pass', async () => {
  const router = new Router();
  const trace = [];

  router.use(async (_req, _res, next) => {
    trace.push('mw_before');
    await Promise.resolve();
    next();
  });

  router.get(
    '/async-throw',
    async () => {
      trace.push('route_mw1');
      await Promise.resolve();
      throw new Error('async_db_down');
    },
    (_req, res) => {
      trace.push('should_not_run');
      res.status(200).json({ ok: true });
    }
  );

  router.get('/async-reject', () => {
    return Promise.reject(new Error('rejected_promise'));
  });

  router.use((err, _req, res, _next) => {
    trace.push(`err:${err.message}`);
    res.status(502).json({ caught: err.message });
  });

  const r1 = await router.handle({ method: 'GET', url: '/async-throw' });
  assert.equal(r1.status, 502);
  assert.deepEqual(r1.body, { caught: 'async_db_down' });
  assert.deepEqual(trace, ['mw_before', 'route_mw1', 'err:async_db_down']);

  const r2 = await router.handle({ method: 'GET', url: '/async-reject' });
  assert.equal(r2.status, 502);
  assert.deepEqual(r2.body, { caught: 'rejected_promise' });
});

await runCheck('f2p_chained_error_middlewares_and_recovery', 'fail_to_pass', async () => {
  // Part 1: Chained error middlewares via next(err) AND async throw in error middleware
  const router = new Router();
  const chain = [];

  router.get('/fail-chain', async () => {
    await Promise.resolve();
    throw new Error('origin');
  });

  router.use((err, _req, _res, next) => {
    chain.push(`e1:${err.message}`);
    err.code = 'E_ENRICHED';
    next(err);
  });

  router.use(async (err, _req, _res, _next) => {
    chain.push(`e2:${err.code}`);
    await Promise.resolve();
    throw new Error(`wrapped:${err.message}`);
  });

  router.use((err, _req, res, _next) => {
    chain.push(`e3:${err.message}`);
    res.status(503).json({ finalError: err.message, chain });
  });

  const r1 = await router.handle({ method: 'GET', url: '/fail-chain' });
  assert.equal(r1.status, 503);
  assert.deepEqual(r1.body, {
    finalError: 'wrapped:origin',
    chain: ['e1:origin', 'e2:E_ENRICHED', 'e3:wrapped:origin'],
  });

  // Part 2: Error recovery via next() resumes normal middleware
  const recTrace = [];
  const req = {};
  const res = { statusCode: 200, body: null };
  await runPipeline(
    [
      async () => {
        recTrace.push('m1');
        throw new Error('recoverable');
      },
      (_req, _res, next) => {
        recTrace.push('skipped_normal');
        next();
      },
      async (err, _req, _res, next) => {
        recTrace.push(`recover:${err.message}`);
        await Promise.resolve();
        next();
      },
      (_req, response) => {
        recTrace.push('resumed');
        response.body = 'ok';
      },
    ],
    req,
    res
  );
  assert.deepEqual(recTrace, ['m1', 'recover:recoverable', 'resumed']);
  assert.equal(res.body, 'ok');
});

process.stdout.write(JSON.stringify({ checks }));
"""


def find_node() -> str:
    node = shutil.which("node")
    if node:
        return node
    default = Path(r"C:\Program Files\nodejs\node.exe")
    if default.exists():
        return str(default)
    raise FileNotFoundError("node executable not found")


def run_checks(workspace: Path) -> dict:
    node_bin = find_node()
    checks: list[dict] = []

    # 1. Public baseline tests
    proc_pub = subprocess.run(
        [node_bin, "tests/basic.test.mjs"],
        cwd=str(workspace),
        capture_output=True,
        text=True,
        timeout=30,
    )
    checks.append(
        {
            "name": "p2p_public_basic_test",
            "passed": proc_pub.returncode == 0,
            "group": "pass_to_pass",
            "detail": "ok"
            if proc_pub.returncode == 0
            else f"rc={proc_pub.returncode}: {(proc_pub.stderr or proc_pub.stdout).strip()[:400]}",
        }
    )

    # 2. Hidden Node.js ESM harness
    env = os.environ.copy()
    env["VERIFY_WORKSPACE"] = str(workspace)
    proc_hid = subprocess.run(
        [node_bin, "--input-type=module", "-e", NODE_HARNESS],
        cwd=str(workspace),
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
    )
    if proc_hid.returncode != 0:
        return {
            "task_id": TASK_ID,
            "passed": False,
            "score": 0.0,
            "fail_to_pass": {"passed": 0, "total": 1},
            "pass_to_pass": {"passed": int(proc_pub.returncode == 0), "total": 1},
            "checks": checks,
            "error": f"Hidden node harness crashed (rc={proc_hid.returncode}): {proc_hid.stderr or proc_hid.stdout}",
        }

    data = json.loads(proc_hid.stdout)
    checks.extend(data["checks"])

    f2p = [c for c in checks if c["group"] == "fail_to_pass"]
    p2p = [c for c in checks if c["group"] == "pass_to_pass"]
    f2p_passed = sum(1 for c in f2p if c["passed"])
    p2p_passed = sum(1 for c in p2p if c["passed"])
    total = len(checks)
    total_passed = f2p_passed + p2p_passed
    passed = total > 0 and total_passed == total

    return {
        "task_id": TASK_ID,
        "passed": passed,
        "score": round(total_passed / total, 4) if total else 0.0,
        "fail_to_pass": {"passed": f2p_passed, "total": len(f2p)},
        "pass_to_pass": {"passed": p2p_passed, "total": len(p2p)},
        "checks": checks,
        "error": None,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workspace", required=True)
    args = parser.parse_args()
    result = run_checks(Path(args.workspace).resolve())
    print(json.dumps(result))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
