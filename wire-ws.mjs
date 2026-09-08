// agent-bridge/wire-ws.mjs — a minimal RFC 6455 WebSocket SERVER subset,
// hand-rolled because this repo has zero npm dependencies and Node ships no
// built-in WS server. Just enough for the ACP front (acp-front-ws.mjs):
// small JSON-RPC text messages, one message per frame, plus ping/pong/close.
//
// Deliberately NOT implemented (we close the socket with a protocol error
// instead): fragmentation/continuation frames, RSV extensions, binary
// messages. ACP messages are small JSON documents; a per-message frame cap
// (16MB, well above any turn payload) guards against runaway lengths.

import crypto from 'node:crypto';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
export const OP_TEXT = 0x1;
export const OP_CLOSE = 0x8;
export const OP_PING = 0x9;
export const OP_PONG = 0xa;

const MAX_FRAME = 16 * 1024 * 1024;

/** RFC 6455 §4.2.2 handshake accept key. */
export function acceptKey(secWebSocketKey) {
  return crypto.createHash('sha1').update(String(secWebSocketKey) + WS_GUID).digest('base64');
}

/** True when the request is a well-formed WS upgrade (has key + upgrade hdr). */
export function isWsUpgrade(req) {
  return String(req.headers.upgrade || '').toLowerCase() === 'websocket'
    && !!req.headers['sec-websocket-key'];
}

/** Send the 101 handshake. Only call after auth checks passed. */
export function acceptUpgrade(req, socket) {
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${acceptKey(req.headers['sec-websocket-key'])}\r\n` +
    '\r\n'
  );
}

/** Write a plain-HTTP error on a socket that asked for an upgrade we refuse,
 * then close. Used before any 101, where normal res methods don't exist. */
export function rejectUpgrade(socket, status, reason) {
  const body = JSON.stringify({ ok: false, error: reason });
  try {
    socket.end(
      `HTTP/1.1 ${status} ${reason}\r\n` +
      'Content-Type: application/json\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      'Connection: close\r\n' +
      '\r\n' +
      body
    );
  } catch (_) {}
}

function encodeFrame(opcode, payload = Buffer.alloc(0)) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

export const wsText = (str) => encodeFrame(OP_TEXT, Buffer.from(str, 'utf8'));
export const wsPong = (payload) => encodeFrame(OP_PONG, payload);
export const wsClose = (code = 1000) => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(code);
  return encodeFrame(OP_CLOSE, b);
};

/** Incremental frame decoder for the SERVER side. Client frames MUST be
 * masked (RFC 6455 §5.1) — unmasked input is a protocol error. Feed it raw
 * socket chunks; it calls exactly one of the handlers per complete frame and
 * then `onClose(code)` once before going silent. Handlers:
 *   onText(str) · onPing(payload) · onPong(payload) · onClose(code, reason) */
export function createFrameDecoder({ onText, onPing, onPong, onClose }) {
  let buf = Buffer.alloc(0);
  let dead = false;
  const fail = (code) => { if (!dead) { dead = true; onClose?.(code, ''); } };
  return {
    push(chunk) {
      if (dead) return;
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 2) return;
        const b0 = buf[0];
        const b1 = buf[1];
        const fin = (b0 & 0x80) !== 0;
        const opcode = b0 & 0x0f;
        const masked = (b1 & 0x80) !== 0;
        let len = b1 & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          off = 4;
        } else if (len === 127) {
          if (buf.length < 10) return;
          len = Number(buf.readBigUInt64BE(2));
          off = 10;
        }
        if (len > MAX_FRAME) return fail(1009); // message too big
        if (!masked) return fail(1002);         // clients must mask
        if ((b0 & 0x70) !== 0) return fail(1002); // RSV bits: no extensions
        if (!fin || opcode === 0x0) return fail(1002); // no fragmentation
        if (buf.length < off + 4 + len) return; // wait for the full frame
        const mask = buf.subarray(off, off + 4);
        const payload = Buffer.allocUnsafe(len);
        const src = buf.subarray(off + 4, off + 4 + len);
        for (let i = 0; i < len; i++) payload[i] = src[i] ^ mask[i & 3];
        buf = buf.subarray(off + 4 + len);
        if (opcode === OP_TEXT) onText?.(payload.toString('utf8'));
        else if (opcode === OP_PING) onPing?.(payload);
        else if (opcode === OP_PONG) onPong?.(payload);
        else if (opcode === OP_CLOSE) {
          dead = true;
          onClose?.(payload.length >= 2 ? payload.readUInt16BE(0) : 1000, '');
          return;
        } else return fail(1003); // binary etc.: unsupported data type
      }
    },
  };
}
