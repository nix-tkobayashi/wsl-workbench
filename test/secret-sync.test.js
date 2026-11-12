const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sync = require('../src/secret-sync');
const { SecretStore } = require('../src/secrets');

// Each "PC" has its own stand-in for DPAPI (a different XOR byte), so one PC's local store can't be
// read by the other — only the shared file carries values across.
function makePc(xor, wslPath) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-sync-pc-'));
  const store = new SecretStore({
    dir,
    encrypt: (s) => Buffer.from(Buffer.from(s, 'utf8').map((b) => b ^ xor)),
    decrypt: (b) => Buffer.from(b.map((x) => x ^ xor)).toString('utf8'),
    available: () => true
  });
  return { store, ws: { distro: 'Ubuntu', wslPath } };
}
const PASS = 'correct horse battery';

function setup() {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-sync-drive-'));
  const name = 'demo';
  const file = path.join(folder, sync.shareFileName(name));
  // Different paths on purpose: the share name, not the path, links the two workspaces.
  const a = makePc(0x11, '/home/a/projects/demo');
  const b = makePc(0x22, '/home/b/work/demo-checkout');
  const run = (pc, passphrase = PASS) => sync.syncWorkspaceFile({ store: pc.store, ws: pc.ws, file, name, passphrase });
  return { folder, file, name, a, b, run };
}

test('bundle: round-trips, hides plaintext, binds the share name', () => {
  const payload = { items: [{ key: 'aws', value: 'SECRETVALUE', updatedAt: 5 }], tombstones: [] };
  const text = sync.encryptBundle(PASS, 'demo', payload);
  assert.ok(!text.includes('SECRETVALUE'));
  assert.deepEqual(sync.decryptBundle(PASS, 'demo', text).payload, payload);
  assert.throws(() => sync.decryptBundle('wrong passphrase', 'demo', text), { code: 'bad-passphrase' });
  assert.throws(() => sync.decryptBundle(PASS, 'other', text), { code: 'bad-passphrase' }, 'a file renamed to another share is refused');
  assert.throws(() => sync.decryptBundle(PASS, 'demo', '{"hello":1}'), { code: 'bad-format' });
  const doc = JSON.parse(text);
  assert.throws(() => sync.decryptBundle(PASS, 'demo', JSON.stringify({ ...doc, v: 2 })), { code: 'newer-format' });
  assert.throws(() => sync.decryptBundle(PASS, 'demo', JSON.stringify({ ...doc, kdf: { ...doc.kdf, N: 1 << 30 } })), { code: 'bad-format' }, 'scrypt cost is bounded');
});

test('merge: last write wins per key, deletions travel as tombstones', () => {
  const a = { items: [{ key: 'x', value: 'old', updatedAt: 1 }, { key: 'y', value: 'keep', updatedAt: 1 }], tombstones: [] };
  const b = { items: [{ key: 'x', value: 'new', updatedAt: 2 }], tombstones: [{ key: 'y', deletedAt: 3 }] };
  const now = 10;
  const m = sync.mergePayloads(a, b, now);
  assert.deepEqual(m, { items: [{ key: 'x', value: 'new', updatedAt: 2 }], tombstones: [{ key: 'y', deletedAt: 3 }] });
  assert.deepEqual(sync.mergePayloads(b, a, now), m, 'order-independent');
  // A re-add after the deletion wins.
  const re = sync.mergePayloads(m, { items: [{ key: 'y', value: 'again', updatedAt: 4 }], tombstones: [] }, now);
  assert.deepEqual(re.items.map((i) => i.key), ['x', 'y']);
  assert.deepEqual(re.tombstones, []);
  // Ties resolve the same way from both sides.
  const t1 = { items: [{ key: 'k', value: 'aaa', updatedAt: 7 }], tombstones: [] };
  const t2 = { items: [{ key: 'k', value: 'bbb', updatedAt: 7 }], tombstones: [] };
  assert.deepEqual(sync.mergePayloads(t1, t2, now), sync.mergePayloads(t2, t1, now));
  // Old tombstones expire.
  assert.deepEqual(sync.mergePayloads({ tombstones: [{ key: 'z', deletedAt: 1 }] }, {}, 1 + sync.TOMBSTONE_TTL_MS).tombstones, []);
});

test('two PCs: values, edits, renames and deletions reach the other PC', () => {
  const { file, a, b, run } = setup();
  const T = Date.now(); // real times: a tombstone older than TOMBSTONE_TTL_MS would be dropped
  a.store.set(a.ws, { key: 'aws', value: 'from-a' }, T + 1000);
  assert.deepEqual(run(a), { ok: true, changed: [], removed: [] });
  assert.ok(fs.existsSync(file));
  assert.ok(!fs.readFileSync(file, 'utf8').includes('from-a'), 'shared file is encrypted');

  b.store.set(b.ws, { key: 'github', value: 'from-b' }, T + 1500);
  assert.deepEqual(run(b).changed, ['aws']);
  assert.equal(b.store.get(b.ws, 'aws'), 'from-a');
  run(a);
  assert.equal(a.store.get(a.ws, 'github'), 'from-b');

  // Edit on B, rename on A: both land on both sides.
  b.store.set(b.ws, { key: 'aws', value: 'rotated', previousKey: 'aws' }, T + 2000);
  run(b);
  a.store.set(a.ws, { key: 'gh', value: 'from-b', previousKey: 'github' }, T + 2100);
  run(a);
  run(b);
  for (const pc of [a, b]) {
    assert.deepEqual(pc.store.list(pc.ws).map((i) => i.key).sort(), ['aws', 'gh']);
    assert.equal(pc.store.get(pc.ws, 'aws'), 'rotated');
  }

  // Delete on B: A drops it (and is told whether its copy was handed out).
  a.store.setMaterialized(a.ws, 'gh', true);
  b.store.remove(b.ws, 'gh', T + 3000);
  run(b);
  const res = run(a);
  assert.deepEqual(res.removed, [{ key: 'gh', materialized: true }]);
  assert.equal(a.store.has(a.ws, 'gh'), false);
});

test('sync: materialized flags stay local and an unchanged file is not rewritten', () => {
  const { file, a, b, run } = setup();
  a.store.set(a.ws, { key: 'aws', value: 'v' }, 1000);
  a.store.setMaterialized(a.ws, 'aws', true);
  run(a);
  run(b);
  assert.deepEqual(b.store.list(b.ws), [{ key: 'aws', materialized: false }]);
  const before = fs.readFileSync(file, 'utf8');
  run(a);
  run(b);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.deepEqual(a.store.list(a.ws), [{ key: 'aws', materialized: true }]);
});

test('sync: a wrong passphrase or foreign file changes nothing locally', () => {
  const { file, a, b, run } = setup();
  a.store.set(a.ws, { key: 'aws', value: 'v' }, 1000);
  run(a);
  const shared = fs.readFileSync(file, 'utf8');
  b.store.set(b.ws, { key: 'local', value: 'only-b' }, 900);
  assert.deepEqual(run(b, 'not the passphrase'), { ok: false, error: 'bad-passphrase' });
  assert.deepEqual(b.store.list(b.ws).map((i) => i.key), ['local']);
  assert.equal(fs.readFileSync(file, 'utf8'), shared, 'the shared file is left alone');
  fs.writeFileSync(file, 'garbage');
  assert.deepEqual(run(b), { ok: false, error: 'bad-format' });
});

test('store: share name and tombstones survive reload; legacy entries sync as oldest', () => {
  const { a } = setup();
  a.store.setShareName(a.ws, 'demo');
  a.store.set(a.ws, { key: 'k', value: 'v' }, 5);
  a.store.remove(a.ws, 'k', 6);
  assert.equal(a.store.shareName(a.ws), 'demo');
  assert.deepEqual(a.store.exportPlain(a.ws), { items: [], tombstones: [{ key: 'k', deletedAt: 6 }] });
  // An entry saved before this version has no updatedAt: it counts as 0 and loses to any edit.
  const file = a.store.file(a.ws);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.items.push({ key: 'legacy', value: a.store.encrypt('x').toString('base64'), materialized: false });
  fs.writeFileSync(file, JSON.stringify(data));
  assert.deepEqual(a.store.exportPlain(a.ws).items, [{ key: 'legacy', value: 'x', updatedAt: 0 }]);
  a.store.setShareName(a.ws, null);
  assert.equal(a.store.shareName(a.ws), null);
});

test('bundle: a shortened GCM tag is refused', () => {
  const doc = JSON.parse(sync.encryptBundle(PASS, 'demo', { items: [], tombstones: [] }));
  doc.tag = Buffer.from(doc.tag, 'base64').subarray(0, 4).toString('base64');
  assert.throws(() => sync.decryptBundle(PASS, 'demo', JSON.stringify(doc)), { code: 'bad-format' });
});

test('store: a handed-out copy of a key deleted elsewhere stays pending until removed', () => {
  const { a, b, run } = setup();
  const T = Date.now();
  a.store.set(a.ws, { key: 'aws', value: 'v' }, T);
  run(a);
  run(b);
  b.store.setMaterialized(b.ws, 'aws', true);
  a.store.remove(a.ws, 'aws', T + 1);
  run(a);
  run(b);
  assert.deepEqual(b.store.pendingRemovals(b.ws), ['aws'], 'persisted in the store file');
  // Re-added elsewhere before the copy was removed: the copy is taken over and rewritten.
  a.store.set(a.ws, { key: 'aws', value: 'new' }, T + 2);
  run(a);
  assert.deepEqual(run(b).changed, ['aws']);
  assert.deepEqual(b.store.list(b.ws), [{ key: 'aws', materialized: true }]);
  assert.deepEqual(b.store.pendingRemovals(b.ws), []);
  // Same when the key is re-added on this PC.
  b.store.setMaterialized(b.ws, 'aws', true);
  a.store.remove(a.ws, 'aws', T + 3);
  run(a);
  run(b);
  assert.deepEqual(b.store.pendingRemovals(b.ws), ['aws']);
  assert.equal(b.store.set(b.ws, { key: 'aws', value: 'local' }, T + 4).materialized, true);
  assert.deepEqual(b.store.pendingRemovals(b.ws), []);
  // And when another (not handed-out) key is renamed onto it.
  run(b);
  run(a); // A has B's re-added key again before deleting it
  b.store.setMaterialized(b.ws, 'aws', true);
  a.store.set(a.ws, { key: 'other', value: 'o' }, T + 5);
  a.store.remove(a.ws, 'aws', T + 6);
  run(a);
  run(b);
  assert.deepEqual(b.store.pendingRemovals(b.ws), ['aws']);
  assert.equal(b.store.set(b.ws, { key: 'aws', value: 'o', previousKey: 'other' }, T + 7).materialized, true);
});
