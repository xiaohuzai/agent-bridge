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

import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { agentSpawnEnv } from './agent-env.mjs';

const ADMISSION_TIMEOUT_MS = 15_000;
const KILL_GRACE_MS = 1_500;
const STDERR_TAIL_BYTES = 4_096;

/** CLI candidates beyond a bare `zcode` on PATH — every shape below was
 * verified against a real install (Linux/WSL 2026-10-21, Windows 2026-10-22):
 *   Linux desktop:  ~/.zcode/server/bin/zcode — a sh wrapper, spawned as-is.
 *   Windows/macOS desktop: the app bundles the CLI as resources/glm/zcode.cjs
 *     and runs it on the app's OWN Electron in ELECTRON_RUN_AS_NODE mode
 *     (verified: `ELECTRON_RUN_AS_NODE=1 ZCode.exe …\zcode.cjs --version`
 *     prints 0.17.0; macOS is the same shape the native adapter verified
 *     2026-10-08 — Contents/Resources/glm/zcode.cjs on Contents/MacOS/ZCode).
 *     The app-bundle CLI cannot find its builtin provider catalog beside
 *     itself (packaging delta — it looks at glm/provider/, the app ships
 *     Resources/config/provider/), so point ZCODE_BUILTIN_PROVIDER_CONFIG_FILE
 *     at the app's copy when present. */
export function zcodeFallbackCandidates({ home = homedir(), programDirs, platform = process.platform } = {}) {
  const out = [];
  if (platform === 'win32') {
    const dirs = programDirs || [
      process.env.ProgramFiles || 'C:\\Program Files',
      join(home, 'AppData', 'Local', 'Programs'),
    ];
    for (const root of dirs) {
      const cjs = join(root, 'ZCode', 'resources', 'glm', 'zcode.cjs');
      const exe = join(root, 'ZCode', 'ZCode.exe');
      if (!existsSync(cjs)) continue;
      const provider = join(root, 'ZCode', 'resources', 'config', 'provider', 'zcode-builtin.json');
      const providerEnv = providerPairEnv(provider, { home });
      // `bin` below already includes the bridge's own node first (see the
      // nodeRuntime() helper) — same reason as macOS.
      const node = nodeRuntime();
      if (node) {
        out.push({ bin: node, prefix: [cjs], envPatch: { ...providerEnv }, label: `${cjs} (desktop app bundle, node runtime)` });
        continue;
      }
      if (!existsSync(exe)) continue;
      out.push({
        bin: exe,
        prefix: [cjs],
        envPatch: { ELECTRON_RUN_AS_NODE: '1', ...providerEnv },
        label: `${cjs} (desktop app bundle, Electron launcher)`,
      });
    }
    return out;
  }
  if (platform === 'darwin') {
    const dirs = programDirs || ['/Applications/ZCode.app/Contents'];
    for (const root of dirs) {
      const cjs = join(root, 'Resources', 'glm', 'zcode.cjs');
      const gui = join(root, 'MacOS', 'ZCode');
      if (!existsSync(cjs)) continue;
      const provider = join(root, 'Resources', 'config', 'provider', 'zcode-builtin.json');
      const providerEnv = providerPairEnv(provider, { home });
      // ZERO-CONFIG node resolution, in preference order:
      //   1. the node running THIS bridge (process.execPath) — always a real
      //      node, needs no user setup;
      //   2. a node shipped inside the app bundle;
      //   3. a node on PATH;
      //   4. the app's GUI binary as a launcher (ELECTRON_RUN_AS_NODE).
      // Why node at all: the GUI launcher makes the CLI's own child spawns
      // flash Terminal windows — the CLI strips ELECTRON_RUN_AS_NODE from
      // tool/Bash subprocess envs (`vPe()` in the 3.16.2 bundle), so each child
      // re-launches the GUI app. A real node has no such behavior.
      // Every candidate is PROVEN by running `<node> <cjs> --version`: mere
      // existence is not evidence (Electron's `Frameworks/<App> Helper.app`
      // passes existsSync and then dies "Unable to find helper app", 2026-10-22).
      const nodeCandidates = [
        nodeRuntime(),
        ...(platform === 'darwin'
          ? [join(root, 'Resources', 'node'), join(root, 'Resources', 'runtime', 'node')].filter((p) => existsSync(p))
          : []),
      ].filter(Boolean);
      const node = nodeCandidates.find((p) => runsZcodeCli(p, cjs));
      if (node) {
        out.push({ bin: node, prefix: [cjs], envPatch: { ...providerEnv }, label: `${cjs} (desktop app bundle, node runtime: ${node})` });
        continue;
      }
      if (!existsSync(gui)) continue;
      out.push({
        bin: gui,
        prefix: [cjs],
        envPatch: { ELECTRON_RUN_AS_NODE: '1', ...providerEnv },
        label: `${cjs} (desktop app bundle, Electron launcher)`,
      });
    }
    return out;
  }
  const wrapper = join(home, '.zcode', 'server', 'bin', 'zcode');
  if (existsSync(wrapper)) {
    out.push({ bin: wrapper, prefix: [], envPatch: {}, label: `${wrapper} (Linux desktop)` });
  }
  return out;
}

/** The builtin/personal provider-config env pair. The CLI requires BOTH or
 * neither: `resolveNodeProviderRuntimePaths()` throws
 * "ZCode Built-in 与 Personal Provider Config 路径必须同时提供" when only one
 * is set, and setting only the builtin one is what made macOS print
 * "ZCode Built-in missing" (2026-10-22). Personal config lives in the normal
 * ~/.zcode location, so point it there explicitly whenever we point the
 * builtin one. If either path is absent, set NEITHER and let the CLI resolve
 * its own defaults. */
function providerPairEnv(builtinPath, { home = homedir() } = {}) {
  const personal = join(home, '.zcode', 'v2', 'provider_config.json');
  if (!existsSync(builtinPath) || !existsSync(personal)) return {};
  return {
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtinPath,
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personal,
  };
}

/** Is this really a Node runtime? Presence is not proof — Electron bundles
 * ship helper binaries (Frameworks/<App> Helper.app) that are NOT node and die
 * with "FATAL: Unable to find helper app" when asked to run a script
 * (2026-10-22: the adapter picked one and broke a working bridge). Ask it:
 * a node binary prints "v22.x.y" for --version within a few seconds. */
function isNodeBinary(bin) {
  try {
    const out = execFileSync(bin, ['--version'], { timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return /^v\d+\.\d+\.\d+/m.test(String(out || '').trim());
  } catch (_) {
    return false;
  }
}

/** The strongest node candidate available without user setup: the interpreter
 * running THIS bridge. It is a real node by construction. */
function nodeRuntime() {
  const p = process.execPath;
  return p && isNodeBinary(p) ? p : null;
}

/** Prove a node candidate can actually drive the CLI: run `<node> <cjs> --version`
 * and expect the CLI's own version (e.g. "0.17.0"). This catches both "not a
 * node" and "node too old for this CLI" before a user ever sees a failure. */
function runsZcodeCli(node, cjs) {
  try {
    const out = execFileSync(node, [cjs, '--version'], {
      timeout: 20_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    return /\b\d+\.\d+\.\d+\b/.test(String(out || ''));
  } catch (_) {
    return false;
  }
}

export const HEADLESS_PROFILES = {
  zcode: {
    name: 'zcode',
    modes: ['edit', 'plan', 'build', 'guarded', 'yolo'],
    // 'edit', not 'plan': headless has NO approval card, so 'build' (which
    // pauses for approval) can stall a turn and 'plan' cannot touch files at
    // all. 'edit' auto-applies changes and is the practical default for a
    // chat client that mostly reads but may write docs (owner decision
    // 2026-10-22). Agents that must never write can still set "mode": "plan".
    defaultMode: 'edit',
    command: ['zcode'],
    fallbackCandidates: zcodeFallbackCandidates,
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
        case 'turn.started': {
          // The model the CLI ACTUALLY resolved — the only trustworthy source.
          // A reply that "says" GLM proves nothing (models name themselves);
          // this is the selection the provider will be charged for. Surfaced
          // additively on the start event so clients can show it.
          const sel = msg.payload?.intent?.modelSelection;
          if (sel && typeof sel === 'object' && sel.modelId) {
            turn.model = {
              ...(sel.providerId ? { provider: sel.providerId } : {}),
              model: sel.modelId,
              ...(sel.options?.reasoningLevel ? { reasoningLevel: sel.options.reasoningLevel } : {}),
            };
          }
          return;
        }
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

/** Turn upstream stderr into an actionable message. The CLI's own wording for
 * the account-plan dead end is just "Select a model before sending a message" —
 * true but useless to a bridge operator, who cannot click anything. Observed
 * live 2026-10-22 (zhipu account logged in, no custom provider visible). */
function explainHeadlessExit(base, stderr) {
  const text = String(stderr || '');
  if (/Select a model before sending a message/i.test(text)) {
    return base + ': the CLI has no auto-selectable model. '
      + 'For ZCode: headless cannot pick an ACCOUNT-plan provider\'s model — '
      + 'add a custom provider (headless orders them first), or start the session in the ZCode '
      + 'app/CLI with the account model selected and continue it (--resume keeps its model).';
  }
  const tail = text.trim().split('\n').slice(-3).join(' | ');
  return base + (tail ? `: ${tail}` : '');
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
      emit({ type: 'start', sessionId: turn.sessionId, turnId: turn.turnId, ...(turn.model ? { model: turn.model } : {}) });
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
      const hadSession = !!turn.sessionId;
      if (msg.sessionId && !turn.sessionId) {
        turn.sessionId = msg.sessionId;
        this.sessions.set(msg.sessionId, turn);
        // First boundary (session.updated) — emit `start` NOW so the client
        // learns the session id as early as possible (a disconnect needs it).
        // The model is NOT known yet at this point: real ZCode sends
        // session.updated before turn.started.
        emit({ type: 'start', sessionId: turn.sessionId, turnId: turn.turnId });
      }
      const modelBefore = turn.modelAnnounced;
      this.spec.onEvent(msg, turn, emit, finish);
      // `turn.started` is where the CLI reveals the model it actually
      // resolved. Announce it once, as a note, so a client can show "using X"
      // without trusting the reply text (models name themselves unreliably).
      if (!modelBefore && turn.model) {
        turn.modelAnnounced = true;
        emit({ type: 'note', text: `model: ${turn.model.model}${turn.model.provider ? ` (${turn.model.provider})` : ''}${turn.model.reasoningLevel ? ` · reasoning ${turn.model.reasoningLevel}` : ''}`, kind: 'model', model: turn.model });
      }
      if (hadSession) return;
    };

    try {
      turn.child = await this.#spawnTurn({ text, sessionId });
    } catch (e) {
      this.turns.delete(turn);
      if (turn.sessionId && this.sessions.get(turn.sessionId) === turn) this.sessions.delete(turn.sessionId);
      const message = e.spawnMessage
        // #spawnTurn's own errors (missing cwd, exhausted candidates) are
        // already end-user-shaped — pass them through verbatim.
        ? e.message
        : e.code === 'ENOENT'
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
        message: explainHeadlessExit(`${this.spec.name} exited (code=${code}${signal ? `, signal=${signal}` : ''}) before a result`, turn.stderr + tail),
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
      // Not an error: on a cold start the CLI may take longer than the
      // admission window to emit its first event. The turn keeps running and
      // `start` (with the session id) still arrives; the client's disconnect
      // path is covered by res.on('close') in server.mjs, not by this timeout.
      this.log(`[${this.spec.name}] still booting after ${ADMISSION_TIMEOUT_MS}ms — the turn continues; the start event will arrive once the CLI emits its first frame (normal on a cold start)`);
    }
    return { sessionId: turn.sessionId, turnId: turn.turnId };
  }

  /** Spawn argv for one turn, walking the candidate chain on ENOENT:
   * explicit non-default command > ZCODE_CLI env > `zcode` on PATH > the
   * platform's desktop-install candidates. A command EQUAL to the profile
   * default is treated as "no explicit command" so copying ["zcode"] into an
   * entry does not silently disable the fallbacks. */
  #spawnTurn({ text, sessionId }) {
    // A missing cwd also surfaces as spawn ENOENT (Node reports "spawn node
    // ENOENT" with the BINARY's name even when the cwd is the problem —
    // verified 2026-10-22), which the old error misread as "binary not
    // found". Pre-check and name the real problem.
    if (!existsSync(this.cwd)) {
      const err = new Error(`${this.spec.name}: workspace cwd does not exist: ${this.cwd} — fix the bridge entry's "cwd"`);
      err.spawnMessage = true;
      throw err;
    }
    const argv = this.spec.argsFor({ text, mode: this.mode, cwd: this.cwd, sessionId });
    const isDefault = JSON.stringify(this.command) === JSON.stringify(this.spec.command);
    const explicit = this.command !== null && !isDefault;
    const attempts = [];
    if (explicit) {
      attempts.push({ bin: this.command[0], prefix: this.command.slice(1), envPatch: {}, label: `command ${this.command.join(' ')}` });
    } else {
      const mergedEnv = agentSpawnEnv(this.env);
      if (mergedEnv.ZCODE_CLI) {
        // A command LINE, not just a path: the escape hatch for platforms
        // where the desktop bundle has no plain node binary is
        // `ZCODE_CLI="/usr/bin/env node /Applications/ZCode.app/Contents/Resources/glm/zcode.cjs"`.
        // Runs through `sh -c` so QUOTED paths with spaces survive (a naive
        // whitespace split breaks "/Applications/ZCode.app/…"); the user owns
        // this value, so shell semantics are what they expect.
        attempts.push({ shellLine: mergedEnv.ZCODE_CLI.trim(), label: `ZCODE_CLI=${mergedEnv.ZCODE_CLI}` });
      }
      attempts.push({ bin: this.spec.command[0], prefix: this.spec.command.slice(1), envPatch: {}, label: `${this.spec.command[0]} (PATH)` });
      for (const c of (this.spec.fallbackCandidates?.() || [])) attempts.push(c);
    }
    const tryOnce = (att) => new Promise((resolve, reject) => {
      const useShell = !!att.shellLine || (process.platform === 'win32' && !/\.exe$/i.test(att.bin));
      const child = att.shellLine
        // ZCODE_CLI: shell-parsed so quoted paths survive; the prompt rides
        // argv, never interpolated into the command string.
        ? spawn(att.shellLine, argv, { cwd: this.cwd, env: agentSpawnEnv({ ...this.env, ...att.envPatch }), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: true })
        : spawn(att.bin, [...att.prefix, ...argv], {
          cwd: this.cwd,
          env: agentSpawnEnv({ ...this.env, ...att.envPatch }),
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          // Windows: .cmd/.bat shims need a shell; a real .exe (the desktop
          // app's ZCode.exe) must NOT go through one — its "C:\Program Files\…"
          // path would split on the space. POSIX never uses a shell here (the
          // user's prompt rides in argv).
          shell: useShell,
        });
      child.once('spawn', () => resolve(child));
      child.once('error', (err) => reject(err));
    });
    const walk = (i) => {
      if (i >= attempts.length) {
        const err = new Error(
          `agent binary not found — tried: ${attempts.map((a) => a.label).join(', ')}`
          + (this.installHint ? ` — install: ${this.installHint}` : '')
          + ' — or point the entry\'s "command" (or ZCODE_CLI) at the CLI',
        );
        err.code = 'ENOENT';
        err.spawnMessage = true;
        throw err;
      }
      const att = attempts[i];
      return tryOnce(att).catch((err) => {
        if (err.code !== 'ENOENT') throw err;
        if (i + 1 < attempts.length) this.log(`[${this.spec.name}] ${att.label} not found — trying next candidate`);
        return walk(i + 1);
      });
    };
    return walk(0);
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
