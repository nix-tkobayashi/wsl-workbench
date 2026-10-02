// tunnel-client runner: key storage (encrypted, ACL'd, no plaintext fallback), env isolation, and
// start / stop / exit bookkeeping, with a fake key store and a fake child process.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { TunnelRunner, normalizeKey, KEY_FILE, wrapperClearsKey, profileCommands, checkProfileIsolation } = require('../../src/integration/tunnel-runner');
const { requestLines, parseHelperLine, quoteWindowsArg, encodedCommand } = require('../../src/integration/tunnel-job');
const { buildKeyInputHtml } = require('../../src/integration/key-input-page');

const KEY = 'sk-proj-abcDEF123_-xyz';

// Reversible stand-in for DPAPI: the stored bytes must never equal the plaintext.
function fakeKeyStore({ available = true, failDecrypt = false } = {}) {
  return {
    available: () => available,
    encrypt: (text) => Buffer.from(`enc:${Buffer.from(text).toString('base64')}`),
    decrypt: (buf) => {
      if (failDecrypt) throw new Error('decrypt failed');
      const s = buf.toString();
      if (!s.startsWith('enc:')) throw new Error('not encrypted');
      return Buffer.from(s.slice(4), 'base64').toString();
    }
  };
}

function fakeSpawn() {
  const calls = [];
  const children = [];
  const spawn = (file, args, opts) => {
    const child = new EventEmitter();
    child.pid = 1000 + children.length;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.written = '';
    child.stdin = { write: (d) => { child.written += d; return true; }, on() {} };
    child.started = (pid) => child.stdout.emit('data', `STARTED ${pid}\n`);
    child.request = () => Object.fromEntries(child.written.trim().split('\n').map((l) => [l.split(' ')[0], l.split(' ')[1] == null ? '' : Buffer.from(l.split(' ')[1], 'base64').toString()]));
    child.kill = () => { throw new Error('a parent-only kill must not be used'); };
    calls.push({ file, args, opts });
    children.push(child);
    return child;
  };
  return { spawn, calls, children };
}

function setup({ keyStore = fakeKeyStore(), restrictAcl, baseEnv, killFails = false, canRun = () => true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wswb-tunnel-'));
  const dir = path.join(root, 'integration');
  const exePath = path.join(root, 'tunnel-client.exe');
  const profileFile = path.join(root, 'wsl-workbench.yaml');
  fs.writeFileSync(exePath, '');
  const wrapper = path.join(root, 'adapter.cmd');
  fs.writeFileSync(wrapper, '@echo off\r\nset CONTROL_PLANE_API_KEY=\r\nset ELECTRON_RUN_AS_NODE=1\r\n"C:\\x\\WSL Workbench.exe" adapter.js\r\n');
  fs.writeFileSync(profileFile, `config_version: 1\nmcp:\n  commands:\n    - channel: main\n      command: "${wrapper.replace(/\\/g, '/')}"\n`);
  let cfg = { exePath, profileFile };
  const events = [];
  const killed = [];
  const aclCalls = [];
  const sp = fakeSpawn();
  const runner = new TunnelRunner({
    dir,
    platform: process.platform,
    readConfig: () => cfg,
    writeConfig: (next) => { cfg = next; },
    keyStore,
    restrictAcl: restrictAcl || (async (file) => { aclCalls.push(file); }),
    spawn: sp.spawn,
    killTree: (pid) => { killed.push(pid); return !killFails; },
    baseEnv: baseEnv || (() => ({ PATH: 'C:\\Windows', control_plane_api_key: 'stale' })),
    audit: { record: (e) => events.push(e) },
    canRun: () => canRun(),
    parentPid: 4242
  });
  return { runner, dir, root, sp, events, killed, aclCalls, cfg: () => cfg };
}

test('normalizeKey: trims, rejects empty / whitespace / control characters / oversize', () => {
  assert.equal(normalizeKey(`  ${KEY}\n`), KEY);
  assert.throws(() => normalizeKey(''));
  assert.throws(() => normalizeKey('   '));
  assert.throws(() => normalizeKey('sk a'));
  assert.throws(() => normalizeKey('sk\u0000a'));
  assert.throws(() => normalizeKey('x'.repeat(513)));
});

test('setKey stores only ciphertext in the integration dir and locks the file ACL', async () => {
  const t = setup();
  await t.runner.setKey(KEY);
  const file = path.join(t.dir, KEY_FILE);
  const raw = fs.readFileSync(file);
  assert.ok(!raw.toString().includes(KEY), 'plaintext must not be on disk');
  assert.equal(t.runner.loadKey(), KEY);
  assert.equal(t.aclCalls.length, 1);
  assert.deepEqual(fs.readdirSync(t.dir).filter((n) => n.endsWith('.tmp')), []);
  assert.ok(t.events.some((e) => e.event === 'tunnel_key_saved'));
  assert.ok(!JSON.stringify(t.events).includes(KEY));
});

test('no plaintext fallback: encryption unavailable or ACL failure saves nothing', async () => {
  const a = setup({ keyStore: fakeKeyStore({ available: false }) });
  await assert.rejects(a.runner.setKey(KEY), /DPAPI/);
  assert.equal(a.runner.hasKey(), false);

  const b = setup({ restrictAcl: async () => { throw new Error('icacls failed'); } });
  await assert.rejects(b.runner.setKey(KEY), /icacls/);
  assert.equal(b.runner.hasKey(), false);
  assert.deepEqual(fs.readdirSync(b.dir), []);
});

test('start launches the job helper; the key goes only over its stdin (never env / argv), last before GO', async () => {
  const t = setup({ baseEnv: () => ({ PATH: 'C:\\Windows', control_plane_api_key: 'stale', MCP_COMMAND: 'command=x.exe', TUNNEL_CLIENT_PROFILE: 'other', Control_Plane_Base_Url: 'http://evil' }) });
  await t.runner.setKey(KEY);
  const before = process.env.CONTROL_PLANE_API_KEY;
  assert.equal(t.runner.start(), true);
  const call = t.sp.calls[0];
  const child = t.sp.children[0];
  assert.equal(call.file, 'powershell.exe');
  assert.ok(!call.args.join(' ').includes(KEY));
  assert.equal(call.opts.env.control_plane_api_key, undefined, 'an inherited key is dropped from the helper env');
  assert.equal(call.opts.env.CONTROL_PLANE_API_KEY, undefined);
  assert.deepEqual(Object.keys(call.opts.env), ['PATH'], 'tunnel-client env overrides are dropped');
  assert.equal(call.opts.env.PATH, 'C:\\Windows');
  assert.deepEqual(call.opts.stdio, ['pipe', 'pipe', 'pipe']);
  const req = child.request();
  assert.equal(req.EXE, t.cfg().exePath);
  assert.equal(req.CWD, path.dirname(t.cfg().exePath));
  assert.equal(req.CMDLINE, `run --profile-file ${quoteWindowsArg(t.cfg().profileFile)} --control-plane.api-key env:CONTROL_PLANE_API_KEY`);
  assert.equal(req.KEY, KEY);
  const lines = child.written.trim().split('\n');
  assert.equal(lines.at(-1), 'GO');
  assert.match(lines.at(-2), /^KEY /);
  assert.equal(lines.find((l) => l.startsWith('PARENT ')), 'PARENT 4242');
  assert.equal(process.env.CONTROL_PLANE_API_KEY, before, 'the main process env is untouched');
  assert.equal(t.runner.status().state, 'starting');
  child.started(777);
  assert.equal(t.runner.status().state, 'running');
  assert.equal(t.runner.status().pid, 777);
  assert.equal(t.runner.status().helperPid, child.pid);
  assert.ok(!JSON.stringify(t.events).includes(KEY));
});

test('start refuses (and reports) without exe, profile, or a decryptable key', async () => {
  const t = setup();
  assert.equal(t.runner.start(), false);
  assert.match(t.runner.status().lastError, /No API key/);
  await t.runner.setKey(KEY);
  fs.writeFileSync(path.join(t.dir, KEY_FILE), 'garbage');
  assert.equal(t.runner.start(), false);
  assert.match(t.runner.status().lastError, /decrypted/);
  assert.equal(t.sp.calls.length, 0);

  const u = setup({ keyStore: fakeKeyStore({ failDecrypt: true }) });
  fs.mkdirSync(u.dir, { recursive: true });
  fs.writeFileSync(path.join(u.dir, KEY_FILE), 'enc:xx');
  assert.equal(u.runner.start(), false);
  assert.equal(u.sp.calls.length, 0);

  const v = setup();
  await v.runner.setKey(KEY);
  v.runner.setConfig({ exePath: path.join(v.dir, 'missing.exe') });
  assert.equal(v.runner.start(), false);
  assert.match(v.runner.status().lastError, /tunnel-client\.exe/);
});

test('autoStart runs only when opted in; stop kills the tree and an expected exit reads as stopped', async () => {
  const t = setup();
  await t.runner.setKey(KEY);
  assert.equal(t.runner.autoStart(), false);
  assert.equal(t.sp.calls.length, 0);
  t.runner.setConfig({ autoStart: true });
  assert.equal(t.runner.autoStart(), true);
  const child = t.sp.children[0];
  t.runner.stop('app_exit');
  assert.deepEqual(t.killed, [child.pid]);
  child.emit('exit', 1, null);
  assert.equal(t.runner.status().state, 'stopped');
  assert.equal(t.runner.status().lastError, null);
});

test('an unexpected exit is reported; replacing the key restarts a running tunnel', async () => {
  const t = setup();
  await t.runner.setKey(KEY);
  t.runner.start();
  t.sp.children[0].started(50);
  t.sp.children[0].stdout.emit('data', 'EXIT 2\n');
  t.sp.children[0].emit('exit', 0, null);
  assert.equal(t.runner.status().state, 'exited');
  assert.match(t.runner.status().lastError, /code 2/);

  t.runner.start();
  const old = t.sp.children[1];
  old.started(51);
  await t.runner.setKey('sk-new-key');
  assert.equal(t.sp.calls.length, 3);
  assert.equal(t.sp.children[2].request().KEY, 'sk-new-key');
  old.emit('exit', 1, null); // the old process dies after the new one started
  t.sp.children[2].started(52);
  assert.equal(t.runner.status().state, 'running');
  assert.equal(t.runner.status().pid, 52);
  assert.equal(t.runner.status().helperPid, t.sp.children[2].pid);
});

test('deleteKey stops a running tunnel and removes the file', async () => {
  const t = setup();
  await t.runner.setKey(KEY);
  t.runner.start();
  t.runner.deleteKey();
  assert.equal(t.killed.length, 1);
  assert.equal(t.runner.hasKey(), false);
  assert.equal(t.runner.running, false);
});

test('spawn error is reported, not thrown', async () => {
  const t = setup();
  await t.runner.setKey(KEY);
  t.runner.start();
  t.sp.children[0].emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
  assert.equal(t.runner.status().state, 'error');
  assert.equal(t.runner.running, false);
});

test('key input page: password field, no key in title/url path, escapes text', () => {
  const html = buildKeyInputHtml({ title: '<t>', heading: 'h', note: 'n', okLabel: 'OK', cancelLabel: 'C' });
  assert.match(html, /type="password"/);
  assert.match(html, /autocomplete="off"/);
  assert.ok(html.includes('&lt;t&gt;'));
  assert.ok(!/document\.title\s*=/.test(html));
  assert.match(html, /window\.keyInput\.submit/);
});

test('integration controller: tunnel auto-starts with the integration and stops when it is turned off / on exit', async () => {
  const { IntegrationController } = require('../../src/integration');
  const calls = [];
  const fakeTunnel = { autoStart: () => calls.push('auto'), stop: (r) => { calls.push(`stop:${r}`); return true; } };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wswb-tunnel-ctl-'));
  let settings = {};
  const ctl = new IntegrationController({
    userDataDir: dir, platform: 'linux',
    readSettings: () => settings,
    writeSettings: (p) => { settings = { ...settings, ...p }; return true; },
    tunnel: fakeTunnel
  });
  await ctl.start(); // integration off: nothing
  assert.deepEqual(calls, []);
  if (process.platform === 'win32') return; // the plain-pipe listener below is a Unix socket
  await ctl.enable();
  assert.deepEqual(calls, ['auto']);
  assert.deepEqual(await ctl.disable(), { tunnelStopped: true });
  assert.deepEqual(calls, ['auto', 'stop:integration_disabled']);
  await ctl.enable();
  fakeTunnel.stop = (r) => { calls.push(`stop:${r}`); return false; };
  assert.deepEqual(await ctl.disable(), { tunnelStopped: false });
  assert.equal(ctl.enabled, false, 'the integration still turns off');
  await ctl.shutdown();
  assert.deepEqual(calls.at(-1), 'stop:app_exit');
});

test('a failed stop keeps the child tracked; key replacement does not start a second tunnel', async () => {
  const t = setup({ killFails: true });
  await t.runner.setKey(KEY);
  t.runner.start();
  t.sp.children[0].started(60);
  assert.equal(t.runner.stop('user'), false);
  assert.equal(t.runner.running, true);
  assert.equal(t.runner.status().state, 'running');
  assert.match(t.runner.status().lastError, /could not be stopped/);
  await assert.rejects(t.runner.setKey('sk-new-key'), /could not be stopped/);
  assert.equal(t.sp.calls.length, 1, 'no second tunnel-client');
  assert.throws(() => t.runner.deleteKey(), /could not be stopped/);
  assert.equal(t.runner.hasKey(), false);
  assert.ok(t.events.some((e) => e.event === 'tunnel_stop_failed'));
});

test('nothing starts while the integration is off (auto start, manual start, key replacement)', async () => {
  let on = true;
  const t = setup({ canRun: () => on, killFails: true });
  await t.runner.setKey(KEY);
  t.runner.setConfig({ autoStart: true });
  t.runner.start();
  on = false; // integration turned off, but the tree kill failed: the child is still tracked
  assert.equal(t.runner.stop('integration_disabled'), false);
  t.runner.killTree = () => true; // the retry inside setKey succeeds
  await t.runner.setKey('sk-new-key');
  assert.equal(t.sp.calls.length, 1, 'no restart while the integration is off');
  assert.equal(t.runner.running, false);
  assert.equal(t.runner.autoStart(), false);
  assert.equal(t.runner.start(), false);
  assert.match(t.runner.status().lastError, /integration is off/);
  assert.equal(t.sp.calls.length, 1);
});

test('helper refusal (another tunnel-client running) is reported as such', async () => {
  const t = setup();
  await t.runner.setKey(KEY);
  t.runner.start();
  t.sp.children[0].stdout.emit('data', 'ERROR already_running 1234,5678\n');
  t.sp.children[0].emit('exit', 3, null);
  assert.equal(t.runner.status().state, 'error');
  assert.match(t.runner.status().lastError, /already running \(pid 1234,5678\)/);
  assert.ok(t.events.some((e) => e.event === 'tunnel_start_failed' && e.reason === 'already_running'));
});

test('wrapper check: the key must be cleared before anything runs', () => {
  assert.equal(wrapperClearsKey('@echo off\r\nset CONTROL_PLANE_API_KEY=\r\n"x.exe"'), true);
  assert.equal(wrapperClearsKey('@echo off\nrem hi\nset ELECTRON_RUN_AS_NODE=1\nset "CONTROL_PLANE_API_KEY="\nx.exe'), true);
  assert.equal(wrapperClearsKey('@echo off\n"x.exe"\nset CONTROL_PLANE_API_KEY='), false, 'too late');
  assert.equal(wrapperClearsKey('@echo off\nset ELECTRON_RUN_AS_NODE=1\n"x.exe"'), false, 'never cleared');
  assert.equal(wrapperClearsKey('set A=1 & x.exe\nset CONTROL_PLANE_API_KEY='), false, 'a chained command runs first');
  assert.equal(wrapperClearsKey('set CONTROL_PLANE_API_KEY=abc'), false, 'set to a value is not clearing');
  assert.equal(wrapperClearsKey('@echo off\nsetlocal\nset CONTROL_PLANE_API_KEY=\nx.exe'), false, 'setlocal scopes are refused');
  assert.equal(wrapperClearsKey('@echo off\nset CONTROL_PLANE_API_KEY=\nendlocal\nx.exe'), false, 'endlocal could restore it');
  assert.equal(wrapperClearsKey('@echo off\nset CONTROL_PLANE_API_KEY=\nset CONTROL_PLANE_API_KEY=%OLD%\nx.exe'), false, 'set again later');
  assert.equal(wrapperClearsKey('@echo off\nset CONTROL_PLANE_API_KEY=\nset ELECTRON_RUN_AS_NODE=1\n"x.exe" a.js'), true);
  assert.equal(wrapperClearsKey('@echo off\nsetlocal & adapter.exe\nset CONTROL_PLANE_API_KEY='), false, 'chained setlocal');
  assert.equal(wrapperClearsKey('@echo off & adapter.exe\nset CONTROL_PLANE_API_KEY='), false, 'chained echo off');
  assert.equal(wrapperClearsKey('@echo off\nrem launch & adapter.exe\nset CONTROL_PLANE_API_KEY='), false, 'separator in a comment');
});

test('profile check: stdio commands must be key-clearing wrappers; HTTP-only profiles pass', () => {
  const files = {
    'p.yaml': 'mcp:\n  commands:\n    # the wrapper\n    - channel: main\n      command: "C:/w/a.cmd"\n',
    'C:/w/a.cmd': '@echo off\nset CONTROL_PLANE_API_KEY=\nx.exe',
    'bad.yaml': 'mcp:\n  commands:\n    - command: C:/w/b.cmd\n',
    'C:/w/b.cmd': '@echo off\nx.exe',
    'exe.yaml': 'mcp:\n  commands:\n    - command: "C:/w/adapter.exe"\n',
    'http.yaml': 'mcp:\n  server_url: http://127.0.0.1:3000/mcp\n'
  };
  const read = (f) => { if (!(f in files)) throw new Error('ENOENT'); return files[f]; };
  assert.deepEqual(profileCommands(files['p.yaml']), ['C:/w/a.cmd']);
  assert.deepEqual(profileCommands('mcp:\n  commands: [{channel: main, command: C:/w/adapter.exe}, {"command": "C:/w/a.cmd"}]\n'), ['C:/w/adapter.exe', 'C:/w/a.cmd']);
  assert.deepEqual(profileCommands("mcp: {commands: [{command: 'C:/w/a.cmd', channel: main}]}"), ['C:/w/a.cmd']);
  assert.equal(profileCommands('mcp:\n  commands:\n    - command: >-\n        C:/w/adapter.exe\n'), null, 'block scalar');
  assert.equal(profileCommands('mcp:\n  commands:\n    - command: *anchor\n'), null, 'alias');
  assert.deepEqual(profileCommands('# command: C:/x.exe\nmcp: {}\n'), [], 'comments are ignored');
  assert.equal(profileCommands('mcp: {commands: [{channel: "main #1", command: C:/w/adapter.exe}]}'), null, '# inside quotes');
  assert.equal(profileCommands('mcp:\n  commands:\n    - "comm\\u0061nd": C:/w/adapter.exe\n'), null, 'escaped key');
  assert.equal(profileCommands('mcp:\n  commands:\n    - !!str command: C:/w/adapter.exe\n'), null, 'tag');
  assert.equal(profileCommands('mcp:\n  commands:\n    - <<: *base\n'), null, 'merge key');
  assert.equal(profileCommands('mcp:\n  commands:\n    - ? command\n      : C:/w/adapter.exe\n'), null, 'complex key');
  assert.deepEqual(profileCommands('mcp:\n  commands:\n    - Command: C:/w/adapter.exe\n'), ['C:/w/adapter.exe'], 'key case');
  assert.deepEqual(profileCommands('control_plane:\n  base_url: "https://api.openai.com"\n  api_key: "env:CONTROL_PLANE_API_KEY"\nhealth:\n  listen_addr: "127.0.0.1:0"\nmcp:\n  commands:\n    - channel: main\n      command: "C:/Users/u/wswb-mcp/adapter.cmd"\n'), ['C:/Users/u/wswb-mcp/adapter.cmd'], 'the generated profile shape');
  files['rel.yaml'] = 'mcp:\n  commands:\n    - command: adapter.cmd\n';
  files['adapter.cmd'] = '@echo off\nset CONTROL_PLANE_API_KEY=\nx.exe';
  assert.match(checkProfileIsolation('rel.yaml', read, 'win32').reason, /absolute path/);
  files['space.yaml'] = 'mcp:\n  commands:\n    - command: "C:/Program Files/w/a.cmd"\n';
  assert.match(checkProfileIsolation('space.yaml', read, 'win32').reason, /absolute path/);
  files['dots.yaml'] = 'mcp:\n  commands:\n    - command: C:/w/../w/a.cmd\n';
  assert.match(checkProfileIsolation('dots.yaml', read, 'win32').reason, /absolute path/);
    files['flow.yaml'] = 'mcp:\n  commands: [{channel: main, command: C:/w/adapter.exe}]\n';
  assert.match(checkProfileIsolation('flow.yaml', read, 'win32').reason, /would receive the API key/);
  files['alias.yaml'] = 'mcp:\n  commands:\n    - command: *a\n';
  assert.match(checkProfileIsolation('alias.yaml', read, 'win32').reason, /could not be verified/);
  assert.equal(checkProfileIsolation('p.yaml', read, 'win32').ok, true);
  assert.match(checkProfileIsolation('bad.yaml', read, 'win32').reason, /must clear the key/);
  assert.match(checkProfileIsolation('exe.yaml', read, 'win32').reason, /would receive the API key/);
  assert.equal(checkProfileIsolation('http.yaml', read, 'win32').ok, true);
  assert.equal(checkProfileIsolation('missing.yaml', read, 'win32').ok, false);
});

test('start refuses a profile whose wrapper does not clear the key (nothing is launched)', async () => {
  const t = setup();
  await t.runner.setKey(KEY);
  fs.writeFileSync(path.join(t.root, 'adapter.cmd'), '@echo off\r\n"x.exe"\r\n');
  assert.equal(t.runner.start(), false);
  assert.match(t.runner.status().lastError, /must clear the key/);
  assert.equal(t.sp.calls.length, 0);
});

test('job helper protocol: request lines, parsing, quoting', () => {
  const lines = requestLines({ exe: 'C:\\t\\tunnel-client.exe', cwd: 'C:\\t', args: ['run', 'a b', 'q"x', 'end\\'], logPath: 'C:\\l.log', logMax: 10, parentPid: 9, key: 'k' });
  assert.deepEqual(lines.map((l) => l.split(' ')[0]), ['EXE', 'CWD', 'CMDLINE', 'LOG', 'LOGMAX', 'PARENT', 'KEY', 'GO']);
  assert.equal(Buffer.from(lines[2].split(' ')[1], 'base64').toString(), 'run "a b" "q\\"x" end\\');
  assert.equal(quoteWindowsArg('C:\\a b\\'), '"C:\\a b\\\\"');
  assert.deepEqual(parseHelperLine('STARTED 12\r'), { type: 'started', pid: 12 });
  assert.deepEqual(parseHelperLine('EXIT -1'), { type: 'exit', code: -1 });
  assert.deepEqual(parseHelperLine('ERROR already_running 1,2'), { type: 'error', code: 'already_running', detail: '1,2' });
  assert.equal(parseHelperLine('Add-Type noise'), null);
  const script = Buffer.from(encodedCommand(), 'base64').toString('utf16le');
  assert.match(script, /JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000/);
  assert.match(script, /AssignProcessToJobObject\(Job, GetCurrentProcess\(\)\)/);
});
