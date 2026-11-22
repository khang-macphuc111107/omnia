# Task: Split Monolith into 4 Domain Modules & Migrate All 18 Service Callers

Refactor this Node.js ESM codebase (`package.json` uses `"type": "module"`):

1. Split `src/monolith.mjs` into 4 dedicated modules under `src/core/`:
   - `src/core/validation.mjs`: export `validateSku`, `validateOrder`, `normalizeCountry`
   - `src/core/pricing.mjs`: export `computeSubtotal`, `computeTax`, `computeOrderTotal`
   - `src/core/shipping.mjs`: export `estimateShippingCents`, `selectCarrier`
   - `src/core/audit.mjs`: export `formatAuditRecord`, `computeOrderChecksum`
2. **Fix a pricing bug during migration (`src/core/pricing.mjs`)**:
   In `computeTax(subtotalCents, country, isTaxExempt)`, tax-exempt orders MUST return `0` BEFORE applying the country rate, and non-exempt tax MUST use integer half-up rounding `Math.round(subtotalCents * rate)` (currently `Math.floor` undercharges fractional cents AND `isTaxExempt` is ignored!).
3. **Preserve backward compatibility in `src/monolith.mjs`**:
   Replace `src/monolith.mjs` with a slim re-export barrel (`<= 30` non-empty lines) that re-exports all 9 symbols from `./core/*.mjs` so external/legacy imports of `src/monolith.mjs` keep working identically.
4. **Migrate ALL 18 service files (`src/services/svc_01.mjs` .. `src/services/svc_18.mjs`)**:
   Every file in `src/services/` MUST import directly from `../core/<domain>.mjs` and have **ZERO** imports from `monolith.mjs`.

Run `node tests/public.test.mjs` to verify functionality.
