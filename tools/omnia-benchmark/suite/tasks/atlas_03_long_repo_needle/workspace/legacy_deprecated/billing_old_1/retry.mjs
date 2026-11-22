export const MAX_RETRY_DELAY_MS = 30000;
export function oldBackoff1(attempt) { return 500 * (2 ** attempt); }
