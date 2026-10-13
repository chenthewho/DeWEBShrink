#!/usr/bin/env node
/* ==========================================================================
   PoC 无头验收：真浏览器跑一遍，和 Node 原生流水线对拍
   --------------------------------------------------------------------------
   为什么非要真浏览器：Worker、wasm 加载、WebCrypto、模块解析这些只有在浏览器里
   才知道成不成。本机装了 Chrome，就用它的无头模式当测试宿主：

     1. Node 侧先跑原生流水线（sharp/esbuild）拿到基准 A
     2. 起本地静态服务器（带 /__fixture 与 /__result 两个测试口子）
     3. 无头 Chrome 打开 /test.html：页内 Worker 跑两遍（A 无图片、B 开 oxipng），
        结果 POST 回服务器
     4. 对拍：字段与产物 sha256 必须与基准一致（B 另外确认图片尺寸没变）

   用法：node poc/test-headless.mjs [--keep-open]
   ========================================================================== */

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { optimizeSite } from "../src/optimize/index.js";
import { createMemorySink, createMemorySource } from "../src/source.js";
import { scanSite } from "../src/scan.js";
import { estimateGas, costOf } from "../src/cost.js";
import { createPocServer } from "./serve.mjs";

const POC = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(POC, "..");
const SITE = path.join(ROOT, "fixtures", "07-real-site");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
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

/* --------------------------- ① Node 基准 --------------------------- */

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
console.log(`\n基准：Node 原生流水线（${files.length} 个文件）`);
const baseScan = await scanSite(createMemorySource(files));
const base = await optimizeSite({
  source: createMemorySource(files),
  sink: createMemorySink(),
  options: NO_IMAGES,
  ...PRICING,
});
const reference = {
  before: baseScan.totals,
  gasBefore: estimateGas(baseScan.billable).gas,
  costBefore: costOf(estimateGas(baseScan.billable), PRICING),
  after: base.after.totals,
  gasAfter: base.after.gas.gas,
  costAfter: base.after.cost,
  saved: base.saved,
  dropped: (base.files?.dropped || []).map((d) => d.path),
  renames: base.files?.renames || [],
  checks: (base.verification?.checks || []).map((c) => [c.name, c.status, c.detail]),
  artifacts: base.artifacts.map((a) => [a.path, a.bytes]),
  artifactHashes: base.artifacts.map((a) => [a.path, a.bytes, sha(Buffer.from(a.base64, "base64"))]),
};
console.log(`  ${reference.before.bytes} B → ${reference.after.bytes} B · ${reference.gasAfter.toLocaleString("en-US")} gas\n`);

/* --------------------------- ② 起服务器 + Chrome --------------------------- */

const { server, waitForResult, getTestState } = createPocServer({ test: true });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const url = `http://127.0.0.1:${port}/test.html`;
console.log(`② 无头 Chrome 打开 ${url}`);

const profile = await fs.mkdtemp(path.join(process.env.TMPDIR || "/tmp", "poc-chrome-"));
const chrome = spawn(
  CHROME,
  [
    /* 踩过的坑：--headless=new 在这台机器上会起一个**不加载页面**的进程（GPU/进程初始化退化，
       请求日志里连 /test.html 都没有）；换成 --headless=old 才稳定。
       另外要 --no-sandbox（外层沙箱不允许 Chrome 再套一层）与 --disable-background-networking
       （否则全是 GCM/updater 噪音，看日志分不清真错误）。 */
    "--headless=old",
    "--no-sandbox",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-features=Translate,MediaRouter,OptimizationHints",
    `--user-data-dir=${profile}`,
    url,
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);
let chromeDom = "";
chrome.stdout.on("data", (d) => (chromeDom += d));
let chromeErr = "";
chrome.stderr.on("data", (d) => (chromeErr += d.toString()));

let result;
try {
  result = JSON.parse(await waitForResult(90000));
} catch (err) {
  const state = getTestState();
  console.log("\n  页面阶段埋点：");
  for (const s of state.stages) console.log(`    · ${JSON.stringify(s)}`);
  console.log("  服务器收到的请求：");
  for (const r of state.requests.slice(-12)) console.log(`    · ${r}`);
  const pageLog = chromeDom.match(/<pre id="log">([\s\S]*?)<\/pre>/)?.[1];
  if (pageLog) console.log(`  页面日志：\n${pageLog.trim().split("\n").map((l) => `    · ${l}`).join("\n")}`);
  console.log(`  Chrome stderr: ${chromeErr.split("\n").filter(Boolean).slice(-4).join(" | ")}`);
  console.log(`\n✗ 拿不到浏览器结果：${err.message}`);
  chrome.kill("SIGKILL");
  server.close();
  process.exit(1);
}

if (!process.argv.includes("--keep-open")) chrome.kill("SIGKILL");
server.close();

/* --------------------------- ③ 对拍 --------------------------- */

console.log("\n③ 对拍（浏览器 A 组 vs Node 基准）");
if (!result.ok) {
  check("浏览器页跑通", false, result.error);
  console.log(result.stack || "");
  process.exit(1);
}
check("浏览器页跑通", true, `A ${result.A.elapsedMs}ms · B ${result.B.elapsedMs}ms`);
check("扫描 totals 一致", JSON.stringify(result.A.before) === JSON.stringify(reference.before), `${reference.before.bytes} B`);
check("扫描 gas 一致", result.A.gasBefore === reference.gasBefore, `${reference.gasBefore.toLocaleString("en-US")} gas`);
check("扫描 cost 一致", JSON.stringify(result.A.costBefore) === JSON.stringify(reference.costBefore));
check("after.totals 一致", JSON.stringify(result.A.after) === JSON.stringify(reference.after), `${reference.after.bytes} B / ${reference.after.chunks} 块`);
check("after.gas 一致", result.A.gasAfter === reference.gasAfter, `${reference.gasAfter.toLocaleString("en-US")} gas`);
check("after.cost 一致", JSON.stringify(result.A.costAfter) === JSON.stringify(reference.costAfter));
check("saved 一致", JSON.stringify(result.A.saved) === JSON.stringify(reference.saved), `省 $${reference.saved.usd?.toFixed(4)}`);
check("删除清单一致", JSON.stringify(result.A.dropped) === JSON.stringify(reference.dropped), reference.dropped.join("、") || "（无）");
check("校验项一致", JSON.stringify(result.A.checks) === JSON.stringify(reference.checks), `${reference.checks.length} 项`);
check("产物清单一致", JSON.stringify(result.A.artifacts) === JSON.stringify(reference.artifacts), `${reference.artifacts.length} 个`);

const hashA = JSON.stringify(result.A.artifactHashes || []);
const hashRef = JSON.stringify(reference.artifactHashes);
check("每个产物 sha256 一致（真·逐字节）", hashA === hashRef, hashA === hashRef ? `${reference.artifacts.length} 个文件` : "有差异");
if (hashA !== hashRef) {
  const a = new Map((result.A.artifactHashes || []).map(([p, n, h]) => [p, `${n}:${h}`]));
  const b = new Map(reference.artifactHashes.map(([p, n, h]) => [p, `${n}:${h}`]));
  for (const p of new Set([...a.keys(), ...b.keys()])) {
    if (a.get(p) !== b.get(p)) console.log(`    · ${p}: 浏览器 ${a.get(p)?.slice(0, 12)} vs Node ${b.get(p)?.slice(0, 12)}`);
  }
}

console.log("\n④ 图片路径（oxipng 无损）");
check("B 组跑通且校验通过", result.B.ok === true, `warn ${result.B.warned}`);
check("产物里有 PNG", result.B.pngCount > 0, `${result.B.pngCount} 张 · 共 ${result.B.pngAfter} B`);
check("图片尺寸校验通过（只换编码不变尺寸）", result.B.dimCheck?.[0] === "pass", result.B.dimCheck?.[1]?.slice(0, 60));
check("B 组确实比 A 组小（无损重压有效或至少不变大）", result.B.afterBytes <= result.A.after.bytes, `A ${result.A.after.bytes} B → B ${result.B.afterBytes} B`);

console.log("\n" + "═".repeat(60));
console.log(`  无头浏览器验收：${pass} 通过 / ${fail} 失败`);
console.log("═".repeat(60));
await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
process.exit(fail ? 1 : 0);
