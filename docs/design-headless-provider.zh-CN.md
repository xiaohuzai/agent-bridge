# Orca 扫描、headless provider 与 browsa 直连评估

> 2026-10-21。本文记录三件事：① 对 stablyai/orca 的 agent 连接层做源码级扫描的结论；
> ② agent-bridge 从中借鉴并已落地的东西（`adapters/headless-cli.mjs` 与 zcode 接入）；
> ③ browsa 能否绕过 agent-bridge 直连 agent 的评估。协议事实均来自实机抓取，
> 不是文档抄录。

## 结论先行

1. **Orca 不是"某种协议统一了 40 个 agent"，而是三层解耦**：控制面用 PTY 注入按键，
   观察面用各 agent 自己的 hook/插件回调 + 磁盘 transcript，只有少数 agent 走
   SDK / app-server / ACP 加速。它的可扩展性来自**配置表 + 结构化状态**，不是屏幕解析。
2. **agent-bridge 已借鉴的部分**：把"每家一条配置"的思路落在 headless CLI 上——
   `kind: 'headless'` + profile 表 + 结构化 JSONL 事件，首个 profile 是 ZCode。
   ZCode 现在走官方 `zcode -p … --output-format stream-json`，真机两回合验证通过
   （流式、工具行、usage、`--resume` + 缓存）。
3. **browsa 直连 agent 不成立（对现有 agent 群）**：浏览器扩展不能 spawn 进程、
   不能读 agent 的 stdio/磁盘会话库，只能连 localhost 上"已经有人起好的"HTTP/WS 服务。
   codex / claude / zcode 的机器接口都是 stdio。直连只对自带 server 的 agent
   （如 `opencode serve`）有理论可能，但仍需有人负责启动/鉴权/生命周期——那就是桥。
   结论：**保留桥作为进程所有者**；直连只作为未来针对 HTTP-native agent 的可选特例。

---

## 1. Orca 的 agent 连接层（源码扫描）

扫描对象：`stablyai/orca` HEAD（2026-10-21），重点文件
`src/shared/tui-agent.ts`、`src/shared/tui-agent-config.ts`、
`src/shared/agent-hook-relay.ts`、`src/shared/agent-hook-listener/**`、
`src/main/agent-hooks/README.md`。

### 1.1 三层结构

| 层 | 做什么 | 实现 |
|---|---|---|
| **控制面** | 启动 agent、把 prompt 送进去 | PTY（`node-pty`）+ xterm-headless 屏幕状态 + 每 agent 的注入模式/就绪信号/信任预检 |
| **观察面** | 知道 agent 在干什么 | ① managed hooks：把各 agent 的 hook/插件/扩展装进它自己的配置，事件 POST 到 Orca 的 loopback hook server；② OSC 7501（Program Status Protocol）从 PTY 输出兜底；③ 磁盘 transcript 读取 |
| **协议加速器（可选）** | 更完整的流式/审批/会话 | Claude → Agent SDK；Codex → app-server；Grok/Antigravity/omp/opencode → ACP 方言；其余 40 多个全走终端 |

关键不变量：**协议不是准入门槛**。一个 agent 只要能在终端里跑，就能进 Orca；
协议实现只是"如果有，就用更完整的那个"。

### 1.2 45-agent 配置表

`TUI_AGENT_CONFIG_SOURCE` 是一家一行：`detectCmd` / `launchCmd` / `expectedProcess` /
`promptInjectionMode` / 就绪与提交信号 / 逐 agent 怪癖（Windows 编码、粘贴重试、
trust 预设等）。注入模式共 6 种：`argv`、`stdin-after-start`、`flag-prompt`、
`flag-prompt-interactive`、`flag-interactive`、`hermes-query`。

ZCode 那一行（原文要点）：

- `detectCmd: 'zcode'`，`expectedProcess: 'zcode-cli'`（CLI 自己把 process.title 改成
  `zcode-cli`，否则前台进程识别永远匹配不上）。
- `promptInjectionMode: 'stdin-after-start'`——因为 ZCode 把 `positionals[0]` 当子命令，
  argv 直接传 prompt 会 `Unknown command`；而 `-p` 是 headless 单次模式、跑完就退出。
- `draftPasteReadySignal: 'zcode-composer-prompt'`——ZCode 的 ASCII banner 一直重绘，
  "安静窗口"永远不成立，只能等 composer 边框这个真实信号；配了录像 fixture
  `zcode-composer-ready`。

### 1.3 hook 观察面（最值得注意的部分）

Orca 给每个支持的 agent 安装自己的 hook 配置，agent 在生命周期节点上 POST JSON 到
`http://127.0.0.1:<hook-port>/hook/<source>`。ZCode 的事件词表（`zcode-events.ts`）：

| 事件 | 含义 |
|---|---|
| `SessionStart` | 新会话/恢复/clear；`source` 在 `startup|resume|clear` 时落一条 idle 边界行 |
| `UserPromptSubmit` | 用户提交，真正的回合边界 |
| `PreToolUse` / `PostToolUse` / `PostToolUseFailure` | 工具开始/结束/失败 |
| `PermissionRequest` | 审批卡已经上屏、在等人类回答（只在需要人工时触发） |
| `Stop` | 回合结束；`is_interrupt` 表示被中断 |

payload 同时写一套 Claude 兼容别名：`hook_event_name`、`tool_name`、`tool_input`、
`transcript_path`、`last_assistant_message`。所以 Orca 直接复用了 Claude 的字段抽取器。

优先级规则：**hooks 赢，OSC 7501 补空**。hooks 关闭/没装/静默 2 分钟时，OSC 7501
（终端转义序列里的状态报告）接管；下一个 hook 事件再把行拿回去。

### 1.4 其他可复用的工程习惯

- **声明式状态规则**：每个 agent 一个 JSON 规则文件（屏幕锚点 → 状态），不是散落的 if-else。
- **录像 fixture + 回放测试**：把真实 TUI 会话录成 fixture，重放锁住适配行为
  （`capture-agent-pty-transcript.mjs`、`composerReadyCaptures`）。
- **trust 预检**：每个 agent 的首次信任菜单会吞掉粘贴内容，Orca 在启动前写好 trust 标记。
- **三层解耦**：控制面（TUI 注入）、观察面（优先读磁盘会话库，终端输出兜底）、
  元数据面（读本地凭据算用量）。三者互不依赖。

---

## 2. agent-bridge 借鉴了什么

### 2.1 已落地：headless CLI provider（本次）

把 Orca"一家一行配置"的思路从 TUI 搬到 **headless 面**：

- `agents-registry.mjs` 的条目声明 `kind: 'headless'`、`profile`、默认 `command`、
  `mode` 与允许值。
- `adapters/headless-cli.mjs` 负责 transport + 生命周期（每回合 spawn、JSONL 解析、
  中止、会话续接、错误映射）；每家 agent 只差一个 profile（argv 模板 + 事件解析）。
- 首个 profile 是 zcode；新增 agent 的成本是"一条 profile + 一段 fixture"，
  与 Orca 摊薄 40 个 agent 的方式同构。

与 Orca 的对应关系：

| Orca | agent-bridge 的对应物 |
|---|---|
| 45 行 TUI 配置表 | registry 条目 + `HEADLESS_PROFILES` |
| 按模式注入 prompt | headless argv 模板（`-p`、`--resume`、`--cwd`） |
| 结构化 hook 事件 | CLI 自己的 `--output-format stream-json` 事件 |
| 录像 fixture 回放 | `test/fake-zcode-cli.mjs` + 真机抓取的事件 schema |
| trust 预检 | `mode` 预选（plan 默认，yolo 必须显式） |

### 2.2 没有照搬（以及为什么）

- **PTY/屏幕解析**：agent-bridge 的定位是协议适配，不做 UI 自动化；屏幕状态是最脆的一层。
- **往用户全局配置装 hook**：Orca 有完整的 installer/lock/清理机制；桥去改
  `~/.zcode/hooks.json` 会和其他工具（本机已有 OpenViking 的 hooks）抢配置，
  收益也不如 headless 事件流直接。将来若要做，必须是显式 opt-in + 合并写 + 退出清理。
- **OSC 7501**：只对 PTY 有意义，桥不拥有终端。

### 2.3 可选未来项

- **hook 事件接入**：对只有 TUI、没有 headless/JSON 输出的 agent，hooks 是比屏幕解析
  更稳的观察面。前提是配置合并与生命周期管理。
- **transcript tail**：headless CLI 只给最终 JSON 时，可从 agent 落盘的 transcript
  补实时增量；ZCode 已经给了 stream-json，暂不需要。

---

## 3. browsa 能否绕过 agent-bridge 直连 agent？

### 3.1 浏览器的硬约束

- 扩展**不能 spawn 进程**、不能读任意本地文件、不能开原始 TCP；只能 `fetch`/WebSocket
  到 localhost（或远程）上**已经存在**的服务。
- 因此"直连"的前提是：agent 自己就是一个本地 HTTP/WS 服务，而且用户已经把它启动好了。

### 3.2 现实中的 agent 接口面

| agent | 机器接口 | 浏览器能否直连 |
|---|---|---|
| codex | `app-server`（stdio JSON-RPC） | ❌ 需要进程所有者 |
| claude code | Agent SDK / stdio ACP shim | ❌ |
| zcode | `-p --json`（stdio 一次性）、`app-server`（stdio）、桌面 server（stdio 二进制 RPC） | ❌（`zcode --web` 例外，见下） |
| gemini / qoder / pi / dsh | ACP（stdio） | ❌ |
| opencode | `opencode serve`（本地 HTTP） | ✅ 理论上可以 |
| zcode `--web` | 二进制 RPC over `/ws` | ⚠️ 可以但要实现二进制分帧 + VQL 序列化，且需用户先起 server |

zcode 的 `--web` 是一个真实存在的例外（原生适配器的注释里有记录：桌面 app 与
`zcode --web` 走同一套 binary RPC）。但直连它意味着：在浏览器里重写一遍二进制协议、
自己处理鉴权/CORS/重连、以及"用户必须先手动启动 `zcode --web`"的部署成本。
对 browsa 来说，这比"连桥的一个 SSE 端点"复杂得多。

### 3.3 Native Messaging 也不是答案

Chrome/Firefox 的 native messaging 允许扩展和本地进程通信，但仍需安装一个 host
manifest + 一个 broker 进程；broker 要做的事（spawn agent、转发 stdio、生命周期）
就是 agent-bridge 的缩小版，而且只支持桌面 Chrome/Firefox，失去"任何客户端"的通用性。

### 3.4 结论

**保留 agent-bridge 作为唯一的进程所有者。** 直连只在"agent 自带 HTTP server +
用户愿意手动运维"的场景成立，且每个 agent 一套协议，正好抵消了桥的价值。
如果未来要支持，建议以**可选 provider** 的形式加在 browsa 侧，而不是把桥拆掉：
- `opencode serve` 这样有稳定 HTTP API 的，browsa 可以直接配 endpoint；
- 其余 stdio-only agent 继续走桥；
- 桥本身仍是统一的鉴权、CORS、心跳、断连中止和会话续接层。

---

## 4. ZCode 接入：路线与实测

### 4.1 四条路线

| 路线 | 结论 |
|---|---|
| **native 适配器**（桌面 stdio server 的二进制 RPC） | ❌ 2026-10-21 复测：桥拉起的 server 注册好 provider 后，回合一开始就 `ZCode Protocol client is disposed`。暂停。 |
| **`zcode app-server`**（ZCode Protocol stdio） | ⏳ 最完整的潜在路线（流式/审批），但协议未公开、需要逆向；不是本次目标。 |
| **headless CLI**（`-p --output-format stream-json`） | ✅ 本次采用。官方外部驱动面，事件完整度足够 v1。 |
| TUI（PTY） | ❌ 桥不做屏幕解析；也是 Orca 的兜底路线，不是我们的。 |

### 4.2 headless 事件 schema（实机抓取）

命令：

```bash
zcode -p '<text>' --output-format stream-json --no-color --mode plan --cwd <dir> [--resume sess_…]
```

stdout 是 JSONL，每行一个 envelope：

```json
{"type":"…","sessionId":"sess_…","turnId":"turn_…","seq":N,"payload":{…}}
```

| type | 用途 | 映射到 v1 |
|---|---|---|
| `session.updated` | 含 hook 运行生命周期（`payload.hookEventName`）——对桥是噪声 | 忽略 |
| `session.titleUpdated` | 首条输入生成的标题 | 忽略 |
| `turn.started` | 回合开始，带 turnNumber/input/modelSelection | 提供 turnId |
| `model.streaming` | `kind`: `start`/`reasoning_start`/`reasoning_end`/`tool_input_*`/`tool_call`/`text_start`/`text_delta`/`text_end`/`finish` | `text_delta` → `delta`；reasoning 增量包 `<thinking>` |
| `tool.updated` | `kind`: `scheduled`（含 input）/`started`/`result`/`batch` | `tool` 行，按 `toolCallId` 配对 |
| `streamRecovery.updated` | 流恢复锚点 | 忽略 |
| `turn.completed` | `response`、`usage`、`resultType`、`toolCallCount` | `usage` + `done` |
| `result` | 最后一行：response/usage/sessionId/projection | 兜底 done/usage |

实测数字（本机 WSL，2026-10-21，CLI 0.17.0 / server 3.16.2）：

- PONG 回合 12.7s；Read 工具回合 18.5s；`--resume` 回合 15.3s。
- 新会话输入约 28K token（CLI 自己的系统提示/工具）；续接回合 28.5K 输入里
  22,528 来自 provider 缓存。
- Read 工具事件序列：`scheduled`（input.file_path）→ `started`（readOnly:true）→
  `result`（content）→ `batch`。

### 4.3 边界

- **无交互审批**：headless 没有审批卡；`-p` 默认 `yolo`。桥默认 `plan`（只读），
  条目可显式设 `build` / `edit` / `guarded` / `yolo`。
- **无图片**：CLI 只接受本地文件 `--attach`，桥不把 data:/https 图片写盘 → 降级提示。
- **每回合一个进程**：冷启动 2–4s，输入 token 固定开销约 28K；续接靠 `--resume`。
- **会话归属**：会话在 `~/.zcode` 的持久化里，`sess_…` 跨桥重启可续。

### 4.4 为什么这符合仓库的不变量

- v1 协议冻结：只新增 registry 条目与 `headless` 内部 kind，事件语义不变。
- 零运行时依赖：只 spawn 用户自己的 CLI，不新增 npm 包。
- 协议事实实机验证：事件 schema、resume、缓存、工具行都来自 2026-10-21 的真机抓取，
  记录在 `adapters/headless-cli.mjs` 头部与 `docs/agents*.md`。
- 用户优先：CLI 走 PATH，找不到时回退到桌面版自带路径，绝不内置固定版本。
