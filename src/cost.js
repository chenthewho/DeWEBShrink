/* ==========================================================================
   把字节换算成钱 —— 严格照协议前端那套算法重算一遍
   ========================================================================== */

"use strict";

import {
  CHUNK_BYTES,
  GAS_MODEL,
  HEADROOM_WEI,
  GAS_HEADROOM_NUM,
  GAS_HEADROOM_DEN,
  NETWORKS,
  chunkCount,
} from "./protocol.js";

const WEI_PER_GWEI = 1_000_000_000n;

/**
 * 估算一批文件的 gas。
 * @param {Array<{path:string, bytes:number, contentType?:string|null}>} files
 * @returns {{files:number, chunks:number, bytes:number, gas:number,
 *            chunkGas:number, byteGas:number, perFile:Array<object>,
 *            maxTxGasLimit:number}}
 */
export function estimateGas(files) {
  let chunks = 0;
  let bytes = 0;
  let maxTxGasLimit = 0;
  const perFile = [];

  for (const f of files) {
    const c = chunkCount(f.bytes);
    const gas = c * GAS_MODEL.perChunk + f.bytes * GAS_MODEL.perByte;
    // 单笔 gasLimit 要能装下最大的一块
    const biggestChunk = Math.min(CHUNK_BYTES, Math.max(f.bytes, 1));
    const limit = Math.min(
      GAS_MODEL.limitMax,
      GAS_MODEL.limitBase + biggestChunk * GAS_MODEL.limitPerByte,
    );
    if (limit > maxTxGasLimit) maxTxGasLimit = limit;
    chunks += c;
    bytes += f.bytes;
    perFile.push({
      path: f.path,
      bytes: f.bytes,
      chunks: c,
      gas,
      chunkGas: c * GAS_MODEL.perChunk,
      byteGas: f.bytes * GAS_MODEL.perByte,
    });
  }

  return {
    files: files.length,
    chunks,
    bytes,
    gas: chunks * GAS_MODEL.perChunk + bytes * GAS_MODEL.perByte,
    chunkGas: chunks * GAS_MODEL.perChunk,
    byteGas: bytes * GAS_MODEL.perByte,
    maxTxGasLimit,
    perFile,
  };
}

/** 协议的价格选择：max(地板价, min(实时价, 地板价×20))。返回 gwei 数字。 */
export function effectiveGasPriceGwei(networkKey, liveGwei = null) {
  const net = NETWORKS[networkKey] || NETWORKS.bsc;
  const floor = Number(net.gasFloorGwei);
  if (liveGwei == null || !Number.isFinite(Number(liveGwei)) || Number(liveGwei) <= 0) {
    return floor;
  }
  const live = Number(liveGwei);
  return Math.max(floor, Math.min(live, floor * GAS_MODEL.capMultiple));
}

/**
 * 估算的 gas → 钱。
 * @param {{gas:number, maxTxGasLimit:number}} estimate
 * @param {{gasPriceGwei:number, priceUsd?:number|null}} opts
 */
export function costOf(estimate, { gasPriceGwei, priceUsd = null }) {
  const priceWei = BigInt(Math.round(gasPriceGwei * 1e6)) * WEI_PER_GWEI / 1_000_000n;
  const gas = BigInt(Math.ceil(estimate.gas));
  const wei = gas * priceWei;
  const bnb = Number(wei) / 1e18;
  return {
    gasPriceGwei,
    gas: estimate.gas,
    wei: wei.toString(),
    native: bnb,
    usd: priceUsd == null ? null : bnb * priceUsd,
  };
}

/**
 * 协议在真正开始签交易之前要求钱包里备好的钱：
 * needWei = estGas×1.3×price + maxTxGasLimit×price + 0.0005 BNB
 */
export function fundingRequirementWei(estimate, gasPriceGwei) {
  const priceWei = BigInt(Math.round(gasPriceGwei * 1e6)) * WEI_PER_GWEI / 1_000_000n;
  const gas = BigInt(Math.ceil(estimate.gas));
  const maxTx = BigInt(estimate.maxTxGasLimit || GAS_MODEL.limitMax);
  const reserved = (gas * GAS_HEADROOM_NUM * priceWei) / GAS_HEADROOM_DEN + maxTx * priceWei + HEADROOM_WEI;
  return reserved;
}

/** 摘下 N 块要花的 gas（协议里的 removeFile 估算）。 */
export function removalGas(pathChunks, pathLen, fallbackLen) {
  return (
    GAS_MODEL.removeBase +
    GAS_MODEL.perOldChunk * pathChunks +
    GAS_MODEL.perPathSlot * (pathLen + fallbackLen)
  );
}

/* --------------------------- 代币价格（美元） --------------------------- */

const priceCache = new Map(); // `${net}` -> { at, usd, source }

/**
 * 价格源按「实测可用性」排序。api.binance.com / coingecko 在部分网络下直接连不上
 * （实测本机 curl 返回 000，而 data-api.binance.vision 返回 200），所以第一个源就是
 * 它，后面的只当兜底。取不到就返回 null —— 换算成人话而已，不该阻断任何计算。
 */
const PRICE_SOURCES = {
  BNB: [
    { name: "binance-data", url: "https://data-api.binance.vision/api/v3/ticker/price?symbol=BNBUSDT", pick: (j) => Number(j.price) },
    { name: "binance", url: "https://api.binance.com/api/v3/ticker/price?symbol=BNBUSDT", pick: (j) => Number(j.price) },
    { name: "coingecko", url: "https://api.coingecko.com/api/v3/simple/price?ids=binancecoin&vs_currencies=usd", pick: (j) => Number(j?.binancecoin?.usd) },
    { name: "coinbase", url: "https://api.coinbase.com/v2/prices/BNB-USD/spot", pick: (j) => Number(j?.data?.amount) },
  ],
  OKB: [
    { name: "okx", url: "https://www.okx.com/api/v5/market/ticker?instId=OKB-USDT", pick: (j) => Number(j?.data?.[0]?.last) },
    { name: "coingecko", url: "https://api.coingecko.com/api/v3/simple/price?ids=okb&vs_currencies=usd", pick: (j) => Number(j?.okb?.usd) },
  ],
  ETH: [
    { name: "binance-data", url: "https://data-api.binance.vision/api/v3/ticker/price?symbol=ETHUSDT", pick: (j) => Number(j.price) },
    { name: "binance", url: "https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT", pick: (j) => Number(j.price) },
    { name: "coingecko", url: "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd", pick: (j) => Number(j?.ethereum?.usd) },
  ],
};

/**
 * 取原生代币的美元价。
 * @returns {Promise<number|null>}
 */
export async function fetchNativePriceUsd(networkKey, { timeoutMs = 4000, ttlMs = 5 * 60_000 } = {}) {
  const net = NETWORKS[networkKey] || NETWORKS.bsc;
  const hit = priceCache.get(net.key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.usd;

  const sources = PRICE_SOURCES[net.symbol] || [];
  for (const src of sources) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(src.url, { signal: ac.signal, headers: { accept: "application/json" } });
      if (!res.ok) continue;
      const usd = src.pick(await res.json());
      if (Number.isFinite(usd) && usd > 0) {
        priceCache.set(net.key, { at: Date.now(), usd, source: src.name });
        return usd;
      }
    } catch {
      /* 换下一个源 */
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

/** 已经取到的价格是哪来的（报告里写清楚，别让用户猜）。 */
export function cachedPriceSource(networkKey) {
  const net = NETWORKS[networkKey] || NETWORKS.bsc;
  return priceCache.get(net.key)?.source || null;
}

/** 只读问一次 RPC 的 eth_gasPrice，失败返回 null。 */
export async function fetchLiveGasPriceGwei(networkKey, { timeoutMs = 4000 } = {}) {
  const net = NETWORKS[networkKey] || NETWORKS.bsc;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(net.rpc, {
      method: "POST",
      signal: ac.signal,
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_gasPrice", params: [] }),
    });
    if (!res.ok) return null;
    const j = await res.json();
    const wei = Number(BigInt(j.result));
    return wei / 1e9;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------- 格式化 ------------------------------- */

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function formatUsd(v) {
  if (v == null) return "—";
  if (v < 0.01) return `$${v.toFixed(4)}`;
  if (v < 1) return `$${v.toFixed(3)}`;
  return `$${v.toFixed(2)}`;
}

export function formatNative(v, symbol) {
  if (v == null) return "—";
  if (v === 0) return `0 ${symbol}`;
  if (v < 0.0001) return `${v.toExponential(3)} ${symbol}`;
  return `${v.toFixed(6)} ${symbol}`;
}
