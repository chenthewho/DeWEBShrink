# DeWEBShrink MCP · 接入与使用说明

> 给**使用者**看的文档（不是给 agent 看的提示词，那份在 `agent-mcp-prompt.md`）。
> 你可以把这份文档 + 一把 API key 直接发给对方。

---

## 1. 这是什么

**DeWEBShrink** 是给「去中心化网站」（TapeCode / TapeOut 协议）做**上链前体检与压缩**的
MCP 服务。它回答三件事：

| 你会问的问题 | 用哪个工具 |
| --- | --- |
| 我这个站点上链要花多少钱？ | `scan` |
| 再加一张 2 MB 的图、或者整站压一遍，要多少 / 省多少？ | `estimate` / `optimize` |
| 我只改了一个文件，这一版实际上传要花多少？ | `diff` |

所有金额都按协议前端那份公式算，不是估的：

```
gas = 块数 × 270,000 + 字节数 × 235
每 24,000 字节 = 1 块 = 1 笔交易
gasPrice = max(0.05 gwei, min(实时价, 20 × 0.05 gwei))     # BSC 地板价 0.05 gwei
参考价：1 MB 纯数据 ≈ 0.0129 BNB
```

它**不会**替你发交易、不会签名，只碰文件内容：出账单、出压缩产物、出校验结论。

---

## 2. 30 秒自测

```bash
# ① 探活（不需要 key）
curl -s https://yutingprod.com/mcp/
# → {"ok":true,"service":"deweb-shrink","mode":"on-demand-stdio","authRequired":true}

# ② 带 key 列工具
export DEWEB_SHRINK_API_KEY=<你的key>
curl -s https://yutingprod.com/mcp/ \
  -H "x-api-key: $DEWEB_SHRINK_API_KEY" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | head -c 300
```

拿到 6 个工具名（`cost_model` / `scan` / `estimate` / `optimize` / `verify` / `diff`）就通了。

| 项 | 值 |
| --- | --- |
| 端点 | `https://yutingprod.com/mcp/`（**只收 POST**；`GET /mcp/` 是探活） |
| 认证 | 请求头 `x-api-key: <KEY>`，或 `Authorization: Bearer <KEY>` |
| 传输 | MCP Streamable HTTP（**无状态**：每个请求独立，不用管 session id） |
| 协议版本 | 2025-06-18（`initialize` 握手正常返回） |
| 响应格式 | `text/event-stream`，内容在 `data:` 那一行；带回 `x-tape-elapsed-ms` 头（服务端耗时） |
| CORS | `Access-Control-Allow-Origin: *`（浏览器端也能直连，但别把 key 写进前端代码） |

---

## 3. 接到你的客户端上

### 3.1 Claude Desktop / Cursor / Cline / VS Code（支持 Streamable HTTP 的）

```json
{
  "mcpServers": {
    "deweb-shrink": {
      "type": "http",
      "url": "https://yutingprod.com/mcp/",
      "headers": { "x-api-key": "<KEY>" }
    }
  }
}
```

配好后重新打开客户端，工具会以 `deweb-shrink` 命名空间出现。客户端里问它一句
「用一个 1 MB 的文件估一下上链费用」就能验证。

### 3.2 只认 stdio 的老客户端

用 `mcp-remote` 桥一下（本机需要 Node ≥ 20）：

```json
{
  "mcpServers": {
    "deweb-shrink": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://yutingprod.com/mcp/",
               "--header", "x-api-key:<KEY>"]
    }
  }
}
```

### 3.3 DSH（DeepSeek Harness）

写进 `~/.dsh/profiles/<profile>/cordis.patch.yml`，然后**重启 DSH**：

```yaml
- insert:
    - id: mcp-deweb-shrink-remote
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: deweb-shrink-remote        # 工具名 mcp__deweb-shrink-remote__<tool>
        transport: streamable-http
        url: https://yutingprod.com/mcp/
        headers:
          x-api-key: <KEY>
        toolCallTimeoutMs: 120000              # 重请求 8–30s，默认 60s 偏紧
        failOnStartupError: false
```

同一台机器上还可以跑**本地 stdio 版**（快、没有并发限制、产物写盘）：

```yaml
        transport: stdio
        command: node
        args: [ '/path/to/deweb-shrink/src/index.js' ]     # 需要先 git clone + npm ci
```

### 3.4 自己写代码（Node / JS，其它语言同理）

```bash
npm i @modelcontextprotocol/sdk
```

```js
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const client = new Client({ name: "my-tool", version: "1.0.0" }, { capabilities: {} });
await client.connect(
  new StreamableHTTPClientTransport(new URL("https://yutingprod.com/mcp/"), {
    requestInit: { headers: { "x-api-key": process.env.DEWEB_SHRINK_API_KEY } },
  }),
);

const res = await client.callTool({
  name: "scan",
  arguments: { files: [{ path: "index.html", content: "<!doctype html><html><body>hi</body></html>" }],
               gasPriceGwei: 0.05, priceUsd: 750 },
});

const data = JSON.parse(res.content.find((c) => c.text.includes("--- JSON ---"))
                              .text.split("--- JSON ---")[1]);   // 数字都在这里
console.log(data.totals, data.gas, data.cost);
```

### 3.5 只会 shell / 任意 HTTP 客户端

```bash
KEY=<你的key>
curl -s https://yutingprod.com/mcp/ \
  -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"estimate",
       "arguments":{"files":[{"path":"hero.png","bytes":262144}],"gasPriceGwei":0.05,"priceUsd":750}}}'
```

响应（SSE）：

```
event: message
data: {"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"…报告…"},
      {"type":"text","text":"\n--- JSON ---\n{…}"}]}}
```

取第一行 `data:` 后面的 JSON 即可；二进制文件用 base64（`base64 -i a.png | tr -d '\n'`）。

---

## 4. 六个工具

> 除 `cost_model` / `estimate` 是纯计算外，其余工具都要**传站点内容**：
> `files`（远程必须用这个）或 `dir`（只有本地 stdio 版有目录概念）。

| 工具 | 用途 | 关键参数 |
| --- | --- | --- |
| `cost_model` | 计费模型与全部常量 | `network`(bsc/xlayer/base)、`liveGasPrice` |
| `scan` | 只读体检：会传哪些文件、多少字节/块/gas/钱；顺带报隐藏文件、断链、死文件、重复内容、Content-Type 问题 | `files`/`dir`、`exclude[]`、`network`、`gasPriceGwei`、`priceUsd` |
| `estimate` | 只按字节数算钱 | `bytes` 或 `files:[{path,bytes}]` |
| `optimize` | 压出新版本 + 前后账单 + 校验结果 + 「还能再省」清单 | `files`/`dir`、`options{…}`（见下） |
| `verify` | 能不能安全上链；给 `referenceFiles` 就与原文对拍 | `files`、`referenceFiles` |
| `diff` | 增量账单：从链上那一版到这一版实际上传要花多少 | `nextFiles`、`previousFiles`（不给 = 首次部署） |

`optimize` 的 `options`（都是可选，默认最保守）：

```jsonc
{
  "minifyHtml": true, "minifyCss": true, "minifyJs": true,   // 默认开
  "optimizePng": true, "optimizeJpeg": true, "psnrTarget": 42, // 默认开，同格式重编码
  "aggressiveHtml": false,      // 激进 HTML（去引号/折空白），默认关
  "convertImages": false, "convertTo": "webp",  // 转 WebP 并改引用，默认关
  "dropUnreferenced": true, "dropNonSiteFiles": true,  // 默认删「白花钱的文件」
  "drop": [], "keep": [], "verify": true
}
```

默认的「删」是有边界的：README、`.map`、没人引用的图会被删；
`robots.txt`、`favicon.ico`、根目录 `apple-touch-icon.png`、`sitemap.xml` 这类
**靠约定路径访问**的文件会被保护。要一个都不删就关掉那两个开关。

---

## 5. 传站点：`files` 的写法

```json
{ "files": [
  { "path": "index.html",        "content": "<!doctype html>…" },
  { "path": "assets/app.js",     "content": "function a(){…}" },
  { "path": "icons/icon-512.png","base64":  "iVBORw0KGgo…" }
] }
```

- 文本（HTML/CSS/JS/JSON/SVG…）用 `content`；二进制（PNG/JPEG/字体/视频…）用 `base64`。
- `path` 是**相对路径**：前导 `/` 和 `\` 会被规范化掉；`..`、控制字符、>1000 字符会被拒。
- 重复路径会**报错**（不静默取最后一个）；缺 `content`/`base64` 也会报错。
- 单次总量 **≤ 8 MB**、文件数 **≤ 2000**、请求体 **≤ 16 MB**；超了请**分批**
  （建议先 HTML/CSS/JS，再图片/字体，最后大文件）。

**注意**：单个 >8 MB 的文件传不进来（先被 8 MB 护栏拦），而链上协议本身也会静默跳过它 ——
所以线上站点里不要放这种文件，先自己拆。

---

## 6. 返回怎么读

每次调用返回两段 `content`：

1. **第 0 段**：给人看的排版报告（可以直接贴给用户）；
2. **第 1 段**：`"\n--- JSON ---\n{…}"`，**所有数字都在这里面**（gas、块数、BNB、美元、产物 base64）。

```js
const pick = (res) => JSON.parse(
  res.content.find((c) => c.text.includes("--- JSON ---")).text.split("--- JSON ---")[1]);
```

最常用的字段：

| 工具 | 字段 |
| --- | --- |
| `scan` | `totals{allFiles,billableFiles,skippedFiles,bytes,chunks,gas}`、`cost{gas,native,usd}`、`skipped[].reason`、`unresolved`、`duplicates` |
| `estimate` | `gas{chunks,gas,byteGas,chunkGas}`、`cost` |
| `optimize` | `before`/`after`、`saved{bytes,gas,native,usd}`、`files.dropped[]`、`files.renames[]`、`verification{ok,failed,warned,checks[]}`、`artifacts[{path,bytes,base64}]` |
| `verify` | `ok`、`failed`、`warned`、`checks[{name,status,detail}]` |
| `diff` | `firstDeploy`、`counts{added,changed,unchanged,removed}`、`upload{…}`、`removal`、`total`、`full`、`savedVsFull` |

远程形态下 `optimize` 的压缩结果就在 `artifacts` 里（`base64`），自己解码写盘即可。
**发布前必须看 `verification`**：`ok=false` 就别传；`warned>0` 说明有降级要解释
（例如 `esbuild 解析失败` = 这一版 JS 没压成，账单数字会偏大）。

---

## 7. 限制与「礼仪」（重要）

这个服务跑在一台**共享主机**上，资源很紧，用之前请知道：

| 项 | 实际值 | 你要做什么 |
| --- | --- | --- |
| 并发 | **一次只跑一个任务**（其他排队） | 串行调用；别并发轰炸 |
| 排队 | 超过 20 秒仍排不上 → HTTP 503 `error:"busy"` | 等 5 秒重试 |
| 耗时 | 轻调用 0.2–2 s；含图片/JS 的真站点 `optimize` **8–30 s** | 客户端超时设 ≥120 s |
| 单次内容 | ≤ 8 MB / ≤ 2000 文件 / 请求体 ≤ 16 MB | 分批传 |
| 单文件 | ≤ 8 MB（链上协议上限，同样值） | 大文件自己拆 |
| 超时 | 服务端任务 45 s、桥接 60 s | 拆小批次 |
| 偶发 | `502 server overloaded`（主机线程预算被占满） | 串行重试 1–2 次；连续失败改用本地 stdio 版 |

其它几条约定：

- **源目录只读**：本地 stdio 版的产物只会写 `<dir>.tape`，不会改你的站点；
- **`optimize` 默认会删「白花钱的文件」**（README / `.map` / 无引用图），要全留就关开关；
- **隐藏文件/目录（`.` 开头，含 `.well-known/`）协议会静默跳过**，传上去也没用；
- **多文件比大文件贵**：块开销按文件各向上取整 —— 10 个 3 KB 小文件比 1 个 30 KB 贵；
- **改版只花改动文件的钱**（同路径 + 同 sha256 跳过，但改动的文件整份重传）—— 用 `diff` 看这个数。

---

## 8. 安全与隐私

- 你传进来的**文件内容只在这个请求的内存里处理**，不写盘、不缓存；服务端日志只记
  耗时、方法与结果字节数，不记内容。
- 但它毕竟经过**别人的服务器**：不要传密钥、`.env`、私有源码仓库；站点资源无所谓。
- **API key 是共享的**：拿到 key 的人都能调用，没有配额、没有按人审计。请：
  - 不要贴到群里 / 提交进 git / 放进前端代码；
  - 通过私聊或密码管理器单独发；
  - 发现外泄立刻找服务方轮换（旧 key 立即失效）。
- 如果你要给**很多人**用，建议先让服务方改成「一人一把 key + 每 key 限流」，这样谁用超了能单独停。

---

## 9. 常见错误对照表

| 现象 | 原因 | 处置 |
| --- | --- | --- |
| `401 unauthorized` | 没带 key / key 不对 / 头名字写错了 | 用 `x-api-key` 或 `Authorization: Bearer`，值不要带引号与空格 |
| `405 method not allowed` | 用了 GET/PUT/DELETE 调 `/mcp/` | 只发 POST |
| `400 invalid json` / `empty body` | body 不是合法 JSON-RPC / 没 body | 检查 `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{…}}` |
| `413 payload too large` | 单次请求 > 16 MB | 分批传 |
| `503 busy` | 排队超过 20 秒 | 等 5 秒重试，别并发 |
| `502 server overloaded` | 主机线程预算被占满 | 串行重试；持续失败改用本地 stdio |
| 工具结果里 `错误：缺少输入…` | 既没给 `files` 也没给 `dir`（远程只能给 `files`） | 补上 `files`（空数组不算） |
| `错误：非法路径…` | 路径含 `..` / 控制字符 / 超长 | 用干净的相对路径 |
| `错误：这次传的内容太大…` | 单次 >8 MB（含 base64 膨胀） | 分批；单个大文件请自己拆或不上链 |
| `错误：文件…缺少内容` | 条目只有 `path` | 文本给 `content`，二进制给 `base64` |
| 报告里 `skipped: hidden/toobig/badpath` | 协议会**静默跳过**这些文件（与工具无关） | 隐藏文件改名；>8 MiB 文件拆分；非法路径改名 |
| `verify` 里 `warned>0` | 有降级（如 JS 没压成、manifest Content-Type 不规范） | 看 `checks[]` 的 detail 决定是否处理 |

---

## 10. 版本与变更

```bash
curl -s https://yutingprod.com/mcp/     # 探活里带 service 与 mode
# MCP initialize 的 result.serverInfo.name/version 是权威版本号
```

服务是无状态的：**升级不需要你改任何配置**（下次请求即生效）。

---

## 附：直接发给对方的模板（复制即用）

> 给你一个「站点上链前体检 + 压缩」的 MCP，用来算清上链要花多少 BNB、能省多少。
>
> - 端点：`https://yutingprod.com/mcp/`（Streamable HTTP，只收 POST）
> - key：`<KEY>`（请勿转发/入库；泄露了告诉我，我换）
> - 接法（Claude/Cursor 等）：把下面这段加进 MCP 配置，然后重开客户端
>
> ```json
> { "mcpServers": { "deweb-shrink": {
>     "type": "http", "url": "https://yutingprod.com/mcp/",
>     "headers": { "x-api-key": "<KEY>" } } } }
> ```
>
> - 自测：`curl -s https://yutingprod.com/mcp/` 应返回 `{"ok":true,…}`
> - 用法：把站点文件用 `files:[{path, content|base64}]` 传进去，
>   `scan` 看账单 → `optimize` 出压缩产物（在返回的 `artifacts` 里，base64）→ `verify` 确认能上链；
>   只改了一个文件就用 `diff` 看增量花费。
> - 注意：**串行调用**（服务一次只跑一个任务）；单次内容 ≤ 8 MB，超了分批；
>   含图片的整站 `optimize` 要 8–30 秒，客户端超时请设 ≥120 秒；`verify` 里
>   `warned` 不为 0 要先看原因再发布。
> - 完整说明见：<把这份文档发给对方>
