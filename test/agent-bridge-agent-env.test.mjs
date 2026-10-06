// test/agent-bridge-agent-env.test.mjs — adapters/agent-env.mjs: the bundled
// bin-dir discovery and the child PATH it builds (the "one install covers the
// agent CLIs" guarantee — see adapters/agent-env.mjs and package.json's
// optionalDependencies).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';

const { bundledBinDirs, agentPath, agentSpawnEnv } = await import('../adapters/agent-env.mjs');

const PATH_KEY = process.platform === 'win32' ? 'Path' : 'PATH';
const SEP = process.platform === 'win32' ? ';' : ':';

test('bundledBinDirs only returns existing directories (no dead PATH entries)', () => {
  for (const d of bundledBinDirs()) {
    assert.ok(statSync(d).isDirectory(), `${d} must exist`);
  }
});

test('agentPath() appends the bundled dirs AFTER the system PATH (user installs win) and is idempotent', () => {
  const dirs = bundledBinDirs();
  // Controlled PATH: bundled dirs must land AFTER it, never shadow it.
  const saved = process.env.PATH;
  process.env.PATH = '/usr/bin';
  try {
    if (dirs.length) {
      const once = agentPath();
      assert.ok(once.startsWith('/usr/bin' + SEP), 'system PATH comes first');
      assert.ok(once.endsWith(dirs.join(SEP)), 'bundled dirs come last');
      // Re-augmenting an already-augmented PATH must not duplicate entries.
      process.env.PATH = once;
      const twice = agentPath();
      for (const d of dirs) {
        assert.equal(twice.split(SEP).filter((p) => p === d).length, 1, `no duplicate for ${d}`);
      }
    } else {
      assert.equal(agentPath(), '/usr/bin', 'nothing bundled → PATH unchanged');
    }
  } finally {
    process.env.PATH = saved;
  }
});

test('agentSpawnEnv: bundled PATH rides in, extra env rides OVER it, daemon env inherits', () => {
  const env = agentSpawnEnv({ CODEX_HOME: '/tmp/xyz-home' });
  assert.equal(env.CODEX_HOME, '/tmp/xyz-home');
  assert.equal(env[PATH_KEY], agentPath());
  assert.equal(env.HOME, process.env.HOME);
});
