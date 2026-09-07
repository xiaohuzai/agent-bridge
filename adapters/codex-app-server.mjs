// agent-bridge/adapters/codex-app-server.mjs — codex CLI adapter.
//
// Speaks the codex app-server JSON-RPC protocol (JSONL over stdio, the same
// interface the VS Code extension drives). All wire facts below were verified
// live against codex-cli 0.149.1 (2026-09-07, mock Responses backend; frames
// captured in the integration session) — do not "simplify" them:
//
//   initialize {clientInfo:{name,title,version}} → {userAgent, codexHome, …}
//   thread/start {cwd, sandbox:'read-only'|'workspace-write'|'danger-full-access',
//                 approvalPolicy:'never'|'on-request'|'untrusted'}
//               → {thread:{id, …}}            (sandbox is a kebab-case STRING
//                                              here — the schema's camelCase
//                                              SandboxPolicy objects belong to
//                                              a different layer; passing
//                                              {type:'readOnly'} 400s)
//   turn/start  {threadId, input:[{type:'text',text}]} → {turn:{id}} (immediately)
//   thread/resume {threadId} → {thread:{…}}     (restores a thread from disk
//                                               after this bridge restarted)
//   turn/interrupt {threadId, turnId} → {}      (turn/completed status:'interrupted')
//
//   notifications: turn/started; item/agentMessage/delta {itemId, delta};
//     item/started|item/completed {item:{type:'agentMessage'|'commandExecution'
//     |'fileChange'|…}}; thread/tokenUsage/updated {turnId, tokenUsage:{last:
//     {inputTokens, outputTokens}}}; thread/status/changed (activeFlags may
//     carry 'waitingOnApproval'); error {error:{message}, willRetry};
//     turn/completed {turn:{status:'completed'|'interrupted'|'failed', error, items}}.
//   server→client REQUESTS (must always be answered or codex blocks forever):
//     item/commandExecution/requestApproval {command, cwd, availableDecisions:
//       ['accept', {acceptWithExecpolicyAmendment:{…}}, 'cancel']} → answer
//       {decision:'accept'|'cancel'|{acceptWithExecpolicyAmendment}} (v2
//       vocabulary — the v1 execCommandApproval {decision:'approved'} enum is
//       a DIFFERENT namespace; answering it with 'accept' silently no-ops).
//
// Short replies may carry their full text only in item/completed with no
// agentMessage deltas at all (known codex behavior) — the turn assembler
// therefore falls back to completed items and de-dupes against deltas.

import { spawn } from 'node:child_process';

const INIT_TIMEOUT_MS = 15000;
const RPC_TIMEOUT_MS = 30000;

export class CodexAppServerAdapter {
  constructor({
    codexBin = 'codex',
    codexHome,
    cwd = process.cwd(),
    sandbox = 'read-only',        // 'read-only' | 'workspace-write' | 'danger-full-access'
    network = false,              // workspace-write networkAccess (read-only ignores it)
    approval = 'never',           // 'never' | 'on-request' | 'untrusted'
    log = () => {},
  } = {}) {
    this.opts = { codexBin, codexHome, cwd, sandbox, network, approval, log };
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();      // rpc id → {resolve, reject}
    this.threads = new Map();      // sessionId(threadId) → {turnId, full, sawDelta, itemTexts, usage, events}
    this.approvals = new Map();    // approval requestId → {method, params}
    this.buf = '';
    this.closed = false;
  }

  /** Spawn the app-server child (if needed) and run the initialize handshake. */
  async ensureChild() {
    if (this.child && this.child.exitCode === null) return;
    if (this.closed) throw new Error('bridge adapter already stopped');
    const { codexBin, codexHome, log } = this.opts;
    const env = { ...process.env };
    if (codexHome) env.CODEX_HOME = codexHome;
    this.child = spawn(codexBin, ['app-server'], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Windows: npm-installed CLIs are .cmd shims — spawn() throws EINVAL on
      // them without a shell (Node ≥18.20). 'app-server' carries no spaces or
      // metacharacters, so shell join is safe; a --codex-bin path containing
      // spaces must be quoted by the caller on Windows.
      shell: process.platform === 'win32',
      windowsHide: true,
    });
    this.threads.clear();
    this.child.stdout.on('data', (d) => this.#onData(String(d)));
    this.child.stderr.on('data', (d) => log(`[codex stderr] ${String(d).slice(0, 300)}`));
    this.child.on('exit', (code) => {
      log(`[codex] app-server exited (code=${code})`);
      for (const [, p] of this.pending) p.reject(new Error(`codex app-server exited (code=${code})`));
      this.pending.clear();
      this.child = null;
    });
    await this.rpc('initialize', {
      clientInfo: { name: 'agent-bridge', title: 'agent-bridge (browsa)', version: '1.0.0' },
    }, INIT_TIMEOUT_MS);
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
    // server→client REQUEST (has id AND method): must be answered. Approval
    // flavors are forwarded to the client; anything unknown gets a generic
    // refusal so codex never dead-locks waiting on us.
    if (j.id !== undefined && j.method) {
      const params = j.params || {};
      if (/requestApproval$/.test(j.method) || j.method === 'execCommandApproval' || j.method === 'applyPatchApproval') {
        this.approvals.set(String(j.id), { method: j.method, params });
        const t = this.threads.get(params.threadId);
        const command = typeof params.command === 'string'
          ? params.command
          : Array.isArray(params.command) ? params.command.join(' ') : (params.command || '');
        this.opts.log(`[codex] approval request id=${j.id}: ${command}`);
        t?.events?.({ type: 'approval', requestId: String(j.id), tool: 'command', command, cwd: params.cwd || '' });
      } else {
        // e.g. item/tool/requestUserInput, mcpServer/elicitation/request —
        // not modeled in v1; refuse so the turn can proceed.
        this.#write({ jsonrpc: '2.0', id: j.id, error: { code: -32601, message: `agent-bridge: ${j.method} not supported` } });
      }
      return;
    }
    // response to one of our rpcs
    if (j.id !== undefined) {
      const p = this.pending.get(j.id);
      if (!p) return;
      this.pending.delete(j.id);
      j.error ? p.reject(new Error(`${j.error.message || JSON.stringify(j.error)}`)) : p.resolve(j.result);
      return;
    }
    // notifications
    const params = j.params || {};
    const t = params.threadId ? this.threads.get(params.threadId) : null;
    // Turn-scoped match: normally the notification's turnId must equal the
    // tracked one — EXCEPT while a turn/start is still in flight (entry
    // pre-registered with turnId null): codex batches the turn/start RESPONSE
    // and the first notifications into the same stdio chunk, so without the
    // awaiting-window the earliest deltas would drop. Turns on one thread are
    // serial, so any turn-scoped frame in that window belongs to the new turn.
    const matches = (nt) => {
      if (!t) return false;
      if (t.awaitingTurnStart && !t.turnId) return true;
      return nt === t.turnId;
    };
    switch (j.method) {
      case 'turn/started': {
        if (!t) break;
        const id = params.turn?.id || params.turnId;
        if (t.awaitingTurnStart && !t.turnId && id) t.turnId = id;
        break;
      }
      case 'item/agentMessage/delta': {
        if (!matches(params.turnId)) break;
        t.sawDelta = true;
        t.deltaItems.add(params.itemId);
        t.full += params.delta || '';
        t.events?.({ type: 'delta', text: params.delta || '' });
        break;
      }
      case 'item/started': {
        const it = params.item || {};
        if (!matches(params.turnId)) break;
        if (it.type === 'commandExecution') t.events?.({ type: 'tool', name: 'command', status: 'started', detail: it.command || '' });
        else if (it.type === 'fileChange') t.events?.({ type: 'tool', name: 'file', status: 'started', detail: it.files?.join?.(', ') || '' });
        else if (it.type === 'mcpToolCall') t.events?.({ type: 'tool', name: it.tool || 'mcp', status: 'started', detail: it.server || '' });
        break;
      }
      case 'item/completed': {
        const it = params.item || {};
        if (!matches(params.turnId)) break;
        if (it.type === 'commandExecution') t.events?.({ type: 'tool', name: 'command', status: 'completed', detail: `${it.command || ''}${it.exitCode != null ? ` (exit ${it.exitCode})` : ''}` });
        // Short replies can arrive with NO deltas at all — remember completed
        // agentMessage texts so the assembler can fall back to them.
        if (it.type === 'agentMessage' && !t.deltaItems.has(it.id)) t.itemTexts.push(it.text || '');
        break;
      }
      case 'thread/tokenUsage/updated': {
        if (!matches(params.turnId)) break;
        const last = params.tokenUsage?.last;
        if (last) t.usage = { prompt_tokens: last.inputTokens ?? 0, completion_tokens: last.outputTokens ?? 0 };
        break;
      }
      case 'error': {
        if (!matches(params.turnId)) break;
        if (!t.finished) {
          t.finished = true;
          t.events?.({ type: 'error', message: params.error?.message || 'codex error' });
        }
        break;
      }
      case 'turn/completed': {
        // NOTE: unlike every other notification, turn/completed carries the
        // turn id NESTED (params.turn.id), not as params.turnId.
        const completedTurnId = params.turn?.id || params.turnId;
        if (!matches(completedTurnId)) break;
        if (t.finished) break;
        t.finished = true;
        const status = params.turn?.status;
        if (status === 'interrupted') {
          t.events?.({ type: 'aborted' });
        } else if (status === 'failed') {
          t.events?.({ type: 'error', message: params.turn?.error?.message || 'codex turn failed' });
        } else {
          // Assembled full text: streamed deltas win; completed-item texts
          // cover the no-delta case (delivered via item/completed OR only
          // inside turn/completed.items); both are concatenated when a turn
          // mixed delta'd and non-delta'd items.
          const itemText = (params.turn?.items || [])
            .filter((it) => it.type === 'agentMessage')
            .map((it) => it.text || '')
            .filter(Boolean).join('');
          const full = t.full || t.itemTexts.filter(Boolean).join('') || itemText;
          t.events?.({ type: 'done', full, usage: t.usage });
        }
        break;
      }
      default:
        break;
    }
  }

  #write(obj) {
    try { this.child?.stdin?.write(JSON.stringify(obj) + '\n'); } catch (_) {}
  }

  rpc(method, params, timeoutMs = RPC_TIMEOUT_MS) {
    const id = this.nextId++;
    const frame = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex rpc timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.#write(frame);
    });
  }

  /** Run one agent turn. Resolves as soon as the turn is ADMITTED (turn id
   * known); events flow through onEvent until done/aborted/error. */
  async startTurn({ text, sessionId, onEvent }) {
    await this.ensureChild();
    let threadId = sessionId || null;
    if (threadId && !this.threads.has(threadId)) {
      // Thread from a previous bridge lifetime — restore it from disk.
      await this.rpc('thread/resume', { threadId });
    }
    if (!threadId) {
      const thread = await this.rpc('thread/start', {
        cwd: this.opts.cwd,
        sandbox: this.opts.sandbox,
        approvalPolicy: this.opts.approval,
      });
      threadId = thread?.thread?.id;
      if (!threadId) throw new Error('codex thread/start: no thread id');
    }
    // Pre-register the turn entry BEFORE the turn/start rpc: codex batches
    // the response and the first notifications into the same stdio chunk,
    // and a post-await registration would drop that whole batch. The turnId
    // is patched in when the response (or turn/started) arrives; the
    // awaitingTurnStart window accepts turn-scoped frames until then.
    const entry = {
      turnId: null, awaitingTurnStart: true, full: '', sawDelta: false,
      deltaItems: new Set(), itemTexts: [], usage: null, finished: false, events: onEvent,
    };
    this.threads.set(threadId, entry);
    // Emit start BEFORE turn/start: the sessionId is already known here, and
    // emitting after the rpc would order it behind same-chunk deltas (the
    // client-visible order must be start → delta… → done). turnId is empty
    // until the admission response lands; the client doesn't need it.
    onEvent({ type: 'start', sessionId: threadId, turnId: '' });
    let r;
    try {
      // Per-turn sandboxPolicy uses the CORE camelCase object shape (unlike
      // thread/start's kebab string) — this is where networkAccess lives.
      const sandboxPolicy = this.opts.sandbox === 'workspace-write'
        ? { type: 'workspaceWrite', networkAccess: !!this.opts.network }
        : undefined;
      r = await this.rpc('turn/start', {
        threadId,
        input: [{ type: 'text', text }],
        ...(sandboxPolicy ? { sandboxPolicy } : {}),
      });
    } catch (e) {
      this.threads.delete(threadId);
      throw e;
    }
    const turnId = r?.turn?.id;
    if (!turnId) {
      this.threads.delete(threadId);
      throw new Error('codex turn/start: no turn id');
    }
    entry.turnId = turnId;
    entry.awaitingTurnStart = false;
    return { sessionId: threadId, turnId };
  }

  /** Best-effort interrupt of a session's current turn (client disconnect). */
  async interrupt(sessionId) {
    const t = this.threads.get(sessionId);
    if (!t || t.finished) return;
    try {
      await this.rpc('turn/interrupt', { threadId: sessionId, turnId: t.turnId });
    } catch (e) {
      this.opts.log(`[codex] interrupt failed: ${e.message}`);
    }
  }

  /** Answer a pending approval. choice ∈ 'once' | 'always' | 'deny'. */
  respondApproval(requestId, choice) {
    const entry = this.approvals.get(String(requestId));
    if (!entry) throw new Error(`no pending approval ${requestId}`);
    this.approvals.delete(String(requestId));
    const v2 = /requestApproval$/.test(entry.method);
    let decision;
    if (choice === 'deny') {
      decision = v2 ? 'cancel' : 'denied';
    } else if (choice === 'always' && v2 && Array.isArray(entry.params.proposedExecpolicyAmendment)) {
      // "always" = accept AND record the execpolicy amendment so future
      // matching commands skip the prompt (codex's own always-allow shape).
      decision = { acceptWithExecpolicyAmendment: { execpolicy_amendment: entry.params.proposedExecpolicyAmendment } };
    } else if (choice === 'always') {
      decision = v2 ? 'accept' : 'approved_for_session';
    } else {
      decision = v2 ? 'accept' : 'approved';
    }
    this.#write({ jsonrpc: '2.0', id: Number(requestId), result: { decision } });
  }

  stop() {
    this.closed = true;
    try { this.child?.stdin?.end(); } catch (_) {} // stdin EOF → codex exits even if the kill races
    try { this.child?.kill('SIGKILL'); } catch (_) {} // TerminateProcess on Windows
    this.child = null;
  }
}
