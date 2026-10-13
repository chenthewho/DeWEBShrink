/* 端到端：造一个小站点 → 压 → 校验 → 对账。
   重点不是「省了多少」，而是**源目录一个字节都没变**、产物能通过校验。 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

import sharp from "sharp";

import { optimizeSite } from "../src/optimize/index.js";
import { scanSite } from "../src/scan.js";
import { verifyOutput } from "../src/verify.js";

/** 造一个尽量像真实站点的小站：HTML 带内联样式、独立 JS、图片、manifest、死文件、隐藏文件。 */
async function makeFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "deweb-shrink-fixture-"));
  const site = path.join(root, "site");
  await fs.mkdir(path.join(site, "assets"), { recursive: true });

  // 一张有渐变的 256×256 PNG（避免纯色让调色板量化「无损」得太容易）
  const png = await sharp({
    create: { width: 256, height: 256, channels: 4, background: { r: 10, g: 7, b: 5, alpha: 1 } },
  })
    .composite([
      {
        input: Buffer.from(
          `<svg width="256" height="256"><defs><radialGradient id="g"><stop offset="0" stop-color="#ffb04a"/><stop offset="1" stop-color="#0a0705"/></radialGradient></defs><rect width="256" height="256" fill="url(#g)"/><circle cx="128" cy="128" r="60" fill="#fff" fill-opacity="0.6"/></svg>`,
        ),
        top: 0,
        left: 0,
      },
    ])
    .png({ compressionLevel: 0 })
    .toBuffer();
  await fs.writeFile(path.join(site, "assets", "hero.png"), png);

  await fs.writeFile(
    path.join(site, "index.html"),
    `<!doctype html>
<html lang="zh"><head>
  <meta charset="utf-8">
  <link rel="manifest" href="manifest.webmanifest">
  <style>
    /* 这张图是背景 */
    .hero { background: url("assets/hero.png"); color: #ffb04a; }
    body { margin: 0; padding: 0 }
  </style>
</head><body>
  <!-- 注释：这是入口 -->
  <div class="hero" id="hero-root"></div>
  <img src=assets/hero.png alt="">
  <script src="app.js"></script>
  <script>
    window.__boot = function () { return MyApp.start("assets/hero.png"); };
  </script>
</body></html>`,
  );

  await fs.writeFile(
    path.join(site, "app.js"),
    `/* 应用逻辑：故意写得松散一点，好让压缩有东西可压 */
var MyApp = {
  version: "1.0.0",
  start: function (imagePath) {
    var heroImage = imagePath;
    var unusedButGlobal = { a: 1, b: 2, c: 3 };
    document.title = "demo " + heroImage + JSON.stringify(unusedButGlobal);
    return true;
  }
};
window.MyApp = MyApp;
`,
  );

  await fs.writeFile(
    path.join(site, "manifest.webmanifest"),
    JSON.stringify(
      {
        name: "demo",
        start_url: "./index.html",
        icons: [{ src: "assets/hero.png", sizes: "256x256", type: "image/png", purpose: "any" }],
      },
      null,
      2,
    ),
  );

  // 没人引用的文件（应被报出来）
  await fs.writeFile(path.join(site, "orphan.txt"), "nobody references me");
  await fs.writeFile(path.join(site, "README.md"), "# 文档，不该上链");
  // 协议会跳过的隐藏文件
  await fs.writeFile(path.join(site, ".DS_Store"), "junk");

  return { root, site };
}

async function treeDigest(dir) {
  const out = [];
  async function walk(d, rel) {
    for (const e of (await fs.readdir(d, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(abs, r);
      else out.push(`${r}:${crypto.createHash("sha256").update(await fs.readFile(abs)).digest("hex")}`);
    }
  }
  await walk(dir, "");
  return out.join("\n");
}

test("端到端：保守优化 → 校验通过 → 源目录零改动", async (t) => {
  const { root, site } = await makeFixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const beforeDigest = await treeDigest(site);
  const srcScan = await scanSite(site);
  assert.equal(srcScan.skipped.length, 1); // .DS_Store
  assert.equal(srcScan.skipped[0].path, ".DS_Store");
  assert.ok(srcScan.references.unreferenced.includes("orphan.txt"));

  const result = await optimizeSite({
    dir: site,
    out: path.join(root, "out"),
    gasPriceGwei: 0.05,
    priceUsd: 1000,
    options: { reportOpportunities: false },
  });

  // 源目录没被碰过
  assert.equal(await treeDigest(site), beforeDigest, "源目录被改动了");

  // 变小的确是真的小了
  assert.ok(result.after.totals.bytes < result.before.totals.bytes);
  assert.ok(result.saved.bytes > 0);

  // 校验必须全通过（含引用完整性 / JS 语法 / HTML 结构 / 跨文件全局）
  assert.equal(result.verification.ok, true, JSON.stringify(result.verification.checks, null, 1));

  // 所有引用仍然落地
  const outScan = await scanSite(path.join(root, "out"));
  const outPaths = new Set(outScan.billable.map((f) => f.path));
  for (const f of outScan.billable.filter((f) => f.isText)) {
    const text = await fs.readFile(path.join(root, "out", f.path), "utf8");
    const { extractRefsAuto } = await import("../src/refs.js");
    for (const ref of extractRefsAuto(text, f.path).refs) {
      assert.ok(outPaths.has(ref) || ref === "", `${f.path} 的引用 ${ref} 在产物里不存在`);
    }
  }

  // 全局 MyApp 还在（index.html 的内联脚本要用它）
  const appJs = await fs.readFile(path.join(root, "out", "app.js"), "utf8");
  assert.match(appJs, /MyApp/);
});

test("激进路径：转 WebP 会改文件名、重写引用、修 manifest 的 type，并且校验通过", async (t) => {
  const { root, site } = await makeFixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const out = path.join(root, "out");

  const result = await optimizeSite({
    dir: site,
    out,
    gasPriceGwei: 0.05,
    priceUsd: 1000,
    options: {
      convertImages: true,
      convertTo: "webp",
      psnrTarget: 30, // 明确允许有损，让转换真的发生
      reportOpportunities: false,
    },
  });

  const renames = result.files.renames;
  assert.equal(renames.length, 1, JSON.stringify(renames));
  assert.equal(renames[0].from, "assets/hero.png");
  assert.equal(renames[0].to, "assets/hero.webp");

  // 产物里必须是新文件名（这是之前真出过的 bug：字节写在新名下、引用却指向旧名）
  await assert.doesNotReject(fs.access(path.join(out, "assets/hero.webp")));
  await assert.rejects(fs.access(path.join(out, "assets/hero.png")));

  // 引用全部改到 .webp
  for (const rel of ["index.html", "manifest.webmanifest"]) {
    const text = await fs.readFile(path.join(out, rel), "utf8");
    assert.equal(text.includes("assets/hero.png"), false, `${rel} 里还留着 .png`);
    assert.ok(text.includes("assets/hero.webp"), `${rel} 里没有 .webp`);
  }
  const manifest = JSON.parse(await fs.readFile(path.join(out, "manifest.webmanifest"), "utf8"));
  assert.equal(manifest.icons[0].type, "image/webp");

  assert.equal(result.verification.ok, true, JSON.stringify(result.verification.checks, null, 1));
});

test("删文件开关：dropUnreferenced / dropNonSiteFiles 真的不写进产物，并且省下的钱算得出来", async (t) => {
  const { root, site } = await makeFixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const out = path.join(root, "out");

  const result = await optimizeSite({
    dir: site,
    out,
    gasPriceGwei: 0.05,
    priceUsd: 1000,
    options: { dropUnreferenced: true, dropNonSiteFiles: true, reportOpportunities: false },
  });

  const dropped = result.files.dropped.map((d) => d.path).sort();
  assert.deepEqual(dropped, ["README.md", "orphan.txt"]);
  for (const rel of dropped) await assert.rejects(fs.access(path.join(out, rel)));
  assert.ok(result.verification.ok, JSON.stringify(result.verification.checks, null, 1));
});

test("产物目录不能套在源目录里（否则会把自己扫进去）", async (t) => {
  const { root, site } = await makeFixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await assert.rejects(
    optimizeSite({ dir: site, out: path.join(site, "dist") }),
    /在源目录里面|不能等于源目录/,
  );
});

test("verify：单独校验一个目录（没有原文基准）也能挑出断链", async (t) => {
  const { root, site } = await makeFixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const out = path.join(root, "broken");
  await fs.mkdir(path.join(out, "assets"), { recursive: true });
  await fs.writeFile(
    path.join(out, "index.html"),
    `<img src="assets/nope.png"><script src="app.js"></script>`,
  );

  const result = await verifyOutput({ originalDir: out, outputDir: out });
  assert.equal(result.ok, false);
  const refCheck = result.checks.find((c) => c.name === "引用完整性");
  assert.equal(refCheck.status, "fail");
  assert.match(refCheck.detail, /assets\/nope\.png/);
});
