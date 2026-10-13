/* ==========================================================================
   浏览器替身：node:fs（裸 "fs"）
   --------------------------------------------------------------------------
   谁在 require 它：clean-css 的 source-map 读取（可选路径）。
   浏览器 PoC 里没有文件系统，也不会走到那条路 —— 真被调用就报错，别静默返回空值
   （静默返回空会让「读到空文件」这种事悄悄污染产物）。
   ========================================================================== */

"use strict";

function boom(name) {
  return () => {
    throw new Error(`浏览器 PoC 里不该调用 fs.${name}()`);
  };
}

export const readFileSync = boom("readFileSync");
export const writeFileSync = boom("writeFileSync");
export const existsSync = () => false; // 唯一「无害且正确答案明确」的一个：没有文件
export const statSync = boom("statSync");
export const createReadStream = boom("createReadStream");
export const createWriteStream = boom("createWriteStream");
export const readdirSync = () => [];
export const promises = { readFile: async () => boom("promises.readFile")(), writeFile: boom("promises.writeFile") };

export default { readFileSync, writeFileSync, existsSync, statSync, createReadStream, createWriteStream, readdirSync, promises };
