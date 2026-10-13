#!/usr/bin/env node
/* ==========================================================================
   deweb-shrink 命令行 —— MCP 之外也能直接用（调试、CI、手动发布前跑一遍）
   ========================================================================== */

"use strict";

import path from "node:path";

import { formatOptimizeReport, formatScanReport, collectOpportunities } from "./report.js";
import { scanSite } from "./scan.js";
import { optimizeSite } from "./optimize/index.js";
import { verifyOutput } from "./verify.js";
import { diffSites, formatDiffReport } from "./diff.js";
import { costOf, estimateGas, effectiveGasPriceGwei } from "./cost.js";
import { COST_MODEL_NOTES, GAS_MODEL, CHUNK_BYTES, MAX_FILE_BYTES, NETWORKS } from "./protocol.js";

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  const list = new Set(["exclude", "drop", "keep"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (list.has(key)) {
        flags[key] = [...(flags[key] || []), ...String(argv[++i] || "").split(",").filter(Boolean)];
      } else if (key.startsWith("no-")) {
        flags[key.slice(3)] = false;
      } else if (argv[i + 1] && !argv[i + 1].startsWith("--")) {
        flags[key] = argv[++i];
      } else {
        flags[key] = true;
      }
    } else positional.push(a);
  }
  return { positional, flags };
}

function num(v, fallback = null) {
  if (v == null || v === true || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

const USAGE = `deweb-shrink —— 上传到 tapecode.ai 之前，把站点压小，省下上链的 gas

用法：
  deweb-shrink scan     [目录] [选项]     只扫描 + 算钱（只读）
  deweb-shrink optimize [目录] [选项]     压出一份新目录，并对比前后费用
  deweb-shrink diff     <新目录> --previous <旧目录>
                                         只算「这一版要多花多少」—— 增量部署账单
  deweb-shrink verify   <目录> [--reference 原目录]
  deweb-shrink model                      打印协议计费模型

通用选项：
  --network bsc|xlayer|base   链（默认 bsc）
  --gas <gwei>                指定 gasPrice；不传则读链上实时价，读不到用协议地板价
  --usd <价格>                指定原生代币美元价
  --exclude a,b,c             排除路径（前缀或 glob），可重复
  --json                      输出 JSON

diff 选项：
  --previous <目录>           链上当前那一版（不给就是首次部署）
  --exclude a,b,c             排除路径

optimize 选项（安全优化默认已开，含「删掉白花钱的文件」）：
  --out <目录>                产物目录（默认 <目录>.tape）
  --aggressive                激进 HTML 压缩（去属性引号、折叠空白、压内联 CSS/JS）
  --webp                      把 PNG/JPEG 转成 WebP 并重写引用（--avif 同理）
  --psnr <dB>                 图片质量门限，默认 42
  --keep-all                  反向开关：一个文件都不删（完全保守）
  --no-drop-unreferenced      不删「没有任何引用」的文件
  --no-drop-non-site          不删 README/.map/lock 这类非站点文件
  --drop a,b                  显式排除某些文件
  --keep a,b                  显式保留某些文件（优先级最高）
  --no-verify                 关闭压缩后校验（不建议）

  说明：删文件默认是**开**的 —— README、.map、没人引用的图传上去是纯花钱。
  但靠约定路径访问的文件（robots.txt / favicon.ico / .well-known/…）会被保护：
  它们本来就没有 HTML 引用，删了会静默失效。
`;

async function cmdScan(flags, positional) {
  const dir = path.resolve(positional[0] || process.cwd());
  const net = NETWORKS[flags.network] || NETWORKS.bsc;
  const gp = effectiveGasPriceGwei(net.key, num(flags.gas));
  const scan = await scanSite(dir, { exclude: flags.exclude || [] });
  const report = formatScanReport(scan, { networkKey: net.key, gasPriceGwei: gp, priceUsd: num(flags.usd) });
  if (flags.json) {
    const gas = estimateGas(scan.billable);
    console.log(JSON.stringify({ dir, network: net.key, gas, cost: costOf(gas, { gasPriceGwei: gp, priceUsd: num(flags.usd) }), totals: scan.totals, files: scan.billable, skipped: scan.skipped, warnings: scan.warnings, unreferenced: scan.references.unreferenced, unresolved: scan.references.unresolved }, null, 2));
  } else {
    console.log(report);
  }
}

async function cmdOptimize(flags, positional) {
  const dir = path.resolve(positional[0] || process.cwd());
  const net = NETWORKS[flags.network] || NETWORKS.bsc;
  const options = {
    aggressiveHtml: !!flags.aggressive,
    minifyInlineJs: !!flags.aggressive,
    minifyInlineCss: !!flags.aggressive,
    convertImages: !!(flags.webp || flags.avif),
    convertTo: flags.avif ? "avif" : "webp",
    /* 删文件现在是**默认开**的（见 optimize/files.js），所以这里只在显式传了
       flag 时才覆盖默认值。之前写的是 `!!flags[...]`，等于永远传一个 false 进来，
       会把默认值顶掉 —— 那种「CLI 和库行为不一致」的 bug 最难查。 */
    ...(flags["drop-unreferenced"] !== undefined ? { dropUnreferenced: flags["drop-unreferenced"] } : {}),
    ...(flags["drop-non-site"] !== undefined ? { dropNonSiteFiles: flags["drop-non-site"] } : {}),
    ...(flags["keep-all"] ? { dropUnreferenced: false, dropNonSiteFiles: false } : {}),
    drop: flags.drop || [],
    keep: flags.keep || [],
    verify: flags.verify !== false,
  };
  const psnr = num(flags.psnr);
  if (psnr != null) options.psnrTarget = psnr;

  const result = await optimizeSite({
    dir,
    out: flags.out ? path.resolve(flags.out) : undefined,
    exclude: flags.exclude || [],
    network: net.key,
    gasPriceGwei: num(flags.gas),
    priceUsd: num(flags.usd),
    options,
  });
  result.opportunities = await collectOpportunities(result).catch(() => result.opportunities || []);

  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatOptimizeReport(result));
  }
  // 校验失败 = 非零退出码，方便挂到发布脚本前面
  if (result.verification && !result.verification.ok) process.exitCode = 2;
}

async function cmdVerify(flags, positional) {
  const dir = path.resolve(positional[0] || ".");
  const reference = flags.reference ? path.resolve(flags.reference) : null;
  /* 没给 --reference 就**不要**传 originalDir —— 以前这里传的是 `reference || dir`，
     等于「自己跟自己比」，会被当成有基准，把本来就存在的断链全算成「新增」而误报失败。
     现在语义分明：给了 reference 才是对拍，否则就是自洽检查。 */
  const result = await verifyOutput(
    reference ? { originalDir: reference, outputDir: dir } : { outputDir: dir },
  );
  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`校验对象：${dir}${reference ? `\n对拍基准：${reference}` : "（无基准，只做自洽检查）"}`);
    console.log(`结论：${result.ok ? "可以上链" : "有问题，先别传"}（fail ${result.failed} / warn ${result.warned}）\n`);
    for (const c of result.checks) {
      const tag = c.status === "pass" ? "✓" : c.status === "warn" ? "!" : "✗";
      console.log(`${tag} ${c.name}：${c.detail}`);
    }
  }
  if (!result.ok) process.exitCode = 2;
}

async function cmdModel(flags) {
  const net = NETWORKS[flags.network] || NETWORKS.bsc;
  const gp = effectiveGasPriceGwei(net.key, num(flags.gas));
  const perMb = estimateGas([{ path: "x.bin", bytes: 1024 * 1024 }]);
  const cost = costOf(perMb, { gasPriceGwei: gp, priceUsd: num(flags.usd) });
  const usd = cost.usd == null ? "" : ` ≈ $${cost.usd.toFixed(2)}`;
  console.log(`${net.name}（${net.symbol}）· gasPrice ${gp} gwei`);
  console.log(`每 ${CHUNK_BYTES} 字节 = 1 块 = 1 笔交易；单文件上限 ${MAX_FILE_BYTES / 1024 / 1024} MiB`);
  console.log(`gas = 块数 × ${GAS_MODEL.perChunk} + 字节数 × ${GAS_MODEL.perByte}`);
  console.log(`1 MB 纯数据 → ${perMb.chunks} 块 → ${perMb.gas.toLocaleString("en-US")} gas → ${cost.native.toFixed(6)} ${net.symbol}${usd}`);
  console.log("");
  COST_MODEL_NOTES.forEach((n, i) => console.log(`${i + 1}. ${n}`));
}

/**
 * 增量部署账单：只算「从上一版到这一版要多花多少」。
 *
 * 这是长期迭代真正该看的数字 —— 协议按「路径 + sha256」跳过没变的文件，
 * 所以日常改几个文件的成本，往往只有全量的百分之几。
 */
async function cmdDiff(flags, positional) {
  const next = path.resolve(positional[0] || process.cwd());
  // --previous 后面没跟值时是 true，别拿它去 path.resolve
  const previous = typeof flags.previous === "string" ? path.resolve(flags.previous) : null;
  const net = NETWORKS[flags.network] || NETWORKS.bsc;
  const gp = effectiveGasPriceGwei(net.key, num(flags.gas));
  const usd = num(flags.usd);

  const d = await diffSites({
    previous,
    next,
    network: net.key,
    exclude: flags.exclude || [],
    gasPriceGwei: gp,
    priceUsd: usd,
  });

  if (flags.json) {
    console.log(
      JSON.stringify(
        {
          previous: d.previousLabel,
          next: d.nextLabel,
          firstDeploy: d.firstDeploy,
          network: d.network,
          symbol: d.symbol,
          gasPriceGwei: d.gasPriceGwei,
          priceUsd: d.priceUsd,
          added: d.added.map((f) => ({ path: f.path, bytes: f.bytes, chunks: f.chunks })),
          changed: d.changed.map((f) => ({ path: f.path, bytes: f.bytes, oldBytes: f.oldBytes, chunks: f.chunks })),
          unchanged: d.unchanged.map((f) => ({ path: f.path, bytes: f.bytes })),
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
        },
        null,
        2,
      ),
    );
  } else {
    console.log(formatDiffReport(d));
  }
}

const { positional, flags } = parseArgs(process.argv.slice(2));
const cmd = positional.shift() || "scan";

try {
  if (cmd === "scan") await cmdScan(flags, positional);
  else if (cmd === "optimize") await cmdOptimize(flags, positional);
  else if (cmd === "diff") await cmdDiff(flags, positional);
  else if (cmd === "verify") await cmdVerify(flags, positional);
  else if (cmd === "model") await cmdModel(flags);
  else {
    console.log(USAGE);
    process.exitCode = cmd === "help" || cmd === "--help" ? 0 : 1;
  }
} catch (err) {
  console.error(`错误：${err.message}`);
  if (process.env.DEWEB_SHRINK_DEBUG) console.error(err.stack);
  process.exitCode = 1;
}
