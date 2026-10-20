const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { agentRemoteCommand, RemoteAgent } = require('../src/remote-workspace');
const remoteFs = require('../src/remote-fs');

let agent;
let root;
let local;
before(() => {
  agent = new RemoteAgent(() => spawn('bash', ['-c', agentRemoteCommand()]));
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wb-rfs-')));
  local = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-rfs-src-'));
});
after(() => {
  agent.dispose();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(local, { recursive: true, force: true });
});

test('tree: dirs first, hidden .git* and Zone.Identifier files dropped; signature format', async () => {
  fs.mkdirSync(path.join(root, 'b-dir'));
  fs.mkdirSync(path.join(root, '.git'));
  fs.writeFileSync(path.join(root, 'a.txt'), 'x');
  fs.writeFileSync(path.join(root, 'a.txt:Zone.Identifier'), '');
  const tree = await remoteFs.readDirTree(agent, root);
  assert.equal(tree.path, root);
  assert.deepEqual(tree.children.map((c) => [c.name, c.type, c.path]), [
    ['b-dir', 'directory', `${root}/b-dir`],
    ['a.txt', 'file', `${root}/a.txt`]
  ]);
  await assert.rejects(remoteFs.readDirTree(agent, `${root}/missing`), /Path not found/);
  const sig = await remoteFs.treeSignature(agent, [root, `${root}/missing`]);
  assert.equal(sig, `${root}|d:b-dir,f:a.txt\n${root}/missing|MISSING`);
});

test('text read/write/stat mirror the local handlers', async () => {
  const f = `${root}/t.md`;
  fs.writeFileSync(f, 'héllo');
  assert.deepEqual(await remoteFs.readText(agent, f, false), { text: 'héllo', unsupported: false, tooLarge: false });
  const w = await remoteFs.writeText(agent, f, 'new ✓');
  assert.equal(fs.readFileSync(f, 'utf8'), 'new ✓');
  assert.deepEqual(await remoteFs.statFile(agent, f), { mtimeMs: w.mtimeMs, size: w.size });
  await assert.rejects(remoteFs.writeText(agent, `${root}/nope.md`, 'x'), /File not found/);
  assert.equal(await remoteFs.statFile(agent, `${root}/b-dir`), null);
  fs.writeFileSync(`${root}/bin`, Buffer.from([0, 1, 2, 0xff]));
  assert.equal((await remoteFs.readText(agent, `${root}/bin`, false)).unsupported, true);
  fs.writeFileSync(`${root}/big`, Buffer.alloc(1024 * 1024 + 1, 'a'));
  assert.equal((await remoteFs.readText(agent, `${root}/big`, false)).tooLarge, true);
  assert.equal(await remoteFs.readDataUrl(agent, f, 100, 'text/plain', 'too big'), `data:text/plain;base64,${Buffer.from('new ✓').toString('base64')}`);
  await assert.rejects(remoteFs.readDataUrl(agent, `${root}/big`, 10, 'x', 'too big'), /too big/);
  await assert.rejects(remoteFs.readDataUrl(agent, `${root}/zz`, 10, 'x', 'too big'), /File not found/);
});

test('create / rename / move / delete with the local validation rules', async () => {
  await remoteFs.create(agent, root, 'n.txt', 'file');
  await remoteFs.create(agent, root, 'd2', 'directory');
  await assert.rejects(remoteFs.create(agent, root, 'n.txt', 'file'), /Already exists/);
  await assert.rejects(remoteFs.create(agent, root, '../x', 'file'), /Invalid name/);
  const r = await remoteFs.rename(agent, `${root}/n.txt`, 'm.txt');
  assert.equal(r.path, `${root}/m.txt`);
  await assert.rejects(remoteFs.rename(agent, `${root}/m.txt`, 'd2'), /Already exists/);
  await remoteFs.move(agent, `${root}/m.txt`, `${root}/d2`);
  assert.ok(fs.existsSync(`${root}/d2/m.txt`));
  await assert.rejects(remoteFs.move(agent, `${root}/d2`, `${root}/d2/sub`), /into itself/);
  await assert.rejects(remoteFs.move(agent, `${root}/gone`, root), /Source not found/);
  await remoteFs.remove(agent, `${root}/d2`);
  assert.ok(!fs.existsSync(`${root}/d2`));
  await assert.rejects(remoteFs.remove(agent, `${root}/d2`), /Target not found/);
});

test('delete removes a symlink, not what it points to', async () => {
  fs.mkdirSync(`${root}/keep`);
  fs.writeFileSync(`${root}/keep/f`, 'x');
  fs.symlinkSync(`${root}/keep`, `${root}/link`);
  await remoteFs.remove(agent, `${root}/link`);
  assert.ok(fs.existsSync(`${root}/keep/f`));
});

test('saveImage picks the next free name', async () => {
  const png = Buffer.from('PNG');
  const a = await remoteFs.saveImage(agent, root, png, 'pasted');
  const b = await remoteFs.saveImage(agent, root, png, 'pasted');
  assert.equal(a.name, 'pasted.png');
  assert.equal(b.name, 'pasted-1.png');
  await assert.rejects(remoteFs.saveImage(agent, `${root}/nodir`, png, 'p'), /Target directory not found/);
});

test('copyExternal uploads files and folders, never overwrites, honours skip rules', async () => {
  fs.mkdirSync(path.join(local, 'pkg'));
  fs.writeFileSync(path.join(local, 'pkg', 'x.bin'), Buffer.from([1, 2, 3]));
  fs.writeFileSync(path.join(local, 'NTUSER.DAT'), 'x');
  fs.mkdirSync(`${root}/dst`);
  fs.writeFileSync(`${root}/dst/exists.txt`, 'keep');
  fs.writeFileSync(path.join(local, 'exists.txt'), 'new');
  const res = await remoteFs.copyExternal(agent,
    [path.join(local, 'pkg'), path.join(local, 'NTUSER.DAT'), path.join(local, 'exists.txt'), path.join(local, 'a:Zone.Identifier')],
    `${root}/dst`,
    { shouldSkip: (p) => path.basename(p) === 'NTUSER.DAT', isAds: (p) => p.endsWith(':Zone.Identifier') });
  assert.deepEqual(fs.readFileSync(`${root}/dst/pkg/x.bin`), Buffer.from([1, 2, 3]));
  assert.equal(fs.readFileSync(`${root}/dst/exists.txt`, 'utf8'), 'keep');
  assert.deepEqual(res.skipped.map((s) => s.reason), ['system profile file', 'destination exists']);
  await assert.rejects(remoteFs.copyExternal(agent, [path.join(local, 'exists.txt')], `${root}/dst`), /No files were copied/);
});

test('gitInfo runs the script in the workspace and parses it; non-repo is null', async () => {
  const repo = `${root}/repo`;
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  fs.writeFileSync(`${repo}/new.txt`, 'x');
  const script = 'b=$(git branch --show-current); echo "$b"; git rev-parse --show-toplevel; echo; git status --porcelain';
  const info = await remoteFs.gitInfo(agent, repo, script);
  assert.equal(info.branch, 'main');
  assert.equal(info.dirty, true);
  assert.equal(await remoteFs.gitInfo(agent, `${root}/missing`, script), null);
});
