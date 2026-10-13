/* ==========================================================================
   浏览器替身：node:url / node:http / node:https（裸 "url" / "http" / "https"）
   --------------------------------------------------------------------------
   clean-css 的 inline-request（把 url() 里的远程资源内联进来）会 require 这三个；
   html-minifier-terser 在我们用的选项下不会开启那条路（它做的是内联样式压缩，
   不抓远程资源）。所以这里给「能加载、调用即报错」的实现，避免静默走错分支。
   ========================================================================== */

"use strict";

/* ------------------------------- url ------------------------------- */

export function parse(input, base) {
  try {
    return new URL(String(input), base || "http://localhost/");
  } catch {
    return { href: String(input), pathname: String(input), protocol: "", host: "" };
  }
}

export function format(u) {
  if (typeof u === "string") return u;
  if (u instanceof URL) return u.href;
  return String(u?.href ?? "");
}

export function resolve(from, to) {
  try {
    return new URL(String(to), String(from)).href;
  } catch {
    return String(to);
  }
}

export function fileURLToPath(u) {
  const s = String(u);
  return s.startsWith("file://") ? decodeURIComponent(s.slice("file://".length)) : s;
}

export function pathToFileURL(p) {
  return new URL(`file://${String(p).startsWith("/") ? "" : "/"}${p}`);
}

export const URL = globalThis.URL;

/* ---------------------------- http / https ---------------------------- */

function unsupported(mod) {
  return () => {
    throw new Error(`浏览器 PoC 里不该发起 ${mod} 请求（${mod}.request/get 未实现）`);
  };
}

export const request = unsupported("http");
export const get = unsupported("http");
export class Agent {
  constructor(opts = {}) {
    Object.assign(this, opts);
  }
}
export const globalAgent = new Agent();
export const STATUS_CODES = {};

export default { parse, format, resolve, fileURLToPath, pathToFileURL, URL, request, get, Agent, globalAgent, STATUS_CODES };
