#!/usr/bin/env node
// agent-bridge/cli.mjs — run the bridge from a terminal:
//
//   agent-bridge codex [options]          drive the codex CLI (app-server)
//   agent-bridge acp -- <command…>        drive ANY Agent Client Protocol v2
//                                         agent (claude-code-acp, codex-acp,
//                                         `gemini --experimental-acp`, …)
//
// Requires a locally installed agent with working auth (codex login — a
// ChatGPT Plus/Pro subscription works — or an API key, or a custom provider).
// Then point any client of the wire protocol (see server.mjs header) at
// http://127.0.0.1:3948.

import { createBridgeServer } from './server.mjs';
import { CodexAppServerAdapter } from './adapters/codex-app-server.mjs';
import { AcpStdioAdapter } from './adapters/acp-stdio.mjs';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') args.port = Number(argv[++i]);
    else if (a === '--cwd') args.cwd = argv[++i];
    else if (a === '--sandbox') args.sandbox = argv[++i];
    else if (a === '--network') args.network = true;
    else if (a === '--approval') args.approval = argv[++i];
    else if (a === '--token') args.token = argv[++i];
    else if (a === '--cors-origin') args.corsOrigin = argv[++i];
    else if (a === '--codex-bin') args.codexBin = argv[++i];
    else if (a === '--codex-home') args.codexHome = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
    else args._.push(a);
  }
  return args;
}

// Everything after `--` belongs to the ACP agent command, never to us.
const raw = process.argv.slice(2);
const dd = raw.indexOf('--');
const head = dd === -1 ? raw : raw.slice(0, dd);
const agentCommand = dd === -1 ? [] : raw.slice(dd + 1).filter((a) => a !== '');
const args = parseArgs(head);

const mode = args._[0];
if (args.help || (mode !== 'codex' && mode !== 'acp')) {
  console.log(`usage:
  browsa-agent-bridge codex [options]        drive the codex CLI
  browsa-agent-bridge acp -- <command…> [options]
                                             drive any ACP v2 agent, e.g.
                                             acp -- claude-code-acp
                                             acp -- gemini --experimental-acp
       (repo checkout: node cli.mjs codex|acp …)

options:
  --port N              listen port (default 3948, loopback only)
  --cwd DIR             agent workspace (default: current directory)
  --token TOKEN         require this bearer token on every request
  --cors-origin MODE    loopback (default: reflect http(s)://localhost:* and
                        127.0.0.1:* origins) or * (any origin; use with --token)
codex-specific:
  --sandbox MODE        read-only | workspace-write | danger-full-access (default read-only)
  --network             allow network access inside a workspace-write sandbox
  --approval POLICY     never | on-request | untrusted (default never;
                        on-request/untrusted route approvals to the client)
  --codex-bin PATH      codex binary (default: codex on PATH)
  --codex-home DIR      CODEX_HOME override (default: ~/.codex)`);
  process.exit(args.help ? 0 : 1);
}

const SANDBOXES = ['read-only', 'workspace-write', 'danger-full-access'];
const APPROVALS = ['never', 'on-request', 'untrusted'];
if (!SANDBOXES.includes(args.sandbox)) args.sandbox = 'read-only';
if (!APPROVALS.includes(args.approval)) args.approval = 'never';

let adapter;
let agent;
if (mode === 'acp') {
  if (!agentCommand.length) {
    console.error('acp mode: an agent command is required, e.g.  agent-bridge acp -- claude-code-acp');
    process.exit(1);
  }
  adapter = new AcpStdioAdapter({
    command: agentCommand,
    cwd: args.cwd || process.cwd(),
    log: (m) => console.error(m),
  });
  agent = `acp:${agentCommand[0]}`;
} else {
  adapter = new CodexAppServerAdapter({
    codexBin: args.codexBin || 'codex',
    codexHome: args.codexHome,
    cwd: args.cwd || process.cwd(),
    sandbox: args.sandbox,
    network: !!args.network,
    approval: args.approval,
    log: (m) => console.error(m),
  });
  agent = 'codex';
}

const server = createBridgeServer({
  adapter,
  agent,
  version: '1.0.0',
  token: args.token,
  corsOrigin: args.corsOrigin === '*' ? '*' : 'loopback',
  log: (m) => console.error(m),
});

const port = Number.isFinite(args.port) && args.port > 0 ? args.port : 3948;
server.listen(port, '127.0.0.1', () => {
  console.log(`agent-bridge (${agent}) listening on http://127.0.0.1:${port}`);
  console.log(`  workspace : ${adapter.opts.cwd}`);
  if (mode === 'codex') {
    console.log(`  sandbox   : ${adapter.opts.sandbox}${adapter.opts.sandbox === 'workspace-write' && adapter.opts.network ? ' + network' : ''}`);
    console.log(`  approvals : ${adapter.opts.approval}${adapter.opts.approval === 'never' ? ' (commands needing sandbox escape are refused; use --approval on-request to approve from the client)' : ''}`);
  } else {
    console.log(`  command   : ${agentCommand.join(' ')}`);
    console.log('  approvals : whatever the ACP agent requests are routed to the client');
  }
  console.log(`  auth      : ${args.token ? 'bearer token required' : 'none (loopback only)'}`);
  console.log(`  cors      : ${args.corsOrigin === '*' ? 'any origin (use --token!)' : 'loopback origins reflected'}`);
  console.log('Point any wire-protocol client at this address. Ctrl+C to stop.');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    adapter.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  });
}
