/* ==========================================================================
   服务器护栏 —— 公开服务必须有的那几道闸
   --------------------------------------------------------------------------
   这个工具跑在服务器上、由陌生人调用时，最大的风险不是算错账，而是**被拖死**：
   sharp 和 esbuild 都是 CPU 密集型，一个 8 MiB 的 PNG 或几 MB 的 JS 就能把进程占住。
   所以公开部署必须有三道闸：

     1. 体积闸：单次请求的总字节与文件数有上限（默认 8 MiB / 2000 个文件），
        超了要说清楚「超了多少、怎么分批」，而不是丢一个 500；
     2. 并发闸：同时只跑 N 个压缩任务，多的排队 —— 宁可慢，不可雪崩；
     3. 超时闸：到点就放弃等待并释放槽位。

   一个必须说清楚的限制：超时只是**不再等它**，并不能真的掐断已经在跑的 CPU 工作。
   sharp 走的是原生线程池、esbuild 走子进程，都不是靠 event loop 的 setTimeout 能中断的。
   真正想硬性隔离，得把压缩放进 worker_threads 或单独进程 —— 这里不做，
   但把「超时后槽位会释放」这件事保证了，免得一次超时把服务永久卡住。
   ========================================================================== */

"use strict";

/** 从环境变量读一个正整数，读不到就用默认值。 */
function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * 默认护栏。全部可以用环境变量覆盖，但体积上限不建议放开太多。
 * 这里是护栏的唯一真相源 —— http.js 的启动日志和工具里的校验都读它。
 */
export const SERVER_LIMITS = Object.freeze({
  /** 单次请求里所有文件的原始字节总和 */
  maxRequestBytes: envInt("DEWEB_SHRINK_MAX_BYTES", 8 * 1024 * 1024),
  /** 单次请求的文件数 */
  maxFiles: envInt("DEWEB_SHRINK_MAX_FILES", 2000),
  /** 同时进行的压缩任务数 */
  maxConcurrency: envInt("DEWEB_SHRINK_CONCURRENCY", 4),
  /** 单个任务的最长等待时间 */
  timeoutMs: envInt("DEWEB_SHRINK_TIMEOUT_MS", 120_000),
});

function utf8Len(s) {
  return Buffer.byteLength(s, "utf8");
}

/**
 * 量一批外部传进来的文件有多大。
 * base64 按 4 字符 → 3 字节估算（不真解码，免得为了「量体积」先吃一遍内存）。
 */
export function measureFiles(files) {
  let bytes = 0;
  for (const f of files) {
    if (!f || typeof f !== "object") continue;
    if (f.bytes instanceof Uint8Array) bytes += f.bytes.length;
    else if (typeof f.base64 === "string") bytes += Math.floor((f.base64.length * 3) / 4);
    else if (typeof f.content === "string") bytes += utf8Len(f.content);
  }
  return { files: files.length, bytes };
}

/** 把字节数说成人话，错误信息里要用。 */
function human(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * 超出护栏就抛错。错误信息必须可操作 —— 告诉调用方超了多少、下一步怎么做。
 * @param {Array<object>} files
 * @param {{maxRequestBytes:number, maxFiles:number}} [limits]
 */
export function assertWithinLimits(files, limits = SERVER_LIMITS) {
  const { files: count, bytes } = measureFiles(files);

  if (count > limits.maxFiles) {
    throw new Error(
      `文件太多：这次传了 ${count} 个，上限是 ${limits.maxFiles} 个。` +
        `请分批调用（例如先传 HTML/CSS/JS，再传图片），每批不超过 ${limits.maxFiles} 个。`,
    );
  }
  if (bytes > limits.maxRequestBytes) {
    throw new Error(
      `这次传的内容太大：${human(bytes)}，上限是 ${human(limits.maxRequestBytes)}。` +
        `请分批调用 —— 先单独压最大的那几个文件，剩下的再传一批。` +
        `（图片转 base64 后会膨胀约 1/3，如果原始字节接近上限，base64 后就会超。）`,
    );
  }
  return { files: count, bytes };
}

/**
 * 并发闸门 + 超时。用法：`await gate.run(() => 干活())`。
 * 超时后槽位一定会释放，所以一次超时不会把服务永久卡住。
 */
export function createGate(options = {}) {
  const maxConcurrency = options.maxConcurrency ?? SERVER_LIMITS.maxConcurrency;
  const timeoutMs = options.timeoutMs ?? SERVER_LIMITS.timeoutMs;

  let active = 0;
  let peak = 0;
  let served = 0;
  let timedOut = 0;
  const waiting = [];

  async function acquire() {
    if (active >= maxConcurrency) {
      await new Promise((resolve) => waiting.push(resolve));
    }
    active++;
    if (active > peak) peak = active;
  }

  function release() {
    active--;
    const next = waiting.shift();
    if (next) next();
  }

  async function run(fn) {
    await acquire();
    let timer = null;
    try {
      const work = fn();
      if (!timeoutMs || timeoutMs <= 0) {
        const out = await work;
        served++;
        return out;
      }
      const out = await Promise.race([
        work,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            timedOut++;
            const howLong = timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} 秒` : `${timeoutMs} 毫秒`;
            reject(
              new Error(
                `这次压缩超过 ${howLong}还没跑完，已经放弃等待。` +
                  `通常是某个文件特别大 —— 请把它单独传一次，或者先跳过它。`,
              ),
            );
          }, timeoutMs);
        }),
      ]);
      served++;
      return out;
    } finally {
      if (timer) clearTimeout(timer);
      release();
    }
  }

  return {
    run,
    get stats() {
      return { active, queued: waiting.length, peak, served, timedOut, maxConcurrency, timeoutMs };
    },
  };
}
