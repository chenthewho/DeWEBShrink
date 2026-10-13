#!/usr/bin/env node
/* ==========================================================================
   PoC 本地静态服务器
   --------------------------------------------------------------------------
   浏览器要求 .wasm 用 application/wasm 提供（否则 instantiateStreaming 会拒绝），
   所以这里顺手把 MIME 表配对。

   用法：
     node poc/serve.mjs                 # 起在 5180，服务 poc/web（含 dist）
     node poc/serve.mjs --port 5200
     POC_TEST=1 node poc/serve.mjs      # 额外开放 /__fixtures.json 与 /__result（无头测试用）
   ========================================================================== */

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const POC = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(POC, "..");
const WEB = path.join(POC, "web");
const FIXTURES = path.join(ROOT, "fixtures");
/** 示例站点：demo 页面的「一键试用」按钮读它（只读，21 个文件 / 812 KB）。 */
const DEMO_SITE = path.join(FIXTURES, "07-real-site");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

const TEST_MODE = process.env.POC_TEST === "1";
let testResult = null;
let testResolve = null;
/** 测试模式下的现场记录：请求过哪些路径、页面走到哪一步（失败时用来定位）。 */
const testState = { requests: [], stages: [] };

function safeJoin(base, rel) {
  const abs = path.resolve(base, rel.replace(/^\/+/, ""));
  return abs.startsWith(base) ? abs : null;
}

async function listFixtures(dir, prefix = "") {
  const out = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listFixtures(path.join(dir, e.name), rel)));
    else out.push(rel);
  }
  return out;
}

export function createPocServer(options = {}) {
  /* 测试口子用**显式参数**开，不看 env —— 踩过的坑：以前读 process.env.POC_TEST，
     而 ESM 的 import 是提升的，调用方在 import 之后才设 env，于是口子根本没开，
     页面 POST /__result 打到静态路由上 404，对拍脚本干等到超时。 */
  const testMode = options.test ?? process.env.POC_TEST === "1";
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    const send = (code, body, type = "text/plain; charset=utf-8") => {
      res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
      res.end(body);
    };

    /* ---- 示例站点：让 demo 页面不用选目录就能试 ---- */
    if (url.pathname === "/demo-site.json") {
      const files = await listFixtures(DEMO_SITE);
      return send(200, JSON.stringify({ dir: "07-real-site", files }), MIME[".json"]);
    }
    if (url.pathname.startsWith("/demo-site/")) {
      const abs = safeJoin(DEMO_SITE, decodeURIComponent(url.pathname.slice("/demo-site/".length)));
      if (!abs) return send(403, "forbidden");
      try {
        return send(200, await fs.readFile(abs), MIME[path.extname(abs)] || "application/octet-stream");
      } catch {
        return send(404, "not found");
      }
    }

    /* 请求日志与测试口子分开：日志永远记（排查用），口子只在 POC_TEST=1 时开。
       踩过的坑：以前日志也挂在 TEST_MODE 上，结果 test-headless 里看到「服务器没收到请求」，
       实际是日志没开，白查了半天。 */
    testState.requests.push(`${req.method} ${url.pathname}`);
    if (testMode && url.pathname === "/__stage" && req.method === "POST") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      try {
        testState.stages.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        /* 忽略坏 JSON */
      }
      return send(200, "ok");
    }
    if (testMode && url.pathname === "/__result" && req.method === "POST") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      testResult = Buffer.concat(chunks).toString("utf8");
      testResolve?.(testResult);
      return send(200, "ok");
    }
    const rel = url.pathname === "/" ? "/index.html" : url.pathname;
    const abs = safeJoin(WEB, rel);
    if (!abs) return send(403, "forbidden");
    try {
      const buf = await fs.readFile(abs);
      return send(200, buf, MIME[path.extname(abs)] || "application/octet-stream");
    } catch {
      return send(404, `not found: ${rel}`);
    }
  });

  return {
    server,
    /** 测试现场（页面走到哪一步、请求过什么）。 */
    getTestState: () => testState,
    /** 等无头页面把结果 POST 回来。 */
    waitForResult(timeoutMs = 120000) {
      if (testResult) return Promise.resolve(testResult);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`等页面回传结果超时（${timeoutMs}ms）`)), timeoutMs);
        testResolve = (v) => {
          clearTimeout(timer);
          resolve(v);
        };
      });
    },
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const portArg = process.argv.find((a) => a.startsWith("--port="));
  /* 默认 5233：5180 常被别的 vite dev server 占着（本项目自己也开过），别再撞。
     --port=0 交给系统挑，日志里打印**实际**端口（以前会傻傻打印 0）。 */
  const wanted = Number(portArg?.split("=")[1] ?? process.env.PORT ?? 5233);
  const { server } = createPocServer();
  server.listen(wanted, "127.0.0.1", () => {
    const actual = server.address().port;
    console.log(`DeWEBShrink PoC  →  http://127.0.0.1:${actual}/`);
    console.log(`  静态目录  poc/web（含构建产物 dist/）`);
    console.log(`  示例站点  /demo-site.json · /demo-site/<path>（fixtures/07-real-site）`);
    if (TEST_MODE) console.log("  测试口子   /__fixtures.json · /__result（仅 POC_TEST=1）");
  });
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(`端口 ${wanted} 已被占用。换一个：PORT=5234 node poc/serve.mjs`);
    } else {
      console.error(`启动失败：${err.message}`);
    }
    process.exit(1);
  });
}
