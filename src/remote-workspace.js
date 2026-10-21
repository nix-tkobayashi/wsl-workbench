// Remote workspaces: a workspace whose `distro` is `ssh:<host>` lives on that ssh host (e.g. an EC2
// instance). Its `wslPath` is a path on the host. The tree, editor and git badge talk to a small
// Python agent (remote-agent.py) started once per host over ssh; terminals run `ssh -t <host>`. ssh
// itself runs inside a local WSL distro, so that distro's ~/.ssh/config (keys, SSM ProxyCommand)
// applies. Encoding the host in `distro` keeps every renderer call, session key and recent entry
// working unchanged — main dispatches on it. Kept free of Electron so it can be unit-tested.
const fs = require('fs');
const path = require('path');
const { validHost } = require('./remote-terminal');

const REMOTE_PREFIX = 'ssh:';
// WSL distro names cannot contain ':', so the prefix can never collide with a real distro.
function remoteHostOf(distro) {
  if (typeof distro !== 'string' || !distro.startsWith(REMOTE_PREFIX)) return null;
  const host = distro.slice(REMOTE_PREFIX.length);
  return validHost(host) ? host : null;
}
function isRemoteDistro(distro) {
  return typeof distro === 'string' && distro.startsWith(REMOTE_PREFIX);
}
function remoteDistro(host) { return `${REMOTE_PREFIX}${host}`; }

// "host", "host:/abs/dir", "host:~/dir" or "host:dir" (relative to the remote home) -> { host, path }.
function parseRemoteSpec(spec) {
  const m = String(spec || '').trim().match(/^([^:\s]+)(?::(.*))?$/);
  if (!m || !validHost(m[1])) return null;
  const dir = (m[2] || '').trim();
  if (/[\x00-\x1f\x7f]/.test(dir)) return null;
  return { host: m[1], path: dir || '~' };
}

const AGENT_SOURCE_PATH = path.join(__dirname, 'remote-agent.py');
// The remote command ssh runs. The agent travels base64-encoded as argv[1] (only [A-Za-z0-9+/=],
// so no quoting issue through ssh's remote shell or wsl.exe's command line).
function agentRemoteCommand(source = fs.readFileSync(AGENT_SOURCE_PATH, 'utf8')) {
  const b64 = Buffer.from(source, 'utf8').toString('base64');
  return `python3 -u -c 'import sys,base64;exec(base64.b64decode(sys.argv[1]))' ${b64}`;
}

// wsl.exe argv for the agent connection. BatchMode: a missing key / expired SSO token fails fast
// with ssh's message instead of hanging on a prompt nobody can see (-T: no pty, stdio is the RPC).
function agentSshArgs(distro, host, remoteCommand = agentRemoteCommand()) {
  return ['-d', distro, '--exec', 'ssh', '-T',
    '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=30',
    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
    '--', host, remoteCommand];
}

class RemoteError extends Error {
  constructor(message, code = 'EIO') { super(message); this.name = 'RemoteError'; this.code = code; }
}

// Wait before reconnecting after a failed connection: doubles per failure up to the cap, so the
// tree's 1.5 s poll can't spawn an ssh (and an SSM session) every tick while a host is down.
function reconnectDelayMs(failures, baseMs = 2000, maxMs = 30000) {
  if (!(failures > 0)) return 0;
  return Math.min(maxMs, baseMs * 2 ** Math.min(failures - 1, 16));
}

// One agent process (one ssh connection) per host, started on first use and restarted on the next
// request after it dies (after reconnectDelayMs once connecting has failed; `reconnect()` skips the
// wait). `spawn` returns a ChildProcess-like object (stdin/stdout/stderr, 'exit'). `beforeStart`
// (optional, async) runs before each connection attempt — main uses it to wait for the local
// secret copies an ssh ProxyCommand may read.
class RemoteAgent {
  constructor(spawn, { label = 'remote', readyTimeoutMs = 60000, requestTimeoutMs = 30000, beforeStart = null, now = Date.now } = {}) {
    this.spawn = spawn;
    this.label = label;
    this.readyTimeoutMs = readyTimeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.beforeStart = beforeStart;
    this.now = now;
    this.child = null;
    this.ready = null;
    this.starting = null;
    this.pending = new Map();
    this.seq = 0;
    this.failures = 0;      // consecutive failed connection attempts
    this.lastError = null;  // the error of the last failed attempt
    this.lastFailureAt = 0;
  }

  // Whether the agent is currently connected (or connecting).
  get connected() { return !!this.child; }

  _start() {
    const child = this.spawn();
    this.child = child;
    let stderr = '';
    let parts = [];
    let readyDone = false;
    let resolveReady;
    let rejectReady;
    this.ready = new Promise((res, rej) => { resolveReady = res; rejectReady = rej; });
    this.ready.catch(() => {}); // observed by request(); avoid an unhandled rejection meanwhile
    const fail = (message) => {
      if (this.child !== child) return;
      this.child = null;
      clearTimeout(readyTimer);
      const tail = stderr.trim().split('\n').slice(-3).join('\n');
      const err = new RemoteError(`${this.label}: ${message}${tail ? `\n${tail}` : ''}`, 'ECONNRESET');
      if (!readyDone) {
        readyDone = true;
        this.failures += 1;
        this.lastError = err;
        this.lastFailureAt = this.now();
        rejectReady(err);
      }
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(err); }
      this.pending.clear();
      try { child.kill(); } catch {}
    };
    const readyTimer = setTimeout(() => fail('connection timed out'), this.readyTimeoutMs);
    const onLine = (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      if (msg.id === 0 && !readyDone) {
        readyDone = true;
        clearTimeout(readyTimer);
        this.failures = 0;
        this.lastError = null;
        this.info = msg.result || {};
        resolveReady(this.info);
        return;
      }
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new RemoteError((msg.error && msg.error.message) || 'remote error', (msg.error && msg.error.code) || 'EIO'));
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      // Lines can be tens of MB (base64 file contents): collect chunks, join only at a newline.
      let start = 0;
      let nl;
      while ((nl = chunk.indexOf('\n', start)) !== -1) {
        parts.push(chunk.slice(start, nl));
        const line = parts.join('');
        parts = [];
        onLine(line);
        start = nl + 1;
      }
      if (start < chunk.length) parts.push(chunk.slice(start));
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4096); });
    child.on('error', (e) => fail(`failed to start (${e.message || e})`));
    child.on('exit', (code) => fail(`connection closed (exit ${code})`));
    child.stdin.on('error', () => {});
  }

  async _ensureStarted() {
    if (this.child) return;
    const wait = reconnectDelayMs(this.failures) - (this.now() - this.lastFailureAt);
    if (this.failures && wait > 0) {
      throw new RemoteError(`${this.lastError ? this.lastError.message : `${this.label}: not connected`}`, 'ENOTCONN');
    }
    if (!this.beforeStart) { this._start(); return; }
    if (!this.starting) {
      this.starting = (async () => {
        try { if (this.beforeStart) await this.beforeStart(); } catch { /* best effort */ }
        if (!this.child) this._start();
      })().finally(() => { this.starting = null; });
    }
    await this.starting;
  }

  // Drop the reconnect wait so the next request connects right away (the user asked to retry).
  reconnect() {
    this.failures = 0;
    this.lastFailureAt = 0;
  }

  async request(op, args = {}, { timeoutMs = this.requestTimeoutMs } = {}) {
    await this._ensureStarted();
    const child = this.child;
    if (!child) throw new RemoteError(`${this.label}: connection closed`, 'ECONNRESET');
    await this.ready;
    if (this.child !== child) throw new RemoteError(`${this.label}: connection closed`, 'ECONNRESET');
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RemoteError(`${this.label}: ${op} did not respond within ${timeoutMs}ms`, 'ETIMEDOUT'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ ...args, id, op })}\n`);
    });
  }

  dispose() {
    const child = this.child;
    this.child = null;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new RemoteError(`${this.label}: closed`, 'ECONNRESET')); }
    this.pending.clear();
    if (child) { try { child.stdin.end(); } catch {} try { child.kill(); } catch {} }
  }
}

class RemoteAgentPool {
  constructor(spawnForHost, options = {}) {
    this.spawnForHost = spawnForHost;
    this.options = options;
    this.agents = new Map();
  }
  get(host) {
    let agent = this.agents.get(host);
    if (!agent) {
      agent = new RemoteAgent(() => this.spawnForHost(host), { ...this.options, label: `ssh ${host}` });
      this.agents.set(host, agent);
    }
    return agent;
  }
  disposeAll() {
    for (const agent of this.agents.values()) agent.dispose();
    this.agents.clear();
  }
}

module.exports = {
  REMOTE_PREFIX, remoteHostOf, isRemoteDistro, remoteDistro, parseRemoteSpec,
  agentRemoteCommand, agentSshArgs, reconnectDelayMs, RemoteError, RemoteAgent, RemoteAgentPool
};
