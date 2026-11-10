// test/agent-bridge-headless-attempts.test.mjs — the ONE headless spawn
// resolution rule, shared by the adapter and doctor.
//
// Paid-for drift (2026-10-22): doctor treated ANY entry `command` as an
// override, while the adapter treated a command EQUAL to the profile default
// as "not explicit" and kept walking ZCODE_CLI / desktop fallbacks. A config
// that copied `["zcode"]` into the entry could therefore pass doctor's
// fallback check or fail it depending on which code path asked. These tests
// pin the shared list and doctor's use of it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { headlessAttempts } from '../adapters/headless-cli.mjs';
import { resolveCommandOf } from '../doctor.mjs';

const NO_ZCODE_CLI = { ZCODE_CLI: '' };
const FALLBACK = { bin: '/opt/fake/fake-cli', prefix: [], envPatch: {}, label: 'desktop fallback' };
const spec = {
  kind: 'headless',
  name: 'fake',
  command: ['fake-cli'],
  fallbackCandidates: () => [FALLBACK],
};

test('an explicit non-default command is the only attempt', () => {
  const attempts = headlessAttempts({
    command: ['other-cli', '--flag'],
    spec,
    env: { ZCODE_CLI: '/usr/bin/env node /opt/cli.js' },
  });
  assert.deepEqual(attempts, [
    { bin: 'other-cli', prefix: ['--flag'], envPatch: {}, label: 'command other-cli --flag' },
  ], 'explicit command must not fall through to ZCODE_CLI or the desktop install');
});

test('a command EQUAL to the profile default keeps ZCODE_CLI and fallbacks', () => {
  const attempts = headlessAttempts({
    command: ['fake-cli'],
    spec,
    env: { ZCODE_CLI: '/usr/bin/env node /opt/cli.js' },
  });
  assert.deepEqual(attempts.map((a) => a.label), [
    'ZCODE_CLI=/usr/bin/env node /opt/cli.js',
    'fake-cli (PATH)',
    'desktop fallback',
  ]);
});

test('ZCODE_CLI is trimmed and rides as a shell line', () => {
  const [first] = headlessAttempts({
    command: null,
    spec,
    env: { ZCODE_CLI: '  /usr/bin/env node /opt/cli.js  ' },
  });
  assert.equal(first.shellLine, '/usr/bin/env node /opt/cli.js');
});

test('no command and no ZCODE_CLI → PATH then desktop fallback', () => {
  const attempts = headlessAttempts({ command: null, spec, env: NO_ZCODE_CLI });
  assert.deepEqual(attempts.map((a) => a.label), ['fake-cli (PATH)', 'desktop fallback']);
});

test('doctor resolves the same fallback the adapter would spawn', () => {
  const b = { name: 'fake', command: ['fake-cli'], env: NO_ZCODE_CLI };
  const r = resolveCommandOf(b, {
    spec,
    find: (bin) => (bin === FALLBACK.bin ? FALLBACK.bin : null),
  });
  assert.equal(r.found, FALLBACK.bin,
    'a default-equal command must still reach the desktop fallback');
  assert.equal(r.overridden, true, 'the entry did carry a command');
});

test('doctor does NOT walk fallbacks for an explicit non-default command', () => {
  const b = { name: 'fake', command: ['other-cli'], env: NO_ZCODE_CLI };
  const asked = [];
  const r = resolveCommandOf(b, {
    spec,
    find: (bin) => { asked.push(bin); return null; },
  });
  assert.deepEqual(asked, ['other-cli']);
  assert.equal(r.found, null);
  assert.equal(r.cmd, 'other-cli');
});

test('doctor treats a set ZCODE_CLI as resolved (user escape hatch)', () => {
  const b = { name: 'fake', env: { ZCODE_CLI: '/usr/bin/env node /opt/cli.js' } };
  const r = resolveCommandOf(b, { spec, find: () => null });
  assert.equal(r.found, 'ZCODE_CLI=/usr/bin/env node /opt/cli.js');
});
