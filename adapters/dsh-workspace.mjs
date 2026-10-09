// adapters/dsh-workspace.mjs — best-effort desktop-visibility registration for
// dsh sessions created by this bridge.
//
// WHY: dsh's desktop/Web UI renders the workspace registry
// (`~/.dsh/storages/workspace.json`), and sessions created through automation
// surfaces (this bridge's spawned ACP agent) are persisted into the shared
// `~/.dsh/sessions` store WITHOUT ever being registered there — the
// registration only happens in the web session-create flow. Result: the
// conversation works, is resumable, but is invisible in the desktop app's
// list. This module performs the missing registration by hand.
//
// On-disk contract (read from @deepseek-ai/dsh-workspace 0.2.0-rc.2's source —
// dsh-storage-domain + dsh-storage-json serialize the workspace domain, v2, as
// one 2-space JSON document):
//   { unit:   { name: 'workspace', version: 2 },
//     global: { initialized, workspaceIds: [ …render order… ],
//               archivedSessionIds, pinnedSessionIds, … },
//     tables: { workspaces: { '<uuid>': { path, title, sessionIds,
//                                         createdAt, updatedAt } } } }
// The desktop lists workspaces in `global.workspaceIds` order and filters each
// workspace's sessionIds by the session-header cwd equaling the workspace
// path; dsh canonicalizes every workspace path through fs.realpath before
// comparing. So this module: canonicalizes the entry cwd the same way, appends
// the session id into the matching workspace — and when NO workspace owns the
// cwd (2026-10-10: the bridge user's default, since a registry entry's cwd
// defaults to the serve process's directory and the desktop rarely has a
// workspace for it), creates the record itself: `randomUUID()` key, title =
// path basename, session id pre-listed, id PREPENDED to `global.workspaceIds`
// (mirroring dsh's own create, which prepends to the durable order). The
// 2026-10-09 "existing workspaces only" limit is thereby retired with
// evidence — the original refusal was "a hand-built record risks
// registry-state inconsistency"; the full record + order shape is now known.
//
// Deliberate limits:
// - **Domain-version gate** — anything but `unit: workspace/2` is left
//   untouched with a log line. A future dsh that bumps the version may change
//   shapes; writing blind would risk corrupting the desktop's registry, and
//   the session itself is never at stake.
// - **Best effort, idempotent** — any failure (missing file, bad JSON, race
//   with the desktop's own writes) is logged and skipped; writes go through a
//   temp-file rename so a torn write can never poison the registry, and the
//   next turn re-registers. The desktop only rewrites the file on its own
//   workspace mutations, so a concurrent lost-update window exists but is
//   narrow and self-heals on the next bridge turn.
// - The dsh session's stored header cwd equals the acp `session/new` cwd
//   (canonicalized by the adapter, see acp-stdio.mjs), which is exactly what
//   the workspace `path` match compares.

import { existsSync, readFileSync, writeFileSync, renameSync, realpathSync, statSync } from 'node:fs';
import { join, basename, parse } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

export function registerSessionInWorkspace(entryCwd, sessionId, log = () => {}) {
  try {
    const file = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'storages', 'workspace.json');
    if (!existsSync(file)) {
      log(`[dsh] no workspace registry at ${file} — session stays unlisted in the desktop UI`);
      return;
    }
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    if (doc?.unit?.name !== 'workspace' || doc?.unit?.version !== 2) {
      log(`[dsh] workspace registry is not the workspace/2 domain this bridge knows — skipping visibility registration`);
      return;
    }
    const workspaces = doc?.tables?.workspaces;
    if (!workspaces || typeof workspaces !== 'object') {
      log('[dsh] workspace registry has no workspaces table — skipping visibility registration');
      return;
    }
    // Canonical cwd: mirrors dsh's own realpathNormalize before any path
    // compare. Falls back to the raw spelling when the directory does not
    // exist locally (append-side match only; creation needs a real directory).
    let canonical = null;
    try {
      canonical = realpathSync(entryCwd);
      if (!statSync(canonical).isDirectory()) canonical = null;
    } catch { /* nonexistent — creation will report it */ }
    const matchPath = canonical ?? entryCwd;
    const target = Object.values(workspaces).find((w) => w && w.path === matchPath);
    if (target) {
      if (!Array.isArray(target.sessionIds)) target.sessionIds = [];
      if (target.sessionIds.includes(sessionId)) return; // already registered
      target.sessionIds.unshift(sessionId);
      writeRegistry(file, doc);
      log(`[dsh] session '${sessionId}' registered into workspace '${target.path}' (desktop session list)`);
      return;
    }
    // No workspace owns this directory: create the record exactly as dsh's
    // registry create does (uuid key, basename title, prepended render order),
    // with the session id already accounted. Creation needs a real directory —
    // a nonexistent entry cwd is a config mistake, report it as such.
    const global = doc?.global;
    if (!canonical) {
      log(`[dsh] no workspace matches cwd '${entryCwd}' and it is not an existing directory — session stays unlisted (fix the entry's cwd, or create a workspace for that directory in dsh)`);
      return;
    }
    if (!global || !Array.isArray(global.workspaceIds)) {
      log('[dsh] workspace registry has no global order table — session stays unlisted (create a workspace for that directory in dsh to see it)');
      return;
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    workspaces[id] = {
      path: canonical,
      title: basename(canonical) || parse(canonical).root,
      sessionIds: [sessionId],
      createdAt: now,
      updatedAt: now,
    };
    global.workspaceIds.unshift(id);
    writeRegistry(file, doc);
    log(`[dsh] no workspace matched cwd '${entryCwd}' — created workspace '${basename(canonical)}' and registered session '${sessionId}' (desktop session list)`);
  } catch (error) {
    log(`[dsh] workspace visibility registration skipped: ${error?.message ?? error}`);
  }
}

/** Serialize exactly like dsh-storage-json (2-space indent, trailing newline)
 * through a temp-file rename, so a crash mid-write can never leave the
 * desktop facing a torn registry. */
function writeRegistry(file, doc) {
  const tmp = `${file}.bridge-${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`);
  renameSync(tmp, file);
}
