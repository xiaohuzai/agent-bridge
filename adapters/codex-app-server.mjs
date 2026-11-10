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
//     item/reasoning/summaryTextDelta {threadId,turnId,itemId,summaryIndex,
//     delta} · item/reasoning/textDelta {…,contentIndex,delta} (schema dump of
//     codex-cli 0.149.1, 2026-10-09 — surfaced as an inline <thinking> block
//     that joins done.full; a completed-only reasoning item {content[]+
//     summary[], arrays of strings} joins it too); item/started|item/completed
//     {item:{type:'agentMessage'|'reasoning'|'commandExecution'
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
// Short replies may carry their full text only in item/completed (or even
// only inside turn/completed.items) with no agentMessage deltas at all (known
// codex behavior) — the turn assembler falls back to those texts, de-duped by
// item id. `tool` events carry the item's own id in an additive `id` field so
// clients can pair a call's started/completed updates (the detail strings
// differ between them); fileChange/mcpToolCall items emit BOTH, like
// commandExecution.
//
// MULTI-MESSAGE TURNS (2026-10-06, user field report): one turn can carry
// SEVERAL agentMessage items — the model narrates before tool calls ("I'm
// using the X skill to check which workflows apply.") and answers after them.
// Concatenating every item into done.full leaks the narration into the reply
// body (browsa bug report: a bare "hi" came back as narration + answer in one
// bubble). Classification uses codex's OWN phase field (present on the
// agentMessage item in app-server 0.149.1, verified in the generated schema:
// "commentary" | "final_answer"; per the schema, providers do not always emit
// it, so null = unknown):
//
//   done.full   = the last item NOT labeled 'commentary' (phase null counts —
//                 legacy-model compat). All-commentary turns fall back to the
//                 last item so the reply is never silently emptied.
//   note events = every other item, emitted just before done as
//                 {type:'note', text, phase?} — additive; v1 clients that
//                 ignore unknown event types keep the old concat only if they
//                 also ignore done.full, so clients SHOULD prefer done.full
//                 when it is non-empty.
//
// Single-message turns (the overwhelming majority) are byte-identical to the
// old behavior. The official codex-acp shim was evaluated for this and NOT
// adopted (user decision 2026-10-06): it hides phase behind the JetBrains AIR
// _meta (airOnlyMeta) and still `return null`s completed agentMessages, so
// the boundary work would land in OUR ACP adapter anyway with worse signal.

import { v1Usage } from './usage.mjs';
import { createJsonlRpc } from './jsonl-rpc.mjs';

const INIT_TIMEOUT_MS = 15000;

/** Build a v1 `tool` event. `id` (additive on the wire) is the agent's own
 * tool-call id — clients pair a call's started/completed updates on it,
 * because the detail strings differ between them (codex appends " (exit N)"). */
function toolEv(name, status, detail, id) {
  return { type: 'tool', name, status, detail, ...(id ? { id } : {}) };
}

/** Can this completed agentMessage text still join the turn's item list?
 * De-dupes against streamed deltas and already-captured items; an item with
 * NO id cannot be de-duped, so it is trusted only when nothing streamed. */
function unseen(t, it) {
  return it.type === 'agentMessage' && !!it.text
    && !t.deltaItems.has(it.id) && !t.itemIds.has(it.id)
    && (it.id != null || !t.sawDelta);
}

/** Close the agentMessage currently being streamed into the ordered item
 * list (a NEW agentMessage boundary supersedes it — it can no longer be the
 * turn's final message). Empty text (e.g. an item/started with no deltas yet)
 * closes to nothing. */
function closeCurMsg(t) {
  if (t.curMsg?.text) {
    t.items.push({ id: t.curMsg.id, text: t.curMsg.text, phase: t.curMsg.phase ?? null });
    if (t.curMsg.id != null) t.itemIds.add(t.curMsg.id);
  }
  t.curMsg = null;
}

/** Close an open <thinking> delta run (stream tags only — the assembled
 * done.full re-wraps t.thinkingText itself at turn end). */
function closeThinking(t) {
  if (!t.thinking) return;
  t.thinking = false;
  t.events?.({ type: 'delta', text: '\n</thinking>\n' });
}

export class CodexAppServerAdapter {
  constructor({
    codexBin = 'codex',
    codexHome,
    cwd = process.cwd(),
    sandbox = 'read-only',        // 'read-only' | 'workspace-write' | 'danger-full-access'
    network = false,              // workspace-write networkAccess (read-only ignores it)
    approval = 'never',           // 'never' | 'on-request' | 'untrusted'
    env = {},                     // per-entry {VAR: value} merged over the daemon env
    log = () => {},
  } = {}) {
    this.opts = { codexBin, codexHome, cwd, sandbox, network, approval, env, log };
    this.threads = new Map();      // sessionId(threadId) → {turnId, items, curMsg, sawDelta, usage, events}
    this.approvals = new Map();    // approval requestId → {method, params}
    this.link = createJsonlRpc({
      command: [codexBin, 'app-server'],
      cwd,
      // CODEX_HOME and the entry's own env override the daemon env; the
      // bundled shim PATH is appended underneath (adapters/agent-env.mjs).
      env: { ...(codexHome ? { CODEX_HOME: codexHome } : {}), ...env },
      label: 'codex',
      description: 'codex app-server',
      notFound: (bin) => `codex CLI not found: '${bin}' — install it with: npm i -g @openai/codex, or pass --codex-bin /path/to/codex`,
      startFailed: (bin, err) => `failed to start codex '${bin}': ${err.message}`,
      log,
      onFrame: (j) => this.#onFrame(j),
      onDown: ({ child, all, message }) => {
        this.approvals.clear();
        this.#settleTurns((t) => all || t.child === child, message);
        if (all) this.threads.clear();
      },
      handshake: async (link) => {
        await link.rpc('initialize', {
          clientInfo: { name: 'agent-bridge', title: 'agent-bridge', version: '1.0.0' },
        }, INIT_TIMEOUT_MS);
      },
    });
  }

  /** Spawn the app-server child (if needed) and run the initialize handshake. */
  async ensureChild() {
    await this.link.ensure();
  }

  /** The live app-server child (tests kill it to exercise the death path). */
  get child() { return this.link.child; }

  #settleTurns(match, msg) {
    for (const [, t] of this.threads) {
      if (t.finished || !match(t)) continue;
      t.finished = true;
      t.events?.({ type: 'error', message: `${msg} mid-turn` });
    }
  }

  #onFrame(j) {
    // server→client REQUEST (has id AND method): must be answered. Approval
    // flavors are forwarded to the client; anything unknown gets a generic
    // refusal so codex never dead-locks waiting on us.
    if (j.id !== undefined && j.method) {
      const params = j.params || {};
      if (/requestApproval$/.test(j.method) || j.method === 'execCommandApproval' || j.method === 'applyPatchApproval') {
        // The raw rpc id is kept for the answer: JSON-RPC ids may be strings,
        // and coercing back through Number() would answer with id null — the
        // agent would block forever on the unanswered request.
        this.approvals.set(String(j.id), { id: j.id, method: j.method, params });
        const t = this.threads.get(params.threadId);
        const command = typeof params.command === 'string'
          ? params.command
          : Array.isArray(params.command) ? params.command.join(' ') : (params.command || '');
        this.opts.log(`[codex] approval request id=${j.id}: ${command}`);
        t?.events?.({ type: 'approval', requestId: String(j.id), tool: 'command', command, cwd: params.cwd || '' });
      } else {
        // e.g. item/tool/requestUserInput, mcpServer/elicitation/request —
        // not modeled in v1; refuse so the turn can proceed.
        this.link.write({ jsonrpc: '2.0', id: j.id, error: { code: -32601, message: `agent-bridge: ${j.method} not supported` } });
      }
      return;
    }
    // response to one of our rpcs
    if (j.id !== undefined) {
      const p = this.link.pending.get(j.id);
      if (!p) return;
      this.link.pending.delete(j.id);
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
        closeThinking(t);
        // A delta for a DIFFERENT item than the one streaming = the previous
        // message just got superseded (multi-message turn): close it as a
        // future note before appending to the new one. Delta frames carry no
        // phase — it arrives on the item's started/completed frames.
        if (t.curMsg && params.itemId !== t.curMsg.id) closeCurMsg(t);
        if (!t.curMsg) t.curMsg = { id: params.itemId, text: '', phase: null };
        t.sawDelta = true;
        t.deltaItems.add(params.itemId);
        t.curMsg.text += params.delta || '';
        t.events?.({ type: 'delta', text: params.delta || '' });
        break;
      }
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta': {
        // codex streams reasoning as it thinks (schema-verified 0.149.1:
        // item/reasoning/summaryTextDelta {threadId,turnId,itemId,summaryIndex,
        // delta} · item/reasoning/textDelta {…,contentIndex,delta}). Surfaced
        // as an inline <thinking> delta run; t.thinkingText re-joins it into
        // done.full at turn end (2026-10-09: reasoning used to be dropped).
        if (!matches(params.turnId) || t.finished) break;
        const delta = typeof params.delta === 'string' ? params.delta : '';
        if (!delta) break;
        if (params.itemId != null) t.itemIds.add(params.itemId);
        if (!t.thinking) { t.thinking = true; t.thinkingText += (t.thinkingText ? '\n\n' : ''); t.events?.({ type: 'delta', text: '<thinking>\n' }); }
        t.thinkingText += delta;
        t.events?.({ type: 'delta', text: delta });
        break;
      }
      case 'item/started': {
        const it = params.item || {};
        if (!matches(params.turnId)) break;
        if (it.type === 'agentMessage') {
          // agentMessage items frame message boundaries too — a started for a
          // new id supersedes whatever was streaming (defensive: the delta
          // handler closes on id change anyway, so this only moves the
          // boundary earlier when codex sends started before deltas). The
          // started frame is where phase usually arrives first.
          if (t.curMsg && it.id !== t.curMsg.id) closeCurMsg(t);
          if (!t.curMsg && it.id != null) t.curMsg = { id: it.id, text: '', phase: it.phase ?? null };
        } else if (it.type === 'commandExecution') t.events?.(toolEv('command', 'started', it.command || '', it.id ?? params.itemId));
        else if (it.type === 'fileChange') t.events?.(toolEv('file', 'started', it.files?.join?.(', ') || '', it.id ?? params.itemId));
        else if (it.type === 'mcpToolCall') t.events?.(toolEv(it.tool || 'mcp', 'started', it.server || '', it.id ?? params.itemId));
        break;
      }
      case 'item/completed': {
        const it = params.item || {};
        if (!matches(params.turnId)) break;
        // EVERY tool-bearing item completes — fileChange/mcpToolCall included:
        // a started with no completed leaves client tool rows stuck mid-call.
        if (it.type === 'commandExecution') t.events?.(toolEv('command', 'completed', `${it.command || ''}${it.exitCode != null ? ` (exit ${it.exitCode})` : ''}`, it.id ?? params.itemId));
        else if (it.type === 'fileChange') t.events?.(toolEv('file', 'completed', it.files?.join?.(', ') || '', it.id ?? params.itemId));
        else if (it.type === 'mcpToolCall') t.events?.(toolEv(it.tool || 'mcp', 'completed', it.server || '', it.id ?? params.itemId));
        if (it.type !== 'agentMessage' || !it.text) break;
        if (t.curMsg && it.id === t.curMsg.id) {
          // The streaming item's own completed: deltas are authoritative;
          // adopt the completed text only when it carries MORE than they did,
          // and the phase whenever the item frame carries one.
          if (it.text.length > t.curMsg.text.length) t.curMsg.text = it.text;
          if (it.phase != null) t.curMsg.phase = it.phase;
          closeCurMsg(t);
        } else if (unseen(t, it)) {
          // A message delivered whole, never streamed (known short-reply
          // behavior). Its arrival also supersedes any still-open item —
          // codex emits items sequentially, so this one comes after it.
          closeCurMsg(t);
          t.items.push({ id: it.id, text: it.text, phase: it.phase ?? null });
          if (it.id != null) t.itemIds.add(it.id);
        }
        break;
      }
      case 'thread/tokenUsage/updated': {
        if (!matches(params.turnId)) break;
        const last = params.tokenUsage?.last;
        if (last) {
          // Codex's inputTokens is the WHOLE prompt (cached tokens included);
          // cachedInputTokens/cacheWriteInputTokens are subsets. Forward them
          // as cache telemetry without inflating prompt_tokens.
          const cached = last.cachedInputTokens ?? last.cached_input_tokens ?? 0;
          const cacheWrite = last.cacheWriteInputTokens ?? last.cache_write_input_tokens ?? 0;
          t.usage = v1Usage({
            promptTokens: last.inputTokens ?? 0,
            completionTokens: last.outputTokens ?? 0,
            cachedTokens: cached > 0 ? cached : undefined,
            cacheWriteTokens: cacheWrite > 0 ? cacheWrite : undefined,
          });
        }
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
          // Assemble the turn's ordered agentMessage list: closed items in
          // arrival order (streamed + completed-only), plus texts that never
          // left turn/completed.items — de-duped by item id. The answer is
          // the last item NOT labeled phase:'commentary' (null = unknown
          // counts, legacy-model compat; an all-commentary turn falls back
          // to the last item so the reply is never silently emptied). Every
          // other item rides out as a `note` event (additive) just before
          // done, instead of leaking into the reply body.
          closeCurMsg(t);
          closeThinking(t);
          for (const it of params.turn?.items || []) {
            if (it?.type === 'reasoning') {
              // Reasoning rides the item/reasoning/* deltas; a completed-only
              // reasoning item (short/non-streaming turns) joins the assembled
              // thinking block here. Never a note, never the reply body
              // (ReasoningThreadItem: content[] + summary[] arrays of strings,
              // schema-verified 0.149.1).
              if (it.id == null || !t.itemIds.has(it.id)) {
                const text = [
                  ...(Array.isArray(it.content) ? it.content : []),
                  ...(Array.isArray(it.summary) ? it.summary : []),
                ].filter((s) => typeof s === 'string' && s).join('\n\n');
                if (text) t.thinkingText += (t.thinkingText ? '\n\n' : '') + text;
                if (it.id != null) t.itemIds.add(it.id);
              }
              continue;
            }
            if (unseen(t, it)) {
              t.items.push({ id: it.id, text: it.text, phase: it.phase ?? null });
              if (it.id != null) t.itemIds.add(it.id);
            }
          }
          let answer = -1;
          for (let i = t.items.length - 1; i >= 0; i--) {
            if (t.items[i].phase !== 'commentary') { answer = i; break; }
          }
          if (answer === -1) answer = t.items.length - 1;
          for (let i = 0; i < t.items.length; i++) {
            const item = t.items[i];
            if (i !== answer && item.text) {
              t.events?.({ type: 'note', text: item.text, ...(item.phase ? { phase: item.phase } : {}) });
            }
          }
          const answerText = answer >= 0 ? (t.items[answer].text || '') : '';
          const full = t.thinkingText ? `<thinking>\n${t.thinkingText}\n</thinking>\n\n${answerText}` : answerText;
          t.events?.({ type: 'done', full, usage: t.usage });
        }
        break;
      }
      default:
        break;
    }
  }

  rpc(method, params, timeoutMs) {
    return this.link.rpc(method, params, timeoutMs);
  }

  /** Run one agent turn. Resolves as soon as the turn is ADMITTED (turn id
   * known); events flow through onEvent until done/aborted/error.
   * images: optional array of https:/data: URLs — codex accepts data: URLs
   * directly (verified live 2026-09-07: they ride through to the model
   * backend as input_image parts, no temp files needed). */
  async startTurn({ text, sessionId, images, onEvent }) {
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
    // Same session discipline as the ACP adapter: a second turn on a session
    // with a turn still in flight would overwrite the entry mid-stream (the
    // in-flight turn's frames would bleed into the new stream). Refuse it —
    // server.mjs relays this as the turn's clean SSE error.
    const existing = this.threads.get(threadId);
    if (existing && !existing.finished) {
      throw new Error('codex: a turn is already in flight for this session');
    }
    // Pre-register the turn entry BEFORE the turn/start rpc: codex batches
    // the response and the first notifications into the same stdio chunk,
    // and a post-await registration would drop that whole batch. The turnId
    // is patched in when the response (or turn/started) arrives; the
    // awaitingTurnStart window accepts turn-scoped frames until then.
    // items/curMsg carry the multi-message assembly (see the file header):
    // curMsg is the agentMessage item currently streaming; items is the
    // ordered closed list whose last entry becomes done.full.
    const entry = {
      turnId: null, awaitingTurnStart: true, sawDelta: false,
      deltaItems: new Set(), itemIds: new Set(), items: [], curMsg: null,
      thinking: false, thinkingText: '',
      usage: null, finished: false, events: onEvent, child: this.link.child,
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
        input: [
          { type: 'text', text },
          ...(Array.isArray(images) ? images.map((url) => ({ type: 'image', url })) : []),
        ],
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
      // Success: codex answers with turn/completed(interrupted) and the turn
      // settles through the normal event path.
    } catch (e) {
      // Same discipline as the ACP adapter: a lost/failed interrupt must
      // never leave the session busy forever (wedged child, lost answer).
      // Settle locally — late turn/completed frames are no-ops (finished).
      this.opts.log(`[codex] interrupt failed: ${e.message}`);
      t.finished = true;
      t.events?.({ type: 'aborted' });
    }
  }

  /** Name the thread so it's findable in `codex resume` (by name or id).
   * Codex 0.149.1 app-server: thread/name/set {threadId, name} → {} plus a
   * thread/name/updated notification (verified live 2026-10-01). Throws on
   * protocol failure — the server maps that to a 5xx; a thread that was
   * never started (unknown id) surfaces codex's own error. */
  async renameSession(sessionId, name) {
    if (!sessionId || !name || !String(name).trim()) throw new Error('codex rename: sessionId and name required');
    await this.ensureChild(); // #write is a silent no-op before the child exists — spawn first
    await this.rpc('thread/name/set', { threadId: sessionId, name: String(name).trim() });
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
    this.link.write({ jsonrpc: '2.0', id: entry.id, result: { decision } });
  }

  /** Known sessions for GET /sessions: lets a client recover session ids
   * after its own restart. busy = a turn is currently in flight. */
  listSessions() {
    return [...this.threads.entries()].map(([sessionId, t]) => ({
      sessionId,
      busy: !!(t && !t.finished),
    }));
  }

  stop() {
    this.link.stop();
  }
}
