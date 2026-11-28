// Omnia Studio UI (fallback) — Pure /super-plan, /super-run, /boost, /auto-proceed & /super-cancel dispatcher.

export const SUPER_PROCEED_POLICIES = ['off', 'standard', 'full'];

function normalizePolicy(value, fallback = 'standard') {
  const s = String(value ?? '').trim().toLowerCase();
  return SUPER_PROCEED_POLICIES.includes(s) ? s : fallback;
}

/**
 * Parse a leading Super workflow slash command from composer text.
 * Returns null for ordinary messages or unrelated slash commands.
 */
export function parseSuperSlashCommand(input) {
  const raw = String(input ?? '').trim();
  const match = raw.match(/^(\/(?:super-plan|super-run|auto-proceed|super-cancel|boost))(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  const cmd = match[1].toLowerCase();
  const rest = (match[2] ?? '').trim();

  if (cmd === '/super-plan') {
    return { kind: 'plan', cmd, goal: rest, raw };
  }
  if (cmd === '/super-run' || cmd === '/boost') {
    return { kind: 'run', cmd, goal: rest, boost: cmd === '/boost', raw };
  }
  if (cmd === '/auto-proceed') {
    const arg = rest.toLowerCase();
    return {
      kind: 'proceed',
      cmd,
      policy: SUPER_PROCEED_POLICIES.includes(arg) ? arg : '',
      invalidArg: arg && !SUPER_PROCEED_POLICIES.includes(arg) ? arg : '',
      raw
    };
  }
  return { kind: 'cancel', cmd: '/super-cancel', runId: rest, raw };
}

/**
 * Dispatch a parsed Super workflow command against `client.super.*` and return a normalized receipt.
 */
export async function dispatchSuperSlashCommand(parsed, { client, sessionId = '' } = {}) {
  if (!parsed || typeof parsed !== 'object') {
    throw Object.assign(new Error('Missing parsed Super command'), { code: 'invalid_command' });
  }
  if (!client || !client.super) {
    throw Object.assign(new Error('Super API client unavailable'), { code: 'unavailable' });
  }

  if (parsed.kind === 'plan') {
    const goal = parsed.goal || 'Interactive unified /super-plan session';
    const payload = await client.super.plan({
      goal,
      prompt: goal,
      sessionId,
      autoProceed: 'off',
      goalPersistence: false,
      tokenBudget: null
    });
    return {
      ok: payload?.ok !== false,
      kind: 'plan',
      cmd: parsed.cmd,
      mode: 'super-plan',
      runId: String(payload?.runId ?? payload?.run_id ?? ''),
      phase: String(payload?.phase ?? 'hydrate-plan'),
      autoProceed: 'off',
      goalPersistence: false,
      approvalMode: String(payload?.approvalMode ?? payload?.approval_mode ?? 'interactive'),
      tokenBudget: null,
      boost: false,
      auditStreak: Number(payload?.auditStreak ?? payload?.audit_streak ?? 0) || 0,
      status: String(payload?.status ?? 'SUPER_PLAN_ACTIVE'),
      goal
    };
  }

  if (parsed.kind === 'run') {
    const isBoost = Boolean(parsed.boost);
    const goal = parsed.goal || (isBoost ? 'High-parallelism Boost execution' : 'Autonomous unified /super-run execution');
    const payload = await client.super.run({
      goal,
      prompt: goal,
      sessionId,
      autoProceed: 'full',
      goalPersistence: true,
      approvalMode: 'yolo',
      tokenBudget: null,
      boost: isBoost
    });
    return {
      ok: payload?.ok !== false,
      kind: 'run',
      cmd: parsed.cmd,
      mode: 'super-run',
      runId: String(payload?.runId ?? payload?.run_id ?? ''),
      phase: String(payload?.phase ?? (isBoost ? 'boost-swarm' : 'autonomous-run')),
      autoProceed: 'full',
      goalPersistence: true,
      approvalMode: 'yolo',
      tokenBudget: null,
      boost: isBoost,
      auditStreak: Number(payload?.auditStreak ?? payload?.audit_streak ?? 0) || 0,
      status: String(payload?.status ?? 'SUPER_RUN_ACTIVE'),
      goal
    };
  }

  if (parsed.kind === 'proceed') {
    if (parsed.invalidArg) {
      throw Object.assign(new Error(`Invalid AutoProceedPolicy "${parsed.invalidArg}" (use off | standard | full)`), {
        code: 'invalid_policy'
      });
    }
    const payload = parsed.policy ? await client.super.setProceed(parsed.policy) : await client.super.proceed();
    const policy = normalizePolicy(payload?.policy ?? payload?.autoProceed ?? payload?.auto_proceed, parsed.policy || 'standard');
    return {
      ok: payload?.ok !== false,
      kind: 'proceed',
      cmd: parsed.cmd,
      mode: 'auto-proceed',
      runId: '',
      phase: 'policy',
      autoProceed: policy,
      goalPersistence: policy === 'full',
      approvalMode: policy === 'full' ? 'yolo' : 'interactive',
      tokenBudget: null,
      boost: false,
      auditStreak: 0,
      status: `AUTO_PROCEED_${policy.toUpperCase()}`,
      goal: ''
    };
  }

  const payload = await client.super.cancel({
    runId: parsed.runId || undefined,
    sessionId
  });
  return {
    ok: payload?.ok !== false,
    kind: 'cancel',
    cmd: '/super-cancel',
    mode: 'cancelled',
    runId: String(payload?.runId ?? payload?.run_id ?? parsed.runId ?? ''),
    phase: 'cancelled',
    autoProceed: 'off',
    goalPersistence: false,
    approvalMode: 'interactive',
    tokenBudget: null,
    boost: false,
    auditStreak: 0,
    status: String(payload?.status ?? 'cancelled'),
    marker: String(payload?.marker ?? '<!-- GOAL_CANCELLED -->'),
    goal: ''
  };
}
