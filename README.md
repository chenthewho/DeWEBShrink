# DeWEBShrink

**去中心化网站的体检与压缩工具。**

它做两件事：**体检**出链上站点的问题与真实上链成本（TapeOut / TapeKit 生态），
再把它**压小**，并算出这一版省了多少钱。以 MCP server 形式提供，本地 stdio、
服务器 Streamable HTTP 两种形态都能跑。

它不是一个「顺手 minify 一下」的脚本 —— 计费公式、块大小、路径规则、Content-Type 表
全部照抄 tapecode.ai 前端 bundle 里的那份常量，所以给出的数字就是发布页会给出的那个数字。

```bash
cd deweb-shrink
npm install
npm test                                  # 98 个测试，含端到端、与链上实测对拍、源目录零改动断言

node src/cli.js model                     # 打印计费模型
node src/cli.js scan     ..  --exclude deweb-shrink,.shots
node src/cli.js optimize ..  --exclude deweb-shrink,.shots --out ../site.tape
node src/cli.js verify   ../site.tape --reference ..
```

---

## 1. 为什么「文件越大越贵」

TapeCode 把站点**原样按路径写进链上的容器合约**（`putFile` / `appendChunk`），
没有任何自动 gzip / brotli / WebP 转换。所以从协议前端抄下来的账单是：

| 常量 | 值 | 含义 |
| --- | --- | --- |
| `CHUNK_BYTES` | `24,000` | 每 24 KB 切一块，**一块 = 一笔交易** |
| `perChunk` | `270,000` gas | 每块固定开销（交易本身、目录槽位、事件） |
| `perByte` | `235` gas | **每一个字节**，永久 |
| 地板价 | `0.05 gwei`（BSC） | `gasPrice = max(地板价, min(实时价, 20×地板价))` |
| 单文件上限 | `8 MiB` | 超过的文件**静默跳过**，界面不报错 |

```
gas ≈ 块数 × 270,000 + 字节数 × 235
```

也就是说 `235 gas/byte` 是主体：它对应「calldata（16 gas/非零字节）+ 把字节真正落到链上」。
在 BSC 地板价 `0.05 gwei` 下：

> **1 MB 纯数据 ≈ 0.0129 BNB ≈ $9.6（BNB $747）**

几个直接推论（都会影响你怎么改站点）：

- **多文件比大文件贵**：块数是按文件各向上取整的。10 个 3 KB 的小文件 = 10 块 = 270 万 gas
  的纯块开销，而它们总共才 30 KB。
- **只改一个文件，只花那一个文件的钱**：同一路径 + 同一 `sha256` 会被跳过。但那个文件是**整份重传** ——
  所以把一张 240 KB 的图换成 60 KB，省的是**每一次改版**的钱。
- **压缩是永久的**：内容上链后永久保留，`removeFile` 只是从目录里取下，字节还在链上，取下本身还要 gas。
- **别把垃圾传上去**：`README.md`、`.map`、设计稿这些会照样按字节计费；隐藏文件（`.shots/`、`.DS_Store`）
  则会被协议整个跳过（`super-lock` 的 `.shots/` 有 4.6 MB，一个字节都没上传）。

## 2. 它在真实站点上做了什么

拿本仓库（`super-lock`，辉光管时钟站）实测，在 BNB Chain 地板价、BNB $747.31 下：

| | 文件数 | 字节数 | 块数 | gas | 费用 |
| --- | --- | --- | --- | --- | --- |
| 优化前 | 20 | 801,960 | 46 | 200,880,600 | 0.010044 BNB ≈ **$7.51** |
| 优化后 | 20 | 408,755 | 29 | 103,887,425 | 0.005194 BNB ≈ **$3.88** |
| **省下** | | **384 KB（49.0%）** | 17 | 96,993,175 | **$3.62** |

钱主要省在这几处：

- `icons/icon-512.png` **246,638 → 55,979**（-77%）、`icon-maskable-512.png` **121,529 → 23,070**（-81%）、
  `icon-192.png` **49,012 → 12,690**、`apple-touch-icon.png` **43,841 → 11,896**。
  做法是**同格式的调色板量化**（还是 `.png`，路径和引用都不动），并且逐档试 + 量 PSNR，
  取「达到质量门限里最小的那一档」；实测这几张图落在 q85 / 42.7 dB。
- `chain.js` **20,496 → 6,931**（-66%）、`clock.js` **36,807 → 19,388**（-47%）、
  `sw.js` -47%、`pwa.js` -42%：JS 压缩。
- `index.html` 保守压缩只省 3%；激进档（去属性引号 + 折叠空白 + 压内联 CSS/JS）能到 **-37%**
  （69,242 → 43,706），默认不开。

**还剩什么没省**（`optimize` 报告里的「还能再省」一节会把每项折算成钱）：

- **字体 176.5 KB，占优化后总体积的 44%** —— 现在是最大的一项。要再压得做字体子集化
  （harfbuzz `subset-font` 重裁字形），但必须先有一条「页面用到的码位在新字体里都还在」的校验，
  否则会渲染成豆腐块。本工具**故意不做**，只报数（约还能省 88 KB）。
- `icons/apple-touch-icon.png`（42.8 KB）**没有任何引用**；`README.md`（17.4 KB）不是站点资源。
  **这两类现在默认就不写入产物了**（见第 3 节 ①）。

## 3. 三个刻意的设计决定

**① 默认删掉白花钱的文件，但不删「靠约定路径访问」的。**
上链是按字节**永久**计费，所以把 README、`.map`、没人引用的图传上去是纯亏 ——
它们默认不写入产物，报告里会逐条列出删了什么、省了多少。

但有一类文件**必须保护**：`robots.txt`、`favicon.ico`、`apple-touch-icon.png`（根目录）、
`sitemap.xml`、`browserconfig.xml` 这些靠**约定路径**被浏览器 / 爬虫自动请求，
**天然没有 HTML 引用**。按「无引用」判会把它们误删，而且删完页面照样打开，
问题要到线上才暴露。所以它们走单独的保护名单（`src/optimize/files.js` 的
`CONVENTION_FILES`），并且报告里会说明「这些是保留的约定文件」。

（顺带一个协议限制：**`.well-known/` 传不上去** —— 路径段以 `.` 开头会被判为隐藏文件
静默跳过，所以域名验证、ACME 在这个协议下都用不了。）

转 WebP、激进 HTML 这类**会改站点结构**的手段仍然是显式开关：它们的风险比「少传一个
没人引用的文件」大得多，值不值得由人决定。

**② 绝不原地改。**
源目录只读，产物写到独立的 `<dir>.tape`（不允许放进源目录里）。压坏了、校验不过，
源目录一个字节都没动 —— 端到端测试里有一条断言专门盯着这个。

**③ 每次优化都跟一遍校验。**
`verify` 会检查入口 `index.html`、协议合法性（隐藏文件 / 非法路径 / 超 8 MiB）、
引用完整性、JS 语法、HTML 标签直方图、**跨文件全局有没有被改名**、Content-Type、
图片像素尺寸。其中「跨文件全局」是最关键的一条：这个站点的 `index.html` 内联脚本直接引用
`clock.js` / `chain.js` / `pwa.js` 暴露的 `NixieClock` / `NixieChain` / `NixiePWA`，
任何「重命名顶层标识符」的压缩都会把站点压成一堆 `ReferenceError`。

实测 esbuild 的行为是：对**裸全局脚本**会保留顶层名字，对 **IIFE 包裹**的文件才会重命名内部标识符
（本项目的 `clock.js` / `chain.js` / `pwa.js` / `sw.js` 正好都是 IIFE，所以能吃满压缩率）。
但工具不靠「相信 esbuild」：先用 acorn 解出顶层声明名，压完再逐个检查是否都还在，
少一个就自动退回「只压空白与语法、绝不改名」，并检查所有资源引用字符串是否原样保留。

> 校验不是装饰。开发过程中它当场抓出了两个真 bug：
> ① 转 WebP 时字节写到了新文件名下、引用却指向旧名（线上必然 404）；
> ② `manifest.webmanifest` 的 `icons[].type` 没跟着扩展名改。
> 两个都已经修掉，并且有回归测试。

## 4. MCP 工具

已经在 `~/.dsh/profiles/web/cordis.patch.yml` 里注册，工具名是 `mcp__deweb-shrink__<tool>`：

| 工具 | 做什么 |
| --- | --- |
| `cost_model` | 计费模型 + 全部常量 + 「1 MB 多少钱」参考价 |
| `scan` | 只读扫描：会被上传哪些文件、多少字节/块/gas/BNB/美元；顺带列出协议会静默跳过的文件、断链、死文件、重复内容、Content-Type 问题 |
| `estimate` | 只给字节数算钱（「再加一个 2 MB 的视频要多少」） |
| `optimize` | 压出一份新目录 + 前后费用对比 + 校验结果 + 「还能再省」清单 |
| `verify` | 校验某个目录能不能安全上链；给了 `reference` 就与原文对拍 |
| `diff` | **增量账单**：从链上那一版到这一版，实际上传要多花多少钱（长期迭代看这个） |

> 除 `cost_model` / `estimate`（纯计算）外，其余工具都接受 `dir`（本地目录路径）
> **或** `files`（文件内容）—— 后者是服务器形态，见下一节。
> **两者都不给会明确报错**（以前会回退到 `process.cwd()`，在服务器上等于扫描部署目录自己，
> 会把 `~/deweb-shrink` 的文件清单连同 `.mcp-key` 一起报给调用方）。

### 本地注册片段（stdio）

```yaml
- insert:
    - id: mcp-deweb-shrink
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: deweb-shrink
        transport: stdio
        command: node
        args: [ '/Users/thewho/code/deepseek/deweb-shrink/src/index.js' ]
        cwd: /Users/thewho/code/deepseek/deweb-shrink
        failOnStartupError: false
```

### 远程注册片段（Streamable HTTP）

同一台机器上可以同时挂本地和远程两份 —— `serverName` 不同，工具命名空间就不同
（`mcp__deweb-shrink__*` 是本地，`mcp__deweb-shrink-remote__*` 是远程）：

```yaml
- insert:
    - id: mcp-deweb-shrink-remote
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: deweb-shrink-remote
        transport: streamable-http
        url: https://yutingprod.com/mcp/
        headers:
          x-api-key: <KEY>          # ⚠️ 明文密钥；profile 文件权限保持 600
        failOnStartupError: false    # 服务器挂了不拖住 DSH 启动
```

改完 profile 要**重启 DSH** 才会出现工具（MCP 连接在启动时建立）。
远程形态的限制（并发要靠排队、重请求慢）见 `deploy/README.md`。

> 要把服务**给别人用**：接入与使用说明见 [`docs/using-the-mcp.md`](docs/using-the-mcp.md)
> （可以直接连同一把 key 转发出去，含各客户端配置、限额、错误对照表、发给对方的模板）；
> 要让**别的 agent** 用对：提示词见 [`docs/agent-mcp-prompt.md`](docs/agent-mcp-prompt.md)。

## 4.5 纯前端形态（浏览器里跑，无需服务器）

同一套 `src/` 算法也能整体搬进浏览器：**没有服务器、没有 API key、文件不出本机**。
Demo 与验证脚本在 `poc/`：

```bash
npm run fixtures        # 首次：生成示例站点
npm run poc:build       # 打浏览器包（esbuild-wasm + oxipng WASM）
npm run poc:serve       # → http://127.0.0.1:5233/  点「① 一键试用示例站点」再点「② 开始」
npm run poc:verify      # 四层验证全跑（对拍 / 产物包 / 无头 Chrome / UI 冒烟）
```

已验证的等价性（示例站点 21 文件 / 831,130 B）：

| 项 | 结果 |
| --- | --- |
| 账单 | 浏览器与 CLI **完全一致**：48 块 / 208,275,550 gas → 43 块 / 181,648,245 gas |
| 文本产物 | HTML/CSS/JS **逐字节一致**（19 个产物 sha256 全同） |
| 图片 | 浏览器只做无损（oxipng，831 KB → 681 KB）；CLI 做调色板量化（→ 398 KB）——**唯一差别** |

替换点：`sharp`→oxipng WASM、`esbuild`→`esbuild-wasm`、`node:crypto`→纯 JS sha256、
`node:path/fs`→替身、全局 `Buffer`/`process` 注入。细节与踩过的坑见 `poc/README.md`。

## 5. 部署到服务器（Streamable HTTP）

本地用 stdio 就够，但服务器上不行 —— stdio 要求客户端把进程当子进程拉起来，
而「部署一次、别人连过来用」需要的是网络入口：

```bash
DEWEB_SHRINK_API_KEY=你的密钥 PORT=8787 node src/http.js
# 或
npm run start:http
```

| 端点 | 说明 |
| --- | --- |
| `POST /mcp` | MCP Streamable HTTP（无状态，每请求一套 server + transport） |
| `GET /health` | 探活，**不需要** key，方便容器编排 |

### 两种输入形态：`dir` 与 `files`

这是服务器部署最关键的区别：**服务器上没有用户那个目录**。

| 形态 | 输入 | 产物 | 用在哪 |
| --- | --- | --- | --- |
| 本地 stdio | `dir`（目录路径） | 写到 `<dir>.tape` | 自己机器上 |
| 服务器 HTTP | `files`（文件内容） | 以 base64 放在返回的 `artifacts` 里 | agent 把上传的文件传进来 |

`files` 里文本用 `content`、二进制用 `base64`：

```json
{ "files": [
  { "path": "index.html", "content": "<!doctype html>…" },
  { "path": "icons/a.png", "base64": "iVBORw0KG…" }
] }
```

两者走的是**同一套算法**：`source.js` 把「文件从哪来」抽象掉，
`scanSite` / `optimizeSite` / `verifyOutput` 对本地目录和内存文件一视同仁。
测试里有一条断言专门盯住「两种模式产物字节完全一致」，防止两条路走偏。

### 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DEWEB_SHRINK_API_KEY` | 空 | 空 = **不鉴权**，启动时会打警告。支持 `x-api-key` 或 `Authorization: Bearer` |
| `PORT` / `HOST` | `8787` / `0.0.0.0` | 监听地址 |
| `DEWEB_SHRINK_MCP_PATH` | `/mcp` | MCP 端点路径 |
| `DEWEB_SHRINK_MAX_BYTES` | 8 MB | 单次请求的内容总量上限（超了要分批） |
| `DEWEB_SHRINK_MAX_FILES` | 2000 | 单次请求的文件数上限 |
| `DEWEB_SHRINK_CONCURRENCY` | 4 | 同时进行的压缩任务数 |
| `DEWEB_SHRINK_TIMEOUT_MS` | 120000 | 单个任务的等待上限 |
| `DEWEB_SHRINK_MAX_BODY` | 16 MB | HTTP 请求体上限 |
| `DEWEB_SHRINK_CORS` | `*` | `Access-Control-Allow-Origin` |
| `DEWEB_SHRINK_SHARP_CONCURRENCY` | 空（=sharp 默认） | 设成 `1` 就让 libvips 只开一个线程。共享主机上必设，见 `deploy/README.md` |

### 为什么必须有护栏

`sharp` 和 `esbuild` 都是 CPU 密集型，公开服务不设闸，一个 8 MB 的 PNG 就能把进程占住。
所以有体积、并发、超时三道闸，见 `src/limits.js`。两个诚实的说明：

- **超时只是「不再等它」**，并不能真的掐断已经在跑的 CPU 工作（`sharp` 走原生线程池、
  `esbuild` 走子进程，都不是 `setTimeout` 能中断的）。真正硬隔离要把压缩放进
  `worker_threads` 或独立进程，这里没做 —— 但保证了「超时后槽位一定会释放」，
  所以一次超时不会把服务永久卡死。
- **esbuild 用的是异步 `transform`，不是 `transformSync`**。同步版会阻塞事件循环，
  服务器上并发调用时整个进程会被卡住，连并发闸门和超时都跟着失效。

## 6. 长期迭代：让每次部署都最省

协议的计费规则里有一条决定了一切：

> **同一路径 + 同一 sha256 的文件会被跳过；变了的文件整份重传。**

由此推出一个反直觉的结论：

> **长期迭代的成本，不取决于站点多大，而取决于「每次改动的那几个文件多大」。**

一个 800 KB 的站点，如果每次只改一个 20 KB 的 JS，那每次部署只付那 20 KB。
大静态资源（图片、字体）改一次之后就**永久免费**了 —— 它们是「一次性成本」，
而代码是「每次成本」。

### `diff` 就是为这个场景做的

```bash
deweb-shrink diff ./site_v2 --previous ./site_v1 --gas 0.05 --usd 750
# 或
npm run diff -- ./site_v2 --previous ./site_v1
```

它回答的不是「整站多少钱」，而是「**这一版要多花多少**」。

### 实测：三种策略跑 6 轮迭代

`npm run iteration` 模拟一条真实的迭代时间线（修 bug、改文案、换图标、补注释），对照：

| 策略 | 6 轮累计 | 说明 |
| --- | --- | --- |
| A 不压缩 | **$10.39** | 源码原样传，改动按未压缩字节算 |
| B 压缩 + 增量 | **$5.03** | 一直传压缩版，协议自动跳过没变的文件 |
| C 先不压缩、第 3 轮才改用压缩 | **$10.43** | 切换那一轮要全站重传，**反而比 A 还贵** |

- **B 比 A 省 52%。**
- **C 比 B 贵一倍还多** —— 从「未压缩」切到「压缩版」时，压缩会改变**每一个文件**的字节，
  协议判定为全新内容，于是整站重传一次。这笔切换成本完全白花。

### 三条实践建议

1. **第一轮就用压缩版。** 中途切换要付一次全站重传的代价，可能比一直不压缩还贵。
2. **保持压缩参数不变。** 改了 `psnrTarget` 或 `--aggressive`，受影响的文件会全部重传。
   想改就先 `diff` 一遍，看清这一轮要多花多少再决定。
3. **优先压「反复改动」的文件。** 大图片是首付的一部分，改一次就永久免费；
   而 `index.html`、主 JS 这类每次都要动的文件，它们的体积才是真正的「每次成本」。

### 两个意外的好处

- **只改注释不花钱**：压缩会把注释去掉，产物字节不变 → 协议跳过 → 免费。
  （实测第 6 轮：不压缩要 $0.346，压缩版 $0。）
- **换个未优化的图也可能免费**：如果新图压缩后与旧图产物一致，同样不用重传。

## 7. 代码结构

```
src/protocol.js        协议常量：块大小、计费模型、Content-Type 表、路径规则、三条链的地址
src/cost.js            gas / BNB / 美元换算，多源取价（binance-data → binance → coingecko → coinbase）
src/source.js          文件源 / 产物槽：本地目录 or 内存文件数组，算法层不碰 node:fs
src/limits.js          服务器护栏：体积 / 并发 / 超时
src/scan.js            扫描站点 → 协议视角的清单（含引用图、sha256 去重、隐藏文件分类）
src/diff.js            增量账单：对比两版，算「这一版要多花多少」（含 removeFile 成本）
src/refs.js            引用图：JS 走 acorn AST（正则配对引号会在压缩代码上跑偏），HTML/CSS 走文本规则
src/verify.js          10 项自动校验
src/report.js          报告排版 + 「还能再省」估算
src/optimize/
  index.js             流水线：扫 → 压 → 改名重写引用 → 写出 → 重扫 → 校验 → 算账
  text.js              HTML/CSS/JS 压缩 + 三条守卫（顶层名字、选择器、资源引用）
  images.js            sharp：PSNR 门限 + 自适应质量档 + 尺寸/格式/透明通道对拍
  files.js             哪些文件不写入产物（默认一个都不删）
src/index.js           MCP server（工具定义 + stdio 启动）
src/http.js            MCP over Streamable HTTP（服务器部署：API key + 护栏 + 探活）
src/cli.js             命令行（scan / optimize / verify / model）
scripts/test-remote.mjs     远程部署验收（21 项：探活 / 鉴权 / 协议 / 压一次 / 增量 / 护栏）
scripts/scenarios-remote.mjs 远程多场景模拟（98 项计分：真站点对拍、图片、并发、空参数、坏产物…）
```

> 这两条远程测试都直接连 `https://<host>/mcp/`，用标准 MCP 客户端 + 本地 stdio 对照组；
> `npm run test:remote` / `npm run test:scenarios`，用法见 `deploy/README.md`。

### 加新优化器时的约定

1. 不确定就**返回原文**，绝不返回半成品；
2. 产物比原文大 → 一律回退；
3. 改路径/改引用 → 必须同时进 `renames`，让引用重写与 `verify` 都能看到；
4. 新增一类「可能压坏的东西」→ 在 `verify.js` 里补一条能自动判定的检查，
   并在 `test/` 里补一条会失败的用例。

## 8. 官网（`web/`）

产品官网由设计稿**生成**，不手写：结构、文案、颜色、字号、间距、乃至背景的 shader
全部来自 `web/design/DeWEBSharink.pen`（Pencil v2.20）。设计稿里有三个 frame：

| 页面 | 设计稿 frame | 产物 |
| --- | --- | --- |
| 中文桌面 | DeWEBShrink Landing | `web/index.html` → `/` |
| 英文桌面 | DeWEBShrink Landing (EN) | `web/en/index.html` → `/en/` |
| 390 手机版 | DeWEBShrink Mobile (390) | `web/m/index.html` → `/m/` |

```bash
npm run site:build                # 设计稿 → 三个页面 + assets/（含 12 MB 的 esbuild.wasm）
npm run site:serve                # http://127.0.0.1:5240/（/en/ 英文，/m/ 手机版）
npm run site:verify               # 55 项验收：桌面与手机各真跑一遍体检
npm run site:shots -- --lang=zh   # 按区块截图（zh|en|m），用来和设计稿逐屏对
```

页面里的「在线体检」就是本仓库那套算法在浏览器里跑（§4.5 的同一份 `src/`），文件不出本机。
设计稿用的三支 `.glsl` 背景、磁带机隐喻（REC 灯 / VU 表 / 计数器 / 走带键）、组件引用
（`ref` 节点）怎么落地的，以及相对设计稿的主动修正与部署注意
（`application/wasm`、示例站点口子、别把 API key 放前端）都在
[`web/README.md`](web/README.md)。

## 9. 已知边界

- **不做字体子集化**（原因见上），只报数。
- **不直接发交易**。这个工具只碰文件系统；发布仍然走 TapeCode 自己的界面
  （它要签名、要运营节点、要 `operator` 临时钱包）。
- `scan` 只看静态引用。运行时用字符串拼出来的资源名只能靠「basename / 目录前缀」兜底判断，
  所以「死文件」结论是**保守**的（宁可漏报也不误删）。
- 图片质量门限是按 PSNR 量的。PSNR 不是人眼模型，42 dB 只是「实测这几张图看不出差别」的位置，
  换站点建议把 `psnrTarget` 调高再跑一次对比。
