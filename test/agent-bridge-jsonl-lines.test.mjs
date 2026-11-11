// test/agent-bridge-jsonl-lines.test.mjs — the shared JSONL line splitter.
// Every stdio protocol here (codex app-server, ACP, the ACP stdio front, the
// headless CLI) receives arbitrary chunks: one line split across chunks,
// several lines in one chunk, blank keepalive lines. Getting that wrong drops
// or merges frames, so it is pinned once here instead of per adapter.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createLineSplitter } from '../jsonl-lines.mjs';

function collect() {
  const lines = [];
  return { lines, splitter: createLineSplitter((line) => lines.push(line)) };
}

test('one terminated line is delivered once', () => {
  const { lines, splitter } = collect();
  splitter.push('{"a":1}\n');
  assert.deepEqual(lines, ['{"a":1}']);
});

test('a line split across chunks is reassembled', () => {
  const { lines, splitter } = collect();
  splitter.push('{"a"');
  assert.deepEqual(lines, []);
  splitter.push(':1}\n');
  assert.deepEqual(lines, ['{"a":1}']);
});

test('several lines in one chunk are all delivered, in order', () => {
  const { lines, splitter } = collect();
  splitter.push('a\nb\nc\n');
  assert.deepEqual(lines, ['a', 'b', 'c']);
});

test('blank lines are delivered as empty strings (callers decide to skip)', () => {
  const { lines, splitter } = collect();
  splitter.push('\n\na\n');
  assert.deepEqual(lines, ['', '', 'a']);
});

test('an unterminated tail is NOT a line until its newline arrives', () => {
  const { lines, splitter } = collect();
  splitter.push('{"partial":true}');
  assert.deepEqual(lines, []);
  splitter.push('\n');
  assert.deepEqual(lines, ['{"partial":true}']);
});

test('flush delivers a final unterminated line exactly once', () => {
  const { lines, splitter } = collect();
  splitter.push('{"partial":true}');
  splitter.flush();
  assert.deepEqual(lines, ['{"partial":true}']);
  splitter.flush();
  assert.deepEqual(lines, ['{"partial":true}'], 'a second flush must not duplicate');
});

test('flush drops a whitespace-only tail', () => {
  const { lines, splitter } = collect();
  splitter.push(' \t ');
  splitter.flush();
  assert.deepEqual(lines, []);
});

test('CRLF is normalized to LF (the \\r never reaches a JSON parser)', () => {
  const { lines, splitter } = collect();
  splitter.push('a\r\nb\r\n');
  assert.deepEqual(lines, ['a', 'b']);
});

test('Buffer chunks are accepted (stdout without setEncoding)', () => {
  const { lines, splitter } = collect();
  splitter.push(Buffer.from('{"a":1}\n'));
  assert.deepEqual(lines, ['{"a":1}']);
});

test('a multibyte character split across Buffer chunks survives decoding', () => {
  const { lines, splitter } = collect();
  const bytes = Buffer.from('{"t":"你好"}\n');
  const first = bytes.indexOf(0xe4); // first byte of 你
  splitter.push(bytes.subarray(0, first + 1));
  splitter.push(bytes.subarray(first + 1, first + 2));
  splitter.push(bytes.subarray(first + 2));
  assert.deepEqual(lines, ['{"t":"你好"}']);
});
