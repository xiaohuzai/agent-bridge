// test/agent-bridge-cli.test.mjs — the CLI's first-run experience: a missing
// default config must produce a hint that names the SHIPPED starter's real
// path (a global npm install's cwd does not contain agents.example.json —
// the file lives inside the package, so the hint must resolve it from the
// CLI's own location, not from the user's cwd).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '..', 'cli.mjs');
const REPO = join(__dirname, '..');
const STARTER = join(REPO, 'agents.example.json');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const tmp = mkdtempSync(join(tmpdir(), 'ab-cli-'));
process.on('exit', () => { try { rmSync(tmp, { recursive: true, force: true }); } catch (_) {} });

function runCli(args, cwd) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [CLI, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += String(d); });
    proc.on('exit', (code) => resolve({ code, stderr }));
  });
}

test('serve with no agents.json: the hint names the shipped starter by absolute path', async () => {
  const { code, stderr } = await runCli(['serve'], tmp);
  assert.equal(code, 1);
  assert.match(stderr, /No agents\.json here/);
  assert.match(stderr, new RegExp(escapeRe(STARTER)), 'hint must point at the starter next to cli.mjs, not the cwd');
  assert.match(stderr, /cp \S*agents\.example\.json agents\.json/);
});

test('acp with no agents.json: zero-setup fallback to the registry default', async () => {
  const { code, stderr } = await runCli(['acp', 'claude'], tmp);
  // stdin is /dev/null → the front shuts down cleanly (exit 0). The real
  // claude-agent-acp isn't on PATH here; that must not crash the front
  // either — a missing agent binary is a turn error, never a boot crash.
  assert.equal(code, 0);
  assert.match(stderr, /registry default for "claude"/);
  assert.doesNotMatch(stderr, /No agents\.json here/);
});

test('acp with no agents.json and an unknown name: names the known agents', async () => {
  const { code, stderr } = await runCli(['acp', 'nope'], tmp);
  assert.equal(code, 1);
  assert.match(stderr, /known agents: codex, claude, pi/);
  assert.match(stderr, /create an agents\.json/);
});

test('an explicitly missing --config path gets the raw error, no starter hint', async () => {
  const { code, stderr } = await runCli(['serve', '--config', join(tmp, 'nope.json')], REPO);
  assert.equal(code, 1);
  assert.match(stderr, /cannot read config/);
  assert.doesNotMatch(stderr, /shipped starter/);
});
