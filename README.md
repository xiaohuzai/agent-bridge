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

**agent-bridge** is a tiny, zero-dependency Node daemon with one job: adapt local CLI agents to a small, versioned HTTP+SSE protocol so that *anything* can drive them. It exists because of a hard boundary — browser extensions live in a sandbox and can never spawn local processes, while CLI agents (codex, claude code, …) speak only stdio. The bridge sits between the two:

```
any client — extension / editor / script / your own UI
   │  plain HTTP to 127.0.0.1  — POST JSON, read SSE
   ▼
agent-bridge  ◄── the process you start in a terminal (~400 lines, no deps)
   │  JSONL over stdio
   ▼
codex app-server  ──►  your ChatGPT/Codex login, or your own model config
```

The same idea as `opencode serve` or other agent HTTP servers — *the agent is the server, any UI is a client* — except codex and claude code don't ship an HTTP server, so this repo is the missing ~400 lines. One client implementation works with every agent behind the bridge; one agent adapter works with every client in front of it.

## Quick start

```bash
# 0. Prerequisite: a working codex CLI. Any ONE of these auth paths works —
codex login                    # ① ChatGPT subscription login (Plus/Pro — no API key)
export OPENAI_API_KEY=sk-...   # ② or an OpenAI API key (no subscription, no login)
# ③ or a custom provider in ~/.codex/config.toml ([model_providers.*] pointing at
#    your own gateway / local model) — no codex login at all. Note: codex ≥0.149
#    requires wire_api = "responses"; chat-completions-only endpoints are rejected
#    by codex itself (the bridge does not restrict this).

# 1. Start the bridge
npx browsa-agent-bridge codex --port 3948      # npm package
node cli.mjs codex --port 3948                 # or straight from a checkout

# 2. Talk to it — curl is a complete client:
curl -N -X POST http://127.0.0.1:3948/turns \
  -H 'Content-Type: application/json' \
  -d '{"text":"Summarize this in one sentence"}'
```

## The wire protocol (v1)

Four rules are the whole client contract:

1. **`POST /turns` with `{text, sessionId?}`** and read the SSE stream. On the first turn omit `sessionId` — the agent assigns one and reports it on the `start` event; store it and pass it back on every later turn (the agent keeps its own transcript; you never resend history).
2. **`done` / `aborted` / `error` end the turn.** Until then, `delta` events carry the reply text, `tool` events report agent activity, `usage` arrives once with token counts. `": ka"` comment lines are keepalives during silent stretches — ignore them.
3. **To cancel, close the connection.** The bridge notices the disconnect and interrupts the agent server-side. Turns are live-only — there is no replay of a turn you left.
4. **Approvals** (when the agent is configured to ask): an `approval` event arrives with a `requestId`; answer it with `POST /approvals/:requestId` and `{choice:'once'|'always'|'deny'}` while the turn's stream stays open.

```
GET  /health                   → {ok:true, agent, version, proto:1}
GET  /sessions                 → {ok:true, sessions:[{sessionId, busy}]}   ← recover ids after a client restart
POST /turns                    → SSE: start / delta / tool / approval / usage / done / aborted / error
                               body: {text, sessionId?, images?} — images are https:/data: URLs (≤8)
POST /approvals/:requestId     → {ok:true}
```

The authoritative contract — including edge rules like first-turn session assignment and disconnect semantics — is the header comment of [`server.mjs`](./server.mjs).

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

## CLI options

```bash
browsa-agent-bridge codex [options]
  --port N              listen port (default 3948, loopback only)
  --cwd DIR             agent workspace (default: current directory)
  --sandbox MODE        read-only | workspace-write | danger-full-access (default read-only)
  --network             allow network inside a workspace-write sandbox
  --approval POLICY     never | on-request | untrusted (default never)
  --token TOKEN         require this bearer token on every request
  --cors-origin MODE    loopback (default) | * (any origin; use with --token)
  --codex-bin PATH      codex binary (default: codex on PATH)
  --codex-home DIR      CODEX_HOME override (default: ~/.codex)
```

**Safe defaults**: read-only sandbox + `--approval never`. The agent can read and reason but commands that would escape the sandbox are refused. Give it write access with `--sandbox workspace-write` (add `--network` if it needs the net). Want to approve each escape from your client's UI? `--approval on-request` — the client receives `approval` events and answers via `POST /approvals/:id`.

## Sessions, approvals, abort

- **Session id = the agent's own thread id**, assigned on the first turn and reported on the `start` event. Survives bridge restarts (`thread/resume` restores from disk). `GET /sessions` lists known sessions and their busy state — use it to recover ids after a client restart.
- **Approvals are a full round trip**: the agent asks as a JSON-RPC request → the bridge forwards a wire `approval` event → the client answers → the decision goes back into the agent's stdin.
- **Abort = hang up**: closing the `POST /turns` connection is the interrupt. The bridge notices the disconnect and interrupts the agent, so nothing keeps running headless.

## Adding an agent

One file per agent in [`adapters/`](./adapters) implementing four methods — `startTurn`, `interrupt`, `respondApproval`, `stop` — plus a line in `cli.mjs`. claude code is the next adapter (`claude -p --input-format stream-json --output-format stream-json` + `--resume`); an agent without approvals or streaming still works — the protocol degrades (final text arrives with `done`, safe sandbox defaults apply).

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

## License

[MIT](./LICENSE)
