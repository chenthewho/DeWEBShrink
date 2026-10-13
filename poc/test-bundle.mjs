#!/usr/bin/env node
/* ==========================================================================
   在 Node 里跑「浏览器产物包」—— 无浏览器时的等价验收
   --------------------------------------------------------------------------
   验的是 poc/web/dist/worker.js，也就是**浏览器真正加载的那个文件**：
   esbuild-wasm 的浏览器入口、clean-css 的 node 内置替身、oxipng 的 wasm fetch、
   buffer polyfill，全都在这一份产物里。区别只是宿主换成了 Node：

     · globalThis.self / location 补上（浏览器里天然有）
     · fetch 增加 file:// 支持（浏览器里是 http 同源，本地服务负责 MIME）

   于是不需要 Chrome 也能拿到「产物包到底能不能跑」的答案；真浏览器验收见
   test-headless.mjs。
   ========================================================================== */

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

import { optimizeSite } from "../src/optimize/index.js";
import { createMemorySink, createMemorySource } from "../src/source.js";
import { scanSite } from "../src/scan.js";
import { estimateGas, costOf } from "../src/cost.js";

const POC = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(POC, "..");
const SITE = path.join(ROOT, "fixtures", "07-real-site");
const DIST = path.join(POC, "web/dist");
const NO_IMAGES = { optimizePng: false, optimizeJpeg: false, optimizeWebp: false, convertImages: false };
const PNG_ONLY = { optimizePng: true, optimizeJpeg: false, optimizeWebp: false, convertImages: false };
const PRICING = { network: "bsc", gasPriceGwei: 0.05, priceUsd: 750 };

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? `  ${detail}` : ""}`);
};
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

/* ------------------------ 浏览器环境补丁 ------------------------ */

const realFetch = globalThis.fetch;
globalThis.self = globalThis;
globalThis.location = { href: pathToFileURL(path.join(DIST, "worker.js")).href };
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  if (url.startsWith("file:")) {
    const buf = await fs.readFile(fileURLToPath(url));
    const isWasm = url.endsWith(".wasm");
    return new Response(buf, { status: 200, headers: { "content-type": isWasm ? "application/wasm" : "application/octet-stream" } });
  }
  return realFetch(input, init);
};

let inbox = null;
globalThis.postMessage = (msg) => {
  if (msg.type === "done" || msg.type === "error") inbox = msg;
};

/* ------------------------ 素材与基准 ------------------------ */

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
console.log(`\n浏览器产物包验收（poc/web/dist/worker.js）· ${files.length} 个文件\n`);

const baseScan = await scanSite(createMemorySource(files));
const baseGas = estimateGas(baseScan.billable);
const base = await optimizeSite({ source: createMemorySource(files), sink: createMemorySink(), options: NO_IMAGES, ...PRICING });
console.log(`① Node 原生基准：${baseScan.totals.bytes} B → ${base.after.totals.bytes} B · ${base.after.gas.gas.toLocaleString("en-US")} gas`);

/* 载入浏览器产物并喂给它一份输入（等于页面里 Worker 收到的那条消息） */
await import(pathToFileURL(path.join(DIST, "worker.js")).href);

async function runInBundle(options) {
  inbox = null;
  const payload = files.map((f) => ({ path: f.path, bytes: f.bytes }));
  const t0 = Date.now();
  await globalThis.self.onmessage({ data: { type: "run", files: payload, pricing: PRICING, options } });
  const ms = Date.now() - t0;
  if (!inbox) throw new Error("产物包没有回传结果");
  if (inbox.type === "error") throw new Error(`${inbox.message}\n${inbox.stack || ""}`);
  return { ...inbox, ms };
}

console.log("\n② 跑浏览器产物包");
const a = await runInBundle(NO_IMAGES);
const j = a.json;
check("产物包跑通并回传结果", !!j, `${a.ms}ms`);
check("自校验通过", j.verification?.ok === true, `fail ${j.verification?.failed} / warn ${j.verification?.warned}`);

console.log("\n③ 与 Node 原生基准对拍（无图片）");
check("扫描 totals 一致", JSON.stringify(j.before.totals) === JSON.stringify(baseScan.totals), `${j.before.totals.bytes} B`);
check("扫描 gas 一致", estimateGas(baseScan.billable).gas === baseGas.gas, `${baseGas.gas.toLocaleString("en-US")} gas`);
check("扫描 cost 一致", JSON.stringify(j.before.cost) === JSON.stringify(costOf(baseGas, PRICING)));
check("after.totals 一致", JSON.stringify(j.after.totals) === JSON.stringify(base.after.totals), `${j.after.totals.bytes} B`);
check("after.gas 一致", j.after.gas.gas === base.after.gas.gas, `${j.after.gas.gas.toLocaleString("en-US")} gas`);
check("saved 一致", JSON.stringify(j.saved) === JSON.stringify(base.saved), `省 $${base.saved.usd?.toFixed(4)}`);
check("删除清单一致", JSON.stringify((j.files?.dropped || []).map((d) => d.path)) === JSON.stringify((base.files?.dropped || []).map((d) => d.path)));
check("校验项一致", JSON.stringify((j.verification?.checks || []).map((c) => [c.name, c.status, c.detail])) === JSON.stringify((base.verification?.checks || []).map((c) => [c.name, c.status, c.detail])));

const hashes = (arts) => JSON.stringify(arts.map((x) => [x.path, x.bytes, sha(Buffer.from(x.base64, "base64"))]));
check("产物逐字节一致（含 HTML —— 证明 clean-css 替身没改变输出）", hashes(j.artifacts) === hashes(base.artifacts), `${base.artifacts.length} 个文件`);
if (hashes(j.artifacts) !== hashes(base.artifacts)) {
  const A = new Map(j.artifacts.map((x) => [x.path, sha(Buffer.from(x.base64, "base64"))]));
  for (const x of base.artifacts) {
    const h = sha(Buffer.from(x.base64, "base64"));
    if (A.get(x.path) !== h) console.log(`    · ${x.path}: 包内 ${x.bytes}B vs 基准 ${x.bytes}B · sha 不同`);
  }
}

console.log("\n④ 图片路径（oxipng 无损，只在浏览器产物里存在）");
const b = await runInBundle(PNG_ONLY);
const pngs = (b.json.artifacts || []).filter((x) => x.path.endsWith(".png"));
const dim = (b.json.verification?.checks || []).find((c) => c.name === "图片尺寸");
check("开图片后仍跑通、校验通过", b.json.verification?.ok === true, `warn ${b.json.verification?.warned}`);
check("产物里有 PNG", pngs.length > 0, `${pngs.length} 张 · 共 ${pngs.reduce((s, x) => s + x.bytes, 0)} B`);
check("图片尺寸校验 pass", dim?.status === "pass", dim?.detail?.slice(0, 50));
const pngBefore = files.filter((f) => f.path.startsWith("icons/")).reduce((s, f) => s + f.bytes.length, 0);
const iconAfter = pngs.filter((x) => x.path.startsWith("icons/")).reduce((s, x) => s + x.bytes, 0);
check(
  "PNG 无损重压有效（图标目录变小）",
  iconAfter < pngBefore,
  `icons/ ${(pngBefore / 1024).toFixed(1)} KB → ${(iconAfter / 1024).toFixed(1)} KB（省 ${(((pngBefore - iconAfter) / pngBefore) * 100).toFixed(1)}%）`,
);

console.log("\n" + "═".repeat(60));
console.log(`  浏览器产物包验收：${pass} 通过 / ${fail} 失败`);
console.log("═".repeat(60));
process.exit(fail ? 1 : 0);
