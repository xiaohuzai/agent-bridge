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
| gemini | `{ "name": "gemini", "port": 3951, "apiKey": "" }` | ✅ 2026-10-01 — real turns (streaming, shell tool + approval request, cancel) through native `gemini --acp` 0.62.0, driven by a mock Google GenAI backend; bridge-restart resume (`session/load` fallback) exercised live; usage rides on `_meta.quota.token_count` (mapped) |
| dsh (DeepSeek Harness) | `{ "name": "dsh", "port": 3952, "apiKey": "", "cwd": "/your/project" }` | ⚠️ 2026-10-09 — wire chain live-verified against dsh 0.2.0-rc.2 (spawn → ACP v1 handshake → session/new → prompt → clean auth-error SSE; the model call itself needs a credentialed machine) |
| workbuddy | `{ "name": "workbuddy", "port": 3953, "apiKey": "", "cwd": "/your/project" }` | ✅ 2026-10-08 — real turns (streaming, thinking folds, images as ACP content blocks, approval round trip, cancel) against the running WorkBuddy AI desktop 5.4.3 via the native loopback adapter |
| opencode / kimi / qwen etc. | not in the registry yet — add a line to `agents-registry.mjs` once verified (see below) | ❓ schema-level only |

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
- **Two shim packages exist — don't mix them up.** `@agentclientprotocol/claude-agent-acp` (binary `claude-agent-acp`) is the official shim maintained by the ACP org — that's the one we verify. `@zed-industries/claude-code-acp` (binary `claude-code-acp`) is Zed's older shim — it works too (both speak v1; it's what chrome-acp wires up), but our session/resume and capability findings are recorded against the official one, so prefer it.

**Behavior notes**:

- **There is no approval/sandbox knob** — when approvals happen is decided by claude's own permission system: tool calls outside its allowlist trigger a request, and `always` = claude remembers the allowance (its persistence). The bridge always relays.
- Session recovery across bridge restarts: the official shim supports ACP `session/resume` (claude-agent-acp passes it down as `claude -p --resume`; method existence verified live).
- **Sessions stay visible in `claude --resume`** (bridge-side fix, 2026-10-01): claude CLI 2.x self-stamps every SDK-driven transcript `entrypoint:"sdk-cli"` — ignoring the `CLAUDE_CODE_ENTRYPOINT` env entirely (verified: env preset `cli`, transcript still `sdk-cli`) — and the interactive picker hides `sdk-*` transcripts. The claude registry entry therefore opts into a post-turn rewrite: after each settled turn the bridge flips the stamp to `"cli"` in `~/.claude/projects/*/<sessionId>.jsonl` (`adapters/claude-transcript-fix.mjs`, with retries for claude's lazy transcript writes). Purely local JSON surgery — if claude ever changes the layout the rewrite no-ops and sessions fall back to hidden-but-resumable-by-id. Sessions land in the entry's `cwd` project, so the picker shows them per directory (claude's own project scoping). Transcripts written before this fix keep the old stamp — one `sed -i '' 's/"entrypoint":"sdk-cli"/"entrypoint":"cli"/g' <file>` flips them manually.
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

- **pi already installed via its own installer?** (pi ≥ 0.98 self-installs to `~/.pi/agent/bin/pi`, symlinked into `~/.local/bin`.) Then install ONLY the shim — `npm i -g pi-acp` — and skip the npm `pi` package: it ships its own `pi` bin and the install aborts with `EEXIST` against the installer's symlink (seen live 2026-10-01). After any `npm i -g`, restart the terminal before retesting — a stale session PATH/symlink state produces confusing "executable not found" errors.
- **Bridge can't find pi even though your terminal can?** The daemon's PATH may be narrower than your shell's. pi-acp 0.0.34+ honors `PI_ACP_PI_COMMAND` — point it at the absolute pi path via the entry's `env`: `"env": { "PI_ACP_PI_COMMAND": "/Users/you/.pi/agent/bin/pi" }`.

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

`npm i -g @agentclientprotocol/codex-acp` also puts codex behind the bridge — verified end-to-end on 2026-09-07 with a real turn through a volcengine gateway (start → done + usage). Since `serve` only accepts registry names, drive it with a one-line registry addition (`"codexacp": { "kind": "acp", "command": ["codex-acp"] }`) plus an entry `{ "name": "codexacp", "port": …, "apiKey": … }`. **But there is an upstream defect**: on non-streaming backends (which send `item/completed` without prior deltas — e.g. the deepseek gateway), the final answer text is dropped entirely — the turn ends `end_turn` with an empty `full` (codex-acp `return null`s the completed agentMessage item and only forwards deltas). The native codex entry above remains the primary recommendation (it has the completed-items fallback and is unaffected). (Note: Zed's `@zed-industries/codex-acp` also exists in the wild; the official `@agentclientprotocol/codex-acp` is the one verified here.)

**Re-evaluated 2026-10-06 (user decision: stay native).** A browsa field report (a bare "hi" came back with the model's skill narration glued to the answer) triggered a fresh comparison. The codex app-server protocol (0.149.1 schema) has an OFFICIAL boundary signal — agentMessage items carry `phase: "commentary" | "final_answer"` ("Classifies an assistant message as interim commentary or final answer text. Providers do not emit this consistently, so callers must treat None as phase unknown"). codex-acp knows the phase but only forwards it as `_meta.jetbrains.air.phase` to AIR clients (JetBrains extension) — a plain ACP client gets flat `agent_message_chunk` text with no boundary, so the leak fix would land in OUR ACP adapter anyway with a last-message heuristic instead of the real signal. The completed-drop defect above is also still in main (source-verified 2026-10-06). DECISIVE (user, 2026-10-06): codex-acp declares `@openai/codex: ^0.159.1` as a regular dependency — adopting it would install a second codex CLI into agent-bridge's tree, against the user-first rule that the CLI stays the user's own install. The native adapter now classifies on phase (commentary → `note` events, everything else → done.full; null-phase falls back to last-item) — see the adapter header.

## Other ACP v2 agents

Any agent that speaks ACP v2 on stdio joins with two lines: a registry entry in [`agents-registry.mjs`](../agents-registry.mjs) (`"kimi": { "kind": "acp", "command": ["kimi-acp"] }`) and an agents.json entry (`{ "name": "kimi", "port": …, "apiKey": … }`). The registry doubles as a "supported" claim to clients, so add a line once the agent has a verified turn.

Candidate commands cross-checked against the wider ecosystem (each CLI must be installed and signed in first):

- **qwen**: `"qwen": { "kind": "acp", "command": ["qwen", "--acp"] }` (`npm i -g @qwen-code/qwen-code`).
- **opencode**: `"opencode": { "kind": "acp", "command": ["opencode", "acp"] }`.
- **auggie** (Augment Code): `"auggie": { "kind": "acp", "command": ["auggie", "--acp"] }`.
- **kimi etc.**: check each agent's docs for its ACP story; the single test is that the configured command speaks ACP on stdio (the bridge accepts protocolVersion 1 or 2).

None of these are live-verified yet — report your results (good or bad) and we'll update the table.

## gemini

Native ACP, no shim — registered as `"gemini": { "kind": "acp", "command": ["gemini", "--acp"] }` (`npm i -g @google/gemini-cli`; on ≥0.62 the flag is `--acp`, `--experimental-acp` still works but is deprecated). Auth before the first turn: either sign in once with `gemini`, or set `GEMINI_API_KEY`, or point `GOOGLE_GEMINI_BASE_URL` at a gateway — with env auth the ACP `session/new` needs no `authenticate` call.

Live-verified 2026-10-01 (gemini-cli 0.62.0, mock Google GenAI backend, real turns through the bridge): protocolVersion 1 (prompt-response terminator); streaming deltas; shell tool with `session/request_permission` (kind-mapped options) on risky commands; cancel answers the pending prompt with `stopReason:'cancelled'`; usage arrives on the response's `_meta.quota.token_count` (the bridge maps it); `session/resume` is refused (`-32601`) so bridge-restart restore goes through `session/load`; images advertised (`promptCapabilities.image`) but not yet exercised live. Files are read/written locally by the CLI — no fs-proxy requests hit the bridge.

## dsh (DeepSeek Harness)

Native ACP, no shim — `dsh --profile acp` IS a stdio ACP v1 agent (`@deepseek-ai/dsh-acp`, the official "automation-only" profile; registered as `"dsh": { "kind": "acp", "command": ["dsh", "--profile", "acp"] }`). The preferred install is the desktop app's **Manage dsh Command… → Install** menu entry: it puts a `dsh` on PATH whose version always matches the running desktop release. CLI and desktop share `~/.dsh` product data (sessions, credentials, settings) while never sharing executable packages, so a turn started through the bridge shows up in the desktop app's session list (the ACP surface has no title channel — those sessions carry dsh's deterministic fallback titles).

Live-verified 2026-10-09 (dsh 0.2.0-rc.2): the handshake answers protocolVersion 1 (the bridge requests 2 and accepts); `sessionCapabilities` = list/resume/close, so bridge-restart restore takes the adapter's `session/resume` first branch; approvals arrive as standard `session/request_permission` (one-shot allow/reject); thoughts ride `agent_thought_chunk`; models (`deepseek-v4-flash` / `-v4-pro`, …) and `reasoning_effort` (`off`/`low`/`high`/`max`) are standard `session/set_config_option` selects. Images advertise `false` on a bare install (the profile enables them only with a durable attachment store plus an image-capable exact route). The wire chain (spawn → handshake → session/new → prompt → clean auth-error SSE) was exercised through the bridge with the real binary; the model call itself needs provider credentials that machine did not have.

**Known trade-off: no token streaming.** The official ACP surface delivers updates at committed-message granularity (source-verified: it reacts only to `assistant/message` / `tool/call` / `tool/result` events) — tool calls arrive live, but a long pure-text answer lands as one block instead of a token stream. The third-party `dsh-acp-gateway` streams tokens but still pins dsh 0.1.x — not recommended over the official profile.

## ACP clients (the front)

Every entry can additionally serve ACP clients directly: add `"acp": true` and the bridge exposes `ws://<host>:<port>/acp` speaking ACP v1 (`initialize` → `session/new` → `session/prompt`; permission requests arrive as `session/request_permission` with the agent's own options). Same port, same apiKey and Host rules as v1; the client's `session/new` cwd is ignored — the agent runs in the entry's `cwd`. Ready-made clients (browser sidepanels à la acp-sidepanel / chrome-acp, acpx, acp-ui, …) connect as-is: point them at `ws://host:port/acp` with the entry's apiKey as the bearer token. Design notes: [design-acp-front.zh-CN.md](./design-acp-front.zh-CN.md).

Spawn-style clients that launch agents as local commands (Zed, vscode-acp, …) use the stdio door instead: `node cli.mjs acp <entry-name> [--config agents.json]` — that one entry becomes an ACP v1 agent on stdio (protocol on stdout, logs on stderr, no port opened; the entry may omit `port`). With no config file at all, the registry's built-in default for the name is spawned, so `agent-bridge acp claude` works with zero setup — that is the command the ACP Registry listing distributes (see [acp-registry.zh-CN.md](./acp-registry.zh-CN.md)).

## Troubleshooting

- **Start with `agent-bridge doctor`** — it pre-flights the config, every entry's agent binary on PATH, port conflicts (a bridge already serving passes its own check), and the non-loopback apiKey rule; every FAIL prints its fix, and `--json` makes it scriptable. The bullets below cover what a static check can't see.
- **When reporting a problem, include the `[acp]` / `[bridge]` lines from the bridge terminal** — they cover the handshake negotiation, session create/resume, each turn's prompt and response (with stopReason and usage), permission requests, and ignored unknown notifications, and pinpoint which layer failed.
- **The turn streams `Reconnecting... waiting for network` and keeps retrying** — codex cannot reach its model backend. The most common cause: a custom provider authenticates via an **environment variable** (the `env_key` in config.toml, e.g. `OPENAI_API_KEY`), and that variable must be exported in the terminal where you start the bridge (`echo $OPENAI_API_KEY` to check) — the bridge inherits the starting shell's environment only, and every terminal window is its own environment. Export it, then restart the bridge **in that same terminal**.
- `codex CLI not found: 'codex' …` / `agent command not found: '…'` — the agent binary isn't installed or isn't on PATH; install it, or set `"codexBin"` / `"command"` in the config entry.
- No approval events in codex mode — the entry lacks `"approval": "on-request"`.
- An old conversation errors after you swapped the agent behind the bridge — session ids are agent-private (a codex thread id is not a claude session id); clear the chat history and start fresh.
- Everything else works but one agent behaves oddly — check the table above: agents marked "schema-level only" haven't been live-verified; their surprises are exactly what we want to hear about.


## workbuddy

Native adapter (`adapters/workbuddy.mjs`, `kind: 'workbuddy'`) that is a pure **client of the running WorkBuddy AI desktop app**: the desktop spawns and keeps warm a local CodeBuddy Code worker gateway (ACP over Streamable HTTP on a loopback port), and the adapter discovers it automatically — newest-first probe of loopback listening ports for the `/health` signature, or `"workbuddyPort"` on the entry overrides. The desktop app must be installed, logged in, and **running** (no console registration, no OAuth — the adapter never touches credentials; model/login state lives in the WorkBuddy app).

Config entry:

```json
{ "name": "workbuddy", "port": 3953, "apiKey": "", "cwd": "/path/to/your/project" }
```

Live-verified 2026-10-08 (WorkBuddy AI 5.4.3 on macOS, real turns through the bridge): connect (no auth on loopback) → initialize → session/new / session/prompt over Streamable HTTP + SSE; streaming deltas with reasoning folded into `<thinking>` blocks; tool_call events; permission asks surface as approvals (`session/request_permission` answered with the mapped optionId); images ride as ACP image content blocks (`promptCapabilities.image: true`); `session/cancel` interrupts; `loadSession: true` keeps sessionIds alive across bridge restarts (resume via `session/load`). Usage is not exposed by this surface (omitted). Rename has no channel (the bridge answers 501). AskUserQuestion-style prompts are not wired — the session's permission mode (default `bypassPermissions`) auto-resolves them.

Session model, verified on the user's machine 2026-10-08 — worth knowing before you wonder where your conversations went:

- **The worker keeps gateway sessions in memory only.** The ACP session id appears nowhere on disk (checked the app's storage locations) — restarting the WorkBuddy desktop app resets every bridge conversation's server-side context. The next turn automatically continues in a fresh session and streams a `note` saying the earlier context does not carry over; the start event re-maps the new session id, so clients need no changes.
- **The desktop app's own UI does not list conversations started through the bridge.** This is ACP's client-owned session model (the gateway has no list/rename channel), not a bug — your client (browsa, your script) is the session manager. To move a conversation into the desktop, export it from the client and paste it into a new desktop chat.
- **Auto-discovery shells out to `lsof` + `curl`** (present on macOS/Linux; curl also ships with Windows 10+ but lsof does not). On Windows, set `"workbuddyPort"` on the entry explicitly.



