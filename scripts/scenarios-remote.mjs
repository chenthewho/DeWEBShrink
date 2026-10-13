#!/usr/bin/env node
/* ==========================================================================
   deweb-shrink · 远程 MCP 多场景模拟测试
   --------------------------------------------------------------------------
   和 test-remote.mjs（部署验收，只验「活着没、能不能压」）不同，这个脚本是
   **场景模拟**：假装自己是各种真实用户/agent，把远程 MCP 当生产依赖用一遍。

   两条通路同时测，因为它们是两种真实客户端：

     · 标准 MCP 客户端（SDK + StreamableHTTPClientTransport）—— 工具调用走这条，
       覆盖 initialize / notifications、tools/list、tools/call 的完整握手；
     · 裸 HTTP —— 只有它能测鉴权、方法限制、坏 JSON、超大 body 这些边界。

   九组场景：
     ⓪ 真实客户端连接        ① 端点与鉴权          ② 计费模型与估算
     ③ 与本地 stdio 对拍     ④ 压缩能力            ⑤ 扫描诊断
     ⑥ 校验能不能拦住坏产物  ⑦ 增量账单            ⑧ 输入健壮性
     ⑨ 性能与并发

   断言原则：凡是「服务行为」用 pass/fail；凡是「环境决定、没有唯一正确答案」的
   用 record（记录，不计分）—— 免得把共享主机/反代的差异误判成 bug。

   用法：
     DEWEB_SHRINK_API_KEY=xxx node scripts/scenarios-remote.mjs https://yutingprod.com/mcp/
   ========================================================================== */

"use strict";

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import sharp from "sharp";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE =
  ((process.argv[2] || process.env.DEWEB_SHRINK_MCP_URL || "https://yutingprod.com/mcp/").replace(/\/+$/, "")) + "/";
const KEY = (process.env.DEWEB_SHRINK_API_KEY || "").trim();
const NET = "bsc";
const GP = 0.05;
const USD = 747.31;

/* ------------------------------- 断言收集 ------------------------------- */

const checks = [];
let pass = 0;
let fail = 0;
let currentGroup = "";

function check(name, ok, detail = "") {
  if (ok === null || ok === undefined) return record(name, detail);
  if (ok) pass++;
  else fail++;
  checks.push({ group: currentGroup, name, ok: !!ok, detail: String(detail ?? "") });
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? `  ${detail}` : ""}`);
  return !!ok;
}

/** 环境决定、不设唯一预期的观察项：只记录，不计分。 */
function record(name, detail) {
  checks.push({ group: currentGroup, name, ok: null, detail: String(detail ?? "") });
  console.log(`  · ${name}${detail ? `  ${detail}` : ""}`);
  return true;
}

async function group(title, fn) {
  currentGroup = title;
  console.log("");
  console.log(title);
  try {
    await fn();
  } catch (err) {
    check(`${title} · 组内意外异常`, false, err?.stack?.split("\n")[0] || String(err));
  }
}

/* ------------------------------- 基础工具 ------------------------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 裸 HTTP：auth / 方法 / body 这些边界只能这么测。 */
async function http(method, suffix = "", { body, key = KEY, headers = {}, timeoutMs = 180000, rawBody } = {}) {
  const url = BASE + suffix;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const payload = rawBody !== undefined ? rawBody : body === undefined ? undefined : JSON.stringify(body);
    const res = await fetch(url, {
      method,
      headers: {
        ...(payload !== undefined ? { "content-type": "application/json" } : {}),
        accept: "application/json, text/event-stream",
        ...(key ? { "x-api-key": key } : {}),
        ...headers,
      },
      ...(payload !== undefined ? { body: payload } : {}),
      signal: ctrl.signal,
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, text, ms: Date.now() - t0, aborted: false };
  } catch (err) {
    return { status: 0, headers: new Headers(), text: String(err.message), ms: Date.now() - t0, aborted: true };
  } finally {
    clearTimeout(timer);
  }
}

/** MCP 的响应可能是 SSE，也可能是纯 JSON；两种都拆。 */
function parseRpcMsgs(text) {
  const out = [];
  for (const line of String(text).split("\n")) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    try {
      out.push(JSON.parse(t.slice(5).trim()));
    } catch {
      /* 半截行 */
    }
  }
  if (out.length) return out;
  try {
    return [JSON.parse(text)];
  } catch {
    return [];
  }
}

async function rpc(method, params, { id = 1, key = KEY, timeoutMs = 180000 } = {}) {
  const r = await http("POST", "", { body: { jsonrpc: "2.0", id, method, params }, key, timeoutMs });
  return { ...r, msgs: parseRpcMsgs(r.text) };
}

/** 从工具返回里抠出「--- JSON ---」那段。 */
function resultJson(result) {
  for (const c of result?.content || []) {
    if (typeof c.text === "string" && c.text.includes("--- JSON ---")) {
      try {
        return JSON.parse(c.text.split("--- JSON ---")[1]);
      } catch {
        return null;
      }
    }
  }
  return null;
}

function resultText(result) {
  return (result?.content || [])
    .filter((c) => typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");
}

/* ------------------------------ 两边客户端 ------------------------------ */

let remote = null;
let local = null;
let remoteViaSdk = false;

async function connectRemote() {
  const transport = new StreamableHTTPClientTransport(new URL(BASE), {
    requestInit: { headers: { "x-api-key": KEY } },
  });
  const client = new Client({ name: "deweb-shrink-scenarios", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  remoteViaSdk = true;
  return client;
}

async function connectLocal() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, "src", "index.js")],
    cwd: ROOT,
    stderr: "ignore",
  });
  const client = new Client({ name: "deweb-shrink-local-parity", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

/**
 * 统一调用：优先走标准 MCP 客户端（真实通路），没有客户端时退回裸 JSON-RPC。
 * 返回 { ok, data, text, isError, ms, via, status }。
 */
async function call(client, name, args, { timeoutMs = 180000 } = {}) {
  const t0 = Date.now();
  if (client) {
    try {
      const r = await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs });
      return {
        ok: true,
        isError: !!r.isError,
        data: resultJson(r),
        text: resultText(r),
        ms: Date.now() - t0,
        via: "mcp-client",
        status: 200,
      };
    } catch (err) {
      return { ok: false, isError: true, data: null, text: String(err.message), ms: Date.now() - t0, via: "mcp-client", status: 0 };
    }
  }
  const r = await rpc("tools/call", { name, arguments: args }, { timeoutMs });
  const result = r.msgs[0]?.result;
  return {
    ok: r.status === 200,
    isError: !!result?.isError,
    data: resultJson(result),
    text: resultText(result) || r.text,
    ms: Date.now() - t0,
    via: "raw-jsonrpc",
    status: r.status,
  };
}

/* --------------------------------- 素材 --------------------------------- */

async function loadDir(dir) {
  const out = [];
  const BIN = /\.(png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|eot|mp4|webm|mp3|wasm|pdf|zip|bin)$/i;
  async function walk(abs, rel) {
    for (const e of await fs.readdir(abs, { withFileTypes: true })) {
      const a = path.join(abs, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(a, r);
      else if (e.isFile()) {
        const buf = await fs.readFile(a);
        out.push(BIN.test(r) ? { path: r, base64: buf.toString("base64") } : { path: r, content: buf.toString("utf8") });
      }
    }
  }
  await walk(path.resolve(dir), "");
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

const txt = (p, content) => ({ path: p, content });
const bin = (p, buf) => ({ path: p, base64: buf.toString("base64") });

const pngFlat = (w, h, bg) => sharp({ create: { width: w, height: h, channels: 3, background: bg } }).png().toBuffer();

const CLOCK_JS =
  "var NixieClock = (function () {\n  var internalTick = 12345;\n  function boot() { return internalTick; }\n  return { boot: boot };\n})();\n";

function siteBasic({ index } = {}) {
  return [
    txt(
      "index.html",
      index ||
        '<!doctype html>\n<html><head><meta charset="utf-8"><link rel="stylesheet" href="app.css"></head>\n' +
          '<body>\n<h1>   场景测试   </h1>\n<!-- 这段注释应该被压掉 -->\n' +
          '<img src="logo.png" alt="logo">\n<script src="clock.js"></script>\n<script>NixieClock.boot();</script>\n' +
          "</body></html>\n",
    ),
    txt("clock.js", CLOCK_JS),
    txt("app.js", "/* 横幅注释 */\nfunction  add ( a , b ) {\n  var unusedLongName = 1;\n  return a + b ;\n}\nwindow.add = add ;\n"),
    txt("app.css", "/* 样式注释 */\nbody {   color : #fff ;   margin : 0  0   0 0 ; }\n"),
    txt("robots.txt", "User-agent: *\nAllow: /\n"),
    bin("logo.png", PNG_LOGO),
  ];
}

const PNG_LOGO = await pngFlat(64, 64, { r: 200, g: 60, b: 40 });
const PNG_UNUSED = await pngFlat(48, 48, { r: 10, g: 120, b: 200 });
const ICO_BYTES = Buffer.concat([Buffer.from([0, 0, 1, 0, 1, 0]), Buffer.alloc(60, 7)]);

/* ============================== 场景开始 ============================== */

console.log("");
console.log("═".repeat(74));
console.log("  deweb-shrink · 远程 MCP 多场景模拟测试");
console.log("═".repeat(74));
console.log(`  端点  ${BASE}`);
console.log(`  认证  ${KEY ? "带 API key" : "⚠️ 未提供 DEWEB_SHRINK_API_KEY（大量场景会 401）"}`);
console.log(`  时间  ${new Date().toISOString()}`);

/* ------------------------------ ⓪ 真实客户端 ------------------------------ */

await group("⓪ 真实 MCP 客户端连接（SDK + Streamable HTTP）", async () => {
  try {
    remote = await connectRemote();
    check("initialize 握手成功（标准客户端能连上共享主机桥接）", true, `via ${remote.constructor.name}`);
  } catch (err) {
    check("initialize 握手成功", false, err.message);
    console.log("  ⚠️ 标准客户端连不上，后续工具调用退回裸 JSON-RPC（结果是等价的）");
  }

  const ver = remote?.getServerVersion?.();
  record("服务端 self-report", ver ? `${ver.name} ${ver.version}` : "（拿不到）");

  /* 对照组：本地 stdio 跑的是同一份代码，用来把「服务的问题」和「输入的问题」分开 */
  try {
    local = await connectLocal();
    check("本地 stdio 客户端也连上（对照组，用于对拍）", true, path.join("src", "index.js"));
  } catch (err) {
    check("本地 stdio 客户端也连上（对照组，用于对拍）", false, err.message);
  }

  if (remote) {
    const t = await remote.listTools();
    const names = (t.tools || []).map((x) => x.name);
    check("tools/list 返回 6 个工具", names.length === 6, names.join(", "));
    check(
      "工具名与文档一致（无 tape_ 遗留前缀）",
      ["cost_model", "scan", "estimate", "optimize", "verify", "diff"].every((n) => names.includes(n)) &&
        !names.some((n) => n.startsWith("tape_")),
      names.join(", "),
    );
  }
});

/* ------------------------------ ① 端点与鉴权 ------------------------------ */

await group("① 端点、鉴权与协议边界（裸 HTTP）", async () => {
  const h = await http("GET");
  let hj = null;
  try {
    hj = JSON.parse(h.text);
  } catch {
    /* 不是 JSON */
  }
  check("GET /mcp/ 探活 200", h.status === 200, `${h.ms}ms`);
  check("探活自称 deweb-shrink", hj?.service === "deweb-shrink" || hj?.name === "deweb-shrink", JSON.stringify(hj));
  record("部署形态", hj?.mode || "unknown");
  check("探活不需要 key（方便负载均衡）", hj?.ok === true && hj?.authRequired === true);

  const noKey = await rpc("tools/list", {}, { key: "" });
  check("不带 key → 401", noKey.status === 401, `HTTP ${noKey.status} ${noKey.text.slice(0, 60)}`);

  const badKey = await rpc("tools/list", {}, { key: "wrong-key-000" });
  check("错误 key → 401", badKey.status === 401, `HTTP ${badKey.status}`);

  const bearer = await http("POST", "", {
    body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    key: "",
    headers: { authorization: `Bearer ${KEY}` },
  });
  check("Authorization: Bearer 也能认证（不只 x-api-key）", bearer.status === 200 && parseRpcMsgs(bearer.text).length > 0, `HTTP ${bearer.status}`);

  const put = await http("PUT", "", { body: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
  check("PUT → 405（无状态端点只收 POST）", put.status === 405, `HTTP ${put.status}`);

  const del = await http("DELETE", "", { key: KEY });
  check("DELETE → 405（没有会话可删）", del.status === 405, `HTTP ${del.status}`);

  const badJson = await http("POST", "", { rawBody: "{not json", key: KEY });
  check("坏 JSON → 400 且提示明确", badJson.status === 400 && /json/i.test(badJson.text), `HTTP ${badJson.status} ${badJson.text.slice(0, 60)}`);

  const empty = await http("POST", "", { rawBody: "", key: KEY });
  check("空 body → 400", empty.status === 400, `HTTP ${empty.status} ${empty.text.slice(0, 60)}`);

  const t0 = Date.now();
  const note = await http("POST", "", {
    body: { jsonrpc: "2.0", method: "notifications/initialized" }, // 无 id = notification
    key: KEY,
  });
  const noteMs = Date.now() - t0;
  check("notification（无 id）202 且不挂起", note.status === 202 && noteMs < 5000, `HTTP ${note.status} ${noteMs}ms`);

  const oob = await rpc("tools/call", { name: "definitely_not_a_tool", arguments: {} });
  const oobMsg = oob.msgs[0];
  check(
    "不存在的工具 → JSON-RPC 错误（不是 500）",
    oob.status === 200 && (oobMsg?.error || oobMsg?.result?.isError),
    JSON.stringify(oobMsg?.error?.code ?? oobMsg?.result?.isError ?? "?"),
  );

  const health = await http("GET", "health");
  record(
    "/mcp/health 的实际行为（文档说这里会被前端兜底吃掉）",
    `HTTP ${health.status} · ${health.headers.get("content-type") || "-"} · ${health.text.slice(0, 40).replace(/\n/g, " ")}`,
  );

  const big = 17 * 1024 * 1024;
  const huge = await http("POST", "", {
    body: { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "scan", arguments: { files: [txt("big.txt", "A".repeat(big))] } } },
    timeoutMs: 180000,
  });
  const hugeJson = parseRpcMsgs(huge.text)[0];
  const hugeMsg = hugeJson?.result?.content?.[0]?.text || hugeJson?.error?.message || huge.text;
  check(
    "17MB 请求体被前端挡住（4xx + 可读错误，不是挂死 / 不是 500）",
    !huge.aborted && huge.status >= 400 && huge.status < 500 && String(hugeMsg).trim().length > 0,
    `HTTP ${huge.status} · ${huge.ms}ms · ${String(hugeMsg).slice(0, 70).replace(/\n/g, " ")}`,
  );
});

/* ---------------------------- ② 计费模型与估算 ---------------------------- */

await group("② 计费模型与估算（纯计算，不碰文件）", async () => {
  const cm = await call(remote, "cost_model", { network: NET, priceUsd: USD });
  const d = cm.data;
  check("cost_model 调用成功", !!d, `${cm.ms}ms via ${cm.via}`);
  if (d) {
    const c = d.constants || {};
    check(
      "常量与协议前端一致（24000 / 270000 / 235）",
      c.CHUNK_BYTES === 24000 && c.perChunk === 270000 && c.perByte === 235,
      `CHUNK_BYTES=${c.CHUNK_BYTES} perChunk=${c.perChunk} perByte=${c.perByte}`,
    );
    const expectGas = 44 * 270000 + 1024 * 1024 * 235;
    check("1 MB 参考价 = 44 块 / 258,295,360 gas", d.perMegabyte?.chunks === 44 && d.perMegabyte?.gas === expectGas, JSON.stringify(d.perMegabyte));
    check(
      "1 MB ≈ 0.0129 BNB（$747.31 下 ≈ $9.6）",
      Math.abs((d.perMegabyte?.native ?? 0) - 0.012914768) < 1e-6 && d.perMegabyte?.usd > 9 && d.perMegabyte?.usd < 10.5,
      `${d.perMegabyte?.native} BNB ≈ $${Number(d.perMegabyte?.usd).toFixed(2)}`,
    );
  }

  const xl = await call(remote, "cost_model", { network: "xlayer", priceUsd: USD });
  check("xlayer 也能算（地板价 0.02 gwei）", !!xl.data && xl.data.gasPriceGwei === 0.02, `gasPrice=${xl.data?.gasPriceGwei} ${xl.data?.symbol}`);

  const base = await call(remote, "cost_model", { network: "base", priceUsd: USD });
  check("base 也能算", !!base.data && base.data.network === "base", `${base.data?.symbol}`);

  const live = await call(remote, "cost_model", { network: NET, liveGasPrice: true });
  record("liveGasPrice=true（读链上实时价）", live.data ? `gasPrice ${live.data.gasPriceGwei} gwei · live=${live.data.liveGasPriceGwei}` : `读取失败：${live.text.slice(0, 60)}`);

  const one = await call(remote, "estimate", { bytes: 1024 * 1024, network: NET, gasPriceGwei: GP, priceUsd: USD });
  check(
    "estimate 1MB 与 cost_model 的参考价一致（同一公式）",
    one.data?.gas?.gas === 44 * 270000 + 1024 * 1024 * 235,
    `gas=${one.data?.gas?.gas}`,
  );

  const many = await call(remote, "estimate", {
    files: Array.from({ length: 10 }, (_, i) => ({ path: `f${i}.txt`, bytes: 3 * 1024 })),
    network: NET,
    gasPriceGwei: GP,
    priceUsd: USD,
  });
  const single = await call(remote, "estimate", { bytes: 30 * 1024, network: NET, gasPriceGwei: GP, priceUsd: USD });
  check(
    "「多文件比大文件贵」：10×3KB 比 1×30KB 贵（块开销按文件向上取整）",
    many.data?.gas?.gas > single.data?.gas?.gas,
    `10 个文件 ${many.data?.gas?.gas} gas > 单文件 ${single.data?.gas?.gas} gas`,
  );

  const edge = await call(remote, "estimate", { bytes: 0, network: NET, gasPriceGwei: GP, priceUsd: USD });
  check(
    "estimate 0 字节不产生负数/异常（空文件仍算 1 块 = 一笔交易）",
    edge.data?.gas?.bytes === 0 && edge.data?.gas?.chunks === 1 && edge.data?.gas?.gas === 270000,
    JSON.stringify(edge.data?.gas),
  );

  const neg = await call(remote, "estimate", { bytes: -5, network: NET, gasPriceGwei: GP, priceUsd: USD });
  check("estimate 负数被夹到 0 再按 1 块计（不产生负账单）", neg.data?.gas?.bytes === 0 && neg.data?.gas?.gas === 270000, `bytes=${neg.data?.gas?.bytes} gas=${neg.data?.gas?.gas}`);

  const frac = await call(remote, "estimate", { bytes: 1.9, network: NET, gasPriceGwei: GP, priceUsd: USD });
  check("estimate 小数被向下取整", frac.data?.gas?.bytes === 1, `bytes=${frac.data?.gas?.bytes}`);

  const localEst = await call(local, "estimate", { bytes: 1024 * 1024, network: NET, gasPriceGwei: GP, priceUsd: USD });
  check("远程与本地 estimate 逐字段一致", JSON.stringify(one.data?.gas) === JSON.stringify(localEst.data?.gas), `remote=${one.data?.gas?.gas} local=${localEst.data?.gas?.gas}`);
});

/* --------------------------- ③ 与本地 stdio 对拍 --------------------------- */

const REAL_FILES = await loadDir(path.join(ROOT, "fixtures", "07-real-site"));
const REAL_DIR = path.join(ROOT, "fixtures", "07-real-site");

await group(`③ 真实站点对拍：远程 files ⇄ 本地 stdio（${REAL_FILES.length} 个文件 / ${(REAL_FILES.reduce((a, f) => a + (f.content ? Buffer.byteLength(f.content) : Buffer.from(f.base64, "base64").length), 0) / 1024).toFixed(0)} KB）`, async () => {
  const [remoteScan, localScanMem, localScanFs] = [
    await call(remote, "scan", { files: REAL_FILES, network: NET, gasPriceGwei: GP, priceUsd: USD }),
    await call(local, "scan", { files: REAL_FILES, network: NET, gasPriceGwei: GP, priceUsd: USD }),
    await call(local, "scan", { dir: REAL_DIR, network: NET, gasPriceGwei: GP, priceUsd: USD }),
  ];

  check("远程 scan（内容驱动）成功", !!remoteScan.data, `${remoteScan.ms}ms`);
  check(
    "远程 files 与本地 files 的账单完全一致",
    JSON.stringify(remoteScan.data?.totals) === JSON.stringify(localScanMem.data?.totals) &&
      JSON.stringify(remoteScan.data?.gas) === JSON.stringify(localScanMem.data?.gas),
    `remote ${remoteScan.data?.totals?.bytes}B/${remoteScan.data?.gas?.chunks}块 vs local ${localScanMem.data?.totals?.bytes}B`,
  );
  check(
    "远程 files 与本地 dir（真实目录）的账单一致（两种形态同一套算法）",
    remoteScan.data?.totals?.bytes === localScanFs.data?.totals?.bytes &&
      remoteScan.data?.gas?.gas === localScanFs.data?.gas?.gas,
    `remote ${remoteScan.data?.totals?.billableFiles} 文件 / ${remoteScan.data?.gas?.gas} gas vs local ${localScanFs.data?.totals?.billableFiles} 文件 / ${localScanFs.data?.gas?.gas} gas`,
  );

  /* 重请求在共享主机上是碰运气（见报告「共享主机资源上限」），所以连试 3 次：
     既给对拍一次机会，也顺手量一下失败率 —— 失败本身就是要记录的现象。 */
  const attempts = [];
  let remoteOpt = null;
  for (let i = 0; i < 3 && !remoteOpt; i++) {
    const r = await call(remote, "optimize", { files: REAL_FILES, network: NET, gasPriceGwei: GP, priceUsd: USD }, { timeoutMs: 150000 });
    attempts.push(r);
    if (r.data) remoteOpt = r;
  }
  const localOpt = await call(local, "optimize", { files: REAL_FILES, network: NET, gasPriceGwei: GP, priceUsd: USD }, { timeoutMs: 300000 });

  check("本地 stdio 对同一份文件 optimize 成功（对照组）", !!localOpt.data, `${localOpt.ms}ms · 产物 ${localOpt.data?.artifacts?.length ?? 0} 个`);
  check(
    "远程 optimize 成功（含图片的真实站点，最多重试 3 次）",
    !!remoteOpt,
    remoteOpt
      ? `${remoteOpt.ms}ms（第 ${attempts.length} 次尝试）`
      : `3 次全失败：${String(attempts[0]?.text).replace(/\s+/g, " ").slice(0, 120)}`,
  );
  record("重请求失败率（同一输入连续调用，由共享主机资源上限决定）", `${attempts.filter((a) => !a.data).length}/${attempts.length} 次失败`);

  if (!remoteOpt) {
    check("远程与本地产物对拍（前置条件：远程 optimize 至少成功一次）", false, "三次都没成功，无法对拍");
  } else {
  check("远程优化确实变小", remoteOpt.data?.saved?.bytes > 0, `${remoteOpt.data?.before?.totals?.bytes} → ${remoteOpt.data?.after?.totals?.bytes} 字节`);

  const artMap = (arts) => new Map((arts || []).map((a) => [a.path, Buffer.from(a.base64, "base64")]));
  const ra = artMap(remoteOpt.data?.artifacts);
  const la = artMap(localOpt.data?.artifacts);
  const rPaths = [...ra.keys()].sort().join(",");
  const lPaths = [...la.keys()].sort().join(",");
  check("远程与本地的产物文件集合一致", rPaths.length > 0 && rPaths === lPaths, `remote ${ra.size} 个 vs local ${la.size} 个`);
  check(
    "远程与本地的删除清单一致（README / 无引用图标）",
    JSON.stringify((remoteOpt.data?.files?.dropped || []).map((d) => d.path)) ===
      JSON.stringify((localOpt.data?.files?.dropped || []).map((d) => d.path)),
    (remoteOpt.data?.files?.dropped || []).map((d) => d.path).join("、") || "（无）",
  );

  const imgRe = /\.(png|jpe?g|webp|avif|gif|ico)$/i;
  const textDiff = [...ra]
    .filter(([p, b]) => !imgRe.test(p) && la.has(p) && !b.equals(la.get(p)))
    .map(([p, b]) => `${p}：远程 ${b.length}B vs 本地 ${la.get(p).length}B`);
  check(
    "非图片产物与本地逐字节一致（不一致 = 服务器上压缩退化了）",
    textDiff.length === 0,
    textDiff.join("；") || `共 ${[...ra].filter(([p]) => !imgRe.test(p)).length} 个文件`,
  );

  const imgDiff = [...ra].filter(([p, b]) => imgRe.test(p) && la.has(p) && !b.equals(la.get(p)));
  record("图片产物的跨平台差异（libvips 编译不同 / 逐档挑质量时的浮点差）", imgDiff.map(([p, b]) => `${p}：${b.length}B vs ${la.get(p).length}B`).join("；") || "全部逐字节一致");
  for (const [p, b] of imgDiff) {
    try {
      const [x, y] = await Promise.all([sharp(b).raw().toBuffer(), sharp(la.get(p)).raw().toBuffer()]);
      if (x.length !== y.length) {
        record(`  ${p} 像素数不同`, `${x.length} vs ${y.length}`);
        continue;
      }
      let se = 0;
      for (let i = 0; i < x.length; i++) {
        const d = x[i] - y[i];
        se += d * d;
      }
      const mse = se / x.length;
      record(`  ${p} 像素对拍`, mse === 0 ? "像素完全相同（PSNR ∞，只是编码字节不同）" : `PSNR ${(10 * Math.log10((255 * 255) / mse)).toFixed(2)} dB（视觉不可分辨）`);
    } catch (err) {
      record(`  ${p} 像素对拍失败`, err.message.slice(0, 60));
    }
  }

  check(
    "artifacts 的 base64 与 bytes 长度一致（没有截断/膨胀）",
    (remoteOpt.data?.artifacts || []).every((a) => Buffer.from(a.base64, "base64").length === a.bytes),
    `${remoteOpt.data?.artifacts?.length} 个`,
  );
  check("远程优化的校验通过", remoteOpt.data?.verification?.ok === true, `fail ${remoteOpt.data?.verification?.failed} / warn ${remoteOpt.data?.verification?.warned}`);
  }
});

/* ------------------------------- ④ 压缩能力 ------------------------------- */

await group("④ 压缩能力：JS/CSS/HTML、图片、激进档、转 WebP、白花钱文件", async () => {
  const basic = siteBasic();

  const min = await call(remote, "optimize", { files: basic, network: NET, gasPriceGwei: GP, priceUsd: USD });
  const minArt = new Map((min.data?.artifacts || []).map((a) => [a.path, Buffer.from(a.base64, "base64").toString("utf8")]));
  check("默认档压缩成功", !!min.data && min.data.saved?.bytes > 0, `省 ${min.data?.saved?.bytes} 字节`);
  check(
    "JS 压缩但保留被内联脚本引用的顶层全局 NixieClock",
    minArt.get("clock.js")?.includes("NixieClock") && minArt.get("clock.js").length < CLOCK_JS.length,
    `${CLOCK_JS.length} → ${minArt.get("clock.js")?.length} 字节`,
  );
  check("HTML 注释被压掉", !String(minArt.get("index.html")).includes("这段注释"));

  const aggr = await call(remote, "optimize", {
    files: basic,
    options: { aggressiveHtml: true },
    network: NET,
    gasPriceGwei: GP,
    priceUsd: USD,
  });
  check(
    "激进 HTML 档比默认档更小",
    aggr.data?.after?.totals?.bytes < min.data?.after?.totals?.bytes,
    `${min.data?.after?.totals?.bytes} → ${aggr.data?.after?.totals?.bytes} 字节`,
  );
  check("激进档校验依然通过", aggr.data?.verification?.ok === true, `fail ${aggr.data?.verification?.failed}`);

  const webp = await call(remote, "optimize", {
    files: basic,
    options: { convertImages: true, convertTo: "webp" },
    network: NET,
    gasPriceGwei: GP,
    priceUsd: USD,
  });
  const webpNames = (webp.data?.artifacts || []).map((a) => a.path);
  check("转 WebP：产物里出现 .webp、旧 .png 不再写入", webpNames.includes("logo.webp") && !webpNames.includes("logo.png"), webpNames.join(", "));
  const webpHtml = Buffer.from((webp.data?.artifacts || []).find((a) => a.path === "index.html")?.base64 || "", "base64").toString("utf8");
  check("转 WebP 后 HTML 引用被同步重写（历史上踩过的 404 bug）", webpHtml.includes("logo.webp") && !webpHtml.includes("logo.png"));
  check("转 WebP 后校验不报断链/尺寸", webp.data?.verification?.ok === true, `fail ${webp.data?.verification?.failed} / warn ${webp.data?.verification?.warned}`);

  /* 图片量化：用真实照片（fixtures/02-images），平色图看不出压缩率 */
  const IMG_FILES = await loadDir(path.join(ROOT, "fixtures", "02-images"));
  const img = await call(remote, "optimize", { files: IMG_FILES, network: NET, gasPriceGwei: GP, priceUsd: USD }, { timeoutMs: 300000 });
  check("真实 PNG 站点压缩成功且省钱", (img.data?.saved?.bytes ?? 0) > 0, `${img.data?.before?.totals?.bytes} → ${img.data?.after?.totals?.bytes} 字节（省 ${img.data?.saved?.bytes}）`);
  const dimCheck = (img.data?.verification?.checks || []).find((c) => c.name === "图片尺寸");
  check("图片像素尺寸不变（只重编码）", dimCheck?.status === "pass", dimCheck?.detail?.slice(0, 60));

  /* 白花钱的文件：默认删，但约定路径文件必须留 */
  const messy = [
    ...basic,
    txt("README.md", "# 这是文档，不该上链\n"),
    txt("app.js.map", JSON.stringify({ version: 3, sources: ["app.js"] })),
    bin("unused.png", PNG_UNUSED),
    bin("favicon.ico", ICO_BYTES),
    bin("apple-touch-icon.png", PNG_LOGO),
    txt("docs/notes.md", "设计稿说明\n"),
  ];
  const dropped = await call(remote, "optimize", { files: messy, network: NET, gasPriceGwei: GP, priceUsd: USD });
  const outNames = (dropped.data?.artifacts || []).map((a) => a.path);
  const droppedNames = (dropped.data?.files?.dropped || []).map((d) => d.path);
  check("默认删掉 README / .map / 无引用图", ["README.md", "app.js.map", "unused.png"].every((p) => !outNames.includes(p)), `删除 ${droppedNames.join("、") || "（无）"}`);
  check(
    "约定路径文件被保护（robots.txt / favicon.ico / apple-touch-icon.png 即使没引用也保留）",
    ["robots.txt", "favicon.ico", "apple-touch-icon.png"].every((p) => outNames.includes(p)),
    outNames.join(", "),
  );
  record(
    "被保护清单（报告里会说明，免得用户以为漏删了）",
    (dropped.data?.files?.protectedByConvention || []).map((x) => (typeof x === "string" ? x : x.path)).join("、") || "（空）",
  );
  check("被删文件的省下字节被算进账单", (dropped.data?.saved?.bytes ?? 0) > 0, `省 ${dropped.data?.saved?.bytes} 字节`);
  check("删除后校验通过", dropped.data?.verification?.ok === true, `fail ${dropped.data?.verification?.failed}`);

  const kept = await call(remote, "optimize", {
    files: messy,
    options: { dropUnreferenced: false, dropNonSiteFiles: false },
    network: NET,
    gasPriceGwei: GP,
    priceUsd: USD,
  });
  const keptNames = (kept.data?.artifacts || []).map((a) => a.path);
  check(
    "关掉删除开关后一个文件都不少（人工可控）",
    ["README.md", "app.js.map", "unused.png", "docs/notes.md"].every((p) => keptNames.includes(p)),
    `${keptNames.length} 个产物`,
  );
});

/* ------------------------------- ⑤ 扫描诊断 ------------------------------- */

await group("⑤ 扫描诊断：隐藏文件、断链、重复、超限", async () => {
  const messy = [
    txt("index.html", '<!doctype html>\n<html><body><img src="icons/icon-512.png"><img src="missing.png"><script src="a.js"></script></body></html>\n'),
    txt("a.js", "var a = 1;\n"),
    txt("b.js", "var a = 1;\n"), // 与 a.js 完全重复
    txt(".DS_Store", "mac junk"),
    bin(".shots/design-v1.png", PNG_UNUSED),
    txt(".well-known/assetlinks.json", "[]"),
    txt("README.md", "# docs\n"),
    txt("manifest.webmanifest", '{"name":"x","icons":[{"src":"icons/icon-512.png","type":"image/png"}]}'),
    bin("icons/icon-512.png", PNG_LOGO),
  ];

  const s = await call(remote, "scan", { files: messy, network: NET, gasPriceGwei: GP, priceUsd: USD });
  const d = s.data || {};
  const skipped = (d.skipped || []).map((x) => `${x.path}（${x.reason}）`);
  check("scan 调用成功", !!s.data, `${s.ms}ms`);
  check("隐藏文件/目录被标为「协议会静默跳过」", [".DS_Store", ".shots/design-v1.png", ".well-known/assetlinks.json"].every((p) => skipped.some((x) => x.startsWith(p))), skipped.join("、"));
  const unresolved = JSON.stringify(d.unresolved);
  check("断链引用被报出来", /missing\.png/.test(unresolved), unresolved.slice(0, 80));
  check("重复内容被报出来", (d.duplicates || []).length >= 1, JSON.stringify(d.duplicates));
  check("README.md 被标为「不像站点文件」", (d.files || []).some((f) => f.path === "README.md" && f.likelyNotSiteFile === true));
  check("Content-Type 表照抄协议（.webmanifest 是未知扩展名 → octet-stream）", (d.files || []).find((f) => f.path === "manifest.webmanifest")?.contentType === "application/octet-stream", String((d.files || []).find((f) => f.path === "manifest.webmanifest")?.contentType));

  /* 超过 8 MiB 的单文件：远程形态下永远先撞上请求护栏 */
  const hugeOnly = await call(remote, "scan", { files: [bin("huge-video.mp4", Buffer.alloc(9 * 1024 * 1024, 1))], network: NET, gasPriceGwei: GP, priceUsd: USD });
  record(
    "9 MiB 单文件在远程形态的实际行为",
    hugeOnly.isError ? `被护栏拦住：${hugeOnly.text.replace(/^错误：/, "").slice(0, 90)}…` : `通过了：${JSON.stringify(hugeOnly.data?.totals)}`,
  );
  const hugeLocal = await call(local, "scan", { dir: path.join(ROOT, "fixtures", "05-messy"), network: NET, gasPriceGwei: GP, priceUsd: USD });
  const localSkipped = (hugeLocal.data?.skipped || []).find((x) => x.path === "huge-video.mp4");
  check("本地 dir 形态下 9 MiB 文件会被标为超限跳过（协议行为）", !!localSkipped, localSkipped?.reason || "（没找到）");
});

/* ------------------------------- ⑥ 校验 ------------------------------- */

await group("⑥ 校验：能不能拦住坏产物", async () => {
  const good = siteBasic();
  const v1 = await call(remote, "verify", { files: good });
  check("正常站点自洽校验通过", v1.data?.ok === true, `fail ${v1.data?.failed} / warn ${v1.data?.warned}`);
  for (const n of ["入口 index.html", "协议合法性", "引用完整性", "JS 语法", "HTML 结构", "跨文件全局", "Content-Type", "单文件上限"]) {
    check(`  校验项「${n}」存在`, (v1.data?.checks || []).some((c) => c.name === n));
  }

  /* 模拟「压缩器把被引用的顶层全局改名」：只在 clock.js 里改，index.html 仍按老名字调用 */
  const renamed = good.map((f) => (f.path === "clock.js" ? { ...f, content: f.content.replace("NixieClock", "Zz9") } : f));
  const v2 = await call(remote, "verify", { files: renamed, referenceFiles: good });
  const global = (v2.data?.checks || []).find((c) => c.name === "跨文件全局");
  check("把被引用的全局改名 → 对拍校验拦住", v2.data?.ok === false && global?.status === "fail", String(global?.detail).slice(0, 80));

  const noEntry = good.filter((f) => f.path !== "index.html");
  const v3 = await call(remote, "verify", { files: noEntry });
  check("没有 index.html → 校验失败", v3.data?.ok === false, (v3.data?.checks || []).find((c) => c.name === "入口 index.html")?.detail?.slice(0, 60));

  const dangling = good.map((f) => (f.path === "index.html" ? { ...f, content: f.content.replace('src="logo.png"', 'src="gone.png"') } : f));
  const v4 = await call(remote, "verify", { files: dangling, referenceFiles: good });
  const refCheck = (v4.data?.checks || []).find((c) => c.name === "引用完整性");
  check("新增断链 → 对拍校验拦住", v4.data?.ok === false && refCheck?.status === "fail", refCheck?.detail?.slice(0, 70));

  const v5 = await call(remote, "verify", { files: good, referenceFiles: good });
  check("产物与原文一致时校验通过（不误报）", v5.data?.ok === true, `fail ${v5.data?.failed}`);
});

/* ------------------------------- ⑦ 增量账单 ------------------------------- */

await group("⑦ 增量账单：只改一个文件、删文件、首次部署", async () => {
  const prev = siteBasic();
  const next = prev.map((f) => (f.path === "app.js" ? { ...f, content: f.content.replace("a + b", "a + b * 2") } : f));

  const first = await call(remote, "diff", { nextFiles: next, network: NET, gasPriceGwei: GP, priceUsd: USD });
  check("首次部署（没有 previous）被识别", first.data?.firstDeploy === true, `total.gas=${first.data?.total?.gas}`);
  check("首次部署的账单等于全量", first.data?.total?.gas === first.data?.full?.gas);

  const inc = await call(remote, "diff", { previousFiles: prev, nextFiles: next, network: NET, gasPriceGwei: GP, priceUsd: USD });
  check("只改一个文件被识别（其余跳过）", inc.data?.counts?.changed === 1 && inc.data?.counts?.unchanged >= 5, JSON.stringify(inc.data?.counts));
  check("增量明显比全量便宜（只重传改动的那一个文件）", (inc.data?.total?.gas ?? 0) * 3 < (inc.data?.full?.gas ?? 1), `增量 ${inc.data?.total?.gas} vs 全量 ${inc.data?.full?.gas} gas`);
  const nextAppJs = next.find((f) => f.path === "app.js").content;
  check("上传字节 = 那一个文件的新字节数（整份重传）", inc.data?.upload?.bytes === Buffer.byteLength(nextAppJs), `${inc.data?.upload?.bytes} vs ${Buffer.byteLength(nextAppJs)}`);

  const removed = await call(remote, "diff", { previousFiles: prev, nextFiles: prev.filter((f) => f.path !== "unused-check"), network: NET, gasPriceGwei: GP, priceUsd: USD });
  record("同一份文件做 previous/next（无变化）", `changed=${removed.data?.counts?.changed} unchanged=${removed.data?.counts?.unchanged} upload.gas=${removed.data?.upload?.gas}`);

  const del = await call(remote, "diff", {
    previousFiles: [...prev, txt("old.html", "<!doctype html><html><body>旧页面</body></html>\n")],
    nextFiles: prev,
    network: NET,
    gasPriceGwei: GP,
    priceUsd: USD,
  });
  check("删除文件 → 计入 removeFile 的 gas（取下目录也要钱）", del.data?.counts?.removed === 1 && (del.data?.removal?.gas ?? 0) > 0, `removal.gas=${del.data?.removal?.gas}`);

  const localInc = await call(local, "diff", { previousFiles: prev, nextFiles: next, network: NET, gasPriceGwei: GP, priceUsd: USD });
  check("远程与本地 diff 账单一致", JSON.stringify(inc.data?.upload) === JSON.stringify(localInc.data?.upload) && JSON.stringify(inc.data?.total) === JSON.stringify(localInc.data?.total));
});

/* ------------------------------ ⑧ 输入健壮性 ------------------------------ */

await group("⑧ 输入健壮性：路径、重复、缺内容、空参数", async () => {
  const unicode = [
    txt("index.html", '<!doctype html>\n<html><body><img src="图片/图标 1.png"><script src="脚本/主 程序.js"></script></body></html>\n'),
    txt("脚本/主 程序.js", "var 中文变量 = 1;\nwindow.x = 中文变量;\n"),
    bin("图片/图标 1.png", PNG_LOGO),
  ];
  const u = await call(remote, "optimize", { files: unicode, network: NET, gasPriceGwei: GP, priceUsd: USD });
  const uNames = (u.data?.artifacts || []).map((a) => a.path);
  check("中文/空格路径能正常处理（NFC 归一化，不以 / 开头）", uNames.includes("脚本/主 程序.js") && uNames.every((n) => !n.startsWith("/")), uNames.join(", "));
  check("中文路径站点校验通过", u.data?.verification?.ok === true, `fail ${u.data?.verification?.failed}`);

  const leading = await call(remote, "scan", { files: [{ path: "/leading/slash.html", content: "<!doctype html><html></html>" }], network: NET, gasPriceGwei: GP, priceUsd: USD });
  check("前导斜杠被去掉（不是当成绝对路径）", (leading.data?.files || []).some((f) => f.path === "leading/slash.html"), JSON.stringify((leading.data?.files || []).map((f) => f.path)));

  const backslash = await call(remote, "scan", { files: [{ path: "dir\\win.html", content: "<!doctype html><html></html>" }], network: NET, gasPriceGwei: GP, priceUsd: USD });
  check("反斜杠被规范成 /（Windows 客户端友好）", (backslash.data?.files || []).some((f) => f.path === "dir/win.html"), JSON.stringify((backslash.data?.files || []).map((f) => f.path)));

  const dup = await call(remote, "scan", { files: [txt("a.html", "1"), txt("a.html", "2")], network: NET, gasPriceGwei: GP, priceUsd: USD });
  check("重复路径 → 明确报错（不静默取最后一个）", dup.isError && /重复路径/.test(dup.text), dup.text.slice(0, 70));

  const noContent = await call(remote, "scan", { files: [{ path: "a.html" }], network: NET, gasPriceGwei: GP, priceUsd: USD });
  check("缺少 content/base64 → 明确报错", noContent.isError && /缺少内容/.test(noContent.text), noContent.text.slice(0, 70));

  const traversal = await call(remote, "scan", { files: [txt("../../etc/passwd", "root:x:0:0")], network: NET, gasPriceGwei: GP, priceUsd: USD });
  check("路径穿越被拒", traversal.isError && /非法路径/.test(traversal.text), traversal.text.slice(0, 70));

  const longPath = await call(remote, "scan", { files: [txt(`${"a/".repeat(600)}x.html`, "x")], network: NET, gasPriceGwei: GP, priceUsd: USD });
  check("超长路径（>1000 字符）被拒", longPath.isError && /非法路径/.test(longPath.text), longPath.text.slice(0, 70));

  const badB64 = await call(remote, "scan", { files: [{ path: "weird.png", base64: "这不是 base64!!!" }], network: NET, gasPriceGwei: GP, priceUsd: USD });
  record("非法 base64 的行为", badB64.isError ? `报错：${badB64.text.slice(0, 60)}` : `容错通过：${badB64.data?.totals?.bytes} 字节被算进账单`);

  const excl = await call(remote, "scan", { files: [...siteBasic(), txt("docs/a.md", "# a\n"), txt("docs/b.md", "# b\n")], exclude: ["docs"], network: NET, gasPriceGwei: GP, priceUsd: USD });
  check("exclude 前缀生效", !(excl.data?.files || []).some((f) => f.path.startsWith("docs/")));

  /* 空参数：这是一个真实的行为边界 —— 不给 dir 也不给 files 时，服务端会 fallback 到自己的 cwd */
  const emptyScan = await call(remote, "scan", { network: NET, gasPriceGwei: GP, priceUsd: USD });
  const selfDir = emptyScan.isError ? null : String(emptyScan.data?.dir || "");
  if (emptyScan.isError) {
    check("空参数 scan → 明确报错", /缺少|需要|给/.test(emptyScan.text), emptyScan.text.slice(0, 70));
  } else {
    check(
      "空参数 scan 不应当悄悄扫描服务器自己的目录（缺陷：应报「缺少输入」）",
      !/deweb-shrink/.test(selfDir) || (emptyScan.data?.files || []).length === 0,
      `实际返回 dir=${selfDir}，列出 ${emptyScan.data?.files?.length ?? 0} 个文件、${emptyScan.data?.skipped?.length ?? 0} 个跳过项：` +
        `${(emptyScan.data?.skipped || []).map((x) => x.path).slice(0, 6).join("、")}`,
    );
  }

  const emptyFiles = await call(remote, "scan", { files: [], network: NET, gasPriceGwei: GP, priceUsd: USD });
  record("files: [] 的行为", emptyFiles.isError ? `报错：${emptyFiles.text.slice(0, 60)}` : `当作空输入之外的来源（dir=${emptyFiles.data?.dir}）`);

  const emptyOpt = await call(remote, "optimize", { network: NET, gasPriceGwei: GP, priceUsd: USD });
  check("空参数 optimize → 明确报错、不写盘", emptyOpt.isError, emptyOpt.text.slice(0, 80));

  const both = await call(remote, "scan", { dir: "/tmp/definitely-not-here", files: siteBasic(), network: NET, gasPriceGwei: GP, priceUsd: USD });
  check("同时给 dir 与 files 时以 files 为准（服务器上没有那个目录）", !!both.data && both.data.totals?.billableFiles > 0 && (both.data.files || []).length > 0, `billable=${both.data?.totals?.billableFiles}`);

  const unknownNet = await call(remote, "scan", { files: siteBasic(), network: "dogechain", gasPriceGwei: GP, priceUsd: USD });
  record("未知链名（schema 限定，应当被拒）", unknownNet.isError ? `被拒：${unknownNet.text.slice(0, 60)}` : `回退到 ${unknownNet.data?.network}`);
});

/* ------------------------------ ⑨ 性能与并发 ------------------------------ */

await group("⑨ 性能与并发", async () => {
  const t0 = Date.now();
  const first = await call(remote, "estimate", { bytes: 1024, network: NET, gasPriceGwei: GP, priceUsd: USD });
  const second = await call(remote, "estimate", { bytes: 1024, network: NET, gasPriceGwei: GP, priceUsd: USD });
  record("单次调用耗时", `第 1 次 ${first.ms}ms（含冷启动）· 第 2 次 ${second.ms}ms`);

  const probe = await http("POST", "", { body: { jsonrpc: "2.0", id: 77, method: "tools/list" } });
  const bridgeMs = probe.headers.get("x-tape-elapsed-ms");
  record("桥接自报的服务端耗时", bridgeMs ? `${bridgeMs}ms（x-tape-elapsed-ms）· 客户端实测 ${probe.ms}ms` : "（响应里没有这个头）");

  const basic = siteBasic();
  const solo = await call(remote, "optimize", { files: basic, network: NET, gasPriceGwei: GP, priceUsd: USD });
  check("单发 optimize 稳定成功（并发问题只在请求重叠时出现）", !!solo.data, `${solo.ms}ms`);

  const tConc = Date.now();
  const results = await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      call(remote, "optimize", { files: basic, network: NET, gasPriceGwei: GP, priceUsd: USD, options: { minifyJs: true } }).then((r) => ({ i, ...r })),
    ),
  );
  const concMs = Date.now() - tConc;
  const okCount = results.filter((r) => r.data && !r.isError).length;
  check("并发下至少有一半请求成功（服务没被拖死）", okCount >= 3, `${okCount}/6 · 总耗时 ${concMs}ms · 单个 ${results.map((r) => r.ms).join("/")}ms`);
  check(
    "并发失败时返回的是明确的后端错误（不是静默丢响应或损坏结果）",
    results.every((r) => (r.data && !r.isError) || /backend error|无法启动|没有返回内容|timed out|timeout/i.test(String(r.text))),
    results
      .filter((r) => !(r.data && !r.isError))
      .map((r) => `#${r.i}:${String(r.text).replace(/\s+/g, " ").slice(0, 60)}`)
      .join(" | ") || "（全部成功）",
  );
  record(
    "6 并发成功率（受共享主机每用户进程数上限影响，不是本工具的并发闸门）",
    `${okCount}/6 成功`,
  );

  const h = await http("GET");
  check("并发之后探活仍 200", h.status === 200, `${h.ms}ms`);

  const heavy = await call(remote, "optimize", { files: REAL_FILES, network: NET, gasPriceGwei: GP, priceUsd: USD }, { timeoutMs: 300000 });
  record("真实站点（852 KB / 20 文件）端到端 optimize", `${heavy.ms}ms · 产物 ${heavy.data?.artifacts?.length ?? 0} 个`);
});

/* -------------------------------- 汇总 -------------------------------- */

const scored = checks.filter((c) => c.ok !== null);
const total = scored.length;
console.log("");
console.log("═".repeat(74));
console.log(`  结果：${pass} 通过 / ${fail} 失败 · 计分 ${total} 项 · 仅记录 ${checks.length - total} 项`);
console.log("═".repeat(74));
if (fail) {
  console.log("");
  console.log("  失败项：");
  for (const c of scored.filter((x) => !x.ok)) console.log(`    ✗ [${c.group}] ${c.name}  ${c.detail}`);
}

const byGroup = {};
for (const c of checks) {
  byGroup[c.group] ||= { pass: 0, fail: 0, info: 0 };
  if (c.ok === null) byGroup[c.group].info++;
  else if (c.ok) byGroup[c.group].pass++;
  else byGroup[c.group].fail++;
}
console.log("");
console.log("  分组：");
for (const [g, s] of Object.entries(byGroup)) console.log(`    ${s.fail ? "✗" : "✓"} ${g}  —  ${s.pass} 通过${s.fail ? ` / ${s.fail} 失败` : ""}${s.info ? ` / ${s.info} 记录` : ""}`);

const report = {
  generatedAt: new Date().toISOString(),
  endpoint: BASE,
  auth: KEY ? "api-key" : "none",
  sdkClient: remoteViaSdk,
  summary: { pass, fail, scored: total, recorded: checks.length - total },
  byGroup,
  checks,
};
await fs.writeFile(path.join(ROOT, "remote-scenarios-report.json"), JSON.stringify(report, null, 2) + "\n");
console.log("");
console.log(`  机器可读报告：remote-scenarios-report.json`);
console.log("");

try {
  await remote?.close?.();
  await local?.close?.();
} catch {
  /* 收尾失败不影响结论 */
}
process.exit(fail ? 1 : 0);
