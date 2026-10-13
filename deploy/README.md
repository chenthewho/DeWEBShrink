# 部署记录 · DeWEBShrink @ yutingprod.com

**DeWEBShrink** —— 去中心化网站的体检与压缩工具。它的 MCP 服务部署在 **SiteGround 共享主机**
（`ssh.yutingprod.com:18765`，用户 `u3040-brzuiy4cxyrs`）。

## 端点

| 项 | 值 |
| --- | --- |
| MCP 端点 | `https://yutingprod.com/mcp/` |
| 探活 | `GET https://yutingprod.com/mcp/`（不需要 key） |
| 认证 | `x-api-key: <KEY>` 或 `Authorization: Bearer <KEY>` |
| API key | 存在服务器 `~/deweb-shrink/.mcp-key`（权限 600，**不在 Web 目录下**） |

## 为什么是这个架构

这台共享主机有两条硬限制，直接决定了方案：

**① 禁止用户进程 TCP listen。**
实测 `node -e "net.createServer().listen(8787)"` 报 `PermissionError: [Errno 1] Operation not permitted`，连绑 `127.0.0.1` 都不行。所以常规的「起一个 HTTP 服务」在这台机器上**不可能**，443 只能由主机管理的 Apache/nginx 提供。

**② 进程不能脱离会话存活。**
`setsid nohup node src/http.js &` 起来的进程，在会话结束后会被清理（`ps` 里查不到）。所以「常驻一个后端进程 + Unix socket」这条路也走不通 —— 尽管 Unix socket **可以**监听（我们验证过），进程本身活不下来。

于是架构只能是：

```
MCP 客户端
   │  HTTPS
   ▼
Apache / nginx (443, 主机管理)
   │  站点 .htaccess：/mcp/ 是真实目录 → 命中 `RewriteCond -d` 直接放行
   ▼
public_html/mcp/index.php        ← 薄桥接：认证 + 按需拉起 + 转发
   │  stdio（每请求一个进程）
   ▼
~/deweb-shrink/src/index.js       ← 和本地跑的是同一份 MCP server 代码
```

**每个 HTTP 请求拉起一个 Node 进程，处理完即退出。** 进程生命周期就是一个请求，不违反上面的限制。代价是每次多 ~220ms 的冷启动 —— 对 MCP 这种「一次调用一次响应」的场景完全可以接受（实测端到端 230–900ms）。

## 文件位置

| 路径 | 说明 |
| --- | --- |
| `~/deweb-shrink/` | 代码 + `node_modules` + `.mcp-key` + `bridge.log` |
| `~/www/yutingprod.com/public_html/mcp/index.php` | Web 桥接（**唯一**新增到站点目录的东西） |
| `~/deweb-shrink/bridge.log` | 每次调用的耗时与结果（含 `QUEUED` / `BUSY` / `FAIL`） |
| `~/deweb-shrink/php-errors.log` | PHP 错误 |
| `~/deweb-shrink/bridge.lock` | 串行闸用的锁文件（`flock`，空文件） |
| `~/deweb-shrink/index.php.bak-*` | 历次桥接备份（回滚用） |

站点根 `.htaccess` **未做任何修改**。`/mcp/` 之所以能直达 PHP，是因为它是**真实存在的目录**，命中站点原有规则里的 `RewriteCond %{REQUEST_FILENAME} -d`。

> ⚠️ 推论：**只有 `/mcp/` 这一个路径可用**。`/mcp/health` 之类会被站点最后一条 `RewriteRule . /index.html [L]` 当成 Vue 前端路由吃掉。所以探活设计成 `GET /mcp/`。

## 运维命令

```bash
# 更新代码（本地执行）
rsync -az --delete --exclude node_modules --exclude fixtures src/ yuting:deweb-shrink/src/
scp deploy/php-bridge/index.php yuting:www/yutingprod.com/public_html/mcp/index.php

# 服务器上装依赖（首次或 package.json 变更后）
ssh yuting 'cd ~/deweb-shrink && npm ci --omit=dev'

# 看调用日志
ssh yuting 'tail -30 ~/deweb-shrink/bridge.log'

# 看 PHP 错误
ssh yuting 'tail -30 ~/deweb-shrink/php-errors.log'

# 轮换 API key
ssh yuting 'cd ~/deweb-shrink && openssl rand -hex 32 > .mcp-key && chmod 600 .mcp-key && cat .mcp-key'

# 验收测试（本地执行）
DEWEB_SHRINK_API_KEY=<KEY> node scripts/test-remote.mjs https://yutingprod.com/mcp/
# 多场景测试（更狠：真站点、图片、并发、空参数、对拍）
DEWEB_SHRINK_API_KEY=<KEY> node scripts/scenarios-remote.mjs https://yutingprod.com/mcp/

# 回滚桥接
ssh yuting 'cp ~/deweb-shrink/index.php.bak-<ts> ~/www/yutingprod.com/public_html/mcp/index.php'
```

**不需要重启任何东西** —— 没有常驻进程，改完代码下一个请求就生效。

## 已知限制

| 限制 | 原因 | 影响 |
| --- | --- | --- |
| 每次请求 ~220ms 冷启动 | 不能常驻进程（见上） | 单次调用 230–900ms，可接受 |
| 单请求 ≤ 16 MB | stdio 管道 + 读缓冲上限 | 内容超过 8 MB 会被护栏要求分批 |
| **一次只跑一个压缩任务** | 每用户进程/线程上限（实测 `ulimit -u` = 80），见下 | 并发请求排队最多 20s，仍排不上回 503 `busy` |
| 无会话状态 | 每请求独立进程 | 本服务本来设计成无状态，无影响 |
| 只能有 `/mcp/` 一个路径 | 站点 .htaccess 前端兜底规则 | 不支持多路由 |

## 这台机器的进程/线程预算（很重要）

实测 `ulimit -u = 80`，而一次调用要新建：

```
PHP-FPM 子进程 → Node（主线程 + libuv 线程池 + V8 平台线程）→ esbuild 子进程（Go，按 CPU 开线程）
                                                          → libvips 线程（sharp）
```

默认参数下，几个请求叠在一起就会看到这些错误（都会让调用方只拿到
`502 Node 没有返回内容`，看不出原因）：

```
PHP-ERR: proc_open(): Fork failed: Resource temporarily unavailable
node[...]: pthread_create: Resource temporarily unavailable
Warning: Failed to load CA certificates off thread: resource temporarily unavailable
runtime: failed to create new OS thread (have 9 already; errno=11)
fatal error: newosproc          ← esbuild（Go）直接 fatal
```

所以现在的桥接固定这么做（见 `deploy/php-bridge/index.php`）：

| 手段 | 作用 |
| --- | --- |
| `flock(bridge.lock)` 串行 | 同一时刻只放一个 Node 进来，多的排队（最多 20s，然后 503 `busy`） |
| `UV_THREADPOOL_SIZE=2` | 压 libuv 线程池 |
| `GOMAXPROCS=2` | 压 esbuild（Go）的线程数 |
| `DEWEB_SHRINK_SHARP_CONCURRENCY=1` | libvips 只开 1 个线程（`src/optimize/images.js`） |
| `DEWEB_SHRINK_TIMEOUT_MS=45000` | Node 自己先超时并回一条可读错误，而不是让桥接 kill 进程 |
| `TIMEOUT=60` | 比 Node 的 45s 留出余量 |

**代价**：吞吐变差、单次更慢（实测真站点 optimize 8–14s）。**收益**：从「大部分调用直接失败」
变成「慢但能跑完」。真正的并发能力只有换掉共享主机才能解决（禁 TCP listen、进程不能脱离会话
这两条也决定了架构只能是「每请求拉起一个 Node」）。


## 踩过的坑（供以后参考）

1. **`SIGTERM` 常量在 Web 上下文未定义。** CLI 下的 PHP 有 `pcntl` 扩展，PHP-FPM 没有。直接写 `proc_terminate($proc, SIGTERM)` 会 fatal。用 `defined('SIGTERM') ? SIGTERM : 15`。

2. **stdin 写完不能立刻关。** Node 的 stdout 在管道模式下是异步的，写完就关 stdin 会让进程在响应刷出去之前退出，调用方拿到空响应。

3. **notification 必须早于「等响应」返回。** 标准 MCP 客户端在 `connect()` 阶段就发 `notifications/initialized`（无 id、永远无响应）。如果把它交给等待响应的路径，第一次连接必卡满超时。

4. **共享主机的 500 是空 body。** `display_errors` 关闭，PHP fatal 只回一个空 500，不看日志根本不知道哪一行炸了。所以桥接里加了 `register_shutdown_function` 把 fatal 写进 `bridge.log`。

5. **Node stdio 读缓冲默认 10 MB。** 我们的内容上限是 8 MB，图片转 base64 后膨胀 1/3 就会顶到 10 MB，导致 ReadBuffer 抛错、transport 关闭、进程退出 —— 调用方只看到「没有响应」。已在 `src/index.js` 里显式放大到 16 MB。

6. **空参数会扫到服务器自己。** `sourceFrom` 原来在既没有 `dir` 也没有 `files` 时回退到 `process.cwd()`，
   在服务器上就是「扫描部署目录自己」：认证用户能拿到 `~/deweb-shrink` 的 77 个文件清单，
   连 `.mcp-key` 的存在与大小都在里面。现在两者都缺（含 `files: []`）直接报「缺少输入」。
   **给 MCP 工具加「可选路径参数」时，永远不要让缺省落到 cwd。**

