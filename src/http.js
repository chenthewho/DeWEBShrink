#!/usr/bin/env node
/* ==========================================================================
   deweb-shrink · MCP over Streamable HTTP（服务器部署形态）
   --------------------------------------------------------------------------
   本地用 stdio 就够了，但服务器上不行：stdio 要求客户端把这个进程当子进程拉起来，
   而你要的是「部署一次，别人连过来用」。所以这里是 HTTP 入口：

     POST /mcp      MCP Streamable HTTP（无状态模式）
     GET  /health   探活，不需要 API key

   三件事和本地形态不同，都是服务器部署必须的：

     1. **内容驱动**：没有用户那个目录，文件由 agent 放在 files 参数里传进来；
     2. **API key**：`x-api-key` 或 `Authorization: Bearer`。没设 key 时服务照常起来，
        但会打一条显眼的警告 —— 公开服务不设 key 等于把 CPU 送人；
     3. **护栏**：体积上限、并发闸门、超时。理由见 limits.js。

   无状态模式（sessionIdGenerator: undefined）：每个请求造一份新的 server + transport。
   这个工具本来就是纯函数（文件内容进、压缩结果出），不需要跨请求的会话状态 ——
   无状态也顺便让它能水平扩多实例。

   配置既可以走环境变量，也可以走 createHttpServer 的参数（测试用后者）。
   ========================================================================== */

"use strict";

import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { createTapeShrinkServer } from "./index.js";
import { SERVER_LIMITS, createGate } from "./limits.js";

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** 从 header 里取 key：支持 x-api-key，也支持 Authorization: Bearer。 */
export function extractKey(headers) {
  const direct = headers["x-api-key"];
  if (typeof direct === "string" && direct) return direct;
  const auth = headers["authorization"];
  if (typeof auth === "string" && /^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, "").trim();
  return "";
}

/** 常量时间比较，别用 === 泄漏长度/前缀信息。 */
export function keyMatches(given, apiKey) {
  if (!apiKey) return true;
  if (!given) return false;
  const a = Buffer.from(given, "utf8");
  const b = Buffer.from(apiKey, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * 造一个 HTTP 服务（不 listen）。测试可以直接拿它 + listen(0) 要一个随机端口。
 * @returns {{server: import("node:http").Server, gate: object, config: object}}
 */
export function createHttpServer(options = {}) {
  const config = {
    mcpPath: options.mcpPath ?? process.env.DEWEB_SHRINK_MCP_PATH ?? "/mcp",
    apiKey: options.apiKey ?? process.env.DEWEB_SHRINK_API_KEY ?? "",
    corsOrigin: options.corsOrigin ?? process.env.DEWEB_SHRINK_CORS ?? "*",
    /** 请求体上限：比内容上限再放宽一点，给 JSON 外壳和 base64 膨胀留余量 */
    maxBodyBytes: options.maxBodyBytes ?? envInt("DEWEB_SHRINK_MAX_BODY", 16 * 1024 * 1024),
    quiet: options.quiet ?? false,
  };
  const gate =
    options.gate ??
    createGate({
      maxConcurrency: SERVER_LIMITS.maxConcurrency,
      timeoutMs: SERVER_LIMITS.timeoutMs,
    });

  const log = (...args) => {
    if (!config.quiet) console.log(...args);
  };

  function sendJson(res, status, payload) {
    if (res.headersSent) return;
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
    });
    res.end(body);
  }

  function applyCors(res) {
    res.setHeader("Access-Control-Allow-Origin", config.corsOrigin);
    res.setHeader(
      "Access-Control-Allow-Headers",
      "content-type, x-api-key, authorization, mcp-session-id, mcp-protocol-version, last-event-id",
    );
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
    res.setHeader("Access-Control-Expose-Headers", "mcp-session-id, mcp-protocol-version");
    res.setHeader("Vary", "Origin");
  }

  /** 读完请求体，超限就抛（别让一个大 body 把内存吃光）。 */
  async function readBody(req, limit) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) {
        const err = new Error(`请求体超过 ${(limit / 1024 / 1024).toFixed(0)} MB`);
        err.statusCode = 413;
        throw err;
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  const server = createServer(async (req, res) => {
    const startedAt = Date.now();
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    applyCors(res);

    const finish = (status) => {
      const ms = Date.now() - startedAt;
      // key 状态只在 MCP 端点上标注：/health 本来就不需要 key，标了只会误导
      const keyTag =
        url.pathname === config.mcpPath && config.apiKey
          ? keyMatches(extractKey(req.headers), config.apiKey)
            ? " [key ok]"
            : " [key bad]"
          : "";
      log(`${new Date().toISOString()} ${req.method} ${url.pathname} → ${status} ${ms}ms${keyTag}`);
    };

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return finish(204);
    }

    // 探活：刻意不要求 key，方便负载均衡/容器编排探活
    if (url.pathname === "/health") {
      sendJson(res, 200, {
        ok: true,
        name: "deweb-shrink",
        version: "0.3.0",
        authRequired: !!config.apiKey,
        gate: gate.stats,
        limits: {
          ...SERVER_LIMITS,
          maxRequestBytes: SERVER_LIMITS.maxRequestBytes,
          maxBodyBytes: config.maxBodyBytes,
        },
        uptimeSec: Math.round(process.uptime()),
      });
      return finish(200);
    }

    if (url.pathname !== config.mcpPath) {
      sendJson(res, 404, { error: "not found", hint: `MCP 端点是 ${config.mcpPath}，探活是 /health` });
      return finish(404);
    }

    // 认证放最前面：不认识的人不该有机会让我们读 body
    if (!keyMatches(extractKey(req.headers), config.apiKey)) {
      sendJson(res, 401, {
        error: "unauthorized",
        hint: "请在 x-api-key 头里带上 key，或用 Authorization: Bearer <key>",
      });
      return finish(401);
    }

    if (req.method !== "POST") {
      // 无状态模式不提供 SSE 长连接，GET/DELETE 没有意义
      sendJson(res, 405, { error: "method not allowed", hint: "这个端点只接受 POST（无状态模式不用会话）" });
      return finish(405);
    }

    let body;
    try {
      const raw = await readBody(req, config.maxBodyBytes);
      body = raw.length ? JSON.parse(raw.toString("utf8")) : undefined;
    } catch (err) {
      sendJson(res, err.statusCode || 400, { error: "bad request", detail: err.message });
      return finish(err.statusCode || 400);
    }

    res.on("finish", () => finish(res.statusCode || 200));

    try {
      await gate.run(async () => {
        const mcp = createTapeShrinkServer();
        const transport = new StreamableHTTPServerTransport({
          // 无状态：不生成 session id，也不做会话校验
          sessionIdGenerator: undefined,
        });

        const cleanup = () => {
          transport.close?.().catch?.(() => {});
          mcp.close?.().catch?.(() => {});
        };
        res.on("close", cleanup);

        await mcp.connect(transport);
        await transport.handleRequest(req, res, body);
      });
    } catch (err) {
      // 超时或护栏拒绝：闸门一定会释放槽位，这里只负责回一个能看懂的错误
      const isTimeout = /超过 \d+ 秒/.test(err.message || "");
      sendJson(res, isTimeout ? 504 : 500, {
        error: isTimeout ? "timeout" : "internal error",
        detail: err.message,
        gate: gate.stats,
      });
    }
  });

  return { server, gate, config };
}

/** 起服务并打印启动信息。 */
export function startHttpServer(options = {}) {
  const { server, gate, config } = createHttpServer(options);

  /* Unix domain socket 模式。
     为什么需要它：共享主机（SiteGround 这类）在 seccomp 层面禁掉了 TCP listen
     （`listen EPERM`），连 127.0.0.1 都不许 —— 但 **Unix socket 没被禁**。
     所以在这种机器上，唯一能让常驻进程对外提供服务的方式就是挂在 socket 上，
     再由同机的 PHP / nginx 转发。 */
  const socketPath = options.socketPath ?? process.env.DEWEB_SHRINK_SOCKET ?? null;

  if (socketPath) {
    // 残留的 socket 文件会让 listen 报 EADDRINUSE，先清掉
    try {
      fs.unlinkSync(socketPath);
    } catch {
      /* 本来就不存在 */
    }
    fs.mkdirSync(path.dirname(socketPath), { recursive: true });

    server.listen(socketPath, () => {
      // 让同机其它进程（PHP-FPM 跑在别的用户下）也能连
      try {
        fs.chmodSync(socketPath, 0o777);
      } catch {
        /* 改不了就算了，同用户下照样能用 */
      }
      console.log("deweb-shrink · MCP over Unix socket");
      console.log(`  socket     ${socketPath}`);
      console.log(`  MCP 端点   http://localhost${config.mcpPath}（经 socket）`);
      console.log(
        `  认证       ${config.apiKey ? "已开启（x-api-key 或 Authorization: Bearer）" : "⚠️  未设置 DEWEB_SHRINK_API_KEY"}`,
      );
      console.log(`  护栏       并发 ${gate.stats.maxConcurrency} · 超时 ${gate.stats.timeoutMs / 1000}s`);
    });
    server.on("error", (err) => {
      console.error(`socket 监听失败：${err.message}`);
      process.exit(1);
    });

    return { server, gate, config, socketPath };
  }

  const PORT = options.port ?? envInt("PORT", 8787);
  const HOST = options.host ?? process.env.HOST ?? "0.0.0.0";

  server.listen(PORT, HOST, () => {
    const actual = server.address();
    const port = typeof actual === "object" && actual ? actual.port : PORT;
    const base = `http://${HOST === "0.0.0.0" ? "127.0.0.1" : HOST}:${port}`;
    console.log("deweb-shrink · MCP over Streamable HTTP");
    console.log(`  MCP 端点   ${base}${config.mcpPath}`);
    console.log(`  探活       ${base}/health`);
    console.log(
      `  认证       ${
        config.apiKey
          ? "已开启（x-api-key 或 Authorization: Bearer）"
          : "⚠️  未设置 DEWEB_SHRINK_API_KEY —— 任何人都能调用这个服务，公开部署前请务必设置"
      }`,
    );
    console.log(
      `  护栏       并发 ${gate.stats.maxConcurrency} · 超时 ${gate.stats.timeoutMs / 1000}s · ` +
        `单次内容上限 ${(SERVER_LIMITS.maxRequestBytes / 1024 / 1024).toFixed(0)} MB · ` +
        `请求体上限 ${(config.maxBodyBytes / 1024 / 1024).toFixed(0)} MB`,
    );
  });

  return { server, gate, config, socketPath: null };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const { server } = startHttpServer();
  /* 优雅退出：容器编排发 SIGTERM 时别把在跑的请求直接砍掉 */
  for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, () => {
      console.log(`\n收到 ${sig}，停止接收新请求…`);
      server.close(() => process.exit(0));
      // 兜底：10 秒还没关干净就强退
      setTimeout(() => process.exit(0), 10_000).unref();
    });
  }
}
