import { validateOrder, computeOrderTotal, formatAuditRecord } from "../monolith.mjs";

export function processService10(orderId, order) {
  const v = validateOrder(order);
  if (!v.ok) return { ok: false, reason: v.reason };
  const totals = computeOrderTotal(order);
  return { ok: true, audit: formatAuditRecord(orderId, order, totals), totals };
}
