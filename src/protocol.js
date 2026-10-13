/* ==========================================================================
   TapeCode / TapeOut 协议常量 —— 与 tapecode.ai 前端 bundle 逐项对齐
   --------------------------------------------------------------------------
   数据来源：https://tapecode.ai/assets/main-*.js 与其常量 chunk
   （assets/__vite-browser-external-*.js）。下面是该 chunk 里那段常量的原样抄录，
   压缩后的变量名标在括号里：

     const N = 24e3,            // Wg —— 每块字节数（一块 = 一笔交易）
           T = 8*1024*1024,     // tx —— 单文件上限，超过的文件被静默跳过
           F = 18e4,            // 授权 TTL / 秒（本工具用不到）
           q = 96*1024,         // readRange 上限（本工具用不到）
           D = 24*3600,
           W = { perChunk: 27e4, perByte: 235, ... }   // Gi —— 计费模型

   计费模型（协议自己给用户看的估算就是这一个）：
       gas ≈ 块数 × 270000 + 字节数 × 235
       gasPrice = max(0.05 gwei, min(实时价, 0.05 gwei × 20))
   所以「体积 = 钱」，而且是**永久**的钱：字节写进合约存储后不会因为没人访问而消失。
   ========================================================================== */

"use strict";

/** 每块字节数（协议里的 Wg）。一块写一笔交易。 */
export const CHUNK_BYTES = 24_000;

/** 单文件上限（协议里的 tx）。超过的文件被前端静默跳过，用户看不到报错。 */
export const MAX_FILE_BYTES = 8 * 1024 * 1024;

/** 计费模型（协议里的 Gi）。gas = chunks*perChunk + bytes*perByte。 */
export const GAS_MODEL = Object.freeze({
  perChunk: 270_000,
  perByte: 235,
  limitBase: 400_000,
  limitPerByte: 260,
  limitMax: 16_500_000,
  perOldChunk: 6_000,
  removeBase: 150_000,
  setFallback: 150_000,
  perPathSlot: 25_000,
  bind: 260_000,
  setOperator: 200_000,
  transfer: 21_000,
  floorGwei: "0.05",
  capMultiple: 20,
});

/** 触发上传所需的最低余额余量（协议里的 headroomWei，0.0005 BNB）。 */
export const HEADROOM_WEI = 500_000_000_000_000n;

/** 上传前给估算 gas 乘的系数（协议里的 *13n/10n）。 */
export const GAS_HEADROOM_NUM = 13n;
export const GAS_HEADROOM_DEN = 10n;

/** 扩展名 → Content-Type（协议里的 R）。未知扩展名一律 application/octet-stream，
 *  而 octet-stream 的 html/js 不会按网页执行，所以扩展名写错 = 站点白传。 */
export const CONTENT_TYPES = Object.freeze({
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  js: "text/javascript",
  mjs: "text/javascript",
  css: "text/css",
  json: "application/json",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  wasm: "application/wasm",
  map: "application/json",
  xml: "application/xml",
  pdf: "application/pdf",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
});

export const DEFAULT_CONTENT_TYPE = "application/octet-stream";

/** 支持的网络（协议里的 v / O / k / S）。gasFloorGwei 各不相同。 */
export const NETWORKS = Object.freeze({
  bsc: {
    key: "bsc",
    name: "BNB Chain",
    symbol: "BNB",
    chainId: 56,
    gasFloorGwei: "0.05",
    registry: "0xd006ffdd5Ae313B17729621A00999cD3C71CE5e6",
    factory: "0x68224F668083c29e9800Be2a646d42d18cedF7e2",
    opener: "0x021745DE2f42A7839d96f2d3634d0294487D81F1",
    binding: "0x861EE183de2BBE4a6ecf9D15812C123b566a3DB7",
    explorer: "https://bscscan.com",
    rpc: "https://bsc-rpc.publicnode.com",
    coingeckoId: "binancecoin",
    binanceSymbol: "BNBUSDT",
  },
  xlayer: {
    key: "xlayer",
    name: "X Layer",
    symbol: "OKB",
    chainId: 196,
    gasFloorGwei: "0.02",
    registry: "0xd6efb7adcc9c83dc4924ad56f6a8e4e969b9adb6",
    factory: "0x1f09daefa827f02cbb40967cc91b259763760761",
    opener: "0x536add8f30f03b69f6fbf29d425a816a0dc50106",
    binding: "0x68809fd2fb343aa57d0aeb7f33defe477c9666f9",
    explorer: "https://www.okx.com/web3/explorer/xlayer",
    rpc: "https://rpc.xlayer.tech",
    coingeckoId: "okb",
    binanceSymbol: null,
  },
  base: {
    key: "base",
    name: "Base",
    symbol: "ETH",
    chainId: 8453,
    gasFloorGwei: "0.01",
    registry: "0xd6efb7adcc9c83dc4924ad56f6a8e4e969b9adb6",
    factory: "0x1f09daefa827f02cbb40967cc91b259763760761",
    opener: "0x536add8f30f03b69f6fbf29d425a816a0dc50106",
    binding: "0x68809fd2fb343aa57d0aeb7f33defe477c9666f9",
    explorer: "https://basescan.org",
    rpc: "https://mainnet.base.org",
    coingeckoId: "ethereum",
    binanceSymbol: null,
  },
});

/** 扩展名 → Content-Type（对应协议里的 fH）。 */
export function contentTypeFor(path) {
  const ext = String(path).split(".").pop().toLowerCase();
  return CONTENT_TYPES[ext] || DEFAULT_CONTENT_TYPE;
}

/** 路径归一化（协议里的 Cle：NFC）。 */
export function normalizePath(path) {
  return String(path).normalize("NFC");
}

/** 路径是否合法（协议里的 Q3，逐条抄录）。不合法 = 前端直接跳过这个文件。 */
export function isBadPath(path) {
  const p = String(path);
  return (
    p.includes("..") ||
    /[#?\0-\x1f\x7f]/.test(p) ||
    p.length > 1000 ||
    p.startsWith("/") ||
    p === ""
  );
}

/** 是否是隐藏文件（协议里的 B3：任一路径段以 "." 开头）。.shots/、.DS_Store 都在此列。 */
export function isHiddenPath(path) {
  return String(path)
    .split("/")
    .some((seg) => seg.startsWith("."));
}

/** 单文件的块数（协议里的 $le）。0 字节的文件也算 1 块 —— 一块 = 一笔交易 = 27 万 gas。 */
export function chunkCount(bytes) {
  return Math.max(1, Math.ceil(bytes / CHUNK_BYTES));
}

/** 单笔交易的 gasLimit（协议里的 aN），超过 limitMax 就说明这块太大了。 */
export function txGasLimit(bytes, oldChunks = 0) {
  return Math.min(
    GAS_MODEL.limitMax,
    GAS_MODEL.limitBase + bytes * GAS_MODEL.limitPerByte + oldChunks * GAS_MODEL.perOldChunk,
  );
}

/** 单块最大字节数：由 limitMax 反推（16.5M - 400k) / 260 ≈ 61,923，协议自己只用 24,000。 */
export const MAX_CHUNK_PAYLOAD = Math.floor(
  (GAS_MODEL.limitMax - GAS_MODEL.limitBase) / GAS_MODEL.limitPerByte,
);

/** 按协议规则判断一个文件会不会被上传。 */
export function classifyPath(path, bytes) {
  const p = normalizePath(path);
  if (isBadPath(p)) {
    return { ok: false, reason: "badpath", detail: "路径含 ..、控制字符、以 / 开头、或超过 1000 字符" };
  }
  if (isHiddenPath(p)) {
    return { ok: false, reason: "hidden", detail: "任一路径段以 . 开头，协议会整个跳过" };
  }
  if (bytes > MAX_FILE_BYTES) {
    return { ok: false, reason: "toobig", detail: `超过单文件上限 ${MAX_FILE_BYTES / 1024 / 1024} MiB` };
  }
  return { ok: true, reason: null, detail: null };
}

/** 协议里的 CNAME 网关（自有域名要走它）。 */
export const CNAME_GATEWAY = "cname.hashport.org";

/** 一条一句的真相，MCP 的 cost_model 资源直接读这里。 */
export const COST_MODEL_NOTES = [
  "站点内容按路径写进容器合约：第一块 putFile(container,path,contentType,sha256,data)，后续块 appendChunk(container,path,index,data)。",
  "每 24,000 字节 = 一块 = 一笔交易；gas ≈ 块数×270000 + 字节数×235。",
  "没有任何自动 gzip / brotli / WebP 转换：写进去的就是文件原始字节，所以源码体积就是账单。",
  "gasPrice 取 max(0.05 gwei, min(实时价, 1 gwei))——BSC 上的地板价 0.05 gwei 是常态。",
  "同一路径、同一 sha256 的文件会被跳过（不花 gas），所以「改一个字」只花那一个文件的钱，但那个文件是整份重传。",
  "单文件超过 8 MiB 会被静默跳过；路径含 .. / 控制字符 / 以 . 开头的隐藏文件同样被跳过。",
  "内容上链后永久保留：removeFile 只会从目录里取下，字节还在链上（取下本身也要花 gas）。",
];
