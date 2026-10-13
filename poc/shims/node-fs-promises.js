/* ==========================================================================
   node:fs/promises 的浏览器替身 —— 所有函数一调用就报错
   --------------------------------------------------------------------------
   浏览器形态只会用内存源 / 内存产物槽，没有任何理由碰文件系统。
   真被调用到就说明代码走进了「本地目录」分支，这时候报错比静默继续安全。
   ========================================================================== */

"use strict";

function notAvailable(name) {
  return async () => {
    throw new Error(`浏览器 PoC 里不该调用 fs.${name}()：内存形态请用 createMemorySource / createMemorySink`);
  };
}

export const readFile = notAvailable("readFile");
export const writeFile = notAvailable("writeFile");
export const readdir = notAvailable("readdir");
export const stat = notAvailable("stat");
export const mkdir = notAvailable("mkdir");
export const rm = notAvailable("rm");
export const unlink = notAvailable("unlink");

export default { readFile, writeFile, readdir, stat, mkdir, rm, unlink };
