#!/usr/bin/env node
// test/fake-acp-agent.mjs — a scripted stand-in for any ACP v2 agent
// (JSONL JSON-RPC over stdio) so the generic ACP adapter is exercised
// end-to-end without a real agent install.
//
// Behavior keyed off the prompt text:
//   'APPROVE'  → sends session/request_permission (id 900), waits for the
//                client's answer, then completes (echoing the chosen kind).
//   'SLOW'     → one delta, then idles; reacts to session/cancel with
//                stopReason 'cancelled' and writes FAKE_CANCELLED to stderr.
//   'FAIL'     → failed tool call + state_update idle with stopReason
//                'refusal'.
//   'IMG'      → reports the number of image blocks + their mimeType.
//   otherwise  → two deltas + usage_update + state_update idle (end_turn).
// Every received method is echoed to stderr as FAKE_METHOD:<m>.

process.stdout.on('error', () => {}); // EPIPE when the adapter kills us
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const err = (s) => process.stderr.write(s + '\n');

const sessions = new Set();

// v1 mode (argv 'v1'): the OFFICIAL shims' dialect (agentclientprotocol/
// codex-acp, claude-agent-acp) — initialize replies protocolVersion 1, there
// is NO prompt ack, and the session/prompt RPC response IS the turn
// terminator ({stopReason, usage}). v2 mode: ack + state_update idle.
const V1 = process.argv[2] === 'v1';
const pendingPrompt = new Map(); // sessionId → pending session/prompt rpc id
const hangSessions = new Set();  // v1: sessions whose prompt must NEVER be answered (wedged-shim simulation)

function finish(sessionId, stopReason) {
  if (V1) {
    const id = pendingPrompt.get(sessionId);
    if (id !== undefined) {
      pendingPrompt.delete(sessionId);
      // usage shape as captured live from codex-acp 1.10.0
      send({ jsonrpc: '2.0', id, result: { stopReason, usage: { totalTokens: 10, inputTokens: 8, cachedReadTokens: 0, outputTokens: 2, thoughtTokens: 0 } } });
    }
  } else {
    idle(sessionId, stopReason);
  }
}

function idle(sessionId, stopReason) {
  send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'state_update', state: 'idle', ...(stopReason ? { stopReason } : {}) } } });
}

let buf = '';
process.stdin.on('data', (d) => {
  buf += String(d);
  let i;
  while ((i = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    handle(j);
  }
});
process.stdin.on('end', () => process.exit(0));

function handle(j) {
  err(`FAKE_METHOD:${j.method || ''}`);
  // client's answer to our permission request (id 900)
  if (j.id === 900 && j.result) {
    err(`FAKE_PERMISSION:${JSON.stringify(j.result.outcome)}`);
    const sessionId = sessions.values().next().value;
    send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: 'tc1', title: 'sensitive op', status: 'completed' } } });
    send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ACP_reply' } } } });
    finish(sessionId, 'end_turn');
    return;
  }
  switch (j.method) {
    case 'initialize':
      send({ jsonrpc: '2.0', id: j.id, result: { protocolVersion: V1 ? 1 : 2, info: { name: 'fake-acp', version: '0' }, capabilities: { promptCapabilities: { image: true } } } });
      break;
    case 'session/new':
      sessions.add('acp-sess-1');
      send({ jsonrpc: '2.0', id: j.id, result: { sessionId: 'acp-sess-1' } });
      break;
    case 'session/resume':
      send({ jsonrpc: '2.0', id: j.id, result: { sessionId: j.params?.sessionId } });
      break;
    case 'session/prompt': {
      const sessionId = j.params?.sessionId;
      const blocks = j.params?.prompt || [];
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join(' ');
      const images = blocks.filter((b) => b.type === 'image');
      if (V1) pendingPrompt.set(sessionId, j.id); // v1: no ack — the response finishes the turn
      else send({ jsonrpc: '2.0', id: j.id, result: {} }); // v2: acceptance only
      if (text.includes('APPROVE')) {
        send({
          jsonrpc: '2.0', id: 900, method: 'session/request_permission',
          params: { sessionId, title: 'run sensitive op', options: [
            { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
            { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
          ] },
        });
        return;
      }
      if (text.includes('SLOW')) {
        send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'slow ' } } } });
        if (text.includes('HANG')) hangSessions.add(sessionId); // worst-case shim: never answers the pending prompt, even on cancel
        return; // idle until cancelled
      }
      if (text.includes('FAIL')) {
        send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: 'tc9', title: 'boom', status: 'failed' } } });
        finish(sessionId, 'refusal');
        return;
      }
      let reply = 'ACP_reply';
      if (images.length) reply += ` IMG:${images.length} MIME:${images[0]?.mimeType || '-'}`;
      send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply } } } });
      if (!V1) send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'usage_update', used: 33, size: 1000 } } });
      finish(sessionId, 'end_turn');
      break;
    }
    case 'session/cancel':
      err('FAKE_CANCELLED');
      if (V1) {
        for (const [sid, id] of pendingPrompt) {
          if (hangSessions.has(sid)) continue; // wedged shim: no answer, ever
          pendingPrompt.delete(sid);
          send({ jsonrpc: '2.0', id, result: { stopReason: 'cancelled' } });
        }
      } else if (sessions.size) idle(sessions.values().next().value, 'cancelled');
      if (j.id !== undefined) send({ jsonrpc: '2.0', id: j.id, result: {} });
      break;
    default:
      if (j.id !== undefined) send({ jsonrpc: '2.0', id: j.id, result: {} });
  }
}
