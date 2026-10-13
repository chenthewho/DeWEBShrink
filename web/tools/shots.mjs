#!/usr/bin/env node
/* ==========================================================================
   shots.mjs —— 按区块截图（走 CDP，不装依赖）
   --------------------------------------------------------------------------
   为什么不用 "--screenshot + #anchor"：headless 在字体/布局稳定前就会截，
   锚点跳转经常被布局抖动吃掉。这里用 CDP 先 scrollIntoView、等一帧、再截。

   用法：node web/serve.mjs & node web/tools/shots.mjs [--port=5240] [--out=/tmp/deweb-shots] [--lang=zh]
   ========================================================================== */

import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || `--${k}=${d}`).split("=")[1];
const port = Number(arg("port", 5240));
const out = arg("out", "/tmp/deweb-shots");
const lang = arg("lang", "zh");
/* zh → /    en → /en/    m → /m/（390 手机版，带移动端模拟） */
const base = `http://127.0.0.1:${port}${lang === "en" ? "/en/" : lang === "m" ? "/m/" : "/"}`;
const mobile = lang === "m";

const SECTIONS = mobile
  ? ["hero", "checkup", "running", "bill", "footer"]
  : ["hero", "checkup", "pricing", "features", "how", "case", "iterate", "limits", "use", "faq", "footer"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = "/tmp/chrome-shots";
await fs.rm(profile, { recursive: true, force: true });
await fs.mkdir(out, { recursive: true });
const child = spawn(CHROME, [
  "--headless=old", "--no-sandbox", "--disable-gpu", "--hide-scrollbars",
  `--force-device-scale-factor=${mobile ? 2 : 1}`, `--window-size=${mobile ? 390 : 1440},${mobile ? 1500 : 1200}`, 
  "--no-first-run", "--no-default-browser-check", "--disable-extensions",
  "--disable-background-networking", "--remote-debugging-port=0", "--remote-allow-origins=*",
  `--user-data-dir=${profile}`, "about:blank",
], { stdio: "ignore" });

let debugPort = null;
for (let i = 0; i < 100 && !debugPort; i++) {
  await sleep(120);
  try { debugPort = (await fs.readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0].trim(); } catch {}
}
let wsUrl = null;
for (let i = 0; i < 40 && !wsUrl; i++) {
  const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json().catch(() => []);
  wsUrl = list.find((t) => t.type === "page")?.webSocketDebuggerUrl ?? null;
  if (!wsUrl) await sleep(150);
}
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0;
const pending = new Map();
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
});
const send = (method, params = {}) =>
  new Promise((resolve) => { const i = ++id; pending.set(i, resolve); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expression) =>
  (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.value;

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", mobile
  ? { width: 390, height: 1500, deviceScaleFactor: 2, mobile: true }
  : { width: 1440, height: 1200, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: base });
await sleep(2500);
await evaluate("document.fonts && document.fonts.ready");

if (process.argv.includes("--run-demo")) {
  await evaluate('document.querySelector(".pen-demo").click()');
  for (let i = 0; i < 240; i++) {
    await sleep(500);
    const st = await evaluate("document.documentElement.dataset.state");
    if (["pass", "warn", "fail", "error"].includes(st)) { console.log(`  跑完体检：${st}`); break; }
  }
  SECTIONS.push("checkup", "iterate");
}

for (const s of SECTIONS) {
  const ok = await evaluate(`(() => { const el = document.getElementById(${JSON.stringify(s)}); if (!el) return false; el.scrollIntoView({ block: "start", behavior: "instant" }); return true; })()`);
  if (!ok) { console.log(`  跳过 ${s}（没有这个区块）`); continue; }
  await sleep(450);
  const shot = await send("Page.captureScreenshot", { format: "png" });
  await fs.writeFile(path.join(out, `${lang}-${s}.png`), Buffer.from(shot.data, "base64"));
  console.log(`  ✓ ${lang}-${s}.png`);
}

/* 整页也来一张，方便和设计稿整体对 */
const height = await evaluate("document.documentElement.scrollHeight");
console.log(`  页面总高 ${height}px`);
await send("Emulation.setDeviceMetricsOverride", mobile
  ? { width: 390, height: Math.min(height, 16000), deviceScaleFactor: 1, mobile: true }
  : { width: 1440, height: Math.min(height, 16000), deviceScaleFactor: 1, mobile: false });
await sleep(600);
const full = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
await fs.writeFile(path.join(out, `${lang}-full.png`), Buffer.from(full.data, "base64"));
console.log(`  ✓ ${lang}-full.png`);

child.kill("SIGTERM");
process.exit(0);
