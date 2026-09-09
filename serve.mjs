// agent-bridge/serve.mjs — `agent-bridge serve --config agents.json`: start
// MANY bridges (one per agent, each on its own port) in one process. Each
// entry is a full, isolated bridge: its own adapter, its own agent
// subprocess, its own sessions. Process-level supervision (boot persistence,
// crash restart) belongs to systemd/launchd, not here.
//
// Config shape (JSON; `name` must be a KNOWN_AGENTS name). `cwd` is optional
// on every entry: omit it and the agent runs in the directory serve was
// started from (`"."` is the same thing); `~` and relative paths resolve.
//
//   {
//     "bridges": [
//       { "name": "codex",  "port": 3948, "apiKey": "…",
//         "sandbox": "workspace-write", "approval": "on-request" },
//       { "name": "claude", "port": 3949, "apiKey": "" },
//       { "name": "claude2","port": 3950, "apiKey": "…", "cwd": "/abs/path/to/project",
//         "command": ["npx", "-y", "@agentclientprotocol/claude-agent-acp"] }
//     ]
//   }
//
// `acp: true` on an entry opts it into the ACP-over-WebSocket FRONT: the
// bridge additionally speaks ACP v1 at `ws://<host>:<port>/acp` so ACP
// clients (editors, acpx, acp-ui, …) can attach without learning the v1
// wire — see acp-front-ws.mjs and docs/design-acp-front.zh-CN.md. Default
// off; the v1 HTTP+SSE surface (server.mjs) is untouched either way.
//
// apiKey: empty or omitted = keyless (fine on loopback binds; non-loopback
// binds refuse keyless entries, same posture as single-agent mode).
//
// Resolution order for the spawn command: explicit `command` > registry
// default > error. Everything else is per-entry validation with all errors
// reported at once; a port that cannot bind fails the whole serve (fail
// fast, naming the bridge) after shutting down the bridges that did start.

import { homedir } from 'node:os';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { createBridgeServer } from './server.mjs';
import { attachAcpFront } from './acp-front-ws.mjs';
import { CodexAppServerAdapter } from './adapters/codex-app-server.mjs';
import { AcpStdioAdapter } from './adapters/acp-stdio.mjs';
import { KNOWN_AGENTS, knownAgentNames } from './agents-registry.mjs';

const SANDBOXES = ['read-only', 'workspace-write', 'danger-full-access'];
const APPROVALS = ['never', 'on-request', 'untrusted'];
const LOOPBACKS = ['127.0.0.1', 'localhost', '::1'];

/** Expand a leading ~/ to the user's home directory (JSON can't do it). */
function expandHome(p) {
  if (typeof p !== 'string') return p;
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return homedir() + p.slice(1);
  return p;
}

/** Parse + validate the config file. Throws ONE error listing ALL problems.
 * `requirePort: false` serves the `acp` stdio front, where entries don't
 * listen on any port. */
export function loadConfig(path, { requirePort = true } = {}) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    throw new Error(`cannot read config ${path}: ${e.message}`);
  }
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (e) {
    throw new Error(`config ${path} is not valid JSON: ${e.message}`);
  }
  return validateConfig(cfg, { requirePort });
}

export function validateConfig(cfg, { requirePort = true } = {}) {
  const errors = [];
  if (!cfg || typeof cfg !== 'object' || !Array.isArray(cfg.bridges) || cfg.bridges.length === 0) {
    throw new Error('config must be a JSON object like {"bridges":[ … ]} with at least one entry');
  }
  const seenNames = new Set();
  const seenPorts = new Set();
  const out = [];
  cfg.bridges.forEach((b, i) => {
    const at = `bridges[${i}]`;
    if (!b || typeof b !== 'object' || Array.isArray(b)) {
      errors.push(`${at}: must be an object`);
      return;
    }
    const name = b.name;
    const spec = KNOWN_AGENTS[name];
    if (typeof name !== 'string' || !name) errors.push(`${at}: "name" is required`);
    else if (!spec) errors.push(`${at}: unknown agent "${name}" — known agents: ${knownAgentNames().join(', ')} (long-tail agents: add a line to agents-registry.mjs)`);
    else if (seenNames.has(name)) errors.push(`${at}: duplicate name "${name}"`);

    // `port` is a serve-mode concern (each bridge listens on its own port).
    // The `acp` stdio front spawns one entry as an agent — no port involved —
    // so entries may omit it when the config is only used that way.
    const port = b.port;
    if (requirePort) {
      if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push(`${at}: "port" must be an integer 1–65535`);
      else if (seenPorts.has(port)) errors.push(`${at}: duplicate port ${port}`);
    }

    if (b.apiKey !== undefined && typeof b.apiKey !== 'string') errors.push(`${at}: "apiKey" must be a string (empty or omitted = keyless, loopback only)`);

    if (b.command !== undefined) {
      if (!Array.isArray(b.command) || !b.command.length || b.command.some((c) => typeof c !== 'string' || !c.trim())) {
        errors.push(`${at}: "command" must be a non-empty array of strings`);
      } else if (spec?.kind === 'codex') {
        errors.push(`${at}: "${name}" runs on the native adapter — use "codexBin" to point at the binary, not "command"`);
      }
    }
    if (b.cwd !== undefined && (typeof b.cwd !== 'string' || !b.cwd.trim())) errors.push(`${at}: "cwd" must be a non-empty string`);
    if (b.sandbox !== undefined && !SANDBOXES.includes(b.sandbox)) errors.push(`${at}: "sandbox" must be one of ${SANDBOXES.join(' | ')}`);
    if (b.approval !== undefined && !APPROVALS.includes(b.approval)) errors.push(`${at}: "approval" must be one of ${APPROVALS.join(' | ')}`);
    if (b.corsOrigin !== undefined && b.corsOrigin !== '*') errors.push(`${at}: "corsOrigin" must be "*" or omitted (loopback only)`);
    if (b.acp !== undefined && typeof b.acp !== 'boolean') errors.push(`${at}: "acp" must be a boolean (opts the bridge into the ACP-over-WebSocket front at /acp)`);

    seenNames.add(name);
    seenPorts.add(port);
    out.push({
      ...b,
      // ACP shims validate cwd as "must be absolute" — resolve every entry
      // (default: the directory serve was started from) so configs can write
      // "~/x" or even "x/sub" safely.
      cwd: resolve(expandHome(b.cwd || process.cwd())),
      apiKey: typeof b.apiKey === 'string' && b.apiKey.trim() ? b.apiKey.trim() : undefined,
    });
  });
  if (errors.length) throw new Error(`invalid config:\n  - ${errors.join('\n  - ')}`);
  return { bridges: out };
}

/** Construct the adapter for one validated config entry — shared by serve
 * (one HTTP bridge per entry) and the `acp` stdio front (the entry spawned
 * as an ACP agent by an editor). */
export function adapterFor(b, { log = () => {} } = {}) {
  const spec = KNOWN_AGENTS[b.name];
  const wrappedLog = (m) => log(`[${b.name}] ${m}`);
  if (spec.kind === 'codex') {
    return {
      agent: b.name,
      adapter: new CodexAppServerAdapter({
        codexBin: b.codexBin || 'codex',
        codexHome: b.codexHome,
        cwd: b.cwd || process.cwd(),
        sandbox: b.sandbox || 'read-only',
        network: !!b.network,
        approval: b.approval || 'never',
        log: wrappedLog,
      }),
    };
  }
  return {
    agent: b.name,
    adapter: new AcpStdioAdapter({
      command: b.command || spec.command,
      cwd: b.cwd || process.cwd(),
      log: wrappedLog,
    }),
  };
}

/** Start every bridge in the config. Throws (after stopping whatever did
 * start) if any port fails to bind. Returns a handle with a stop(). */
export async function startServe(cfg, { bind = '127.0.0.1', version = '1.0.0', log = () => {} } = {}) {
  // Keyless entries are fine on loopback, refused the moment the serve goes
  // beyond the machine — same posture as single-agent mode.
  const keyless = cfg.bridges.filter((b) => !b.apiKey).map((b) => b.name);
  if (!LOOPBACKS.includes(bind) && keyless.length) {
    throw new Error(`bridge(s) without apiKey: ${keyless.join(', ')} — a key is required when binding non-loopback (omit --bind to stay loopback)`);
  }
  const running = [];
  const stop = () => {
    for (const r of running) {
      try { r.front?.dispose(); } catch (_) {} // WS sockets first: Node's connection accounting does not cover upgraded sockets
      try { r.adapter.stop(); } catch (_) {}
      try { r.server.closeAllConnections?.(); } catch (_) {}
      try { r.server.close(); } catch (_) {}
    }
    running.length = 0;
  };
  try {
    for (const b of cfg.bridges) {
      const { adapter, agent } = adapterFor(b, { log });
      const server = createBridgeServer({
        adapter,
        agent,
        version,
        token: b.apiKey,
        corsOrigin: b.corsOrigin === '*' ? '*' : 'loopback',
        bindAddress: bind,
        log: (m) => log(`[${b.name}] ${m}`),
      });
      // Opt-in ACP front: an `upgrade` listener on the SAME server, filtered
      // to path /acp. Purely additive — v1 requests never see it.
      let front = null;
      if (b.acp) {
        front = attachAcpFront(server, {
          adapter,
          agent,
          version,
          token: b.apiKey,
          bindAddress: bind,
          log: (m) => log(`[${b.name}] ${m}`),
        });
      }
      await new Promise((resolve, reject) => {
        const fail = (err) => {
          server.removeListener('error', onError);
          reject(err);
        };
        const onError = (err) => fail(err);
        server.on('error', onError);
        server.listen(b.port, bind, () => {
          server.removeListener('error', onError);
          resolve();
        });
      }).catch((err) => {
        const why = err.code === 'EADDRINUSE' ? `port ${b.port} is already in use` : err.message;
        throw new Error(`bridge "${b.name}" failed to start: ${why}`);
      });
      running.push({ name: b.name, adapter, server, port: b.port, hasKey: !!b.apiKey, acp: !!b.acp, front });
    }
  } catch (e) {
    stop();
    throw e;
  }
  return {
    banner: [
      `agent-bridge serve: ${running.length} bridge${running.length === 1 ? '' : 's'} on http://${bind === '0.0.0.0' ? '0.0.0.0 (all interfaces)' : bind}`,
      ...running.map((r) => `  ${r.name.padEnd(10)} :${r.port}  (${r.hasKey ? 'apiKey required' : 'no api key — loopback only'})${r.acp ? `  ·  acp: ws://${bind === '0.0.0.0' ? '127.0.0.1' : bind}:${r.port}/acp` : ''}`),
      ...(LOOPBACKS.includes(bind) ? [] : ['  WARNING   : non-loopback bind — every request must carry the apiKey, and traffic is plain HTTP until you put a TLS reverse proxy in front.']),
    ],
    adapters: running.map((r) => r.adapter),
    servers: running.map((r) => r.server),
    stop,
  };
}

/** Warn (not fail) when the config file is readable by group/others — it
 * holds every bridge's api key. Returns a warning string or null. */
export function configPermissionsWarning(path) {
  try {
    const mode = statSync(path).mode & 0o777;
    if (mode & 0o077) return `config ${path} is readable by group/others (mode ${mode.toString(8)}) — it holds every bridge's api key; chmod 600 it.`;
  } catch (_) {}
  return null;
}
