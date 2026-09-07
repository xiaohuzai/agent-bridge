<p align="center">
  <a href="./README.md">English</a> · <strong>简体中文</strong>
</p>

<h1 align="center">agent-bridge</h1>

<p align="center">
  在自己的机器上跑 CLI 编码智能体，用 <a href="https://github.com/xiaohuzai/browsa">browsa</a> 的侧边栏与它对话。<br/>
  你的订阅就是后端——不需要任何 API key。
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-14171f?style=flat-square" alt="MIT License" /></a>&nbsp;
  <a href="https://github.com/xiaohuzai/agent-bridge/actions/workflows/ci.yml"><img src="https://img.shields.io/badge/CI-test--18%2C%2020%2C%2022-926c0d?style=flat-square" alt="CI" /></a>&nbsp;
  <a href="#开发"><img src="https://img.shields.io/badge/node-%E2%89%A518-c2410c?style=flat-square" alt="node ≥ 18" /></a>&nbsp;
  <a href="https://github.com/xiaohuzai/agent-bridge/issues"><img src="https://img.shields.io/badge/PRs-welcome-3a6b35?style=flat-square" alt="PRs welcome" /></a>
</p>

---

**agent-bridge** 是一个极小的零依赖 Node 守护进程，把本地 CLI 智能体适配成一个 HTTP+SSE 小协议（**BAP — browsa Agent Protocol**）。它存在的原因：浏览器扩展被沙箱锁死、永远无法启动本地进程，而 CLI 智能体（codex、claude code……）只从 stdio 说话。桥坐在两者中间：

```
browsa 侧边栏（Chrome/Edge 扩展，沙箱里）
   │  普通 fetch() 到 127.0.0.1 —— BAP over HTTP+SSE
   ▼
agent-bridge  ◄── 你在终端启动的这个进程（约 400 行，零依赖）
   │  JSONL over stdio
   ▼
codex app-server  ──►  你的 ChatGPT/Codex 登录，或你自己的模型配置
```

与 `opencode serve`、Hermes 的 API server 是同一个思想——*智能体本体就是 server，任何 UI 都是 client*——只是 codex 和 claude code 没有自带 HTTP server，本仓库就是补上的那 400 行。

## 快速开始

```bash
# 0. 前提：codex CLI 可用。认证三选一——
codex login                    # ① ChatGPT 订阅登录（Plus/Pro，无需 API key）
export OPENAI_API_KEY=sk-...   # ② 或 OpenAI API key（无需订阅、无需 login）
# ③ 或在 ~/.codex/config.toml 配自定义 provider（[model_providers.*] 指向自己的
#    网关/本地模型），完全无需 codex 登录。注意：codex ≥0.149 强制
#    wire_api = "responses"，仅说 chat-completions 的端点会被 codex 本身拒绝
#    （桥不限制这个）。

# 1. 启动桥
npx browsa-agent-bridge codex --port 3948      # npm 包
node cli.mjs codex --port 3948                 # 或直接跑仓库检出

# 2. browsa → ⚙ 设置 → 「Agent Bridge」卡片 → Base URL 填 http://127.0.0.1:3948
#    → Save → Ping（应显示 agent-bridge (codex) healthy）
```

任何 BAP 客户端都能用，不限于 browsa——一条 `curl` 就能驱动一个回合：

```bash
curl -N -X POST http://127.0.0.1:3948/turns \
  -H 'Content-Type: application/json' \
  -d '{"text":"用一句话总结这个"}'
```

## CLI 参数

```bash
browsa-agent-bridge codex [options]
  --port N              监听端口（默认 3948，只绑回环）
  --cwd DIR             agent 工作区（默认：当前目录）
  --sandbox MODE        read-only | workspace-write | danger-full-access（默认 read-only）
  --network             workspace-write 沙箱内允许联网
  --approval POLICY     never | on-request | untrusted（默认 never）
  --token TOKEN         所有请求要求此 bearer token
  --codex-bin PATH      codex 二进制（默认：PATH 上的 codex）
  --codex-home DIR      CODEX_HOME 覆盖（默认：~/.codex）
```

**安全默认值**：read-only 沙箱 + `--approval never`。智能体可以读、可以推理，但要逃逸沙箱的命令会被拒绝。想让它写文件：`--sandbox workspace-write`（需要联网再加 `--network`）。想逐条在 browsa 的审批卡里点批准：`--approval on-request`。

## 会话、审批、中断

- **sessionId = codex threadId**，第一回合由 codex 分配、经 SSE `start` 事件带回；客户端存下它、之后每回合带上，agent 的上下文由它自己的 transcript 管理。桥重启不丢（`thread/resume` 从磁盘恢复）。
- **审批是完整往返**：codex 以 JSON-RPC 请求发问 → 桥转成 BAP `approval` 事件 → 客户端经 `POST /approvals/:id` 应答 → 决定（`accept` / 策略修正 / `cancel`）写回 codex 的 stdin。
- **中断 = 挂断**：断开 `POST /turns` 连接就是中断。桥发现断连后自动 `turn/interrupt`，agent 绝不会在后台无主空跑。

## BAP v1

```
GET  /health                   → {ok:true, agent, version, proto:1}
POST /turns {text, sessionId?} → SSE 流：
     {"type":"start","sessionId":"…","turnId":"…"}   （turnId 在入场前可能是 ""）
     {"type":"delta","text":"…"}
     {"type":"tool","name":"command","status":"started","detail":"…"}
     {"type":"approval","requestId":"…","tool":"command","command":"…","cwd":"…"}
     {"type":"usage","prompt_tokens":N,"completion_tokens":M}
     {"type":"done","full":"…"} | {"type":"aborted"} | {"type":"error","message":"…"}
     （静默期有 ": ka" 注释行做 keepalive）
POST /approvals/:requestId {choice:'once'|'always'|'deny'} → {ok:true}
```

协议刻意保持极小并带版本号（`proto:1`）；完整线缆契约（含客户端侧规则：断连语义、会话复用）写在 [`server.mjs`](./server.mjs) 的头注释里。

## 接入新 agent

[`adapters/`](./adapters) 里一个文件一个 agent，实现四个方法——`startTurn`、`interrupt`、`respondApproval`、`stop`——再到 `cli.mjs` 注册一行。claude code 是下一个 adapter（`claude -p --input-format stream-json --output-format stream-json` + `--resume`）；没有审批或流式的 agent 也能用——BAP 会优雅降级（全文随 `done` 一次到达，安全沙箱默认生效）。

## 平台支持

同一份代码，Node ≥ 18，零 npm 依赖。Linux 经过 CI 与实战检验；macOS 应当原样可用（没有任何 shell 花招，全是 Node）；Windows 已显式处理 `shell` spawn（npm 的 `.cmd` 垫片）与停止时先关 stdin。各平台的实测反馈非常欢迎。

## 开发

```bash
npm test          # 真 adapter + 真 HTTP server，对打一个脚本化的假 codex
```

[`test/fake-codex-app-server.mjs`](./test/fake-codex-app-server.mjs) 是按 codex-cli 0.149.1 真机捕获帧写就的脚本化替身，测试套件不需要安装 codex、不需要联网。codex 迭代很快——升级后请用 `codex app-server generate-json-schema --out /tmp/x` 重新导出协议，核对 adapter 头注释里记录的方法名。

## 已知边界（v1）

- 图片尚未转发给 agent。
- codex 的 `request_user_input` 工具未映射为澄清卡（桥会拒绝它，回合可继续）。
- 网络抖动触发的重试会重发整条 prompt——agent 侧可能把一个回合跑两遍（与 opencode/Hermes 集成相同的既知权衡）。
- 审批已对协议做过实测（schema + 实捕帧 + 错误路径）；交互卡片流程在 CI 里对着假 codex 演练。

## 许可

[MIT](./LICENSE)
