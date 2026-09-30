// agent-bridge/adapters/claude-transcript-fix.mjs — keep bridge-driven claude
// sessions BROWSABLE in claude's interactive /resume picker.
//
// claude CLI 2.x self-stamps every SDK-driven transcript with
// entrypoint:"sdk-cli" (it ignores the CLAUDE_CODE_ENTRYPOINT env — live
// 2026-10-01 — see acp-stdio.mjs), and the picker hides transcripts whose
// entrypoint is sdk-cli/sdk-ts/sdk-py. The bridge knows the sessionId, and
// claude stores transcripts as ~/.claude/projects/<project>/<sessionId>.jsonl
// — so after each settled turn we flip the stamp to "cli" in place. Purely
// local JSON-string surgery on claude's own files; if the layout or field
// ever changes this no-ops (logged once) and the worst case is the old one:
// the session stays hidden in the picker but still resumable by id.
//
// Race note: the rewrite runs right after a turn settles, when the CLI is
// idle (it appends only during turns). A turn starting in the microseconds
// between our read and rename could lose its first lines — practically
// unreachable (a next turn needs a client round trip), accepted as hack
// cost. Sessions are rewritten after EVERY turn: later turns re-stamp
// sdk-cli on their lines, so the file is fixed incrementally.

import { readdir, readFile, writeFile, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

// claude writes minified JSON; tolerate whitespace anyway. The stamp variant
// drifts between sdk-cli and sdk-ts run to run — all are in the picker's
// hide-list, all are rewritten.
const STAMP = /"entrypoint"\s*:\s*"sdk-(?:cli|ts|py)"/g;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function rewriteClaudeEntrypoint({
  sessionId,
  projectsDir = join(homedir(), '.claude', 'projects'),
  log = () => {},
} = {}) {
  if (!sessionId) return false;
  // claude persists transcripts lazily — the file can appear a second or so
  // AFTER the turn settles (observed live). Retry a few times before giving
  // up; if the projects dir doesn't exist at all there is nothing to wait for.
  try {
    await stat(projectsDir);
  } catch {
    return false;
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt) await sleep(700);
    try {
      for (const dir of await readdir(projectsDir, { withFileTypes: true })) {
        if (!dir.isDirectory() && !dir.isSymbolicLink()) continue;
        const file = join(projectsDir, dir.name, `${sessionId}.jsonl`);
        let text;
        try {
          text = await readFile(file, 'utf8');
        } catch {
          continue; // not in this project dir (or vanished) — keep scanning
        }
        STAMP.lastIndex = 0;
        if (!STAMP.test(text)) return false; // found but already clean
        const fixed = text.replace(STAMP, '"entrypoint":"cli"');
        const tmp = `${file}.agent-bridge-tmp`;
        await writeFile(tmp, fixed);
        await rename(tmp, file);
        log(`[claude-resume] entrypoint rewritten to "cli" (${sessionId}) so the session lists in claude --resume`);
        return true;
      }
    } catch (e) {
      log(`[claude-resume] rewrite skipped: ${String(e.message || e).slice(0, 120)}`);
      return false;
    }
  }
  log(`[claude-resume] no transcript found for ${sessionId} under ${projectsDir} after retries (layout changed? skipping)`);
  return false;
}
