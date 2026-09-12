# ACP Registry 提交 runbook

Roadmap #4（owner 决策 2026-09-08：双门策略——v1 留给 browsa，**公开门是 ACP**；stdio 门让 bridge 本身成为可列出的 agent）。本文记录向 [ACP Registry](https://agentclientprotocol.com/get-started/registry) 提交的定稿材料与流程，发版后按此更新。

## 为什么值得列

- Registry 由 Zed 与 JetBrains 共同背书，是 ACP 生态的中央发现点；Zed 的 agent 面板已支持从 Registry 直接安装 agent。
- 列出后第三方客户端（编辑器、浏览器侧边栏、acpx/acp-ui 一类）无需了解 v1 wire 即可采用本桥。
- 竞品参照：chrome-acp 已用 Zed 系壳把 Claude Code/Codex/多 agent 接进浏览器——我们列出的差异化是原生 codex adapter、正确的审批流映射、会话跨重启存活、零依赖。

## 条目定稿（`agent.json`）

按上游 `agent.schema.json`：`id` 匹配 `^[a-z][a-z0-9-]*$`；`license_url` 除 dimcode 外必填；`distribution` 三选一（binary/npx/uvx），npx 形如 `{package, args, env?}`。目录结构：仓库根建 `agent-bridge/agent.json`（可选 `icon.svg`，16×16——仓库暂无图标，留待补）。

```json
{
  "id": "agent-bridge",
  "name": "agent-bridge",
  "version": "0.3.0",
  "description": "One bridge for many CLI coding agents. Spawn any entry as a stdio ACP agent — codex (native app-server adapter), Claude Code, pi, or any ACP agent by name — with correct approval-flow mapping (once/always/deny by kind), session resume across restarts, image passthrough, and zero npm dependencies.",
  "repository": "https://github.com/xiaohuzai/agent-bridge",
  "authors": ["xiaohuzai"],
  "license": "MIT",
  "license_url": "https://github.com/xiaohuzai/agent-bridge/blob/main/LICENSE",
  "distribution": {
    "npx": {
      "package": "@xiaohuzai/agent-bridge",
      "args": ["acp", "claude"]
    }
  }
}
```

**args 为什么是 `["acp", "claude"]`**：cli 的 acp 模式带免配置回退（显式 `--config` > `./agents.json` > 注册表内置默认），所以这条命令自包含可跑——claude 本体与官方壳 `@agentclientprotocol/claude-agent-acp` 是 agent 自己的前置，与其他 registry 条目同例。编辑器想换 agent/加配置时覆盖 args 即可（如 `["acp", "codex", "--config", "/abs/agents.json"]`）。

**version 必须跟 npm latest 对齐**：listing 的 `npx` 分发解析到 npm 的 latest dist-tag，`version` 字段要与它一致——每次 npm 发版后同步更新这里与上游条目。

## 提交流程（上游）

1. Fork `agentclientprotocol/registry`，开分支（如 `add-agent-bridge`）。
2. 建 `agent-bridge/agent.json`（内容如上，version 对齐当时 npm latest）。
3. PR 到上游 `main`，说明：是什么、npx 分发、stdio ACP v1、approval/resume 亮点、仓库与文档链接。
4. 合入后：更新本文件的提交记录与 README 的 registry 提法。

## 提交记录

- 2026-09-12：首次提交（version 0.3.0，随免配置回退特性发布；npm latest 已是 0.3.0）。上游 PR：https://github.com/agentclientprotocol/registry/pull/598 ——合入后把 README 与本记录改为「已列出」。
