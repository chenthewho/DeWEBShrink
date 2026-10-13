/* ==========================================================================
   node:crypto 的浏览器替身 —— 只实现这个项目用到的 sha256
   --------------------------------------------------------------------------
   src/scan.js 只用它做一件事：给每个文件算 sha256，用来发现「内容完全重复」
   的文件（重复内容要各自付费，所以要报给用户）。

   Node 的 crypto.createHash 是同步 API，代码里也是同步用的，所以这里不能用
   WebCrypto（那是异步的），改成一份纯 JS 实现。约 60 行，够用且可对拍。
   ========================================================================== */

"use strict";

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x, n) => (x >>> n) | (x << (32 - n));

function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  throw new TypeError("sha256 shim 只认 string / Uint8Array / ArrayBuffer");
}

function concat(parts) {
  if (parts.length === 1) return parts[0];
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function sha256Hex(bytes) {
  const len = bytes.length;
  const bitLen = len * 8;
  const padded = new Uint8Array(((len + 9 + 63) >> 6) << 6);
  padded.set(bytes);
  padded[len] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000));
  dv.setUint32(padded.length - 4, bitLen >>> 0);

  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);

  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15];
      const y = w[i - 2];
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }

    let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0;
      d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
    H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
  }

  let out = "";
  for (const v of H) out += (v >>> 0).toString(16).padStart(8, "0");
  return out;
}

/** 兼容 node:crypto 的 createHash(...).update(x).digest("hex")。 */
export function createHash(algo = "sha256") {
  if (String(algo).toLowerCase() !== "sha256") {
    throw new Error(`浏览器 shim 只实现了 sha256，收到「${algo}」`);
  }
  const parts = [];
  return {
    update(data) {
      parts.push(toBytes(data));
      return this;
    },
    digest(encoding = "hex") {
      const hex = sha256Hex(concat(parts));
      if (encoding === "hex") return hex;
      if (encoding === "base64" || encoding === "base64url") {
        const raw = new Uint8Array(hex.length / 2);
        for (let i = 0; i < raw.length; i++) raw[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
        let b64 = "";
        const B = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        for (let i = 0; i < raw.length; i += 3) {
          const n = (raw[i] << 16) | ((raw[i + 1] || 0) << 8) | (raw[i + 2] || 0);
          b64 += B[(n >> 18) & 63] + B[(n >> 12) & 63] + (i + 1 < raw.length ? B[(n >> 6) & 63] : "=") + (i + 2 < raw.length ? B[n & 63] : "=");
        }
        return encoding === "base64url" ? b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : b64;
      }
      throw new Error(`浏览器 shim 不支持 digest("${encoding}")`);
    },
  };
}

export default { createHash };
