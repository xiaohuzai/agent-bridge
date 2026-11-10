// agent-bridge/jsonl-lines.mjs — split a stdio byte/string stream into
// newline-terminated lines, once, for every JSONL protocol here.
//
// The four call sites (codex app-server, ACP stdio, the ACP stdio front, the
// headless CLI) each used to carry the same five-line buffer loop. The edge
// cases are the reason this is a module: a line split across chunks, several
// frames in one chunk, and — when the caller has not called setEncoding —
// a multibyte UTF-8 character split across two Buffer chunks. String(chunk)
// would corrupt that last one, so Buffers go through a stateful decoder.
//
// A trailing CR is stripped (CRLF input). An unterminated tail is held until
// its newline arrives; flush() exists for the one caller that treats a final
// unterminated line as a frame at child exit (the headless CLI).

import { StringDecoder } from 'node:string_decoder';

export function createLineSplitter(onLine) {
  const decoder = new StringDecoder('utf8');
  let buf = '';
  return {
    push(chunk) {
      buf += typeof chunk === 'string' ? chunk : decoder.write(chunk);
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        let line = buf.slice(0, idx);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        buf = buf.slice(idx + 1);
        onLine(line);
      }
    },
    /** Deliver a final unterminated line (whitespace-only tails are dropped). */
    flush() {
      const tail = buf;
      buf = '';
      if (tail.trim()) onLine(tail);
    },
  };
}
