#!/usr/bin/env node
/* ==========================================================================
   成本结构分析 —— 到底是「文件大」还是「文件多」在花钱
   --------------------------------------------------------------------------
   计费公式：gas = 块数 × 270,000 + 字节数 × 235，每 24,000 字节一块。

   把它拆开看，两个杠杆的性质完全不同：

     字节杠杆：235 gas/byte，对每一字节一视同仁、连续线性。
     块杠杆：  270,000 gas/block，**阶梯式**、有固定的入场费。

   关键换算：
     270,000 ÷ 24,000 = 11.25 gas/byte   ← 满块时，块的边际成本
     (235 + 11.25) = 246.25 gas/byte     ← 满块文件的实际边际成本

   所以对**满块的大文件**，块只占 4.6% 的边际成本 —— 字节才是大头。
   但对**不满块的小文件**，那一块 270,000 是硬付的，摊到每字节上就非常贵：

     100 字节的文件 → 293,500 gas → 2,935 gas/byte（是满块文件的 11.9 倍）

   这带来一个反直觉但极有用的结论：
     **一个文件从 24,001 字节压到 24,000，只压掉 1 个字节，却省下整整一块
     270,000 gas（≈ $0.010）。而把 23,999 压到 1 字节，一块都省不了。**

   本脚本就找这类「离降一块很近」的文件 —— 它们往往是性价比最高的下手点。

   用法：node scripts/cost-structure.mjs [目录] [--gas 0.05] [--usd 750]
   ========================================================================== */

"use strict";

import path from "node:path";
import { fileURLToPath } from "node:url";

import { scanSite } from "../src/scan.js";
import { costOf, effectiveGasPriceGwei, estimateGas, fetchNativePriceUsd, formatBytes, formatNative, formatUsd } from "../src/cost.js";
import { CHUNK_BYTES, GAS_MODEL, NETWORKS } from "../src/protocol.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

function parseArgs(argv) {
  const out = { dir: null, gas: 0.05, usd: 750, network: "bsc" };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--gas") out.gas = Number(argv[++i]);
    else if (a === "--usd") out.usd = Number(argv[++i]);
    else if (a === "--network") out.network = argv[++i];
    else if (a === "--live") out.live = true;
    else pos.push(a);
  }
  out.dir = pos[0] || path.join(ROOT, "fixtures", "07-real-site");
  return out;
}

const args = parseArgs(process.argv.slice(2));
const net = NETWORKS[args.network] || NETWORKS.bsc;
const W = 84;

const pad = (s, n, right = false) => {
  const str = String(s ?? "");
  const width = [...str].reduce((a, c) => a + (c.codePointAt(0) > 0x2e80 ? 2 : 1), 0);
  const fill = " ".repeat(Math.max(0, n - width));
  return right ? fill + str : str + fill;
};
const hr = (ch = "─") => ch.repeat(W);
const money = (bnb, usd) => `${formatNative(bnb, net.symbol)} ≈ ${formatUsd(usd)}`;

/* --------------------------------- 数据 --------------------------------- */

const scan = await scanSite(args.dir);
const gas = estimateGas(scan.billable);
const gp = effectiveGasPriceGwei(net.key, args.live ? null : args.gas);
const usd = args.live ? await fetchNativePriceUsd(net.key).catch(() => 750) : args.usd;
const price = { gasPriceGwei: gp, priceUsd: usd };
const totalCost = costOf(gas, price);

const chunkGas = gas.chunks * GAS_MODEL.perChunk;
const byteGas = gas.bytes * GAS_MODEL.perByte;
const chunkShare = (chunkGas / gas.gas) * 100;
const byteShare = (byteGas / gas.gas) * 100;

console.log("");
console.log("═".repeat(W));
console.log("  上链成本结构分析 · 是「文件大」还是「文件多」在花钱");
console.log("═".repeat(W));
console.log(`  目录      ${path.relative(ROOT, path.resolve(args.dir))}`);
console.log(`  网络      ${net.name}（${net.symbol}）· gasPrice ${gp} gwei · ${net.symbol} $${usd}`);
console.log("");

/* ------------------------------ 1. 总成本拆解 ------------------------------ */

console.log("① 总成本拆解");
console.log(hr());
console.log(`  ${pad("文件数", 14)} ${pad(gas.files + " 个", 12, true)}`);
console.log(`  ${pad("字节数", 14)} ${pad(formatBytes(gas.bytes), 12, true)}`);
console.log(`  ${pad("块数", 14)} ${pad(gas.chunks + " 块（= " + gas.chunks + " 笔交易）", 12, true)}`);
console.log("");
console.log(`  ${pad("块开销", 14)} ${pad(chunkGas.toLocaleString("en-US") + " gas", 22, true)}  ${pad(chunkShare.toFixed(1) + "%", 7, true)}`);
console.log(`  ${pad("字节开销", 14)} ${pad(byteGas.toLocaleString("en-US") + " gas", 22, true)}  ${pad(byteShare.toFixed(1) + "%", 7, true)}`);
console.log(`  ${pad("合计", 14)} ${pad(gas.gas.toLocaleString("en-US") + " gas", 22, true)}  ${pad(money(totalCost.native, totalCost.usd), 24, true)}`);
console.log("");

const verdict =
  byteShare > 70
    ? `字节是主要成本（${byteShare.toFixed(0)}%）—— 压缩体积是主杠杆`
    : chunkShare > 50
      ? `块是主要成本（${chunkShare.toFixed(0)}%）—— 减少文件数 / 跨过块边界是主杠杆`
      : "两者相当，要分别优化";
console.log(`  ▸ ${verdict}`);
console.log("");

/* --------------------------- 2. 小文件有多贵 --------------------------- */

console.log("② 同样的字节，拆成小文件会贵多少（块开销被摊薄的程度）");
console.log(hr());
console.log(`  ${pad("单文件大小", 16)} ${pad("块数", 6, true)} ${pad("gas", 15, true)} ${pad("gas/字节", 11, true)} ${pad("相对满块", 10, true)}`);
const ref = (235 * CHUNK_BYTES + GAS_MODEL.perChunk) / CHUNK_BYTES;
for (const size of [100, 1024, 5000, 12000, 24000, 48000, 96000]) {
  const g = estimateGas([{ path: "x", bytes: size }]);
  const per = g.gas / size;
  console.log(
    `  ${pad(formatBytes(size), 16)} ${pad(g.chunks, 6, true)} ${pad(g.gas.toLocaleString("en-US"), 15, true)} ` +
      `${pad(per.toFixed(0), 11, true)} ${pad((per / ref).toFixed(2) + "x", 10, true)}`,
  );
}
console.log("");
console.log(`  满块基准：${ref.toFixed(2)} gas/字节（= 235 字节费 + 11.25 块摊销）`);
console.log("");

/* --------------------------- 3. 块边界机会 --------------------------- */

console.log("③ 块边界机会 —— 只压几百字节就能省一整块（270,000 gas）");
console.log(hr());

const boundary = scan.billable
  .map((f) => {
    const over = f.bytes - (f.chunks - 1) * CHUNK_BYTES; // 压掉这么多就能少一块
    return { ...f, over, saveable: over <= 3000 }; // 3 KB 内算「够得着」
  })
  .filter((f) => f.chunks >= 2 && f.saveable)
  .sort((a, b) => a.over - b.over);

if (boundary.length) {
  console.log(`  ${pad("文件", 34)} ${pad("当前", 10, true)} ${pad("块", 5, true)} ${pad("只需压掉", 10, true)} ${pad("就省", 8, true)} ${pad("价值", 20, true)}`);
  for (const f of boundary.slice(0, 12)) {
    const c = costOf({ gas: GAS_MODEL.perChunk }, price);
    console.log(
      `  ${pad(f.path, 34)} ${pad(formatBytes(f.bytes), 10, true)} ${pad(f.chunks, 5, true)} ` +
        `${pad(formatBytes(f.over), 10, true)} ${pad("1 块", 8, true)} ${pad(money(c.native, c.usd), 20, true)}`,
    );
  }
  const totalBoundary = boundary.length;
  const bc = costOf({ gas: totalBoundary * GAS_MODEL.perChunk }, price);
  console.log("");
  console.log(
    `  ▸ 共 ${totalBoundary} 个文件「离降一块很近」，全部跨过去可省 ${totalBoundary} 块 ` +
      `= ${money(bc.native, bc.usd)}（只压掉约 ${formatBytes(boundary.reduce((a, f) => a + f.over, 0))}）`,
  );
} else {
  console.log("  没有「离降一块很近」的文件。");
}
console.log("");

/* ----------------------- 4. 每个文件的真实成本 ----------------------- */

console.log("④ 谁在花钱（按 gas 排序，前 12）");
console.log(hr());
console.log(
  `  ${pad("文件", 32)} ${pad("字节", 10, true)} ${pad("块", 4, true)} ${pad("块开销", 12, true)} ${pad("字节开销", 13, true)} ${pad("费用", 20, true)}`,
);
const byGas = [...scan.billable].sort((a, b) => b.gas - a.gas).slice(0, 12);
for (const f of byGas) {
  const cg = f.chunks * GAS_MODEL.perChunk;
  const bg = f.bytes * GAS_MODEL.perByte;
  const c = costOf({ gas: f.gas }, price);
  const hot = cg / f.gas > 0.3 ? " ←块主导" : "";
  console.log(
    `  ${pad(f.path, 32)} ${pad(formatBytes(f.bytes), 10, true)} ${pad(f.chunks, 4, true)} ` +
      `${pad(cg.toLocaleString("en-US"), 12, true)} ${pad(bg.toLocaleString("en-US"), 13, true)} ${pad(money(c.native, c.usd), 20, true)}${hot}`,
  );
}
console.log("");

/* ------------------------- 5. 剩余优化空间 ------------------------- */

console.log("⑤ 还没做的优化（按性价比排序）");
console.log(hr());

const dead = scan.billable.filter((f) => scan.references.unreferenced.includes(f.path));
const docs = scan.billable.filter((f) => /\.(?:md|map|lock|log)$/i.test(f.path));
const fonts = scan.billable.filter((f) => /\.(?:woff2?|ttf|otf)$/i.test(f.path));
const htmls = scan.billable.filter((f) => f.ext === "html" || f.ext === "htm");

const opps = [];
if (docs.length || dead.length) {
  const set = new Map();
  for (const f of [...docs, ...dead]) set.set(f.path, f);
  const list = [...set.values()];
  const g = estimateGas(list);
  const c = costOf({ gas: g.gas }, price);
  opps.push({
    label: `删掉 ${list.length} 个死文件 / 非站点文件`,
    detail: list.map((f) => f.path).join("、"),
    gas: g.gas,
    cost: c,
    risk: "零风险",
  });
}
if (fonts.length) {
  const fb = fonts.reduce((a, f) => a + f.bytes, 0);
  const saved = Math.round(fb * 0.3); // 实测子集化约省 30%
  const g = { gas: saved * GAS_MODEL.perByte };
  const c = costOf(g, price);
  opps.push({
    label: `字体子集化（实测可省约 30%）`,
    detail: `当前 ${fonts.length} 个字体共 ${formatBytes(fb)}`,
    gas: g.gas,
    cost: c,
    risk: "需码位覆盖校验",
  });
}
if (htmls.length) {
  const hb = htmls.reduce((a, f) => a + f.bytes, 0);
  const saved = Math.round(hb * 0.3); // 保守起子集，激进 HTML 约再省 30%
  const g = { gas: saved * GAS_MODEL.perByte };
  const c = costOf(g, price);
  opps.push({
    label: `HTML 激进压缩（去引号 + 折叠空白）`,
    detail: `${htmls.length} 个文件共 ${formatBytes(hb)}`,
    gas: g.gas,
    cost: c,
    risk: "要 verify 兜底",
  });
}

opps.sort((a, b) => b.cost.native - a.cost.native);
let oppTotal = 0;
for (const o of opps) {
  oppTotal += o.cost.native;
  console.log(
    `  ${pad(o.label, 34)} ${pad(formatUsd(o.cost.usd), 10, true)}  ${pad(o.risk, 16)} ${o.detail.slice(0, 30)}`,
  );
}
console.log(hr());
console.log(
  `  ${pad("合计还有约", 34)} ${pad(formatUsd(opps.reduce((a, o) => a + (o.cost.usd || 0), 0)), 10, true)}  ` +
    `（占当前账单 ${(((opps.reduce((a, o) => a + (o.cost.usd || 0), 0)) / totalCost.usd) * 100).toFixed(0)}%）`,
);
console.log("");
