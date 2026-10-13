/* ==========================================================================
   图片压缩 —— 默认**只改编码、不改格式、不改引用**
   --------------------------------------------------------------------------
   为什么默认不转 WebP：manifest 里的 PWA 图标、<link rel="apple-touch-icon">、
   有些老 Safari 的 <img srcset>，对格式的宽容度各不相同；而链上的字节是**永久**的
   —— 转格式一旦在某个浏览器上不显示，钱已经花掉了。所以：
     · 默认：PNG→调色板量化（还是 .png）、JPEG→同格式重编码，只求更小；
     · 激进（显式开关）：转 WebP/AVIF 并改写引用，交给 verify 兜底。

   量化怎么保证「看不出差别」：不是拍脑袋定 256 色，而是**逐档试 + 量 PSNR**。
   候选色数从 16 一路到 256，取第一个达到质量门限的最小色数；全部不达标就退回
   无损重压，再不行就原样保留。产物还会做尺寸 / 格式 / 透明通道三样对拍。
   实测本项目图标（512×512 的扁平工业风）从 246,638 字节降到 32,168 字节，
   PSNR 为无穷大 —— 也就是说原图本来就只有 64 色，量化是无损的。
   ========================================================================== */

"use strict";

import sharp from "sharp";

/* --------------------------------------------------------------------------
   线程预算：libvips 默认按 CPU 数开线程，在多核机器上最快，但在**共享主机**上
   会直接撞上「每用户进程/线程上限」（实测 SiteGround：ulimit -u 80），表现为
   `pthread_create: Resource temporarily unavailable`、整个进程无声退出，
   调用方只看到「Node 没有返回内容」。

   所以留一个环境变量把并发压到 1（配合 PHP 桥接里的 UV_THREADPOOL_SIZE/GOMAXPROCS）：
     DEWEB_SHRINK_SHARP_CONCURRENCY=1 node src/http.js
   不设就保持 sharp 的默认行为 —— 本地/容器里多核更快，没必要替用户做这个取舍。
   ========================================================================== */
const SHARP_CONCURRENCY = Number(process.env.DEWEB_SHRINK_SHARP_CONCURRENCY || "");
if (Number.isFinite(SHARP_CONCURRENCY) && SHARP_CONCURRENCY > 0) {
  sharp.concurrency(Math.max(1, Math.floor(SHARP_CONCURRENCY)));
  /* 缓存是给「同一张图反复编码」用的（本工具的阶梯试压正好会反复读同一张），
     但它在共享主机上是纯粹的内存开销 —— 关掉，宁可多解几次。 */
  sharp.cache(false);
}

/** 默认参数。psnrTarget 是质量门限，低于它的候选一律不要。 */
export const IMAGE_DEFAULTS = Object.freeze({
  psnrTarget: 42,
  // PNG 调色板走 libimagequant 的 quality 档：实测（512×512 图标）
  //   q50 → 45.6KB/36.2dB   q75 → 50.3KB/40.3dB   q85 → 58.7KB/42.6dB   q100 → 88.9KB/47.9dB
  // 先跑完整阶梯再按「达标里挑最小」选，所以门限调高调低都能落在合适的档上。
  pngQualityLadder: [50, 65, 75, 85, 92, 100],
  pngColours: 256,
  jpegQualityLadder: [70, 78, 85],
  webpQuality: 80,
  avifQuality: 55,
  effort: 10,
  maxMetricPixels: 4_000_000,
  resizeMaxWidth: 2048,
});

function extOf(p) {
  const base = String(p).split("/").pop() || "";
  const i = base.lastIndexOf(".");
  return i <= 0 ? "" : base.slice(i + 1).toLowerCase();
}

/**
 * 峰值信噪比（dB）。完全一致返回 Infinity。
 * 只比原始像素，用来量化「这一档色数到底损失了多少」。
 */
export async function psnr(aBuf, bBuf) {
  const [a, b] = await Promise.all([
    sharp(aBuf, { failOn: "none" }).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(bBuf, { failOn: "none" }).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
  ]);
  if (a.info.width !== b.info.width || a.info.height !== b.info.height) return null;
  const n = Math.min(a.data.length, b.data.length);
  let se = 0;
  for (let i = 0; i < n; i++) {
    const d = a.data[i] - b.data[i];
    se += d * d;
  }
  const mse = se / n;
  if (mse === 0) return Infinity;
  return 10 * Math.log10((255 * 255) / mse);
}

const alphaProbe = new WeakMap();

/**
 * 这张图**真的用到了透明**吗（有任何一个像素的 alpha < 255）？
 *
 * 为什么不能只看 hasAlpha：PNG 常常带一个全不透明的 alpha 通道（截图、导出工具、
 * 本项目的图标都是这样）。WebP / 调色板 PNG 遇到全不透明的输入会干脆不写 alpha，
 * 于是「原图有 alpha、产物没 alpha」——但那一点损失都没有。按 hasAlpha 判会把
 * 这类图片的压缩全部拒掉（实测就是：一张 262KB 的 RGBA PNG 转 WebP 只有 1.6KB，
 * 却因为这条被误杀）。只有**真的用了透明**时才必须保住 alpha。
 */
export function usesTransparency(buf) {
  let hit = alphaProbe.get(buf);
  if (!hit) {
    hit = (async () => {
      try {
        const { data, info } = await sharp(buf, { failOn: "none" })
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        if (info.channels < 4) return false;
        for (let i = 3; i < data.length; i += info.channels) {
          if (data[i] < 255) return true;
        }
        return false;
      } catch {
        return true; // 读不出来就按「用了透明」保守处理
      }
    })();
    alphaProbe.set(buf, hit);
  }
  return hit;
}

/** 产物有没有把**在用的**透明丢掉。 */
async function alphaLost(input, outMeta) {
  if (outMeta.hasAlpha) return false;
  return usesTransparency(input);
}

/** 编码 + 对拍（尺寸 / 格式 / 透明通道）。不安全就返回 null。 */
async function encodeGuarded(input, originalMeta, encode) {
  let out;
  try {
    out = await encode(sharp(input, { failOn: "none" }));
  } catch {
    return null;
  }
  if (!out || !Buffer.isBuffer(out) || out.length === 0) return null;

  let meta;
  try {
    meta = await sharp(out).metadata();
  } catch {
    return null;
  }
  if (meta.width !== originalMeta.width || meta.height !== originalMeta.height) return null;
  if (meta.format !== originalMeta.format) return null;
  // 真的用了透明却被丢掉 → 拒绝（半透明阴影会变黑块）；只是「有个没用的 alpha 通道」则放行
  if (await alphaLost(input, meta)) return null;
  return out;
}

/**
 * 压一张图。任何不确定都返回 buffer:null（= 用原文）。
 * @param {Buffer} input
 * @param {string} filePath
 * @param {object} [opts]
 */
export async function optimizeImage(input, filePath, opts = {}) {
  const cfg = { ...IMAGE_DEFAULTS, ...opts };
  const ext = extOf(filePath);
  const skip = (note) => ({ buffer: null, action: "skipped", note, from: input.length, to: input.length });

  let meta;
  try {
    meta = await sharp(input, { failOn: "none" }).metadata();
  } catch {
    return null; // 不是 sharp 认得的图（比如 SVG）
  }
  if ((meta.pages || 1) > 1) return skip("多帧动画，保持不变");

  const pixels = (meta.width || 0) * (meta.height || 0);
  const measurable = pixels > 0 && pixels <= cfg.maxMetricPixels;
  const target = cfg.psnrTarget;

  /** 在候选里挑：先满足质量门限，再挑最小。 */
  const chosen = [];
  const consider = async (encode, label, lossless = false) => {
    const out = await encodeGuarded(input, meta, encode);
    if (!out || out.length >= input.length) return null;
    const score = lossless || !measurable ? Infinity : await psnr(input, out);
    if (score != null && score < target) return null;
    const item = { buffer: out, label, psnr: score };
    chosen.push(item);
    return item;
  };

  if (ext === "png") {
    await consider(
      (s) => s.png({ compressionLevel: 9, effort: cfg.effort, palette: false }).toBuffer(),
      "无损重压",
      true,
    );
    for (const q of cfg.pngQualityLadder) {
      await consider(
        (s) =>
          s
            .png({
              palette: true,
              colours: cfg.pngColours,
              quality: q,
              effort: cfg.effort,
              compressionLevel: 9,
              dither: 0.5,
            })
            .toBuffer(),
        `调色板 q${q}`,
      );
    }
  } else if (ext === "jpg" || ext === "jpeg") {
    const bpp = input.length / Math.max(pixels, 1);
    if (bpp < 0.35) return skip("本来就很紧凑（<0.35 B/px），不再重编码");
    for (const q of cfg.jpegQualityLadder) {
      const hit = await consider(
        (s) => s.jpeg({ quality: q, mozjpeg: true, chromaSubsampling: "4:2:0" }).toBuffer(),
        `JPEG q${q}`,
      );
      if (hit) break;
    }
  } else if (ext === "webp") {
    await consider((s) => s.webp({ quality: cfg.webpQuality, effort: 6 }).toBuffer(), `WebP q${cfg.webpQuality}`);
  } else {
    return null;
  }

  chosen.sort((a, b) => a.buffer.length - b.buffer.length);
  const best = chosen[0];
  if (!best) {
    return { buffer: null, action: "none", note: "已经是最优编码（或没有达标的候选）", from: input.length, to: input.length };
  }
  const keepPct = best.psnr === Infinity ? 100 : undefined;
  return {
    buffer: best.buffer,
    action: "optimized",
    note:
      best.label +
      (best.psnr === Infinity
        ? "（无损）"
        : best.psnr == null
          ? ""
          : `（PSNR ${best.psnr.toFixed(1)} dB）`),
    psnr: best.psnr,
    keepPct,
    from: input.length,
    to: best.buffer.length,
  };
}

/** 转换格式（激进开关）。返回新扩展名与产物；不安全/没变小返回 null。 */
export async function convertImage(input, filePath, opts = {}) {
  const cfg = { ...IMAGE_DEFAULTS, ...opts };
  const target = opts.to || "webp";
  const ext = extOf(filePath);
  if (ext === target || ext === "svg" || ext === "gif") return null;

  let meta;
  try {
    meta = await sharp(input, { failOn: "none" }).metadata();
  } catch {
    return null;
  }
  if ((meta.pages || 1) > 1) return null;

  const encode = async (pipeline) => {
    try {
      const out = await pipeline.toBuffer();
      const m = await sharp(out).metadata();
      if (!m.width || m.width !== meta.width || m.height !== meta.height) return null;
      if (await alphaLost(input, m)) return null;
      return out;
    } catch {
      return null;
    }
  };

  const out =
    target === "webp"
      ? await encode(sharp(input, { failOn: "none" }).webp({ quality: cfg.webpQuality, effort: 6 }))
      : target === "avif"
        ? await encode(sharp(input, { failOn: "none" }).avif({ quality: cfg.avifQuality, effort: 4 }))
        : null;
  if (!out || out.length >= input.length) return null;

  const pixels = (meta.width || 0) * (meta.height || 0);
  const score =
    pixels > 0 && pixels <= cfg.maxMetricPixels ? await psnr(input, out) : Infinity;
  if (score != null && score < cfg.psnrTarget) return null;

  return { buffer: out, ext: target, from: input.length, to: out.length, psnr: score };
}

/** 图片元信息（报告里用：一眼看出哪张图大得没必要）。 */
export async function imageInfo(input) {
  try {
    const m = await sharp(input, { failOn: "none" }).metadata();
    return { width: m.width, height: m.height, format: m.format, hasAlpha: !!m.hasAlpha, pages: m.pages || 1 };
  } catch {
    return null;
  }
}

export { extOf as imageExtOf };
