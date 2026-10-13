#!/usr/bin/env node
/* ==========================================================================
   pen-to-site.mjs —— 从 Pencil 设计稿生成站点页面
   --------------------------------------------------------------------------
   输入  web/design/DeWEBSharink.pen        设计稿（唯一真相源）
         web/design/icons/*.svg             lucide 图标（设计稿里 icon 节点的 library）
         web/design/faq-extra.json          设计稿没展开的 10 条 FAQ 答案
   输出  web/index.html                     中文页（默认）
         web/en/index.html                  英文页
         web/assets/pen.css                 设计稿生成的样式（按样式签名去重）
         web/assets/favicon.svg

   设计稿的约束（已验证，生成器依赖这些约定）：
     · 只有 frame / text / rectangle / ellipse / icon 五种节点，没有图片、阴影、渐变、旋转
     · frame 的 layout 只有 "vertical"；没有 layout 的 frame 就是横向 flex
     · layout 父节点里的子节点**不带** x/y（纯 auto-layout），所以能一比一映射成 flexbox
     · fill 只引用 variables（$bg / $phosphor / …），没有裸 hex
     · 两种语言的节点 name 完全相同（只有 content 不同），所以 hook 可以按 name 路径匹配

   用法：node web/tools/pen-to-site.mjs
   ========================================================================== */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const DESIGN = path.join(ROOT, "web/design");
const OUT = path.join(ROOT, "web");
const ASSETS = path.join(OUT, "assets");

const pen = JSON.parse(fs.readFileSync(path.join(DESIGN, "DeWEBSharink.pen"), "utf8"));
const faqExtra = JSON.parse(fs.readFileSync(path.join(DESIGN, "faq-extra.json"), "utf8"));

/* ------------------------------------------------------------------ tokens */

const VARS = pen.variables;
const color = (v) => (typeof v === "string" && v.startsWith("$") ? VARS[v.slice(1)]?.value ?? v : v);
const fontStack = {
  mono: "var(--pen-mono)",
  sans: "var(--pen-sans)",
  display: "var(--pen-display)",
  pixel: "var(--pen-pixel)",
};
const font = (v) => fontStack[String(v).replace("$", "")] ?? "var(--pen-sans)";

/* ------------------------------------------------------------------- icons */

const iconCache = new Map();
function icon(name) {
  if (iconCache.has(name)) return iconCache.get(name);
  const raw = fs.readFileSync(path.join(DESIGN, "icons", `${name}.svg`), "utf8");
  const viewBox = (raw.match(/viewBox="([^"]+)"/) || [])[1] ?? "0 0 24 24";
  const inner = raw
    .replace(/^[\s\S]*?<svg[^>]*>/, "")
    .replace(/<\/svg>[\s\S]*$/, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .trim();
  const out = { viewBox, inner };
  iconCache.set(name, out);
  return out;
}

/* --------------------------------------------------- 样式签名 → 去重后的类名 */

const rules = new Map(); // className -> 声明串
const classCache = new Map(); // 声明串 -> className
let classSeq = 0;

function cls(decls) {
  const body = Object.entries(decls)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}:${v}`)
    .sort()
    .join(";");
  if (!body) return "";
  if (!classCache.has(body)) {
    const name = `n${(++classSeq).toString(36)}`;
    classCache.set(body, name);
    rules.set(name, body);
  }
  return classCache.get(body);
}

/* ------------------------------------------------------------- 布局计算 */

const pad = (v) => {
  if (v === undefined) return null;
  if (typeof v === "number") return `${v}px`;
  if (v.length === 2) return `${v[0]}px ${v[1]}px`;
  if (v.length === 3) return `${v[0]}px ${v[1]}px ${v[2]}px`;
  return `${v[0]}px ${v[1]}px ${v[2]}px ${v[3]}px`;
};

/** fill_container 在 flex 里的两种含义：主轴填充 vs 交叉轴拉伸。 */
function fillOn(axis) {
  return axis === "row" ? { flex: "1 1 0", "min-width": "0" } : { width: "100%", "min-width": "0" };
}

function boxDecls(node, parentAxis, isRoot) {
  const d = {};
  const axis = node.layout === "vertical" ? "column" : "row";
  const hasKids = (node.children ?? []).length > 0;

  if (node.type === "frame") {
    d.display = hasKids ? "flex" : "block";
    if (hasKids && axis === "column") d["flex-direction"] = "column";
    if (node.gap !== undefined) d.gap = `${node.gap}px`;
    if (node.justifyContent === "space_between") d["justify-content"] = "space-between";
    else if (node.justifyContent === "center") d["justify-content"] = "center";
    if (node.alignItems === "center") d["align-items"] = "center";
    else if (node.alignItems === "end") d["align-items"] = "flex-end";
    else if (hasKids) d["align-items"] = "flex-start";
    if (node.clip && !isRoot) d.overflow = "hidden";
  } else {
    d["flex-shrink"] = "0";
  }

  if (node.width === "fill_container") Object.assign(d, fillOn(parentAxis));
  else if (typeof node.width === "number") d.width = `${node.width}px`;

  if (node.height === "fill_container") Object.assign(d, axis === "column" ? { flex: "1 1 0" } : { "align-self": "stretch" });
  else if (typeof node.height === "number") d.height = `${node.height}px`;

  if (node.layoutPosition === "absolute") {
    d.position = "absolute";
    if (typeof node.x === "number") d.left = `${node.x}px`;
    if (typeof node.y === "number") d.top = `${node.y}px`;
  }

  const padding = pad(node.padding);
  if (padding) d.padding = padding;

  if (node.fill !== undefined && node.type !== "text" && node.type !== "icon") {
    if (typeof node.fill === "object") {
      /* shader / 渐变这类填充不写进公共 class（否则同签名的节点会互相污染），
         改成按节点 id 记下来，渲染时写 data-shader + 行内 CSS 变量 */
      shaderOf.set(node.id, node.fill);
      shaderUsed.add(node.fill?.type === "shader" ? node.fill.url : `unknown:${node.fill?.type}`);
    } else {
      d["background-color"] = color(node.fill);
    }
  }
  if (node.cornerRadius !== undefined) d["border-radius"] = `${node.cornerRadius}px`;

  if (node.stroke !== undefined) {
    const c = color(node.stroke);
    const w = node.strokeWidth ?? 1;
    if (typeof w === "number") d.border = `${w}px solid ${c}`;
    else {
      if (w.top) d["border-top"] = `${w.top}px solid ${c}`;
      if (w.right) d["border-right"] = `${w.right}px solid ${c}`;
      if (w.bottom) d["border-bottom"] = `${w.bottom}px solid ${c}`;
      if (w.left) d["border-left"] = `${w.left}px solid ${c}`;
    }
  }
  if (node.type === "rectangle" || node.type === "ellipse") d["flex-shrink"] = "0";
  return d;
}

function textDecls(node, parentAxis) {
  const d = {};
  if (node.width === "fill_container") Object.assign(d, fillOn(parentAxis));
  else if (typeof node.width === "number") d.width = `${node.width}px`;
  if (node.fontFamily !== undefined) d["font-family"] = font(node.fontFamily);
  if (node.fontSize !== undefined) d["font-size"] = `${node.fontSize}px`;
  if (node.fontWeight !== undefined) d["font-weight"] = String(node.fontWeight);
  if (node.lineHeight !== undefined) d["line-height"] = String(node.lineHeight);
  if (node.letterSpacing !== undefined) d["letter-spacing"] = `${node.letterSpacing}px`;
  if (node.textAlign !== undefined) d["text-align"] = node.textAlign;
  if (node.fill !== undefined) d.color = color(node.fill);
  if (node.textGrowth === "fixed-width") {
    d["white-space"] = "pre-wrap";
    d["overflow-wrap"] = "anywhere";
    d["min-width"] = "0";
  } else {
    d["white-space"] = "nowrap";
  }
  return d;
}

/* ------------------------------------------------------------ 交互 hook 表 */

/* ------------------------------------------------- 可复用组件（ref 节点）

   设计稿里 Cassette 是一个 reusable 组件，英文帧与手机版用 `ref` 引用它。
   ref 节点只有 {type:"ref", ref:"<组件 id>", name}，渲染时取出定义再画一遍。 */

const REUSABLES = new Map();
(function indexReusables(n) {
  if (n.reusable && n.id) REUSABLES.set(n.id, n);
  for (const c of n.children ?? []) indexReusables(c);
})(pen);

/* ------------------------------------------------------- shader 填充支持 */

/** node.id → {type:"shader", url, uniforms}；这些节点由 site.css 里的 [data-shader] 规则上色。 */
const shaderOf = new Map();
const shaderUsed = new Set();

/** 解析 .glsl 头部注释里的 @default / @color，拿到 uniform 的默认值。 */
function shaderUniforms(url) {
  const file = path.join(DESIGN, "shaders", url);
  if (!fs.existsSync(file)) return null;
  const src = fs.readFileSync(file, "utf8");
  const out = {};
  /* 注释块 + uniform 声明成对出现：`/** @default 3 *\/ uniform float u_line;` */
  const re = /\/\*\*([\s\S]*?)\*\/\s*uniform\s+\w+\s+(\w+)\s*;/g;
  for (const m of src.matchAll(re)) {
    const [, comment, name] = m;
    const def = (comment.match(/@default\s+([^\s*]+)/) || [])[1];
    if (def) out[name] = def; // 没有 @default 的（如 u_resolution）由运行时提供，跳过
  }
  return out;
}

const SHADER_UNIFORM_DEFAULTS = {};
for (const url of ["perf.glsl", "tape-grid.glsl", "crt-scan.glsl"]) {
  SHADER_UNIFORM_DEFAULTS[url] = shaderUniforms(url) ?? {};
}

/** 设计稿给的 uniforms + glsl 里的默认值 → 行内 CSS 变量串。 */
function shaderStyle(url, uniforms = {}) {
  const defaults = SHADER_UNIFORM_DEFAULTS[url] ?? {};
  const merged = { ...defaults, ...uniforms };
  const parts = [];
  for (const [k, v] of Object.entries(merged)) {
    const short = k.replace(/^u_/, "").replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    parts.push(`--sh-${short}:${color(String(v))}`);
  }
  return parts.join(";");
}

/** 路径模式匹配（按 "/" 分段，`*` 匹配任意一段），命中即打 data-hook。
    两个语言页的 name 路径完全一致，所以一套模式够用。 */
/* 第三项是「这套 hook 在哪几个页面上存在」，缺省 = 桌面两页（zh/en）。
   手机版是设计稿里的另一条流程，节点名字完全不同，所以单独列。 */
const DESKTOP = ["zh", "en"];
const MOBILE = ["m"];
/** 设计稿里目前只有中文帧更新了这一块（英文帧待补） */
const ZH_ONLY = DESKTOP;

const HOOKS = [
  ["S1 Nav/Brand", "brand"],
  ["S1 Nav/Nav Actions/Docs Button", "docs-button"],
  ["S1 Nav/Nav Actions/Primary CTA", "nav-cta"],
  ["S1 Nav/Nav Actions/Lang Toggle/ZH Active", "lang-zh"],
  ["S1 Nav/Nav Actions/Lang Toggle/EN", "lang-en"],
  ["S2 Hero/Hero Top/Hero Copy/Hero CTAs/Drop CTA", "hero-cta"],
  ["S2 Hero/Hero Top/Hero Copy/Hero CTAs/Secondary Btn", "hero-secondary"],
  ["Checkup Console/Console Bar/Console Title", "console-title"],
  ["Checkup Console/Console Bar/Lamp/Runtime Text", "runtime-text"],
  ["Checkup Console/Console Bar/Lamp/Runtime LED", "runtime-led"],
  ["Console Body/Drop Column/Dropzone", "dropzone"],
  ["Console Body/Drop Column/Dropzone/Choose Folder", "choose-folder"],
  ["Console Body/Drop Column/First Load Note", "first-load-note"],
  ["Console Body/Drop Column/Support Note", "support-note"],
  ["Console Body/Drop Column/Dropzone/Drop Title", "drop-title"],
  ["Console Body/Drop Column/Dropzone/Divider Row", "drop-divider"],
  ["Params Column/gasPrice/Input/V", "gas-price"],
  ["Params Column/BNB 价格/Input/V", "bnb-price"],
  ["Params Column/BNB 价格/Lab/L", "price-label"],
  ["Chain Seg/BSC", "chain-bsc"],
  ["Chain Seg/X Layer", "chain-xlayer"],
  ["Chain Seg/Base", "chain-base"],
  ["Presets/安全档 · 默认", "preset-safe"],
  ["Presets/激进档 · 即将支持", "preset-aggressive"],
  ["Presets/转换 WebP · 即将支持", "preset-webp"],
  ["Params Column/Run Button", "run"],
  ["S3-F Bill/Result Head/RL/Conditions", "bill-conditions"],
  ["S3-F Bill/Result Head/Status Badge/Badge Text", "bill-badge"],
  ["S3-F Bill/Result Head/Status Badge/Check Icon", "badge-icon"],
  ["Bill Table/优化前", "row-before"],
  ["Bill Table/优化后", "row-after"],
  ["Bill Table/省下", "row-saved"],
  ["Bill Table/Head", "bill-head"],
  ["S3-F Bill/Table Note", "table-note"],
  ["S3-F Bill/Actions/Download", "download"],
  ["S3-F Bill/Actions/复制 JSON", "copy-json"],
  ["S3-F Bill/Actions/展开完整报告", "full-report"],
  ["S3-F Bill/Actions/Delta Link", "delta-link"],
  ["S3-G Verification/Ver Head/VHL/V Title", "ver-title"],
  ["S3-G Verification/Ver Head/VHL/V Sub", "ver-sub"],
  ["S3-G Verification/Ver Head/V Count", "ver-count"],
  ["S3-G Verification/Check Columns", "ver-cols"],
  ["S3-G Verification/Check Columns/Col/*", "check-row"],
  ["S3-G Verification/Check Columns/Col/*/Icon", "check-icon"],
  ["S3-G Verification/Check Columns/Col/*/T/N", "check-name"],
  ["S3-G Verification/Check Columns/Col/*/T/D", "check-detail"],
  ["S11 FAQ/FAQ List/*", "faq-item"],
  ["S11 FAQ/FAQ List/*/Q", "faq-q"],
  ["S11 FAQ/FAQ List/*/A", "faq-a"],
  ["S3-G Verification/Ver States", "state-gallery"],
  ["S3-G Verification/Fail Examples", "fail-examples"],
  ["S3 Checkup/S3-D Mobile Fallback", "mobile-fallback"],
  ["S3 Checkup/S3-H Details", "details"],
  ["S3-H Details/改了什么（按体积）/HR/R", "detail-changed-count"],
  ["S3-H Details/改了什么（按体积）/Body", "detail-changed-body"],
  ["S3-H Details/没写进产物/HR/R", "detail-dropped-count"],
  ["S3-H Details/保留的约定文件/HR/R", "detail-convention-count"],
  ["S3-H Details/改了文件名/HR/R", "detail-renames-count"],
  ["S3-H Details/还能再省/HR/R", "detail-opportunities-count"],
  ["S3-H Details/Details Head", "details-head"],
  ["S3 Checkup/S3-I Errors", "errors-gallery"],
  ["S10 Get Started/Tabs/网页版（本页）", "tab-web"],
  ["S10 Get Started/Tabs/命令行 CLI", "tab-cli"],
  ["S10 Get Started/Tabs/MCP（给 agent 用）", "tab-mcp"],
  ["S10 Get Started/Web Panel", "panel-web"],
  ["S10 Get Started/Use Row/CLI Card", "panel-cli"],
  ["S10 Get Started/Use Row/MCP Card", "panel-mcp"],
  ["Floating CTA (fixed bottom-right)/Pill", "floating-cta"],

  /* ---- 磁带机隐喻：REC 灯 / 计数器 / 电平表 / 走带按钮 ---- */
  ["S1 Nav/Brand/Rec/Rec LED", "rec-led"],
  ["S1 Nav/Nav Actions/Tape Counter", "tape-counter"],
  ["S1 Nav/Nav Actions/VU Meter", "vu-meter"],
  ["Tape Module/Tape Info/Tape Code", "tape-code"],
  ["Tape Module/Tape Info/Tape Label", "tape-status"],
  ["Tape Module/Tape Info/Transport/Counter", "tape-count"],
  ["Tape Module/Tape Info/Transport/Mode", "tape-mode"],
  ["Tape Module/Tape Info/Transport/Play", "tape-play"],
  ["Tape Module/Tape Info/Transport/Stop", "tape-stop"],

  /* ---- 390 手机版：一条独立的流程 ---- */
  ["M Nav/Actions/Lang Toggle/ZH Active", "lang-zh", MOBILE],
  ["M Nav/Actions/Lang Toggle/EN", "lang-en", MOBILE],
  ["M Nav/Actions/Menu Button", "menu-button", MOBILE],
  ["M Nav/Tape Counter", "tape-counter", MOBILE],
  ["M Nav/VU Meter", "vu-meter", MOBILE],
  ["M Nav/Brand/Rec/Rec LED", "rec-led", MOBILE],
  ["M Hero/Tape Module/Tape Info/Tape Code", "tape-code", MOBILE],
  ["M Hero/Tape Module/Tape Info/Tape Label", "tape-status", MOBILE],
  ["M Hero/CTAs/Primary", "hero-cta", MOBILE],
  ["M Hero/CTAs/Secondary", "hero-secondary", MOBILE],
  ["Checkup Console/Console Body/Mobile Fallback/Choose File", "choose-file", MOBILE],
  ["Checkup Console/Console Body/Assumptions Summary", "assumptions", MOBILE],
  ["Checkup Console/Console Body/Run Button", "run", MOBILE],
  ["M Running/Head/Cancel", "cancel", MOBILE],
  ["M Running/Segments", "segments", MOBILE],
  ["M Running/Current", "current-step", MOBILE],
  ["M Running/Note", "running-note", MOBILE],
  ["M Bill/Head/L/T", "bill-title", MOBILE],
  ["M Bill/Head/L/C", "bill-conditions", MOBILE],
  ["M Bill/Head/Badge", "bill-badge", MOBILE],
  ["M Bill/Head/Badge/T", "bill-badge-text", MOBILE],
  ["Numbers/省下 / SAVED/V", "saved-usd", MOBILE],
  ["Numbers/省下 / SAVED/L/T", "saved-usd-sub", MOBILE],
  ["Numbers/体积 / BYTES/V", "saved-bytes", MOBILE],
  ["Numbers/体积 / BYTES/L/T", "saved-bytes-sub", MOBILE],
  ["Numbers/交易 / TXS/V", "saved-txs", MOBILE],
  ["Numbers/交易 / TXS/L/T", "saved-txs-sub", MOBILE],
  ["Bill Table/H", "bill-head", MOBILE],
  ["Bill Table/优化前", "row-before", MOBILE],
  ["Bill Table/优化后", "row-after", MOBILE],
  ["Bill Table/省下", "row-saved", MOBILE],
  ["M Bill/Actions/Download", "download", MOBILE],
  ["M Bill/Actions/Row/复制 JSON", "copy-json", MOBILE],
  ["M Bill/Actions/Row/展开完整报告", "full-report", MOBILE],
  ["M Bill/Actions/Delta", "delta-link", MOBILE],
];

/** 生成时默认隐藏、由 JS 按状态放出来的块（用户已确认按真实产品行为处理）。 */
const HIDDEN = new Set(["state-gallery", "fail-examples", "errors-gallery", "details"]);
/** 只在移动端显示（拖拽/目录选择在手机上不成立）。 */
const MOBILE_ONLY = new Set(["mobile-fallback"]);

/** 设计稿里给开发看的备注，不上线。 */
const STRIP_TEXT = [/^下一步：/, /^默认收起$/, /^错误态 · 就地内联/, /^滚过首屏后出现/];

/** 导航与页脚的文本 → 锚点（中英各一套）。 */
const LINK_MAP = new Map(Object.entries({
  在线体检: "#checkup", 为什么贵: "#pricing", 功能: "#features", 工作原理: "#how", 真实案例: "#case", 怎么用: "#use", FAQ: "#faq",
  案例: "#case", CLI: "#use", MCP: "#use",
  接入文档: "/docs/using-the-mcp.md", "agent 提示词": "/docs/agent-mcp-prompt.md", 变更记录: "/README.md", 问题反馈: "/README.md",
  Checkup: "#checkup", "Why it's pricey": "#pricing", Features: "#features", "How it works": "#how", "Case study": "#case",
  "Get started": "#use", "Case": "#case", Docs: "/docs/using-the-mcp.md", "Agent prompt": "/docs/agent-mcp-prompt.md",
  Changelog: "/README.md", Feedback: "/README.md",
}));

const SQUARE = { "S1 Nav": "header", "S12 Footer": "footer", "M Nav": "header", "M Footer": "footer" };

/** 桌面版（中/英）的区块 → 锚点 id */
const ANCHORS = {
  "S1 Nav": "top", "S2 Hero": "hero", "S3 Checkup": "checkup", "S4 Gas Model": "pricing",
  "S5 Features": "features", "S6 How It Works": "how", "S7 Case Study": "case",
  "S8 Iteration": "iterate", "S9 Limits": "limits", "S10 Get Started": "use",
  "S11 FAQ": "faq", "S12 Footer": "footer",
};

/** 390 手机版（设计稿里的独立流程） */
const MOBILE_ANCHORS = {
  "M Nav": "top", "M Hero": "hero", "M Checkup": "checkup",
  "M Running": "running", "M Bill": "bill", "M Footer": "footer",
};

/**
 * 三个页面。设计稿里是三个独立 frame：
 *   · 中文桌面 / 英文桌面：整站落地页
 *   · 390 手机版：一条**完整流程**（英雄区 → 体检 → 运行中 → 账单）
 * 手机版里的「运行中 / 账单」是状态页，默认隐藏，由 JS 按真实状态放出来。
 */
const PAGES = [
  { key: "zh", frame: "DeWEBShrink Landing", out: "index.html", anchors: ANCHORS, lang: "zh", rel: "", title: "DeWEBShrink · 上链前给站点做一次体检", desc: "链上按字节永久计费。扫描站点，算出上链要花多少钱、能压掉多少、这一版改完要多花多少。文件不出本机。" },
  /* 英文帧还在改（目前落后于中文帧：没有 REC / VU 表 / 磁带模块 / TRK 标签）。
     这里照它自己的帧渲染，构建日志会列出「英文帧比中文帧少什么」；
     设计师更新英文帧后重跑 npm run site:build 就会自动跟上，不需要改代码。 */
  { key: "en", frame: "DeWEBShrink Landing (EN)", out: "en/index.html", anchors: ANCHORS, lang: "en", rel: "../", title: "DeWEBShrink — check up your site before it goes on-chain", desc: "On-chain bytes are billed forever. Scan your site, see what publishing costs, how much you can shrink, and what this revision adds. Your files never leave your browser." },
  { key: "m", frame: "DeWEBShrink Mobile (390)", out: "m/index.html", anchors: MOBILE_ANCHORS, lang: "zh", rel: "../", mobile: true, title: "DeWEBShrink · 手机上也能先体检", desc: "手机端只体检单个文件；整站体检在桌面浏览器或 CLI / MCP 里跑。" },
];

/** 手机版里默认隐藏、按运行状态放出来的区块 */
const MOBILE_STATE_SECTIONS = { "M Running": "m-running", "M Bill": "m-bill" };


/* ------------------------------------------------- 预检：设计稿里有什么我不认识 */

/**
 * 设计稿每次改版都可能引入新东西（新的节点类型、新的视觉属性、新的图标）。
 * 生成器宁可**当场把不认识的列出来**，也不要装作渲染成功 —— 上一次就是这样：
 * 语言开关两个按钮都被画成选中态，页面看起来「没问题」，其实是错的。
 */
function preflight(pen) {
  const KNOWN_TYPES = new Set(["frame", "text", "rectangle", "ellipse", "icon", "ref"]);
  const ROOT_ONLY = new Set(["version", "variables", "fileToken", "pages"]);
  const HANDLED = new Set([
    "type", "id", "name", "children", "x", "y", "reusable", "layout", "width", "height",
    "gap", "padding", "justifyContent", "alignItems", "fill", "stroke", "strokeWidth",
    "cornerRadius", "clip", "content", "fontFamily", "fontSize", "fontWeight",
    "letterSpacing", "lineHeight", "textAlign", "textGrowth", "icon", "library", "innerRadius",
    "layoutPosition", "ref",
  ]);
  const out = { types: new Set(), props: new Set(), icons: new Set(), fills: new Set(), literals: new Set(), libraries: new Set() };
  const walk = (n, isRoot = false) => {
    if (!isRoot && !KNOWN_TYPES.has(n.type)) out.types.add(String(n.type));
    for (const k of Object.keys(n)) if (!HANDLED.has(k) && !(isRoot && ROOT_ONLY.has(k))) out.props.add(k);
    if (n.icon) {
      out.icons.add(n.icon);
      out.libraries.add(n.library ?? "(未标)");
    }
    for (const f of [n.fill, n.stroke]) {
      if (typeof f === "string" && !f.startsWith("$")) out.literals.add(f);
      else if (f && typeof f === "object" && f.type !== "shader") out.fills.add(JSON.stringify(f).slice(0, 60));
    }
    for (const c of n.children ?? []) walk(c);
  };
  walk(pen, true);
  return out;
}

/* ------------------------------------------------------------------ 渲染 */

const stats = { hooks: new Map(), stripped: 0, missingRefs: new Set() };

/**
 * 表格列宽测量。
 * 设计稿里有几张「表」只有最后一列是 fill_container，前面的列没给宽度 ——
 * 在 auto-layout 里它们各自 hug 内容，于是列与列不对齐（设计稿的一处笔误）。
 * 这里按内容量出前面几列需要的像素宽，渲染时写成行内宽度，表就真的对齐了。
 * 只认「最后列自适应 + 每行同列数 + 前面都是短文本」的结构，避免误伤普通行。
 */
const CJK = /[\u3000-\u9fff\uff00-\uffef]/;
function tableColumns(node) {
  if (node.layout !== "vertical") return null;
  const rows = node.children ?? [];
  if (rows.length < 3) return null;
  if (!rows.every((r) => r.type === "frame")) return null;
  const cols = (rows[0].children ?? []).length;
  if (cols < 2) return null;
  if (!rows.every((r) => (r.children ?? []).length === cols)) return null;
  if (!rows.every((r) => (r.children ?? []).every((c) => c.type === "text"))) return null;
  if ((rows[0].children[cols - 1].width ?? "") !== "fill_container") return null;
  /* 只有设计稿「没给宽度」的前导列才需要补；给了 fill_container 的列说明它想等分，别动 */
  if (rows.some((r) => r.children.slice(0, cols - 1).some((c) => c.width !== undefined))) return null;
  const widths = [];
  for (let c = 0; c < cols - 1; c++) {
    let w = 0;
    for (const r of rows) {
      const t = r.children[c];
      const fs = t.fontSize ?? 12;
      const text = String(t.content ?? "");
      const est = [...text].reduce((a, ch) => a + (CJK.test(ch) ? fs : fs * 0.62), 0);
      w = Math.max(w, est);
    }
    widths.push(Math.ceil(w));
  }
  return widths;
}
/** 节点 name 里可能带 "/"（例如「网页版和 CLI / MCP 版结果一样吗？」），
    所以路径用 unit separator 拼，不能用 "/"。 */
const SEP = "\u001f";

function hookNames(key, pageKey = "zh") {
  const segs = key.split(SEP);
  const hits = [];
  for (const [pattern, name, pages] of HOOKS) {
    if (pages && !pages.includes(pageKey)) continue;
    const want = pattern.split("/");
    if (want.length > segs.length) continue;
    const tail = segs.slice(-want.length);
    if (want.every((w, i) => w === "*" || w === tail[i])) hits.push(name);
  }
  return hits;
}

function textTag(node, insideButton) {
  if (insideButton) return "span";
  const n = node.name ?? "";
  if (/^H1/.test(n)) return "h1";
  if (/^H2/.test(n)) return "h2";
  if (/^H3/.test(n)) return "h3";
  if (/^(Body|Sub|Trust Line|Support Note|FL Text|DH2|Conditions|V Sub|MD|WD|AT|D|S|FE)$/.test(n)) return "p";
  return "span";
}

/** 开标签：attrs 里可能已经有 class/style 的碎片，统一在这里收口。 */
function openTag(tag, attrs, classes, styleParts = []) {
  const list = [...attrs];
  if (styleParts.length) list.push(`style="${styleParts.join(";")}"`);
  const cls = classes.filter(Boolean).join(" ");
  if (cls) list.unshift(`class="${cls}"`);
  return `<${tag}${list.length ? " " + list.join(" ") : ""}>`;
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 状态图标：一个位置放三张（通过父级 data-status 切换），避免 JS 注入 SVG。 */
function statusIcons(base, w, h, icons) {
  return icons
    .map(([name, kind]) => {
      const ic = icon(name);
      return `<svg class="${base} js-ic-${kind}" viewBox="${ic.viewBox}" width="${w}" height="${h}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ic.inner}</svg>`;
    })
    .join("");
}

function render(node, ctx) {
  const { parentAxis, path: parentPath, insideButton, template } = ctx;

  /* 组件引用：取出定义节点，用 ref 自己的 id 画一遍（定义处那一次照常渲染） */
  if (node.type === "ref") {
    const target = REUSABLES.get(node.ref);
    if (!target) {
      stats.missingRefs.add(`${node.name ?? "?"} → ${node.ref}`);
      return `<div${ctx.debugRef ? ` data-missing-ref="${node.ref}"` : ""}></div>`;
    }
    return render({ ...structuredClone(target), id: node.id }, ctx);
  }

  const key = [...parentPath, node.name ?? node.type].join(SEP);
  const full = `${ctx.lang}/${key}`;

  /* 1. 纯装饰性的设计备注：整节点丢弃 */
  if (node.type === "text" && node.content !== undefined && STRIP_TEXT.some((re) => re.test(node.content))) {
    stats.stripped++;
    return "";
  }

  /* 「Big Numbers」三张卡的名字里带 " / "，没法写成路径模式，按**兄弟序号**认 */
  const extra = [...(ctx.extraHooks ?? [])];
  /* 账单三个大数字：桌面是 Big Numbers/BV+BS，手机是 Numbers/V+T（名字里带 " / "，
     没法写成路径模式，所以按兄弟序号认）。 */
  const cardName = [...parentPath].reverse().find((seg) => /SAVED|BYTES|TXS/.test(seg)) ?? "";
  if (cardName) {
    const kind = /SAVED/.test(cardName) ? "saved-usd" : /BYTES/.test(cardName) ? "saved-bytes" : "saved-txs";
    if (node.name === "BV" || node.name === "V") extra.push(kind);
    if (node.name === "BS" || node.name === "T") extra.push(`${kind}-sub`);
  }
  const hooks = [...new Set([...hookNames(key, ctx.pageKey), ...extra])];
  for (const h of hooks) stats.hooks.set(h, (stats.hooks.get(h) ?? 0) + 1);

  /* 2. 特殊结构：FAQ 手风琴、校验行 */
  const anchors = ctx.anchors ?? ANCHORS;
  const isFaqItem = hooks.includes("faq-item");
  const isCheckRow = hooks.includes("check-row");
  const isButtonText = insideButton;
  const sectionName = key.split(SEP)[1] ?? "";

  /* 3. 标签与属性 */
  const isSection = Boolean(anchors[node.name]) && node.type === "frame" && parentPath.length === 1;
  let tag = node.type === "frame" ? (isSection ? SQUARE[node.name] ?? "section" : "div") : null;
  const attrs = [];
  /** 行内 style 片段：表格列宽、shader 变量都往这里塞，最后统一拼成一个 style 属性 */
  const styleParts = [];

  if (node.type === "text") {
    tag = textTag(node, isButtonText);
  } else if (node.type === "rectangle") {
    tag = "div";
  } else if (node.type === "ellipse") {
    tag = "div";
  }

  /* 导航 / 页脚里的文本 → 锚点链接（设计稿把这些当纯文本画，站点里必须是 <a>） */
  const inNavLinks = key.includes(["S1 Nav", "Nav Links"].join(SEP));
  const navLink = node.type === "text" && LINK_MAP.get(node.content) &&
    (inNavLinks || sectionName === "S12 Footer" || sectionName === "M Footer");
  if (navLink) {
    tag = "a";
    attrs.push(`href="${LINK_MAP.get(node.content)}"`);
  }

  const clickable = hooks.some((h) =>
    ["choose-folder", "run", "download", "copy-json", "full-report", "chain-bsc", "chain-xlayer", "chain-base",
     "preset-safe", "preset-aggressive", "preset-webp", "tab-web", "tab-cli", "tab-mcp", "floating-cta",
     "choose-file", "menu-button", "assumptions", "cancel", "tape-play", "tape-stop",
     "nav-cta", "hero-cta", "hero-secondary", "delta-link", "brand", "docs-button", "lang-zh", "lang-en",
     "faq-q"].includes(h),
  );
  const desk = (anchor) => (ctx.mobile ? `../index.html#${anchor}` : `#${anchor}`);
  const linkHref = {
    brand: "#top", "nav-cta": "#checkup", "hero-cta": "#checkup",
    "hero-secondary": desk("case"), "delta-link": desk("iterate"), "floating-cta": "#checkup",
    "docs-button": "/docs/using-the-mcp.md",
    "lang-zh": ctx.lang === "zh" ? "./index.html" : "../index.html",
    "lang-en": ctx.lang === "zh" ? "./en/index.html" : "./index.html",
  };
  const hrefOf = hooks.map((h) => linkHref[h]).find(Boolean);

  if (!navLink && hrefOf && (node.type === "frame" || node.type === "text")) {
    tag = "a";
    attrs.push(`href="${hrefOf}"`);
  } else if (!navLink && hrefOf === undefined && clickable) {
    tag = hooks.includes("choose-folder") || hooks.includes("choose-file") ? "label" : "button";
    if (tag === "button") attrs.push('type="button"');
    if (tag === "label") attrs.push(`for="${hooks.includes("choose-file") ? "pen-file-input" : "pen-folder-input"}"`);
  }

  if (isSection) attrs.push(`id="${anchors[node.name]}"`);
  /* shader / 对象填充：直接看节点自己的 fill。
     （不能查 boxDecls 登记的那张表 —— 样式是在这之后才算的，查表永远是空。） */
  if (node.fill && typeof node.fill === "object") {
    if (node.fill.type === "shader") {
      attrs.push(`data-shader="${String(node.fill.url).replace(/\.glsl$/, "")}"`);
      const st = shaderStyle(node.fill.url, node.fill.uniforms ?? {});
      if (st) styleParts.push(st);
      if (node.name === "CRT Scanlines") attrs.push('aria-hidden="true"');
    } else {
      attrs.push(`data-fill-unknown="${node.fill.type ?? "?"}"`);
    }
  }
  if (ctx.rowCellWidths && ctx.cellIndex !== undefined && ctx.cellIndex < ctx.rowCellWidths.length) {
    const w = ctx.rowCellWidths[ctx.cellIndex];
    styleParts.push(`width:${w}px`, `flex:0 0 ${w}px`);
  }
  if (isFaqItem) attrs.push("data-faq-item");
  if (isCheckRow) attrs.push("data-check-row");
  if (hooks.length) attrs.push(`data-hook="${hooks.join(" ")}"`);
  if (isSection || hooks.length) attrs.push(`data-pen="${node.id}"`);

  const classes = [];
  const decls = node.type === "text" ? textDecls(node, parentAxis) : boxDecls(node, parentAxis, ctx.isRoot);
  const c = cls(decls);
  if (c) classes.push(c);
  if (isSection) classes.push("pen-section", `pen-${anchors[node.name]}`);
  /* 手机版的「运行中 / 账单」是状态页：默认隐藏，跑完再由 JS 放出来 */
  if (isSection && ctx.mobile && MOBILE_STATE_SECTIONS[node.name]) {
    classes.push("pen-hidden");
    attrs.push(`data-hook="${MOBILE_STATE_SECTIONS[node.name]}"`);
    stats.hooks.set(MOBILE_STATE_SECTIONS[node.name], (stats.hooks.get(MOBILE_STATE_SECTIONS[node.name]) ?? 0) + 1);
  }
  if (ctx.isRoot) classes.push("pen-root");
  if (navLink) classes.push("pen-navlink");
  /* 数据驱动的响应式提示：设计稿是 1440 固定宽的，窄屏需要这些标记才能收得住 */
  if (typeof node.width === "number" && node.width >= 240) classes.push("pen-fluidw");
  if (node.type === "frame" && (node.children ?? []).length >= 2) {
    const kids = node.children;
    const deco = kids.some((c) => ["icon", "ellipse", "rectangle"].includes(c.type));
    const blocks = kids.filter((c) => c.type === "frame" || c.type === "text").length;
    if (!deco && blocks >= 2) classes.push("pen-row");
    /* 一排「卡片」（子节点全是 fill_container 的 frame）拉成等高：
       设计稿没写高度，auto-layout 下会各自 hug，底部就会参差。 */
    if (
      node.layout !== "vertical" &&
      node.height === undefined &&
      node.alignItems === undefined &&
      kids.every((c) => c.type === "frame" && c.width === "fill_container")
    ) classes.push("pen-cardrow");
    /* 一整排小方块/图标（hero 里那 24 个「块」）窄屏要能换行，否则撑破页面 */
    if (deco && blocks === 0 && kids.length >= 6) classes.push("pen-deco-row");
  }
  if (node.type === "frame" && node.reusable) classes.push("pen-reusable");
  if (node.name?.startsWith("E0") && key.includes("S3-I Errors")) {
    classes.push("pen-errorcard");
    attrs.push(`data-err="${node.name.slice(0, 3)}"`);
  }
  if (isFaqItem) classes.push("pen-faq-item");
  if (isCheckRow) classes.push("pen-checkrow");
  /* 表行：列之间给一点间距（设计稿这几行没写 gap） */
  if (ctx.cellWidths && node.type === "frame" && node.gap === undefined) classes.push("pen-tablerow");
  /* 设计稿里第 1 条 FAQ 是展开态，其余收起 —— 生成时照做，之后交给 JS 切换 */
  if (isFaqItem) {
    stats.faqSeen = (stats.faqSeen ?? 0) + 1;
    if (stats.faqSeen === 1) classes.push("is-open");
  }
  for (const h of hooks) if (HIDDEN.has(h)) classes.push("pen-hidden");
  for (const h of hooks) if (MOBILE_ONLY.has(h)) classes.push("pen-mobile-only");

  /* 4. 子节点 */
  const childAxis = node.type === "frame" ? (node.layout === "vertical" ? "column" : "row") : parentAxis;
  /* extraHooks 只作用于**当前节点**，不能顺延到子孙（踩过的坑：FAQ 的 A 把 faq-a 传染给了 AT） */
  const childCtx = {
    ...ctx,
    isRoot: false,
    extraHooks: undefined,
    cellWidths: undefined,
    rowCellWidths: undefined,
    cellIndex: undefined,
    parentAxis: childAxis,
    path: [...parentPath, node.name ?? node.type],
    insideButton: insideButton || tag === "button" || tag === "a",
  };
  let inner = "";

  if (node.type === "text") {
    let content = node.content ?? "";
    content = content.replace(/^Tab \d+ · /, "");
    if (!inner) inner = esc(content);
    else if (content) inner += esc(content);
    if (tag === "span" && !classes.length && !inner) return "";
    return `${openTag(tag, attrs, classes, styleParts)}${inner}</${tag}>`;
  }

  if (node.type === "icon") {
    const clsName = classes.join(" ");
    const svgAttrs = (name, extra = "") => {
      const one = icon(name);
      return `<svg class="pen-ic ${extra}" viewBox="${one.viewBox}" fill="none" stroke="${color(node.fill)}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${one.inner}</svg>`;
    };
    if (hooks.includes("badge-icon") || hooks.includes("check-icon")) {
      /* 三态图标：外面套一层，靠父级 data-status 切换显示哪一个 */
      return `${openTag("span", attrs, classes, styleParts)}` +
        statusIcons("pen-ic", node.width ?? 15, node.height ?? 15, [["circle-check", "pass"], ["triangle-alert", "warn"], ["circle-x", "fail"]]) +
        `</span>`;
    }
    if (node.name === "Chev" && key.includes(["S11 FAQ", "FAQ List"].join(SEP))) {
      return `${openTag("span", attrs, classes, styleParts)}` +
        `<span class="pen-chev">${svgAttrs("plus", "pen-chev-plus")}${svgAttrs("minus", "pen-chev-minus")}</span>` +
        `</span>`;
    }
    classes.push("pen-ic");
    return `${openTag("svg", attrs, classes, styleParts).replace(/>$/, "")} viewBox="${icon(node.icon).viewBox}" fill="none" stroke="${color(node.fill)}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icon(node.icon).inner}</svg>`;
  }

  if (false) {
    const ic = icon(node.icon);
    const w = node.width ?? 24;
    const h = node.height ?? 24;
    const stroke = color(node.fill);
    const svg = (name, extra = "") => {
      const one = icon(name);
      return `<svg class="pen-ic ${extra}" viewBox="${one.viewBox}" width="${w}" height="${h}" fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${one.inner}</svg>`;
    };
    if (hooks.includes("badge-icon") || hooks.includes("check-icon")) {
      /* 一个位置放三态图标，靠父级 data-status 切换（避免 JS 注入 SVG） */
      inner = statusIcons("pen-ic", w, h, [["circle-check", "pass"], ["triangle-alert", "warn"], ["circle-x", "fail"]]);
    } else if (node.name === "Chev" && key.includes(["S11 FAQ", "FAQ List"].join(SEP))) {
      /* FAQ 的加减号：两张都放，CSS 按 is-open 切换 */
      inner = `<span class="pen-chev">${svg("plus", "pen-chev-plus")}${svg("minus", "pen-chev-minus")}</span>`;
    } else {
      inner = `<svg class="pen-ic" viewBox="${ic.viewBox}" width="${w}" height="${h}" fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ic.inner}</svg>`;
    }
  } else if (node.type === "ellipse") {
    const inner0 = node.innerRadius ?? 0;
    if (inner0 >= 0.9) {
      Object.assign(decls, { "border-radius": "50%", "background-color": "transparent", border: `1px solid ${color(node.fill)}` });
    } else if (inner0 > 0) {
      Object.assign(decls, { "border-radius": "50%", "background-color": "transparent", border: `2px solid ${color(node.fill)}` });
    } else {
      Object.assign(decls, { "border-radius": "50%" });
    }
    const c2 = cls(decls);
    inner = "";
    classes.length = 0;
    if (c2) classes.push(c2);
    if (isSection) classes.push("pen-section");
    return `${openTag(tag, attrs, classes, styleParts)}</${tag}>`;
  } else {
    /* 表格：容器把列宽交给「行」，行再把列宽交给「单元格」——不能再往上一层传，
       否则行自己会被套上一个 82px 的宽度（踩过）。 */
    /* 有 absolute 子节点 → 父级要建立定位上下文 */
    if (node.type === "frame" && (node.children ?? []).some((c) => c.layoutPosition === "absolute")) {
      classes.push("pen-rel");
    }
    const tableWidths = node.type === "frame" ? tableColumns(node) : null;
    (node.children ?? []).forEach((child, i) => {
      inner += render(child, {
        ...childCtx,
        siblingIndex: i,
        parentSiblingIndex: ctx.siblingIndex,
        cellWidths: tableWidths ?? undefined,
        rowCellWidths: ctx.cellWidths ?? undefined,
        cellIndex: ctx.cellWidths ? i : undefined,
      });
    });

    /* 目录 / 文件选择：必须有一个真正的 file input，label 才有得点。
       桌面版要整目录（webkitdirectory），手机版只能选文件（设计稿里就是这么写的）。 */
    if (hooks.includes("choose-folder")) {
      inner = `<input id="pen-folder-input" class="pen-file" type="file" webkitdirectory directory multiple hidden>` + inner;
    }
    if (hooks.includes("choose-file")) {
      inner = `<input id="pen-file-input" class="pen-file" type="file" multiple hidden>` + inner;
    }

    /* FAQ：设计稿只展开了第 1 条，其余 10 条答案按同款排版从 faq-extra.json 补进来 */
    if (isFaqItem && !(node.children ?? []).some((c) => c.name === "A")) {
      const num = ((node.children?.[0]?.children?.[0]?.children?.[0]?.content ?? "").match(/\d\d/) || [])[0];
      const answer = faqExtra[ctx.lang]?.[num];
      if (answer && faqATemplate) {
        const aNode = structuredClone(faqATemplate);
        aNode.id = `${node.id}A`;
        const setText = (n) => {
          if (n.type === "text" && n.name === "AT") { n.content = answer; return true; }
          return (n.children ?? []).some(setText);
        };
        setText(aNode);
        inner += render(aNode, { ...childCtx, extraHooks: ["faq-a"] });
      }
    }
  }

  if (node.type === "frame" && (node.children ?? []).length === 0) inner = "";
  return `${openTag(tag, attrs, classes, styleParts)}${inner}</${tag}>`;
}

/* -------------------------------------------------------------- 页面组装 */

const HEAD = (page) => {
  const { lang, rel, title, desc } = page;
  return `<!doctype html>
<html lang="${lang === "zh" ? "zh-CN" : "en"}" data-lang="${lang}" data-state="idle" data-tab="web"${page.mobile ? ' data-mobile="1"' : ""}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="${desc}">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${desc}">
<meta property="og:type" content="website">
<link rel="icon" href="${rel}assets/favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&family=Noto+Sans+SC:wght@400;700&family=Press+Start+2P&family=VT323&display=swap">
<link rel="stylesheet" href="${rel}assets/pen.css">
<link rel="stylesheet" href="${rel}assets/site.css">
</head>
<body>
`;
};

function build(page) {
  const frame = pen.children.find((c) => c.name === page.frame);
  if (!frame) throw new Error(`设计稿里找不到 "${page.frame}"`);
  stats.faqSeen = 0;
  const ctx = {
    lang: page.lang,
    pageKey: page.key,
    anchors: page.anchors,
    mobile: Boolean(page.mobile),
    parentAxis: "column",
    path: [],
    insideButton: false,
    isRoot: true,
  };
  const body = render(frame, ctx);
  /* 浮动 CTA 只有桌面版有 */
  const floating = page.mobile ? null : pen.children.find((c) => c.name.startsWith("Floating"));
  const floatHtml = floating ? render(floating, { ...ctx, isRoot: false }) : "";
  return `${HEAD(page)}<div class="pen-page${page.mobile ? " pen-page-m" : ""}">${body}</div>
${floatHtml}
<script type="module" src="${page.rel}assets/site.js"></script>
</body>
</html>
`;
}

fs.mkdirSync(path.join(OUT, "en"), { recursive: true });
fs.mkdirSync(path.join(OUT, "m"), { recursive: true });
fs.mkdirSync(ASSETS, { recursive: true });

/* FAQ 答案的排版模板：取设计稿里第 1 条已展开的 A（补出来的 10 条照抄它的样式） */
const faqATemplate = (() => {
  let found = null;
  const walk = (n, inList) => {
    if (found) return;
    if (n.name === "S11 FAQ") inList = true;
    if (n.name === "FAQ List") inList = true;
    if (inList && (n.children ?? []).some((c) => c.name === "A")) {
      found = structuredClone(n.children.find((c) => c.name === "A"));
      return;
    }
    for (const c of n.children ?? []) walk(c, inList);
  };
  walk(pen, false);
  return found;
})();

const deployed = {};
const pageHooks = {};
for (const page of PAGES) {
  stats.hooks = new Map();
  stats.faqSeen = 0;
  deployed[page.key] = { html: build(page), hooks: null };
  pageHooks[page.key] = new Map(stats.hooks);
  deployed[page.key].hooks = pageHooks[page.key];
}

/* hook 校验：每个 hook 在**它应该在的每一页**上的命中数都必须等于预期。
   踩过的坑：以前只遍历「匹配到的 hook」，于是完全没匹配上的 hook 反而不会被发现。 */
const MULTI = { "faq-item": 11, "faq-q": 11, "faq-a": 11, "check-row": 10, "check-icon": 10, "check-name": 10, "check-detail": 10 };
const problems = [];
for (const [, name, pages] of HOOKS) {
  const want = MULTI[name] ?? 1;
  for (const key of pages ?? DESKTOP) {
    const got = pageHooks[key]?.get(name) ?? 0;
    if (got !== want) problems.push(`${name} @ ${key}: 期望 ${want}，实际 ${got}`);
  }
}

const rootVars = `:root{` +
  Object.entries(VARS).filter(([, v]) => v.type === "color").map(([k, v]) => `--pen-${k}:${v.value}`).join(";") +
  `;--pen-mono:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,monospace` +
  `;--pen-sans:'Noto Sans SC',-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',system-ui,sans-serif` +
  `;--pen-display:'Press Start 2P',var(--pen-mono)` +
  `;--pen-pixel:'VT323',var(--pen-mono)}`;

const css = `/* 自动生成：node web/tools/pen-to-site.mjs —— 不要手改。
   来源：web/design/DeWEBSharink.pen（Pencil v${pen.version}）
   每条规则对应设计稿里一组**样式完全相同**的节点（${rules.size} 组 / ${[...stats.hooks.values()].reduce((a, b) => a + b, 0)} 个 hook 节点）。 */
${rootVars}
*{box-sizing:border-box}
${[...rules.entries()].map(([name, body]) => `.${name}{${body}}`).join("\n")}
`;

for (const page of PAGES) fs.writeFileSync(path.join(OUT, page.out), deployed[page.key].html);
fs.writeFileSync(path.join(ASSETS, "pen.css"), css);

/* 文案清单：跟着设计稿一起生成，方便校对（不要手改） */
for (const page of PAGES) {
  const frame = pen.children.find((c) => c.name === page.frame);
  const lines = [];
  const walk = (n, section) => {
    let sec = section;
    if (n.type === "frame" && /^(S\d+|M) /.test(n.name ?? "")) sec = n.name;
    if (n.type === "text") lines.push(`[${sec ?? page.frame}] ${n.content ?? ""}`);
    for (const c of n.children ?? []) walk(c, sec);
  };
  walk(frame, null);
  fs.writeFileSync(path.join(DESIGN, `copy.${page.key}.txt`), lines.join("\n") + "\n");
  console.log(`  文案清单 web/design/copy.${page.key}.txt  ${lines.length} 条`);
}

/* favicon：设计稿里的 cassette-tape */
const fav = icon("cassette-tape");
fs.writeFileSync(
  path.join(ASSETS, "favicon.svg"),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${fav.viewBox}" width="32" height="32" fill="none" stroke="#5CF08E" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="24" height="24" fill="#0B0D0C" stroke="none"/>${fav.inner}</svg>`,
);

const kb = (p) => `${(fs.statSync(p).size / 1024).toFixed(0)} KB`;

/* 预检报告：不认识的类型/属性/图标/颜色，全部打出来 */
const pre = preflight(pen);
const missingIcons = [...pre.icons].filter((n) => !fs.existsSync(path.join(DESIGN, "icons", `${n}.svg`)));
const notes = [];
if (pre.types.size) notes.push(`未知节点类型：${[...pre.types].join("、")}（现在会被当成 div 渲染，需要补支持）`);
if (pre.props.size) notes.push(`未处理的属性：${[...pre.props].join("、")}（可能少样式：虚线/透明度/旋转/阴影/渐变…）`);
if (missingIcons.length) notes.push(`缺图标文件：${missingIcons.join("、")}（web/design/icons/ 里没有）`);
if (pre.libraries.size && [...pre.libraries].some((l) => l !== "lucide")) notes.push(`非 lucide 图标库：${[...pre.libraries].join("、")}`);
if (pre.fills.size) notes.push(`未知的填充类型：${[...pre.fills].join("、")}（shader 之外的对象填充没实现）`);
if (pre.literals.size) notes.push(`裸色值 ${pre.literals.size} 个（浅色/局部用的字面量色，已按原样渲染）`);
if (notes.length) {
  console.log("\n⚠ 设计稿预检：");
  for (const n of notes) console.log(`  · ${n}`);
} else {
  console.log("\n✓ 设计稿预检：类型 / 属性 / 图标 / 取色全部认识");
}
for (const page of PAGES) console.log(`✓ web/${page.out.padEnd(18)} ${kb(path.join(OUT, page.out))}`);
console.log(`✓ web/assets/pen.css    ${kb(path.join(ASSETS, "pen.css"))}  （${rules.size} 条去重规则）`);
console.log(`  丢弃设计备注 ${stats.stripped} 条`);
if (process.env.PEN_DEBUG) {
  console.log(`  [debug] shaderOf=${shaderOf.size} shaderUsed=${[...shaderUsed].join(",")}`);
  console.log(`  [debug] 顶层帧 children=${pen.children.map((c) => `${c.name}:${(c.children ?? []).length}`).join(" | ")}`);
}
if (problems.length) {
  console.error(`\n✗ hook 校验失败（${problems.length}）：`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
/* 英文帧落后于中文帧时，把差异列出来（给设计师对照，不是错误） */
function frameShape(frame) {
  const counts = new Map();
  const walk = (n, root = false) => {
    if (!root) {
      const key = n.name ?? n.type;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    /* ref 指向的组件内容也要算进来，否则「英文帧少了 Cassette 内部节点」是假警报 */
    if (n.type === "ref") {
      const target = REUSABLES.get(n.ref);
      if (target) walk(structuredClone(target));
      return;
    }
    for (const c of n.children ?? []) walk(c);
  };
  walk(frame, true);
  return counts;
}
{
  const zhFrame = pen.children.find((c) => c.name === "DeWEBShrink Landing");
  const enFrame = pen.children.find((c) => c.name === "DeWEBShrink Landing (EN)");
  if (zhFrame && enFrame) {
    const zhShape = frameShape(zhFrame);
    const enShape = frameShape(enFrame);
    const missing = [...zhShape].filter(([k, v]) => (enShape.get(k) ?? 0) < v && !/^S\d+|Tape Perforation/.test(k));
    if (missing.length) {
      console.log(`\n⚠ 英文帧比中文帧少 ${missing.length} 类节点（英文设计稿还在改；更新后重跑即可）：`);
      for (const [k, v] of missing.slice(0, 12)) console.log(`  · ${k}  zh=${v} en=${enShape.get(k) ?? 0}`);
    }
  }
}

if (stats.missingRefs?.size) console.log(`\n⚠ 有 ${stats.missingRefs.size} 个组件引用找不到定义：${[...stats.missingRefs].join("、")}`);
console.log("✓ hook 校验通过");
