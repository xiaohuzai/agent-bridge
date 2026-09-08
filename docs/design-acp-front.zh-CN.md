# ACP front 设计稿（WS 优先）

状态：**已实现**（2026-09-08）。WS profile 随 `wire-ws.mjs` + `acp-front-ws.mjs` 交付；stdio 门（`acp-front.mjs` 传输无关会话 + `acp-front-stdio.mjs`，`agent-bridge acp <条目>` 作为可被编辑器 spawn 的 ACP agent）随后交付。§9 的决定点 1/2/4 按建议落地，3 为记录在案的已知缺口。战略背景见 AGENTS.md「Roadmap (dual-door strategy)」：v1 是内置极简门（冻结），ACP 是公众门。

---

## 0. browsa 兼容性保证（第 0 条，硬约束）

新 front 是**加一扇门，不是改旧门**。具体保证，四条全是结构性的、不靠自觉：

1. **路径隔离**：ACP 门只活在 `/acp` 一个路径上。v1 的四个端点（`/health` `/sessions` `/turns` `/approvals/:requestId`）路由、事件名、语义（disconnect=abort、start 先于 delta、15s 心跳）逐字不动。
2. **配置 opt-in**：`"acp": true` 是新的可选字段，默认不开。不写它的配置文件行为与今天 100% 一致——包括已有的 `agents.json` 一字不改照常工作。
3. **回归网**：现有全部测试（37 个，真实 HTTP server 驱动）就是 v1 契约测试；任何破坏 v1 的改动必然红。另加一个**契约钉死测试**：断言端点清单与 SSE 事件名集合，防止"顺手"改动。
4. **入宪**：AGENTS.md Conventions 已写入「v1 FROZEN — additive-only」条款；重命名/删除/改事件语义必须走 v2，不允许在 v1 上发生。

browsa 因此**永远不需要跟着改**。

## 1. 门开在哪里

- **同端口、同 server、新路径 `/acp`**。`GET /acp` 带 `Upgrade: websocket` 即进入 ACP-WS 模式；普通 GET（无升级头）落到 v1 的 404——不给冻结的 server.mjs 加探测分支，文档写明即可。
- 不开独立端口：本仓库的模型就是"每桥一个端口"，认证、日志、防火墙都单点；config 不膨胀。
- 与官方 RFD 对齐：RFD 规定**单一 `/acp` 端点**承载两种 profile（WebSocket 与 Streamable HTTP）。我们先做 WS（RFD 合规最低线："WS-only servers — clients MUST support WS"），将来 Streamable HTTP（需 HTTP/2）落在同一路径上，客户端可任选。
- 开关：bridge 条目新增 `"acp": true`（默认 false，保守起步；采纳量起来后可讨论翻转默认值）。

## 2. 协议角色

WS 连接的对端是 **ACP client**（Zed、acpx、acp-ui、obsidian-agent-client…），桥在这个门上扮演 **ACP agent**。桥对 ACP v1 语义的全部既有知识（`acp-stdio.mjs` 头注释是记录）直接复用——本 front 本质上就是 `acp-stdio.mjs` 把传输层换成 WS、方向反转。

版本协商：`initialize` 必须是首条消息；桥声明支持 protocolVersion 1（对外只说 v1——v2 还是 tracking RFD，draft schema，不承诺）。桥向对端声明的能力里，`promptCapabilities.image` 按后端 adapter 的实际能力转报。

## 3. 内部事件 ↔ ACP v1 线上消息映射

| 内核 onEvent | ACP v1 出线 |
|---|---|
| `start`（sessionId 已知） | `session/new` 的响应 / `session/prompt` 期间的首个 `session/update` |
| `delta` | `session/update` `agentMessageChunk`（thought 流单独映射 `agentThoughtChunk`） |
| `tool` | `session/update` `toolCall` / `toolCallUpdate` |
| `approval` | `session/request_permission`（原样转发 options；codex 原生审批合成 `allow_once/allow_always/reject_once` 三选项） |
| `done` / `aborted` | `session/prompt` RPC 响应 `stopReason: end_turn / cancelled`（`done.usage` → 响应 `usage {inputTokens, outputTokens}`——v1 响应是合法的 usage 承载点，随响应转发） |
| `error` | `session/prompt` RPC 响应带 error |

反向：`session/cancel` → `interrupt(sessionId)`；`session/load` → 用内部持久化的 sessionId 恢复（我们已有"会话跨重启存活"的不变量）。

**会话双轨**：ACP sessionId 与内部 sessionId 各自独立，front 维护映射表。ACP client 在 `session/new` 就拿到 sessionId（内部会话此刻可以还没绑定 adapter——内部 sessionId 在第一轮 `startTurn` 才诞生，这正是既有不变量）。

**断线语义**：WS close 即 `session/cancel` + `interrupt`——与 v1 的 disconnect=abort 哲学一致，编辑器客户端关窗即中断是合理行为。悬空的 `request_permission` 按 ACP 规范回 `{outcome:{outcome:'cancelled'}}`（adapter 侧已有这个纪律）。

## 4. 认证

- 与 v1 同一把 per-bridge `apiKey`，同一套"loopback 可免 key、非回环必配"的规则——不发明第二套鉴权。
- WS 握手查 `Authorization: Bearer`（Node/脚本客户端都能设头）。
- **已知缺口（记录，不默认修）**：浏览器 WebSocket 无法设自定义头。方案是反代注入头（caddy/nginx 都能干），文档写清楚。查询参数 `?api_key=` 会进访问日志，默认拒绝；若将来加，必须显式 opt-in 并打警告。

## 5. 零依赖 WS server 的实现范围

Node 没有内置 WS **server**——手写 RFC 6455 子集：握手（`Sec-WebSocket-Accept` SHA-1）、帧编解码（text/binary/ping/pong/close，client→server 帧掩码校验）、一条 JSON-RPC 消息 = 一帧。纯 `crypto`/`net`，预估 150–200 行，全 Node 版本可用。拒绝帧分片（RSV/continuation 直接断开）——ACP 消息小，不值得支持。

测试侧同理手写 ~100 行的 WS 测试客户端（`net.Socket` + 掩码帧），维持"无依赖、无网络"纪律。用 `@agentclientprotocol/sdk` 写验收脚本属于 devDependency，不进运行时——**默认不用**（见决定点 4）。

## 6. 前置工作项（已核实，2026-09-08）

- ~~核对 approval 事件是否带 options~~ **已核实：适配器零改动**。内部 `approval` 事件已携带 per-option `{optionId, name, kind}`（acp-stdio.mjs），且事件按 turn 发出——front 自己知道归属会话，自行盖 sessionId 即可。codex 原生审批（无 options）由 front 合成三标准选项。已知差距（可接受的将来增强）：内部事件把 title/description 合并成一个 command 字符串、丢掉 options 上的扩展字段——渲染 UI 足够，逐字保真暂不做。
- 会话跨重启：为 `AcpStdioAdapter` 增加一个小的 additive 方法 `createSession()`（立即 session/new 并预登记，front 的 sessionId 从出生就是可恢复的内部 sessionId——重启后客户端凭原 id prompt，走既有 `session/resume` 路径）。codex 原生适配器暂不加（thread/start 无 prompt 创建未经实机验证），front 走"临时 id + 首个 start 事件绑定"的降级路径。
- `agents.example.json`、`agents-registry` 无需变动；README/agents.md 等 front 文档在实现合入时补一节（双语对齐惯例照旧）。

## 7. 验收

必测路径（fake agent + 真 WS client）：initialize 版本协商（含拒绝首条非 initialize）、session/new→prompt 全事件流、request_permission 往返（含 deny 与取消）、WS close 中断、 apiKey 错误 401、ping/pong 保活。

真实客户端手工验收清单：**acpx**（headless CLI，最易脚本化）、acp-ui web 版（它官方文档明说要外挂 stdio→ws 桥——本 front 就是我给它缺的那块）、obsidian-agent-client。Zed（stdio-only）留到第 3 步 stdio front。

## 8. 本期明确不做

Streamable HTTP profile（等官方 Goose 参考实现落地）；事件流重连/续播（RFD 也 defer 了）；ACP v2；Gemini。

## 9. 待拍板的决定点

1. `"acp"` 默认值：**false（opt-in）**——与"配置了啥起啥"一致，采纳成熟后再讨论翻转。
2. ~~usage 丢弃~~ **已修正**：v1 的 `session/prompt` 响应本身就是合法 usage 承载点，随响应转发，不丢事件也不造扩展。
3. 浏览器无头认证走反代注入：建议**接受**（安全姿势优先于便利）。
4. 验收脚本用官方 SDK（devDependency）还是裸手写 WS 客户端：建议**裸手写**，守零依赖纪律。
