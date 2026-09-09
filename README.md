<p align="center">
  <strong>English</strong> · <a href="./README.zh-CN.md">简体中文</a>
</p>

<h1 align="center">agent-bridge</h1>

<p align="center">
  Run a CLI coding agent on your own machine. Talk to it from <em>any</em> client —<br/>
  a browser extension, an editor, a script, or your own UI. Your subscription is the backend — no model API keys required.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-14171f?style=flat-square" alt="MIT License" /></a>&nbsp;
  <a href="https://github.com/xiaohuzai/agent-bridge/actions/workflows/ci.yml"><img src="https://img.shields.io/badge/CI-test-926c0d?style=flat-square" alt="CI" /></a>&nbsp;
  <a href="#development"><img src="https://img.shields.io/badge/node-%E2%89%A518-c2410c?style=flat-square" alt="node ≥ 18" /></a>&nbsp;
  <a href="https://github.com/xiaohuzai/agent-bridge/issues"><img src="https://img.shields.io/badge/PRs-welcome-3a6b35?style=flat-square" alt="PRs welcome" /></a>
</p>

```mermaid
flowchart LR
    V["v1 clients<br/>scripts · browsa · your UI"] -->|"HTTP + SSE"| B["agent-bridge"]
    W["ACP clients<br/>acpx · acp-ui · mobile"] -->|"WebSocket /acp"| B
    E["editors<br/>Zed · vscode-acp"] -->|"spawns<br/>agent-bridge acp"| B
    B -->|drives| A["coding agents<br/>codex · claude code · …"]
```

One JSON config file turns your local coding agents into services — each entry with its own port, its own api key, its own sessions. Clients reach them through three doors: a built-in minimal HTTP API (v1), ACP over WebSocket, or a spawned ACP agent on stdio. Behind every door the agent keeps its own transcript, sessions and approvals; change one line of config to change the agent — client code never notices.

## Install

Node ≥ 18. Pick **one** of the two ways:

**npm (recommended)** — installs the `agent-bridge` command, which works in any directory:

```bash
npm i -g @xiaohuzai/agent-bridge
```

**From source** — clone the repo and use `node cli.mjs` wherever this README says `agent-bridge`:

```bash
git clone https://github.com/xiaohuzai/agent-bridge && cd agent-bridge
```

Just trying it out? `npx @xiaohuzai/agent-bridge serve` runs without installing.

## Supported agents & prerequisites

| Agent | Install & log in first | Status |
|---|---|---|
| **codex** | `npm i -g @openai/codex`, then any ONE of: `codex login` (ChatGPT subscription) · `export OPENAI_API_KEY=…` · custom provider in `~/.codex/config.toml` | ✅ live-verified |
| **claude code** | `npm i -g @anthropic-ai/claude-code` → run `claude` once to log in · `npm i -g @agentclientprotocol/claude-agent-acp` (official ACP shim) | ✅ live-verified |
| any ACP v2 agent (gemini, opencode, kimi, …) | that agent's own CLI + login (gemini is native ACP: `gemini --experimental-acp`) | ❓ schema-level |

Per-agent details, behavior notes and troubleshooting: [docs/agents.md](./docs/agents.md).

## Configure

Every bridge — single or many — is an entry in one JSON config file; that is the only way to start the bridge. A working starter ships with the repo:

```bash
cp agents.example.json agents.json && chmod 600 agents.json
```

```json
{
  "bridges": [
    { "name": "codex",  "port": 3948, "apiKey": "", "cwd": "~/work",
      "sandbox": "workspace-write", "approval": "on-request" },
    { "name": "claude", "port": 3949, "apiKey": "", "cwd": "~/work" }
  ]
}
```

A single agent is the same thing with one entry — keep only the codex line, for example.

| Field | Meaning |
|---|---|
| `name` | must be a known agent — registry in [`agents-registry.mjs`](./agents-registry.mjs) (today: `codex`, `claude`) |
| `port` | required for serve, unique per bridge (may be omitted for entries used only via `acp`) |
| `apiKey` | `""` / omitted = keyless (loopback only); required when binding non-loopback |
| `command` | optional; overrides the default spawn — e.g. `["npx", "-y", "@agentclientprotocol/claude-agent-acp"]` |
| `cwd` | optional; default = the directory you start serve from (`~` and relative paths are resolved) |
| `acp` | optional; `true` opts this bridge into the ACP-over-WebSocket door (see Three ways to connect) |
| `sandbox` · `approval` · `network` · `codexBin` · `codexHome` · `corsOrigin` | optional, codex-specific tuning |

**Why a registry?** ACP implementations across the ecosystem vary widely — protocol versions, image/permission/streaming support; there is no framework everyone follows. A name enters the registry only after a real, live-verified turn through the bridge, so "supported" is a claim this repo stands behind, not a coin flip. New agent = verify a turn, add one line.

## Start

One command. It reads `./agents.json` by default:

```bash
node cli.mjs serve
# or: node cli.mjs serve --config /path/to/agents.json
```

Every bridge in the file starts and prints its address; Ctrl+C stops them all. Only two flags exist: `--config` (default `./agents.json`) and `--bind` (default `127.0.0.1`) — every other knob is a config-file field (see the table above). Installed from npm? Use `agent-bridge serve` — same flags.

There is exactly one other command: `agent-bridge acp <entry>` (or `node cli.mjs acp <entry>` from a clone) spawns a single config entry as an ACP agent on stdio — see Three ways to connect below.

## From zero to your first chat

New here? The whole journey is about five minutes:

1. **Install Node 18+** from [nodejs.org](https://nodejs.org) if you don't have it.
2. **Get agent-bridge**: `npm i -g @xiaohuzai/agent-bridge` — after this the `agent-bridge` command works in any directory. (Prefer source? Clone the repo and use `node cli.mjs` instead.)
3. **Create your config**: `agent-bridge` needs an `agents.json` in the directory you start it from — copy the starter: `cp agents.example.json agents.json` (Windows: `copy`; npm users: grab it from [the repo](https://github.com/xiaohuzai/agent-bridge/blob/main/agents.example.json)). The starter runs as-is — codex on port 3948, claude on 3949, no password needed on your own machine.
4. **Install & log in to your agent** (see the table above — e.g. `npm i -g @openai/codex`, then `codex login` once).
5. **Start the bridge**:

   ```bash
   agent-bridge serve
   ```

   You'll see:

   ```
   agent-bridge serve: 2 bridges on http://127.0.0.1
     codex       :3948  (no api key — loopback only)
     claude      :3949  (no api key — loopback only)
   ```

6. **Connect browsa**: in browsa's settings, add a bridge provider and point it at `http://127.0.0.1:3948` — that's the codex line above. No key needed on your own machine.
7. **Chat.** Type in browsa; the reply streams back live. When the agent wants to run a command, browsa shows the approval — once / always / deny is your call.

Keep that terminal window open — closing it stops the agents. Want claude too? Add a second bridge in browsa pointing at port 3949.

## Three ways to connect

|  | Built-in HTTP API (v1) | ACP over WebSocket | ACP over stdio |
|---|---|---|---|
| Who it's for | scripts and UIs that want the simplest thing | ACP clients over the network — acpx, acp-ui, mobile UIs | clients that launch agents as local commands — Zed, vscode-acp |
| How to enable | always on | `"acp": true` on the entry | `node cli.mjs acp <entry>` |
| Address | `http://host:port` | `ws://host:port/acp` | launched by the client — no port |
| Lifecycle | resident daemon; sessions survive restarts | same — several clients share the bridge | follows the client; close = stop |
| Auth | Bearer apiKey (loopback may omit) | same apiKey on the WS handshake | none — a local spawn is the trust |

Notes:

- The ACP doors speak **ACP v1** — `initialize` → `session/new` → `session/prompt`; permission requests arrive as `session/request_permission` carrying the agent's own options. Same port and apiKey rules as v1 (the stdio door needs neither).
- A client's `session/new` cwd is ignored — the agent runs in the entry's `cwd`.
- The ACP doors cannot touch v1: opt-in config, separate paths, additive only.
- Design notes: [docs/design-acp-front.zh-CN.md](./docs/design-acp-front.zh-CN.md) (zh-CN).

## The built-in HTTP API (v1)

The minimal door — four endpoints and one SSE event vocabulary, deliberate and frozen. Clients that already speak ACP use the ACP doors above; everyone else starts here.

```mermaid
sequenceDiagram
    autonumber
    participant C as Client
    participant B as agent-bridge
    participant A as Agent (codex / claude)
    C->>B: POST /turns {"text": "…"}
    A-->>B: sessionId
    B-->>C: SSE start {sessionId} — store it
    A-->>B: needs permission
    B-->>C: SSE approval {requestId}
    C->>B: POST /approvals/42 {"choice":"once"}
    A-->>B: reply
    B-->>C: SSE delta… done {full, usage}
```

| Endpoint | Body | Response |
|---|---|---|
| `GET /health` | — | `{ok:true, agent, version, proto:1}` |
| `GET /sessions` | — | `{ok:true, sessions:[{sessionId, busy}]}` |
| `POST /turns` | `{text, sessionId?, images?}` | SSE event stream |
| `POST /approvals/:requestId` | `{choice:'once'\|'always'\|'deny'}` | `{ok:true}` |

A minimal client is curl:

```bash
# alive? which agent?
curl http://127.0.0.1:3948/health

# a turn (-N disables curl buffering so you see the stream)
curl -N -X POST http://127.0.0.1:3948/turns -H 'Content-Type: application/json' \
  -d '{"text":"Run the test suite"}'
# data: {"type":"start","sessionId":"a1b2c3…"}      ← store it, pass it back next turn
# data: {"type":"delta","text":"…"}                 ← reply text, as it streams
# data: {"type":"tool","name":"command","detail":"npm test"}
# data: {"type":"done","full":"…","usage":{"prompt_tokens":N,"completion_tokens":M}}

# continue a conversation — same sessionId, never resend history
curl -N -X POST http://127.0.0.1:3948/turns -H 'Content-Type: application/json' \
  -d '{"text":"Fix the failing one","sessionId":"a1b2c3…"}'

# answer an approval while the turn stream is still open
curl -X POST http://127.0.0.1:3948/approvals/42 -H 'Content-Type: application/json' -d '{"choice":"once"}'

# recover the session list (e.g. after a client restart)
curl http://127.0.0.1:3948/sessions

# images are optional — https: or data: URLs, ≤8 per turn, 4MB body cap
curl -N -X POST http://127.0.0.1:3948/turns -H 'Content-Type: application/json' \
  -d '{"text":"What is in this image?","images":["https://example.com/pic.png"]}'
```

Rules worth knowing:

- `done` / `aborted` / `error` are the terminal events; `": ka"` lines are heartbeats — ignore them.
- **To cancel, hang up**: closing the `/turns` connection interrupts the agent — nothing keeps running headless.
- codex entries need `"approval": "on-request"` to emit `approval` events (ACP agents ask on their own); with the default `"never"`, commands either run inside the sandbox or are refused.
- The session id survives bridge restarts (the agent resumes from its own storage); session ids are agent-private — pointing a client at a different agent means starting a new conversation.

### Write your own client

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
      if (e.type === 'done') { full = e.full || full; }
    }
  }
  return { text: full, sessionId: sid };
}
```

The authoritative contract — edge rules like first-turn session assignment and disconnect semantics — is the header comment of [`server.mjs`](./server.mjs).

## How is this different

- **Multi-agent by design.** One daemon, one config file, N agents — each on its own port with its own key. The first wave of "a web UI for one CLI" projects is gone (archived, sunset); what survived is multi-agent.
- **Approvals are first-class.** Permission requests stream to the client with the agent's own options, and the client decides once / always / deny. The best-known multi-agent HTTP bridge answers "always allow" server-side on the client's behalf — we think that's a bug, not a feature.
- **Live-verified adapters.** codex is driven through its native app-server protocol; everything else through ACP against the official shims. Every protocol fact was captured from real agents, not from docs.
- **Zero dependencies.** One clone, one command. No installer, no container, no database.
- **ACP on both ends.** The bridge speaks ACP toward agents (stdio adapters) and toward clients (WebSocket / stdio fronts) — which is also what qualifies it for the ACP Registry.

## Run it on a remote server

Three steps:

```bash
# ① on the server — fill apiKey for EVERY entry in agents.json (required beyond
#    loopback; the CLI refuses keyless entries otherwise), then bind beyond loopback:
node cli.mjs serve --config agents.json --bind 0.0.0.0

# ② in your cloud console / firewall — open the port (the bridge cannot do this for you)

# ③ from your machine — connect with the key
curl http://SERVER_IP:3948/health -H 'Authorization: Bearer <key>'
```

Notes:

- The traffic is **plain HTTP** — fine inside a company network, VPN or tailnet; if the server is reachable from the public internet, terminate TLS in front (below) or keep the port firewalled to your own IP.
- The agent's credentials and workspace live on the server; the client is just a remote control.
- Boot persistence / crash restart is deliberately out of scope — wrap the one command in a systemd unit or launchd job.

<details>
<summary>TLS with a reverse proxy (public internet)</summary>

```caddy
# Caddyfile — auto-HTTPS + SSE-friendly proxying; the bridge stays on loopback
bridge.example.com {
    reverse_proxy 127.0.0.1:3948 {
        header_up Host 127.0.0.1:3948   # satisfy the loopback Host allowlist
        flush_interval -1               # stream SSE immediately
    }
}
```
(nginx works too: the bridge sends `X-Accel-Buffering: no`; keep proxy read timeouts ≥ 30 s — heartbeats fire every 15 s. No domain? Tailscale gives you one plus a certificate for free.)

</details>

## Known limitations

Everywhere:

- codex's `request_user_input` tool is declined by the bridge (the turn can proceed without it).
- A network-flake retry re-submits the whole prompt — the agent may run a turn twice.

Turns are live-only (all doors):

- A client that disconnects cannot rejoin the same turn; event streams are not resumable (the official ACP remote-transport RFD defers resumability too).
- Request bodies cap at 4MB; ≤8 images per turn.

Protocol notes:

- The ACP adapter negotiates protocolVersion 1–2 (both official shims — codex-acp, claude-agent-acp — speak v1).
- The ACP-over-WebSocket front follows the official remote-transport RFD, which is still Active (not final); when it lands we'll make a compliance pass.

## Development

```bash
npm test   # real adapter + real HTTP server vs scripted fake agents — no installs, no network
```

## License

[MIT](./LICENSE)
