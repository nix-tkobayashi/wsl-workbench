const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  remoteHostOf, isRemoteDistro, remoteDistro, parseRemoteSpec,
  agentRemoteCommand, agentSshArgs, reconnectDelayMs, RemoteAgent, RemoteAgentPool
} = require('../src/remote-workspace');

// The exact remote command ssh would run, executed by a local shell instead.
const localAgent = () => spawn('bash', ['-c', agentRemoteCommand()], { stdio: ['pipe', 'pipe', 'pipe'] });

test('ssh: distro encodes the host; malformed hosts are not remote hosts', () => {
  assert.equal(remoteHostOf('ssh:ec2-dev'), 'ec2-dev');
  assert.equal(remoteHostOf('ssh:user@10.0.0.1'), 'user@10.0.0.1');
  assert.equal(remoteHostOf('Ubuntu'), null);
  assert.equal(remoteHostOf('ssh:-oProxyCommand=x'), null);
  assert.equal(remoteHostOf('ssh:a b'), null);
  assert.equal(remoteHostOf('ssh:'), null);
  assert.equal(remoteHostOf(undefined), null);
  assert.equal(isRemoteDistro('ssh:-bad'), true); // still remote: main refuses it instead of going local
  assert.equal(isRemoteDistro('Ubuntu-22.04'), false);
  assert.equal(remoteDistro('ec2-dev'), 'ssh:ec2-dev');
});

test('parseRemoteSpec accepts host, host:/abs, host:~/rel; rejects bad hosts and control chars', () => {
  assert.deepEqual(parseRemoteSpec('ec2-dev:/home/ec2-user/app'), { host: 'ec2-dev', path: '/home/ec2-user/app' });
  assert.deepEqual(parseRemoteSpec('  ec2-dev:~/app '), { host: 'ec2-dev', path: '~/app' });
  assert.deepEqual(parseRemoteSpec('ec2-dev'), { host: 'ec2-dev', path: '~' });
  assert.deepEqual(parseRemoteSpec('ec2-dev:'), { host: 'ec2-dev', path: '~' });
  assert.deepEqual(parseRemoteSpec('ec2-dev:/a b/c'), { host: 'ec2-dev', path: '/a b/c' });
  assert.equal(parseRemoteSpec(''), null);
  assert.equal(parseRemoteSpec('-oProxyCommand=x:/tmp'), null);
  assert.equal(parseRemoteSpec('ec2-dev:/x\ny'), null);
});

test('agent ssh argv: host after --, batch mode, remote command is quote-safe', () => {
  const args = agentSshArgs('Ubuntu', 'ec2-dev', 'CMD');
  assert.deepEqual(args.slice(0, 5), ['-d', 'Ubuntu', '--exec', 'ssh', '-T']);
  assert.ok(args.includes('BatchMode=yes'));
  assert.deepEqual(args.slice(-3), ['--', 'ec2-dev', 'CMD']);
  const cmd = agentRemoteCommand();
  assert.match(cmd, /^python3 -u -c '[^']*' [A-Za-z0-9+/=]+$/);
  assert.ok(!cmd.includes('"'));
});

test('agent over the real remote command: hello, ops, errors with codes', async () => {
  const agent = new RemoteAgent(localAgent, { label: 'local' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-agent-'));
  try {
    assert.deepEqual(await agent.request('resolvedir', { path: dir }), { path: fs.realpathSync(dir), exists: true, isDir: true });
    assert.equal(agent.info.version, 1);
    assert.equal((await agent.request('resolvedir', { path: '~' })).path, fs.realpathSync(os.homedir()));
    const missing = path.join(dir, 'nope', 'deeper');
    assert.deepEqual(await agent.request('resolvedir', { path: missing }), { path: missing, exists: false, isDir: false });
    assert.equal(await agent.request('mkdirs', { path: missing }), missing);
    assert.equal(fs.statSync(missing).isDirectory(), true);
    fs.writeFileSync(path.join(dir, 'plain'), '');
    assert.deepEqual(await agent.request('resolvedir', { path: path.join(dir, 'plain') }), { path: path.join(dir, 'plain'), exists: true, isDir: false });
    await assert.rejects(agent.request('stat', { path: 'relative' }), { code: 'EINVAL' });
    await assert.rejects(agent.request('bogus'), { code: 'ENOSYS' });
    const f = path.join(dir, 'a.txt');
    await agent.request('write', { path: f, b64: Buffer.from('hi').toString('base64'), mode: 'new' });
    await assert.rejects(agent.request('write', { path: f, b64: '', mode: 'new' }), { code: 'EEXIST' });
    await assert.rejects(agent.request('write', { path: path.join(dir, 'b'), b64: '', mode: 'existing' }), { code: 'ENOENT' });
    // Concurrent requests resolve to their own ids.
    const [s, r] = await Promise.all([agent.request('stat', { path: f }), agent.request('read', { path: f, max: 10 })]);
    assert.equal(s.size, 2);
    assert.equal(Buffer.from(r.b64, 'base64').toString(), 'hi');
    assert.deepEqual(await agent.request('read', { path: f, max: 1 }), { tooLarge: true, size: 2 });
    // Big payloads cross chunk boundaries intact.
    const big = Buffer.alloc(3 * 1024 * 1024, 'x');
    fs.writeFileSync(f, big);
    const rb = await agent.request('read', { path: f, max: 4 * 1024 * 1024 });
    assert.equal(Buffer.from(rb.b64, 'base64').length, big.length);
    const sh = await agent.request('sh', { cwd: dir, script: 'pwd; echo é' });
    assert.equal(sh.code, 0);
    assert.equal(sh.stdout, `${fs.realpathSync(dir)}\né\n`);
  } finally {
    agent.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('tempfile is 0600 in a 0700 directory and never clobbers', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-home-'));
  const agent = new RemoteAgent(() => spawn('bash', ['-c', agentRemoteCommand()], { env: { ...process.env, HOME: home } }));
  try {
    const p = await agent.request('tempfile', { name: '../x.png', b64: Buffer.from('png').toString('base64') });
    assert.equal(p, path.join(home, '.cache/wsl-workbench/paste/x.png'));
    assert.equal(fs.statSync(p).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(p)).mode & 0o777, 0o700);
    await assert.rejects(agent.request('tempfile', { name: 'x.png', b64: '' }), { code: 'EEXIST' });
  } finally {
    agent.dispose();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// A fake child process: lets tests drive exits and silence.
function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => { child.killed = true; };
  return child;
}

test('a dying connection rejects pending requests with ssh stderr, and the next request reconnects', async () => {
  const children = [];
  let clock = 1000;
  const agent = new RemoteAgent(() => { const c = fakeChild(); children.push(c); return c; }, { label: 'ssh h', now: () => clock });
  const p1 = agent.request('stat', { path: '/' });
  children[0].stderr.write('ssh: connect to host h: Connection refused\n');
  await new Promise((r) => setImmediate(r));
  children[0].emit('exit', 255);
  await assert.rejects(p1, (e) => e.code === 'ECONNRESET' && /Connection refused/.test(e.message));
  // Within the reconnect wait the last error comes back without spawning another ssh.
  await assert.rejects(agent.request('stat', { path: '/' }), (e) => e.code === 'ENOTCONN' && /Connection refused/.test(e.message));
  assert.equal(children.length, 1);
  clock += 2000;
  const p2 = agent.request('stat', { path: '/' });
  assert.equal(children.length, 2);
  children[1].stdout.write('{"id":0,"ok":true,"result":{"version":1}}\n');
  await new Promise((r) => setImmediate(r));
  const line = children[1].stdin.read().toString();
  const { id } = JSON.parse(line);
  children[1].stdout.write(`${JSON.stringify({ id, ok: true, result: { isDir: true } })}\n`);
  assert.deepEqual(await p2, { isDir: true });
  agent.dispose();
});

test('no hello within the ready timeout fails the connection; a slow request times out alone', async () => {
  const children = [];
  const agent = new RemoteAgent(() => { const c = fakeChild(); children.push(c); return c; }, { readyTimeoutMs: 20, requestTimeoutMs: 20 });
  await assert.rejects(agent.request('stat', { path: '/' }), /connection timed out/);
  assert.equal(children[0].killed, true);
  agent.reconnect(); // skip the reconnect wait
  const p = agent.request('stat', { path: '/' });
  children[1].stdout.write('{"id":0,"ok":true,"result":{}}\n');
  await assert.rejects(p, { code: 'ETIMEDOUT' });
  assert.equal(agent.child, children[1]); // still connected
  agent.dispose();
});

test('pool keeps one agent per host', () => {
  const pool = new RemoteAgentPool(() => fakeChild());
  assert.equal(pool.get('a'), pool.get('a'));
  assert.notEqual(pool.get('a'), pool.get('b'));
  pool.disposeAll();
  assert.equal(pool.agents.size, 0);
});

test('concurrent renames onto one free name: exactly one wins, nothing is replaced', async () => {
  const agent = new RemoteAgent(localAgent);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-rename-'));
  try {
    for (let round = 0; round < 20; round++) {
      const dst = path.join(dir, `dst${round}`);
      const ps = [0, 1, 2, 3].map((i) => {
        const src = path.join(dir, `s${round}-${i}`);
        fs.writeFileSync(src, String(i));
        return agent.request('rename', { src, dst });
      });
      const ok = (await Promise.allSettled(ps)).filter((r) => r.status === 'fulfilled').length;
      assert.equal(ok, 1);
    }
  } finally {
    agent.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('overlapping saves of one file land whole and in request order', async () => {
  const agent = new RemoteAgent(localAgent);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-save-'));
  const f = path.join(dir, 'f');
  fs.writeFileSync(f, '');
  try {
    const payloads = [0, 1, 2, 3].map((i) => Buffer.alloc(1024 * 1024 - i * 100000, 65 + i));
    for (let round = 0; round < 10; round++) {
      await Promise.all(payloads.map((b) => agent.request('write', { path: f, b64: b.toString('base64'), mode: 'existing' })));
      assert.deepEqual(fs.readFileSync(f), payloads[3]);
    }
  } finally {
    agent.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a read never sees a file mid-save', async () => {
  const agent = new RemoteAgent(localAgent);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-rw-'));
  const f = path.join(dir, 'f');
  const body = Buffer.alloc(1024 * 1024, 65);
  fs.writeFileSync(f, body);
  try {
    for (let round = 0; round < 30; round++) {
      const res = await Promise.all([
        agent.request('write', { path: f, b64: body.toString('base64'), mode: 'existing' }),
        ...Array.from({ length: 6 }, () => agent.request('read', { path: f, max: 2 * 1024 * 1024 }))
      ]);
      for (const r of res.slice(1)) assert.equal(Buffer.from(r.b64, 'base64').length, body.length);
    }
  } finally {
    agent.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reconnectDelayMs doubles per failure up to the cap', () => {
  assert.equal(reconnectDelayMs(0), 0);
  assert.equal(reconnectDelayMs(1), 2000);
  assert.equal(reconnectDelayMs(2), 4000);
  assert.equal(reconnectDelayMs(4), 16000);
  assert.equal(reconnectDelayMs(5), 30000);
  assert.equal(reconnectDelayMs(50), 30000);
});

test('beforeStart runs before each connection attempt', async () => {
  const order = [];
  const children = [];
  const agent = new RemoteAgent(() => { order.push('spawn'); const c = fakeChild(); children.push(c); return c; }, {
    beforeStart: async () => { order.push('before'); }
  });
  const p = agent.request('stat', { path: '/' });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(order, ['before', 'spawn']);
  children[0].stdout.write('{"id":0,"ok":true,"result":{}}\n');
  await new Promise((r) => setImmediate(r));
  const { id } = JSON.parse(children[0].stdin.read().toString());
  children[0].stdout.write(`${JSON.stringify({ id, ok: true, result: 1 })}\n`);
  assert.equal(await p, 1);
  agent.dispose();
});
