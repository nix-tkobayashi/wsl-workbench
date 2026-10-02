// Controller + local transport + the real adapter process speaking MCP over stdio.
// Uses a Unix socket in a temp dir (the Windows named pipe path is the same code with another endpoint).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { IntegrationController } = require('../../src/integration');
const { connectBroker, createBrokerServer } = require('../../src/integration/local-transport');
const { readPairing } = require('../../src/integration/pairing');

const posixOnly = { skip: process.platform === 'win32' ? 'uses a Unix socket' : false };

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'wswb-int-')); }

function makeController(dir, extra = {}) {
  let settings = {};
  return new IntegrationController({
    userDataDir: dir,
    appVersion: '0.26.0-test',
    readSettings: () => settings,
    writeSettings: (patch) => { settings = { ...settings, ...patch }; return true; },
    notifyView: extra.notifyView || (() => {}),
    ...extra
  });
}

function startAdapter(dir) {
  const child = spawn(process.execPath, [path.join(__dirname, '..', '..', 'src', 'mcp', 'adapter.js')], {
    env: { ...process.env, WSLWB_INTEGRATION_DIR: path.join(dir, 'integration') },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let buf = '';
  const waiters = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      const w = waiters.get(msg.id);
      if (w) { waiters.delete(msg.id); w(msg); }
    }
  });
  let id = 0;
  return {
    child,
    request(method, params) {
      const reqId = ++id;
      return new Promise((resolve) => {
        waiters.set(reqId, resolve);
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: reqId, method, params })}\n`);
      });
    },
    notify(method, params) { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`); },
    async callTool(name, args) {
      const res = await this.request('tools/call', { name, arguments: args });
      return res.result;
    },
    close() { child.stdin.end(); child.kill(); }
  };
}

test('A2/A3 contract: MCP initialize, tools/list, and read-only calls through the real adapter', posixOnly, async () => {
  const dir = tmpDir();
  const panes = [];
  const ctl = makeController(dir, { notifyView: (viewId, state) => panes.push([viewId, state]) });
  await ctl.enable();
  const mode = fs.statSync(path.join(dir, 'integration', 'pairing.key')).mode & 0o777;
  assert.equal(mode, 0o600);
  ctl.ptyStarted(7, 1, { distro: 'Ubuntu', wslPath: '/home/u/p', initialCwd: '/home/u/p' });
  ctl.ptyData(7, 1, 'not shared yet\n');
  const adapter = startAdapter(dir);
  try {
    const init = await adapter.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.ok(init.result.capabilities.tools);
    adapter.notify('notifications/initialized');
    const list = await adapter.request('tools/list', {});
    assert.equal(list.result.tools.length, 4);
    for (const tool of list.result.tools) {
      assert.equal(tool.inputSchema.additionalProperties, false);
      assert.ok(tool.outputSchema);
    }

    const caps = await adapter.callTool('workbench_capabilities', {});
    assert.equal(caps.isError, false);
    assert.equal(caps.structuredContent.features.command_execution, false);
    assert.equal(caps.structuredContent.app_instance_id, ctl.registry.appInstanceId);
    assert.ok(caps.content[0].text.includes('"ok":true'));

    let sessions = await adapter.callTool('workbench_list_sessions', {});
    assert.equal(sessions.structuredContent.sessions.length, 0);

    ctl.share(7, 1, { label: 'claude' });
    assert.equal(panes.at(-1)[1][0].shared, true);
    ctl.ptyData(7, 1, '\x1b[1mbuild ok\x1b[0m\r\n');
    sessions = await adapter.callTool('workbench_list_sessions', {});
    const view = sessions.structuredContent.sessions[0];
    assert.equal(view.display_label, 'p · claude');
    const out = await adapter.callTool('workbench_read_output', { target: view.target });
    assert.equal(out.structuredContent.text, 'build ok\n');
    assert.ok(!out.structuredContent.text.includes('not shared yet'));

    // Argument validation happens before anything reaches Workbench.
    const bad = await adapter.callTool('workbench_read_output', { target: view.target, cursor: 'x', tail: true });
    assert.equal(bad.isError, true);
    assert.equal(bad.structuredContent.error.code, 'INPUT_INVALID');
    const unknown = await adapter.request('tools/call', { name: 'workbench_run_command', arguments: {} });
    assert.equal(unknown.error.code, -32602);

    // Revoke from the UI: the next read is denied.
    ctl.stopSharing(7, 1);
    const denied = await adapter.callTool('workbench_read_output', { target: view.target });
    assert.equal(denied.structuredContent.error.code, 'GRANT_REVOKED');

    // Turning the integration off -> APP_UNAVAILABLE, and the adapter never starts anything itself.
    await ctl.disable();
    const off = await adapter.callTool('workbench_capabilities', {});
    assert.equal(off.isError, true);
    assert.equal(off.structuredContent.error.code, 'APP_UNAVAILABLE');
    assert.equal(off.structuredContent.error.next_action, 'reconnect');

    // Re-enable: the adapter reconnects on the next call (X02 resync path).
    await ctl.enable();
    const again = await adapter.callTool('workbench_capabilities', {});
    assert.equal(again.isError, false);
  } finally {
    adapter.close();
    await ctl.shutdown();
  }
});

test('A07: wrong secret, no proof, and a fake server are all rejected', posixOnly, async () => {
  const dir = tmpDir();
  const ctl = makeController(dir);
  await ctl.enable();
  try {
    const pairing = readPairing(path.join(dir, 'integration'));
    await assert.rejects(connectBroker({ endpoint: pairing.endpoint, secret: crypto.randomBytes(32), timeoutMs: 2000 }));
    // A raw client that never authenticates gets only the hello, then is dropped.
    const net = require('net');
    const lines = await new Promise((resolve) => {
      const sock = net.createConnection(pairing.endpoint);
      let data = '';
      sock.on('data', (d) => { data += d; sock.write('{"t":"req","id":1,"method":"tool","params":{"name":"workbench_list_sessions","args":{}}}\n'); });
      sock.on('close', () => resolve(data.trim().split('\n')));
    });
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).t, 'hello');
    assert.ok(ctl.status().lastAuthFailureAt);
    // The right secret works.
    const conn = await connectBroker(pairing);
    const r = await conn.callTool('workbench_capabilities', {});
    assert.equal(r.ok, true);
    conn.close();
  } finally {
    await ctl.shutdown();
  }
  // A squatter that doesn't know the secret can't pass the client's check of the server proof.
  const dir2 = tmpDir();
  const endpoint = path.join(dir2, 'fake.sock');
  const fake = createBrokerServer({ endpoint, secret: crypto.randomBytes(32), onTool: () => ({ ok: true }) });
  await fake.listen();
  await assert.rejects(connectBroker({ endpoint, secret: crypto.randomBytes(32), timeoutMs: 2000 }));
  await fake.close();
});

test('controller: PTY replace / close / view reload end grants and drop buffers', posixOnly, async () => {
  const dir = tmpDir();
  const ctl = makeController(dir);
  await ctl.enable();
  try {
    ctl.ptyStarted(1, 1, { distro: 'Ubuntu', wslPath: '/w' });
    ctl.share(1, 1);
    ctl.ptyData(1, 1, 'x');
    const session = ctl.registry.bySlot(1, 1);
    assert.equal(session.buffer.totalBytes, 1);
    ctl.ptyStarted(1, 1, { distro: 'Ubuntu', wslPath: '/w' }); // restart
    assert.equal(ctl.paneState(1)[0].shared, false);
    assert.equal(session.capture, 'off');

    ctl.share(1, 1);
    ctl.ptyClosed(1, 1);
    assert.equal(ctl.access.grants.size, 0);

    ctl.ptyStarted(2, 1, { distro: 'Ubuntu', wslPath: '/w' });
    ctl.share(2, 1);
    ctl.viewReset(2);
    assert.equal(ctl.access.grants.size, 0);

    ctl.ptyStarted(3, 1, { distro: 'Ubuntu', wslPath: '/w' });
    ctl.share(3, 1);
    ctl.pause(3, 1);
    ctl.ptyData(3, 1, 'hidden');
    ctl.resume(3, 1);
    const s3 = ctl.registry.bySlot(3, 1);
    assert.equal(s3.buffer.totalBytes, 0);
    assert.equal(s3.buffer.chunks.at(-1).gap, 'capture_paused');
    ctl.revokeAll();
    assert.equal(s3.capture, 'off');
    // Audit has events but never terminal text.
    const auditDir = path.join(dir, 'integration', 'audit');
    const text = fs.readdirSync(auditDir).map((f) => fs.readFileSync(path.join(auditDir, f), 'utf8')).join('');
    assert.ok(text.includes('grant_issued'));
    assert.ok(!text.includes('hidden'));
  } finally {
    await ctl.shutdown();
  }
});

test('feature OFF: hooks keep working, nothing is captured, sharing is refused', () => {
  const dir = tmpDir();
  const ctl = makeController(dir);
  ctl.ptyStarted(1, 1, { distro: 'Ubuntu', wslPath: '/w' });
  ctl.ptyData(1, 1, 'data');
  ctl.ptyExited(1, 1);
  ctl.ptyClosed(1, 1);
  assert.equal(ctl.enabled, false);
  assert.equal(ctl.registry.totalBytes(), 0);
  ctl.ptyStarted(1, 2, { distro: 'Ubuntu', wslPath: '/w' });
  assert.throws(() => ctl.share(1, 2), /turned off/);
  assert.equal(fs.existsSync(path.join(dir, 'integration', 'pairing.key')), false);
});

test('codex r1: lazy expiry (noticed by a read) still stops capture and drops the buffer', () => {
  let t = 0;
  const ctl = makeController(tmpDir(), { now: () => t, monotonic: () => t });
  ctl.server = { status: () => ({}) }; ctl.principal = 'p';
  ctl.ptyStarted(1, 1, { distro: 'Ubuntu', wslPath: '/w' });
  const s = ctl.sessionFor(1, 1);
  ctl.share(1, 1, { durationMs: 100 });
  ctl.ptyData(1, 1, 'abc');
  t = 101;
  assert.equal(ctl.broker.handle('p', 'workbench_get_session', { target: ctl.registry.target(s) }).error.code, 'GRANT_EXPIRED');
  assert.equal(s.capture, 'off');
  assert.equal(s.buffer, null);
  ctl.ptyData(1, 1, 'after expiry');
  assert.equal(ctl.registry.totalBytes(), 0);
});

test('codex r1: a cursor from an earlier share is invalid after re-sharing', () => {
  const ctl = makeController(tmpDir());
  ctl.server = { status: () => ({}) }; ctl.principal = 'p';
  ctl.ptyStarted(1, 1, { distro: 'Ubuntu', wslPath: '/w' });
  const s = ctl.sessionFor(1, 1);
  const target = ctl.registry.target(s);
  ctl.share(1, 1);
  ctl.ptyData(1, 1, 'abcd');
  const old = ctl.broker.handle('p', 'workbench_read_output', { target }).next_cursor;
  ctl.stopSharing(1, 1);
  ctl.share(1, 1);
  ctl.ptyData(1, 1, '12345678');
  assert.equal(ctl.broker.handle('p', 'workbench_read_output', { target, cursor: old }).error.code, 'CURSOR_INVALID');
});

test('codex r3: a read enforces age retention even before the sweep runs', () => {
  let t = 0;
  const ctl = makeController(tmpDir(), { now: () => t, monotonic: () => t });
  ctl.server = { status: () => ({}) }; ctl.principal = 'p';
  ctl.ptyStarted(1, 1, { distro: 'Ubuntu', wslPath: '/w' });
  ctl.share(1, 1, { durationMs: 60 * 60 * 1000 });
  ctl.ptyData(1, 1, 'old secret');
  t = 11 * 60 * 1000;
  const r = ctl.broker.handle('p', 'workbench_read_output', { target: ctl.registry.target(ctl.sessionFor(1, 1)) });
  assert.equal(r.ok, true);
  assert.equal(r.text, '');
});
