import assert from "node:assert/strict";
import { processService01 } from "../src/services/svc_01.mjs";
import { quoteService02 } from "../src/services/svc_02.mjs";
import { shipService03 } from "../src/services/svc_03.mjs";

const res1 = processService01("ORD-1", {
  country: "jp",
  weightGrams: 400,
  items: [{ sku: "AB-1234", qty: 2, unitCents: 1000 }],
});
assert.equal(res1.ok, true);
assert.equal(res1.totals.subtotalCents, 2000);
assert.equal(res1.totals.taxCents, 200);

const q2 = quoteService02([{ sku: "CD-5678", qty: 1, unitCents: 1000 }], "VN", false);
assert.equal(q2.tax, 80);

const s3 = shipService03("ORD-3", 1200, "us");
assert.equal(s3.carrier, "UPS_GROUND");
assert.equal(s3.cost, 800);
console.log("PUBLIC_OK");
