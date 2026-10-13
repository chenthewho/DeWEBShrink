# 给 agent 的提示词 · DeWEBShrink MCP

这份文档是**给别的 agent 看的说明书**（不是给人看的 README）。三种用法：

| 场景 | 怎么用 |
| --- | --- |
| 同一个 DSH 里别的 agent / 别的 session | 把「精简版」粘进那个工作区的 `AGENTS.md`（DSH 会自动读），工具本身由 profile 注册提供 |
| 别的机器 / 别的 MCP 客户端（Claude、Cursor、Cline、VS Code…） | 把「完整版」放进 system prompt / custom instructions，按第 4 节配连接 |
| 只能跑 shell 的 agent（不会说 MCP） | 用第 4 节的 `curl` 例子直接发 JSON-RPC |

端点与密钥：

```
MCP 端点   https://yutingprod.com/mcp/         （Streamable HTTP，只收 POST；GET 是探活）
认证       x-api-key: <KEY>   或   Authorization: Bearer <KEY>
本地形态   node /path/to/deweb-shrink/src/index.js   （stdio，接 dir 参数，产物写 <dir>.tape）
```

---

## 1. 精简版（粘进 AGENTS.md / system prompt，约 15 行）

```text
工具：DeWEBShrink MCP（去中心化站点上链前的体检 + 压缩 + 计费）。
作用：算清「这个站点上链要花多少 gas/BNB」，并压小它；一切数字按 tapecode.ai 协议的
真实公式：gas = 块数×270000 + 字节×235，每 24000 字节一块（一块 = 一笔交易）。

什么时候用：
 - 用户问「上链多少钱 / 怎么省 / 这版改动要花多少」→ cost_model / estimate / scan / diff
 - 要发布前 → scan 看账单和问题，optimize 出压缩产物，verify 确认能安全上链
 - 改版后只想知道增量花费 → diff（同一路径+同一 sha256 会跳过，所以通常只花几个文件的钱）

怎么传站点（二选一）：本地 stdio 用 dir（目录路径）；远程 HTTP 必须用 files
（[{path, content} 文本 | {path, base64} 二进制]）。两者都不给会报错。
单次 content 总量 ≤ 8 MB、≤ 2000 个文件；远程是串行执行（一次一个），重请求 8–30s，
失败就重试（返回 503 busy 就等 5 秒）。

输出：每次返回两段 content —— 第 0 段是给人看的报告，第 1 段是
"\n--- JSON ---\n{...}"，要数字就解析这段 JSON。

铁律：
 1. optimize 绝不改源目录，产物只写 <dir>.tape 或放在 artifacts 里；
 2. 发布前必须 verify，且要看 warned（warned>0 表示有降级，例如 JS 没压成）；
 3. 别把 README/.map/无引用图当站点资源 —— 默认会被删（robots.txt/favicon 之类约定文件受保护）；
 4. 隐藏文件/目录（.shots、.well-known）协议会静默跳过，别指望它们能上链。
```

---

## 2. 完整版（可以整段放进 system prompt）

```text
## DeWEBShrink MCP 使用规范

### 它是什么
TapeCode / TapeOut（去中心化网站）的**体检 + 压缩 + 计费**工具。链上按字节永久计费，
所以这个工具回答两个问题：① 这站点上链要花多少钱、有什么问题；② 怎么压小、省了多少。
计费公式（与协议前端一致，不要自己另算）：
  gas = 块数 × 270000 + 字节数 × 235     每 24000 字节一块 = 一笔交易
  gasPrice = max(0.05 gwei, min(实时价, 20 × 0.05 gwei))
  参考：1 MB 纯数据 ≈ 0.0129 BNB（BSC 地板价下）

### 六个工具（都会返回「报告文本 + --- JSON --- 尾巴」，要数字解析 JSON）
- cost_model(network?, liveGasPrice?)          计费模型与常量。用户问「为什么越大越贵」时用它。
- scan(dir|files, exclude?, network?, …)       只读体检：会传哪些文件、多少字节/块/gas/钱，
                                                以及会被静默跳过的文件、断链、死文件、重复内容、
                                                Content-Type 问题。
- estimate(bytes|files, …)                      只算钱。「再加一张 2 MB 的图要多少」用这个。
- optimize(dir|files, options?, …)              压出新版本 + 前后账单对比 + 校验结果 + 还能再省清单。
                                                默认安全档；转 WebP / 激进 HTML 要显式开。
                                                本地形态产物写 <dir>.tape；远程形态从 artifacts 取。
- verify(dir|files, reference|referenceFiles)   能不能安全上链。给了基准就与原文对拍。
- diff(next|nextFiles, previous|previousFiles)  增量账单：从链上那一版到这一版，实际上传要花多少。
                                                不给 previous 视为首次部署（= 全量）。

### 输入形态（最容易搞错的一点）
- 本地 stdio：传 `dir`（站点目录路径），产物写 `<dir>.tape`（绝不允许写在源目录里）。
- 远程 HTTP：**必须**传 `files`，服务器上没有你那个目录。文本用 `content`，二进制用 `base64`：
  [{"path":"index.html","content":"<!doctype html>…"},{"path":"icons/a.png","base64":"iVBORw0…"}]
- `files` 与 `dir` 同时给时以 `files` 为准；两者都不给（含 `files: []`）会报「缺少输入」。
- 上限：单次内容总量 ≤ 8 MB、≤ 2000 个文件、请求体 ≤ 16 MB，超了要分批
  （**分批建议按类型**：先 HTML/CSS/JS，再图片/字体）。
- 单个 >8 MB 的文件远程传不进来（会先被 8 MB 护栏拦住）；链上协议本身也会静默跳过它。

### 远程形态的现实约束（照做，不然会白等）
- 共享主机上**一次只跑一个压缩任务**：并发调用会排队；排队超过 20 秒返回 HTTP 503
  `error: busy`。收到 503 就等 5 秒重试，不要并发轰炸。
- 轻调用 0.2–2 s；含图片/JS 的真站点 optimize 8–30 s。单个调用超时按 120 s 设。
- 偶发 `502 server overloaded`（主机线程预算被占满）→ 串行重试 1–2 次，或拆小批次；
  连续失败就别硬试，改用本地 stdio 形态。

### 硬约束与反模式
1. **源目录只读**：optimize 不原地改；不要试图让它写进源目录（会被拒）。
2. **发布前必须 verify**，并检查 `verification.warned`：
   - `warned > 0` 说明有降级（例如 `esbuild 解析失败` = 这一版 JS 没压缩，账单数字偏大）；
   - `manifest.webmanifest` 的 Content-Type 警告是协议扩展名表的问题，建议改名 manifest.json
     并同步 `<link rel="manifest">` 与 sw.js 里的引用。
3. **默认删掉「白花钱」的文件**（README/.map/无引用图/设计稿），并保护 robots.txt、favicon.ico、
   root 的 apple-touch-icon.png、sitemap.xml 这类靠约定路径访问的文件。要全留就关掉
   `dropUnreferenced` / `dropNonSiteFiles`。
4. **隐藏文件（. 开头）与 `.well-known/` 传不上去**（协议按隐藏文件跳过）——
   域名验证、ACME、`.shots/` 截图都别算进站点。
5. **多文件比大文件贵**：块开销按文件各向上取整，10 个 3 KB 小文件比 1 个 30 KB 贵。
6. **改版只花改动文件的钱**：同一路径 + 同一 sha256 跳过；但改动文件是整份重传，
   所以「把 240 KB 的图换成 60 KB」省的是**每一次**改版的钱 —— 用 diff 给用户看这个数。
7. 不要编造数字：所有 gas/BNB/美元都以工具返回的 JSON 为准（gasPrice/币价是工具取的，
   显式传 gasPriceGwei/priceUsd 可复现）。

### 推荐调用顺序
体检阶段：cost_model → scan →（按需 estimate）
发布阶段：scan → optimize → verify（warned=0 或已解释）→ 用 artifacts/<dir>.tape 发布
迭代阶段：diff（previous = 链上那一版，next = 这一版）→ 需要的话再 optimize

### 回答用户时的口径
- 给数字时同时给**单位与口径**：字节数、块数（= 交易数）、gas、BNB、美元，以及 gasPrice/币价来源。
- 「省了多少」要说清是**这一次**省，还是**每次改版**都省。
- 明确区分「协议会跳过」（隐藏文件、>8 MiB）与「工具建议删」（无引用、非站点文件）。
```

---

## 3. 工具速查（写给 agent 的参数表）

| 工具 | 关键参数 | 返回里最该看的字段 |
| --- | --- | --- |
| `cost_model` | `network`(bsc/xlayer/base)、`liveGasPrice` | `constants`、`perMegabyte`、`gasPriceGwei` |
| `scan` | `dir` / `files`、`exclude[]` | `totals{allFiles,billableFiles,skippedFiles,bytes,chunks,gas}`、`cost`、`skipped[].reason`、`unresolved`、`duplicates`、`files[].likelyNotSiteFile` |
| `estimate` | `bytes` 或 `files[{path,bytes}]` | `gas{chunks,gas,byteGas,chunkGas}`、`cost` |
| `optimize` | `options{minifyJs,minifyCss,minifyHtml,optimizePng,optimizeJpeg,psnrTarget,aggressiveHtml,convertImages,convertTo,dropUnreferenced,dropNonSiteFiles,drop[],keep[],verify}` | `before/after.totals`、`saved{bytes,gas,usd}`、`files.dropped[]`、`files.renames[]`、`verification{ok,failed,warned,checks[]}`、`opportunities`、`artifacts[{path,bytes,base64}]`（远程） |
| `verify` | `dir`/`files`、`reference`/`referenceFiles` | `ok`、`failed`、`warned`、`checks[{name,status,detail}]`（入口 index.html / 协议合法性 / 引用完整性 / JS 语法 / HTML 结构 / 跨文件全局 / 体积单调 / Content-Type / 图片尺寸 / 单文件上限） |
| `diff` | `next`/`nextFiles`、`previous`/`previousFiles` | `firstDeploy`、`counts{added,changed,unchanged,removed}`、`upload{files,bytes,chunks,gas,cost}`、`removal`、`total`、`full`、`savedVsFull` |

解析返回的通用写法（Node/JS，任意 MCP 客户端同理）：

```js
const walk = (content) => {
  for (const c of content) {
    if (typeof c.text === "string" && c.text.includes("--- JSON ---")) {
      return JSON.parse(c.text.split("--- JSON ---")[1]);   // 数字都在这里
    }
  }
  return null;   // 只有报告、没有 JSON 尾巴 = 出错了（看 isError / 第一段文字）
};
```

---

## 4. 怎么让别的客户端连上

### 4.1 DSH（本机）

工具由 **profile** 提供，写在 `~/.dsh/profiles/<profile>/cordis.patch.yml`：

```yaml
- insert:
    - id: mcp-deweb-shrink-remote
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: deweb-shrink-remote      # 工具名 = mcp__deweb-shrink-remote__<tool>
        transport: streamable-http
        url: https://yutingprod.com/mcp/
        headers:
          x-api-key: <KEY>                   # 明文，文件权限保持 600
        toolCallTimeoutMs: 120000            # 远程重请求 8–30s，默认 60s 偏紧
        failOnStartupError: false            # 服务器挂了不拖住 DSH 启动
```

改完要**重启 DSH**；然后在该工作区放一份 `AGENTS.md`（第 1 节的精简版）告诉 agent 何时用它。

### 4.2 Claude Desktop / Cursor / Cline / VS Code（支持 Streamable HTTP 的）

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

> 老客户端只认 stdio（`command`/`args`）时，用 `mcp-remote` 做桥：
> `"command": "npx", "args": ["-y", "mcp-remote", "https://yutingprod.com/mcp/", "--header", "x-api-key:<KEY>"]`

### 4.3 只会跑 shell 的 agent（curl 发 JSON-RPC）

```bash
# 探活（不需要 key）
curl -s https://yutingprod.com/mcp/

# 列工具
curl -s https://yutingprod.com/mcp/ -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# 调工具（响应是 SSE，数据在 data: 行里；只取第一行就是完整 JSON）
curl -s https://yutingprod.com/mcp/ -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"estimate",
       "arguments":{"files":[{"path":"a.bin","bytes":1048576}],"gasPriceGwei":0.05,"priceUsd":750}}}'
```

注意：只收 `POST`；`GET /mcp/` 是探活；`/mcp/health` 之类的路径会被站点前端兜底吃掉（返回 HTML）。

---

## 5. agent 自检清单（用之前对一遍）

- [ ] 我传的是 `files`（远程）还是 `dir`（本地）？两者都没传会被拒。
- [ ] 单次内容 ≤ 8 MB、文件数 ≤ 2000？超了就按「文本 / 图片」分批，别并发。
- [ ] 我是**串行**调用的吗？收到 503 `busy` 就等 5 秒重试。
- [ ] 我从返回的 `--- JSON ---` 尾巴里取数字，而不是从报告文字里猜？
- [ ] 发布前跑了 `verify`，并看了 `warned` 与 `checks`？
- [ ] 我给用户的数字带了口径（块 = 交易数、gasPrice/币价来源）？
- [ ] 我有没有把「协议会跳过」和「工具建议删」混为一谈？
