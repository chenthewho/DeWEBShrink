#!/usr/bin/env node
/* ==========================================================================
   A 完全不压缩  vs  B 每次都压缩 —— 4 次迭代的花费对比
   --------------------------------------------------------------------------
   这是一个受控对照实验，两边走**完全相同**的 4 次迭代，唯一差别是
   「上传前压不压缩」：

     A：每次把**源码站点**传上去
     B：每次把**压缩产物**传上去

   公平性靠两点保证：
     1. 两边各自与**自己的**上一版对比 —— A 比 A、B 比 B。协议本来就是按
        「路径 + sha256」跳过没变的文件，所以两边都会享受到增量跳过；
        差别只在于「变了的那些文件，是按原始字节付还是按压缩后字节付」。
     2. 价格固定（默认 BSC 地板价 0.05 gwei / BNB $750），结果可复现。

   为什么 B 的第二次以后仍然更便宜：压缩把 JS/CSS/HTML 压掉 40-70%，
   图片压掉 70-85%，而改了就是整份重传 —— 所以「每轮改动的文件」体积
   越小，每次部署就越省。

   用法：
     node scripts/raw-vs-compressed.mjs
     node scripts/raw-vs-compressed.mjs --gas 0.05 --usd 750
     node scripts/raw-vs-compressed.mjs --rounds 4
   ========================================================================== */

"use strict";

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

import { optimizeSite } from "../src/optimize/index.js";
import { diffSites } from "../src/diff.js";
import {
  effectiveGasPriceGwei,
  fetchNativePriceUsd,
  formatBytes,
  formatNative,
  formatUsd,
} from "../src/cost.js";
import { NETWORKS } from "../src/protocol.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "fixtures");
const BASE = path.join(ROOT, "07-real-site");
const WORK = path.join(ROOT, "_ab");

const W = 82;
const pad = (s, n, right = false) => {
  const str = String(s ?? "");
  const width = [...str].reduce((a, c) => a + (c.codePointAt(0) > 0x2e80 ? 2 : 1), 0);
  const fill = " ".repeat(Math.max(0, n - width));
  return right ? fill + str : str + fill;
};
const hr = (ch = "─") => ch.repeat(W);

/* -------------------------------- 参数 -------------------------------- */

function parseArgs(argv) {
  const out = { gas: 0.05, usd: 750, rounds: 4, network: "bsc" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--gas") out.gas = Number(argv[++i]);
    else if (a === "--usd") out.usd = Number(argv[++i]);
    else if (a === "--rounds") out.rounds = Number(argv[++i]);
    else if (a === "--network") out.network = argv[++i];
    else if (a === "--live") out.live = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const net = NETWORKS[args.network] || NETWORKS.bsc;

/* ---------------------------- 4 次迭代的内容 ---------------------------- */

const ALL_ROUNDS = [
  {
    label: "首次部署",
    detail: "整站上线",
    apply: async () => {},
  },
  {
    label: "第 2 次",
    detail: "修 clock.js 里的一个时区 bug",
    apply: async (dir) => {
      const p = path.join(dir, "clock.js");
      const src = await fs.readFile(p, "utf8");
      await fs.writeFile(p, `${src}\n// 修复：夏令时偏移少算了一小时\nwindow.TZ_FIX = true;\n`);
    },
  },
  {
    label: "第 3 次",
    detail: "改 index.html 的标题和一段文案",
    apply: async (dir) => {
      const p = path.join(dir, "index.html");
      const src = await fs.readFile(p, "utf8");
      await fs.writeFile(p, src.replace("</title>", " · 链上时钟</title>"));
    },
  },
  {
    label: "第 4 次",
    detail: "换一张图标 icon-192.png",
    apply: async (dir) => {
      const p = path.join(dir, "icons/icon-192.png");
      const buf = await sharp(p).png({ compressionLevel: 0 }).toBuffer();
      await fs.writeFile(p, buf);
    },
  },
  {
    label: "第 5 次",
    detail: "pwa.js 加一段安装提示",
    apply: async (dir) => {
      const p = path.join(dir, "pwa.js");
      const src = await fs.readFile(p, "utf8");
      await fs.writeFile(p, `${src}\n/* 安装提示 */\nwindow.__INSTALL_HINT__ = 1;\n`);
    },
  },
];

const ROUNDS = ALL_ROUNDS.slice(0, Math.max(1, Math.min(args.rounds, ALL_ROUNDS.length)));

/* -------------------------------- 主流程 -------------------------------- */

const gp = effectiveGasPriceGwei(net.key, args.live ? null : args.gas);
const usd = args.usd ?? (await fetchNativePriceUsd(net.key).catch(() => null));
const PRICING = { network: net.key, gasPriceGwei: gp, priceUsd: usd };

console.log("");
console.log("═".repeat(W));
console.log("  A 完全不压缩  vs  B 每次都压缩");
console.log("═".repeat(W));
console.log(`  站点      ${path.relative(ROOT, BASE)}（辉光管时钟站，${(await fs.readdir(BASE)).length} 项）`);
console.log(`  迭代次数  ${ROUNDS.length} 次（第 1 次是首次部署，其余是后续改动）`);
console.log(`  网络      ${net.name}（${net.symbol}）· gasPrice ${gp} gwei · ${net.symbol} $${usd ?? "—"}`);
console.log("  计费      gas = 块数 × 270,000 + 字节数 × 235（每 24,000 字节 = 1 块）");
console.log("  规则      同一路径 + 同一 sha256 的文件会被跳过，变了的整份重传");
console.log("");

await fs.rm(WORK, { recursive: true, force: true });
await fs.mkdir(WORK, { recursive: true });

const rows = [];
let prevSite = null; // A 的上一版（未压缩）
let prevZip = null; // B 的上一版（压缩产物）

for (let i = 0; i < ROUNDS.length; i++) {
  const r = ROUNDS[i];

  /* 造这一轮的源码站点 */
  const siteDir = path.join(WORK, `site_${i}`);
  await fs.cp(prevSite ?? BASE, siteDir, { recursive: true });
  await r.apply(siteDir);

  /* B 场景：压缩这一轮的站点 */
  const zipDir = path.join(WORK, `zip_${i}`);
  const opt = await optimizeSite({ dir: siteDir, out: zipDir, ...PRICING });

  /* A：源码 vs 上一轮源码；B：压缩产物 vs 上一轮压缩产物 */
  const a = await diffSites({ previous: prevSite, next: siteDir, ...PRICING });
  const b = await diffSites({ previous: prevZip, next: zipDir, ...PRICING });

  rows.push({ label: r.label, detail: r.detail, a, b, opt });

  prevSite = siteDir;
  prevZip = zipDir;
}

/* -------------------------------- 输出 -------------------------------- */

for (const row of rows) {
  console.log(`${row.label} · ${row.detail}`);
  console.log(hr());
  console.log(
    `  ${pad("", 18)} ${pad("上传文件", 10, true)} ${pad("上传字节", 11, true)} ${pad("块数", 7, true)} ` +
      `${pad("gas", 15, true)} ${pad("费用", 24, true)}`,
  );

  const line = (tag, d) =>
    `  ${pad(tag, 18)} ${pad(d.total.files + " 个", 10, true)} ${pad(formatBytes(d.total.bytes), 11, true)} ` +
    `${pad(d.total.chunks + " 块", 7, true)} ${pad(d.total.gas.toLocaleString("en-US"), 15, true)} ` +
    `${pad(`${formatNative(d.total.cost.native, net.symbol)} ≈ ${d.total.cost.usd == null ? "—" : formatUsd(d.total.cost.usd)}`, 24, true)}`;

  console.log(line("A 不压缩", row.a));
  console.log(line("B 压缩", row.b));

  const diffUsd = (row.a.total.cost.usd || 0) - (row.b.total.cost.usd || 0);
  const pct = row.a.total.cost.usd ? ((diffUsd / row.a.total.cost.usd) * 100).toFixed(0) : "0";
  console.log(
    `  ${pad("", 18)} ${pad("", 10)} ${pad("", 11)} ${pad("", 7)} ${pad("", 15)} ` +
      `${pad(`B 省 ${formatUsd(diffUsd)}（${pct}%）`, 24, true)}`,
  );

  // 这一轮各自动了哪些文件
  const aChanged = [...row.a.added, ...row.a.changed].map((f) => f.path);
  if (aChanged.length && aChanged.length <= 4) {
    console.log(`  ${pad("A 重传", 18)} ${aChanged.join("、")}`);
  } else if (aChanged.length) {
    console.log(`  ${pad("A 重传", 18)} ${aChanged.length} 个文件（首次全量）`);
  }
  const bChanged = [...row.b.added, ...row.b.changed].map((f) => f.path);
  if (bChanged.length && bChanged.length <= 4) {
    console.log(`  ${pad("B 重传", 18)} ${bChanged.length ? bChanged.join("、") : "（无）"}`);
  } else if (bChanged.length) {
    console.log(`  ${pad("B 重传", 18)} ${bChanged.length} 个文件（首次全量）`);
  }
  console.log("");
}

/* -------------------------------- 累计 -------------------------------- */

const sumUsd = (k) => rows.reduce((acc, r) => acc + (r[k].total.cost.usd || 0), 0);
const sumNative = (k) => rows.reduce((acc, r) => acc + r[k].total.cost.native, 0);
const sumBytes = (k) => rows.reduce((acc, r) => acc + r[k].total.bytes, 0);
const sumChunks = (k) => rows.reduce((acc, r) => acc + r[k].total.chunks, 0);
const sumGas = (k) => rows.reduce((acc, r) => acc + r[k].total.gas, 0);

console.log("═".repeat(W));
console.log(`  累计花费 · ${rows.length} 次迭代`);
console.log("═".repeat(W));
console.log(
  `  ${pad("", 18)} ${pad("累计字节", 12, true)} ${pad("累计块数", 10, true)} ${pad("累计 gas", 17, true)} ${pad("累计费用", 26, true)}`,
);

const totalLine = (tag, k) =>
  `  ${pad(tag, 18)} ${pad(formatBytes(sumBytes(k)), 12, true)} ${pad(sumChunks(k) + " 块", 10, true)} ` +
  `${pad(sumGas(k).toLocaleString("en-US"), 17, true)} ` +
  `${pad(`${formatNative(sumNative(k), net.symbol)} ≈ ${formatUsd(sumUsd(k))}`, 26, true)}`;

console.log(totalLine("A 完全不压缩", "a"));
console.log(totalLine("B 每次都压缩", "b"));

const aUsd = sumUsd("a");
const bUsd = sumUsd("b");
const savedUsd = aUsd - bUsd;
const savedPct = aUsd ? (savedUsd / aUsd) * 100 : 0;

console.log("  " + "·".repeat(W - 2));
console.log(
  `  ${pad("B 省下", 18)} ${pad(formatBytes(sumBytes("a") - sumBytes("b")), 12, true)} ` +
    `${pad(sumChunks("a") - sumChunks("b") + " 块", 10, true)} ` +
    `${pad((sumGas("a") - sumGas("b")).toLocaleString("en-US"), 17, true)} ` +
    `${pad(`${formatNative(sumNative("a") - sumNative("b"), net.symbol)} ≈ ${formatUsd(savedUsd)}（${savedPct.toFixed(1)}%）`, 26, true)}`,
);

/* 逐次展开，看每次省多少 */
console.log("");
console.log("  逐次看 B 省了多少：");
for (const row of rows) {
  const d = (row.a.total.cost.usd || 0) - (row.b.total.cost.usd || 0);
  const p = row.a.total.cost.usd ? ((d / row.a.total.cost.usd) * 100).toFixed(0) : "0";
  const bar = "█".repeat(Math.max(0, Math.round(Number(p) / 3)));
  console.log(
    `    ${pad(row.label, 8)} ${pad(formatUsd(row.a.total.cost.usd || 0), 9, true)} → ${pad(formatUsd(row.b.total.cost.usd || 0), 9, true)}  ` +
      `${pad("省 " + formatUsd(d), 11, true)} ${pad(p + "%", 5, true)} ${bar}`,
  );
}

console.log("");
console.log(
  `  ▸ ${rows.length} 次迭代，不压缩共花 ${formatUsd(aUsd)}，压缩共花 ${formatUsd(bUsd)}，` +
    `省 ${formatUsd(savedUsd)}（${savedPct.toFixed(1)}%）。`,
);
console.log("");

await fs.rm(WORK, { recursive: true, force: true });
