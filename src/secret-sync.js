// Sharing a workspace's secrets between PCs through a synced folder (Google Drive for desktop,
// OneDrive, Dropbox…). The app never talks to a cloud API: it writes one encrypted file per shared
// name into a folder the user picked, and the desktop client of that service syncs it.
//
// The local store is encrypted with DPAPI, which only the same Windows user on the same PC can
// decrypt, so the shared file is encrypted separately with a key derived from a passphrase the
// user enters once on each PC (scrypt → AES-256-GCM, the share name bound in as associated data).
//
// Merging is per key, last write wins: every entry carries `updatedAt` (ms), a deletion is kept as
// a tombstone `{ key, deletedAt }` so it reaches the other PCs instead of being re-added from them.
//
// Pure Node (no Electron) so it can be unit-tested.
const crypto = require('crypto');
const fs = require('fs');
const { isValidKey } = require('./secret-keys');

const FORMAT = 'wsl-workbench-secrets';
const VERSION = 1;
const FILE_EXT = '.wbsecrets';
const SCRYPT = { N: 1 << 15, r: 8, p: 1 };
const SCRYPT_MAXMEM = 128 * 1024 * 1024;
const TOMBSTONE_TTL_MS = 180 * 24 * 60 * 60 * 1000; // a PC away longer than this may re-add a deleted key
const MIN_PASSPHRASE = 8;

class SyncError extends Error {
  constructor(code) { super(code); this.code = code; }
}

// A share name is also the file name, so the key rules apply (letters, digits, . _ -).
const isValidShareName = (name) => isValidKey(name);
const shareFileName = (name) => `${name}${FILE_EXT}`;

// Derived keys are cached per (passphrase, salt): scrypt is deliberately slow, and the same file is
// read and rewritten on every sync.
const keyCache = new Map();
function deriveKey(passphrase, salt, params = SCRYPT) {
  const id = crypto.createHash('sha256').update(passphrase).update('\0').update(salt).update(`\0${params.N}/${params.r}/${params.p}`).digest('hex');
  let key = keyCache.get(id);
  if (!key) {
    key = crypto.scryptSync(passphrase, salt, 32, { N: params.N, r: params.r, p: params.p, maxmem: SCRYPT_MAXMEM });
    if (keyCache.size > 16) keyCache.clear();
    keyCache.set(id, key);
  }
  return key;
}

// payload: { items: [{ key, value, updatedAt }], tombstones: [{ key, deletedAt }] }.
// `salt` (base64) reuses the existing file's salt so the cached key applies; a new one otherwise.
function encryptBundle(passphrase, name, payload, salt = null) {
  const saltBuf = salt ? Buffer.from(salt, 'base64') : crypto.randomBytes(16);
  const key = deriveKey(passphrase, saltBuf);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`${FORMAT}/${VERSION}/${name}`, 'utf8'));
  const data = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return JSON.stringify({
    format: FORMAT,
    v: VERSION,
    kdf: { name: 'scrypt', N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: saltBuf.toString('base64') },
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64')
  }, null, 2);
}

// → { payload, salt }. Throws SyncError 'bad-format' (not our file / a newer version) or
// 'bad-passphrase' (authentication failed: wrong passphrase, or the file was altered).
function decryptBundle(passphrase, name, text) {
  let doc;
  try { doc = JSON.parse(text); } catch { throw new SyncError('bad-format'); }
  if (!doc || doc.format !== FORMAT || !doc.kdf || doc.kdf.name !== 'scrypt') throw new SyncError('bad-format');
  if (doc.v !== VERSION) throw new SyncError('newer-format');
  const { N, r, p, salt } = doc.kdf;
  // Bounded so a crafted file can't make scrypt eat all memory/CPU.
  if (![N, r, p].every(Number.isInteger) || N < 1024 || N > (1 << 20) || (N & (N - 1)) || r < 1 || r > 32 || p < 1 || p > 16) throw new SyncError('bad-format');
  let plain;
  try {
    const key = deriveKey(passphrase, Buffer.from(String(salt), 'base64'), { N, r, p });
    // A full 16-byte tag only: a shortened one would weaken the authentication of an altered file.
    const tag = Buffer.from(String(doc.tag), 'base64');
    if (tag.length !== 16) throw new SyncError('bad-format');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(String(doc.iv), 'base64'), { authTagLength: 16 });
    decipher.setAAD(Buffer.from(`${FORMAT}/${VERSION}/${name}`, 'utf8'));
    decipher.setAuthTag(tag);
    plain = Buffer.concat([decipher.update(Buffer.from(String(doc.data), 'base64')), decipher.final()]).toString('utf8');
  } catch (e) {
    if (e instanceof SyncError) throw e;
    throw new SyncError('bad-passphrase');
  }
  let payload;
  try { payload = JSON.parse(plain); } catch { throw new SyncError('bad-format'); }
  return { payload: normalizePayload(payload), salt: String(salt) };
}

const ts = (n) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

function normalizePayload(p) {
  const items = [];
  const tombstones = [];
  for (const i of (p && Array.isArray(p.items) ? p.items : [])) {
    if (i && isValidKey(i.key) && typeof i.value === 'string') items.push({ key: i.key, value: i.value, updatedAt: ts(i.updatedAt) });
  }
  for (const d of (p && Array.isArray(p.tombstones) ? p.tombstones : [])) {
    if (d && isValidKey(d.key)) tombstones.push({ key: d.key, deletedAt: ts(d.deletedAt) });
  }
  return { items, tombstones };
}

// Last write wins per key. On a tie a live value beats a deletion, and between two values the
// larger one wins, so every PC reaches the same result whichever side it merges from.
function mergePayloads(a, b, now = Date.now()) {
  const best = new Map(); // key -> { at, value } | { at, deleted: true }
  const offer = (key, cand) => {
    const cur = best.get(key);
    if (!cur || cand.at > cur.at) { best.set(key, cand); return; }
    if (cand.at < cur.at) return;
    if (cur.deleted && !cand.deleted) best.set(key, cand);
    else if (!cur.deleted && !cand.deleted && cand.value > cur.value) best.set(key, cand);
  };
  for (const p of [a, b]) {
    const n = normalizePayload(p);
    for (const i of n.items) offer(i.key, { at: i.updatedAt, value: i.value });
    for (const d of n.tombstones) offer(d.key, { at: d.deletedAt, deleted: true });
  }
  const items = [];
  const tombstones = [];
  for (const [key, e] of [...best.entries()].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))) {
    if (!e.deleted) items.push({ key, value: e.value, updatedAt: e.at });
    else if (now - e.at < TOMBSTONE_TTL_MS) tombstones.push({ key, deletedAt: e.at });
  }
  return { items, tombstones };
}

// Whether two payloads hold the same entries (so an unchanged file isn't rewritten — a rewrite
// would make every other PC's sync client download it again, and invite edit conflicts).
function samePayload(a, b) {
  // now = -Infinity: no tombstone counts as expired, so only real differences are compared.
  const s = (p) => JSON.stringify(mergePayloads(p, { items: [], tombstones: [] }, -Infinity));
  return s(a) === s(b);
}

// One sync of a workspace with its shared file: read + decrypt the file (absent = empty), merge
// with the local entries, apply the result locally, and rewrite the file only when it differs.
// store: a SecretStore. → { ok: true, changed, removed } | { ok: false, error }. Never throws.
// Nothing local changes unless the file was readable with this passphrase.
function syncWorkspaceFile({ store, ws, file, name, passphrase }) {
  let raw = null;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (!e || e.code !== 'ENOENT') return { ok: false, error: 'read-failed' };
  }
  let remote = { items: [], tombstones: [] };
  let salt = null;
  try {
    if (raw != null) ({ payload: remote, salt } = decryptBundle(passphrase, name, raw));
  } catch (e) {
    return { ok: false, error: e.code || 'bad-format' };
  }
  let merged;
  let applied;
  try {
    merged = mergePayloads(store.exportPlain(ws), remote);
    applied = store.applyMerged(ws, merged);
  } catch {
    return { ok: false, error: 'decrypt' };
  }
  if (raw == null || !samePayload(merged, remote)) {
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, encryptBundle(passphrase, name, merged, salt), 'utf8');
      fs.renameSync(tmp, file);
    } catch {
      try { fs.unlinkSync(tmp); } catch {}
      return { ok: false, error: 'write-failed', changed: applied.changed, removed: applied.removed };
    }
  }
  return { ok: true, changed: applied.changed, removed: applied.removed };
}

module.exports = {
  SyncError,
  syncWorkspaceFile,
  encryptBundle,
  decryptBundle,
  mergePayloads,
  samePayload,
  normalizePayload,
  isValidShareName,
  shareFileName,
  FILE_EXT,
  MIN_PASSPHRASE,
  TOMBSTONE_TTL_MS
};
