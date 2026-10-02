// Pairing material for the local broker connection.
//
// <userData>/integration/
//   pairing.key    256-bit secret (hex). Readable by the current user only.
//   endpoint.json  { proto, endpoint } so the adapter knows where to connect (not secret).
//   audit/         audit log (audit.js)
//
// The secret is created only when the user turns the integration on (an explicit UI action with a
// confirmation). On Windows the directory and file ACLs are reset to a single ACE for the current
// user's SID with icacls, and the result is verified; if that can't be done the integration stays
// off — the default ACL is never assumed to be good enough. Elsewhere POSIX modes 0700/0600 are used.
// The secret is never put in argv, environment variables, settings.json, or logs.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { PROTO } = require('./local-transport');

const KEY_FILE = 'pairing.key';
const ENDPOINT_FILE = 'endpoint.json';

function integrationDir(userDataDir) { return path.join(userDataDir, 'integration'); }

function endpointFor(dir, platform = process.platform) {
  if (platform === 'win32') {
    const tag = crypto.createHash('sha256').update(path.resolve(dir).toLowerCase()).digest('hex').slice(0, 16);
    return `\\\\.\\pipe\\wsl-workbench-dots-${tag}`;
  }
  return path.join(dir, 'broker.sock');
}

function run(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 10000 }, (error, stdout) => {
      if (error) reject(error); else resolve(String(stdout || ''));
    });
  });
}

async function currentUserSid() {
  const out = await run('whoami', ['/user', '/fo', 'csv', '/nh']);
  const m = /"(S-1-[0-9-]+)"/.exec(out);
  if (!m) throw new Error('Could not determine the current user SID.');
  return m[1];
}

// Reset the ACL to "current user: full control" only, then verify exactly one ACE remains.
async function restrictWindowsAcl(target, sid, { directory = false } = {}) {
  const grant = directory ? `*${sid}:(OI)(CI)F` : `*${sid}:F`;
  await run('icacls', [target, '/inheritance:r', '/grant:r', grant]);
  const listing = await run('icacls', [target]);
  // `icacls <path>` prints "<path> <ACE>" then one indented ACE per line, a blank line, and a
  // (localized) summary. ACEs are "<account>:(<flags>)...".
  const aces = listing.split(/\r?\n/)
    .map((line, i) => (i === 0 && line.startsWith(target) ? line.slice(target.length) : line).trim())
    .filter((line) => /^\S.*:\([A-Z,()]+/.test(line) && line.includes(':('));
  if (aces.length !== 1) throw new Error(`Unexpected ACL on ${path.basename(target)} (${aces.length} entries).`);
}

async function secureDir(dir, platform) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (platform === 'win32') {
    const sid = await currentUserSid();
    await restrictWindowsAcl(dir, sid, { directory: true });
    return sid;
  }
  fs.chmodSync(dir, 0o700);
  return null;
}

// Load the pairing secret, creating it (and locking the directory down) if needed.
async function ensurePairing(userDataDir, { platform = process.platform } = {}) {
  const dir = integrationDir(userDataDir);
  const sid = await secureDir(dir, platform);
  const keyPath = path.join(dir, KEY_FILE);
  let secret = readSecret(keyPath);
  if (!secret) {
    secret = crypto.randomBytes(32);
    try { fs.unlinkSync(keyPath); } catch {}
    fs.writeFileSync(keyPath, secret.toString('hex'), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  }
  if (platform === 'win32') await restrictWindowsAcl(keyPath, sid);
  else fs.chmodSync(keyPath, 0o600);
  const endpoint = endpointFor(dir, platform);
  fs.writeFileSync(path.join(dir, ENDPOINT_FILE), JSON.stringify({ proto: PROTO, endpoint }, null, 2), { encoding: 'utf8', mode: 0o600 });
  return { dir, secret, endpoint };
}

function readSecret(keyPath) {
  try {
    const hex = fs.readFileSync(keyPath, 'utf8').trim();
    return /^[0-9a-f]{64}$/.test(hex) ? Buffer.from(hex, 'hex') : null;
  } catch {
    return null;
  }
}

// Forget the secret: every adapter must be paired again (new principal).
function resetPairing(userDataDir) {
  const dir = integrationDir(userDataDir);
  try { fs.unlinkSync(path.join(dir, KEY_FILE)); } catch {}
}

// Adapter side: read what main published. Returns null when the integration was never enabled.
function readPairing(dir) {
  const secret = readSecret(path.join(dir, KEY_FILE));
  if (!secret) return null;
  try {
    const info = JSON.parse(fs.readFileSync(path.join(dir, ENDPOINT_FILE), 'utf8'));
    if (!info || info.proto !== PROTO || typeof info.endpoint !== 'string') return null;
    return { secret, endpoint: info.endpoint };
  } catch {
    return null;
  }
}

module.exports = { integrationDir, endpointFor, ensurePairing, resetPairing, readPairing, currentUserSid, restrictWindowsAcl, KEY_FILE, ENDPOINT_FILE };
