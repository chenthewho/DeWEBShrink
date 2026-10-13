/* ==========================================================================
   报告 —— 把结果排成人能看的样子
   --------------------------------------------------------------------------
   两条原则：
     · 先给结论（省了多少字节、多少钱），再给明细；
     · 「还能再省多少」单独列一节，并且把每一项对应的钱算出来 —— 有些开关是
       有代价的（删文件、转格式），值不值得由用户决定，不由工具替他决定。
   ========================================================================== */

"use strict";

import { costOf, estimateGas, formatBytes, formatNative, formatUsd, effectiveGasPriceGwei } from "./cost.js";
import { CHUNK_BYTES, GAS_MODEL, MAX_FILE_BYTES, NETWORKS } from "./protocol.js";

/** 钱的那一行：gas、原生代币、美元。 */
export function moneyLine(cost, symbol) {
  const usd = cost.usd == null ? "" : ` ≈ ${formatUsd(cost.usd)}`;
  return `${formatNative(cost.native, symbol)}${usd}`;
}

function pct(a, b) {
  if (!b) return "0.0%";
  return `${(((b - a) / b) * 100).toFixed(1)}%`;
}

/** 价格/网络等前提条件写在最前面，避免数字被误读。 */
export function formatAssumptions({ networkName, symbol, gasPriceGwei, priceUsd, priceSource }) {
  const cost = gasPriceGwei;
  return [
    `网络：${networkName}（${symbol}） · gasPrice：${cost} gwei（协议地板价）`,
    priceUsd == null
      ? `美元换算：取不到 ${symbol} 价格（可显式传 priceUsd）`
      : `${symbol} 价格：${formatUsd(priceUsd)}${priceSource ? `（来源 ${priceSource}）` : ""}`,
    `计费模型：gas = 块数 × ${GAS_MODEL.perChunk.toLocaleString("en-US")} + 字节数 × ${GAS_MODEL.perByte}，每 ${CHUNK_BYTES.toLocaleString("en-US")} 字节一块`,
  ].join("\n");
}

/** 扫描报告。 */
export function formatScanReport(scan, { networkKey = "bsc", gasPriceGwei = null, priceUsd = null } = {}) {
  const net = NETWORKS[networkKey] || NETWORKS.bsc;
  const gp = effectiveGasPriceGwei(net.key, gasPriceGwei);
  const gas = estimateGas(scan.billable);
  const cost = costOf(gas, { gasPriceGwei: gp, priceUsd });

  const rows = [...scan.billable].sort((a, b) => b.bytes - a.bytes);
  const lines = [];
  lines.push(`站点：${scan.root}`);
  lines.push(formatAssumptions({ networkName: net.name, symbol: net.symbol, gasPriceGwei: gp, priceUsd }));
  lines.push("");
  lines.push(
    `会被上传：${gas.files} 个文件 / ${formatBytes(gas.bytes)} / ${gas.chunks} 块`,
  );
  lines.push(`预计上链成本：${moneyLine(cost, net.symbol)}`);
  lines.push(
    `gas 明细：块开销 ${gas.chunkGas.toLocaleString("en-US")} + 字节开销 ${gas.byteGas.toLocaleString("en-US")} = ${gas.gas.toLocaleString("en-US")}`,
  );
  lines.push("");
  lines.push("按体积排序（前 25）：");
  lines.push("      字节    块  Content-Type                     路径");
  for (const f of rows.slice(0, 25)) {
    lines.push(
      `${String(f.bytes).padStart(9)}  ${String(f.chunks).padStart(3)}  ${f.contentType.padEnd(30)} ${f.path}`,
    );
  }
  if (rows.length > 25) lines.push(`… 另有 ${rows.length - 25} 个文件`);
  if (scan.skipped.length) {
    lines.push("");
    lines.push(`协议不会上传（${scan.skipped.length} 个 / ${formatBytes(scan.skipped.reduce((a, f) => a + f.bytes, 0))}）：`);
    for (const f of scan.skipped) lines.push(`  ${f.path} —— ${f.skippedReason}：${f.skippedDetail}`);
  }
  if (scan.warnings.length) {
    lines.push("");
    lines.push("需要注意：");
    for (const w of scan.warnings) lines.push(`  · ${w}`);
  }
  return lines.join("\n");
}

/** 优化报告。 */
export function formatOptimizeReport(result) {
  const { symbol, networkName } = result;
  const lines = [];

  lines.push("═".repeat(72));
  lines.push(`deweb-shrink · ${networkName}（${symbol}）`);
  lines.push("═".repeat(72));
  lines.push(formatAssumptions({
    networkName,
    symbol,
    gasPriceGwei: result.gasPriceGwei,
    priceUsd: result.priceUsd,
  }));
  lines.push("");

  const b = result.before, a = result.after;
  lines.push("                 文件数      字节数        块数            gas           费用");
  const row = (label, t, g, cost) =>
    lines.push(
      `${label.padEnd(10)} ${String(t.billableFiles).padStart(8)} ${String(t.bytes.toLocaleString("en-US")).padStart(12)} ` +
        `${String(t.chunks).padStart(10)} ${String(g.gas.toLocaleString("en-US")).padStart(14)}  ${moneyLine(cost, symbol).padStart(14)}`,
    );
  row("优化前", b.totals, b.gas, b.cost);
  row("优化后", a.totals, a.gas, a.cost);
  lines.push("");
  lines.push(
    `省下：${formatBytes(result.saved.bytes)}（${result.saved.bytesPct.toFixed(1)}%）· ` +
      `${result.saved.chunks} 块 · ${result.saved.gas.toLocaleString("en-US")} gas · ` +
      `${formatNative(result.saved.native, symbol)}${result.saved.usd != null ? ` ≈ ${formatUsd(result.saved.usd)}` : ""}`,
  );
  lines.push(
    result.out
      ? `产物目录：${result.out}（源目录未改动）`
      : `产物：随结果以 base64 返回（${result.artifacts?.length ?? 0} 个文件；源文件未改动）`,
  );
  lines.push(`耗时：${(result.elapsedMs / 1000).toFixed(1)}s`);

  /* 明细：只列有变化的，外加最大的几个 */
  const changed = result.files.results.filter((f) => f.from !== f.to).sort((x, y) => y.from - x.from);
  lines.push("");
  lines.push("改了什么（按体积）：");
  if (!changed.length) lines.push("  （没有文件被改动）");
  for (const f of changed) {
    lines.push(
      `  ${String(f.from).padStart(8)} → ${String(f.to).padStart(8)}  ${(((f.from - f.to) / f.from) * 100).toFixed(0).padStart(3)}%  ` +
        `${f.path}${f.note ? `  · ${f.note}` : ""}`,
    );
  }

  if (result.files.dropped.length) {
    lines.push("");
    const savedBytes = result.files.dropped.reduce((a, d) => a + d.bytes, 0);
    lines.push(`没有写进产物（共 ${formatBytes(savedBytes)}，这部分不上链也就不花钱）：`);
    for (const d of result.files.dropped) lines.push(`  ${formatBytes(d.bytes).padStart(9)}  ${d.path} —— ${d.reason}`);
  }
  /* 无引用但被保护下来的约定文件：要说出来，否则用户会以为工具漏删了，
     或者自己手动把它们删掉 —— 而它们是靠约定路径访问的，删了就静默失效。 */
  if (result.files.protectedByConvention?.length) {
    lines.push("");
    lines.push("保留的约定文件（没有 HTML 引用是正常的，靠约定路径被访问）：");
    for (const p of result.files.protectedByConvention) lines.push(`  ${p}`);
  }
  if (result.files.renames.length) {
    lines.push("");
    lines.push("改了文件名（引用已同步重写）：");
    for (const r of result.files.renames) lines.push(`  ${r.from} → ${r.to}`);
  }

  /* 校验 */
  if (result.verification) {
    lines.push("");
    lines.push(`校验：${result.verification.ok ? "全部通过" : "有失败项"}（fail ${result.verification.failed} / warn ${result.verification.warned}）`);
    for (const c of result.verification.checks) {
      const tag = c.status === "pass" ? "✓" : c.status === "warn" ? "!" : "✗";
      lines.push(`  ${tag} ${c.name}：${c.detail}`);
    }
  }

  /* 还能再省多少 */
  const ops = result.opportunities;
  if (ops && ops.length) {
    lines.push("");
    lines.push("还能再省（都是可选项，默认不做）：");
    for (const o of ops) {
      if (o.bytes <= 0) continue;
      const approx = o.estimated ? "约 " : "";
      const usd = result.gasPriceGwei != null && result.priceUsd != null
        ? `　约 ${formatUsd((o.bytes * GAS_MODEL.perByte * result.gasPriceGwei * 1e-9) * result.priceUsd)}`
        : "";
      lines.push(`  ${approx}${formatBytes(o.bytes).padStart(9)}  ${o.label}${usd}`);
      if (o.how) lines.push(`              ${o.how}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * 收集「还能再省」的候选。激进项要真跑一遍才敢报数，所以这里只跑纯文本的
 * HTML 激进压缩（快、无副作用），图片和删文件按实测体积给下界。
 */
export async function collectOpportunities(result) {
  const ops = [];
  const { minifyHtml } = await import("./optimize/text.js");
  const fs = await import("node:fs/promises");
  const path = await import("node:path");

  // 1) 激进 HTML
  // 产物可能在内存里（MCP 服务器形态，没有 out 目录），所以先看 artifacts，再退回磁盘。
  const artifactByPath = new Map(
    (result.artifacts || []).map((a) => [a.path, Buffer.from(a.base64, "base64")]),
  );
  const readArtifact = async (p) => {
    const hit = artifactByPath.get(p);
    if (hit) return hit;
    if (!result.out) return null;
    return fs.readFile(path.join(result.out, p));
  };

  let aggressiveGain = 0;
  for (const f of result.after.files) {
    if (f.ext !== "html" && f.ext !== "htm") continue;
    try {
      const cur = await readArtifact(f.path);
      if (!cur) continue;
      const curBytes = cur.length;
      const r = await minifyHtml(cur.toString("utf8"), {
        aggressive: true,
        minifyInlineJs: true,
        minifyInlineCss: true,
      });
      const outBytes = Buffer.byteLength(r.code, "utf8");
      if (outBytes < curBytes) aggressiveGain += curBytes - outBytes;
    } catch {
      /* 忽略 */
    }
  }
  if (aggressiveGain > 0) {
    ops.push({
      label: "HTML 激进压缩（去引号 + 折叠空白 + 压内联 CSS/JS）",
      bytes: aggressiveGain,
      how: "optimize 时传 options.aggressiveHtml = true（会重排 HTML，务必再用 verify 过一遍）",
    });
  }

  // 2) 删掉没人引用的文件
  const dead = result.after.files.filter((f) => result.after.unreferenced.includes(f.path));
  if (dead.length) {
    ops.push({
      label: `不传 ${dead.length} 个没有任何引用的文件`,
      bytes: dead.reduce((a, f) => a + f.bytes, 0),
      how: `options.dropUnreferenced = true（${dead.map((f) => f.path).join("、")}）`,
    });
  }

  // 3) 文档类文件
  const docs = result.after.files.filter((f) => /\.(?:md|map|lock|log)$/i.test(f.path));
  if (docs.length) {
    ops.push({
      label: `不传 ${docs.length} 个文档 / 映射文件`,
      bytes: docs.reduce((a, f) => a + f.bytes, 0),
      how: `options.dropNonSiteFiles = true（${docs.map((f) => f.path).join("、")}）`,
    });
  }

  // 4) 字体子集化：只报潜力，不假装能做
  const fonts = result.after.files.filter((f) => /\.(?:woff2?|ttf|otf)$/i.test(f.path));
  if (fonts.length) {
    const total = fonts.reduce((a, f) => a + f.bytes, 0);
    const byExt = new Map();
    for (const f of result.after.files) byExt.set(f.ext, (byExt.get(f.ext) || 0) + f.bytes);
    const biggest = [...byExt.entries()].sort((x, y) => y[1] - x[1])[0];
    ops.push({
      label: `字体子集化（当前 ${fonts.length} 个字体重 ${formatBytes(total)}${
        biggest ? `；当前最大一类是 .${biggest[0]} 共 ${formatBytes(biggest[1])}` : ""
      }）`,
      bytes: Math.round(total * 0.5),
      estimated: true,
      how:
        "本工具暂不做字体子集化：需要在 harfbuzz（subset-font）里重新裁字形，并且要证明" +
        "「页面用到的每个码位在新字体里都还在」，否则会渲染成豆腐块。要做得先补一条码位覆盖校验。",
    });
  }

  // 5) 图片质量档
  const images = result.after.files.filter((f) => /\.(?:png|jpe?g|webp|avif)$/i.test(f.path));
  if (images.length) {
    ops.push({
      label: "图片质量门限下调（psnrTarget 42 → 36）",
      bytes: Math.round(images.reduce((a, f) => a + f.bytes, 0) * 0.25),
      estimated: true,
      how: "optimize 时传 options.psnrTarget = 36，或用 options.convertImages = true 转 WebP（会改文件名并重写引用）",
    });
  }

  ops.sort((x, y) => y.bytes - x.bytes);
  return ops;
}

export { formatBytes, formatUsd, formatNative, MAX_FILE_BYTES };
