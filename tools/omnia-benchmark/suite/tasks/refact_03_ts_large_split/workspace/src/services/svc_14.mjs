import { validateSku, computeSubtotal, computeTax } from "../monolith.mjs";

export function quoteService14(items, country, taxExempt = false) {
  if (!items.every((x) => validateSku(x.sku))) throw new Error("bad_sku");
  const sub = computeSubtotal(items);
  const tax = computeTax(sub, country, taxExempt);
  return { sub, tax, grand: sub + tax };
}
