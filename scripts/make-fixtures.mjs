#!/usr/bin/env node
/* ==========================================================================
   生成测试站点 —— 用来检验「压缩前 vs 压缩后」在平台上的真实计费
   --------------------------------------------------------------------------
   为什么要建多个站点而不是一个：协议对不同文件的处理差别很大，一个站点覆盖不全：

     · 小文件按块计费 —— 10 个 3KB 的文件要 10 块，块开销比字节开销还贵；
     · 图片同格式重编码有 PSNR 门限，收益因图而异；
     · 字体是最大项，而本工具**故意不做**子集化，得让账单如实反映这一点；
     · 隐藏文件 / 超 8 MiB / 非法路径会被协议**静默跳过**，不上传也就不计费；
     · README 这类非站点文件照样按字节收费，是纯浪费；
     · 内容完全相同的两个文件，每个路径单独计费。

   所以这里造七个站点，每个专门压住一类规则。素材尽量用真实的（字体、图标
   从 super-lock 复制），因为合成素材的压缩率和真实情况差得远。

   用法：node scripts/make-fixtures.mjs
   ========================================================================== */

"use strict";

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "fixtures");
/** 真实素材来源：辉光管时钟站（已上链 1413.30.tape 的那个） */
const REAL = "/Users/thewho/code/deepseek/super-lock";

const log = (...a) => console.log(...a);

async function writeFile(rel, content) {
  const abs = path.join(ROOT, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
}

async function copyReal(srcRel, destRel) {
  const abs = path.join(ROOT, destRel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  try {
    await fs.copyFile(path.join(REAL, srcRel), abs);
    return true;
  } catch {
    return false;
  }
}

/**
 * 造一张有真实内容的 PNG：径向渐变 + 条纹 + 轻微噪声。
 *
 * compressionLevel 默认 6（和大多数工具导出的图一样）—— **刻意不用 0**。
 * 用完全未压缩的图能做出「省 96%」的漂亮数字，但那不真实：用户上传的图
 * 多半已经被某个工具压过一遍了。用常规压缩的图，收益落在真实区间里，
 * 报告才值得信。（真实图标那批是从 super-lock 直接复制的，已经优化过，更严苛。）
 */
async function makePng(rel, width, height, { compressionLevel = 6, noise = 0 } = {}) {
  const channels = 4;
  const buf = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      const dx = (x - width / 2) / (width / 2);
      const dy = (y - height / 2) / (height / 2);
      const d = Math.min(1, Math.sqrt(dx * dx + dy * dy));
      const stripe = Math.sin((x + y) / 24) * 0.5 + 0.5;
      const jitter = noise ? (Math.random() - 0.5) * noise : 0;
      buf[i] = Math.max(0, Math.min(255, 255 * (1 - d) * (0.6 + 0.4 * stripe) + jitter)) | 0;
      buf[i + 1] = Math.max(0, Math.min(255, 200 * (1 - d * 0.8) + jitter)) | 0;
      buf[i + 2] = Math.max(0, Math.min(255, 120 + 110 * stripe * (1 - d) + jitter)) | 0;
      buf[i + 3] = 255;
    }
  }
  const abs = path.join(ROOT, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await sharp(buf, { raw: { width, height, channels } }).png({ compressionLevel }).toFile(abs);
}

/** 造一个「像真实业务代码」的 JS：有注释、长名字、空白，压得动。 */
function makeJs(name, lines) {
  return `/* ==========================================================================
   ${name} —— 测试用模块
   --------------------------------------------------------------------------
   这段注释本身也是字节，压缩后会消失。真实项目里的注释和缩进占比通常不低。
   ========================================================================== */

"use strict";

(function () {
  var CONFIG = {
    name: "${name}",
    retries: 3,
    timeoutMs: 5000,
    endpoints: ["/api/a", "/api/b", "/api/c"]
  };

  function computeSomethingMeaningful(inputValue, multiplierValue) {
    var accumulator = 0;
    for (var index = 0; index < inputValue.length; index++) {
      accumulator += inputValue[index] * multiplierValue;
    }
    return accumulator;
  }

${lines}

  window.${name.replace(/[^\w]/g, "")} = {
    compute: computeSomethingMeaningful,
    config: CONFIG
  };
})();
`;
}

/* ========================================================================== */

log(`生成测试站点 → ${ROOT}\n`);
await fs.rm(ROOT, { recursive: true, force: true });
await fs.mkdir(ROOT, { recursive: true });

/* ------------------------- 01 · 基础小站（块开销） ------------------------- */
{
  await writeFile(
    "01-basic/index.html",
    `<!doctype html>
<html lang="zh">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>基础小站</title>
  <link rel="stylesheet" href="app.css">
</head>
<body>
  <!-- 这个注释压缩后会消失 -->
  <h1>基础小站</h1>
  <p>用来验证：小文件也各占一整块，所以「文件个数」本身就是成本。</p>
  <script src="app.js"></script>
</body>
</html>
`,
  );
  await writeFile(
    "01-basic/app.css",
    `/* 样式表注释 */
body {
  margin: 0;
  padding: 24px;
  font-family: system-ui, sans-serif;
  background: #101014;
  color: #e8e8ec;
}
h1 { font-size: 28px; letter-spacing: -0.02em; }
p  { line-height: 1.7; max-width: 62ch; }
`,
  );
  await writeFile("01-basic/app.js", makeJs("BasicApp", "  var cache = {};"));
  await writeFile(
    "01-basic/robots.txt",
    "User-agent: *\nAllow: /\n",
  );
  log("01-basic      3 个真站点文件 + robots.txt（都很小，专门看块开销）");
}

/* --------------------- 02 · 图片密集（同格式重编码） --------------------- */
{
  await makePng("02-images/hero.png", 900, 600);
  await makePng("02-images/card-a.png", 400, 300, { noise: 18 });
  await makePng("02-images/card-b.png", 400, 300);
  await makePng("02-images/icon.png", 192, 192);
  await writeFile(
    "02-images/index.html",
    `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>图片站</title></head>
<body>
  <img src="hero.png" alt="hero" width="900" height="600">
  <img src="card-a.png" alt="a" width="400" height="300">
  <img src="card-b.png" alt="b" width="400" height="300">
  <link rel="icon" href="icon.png">
</body></html>
`,
  );
  log("02-images     4 张常规压缩的 PNG（900×600 起），看同格式重编码的真实收益");
}

/* --------------------------- 03 · 字体密集 --------------------------- */
{
  const fonts = [
    "barlow-condensed-100.woff2",
    "chakra-petch-700.woff2",
    "ibm-plex-mono-400.woff2",
    "ibm-plex-mono-500.woff2",
    "inter-400.woff2",
    "inter-500.woff2",
    "noto-sans-sc-400.woff2",
    "zcool-qingke-huangyou-400.woff2",
  ];
  let css = "/* 字体声明：本工具不做子集化，所以这些字节会原样上链 */\n";
  let i = 0;
  for (const f of fonts) {
    const ok = await copyReal(`fonts/${f}`, `03-fonts/fonts/${f}`);
    if (!ok) continue;
    css += `@font-face { font-family: "F${i++}"; src: url("fonts/${f}") format("woff2"); font-display: swap; }\n`;
  }
  await writeFile("03-fonts/fonts.css", css);
  await writeFile(
    "03-fonts/index.html",
    `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><link rel="stylesheet" href="fonts.css"></head>
<body><h1 style="font-family:F0">字体站</h1><p style="font-family:F4">字体通常是账单里最大的一项。</p></body></html>
`,
  );
  log(`03-fonts      ${i} 个真实 woff2（从 super-lock 复制），看「最大项不做子集化」的代价`);
}

/* --------------------------- 04 · JS 密集 --------------------------- */
{
  for (const f of ["clock.js", "chain.js", "pwa.js", "sw.js"]) {
    await copyReal(f, `04-js/${f}`);
  }
  await writeFile(
    "04-js/index.html",
    `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>JS 站</title></head>
<body>
  <script src="clock.js"></script>
  <script src="chain.js"></script>
  <script src="pwa.js"></script>
</body></html>
`,
  );
  log("04-js         4 个真实 JS（IIFE 包裹，能吃满压缩率）");
}

/* ------------- 05 · 脏站（协议会跳过的、会被白收费的都在这里） ------------- */
{
  await writeFile(
    "05-messy/index.html",
    `<!doctype html>
<html lang="zh"><head>
  <meta charset="utf-8">
  <link rel="manifest" href="manifest.webmanifest">
  <link rel="icon" href="icons/icon-192.png">
</head><body>
  <h1>脏站</h1>
  <img src="icons/icon-512.png" alt="logo">
</body></html>
`,
  );
  await copyReal("icons/icon-192.png", "05-messy/icons/icon-192.png");
  await copyReal("icons/icon-512.png", "05-messy/icons/icon-512.png");
  /* 没有任何引用的死文件：照样按字节收费 */
  await copyReal("icons/apple-touch-icon.png", "05-messy/icons/apple-touch-icon.png");
  /* 非站点文件：README 会原样计费 */
  await writeFile(
    "05-messy/README.md",
    `# 脏站\n\n这个文件不是站点资源，但协议照样按字节收费 —— 每个字节都是永久的钱。\n`,
  );
  /* Content-Type 陷阱：协议的扩展名表里没有 webmanifest */
  await writeFile(
    "05-messy/manifest.webmanifest",
    `{ "name": "脏站", "short_name": "脏", "start_url": "./", "display": "standalone",
  "icons": [ { "src": "icons/icon-192.png", "sizes": "192x192", "type": "image/png" } ] }
`,
  );
  /* 隐藏文件：协议会整个跳过，一个字节都不上传 */
  await writeFile("05-messy/.DS_Store", "not really a ds_store but hidden anyway\n");
  await writeFile("05-messy/.shots/design-v1.png", Buffer.alloc(300 * 1024, 7));
  /* 超过 8 MiB：协议静默跳过，界面上不报错 */
  await writeFile("05-messy/huge-video.mp4", Buffer.alloc(9 * 1024 * 1024, 3));
  /* 非法路径：以 .. 段出现（这里用控制字符更贴近真实误操作） */
  await writeFile("05-messy/bad\u0001name.txt", "路径里有控制字符，协议会跳过\n");
  log("05-messy      README + 死图标 + manifest + .DS_Store + .shots/ + 9MiB 视频 + 控制字符路径");
}

/* --------------------------- 06 · 重复内容 --------------------------- */
{
  const same = makeJs("Dup", "  var same = true;");
  await writeFile("06-dup/index.html", `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="a.css"></head><body><script src="a.js"></script><script src="b.js"></script></body></html>\n`);
  await writeFile("06-dup/a.js", same);
  await writeFile("06-dup/b.js", same); // 内容完全相同，但路径不同 → 分别计费
  const css = `body { margin: 0; padding: 16px; background: #fff; }\n`;
  await writeFile("06-dup/a.css", css);
  await writeFile("06-dup/b.css", css);
  log("06-dup        两组内容完全相同的文件（a/b 同名不同路径），看重复计费");
}

/* ------------------- 07 · 真实站点（super-lock 完整复制） ------------------- */
{
  let copied = 0;
  const skip = new Set(["node_modules", ".git", ".shots", "tape-shrink", "tape-shrink.tape", ".DS_Store"]);
  async function walk(srcDir, relDir) {
    let entries;
    try {
      entries = await fs.readdir(srcDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (skip.has(e.name)) continue;
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        await walk(path.join(srcDir, e.name), rel);
        continue;
      }
      if (!e.isFile()) continue;
      if (!/\.(?:html|js|css|json|webmanifest|png|jpg|jpeg|svg|woff2?|txt|md|ico)$/i.test(e.name)) continue;
      await copyReal(rel, `07-real-site/${rel}`);
      copied++;
    }
  }
  await walk(REAL, "");
  log(`07-real-site  ${copied} 个真实文件（完整 super-lock，就是已上链那个站）`);
}

log("\n完成。接下来跑：node scripts/billing-report.mjs");
