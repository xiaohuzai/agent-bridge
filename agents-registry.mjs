// agent-bridge/agents-registry.mjs — the one list of agents agent-bridge
// knows by name. The `serve` config file accepts ONLY these names (long-tail
// agents join by adding a line here, not by loosening the config); a browser
// client like browsa mirrors this table for its agent picker. Each entry says
// how the agent is driven: kind 'codex' = the native app-server adapter,
// kind 'acp' = the generic ACP-stdio adapter with a default spawn command.
// `command` in a serve entry overrides the default spawn (the agent stays
// whatever its name says; e.g. claude via npx instead of a global install).

export const KNOWN_AGENTS = {
  codex: { kind: 'codex', summary: 'codex CLI via its app-server (native adapter)' },
  claude: { kind: 'acp', command: ['claude-agent-acp'], summary: 'claude code via the official claude-agent-acp shim' },
  gemini: { kind: 'acp', command: ['gemini', '--experimental-acp'], summary: 'gemini CLI native ACP mode' },
};

export function knownAgentNames() {
  return Object.keys(KNOWN_AGENTS);
}
