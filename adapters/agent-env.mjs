// adapters/agent-env.mjs — where agent binaries live, for every spawn site.
//
// Philosophy (2026-10-06, user direction): agent-bridge is a GUEST on the
// user's agent environment — everything resolves USER-FIRST. The ACP shims
// (`claude-agent-acp`, `pi-acp`) ship as bundled optionalDependencies purely
// as a zero-config fallback; a shim the user installed themselves WINS,
// because the shim must track the user's CLI version (the pair they keep
// working in their terminal), and a shadowing bundled copy would be
// unfixable-by-user the moment the CLI outruns our release cadence. The
// agent CLIs proper (codex, claude, gemini, pi) are never bundled at all —
// same reason, stronger: stateful, versioned, auto-updating tools that a
// pinned copy would fork (`~/.codex`, `~/.claude`).
//
// Concretely: the bundled bin dirs are APPENDED to the child PATH — the
// system PATH wins, bundled fills the gaps. doctor.mjs resolves through the
// SAME augmented path so its "binary found" verdicts can never disagree with
// what a spawn would actually use.

import path from 'node:path';
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const pkgRoot = path.resolve(here, '..');

const PATH_KEY = process.platform === 'win32' ? 'Path' : 'PATH';

/** Bin dirs holding this package's bundled ACP shims, per install layout.
 *   repo checkout:              <repo>/node_modules/.bin (deps install there);
 *   npm install into a project: hoisted deps sit NEXT to this package, so
 *     their bins land in the HOST project's node_modules/.bin — resolve two
 *     levels up, not one ('..' only reaches the @xiaohuzai scope dir, which
 *     npm never puts a .bin in; found 2026-10-09 while diagnosing a dsh
 *     ENOENT on a from-source bridge);
 *   npm install -g:             neither candidate exists — npm links every
 *     top-level bin into <prefix>/bin, which is already on PATH.
 * Pure so tests can pin the per-layout shape; bundledBinDirs filters to dirs
 * that exist (a PATH entry that isn't there is inert, but there is no reason
 * to hand children dead directories). */
export function bundledBinDirCandidates(pkgRoot) {
  return [
    path.join(pkgRoot, 'node_modules', '.bin'),
    path.resolve(pkgRoot, '..', '..', '.bin'),
  ];
}

export function bundledBinDirs() {
  return bundledBinDirCandidates(pkgRoot).filter((d) => {
    try { return statSync(d).isDirectory(); } catch (_) { return false; }
  });
}

/** The PATH string a child should get: the system PATH first, the bundled
 * shim dirs appended after it (user-installed agents and shims win; bundled
 * copies only fill the gaps). Idempotent — never duplicates a dir. */
export function agentPath() {
  const cur = process.env.PATH || process.env.Path || '';
  const parts = cur.split(path.delimiter);
  const add = bundledBinDirs().filter((d) => !parts.includes(d));
  return add.length ? `${cur}${path.delimiter}${add.join(path.delimiter)}` : cur;
}

/** The spawn env for an agent child: the daemon's environment with the
 * bundled-shim PATH appended. `extra` rides OVER it (entry/registry env —
 * e.g. the claude entry's CLAUDE_CODE_ENTRYPOINT, or CODEX_HOME). */
export function agentSpawnEnv(extra = {}) {
  return { ...process.env, ...extra, [PATH_KEY]: agentPath() };
}
