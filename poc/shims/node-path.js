/* ==========================================================================
   浏览器替身：node:path（含裸 "path"）
   --------------------------------------------------------------------------
   src/source.js 用它在「本地目录形态」下拼路径；clean-css（html-minifier-terser
   的依赖）在可选加载路径里 require("path")。浏览器形态下这两处都不会真的用到
   文件系统语义，但**模块必须能加载**，所以给一份语义正确的最小实现。
   ========================================================================== */

"use strict";

export const sep = "/";
export const delimiter = ":";

const clean = (p) => String(p).replace(/\/{2,}/g, "/");

export function normalize(p) {
  const parts = [];
  for (const seg of clean(p).split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === ".." && parts.length && parts[parts.length - 1] !== "..") parts.pop();
    else parts.push(seg);
  }
  const joined = parts.join("/");
  return String(p).startsWith("/") ? `/${joined}` : joined || ".";
}

export function join(...parts) {
  return normalize(parts.filter((p) => p !== "" && p != null).join("/"));
}

export function resolve(...parts) {
  const joined = normalize(parts.filter((p) => p !== "" && p != null).join("/"));
  return joined.startsWith("/") ? joined : `/${joined}`;
}

export function isAbsolute(p) {
  return String(p).startsWith("/");
}

export function dirname(p) {
  const s = clean(String(p)).replace(/\/+$/, "");
  const i = s.lastIndexOf("/");
  return i <= 0 ? (s.startsWith("/") ? "/" : ".") : s.slice(0, i);
}

export function basename(p, ext = "") {
  const s = clean(String(p)).replace(/\/+$/, "");
  const base = s.slice(s.lastIndexOf("/") + 1);
  return ext && base.endsWith(ext) ? base.slice(0, -ext.length) : base;
}

export function extname(p) {
  const base = basename(p);
  const i = base.lastIndexOf(".");
  return i <= 0 ? "" : base.slice(i);
}

export function relative(from, to) {
  const a = resolve(from).split("/").filter(Boolean);
  const b = resolve(to).split("/").filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return [...Array(a.length - i).fill(".."), ...b.slice(i)].join("/");
}

export const posix = { sep, join, resolve, normalize, isAbsolute, dirname, basename, extname, relative };
export const win32 = posix;

export default { sep, delimiter, join, resolve, normalize, isAbsolute, dirname, basename, extname, relative, posix, win32 };
