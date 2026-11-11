// adapters/jsonl-rpc.mjs — the shared transport for the two long-lived JSONL
// adapters (codex app-server, ACP stdio).
//
// It owns the rules that were paid for live and then copied:
//   - one spawn+handshake at a time (single-flight lock; a second spawn would
//     orphan the first child);
//   - spawn failure arrives as an async 'error' event, never a throw;
//   - every pending rpc carries its child identity, so a late exit from an
//     old child can never settle a newer child's call;
//   - a dead child settles ITS admitted turns via onDown, and a respawn
//     sweeps everything that belonged to the child being replaced;
//   - JSONL framing through the shared line splitter.
//
// Protocol dispatch stays in the adapter (onFrame, onDown, handshake).

import { spawn } from 'node:child_process';
import { agentSpawnEnv } from './agent-env.mjs';
import { createLineSplitter } from '../jsonl-lines.mjs';
import { rejectPendingForChild, rejectAllPending } from './pending-rpcs.mjs';

const RPC_TIMEOUT_MS = 30000;

export function createJsonlRpc({
  command,
  args = [],
  cwd = process.cwd(),
  env = {},
  label,
  description = label,
  notFound,
  startFailed,
  log = () => {},
  onFrame = () => {},
  onDown = () => {},
  onRpcCall = () => {},
  onRpcSettled = () => {},
  handshake = async () => {},
} = {}) {
  if (!Array.isArray(command) || !command.length) throw new Error('jsonl-rpc: command required');

  let child = null;
  let ready = false;
  let starting = null;
  let nextId = 1;
  let closed = false;
  const pending = new Map();
  const lines = createLineSplitter((raw) => {
    const line = raw.trim();
    if (!line) return;
    let j;
    try { j = JSON.parse(line); } catch { return; }
    onFrame(j);
  });

  const link = {
    get child() { return child; },
    get ready() { return ready; },
    get pending() { return pending; },
    get closed() { return closed; },
    ensure,
    rpc,
    write,
    down,
    sweep,
    stop,
  };

  async function ensure() {
    if (child && child.exitCode === null && ready) return;
    if (closed) throw new Error('bridge adapter already stopped');
    if (!starting) starting = start().finally(() => { starting = null; });
    await starting;
  }

  async function start() {
    // A respawn only starts once the previous child is gone or unusable —
    // whatever it left behind is stale by definition. Settle it BEFORE the
    // fresh child so nothing can hang on a dead process, and kill the
    // half-dead one (e.g. an initialize that timed out) instead of leaking it.
    sweep(`${description} restarted`);
    const c = spawn(command[0], [...command.slice(1), ...args], {
      cwd,
      env: agentSpawnEnv(env),
      stdio: ['pipe', 'pipe', 'pipe'],
      // Windows: npm CLI shims are .cmd — spawn needs a shell there.
      shell: process.platform === 'win32',
      windowsHide: true,
    });
    child = c;
    ready = false;
    c.stdout.on('data', (d) => lines.push(d));
    c.stderr.on('data', (d) => log(`[${label} stderr] ${String(d).slice(0, 300)}`));
    c.on('exit', (code) => {
      log(`[${label}] ${description} exited (code=${code})`);
      down(c, `${description} exited (code=${code})`);
    });
    // A spawn failure is an async 'error' event — without a listener it is an
    // uncaughtException that kills the whole bridge.
    c.on('error', (err) => {
      const msg = err.code === 'ENOENT'
        ? (notFound ? notFound(command[0]) : `${label}: command not found: '${command[0]}' — install it with: see README → Supported agents`)
        : (startFailed ? startFailed(command[0], err) : `failed to start ${label} '${command[0]}': ${err.message}`);
      log(`[${label}] ${msg}`);
      down(c, msg);
    });
    await handshake(link);
    ready = true;
  }

  function down(c, message) {
    rejectPendingForChild(pending, c, message);
    onDown({ child: c, all: false, message });
    if (child === c) {
      child = null;
      ready = false;
    }
  }

  function sweep(message) {
    rejectAllPending(pending, message);
    onDown({ child: null, all: true, message });
    if (child) {
      try { child.kill('SIGKILL'); } catch (_) {}
      child = null;
    }
    ready = false;
  }

  function write(obj) {
    try { child?.stdin?.write(JSON.stringify(obj) + '\n'); } catch (_) {}
  }

  function rpc(method, params, timeoutMs = RPC_TIMEOUT_MS) {
    const id = nextId++;
    onRpcCall(id, method);
    return new Promise((resolve, reject) => {
      // timeoutMs <= 0 means "no timer": a v1 session/prompt rpc stays
      // pending for the WHOLE turn (its response IS the completion).
      const timer = timeoutMs > 0 ? setTimeout(() => {
        pending.delete(id);
        onRpcSettled(id);
        reject(new Error(`${label} rpc timeout: ${method}`));
      }, timeoutMs) : null;
      pending.set(id, {
        resolve: (v) => { if (timer) clearTimeout(timer); onRpcSettled(id); resolve(v); },
        reject: (e) => { if (timer) clearTimeout(timer); onRpcSettled(id); reject(e); },
        child,
      });
      write({ jsonrpc: '2.0', id, method, params });
    });
  }

  function stop() {
    closed = true;
    try { child?.stdin?.end(); } catch (_) {}
    try { child?.kill('SIGKILL'); } catch (_) {}
    child = null;
    ready = false;
  }

  return link;
}
