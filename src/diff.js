/* ==========================================================================
   增量对比 —— 「这一版要多花多少钱」，而不是「整站多少钱」
   --------------------------------------------------------------------------
   协议的上链规则是：**同一路径 + 同一 sha256 的文件跳过，变了的整份重传**。
   这条规则决定了一件反直觉的事：

     长期迭代的成本，不取决于站点多大，而取决于「每次改动的那几个文件多大」。

   一个 800 KB 的站点，如果每次只改一个 20 KB 的 JS，那每次部署只付那 20 KB
   （加上它那几块的固定开销）。大静态资源（图片、字体）改一次之后就**永久免费**了 ——
   它们是「一次性成本」，而代码是「每次成本」。

   所以 scan 和 diff 回答的是两个不同的问题：
     scan → 现在把整个站点传上去要多少钱（首次部署 / 全量重建）
     diff → 从上一版到这一版，要多花多少钱（日常迭代）

   两条容易踩的坑，工具会在报告里明说：
     · 变了就是**整份重传**，不是「传 diff」—— 改一个字节也要付整个文件；
     · 块数按文件各向上取整，所以改动一个 3 KB 小文件也要付满一块（27 万 gas）。
   ========================================================================== */

"use strict";

import { scanSite } from "./scan.js";
import { asSource } from "./source.js";
import { costOf, effectiveGasPriceGwei, estimateGas, removalGas } from "./cost.js";
import { NETWORKS } from "./protocol.js";
import { formatBytes, formatNative, formatUsd } from "./cost.js";

/**
 * 对比两版站点，算出「实际上传这一版要花多少钱」。
 *
 * @param {object} args
 * @param {string|object|null} args.previous 链上当前那一版（目录或文件源）；null = 空站点（首次部署）
 * @param {string|object} args.next 要部署的新版本
 * @param {string} [args.network] bsc（默认）/ xlayer / base
 * @param {string[]} [args.exclude]
 * @param {number|null} [args.gasPriceGwei]
 * @param {number|null} [args.priceUsd]
 */
export async function diffSites({
  previous = null,
  next,
  network = "bsc",
  exclude = [],
  gasPriceGwei = null,
  priceUsd = null,
}) {
  const net = NETWORKS[network] || NETWORKS.bsc;
  const gp = effectiveGasPriceGwei(net.key, gasPriceGwei);
  const pricing = { gasPriceGwei: gp, priceUsd };

  const nextSource = asSource(next, { exclude });
  const nextScan = await scanSite(nextSource, { exclude });

  const prevScan = previous ? await scanSite(asSource(previous, { exclude }), { exclude }) : null;
  const prevByPath = new Map((prevScan?.billable || []).map((f) => [f.path, f]));
  const nextByPath = new Map(nextScan.billable.map((f) => [f.path, f]));

  const added = [];
  const changed = [];
  const unchanged = [];

  for (const f of nextScan.billable) {
    const old = prevByPath.get(f.path);
    if (!old) {
      added.push(f);
    } else if (old.sha256 !== f.sha256) {
      // 整份重传：按**新**文件的完整字节计费，不是两者的差
      changed.push({ ...f, oldBytes: old.bytes, oldChunks: old.chunks });
    } else {
      unchanged.push(f);
    }
  }

  const removed = [...prevByPath.values()].filter((f) => !nextByPath.has(f.path));

  /* 实际上传 = 新增 + 改动（都要整份重传） */
  const uploadFiles = [...added, ...changed];
  const upload = estimateGas(uploadFiles);

  /* 对照：假设全部重传 */
  const full = estimateGas(nextScan.billable);

  /* 删除也要花钱（removeFile）：底座 + 老块数 + 路径槽位 */
  const removal = {
    files: removed.length,
    gas: removed.reduce((a, f) => a + removalGas(f.chunks, f.path.length, 0), 0),
  };

  const totalGas = upload.gas + removal.gas;
  const cost = costOf({ gas: totalGas }, pricing);
  const fullCost = costOf(full, pricing);
  const uploadCost = costOf(upload, pricing);
  const removalCost = costOf({ gas: removal.gas }, pricing);

  return {
    network: net.key,
    symbol: net.symbol,
    gasPriceGwei: gp,
    priceUsd,
    previousLabel: prevScan ? prevScan.root : "（空：首次部署）",
    nextLabel: nextScan.root,
    firstDeploy: !prevScan,

    added,
    changed,
    unchanged,
    removed,

    upload: { ...upload, cost: uploadCost },
    removal: { ...removal, cost: removalCost },
    total: { gas: totalGas, bytes: upload.bytes, chunks: upload.chunks, files: uploadFiles.length, cost },
    full: { ...full, cost: fullCost },

    /** 相比「全量重传」省了多少 */
    savedVsFull: {
      gas: full.gas - totalGas,
      bytes: full.bytes - upload.bytes,
      chunks: full.chunks - upload.chunks,
      native: fullCost.native - cost.native,
      usd: fullCost.usd != null && cost.usd != null ? fullCost.usd - cost.usd : null,
    },

    nextTotals: nextScan.totals,
    warnings: [...nextScan.warnings],
  };
}

/* ------------------------------- 报告排版 ------------------------------- */

function pad(s, n, right = false) {
  const str = String(s ?? "");
  const width = [...str].reduce((a, c) => a + (c.codePointAt(0) > 0x2e80 ? 2 : 1), 0);
  const fill = " ".repeat(Math.max(0, n - width));
  return right ? fill + str : str + fill;
}

export function formatDiffReport(d) {
  const L = [];
  const sym = d.symbol;
  const money = (c) => `${formatNative(c.native, sym)}${c.usd != null ? ` ≈ ${formatUsd(c.usd)}` : ""}`;

  L.push("═".repeat(78));
  L.push("  增量部署账单 · 从上一版到这一版要多花多少");
  L.push("═".repeat(78));
  L.push(`  上一版（链上）  ${d.previousLabel}`);
  L.push(`  这一版（要传）  ${d.nextLabel}`);
  L.push("");

  if (d.firstDeploy) {
    L.push("  这是首次部署（没有上一版可比）—— 全部文件都要传，等于 scan 的结果。");
    L.push("");
  }

  /* 变化清单 */
  L.push("  变化清单");
  L.push("  " + "─".repeat(74));
  const row = (label, files, bytes) =>
    `    ${pad(label, 26)} ${pad(files + " 个", 7, true)} ${pad(formatBytes(bytes), 11, true)}`;
  L.push(row("未改动（协议跳过，免费）", d.unchanged.length, d.unchanged.reduce((a, f) => a + f.bytes, 0)));
  L.push(row("改动了（整份重传）", d.changed.length, d.changed.reduce((a, f) => a + f.bytes, 0)));
  L.push(row("新增（要传）", d.added.length, d.added.reduce((a, f) => a + f.bytes, 0)));
  L.push(row("删除（也要花 gas）", d.removed.length, d.removed.reduce((a, f) => a + f.bytes, 0)));

  /* 本次要付的钱 */
  L.push("");
  L.push("  这次部署要付");
  L.push("  " + "─".repeat(74));
  L.push(
    `    上传 ${pad(d.total.files + " 个文件", 12)} ${pad(formatBytes(d.upload.bytes), 11, true)} ` +
      `${pad(d.upload.chunks + " 块", 7, true)} ${pad(d.upload.gas.toLocaleString("en-US") + " gas", 17, true)} ${pad(money(d.upload.cost), 24, true)}`,
  );
  if (d.removal.files) {
    L.push(
      `    删除 ${pad(d.removal.files + " 个文件", 12)} ${pad("—", 11, true)} ` +
        `${pad("—", 7, true)} ${pad(d.removal.gas.toLocaleString("en-US") + " gas", 17, true)} ${pad(money(d.removal.cost), 24, true)}`,
    );
  }
  L.push("    " + "·".repeat(72));
  L.push(
    `    ${pad("合计", 17)} ${pad(formatBytes(d.total.bytes), 11, true)} ` +
      `${pad(d.total.chunks + " 块", 7, true)} ${pad(d.total.gas.toLocaleString("en-US") + " gas", 17, true)} ${pad(money(d.total.cost), 24, true)}`,
  );

  /* 与全量重传对比 —— 让「增量到底省了多少」可见 */
  L.push("");
  L.push("  如果整站重传（对照）");
  L.push("  " + "─".repeat(74));
  L.push(
    `    ${pad("全量", 17)} ${pad(formatBytes(d.full.bytes), 11, true)} ` +
      `${pad(d.full.chunks + " 块", 7, true)} ${pad(d.full.gas.toLocaleString("en-US") + " gas", 17, true)} ${pad(money(d.full.cost), 24, true)}`,
  );
  const sv = d.savedVsFull;
  L.push(
    `    ${pad("本次省掉", 17)} ${pad(formatBytes(sv.bytes), 11, true)} ` +
      `${pad(sv.chunks + " 块", 7, true)} ${pad(sv.gas.toLocaleString("en-US") + " gas", 17, true)} ${pad(money({ native: sv.native, usd: sv.usd }), 24, true)}`,
  );

  /* 改动最大的几个文件 —— 它们就是「每次成本」的主要来源 */
  const hot = [...d.changed].sort((a, b) => b.bytes - a.bytes).slice(0, 8);
  if (hot.length) {
    L.push("");
    L.push("  本次改动的文件（按体积，它们直接决定这次要付多少钱）");
    L.push("  " + "─".repeat(74));
    for (const f of hot) {
      L.push(
        `    ${pad(f.path, 36)} ${pad(formatBytes(f.oldBytes), 10, true)} → ${pad(formatBytes(f.bytes), 10, true)}  ${pad(f.chunks + " 块", 7, true)}`,
      );
    }
    if (d.changed.length > hot.length) L.push(`    …… 还有 ${d.changed.length - hot.length} 个`);

    const hotBytes = d.changed.reduce((a, f) => a + f.bytes, 0);
    L.push("");
    L.push(
      `  ▸ 改动的 ${d.changed.length} 个文件共 ${formatBytes(hotBytes)}，占这次上传的 ` +
        `${d.upload.bytes ? ((hotBytes / d.upload.bytes) * 100).toFixed(0) : 0}%。`,
    );
    L.push("    这些文件就是你长期迭代的「每次成本」—— 想降低每次部署的钱，优先压它们，");
    L.push("    而不是压那些改一次就永久免费的大图片。");
  } else if (!d.firstDeploy && d.added.length === 0 && d.removed.length === 0) {
    L.push("");
    L.push("  ▸ 没有任何文件变化，这次部署不需要花钱（协议会跳过所有文件）。");
  }

  if (d.warnings.length) {
    L.push("");
    L.push("  警告");
    L.push("  " + "─".repeat(74));
    for (const w of d.warnings) L.push(`    ! ${w}`);
  }

  L.push("");
  return L.join("\n");
}
