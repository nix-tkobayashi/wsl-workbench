// The remote agent's secret-copy ops, run against a local python3 with a temp dir standing in for
// /run/user/<uid> (WB_SECRETS_BASE_TEST).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const hasPython = spawnSync('python3', ['--version']).status === 0;
const AGENT = path.join(__dirname, '..', 'src', 'remote-agent.py');

function startAgent(base) {
  const child = spawn('python3', ['-u', AGENT], { env: { ...process.env, WB_SECRETS_BASE_TEST: base } });
  const waiters = new Map();
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const msg = JSON.parse(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      const w = waiters.get(msg.id);
      if (w) { waiters.delete(msg.id); w(msg); }
    }
  });
  let seq = 0;
  const request = (op, args = {}) => new Promise((resolve) => {
    const id = ++seq;
    waiters.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ ...args, id, op })}\n`);
  });
  return { request, close: () => child.stdin.end() };
}

test('remote agent: secret_put / secret_remove / secret_remove_all', { skip: !hasPython }, async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-secrets-test-'));
  const agent = startAgent(base);
  try {
    const b64 = Buffer.from('s3cret\n', 'utf8').toString('base64');
    const put = await agent.request('secret_put', { slug: 'app-0123456789abcdef', key: 'aws', b64 });
    assert.equal(put.ok, true);
    assert.equal(put.result, path.join(base, 'wb-secrets', 'app-0123456789abcdef', 'aws'));
    assert.equal(fs.readFileSync(put.result, 'utf8'), 's3cret\n');
    assert.equal(fs.statSync(put.result).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(put.result)).mode & 0o777, 0o700);
    // Overwrite follows an edit.
    await agent.request('secret_put', { slug: 'app-0123456789abcdef', key: 'aws', b64: Buffer.from('v2').toString('base64') });
    assert.equal(fs.readFileSync(put.result, 'utf8'), 'v2');

    const bad = await agent.request('secret_put', { slug: '..', key: 'aws', b64 });
    assert.equal(bad.ok, false);
    const badKey = await agent.request('secret_put', { slug: 'app-x', key: '../x', b64 });
    assert.equal(badKey.ok, false);

    const rm = await agent.request('secret_remove', { slug: 'app-0123456789abcdef', key: 'aws' });
    assert.equal(rm.ok, true);
    assert.equal(fs.existsSync(put.result), false);
    assert.equal(fs.existsSync(path.dirname(put.result)), false); // emptied dir is removed
    assert.equal((await agent.request('secret_remove', { slug: 'never', key: 'none' })).ok, true);

    await agent.request('secret_put', { slug: 'app-x', key: 'k', b64 });
    assert.equal((await agent.request('secret_remove_all')).ok, true);
    assert.equal(fs.existsSync(path.join(base, 'wb-secrets')), false);
  } finally {
    agent.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('remote agent: refuses a symlinked secrets directory', { skip: !hasPython }, async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-secrets-test-'));
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-secrets-target-'));
  fs.symlinkSync(elsewhere, path.join(base, 'wb-secrets'));
  const agent = startAgent(base);
  try {
    const res = await agent.request('secret_put', { slug: 'app-x', key: 'k', b64: 'eA==' });
    assert.equal(res.ok, false);
    assert.equal(fs.readdirSync(elsewhere).length, 0);
  } finally {
    agent.close();
    fs.rmSync(base, { recursive: true, force: true });
    fs.rmSync(elsewhere, { recursive: true, force: true });
  }
});

test('remote agent: tempfile drops pasted images older than a week', { skip: !hasPython }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-home-'));
  const child = spawn('python3', ['-u', AGENT], { env: { ...process.env, HOME: home } });
  const lines = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => lines.push(...d.split('\n').filter(Boolean)));
  try {
    const dir = path.join(home, '.cache', 'wsl-workbench', 'paste');
    fs.mkdirSync(dir, { recursive: true });
    const old = path.join(dir, 'old.png');
    const recent = path.join(dir, 'recent.png');
    fs.writeFileSync(old, 'x');
    fs.writeFileSync(recent, 'x');
    const eightDaysAgo = Date.now() / 1000 - 8 * 24 * 3600;
    fs.utimesSync(old, eightDaysAgo, eightDaysAgo);
    child.stdin.write(`${JSON.stringify({ id: 1, op: 'tempfile', name: 'new.png', b64: 'eA==' })}\n`);
    for (let i = 0; i < 100 && !lines.some((l) => JSON.parse(l).id === 1); i++) await new Promise((r) => setTimeout(r, 20));
    const res = JSON.parse(lines.find((l) => JSON.parse(l).id === 1));
    assert.equal(res.ok, true);
    assert.equal(fs.existsSync(old), false);
    assert.equal(fs.existsSync(recent), true);
    assert.equal(fs.existsSync(path.join(dir, 'new.png')), true);
  } finally {
    child.stdin.end();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('remote agent: git_clone clones into a new directory and refuses bad input', { skip: !hasPython || spawnSync('git', ['--version']).status !== 0 }, async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-clone-'));
  const src = path.join(base, 'src');
  fs.mkdirSync(src);
  spawnSync('git', ['init', '-q', src]);
  spawnSync('git', ['-C', src, '-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init']);
  const agent = startAgent(base);
  try {
    const res = await agent.request('git_clone', { parent: base, url: src, name: 'copy' });
    assert.equal(res.ok, true);
    assert.equal(res.result, path.join(base, 'copy'));
    assert.equal(fs.existsSync(path.join(base, 'copy', '.git')), true);
    assert.equal((await agent.request('git_clone', { parent: base, url: src, name: 'copy' })).error.code, 'EEXIST');
    assert.equal((await agent.request('git_clone', { parent: base, url: '--upload-pack=x', name: 'y' })).error.code, 'EINVAL');
    assert.equal((await agent.request('git_clone', { parent: base, url: src, name: '../y' })).error.code, 'EINVAL');
    const bad = await agent.request('git_clone', { parent: base, url: path.join(base, 'missing'), name: 'z' });
    assert.equal(bad.ok, false);
    assert.equal(fs.existsSync(path.join(base, 'z')), false);
  } finally {
    agent.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});
