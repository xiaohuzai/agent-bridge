<p align="center">
  <strong>English</strong> · <a href="./README.zh-CN.md">简体中文</a>
</p>

<h1 align="center">agent-bridge</h1>

<p align="center">
  Run a CLI coding agent on your own machine, chat with it from <a href="https://github.com/xiaohuzai/browsa">browsa</a>'s sidebar.<br/>
  Your subscription becomes the backend — no API keys required.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-14171f?style=flat-square" alt="MIT License" /></a>&nbsp;
  <a href="https://github.com/xiaohuzai/agent-bridge/actions/workflows/ci.yml"><img src="https://img.shields.io/badge/CI-test--18%2C%2020%2C%2022-926c0d?style=flat-square" alt="CI" /></a>&nbsp;
  <a href="#development"><img src="https://img.shields.io/badge/node-%E2%89%A518-c2410c?style=flat-square" alt="node ≥ 18" /></a>&nbsp;
  <a href="https://github.com/xiaohuzai/agent-bridge/issues"><img src="https://img.shields.io/badge/PRs-welcome-3a6b35?style=flat-square" alt="PRs welcome" /></a>
</p>

---

**agent-bridge** is a tiny, zero-dependency Node daemon that adapts local CLI agents to a small HTTP+SSE protocol (**BAP — browsa Agent Protocol**). It exists because browser extensions live in a sandbox and can never spawn local processes, while CLI agents (codex, claude code, …) speak only stdio. The bridge sits between them:

```
browsa sidebar (Chrome/Edge extension, sandboxed)
   │  plain fetch() to 127.0.0.1  — BAP over HTTP+SSE
   ▼
agent-bridge  ◄── the process you start in a terminal (~400 lines, no deps)
   │  JSONL over stdio
   ▼
codex app-server  ──►  your ChatGPT/Codex login, or your own model config
```

The same idea as `opencode serve` or Hermes's API server — *the agent is the server, any UI is a client* — except codex and claude code don't ship an HTTP server, so this repo is the missing ~400 lines.

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

# 2. browsa → ⚙ Settings → "Agent Bridge" card → Base URL = http://127.0.0.1:3948
#    → Save → Ping (should say: agent-bridge (codex) healthy)
```

Any BAP client works, not just browsa — `curl` is enough to drive a turn:

```bash
curl -N -X POST http://127.0.0.1:3948/turns \
  -H 'Content-Type: application/json' \
  -d '{"text":"Summarize this in one sentence"}'
```

## CLI options

```bash
browsa-agent-bridge codex [options]
  --port N              listen port (default 3948, loopback only)
  --cwd DIR             agent workspace (default: current directory)
  --sandbox MODE        read-only | workspace-write | danger-full-access (default read-only)
  --network             allow network inside a workspace-write sandbox
  --approval POLICY     never | on-request | untrusted (default never)
  --token TOKEN         require this bearer token on every request
  --codex-bin PATH      codex binary (default: codex on PATH)
  --codex-home DIR      CODEX_HOME override (default: ~/.codex)
```

**Safe defaults**: read-only sandbox + `--approval never`. The agent can read and reason but commands that would escape the sandbox are refused. Give it write access with `--sandbox workspace-write` (add `--network` if it needs the net). Want to approve each escape click-by-click from browsa's approval card? `--approval on-request`.

## Sessions, approvals, abort

- **Session id = codex threadId**, assigned on the first turn and reported on the SSE `start` event; the client stores it and passes it back on later turns, so the agent keeps its own transcript. Survives bridge restarts (`thread/resume` restores from disk).
- **Approvals** are a full round trip: codex asks as a JSON-RPC request → bridge forwards a BAP `approval` event → the client answers via `POST /approvals/:id` → the decision (`accept` / policy amendment / `cancel`) goes back into codex's stdin.
- **Abort = hang up**: closing the `POST /turns` connection is the interrupt. The bridge notices the disconnect and `turn/interrupt`s the agent, so nothing keeps running headless.

## BAP v1

```
GET  /health                   → {ok:true, agent, version, proto:1}
POST /turns {text, sessionId?} → SSE stream:
     {"type":"start","sessionId":"…","turnId":"…"}   (turnId may be "" until admitted)
     {"type":"delta","text":"…"}
     {"type":"tool","name":"command","status":"started","detail":"…"}
     {"type":"approval","requestId":"…","tool":"command","command":"…","cwd":"…"}
     {"type":"usage","prompt_tokens":N,"completion_tokens":M}
     {"type":"done","full":"…"} | {"type":"aborted"} | {"type":"error","message":"…"}
     (": ka" comment lines are keepalives during silent stretches)
POST /approvals/:requestId {choice:'once'|'always'|'deny'} → {ok:true}
```

The protocol is deliberately tiny and versioned (`proto:1`); the full wire contract, including the client-side rules (disconnect semantics, session reuse), lives in the header comment of [`server.mjs`](./server.mjs).

## Adding an agent

One file per agent in [`adapters/`](./adapters) implementing four methods — `startTurn`, `interrupt`, `respondApproval`, `stop` — plus a line in `cli.mjs`. claude code is the next adapter (`claude -p --input-format stream-json --output-format stream-json` + `--resume`); an agent without approvals or streaming still works — BAP degrades (final text arrives with `done`, safe sandbox defaults apply).

## Platforms

One codebase, Node ≥ 18, no npm dependencies. Linux is CI- and battle-tested; macOS should work unchanged (no shell tricks — everything is Node); Windows gets an explicit `shell` spawn (npm `.cmd` shims) and stdin-close-on-stop handling. Details in the [README.zh-CN.md platform notes](./README.zh-CN.md#平台支持) — first-hand reports from each platform are very welcome.

## Development

```bash
npm test          # real adapter + real HTTP server vs a scripted fake codex
```

[`test/fake-codex-app-server.mjs`](./test/fake-codex-app-server.mjs) is a scripted stand-in built from frames captured live against codex-cli 0.149.1, so the suite needs no codex install and no network. codex moves fast — after upgrading it, re-dump the protocol with `codex app-server generate-json-schema --out /tmp/x` and re-check the method names documented in the adapter header.

## Known limitations (v1)

- Images are not forwarded to the agent yet.
- codex's `request_user_input` tool is not mapped to a clarify card (the bridge declines it so the turn can proceed).
- A network-flake retry re-submits the whole prompt — the agent may run a turn twice (same tradeoff as opencode/Hermes integrations).
- Approvals were verified live against the protocol (schema + captured frames + error paths); the interactive card flow is exercised in CI against the fake codex.

## License

[MIT](./LICENSE)
