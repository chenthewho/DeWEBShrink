#!/usr/bin/env node
/* ==========================================================================
   压缩前 vs 压缩后 · 上链计费对比
   --------------------------------------------------------------------------
   对 fixtures/ 下每个测试站点做三件事，用的是协议那套真实规则（不是估算）：

     1. scan     → 按协议规则筛出「真正会被上传的文件」，算出字节 / 块 / gas / 钱；
     2. optimize → 压出一份新站点（源目录只读）；
     3. 重扫产物 → 用**同一把尺子**量压缩后的账单。

   为什么必须重扫产物而不是「按压缩率估」：块数是按文件各向上取整的，
   文件个数变了、某些文件没压动、有文件被跳过 —— 这些都会让「估的」和「实的」对不上。
   账单必须按产物实测。

   用法：
     node scripts/billing-report.mjs                        # 实时 gasPrice / 币价
     node scripts/billing-report.mjs --gas 0.05 --usd 750   # 固定值，便于复现
     node scripts/billing-report.mjs --network base
     node scripts/billing-report.mjs --only 05              # 只跑某个站点
     node scripts/billing-report.mjs --json                 # 机器可读
   ========================================================================== */

"use strict";

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { scanSite } from "../src/scan.js";
import { optimizeSite } from "../src/optimize/index.js";
import {
  costOf,
  effectiveGasPriceGwei,
  estimateGas,
  fetchLiveGasPriceGwei,
  fetchNativePriceUsd,
  formatBytes,
  formatNative,
  formatUsd,
} from "../src/cost.js";
import { NETWORKS } from "../src/protocol.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "fixtures");
const W = 82;

/* -------------------------------- 表格排版 -------------------------------- */

/** 粗略但够用的显示宽度：CJK / 全角 / 假名 / 韩文算两格。 */
function displayWidth(str) {
  let w = 0;
  for (const ch of String(str)) {
    const cp = ch.codePointAt(0);
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6);
    w += wide ? 2 : 1;
  }
  return w;
}

function pad(s, n, right = false) {
  const str = String(s ?? "");
  const fill = " ".repeat(Math.max(0, n - displayWidth(str)));
  return right ? fill + str : str + fill;
}

/** 账单表的列定义：gas 和钱分列，别挤在一起。
 *  宽度要留出富余 —— 右对齐的列如果宽度正好等于内容宽度，相邻列就会贴在一起。 */
const COLS = [
  { title: "", w: 12 },
  { title: "文件数", w: 8, right: true },
  { title: "字节数", w: 10, right: true },
  { title: "块数", w: 6, right: true },
  { title: "gas", w: 16, right: true },
  { title: "BNB", w: 15, right: true },
  { title: "USD", w: 11, right: true },
];

const rowLine = (cells) => "  " + COLS.map((c, i) => pad(cells[i], c.w, c.right)).join("");
const headerLine = () => rowLine(COLS.map((c) => c.title));

/** 把一组 {files,bytes,chunks,gas,cost} 变成表格行。 */
function billRow(label, t) {
  const cost = t.cost;
  return rowLine([
    label,
    t.files,
    formatBytes(t.bytes),
    t.chunks,
    t.gas.toLocaleString("en-US"),
    cost ? formatNative(cost.native, SYMBOL) : "—",
    cost && cost.usd != null ? formatUsd(cost.usd) : "—",
  ]);
}

const hr = (ch = "─") => ch.repeat(W);
const thin = "  " + "·".repeat(W - 2);

/* --------------------------------- 参数 --------------------------------- */

function parseArgs(argv) {
  const out = { network: "bsc", gas: null, usd: null, json: false, only: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") out.json = true;
    else if (a === "--network") out.network = argv[++i];
    else if (a === "--gas") out.gas = Number(argv[++i]);
    else if (a === "--usd") out.usd = Number(argv[++i]);
    else if (a === "--only") out.only = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const net = NETWORKS[args.network] || NETWORKS.bsc;
const SYMBOL = net.symbol;

/* --------------------------------- 度量 --------------------------------- */

async function measure(name, title) {
  const dir = path.join(ROOT, name);
  const out = path.join(ROOT, `${name}.tape`);

  const beforeScan = await scanSite(dir);
  const before = {
    files: beforeScan.totals.billableFiles,
    bytes: beforeScan.totals.bytes,
    chunks: beforeScan.totals.chunks,
    gas: beforeScan.totals.gas,
    cost: costOf(estimateGas(beforeScan.billable), { gasPriceGwei: gp, priceUsd: usd }),
  };

  let result = null;
  let error = null;
  try {
    result = await optimizeSite({ dir, out, network: net.key, gasPriceGwei: gp, priceUsd: usd });
  } catch (err) {
    error = err.message;
  }

  // result.after 是 optimizeSite 内部算好的快照（已带 gas/cost），
  // 直接用它 —— 自己再算一遍容易两边口径不一致，账单就不可信了。
  const after = result
    ? {
        files: result.after.totals.billableFiles,
        bytes: result.after.totals.bytes,
        chunks: result.after.totals.chunks,
        gas: result.after.gas.gas,
        cost: result.after.cost,
      }
    : null;

  return {
    name,
    title,
    error,
    beforeScan,
    before,
    after,
    verification: result?.verification ?? null,
    files: result?.files ?? null,
    opportunities: result?.opportunities ?? [],
  };
}

/* -------------------------------- 单站输出 -------------------------------- */

function printSite(m) {
  console.log("");
  console.log(`${m.name} · ${m.title}`);
  console.log(hr());
  console.log(headerLine());
  console.log(billRow("压缩前", m.before));

  if (m.error) {
    console.log(billRow("压缩后", { files: 0, bytes: 0, chunks: 0, gas: 0, cost: null }) + `  失败：${m.error}`);
    return;
  }

  console.log(billRow("压缩后", m.after));
  console.log(thin);

  const dBytes = m.before.bytes - m.after.bytes;
  const dChunks = m.before.chunks - m.after.chunks;
  const dGas = m.before.gas - m.after.gas;
  const dNative = m.before.cost.native - m.after.cost.native;
  const dUsd = m.before.cost.usd != null && m.after.cost.usd != null ? m.before.cost.usd - m.after.cost.usd : null;
  const pct = m.before.bytes ? ((dBytes / m.before.bytes) * 100).toFixed(1) : "0.0";

  console.log(
    rowLine([
      "省下",
      "—",
      formatBytes(dBytes),
      dChunks,
      dGas.toLocaleString("en-US"),
      formatNative(dNative, SYMBOL),
      dUsd == null ? "—" : formatUsd(dUsd),
    ]) + `   (${pct}%)`,
  );

  /* 协议会静默跳过的文件：不上链也就不计费，但界面上不会提示 */
  const skipped = m.beforeScan.skipped;
  if (skipped.length) {
    const skippedBytes = skipped.reduce((a, f) => a + f.bytes, 0);
    console.log("");
    console.log(
      `  ⚠ 协议会跳过 ${skipped.length} 个文件（共 ${formatBytes(skippedBytes)}，不上链、不计费，但平台界面不提示）：`,
    );
    for (const f of skipped.slice(0, 5)) {
      console.log(`      ${pad(f.path, 42)} ${pad(formatBytes(f.bytes), 10, true)}  ${f.skippedReason}`);
    }
    if (skipped.length > 5) console.log(`      …… 还有 ${skipped.length - 5} 个`);
  }

  /* 压动了的文件 */
  const changed = (m.files?.results || [])
    .filter((r) => r.to < r.from)
    .sort((a, b) => b.from - b.to - (a.from - a.to));
  if (changed.length) {
    console.log("");
    console.log(`  压动了的文件（共 ${changed.length} 个，列前 6 个）：`);
    for (const r of changed.slice(0, 6)) {
      const p = ((1 - r.to / r.from) * 100).toFixed(0);
      console.log(
        `      ${pad(r.path, 34)} ${pad(formatBytes(r.from), 10, true)} → ${pad(formatBytes(r.to), 10, true)}  ${pad(`-${p}%`, 6, true)}  ${r.action}`,
      );
    }
  }

  /* 校验：压完能不能安全上链 */
  if (m.verification) {
    const v = m.verification;
    console.log("");
    console.log(`  校验：${v.ok ? "✓ 可以上链" : "✗ 有问题，先别传"}（fail ${v.failed} / warn ${v.warned}）`);
    for (const c of v.checks.filter((c) => c.status !== "pass")) {
      console.log(`      ${c.status === "fail" ? "✗" : "!"} ${c.name}：${c.detail.slice(0, 160)}`);
    }
  }
}

/* --------------------------------- 主流程 --------------------------------- */

if (!args.json) {
  console.log("");
  console.log("═".repeat(W));
  console.log("  压缩前 vs 压缩后 · 上链计费对比（按协议真实规则，不是估算）");
  console.log("═".repeat(W));
}

const gp = effectiveGasPriceGwei(net.key, args.gas ?? (await fetchLiveGasPriceGwei(net.key).catch(() => null)));
const usd = args.usd ?? (await fetchNativePriceUsd(net.key).catch(() => null));

if (!args.json) {
  console.log(`  网络      ${net.name}（${net.symbol}）`);
  console.log(`  gasPrice  ${gp} gwei${args.gas == null ? "（链上实时价，读不到用协议地板价）" : "（手动指定）"}`);
  console.log(`  ${net.symbol} 价格   ${usd == null ? "取不到（只显示原生代币）" : `$${usd}`}`);
  console.log("  计费      gas = 块数 × 270,000 + 字节数 × 235（每 24,000 字节 = 1 块 = 1 笔交易）");
}

const ALL = [
  ["01-basic", "基础小站 —— 看块开销：小文件也各占一整块"],
  ["02-images", "图片密集 —— 同格式重编码 + PSNR 质量门限"],
  ["03-fonts", "字体密集 —— 本工具不做子集化，账单会如实反映"],
  ["04-js", "JS 密集 —— IIFE 包裹，能吃满压缩率"],
  ["05-messy", "脏站 —— 协议跳过的 / 白收费的 / Content-Type 陷阱"],
  ["06-dup", "重复内容 —— 每个路径单独计费"],
  ["07-real-site", "真实站点 —— 完整 super-lock，就是已上链那个"],
];

let names;
try {
  const entries = await fs.readdir(ROOT, { withFileTypes: true });
  const have = new Set(entries.filter((e) => e.isDirectory() && !e.name.endsWith(".tape")).map((e) => e.name));
  names = ALL.filter(([n]) => have.has(n));
} catch {
  console.error("读不到 fixtures/ —— 先跑：node scripts/make-fixtures.mjs");
  process.exit(1);
}
if (args.only) names = names.filter(([n]) => n.includes(args.only));

const results = [];
for (const [name, title] of names) {
  const m = await measure(name, title);
  results.push(m);
  if (!args.json) printSite(m);
}

/* --------------------------------- 汇总 --------------------------------- */

const ok = results.filter((r) => !r.error && r.after);
const sumOf = (pick) => ok.reduce((a, r) => a + pick(r), 0);

const totalBefore = {
  files: sumOf((r) => r.before.files),
  bytes: sumOf((r) => r.before.bytes),
  chunks: sumOf((r) => r.before.chunks),
  gas: sumOf((r) => r.before.gas),
  cost: {
    native: sumOf((r) => r.before.cost.native),
    usd: sumOf((r) => r.before.cost.usd || 0),
  },
};
const totalAfter = {
  files: sumOf((r) => r.after.files),
  bytes: sumOf((r) => r.after.bytes),
  chunks: sumOf((r) => r.after.chunks),
  gas: sumOf((r) => r.after.gas),
  cost: {
    native: sumOf((r) => r.after.cost.native),
    usd: sumOf((r) => r.after.cost.usd || 0),
  },
};

if (!args.json) {
  console.log("");
  console.log("═".repeat(W));
  console.log(`  汇总 · ${ok.length} 个测试站点`);
  console.log("═".repeat(W));
  console.log(headerLine());
  console.log(billRow("压缩前", totalBefore));
  console.log(billRow("压缩后", totalAfter));
  console.log(thin);

  const dBytes = totalBefore.bytes - totalAfter.bytes;
  const dChunks = totalBefore.chunks - totalAfter.chunks;
  const dGas = totalBefore.gas - totalAfter.gas;
  const dNative = totalBefore.cost.native - totalAfter.cost.native;
  const dUsd = totalBefore.cost.usd - totalAfter.cost.usd;
  const pct = ((dBytes / totalBefore.bytes) * 100).toFixed(1);
  console.log(
    rowLine([
      "省下",
      "—",
      formatBytes(dBytes),
      dChunks,
      dGas.toLocaleString("en-US"),
      formatNative(dNative, SYMBOL),
      formatUsd(dUsd),
    ]) + `   (${pct}%)`,
  );

  /* 哪类站点最值得压 */
  console.log("");
  console.log("  按站点看省下多少（体积比例 / 省下的钱 / 少发几笔交易）：");
  const ranked = ok
    .map((r) => ({
      name: r.name,
      pct: r.before.bytes ? ((r.before.bytes - r.after.bytes) / r.before.bytes) * 100 : 0,
      usd: (r.before.cost.usd || 0) - (r.after.cost.usd || 0),
      chunks: r.before.chunks - r.after.chunks,
    }))
    .sort((a, b) => b.pct - a.pct);
  for (const r of ranked) {
    const bar = "█".repeat(Math.max(0, Math.round(r.pct / 3)));
    console.log(
      `    ${pad(r.name, 15)} ${pad(`${r.pct.toFixed(1)}%`, 7, true)}  ${pad(bar, 22)} ${pad(formatUsd(r.usd), 10, true)}  ${r.chunks} 块`,
    );
  }
  console.log("");
}

if (args.json) {
  console.log(
    JSON.stringify(
      {
        network: net.key,
        symbol: net.symbol,
        gasPriceGwei: gp,
        priceUsd: usd,
        sites: results.map((r) => ({
          name: r.name,
          title: r.title,
          error: r.error,
          before: {
            totals: r.beforeScan.totals,
            gas: r.before.gas,
            cost: r.before.cost,
            skipped: r.beforeScan.skipped.map((f) => ({ path: f.path, bytes: f.bytes, reason: f.skippedReason })),
          },
          after: r.after,
          verification: r.verification,
        })),
        totals: { before: totalBefore, after: totalAfter },
      },
      null,
      2,
    ),
  );
}
