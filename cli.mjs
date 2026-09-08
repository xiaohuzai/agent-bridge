#!/usr/bin/env node
// agent-bridge/cli.mjs — run the bridge from a terminal:
//
//   agent-bridge serve [--config FILE] [--bind ADDR]
//
// ONE way to start: a JSON config file describes every bridge — one per
// known agent (see agents-registry.mjs), each on its own port. --config
// defaults to ./agents.json; the repo ships agents.example.json as a
// working starter (codex + claude on loopback). Point any client of the
// wire protocol (see server.mjs header) at the printed addresses.

import { loadConfig, startServe, configPermissionsWarning } from './serve.mjs';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === 'serve') continue; // the (only) mode word — optional
    else if (a === '--config') args.config = argv[++i];
    else if (a === '--bind') args.bind = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
    else {
      console.error(`unknown argument: ${a}
usage: agent-bridge [serve] [--config FILE] [--bind ADDR] — see --help`);
      process.exit(1);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(`usage:
  agent-bridge serve [--config FILE] [--bind ADDR]

  Starts every bridge described in the config file — one per known agent,
  each on its own port. --config defaults to ./agents.json;
  agents.example.json in this repo is a working starter.

options:
  --config FILE   JSON config: {"bridges":[…]} — name must be a known agent
                  (agents-registry.mjs); every bridge needs a port; apiKey is
                  optional on loopback and required for non-loopback binds;
                  "acp": true on an entry also serves ACP clients at ws://…/acp
  --bind ADDR     bind address (default 127.0.0.1; e.g. 0.0.0.0 for LAN/VPN)`);
  process.exit(0);
}

const bind = args.bind || '127.0.0.1';
const configPath = args.config || 'agents.json';

let running;
try {
  running = await startServe(loadConfig(configPath), { bind, version: '1.0.0', log: (m) => console.error(m) });
} catch (e) {
  const hint = /cannot read config/.test(e.message) && configPath === 'agents.json'
    ? `\n  No agents.json here — copy the shipped starter first:  cp agents.example.json agents.json`
    : '';
  console.error(e.message + hint);
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
