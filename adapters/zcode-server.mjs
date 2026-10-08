// agent-bridge/adapters/zcode-server.mjs — ZCode adapter.
//
// Speaks the ZCode server's binary RPC on stdio — the same interface the
// ZCode desktop app drives over stdio pipes and the open-source repo's
// `zcode --web` exposes over /ws. All wire facts below were verified live
// against the official server 3.14.4 (2026-10-08: a full real conversation —
// handshake, createSession, streamed model deltas, stop, usage) — do not
// "simplify" them:
//
//   Transport: the child's stdout carries ONE hello JSON line first
//     {"type":"zcode-hello","version":…,…}; the client must write a
//     hello-ack JSON line {"type":"zcode-hello-ack","version":…,"clientId":…}
//     BEFORE any binary frame (the ack parser reads to the first newline —
//     frames sent first corrupt it). After the ack, stdout is a raw frame
//     stream: [type u8=1][id u32][ack u32][len u32] + payload. Clients only
//     send type=1 with id/ack 0 (the reference SocketProtocol does exactly
//     that; other types never appear on this path).
//   Payload: serialize(header)+serialize(body) back to back. Value tags:
//     Undefined=0, String=1 (VQL len + utf8), Buffer=2, VSBuffer=3,
//     Array=4 (VQL count + items), Object=5 (VQL len + JSON — booleans,
//     null, floats and plain objects all ride this), Int=6 (VQL varint,
//     7-bit little-endian groups, high bit = continuation).
//   Channel: requests [100,id,channel,method]+argsArray, event subscribes
//     [102,id,channel,event]+arg; server replies [200] Initialize (pushed
//     right after attach), [201,id] result, [202,id] error, [204,listenId]
//     event payload. Channel name: "zcode-agent".
//   v4 handshake: helloConversationV4() → HelloMessage{protocolVersion,
//     connectionId, capabilities,…}, then initializeConversationV4
//     (clientHello). protocolVersion must ECHO the hello's value; the
//     workflowRunDeltas capability key may only be sent when hello's
//     capabilities carried it (old hosts run strict schemas — an unknown
//     key fails the WHOLE handshake). Every later command envelope must
//     carry the same clientId (fault.command.clientMismatch otherwise).
//   Sessions: createSession is a COMMAND, not a method —
//     sendConversationCommandV4({workspacePath, envelope:{commandId,
//     clientId, sessionId:null, type:'createSession', payload:{workspaceId,
//     firstInput:{text, attachments?}}}}) → ack.result.sessionId (`sess_…`,
//     server-assigned). Later turns sendText in the same session. Frames
//     flow via the onDynamicConversationFrame({workspacePath}) event:
//     wire envelope {kind:'complete'|'fragment' (base64 slices reassembled
//     by logicalFrameId)} wrapping {topic:'conversation/<sid>', payload:
//     {kind:'snapshot'|'deltas'}}; row ops row.appended/row.upserted/
//     row.delta{text,append} and state.updated{patch}. A turnHeader row
//     reaching completedSuccess/completedInterrupted/failed ends the turn.
//   Approvals: permission requests surface as pendingInteractions in
//     snapshot/state.updated patches (kind:'permission', payload.options
//     kinds allowOnce/allowAlways/deny); the answer is the resolveInteraction
//     COMMAND on the same connection — there is no stateless HTTP relay.
//     AskUserQuestion-style prompts are NOT wired: the handshake declares
//     askUserQuestionAutoResolutionEnabled, so the host auto-resolves them
//     instead of blocking the turn (the codex adapter likewise refuses them).
//   Abort: the `stop` command — closing the connection does NOT stop the
//     server-side agent.
//   Images: the v4 attachment face — attachmentBeginV4 (uploadId +
//     sha256:<hex> + total bytes/chunks) → attachmentChunkV4 (≤512KiB
//     base64, slices cut on 3-byte boundaries so each decodes standalone)
//     → attachmentCommitV4 → {ref}; the ref rides the sendText payload
//     attachments as {ref, fileName, mime, bytes} (strict schema). Limits:
//     20MiB per attachment. connectionId comes from the hello. Images need a
//     sessionId BEFORE the text can ride (strict schema, refs in the payload)
//     → new image turns create a draft session first, upload, then sendText.
//
// Child lifecycle follows the codex adapter: one long-lived server process
// per bridge (the cold start — CLI agent spawn — is paid once at first
// turn), respawn on demand after a crash; sessions survive via the server's
// own persistence (sess_ ids resume with a plain subscribe + sendText).
// Runtime files are NOT bundled: the adapter reuses whatever the user's
// ZCode desktop app installed (macOS content-addressed cache under
// ~/Library/Application Support/ZCode, Linux desktop layout under
// ~/.zcode/server); explicit config overrides win.

import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { agentSpawnEnv } from './agent-env.mjs';

const INIT_TIMEOUT_MS = 30_000;     // server boot + services init (measured 1.5–4s)
const RPC_TIMEOUT_MS = 30_000;
const TURN_ACK_TIMEOUT_MS = 90_000; // first createSession spawns the CLI agent inside (measured up to ~15s)
const STOP_TIMEOUT_MS = 5_000;
const ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;
const CHUNK_BYTES = 524286;         // 512KiB rounded down to a multiple of 3 — base64 slices decode standalone

// turnHeader terminal states (rows.ts). completedInterrupted ends the turn
// cleanly here: the interrupt path settles it as `aborted`.
const TERMINAL_TURN_STATES = new Set(['completedSuccess', 'completedInterrupted', 'failed']);

// ─── value serialization (verified byte-for-byte against the real server) ───

function writeVQL(bytes, value) {
  if (value === 0) { bytes.push(0); return; }
  let v = value >>> 0;
  while (v !== 0) {
    let b = v & 0x7f;
    v = v >>> 7;
    if (v > 0) b |= 0x80;
    bytes.push(b);
  }
}

function serializeValue(data, out) {
  if (data === undefined) { out.push(0); }
  else if (typeof data === 'string') {
    const b = Buffer.from(data, 'utf8');
    out.push(1); writeVQL(out, b.byteLength); for (const x of b) out.push(x);
  } else if (data instanceof Uint8Array) {
    out.push(2); writeVQL(out, data.byteLength); for (const x of data) out.push(x);
  } else if (Array.isArray(data)) {
    out.push(4); writeVQL(out, data.length);
    for (const el of data) serializeValue(el, out);
  } else if (typeof data === 'number' && (data | 0) === data) {
    out.push(6); writeVQL(out, data);
  } else {
    const b = Buffer.from(JSON.stringify(data), 'utf8');
    out.push(5); writeVQL(out, b.byteLength); for (const x of b) out.push(x);
  }
}

function serialize(data) {
  const out = [];
  serializeValue(data, out);
  return Uint8Array.from(out);
}

class Reader {
  constructor(buf) { this.buf = buf; this.pos = 0; }
  read(n) { const s = this.buf.subarray(this.pos, this.pos + n); this.pos += n; return s; }
  vql() {
    let v = 0, n = 0;
    for (;;) {
      const b = this.read(1)[0];
      v |= (b & 0x7f) << n;
      if (!(b & 0x80)) return v;
      n += 7;
    }
  }
}

function deserializeValue(r) {
  const t = r.read(1)[0];
  switch (t) {
    case 0: return undefined;
    case 1: return r.read(r.vql()).toString('utf8');
    case 2: case 3: return r.read(r.vql());
    case 4: {
      const n = r.vql();
      const a = [];
      for (let i = 0; i < n; i++) a.push(deserializeValue(r));
      return a;
    }
    case 5: return JSON.parse(r.read(r.vql()).toString('utf8'));
    case 6: return r.vql();
    default: throw new Error(`zcode rpc: bad value tag ${t}`);
  }
}

function deserialize(buf) {
  const r = new Reader(buf);
  const header = deserializeValue(r);
  const body = r.pos < buf.length ? deserializeValue(r) : undefined;
  return [header, body];
}

function encodeFrame(payload) {
  const out = Buffer.allocUnsafe(13 + payload.length);
  out[0] = 1;                    // Regular
  out.writeUInt32BE(0, 1);       // id
  out.writeUInt32BE(0, 5);       // ack
  out.writeUInt32BE(payload.length, 9);
  out.set(payload, 13);
  return out;
}

/** Frame reassembly: stdin chunks feed in; complete Regular frames come out
 * (one frame may span chunks; several frames may share one chunk). */
function createFrameAssembler(onFrame) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    let pos = 0;
    for (;;) {
      const avail = buf.length - pos;
      if (avail < 13) break;
      const type = buf[pos];
      const len = buf.readUInt32BE(pos + 9);
      if (avail < 13 + len) break;
      const payload = buf.subarray(pos + 13, pos + 13 + len);
      pos += 13 + len;
      if (type === 1) {
        try { onFrame(deserialize(payload)); } catch (_) { /* malformed frame: skip */ }
      }
    }
    buf = buf.subarray(pos);
  };
}

// wire frames: kind 'fragment' reassembles base64 slices per logicalFrameId.
function assembleWireFrame(wire, fragBuf) {
  if (wire.kind !== 'fragment') return wire;
  const acc = fragBuf.get(wire.logicalFrameId) || { parts: new Map() };
  acc.parts.set(wire.fragmentIndex, Buffer.from(wire.dataBase64, 'base64'));
  if (acc.parts.size < wire.fragmentCount) { fragBuf.set(wire.logicalFrameId, acc); return null; }
  fragBuf.delete(wire.logicalFrameId);
  const whole = Buffer.concat([...acc.parts.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]));
  return JSON.parse(whole.toString('utf8'));
}

// ─── runtime-file discovery (the adapter reuses the desktop install) ─────────

/** Newest content-addressed server bundle from the macOS desktop cache. */
function newestMacServerBundle(home = homedir()) {
  const root = join(home, 'Library', 'Application Support', 'ZCode', 'remote-assets-cache', 'components', 'server-bundle');
  let best = null;
  try {
    for (const name of readdirSync(root)) {
      const p = join(root, name, 'zcode-server.cjs');
      try {
        const st = statSync(p);
        if (st.isFile() && (!best || st.mtimeMs > best.mtimeMs)) best = { path: p, mtimeMs: st.mtimeMs };
      } catch (_) { /* hash dir without the file */ }
    }
  } catch (_) { /* no cache dir */ }
  return best?.path || null;
}

export function resolveServerCjs({ serverCjs, home = homedir() } = {}) {
  if (serverCjs && existsSync(serverCjs)) return serverCjs;
  const fromEnv = process.env.ZCODE_SERVER_CJS;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const mac = newestMacServerBundle(home);
  if (mac) return mac;
  const linux = join(home, '.zcode', 'server', 'zcode-server.cjs');
  if (existsSync(linux)) return linux;
  throw new Error(
    'zcode-server.cjs not found — install (and once open) the ZCode desktop app, '
    + 'or point the bridge entry at it with "serverCjs": "/abs/path/zcode-server.cjs". '
    + `Searched: macOS desktop cache, env ZCODE_SERVER_CJS, ${linux}`,
  );
}

function resolveNodeBin({ nodeBin, home = homedir() } = {}) {
  if (nodeBin && existsSync(nodeBin)) return nodeBin;
  const bundled = join(home, '.zcode', 'server', 'node');
  if (existsSync(bundled)) return bundled;
  return process.execPath; // the node running agent-bridge (the server needs a modern Node)
}

/** Resolve the zcode AGENT CLI the server child must spawn — exported for
 * doctor. The official server's own resolution chain (env → monorepo →
 * Electron runtime → native binary in ~/.zcode/server/agents) comes up empty
 * on a desktop-only Mac install, and the server then refuses every turn with
 * "ZCode agent server command is not configured. Set
 * ZCODE_AGENT_SERVER_COMMAND before integration." (fault observed live via
 * browsa 2026-10-08). We therefore hand the server its agent explicitly.
 * Candidates: explicit config > the deployed wrapper next to the server
 * bundle (Linux desktop layout) > the macOS app bundle's zcode.cjs.
 * Returns the env patch to merge into the child's environment. */
export function resolveAgentCommandEnv({ serverCjs, agentCommand, home = homedir() } = {}) {
  const explicit = agentCommand;
  if (explicit) {
    // A .cjs needs a node interpreter in front; anything else is an
    // executable wrapper the server can spawn directly (args default to
    // app-server --stdio server-side).
    if (explicit.endsWith('.cjs')) {
      return {
        ZCODE_AGENT_SERVER_COMMAND: process.execPath,
        ZCODE_AGENT_SERVER_ARGS_JSON: JSON.stringify([explicit, 'app-server', '--stdio']),
      };
    }
    return { ZCODE_AGENT_SERVER_COMMAND: explicit };
  }
  const dir = serverCjs ? dirname(serverCjs) : null;
  const appRoot = '/Applications/ZCode.app/Contents';
  const appGlm = join(appRoot, 'Resources', 'glm');
  const appCjs = join(appGlm, 'zcode.cjs');
  const candidates = [
    ...(dir ? [join(dir, 'agents', 'glm', 'zcode-agent'), join(dir, 'zcode-agent')] : []),
    join(home, '.zcode', 'server', 'agents', 'glm', 'zcode-agent'),
  ];
  for (const c of candidates) {
    if (!existsSync(c)) continue;
    return { ZCODE_AGENT_SERVER_COMMAND: c };
  }
  // macOS desktop-only installs: run the app-bundled zcode.cjs on the app's
  // OWN Electron runtime in ELECTRON_RUN_AS_NODE mode — exactly what the
  // desktop does (its CLI needs Node ≥22.5 for node:sqlite; the node running
  // agent-bridge may be older, and the CLI then dies at boot with "ZCode
  // agent transport closed"). ELECTRON_RUN_AS_NODE is inert for the plain
  // node server process; the CLI spawn inherits it and Electron runs as pure
  // node (Electron 41 ≈ Node 24).
  if (existsSync(appCjs)) {
    const electronBin = findElectronBinary(appRoot);
    if (electronBin) {
      return {
        ZCODE_AGENT_SERVER_COMMAND: electronBin,
        ZCODE_AGENT_SERVER_ARGS_JSON: JSON.stringify([appCjs, 'app-server', '--stdio']),
        ELECTRON_RUN_AS_NODE: '1',
      };
    }
    // no Electron binary where expected — last resort, the bridge's own node
    return {
      ZCODE_AGENT_SERVER_COMMAND: process.execPath,
      ZCODE_AGENT_SERVER_ARGS_JSON: JSON.stringify([appCjs, 'app-server', '--stdio']),
    };
  }
  return {};
}

/** The Electron binary inside an app bundle: Contents/MacOS/<app name>
 * (case-insensitive), else the first file in Contents/MacOS. */
function findElectronBinary(appRoot) {
  try {
    const macosDir = join(appRoot, 'MacOS');
    const appName = basename(appRoot).replace(/\.app$/i, '');
    const entries = readdirSync(macosDir).filter((name) => {
      try { return statSync(join(macosDir, name)).isFile(); } catch (_) { return false; }
    });
    return entries.find((name) => name.toLowerCase() === appName.toLowerCase())
      || entries[0]
      ? join(macosDir, entries.find((name) => name.toLowerCase() === appName.toLowerCase()) || entries[0])
      : null;
  } catch (_) {
    return null;
  }
}

function parseDataUrl(dataUrl) {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(String(dataUrl || ''));
  if (!m) return null;
  return { mime: m[1], b64: m[2] };
}

/** Split a base64 string into standalone-decodable chunk slices
 * (boundaries on complete 4-char groups; the last slice carries padding). */
export function splitBase64ForChunks(b64, chunkBytes = CHUNK_BYTES) {
  const groupChars = Math.floor(chunkBytes / 3) * 4;
  const out = [];
  for (let i = 0; i < b64.length; i += groupChars) out.push(b64.slice(i, i + groupChars));
  return out;
}

// ─── turn projection: v4 rows → bridge events ────────────────────────────────

function createTurnProjector({ onDelta, onTool, onApproval, onTurnEnd }) {
  const rowKinds = new Map();     // rowId → kind
  const rowTexts = new Map();     // rowId → text (assistantText / reasoning)
  const textRowOrder = [];
  const toolStates = new Map();   // rowId → last status
  let emittingKind = null;
  let ended = false;
  let failed = false;
  let usage = null;

  const openThinking = () => { if (emittingKind !== 'reasoning') { if (emittingKind) onDelta('\n</thinking>\n'); onDelta('<thinking>\n'); emittingKind = 'reasoning'; } };
  const openText = () => { if (emittingKind !== 'assistantText') { if (emittingKind) onDelta('\n</thinking>\n'); emittingKind = 'assistantText'; } };
  // only a thinking block owns a closer — plain text ends without a tag
  const closeEmit = () => { if (emittingKind === 'reasoning') onDelta('\n</thinking>\n'); emittingKind = null; };

  const applyRow = (row) => {
    if (!row || typeof row.rowId !== 'number') return;
    if (row.kind === 'turnHeader') {
      if (row.state && TERMINAL_TURN_STATES.has(row.state)) {
        ended = true;
        failed = row.state === 'failed';
        closeEmit();
        onTurnEnd({ failed, state: row.state });
      }
      return;
    }
    if (row.kind === 'assistantText' || row.kind === 'reasoning') {
      const isNew = !rowKinds.has(row.rowId);
      rowKinds.set(row.rowId, row.kind);
      if (isNew && row.kind === 'assistantText') textRowOrder.push(row.rowId);
      const prev = rowTexts.get(row.rowId) || '';
      const text = typeof row.text === 'string' ? row.text : prev;
      if (text.length > prev.length) {
        rowTexts.set(row.rowId, text);
        const append = text.slice(prev.length);
        if (row.kind === 'reasoning') { openThinking(); onDelta(append); }
        else { openText(); onDelta(append); }
      } else {
        rowTexts.set(row.rowId, text);
      }
      return;
    }
    if (row.kind === 'toolCall') {
      const prev = toolStates.get(row.rowId);
      rowKinds.set(row.rowId, 'toolCall');
      toolStates.set(row.rowId, row.status);
      if (!row.toolName || row.status === 'pendingApproval') return;
      if (!prev) {
        onTool({ name: row.toolName, status: 'started', detail: row.inputText || '', id: String(row.rowId) });
      } else if (row.status !== prev && (row.status === 'success' || row.status === 'error' || row.status === 'cancelled')) {
        onTool({ name: row.toolName, status: 'completed', detail: row.inputText || '', id: String(row.rowId) });
      }
    }
  };

  const applyDelta = (d) => {
    if (!d || typeof d.op !== 'string') return;
    if (d.op === 'row.appended' || d.op === 'row.upserted') { applyRow(d.row); return; }
    if (d.op !== 'row.delta') return;
    const kind = rowKinds.get(d.rowId);
    if ((d.path === 'text' || kind === 'assistantText' || kind === 'reasoning') && typeof d.append === 'string' && d.append) {
      const prev = rowTexts.get(d.rowId) || '';
      rowTexts.set(d.rowId, prev + d.append);
      if (kind === 'reasoning') { openThinking(); onDelta(d.append); }
      else if (kind === 'assistantText') { openText(); onDelta(d.append); }
    }
  };

  const applyOps = (deltas) => {
    for (const d of deltas || []) {
      if (d?.op === 'state.updated') handlePatch(d.patch);
      else applyDelta(d);
    }
  };

  const handlePatch = (patch) => {
    if (!patch) return;
    if (Array.isArray(patch.pendingInteractions)) {
      for (const it of patch.pendingInteractions) {
        if (!it?.interactionId) continue;
        if (it.kind !== 'permission') continue; // userInput: auto-resolved (see header)
        const p = it.payload || {};
        const optionIds = {};
        for (const o of p.options || []) {
          if (o?.kind === 'allowOnce') optionIds.once = o.optionId;
          else if (o?.kind === 'allowAlways') optionIds.always = o.optionId;
          else if (o?.kind === 'deny') optionIds.deny = o.optionId;
        }
        onApproval({ requestId: it.interactionId, tool: p.toolName || 'tool', command: p.summary || '', optionIds });
      }
    }
    if (patch.usage) usage = patch.usage;
  };

  return {
    applyRow,
    applyOps,
    handlePatch,
    snapshot(snapshot) {
      if (!snapshot) return;
      for (const row of snapshot.rows?.window || []) applyRow(row);
      handlePatch({ pendingInteractions: snapshot.pendingInteractions, usage: snapshot.usage });
    },
    finish() { closeEmit(); },
    fullText() { return textRowOrder.map((id) => rowTexts.get(id) || '').filter(Boolean).join('\n\n'); },
    get ended() { return ended; },
    get failed() { return failed; },
    get usage() { return usage; },
  };
}

// ─── the adapter ──────────────────────────────────────────────────────────────

export class ZcodeServerAdapter {
  constructor({
    serverCjs,               // explicit path; auto-resolved from the desktop install otherwise
    nodeBin,                 // explicit node binary; desktop-bundled node / agent-bridge's node otherwise
    agentCommand,            // explicit zcode agent CLI; auto-resolved (desktop install) otherwise
    cwd = process.cwd(),     // the zcode workspace every session lives in
    log = () => {},
  } = {}) {
    this.opts = { cwd, log, agentCommand };
    this.serverCjs = serverCjs;
    this.nodeBin = nodeBin;
    this.child = null;
    this.ready = false;          // hello-ack + [200] + v4 handshake done
    this.starting = null;        // spawn+handshake serialization lock (codex pattern)
    this.closed = false;
    this.connId = null;          // hello.connectionId — attachment upload calls need it
    this.clientId = 'agb-' + randomUUID();
    this.nextId = 0;
    this.pending = new Map();    // rpc id → {resolve, reject, child}
    this.listeners = new Map();  // listen id → handler
    this.sessions = new Map();   // sessionId → turn entry
    this.approvals = new Map();  // requestId(interactionId) → {sessionId, optionIds}
    this.lastKnownSessionId = null; // most recent session this bridge turned in — the image-upload carrier
    this.lastUsage = new Map();  // sessionId → last known cumulative usage (turn deltas)
    this.subscribed = new Set(); // sessions subscribed by the CURRENT child (fresh Set per child)
    this.fragBuf = new Map();    // wire-frame fragment assembly
  }

  async ensureChild() {
    if (this.child && this.child.exitCode === null && this.ready) return;
    if (this.closed) throw new Error('bridge adapter already stopped');
    if (!this.starting) this.starting = this.#startChild().finally(() => { this.starting = null; });
    await this.starting;
  }

  async #startChild() {
    if (!existsSync(this.opts.cwd)) {
      // spawn() with a nonexistent cwd fails as a bare ENOENT naming the NODE
      // binary — pre-check so the error names the actual problem.
      throw new Error(`zcode: workspace does not exist: ${this.opts.cwd} — fix the bridge entry's "cwd"`);
    }
    const serverCjs = resolveServerCjs({ serverCjs: this.serverCjs });
    const nodeBin = resolveNodeBin({ nodeBin: this.nodeBin });
    // The server child inherits the explicit agent command (config/env) or the
    // one resolved from the desktop install — without it the official server
    // refuses every turn on desktop-only Mac installs (see resolveAgentCommandEnv).
    const agentEnv = resolveAgentCommandEnv({ serverCjs, agentCommand: this.opts.agentCommand });
    if (agentEnv.ZCODE_AGENT_SERVER_COMMAND) {
      this.opts.log(`agent command: ${agentEnv.ZCODE_AGENT_SERVER_COMMAND}${agentEnv.ZCODE_AGENT_SERVER_ARGS_JSON ? ' ' + agentEnv.ZCODE_AGENT_SERVER_ARGS_JSON : ''}`);
    } else {
      this.opts.log('WARNING: no zcode agent CLI found next to the server bundle or in /Applications/ZCode.app — if the first turn fails with "ZCode agent server command is not configured", set "agentCommand" on the bridge entry');
    }
    this.opts.log(`spawning zcode server: ${nodeBin} ${serverCjs} (workspace ${this.opts.cwd})`);
    // A respawn only starts once the previous child is gone; settle its work first.
    this.#sweepStale('zcode server restarted');
    const child = spawn(nodeBin, [serverCjs], {
      cwd: this.opts.cwd,
      env: agentSpawnEnv(agentEnv),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    this.ready = false;
    this.subscribed = new Set(); // subscriptions die with the child
    this.fragBuf = new Map();

    child.stderr.on('data', (d) => this.opts.log(`[zcode stderr] ${String(d).trimEnd().slice(0, 400)}`));
    child.on('exit', (code) => {
      this.opts.log(`zcode server exited (code=${code})`);
      this.#childDown(child, `zcode server exited (code=${code})`);
    });
    child.on('error', (err) => {
      const msg = `failed to start zcode server '${nodeBin} ${serverCjs}': ${err.message}`;
      this.opts.log(msg);
      this.#childDown(child, msg);
    });

    // The hello line arrives on stdout; the ack MUST go out before any binary
    // frame (the server's ack parser reads one line, then re-attaches RPC).
    const initPromise = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('zcode: no RPC Initialize from server — is this a zcode server bundle?')), INIT_TIMEOUT_MS);
      this.initWaiter = { resolve: () => { clearTimeout(t); resolve(); }, reject };
    });
    let helloDone = false;
    let helloBuf = Buffer.alloc(0);
    const feed = createFrameAssembler(([header, body]) => this.#onMessage(header, body));
    child.stdout.on('data', (chunk) => {
      if (!helloDone) {
        helloBuf = Buffer.concat([helloBuf, chunk]);
        const i = helloBuf.indexOf(0x0a);
        if (i === -1) return;
        this.opts.log(`server hello: ${helloBuf.subarray(0, i).toString('utf8').slice(0, 120)}`);
        helloDone = true;
        child.stdin.write(JSON.stringify({ type: 'zcode-hello-ack', version: 'agent-bridge', clientId: this.clientId }) + '\n');
        const rest = helloBuf.subarray(i + 1);
        helloBuf = Buffer.alloc(0);
        if (rest.length) feed(rest);
        return;
      }
      feed(chunk);
    });

    await initPromise;
    // v4 handshake: echo the hello's protocolVersion; only echo capabilities we saw.
    const hello = await this.rpc('helloConversationV4', [], INIT_TIMEOUT_MS);
    this.connId = hello?.connectionId || null;
    await this.rpc('initializeConversationV4', [{
      kind: 'clientHello',
      protocolVersion: hello?.protocolVersion || 3,
      clientId: this.clientId,
      clientKind: 'web',
      appVersion: 'agent-bridge',
      capabilities: {
        workspaceHookReviewUi: true,
        ...(hello?.capabilities?.workflowRunDeltas === true ? { workflowRunDeltas: true } : {}),
      },
    }], INIT_TIMEOUT_MS);
    // Host-relay callback: without an answer, createSession stalls 15s per turn.
    this.listen('onDynamicSessionRuntimePreferencesRequest', undefined, (req) => {
      if (!req?.requestId) return;
      this.rpc('respondSessionRuntimePreferences', [{
        requestId: req.requestId,
        resolution: { status: 'resolved', preferences: {
          nativeSearchEnhancementsEnabled: false,
          memoryEnabled: false,
          askUserQuestionAutoResolutionEnabled: true,
        } },
      }]).catch(() => {});
    });
    // Workspace-level conversation fan-out, routed by topic (registered ONCE
    // per child; per-turn listeners would leak and re-subscribe the event).
    this.listen('onDynamicConversationFrame', { workspacePath: this.opts.cwd }, (raw) => this.#onConversationFrame(raw));
    this.ready = true;
    this.opts.log('zcode server ready');
  }

  #onMessage(header, body) {
    const [msgType, id] = header;
    if (msgType === 200) { const w = this.initWaiter; this.initWaiter = null; w?.resolve(); return; }
    if (msgType === 201) {
      const p = this.pending.get(id);
      if (p) { this.pending.delete(id); p.resolve(body); }
      return;
    }
    if (msgType === 202 || msgType === 203) {
      const p = this.pending.get(id);
      if (p) {
        this.pending.delete(id);
        const err = new Error(body?.message || body?.name || 'zcode rpc error');
        err.code = body?.code || '';
        p.reject(err);
      }
      return;
    }
    if (msgType === 204) {
      const h = this.listeners.get(id);
      if (h) h(body);
    }
  }

  #childDown(child, msg) {
    const w = this.initWaiter;
    if (w) { this.initWaiter = null; w.reject(new Error(msg)); }
    for (const [id, p] of this.pending) {
      if (p.child !== child) continue;
      this.pending.delete(id);
      p.reject(new Error(msg));
    }
    for (const [, entry] of this.sessions) {
      if (entry.child !== child || entry.finished) continue;
      entry.finished = true;
      entry.events?.({ type: 'error', message: `${msg} mid-turn` });
    }
    if (this.child === child) { this.child = null; this.ready = false; }
  }

  #sweepStale(msg) {
    for (const [, p] of this.pending) p.reject(new Error(msg));
    this.pending.clear();
    for (const [, entry] of this.sessions) {
      if (entry.finished) continue;
      entry.finished = true;
      entry.events?.({ type: 'error', message: `${msg} mid-turn` });
    }
    this.sessions.clear();
    this.approvals.clear();
    this.listeners.clear();
    if (this.child) {
      try { this.child.kill('SIGKILL'); } catch (_) {}
      this.child = null;
    }
    this.ready = false;
  }

  rpc(method, argsArray, timeoutMs = RPC_TIMEOUT_MS, channel = 'zcode-agent') {
    if (!this.child) return Promise.reject(new Error('zcode: child not running'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`zcode rpc timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
        child: this.child,
      });
      const head = serialize([100, id, channel, method]);
      const body = argsArray === undefined ? serialize(undefined) : serialize(argsArray);
      const buf = Buffer.alloc(head.length + body.length);
      buf.set(head); buf.set(body, head.length);
      try { this.child.stdin.write(encodeFrame(buf)); } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }

  listen(event, arg, handler, channel = 'zcode-agent') {
    const id = this.nextId++;
    const head = serialize([102, id, channel, event]);
    const body = serialize(arg);
    const buf = Buffer.alloc(head.length + body.length);
    buf.set(head); buf.set(body, head.length);
    this.listeners.set(id, handler);
    try { this.child.stdin.write(encodeFrame(buf)); } catch (_) {}
    return id;
  }

  command(type, payload, sessionId, timeoutMs) {
    return this.rpc('sendConversationCommandV4', [{
      workspacePath: this.opts.cwd,
      envelope: {
        commandId: randomUUID(),
        clientId: this.clientId,
        sessionId: sessionId ?? null,
        type,
        payload,
        issuedAt: Date.now(),
      },
    }], timeoutMs);
  }

  /** Frame routing: workspace fan-out → the session's turn entry. The entry's
   * phase gates application: 'awaiting' buffers (the command ack and the first
   * turn frames can share one stdin chunk, and the ack resolves a promise —
   * a microtask that runs AFTER the same drain), 'armed' applies, 'idle'
   * ignores (old-turn replay / foreign clients). */
  #onConversationFrame(raw) {
    const wire = assembleWireFrame(raw, this.fragBuf);
    if (!wire || typeof wire.topic !== 'string' || !wire.topic.startsWith('conversation/')) return;
    const sessionId = wire.topic.slice('conversation/'.length);
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.finished) return;
    const inner = wire.frame;
    if (!inner?.payload) return;
    if (inner.payload.kind === 'snapshot') {
      if (entry.phase === 'awaiting') entry.preBuffer.push({ kind: 'snapshot', snapshot: inner.payload.snapshot });
      else if (entry.phase === 'armed') entry.projector.snapshot(inner.payload.snapshot);
      return;
    }
    if (inner.payload.kind !== 'deltas') return;
    if (entry.phase === 'awaiting') { entry.preBuffer.push({ kind: 'deltas', deltas: inner.payload.deltas || [] }); return; }
    if (entry.phase !== 'armed') return;
    entry.projector.applyOps(inner.payload.deltas || []);
    if (entry.projector.ended) this.#finishTurn(entry);
  }

  #finishTurn(entry) {
    entry.finished = true;
    entry.phase = 'idle';
    if (entry.stopTimer) { clearTimeout(entry.stopTimer); entry.stopTimer = null; }
    entry.projector.finish();
    if (entry.projector.failed) {
      entry.events?.({ type: 'error', message: 'zcode turn failed' });
      return;
    }
    if (entry.endState === 'completedInterrupted') {
      // Interrupted turns settle as `aborted` (codex parity) — done.full would
      // present a half-answer as the reply.
      entry.events?.({ type: 'aborted' });
      return;
    }
    const end = entry.projector.usage?.cumulative || null;
    const start = entry.usageStart;
    const usage = end
      ? { prompt_tokens: Math.max(0, (end.inputTokens ?? 0) - (start?.inputTokens ?? 0)),
          completion_tokens: Math.max(0, (end.outputTokens ?? 0) - (start?.outputTokens ?? 0)) }
      : null;
    if (end) this.lastUsage.set(entry.sessionId, end);
    this.lastKnownSessionId = entry.sessionId;
    entry.events?.({ type: 'done', full: entry.projector.fullText(), usage });
  }

  /** Most recent persisted session of this workspace (legacy listSessions) —
   * the fallback image-upload carrier when this bridge never turned here.
   * The official build wants the workspace FLAT; the OSS schema's nested
   * `workspace` ref 400s ("expected string, received undefined"). */
  async #findRecentPersistedSession() {
    try {
      const listed = await this.rpc('listSessions', [{ workspacePath: this.opts.cwd, limit: 5 }], RPC_TIMEOUT_MS, 'zcode-session');
      const list = Array.isArray(listed) ? listed : (listed?.sessions || []);
      const sid = list.find((s) => s?.sessionId)?.sessionId || null;
      if (sid) this.opts.log(`image carrier from listSessions: ${sid}`);
      return sid;
    } catch (e) {
      this.opts.log(`listSessions failed (${e.message}) — no image carrier`);
      return null;
    }
  }

  #register(sessionId, entry) {
    entry.projector = createTurnProjector({
      onDelta: (t) => entry.events?.({ type: 'delta', text: t }),
      onTool: (ev) => entry.events?.({ type: 'tool', ...ev }),
        onApproval: (ev) => {
          this.approvals.set(ev.requestId, { sessionId, optionIds: ev.optionIds });
          entry.events?.({ type: 'approval', requestId: ev.requestId, tool: ev.tool, command: ev.command });
        },
        onTurnEnd: ({ state }) => { entry.endState = state; },
    });
    entry.usageStart = this.lastUsage.get(sessionId) || null;
    this.sessions.set(sessionId, entry);
  }

  #arm(entry) {
    if (entry.phase !== 'awaiting') return;
    entry.phase = 'armed';
    for (const item of entry.preBuffer.splice(0)) {
      if (item.kind === 'snapshot') entry.projector.snapshot(item.snapshot);
      else entry.projector.applyOps(item.deltas);
    }
    if (entry.projector.ended && !entry.finished) this.#finishTurn(entry);
  }

  /** attachmentBegin with a bounded wait: a just-created draft session is
   * neither active nor persisted until the session-plane CLI finishes booting
   * (measured 1.5–8s cold) — the face rejects with fault.subscribe.
   * sessionNotFound ("not active and not persisted") until then. 30 × 500ms
   * covers the cold boot without masking real unknown session ids. */
  async #beginAttachmentWithRetry(params) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.rpc('attachmentBeginV4', [params], RPC_TIMEOUT_MS);
      } catch (e) {
        if (attempt >= 29 || !/sessionNotFound|not active and not persisted/i.test(`${e?.code} ${e?.message}`)) throw e;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }

  /** Upload one data-URL image through the v4 attachment face; returns the
   * {ref, fileName, mime, bytes} attachmentRef for the sendText payload. */
  async #uploadAttachment(sessionId, image, index) {
    const parsed = parseDataUrl(image);
    if (!parsed) throw new Error(`zcode: image #${index + 1} is not a data: URL`);
    const bytes = Buffer.from(parsed.b64, 'base64');
    if (bytes.length > ATTACHMENT_MAX_BYTES) throw new Error(`zcode: image #${index + 1} exceeds the 20MB attachment limit`);
    const ext = /^image\/jpeg$/i.test(parsed.mime) ? 'jpg' : (/^image\/([a-z0-9.+-]+)/i.exec(parsed.mime)?.[1] || 'png');
    const fileName = `image-${index + 1}.${ext}`;
    const uploadId = `agb-${randomUUID()}`;
    const checksum = 'sha256:' + createHash('sha256').update(bytes).digest('hex');
    const pieces = splitBase64ForChunks(parsed.b64);
    const begin = await this.#beginAttachmentWithRetry({
      connectionId: this.connId,
      uploadId, sessionId,
      fileName,
      mime: parsed.mime,
      totalBytes: bytes.length,
      totalChunks: pieces.length,
      checksum,
    });
    if (begin?.state === 'committed' && begin.ref) {
      return { ref: begin.ref, fileName, mime: parsed.mime, bytes: bytes.length }; // server-side dedupe hit
    }
    for (let i = begin?.nextChunkIndex ?? 0; i < pieces.length; i++) {
      const r = await this.rpc('attachmentChunkV4', [{ connectionId: this.connId, uploadId, sessionId, chunkIndex: i, dataBase64: pieces[i] }], RPC_TIMEOUT_MS);
      if (r?.nextChunkIndex != null && r.nextChunkIndex !== i + 1) i = r.nextChunkIndex - 1;
    }
    const committed = await this.rpc('attachmentCommitV4', [{ connectionId: this.connId, uploadId, sessionId }], RPC_TIMEOUT_MS);
    if (!committed?.ref) throw new Error(`zcode: attachment commit returned no ref (image #${index + 1})`);
    return { ref: committed.ref, fileName, mime: parsed.mime, bytes: bytes.length };
  }

  /** Subscribe with a bounded retry: a just-promoted draft session is admitted
   * (sendText acked) a moment BEFORE its journal is subscribable — the real
   * fault is `fault.subscribe.sessionNotFound` ("not active and not persisted").
   * 8 × 250ms covers the persistence lag without masking real unknown ids. */
  async #subscribeWithRetry(sessionId) {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.rpc('subscribeConversationV4', [{ workspacePath: this.opts.cwd, sessionId, visibility: 'foreground' }], TURN_ACK_TIMEOUT_MS);
        this.subscribed.add(sessionId);
        return;
      } catch (e) {
        if (attempt >= 7 || !/sessionNotFound|not active and not persisted/i.test(`${e?.code} ${e?.message}`)) throw e;
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  }

  async startTurn({ text, sessionId, images, onEvent }) {
    await this.ensureChild();
    if (sessionId && !this.subscribed.has(sessionId)) {
      // Resume a session from an earlier bridge/child lifetime: subscribe first
      // (the snapshot replay lands while no turn entry exists → ignored).
      await this.#subscribeWithRetry(sessionId);
    }
    const entry = {
      sessionId: sessionId || null,
      phase: 'awaiting',         // frames buffer until the command ack is applied
      preBuffer: [],
      projector: null,
      events: onEvent,
      finished: false,
      usageStart: null,
      stopTimer: null,
      child: this.child,
    };
    try {
      if (sessionId) {
        this.#register(sessionId, entry);
        onEvent({ type: 'start', sessionId, turnId: '' });
        const refs = [];
        for (let i = 0; i < (Array.isArray(images) ? images.length : 0); i++) {
          refs.push(await this.#uploadAttachment(sessionId, images[i], i));
        }
        const ack = await this.command('sendText', refs.length ? { text, attachments: refs } : { text }, sessionId, TURN_ACK_TIMEOUT_MS);
        if (ack?.status !== 'accepted') {
          throw new Error(`zcode sendText: ${ack?.reasonCode || ack?.message || ack?.status}`);
        }
        this.#arm(entry);
        } else if (Array.isArray(images) && images.length) {
          // Image turns: the attachment face refuses uploads against a v4
          // DRAFT session (createSession without firstInput — "not active and
          // not persisted", fault.subscribe.sessionNotFound; an empty
          // persistence:'immediate' session never leaves that state either —
          // the gate needs a session with journal rows). Proven-live carrier:
          // upload refs against a PERSISTED session (this conversation's last
          // one, or the workspace's most recent via listSessions), then ride
          // them in one-step createSession(firstInput+attachments).
          const carrier = this.lastKnownSessionId || (await this.#findRecentPersistedSession());
          if (carrier) {
            const refs = [];
            for (let i = 0; i < images.length; i++) refs.push(await this.#uploadAttachment(carrier, images[i], i));
            const ack = await this.command('createSession', { workspaceId: this.opts.cwd, firstInput: { text, attachments: refs } }, null, TURN_ACK_TIMEOUT_MS);
            if (ack?.status !== 'accepted' || ack?.result?.type !== 'createSession') {
              const reason = ack?.reasonCode || ack?.message || `status=${ack?.status}`;
              throw new Error(/PROVIDER_NOT_READY/.test(String(reason))
                ? 'ZCode has no usable model (not logged in / no API key) — sign in from the ZCode app first'
                : `zcode createSession failed: ${reason}`);
            }
            const sid = ack.result.sessionId;
            entry.sessionId = sid;
            this.#register(sid, entry);
            onEvent({ type: 'start', sessionId: sid, turnId: '' });
            await this.#subscribeWithRetry(sid);
            this.#arm(entry);
          } else {
            // Nothing persisted anywhere (fresh ZCode workspace + fresh
            // bridge): there is no upload carrier — degrade honestly instead
            // of sending images the agent can never see.
            const note = `（注：${images.length} 张图片未能随附——这是本 ZCode 工作区的第一条消息，还没有可用于传图的会话；图片请在下一条消息重新粘贴。）`;
            const ack = await this.command('createSession', { workspaceId: this.opts.cwd, firstInput: { text: `${text}\n\n${note}` } }, null, TURN_ACK_TIMEOUT_MS);
            if (ack?.status !== 'accepted' || ack?.result?.type !== 'createSession') {
              const reason = ack?.reasonCode || ack?.message || `status=${ack?.status}`;
              throw new Error(/PROVIDER_NOT_READY/.test(String(reason))
                ? 'ZCode has no usable model (not logged in / no API key) — sign in from the ZCode app first'
                : `zcode createSession failed: ${reason}`);
            }
            const sid = ack.result.sessionId;
            entry.sessionId = sid;
            this.#register(sid, entry);
            onEvent({ type: 'start', sessionId: sid, turnId: '' });
            await this.#subscribeWithRetry(sid);
            this.#arm(entry);
          }
        } else {
          // One-step text turn: firstInput rides createSession — the session
          // persists immediately, so subscribing before arming replays any
          // rows the turn already produced as a snapshot.
          const ack = await this.command('createSession', { workspaceId: this.opts.cwd, firstInput: { text } }, null, TURN_ACK_TIMEOUT_MS);
          if (ack?.status !== 'accepted' || ack?.result?.type !== 'createSession') {
            const reason = ack?.reasonCode || ack?.message || `status=${ack?.status}`;
            throw new Error(/PROVIDER_NOT_READY/.test(String(reason))
              ? 'ZCode has no usable model (not logged in / no API key) — sign in from the ZCode app first'
              : `zcode createSession failed: ${reason}`);
          }
          const sid = ack.result.sessionId;
          entry.sessionId = sid;
          this.#register(sid, entry);
          onEvent({ type: 'start', sessionId: sid, turnId: '' });
          await this.#subscribeWithRetry(sid);
          this.#arm(entry);
        }
    } catch (e) {
      if (!entry.finished) {
        entry.finished = true;
        entry.phase = 'idle';
        entry.events?.({ type: 'error', message: e?.message || String(e) });
        if (entry.sessionId && !sessionId) this.sessions.delete(entry.sessionId);
      }
      throw e;
    }
    return { sessionId: entry.sessionId, turnId: '' };
  }

  async interrupt(sessionId) {
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.finished) return;
    try {
      await this.command('stop', {}, sessionId, STOP_TIMEOUT_MS);
      // Success: the turn settles via turnHeader completedInterrupted → aborted.
      entry.stopTimer = setTimeout(() => {
        if (entry.finished) return;
        entry.finished = true;
        entry.phase = 'idle';
        entry.events?.({ type: 'aborted' });
      }, STOP_TIMEOUT_MS);
    } catch (e) {
      // A lost stop must never leave the session busy forever — settle locally.
      this.opts.log(`interrupt failed: ${e.message}`);
      if (!entry.finished) {
        entry.finished = true;
        entry.phase = 'idle';
        entry.events?.({ type: 'aborted' });
      }
    }
  }

  async renameSession(sessionId, name) {
    if (!sessionId || !name || !String(name).trim()) throw new Error('zcode rename: sessionId and name required');
    await this.ensureChild();
    const ack = await this.command('renameSession', { title: String(name).trim() }, sessionId, RPC_TIMEOUT_MS);
    if (ack?.status !== 'accepted') throw new Error(`zcode rename failed: ${ack?.reasonCode || ack?.message || ack?.status}`);
  }

  async respondApproval(requestId, choice) {
    const pending = this.approvals.get(String(requestId));
    if (!pending) throw new Error(`no pending approval ${requestId}`);
    this.approvals.delete(String(requestId));
    const optId = pending.optionIds?.[choice];
    const answer = optId ? { optionId: optId }
      : choice === 'deny' ? { action: 'decline' }
      : { action: 'accept' }; // once/always with no matching option kind
    const ack = await this.command('resolveInteraction', { interactionId: String(requestId), answer }, pending.sessionId, RPC_TIMEOUT_MS);
    if (ack?.status !== 'accepted') throw new Error(`zcode resolveInteraction: ${ack?.reasonCode || ack?.message || ack?.status}`);
  }

  listSessions() {
    return [...this.sessions.entries()].map(([sessionId, entry]) => ({
      sessionId,
      busy: !!(entry && !entry.finished),
    }));
  }

  stop() {
    this.closed = true;
    try { this.child?.stdin?.end(); } catch (_) {}
    try { this.child?.kill('SIGKILL'); } catch (_) {}
    this.child = null;
    this.ready = false;
  }
}
