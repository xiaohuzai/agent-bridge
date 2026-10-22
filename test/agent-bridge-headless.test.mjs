// test/agent-bridge-headless.test.mjs — the headless-CLI adapter (the
// profile-driven transport borrowed from Orca's agent table) driven through
// the REAL HTTP surface against test/fake-zcode-cli.mjs, which speaks the
// JSONL envelope captured live from ZCode 0.17.0 on 2026-10-21. Covers the
// ZCode profile end to end: streaming deltas, usage/cache mapping, tool rows,
// thinking fences, --resume wiring, mode preselection, image degradation, the
// missing-binary and failed-turn errors, and disconnect → kill.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_ZCODE = join(__dirname, 'fake-zcode-cli.mjs');
chmodSync(FAKE_ZCODE, 0o755);

const { createBridgeServer } = await import('../server.mjs');
const { HeadlessCliAdapter } = await import('../adapters/headless-cli.mjs');
const { validateConfig, adapterFor } = await import('../serve.mjs');

let server;
let adapter;
let port;
let logs;
let logFile;

async function startServer({ mode, command, env = {} } = {}) {
  logs = [];
  logFile = join(tmpdir(), `fake-zcode-${randomUUID()}.json`);
  adapter = new HeadlessCliAdapter({
    profile: 'zcode',
    command: command || [process.execPath, FAKE_ZCODE],
    cwd: process.cwd(),
    mode,
    env: { FAKE_ZCODE_LOG: logFile, ...env },
    installHint: 'install zcode',
    log: (m) => logs.push(m),
  });
  server = createBridgeServer({ adapter, agent: 'zcode', version: 'test', log: (m) => logs.push(m) });
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve();
    });
  });
}

async function stopServer() {
  try { adapter.stop(); } catch (_) {}
  const s = server;
  server = null;
  await new Promise((r) => s.close(() => r()));
  s.closeAllConnections?.();
  try { rmSync(logFile, { force: true }); } catch (_) {}
}

beforeEach(() => startServer());
afterEach(() => stopServer());

function post(path, body, extraHeaders = {}, signal) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
    signal,
  });
}

/** Read an SSE body incrementally with a frame predicate + timeout. */
function sseReader(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const frames = [];
  const readUntil = async (pred, ms = 8000) => {
    const t0 = Date.now();
    for (;;) {
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        if (line.startsWith('data:')) frames.push({ data: JSON.parse(line.slice(5)) });
      }
      const hit = frames.find(pred);
      if (hit) return hit;
      if (Date.now() - t0 > ms) throw new Error(`timeout waiting for frame; got: ${frames.map((f) => f.data.type).join(',')}`);
      const { value, done } = await reader.read();
      if (value) buf += decoder.decode(value, { stream: true });
      if (done && !hit) throw new Error(`stream ended before expected frame; got: ${frames.map((f) => f.data.type).join(',')}`);
    }
  };
  const cancel = () => { try { reader.cancel().catch(() => {}); } catch (_) {} };
  return { readUntil, cancel, frames };
}

function spawnedArgs() {
  return JSON.parse(readFileSync(logFile, 'utf8'));
}

const PNG_1X1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('headless happy path: start → deltas → usage → done (plan mode, no resume)', async () => {
  const res = await post('/turns', { text: 'PONG' });
  assert.equal(res.status, 200);
  const sse = sseReader(res.body);
  const start = await sse.readUntil((f) => f.data.type === 'start');
  assert.equal(start.data.sessionId, 'sess_fake_1');
  const done = await sse.readUntil((f) => f.data.type === 'done');
  assert.equal(done.data.full, 'PONG');
  assert.deepEqual(
    sse.frames.filter((f) => f.data.type === 'delta').map((f) => f.data.text).join(''),
    'PONG',
  );
  const usage = sse.frames.find((f) => f.data.type === 'usage').data;
  assert.equal(usage.prompt_tokens, 100);
  assert.equal(usage.completion_tokens, 3);
  assert.equal(usage.cached_tokens, 0);
  const argv = spawnedArgs();
  assert.equal(argv.mode, 'plan');
  assert.equal(argv.resume, null);
  assert.equal(argv.cwd, process.cwd());
  assert.ok(argv.args.includes('--output-format') && argv.args.includes('stream-json'));
});

test('resume: the client session id rides --resume and cache usage is mapped', async () => {
  const res = await post('/turns', { text: 'again', sessionId: 'sess_fake_9' });
  const sse = sseReader(res.body);
  const start = await sse.readUntil((f) => f.data.type === 'start');
  assert.equal(start.data.sessionId, 'sess_fake_9');
  const done = await sse.readUntil((f) => f.data.type === 'done');
  assert.equal(done.data.full, 'PONG');
  const usage = sse.frames.find((f) => f.data.type === 'usage').data;
  assert.equal(usage.cached_tokens, 40);
  assert.equal(spawnedArgs().resume, 'sess_fake_9');
});

test('tool.updated maps to paired v1 tool rows carrying the call id', async () => {
  const res = await post('/turns', { text: 'TOOL' });
  const sse = sseReader(res.body);
  const started = await sse.readUntil((f) => f.data.type === 'tool' && f.data.status === 'started');
  assert.equal(started.data.id, 'call_fake_1');
  assert.equal(started.data.name, 'Read');
  assert.equal(started.data.detail, '/tmp/fake.txt');
  const completed = await sse.readUntil((f) => f.data.type === 'tool' && f.data.status === 'completed');
  assert.equal(completed.data.id, 'call_fake_1');
  const done = await sse.readUntil((f) => f.data.type === 'done');
  assert.equal(done.data.full, 'tool done');
});

test('reasoning deltas are fenced so full agrees with the delta concat', async () => {
  const res = await post('/turns', { text: 'THINK' });
  const sse = sseReader(res.body);
  const done = await sse.readUntil((f) => f.data.type === 'done');
  assert.equal(done.data.full, '<thinking>checking the input</thinking>\nPONG');
  const concat = sse.frames.filter((f) => f.data.type === 'delta').map((f) => f.data.text).join('');
  assert.ok(concat.includes('<thinking>checking the input</thinking>'));
  assert.ok(concat.endsWith('PONG'));
});

test('a non-success resultType becomes an error frame (no done)', async () => {
  const res = await post('/turns', { text: 'REFUSE' });
  const sse = sseReader(res.body);
  const err = await sse.readUntil((f) => f.data.type === 'error');
  assert.match(err.data.message, /zcode turn ended: failure/);
  assert.equal(sse.frames.some((f) => f.data.type === 'done'), false);
});

test('missing binary: the turn error names the install hint', async () => {
  await stopServer();
  await startServer({ command: ['/nonexistent/zcode-cli-does-not-exist'] });
  const res = await post('/turns', { text: 'PONG' });
  const sse = sseReader(res.body);
  const err = await sse.readUntil((f) => f.data.type === 'error');
  assert.match(err.data.message, /agent binary not found/);
  assert.match(err.data.message, /install zcode/);
});

test('images degrade to an honest note instead of being dropped silently', async () => {
  const res = await post('/turns', { text: 'PONG', images: [PNG_1X1] });
  const sse = sseReader(res.body);
  const note = await sse.readUntil((f) => f.data.type === 'note');
  assert.match(note.data.text, /1 张图片/);
  const done = await sse.readUntil((f) => f.data.type === 'done');
  assert.equal(done.data.full, 'PONG');
});

test('mode override reaches the CLI argv', async () => {
  await stopServer();
  await startServer({ mode: 'yolo' });
  const res = await post('/turns', { text: 'PONG' });
  const sse = sseReader(res.body);
  await sse.readUntil((f) => f.data.type === 'done');
  assert.equal(spawnedArgs().mode, 'yolo');
});

test('disconnect mid-turn kills the headless process', async () => {
  const ac = new AbortController();
  const res = await post('/turns', { text: 'SLOW' }, {}, ac.signal);
  const sse = sseReader(res.body);
  await sse.readUntil((f) => f.data.type === 'start');
  assert.deepEqual(adapter.listSessions(), [{ sessionId: 'sess_fake_1', busy: true }]);
  ac.abort();
  sse.cancel();
  const t0 = Date.now();
  while (adapter.turns.size > 0 && Date.now() - t0 < 5000) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(adapter.turns.size, 0, `headless child still tracked; logs: ${logs.join(' | ')}`);
});

test('config validation: zcode is headless, mode is whitelisted, stale native fields fail', () => {
  const ok = validateConfig({ bridges: [{ name: 'zcode', port: 3999, mode: 'plan' }] });
  assert.equal(ok.bridges[0].mode, 'plan');
  assert.ok(adapterFor(ok.bridges[0]).adapter instanceof HeadlessCliAdapter);

  assert.throws(
    () => validateConfig({ bridges: [{ name: 'zcode', port: 3999, mode: 'nope' }] }),
    /mode must be one of/,
  );
  assert.throws(
    () => validateConfig({ bridges: [{ name: 'zcode', port: 3999, serverCjs: '/x/zcode-server.cjs' }] }),
    /belonged to the paused native zcode adapter/,
  );
});
