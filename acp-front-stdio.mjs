// agent-bridge/acp-front-stdio.mjs — ACP v1 over STDIO: the bridge itself as
// a spawnable ACP agent (`agent-bridge acp --name <entry>`). This is the
// door for spawn-style clients — editors like Zed (which only launches local
// agent commands), vscode-acp, etc. — and it is what qualifies agent-bridge
// for the ACP Registry, which lists agents (spawnable commands), not clients.
//
// The protocol session is shared verbatim with the WebSocket front
// (acp-front.mjs); this file is only the stdio plumbing:
//   - stdin: one JSON-RPC message per line → session.handleMessage
//   - stdout: one JSON-RPC message per line — the ONLY thing allowed on
//     stdout; every log (human-facing) goes to stderr, same convention as
//     the fake test agents
//   - stdin end / SIGINT / SIGTERM: tear down (interrupt in-flight turns),
//     stop the adapter, exit 0

import { createAcpFrontSession } from './acp-front.mjs';

export function runAcpStdio({ adapter, agent, version = '0.0.0', log = () => {}, input = process.stdin, output = process.stdout }) {
  let exiting = false;
  const real = input === process.stdin && output === process.stdout;
  const shutdown = (why, code = 0) => {
    if (exiting) return;
    exiting = true;
    const hadBusyTurns = session.hasBusyTurns();
    session.destroy();
    const finish = () => {
      try { adapter.stop(); } catch (_) {}
      try { output.end(); } catch (_) {}
      log(`[acp-front] stdio front stopped (${why})`);
      if (real) setTimeout(() => process.exit(code), 50).unref();
    };
    if (hadBusyTurns) {
      // A turn was in flight: session.destroy() fired interrupt(session/cancel)
      // — give it a bounded grace window to reach the agent (and the agent's
      // stderr logs to flush through our pipes) before SIGKILLing the child.
      // Bounded so a wedged shim can never hold the exit hostage.
      setTimeout(finish, 800);
    } else {
      finish();
    }
  };

  // stdout is the protocol channel — an EPIPE (editor closed our pipe)
  // must not become an uncaughtException.
  output.on?.('error', () => {});

  log(`[acp-front] agent-bridge acp: serving "${agent}" as an ACP v1 agent on stdio (protocol only on stdout, logs on stderr)`);

  const session = createAcpFrontSession({
    adapter,
    agent,
    version,
    log,
    wire: {
      send: (obj) => { output.write(JSON.stringify(obj) + '\n'); },
      close: () => shutdown('transport closed'),
    },
    onClosed: () => {},
  });

  let buf = '';
  input.setEncoding?.('utf8');
  input.on('data', (d) => {
    buf += d;
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) session.handleMessage(line);
    }
  });
  input.on('end', () => shutdown('stdin ended'));
  input.on('error', () => shutdown('stdin error'));

  // Signal handling only in the real process (tests drive streams directly
  // and must not install handlers on the test runner).
  if (real) {
    for (const sig of ['SIGINT', 'SIGTERM']) {
      process.on(sig, () => shutdown(sig));
    }
  }

  return { stop: () => shutdown('stop()') };
}
