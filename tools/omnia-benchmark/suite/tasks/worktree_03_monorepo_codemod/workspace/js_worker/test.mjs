import test from "node:test";
import assert from "node:assert/strict";
import { verifyRequest } from "./verifier.mjs";

test("rejects unimplemented", () => {
  assert.equal(verifyRequest({ key: "k", method: "GET", path: "/", tsSec: 10, nonce: "n", body: "", sigV2: "x", nowSec: 10, usedNonces: new Set() }), false);
});
