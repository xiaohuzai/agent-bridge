# AGENTS.md

Guidance for coding agents working in this repository.

## What this repo is

**agent-bridge** is a UI-agnostic, zero-dependency Node daemon that adapts local CLI coding agents to a small HTTP+SSE wire protocol (v1). Any client (browser extension, editor, script, your own UI) implements the client side once; any agent is reached through an adapter. It is deliberately NOT tied to any product, UI, or vendor — do not add product-specific coupling, branding, or features that only make sense for one client.

Non-goals (decided, do not re-propose): becoming a chat UI; letting agents control the browser (the reverse direction — that posture is security-contaminated); renaming the repo with an `-acp` suffix (in the ACP ecosystem that suffix means "the ACP adapter for X", which would re-introduce exactly the coupling this repo avoids — ACP lives in the README, topics, the future `/acp` endpoint, and the ACP Registry listing).

## Commands

```bash
npm test                              # the whole suite (node --test test/*.test.mjs)
node --test test/agent-bridge-acp.test.mjs   # one file
npm pack && tar -tzf xiaohuzai-agent-bridge-*.tgz   # publish dry-run (files whitelist matters)
```

No npm dependencies, no build step, no network in tests. CI is a single job named **`Test`** (node 20) running `npm test`.

## Architecture

```
fronts (what clients speak)              core            adapters (what agents speak)
├── server.mjs  — wire protocol v1  ──►  sessions/  ◄── adapters/codex-app-server.mjs
│   HTTP+SSE: /health /sessions          turns/          (codex app-server JSON-RPC)
│   /turns /approvals/:id                approvals       adapters/acp-stdio.mjs
├── acp-front-ws.mjs — ACP v1 over                       (ANY ACP v2 agent command)
│   WebSocket at /acp (opt-in "acp": true)
└── acp-front-stdio.mjs — ACP v1 over stdio
    (`agent-bridge acp <entry>` — the bridge as a spawnable agent)
```

`cli.mjs` has two modes over the same config file: `serve [--config agents.json] [--bind ADDR]` (default) starts every bridge — one per known agent, each on its own port (apiKey optional on loopback, required for non-loopback binds; `agents.example.json` ships as a working starter) — and `acp <entry> [--config FILE]` spawns ONE config entry as an ACP v1 agent on stdio (for clients that launch agents as local commands; stdout = protocol only, logs = stderr, no port opened). The agent NAME registry (`agents-registry.mjs`) is the single source of truth for serve configs and client-side pickers (browsa mirrors it); long-tail agents join by adding a line there, not by loosening the config. Auth is the per-bridge `apiKey` config field (serve/WS only — the stdio door is local by construction). The server is adapter-agnostic — it only calls four methods: `startTurn({text, sessionId, images, onEvent})`, `interrupt(sessionId)`, `respondApproval(requestId, choice)`, `stop()`. `onEvent` emits `{type: 'start'|'delta'|'tool'|'approval'|'usage'|'done'|'aborted'|'error'}`.

The authoritative wire-protocol contract is the header comment of `server.mjs`. Core invariants:
- Session ids are assigned by the adapter on the first turn and reported on the `start` event; the client stores and returns them. Sessions must survive a bridge restart (resume from the agent's own persistence).
- **Disconnect = abort.** The bridge listens on `res.on('close')` — NEVER `req.on('close')` (Node ≥16 fires the latter as soon as the request body is consumed: an instant false abort that swallows whole turns). The session id may only become known when `startTurn` returns, so the disconnect handler tracks it on a mutable and a post-admission `res.destroyed` check covers aborts that raced admission. Additionally, server.mjs patches `liveSession` from the `start` event itself — v1-style ACP agents keep the session/prompt rpc pending for the WHOLE turn, so without the start-event patch a mid-turn disconnect would never interrupt.
- Turns are live-only: no replay of a turn the client left.
- Heartbeats (`: ka` SSE comments) fire every 15s during silent stretches.

## Verification discipline (this repo's most important rule)

Every agent-side protocol fact in the adapters was captured LIVE, not read from docs. The adapters' header comments are the record. When an agent CLI moves fast (codex does):

1. Re-dump the protocol from the binary: `codex app-server generate-json-schema --out /tmp/x` (ACP: the official repo's `schema/v2/schema.json`).
2. Drive it with a mock backend and capture real frames before writing code.
3. Only then change the adapter, and record new facts in the header comment.

Known traps already paid for (do not rediscover):
- **codex**: `thread/start` takes `sandbox` as a kebab-case STRING; the camelCase `sandboxPolicy` object belongs to per-turn `turn/start` (that's where `networkAccess` lives). `turn/completed` carries the turn id NESTED as `params.turn.id` (every other notification uses `params.turnId`). Approvals use the v2 vocabulary — `item/commandExecution/requestApproval` answered with `{decision:'accept'|'cancel'|{acceptWithExecpolicyAmendment}}`; answering v1-style `{decision:'approved'}` silently no-ops. Usage is `thread/tokenUsage/updated` → `tokenUsage.last` (`total` is cumulative). `wire_api = "chat"` is gone; mock backends must speak /v1/responses SSE.
- **stdio batch race**: codex batches the turn/start RESPONSE and the first notifications into one stdio chunk, and frame processing is synchronous — a turn entry registered after the `await rpc()` resumes drops the whole batch. Fix pattern: pre-register the turn entry BEFORE the rpc with an awaiting window (accept any turnId until patched), and emit the client-visible `start` event BEFORE the rpc (sessionId is already known — emitting it after reordered it behind same-chunk deltas and, worst case, let `done` swallow it).
- **Notification matching must be by turn id** (or a per-session state machine): array-searching "the latest turn/completed" eats a previous turn's stale notification and fakes completion.
- **data: URLs work**: codex accepts `{type:'image', url:'data:…'}` and forwards it verbatim to the backend as `input_image` — no temp files, ever. ACP gates images behind the agent's advertised `promptCapabilities.image`; degrade to a text note, never write images to disk.
- **Windows**: npm CLI shims are `.cmd` — `spawn` needs `shell:true` there (args contain no metacharacters). On stop, close stdin before kill so shim-wrapped agents exit.
- **spawn failure is an async `error` event, not a throw**: a missing agent binary (ENOENT) becomes an uncaughtException that kills the whole bridge unless the child has an `error` listener (first-run trap: `/health` looks fine, the first turn kills the daemon). Both adapters attach one: reject pending rpcs with an install-hint message (server.mjs relays it as the turn's SSE `error`), null the child so later turns retry. Tests spawn deliberately nonexistent binaries.
- **ACP versions**: the bridge requests protocolVersion 2 and ACCEPTS 1 or 2 — both OFFICIAL shims (agentclientprotocol/codex-acp 1.10.0, claude-agent-acp 0.75.1) speak **v1** (live-verified 2026-09-07). v2 semantics: `session/prompt` only ACKNOWLEDGES; completion arrives via `state_update {state:'idle', stopReason}` (`end_turn`/`max_tokens`/`refusal`/`cancelled`). v1 semantics: the session/prompt RPC RESPONSE is the turn terminator (`{stopReason, usage}` — map `inputTokens`/`outputTokens` to prompt_tokens/completion_tokens; `cancelled` → aborted), so that rpc runs with NO timeout (a trivial turn took 17s through a real gateway) and the server must learn the session from the `start` event. `session/request_permission` options carry `kind` (`allow_once|allow_always|reject_once|reject_always`) — map the client's once/always/deny by kind onto the agent's own `optionId`, and while cancelling, pending permission requests MUST be answered `{outcome:{outcome:'cancelled'}}`. Images require the agent's advertised `promptCapabilities.image` (under `agentCapabilities` on the official shims, `capabilities` on the older Zed shim — read both). `initialize` must be the first message. Known UPSTREAM gap (not ours to fix): codex-acp drops the final agent text when the backend sends `item/completed {agentMessage}` without prior deltas (non-streaming gateways — it `return null`s the completed item and only forwards deltas); our native codex adapter has the completed-items fallback and is unaffected.

## Testing conventions

- Tests drive the REAL adapter and REAL HTTP server against scripted fake agents (`test/fake-codex-app-server.mjs`, `test/fake-acp-agent.mjs`) — executable shebang scripts speaking JSONL on stdio, with prompt markers (APPROVE/SLOW/FAIL/IMG) triggering the interesting paths. No codex/claude install, no network.
- Keep test buffers tiny; CI boxes are small.
- Undici gotchas (do not rediscover): cancelling an SSE reader does NOT tear down the socket — abort the fetch SIGNAL in disconnect tests; a locally-constructed `Response` body does not end reads on signal abort — race `reader.read()` against an abort promise.
- `node --test test/` (directory form) mis-parses as a main module on several Node builds — always go through the package.json glob.

## Git workflow & branch protection

`main` is protected (mirroring the browsa repo): classic require-PR (0 approvals) + a ruleset (no deletion / no force-push / required check `Test` / PR thread resolution / extra approval for unattributed changes). Workflow: commit on `dev` → push → PR to `main` → wait for the `Test` check → squash merge.

Traps already paid for:
- **Commits MUST be authored with a GitHub-attributed email** or the ruleset's `require_extra_approval_for_unattributed_changes` blocks the merge with no useful error. Repo-local git config is set to `Billy <35189812+xiaohuzai@users.noreply.github.com>` — keep it.
- The ruleset's required check name must match the workflow job name EXACTLY (`Test`); matrix jobs (`Test (18)`…) never match.
- Repo-local `git config` also matters because a bare identity (e.g. container defaults) is unattributed.

## Conventions

- Commits: conventional-commit style, Chinese or English bodies both fine; squash-merge through PRs, never push to main.
- READMEs are bilingual (`README.md` EN + `README.zh-CN.md`), section-aligned — update both together.
- The npm package is `@xiaohuzai/agent-bridge` (bin command: `agent-bridge`); publishing is the owner's call — do not publish without an explicit instruction. Scoped publishes need `npm publish --access public`.
- The v1 wire protocol is **FROZEN** — browsa is the pinned reference client (owner decision 2026-09-08): additive-only changes (new optional config fields/endpoints are fine; renames, removals, or event-semantic changes need a v2, never a v1 edit). New protocol surfaces (the planned ACP fronts) are separate doors on separate paths with opt-in config — they must not disturb v1 routes, events, or defaults. The existing test suite is the browsa-compatibility regression net; any change that breaks it is a v1 break.
- The `4MB` request-body cap is deliberate (bounds inline base64 images); `images` arrays are capped at 8.
- Security posture: loopback bind by default; `--bind` opts into non-loopback and every config entry then REQUIRES `apiKey` (the CLI refuses to start otherwise); the `Host` header allowlist (DNS-rebinding guard) applies only to loopback binds — remote binds are hostname-legit and gated by the token; CORS reflects loopback origins only (`corsOrigin: "*"` per entry is the explicit opt-in, to be paired with api keys). The bridge speaks plain HTTP — TLS belongs in a reverse proxy (server.mjs sends `X-Accel-Buffering: no` so SSE streams unbuffered behind nginx/caddy).

## Roadmap (dual-door strategy — owner decision 2026-09-08)

Adoption strategy: the goal is broad third-party adoption. v1 stays the built-in minimal door for browsa-style clients (FROZEN — see Conventions); the PUBLIC door is ACP. The adapters already speak ACP toward agents; the fronts below let ACP clients speak it toward the bridge — third parties adopt the bridge without ever learning v1. Design draft: `docs/design-acp-front.zh-CN.md`.

1. Live verification of both adapters against real agents — codex: done for the wire (native adapter AND the official codex-acp shim). claude: real turns verified on the user's Mac 2026-09-08 (streaming, session continuity, usage, approvals) via the official claude-agent-acp; handshake/version-negotiation/error-path verified in the container; disconnect-interrupt and bridge-restart resume test-covered but not exercised live. gemini not planned yet.
2. ACP-over-WebSocket front: per-bridge `/acp` path on the bridge's EXISTING port, opt-in via a per-bridge config flag — additive only, browsa/v1 untouched. **SHIPPED 2026-09-08** (`wire-ws.mjs` + `acp-front-ws.mjs`; the RFD's compliance minimum is WebSocket-only servers — clients MUST support WS). The streamable-HTTP profile waits for the official reference implementation (Goose).
3. ACP stdio front (`agent-bridge acp` as a spawned agent for editors) — per-bridge granularity: each agents.json entry is one spawnable ACP agent. **SHIPPED 2026-09-08** (`acp-front.mjs` shared session + `acp-front-stdio.mjs`; entries may omit `port` when the config is only used for acp mode).
4. Submit to the ACP Registry — ONLY after 3: the registry lists agents only, and the stdio front is what makes the bridge itself one.
