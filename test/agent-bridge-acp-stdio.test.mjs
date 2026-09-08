// test/agent-bridge-acp-stdio.test.mjs — the ACP stdio FRONT end to end:
// spawn the REAL cli (`node cli.mjs acp claude --config …`) exactly the way
// an editor would (Zed launching a local agent command), drive ACP v1 over
// its stdin/stdout, and assert the transport contract: stdout carries ONLY
// protocol JSONL (every line parses), all human logs go to stderr, stdin
// end shuts the agent down with exit 0. The adapter behind it is the real
// AcpStdioAdapter driving test/fake-acp-agent.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_ACP = join(__dirname, 'fake-acp-agent.mjs');
const CLI = join(__dirname, '..', 'cli.mjs');
const REPO = join(__dirname, '..');

const { AcpStdioAdapter } = await import('../adapters/acp-stdio.mjs');

chmodSync(FAKE_ACP, 0o755);

const tmp = mkdtempSync(join(tmpdir(), 'ab-acp-stdio-'));
const children = [];
process.on('exit', () => {
  for (const p of children) { try { p.kill('SIGKILL'); } catch (_) {} }
  try { rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
});

// A config WITHOUT ports — legal for acp mode (entries listen on nothing).
const CONFIG = join(tmp, 'agents.json');
writeFileSync(CONFIG, JSON.stringify({ bridges: [{ name: 'claude', command: [FAKE_ACP], cwd: '/tmp' }] }));

function spawnAcp({ extraArgs = ['claude'], config = CONFIG } = {}) {
  const proc = spawn(process.execPath, [CLI, 'acp', ...extraArgs, '--config', config], { cwd: REPO, stdio: ['pipe', 'pipe', 'pipe'] });
  const frames = [];
  const stderr = [];
  let buf = '';
  // ANY unparseable stdout line throws here — which IS the stdout-purity test.
  proc.stdout.on('data', (d) => {
    buf += String(d);
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) frames.push(JSON.parse(line));
    }
  });
  proc.stderr.on('data', (d) => stderr.push(String(d)));
  const wait = async (pred, ms = 5000) => {
    const t0 = Date.now();
    for (;;) {
      const hit = frames.find(pred);
      if (hit) return hit;
      if (Date.now() - t0 > ms) throw new Error('timeout waiting for stdio frame');
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  children.push(proc);
  return {
    proc, frames, stderr, wait,
    send: (o) => proc.stdin.write(JSON.stringify(o) + '\n'),
    end: () => proc.stdin.end(),
    exit: () => new Promise((r) => { if (proc.exitCode !== null) r(proc.exitCode); else proc.on('exit', (code) => r(code)); }),
  };
}

const initialize = (c) => c.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } });

test('spawned as an agent: initialize negotiates v1 and advertises capabilities', async () => {
  const c = spawnAcp();
  initialize(c);
  const init = await c.wait((f) => f.id === 1);
  assert.equal(init.result.protocolVersion, 1);
  assert.equal(init.result.agentCapabilities.promptCapabilities.image, true);
  assert.match(init.result.agentInfo.name, /agent-bridge \(claude\)/);
  c.end();
  assert.equal(await c.exit(), 0);
});

test('session/new → prompt streams deltas, responds with stopReason + usage', async () => {
  const c = spawnAcp();
  initialize(c);
  await c.wait((f) => f.id === 1);
  c.send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: '/ignored', mcpServers: [] } });
  const created = await c.wait((f) => f.id === 2);
  assert.equal(created.result.sessionId, 'acp-sess-1', 'createSession returns the agent-side id');
  c.send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: created.result.sessionId, prompt: [{ type: 'text', text: 'hello' }] } });
  const chunk = await c.wait((f) => f.method === 'session/update' && f.params.update.sessionUpdate === 'agent_message_chunk');
  assert.equal(chunk.params.update.content.text, 'ACP_reply');
  const done = await c.wait((f) => f.id === 3);
  assert.equal(done.result.stopReason, 'end_turn');
  assert.deepEqual(done.result.usage, { inputTokens: 33, outputTokens: 0 });
  c.end();
  assert.equal(await c.exit(), 0);
});

test('permission round trip over stdio: request_permission forwarded, optionId mapped back', async () => {
  const c = spawnAcp();
  initialize(c);
  await c.wait((f) => f.id === 1);
  c.send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: {} });
  const created = await c.wait((f) => f.id === 2);
  c.send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: created.result.sessionId, prompt: [{ type: 'text', text: 'APPROVE it' }] } });
  const perm = await c.wait((f) => f.method === 'session/request_permission');
  assert.equal(perm.params.sessionId, created.result.sessionId);
  assert.equal(perm.params.options.length, 3);
  c.send({ jsonrpc: '2.0', id: perm.id, result: { outcome: { outcome: 'selected', optionId: 'allow-once' } } });
  const done = await c.wait((f) => f.id === 3);
  assert.equal(done.result.stopReason, 'end_turn');
  assert.ok(c.stderr.join('').includes('FAKE_PERMISSION') && c.stderr.join('').includes('allow-once'));
  c.end();
  assert.equal(await c.exit(), 0);
});

test('refusal stopReason and session/cancel both pass through', async () => {
  const c = spawnAcp();
  initialize(c);
  await c.wait((f) => f.id === 1);
  c.send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: {} });
  const created = await c.wait((f) => f.id === 2);
  c.send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: created.result.sessionId, prompt: [{ type: 'text', text: 'FAIL to do it' }] } });
  const refused = await c.wait((f) => f.id === 3);
  assert.equal(refused.result.stopReason, 'refusal');
  c.send({ jsonrpc: '2.0', id: 4, method: 'session/prompt', params: { sessionId: created.result.sessionId, prompt: [{ type: 'text', text: 'SLOW please' }] } });
  await c.wait((f) => f.method === 'session/update' && f.params.update.sessionUpdate === 'agent_message_chunk');
  c.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: created.result.sessionId } });
  const cancelled = await c.wait((f) => f.id === 4);
  assert.equal(cancelled.result.stopReason, 'cancelled');
  assert.ok(c.stderr.join('').includes('FAKE_CANCELLED'));
  c.end();
  assert.equal(await c.exit(), 0);
});

test('transport contract: stdout is pure protocol JSONL, human logs live on stderr', async () => {
  const c = spawnAcp();
  initialize(c);
  await c.wait((f) => f.id === 1);
  c.send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: {} });
  await c.wait((f) => f.id === 2);
  c.end();
  await c.exit();
  // frames[] already proves every stdout line parsed as JSON. The fake's
  // chatter (FAKE_METHOD lines) must be on stderr, never on stdout.
  const errText = c.stderr.join('');
  assert.ok(errText.includes('FAKE_METHOD:initialize'), `agent logs on stderr; got: ${errText.slice(0, 200)}`);
  for (const f of c.frames) assert.equal(typeof f, 'object');
});

test('stdin end shuts the spawned agent down cleanly (exit 0) even mid-turn', async () => {
  const c = spawnAcp();
  initialize(c);
  await c.wait((f) => f.id === 1);
  c.send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: {} });
  const created = await c.wait((f) => f.id === 2);
  c.send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: created.result.sessionId, prompt: [{ type: 'text', text: 'SLOW please' }] } });
  await c.wait((f) => f.method === 'session/update' && f.params.update.sessionUpdate === 'agent_message_chunk');
  c.end(); // editor closed the pipe mid-turn → abort + clean exit
  const code = await c.exit();
  assert.equal(code, 0);
  assert.ok(c.stderr.join('').includes('FAKE_CANCELLED'), 'in-flight turn must be interrupted');
});

test('unknown entry name → exit 1 with a helpful stderr message', async () => {
  const c = spawnAcp({ extraArgs: ['nope'] });
  const code = await c.exit();
  assert.equal(code, 1);
  assert.match(c.stderr.join(''), /no bridge "nope"/);
  assert.match(c.stderr.join(''), /claude/);
});

test('--bind is rejected in acp mode (it opens no port)', async () => {
  const c = spawnAcp({ extraArgs: ['--bind', '127.0.0.1'] });
  const code = await c.exit();
  assert.equal(code, 1);
  assert.match(c.stderr.join(''), /--bind is a serve flag/);
});

// Direct-module sanity: the neutral session + adapter work without the CLI
// too (this is the same path acp-front-ws shares).
test('runAcpStdio drives the adapter over PassThrough streams (test-mode plumbing)', async () => {
  const { PassThrough } = await import('node:stream');
  const adapter = new AcpStdioAdapter({ command: [FAKE_ACP], cwd: '/tmp', log: () => {} });
  const input = new PassThrough();
  const output = new PassThrough();
  const { runAcpStdio } = await import('../acp-front-stdio.mjs');
  const frames = [];
  let buf = '';
  output.on('data', (d) => {
    buf += String(d);
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      frames.push(JSON.parse(buf.slice(0, i)));
      buf = buf.slice(i + 1);
    }
  });
  runAcpStdio({ adapter, agent: 'claude', version: 'test', log: () => {}, input, output });
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
  const t0 = Date.now();
  while (!frames.some((f) => f.id === 1) && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 25));
  assert.equal(frames.find((f) => f.id === 1)?.result.protocolVersion, 1);
  input.end();
  adapter.stop();
});
