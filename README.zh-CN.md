<p align="center">
  <a href="./README.md">English</a> · <strong>简体中文</strong>
</p>

<h1 align="center">agent-bridge</h1>

<p align="center">
  在自己的机器上跑 CLI 编码智能体，用<em>任何</em>客户端与它对话——<br/>
  浏览器扩展、编辑器、脚本、你自己的 UI 都行。你的订阅就是后端，不需要任何 API key。
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-14171f?style=flat-square" alt="MIT License" /></a>&nbsp;
  <a href="https://github.com/xiaohuzai/agent-bridge/actions/workflows/ci.yml"><img src="https://img.shields.io/badge/CI-test-926c0d?style=flat-square" alt="CI" /></a>&nbsp;
  <a href="#开发"><img src="https://img.shields.io/badge/node-%E2%89%A518-c2410c?style=flat-square" alt="node ≥ 18" /></a>&nbsp;
  <a href="https://github.com/xiaohuzai/agent-bridge/issues"><img src="https://img.shields.io/badge/PRs-welcome-3a6b35?style=flat-square" alt="PRs welcome" /></a>
</p>

---

**agent-bridge** 是一个极小的零依赖 Node 守护进程，只做一件事：把本地 CLI 智能体适配成一个小的、带版本的 HTTP+SSE 协议，让*任何东西*都能驱动它。它存在的原因是一道硬边界——浏览器扩展被沙箱锁死、永远无法启动本地进程，而 CLI 智能体（codex、claude code……）只从 stdio 说话。桥坐在两者中间：

```
任何客户端 —— 扩展 / 编辑器 / 脚本 / 你自己的 UI
   │  普通 HTTP 到 127.0.0.1 —— POST JSON，读 SSE
   ▼
agent-bridge  ◄── 你在终端启动的这个进程（约 400 行，零依赖）
   │  JSONL over stdio
   ▼
codex app-server  ──►  你的 ChatGPT/Codex 登录，或你自己的模型配置
```

与 `opencode serve` 等智能体 HTTP server 是同一个思想——*智能体本体就是 server，任何 UI 都是 client*——只是 codex 和 claude code 没有自带 HTTP server，本仓库就是补上的那 400 行。客户端实现一次即可驱动桥背后的每个智能体；每个智能体 adapter 自动服务桥前面的每个客户端。

## 快速开始

```bash
# 0. 前提：codex CLI 可用。认证三选一——
codex login                    # ① ChatGPT 订阅登录（Plus/Pro，无需 API key）
export OPENAI_API_KEY=sk-...   # ② 或 OpenAI API key（无需订阅、无需 login）
# ③ 或在 ~/.codex/config.toml 配自定义 provider（[model_providers.*] 指向自己的
#    网关/本地模型），完全无需 codex 登录。注意：codex ≥0.149 强制
#    wire_api = "responses"，仅说 chat-completions 的端点会被 codex 本身拒绝
#    （桥不限制这个）。

# 1. 启动桥——codex，或任何支持 Agent Client Protocol v2 的智能体
npx browsa-agent-bridge codex --port 3948          # codex（走它的 app-server）
node cli.mjs acp -- claude-code-acp --port 3948    # 任何 ACP agent 命令都行：
node cli.mjs acp -- gemini --experimental-acp     # claude-code-acp、codex-acp、
                                                   # opencode、hermes、kimi、qwen…

# 2. 对话——一条 curl 就是一个完整的客户端：
curl -N -X POST http://127.0.0.1:3948/turns \
  -H 'Content-Type: application/json' \
  -d '{"text":"用一句话总结这个"}'
```

## 线缆协议（v1）

四条规则就是全部的客户端契约：

1. **`POST /turns`，body 为 `{text, sessionId?}`**，然后读 SSE 流。第一回合不带 `sessionId`——智能体会分配一个并在 `start` 事件里带回；存下来，之后每回合带上（智能体自己管理 transcript，你永远不需要重发历史）。
2. **`done` / `aborted` / `error` 结束回合。** 在此之前：`delta` 是回复文本，`tool` 是智能体活动，`usage` 携带一次 token 统计。`": ka"` 注释行是静默期 keepalive——忽略即可。
3. **取消 = 断开连接。** 桥发现断连后会在服务端中断智能体。回合是 live-only 的——离开的回合没有重放。
4. **审批**（智能体被配置为询问时）：收到带 `requestId` 的 `approval` 事件后，在该回合流保持打开期间用 `POST /approvals/:requestId` 与 `{choice:'once'|'always'|'deny'}` 应答。

```
GET  /health                   → {ok:true, agent, version, proto:1}
GET  /sessions                 → {ok:true, sessions:[{sessionId, busy}]}   ← 客户端重启后找回会话 id
POST /turns                    → SSE：start / delta / tool / approval / usage / done / aborted / error
                               body：{text, sessionId?, images?} —— images 为 https:/data: URL（≤8 张）
POST /approvals/:requestId     → {ok:true}
```

权威契约——包括首回合会话分配、断连语义等边界规则——写在 [`server.mjs`](./server.mjs) 的头注释里。

### 一个最小客户端（约 20 行）

```js
async function turn(text, sessionId) {
  const res = await fetch('http://127.0.0.1:3948/turns', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, sessionId }),
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '', full = '', sid = sessionId;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const e = JSON.parse(line.slice(5));
      if (e.type === 'start') sid = e.sessionId;
      if (e.type === 'delta') full += e.text;
      if (e.type === 'tool') console.error(`[tool] ${e.status}: ${e.detail}`);
      if (e.type === 'done') { full = e.full || full; }
    }
  }
  return { text: full, sessionId: sid };
}
```

**浏览器客户端**：桥会应答 CORS 预检，且只对回环来源（`http(s)://localhost:*`、`http(s)://127.0.0.1:*`）做反射，所以 localhost 上的页面可以直接调用，任意的 web 来源会被拒绝。传 `--cors-origin '*'` 可对所有来源开放——那时请配 `--token`。非浏览器客户端（Node、Python、curl）完全不需要这些。

## CLI 参数

```bash
browsa-agent-bridge codex [options]
  --port N              监听端口（默认 3948，只绑回环）
  --cwd DIR             agent 工作区（默认：当前目录）
  --sandbox MODE        read-only | workspace-write | danger-full-access（默认 read-only）
  --network             workspace-write 沙箱内允许联网
  --approval POLICY     never | on-request | untrusted（默认 never）
  --token TOKEN         所有请求要求此 bearer token
  --cors-origin MODE    loopback（默认）| *（任意来源；请配 --token）
  --codex-bin PATH      codex 二进制（默认：PATH 上的 codex）
  --codex-home DIR      CODEX_HOME 覆盖（默认：~/.codex）
```

**安全默认值**：read-only 沙箱 + `--approval never`。智能体可以读、可以推理，但要逃逸沙箱的命令会被拒绝。想让它写文件：`--sandbox workspace-write`（需要联网再加 `--network`）。想在你的客户端 UI 里逐条批准：`--approval on-request`——客户端会收到 `approval` 事件，并经 `POST /approvals/:id` 应答。

## 会话、审批、中断

- **sessionId = 智能体自己的线程 id**，第一回合分配、`start` 事件带回。桥重启不丢（`thread/resume` 从磁盘恢复）。`GET /sessions` 列出已知会话与忙闲状态——客户端重启后用它找回会话 id。
- **审批是完整往返**：智能体以 JSON-RPC 请求发问 → 桥转成线缆 `approval` 事件 → 客户端应答 → 决定写回智能体的 stdin。
- **中断 = 挂断**：断开 `POST /turns` 连接就是中断。桥发现断连后自动中断智能体，绝不会在后台无主空跑。

## 接入新 agent

**说 ACP v2？那已经不用接了**——`agent-bridge acp -- <你的 agent 命令>` 就是通用 adapter：stdio 拉起任意 ACP 智能体，把回合、流式增量、工具调用、用量、权限请求全部映射到桥的核心。零代码。

原生协议比 ACP 更丰富的 agent 才值得写专用 adapter（[`adapters/`](./adapters) 一个文件，实现 `startTurn` / `interrupt` / `respondApproval` / `stop` 四个方法 + `cli.mjs` 注册一行）——codex 就有一个，因为它的 app-server 协议实测强于走 codex-acp（审批词表、每回合沙箱策略都是真机实捕的）。没有审批或流式的 agent 也能用——协议会优雅降级（全文随 `done` 一次到达，安全沙箱默认生效）。

## 平台支持

同一份代码，Node ≥ 18，零 npm 依赖。Linux 经过 CI 与实战检验；macOS 应当原样可用（没有任何 shell 花招，全是 Node）；Windows 已显式处理 `shell` spawn（npm 的 `.cmd` 垫片）与停止时先关 stdin。各平台的实测反馈非常欢迎。

## 开发

```bash
npm test          # 真 adapter + 真 HTTP server，对打一个脚本化的假 codex
```

[`test/fake-codex-app-server.mjs`](./test/fake-codex-app-server.mjs) 是按 codex-cli 0.149.1 真机捕获帧写就的脚本化替身，测试套件不需要安装 codex、不需要联网。codex 迭代很快——升级后请用 `codex app-server generate-json-schema --out /tmp/x` 重新导出协议，核对 adapter 头注释里记录的方法名。

## 已知边界（v1）

- 请求总体积上限 4MB（内联 base64 图片被限制在几 MB 内）。
- codex 的 `request_user_input` 工具会被桥拒绝（回合可继续）。
- 网络抖动触发的重试会重发整条 prompt——agent 侧可能把一个回合跑两遍。
- 回合是 live-only 的：断开的客户端无法重新加入同一个回合。
- 通用 ACP adapter 面向 ACP **v2**（依官方 schema 实现），CI 里以脚本化假 agent 演练；对真实 claude-code-acp / gemini 的实机验证是下一个里程碑。

## 许可

[MIT](./LICENSE)
