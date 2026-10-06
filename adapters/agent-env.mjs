// adapters/agent-env.mjs — where agent CLIs live, for every spawn site.
//
// agent-bridge ships its agents as bundled optionalDependencies
// (`@openai/codex`, the claude/gemini ACP shims and CLIs, `pi-acp`) so ONE
// `npm i -g @xiaohuzai/agent-bridge` leaves nothing else to remember. Their
// bins land in a node_modules/.bin that is NOT on PATH for local/checkout
// installs (global installs also get npm's own bin links). Every adapter
// spawn therefore gets a PATH with those directories PREPENDED: the bundled
// binary wins over a system one (the codex adapter's protocol facts are
// verified against its exact pin — a random PATH codex may be newer than
// what the adapter was verified against), and a system install still works
// whenever the bundled dep was skipped (`--omit=optional`).
//
// doctor.mjs resolves through the SAME augmented path so its "binary found"
// verdicts can never disagree with what a spawn would actually use.

import path from 'node:path';
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const pkgRoot = path.resolve(here, '..');

const PATH_KEY = process.platform === 'win32' ? 'Path' : 'PATH';

/** Bin dirs that hold this package's bundled agent CLIs, filtered to those
 * that exist. Two layouts to cover:
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

/** The PATH string a child should get: bundled bin dirs first, system PATH
 * after. Idempotent — never duplicates a dir that is already on PATH. */
export function agentPath() {
  const cur = process.env.PATH || process.env.Path || '';
  const parts = cur.split(path.delimiter);
  const add = bundledBinDirs().filter((d) => !parts.includes(d));
  return add.length ? `${add.join(path.delimiter)}${path.delimiter}${cur}` : cur;
}

/** The spawn env for an agent child: the daemon's environment with the
 * bundled-bin PATH. `extra` rides OVER it (entry/registry env — e.g. the
 * claude entry's CLAUDE_CODE_ENTRYPOINT, or CODEX_HOME). */
export function agentSpawnEnv(extra = {}) {
  return { ...process.env, ...extra, [PATH_KEY]: agentPath() };
}
