#!/usr/bin/env node
/* ==========================================================================
   deweb-shrink · MCP server
   --------------------------------------------------------------------------
   给「上传到 tapecode.ai / TapeOut 之前」这件事专用的 MCP：
     cost_model   协议怎么计费（为什么体积 = 钱），常量原样给出
     scan         扫站点：会被上传哪些文件、多少字节、多少块、多少钱
     estimate     只给字节数：算钱（改一版大概多花多少）
     optimize     压出一份新站点，并给出前后费用对比 + 校验结果
     verify       校验一份站点能不能安全上链（引用/语法/Content-Type/上限）
     diff         增量账单：从链上那一版到这一版，实际上传要多花多少钱

   两种用法，同一套算法：

     · **本地（stdio）**：`node src/index.js`，工具接 `dir`（本地目录路径），产物写盘。
       这是开发/自用形态，也是 `bin` 的默认行为。

     · **服务器（Streamable HTTP）**：`node src/http.js`，工具接 `files`
       （agent 把文件内容当参数传进来），产物以 base64 带回。
       服务器上**没有**用户那个目录，所以内容驱动是唯一的可能形态，见 source.js。

   工具都**不会碰源目录**：optimize 只往一个独立的产物目录（或内存）写。
   ========================================================================== */

"use strict";

import path from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  CHUNK_BYTES,
  COST_MODEL_NOTES,
  CNAME_GATEWAY,
  GAS_MODEL,
  MAX_CHUNK_PAYLOAD,
  MAX_FILE_BYTES,
  NETWORKS,
} from "./protocol.js";
import {
  costOf,
  effectiveGasPriceGwei,
  estimateGas,
  fetchLiveGasPriceGwei,
  fetchNativePriceUsd,
  formatBytes,
  formatNative,
  formatUsd,
} from "./cost.js";
import { scanSite } from "./scan.js";
import { createFsSource, createMemorySink, createMemorySource } from "./source.js";
import { SERVER_LIMITS, assertWithinLimits } from "./limits.js";
import { formatOptimizeReport, formatScanReport, formatAssumptions } from "./report.js";
import { optimizeSite } from "./optimize/index.js";
import { verifyOutput } from "./verify.js";
import { diffSites, formatDiffReport } from "./diff.js";

const NETWORK_KEYS = Object.keys(NETWORKS);
const networkSchema = z.enum(NETWORK_KEYS).optional().describe("链：bsc（默认）/ xlayer / base");

/* --------------------------- 输入：目录 or 内容 --------------------------- */

const fileEntrySchema = z.object({
  path: z.string().describe("相对路径，如 index.html、assets/app.js（前导 / 会被去掉）"),
  content: z.string().optional().describe("文本文件内容（HTML/CSS/JS/JSON 用这个）"),
  base64: z.string().optional().describe("二进制文件内容（图片/字体用这个，base64 编码）"),
});

const filesSchema = z
  .array(fileEntrySchema)
  .optional()
  .describe(
    `文件内容（服务器部署用）。适合 agent 把用户上传的文件传进来；` +
      `单次总量上限 ${(SERVER_LIMITS.maxRequestBytes / 1024 / 1024).toFixed(0)} MB、${SERVER_LIMITS.maxFiles} 个文件，超了要分批。`,
  );

const dirSchema = z.string().optional().describe("站点目录（本地用；服务器上没有这个目录，请改用 files）");

/**
 * 从工具入参里取一个文件源。files 优先（服务器形态），否则用 dir（本地形态）。
 * 护栏只对 files 生效 —— 本地目录是使用者自己的机器，不需要限流。
 *
 * **两者都不给必须报错**：以前这里回退到 process.cwd()，在服务器上就等于
 * 「扫描部署目录自己」——认证用户能拿到 ~/deweb-shrink 的完整文件清单（含 .mcp-key
 * 的存在与大小）。空参数几乎一定是 agent 忘了传，报错比悄悄扫别的东西安全得多。
 * `files: []` 也算空：空批次不是「整个磁盘」的意思。
 */
function sourceFrom({ dir, files, exclude = [] }) {
  if (files && files.length) {
    assertWithinLimits(files);
    return createMemorySource(files, { exclude });
  }
  if (!dir) {
    throw new Error(
      "缺少输入：服务器形态请传 files（文件内容数组），本地形态请传 dir（站点目录路径）。" +
        "不允许空参数 —— 空 files 也请在调用方拦住，不要让它落到「扫描运行进程的工作目录」这条路上。",
    );
  }
  return createFsSource(path.resolve(dir), { exclude });
}

/** 统一的返回：先给人看的报告，再给机器看的 JSON。 */
function reply(report, data) {
  return {
    content: [
      { type: "text", text: report },
      { type: "text", text: `\n--- JSON ---\n${JSON.stringify(data, null, 2)}` },
    ],
  };
}

function fail(message) {
  return { isError: true, content: [{ type: "text", text: `错误：${message}` }] };
}

/** 取价格 + gas 价（显式传入优先，其次实时，最后地板价）。 */
async function resolvePricing({ network, gasPriceGwei, priceUsd }) {
  const net = NETWORKS[network] || NETWORKS.bsc;
  let live = null;
  if (gasPriceGwei == null) {
    live = await fetchLiveGasPriceGwei(net.key).catch(() => null);
  }
  const gp = effectiveGasPriceGwei(net.key, gasPriceGwei ?? live);
  let usd = priceUsd ?? null;
  if (usd == null) usd = await fetchNativePriceUsd(net.key).catch(() => null);
  return { net, gp, usd, live };
}

/* ------------------------------ server 工厂 ------------------------------ */

/**
 * 造一个注册好全部工具的 MCP server。
 *
 * 为什么要做成工厂而不是模块级单例：Streamable HTTP 的无状态模式里，
 * **每个请求**都要一份新的 server + transport（一个 server 同时只能连一个 transport）。
 * 模块级单例在并发请求下会互相踩。
 */
export function createTapeShrinkServer() {
  const server = new McpServer({
    name: "deweb-shrink",
    version: "0.3.0",
  });

  /* ------------------------------ 计费模型 ------------------------------ */

  server.registerTool(
    "cost_model",
    {
      title: "上链计费模型",
      description:
        "说明 tapecode.ai / TapeOut 的计费方式：每 24,000 字节一块、一块一笔交易、" +
        "gas = 块数×270000 + 字节数×235，gasPrice = max(地板价, min(实时价, 20×地板价))。" +
        "用于回答「为什么文件越大越贵」以及给其他工具的估算提供依据。",
      inputSchema: {
        network: networkSchema,
        liveGasPrice: z.boolean().optional().describe("是否顺便读一次链上实时 gasPrice（默认 false）"),
      },
    },
    async ({ network, liveGasPrice }) => {
      const net = NETWORKS[network] || NETWORKS.bsc;
      const live = liveGasPrice ? await fetchLiveGasPriceGwei(net.key).catch(() => null) : null;
      const gp = effectiveGasPriceGwei(net.key, live);
      const usd = await fetchNativePriceUsd(net.key).catch(() => null);

      // 用「1 MB 的纯数据」举例，让数字具体
      const perMb = estimateGas([{ path: "x.bin", bytes: 1024 * 1024 }]);
      const costMb = costOf(perMb, { gasPriceGwei: gp, priceUsd: usd });

      const lines = [];
      lines.push(`# ${net.name}（${net.symbol}）上的计费`);
      lines.push("");
      lines.push(formatAssumptions({ networkName: net.name, symbol: net.symbol, gasPriceGwei: gp, priceUsd: usd }));
      if (live != null) lines.push(`链上实时 gasPrice：${live} gwei（协议会把它夹在 [地板价, 20×地板价] 之间）`);
      lines.push("");
      lines.push("## 为什么字节就是钱");
      lines.push(COST_MODEL_NOTES.map((n, i) => `${i + 1}. ${n}`).join("\n"));
      lines.push("");
      lines.push("## 常量（照抄协议前端，未做任何四舍五入）");
      lines.push(`· 每块字节数 CHUNK_BYTES = ${CHUNK_BYTES}`);
      lines.push(`· 单文件上限 = ${MAX_FILE_BYTES} 字节（${MAX_FILE_BYTES / 1024 / 1024} MiB）`);
      lines.push(`· 单块理论上限 = ${MAX_CHUNK_PAYLOAD} 字节（由 limitMax 反推，协议只用 ${CHUNK_BYTES}）`);
      lines.push(`· perChunk = ${GAS_MODEL.perChunk} gas`);
      lines.push(`· perByte  = ${GAS_MODEL.perByte} gas`);
      lines.push(`· 地板价 = ${net.gasFloorGwei} gwei · 上限 = 地板价 × ${GAS_MODEL.capMultiple}`);
      lines.push(`· registry = ${net.registry}`);
      lines.push(`· 自有域名走 CNAME：${CNAME_GATEWAY}`);
      lines.push("");
      lines.push("## 参考价：1 MB 纯数据");
      lines.push(
        `${perMb.chunks} 块 · ${perMb.gas.toLocaleString("en-US")} gas · ` +
          `${formatNative(costMb.native, net.symbol)}${costMb.usd != null ? ` ≈ ${formatUsd(costMb.usd)}` : ""}（gasPrice ${gp} gwei）`,
      );
      lines.push("");
      lines.push(
        "> 注意：同一路径 + 同一 sha256 的文件会被跳过，所以「只改一个文件」只花那一个文件的钱；" +
          "但那个文件是整份重传 —— 这也是为什么把一个 200KB 的图换成 50KB 的图，省的是**每一次**改版的钱。",
      );

      return reply(lines.join("\n"), {
        network: net.key,
        symbol: net.symbol,
        gasPriceGwei: gp,
        liveGasPriceGwei: live,
        priceUsd: usd,
        constants: { ...GAS_MODEL, CHUNK_BYTES, MAX_FILE_BYTES, MAX_CHUNK_PAYLOAD },
        notes: COST_MODEL_NOTES,
        perMegabyte: { chunks: perMb.chunks, gas: perMb.gas, native: costMb.native, usd: costMb.usd },
        serverLimits: SERVER_LIMITS,
      });
    },
  );

  /* -------------------------------- 扫描 -------------------------------- */

  server.registerTool(
    "scan",
    {
      title: "扫描站点并预估上链费用",
      description:
        "扫描一份站点，按 tapecode.ai 的真实规则算出：哪些文件会被上传、" +
        "多少字节、多少块（= 多少笔交易）、预计多少 gas / 多少 BNB / 多少美元。" +
        "同时列出协议会**静默跳过**的文件（隐藏文件、超 8 MiB、非法路径）、断链、" +
        "没人引用的死文件、以及 Content-Type 有问题的文件。只读，不写任何东西。",
      inputSchema: {
        dir: dirSchema,
        files: filesSchema,
        exclude: z.array(z.string()).optional().describe('排除的路径前缀或 glob，如 ["node_modules", "docs/**"]'),
        network: networkSchema,
        gasPriceGwei: z.number().optional().describe("指定 gasPrice（gwei）；不传则读链上实时价，读不到用协议地板价"),
        priceUsd: z.number().optional().describe(`指定原生代币美元价；不传则自动获取（${Object.values(NETWORKS).map((n) => n.symbol).join(" / ")}）`),
      },
    },
    async ({ dir, files, exclude, network, gasPriceGwei, priceUsd }) => {
      try {
        const source = sourceFrom({ dir, files, exclude: exclude || [] });
        const { net, gp, usd } = await resolvePricing({ network, gasPriceGwei, priceUsd });
        const scan = await scanSite(source, { exclude: exclude || [] });
        const report = formatScanReport(scan, { networkKey: net.key, gasPriceGwei: gp, priceUsd: usd });

        const gas = estimateGas(scan.billable);
        const cost = costOf(gas, { gasPriceGwei: gp, priceUsd: usd });

        return reply(report, {
          dir: scan.root,
          network: net.key,
          symbol: net.symbol,
          gasPriceGwei: gp,
          priceUsd: usd,
          totals: scan.totals,
          gas,
          cost,
          files: scan.billable.map((f) => ({
            path: f.path,
            bytes: f.bytes,
            chunks: f.chunks,
            contentType: f.contentType,
            likelyNotSiteFile: f.likelyNotSiteFile,
          })),
          skipped: scan.skipped.map((f) => ({ path: f.path, bytes: f.bytes, reason: f.skippedReason })),
          unreferenced: scan.references.unreferenced,
          unresolved: scan.references.unresolved,
          duplicates: scan.duplicates,
          ignoredDirs: scan.ignoredDirs,
          warnings: scan.warnings,
        });
      } catch (err) {
        return fail(err.message);
      }
    },
  );

  /* ------------------------------ 只算字节数 ------------------------------ */

  server.registerTool(
    "estimate",
    {
      title: "按字节数估费用",
      description:
        "给一个（或一组）字节数，按协议公式算出块数、gas、BNB、美元。" +
        "用于「再加一个 2 MB 的视频要多少钱」这类假设问题。",
      inputSchema: {
        bytes: z.number().optional().describe("总字节数"),
        files: z
          .array(z.object({ path: z.string().optional(), bytes: z.number() }))
          .optional()
          .describe("按文件给字节数（要按每文件向上取整算块数，比只给总数更准）"),
        network: networkSchema,
        gasPriceGwei: z.number().optional(),
        priceUsd: z.number().optional(),
      },
    },
    async ({ bytes, files, network, gasPriceGwei, priceUsd }) => {
      try {
        const { net, gp, usd } = await resolvePricing({ network, gasPriceGwei, priceUsd });
        const list = files && files.length
          ? files.map((f, i) => ({ path: f.path || `file-${i + 1}`, bytes: Math.max(0, Math.floor(f.bytes)) }))
          : [{ path: "payload", bytes: Math.max(0, Math.floor(bytes ?? 0)) }];
        const gas = estimateGas(list);
        const cost = costOf(gas, { gasPriceGwei: gp, priceUsd: usd });

        const lines = [];
        lines.push(formatAssumptions({ networkName: net.name, symbol: net.symbol, gasPriceGwei: gp, priceUsd: usd }));
        lines.push("");
        lines.push(`${formatBytes(gas.bytes)} / ${gas.files} 个文件 → ${gas.chunks} 块（${gas.chunks} 笔交易）`);
        lines.push(
          `gas ${gas.gas.toLocaleString("en-US")}（块开销 ${gas.chunkGas.toLocaleString("en-US")} + 字节开销 ${gas.byteGas.toLocaleString("en-US")}）`,
        );
        lines.push(`费用 ${formatNative(cost.native, net.symbol)}${cost.usd != null ? ` ≈ ${formatUsd(cost.usd)}` : ""}`);
        return reply(lines.join("\n"), {
          network: net.key,
          symbol: net.symbol,
          gasPriceGwei: gp,
          priceUsd: usd,
          gas,
          cost,
        });
      } catch (err) {
        return fail(err.message);
      }
    },
  );

  /* ------------------------------- 优化 ------------------------------- */

  const optionsShape = {
    minifyHtml: z.boolean().optional(),
    minifyCss: z.boolean().optional(),
    minifyJs: z.boolean().optional(),
    optimizePng: z.boolean().optional(),
    optimizeJpeg: z.boolean().optional(),
    psnrTarget: z.number().optional().describe("图片质量门限（dB，默认 42；越低越小越糊）"),
    aggressiveHtml: z.boolean().optional().describe("激进 HTML 压缩：去属性引号、折叠空白、压内联 CSS/JS（默认关）"),
    minifyInlineJs: z.boolean().optional(),
    minifyInlineCss: z.boolean().optional(),
    convertImages: z.boolean().optional().describe("把 PNG/JPEG 转成 WebP/AVIF 并重写引用（默认关，会改文件名）"),
    convertTo: z.enum(["webp", "avif"]).optional(),
    dropUnreferenced: z
      .boolean()
      .optional()
      .describe("不写入没有任何引用的文件（默认开）。robots.txt / favicon.ico 这类约定文件会被保护，不受影响"),
    dropNonSiteFiles: z
      .boolean()
      .optional()
      .describe("不写入 README / .map / lock / 设计稿这类非站点文件（默认开）"),
    drop: z.array(z.string()).optional().describe("显式排除某些文件"),
    keep: z.array(z.string()).optional().describe("显式保留某些文件"),
    verify: z.boolean().optional().describe("是否做压缩后校验（默认开，强烈建议别关）"),
  };

  server.registerTool(
    "optimize",
    {
      title: "优化站点并对比上链费用",
      description:
        "压出一份新站点，并给出优化前/后的字节数、块数、gas、BNB/美元对比。" +
        "默认只做安全优化：JS/CSS/HTML 压缩、PNG/JPEG 同格式重编码（带 PSNR 质量门限）、" +
        "**删掉白花钱的文件**（非站点资源 + 没有任何引用的文件），但 robots.txt / favicon.ico " +
        "这类靠约定路径访问的文件会被保护。转 WebP、激进 HTML 需要显式打开。" +
        "**源永远只读，绝不原地改**；每次都会跑校验，校验失败会明确报出来。" +
        "服务器形态（传 files）下，压缩后的文件以 base64 放在返回的 artifacts 里。",
      inputSchema: {
        dir: dirSchema,
        files: filesSchema,
        out: z.string().optional().describe("产物目录（默认 <dir>.tape，必须在源目录之外；只有本地形态用得上）"),
        exclude: z.array(z.string()).optional(),
        network: networkSchema,
        gasPriceGwei: z.number().optional(),
        priceUsd: z.number().optional(),
        options: z.object(optionsShape).optional(),
      },
    },
    async ({ dir, files, out, exclude, network, gasPriceGwei, priceUsd, options }) => {
      try {
        const memoryMode = !!(files && files.length);
        const source = sourceFrom({ dir, files, exclude: exclude || [] });
        const { net, gp, usd } = await resolvePricing({ network, gasPriceGwei, priceUsd });

        const result = await optimizeSite({
          source,
          // 服务器形态没有可写的目录，产物收在内存里随结果带回
          sink: memoryMode ? createMemorySink() : undefined,
          out: memoryMode ? undefined : out ? path.resolve(out) : undefined,
          exclude: exclude || [],
          network: net.key,
          gasPriceGwei: gp,
          priceUsd: usd,
          options: options || {},
        });

        const report = formatOptimizeReport(result);
        return reply(report, {
          dir: result.dir,
          out: result.out,
          network: result.network,
          symbol: result.symbol,
          gasPriceGwei: result.gasPriceGwei,
          priceUsd: result.priceUsd,
          before: { totals: result.before.totals, gas: result.before.gas, cost: result.before.cost },
          after: { totals: result.after.totals, gas: result.after.gas, cost: result.after.cost },
          saved: result.saved,
          files: result.files,
          renames: result.files.renames,
          verification: result.verification,
          opportunities: result.opportunities,
          warnings: result.warnings,
          /* 压缩后的站点：服务器形态下这是 agent 唯一能拿到产物的途径 */
          artifacts: result.artifacts,
        });
      } catch (err) {
        return fail(err.message);
      }
    },
  );

  /* ------------------------------- 校验 ------------------------------- */

  server.registerTool(
    "verify",
    {
      title: "校验站点能否安全上链",
      description:
        "检查一份站点能不能安全上链：入口 index.html 在不在、协议会不会静默跳过某些文件、" +
        "引用有没有断链、JS 还能不能解析、HTML 结构有没有被压坏、跨文件全局有没有被改名、" +
        "Content-Type（含 manifest 的 octet-stream 问题）、图片尺寸有没有变、有没有超过 8 MiB。" +
        "给了 reference / referenceFiles 就做「与原文对拍」，不给就只做自洽检查。",
      inputSchema: {
        dir: dirSchema,
        files: filesSchema,
        reference: z.string().optional().describe("原始站点目录（本地形态；给了就对比压缩前后）"),
        referenceFiles: filesSchema.describe("原始站点的文件内容（服务器形态的对拍基准）"),
        network: networkSchema,
      },
    },
    async ({ dir, files, reference, referenceFiles, network }) => {
      try {
        const outSource = sourceFrom({ dir, files });
        const hasRef = !!(reference || (referenceFiles && referenceFiles.length));
        const refSource = hasRef ? sourceFrom({ dir: reference, files: referenceFiles }) : outSource;

        const result = await verifyOutput({
          originalSource: refSource,
          outputSource: outSource,
        });

        const lines = [];
        lines.push(`校验对象：${outSource.label}${hasRef ? `\n对拍基准：${refSource.label}` : "（无基准，只做自洽检查）"}`);
        lines.push(`结论：${result.ok ? "可以上链" : "有问题，先别传"}（fail ${result.failed} / warn ${result.warned}）`);
        lines.push("");
        for (const c of result.checks) {
          const tag = c.status === "pass" ? "✓" : c.status === "warn" ? "!" : "✗";
          lines.push(`${tag} ${c.name}：${c.detail}`);
        }
        return reply(lines.join("\n"), {
          dir: outSource.label,
          reference: hasRef ? refSource.label : null,
          ...result,
        });
      } catch (err) {
        return fail(err.message);
      }
    },
  );

  /* ---------------------------- 增量部署账单 ----------------------------
     长期迭代真正该看的数字。协议按「路径 + sha256」跳过没变的文件，所以
     日常改几个文件的成本往往只有全量的几个百分点 —— scan 看不到这一点。 */

  server.registerTool(
    "diff",
    {
      title: "增量部署账单（这一版要多花多少）",
      description:
        "对比「链上当前那一版」和「你要部署的这一版」，算出实际上传要花多少钱。" +
        "协议规则是：同一路径 + 同一 sha256 的文件**跳过**，变了的文件**整份重传** —— " +
        "所以日常只改几个文件的成本，往往只有全量重传的百分之几。" +
        "长期迭代想控制成本，看这个数字，而不是整站体积。" +
        "不给 previous / previousFiles 就当作首次部署（结果等于 scan）。",
      inputSchema: {
        next: z.string().optional().describe("要部署的新版本目录（本地形态）"),
        nextFiles: filesSchema.describe("要部署的新版本文件内容（服务器形态）"),
        previous: z.string().optional().describe("链上当前那一版的目录（本地形态）；不给就是首次部署"),
        previousFiles: filesSchema.describe("链上当前那一版的文件内容（服务器形态）"),
        exclude: z.array(z.string()).optional(),
        network: networkSchema,
        gasPriceGwei: z.number().optional(),
        priceUsd: z.number().optional(),
      },
    },
    async ({ next, nextFiles, previous, previousFiles, exclude, network, gasPriceGwei, priceUsd }) => {
      try {
        const nextSource = sourceFrom({ dir: next, files: nextFiles, exclude: exclude || [] });
        const hasPrev = !!(previous || (previousFiles && previousFiles.length));
        const prevSource = hasPrev
          ? sourceFrom({ dir: previous, files: previousFiles, exclude: exclude || [] })
          : null;
        const { net, gp, usd } = await resolvePricing({ network, gasPriceGwei, priceUsd });

        const d = await diffSites({
          previous: prevSource,
          next: nextSource,
          network: net.key,
          exclude: exclude || [],
          gasPriceGwei: gp,
          priceUsd: usd,
        });

        return reply(formatDiffReport(d), {
          previous: d.previousLabel,
          next: d.nextLabel,
          firstDeploy: d.firstDeploy,
          network: d.network,
          symbol: d.symbol,
          gasPriceGwei: d.gasPriceGwei,
          priceUsd: d.priceUsd,
          counts: {
            added: d.added.length,
            changed: d.changed.length,
            unchanged: d.unchanged.length,
            removed: d.removed.length,
          },
          added: d.added.map((f) => ({ path: f.path, bytes: f.bytes, chunks: f.chunks })),
          changed: d.changed.map((f) => ({
            path: f.path,
            bytes: f.bytes,
            oldBytes: f.oldBytes,
            chunks: f.chunks,
          })),
          removed: d.removed.map((f) => ({ path: f.path, bytes: f.bytes, chunks: f.chunks })),
          upload: {
            files: d.upload.files,
            bytes: d.upload.bytes,
            chunks: d.upload.chunks,
            gas: d.upload.gas,
            cost: d.upload.cost,
          },
          removal: d.removal,
          total: d.total,
          full: {
            files: d.full.files,
            bytes: d.full.bytes,
            chunks: d.full.chunks,
            gas: d.full.gas,
            cost: d.full.cost,
          },
          savedVsFull: d.savedVsFull,
        });
      } catch (err) {
        return fail(err.message);
      }
    },
  );

  return server;
}

/* ------------------------------- 启动 ------------------------------- */

/**
 * 只有被直接运行时才起 stdio；被 http.js `import` 时不能顺手把 stdio 也挂上，
 * 否则同一个进程会同时占住 stdin/stdout，把 HTTP 模式的日志也搅乱。
 */
const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const server = createTapeShrinkServer();
  /* maxBufferSize 必须显式放大：SDK 的 ReadBuffer 默认上限是 10 MB，
     而我们的单次内容上限是 8 MB —— 图片转 base64 后膨胀约 1/3 就会顶到 10 MB。
     一旦超了，ReadBuffer 会抛错并关掉 transport、进程直接退出，
     调用方只看到「没有响应」，完全猜不到是体积问题（实测踩过）。 */
  const transport = new StdioServerTransport(process.stdin, process.stdout, {
    maxBufferSize: 16 * 1024 * 1024,
  });
  await server.connect(transport);
}
