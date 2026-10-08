// test/agent-bridge-workbuddy.test.mjs — the WorkBuddy adapter driven
// end-to-end through the REAL HTTP surface (createBridgeServer) talking to
// test/fake-workbuddy-daemon.mjs, a scripted stand-in for the CodeBuddy Code
// worker gateway (ACP over Streamable HTTP — wire facts mirrored from the
// real worker, see adapters/workbuddy.mjs header). Covers: connect +
// initialize, streamed deltas with thinking folds, session resume, the
// lost-session fallback (load fails → fresh session + note + re-key),
// images as content blocks, approval round trip, cancel → aborted, failed
// turns, and the workbuddyPort override. Keeps buffers tiny per low-memory CI.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_DAEMON = join(__dirname, 'fake-workbuddy-daemon.mjs');

const { createBridgeServer } = await import('../server.mjs');
const { WorkbuddyAdapter } = await import('../adapters/workbuddy.mjs');

const PNG_1X1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let server;
let adapter;
let daemonProcess;
let daemonPort;
let logs;

async function startServer() {
  logs = [];
  // spawn the fake daemon as a child process (standalone HTTP script); its
  // stderr markers double as the assertion feed
  daemonProcess = spawn(process.execPath, [FAKE_DAEMON, '0'], { stdio: ['ignore', 'ignore', 'pipe'] });
  daemonPort = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('fake daemon did not listen')), 5000);
    daemonProcess.stderr.on('data', (d) => {
      logs.push(`[daemon] ${String(d).trimEnd()}`);
      const m = /FAKE_LISTENING:(\d+)/.exec(String(d));
      if (m) { clearTimeout(t); resolve(Number(m[1])); }
    });
  });

  adapter = new WorkbuddyAdapter({
    workbuddyPort: daemonPort,
    cwd: process.cwd(),
    log: (m) => logs.push(m),
  });
  server = createBridgeServer({ adapter, agent: 'workbuddy', version: 'test', log: (m) => logs.push(m) });
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); });
  });
}

async function stopServer() {
  try { adapter.stop(); } catch (_) {}
  try { daemonProcess?.kill('SIGKILL'); } catch (_) {}
  daemonProcess = null;
  const s = server;
  server = null;
  await new Promise((r) => s.close(() => r()));
  s.closeAllConnections?.();
}

let port;

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
      if (Date.now() - t0 > ms) throw new Error(`timeout waiting for SSE frame; got: ${frames.map((f) => f.data.type).join(',')}`);
      const { value, done } = await reader.read();
      if (value) buf += decoder.decode(value, { stream: true });
      if (done && !hit) throw new Error(`stream ended before expected frame; got: ${frames.map((f) => f.data.type).join(',')}`);
    }
  };
  const cancel = () => { try { reader.cancel().catch(() => {}); } catch (_) {} };
  return { readUntil, cancel, frames };
}

test('happy path: start → streamed deltas → done with full text', async () => {
  const res = await post('/turns', { text: 'hello there' });
  assert.equal(res.status, 200);
  const sse = sseReader(res.body);
  const start = await sse.readUntil((f) => f.data.type === 'start');
  assert.match(start.data.sessionId, /^sess_fake\d+$/);
  const done = await sse.readUntil((f) => f.data.type === 'done');
  const deltas = sse.frames.filter((f) => f.data.type === 'delta').map((f) => f.data.text).join('');
  assert.equal(done.data.full, 'FAKE_reply');
  assert.equal(deltas, 'FAKE_reply');
  // the daemon echoed the acp-connection-id gate — the adapter passed it
  assert.ok(logs.some((l) => l.includes('FAKE_METHOD:initialize')), 'initialize ran');
});

test('resume: a second turn with the same sessionId rides the loaded session', async () => {
  const r1 = await post('/turns', { text: 'first' });
  const s1 = sseReader(r1.body);
  const start1 = await s1.readUntil((f) => f.data.type === 'start');
  await s1.readUntil((f) => f.data.type === 'done');
  const sid = start1.data.sessionId;

  const r2 = await post('/turns', { text: 'second', sessionId: sid });
  const s2 = sseReader(r2.body);
  const start2 = await s2.readUntil((f) => f.data.type === 'start');
  assert.equal(start2.data.sessionId, sid);
  const done2 = await s2.readUntil((f) => f.data.type === 'done');
  assert.equal(done2.data.full, 'FAKE_reply');
  // same connection reused → no session/load needed
  assert.ok(!logs.some((l) => l.includes('FAKE_SESSION_LOAD')), 'same connection: no reload');
});

test('worker lost the session: load fails → fresh session + note + re-key', async () => {
  // first turn to establish the connection (and its loadedSessions state)
  const r1 = await post('/turns', { text: 'first' });
  const s1 = sseReader(r1.body);
  await s1.readUntil((f) => f.data.type === 'start');
  await s1.readUntil((f) => f.data.type === 'done');

  // hand the bridge a sessionId the worker never issued — "gone" trips the
  // fake daemon's session/load error (desktop restarted, ACP sessions lost)
  const dead = 'sess_gone_1234';
  const r2 = await post('/turns', { text: 'after restart', sessionId: dead });
  const s2 = sseReader(r2.body);
  const note = await s2.readUntil((f) => f.data.type === 'note');
  assert.match(note.data.text, /gone on the workbuddy worker/);
  assert.match(note.data.text, /earlier context does not carry over/);
  const start2 = await s2.readUntil((f) => f.data.type === 'start');
  assert.match(start2.data.sessionId, /^sess_fake\d+$/);
  assert.notEqual(start2.data.sessionId, dead);
  const done2 = await s2.readUntil((f) => f.data.type === 'done');
  assert.equal(done2.data.full, 'FAKE_reply');
  assert.ok(logs.some((l) => l.includes(`FAKE_SESSION_LOAD:${dead}`)), `logs: ${logs.join(' | ')}`);

  // a third turn rides the NEW id on the same connection — no reload
  const loadCount = logs.filter((l) => l.includes('FAKE_SESSION_LOAD')).length;
  const r3 = await post('/turns', { text: 'third', sessionId: start2.data.sessionId });
  const s3 = sseReader(r3.body);
  const start3 = await s3.readUntil((f) => f.data.type === 'start');
  assert.equal(start3.data.sessionId, start2.data.sessionId);
  await s3.readUntil((f) => f.data.type === 'done');
  assert.equal(logs.filter((l) => l.includes('FAKE_SESSION_LOAD')).length, loadCount, 'no extra session/load');
});

test('images ride as ACP image content blocks', async () => {
  const res = await post('/turns', { text: 'what is this?', images: [PNG_1X1] });
  const sse = sseReader(res.body);
  const done = await sse.readUntil((f) => f.data.type === 'done');
  assert.equal(done.data.full, 'FAKE_saw 1 image(s) (image/png)');
  assert.ok(logs.some((l) => l.includes('FAKE_IMAGE_MIMES:image/png')), `logs: ${logs.join(' | ')}`);
});

test('approval round trip: approval event → POST /approvals/:id → resolveInteraction', async () => {
  const res = await post('/turns', { text: 'APPROVE the write please' });
  const sse = sseReader(res.body);
  const approval = await sse.readUntil((f) => f.data.type === 'approval');
  assert.equal(approval.data.requestId, '9001');
  assert.equal(approval.data.tool, 'write_file');

  const miss = await post('/approvals/nope', { choice: 'once' });
  assert.equal(miss.status, 409);

  const ok = await post('/approvals/9001', { choice: 'always' });
  assert.equal((await ok.json()).ok, true);
  const done = await sse.readUntil((f) => f.data.type === 'done');
  assert.equal(done.data.full, 'FAKE_after_approve');
  // the mapped optionId rode the JSON-RPC response
  assert.ok(logs.some((l) => l.includes('FAKE_RESOLVE:{"outcome":{"outcome":"selected","optionId":"opt_always"}}')), `logs: ${logs.join(' | ')}`);
  const tools = sse.frames.filter((f) => f.data.type === 'tool');
  assert.ok(tools.length >= 2 && tools[0].data.name === 'write_file');
});

test('deny choice maps to the reject_once optionId', async () => {
  const res = await post('/turns', { text: 'APPROVE but deny it' });
  const sse = sseReader(res.body);
  await sse.readUntil((f) => f.data.type === 'approval');
  await post('/approvals/9001', { choice: 'deny' });
  await sse.readUntil((f) => f.data.type === 'done');
  assert.ok(logs.some((l) => l.includes('"optionId":"opt_deny"')), `logs: ${logs.join(' | ')}`);
});

test('failed turn surfaces as an error event', async () => {
  const res = await post('/turns', { text: 'FAIL please' });
  const sse = sseReader(res.body);
  const err = await sse.readUntil((f) => f.data.type === 'error');
  assert.equal(err.data.message, 'FAKE_turn_failed');
});

test('client disconnect mid-turn sends session/cancel; the turn settles as aborted', async () => {
  const r1 = await post('/turns', { text: 'warmup' });
  const s1 = sseReader(r1.body);
  const start1 = await s1.readUntil((f) => f.data.type === 'start');
  await s1.readUntil((f) => f.data.type === 'done');
  const sid = start1.data.sessionId;

  const ac = new AbortController();
  const res = await post('/turns', { text: 'SLOW', sessionId: sid }, {}, ac.signal);
  const sse = sseReader(res.body);
  await sse.readUntil((f) => f.data.type === 'start');
  ac.abort();
  for (let i = 0; i < 40 && !logs.some((l) => l.includes('FAKE_CANCELLED')); i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(logs.some((l) => l.includes('FAKE_CANCELLED')), 'session/cancel must reach the worker');
  assert.ok(logs.some((l) => l.includes('client disconnected mid-turn')));
  for (let i = 0; i < 40 && adapter.listSessions().some((s) => s.sessionId === sid && s.busy); i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(adapter.listSessions().find((s) => s.sessionId === sid)?.busy, false);
});
