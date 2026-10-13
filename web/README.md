# 官网（`web/`）

DeWEBShrink 的官网页。**设计稿是唯一真相源**：页面结构、文案、颜色、字号、间距全部由
`web/design/DeWEBSharink.pen` 生成，不手写。

```
web/
  design/DeWEBSharink.pen       设计稿（Pencil v2.20，1440 宽，三个 frame：
                                中文桌面 / 英文桌面 / 390 手机版）
  design/shaders/*.glsl         设计稿的 shader 填充（打孔带 / 网格 / CRT 扫描线）
  design/icons/*.svg            设计稿用到的 lucide 图标（ISC，见 icons/LICENSE）
  design/faq-extra.json         设计稿只展开了 FAQ 第 1 条，其余 10 条答案在这里补齐
  design/copy.zh|en|m.txt       文案清单（构建时自动生成，便于校对）
  src/site.js                   页面行为 + 在线体检（手写源文件）
  src/site.css                  状态 / 交互 / 响应式 / shader 的 CSS 等价实现（手写）
  tools/pen-to-site.mjs         设计稿 → index.html + en/index.html + m/index.html + assets/pen.css
  tools/build-tool.mjs          打包 site.js、压缩 Worker 与两个 wasm 到 assets/
  tools/verify-site.mjs         验收：CDP 驱动，真跑一遍体检（桌面 + 手机各一次）+ 55 项断言
  tools/shots.mjs               按区块截图，--lang=zh|en|m（对照设计稿用）
  serve.mjs                     本地服务器（含示例站点与文档只读口子）
  assets/                       全部是生成物，已被 .gitignore 忽略
```

三个页面：`/`（中文桌面）、`/en/`（英文桌面）、`/m/`（390 手机版）。
桌面页在小屏（≤720px）会自动跳到 `/m/`；`/m/` 的菜单里有「桌面版」可以跳回来。

## 构建与运行

```bash
npm run site:build          # 设计稿 → 页面 + 样式 + 运行时（assets/ 约 13 MB，含 esbuild.wasm）
npm run site:serve          # http://127.0.0.1:5240/  （/en/ 是英文页）
npm run site:verify                  # 40 项验收（需要先起 serve）
npm run site:shots                   # 按区块截图到 /tmp/deweb-shots
node web/tools/shots.mjs --run-demo  # 先点「试用示例站点」跑一遍，再截图（看结果态）
```

改设计稿之后**只需要重跑 `npm run site:build`**，不要改 `web/index.html`、`web/en/index.html`、
`web/assets/pen.css` —— 它们下次生成会被覆盖。

## 生成器怎么工作

`.pen` 是 JSON，节点类型只有 frame / text / rectangle / ellipse / icon，且完全是 auto-layout
（layout 父节点里的子节点不带 x/y），所以能一比一映射成 flexbox：

| 设计稿 | 生成的 CSS |
| --- | --- |
| `layout: "vertical"` | `display:flex; flex-direction:column` |
| 有子节点但没 `layout` | `display:flex`（横向） |
| `width: "fill_container"` | 行内 `flex:1 1 0`；列内 `width:100%` |
| `gap` / `padding` / `justifyContent` / `alignItems` | 同名 flex 属性 |
| `stroke` + `strokeWidth`（数字或 `{top,left,…}`） | `border` / `border-top` … |
| `fill` / `cornerRadius` / `clip` | `background-color` / `border-radius` / `overflow:hidden` |
| `innerRadius` 的 ellipse | 圆环（选中态）或 1px 细圈（未选中态） |
| `icon` + `library: lucide` | 内联 lucide SVG |
| `fill: {type:"shader", url, uniforms}` | `data-shader` + 行内 CSS 变量，图案由 site.css 精确等价 |
| `layoutPosition: "absolute"` | `position:absolute; left/top`，父级自动加 `position:relative` |
| `type:"ref"`（组件引用） | 取出 reusable 定义按引用处重画一遍（如 Cassette） |
| `fontFamily: $display / $pixel` | Press Start 2P / VT323（Google Fonts） |

**shader 为什么不用 WebGL**：三个 `.glsl`（perf 打孔带、tape-grid 网格、crt-scan 扫描线）
都是轴对齐的条纹/网格，CSS 的 `repeating-linear-gradient` 能精确等价。打孔带在一页里出现
11 次 —— 每个实例开一个 WebGL 上下文会撞上浏览器的上下文上限，纯装饰不值得。
uniforms（`u_cell` / `u_alpha` / `u_gridStrength` …）由生成器从 `.glsl` 头部的 `@default`
读出来，再被设计稿里的实际取值覆盖，写进行内 CSS 变量。

样式按**声明串去重**：276 条规则覆盖两页两千多个节点。文案里的 `&`/`<`/`>` 会被转义
（设计稿里有一句 `<div> 直方图…`，不转义会当场破版）。

生成器还负责几件「设计稿没说、但页面必须有」的事，全部有断言兜底：

- **hook 校验**：65 个交互/动态节点按 name 路径匹配，中英文页各自命中数必须等于预期，
  少一个就构建失败（`vim` 里改坏一个节点名字会被立刻发现）。
- **去掉给开发看的备注**：`下一步：…`、`默认收起`、`错误态 · 就地内联…`、浮动 CTA 的
  `滚过首屏后出现…` —— 这些是设计稿里的批注，不上线。
- **语义**：区块 → `<section id>`、标题 → `<h1>/<h2>`、导航与页脚文本 → `<a>`、
  按钮 → `<button>`、目录选择 → `<label>` + 真 file input。
- **补 FAQ 答案**：其余 10 条按第 1 条的排版克隆出来（样式来自设计稿本身）。
- **表格列宽**：设计稿里有几张表只有最后一列是 `fill_container`，前面的列没给宽度，
  auto-layout 下会各自 hug、列与列不对齐。生成器按内容量出前导列宽度写成行内 `style`
  （只对「没给宽度」的列生效，给了 `fill_container` 的列不动）。

## 相对设计稿的主动修正（都是为了「设计稿没画、但页面必须有」）

1. **计费模型那张常量表**：设计稿只给最后一列 `fill_container`，前导列没宽度 →
   auto-layout 下列会挤在一起。生成器按内容量出列宽写成行内 `style`（只对没给宽度的列生效）。
2. **一排卡片的等高**：设计稿没写高度，auto-layout 下卡片底部参差；对
   「子节点全是 `fill_container` 的 frame」的行拉成 `align-items: stretch`。
3. **语言开关**：设计稿里两个按钮都画成选中态，站点按当前语言收口，永远只有一个高亮。
4. **手机版的「运行中 / 账单」**：设计稿把这两块画成了独立区块，站点里它们是**状态页**
   （默认隐藏，跑完才出现）—— 和之前确认过的「按真实产品行为」一致。
5. **手机版菜单抽屉、计算条件展开面板**：设计稿只给了汉堡按钮和一行摘要 + chevron，
   抽屉和面板按设计稿的色板/等宽字体补的（不加就没法导航、没法改参数）。

另外加了一行设计稿没有的入口：拖拽区里的 **「试用示例站点 · super-lock」** 链接
（`/demo-site.json`），让访客不用选目录也能跑一遍，也方便验收脚本做端到端断言。
不需要就删掉 `web/src/site.js` 里 `demoBtn` 那一段。

## 磁带机的动态行为

设计稿用「磁带录音机」当隐喻，并且画了 REC 灯、VU 电平表、`00:30` 计数器、
`TAPE-001 / SIDE A` 模块、走带键、`CNT` 计数。站点把它们接上了真实状态：

| 元素 | 行为 |
| --- | --- |
| REC 灯 | 运行中闪烁（其余状态常亮/熄灭） |
| VU 电平表 | 运行中跳动 |
| `00:30` / `CNT 0030` | 未跑时显示设计稿的样值；一旦开跑就改成实时走时与已处理文件数 |
| 走带键 ▶ / ■ | ▶ = 开始体检，■ = 复位（worker 已经在跑的任务不会被打断，只是不再等它） |
| 状态行 | `SITE AUDIT · RUNS LOCALLY / RUNNING / DONE / HALTED` + 用时 |

## 在线体检是什么在跑

页面里的 Worker 就是 `poc/web/worker.js`，走的是 **`src/` 的同一套算法**（构建期把
`node:crypto` 换纯 JS sha256、`sharp` 换 oxipng WASM、`esbuild` 换 esbuild-wasm）。
所以网页算出来的 gas / 美元与 CLI、MCP 必然一致。文件全程在本机内存里，一个字节不发出去。

限制（页面上也写了）：浏览器版图片只做**无损重压**（oxipng），要调色板量化（实测图标 −77%）
得走 CLI / MCP；`esbuild.wasm` 12.3 MB，首次使用才下载，之后走浏览器缓存。

## 验收覆盖

`web/tools/verify-site.mjs`（55 项，全绿才算过）：

- 结构：标题、12 个区块、导航锚点、默认隐藏的块确实不显示、gasPrice 是真输入框
- 端到端：点示例站点 → Worker 真跑 → 账单表/三个大数字/10 项校验被填上真实值，
  「优化后 < 优化前」、gas 列是数字、页面里没有 `[object Object]`
- 交互：FAQ 手风琴、三种用法 Tab、展开完整报告、浮动 CTA、粘性导航
- 双语：`/en/` 文案与隐藏块一致、语言开关只有一个高亮
- shader / 磁带机：`data-shader` 三个都在、打孔带真的有背景图、REC/VU/计数器/走带键在位、
  像素字体已加载、TRK 眉标在
- 手机版 `/m/`：6 个区块、「运行中 / 账单」默认隐藏、**用 CDP 塞真实文件进 input 跑一遍**
  （不是模拟点击），跑完状态页正确切换、账单是真实数字、不能横向滚动
- 控制台零未捕获异常

## 部署注意

- **静态托管即可**，但 `assets/esbuild.wasm` 必须用 `application/wasm` 提供（`serve.mjs` 已配对）。
- 三个页面都是静态的；`/m/` 靠 JS 判断小屏跳转，禁掉 JS 时桌面页在手机上也能看（响应式兜底）。
- `/demo-site.json`、`/demo-site/*`、`/docs/*`、`/README.md` 是**本地开发口子**：
  线上要么一起提供（示例站点 852 KB），要么把示例入口和页脚里的文档链接改掉。
- 页头导航的「查看文档」指向 `/docs/using-the-mcp.md`；线上建议换成真正的文档站。
- 字体走 Google Fonts（JetBrains Mono + Noto Sans SC），有完整 fallback；要离线就自托管。
- **不要**在前端放 MCP 的 API key（`docs/using-the-mcp.md` 里有同样的警告）。

## 设计稿改动后的同步

改完设计稿只需要重跑 `npm run site:build`：

- **新增/改名的交互节点**：生成器会直接构建失败并列出是哪条 hook 对不上，
  按提示改 `web/tools/pen-to-site.mjs` 的 `HOOKS` 表（第三项是「这套 hook 在哪几个页面」）。
- **设计稿引入新东西**（新节点类型 / 新属性 / 新图标 / 非变量取色）：预检会当场列出来，
  不会装作渲染成功 —— 之前踩过：语言开关两个按钮都画成选中态，页面「看起来没问题」但是错的。
- **中英文进度不一致**：构建日志会列出「英文帧比中文帧少哪几类节点」，方便对照补齐。
- **新图标**：`web/design/icons/` 里没有的会被点名，从 lucide 拿同名 svg 放进去即可。
