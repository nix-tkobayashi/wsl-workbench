const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { findRemoteTerminal, remoteTerminalArgs } = require('../src/remote-terminal');

const ws = { distro: 'Ubuntu', wslPath: '/home/me/app' };

test('matches a workspace by path (trailing slash ignored) and optional distro', () => {
  const entries = [{ wslPath: '/home/me/app/', host: 'ec2-dev', dir: '/srv/app' }];
  assert.deepEqual(findRemoteTerminal(entries, ws), { host: 'ec2-dev', dir: '/srv/app' });
  assert.equal(findRemoteTerminal([{ ...entries[0], distro: 'Debian' }], ws), null);
  assert.deepEqual(findRemoteTerminal([{ ...entries[0], distro: 'Ubuntu' }], ws), { host: 'ec2-dev', dir: '/srv/app' });
  assert.equal(findRemoteTerminal(entries, { distro: 'Ubuntu', wslPath: '/home/me/app2' }), null);
});

test('no settings or no match keeps the terminal local', () => {
  assert.equal(findRemoteTerminal(undefined, ws), null);
  assert.equal(findRemoteTerminal({}, ws), null);
  assert.equal(findRemoteTerminal([], ws), null);
});

test('malformed entries are skipped, not half-applied', () => {
  const bad = [
    { wslPath: '/home/me/app', host: '-oProxyCommand=evil' },
    { wslPath: '/home/me/app', host: 'a b' },
    { wslPath: '/home/me/app', host: '' },
    { wslPath: '/home/me/app', host: 'ok', dir: 'relative' },
    { wslPath: '/home/me/app', host: 'ok', dir: '/x\ny' },
    { host: 'ok' }
  ];
  assert.equal(findRemoteTerminal(bad, ws), null);
  assert.deepEqual(findRemoteTerminal([...bad, { wslPath: '/home/me/app', host: 'good' }], ws), { host: 'good', dir: '' });
});

test('ssh argv: host after --, one remote command string', () => {
  const args = remoteTerminalArgs('Ubuntu', { host: 'ec2-dev', dir: '' }, 'exec bash');
  assert.deepEqual(args.slice(0, 5), ['-d', 'Ubuntu', '--exec', 'ssh', '-t']);
  const dd = args.indexOf('--');
  assert.equal(args[dd + 1], 'ec2-dev');
  assert.equal(args.length, dd + 3);
  assert.equal(args[dd + 2], "bash -lc 'exec bash'");
});

test('remote command survives the remote shell parse with quotes in dir and script', { skip: process.platform === 'win32' && 'needs a POSIX sh' }, () => {
  const dir = "/srv/it's here";
  const script = `printf '%s\\n' "$PWD"`;
  const cmd = remoteTerminalArgs('Ubuntu', { host: 'h', dir }, script).at(-1);
  // ssh hands the string to the remote login shell; emulate that with sh -c, with `cd` stubbed.
  const out = execFileSync('sh', ['-c', `cd() { shift; PWD="$1"; }; ${cmd.replace(/^bash -lc /, 'eval ')}`], { encoding: 'utf8' });
  assert.equal(out, `${dir}\n`);
});

test('a failed remote cd skips the launch script', { skip: process.platform === 'win32' && 'needs a POSIX sh' }, () => {
  const cmd = remoteTerminalArgs('Ubuntu', { host: 'h', dir: '/nope' }, 'echo LAUNCHED').at(-1);
  // The fallback `exec bash` reads an empty stdin and exits, so the launch line must never run.
  const out = execFileSync('sh', ['-c', `cd() { return 1; }; ${cmd.replace(/^bash -lc /, 'eval ')}`], { encoding: 'utf8', input: '' });
  assert.equal(out, '[remote] cannot cd to /nope\n');
});
