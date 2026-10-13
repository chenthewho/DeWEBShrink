/* ==========================================================================
   PoC 流水线 —— 浏览器与 Node 共用同一条代码路径
   --------------------------------------------------------------------------
   关键点：**不重新实现算法**。这里直接复用 src/ 里的真相源：

     src/scan.js           扫描 + 引用图 + 重复内容 + 协议跳过规则
     src/optimize/index.js 压缩流水线（含 decideDrops / minifyByExt / 校验 / 算账）
     src/report.js         报告排版
     src/source.js         内存文件源 / 内存产物槽
     src/cost.js           计费换算

   浏览器与 Node 的差别只有三处，全在构建期用 alias 替换（见 build.mjs）：
     node:crypto → 纯 JS sha256       esbuild → esbuild-wasm
     sharp       → oxipng WASM 版      node:fs/path → 只在本地形态用，浏览器里给替身

   于是「浏览器算出来的 gas/美元」与「服务器/CLI 算出来的」必然一致 ——
   因为它们本来就是同一段代码。
   ========================================================================== */

"use strict";

import { optimizeSite } from "../src/optimize/index.js";
import { scanSite } from "../src/scan.js";
import { estimateGas, costOf, effectiveGasPriceGwei } from "../src/cost.js";
import { NETWORKS } from "../src/protocol.js";
import { createMemorySink, createMemorySource } from "../src/source.js";
import { formatOptimizeReport, formatScanReport } from "../src/report.js";

export const POC_DEFAULTS = Object.freeze({
  network: "bsc",
  gasPriceGwei: 0.05, // BSC 地板价
  priceUsd: 750,
});

/** 包一层进度回调：内存源每被读一次就报一声（optimizeSite 会逐个文件读）。 */
function withProgress(source, onProgress) {
  if (!onProgress) return source;
  let reads = 0;
  return {
    kind: source.kind,
    label: source.label,
    root: source.root,
    list: () => source.list(),
    async read(rel) {
      const buf = await source.read(rel);
      reads++;
      onProgress({ phase: "optimize", filesRead: reads, path: rel });
      return buf;
    },
  };
}

/** 只扫描：出账单与问题清单。 */
export async function scanFiles(files, opts = {}) {
  const { network = POC_DEFAULTS.network, gasPriceGwei = POC_DEFAULTS.gasPriceGwei, priceUsd = POC_DEFAULTS.priceUsd, exclude = [] } = opts;
  const source = createMemorySource(files, { exclude });
  const scan = await scanSite(source, { exclude });
  const gas = estimateGas(scan.billable);
  const cost = costOf(gas, { gasPriceGwei, priceUsd });
  const net = NETWORKS[network] || NETWORKS.bsc;
  return {
    scan,
    gas,
    cost,
    report: formatScanReport(scan, { networkKey: net.key, gasPriceGwei, priceUsd }),
  };
}

/**
 * 压缩 + 校验 + 算账。返回结构刻意与 MCP 的 optimize 工具保持一致，
 * 这样「网页版」和「MCP 版」的产物形状一样，将来可以共用前端渲染。
 */
export async function shrinkFiles({ files, options = {}, onProgress, ...pricing } = {}) {
  const network = pricing.network || POC_DEFAULTS.network;
  const gasPriceGwei = pricing.gasPriceGwei ?? POC_DEFAULTS.gasPriceGwei;
  const priceUsd = pricing.priceUsd ?? POC_DEFAULTS.priceUsd;
  const exclude = pricing.exclude || [];

  const base = createMemorySource(files, { exclude });
  onProgress?.({ phase: "scan" });
  const source = withProgress(base, onProgress);
  const started = Date.now();

  const result = await optimizeSite({
    source,
    sink: createMemorySink(),
    exclude,
    network,
    gasPriceGwei,
    priceUsd,
    options,
  });

  onProgress?.({ phase: "verify" });

  const net = NETWORKS[network] || NETWORKS.bsc;
  return {
    /* 完整结果对象（before/after/saved/files/verification/artifacts/opportunities） */
    result,
    elapsedMs: Date.now() - started,
    report: formatOptimizeReport(result),
    json: {
      engine: "browser-poc",
      network: net.key,
      symbol: net.symbol,
      gasPriceGwei: result.gasPriceGwei ?? gasPriceGwei,
      priceUsd: result.priceUsd ?? priceUsd,
      before: result.before,
      after: result.after,
      saved: result.saved,
      files: result.files,
      verification: result.verification,
      opportunities: result.opportunities,
      warnings: result.warnings,
      artifacts: result.artifacts,
      elapsedMs: Date.now() - started,
    },
  };
}

/** 产物 → ZIP 用的 [路径, Uint8Array] 列表（transferable，能直接丢给 Worker）。 */
export function artifactEntries(result) {
  return (result.artifacts || []).map((a) => [a.path, Uint8Array.from(Buffer.from(a.base64, "base64"))]);
}
