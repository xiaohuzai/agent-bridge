// agent-bridge/adapters/workbuddy.mjs — WorkBuddy AI desktop adapter.
//
// Drives the CodeBuddy Code worker that the **WorkBuddy AI desktop app**
// spawns and keeps warm: the desktop launches `cli/bin/codebuddy --serve
// --port 0` (a local HTTP gateway) and drives it over **ACP over Streamable
// HTTP** — JSON-RPC where the client POSTs requests and reads responses/SSE,
// with server→client requests (permission asks) arriving on the same stream.
// All facts below were verified live against WorkBuddy AI 5.4.3 on macOS
// (2026-10-08, real turns through this exact surface) — do not "simplify":
//
//   POST {base}/connect  body {} → {connectionId, sessionToken}   (no auth)
//   POST {base}          headers: Authorization: Bearer <sessionToken>
//                                 acp-connection-id: <connectionId>
//                                 Accept: application/json, text/event-stream
//                        body: JSON-RPC request
//                        → SSE (":ok" comment, "event: message", "data: {…}")
//   initialize {protocolVersion:1, clientCapabilities:{fs:{readTextFile:false,
//              writeTextFile:false}, terminal:false}}
//              → {protocolVersion:1, agentCapabilities:{promptCapabilities:
//              {image:true, embeddedContext:true}, loadSession:true, …}}
//   session/new {cwd, mcpServers:[]} → result.sessionId (+ session/update
//              notifications on the stream: config_option_update etc.)
//   session/prompt {sessionId, prompt:[{type:'text',text} | {type:'image',
//              data:<base64>, mimeType}]} → SSE stream of session/update
//              notifications, final result {stopReason:'end_turn'|'cancelled'|…}
//   session/cancel {sessionId} → the prompt settles with stopReason 'cancelled'.
//   session/request_permission (server→client REQUEST on the stream):
//              {params:{sessionId, toolCall:{toolCallId,title,…}, options:
//              [{optionId,name,kind:'allow_once'|'allow_always'|'reject_once'}]}}
//              → answer by POSTing {jsonrpc, id:<request id>, result:{outcome:
//              {outcome:'selected', optionId}}|{outcome:{outcome:'cancelled'}}}.
//   session/update variants: agent_message_chunk {content:{type:'text',text}},
//              agent_thought_chunk, tool_call/tool_call_update {toolCallId,
//              toolName, status: pending|in_progress|completed|failed},
//              config_option_update / session_info_update (noise → heartbeat).
//   loadSession: true — a sessionId survives across worker/bridge lifetimes;
//              resume with session/load {sessionId, cwd, mcpServers:[]}.
//              If load FAILS (worker lost the session — e.g. the desktop
//              restarted without keeping ACP sessions), the turn falls back
//              to a fresh session and re-keys: the start event carries the
//              new id (clients re-map), a note explains the context reset.
//
// Worker discovery: the worker port is dynamic (random per desktop boot).
// Order: explicit `workbuddyPort` config > env WORKBUDDY_PORT > auto-discovery
// (scan `lsof -iTCP -sTCP:LISTEN` loopback ports for the /health signature
// `{"status":"UP"` with the `eg` component). The WorkBuddy AI desktop app must
// be installed, logged in, and RUNNING — the adapter is a pure client and
// never spawns anything; model/login state stays in the user's WorkBuddy app.

import { spawnSync } from 'node:child_process';

const CONNECT_TIMEOUT_MS = 8_000;
const RPC_TIMEOUT_MS = 20_000;
const DISCOVERY_TIMEOUT_MS = 6_000;
const HEALTH_SIGNATURE = /"status"\s*:\s*"UP"/;

/** Probe loopback listening ports for the CodeBuddy worker health signature
 * (`{"status":"UP","components":{"eg":…}}`). */
function discoverWorkerPort(log) {
  let out = '';
  try {
    out = spawnSync('lsof', ['-iTCP', '-sTCP:LISTEN', '-P', '-n'], {
      encoding: 'utf8',
      timeout: DISCOVERY_TIMEOUT_MS,
    }).stdout || '';
  } catch (_) {
    return null;
  }
  const ports = [...new Set([...out.matchAll(/127\.0\.0\.1:(\d+)/g)].map((m) => +m[1]))];
  for (const port of ports) {
    try {
      const res = spawnSync('curl', ['-sS', '-m', '2', `http://127.0.0.1:${port}/health`], {
        encoding: 'utf8',
        timeout: DISCOVERY_TIMEOUT_MS,
      });
      const body = res.stdout || '';
      if (HEALTH_SIGNATURE.test(body) && body.includes('"eg"')) {
        log(`workbuddy worker discovered on port ${port}`);
        return port;
      }
    } catch (_) { /* try next */ }
  }
  return null;
}

export function resolveWorkbuddyPort({ workbuddyPort, log } = {}) {
  if (workbuddyPort) return workbuddyPort;
  const fromEnv = process.env.WORKBUDDY_PORT;
  if (fromEnv && /^\d+$/.test(fromEnv.trim())) return Number(fromEnv.trim());
  const discovered = discoverWorkerPort(log);
  if (discovered) return discovered;
  throw new Error(
    'workbuddy worker not found — start the WorkBuddy AI desktop app (and keep it running), '
    + 'or set "workbuddyPort" on the bridge entry to the running worker port',
  );
}

/** Strip a data: URL to {mimeType, base64}; null when it isn't one. */
function parseImageDataUrl(dataUrl) {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(String(dataUrl || ''));
  if (!m) return null;
  return { mimeType: m[1], data: m[2] };
}

/** Incremental SSE parse for one POST response body. Each complete
 * `data: {…}` line is delivered as a parsed JSON-RPC message. */
function createSseParser(onMessage) {
  let buf = '';
  return (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      try { onMessage(JSON.parse(payload)); } catch (_) { /* malformed: skip */ }
    }
  };
}

/** Build the prompt content blocks for one turn. Images ride as ACP image
 * blocks (agentCapabilities.promptCapabilities.image = true, verified). */
function buildPromptBlocks(text, images) {
  const blocks = [{ type: 'text', text: String(text || '') }];
  for (const image of Array.isArray(images) ? images : []) {
    const parsed = parseImageDataUrl(image);
    if (parsed) blocks.push({ type: 'image', data: parsed.data, mimeType: parsed.mimeType });
  }
  return blocks;
}

export class WorkbuddyAdapter {
  constructor({
    workbuddyPort,            // explicit worker port; auto-discovered otherwise
    cwd = process.cwd(),      // the workspace sessions live in
    log = () => {},
  } = {}) {
    this.opts = { cwd, log };
    this.workbuddyPort = workbuddyPort;
    this.port = null;
    this.base = null;
    this.connectionId = null;
    this.sessionToken = null;
    this.initialized = false;
    this.nextId = 1;
    this.#pending = new Map();           // rpc id → {resolve, reject}
    this.pendingPermissions = new Map(); // requestId → {sessionId, optionIds}
    this.sessions = new Map();           // sessionId → turn entry
    this.loadedSessions = new Set();     // sessions session/load-ed on this connection
    this.#newEntry = null;               // entry awaiting its sessionId (first turn)
    this.disposed = false;
  }

  #pending;
  #newEntry;

  async ensureConnection() {
    if (this.connectionId && this.sessionToken && this.initialized) return;
    if (this.disposed) throw new Error('bridge adapter already stopped');
    if (!this.port) this.port = resolveWorkbuddyPort({ workbuddyPort: this.workbuddyPort, log: this.opts.log });
    this.base = `http://127.0.0.1:${this.port}/api/v1/acp`;

    const connected = await this.#post('/connect', {}, CONNECT_TIMEOUT_MS);
    this.connectionId = connected?.connectionId;
    this.sessionToken = connected?.sessionToken;
    if (!this.connectionId || !this.sessionToken) {
      throw new Error(`workbuddy acp/connect failed: ${JSON.stringify(connected || null).slice(0, 200)}`);
    }
    await this.#rpc('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'agent-bridge', version: '1.0.0' },
    });
    // A fresh connection lost the daemon-side load state of this bridge's
    // sessions — force a session/load on their next turn.
    this.loadedSessions = new Set();
    this.initialized = true;
    this.opts.log(`connected to workbuddy worker on port ${this.port}`);
  }

  /** Raw HTTP POST (used for /connect). */
  async #post(path, body, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`http://127.0.0.1:${this.port}/api/v1/acp${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  #nextMessageId() { return this.nextId++; }

  /** One JSON-RPC POST. Notifications on the response stream are dispatched
   * through #handleMessage; the promise resolves with this request's result
   * (rejected on error response / transport failure / timeout). */
  #rpc(method, params, timeoutMs = RPC_TIMEOUT_MS) {
    const id = this.#nextMessageId();
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    const promise = new Promise((resolve, reject) => {
      // timeoutMs = 0 → no timer (session/prompt owns its lifetime; the bridge
      // interrupts via session/cancel and the fetch settles with it).
      const timer = timeoutMs
        ? setTimeout(() => {
            this.#pending.delete(id);
            reject(new Error(`workbuddy rpc timeout: ${method}`));
          }, timeoutMs)
        : null;
      this.#pending.set(id, {
        resolve: (v) => { if (timer) clearTimeout(timer); resolve(v); },
        reject: (e) => { if (timer) clearTimeout(timer); reject(e); },
      });
    });
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch(this.base, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            Authorization: `Bearer ${this.sessionToken}`,
            'acp-connection-id': this.connectionId,
          },
          body,
          signal: controller.signal,
        });
        if (!res.ok && res.status !== 500) {
          const text = await res.text().catch(() => '');
          throw new Error(`workbuddy ${method} → HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
        }
        if (!res.body) throw new Error(`workbuddy ${method}: empty response body`);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        const parser = createSseParser((msg) => this.#handleMessage(msg));
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          parser(decoder.decode(value, { stream: true }));
        }
      } catch (e) {
        const p = this.#pending.get(id);
        if (p) { this.#pending.delete(id); p.reject(e); }
      }
    })();
    return Object.assign(promise, { cancel: () => controller.abort() });
  }

  /** Route every parsed message: replies resolve their rpc; notifications and
   * server→client requests route to the turn entry by sessionId. A first-turn
   * entry awaiting its sessionId adopts the conversation as soon as any
   * session-scoped message names it (session/update frames can arrive before
   * the session/new HTTP response resolves). */
  #handleMessage(msg) {
    if (msg.id !== undefined && !msg.method) {
      const p = this.#pending.get(msg.id);
      if (!p) return;
      this.#pending.delete(msg.id);
      if (msg.error) {
        const err = new Error(msg.error.message || 'workbuddy rpc error');
        err.code = msg.error.code;
        p.reject(err);
      } else {
        p.resolve(msg.result);
      }
      return;
    }
    if (msg.method === 'session/request_permission') {
      const sessionId = msg.params?.sessionId;
      const entry = this.#entryFor(sessionId);
      if (!entry) return;
      entry.onPermission(msg);
      return;
    }
    if (msg.method === 'session/update') {
      const sessionId = msg.params?.sessionId;
      const entry = this.#entryFor(sessionId);
      if (!entry) return; // foreign session / config noise before adoption
      entry.onUpdate(msg.params?.update || {});
    }
  }

  #entryFor(sessionId) {
    let entry = this.sessions.get(sessionId);
    if (!entry && this.#newEntry) {
      entry = this.#newEntry;
      entry.sessionId = sessionId;
      this.sessions.set(sessionId, entry);
      this.#newEntry = null;
    }
    return entry;
  }

  #makeEntry(events) {
    return {
      sessionId: null,
      events,
      finished: false,
      full: '',
      thinking: false,
      toolStates: new Map(),
      stopTimer: null,
    };
  }

  async startTurn({ text, sessionId, images, onEvent }) {
    await this.ensureConnection();

    const entry = this.#makeEntry(onEvent);
    const emit = (ev) => { if (!entry.finished) entry.events?.(ev); };

    const onUpdate = (u) => {
      switch (u.sessionUpdate) {
        case 'agent_message_chunk':
          if (entry.thinking) { entry.thinking = false; emit({ type: 'delta', text: '\n</thinking>\n' }); }
          entry.full += u.content?.text || '';
          emit({ type: 'delta', text: u.content?.text || '' });
          break;
        case 'agent_thought_chunk':
          if (!entry.thinking) { entry.thinking = true; emit({ type: 'delta', text: '<thinking>\n' }); }
          emit({ type: 'delta', text: u.content?.text || '' });
          break;
        case 'tool_call': {
          if (entry.thinking) { entry.thinking = false; emit({ type: 'delta', text: '\n</thinking>\n' }); }
          const prev = entry.toolStates.get(u.toolCallId);
          entry.toolStates.set(u.toolCallId, u.status || 'in_progress');
          if (!prev || prev === 'pending') {
            emit({ type: 'tool', name: u.toolName || u.title || 'tool', status: 'started', detail: typeof u.rawInput === 'string' ? u.rawInput : '', id: u.toolCallId });
          }
          break;
        }
        case 'tool_call_update': {
          const prev = entry.toolStates.get(u.toolCallId);
          entry.toolStates.set(u.toolCallId, u.status || prev);
          if (u.status && u.status !== prev && (u.status === 'completed' || u.status === 'failed')) {
            emit({ type: 'tool', name: u.toolName || u.title || 'tool', status: 'completed', detail: typeof u.rawInput === 'string' ? u.rawInput : '', id: u.toolCallId });
          }
          break;
        }
        default:
          break; // config_option_update / session_info_update / user_message_chunk echo
      }
    };
    const onPermission = (msg) => {
      const params = msg.params || {};
      const optionIds = {};
      for (const o of params.options || []) {
        if (o?.kind === 'allow_once') optionIds.once = o.optionId;
        else if (o?.kind === 'allow_always') optionIds.always = o.optionId;
        else if (o?.kind === 'reject_once') optionIds.deny = o.optionId;
      }
      this.pendingPermissions.set(String(msg.id), { sessionId: entry.sessionId, optionIds });
      emit({ type: 'approval', requestId: String(msg.id), tool: params.toolCall?.title || 'tool', command: typeof params.toolCall?.rawInput === 'string' ? params.toolCall.rawInput : '' });
    };
    entry.onUpdate = onUpdate;
    entry.onPermission = onPermission;

    try {
      await this.ensureConnection();

      if (sessionId) {
        entry.sessionId = sessionId;
        this.sessions.set(sessionId, entry);
        if (!this.loadedSessions.has(sessionId)) {
          // First use on this connection: resume the persisted session. If
          // the worker no longer knows it, fall back to a FRESH session and
          // re-key — the start event carries the new id so clients re-map;
          // the note says plainly that earlier context does not carry over.
          try {
            await this.#rpc('session/load', { sessionId, cwd: this.opts.cwd, mcpServers: [] });
            this.loadedSessions.add(sessionId);
          } catch (e) {
            const created = await this.#rpc('session/new', { cwd: this.opts.cwd, mcpServers: [] }, RPC_TIMEOUT_MS);
            const sid = created?.sessionId;
            if (!sid) throw new Error('workbuddy session/new: no sessionId');
            this.sessions.delete(sessionId);
            entry.sessionId = sid;
            this.sessions.set(sid, entry);
            this.loadedSessions.add(sid);
            emit({ type: 'note', text: `previous session ${sessionId} is gone on the workbuddy worker (${e?.message || 'load failed'}) — continuing in a fresh session; earlier context does not carry over` });
            sessionId = sid;
          }
        }
        emit({ type: 'start', sessionId, turnId: '' });
        const blocks = buildPromptBlocks(text, images);
        const result = await this.#rpc('session/prompt', { sessionId, prompt: blocks }, 0);
        this.#finishTurn(entry, { stopReason: result?.stopReason, aborted: result?.stopReason === 'cancelled' });
      } else {
        this.#newEntry = entry;
        const created = await this.#rpc('session/new', { cwd: this.opts.cwd, mcpServers: [] }, RPC_TIMEOUT_MS);
        const sid = created?.sessionId || entry.sessionId;
        if (!sid) throw new Error('workbuddy session/new: no sessionId');
        entry.sessionId = sid;
        this.sessions.set(sid, entry);
        this.#newEntry = null;
        // a session created on this connection is loaded by definition
        this.loadedSessions.add(sid);
        emit({ type: 'start', sessionId: sid, turnId: '' });
        const blocks = buildPromptBlocks(text, images);
        const result = await this.#rpc('session/prompt', { sessionId: sid, prompt: blocks }, 0);
        this.#finishTurn(entry, { stopReason: result?.stopReason, aborted: result?.stopReason === 'cancelled' });
      }
      if (entry.finished) {
        return { sessionId: entry.sessionId, turnId: '' };
      }
      // Stream ended without an explicit final response — treat as done with
      // what we have (the daemon sometimes closes early on end_turn).
      entry.finished = true;
      if (entry.thinking) emit({ type: 'delta', text: '\n</thinking>\n' });
      emit({ type: 'done', full: entry.full });
      return { sessionId: entry.sessionId, turnId: '' };
    } catch (e) {
      if (!entry.finished) {
        entry.finished = true;
        emit({ type: 'error', message: e?.message || String(e) });
      }
      throw e;
    }
  }

  #finishTurn(entry, { aborted = false, failed = false, message = null, stopReason = null } = {}) {
    if (entry.finished) return;
    entry.finished = true;
    if (entry.thinking) entry.events?.({ type: 'delta', text: '\n</thinking>\n' });
    entry.thinking = false;
    if (aborted || stopReason === 'cancelled') { entry.events?.({ type: 'aborted' }); return; }
    if (failed) { entry.events?.({ type: 'error', message: message || 'workbuddy turn failed' }); return; }
    if (stopReason && stopReason !== 'end_turn') {
      // 其他罕见 stopReason（refusal 等）仍按正常收束呈报（browsa 以 done 呈现）。
      entry.events?.({ type: 'done', full: entry.full, usage: null, stopReason });
      return;
    }
    entry.events?.({ type: 'done', full: entry.full, usage: null });
  }

  async interrupt(sessionId) {
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.finished) return;
    try {
      await this.ensureConnection();
      await this.#rpc('session/cancel', { sessionId }, RPC_TIMEOUT_MS);
      // The prompt settles via stopReason 'cancelled' → aborted; a lost reply
      // must never leave the session busy forever.
      entry.stopTimer = setTimeout(() => this.#finishTurn(entry, { aborted: true }), RPC_TIMEOUT_MS);
    } catch (e) {
      this.opts.log(`interrupt failed: ${e.message}`);
      this.#finishTurn(entry, { aborted: true });
    }
  }

  async respondApproval(requestId, choice) {
    const pending = this.pendingPermissions.get(String(requestId));
    if (!pending) throw new Error(`no pending approval ${requestId}`);
    this.pendingPermissions.delete(String(requestId));
    const optId = pending.optionIds?.[choice];
    const outcome = optId
      ? { outcome: 'selected', optionId: optId }
      : (choice === 'deny' ? { outcome: 'cancelled' } : { outcome: 'selected' });
    await this.ensureConnection();
    const body = JSON.stringify({ jsonrpc: '2.0', id: Number(requestId) || requestId, result: { outcome } });
    const res = await fetch(this.base, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${this.sessionToken}`,
        'acp-connection-id': this.connectionId,
      },
      body,
    });
    if (!res.ok) throw new Error(`workbuddy permission respond → HTTP ${res.status}`);
  }

  listSessions() {
    return [...this.sessions.entries()].map(([sessionId, entry]) => ({
      sessionId,
      busy: !!(entry && !entry.finished),
    }));
  }

  stop() {
    this.disposed = true;
    // Pure HTTP client — nothing to kill; in-flight fetches settle on their own.
  }
}
