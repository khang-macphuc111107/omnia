import crypto from "node:crypto";

export function verifyRequest({ key, method, path, tsSec, nonce, body, sigV2, sigV1, nowSec, usedNonces, allowLegacy = false }) {
  return false;
}
