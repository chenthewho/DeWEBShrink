<?php
/**
 * =============================================================================
 *  deweb-shrink · MCP over HTTPS（共享主机桥接 · 按需拉起版）
 * =============================================================================
 *  部署环境：SiteGround 共享主机。两条硬限制塑造了整个设计：
 *
 *    1. **禁止用户进程 TCP listen**（`listen EPERM`，连 127.0.0.1 都不行）。
 *       所以不可能跑一个常规的 HTTP 服务，443 只能由主机的 Apache/nginx 提供。
 *    2. **进程不能脱离会话存活**。实测：`setsid nohup node ... &` 起来的进程
 *       在 SSH/请求会话结束后就被清理。所以常驻进程（哪怕挂 Unix socket）也活不下来。
 *
 *  于是只剩一条路 —— **每个 HTTP 请求拉起一个 Node 进程，处理完即退出**：
 *
 *        客户端 ──HTTPS──> Apache(443) ──> 本文件 ──stdio──> node src/index.js
 *
 *  代价是每次请求多 ~220ms 的 Node 冷启动。对 MCP 这种「一次调用一次响应」的
 *  场景完全可以接受（一次 tools/call 端到端通常在 1 秒内）。
 *
 *  为什么直接复用 `src/index.js`（标准 stdio MCP server）而不是另写一套：
 *  保证「线上跑的」和「本地测的、97 个测试覆盖的」是**同一份代码**，行为不会漂。
 * =============================================================================
 */

declare(strict_types=1);

const APP_DIR  = '/home/customer/deweb-shrink';
const KEY_FILE = APP_DIR . '/.mcp-key';
const LOG_FILE = APP_DIR . '/bridge.log';
const LOCK_FILE = APP_DIR . '/bridge.lock';
const NODE_BIN = '/usr/local/bin/node';
const SERVER   = APP_DIR . '/src/index.js';
const MAX_BODY = 16 * 1024 * 1024;   // 与 Node 侧 DEWEB_SHRINK_MAX_BODY 对齐
const TIMEOUT  = 60;                 // 秒；Node 侧任务超时设成 45s，让它自己先给出可读错误
const QUEUE_WAIT = 20;               // 秒；拿不到执行槽位时最多排这么久，然后回 503

/* 为什么要有串行闸（QUEUE_WAIT/LOCK_FILE）：
 * 这台共享主机**每用户进程/线程上限非常紧**（实测 `ulimit -u` = 80），而一次调用
 * 要新建：一个多线程 Node + esbuild 的子进程（Go，按 CPU 开线程）+ libvips 线程池。
 * 并发拉起几个就会出现：
 *     PHP-ERR: proc_open(): Fork failed: Resource temporarily unavailable
 *     node: pthread_create: Resource temporarily unavailable
 *     runtime: failed to create new OS thread ... fatal error: newosproc
 * 结果调用方只拿到「Node 没有返回内容」。所以这里用 flock 把并发的 Node 压到 1 个，
 * 其它请求排队；排太久就明确回 503 busy（而不是让 agent 干等 170s）。 */

/* 共享主机上 display_errors 是关的，PHP 一出 fatal 就只回一个**空 body 的 500**，
 * 看响应根本不知道哪一行炸了。所以把错误也收进我们自己的日志。 */
ini_set('display_errors', '0');
ini_set('log_errors', '1');
ini_set('error_log', APP_DIR . '/php-errors.log');
register_shutdown_function(static function (): void {
    $e = error_get_last();
    if ($e && in_array($e['type'], [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR, E_USER_ERROR], true)) {
        @file_put_contents(
            LOG_FILE,
            date('c') . " PHP-FATAL: {$e['message']} @ {$e['file']}:{$e['line']}\n",
            FILE_APPEND
        );
    }
});
set_error_handler(static function (int $no, string $str, string $file, int $line): bool {
    @file_put_contents(LOG_FILE, date('c') . " PHP-ERR: $str @ $file:$line\n", FILE_APPEND);
    return false;
});

/* -------------------------------------------------------------------------- */

function bridge_log(string $msg): void
{
    @file_put_contents(LOG_FILE, date('c') . ' ' . $msg . "\n", FILE_APPEND | LOCK_EX);
}

function send_json(int $status, array $payload): void
{
    http_response_code($status);
    header('content-type: application/json; charset=utf-8');
    header('cache-control: no-store');
    echo json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

function cors(): void
{
    header('Access-Control-Allow-Origin: *');
    header('Access-Control-Allow-Headers: content-type, x-api-key, authorization, mcp-session-id, mcp-protocol-version, last-event-id');
    header('Access-Control-Allow-Methods: POST, GET, DELETE, OPTIONS');
    header('Access-Control-Expose-Headers: mcp-session-id, mcp-protocol-version');
    header('Vary: Origin');
}

function client_key(): string
{
    if (!empty($_SERVER['HTTP_X_API_KEY'])) {
        return (string) $_SERVER['HTTP_X_API_KEY'];
    }
    $auth = $_SERVER['HTTP_AUTHORIZATION'] ?? ($_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '');
    if (is_string($auth) && preg_match('/^bearer\s+(.+)$/i', trim($auth), $m)) {
        return trim($m[1]);
    }
    return '';
}

/**
 * 拉起 Node、喂一个 JSON-RPC 消息、读回响应。
 *
 * 关键细节：**stdin 不能马上关**。Node 的 stdout 在管道模式下是异步的，
 * 如果写完就关 stdin，进程会在响应刷出去之前退出（本地实测过：加 `; sleep 2`
 * 才有输出）。所以这里写完请求后保持管道打开，读到响应再收。
 *
 * @return array{0:?string,1:?string} [原始响应行, 错误信息]
 */
function run_mcp_once(string $payload): array
{
    $descriptors = [
        0 => ['pipe', 'r'],  // stdin
        1 => ['pipe', 'w'],  // stdout
        2 => ['pipe', 'w'],  // stderr
    ];

    $env = [
        'PATH' => '/usr/local/bin:/usr/bin:/bin',
        'HOME' => APP_DIR,
        // 关掉 Node 侧交互式提示之类的东西，顺便让它对单次调用更轻
        'NODE_ENV' => 'production',
        'DEWEB_SHRINK_API_KEY' => '',   // stdio 形态不校验 key（认证在 PHP 层做完了）
        /* ↓ 线程预算。共享主机 ulimit -u 只有 80，默认线程数会直接把进程打死：
           libuv 默认 4 个线程池线程、libvips 按 CPU 数开线程、esbuild（Go）也按 CPU 开。
           全部压到最小，换来的是「慢一点但能跑完」。 */
        'UV_THREADPOOL_SIZE' => '2',
        'GOMAXPROCS' => '2',
        'DEWEB_SHRINK_SHARP_CONCURRENCY' => '1',
        /* Node 侧自己的任务超时（src/limits.js）。比 PHP 的 TIMEOUT 短，
           这样超时是「Node 返回一条能看懂的 504 消息」，而不是桥接把进程 kill 掉、
           调用方只看到空响应。 */
        'DEWEB_SHRINK_TIMEOUT_MS' => '45000',
        'DEWEB_SHRINK_CONCURRENCY' => '1',
    ];

    $proc = @proc_open([NODE_BIN, SERVER], $descriptors, $pipes, APP_DIR, $env);
    if (!is_resource($proc)) {
        return [null, '无法启动 Node 进程'];
    }

    // 非阻塞读，避免某个管道没数据时把整个请求卡死
    foreach ([1, 2] as $i) {
        stream_set_blocking($pipes[$i], false);
    }
    stream_set_blocking($pipes[0], true);

    // 发请求。注意**不关闭** stdin —— 见上面的说明。
    @fwrite($pipes[0], $payload . "\n");
    @fflush($pipes[0]);

    $stdout = '';
    $stderr = '';
    $deadline = microtime(true) + TIMEOUT;
    $gotLine = false;

    while (microtime(true) < $deadline) {
        $r = [$pipes[1], $pipes[2]];
        $w = null;
        $e = null;
        // 等 200ms 看有没有数据，避免忙等
        if (@stream_select($r, $w, $e, 0, 200000) > 0) {
            foreach ($r as $stream) {
                if ($stream === $pipes[1]) {
                    $chunk = @fread($pipes[1], 65536);
                    if ($chunk !== false && $chunk !== '') {
                        $stdout .= $chunk;
                        // stdio MCP 是「一行一个 JSON-RPC 消息」，拿到一行就够了
                        if (strpos($stdout, "\n") !== false) {
                            $gotLine = true;
                        }
                    }
                } else {
                    $err = @fread($pipes[2], 65536);
                    if ($err !== false) {
                        $stderr .= $err;
                    }
                }
            }
        }

        if ($gotLine) {
            break;
        }

        // 进程已经退出且没有更多输出 → 没必要再等
        $status = proc_get_status($proc);
        if (!$status['running'] && $stdout === '') {
            // 再给一点时间把缓冲读干净
            $tail = @fread($pipes[1], 65536);
            if ($tail !== false) {
                $stdout .= $tail;
            }
            break;
        }
    }

    // 收尾：先关管道再终止，避免僵尸
    foreach ($pipes as $p) {
        if (is_resource($p)) {
            @fclose($p);
        }
    }
    $st = proc_get_status($proc);
    if ($st['running']) {
        // 注意：**不能直接写 SIGTERM**。共享主机上 pcntl 扩展通常只在 CLI SAPI 里启用，
        // 网站跑的 PHP-FPM 没有，于是 SIGTERM 常量未定义 —— 直接 fatal（实测踩过）。
        proc_terminate($proc, defined('SIGTERM') ? SIGTERM : 15);
    }
    proc_close($proc);

    if ($stdout === '') {
        $why = trim($stderr) !== '' ? trim($stderr) : '（无输出，可能是超时）';
        return [null, 'Node 没有返回内容：' . mb_substr($why, 0, 300)];
    }

    return [$stdout, null];
}

/* ------------------------------- 主流程 ------------------------------- */

set_time_limit(TIMEOUT + 30);
ini_set('memory_limit', '256M');

cors();

$method = $_SERVER['REQUEST_METHOD'] ?? '';

if ($method === 'OPTIONS') {
    http_response_code(204);
    exit;
}

/* 探活走 GET /mcp/。
   只能有这个路径 —— 站点根 .htaccess 最后一条 `RewriteRule . /index.html [L]`
   会把所有不存在的路径交给 Vue 前端路由，/mcp/health 之类根本到不了本脚本。
   而 /mcp/ 本身是真实目录，命中 `RewriteCond -d`，可以直达。 */
if ($method === 'GET') {
    header('content-type: application/json; charset=utf-8');
    header('cache-control: no-store');
    echo json_encode([
        'ok' => true,
        'service' => 'deweb-shrink',
        'mode' => 'on-demand-stdio',   // 每次请求拉起一次 Node
        'authRequired' => is_file(KEY_FILE),
    ], JSON_UNESCAPED_SLASHES);
    exit;
}

if ($method !== 'POST') {
    send_json(405, ['error' => 'method not allowed', 'hint' => '这个端点只接受 POST（探活用 GET）']);
}

/* API key：常量时间比较 */
if (!is_file(KEY_FILE)) {
    send_json(503, ['error' => 'server not configured', 'hint' => '缺少 API key 文件']);
}
$expected = trim((string) @file_get_contents(KEY_FILE));
if ($expected === '' || !hash_equals($expected, client_key())) {
    send_json(401, [
        'error' => 'unauthorized',
        'hint' => '请在 x-api-key 头里带上 key，或用 Authorization: Bearer <key>',
    ]);
}

/* 请求体闸。
   这里的一步很关键：**在 PHP 侧就把过大的请求挡住**，别丢给 Node。
   原因：stdio 是一条管道，Node 侧读缓冲有上限；超了会直接关掉 transport、
   进程退出，调用方只看到「没有响应」，完全不知道是体积问题。
   所以宁可在这一层给一个能看懂的 413。 */
$body = file_get_contents('php://input');
if ($body === false || $body === '') {
    send_json(400, ['error' => 'empty body', 'hint' => '请求体应当是 JSON-RPC 消息']);
}
if (strlen($body) > MAX_BODY) {
    send_json(413, [
        'error' => 'payload too large',
        'detail' => '这次传了约 ' . round(strlen($body) / 1024 / 1024, 2) . ' MB，超过上限 ' . (MAX_BODY / 1024 / 1024) . ' MB',
        'hint' => '请分批调用：先传 HTML/CSS/JS，再传图片/字体；单批原始内容不要超过 8 MB（图片转 base64 后还会膨胀约 1/3）',
    ]);
}

/* 解析一下是不是 JSON-RPC；notification（没有 id）不需要响应，直接收下就返回 */
$decoded = json_decode($body, true);
if (!is_array($decoded)) {
    send_json(400, ['error' => 'invalid json', 'hint' => '请求体应当是合法的 JSON-RPC 消息']);
}
/* notification（没有 id）不需要响应 —— **必须在 run_mcp_once 之前就返回**。
   它永远不会有响应，交给 run_mcp_once 只会卡满整个超时。
   标准 MCP 客户端在 connect() 阶段就会发 `notifications/initialized`，
   所以这里的顺序错了会让**第一次连接必定失败**（实测踩过：卡的正是这一下）。

   我们的服务是无状态的，初始化通知不参与后续请求的处理，直接收下返回 202 即可。
   哪天需要它生效（比如加会话状态），再改成「转发给 Node 但不等待响应」。 */
if (!isset($decoded['id'])) {
    http_response_code(202);
    header('cache-control: no-store');
    exit;
}

/* ------------------------------- 串行闸 -------------------------------
   一次只放一个 Node 子进程进来（理由见文件头的 QUEUE_WAIT 注释）。
   拿不到锁文件不属于「忙」——那是环境问题，宁可按老路径直接跑，也别让整个服务 503。 */
$lockWaitStart = microtime(true);
$lockHandle = @fopen(LOCK_FILE, 'c');
$locked = false;
if ($lockHandle !== false) {
    while (microtime(true) - $lockWaitStart < QUEUE_WAIT) {
        if (@flock($lockHandle, LOCK_EX | LOCK_NB)) {
            $locked = true;
            break;
        }
        usleep(150000);   // 150ms 一探
    }
}
$lockWaitedMs = (int) round((microtime(true) - $lockWaitStart) * 1000);

if ($lockHandle !== false && !$locked) {
    bridge_log("BUSY waited={$lockWaitedMs}ms method=" . ($decoded['method'] ?? '?'));
    header('retry-after: 5');
    send_json(503, [
        'error' => 'busy',
        'detail' => '排队等了 ' . QUEUE_WAIT . ' 秒仍拿不到执行槽位',
        'hint' => '这台共享主机同一时刻只跑一个压缩任务（每用户进程/线程预算很小）。请稍后重试、不要并发调用；'
            . '或者改用本地 stdio / 自建 VPS —— 并发能力只有换环境才能根治。',
        'waitedMs' => $lockWaitedMs,
    ]);
}
if ($lockWaitedMs > 300) {
    bridge_log("QUEUED waited={$lockWaitedMs}ms method=" . ($decoded['method'] ?? '?'));
}

$t0 = microtime(true);
[$response, $err] = run_mcp_once($body);
$elapsed = (int) round((microtime(true) - $t0) * 1000);

if ($locked) {
    @flock($lockHandle, LOCK_UN);
}
if ($lockHandle !== false) {
    @fclose($lockHandle);
}

if ($err !== null) {
    bridge_log("FAIL {$elapsed}ms method=" . ($decoded['method'] ?? '?') . ' err=' . $err);
    /* 「没有返回内容 / 线程 / fork 失败」几乎都是资源上限，不是代码 bug。
       错误信息里说清楚，agent 才知道该重试还是该拆小请求。 */
    $overloaded = (bool) preg_match('/thread|pthread|Fork failed|Resource temporarily unavailable|没有返回内容/i', $err);
    send_json(502, [
        'error' => $overloaded ? 'server overloaded' : 'backend error',
        'detail' => $err,
        'elapsedMs' => $elapsed,
        'hint' => $overloaded
            ? '共享主机的进程/线程预算被占满（一次调用要拉起 Node + esbuild + libvips）。请拆小请求（先传文本再传图片）、串行重试；持续失败请改用本地 stdio。'
            : '后端 Node 进程出错，请重试；持续失败看服务器 bridge.log。',
    ]);
}

/* 取出第一行完整响应，包成 SSE 返回 —— 和自建 HTTP 形态（src/http.js）
   保持一致的响应格式，客户端不用区分两种部署。 */
$line = strtok($response, "\n");
if ($line === false || trim($line) === '') {
    send_json(502, ['error' => 'empty response', 'detail' => mb_substr($response, 0, 200)]);
}

bridge_log('OK ' . $elapsed . 'ms method=' . ($decoded['method'] ?? '?') . ' bytes=' . strlen($line));

header('content-type: text/event-stream; charset=utf-8');
header('cache-control: no-store');
header('x-tape-elapsed-ms: ' . $elapsed);
echo 'event: message' . "\n";
echo 'data: ' . trim($line) . "\n\n";
