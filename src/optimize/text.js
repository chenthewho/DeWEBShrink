/* ==========================================================================
   文本压缩：HTML / CSS / JS
   --------------------------------------------------------------------------
   这里是全项目最需要小心的地方。TapeCode 上的站点是**一堆各自独立的文件**：
   index.html 的内联脚本直接引用 clock.js / chain.js / pwa.js 暴露的全局
   （NixieClock / NixieChain / NixiePWA）。所以任何「重命名顶层标识符」的压缩都会
   把一个能跑的站点压成一堆 ReferenceError，而链上已经花掉的钱一分不退。

   实测（esbuild 0.25，非模块脚本）：
     · minify: true 会把 IIFE 内部的 const 重命名 —— 本项目的 clock.js / chain.js
       正好都是 IIFE，所以对它们是安全的；
     · 对**裸全局脚本**，esbuild 会保留顶层名字，但如果哪天它改了行为……
   所以这里不靠「相信」，靠**前后对拍**：
     1. 用 acorn 解出顶层声明的名字集合；
     2. 压缩后再检查这些名字是否全都还在；
     3. 只要少一个，就退回「只压空白和语法、绝不改名」的模式；
     4. 顺带检查所有资源引用字符串（"fonts/xxx.woff2" 这种）是否原样保留。
   任何一步出错都返回**原文**，绝不返回半成品。
   ========================================================================== */

"use strict";

import { parse } from "acorn";
import { transform } from "esbuild";

import { ASSET_EXT_RE, extractRefsAuto } from "../refs.js";

/* ------------------------------ 公共小工具 ------------------------------ */

function wordRe(name) {
  return new RegExp(`(^|[^\\w$])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\w$]|$)`);
}

/** 收集顶层声明出来的名字（含 var/let/const/function/class 的各种绑定形式）。 */
function topLevelNames(ast) {
  const names = new Set();
  const addPattern = (node) => {
    if (!node) return;
    switch (node.type) {
      case "Identifier":
        names.add(node.name);
        break;
      case "ObjectPattern":
        for (const p of node.properties) {
          if (p.type === "RestElement") addPattern(p.argument);
          else addPattern(p.value);
        }
        break;
      case "ArrayPattern":
        for (const el of node.elements) addPattern(el);
        break;
      case "AssignmentPattern":
        addPattern(node.left);
        break;
      case "RestElement":
        addPattern(node.argument);
        break;
      default:
        break;
    }
  };
  for (const node of ast.body) {
    switch (node.type) {
      case "VariableDeclaration":
        node.declarations.forEach((d) => addPattern(d.id));
        break;
      case "FunctionDeclaration":
      case "ClassDeclaration":
        if (node.id) names.add(node.id.name);
        break;
      case "ExportNamedDeclaration":
      case "ExportDefaultDeclaration":
        if (node.declaration) {
          if (node.declaration.id) names.add(node.declaration.id.name);
          if (node.declaration.declarations) {
            node.declaration.declarations.forEach((d) => addPattern(d.id));
          }
        }
        break;
      default:
        break;
    }
  }
  return names;
}

function tryParseJs(code) {
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
}

/** 输入里所有「像资源路径」的引用 + 所有字符串字面量（用于对拍）。 */
function stringLiterals(code) {
  const out = new Set();
  for (const m of code.matchAll(/["'`]([^"'`\n\\]{1,300})["'`]/g)) out.add(m[1]);
  return out;
}

/**
 * 一条压缩结果是否可信：**资源引用**一条都不能丢。
 * 只比「像文件的路径」，不然 `new URL(req.url)` 这种会被当成引用，
 * 变量名一改就误报，最后所有 JS 都不敢压了。
 */
function checkRefsPreserved(before, after, ext) {
  const isAsset = (r) => ASSET_EXT_RE.test(r);
  const a = [...extractRefsAuto(before, `x.${ext}`).refs].filter(isAsset);
  const b = new Set([...extractRefsAuto(after, `x.${ext}`).refs].filter(isAsset));
  return a.filter((r) => !b.has(r));
}

/* --------------------------------- JS --------------------------------- */

/**
 * 压 JS。返回 {code, mode, notes}，永不抛错；任何不确定都退回原文或最保守模式。
 * @param {string} code
 */
export async function minifyJs(code) {
  const notes = [];
  const original = code;

  // 用异步的 transform，不用 transformSync：同步版会阻塞 event loop，
  // 服务器上并发调用时整个进程会被卡住，连并发闸门和超时都跟着失效。
  const esbuildTry = async (opts) => {
    try {
      const out = await transform(code, { loader: "js", target: "es2020", legalComments: "none", ...opts });
      return out.code;
    } catch (err) {
      notes.push(`esbuild 解析失败：${err.message}`);
      return null;
    }
  };

  const ast = tryParseJs(code);
  const topNames = ast ? topLevelNames(ast) : null;
  if (!ast) notes.push("acorn 解不开，退回「只压空白」模式（不改任何名字）");

  let candidate = null;
  let mode = "none";

  if (ast) {
    const full = await esbuildTry({ minify: true });
    if (full) {
      // 顶层名字必须全都还在 —— 少一个就说明它被改名了，对跨文件引用是致命的
      const lost = [...topNames].filter((n) => !wordRe(n).test(full));
      if (lost.length === 0) {
        candidate = full;
        mode = "full";
      } else {
        notes.push(
          `完整压缩会重命名顶层标识符（${lost.slice(0, 5).join("、")}${lost.length > 5 ? " 等" : ""}），` +
            `已改为只压空白与语法`,
        );
      }
    }
  }

  if (!candidate) {
    const safe = await esbuildTry({ minifyWhitespace: true, minifySyntax: true });
    if (!safe) return { code: original, mode: "skipped", notes };
    candidate = safe;
    mode = "whitespace+syntax";
  }

  // 资源引用对拍
  const missingRefs = checkRefsPreserved(original, candidate, "js");
  if (missingRefs.length) {
    notes.push(`压缩后丢了引用 ${missingRefs.slice(0, 3).join("、")}，已保留原文`);
    return { code: original, mode: "skipped", notes };
  }

  // 再解一遍，确认产物本身是合法 JS
  if (!tryParseJs(candidate)) {
    notes.push("压缩产物无法解析，已保留原文");
    return { code: original, mode: "skipped", notes };
  }

  if (candidate.length >= original.length) {
    return { code: original, mode: "none", notes };
  }
  return { code: candidate, mode, notes };
}

/* --------------------------------- CSS --------------------------------- */

/** 抽出选择器里的类名 / id，压缩不允许弄丢任何一个（改名就等于样式全失效）。 */
function cssTokens(code) {
  const tokens = new Set();
  for (const m of code.matchAll(/[.#]([A-Za-z_][\w-]*)/g)) tokens.add(m[1]);
  for (const m of code.matchAll(/@(?:keyframes|font-face|media|supports|import)\b/g)) tokens.add(m[0]);
  return tokens;
}

export async function minifyCss(code) {
  const notes = [];
  const original = code;
  let candidate;
  try {
    candidate = (await transform(code, { loader: "css", minify: true, target: "es2020" })).code;
  } catch (err) {
    return { code: original, mode: "skipped", notes: [`esbuild 解析 CSS 失败：${err.message}`] };
  }

  const before = cssTokens(original);
  const lost = [...before].filter((t) => !candidate.includes(t));
  if (lost.length) {
    notes.push(`压缩后丢了选择器 ${lost.slice(0, 5).join("、")}，已保留原文`);
    return { code: original, mode: "skipped", notes };
  }
  const missingRefs = checkRefsPreserved(original, candidate, "css");
  if (missingRefs.length) {
    notes.push(`压缩后丢了 url() 引用 ${missingRefs.slice(0, 3).join("、")}，已保留原文`);
    return { code: original, mode: "skipped", notes };
  }
  if (candidate.length >= original.length) return { code: original, mode: "none", notes };
  return { code: candidate, mode: "minified", notes };
}

/* --------------------------------- HTML --------------------------------- */

let htmlMinifierMod = null;
async function loadHtmlMinifier() {
  if (htmlMinifierMod === null) {
    try {
      const m = await import("html-minifier-terser");
      htmlMinifierMod = m.minify ? m : (m.default ?? false);
    } catch {
      htmlMinifierMod = false;
    }
  }
  return htmlMinifierMod;
}

/** 元素标签直方图 —— 用来确认 HTML 没被压掉结构。 */
function tagHistogram(html) {
  const hist = new Map();
  for (const m of html.matchAll(/<([a-zA-Z][\w-]*)[\s/>]/g)) {
    const t = m[1].toLowerCase();
    hist.set(t, (hist.get(t) || 0) + 1);
  }
  return hist;
}

function inlineBlockCounts(html) {
  return {
    script: (html.match(/<script\b/gi) || []).length,
    style: (html.match(/<style\b/gi) || []).length,
  };
}

/**
 * 压 HTML。
 * @param {string} html
 * @param {{aggressive?:boolean, minifyInlineJs?:boolean, minifyInlineCss?:boolean}} [opts]
 */
export async function minifyHtml(html, opts = {}) {
  const { aggressive = false, minifyInlineJs = aggressive, minifyInlineCss = aggressive } = opts;
  const notes = [];
  const original = html;

  const hm = await loadHtmlMinifier();
  if (!hm) {
    return { code: original, mode: "skipped", notes: ["html-minifier-terser 不可用，跳过 HTML"] };
  }

  const base = {
    collapseWhitespace: aggressive ? true : "conservative",
    removeComments: true,
    removeAttributeQuotes: aggressive,
    removeOptionalTags: false, // 就算激进也不删可选闭合标签：解析器兼容性不值这点字节
    keepClosingSlash: true,
    caseSensitive: true,
    sortAttributes: false,
    sortClassName: false,
    minifyCSS: minifyInlineCss,
    minifyJS: minifyInlineJs,
  };

  let candidate;
  try {
    candidate = await hm.minify(original, base);
  } catch (err) {
    return { code: original, mode: "skipped", notes: [`HTML 压缩失败：${err.message}`] };
  }

  // 结构对拍：标签直方图、内联块数量、资源引用、id 集合
  const before = tagHistogram(original);
  const after = tagHistogram(candidate);
  const lostTags = [...before].filter(([t, n]) => (after.get(t) || 0) < n);
  if (lostTags.length) {
    notes.push(`压掉了标签 ${lostTags.map(([t]) => t).join("、")}，已保留原文`);
    return { code: original, mode: "skipped", notes };
  }
  const b = inlineBlockCounts(original);
  const a = inlineBlockCounts(candidate);
  if (a.script !== b.script || a.style !== b.style) {
    notes.push("内联 <script>/<style> 数量变了，已保留原文");
    return { code: original, mode: "skipped", notes };
  }
  const lostIds = [...original.matchAll(/\bid\s*=\s*["']?([^"'\s>]+)["']?/g)]
    .map((m) => m[1])
    .filter((id) => !candidate.includes(id));
  if (lostIds.length) {
    notes.push(`丢了 id=${lostIds.slice(0, 3).join("、")}，已保留原文`);
    return { code: original, mode: "skipped", notes };
  }
  const missingRefs = checkRefsPreserved(original, candidate, "html");
  if (missingRefs.length) {
    notes.push(`压丢了引用 ${missingRefs.slice(0, 3).join("、")}，已保留原文`);
    return { code: original, mode: "skipped", notes };
  }
  if (candidate.length >= original.length) return { code: original, mode: "none", notes };
  return { code: candidate, mode: aggressive ? "aggressive" : "conservative", notes };
}

/** 按扩展名分派。 */
export async function minifyByExt(code, ext, opts = {}) {
  switch (ext) {
    case "html":
    case "htm":
      return minifyHtml(code, opts);
    case "css":
      return await minifyCss(code);
    case "js":
    case "mjs":
    case "cjs":
      return await minifyJs(code);
    default:
      return { code, mode: "none", notes: [] };
  }
}
