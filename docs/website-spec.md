# DeWEBShrink 官网 · 内容与文案规格（v1，交付设计）

> **这份文档给谁看**：设计师（pen）。里面每一屏的结构、层级、中文终稿、英文终稿、
> 交互状态和微文案都已经定稿或明确标注状态；不需要再回来问「这里写什么」。
>
> **产品是什么**：DeWEBShrink —— 给**去中心化网站**（TapeCode / TapeOut 协议上的链上站点）
> 做**上链前体检 + 压缩**的工具。链上按字节**永久**计费，所以「多传的每一个字节」
> 都是重复付费。工具做三件事：**算出这一版要花多少钱 → 把它压小 → 校验压完还能安全上线**。
>
> **本文所有数字都来自项目实测**（README、`scripts/` 报告、98 项测试）。任何没有实测支撑的
> 说法都不允许出现在页面上，见 §6「文案禁区」。

---

## 0. 给设计师的一页 Brief

### 0.1 一句话目标

> 让一个「已经在链上发站、并且被 gas 账单疼过」的开发者，
> **在首屏 3 秒内**看懂「上链前先体检」，并且**不需要注册、不需要上传**就能立刻试一次。

### 0.2 三个设计目标（按优先级）

1. **首屏就要有「钱」**。这个产品的钩子是账单，不是「更快的压缩工具」。
   首屏必须出现一个真实的省钱数字和一个可点的拖拽区，中间不要插第二个屏的营销图。
2. **拖进去 = 出账单**。核心交互区就是产品本体，不需要滚动就能开始。
   状态切换要非常清楚：空 → 拖拽中 → 扫描 → 压缩 → 校验 → 账单 → 下载。
3. **账单要看起来可信**。等宽数字、明确的假设计算条件（gasPrice / 币价 / 链）、
   可展开的证据（逐文件前后对比、10 项校验清单、原始 JSON）。
   宁可显得「工程味」，也不要显得「营销味」。

### 0.3 硬约束（设计上不能违反）

| 约束 | 原因 / 设计含义 |
| --- | --- |
| **单页长页面**，落地页与工具合一 | 已确认的形态。导航用锚点滚动，不要做多页 |
| **中英双语**，默认中文、可切换 | 英文比中文长 30–50%，所有按钮/标签按**英文长度**排最小宽度；不要用中文挤满的布局再硬塞英文 |
| **文件默认不出本机** | 浏览器本地跑 WASM。**页面上不能出现任何「上传到服务器」的措辞**（除非将来真的做了服务端模式，那也必须显式切换并重新写文案） |
| **首次加载有一个 12 MB 的运行时** | `esbuild.wasm` 12.3 MB + `worker.js` 2.2 MB（gzip 后小很多）。必须有**首次加载态**文案与进度，并说明「只在第一次下载，之后走浏览器缓存」 |
| **数字必须带条件** | 所有金额旁边必须能看见 `gasPrice` 与币价来源。币价会变，页面不允许出现「省 $3.62」而无条件标注 |
| **移动端没有目录拖拽** | iOS/Android 不支持 `webkitdirectory`。移动端要有降级路径与对应文案（见 §3.3 S3-D） |
| **密钥不能出现在前端** | 文档明确写了「别把 key 写进前端代码」。需要服务端能力的入口只做**说明 + 跳转**，不要在前端内置 key |

### 0.4 语气（Tone of Voice）

- **像一个靠谱的工程师同事**：给数字、给条件、给边界，不吹。
- 直接、短句、动词开头。不写「赋能」「一站式」「颠覆」这类词。
- **允许展示不确定**：「这个我们故意不做」「这里会静默跳过，是协议的限制」——
  诚实是这个产品的核心卖点之一（§3.9）。
- 术语不降级：受众是已经在链上发站的开发者，`gas`、`chunk`、`sha256`、`PSNR` 直接用。
- 中文里保留英文原词，不要硬译：`gas`、`chunk`（块）、`.tape`、`sha256`、`PSNR`、
  `Content-Type`、`index.html`、`WebAssembly`。

---

## 1. 页面地图

单页，锚点导航，顺序即为阅读顺序。右下角固定一个「开始体检」浮动按钮（滚过首屏后出现）。

| # | 区块 | 锚点 | 目的 | 长度建议 |
| --- | --- | --- | --- | --- |
| S1 | 顶部导航 | — | 品牌 + 锚点 + 语言切换 + 主 CTA | 64–72 px，滚动后收窄 |
| S2 | Hero | `#top` | 钩子 + 主 CTA + 4 个实测数字 | 100vh 的 80–90% |
| S3 | **在线体检 + 压缩（核心）** | `#checkup` | 拖拽 → 账单 → 校验 → 下载 | 工具区 ≥ 60vh，结果区展开 |
| S4 | 为什么「大就是贵」 | `#pricing` | 讲清计费模型（可信度的根） | 1 屏多 |
| S5 | 功能说明（8 张卡） | `#features` | 拆功能、每张卡带证据 | 2 屏 |
| S6 | 工作原理（4 步） | `#how` | 流水线可视化 | 1 屏 |
| S7 | 真实案例 | `#case` | super-lock 实测：前后对比 + 省钱明细 | 1.5 屏 |
| S8 | 长期迭代最省 | `#iterate` | 增量账单 + A/B/C 三策略 | 1.5 屏 |
| S9 | 还能再省 & 诚实边界 | `#limits` | 明确不做什么 | 1 屏 |
| S10 | 三种用法（网页 / CLI / MCP） | `#use` | Tab 切换接入方式 | 1 屏 |
| S11 | FAQ | `#faq` | 11 条，折叠 | 1.5 屏 |
| S12 | 页脚 | — | 版本、文档、免责声明 | — |

---

## 2. 术语表（中英对照 · 全站必须一致）

| 中文 | English | 备注（设计/文案约束） |
| --- | --- | --- |
| 体检 | checkup | 不用 health check；动词用「做一次体检 / run a checkup」 |
| 压缩 | shrink | 产品名里就是 shrink；不用 compress 做主词 |
| 上链 / 发布 | publish on-chain | 「发站」偏口语，正文用「上链发布」 |
| 块（=一笔交易） | chunk (= one transaction) | 首次出现必须带上括号解释 |
| 账单 | bill | 结果区标题用「账单」，不用「报告」（报告 = 完整文本） |
| 增量账单 | incremental bill | S8 专用 |
| 产物 | output | 指压缩后的目录 / `.tape.zip` |
| 源目录 | source directory | 强调只读 |
| 死文件 | dead file | 没有任何引用的文件 |
| 断链 | dangling reference | |
| 约定文件 | convention file | `robots.txt` / `favicon.ico` 这类靠路径被访问的 |
| 校验 | verification | 10 项 |
| 还能再省 | still on the table | 未启用的可选优化 |
| 优化前 / 优化后 / 省下 | before / after / saved | 表格三行固定用词 |
| 计费模型 | gas model | |
| 地板价 | floor price | gasPrice 的地板 |
| 跳过（静默） | silently skipped | 协议行为，不是我们的 bug |

---

## 3. 全站文案（逐屏终稿）

> 每一屏格式：**【中文终稿】/ 【English】/ 【UI 备注】**。
> 标注 `A/B 备选` 的行是给决策用的，**默认不上设计稿**，除非另行通知。

### S1 · 顶部导航

**【中文终稿】**

- 品牌：`DeWEBShrink`（左侧，字标，不带 slogan）
- 锚点：`在线体检` · `为什么贵` · `功能` · `工作原理` · `真实案例` · `怎么用` · `FAQ`
- 右侧：语言切换 `中文 / EN`，次按钮 `查看文档`，主按钮 `开始体检`

**【English】**

- Brand: `DeWEBShrink`
- Anchors: `Checkup` · `Why it's pricey` · `Features` · `How it works` · `Case study` · `Get started` · `FAQ`
- Right: `中文 / EN`, ghost button `Docs`, primary button `Run a checkup`

**【UI 备注】**

- 导航项 7 个在 1024 px 及以下会挤：≤1024 px 只留 `在线体检 / 功能 / 真实案例`，其余进「更多」下拉。
- 语言切换是**双态开关**，不做下拉；切换后页面滚动位置保持不变。
- 主按钮点击 = 滚到 S3 并让拖拽区出现一次高亮呼吸（1 次，不循环）。

---

### S2 · Hero

**【中文终稿】**

- 眉标：`链上按字节永久计费`
- H1：**上链之前，先给站点做一次体检。**
- 副标题：链上按字节**永久**计费：多传 1 MB，就是多花一份永久的钱。DeWEBShrink 把你的站点扫一遍，告诉你**哪些字节在烧钱、能压掉多少，以及这一版改完要多花多少钱**。
- 主 CTA：`拖进来，立刻体检` ＋ 小字 `免费 · 文件不出本机`
- 次 CTA：`先看一次真实案例`（滚到 S7）
- 信任行：计费公式、块大小、路径规则全部照抄发布页的前端常量 —— 网页里算出的数字，就是发布时账单上的数字。

**4 个实测数字（等宽数字，可换行）**

| 数字 | 中文标签 | 英文标签 | 脚注 |
| --- | --- | --- | --- |
| **−49%** | 一个真实站点压完省下的体积 | bytes saved on one real site | `801,960 B → 408,755 B` |
| **$3.62** | 那一版省下的钱 | saved on that build | `BSC 地板价 0.05 gwei · BNB $747.31` |
| **10 项** | 自动校验，产物与原文对拍 | automated checks, output diffed vs. source | `含跨文件全局改名检查` |
| **0 字节** | 源目录的改动量 | bytes changed in your source | `绝不原地改，产物另存` |

**【English】**

- Eyebrow: `On-chain bytes are billed forever`
- H1: **Check up your site before it goes on-chain.**
- Sub: On-chain bytes are billed **forever**: one extra megabyte is a cost you pay permanently. DeWEBShrink scans your site and tells you **which bytes are burning money, how much you can shrink, and what this revision will really cost.**
- Primary CTA: `Drop your site in — run a checkup` + caption `Free · your files never leave this machine`
- Secondary CTA: `See a real case study`
- Trust line: The billing formula, chunk size and path rules are copied from the publishing front end's own constants — the number you see here is the number the publishing page will quote you.

**Stats block**

| Value | EN label | Footnote |
| --- | --- | --- |
| **−49%** | bytes saved on one real site | `801,960 B → 408,755 B` |
| **$3.62** | saved on that build | `BSC floor 0.05 gwei · BNB $747.31` |
| **10** | automated checks, output diffed vs. source | `includes cross-file global renames` |
| **0 bytes** | changed in your source directory | `never in-place; output is written separately` |

**【UI 备注】**

- H1 必须**单行或两行内**完成，两行时断在「先给站点」后面。
- `免费 · 文件不出本机` 紧贴主 CTA，字号比 CTA 小两级，不要做成独立徽章堆叠。
- 4 个数字建议做成一行 4 列（≤768 px 变 2×2）；数字用 tabular-nums，脚注用等宽字体小字。
- `$3.62` / `−49%` 旁边必须留出脚注位置，**不能只留数字**。
- **Hero 不放任何装置艺术级的插画**。可以放一个静态的「字节 → 块 → 交易」示意图（见 §7）。

---

### S3 · 在线体检 + 压缩（核心区块）

> 这是整页最重要的组件。它本质是一个**状态机**，设计稿需要把每个状态都画出来，
> 而不是只画一个「填满数据的理想态」。完整状态清单见 §4。

#### S3-A 区块标题

**【中文终稿】**
- 小标题：`现在就来`
- H2：**把站点拖进来，三十秒后你知道要花多少钱。**
- 说明：扫描、压缩、校验、算账全部在你的浏览器里跑（WebAssembly），**没有一个字节发到服务器**。算法与 CLI / MCP 是同一份代码。

**【English】**
- Eyebrow: `Try it now`
- H2: **Drop your site in. Thirty seconds later you know what it costs.**
- Body: Scanning, shrinking, verification and the bill all run in your browser (WebAssembly) — **not a single byte is sent to a server.** Same algorithm as the CLI and MCP builds.

#### S3-B 拖拽区（空态）

**【中文终稿】**

- 主文案：`把站点目录拖到这里`
- 分隔：`或者`
- 按钮：`选择文件夹`
- 支持说明：`支持整个目录（含子目录）。单文件上限 8 MiB —— 超过的文件协议会静默跳过，我们会替你标出来。`
- 隐私行：`文件只在你本机内存里处理，关掉页面就没了。`
- 首次加载提示（仅在 WASM 运行时未就绪时出现）：`第一次使用要先下载 12 MB 的压缩运行时，之后走浏览器缓存。`

**【English】**

- Primary: `Drop your site folder here`
- Divider: `or`
- Button: `Choose a folder`
- Support note: `Whole directories, subfolders included. Single-file limit is 8 MiB — larger files are silently skipped by the protocol; we flag them for you.`
- Privacy line: `Files are processed in your browser's memory. Close the tab and they're gone.`
- First-load note (only until the WASM runtime is ready): `First run downloads a 12 MB shrink runtime. After that it's served from your browser cache.`

**【UI 备注】**

- 拖拽区高度 ≥ 220 px，虚线边框；`dragover` 时整块变色 + 边框实线 + 轻微放大（≤1.02）。
- 拖入**非目录**内容时不要直接报错，先接受文件列表（散文件也允许，路径按文件名算）。
- `选择文件夹` 用 `<input type="file" webkitdirectory>`；必须同时提供一个「选择文件」的次要入口（部分浏览器/系统不支持目录选择）。
- 首次加载提示做成拖拽区下方一行细提示，**不要**用 modal 挡住。

#### S3-C 参数区（体检前可调）

**【中文终稿】**

- 区块标签：`计算条件`
- `gasPrice (gwei)` 默认 `0.05`，说明：`BSC 地板价。留空就用 0.05。`
- `BNB 价格 (USD)` 默认 `750`，说明：`用来把 gas 换算成美元。币价随时会变，自己改。`
- `链` 选择：`BSC` / `X Layer` / `Base`（默认 BSC）
- 优化档位（互斥，单选）：
  - `安全档（默认）` — `只改编码，不改路径、不改引用。JS/CSS/HTML 压缩 + PNG 无损重压 + 剔掉白花钱的文件。`
  - `激进档` — `额外去掉 HTML 属性引号、折叠空白、压内联 CSS/JS。会改站点结构，默认不开。`
  - `转换图片格式（WebP）` — `把图片换成 WebP 并重写引用。收益最大，风险也最大，建议先在一份副本上跑。`
- 一键：`开始体检 + 压缩`

**【English】**

- Label: `Assumptions`
- `gasPrice (gwei)` default `0.05` — `BSC floor price. Leave blank to use 0.05.`
- `BNB price (USD)` default `750` — `Used to convert gas into dollars. Prices move — change it.`
- `Chain`: `BSC` / `X Layer` / `Base`
- Presets (radio):
  - `Safe (default)` — `Re-encodes only: no path changes, no reference rewrites. JS/CSS/HTML minification + lossless PNG recompression + dropping files that don't belong in the build.`
  - `Aggressive` — `Also strips HTML attribute quotes, collapses whitespace, minifies inline CSS/JS. Changes site structure; off by default.`
  - `Convert images to WebP` — `Rewrites images and their references. Biggest win, biggest risk — try it on a copy first.`
- Action: `Run checkup + shrink`

**【UI 备注】**

- 三个档位**不要**做成并列 checkbox，用单选卡片（含一行说明），默认选中「安全档」。
- 数字输入右侧留单位位；`gasPrice` 与币价旁各放一个 `i` 提示，内容即上面的说明句。
- 参数区默认折叠在拖拽区下方的一行摘要里（`0.05 gwei · BNB $750 · BSC · 安全档`），点击展开。
  **理由**：绝大多数人不需要改这些，但改的人会很在意。
- ⚠️ **真实现状（给设计的前提，不是文案）**：网页版目前只有「PNG 无损重压」这一个图片开关，
  且浏览器版图片收益**明显小于服务器版**（浏览器走 oxipng 无损重压；服务器走 sharp 调色板量化，
  实测图标 −77%）。若首版不做激进档/WebP，请按 §10 的 Q3 处理：**先画出来，标注「即将支持」**。

#### S3-D 移动端降级

**【中文终稿】**
- `手机上没有「文件夹」这个概念，拖拽也用不了。`
- `在桌面浏览器打开可以完整体检整个站点；手机端我们正在做「上传 .zip」的入口。`
- 次要按钮：`在桌面打开试试` → 复制当前链接。

**【English】**
- `Phones have no "folder" to pick, and drag-and-drop won't help.`
- `Open this page on a desktop browser to check up a whole site. A .zip upload path is in the works.`
- Secondary: `Copy link and open on desktop`

**【UI 备注】**
- 这段只在检测到触摸设备 / 不支持 `webkitdirectory` 时显示，替换掉拖拽区。
- 同时保留「选择单个文件」入口（可以只体检一个文件，也是有价值的，不要完全堵死）。

#### S3-E 运行中

**【中文终稿】** 进度文案按阶段切换（不要做成假进度条匀速跑）：

| 阶段 | 中文 | English |
| --- | --- | --- |
| 读运行时 | `加载压缩运行时…` | `Loading the shrink runtime…` |
| 读取文件 | `读取文件 12 / 20` | `Reading files 12 / 20` |
| 扫描 | `扫描站点、算账单…` | `Scanning the site and pricing every byte…` |
| 压缩 | `压缩中… 8 / 20 · icons/icon-512.png` | `Shrinking… 8 / 20 · icons/icon-512.png` |
| 校验 | `校验产物…` | `Verifying the output…` |
| 完成 | `完成 · 用时 1.8s` | `Done · 1.8s` |

- 区块标题：`正在体检` / `Running the checkup`
- 取消按钮：`取消` / `Cancel`（文案：`可以取消，源目录不会有任何变化。`）

**【UI 备注】**

- 进度条分段（5 段：运行时 / 扫描 / 压缩 / 校验 / 完成），当前段高亮，已完成段实心。
- 当前正在处理的**文件名**要显示，最长 1 行，中间省略。
- 用 `aria-live="polite"`，每阶段切换播报一次，**不要**每 100 ms 播报。
- 整个运行期不要让页面滚动跳动；结果区用骨架屏占位。

#### S3-F 结果 · 账单（架构核心）

**【中文终稿】**

- 区块标题：`账单` + 一行条件：`BSC · gasPrice 0.05 gwei · BNB $747.31`
- 三个大数字（从左到右）：
  1. `省下 $3.62` — 脚注 `这一版少花 48.2%`
  2. `省下 384 KB` — 脚注 `801,960 B → 408,755 B`
  3. `少发 17 笔交易` — 脚注 `46 块 → 29 块`
- 明细表（固定表头）：

| | 文件数 | 字节数 | 块（=交易） | gas | BNB | USD |
| --- | --- | --- | --- | --- | --- | --- |
| 优化前 | 20 | 801,960 | 46 | 200,880,600 | 0.010044 | $7.51 |
| 优化后 | 20 | 408,755 | 29 | 103,887,425 | 0.005194 | $3.88 |
| **省下** | | **384 KB（49.0%）** | 17 | 96,993,175 | 0.001850 | **$3.62** |

- 表下一行：`产物 20 个文件 · 没写进产物的 2 个（共 59.8 KB）`
- 主按钮：`下载 .tape.zip`；次按钮：`复制 JSON`；次按钮：`展开完整报告`
- 「这一版实际要花多少」跳转链接：`只是改了一版？算增量账单 →`（滚到 S8）

**【English】**

- Section title: `The bill` + conditions line: `BSC · gasPrice 0.05 gwei · BNB $747.31`
- Three headline numbers:
  1. `$3.62 saved` — `48.2% cheaper than the raw build`
  2. `384 KB saved` — `801,960 B → 408,755 B`
  3. `17 fewer transactions` — `46 chunks → 29 chunks`
- Table headers: `Files / Bytes / Chunks (= txs) / gas / BNB / USD`; rows `Before / After / Saved`
- Under the table: `20 files in the output · 2 left out (59.8 KB)`
- Buttons: `Download .tape.zip` · `Copy JSON` · `Show full report`
- Link: `Only changed one file? Price the delta →`

**【UI 备注】**

- 表格**必须**支持横向滚动并在窄屏隐藏 `gas` 列（保留 USD 和字节）。
- `省下` 行用强调色（建议绿色系 + 左侧 4 px 色条），不要整行填充高饱和底色。
- 数字全部 tabular-nums，右对齐；金额保留 6 位小数的 BNB 与 2 位小数的 USD。
- 表头 `块（=交易）` 的括号解释只在**首次出现**保留，后面的表格可简写为 `块`。
- 三个大数字与明细表之间不要插广告位、不要插社交分享。

#### S3-G 结果 · 校验（10 项）

**【中文终稿】**
- 标题：`校验 · 全部通过` 或 `校验 · 1 项需要注意` 或 `校验 · 有失败项，先别发布`
- 每项：图标 + 名称 + 一行结论。10 项名称与通过态文案：

| # | 名称 | 通过态文案 | English name |
| --- | --- | --- | --- |
| 1 | 入口 `index.html` | 存在；发布页要求项目里有 `index.html` | Entry `index.html` |
| 2 | 协议合法性 | 没有任何文件会被协议静默跳过 | Protocol legality |
| 3 | 引用完整性 | 产物里所有文本文件的引用都能落到真实文件上 | Reference integrity |
| 4 | JS 语法 | 产物里所有 JS 都能解析 | JS syntax |
| 5 | HTML 结构 | 标签直方图与内联块数量与原文一致 | HTML structure |
| 6 | 跨文件全局 | 没有把被其他文件引用的全局改名或删除 | Cross-file globals |
| 7 | 体积单调 | 产物里没有比原文更大的文件 | Monotonic size |
| 8 | `Content-Type` | 扩展名协议都认识，manifest 声明与真实文件一致 | Content-Type |
| 9 | 图片尺寸 | 所有图片的像素尺寸保持不变（只换了编码） | Image dimensions |
| 10 | 单文件上限 | 没有文件超过协议 8 MiB 的上限 | Single-file limit |

- 失败态示例（真实文案，直接用于设计）：
  - 引用完整性 fail：`压缩后新增了 3 条断链：index.html → icons/logo.png；…`
  - HTML 结构 fail：``<div>` 直方图与原文不一致（原始 41 / 产物 39）`
  - 跨文件全局 fail：`NixieClock 在 clock.js 里被引用，但产物里找不到这个顶层名字`
- 折叠区：`这 10 项分别防什么？`（展开后是一段说明，见 §5.4）

**【English】** — names as in the table; outcomes:
- All pass: `All 10 checks passed`
- Warn: `1 check needs attention`
- Fail: `Failing — don't publish this yet`
- Section title: `Verification`

**【UI 备注】**
- 每项最多两行：第一行名称，第二行结论。结论过长时截断并可展开，**不要**把 8 条断链全塞进卡片。
- 图标三态用形状区分而不只靠颜色（✓ / ! / ✗）。
- 默认**折叠**这 10 项（只展示总结行），因为全通过的人不需要读它；有 fail 时**自动展开**。

#### S3-H 结果 · 明细（折叠区三段）

**【中文终稿】**

1. `改了什么（按体积）` — 逐文件 `图标 246,638 → 55,979（-77%）`，附做法标签 `调色板量化 q85 · 42.7 dB`
2. `没写进产物` — 每条：`17.4 KB  README.md —— 不是站点资源（文档 / 源码 / 映射）`；空态：`没有文件被剔除`
3. `保留的约定文件` — `robots.txt、favicon.ico、apple-touch-icon.png —— 没有 HTML 引用是正常的，它们靠约定路径被访问`
4. `改了文件名` — `icons/a.png → icons/a.webp（引用已同步重写）`
5. `还能再省` — `字体子集化  约 88 KB ≈ $0.85  可选，默认不做`（每条带 `how` 一行说明）

**【English】**

1. `What changed (by size)`
2. `Left out of the output`
3. `Convention files kept`
4. `Files renamed`
5. `Still on the table`

**【UI 备注】**
- 三段是 `<details>`，默认收起；标题行右侧显示条数与合计字节。
- 「还能再省」每条要有 `可选 / 默认不做` 标签，避免用户以为工具漏做了。

#### S3-I 错误态（逐条文案，全部要画）

| 场景 | 中文 | English | 下一步建议 |
| --- | --- | --- | --- |
| 没选任何文件 | `还没选文件。把站点目录拖进来，或者点「选择文件夹」。` | `Nothing selected yet. Drop your site folder, or hit "Choose a folder".` | 高亮拖拽区 |
| 目录里没有 `index.html` | `这个目录里没有 `index.html` —— 发布页会拒绝，站点打开就是 404。` | `No `index.html` in this folder — the publishing page will reject it, and the site would 404.` | 仍允许继续体检 |
| 文件总量超限 | `一次最多处理 16 MB / 2000 个文件。这个目录有 34 MB / 812 个文件。` | `Up to 16 MB and 2000 files per run. This folder has 34 MB across 812 files.` | 提供「排除目录」输入 |
| 单文件超 8 MiB | `3 个文件超过协议 8 MiB 上限，协议会静默跳过它们 —— 我们替你标出来了。` | `3 files exceed the protocol's 8 MiB limit and would be silently skipped — we flagged them.` | 列文件名 |
| 浏览器不支持 WebAssembly | `这个浏览器跑不了压缩运行时。换 Chrome / Edge / Safari 的新版本，或者用 CLI 版。` | `This browser can't run the shrink runtime. Use a recent Chrome / Edge / Safari, or the CLI.` | 给 CLI 一行命令 |
| 压缩过程出错 | `压缩过程中断了：<错误信息>` + `源目录没有被改动过，重新跑一次通常就好。` | `Shrinking stopped: <message>` + `Your source is untouched. Running again usually fixes it.` | 带 `复制错误详情` |
| 全部文件都被剔除 | `所有文件都被判定为「不是站点资源」，产物是空的。这通常是选错了目录。` | `Every file was judged "not a site asset", so the output is empty. This usually means the wrong folder was picked.` | 回到选择 |
| 浏览器内存不足 | `文件太大，浏览器内存不够了。试试分批，或者用 CLI 版跑整站。` | `Too much data for this tab's memory. Try a subset, or use the CLI for the whole site.` | 见 S10 |

**【UI 备注】** 错误一律**就地**出现在出错的区块内，不用 toast，不用 modal，不用红色满屏。

---

### S4 · 为什么「大就是贵」

**【中文终稿】**

- 小标题：`计费模型`
- H2：**协议不替你压缩。你传多少字节，就永久付多少字节的钱。**
- 正文：TapeCode 把站点**原样按路径**写进链上的容器合约，没有任何自动 gzip / brotli / WebP 转换。所以账单是死的：

| 常量 | 值 | 含义 |
| --- | --- | --- |
| `CHUNK_BYTES` | `24,000` | 每 24 KB 切一块，**一块 = 一笔交易** |
| `perChunk` | `270,000` gas | 每块固定开销（交易本身、目录槽位、事件） |
| `perByte` | `235` gas | **每一个字节**，永久 |
| 地板价 | `0.05 gwei`（BSC） | `gasPrice = max(地板价, min(实时价, 20 × 地板价))` |
| 单文件上限 | `8 MiB` | 超过的文件**静默跳过**，界面不报错 |

- 公式（大号等宽，视觉重点）：
  `gas ≈ 块数 × 270,000 + 字节数 × 235`
- 参考价（醒目）：**1 MB 纯数据 ≈ 0.0129 BNB ≈ $9.6** — 脚注 `BSC 地板价 0.05 gwei · BNB $747`
- 三条推论（三列卡片）：
  1. **多文件比大文件贵** — 块数是按文件各向上取整的。10 个 3 KB 的小文件 = 10 块 = 270 万 gas 的纯块开销，而它们总共才 30 KB。
  2. **只改一个文件，只花那一个文件的钱** — 同一路径 + 同一 `sha256` 会被跳过。但那个文件是**整份重传**，所以把一张 240 KB 的图换成 60 KB，省的是**每一次改版**的钱。
  3. **别把垃圾传上去** — `README.md`、`.map`、设计稿会照样按字节计费；隐藏文件（`.shots/`、`.DS_Store`）会被协议整个跳过 —— 有个站点的 `.shots/` 有 4.6 MB，一个字节都没上传。

**【English】**

- Eyebrow: `The gas model`
- H2: **The protocol does not compress for you. Every byte you upload is a byte you pay for forever.**
- Body: TapeCode writes your site, path for path, into an on-chain container contract. No automatic gzip, brotli or WebP. So the bill is fixed:
- Constant table (same values, EN meanings): `Chunks of 24,000 bytes — one chunk, one transaction` / `Fixed cost per chunk (the tx, the directory slot, the event)` / `Every single byte, forever` / `gasPrice = max(floor, min(live, 20 × floor))` / `Larger files are silently skipped; the UI says nothing`
- Formula: `gas ≈ chunks × 270,000 + bytes × 235`
- Reference price: **1 MB of raw data ≈ 0.0129 BNB ≈ $9.60** — `BSC floor 0.05 gwei · BNB $747`
- Three implications:
  1. **Many small files cost more than one big file** — chunks round up per file. Ten 3 KB files = ten chunks = 2.7M gas of pure per-chunk overhead for 30 KB of content.
  2. **Change one file, pay for one file** — same path + same `sha256` is skipped. But that file is re-uploaded in full, so turning a 240 KB image into 60 KB saves money on **every revision**.
  3. **Don't publish junk** — `README.md`, `.map` files and design exports are billed by the byte. Hidden files (`.shots/`, `.DS_Store`) are skipped entirely — one site had 4.6 MB in `.shots/` that never went up.

**【UI 备注】**
- 公式是这一屏的视觉中心，字号至少比正文大 2 级，等宽字体，可高亮 `235`。
- 常量表用等宽表格；`一块 = 一笔交易` 要能一眼看到。
- 三条推论做成三张等宽卡片，卡片内**加粗第一句**（就是上面加粗那句）。
- ⚠️ 币价相关文案必须带日期锚点。建议页面顶部或此处显示 `价格基准：2026-10 · BNB $747.31`，
  并在参数区改动后实时更新（用户改成 $900，参考价也要跟着变）。

---

### S5 · 功能说明（8 张卡）

> 每张卡：**图标 / 标题 / 一句话 / 证据行（小字、等宽、必须是真实数字或真实行为）**。
> 卡片顺序 = 使用顺序，不是重要性排序。

| # | 标题（中） | 标题（EN） | 一句话（中） | 一句话（EN） | 证据行 |
| --- | --- | --- | --- | --- | --- |
| 1 | 体检 | Checkup | 先说清楚「会被上传哪些文件、一共多少钱」，一个字节都不改。 | Tells you which files would go up and what they cost — without touching anything. | `scan` 只读；顺带列出协议会静默跳过的文件、断链、死文件、重复内容、`Content-Type` 问题 |
| 2 | 压缩 | Shrink | 文本压缩、图片重编码、剔掉白花钱的文件，全部默认安全档。 | Text minification, image re-encoding and dropping files that don't belong, safe by default. | 实测：`icon-512.png` 246,638 → 55,979（−77%）；`chain.js` 20,496 → 6,931（−66%） |
| 3 | 校验 | Verification | 压完自动对拍 10 项，`fail` 就不让你发布。 | Ten checks against the original. If one fails, don't publish. | 其中「跨文件全局」防的是：把 `clock.js` 暴露给内联脚本的 `NixieClock` 改名，站点会变成一堆 `ReferenceError` |
| 4 | 增量账单 | Incremental bill | 只改了一个文件？只算那一个文件的钱。 | Changed one file? Pay for one file. | 协议规则：同一路径 + 同一 `sha256` 跳过，变了的整份重传 |
| 5 | 预估 | Estimate | 「再加一张 2 MB 的图要多少？」先算钱，再决定传不传。 | "What would one more 2 MB image cost?" Price it before you upload it. | 纯计算，不用真的读文件 |
| 6 | 计费模型 | Gas model | 常量、公式、1 MB 参考价，全部摊开给你看。 | Constants, formula and the per-megabyte reference price, all exposed. | `24,000 B / 块`、`270,000 gas / 块`、`235 gas / 字节`、BSC 地板价 `0.05 gwei` |
| 7 | 三种形态 | Three shapes | 网页里点一下、命令行一行、或者让 AI agent 通过 MCP 调。 | Click in the browser, run one CLI line, or let an AI agent call it over MCP. | 网页版与命令行版走**同一份算法**，产物字节完全一致（有测试盯着） |
| 8 | 不原地改 | Never in place | 源目录只读，产物写到独立的 `.tape` 目录。 | Your source is read-only. Output goes to a separate `.tape` directory. | 端到端测试里有一条断言专门盯「源目录零改动」 |

**【UI 备注】**
- 8 张卡建议 4×2（≥1280 px）/ 2×4（768–1280）/ 1×8（<768）。
- 图标需要线性、工程感、不拟物；避免「盾牌 + 对勾」这类通用安全图标撞车（10 项校验卡用它即可）。
- 每张卡的**证据行是必须的**，它承担「凭什么信你」——不要为了留白砍掉。
- ⚠️ 第 1 张卡的证据行里 `Content-Type` 等术语可保留英文原词，不要翻译。

---

### S6 · 工作原理（4 步）

**【中文终稿】**
- H2：**四步，全部在本地完成。**
- 步骤：
  1. `扫描` — 按路径读一遍，算出会被上传的文件、字节数、块数、gas 和钱，同时标出协议会跳过的文件。
  2. `压缩` — 文本走压缩器（带「顶层名字不许改名」的守卫），图片按 PSNR 门限逐档试，选达到质量门限里最小的一档。
  3. `校验` — 10 项自动检查，产物与原文对拍：引用、全局名、`Content-Type`、图片尺寸、体积单调。
  4. `出账单` — 前后对比 + 省下的钱 + 这一版实际要多花多少，产物打包成 `.tape.zip` 下载。

**【English】**
- H2: **Four steps, all local.**
- Steps: `Scan` / `Shrink` / `Verify` / `Bill`，正文同上逐句对应（`Scan every path and price it…`, `Minify text with a "never rename top-level globals" guard; try image quality tiers down to the PSNR threshold and keep the smallest passing one`, `Ten automated checks diffed against the original`, `Before/after, money saved, this revision's delta, and the output zipped as .tape.zip`）.

**【UI 备注】**
- 4 步横向流程（移动端纵向）。第 3 步「校验」用不同色强调，它是产品的差异点。
- 每步配一个小示意（不是插画）：`文件 → 块`、`质量档梯度`、`对拍箭头`、`账单表`。

---

### S7 · 真实案例

**【中文终稿】**
- 小标题：`实测`
- H2：**一个真实站点，一轮优化，省掉一半。**
- 站点与条件：`super-lock（辉光管时钟 PWA）· 20 个文件 · BSC 地板价 0.05 gwei · BNB $747.31`
- 表格：即 §3.3 S3-F 的账单表（这里完整展开，不折叠）
- 钱省在哪（4 条，带做法）：
  - `icons/icon-512.png` **246,638 → 55,979（−77%）** — 同格式调色板量化（还是 `.png`，路径和引用都不动），逐档试 + 量 PSNR，落在 q85 / 42.7 dB
  - `icons/icon-maskable-512.png` **121,529 → 23,070（−81%）**
  - `chain.js` **20,496 → 6,931（−66%）**、`clock.js` **36,807 → 19,388（−47%）**、`sw.js` −47%、`pwa.js` −42%
  - `index.html` 保守档只省 3%；激进档（去属性引号 + 折叠空白 + 压内联 CSS/JS）能到 **−37%**（69,242 → 43,706），默认不开
- 一行收尾：`这就是「先体检再上链」和「直接点发布」的差距。`

**【English】**
- Eyebrow: `Measured, not promised`
- H2: **One real site, one pass, half the bytes.**
- Meta: `super-lock (a nixie-tube clock PWA) · 20 files · BSC floor 0.05 gwei · BNB $747.31`
- Then: `Where the money came from` with the four items above (`Same-format palette quantization — still a .png, same path, no reference changes; tried tier by tier and measured PSNR, landed at q85 / 42.7 dB`)
- Closing: `That's the gap between "check up first" and "hit publish".`

**【UI 备注】**
- 这屏的核心是**对比**：左边优化前、右边优化后，中间一条下滑箭头 / 收窄的条形。
- 图片前后对比**不要**放原图（2.7 MB 页面负担），用条形长度对比 + 数字。
- 每条都要有做法说明，否则数字不可信。

---

### S8 · 长期迭代最省（增量账单）

**【中文终稿】**
- 小标题：`长期成本`
- H2：**迭代成本不取决于站点多大，取决于每次改动的那几个文件多大。**
- 关键规则（引用块）：`同一路径 + 同一 sha256 的文件会被跳过；变了的文件整份重传。`
- 推论：一个 800 KB 的站点，如果每次只改一个 20 KB 的 JS，那每次部署只付那 20 KB。大静态资源（图片、字体）改一次之后就**永久免费**了 —— 它们是「一次性成本」，代码才是「每次成本」。
- 表格：三种策略跑 6 轮迭代

| 策略 | 6 轮累计 | 说明 |
| --- | --- | --- |
| A 不压缩 | **$10.39** | 源码原样传，改动按未压缩字节算 |
| **B 压缩 + 增量** | **$5.03** | 一直传压缩版，协议自动跳过没变的文件 |
| C 先不压缩、第 3 轮才改用压缩 | **$10.43** | 切换那一轮要全站重传，**反而比 A 还贵** |

- 三条建议：
  1. **第一轮就用压缩版。** 中途切换要付一次全站重传的代价，可能比一直不压缩还贵。
  2. **保持压缩参数不变。** 改了 `psnrTarget` 或激进档，受影响的文件会全部重传；想改先跑一遍增量账单。
  3. **优先压「反复改动」的文件。** 大图片是首付，`index.html`、主 JS 才是真正的每次成本。
- 两个意外好处：`只改注释不花钱`（压缩会去掉注释，产物字节不变 → 协议跳过 → 免费）；`换个未优化的图也可能免费`（新图压缩后与旧图产物一致）。

**【English】**
- H2: **Iteration cost doesn't scale with site size — it scales with the files you touch.**
- Rule: `Same path + same sha256 is skipped. Anything that changed is re-uploaded in full.`
- Table headers: `Strategy / 6 rounds / Notes` with `A No compression $10.39`, `B Compress + incremental $5.03`, `C Raw first, compress from round 3 $10.43`
- Three habits (same as above), plus `Two free lunches: comment-only edits ship zero changed bytes; and a new unoptimized image can compress to the same bytes as the old one.`

**【UI 备注】**
- 表格里 B 行必须视觉突出（推荐色块 + `BEST` 标签）。
- 策略 C 的「反而比 A 还贵」要用**价格差箭头**直接画出来（$10.43 > $10.39），这是这一屏的记忆点。
- CLI 一行示例可放在这屏底部：`deweb-shrink diff ./site_v2 --previous ./site_v1 --gas 0.05 --usd 750`

---

### S9 · 还能再省 & 诚实边界

**【中文终稿】**
- 小标题：`边界`
- H2：**我们不做的事，也写在页面上。**
- 列表（每条都是「不做什么 + 为什么 + 数字」）：
  1. **不做字体子集化** — 字体 176.5 KB，占优化后总体积 **44%**，是现在最大的一项。要压得重裁字形，但必须先有一条「页面用到的码位在新字体里都还在」的校验，否则会渲染成豆腐块。所以工具**只报数**：约还能再省 88 KB。
  2. **不直接发交易** — 工具只碰文件系统，不发交易、不签名。发布仍然走 TapeCode 自己的界面。
  3. **`.well-known/` 传不上去** — 路径段以 `.` 开头会被判为隐藏文件、静默跳过，所以在这个协议下域名验证、ACME 都用不了。
  4. **8 MiB 以上的文件界面不报错** — 协议静默跳过。我们会替你标出来，但发布页不会。
  5. **改了压缩参数 = 全站重传** — 参数一变，每个文件的字节都可能变，协议判定为全新内容。
  6. **死文件结论是保守的** — 只看静态引用，运行时拼出来的资源名只能靠 basename / 目录前缀兜底，宁可漏报也不误删。
  7. **图片质量门限是按 PSNR 量的** — PSNR 不是人眼模型，42 dB 只是「实测这几张图看不出差别」的位置，换站点建议调高再跑一次对比。
- 收尾：`一个不告诉你边界的压缩工具，不值得把站点交给它。`

**【English】**
- H2: **What we don't do is on this page, too.**
- 7 items as above: `No font subsetting`, `We never send a transaction`, `\.well-known/ can't be uploaded`, `Files over 8 MiB fail silently`, `Changing shrink parameters re-uploads the whole site`, `Dead-file detection is conservative`, `PSNR is not a model of the human eye`.
- Closing: `A shrink tool that hides its limits isn't one you should hand your site to.`

**【UI 备注】**
- 这屏故意用**弱化配色**（低饱和），不要做成警告黄色块——它是「职业诚实」，不是「风险提示」。
- 每条左侧可放一个小的 `不做` / `SKIPPED` 标签。
- 与 S5 的卡片区分：这是列表，不是卡片，避免和功能说明抢视觉。

---

### S10 · 三种用法（Tab）

**【中文终稿】**
- H2：**网页里点一下，命令行一行，或者交给 agent。**
- Tab 1 `网页版（本页）`：`零安装。文件不出本机。图片只做无损重压 —— 需要调色板量化就往下看。`
- Tab 2 `命令行`：

```bash
npm install && npm test          # 98 个测试，含端到端与链上实测对拍
node src/cli.js model            # 打印计费模型
node src/cli.js scan     ..      --exclude deweb-shrink,.shots
node src/cli.js optimize ..      --exclude deweb-shrink,.shots --out ../site.tape
node src/cli.js diff     ./v2    --previous ./v1 --gas 0.05 --usd 750
```

- Tab 3 `MCP（给 agent 用）`：`一个 MCP server，六个工具：cost_model / scan / estimate / optimize / verify / diff。本地 stdio、服务器 Streamable HTTP 两种形态。`
  - 说明：`接入文档、限额、错误对照表都在文档里。服务端形态要 API key，请放在服务端 —— 不要写进前端代码。`
  - 链接：`查看接入说明` / `复制 agent 提示词`

**【English】**
- H2: **Click here, run one line, or hand it to an agent.**
- Tabs: `Web (this page)` / `CLI` / `MCP (for agents)` with the same bodies; CLI block unchanged; MCP text: `One MCP server, six tools: cost_model / scan / estimate / optimize / verify / diff. Runs locally over stdio or on a server over Streamable HTTP.` + `The server build needs an API key — keep it server-side, never in front-end code.`

**【UI 备注】**
- 代码块必须有复制按钮，且支持横向滚动不换行。
- Tab 切换要保留 URL hash（`#use-cli`），方便直接发链接给别人。
- 三个 Tab 的内容高度差很大，容器高度按最高者固定，避免切换时页面跳动。

---

### S11 · FAQ（11 条，折叠）

| # | 问题 | 答案要点 |
| --- | --- | --- |
| 1 | 我的文件会上传到你们的服务器吗？ | 网页版全程在本机浏览器里跑（WebAssembly），一个字节都不发出去。服务端形态（MCP）是另一套入口，需要你显式把文件传给它。 |
| 2 | 协议不是会自动 gzip 吗？ | 不会。站点原样按路径写进链上容器合约，没有 gzip / brotli / WebP 转换。所以「少传字节」是唯一的省钱手段。 |
| 3 | 会不会把我的站点压坏？ | 默认安全档只改编码、不改路径、不改引用；压完跑 10 项校验，`fail` 会明确告诉你别发布；源目录全程只读，产物另存。 |
| 4 | 为什么我改了参数，费用反而变高了？ | 协议按「路径 + sha256」判断是否跳过。改了压缩参数，几乎每个文件的字节都变，会被当成全新内容整站重传。 |
| 5 | 为什么 8 MiB 以上的文件界面不报错？ | 这是协议行为：超限文件被静默跳过。我们会替你标出来，发布页不会。 |
| 6 | 为什么 `.well-known/` 传不上去？ | 路径段以 `.` 开头会被判为隐藏文件、静默跳过。所以在该协议下域名验证、ACME 都用不了。 |
| 7 | 字体这么大，能压吗？ | 现在不能自动压。字体子集化需要先有「码位覆盖」校验，否则会渲染成豆腐块；工具只报数（实测约还能省 88 KB）。 |
| 8 | 会替我发交易吗？ | 不会，也不签名。工具只出账单、产物和校验结论，发布仍走 TapeCode 界面。 |
| 9 | 网页版和 CLI / MCP 版结果一样吗？ | 算法是同一份代码，账单数字必然一致；差别在图片档位——网页版走无损重压，服务器版走调色板量化，后者收益更大。 |
| 10 | 支持哪些链？ | BSC / X Layer / Base，计费公式相同，只有 gasPrice 地板价与币种不同。 |
| 11 | 要不要注册、要不要钱？ | 网页版不需要注册、不需要 key；服务端 MCP 形态需要 API key，并且有体积 / 并发 / 超时限制。 |

**【English】** 逐条对应，问题用：`Do my files get uploaded?`、`Doesn't the protocol gzip for me?`、`Can this break my site?`、`Why did changing a setting cost more?`、`Why doesn't the UI complain about files over 8 MiB?`、`Why can't I upload `.well-known/`?`、`My fonts are huge — can you shrink them?`、`Will it send transactions for me?`、`Do the web and CLI builds agree?`、`Which chains are supported?`、`Do I need an account or a key?`

**【UI 备注】**
- 单列手风琴，一次只展开一条（也可以允许多条，但需统一）。
- 展开/收起要有 150–200 ms 过渡，且箭头旋转。
- 第 1、3、8 条是信任问题，**建议默认展开第 1 条**。

---

### S12 · 页脚

**【中文终稿】**
- 品牌 + 一行简介：`DeWEBShrink · 给链上站点做上链前体检与压缩。`
- 列：`产品`（在线体检 / 功能 / 工作原理 / 案例）、`接入`（CLI / MCP / 接入文档 / agent 提示词）、`项目`（版本 v0.3.0 / 变更记录 / 问题反馈）
- 免责声明（小字，必须）：`页面上的费用为按当前 gasPrice 与币价估算的结果，实际以发布页为准；币价与网络拥堵会改变最终金额。本工具不发送交易、不保存你的文件。`
- 底部：`© 2026 DeWEBShrink` + 语言切换（与顶部同步）

**【English】**
- `DeWEBShrink · Check up and shrink a site before it goes on-chain.`
- Columns: `Product` / `Get started` / `Project`
- Disclaimer: `Costs shown are estimates based on the current gas price and token price; the publishing page is authoritative. Network conditions and prices change the final amount. This tool sends no transactions and stores none of your files.`
- `© 2026 DeWEBShrink`

**【UI 备注】**
- 免责声明**不能**做成需要 hover 才可见的 tooltip。

---

## 4. 核心组件的状态清单（设计必须逐态出稿）

| 状态 | 触发 | 页面表现 | 关键文案 |
| --- | --- | --- | --- |
| `idle` | 首次进入 | 拖拽区 + 参数摘要 + 主按钮禁用 | `把站点目录拖到这里` |
| `dragover` | 拖动悬停 | 边框实线 + 变色 + 轻微放大 | `松开就开始了` |
| `picked` | 已选目录 | 显示目录名 / 文件数 / 总字节，主按钮可用 | `已选择：super-lock · 20 个文件 · 783 KB` |
| `runtime-loading` | 首次点击后 | 进度条第 1 段 + 加载说明 | `加载压缩运行时…`（附 12 MB 首次说明） |
| `scanning` | 扫描中 | 进度条第 2 段 | `扫描站点、算账单…` |
| `optimizing` | 压缩中 | 进度条第 3 段 + 当前文件名 | `压缩中… 8 / 20` |
| `verifying` | 校验中 | 进度条第 4 段 | `校验产物…` |
| `done-pass` | 全部通过 | 账单 + 三个大数字 + 10 项全绿 + 下载可用 | `省下 $3.62` |
| `done-warn` | 有 warn | 同上，校验区标黄，其余正常 | `校验 · 1 项需要注意` |
| `done-fail` | 有 fail | 校验区自动展开、下载降级为「仍然下载」并在旁边警告 | `校验 · 有失败项，先别发布` |
| `error-*` | 见 §3.3 S3-I 的 8 种 | 就地内联错误，不弹窗 | 见上表 |
| `busy-again` | 结果页再改参数 | 参数改动提示「改了参数要重跑」，不清空旧结果 | `参数已改动，重新跑一次会得到新的账单` |

**结果页固定操作**：`下载 .tape.zip`（主）、`复制 JSON`（次）、`展开完整报告`（次）、`重新体检`（次）。

**微文案细节**
- 复制成功：`已复制 ✓`（1.5 s 后还原为 `复制 JSON`）
- 下载中：`正在打包…`
- 下载完成：`已下载 super-lock.tape.zip`
- 参数变化但未重跑：`参数已改动，重新跑一次会得到新的账单`（不要自动重跑）
- 结果页顶部条件行始终显示：`BSC · gasPrice 0.05 gwei · BNB $747.31 · 安全档`

---

## 5. 数字、格式化与数据规范

### 5.1 格式化

| 类型 | 规则 | 示例 |
| --- | --- | --- |
| 字节 | < 1 KB 用 B；< 1 MB 用 KB（1 位小数）；≥ 1 MB 用 MB（2 位小数） | `801,960 B` → `783.2 KB` → `1.46 MB` |
| 千分位 | 一律加分隔符（en-US 逗号） | `200,880,600` |
| gas | 整数 + 千分位 | `96,993,175` |
| 币 | 6 位小数 + 币种符号 | `0.001850 BNB` |
| 美元 | 2 位小数 + `$` | `$3.62` |
| 百分比 | 省下用 1 位小数，不加 `+`；减少用 `−`（真减号） | `−49.0%`、`−77%` |
| 时间 | `< 1000 ms` 显示毫秒，否则 `1.8s` | `完成 · 1.8s` |

### 5.2 数字必须带条件

任何金额周围 200 px 内必须能找到 `gasPrice` + 币价 + 链。参考价（`1 MB ≈ $9.6`）必须带
`BNB $747` 与日期基准。参数区改动后，页面上**所有**金额（Hero 数字除外，Hero 是历史实测快照）实时重算。

### 5.3 静态数字的出处（设计不需要改，但不要被「优化」掉）

| 页面数字 | 出处 |
| --- | --- |
| `801,960 → 408,755`、`$7.51 → $3.88`、`−49%`、`$3.62` | README §2 super-lock 实测 |
| `1 MB ≈ 0.0129 BNB ≈ $9.6` | README §1（BSC 地板价 · BNB $747） |
| `$10.39 / $5.03 / $10.43` | README §6 六轮迭代实测 |
| 字体 176.5 KB / 44% / 约 88 KB | README §2「还剩什么没省」 |
| `.shots/` 4.6 MB 未上传 | README §1 |
| 10 项校验 | `src/verify.js`（10 个 `add()`） |
| `24,000 / 270,000 / 235 / 0.05 gwei / 8 MiB` | `src/protocol.js` |

### 5.4 「10 项分别防什么」展开文案（给 S3-G 用）

| 校验 | 防的是什么事故 |
| --- | --- |
| 入口 `index.html` | 产物没有入口，发布页拒绝或打开就 404 |
| 协议合法性 | 上传了隐藏文件 / 非法路径 / 超限文件，白花 gas 或整份被跳过 |
| 引用完整性 | 压缩改了路径却没同步引用，线上必然 404 |
| JS 语法 | 压缩把 JS 压成了语法错误 |
| HTML 结构 | 压缩改变了标签与内联块结构 |
| 跨文件全局 | 把内联脚本依赖的全局名（如 `NixieClock`）改名，站点变成一堆 `ReferenceError` |
| 体积单调 | 压缩产物比原文还大（应当一律回退） |
| `Content-Type` | `manifest` 声明的图标类型与实际文件不一致 |
| 图片尺寸 | 重编码顺手改了像素尺寸 |
| 单文件上限 | 有文件超过协议 8 MiB 会被静默跳过 |

（开发过程中这套校验当场抓出过两个真 bug：转 WebP 时字节写在新文件名下、引用却指向旧名；
`manifest.webmanifest` 的 `icons[].type` 没跟着扩展名改。可以在页面上作为「校验不是装饰」的佐证一句带过。）

---

## 6. 文案禁区（不要写进设计稿）

| 禁止 | 原因 |
| --- | --- |
| 「上传你的站点」「我们的服务器会处理」 | 网页版本地跑，说了就是假话 |
| 「自动 gzip / brotli 压缩」 | 协议不做，说反了 |
| 「保证省 X%」「最高压缩 90%」 | 只有实测值，没有保证值 |
| 「一键发布 / 自动上链」 | 工具不发交易、不签名 |
| 「支持所有链 / 所有资源类型」 | 目前 BSC / X Layer / Base；字体不压 |
| 「及时发现线上问题 / 监控」 | 工具是上链前的，不做运行时监控 |
| 「压缩是智能 AI 优化」 | 是确定性算法 + PSNR 门限，不要蹭 AI |
| 「已服务 N 个用户 / N 个站点」 | 没有这个数据 |
| 任何没有脚注的金额 | 见 §5.2 |

---

## 7. 资产清单（设计需要产出）

| 资产 | 数量 | 说明 |
| --- | --- | --- |
| 页面设计稿 | 1 页 × 2 语言 | 中文为基准，英文需校对断行与按钮宽度 |
| 核心组件状态 | 12 态 | §4 表格逐态 |
| 表格组件 | 3 种 | 账单表（3 行）、明细表（N 行）、常量表（键值） |
| 校验列表 | 3 状态 | 全绿 / 有 warn / 有 fail |
| 错误内联态 | 8 种 | §3.3 S3-I |
| 图标 | 8 + 6 | 功能卡 8 个 + 流程/状态 6 个（线性、1.5–2 px 描边、24 px 网格） |
| 示意图 | 3 张 | ① `字节 → 块 → 交易` 计费示意 ② 4 步流水线 ③ 增量重传示意（哪些文件会被重传） |
| 图片对比图 | 1 张 | 用条形长度对比，**不要**放原图 |
| OG / 社交卡 | 2 张 | 中英各一，文案见 §9.4 |
| Favicon | 1 套 | 建议直接用产品字标首字母 `D`，注意别和产品自身的图标风格冲突 |
| 空态插画 | 0–1 张 | 建议**不用**插画，用「虚线框 + 一行提示」即可，保持工程感 |

---

## 8. 给设计的交付清单（Definition of Done）

1. 桌面（1440 / 1280）、平板（1024 / 768）、手机（390）四档，每种都要有 `idle` 与 `done-pass` 两个状态。
2. 英文版至少覆盖 Hero、S3 全部状态、S5、S11；其余区块给文案替换规则即可。
3. 表格在 390 px 下的横向滚动/隐藏列行为要有明确稿。
4. 所有交互态（hover / focus / active / disabled / loading）至少给按钮、输入、Tab、折叠项四类。
5. 深浅色：**待确认**（§10 Q5）。若只做浅色，请确保账单表在浅色下仍有足够层级。
6. 颜色对比度：正文 ≥ 4.5:1，等宽小字 ≥ 4.5:1（脚注很多，别用浅灰 `#999` 糊过去）。
7. 焦点态可见（键盘可完整走通：拖拽区 → 选择文件夹 → 参数 → 运行 → 下载 → 复制）。

---

## 9. 国际化、无障碍与性能注意

### 9.1 语言切换

- 默认按浏览器语言：`zh*` → 中文，其他 → English。
- 切换写进 URL（`?lang=en` 或 `/en`），刷新保持；给 `<link rel="alternate" hreflang>`。
- 切换**不重载数据**：账单、校验结果、文件名全部保持。
- 英文比中文长 30–50%：`开始体检 + 压缩` → `Run checkup + shrink`；按钮不要定死宽度。
- 数字与单位不本地化（`0.001850 BNB` 保持），日期用 `2026-10` 这种无歧义格式。

### 9.2 无障碍

- 进度用 `aria-live="polite"` + `role="status"`，**只在阶段切换时更新**。
- 账单表用真 `<table>`，带 `<caption>`（`优化前后费用对比`）；`省下` 行用 `aria-label` 说明。
- 拖拽区同时是 `<label>` 包裹的按钮，键盘可 `Enter` 触发文件选择。
- 校验三态不能只靠颜色（✓ / ! / ✗ + 文案）。
- `html[lang]` 随语言切换更新。

### 9.3 性能（会直接影响视觉）

- 首次进入**不要**预加载 12.3 MB 的 `esbuild.wasm`：等用户点击或拖入后再加载，期间展示 §3.3 S3-E 的加载态。
- `worker.js` 2.2 MB 同样是首次成本；建议用 `module` worker + `preload` 提示，并在文案里明说「只在第一次下载」。
- 页面自身要轻：Hero 不用大图、不用视频背景（这个产品的读者对性能数字极其敏感，
  一个 2 MB 的首图会把「省字节」的说服力抵消掉）。
- 建议 Lighthouse 移动端性能 ≥ 90，并把截图放在内部评审里（不作为页面内容）。

### 9.4 SEO / 分享

- `<title>`：`DeWEBShrink · 上链前给站点做一次体检` / `DeWEBShrink — check up your site before it goes on-chain`
- `description`：`链上按字节永久计费。扫描站点，算出上链要花多少钱、能压掉多少、这一版改完要多花多少。文件不出本机。`
- OG 文案：`−49% / 一个真实站点的实测` + `免费 · 文件不出本机`
- 分享图不要放具体金额（币价会变），放体积对比。

---

## 10. 待确认（上线前必须由人拍板）

| # | 问题 | 影响 |
| --- | --- | --- |
| Q1 | 网页版是否上线为**正式功能**（不只是 PoC）？ | 决定 S3 是否进首版设计稿。目前 `poc/web/` 已经跑通同一条代码路径 |
| Q2 | 是否允许「服务端模式」（把文件发给服务器换取更强的图片压缩）？ | 若要，必须新增显式开关、隐私说明、key 不能进前端；S3-C 的档位设计要重做 |
| Q3 | 首版网页版是否包含**激进档 / WebP 转换**？ | 目前浏览器端只有 PNG 无损重压；激进档与格式转换尚未接进网页版。不包含就要在 UI 上明确「即将支持」，不能画成可用 |
| Q4 | Hero 的主 CTA 是「拖进来立刻体检」还是「先看案例」？ | 取决于网页版是否上线（Q1） |
| Q5 | 做不做深色模式？ | 影响所有色板与表格层级 |
| Q6 | 币价与 gasPrice 是否接实时源（CLI 侧有多源取价：binance-data → binance → coingecko → coinbase）？ | 接了就自动填，不接就靠用户手填 + 显示基准日期 |
| Q7 | 站点域名与品牌是否用 `DeWEBShrink` 这个拼写（注意 `DeWEB` 三处大小写）？ | 字标与 OG 图 |
| Q8 | 页面上是否出现 `yutingprod.com` 这个 MCP 端点？ | 若出现，等于公开服务入口；是否需要申请流程 |
| Q9 | `README.md` §7 写「files.js 默认一个都不删」，但代码默认是 `dropUnreferenced: true` + `dropNonSiteFiles: true`（默认会删无引用与非站点文件）。**页面文案以代码默认值为准**（即「默认剔除」），README 那句待修正 | S3-C / S5 卡 2 的措辞 |

---

*文档版本：v1 · 2026-10-12 · 依据：`README.md`、`src/protocol.js`、`src/verify.js`、`src/optimize/index.js`、`poc/web/`、`docs/using-the-mcp.md`*

