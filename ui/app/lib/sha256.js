// Omnia Studio UI — SHA-256 (FIPS 180-4), pure and dependency free.
//
//   sha256Hex('abc')                     → hex of the UTF-8 bytes (sync, pure JS)
//   sha256Bytes(uint8array)              → hex (sync, pure JS)
//   await digestBytes(arrayBufferOrU8)   → hex; uses crypto.subtle when available
//                                          (secure contexts) and falls back to the pure
//                                          implementation otherwise.
// No DOM access: usable from node tests.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

const rotr = (x, n) => (x >>> n) | (x << (32 - n));

/** Pure SHA-256 over bytes; processes the input in place without copying the whole message. */
export function sha256Bytes(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const length = bytes.length;
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);

  const compress = (view, offset) => {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h[0];
    let b = h[1];
    let c = h[2];
    let d = h[3];
    let e = h[4];
    let f = h[5];
    let g = h[6];
    let hh = h[7];
    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  };

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fullBlocks = Math.floor(length / 64);
  for (let block = 0; block < fullBlocks; block += 1) compress(view, block * 64);

  // Tail: remaining bytes + 0x80 + zero padding + 64-bit big-endian bit length.
  const rest = length - fullBlocks * 64;
  const tailLength = rest + 9 <= 64 ? 64 : 128;
  const tail = new Uint8Array(tailLength);
  tail.set(bytes.subarray(fullBlocks * 64), 0);
  tail[rest] = 0x80;
  const tailView = new DataView(tail.buffer);
  tailView.setUint32(tailLength - 8, Math.floor((length * 8) / 0x100000000), false);
  tailView.setUint32(tailLength - 4, (length * 8) >>> 0, false);
  for (let offset = 0; offset < tailLength; offset += 64) compress(tailView, offset);

  let out = '';
  for (let i = 0; i < 8; i += 1) out += h[i].toString(16).padStart(8, '0');
  return out;
}

export function utf8Bytes(text) {
  return new TextEncoder().encode(String(text ?? ''));
}

export function sha256Hex(text) {
  return sha256Bytes(utf8Bytes(text));
}

function toHex(buffer) {
  const view = new Uint8Array(buffer);
  let out = '';
  for (let i = 0; i < view.length; i += 1) out += view[i].toString(16).padStart(2, '0');
  return out;
}

/** SHA-256 of real bytes: crypto.subtle when available, pure JS otherwise. Resolves to hex. */
export async function digestBytes(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const subtle = typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.subtle;
  if (subtle && typeof subtle.digest === 'function') {
    try {
      return toHex(await subtle.digest('SHA-256', bytes));
    } catch {
      // not a secure context or digest refused: use the pure implementation
    }
  }
  return sha256Bytes(bytes);
}
