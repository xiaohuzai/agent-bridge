// agent-bridge/turn-stream.mjs — the v1 turn lifecycle, independent of HTTP.
//
// The rules here are the expensive ones (server.mjs header, "Disconnect =
// abort"): listen on the RESPONSE close, patch the session id from the
// `start` event (v1-style ACP agents keep startTurn pending for the whole
// turn), re-check destruction after admission, and never let a
// contract-violating sync interrupt kill the daemon.
//
// `wire` is the transport seam:
//   write(obj)      one SSE data frame
//   comment(text)   one SSE comment (heartbeat)
//   end()           finish the response
//   destroy()       hard-close the response
//   isDestroyed()   has the peer already gone?
//   onClose(cb)     register the response close listener
//
// The HTTP adapter lives in server.mjs; tests use a fake wire, which is what
// makes the disconnect races unit-testable instead of socket-only.

export function createTurnStream({
  adapter,
  text,
  sessionId,
  images,
  wire,
  heartbeatMs = 15000,
  log = () => {},
}) {
  async function run() {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearInterval(heartbeat);
      wire.end();
    };
    // Keepalives during silent agent stretches; also defeats buffering.
    const heartbeat = setInterval(() => wire.comment(': ka'), heartbeatMs);

    // The session id may only become known when startTurn returns (first turn
    // = the client sent none), so it is tracked on a mutable, not read from
    // the request body alone.
    let liveSession = typeof sessionId === 'string' ? sessionId : null;
    // The peer is gone but the session id may not be known yet. Stop the
    // heartbeat immediately; the late start event still has to interrupt.
    let clientGone = false;

    // Promise.resolve guards the contract: interrupt is async, but a
    // contract-violating SYNC return (or throw) must never crash the daemon
    // on the disconnect path.
    const interrupt = () => {
      let pending;
      try { pending = Promise.resolve(adapter.interrupt(liveSession)); }
      catch (e) { pending = Promise.reject(e); }
      return pending.catch(() => {});
    };
    const interruptLive = () => {
      if (!liveSession) return;
      interrupt().finally(() => wire.destroy());
    };

    // MUST be the response close: req 'close' fires as soon as the request
    // body is consumed (Node >=16), which would abort every turn instantly.
    wire.onClose(() => {
      if (finished) return;
      clientGone = true;
      clearInterval(heartbeat); // never leave a keepalive timer on a dead peer
      if (!liveSession) return; // the start-event patch below interrupts later
      finished = true;
      log(`[bridge] client disconnected mid-turn — interrupting ${liveSession}`);
      interruptLive();
    });

    const onEvent = (e) => {
      if (finished) return;
      // v1-style agents keep the prompt rpc pending for the whole turn, so a
      // mid-turn disconnect must already know the session to interrupt.
      if (e.type === 'start' && e.sessionId) {
        liveSession = e.sessionId;
        // A hard disconnect can fire close BEFORE the first start event; the
        // close handler had no session to interrupt. Interrupt now.
        if (clientGone || wire.isDestroyed()) {
          finished = true;
          clearInterval(heartbeat);
          log(`[bridge] client already gone when the session id landed — interrupting ${liveSession}`);
          interruptLive();
          return;
        }
      }
      wire.write(e);
      if (e.type === 'done' || e.type === 'aborted' || e.type === 'error') finish();
    };

    try {
      const { sessionId: admitted } = await adapter.startTurn({
        text,
        sessionId: liveSession,
        images,
        onEvent,
      });
      liveSession = admitted || liveSession;
      // The client may have aborted while the turn was being admitted — the
      // close handler ran with liveSession still null.
      if ((clientGone || wire.isDestroyed()) && !finished && liveSession) {
        finished = true;
        clearInterval(heartbeat);
        await interrupt();
      }
    } catch (e) {
      onEvent({ type: 'error', message: e.message });
    }
  }

  return { run };
}
