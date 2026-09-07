<p align="center"><strong>English</strong> · <a href="./agents.zh-CN.md">简体中文</a></p>

# Per-agent setup guide

agent-bridge exposes a single client interface; everything that differs between agents lives in **how you start the bridge**. Two modes: `codex` (bespoke adapter) and `acp -- <command>` (generic adapter for anything speaking ACP v2).

Verification status at a glance (honesty first — tell us what works or breaks, and we'll update this table):

| Agent | How to start | Live-verified |
|---|---|---|
| codex | `codex` mode (bespoke adapter) | ✅ yes (codex-cli 0.149.1) |
| claude code | `acp -- claude-code-acp` | ⏳ in progress |
| gemini | `acp -- gemini --experimental-acp` | ❓ schema-level only |
| pi / opencode / kimi / qwen etc. | `acp -- <their ACP command>` | ❓ schema-level only |

---

## codex

**Install & sign in** (any one of three):

```bash
npm i -g @openai/codex     # or brew install codex
codex login                # ① ChatGPT subscription (Plus/Pro — no API key)
export OPENAI_API_KEY=...  # ② or an OpenAI API key
# ③ or a custom provider in ~/.codex/config.toml ([model_providers.*] pointing
#    at your own gateway/local model). Note: codex ≥0.149 requires
#    wire_api = "responses".
```

**Start**:

```bash
node cli.mjs codex --port 3948 --approval on-request
```

**Behavior notes**:

- Default is a **read-only sandbox**: the agent can read and reason; commands that would escape are refused. `--sandbox workspace-write` opens writes (add `--network` for net access).
- `--approval on-request` is what makes the bridge emit `approval` events; the default `never` emits none — commands simply run inside the sandbox or get refused.
- Images (data:/https URLs) ride straight through to the model.
- Sessions survive bridge restarts (codex persists its threads on disk).

## claude code

**Key prerequisite: claude code does not speak ACP natively.** It needs a translator shim — Zed's officially maintained `claude-code-acp` (very thin: it does not contain claude and has no login of its own; it drives your installed, logged-in claude code through Anthropic's official Agent SDK). The chain:

```
agent-bridge ──ACP v2 (stdio)──► claude-code-acp ──Agent SDK──► claude code
```

**Install & sign in**:

```bash
npm i -g @anthropic-ai/claude-code    # claude code itself (if not installed)
claude                                # first run completes login (subscription or API key)
npm i -g @zed-industries/claude-code-acp   # the ACP shim (maintained by Zed)
```

**Start**:

```bash
node cli.mjs acp -- claude-code-acp
# equivalent without a global install:
node cli.mjs acp -- npx -y @zed-industries/claude-code-acp
```

**Behavior notes**:

- **There is no `--approval` flag to set** — when approvals happen is decided by claude's own permission system: tool calls outside its allowlist trigger a request, and `always` = claude remembers the allowance (its persistence). The bridge always relays.
- **There is no `--sandbox`** — safety policy belongs to claude; the bridge does not interfere.
- Session recovery across bridge restarts goes through ACP `session/resume`; whether claude-code-acp fully supports it is being verified on real machines right now.
- Image support depends on the `promptCapabilities.image` it advertises; without it, images degrade to a text note (never written to disk).

## Other ACP v2 agents

Any command that speaks ACP v2 on stdio can be driven: `node cli.mjs acp -- <command>`.

- **gemini**: native ACP support, no shim — `node cli.mjs acp -- gemini --experimental-acp` (sign in with `gemini` first).
- **pi**: community shims exist (e.g. [nat-e/pi-acp](https://github.com/nat-e/pi-acp), built on `pi --mode rpc`); see their repos for installation.
- **opencode / kimi / qwen etc.**: check each agent's docs for its ACP story; the single test is that the command after `--` speaks ACP v2 on stdio.

None of these are live-verified yet — report your results (good or bad) and we'll update the table.

## Troubleshooting

- `codex CLI not found: 'codex' …` / `agent command not found: '…'` — the agent binary isn't installed or isn't on PATH; install it, or point at it with `--codex-bin` / a different command.
- No approval events in codex mode — you didn't start with `--approval on-request`.
- An old conversation errors after you swapped the agent behind the bridge — session ids are agent-private (a codex thread id is not a claude session id); clear the chat history and start fresh.
- Everything else works but one agent behaves oddly — check the table above: agents marked "schema-level only" haven't been live-verified; their surprises are exactly what we want to hear about.
