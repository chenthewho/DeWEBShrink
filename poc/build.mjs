#!/usr/bin/env node
/* ==========================================================================
   PoC 构建 —— 用同一套 alias 打两个产物
   --------------------------------------------------------------------------
     --target=browser（默认）  poc/web/dist/{main.js,worker.js} + 两个 wasm
     --target=node            poc/dist/pipeline.node.mjs（给对拍脚本用）

   两个产物走的是**同一份 src/ 代码 + 同一套替身**，所以 Node 里跑出来的
   「浏览器版结果」可以直接拿去和原生 sharp/esbuild 版对拍。
   ========================================================================== */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const POC = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(POC, "..");
const target = (process.argv.find((a) => a.startsWith("--target=")) || "--target=browser").split("=")[1];

/** 把原生/Node 专用的东西换成浏览器替身；两个产物都换，保证对拍的是同一条路径。 */
const aliasPlugin = {
  name: "poc-alias",
  setup(build) {
    const map = {
      "node:crypto": path.join(POC, "shims/node-crypto.js"),
      "node:path": path.join(POC, "shims/node-path.js"),
      "node:fs/promises": path.join(POC, "shims/node-fs-promises.js"),
    };
    build.onResolve({ filter: /^(node:crypto|node:path|node:fs\/promises)$/ }, (args) => ({ path: map[args.path] }));

    /* 浏览器包还要替换一批**裸** node 内置名：clean-css（html-minifier-terser 的依赖）
       在「内联远程资源 / 读 source map」这些可选路径里 require 了它们。那条路我们不会走，
       但模块得能加载，所以用「调用即报错」的替身。node 产物不需要（那些包是 external）。 */
    if (target === "browser") {
      const bare = {
        path: path.join(POC, "shims/node-path.js"),
        fs: path.join(POC, "shims/node-fs.js"),
        url: path.join(POC, "shims/node-net.js"),
        http: path.join(POC, "shims/node-net.js"),
        https: path.join(POC, "shims/node-net.js"),
      };
      build.onResolve({ filter: /^(path|fs|url|http|https)$/ }, (args) => {
        /* 只拦 true-bare import（相对路径不会走到这里；npm 里没有叫 path/fs/url 的包） */
        const to = bare[args.path];
        return to ? { path: to } : null;
      });
    }
    /* esbuild → esbuild-wasm：交给 esbuild 自己解析，这样 platform=browser 时会走
       esbuild-wasm 的浏览器入口（browser 字段），platform=node 时走 node 入口。 */
    build.onResolve({ filter: /^esbuild$/ }, async (args) => {
      const r = await build.resolve("esbuild-wasm", { resolveDir: args.resolveDir, kind: args.kind });
      if (r.errors.length) return { errors: r.errors };
      /* node 产物里 esbuild-wasm 是 external（CJS 入口不能打进 ESM），原样透传 */
      if (r.external) return { path: r.path, external: true };
      return { path: r.path, namespace: r.namespace, sideEffects: r.sideEffects, external: false };
    });
    /* sharp 藏在 src/optimize/images.js 里：整模块换成 WASM 版（oxipng + 头部解析）。
       注意 importer 的写法有两种：optimize/index.js 用 "./images.js"，
       verify.js 用 "./optimize/images.js"，所以正则要两种都接。 */
    build.onResolve({ filter: /(^|\/)(optimize\/)?images\.js$/ }, (args) => ({
      path: path.join(POC, "shims/images-browser.js"),
    }));
  },
};

const shared = {
  bundle: true,
  format: "esm",
  target: ["es2022"],
  sourcemap: false,
  minify: false, // PoC 要能读 bundle，先不压
  logLevel: "warning",
  plugins: [aliasPlugin],
  /* 注入两个全局替身：Buffer（base64/UTF-8 语义）与 process（html-minifier-terser
     在浏览器里会读 process.*，不注入就会抛错 → HTML 被静默跳过压缩）。 */
  inject: [path.join(POC, "shims/buffer-global.js"), path.join(POC, "shims/process-global.js")],
  define: { "process.env.NODE_ENV": '"production"' },
};

async function main() {
  if (target === "node") {
    await fs.mkdir(path.join(POC, "dist"), { recursive: true });
    await esbuild.build({
      ...shared,
      platform: "node",
      entryPoints: [path.join(POC, "pipeline.js")],
      outfile: path.join(POC, "dist/pipeline.node.mjs"),
      /* esbuild-wasm 的 node 入口是 CJS，内部用 require("fs") 读 wasm；
         html-minifier-terser 及其依赖（terser/clean-css）也是 CJS —— 打进 ESM 产物
         会退化成 esbuild 的 __require 垫片而抛 "Dynamic require is not supported"。
         两个都留成 external，交给 Node 自己 require。 */
      external: ["esbuild-wasm", "html-minifier-terser"],
      banner: { js: "/* 自动生成：node poc/build.mjs --target=node。不要手改。 */" },
    });
    console.log("✓ poc/dist/pipeline.node.mjs");
    return;
  }

  const dist = path.join(POC, "web/dist");
  await fs.rm(dist, { recursive: true, force: true });
  await fs.mkdir(dist, { recursive: true });

  const result = await esbuild.build({
    ...shared,
    platform: "browser",
    entryPoints: {
      main: path.join(POC, "web/main.js"),
      worker: path.join(POC, "web/worker.js"),
    },
    outdir: dist,
    entryNames: "[name]",
    assetNames: "assets/[name]-[hash]",
    loader: { ".wasm": "file" },
    metafile: true,
  });

  /* esbuild-wasm 的 wasm 得让浏览器自己 fetch —— 复制到 dist 根下 */
  await fs.copyFile(
    path.join(ROOT, "node_modules/esbuild-wasm/esbuild.wasm"),
    path.join(dist, "esbuild.wasm"),
  );

  /* oxipng 的 wasm：jSquash 的 glue 用 `new URL("squoosh_oxipng_bg.wasm", import.meta.url)`
     定位（没有 ./ 前缀，所以 esbuild 不会当成 asset 处理），名字相对于 worker.js，
     因此必须放到 dist 根下、名字一个字都不能改。
     注意：这里放的是**单线程**版。jSquash 只有在 Worker + SharedArrayBuffer（需要
     COOP/COEP 响应头）都满足时才走多线程版，本地静态服务不发那两个头，所以是单线程。 */
  await fs.copyFile(
    path.join(ROOT, "node_modules/@jsquash/oxipng/codec/pkg/squoosh_oxipng_bg.wasm"),
    path.join(dist, "squoosh_oxipng_bg.wasm"),
  );

  const out = Object.entries(result.metafile.outputs)
    .filter(([, v]) => v.entryPoint)
    .map(([k, v]) => `  ${path.relative(POC, k)}  ${(v.bytes / 1024).toFixed(0)} KB`)
    .join("\n");
  const assets = Object.entries(result.metafile.outputs)
    .filter(([, v]) => !v.entryPoint)
    .map(([k, v]) => `  ${path.relative(POC, k)}  ${(v.bytes / 1024).toFixed(0)} KB`)
    .join("\n");
  console.log("✓ 浏览器包：\n" + out);
  if (assets) console.log("  附带资源：\n" + assets);
  for (const wasm of ["esbuild.wasm", "squoosh_oxipng_bg.wasm"]) {
    const size = (await fs.stat(path.join(dist, wasm))).size;
    console.log(`  ${wasm}  ${(size / 1024 / 1024).toFixed(1)} MB`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
