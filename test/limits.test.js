/* ==========================================================================
   服务器护栏的单元测试
   --------------------------------------------------------------------------
   公开服务被陌生人调用时，最怕的不是算错账，而是被一个巨大的请求拖死。
   这里盯住三道闸各自的边界，以及「超时后槽位一定要释放」——
   最后这条最重要：如果超时不释放，一次超时就能把服务永久卡死。
   ========================================================================== */

"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";

import { SERVER_LIMITS, assertWithinLimits, createGate, measureFiles } from "../src/limits.js";

test("体积护栏：超限时报错，并说清楚超了多少、该怎么办", () => {
  const files = [{ path: "big.js", content: "x".repeat(2000) }];
  assert.throws(
    () => assertWithinLimits(files, { maxRequestBytes: 1000, maxFiles: 10 }),
    (err) => {
      assert.match(err.message, /内容太大/);
      assert.match(err.message, /2\.0 KB/, "要说清楚实际多大");
      assert.match(err.message, /1000 B/, "要说清楚上限多少");
      assert.match(err.message, /分批/, "要给出可操作的下一步");
      return true;
    },
  );
});

test("文件数护栏：超限时报错", () => {
  const files = Array.from({ length: 5 }, (_, i) => ({ path: `f${i}.js`, content: "x" }));
  assert.throws(
    () => assertWithinLimits(files, { maxRequestBytes: 1e9, maxFiles: 3 }),
    /文件太多.*5 个.*上限是 3 个/,
  );
});

test("base64 按 3/4 估算体积（不真解码，省一次内存）", () => {
  const m = measureFiles([{ path: "a.png", base64: "A".repeat(4000) }]);
  assert.equal(m.bytes, 3000);
  assert.equal(m.files, 1);
});

test("bytes 与 content 也能量对", () => {
  const m = measureFiles([
    { path: "a.js", content: "abcde" },
    { path: "b.png", bytes: new Uint8Array(7) },
  ]);
  assert.equal(m.bytes, 12);
  assert.equal(m.files, 2);
});

test("没超限就正常返回统计，不抛错", () => {
  const r = assertWithinLimits([{ path: "a.js", content: "x".repeat(10) }], {
    maxRequestBytes: 1000,
    maxFiles: 10,
  });
  assert.deepEqual(r, { files: 1, bytes: 10 });
});

test("默认护栏是合理值（且可被环境变量覆盖）", () => {
  assert.equal(SERVER_LIMITS.maxRequestBytes, 8 * 1024 * 1024);
  assert.equal(SERVER_LIMITS.maxFiles, 2000);
  assert.ok(SERVER_LIMITS.maxConcurrency >= 1);
  assert.ok(SERVER_LIMITS.timeoutMs > 0);
});

test("并发闸门：同时跑的不会超过上限，但全部都会跑完", async () => {
  const gate = createGate({ maxConcurrency: 2, timeoutMs: 5000 });
  let active = 0;
  let peak = 0;
  const job = async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 30));
    active--;
  };
  await Promise.all(Array.from({ length: 6 }, () => gate.run(job)));
  assert.ok(peak <= 2, `峰值并发 ${peak} 不该超过 2`);
  assert.equal(gate.stats.served, 6, "六个任务都要跑完");
  assert.equal(gate.stats.active, 0, "跑完后不该有残留占用");
});

test("并发闸门：超时会抛错，而且槽位一定会释放（否则一次超时就卡死服务）", async () => {
  const gate = createGate({ maxConcurrency: 1, timeoutMs: 30 });
  // 用一个「可以手动收尾」的挂起任务，而不是 new Promise(() => {})：
  // 后者永远不 resolve，测试结束时事件循环里会留一个悬空 promise。
  let release;
  const hanging = new Promise((resolve) => {
    release = resolve;
  });

  await assert.rejects(() => gate.run(() => hanging), /放弃等待/);
  assert.equal(gate.stats.active, 0, "超时后槽位必须释放");
  assert.equal(gate.stats.timedOut, 1);

  release(); // 收尾，别把悬空 promise 留到下一个用例
  // 释放了才可能继续接活
  const ok = await gate.run(async () => "done");
  assert.equal(ok, "done");
});

test("并发闸门：一个任务抛错不会污染闸门状态", async () => {
  const gate = createGate({ maxConcurrency: 2, timeoutMs: 1000 });
  await assert.rejects(() => gate.run(async () => { throw new Error("boom"); }), /boom/);
  assert.equal(gate.stats.active, 0);
  assert.equal(await gate.run(async () => 42), 42);
});
