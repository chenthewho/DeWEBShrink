#!/usr/bin/env node
/* ==========================================================================
   serve.mjs —— 站点本地服务器
   --------------------------------------------------------------------------
   静态目录就是 web/，另外挂三个只读口子（都不出仓库）：

     /demo-site.json · /demo-site/<path>   示例站点（fixtures/07-real-site），
                                           页面上的「试用示例站点」按钮读它
     /docs/<file>                         仓库 docs/ 下的文档（页脚与导航的链接）
     /README.md                           项目 README

   .wasm 必须用 application/wasm 提供，否则 instantiateStreaming 会拒绝。

   用法：node web/serve.mjs [--port=5240]
   ========================================================================== */

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const WEB = HERE;
const DEMO = path.join(ROOT, "fixtures/07-real-site");
const DOCS = path.join(ROOT, "docs");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

const safeJoin = (base, rel) => {
  const abs = path.resolve(base, rel.replace(/^\/+/, ""));
  return abs === base || abs.startsWith(base + path.sep) ? abs : null;
};

async function listFiles(dir, prefix = "") {
  const out = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listFiles(path.join(dir, e.name), rel)));
    else out.push(rel);
  }
  return out;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  const send = (code, body, type = "text/plain; charset=utf-8") => {
    res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
    res.end(body);
  };
  const sendFile = async (abs, fallback = "application/octet-stream") => {
    try {
      const buf = await fs.readFile(abs);
      return send(200, buf, MIME[path.extname(abs)] ?? fallback);
    } catch {
      return send(404, `not found: ${url.pathname}`);
    }
  };

  if (url.pathname === "/demo-site.json") {
    return send(200, JSON.stringify({ dir: "07-real-site", files: await listFiles(DEMO) }), MIME[".json"]);
  }
  if (url.pathname.startsWith("/demo-site/")) {
    const abs = safeJoin(DEMO, decodeURIComponent(url.pathname.slice("/demo-site/".length)));
    if (!abs) return send(403, "forbidden");
    return sendFile(abs);
  }
  if (url.pathname === "/README.md") return sendFile(path.join(ROOT, "README.md"));
  if (url.pathname.startsWith("/docs/")) {
    const abs = safeJoin(DOCS, decodeURIComponent(url.pathname.slice("/docs/".length)));
    if (!abs) return send(403, "forbidden");
    return sendFile(abs);
  }

  const rel = url.pathname === "/" ? "index.html" : url.pathname.endsWith("/") ? `${url.pathname}index.html` : url.pathname;
  const abs = safeJoin(WEB, rel);
  if (!abs) return send(403, "forbidden");
  return sendFile(abs);
});

const port = Number((process.argv.find((a) => a.startsWith("--port=")) || "").split("=")[1] ?? process.env.PORT ?? 5240);
server.listen(port, "127.0.0.1", () => {
  const actual = server.address().port;
  console.log(`DeWEBShrink 站点  →  http://127.0.0.1:${actual}/`);
  console.log(`  中文页 /            英文页 /en/`);
  console.log(`  示例站点 /demo-site.json（fixtures/07-real-site）`);
});
server.on("error", (err) => {
  console.error(err.code === "EADDRINUSE" ? `端口 ${port} 被占用，换一个：--port=5241` : `启动失败：${err.message}`);
  process.exit(1);
});
