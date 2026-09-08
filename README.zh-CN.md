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

**agent-bridge** 是一个零依赖的 Node 守护进程，只做一件事：把本地 CLI 智能体适配成一个小的、带版本的 HTTP+SSE 协议（v1），让*任何东西*都能驱动它。它存在的原因是一道硬边界——浏览器扩展被沙箱锁死、无法启动本地进程，而 CLI 智能体（codex、claude code……）只从 stdio 说话。桥坐在两者中间，客户端实现一次即可驱动桥背后的每个智能体，每个智能体 adapter 自动服务桥前面的每个客户端：

```
任何客户端 —— 扩展 / 编辑器 / 脚本 / 你自己的 UI
   │  普通 HTTP 到 127.0.0.1 —— POST JSON，读 SSE
   ▼
agent-bridge  ◄── 你在终端启动的这个进程（约 400 行，零依赖）
   │  JSONL over stdio
   ▼
codex app-server  ──►  你的 ChatGPT/Codex 登录，或你自己的模型配置
```

## 快速开始

```bash
# 0. 前提：一个已装好、已登录的 CLI 智能体。以 codex 为例，认证三选一——
codex login                    # ① ChatGPT 订阅登录（Plus/Pro，无需 API key）
export OPENAI_API_KEY=sk-...   # ② 或 OpenAI API key
# ③ 或在 ~/.codex/config.toml 配自定义 provider（[model_providers.*] 指向自己的
#    网关/本地模型）。注意：codex ≥0.149 强制 wire_api = "responses"，仅说
#    chat-completions 的端点会被 codex 本身拒绝（桥不限制这个）。

# 1. 拿到桥——零依赖，clone 下来就能跑，无需 npm install
git clone https://github.com/xiaohuzai/agent-bridge && cd agent-bridge

# 2. 启动——codex，或任何 ACP v2 智能体（各 agent 的安装与登录详见 docs/agents.zh-CN.md）
node cli.mjs codex --port 3948 --approval on-request   # codex（走它的 app-server）；审批事件路由给客户端
node cli.mjs acp -- claude-agent-acp     # 接 claude code——需先装官方 claude-agent-acp 壳
node cli.mjs acp -- gemini --experimental-acp   # 任何 ACP agent 命令都行

# 3. 对话——一条 curl 就是一个完整客户端
curl -N -X POST http://127.0.0.1:3948/turns \
  -H 'Content-Type: application/json' \
  -d '{"text":"用一句话总结这个"}'
```

## 线缆协议 v1：使用指南

整份客户端契约只有四条规则：

1. **`POST /turns`，body 为 `{text, sessionId?}`**，然后读 SSE 流。第一回合不带 `sessionId`——智能体会分配一个并在 `start` 事件里带回；存下来，之后每回合带上（智能体自己管理 transcript，你永远不需要重发历史）。
2. **`done` / `aborted` / `error` 结束回合。** 在此之前：`delta` 是回复文本，`tool` 是智能体活动，`approval` 要你去应答。`": ka"` 注释行是静默期 keepalive——忽略即可。
3. **取消 = 断开连接。** 桥发现断连后会在服务端中断智能体。回合是 live-only 的——离开的回合没有重放。
4. **审批**：收到带 `requestId` 的 `approval` 事件后，在本回合流还开着时用 `POST /approvals/:requestId` 与 `{choice:'once'|'always'|'deny'}` 应答。

### 一次完整对话（curl 走查）

```bash
# ① 探测桥：活着没？后面是谁？什么协议版本？
curl http://127.0.0.1:3948/health
# → {"ok":true,"agent":"codex","version":"1.0.0","proto":1}

# ② 发起回合（-N 关闭 curl 缓冲，否则看不到流式输出）
curl -N -X POST http://127.0.0.1:3948/turns \
  -H 'Content-Type: application/json' \
  -d '{"text":"帮我把这个项目的测试跑一遍"}'
```

SSE 流是一段一段到达的，每条 `data:` 是一个 JSON 事件：

```
data: {"type":"start","sessionId":"a1b2c3…","turnId":""}   ← 首回合分配会话 id，存下来
data: {"type":"tool","name":"command","status":"started","detail":"npm test"}
data: {"type":"approval","requestId":"42","tool":"command","command":"npm install","cwd":"/repo"}
```

收到 `approval` 说明智能体想跑一条需要放行的命令。**在本回合流还开着的时候**应答（另开一个终端也行）。`approval` 事件只在桥以 `--approval on-request` 启动时出现——快速开始里的命令已带上；默认 `never` 时没有审批环节，命令要么在沙箱内直接执行、要么被拒绝：

```bash
# ③ 应答审批：choice ∈ once | always | deny
curl -X POST http://127.0.0.1:3948/approvals/42 \
  -H 'Content-Type: application/json' -d '{"choice":"once"}'
# → {"ok":true}    （409 = 这个审批已失效）
```

流继续，直到一个**终结事件**（`done` / `aborted` / `error`）到来、连接关闭：

```
data: {"type":"delta","text":"测试全部通过，共 23 个用例。"}
data: {"type":"done","full":"测试全部通过，共 23 个用例。","usage":{"prompt_tokens":1234,"completion_tokens":567}}
```

```bash
# ④ 第二回合：带上存下的 sessionId（不重发历史，智能体自己记得）
curl -N -X POST http://127.0.0.1:3948/turns \
  -H 'Content-Type: application/json' \
  -d '{"text":"把失败的那个修一下","sessionId":"a1b2c3…"}'

# ⑤ 任何时候（比如客户端重启后）找回会话列表
curl http://127.0.0.1:3948/sessions
# → {"ok":true,"sessions":[{"sessionId":"a1b2c3…","busy":false}]}
```

想中断一个跑偏的回合？直接断开 ② 的连接即可——桥会中断智能体，绝不后台空跑。

### 端点速查

| 方法与路径 | 请求体 | 成功响应 | 错误 |
|---|---|---|---|
| `GET /health` | — | `{ok:true, agent, version, proto:1}` | 401 token 错 · 403 Host 非回环 |
| `GET /sessions` | — | `{ok:true, sessions:[{sessionId, busy}]}` | — |
| `POST /turns` | `{text, sessionId?, images?}`（images ≤8 张 https:/data: URL） | SSE 事件流（见下表） | 400 缺 text / images 不合法 / body 超 4MB |
| `POST /approvals/:requestId` | `{choice:'once'\|'always'\|'deny'}` | `{ok:true}` | 400 choice 非法 · 409 审批已失效 |

带 `--api-key` 启动时，所有请求都要带 `Authorization: Bearer <token>`。

### 事件速查

| 事件 | 字段 | 含义 |
|---|---|---|
| `start` | `sessionId`, `turnId` | 回合已受理；首回合在此分配 `sessionId` |
| `delta` | `text` | 增量回复文本 |
| `tool` | `name`, `status: started\|completed\|failed`, `detail` | 智能体活动（跑命令、改文件……） |
| `approval` | `requestId`, `tool`, `command`（codex 另带 `cwd`） | 智能体请求批准——用 `POST /approvals/:requestId` 应答 |
| `done` | `full`, `usage?`, `finishReason?` | **终结**：正常完成；`usage` 为 `{prompt_tokens, completion_tokens}` |
| `aborted` | — | **终结**：回合被中断 |
| `error` | `message` | **终结**：出错 |

注：token 统计目前随 `done` 的 `usage` 字段携带（协议保留了独立的 `usage` 事件类型，供未来 adapter 更早推送）；`": ka"` 注释行是心跳，忽略即可。

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

**浏览器客户端**：桥会应答 CORS 预检，且只对回环来源（`http(s)://localhost:*`、`http(s)://127.0.0.1:*`）做反射，所以 localhost 上的页面可以直接调用，任意的 web 来源会被拒绝。传 `--cors-origin '*'` 可对所有来源开放——那时请配 `--api-key`。非浏览器客户端（Node、Python、curl）完全不需要这些。

### 行为保证

- **sessionId = 智能体自己的会话 id**。桥重启不丢（codex `thread/resume` / ACP `session/resume` 从磁盘恢复）；`GET /sessions` 在客户端重启后找回会话与忙闲状态。
- **审批是完整往返**：智能体发问 → 桥转成 `approval` 事件 → 客户端应答 → 决定写回智能体。不应答它就一直等；不想等了断开连接即可。
- **中断 = 挂断**：断开 `POST /turns` 的连接就是中断，绝无后台无主空跑。

权威契约——包括首回合会话分配、断连语义等边界规则——写在 [`server.mjs`](./server.mjs) 的头注释里。

## CLI 参考

```bash
node cli.mjs codex [options]          # codex（走它的 app-server）
node cli.mjs acp -- <agent 命令…>     # 任何 ACP v2 智能体；`--` 之后全部归 agent 命令
node cli.mjs serve --config FILE      # 一份配置起多个桥（见下）
```

| 参数 | 说明 |
|---|---|
| `--port N` | 监听端口（默认 3948） |
| `--bind ADDR` | 绑定地址（默认 `127.0.0.1`；非回环绑定强制要求 `--api-key`——见[远程访问](#远程访问)） |
| `--cwd DIR` | 智能体工作区（默认：当前目录） |
| `--api-key KEY` | 所有请求要求此 bearer key（`--token` 作为别名可用） |
| `--cors-origin MODE` | loopback（默认）\| `*`（任意来源；请配 `--api-key`） |
| `--sandbox MODE` | **codex 专用**：read-only（默认）\| workspace-write \| danger-full-access |
| `--network` | **codex 专用**：workspace-write 沙箱内允许联网 |
| `--approval POLICY` | **codex 专用**：never（默认）\| on-request \| untrusted——想收到 `approval` 事件要开 on-request |
| `--codex-bin PATH` | **codex 专用**：codex 二进制（默认：PATH 上的 codex） |
| `--codex-home DIR` | **codex 专用**：CODEX_HOME 覆盖（默认：~/.codex） |
| `--config FILE` | **serve 专用**：JSON 配置文件，含 `bridges` 数组（见下） |

**安全默认值**：read-only 沙箱 + `--approval never`。智能体可以读、可以推理，但要逃逸沙箱的命令会被拒绝。想让它写文件：`--sandbox workspace-write`（需要联网再加 `--network`）。想在你的客户端 UI 里逐条批准：`--approval on-request`。ACP 模式下沙箱与权限由 agent 自己的策略管理，它的权限请求总是路由给客户端。

### 远程访问

默认只绑 `127.0.0.1`。`--bind` 把它放开——且 CLI 会拒绝不带 `--api-key` 的非回环绑定：

```bash
# 局域网 / VPN / tailnet
node cli.mjs codex --bind 0.0.0.0 --api-key $(openssl rand -hex 16)
```

非回环绑定的注意事项：

- **公网暴露：前面必须加 TLS。** 桥只说明文 HTTP——在 TLS 被终结之前，所有请求（包括 token）都是明文。最干净的部署是桥继续绑回环，由反向代理持有证书：
  ```caddy
  # Caddyfile —— TLS + 对 SSE 友好的转发；完全不需要 --bind
  bridge.example.com {
      reverse_proxy 127.0.0.1:3948 {
          header_up Host 127.0.0.1:3948   # 满足回环 Host 白名单
          flush_interval -1               # SSE 立即下发，不缓冲
      }
  }
  ```
  （nginx 同理：桥已发送 `X-Accel-Buffering: no`，SSE 不会被缓冲；代理读超时保持 ≥ 30 秒——桥每 15 秒发一次心跳。）
- **`--bind 0.0.0.0` + `--api-key`** 适用于可信网络（局域网/VPN）。回环绑定下，非回环 `Host` 头会被拒（DNS-rebinding 防护）；非回环绑定下该检查被跳过——那里主机名是合法的，token 就是闸门。
- **其他来源的网页**仍然拿不到 CORS 头（规则不变：只反射回环来源；要放开用 `--cors-origin '*'`，并配 `--api-key`）。浏览器扩展不需要 CORS。
- **token 是共享的静态凭证**——不过期、不分设备。谁拿到它，谁就能以服务器上的凭证和文件系统运行这个 agent。务必用足够长的随机值，存疑就轮换；纯个人使用的话，SSH 隧道（`ssh -N -L 3948:127.0.0.1:3948 host`）依旧是最省事的零配置方案。

### 一台机器，多个智能体（`serve` 模式）

一台机器上住着多个 agent 时，一条命令全起——每个桥独占一个端口、一把 api key、一个独立的 agent 子进程（会话隔离、凭证隔离）：

```bash
node cli.mjs serve --config agents.json
```

```json
{
  "bridges": [
    { "name": "codex",  "port": 3948, "apiKey": "…", "cwd": "~/work",
      "sandbox": "workspace-write", "approval": "on-request" },
    { "name": "claude", "port": 3949, "apiKey": "…", "cwd": "~/work" }
  ]
}
```

规则：

- **`name` 必须是注册表里的已知 agent**——[`agents-registry.mjs`](./agents-registry.mjs) 是唯一事实源（当前：`codex`、`claude`）。新 agent 等真机验证过再在那里加一行；browsa 等客户端的 agent 选择器镜像同一张表。
- **每个桥必须配 `port`；`apiKey` 回环下可选**——不写（或留空 `""`）就以无键方式跑，和单 agent 模式完全一致；加了非回环 `--bind` 才强制要 key。一个进程承载全部桥，Ctrl+C 全停。
- **不想自己写配置？** 复制仓库里的 [`agents.example.json`](./agents.example.json)——回环下开箱即跑（`node cli.mjs serve --config agents.example.json`）；要出远端时再把 key 填上。
- **`command: [...]` 覆盖注册表的默认命令**——比如 claude 用 `npx -y @agentclientprotocol/claude-agent-acp`、或壳装在自定义路径。agent 身份仍由 `name` 决定。
- 每条可选：`cwd`（支持 `~/` 展开）、`sandbox`、`approval`、`network`、`codexBin`、`codexHome`、`corsOrigin: "*"`。
- 任一端口绑定失败则整体启动失败，并报出是哪个桥（不会半起半挂）。配置文件里是全部 api key——请 `chmod 600`（权限过松 serve 会警告）。
- 可与 `--bind` 组合：`node cli.mjs serve --config agents.json --bind 0.0.0.0` 把所有桥暴露到局域网/VPN（见[远程访问](#远程访问)）。
- 开机自启/崩溃重启**有意不做**——用 systemd unit 或 launchd 包住这一条命令即可。

## 接入智能体

**两种启动方式，一套客户端接口**——起桥的命令和旗标随 agent 而异，但起好之后，客户端面对的是同一套线缆协议：四个端点、同一事件词表、同一审批往返。browsa 等客户端不需要（也没有任何办法）区分桥后面坐的是谁：

| | codex 模式 | acp 模式 |
|---|---|---|
| 启动命令 | `node cli.mjs codex --port 3948 --approval on-request` | `node cli.mjs acp -- <agent 命令>` |
| agent 说的协议 | codex 私有 app-server JSON-RPC | ACP v2（stdio，NDJSON） |
| 审批何时发生 | 你用 `--approval` 配策略（默认 never：不问） | agent 自己的权限体系决定，桥一律转发 |
| 沙箱 | 桥下发（`--sandbox` / `--network`） | 由 agent 自己的策略管理 |
| 图片 | 直接吃 data:/https URL | 须 agent 声明 `promptCapabilities.image`，否则降级为文本 |
| 适用 | codex | claude code、gemini、opencode…… 任何说 ACP v2 的 agent |

个别事件的可选字段随 agent 略有差异（如 `approval` 事件里 codex 带 `cwd`、ACP 带它自己的选项列表），核心字段与语义完全一致。**每个 agent 的安装、登录与专属注意事项**（比如接 claude code 需要先装 `claude-agent-acp` 翻译壳）见 [docs/agents.zh-CN.md](./docs/agents.zh-CN.md)。

**说 ACP v2？零代码**——`node cli.mjs acp -- <命令>` 拉起任意 ACP 智能体，把回合、流式、工具调用、审批、用量全部映射到上面的协议：claude code 用 `acp -- claude-agent-acp`，gemini 用 `acp -- gemini --experimental-acp`，opencode、kimi、qwen 等同理。图片须 agent 声明 `promptCapabilities.image`，否则自动降级为文本提示（绝不落盘）。adapter 同时说 ACP v1 与 v2（initialize 时协商），并已对官方 codex-acp 与 claude-agent-acp 壳完成真机真回合全链路验证。

**ACP 是什么**：Agent Client Protocol，Zed 发起的开放标准（[agentclientprotocol.com](https://agentclientprotocol.com)），"LSP for agents"——客户端把 agent CLI 作为子进程拉起，JSON-RPC 2.0 走 stdio（NDJSON），设计上**不绑端口**；官方远程传输（WebSocket / Streamable HTTP）尚在 RFD 阶段。本桥的 acp 模式扮演的是 ACP **客户端**；对使用方暴露的始终是上面那套 HTTP+SSE 协议。等官方远程传输定稿，桥会再加一个 ACP-over-WebSocket 门面，让现成 ACP 客户端零改动接入。

**原生协议比 ACP 更丰富的 agent 才值得写专用 adapter**——codex 就有一个，因为实测它的 app-server 协议强于走 codex-acp（审批词表、每回合沙箱策略都是真机实捕的）：[`adapters/`](./adapters) 一个文件，实现 `startTurn` / `interrupt` / `respondApproval` / `stop` 四个方法 + `cli.mjs` 注册一行。没有流式或审批的 agent 也能接——协议优雅降级（全文随 `done` 一次到达，安全沙箱默认生效）。

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
- 通用 ACP adapter 在 initialize 时协商 protocolVersion 1–2（两个官方壳——codex-acp、claude-agent-acp——都只说 v1），并已对这两个官方壳完成真机真回合全链路验证。

## 许可

[MIT](./LICENSE)
