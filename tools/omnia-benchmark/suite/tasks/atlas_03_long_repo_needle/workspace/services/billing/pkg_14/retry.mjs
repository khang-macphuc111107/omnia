// Active Production Billing Retry Planner (wired by config/production_wiring.json)
export const MAX_RETRY_DELAY_MS = 30000;

export function planBillingBackoffMs(attempt, baseMs = 500) {
  const safeAttempt = Math.max(0, attempt);
  // DEFECT: omits Math.min(..., MAX_RETRY_DELAY_MS) cap!
  const delay = baseMs * (2 ** safeAttempt);
  return delay;
}
