/* ==========================================================================
   浏览器替身：全局 process
   --------------------------------------------------------------------------
   为什么需要：html-minifier-terser（→ terser / clean-css / relateurl）里有
   `process.*` 的引用。Node 里它天然存在，所以「在 Node 里跑浏览器包」的对拍会
   全部通过；一进浏览器，`process is not defined` 会让那条动态 import 抛错，
   被 text.js 的守卫捕获 → HTML 直接跳过压缩（产物还是原文，账单偏大）。

   实测就是这么翻车的：浏览器版 index.html 72328 B（原文），CLI 版 70155 B。
   注入这个替身后两边一致。

   注意：这里**不是**在模拟完整 Node；只是让「浏览器里也会被读到的那些字段」
   有合理取值（env 空对象、platform=browser、nextTick 用微任务）。
   ========================================================================== */

"use strict";

export const process = {
  env: { NODE_ENV: "production" },
  platform: "browser",
  browser: true,
  versions: {},
  argv: [],
  pid: 0,
  title: "browser",
  cwd: () => "/",
  chdir: () => {},
  nextTick: (fn, ...args) => queueMicrotask(() => fn(...args)),
  emitWarning: () => {},
  on: () => {},
  once: () => {},
  off: () => {},
  removeListener: () => {},
  exit: () => {},
  hrtime: Object.assign((prev) => {
    const ms = performance.now();
    const s = Math.floor(ms / 1000);
    const ns = Math.floor((ms % 1000) * 1e6);
    if (!prev) return [s, ns];
    const ds = s - prev[0];
    const dns = ns - prev[1];
    return dns < 0 ? [ds - 1, dns + 1e9] : [ds, dns];
  }, { bigint: () => BigInt(Math.floor(performance.now() * 1e6)) }),
};
