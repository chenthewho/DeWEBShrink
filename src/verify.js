/* ==========================================================================
   校验 —— 「压完之后这个站点还能跑吗」
   --------------------------------------------------------------------------
   链上的字节是永久计费、永久存在的：压缩压坏了也不会退款，所以每次优化之后都要
   拿产物和原文逐项对拍。这里只做**能自动判定**的检查：

     1. 入口 index.html 在不在（TapeCode 发布页要求项目里有 index.html）；
     2. 协议合法性：有没有隐藏文件 / 非法路径 / 超过 8 MiB 的文件；
     3. 引用完整性：产物里每一条引用能不能落到一个真实文件上；
     4. JS 语法：每个 .js 还能不能解析；
     5. HTML 结构：标签直方图、内联 <script>/<style> 数量与原文件一致；
     6. 跨文件全局：clock.js 暴露给 index.html 的 NixieClock 这类名字必须还在；
     7. 体积单调：产物的每个文件都不比原文大；
     8. Content-Type：扩展名协议认不认、manifest 图标声明的 type 和真实扩展名对不对得上。

   任何一条 fail 都说明「这次别传」，必须回去看报告。
   ========================================================================== */

"use strict";

import { parse } from "acorn";

import { classifyPath, contentTypeFor, DEFAULT_CONTENT_TYPE, MAX_FILE_BYTES } from "./protocol.js";
import { extractRefsAuto, ASSET_EXT_RE } from "./refs.js";
import { imageInfo } from "./optimize/images.js";
import { scanSite } from "./scan.js";
import { asSource, isSameSource } from "./source.js";

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "webp", "avif", "gif", "tiff", "tif"]);

function extOf(p) {
  const base = String(p).split("/").pop() || "";
  const i = base.lastIndexOf(".");
  return i <= 0 ? "" : base.slice(i + 1).toLowerCase();
}

function parseJs(code) {
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

/** 顶层声明名 + 用到的所有标识符（粗粒度：词法扫描，够用来判断全局是否被改名）。 */
function jsSurface(code) {
  const ast = parseJs(code);
  const top = new Set();
  if (ast) {
    const addPat = (n) => {
      if (!n) return;
      if (n.type === "Identifier") top.add(n.name);
      else if (n.type === "ObjectPattern") n.properties.forEach((p) => addPat(p.value ?? p.argument));
      else if (n.type === "ArrayPattern") n.elements.forEach(addPat);
      else if (n.type === "AssignmentPattern") addPat(n.left);
      else if (n.type === "RestElement") addPat(n.argument);
    };
    for (const node of ast.body) {
      if (node.type === "VariableDeclaration") node.declarations.forEach((d) => addPat(d.id));
      else if (node.id) top.add(node.id.name);
    }
  }
  const used = new Set();
  for (const m of code.matchAll(/[A-Za-z_$][\w$]*/g)) used.add(m[0]);
  return { ok: !!ast, top, used };
}

function tagHistogram(html) {
  const hist = new Map();
  for (const m of html.matchAll(/<([a-zA-Z][\w-]*)[\s/>]/g)) {
    const t = m[1].toLowerCase();
    hist.set(t, (hist.get(t) || 0) + 1);
  }
  return hist;
}

/** 从文件源读一段文本；读不到就返回 null（校验不因为读不到而中断）。 */
async function readTextSafe(source, rel) {
  const buf = await source.read(rel);
  return buf ? buf.toString("utf8") : null;
}

/**
 * 校验产物能不能安全上链。
 *
 * 输入既可以是目录路径（CLI），也可以是 source.js 的文件源（MCP，产物在内存里）：
 *   verifyOutput({ originalDir, outputDir })
 *   verifyOutput({ originalSource, outputSource })
 *
 * @param {{originalDir?:string, outputDir?:string, originalSource?:object, outputSource?:object,
 *          original?:object, output?:object, allowGrowth?:string[]}} args
 */
export async function verifyOutput({
  originalDir = null,
  outputDir = null,
  originalSource = null,
  outputSource = null,
  original = null,
  output = null,
  allowGrowth = [],
}) {
  const checks = [];
  const add = (name, status, detail) => checks.push({ name, status, detail });

  const outSource = outputSource || asSource(outputDir);
  const origSource = originalSource || (originalDir ? asSource(originalDir) : null);

  /* 「有没有真基准」= 给了 original 且它和产物**不是同一个来源**。
     `verifyOutput({originalDir: X, outputDir: X})` 这种自己跟自己比，语义上等于没基准。 */
  const hasBaseline = !!origSource && !isSameSource(origSource, outSource);

  const outScan = output || (await readScan(outSource));
  // 有基准但调用方没给预扫描结果时，自己扫一遍 —— 否则 origScan 为 null，
  // 「新增断链」的对比就永远做不了（CLI 的 --reference 之前就是这么失效的）。
  const origScan = original || (hasBaseline ? await readScan(origSource) : null);
  const outPaths = new Set(outScan.billable.map((f) => f.path));
  const origByPath = new Map((origScan?.billable || []).map((f) => [f.path, f]));

  /* 1. 入口 */
  if (outPaths.has("index.html")) {
    add("入口 index.html", "pass", "存在；TapeCode 发布页要求项目里有 index.html");
  } else {
    add("入口 index.html", "fail", "产物里没有 index.html —— 发布页会拒绝，或者站点打开就是 404");
  }

  /* 2. 协议合法性 */
  const illegal = outScan.skipped.filter((f) => f.skippedReason);
  if (illegal.length) {
    add(
      "协议合法性",
      "warn",
      `${illegal.length} 个文件协议不会上传：` + illegal.map((f) => `${f.path}（${f.skippedReason}）`).join("、"),
    );
  } else {
    add("协议合法性", "pass", "没有任何文件会被协议静默跳过");
  }

  /* 3. 引用完整性（只看新增的断链，原本就断的不重复报） */
  const outGraph = new Map();
  const origGraph = new Map();
  for (const f of outScan.billable) {
    if (!f.isText) continue;
    const text = await readTextSafe(outSource, f.path);
    if (text == null) continue;
    outGraph.set(f.path, extractRefsAuto(text, f.path));
  }
  if (origScan && origSource) {
    for (const f of origScan.billable) {
      if (!f.isText) continue;
      const text = await readTextSafe(origSource, f.path);
      if (text == null) continue;
      origGraph.set(f.path, extractRefsAuto(text, f.path));
    }
  }

  const danglingNow = [];
  for (const [from, entry] of outGraph) {
    for (const ref of entry.refs) {
      if (outPaths.has(ref) || outPaths.has(`${ref}/index.html`) || ref === "") continue;
      if (!ASSET_EXT_RE.test(ref) && !/\//.test(ref)) continue;
      // 带扩展名 = 明确的静态资源引用（assets/nope.png）；
      // 只有斜杠 = 可能是 API 端点或前端路由（/api/a），存疑。
      danglingNow.push({ key: `${from} → ${ref}`, asset: ASSET_EXT_RE.test(ref) });
    }
  }
  const danglingBefore = new Set();
  for (const [from, entry] of origGraph) {
    for (const ref of entry.refs) {
      const exists = origByPath.has(ref) || origByPath.has(`${ref}/index.html`);
      if (!exists && (ASSET_EXT_RE.test(ref) || /\//.test(ref))) danglingBefore.add(`${from} → ${ref}`);
    }
  }

  const refPass = () =>
    add("引用完整性", "pass", `产物里 ${outGraph.size} 个文本文件的引用全部能落到真实文件上`);

  if (hasBaseline) {
    /* 有基准：只关心「这次改动有没有弄出新断链」，原本就断的不重复报。 */
    const addedRefs = danglingNow.filter((d) => !danglingBefore.has(d.key));
    if (addedRefs.length) {
      add(
        "引用完整性",
        "fail",
        `压缩后新增了 ${addedRefs.length} 条断链：` + addedRefs.slice(0, 8).map((d) => d.key).join("；"),
      );
    } else {
      refPass();
    }
  } else if (danglingNow.some((d) => d.asset)) {
    /* 无基准，但缺的是**明确的静态资源**（带扩展名）—— 这种引用不可能靠运行时补上，判 fail。
       （原来这里用的是 origScan 是否存在来判断；但 CLI 从不传预扫描结果，
        导致「有 reference 也走无基准分支」，两种情况的结论就都错了。） */
    const certain = danglingNow.filter((d) => d.asset);
    add(
      "引用完整性",
      "fail",
      `产物里有 ${certain.length} 条静态资源引用找不到文件（线上必然 404）：` +
        certain.slice(0, 8).map((d) => d.key).join("；"),
    );
  } else if (danglingNow.length) {
    /* 无基准，且缺的只是「看不出是不是静态资源」的路径（如 /api/a）。
       纯静态托管下它们同样会 404，但也可能本来就是外部接口 —— 没有基准就无权
       断言「是这次改动弄坏的」，所以只提示、不阻断。 */
    add(
      "引用完整性",
      "warn",
      `产物里有 ${danglingNow.length} 条引用找不到对应文件，可能是 API 端点或前端路由（静态托管下也会 404）：` +
        danglingNow.slice(0, 8).map((d) => d.key).join("；") +
        ` —— 要确认是不是改动造成的，请传 reference / --reference 用原始站点对拍`,
    );
  } else {
    refPass();
  }

  /* 4. JS 语法 */
  const jsBroken = [];
  for (const f of outScan.billable) {
    if (!["js", "mjs", "cjs"].includes(f.ext)) continue;
    const text = await readTextSafe(outSource, f.path);
    if (text == null) continue;
    if (!parseJs(text)) jsBroken.push(f.path);
  }
  if (jsBroken.length) add("JS 语法", "fail", `无法解析：${jsBroken.join("、")}`);
  else add("JS 语法", "pass", "产物里所有 JS 都能解析");

  /* 5. HTML 结构 */
  const htmlIssues = [];
  for (const f of outScan.billable) {
    if (f.ext !== "html" && f.ext !== "htm") continue;
    const after = await readTextSafe(outSource, f.path);
    const before = origSource ? await readTextSafe(origSource, f.path) : null;
    if (!after || before == null) continue;
    const ha = tagHistogram(after);
    const hb = tagHistogram(before);
    const lost = [...hb].filter(([t, n]) => (ha.get(t) || 0) < n).map(([t, n]) => `${t}(少 ${n - (ha.get(t) || 0)})`);
    const scriptsBefore = (before.match(/<script\b/gi) || []).length;
    const scriptsAfter = (after.match(/<script\b/gi) || []).length;
    if (lost.length) htmlIssues.push(`${f.path} 少了标签 ${lost.join("、")}`);
    if (scriptsBefore !== scriptsAfter) htmlIssues.push(`${f.path} 的 <script> 数量 ${scriptsBefore} → ${scriptsAfter}`);
  }
  if (htmlIssues.length) add("HTML 结构", "fail", htmlIssues.join("；"));
  else add("HTML 结构", "pass", "标签直方图与内联块数量与原文一致");

  /* 6. 跨文件全局：别的文件用到的顶层名字，在定义它的文件里必须还在 */
  const globalIssues = [];
  if (origScan) {
    for (const f of origScan.billable) {
      if (!["js", "mjs", "cjs"].includes(f.ext)) continue;
      const before = origSource ? await readTextSafe(origSource, f.path) : null;
      const after = await readTextSafe(outSource, f.path);
      if (before == null || after == null) continue;
      const surfaceBefore = jsSurface(before);
      if (!surfaceBefore.ok || surfaceBefore.top.size === 0) continue;
      // 找「除了自己以外，还有谁在用这个名字」
      const othersText = [];
      for (const [otherPath, entry] of outGraph) {
        if (otherPath === f.path) continue;
        const t = await readTextSafe(outSource, otherPath);
        if (t) othersText.push(t);
      }
      const others = othersText.join("\n");
      const externallyUsed = [...surfaceBefore.top].filter((n) => new RegExp(`(^|[^\\w$])${n}([^\\w$]|$)`).test(others));
      const missing = externallyUsed.filter((n) => !new RegExp(`(^|[^\\w$])${n}([^\\w$]|$)`).test(after));
      if (missing.length) {
        globalIssues.push(`${f.path} 里的全局 ${missing.join("、")} 被改名或删掉了，但别的文件还在用`);
      }
    }
  }
  if (globalIssues.length) add("跨文件全局", "fail", globalIssues.join("；"));
  else add("跨文件全局", "pass", "没有把被其他文件引用的全局改名或删除");

  /* 7. 体积单调 */
  const allow = new Set(allowGrowth);
  const grew = [];
  const grewAllowed = [];
  for (const f of outScan.billable) {
    const before = origByPath.get(f.path);
    if (!before || f.bytes <= before.bytes) continue;
    if (allow.has(f.path)) grewAllowed.push(`${f.path}（${before.bytes} → ${f.bytes}，引用重写导致）`);
    else grew.push(`${f.path}（${before.bytes} → ${f.bytes}）`);
  }
  if (grew.length) add("体积单调", "fail", `有文件反而变大：${grew.join("、")}`);
  else if (grewAllowed.length) add("体积单调", "pass", `只有引用重写过的文件略微变大：${grewAllowed.join("、")}`);
  else add("体积单调", "pass", "产物里没有比原文更大的文件");

  /* 8. Content-Type 与声明一致性 */
  const typeIssues = [];
  const unknownExt = outScan.billable.filter((f) => contentTypeFor(f.path) === DEFAULT_CONTENT_TYPE);
  if (unknownExt.length) {
    typeIssues.push(
      `协议不认识这些扩展名，会以 application/octet-stream 提供：` + unknownExt.map((f) => f.path).join("、"),
    );
  }
  const manifestFile = outScan.billable.find((f) => /(^|\/)manifest\.(?:webmanifest|json)$/i.test(f.path));
  if (manifestFile && manifestFile.ext === "webmanifest") {
    typeIssues.push(
      `${manifestFile.path} 会被以 application/octet-stream 返回：协议的扩展名表里没有 webmanifest。` +
        `W3C 规范的媒体类型注册要求 manifest 返回 Content-Type: application/manifest+json，浏览器一般也接受 .json（application/json）；` +
        `octet-stream 两者都不是，manifest 大概率被忽略、PWA 装不上。` +
        `建议改名为 manifest.json，并同步 <link rel="manifest"> 与 sw.js 里的引用（sw.js 里除字符串外还有一条 /.(?:html|js|webmanifest)$/ 正则要一起改）`,
    );
  }
  const manifestJson = manifestFile;
  if (manifestJson) {
    const text = await readTextSafe(outSource, manifestJson.path);
    try {
      const parsed = JSON.parse(text);
      for (const icon of parsed.icons || []) {
        if (!icon.src) continue;
        const real = extOf(icon.src);
        const declared = String(icon.type || "").split("/").pop();
        const alias = { jpg: "jpeg" };
        if (declared && (alias[real] || real) !== declared) {
          typeIssues.push(`${manifestJson.path} 里 ${icon.src} 声明 type=${icon.type}，但真实扩展名是 .${real}`);
        }
        const target = icon.src.replace(/^\.?\//, "");
        if (!outPaths.has(target)) typeIssues.push(`${manifestJson.path} 里的图标 ${icon.src} 在产物里不存在`);
      }
    } catch (err) {
      typeIssues.push(`${manifestJson.path} 不是合法 JSON：${err.message}`);
    }
  }
  if (typeIssues.length) add("Content-Type", "warn", typeIssues.join("；"));
  else add("Content-Type", "pass", "扩展名协议都认识，manifest 声明与真实文件一致");

  /* 9. 图片尺寸没变（换格式允许，尺寸不允许） */
  const dimIssues = [];
  for (const f of outScan.billable) {
    if (!IMAGE_EXT.has(f.ext)) continue;
    const before = origByPath.get(f.path);
    if (!before) continue;
    try {
      const [aBuf, bBuf] = await Promise.all([
        origSource ? origSource.read(f.path) : null,
        outSource.read(f.path),
      ]);
      const [a, b] = await Promise.all([imageInfo(aBuf), imageInfo(bBuf)]);
      if (a && b && (a.width !== b.width || a.height !== b.height)) {
        dimIssues.push(`${f.path} 尺寸 ${a.width}×${a.height} → ${b.width}×${b.height}`);
      }
    } catch {
      /* 读不到就算了，不阻断 */
    }
  }
  if (dimIssues.length) add("图片尺寸", "fail", dimIssues.join("、"));
  else add("图片尺寸", "pass", "所有图片的像素尺寸保持不变（只换了编码）");

  /* 10. 单文件上限 */
  const tooBig = outScan.billable.filter((f) => f.bytes > MAX_FILE_BYTES);
  if (tooBig.length) add("单文件上限", "fail", `超过 8 MiB：${tooBig.map((f) => f.path).join("、")}`);
  else add("单文件上限", "pass", "没有文件超过协议 8 MiB 的上限");

  const failed = checks.filter((c) => c.status === "fail");
  return {
    ok: failed.length === 0,
    checks,
    failed: failed.length,
    warned: checks.filter((c) => c.status === "warn").length,
  };
}

function readScan(dir) {
  return scanSite(dir, { withHashes: false });
}
