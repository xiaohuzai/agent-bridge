// test/agent-bridge-doctor.test.mjs — `agent-bridge doctor`: pre-flight
// checks whose whole point is the paid-for first-run trap (serve starts and
// answers /health even when the agent binary is missing — the first TURN
// dies with ENOENT). Doctor must catch that BEFORE the first chat, and every
// FAIL must carry its own fix. A running serve must PASS the port check
// (the probe doubles as its /health check); a foreign process must fail.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDoctor, formatReport } from '../doctor.mjs';
import { createBridgeServer } from '../server.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '..', 'cli.mjs');
const REPO = join(__dirname, '..');

const tmp = mkdtempSync(join(tmpdir(), 'ab-doctor-'));
process.on('exit', () => { try { rmSync(tmp, { recursive: true, force: true }); } catch (_) {} });

function runCli(args, cwd) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [CLI, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    proc.stdout.on('data', (d) => { stdout += String(d); });
    proc.stderr.on('data', (d) => { stderr += String(d); });
    proc.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

function writeConfig(name, obj) {
  const p = join(tmp, name);
  writeFileSync(p, JSON.stringify(obj));
  return p;
}

/** Grab a free loopback port and hand it back (tiny TOCTOU race is fine —
 * the suite picks a fresh one per test and holds nothing else open). */
function freePort() {
  return new Promise((resolve) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

const stubAdapter = {
  listSessions: () => [],
  startTurn: async () => {},
  interrupt() {},
  respondApproval() {},
  stop() {},
};

test('doctor with no agents.json: registry defaults, warn-only, starter hint, exit 0', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ab-doctor-empty-'));
  const { code, stdout } = await runCli(['doctor', '--json'], dir);
  assert.equal(code, 0, 'a missing config is not a failure — nothing is configured yet');
  const report = JSON.parse(stdout);
  assert.equal(report.ok, true);
  const configCheck = report.checks.find((c) => c.check === 'config');
  assert.equal(configCheck.status, 'warn');
  assert.match(configCheck.hint, /agents\.example\.json agents\.json/, 'the very next step stays copy-pasteable');
  assert.match(configCheck.detail, /registry defaults/);
  for (const name of ['codex', 'claude', 'pi', 'gemini']) {
    const c = report.checks.find((x) => x.check === `agent ${name}`);
    assert.ok(c, `registry default for ${name} is reported`);
    assert.ok(['pass', 'warn'].includes(c.status));
  }
  rmSync(dir, { recursive: true, force: true });
});

test('doctor with an explicitly missing --config: fail, raw error, no starter hint', async () => {
  const { code, stdout } = await runCli(['doctor', '--config', join(tmp, 'nope.json')], tmp);
  assert.equal(code, 1);
  assert.match(stdout, /cannot read config/);
  assert.doesNotMatch(stdout, /agents\.example\.json agents\.json/);
});

test('doctor flags a configured entry whose binary is missing, with a fix', async () => {
  const port = await freePort();
  const cfg = writeConfig('missing-bin.json', {
    bridges: [{ name: 'claude', port, command: ['/nonexistent/claude-agent-acp-xyz'] }],
  });
  const { ok, checks } = await runDoctor({ configPath: cfg });
  assert.equal(ok, false);
  const bridge = checks.filter((c) => c.check === 'bridge claude');
  const binFail = bridge.find((c) => /not found on PATH/.test(c.detail));
  assert.ok(binFail, 'the missing binary is a FAIL');
  assert.equal(binFail.status, 'fail');
  assert.match(binFail.detail, /first turn dies with ENOENT/, 'names the trap it prevents');
  assert.match(binFail.hint, /fix the entry's command/, 'an overridden command gets the override-aware hint');
  assert.ok(bridge.some((c) => /port .* free/.test(c.detail) && c.status === 'pass'), 'the free port still passes');
});

test('doctor passes a fully valid config (binary found, port free, loopback keyless)', async () => {
  const port = await freePort();
  const nop = join(tmp, 'nop.js');
  writeFileSync(nop, '// sits on disk so the command resolves; never run by doctor\n');
  const cfg = writeConfig('valid.json', {
    bridges: [{ name: 'pi', port, command: [process.execPath, nop] }],
  });
  const { ok, checks } = await runDoctor({ configPath: cfg });
  assert.equal(ok, true);
  assert.ok(!checks.some((c) => c.status === 'fail'), JSON.stringify(checks));
});

test('doctor fails a port held by a foreign process', async () => {
  const port = await freePort();
  const foreign = http.createServer((req, res) => { res.writeHead(200); res.end('<html>not a bridge</html>'); });
  await new Promise((r) => foreign.listen(port, '127.0.0.1', r));
  try {
    const nop = join(tmp, 'nop.js');
    const cfg = writeConfig('foreign-port.json', {
      bridges: [{ name: 'pi', port, command: [process.execPath, nop] }],
    });
    const { ok, checks } = await runDoctor({ configPath: cfg });
    assert.equal(ok, false);
    const portFail = checks.find((c) => c.check === 'bridge pi' && c.status === 'fail');
    assert.ok(portFail);
    assert.match(portFail.detail, /already in use by another process/);
  } finally {
    await new Promise((r) => foreign.close(r));
  }
});

test('doctor recognizes a RUNNING agent-bridge on the port as pass', async () => {
  const port = await freePort();
  const server = createBridgeServer({ adapter: stubAdapter, agent: 'pi', version: '9.9.9', token: '' });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  try {
    const nop = join(tmp, 'nop.js');
    const cfg = writeConfig('running.json', {
      bridges: [{ name: 'pi', port, command: [process.execPath, nop] }],
    });
    const { ok, checks } = await runDoctor({ configPath: cfg });
    assert.equal(ok, true);
    const serving = checks.find((c) => c.check === 'bridge pi' && /already serving this bridge/.test(c.detail));
    assert.ok(serving, 'a running serve must pass its own port check');
    assert.match(serving.detail, /v9\.9\.9/, 'reports the running version');
  } finally {
    await new Promise((r) => { server.close(r); server.closeAllConnections?.(); });
  }
});

test('doctor fails a port held by ANOTHER bridge (name mismatch on /health)', async () => {
  const port = await freePort();
  const server = createBridgeServer({ adapter: stubAdapter, agent: 'codex', version: '9.9.9', token: '' });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  try {
    const nop = join(tmp, 'nop.js');
    const cfg = writeConfig('other-bridge.json', {
      bridges: [{ name: 'pi', port, command: [process.execPath, nop] }],
    });
    const { ok, checks } = await runDoctor({ configPath: cfg });
    assert.equal(ok, false);
    const clash = checks.find((c) => c.check === 'bridge pi' && c.status === 'fail');
    assert.ok(clash);
    assert.match(clash.detail, /taken by bridge "codex"/);
  } finally {
    await new Promise((r) => { server.close(r); server.closeAllConnections?.(); });
  }
});

test('doctor enforces the non-loopback apiKey rule before serve can refuse it', async () => {
  const port = await freePort();
  const nop = join(tmp, 'nop.js');
  const cfg = writeConfig('keyless.json', {
    bridges: [{ name: 'pi', port, command: [process.execPath, nop] }],
  });
  const { ok, checks } = await runDoctor({ configPath: cfg, bind: '0.0.0.0' });
  assert.equal(ok, false);
  const keyFail = checks.find((c) => c.check === 'bridge pi' && /apiKey/.test(c.detail));
  assert.ok(keyFail);
  assert.equal(keyFail.status, 'fail');
  assert.match(keyFail.hint, /apiKey/);
});

test('formatReport: FAIL lines carry hint lines, summary names the exit code', () => {
  const lines = formatReport({
    ok: false,
    checks: [
      { check: 'config', status: 'pass', detail: 'x.json: 1 bridge(s)' },
      { check: 'bridge claude', status: 'fail', detail: 'command "z" not found on PATH', hint: '\n  install: npm i -g z' },
    ],
  });
  const text = lines.join('\n');
  assert.match(text, /FAIL  bridge claude/);
  assert.match(text, /hint: install: npm i -g z/, 'leading newlines from the shared hint are trimmed');
  assert.match(text, /1 fail, 1 pass, 0 warn — exit 1/);
});
