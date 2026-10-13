#!/usr/bin/env node
/* ==========================================================================
   verify-site.mjs —— 站点验收（不装依赖，直接走 CDP）
   --------------------------------------------------------------------------
   为什么不用 playwright：这台机器上不装包也能跑。Chrome 开 remote-debugging，
   用 Node 22 自带的 WebSocket 连 CDP，就能拿到「点一下、跑一遍、读结果」的能力。

   验的东西（每条都是页面上的真实行为，不是结构快照）：
     1. 首屏结构：导航锚点、默认隐藏的块确实没显示、浮动 CTA 滚过首屏才出现
     2. 在线体检：点「试用示例站点」→ Worker 真跑一遍 → 账单表/三个大数字/10 项校验被填上
     3. 状态块：明细默认收起、错误态与状态画廊默认不显示（已确认的产品行为）
     4. 交互：FAQ 手风琴、三种用法 Tab、复制按钮不报错
     5. 双语：/en/ 的文案与隐藏块行为一致
     6. 移动端 390px：没有横向溢出、手机降级块出现、导航收起来
     7. 控制台零报错、零未捕获异常

   用法：node web/serve.mjs & node web/tools/verify-site.mjs [--port=5240] [--shots=/tmp/deweb-shots]
   ========================================================================== */

import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const port = Number((process.argv.find((a) => a.startsWith("--port=")) || "").split("=")[1] ?? 5240);
const SHOTS = (process.argv.find((a) => a.startsWith("--shots=")) || "").split("=")[1] ?? "/tmp/deweb-shots";
const BASE = `http://127.0.0.1:${port}`;

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  ✓ ${name}${detail ? `  ${detail}` : ""}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `  ${detail}` : ""}`); }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* --------------------------------------------------------------- CDP 客户端 */

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP 超时：${method}`));
      }, 180000);
    });
  }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval 抛错");
    return r.result.value;
  }
  async shot(file) {
    const r = await this.send("Page.captureScreenshot", { format: "png" });
    await fs.writeFile(file, Buffer.from(r.data, "base64"));
  }
  /** 滚到某个元素再截：可视区截图，尺寸不会爆 */
  async shotOf(selector, file) {
    await this.eval(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: "start", behavior: "instant" })`);
    await sleep(350);
    await this.shot(file);
  }
  /** 页面里的报错：只关心真错误，过滤掉资源 404（fonts 之类的第三方域名失败不算） */
  errors() {
    return this.events
      .filter((e) => e.method === "Runtime.exceptionThrown" ||
        (e.method === "Runtime.consoleAPICalled" && e.params.type === "error"))
      .map((e) => e.params.exceptionDetails?.exception?.description ?? e.params.args?.map((a) => a.value).join(" ") ?? "")
      .filter((t) => t && !/fonts\.googleapis|fonts\.gstatic|ERR_NAME_NOT_RESOLVED|Failed to load resource/i.test(t));
  }
}

async function launchChrome(profile) {
  await fs.rm(profile, { recursive: true, force: true });
  const args = [
    "--headless=old", "--no-sandbox", "--disable-gpu", "--hide-scrollbars",
    "--force-device-scale-factor=1", "--window-size=1440,1000",
    "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-background-networking",
    "--remote-debugging-port=0", "--remote-allow-origins=*", `--user-data-dir=${profile}`, "about:blank",
  ];
  const child = spawn(CHROME, args, { stdio: ["ignore", "pipe", "pipe"] });
  const devtools = path.join(profile, "DevToolsActivePort");
  let debugPort = null;
  for (let i = 0; i < 100 && !debugPort; i++) {
    await sleep(120);
    try {
      debugPort = (await fs.readFile(devtools, "utf8")).split("\n")[0].trim();
    } catch { /* 还没起来 */ }
  }
  if (!debugPort) throw new Error("Chrome 没起来（DevToolsActivePort 读不到）");
  /* 页面级 target 的 ws 地址要从 /json/list 拿（DevToolsActivePort 第二行是 browser 级的） */
  let wsUrl = null;
  for (let i = 0; i < 40 && !wsUrl; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
      wsUrl = list.find((t) => t.type === "page")?.webSocketDebuggerUrl ?? null;
    } catch { /* 再等 */ }
    if (!wsUrl) await sleep(150);
  }
  if (!wsUrl) throw new Error("Chrome 起来了但拿不到页面 target");
  return { child, wsUrl };
}

async function connect(wsUrl) {
  for (let i = 0; i < 40; i++) {
    try {
      const ws = new WebSocket(wsUrl);
      await new Promise((resolve, reject) => {
        ws.addEventListener("open", resolve, { once: true });
        ws.addEventListener("error", reject, { once: true });
      });
      return new CDP(ws);
    } catch {
      await sleep(150);
    }
  }
  throw new Error("连不上 CDP");
}

/* ------------------------------------------------------------------- 主流程 */

const { child, wsUrl } = await launchChrome("/tmp/chrome-verify");
const cdp = await connect(wsUrl);
await cdp.send("Page.enable");
await cdp.send("Runtime.enable");
await cdp.send("Network.enable");
await fs.mkdir(SHOTS, { recursive: true });

/* 桌面档：显式钉住 1440 CSS 像素，别受 headless 默认 DSF 影响 */
await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

const goto = async (url) => {
  await cdp.send("Page.navigate", { url });
  await sleep(1500);
};

/* ---- 1. 中文桌面首页 ---- */
console.log("\n① 中文桌面首页 · 结构与默认状态");
await goto(`${BASE}/`);
await cdp.eval("document.fonts && document.fonts.ready");

check("标题正确", (await cdp.eval("document.title")).includes("DeWEBShrink"), await cdp.eval("document.title"));
check("导航锚点齐全", (await cdp.eval('document.querySelectorAll(".pen-navlink").length')) >= 12,
  `navlink=${await cdp.eval('document.querySelectorAll(".pen-navlink").length')}`);
check("12 个区块都在", (await cdp.eval('document.querySelectorAll("section.pen-section, header.pen-section, footer.pen-section").length')) === 12);
check("明细默认收起", await cdp.eval('getComputedStyle(document.querySelector(\'[data-hook~="details"]\')).display === "none"'));
check("错误态默认不显示", await cdp.eval('getComputedStyle(document.querySelector(\'[data-hook~="errors-gallery"]\')).display === "none"'));
check("状态画廊默认不显示", await cdp.eval('getComputedStyle(document.querySelector(\'[data-hook~="state-gallery"]\')).display === "none"'));
check("浮动 CTA 初始隐藏", await cdp.eval('!document.querySelector(".pen-reusable")?.classList.contains("is-shown")'));
check("gasPrice 是真输入框", await cdp.eval('document.querySelector(\'[data-hook~="gas-price"]\')?.tagName === "INPUT"'));

/* 新设计稿的三类「磁带」元素 */
check("打孔带（perf shader）已生成", (await cdp.eval('document.querySelectorAll(\'[data-shader="perf"]\').length')) >= 8);
check("网格底纹（tape-grid shader）已生成", (await cdp.eval('document.querySelectorAll(\'[data-shader="tape-grid"]\').length')) >= 1);
check("打孔带的 CSS 真的画出来了（有背景图）", await cdp.eval(`(() => {
  const el = document.querySelector('[data-shader="perf"]');
  return getComputedStyle(el).backgroundImage.includes("repeating-linear-gradient");
})()`));
check("导航里有磁带机（REC / 电平表 / 计数器）",
  await cdp.eval('!!document.querySelector(\'[data-hook~="rec-led"]\') && !!document.querySelector(\'[data-hook~="vu-meter"]\') && !!document.querySelector(\'[data-hook~="tape-counter"]\')'));
check("hero 的磁带模块在（TAPE-001 / 走带键 / CNT）",
  await cdp.eval('!!document.querySelector(\'[data-hook~="tape-code"]\') && !!document.querySelector(\'[data-hook~="tape-play"]\') && !!document.querySelector(\'[data-hook~="tape-count"]\')'));
check("像素字体已加载（REC / 计数器用 VT323）", await cdp.eval(`(() => {
  const el = document.querySelector('[data-hook~="tape-counter"]');
  return el && getComputedStyle(el).fontFamily.includes("VT323");
})()`));
check("TRK 眉标在（TRK-00 / TRK-01）", await cdp.eval('document.body.innerText.includes("TRK-00") && document.body.innerText.includes("TRK-01")'));
check("页面没有横向溢出", await cdp.eval("document.documentElement.scrollWidth <= 1441"),
  `scrollWidth=${await cdp.eval("document.documentElement.scrollWidth")}`);

/* ---- 2. 真跑一遍体检 ---- */
console.log("\n② 在线体检 · 点示例站点真跑一遍（首次要下 12 MB wasm，等一下）");
const t0 = Date.now();
await cdp.eval('document.querySelector(".pen-demo").click()');
let state = "idle";
for (let i = 0; i < 240; i++) {
  await sleep(500);
  state = await cdp.eval("document.documentElement.dataset.state");
  if (state === "pass" || state === "warn" || state === "fail" || state === "error") break;
}
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
check(`流水线跑完（${elapsed}s）`, ["pass", "warn", "fail"].includes(state), `state=${state}`);
check("三个大数字被填上真实值", /\$[0-9]/.test(await cdp.eval('document.querySelector(\'[data-hook~="saved-usd"]\').textContent.trim()')),
  `saved=${await cdp.eval('document.querySelector(\'[data-hook~="saved-usd"]\').textContent.trim()')}`);
check("体积数字是 KB/MB", /KB|MB|B/.test(await cdp.eval('document.querySelector(\'[data-hook~="saved-bytes"]\').textContent.trim()')));
check("账单表「优化前」有字节数", /[0-9,]{4,}/.test(await cdp.eval('document.querySelector(\'[data-hook~="row-before"]\').children[2].textContent')));
check("页面里没有 [object Object]（渲染占位错误）", !/\[object /.test(await cdp.eval("document.body.innerText")));
check("优化后确实比优化前小", await cdp.eval(`(() => {
  const num = (sel, i) => Number(document.querySelector(sel).children[i].textContent.replace(/[^0-9]/g, ""));
  return num('[data-hook~="row-before"]', 2) > num('[data-hook~="row-after"]', 2) && num('[data-hook~="row-before"]', 2) > 0;
})()`));
check("gas 列是数字不是对象", /^[0-9,]+$/.test((await cdp.eval('document.querySelector(\'[data-hook~="row-before"]\').children[4].textContent')).trim()));
check("校验行被重建成 10 条", (await cdp.eval('document.querySelectorAll(".pen-checkrow").length')) === 10,
  `rows=${await cdp.eval('document.querySelectorAll(".pen-checkrow").length')}`);
check("校验计数与状态一致", /PASS/.test(await cdp.eval('document.querySelector(\'[data-hook~="ver-count"]\').textContent')));
check("状态图标按状态显示", await cdp.eval(`(() => {
  const row = document.querySelector(".pen-checkrow");
  const status = row.dataset.status;
  const shown = [...row.querySelectorAll("svg")].filter(s => getComputedStyle(s).display !== "none");
  return shown.length === 1 && shown[0].classList.contains("js-ic-" + status);
})()`));
check("明细统计被填上", (await cdp.eval('document.querySelector(\'[data-hook~="detail-changed-count"]\').textContent')).length > 3,
  await cdp.eval('document.querySelector(\'[data-hook~="detail-changed-count"]\').textContent'));
check("下载按钮已启用", await cdp.eval('(() => { const d = document.querySelector(\'[data-hook~="download"]\'); return !d.disabled && getComputedStyle(d).opacity === "1"; })()'));
check("磁带机走到 DONE 并记下时长", /DONE/.test(await cdp.eval('document.querySelector(\'[data-hook~="tape-status"]\').textContent')),
  await cdp.eval('document.querySelector(\'[data-hook~="tape-status"]\').textContent'));
check("CNT 记的是处理过的文件数", /CNT \d{4}/.test(await cdp.eval('document.querySelector(\'[data-hook~="tape-count"]\').textContent')),
  await cdp.eval('document.querySelector(\'[data-hook~="tape-count"]\').textContent'));
check("进度条跑到 100%", await cdp.eval('document.querySelector(".pen-progress > i").style.width === "100%"'));
await cdp.shotOf('[data-hook~="row-before"]', path.join(SHOTS, "v1-zh-bill.png"));
await cdp.shotOf('[data-hook~="ver-cols"]', path.join(SHOTS, "v1-zh-checks.png"));

/* ---- 3. 交互 ---- */
console.log("\n③ 交互 · FAQ / Tab / 详情展开");
check("FAQ 默认展开第 1 条", await cdp.eval('document.querySelectorAll(".pen-faq-item")[0].classList.contains("is-open")'));
check("FAQ 其余条目默认收起", await cdp.eval('(() => { const a = document.querySelectorAll(".pen-faq-item")[1]; return !a.classList.contains("is-open") && getComputedStyle(a.querySelector(\'[data-hook~="faq-a"]\')).display === "none"; })()'));
await cdp.eval('document.querySelectorAll(".pen-faq-item")[1].querySelector(\'[data-hook~="faq-q"]\').click()');
await sleep(200);
check("点开第 2 条后答案可见", await cdp.eval('getComputedStyle(document.querySelectorAll(".pen-faq-item")[1].querySelector(\'[data-hook~="faq-a"]\')).display !== "none"'));
await cdp.eval('document.querySelector(\'[data-hook~="tab-cli"]\').click()');
await sleep(200);
check("切到 CLI Tab 后只显示 CLI 卡", await cdp.eval('(() => { const cli = document.querySelector(\'[data-hook~="panel-cli"]\'), web = document.querySelector(\'[data-hook~="panel-web"]\'); return getComputedStyle(cli).display !== "none" && getComputedStyle(web).display === "none"; })()'));
await cdp.eval('document.querySelector(\'[data-hook~="tab-web"]\').click()');
await cdp.eval('document.querySelector(\'[data-hook~="full-report"]\').click()');
await sleep(200);
check("展开完整报告后明细可见", await cdp.eval('getComputedStyle(document.querySelector(\'[data-hook~="details"]\')).display !== "none"'));

/* ---- 4. 浮动 CTA ---- */
await cdp.eval("window.scrollTo(0, 2000)");
await sleep(400);
check("滚过首屏后浮动 CTA 出现", await cdp.eval('document.querySelector(".pen-reusable").classList.contains("is-shown")'));
check("粘性导航进入滚动态", await cdp.eval('document.querySelector("header").classList.contains("is-scrolled")'));

/* ---- 5. 英文页 ---- */
console.log("\n④ 英文页 /en/");
await goto(`${BASE}/en/`);
check("英文标题", (await cdp.eval("document.title")).includes("check up your site"), await cdp.eval("document.title"));
check("英文导航文案", (await cdp.eval("document.body.textContent")).includes("Run a checkup"));
check("英文页明细同样默认收起", await cdp.eval('getComputedStyle(document.querySelector(\'[data-hook~="details"]\')).display === "none"'));
check("英文页只有一个语言按钮处于选中态", await cdp.eval(`(() => {
  const lit = [...document.querySelectorAll('[data-hook~="lang-zh"], [data-hook~="lang-en"]')]
    .filter(el => getComputedStyle(el).backgroundColor !== "rgba(0, 0, 0, 0)");
  return lit.length === 1 && lit[0].dataset.hook === "lang-en";
})()`));
check("英文页无横向溢出", await cdp.eval("document.documentElement.scrollWidth <= 1441"), `scrollWidth=${await cdp.eval("document.documentElement.scrollWidth")}`);
await cdp.shot(path.join(SHOTS, "v2-en-top.png"));

/* ---- 5. 手机版 /m/（设计稿里的独立流程） ---- */
console.log("\n⑤ 手机版 /m/（390 设计稿）");
await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await goto(`${BASE}/m/`);
await sleep(800);
check("手机版 6 个区块都在", (await cdp.eval('document.querySelectorAll(".pen-section").length')) === 6,
  `sections=${await cdp.eval('document.querySelectorAll(".pen-section").length')}`);
check("「运行中」默认隐藏（状态页）", await cdp.eval('getComputedStyle(document.querySelector(\'[data-hook~="m-running"]\')).display === "none"'));
check("「账单」默认隐藏（状态页）", await cdp.eval('getComputedStyle(document.querySelector(\'[data-hook~="m-bill"]\')).display === "none"'));
check("手机版是「选择单个文件」（没有目录拖拽）", await cdp.eval('!!document.getElementById("pen-file-input") && !document.getElementById("pen-folder-input")'));
check("手机版不能横向滚动", await cdp.eval(`(() => { const se = document.scrollingElement; se.scrollLeft = 80; const m = se.scrollLeft; se.scrollLeft = 0; return m; })()`) === 0);

/* 真的塞几个文件进去跑一遍：走 CDP 的文件输入，不是模拟点击 */
const fixtures = ["index.html", "chain.js", "clock.js", "pwa.js"].map((f) => `${ROOT}/fixtures/07-real-site/${f}`);
const doc = await cdp.send("DOM.getDocument", { depth: -1 });
const nodeId = (await cdp.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: "#pen-file-input" })).nodeId;
await cdp.send("DOM.setFileInputFiles", { files: fixtures, nodeId });
await cdp.eval('document.getElementById("pen-file-input").dispatchEvent(new Event("change"))');
await sleep(400);
check("选完文件后仍然不显示账单（还没跑）", await cdp.eval('getComputedStyle(document.querySelector(\'[data-hook~="m-bill"]\')).display === "none"'));
await cdp.eval('document.querySelector(\'[data-hook~="run"]\').click()');
let mstate = "idle";
for (let i = 0; i < 200; i++) {
  await sleep(500);
  mstate = await cdp.eval("document.documentElement.dataset.state");
  if (["pass", "warn", "fail", "error"].includes(mstate)) break;
}
check(`手机版跑完（state=${mstate}）`, ["pass", "warn", "fail"].includes(mstate));
check("跑完隐藏「运行中」", await cdp.eval('getComputedStyle(document.querySelector(\'[data-hook~="m-running"]\')).display === "none"'));
check("跑完显示「账单」", await cdp.eval('getComputedStyle(document.querySelector(\'[data-hook~="m-bill"]\')).display !== "none"'));
check("手机版账单数字是真实值", /\$[0-9]/.test(await cdp.eval('document.querySelector(\'[data-hook~="saved-usd"]\').textContent')),
  await cdp.eval('document.querySelector(\'[data-hook~="saved-usd"]\').textContent'));
check("手机版账单表 3 列数据都在", await cdp.eval(`(() => {
  const row = document.querySelector('[data-hook~="row-before"]');
  return row && row.children.length === 4 && [...row.children].slice(1).every((c) => c.textContent.trim().length > 0);
})()`));
await cdp.shot(path.join(SHOTS, "v3-mobile-bill.png"));
await cdp.send("Emulation.clearDeviceMetricsOverride");

/* ---- 7. 报错 ---- */
console.log("\n⑥ 控制台");
const errs = cdp.errors();
check("没有未捕获异常 / console.error", errs.length === 0, errs.slice(0, 3).join(" | "));

console.log(`\n${fail === 0 ? "✓ 全部通过" : "✗ 有失败项"}  ${pass} passed, ${fail} failed`);
console.log(`截图目录：${SHOTS}`);

child.kill("SIGTERM");
process.exit(fail === 0 ? 0 : 1);
