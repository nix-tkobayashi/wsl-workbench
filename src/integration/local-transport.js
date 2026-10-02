// Local transport between the MCP adapter process and the main-process broker.
//
// Windows: a named pipe; elsewhere (tests / dev): a Unix socket in the integration directory.
// Node cannot set a named pipe's DACL, so the pipe's default ACL is NOT relied on for access
// control. Instead every connection must pass a mutual HMAC challenge-response over a 256-bit
// pairing secret that only the current Windows user can read (pairing.js restricts the file to the
// user's SID). Until authenticated, a connection gets nothing but the challenge; a failed or slow
// handshake is dropped. The adapter verifies the server's proof too, so a process squatting on the
// pipe name cannot impersonate Workbench.
//
// Framing: one JSON object per line (UTF-8), bounded line size and connection count.
//   S->C {t:'hello', proto, nonce}
//   C->S {t:'auth', client_nonce, proof = HMAC(secret, 'c|'+nonce+'|'+client_nonce)}
//   S->C {t:'auth_ok', proof = HMAC(secret, 's|'+nonce+'|'+client_nonce)}   (or close)
//   C->S {t:'req', id, method:'tool', params:{name, args}}  S->C {t:'res', id, result}

const net = require('net');
const fs = require('fs');
const crypto = require('crypto');

const PROTO = 'wswb-broker/1';
const MAX_LINE_BYTES = 256 * 1024;
const AUTH_TIMEOUT_MS = 5000;
const MAX_CONNECTIONS = 4;

function hmac(secret, label, nonce, clientNonce) {
  return crypto.createHmac('sha256', secret).update(`${label}|${nonce}|${clientNonce}`).digest('hex');
}

function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || !/^[0-9a-f]+$/.test(a)) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

function principalFor(secret) {
  return `paired-local:${crypto.createHash('sha256').update(secret).digest('hex').slice(0, 12)}`;
}

// Line splitter with a hard size cap; calls onLine(obj) per JSON line, onAbuse() on overflow/garbage.
function lineReader(socket, onLine, onAbuse) {
  let pending = Buffer.alloc(0);
  socket.on('data', (data) => {
    pending = pending.length ? Buffer.concat([pending, data]) : data;
    let nl;
    while ((nl = pending.indexOf(0x0a)) >= 0) {
      const line = pending.subarray(0, nl).toString('utf8');
      pending = pending.subarray(nl + 1);
      if (!line.trim()) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { onAbuse('bad-json'); return; }
      if (!obj || typeof obj !== 'object') { onAbuse('bad-json'); return; }
      onLine(obj);
    }
    if (pending.length > MAX_LINE_BYTES) onAbuse('line-too-long');
  });
}

function send(socket, obj) {
  if (!socket.destroyed && socket.writable) socket.write(`${JSON.stringify(obj)}\n`);
}

// listenWith (optional): async (onConnection) => ({ close }) — a custom connection source (the
// Windows DACL-restricted pipe relay). Connections are Duplex streams; the handshake and framing
// below are identical either way. onTool may return a result or a Promise of one.
function createBrokerServer({ endpoint, secret, onTool, onEvent = () => {}, maxConnections = MAX_CONNECTIONS, authTimeoutMs = AUTH_TIMEOUT_MS, listenWith = null }) {
  if (!Buffer.isBuffer(secret) || secret.length < 32) throw new Error('pairing secret must be >= 32 bytes');
  const principal = principalFor(secret);
  const sockets = new Set();
  const status = { listening: false, connections: 0, lastConnectedAt: null, lastAuthFailureAt: null, error: null };

  let custom = null;
  function handleConnection(socket) {
    // Relayed connections carry the relay's id so these lines join up with relay_* events.
    const relayId = socket.relayId === undefined ? undefined : socket.relayId;
    if (sockets.size >= maxConnections) {
      onEvent({ event: 'connection_rejected', reason: 'max-connections', relay_id: relayId });
      socket.destroy();
      return;
    }
    sockets.add(socket);
    onEvent({ event: 'connection_accepted', relay_id: relayId });
    let authed = false;
    let failed = false;
    let socketError = null;
    const startedAt = Date.now();
    const nonce = crypto.randomBytes(32).toString('hex');
    const authTimer = setTimeout(() => { if (!authed) fail('auth-timeout'); }, authTimeoutMs);
    function fail(reason) {
      if (!authed && !failed) {
        failed = true;
        status.lastAuthFailureAt = Date.now();
        onEvent({ event: 'auth_failed', reason, relay_id: relayId, elapsed_ms: Date.now() - startedAt });
      }
      socket.destroy();
    }
    socket.on('close', () => {
      clearTimeout(authTimer);
      sockets.delete(socket);
      if (authed) { status.connections = Math.max(0, status.connections - 1); onEvent({ event: 'disconnected', principal, relay_id: relayId }); return; }
      // The client went away before authenticating (nothing else would record this attempt).
      if (!failed) {
        failed = true;
        status.lastAuthFailureAt = Date.now();
        onEvent({ event: 'auth_failed', reason: 'peer-closed-before-auth', code: socketError || undefined, relay_id: relayId, elapsed_ms: Date.now() - startedAt });
      }
    });
    socket.on('error', (error) => { socketError = (error && error.code) || 'error'; });
    lineReader(socket, (msg) => {
      if (!authed) {
        if (msg.t !== 'auth' || typeof msg.client_nonce !== 'string' || !/^[0-9a-f]{64}$/.test(msg.client_nonce)
          || !safeEqualHex(msg.proof, hmac(secret, 'c', nonce, msg.client_nonce))) {
          fail('bad-proof');
          return;
        }
        authed = true;
        clearTimeout(authTimer);
        status.connections += 1;
        status.lastConnectedAt = Date.now();
        onEvent({ event: 'connected', principal, relay_id: relayId, elapsed_ms: Date.now() - startedAt });
        send(socket, { t: 'auth_ok', proof: hmac(secret, 's', nonce, msg.client_nonce) });
        return;
      }
      if (msg.t !== 'req' || (typeof msg.id !== 'number' && typeof msg.id !== 'string')) { socket.destroy(); return; }
      let result = null;
      if (msg.method === 'tool' && msg.params && typeof msg.params.name === 'string') {
        try { result = onTool(principal, msg.params.name, msg.params.args); } catch { result = null; }
      }
      Promise.resolve(result).catch(() => null).then((value) => send(socket, { t: 'res', id: msg.id, result: value || null }));
    }, (reason) => fail(reason));
    send(socket, { t: 'hello', proto: PROTO, nonce });
    onEvent({ event: 'hello_sent', relay_id: relayId });
  }
  const server = net.createServer(handleConnection);
  server.maxConnections = maxConnections + 1; // we reject the extra one ourselves (cleanly)

  async function listen() {
    if (listenWith) {
      custom = await listenWith(handleConnection);
      status.listening = true;
      status.error = null;
      return;
    }
    await new Promise((resolve, reject) => {
      if (process.platform !== 'win32') {
        try { if (fs.lstatSync(endpoint).isSocket()) fs.unlinkSync(endpoint); } catch {}
      }
      server.once('error', (error) => { status.error = error.code || 'listen-failed'; reject(error); });
      server.listen(endpoint, () => {
        status.listening = true;
        status.error = null;
        if (process.platform !== 'win32') { try { fs.chmodSync(endpoint, 0o600); } catch {} }
        resolve();
      });
    });
  }

  function close() {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    status.listening = false;
    status.connections = 0;
    if (custom) { const c = custom; custom = null; return Promise.resolve(c.close()); }
    return new Promise((resolve) => server.close(() => resolve()));
  }

  return { listen, close, status: () => ({ ...status }), principal };
}

// Adapter side. Resolves once mutually authenticated. On failure the rejection carries a
// non-secret `diag` ({ stage, reason, code, elapsed_ms, bytes_in }) saying how far the handshake
// got: connecting -> pipe-open -> hello-received -> auth-sent -> auth-ok. onStage(stage) is called
// as each stage is reached. Nonces, proofs and the secret are never part of it.
function connectBroker({ endpoint, secret, timeoutMs = AUTH_TIMEOUT_MS, onStage = () => {} }) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const socket = net.createConnection(endpoint);
    const pendingCalls = new Map();
    let nextId = 1;
    let authed = false;
    let clientNonce = null;
    let serverNonce = null;
    let closed = false;
    let stage = 'connecting';
    let bytesIn = 0;
    let failure = null; // { reason, code } of the first thing that went wrong
    const closeListeners = new Set();
    const reach = (next) => { stage = next; try { onStage(next); } catch {} };
    const noteFailure = (reason, code = null) => { if (!failure) failure = { reason, code }; };
    const timer = setTimeout(() => { noteFailure('timeout'); socket.destroy(); }, timeoutMs);

    function shutdown(err) {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      for (const { reject: rej, timer: t } of pendingCalls.values()) { clearTimeout(t); rej(new Error('TRANSPORT_UNAVAILABLE')); }
      pendingCalls.clear();
      if (!authed) {
        if (err) noteFailure('socket-error', err.code || null);
        noteFailure('peer-close');
        const error = new Error('TRANSPORT_UNAVAILABLE');
        error.diag = { stage, reason: failure.reason, code: failure.code, elapsed_ms: Date.now() - startedAt, bytes_in: bytesIn };
        reject(error);
      }
      for (const fn of closeListeners) { try { fn(); } catch {} }
    }

    socket.on('connect', () => reach('pipe-open'));
    socket.on('data', (data) => { bytesIn += data.length; });
    socket.on('error', (err) => shutdown(err));
    socket.on('close', () => shutdown());
    lineReader(socket, (msg) => {
      if (!authed) {
        if (msg.t === 'hello' && msg.proto === PROTO && typeof msg.nonce === 'string' && !clientNonce) {
          reach('hello-received');
          clientNonce = crypto.randomBytes(32).toString('hex');
          serverNonce = msg.nonce;
          send(socket, { t: 'auth', client_nonce: clientNonce, proof: hmac(secret, 'c', msg.nonce, clientNonce) });
          reach('auth-sent');
          return;
        }
        if (msg.t === 'auth_ok' && clientNonce && safeEqualHex(msg.proof, hmac(secret, 's', serverNonce, clientNonce))) {
          authed = true;
          clearTimeout(timer);
          reach('auth-ok');
          resolve(api);
          return;
        }
        noteFailure(msg.t === 'hello' ? 'bad-hello' : msg.t === 'auth_ok' ? 'bad-server-proof' : 'unexpected-message');
        socket.destroy();
        return;
      }
      if (msg.t === 'res' && pendingCalls.has(msg.id)) {
        const call = pendingCalls.get(msg.id);
        pendingCalls.delete(msg.id);
        clearTimeout(call.timer);
        call.resolve(msg.result);
      }
    }, (reason) => { noteFailure(`protocol-${reason}`); socket.destroy(); });

    const api = {
      callTool(name, args, callTimeoutMs = 20000) {
        if (closed) return Promise.reject(new Error('TRANSPORT_UNAVAILABLE'));
        const id = nextId++;
        return new Promise((res, rej) => {
          const t = setTimeout(() => { pendingCalls.delete(id); rej(new Error('TRANSPORT_UNAVAILABLE')); }, callTimeoutMs);
          pendingCalls.set(id, { resolve: res, reject: rej, timer: t });
          send(socket, { t: 'req', id, method: 'tool', params: { name, args } });
        });
      },
      close() { socket.destroy(); },
      onClose(fn) { closeListeners.add(fn); },
      get closed() { return closed; }
    };
  });
}

module.exports = { createBrokerServer, connectBroker, principalFor, PROTO };
