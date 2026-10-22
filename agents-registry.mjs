// agent-bridge/agents-registry.mjs — the one list of agents agent-bridge
// knows by name. The `serve` config file accepts ONLY these names (long-tail
// agents join by adding a line here, not by loosening the config); a browser
// client like browsa mirrors this table for its agent picker. Each entry says
// how the agent is driven: kind 'codex' = the native app-server adapter,
// kind 'acp' = the generic ACP-stdio adapter with a default spawn command.
// `command` in a serve entry overrides the default spawn (the agent stays
// whatever its name says; e.g. claude via npx instead of a global install).
//
// The ACP SHIMS (claude-agent-acp, pi-acp) ship as bundled optionalDependencies
// (package.json) — stateless glue users rarely install standalone, so the
// claude/pi entries work after one agent-bridge install; adapters APPEND the
// bundled bin dir to the child PATH (adapters/agent-env.mjs) — a
// user-installed shim wins. The agent CLIs proper are deliberately NOT
// bundled: users run their own versions, and a
// pinned copy would fork the CLI state their terminal writes.


export const KNOWN_AGENTS = {
  // install: surfaced verbatim in the ENOENT error when the agent's command
  // is missing (the moment of need) — keep it one copy-pasteable line.
  codex: { kind: 'codex', install: 'npm i -g @openai/codex', summary: 'codex CLI via its app-server (native adapter)' },
  // transcriptFix: claude CLI 2.x self-stamps SDK-driven transcripts
  // entrypoint:"sdk-cli" and its /resume picker hides sdk-* — after each turn
  // the adapter rewrites the stamp so sessions stay browsable there
  // (adapters/claude-transcript-fix.mjs; env alone can't do it, the CLI
  // ignores CLAUDE_CODE_ENTRYPOINT).
  claude: { kind: 'acp', command: ['claude-agent-acp'], install: 'npm i -g @anthropic-ai/claude-code (the claude-agent-acp shim ships bundled with agent-bridge)', transcriptFix: 'claude', summary: 'claude code via the official claude-agent-acp shim' },
  // pi's install hint is shim-only on purpose: users with pi's official
  // self-installer hit EEXIST if the npm pi package is added on top (the npm
  // package's `pi` bin collides with the installer's symlink — seen live
  // 2026-10-01). The pi-acp SHIM ships bundled and is what this hint fixes
  // when missing; pi itself cannot come from npm at all — if pi is missing
  // too, pi-acp's own error names it.
  pi: { kind: 'acp', command: ['pi-acp'], install: 'npm i -g pi-acp', summary: 'pi via the pi-acp shim (needs pi >= 0.80.4 on PATH)' },
  gemini: { kind: 'acp', command: ['gemini', '--acp'], install: 'npm i -g @google/gemini-cli', summary: 'gemini CLI native ACP mode (needs gemini >= 0.62 on PATH, signed in or env-auth)' },
  // qoder (Qoder CLI) native ACP mode: `qoder --acp` (docs.qoder.com/cli/acp).
  // Live-verified 2026-10-15 in a container, qoder-cli 1.1.71, UNAUTHENTICATED
  // (handshake/capabilities only — a real model turn still needs a credentialed
  // machine): protocolVersion 1 (the session/prompt response is the turn
  // terminator — the v1 path). ACP shares the CLI's login state: `qoder login`
  // once, or QODER_PERSONAL_ACCESS_TOKEN via the entry's env config; without
  // either, session/new fails -32000 "Authentication required" (the bridge
  // relays it as the turn's error — the message names the fix). Advertised:
  // loadSession, promptCapabilities {image, embeddedContext}, session
  // resume/fork/list/close/delete, mcp http/sse. No authenticate call needed —
  // auth is ambient like gemini's.
  qoder: { kind: 'acp', command: ['qoder', '--acp'], install: 'curl -fsSL https://qoder.com/install | bash (or: npm i -g @qoder-ai/qodercli)', summary: 'qoder CLI native ACP mode (images; shares login state with the qoder CLI)' },
  // dsh (DeepSeek Harness) via the openma ACP adapter (@openma/
  // deepseek-harness-acp — a third-party, actively-maintained ACP v1 stdio
  // agent that composes the dsh harness in-process). Why THIS over dsh's own
  // `--profile acp` (the official @deepseek-ai/dsh-acp-app): the official
  // surface is "automation-only" and delivers updates at committed-message
  // granularity, while dsh 0.2 publishes token deltas on a process-local
  // `agent/assistant-stream` event that only the openma adapter subscribes to
  // — so THIS entry streams token-level text and reasoning where the official
  // profile ships whole messages. Full ACP vocabulary on top: session
  // load/resume/fork, images, embedded context, model catalog. It shares
  // ~/.dsh with the dsh desktop/Web UI — sessions and credentials are the same
  // store. Standalone credentials are API KEYS through every path the adapter
  // exposes (`dsh-acp login`, the Web UI Settings → Models, the local browser
  // sign-in page — all land in ~/.dsh/.credentials.yaml, mode 600); the
  // desktop login's grants are in the store too but no adapter path consumes
  // them — the `deepseek-account` route has only ever failed with the
  // credential error, so the key route (product default `deepseek-official`
  // reading refs.DEEPSEEK_API_KEY) is the supported path. Real end-to-end
  // turn through browsa verified 2026-10-10 (dsh 0.2.0-rc.2, default route +
  // saved key; handshake/capabilities/streaming verified 2026-10-09).
  // workspaceRegister 'dsh': sessions created here are auto-registered into
  // the matching dsh workspace — and the workspace record itself is created
  // when none owns the entry cwd (workspace domain v2 shape, realpath-
  // canonical paths, version-gated) — so the desktop/Web session list renders
  // them (without this they'd work but stay invisible there).
  dsh: { kind: 'acp', command: ['dsh-acp'], workspaceRegister: 'dsh', install: 'ships bundled with agent-bridge — run "npm i" in the agent-bridge checkout (a fresh clone installs nothing), or npm i -g @openma/deepseek-harness-acp (needs node >= 22.15; a failed optional dep is skipped silently)', summary: 'DeepSeek Harness via the openma ACP adapter (token streaming; shares sessions and credentials with the dsh desktop/Web UI)' },
  // zcode runs on the HEADLESS-CLI adapter (adapters/headless-cli.mjs)
  // against the official `zcode` CLI's headless mode. The older native
  // adapter (adapters/zcode-server.mjs) rode the desktop's stdio server;
  // re-tested live 2026-10-21, a bridge-spawned server registers a provider
  // and then drops the client at turn start ("ZCode Protocol client is
  // disposed") — the pause recorded in AGENTS.md is still real, so the
  // registry no longer routes there. The headless surface was captured live
  // the same day (CLI 0.17.0 / server 3.16.2): `zcode -p … --output-format
  // stream-json` emits JSONL — model.streaming text deltas, tool.updated
  // scheduled/started/result, turn.completed with usage — and `--resume
  // sess_…` continues the same persisted session (cacheReadTokens 22528 on a
  // 28.5K-input follow-up). One process per turn (~2–4s boot; PONG 12.7s,
  // tool turn 18.5s) and a fresh prompt carries the CLI's own ~28K-token
  // system prompt.
  //
  // `mode` is the permission decision: a headless turn has no approval card,
  // and the CLI's own -p default is yolo. This registry defaults to PLAN
  // (read-only); set "mode": "build"|"edit"|"guarded"|"yolo" per entry to
  // widen it deliberately. Images degrade to a note: the CLI only attaches
  // local files (--attach), and the bridge never writes user images to disk.
  // The CLI is not bundled — desktop installs carry it at
  // ~/.zcode/server/bin/zcode, which the adapter falls back to when `zcode`
  // is not on PATH.
  zcode: {
    kind: 'headless',
    profile: 'zcode',
    command: ['zcode'],
    mode: 'edit',
    install: 'the ZCode desktop app (the bridge auto-finds its bundled CLI — Linux ~/.zcode/server/bin/zcode, Windows/macOS resources/glm/zcode.cjs run on the app runtime) or the zcode CLI on PATH — or point the entry\'s "command"/ZCODE_CLI at it',
    summary: 'ZCode via its official headless CLI (streamed JSONL; --resume sessions; no interactive approvals)',
  },
};

export function knownAgentNames() {
  return Object.keys(KNOWN_AGENTS);
}
