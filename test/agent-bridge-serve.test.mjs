// test/agent-bridge-serve.test.mjs — `serve` mode: many bridges, one process,
// each on its own port with its own api key. Drives the REAL loaders and
// REAL servers against the scripted fake agents (no installs, no network):
// config validation, per-bridge apiKey enforcement, a real turn through a
// served bridge (command override → fake ACP agent), and fail-fast on a
// port conflict naming the bridge.
//
// Keeps buffers tiny (a few dozen bytes per event) per low-memory CI boxes.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_ACP = join(__dirname, 'fake-acp-agent.mjs');
const FAKE_CODEX = join(__dirname, 'fake-codex-app-server.mjs');

const { validateConfig, loadConfig, startServe, configPermissionsWarning } = await import('../serve.mjs');

chmodSync(FAKE_ACP, 0o755);
chmodSync(FAKE_CODEX, 0o755);

const handles = [];
afterEach(() => {
  while (handles.length) handles.pop().stop();
});

/** Grab a free TCP port (tiny TOCTOU window; fine for sequential tests). */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function get(path, port, headers = {}) {
  return fetch(`http://127.0.0.1:${port}${path}`, { headers });
}

test('validateConfig: all problems reported at once, with the fix hint', () => {
  assert.throws(
    () => validateConfig({ bridges: [
      { name: 'nope', port: 1, apiKey: 'k' },                       // unknown agent
      { name: 'codex', port: 3949, apiKey: 'k', command: ['x'] },   // command on codex
      { name: 'codex', port: 3950, apiKey: 'k' },                   // dup name
      { name: 'claude', port: 3949, apiKey: 'k' },                  // dup port (with codex above)
      { name: 'claude', port: 70000, apiKey: 'k', sandbox: 'yolo' } // bad port + bad sandbox
    ] }),
    (e) => /unknown agent "nope".*known agents: codex, claude, pi/s.test(e.message)
      && /native adapter.*codexBin.*not "command"/s.test(e.message)
      && /duplicate name "codex"/.test(e.message)
      && /duplicate port 3949/.test(e.message)
      && /"port" must be an integer/.test(e.message)
      && /"sandbox" must be one of/.test(e.message)
  );
});

test('loadConfig: invalid JSON says so; valid file expands ~ and defaults nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ab-serve-'));
  const bad = join(dir, 'bad.json');
  writeFileSync(bad, '{ nope');
  assert.throws(() => loadConfig(bad), /not valid JSON/);

  const good = join(dir, 'good.json');
  writeFileSync(good, JSON.stringify({ bridges: [{ name: 'codex', port: 1, apiKey: 'k', cwd: '~/work' }] }));
  const cfg = loadConfig(good);
  assert.equal(cfg.bridges[0].cwd, join(homedir(), 'work'));
});

test('serve: one bridge per entry, /health answers with the agent name, apiKey enforced', async () => {
  const p1 = await freePort();
  const cfg = validateConfig({ bridges: [{ name: 'claude', port: p1, apiKey: 'k1', command: [FAKE_ACP] }] });
  const run = await startServe(cfg);
  handles.push(run);

  const noKey = await get('/health', p1);
  assert.equal(noKey.status, 401);
  const withKey = await get('/health', p1, { Authorization: 'Bearer k1' });
  const j = await withKey.json();
  assert.equal(j.ok, true);
  assert.equal(j.agent, 'claude', '/health reports the registry name');
  assert.match(run.banner.join('\n'), /claude/);
});

test('serve: a real turn streams through a served bridge', async () => {
  const p1 = await freePort();
  const cfg = validateConfig({ bridges: [{ name: 'claude', port: p1, apiKey: 'k1', command: [FAKE_ACP] }] });
  const run = await startServe(cfg);
  handles.push(run);

  const res = await fetch(`http://127.0.0.1:${p1}/turns`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer k1' },
    body: JSON.stringify({ text: 'hi' }),
  });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /"type":"start"/);
  assert.match(body, /"type":"delta"/);
  assert.match(body, /ACP_reply/);
  assert.match(body, /"type":"done"/);
});

test('serve: two bridges in one process, each with its own key and agent', async () => {
  const p1 = await freePort();
  const p2 = await freePort();
  const cfg = validateConfig({ bridges: [
    { name: 'claude', port: p1, apiKey: 'kc', command: [FAKE_ACP] },
    { name: 'codex', port: p2, apiKey: 'kx', codexBin: FAKE_CODEX },
  ] });
  const run = await startServe(cfg);
  handles.push(run);

  // Keys are per-bridge: claude's key does not open codex's bridge.
  const swapped = await get('/health', p2, { Authorization: 'Bearer kc' });
  assert.equal(swapped.status, 401);
  const j = await (await get('/health', p2, { Authorization: 'Bearer kx' })).json();
  assert.equal(j.agent, 'codex');
  const j2 = await (await get('/health', p1, { Authorization: 'Bearer kc' })).json();
  assert.equal(j2.agent, 'claude');
});

test('serve: port conflict fails fast, names the bridge, shuts down the ones that started', async () => {
  const blocker = net.createServer();
  const occupied = await new Promise((resolve) => blocker.listen(0, '127.0.0.1', () => resolve(blocker.address().port)));
  const p1 = await freePort();
  const cfg = validateConfig({ bridges: [
    { name: 'claude', port: p1, apiKey: 'k1', command: [FAKE_ACP] },
    { name: 'codex', port: occupied, apiKey: 'k2' },
  ] });
  await assert.rejects(
    () => startServe(cfg),
    (e) => /bridge "codex" failed to start: port \d+ is already in use/.test(e.message)
  );
  blocker.close();
  // The first bridge must not linger half-started: its port is closed.
  const gone = await new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: p1, path: '/health' }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve(0));
  });
  assert.equal(gone, 0, 'the earlier bridge must have been shut down');
});

test('validateConfig: cwd becomes absolute (ACP shims reject relative paths)', () => {
  const cfg = validateConfig({ bridges: [
    { name: 'claude', port: 1, apiKey: 'k', cwd: './sub' },
    { name: 'codex', port: 2, apiKey: 'k' }, // omitted → the serve start directory
  ] });
  assert.ok(cfg.bridges[0].cwd.endsWith('/sub') && cfg.bridges[0].cwd.startsWith('/'), `relative cwd must resolve: ${cfg.bridges[0].cwd}`);
  assert.ok(cfg.bridges[1].cwd.startsWith('/'), `default cwd must be absolute: ${cfg.bridges[1].cwd}`);
});

test('serve: keyless entry (empty apiKey) runs unauthenticated on loopback', async () => {
  const p1 = await freePort();
  const cfg = validateConfig({ bridges: [{ name: 'claude', port: p1, apiKey: '', command: [FAKE_ACP] }] });
  const run = await startServe(cfg);
  handles.push(run);
  const j = await (await get('/health', p1)).json();
  assert.equal(j.ok, true, 'empty apiKey = keyless on loopback');
  assert.match(run.banner.join('\n'), /no api key — loopback only/);
});

test('serve: keyless entries refuse non-loopback binds', async () => {
  const p1 = await freePort();
  const cfg = validateConfig({ bridges: [
    { name: 'claude', port: p1, command: [FAKE_ACP] },
    { name: 'codex', port: await freePort(), apiKey: 'kx' },
  ] });
  await assert.rejects(
    () => startServe(cfg, { bind: '0.0.0.0' }),
    (e) => {
      const list = e.message.match(/without apiKey: ([^\n]+)/)[1].split('—')[0].trim();
      return list === 'claude';
    },
    'names the keyless bridges only (codex has a key and is fine)'
  );
});

test('configPermissionsWarning: flags group/world-readable files, silent on 600', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ab-perm-'));
  const loose = join(dir, 'loose.json');
  writeFileSync(loose, '{}', { mode: 0o644 });
  assert.match(configPermissionsWarning(loose), /chmod 600/);
  const tight = join(dir, 'tight.json');
  writeFileSync(tight, '{}', { mode: 0o600 });
  assert.equal(configPermissionsWarning(tight), null);
});
