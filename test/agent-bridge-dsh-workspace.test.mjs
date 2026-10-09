// test/agent-bridge-dsh-workspace.test.mjs — the dsh desktop-visibility
// registration (adapters/dsh-workspace.mjs): append new session ids into the
// matching dsh workspace's sessionIds so the desktop/Web session list renders
// them. Pure fs + JSON — no chrome, no network.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { registerSessionInWorkspace } from '../adapters/dsh-workspace.mjs';

let dir;
let dshHome;
const logs = [];
const CWD = '/Users/me/work-agent-bridge';

function seedRegistry(workspaces) {
  const doc = {
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: workspaces.map((w) => w.id), archivedSessionIds: [] },
    tables: { workspaces: Object.fromEntries(workspaces.map((w) => [w.id, w])) },
  };
  writeFileSync(join(dshHome, 'storages', 'workspace.json'), JSON.stringify(doc, null, 2));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-ws-'));
  dshHome = join(dir, 'dsh-home');
  mkdirSync(join(dshHome, 'storages'), { recursive: true });
  mkdirSync(join(dshHome, 'sessions', '--Users-me-work-agent-bridge--'), { recursive: true });
  logs.length = 0;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test('registers a session into the workspace whose path matches the entry cwd', () => {
  process.env.DSH_HOME = dshHome;
  seedRegistry([{ id: 'w1', path: CWD, title: 'agent-bridge', sessionIds: [] }]);
  registerSessionInWorkspace(CWD, 'sess-1', (m) => logs.push(m));
  const doc = JSON.parse(readFileSync(join(dshHome, 'storages', 'workspace.json'), 'utf8'));
  assert.deepEqual(doc.tables.workspaces.w1.sessionIds, ['sess-1']);
});

test('newest session lands first and registration is idempotent', () => {
  process.env.DSH_HOME = dshHome;
  seedRegistry([{ id: 'w1', path: CWD, title: 'agent-bridge', sessionIds: ['sess-old'] }]);
  registerSessionInWorkspace(CWD, 'sess-new', () => {});
  registerSessionInWorkspace(CWD, 'sess-new', () => {}); // second sweep: no duplicate
  const doc = JSON.parse(readFileSync(join(dshHome, 'storages', 'workspace.json'), 'utf8'));
  assert.deepEqual(doc.tables.workspaces.w1.sessionIds, ['sess-new', 'sess-old']);
});

test('no matching workspace → skipped with a hint, registry untouched', () => {
  process.env.DSH_HOME = dshHome;
  seedRegistry([{ id: 'w1', path: '/elsewhere', title: 'x', sessionIds: [] }]);
  const before = readFileSync(join(dshHome, 'storages', 'workspace.json'), 'utf8');
  registerSessionInWorkspace(CWD, 'sess-1', (m) => logs.push(m));
  assert.equal(readFileSync(join(dshHome, 'storages', 'workspace.json'), 'utf8'), before);
  assert.ok(logs.join(' ').includes('no workspace matches cwd'), 'must explain the skip');
});

test('no workspace registry file at all → clean no-op', () => {
  process.env.DSH_HOME = dshHome;
  registerSessionInWorkspace(CWD, 'sess-1', (m) => logs.push(m));
  assert.ok(logs.join(' ').includes('no workspace registry'), 'must explain the no-op');
});
