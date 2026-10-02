#!/usr/bin/env node
// WSL Workbench MCP adapter (stdio). Launched by the MCP client / Secure MCP Tunnel client, NOT by
// Workbench. It connects to the running Workbench's local broker, authenticates with the pairing
// secret that Workbench created when the user turned the integration on, and exposes the read-only
// tools over stdio. It never starts a shell or a Workbench instance of its own.
//
// Run (Windows, packaged app; the paths are shown in Workbench: Integration > Connection Status):
//   set ELECTRON_RUN_AS_NODE=1
//   "WSL Workbench.exe" "<install dir>\resources\app.asar\src\mcp\adapter.js"
// Optional: WSLWB_INTEGRATION_DIR=<userData>\integration when the default lookup doesn't fit.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { readPairing } = require('../integration/pairing');
const { connectBroker } = require('../integration/local-transport');
const { createAuditLog } = require('../integration/audit');
const { createMcpServer } = require('./server');

function candidateDirs() {
  if (process.env.WSLWB_INTEGRATION_DIR) return [process.env.WSLWB_INTEGRATION_DIR];
  const base = process.platform === 'win32'
    ? (process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'))
    : (process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'));
  return ['wsl-workbench', 'WSL Workbench'].map((name) => path.join(base, name, 'integration'));
}

function serverVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')).version || '0.0.0'; } catch { return '0.0.0'; }
}

// Connection diagnostics: stderr (the MCP client's log) and <integration dir>/diag/adapter-*.jsonl.
// Only stages, reasons, error codes, timings and byte counts — never the secret, nonces or proofs.
function diagLogger(dir) {
  const file = dir ? createAuditLog({ dir: path.join(dir, 'diag'), prefix: 'adapter' }) : null;
  return (entry) => {
    const line = { ...entry, pid: process.pid };
    try { process.stderr.write(`[wswb-adapter] ${JSON.stringify(line)}\n`); } catch {}
    if (file) file.record(line);
  };
}

let connection = null;
let connecting = null;

async function getConnection() {
  if (connection && !connection.closed) return connection;
  if (connecting) return connecting;
  connecting = (async () => {
    const dirs = candidateDirs();
    let pairing = null;
    let dir = null;
    for (const candidate of dirs) { pairing = readPairing(candidate); if (pairing) { dir = candidate; break; } }
    const log = diagLogger(dir);
    if (!pairing) {
      log({ event: 'adapter_pairing_missing', reason: `checked ${dirs.length} dir(s)` });
      const error = new Error('APP_UNAVAILABLE');
      error.diag = { stage: 'pairing', reason: 'pairing-missing' };
      throw error;
    }
    log({ event: 'adapter_connect_start', endpoint: pairing.endpoint });
    try {
      connection = await connectBroker({ ...pairing, onStage: (stage) => log({ event: 'adapter_stage', stage }) });
    } catch (cause) {
      const diag = (cause && cause.diag) || { stage: 'connecting', reason: 'exception', code: (cause && cause.code) || null };
      log({ event: 'adapter_connect_failed', ...diag });
      const error = new Error('APP_UNAVAILABLE');
      error.diag = diag;
      throw error;
    }
    log({ event: 'adapter_connected' });
    connection.onClose(() => { connection = null; log({ event: 'adapter_disconnected' }); });
    return connection;
  })();
  try { return await connecting; } finally { connecting = null; }
}

function main() {
  const send = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
  const server = createMcpServer({
    serverVersion: serverVersion(),
    send,
    callTool: async (name, args) => (await getConnection()).callTool(name, args)
  });
  let pending = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (data) => {
    pending += data;
    if (pending.length > 1024 * 1024 && !pending.includes('\n')) { pending = ''; return; } // oversized garbage
    let nl;
    while ((nl = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, nl).trim();
      pending = pending.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
      server.handle(msg).catch(() => {});
    }
  });
  process.stdin.on('end', () => { if (connection) connection.close(); process.exit(0); });
}

if (require.main === module) main();

module.exports = { candidateDirs, getConnection };
