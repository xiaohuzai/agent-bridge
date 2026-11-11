// test/agent-bridge-package.test.mjs — the published tarball surface.
//
// `files` is an allowlist, so a runtime module missing from it ships a broken
// package while the repo tests stay green. The paused native ZCode adapter is
// the opposite case: it must stay in the repo/test suite as a reference
// capture but not ride every npm install (adapters/.npmignore).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

test('the tarball carries every runtime module and drops the paused native adapter', () => {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: REPO,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const [pkg] = JSON.parse(out);
  const files = pkg.files.map((f) => f.path);

  for (const required of [
    'cli.mjs',
    'server.mjs',
    'serve.mjs',
    'doctor.mjs',
    'jsonl-lines.mjs',
    'turn-stream.mjs',
    'agents-registry.mjs',
    'adapters/usage.mjs',
    'adapters/pending-rpcs.mjs',
    'adapters/jsonl-rpc.mjs',
    'adapters/headless-cli.mjs',
    'adapters/codex-app-server.mjs',
    'adapters/acp-stdio.mjs',
  ]) {
    assert.ok(files.includes(required), `${required} must ship in the tarball`);
  }

  assert.equal(files.includes('adapters/zcode-server.mjs'), false,
    'the paused native adapter is reference-only and must not ship');
  assert.equal(files.some((f) => f.startsWith('test/')), false, 'tests never ship');
  assert.equal(files.some((f) => f.endsWith('.npmignore')), false, 'ignore files never ship');
});
