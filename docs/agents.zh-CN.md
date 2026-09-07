<p align="center"><a href="./agents.md">English</a> · <strong>简体中文</strong></p>

# 各 agent 接入指南

agent-bridge 对客户端只有一套接口；agent 之间的差异全部在**怎么把桥跑起来**。两种模式：`codex`（专用 adapter），`acp -- <命令>`（通用 adapter，接任何说 ACP v2 的 agent）。

验证状态一览（诚实优先，跑通了或踩坑了请回报，我们来更新）：

| agent | 启动方式 | 实机验证 |
|---|---|---|
| codex | `codex` 模式（专用 adapter，**主推荐**） | ✅ 已验证（codex-cli 0.149.1） |
| codex | `acp -- codex-acp`（官方壳） | ⚠️ 过桥真回合 ✅；非流式后端丢答案文本（上游缺陷，见下） |
| claude code | `acp -- claude-agent-acp`（官方壳，主推荐） | ⏳ 握手/版本协商/错误路径已实测，真回合待 Mac 实测 |
| gemini | `acp -- gemini --experimental-acp` | ❓ 仅 schema 级 |
| pi / opencode / kimi / qwen 等 | `acp -- <各自的 ACP 命令>` | ❓ 仅 schema 级 |

---

## codex

**安装与登录**（三选一）：

```bash
npm i -g @openai/codex     # 或 brew install codex
codex login                # ① ChatGPT 订阅登录（Plus/Pro，无需 API key）
export OPENAI_API_KEY=...  # ② 或 OpenAI API key
# ③ 或 ~/.codex/config.toml 配自定义 provider（[model_providers.*] 指向自己的
#    网关/本地模型）。注意：codex ≥0.149 强制 wire_api = "responses"。
```

**启动**：

```bash
node cli.mjs codex --port 3948 --approval on-request
```

**行为要点**：

- 默认 **read-only 沙箱**：可读可推理，逃逸沙箱的命令被拒绝。`--sandbox workspace-write` 放开写（要联网再加 `--network`）。
- `--approval on-request` 才会向客户端发 `approval` 事件；默认 `never` 不发——命令按沙箱策略直接执行或被拒。
- 图片（data:/https URL）直接透传给模型。
- 桥重启后会话从磁盘恢复（codex 自己持久化线程）。

## claude code

**关键前提：claude code 本体不会说 ACP**。需要一个翻译壳——ACP 官方组织维护的 `claude-agent-acp`（很薄，不含 claude 本体、不单独登录；底层用 Anthropic 官方 Agent SDK 驱动你已装好的 claude code）。链路是：

```
agent-bridge ──ACP v1 (stdio，桥自动协商)──► claude-agent-acp ──Agent SDK──► claude code
```

**安装与登录**：

```bash
npm i -g @anthropic-ai/claude-code    # claude code 本体（若未装）
claude                                # 首次运行完成登录（订阅或 API key）
npm i -g @agentclientprotocol/claude-agent-acp   # ACP 翻译壳（ACP 官方组织维护）
```

**启动**：

```bash
node cli.mjs acp -- claude-agent-acp
# 免全局安装的等价写法：
node cli.mjs acp -- npx -y @agentclientprotocol/claude-agent-acp
# 备选：Zed 维护的旧壳 @zed-industries/claude-code-acp（命令 claude-code-acp）同样可用
```

**行为要点**：

- **没有 `--approval` 旗标可配**——什么时候发审批由 claude 自己的权限体系决定：allowlist 之外的工具调用才问，`always` = claude 记住放行（它的持久化）。桥一律转发。
- **没有 `--sandbox`**——安全策略归 claude 自己管，桥不干预。
- 桥重启后会话恢复：官方壳支持 ACP `session/resume`（claude-agent-acp 会透传成 `claude -p --resume`，已实测方法存在）。
- 图片能力取决于它向 ACP 声明的 `promptCapabilities.image`（claude-agent-acp 已声明 `image: true`）；没声明会自动降级为文本提示（不落盘）。
- 无凭证时表现已实测：session 正常创建，回合以干净的 `Authentication required` SSE error 结束。

## codex 的 ACP 备选路线（官方壳）

`node cli.mjs acp -- codex-acp`（`npm i -g @agentclientprotocol/codex-acp`）也能把 codex 挂进桥——2026-09-07 已过桥实测真回合（volcengine 网关，start → done + usage 全通）。**但有一个上游缺陷**：非流式后端（只发 `item/completed` 不发 delta，例如 deepseek 网关）会把最终答案文本整个丢掉——turn 以 `end_turn` 结束但 `full` 为空（codex-acp 对 completed 的 agentMessage 直接 `return null`，只转发 delta）。主推荐仍是专用 adapter 路线（有 completed-items 兜底，不受影响）。

## 其他 ACP v2 agent

任何在 stdio 上说 ACP v2 的命令都能接：`node cli.mjs acp -- <命令>`。

- **gemini**：原生支持 ACP，无需壳——`node cli.mjs acp -- gemini --experimental-acp`（需先 `gemini` 登录）。
- **pi**：社区壳（如 [nat-e/pi-acp](https://github.com/nat-e/pi-acp)，底层是 `pi --mode rpc`），安装方式见其仓库。
- **opencode / kimi / qwen 等**：各自的 ACP 支持方式以其官方文档为准；核心判断只有一条——`--` 后面跟的命令得能在 stdio 上说 ACP v2。

## 故障排查

- **报问题时把桥终端里 `[acp]` / `[bridge]` 开头的行一起贴上**——它们覆盖了握手协商、会话创建/恢复、每回合的 prompt 与响应（含 stopReason 和 usage）、审批请求、以及被忽略的未知通知，能直接定位问题在哪一层。
- `codex CLI not found: 'codex' …` / `agent command not found: '…'` —— agent 二进制没装或不在 PATH；装上，或用 `--codex-bin` / 换命令指定路径。
- codex 模式收不到审批事件 —— 启动时没带 `--approval on-request`。
- 换了桥后面的 agent 之后旧对话报错 —— sessionId 是 agent 私有的（codex 线程 id ≠ claude 会话 id），清掉对话历史重新开始即可。
- 别的都正常但某个 agent 行为诡异 —— 先看是不是上表里"仅 schema 级"的：没实机验证过的 agent，坑就是我们下一步要填的，欢迎把现象带回来。
