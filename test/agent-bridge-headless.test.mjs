// test/agent-bridge-headless.test.mjs — the headless-CLI adapter (the
// profile-driven transport borrowed from Orca's agent table) driven through
// the REAL HTTP surface against test/fake-zcode-cli.mjs, which speaks the
// JSONL envelope captured live from ZCode 0.17.0 on 2026-10-21. Covers the
// ZCode profile end to end: streaming deltas, usage/cache mapping, tool rows,
// thinking fences, --resume wiring, mode preselection, image degradation, the
// missing-binary and failed-turn errors, and disconnect → kill.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

async function startServer({ mode, command, env = {}, cwdOverride } = {}) {
  logs = [];
  logFile = join(tmpdir(), `fake-zcode-${randomUUID()}.json`);
  adapter = new HeadlessCliAdapter({
    profile: 'zcode',
    command: command || [process.execPath, FAKE_ZCODE],
    cwd: cwdOverride || process.cwd(),
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

// ─── 2026-10-22 audit regressions (repro-verified before the fix) ──────────────

test('ACP front: usage rides the done event and image support is NOT advertised', async () => {
  const { createAcpFrontSession } = await import('../acp-front.mjs');
  const out = [];
  const front = createAcpFrontSession({
    adapter, agent: 'zcode', version: 'test', log: () => {},
    wire: { send: (o) => out.push(o), close: () => {} }, onClosed: () => {},
  });
  front.handleMessage(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));
  assert.equal(out[0].result.agentCapabilities.promptCapabilities.image, false,
    'headless degrades images to a note — advertising image support would lie to ACP clients');
  front.handleMessage(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'session/new', params: {} }));
  const sid = out.find((m) => m.id === 2).result.sessionId;
  front.handleMessage(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: sid, prompt: [{ type: 'text', text: 'PONG' }] } }));
  await new Promise((r) => setTimeout(r, 1500));
  const resp = out.find((m) => m.id === 3);
  assert.equal(resp.result.usage.inputTokens, 100, 'the ACP front maps usage ONLY from the done event');
  assert.equal(resp.result.usage.outputTokens, 3);
});

test('the admission timer is cleared once the turn settles (no dangling event-loop hold)', async () => {
  const timeoutCount = () => process.getActiveResourcesInfo().filter((x) => x === 'Timeout').length;
  const before = timeoutCount();
  const res = await post('/turns', { text: 'PONG' });
  const sse = sseReader(res.body);
  await sse.readUntil((f) => f.data.type === 'done');
  await new Promise((r) => setTimeout(r, 60)); // let the admission race's finally run
  const after = timeoutCount();
  assert.ok(after <= before, `dangling Timeout after done (before=${before}, after=${after}) — the 15s admission timer must be cleared`);
});

// ─── CLI resolution chain (2026-10-22: the Windows desktop tree has NO CLI —
// the app bundles resources/glm/zcode.cjs, run on the app's own Electron in
// ELECTRON_RUN_AS_NODE mode; verified live from WSL interop: --version →
// 0.17.0. The old single Linux fallback made every Windows bridge die with
// "agent binary not found".) ────────────────────────────────────────────────────

test('zcodeFallbackCandidates: the desktop-app bundle shapes per platform', async () => {
  const { zcodeFallbackCandidates } = await import('../adapters/headless-cli.mjs');
  const { mkdirSync, writeFileSync } = await import('node:fs');

  const mkApp = (root, { exeRel, cjsRel, providerRel }) => {
    mkdirSync(join(root, dirname(exeRel)), { recursive: true });
    mkdirSync(join(root, dirname(cjsRel)), { recursive: true });
    writeFileSync(join(root, exeRel), 'x');
    writeFileSync(join(root, cjsRel), 'x');
    if (providerRel) {
      mkdirSync(join(root, dirname(providerRel)), { recursive: true });
      writeFileSync(join(root, providerRel), '{}');
    }
  };
  const t1 = mkdtempSync(join(tmpdir(), 'ab-zc-win'));
  mkApp(t1, { exeRel: 'ZCode/ZCode.exe', cjsRel: 'ZCode/resources/glm/zcode.cjs', providerRel: 'ZCode/resources/config/provider/zcode-builtin.json' });
  // Windows follows the same zero-config rule: the bridge's own node runs the
  // CLI (no Electron flag, no Terminal flashes), with the app's provider
  // catalog pointed in.
  writeFileSync(join(t1, 'ZCode', 'resources', 'glm', 'zcode.cjs'),
    "if (process.argv.includes('--version')) { console.log('0.17.0'); }\n");
  const win = zcodeFallbackCandidates({ programDirs: [t1], platform: 'win32' });
  assert.equal(win.length, 1);
  assert.equal(win[0].bin, process.execPath, 'the bridge node runs the CLI — no user config');
  assert.match(win[0].prefix[0], /resources[\\/]glm[\\/]zcode\.cjs$/);
  assert.equal(win[0].envPatch.ELECTRON_RUN_AS_NODE, undefined, 'a real node needs no Electron flag');
  assert.match(win[0].envPatch.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, /zcode-builtin\.json$/, 'the app-bundle CLI needs the app\'s provider catalog');

  const t2 = mkdtempSync(join(tmpdir(), 'ab-zc-mac'));
  mkApp(t2, { exeRel: 'MacOS/ZCode', cjsRel: 'Resources/glm/zcode.cjs', providerRel: null });
  // darwin expects roots shaped like "<…>/ZCode.app/Contents" — t2 plays Contents
  const mac = zcodeFallbackCandidates({ programDirs: [t2], platform: 'darwin' });
  assert.equal(mac.length, 1);
  assert.match(mac[0].bin, /MacOS[\\/]ZCode$/);
  assert.equal(mac[0].envPatch.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, undefined, 'no catalog file → no env patch for it');

  // macOS: the bridge's OWN node is preferred (zero user setup) — the GUI
  // launcher makes the CLI's child spawns flash Terminal windows, and a
  // non-node "runtime" file would crash it.
  const t2b = mkdtempSync(join(tmpdir(), 'ab-zc-mac-node'));
  mkApp(t2b, { exeRel: 'MacOS/ZCode', cjsRel: 'Resources/glm/zcode.cjs', providerRel: null });
  // The fake CLI must answer `--version` — candidates are PROVEN by running
  // `<node> <cjs> --version`, never by existence.
  writeFileSync(join(t2b, 'Resources', 'glm', 'zcode.cjs'),
    "if (process.argv.includes('--version')) { console.log('0.17.0'); }\n");
  const macNode = zcodeFallbackCandidates({ programDirs: [t2b], platform: 'darwin' });
  assert.equal(macNode.length, 1);
  assert.equal(macNode[0].bin, process.execPath, 'must use the node running the bridge — no user config');
  assert.equal(macNode[0].envPatch.ELECTRON_RUN_AS_NODE, undefined, 'a real node needs no Electron flag');

  // A bundle whose CLI cannot run under any node falls back to the GUI launcher.
  const t2c = mkdtempSync(join(tmpdir(), 'ab-zc-mac-broken'));
  mkApp(t2c, { exeRel: 'MacOS/ZCode', cjsRel: 'Resources/glm/zcode.cjs', providerRel: null });
  writeFileSync(join(t2c, 'Resources', 'glm', 'zcode.cjs'), 'process.exit(3);\n');
  const macBroken = zcodeFallbackCandidates({ programDirs: [t2c], platform: 'darwin' });
  assert.match(macBroken[0].bin, /MacOS[\\/]ZCode$/, 'unrunnable CLI → GUI launcher');
  assert.equal(macBroken[0].envPatch.ELECTRON_RUN_AS_NODE, '1');

  const t3 = mkdtempSync(join(tmpdir(), 'ab-zc-lin'));
  mkdirSync(join(t3, '.zcode', 'server', 'bin'), { recursive: true });
  writeFileSync(join(t3, '.zcode', 'server', 'bin', 'zcode'), '#!/bin/sh\n');
  const lin = zcodeFallbackCandidates({ home: t3, platform: 'linux' });
  assert.deepEqual(lin, [{ bin: join(t3, '.zcode', 'server', 'bin', 'zcode'), prefix: [], envPatch: {}, label: `${join(t3, '.zcode', 'server', 'bin', 'zcode')} (Linux desktop)` }]);
});

test('ZCODE_CLI resolves the CLI end-to-end, even when the entry copied the default command', async () => {
  await stopServer();
  // An executable wrapper standing in for a user-pinned CLI binary.
  const wrapper = join(tmpdir(), `ab-zc-cli-${randomUUID()}.sh`);
  writeFileSync(wrapper, `#!/bin/sh\nexec '${process.execPath}' '${FAKE_ZCODE}' "$@"\n`);
  chmodSync(wrapper, 0o755);
  await startServer({ command: ['zcode'], env: { ZCODE_CLI: wrapper } }); // command === registry default ⇒ NOT explicit
  const res = await post('/turns', { text: 'PONG' });
  const sse = sseReader(res.body);
  const done = await sse.readUntil((f) => f.data.type === 'done');
  assert.equal(done.data.full, 'PONG');
  assert.equal(spawnedArgs().prompt, 'PONG');
  rmSync(wrapper, { force: true });
});

test('a missing entry cwd reports the CWD, not "binary not found" (both are ENOENT)', async () => {
  await stopServer();
  await startServer({ cwdOverride: '/definitely/not/here' });
  const res = await post('/turns', { text: 'PONG' });
  const sse = sseReader(res.body);
  const err = await sse.readUntil((f) => f.data.type === 'error');
  assert.match(err.data.message, /cwd does not exist: \/definitely\/not\/here/);
  assert.doesNotMatch(err.data.message, /binary not found/);
});

test('exhausted candidates list every attempt and the manual levers', async () => {
  await stopServer();
  await startServer({ command: ['/nonexistent/zcode-cli-x'], env: {} });
  const res = await post('/turns', { text: 'PONG' });
  const sse = sseReader(res.body);
  const err = await sse.readUntil((f) => f.data.type === 'error');
  assert.match(err.data.message, /agent binary not found/);
  assert.match(err.data.message, /tried: command \/nonexistent\/zcode-cli-x/);
  assert.match(err.data.message, /ZCODE_CLI/);
  assert.match(err.data.message, /install zcode/);
});


// ─── model resolution / visibility (2026-10-22) ───────────────────────────────

test('the model the CLI actually resolved is announced (never guessed from reply text)', async () => {
  const res = await post('/turns', { text: 'PONG' });
  const sse = sseReader(res.body);
  const note = await sse.readUntil((f) => f.data.type === 'note' && f.data.kind === 'model');
  assert.deepEqual(note.data.model, { provider: 'provider_fake', model: 'model-fake-1', reasoningLevel: 'max' });
  assert.match(note.data.text, /model-fake-1/);
  await sse.readUntil((f) => f.data.type === 'done');
});

test('the account-plan dead end is translated into an actionable message', async () => {
  const res = await post('/turns', { text: 'NOMODEL' });
  const sse = sseReader(res.body);
  const err = await sse.readUntil((f) => f.data.type === 'error');
  assert.match(err.data.message, /no auto-selectable model/);
  assert.match(err.data.message, /--resume/, 'must name the continue-a-selected-session escape hatch');
  assert.match(err.data.message, /custom provider/, 'must name the other escape hatch');
});

