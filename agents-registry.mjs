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
  // store (desktop-saved keys just work; `dsh-acp login` adds one). Route
  // selection belongs to the spawned process: default = the dsh product
  // default (deepseek-official + key); account route (desktop login balance)
  // = entry `args: ["--provider", "deepseek-account"]`; `args: []` forces the
  // official route. Verified live 2026-10-09 against dsh 0.2.0-rc.2
  // (standalone handshake, capabilities, both auth methods).
  // workspaceRegister 'dsh': sessions created here are auto-registered into
  // the matching dsh workspace (the desktop/Web session list renders workspace
  // members — without this they'd work but stay invisible there).
  dsh: { kind: 'acp', command: ['dsh-acp'], workspaceRegister: 'dsh', install: 'ships bundled with agent-bridge — run "npm i" in the agent-bridge checkout (a fresh clone installs nothing), or npm i -g @openma/deepseek-harness-acp (needs node >= 22.15; a failed optional dep is skipped silently)', summary: 'DeepSeek Harness via the openma ACP adapter (token streaming; shares sessions and credentials with the dsh desktop/Web UI)' },
  // zcode runs on its NATIVE adapter (adapters/zcode-server.mjs) against the
  // runtime the ZCode desktop app installs — no separate CLI install exists
  // (the CLI release has no public download channel). The adapter
  // auto-resolves the newest server bundle from the desktop's content-
  // addressed cache; "serverCjs"/"nodeBin" on the entry override. Model and
  // login state live in the user's ZCode app — the adapter never touches
  // credentials; the conversation sessions are the app's own (visible/resumable
  // there, named "browsa：<first line>" when browsa titles them).
  // workbuddy runs on its NATIVE adapter (adapters/workbuddy.mjs) against the
  // CodeBuddy Code worker that the WorkBuddy AI desktop app spawns and keeps
  // warm (ACP over Streamable HTTP on a loopback port, auto-discovered via the
  // /health signature; "workbuddyPort" overrides). Model/login state lives in
  // the user's WorkBuddy app — the adapter never touches credentials.
  workbuddy: { kind: 'workbuddy', install: 'WorkBuddy AI desktop app (installed, logged in, and running)', summary: 'WorkBuddy AI desktop via its local CodeBuddy worker gateway (native adapter)' },
  zcode: { kind: 'zcode', install: 'ZCode desktop app (open it once so its runtime is cached)', summary: 'ZCode via its local stdio server (native adapter; model/login from the ZCode app)' },
};

export function knownAgentNames() {
  return Object.keys(KNOWN_AGENTS);
}
