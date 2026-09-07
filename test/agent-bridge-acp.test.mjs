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

async function startServer({ command } = {}) {
  logs = [];
  adapter = new AcpStdioAdapter({
    command: command || [FAKE_ACP],
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

test('missing agent command → friendly SSE error, bridge survives (no uncaughtException)', async () => {
  // Same trap as the codex adapter: a typo'd `acp -- <command>` must surface
  // as a clean SSE error (install hint), never an uncaughtException that
  // kills the bridge. This test passing at all proves the crash is gone.
  await stopServer();
  await startServer({ command: ['definitely-not-installed-xyz'] });
  const res = await post('/turns', { text: 'hi' });
  const err = await sseReader(res.body).readUntil((f) => f.data?.type === 'error');
  assert.match(err.data.message, /agent command not found/);
  assert.match(err.data.message, /acp --/);
  // Bridge still alive and retrying errors cleanly.
  const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  assert.equal(health.ok, true);
  const res2 = await post('/turns', { text: 'hi again' });
  const err2 = await sseReader(res2.body).readUntil((f) => f.data?.type === 'error');
  assert.match(err2.data.message, /agent command not found/);
});

test('official-style v1 agent: version negotiation + prompt-response completion with usage', async () => {
  // The OFFICIAL shims (agentclientprotocol/codex-acp, claude-agent-acp) speak
  // protocolVersion 1: initialize negotiates down, there is no prompt ack,
  // and the prompt RPC response IS the turn terminator carrying stopReason
  // and usage (captured live from codex-acp 1.10.0 on 2026-09-07).
  await stopServer();
  await startServer({ command: [FAKE_ACP, 'v1'] });
  const res = await post('/turns', { text: 'hi' });
  const sse = sseReader(res.body);
  await sse.readUntil((f) => f.data?.type === 'start');
  const delta = await sse.readUntil((f) => f.data?.type === 'delta');
  assert.equal(delta.data.text, 'ACP_reply');
  const done = await sse.readUntil((f) => f.data?.type === 'done');
  assert.equal(done.data.full, 'ACP_reply');
  assert.deepEqual(done.data.usage, { prompt_tokens: 8, completion_tokens: 2 });
  sse.cancel();
});

test('v1 agent: cancel settles the turn via the prompt response (stopReason cancelled)', async () => {
  await stopServer();
  await startServer({ command: [FAKE_ACP, 'v1'] });
  const ctrl = new AbortController();
  const res = await post('/turns', { text: 'SLOW please' }, {}, ctrl.signal);
  const sse = sseReader(res.body);
  await sse.readUntil((f) => f.data?.type === 'delta');
  ctrl.abort(); // disconnect = interrupt → session/cancel → the fake answers
  // the pending prompt with stopReason 'cancelled' → the turn must settle.
  const t0 = Date.now();
  while (Date.now() - t0 < 4000) {
    const now = await (await fetch(`http://127.0.0.1:${port}/sessions`)).json();
    if (now.sessions[0]?.busy === false) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const settled = await (await fetch(`http://127.0.0.1:${port}/sessions`)).json();
  assert.equal(settled.sessions[0]?.busy, false, 'v1 turn must settle after cancel');
});

test('v1 wedged shim (never answers the prompt after cancel): interrupt settles locally, follow-up turn works', async () => {
  // Worst case, live-verified against codex-acp 1.10.0: after session/cancel
  // the shim NEVER answers the pending session/prompt rpc — without a local
  // settle the session stays busy:true forever and the next turn dies with
  // "a turn is already in flight for this session".
  await stopServer();
  await startServer({ command: [FAKE_ACP, 'v1'] });
  const ctrl = new AbortController();
  const res = await post('/turns', { text: 'SLOW and HANG please' }, {}, ctrl.signal);
  const sse = sseReader(res.body);
  await sse.readUntil((f) => f.data?.type === 'delta');
  ctrl.abort();
  const t0 = Date.now();
  while (Date.now() - t0 < 4000) {
    const now = await (await fetch(`http://127.0.0.1:${port}/sessions`)).json();
    if (now.sessions[0]?.busy === false) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const settled = await (await fetch(`http://127.0.0.1:${port}/sessions`)).json();
  assert.equal(settled.sessions[0]?.busy, false, 'local settle must free the session even when the shim never answers');
  // follow-up turn on the SAME session must succeed
  const res2 = await post('/turns', { text: 'hi', sessionId: settled.sessions[0].sessionId });
  const sse2 = sseReader(res2.body);
  await sse2.readUntil((f) => f.data?.type === 'start');
  const done2 = await sse2.readUntil((f) => f.data?.type === 'done');
  assert.equal(done2.data.full, 'ACP_reply');
  sse2.cancel();
});
