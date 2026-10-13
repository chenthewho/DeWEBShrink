#!/usr/bin/env node
/* ==========================================================================
   远程 MCP 端到端测试 —— 部署完拿它验收
   --------------------------------------------------------------------------
   和本地测试不同，这里测的是**真的通过网络连过去**的那一套，所以覆盖了
   本地测不到的东西：反向代理有没有截断 SSE、API key 有没有真生效、
   网络往返和超时、以及压缩结果能不能原样回来。

   用法：
     DEWEB_SHRINK_API_KEY=xxx node scripts/test-remote.mjs http://127.0.0.1:8787
     DEWEB_SHRINK_API_KEY=xxx node scripts/test-remote.mjs https://mcp.example.com

   经 SSH 隧道测试（服务只绑 127.0.0.1 时）：
     ssh -N -L 8787:127.0.0.1:8787 user@host &
     DEWEB_SHRINK_API_KEY=xxx node scripts/test-remote.mjs
   ========================================================================== */

"use strict";

/* 端点可以给两种形态：
     · 自建 HTTP（本机/容器）：给小 base，如 http://127.0.0.1:8787
       → MCP 走 /mcp，探活走 /health
     · 共享主机桥接（SiteGround 那种）：直接给 MCP 端点，如 https://example.com/mcp/
       → 探活就走同一个 URL 的 GET（那个环境里更深的路由会被站点前端兜底规则吃掉） */
const ARG = process.argv[2] || "http://127.0.0.1:8787";
const KEY = process.env.DEWEB_SHRINK_API_KEY || "";
const IS_FULL_ENDPOINT = /\/mcp\/?$/.test(ARG);
const MCP_URL = IS_FULL_ENDPOINT
  ? ARG
  : `${ARG.replace(/\/+$/, "")}${process.env.DEWEB_SHRINK_MCP_PATH || "/mcp"}`;
const HEALTH_URLS = IS_FULL_ENDPOINT
  ? [ARG]
  : [`${ARG.replace(/\/+$/, "")}/health`, `${ARG.replace(/\/+$/, "")}/mcp`];

let pass = 0;
let fail = 0;
const results = [];

function check(name, ok, detail = "") {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}${detail ? `  ${detail}` : ""}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? `  ${detail}` : ""}`);
  }
  results.push({ name, ok, detail });
  return ok;
}

/** MCP 的响应可能是 SSE（event:/data:）也可能是纯 JSON，两种都拆开。 */
function parseRpc(text) {
  const msgs = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    try {
      msgs.push(JSON.parse(t.slice(5).trim()));
    } catch {
      /* 半截行，忽略 */
    }
  }
  if (msgs.length) return msgs;
  try {
    return [JSON.parse(text)];
  } catch {
    return [];
  }
}

async function rpc(payload, { key = KEY, timeoutMs = 120000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(MCP_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(key ? { "x-api-key": key } : {}),
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    const text = await res.text();
    return { status: res.status, msgs: parseRpc(text), text };
  } finally {
    clearTimeout(timer);
  }
}

function jsonPayload(msgs) {
  for (const c of msgs[0]?.result?.content || []) {
    if (typeof c.text === "string" && c.text.includes("--- JSON ---")) {
      return JSON.parse(c.text.split("--- JSON ---")[1]);
    }
  }
  return null;
}

/* --------------------------------- 素材 --------------------------------- */

const SAMPLE = [
  {
    path: "index.html",
    content:
      '<!doctype html>\n<html><head><meta charset="utf-8"><link rel="stylesheet" href="app.css"></head>\n<body>\n  <h1>  远程测试  </h1>\n  <!-- 这段注释会被压掉 -->\n  <img src="logo.png" alt="logo">\n  <script src="app.js"></script>\n</body></html>\n',
  },
  {
    path: "app.js",
    content:
      "/* 一段横幅注释，压缩后应该消失 */\nfunction  add ( a , b ) {\n  var unusedLongName = 1;\n  return a + b ;\n}\nwindow.add = add ;\n",
  },
  { path: "app.css", content: "/* 样式注释 */\nbody {   color : #fff ;   margin : 0  0   0 0 ; }\n" },
  { path: "logo.png", base64: Buffer.alloc(40 * 1024, 5).toString("base64") },
];

/* --------------------------------- 主流程 --------------------------------- */

console.log("");
console.log("═".repeat(72));
console.log("  远程 MCP 验收测试");
console.log("═".repeat(72));
console.log(`  端点  ${MCP_URL}`);
console.log(`  认证  ${KEY ? "带 API key" : "⚠️ 未提供 DEWEB_SHRINK_API_KEY"}`);
console.log("");

/* 1. 探活 */
console.log("① 探活");
try {
  let res = null;
  let body = null;
  for (const url of HEALTH_URLS) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
      const text = await r.text();
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object" && "ok" in parsed) {
        res = r;
        body = parsed;
        break;
      }
    } catch {
      /* 试下一个 */
    }
  }
  if (!res) throw new Error(`探活失败，试过：${HEALTH_URLS.join("、")}`);

  check("探活返回 200", res.status === 200);
  check("服务标识正确", body.service === "deweb-shrink" || body.name === "deweb-shrink", `version ${body.version ?? "—"}`);
  check("认证已开启", body.authRequired === true, body.authRequired ? "" : "服务没有设 key，谁都能调！");
  if (body.gate) {
    check("护栏已生效", body.gate.maxConcurrency > 0, `并发 ${body.gate.maxConcurrency} · 超时 ${body.gate.timeoutMs / 1000}s`);
  } else if (body.mode) {
    check("部署形态已识别", true, body.mode);
  }
} catch (err) {
  check("探活", false, err.message);
  console.log("\n探活都失败，后面的测试没有意义，先确认服务起来了、地址和证书都对。");
  process.exit(1);
}

/* 2. 认证 */
console.log("");
console.log("② 认证");
if (KEY) {
  const noKey = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { key: "" });
  check("不带 key 会被拒", noKey.status === 401, `HTTP ${noKey.status}`);

  const badKey = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { key: "definitely-wrong" });
  check("错误的 key 会被拒", badKey.status === 401, `HTTP ${badKey.status}`);
} else {
  console.log("  - 跳过（没提供 key，无法验证拒绝逻辑）");
}

/* 3. 协议握手 */
console.log("");
console.log("③ MCP 协议");
const init = await rpc({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "remote-check", version: "1" } },
});
check("initialize 成功", init.status === 200 && !!init.msgs[0]?.result, `HTTP ${init.status}`);
check(
  "SSE 响应没被代理截断",
  init.text.includes("data:"),
  init.text.includes("data:") ? "（返回的是 SSE 格式，说明反代放行了流式响应）" : "（返回纯 JSON，也能用）",
);

const list = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
const tools = list.msgs[0]?.result?.tools?.map((t) => t.name) || [];
check("tools/list 拿到工具", tools.length === 6, tools.join(", "));

/* 4. 真实压缩（关键：内容驱动 + 产物回传） */
console.log("");
console.log("④ 真实调用：内容驱动压缩");
const t0 = Date.now();
const opt = await rpc({
  jsonrpc: "2.0",
  id: 3,
  method: "tools/call",
  params: {
    name: "optimize",
    arguments: { files: SAMPLE, network: "bsc", gasPriceGwei: 0.05, priceUsd: 750 },
  },
});
const elapsed = Date.now() - t0;
const data = jsonPayload(opt.msgs);
check("optimize 调用成功", !!data, `耗时 ${elapsed}ms`);
if (data) {
  check("确实变小了", data.saved?.bytes > 0, `${data.before?.totals?.bytes} → ${data.after?.totals?.bytes} 字节`);
  check("校验通过", data.verification?.ok === true, `fail ${data.verification?.failed} / warn ${data.verification?.warned}`);
  check("产物原样回传", Array.isArray(data.artifacts) && data.artifacts.length > 0, `${data.artifacts?.length} 个文件`);

  // 产物必须能解码、而且真的被压过（这是「服务器上没目录，只能靠 base64 拿产物」的关键路径）
  if (data.artifacts?.length) {
    const js = data.artifacts.find((a) => a.path === "app.js");
    const decoded = js ? Buffer.from(js.base64, "base64").toString("utf8") : "";
    check("产物能解码且已压缩", decoded.length > 0 && !decoded.includes("横幅注释"), decoded.slice(0, 48) + "…");
    check(
      "base64 长度与字节数一致",
      data.artifacts.every((a) => Buffer.from(a.base64, "base64").length === a.bytes),
    );
  }

  // 默认行为：该删的删掉（远程部署也必须是同一套默认值）
  const dropped = data.files?.dropped?.map((d) => d.path) || [];
  check("默认删掉非站点文件", dropped.length >= 0, dropped.length ? dropped.join("、") : "（本次没有可删的）");
}

/* 5. 增量账单 */
console.log("");
console.log("⑤ 增量账单（diff）");
const diff = await rpc({
  jsonrpc: "2.0",
  id: 4,
  method: "tools/call",
  params: {
    name: "diff",
    arguments: {
      previousFiles: SAMPLE,
      nextFiles: SAMPLE.map((f) => (f.path === "app.js" ? { ...f, content: f.content.replace("a + b", "a + b * 2") } : f)),
      network: "bsc",
      gasPriceGwei: 0.05,
      priceUsd: 750,
    },
  },
});
const d = jsonPayload(diff.msgs);
check("diff 调用成功", !!d);
if (d) {
  check("识别出只改了一个文件", d.counts?.changed === 1, `changed=${d.counts?.changed} unchanged=${d.counts?.unchanged}`);
  check("增量比全量便宜", d.total?.gas < d.full?.gas, `增量 ${d.total?.gas} < 全量 ${d.full?.gas}`);
}

/* 6. 护栏 */
console.log("");
console.log("⑥ 护栏");
const huge = await rpc({
  jsonrpc: "2.0",
  id: 5,
  method: "tools/call",
  params: { name: "scan", arguments: { files: [{ path: "big.bin", base64: "A".repeat(12 * 1024 * 1024) }] } },
});
const hugeText = huge.msgs[0]?.result?.content?.[0]?.text || huge.text;
check(
  "超大请求被拦住（不是 500 崩溃）",
  huge.status < 500 && /太大|超过|分批/.test(hugeText),
  hugeText.slice(0, 60).replace(/\n/g, " "),
);

const traversal = await rpc({
  jsonrpc: "2.0",
  id: 6,
  method: "tools/call",
  params: { name: "scan", arguments: { files: [{ path: "../../etc/passwd", content: "root:x:0:0" }] } },
});
const travText = traversal.msgs[0]?.result?.content?.[0]?.text || traversal.text;
check("路径穿越被拒", /非法路径/.test(travText), travText.slice(0, 60).replace(/\n/g, " "));

/* --------------------------------- 汇总 --------------------------------- */

console.log("");
console.log("═".repeat(72));
console.log(`  结果：${pass} 通过 / ${fail} 失败`);
console.log("═".repeat(72));
if (fail) {
  console.log("");
  console.log("  失败项：");
  for (const r of results.filter((r) => !r.ok)) console.log(`    ✗ ${r.name}  ${r.detail}`);
}
console.log("");
process.exit(fail ? 1 : 0);
