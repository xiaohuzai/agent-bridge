// agent-bridge/server.mjs — the agent-bridge wire protocol (version 1) over HTTP.
//
// One tiny, stable, vendor-neutral contract between ANY client (a browser
// extension, an editor plugin, a script, your own UI — anything that can POST
// JSON and read SSE) and a LOCAL agent process the bridge owns. A client
// implements this once; every new CLI agent is just another adapter behind it
// (adapters/codex-app-server.mjs today, claude code next). The agent keeps its
// own per-session transcript — the client sends only the user's turn.
//
//   GET  /health              → {ok:true, agent, version, proto:1}
//   GET  /sessions            → {ok:true, sessions:[{sessionId, busy}]}
//   POST /turns               body {text, sessionId?, images?} → SSE stream:
//       images: optional array of strings — https:// URLs or data: URLs
//       (base64). They ride through to the agent as image inputs; the JSON
//       body cap (4MB) bounds their total size.
//       data: {"type":"start","sessionId":"…","turnId":"…"}
//       data: {"type":"delta","text":"…"}
//       data: {"type":"tool","name":"command","status":"started","detail":"…"}
//       data: {"type":"approval","requestId":"…","tool":"command","command":"…","cwd":"…"}
//       data: {"type":"usage","prompt_tokens":N,"completion_tokens":M}
//       data: {"type":"done","full":"…"}          ← turn finished normally
//       data: {"type":"aborted"}                  ← turn was interrupted
//       data: {"type":"error","message":"…"}
//       (": ka" comment lines are keepalives during silent stretches)
//   POST /approvals/:requestId  body {choice:'once'|'always'|'deny'} → {ok:true}
//
// Session ids are ASSIGNED BY THE ADAPTER on the first turn (start event) and
// passed back by the client on later turns; GET /sessions recovers them after
// a client restart. Security posture: binds 127.0.0.1 only, rejects
// non-loopback Host headers (DNS-rebinding), optional shared bearer token.
// CORS: browser clients on loopback origins (http(s)://localhost:* and
// http(s)://127.0.0.1:*) are served Access-Control-Allow-Origin reflections so
// plain web pages can talk to the bridge; other origins get no ACAO header
// (pass corsOrigin:'*' to open up — pair it with --token). Aborting = closing
// the POST /turns connection; the bridge notices the disconnect and
// interrupts the agent turn server-side. Turns are live-only: there is no
// replay of a turn you disconnected from.

import http from 'node:http';

const HEARTBEAT_MS = 15000;

/** CORS for one request: reflect loopback origins (any port), honor the
 * '*' override, everyone else gets no ACAO header (the browser blocks them). */
function corsHeaders(req, corsOrigin) {
  const origin = String(req.headers.origin || '');
  let allow = null;
  if (corsOrigin === '*') allow = '*';
  else if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) allow = origin;
  if (!allow) return {};
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

export function createBridgeServer({ adapter, agent, version, token, corsOrigin = 'loopback', log = () => {} }) {
  const server = http.createServer(async (req, res) => {
    try {
      const cors = corsHeaders(req, corsOrigin);
      // DNS-rebinding guard: only loopback Host headers.
      const host = String(req.headers.host || '').split(':')[0].toLowerCase();
      if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1' && host !== '[::1]') {
        res.writeHead(403, { 'Content-Type': 'application/json', ...cors });
        res.end(JSON.stringify({ ok: false, error: 'loopback only' }));
        return;
      }
      if (req.method === 'OPTIONS') {
        res.writeHead(204, cors);
        res.end();
        return;
      }
      if (token) {
        const auth = String(req.headers.authorization || '');
        if (auth !== `Bearer ${token}`) {
          res.writeHead(401, { 'Content-Type': 'application/json', ...cors });
          res.end(JSON.stringify({ ok: false, error: 'bad token' }));
          return;
        }
      }
      const url = new URL(req.url, 'http://x');
      if (req.method === 'GET' && url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
        res.end(JSON.stringify({ ok: true, agent, version, proto: 1 }));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/sessions') {
        res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
        res.end(JSON.stringify({ ok: true, sessions: adapter.listSessions() }));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/turns') {
        const body = await readJson(req);
        if (!body || typeof body.text !== 'string' || !body.text.trim()) {
          res.writeHead(400, { 'Content-Type': 'application/json', ...cors });
          res.end(JSON.stringify({ ok: false, error: 'text required' }));
          return;
        }
        if (body.images !== undefined) {
          if (!Array.isArray(body.images) || body.images.some((u) => typeof u !== 'string' || !u.trim()) || body.images.length > 8) {
            res.writeHead(400, { 'Content-Type': 'application/json', ...cors });
            res.end(JSON.stringify({ ok: false, error: 'images must be an array of ≤8 URL strings' }));
            return;
          }
          body.images = body.images.map((u) => u.trim());
        }
        await handleTurn(req, res, body, cors);
        return;
      }
      if (req.method === 'POST' && url.pathname.startsWith('/approvals/')) {
        const requestId = decodeURIComponent(url.pathname.slice('/approvals/'.length));
        const body = await readJson(req);
        const choice = body?.choice;
        if (!['once', 'always', 'deny'].includes(choice)) {
          res.writeHead(400, { 'Content-Type': 'application/json', ...cors });
          res.end(JSON.stringify({ ok: false, error: "choice must be 'once'|'always'|'deny'" }));
          return;
        }
        try {
          adapter.respondApproval(requestId, choice);
          res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(409, { 'Content-Type': 'application/json', ...cors });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify({ ok: false, error: 'not found' }));
    } catch (e) {
      log(`[bridge] ${req.method} ${req.url} → ${e.message}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      } else {
        try { res.end(); } catch (_) {}
      }
    }
  });

  async function handleTurn(req, res, body, cors) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      ...cors,
    });
    const ev = (obj) => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (_) {} };
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearInterval(hb);
      try { res.end(); } catch (_) {}
    };
    // Keepalives during silent agent stretches; also defeats buffering.
    const hb = setInterval(() => { try { res.write(': ka\n\n'); } catch (_) {} }, HEARTBEAT_MS);
    // Client disconnect (tab closed / panel closed / process death) = abort:
    // interrupt the agent turn so it never keeps running headless. MUST
    // listen on the RESPONSE stream: req 'close' fires as soon as the request
    // message is fully consumed (Node >=16 semantics) — an immediate false
    // abort that swallows the whole turn. The session id may only become
    // known when startTurn returns (first turn = client sent none), so it's
    // tracked on a mutable, not read from the request body alone.
    let liveSession = typeof body.sessionId === 'string' ? body.sessionId : null;
    res.on('close', () => {
      if (!finished && liveSession) {
        finished = true; // stop the hb timer; adapter interrupts below
        clearInterval(hb);
        log(`[bridge] client disconnected mid-turn — interrupting ${liveSession}`);
        adapter.interrupt(liveSession).catch(() => {}).finally(() => { try { res.destroy(); } catch (_) {} });
      }
    });
    const onEvent = (e) => {
      if (finished) return;
      ev(e);
      if (e.type === 'done' || e.type === 'aborted' || e.type === 'error') finish();
    };
    try {
      const { sessionId: sid } = await adapter.startTurn({
        text: body.text,
        sessionId: liveSession,
        images: Array.isArray(body.images) ? body.images : undefined,
        onEvent,
      });
      liveSession = sid || liveSession;
      // The client may have aborted while the turn was being admitted —
      // the close handler ran with liveSession still null. Interrupt now.
      if (res.destroyed && !finished && liveSession) {
        finished = true;
        clearInterval(hb);
        adapter.interrupt(liveSession).catch(() => {});
      }
    } catch (e) {
      onEvent({ type: 'error', message: e.message });
    }
  }

  return server;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 4 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => {
      if (!b) return resolve(null);
      try { resolve(JSON.parse(b)); } catch { resolve(null); }
    });
    req.on('error', reject);
  });
}
