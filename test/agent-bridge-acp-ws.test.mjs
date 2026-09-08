// test/agent-bridge-acp-ws.test.mjs — the ACP-over-WebSocket FRONT, end to
// end: a hand-rolled WS test client (test/ws-client.mjs) drives the real
// acp-front-ws attach on a real createBridgeServer http.Server, behind which
// the real AcpStdioAdapter spawns test/fake-acp-agent.mjs. Covers handshake
// auth (same token + Host rules as v1), the ACP v1 session lifecycle
// (initialize / session/new / prompt-with-usage-on-response), the permission
// round trip, tool mapping, images, cancel, close-mid-turn interrupt, and
// restart-resume via session/load. v1 (server.mjs) is pinned untouched: a
// bridge WITHOUT the opt-in destroys upgrades, and GET /acp falls to 404.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_ACP = join(__dirname, 'fake-acp-agent.mjs');

const { createBridgeServer } = await import('../server.mjs');
const { attachAcpFront } = await import('../acp-front-ws.mjs');
const { AcpStdioAdapter } = await import('../adapters/acp-stdio.mjs');
const { wsConnect } = await import('./ws-client.mjs');

chmodSync(FAKE_ACP, 0o755);

let bridge = null;
let front = null;
let port = 0;
let logs = [];
const clients = [];

async function startBridge({ token, attach = true, command } = {}) {
  logs = [];
  const adapter = new AcpStdioAdapter({ command: command || [FAKE_ACP], cwd: '/tmp', log: (m) => logs.push(m) });
  const server = createBridgeServer({ adapter, agent: 'acp', version: 'test', token, log: (m) => logs.push(m) });
  if (attach) {
    front = attachAcpFront(server, { adapter, agent: 'acp', version: 'test', token, bindAddress: '127.0.0.1', log: (m) => logs.push(m) });
  }
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  bridge = { adapter, server };
}

afterEach(async () => {
  for (const c of clients) { try { c.socket.destroy(); } catch (_) {} }
  clients.length = 0;
  if (front) { try { front.dispose(); } catch (_) {} front = null; }
  if (bridge) {
    try { bridge.adapter.stop(); } catch (_) {}
    const s = bridge.server;
    bridge = null;
    s.closeAllConnections?.();
    await new Promise((r) => s.close(() => r()));
  }
});

const text = (f) => (f && f.type === 'text' ? f.msg : null);
const update = (f, name) => text(f)?.method === 'session/update' && text(f)?.params?.update?.sessionUpdate === name ? text(f).params : null;

/** Open a client and complete the initialize handshake. */
async function openAcpClient({ auth, host } = {}) {
  const ws = await wsConnect({ port, auth, host });
  clients.push(ws);
  await ws.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } });
  const init = await ws.recv((f) => text(f)?.id === 1);
  return { ws, init: init.msg };
}

async function newSession(ws) {
  await ws.send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: '/ignored', mcpServers: [] } });
  const r = await ws.recv((f) => text(f)?.id === 2);
  return r.msg.result.sessionId;
}

// --- handshake & auth ------------------------------------------------------

test('handshake: correct token upgrades; missing/wrong token → 401; non-loopback Host on loopback bind → 403', async () => {
  await startBridge({ token: 'sekrit' });
  const good = await wsConnect({ port, auth: 'sekrit' });
  clients.push(good);
  assert.equal(good.ok, true);
  good.close();

  const noAuth = await wsConnect({ port });
  assert.equal(noAuth.ok, false);
  assert.equal(noAuth.status, 401);

  const badAuth = await wsConnect({ port, auth: 'wrong' });
  assert.equal(badAuth.ok, false);
  assert.equal(badAuth.status, 401);

  const evil = await wsConnect({ port, auth: 'sekrit', host: 'evil.example.com' });
  assert.equal(evil.ok, false);
  assert.equal(evil.status, 403, 'same DNS-rebinding guard as v1');
});

test('handshake: keyless bridge on loopback upgrades without auth', async () => {
  await startBridge({});
  const ws = await wsConnect({ port });
  clients.push(ws);
  assert.equal(ws.ok, true);
});

test('initialize → protocolVersion 1, image capability advertised, agentInfo names the bridge', async () => {
  await startBridge({});
  const { ws, init } = await openAcpClient();
  assert.equal(init.result.protocolVersion, 1);
  assert.equal(init.result.agentCapabilities.promptCapabilities.image, true);
  assert.match(init.result.agentInfo.name, /agent-bridge \(acp\)/);
  ws.close();
});

// --- session lifecycle -------------------------------------------------------

test('session/new returns a real id; prompt streams deltas then answers with stopReason + usage', async () => {
  await startBridge({});
  const { ws } = await openAcpClient();
  const sid = await newSession(ws);
  assert.equal(sid, 'acp-sess-1', 'createSession returns the agent-side id (restart-resumable)');

  await ws.send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: sid, prompt: [{ type: 'text', text: 'hello' }] } });
  const chunk = await ws.recv((f) => update(f, 'agent_message_chunk'));
  assert.equal(chunk.msg.params.update.content.text, 'ACP_reply');
  const done = await ws.recv((f) => text(f)?.id === 3);
  assert.equal(done.msg.result.stopReason, 'end_turn');
  assert.deepEqual(done.msg.result.usage, { inputTokens: 33, outputTokens: 0 }, 'usage rides the prompt response (v1)');
  ws.close();
});

test('images ride through as data: URLs and reach the agent', async () => {
  await startBridge({});
  const { ws } = await openAcpClient();
  const sid = await newSession(ws);
  await ws.send({
    jsonrpc: '2.0', id: 3, method: 'session/prompt',
    params: { sessionId: sid, prompt: [
      { type: 'text', text: 'IMG look' },
      { type: 'image', data: 'UklGRhIAAABXRUJQVlA4TAGAAAAAAA==', mimeType: 'image/webp' },
    ] },
  });
  const chunk = await ws.recv((f) => update(f, 'agent_message_chunk'));
  assert.match(chunk.msg.params.update.content.text, /IMG:1/);
  assert.match(chunk.msg.params.update.content.text, /MIME:image\/webp/);
  await ws.recv((f) => text(f)?.id === 3);
  ws.close();
});

test('tool events map to tool_call_update; refusal stopReason passes through', async () => {
  await startBridge({});
  const { ws } = await openAcpClient();
  const sid = await newSession(ws);
  await ws.send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: sid, prompt: [{ type: 'text', text: 'FAIL to do it' }] } });
  const tool = await ws.recv((f) => update(f, 'tool_call_update') && f.msg.params.update.status === 'failed');
  assert.equal(tool.msg.params.update.status, 'failed');
  assert.ok(tool.msg.params.update.toolCallId, 'synthesized toolCallId');
  const done = await ws.recv((f) => text(f)?.id === 3);
  assert.equal(done.msg.result.stopReason, 'refusal');
  ws.close();
});

// --- permissions -------------------------------------------------------------

test('permission round trip: request_permission forwarded, client optionId mapped back by kind', async () => {
  await startBridge({});
  const { ws } = await openAcpClient();
  const sid = await newSession(ws);
  await ws.send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: sid, prompt: [{ type: 'text', text: 'APPROVE it' }] } });
  const perm = await ws.recv((f) => text(f)?.method === 'session/request_permission');
  assert.equal(perm.msg.params.sessionId, sid);
  assert.equal(perm.msg.params.toolCall.title, 'run sensitive op');
  assert.equal(perm.msg.params.options.length, 3, "the agent's own options are echoed");
  ws.send({ jsonrpc: '2.0', id: perm.msg.id, result: { outcome: { outcome: 'selected', optionId: 'allow-once' } } });
  const done = await ws.recv((f) => text(f)?.id === 3);
  assert.equal(done.msg.result.stopReason, 'end_turn');
  assert.ok(logs.some((l) => l.includes('FAKE_PERMISSION') && l.includes('allow-once')), `once must reach the agent as allow-once; logs: ${logs.join(' | ')}`);
  ws.close();
});

test('reject optionId maps to deny (reject-once reaches the agent)', async () => {
  await startBridge({});
  const { ws } = await openAcpClient();
  const sid = await newSession(ws);
  await ws.send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: sid, prompt: [{ type: 'text', text: 'APPROVE it' }] } });
  const perm = await ws.recv((f) => text(f)?.method === 'session/request_permission');
  ws.send({ jsonrpc: '2.0', id: perm.msg.id, result: { outcome: { outcome: 'selected', optionId: 'reject-once' } } });
  await ws.recv((f) => text(f)?.id === 3);
  assert.ok(logs.some((l) => l.includes('reject-once')), `logs: ${logs.join(' | ')}`);
  ws.close();
});

test('client-cancelled permission outcome → deny', async () => {
  await startBridge({});
  const { ws } = await openAcpClient();
  const sid = await newSession(ws);
  await ws.send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: sid, prompt: [{ type: 'text', text: 'APPROVE it' }] } });
  const perm = await ws.recv((f) => text(f)?.method === 'session/request_permission');
  ws.send({ jsonrpc: '2.0', id: perm.msg.id, result: { outcome: { outcome: 'cancelled' } } });
  await ws.recv((f) => text(f)?.id === 3);
  assert.ok(logs.some((l) => l.includes('FAKE_PERMISSION') && l.includes('reject-once')), `cancelled must map to deny; logs: ${logs.join(' | ')}`);
  ws.close();
});

// --- cancel / disconnect -------------------------------------------------------

test('session/cancel notification settles the turn with stopReason cancelled', async () => {
  await startBridge({});
  const { ws } = await openAcpClient();
  const sid = await newSession(ws);
  await ws.send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: sid, prompt: [{ type: 'text', text: 'SLOW please' }] } });
  await ws.recv((f) => update(f, 'agent_message_chunk'));
  ws.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: sid } });
  const done = await ws.recv((f) => text(f)?.id === 3);
  assert.equal(done.msg.result.stopReason, 'cancelled');
  assert.ok(logs.some((l) => l.includes('FAKE_CANCELLED')));
  ws.close();
});

test('WS close mid-turn interrupts the agent turn (disconnect = abort)', async () => {
  await startBridge({});
  const { ws } = await openAcpClient();
  const sid = await newSession(ws);
  await ws.send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: sid, prompt: [{ type: 'text', text: 'SLOW please' }] } });
  await ws.recv((f) => update(f, 'agent_message_chunk'));
  ws.close();
  const t0 = Date.now();
  while (Date.now() - t0 < 4000) {
    if (logs.some((l) => l.includes('FAKE_CANCELLED'))) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(logs.some((l) => l.includes('FAKE_CANCELLED')), `close must cancel the in-flight turn; logs: ${logs.join(' | ')}`);
});

// --- resume & errors -------------------------------------------------------------

test('session/load adopts an id from a previous bridge lifetime; the next prompt resumes it', async () => {
  await startBridge({});
  const { ws } = await openAcpClient();
  // No session/new — a client reconnecting after a BRIDGE RESTART only knows
  // the old id. session/load must adopt it so the prompt resumes.
  await ws.send({ jsonrpc: '2.0', id: 2, method: 'session/load', params: { sessionId: 'acp-sess-1', cwd: '/ignored', mcpServers: [] } });
  const loaded = await ws.recv((f) => text(f)?.id === 2);
  assert.deepEqual(loaded.msg.result, {});
  await ws.send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: 'acp-sess-1', prompt: [{ type: 'text', text: 'hello again' }] } });
  const chunk = await ws.recv((f) => update(f, 'agent_message_chunk'));
  assert.equal(chunk.msg.params.update.content.text, 'ACP_reply');
  assert.ok(logs.some((l) => l.includes('session resumed')), `adapter must take the session/resume path; logs: ${logs.join(' | ')}`);
  ws.close();
});

test('prompt on an unknown id adopts it, but a genuinely dead agent surfaces as an error response', async () => {
  // Admission failure path (same trap as v1): the agent command isn't
  // installed → the turn errors cleanly over WS, never an uncaughtException.
  await startBridge({ command: ['definitely-not-installed-xyz'] });
  const { ws } = await openAcpClient();
  await ws.send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: 'not-a-real-session', prompt: [{ type: 'text', text: 'hi' }] } });
  const err = await ws.recv((f) => text(f)?.id === 3 && text(f)?.error);
  assert.match(err.msg.error.message, /agent command not found/);
  // The connection and bridge survive; the front can still answer rpcs.
  await ws.send({ jsonrpc: '2.0', id: 5, method: 'initialize', params: {} });
  const init = await ws.recv((f) => text(f)?.id === 5);
  assert.equal(init.msg.result.protocolVersion, 1);
  ws.close();
});

test('>8 images rejected (same bound as the v1 wire)', async () => {
  await startBridge({});
  const { ws } = await openAcpClient();
  const sid = await newSession(ws);
  const images = Array.from({ length: 9 }, () => ({ type: 'image', data: 'aGk=', mimeType: 'image/png' }));
  await ws.send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: sid, prompt: [{ type: 'text', text: 'too many' }, ...images] } });
  const err = await ws.recv((f) => text(f)?.id === 3 && text(f)?.error);
  assert.match(err.msg.error.message, /≤8/);
  ws.close();
});

test('unknown rpc method → -32601', async () => {
  await startBridge({});
  const { ws } = await openAcpClient();
  await ws.send({ jsonrpc: '2.0', id: 5, method: 'fs/read_text_file', params: { path: '/etc/passwd' } });
  const err = await ws.recv((f) => text(f)?.id === 5);
  assert.equal(err.msg.error.code, -32601);
  ws.close();
});

// --- v1 safety pins ---------------------------------------------------------------

test('a bridge WITHOUT the acp opt-in never upgrades (v1 stays byte-identical)', async () => {
  await startBridge({ attach: false });
  // No 'upgrade' listener → the request falls through to the v1 handler,
  // which answers its own plain-HTTP 404; no 101 ever happens.
  const res = await wsConnect({ port });
  assert.equal(res.ok, false);
  assert.equal(res.status, 404);
});

test('plain GET /acp (no upgrade) falls through to the v1 404', async () => {
  await startBridge({});
  const res = await fetch(`http://127.0.0.1:${port}/acp`);
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error, 'not found');
});
