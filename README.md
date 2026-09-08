<p align="center">
  <strong>English</strong> · <a href="./README.zh-CN.md">简体中文</a>
</p>

<h1 align="center">agent-bridge</h1>

<p align="center">
  Run a CLI coding agent on your own machine. Talk to it from <em>any</em> client —<br/>
  a browser extension, an editor, a script, or your own UI. Your subscription is the backend; no API keys required.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-14171f?style=flat-square" alt="MIT License" /></a>&nbsp;
  <a href="https://github.com/xiaohuzai/agent-bridge/actions/workflows/ci.yml"><img src="https://img.shields.io/badge/CI-test-926c0d?style=flat-square" alt="CI" /></a>&nbsp;
  <a href="#development"><img src="https://img.shields.io/badge/node-%E2%89%A518-c2410c?style=flat-square" alt="node ≥ 18" /></a>&nbsp;
  <a href="https://github.com/xiaohuzai/agent-bridge/issues"><img src="https://img.shields.io/badge/PRs-welcome-3a6b35?style=flat-square" alt="PRs welcome" /></a>
</p>

---

**agent-bridge** is a tiny, zero-dependency Node daemon with one job: adapt local CLI agents to a small, versioned HTTP+SSE protocol (v1) so that *anything* can drive them. It exists because of a hard boundary — browser extensions live in a sandbox and can never spawn local processes, while CLI agents (codex, claude code, …) speak only stdio. The bridge sits between the two: one client implementation drives every agent behind the bridge; one agent adapter serves every client in front of it.

```
any client — extension / editor / script / your own UI
   │  plain HTTP to 127.0.0.1  — POST JSON, read SSE
   ▼
agent-bridge  ◄── the process you start in a terminal (~400 lines, no deps)
   │  JSONL over stdio
   ▼
codex app-server  ──►  your ChatGPT/Codex login, or your own model config
```

## Quick start

```bash
# 0. Prerequisite: a working, logged-in CLI agent. codex, for example — any ONE of:
codex login                    # ① ChatGPT subscription login (Plus/Pro — no API key)
export OPENAI_API_KEY=sk-...   # ② or an OpenAI API key
# ③ or a custom provider in ~/.codex/config.toml ([model_providers.*] pointing at
#    your own gateway / local model). Note: codex ≥0.149 requires
#    wire_api = "responses"; chat-completions-only endpoints are rejected by
#    codex itself (the bridge does not restrict this).

# 1. Get the bridge — zero dependencies; a clone is enough, no npm install
git clone https://github.com/xiaohuzai/agent-bridge && cd agent-bridge

# 2. Start it — codex, or any ACP v2 agent (per-agent install & login: docs/agents.md)
node cli.mjs codex --port 3948 --approval on-request   # codex via its app-server; approval events route to the client
node cli.mjs acp -- claude-agent-acp     # claude code — install the official claude-agent-acp shim first
node cli.mjs acp -- gemini --experimental-acp   # any ACP agent command works

# 3. Talk to it — curl is a complete client:
curl -N -X POST http://127.0.0.1:3948/turns \
  -H 'Content-Type: application/json' \
  -d '{"text":"Summarize this in one sentence"}'
```

## The wire protocol (v1): a usage guide

Four rules are the whole client contract:

1. **`POST /turns` with `{text, sessionId?}`** and read the SSE stream. On the first turn omit `sessionId` — the agent assigns one and reports it on the `start` event; store it and pass it back on every later turn (the agent keeps its own transcript; you never resend history).
2. **`done` / `aborted` / `error` end the turn.** Until then, `delta` events carry the reply text, `tool` events report agent activity, and an `approval` event is yours to answer. `": ka"` comment lines are keepalives during silent stretches — ignore them.
3. **To cancel, close the connection.** The bridge notices the disconnect and interrupts the agent server-side. Turns are live-only — there is no replay of a turn you left.
4. **Approvals**: when an `approval` event arrives with a `requestId`, answer it with `POST /approvals/:requestId` and `{choice:'once'|'always'|'deny'}` while the turn's stream stays open.

### A complete conversation, step by step

```bash
# ① Probe the bridge: alive? which agent? which protocol version?
curl http://127.0.0.1:3948/health
# → {"ok":true,"agent":"codex","version":"1.0.0","proto":1}

# ② Start a turn (-N disables curl buffering, or you won't see streaming)
curl -N -X POST http://127.0.0.1:3948/turns \
  -H 'Content-Type: application/json' \
  -d '{"text":"Run this project's test suite"}'
```

The SSE stream arrives piece by piece; each `data:` line is one JSON event:

```
data: {"type":"start","sessionId":"a1b2c3…","turnId":""}   ← first turn assigns the session id — store it
data: {"type":"tool","name":"command","status":"started","detail":"npm test"}
data: {"type":"approval","requestId":"42","tool":"command","command":"npm install","cwd":"/repo"}
```

An `approval` event means the agent wants to run something that needs permission. Answer it **while the turn's stream is still open** (another terminal is fine). `approval` events only arrive when the bridge is started with `--approval on-request` — the Quick start command already includes it; with the default `never` there is no approval step: commands either run inside the sandbox or get refused:

```bash
# ③ Answer the approval: choice ∈ once | always | deny
curl -X POST http://127.0.0.1:3948/approvals/42 \
  -H 'Content-Type: application/json' -d '{"choice":"once"}'
# → {"ok":true}    (409 = that approval is already gone)
```

The stream continues until a **terminal event** (`done` / `aborted` / `error`) arrives and the connection closes:

```
data: {"type":"delta","text":"All 23 tests pass."}
data: {"type":"done","full":"All 23 tests pass.","usage":{"prompt_tokens":1234,"completion_tokens":567}}
```

```bash
# ④ Second turn: pass the stored sessionId (never resend history — the agent remembers)
curl -N -X POST http://127.0.0.1:3948/turns \
  -H 'Content-Type: application/json' \
  -d '{"text":"Fix the failing one","sessionId":"a1b2c3…"}'

# ⑤ Any time (e.g. after a client restart), recover the session list
curl http://127.0.0.1:3948/sessions
# → {"ok":true,"sessions":[{"sessionId":"a1b2c3…","busy":false}]}
```

To interrupt a runaway turn, just close the ② connection — the bridge interrupts the agent; nothing keeps running headless.

### Endpoint reference

| Method & path | Body | Success response | Errors |
|---|---|---|---|
| `GET /health` | — | `{ok:true, agent, version, proto:1}` | 401 bad token · 403 non-loopback Host |
| `GET /sessions` | — | `{ok:true, sessions:[{sessionId, busy}]}` | — |
| `POST /turns` | `{text, sessionId?, images?}` (images ≤8 https:/data: URLs) | SSE event stream (see below) | 400 missing text / bad images / body over 4MB |
| `POST /approvals/:requestId` | `{choice:'once'\|'always'\|'deny'}` | `{ok:true}` | 400 bad choice · 409 approval no longer pending |

Started with `--token`, every request must carry `Authorization: Bearer <token>`.

### Event reference

| Event | Fields | Meaning |
|---|---|---|
| `start` | `sessionId`, `turnId` | Turn admitted; the first turn assigns `sessionId` here |
| `delta` | `text` | Incremental reply text |
| `tool` | `name`, `status: started\|completed\|failed`, `detail` | Agent activity (running commands, editing files…) |
| `approval` | `requestId`, `tool`, `command` (codex also `cwd`) | Agent asks for permission — answer via `POST /approvals/:requestId` |
| `done` | `full`, `usage?`, `finishReason?` | **Terminal**: completed normally; `usage` is `{prompt_tokens, completion_tokens}` |
| `aborted` | — | **Terminal**: the turn was interrupted |
| `error` | `message` | **Terminal**: something failed |

Note: token counts are currently carried on the `done` event's `usage` field (a standalone `usage` event type is reserved in the protocol for adapters that stream it earlier); `": ka"` comment lines are heartbeats — ignore them.

### A minimal client (~20 lines)

```js
async function turn(text, sessionId) {
  const res = await fetch('http://127.0.0.1:3948/turns', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, sessionId }),
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '', full = '', sid = sessionId;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const e = JSON.parse(line.slice(5));
      if (e.type === 'start') sid = e.sessionId;
      if (e.type === 'delta') full += e.text;
      if (e.type === 'tool') console.error(`[tool] ${e.status}: ${e.detail}`);
      if (e.type === 'done') { full = e.full || full; }
    }
  }
  return { text: full, sessionId: sid };
}
```

**Browser clients**: the bridge answers CORS preflights and reflects only loopback origins (`http(s)://localhost:*`, `http(s)://127.0.0.1:*`), so a page served from localhost can call it directly while random web origins are refused. Pass `--cors-origin '*'` to open every origin — pair it with `--token` when you do. Non-browser clients (Node, Python, curl) need none of this.

### Behavioral guarantees

- **sessionId = the agent's own session id.** It survives bridge restarts (codex `thread/resume` / ACP `session/resume` restore from disk); `GET /sessions` recovers ids and busy state after a client restart.
- **Approvals are a full round trip**: the agent asks → the bridge forwards a wire `approval` event → the client answers → the decision goes back into the agent. An unanswered approval waits forever; close the connection when you'd rather not wait.
- **Abort = hang up**: closing the `POST /turns` connection is the interrupt — nothing keeps running headless.

The authoritative contract — including edge rules like first-turn session assignment and disconnect semantics — is the header comment of [`server.mjs`](./server.mjs).

## CLI reference

```bash
node cli.mjs codex [options]          # codex via its app-server
node cli.mjs acp -- <agent command…>  # any ACP v2 agent; everything after `--` belongs to the agent
```

| Option | Meaning |
|---|---|
| `--port N` | listen port (default 3948) |
| `--bind ADDR` | bind address (default `127.0.0.1`; non-loopback binds require `--token` — see [Remote access](#remote-access)) |
| `--cwd DIR` | agent workspace (default: current directory) |
| `--token TOKEN` | require this bearer token on every request |
| `--cors-origin MODE` | loopback (default) \| `*` (any origin; use with `--token`) |
| `--sandbox MODE` | **codex only**: read-only (default) \| workspace-write \| danger-full-access |
| `--network` | **codex only**: allow network inside a workspace-write sandbox |
| `--approval POLICY` | **codex only**: never (default) \| on-request \| untrusted — turn on on-request to receive `approval` events |
| `--codex-bin PATH` | **codex only**: codex binary (default: codex on PATH) |
| `--codex-home DIR` | **codex only**: CODEX_HOME override (default: ~/.codex) |

**Safe defaults**: read-only sandbox + `--approval never`. The agent can read and reason but commands that would escape the sandbox are refused. Give it write access with `--sandbox workspace-write` (add `--network` if it needs the net). Want to approve each escape from your client's UI? `--approval on-request`. In acp mode, sandboxing and permissions are governed by the agent's own policy, and its permission requests are always routed to the client.

### Remote access

By default the bridge binds `127.0.0.1` only. `--bind` opens it up — and the CLI refuses a non-loopback bind without `--token`:

```bash
# LAN / VPN / tailnet
node cli.mjs codex --bind 0.0.0.0 --token $(openssl rand -hex 16)
```

Notes for non-loopback binds:

- **Public internet: put TLS in front.** The bridge speaks plain HTTP — every request (token included) is cleartext until TLS is terminated somewhere. The cleanest deployment keeps the bridge on loopback and lets a reverse proxy own the certificate:
  ```caddy
  # Caddyfile — TLS + SSE-friendly proxying; no --bind needed at all
  bridge.example.com {
      reverse_proxy 127.0.0.1:3948 {
          header_up Host 127.0.0.1:3948   # satisfy the loopback Host allowlist
          flush_interval -1               # stream SSE immediately
      }
  }
  ```
  (nginx works too: the bridge sends `X-Accel-Buffering: no`, so SSE arrives unbuffered; keep proxy read timeouts ≥ 30 s — heartbeats fire every 15 s.)
- **`--bind 0.0.0.0` + `--token`** is for trusted networks (LAN/VPN). On a loopback bind, a non-loopback `Host` header is rejected (DNS-rebinding guard); on non-loopback binds that check is skipped — hostnames are legit there and the token is the gate.
- **Web pages on other origins** still get no CORS headers (unchanged rules: loopback origins reflected; `--cors-origin '*'` to open up, pair with `--token`). Browser extensions don't need CORS.
- **The token is a shared static credential** — no expiry, no per-device keys. Whoever holds it runs the agent with the server's credentials and filesystem. Use a long random value and rotate when in doubt; for purely personal use an SSH tunnel (`ssh -N -L 3948:127.0.0.1:3948 host`) remains the zero-config option.

## Adding an agent

**Two ways to start the bridge, one client interface** — the start command and flags vary by agent, but once the bridge is up, clients face the same wire protocol: four endpoints, one event vocabulary, the same approval round trip. A client like browsa never needs to (and has no way to) distinguish which agent sits behind the bridge:

| | codex mode | acp mode |
|---|---|---|
| Start command | `node cli.mjs codex --port 3948 --approval on-request` | `node cli.mjs acp -- <agent command>` |
| Protocol the agent speaks | codex's private app-server JSON-RPC | ACP v2 (stdio, NDJSON) |
| When approvals happen | you set the policy with `--approval` (default never: no asks) | the agent's own permission system decides; the bridge always relays |
| Sandboxing | issued by the bridge (`--sandbox` / `--network`) | governed by the agent's own policy |
| Images | data:/https URLs taken directly | require the agent's advertised `promptCapabilities.image`, else degrade to text |
| Good for | codex | claude code, gemini, opencode… any ACP v2 agent |

A few optional event fields vary by agent (e.g. the `approval` event carries `cwd` for codex, the agent's own option list for ACP); core fields and semantics are identical. **Per-agent install, login, and behavior notes** (e.g. claude code needs the `claude-agent-acp` shim installed first) live in [docs/agents.md](./docs/agents.md).

**Speak ACP v2? Zero code** — `node cli.mjs acp -- <command>` spawns any ACP agent and maps turns, streaming, tool calls, approvals, and usage onto the protocol above: claude code via `acp -- claude-agent-acp`, gemini via `acp -- gemini --experimental-acp`, likewise opencode, kimi, qwen and friends. Images require the agent's advertised `promptCapabilities.image`, otherwise they degrade to a text note (never written to disk). The adapter speaks ACP v1 **and** v2 (negotiated at initialize) and has been live-verified end-to-end — real model turns through the bridge — against the official codex-acp and claude-agent-acp shims.

**What is ACP?** The Agent Client Protocol, an open standard started by Zed ([agentclientprotocol.com](https://agentclientprotocol.com)) — "LSP for agents": the client spawns the agent CLI as a subprocess and the two speak JSON-RPC 2.0 over stdio (NDJSON). By design it binds **no port**; the official remote transport (WebSocket / Streamable HTTP) is still an RFD. The bridge's acp mode acts as the ACP **client**; what the bridge exposes to its users is always the HTTP+SSE protocol above. Once the official remote transport lands, the bridge plans an ACP-over-WebSocket front so existing ACP clients can connect unchanged.

An agent whose native protocol is *richer* than ACP deserves a bespoke adapter — codex ships one, because its app-server protocol was verified to be stronger than going through codex-acp (live-captured approval vocabulary, per-turn sandbox policy): one file in [`adapters/`](./adapters) implementing `startTurn` / `interrupt` / `respondApproval` / `stop` + a line in `cli.mjs`. An agent without approvals or streaming still works — the protocol degrades (final text arrives with `done`, safe sandbox defaults apply).

## Platforms

One codebase, Node ≥ 18, no npm dependencies. Linux is CI- and battle-tested; macOS should work unchanged (no shell tricks — everything is Node); Windows gets an explicit `shell` spawn (npm `.cmd` shims) and stdin-close-on-stop handling. First-hand reports from each platform are very welcome.

## Development

```bash
npm test          # real adapter + real HTTP server vs a scripted fake codex
```

[`test/fake-codex-app-server.mjs`](./test/fake-codex-app-server.mjs) is a scripted stand-in built from frames captured live against codex-cli 0.149.1, so the suite needs no codex install and no network. codex moves fast — after upgrading it, re-dump the protocol with `codex app-server generate-json-schema --out /tmp/x` and re-check the method names documented in the adapter header.

## Known limitations (v1)

- Total request size is capped at 4MB (bounds inline base64 images to a few MB).
- codex's `request_user_input` tool is declined by the bridge (the turn can proceed without it).
- A network-flake retry re-submits the whole prompt — the agent may run a turn twice.
- Turns are live-only: a client that disconnects cannot rejoin the same turn.
- The generic ACP adapter negotiates protocolVersion 1–2 at initialize (both OFFICIAL shims — codex-acp, claude-agent-acp — speak v1) and has been live-verified end-to-end — real model turns through the bridge — against official codex-acp and claude-agent-acp.

## License

[MIT](./LICENSE)
