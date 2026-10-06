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

/** Bin dirs holding this package's bundled ACP shims, filtered to those that
 * exist. Two layouts to cover:
 *   npm install (global or local):  <…>/node_modules/@xiaohuzai/agent-bridge
 *     → the deps' .bin is the package tree's own node_modules/.bin;
 *   repo checkout: deps install into the repo root's node_modules/.bin.
 * Nonexistent candidates drop out — a PATH entry that isn't there is inert,
 * but there is no reason to hand children dead directories. */
export function bundledBinDirs() {
  const candidates = [
    path.join(pkgRoot, 'node_modules', '.bin'),
    path.resolve(pkgRoot, '..', '.bin'),
  ];
  return candidates.filter((d) => {
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
