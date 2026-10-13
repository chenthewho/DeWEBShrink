/* ==========================================================================
   文件源 / 产物槽 —— 把「文件从哪来、到哪去」和压缩算法解耦
   --------------------------------------------------------------------------
   之前 scanSite / optimizeSite / verifyOutput 直接吃目录路径，所以只能处理本地磁盘。
   要把它部署成服务器上的 MCP（agent 把文件内容当参数传进来，服务器上并没有那个目录），
   就得让算法同时支持两种来源：

     createFsSource(root)        本地目录（CLI 继续用这个）
     createMemorySource(files)   agent 传进来的文件内容（MCP 用这个）

   产物侧同理：

     createFsSink(root)          写到本地目录
     createMemorySink()          收在内存里，回给调用方

   算法层只认 Source / Sink 接口，不再碰 node:fs —— 同一套压缩与校验逻辑，
   本地和服务器上一字不差。

   安全约定（memorySource 是唯一处理「外部输入」的地方，所以校验都放这里）：
     · 路径先去掉前导 /，再做 NFC 归一化，再走协议的 isBadPath（拒绝 ..、控制字符、超长）；
     · 重复路径直接报错，不静默取最后一个 —— 免得 agent 以为传了两份、实际只留一份；
     · 隐藏文件（. 开头）**不在这里拒绝**：协议会跳过它，但那属于 scan 的判断，
       扫描报告要能把「你有文件会被静默跳过」如实讲出来。
   ========================================================================== */

"use strict";

import fs from "node:fs/promises";
import path from "node:path";

import { isBadPath, normalizePath } from "./protocol.js";

/** 永远不进：版本库与依赖目录（既不该上传，走进去也没意义）。 */
const NEVER_WALK = new Set([".git", "node_modules"]);

/** 把 "dist/**" 这种简单 glob 变成正则（只支持 * 与 **，够用且不会误伤）。 */
function globToRe(glob) {
  const body = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${body}$`);
}

/** 判断一个相对路径是否命中排除规则（前缀或 glob）。 */
export function isExcluded(rel, patterns) {
  for (const p of patterns) {
    if (!p) continue;
    if (rel === p || rel.startsWith(p.endsWith("/") ? p : `${p}/`)) return true;
    if (/[*?]/.test(p) && globToRe(p).test(rel)) return true;
  }
  return false;
}

/* --------------------------------------------------------------------------
   文件源
   -------------------------------------------------------------------------- */

/**
 * 本地目录作为文件源。行为与原 walkSite 完全一致（同样的跳过规则、同样的排序）。
 * @param {string} root
 * @param {{exclude?:string[]}} [opts]
 */
export function createFsSource(root, opts = {}) {
  const exclude = opts.exclude || [];
  const absRoot = path.resolve(root);
  let listed = null;

  return {
    kind: "fs",
    label: absRoot,
    root: absRoot,

    async list() {
      if (listed) return listed;
      const files = [];
      const ignoredDirs = [];

      async function visit(absDir, relDir) {
        let entries;
        try {
          entries = await fs.readdir(absDir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          const abs = path.join(absDir, entry.name);
          const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            if (NEVER_WALK.has(entry.name) || isExcluded(rel, exclude)) {
              ignoredDirs.push(rel);
              continue;
            }
            await visit(abs, rel);
            continue;
          }
          if (!entry.isFile()) continue; // 符号链接 / 设备文件一律不管
          if (isExcluded(rel, exclude)) continue;
          let st;
          try {
            st = await fs.stat(abs);
          } catch {
            continue;
          }
          files.push({ path: rel, bytes: st.size });
        }
      }

      await visit(absRoot, "");
      files.sort((a, b) => a.path.localeCompare(b.path));
      listed = { files, ignoredDirs };
      return listed;
    },

    async read(rel) {
      try {
        return await fs.readFile(path.join(absRoot, rel));
      } catch {
        return null;
      }
    },
  };
}

/** 规范化外部传进来的路径：去前导 /、NFC 归一化、按协议规则拒绝非法路径。 */
export function cleanRelPath(raw) {
  const stripped = String(raw ?? "").replace(/^[/\\]+/, "").replace(/\\/g, "/");
  const rel = normalizePath(stripped);
  if (isBadPath(rel)) {
    throw new Error(
      `非法路径「${raw}」：不能为空、不能含 .. 或控制字符、不能超过 1000 字符（协议也会拒绝这样的路径）`,
    );
  }
  return rel;
}

/** 把一条外部文件记录变成 Buffer。文本走 content，二进制走 base64，也可以直接给 bytes。 */
function entryToBuffer(entry, rel) {
  if (entry.bytes instanceof Uint8Array) return Buffer.from(entry.bytes);
  if (typeof entry.base64 === "string") return Buffer.from(entry.base64, "base64");
  if (typeof entry.content === "string") return Buffer.from(entry.content, "utf8");
  throw new Error(`文件「${rel}」缺少内容：需要 content（文本）、base64（二进制）或 bytes 之一`);
}

/**
 * 内存文件数组作为文件源。给 MCP 用：agent 把文件内容当参数传进来。
 * @param {Array<{path:string, content?:string, base64?:string, bytes?:Uint8Array}>} files
 * @param {{exclude?:string[]}} [opts]
 */
export function createMemorySource(files, opts = {}) {
  if (!Array.isArray(files)) throw new Error("files 必须是数组");
  const exclude = opts.exclude || [];
  const store = new Map();
  const ignoredDirs = [];

  for (const entry of files) {
    if (!entry || typeof entry !== "object") throw new Error("files 里每一项都要是 { path, content | base64 }");
    const rel = cleanRelPath(entry.path);
    if (store.has(rel)) throw new Error(`files 里有重复路径「${rel}」——请合并后再传`);
    if (isExcluded(rel, exclude)) continue;
    store.set(rel, entryToBuffer(entry, rel));
  }

  return {
    kind: "memory",
    label: `（内存文件源，${store.size} 个文件）`,
    root: null,

    async list() {
      const out = [...store.entries()].map(([rel, buf]) => ({ path: rel, bytes: buf.length }));
      out.sort((a, b) => a.path.localeCompare(b.path));
      return { files: out, ignoredDirs };
    },

    async read(rel) {
      const buf = store.get(normalizePath(String(rel)));
      return buf ? Buffer.from(buf) : null;
    },
  };
}

/**
 * 把「字符串路径」或「已构造的 Source」统一成 Source。
 * 这是所有算法入口的兼容层：CLI 传字符串、MCP 传 Source，两边走同一段代码。
 */
export function asSource(input, opts = {}) {
  if (!input) throw new Error("缺少文件源：要么给目录路径，要么给 { path, content } 的文件数组");
  if (typeof input === "string") return createFsSource(input, opts);
  if (typeof input.list === "function" && typeof input.read === "function") return input;
  throw new Error("无法识别的文件源：字符串目录路径，或 createFsSource / createMemorySource 的返回值");
}

/**
 * 两个文件源是不是**同一个**。
 *
 * 用来判断「这次校验到底有没有基准」：`verifyOutput({ originalDir: X, outputDir: X })`
 * 这种「自己跟自己比」在语义上等于没有基准，不能按「对拍」处理 ——
 * 否则会把本来就存在的断链全部算成「这次改动新增的」，从而误报失败。
 * 内存源没有路径可比，只能用引用相等判断。
 */
export function isSameSource(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.kind === "fs" && b.kind === "fs") return a.root === b.root;
  return false;
}

/* --------------------------------------------------------------------------
   产物槽
   -------------------------------------------------------------------------- */

/** 产物写到本地目录。 */
export function createFsSink(root) {
  const absRoot = path.resolve(root);
  return {
    kind: "fs",
    label: absRoot,
    root: absRoot,
    async write(rel, buf) {
      const abs = path.join(absRoot, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, buf);
    },
    async done() {
      return { kind: "fs", root: absRoot, files: null };
    },
  };
}

/** 产物收在内存里，交给调用方（MCP 要把它回给 agent）。 */
export function createMemorySink() {
  const files = new Map();
  return {
    kind: "memory",
    label: "（内存产物）",
    root: null,
    async write(rel, buf) {
      files.set(normalizePath(String(rel)), Buffer.from(buf));
    },
    async done() {
      return { kind: "memory", root: null, files };
    },
  };
}

/** 把「字符串目录」或「已构造的 Sink」统一成 Sink。 */
export function asSink(input) {
  if (!input) throw new Error("缺少产物槽：要么给目录路径，要么给 createMemorySink() 的返回值");
  if (typeof input === "string") return createFsSink(input);
  if (typeof input.write === "function") return input;
  throw new Error("无法识别的产物槽：字符串目录路径，或 createFsSink / createMemorySink 的返回值");
}
