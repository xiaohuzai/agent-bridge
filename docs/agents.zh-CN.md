<p align="center"><a href="./agents.md">English</a> · <strong>简体中文</strong></p>

# 各 agent 接入指南

agent-bridge 对客户端只有一套接口；agent 之间的差异全部在**怎么把桥跑起来**。两种模式：`codex`（专用 adapter），`acp -- <命令>`（通用 adapter，接任何说 ACP v2 的 agent）。

验证状态一览（诚实优先，跑通了或踩坑了请回报，我们来更新）：

| agent | 启动方式 | 实机验证 |
|---|---|---|
| codex | `codex` 模式（专用 adapter） | ✅ 已验证（codex-cli 0.149.1） |
| claude code | `acp -- claude-code-acp` | ⏳ 实机验证进行中 |
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

**关键前提：claude code 本体不会说 ACP**。需要一个翻译壳——Zed 官方维护的 `claude-code-acp`（很薄，不含 claude 本体、不单独登录；底层用 Anthropic 官方 Agent SDK 驱动你已装好的 claude code）。链路是：

```
agent-bridge ──ACP v2 (stdio)──► claude-code-acp ──Agent SDK──► claude code
```

**安装与登录**：

```bash
npm i -g @anthropic-ai/claude-code    # claude code 本体（若未装）
claude                                # 首次运行完成登录（订阅或 API key）
npm i -g @zed-industries/claude-code-acp   # ACP 翻译壳（Zed 官方维护）
```

**启动**：

```bash
node cli.mjs acp -- claude-code-acp
# 免全局安装的等价写法：
node cli.mjs acp -- npx -y @zed-industries/claude-code-acp
```

**行为要点**：

- **没有 `--approval` 旗标可配**——什么时候发审批由 claude 自己的权限体系决定：allowlist 之外的工具调用才问，`always` = claude 记住放行（它的持久化）。桥一律转发。
- **没有 `--sandbox`**——安全策略归 claude 自己管，桥不干预。
- 桥重启后会话恢复走 ACP `session/resume`；claude-code-acp 是否完整支持，实机验证中。
- 图片能力取决于它向 ACP 声明的 `promptCapabilities.image`；没声明会自动降级为文本提示（不落盘）。

## 其他 ACP v2 agent

任何在 stdio 上说 ACP v2 的命令都能接：`node cli.mjs acp -- <命令>`。

- **gemini**：原生支持 ACP，无需壳——`node cli.mjs acp -- gemini --experimental-acp`（需先 `gemini` 登录）。
- **pi**：社区壳（如 [nat-e/pi-acp](https://github.com/nat-e/pi-acp)，底层是 `pi --mode rpc`），安装方式见其仓库。
- **opencode / kimi / qwen 等**：各自的 ACP 支持方式以其官方文档为准；核心判断只有一条——`--` 后面跟的命令得能在 stdio 上说 ACP v2。

## 故障排查

- `codex CLI not found: 'codex' …` / `agent command not found: '…'` —— agent 二进制没装或不在 PATH；装上，或用 `--codex-bin` / 换命令指定路径。
- codex 模式收不到审批事件 —— 启动时没带 `--approval on-request`。
- 换了桥后面的 agent 之后旧对话报错 —— sessionId 是 agent 私有的（codex 线程 id ≠ claude 会话 id），清掉对话历史重新开始即可。
- 别的都正常但某个 agent 行为诡异 —— 先看是不是上表里"仅 schema 级"的：没实机验证过的 agent，坑就是我们下一步要填的，欢迎把现象带回来。
