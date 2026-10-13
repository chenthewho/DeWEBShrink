/* ==========================================================================
   计费一致性测试
   --------------------------------------------------------------------------
   这里要钉住两件事：

   1. **公式本身**：块数按文件各向上取整、0 字节也占一块、文件越多块开销越贵。
      这几条是「为什么小文件也贵」的全部原因，算错了整个工具的结论就反了。

   2. **与链上实测对齐**：fixtures/07-real-site 是从 super-lock 复制的完整站点，
      而 super-lock 已经真的发布到链上了（1413.30.tape，容器 0xa479…5a41）。
      链上读回来的实际数据是 21 个文件 / 831,130 字节 / 48 块。
      工具算出来的压缩前账单必须**一模一样** —— 对不上就说明计费模型漂了，
      那所有「省了多少钱」的说法都不成立。

   依赖 fixtures/ 已生成（node scripts/make-fixtures.mjs）；没生成就跳过，
   不让「没跑生成脚本」变成测试失败。
   ========================================================================== */

"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { estimateGas, costOf } from "../src/cost.js";
import { GAS_MODEL, CHUNK_BYTES, MAX_FILE_BYTES } from "../src/protocol.js";
import { scanSite } from "../src/scan.js";
import { optimizeSite } from "../src/optimize/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, "..", "fixtures");

async function fixtureExists(name) {
  try {
    await fs.access(path.join(FIXTURES, name));
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------ 公式本身 ------------------------------ */

test("块数按文件各向上取整：10 个 3KB 文件比 1 个 30KB 文件贵得多", () => {
  const many = estimateGas(Array.from({ length: 10 }, (_, i) => ({ path: `f${i}.js`, bytes: 3000 })));
  const one = estimateGas([{ path: "a.js", bytes: 30000 }]);

  assert.equal(many.chunks, 10, "10 个文件各占一块");
  assert.equal(one.chunks, 2, "30KB 只占两块");
  assert.equal(many.bytes, one.bytes, "字节数一样");
  assert.ok(many.gas > one.gas, "同样的字节数，拆成多文件更贵");
  // 差的正好是 8 块的固定开销
  assert.equal(many.gas - one.gas, 8 * GAS_MODEL.perChunk);
});

test("0 字节的文件也占整整一块（一块 = 一笔交易 = 27 万 gas）", () => {
  const g = estimateGas([{ path: "empty.txt", bytes: 0 }]);
  assert.equal(g.chunks, 1);
  assert.equal(g.gas, GAS_MODEL.perChunk, "0 字节也要付满块开销");
});

test("恰好整除 24,000 时不额外多一块", () => {
  assert.equal(estimateGas([{ path: "a.bin", bytes: CHUNK_BYTES }]).chunks, 1);
  assert.equal(estimateGas([{ path: "a.bin", bytes: CHUNK_BYTES + 1 }]).chunks, 2);
  assert.equal(estimateGas([{ path: "a.bin", bytes: CHUNK_BYTES * 3 }]).chunks, 3);
});

test("gas 拆开算等于合起来算（块开销 + 字节开销）", () => {
  const g = estimateGas([{ path: "a.bin", bytes: 50000 }]);
  assert.equal(g.chunkGas, g.chunks * GAS_MODEL.perChunk);
  assert.equal(g.byteGas, 50000 * GAS_MODEL.perByte);
  assert.equal(g.gas, g.chunkGas + g.byteGas);
});

test("费用换算：gas × gasPrice，且美元价可选", () => {
  const g = estimateGas([{ path: "a.bin", bytes: 1024 * 1024 }]);
  const c = costOf(g, { gasPriceGwei: 0.05, priceUsd: 750 });
  // 1 MB = 44 块 → 44*270000 + 1048576*235
  assert.equal(g.chunks, 44);
  assert.equal(g.gas, 44 * GAS_MODEL.perChunk + 1048576 * GAS_MODEL.perByte);
  const expectedBnb = g.gas * 0.05e-9;
  assert.ok(Math.abs(c.native - expectedBnb) < 1e-12, "BNB 换算要对");
  assert.ok(Math.abs(c.usd - expectedBnb * 750) < 1e-9, "美元换算要对");

  const noPrice = costOf(g, { gasPriceGwei: 0.05, priceUsd: null });
  assert.equal(noPrice.usd, null, "取不到币价时不该编一个出来");
});

/* --------------------------- 协议跳过的规则 --------------------------- */

test("协议会静默跳过的四类文件：隐藏 / 超 8MiB / 非法路径", async (t) => {
  if (!(await fixtureExists("05-messy"))) return t.skip("fixtures 未生成，先跑 node scripts/make-fixtures.mjs");

  const scan = await scanSite(path.join(FIXTURES, "05-messy"));
  const reasons = new Map(scan.skipped.map((f) => [f.path, f.skippedReason]));

  assert.ok(reasons.has(".DS_Store"), "隐藏文件要被判出来");
  assert.equal(reasons.get(".DS_Store"), "hidden");
  assert.ok(
    [...reasons.keys()].some((p) => p.startsWith(".shots/")),
    ".shots/ 目录下的文件也要被判出来",
  );
  assert.equal(reasons.get("huge-video.mp4"), "toobig", "超过 8 MiB 要被判出来");
  assert.ok(
    [...reasons.values()].includes("badpath"),
    "路径含控制字符要被判出来",
  );

  // 被跳过的文件一律不计费
  const skippedBytes = scan.skipped.reduce((a, f) => a + f.bytes, 0);
  assert.ok(skippedBytes > 8 * 1024 * 1024, "这个 fixture 里被跳过的字节应该超过 8 MiB");
  assert.ok(
    !scan.billable.some((f) => scan.skipped.includes(f)),
    "被跳过的文件不能出现在计费清单里",
  );
});

test("manifest.webmanifest 会被协议当成 application/octet-stream（PWA 装不上）", async (t) => {
  if (!(await fixtureExists("05-messy"))) return t.skip("fixtures 未生成");

  const scan = await scanSite(path.join(FIXTURES, "05-messy"));
  const mf = scan.billable.find((f) => /manifest\.webmanifest$/.test(f.path));
  assert.ok(mf, "fixture 里应该有一个 manifest.webmanifest");
  assert.equal(mf.contentType, "application/octet-stream");
  assert.equal(mf.isDefaultType, true);
});

/* ------------------------ 与链上实测对齐（关键） ------------------------ */

test("真实站点的压缩前账单与链上实测完全一致（21 文件 / 831,130 字节 / 48 块）", async (t) => {
  if (!(await fixtureExists("07-real-site"))) return t.skip("fixtures 未生成");

  const scan = await scanSite(path.join(FIXTURES, "07-real-site"));

  // 这三个数字来自链上实际发布的那份站点（1413.30.tape）：
  // 用 TapeKit 内核读 SiteRegistry 得到 21 个路径、831,130 字节、48 块。
  assert.equal(scan.totals.billableFiles, 21, "文件数要和链上一致");
  assert.equal(scan.totals.bytes, 831130, "字节数要和链上一致");
  assert.equal(scan.totals.chunks, 48, "块数要和链上一致");

  // 由此得出的 gas 与费用也要能对上（BSC 地板价 0.05 gwei）
  assert.equal(scan.totals.gas, 48 * GAS_MODEL.perChunk + 831130 * GAS_MODEL.perByte);
  const cost = costOf(estimateGas(scan.billable), { gasPriceGwei: 0.05, priceUsd: 750 });
  assert.ok(Math.abs(cost.usd - 7.81) < 0.02, `链上实际约 $7.81，算出来是 $${cost.usd.toFixed(2)}`);
});

test("真实站点压缩后确实更便宜，且校验通过", async (t) => {
  if (!(await fixtureExists("07-real-site"))) return t.skip("fixtures 未生成");

  const dir = path.join(FIXTURES, "07-real-site");
  const out = path.join(FIXTURES, "07-real-site.tape");
  const result = await optimizeSite({ dir, out, network: "bsc", gasPriceGwei: 0.05, priceUsd: 750 });

  assert.ok(result.saved.bytes > 0, "要真的压小了");
  assert.ok(result.saved.chunks > 0, "块数也要减少（少发交易）");
  assert.ok(result.saved.usd > 0, "要省钱");
  assert.equal(result.verification.ok, true, "压完必须能安全上链");

  // 源目录必须一个字节都没动
  const after = await scanSite(dir);
  assert.equal(after.totals.bytes, 831130, "源目录的字节数不能变");
});

test("字体是硬骨头：不做子集化，压缩收益接近零（账单要如实反映）", async (t) => {
  if (!(await fixtureExists("03-fonts"))) return t.skip("fixtures 未生成");

  const dir = path.join(FIXTURES, "03-fonts");
  const result = await optimizeSite({
    dir,
    out: path.join(FIXTURES, "03-fonts.tape"),
    network: "bsc",
    gasPriceGwei: 0.05,
    priceUsd: 750,
  });

  const fontBytesBefore = result.before.files
    .filter((f) => /\.woff2?$/.test(f.path))
    .reduce((a, f) => a + f.bytes, 0);
  assert.ok(fontBytesBefore > 170 * 1024, "这个 fixture 的字体应该占大头");

  // 工具刻意不做字体子集化，所以整体收益应该很小 —— 不能假装能压
  const pct = (result.saved.bytes / result.before.totals.bytes) * 100;
  assert.ok(pct < 5, `字体站的收益应该很小（实测 ${pct.toFixed(1)}%），不能虚报`);
});
