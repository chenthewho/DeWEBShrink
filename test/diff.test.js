/* ==========================================================================
   增量部署账单的测试
   --------------------------------------------------------------------------
   长期迭代的成本，全押在协议这一条规则上：**同一路径 + 同一 sha256 则跳过**。
   由此推出整件事的成立条件 —— 也是这里要守住的东西：

     1. **压缩必须确定性**。同一份输入压两次，产物要逐字节一致。
        否则「没改的文件」每次重压都会变，协议判定为新内容，全站重传 ——
        增量省钱就是空谈。这是第一块基石，所以第一个测试就是它。
     2. **变了就整份重传**。不是传 diff 出来的那几个字节，是付整个文件。
        改一个字节和改一半，账单一样。
     3. **块数按文件各向上取整**。改动一个 10 字节的文件，也要付满一块（27 万 gas）。
     4. **删除也要花 gas**（removeFile），虽然远比重新上传便宜。
   ========================================================================== */

"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";

import { diffSites } from "../src/diff.js";
import { optimizeSite } from "../src/optimize/index.js";
import { createMemorySink, createMemorySource } from "../src/source.js";
import { GAS_MODEL } from "../src/protocol.js";

const PRICING = { network: "bsc", gasPriceGwei: 0.05, priceUsd: 750 };

const HTML = `<!doctype html>
<html><head><meta charset="utf-8"><link rel="stylesheet" href="app.css"></head>
<body>
  <h1>  增量测试  </h1>
  <!-- 注释会被压掉 -->
  <img src="hero.png" alt="hero">
  <script src="app.js"></script>
</body></html>
`;

const JS = `/* 一段横幅注释 */
(function () {
  var CONFIG = { retries: 3, timeoutMs: 5000 };
  function compute(inputValue) {
    var accumulator = 0;
    for (var i = 0; i < inputValue.length; i++) accumulator += inputValue[i];
    return accumulator;
  }
  window.App = { compute: compute, config: CONFIG };
})();
`;

const CSS = `/* 样式注释 */
body { margin: 0; padding: 24px; background: #101014; color: #e8e8ec; }
h1 { font-size: 28px; }
`;

/** 一个「大而不常改」的静态资源，用 base64 假装是图片。 */
const BIG_ASSET = { path: "hero.png", base64: Buffer.alloc(120 * 1024, 7).toString("base64") };

function baseFiles() {
  return [
    { path: "index.html", content: HTML },
    { path: "app.js", content: JS },
    { path: "app.css", content: CSS },
    BIG_ASSET,
  ];
}

/** 压一遍，拿到产物（模拟「链上已经发布的那一版」）。 */
async function compress(files) {
  const result = await optimizeSite({
    source: createMemorySource(files),
    sink: createMemorySink(),
    ...PRICING,
  });
  return {
    artifacts: result.artifacts.map((a) => ({ path: a.path, base64: a.base64 })),
    result,
  };
}

/* ----------------------- 基石：压缩必须确定性 ----------------------- */

test("压缩是确定性的：同一份输入压两次，产物逐字节一致", async () => {
  const files = baseFiles();
  const a = await compress(files);
  const b = await compress(files);

  const byPath = new Map(a.artifacts.map((x) => [x.path, x.base64]));
  assert.equal(byPath.size, b.artifacts.length, "两次产物文件数要一样");
  for (const x of b.artifacts) {
    assert.equal(
      byPath.get(x.path),
      x.base64,
      `${x.path} 两次压缩结果不一致 —— 增量省钱的前提就没了`,
    );
  }
});

test("确定性前提下的实际收益：改一个文件后重压，未改动的文件字节不变", async () => {
  const v1 = baseFiles();
  const out1 = await compress(v1);

  // 只改 app.js 一行，其他保持原样
  const v2 = v1.map((f) =>
    f.path === "app.js" ? { ...f, content: f.content.replace("retries: 3", "retries: 5") } : f,
  );
  const out2 = await compress(v2);

  const h1 = new Map(out1.artifacts.map((x) => [x.path, x.base64]));
  const changedArtifacts = out2.artifacts.filter((x) => h1.get(x.path) !== x.base64);

  assert.equal(changedArtifacts.length, 1, `只该有 app.js 变，实际变了 ${changedArtifacts.length} 个`);
  assert.equal(changedArtifacts[0].path, "app.js");
});

/* --------------------------- 增量账单本身 --------------------------- */

test("两版完全相同：一分钱都不用花", async () => {
  const files = baseFiles();
  const out = await compress(files);
  const d = await diffSites({ previous: createMemorySource(out.artifacts), next: createMemorySource(out.artifacts), ...PRICING });

  assert.equal(d.changed.length, 0);
  assert.equal(d.added.length, 0);
  assert.equal(d.removed.length, 0);
  assert.equal(d.unchanged.length, out.artifacts.length);
  assert.equal(d.total.gas, 0);
  assert.equal(d.total.cost.native, 0);
});

test("改一个文件：按那个文件的**完整体积**计费，不是 diff 出来的几个字节", async () => {
  const v1 = baseFiles();
  const out1 = await compress(v1);

  // 改的必须是「会活到产物里」的东西（改变量的值），不能只改注释 ——
  // 只改注释的话产物字节不变，那是另一种情况，见下一个测试。
  const v2 = v1.map((f) =>
    f.path === "app.js" ? { ...f, content: f.content.replace("retries: 3", "retries: 5") } : f,
  );
  const out2 = await compress(v2);

  const d = await diffSites({
    previous: createMemorySource(out1.artifacts),
    next: createMemorySource(out2.artifacts),
    ...PRICING,
  });

  assert.equal(d.changed.length, 1);
  assert.equal(d.changed[0].path, "app.js");
  assert.equal(d.unchanged.length, out1.artifacts.length - 1);

  // 上传字节 = 新 app.js 的完整字节，而不是「改了一个字符」
  const newJs = out2.artifacts.find((x) => x.path === "app.js");
  assert.equal(d.upload.bytes, Buffer.from(newJs.base64, "base64").length);
  assert.ok(d.upload.bytes > 50, "显然是整份重传，不是只传改动的那几个字节");

  // 未改动的文件（含那张 120 KB 的大图）一分钱不花
  assert.ok(d.upload.bytes < d.full.bytes, "增量上传必须远小于全量");
});

test("只改注释 / 空行：压缩后产物完全没变，部署一分钱不花", async () => {
  const v1 = baseFiles();
  const out1 = await compress(v1);

  // 加了注释和空行 —— 压缩时会被去掉，产物逐字节不变
  const v2 = v1.map((f) =>
    f.path === "app.js"
      ? { ...f, content: `/* 新增一整段说明注释，写完发现自己只是在解释代码 */\n\n${f.content}\n\n// 再来一行\n` }
      : f,
  );
  const out2 = await compress(v2);

  const d = await diffSites({
    previous: createMemorySource(out1.artifacts),
    next: createMemorySource(out2.artifacts),
    ...PRICING,
  });

  assert.equal(d.changed.length, 0, "注释被压掉了，产物应该完全没变");
  assert.equal(d.total.gas, 0, "产物没变就不需要重传，一分钱都不用花");
  assert.equal(d.total.cost.native, 0);
});

test("增量成本远小于全量：省下的正好是未改动文件", async () => {
  const v1 = baseFiles();
  const out1 = await compress(v1);
  const v2 = v1.map((f) =>
    f.path === "app.css" ? { ...f, content: `${f.content}\n.fix { color: red; }\n` } : f,
  );
  const out2 = await compress(v2);

  const d = await diffSites({
    previous: createMemorySource(out1.artifacts),
    next: createMemorySource(out2.artifacts),
    ...PRICING,
  });

  assert.ok(d.total.gas < d.full.gas, "增量必须比全量便宜");
  assert.equal(d.savedVsFull.gas, d.full.gas - d.total.gas, "省下的 gas 要对得上");
  assert.ok(d.savedVsFull.usd > 0, "省下的钱要能算出来");

  // 那张 120 KB 的图没改，它占了全量成本的大头 —— 正是被省掉的部分
  const bigBefore = d.full.perFile.find((f) => f.path === "hero.png");
  assert.ok(bigBefore, "全量账单里应该能看到那张大图");
  assert.ok(
    d.upload.perFile.every((f) => f.path !== "hero.png"),
    "没改动的大图不该出现在这次的付费清单里",
  );
});

test("改动一个极小文件也要付满一块（块数按文件向上取整）", async () => {
  const before = [{ path: "a.js", content: "var a = 1;" }];
  const after = [{ path: "a.js", content: "var a = 2;" }];
  const d = await diffSites({
    previous: createMemorySource(before),
    next: createMemorySource(after),
    ...PRICING,
  });

  assert.equal(d.upload.chunks, 1);
  assert.ok(
    d.upload.gas >= GAS_MODEL.perChunk,
    `改动哪怕一个字节也要付满块开销 ${GAS_MODEL.perChunk}，实际 ${d.upload.gas}`,
  );
});

/* ----------------------- 新增 / 删除 / 首次部署 ----------------------- */

test("新增的文件要传，按完整字节计费", async () => {
  const v1 = [{ path: "a.js", content: "var a = 1;" }];
  const v2 = [...v1, { path: "b.js", content: "var b = 2;" }];
  const d = await diffSites({
    previous: createMemorySource(v1),
    next: createMemorySource(v2),
    ...PRICING,
  });
  assert.equal(d.added.length, 1);
  assert.equal(d.added[0].path, "b.js");
  assert.equal(d.upload.files, 1);
});

test("删除的文件也要花 gas（removeFile），并且计入总额", async () => {
  const v1 = [
    { path: "a.js", content: "var a = 1;" },
    { path: "old.js", content: "var old = 1;" },
  ];
  const v2 = [{ path: "a.js", content: "var a = 1;" }];
  const d = await diffSites({
    previous: createMemorySource(v1),
    next: createMemorySource(v2),
    ...PRICING,
  });

  assert.equal(d.removed.length, 1);
  assert.equal(d.removed[0].path, "old.js");
  assert.ok(d.removal.gas > 0, "删除不是免费的");
  assert.equal(d.total.gas, d.upload.gas + d.removal.gas, "总额要把删除算进去");
});

test("不给 previous = 首次部署：全部文件都要传，等于全量", async () => {
  const files = baseFiles();
  const out = await compress(files);
  const d = await diffSites({ previous: null, next: createMemorySource(out.artifacts), ...PRICING });

  assert.equal(d.firstDeploy, true);
  assert.equal(d.added.length, out.artifacts.length);
  assert.equal(d.total.gas, d.full.gas);
  assert.equal(d.savedVsFull.gas, 0);
});

/* ------------------------------- 端到端 ------------------------------- */

test("端到端：压缩后的站点改一处，增量账单只算那一个文件", async () => {
  // 源站 v1 → 压缩 → 这就是「链上那一版」
  const out1 = await compress(baseFiles());

  // 源站改一个文件 → 重新压缩 → 这是「要部署的新版本」
  const v2 = baseFiles().map((f) =>
    f.path === "index.html" ? { ...f, content: f.content.replace("增量测试", "改过的标题") } : f,
  );
  const out2 = await compress(v2);

  const d = await diffSites({
    previous: createMemorySource(out1.artifacts),
    next: createMemorySource(out2.artifacts),
    ...PRICING,
  });

  assert.equal(d.changed.length, 1, "只改了 index.html，就该只有一个文件重传");
  assert.equal(d.changed[0].path, "index.html");
  assert.ok(d.upload.bytes < 1024, "只传一个压过的小 HTML，字节数应该很小");
  assert.ok(
    d.total.cost.usd < d.full.cost.usd / 10,
    `增量应该不到全量的十分之一（增量 $${d.total.cost.usd?.toFixed(4)} / 全量 $${d.full.cost.usd?.toFixed(4)}）`,
  );
});
