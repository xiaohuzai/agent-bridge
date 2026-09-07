// agent-bridge/adapters/acp-stdio.mjs — GENERIC adapter for ANY ACP agent.
//
// Spawns an arbitrary command that speaks the Agent Client Protocol
// (JSONL JSON-RPC over stdio) and translates it to the bridge's four core
// methods. One implementation covers the whole ACP agent ecosystem:
// claude-agent-acp, codex-acp, gemini --experimental-acp, opencode, hermes,
// kimi, qwen, … — new agents are a CLI flag, not new code.
//
// VERSION NEGOTIATION (live-verified 2026-09-07 against the two OFFICIAL
// shims — agentclientprotocol/codex-acp 1.10.0 and claude-agent-acp 0.75.1):
// both answer initialize with protocolVersion 1 no matter what the client
// requests. The bridge therefore requests 2 and ACCEPTS 1 or 2; anything
// else is refused.
//
// Wire facts (official schema + live frames; v1 facts captured from
// codex-acp driving codex-cli 0.149.1 through a volcengine gateway):
//   initialize  {protocolVersion:2, clientCapabilities:{}}
//              → {protocolVersion:1|2, agentCapabilities:{promptCapabilities:
//                 {image}?}, agentInfo, authMethods?}   (the Zed shim of the
//                 pre-official era put promptCapabilities under `capabilities`
//                 instead — both are read)
//   session/new {cwd, mcpServers:[]} → {sessionId}   (codex-acp also returns
//                 models.availableModels — ignored)
//   session/resume {sessionId, cwd} → {sessionId}   (restore after restart;
//                 exists on BOTH official shims — claude-agent-acp passes it
//                 down as `claude -p --resume <id>`)
//   session/prompt {sessionId, prompt:ContentBlock[]} — completion depends on
//       the negotiated version:
//       v2 → {} (ACCEPTANCE ONLY); the turn ends via `state_update` idle
//       v1 → the RPC RESPONSE IS THE TURN TERMINATOR:
//             {stopReason:'end_turn', usage:{totalTokens, inputTokens,
//             cachedReadTokens, outputTokens, thoughtTokens}} — usage maps to
//             prompt_tokens/completion_tokens; 'cancelled' on the response
//             (after session/cancel) surfaces as aborted. The rpc therefore
//             runs with NO timeout in v1 — a fixed one would kill every long
//             turn (a trivial reply took 17s through a real gateway).
//   session/cancel  NOTIFICATION {sessionId}   — and while a permission
//       request is pending, the client MUST answer it with
//       {outcome:{outcome:'cancelled'}}.
//   session/update NOTIFICATION {sessionId, update:{sessionUpdate:…}} (same
//       shapes in v1 and v2):
//       agent_message_chunk {content:{type:'text',text}} → delta
//       tool_call_update {toolCallId,title?,status:pending|in_progress|
//         completed|failed|cancelled} → tool events
//       usage_update {used,size?,cost?} → usage (v2; context tokens — there
//         is no per-turn output count, completion_tokens reported as 0)
//       state_update {state:'idle', stopReason?} → TURN END (v2):
//         end_turn→done · max_tokens→done(finishReason 'length') ·
//         cancelled→aborted · refusal→done (the refusal text is the reply)
//       unknown updates (available_commands_update, session_info_update,
//         _auth/status_update, …) are ignored
//   session/request_permission REQUEST {sessionId,title?,description?,options:
//       [{optionId,name,kind:allow_once|allow_always|reject_once|reject_always}]}
//       → {outcome:{outcome:'selected',optionId}} (kind-matched to the
//       client's once/always/deny) — options are echoed verbatim so any
//       client UI can render them.
// Prompt content: text is baseline; images are ONLY sent when the agent
// advertised capabilities.promptCapabilities.image in initialize (they ride
// as {type:'image', data, mimeType} for data: URLs, {type:'image', uri}
// otherwise). Undeclared-image turns degrade to text with a note.

import { spawn } from 'node:child_process';

const INIT_TIMEOUT_MS = 15000;
const RPC_TIMEOUT_MS = 30000;
const REQUESTED_ACP_VERSION = 2; // we speak 1–2; the agent picks ≤ requested

export class AcpStdioAdapter {
  constructor({
    command,                 // array: ['claude-code-acp'] or ['gemini','--experimental-acp']
    cwd = process.cwd(),
    log = () => {},
  } = {}) {
    if (!Array.isArray(command) || !command.length) throw new Error('acp adapter: command required');
    this.opts = { command, cwd, log };
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();     // rpc id → {resolve, reject}
    this.sessions = new Map();    // ACP sessionId → turn state
    this.permissions = new Map(); // permission request id → {sessionId, options}
    this.ready = false;
    this.buf = '';
    this.closed = false;
    this.rpcMethods = new Map(); // rpc id → method (for error-response logging)
    this.seenLogs = new Set();   // once-per-kind diagnostics (reset per child)
  }

  async ensureChild() {
    if (this.child && this.child.exitCode === null && this.ready) return;
    if (this.closed) throw new Error('bridge adapter already stopped');
    const { command, log } = this.opts;
    this.child = spawn(command[0], command.slice(1), {
      stdio: ['pipe', 'pipe', 'pipe'],
      // Windows: npm-installed CLI shims are .cmd — spawn needs a shell there.
      shell: process.platform === 'win32',
      windowsHide: true,
    });
    this.ready = false;
    this.child.stdout.on('data', (d) => this.#onData(String(d)));
    this.child.stderr.on('data', (d) => log(`[acp stderr] ${String(d).slice(0, 300)}`));
    this.child.on('exit', (code) => {
      log(`[acp] agent exited (code=${code})`);
      for (const [, p] of this.pending) p.reject(new Error(`acp agent exited (code=${code})`));
      this.pending.clear();
      this.child = null;
      this.ready = false;
    });
    // A spawn failure (agent command not installed / typo'd) arrives as an
    // async 'error' event — without a listener it is an uncaughtException
    // that kills the whole bridge. Reject the in-flight rpcs with an install
    // hint (relayed as the turn's SSE error) and allow a later retry.
    this.child.on('error', (err) => {
      const msg = err.code === 'ENOENT'
        ? `agent command not found: '${command[0]}' — install it, or pass an existing command after 'acp --'`
        : `failed to start agent '${command[0]}': ${err.message}`;
      log(`[acp] ${msg}`);
      for (const [, p] of this.pending) p.reject(new Error(msg));
      this.pending.clear();
      this.child = null;
      this.ready = false;
    });
    const res = await this.rpc('initialize', {
      protocolVersion: REQUESTED_ACP_VERSION,
      clientCapabilities: {},
    }, INIT_TIMEOUT_MS);
    const version = res?.protocolVersion;
    if (version !== 1 && version !== 2) {
      throw new Error(`acp agent speaks protocolVersion ${JSON.stringify(version)}, bridge supports 1–2`);
    }
    this.acpVersion = version;
    // promptCapabilities lives under agentCapabilities on the official shims
    // and under capabilities on the older Zed shim — read both.
    this.promptImage = !!(res?.agentCapabilities?.promptCapabilities?.image ?? res?.capabilities?.promptCapabilities?.image);
    const info = res?.agentInfo || {};
    this.opts.log(`[acp] agent ${info.name || '?'} v${info.version || '?'} — ACP v${version}, images: ${this.promptImage ? 'yes' : 'no'}`);
    this.ready = true;
    this.seenLogs.clear();
  }

  #onData(chunk) {
    this.buf += chunk;
    let idx;
    while ((idx = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let j;
      try { j = JSON.parse(line); } catch { continue; }
      this.#onFrame(j);
    }
  }

  #onFrame(j) {
    // agent→client REQUEST: session/request_permission must be answered.
    if (j.id !== undefined && j.method) {
      if (/request_permission$/.test(j.method)) {
        const params = j.params || {};
        const sessionId = params.sessionId;
        this.permissions.set(String(j.id), { sessionId, options: params.options || [] });
        const t = sessionId ? this.sessions.get(sessionId) : null;
        const kind = (k) => (params.options || []).find((o) => o.kind === k);
        const pick = (k) => kind(k)?.optionId ?? kind(k === 'deny' ? 'reject_always' : k)?.optionId ?? params.options?.[0]?.optionId ?? '';
        this.opts.log(`[acp] permission request id=${j.id}: ${params.title || params.description || '(untitled)'}`);
        t?.events?.({
          type: 'approval',
          requestId: String(j.id),
          tool: 'permission',
          command: params.title || params.description || '',
          choices: ['once', 'always', 'deny'],
          // ACP-native option ids, for clients that want to render the
          // agent's own labels instead of the three generic buttons:
          options: (params.options || []).map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind })),
          _pick: { once: pick('allow_once'), always: pick('allow_always'), deny: pick('deny') },
        });
      } else {
        // e.g. item/tool/requestUserInput, mcpServer/elicitation/request —
        // not modeled in v1; refuse so the turn can proceed.
        if (!this.seenLogs.has(`r:${j.method}`)) {
          this.seenLogs.add(`r:${j.method}`);
          this.opts.log(`[acp] refusing unsupported request: ${j.method}`);
        }
        this.#write({ jsonrpc: '2.0', id: j.id, error: { code: -32601, message: `agent-bridge: ${j.method} not supported` } });
      }
      return;
    }
    // response to our rpc
    if (j.id !== undefined) {
      const p = this.pending.get(j.id);
      if (!p) return;
      this.pending.delete(j.id);
      if (j.error) this.opts.log(`[acp] rpc error (${this.rpcMethods.get(j.id) || `id ${j.id}`}): ${j.error.message || JSON.stringify(j.error).slice(0, 200)}`);
      this.rpcMethods.delete(j.id);
      j.error ? p.reject(new Error(j.error.message || JSON.stringify(j.error))) : p.resolve(j.result);
      return;
    }
    // notifications
    if (j.method !== 'session/update') {
      if (!this.seenLogs.has(`n:${j.method}`)) {
        this.seenLogs.add(`n:${j.method}`);
        this.opts.log(`[acp] ignoring notification: ${j.method}`);
      }
      return;
    }
    const params = j.params || {};
    const t = params.sessionId ? this.sessions.get(params.sessionId) : null;
    if (!t || t.finished) return;
    const u = params.update || {};
    switch (u.sessionUpdate) {
      case 'agent_message_chunk': {
        const blocks = Array.isArray(u.content) ? u.content : [u.content].filter(Boolean);
        for (const b of blocks) {
          if (b?.type === 'text' && b.text) {
            t.full += b.text;
            t.events?.({ type: 'delta', text: b.text });
          }
        }
        break;
      }
      case 'tool_call_update': {
        const st = u.status;
        if (st === 'pending' || st === 'in_progress') {
          t.events?.({ type: 'tool', name: u.kind || 'tool', status: 'started', detail: u.title || u.toolCallId || '' });
        } else if (st === 'completed' || st === 'failed' || st === 'cancelled') {
          t.events?.({ type: 'tool', name: u.kind || 'tool', status: st === 'completed' ? 'completed' : 'failed', detail: `${u.title || u.toolCallId || ''}${st === 'failed' ? ' (failed)' : st === 'cancelled' ? ' (cancelled)' : ''}` });
        }
        break;
      }
      case 'usage_update': {
        if (typeof u.used === 'number') {
          t.usage = { prompt_tokens: u.used, completion_tokens: 0 };
        }
        break;
      }
      case 'state_update': {
        if (u.state !== 'idle') break; // 'running' / 'requires_action' need no turn event
        this.opts.log(`[acp] ← turn idle: stopReason=${u.stopReason || '(none)'}`);
        if (t.finished) break;
        t.finished = true;
        const stop = u.stopReason;
        if (stop === 'cancelled') t.events?.({ type: 'aborted' });
        else if (stop === 'refusal') t.events?.({ type: 'done', full: t.full, usage: t.usage, finishReason: '' });
        else t.events?.({ type: 'done', full: t.full, usage: t.usage, finishReason: stop === 'max_tokens' ? 'length' : '' });
        break;
      }
      default:
        break; // agent_thought_chunk, plan_update, … — not surfaced in v1
    }
  }

  #write(obj) {
    try { this.child?.stdin?.write(JSON.stringify(obj) + '\n'); } catch (_) {}
  }

  rpc(method, params, timeoutMs = RPC_TIMEOUT_MS) {
    const id = this.nextId++;
    if (method) this.rpcMethods.set(id, method);
    return new Promise((resolve, reject) => {
      // timeoutMs <= 0 means "no timer": a v1 session/prompt rpc stays
      // pending for the WHOLE turn (its response IS the completion), so a
      // fixed timeout would kill every long turn.
      const timer = timeoutMs > 0 ? setTimeout(() => {
        this.pending.delete(id);
        this.rpcMethods.delete(id);
        reject(new Error(`acp rpc timeout: ${method}`));
      }, timeoutMs) : null;
      this.pending.set(id, {
        resolve: (v) => { if (timer) clearTimeout(timer); this.rpcMethods.delete(id); resolve(v); },
        reject: (e) => { if (timer) clearTimeout(timer); this.rpcMethods.delete(id); reject(e); },
      });
      this.#write({ jsonrpc: '2.0', id, method, params });
    });
  }

  async #ensureSession(sessionId) {
    await this.ensureChild();
    if (sessionId && this.sessions.has(sessionId)) return sessionId;
    if (sessionId) {
      // Session from a previous bridge lifetime — ACP v2 has session/resume.
      await this.rpc('session/resume', { sessionId, cwd: this.opts.cwd });
      this.opts.log(`[acp] session resumed ${String(sessionId).slice(0, 8)}…`);
      return sessionId;
    }
    const r = await this.rpc('session/new', { cwd: this.opts.cwd, mcpServers: [] });
    const sid = r?.sessionId;
    if (!sid) throw new Error('acp session/new: no sessionId');
    this.opts.log(`[acp] session created ${String(sid).slice(0, 8)}…`);
    return sid;
  }

  async startTurn({ text, sessionId, images, onEvent }) {
    const sid = await this.#ensureSession(sessionId);
    const t = this.sessions.get(sid) || {};
    if (t.finished === false && t.promptInFlight) {
      throw new Error('acp: a turn is already in flight for this session');
    }
    const blocks = [{ type: 'text', text }];
    let dropped = 0;
    for (const url of Array.isArray(images) ? images : []) {
      const m = /^data:([^;,]+);base64,(.+)$/s.exec(url);
      if (this.promptImage && m) blocks.push({ type: 'image', data: m[2], mimeType: m[1] });
      else if (this.promptImage) blocks.push({ type: 'image', uri: url });
      else dropped++;
    }
    if (dropped) blocks.push({ type: 'text', text: `\n[agent-bridge: ${dropped} image(s) omitted — this agent does not advertise image input]` });
    const entry = {
      sessionId: sid, full: '', sawIdle: false, usage: null, finished: false,
      promptInFlight: true, events: onEvent,
    };
    this.sessions.set(sid, entry);
    onEvent({ type: 'start', sessionId: sid, turnId: '' });
    this.opts.log(`[acp] prompt → ${text.length} chars, ${Array.isArray(images) ? images.length : 0} image(s)${dropped ? `, ${dropped} dropped` : ''}`);
    let r;
    try {
      // v1: the response IS the completion — no timeout, cancellable only
      // via session/cancel (which makes the shim answer with stopReason
      // 'cancelled'). v2: the rpc is an acceptance ack — normal timeout.
      r = await this.rpc('session/prompt', { sessionId: sid, prompt: blocks }, this.acpVersion === 1 ? 0 : RPC_TIMEOUT_MS);
    } catch (e) {
      this.sessions.delete(sid);
      onEvent({ type: 'error', message: e.message });
      return { sessionId: sid, turnId: '' };
    }
    if (r && typeof r.stopReason === 'string') {
      // v1 completion: the prompt response carries the final stopReason and
      // the turn's usage (v2 completes via state_update instead).
      entry.promptInFlight = false;
      if (r.usage) entry.usage = { prompt_tokens: r.usage.inputTokens ?? 0, completion_tokens: r.usage.outputTokens ?? 0 };
      this.opts.log(`[acp] ← prompt response: stopReason=${r.stopReason}${entry.usage ? `, usage ${entry.usage.prompt_tokens}/${entry.usage.completion_tokens}` : ', no usage'}`);
      if (!entry.finished) {
        entry.finished = true;
        if (r.stopReason === 'cancelled') onEvent({ type: 'aborted' });
        else onEvent({ type: 'done', full: entry.full, usage: entry.usage, finishReason: r.stopReason === 'max_tokens' ? 'length' : '' });
      }
    }
    return { sessionId: sid, turnId: '' };
  }

  /** Cancel a session's in-flight turn. Also answers any pending permission
   * request with the ACP-mandated `cancelled` outcome. */
  async interrupt(sessionId) {
    const t = this.sessions.get(sessionId);
    if (!t || t.finished) return;
    for (const [reqId, p] of this.permissions) {
      if (p.sessionId !== sessionId) continue;
      this.permissions.delete(reqId);
      this.#write({ jsonrpc: '2.0', id: Number(reqId), result: { outcome: { outcome: 'cancelled' } } });
    }
    try {
      await this.rpc('session/cancel', { sessionId });
    } catch (e) {
      this.opts.log(`[acp] cancel failed: ${e.message}`);
    }
    // The shim is NOT required to answer the pending session/prompt rpc
    // after a cancel (codex-acp 1.10.0 doesn't — live-verified), and the
    // response could take up to claude-agent-acp's 30s force-cancel grace.
    // Settle the entry locally so the session is never stuck "in flight"
    // and later turns on it can proceed. If the shim does answer late, the
    // finished guard makes it a no-op.
    if (!t.finished) {
      t.finished = true;
      t.promptInFlight = false;
      this.opts.log(`[acp] settling session locally after cancel (shim did not answer the pending prompt)`);
      t.events?.({ type: 'aborted' });
    }
  }

  /** Answer a pending permission request. choice ∈ 'once'|'always'|'deny',
   * mapped onto the agent's own optionIds by their `kind`. */
  respondApproval(requestId, choice) {
    const entry = this.permissions.get(String(requestId));
    if (!entry) throw new Error(`no pending permission request ${requestId}`);
    this.permissions.delete(String(requestId));
    const byKind = (k) => entry.options.find((o) => o.kind === k);
    const kind = choice === 'deny' ? (byKind('reject_once') || byKind('reject_always')) : choice === 'always' ? (byKind('allow_always') || byKind('allow_once')) : (byKind('allow_once') || byKind('allow_always'));
    const optionId = kind?.optionId ?? entry.options[0]?.optionId;
    if (!optionId) throw new Error('acp permission request had no options');
    this.#write({ jsonrpc: '2.0', id: Number(requestId), result: { outcome: { outcome: 'selected', optionId } } });
  }

  listSessions() {
    return [...this.sessions.entries()].map(([sessionId, t]) => ({
      sessionId,
      busy: !!(t && !t.finished),
    }));
  }

  stop() {
    this.closed = true;
    try { this.child?.stdin?.end(); } catch (_) {}
    try { this.child?.kill('SIGKILL'); } catch (_) {}
    this.child = null;
  }
}
