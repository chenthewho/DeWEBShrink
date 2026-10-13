/* ==========================================================================
   src/optimize/images.js 的浏览器替身（PoC 版）
   --------------------------------------------------------------------------
   真实实现依赖 sharp / libvips（原生模块，浏览器里没有）。浏览器里我们只做
   **无损** 那一档，换来的是「零服务器、文件不出本机」：

     PNG  → @jsquash/oxipng（Rust oxipng 的 WASM 版，重编码为更小的无损 PNG）
     JPEG → 先不动（mozjpeg WASM 是下一步；PoC 不冒险）
     其他 → 原样返回

   与 sharp 版的差距必须说清楚：sharp 走的是 libimagequant 的**调色板量化**
   （本项目图标实测 -77%），oxipng 只是无损重压，通常只能再省几个百分点。
   所以浏览器版的图片收益明显小于服务器版 —— 这是「不用服务器」的代价之一。

   对外的接口与 src/optimize/images.js 保持一致（optimizeImage / convertImage /
   imageInfo / imageExtOf），这样 src/optimize/index.js 与 src/verify.js 一行都不用改。
   ========================================================================== */

"use strict";

import { optimise } from "@jsquash/oxipng";

/** 与 images.js 里那个 extOf 同款实现（改路径规则时两边一起改）。 */
function extOf(p) {
  const base = String(p).split("/").pop() || "";
  const i = base.lastIndexOf(".");
  return i <= 0 ? "" : base.slice(i + 1).toLowerCase();
}

function toU8(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  return null;
}

const ascii = (b, off, len) => String.fromCharCode(...b.subarray(off, off + len));
const u16be = (b, o) => (b[o] << 8) | b[o + 1];
const u32be = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const u16le = (b, o) => b[o] | (b[o + 1] << 8);
const u32le = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

/** PNG：读 IHDR + 找 tRNS（有 tRNS = 有透明像素）。 */
function pngInfo(b, out) {
  if (b.length < 26) return null;
  out.width = u32be(b, 16);
  out.height = u32be(b, 20);
  const colorType = b[25];
  out.hasAlpha = colorType === 4 || colorType === 6;
  if (!out.hasAlpha) {
    let off = 8;
    while (off + 8 <= b.length) {
      const len = u32be(b, off);
      const type = ascii(b, off + 4, 4);
      if (type === "tRNS") {
        out.hasAlpha = true;
        break;
      }
      if (type === "IDAT" || type === "IEND") break;
      off += 12 + len;
    }
  }
  return out;
}

/** JPEG：扫 SOF 段拿尺寸。 */
function jpegInfo(b, out) {
  let off = 2;
  while (off + 9 < b.length) {
    if (b[off] !== 0xff) {
      off++;
      continue;
    }
    const marker = b[off + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
      off += 2;
      continue;
    }
    const len = u16be(b, off + 2);
    const isSOF = (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf);
    if (isSOF) {
      out.height = u16be(b, off + 5);
      out.width = u16be(b, off + 7);
      out.hasAlpha = false;
      return out;
    }
    off += 2 + len;
  }
  return null;
}

function webpInfo(b, out) {
  const fourcc = ascii(b, 12, 4);
  if (fourcc === "VP8X") {
    out.width = u32le(b, 24) + 1;
    out.height = u32le(b, 27) + 1;
    out.hasAlpha = (b[20] & 0x10) !== 0;
    return out;
  }
  if (fourcc === "VP8L") {
    const bits = u32le(b, 21);
    out.width = (bits & 0x3fff) + 1;
    out.height = ((bits >> 14) & 0x3fff) + 1;
    out.hasAlpha = ((bits >> 28) & 1) === 1;
    return out;
  }
  if (fourcc === "VP8 ") {
    for (let i = 20; i + 10 < b.length; i++) {
      if (b[i] === 0x9d && b[i + 1] === 0x01 && b[i + 2] === 0x2a) {
        out.width = u16le(b, i + 3) & 0x3fff;
        out.height = u16le(b, i + 5) & 0x3fff;
        out.hasAlpha = false;
        return out;
      }
    }
  }
  return null;
}

/**
 * 图片元信息 —— 只解文件头，不解码像素（浏览器里 createImageBitmap 要真解码，
 * 而 verify 只需要宽高/格式，所以这里用头部解析，快且无内存压力）。
 * 返回结构与 sharp 版一致：{ width, height, format, hasAlpha, pages }。
 */
export async function imageInfo(input) {
  const b = toU8(input);
  if (!b || b.length < 12) return null;
  const out = { width: null, height: null, format: null, hasAlpha: false, pages: 1 };
  try {
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
      out.format = "png";
      return pngInfo(b, out);
    }
    if (b[0] === 0xff && b[1] === 0xd8) {
      out.format = "jpeg";
      return jpegInfo(b, out);
    }
    if (ascii(b, 0, 3) === "GIF") {
      out.format = "gif";
      out.width = u16le(b, 6);
      out.height = u16le(b, 8);
      return out;
    }
    if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") {
      out.format = "webp";
      return webpInfo(b, out);
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * 同格式无损优化。返回形状与 sharp 版一致：{ buffer, ext, from, to, psnr }。
 * 无损 ⇒ psnr = Infinity（sharp 版在调色板量化无损时也是 Infinity）。
 * 没变小就返回 null（调用方会保留原文）。
 */
export async function optimizeImage(input, filePath, opts = {}) {
  const ext = extOf(filePath);
  if (ext !== "png") return null;
  const src = toU8(input);
  if (!src) return null;
  try {
    const level = Math.min(6, Math.max(0, opts.oxipngLevel ?? 2));
    const out = new Uint8Array(await optimise(src, { level, interlace: false, optimiseAlpha: true }));
    if (out.length >= src.length) return null;
    return { buffer: out, ext: "png", from: src.length, to: out.length, psnr: Infinity };
  } catch {
    // oxipng 认不出的 PNG（少见格式/损坏）就当没压，绝不返回半成品
    return null;
  }
}

/** 转格式（WebP/AVIF）在 PoC 里不做 —— 需要编码器 WASM，且会改文件名与引用。 */
export async function convertImage() {
  return null;
}

export function imageExtOf(p) {
  return extOf(p);
}

/** 与真实实现同名导出，避免 import 出错（PoC 用不到调色板量化阶梯）。 */
export const IMAGE_DEFAULTS = Object.freeze({ psnrTarget: 42 });
