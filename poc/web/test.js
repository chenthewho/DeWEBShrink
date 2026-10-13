/* ==========================================================================
   无头浏览器验收页（只有 POC_TEST=1 的本地服务器才会用到）
   --------------------------------------------------------------------------
   跑两遍，然后把结果 POST 回本地服务器，由 poc/test-headless.mjs 与 Node 侧
   原生流水线的结果对拍：

     A. images off —— 必须与 Node 原生版**逐字段、逐字节**一致
        （证明浏览器里跑的就是同一套算法：esbuild-wasm 产物 = esbuild 二进制产物）
     B. images on（oxipng 无损）—— 证明图片那条路在浏览器里真能跑通
        （校验里「图片尺寸」必须 pass）
   ========================================================================== */

const NO_IMAGES = { optimizePng: false, optimizeJpeg: false, optimizeWebp: false, convertImages: false };
const PNG_ONLY = { optimizePng: true, optimizeJpeg: false, optimizeWebp: false, convertImages: false };
const PRICING = { network: "bsc", gasPriceGwei: 0.05, priceUsd: 750 };

const $ = (id) => document.getElementById(id);
const log = (msg) => {
  $("log").textContent += `${msg}\n`;
};

/** 埋点：把「走到哪一步」报给本地服务器，失败时能一眼看出卡在哪。 */
const stage = (name, extra = {}) =>
  fetch("/__stage", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, ...extra }) }).catch(() => {});

window.addEventListener("error", (e) => stage("window-error", { message: e.message }));
window.addEventListener("unhandledrejection", (e) => stage("unhandled-rejection", { message: String(e.reason?.message || e.reason) }));

const b64ToU8 = (b64) => {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
};

const sha256hex = async (u8) => {
  const d = await crypto.subtle.digest("SHA-256", u8);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

const worker = new Worker(new URL("./dist/worker.js", import.meta.url), { type: "module" });
worker.addEventListener("error", (e) => stage("worker-error", { message: e.message || "worker 加载失败" }));

function runInWorker(files, options) {
  return new Promise((resolve, reject) => {
    const onMsg = (ev) => {
      const m = ev.data;
      if (m.type === "progress") return;
      worker.removeEventListener("message", onMsg);
      if (m.type === "error") reject(new Error(m.message));
      else resolve(m);
    };
    worker.addEventListener("message", onMsg);
    const payload = files.map((f) => ({ path: f.path, bytes: f.bytes.slice() }));
    worker.postMessage({ type: "run", files: payload, pricing: PRICING, options }, payload.map((f) => f.bytes.buffer));
  });
}

async function digestArtifacts(artifacts) {
  const out = [];
  for (const a of artifacts || []) {
    const u8 = b64ToU8(a.base64);
    out.push([a.path, a.bytes, await sha256hex(u8)]);
  }
  return out;
}

function summarize(json) {
  return {
    before: json.before.totals,
    gasBefore: json.before.gas.gas,
    costBefore: json.before.cost,
    after: json.after.totals,
    gasAfter: json.after.gas.gas,
    costAfter: json.after.cost,
    saved: json.saved,
    dropped: (json.files?.dropped || []).map((d) => d.path),
    renames: json.files?.renames || [],
    checks: (json.verification?.checks || []).map((c) => [c.name, c.status, c.detail]),
    artifacts: json.artifacts?.map((a) => [a.path, a.bytes]) || [],
    notes: (json.files?.results || []).filter((r) => r.note).map((r) => [r.path, r.note]),
  };
}

(async () => {
  try {
    await stage("boot");
    log("拉取 fixtures…");
    const list = await (await fetch("/demo-site.json")).json();
    await stage("fixtures-listed", { count: list.files.length });
    const files = [];
    for (const rel of list.files) {
      const url = `/demo-site/${rel.split("/").map(encodeURIComponent).join("/")}`;
      const res = await fetch(url);
      /* 必须查状态码：踩过的坑 —— 路由 404 返回的 "not found"（9 字节）被当成文件内容，
         于是「21 个文件共 189 字节」，账单对不上还很难看出原因。 */
      if (!res.ok) throw new Error(`${rel} → HTTP ${res.status}`);
      files.push({ path: rel, bytes: new Uint8Array(await res.arrayBuffer()) });
    }
    log(`fixtures: ${files.length} 个文件`);
    await stage("fixtures-loaded", { count: files.length });

    await stage("run-a-start");
    const a = await runInWorker(files, NO_IMAGES);
    const summaryA = summarize(a.json);
    summaryA.artifactHashes = await digestArtifacts(a.json.artifacts);
    summaryA.elapsedMs = a.elapsedMs;
    log(`A（无图片）完成：${a.json.after.totals.bytes} B / ${a.json.after.gas.gas} gas / ${a.elapsedMs}ms`);
    await stage("run-a-done", { bytes: a.json.after.totals.bytes });

    await stage("run-b-start");
    const b = await runInWorker(files, PNG_ONLY);
    const pngArtifacts = (b.json.artifacts || []).filter((x) => x.path.endsWith(".png"));
    const dimCheck = (b.json.verification?.checks || []).find((c) => c.name === "图片尺寸");
    const summaryB = {
      ok: b.json.verification?.ok,
      warned: b.json.verification?.warned,
      afterBytes: b.json.after.totals.bytes,
      savedBytes: b.json.saved.bytes,
      pngCount: pngArtifacts.length,
      pngBefore: 0,
      pngAfter: pngArtifacts.reduce((s, x) => s + x.bytes, 0),
      dimCheck: dimCheck ? [dimCheck.status, dimCheck.detail] : null,
      elapsedMs: b.elapsedMs,
    };
    log(`B（PNG 无损）完成：产物 ${pngArtifacts.length} 张 PNG 共 ${summaryB.pngAfter} B · 校验 ${summaryB.ok ? "通过" : "失败"}`);

    await fetch("/__result", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ok: true, A: summaryA, B: summaryB }),
    });
    await stage("posted");
    log("已回传结果");
  } catch (err) {
    await stage("failed", { message: err.message });
    log(`失败：${err.message}`);
    await fetch("/__result", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ok: false, error: err.message, stack: err.stack }),
    });
  }
})();
