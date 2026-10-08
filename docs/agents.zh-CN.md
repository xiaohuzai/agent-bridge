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
| dsh（DeepSeek Harness） | `{ "name": "dsh", "port": 3952, "apiKey": "", "cwd": "/your/project" }` | ⚠️ 2026-10-09——协议链对 dsh 0.2.0-rc.2 实机验证（spawn → ACP v1 握手 → session/new → prompt → 干净的鉴权错误 SSE；模型调用本身需有凭据的机器） |
| workbuddy | `{ "name": "workbuddy", "port": 3953, "apiKey": "", "cwd": "/your/project" }` | ✅ 2026-10-08——真实回合（流式、thinking 折叠、ACP 内容块传图、审批往返、中止）走原生回环适配器对接运行中的 WorkBuddy AI 桌面 5.4.3 |
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

## dsh（DeepSeek Harness）

原生 ACP，无需壳——`dsh --profile acp` 本身就是一个 stdio ACP v1 agent（`@deepseek-ai/dsh-acp`，官方「automation-only」profile；注册行 `"dsh": { "kind": "acp", "command": ["dsh", "--profile", "acp"] }`）。首选安装是桌面版菜单 **Manage dsh Command… → Install**：装出的 `dsh` 版本永远跟运行中的桌面发行版一致。CLI 与桌面共享 `~/.dsh` 的产品数据（会话、凭据、设置），但不共享可执行包——从桥发起的回合会出现在桌面应用的会话列表里（ACP 面没有标题通道，这些会话用 dsh 的确定性兜底标题）。

注册表条目自带**默认 `--patch`**（`patches/dsh-account-route.yml`），把钉死的 profile 行切到 `deepseek-account` 路由——桌面版登录态存在共享的 `~/.dsh` 凭据存储里，已登录用户只写 `{ "name": "dsh", "port": …, "apiKey": "" }` 就能用，每个回合直接记到账户余额，哪里都不需要 `DEEPSEEK_API_KEY`。2026-10-09 macOS 实机验证（dsh 0.2.0-rc.2，桌面版已登录）：带 patch 真回合完成；不打 patch 的同一台机器报 `MISSING_CREDENTIAL … deepseek-official`。

实机验证 2026-10-09（dsh 0.2.0-rc.2）：握手答 protocolVersion 1（桥请求 2 并接受）；`sessionCapabilities` = list/resume/close——桥重启恢复走适配器 `session/resume` 第一分支；审批走标准 `session/request_permission`（one-shot allow/reject）；思考块走 `agent_thought_chunk`；模型（`deepseek-v4-flash` / `-v4-pro` 等）与 `reasoning_effort`（`off`/`low`/`high`/`max`）都是标准 `session/set_config_option` 选项。裸安装时图片声明为 `false`（该 profile 只在「有持久附件存储 + 声明图片能力的 exact route」时开启）。协议链（spawn → 握手 → session/new → prompt → 干净的鉴权错误 SSE）已用真实二进制过桥跑通。

**已知取舍：无 token 级流式。** 官方 ACP 面按 committed 消息粒度投递更新（源码实锤：只对 `assistant/message` / `tool/call` / `tool/result` 事件反应）——工具调用实时到，但纯文本长回答会整段落下而不是逐 token 流。第三方 `dsh-acp-gateway` 有 token 流但仍锁 dsh 0.1.x——不建议压过官方 profile。

### 路由控制：退出或自定义

- **API-key 用户**（没登录桌面版）：账号路由不回退到 key，用 `"args": []` 清掉默认，再配 `DEEPSEEK_API_KEY`（或在 Web 模型页存 key）。未登录态在首回合表现为 `ACCOUNT_SIGN_IN_REQUIRED`。
- **自定义路由/模型**：把 `"args"` 指到你自己的 patch——条目的 `args` 整体替换默认。随包文件就是模板：

```yaml
- insert:
    - id: agent-default-model
      name: '@deepseek-ai/dsh-agent-default-model'
      config:
        provider: deepseek-account
        model: deepseek-flash
    - id: acp
      name: '@deepseek-ai/dsh-acp'
      config:
        provider: deepseek-account
        model: deepseek-flash
```

`args` 逐字使用——`~` 不展开，请传绝对路径。

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


## workbuddy

原生适配器（`adapters/workbuddy.mjs`，`kind: 'workbuddy'`），作为**运行中的 WorkBuddy AI 桌面应用**的纯客户端：桌面版自己拉起并常驻一个本地 CodeBuddy Code worker 网关（ACP over Streamable HTTP，回环端口），适配器自动发现它——对回环监听端口按 `/health` 特征最新探测，条目 `"workbuddyPort"` 可覆盖。桌面应用需已安装、已登录且**正在运行**（无需控制台注册、无需 OAuth——适配器不碰凭据；模型与登录态都在 WorkBuddy 应用里）。

配置条目：

```json
{ "name": "workbuddy", "port": 3953, "apiKey": "", "cwd": "/path/to/your/project" }
```

2026-10-08 实机验证（WorkBuddy AI 5.4.3，macOS，真实回合过桥）：connect（回环免鉴权）→ initialize → session/new / session/prompt 走 Streamable HTTP + SSE；流式增量中 reasoning 折成 `<thinking>` 块；工具调用出 tool 事件；权限请求以审批卡呈现（`session/request_permission` 按映射的 optionId 应答）；图片以 ACP image 内容块随行（`promptCapabilities.image: true`）；`session/cancel` 中止；`loadSession: true` 让 sessionId 跨桥重启存活（`session/load` 续接）。该面未暴露用量（省略）；无命名通道（桥答 501）；AskUserQuestion 类提问未接线——会话权限模式（默认 `bypassPermissions`）会自动消解。

会话模型，2026-10-08 在用户机器上实测确认——先知道，免得找不到自己的对话：

- **worker 的网关会话只存内存。** ACP 会话 id 在应用的全部存储位置都搜不到——重启 WorkBuddy 桌面版会清掉所有桥对话的 worker 侧上下文。下一条消息自动在新会话里继续，流中有一条 `note` 说明「此前上下文不带过来」；start 事件会把新会话 id 重映射回客户端，客户端无需改动。
- **桌面版自己的 UI 不会列出经桥开始的对话。** 这是 ACP「会话归客户端管」的设计（网关没有列表/命名通道），不是 bug——你的客户端（browsa、你的脚本）才是会话管理器。想把对话搬进桌面：从客户端导出内容，粘贴到桌面的新聊天里即可。
- **自动发现依赖 `lsof` + `curl`**（macOS/Linux 自带；Windows 10+ 虽带 curl 但没有 lsof）。Windows 上请在条目里显式写 `"workbuddyPort"`。


