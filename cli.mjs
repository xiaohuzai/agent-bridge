#!/usr/bin/env node
// agent-bridge/cli.mjs — run the bridge from a terminal:
//
//   agent-bridge serve [--config FILE] [--bind ADDR]     HTTP+SSE bridges (v1)
//   agent-bridge acp <name> [--config FILE]              one entry as an ACP agent
//
// serve (the default mode) reads a JSON config describing every bridge —
// one per known agent (see agents-registry.mjs), each on its own port.
// --config defaults to ./agents.json; the repo ships agents.example.json as
// a working starter (codex + claude on loopback). Point any client of the
// wire protocol (see server.mjs header) at the printed addresses.
//
// acp spawns ONE config entry as an ACP v1 agent on stdio — for clients
// that launch agents as local commands (Zed, vscode-acp, …). stdout is the
// protocol channel; all logs go to stderr. No port is opened in this mode.

import { loadConfig, startServe, configPermissionsWarning, adapterFor } from './serve.mjs';
import { runAcpStdio } from './acp-front-stdio.mjs';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The shipped starter lives next to this file — both in a repo checkout and
// inside a globally installed npm package. The missing-config hint must point
// THERE: a global install's cwd does not contain agents.example.json.
const SHIPPED_STARTER = fileURLToPath(new URL('./agents.example.json', import.meta.url));

function missingConfigHint(configPath, message) {
  if (!/cannot read config/.test(message) || configPath !== 'agents.json') return '';
  if (existsSync(SHIPPED_STARTER)) {
    return `\n  No agents.json here — copy the shipped starter first:\n  cp ${SHIPPED_STARTER} agents.json`;
  }
  return `\n  No agents.json here — the config format is documented at https://github.com/xiaohuzai/agent-bridge#configure`;
}

function parseArgs(argv) {
  const args = {};
  let i = 0;
  if (argv[0] === 'serve') { args.mode = 'serve'; i = 1; }
  else if (argv[0] === 'acp') { args.mode = 'acp'; i = 1; }
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config') args.config = argv[++i];
    else if (a === '--bind') args.bind = argv[++i];
    else if (a === '--name') args.name = argv[++i];
    else if (args.mode === 'acp' && args.name === undefined && !a.startsWith('-')) args.name = a; // positional name
    else if (a === '--help' || a === '-h') args.help = true;
    else {
      console.error(`unknown argument: ${a}
usage: agent-bridge [serve] [--config FILE] [--bind ADDR] | agent-bridge acp <name> [--config FILE] — see --help`);
      process.exit(1);
    }
  }
  if (!args.mode) args.mode = 'serve'; // the default mode word
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(`usage:
  agent-bridge serve [--config FILE] [--bind ADDR]
  agent-bridge acp <name> [--config FILE]

  serve  Starts every bridge described in the config file — one per known
         agent, each on its own port. --config defaults to ./agents.json;
         agents.example.json in this repo is a working starter.
  acp    Spawns ONE config entry as an ACP v1 agent on stdio — for clients
         that launch agents as local commands (Zed, vscode-acp, …). Point
         them at:  agent-bridge acp <name> --config /abs/path/agents.json

options:
  --config FILE   JSON config: {"bridges":[…]} — name must be a known agent
                  (agents-registry.mjs); every serve entry needs a port;
                  apiKey is optional on loopback and required for non-loopback
                  binds; "acp": true on a serve entry also serves ACP clients
                  at ws://…/acp
  --bind ADDR     serve only: bind address (default 127.0.0.1; 0.0.0.0 for
                  LAN/VPN)`);
  process.exit(0);
}

const bind = args.bind || '127.0.0.1';
const configPath = args.config || 'agents.json';

if (args.mode === 'acp') {
  if (args.bind) {
    console.error('acp mode opens no port — --bind is a serve flag');
    process.exit(1);
  }
  if (!args.name) {
    console.error('acp mode needs an entry name: agent-bridge acp <name> [--config FILE]');
    process.exit(1);
  }
  let entry;
  try {
    const cfg = loadConfig(configPath, { requirePort: false });
    entry = cfg.bridges.find((b) => b.name === args.name);
    if (!entry) {
      console.error(`no bridge "${args.name}" in ${configPath} — entries: ${cfg.bridges.map((b) => b.name).join(', ')}`);
      process.exit(1);
    }
  } catch (e) {
    console.error(e.message + missingConfigHint(configPath, e.message));
    process.exit(1);
  }
  const { adapter, agent } = adapterFor(entry, { log: (m) => console.error(m) });
  runAcpStdio({ adapter, agent, version: '1.0.0', log: (m) => console.error(m) });
} else {
  let running;
  try {
    running = await startServe(loadConfig(configPath), { bind, version: '1.0.0', log: (m) => console.error(m) });
  } catch (e) {
    console.error(e.message + missingConfigHint(configPath, e.message));
    process.exit(1);
  }
  for (const line of running.banner) console.log(line);
  const perm = configPermissionsWarning(configPath);
  if (perm) console.log(`  WARNING   : ${perm}`);
  console.log('Point any wire-protocol client at these addresses. Ctrl+C stops all bridges.');
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      running.stop();
      setTimeout(() => process.exit(0), 500).unref();
    });
  }
}
