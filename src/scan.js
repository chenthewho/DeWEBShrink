/* ==========================================================================
   扫描一个站点 —— 变成一份「协议视角」的清单
   --------------------------------------------------------------------------
   关键点：TapeCode 上传的不是「文件夹」，而是**按协议规则筛过一遍的文件集合**。
   隐藏文件（.shots/、.DS_Store）、含 .. 的路径、超过 8 MiB 的文件，前端会静默跳过
   —— 用户看不到任何提示。所以扫描必须把「会被上传的」和「会被丢掉的」分开算。

   输入是「文件源」而不是目录路径：本地目录（CLI）和内存文件数组（MCP）走同一段代码。
   目录遍历与路径校验都在 source.js，这里只管协议视角的账。
   ========================================================================== */

"use strict";

import crypto from "node:crypto";

import {
  GAS_MODEL,
  classifyPath,
  contentTypeFor,
  chunkCount,
  DEFAULT_CONTENT_TYPE,
} from "./protocol.js";
import { buildReferenceReport, extractRefsAuto } from "./refs.js";
import { asSource, isExcluded } from "./source.js";

export { isExcluded };

/** 会被读进内存做引用分析的扩展名。 */
const TEXT_EXT = new Set([
  "html", "htm", "js", "mjs", "cjs", "css", "json", "webmanifest",
  "svg", "xml", "txt", "md", "map", "yml", "yaml",
]);

/** 读文件内容的上限：引用分析不需要读完几百 MB 的东西。 */
const TEXT_READ_LIMIT = 8 * 1024 * 1024;

function extOf(p) {
  const base = p.split("/").pop() || "";
  const i = base.lastIndexOf(".");
  return i <= 0 ? "" : base.slice(i + 1).toLowerCase();
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/**
 * 扫描站点并算账。
 * @param {string|object} sourceOrRoot 站点根目录，或 source.js 构造的文件源
 * @param {{withHashes?:boolean, withRefs?:boolean, maxTextBytes?:number, exclude?:string[]}} [opts]
 */
export async function scanSite(sourceOrRoot, opts = {}) {
  const {
    withHashes = true,
    withRefs = true,
    maxTextBytes = TEXT_READ_LIMIT,
    exclude = [],
  } = opts;
  const source = asSource(sourceOrRoot, { exclude });
  const { files: raw, ignoredDirs } = await source.list();

  const files = [];
  const skipped = [];
  const graph = new Map();
  const byHash = new Map();
  const duplicates = [];

  for (const f of raw) {
    const rel = f.path.normalize("NFC");
    const cls = classifyPath(rel, f.bytes);
    const contentType = contentTypeFor(rel);
    const ext = extOf(rel);
    const isText = TEXT_EXT.has(ext);

    const entry = {
      path: rel,
      bytes: f.bytes,
      ext,
      contentType,
      isText,
      isDefaultType: contentType === DEFAULT_CONTENT_TYPE,
      chunks: cls.ok ? chunkCount(f.bytes) : 0,
      gas: 0,
      sha256: null,
      likelyNotSiteFile: /\.(?:md|map|yml|yaml)$/i.test(rel),
    };

    if (!cls.ok) {
      entry.skippedReason = cls.reason;
      entry.skippedDetail = cls.detail;
      skipped.push(entry);
      // 跳过的东西不花钱，也就不需要读内容/算哈希
      files.push(entry);
      continue;
    }

    let buf = null;
    const needContent = (withHashes || (withRefs && isText)) && f.bytes <= maxTextBytes;
    if (needContent) buf = await source.read(rel);

    if (withHashes && buf) {
      entry.sha256 = sha256(buf);
      const hit = byHash.get(entry.sha256);
      if (hit) duplicates.push({ path: rel, sameAs: hit, bytes: f.bytes });
      else byHash.set(entry.sha256, rel);
    }

    if (withRefs && isText && buf) {
      graph.set(rel, extractRefsAuto(buf.toString("utf8"), rel));
    }

    files.push(entry);
  }

  const billable = files.filter((f) => !f.skippedReason);
  for (const f of billable) f.gas = f.chunks * GAS_MODEL.perChunk + f.bytes * GAS_MODEL.perByte;

  const totals = {
    allFiles: files.length,
    billableFiles: billable.length,
    skippedFiles: skipped.length,
    bytes: billable.reduce((a, f) => a + f.bytes, 0),
    chunks: billable.reduce((a, f) => a + f.chunks, 0),
    gas: billable.reduce((a, f) => a + f.gas, 0),
  };

  const references = withRefs
    ? buildReferenceReport(billable, graph)
    : { referenced: new Set(), unreferenced: [], unresolved: [] };

  const warnings = [];
  if (skipped.length) {
    const total = skipped.reduce((a, f) => a + f.bytes, 0);
    warnings.push(
      `有 ${skipped.length} 个文件（共 ${total} 字节）协议**不会**上传：` +
        skipped
          .slice(0, 8)
          .map((f) => `${f.path}（${f.skippedReason}）`)
          .join("、") +
        (skipped.length > 8 ? " 等" : ""),
    );
  }
  if (references.unresolved.length) {
    warnings.push(
      `有 ${references.unresolved.length} 条引用在站点里找不到目标（线上大概率 404）：` +
        references.unresolved
          .slice(0, 8)
          .map((u) => `${u.from} → ${u.ref}`)
          .join("、") +
        (references.unresolved.length > 8 ? " 等" : ""),
    );
  }
  if (references.unreferenced.length) {
    const dead = billable.filter((f) => references.unreferenced.includes(f.path));
    const deadBytes = dead.reduce((a, f) => a + f.bytes, 0);
    warnings.push(
      `有 ${dead.length} 个文件没有任何引用（共 ${deadBytes} 字节，纯浪费）：` +
        dead.map((f) => f.path).slice(0, 8).join("、") +
        (dead.length > 8 ? " 等" : ""),
    );
  }
  if (duplicates.length) {
    warnings.push(
      `有 ${duplicates.length} 个文件内容完全重复（每个路径都单独计费）：` +
        duplicates.map((d) => `${d.path} = ${d.sameAs}`).join("、"),
    );
  }
  const defaultTyped = billable.filter((f) => f.isDefaultType);
  if (defaultTyped.length) {
    warnings.push(
      `有 ${defaultTyped.length} 个扩展名协议不认识的文件会被以 application/octet-stream 提供：` +
        defaultTyped.map((f) => f.path).join("、"),
    );
  }

  return {
    root: source.label,
    files,
    billable,
    skipped,
    duplicates,
    ignoredDirs,
    totals,
    references,
    warnings,
  };
}
