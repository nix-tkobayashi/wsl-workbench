// Per-workspace secrets (key = file name, value = file contents). Values are stored encrypted by
// the OS (Electron safeStorage → DPAPI on Windows) under the app's userData — never inside the
// workspace, so nothing can be committed by mistake. A CLI in the terminal reads a secret through
// a plaintext copy the app writes into WSL tmpfs (/run/user/<uid>/wb-secrets/<workspace>/<key>,
// 0600 in a 0700 dir) on request; those copies are removed when the app quits.
//
// Kept free of Electron so it can be unit-tested: encryption and the wsl.exe runner are injected.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { isValidKey } = require('./secret-keys');

const MAX_VALUE_BYTES = 1024 * 1024;

function workspaceId(ws) {
  return crypto.createHash('sha256').update(`${ws.distro}:${ws.wslPath}`).digest('hex').slice(0, 16);
}

// Directory name of a workspace's copies in WSL: readable (the folder name) plus a hash so two
// workspaces with the same folder name never share files. Fixed for a workspace, so a path handed
// to a CLI before an app restart still works after it (the copy is re-created on open).
function workspaceSlug(ws) {
  const base = String(ws.wslPath || '').split('/').filter(Boolean).pop() || 'root';
  const clean = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_').slice(0, 40) || 'root';
  return `${clean}-${workspaceId(ws)}`;
}

class SecretStore {
  // dir: where the encrypted store files live. encrypt(string) → Buffer, decrypt(Buffer) → string,
  // available() → whether OS encryption can be used (without it nothing is saved).
  constructor({ dir, encrypt, decrypt, available }) {
    this.dir = dir;
    this.encrypt = encrypt;
    this.decrypt = decrypt;
    this.available = available;
  }

  file(ws) { return path.join(this.dir, `${workspaceId(ws)}.json`); }

  load(ws) {
    try {
      const data = JSON.parse(fs.readFileSync(this.file(ws), 'utf8'));
      return { workspace: { distro: ws.distro, wslPath: ws.wslPath }, items: Array.isArray(data.items) ? data.items.filter((i) => i && isValidKey(i.key) && typeof i.value === 'string') : [] };
    } catch {
      return { workspace: { distro: ws.distro, wslPath: ws.wslPath }, items: [] };
    }
  }

  save(ws, data) {
    fs.mkdirSync(this.dir, { recursive: true });
    const target = this.file(ws);
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, target);
  }

  list(ws) {
    return this.load(ws).items.map((i) => ({ key: i.key, materialized: !!i.materialized }));
  }

  has(ws, key) { return this.load(ws).items.some((i) => i.key === key); }

  get(ws, key) {
    const item = this.load(ws).items.find((i) => i.key === key);
    if (!item) return null;
    return this.decrypt(Buffer.from(item.value, 'base64'));
  }

  // Add or update. `previousKey` renames an existing entry (keeping its materialized flag).
  // Returns { ok, error?, renamedFrom?, materialized? }.
  // Whether set() would accept this update: { ok } or { ok: false, error }.
  validate(ws, { key, value, previousKey = null }) {
    if (!this.available()) return { ok: false, error: 'unavailable' };
    if (!isValidKey(key)) return { ok: false, error: 'invalid-key' };
    if (typeof value !== 'string') return { ok: false, error: 'invalid-value' };
    if (Buffer.byteLength(value, 'utf8') > MAX_VALUE_BYTES) return { ok: false, error: 'too-large' };
    const keys = this.load(ws).items.map((i) => i.key);
    if (previousKey && !keys.includes(previousKey)) return { ok: false, error: 'not-found' };
    if ((!previousKey || previousKey !== key) && keys.includes(key)) return { ok: false, error: 'duplicate' };
    return { ok: true };
  }

  set(ws, { key, value, previousKey = null }) {
    const check = this.validate(ws, { key, value, previousKey });
    if (!check.ok) return check;
    const data = this.load(ws);
    const fromKey = previousKey && previousKey !== key ? previousKey : null;
    const enc = this.encrypt(value).toString('base64');
    const idx = data.items.findIndex((i) => i.key === (previousKey || key));
    let materialized = false;
    if (idx >= 0) {
      materialized = !!data.items[idx].materialized;
      data.items[idx] = { key, value: enc, materialized };
    } else {
      data.items.push({ key, value: enc, materialized: false });
    }
    this.save(ws, data);
    return { ok: true, renamedFrom: fromKey, materialized };
  }

  remove(ws, key) {
    const data = this.load(ws);
    const before = data.items.length;
    data.items = data.items.filter((i) => i.key !== key);
    if (data.items.length !== before) this.save(ws, data);
    return data.items.length !== before;
  }

  setMaterialized(ws, key, on) {
    const data = this.load(ws);
    const item = data.items.find((i) => i.key === key);
    if (!item || !!item.materialized === on) return;
    item.materialized = on;
    this.save(ws, data);
  }
}

// --- WSL side: the plaintext copies. One bash script per operation, run as
// `wsl.exe -d <distro> --exec bash -c <script> bash <slug> <key>`; slug and key are validated
// above, and passed as positional args (never interpolated into the script). ---

// Prefer the per-user runtime dir (tmpfs, systemd); fall back to /dev/shm (tmpfs) when it's absent.
// Every directory we use must be owned by us, so a planted one is refused rather than written into.
const BASE_DIR =
  'uid=$(id -u); base=/run/user/$uid; ' +
  'if [ ! -d "$base" ] || [ ! -O "$base" ]; then base=/dev/shm/wslwb-$uid; fi; ' +
  'root="$base/wb-secrets"';

// Symlinks are refused at every level (-O follows them, so a planted link to a disk directory
// would otherwise pass), checked both before creating anything and after.
const NO_LINKS = '[ ! -L "$base" ] && [ ! -L "$root" ] && [ ! -L "$dir" ] || exit 5; ';
const MATERIALIZE_SCRIPT =
  `set -e; umask 077; ${BASE_DIR}; dir="$root/$1"; ` +
  NO_LINKS +
  'mkdir -p "$dir"; ' +
  NO_LINKS +
  '[ -O "$base" ] && [ -O "$root" ] && [ -O "$dir" ] || exit 5; ' +
  'chmod 700 "$base" "$root" "$dir"; ' +
  'tmp=$(mktemp "$dir/.tmp.XXXXXX"); trap \'rm -f -- "$tmp"\' EXIT; ' +
  'cat > "$tmp"; mv -fT -- "$tmp" "$dir/$2"; ' +
  'printf "%s" "$dir/$2"';

const REMOVE_SCRIPT =
  `${BASE_DIR}; dir="$root/$1"; ${NO_LINKS}f="$dir/$2"; rm -f -- "$f"; [ ! -e "$f" ] || exit 6; ` +
  'rmdir -- "$root/$1" 2>/dev/null; exit 0';
const REMOVE_ALL_SCRIPT = `${BASE_DIR}; [ ! -L "$base" ] && [ ! -L "$root" ] || exit 5; rm -rf -- "$root"; exit 0`;

function materializeArgs(distro, slug, key) {
  return ['-d', distro, '--exec', 'bash', '-c', MATERIALIZE_SCRIPT, 'bash', slug, key];
}
function removeArgs(distro, slug, key) {
  return ['-d', distro, '--exec', 'bash', '-c', REMOVE_SCRIPT, 'bash', slug, key];
}
function removeAllArgs(distro) {
  return ['-d', distro, '--exec', 'bash', '-c', REMOVE_ALL_SCRIPT];
}

// The path printed by MATERIALIZE_SCRIPT, or null when the output isn't one of our paths.
function parseMaterializedPath(stdout, slug, key) {
  const p = String(stdout || '').trim();
  const suffix = `/wb-secrets/${slug}/${key}`;
  return p.startsWith('/') && p.endsWith(suffix) && !/[\x00-\x1f\x7f]/.test(p) ? p : null;
}

// Files in a workspace's legacy `.credentials/` directory that can be imported: regular files with a
// valid key name and a size within the value limit. `entries` are { name, isFile, size }.
function importableEntries(entries, existingKeys = []) {
  const taken = new Set(existingKeys);
  return entries
    .filter((e) => e && e.isFile && isValidKey(e.name) && e.size <= MAX_VALUE_BYTES && !taken.has(e.name))
    .map((e) => e.name)
    .sort();
}

module.exports = {
  SecretStore,
  isValidKey,
  workspaceId,
  workspaceSlug,
  materializeArgs,
  removeArgs,
  removeAllArgs,
  parseMaterializedPath,
  importableEntries,
  MAX_VALUE_BYTES,
  MATERIALIZE_SCRIPT,
  REMOVE_SCRIPT,
  REMOVE_ALL_SCRIPT
};
