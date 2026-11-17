#!/usr/bin/env node
// Scripted stand-in for the official `zcode` headless CLI. Speaks the JSONL
// envelope captured live 2026-10-21 (see adapters/headless-cli.mjs header):
// session.updated / turn.started / model.streaming / tool.updated /
// turn.completed / result. Prompt markers pick the branch:
//
//   PONG (or anything) → two text deltas "PO"+"NG", one usage, done
//   TOOL               → one tool.updated scheduled/started/result + text
//   TOOL_BAD_RESULT    → result.success false, but the enclosing turn succeeds
//   TOOL_EXCEPTION     → tool.updated error, but the enclosing turn succeeds
//   TOOL_NONZERO       → Bash exit 1 with result.success true
//   TOOL_MCP_ERROR     → MCP error text with result.success true
//   TOOL_UNKNOWN       → result with no success flag (legacy fallback)
//   REPLAY_SEQUENCE    → old terminal/start frames after failure and ID reuse
//   REPLAY_NO_SEQ      → the same failure and ID reuse without sequence numbers
//   REPLAY_SESSIONS    → two child sessions reuse an id with independent sequences
//   REPLAY_NO_SESSION  → unscoped frames must not inherit another session's sequence
//   REPLAY_PARTIAL     → some frames omit session ids or sequence numbers
//   REPLAY_NO_SESSION_ONLY → all frames omit session ids
//   REVIEW_WATERMARK   → ignored newer success before an old replayed start
//   REVIEW_NO_START    → new scheduled/result after a terminal event, with no started
//   REVIEW_CHILD_SCOPE → unscoped new child after an earlier session has ended
//   REVIEW_BEHAVIOR    → duplicate, incomplete, and ambiguous tool events
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

// The account-plan dead end observed live 2026-10-22: the CLI prints its own
// terse message and exits without ever starting a turn.
if (prompt.includes('NOMODEL')) {
  process.stderr.write('Error: Select a model before sending a message (traceId: fake)\n');
  process.exit(1);
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
const toolFrame = (payload, frameSeq, frameSession = sessionId) => {
  const frame = { type: 'tool.updated', sessionId: frameSession, turnId, traceId: 'trace_fake_1', timestamp: Date.now(), payload };
  if (frameSeq !== undefined) frame.seq = frameSeq;
  process.stdout.write(JSON.stringify(frame) + '\n');
};

async function main() {
  emit('session.updated', { hookEventName: 'SessionStart', source: 'startup' });
  emit('session.titleUpdated', { title: prompt.slice(0, 40), source: 'first_input' });
  emit('turn.started', {
    turnNumber: resume ? 1 : 0,
    input: prompt,
    messageId: 'msg_fake_1',
    // The model the CLI resolved — the bridge reports it as a model note.
    intent: { modelSelection: { providerId: 'provider_fake', modelId: 'model-fake-1', options: { reasoningLevel: 'max' } } },
  });

  if (prompt.includes('SLOW')) {
    stream('start');
    await sleep(30_000);
  }

  stream('reasoning_start');
  if (prompt.includes('THINK')) stream('reasoning_delta', { delta: 'checking the input' });
  stream('reasoning_end');

  if (prompt.includes('REVIEW_BEHAVIOR')) {
    const equal = 'quality_equal';
    toolFrame({ kind: 'scheduled', toolCallId: equal, toolName: 'Read', input: { file_path: '/tmp/equal.txt' } }, 1, 'quality_a');
    toolFrame({ kind: 'started', toolCallId: equal, toolName: 'Read' }, 2, 'quality_a');
    toolFrame({ kind: 'started', toolCallId: equal, toolName: 'Read' }, 2, 'quality_a');
    toolFrame({ kind: 'result', toolCallId: equal, result: { success: true } }, 3, 'quality_a');

    const failed = 'quality_failed';
    toolFrame({ kind: 'scheduled', toolCallId: failed, toolName: 'Read', input: { file_path: '/tmp/failed.txt' } }, 1, 'quality_a');
    toolFrame({ kind: 'started', toolCallId: failed, toolName: 'Read' }, 2, 'quality_a');
    toolFrame({ kind: 'error', toolCallId: failed, error: { message: 'failed' } }, 3, 'quality_a');
    toolFrame({ kind: 'result', toolCallId: failed, result: { success: true } }, undefined, null);

    const missing = 'quality_missing';
    toolFrame({ kind: 'scheduled', toolCallId: missing, toolName: 'Read', input: { file_path: '/tmp/missing.txt' } }, 1, 'quality_a');
    toolFrame({ kind: 'started', toolCallId: missing }, 2, 'quality_a');
    toolFrame({ kind: 'result', toolCallId: missing }, 3, 'quality_a');

    const empty = 'quality_empty';
    toolFrame({ kind: 'scheduled', toolCallId: empty, toolName: 'Read', input: { file_path: '/tmp/old.txt' } }, 1, 'quality_a');
    toolFrame({ kind: 'started', toolCallId: empty, toolName: 'Read' }, 2, 'quality_a');
    toolFrame({ kind: 'result', toolCallId: empty, result: { success: true } }, 3, 'quality_a');
    toolFrame({ kind: 'scheduled', toolCallId: empty, toolName: 'Bash' }, 4, 'quality_a');
    toolFrame({ kind: 'started', toolCallId: empty, toolName: 'Bash' }, 5, 'quality_a');
    toolFrame({ kind: 'result', toolCallId: empty, result: { success: true } }, 6, 'quality_a');

    const pending = 'quality_pending';
    toolFrame({ kind: 'scheduled', toolCallId: pending, toolName: 'Read', input: { file_path: '/tmp/a.txt' } }, 1, 'quality_a');
    toolFrame({ kind: 'started', toolCallId: pending, toolName: 'Read' }, 2, 'quality_a');
    toolFrame({ kind: 'result', toolCallId: pending, result: { success: true } }, 3, 'quality_a');
    toolFrame({ kind: 'scheduled', toolCallId: pending, toolName: 'Bash', input: { command: 'echo a' } }, 4, 'quality_a');
    toolFrame({ kind: 'scheduled', toolCallId: pending, toolName: 'Read', input: { file_path: '/tmp/b.txt' } }, 1, 'quality_b');
    toolFrame({ kind: 'started', toolCallId: pending, toolName: 'Read' }, 2, 'quality_b');
    toolFrame({ kind: 'error', toolCallId: pending, error: { message: 'ambiguous' } }, undefined, null);
    toolFrame({ kind: 'result', toolCallId: pending, result: { success: true } }, 5, 'quality_a');
    toolFrame({ kind: 'result', toolCallId: pending, result: { success: true } }, 3, 'quality_b');
  } else if (prompt.includes('REVIEW_CHILD_SCOPE')) {
    const id = 'call_child';
    toolFrame({ kind: 'scheduled', toolCallId: id, toolName: 'Read', input: { file_path: '/tmp/a.txt' } }, 1, 'sub_a');
    toolFrame({ kind: 'started', toolCallId: id, toolName: 'Read' }, 2, 'sub_a');
    toolFrame({ kind: 'result', toolCallId: id, result: { success: true } }, 3, 'sub_a');
    toolFrame({ kind: 'scheduled', toolCallId: id, toolName: 'Bash', input: { command: 'echo b' } }, 4, null);
    toolFrame({ kind: 'started', toolCallId: id, toolName: 'Bash' }, 5, null);
    toolFrame({ kind: 'result', toolCallId: id, result: { success: true } }, 1, 'sub_b');

    const sameName = 'call_same_name';
    toolFrame({ kind: 'scheduled', toolCallId: sameName, toolName: 'Read', input: { file_path: '/tmp/first.txt' } }, 1, 'sub_a');
    toolFrame({ kind: 'started', toolCallId: sameName, toolName: 'Read' }, 2, 'sub_a');
    toolFrame({ kind: 'result', toolCallId: sameName, result: { success: true } }, 3, 'sub_a');
    toolFrame({ kind: 'scheduled', toolCallId: sameName, toolName: 'Read', input: { file_path: '/tmp/second.txt' } }, 4, null);
    toolFrame({ kind: 'started', toolCallId: sameName, toolName: 'Read' }, 5, null);
    toolFrame({ kind: 'result', toolCallId: sameName, result: { success: true } }, 1, 'sub_b');

    const ambiguous = 'call_ambiguous';
    toolFrame({ kind: 'scheduled', toolCallId: ambiguous, toolName: 'Read', input: { file_path: '/tmp/active.txt' } }, 1, 'sub_a');
    toolFrame({ kind: 'started', toolCallId: ambiguous, toolName: 'Read' }, 2, 'sub_a');
    toolFrame({ kind: 'scheduled', toolCallId: ambiguous, toolName: 'Bash', input: { command: 'echo other' } }, 1, null);
    toolFrame({ kind: 'started', toolCallId: ambiguous, toolName: 'Bash' }, 2, null);
    toolFrame({ kind: 'result', toolCallId: ambiguous, result: { success: true } }, 1, 'sub_b');
    toolFrame({ kind: 'result', toolCallId: ambiguous, result: { success: true } }, 3, 'sub_a');
  } else if (prompt.includes('REVIEW_NO_START')) {
    for (const [id, failed] of [['call_completed', false], ['call_failed', true]]) {
      toolFrame({ kind: 'scheduled', toolCallId: id, toolName: 'Read', input: { file_path: '/tmp/a.txt' } }, 1);
      toolFrame({ kind: 'started', toolCallId: id, toolName: 'Read' }, 2);
      toolFrame(failed ? { kind: 'error', toolCallId: id, error: { message: 'failed' } } : { kind: 'result', toolCallId: id, result: { success: true } }, 3);
      toolFrame({ kind: 'scheduled', toolCallId: id, toolName: 'Bash', input: { command: 'echo b' } }, 4);
      toolFrame({ kind: 'result', toolCallId: id, result: { success: true } }, 5);
    }
    const id = 'call_partial_reused';
    toolFrame({ kind: 'scheduled', toolCallId: id, toolName: 'Read', input: { file_path: '/tmp/a.txt' } }, 1, 'sub_reused');
    toolFrame({ kind: 'started', toolCallId: id, toolName: 'Read' }, 2, 'sub_reused');
    toolFrame({ kind: 'result', toolCallId: id, result: { success: true } }, 3, 'sub_reused');
    toolFrame({ kind: 'scheduled', toolCallId: id, toolName: 'Bash', input: { command: 'echo mixed' } }, 4, null);
    toolFrame({ kind: 'result', toolCallId: id, result: { success: true } }, 5, 'sub_reused');
  } else if (prompt.includes('REVIEW_WATERMARK')) {
    const id = 'call_watermark';
    toolFrame({ kind: 'scheduled', toolCallId: id, toolName: 'Read', input: { file_path: '/tmp/a.txt' } }, 1);
    toolFrame({ kind: 'started', toolCallId: id, toolName: 'Read' }, 2);
    toolFrame({ kind: 'error', toolCallId: id, error: { message: 'failed' } }, 10);
    toolFrame({ kind: 'result', toolCallId: id, result: { success: true } }, 30);
    toolFrame({ kind: 'started', toolCallId: id, toolName: 'Read' }, 20);
    toolFrame({ kind: 'result', toolCallId: id, result: { success: true } }, 21);
    toolFrame({ kind: 'started', toolCallId: id, toolName: 'Read' }, 31);
    toolFrame({ kind: 'result', toolCallId: id, result: { success: true } }, 32);
  } else if (prompt.includes('REPLAY_SEQUENCE')) {
    const id = 'call_replay';
    toolFrame({ kind: 'scheduled', toolCallId: id, toolName: 'Read', input: { file_path: '/tmp/replay.txt' } }, 20);
    toolFrame({ kind: 'started', toolCallId: id, toolName: 'Read' }, 21);
    toolFrame({ kind: 'result', toolCallId: id, result: { success: true } }, 25);
    toolFrame({ kind: 'error', toolCallId: id, error: { message: 'failed' } }, 27);
    toolFrame({ kind: 'result', toolCallId: id, result: { success: true } }, 25);
    toolFrame({ kind: 'result', toolCallId: id, result: { content: 'unknown' } }, 26);
    toolFrame({ kind: 'started', toolCallId: id, toolName: 'Read' }, 21);
    toolFrame({ kind: 'result', toolCallId: id, result: { success: true } }, 28);
    toolFrame({ kind: 'scheduled', toolCallId: id, toolName: 'Read', input: { file_path: '/tmp/reused.txt' } }, 29);
    toolFrame({ kind: 'started', toolCallId: id, toolName: 'Read' }, 30);
    toolFrame({ kind: 'error', toolCallId: id, error: { message: 'old replay' } }, 27);
    toolFrame({ kind: 'result', toolCallId: id, result: { success: true } }, 31);
  } else if (prompt.includes('REPLAY_NO_SEQ')) {
    const id = 'call_unsequenced';
    toolFrame({ kind: 'scheduled', toolCallId: id, toolName: 'Read', input: { file_path: '/tmp/replay.txt' } });
    toolFrame({ kind: 'started', toolCallId: id, toolName: 'Read' });
    toolFrame({ kind: 'error', toolCallId: id, error: { message: 'failed' } });
    toolFrame({ kind: 'result', toolCallId: id, result: { success: true } });
    toolFrame({ kind: 'result', toolCallId: id, result: { content: 'unknown' } });
    toolFrame({ kind: 'started', toolCallId: id, toolName: 'Read' });
    toolFrame({ kind: 'result', toolCallId: id, result: { success: true } });
  } else if (prompt.includes('REPLAY_SESSIONS')) {
    const id = 'call_shared';
    const number = (n) => prompt.includes('NO_SEQ') ? undefined : n;
    toolFrame({ kind: 'scheduled', toolCallId: id, toolName: 'Read', input: { file_path: '/tmp/a.txt' } }, number(99), 'sub_a');
    toolFrame({ kind: 'started', toolCallId: id, toolName: 'Read' }, number(100), 'sub_a');
    toolFrame({ kind: 'scheduled', toolCallId: id, toolName: 'Bash', input: { command: 'echo b' } }, number(1), 'sub_b');
    toolFrame({ kind: 'started', toolCallId: id, toolName: 'Bash' }, number(2), 'sub_b');
    toolFrame({ kind: 'error', toolCallId: id, error: { message: 'failed' } }, number(102), 'sub_a');
    toolFrame({ kind: 'result', toolCallId: id, result: { success: true } }, number(3), 'sub_b');
    toolFrame({ kind: 'result', toolCallId: id, result: { success: true } }, number(101), 'sub_a');
  } else if (prompt.includes('REPLAY_PARTIAL')) {
    toolFrame({ kind: 'scheduled', toolCallId: 'partial_a', toolName: 'Read', input: { file_path: '/tmp/partial-a.txt' } }, 40, 'sub_a');
    toolFrame({ kind: 'started', toolCallId: 'partial_a', toolName: 'Read' }, 999, null);
    toolFrame({ kind: 'error', toolCallId: 'partial_a', error: { message: 'failed' } }, 999, null);
    toolFrame({ kind: 'result', toolCallId: 'partial_a', result: { success: true } }, 42, 'sub_a');
    toolFrame({ kind: 'started', toolCallId: 'partial_a', toolName: 'Read' }, 43, 'sub_a');
    toolFrame({ kind: 'result', toolCallId: 'partial_a', result: { success: true } }, 44, 'sub_a');

    toolFrame({ kind: 'scheduled', toolCallId: 'partial_b', toolName: 'Read', input: { file_path: '/tmp/partial-b.txt' } }, 900, null);
    toolFrame({ kind: 'started', toolCallId: 'partial_b', toolName: 'Read' }, 2, 'sub_b');
    toolFrame({ kind: 'result', toolCallId: 'partial_b', result: { success: true } }, 999, null);

    toolFrame({ kind: 'scheduled', toolCallId: 'partial_c', toolName: 'Read', input: { file_path: '/tmp/c.txt' } }, 1, 'sub_c_a');
    toolFrame({ kind: 'started', toolCallId: 'partial_c', toolName: 'Read' }, 2, 'sub_c_a');
    toolFrame({ kind: 'scheduled', toolCallId: 'partial_c', toolName: 'Bash', input: { command: 'echo c' } }, 1, 'sub_c_b');
    toolFrame({ kind: 'started', toolCallId: 'partial_c', toolName: 'Bash' }, 2, 'sub_c_b');
    toolFrame({ kind: 'error', toolCallId: 'partial_c', error: { message: 'ambiguous' } }, 999, null);
    toolFrame({ kind: 'result', toolCallId: 'partial_c', result: { success: true } }, 3, 'sub_c_a');
    toolFrame({ kind: 'result', toolCallId: 'partial_c', result: { success: true } }, 3, 'sub_c_b');
  } else if (prompt.includes('REPLAY_NO_SESSION_ONLY')) {
    const id = 'call_unscoped';
    toolFrame({ kind: 'scheduled', toolCallId: id, toolName: 'Read', input: { file_path: '/tmp/unscoped.txt' } }, 10, null);
    toolFrame({ kind: 'started', toolCallId: id, toolName: 'Read' }, 11, null);
    toolFrame({ kind: 'error', toolCallId: id, error: { message: 'failed' } }, 12, null);
    toolFrame({ kind: 'result', toolCallId: id, result: { success: true } }, 13, null);
    toolFrame({ kind: 'result', toolCallId: id, result: { content: 'unknown' } }, 14, null);
    toolFrame({ kind: 'started', toolCallId: id, toolName: 'Read' }, 15, null);
    toolFrame({ kind: 'result', toolCallId: id, result: { success: true } }, 16, null);
  } else if (prompt.includes('REPLAY_NO_SESSION')) {
    const id = 'call_shared';
    toolFrame({ kind: 'started', toolCallId: id, toolName: 'Read' }, 100, 'sub_a');
    toolFrame({ kind: 'error', toolCallId: id, error: { message: 'failed' } }, 102, 'sub_a');
    toolFrame({ kind: 'scheduled', toolCallId: id, toolName: 'Bash', input: { command: 'echo unknown' } }, 1, null);
    toolFrame({ kind: 'started', toolCallId: id, toolName: 'Bash' }, 2, null);
    toolFrame({ kind: 'result', toolCallId: id, result: { success: true } }, 3, null);
  }

  if (prompt.includes('TOOL')) {
    const providerResult = prompt.includes('TOOL_BAD_RESULT');
    const nonzero = prompt.includes('TOOL_NONZERO');
    const mcpError = prompt.includes('TOOL_MCP_ERROR');
    const toolName = providerResult ? 'fixture_fail' : nonzero ? 'Bash' : mcpError ? 'mcp__fixture__fixture_fail' : 'Read';
    const input = providerResult || mcpError ? {} : nonzero ? { command: 'false' } : { file_path: '/tmp/fake.txt' };
    emit('tool.updated', { kind: 'scheduled', toolCallId: 'call_fake_1', toolName, input });
    emit('tool.updated', { kind: 'started', toolCallId: 'call_fake_1', toolName, readOnly: true });
    await sleep(5);
    if (prompt.includes('TOOL_EXCEPTION')) {
      emit('tool.updated', { kind: 'error', toolCallId: 'call_fake_1', error: { type: 'tool_execution_failed', message: 'File does not exist.', code: 'TOOL_EXECUTION_FAILED', detail: 'file not found', stack: 'Error: File does not exist.' } });
    } else if (providerResult) {
      emit('tool.updated', { kind: 'result', toolCallId: 'call_fake_1', result: { success: false, content: 'fixture failed', display: { kind: 'mcp_tool', serverName: 'server', toolName }, error: { type: 'provider_tool_error', message: 'fixture failed' } }, duration: 2 });
    } else if (nonzero) {
      emit('tool.updated', { kind: 'result', toolCallId: 'call_fake_1', result: { success: true, content: 'Exit code 1', perf: { detail: { kind: 'command', command: { exitCode: 1, status: 'failed' } } } }, duration: 2 });
    } else if (mcpError) {
      emit('tool.updated', { kind: 'result', toolCallId: 'call_fake_1', result: { success: true, content: 'MCP tool returned an error:\nfixture failed' }, duration: 2 });
    } else if (prompt.includes('TOOL_UNKNOWN')) {
      emit('tool.updated', { kind: 'result', toolCallId: 'call_fake_1', result: { content: 'unknown result' }, duration: 2 });
    } else {
      emit('tool.updated', { kind: 'result', toolCallId: 'call_fake_1', result: { success: true, content: 'ok' }, duration: 3 });
    }
    if (!providerResult) {
      const failed = prompt.includes('TOOL_EXCEPTION');
      emit('tool.updated', { kind: 'batch', toolCallIds: ['call_fake_1'], successCount: failed ? 0 : 1, errorCount: failed ? 1 : 0 });
    }
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
