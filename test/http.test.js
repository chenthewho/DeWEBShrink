/* ==========================================================================
   HTTP 形态的端到端测试
   --------------------------------------------------------------------------
   服务器部署的形态和本地 stdio 有本质区别，所以这些必须真跑一遍 HTTP：
     · 认证：没 key 不能进，key 不对不能进，两种 header 写法都要认；
     · 路由：/health 探活不设卡，未知路径 404，GET /mcp 405（无状态模式没有 SSE 长连接）；
     · 工具：真的通过 HTTP 调一次压缩，产物要以 base64 回来 ——
       服务器上没有目录，agent 只能靠这份 base64 拿到压缩结果。

   每个用例都自己 listen(0) 要一个随机端口，跑完关掉，不依赖外部服务。
   ========================================================================== */

"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";

import { createHttpServer } from "../src/http.js";

const KEY = "test-key-123";

/** 起一个临时服务，跑完一定关掉（含 keep-alive 连接，否则 close 会挂着）。 */
async function withServer(fn, options = {}) {
  const { server } = createHttpServer({ apiKey: KEY, quiet: true, ...options });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    return await fn(base);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
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
      /* 忽略半截行 */
    }
  }
  if (msgs.length) return msgs;
  try {
    return [JSON.parse(text)];
  } catch {
    return [];
  }
}

async function rpc(base, payload, { key = KEY, headers = {} } = {}) {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(key ? { "x-api-key": key } : {}),
      ...headers,
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  return { status: res.status, msgs: parseRpc(text), text };
}

/** 取工具调用返回的 JSON 尾巴（报告之后那段）。 */
function jsonPayload(msgs) {
  const content = msgs[0]?.result?.content || [];
  for (const c of content) {
    if (typeof c.text === "string" && c.text.includes("--- JSON ---")) {
      return JSON.parse(c.text.split("--- JSON ---")[1]);
    }
  }
  return null;
}

const SAMPLE = [
  { path: "index.html", content: '<!doctype html>\n<html><head><link rel="stylesheet" href="app.css"></head><body>\n  <h1>  Hi  </h1>\n  <!-- drop -->\n  <script src="app.js"></script>\n</body></html>\n' },
  { path: "app.js", content: "/* banner */\nfunction add(a,b){ return a+b; }\nwindow.add = add;\n" },
  { path: "app.css", content: "/* c */\nbody {  color : #fff ;  margin : 0 0 0 0 ; }\n" },
];

/* --------------------------------- 探活 --------------------------------- */

test("/health 不需要 key，并如实报告护栏与认证状态", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.authRequired, true);
    assert.ok(body.limits.maxRequestBytes > 0);
    assert.equal(typeof body.gate.maxConcurrency, "number");
  });
});

test("未设 key 时 authRequired 为 false（但仍能跑）", async () => {
  await withServer(
    async (base) => {
      const body = await (await fetch(`${base}/health`)).json();
      assert.equal(body.authRequired, false);
    },
    { apiKey: "" },
  );
});

/* --------------------------------- 认证 --------------------------------- */

test("没有 key：401，且不读 body", async () => {
  await withServer(async (base) => {
    const r = await rpc(base, { jsonrpc: "2.0", id: 1, method: "tools/list" }, { key: "" });
    assert.equal(r.status, 401);
    assert.match(r.text, /unauthorized/);
  });
});

test("key 不对：401", async () => {
  await withServer(async (base) => {
    const r = await rpc(base, { jsonrpc: "2.0", id: 1, method: "tools/list" }, { key: "wrong" });
    assert.equal(r.status, 401);
  });
});

test("Authorization: Bearer 写法也能认证", async () => {
  await withServer(async (base) => {
    const r = await rpc(base, { jsonrpc: "2.0", id: 1, method: "tools/list" }, {
      key: "",
      headers: { authorization: `Bearer ${KEY}` },
    });
    assert.equal(r.status, 200);
    assert.ok(r.msgs[0]?.result?.tools?.length > 0);
  });
});

/* --------------------------------- 路由 --------------------------------- */

test("未知路径 404", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/nope`);
    assert.equal(res.status, 404);
  });
});

test("GET /mcp 405：无状态模式不提供 SSE 长连接", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/mcp`, { headers: { "x-api-key": KEY } });
    assert.equal(res.status, 405);
  });
});

test("非法 JSON 请求体 → 400", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": KEY },
      body: "{ this is not json",
    });
    assert.equal(res.status, 400);
  });
});

/* --------------------------------- 工具 --------------------------------- */

test("tools/list 列出全部六个工具", async () => {
  await withServer(async (base) => {
    const r = await rpc(base, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const names = r.msgs[0].result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "cost_model",
      "diff",
      "estimate",
      "optimize",
      "scan",
      "verify",
    ]);
  });
});

test("diff 走 HTTP：只改一个文件时，只按那一个文件算钱", async () => {
  await withServer(async (base) => {
    const previousFiles = SAMPLE;
    // 只改 app.js 里一个会活到产物的值
    const nextFiles = SAMPLE.map((f) =>
      f.path === "app.js" ? { ...f, content: f.content.replace("a+b", "a+b*2") } : f,
    );

    const r = await rpc(base, {
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: {
        name: "diff",
        arguments: { previousFiles, nextFiles, gasPriceGwei: 0.05, priceUsd: 750, network: "bsc" },
      },
    });

    const data = jsonPayload(r.msgs);
    assert.ok(data, "要有 JSON 尾巴");
    assert.equal(data.firstDeploy, false);
    assert.equal(data.counts.added, 0);
    assert.ok(data.counts.unchanged >= 2, "没改的文件要算成「跳过」");
    assert.ok(data.upload.bytes < data.full.bytes, "增量必须小于全量");
    assert.equal(data.savedVsFull.gas, data.full.gas - data.total.gas);
  });
});

test("diff 不给 previous = 首次部署，等于全量", async () => {
  await withServer(async (base) => {
    const r = await rpc(base, {
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: { name: "diff", arguments: { nextFiles: SAMPLE, gasPriceGwei: 0.05, priceUsd: 750 } },
    });
    const data = jsonPayload(r.msgs);
    assert.equal(data.firstDeploy, true);
    assert.equal(data.total.gas, data.full.gas);
  });
});

test("estimate 走 HTTP 能算钱", async () => {
  await withServer(async (base) => {
    const r = await rpc(base, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "estimate", arguments: { bytes: 1024 * 1024, gasPriceGwei: 0.05, priceUsd: 750 } },
    });
    const data = jsonPayload(r.msgs);
    assert.ok(data, "要有 JSON 尾巴");
    assert.equal(data.gas.bytes, 1024 * 1024);
    assert.ok(data.cost.usd > 0);
  });
});

test("scan 接 files（内容驱动），不依赖服务器上有那个目录", async () => {
  await withServer(async (base) => {
    const r = await rpc(base, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "scan", arguments: { files: SAMPLE, gasPriceGwei: 0.05, priceUsd: 750 } },
    });
    const data = jsonPayload(r.msgs);
    assert.equal(data.totals.billableFiles, 3);
    assert.ok(data.totals.bytes > 0);
  });
});

test("optimize 接 files：产物以 base64 回来，并带校验结论", async () => {
  await withServer(async (base) => {
    const r = await rpc(base, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "optimize",
        arguments: { files: SAMPLE, gasPriceGwei: 0.05, priceUsd: 750, network: "bsc" },
      },
    });
    const data = jsonPayload(r.msgs);
    assert.ok(data, "要有 JSON 尾巴");
    assert.equal(data.out, null, "内存模式不该有产物目录");
    assert.ok(data.saved.bytes > 0, "总字节要变小");
    assert.equal(data.verification.ok, true, `校验不该失败：${JSON.stringify(data.verification.checks?.filter((c) => c.status === "fail"))}`);

    // 关键：服务器上没有目录，agent 只能靠 artifacts 拿到压缩后的文件
    assert.equal(data.artifacts.length, 3);
    for (const a of data.artifacts) {
      const bytes = Buffer.from(a.base64, "base64");
      assert.equal(bytes.length, a.bytes, `${a.path} 的 base64 长度要对得上`);
    }
    const js = data.artifacts.find((a) => a.path === "app.js");
    assert.ok(Buffer.from(js.base64, "base64").toString("utf8").length < 82, "app.js 要被压小");
  });
});

test("verify 接 files，能对拍两份内容", async () => {
  await withServer(async (base) => {
    const r = await rpc(base, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "verify",
        arguments: { files: SAMPLE, referenceFiles: SAMPLE, gasPriceGwei: 0.05, priceUsd: 750 },
      },
    });
    const data = jsonPayload(r.msgs);
    assert.equal(data.ok, true);
    assert.ok(data.checks.some((c) => c.name === "入口 index.html"));
  });
});

test("路径穿越通过 HTTP 传进来也会被拒（错误以工具结果返回，不是 500）", async () => {
  await withServer(async (base) => {
    const r = await rpc(base, {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "scan", arguments: { files: [{ path: "../../etc/passwd", content: "x" }] } },
    });
    assert.equal(r.status, 200, "工具级错误不该变成 HTTP 500");
    const content = r.msgs[0].result.content[0].text;
    assert.match(content, /非法路径/);
  });
});

test("空参数不报「缺少输入」就等于在扫服务器自己的目录（回归：曾经回退到 process.cwd）", async () => {
  await withServer(async (base) => {
    for (const [id, name] of [
      [7, "scan"],
      [8, "optimize"],
      [9, "verify"],
      [10, "diff"],
    ]) {
      const r = await rpc(base, {
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: { gasPriceGwei: 0.05, priceUsd: 750 } },
      });
      assert.equal(r.status, 200, `${name}：工具级错误不该变成 HTTP 500`);
      const content = r.msgs[0].result.content[0].text;
      assert.match(content, /缺少输入/, `${name} 空参数必须明确报错`);
    }
  });
});

test("files: [] 也算空输入（空批次不是「整个磁盘」的意思）", async () => {
  await withServer(async (base) => {
    const r = await rpc(base, {
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: { name: "scan", arguments: { files: [], gasPriceGwei: 0.05, priceUsd: 750 } },
    });
    assert.equal(r.status, 200);
    assert.match(r.msgs[0].result.content[0].text, /缺少输入/);
  });
});

test("并发请求互不干扰（无状态模式每请求一套 server）", async () => {
  await withServer(async (base) => {
    const jobs = Array.from({ length: 6 }, (_, i) =>
      rpc(base, {
        jsonrpc: "2.0",
        id: 100 + i,
        method: "tools/call",
        params: {
          name: "optimize",
          arguments: { files: SAMPLE, gasPriceGwei: 0.05, priceUsd: 750, network: "bsc" },
        },
      }),
    );
    const results = await Promise.all(jobs);
    for (const r of results) {
      const data = jsonPayload(r.msgs);
      assert.equal(data.artifacts.length, 3, "每个请求都要拿到自己那份完整产物");
    }
  });
});
