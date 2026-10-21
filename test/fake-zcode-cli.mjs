#!/usr/bin/env node
// Scripted stand-in for the official `zcode` headless CLI. Speaks the JSONL
// envelope captured live 2026-10-21 (see adapters/headless-cli.mjs header):
// session.updated / turn.started / model.streaming / tool.updated /
// turn.completed / result. Prompt markers pick the branch:
//
//   PONG (or anything) → two text deltas "PO"+"NG", one usage, done
//   TOOL               → one tool.updated scheduled/started/result + text
//   THINK              → reasoning_start/delta/end before the text
//   SLOW               → stays alive ~30s before answering (interrupt tests)
//   REFUSE             → turn.completed.resultType "failure"
//   FAIL               → exits 2 with stderr before any event
//
// FAKE_ZCODE_LOG, when set, receives the parsed argv as JSON so tests can
// assert --mode/--resume/--cwd wiring without guessing.

import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
};
const prompt = opt('-p') || '';
const resume = opt('--resume');
const mode = opt('--mode');
const cwd = opt('--cwd');
if (process.env.FAKE_ZCODE_LOG) {
  writeFileSync(process.env.FAKE_ZCODE_LOG, JSON.stringify({ prompt, resume, mode, cwd, args }));
}

if (prompt.includes('FAIL')) {
  process.stderr.write('fake zcode: model backend unavailable\n');
  process.exit(2);
}

const sessionId = resume || 'sess_fake_1';
const turnId = 'turn_fake_1';
let seq = 0;
const emit = (type, payload = {}) => {
  process.stdout.write(JSON.stringify({
    eventId: `evt_${seq}`,
    payload,
    seq: ++seq,
    sessionId,
    timestamp: Date.now(),
    traceId: 'trace_fake_1',
    turnId,
    type,
  }) + '\n');
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stream = (kind, extra = {}) => emit('model.streaming', { assistantMessageId: 'msg_fake_1', delta: '', done: false, kind, ...extra });

async function main() {
  emit('session.updated', { hookEventName: 'SessionStart', source: 'startup' });
  emit('session.titleUpdated', { title: prompt.slice(0, 40), source: 'first_input' });
  emit('turn.started', { turnNumber: resume ? 1 : 0, input: prompt, messageId: 'msg_fake_1' });

  if (prompt.includes('SLOW')) {
    stream('start');
    await sleep(30_000);
  }

  stream('reasoning_start');
  if (prompt.includes('THINK')) stream('reasoning_delta', { delta: 'checking the input' });
  stream('reasoning_end');

  if (prompt.includes('TOOL')) {
    emit('tool.updated', { kind: 'scheduled', toolCallId: 'call_fake_1', toolName: 'Read', input: { file_path: '/tmp/fake.txt' } });
    emit('tool.updated', { kind: 'started', toolCallId: 'call_fake_1', toolName: 'Read', readOnly: true });
    await sleep(5);
    emit('tool.updated', { kind: 'result', toolCallId: 'call_fake_1', result: { success: true, content: 'ok' }, duration: 3 });
    emit('tool.updated', { kind: 'batch', toolCallIds: ['call_fake_1'], successCount: 1, errorCount: 0 });
  }

  stream('text_start');
  if (prompt.includes('TOOL')) {
    stream('tool_input_start');
    stream('tool_input_delta', { delta: '{"file_path":"/tmp/fake.txt"}' });
    stream('tool_input_end');
    stream('tool_call');
  }
  if (prompt.includes('REFUSE')) {
    emit('model.streaming', { kind: 'finish', done: true });
    emit('turn.completed', {
      response: '',
      resultType: 'failure',
      usage: { inputTokens: 100, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      toolCallCount: 0,
    });
    return;
  }

  const text = prompt.includes('TOOL') ? 'tool done' : 'PONG';
  const mid = Math.ceil(text.length / 2);
  for (const part of [text.slice(0, mid), text.slice(mid)]) {
    stream('text_delta', { delta: part });
    await sleep(5);
  }
  stream('text_end');
  emit('model.streaming', { kind: 'finish', done: true });

  const usage = {
    source: 'provider',
    modelRequestCount: 1,
    inputTokens: 100,
    outputTokens: 3,
    totalTokens: 103,
    cacheReadTokens: resume ? 40 : 0,
    cacheWriteTokens: 0,
    reasoningTokens: 1,
  };
  emit('turn.completed', { response: text, resultType: 'success', usage, toolCallCount: prompt.includes('TOOL') ? 1 : 0, duration: 10 });
  process.stdout.write(JSON.stringify({
    type: 'result',
    sessionId,
    traceId: 'trace_fake_1',
    turnId,
    response: text,
    usage,
    eventCount: seq,
    projection: { status: 'idle', turnCount: 1, totalTokenCount: 103, contextUsed: 103, contextWindow: 200000 },
  }) + '\n');
}

main().then(() => process.exit(0)).catch((e) => {
  process.stderr.write(`fake zcode crashed: ${e.message}\n`);
  process.exit(3);
});
