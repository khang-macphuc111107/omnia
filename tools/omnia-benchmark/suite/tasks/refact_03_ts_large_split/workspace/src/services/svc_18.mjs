import { normalizeCountry, estimateShippingCents, selectCarrier, computeOrderChecksum } from "../monolith.mjs";

export function shipService18(orderId, weightGrams, country) {
  const c = normalizeCountry(country);
  const cost = estimateShippingCents(weightGrams, c);
  return { country: c, carrier: selectCarrier(weightGrams, c), cost, sig: computeOrderChecksum(orderId, cost) };
}
