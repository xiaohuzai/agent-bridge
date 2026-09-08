#!/usr/bin/env node
// agent-bridge/cli.mjs — run the bridge from a terminal:
//
//   agent-bridge codex [options]          drive the codex CLI (app-server)
//   agent-bridge acp -- <command…>        drive ANY Agent Client Protocol v2
//                                         agent (claude-code-acp, codex-acp,
//                                         `gemini --experimental-acp`, …)
//   agent-bridge serve --config agents.json
//                                         start MANY bridges from a config
//                                         file — one per known agent, each
//                                         on its own port with its own
//                                         api key (see agents-registry.mjs)
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
    else if (a === '--bind') args.bind = argv[++i];
    else if (a === '--cwd') args.cwd = argv[++i];
    else if (a === '--sandbox') args.sandbox = argv[++i];
    else if (a === '--network') args.network = true;
    else if (a === '--approval') args.approval = argv[++i];
    else if (a === '--config') args.config = argv[++i];
    else if (a === '--api-key' || a === '--token') args.apiKey = argv[++i];
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
if (args.help || (mode !== 'codex' && mode !== 'acp' && mode !== 'serve')) {
  console.log(`usage:
  browsa-agent-bridge codex [options]        drive the codex CLI
  browsa-agent-bridge acp -- <command…> [options]
                                             drive any ACP v2 agent, e.g.
                                             acp -- claude-agent-acp
                                             acp -- gemini --experimental-acp
  browsa-agent-bridge serve --config FILE    start many bridges from a config
                                             file — one per known agent, each
                                             on its own port + api key
       (repo checkout: node cli.mjs codex|acp|serve …)

options:
  --port N              listen port (default 3948; single-agent modes only)
  --bind ADDR           bind address (default 127.0.0.1; non-loopback binds,
                        e.g. 0.0.0.0 for LAN/VPN, REQUIRE --api-key; for the
                        public internet put a TLS reverse proxy in front)
  --cwd DIR             agent workspace (default: current directory)
  --api-key KEY         require this bearer key on every request
                        (--token accepted as an alias)
  --cors-origin MODE    loopback (default: reflect http(s)://localhost:* and
                        127.0.0.1:* origins) or * (any origin; use with --api-key)
serve-only:
  --config FILE         JSON config: {"bridges":[…]} — name must be a known
                        agent (see agents-registry.mjs); every bridge needs
                        a port; apiKey is optional on loopback and required
                        for non-loopback binds; command overrides the spawn
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

const LOOPBACK_BINDS = ['127.0.0.1', 'localhost', '::1'];
const bind = args.bind || '127.0.0.1';
if (!LOOPBACK_BINDS.includes(bind) && !args.apiKey) {
  console.error(`--bind ${bind} exposes the bridge beyond this machine — an api key is REQUIRED.
  Generate one:  --api-key $(openssl rand -hex 16)
  The bridge speaks plain HTTP; for the public internet put a TLS reverse proxy in front.`);
  process.exit(1);
}

if (mode === 'serve') {
  if (!args.config) {
    console.error('serve mode: --config FILE is required (a JSON file with a "bridges" array)');
    process.exit(1);
  }
  const { loadConfig, startServe, configPermissionsWarning } = await import('./serve.mjs');
  let running;
  try {
    running = await startServe(loadConfig(args.config), { bind, version: '1.0.0', log: (m) => console.error(m) });
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  for (const line of running.banner) console.log(line);
  const perm = configPermissionsWarning(args.config);
  if (perm) console.log(`  WARNING   : ${perm}`);
  console.log('Point any wire-protocol client at these addresses. Ctrl+C stops all bridges.');
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      running.stop();
      setTimeout(() => process.exit(0), 500).unref();
    });
  }
} else {
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
    token: args.apiKey,
    corsOrigin: args.corsOrigin === '*' ? '*' : 'loopback',
    bindAddress: bind,
    log: (m) => console.error(m),
  });

  const port = Number.isFinite(args.port) && args.port > 0 ? args.port : 3948;
  server.listen(port, bind, () => {
    console.log(`agent-bridge (${agent}) listening on http://${bind === '0.0.0.0' ? '0.0.0.0 (all interfaces)' : bind}:${port}`);
    console.log(`  workspace : ${adapter.opts.cwd}`);
    if (mode === 'codex') {
      console.log(`  sandbox   : ${adapter.opts.sandbox}${adapter.opts.sandbox === 'workspace-write' && adapter.opts.network ? ' + network' : ''}`);
      console.log(`  approvals : ${adapter.opts.approval}${adapter.opts.approval === 'never' ? ' (commands needing sandbox escape are refused; use --approval on-request to approve from the client)' : ''}`);
    } else {
      console.log(`  command   : ${agentCommand.join(' ')}`);
      console.log('  approvals : whatever the ACP agent requests are routed to the client');
    }
    console.log(`  auth      : ${args.apiKey ? 'bearer key required' : 'none (loopback only)'}`);
    console.log(`  cors      : ${args.corsOrigin === '*' ? 'any origin (use --api-key!)' : 'loopback origins reflected'}`);
    if (!LOOPBACK_BINDS.includes(bind)) {
      console.log('  WARNING   : non-loopback bind — every request must carry the api key, and traffic is plain HTTP until you put a TLS reverse proxy in front.');
    }
    console.log('Point any wire-protocol client at this address. Ctrl+C to stop.');
  });

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      adapter.stop();
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 500).unref();
    });
  }
}
