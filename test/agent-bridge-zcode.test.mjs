// test/agent-bridge-zcode.test.mjs — the ZCode adapter driven end-to-end
// through the REAL HTTP surface (createBridgeServer) talking to
// test/fake-zcode-server.mjs, a scripted stand-in for the ZCode desktop's
// stdio server (hello line → binary RPC frames, same wire format as the real
// one — see adapters/zcode-server.mjs header). Covers: v4 handshake +
// runtime-preferences auto-answer, createSession/streaming deltas (incl.
// wire-frame fragment reassembly and thinking folds), turn resume, image
// upload (sha256 verified by the fixture), approval round trip, stop/interrupt,
// failed turns, and the title channel. Keeps buffers tiny per low-memory CI.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_ZCODE = join(__dirname, 'fake-zcode-server.mjs');

const { createBridgeServer } = await import('../server.mjs');
const { ZcodeServerAdapter } = await import('../adapters/zcode-server.mjs');

// a 1x1 PNG (70 bytes) — the smallest well-formed image for the upload path
const PNG_1X1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let server;
let adapter;
let port;
let logs;

async function startServer() {
  logs = [];
  adapter = new ZcodeServerAdapter({
    serverCjs: FAKE_ZCODE,
    nodeBin: process.execPath,
    cwd: process.cwd(), // spawn fails as a bare ENOENT on a nonexistent cwd
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
      if (Date.now() - t0 > ms) throw new Error(`timeout waiting for SSE frame; got: ${frames.map((f) => f.data.type).join(',')}`);
      const { value, done } = await reader.read();
      if (value) buf += decoder.decode(value, { stream: true });
      if (done && !hit) throw new Error(`stream ended before expected frame; got: ${frames.map((f) => f.data.type).join(',')}`);
    }
  };
  const cancel = () => { try { reader.cancel().catch(() => {}); } catch (_) {} };
  return { readUntil, cancel, frames };
}

test('explicit agentCommand rides the server child env', async () => {
  await stopServer();
  logs = [];
  adapter = new ZcodeServerAdapter({
    serverCjs: FAKE_ZCODE,
    nodeBin: process.execPath,
    agentCommand: 'fake-agent-cli',
    cwd: process.cwd(),
    log: (m) => logs.push(m),
  });
  server = createBridgeServer({ adapter, agent: 'zcode', version: 'test', log: (m) => logs.push(m) });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); }); });
  const res = await post('/turns', { text: 'hello' });
  const sse = sseReader(res.body);
  await sse.readUntil((f) => f.data.type === 'done');
  assert.ok(logs.some((l) => l.includes('FAKE_AGENT_ENV:fake-agent-cli')), `agentCommand must reach the child env; logs: ${logs.join(' | ')}`);
  assert.ok(logs.some((l) => l.includes('FAKE_AUTHORITY:desktop-attached-remote')), `desktop authority mode must reach the child env; logs: ${logs.join(' | ')}`);
  assert.ok(logs.some((l) => l.includes('FAKE_APP_VERSION:') && !l.includes('FAKE_APP_VERSION:unset')), `the app version must reach the child env; logs: ${logs.join(' | ')}`);
});

test('zcode happy path: handshake → start → streamed deltas (thinking folded) → done with usage', async () => {
  const res = await post('/turns', { text: 'hello there' });
  assert.equal(res.status, 200);
  const sse = sseReader(res.body);
  const start = await sse.readUntil((f) => f.data.type === 'start');
  assert.match(start.data.sessionId, /^sess_fake\d+$/);
  await sse.readUntil((f) => f.data.type === 'done');
  const deltas = sse.frames.filter((f) => f.data.type === 'delta').map((f) => f.data.text).join('');
  assert.ok(deltas.includes('<thinking>'), `reasoning should fold into <thinking>; deltas: ${deltas}`);
  assert.ok(deltas.includes('思考中…'));
  assert.ok(deltas.includes('</thinking>'));
  assert.ok(deltas.includes('FAKE_reply'));
  const done = sse.frames.find((f) => f.data.type === 'done');
  // done.full is the answer alone (thinking excluded)
  assert.equal(done.data.full, 'FAKE_reply');
  assert.deepEqual(done.data.usage, { prompt_tokens: 120, completion_tokens: 45 });
  // the v4 handshake + runtime-preferences auto-answer ran against the child
  assert.ok(logs.some((l) => l.includes('FAKE_PREFS')), 'expected the preferences host-request to be answered');
  assert.ok(logs.some((l) => l.includes('zcode server ready')));
});

test('wire-frame fragments are reassembled (reasoning frame rides two fragments)', async () => {
  const res = await post('/turns', { text: 'hi' });
  const sse = sseReader(res.body);
  await sse.readUntil((f) => f.data.type === 'done');
  const deltas = sse.frames.filter((f) => f.data.type === 'delta').map((f) => f.data.text).join('');
  assert.ok(deltas.includes('思考中…'), 'the fragmented reasoning frame must survive reassembly');
});

test('resume: a second turn with the same sessionId rides sendText (no new session)', async () => {
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
  // usage is a DELTA over the session's cumulative counter — the fixture
  // reports the same cumulative on every turn, so the honest delta is zero.
  assert.deepEqual(done2.data.usage, { prompt_tokens: 0, completion_tokens: 0 });
  assert.ok(logs.some((l) => l.includes('FAKE_CMD:sendText')), 'turn 2 must ride sendText, not createSession');
});

test('image turn: upload against a persisted carrier → refs ride firstInput → model sees it', async () => {
  const res = await post('/turns', { text: 'what is this?', images: [PNG_1X1] });
  const sse = sseReader(res.body);
  const start = await sse.readUntil((f) => f.data.type === 'start');
  assert.match(start.data.sessionId, /^sess_fake\d+$/);
  const done = await sse.readUntil((f) => f.data.type === 'done');
  assert.equal(done.data.full, 'FAKE_saw 1 image(s)');
  // the fixture verified the reassembled bytes against the declared sha256
  assert.ok(logs.some((l) => l.includes('FAKE_CHECKSUM:OK')), `checksum must verify; logs: ${logs.join(' | ')}`);
  // the carrier came from the legacy listSessions (no prior turn in this bridge)
  assert.ok(logs.some((l) => l.includes('FAKE_LISTSESSIONS:' + process.cwd())), 'image carrier resolved via listSessions');
  assert.ok(logs.some((l) => l.includes('FAKE_FIRSTINPUT_ATTACH:1')), 'refs ride the firstInput, not sendText');
  assert.ok(logs.some((l) => l.match(/FAKE_ATTACH_BEGIN:image-1\.png:70:1/)), `one 70-byte chunk expected; logs: ${logs.join(' | ')}`);
});

test('image on a RESUME turn rides sendText attachments against the same session', async () => {
  const r1 = await post('/turns', { text: 'first' });
  const s1 = sseReader(r1.body);
  const start1 = await s1.readUntil((f) => f.data.type === 'start');
  await s1.readUntil((f) => f.data.type === 'done');
  const sid = start1.data.sessionId;

  const r2 = await post('/turns', { text: 'and this?', sessionId: sid, images: [PNG_1X1] });
  const s2 = sseReader(r2.body);
  const start2 = await s2.readUntil((f) => f.data.type === 'start');
  assert.equal(start2.data.sessionId, sid);
  const done2 = await s2.readUntil((f) => f.data.type === 'done');
  assert.equal(done2.data.full, 'FAKE_saw 1 image(s)');
  assert.ok(logs.some((l) => l.includes('FAKE_CHECKSUM:OK')));
});

test('approval round trip: approval event → POST /approvals/:id → resolveInteraction with the mapped optionId', async () => {
  const res = await post('/turns', { text: 'APPROVE the write please' });
  const sse = sseReader(res.body);
  const approval = await sse.readUntil((f) => f.data.type === 'approval');
  assert.equal(approval.data.requestId, 'int_1');
  assert.equal(approval.data.tool, 'Bash');
  assert.equal(approval.data.command, 'rm -rf /tmp/fake');

  const miss = await post('/approvals/nope', { choice: 'once' });
  assert.equal(miss.status, 409); // unknown id → the adapter's sync throw surfaces as 409

  const ok = await post('/approvals/int_1', { choice: 'always' });
  assert.equal((await ok.json()).ok, true);
  const done = await sse.readUntil((f) => f.data.type === 'done');
  assert.equal(done.data.full, 'FAKE_after_approve');
  assert.ok(logs.some((l) => l.includes('FAKE_RESOLVE:{"optionId":"opt_always"}')), `choice must map to the allowAlways optionId; logs: ${logs.join(' | ')}`);
  // the tool trail from after the approval streams as tool events
  const tools = sse.frames.filter((f) => f.data.type === 'tool');
  assert.ok(tools.length >= 1 && tools[0].data.name === 'Bash');
});

test('deny choice maps to the deny optionId', async () => {
  const res = await post('/turns', { text: 'APPROVE but deny it' });
  const sse = sseReader(res.body);
  await sse.readUntil((f) => f.data.type === 'approval');
  await post('/approvals/int_1', { choice: 'deny' });
  await sse.readUntil((f) => f.data.type === 'done');
  assert.ok(logs.some((l) => l.includes('FAKE_RESOLVE:{"optionId":"opt_deny"}')));
});

test('failed turn surfaces as an error event', async () => {
  const res = await post('/turns', { text: 'FAIL please' });
  const sse = sseReader(res.body);
  const err = await sse.readUntil((f) => f.data.type === 'error');
  assert.equal(err.data.message, 'zcode turn failed');
});

test('client disconnect mid-turn sends the stop command; the interrupted turn settles as aborted', async () => {
  const r1 = await post('/turns', { text: 'warmup' });
  const s1 = sseReader(r1.body);
  const start1 = await s1.readUntil((f) => f.data.type === 'start');
  await s1.readUntil((f) => f.data.type === 'done');
  const sid = start1.data.sessionId;

  const ac = new AbortController();
  const res = await post('/turns', { text: 'SLOW', sessionId: sid }, {}, ac.signal);
  const sse = sseReader(res.body);
  await sse.readUntil((f) => f.data.type === 'start');
  ac.abort(); // client gone mid-turn
  // server.mjs notices the disconnect → adapter.interrupt → stop command
  for (let i = 0; i < 40 && !logs.some((l) => l.includes('FAKE_STOPPED')); i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(logs.some((l) => l.includes('FAKE_STOPPED')), 'the stop command must reach the agent');
  assert.ok(logs.some((l) => l.includes('client disconnected mid-turn')));
  // the interrupted frame settles the session as not busy
  for (let i = 0; i < 40 && adapter.listSessions().some((s) => s.sessionId === sid && s.busy); i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(adapter.listSessions().find((s) => s.sessionId === sid)?.busy, false);
});

test('title channel: POST /threads/:id/title rides renameSession', async () => {
  const r1 = await post('/turns', { text: 'name me' });
  const s1 = sseReader(r1.body);
  const start1 = await s1.readUntil((f) => f.data.type === 'start');
  await s1.readUntil((f) => f.data.type === 'done');
  const sid = start1.data.sessionId;

  const res = await post(`/threads/${sid}/title`, { title: 'browsa：测试' });
  assert.equal((await res.json()).ok, true);
  assert.ok(logs.some((l) => l.includes('FAKE_RENAME:browsa：测试')), `logs: ${logs.join(' | ')}`);
});
