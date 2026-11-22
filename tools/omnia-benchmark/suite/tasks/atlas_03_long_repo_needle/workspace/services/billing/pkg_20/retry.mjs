export const MAX_RETRY_DELAY_MS = 30000;
export function computeRetryDelay20(attempt) {
  return Math.min(500 * (2 ** attempt), MAX_RETRY_DELAY_MS);
}
