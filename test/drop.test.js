/* ==========================================================================
   删文件策略的测试
   --------------------------------------------------------------------------
   默认删掉白花钱的文件，但**必须防住误删**。这里盯住两件事：

   1. 该删的删：README（不是站点资源）、没有任何引用的图（传上去没人取）。
   2. 不该删的一个都不能少 —— 特别是**约定文件**：robots.txt、favicon.ico、
      .well-known/… 它们靠约定路径被浏览器/爬虫自动请求，**天然没有 HTML 引用**。
      按「无引用」判会把它们删掉，而且删完页面照样打开，问题要到线上才暴露。

   最后一条测试是这次改动的核心：**CLI 和库必须给出一致的行为**。
   之前 CLI 写死了 `dropUnreferenced: !!flags[...]`，等于永远传 false 进来，
   把库里的默认值顶掉 —— 库改了、命令行没改，这种不一致最难查。
   ========================================================================== */

"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { decideDrops, isConventionFile, CONVENTION_FILES } from "../src/optimize/files.js";
import { optimizeSite, DEFAULT_OPTIONS } from "../src/optimize/index.js";
import { scanSite } from "../src/scan.js";
import { createMemorySink, createMemorySource } from "../src/source.js";

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "..", "src", "cli.js");
const PRICING = { network: "bsc", gasPriceGwei: 0.05, priceUsd: 750 };

/* --------------------------------- 素材 --------------------------------- */

const HTML = `<!doctype html>
<html><head><meta charset="utf-8"><link rel="stylesheet" href="app.css"></head>
<body><h1>删文件测试</h1><img src="used.png" alt="used"><script src="app.js"></script></body></html>
`;

function files() {
  return [
    { path: "index.html", content: HTML },
    { path: "app.css", content: "body { margin: 0; }\n" },
    { path: "app.js", content: "var a = 1;\n" },
    { path: "used.png", base64: Buffer.alloc(1024, 3).toString("base64") },
    /* 无引用：该删 */
    { path: "orphan.png", base64: Buffer.alloc(2048, 9).toString("base64") },
    /* 非站点资源：该删 */
    { path: "README.md", content: "# 说明\n" },
    { path: "app.js.map", content: '{"version":3}\n' },
  ];
}

async function runOptimize(extraFiles = [], options = {}) {
  const all = [...files(), ...extraFiles];
  const result = await optimizeSite({
    source: createMemorySource(all),
    sink: createMemorySink(),
    ...PRICING,
    options,
  });
  return result;
}

/* ------------------------------ 该删的删掉 ------------------------------ */

test("默认开：同时打开「删无引用」和「删非站点文件」", () => {
  assert.equal(DEFAULT_OPTIONS.dropUnreferenced, true, "默认应当删无引用文件");
  assert.equal(DEFAULT_OPTIONS.dropNonSiteFiles, true, "默认应当删非站点文件");
});

test("默认删掉：没有引用的文件 + 非站点资源", async () => {
  const r = await runOptimize();
  const dropped = r.files.dropped.map((d) => d.path).sort();
  assert.deepEqual(dropped, ["README.md", "app.js.map", "orphan.png"], `实际删了 ${dropped.join("、")}`);

  // 被引用的文件一个都不能少
  const written = r.after.files.map((f) => f.path).sort();
  for (const p of ["index.html", "app.css", "app.js", "used.png"]) {
    assert.ok(written.includes(p), `${p} 被引用了，不能删`);
  }
});

test("删掉的文件不再计费，账单确实变小", async () => {
  const kept = await runOptimize([], { dropUnreferenced: false, dropNonSiteFiles: false });
  const dropped = await runOptimize();
  assert.ok(
    dropped.after.totals.bytes < kept.after.totals.bytes,
    `删完应当更小：${dropped.after.totals.bytes} vs ${kept.after.totals.bytes}`,
  );
  assert.ok(dropped.after.totals.chunks <= kept.after.totals.chunks, "块数不该增加");
});

/* --------------------- 不该删的一个都不能少（约定文件） --------------------- */

test("约定文件被 isConventionFile 认出来", () => {
  for (const p of [
    "robots.txt",
    "sitemap.xml",
    "favicon.ico",
    "browserconfig.xml",
    "humans.txt",
    "security.txt",
    "manifest.webmanifest",
    "manifest.json",
    "apple-touch-icon.png",
    "apple-touch-icon-180x180.png",
    ".well-known/security.txt",
    ".well-known/acme-challenge/token",
    ".nojekyll",
    "_redirects",
    "_headers",
  ]) {
    assert.ok(isConventionFile(p), `${p} 应当被认作约定文件`);
  }
  // 名字像、但不在约定路径上的，不算
  for (const p of ["icons/apple-touch-icon.png", "assets/robots.txt", "docs/favicon.ico"]) {
    assert.ok(!isConventionFile(p), `${p} 不在约定的根路径上，不该被保护`);
  }
});

test("约定文件即使没有任何引用也不能删（这是最容易踩的坑）", async () => {
  const extras = [
    { path: "robots.txt", content: "User-agent: *\nAllow: /\n" },
    { path: "favicon.ico", base64: Buffer.alloc(64, 1).toString("base64") },
    { path: "sitemap.xml", content: '<?xml version="1.0"?><urlset></urlset>\n' },
  ];
  const r = await runOptimize(extras);

  const droppedPaths = r.files.dropped.map((d) => d.path);
  for (const e of extras) {
    assert.ok(!droppedPaths.includes(e.path), `${e.path} 靠约定路径访问，绝不能被删`);
  }
  // 而且确实写进了产物
  const written = r.after.files.map((f) => f.path);
  for (const e of extras) {
    assert.ok(written.includes(e.path), `${e.path} 应当在产物里`);
  }
  // 报告要说明「这些是无引用但被保护保留的」，否则用户会以为漏删了
  assert.ok(
    r.files.protectedByConvention.includes("robots.txt"),
    `报告里要列出被保护的约定文件，实际：${JSON.stringify(r.files.protectedByConvention)}`,
  );
});

test(".well-known/ 其实进不了链 —— 协议的隐藏文件规则会把它整个跳过", async () => {
  // 这是协议层面的限制，不是本工具的选择：路径任一段以 "." 开头 = 隐藏文件，
  // 前端会静默跳过（不上传、不计费、也不报错）。所以 .well-known/ 里的
  // 域名验证 / ACME / security.txt 在这个协议下都没法用。
  const r = await runOptimize([{ path: ".well-known/security.txt", content: "Contact: mailto:a@b.c\n" }]);

  assert.ok(
    !r.after.files.some((f) => f.path.startsWith(".well-known")),
    "它不该出现在产物里（协议会跳过，不是我们删的）",
  );
  assert.ok(
    !r.files.dropped.some((d) => d.path.startsWith(".well-known")),
    "也不是被删除规则删的",
  );
  assert.ok(
    r.before.skipped.some((f) => f.path.startsWith(".well-known") && f.reason === "hidden"),
    `应当以 hidden 出现在 skipped 里，实际：${JSON.stringify(r.before.skipped)}`,
  );
});

test("显式 drop 仍然能删掉约定文件（用户说了算）", async () => {
  const extras = [{ path: "robots.txt", content: "User-agent: *\n" }];
  const r = await runOptimize(extras, { drop: ["robots.txt"] });
  assert.ok(r.files.dropped.some((d) => d.path === "robots.txt"), "显式排除应当生效");
});

/* ------------------------------ 开关与优先级 ------------------------------ */

test("keep 的优先级高于任何删除规则", async () => {
  const r = await runOptimize([], { keep: ["README.md", "orphan.png"] });
  const droppedPaths = r.files.dropped.map((d) => d.path);
  assert.ok(!droppedPaths.includes("README.md"));
  assert.ok(!droppedPaths.includes("orphan.png"));
  assert.deepEqual(droppedPaths, ["app.js.map"]);
});

test("关掉开关就一个都不删（完全保守模式）", async () => {
  const r = await runOptimize([], { dropUnreferenced: false, dropNonSiteFiles: false });
  assert.deepEqual(r.files.dropped, []);
  assert.ok(r.after.files.some((f) => f.path === "README.md"), "README 也要留着");
});

test("只关一半：保留无引用文件，但仍删非站点资源", async () => {
  const r = await runOptimize([], { dropUnreferenced: false, dropNonSiteFiles: true });
  const droppedPaths = r.files.dropped.map((d) => d.path).sort();
  assert.deepEqual(droppedPaths, ["README.md", "app.js.map"]);
});

test("decideDrops 本身：默认参数就是「删」", () => {
  const scan = {
    billable: [
      { path: "index.html", bytes: 10 },
      { path: "orphan.png", bytes: 20 },
      { path: "README.md", bytes: 30 },
      { path: "robots.txt", bytes: 5 },
    ],
    references: { unreferenced: ["orphan.png", "robots.txt"] },
  };
  const { dropped, kept, protectedByConvention } = decideDrops(scan);
  assert.deepEqual(dropped.map((d) => d.path).sort(), ["README.md", "orphan.png"]);
  assert.deepEqual(kept.map((f) => f.path).sort(), ["index.html", "robots.txt"]);
  assert.deepEqual(protectedByConvention, ["robots.txt"]);
});

/* -------------------- CLI 与库必须一致（这次改动的核心） -------------------- */

test("CLI 不传 flag 时，行为与库的默认值一致（不能把默认值顶掉）", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "deweb-shrink-drop-"));
  const site = path.join(root, "site");
  const outDefault = path.join(root, "out-default");
  const outKeepAll = path.join(root, "out-keepall");
  try {
    await fs.mkdir(site, { recursive: true });
    for (const f of files()) {
      const abs = path.join(site, f.path);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, f.base64 ? Buffer.from(f.base64, "base64") : f.content);
    }

    const run = (args) =>
      execFileAsync(process.execPath, [CLI, "optimize", site, "--gas", "0.05", "--usd", "750", "--json", ...args], {
        maxBuffer: 32 * 1024 * 1024,
      }).then(({ stdout }) => JSON.parse(stdout.slice(stdout.indexOf("{"))));

    const def = await run(["--out", outDefault]);
    assert.deepEqual(
      def.files.dropped.map((d) => d.path).sort(),
      ["README.md", "app.js.map", "orphan.png"],
      "CLI 不带 flag 时应当用库的默认值（删），而不是把它顶成 false",
    );

    const keepAll = await run(["--out", outKeepAll, "--keep-all"]);
    assert.deepEqual(keepAll.files.dropped, [], "--keep-all 应当一个都不删");
    assert.ok(
      keepAll.after.totals.bytes > def.after.totals.bytes,
      "--keep-all 的产物应当更大（多带了被删的文件）",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
