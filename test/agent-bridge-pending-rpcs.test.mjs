// test/agent-bridge-pending-rpcs.test.mjs — child identity in the pending
// rpc table. A late exit from an old child must not reject a newer child's
// in-flight calls.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { rejectPendingForChild, rejectAllPending } from '../adapters/pending-rpcs.mjs';

function table() {
  const pending = new Map();
  const rejected = [];
  const add = (id, child) => pending.set(id, {
    child,
    reject: (e) => rejected.push([id, e.message]),
  });
  return { pending, rejected, add };
}

test('only the dead child\'s calls are rejected', () => {
  const { pending, rejected, add } = table();
  const oldChild = {};
  const newChild = {};
  add(1, oldChild);
  add(2, oldChild);
  add(3, newChild);
  rejectPendingForChild(pending, oldChild, 'old child exited');
  assert.deepEqual(rejected, [[1, 'old child exited'], [2, 'old child exited']]);
  assert.deepEqual([...pending.keys()], [3], 'the newer child\'s call survives');
});

test('a late exit for an already-replaced child is a no-op', () => {
  const { pending, rejected, add } = table();
  add(1, {});
  rejectPendingForChild(pending, {}, 'late exit');
  assert.deepEqual(rejected, []);
  assert.deepEqual([...pending.keys()], [1]);
});

test('rejectAllPending settles every call and clears the table', () => {
  const { pending, rejected, add } = table();
  add(1, {});
  add(2, {});
  rejectAllPending(pending, 'restarting');
  assert.deepEqual(rejected, [[1, 'restarting'], [2, 'restarting']]);
  assert.equal(pending.size, 0);
});
