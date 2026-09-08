// test/ws-client.mjs — a hand-rolled WebSocket CLIENT for tests. The repo
// has zero npm dependencies, and we need raw control of handshake headers
// (Host, Authorization) that fetch/WebSocket won't give us. Just enough to
// exercise acp-front-ws.mjs: handshake, masked text frames, recv-by-
// predicate, auto-pong, close. Deliberately tiny per the small-buffer
// testing convention.

import net from 'node:net';
import crypto from 'node:crypto';

/** Connect + handshake. Resolves to
 *   { ok:true, socket, frames, send, recv, close, isClosed }  on 101, or
 *   { ok:false, status }  when the server answered with a plain HTTP error.
 * Rejects on socket failure / close before the handshake completes. */
export function wsConnect({ port, path = '/acp', host = '127.0.0.1', auth, timeoutMs = 5000 }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      reject(new Error('ws connect timeout'));
    });
    let buf = Buffer.alloc(0);
    let open = false;
    let settled = false;
    let ended = false;
    const frames = [];
    const waiters = [];
    const settle = (fn) => { if (!settled) { settled = true; fn(); } };

    const wake = (f) => {
      for (let i = waiters.length - 1; i >= 0; i--) {
        const w = waiters[i];
        if (w.pred(f)) {
          clearTimeout(w.timer);
          waiters.splice(i, 1);
          w.res(f);
        }
      }
    };

    socket.on('connect', () => {
      const lines = [
        `GET ${path} HTTP/1.1`,
        `Host: ${host}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}`,
        'Sec-WebSocket-Version: 13',
      ];
      if (auth) lines.push(`Authorization: Bearer ${auth}`);
      socket.write(lines.join('\r\n') + '\r\n\r\n');
    });

    socket.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!open) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx === -1) return;
        const head = buf.subarray(0, idx).toString('utf8');
        const status = Number(head.split(' ')[1] || 0);
        buf = buf.subarray(idx + 4);
        if (status !== 101) {
          socket.destroy();
          settle(() => resolve({ ok: false, status }));
          return;
        }
        open = true;
        settle(() => resolve({
          ok: true,
          socket,
          frames,
          send: (obj) => socket.write(maskFrame(Buffer.from(JSON.stringify(obj), 'utf8'))),
          recv: (pred, ms = 5000) => new Promise((res, rej) => {
            const hit = frames.find(pred);
            if (hit) return res(hit);
            const w = { pred, res, rej, timer: null };
            waiters.push(w);
            w.timer = setTimeout(() => {
              const i = waiters.indexOf(w);
              if (i !== -1) waiters.splice(i, 1);
              rej(new Error('timeout waiting for ws frame'));
            }, ms);
          }),
          close: () => {
            try { socket.write(maskFrame(Buffer.alloc(0), 0x8)); } catch (_) {}
            socket.destroy();
          },
          isClosed: () => ended || socket.destroyed,
        }));
      }
      // Server frames are UNMASKED (RFC 6455 §5.1) — decode the tiny subset.
      for (;;) {
        if (buf.length < 2) break;
        const opcode = buf[0] & 0x0f;
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < 4) break;
          len = buf.readUInt16BE(2);
          off = 4;
        } else if (len === 127) {
          if (buf.length < 10) break;
          len = Number(buf.readBigUInt64BE(2));
          off = 10;
        }
        if (buf.length < off + len) break;
        const payload = Buffer.from(buf.subarray(off, off + len));
        buf = buf.subarray(off + len);
        if (opcode === 0x1) {
          let msg = null;
          try { msg = JSON.parse(payload.toString('utf8')); } catch { msg = null; }
          const f = { type: 'text', msg };
          frames.push(f);
          wake(f);
        } else if (opcode === 0x9) {
          socket.write(maskFrame(payload, 0xa)); // pong
        } else if (opcode === 0x8) {
          ended = true;
          socket.destroy();
        }
      }
    });

    socket.on('error', (e) => settle(() => reject(open ? e : new Error(`connection closed during handshake (${e.code || e.message})`))));
    socket.on('close', () => {
      ended = true;
      if (!open) settle(() => reject(new Error('connection closed during handshake')));
      else for (const w of waiters.splice(0)) { clearTimeout(w.timer); w.rej(new Error('ws closed while waiting')); }
    });
  });
}

/** Client→server frames MUST be masked (RFC 6455 §5.1). */
function maskFrame(payload, opcode = 0x1) {
  const mask = crypto.randomBytes(4);
  const masked = Buffer.allocUnsafe(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i & 3];
  const len = payload.length;
  let header;
  if (len < 126) header = Buffer.from([0x80 | opcode, 0x80 | len]);
  else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, mask, masked]);
}
