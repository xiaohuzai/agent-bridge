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
| pi | `{ "name": "pi", "port": 3950, "apiKey": "" }` | ✅ 2026-09-11——经 svkozak/pi-acp 0.0.33 + pi 0.85.1 真回合（流式、工具调用），由 mock OpenAI provider 驱动；桥重启续会话（自动 `session/load` 回退）实机已跑 |
| gemini | `{ "name": "gemini", "port": 3951, "apiKey": "" }` | ✅ 2026-10-01——原生 `gemini --acp` 0.62.0 真回合（流式、shell 工具+审批请求、cancel），由 mock Google GenAI 后端驱动；桥重启续会话（`session/load` 回退）实机已跑；usage 走响应的 `_meta.quota.token_count`（已映射） |
| qoder | `{ "name": "qoder", "port": 3953, "apiKey": "" }` | ⚠️ 2026-10-15——握手/能力 + 鉴权边界实机验证（qoder-cli 1.1.71，未登录：ACP v1、图片 + embeddedContext、loadSession；`session/new` → `-32000 Authentication required`）；真实模型回合待有凭据的机器 |
| dsh（DeepSeek Harness） | `{ "name": "dsh", "port": 3952, "apiKey": "", "cwd": "/your/project" }` | ⚠️ 2026-10-09——协议链对 dsh 0.2.0-rc.2 实机验证（spawn → ACP v1 握手 → session/new → prompt → 干净的鉴权错误 SSE；模型调用本身需有凭据的机器）；图片通路 2026-10-10 验到 provider 边界（占位 key，出图回答待有凭据机器） |
| zcode | `{ "name": "zcode", "port": 3954, "apiKey": "", "mode": "plan" }` | ✅ 2026-10-21——经官方 headless CLI 真回合（流式增量、工具行、usage、`--resume` 命中 provider 缓存；PONG + Read 工具回合，走真实桥） |
| opencode / kimi / qwen 等 | 尚未进注册表——验证过后在 `agents-registry.mjs` 加一行（见下） | ❓ 仅 schema 级 |

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
- **市面上有两套壳包，别混用。** `@agentclientprotocol/claude-agent-acp`（二进制名 `claude-agent-acp`）是 ACP 官方组织维护的官方壳——我们验证的是它。`@zed-industries/claude-code-acp`（二进制名 `claude-code-acp`）是 Zed 维护的旧壳——也能用（都说 v1；chrome-acp 接的就是它），但我们的 session/resume 与能力声明结论都记录在官方壳上，优先用官方壳。

**行为要点**：

- **没有审批/沙箱旋钮可配**——什么时候发审批由 claude 自己的权限体系决定：allowlist 之外的工具调用才问，`always` = claude 记住放行（它的持久化）。桥一律转发。
- 桥重启后会话恢复：官方壳支持 ACP `session/resume`（claude-agent-acp 会透传成 `claude -p --resume`，已实测方法存在）。
- **会话在 `claude --resume` 里保持可见**（桥侧修复，2026-10-01）：claude CLI 2.x 给所有 SDK 驱动的转录自我盖章 `entrypoint:"sdk-cli"`——完全无视 `CLAUDE_CODE_ENTRYPOINT` 环境变量（实测：env 预设 `cli`，转录依然 `sdk-cli`）——而交互式 picker 隐藏 `sdk-*` 转录。因此注册表的 claude 条目启用了回合后改写：每回合落定后，桥把 `~/.claude/projects/*/<sessionId>.jsonl` 里的章翻成 `"cli"`（`adapters/claude-transcript-fix.mjs`，带重试以覆盖 claude 延迟落盘）。纯本地 JSON 手术——若 claude 改了目录布局/字段，改写自动空转，退回「不可见但按 id 可恢复」。会话落在条目 `cwd` 的项目里，picker 按目录划分显示（claude 自家的项目模型）。此修复之前写出的旧转录仍是旧章——手动 `sed -i '' 's/"entrypoint":"sdk-cli"/"entrypoint":"cli"/g' <file>` 逐条翻即可。
- 图片能力取决于它向 ACP 声明的 `promptCapabilities.image`（claude-agent-acp 已声明 `image: true`）；没声明会自动降级为文本提示（不落盘）。
- 无凭证时表现已实测：session 正常创建，回合以干净的 `Authentication required` SSE error 结束。

## pi

pi（earendil-works 出品）本体同样不说 ACP——社区壳 [`pi-acp`](https://github.com/svkozak/pi-acp)（npm 包 `pi-acp`）负责翻译，底层拉起 `pi --mode rpc`。链路是：

```
agent-bridge ──ACP v1 (stdio，桥自动协商)──► pi-acp ──`pi --mode rpc`──► pi
```

**安装与登录**（要求 pi ≥ 0.80.4、Node ≥ 22）：

```bash
npm i -g @earendil-works/pi-coding-agent pi-acp
pi                                      # 首次运行：选 provider / 登录
# 自定义或 OpenAI 兼容端点：~/.pi/agent/models.json（settings.json 里设
# defaultProvider/defaultModel）。pi-acp 也有 `pi-acp --terminal-login`，
# 用于 Terminal Auth（ACP Registry）。
```

- **pi 已经用官方自安装装过？**（pi ≥ 0.98 自安装到 `~/.pi/agent/bin/pi`，软链进 `~/.local/bin`。）那只装壳——`npm i -g pi-acp`——别再装 npm 的 `pi` 包：它自带一个 `pi` bin,会和自安装的软链撞 `EEXIST`（2026-10-01 实踩）。另外任何 `npm i -g` 之后先重启终端再测——会话里残留的 PATH/软链中间态会产生莫名其妙的「executable not found」。
- **终端里找得到 pi、桥却找不到？**daemon 的 PATH 可能比你的 shell 窄。pi-acp 0.0.34+ 支持 `PI_ACP_PI_COMMAND`——用条目的 `env` 指绝对路径：`"env": { "PI_ACP_PI_COMMAND": "/Users/you/.pi/agent/bin/pi" }`。

**agents.json 条目**：

```json
{ "name": "pi", "port": 3950, "apiKey": "" }
```

- 免全局安装的等价写法：`"command": ["npx", "-y", "pi-acp"]`。

**行为要点**（2026-09-11 对 pi-acp 0.0.33 + pi 0.85.1 实测）：

- **没有 usage 事件。** pi 不上报 token 计数（没有 `usage_update`，prompt 响应里也没有）——`done` 事件的 `usage` 为 null。
- **内置工具自动执行。** pi 的 bash/read/edit/write 不询问直接跑——不发 `approval` 事件。唯一的 `session/request_permission` 来自 pi *扩展*的 UI 询问（select/confirm），桥按普通审批转发。
- 图片可用：pi-acp 声明 `promptCapabilities.image: true`，data:/https URL 直接透传。
- **会话可跨桥重启恢复。** pi-acp 拒绝 ACP `session/resume`（方法不存在），只实现了 `session/load`——桥先试 resume、失败自动回退 load；pi-acp 用自己持久化的映射表恢复同一个会话 id。
- 斜杠命令（`/compact`、`/session`、`/thinking`……）当普通文本发即可——pi-acp 会在 pi 触发模型调用前截获。
- pi-acp 的启动横幅（版本 + 已装 skills）在回合外发送；桥会丢弃，首个回合的流不会被污染。

## codex 的 ACP 备选路线（官方壳）

`npm i -g @agentclientprotocol/codex-acp` 也能把 codex 挂进桥——2026-09-07 已过桥实测真回合（volcengine 网关，start → done + usage 全通）。由于 serve 只认注册表名字，走这条路线需在 [`agents-registry.mjs`](../agents-registry.mjs) 加一行（`"codexacp": { "kind": "acp", "command": ["codex-acp"] }`）并写一条 `{ "name": "codexacp", … }` 配置。**但有一个上游缺陷**：非流式后端（只发 `item/completed` 不发 delta，例如 deepseek 网关）会把最终答案文本整个丢掉——turn 以 `end_turn` 结束但 `full` 为空（codex-acp 对 completed 的 agentMessage 直接 `return null`，只转发 delta）。上面的 codex 原生条目仍是主推荐（有 completed-items 兜底，不受影响）。（注：市面上还有 Zed 的 `@zed-industries/codex-acp`；这里实测的是官方 `@agentclientprotocol/codex-acp`。）

**2026-10-06 复评（用户拍板：留原生）。** browsa 一份现场报告（只发了个 "hi"，回复里模型的自述和回答粘在一起）触发重新对比。codex app-server 协议（0.149.1 schema）有**官方边界信号**——agentMessage item 带 `phase: "commentary" | "final_answer"`（schema 原文：区分临时自述与最终回答；各 provider 发得不一致，None 视为未知保持兼容）。codex-acp 认识 phase 但只通过 `_meta.jetbrains.air.phase` 转发给 AIR 客户端（JetBrains 扩展）——普通 ACP 客户端拿到的还是扁平 `agent_message_chunk` 文本、没有边界，修泄漏的代码反正要落在我们自己的 ACP 门里、且只能用「末条=回答」启发式而非真信号。上面的 completed 丢文本缺陷在 main 分支也仍在（2026-10-06 源码核实）。**一票否决点（用户，2026-10-06）**：codex-acp 把 `@openai/codex: ^0.159.1` 列为常规依赖——采用它等于往 agent-bridge 依赖树里再装一份 codex CLI，违背「CLI 留在用户自己手里、绝不装第二份」的 user-first 原则。原生适配器现按 phase 分类（commentary → `note` 事件，其余 → done.full；null phase 回落末条启发式）——详见适配器头注。

## 其他 ACP v2 agent

任何在 stdio 上说 ACP v2 的 agent，两行接入：[`agents-registry.mjs`](../agents-registry.mjs) 加一条注册（`"kimi": { "kind": "acp", "command": ["kimi-acp"] }`），agents.json 加一条引用（`{ "name": "kimi", "port": …, "apiKey": … }`）。注册表对客户端相当于「已支持」的宣称，所以等 agent 有过验证回合再加。

候选命令（已与生态交叉核对，各 CLI 需先安装并登录）：

- **qwen**：`"qwen": { "kind": "acp", "command": ["qwen", "--acp"] }`（`npm i -g @qwen-code/qwen-code`）。
- **opencode**：`"opencode": { "kind": "acp", "command": ["opencode", "acp"] }`。
- **auggie**（Augment Code）：`"auggie": { "kind": "acp", "command": ["auggie", "--acp"] }`。
- **kimi 等**：各自的 ACP 支持方式以其官方文档为准；核心判断只有一条——配置里的 command 得能在 stdio 上说 ACP（桥接受 protocolVersion 1 或 2）。

这些都还没实机验证——把你的结果（好的坏的）带回来，我们更新表格。

## gemini

原生 ACP，无需壳——注册表行 `"gemini": { "kind": "acp", "command": ["gemini", "--acp"] }`（`npm i -g @google/gemini-cli`；0.62 起旗标是 `--acp`，`--experimental-acp` 仍可用但已弃用）。首回合前的鉴权三选一：跑一次 `gemini` 登录，或设 `GEMINI_API_KEY`，或把 `GOOGLE_GEMINI_BASE_URL` 指到网关——env 鉴权时 ACP 的 `session/new` 不需要 `authenticate`。

实机验证 2026-10-01（gemini-cli 0.62.0，mock Google GenAI 后端，过桥真回合）：protocolVersion 1（prompt 响应即终结者）；流式 delta；shell 工具在危险命令上会发 `session/request_permission`（按 kind 映射选项）；cancel 后挂起的 prompt 会应答 `stopReason:'cancelled'`；usage 在响应的 `_meta.quota.token_count`（桥已映射）；`session/resume` 被拒（`-32601`），桥重启走 `session/load` 恢复；声明了图片能力（`promptCapabilities.image`）但实机未跑图片回合。文件读写由 CLI 在本地完成——桥不会收到 fs 代理请求。

## qoder

原生 ACP，无需壳——注册表行 `"qoder": { "kind": "acp", "command": ["qoder", "--acp"] }`（[docs.qoder.com/cli/acp](https://docs.qoder.com/cli/acp)；安装：`curl -fsSL https://qoder.com/install | bash`，或旧法 `npm i -g @qoder-ai/qodercli`，需 Node ≥ 20）。首回合前的鉴权二选一：跑一次 `qoder login`（浏览器流程——ACP 与 CLI 共享登录态），或经条目 `env` 设 `QODER_PERSONAL_ACCESS_TOKEN`（qoder.com/account/integrations 获取）——两种方式都不需要 ACP `authenticate` 调用，鉴权是环境态的，同 gemini。

```json
{ "name": "qoder", "port": 3953, "apiKey": "" }
```

链路验证 2026-10-15（qoder-cli 1.1.71，容器，未登录——握手、能力与鉴权边界；真实模型回合待有凭据的机器）：protocolVersion 1（prompt 响应即回合终结者——v1 路径）；通告 `loadSession`、`promptCapabilities {image, embeddedContext}`、会话 resume/fork/list/close/delete、MCP http/sse；未登录时 `session/new` 报 `-32000 Authentication required`，桥会作为该回合的错误转出。首个**并发审批**的 agent：并行工具调用会把两条 `session/request_permission` 在同一批里发出（无标题；kind 是标准的 `allow_once`/`reject_once`）——桥对其串行化（答完一张放行下一张），单审批卡客户端（browsa）无需改动即可用。源码读面证实 qoder-cli 是 gemini-cli 衍生——方言可预期与 gemini 同源。

## dsh（DeepSeek Harness）

原生 ACP——browsa/agent-bridge 拉起的是 **openma ACP 适配器**（`@openma/deepseek-harness-acp`，`command: ["dsh-acp"]`）：第三方 ACP v1 stdio agent，**进程内组装 dsh harness**（Apache-2.0、带 CI、第三方 dsh-ACP 适配器里装机量第一）。它与 dsh 桌面版/Web 共享 `~/.dsh`——同一凭据存储、设置、预设与会话日志，在这里开的会话会出现在桌面应用的会话列表里。

**安装**：

```bash
npm i -g @openma/deepseek-harness-acp
```

standalone 适配器的凭据是共享 `~/.dsh` 存储里的 **API key**：`dsh-acp login`（贴 key，隐藏输入）、dsh Web UI（设置 → 模型）、适配器的本地浏览器登录页，三者写的都是同一个 `~/.dsh/.credentials.yaml`（mode 600）。路由/模型选择走被拉起进程自己的旗标，经条目的 `args` 传入；不带 args 用 dsh 产品默认 `deepseek-official`，读的就是该存储里的 `refs.DEEPSEEK_API_KEY`。

实机验证 2026-10-09/10（适配器 0.4.37 对 dsh 0.2.0-rc.2）：握手答 protocolVersion 1；`loadSession`/`fork`/图片/`embeddedContext` 能力全开；**token 级流式**——dsh 0.2 把 token 增量发布在进程内事件 `agent/assistant-stream` 上，本适配器正是订阅者（官方 `@deepseek-ai/dsh-acp-app` profile 投递的是整条已提交消息）；权限走标准 ACP `session/request_permission`，默认预设 `workspace-write`；审批「本次总是」会把该会话策略翻成 never；steering（`_session/steering`）有通告；`session/cancel` 真中断运行中的回合。2026-10-10 经 browsa 跑通真实端到端回合（默认路由 + 已存 key）。

**图片**：能传。适配器握手即通告 `promptCapabilities.image`，桥把 `images` 数组里的 data:/https URL 转成 ACP image 内容块随 prompt 透传（v1 限制 2026-10 放宽为单请求 ≤18 张、请求体 ≤16MB——纯松弛，旧客户端不变）。harness 侧的图片准入管线真实执行（png/jpeg/webp/gif；张数/聚合字节/单图字节/像素预算超限是结构化报错、不静默吞图——上限值源自码读面）。模型侧分两路（源码读面）：模型目录里 `deepseek-flash`（DeepSeek-V41-Flash）声明 `inputModalities: ["text","image"]`、图真实进请求；`deepseek-v4-pro` 无 image 模态，带图回合不报错、图在更上游被投影成文本占位符。实机 2026-10-10（VPS，占位 key）：默认路由带 1 图的 `session/prompt` 通过准入、请求真实发出后被 DeepSeek 401 挡下（provider request_id 在案）——图片通路验到 provider 边界；真实出图的完整回合仍待有凭据的机器跑一次。回程不传图：v1 的 delta 只有文本。

```json
{ "name": "dsh", "port": 3952, "apiKey": "", "cwd": "/your/project" }
```

**桌面可见性**——这里创建的会话会自动登记进「realpath 规范化路径与条目 `cwd` 匹配」的那个 dsh 工作区，从而出现在桌面/Web 的会话列表里（尽力而为，每个回合重新补登）。若没有任何工作区拥有该目录，桥会**自行补建工作区记录**——与 dsh 自家注册表同形（workspace domain v2：表记录 + id 头插进渲染顺序）；未来 dsh 若改了这个格式，桥会保持不写并只打日志。桌面端启动时一次性读入工作区注册表、不监听文件变化——桌面开着时新建的会话在它下次启动时出现（想立刻看到就重启桌面）。`cwd` 默认取 serve 进程的启动目录——建议显式指到一个你真想让会话（以及 agent 的文件/bash 工具）落着的目录。

### 路由选择：API key（已验证）vs 账户余额（dsh 侧、未验证）

- **API key 路由（端到端已验证）**：产品默认 `deepseek-official`。存一次 key——`dsh-acp login`、dsh Web UI（设置 → 模型）、或起桥环境里的 `DEEPSEEK_API_KEY`——条目不带 `args` 即可。
- **账户路由**：dsh 本体也认 `--provider deepseek-account`，桌面登录的 grant 也确实在共享 `~/.dsh` 存储里——但 standalone 适配器自己暴露的每一条凭据通路都是 key，且经桥的账户路由回合至今只见凭据报错。按未验证对待；key 路由是受支持通路。
- `--model` / `--reasoning-effort` / `--permission-mode` 走同一 `args`（适配器的 CLI 旗标）。

## zcode

ZCode 提供官方 **headless CLI**——本桥走的就是这个对外驱动面：

```bash
zcode -p '<text>' --output-format stream-json --no-color --mode plan --cwd <dir> [--resume sess_…]
```

CLI 解析顺序:条目 `command`(与默认 `zcode` 不同时)> `ZCODE_CLI` 环境变量 > PATH 上的 `zcode` > 桌面版自带 CLI——Linux 是 `~/.zcode/server/bin/zcode`(sh 包装、直接 spawn);Windows/macOS 是 app 内 `resources/glm/zcode.cjs`,用 app 自己的二进制以 `ELECTRON_RUN_AS_NODE` 模式运行,并把 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` 指向 app 的 provider 目录(两种形态均已实测;Windows 桌面树里**没有**独立的 CLI 可执行文件)。条目 `command` 写的就是默认值时不会禁用回落。agent-bridge **每回合起一个进程**,把 JSONL 事件流翻译成 v1——没有 PTY,也不解析屏幕。

**安装与登录**：装/开一次 ZCode 桌面版（或装独立 CLI），登录一次（`zcode login`，或经桌面版）。CLI 与桌面共享 `~/.zcode`——登录态、MCP、skills、hooks——所以桥里的回合和终端里的 `zcode` 看到的是同一套配置。

**默认模型**（2026-10-22 对 CLI 0.17.0 实机验证）：桥**从不传模型**——CLI 没有 `--model` 参数，每个回合的模型由 ZCode 按自己的配置解析：

1. `~/.zcode/v2/provider_config.json` 里的 `config.defaultModelSelection`——`{ "providerId": …, "modelId": … }`；该提供商可用时按它走；
2. 没设置、或该提供商不可用（比如没登录对应订阅）时，ZCode **静默回落**到 `config.providerOrder` 第一个提供商 × 它 `modelOrder` 的第一个模型——回合不会失败（实测：把 `defaultModelSelection` 指向一个不存在的提供商，回合正常完成并落在第一个第三方提供商上）。

**设置默认**：关掉 ZCode 后手改这个文件。当前桌面版 UI 写不进这个字段——安装包里有持久化方法但没有任何界面调用它，设置页的「设为默认连接」是 SSH 设备连接、与模型无关，TUI 的 `/model` 只改当前会话。例：把已登录的智谱 GLM 订阅设为默认：

```json
"defaultModelSelection": { "providerId": "account:bigmodel-individual-coding-plan", "modelId": "GLM-5.3-Flash" }
```

想核对某回合实际用的模型，查 agent 自己的账本——`~/.zcode/cli/db/db.sqlite`：

```sql
SELECT provider_id, model_id, datetime(started_at/1000,'unixepoch','localtime')
FROM model_usage ORDER BY started_at DESC;
```

两个坑：Windows 桌面与 WSL 各持一份**独立**的 `~/.zcode`——桥跑在哪侧就改哪侧的；运行中的 ZCode server 可能用内存副本回写文件，字段若消失就再补上。

**agents.json 条目**：

```json
{ "name": "zcode", "port": 3954, "apiKey": "", "mode": "plan" }
```

**行为要点**（2026-10-21 对 CLI 0.17.0 / server 3.16.2 经真实桥实机验证）：

- **流式**：`model.streaming` 的 `text_delta` → v1 `delta`；`turn.completed.response` 是权威的 `done.full`。模型真的吐 reasoning 增量时，会包进 `<thinking>…</thinking>`，保证 `full` 与 delta 拼接一致。
- **工具调用**：`tool.updated` 的 `scheduled/started/result` → v1 `tool` 行，用 agent 自己的 `toolCallId` 配对；detail 优先取 `command` / `file_path` / `pattern`。
- **Usage**：`inputTokens` / `outputTokens` / `cacheReadTokens` / `cacheWriteTokens` → `prompt_tokens` / `completion_tokens` / `cached_tokens` / `cache_write_tokens`。
- **会话**：CLI 分配 `sess_…`；后续回合把它带回来，适配器会加 `--resume`。续接是真的续上下文（追问能复述上一轮原话），并且命中 provider 缓存（28.5K 输入的回合里 22,528 个缓存 token）。
- **模型由 ZCode 选，不是桥选。** headless 回合跑的是 `~/.zcode/v2/provider_config.json` 里 **`providerOrder` 的第一个供应商 + 该供应商 `modelOrder` 的第一个模型**；桥不传模型参数，CLI 本身也没有（`--model` 会被拒）。改这个文件要先关掉 ZCode（运行中的 server 会用内存值覆盖），并让 `modelOrder` 与 `personalModelIds` 保持同一顺序——两者可能不同步，表现出来就是"排第一的没被选中"。
- **`defaultModelSelection` 在这条路径上无效**（2026-10-22 实测：指向自定义供应商的模型、指向账号模型、带/不带 `options`、补上缺失的账号模型规则——每种写法都被忽略，排序照旧生效）。它是桌面 UI 会写的字段，`zcode -p` 根本不读。
- **账号类供应商永远不会被自动选中。** 只登录智谱/bigmodel 套餐、把自定义供应商全部隐藏时，`zcode -p` 直接报 `Select a model before sending a message`，连新会话都建不起来。桥会把该错误翻译成两条可行出路。
- **`--resume` 完全跳过模型解析**（CLI 里 `if (e.resume) return;`），所以续接一个在 app/TUI 里用账号模型创建的会话，就会一直用那个模型——这是在 headless 下使用账号套餐模型的受支持方式。
- **macOS/Windows 会弹出 Terminal 窗口。** 桥用 app 自带的 `zcode.cjs` 配 `ELECTRON_RUN_AS_NODE=1` 在 app 二进制上运行，但 CLI **会把它从自己 spawn 的每个子进程 env 里删掉**（工具/Bash 子进程——3.16.2 bundle 里的 `vPe()`），于是每条命令都会重新拉起 GUI app，macOS 就闪一个终端窗口直到它退出。适配器因此优先选用 bundle 里的原生 node；如果你的包里没有，用 `ZCODE_CLI` 指向一个，它接受完整命令行：
  `ZCODE_CLI="/usr/bin/env node /Applications/ZCode.app/Contents/Resources/glm/zcode.cjs"`（先 `ls /Applications/ZCode.app/Contents/Resources/node /Applications/ZCode.app/Contents/Frameworks` 看看有没有；PATH 上真实的 `node` 也可以）。
- **每个回合都会报告实际使用的模型**：一个 `kind: "model"` 的 `note` 事件，带 `model: {provider, model, reasoningLevel}`，取自 CLI 自己的 `turn.started.intent.modelSelection`。回复文本里模型自报的名字不可信，以这个 note 为准。

- **没有交互式审批。** headless 回合没有审批卡，CLI 自己 `-p` 的默认值还是 `yolo`。桥默认 `"mode": "plan"`（只读），条目可选 `build` / `edit` / `guarded` / `yolo`——**选 mode 就是权限决定**。要放宽请显式放宽。
- **不支持图片。** CLI 唯一的附件面是本地文件（`--attach`），而桥从不把用户图片写盘；带图回合降级为一条提示（与 ACP 路径同一姿态）。
- **成本/延迟**：每回合一个进程（CLI 启动约 2–4s）；新会话的 prompt 自带 CLI 约 28K token 的系统提示/工具。实测：PONG 12.7s、Read 工具回合 18.5s、续接回合 15.3s。
- 旧的 native 适配器（`adapters/zcode-server.mjs`，直连桌面 stdio server）**已暂停**：2026-10-21 复测，桥拉起的 server 注册好 provider 后在回合开始时丢弃客户端（`ZCode Protocol client is disposed`）。注册表改走 headless CLI；native 文件仅留作参考。

## ACP 客户端（门）

每个条目还可以额外直接服务 ACP 客户端：写上 `"acp": true`，桥就在 `ws://<host>:<port>/acp` 说 ACP v1（`initialize` → `session/new` → `session/prompt`；审批请求以 `session/request_permission` 原样送达客户端，带 agent 自己的选项）。同端口、与 v1 相同的 apiKey 与 Host 规则；客户端 `session/new` 里的 cwd 会被忽略——agent 跑在条目配置的 `cwd`。现成客户端（acp-sidepanel / chrome-acp 这类浏览器侧边栏、acpx、acp-ui……）直接接：指向 `ws://host:port/acp`，apiKey 当 bearer token 用。设计说明见 [design-acp-front.zh-CN.md](./design-acp-front.zh-CN.md)。

把 agent 当本地命令启动的客户端（Zed、vscode-acp……）走 stdio 门：`node cli.mjs acp <条目名> [--config agents.json]`——该条目就变成 stdio 上的一个 ACP v1 agent（stdout 只走协议、日志走 stderr、不开端口；条目可以不写 `port`）。完全没配置文件时，会按注册表内置默认命令启动该名字的 agent，所以 `agent-bridge acp claude` 零配置即用——ACP Registry 条目分发的就是这条命令（见 [acp-registry.zh-CN.md](./acp-registry.zh-CN.md)）。

## 故障排查

- **先跑 `agent-bridge doctor`**——它会预检配置、每个条目的 agent 二进制是否在 PATH、端口冲突（已在运行的本桥自身算通过）以及非 loopback 绑定的 apiKey 规则；每行 FAIL 都打印修法，`--json` 可接脚本。下面的条目覆盖静态检查看不到的部分。
- **报问题时把桥终端里 `[acp]` / `[bridge]` 开头的行一起贴上**——它们覆盖了握手协商、会话创建/恢复、每回合的 prompt 与响应（含 stopReason 和 usage）、审批请求、以及被忽略的未知通知，能直接定位问题在哪一层。
- **回合里流出 `Reconnecting... waiting for network` 且一直重试** —— codex 连不上它的模型后端。最常见原因：自定义 provider 的鉴权来自**环境变量**（config.toml 的 `env_key`，如 `OPENAI_API_KEY`），它必须在你**起桥的那个终端**里已导出（`echo $OPENAI_API_KEY` 验证）——桥只继承起桥 shell 的环境，每个终端窗口是独立的。export 之后**同一终端**重新起桥。
- `codex CLI not found: 'codex' …` / `agent command not found: '…'` —— agent 二进制没装或不在 PATH；装上，或在配置条目里设 `"codexBin"` / `"command"`。
- codex 收不到审批事件 —— 条目里没写 `"approval": "on-request"`。
- 换了桥后面的 agent 之后旧对话报错 —— sessionId 是 agent 私有的（codex 线程 id ≠ claude 会话 id），清掉对话历史重新开始即可。
- 别的都正常但某个 agent 行为诡异 —— 先看是不是上表里"仅 schema 级"的：没实机验证过的 agent，坑就是我们下一步要填的，欢迎把现象带回来。
