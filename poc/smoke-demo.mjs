#!/usr/bin/env node
/* ==========================================================================
   Demo 页面 UI 冒烟测试（真浏览器真点击）
   --------------------------------------------------------------------------
   前面三个测试验的是「算法在浏览器里对不对」；这个验的是「页面点得动吗」：
   真实 Chrome 打开 demo 首页 → 点「① 一键试用示例站点」→ 等按钮变亮 →
   点「② 开始体检 + 压缩」→ 等账单表格出现 → 把表格内容读回来核对。

   用的是 Chrome DevTools Protocol（Node 22 自带 WebSocket，不需要装 puppeteer）。

   用法：node poc/smoke-demo.mjs
   ========================================================================== */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { createPocServer } from "./serve.mjs";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? `  ${detail}` : ""}`);
};

/* ① 起 demo 服务（示例站点路由始终可用） */
const { server } = createPocServer();
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const url = `http://127.0.0.1:${port}/`;
console.log(`\n① demo 服务：${url}`);

/* ② 起 Chrome 并拿到 CDP 地址 */
const profile = await fs.mkdtemp(path.join(os.tmpdir(), "poc-smoke-"));
const chrome = spawn(
  CHROME,
  [
    "--headless=old",
    "--no-sandbox",
    "--disable-gpu",
    "--no-first-run",
    "--disable-background-networking",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    url,
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);

const wsBrowser = await new Promise((resolve, reject) => {
  let buf = "";
  const timer = setTimeout(() => reject(new Error("等 Chrome 的 DevTools 地址超时")), 30000);
  chrome.stderr.on("data", (d) => {
    buf += d.toString();
    const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
    if (m) {
      clearTimeout(timer);
      resolve(m[1]);
    }
  });
  chrome.on("exit", () => reject(new Error("Chrome 提前退出")));
});
console.log(`② DevTools: ${wsBrowser.replace(/\/devtools\/browser\/.*/, "/…")}`);

/* ③ 找到页面 target 并连上去 */
const rpcHost = new URL(wsBrowser).host;
const targets = await (await fetch(`http://${rpcHost}/json/list`)).json();
const page = targets.find((t) => t.type === "page" && t.url.startsWith(url));
if (!page) {
  console.log("  找不到页面 target：", targets.map((t) => `${t.type} ${t.url}`).join(" | "));
  chrome.kill("SIGKILL");
  server.close();
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener("open", res);
  ws.addEventListener("error", () => rej(new Error("CDP 连接失败")));
});
let msgId = 0;
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++msgId;
    const onMsg = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== id) return;
      ws.removeEventListener("message", onMsg);
      if (m.error) reject(new Error(`${method}: ${m.error.message}`));
      else resolve(m.result);
    };
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });

await send("Runtime.enable");
await send("Log.enable");
const pageLogs = [];
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === "Log.entryAdded") pageLogs.push(`[${m.params.entry.level}] ${m.params.entry.text}`);
  if (m.method === "Runtime.exceptionThrown") pageLogs.push(`[exception] ${m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text}`);
});

/* ④ 真点击：示例站点 → 开始 → 等账单 */
console.log("③ 真点击：① 一键试用示例站点 → ② 开始体检 + 压缩");
const expression = `(async () => {
  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = { stages: [] };
  try {
    out.runDisabled0 = $("run").disabled;
    $("sample").click();
    out.stages.push("clicked-sample");
    const t0 = Date.now();
    while (Date.now() - t0 < 20000 && $("run").disabled) await sleep(200);
    out.picked = $("picked").textContent;
    out.runDisabled1 = $("run").disabled;
    out.stages.push("waited-sample");
    if (!$("run").disabled) {
      $("run").click();
      out.stages.push("clicked-run");
      const t1 = Date.now();
      while (Date.now() - t1 < 120000 && !$("summary").textContent.includes("省下")) await sleep(300);
      out.progress = $("progressText").textContent;
      out.summary = $("summary").innerText.replace(/\\s+/g, " ").slice(0, 500);
      out.checks = document.querySelectorAll(".checks li").length;
      out.hasZip = !$("download").disabled;
      out.reportLen = $("report").textContent.length;
      out.stages.push("done");
    }
  } catch (e) {
    out.error = String(e);
  }
  return JSON.stringify(out);
})()`;

let out;
try {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, timeout: 240000 });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "页面内异常");
  out = JSON.parse(r.result.value);
} catch (err) {
  console.log(`\n✗ 页面点不通：${err.message}`);
  chrome.kill("SIGKILL");
  server.close();
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
  process.exit(1);
}

console.log("\n④ 结果");
console.log(`  阶段：${(out.stages || []).join(" → ")}${out.error ? ` · 异常：${out.error}` : ""}`);
console.log(`  文件：${out.picked ?? "（无）"}`);
console.log(`  账单：${out.summary ?? "（无）"}`);
if (pageLogs.length) {
  console.log("  页面 console / 异常：");
  for (const l of pageLogs.slice(0, 8)) console.log(`    · ${l.slice(0, 200)}`);
}
check("示例站点加载成功（21 个文件 / 812 KB）", /21 个文件/.test(out.picked) && /812 KB/.test(out.picked), out.picked);
check("点「开始」后出了账单表", /优化前/.test(out.summary) && /省下/.test(out.summary));
check("账单数字与 CLI 口径一致（优化前 gas 208,275,550）", (out.summary || "").includes("208,275,550"), out.summary.match(/优化前[\s\S]{0,80}/)?.[0] ?? "");
check("给出了压缩后的 gas（图片开 ≈ 175,873,185）", /17[0-9],[0-9]{3},[0-9]{3}/.test(out.summary || ""), out.summary.match(/优化后[\s\S]{0,60}/)?.[0] ?? "");
check("10 项校验都渲染出来了", out.checks === 10, `${out.checks} 项`);
check("ZIP 下载按钮可用", out.hasZip === true);
check("完整报告已渲染（与 CLI 同款）", (out.reportLen || 0) > 500, `${out.reportLen} 字`);
check("进度显示完成", /完成|用时/.test(out.progress || ""), out.progress);

console.log("\n" + "═".repeat(56));
console.log(`  Demo UI 冒烟：${pass} 通过 / ${fail} 失败`);
console.log("═".repeat(56));
chrome.kill("SIGKILL");
server.close();
await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
process.exit(fail ? 1 : 0);
