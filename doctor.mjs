// agent-bridge/doctor.mjs — `agent-bridge doctor`: pre-flight checks for a
// serve config, run BEFORE the first chat. Serve starts happily with a
// missing agent binary (the async ENOENT only surfaces on the first TURN —
// the paid-for first-run trap: /health looks fine, the first turn dies) and
// a port conflict only surfaces at boot. Doctor surfaces both up front, and
// every FAIL line carries its own fix — the moment of need is the moment of
// instruction.
//
// Checks, per config entry (all against the SAME --bind serve would use):
//   config   parses + validates (one fail listing every problem, same
//            validator serve uses — no second opinion to drift from)
//   binary   the spawn command resolves on PATH — the registry default, or
//            the entry's own "command"/"codexBin" override
//   port     free — or already serving THIS bridge (a running serve passes:
//            the probe doubles as its /health check); a different bridge or
//            a foreign process fails
//   apiKey   required on every entry when --bind is non-loopback (same rule
//            startServe enforces, reported before it can refuse)
//
// With NO agents.json at the default path, doctor still answers "what could
// run on this machine?": it checks the registry defaults (warn-only — no
// config means no committed setup to fail) and prints the usual starter hint.
//
// Exit code: 1 iff any check FAILed (warnings never fail). `--json` prints
// {ok, checks:[{check, status: 'pass'|'warn'|'fail', detail, hint?}]} — the
// machine-readable shape agent-driven setup flows read.

import http from 'node:http';
import { createServer } from 'node:net';
import { accessSync, constants } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { loadConfig, configPermissionsWarning, missingConfigHint, LOOPBACKS } from './serve.mjs';
import { KNOWN_AGENTS, knownAgentNames } from './agents-registry.mjs';
import { agentPath } from './adapters/agent-env.mjs';
import { resolveServerCjs } from './adapters/zcode-server.mjs';

const HEALTH_TIMEOUT_MS = 1500;
const HEALTH_BODY_CAP = 4096;

/** Resolve a command to an executable file: bare names walk the SAME PATH a
 * spawn would get (the system PATH first, then this package's bundled shim
 * dirs APPENDED — see adapters/agent-env.mjs — with PATHEXT on Windows where
 * npm CLI shims are .cmd), anything with a path separator is checked as-is.
 * Returns the resolved path or null. */
export function findOnPath(cmd) {
  const hasSep = cmd.includes('/') || cmd.includes('\\');
  if (hasSep || isAbsolute(cmd)) {
    const p = resolve(cmd);
    try { accessSync(p, constants.X_OK); return p; } catch (_) { return null; }
  }
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';')
    : [''];
  for (const dir of agentPath().split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      try { accessSync(join(dir, cmd + ext), constants.X_OK); return join(dir, cmd + ext); } catch (_) {}
    }
  }
  return null;
}

/** True when nothing is listening on bind:port (best effort: any listen
 * error counts as busy). Closes its probe socket either way. */
function portFree(port, bind) {
  return new Promise((resolveProbe) => {
    const srv = createServer();
    srv.once('error', () => resolveProbe(false));
    srv.listen(port, bind, () => srv.close(() => resolveProbe(true)));
  });
}

/** GET /health with a short timeout. Returns {status, json} — json is the
 * parsed body when it looks like our health object ({ok:true,…}), else null;
 * any failure (refused, timeout, non-JSON) degrades to {status: 0, json: null}. */
function probeHealth(port, bind, token) {
  // The health probe connects to the bind address itself; 0.0.0.0 is not a
  // connectable host — loopback stands in for it (same mapping the banner uses).
  const host = bind === '0.0.0.0' ? '127.0.0.1' : bind;
  return new Promise((resolveProbe) => {
    const req = http.get({
      host, port, path: '/health',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      timeout: HEALTH_TIMEOUT_MS,
    }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; if (body.length > HEALTH_BODY_CAP) req.destroy(); });
      res.on('end', () => {
        let json = null;
        try { const p = JSON.parse(body); if (p && p.ok === true) json = p; } catch (_) {}
        resolveProbe({ status: res.statusCode, json });
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolveProbe({ status: 0, json: null }));
  });
}

/** The spawn command a bridge entry will use — mirrors adapterFor's
 * resolution (explicit override > registry default) as a static check. */
function spawnCommandOf(b) {
  const spec = KNOWN_AGENTS[b.name];
  if (spec.kind === 'codex') return { cmd: b.codexBin || 'codex', overridden: b.codexBin !== undefined };
  if (spec.kind === 'zcode') {
    // No PATH command: the adapter reuses the desktop app's installed runtime
    // bundle (auto-resolved, "serverCjs" overrides).
    let resolved = null;
    try { resolved = resolveServerCjs({ serverCjs: b.serverCjs }); } catch (_) {}
    return { cmd: resolved || 'zcode-server.cjs (not found)', overridden: b.serverCjs !== undefined, isFile: !!resolved };
  }
  return { cmd: (b.command || spec.command)[0], overridden: b.command !== undefined };
}

/** Run every check. Returns {ok, checks} WITHOUT printing — cli.mjs owns the
 * output formats (human table / --json). */
export async function runDoctor({ configPath = 'agents.json', bind = '127.0.0.1' } = {}) {
  const checks = [];
  const push = (check, status, detail, hint) => checks.push({ check, status, detail, ...(hint ? { hint } : {}) });
  const loopback = LOOPBACKS.includes(bind);

  let cfg = null;
  try {
    cfg = loadConfig(configPath);
    push('config', 'pass', `${configPath}: ${cfg.bridges.length} bridge(s)`);
  } catch (e) {
    const hint = missingConfigHint(configPath, e.message);
    if (configPath === 'agents.json' && /cannot read config/.test(e.message)) {
      // Nothing configured yet — check the registry defaults instead
      // (warn-only: there is no committed setup to fail), and hand over the
      // starter hint so the very next step is copy-pasteable.
      push('config', 'warn', `no agents.json here — checking the registry defaults instead`, hint.trim() || undefined);
      for (const name of knownAgentNames()) {
        const spec = KNOWN_AGENTS[name];
        if (spec.kind === 'zcode') {
          // No PATH command exists — the adapter reuses the desktop app's
          // installed runtime bundle, so the check is bundle discovery.
          let bundle = null;
          try { bundle = resolveServerCjs({}); } catch (_) {}
          push(`agent ${name}`,
            bundle ? 'pass' : 'warn',
            bundle ? `zcode server bundle found (${bundle}) — ready to configure` : 'zcode server bundle not found (registry default: the ZCode desktop app\'s installed runtime)',
            bundle ? undefined : `install: ${spec.install}`);
          continue;
        }
        const cmd = spec.kind === 'codex' ? 'codex' : spec.command[0];
        const found = findOnPath(cmd);
        push(`agent ${name}`,
          found ? 'pass' : 'warn',
          found ? `${cmd} found — ready to configure` : `${cmd} not on PATH (registry default: ${spec.command ? spec.command.join(' ') : 'native codex adapter'})`,
          found ? undefined : `install: ${spec.install}`);
      }
      return { ok: true, checks };
    }
    push('config', 'fail', e.message, hint.trim() || undefined);
    return { ok: false, checks };
  }
  const perm = configPermissionsWarning(configPath);
  if (perm) push('config', 'warn', perm);

  for (const b of cfg.bridges) {
    if (KNOWN_AGENTS[b.name]?.kind === 'zcode') {
      // zcode checks the resolved runtime bundle, not a PATH command.
      const { cmd, isFile } = spawnCommandOf(b);
      if (isFile) {
        push(`bridge ${b.name}`, 'pass', `zcode server bundle found (${cmd})`);
      } else {
        push(`bridge ${b.name}`, 'fail',
          `zcode server bundle not found — serve still starts and answers /health, but this bridge's first turn dies with a resolution error`,
          `install/open the ZCode desktop app once, or set the entry's "serverCjs" to the zcode-server.cjs inside it`);
      }
      continue;
    }
    const { cmd, overridden } = spawnCommandOf(b);
    const found = findOnPath(cmd);
    if (found) {
      push(`bridge ${b.name}`, 'pass', `command "${cmd}" found (${found})`);
    } else {
      push(`bridge ${b.name}`, 'fail',
        `command "${cmd}" not found on PATH — serve still starts and answers /health, but this bridge's first turn dies with ENOENT`,
        overridden ? `install "${cmd}" or fix the entry's command/codexBin override` : `install: ${KNOWN_AGENTS[b.name].install}`);
    }

    const free = await portFree(b.port, bind);
    if (free) {
      push(`bridge ${b.name}`, 'pass', `port ${b.port} free on ${bind}`);
    } else {
      const { status, json } = await probeHealth(b.port, bind, b.apiKey);
      if (json && json.agent === b.name) {
        push(`bridge ${b.name}`, 'pass', `port ${b.port}: already serving this bridge (/health ok${json.version ? `, v${json.version}` : ''}) — stop it first if you mean to reconfigure`);
      } else if (json && json.agent) {
        push(`bridge ${b.name}`, 'fail', `port ${b.port} on ${bind} is taken by bridge "${json.agent}" — give this entry a different port`);
      } else if (status === 401) {
        push(`bridge ${b.name}`, 'fail', `port ${b.port} on ${bind} is answering 401 — an agent-bridge with a different apiKey is running there`);
      } else {
        push(`bridge ${b.name}`, 'fail', `port ${b.port} on ${bind} is already in use by another process`);
      }
    }

    if (!loopback && !b.apiKey) {
      push(`bridge ${b.name}`, 'fail',
        `bind ${bind} is non-loopback — entry "${b.name}" has no apiKey; serve refuses keyless entries beyond loopback`,
        'set "apiKey" on the entry, or drop --bind to stay on 127.0.0.1');
    }
  }

  return { ok: !checks.some((c) => c.status === 'fail'), checks };
}

/** Human-readable report lines (cli.mjs prints them one per console.log). */
export function formatReport({ ok, checks }) {
  const ICON = { pass: 'ok  ', warn: 'WARN', fail: 'FAIL' };
  const lines = [`agent-bridge doctor — ${ok ? 'no failures' : 'FAILURES found (each carries its fix below)'}`];
  for (const c of checks) {
    lines.push(`  ${ICON[c.status]}  ${c.check.padEnd(14)} ${c.detail}`);
    if (c.hint) lines.push(`      hint: ${c.hint.trim().replace(/^\n\s*/, '')}`);
  }
  const n = (s) => checks.filter((c) => c.status === s).length;
  lines.push(`  ${n('fail')} fail, ${n('pass')} pass, ${n('warn')} warn — exit ${ok ? 0 : 1}`);
  return lines;
}
