#!/usr/bin/env node
/* ==========================================================================
   多轮迭代的成本模拟 —— 回答「每次部署怎么最省」
   --------------------------------------------------------------------------
   真实网站的账单不是「一次全量」，而是「首付 + 每次改动」。所以这里模拟
   一条真实的迭代时间线，逐轮问一个问题：这一轮要多花多少钱？

   同时跑三种发布策略做对照：

     A. 不压缩         —— 源码原样传（体积大，但改动也按未压缩字节算）
     B. 压缩 + 增量     —— 一直传压缩版，协议自动跳过没变的文件（推荐）
     C. 先不压缩、中途才改用压缩 —— 展示「切换成本」：压缩会改变每一个文件的
                          字节，所以从 A 切到 B 的那一轮，**所有文件都算变了**，
                          要整站重传一次。这就是「第一次就该用压缩版」的原因。

   用法：
     node scripts/iteration-cost.mjs                 # 实时价格
     node scripts/iteration-cost.mjs --gas 0.05 --usd 750
   ========================================================================== */

"use strict";

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

import { optimizeSite } from "../src/optimize/index.js";
import { diffSites } from "../src/diff.js";
import { costOf, effectiveGasPriceGwei, estimateGas, fetchNativePriceUsd, formatBytes, formatNative, formatUsd } from "../src/cost.js";
import { NETWORKS } from "../src/protocol.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "fixtures");
const BASE = path.join(ROOT, "07-real-site");
const WORK = path.join(ROOT, "_iteration");

function parseArgs(argv) {
  const out = { gas: null, usd: null, network: "bsc" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--gas") out.gas = Number(argv[++i]);
    else if (argv[i] === "--usd") out.usd = Number(argv[++i]);
    else if (argv[i] === "--network") out.network = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const net = NETWORKS[args.network] || NETWORKS.bsc;

const W = 78;
const pad = (s, n, right = false) => {
  const str = String(s ?? "");
  const width = [...str].reduce((a, c) => a + (c.codePointAt(0) > 0x2e80 ? 2 : 1), 0);
  const fill = " ".repeat(Math.max(0, n - width));
  return right ? fill + str : str + fill;
};

/* ----------------------------- 迭代时间线 ----------------------------- */
/* 模拟一个真实网站上线后的头几轮改动。刻意混了「高频改的代码」和
   「很少动的大资源」，好让两类文件的成本差异显出来。 */

const ROUNDS = [
  {
    label: "第 1 轮 · 首次部署",
    apply: async () => {},
  },
  {
    label: "第 2 轮 · 修 clock.js 里的一个时区 bug",
    apply: async (dir) => {
      const p = path.join(dir, "clock.js");
      const src = await fs.readFile(p, "utf8");
      await fs.writeFile(p, `${src}\n// 修复：夏令时偏移少算了一小时\nwindow.TZ_FIX = true;\n`);
    },
  },
  {
    label: "第 3 轮 · 改 index.html 的标题和一段文案",
    apply: async (dir) => {
      const p = path.join(dir, "index.html");
      const src = await fs.readFile(p, "utf8");
      await fs.writeFile(p, src.replace("</title>", " · 链上时钟</title>"));
    },
  },
  {
    label: "第 4 轮 · 换一张图标 icon-192.png",
    apply: async (dir) => {
      const p = path.join(dir, "icons/icon-192.png");
      // 真的换一张图：重新编码，字节必然不同
      const buf = await sharp(p).png({ compressionLevel: 0 }).toBuffer();
      await fs.writeFile(p, buf);
    },
  },
  {
    label: "第 5 轮 · pwa.js 加一个小的安装提示",
    apply: async (dir) => {
      const p = path.join(dir, "pwa.js");
      const src = await fs.readFile(p, "utf8");
      await fs.writeFile(p, `${src}\n/* 安装提示 */\nwindow.__INSTALL_HINT__ = 1;\n`);
    },
  },
  {
    label: "第 6 轮 · 只给 clock.js 补注释（不改变产物）",
    apply: async (dir) => {
      const p = path.join(dir, "clock.js");
      const src = await fs.readFile(p, "utf8");
      await fs.writeFile(p, `/* 这一段只是解释代码，压缩后会被去掉 */\n${src}\n`);
    },
  },
];

/* ------------------------------- 主流程 ------------------------------- */

const gp = effectiveGasPriceGwei(net.key, args.gas);
const usd = args.usd ?? (await fetchNativePriceUsd(net.key).catch(() => null));
const PRICING = { network: net.key, gasPriceGwei: gp, priceUsd: usd };

console.log("");
console.log("═".repeat(W));
console.log("  多轮迭代的成本模拟 · 三种发布策略对照");
console.log("═".repeat(W));
console.log(`  网络 ${net.name}（${net.symbol}）· gasPrice ${gp} gwei · ${net.symbol} $${usd ?? "—"}`);
console.log(`  站点 ${path.relative(ROOT, BASE)}（${(await fs.readdir(BASE)).length} 项）`);
console.log("");

await fs.rm(WORK, { recursive: true, force: true });
await fs.mkdir(WORK, { recursive: true });

/** 一轮的产物：源目录（未压缩）与压缩目录各留一份，供下一轮 diff 对比。 */
async function materialize(round, prev) {
  const siteDir = path.join(WORK, `site_${round}`);
  await fs.cp(prev.siteDir ?? BASE, siteDir, { recursive: true });
  await ROUNDS[round].apply(siteDir);

  const zipDir = path.join(WORK, `zip_${round}`);
  await optimizeSite({ dir: siteDir, out: zipDir, ...PRICING }).catch((e) => {
    console.error(`压缩失败（第 ${round + 1} 轮）：${e.message}`);
  });

  return { siteDir, zipDir };
}

const rows = [];
let prev = { siteDir: null, zipDir: null };

for (let i = 0; i < ROUNDS.length; i++) {
  const cur = await materialize(i, prev);
  const first = i === 0;

  /* 策略 A：不压缩，直接传源码。协议照样跳过没变的文件。 */
  const a = await diffSites({
    previous: first ? null : prev.siteDir,
    next: cur.siteDir,
    ...PRICING,
  });

  /* 策略 B：一直传压缩版，协议跳过没变的。 */
  const b = await diffSites({
    previous: first ? null : prev.zipDir,
    next: cur.zipDir,
    ...PRICING,
  });

  /* 策略 C：前两轮传源码，第 3 轮起改用压缩版（切换那一轮会全量重传）。 */
  const switchAt = 2;
  let c;
  if (i < switchAt) {
    c = a;
  } else if (i === switchAt) {
    // 切换：链上是未压缩的上一版，这次传压缩版 → 几乎每个文件都"变了"
    c = await diffSites({ previous: prev.siteDir, next: cur.zipDir, ...PRICING });
  } else {
    c = b;
  }

  rows.push({ label: ROUNDS[i].label, a, b, c, first });
  prev = cur;
}

/* ------------------------------- 输出 ------------------------------- */

const money = (cost) => `${formatNative(cost.native, net.symbol)} · ${cost.usd == null ? "—" : formatUsd(cost.usd)}`;

for (const r of rows) {
  console.log(`${r.label}`);
  console.log("─".repeat(W));
  const line = (tag, d, note) =>
    `  ${pad(tag, 22)} ${pad(d.total.files + " 个文件", 9, true)} ${pad(formatBytes(d.total.bytes), 10, true)} ` +
    `${pad(d.total.chunks + " 块", 7, true)} ${pad(money(r.first || !d.total.cost ? (r.first ? d.total.cost : d.total.cost) : d.total.cost), 30, true)}${note ? `  ${note}` : ""}`;

  console.log(line("A 不压缩", r.a));
  console.log(line("B 压缩 + 增量", r.b));
  console.log(line("C 中途才改用压缩", r.c, r.c === r.a ? "（这一轮还没切）" : ""));
  console.log("");
}

/* 累计 */
const sum = (key) => rows.reduce((acc, r) => acc + r[key].total.cost.native, 0);
const sumUsd = (key) => rows.reduce((acc, r) => acc + (r[key].total.cost.usd || 0), 0);
const sumBytes = (key) => rows.reduce((acc, r) => acc + r[key].total.bytes, 0);
const sumChunks = (key) => rows.reduce((acc, r) => acc + r[key].total.chunks, 0);

console.log("═".repeat(W));
console.log(`  累计（${rows.length} 轮迭代）`);
console.log("═".repeat(W));
console.log(
  `  ${pad("", 22)} ${pad("累计重传", 12, true)} ${pad("累计字节", 12, true)} ${pad("累计块数", 10, true)} ${pad("累计费用", 30, true)}`,
);
const totalRow = (tag, key) =>
  `  ${pad(tag, 22)} ${pad(sum(key) > 0 ? "—" : "—", 12, true)} ${pad(formatBytes(sumBytes(key)), 12, true)} ` +
  `${pad(sumChunks(key) + " 块", 10, true)} ${pad(`${formatNative(sum(key), net.symbol)} · ${formatUsd(sumUsd(key))}`, 30, true)}`;

console.log(totalRow("A 不压缩", "a"));
console.log(totalRow("B 压缩 + 增量", "b"));
console.log(totalRow("C 中途才改用压缩", "c"));

const aUsd = sumUsd("a");
const bUsd = sumUsd("b");
const cUsd = sumUsd("c");
console.log("");
console.log(`  ▸ B 比 A 省 ${formatUsd(aUsd - bUsd)}（${aUsd ? (((aUsd - bUsd) / aUsd) * 100).toFixed(0) : 0}%）`);
console.log(`  ▸ B 比 C 省 ${formatUsd(cUsd - bUsd)} —— 这就是「第一轮就该用压缩版」省下的切换成本`);
console.log("");
console.log("  关键结论：");
console.log("    · 首付只有一次，之后每轮的钱 ≈ 那一轮改动文件的（压缩后）体积");
console.log("    · 大图片 / 字体是「一次性成本」，改过一次后每轮都免费");
console.log("    · 真正决定「每次成本」的，是你**反复改动**的那些代码文件 —— 优先压它们");
console.log("");

await fs.rm(WORK, { recursive: true, force: true });
