<p align="center"><a href="./agents.md">English</a> · <strong>简体中文</strong></p>

# 各 agent 接入指南

agent-bridge 对客户端只有一套接口；agent 之间的差异全部收敛为 **agents.json 里的一条配置**。无论单个还是多个，启动方式只有一种：

```bash
node cli.mjs serve            # 读 ./agents.json（或：serve --config FILE）
```

验证状态一览（诚实优先，跑通了或踩坑了请回报，我们来更新）：

| agent | agents.json 条目 | 实机验证 |
|---|---|---|
| codex | `{ "name": "codex", "port": 3948, "apiKey": "", "approval": "on-request" }` | ✅ 已验证（codex-cli 0.149.1） |
| codex 走官方壳 | 注册表加一行 + `{ "name": "codexacp", "port": …, "command": ["codex-acp"] }`（见下） | ⚠️ 过桥真回合 ✅；非流式后端丢答案文本（上游缺陷，见下） |
| claude code | `{ "name": "claude", "port": 3949, "apiKey": "" }` | ✅ macOS 2026-09-08——真回合（流式完整）、会话连续、usage、审批流程；断连中断与桥重启续会话有测试覆盖，实机未跑 |
| gemini / pi / opencode / kimi / qwen 等 | 尚未进注册表——验证过后在 `agents-registry.mjs` 加一行（见下） | ❓ 仅 schema 级 |

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

**agents.json 条目**：

```json
{ "name": "codex", "port": 3948, "apiKey": "", "sandbox": "workspace-write", "approval": "on-request" }
```

**行为要点**：

- 默认 **read-only 沙箱**（`"sandbox": "read-only"`）：可读可推理，逃逸沙箱的命令被拒绝。`"workspace-write"` 放开写（要联网再加 `"network": true`）。
- `"approval": "on-request"` 才会向客户端发 `approval` 事件；默认 `"never"` 不发——命令按沙箱策略直接执行或被拒。
- 图片（data:/https URL）直接透传给模型。
- 桥重启后会话从磁盘恢复（codex 自己持久化线程）。
- codex 需在 PATH 上；否则用 `"codexBin": "/path/to/codex"` 指定。

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

**agents.json 条目**：

```json
{ "name": "claude", "port": 3949, "apiKey": "" }
```

- 免全局安装的等价写法：加 `"command": ["npx", "-y", "@agentclientprotocol/claude-agent-acp"]`。
- 备选壳：`"command": ["claude-code-acp"]`（Zed 维护的旧壳 `@zed-industries/claude-code-acp`）。

**行为要点**：

- **没有审批/沙箱旋钮可配**——什么时候发审批由 claude 自己的权限体系决定：allowlist 之外的工具调用才问，`always` = claude 记住放行（它的持久化）。桥一律转发。
- 桥重启后会话恢复：官方壳支持 ACP `session/resume`（claude-agent-acp 会透传成 `claude -p --resume`，已实测方法存在）。
- 图片能力取决于它向 ACP 声明的 `promptCapabilities.image`（claude-agent-acp 已声明 `image: true`）；没声明会自动降级为文本提示（不落盘）。
- 无凭证时表现已实测：session 正常创建，回合以干净的 `Authentication required` SSE error 结束。

## codex 的 ACP 备选路线（官方壳）

`npm i -g @agentclientprotocol/codex-acp` 也能把 codex 挂进桥——2026-09-07 已过桥实测真回合（volcengine 网关，start → done + usage 全通）。由于 serve 只认注册表名字，走这条路线需在 [`agents-registry.mjs`](../agents-registry.mjs) 加一行（`"codexacp": { "kind": "acp", "command": ["codex-acp"] }`）并写一条 `{ "name": "codexacp", … }` 配置。**但有一个上游缺陷**：非流式后端（只发 `item/completed` 不发 delta，例如 deepseek 网关）会把最终答案文本整个丢掉——turn 以 `end_turn` 结束但 `full` 为空（codex-acp 对 completed 的 agentMessage 直接 `return null`，只转发 delta）。上面的 codex 原生条目仍是主推荐（有 completed-items 兜底，不受影响）。

## 其他 ACP v2 agent

任何在 stdio 上说 ACP v2 的 agent，两行接入：[`agents-registry.mjs`](../agents-registry.mjs) 加一条注册（`"kimi": { "kind": "acp", "command": ["kimi-acp"] }`），agents.json 加一条引用（`{ "name": "kimi", "port": …, "apiKey": … }`）。注册表对客户端相当于「已支持」的宣称，所以等 agent 有过验证回合再加。

- **gemini**：原生支持 ACP，无需壳——注册表行是 `"gemini": { "kind": "acp", "command": ["gemini", "--experimental-acp"] }`（需先 `gemini` 登录）。
- **pi**：社区壳（如 [nat-e/pi-acp](https://github.com/nat-e/pi-acp)，底层是 `pi --mode rpc`），安装方式见其仓库。
- **opencode / kimi / qwen 等**：各自的 ACP 支持方式以其官方文档为准；核心判断只有一条——配置里的 command 得能在 stdio 上说 ACP v2。

这些都还没实机验证——把你的结果（好的坏的）带回来，我们更新表格。

## ACP 客户端（门）

每个条目还可以额外直接服务 ACP 客户端：写上 `"acp": true`，桥就在 `ws://<host>:<port>/acp` 说 ACP v1（`initialize` → `session/new` → `session/prompt`；审批请求以 `session/request_permission` 原样送达客户端，带 agent 自己的选项）。同端口、与 v1 相同的 apiKey 与 Host 规则；客户端 `session/new` 里的 cwd 会被忽略——agent 跑在条目配置的 `cwd`。设计说明见 [design-acp-front.zh-CN.md](./design-acp-front.zh-CN.md)。

把 agent 当本地命令启动的客户端（Zed、vscode-acp……）走 stdio 门：`node cli.mjs acp <条目名> [--config agents.json]`——该条目就变成 stdio 上的一个 ACP v1 agent（stdout 只走协议、日志走 stderr、不开端口；条目可以不写 `port`）。

## 故障排查

- **报问题时把桥终端里 `[acp]` / `[bridge]` 开头的行一起贴上**——它们覆盖了握手协商、会话创建/恢复、每回合的 prompt 与响应（含 stopReason 和 usage）、审批请求、以及被忽略的未知通知，能直接定位问题在哪一层。
- **回合里流出 `Reconnecting... waiting for network` 且一直重试** —— codex 连不上它的模型后端。最常见原因：自定义 provider 的鉴权来自**环境变量**（config.toml 的 `env_key`，如 `OPENAI_API_KEY`），它必须在你**起桥的那个终端**里已导出（`echo $OPENAI_API_KEY` 验证）——桥只继承起桥 shell 的环境，每个终端窗口是独立的。export 之后**同一终端**重新起桥。
- `codex CLI not found: 'codex' …` / `agent command not found: '…'` —— agent 二进制没装或不在 PATH；装上，或在配置条目里设 `"codexBin"` / `"command"`。
- codex 收不到审批事件 —— 条目里没写 `"approval": "on-request"`。
- 换了桥后面的 agent 之后旧对话报错 —— sessionId 是 agent 私有的（codex 线程 id ≠ claude 会话 id），清掉对话历史重新开始即可。
- 别的都正常但某个 agent 行为诡异 —— 先看是不是上表里"仅 schema 级"的：没实机验证过的 agent，坑就是我们下一步要填的，欢迎把现象带回来。
