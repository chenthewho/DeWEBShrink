# 纯前端压缩 Demo（PoC）

**在浏览器里把「去中心化站点上链前的体检 + 压缩 + 算账」跑完**：没有服务器、没有 API key、
文件不出本机、断网也能用。算法就是 `src/` 里那一份，所以账单口径与 CLI / MCP **完全一致**。

## 怎么跑

```bash
cd deweb-shrink
npm ci                      # 首次
npm run fixtures            # 首次：生成 fixtures/（示例站点 07-real-site 在里面）
npm run poc:build           # 打浏览器包 → poc/web/dist/
npm run poc:serve           # → http://127.0.0.1:5233/
```

打开页面后两种用法：

1. **一键试用示例站点**（`fixtures/07-real-site`，21 个文件 / 812 KB）——不用准备文件；
2. **拖入自己的站点目录**（或点「选择一个目录」）。

勾选框决定要不要做图片无损压缩；`gasPrice` 与 `BNB 价格` 可以改（默认 BSC 地板价 0.05 gwei / $750）。
结果给三样东西：账单三行表（前/后/省下 × 文件数/字节/块/gas/BNB/USD）、10 项校验、`<名字>.tape.zip` 下载。

## 三层验证（都是可复跑的）

| 命令 | 验什么 | 结果 |
| --- | --- | --- |
| `npm run poc:parity` | **浏览器流水线 vs 原生流水线**（同在 Node 里跑，图片关） | 18/18 ✓ |
| `npm run poc:test` | **浏览器产物包**（`poc/web/dist/worker.js`）在 Node 里跑 | 15/15 ✓ |
| `npm run poc:test:browser` | **真·无头 Chrome** 打开页面跑完整流程并对拍 | 16/16 ✓ |

用示例站点（21 文件 / 831,130 B）量到的结论：

- 扫描账单：831,130 B / 48 块 / **208,275,550 gas** —— 浏览器与 CLI 分毫不差；
- 压缩后：723,567 B / 43 块 / **181,648,245 gas**（图片关），**19 个产物 sha256 逐字节一致**（含 HTML）；
- 图片开（oxipng 无损）：723,567 B → **680,671 B**，图片像素尺寸校验 pass；
- CLI 版对照：同样输入用 libimagequant 调色板量化是 **398,127 B** —— 差别只在图片编码器。

## 结构

```
poc/
  pipeline.js          复用 src/ 的算法层（浏览器与 Node 同一条路径）
  build.mjs            打包：--target=browser | node（所有 alias 都在这）
  parity.mjs           对拍：浏览器流水线 vs 原生 sharp/esbuild
  test-bundle.mjs      在 Node 里跑浏览器产物包
  test-headless.mjs    无头 Chrome 端到端（含阶段埋点，失败能定位到步）
  serve.mjs            本地静态服务（.wasm MIME、示例站点路由、测试口子）
  web/                 index.html / main.js / worker.js / styles.css（+ test.html 给无头用）
  shims/               见下表
```

### 替换了什么（这是「浏览器能跑」的全部秘密）

| 原依赖 | 浏览器替身 | 说明 |
| --- | --- | --- |
| `sharp`（libvips 原生） | `shims/images-browser.js`：`@jsquash/oxipng` 无损 + 图片头解析 | **只做无损**，量化未搬（见「局限」） |
| `esbuild`（原生二进制） | `esbuild-wasm` 同版本（0.25.12） | 同版本 Go→WASM，产物逐字节一致 |
| `node:crypto` | `shims/node-crypto.js`：纯 JS sha256 | 同步 API 兼容（代码里是同步用法） |
| `node:path` / `node:fs[-promises]` | `shims/node-path.js` / `node-fs*.js` | 本地目录形态才用；浏览器只走内存源/槽 |
| `url` / `http` / `https` | `shims/node-net.js` | 只被 clean-css 的可选加载路径 require |
| 全局 `Buffer` | `buffer` 包 + `inject` | 保证 base64 / UTF-8 字节数与 Node 一致 |
| 全局 `process` | `shims/process-global.js` | **必须有**：html-minifier-terser 读 `process.*`，缺失会让 HTML 静默不压 |

## 局限（诚实清单）

- **图片只做无损**（oxipng）。CLI/MCP 用 libimagequant 调色板量化，示例站点能到 398 KB；
  浏览器版只能到 ~681 KB。要补这块得把量化 WASM 也搬进来（`libimagequant`/`pngquant` 的 WASM），
  或者接受「图片交给 CLI，网页版先看账单」。
- **JPEG / WebP 重编码未做**（`optimizeJpeg: false`、`convertImages: false`）。
- 图片**多线程**路径（jSquash 的 `wasm-bindgen-rayon`）需要 `COOP/COEP` 响应头才启用；
  本地静态服务没发，所以走单线程（够快，但不吃满多核）。
- **Safari 不能写回目录**：Chromium 的 `showDirectoryPicker()` 可以直接落盘，其他浏览器只能下载 ZIP。
- 首次要下 ~12 MB 的 `esbuild.wasm`（本地服务是瞬时；真上线建议 gzip + 延迟到点击时加载）。
- 示例站点依赖 `fixtures/`，而 `fixtures/` 是生成物：先 `npm run fixtures`。
- Agent 自动化仍然用 CLI / MCP；网页版是给人用的。

## 踩过的坑（写给以后改这块的人）

1. **`--headless=new` 在 macOS + 外层沙箱下会起一个不加载页面的 Chrome 进程** —— 请求日志里
   连 `/test.html` 都没有。换 `--headless=old --no-sandbox` 才稳（见 `test-headless.mjs`）。
2. **`--virtual-time-budget` 会卡住 wasm 编译**：加了 `--dump-dom --virtual-time-budget=180000`
   之后页面永远停在 `run-a-start`。真实异步任务不要用虚拟时间等。
3. **`process` 未定义会让 HTML 静默不压**：`html-minifier-terser` 的动态 import 抛错 → `text.js`
   的守卫返回原文。Node 里跑同一个包不会暴露，只有真浏览器才会。
4. **别把文件 buffer 放进 `postMessage` 的 transferList**：转移会 neuter 原缓冲，第二次点「开始」就空了。
5. **`TEST_MODE` 不能靠 `process.env` 在模块加载时读**：ESM import 是提升的，调用方设 env 已经太晚。
   现在 `createPocServer({ test: true })` 显式传参。
6. **示例站点路由的根目录要对齐**：曾经 `/__fixture/<rel>` 挂在 `fixtures/` 根上，而清单来自
   `fixtures/07-real-site`，于是每个文件都拿到 9 字节的 `not found` 当内容（账单 189 B）。
   现在统一走 `/demo-site/*`，并且页面里 `if (!res.ok) throw`。
7. **`serve.mjs` 默认端口从 5180 改成 5233**：5180 常被别的 vite dev server 占着，
   撞上会直接 `EADDRINUSE`（你看到的就是别人家的网站）。
