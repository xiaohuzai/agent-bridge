#!/usr/bin/env node
// test/fake-codex-app-server.mjs — a scripted stand-in for `codex app-server`
// (JSONL JSON-RPC on stdio) so agent-bridge tests exercise the REAL adapter
// and HTTP layers with zero network and no real codex install.
//
// Behavior keyed off the turn prompt:
//   'APPROVE'   → emits item/commandExecution/requestApproval (id 900), waits
//                 for the client's answer, then completes with a tool trail.
//   'SLOW'      → streams first delta, then idles; reacts to turn/interrupt
//                 with status:'interrupted' and writes FAKE_INTERRUPTED to
//                 stderr (assertion hook for the disconnect→interrupt path).
//   'FAIL'      → error notification + turn/completed status:'failed'.
//   otherwise   → two deltas + tokenUsage + turn/completed (completed).
// Every request method received is echoed to stderr as FAKE_METHOD:<m>.

let out = '';
process.stdout.on('error', () => {}); // EPIPE when the bridge kills us
const send = (obj) => { out = JSON.stringify(obj); process.stdout.write(out + '\n'); };
const err = (s) => process.stderr.write(s + '\n');

let turnSeq = 0;
let pendingApprovalId = null;
let slowState = null; // { threadId, turnId }

function complete(threadId, turnId, status, items) {
  send({ method: 'thread/tokenUsage/updated', params: { threadId, turnId, tokenUsage: { total: { inputTokens: 21, outputTokens: 7 }, last: { inputTokens: 21, outputTokens: 7 } } } });
  send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, items, status, error: null } } });
}

let buf = '';
process.stdin.on('data', (d) => {
  buf += String(d);
  let i;
  while ((i = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    handle(j);
  }
});
process.stdin.on('end', () => process.exit(0));

function handle(j) {
  err(`FAKE_METHOD:${j.method || ''}`);
  // client's answer to our approval request
  if (pendingApprovalId !== null && j.id === pendingApprovalId && j.result) {
    err(`FAKE_APPROVAL_DECISION:${j.result.decision === undefined ? JSON.stringify(j.result) : j.result.decision}`);
    pendingApprovalId = null;
    const { threadId, turnId } = slowState || {};
    send({ method: 'item/started', params: { threadId, turnId, item: { type: 'commandExecution', id: 'c1', command: "bash -lc 'echo done'", exitCode: null, status: 'inProgress' } } });
    send({ method: 'item/completed', params: { threadId, turnId, item: { type: 'commandExecution', id: 'c1', command: "bash -lc 'echo done'", exitCode: 0, status: 'completed' } } });
    complete(threadId, turnId, 'completed', [{ type: 'agentMessage', id: 'm1', text: 'FAKE_reply' }]);
    return;
  }
  // client's turn/interrupt during a SLOW turn
  if (j.method === 'turn/interrupt') {
    err('FAKE_INTERRUPTED');
    if (slowState) {
      complete(slowState.threadId, slowState.turnId, 'interrupted', []);
      slowState = null;
    }
    send({ jsonrpc: '2.0', id: j.id, result: {} });
    return;
  }
  switch (j.method) {
    case 'initialize':
      send({ jsonrpc: '2.0', id: j.id, result: { userAgent: 'fake-codex/0 (test)' } });
      break;
    case 'thread/start': {
      const id = j.params?.sandbox === 'read-only' ? 'thread-fake-1' : 'thread-fake-other';
      send({ jsonrpc: '2.0', id: j.id, result: { thread: { id } } });
      break;
    }
    case 'thread/resume':
      send({ jsonrpc: '2.0', id: j.id, result: { thread: { id: j.params?.threadId } } });
      break;
    case 'turn/start': {
      const threadId = j.params?.threadId;
      const turnId = `turn-${++turnSeq}`;
      const text = j.params?.input?.[0]?.text || '';
      send({ jsonrpc: '2.0', id: j.id, result: { turn: { id: turnId, status: 'inProgress', items: [] } } });
      send({ method: 'turn/started', params: { threadId, turn: { id: turnId, status: 'inProgress', items: [] } } });
      if (text.includes('APPROVE')) {
        pendingApprovalId = 900;
        slowState = { threadId, turnId };
        send({
          jsonrpc: '2.0', id: 900, method: 'item/commandExecution/requestApproval',
          params: { threadId, turnId, itemId: 'c1', command: "bash -lc 'rm -rf /tmp/x'", cwd: '/w', availableDecisions: ['accept', 'cancel'], proposedExecpolicyAmendment: ['bash', '-lc', 'rm -rf /tmp/x'] },
        });
        return;
      }
      if (text.includes('SLOW')) {
        slowState = { threadId, turnId };
        send({ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: 'm1', delta: 'slow ' } });
        return; // idle until interrupted
      }
      if (text.includes('FAIL')) {
        send({ method: 'error', params: { error: { message: 'Missing environment variable: `NOPE`.' }, threadId, turnId, willRetry: false } });
        complete(threadId, turnId, 'failed', []);
        return;
      }
      send({ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: 'm1', delta: 'FAKE_' } });
      send({ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: 'm1', delta: 'reply' } });
      complete(threadId, turnId, 'completed', [{ type: 'agentMessage', id: 'm1', text: 'FAKE_reply' }]);
      break;
    }
    default:
      if (j.id !== undefined) send({ jsonrpc: '2.0', id: j.id, error: { code: -32601, message: `fake: ${j.method} unsupported` } });
  }
}
