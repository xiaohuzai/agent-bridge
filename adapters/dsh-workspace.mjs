// adapters/dsh-workspace.mjs — best-effort desktop-visibility registration for
// dsh sessions created by this bridge.
//
// WHY: dsh's desktop/Web UI renders the workspace registry
// (`~/.dsh/storages/workspace.json`, each workspace's `sessionIds` array), and
// sessions created through automation surfaces (this bridge's spawned ACP
// agent) are persisted into the shared `~/.dsh/sessions` store WITHOUT ever
// being registered there — the registration only happens in the web
// session-create flow. Result: the conversation works, is resumable, but is
// invisible in the desktop app's list. This module performs the missing
// registration by hand: read the registry, find the workspace whose `path`
// equals the entry's cwd, prepend the session id, write back. Verified live
// 2026-10-09 (the same edit, done by hand, made sessions render).
//
// Deliberate limits:
// - **Existing workspaces only** — if no workspace's path matches the cwd,
//   nothing is created (a hand-built workspace record risks registry-state
//   inconsistency; the desktop UI is the tool for creating workspaces). The
//   caller logs a hint instead.
// - **Best effort, idempotent** — any failure (missing file, bad JSON, race
//   with the desktop's own writes) is logged and skipped; the session itself
//   is untouched and the next turn re-registers. The desktop only rewrites
//   the file on its own workspace mutations, so a concurrent-loss window
//   exists but is narrow and self-heals on the next bridge turn.
// - The dsh session's stored header cwd equals the acp `session/new` cwd
//   (this bridge's entry cwd), which is exactly what the workspace `path`
//   match compares.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function registerSessionInWorkspace(entryCwd, sessionId, log = () => {}) {
  try {
    const file = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'storages', 'workspace.json');
    if (!existsSync(file)) {
      log(`[dsh] no workspace registry at ${file} — session stays unlisted in the desktop UI`);
      return;
    }
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    const workspaces = doc?.tables?.workspaces;
    if (!workspaces || typeof workspaces !== 'object') {
      log('[dsh] workspace registry has no workspaces table — skipping visibility registration');
      return;
    }
    const target = Object.values(workspaces).find((w) => w && w.path === entryCwd);
    if (!target) {
      log(`[dsh] no workspace matches cwd '${entryCwd}' — session stays unlisted in the desktop UI (create a workspace for that directory in dsh to see it)`);
      return;
    }
    if (!Array.isArray(target.sessionIds)) target.sessionIds = [];
    if (target.sessionIds.includes(sessionId)) return; // already registered
    target.sessionIds.unshift(sessionId);
    writeFileSync(file, JSON.stringify(doc, null, 2));
    log(`[dsh] session '${sessionId}' registered into workspace '${target.path}' (desktop session list)`);
  } catch (error) {
    log(`[dsh] workspace visibility registration skipped: ${error?.message ?? error}`);
  }
}
