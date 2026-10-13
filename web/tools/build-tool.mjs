#!/usr/bin/env node
/* ==========================================================================
   build-tool.mjs —— 把站点需要的运行时打出来
   --------------------------------------------------------------------------
   与 poc/build.mjs 用的是**同一套 alias / 替身**，所以网页里跑出来的数字
   与 CLI / MCP 必然一致：

     node:crypto      → 纯 JS sha256
     sharp            → oxipng WASM（浏览器里只做无损那一档）
     esbuild          → esbuild-wasm
     node:fs / path   → 只读替身（浏览器里走内存文件源）

   产物（都在 web/assets/，全部是生成物，不要手改）：
     site.js               页面行为 + 在线体检（含 fflate，用来打 .tape.zip）
     tool.worker.js        压缩 Worker
     esbuild.wasm          12.3 MB，首次使用时才下载
     squoosh_oxipng_bg.wasm
     site.css              ← 从 web/src/site.css 拷过来（手写源文件）
   ========================================================================== */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const POC = path.join(ROOT, "poc");
const SRC = path.join(ROOT, "web/src");
const ASSETS = path.join(ROOT, "web/assets");

const aliasPlugin = {
  name: "site-alias",
  setup(build) {
    const map = {
      "node:crypto": path.join(POC, "shims/node-crypto.js"),
      "node:path": path.join(POC, "shims/node-path.js"),
      "node:fs/promises": path.join(POC, "shims/node-fs-promises.js"),
    };
    build.onResolve({ filter: /^(node:crypto|node:path|node:fs\/promises)$/ }, (a) => ({ path: map[a.path] }));
    const bare = {
      path: path.join(POC, "shims/node-path.js"),
      fs: path.join(POC, "shims/node-fs.js"),
      url: path.join(POC, "shims/node-net.js"),
      http: path.join(POC, "shims/node-net.js"),
      https: path.join(POC, "shims/node-net.js"),
    };
    build.onResolve({ filter: /^(path|fs|url|http|https)$/ }, (a) => (bare[a.path] ? { path: bare[a.path] } : null));
    build.onResolve({ filter: /^esbuild$/ }, async (a) => {
      const r = await build.resolve("esbuild-wasm", { resolveDir: a.resolveDir, kind: a.kind });
      return r.errors.length ? { errors: r.errors } : { path: r.path, namespace: r.namespace, sideEffects: r.sideEffects };
    });
    build.onResolve({ filter: /(^|\/)(optimize\/)?images\.js$/ }, () => ({ path: path.join(POC, "shims/images-browser.js") }));
  },
};

async function main() {
  await fs.mkdir(ASSETS, { recursive: true });
  const result = await esbuild.build({
    bundle: true,
    format: "esm",
    target: ["es2022"],
    platform: "browser",
    sourcemap: false,
    minify: true,
    logLevel: "warning",
    plugins: [aliasPlugin],
    inject: [path.join(POC, "shims/buffer-global.js"), path.join(POC, "shims/process-global.js")],
    define: { "process.env.NODE_ENV": '"production"' },
    entryPoints: { site: path.join(SRC, "site.js"), "tool.worker": path.join(POC, "web/worker.js") },
    outdir: ASSETS,
    entryNames: "[name]",
    loader: { ".wasm": "file" },
    metafile: true,
  });

  /* 两个 wasm 必须与产物同目录：glue 代码用 new URL("…", import.meta.url) 定位 */
  await fs.copyFile(path.join(ROOT, "node_modules/esbuild-wasm/esbuild.wasm"), path.join(ASSETS, "esbuild.wasm"));
  await fs.copyFile(
    path.join(ROOT, "node_modules/@jsquash/oxipng/codec/pkg/squoosh_oxipng_bg.wasm"),
    path.join(ASSETS, "squoosh_oxipng_bg.wasm"),
  );
  await fs.copyFile(path.join(SRC, "site.css"), path.join(ASSETS, "site.css"));

  const rows = Object.entries(result.metafile.outputs)
    .filter(([, v]) => v.entryPoint)
    .map(([k, v]) => `  ${path.relative(ROOT, k)}  ${(v.bytes / 1024).toFixed(0)} KB`);
  console.log("✓ 站点运行时：\n" + rows.join("\n"));
  for (const f of ["site.css", "esbuild.wasm", "squoosh_oxipng_bg.wasm"]) {
    const s = await fs.stat(path.join(ASSETS, f));
    console.log(`  web/assets/${f}  ${(s.size / 1024).toFixed(s.size > 1024 * 1024 ? 1 : 0)} KB`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
