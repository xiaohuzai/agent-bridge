// agent-bridge/adapters/headless-cli.mjs — drive an agent's OFFICIAL headless
// CLI (one process per turn) and translate its structured event stream into
// the v1 events. This is the "profile table" borrow from Orca's TUI-agent
// config: the transport and lifecycle are shared, each agent's argv shape and
// output schema are one small profile, not a bespoke adapter.
//
// Why a second ZCode path exists: the native adapter (zcode-server.mjs) rides
// the desktop's stdio server, which works only when the desktop HOST owns the
// protocol lifetime. Live re-test 2026-10-21 through this repo: a bridge-
// spawned server answers the handshake, registers a provider, then drops the
// client ("ZCode Protocol client is disposed") the moment a turn starts — the
// pause recorded in AGENTS.md is still real. The official CLI's headless mode
// is a supported external driver surface and completes real turns.
//
// ZCODE PROFILE — all wire facts below captured LIVE 2026-10-21 against
// ZCode CLI 0.17.0 / server 3.16.2 (WSL), prompts "PONG", a Read-tool turn,
// and a --resume turn:
//
//   $ zcode -p '<text>' --output-format stream-json --no-color \
//       --mode plan --cwd <dir> [--resume sess_…]
//
//   stdout is JSONL; each line is one envelope:
//     {type, sessionId, turnId, traceId, eventId, seq, timestamp, payload}
//   Types observed: session.updated (also carries hook-run lifecycle under
//   payload.hookEventName — hook NOISE for us), session.titleUpdated,
//   turn.started, tool.updated, model.streaming, streamRecovery.updated,
//   turn.completed, result.
//
//   model.streaming payload.kind: start | reasoning_start | reasoning_end |
//   tool_input_start | tool_input_delta | tool_input_end | tool_call |
//   text_start | text_delta | text_end | finish. Only text_delta carries the
//   answer text; tool_input_delta carries fragments of the tool's JSON input
//   (never emit those as text).
//
//   tool.updated payload.kind: scheduled {toolCallId, toolName, input} |
//   started {toolCallId, toolName, readOnly, sideEffectScope} | result
//   {toolCallId, result:{success, content,…}} | batch {toolCallIds,…}.
//
//   turn.completed payload: {response, usage:{inputTokens, outputTokens,
//   cacheReadTokens, cacheWriteTokens, reasoningTokens, …}, toolCallCount,
//   resultType, duration}. `response` is the authoritative final text.
//   `result` repeats response/usage plus sessionId and projection and is the
//   last line.
//
//   --resume <sess_…> continues the same persisted session (verified: the
//   follow-up turn recalled the previous prompt; cacheReadTokens 22528 on a
//   28.5K-input turn). Session ids are `sess_…`.
//
//   --mode: build | edit | plan | yolo | guarded (CLI default for -p is
//   YOLO — this adapter defaults to PLAN instead and exposes the mode per
//   entry; a headless turn has no interactive approval card, so choosing the
//   mode IS the permission decision — the Orca "preflight trust" lesson).
//
//   Images: the CLI's only attachment surface is --attach <local path>.
//   v1 delivers data:/https: URLs, and this repo never writes user images to
//   disk, so images degrade to an honest note (the ACP adapter's posture)
//   instead of being silently dropped.
//
// Cost/latency observed: one process per turn, ~2–4s CLI boot + model time
// (PONG 12.7s, Read-tool turn 18.5s, resumed turn 15.3s); a fresh session's
// prompt carries ~28K input tokens (the CLI's own system prompt/tools), and
// resumed turns still read ~22.5K from cache.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { agentSpawnEnv } from './agent-env.mjs';

const ADMISSION_TIMEOUT_MS = 15_000;
const KILL_GRACE_MS = 1_500;
const STDERR_TAIL_BYTES = 4_096;

/** Tiny getter so tests can point the profile at a fixture without touching
 * the user's real install (the fallback is only consulted on ENOENT). */
function zcodeFallbackBin(home = homedir()) {
  return join(home, '.zcode', 'server', 'bin', 'zcode');
}

export const HEADLESS_PROFILES = {
  zcode: {
    name: 'zcode',
    modes: ['build', 'edit', 'plan', 'yolo', 'guarded'],
    defaultMode: 'plan',
    command: ['zcode'],
    fallbackBin: zcodeFallbackBin,
    /** The argv for one turn. Placeholders are already substituted; this is
     * the only place that knows ZCode's flag names. */
    argsFor({ text, mode, cwd, sessionId }) {
      const args = [
        '-p', text,
        '--output-format', 'stream-json',
        '--no-color',
        '--mode', mode,
        '--cwd', cwd,
      ];
      if (sessionId) args.push('--resume', sessionId);
      return args;
    },
    /** One parsed stdout envelope → zero or more v1 events. `turn` is the
     * accumulator shared across the turn's lines. */
    onEvent(msg, turn, emit, finish) {
      const p = msg.payload || {};
      switch (msg.type) {
        case 'model.streaming':
          if (p.kind === 'text_delta' && typeof p.delta === 'string' && p.delta) {
            turn.text += p.delta;
            emit({ type: 'delta', text: p.delta });
          } else if (p.kind === 'reasoning_delta' && typeof p.delta === 'string' && p.delta) {
            // ZCode opens a reasoning block even when it streams no text
            // (live captures: reasoning_start/reasoning_end with empty
            // deltas). Fence lazily so an empty block never reaches the client.
            if (!turn.thinkingOpen) {
              turn.thinkingOpen = true;
              emit({ type: 'delta', text: '<thinking>' });
            }
            turn.thinking += p.delta;
            emit({ type: 'delta', text: p.delta });
          } else if (p.kind === 'reasoning_start') {
            // nothing to emit: the <thinking> fence opens lazily on the first
            // reasoning DELTA (live captures show start/end with empty text).
          } else if (p.kind === 'reasoning_end') {
            if (turn.thinkingOpen) {
              turn.thinkingOpen = false;
              emit({ type: 'delta', text: '</thinking>\n' });
            }
          }
          return;
        case 'tool.updated':
          if (p.kind === 'scheduled') {
            turn.tools.set(p.toolCallId, {
              name: p.toolName || 'tool',
              detail: summarizeToolInput(p.input),
            });
          } else if (p.kind === 'started') {
            const known = turn.tools.get(p.toolCallId);
            const name = p.toolName || known?.name || 'tool';
            turn.tools.set(p.toolCallId, { name, detail: known?.detail || '' });
            emit({ type: 'tool', id: p.toolCallId, name, status: 'started', detail: known?.detail || '' });
          } else if (p.kind === 'result') {
            const known = turn.tools.get(p.toolCallId) || { name: 'tool', detail: '' };
            emit({ type: 'tool', id: p.toolCallId, name: known.name, status: 'completed', detail: known.detail });
          }
          return;
        case 'turn.completed': {
          emitUsage(p.usage, turn, emit);
          const resultType = p.resultType;
          if (resultType === 'success' || resultType === undefined) {
            finish({ kind: 'done', full: typeof p.response === 'string' ? p.response : turn.text });
          } else if (/interrupt|abort|cancel/i.test(String(resultType))) {
            finish({ kind: 'aborted' });
          } else {
            finish({ kind: 'error', message: `zcode turn ended: ${resultType}` });
          }
          return;
        }
        case 'result': {
          // Last line; turn.completed normally settled first. Keeps usage and
          // the final text authoritative if that event was skipped.
          emitUsage(msg.usage, turn, emit);
          if (typeof msg.response === 'string') finish({ kind: 'done', full: msg.response });
          return;
        }
        default:
          // session.updated / session.titleUpdated / streamRecovery.updated /
          // turn.started carry no v1 event of their own.
          return;
      }
    },
  },
};

/** v1 usage event fields — prompt_tokens is the FULL prompt, cached_tokens a
 * subset (server.mjs contract). */
function emitUsage(u, turn, emit) {
  if (!u || typeof u !== 'object') return;
  if (typeof u.inputTokens !== 'number' || typeof u.outputTokens !== 'number') return;
  const key = `${u.inputTokens}/${u.outputTokens}/${u.cacheReadTokens ?? 0}/${u.cacheWriteTokens ?? 0}`;
  if (turn.lastUsageKey === key) return; // turn.completed and result repeat it
  turn.lastUsageKey = key;
  turn.usage = {
    prompt_tokens: u.inputTokens,
    completion_tokens: u.outputTokens,
    ...(typeof u.cacheReadTokens === 'number' ? { cached_tokens: u.cacheReadTokens } : {}),
    ...(typeof u.cacheWriteTokens === 'number' ? { cache_write_tokens: u.cacheWriteTokens } : {}),
  };
  emit({ type: 'usage', ...turn.usage });
}

/** The one-line human detail for a tool row: the same preference order v1
 * clients already render for command/path tools. */
function summarizeToolInput(input) {
  if (!input || typeof input !== 'object') return '';
  for (const key of ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'description']) {
    if (typeof input[key] === 'string' && input[key].trim()) return input[key].trim();
  }
  try {
    const s = JSON.stringify(input);
    return s.length > 160 ? `${s.slice(0, 157)}…` : s;
  } catch (_) {
    return '';
  }
}

export class HeadlessCliAdapter {
  constructor({ profile = 'zcode', command, cwd = process.cwd(), mode, env = {}, installHint, log = () => {} } = {}) {
    const spec = HEADLESS_PROFILES[profile];
    if (!spec) throw new Error(`unknown headless profile "${profile}"`);
    if (mode !== undefined && !spec.modes.includes(mode)) {
      throw new Error(`invalid mode "${mode}" for ${profile} — one of: ${spec.modes.join(', ')}`);
    }
    this.spec = spec;
    this.command = Array.isArray(command) && command.length ? [...command] : null;
    this.cwd = cwd;
    this.mode = mode || spec.defaultMode;
    this.env = env;
    this.installHint = installHint || '';
    this.log = log;
    this.stopped = false;
    // The ACP front advertises image support from this flag; headless CLIs
    // only attach local files, so the bridge must NOT claim image support.
    this.promptImage = false;
    this.turns = new Set(); // live turn records
    this.sessions = new Map(); // sessionId → turn record (for interrupt)
  }

  /** Spawn the CLI for one turn. Admission resolves once the process is up and
   * the session id is known (or the admission window expires): the server
   * patches its disconnect handler from the start event, so the earlier the
   * id lands the safer a mid-turn abort is. */
  async startTurn({ text, sessionId, images, onEvent }) {
    if (this.stopped) throw new Error('headless adapter already stopped');
    if (Array.isArray(images) && images.length) {
      onEvent({
        type: 'note',
        text: `（注：${images.length} 张图片未随附——headless CLI 只接受本地文件 --attach，bridge 不把图片写盘。）`,
      });
    }

    const turn = {
      sessionId: sessionId || null,
      turnId: '',
      text: '',
      thinking: '',
      thinkingOpen: false,
      tools: new Map(),
      child: null,
      settled: false,       // done/aborted/error emitted
      aborted: false,
      stderr: '',
      usage: null,          // last mapped usage — rides the done event too
      admitResolve: null,
      finish: null,
      lastUsageKey: '',
    };
    this.turns.add(turn);
    if (sessionId) this.sessions.set(sessionId, turn);

    const admit = new Promise((resolve) => {
      turn.admitResolve = resolve;
    });

    const emit = (e) => {
      if (turn.settled) return;
      onEvent(e);
    };
    const finish = ({ kind, full, message }) => {
      if (turn.settled) return;
      turn.settled = true;
      if (kind === 'done') {
        // full is authoritative; it must agree with the delta concat on the
        // thinking shape (server.mjs contract). ZCode's response excludes
        // reasoning, so prepend the collected block only when it has content.
        let final = full;
        if (turn.thinkingOpen) { onEvent({ type: 'delta', text: '</thinking>\n' }); turn.thinkingOpen = false; }
        if (turn.thinking && !final.includes('<thinking>')) {
          final = `<thinking>${turn.thinking}</thinking>\n${final}`;
        }
        // done carries usage: v1 clients read the standalone usage event, but
        // the ACP front maps usage ONLY from done (adapter contract, server.mjs).
        onEvent({ type: 'done', full: final, ...(turn.usage ? { usage: turn.usage } : {}) });
      } else if (kind === 'aborted') {
        onEvent({ type: 'aborted' });
      } else {
        onEvent({ type: 'error', message: message || 'headless agent failed' });
      }
      turn.admitResolve?.({ sessionId: turn.sessionId, turnId: turn.turnId });
    };
    turn.finish = finish;

    const startEvent = () => {
      if (!turn.sessionId) return;
      emit({ type: 'start', sessionId: turn.sessionId, turnId: turn.turnId });
    };

    const onLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg;
      try { msg = JSON.parse(trimmed); } catch (_) {
        this.log(`[${this.spec.name}] non-JSON stdout: ${trimmed.slice(0, 200)}`);
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      if (msg.turnId && !turn.turnId) turn.turnId = msg.turnId;
      if (msg.sessionId && !turn.sessionId) {
        turn.sessionId = msg.sessionId;
        this.sessions.set(turn.sessionId, turn);
        // First boundary (session.updated / turn.started) — before any delta.
        startEvent();
      }
      this.spec.onEvent(msg, turn, emit, finish);
    };

    try {
      turn.child = await this.#spawnTurn({ text, sessionId });
    } catch (e) {
      this.turns.delete(turn);
      if (turn.sessionId && this.sessions.get(turn.sessionId) === turn) this.sessions.delete(turn.sessionId);
      const message = e.code === 'ENOENT'
        ? `agent binary not found: ${this.command ? this.command[0] : this.spec.command[0]}`
          + (this.installHint ? ` — install: ${this.installHint}` : '')
        : `failed to start ${this.spec.name}: ${e.message}`;
      // The HTTP layer relays a thrown startTurn as the turn's error event;
      // emitting here too would double it.
      throw new Error(message);
    }

    const child = turn.child;
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        onLine(line);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      turn.stderr = (turn.stderr + chunk).slice(-STDERR_TAIL_BYTES);
      for (const line of String(chunk).split('\n')) {
        if (line.trim()) this.log(`[${this.spec.name} stderr] ${line.trim()}`);
      }
    });
    child.on('exit', (code, signal) => {
      if (buf.trim()) onLine(buf);
      buf = '';
      this.turns.delete(turn);
      if (turn.sessionId && this.sessions.get(turn.sessionId) === turn) this.sessions.delete(turn.sessionId);
      if (turn.settled) return;
      if (turn.aborted) {
        finish({ kind: 'aborted' });
        return;
      }
      const tail = turn.stderr.trim().split('\n').slice(-3).join(' | ');
      finish({
        kind: 'error',
        message: `${this.spec.name} exited (code=${code}${signal ? `, signal=${signal}` : ''}) before a result`
          + (tail ? `: ${tail}` : ''),
      });
    });

    // Resumed sessions know the id upfront: the start event can go out now and
    // the turn needs no admission wait. New sessions wait for the first
    // envelope carrying a sessionId.
    if (sessionId) {
      startEvent();
      turn.admitResolve({ sessionId, turnId: '' });
    }
    // The timeout's timer MUST be cleared when admission wins the race — an
    // un-cleared 15s timer held the event loop (and the turn closure) long
    // after every turn (verified 2026-10-22: process exit delayed ~14.7s).
    let admitTimer = null;
    const admission = await Promise.race([
      admit,
      new Promise((resolve) => { admitTimer = setTimeout(() => resolve(null), ADMISSION_TIMEOUT_MS); }),
    ]).finally(() => { if (admitTimer) clearTimeout(admitTimer); });
    if (admission === null) {
      this.log(`[${this.spec.name}] no session id within ${ADMISSION_TIMEOUT_MS}ms — returning unadmitted turn`);
    }
    return { sessionId: turn.sessionId, turnId: turn.turnId };
  }

  /** Spawn argv, retrying the profile's fallback binary once on ENOENT when
   * the command was not explicitly configured (desktop-bundled CLIs are not
   * always on PATH — ZCode's lives under ~/.zcode/server/bin). */
  #spawnTurn({ text, sessionId }) {
    const argv = this.spec.argsFor({ text, mode: this.mode, cwd: this.cwd, sessionId });
    const explicit = this.command !== null;
    const base = this.command || this.spec.command;
    const tryOnce = (bin, prefix = []) => new Promise((resolve, reject) => {
      const child = spawn(bin, [...prefix, ...argv], {
        cwd: this.cwd,
        env: agentSpawnEnv(this.env),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        // Windows npm shims are .cmd; args include the user's prompt, so this
        // path is best-effort (the Linux/macOS path never uses a shell).
        shell: process.platform === 'win32',
      });
      child.once('spawn', () => resolve(child));
      child.once('error', (err) => reject(err));
    });
    return tryOnce(base[0], base.slice(1)).catch((err) => {
      if (err.code !== 'ENOENT' || explicit || !this.spec.fallbackBin) throw err;
      const fallback = this.spec.fallbackBin();
      if (!existsSync(fallback)) throw err;
      this.log(`[${this.spec.name}] ${base[0]} not on PATH — using ${fallback}`);
      this.command = [fallback];
      return tryOnce(fallback);
    });
  }

  /** Kill the turn's process. There is no stop rpc on a headless CLI; SIGTERM
   * is the whole interrupt. The turn settles as aborted immediately so the
   * SSE stream does not wait for the child's exit. */
  async interrupt(sessionId) {
    const turn = sessionId ? this.sessions.get(sessionId) : null;
    if (!turn || turn.settled) return;
    turn.aborted = true;
    turn.finish({ kind: 'aborted' });
    try { turn.child?.kill('SIGTERM'); } catch (_) {}
    const child = turn.child;
    setTimeout(() => { try { if (child && child.exitCode === null) child.kill('SIGKILL'); } catch (_) {} }, KILL_GRACE_MS);
  }

  /** Live sessions only: a headless CLI persists its own sessions on disk and
   * offers no cheap enumeration, so v1's recovery list can only report turns
   * this adapter currently owns. After a bridge restart the client recovers
   * by sending its stored sessionId (the CLI resumes it by id). */
  listSessions() {
    const out = [];
    for (const turn of this.turns) {
      if (!turn.sessionId) continue;
      out.push({ sessionId: turn.sessionId, busy: !turn.settled });
    }
    return out;
  }

  /** Headless turns have no interactive approval surface — choosing the mode
   * is the permission decision. A stray answer is a client bug, not a hang. */
  async respondApproval() {
    throw new Error('this agent runs headless — approvals are decided by the mode, not per request');
  }

  stop() {
    this.stopped = true;
    for (const turn of this.turns) {
      try { turn.child?.kill('SIGTERM'); } catch (_) {}
    }
    this.turns.clear();
    this.sessions.clear();
  }
}
