/* ==========================================================================
   site.js —— 页面行为 + 在线体检
   --------------------------------------------------------------------------
   分两半，界线很清楚：

     A. 页面行为   粘性导航 / 浮动 CTA / FAQ 手风琴 / 三种用法 Tab / 复制
     B. 在线体检   读目录（或拖拽、或示例站点）→ Web Worker 跑 src/ 的同一套算法
                   → 把结果填进设计稿生成的 DOM（hook 定位，不新增视觉样式）

   所有数字都来自 Worker 回来的 json（= src/ 那套算法），页面只负责显示。
   文件全程在本机内存里，一个字节都不发出去。
   ========================================================================== */

import { zipSync } from "fflate";

const hook = (name) => document.querySelector(`[data-hook~="${name}"]`);
const hooks = (name) => [...document.querySelectorAll(`[data-hook~="${name}"]`)];
const root = document.documentElement;
const LANG = root.dataset.lang === "en" ? "en" : "zh";

/* --------------------------------------------------------------- 文案表 */

const T = {
  zh: {
    picked: (dir, n, bytes) => `已选择：${dir} · ${n} 个文件 · ${fmtBytes(bytes)}`,
    dropTitle: "把站点目录拖到这里",
    dropHint: "松开就开始读",
    runtime: {
      idle: "IDLE",
      loading: "LOADING RUNTIME",
      scan: "SCANNING",
      optimize: "SHRINKING",
      verify: "VERIFYING",
      ready: "READY",
      error: "ERROR",
    },
    title: { idle: "// CHECKUP CONSOLE · v0.3.0", running: "// CHECKUP CONSOLE · RUNNING", done: "// CHECKUP CONSOLE · DONE" },
    running: (phase, done, total, path) =>
      phase === "scan" ? "扫描站点、算账单…"
      : phase === "verify" ? "校验产物…"
      : phase === "runtime" ? "加载压缩运行时…"
      : `压缩中… ${done}/${total}${path ? ` · ${path}` : ""}`,
    badge: { pass: "校验 · 全部通过", warn: "校验 · 1 项需要注意", fail: "校验 · 有失败项，先别发布" },
    verTitle: { pass: "校验 · 全部通过", warn: "校验 · 需要注意", fail: "校验 · 有失败项" },
    emptyDir: "还没选文件。把站点目录拖进来，或者点「选择文件夹」。",
    noIndex: "这个目录里没有 index.html —— 发布页会拒绝，站点打开就是 404。",
    tooBig: (mb, n, mbLimit, fileLimit) => `一次最多处理 ${mbLimit} MB / ${fileLimit} 个文件。这个目录有 ${mb} MB / ${n} 个文件。`,
    single: (n) => `${n} 个文件超过协议 8 MiB 上限，协议会静默跳过它们 —— 我们替你标出来了。`,
    noWasm: "这个浏览器跑不了压缩运行时。换 Chrome / Edge / Safari 的新版本，或者用 CLI 版。",
    crash: (msg) => `压缩过程中断了：${msg}。源目录没有被改动过，重新跑一次通常就好。`,
    allDropped: "所有文件都被判定为「不是站点资源」，产物是空的。这通常是选错了目录。",
    oom: "文件太大，浏览器内存不够了。试试分批，或者用 CLI 版跑整站。",
    changed: "（没有文件被改动）",
    copied: "已复制 ✓",
    demo: "试用示例站点 · super-lock",
    tape: {
      idle: "SITE AUDIT · RUNS LOCALLY",
      running: "SITE AUDIT · RUNNING",
      done: "SITE AUDIT · DONE",
      error: "SITE AUDIT · HALTED",
      modeIdle: "· NR",
      modeRun: "· REC",
    },
    mobile: {
      title: "账单",
      badge: { pass: "全部通过", warn: "1 项注意", fail: "有失败项" },
      run: "开始体检 + 压缩",
      choosing: "选择单个文件",
      assumptions: "计算条件",
      cancel: "取消",
      menu: "菜单",
      desktop: "桌面版",
      segments: ["运行时", "扫描", "压缩", "校验", "完成"],
    },
    demoLoading: "正在加载示例站点…",
    report: "收起完整报告",
    reportOpen: "展开完整报告",
  },
  en: {
    picked: (dir, n, bytes) => `Selected: ${dir} · ${n} files · ${fmtBytes(bytes)}`,
    dropTitle: "Drop your site folder here",
    dropHint: "Release to read",
    runtime: {
      idle: "IDLE",
      loading: "LOADING RUNTIME",
      scan: "SCANNING",
      optimize: "SHRINKING",
      verify: "VERIFYING",
      ready: "READY",
      error: "ERROR",
    },
    title: { idle: "// CHECKUP CONSOLE · v0.3.0", running: "// CHECKUP CONSOLE · RUNNING", done: "// CHECKUP CONSOLE · DONE" },
    running: (phase, done, total, path) =>
      phase === "scan" ? "Scanning the site and pricing every byte…"
      : phase === "verify" ? "Verifying the output…"
      : phase === "runtime" ? "Loading the shrink runtime…"
      : `Shrinking… ${done}/${total}${path ? ` · ${path}` : ""}`,
    badge: { pass: "Verification · all passed", warn: "Verification · one needs attention", fail: "Verification · failing, don't publish yet" },
    verTitle: { pass: "Verification · all passed", warn: "Verification · needs attention", fail: "Verification · failing" },
    emptyDir: "Nothing selected yet. Drop your site folder, or hit \"Choose a folder\".",
    noIndex: "No index.html in this folder — the publishing page will reject it, and the site would 404.",
    tooBig: (mb, n, mbLimit, fileLimit) => `Up to ${mbLimit} MB / ${fileLimit} files per run. This folder has ${mb} MB across ${n} files.`,
    single: (n) => `${n} files exceed the protocol's 8 MiB limit and would be silently skipped — we flagged them.`,
    noWasm: "This browser can't run the shrink runtime. Use a recent Chrome / Edge / Safari, or the CLI.",
    crash: (msg) => `Shrinking stopped: ${msg}. Your source is untouched; running again usually fixes it.`,
    allDropped: "Every file was judged \"not a site asset\", so the output is empty. This usually means the wrong folder was picked.",
    oom: "Too much data for this tab's memory. Try a subset, or use the CLI for the whole site.",
    changed: "(nothing changed)",
    copied: "Copied ✓",
    demo: "Try the sample site · super-lock",
    demoLoading: "Loading the sample site…",
    report: "Hide full report",
    reportOpen: "Show full report",
  },
}[LANG];

/* --------------------------------------------------------------- 工具函数 */

const fmtBytes = (n) =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(2)} MB`;
const nf = (n) => (n ?? 0).toLocaleString("en-US");
const usd = (n) => `$${(n ?? 0).toFixed(2)}`;
const b64Bytes = (b64) => Math.floor((b64.length * 3) / 4) - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);
const setText = (el, text) => { if (el) el.textContent = text; };
const setState = (s) => { root.dataset.state = s; };

const CHAINS = {
  bsc: { symbol: "BNB", price: 750, label: { zh: "BNB 价格", en: "BNB price" }, gas: 0.05 },
  xlayer: { symbol: "OKB", price: 50, label: { zh: "OKB 价格", en: "OKB price" }, gas: 0.05 },
  base: { symbol: "ETH", price: 3000, label: { zh: "ETH 价格", en: "ETH price" }, gas: 0.05 },
};
const GWEI_FLOOR = 0.05;
const MAX_FILES = 2000;
const MAX_TOTAL = 16 * 1024 * 1024;
const MAX_FILE = 8 * 1024 * 1024;

const tool = { network: "bsc", preset: "safe", files: [], dirName: "", json: null, artifacts: [], busy: false };

/* =========================================================== A. 页面行为 */

/* 粘性导航 + 浮动 CTA ------------------------------------------------ */

const nav = hook("brand")?.closest("header");
const floating = document.querySelector(".pen-reusable");
const hero = document.getElementById("hero");
if (nav) {
  const onScroll = () => {
    nav.classList.toggle("is-scrolled", window.scrollY > 8);
    if (floating && hero) floating.classList.toggle("is-shown", window.scrollY > hero.offsetHeight * 0.6);
  };
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });
}

/* FAQ 手风琴 --------------------------------------------------------- */

for (const item of document.querySelectorAll(".pen-faq-item")) {
  const q = item.querySelector('[data-hook~="faq-q"]');
  if (!q) continue;
  q.setAttribute("aria-expanded", String(item.classList.contains("is-open")));
  q.addEventListener("click", () => {
    const open = item.classList.toggle("is-open");
    q.setAttribute("aria-expanded", String(open));
  });
}

/* 三种用法 Tab ------------------------------------------------------- */

for (const [key, name] of [["web", "tab-web"], ["cli", "tab-cli"], ["mcp", "tab-mcp"]]) {
  hook(name)?.addEventListener("click", () => {
    root.dataset.tab = key;
    for (const n of ["tab-web", "tab-cli", "tab-mcp"]) hook(n)?.setAttribute("aria-selected", String(n === name));
    history.replaceState(null, "", `#use-${key}`);
  });
}

/* 复制 ----------------------------------------------------------------- */

async function copy(text, el) {
  try {
    await navigator.clipboard.writeText(text);
    const label = el.querySelector("span") ?? el;
    const before = label.textContent;
    label.textContent = T.copied;
    setTimeout(() => { label.textContent = before; }, 1500);
  } catch { /* 剪贴板被拒就安静放弃，不弹窗 */ }
}

hook("copy-json")?.addEventListener("click", (e) => {
  if (!tool.json) return;
  copy(JSON.stringify(tool.json, null, 2), e.currentTarget);
});

/* S10 里的「复制」按钮：设计稿把它画成纯文本，这里按内容认出来接上行为 */
for (const el of document.querySelectorAll("#use *")) {
  const text = el.textContent?.trim();
  if (el.children.length === 0 && (text === "复制" || text === "Copy") && !el.dataset.wired) {
    el.dataset.wired = "1";
    el.style.cursor = "pointer";
    el.addEventListener("click", () => {
      const code = el.closest('[data-hook~="panel-cli"]')?.querySelector("pre, code, .pen-code");
      const text2 = code ? code.textContent : "";
      if (text2) copy(text2, el.parentElement ?? el);
    });
  }
}

/* ------------------------------------------------- 磁带机（设计稿的隐喻）

   导航栏的 REC 灯、电平表、00:30 计数器，hero 里的 TAPE-001 磁带模块 ——
   设计稿把它们画成静态装饰，站点里把它们接上真实状态：
   跑体检时 REC 闪、电平表跳、计数器走时、CNT 记处理过的文件数。 */

const IS_MOBILE_PAGE = root.dataset.mobile === "1";
const tape = { timer: null, seconds: 0, started: 0 };

function pad2(n) { return String(n).padStart(2, "0"); }
function mmss(sec) { return `${pad2(Math.floor(sec / 60))}:${pad2(Math.floor(sec % 60))}`; }

function tapeStart() {
  tape.started = Date.now();
  tape.seconds = 0;
  clearInterval(tape.timer);
  tape.timer = setInterval(() => {
    tape.seconds = Math.floor((Date.now() - tape.started) / 1000);
    setText(hook("tape-counter"), mmss(tape.seconds));
    setText(hook("tape-count"), `CNT ${String(tape.seconds).padStart(4, "0")}`);
  }, 500);
}

function tapeStop(kind = "done") {
  clearInterval(tape.timer);
  tape.timer = null;
  const secs = tape.seconds;
  setText(hook("tape-status"), `${T.tape[kind]} · ${mmss(secs)}`);
  setText(hook("tape-mode"), kind === "running" ? T.tape.modeRun : T.tape.modeIdle);
  if (kind === "running") setText(hook("tape-mode"), T.tape.modeRun);
}

function tapeIdle() {
  clearInterval(tape.timer);
  tape.timer = null;
  setText(hook("tape-status"), `${T.tape.idle} · 00:30`);
  setText(hook("tape-mode"), T.tape.modeIdle);
  setText(hook("tape-counter"), "00:30");
  setText(hook("tape-count"), "CNT 0030");
}

/** CNT 记的是「处理过的文件数」，与走时无关。 */
function tapeCount(filesRead) {
  return `CNT ${String(filesRead).padStart(4, "0")}`;
}

hook("tape-play")?.addEventListener("click", () => run());
hook("tape-stop")?.addEventListener("click", () => {
  clearInterval(tape.timer);
  tape.timer = null;
  tool.busy = false;
  setState(tool.json ? "pass" : "idle");
  setRuntime(tool.json ? "ready" : "idle", tool.json ? 100 : 0);
  tapeIdle();
});

/* =========================================================== B. 在线体检 */

/* 输入框：设计稿把 gasPrice / 币价 画成静态文本，这里换成真的可编辑控件 */

function makeInput(span, value, onInput) {
  if (!span) return null;
  const input = document.createElement("input");
  input.type = "text";
  input.inputMode = "decimal";
  input.autocomplete = "off";
  input.className = `${span.className} pen-input`;
  /* hook 必须跟着走到 input 上，否则外部（和验收脚本）就找不到这个字段了 */
  if (span.dataset.hook) input.dataset.hook = span.dataset.hook;
  if (span.dataset.pen) input.dataset.pen = span.dataset.pen;
  input.value = value;
  input.setAttribute("aria-label", span.previousElementSibling?.textContent?.trim() ?? "value");
  input.addEventListener("input", () => onInput(input.value));
  span.replaceWith(input);
  return input;
}

const gasInput = makeInput(hook("gas-price"), "0.05", () => {});
const priceInput = makeInput(hook("bnb-price"), String(CHAINS.bsc.price), () => {});

/* 链选择 ------------------------------------------------------------- */

function selectChain(key) {
  tool.network = key;
  for (const [k, name] of Object.entries({ bsc: "chain-bsc", xlayer: "chain-xlayer", base: "chain-base" })) {
    const el = hook(name);
    if (!el) continue;
    el.classList.toggle("is-selected", k === key);
    el.style.cursor = "pointer";
    el.setAttribute("aria-pressed", String(k === key));
  }
  setText(hook("price-label"), CHAINS[key].label[LANG]);
  if (priceInput) priceInput.value = String(CHAINS[key].price);
  updateConditions();
}
for (const [key, name] of Object.entries({ bsc: "chain-bsc", xlayer: "chain-xlayer", base: "chain-base" })) {
  hook(name)?.addEventListener("click", () => selectChain(key));
}

/* 档位：安全档可用；激进档 / WebP 在设计稿里就是「即将支持」 ------------------ */

hook("preset-safe")?.addEventListener("click", () => {
  tool.preset = "safe";
  hook("preset-safe")?.classList.add("is-selected");
});
for (const name of ["preset-aggressive", "preset-webp"]) {
  const el = hook(name);
  if (el) el.setAttribute("title", LANG === "zh" ? "即将支持，当前版本还没接进网页版" : "Coming soon — not wired into the web build yet");
}
hook("preset-safe")?.classList.add("is-selected");

/* 账单上方的条件行 --------------------------------------------------- */

function updateConditions() {
  const gp = Number(gasInput?.value) || GWEI_FLOOR;
  const price = Number(priceInput?.value) || CHAINS[tool.network].price;
  const chain = { bsc: "BSC", xlayer: "X Layer", base: "Base" }[tool.network];
  setText(
    hook("bill-conditions"),
    `${chain} · gasPrice ${gp} gwei · ${CHAINS[tool.network].symbol} ${usd(price)} · ${LANG === "zh" ? "安全档" : "Safe preset"}`,
  );
}
gasInput?.addEventListener("input", updateConditions);
priceInput?.addEventListener("input", updateConditions);
selectChain("bsc");

/* 读文件 ------------------------------------------------------------- */

function relPath(file) {
  const full = file.webkitRelativePath || file.name;
  const parts = full.split("/");
  if (parts.length > 1) {
    tool.dirName ||= parts[0];
    return parts.slice(1).join("/");
  }
  return full;
}

async function ingest(fileList) {
  const list = [];
  for (const f of fileList) {
    if (!f.size && !f.name) continue;
    list.push({ path: relPath(f), bytes: new Uint8Array(await f.arrayBuffer()) });
  }
  if (!list.length) return;
  tool.files = list;
  tool.dirName ||= "(files)";
  const bytes = list.reduce((a, f) => a + f.bytes.length, 0);
  setText(hook("drop-title"), T.picked(tool.dirName, list.length, bytes));
  clearErrors();
  if (byteLimitProblem(list)) return;
  setState("idle");
}

function byteLimitProblem(list) {
  const bytes = list.reduce((a, f) => a + f.bytes.length, 0);
  if (list.length > MAX_FILES || bytes > MAX_TOTAL) {
    showError("E03", T.tooBig((bytes / 1024 / 1024).toFixed(1), list.length, 16, 2000));
    return true;
  }
  const big = list.filter((f) => f.bytes.length > MAX_FILE);
  if (big.length) showError("E04", T.single(big.length));
  if (!list.some((f) => f.path === "index.html")) showError("E02", T.noIndex);
  return false;
}

hook("choose-folder")?.addEventListener("click", () => {
  /* label + for 已经能触发，这里只处理「选了同一个目录」的情况 */
});
document.getElementById("pen-folder-input")?.addEventListener("change", (e) => ingest(e.target.files));
document.getElementById("pen-file-input")?.addEventListener("change", (e) => ingest(e.target.files));

/* 拖拽 --------------------------------------------------------------- */

const dropzone = hook("dropzone");
function entryFiles(entry, prefix = "") {
  return new Promise((resolve) => {
    if (entry.isFile) return entry.file((f) => resolve([{ file: f, path: prefix + entry.name }]));
    const reader = entry.createReader();
    const all = [];
    const readBatch = () =>
      reader.readEntries(async (entries) => {
        if (!entries.length) {
          resolve((await Promise.all(all.map((e) => entryFiles(e, `${prefix}${entry.name}/`)))).flat());
          return;
        }
        all.push(...entries);
        readBatch();
      });
    readBatch();
  });
}
if (dropzone) {
  dropzone.addEventListener("dragover", (e) => { e.preventDefault(); dropzone.classList.add("is-over"); setText(hook("drop-title"), T.dropHint); });
  dropzone.addEventListener("dragleave", () => dropzone.classList.remove("is-over"));
  dropzone.addEventListener("drop", async (e) => {
    e.preventDefault();
    dropzone.classList.remove("is-over");
    const entries = [...(e.dataTransfer?.items ?? [])].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
    const list = [];
    if (entries.length) {
      for (const { file, path } of (await Promise.all(entries.map((x) => entryFiles(x)))).flat()) {
        list.push({ path, bytes: new Uint8Array(await file.arrayBuffer()) });
      }
    } else {
      for (const f of e.dataTransfer.files) list.push({ path: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
    }
    if (!list.length) return;
    tool.dirName ||= list[0].path.split("/")[0] ?? "";
    tool.files = list;
    const bytes = list.reduce((a, f) => a + f.bytes.length, 0);
    setText(hook("drop-title"), T.picked(tool.dirName, list.length, bytes));
    clearErrors();
    byteLimitProblem(list);
  });
}

/* 示例站点：设计稿没有这个入口，所以只加一行不改变布局的小链接 ---------------- */

const demoBtn = document.createElement("button");
demoBtn.type = "button";
demoBtn.className = "pen-demo";
demoBtn.textContent = T.demo;
demoBtn.addEventListener("click", loadDemoSite);
hook("choose-folder")?.after(demoBtn);

async function loadDemoSite() {
  setText(hook("drop-title"), T.demoLoading);
  try {
    const meta = await (await fetch("./demo-site.json")).json();
    const files = [];
    for (const rel of meta.files) {
      const buf = await (await fetch(`./demo-site/${rel}`)).arrayBuffer();
      files.push({ path: rel, bytes: new Uint8Array(buf) });
    }
    tool.dirName = meta.dir;
    tool.files = files;
    const bytes = files.reduce((a, f) => a + f.bytes.length, 0);
    setText(hook("drop-title"), T.picked(tool.dirName, files.length, bytes));
    clearErrors();
    run();
  } catch (err) {
    showError("E06", T.crash(err.message));
  }
}

/* 进度条（注入到控制台标题栏下方） ------------------------------------- */

const consoleBar = document.querySelector('[data-hook~="console-title"]')?.closest("div[class]")?.parentElement;
const progress = document.createElement("div");
progress.className = "pen-progress";
progress.innerHTML = "<i></i>";
if (consoleBar) consoleBar.after(progress);
const progressBar = progress.firstElementChild;

const runtimeText = hook("runtime-text");
if (runtimeText) { runtimeText.setAttribute("role", "status"); runtimeText.setAttribute("aria-live", "polite"); }

function setRuntime(kind, pct) {
  setText(runtimeText, T.runtime[kind]);
  progressBar.style.width = `${pct}%`;
}

/* 错误态 ------------------------------------------------------------- */

function errorSlot() {
  let slot = hook("error-host");
  if (!slot) {
    slot = document.createElement("div");
    slot.className = "pen-errorhost";
    slot.setAttribute("data-hook", "error-host");
    slot.setAttribute("role", "alert");
    document.querySelector('[data-hook~="dropzone"]')?.closest("section")?.append(slot);
  }
  return slot;
}

function showError(code, message) {
  const card = document.querySelector(`[data-err="${code}"]`);
  if (!card) return;
  const node = card.cloneNode(true);
  node.classList.remove("pen-hidden");
  node.removeAttribute("data-err");
  const texts = [...node.querySelectorAll("p, span")].filter((el) => el.children.length === 0);
  if (texts[1]) texts[1].textContent = message;
  node.querySelector('[data-hook~="error-next"]')?.remove();
  errorSlot().append(node);
  setState("error");
}

function clearErrors() {
  const slot = hook("error-host");
  if (slot) slot.replaceChildren();
  if (root.dataset.state === "error") setState("idle");
}

/* --------------------------------------------------- 手机版（390 设计稿）

   设计稿给手机版画了一条完整流程：英雄区 → 体检 → **运行中** → **账单**。
   后面两块是状态页（默认隐藏），这里按真实运行状态放出来。 */

const M = T.mobile;

function showSection(name) {
  hook(name)?.classList.remove("pen-hidden");
}
function hideSection(name) {
  hook(name)?.classList.add("pen-hidden");
}

function setSegments(phase) {
  const seg = hook("segments");
  if (!seg) return;
  const order = ["runtime", "scan", "optimize", "verify", "done"];
  const at = { runtime: 0, scan: 1, optimize: 2, verify: 3, done: 4 }[phase] ?? 0;
  [...seg.children].forEach((el, i) => {
    el.classList.toggle("is-done", i < at);
    el.classList.toggle("is-active", i === at);
  });
}

if (IS_MOBILE_PAGE) {
  document.getElementById("pen-file-input")?.addEventListener("change", (e) => {
    ingest(e.target.files);
    setText(hook("assumptions"), `${M.assumptions} · ${(Number(gasInput?.value) || GWEI_FLOOR)} gwei · ${CHAINS[tool.network].symbol} $${Number(priceInput?.value) || CHAINS[tool.network].price}`);
    setSegments("runtime");
    hideSection("m-running");
    hideSection("m-bill");
  });
}

hook("cancel")?.addEventListener("click", () => {
  clearInterval(tape.timer);
  tape.timer = null;
  tool.busy = false;
  setState("idle");
  hideSection("m-running");
  setSegments("runtime");
  setText(hook("current-step"), tool.files.length ? `${tool.files.length} 个文件已就绪` : "等待选择文件");
});

/* 菜单：设计稿只给了汉堡按钮，抽屉用设计稿自己的色板与等宽字体搭 */
hook("menu-button")?.addEventListener("click", (e) => {
  e.stopPropagation();
  const open = document.querySelector(".pen-drawer");
  if (open) return open.remove();
  const drawer = document.createElement("nav");
  drawer.className = "pen-drawer";
  const links = [
    ["在线体检", "#checkup"], ["为什么贵", "#hero"], ["怎么用", "#checkup"],
    ["桌面版", "./index.html"], ["查看文档", "../docs/using-the-mcp.md"],
  ];
  drawer.innerHTML = links
    .map(([label, href]) => `<a href="${href}">${label}</a>`)
    .join("");
  document.body.append(drawer);
  setTimeout(() => document.addEventListener("click", () => drawer.remove(), { once: true }), 0);
});

/* 计算条件：设计稿只画了一行摘要 + chevron，这里让它展开成两个输入框 */
hook("assumptions")?.addEventListener("click", () => {
  const box = hook("assumptions")?.closest('[data-hook~="assumptions"], div');
  let panel = document.querySelector(".pen-assume-panel");
  if (panel) return panel.remove();
  panel = document.createElement("div");
  panel.className = "pen-assume-panel";
  panel.innerHTML = `
    <label>gasPrice (gwei)<input class="pen-input" id="m-gas" inputmode="decimal" value="${gasInput?.value ?? "0.05"}"></label>
    <label>${CHAINS[tool.network].label.zh}<input class="pen-input" id="m-price" inputmode="decimal" value="${priceInput?.value ?? CHAINS[tool.network].price}"></label>`;
  box?.after(panel);
  panel.querySelector("#m-gas")?.addEventListener("input", (e) => {
    if (gasInput) gasInput.value = e.currentTarget.value;
    updateConditions();
  });
  panel.querySelector("#m-price")?.addEventListener("input", (e) => {
    if (priceInput) priceInput.value = e.currentTarget.value;
    updateConditions();
  });
});

/* Worker ------------------------------------------------------------- */

let worker = null;
let runtimeReady = false;

function ensureWorker() {
  if (worker) return worker;
  if (typeof WebAssembly !== "object") {
    showError("E05", T.noWasm);
    return null;
  }
  worker = new Worker(new URL("./tool.worker.js", import.meta.url), { type: "module" });
  worker.onmessage = onWorkerMessage;
  worker.onerror = (e) => { showError("E06", T.crash(e.message ?? "worker error")); setRuntime("error", 0); };
  return worker;
}

function onWorkerMessage(ev) {
  const msg = ev.data ?? {};
  if (msg.type === "progress") {
    if (IS_MOBILE_PAGE) {
      setSegments(msg.phase);
      const step = T.running(msg.phase, msg.filesRead ?? 0, tool.files.length, msg.path);
      setText(hook("current-step"), step);
    }
    if (msg.phase === "runtime") {
      setRuntime("loading", 8);
    } else if (msg.phase === "scan") {
      runtimeReady = true;
      hook("first-load-note")?.classList.add("pen-hidden");
      setRuntime("scan", 25);
    } else if (msg.phase === "optimize") {
      const pct = 25 + Math.round(((msg.filesRead ?? 0) / Math.max(1, tool.files.length)) * 60);
      setRuntime("optimize", pct);
      setText(hook("tape-count"), tapeCount(msg.filesRead ?? 0));
      setText(hook("console-title"), T.title.running);
    } else if (msg.phase === "verify") {
      setRuntime("verify", 92);
    }
    const line = T.running(msg.phase, msg.filesRead ?? 0, tool.files.length, msg.path);
    setText(hook("drop-title"), line);
    return;
  }
  if (msg.type === "error") {
    if (IS_MOBILE_PAGE) {
      hideSection("m-running");
      setText(hook("current-step"), T.crash(msg.message));
    }
    showError(resolveErrorCode(msg.message), T.crash(msg.message));
    setRuntime("error", 0);
    tapeStop("error");
    tool.busy = false;
    return;
  }
  if (msg.type === "done") {
    tool.busy = false;
    tool.json = msg.json;
    tool.artifacts = msg.json.artifacts ?? [];
    render(msg);
    tapeStop("done");
    setText(hook("console-title"), T.title.done);
    setText(hook("drop-title"), T.picked(tool.dirName, tool.files.length, tool.files.reduce((a, f) => a + f.bytes.length, 0)));
  }
}

const resolveErrorCode = (message = "") =>
  /memory|allocat|Array buffer/i.test(message) ? "E08" : "E06";

/* 跑 ----------------------------------------------------------------- */

function currentPricing() {
  return {
    network: tool.network,
    gasPriceGwei: Number(gasInput?.value) || GWEI_FLOOR,
    priceUsd: Number(priceInput?.value) || CHAINS[tool.network].price,
  };
}

function run() {
  if (tool.busy) return;
  clearErrors();
  if (!tool.files.length) {
    showError("E01", T.emptyDir);
    return;
  }
  if (byteLimitProblem(tool.files)) return;
  const w = ensureWorker();
  if (!w) return;
  tool.busy = true;
  setState("running");
  if (IS_MOBILE_PAGE) {
    showSection("m-running");
    hideSection("m-bill");
    setSegments("runtime");
  }
  tapeStart();
  setText(hook("tape-status"), `${T.tape.running} · 00:00`);
  setText(hook("tape-mode"), T.tape.modeRun);
  setRuntime(runtimeReady ? "scan" : "loading", 4);
  setText(hook("console-title"), T.title.running);
  hook("full-report")?.classList.remove("is-on");

  const payload = tool.files.map((f) => ({ path: f.path, bytes: f.bytes }));
  w.postMessage(
    {
      type: "run",
      files: payload,
      pricing: currentPricing(),
      options: { optimizePng: true, optimizeJpeg: false, optimizeWebp: false },
    },
    payload.map((f) => f.bytes.buffer),
  );
}
hook("run")?.addEventListener("click", run);

/* 渲染结果 ----------------------------------------------------------- */

function render(msg) {
  const { json } = msg;
  const b = json.before, a = json.after, s = json.saved;
  const pct = b.totals.bytes ? (s.bytes / b.totals.bytes) * 100 : 0;
  const chain = { bsc: "BSC", xlayer: "X Layer", base: "Base" }[json.network] ?? json.network;

  setText(hook("bill-conditions"), IS_MOBILE_PAGE
    ? `${chain} · ${json.gasPriceGwei} gwei · ${json.symbol} ${usd(json.priceUsd)}`
    : `${chain} · gasPrice ${json.gasPriceGwei} gwei · ${json.symbol} ${usd(json.priceUsd)} · ${LANG === "zh" ? "安全档" : "Safe preset"}`);

  /* 三个大数字 */
  setText(hook("saved-usd"), usd(s.usd));
  setText(hook("saved-usd-sub"), LANG === "zh" ? `这一版少花 ${pct.toFixed(1)}%` : `${pct.toFixed(1)}% cheaper than the raw build`);
  setText(hook("saved-bytes"), fmtBytes(s.bytes));
  setText(hook("saved-bytes-sub"), `${nf(b.totals.bytes)} B → ${nf(a.totals.bytes)} B`);
  setText(hook("saved-txs"), nf(s.chunks));
  setText(hook("saved-txs-sub"), LANG === "zh"
    ? `少发 ${nf(s.chunks)} 笔交易 · ${nf(b.totals.chunks)} 块 → ${nf(a.totals.chunks)} 块`
    : `${nf(s.chunks)} fewer transactions · ${nf(b.totals.chunks)} chunks → ${nf(a.totals.chunks)} chunks`);

  /* 账单表 */
  /* snapshot 形状：{ totals, gas: { gas, chunks, … }, cost: { native, usd } } */
  /* 桌面账单表 7 列；手机设计稿只有「字节数 / 块 / USD」3 列 */
  const cells = (t, snap) => IS_MOBILE_PAGE
    ? [nf(t.bytes), nf(t.chunks), usd(snap.cost.usd)]
    : [t.billableFiles, nf(t.bytes), nf(t.chunks), nf(snap.gas.gas), snap.cost.native.toFixed(6), usd(snap.cost.usd)];
  const fillRow = (name, values) => {
    const row = hook(name);
    if (!row) return;
    [...row.children].slice(1).forEach((cell, i) => setText(cell, values[i] ?? "—"));
  };
  fillRow("row-before", cells(b.totals, b));
  fillRow("row-after", cells(a.totals, a));
  fillRow("row-saved", IS_MOBILE_PAGE
    ? [`${fmtBytes(s.bytes)}（${pct.toFixed(1)}%）`, nf(s.chunks), usd(s.usd)]
    : ["—", `${fmtBytes(s.bytes)}（${pct.toFixed(1)}%）`, nf(s.chunks), nf(s.gas), s.native.toFixed(6), usd(s.usd)]);

  setText(hook("table-note"), LANG === "zh"
    ? `产物 ${tool.artifacts.length} 个文件 · 没写进产物的 ${json.files?.dropped?.length ?? 0} 个`
    : `${tool.artifacts.length} files in the output · ${json.files?.dropped?.length ?? 0} left out`);

  /* 校验 */
  const checks = json.verification?.checks ?? [];
  const failed = json.verification?.failed ?? 0;
  const warned = json.verification?.warned ?? 0;
  const status = failed ? "fail" : warned ? "warn" : "pass";
  setState(status);
  setText(hook("bill-badge-text") ?? hook("bill-badge"), (IS_MOBILE_PAGE ? M.badge : T.badge)[status]);
  const badge = hook("badge-icon")?.closest("div[class]");
  if (badge) badge.dataset.status = status;
  setText(hook("ver-title"), T.verTitle[status]);
  setText(hook("ver-sub"), LANG === "zh" ? `${checks.length} 项自动检查，产物与原文对拍` : `${checks.length} automated checks, output diffed against the source`);
  setText(hook("ver-count"), failed ? `${checks.length - failed} / ${checks.length} PASS · ${failed} FAIL`
    : warned ? `${checks.length - warned} / ${checks.length} PASS · ${warned} WARN`
    : `${checks.length} / ${checks.length} PASS`);
  renderChecks(checks);
  setRuntime("ready", 100);

  renderDetails(json);
  updateReportButton(!!json.verification);
  if (IS_MOBILE_PAGE) {
    hideSection("m-running");
    showSection("m-bill");
    setSegments("done");
  }
}

function renderChecks(checks) {
  const cols = hook("ver-cols");
  if (!cols) return;
  const [colA, colB] = cols.children;
  const templates = {
    first: colA.children[0]?.cloneNode(true),
    rest: colA.children[1]?.cloneNode(true) ?? colA.children[0]?.cloneNode(true),
  };
  const per = Math.ceil(checks.length / 2);
  const groups = [checks.slice(0, per), checks.slice(per)];
  [colA, colB].forEach((col, ci) => {
    col.replaceChildren();
    groups[ci].forEach((check, i) => {
      const row = (i === 0 ? templates.first : templates.rest).cloneNode(true);
      row.dataset.status = check.status === "fail" ? "fail" : check.status === "warn" ? "warn" : "pass";
      const name = row.querySelector('[data-hook~="check-name"]');
      const detail = row.querySelector('[data-hook~="check-detail"]');
      setText(name, check.name);
      setText(detail, check.detail);
      col.append(row);
    });
  });
}

function renderDetails(json) {
  const results = (json.files?.results ?? []).filter((r) => r.from !== r.to).sort((x, y) => y.from - x.from);
  const body = hook("detail-changed-body");
  if (body) {
    const template = body.children[0]?.cloneNode(true);
    body.replaceChildren();
    if (!results.length) {
      const empty = document.createElement("p");
      empty.className = template?.firstElementChild?.className ?? "";
      empty.textContent = T.changed;
      body.append(empty);
    }
    for (const r of results.slice(0, 40)) {
      const row = template.cloneNode(true);
      const cells = [...row.children];
      setText(cells[0], r.path);
      const pct = r.from ? ((r.from - r.to) / r.from) * 100 : 0;
      setText(cells[1], `${nf(r.from)} → ${nf(r.to)}（−${pct.toFixed(0)}%）`);
      setText(cells[2], r.note || r.action || "");
      body.append(row);
      if (body.children.length > 200) break;
    }
  }
  const saved = results.reduce((a, r) => a + Math.max(0, r.from - r.to), 0);
  setText(hook("detail-changed-count"), LANG === "zh"
    ? `${results.length} 个文件 · 省 ${fmtBytes(saved)}`
    : `${results.length} files · ${fmtBytes(saved)} saved`);
  const dropped = json.files?.dropped ?? [];
  setText(hook("detail-dropped-count"), LANG === "zh"
    ? `${dropped.length} 个 · ${fmtBytes(dropped.reduce((a, d) => a + d.bytes, 0))}`
    : `${dropped.length} · ${fmtBytes(dropped.reduce((a, d) => a + d.bytes, 0))}`);
  const conv = json.files?.protectedByConvention ?? [];
  setText(hook("detail-convention-count"), `${conv.length} · ${conv.join(", ")}`);
  const renames = json.files?.renames ?? [];
  setText(hook("detail-renames-count"), LANG === "zh" ? `${renames.length} 个 · 引用已同步重写` : `${renames.length} · references rewritten`);
  const opps = json.opportunities ?? [];
  const oppBytes = opps.reduce((a, o) => a + (o.bytes ?? 0), 0);
  setText(hook("detail-opportunities-count"), LANG === "zh"
    ? `${opps.length} 项 · 约 ${fmtBytes(oppBytes)} · 可选`
    : `${opps.length} left · about ${fmtBytes(oppBytes)} · optional`);
}

/* 展开完整报告 ------------------------------------------------------- */

const details = hook("details");
function updateReportButton() {
  const btn = hook("full-report");
  if (!btn) return;
  setText(btn, details?.classList.contains("pen-hidden") ? T.reportOpen : T.report);
}
hook("full-report")?.addEventListener("click", () => {
  if (!details) return;
  const hidden = details.classList.toggle("pen-hidden");
  updateReportButton();
  if (!hidden) details.scrollIntoView({ behavior: "smooth", block: "start" });
});
updateReportButton();

/* 下载 .tape.zip ------------------------------------------------------ */

hook("download")?.addEventListener("click", () => {
  if (!tool.artifacts.length) return;
  const entries = {};
  for (const a of tool.artifacts) {
    const bin = atob(a.base64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    entries[a.path] = u8;
  }
  const zipped = zipSync(entries, { level: 6 });
  const name = `${tool.dirName || "site"}.tape.zip`;
  const url = URL.createObjectURL(new Blob([zipped], { type: "application/zip" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
});

/* 收尾：初始状态 ------------------------------------------------------ */

setState("idle");
setRuntime("idle", 0);
selectChain("bsc");

/* 桌面页在小屏上跳到手机设计稿（/m/）；用户手动点了「桌面版」就不再跳 */
if (!IS_MOBILE_PAGE && window.matchMedia("(max-width: 720px)").matches && sessionStorage.getItem("penDesktop") !== "1") {
  location.replace(new URL("./m/index.html", location.href).href);
}
document.querySelectorAll('a[href$="m/index.html"]').forEach((a) =>
  a.addEventListener("click", () => sessionStorage.setItem("penDesktop", "1")),
);
