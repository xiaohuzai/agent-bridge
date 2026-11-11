// test/agent-bridge-jsonl-rpc.test.mjs — the shared JSONL transport's rpc
// table. Integration tests drive real fake agents; these pin the pieces that
// are easy to get subtly wrong: the timeout message, the no-timer escape for
// a v1 prompt response, and the method-tracking hooks ACP uses for logs.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createJsonlRpc } from '../adapters/jsonl-rpc.mjs';

const link = (extra = {}) => createJsonlRpc({
  command: ['unused-binary'],
  label: 'test',
  ...extra,
});

test('rpc timeout rejects with the label and method', async () => {
  const l = link();
  await assert.rejects(l.rpc('thread/start', {}, 5), /test rpc timeout: thread\/start/);
});

test('timeoutMs <= 0 means NO timer (a v1 prompt response may take a whole turn)', async () => {
  const l = link();
  const pending = l.rpc('session/prompt', {}, 0);
  const settled = await Promise.race([
    pending.then(() => true, () => true),
    new Promise((r) => setTimeout(() => r(false), 30)),
  ]);
  assert.equal(settled, false, 'the call must still be pending after the would-be timeout');
});

test('onRpcCall / onRpcSettled bracket the call (ACP logs errors by method)', async () => {
  const calls = [];
  const settled = [];
  const l = link({
    onRpcCall: (id, method) => calls.push([id, method]),
    onRpcSettled: (id) => settled.push(id),
  });
  await assert.rejects(l.rpc('initialize', {}, 5));
  assert.deepEqual(calls, [[1, 'initialize']]);
  assert.deepEqual(settled, [1]);
});
