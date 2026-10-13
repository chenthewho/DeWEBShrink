/* ==========================================================================
   该传哪些文件 —— 以及哪些文件是白花钱
   --------------------------------------------------------------------------
   链上字节是永久计费，所以「不传」这件事必须谨慎。但**谨慎不等于什么都不删**：
   把一个 README、一张没人引用的图传上去，是实打实的钱，而且没有任何收益。

   默认行为（0.3.0 起）：**删掉白花钱的文件**，两类：

     1. 非站点资源 —— README / CHANGELOG / .map / .lock / 设计稿（.psd/.sketch）
        它们不是站点的一部分，传上去只是把仓库顺手发到了链上。
     2. 没有任何引用的文件 —— 传上去也没有任何页面会去取它。

   但有两类**必须保留**，否则会静默失效：

     · keep 显式指定的；
     · **约定文件**（robots.txt、favicon.ico、.well-known/…）—— 它们靠「约定路径」
       被浏览器 / 爬虫 / 平台自动请求，**天然没有 HTML 引用**。按「无引用」判会
       把它们误删，而且删完页面还能打开，问题要到线上才暴露。

   另外：扫描结果里 skipped 的那些文件（隐藏文件 / 超 8 MiB / 非法路径）本来就不会
   上传，连「删」都不用考虑。
   ========================================================================== */

"use strict";

/** 一眼就知道不是站点资源的文件（文档、源码映射、CI 配置）。 */
export const NON_SITE_RE = /(?:^|\/)(?:README|CHANGELOG|LICENSE|CONTRIBUTING|AUTHORS)(?:\.[a-z]+)?$/i;
export const NON_SITE_EXT_RE = /\.(?:md|markdown|map|ts|tsx|scss|sass|less|psd|ai|sketch|fig|bak|orig|log|lock)$/i;

/**
 * 靠**约定路径**被访问、因此没有 HTML 引用的文件。
 *
 * 这些一定不能被「无引用」规则删掉：删了页面照样打开，但功能静默失效
 * （爬虫读不到 robots、iOS 没图标、域名验证失败），而钱已经花了。
 *
 * 注意路径锚定：`apple-touch-icon.png` 只有放在**根目录**才是 iOS 的自动请求目标；
 * `icons/apple-touch-icon.png` 不是，所以那条不需要保护。
 */
export const CONVENTION_FILES = [
  /^robots\.txt$/i,
  /^sitemap\.xml$/i,
  /^sitemap\.txt$/i,
  /^favicon\.ico$/i,
  /^browserconfig\.xml$/i,
  /^humans\.txt$/i,
  /^security\.txt$/i,
  /^manifest\.(?:webmanifest|json)$/i,
  /^apple-touch-icon(?:-\d+x\d+)?(?:-precomposed)?\.png$/i,
  /* 注意：.well-known/ 下的文件在本协议下**根本传不上去** —— 路径任一段以 "."
     开头会被判为隐藏文件、静默跳过（见 protocol.js 的 isHiddenPath）。
     这里仍然列着，是为了万一协议规则放宽时不会再被「无引用」规则误删。 */
  /^\.well-known\//i,
  /^\.nojekyll$/i,
  /^_redirects$/i,
  /^_headers$/i,
];

/** 这个路径是不是「靠约定访问」的文件（因此不能因为无引用就删）。 */
export function isConventionFile(rel) {
  return CONVENTION_FILES.some((re) => re.test(rel));
}

/**
 * 决定输出里保留什么。
 * @param {object} scan scanSite() 的结果
 * @param {{dropUnreferenced?:boolean, dropNonSiteFiles?:boolean, drop?:string[], keep?:string[]}} opts
 */
export function decideDrops(scan, opts = {}) {
  const { dropUnreferenced = true, dropNonSiteFiles = true, drop = [], keep = [] } = opts;
  const keepSet = new Set(keep);
  const dropSet = new Set(drop);
  const unreferenced = new Set(scan.references.unreferenced);

  const dropped = [];
  const kept = [];
  const protectedByConvention = [];

  for (const f of scan.billable) {
    if (keepSet.has(f.path)) {
      kept.push(f);
      continue;
    }

    // 约定文件优先于任何删除规则：它们没有引用是**正常的**
    if (isConventionFile(f.path)) {
      if (dropSet.has(f.path)) {
        // 显式 drop 仍然尊重（用户说了算）
        dropped.push({ ...f, dropReason: "被显式排除" });
      } else {
        if (unreferenced.has(f.path) || NON_SITE_RE.test(f.path) || NON_SITE_EXT_RE.test(f.path)) {
          protectedByConvention.push(f.path);
        }
        kept.push(f);
      }
      continue;
    }

    let reason = null;
    if (dropSet.has(f.path)) reason = "被显式排除";
    else if (dropNonSiteFiles && (NON_SITE_RE.test(f.path) || NON_SITE_EXT_RE.test(f.path))) {
      reason = "不是站点资源（文档 / 源码 / 映射）";
    } else if (dropUnreferenced && unreferenced.has(f.path)) {
      reason = "没有任何引用";
    }
    if (reason) dropped.push({ ...f, dropReason: reason });
    else kept.push(f);
  }

  return { kept, dropped, protectedByConvention };
}

/** 输出目录不能落在源目录里，否则会递归扫到自己。 */
export function assertOutside(srcRoot, outRoot) {
  const a = srcRoot.replace(/[/\\]+$/, "");
  const b = outRoot.replace(/[/\\]+$/, "");
  if (a === b) throw new Error("输出目录不能等于源目录（本工具只做「原样保留 + 另存一份」，不原地改）");
  if (b.startsWith(`${a}/`) || b.startsWith(`${a}\\`)) {
    throw new Error(`输出目录 ${outRoot} 在源目录里面，扫描会把自己算进去；换到源目录外面`);
  }
}
