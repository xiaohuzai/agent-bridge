# CONTEXT.md — agent-bridge at a glance

Orientation for coding agents and context tooling. Humans start at
[README.md](./README.md) / [README.zh-CN.md](./README.zh-CN.md); the full
agent-facing manual is [AGENTS.md](./AGENTS.md). This file only says WHICH
document answers which question and lists the invariants that are expensive
to get wrong — it deliberately restates nothing at length. When this file and
another doc disagree, the other doc wins.

## What this is

**agent-bridge** is a UI-agnostic, zero-dependency Node daemon that adapts
local CLI coding agents (codex, claude code, pi, … any ACP agent) to a small
HTTP+SSE wire protocol (v1) — plus opt-in ACP doors (WebSocket `/acp`,
spawnable stdio) so ACP clients and editors attach without learning v1. One
process can serve several agents: one bridge per config entry, each on its
own port. It is deliberately not tied to any product, UI, or vendor.

## Where truth lives

| Question | Read |
|---|---|
| Install, configure, use | [README.md](./README.md) (EN) · [README.zh-CN.md](./README.zh-CN.md) (中文) |
| The v1 wire protocol (events, edge rules) | header comment of [server.mjs](./server.mjs) — **authoritative, frozen** |
| Per-agent setup (codex / claude / pi, credentials) | [docs/agents.md](./docs/agents.md) · [docs/agents.zh-CN.md](./docs/agents.zh-CN.md) |
| ACP front design & compliance | [docs/design-acp-front.zh-CN.md](./docs/design-acp-front.zh-CN.md) |
| ACP Registry submission | [docs/acp-registry.zh-CN.md](./docs/acp-registry.zh-CN.md) |
| Architecture, traps, testing, git workflow, roadmap | [AGENTS.md](./AGENTS.md) |
| What each adapter learned from live agents | header comment of the adapter in [adapters/](./adapters/) |

## Invariants that are expensive to get wrong

- **v1 is FROZEN** (owner decision 2026-09-08): additive-only changes;
  renames, removals, or event-semantic changes need a v2 door. The test suite
  is the browsa-compatibility regression net.
- **Zero npm dependencies**, no build step, no network in tests — keep it
  that way.
- **Disconnect = abort**; turns are live-only (no replay); session ids are
  adapter-assigned and must survive bridge restarts (resume from the agent's
  own persistence).
- Protocol facts are **live-verified**, never read from docs, and recorded in
  the adapter header comments (AGENTS.md "Verification discipline").
- **Approvals are first-class**: the client decides once / always / deny —
  never answer on its behalf.
- Decided non-goals, do not re-propose: a chat UI; agents controlling the
  browser; renaming the repo with an `-acp` suffix. See AGENTS.md.
- `main` only moves through PRs (never direct pushes) authored with a
  GitHub-attributed identity; npm releases are the owner's call.

## Status

Development state and roadmap live in [AGENTS.md](./AGENTS.md) ("Roadmap") —
they are not restated here, so this file cannot go stale on them. npm package:
`@xiaohuzai/agent-bridge` (bin: `agent-bridge`).
