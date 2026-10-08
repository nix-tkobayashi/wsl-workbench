const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const secrets = require('../src/secrets');
const { isValidKey } = require('../src/secret-keys');

// Reversible stand-in for safeStorage, so the tests can check that nothing is stored in plaintext.
const fakeCrypto = {
  encrypt: (s) => Buffer.from(Buffer.from(s, 'utf8').map((b) => b ^ 0x5a)),
  decrypt: (b) => Buffer.from(b.map((x) => x ^ 0x5a)).toString('utf8'),
  available: () => true
};
function makeStore(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-secrets-test-'));
  return { dir, store: new secrets.SecretStore({ dir, ...fakeCrypto, ...overrides }) };
}
const WS = { distro: 'Ubuntu', wslPath: '/home/u/projects/demo' };

test('key rules: file-name safe characters only', () => {
  for (const ok of ['aws', 'github', 'aws.prod', 'my_key-1', 'A'.repeat(64)]) assert.ok(isValidKey(ok), ok);
  for (const bad of ['', '.', '..', 'a/b', 'a b', '../x', 'A'.repeat(65), 'キー', 'a\nb', null, 42]) assert.ok(!isValidKey(bad), String(bad));
});

test('store: values are encrypted at rest and round-trip', () => {
  const { dir, store } = makeStore();
  const value = '[default]\naws_access_key_id=AKIAEXAMPLE\naws_secret_access_key=SECRETVALUE\n';
  assert.deepEqual(store.set(WS, { key: 'aws', value }), { ok: true, renamedFrom: null, materialized: false });
  const raw = fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), 'utf8');
  assert.ok(!raw.includes('SECRETVALUE') && !raw.includes('AKIAEXAMPLE'), 'no plaintext on disk');
  assert.equal(store.get(WS, 'aws'), value);
  assert.deepEqual(store.list(WS), [{ key: 'aws', materialized: false }]);
});

test('store: workspaces are isolated', () => {
  const { store } = makeStore();
  store.set(WS, { key: 'aws', value: 'one' });
  const other = { distro: 'Ubuntu', wslPath: '/home/u/projects/other' };
  assert.deepEqual(store.list(other), []);
  assert.equal(store.get(other, 'aws'), null);
  assert.deepEqual(store.list({ distro: 'Ubuntu-22.04', wslPath: WS.wslPath }), []);
});

test('store: rejects invalid keys, duplicates, oversize values, and saves nothing without OS encryption', () => {
  const { store } = makeStore();
  assert.equal(store.set(WS, { key: '../x', value: 'v' }).error, 'invalid-key');
  store.set(WS, { key: 'aws', value: 'v' });
  assert.equal(store.set(WS, { key: 'aws', value: 'v2' }).error, 'duplicate');
  assert.equal(store.set(WS, { key: 'big', value: 'x'.repeat(secrets.MAX_VALUE_BYTES + 1) }).error, 'too-large');
  const { store: noOs } = makeStore({ available: () => false });
  assert.equal(noOs.set(WS, { key: 'aws', value: 'v' }).error, 'unavailable');
  assert.deepEqual(noOs.list(WS), []);
});

test('store: edit, rename (keeps the handed-out flag), and remove', () => {
  const { store } = makeStore();
  store.set(WS, { key: 'aws', value: 'v1' });
  store.set(WS, { key: 'gh', value: 'g' });
  store.setMaterialized(WS, 'aws', true);
  assert.deepEqual(store.set(WS, { key: 'aws', value: 'v2', previousKey: 'aws' }), { ok: true, renamedFrom: null, materialized: true });
  assert.equal(store.get(WS, 'aws'), 'v2');
  assert.equal(store.set(WS, { key: 'gh', value: 'x', previousKey: 'aws' }).error, 'duplicate');
  assert.deepEqual(store.set(WS, { key: 'aws-prod', value: 'v3', previousKey: 'aws' }), { ok: true, renamedFrom: 'aws', materialized: true });
  assert.deepEqual(store.list(WS), [{ key: 'aws-prod', materialized: true }, { key: 'gh', materialized: false }]);
  assert.ok(store.remove(WS, 'aws-prod'));
  assert.ok(!store.remove(WS, 'aws-prod'));
  assert.deepEqual(store.list(WS).map((i) => i.key), ['gh']);
});

test('store: validate() predicts set() without writing (used before removing a renamed copy)', () => {
  const { store } = makeStore();
  store.set(WS, { key: 'aws', value: 'v' });
  store.set(WS, { key: 'gh', value: 'g' });
  assert.deepEqual(store.validate(WS, { key: 'aws2', value: 'v', previousKey: 'aws' }), { ok: true });
  assert.equal(store.validate(WS, { key: 'gh', value: 'v', previousKey: 'aws' }).error, 'duplicate');
  assert.equal(store.validate(WS, { key: 'aws2', value: 'x'.repeat(secrets.MAX_VALUE_BYTES + 1), previousKey: 'aws' }).error, 'too-large');
  assert.equal(store.validate(WS, { key: 'new', value: 'v', previousKey: 'missing' }).error, 'not-found');
  assert.deepEqual(store.list(WS).map((i) => i.key), ['aws', 'gh'], 'validate writes nothing');
});

test('store: a corrupted store file reads as empty instead of throwing', () => {
  const { dir, store } = makeStore();
  fs.writeFileSync(path.join(dir, `${secrets.workspaceId(WS)}.json`), '{not json');
  assert.deepEqual(store.list(WS), []);
});

test('workspace slug: readable, fixed per workspace, distinct for same-named folders', () => {
  const a = secrets.workspaceSlug(WS);
  assert.match(a, /^demo-[0-9a-f]{16}$/);
  assert.equal(secrets.workspaceSlug({ ...WS }), a);
  assert.notEqual(secrets.workspaceSlug({ distro: 'Ubuntu', wslPath: '/srv/demo' }), a);
  assert.match(secrets.workspaceSlug({ distro: 'Ubuntu', wslPath: '/' }), /^root-[0-9a-f]{16}$/);
  assert.match(secrets.workspaceSlug({ distro: 'Ubuntu', wslPath: '/home/u/日本 語' }), /^[A-Za-z0-9._-]+-[0-9a-f]{16}$/);
  assert.match(secrets.workspaceSlug({ distro: 'Ubuntu', wslPath: '/home/u/..' }), /^_/);
});

test('wsl args pass slug and key as positional args, never inside the script', () => {
  const args = secrets.materializeArgs('Ubuntu', 'demo-1234abcd', 'aws');
  assert.deepEqual(args.slice(0, 5), ['-d', 'Ubuntu', '--exec', 'bash', '-c']);
  assert.deepEqual(args.slice(6), ['bash', 'demo-1234abcd', 'aws']);
  assert.ok(!args[5].includes('demo-1234abcd') && !args[5].includes('aws'));
});

test('parseMaterializedPath accepts only our own path', () => {
  assert.equal(secrets.parseMaterializedPath('/run/user/1000/wb-secrets/s-1/aws', 's-1', 'aws'), '/run/user/1000/wb-secrets/s-1/aws');
  assert.equal(secrets.parseMaterializedPath('noise\n', 's-1', 'aws'), null);
  assert.equal(secrets.parseMaterializedPath('/tmp/other/aws', 's-1', 'aws'), null);
  assert.equal(secrets.parseMaterializedPath('/run/user/1000/wb-secrets/s-1/aws\x1b[0m', 's-1', 'aws'), null);
});

test('importableEntries: regular files with valid names and sizes, not already registered', () => {
  const entries = [
    { name: 'aws', isFile: true, size: 100 },
    { name: 'github', isFile: true, size: 50 },
    { name: 'bad name', isFile: true, size: 5 },
    { name: 'huge', isFile: true, size: secrets.MAX_VALUE_BYTES + 1 },
    { name: 'dir', isFile: false, size: 0 }
  ];
  assert.deepEqual(secrets.importableEntries(entries, ['github']), ['aws']);
});

// The scripts are plain bash; run them here against a throwaway base dir to check the file modes
// and cleanup (only where bash and /dev/shm exist, i.e. Linux/WSL).
const canRunBash = process.platform === 'linux' && fs.existsSync('/dev/shm');
test('materialize/remove scripts write a 0600 copy in a 0700 dir and clean up', { skip: !canRunBash }, () => {
  const slug = `test-${process.pid}`;
  const run = (args, input = '') => execFileSync('bash', args.slice(4), { input }).toString();
  const out = run(secrets.materializeArgs('x', slug, 'aws'), 'line1\nline2\n');
  const p = secrets.parseMaterializedPath(out, slug, 'aws');
  assert.ok(p, `unexpected output: ${out}`);
  try {
    assert.equal(fs.readFileSync(p, 'utf8'), 'line1\nline2\n');
    assert.equal(fs.statSync(p).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(p)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.dirname(path.dirname(p))).mode & 0o777, 0o700);
    // Rewriting replaces the content (an edit follows into the copy).
    run(secrets.materializeArgs('x', slug, 'aws'), 'new');
    assert.equal(fs.readFileSync(p, 'utf8'), 'new');
    assert.deepEqual(fs.readdirSync(path.dirname(p)), ['aws'], 'no temp files left behind');
  } finally {
    run(secrets.removeArgs('x', slug, 'aws'));
  }
  assert.ok(!fs.existsSync(p));
  assert.ok(!fs.existsSync(path.dirname(p)), 'empty workspace dir removed');
});

test('materialize refuses a symlinked directory instead of following it', { skip: !canRunBash }, () => {
  const slug = `test-link-${process.pid}`;
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-secrets-target-'));
  const run = (args, input = '') => execFileSync('bash', args.slice(4), { input }).toString();
  // Find the root the scripts use, then plant <root>/<slug> as a link to a disk directory.
  const probe = secrets.parseMaterializedPath(run(secrets.materializeArgs('x', `${slug}-probe`, 'k'), 'x'), `${slug}-probe`, 'k');
  run(secrets.removeArgs('x', `${slug}-probe`, 'k'));
  const link = path.join(path.dirname(path.dirname(probe)), slug);
  fs.symlinkSync(target, link);
  try {
    assert.throws(() => run(secrets.materializeArgs('x', slug, 'aws'), 'secret'));
    assert.deepEqual(fs.readdirSync(target), [], 'nothing written through the link');
  } finally {
    fs.unlinkSync(link);
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test('remove refuses a symlinked directory instead of deleting through it', { skip: !canRunBash }, () => {
  const slug = `test-rmlink-${process.pid}`;
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-secrets-target-'));
  fs.writeFileSync(path.join(target, 'aws'), 'keep me');
  const run = (args, input = '') => execFileSync('bash', args.slice(4), { input }).toString();
  const probe = secrets.parseMaterializedPath(run(secrets.materializeArgs('x', `${slug}-probe`, 'k'), 'x'), `${slug}-probe`, 'k');
  run(secrets.removeArgs('x', `${slug}-probe`, 'k'));
  const link = path.join(path.dirname(path.dirname(probe)), slug);
  fs.symlinkSync(target, link);
  try {
    assert.throws(() => run(secrets.removeArgs('x', slug, 'aws')));
    assert.equal(fs.readFileSync(path.join(target, 'aws'), 'utf8'), 'keep me');
  } finally {
    fs.unlinkSync(link);
    fs.rmSync(target, { recursive: true, force: true });
  }
});
