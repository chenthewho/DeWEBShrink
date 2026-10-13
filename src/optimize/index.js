/* ==========================================================================
   优化流水线：扫描 → 逐个文件压 → 写出一份新的站点目录 → 重新扫描 → 校验 → 算账
   --------------------------------------------------------------------------
   三条硬规矩：
     1. **绝不原地改**。源目录只读，产物写到 out。压坏了、校验不过，源目录还在。
     2. **账单按产物实测**。不是「我估计省了多少」，而是把 out 目录重新扫一遍，
        用协议那套公式算出来的字节数和 gas —— before/after 用的是同一把尺子。
     3. **改不动就不改**。每个优化器自己保证「没变小 / 不安全 → 返回原文」，
        流水线再兜一层：产物比原文大的，一律回退。
   ========================================================================== */

"use strict";

import fs from "node:fs/promises";
import path from "node:path";

import { scanSite } from "../scan.js";
import { asSink, asSource, createFsSink, createFsSource, createMemorySource } from "../source.js";
import {
  estimateGas,
  formatBytes,
  formatNative,
  formatUsd,
  effectiveGasPriceGwei,
  fetchNativePriceUsd,
  cachedPriceSource,
  costOf,
} from "../cost.js";
import { NETWORKS } from "../protocol.js";
import { decideDrops, assertOutside } from "./files.js";
import { minifyByExt } from "./text.js";
import { optimizeImage, convertImage, imageExtOf } from "./images.js";
import { verifyOutput } from "../verify.js";

export const DEFAULT_OPTIONS = Object.freeze({
  /* 默认开：只改编码、不改路径、不改引用，随时可以逐字节对拍 */
  minifyHtml: true,
  minifyCss: true,
  minifyJs: true,
  optimizePng: true,
  optimizeJpeg: true,
  optimizeWebp: true,
  psnrTarget: 42,
  /* 默认开：把白花钱的文件剔掉（非站点资源 + 没有任何引用的文件）。
     约定文件（robots.txt / favicon.ico / .well-known/…）由 files.js 的
     CONVENTION_FILES 保护，不参与「无引用」判定 —— 它们天然没有 HTML 引用。 */
  dropUnreferenced: true,
  dropNonSiteFiles: true,
  /* 默认关：会改变站点结构、需要人工过目的激进手段 */
  aggressiveHtml: false,
  minifyInlineJs: false,
  minifyInlineCss: false,
  convertImages: false,
  convertTo: "webp",
  drop: [],
  keep: [],
  verify: true,
});

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "webp", "avif", "gif", "tiff", "tif"]);
const TEXT_EXT = new Set(["html", "htm", "css", "js", "mjs", "cjs", "json", "webmanifest", "svg", "xml"]);

/** 把 a/b.png → a/b.webp 这种改名映射应用到所有文本文件里。 */
function rewriteReferences(content, renames) {
  let out = content;
  let hits = 0;
  for (const [from, to] of renames) {
    const variants = [
      [from, to],
      [`./${from}`, `./${to}`],
    ];
    for (const [a, b] of variants) {
      let idx = 0;
      while ((idx = out.indexOf(a, idx)) !== -1) {
        // 只在「像一条完整路径」的位置替换，避免命中更长的路径前缀
        const after = out[idx + a.length];
        const before = out[idx - 1];
        const boundaryOk =
          (after === undefined || /["'\s),;\]}?#]/.test(after)) &&
          (before === undefined || /["'\s(,;=\[{>]/.test(before));
        if (!boundaryOk) {
          idx += a.length;
          continue;
        }
        out = out.slice(0, idx) + b + out.slice(idx + a.length);
        idx += b.length;
        hits++;
      }
    }
  }
  return { content: out, hits };
}

/**
 * 压一个站点。
 * @param {object} args
 * @param {string} args.dir 源站点目录（只读）
 * @param {string} [args.out] 产物目录（默认 <dir>.tape）
 * @param {object} [args.options]
 * @param {string} [args.network]
 * @param {number|null} [args.gasPriceGwei]
 * @param {number|null} [args.priceUsd]
 * @param {string[]} [args.exclude]
 */
export async function optimizeSite(args) {
  const {
    dir = null,
    out = null,
    source: sourceArg = null,
    sink: sinkArg = null,
    options = {},
    network = "bsc",
    gasPriceGwei = null,
    priceUsd = null,
    exclude = [],
  } = args || {};

  if (!dir && !sourceArg) throw new Error("缺少输入：要么给 dir（站点目录），要么给 source（文件源）");
  if (!dir && !sinkArg) {
    throw new Error("内存文件源必须配一个产物槽（sink: createMemorySink()），否则压出来的产物无处可去");
  }

  const source = sourceArg ? asSource(sourceArg, { exclude }) : createFsSource(dir, { exclude });
  // 只有「本地目录进、本地目录出」时才需要防呆：产物不许落在源目录里
  const outRoot = sinkArg && typeof sinkArg !== "string" ? null : path.resolve(out || `${dir.replace(/[/\\]+$/, "")}.tape`);
  const sink = sinkArg ? asSink(sinkArg) : createFsSink(outRoot);
  if (dir && outRoot) assertOutside(path.resolve(dir), outRoot);

  const opts = { ...DEFAULT_OPTIONS, ...options };
  const net = NETWORKS[network] || NETWORKS.bsc;

  const started = Date.now();
  const before = await scanSite(source, { exclude });
  const { kept, dropped, protectedByConvention } = decideDrops(before, opts);

  /** @type {Array<object>} */
  const results = [];
  const renames = new Map();
  const output = new Map(); // relPath -> Buffer

  /* ------------------------- 1. 逐个文件优化 ------------------------- */
  for (const f of kept) {
    let buf;
    try {
      buf = await source.read(f.path);
      if (!buf) throw new Error("文件源里读不到这个文件");
    } catch (err) {
      results.push({ path: f.path, from: f.bytes, to: f.bytes, action: "error", note: `读不到：${err.message}` });
      continue;
    }

    let next = buf;
    let action = "copied";
    let note = "";
    let outPath = f.path; // 转格式会改扩展名，产物必须写到新路径上，否则引用全指向不存在的文件
    const ext = f.ext;
    const notes = [];

    if (IMAGE_EXT.has(ext)) {
      if (opts.convertImages && (ext === "png" || ext === "jpg" || ext === "jpeg")) {
        const conv = await convertImage(buf, f.path, { to: opts.convertTo, psnrTarget: opts.psnrTarget });
        if (conv) {
          outPath = `${f.path.slice(0, f.path.length - ext.length)}${conv.ext}`;
          renames.set(f.path, outPath);
          next = conv.buffer;
          action = `converted:${conv.ext}`;
          note = `转 ${conv.ext}（PSNR ${conv.psnr === Infinity ? "无损" : `${conv.psnr.toFixed(1)} dB`}）`;
        } else {
          notes.push("转格式没有收益或质量不达标，保持原格式");
        }
      }
      if (next === buf) {
        if ((ext === "png" && !opts.optimizePng) || ((ext === "jpg" || ext === "jpeg") && !opts.optimizeJpeg) || (ext === "webp" && !opts.optimizeWebp)) {
          notes.push("按配置跳过");
        } else if (ext !== "gif" && ext !== "avif" && ext !== "tiff" && ext !== "tif") {
          const r = await optimizeImage(buf, f.path, { psnrTarget: opts.psnrTarget });
          if (r && r.buffer) {
            next = r.buffer;
            action = "image";
            note = r.note;
          } else if (r) {
            action = "none";
            note = r.note;
          }
        } else {
          notes.push(`${ext} 不做处理`);
        }
      }
    } else if (TEXT_EXT.has(ext)) {
      const text = buf.toString("utf8");
      if (ext === "svg") {
        notes.push("SVG 未处理（不做有风险的路径重写）");
      } else {
        const r = await minifyByExt(text, ext, {
          aggressive: opts.aggressiveHtml,
          minifyInlineJs: opts.minifyInlineJs || opts.aggressiveHtml,
          minifyInlineCss: opts.minifyInlineCss || opts.aggressiveHtml,
        });
        const disabled =
          (ext === "html" || ext === "htm") ? !opts.minifyHtml :
          ext === "css" ? !opts.minifyCss :
          ["js", "mjs", "cjs"].includes(ext) ? !opts.minifyJs : true;
        if (!disabled && r.code !== text && Buffer.byteLength(r.code, "utf8") < buf.length) {
          next = Buffer.from(r.code, "utf8");
          action = `text:${r.mode}`;
          note = r.mode === "none" ? "" : `minify(${r.mode})`;
        } else if (disabled) {
          notes.push("按配置跳过");
        } else if (r.mode === "none") {
          action = "none";
          note = "已经是紧凑形式";
        }
        notes.push(...r.notes);
      }
    }

    if (next.length > buf.length) {
      next = buf; // 兜底：产物更大就回退
      action = "none";
      note = "产物更大，已回退原文";
    }

    if (output.has(outPath)) {
      throw new Error(`产物路径冲突：${outPath}（${f.path} 转格式后与另一个文件重名）`);
    }
    output.set(outPath, next);
    results.push({
      path: outPath,
      fromPath: f.path,
      from: buf.length,
      to: next.length,
      action,
      note: [note, ...notes].filter(Boolean).join("；"),
      contentType: f.contentType,
    });
  }

  /* ------------------- 2. 改名映射 → 重写引用 ------------------- */
  const rewriteLog = [];
  if (renames.size) {
    for (const [rel, buf] of [...output]) {
      const ext = extOfPath(rel);
      if (!TEXT_EXT.has(ext)) continue;
      const r = rewriteReferences(buf.toString("utf8"), renames);
      if (!r.hits) continue;
      // JSON（manifest）里图标还带一个 type 字段，路径改了它也得改，
      // 否则浏览器按声明的 MIME 去解析，可能直接不认这张图标。
      const fixed = fixManifestTypes(r.content);
      const nextBuf = Buffer.from(fixed.content, "utf8");
      rewriteLog.push({
        path: rel,
        hits: r.hits,
        typeFixes: fixed.fixes,
        from: buf.length,
        to: nextBuf.length,
      });
      output.set(rel, nextBuf);
      const e = results.find((x) => x.path === rel);
      if (e) {
        e.to = nextBuf.length;
        e.note = [e.note, `${r.hits} 处引用已重写`].filter(Boolean).join("；");
      }
    }
  }

  /* ------------- 2b. manifest 的图标 type 单独修一遍 -------------
     这条和「有没有改过名」无关：原本就写错 type 的 manifest 一样会让浏览器
     按错误的 MIME 解析图标。所以只要有 manifest 就修，并且在报告里写出来。 */
  const manifestFixes = [];
  for (const [rel, buf] of [...output]) {
    if (!/(^|\/)manifest\.(?:json|webmanifest)$/i.test(rel)) continue;
    const fixed = fixManifestTypes(buf.toString("utf8"));
    if (!fixed.fixes) continue;
    const nextBuf = Buffer.from(fixed.content, "utf8");
    manifestFixes.push({ path: rel, fixes: fixed.fixes, from: buf.length, to: nextBuf.length });
    output.set(rel, nextBuf);
    const e = results.find((x) => x.path === rel);
    if (e) {
      e.to = nextBuf.length;
      e.note = [e.note, `${fixed.fixes} 个图标 type 已改正`].filter(Boolean).join("；");
    }
  }

  /* ------------------------- 3. 写出产物 ------------------------- */
  if (sink.kind === "fs" && outRoot) await fs.rm(outRoot, { recursive: true, force: true });
  let written = 0;
  for (const [rel, buf] of output) {
    await sink.write(rel, buf);
    written++;
  }
  const writtenInfo = await sink.done();

  /* --------------------- 4. 按产物实测重新算账 ---------------------
     产物在内存里时，拿真正写出去的那份字节重新扫一遍 —— 账必须按实测算，不能靠估。 */
  const afterSource =
    writtenInfo.kind === "memory"
      ? createMemorySource([...writtenInfo.files].map(([p, b]) => ({ path: p, bytes: b })))
      : createFsSource(writtenInfo.root, { exclude });
  const after = await scanSite(afterSource, { exclude });

  /* --------------------------- 5. 校验 --------------------------- */
  let verification = null;
  if (opts.verify) {
    verification = await verifyOutput({
      originalSource: source,
      outputSource: afterSource,
      original: before,
      output: after,
      allowGrowth: [...rewriteLog.map((r) => r.path), ...manifestFixes.map((m) => m.path)],
    });
  }

  /* --------------------------- 6. 算钱 --------------------------- */
  const gp = effectiveGasPriceGwei(net.key, gasPriceGwei);
  let usd = priceUsd;
  if (usd == null) {
    try {
      usd = await fetchNativePriceUsd(net.key);
    } catch {
      usd = null;
    }
  }

  const gasBefore = estimateGas(before.billable);
  const gasAfter = estimateGas(after.billable);
  const costBefore = costOf(gasBefore, { gasPriceGwei: gp, priceUsd: usd });
  const costAfter = costOf(gasAfter, { gasPriceGwei: gp, priceUsd: usd });

  const savedBytes = gasBefore.bytes - gasAfter.bytes;
  const savedBnb = costBefore.native - costAfter.native;
  const savedUsd = costBefore.usd != null && costAfter.usd != null ? costBefore.usd - costAfter.usd : null;

  const result = {
    dir: source.label,
    out: writtenInfo.kind === "fs" ? writtenInfo.root : null,
    /* 内存模式下把产物原样带回（MCP 要把它交给 agent 去发布）；本地模式没必要重复一份 */
    artifacts:
      writtenInfo.kind === "memory"
        ? [...writtenInfo.files].map(([p, buf]) => ({ path: p, bytes: buf.length, base64: buf.toString("base64") }))
        : null,
    network: net.key,
    networkName: net.name,
    symbol: net.symbol,
    gasPriceGwei: gp,
    priceUsd: usd,
    priceSource: cachedPriceSource(net.key),
    options: opts,
    elapsedMs: Date.now() - started,
    files: {
      written,
      dropped: dropped.map((d) => ({ path: d.path, bytes: d.bytes, reason: d.dropReason })),
      /* 无引用但靠约定路径访问、因此被保留的文件 —— 报告里要说出来，
         否则用户会以为工具漏删了，或者反过来自己手动删掉它们 */
      protectedByConvention,
      results,
      renames: [...renames.entries()].map(([from, to]) => ({ from, to })),
      rewrites: rewriteLog,
      manifestTypeFixes: manifestFixes,
    },
    before: snapshot(before, gasBefore, costBefore),
    after: snapshot(after, gasAfter, costAfter),
    saved: {
      bytes: savedBytes,
      bytesPct: gasBefore.bytes ? (savedBytes / gasBefore.bytes) * 100 : 0,
      gas: gasBefore.gas - gasAfter.gas,
      native: savedBnb,
      usd: savedUsd,
      chunks: gasBefore.chunks - gasAfter.chunks,
    },
    verification,
    warnings: [...before.warnings, ...after.warnings],
    opportunities: [],
  };

  if (opts.reportOpportunities !== false) {
    try {
      const { collectOpportunities } = await import("../report.js");
      result.opportunities = await collectOpportunities(result);
    } catch (err) {
      // 不静默：报告算不出来也要让用户看见
      result.warnings.push(`「还能再省」这一节算不出来：${err.message}`);
    }
  }

  return result;
}

/**
 * manifest 的图标类型跟着扩展名走：src 变成 .webp 了，type 还写 image/png 就是自相矛盾，
 * 浏览器会按声明的 MIME 去解析，可能直接不认这张图标。
 *
 * 两个刻意的选择：
 *   · 目标 MIME 由 **src 自己的扩展名**决定，不依赖改名映射 —— 这个函数因此是幂等的，
 *     重复跑不会来回改；也顺手修掉别人本来就写错的 type。
 *   · 只对**原始文本**里那一个图标对象的 `"type":"…"` 做定点替换，不重新序列化整个 JSON：
 *     重排 JSON 会平白改变字节数（账单），也会把用户原本的格式和键序冲掉。
 */
const MIME_BY_EXT = {
  webp: "image/webp",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  avif: "image/avif",
  svg: "image/svg+xml",
  ico: "image/x-icon",
};

function fixManifestTypes(content) {
  let json;
  try {
    json = JSON.parse(content);
  } catch {
    return { content, fixes: 0 }; // 解析不了就原样返回，交给校验去报
  }
  if (!json || !Array.isArray(json.icons)) return { content, fixes: 0 };

  const plan = [];
  for (const icon of json.icons) {
    if (!icon || typeof icon.src !== "string") continue;
    const want = MIME_BY_EXT[extOfPath(icon.src)];
    if (want && icon.type !== want) plan.push({ src: icon.src, to: want });
  }
  if (!plan.length) return { content, fixes: 0 };

  let out = content;
  let fixes = 0;
  for (const item of plan) {
    const idx = out.indexOf(`"${item.src}"`);
    if (idx < 0) continue;
    const open = out.lastIndexOf("{", idx);
    const close = out.indexOf("}", idx);
    if (open < 0 || close < 0 || close < open) continue;
    const seg = out.slice(open, close);
    const typeRe = /("type"\s*:\s*")([^"]*)(")/;
    if (!typeRe.test(seg)) continue;
    const newSeg = seg.replace(typeRe, (_m, a, _old, c) => a + item.to + c);
    if (newSeg === seg) continue;
    out = out.slice(0, open) + newSeg + out.slice(close);
    fixes++;
  }
  return { content: out, fixes };
}

/** 把一次扫描压成可序列化的快照（Set 不能进 JSON，全部摊平成数组）。 */
function snapshot(scan, gas, cost) {
  return {
    totals: scan.totals,
    gas,
    cost,
    files: scan.billable.map((f) => ({
      path: f.path,
      bytes: f.bytes,
      ext: f.ext,
      chunks: f.chunks,
      gas: f.gas,
      contentType: f.contentType,
    })),
    skipped: scan.skipped.map((f) => ({ path: f.path, bytes: f.bytes, reason: f.skippedReason })),
    unreferenced: scan.references.unreferenced,
    unresolved: scan.references.unresolved,
    warnings: scan.warnings,
  };
}

function extOfPath(p) {
  const base = String(p).split("/").pop() || "";
  const i = base.lastIndexOf(".");
  return i <= 0 ? "" : base.slice(i + 1).toLowerCase();
}

export { formatBytes, formatNative, formatUsd, imageExtOf };
