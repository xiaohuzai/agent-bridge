// agent-bridge/agents-registry.mjs — the one list of agents agent-bridge
// knows by name. The `serve` config file accepts ONLY these names (long-tail
// agents join by adding a line here, not by loosening the config); a browser
// client like browsa mirrors this table for its agent picker. Each entry says
// how the agent is driven: kind 'codex' = the native app-server adapter,
// kind 'acp' = the generic ACP-stdio adapter with a default spawn command.
// `command` in a serve entry overrides the default spawn (the agent stays
// whatever its name says; e.g. claude via npx instead of a global install).
//
// Every agent below ships as a bundled optionalDependency (package.json) — a
// plain `npm i -g @xiaohuzai/agent-bridge` installs them all, and the
// adapters prepend the bundled bin dir to the child PATH
// (adapters/agent-env.mjs). The `install` hints remain for users who skipped
// the optional deps (`--omit=optional`) or prefer a system install.

export const KNOWN_AGENTS = {
  // install: surfaced verbatim in the ENOENT error when the agent's command
  // is missing (the moment of need) — keep it one copy-pasteable line.
  // codex is EXACT-pinned on purpose: the native adapter's protocol facts are
  // verified against this version (see the adapter header); bump it only with
  // a fresh verification pass, never with a caret.
  codex: { kind: 'codex', install: 'npm i -g @openai/codex (bundled with agent-bridge; this means the optional dep was skipped)', summary: 'codex CLI via its app-server (native adapter)' },
  // transcriptFix: claude CLI 2.x self-stamps SDK-driven transcripts
  // entrypoint:"sdk-cli" and its /resume picker hides sdk-* — after each turn
  // the adapter rewrites the stamp so sessions stay browsable there
  // (adapters/claude-transcript-fix.mjs; env alone can't do it, the CLI
  // ignores CLAUDE_CODE_ENTRYPOINT).
  claude: { kind: 'acp', command: ['claude-agent-acp'], install: 'npm i -g @anthropic-ai/claude-code @agentclientprotocol/claude-agent-acp (both bundled with agent-bridge)', transcriptFix: 'claude', summary: 'claude code via the official claude-agent-acp shim' },
  // pi's install hint is shim-only on purpose: users with pi's official
  // self-installer hit EEXIST if the npm pi package is added on top (the npm
  // package's `pi` bin collides with the installer's symlink — seen live
  // 2026-10-01). The pi-acp SHIM ships bundled, but pi itself cannot — if pi
  // is missing too, pi-acp's own error names it.
  pi: { kind: 'acp', command: ['pi-acp'], install: 'npm i -g pi-acp (shim bundled with agent-bridge; pi itself must come from its own installer)', summary: 'pi via the pi-acp shim (needs pi >= 0.80.4 on PATH)' },
  gemini: { kind: 'acp', command: ['gemini', '--acp'], install: 'npm i -g @google/gemini-cli (bundled with agent-bridge)', summary: 'gemini CLI native ACP mode (needs gemini >= 0.62 on PATH, signed in or env-auth)' },
};

export function knownAgentNames() {
  return Object.keys(KNOWN_AGENTS);
}
