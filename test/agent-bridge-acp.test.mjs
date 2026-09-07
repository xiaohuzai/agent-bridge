// test/agent-bridge-acp.test.mjs — the generic ACP adapter end-to-end:
// real AcpStdioAdapter spawning test/fake-acp-agent.mjs (a scripted ACP v2
// agent) behind the real HTTP+SSE server. Covers the turn lifecycle, images,
// the permission round trip, and disconnect→cancel.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_ACP = join(__dirname, 'fake-acp-agent.mjs');

const { createBridgeServer } = await import('../server.mjs');
const { AcpStdioAdapter } = await import('../adapters/acp-stdio.mjs');

chmodSync(FAKE_ACP, 0o755);

let server;
let adapter;
let port;
let logs;

async function startServer() {
  logs = [];
  adapter = new AcpStdioAdapter({
    command: [FAKE_ACP],
    cwd: '/tmp',
    log: (m) => logs.push(m),
  });
  server = createBridgeServer({ adapter, agent: 'acp', version: 'test', log: (m) => logs.push(m) });
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

test('turn streams start → delta → done, with usage mapped from usage_update', async () => {
  const res = await post('/turns', { text: 'hello' });
  assert.equal(res.status, 200);
  const sse = sseReader(res.body);
  const start = await sse.readUntil((f) => f.data?.type === 'start');
  assert.equal(start.data.sessionId, 'acp-sess-1', 'session id comes from the ACP agent');
  const done = await sse.readUntil((f) => f.data?.type === 'done');
  const deltas = sse.frames.filter((f) => f.data?.type === 'delta').map((f) => f.data.text);
  assert.equal(deltas.join(''), 'ACP_reply');
  assert.equal(done.data.full, 'ACP_reply');
  assert.equal(done.data.usage.prompt_tokens, 33);
  assert.equal(done.data.finishReason, '');
  sse.cancel();
});

test('images ride through as ACP image content blocks (mimeType preserved)', async () => {
  const res = await post('/turns', {
    text: 'IMG describe',
    images: ['data:image/webp;base64,UklGRhIAAABXRUJQVlA4TAGAAAAAAA=='],
  });
  const sse = sseReader(res.body);
  const done = await sse.readUntil((f) => f.data?.type === 'done');
  assert.match(done.data.full, /IMG:1/);
  assert.match(done.data.full, /MIME:image\/webp/);
  sse.cancel();
});

test('permission round trip: approval event → choice mapped to allow_once', async () => {
  const res = await post('/turns', { text: 'APPROVE it' });
  const sse = sseReader(res.body);
  const approval = await sse.readUntil((f) => f.data?.type === 'approval');
  assert.equal(approval.data.requestId, '900');
  assert.equal(approval.data.tool, 'permission');
  assert.ok(Array.isArray(approval.data.options) && approval.data.options.length === 3, 'agent options echoed for client UIs');
  const ok = await post('/approvals/900', { choice: 'once' });
  assert.equal(ok.status, 200);
  const done = await sse.readUntil((f) => f.data?.type === 'done');
  assert.equal(done.data.full, 'ACP_reply');
  assert.ok(logs.some((l) => l.includes('FAKE_PERMISSION:') && l.includes('"outcome":"selected"') && l.includes('allow-once')), `once must map to allow_once; logs: ${logs.join(' | ')}`);
  sse.cancel();
});

test('always maps to allow_always; deny maps to reject_once', async () => {
  const res = await post('/turns', { text: 'APPROVE it' });
  const sse = sseReader(res.body);
  await sse.readUntil((f) => f.data?.type === 'approval');
  await post('/approvals/900', { choice: 'always' });
  await sse.readUntil((f) => f.data?.type === 'done');
  assert.ok(logs.some((l) => l.includes('allow-always')), 'always → allow_always');
  sse.cancel();

  const res2 = await post('/turns', { text: 'APPROVE it again' });
  const sse2 = sseReader(res2.body);
  await sse2.readUntil((f) => f.data?.type === 'approval');
  await post('/approvals/900', { choice: 'deny' });
  await sse2.readUntil((f) => f.data?.type === 'done');
  assert.ok(logs.some((l) => l.includes('reject-once')), 'deny → reject_once');
  sse2.cancel();
});

test('client disconnect mid-turn cancels the ACP session', async () => {
  const ctrl = new AbortController();
  const res = await post('/turns', { text: 'SLOW please' }, {}, ctrl.signal);
  const sse = sseReader(res.body);
  await sse.readUntil((f) => f.data?.type === 'delta');
  ctrl.abort();
  const t0 = Date.now();
  while (Date.now() - t0 < 4000) {
    if (logs.some((l) => l.includes('FAKE_CANCELLED'))) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(logs.some((l) => l.includes('FAKE_CANCELLED')), `fake agent must receive session/cancel; logs: ${logs.join(' | ')}`);
});

test('refusal stopReason surfaces as a normal done with the failure visible', async () => {
  const res = await post('/turns', { text: 'FAIL to do it' });
  const sse = sseReader(res.body);
  const failedTool = await sse.readUntil((f) => f.data?.type === 'tool' && f.data.status === 'failed');
  assert.equal(failedTool.data.name, 'tool');
  const done = await sse.readUntil((f) => f.data?.type === 'done');
  assert.equal(done.data.finishReason, '');
  sse.cancel();
});
