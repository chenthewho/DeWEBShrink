/* ==========================================================================
   PoC 的 Web Worker —— 压缩在这里跑，UI 不卡
   --------------------------------------------------------------------------
   跑的是 poc/pipeline.js，也就是 src/ 里那套算法（构建期把 sharp 换成 oxipng、
   esbuild 换成 esbuild-wasm、node:crypto 换成纯 JS sha256）。

   esbuild-wasm 必须显式 initialize 才肯干活；wasm 文件由 build.mjs 拷到 worker
   同目录（dist/esbuild.wasm），所以这里用 import.meta.url 相对定位。
   ========================================================================== */

import * as esbuildWasm from "esbuild-wasm";
import { shrinkFiles } from "../pipeline.js";

let runtimeReady = null;

function ensureRuntime() {
  if (!runtimeReady) {
    runtimeReady = esbuildWasm.initialize({
      wasmURL: new URL("./esbuild.wasm", import.meta.url).href,
      worker: false, // 已经在 Worker 里了，不需要 esbuild 再开一层线程
    });
  }
  return runtimeReady;
}

const post = (msg) => self.postMessage(msg);

self.onmessage = async (ev) => {
  const { type, files, pricing, options } = ev.data || {};
  if (type !== "run") return;

  try {
    post({ type: "progress", phase: "runtime", detail: "加载 esbuild 的 WASM 运行时…" });
    await ensureRuntime();

    const { report, json, elapsedMs } = await shrinkFiles({
      files,
      options: options || {},
      ...(pricing || {}),
      onProgress: ({ phase, filesRead, path }) =>
        post({ type: "progress", phase, filesRead, path }),
    });

    post({ type: "done", report, json, elapsedMs });
  } catch (err) {
    post({ type: "error", message: err?.message || String(err), stack: err?.stack });
  }
};
