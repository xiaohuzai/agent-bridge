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
  // dsh (DeepSeek Harness) speaks ACP natively — `dsh --profile acp` IS the
  // stdio agent (@deepseek-ai/dsh-acp, automation-only). No shim, and the
  // desktop app's "Manage dsh Command…" installs a `dsh` whose version always
  // matches the desktop release (a shared ~/.dsh means turns started here show
  // up in the desktop UI). Updates arrive at committed-message granularity (no
  // token streaming — tool calls ARE live) and thoughts ride
  // agent_thought_chunk; approvals are one-shot allow/reject via
  // session/request_permission. Verified live 2026-10-09 against dsh
  // 0.2.0-rc.2 (handshake protocolVersion 1, session/resume first branch).
  dsh: { kind: 'acp', command: ['dsh', '--profile', 'acp'], install: 'desktop app menu: Manage dsh Command… → Install (or: npm i -g @deepseek-ai/dsh)', summary: 'DeepSeek Harness via its official ACP automation profile (shares sessions with the dsh desktop app)' },
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
