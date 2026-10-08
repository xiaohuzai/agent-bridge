#!/usr/bin/env node
// test/fake-workbuddy-daemon.mjs — a scripted stand-in for the CodeBuddy Code
// worker gateway that the WorkBuddy AI desktop spawns (ACP over Streamable
// HTTP at /api/v1/acp, /api/v1/acp/connect, /health) so agent-bridge tests
// exercise the REAL adapter and HTTP layers with zero network and no WorkBuddy
// install. Wire facts mirrored from the real worker (see
// adapters/workbuddy.mjs header).
//
// Usage: node fake-workbuddy-daemon.mjs <port>
//
// Behavior keyed off the prompt text:
//   'APPROVE' → session/request_permission (server→client REQUEST id 9001),
//               waits for the client's JSON-RPC response (FAKE_RESOLVE:<outcome
//               json> on stderr), then completes with a tool trail +
//               'FAKE_after_approve'.
//   'SLOW'    → streams one delta then idles; reacts to session/cancel with a
//               stopReason:'cancelled' final response (FAKE_CANCELLED stderr).
//   'FAIL'    → JSON-RPC error response for the prompt.
//   images    → replies 'FAKE_saw <n> image(s) (<mimes>)' (content blocks asserted).
// otherwise → agent_message_chunk deltas + tool_call + end_turn result.
// Every request method received is echoed to stderr as FAKE_METHOD:<m>.
// /api/v1/acp requires the acp-connection-id header (403 without) and only
// accepts connections minted via /connect.

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const err = (s) => process.stderr.write(s + '\n');

const connections = new Set();
const sessions = new Map(); // sid → {res, reply, promptId} of the live prompt turn
const pendingPermission = new Map(); // sessionId → {res, requestId, promptId}
let sessionSeq = 0;

const sseStart = (res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', Cache: 'no-cache' });
  res.write(':ok\n\n');
};
const msg = (res, obj) => res.write(`event: message\ndata: ${JSON.stringify(obj)}\n\n`);
const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
};

function finishApproveTurn(state, answerText) {
  const { res, reply, promptId } = state;
  upd(res, state.sid, { sessionUpdate: 'tool_call', toolCallId: 'tc1', toolName: 'write_file', status: 'in_progress' });
  upd(res, state.sid, { sessionUpdate: 'tool_call_update', toolCallId: 'tc1', toolName: 'write_file', status: 'completed' });
  upd(res, state.sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: answerText } });
  reply(promptId, { stopReason: 'end_turn' });
  res.end();
}

function upd(res, sid, update) {
  msg(res, { jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update } });
}

const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }

    if (req.url === '/health') {
      json(res, 200, { status: 'UP', components: { eg: { status: 'UP' } } });
      return;
    }
    if (req.url === '/api/v1/acp/connect' && req.method === 'POST') {
      const connectionId = randomUUID();
      const sessionToken = randomUUID().replace(/-/g, '');
      connections.add(connectionId);
      err(`FAKE_CONNECT:${connectionId}`);
      json(res, 200, { connectionId, sessionToken });
      return;
    }
    if (req.url === '/api/v1/acp' && req.method === 'POST') {
      const connectionId = req.headers['acp-connection-id'];
      if (!connectionId || !connections.has(connectionId)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
        return;
      }
      err(`FAKE_METHOD:${body.method || ''}`);

      // client's JSON-RPC RESPONSE (e.g. the session/request_permission
      // answer): id present, no method, carries result
      if (body.id !== undefined && !body.method && body.result !== undefined) {
        err(`FAKE_RESOLVE:${JSON.stringify(body.result)}`);
        json(res, 200, { ok: true });
        for (const [sid, p] of pendingPermission) {
          if (Number(body.id) !== Number(p.requestId)) continue;
          pendingPermission.delete(sid);
          finishApproveTurn(sessions.get(sid)?.turn || {}, 'FAKE_after_approve');
        }
        return;
      }

      sseStart(res);
      const reply = (id, result) => msg(res, { jsonrpc: '2.0', id, result });
      const replyErr = (id, message) => msg(res, { jsonrpc: '2.0', id, error: { code: -32000, message } });
      const updNow = (sid, update) => msg(res, { jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update } });

      switch (body.method) {
        case 'initialize':
          reply(body.id, { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true, embeddedContext: true }, mcpCapabilities: { http: true, sse: true }, loadSession: true }, authMethods: [] });
          return;
        case 'session/new': {
          const sid = `sess_fake${++sessionSeq}`;
          err(`FAKE_SESSION_NEW:${sid}`);
          updNow(sid, { sessionUpdate: 'config_option_update', configOptions: [] });
          reply(body.id, { sessionId: sid, config: {} });
          return;
        }
        case 'session/load': {
          err(`FAKE_SESSION_LOAD:${body.params?.sessionId}`);
          // sessionIds containing "gone" simulate a worker that lost the
          // session (desktop restart without persistence)
          if (/gone/.test(body.params?.sessionId || '')) {
            replyErr(body.id, 'FAKE_session_not_found');
            return;
          }
          reply(body.id, {});
          return;
        }
        case 'session/prompt': {
          const sid = body.params.sessionId;
          const blocks = body.params.prompt || [];
          const text = blocks.find((b) => b.type === 'text')?.text || '';
          const images = blocks.filter((b) => b.type === 'image');
          err(`FAKE_PROMPT:${sid}:${images.length}:${text.slice(0, 30)}`);
          const state = { sid, res, reply, promptId: body.id };
          sessions.set(sid, { turn: state });

          if (/FAIL/.test(text)) {
            replyErr(body.id, 'FAKE_turn_failed');
            res.end();
            return;
          }
          if (/APPROVE/.test(text)) {
            const permission = { jsonrpc: '2.0', id: 9001, method: 'session/request_permission', params: { sessionId: sid, toolCall: { toolCallId: 'tc1', title: 'write_file' }, options: [
              { optionId: 'opt_once', name: 'Allow once', kind: 'allow_once' },
              { optionId: 'opt_always', name: 'Always allow', kind: 'allow_always' },
              { optionId: 'opt_deny', name: 'Reject', kind: 'reject_once' },
            ] } };
            pendingPermission.set(sid, { res, requestId: 9001, promptId: body.id, state });
            updNow(sid, { sessionUpdate: 'config_option_update', configOptions: [] });
            msg(res, permission);
            return; // waits for the client's resolveInteraction response
          }
          if (/SLOW/.test(text)) {
            openStreams.set(sid, state);
            updNow(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'FAKE_partial' } });
            return; // waits for session/cancel
          }
          const replyText = images.length
            ? `FAKE_saw ${images.length} image(s) (${images.map((i) => i.mimeType).join(',')})`
            : 'FAKE_reply';
          if (images.length) err(`FAKE_IMAGE_MIMES:${images.map((i) => i.mimeType).join('|')}`);
          updNow(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: replyText } });
          reply(body.id, { stopReason: 'end_turn' });
          res.end();
          return;
        }
        case 'session/cancel': {
          err('FAKE_CANCELLED');
          reply(body.id, {});
          const state = openStreams.get(body.params.sessionId);
          if (state) {
            openStreams.delete(body.params.sessionId);
            updNow(state.sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'FAKE_partial_more' } });
            state.reply(body.promptId ?? state.promptId ?? 424242, { stopReason: 'cancelled' });
            state.res.end();
          }
          return;
        }
        default:
          replyErr(body.id, `fake: unknown method ${body.method}`);
          return;
      }
    }
    json(res, 404, { error: 'not_found' });
  });
  req.on('error', () => {});
});

// sid → live SLOW prompt state (waits for session/cancel)
const openStreams = new Map();

if (process.argv[2]) {
  const port = Number(process.argv[2]);
  server.listen(port, '127.0.0.1', () => err(`FAKE_LISTENING:${port}`));
}
