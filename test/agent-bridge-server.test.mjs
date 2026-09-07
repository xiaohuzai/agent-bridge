// test/agent-bridge-server.test.mjs — the agent-bridge HTTP surface (wire
// protocol v1) driven end-to-end through the REAL CodexAppServerAdapter
// talking to test/fake-codex-app-server.mjs (a scripted `codex app-server`
// stand-in), so spawn/JSONL framing, SSE streaming, approval relay, the
// sessions listing, CORS handling, and the disconnect→interrupt path are all
// exercised without a real codex install.
//
// Keeps buffers tiny (a few dozen bytes per event) per low-memory CI boxes.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_CODEX = join(__dirname, 'fake-codex-app-server.mjs');

const { createBridgeServer } = await import('../server.mjs');
const { CodexAppServerAdapter } = await import('../adapters/codex-app-server.mjs');

chmodSync(FAKE_CODEX, 0o755);

let server;
let adapter;
let port;
let logs;

async function startServer({ token, corsOrigin } = {}) {
  logs = [];
  // spawn() honors shebangs on Linux, so the fake script itself is the binary.
  adapter = new CodexAppServerAdapter({
    codexBin: FAKE_CODEX,
    log: (m) => logs.push(m),
  });
  server = createBridgeServer({ adapter, agent: 'codex', version: 'test', token, corsOrigin, log: (m) => logs.push(m) });
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
  // SSE responses we deliberately left open (aborted tests) would otherwise
  // keep server.close() pending forever.
  s.closeAllConnections?.();
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
  const readUntil = async (pred, ms = 5000) => {
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
      if (Date.now() - t0 > ms) throw new Error('timeout waiting for SSE frame');
      const { value, done } = await reader.read();
      if (value) buf += decoder.decode(value, { stream: true });
      if (done && !hit) throw new Error('stream ended before expected frame');
    }
  };
  const cancel = () => { try { reader.cancel().catch(() => {}); } catch (_) {} };
  return { readUntil, cancel, frames };
}

test('GET /health returns ok + agent + proto', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/health`);
  const j = await res.json();
  assert.equal(res.status, 200);
  assert.equal(j.ok, true);
  assert.equal(j.agent, 'codex');
  assert.equal(j.proto, 1);
});

test('security: non-loopback Host header is rejected with 403', async () => {
  // fetch() ignores a hand-set Host header (forbidden header) — use raw http.
  const status = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/health', headers: { Host: 'evil.example.com' }, method: 'GET' }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 403);
});

test('security: bearer token enforced when configured', async () => {
  await stopServer();
  await startServer({ token: 'sekrit' });
  const bad = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(bad.status, 401);
  const good = await fetch(`http://127.0.0.1:${port}/health`, { headers: { Authorization: 'Bearer sekrit' } });
  assert.equal(good.status, 200);
});

test('turn streams start → deltas → done with full text and usage', async () => {
  const res = await post('/turns', { text: 'Reply with exactly: FAKE_reply' });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/event-stream/);
  const sse = sseReader(res.body);
  const start = await sse.readUntil((f) => f.data?.type === 'start');
  assert.equal(start.data.sessionId, 'thread-fake-1', 'first turn assigns a session id');
  const done = await sse.readUntil((f) => f.data?.type === 'done');
  const deltas = sse.frames.filter((f) => f.data?.type === 'delta').map((f) => f.data.text);
  assert.equal(deltas.join(''), 'FAKE_reply');
  assert.equal(done.data.full, 'FAKE_reply');
  assert.equal(done.data.usage.prompt_tokens, 21);
  sse.cancel();
});

test('session continuity: a passed sessionId is reused (thread/resume path)', async () => {
  const res1 = await post('/turns', { text: 'hi' });
  const sse1 = sseReader(res1.body);
  const start1 = await sse1.readUntil((f) => f.data?.type === 'start');
  const sid = start1.data.sessionId;
  await sse1.readUntil((f) => f.data?.type === 'done');
  const res2 = await post('/turns', { text: 'hi again', sessionId: sid });
  const sse2 = sseReader(res2.body);
  const start2 = await sse2.readUntil((f) => f.data?.type === 'start');
  assert.equal(start2.data.sessionId, sid, 'same session id comes back');
  await sse2.readUntil((f) => f.data?.type === 'done');
  sse2.cancel();
});

test('approval round trip: approval event → POST /approvals/:id → done', async () => {
  const res = await post('/turns', { text: 'APPROVE the write please' });
  const sse = sseReader(res.body);
  const approval = await sse.readUntil((f) => f.data?.type === 'approval');
  assert.equal(approval.data.requestId, '900');
  assert.equal(approval.data.tool, 'command');
  assert.match(approval.data.command, /rm -rf \/tmp\/x/);
  const miss = await post('/approvals/nope', { choice: 'once' });
  assert.equal(miss.status, 409, 'unknown approval id → 409');
  const bad = await post('/approvals/900', { choice: 'sometimes' });
  assert.equal(bad.status, 400, 'invalid choice → 400');
  const ok = await post('/approvals/900', { choice: 'once' });
  assert.equal(ok.status, 200);
  const toolDone = await sse.readUntil((f) => f.data?.type === 'tool' && f.data.status === 'completed');
  assert.equal(toolDone.data.name, 'command');
  const done = await sse.readUntil((f) => f.data?.type === 'done');
  assert.equal(done.data.full, 'FAKE_reply');
  assert.ok(logs.some((l) => l.includes('FAKE_APPROVAL_DECISION:accept')), `bridge must map once→accept (v2 vocabulary); logs: ${logs.join(' | ')}`);
  sse.cancel();
});

test('client disconnect mid-turn interrupts the agent turn', async () => {
  // undici's reader.cancel() does NOT tear the socket down on a still-open
  // SSE body — abort the fetch SIGNAL, which destroys the request server-side
  // and fires the bridge's res 'close' handler.
  const ctrl = new AbortController();
  const res = await post('/turns', { text: 'SLOW please' }, {}, ctrl.signal);
  const sse = sseReader(res.body);
  await sse.readUntil((f) => f.data?.type === 'delta');
  ctrl.abort();
  const t0 = Date.now();
  while (Date.now() - t0 < 4000) {
    if (logs.some((l) => l.includes('FAKE_INTERRUPTED'))) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(logs.some((l) => l.includes('client disconnected mid-turn')), `expected disconnect log; logs: ${logs.join(' | ')}`);
  assert.ok(logs.some((l) => l.includes('FAKE_INTERRUPTED')), `fake codex must receive turn/interrupt; logs: ${logs.join(' | ')}`);
});

test('agent failure surfaces as an SSE error event', async () => {
  const res = await post('/turns', { text: 'FAIL now' });
  const sse = sseReader(res.body);
  const err = await sse.readUntil((f) => f.data?.type === 'error');
  assert.match(err.data.message, /Missing environment variable/);
  sse.cancel();
});

test('images ride through to the agent input (data: URLs, no temp files)', async () => {
  const res = await post('/turns', {
    text: 'what is this?',
    images: ['data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='],
  });
  const sse = sseReader(res.body);
  const done = await sse.readUntil((f) => f.data?.type === 'done');
  assert.match(done.data.full, /IMAGES:1/, 'fake codex must report the image count');
  assert.match(done.data.full, /URL:data:image\/png;base64,/, 'the data: URL must survive intact');
  sse.cancel();
});

test('images: invalid shapes are rejected with 400 (non-array, non-string, >8)', async () => {
  for (const images of ['nope', [42], new Array(9).fill('data:image/png;base64,AA==')]) {
    const res = await post('/turns', { text: 'x', images });
    assert.equal(res.status, 400, `images=${JSON.stringify(images).slice(0, 30)} must be a 400`);
  }
  const ok = await post('/turns', { text: 'x', images: [] });
  assert.equal(ok.status, 200, 'empty images array is valid');
  ok.body?.cancel?.();
});

test('POST /turns without text → 400; unknown path → 404', async () => {
  const bad = await post('/turns', {});
  assert.equal(bad.status, 400);
  const nf = await fetch(`http://127.0.0.1:${port}/nope`);
  assert.equal(nf.status, 404);
});

test('CORS: loopback origins are reflected, foreign origins get no ACAO header', async () => {
  const local = await fetch(`http://127.0.0.1:${port}/health`, { headers: { Origin: 'http://localhost:3000' } });
  assert.equal(local.headers.get('access-control-allow-origin'), 'http://localhost:3000');
  const loopbackIp = await fetch(`http://127.0.0.1:${port}/health`, { headers: { Origin: 'https://127.0.0.1:5173' } });
  assert.equal(loopbackIp.headers.get('access-control-allow-origin'), 'https://127.0.0.1:5173');
  const evil = await fetch(`http://127.0.0.1:${port}/health`, { headers: { Origin: 'https://evil.example.com' } });
  assert.equal(evil.headers.get('access-control-allow-origin'), null, 'non-loopback origin must NOT get an ACAO header');
});

test('CORS: OPTIONS preflight answered without auth, 204 + allow headers', async () => {
  const pre = await fetch(`http://127.0.0.1:${port}/turns`, {
    method: 'OPTIONS',
    headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type, authorization' },
  });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  assert.match(pre.headers.get('access-control-allow-headers') || '', /authorization/i);
  assert.match(pre.headers.get('access-control-allow-methods') || '', /POST/);
});

test('CORS: corsOrigin "*" opens every origin (pair with a token in real use)', async () => {
  await stopServer();
  await startServer({ corsOrigin: '*' });
  const res = await fetch(`http://127.0.0.1:${port}/health`, { headers: { Origin: 'https://anywhere.example.com' } });
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
});

test('GET /sessions lists known sessions and live busy state', async () => {
  // Empty before any turn.
  const empty = await (await fetch(`http://127.0.0.1:${port}/sessions`)).json();
  assert.deepEqual(empty.sessions, []);
  // A completed turn leaves its session listed, not busy.
  const res1 = await post('/turns', { text: 'hi' });
  const sse1 = sseReader(res1.body);
  const start1 = await sse1.readUntil((f) => f.data?.type === 'start');
  await sse1.readUntil((f) => f.data?.type === 'done');
  const after = await (await fetch(`http://127.0.0.1:${port}/sessions`)).json();
  assert.deepEqual(after.sessions, [{ sessionId: start1.data.sessionId, busy: false }]);
  // A slow turn shows busy:true, and back to false after the interrupt.
  const ctrl = new AbortController();
  const res2 = await post('/turns', { text: 'SLOW please', sessionId: start1.data.sessionId }, {}, ctrl.signal);
  const sse2 = sseReader(res2.body);
  await sse2.readUntil((f) => f.data?.type === 'delta');
  const busy = await (await fetch(`http://127.0.0.1:${port}/sessions`)).json();
  assert.deepEqual(busy.sessions, [{ sessionId: start1.data.sessionId, busy: true }]);
  ctrl.abort();
  const t0 = Date.now();
  while (Date.now() - t0 < 4000) {
    const now = await (await fetch(`http://127.0.0.1:${port}/sessions`)).json();
    if (now.sessions[0]?.busy === false) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const settled = await (await fetch(`http://127.0.0.1:${port}/sessions`)).json();
  assert.equal(settled.sessions[0].busy, false, 'after abort the session must settle to busy:false');
});
