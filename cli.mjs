#!/usr/bin/env node
// agent-bridge/cli.mjs — run the bridge from a terminal:
//
//   node agent-bridge/cli.mjs codex [--port 3948] [--cwd DIR]
//        [--sandbox read-only|workspace-write|danger-full-access] [--network]
//        [--approval never|on-request|untrusted] [--token TOKEN]
//        [--codex-bin PATH] [--codex-home DIR]
//
// Requires a locally installed codex CLI with working auth (`codex login` —
// a ChatGPT Plus/Pro subscription works — or an API key, or a custom
// provider). Then point any client of the wire protocol (see server.mjs
// header) at http://127.0.0.1:3948.

import { createBridgeServer } from './server.mjs';
import { CodexAppServerAdapter } from './adapters/codex-app-server.mjs';

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

const args = parseArgs(process.argv.slice(2));
if (args.help || args._[0] !== 'codex') {
  console.log(`usage: browsa-agent-bridge codex [options]
       (repo checkout: node agent-bridge/cli.mjs codex [options])

options:
  --port N              listen port (default 3948, loopback only)
  --cwd DIR             agent workspace (default: current directory)
  --sandbox MODE        read-only | workspace-write | danger-full-access (default read-only)
  --network             allow network access inside a workspace-write sandbox
  --approval POLICY     never | on-request | untrusted (default never;
                        on-request/untrusted route approvals to the client)
  --token TOKEN         require this bearer token on every request
  --cors-origin MODE    loopback (default: reflect http(s)://localhost:* and
                        127.0.0.1:* origins) or * (any origin; use with --token)
  --codex-bin PATH      codex binary (default: codex on PATH)
  --codex-home DIR      CODEX_HOME override (default: ~/.codex)`);
  process.exit(args.help ? 0 : 1);
}

const SANDBOXES = ['read-only', 'workspace-write', 'danger-full-access'];
const APPROVALS = ['never', 'on-request', 'untrusted'];
if (!SANDBOXES.includes(args.sandbox)) args.sandbox = 'read-only';
if (!APPROVALS.includes(args.approval)) args.approval = 'never';

const adapter = new CodexAppServerAdapter({
  codexBin: args.codexBin || 'codex',
  codexHome: args.codexHome,
  cwd: args.cwd || process.cwd(),
  sandbox: args.sandbox,
  network: !!args.network,
  approval: args.approval,
  log: (m) => console.error(m),
});

const server = createBridgeServer({
  adapter,
  agent: 'codex',
  version: '1.0.0',
  token: args.token,
  corsOrigin: args.corsOrigin === '*' ? '*' : 'loopback',
  log: (m) => console.error(m),
});

const port = Number.isFinite(args.port) && args.port > 0 ? args.port : 3948;
server.listen(port, '127.0.0.1', () => {
  console.log(`agent-bridge (codex) listening on http://127.0.0.1:${port}`);
  console.log(`  workspace : ${adapter.opts.cwd}`);
  console.log(`  sandbox   : ${adapter.opts.sandbox}${adapter.opts.sandbox === 'workspace-write' && adapter.opts.network ? ' + network' : ''}`);
  console.log(`  approvals : ${adapter.opts.approval}${adapter.opts.approval === 'never' ? ' (commands needing sandbox escape are refused; use --approval on-request to approve from the client)' : ''}`);
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
