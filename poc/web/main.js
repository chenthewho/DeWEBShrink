/* ==========================================================================
   PoC 页面逻辑：读目录 → 丢给 Worker → 渲染账单 → 打包下载
   --------------------------------------------------------------------------
   这里刻意不碰任何算法：所有数字都来自 Worker 回来的 json（= src/ 那套算法）。
   ========================================================================== */

import { zipSync } from "fflate";

const $ = (id) => document.getElementById(id);
const state = { files: [], dirName: "", result: null, artifacts: null };

/* ------------------------------ 读目录 ------------------------------ */

/** 去掉用户选中目录的第一段（webkitRelativePath 是「目录名/文件」），与 CLI 的 dir 语义对齐。 */
function relPath(file) {
  const full = file.webkitRelativePath || file.name;
  const parts = full.split("/");
  if (parts.length > 1) {
    state.dirName ||= parts[0];
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
  state.files = list;
  const bytes = list.reduce((a, f) => a + f.bytes.length, 0);
  $("picked").textContent = `已选择：${state.dirName || "（散文件）"} · ${list.length} 个文件 · ${(bytes / 1024).toFixed(0)} KB`;
  $("run").disabled = list.length === 0;
}

$("dir").addEventListener("change", (e) => ingest(e.target.files));

/** 一键试用：从本地服务拉 fixtures/07-real-site（同一份站点，CLI 也对拍过）。 */
$("sample").addEventListener("click", async () => {
  $("sample").disabled = true;
  $("picked").textContent = "正在加载示例站点…";
  try {
    const list = await (await fetch("/demo-site.json")).json();
    const out = [];
    for (const rel of list.files) {
      const url = `/demo-site/${rel.split("/").map(encodeURIComponent).join("/")}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${rel} → HTTP ${res.status}`);
      out.push({ path: rel, bytes: new Uint8Array(await res.arrayBuffer()) });
    }
    state.files = out;
    state.dirName = "07-real-site";
    const bytes = out.reduce((a, f) => a + f.bytes.length, 0);
    $("picked").textContent = `已加载示例：${state.dirName} · ${out.length} 个文件 · ${(bytes / 1024).toFixed(0)} KB —— 现在点 ② 开始`;
    $("run").disabled = false;
  } catch (err) {
    $("picked").innerHTML = `<span class="bad">示例站点加载失败：${err.message}（那就把 fixtures/07-real-site 拖进来）</span>`;
  } finally {
    $("sample").disabled = false;
  }
});

/* 拖拽目录：webkitGetAsEntry 递归（Chrome/Edge/Safari 都支持） */
function entryFiles(entry, prefix = "") {
  return new Promise((resolve) => {
    if (entry.isFile) {
      entry.file((f) => resolve([{ file: f, path: prefix + entry.name }]));
      return;
    }
    const reader = entry.createReader();
    const all = [];
    const readBatch = () => {
      reader.readEntries(async (entries) => {
        if (!entries.length) {
          const nested = await Promise.all(all.map((e) => entryFiles(e, `${prefix}${entry.name}/`)));
          resolve(nested.flat());
          return;
        }
        all.push(...entries);
        readBatch();
      });
    };
    readBatch();
  });
}

const drop = $("drop");
drop.addEventListener("dragover", (e) => {
  e.preventDefault();
  drop.classList.add("over");
});
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", async (e) => {
  e.preventDefault();
  drop.classList.remove("over");
  const items = [...(e.dataTransfer?.items || [])];
  const roots = [];
  for (const it of items) {
    const entry = it.webkitGetAsEntry?.();
    if (entry) roots.push(entry);
  }
  if (!roots.length) {
    await ingest(e.dataTransfer.files);
    return;
  }
  const flat = (await Promise.all(roots.map((r) => entryFiles(r)))).flat();
  const list = [];
  for (const { file, path } of flat) list.push({ path, bytes: new Uint8Array(await file.arrayBuffer()) });
  state.files = list;
  state.dirName ||= list[0]?.path.split("/")[0] || "";
  const bytes = list.reduce((a, f) => a + f.bytes.length, 0);
  $("picked").textContent = `已选择：${state.dirName || "（散文件）"} · ${list.length} 个文件 · ${(bytes / 1024).toFixed(0)} KB`;
  $("run").disabled = list.length === 0;
});

/* ------------------------------ 跑流水线 ------------------------------ */

const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });

worker.onmessage = (ev) => {
  const msg = ev.data;
  if (msg.type === "progress") {
    const total = state.files.length;
    const done = msg.filesRead || 0;
    const pct = msg.phase === "scan" ? 15 : msg.phase === "runtime" ? 5 : 20 + Math.round((done / Math.max(1, total)) * 70);
    $("bar").style.width = `${pct}%`;
    $("progressText").textContent =
      msg.phase === "scan" ? "扫描站点、算账单…" :
      msg.phase === "runtime" ? msg.detail :
      msg.phase === "optimize" ? `压缩中… ${done}/${total} ${msg.path ?? ""}` :
      "校验产物…";
    return;
  }
  if (msg.type === "error") {
    $("progressText").innerHTML = `<span class="bad">出错了：${msg.message}</span>`;
    console.error(msg.stack);
    return;
  }
  if (msg.type === "done") {
    state.result = msg.json;
    state.artifacts = msg.json.artifacts || [];
    state.report = msg.report;
    $("bar").style.width = "100%";
    $("progressText").textContent = `完成 · 用时 ${msg.elapsedMs}ms`;
    render(msg);
  }
};

$("run").addEventListener("click", () => {
  if (!state.files.length) return;
  state.result = null;
  state.artifacts = null;
  for (const id of ["resultCard", "checksCard", "detailsCard"]) $(id).classList.remove("hidden");
  $("progressCard").classList.remove("hidden");
  $("bar").style.width = "3%";
  $("summary").innerHTML = "";
  $("checks").innerHTML = "";
  $("download").disabled = true;

  /* 注意：**不能**把这些 buffer 放进 transferList —— 转移会「neutering」原缓冲，
     第二次点「开始」就会变成空文件（实测踩过）。多拷一份几 MB 的代价换可重复运行。 */
  const payload = state.files.map((f) => ({ path: f.path, bytes: f.bytes }));
  worker.postMessage({
    type: "run",
    files: payload,
    pricing: { network: "bsc", gasPriceGwei: Number($("gp").value) || 0.05, priceUsd: Number($("usd").value) || 750 },
    options: { optimizePng: $("doImages").checked, optimizeJpeg: false, optimizeWebp: false },
  });
});

/* ------------------------------ 渲染 ------------------------------ */

const bytes = (n) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(2)} MB`);
const nf = (n) => (n ?? 0).toLocaleString("en-US");
const money = (n, sym = "BNB") => `${(n ?? 0).toFixed(6)} ${sym}`;

function render({ report, json }) {
  const b = json.before, a = json.after, s = json.saved;
  const pct = b.totals.bytes ? ((s.bytes / b.totals.bytes) * 100).toFixed(1) : "0";
  $("summary").innerHTML = `
    <table>
      <thead><tr><th></th><th>文件</th><th>字节</th><th>块（=交易）</th><th>gas</th><th>${json.symbol}</th><th>USD</th></tr></thead>
      <tbody>
        <tr><td>优化前</td><td>${b.totals.billableFiles}</td><td>${bytes(b.totals.bytes)}</td><td>${nf(b.totals.chunks)}</td><td>${nf(b.gas.gas)}</td><td>${money(b.cost.native, json.symbol)}</td><td>$${(b.cost.usd ?? 0).toFixed(2)}</td></tr>
        <tr><td>优化后</td><td>${a.totals.billableFiles}</td><td>${bytes(a.totals.bytes)}</td><td>${nf(a.totals.chunks)}</td><td>${nf(a.gas.gas)}</td><td>${money(a.cost.native, json.symbol)}</td><td>$${(a.cost.usd ?? 0).toFixed(2)}</td></tr>
        <tr class="save"><td>省下</td><td>−${b.totals.billableFiles - a.totals.billableFiles}</td><td>${bytes(s.bytes)}（${pct}%）</td><td>${nf(s.chunks)}</td><td>${nf(s.gas)}</td><td>${money(s.native, json.symbol)}</td><td>$${(s.usd ?? 0).toFixed(2)}</td></tr>
      </tbody>
    </table>
    <p class="hint">gasPrice ${json.gasPriceGwei} gwei · 币价 $${json.priceUsd} · 产物 ${json.artifacts?.length ?? 0} 个${
      json.files?.dropped?.length ? ` · 删掉 ${json.files.dropped.map((d) => d.path).join("、")}` : ""
    }</p>`;

  const icon = (st) => (st === "pass" ? "✓" : st === "warn" ? "!" : "✗");
  $("checks").innerHTML = `<ul class="checks">${(json.verification?.checks || [])
    .map((c) => `<li class="${c.status}"><b>${icon(c.status)} ${c.name}</b> <span>${c.detail}</span></li>`)
    .join("")}</ul>`;

  $("report").textContent = report;
  $("json").textContent = JSON.stringify(json, null, 2);
  $("download").disabled = !(json.artifacts || []).length;
}

/* ------------------------------ 下载 / 复制 ------------------------------ */

$("download").addEventListener("click", () => {
  const entries = {};
  for (const a of state.artifacts || []) {
    const bin = atob(a.base64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    entries[a.path] = u8;
  }
  const zipped = zipSync(entries, { level: 6 });
  const name = `${state.dirName || "site"}.tape.zip`;
  const url = URL.createObjectURL(new Blob([zipped], { type: "application/zip" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
});

$("copy").addEventListener("click", async () => {
  await navigator.clipboard.writeText(JSON.stringify(state.result, null, 2));
  $("copy").textContent = "已复制 ✓";
  setTimeout(() => ($("copy").textContent = "复制 JSON"), 1500);
});
