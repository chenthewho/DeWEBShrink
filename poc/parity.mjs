#!/usr/bin/env node
/* ==========================================================================
   PoC 对拍：浏览器版流水线 vs 原生版流水线
   --------------------------------------------------------------------------
   两边跑**同一份输入**（fixtures/07-real-site，21 个文件 / 812 KB）：

     A. 浏览器版：poc/dist/pipeline.node.mjs
        —— 由 src/ 打包而来，但 esbuild→esbuild-wasm、sharp→oxipng、crypto→纯 JS
     B. 原生版：直接 import src/optimize/index.js
        —— 真正的 esbuild 二进制 + sharp/libvips

   为了只比较「该一致的部分」，两边都关掉图片编码（optimizePng/Jpeg=false）：
   图片走的是完全不同的编码器（libvips vs oxipng），本来就该不同，见 README。

   必须逐字节/逐字段一致的东西：
     · scan 账单（文件数、字节、块数、gas、cost）
     · 产物集合与每个文本产物的字节（HTML/CSS/JS/JSON）
     · 删除清单、改名清单
     · 校验结论（10 项检查的 status 与 detail）
     · saved 数字
   ========================================================================== */

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import { optimizeSite } from "../src/optimize/index.js";
import { createMemorySink, createMemorySource } from "../src/source.js";
import { scanSite } from "../src/scan.js";
import { estimateGas, costOf } from "../src/cost.js";
import { shrinkFiles, scanFiles } from "./dist/pipeline.node.mjs";

const POC = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(POC, "..");
const SITE = path.join(ROOT, "fixtures", "07-real-site");
const NO_IMAGES = { optimizePng: false, optimizeJpeg: false, optimizeWebp: false, convertImages: false };
const PRICING = { network: "bsc", gasPriceGwei: 0.05, priceUsd: 750 };

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? `  ${detail}` : ""}`);
};

const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

/** 读目录成内存文件数组（浏览器里这一步换成 <input webkitdirectory>）。 */
async function loadFiles(dir) {
  const out = [];
  const walk = async (abs, rel) => {
    for (const e of await fs.readdir(abs, { withFileTypes: true })) {
      const a = path.join(abs, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(a, r);
      else if (e.isFile()) out.push({ path: r, bytes: new Uint8Array(await fs.readFile(a)) });
    }
  };
  await walk(dir, "");
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

const files = await loadFiles(SITE);
const totalBytes = files.reduce((a, f) => a + f.bytes.length, 0);
console.log(`\n输入：${path.relative(ROOT, SITE)} · ${files.length} 个文件 · ${(totalBytes / 1024).toFixed(0)} KB\n`);

/* ------------------------------- A. 浏览器版 ------------------------------- */

console.log("① 浏览器版流水线（esbuild-wasm + oxipng + 纯 JS sha256）");
const tA = Date.now();
const webScan = await scanFiles(files, PRICING);
const web = await shrinkFiles({ files, options: NO_IMAGES, ...PRICING });
const webMs = Date.now() - tA;
check("浏览器版跑通", !!web.result, `${webMs}ms · 产物 ${web.json.artifacts?.length ?? 0} 个`);
check("浏览器版自校验通过", web.json.verification?.ok === true, `fail ${web.json.verification?.failed} / warn ${web.json.verification?.warned}`);

/* --------------------------------- B. 原生版 --------------------------------- */

console.log("\n② 原生版流水线（esbuild 二进制 + sharp/libvips）");
const tB = Date.now();
const nativeScan = await scanSite(createMemorySource(files));
const nativeGas = estimateGas(nativeScan.billable);
const nativeCost = costOf(nativeGas, { gasPriceGwei: PRICING.gasPriceGwei, priceUsd: PRICING.priceUsd });
const native = await optimizeSite({
  source: createMemorySource(files),
  sink: createMemorySink(),
  options: NO_IMAGES,
  ...PRICING,
});
const nativeMs = Date.now() - tB;
check("原生版跑通", !!native?.artifacts, `${nativeMs}ms · 产物 ${native?.artifacts?.length ?? 0} 个`);

/* --------------------------------- 对拍 --------------------------------- */

console.log("\n③ 对拍");

/* 1. 扫描账单 */
const tot = (s) => JSON.stringify(s.totals);
check("扫描 totals 完全一致", tot(webScan.scan) === tot(nativeScan), `${webScan.scan.totals.bytes} B / ${webScan.scan.totals.chunks} 块`);
check("扫描 gas 完全一致", webScan.gas.gas === nativeGas.gas, `${webScan.gas.gas.toLocaleString("en-US")} gas`);
check("扫描美元完全一致", webScan.cost.usd === nativeCost.usd, `$${webScan.cost.usd}`);
check(
  "引用图结论一致（断链/死文件数量）",
  JSON.stringify(webScan.scan.references) === JSON.stringify(nativeScan.references),
  `死文件 ${nativeScan.references.unreferenced.length} · 断链 ${nativeScan.references.unresolved.length}`,
);
check("重复内容结论一致", JSON.stringify(webScan.scan.duplicates) === JSON.stringify(nativeScan.duplicates), `${nativeScan.duplicates.length} 组`);

/* 2. 产物逐字节 */
const byPath = (arts) => new Map((arts || []).map((a) => [a.path, Buffer.from(a.base64, "base64")]));
const A = byPath(web.json.artifacts);
const B = byPath(native.artifacts);
const pathsA = [...A.keys()].sort().join(",");
const pathsB = [...B.keys()].sort().join(",");
check("产物文件集合一致", pathsA.length > 0 && pathsA === pathsB, `浏览器 ${A.size} 个 vs 原生 ${B.size} 个`);

const IMG = /\.(png|jpe?g|webp|avif|gif|ico)$/i;
const textDiffs = [];
for (const [p, buf] of A) {
  if (IMG.test(p)) continue;
  const other = B.get(p);
  if (!other || sha(buf) !== sha(other)) textDiffs.push(`${p}（${buf.length}B vs ${other?.length ?? "缺失"}B）`);
}
check(
  "所有文本产物逐字节一致（HTML/CSS/JS/JSON）",
  textDiffs.length === 0,
  textDiffs.join("；") || `${[...A.keys()].filter((p) => !IMG.test(p)).length} 个文本文件 sha256 相同`,
);

/* 3. 删除 / 改名 */
const names = (arr) => JSON.stringify((arr || []).map((x) => x.path ?? x.from));
check("删除清单一致", names(web.json.files?.dropped) === names(native.files?.dropped), (native.files?.dropped || []).map((d) => d.path).join("、") || "（无）");
check("改名清单一致", JSON.stringify(web.json.files?.renames || []) === JSON.stringify(native.files?.renames || []), `${(native.files?.renames || []).length} 个`);

/* 4. 账单 */
check("before.bytes 一致", web.json.before?.totals?.bytes === native.before.totals.bytes, `${native.before.totals.bytes} B`);
check("after.bytes 一致", web.json.after?.totals?.bytes === native.after.totals.bytes, `${native.after.totals.bytes} B`);
check("整站 gas 一致", web.json.after?.gas?.gas === native.after.gas.gas, `${native.after.gas.gas.toLocaleString("en-US")} gas`);
check("省下的钱一致", web.json.saved?.usd === native.saved.usd, `$${native.saved.usd?.toFixed(4)}`);

/* 5. 校验结论 */
const norm = (v) => JSON.stringify((v?.checks || []).map((c) => [c.name, c.status, c.detail]));
check("校验项（名称/结论/说明）完全一致", norm(web.json.verification) === norm(native.verification), `${(native.verification.checks || []).length} 项`);

/* 6. sha256 替身本身 */
const sample = Buffer.from("浏览器版 sha256 自检 \u{1F680} 中文 + emoji");
const { createHash } = await import("./shims/node-crypto.js");
check(
  "纯 JS sha256 与 node:crypto 一致",
  createHash("sha256").update(sample).digest("hex") === sha(sample),
  sample.length + " 字节样本",
);

/* --------------------------------- 汇总 --------------------------------- */

console.log("\n" + "═".repeat(66));
console.log(`  对拍结果：${pass} 通过 / ${fail} 失败`);
console.log(`  浏览器版耗时 ${webMs}ms · 原生版耗时 ${nativeMs}ms（首次含 wasm 加载）`);
console.log("═".repeat(66));
if (fail) {
  console.log("\n  文本产物差异明细：");
  for (const d of textDiffs) console.log(`    · ${d}`);
}
process.exit(fail ? 1 : 0);
