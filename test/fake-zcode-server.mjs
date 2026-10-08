#!/usr/bin/env node
// test/fake-zcode-server.mjs — a scripted stand-in for the ZCode desktop's
// stdio server (hello line → binary RPC frames) so agent-bridge tests
// exercise the REAL adapter and HTTP layers with zero network and no ZCode
// install. Wire facts mirrored from the real server (see
// adapters/zcode-server.mjs header).
//
// Behavior keyed off the turn prompt:
//   'APPROVE' → permission pendingInteraction, waits for the client's
//               resolveInteraction (FAKE_RESOLVE:<answer> on stderr), then
//               completes with a tool trail.
//   'SLOW'    → streams one delta, then idles; reacts to the stop command
//               with turnHeader completedInterrupted (FAKE_STOPPED on stderr).
//   'FAIL'    → turnHeader failed → error event.
//   sendText with attachments → verifies the uploaded bytes' sha256 against
//               the declared checksum (FAKE_CHECKSUM:OK|FAIL) and answers
//               "FAKE_saw <n> image(s)".
// otherwise  → reasoning + assistantText streamed as row deltas (one frame
//              split into TWO wire fragments to exercise reassembly), usage
//              patch, turnHeader completedSuccess.
// Every request method received is echoed to stderr as FAKE_METHOD:<m>.

import { createHash } from 'node:crypto';

let out = '';
process.stdout.on('error', () => {}); // EPIPE when the bridge kills us
const err = (s) => process.stderr.write(s + '\n');

// ── framing (same wire format as the real server) ──
function writeVQL(bytes, value) {
  if (value === 0) { bytes.push(0); return; }
  let v = value >>> 0;
  while (v !== 0) { let b = v & 0x7f; v = v >>> 7; if (v > 0) b |= 0x80; bytes.push(b); }
}
function serializeValue(data, out) {
  if (data === undefined) { out.push(0); }
  else if (typeof data === 'string') {
    const b = Buffer.from(data, 'utf8');
    out.push(1); writeVQL(out, b.byteLength); for (const x of b) out.push(x);
  } else if (data instanceof Uint8Array) {
    out.push(2); writeVQL(out, data.byteLength); for (const x of data) out.push(x);
  } else if (Array.isArray(data)) {
    out.push(4); writeVQL(out, data.length);
    for (const el of data) serializeValue(el, out);
  } else if (typeof data === 'number' && (data | 0) === data) {
    out.push(6); writeVQL(out, data);
  } else {
    const b = Buffer.from(JSON.stringify(data), 'utf8');
    out.push(5); writeVQL(out, b.byteLength); for (const x of b) out.push(x);
  }
}
function frame(header, body) {
  const head = []; serializeValue(header, head);
  const pay = []; serializeValue(body === undefined ? undefined : body, pay);
  const payload = Buffer.from(Uint8Array.from([...head, ...pay]));
  const buf = Buffer.allocUnsafe(13 + payload.length);
  buf[0] = 1; buf.writeUInt32BE(0, 1); buf.writeUInt32BE(0, 5);
  buf.writeUInt32BE(payload.length, 9);
  buf.set(payload, 13);
  return buf;
}

class Reader {
  constructor(buf) { this.buf = buf; this.pos = 0; }
  read(n) { const s = this.buf.subarray(this.pos, this.pos + n); this.pos += n; return s; }
  vql() { let v = 0, n = 0; for (;;) { const b = this.read(1)[0]; v |= (b & 0x7f) << n; if (!(b & 0x80)) return v; n += 7; } }
}
function deserialize(buf) {
  const r = new Reader(buf);
  const one = () => {
    const t = r.read(1)[0];
    switch (t) {
      case 0: return undefined;
      case 1: return r.read(r.vql()).toString('utf8');
      case 2: case 3: return r.read(r.vql());
      case 4: { const n = r.vql(); const a = []; for (let i = 0; i < n; i++) a.push(one()); return a; }
      case 5: return JSON.parse(r.read(r.vql()).toString('utf8'));
      case 6: return r.vql();
      default: throw new Error(`bad tag ${t}`);
    }
  };
  const header = one();
  const body = r.pos < buf.length ? one() : undefined;
  return [header, body];
}

// ── server state ──
const listens = {};                    // event name → listen id
let sessionSeq = 0;
let rowSeq = 0;                        // stable row ids within a session
const pendingInteraction = new Map();  // sessionId → interaction (unresolved)
const uploads = new Map();             // uploadId → {chunks, checksum, totalBytes, fileName}

const send = (header, body) => { process.stdout.write(frame(header, body)); };
const rpcOk = (id, result) => send([201, id], result === undefined ? null : result);
const fire = (event, payload) => {
  const id = listens[event];
  if (id === undefined) { err(`FAKE_NO_LISTENER:${event}`); return; }
  send([204, id], payload);
};

let wireSeq = 0;
function conversationFrame(sessionId, payload, { fragment = false } = {}) {
  const inner = {
    topic: `conversation/${sessionId}`,
    subscriptionId: 'sub1',
    fromSeq: ++wireSeq, toSeq: wireSeq,
    sentAt: Date.now(),
    payload,
  };
  if (!fragment) {
    fire('onDynamicConversationFrame', {
      wireVersion: 3, kind: 'complete', deliveryKind: 'online',
      logicalFrameId: `lf-${wireSeq}`, logicalFrameOrdinal: 0,
      topic: inner.topic, subscriptionId: 'sub1', frame: inner,
    });
    return;
  }
  const buf = Buffer.from(JSON.stringify(inner), 'utf8');
  const half = Math.ceil(buf.length / 2);
  const lid = `lf-${wireSeq}`;
  for (let i = 0; i < 2; i++) {
    fire('onDynamicConversationFrame', {
      wireVersion: 3, kind: 'fragment', deliveryKind: 'online',
      logicalFrameId: lid, logicalFrameOrdinal: i,
      topic: inner.topic, subscriptionId: 'sub1',
      fragmentIndex: i, fragmentCount: 2,
      dataBase64: buf.subarray(i * half, Math.min((i + 1) * half, buf.length)).toString('base64'),
      checksum: { algorithm: 'crc32', value: 0 },
    });
  }
}

function streamTurn(sessionId, text) {
  const turnRow = { rowId: ++rowSeq, turnId: 'turn1', kind: 'turnHeader', state: 'running', origin: 'user' };
  const userRow = { rowId: ++rowSeq, turnId: 'turn1', kind: 'userInput', state: 'complete', text };
  conversationFrame(sessionId, { kind: 'deltas', deltas: [
    { op: 'row.appended', row: turnRow },
    { op: 'row.appended', row: userRow },
  ] });
  if (/FAIL/.test(text)) {
    conversationFrame(sessionId, { kind: 'deltas', deltas: [
      { op: 'row.upserted', row: { ...turnRow, state: 'failed' } },
    ] });
    return;
  }
  if (/APPROVE/.test(text)) {
    const p = { interactionId: 'int_1', kind: 'permission', anchorRowId: null, createdAt: Date.now(), payload: { kind: 'permission', toolCallId: 'tc1', toolName: 'Bash', summary: 'rm -rf /tmp/fake', detail: 'fake', options: [
      { optionId: 'opt_once', label: 'Allow once', kind: 'allowOnce' },
      { optionId: 'opt_always', label: 'Always allow', kind: 'allowAlways' },
      { optionId: 'opt_deny', label: 'Deny', kind: 'deny' },
    ] } };
    pendingInteraction.set(sessionId, p);
    conversationFrame(sessionId, { kind: 'deltas', deltas: [
      { op: 'state.updated', patch: { pendingInteractions: [p] } },
    ] });
    return; // finishTurn runs when the client's resolveInteraction arrives
  }
  // happy path: reasoning (fragmented wire frame) + streamed answer + usage
  const reasoningRow = { rowId: ++rowSeq, turnId: 'turn1', kind: 'reasoning', state: 'streaming', text: '' };
  conversationFrame(sessionId, { kind: 'deltas', deltas: [
    { op: 'row.appended', row: reasoningRow },
    { op: 'row.delta', rowId: reasoningRow.rowId, path: 'text', append: '思考中…' },
    { op: 'row.upserted', row: { ...reasoningRow, state: 'complete', text: '思考中…' } },
  ], fragment: true });
  const reply = /FAKE_saw/.test(text) ? text : 'FAKE_reply';
  const answerRow = { rowId: ++rowSeq, turnId: 'turn1', kind: 'assistantText', state: 'streaming', text: '' };
  conversationFrame(sessionId, { kind: 'deltas', deltas: [
    { op: 'row.appended', row: answerRow },
    { op: 'row.delta', rowId: answerRow.rowId, path: 'text', append: reply.slice(0, 5) },
    { op: 'row.delta', rowId: answerRow.rowId, path: 'text', append: reply.slice(5) },
    { op: 'state.updated', patch: { usage: { cumulative: { inputTokens: 120, outputTokens: 45, cacheReadTokens: 0, cacheWriteTokens: 0 } } } },
    { op: 'row.upserted', row: { ...answerRow, state: 'complete', text: reply } },
    { op: 'row.upserted', row: { ...turnRow, state: 'completedSuccess' } },
  ] });
}

// ── stdio: hello line, then binary frames ──
err(`FAKE_AGENT_ENV:${process.env.ZCODE_AGENT_SERVER_COMMAND || 'unset'}`);
err('FAKE_HELLO');
process.stdout.write(JSON.stringify({ type: 'zcode-hello', version: '9.9.9-fake', platform: process.platform, arch: process.arch, pid: process.pid }) + '\n');

let lineBuf = Buffer.alloc(0);
let binBuf = Buffer.alloc(0);
let acked = false;
const assemble = (buf) => {
  let pos = 0;
  for (;;) {
    if (buf.length - pos < 13) break;
    const type = buf[pos];
    const len = buf.readUInt32BE(pos + 9);
    if (buf.length - pos < 13 + len) break;
    const payload = buf.subarray(pos + 13, pos + 13 + len);
    pos += 13 + len;
    if (type === 1) {
      try { handle(deserialize(payload)); } catch (e) { err(`FAKE_PARSE_ERROR:${e.message}`); }
    }
  }
  return buf.subarray(pos);
};

process.stdin.on('data', (d) => {
  if (!acked) {
    lineBuf = Buffer.concat([lineBuf, d]);
    const i = lineBuf.indexOf(0x0a);
    if (i === -1) return;
    try {
      const ack = JSON.parse(lineBuf.subarray(0, i).toString('utf8'));
      err(`FAKE_ACK:${ack.type}:${ack.clientId}`);
    } catch (e) { err(`FAKE_ACK_PARSE_FAIL:${e.message}`); }
    acked = true;
    binBuf = lineBuf.subarray(i + 1);
    lineBuf = Buffer.alloc(0);
    send([200], undefined); // Initialize: the real server pushes it right after attach
    if (binBuf.length) binBuf = assemble(binBuf);
    return;
  }
  binBuf = assemble(Buffer.concat([binBuf, d]));
});
process.stdin.on('end', () => process.exit(0));

function handle([header, body]) {
  const [type, id, channel, method] = header;
  if (type !== 100) {
    if (type === 102) {
      listens[header[3]] = id;
    }
    return;
  }
  err(`FAKE_METHOD:${channel}/${method}`);
  const args = Array.isArray(body) ? body : [];
  if (channel === 'zcode-session') {
    // legacy face: the image-turn carrier helpers
    if (method === 'createSession') {
      err(`FAKE_LEGACY_CREATE:${args[0]?.persistence}:${args[0]?.workspacePath}`);
      const sid = `sess_fake${++sessionSeq}`;
      rpcOk(id, { session: { sessionId: sid } });
      return;
    }
    if (method === 'listSessions') {
      err(`FAKE_LISTSESSIONS:${args[0]?.workspacePath}`);
      rpcOk(id, { sessions: [{ sessionId: 'sess_carrier0', title: 'old' }] });
      return;
    }
    send([202, id], { message: `fake: unknown zcode-session method ${method}`, name: 'Error' });
    return;
  }
  switch (method) {
    case 'helloConversationV4':
      rpcOk(id, { kind: 'hello', protocolVersion: 3, connectionId: 'conn-fake-1', clientMode: 'web-remote-replayable', deliveryProfile: 'replayable', serverTime: Date.now(), capabilities: { workspaceHookReview: true, workflowRunDeltas: true }, auth: {} });
      return;
    case 'initializeConversationV4':
      rpcOk(id, undefined);
      return;
    case 'respondSessionRuntimePreferences':
      err(`FAKE_PREFS:${JSON.stringify(args[0]?.resolution?.preferences || {})}`);
      rpcOk(id, undefined);
      return;
    case 'subscribeConversationV4':
      rpcOk(id, { ack: { subscriptionId: 'sub1', mode: 'snapshot', logEpoch: 'e1' } });
      return;
    case 'attachmentBeginV4': {
      const p = args[0] || {};
      if (uploads.has(p.uploadId)) { rpcOk(id, { uploadId: p.uploadId, state: 'committed', nextChunkIndex: 0, ref: `ref_${p.uploadId}` }); return; }
      uploads.set(p.uploadId, { chunks: [], checksum: p.checksum, fileName: p.fileName, totalBytes: p.totalBytes });
      err(`FAKE_ATTACH_BEGIN:${p.fileName}:${p.totalBytes}:${p.totalChunks}`);
      rpcOk(id, { uploadId: p.uploadId, state: 'staging', nextChunkIndex: 0 });
      return;
    }
    case 'attachmentChunkV4': {
      const p = args[0] || {};
      const up = uploads.get(p.uploadId);
      if (up) up.chunks[Number(p.chunkIndex)] = Buffer.from(p.dataBase64, 'base64');
      rpcOk(id, { uploadId: p.uploadId, nextChunkIndex: Number(p.chunkIndex) + 1 });
      return;
    }
    case 'attachmentCommitV4': {
      const p = args[0] || {};
      const up = uploads.get(p.uploadId);
      const whole = Buffer.concat((up?.chunks || []).filter(Boolean));
      const ok = !!up
        && `sha256:${createHash('sha256').update(whole).digest('hex')}` === up.checksum
        && whole.length === up.totalBytes;
      err(`FAKE_CHECKSUM:${ok ? 'OK' : 'FAIL'}`);
      rpcOk(id, { ref: `ref_${p.uploadId}` });
      return;
    }
    case 'sendConversationCommandV4': {
      const env = args[0]?.envelope || {};
      err(`FAKE_CMD:${env.type}:${args[0]?.workspacePath}`);
      switch (env.type) {
        case 'createSession': {
          const sid = `sess_fake${++sessionSeq}`;
          // host-relay preferences request, like the real server's runtime-
          // materialization step during createSession
          fire('onDynamicSessionRuntimePreferencesRequest', { sessionId: sid, scope: 'runtime-materialization', requestId: `prefs-${sid}` });
          rpcOk(id, { commandId: env.commandId, status: 'accepted', revisionAtDecision: 0, result: { type: 'createSession', sessionId: sid, input: { delivery: 'startNow', inputId: 'in1' } } });
          if (env.payload?.firstInput) {
            // defer one tick: the adapter registers the turn entry after this
            // ack resolves, so same-chunk frames would race its registration
            const fi = env.payload.firstInput;
            const firstAtts = fi.attachments || [];
            if (firstAtts.length) err(`FAKE_FIRSTINPUT_ATTACH:${firstAtts.length}`);
            const fiText = firstAtts.length ? `FAKE_saw ${firstAtts.length} image(s)` : (fi.text || '');
            setTimeout(() => streamTurn(sid, fiText), 30);
          }
          return;
        }
        case 'sendText': {
          const sid = env.sessionId;
          rpcOk(id, { commandId: env.commandId, status: 'accepted', revisionAtDecision: 1, result: { type: 'inputAccepted', delivery: 'startNow', inputId: 'in2' } });
          const atts = env.payload?.attachments || [];
          err(`FAKE_ATTACHED:${atts.length}`);
          const text = atts.length ? `FAKE_saw ${atts.length} image(s)` : (env.payload?.text || '');
          if (/SLOW/.test(text)) return; // wait for the stop command
          streamTurn(sid, text);
          return;
        }
        case 'stop': {
          const sid = env.sessionId;
          rpcOk(id, { commandId: env.commandId, status: 'accepted', revisionAtDecision: 2 });
          err('FAKE_STOPPED');
          conversationFrame(sid, { kind: 'deltas', deltas: [
            { op: 'row.upserted', row: { rowId: ++rowSeq, turnId: 'turn1', kind: 'turnHeader', state: 'completedInterrupted' } },
          ] });
          return;
        }
        case 'renameSession':
          err(`FAKE_RENAME:${env.payload?.title}`);
          rpcOk(id, { commandId: env.commandId, status: 'accepted', revisionAtDecision: 3 });
          return;
        case 'resolveInteraction': {
          err(`FAKE_RESOLVE:${JSON.stringify(env.payload?.answer)}`);
          rpcOk(id, { commandId: env.commandId, status: 'accepted', revisionAtDecision: 4, result: { type: 'resolveInteraction', resolvedBy: { clientId: env.clientId } } });
          const sid = env.sessionId;
          if (pendingInteraction.has(sid)) {
            pendingInteraction.delete(sid);
            conversationFrame(sid, { kind: 'deltas', deltas: [
              { op: 'row.appended', row: { rowId: ++rowSeq, turnId: 'turn1', kind: 'toolCall', toolName: 'Bash', status: 'success', inputText: 'echo ok' } },
              { op: 'row.appended', row: { rowId: ++rowSeq, turnId: 'turn1', kind: 'assistantText', state: 'streaming', text: '' } },
              { op: 'row.delta', rowId: rowSeq, path: 'text', append: 'FAKE_after_approve' },
              { op: 'row.upserted', row: { rowId: rowSeq, turnId: 'turn1', kind: 'assistantText', state: 'complete', text: 'FAKE_after_approve' } },
              { op: 'row.upserted', row: { rowId: ++rowSeq, turnId: 'turn1', kind: 'turnHeader', state: 'completedSuccess' } },
            ] });
          }
          return;
        }
        default:
          rpcOk(id, { commandId: env.commandId, status: 'rejected', reasonCode: 'fake.unknownCommand', revisionAtDecision: 0 });
          return;
      }
    }
    default:
      send([202, id], { message: `fake: unknown method ${method}`, name: 'Error' });
      return;
  }
}
