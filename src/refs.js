/* ==========================================================================
   引用图 —— 谁引用了谁
   --------------------------------------------------------------------------
   两个方向都要用：
     · 正向（完整性）：HTML/CSS/JS/SW/manifest 里提到的文件，目标是否真的存在？
       少一个文件 = 线上 404，而链上已经付过钱了。
     · 反向（死重）：哪些文件谁都没提？它们一样按字节计费，是纯浪费。

   取字符串这件事**不能靠正则**：压缩后的 JS 是一整行，里面还有 `\u5728` 这种转义，
   正则配对引号会「跑偏」，把后面的字符串整段漏掉 —— 而漏掉的正是安全校验要看的引用。
   所以 JS 一律先用 acorn 解析出真正的字符串字面量，解不开才退回正则。

   反向判断必须**保守**：宁可说「可能被引用」，也不能把还在用的文件当成死文件删掉。
   所以除了精确匹配，还用 basename / 目录前缀（"fonts/" + 名字 这种拼接式引用）兜底。
   ========================================================================== */

"use strict";

import { parse } from "acorn";

/** 认得出的静态资源扩展名 —— 用来从 JS 字符串里挑出「像路径」的那些。 */
export const ASSET_EXT_RE =
  /\.(?:woff2?|ttf|otf|eot|png|jpe?g|gif|webp|avif|svg|ico|bmp|css|js|mjs|json|html?|webmanifest|xml|wasm|pdf|mp4|webm|mp3|txt|md)$/i;

const EXTERNAL_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;
const DATA_RE = /^data:/i;

/** 明显不是本站资源的引用（外链、data:、锚点、模板占位）。 */
export function isExternalRef(raw) {
  const s = String(raw).trim();
  if (s === "" || DATA_RE.test(s)) return true;
  if (EXTERNAL_RE.test(s)) return true;
  if (s.includes("${") || s.includes("{{")) return true; // 模板
  return false;
}

/** 去掉 ?query#hash，并对 %XX 解码。 */
function stripQueryHash(raw) {
  let s = String(raw).trim();
  const cut = s.search(/[?#]/);
  if (cut >= 0) s = s.slice(0, cut);
  try {
    s = decodeURIComponent(s);
  } catch {
    /* 解不开就按原文用 */
  }
  return s;
}

/**
 * 把一条引用规范化成「相对站点根」的 POSIX 路径。
 * @param {string} raw 原始引用文本
 * @param {string} fromPath 引用者自身的相对路径（决定相对基准）
 * @returns {string|null} 无法归到站点内的返回 null
 */
export function resolveRef(raw, fromPath = "") {
  const cleaned = stripQueryHash(raw);
  if (cleaned === "" || isExternalRef(cleaned)) return null;
  const dir = fromPath.includes("/") ? fromPath.slice(0, fromPath.lastIndexOf("/")) : "";
  const base = cleaned.startsWith("/") ? "" : dir;
  const joined = base ? `${base}/${cleaned}` : cleaned;
  const out = [];
  for (const seg of joined.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) return null; // 跑到站点外面去了
      out.pop();
      continue;
    }
    out.push(seg);
  }
  if (out.length === 0) return "";
  return out.join("/").normalize("NFC");
}

/** 字符串是不是「像一条站内路径」。 */
function looksLikePath(s) {
  if (s === "" || /\s/.test(s)) return false;
  if (isExternalRef(s)) return false;
  return ASSET_EXT_RE.test(s) || /^\.{0,2}\//.test(s);
}

/** 造一个收集器，HTML / CSS / JS 三条路都往它里面塞。 */
function makeCollector(filePath) {
  const refs = new Set();
  const locals = new Set();
  const dirs = new Set();
  const strings = new Set();

  const add = (raw) => {
    if (!raw) return;
    const s = String(raw).trim();
    if (s === "" || isExternalRef(s)) return;
    strings.add(s);
    const plain = stripQueryHash(s);
    if (plain === "") return;
    // dirs 只收「纯目录前缀」——字面上就写成 "fonts/" 的那种拼接式引用。
    // 不能从完整路径反推目录：否则 icons/ 一旦被提到，里面所有文件都算被引用，
    // 死文件就永远查不出来了。
    if (plain.endsWith("/")) dirs.add(plain);
    else {
      const parts = plain.split("/");
      locals.add(parts[parts.length - 1]);
    }
    const resolved = resolveRef(s, filePath);
    if (resolved != null && resolved !== "") refs.add(resolved);
  };

  return { add, refs, locals, dirs, strings };
}

/* --------------------------- JS：走真正的 AST --------------------------- */

let acornParse = (code) => {
  try {
    return parse(code, {
      ecmaVersion: "latest",
      sourceType: "script",
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      allowHashBang: true,
    });
  } catch {
    return null;
  }
};

/** 通用 AST 遍历（acorn 的树没有 parent 指针，安全）。 */
function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
    return;
  }
  if (typeof node.type !== "string") return;
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === "type" || key === "start" || key === "end" || key === "loc") continue;
    const value = node[key];
    if (value && typeof value === "object") walk(value, visit);
  }
}

/** 用 acorn 抽 JS 里的字符串字面量；解不开返回 null（交给调用方退回正则）。 */
export function jsStringLiterals(code) {
  const ast = acornParse(code);
  if (!ast) return null;
  const out = [];
  walk(ast, (node) => {
    if (node.type === "Literal" && typeof node.value === "string") out.push(node.value);
    else if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
      out.push(node.quasis.map((q) => q.value.cooked ?? q.value.raw).join(""));
    }
  });
  return out;
}

/** 正则兜底（只在 AST 解不开时用）。 */
function regexStringLiterals(code) {
  const out = [];
  for (const m of code.matchAll(/["'`]([^"'`\n\\]{1,300})["'`]/g)) out.push(m[1]);
  return out;
}

/**
 * 从 JS 里抽引用。
 * @param {string} code
 * @param {string} filePath
 */
export function extractJsRefs(code, filePath = "") {
  const c = makeCollector(filePath);
  const literals = jsStringLiterals(code) ?? regexStringLiterals(code);
  for (const s of literals) if (looksLikePath(s)) c.add(s);
  // 拼接式引用（"fonts/" + name + ".woff2"）只能靠零散片段认出来
  for (const s of literals) if (s.endsWith("/")) c.add(s);
  return { refs: c.refs, locals: c.locals, dirs: c.dirs, strings: c.strings };
}

/* --------------------- HTML / CSS / JSON：走文本规则 --------------------- */

/** 从 srcset 里取出候选 URL（逗号分隔，跳过 2x / 640w 这类描述符）。 */
function parseSrcset(value) {
  return String(value)
    .split(",")
    .map((part) => part.trim().split(/\s+/)[0])
    .filter(Boolean);
}

/**
 * 从一个文本文件里抽出所有引用（HTML 属性、url()、@import，以及内联脚本里的字符串）。
 * @returns {{refs:Set<string>, locals:Set<string>, dirs:Set<string>, strings:Set<string>}}
 */
export function extractRefs(text, filePath = "") {
  const c = makeCollector(filePath);
  const src = String(text);

  // HTML 属性：src / href / poster / data-src / srcset。
  // 第三种分支是**不带引号**的属性值（HTML5 合法，激进压缩也会产出这种形式），
  // 只认带引号的写法会让校验漏掉引用 —— 漏掉的正好是要检查的东西。
  const attrRe =
    /\b(?:src|href|poster|data-src|data-href|srcset)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+))/gi;
  for (const m of src.matchAll(attrRe)) {
    const value = m[1] ?? m[2] ?? m[3] ?? "";
    if (/srcset/i.test(m[0])) parseSrcset(value).forEach(c.add);
    else c.add(value);
  }

  // CSS：url(...) 与 @import。**不加 i 标志** —— 否则 JS 里的 new URL(req.url)
  // 会被当成一条 url() 引用，压缩改了变量名就误报「引用丢失」。
  for (const m of src.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^'")]*))\s*\)/g)) {
    c.add(m[1] ?? m[2] ?? m[3] ?? "");
  }
  for (const m of src.matchAll(/@import\s+(?:url\(\s*)?(?:"([^"]+)"|'([^']+)')/gi)) {
    c.add(m[1] ?? m[2] ?? "");
  }

  // 内联 <script>：用 acorn 逐段过一遍，避免正则配对引号跑偏
  for (const m of src.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    const body = m[1];
    if (!body || !body.trim()) continue;
    const literals = jsStringLiterals(body) ?? regexStringLiterals(body);
    for (const s of literals) if (looksLikePath(s)) c.add(s);
  }

  // 兜底：整份文本里的字符串（JSON / manifest / 属性值里带路径的情况）
  for (const s of regexStringLiterals(src)) if (looksLikePath(s)) c.add(s);

  return { refs: c.refs, locals: c.locals, dirs: c.dirs, strings: c.strings };
}

/** 按扩展名选抽取方式。 */
export function extractRefsAuto(text, filePath) {
  const ext = String(filePath).split(".").pop().toLowerCase();
  if (ext === "js" || ext === "mjs" || ext === "cjs") return extractJsRefs(text, filePath);
  return extractRefs(text, filePath);
}

/**
 * 每个文件「被引用」的判定。
 * @param {Array<{path:string}>} files 站点里的全部文件
 * @param {Map<string, {refs:Set<string>, locals:Set<string>, dirs:Set<string>}>} graph
 */
export function buildReferenceReport(files, graph) {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const referenced = new Set();
  const unresolved = [];

  for (const [from, entry] of graph) {
    for (const ref of entry.refs) {
      if (byPath.has(ref)) {
        referenced.add(ref);
        continue;
      }
      if (byPath.has(`${ref}/index.html`)) {
        referenced.add(`${ref}/index.html`);
        continue;
      }
      // 只在「看起来确实是个文件」时才报断链
      // 排除 "a/..."、"*"、"|"、"(" 这类明显不是文件名的东西
      // （注意别把普通的 "." 也算进去：那会把所有 a/b.png 都误杀）
      if ((ASSET_EXT_RE.test(ref) || /\//.test(ref)) && !/[*|()\\]|\.\.\./.test(ref)) {
        unresolved.push({ from, ref });
      }
    }
  }

  // 兜底：basename 命中或目录前缀命中，也认为「可能被引用」
  const allLocals = new Set();
  const allDirs = new Set();
  for (const entry of graph.values()) {
    entry.locals.forEach((v) => allLocals.add(v));
    entry.dirs.forEach((v) => allDirs.add(v));
  }

  const unreferenced = [];
  for (const f of files) {
    if (f.path === "index.html") continue; // 入口永远要有
    if (referenced.has(f.path)) continue;
    const base = f.path.split("/").pop();
    if (allLocals.has(base)) {
      referenced.add(f.path);
      continue;
    }
    const dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/") + 1) : "";
    if (dir && allDirs.has(dir)) {
      referenced.add(f.path);
      continue;
    }
    unreferenced.push(f.path);
  }

  const seen = new Set();
  const unresolvedUnique = unresolved.filter((u) => {
    const k = `${u.from}->${u.ref}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return { referenced, unreferenced, unresolved: unresolvedUnique };
}
