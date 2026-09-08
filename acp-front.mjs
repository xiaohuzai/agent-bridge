// agent-bridge/acp-front.mjs — the ACP v1 FRONT, transport-neutral.
//
// This is the heart of the public adoption door (AGENTS.md "Roadmap
// (dual-door strategy)"): a per-connection ACP-agent session that lets any
// ACP client (Zed-style editors, acpx, acp-ui, …) reach the bridge's agent
// WITHOUT ever learning the v1 HTTP+SSE wire. Two transports share this
// session unchanged:
//   acp-front-ws.mjs    — ACP over WebSocket at /acp on the bridge's port
//   acp-front-stdio.mjs — ACP over stdio (`agent-bridge acp`), i.e. the
//                         bridge itself spawnable AS an ACP agent (editors)
//
// The bridge acts as the ACP AGENT; the other side is the ACP client.
// Semantics are the mirror of adapters/acp-stdio.mjs's knowledge (that
// adapter documents the AGENT side of these messages; we speak the CLIENT
// side):
//   initialize  {protocolVersion} → {protocolVersion:1, agentCapabilities,
//                 agentInfo}   — we offer v1 only (v2 is still a tracking RFD)
//   session/new {cwd, mcpServers} → {sessionId}
//                 — client cwd is IGNORED: the bridge's cwd is config-owned
//                 (the agent subprocess is spawned with it at start time).
//                 When the adapter exposes createSession() (AcpStdioAdapter)
//                 the id is real and survives bridge restarts (the next
//                 session/prompt resumes via the adapter's session/resume
//                 path); otherwise a temporary id is bound to the internal
//                 session on the first `start` event.
//   session/prompt {sessionId, prompt:ContentBlock[]} → the RPC RESPONSE IS
//                 THE TURN TERMINATOR (v1): {stopReason:'end_turn'|
//                 'max_tokens'|'cancelled'|'refusal', usage:{inputTokens,
//                 outputTokens}} — usage rides the response, there is no
//                 separate usage event. Deltas stream out BEFORE the
//                 response as session/update notifications.
//   session/update NOTIFICATION {sessionId, update:{sessionUpdate:…}}:
//                 agent_message_chunk ← internal `delta`
//                 tool_call_update  ← internal `tool` (ids synthesized)
//   session/request_permission REQUEST {sessionId, toolCall, options}
//                 ← internal `approval`; answered by the client with
//                 {outcome:{outcome:'selected',optionId}} which maps back by
//                 `kind` to the core choice vocabulary once|always|deny.
//                 `cancelled` outcome → deny.
//   session/cancel NOTIFICATION → interrupt the in-flight turn (transport
//                 hang-up does the same — disconnect = abort, same
//                 philosophy as v1).
//   session/load {sessionId} → {} (no history replay; the id is adopted so
//                 the next prompt resumes the underlying agent session).
// ContentBlocks: text passes through; image {data,mimeType} becomes a data:
// URL for the core `images` array (≤8, same bound as v1); resource blocks
// degrade to a text note. Unknown rpc methods get -32601.

import crypto from 'node:crypto';

/** Create one ACP-agent session bound to a client connection.
 * wire: { send(obj) — push one JSON-RPC message to the client,
 *         close()  — hang the transport up }
 * onClosed: called once when the session tears down (either side). */
export function createAcpFrontSession({ adapter, agent, version = '0.0.0', log = () => {}, wire, onClosed }) {
  return new AcpFrontSession({ adapter, agent, version, log, wire, onClosed });
}

class AcpFrontSession {
  constructor({ adapter, agent, version, log, wire, onClosed }) {
    this.adapter = adapter;
    this.agent = agent;
    this.version = version;
    this.log = log;
    this.wire = wire;
    this.onClosed = onClosed;
    this.nextId = 1;                    // JSON-RPC ids on the FRONT wire
    this.permissions = new Map();       // front rpc id → {requestId, options}
    this.sessions = new Map();          // front sessionId → session entry
  }

  /** Feed one inbound message (already framed by the transport). */
  handleMessage(text) {
    let j;
    try { j = JSON.parse(text); } catch { return this.log('[acp-front] dropping unparseable frame'); }
    if (!j || typeof j !== 'object') return;
    // A response to one of OUR requests (session/request_permission):
    if (j.id !== undefined && !j.method && (j.result !== undefined || j.error !== undefined)) {
      this.#onClientResponse(j);
      return;
    }
    if (j.id !== undefined && typeof j.method === 'string') {
      const p = j.params || {};
      if (j.method === 'initialize') return this.#onInitialize(j.id, p);
      if (j.method === 'session/new') return this.#onSessionNew(j.id, p);
      if (j.method === 'session/prompt') return this.#onSessionPrompt(j.id, p);
      if (j.method === 'session/load') return this.#onSessionLoad(j.id, p);
      return this.#respondError(j.id, `agent-bridge: ${j.method} not supported`, -32601);
    }
    if (typeof j.method === 'string') {
      if (j.method === 'session/cancel') return this.#onSessionCancel(j.params || {});
      return this.log(`[acp-front] ignoring notification: ${j.method}`);
    }
  }

  destroy() {
    this.#teardown('disposed');
    try { this.wire.close(); } catch (_) {}
  }

  #onClientResponse(j) {
    const entry = this.permissions.get(String(j.id));
    if (!entry) return this.log(`[acp-front] response to unknown rpc id ${j.id}`);
    this.permissions.delete(String(j.id));
    const outcome = j.result?.outcome?.outcome;
    let choice = 'once';
    if (outcome === 'cancelled') {
      choice = 'deny';
    } else {
      const optionId = j.result?.outcome?.optionId;
      const kind = entry.options.find((o) => o.optionId === optionId)?.kind;
      choice = kind === 'allow_always' ? 'always'
        : (kind === 'reject_once' || kind === 'reject_always') ? 'deny'
        : 'once';
    }
    try {
      this.adapter.respondApproval(entry.requestId, choice);
      this.log(`[acp-front] permission ${entry.requestId} → ${choice} (client picked ${j.result?.outcome?.optionId})`);
    } catch (e) {
      this.log(`[acp-front] respondApproval failed: ${e.message}`);
    }
  }

  // --- ACP v1 methods ------------------------------------------------------

  #onInitialize(id) {
    this.#respond(id, {
      protocolVersion: 1,
      agentCapabilities: { promptCapabilities: { image: this.adapter.promptImage ?? true } },
      agentInfo: { name: `agent-bridge (${this.agent})`, version: this.version },
      authMethods: [],
    });
  }

  async #onSessionNew(id) {
    // Prefer a REAL session id (survives restarts via the adapter's resume
    // path); fall back to a temporary id bound on the first `start` event.
    try {
      if (typeof this.adapter.createSession === 'function') {
        const sid = await this.adapter.createSession();
        this.sessions.set(String(sid), this.#newEntry(String(sid), String(sid)));
        this.log(`[acp-front] session created ${String(sid).slice(0, 8)}…`);
        return this.#respond(id, { sessionId: String(sid) });
      }
    } catch (e) {
      return this.#respondError(id, e.message);
    }
    const temp = `wss-${crypto.randomUUID()}`;
    this.sessions.set(temp, this.#newEntry(temp, null));
    this.#respond(id, { sessionId: temp });
  }

  #newEntry(frontSid, internalSid) {
    return { frontSid, internalSid, busy: false, responded: false, cancelPending: false, toolKeys: new Map(), toolSeq: 0 };
  }

  #onSessionLoad(id, p) {
    const sid = String(p.sessionId || '');
    if (!this.sessions.has(sid)) this.sessions.set(sid, this.#newEntry(sid, sid)); // adopt: next prompt resumes
    this.#respond(id, {});
  }

  async #onSessionPrompt(id, p) {
    const sid = String(p.sessionId || '');
    let s = this.sessions.get(sid);
    if (!s) {
      // Unknown to this session: adopt the id as an INTERNAL session id —
      // covers restarts (the client kept the real session id) and lets the
      // adapter's session/resume path do the work. A bogus id surfaces as
      // the turn's error response.
      s = this.#newEntry(sid, sid);
      this.sessions.set(sid, s);
    }
    if (s.busy) return this.#respondError(id, 'acp: a turn is already in flight for this session');
    const { text, images } = this.#parseBlocks(p.prompt);
    if (!text.trim() && !images.length) return this.#respondError(id, 'prompt required');
    if (images.length > 8) return this.#respondError(id, 'images must be ≤8 (same bound as the v1 wire)');
    s.busy = true;
    s.responded = false;
    s.promptRpcId = id;
    this.log(`[acp-front] prompt → ${text.length} chars, ${images.length} image(s), session ${sid.slice(0, 8)}…`);
    try {
      await this.adapter.startTurn({
        text,
        sessionId: s.internalSid || undefined,
        images: images.length ? images : undefined,
        onEvent: (e) => this.#onTurnEvent(s, e),
      });
    } catch (e) {
      this.#answerPrompt(s, null, e.message); // admission failure (e.g. agent not installed)
    }
    // NOTE: startTurn may resolve before the turn ends (v2-style adapters
    // acknowledge); the prompt response is sent on the terminal EVENT, so
    // nothing to do with the resolved value here.
  }

  /** text/image ContentBlocks → core {text, images[]}. Images become data:
   * URLs (or ride through as https:// URIs); resource blocks degrade to a
   * text note — never written to disk. */
  #parseBlocks(prompt) {
    let text = '';
    const images = [];
    for (const b of Array.isArray(prompt) ? prompt : []) {
      if (b?.type === 'text' && typeof b.text === 'string' && b.text) {
        text += (text ? '\n' : '') + b.text;
      } else if (b?.type === 'image' && typeof b.data === 'string' && b.mimeType) {
        images.push(`data:${b.mimeType};base64,${b.data}`);
      } else if (b?.type === 'image' && typeof b.uri === 'string') {
        images.push(b.uri);
      } else if (b?.type) {
        text += (text ? '\n' : '') + `[unsupported content block: ${b.type}]`;
      }
    }
    return { text, images };
  }

  #onTurnEvent(s, e) {
    if (e.type === 'start' && e.sessionId && !s.internalSid) {
      s.internalSid = e.sessionId;
      if (s.cancelPending) {
        s.cancelPending = false;
        this.adapter.interrupt(s.internalSid).catch(() => {});
      }
    }
    if (s.responded) return; // turn already answered (e.g. local settle raced)
    if (e.type === 'delta') {
      if (e.text) this.#notify(s.frontSid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: e.text } });
    } else if (e.type === 'tool') {
      const key = `${e.name}|${e.detail}`;
      if (!s.toolKeys.has(key)) s.toolKeys.set(key, `t${++s.toolSeq}`);
      this.#notify(s.frontSid, {
        sessionUpdate: 'tool_call_update',
        toolCallId: s.toolKeys.get(key),
        title: e.detail || e.name || 'tool',
        status: e.status === 'started' ? 'in_progress' : e.status === 'completed' ? 'completed' : 'failed',
      });
    } else if (e.type === 'approval') {
      this.#forwardPermission(s, e);
    } else if (e.type === 'done') {
      this.#answerPrompt(s, {
        // ACP v1 stopReasons: end_turn | max_tokens | refusal | cancelled.
        // `refusal` rides the additive `stopReason` field the adapter emits
        // on done (the legacy finishReason only distinguishes length).
        stopReason: e.stopReason === 'refusal' ? 'refusal' : e.finishReason === 'length' ? 'max_tokens' : 'end_turn',
        usage: { inputTokens: e.usage?.prompt_tokens ?? 0, outputTokens: e.usage?.completion_tokens ?? 0 },
      });
    } else if (e.type === 'aborted') {
      this.#answerPrompt(s, { stopReason: 'cancelled' });
    } else if (e.type === 'error') {
      this.#answerPrompt(s, null, e.message || 'turn failed');
    }
    // `usage` events are intentionally not forwarded: v1 carries usage on
    // the prompt RESPONSE (see #answerPrompt), there is no standalone event.
  }

  #forwardPermission(s, e) {
    const rpcId = this.nextId++;
    // The adapter already echoes ACP-native options ({optionId,name,kind});
    // codex-native approvals carry none — synthesize the standard trio.
    const options = (Array.isArray(e.options) && e.options.length)
      ? e.options.map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind }))
      : [
          { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'always', name: 'Allow always', kind: 'allow_always' },
          { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
        ];
    this.permissions.set(String(rpcId), { requestId: e.requestId, options });
    this.log(`[acp-front] permission request ${e.requestId} → client (rpc id ${rpcId}): ${e.command || '(untitled)'}`);
    this.#send({
      jsonrpc: '2.0',
      id: rpcId,
      method: 'session/request_permission',
      params: {
        sessionId: s.frontSid,
        toolCall: { toolCallId: `perm-${e.requestId}`, title: e.command || 'permission request' },
        options,
      },
    });
  }

  #answerPrompt(s, result, errorMessage) {
    if (s.responded) return;
    s.responded = true;
    s.busy = false;
    if (s.promptRpcId === undefined || s.promptRpcId === null) return;
    if (errorMessage !== undefined) this.#respondError(s.promptRpcId, errorMessage);
    else this.#respond(s.promptRpcId, result);
    s.promptRpcId = null;
  }

  #onSessionCancel(p) {
    const s = this.sessions.get(String(p.sessionId || ''));
    if (!s) return;
    if (!s.busy) return;
    if (s.internalSid) {
      this.adapter.interrupt(s.internalSid).catch(() => {});
    } else {
      s.cancelPending = true; // admitted but not yet bound — cancel on start
    }
  }

  // --- wire plumbing & teardown ---------------------------------------------

  #send(obj) {
    try { this.wire.send(obj); } catch (_) {}
  }

  #respond(id, result) { this.#send({ jsonrpc: '2.0', id, result }); }

  #respondError(id, message, code = -32000) {
    this.#send({ jsonrpc: '2.0', id, error: { code, message } });
  }

  #notify(sessionId, update) {
    this.#send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } });
  }

  #teardown(why) {
    if (this.torndown) return;
    this.torndown = true;
    this.onClosed?.();
    let busy = 0;
    for (const s of this.sessions.values()) {
      if (!s.busy) continue;
      if (s.internalSid) this.adapter.interrupt(s.internalSid).catch(() => {});
      else s.cancelPending = true; // bind-on-start path: cancel as soon as it binds
      busy++;
    }
    if (busy) this.log(`[acp-front] client gone (${why}) — interrupting ${busy} in-flight turn(s)`);
    this.sessions.clear();
    this.permissions.clear();
  }
}
