/* 协议常量与计费：这些数字必须和 tapecode.ai 前端一致，错一个就会给用户算出错的账。 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  CHUNK_BYTES,
  GAS_MODEL,
  MAX_FILE_BYTES,
  chunkCount,
  classifyPath,
  contentTypeFor,
  isBadPath,
  isHiddenPath,
  txGasLimit,
} from "../src/protocol.js";
import {
  costOf,
  effectiveGasPriceGwei,
  estimateGas,
  fundingRequirementWei,
} from "../src/cost.js";

test("协议常量与前端一致", () => {
  assert.equal(CHUNK_BYTES, 24000);
  assert.equal(MAX_FILE_BYTES, 8 * 1024 * 1024);
  assert.equal(GAS_MODEL.perChunk, 270000);
  assert.equal(GAS_MODEL.perByte, 235);
  assert.equal(GAS_MODEL.floorGwei, "0.05");
  assert.equal(GAS_MODEL.capMultiple, 20);
});

test("块数：每 24000 字节一块，0 字节也算一块（一块 = 一笔交易）", () => {
  assert.equal(chunkCount(1), 1);
  assert.equal(chunkCount(24000), 1);
  assert.equal(chunkCount(24001), 2);
  assert.equal(chunkCount(0), 1);
});

test("路径规则：隐藏文件 / ../ / 控制字符 / 超长 都会被协议跳过", () => {
  assert.equal(isHiddenPath(".shots/a.png"), true);
  assert.equal(isHiddenPath("a/.b/c.png"), true);
  assert.equal(isHiddenPath("icons/a.png"), false);
  assert.equal(isBadPath("../etc/passwd"), true);
  assert.equal(isBadPath("/abs.png"), true);
  assert.equal(isBadPath("a\u0000b"), true);
  assert.equal(isBadPath("a".repeat(1001)), true);
  assert.equal(isBadPath("ok/path.png"), false);

  assert.equal(classifyPath(".DS_Store", 10).reason, "hidden");
  assert.equal(classifyPath("a/../b", 10).reason, "badpath");
  assert.equal(classifyPath("big.bin", MAX_FILE_BYTES + 1).reason, "toobig");
  assert.equal(classifyPath("ok.png", 10).ok, true);
});

test("Content-Type 表：webmanifest 不在表里 => octet-stream（这是 PWA 装不上的隐患）", () => {
  assert.equal(contentTypeFor("index.html"), "text/html; charset=utf-8");
  assert.equal(contentTypeFor("app.js"), "text/javascript");
  assert.equal(contentTypeFor("a/b.woff2"), "font/woff2");
  assert.equal(contentTypeFor("manifest.webmanifest"), "application/octet-stream");
  assert.equal(contentTypeFor("unknown.xyz"), "application/octet-stream");
});

test("单笔 gasLimit 不超过协议的 limitMax", () => {
  assert.equal(txGasLimit(24000), GAS_MODEL.limitBase + 24000 * GAS_MODEL.limitPerByte);
  assert.equal(txGasLimit(10_000_000), GAS_MODEL.limitMax);
});

test("gas 估算 = 块数×perChunk + 字节数×perByte", () => {
  const one = estimateGas([{ path: "a", bytes: 24000 }]);
  assert.equal(one.chunks, 1);
  assert.equal(one.gas, 270000 + 24000 * 235);

  const two = estimateGas([
    { path: "a", bytes: 24000 },
    { path: "b", bytes: 24000 },
  ]);
  assert.equal(two.chunks, 2);
  // 每个文件各自向上取整，所以 2 个小文件比 1 个大文件贵在「块开销」
  assert.equal(two.gas, 2 * 270000 + 48000 * 235);
});

test("gasPrice 取 max(地板价, min(实时价, 地板价×20))", () => {
  assert.equal(effectiveGasPriceGwei("bsc", null), 0.05);
  assert.equal(effectiveGasPriceGwei("bsc", 0.01), 0.05); // 低于地板价 → 地板价
  assert.equal(effectiveGasPriceGwei("bsc", 0.2), 0.2);
  assert.equal(effectiveGasPriceGwei("bsc", 99), 1); // 上限 0.05×20
  assert.equal(effectiveGasPriceGwei("base", null), 0.01); // 各链地板价不同
});

test("钱：1 MB 在 0.05 gwei 下 ≈ 0.0129 BNB", () => {
  const gas = estimateGas([{ path: "x", bytes: 1024 * 1024 }]);
  const cost = costOf(gas, { gasPriceGwei: 0.05, priceUsd: 1000 });
  assert.equal(gas.chunks, 44);
  assert.ok(Math.abs(cost.native - 0.0129147) < 1e-6, `实际 ${cost.native}`);
  assert.ok(Math.abs(cost.usd - 12.91) < 0.01);
});

test("备足余额：estGas×1.3×price + maxTxGasLimit×price + 0.0005 BNB", () => {
  const gas = estimateGas([{ path: "x", bytes: 24000 }]);
  const need = fundingRequirementWei(gas, 0.05);
  assert.ok(need > 0n);
  assert.equal(typeof need, "bigint");
});
