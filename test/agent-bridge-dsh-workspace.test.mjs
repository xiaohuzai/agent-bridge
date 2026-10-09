// test/agent-bridge-dsh-workspace.test.mjs — the dsh desktop-visibility
// registration (adapters/dsh-workspace.mjs): append new session ids into the
// matching dsh workspace's sessionIds, and CREATE the workspace record when no
// workspace owns the entry cwd (mirroring dsh-workspace domain v2's on-disk
// shape). Pure fs + JSON — no chrome, no network.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { registerSessionInWorkspace } from '../adapters/dsh-workspace.mjs';

let dir;
let dshHome;
let cwd;          // the entry cwd under test — a real directory per test
const logs = [];

const registryFile = () => join(dshHome, 'storages', 'workspace.json');

function seedRegistry(doc) {
  writeFileSync(registryFile(), JSON.stringify(doc, null, 2));
}

function seedWithWorkspaces(workspaces, { version = 2, global: g } = {}) {
  seedRegistry({
    unit: { name: 'workspace', version },
    global: g ?? { initialized: true, workspaceIds: workspaces.map((w) => w.id), archivedSessionIds: [] },
    tables: { workspaces: Object.fromEntries(workspaces.map((w) => [w.id, w])) },
  });
}

const readDoc = () => JSON.parse(readFileSync(registryFile(), 'utf8'));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-ws-'));
  dshHome = join(dir, 'dsh-home');
  cwd = join(dir, 'proj');
  mkdirSync(join(dshHome, 'storages'), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(dshHome, 'sessions', '--Users-me-work-agent-bridge--'), { recursive: true });
  logs.length = 0;
});

afterEach(() => {
  delete process.env.DSH_HOME;
  rmSync(dir, { recursive: true, force: true });
});

test('registers a session into the workspace whose path matches the entry cwd', () => {
  process.env.DSH_HOME = dshHome;
  seedWithWorkspaces([{ id: 'w1', path: cwd, title: 'proj', sessionIds: [] }]);
  registerSessionInWorkspace(cwd, 'sess-1', (m) => logs.push(m));
  assert.deepEqual(readDoc().tables.workspaces.w1.sessionIds, ['sess-1']);
});

test('newest session lands first and registration is idempotent', () => {
  process.env.DSH_HOME = dshHome;
  seedWithWorkspaces([{ id: 'w1', path: cwd, title: 'proj', sessionIds: ['sess-old'] }]);
  registerSessionInWorkspace(cwd, 'sess-new', () => {});
  registerSessionInWorkspace(cwd, 'sess-new', () => {}); // second sweep: no duplicate
  assert.deepEqual(readDoc().tables.workspaces.w1.sessionIds, ['sess-new', 'sess-old']);
});

test('canonical matching: a symlinked entry cwd finds the realpath workspace', () => {
  process.env.DSH_HOME = dshHome;
  const link = join(dir, 'proj-link');
  symlinkSync(cwd, link);
  seedWithWorkspaces([{ id: 'w1', path: realpathSync(cwd), title: 'proj', sessionIds: [] }]);
  registerSessionInWorkspace(link, 'sess-1', (m) => logs.push(m));
  assert.deepEqual(readDoc().tables.workspaces.w1.sessionIds, ['sess-1']);
});

test('no matching workspace → the workspace record is CREATED (dsh-workspace v2 shape)', () => {
  process.env.DSH_HOME = dshHome;
  seedWithWorkspaces([{ id: 'w1', path: '/elsewhere', title: 'x', sessionIds: [] }]);
  registerSessionInWorkspace(cwd, 'sess-1', (m) => logs.push(m));
  const doc = readDoc();
  const createdId = doc.global.workspaceIds[0];
  assert.equal(doc.global.workspaceIds.length, 2, 'created id is PREPENDED to the render order');
  assert.equal(doc.global.workspaceIds[1], 'w1', 'existing workspace keeps its relative order');
  const rec = doc.tables.workspaces[createdId];
  assert.equal(rec.path, realpathSync(cwd));
  assert.equal(rec.title, 'proj');
  assert.deepEqual(rec.sessionIds, ['sess-1']);
  assert.match(rec.createdAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(logs.join(' '), /created workspace 'proj'/, 'must log the create');
});

test('auto-created workspace absorbs the next session; same session never duplicates', () => {
  process.env.DSH_HOME = dshHome;
  seedWithWorkspaces([]);
  registerSessionInWorkspace(cwd, 'sess-1', () => {});
  registerSessionInWorkspace(cwd, 'sess-2', () => {});
  registerSessionInWorkspace(cwd, 'sess-2', () => {});
  const doc = readDoc();
  assert.equal(Object.keys(doc.tables.workspaces).length, 1, 'one workspace, not one per turn');
  assert.deepEqual(Object.values(doc.tables.workspaces)[0].sessionIds, ['sess-2', 'sess-1']);
});

test('non-workspace/2 registry (future dsh) → untouched, hint logged', () => {
  process.env.DSH_HOME = dshHome;
  seedWithWorkspaces([{ id: 'w1', path: '/elsewhere', title: 'x', sessionIds: [] }], { version: 3 });
  const before = readFileSync(registryFile(), 'utf8');
  registerSessionInWorkspace(cwd, 'sess-1', (m) => logs.push(m));
  assert.equal(readFileSync(registryFile(), 'utf8'), before);
  assert.ok(logs.join(' ').includes('workspace/2'), 'must explain the skip');
});

test('missing global order table → no create, hint logged', () => {
  process.env.DSH_HOME = dshHome;
  seedWithWorkspaces([], { global: { initialized: true } });
  const before = readFileSync(registryFile(), 'utf8');
  registerSessionInWorkspace(cwd, 'sess-1', (m) => logs.push(m));
  assert.equal(readFileSync(registryFile(), 'utf8'), before);
  assert.ok(logs.join(' ').includes('no global order table'), 'must explain the skip');
});

test('nonexistent entry cwd → no create, config-mistake hint', () => {
  process.env.DSH_HOME = dshHome;
  seedWithWorkspaces([]);
  registerSessionInWorkspace(join(dir, 'nope'), 'sess-1', (m) => logs.push(m));
  assert.equal(Object.keys(readDoc().tables.workspaces).length, 0);
  assert.ok(logs.join(' ').includes('not an existing directory'), 'must point at the cwd');
});

test('no workspace registry file at all → clean no-op', () => {
  process.env.DSH_HOME = dshHome;
  registerSessionInWorkspace(cwd, 'sess-1', (m) => logs.push(m));
  assert.ok(logs.join(' ').includes('no workspace registry'), 'must explain the no-op');
});
