/* ==========================================================================
   内存文件源 —— 服务器部署形态的回归测试
   --------------------------------------------------------------------------
   为什么单独测这一组：
     MCP 跑在服务器上时，agent 把文件内容当参数传进来，服务器上**没有**那个目录。
     所以「内存进、内存出」不是可选优化，而是这个工具能不能部署的前提。
     这里盯住三件事：
       1. 内存源真的能跑完整条流水线（压 → 算账 → 校验 → 把产物带回来）；
       2. 外部输入被严格校验（路径穿越、重复路径、缺内容都要明确报错，不静默）；
       3. 内存模式与本地目录模式**产物字节完全一致** —— 保证两条路走的是同一套逻辑，
          不会出现「本地压得对、服务器上压坏了」这种最难查的分裂。
   ========================================================================== */

"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { optimizeSite } from "../src/optimize/index.js";
import { scanSite } from "../src/scan.js";
import { verifyOutput } from "../src/verify.js";
import { createFsSource, createMemorySink, createMemorySource } from "../src/source.js";

const HTML = `<!doctype html>
<html><head>
  <meta charset="utf-8">
  <link rel="stylesheet" href="app.css">
</head><body>
  <h1>   Hello   </h1>
  <!-- 这段注释应该被压掉 -->
  <script src="app.js"></script>
</body></html>
`;

const JS = `/* 一段很长的横幅注释，压缩后应该消失 */
function  add ( a , b ) {
  return a + b ;
}
window.add = add ;
`;

const CSS = `/* 注释 */
body {   color : #fff ;   margin : 0  0   0 0 ; }
`;

/** 固定 gas 与币价，让账目可复现（不然测试会去联网取价）。 */
const FIXED = { network: "bsc", gasPriceGwei: 0.05, priceUsd: 750 };

function sampleFiles() {
  return [
    { path: "index.html", content: HTML },
    { path: "app.js", content: JS },
    { path: "app.css", content: CSS },
  ];
}

async function makeTempSite() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "deweb-shrink-mem-"));
  await fs.mkdir(path.join(root, "site"), { recursive: true });
  for (const f of sampleFiles()) {
    await fs.writeFile(path.join(root, "site", f.path), f.content, "utf8");
  }
  return root;
}

test("内存源能跑完整条流水线：压 → 算账 → 校验 → 产物带回", async () => {
  const sink = createMemorySink();
  const result = await optimizeSite({ source: createMemorySource(sampleFiles()), sink, ...FIXED });

  assert.equal(result.files.written, 3, "三个文件都要写出");
  assert.ok(result.saved.bytes > 0, "总字节必须变小");
  assert.ok(result.saved.bytesPct > 0 && result.saved.bytesPct < 100, "省下的比例要在合理区间");

  // 产物必须原样带回（服务器上没有目录可读，agent 只能靠这份 base64 去发布）
  assert.equal(result.artifacts.length, 3);
  for (const a of result.artifacts) {
    assert.equal(typeof a.base64, "string");
    assert.equal(Buffer.from(a.base64, "base64").length, a.bytes, `${a.path} 的 base64 长度要跟 bytes 对得上`);
  }

  // 产物里的 JS 必须真的被压小了，而且是合法 JS（校验里那条会兜住语法）
  const js = result.artifacts.find((a) => a.path === "app.js");
  assert.ok(js.bytes < Buffer.byteLength(JS, "utf8"), "app.js 必须变小");
  assert.ok(!Buffer.from(js.base64, "base64").toString("utf8").includes("横幅注释"), "注释要被压掉");
});

test("内存模式下校验会真跑，且结论是可以上链", async () => {
  const sink = createMemorySink();
  const result = await optimizeSite({ source: createMemorySource(sampleFiles()), sink, ...FIXED });
  assert.ok(result.verification, "默认要带校验结果");
  assert.equal(result.verification.ok, true, `校验不该失败：${JSON.stringify(result.verification.checks.filter((c) => c.status !== "pass"))}`);
  assert.equal(result.verification.failed, 0);
});

test("内存源与本地目录源的产物字节完全一致", async () => {
  const root = await makeTempSite();
  try {
    const memSink = createMemorySink();
    const mem = await optimizeSite({ source: createMemorySource(sampleFiles()), sink: memSink, ...FIXED });

    const fsResult = await optimizeSite({ dir: path.join(root, "site"), out: path.join(root, "out"), ...FIXED });

    const memByPath = new Map(mem.artifacts.map((a) => [a.path, a.base64]));
    const fsByPath = new Map(
      await Promise.all(
        fsResult.after.files.map(async (f) => [
          f.path,
          (await fs.readFile(path.join(root, "out", f.path))).toString("base64"),
        ]),
      ),
    );

    assert.deepEqual([...memByPath.keys()].sort(), [...fsByPath.keys()].sort(), "两条路的产物路径集合要一样");
    for (const [p, b64] of memByPath) {
      assert.equal(b64, fsByPath.get(p), `${p} 的字节在两种模式下必须完全一致`);
    }
    assert.equal(mem.saved.bytes, fsResult.saved.bytes, "省下的字节数也要一致");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("前导 / 会被归一化，等价于不带 / 的写法", async () => {
  const withSlash = createMemorySource([{ path: "/index.html", content: HTML }]);
  const without = createMemorySource([{ path: "index.html", content: HTML }]);
  const a = await scanSite(withSlash);
  const b = await scanSite(without);
  assert.deepEqual(a.files.map((f) => f.path), ["index.html"]);
  assert.deepEqual(a.files.map((f) => f.path), b.files.map((f) => f.path));
});

test("路径穿越会被明确拒绝，而不是被静默接受", () => {
  assert.throws(() => createMemorySource([{ path: "../secret.txt", content: "x" }]), /非法路径/);
  assert.throws(() => createMemorySource([{ path: "a/../../b.txt", content: "x" }]), /非法路径/);
  assert.throws(() => createMemorySource([{ path: "", content: "x" }]), /非法路径/);
});

test("重复路径直接报错，不静默取最后一个", () => {
  assert.throws(
    () => createMemorySource([{ path: "a.js", content: "1" }, { path: "a.js", content: "2" }]),
    /重复路径/,
  );
});

test("缺少内容的文件会被指出是哪个文件", () => {
  assert.throws(() => createMemorySource([{ path: "a.js" }]), /a\.js.*缺少内容/);
});

test("base64 二进制与 bytes 都能进内存源", async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const viaBase64 = createMemorySource([{ path: "a.png", base64: png.toString("base64") }]);
  const viaBytes = createMemorySource([{ path: "a.png", bytes: png }]);
  const [a, b] = await Promise.all([viaBase64.read("a.png"), viaBytes.read("a.png")]);
  assert.deepEqual(a, png);
  assert.deepEqual(b, png);
});

test("内存模式不会在磁盘上留下任何东西", async () => {
  // 把 TMPDIR 指到一个专属空目录，再看它是否仍然为空。
  // （原来是比较整个 os.tmpdir() 的前后差异 —— 那样会被**并发跑的其他测试**
  //  创建临时目录所干扰，是个不稳定的断言。指向专属目录才真正有证明力：
  //  如果 sharp / esbuild 或我们自己往临时目录写了什么，这里立刻会抓到。）
  const watch = await fs.mkdtemp(path.join(os.tmpdir(), "deweb-shrink-watch-"));
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = watch;
  try {
    const sink = createMemorySink();
    await optimizeSite({ source: createMemorySource(sampleFiles()), sink, ...FIXED });
    const left = await fs.readdir(watch);
    assert.deepEqual(left, [], `内存模式不该往临时目录写东西，实际留下了：${left.join("、")}`);
  } finally {
    if (saved === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = saved;
    await fs.rm(watch, { recursive: true, force: true });
  }
});

test("内存文件源可以直接交给 verifyOutput 做自洽检查", async () => {
  const sink = createMemorySink();
  const result = await optimizeSite({ source: createMemorySource(sampleFiles()), sink, ...FIXED });
  const outSource = createMemorySource(
    result.artifacts.map((a) => ({ path: a.path, base64: a.base64 })),
  );
  const check = await verifyOutput({ outputSource: outSource });
  assert.equal(check.ok, true, "产物自洽检查应当通过");
  assert.ok(check.checks.some((c) => c.name === "入口 index.html" && c.status === "pass"));
});

test("本地目录源仍按老样子工作（向后兼容）", async () => {
  const root = await makeTempSite();
  try {
    const scan = await scanSite(path.join(root, "site"));
    assert.equal(scan.billable.length, 3);
    assert.ok(scan.totals.bytes > 0);
    // 老接口：直接传字符串路径
    const viaFsSource = await scanSite(createFsSource(path.join(root, "site")));
    assert.equal(viaFsSource.totals.bytes, scan.totals.bytes);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
