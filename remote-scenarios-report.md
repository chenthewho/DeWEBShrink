# 远程 MCP 多场景测试报告 · deweb-shrink @ yutingprod.com

| 项 | 值 |
| --- | --- |
| 端点 | `POST https://yutingprod.com/mcp/`（Streamable HTTP，桥接形态 `on-demand-stdio`，每请求拉起一个 Node） |
| 认证 | `x-api-key` / `Authorization: Bearer`，实测必需 |
| 被测版本 | deweb-shrink **0.3.0**（工具：`cost_model` / `scan` / `estimate` / `optimize` / `verify` / `diff`） |
| 测试时间 | 2026-10-12 00:04–00:50（Asia/Shanghai） |
| 客户端 | ① 标准 MCP 客户端（`@modelcontextprotocol/sdk` 1.32.1 + `StreamableHTTPClientTransport`）② 裸 HTTP（只它测得到鉴权/方法/坏 body）③ 本地 stdio 同一份代码作对照组 |
| 脚本 | `scripts/scenarios-remote.mjs`（9 个场景组、93 项计分断言、可重复跑） |
| 机器可读结果 | `remote-scenarios-report.json` |
| 本轮结果 | **88 通过 / 5 失败 · 计分 93 项 · 15 项仅记录**（修复前，见第六节修复后复测） |
| 既有验收脚本 | `scripts/test-remote.mjs` → **21/21 通过**（见「为什么验收脚本没发现」） |

复跑：

```bash
DEWEB_SHRINK_API_KEY=<key> node scripts/scenarios-remote.mjs https://yutingprod.com/mcp/   # 多场景
DEWEB_SHRINK_API_KEY=<key> node scripts/test-remote.mjs https://yutingprod.com/mcp/        # 原验收
```

---

## 一、结论先说：4 个真问题

### ① 重请求（真站点 optimize）基本不可用 —— 16 次调用只成功 3 次

**现象**：把自带的真站点（`fixtures/07-real-site`，21 文件 / 831 KB，含 4 张 PNG、4 个 JS、8 个字体）走
远程 `optimize`，绝大多数调用直接失败：

```
{"error":"backend error","detail":"Node 没有返回内容：（无输出，可能是超时）"}
{"error":"backend error","detail":"Node 没有返回内容：Warning: Failed to load CA certificates off thread: resource temporarily unavailable"}
```

少数时候也会「成功」但耗时 12.4s / 13.5s，或干脆挂到桥接的 170s 上限
（bridge.log：`FAIL 170018ms method=tools/call err=Node 没有返回内容：（无输出，可能是超时）`）。

同一份输入、同一份代码：**本地 stdio 2.0s 成功，产物 19 个**（对照组每次都过）。

**统计**（四轮运行 + 定向排障，同一输入）：

| | 调用次数 | 成功 | 失败 |
| --- | --- | --- | --- |
| 远程 `optimize`（真站点 21 文件） | 16 | 3 | 13（约 **81% 失败**） |

**根因（已在服务器上定位，不是猜的）**：SiteGround/CloudLinux 的**每用户进程/线程上限**
被这套架构顶爆了。实测 `ulimit -u = 80`，而每次调用要新建：一个多线程的 Node 进程
＋ esbuild 的子进程（Go runtime，按 CPU 数开线程）＋ sharp/libvips 的线程池；再叠加该账号
常态存在的 Apache/PHP-FPM 子进程。服务端原始报错：

```
runtime: failed to create new OS thread (have 9 already; errno=11)
runtime: may need to increase max user processes (ulimit -u)
fatal error: newosproc            ← esbuild（Go）线程创建失败，直接 fatal
Warning: Failed to load CA certificates off thread: resource temporarily unavailable   ← Node 启动线程都开不出来
node[...]: pthread_create: Resource temporarily unavailable                            ← sharp/libvips
PHP-ERR: proc_open(): Fork failed: Resource temporarily unavailable @ .../mcp/index.php:117
```

**影响**：agent 会看到 502「Node 没有返回内容」，没有任何可操作信息；重试可能成功也可能再挂 170s。
这正是 MCP 的主用例（agent 上传站点 → 要一份压缩+账单），线上却是碰运气。

---

### ② 即使成功，远程 JS 压缩会退化成「原样返回」，账单偏贵

**现象**：那次成功的远程调用里，产物与本地逐个对拍发现 **4 个文件不一致，其中 3 个 JS 完全没被压缩**：

| 文件 | 远程产物 | 本地产物 | 说明 |
| --- | --- | --- | --- |
| `clock.js` | 36,807 B | 19,388 B | = 原始大小，未压缩 |
| `pwa.js` | 19,919 B | 11,054 B | = 原始大小 |
| `sw.js` | 3,322 B | 1,753 B | = 原始大小 |
| 整站 | **425,976 B** | **398,127 B** | 远程多付 **27.8 KB + 1 块 ≈ 0.00034 BNB（约 $0.25）/ 每次改版** |

**根因**：同上 —— esbuild 的 Go 进程起不来（`fatal error: newosproc`），`src/optimize/text.js`
捕获异常后按设计退回原文（`mode: "skipped"`，`notes: esbuild 解析失败：…`，校验里 `warn 1`）。
行为是「有提示的降级」，不是静默出错，但**结果比同一工具的本地形态差**，而且
`scan`/账单都按这份更差的产物报「省了多少」。

**顺带一条跨平台观察**：`icons/icon-512.png` 远程 55,975 B vs 本地 55,979 B，
像素对拍 PSNR 73.65 dB（肉眼无差别）——说明「两种形态产物字节完全一致」这句话
只在**同一平台**成立；跨平台应改用像素/PSNR 判定。README 的口径建议补一句。

---

### ③ 并发 >2 就互踩，6 并发几乎全灭

四轮 6 并发实测：**2/6、1/6、0/6、0/6**；定向测试 1/2/3/4/6 并发 → 1/1、1/2、2/3、2/4、3/6。
失败形态两种：明确的后端错误（`无法启动 Node 进程`，即 PHP `proc_open` fork 失败）、
以及**静默挂死**——单个请求挂 170.6s / 170.9s / 173.0s 后失败，客户端还出现过 `fetch failed`。

**影响**：多个 agent/多人同时用会互相拖死；单用户也可能因为「上一个请求还没挂完」而失败。

---

### ④ 空参数 `scan` 会扫描**服务器自己的部署目录**（信息泄露）

`scan` 既不给 `dir` 也不给 `files` 时（`files: []` 同样），`src/index.js` 的 `sourceFrom`
回退到 `process.cwd()`，也就是服务器的部署目录：

```
实际返回 dir=/home/customer/deweb-shrink · 77 个文件 · 跳过项：.dockerignore、.gitignore、.mcp-key
```

任何持 key 的调用者都能拿到部署目录的完整文件清单（路径 + 大小），包括 **`.mcp-key` 的存在与长度**。
（`optimize` 空参数会报错、不会写盘，所以目前只是清单泄露，不是源码泄露。）

**最小修复**（`src/index.js`，发布即生效，无需重启）：

```js
function sourceFrom({ dir, files, exclude = [] }) {
  if (files && files.length) {
    assertWithinLimits(files);
    return createMemorySource(files, { exclude });
  }
  if (!dir) {
    throw new Error(
      "缺少输入：服务器形态请传 files（文件内容），本地形态请传 dir（目录路径）。" +
        "不允许空参数 —— 那会扫描运行进程自己的工作目录（服务器上就是部署目录）。",
    );
  }
  return createFsSource(path.resolve(dir), { exclude });
}
```

---

## 二、为什么原验收脚本（21/21 全绿）没发现这些

`test-remote.mjs` 的素材是 **41 KB 的迷你站点 + 40 KB 全零 PNG**，走的是最轻的路径：
没有真实大图、没有 20 文件规模、不做并发、不比对产物。它验的是「服务活着、能压小、产物能回传」，
这些都确实没问题。① ② ③ 只在**规模 + 图片/JS 混合 + 重叠请求**时才暴露。

建议把 `scenarios-remote.mjs` 作为发布前的第二道验收（它对 9 个场景组、93 项计分），
或者在 `test-remote.mjs` 里补一条「真站点 optimize + 产物与本地对拍」。

---

## 三、已验证没问题的部分（覆盖清单）

- **端点/鉴权/协议**：探活免 key 且返回 `mode: on-demand-stdio`；无 key / 错 key → 401；
  `Authorization: Bearer` 同样可用；PUT/DELETE → 405；坏 JSON / 空 body → 400（提示明确）；
  notification（无 id）→ 202 且不挂起；不存在的工具 → JSON-RPC 错误而不是 500；
  17 MB 请求体 → 413（`这次传了约 17 MB，超过上限 16 MB`）；
  `/mcp/health` 被站点前端兜底吃掉（返回 HTML）—— 与部署文档写的一致。
- **计费模型**：`CHUNK_BYTES=24000 / perChunk=270000 / perByte=235` 与协议一致；
  1 MB = 44 块 / 258,295,360 gas / 0.012914768 BNB ≈ $9.8；bsc / xlayer / base 三链；
  `estimate` 与 `cost_model` 同公式；0 字节与负数按 1 块计（不产生负数账）；小数向下取整；
  **远程与本地逐字段一致**。
- **三种形态账单一致**：远程 `files` = 本地 `files` = 本地 `dir` →
  831,130 B / 48 块 / 208,275,550 gas，分毫不差。
- **压缩能力**（远程实测）：JS/CSS/HTML 压缩且保留被内联脚本引用的全局；
  真实 PNG 站 988,388 → 185,067 B（省 81%）且像素尺寸不变；
  激进 HTML 档更小且校验通过；转 WebP 后产物与 HTML 引用同步重写、不断链；
  默认删掉 README/.map/无引用图，同时保护 robots.txt / favicon.ico / apple-touch-icon.png；
  关掉开关则一个都不删。
- **扫描诊断**：隐藏文件/目录标记为「协议会静默跳过」；断链、重复内容、Content-Type
  （`.webmanifest` → `application/octet-stream`）都报出来；本地 `dir` 形态下 9 MiB 文件标记为 `toobig`。
  （远程形态永远先撞 8 MB 请求上限，所以看不到「超 8 MiB 静默跳过」这条提示 —— 见下方口径建议。）
- **校验**：10 项检查齐全；「跨文件全局被改名」「缺 index.html」「新增断链」全部拦住；
  产物与原文一致时不误报。
- **增量账单**：首次部署 = 全量；改 1 个文件 → `changed=1/unchanged=5`，增量 296,555 vs 全量 1,822,570 gas；
  删文件计入 `removeFile` gas；远程与本地一致。
- **输入健壮性**：中文/空格路径（NFC）、前导斜杠、反斜杠、重复路径、缺 content/base64、
  路径穿越、>1000 字符路径、`exclude` 前缀 —— 全部按预期或给出可操作错误。
- **性能**：单次轻调用 170 ms–2.3 s（桥接自报服务端 245–282 ms，`x-tape-elapsed-ms`）；
  单发 optimize 稳定成功；失败后探活仍正常。

---

## 四、修复方向（按性价比排序）

1. **空参数**：用上面的 3 行补丁，立刻消掉信息泄露。
2. **并发与资源**：
   - PHP 桥接侧加一把 `flock` 串行锁，一次只放 1–2 个 Node 子进程；
   - 桥接给子进程加环境变量 `UV_THREADPOOL_SIZE=2`、`GOMAXPROCS=2`（压住 libuv/esbuild 的线程数）；
   - 代码里 `sharp.concurrency(1); sharp.cache(false)`；
   - 把「170s 超时」缩短到 30–45s，并返回「服务繁忙，请稍后重试」，别让 agent 干等 3 分钟。
3. **口径**：远程形态下「超 8 MiB 单文件会被静默跳过」这条诊断**永远测不到**（8 MiB 请求上限先拦住，
   而提示里「先单独压最大的那个文件」对单个 >8 MB 文件是死路）。建议超限提示改成
   「这个文件超过 8 MB 请求上限，本服务无法处理它；链上协议也会跳过它」。
4. **根治**：这台共享主机（禁 TCP listen、进程不能脱离会话、`ulimit -u 80`）本来就不适合跑
   sharp/esbuild 这种线程/CPU 密集型服务。换一台小 VPS 会一次性消掉问题 ①②③；
   留在共享主机上，问题 ① 只能缓解、不能保证。
5. **文档**：产物一致性改成「同平台逐字节一致；跨平台像素一致（PSNR 实测 73.65 dB）」。

---

## 五、给 agent 使用时的建议（临时规避）

在 ①②③ 修好之前，远程形态这样用最稳：

- 一次只传**一个批次**、别并发（`DEWEB_SHRINK_CONCURRENCY=1` 级别的使用习惯）；
- 图片和 JS 分开调用：先传文本（HTML/CSS/JS）拿到压缩结果，再传图片；
- 单次内容控制在 ~300 KB 以内（越大越容易撞线程上限）；
- 对 `optimize` 的响应做重试（3 次里通常能有 1 次成功），并核对返回的 `verification.warned`
  —— `warn` 里出现 `esbuild 解析失败` 就说明这一版 JS 没压，账单数字偏大；
- 真正重要的发布，用**本地 stdio** 跑一遍（同一份代码，本地 100% 成功且产物更好）。

---

## 附：本轮失败项原文

```
✗ [③ 真站点对拍] 远程 optimize 成功（含图片的真实站点，最多重试 3 次）
    3 次全失败：backend error / Node 没有返回内容：（无输出，可能是超时）
✗ [③ 真站点对拍] 远程与本地产物对拍（前置条件：远程 optimize 至少成功一次）
✗ [⑧ 输入健壮性] 空参数 scan 不应当悄悄扫描服务器自己的目录
    实际返回 dir=/home/customer/deweb-shrink，77 个文件，跳过项含 .mcp-key
✗ [⑨ 性能与并发] 并发下至少有一半请求成功    0/6（单个最慢 170,610ms）
✗ [⑨ 性能与并发] 并发失败时返回的是明确的后端错误    #2 出现 fetch failed
```

---

## 六、修复后复测（2026-10-12 22:15–22:35）

针对上面 ①②③④ 做了修复并已部署到 `yutingprod.com`。

### 改了什么

| 文件 | 改动 |
| --- | --- |
| `src/index.js` | `sourceFrom`：`dir` 与 `files` 都缺（含 `files: []`）→ 明确报「缺少输入」，不再回退 `process.cwd()` |
| `src/optimize/images.js` | 支持 `DEWEB_SHRINK_SHARP_CONCURRENCY=1` → `sharp.concurrency(1)` + `sharp.cache(false)`（不设则保持默认，本地行为不变） |
| `test/http.test.js` | 新增 2 条回归：四个工具空参数必须报错；`files: []` 同样报错 |
| `deploy/php-bridge/index.php` | ①`flock(bridge.lock)` 串行闸（排队最多 20s，超了回 503 `busy` + `retry-after`）②子进程环境加 `UV_THREADPOOL_SIZE=2`、`GOMAXPROCS=2`、`DEWEB_SHRINK_SHARP_CONCURRENCY=1`、`DEWEB_SHRINK_TIMEOUT_MS=45000`、`DEWEB_SHRINK_CONCURRENCY=1` ③`TIMEOUT` 170s → 60s ④资源类失败回 `error: server overloaded` + 可操作 hint |
| `deploy/README.md` / `README.md` | 记录线程预算、串行闸、远程注册片段、新环境变量 |

部署方式：`rsync src/` + `scp deploy/php-bridge/index.php`（桥接已备份为
`~/deweb-shrink/index.php.bak-20261012-141503`，回滚一条 `cp` 即可）。

### 复测结果

| 指标 | 修复前 | 修复后 |
| --- | --- | --- |
| 多场景套件 | 88 通过 / **5 失败** | **98 通过 / 0 失败**（计分 98 项 + 17 项记录） |
| 真站点 optimize（21 文件 / 831 KB） | 16 次调用成功 3 次（**~19%**） | 复测 **6/6 成功**，耗时 27.0 / 18.3 / 8.6 / 8.5 / 8.3 / 8.5 s |
| 远程产物 vs 本地 | 3 个 JS 未压缩，整站差 27.8 KB | **非图片产物 16 个逐字节一致**，整站 398,123 B（本地 398,127 B，差 4 B 来自跨平台 PNG 编码） |
| 6 并发 | 2/6、1/6、0/6、0/6（有请求挂 170s） | **6/6 成功，总耗时 3.2s**（并发请求排队 0.45–1.8s 后依次执行） |
| 空参数 `scan` | 扫描服务器部署目录（77 个文件，含 `.mcp-key`） | 明确报「缺少输入」 |
| 部署后 bridge.log | 累计 49 条 FAIL | 部署后：**71 条 OK / 0 条 FAIL / 4 条 QUEUED / 0 条 BUSY** |
| 原验收脚本 | 21/21 | 21/21（未回归） |

桥接日志里的排队证据（4 个并发请求依次拿锁）：

```
14:20:04 OK 433ms method=tools/call bytes=12470
14:20:04 QUEUED waited=450ms method=tools/call
14:20:05 QUEUED waited=901ms method=tools/call
14:20:05 QUEUED waited=1351ms method=tools/call
14:20:06 QUEUED waited=1801ms method=tools/call
```

### 代价与剩余事项

- **变慢了**：真站点 optimize 8–27s（热身后稳定 ~8.5s），是「线程全压到最小 + 必须串行」换来的。
  并发能力只有换掉共享主机才能根治（禁 TCP listen、进程不能脱离会话、`ulimit -u 80`）。
- **图片产物跨平台仍有 4 字节差**（`icon-512.png` 55,975 vs 55,979 B，PSNR 73.65 dB）：
  libvips 在不同平台/编译下的编码字节不同。文档口径已按「同平台逐字节一致、跨平台像素一致」理解。
- **`manifest.webmanifest` 的 Content-Type 警告**（`warn 1`）是原有建议项，不是回归：
  协议扩展名表里没有 `webmanifest`，会以 `octet-stream` 提供；建议改名 `manifest.json` 并同步引用。
- **>8 MB 单文件的提示**仍是死路（「先单独压最大的那个文件」对一个 9 MB 文件不成立）——
  已在报告第四节第 3 条列出，尚未改文案。
