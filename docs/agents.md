<p align="center"><strong>English</strong> · <a href="./agents.zh-CN.md">简体中文</a></p>

# Per-agent setup guide

agent-bridge exposes a single client interface; everything that differs between agents lives in **one entry in your agents.json**. Every bridge — single or many — starts the same way:

```bash
node cli.mjs serve            # reads ./agents.json (or: serve --config FILE)
```

Verification status at a glance (honesty first — tell us what works or breaks, and we'll update this table):

| Agent | agents.json entry | Live-verified |
|---|---|---|
| codex | `{ "name": "codex", "port": 3948, "apiKey": "", "approval": "on-request" }` | ✅ yes (codex-cli 0.149.1) |
| codex via official shim | registry line + `{ "name": "codexacp", "port": …, "command": ["codex-acp"] }` (see below) | ⚠️ real turn ✅; drops the answer text on non-streaming backends (upstream bug, see below) |
| claude code | `{ "name": "claude", "port": 3949, "apiKey": "" }` | ✅ macOS 2026-09-08 — real turns (streaming, full answer text), session continuity, usage, approval flow; disconnect-interrupt and bridge-restart resume are test-covered but not yet exercised live |
| pi | `{ "name": "pi", "port": 3950, "apiKey": "" }` | ✅ 2026-09-11 — real turns (streaming, tool calls) through svkozak/pi-acp 0.0.33 + pi 0.85.1, driven by a mock OpenAI provider; bridge-restart resume (automatic `session/load` fallback) exercised live |
| gemini / opencode / kimi / qwen etc. | not in the registry yet — add a line to `agents-registry.mjs` once verified (see below) | ❓ schema-level only |

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

**agents.json entry**:

```json
{ "name": "codex", "port": 3948, "apiKey": "", "sandbox": "workspace-write", "approval": "on-request" }
```

**Behavior notes**:

- Default is a **read-only sandbox** (`"sandbox": "read-only"`): the agent can read and reason; commands that would escape are refused. `"workspace-write"` opens writes (add `"network": true` for net access).
- `"approval": "on-request"` is what makes the bridge emit `approval` events; the default `"never"` emits none — commands simply run inside the sandbox or get refused.
- Images (data:/https URLs) ride straight through to the model.
- Sessions survive bridge restarts (codex persists its threads on disk).
- codex must be on PATH; otherwise point at it with `"codexBin": "/path/to/codex"`.

## claude code

**Key prerequisite: claude code does not speak ACP natively.** It needs a translator shim — `claude-agent-acp`, maintained by the ACP organization itself (very thin: it does not contain claude and has no login of its own; it drives your installed, logged-in claude code through Anthropic's official Agent SDK). The chain:

```
agent-bridge ──ACP v1 (stdio; the bridge negotiates)──► claude-agent-acp ──Agent SDK──► claude code
```

**Install & sign in**:

```bash
npm i -g @anthropic-ai/claude-code    # claude code itself (if not installed)
claude                                # first run completes login (subscription or API key)
npm i -g @agentclientprotocol/claude-agent-acp   # the ACP shim (maintained by the ACP org)
```

**agents.json entry**:

```json
{ "name": "claude", "port": 3949, "apiKey": "" }
```

- Equivalent without a global install: add `"command": ["npx", "-y", "@agentclientprotocol/claude-agent-acp"]`.
- Alternative shim: `"command": ["claude-code-acp"]` (Zed's older `@zed-industries/claude-code-acp`).

**Behavior notes**:

- **There is no approval/sandbox knob** — when approvals happen is decided by claude's own permission system: tool calls outside its allowlist trigger a request, and `always` = claude remembers the allowance (its persistence). The bridge always relays.
- Session recovery across bridge restarts: the official shim supports ACP `session/resume` (claude-agent-acp passes it down as `claude -p --resume`; method existence verified live).
- Image support depends on the `promptCapabilities.image` it advertises (claude-agent-acp advertises `image: true`); without it, images degrade to a text note (never written to disk).
- Unauthenticated behavior verified live: the session is created normally and the turn ends with a clean `Authentication required` SSE error.

## pi

pi (from earendil-works) does not speak ACP itself either — the community shim [`pi-acp`](https://github.com/svkozak/pi-acp) (npm package `pi-acp`) translates, spawning `pi --mode rpc` underneath. The chain:

```
agent-bridge ──ACP v1 (stdio; the bridge negotiates)──► pi-acp ──`pi --mode rpc`──► pi
```

**Install & sign in** (pi ≥ 0.80.4 and Node ≥ 22 required):

```bash
npm i -g @earendil-works/pi-coding-agent pi-acp
pi                                      # first run: pick a provider / log in
# custom or OpenAI-compatible endpoints: ~/.pi/agent/models.json (+ settings.json
# defaultProvider/defaultModel). pi-acp also has `pi-acp --terminal-login` for
# Terminal Auth (ACP Registry).
```

**agents.json entry**:

```json
{ "name": "pi", "port": 3950, "apiKey": "" }
```

- Equivalent without a global install: `"command": ["npx", "-y", "pi-acp"]`.

**Behavior notes** (live-verified 2026-09-11 against pi-acp 0.0.33 + pi 0.85.1):

- **No usage events.** pi reports no token counts (no `usage_update`, nothing in the prompt response) — `done` events carry `usage: null`.
- **Built-in tools auto-execute.** pi's bash/read/edit/write run without asking — no `approval` events for them. The only `session/request_permission` requests are pi *extension* UI prompts (select/confirm), which the bridge relays like any approval.
- Images work: pi-acp advertises `promptCapabilities.image: true`, and data:/https URLs ride through.
- **Sessions survive bridge restarts.** pi-acp refuses ACP `session/resume` (method-not-found) and only implements `session/load` — the bridge tries resume first and falls back to load automatically; pi-acp restores the same session id from its own persisted map.
- Slash commands (`/compact`, `/session`, `/thinking`, …) work as ordinary prompt text — pi-acp intercepts them before pi sees a model call.
- pi-acp's startup banner (version + installed skills) is sent outside any turn; the bridge drops it, so your first turn's stream stays clean.

## codex via the official ACP shim (alternative route)

`npm i -g @agentclientprotocol/codex-acp` also puts codex behind the bridge — verified end-to-end on 2026-09-07 with a real turn through a volcengine gateway (start → done + usage). Since `serve` only accepts registry names, drive it with a one-line registry addition (`"codexacp": { "kind": "acp", "command": ["codex-acp"] }`) plus an entry `{ "name": "codexacp", "port": …, "apiKey": … }`. **But there is an upstream defect**: on non-streaming backends (which send `item/completed` without prior deltas — e.g. the deepseek gateway), the final answer text is dropped entirely — the turn ends `end_turn` with an empty `full` (codex-acp `return null`s the completed agentMessage item and only forwards deltas). The native codex entry above remains the primary recommendation (it has the completed-items fallback and is unaffected).

## Other ACP v2 agents

Any agent that speaks ACP v2 on stdio joins with two lines: a registry entry in [`agents-registry.mjs`](../agents-registry.mjs) (`"kimi": { "kind": "acp", "command": ["kimi-acp"] }`) and an agents.json entry (`{ "name": "kimi", "port": …, "apiKey": … }`). The registry doubles as a "supported" claim to clients, so add a line once the agent has a verified turn.

- **gemini**: native ACP support, no shim — the registry line would be `"gemini": { "kind": "acp", "command": ["gemini", "--experimental-acp"] }` (sign in with `gemini` first).
- **opencode / kimi / qwen etc.**: check each agent's docs for its ACP story; the single test is that the configured command speaks ACP on stdio (the bridge accepts protocolVersion 1 or 2).

None of these are live-verified yet — report your results (good or bad) and we'll update the table.

## ACP clients (the front)

Every entry can additionally serve ACP clients directly: add `"acp": true` and the bridge exposes `ws://<host>:<port>/acp` speaking ACP v1 (`initialize` → `session/new` → `session/prompt`; permission requests arrive as `session/request_permission` with the agent's own options). Same port, same apiKey and Host rules as v1; the client's `session/new` cwd is ignored — the agent runs in the entry's `cwd`. Design notes: [design-acp-front.zh-CN.md](./design-acp-front.zh-CN.md).

Spawn-style clients that launch agents as local commands (Zed, vscode-acp, …) use the stdio door instead: `node cli.mjs acp <entry-name> [--config agents.json]` — that one entry becomes an ACP v1 agent on stdio (protocol on stdout, logs on stderr, no port opened; the entry may omit `port`).

## Troubleshooting

- **When reporting a problem, include the `[acp]` / `[bridge]` lines from the bridge terminal** — they cover the handshake negotiation, session create/resume, each turn's prompt and response (with stopReason and usage), permission requests, and ignored unknown notifications, and pinpoint which layer failed.
- **The turn streams `Reconnecting... waiting for network` and keeps retrying** — codex cannot reach its model backend. The most common cause: a custom provider authenticates via an **environment variable** (the `env_key` in config.toml, e.g. `OPENAI_API_KEY`), and that variable must be exported in the terminal where you start the bridge (`echo $OPENAI_API_KEY` to check) — the bridge inherits the starting shell's environment only, and every terminal window is its own environment. Export it, then restart the bridge **in that same terminal**.
- `codex CLI not found: 'codex' …` / `agent command not found: '…'` — the agent binary isn't installed or isn't on PATH; install it, or set `"codexBin"` / `"command"` in the config entry.
- No approval events in codex mode — the entry lacks `"approval": "on-request"`.
- An old conversation errors after you swapped the agent behind the bridge — session ids are agent-private (a codex thread id is not a claude session id); clear the chat history and start fresh.
- Everything else works but one agent behaves oddly — check the table above: agents marked "schema-level only" haven't been live-verified; their surprises are exactly what we want to hear about.
