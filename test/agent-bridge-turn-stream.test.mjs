// test/agent-bridge-turn-stream.test.mjs — the v1 turn lifecycle with a fake
// wire. These are the disconnect races that used to require a real HTTP
// server plus a fake child process to exercise.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTurnStream } from '../turn-stream.mjs';

function harness({ startTurn, interrupt } = {}) {
  const events = [];
  let destroyed = false;
  let closeCb = null;
  const wire = {
    write: (obj) => events.push(obj),
    comment: (text) => events.push({ type: '__comment', text }),
    end: () => events.push({ type: '__end' }),
    destroy: () => { events.push({ type: '__destroy' }); destroyed = true; },
    isDestroyed: () => destroyed,
    onClose: (cb) => { closeCb = cb; },
  };
  const adapter = {
    startTurn: startTurn || (async ({ onEvent }) => {
      onEvent({ type: 'start', sessionId: 's1' });
      onEvent({ type: 'done', full: 'ok' });
      return { sessionId: 's1' };
    }),
    interrupt: interrupt || (async () => {}),
  };
  return {
    events,
    wire,
    adapter,
    close: () => { destroyed = true; closeCb?.(); },
    markDestroyed: () => { destroyed = true; },
  };
}

const stream = (h, extra = {}) => createTurnStream({
  adapter: h.adapter,
  text: 'hi',
  wire: h.wire,
  heartbeatMs: 60_000,
  ...extra,
});

test('a normal turn streams start → done and ends the response', async () => {
  const h = harness();
  await stream(h).run();
  assert.deepEqual(h.events.map((e) => e.type), ['start', 'done', '__end']);
  assert.equal(h.events.some((e) => e.type === '__destroy'), false);
});

test('a disconnect mid-turn interrupts the session from the start event', async () => {
  let release;
  const interrupts = [];
  const h = harness({
    startTurn: ({ onEvent }) => {
      onEvent({ type: 'start', sessionId: 'sess-live' });
      return new Promise((resolve) => {
        release = () => { onEvent({ type: 'done', full: 'late' }); resolve({ sessionId: 'sess-live' }); };
      });
    },
    interrupt: async (sid) => { interrupts.push(sid); },
  });
  const running = stream(h).run();
  await new Promise((r) => setImmediate(r));
  h.close();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(interrupts, ['sess-live']);
  release();
  await running;
  assert.equal(h.events.some((e) => e.type === 'done'), false, 'events after close are dropped');
  assert.equal(h.events.some((e) => e.type === '__destroy'), true);
});

test('a close BEFORE the start event still interrupts when the id lands', async () => {
  let emitStart;
  const interrupts = [];
  const h = harness({
    startTurn: ({ onEvent }) => {
      emitStart = () => onEvent({ type: 'start', sessionId: 'sess-late' });
      return new Promise(() => {});
    },
    interrupt: async (sid) => { interrupts.push(sid); },
  });
  stream(h).run();
  h.close(); // no session known yet → nothing to interrupt
  assert.deepEqual(interrupts, []);
  emitStart();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(interrupts, ['sess-late']);
  assert.equal(h.events.some((e) => e.type === 'start'), false, 'a gone client gets no frames');
});

test('a sync interrupt return (contract violation) still destroys the wire', async () => {
  const h = harness({
    startTurn: ({ onEvent }) => {
      onEvent({ type: 'start', sessionId: 's1' });
      return new Promise(() => {});
    },
    interrupt: () => undefined,
  });
  stream(h).run();
  h.close();
  await new Promise((r) => setImmediate(r));
  assert.equal(h.events.some((e) => e.type === '__destroy'), true);
});

test('an interrupt that throws synchronously does not escape', async () => {
  const h = harness({
    startTurn: ({ onEvent }) => {
      onEvent({ type: 'start', sessionId: 's1' });
      return new Promise(() => {});
    },
    interrupt: () => { throw new Error('boom'); },
  });
  stream(h).run();
  h.close();
  await new Promise((r) => setImmediate(r));
  assert.equal(h.events.some((e) => e.type === '__destroy'), true);
});

test('a turn that throws becomes an error event and ends the stream', async () => {
  const h = harness({ startTurn: async () => { throw new Error('nope'); } });
  await stream(h).run();
  assert.equal(h.events[0].type, 'error');
  assert.match(h.events[0].message, /nope/);
  assert.equal(h.events.at(-1).type, '__end');
});

test('destruction during admission interrupts the admitted session', async () => {
  const interrupts = [];
  const h = harness({
    startTurn: async () => {
      h.markDestroyed();
      return { sessionId: 'sess-admitted' };
    },
    interrupt: async (sid) => { interrupts.push(sid); },
  });
  await stream(h).run();
  assert.deepEqual(interrupts, ['sess-admitted']);
  assert.equal(h.events.some((e) => e.type === '__end'), false);
});

test('heartbeats are written during a silent stretch', async () => {
  const h = harness({ startTurn: () => new Promise(() => {}) });
  stream(h, { heartbeatMs: 5 }).run();
  await new Promise((r) => setTimeout(r, 20));
  const comments = h.events.filter((e) => e.type === '__comment');
  assert.ok(comments.length >= 1, 'expected at least one heartbeat comment');
  assert.equal(comments[0].text, ': ka');
  const before = comments.length;
  h.close();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(h.events.filter((e) => e.type === '__comment').length, before,
    'a closed peer must not leave a keepalive timer running');
});
