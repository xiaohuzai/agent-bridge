// agent-bridge/acp-front-ws.mjs — ACP v1 over WEBSOCKET, the front's remote
// transport. The protocol session lives in acp-front.mjs (shared with the
// stdio front); this file is just the WS plumbing around it.
//
// This is the public adoption door (AGENTS.md "Roadmap (dual-door strategy)"):
// it lets any ACP client (Zed-style editors' remote setups, acpx, acp-ui, …)
// attach to a bridge and reach its agent WITHOUT ever learning the v1
// HTTP+SSE wire.
//
// Additive by construction: it attaches only an `upgrade` listener filtered
// to the single path `/acp` on the bridge's EXISTING http.Server. Upgrade
// requests never reach server.mjs's v1 request handler, so the frozen v1
// contract (server.mjs header comment) is untouched. Auth mirrors v1 exactly:
// the same per-bridge bearer token and the same loopback Host allowlist for
// loopback binds — both re-implemented here because the v1 gates live in the
// request handler, which upgrades bypass.

import { acceptUpgrade, isWsUpgrade, rejectUpgrade, wsText, wsPong, createFrameDecoder } from './wire-ws.mjs';
import { createAcpFrontSession } from './acp-front.mjs';

const PING_MS = 15000;
const MAX_OUTSTANDING_PINGS = 3;

export function attachAcpFront(server, { adapter, agent, version = '0.0.0', token, bindAddress = '127.0.0.1', log = () => {} }) {
  const loopbackBind = ['127.0.0.1', 'localhost', '::1'].includes(bindAddress);
  // Upgraded sockets are NOT reliably tracked by Node's connection
  // accounting (server.close()/closeAllConnections hang on half-open WS
  // peers — verified empirically), so the front owns every socket it
  // accepts and exposes dispose() for deterministic teardown.
  const connections = new Set();
  server.on('upgrade', (req, socket) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (url.pathname !== '/acp') return rejectUpgrade(socket, 404, 'not found');
      if (!isWsUpgrade(req)) return rejectUpgrade(socket, 400, 'websocket upgrade required');
      // Same DNS-rebinding posture as v1: loopback binds accept only
      // loopback Hosts; remote binds are hostname-legit and token-gated.
      const host = String(req.headers.host || '').split(':')[0].toLowerCase();
      if (loopbackBind && host !== '127.0.0.1' && host !== 'localhost' && host !== '::1' && host !== '[::1]') {
        return rejectUpgrade(socket, 403, 'loopback only');
      }
      if (token) {
        const auth = String(req.headers.authorization || '');
        if (auth !== `Bearer ${token}`) return rejectUpgrade(socket, 401, 'bad token');
      }
      acceptUpgrade(req, socket);
      socket.setNoDelay(true);
      log('[acp-front] ACP client connected (ws /acp)');
      let pingTimer = null;
      const session = createAcpFrontSession({
        adapter,
        agent,
        version,
        log,
        wire: {
          send: (obj) => { try { socket.write(wsText(JSON.stringify(obj))); } catch (_) {} },
          close: () => { try { socket.destroy(); } catch (_) {} },
        },
        onClosed: () => {
          connections.delete(session);
          if (pingTimer) clearInterval(pingTimer);
        },
      });
      connections.add(session);
      // Inbound frames + half-open liveness are WS-only concerns.
      let outstandingPings = 0;
      const decoder = createFrameDecoder({
        onText: (s) => { outstandingPings = 0; session.handleMessage(s); },
        onPing: (p) => { try { socket.write(wsPong(p)); } catch (_) {} },
        onPong: () => { outstandingPings = 0; },
        onClose: (code) => {
          log(`[acp-front] close frame (${code})`);
          session.destroy();
        },
      });
      socket.on('data', (d) => decoder.push(d));
      socket.on('error', () => session.destroy());
      // 'end' (client half-closed with a FIN) must tear down promptly —
      // 'close' alone only fires once BOTH sides close, and a half-open peer
      // would otherwise hold the socket (and server.close()) open forever.
      socket.on('end', () => session.destroy());
      socket.on('close', () => session.destroy());
      // Unanswered pings above the threshold mean the client vanished
      // without a close frame — destroy to force cleanup.
      pingTimer = setInterval(() => {
        if (outstandingPings >= MAX_OUTSTANDING_PINGS) {
          log('[acp-front] ping timeout — destroying connection');
          try { socket.destroy(); } catch (_) {}
          session.destroy();
          return;
        }
        outstandingPings++;
        try { socket.write(wsPingFrame()); } catch (_) {}
      }, PING_MS);
    } catch (e) {
      log(`[acp-front] upgrade failed: ${e.message}`);
      try { socket.destroy(); } catch (_) {}
    }
  });
  return {
    path: '/acp',
    protocol: 'acp-v1',
    dispose: () => {
      for (const c of [...connections]) c.destroy();
      connections.clear();
    },
  };
}

// Local ping frame (server frames are unmasked) — kept next to the liveness
// logic that uses it rather than expanding wire-ws.mjs's public surface.
function wsPingFrame() {
  return Buffer.from([0x89, 0x00]);
}
