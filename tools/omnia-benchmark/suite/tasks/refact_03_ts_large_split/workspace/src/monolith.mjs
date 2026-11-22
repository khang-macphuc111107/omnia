// Legacy Order Monolith (needs splitting into src/core/{validation,pricing,shipping,audit}.mjs)
const VALID_SKU_RE = /^[A-Z]{2,4}-\d{4,6}$/;
const TAX_RATES = { US: 0.0825, DE: 0.19, JP: 0.10, VN: 0.08, GB: 0.20 };

export function normalizeCountry(code) {
  return String(code || "US").trim().toUpperCase();
}

export function validateSku(sku) {
  return typeof sku === "string" && VALID_SKU_RE.test(sku.trim());
}

export function validateOrder(order) {
  if (!order || typeof order !== "object") return { ok: false, reason: "missing_order" };
  if (!Array.isArray(order.items) || order.items.length === 0) return { ok: false, reason: "empty_items" };
  for (const item of order.items) {
    if (!validateSku(item.sku)) return { ok: false, reason: `invalid_sku:${item.sku}` };
    if (!Number.isInteger(item.qty) || item.qty <= 0) return { ok: false, reason: "invalid_qty" };
    if (!Number.isInteger(item.unitCents) || item.unitCents < 0) return { ok: false, reason: "invalid_price" };
  }
  return { ok: true, country: normalizeCountry(order.country) };
}

export function computeSubtotal(items) {
  return items.reduce((acc, it) => acc + it.qty * it.unitCents, 0);
}

// BUG: ignores isTaxExempt and uses Math.floor instead of Math.round
export function computeTax(subtotalCents, country, isTaxExempt = false) {
  const rate = TAX_RATES[normalizeCountry(country)] ?? 0.05;
  return Math.floor(subtotalCents * rate);
}

export function computeOrderTotal(order) {
  const sub = computeSubtotal(order.items);
  const tax = computeTax(sub, order.country, Boolean(order.taxExempt));
  const ship = estimateShippingCents(order.weightGrams || 0, order.country);
  return { subtotalCents: sub, taxCents: tax, shippingCents: ship, totalCents: sub + tax + ship };
}

export function estimateShippingCents(weightGrams, country) {
  const c = normalizeCountry(country);
  const base = c === "US" ? 500 : c === "VN" ? 300 : 1200;
  const extra = Math.ceil(Math.max(0, weightGrams - 500) / 500) * 150;
  return base + extra;
}

export function selectCarrier(weightGrams, country) {
  const c = normalizeCountry(country);
  if (weightGrams > 10000) return "FREIGHT_X";
  return c === "US" ? "UPS_GROUND" : "DHL_EXPRESS";
}

export function computeOrderChecksum(orderId, totalCents) {
  let h = 2166136261 >>> 0;
  const s = `${orderId}:${totalCents}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export function formatAuditRecord(orderId, order, totals) {
  return {
    orderId,
    country: normalizeCountry(order.country),
    itemCount: order.items.length,
    totalCents: totals.totalCents,
    checksum: computeOrderChecksum(orderId, totals.totalCents),
  };
}
