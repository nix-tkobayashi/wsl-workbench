// Non-secret connection diagnostics: how far the adapter's handshake got, and what the broker /
// pipe relay saw on their side. None of it may contain the secret, nonces or proofs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter, once } = require('events');
const { PassThrough } = require('stream');
const { connectBroker, createBrokerServer, PROTO } = require('../../src/integration/local-transport');
const { createSecurePipeListener } = require('../../src/integration/pipe-relay');
const { createAuditLog } = require('../../src/integration/audit');

const posixOnly = { skip: process.platform === 'win32' ? 'uses a Unix socket' : false };

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'wswb-diag-')); }

async function fakeServer(onSocket) {
  const endpoint = path.join(tmpDir(), 'fake.sock');
  const server = net.createServer(onSocket);
  await new Promise((resolve) => server.listen(endpoint, resolve));
  return { endpoint, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function diagOf(promise) {
  const error = await promise.then(() => null, (e) => e);
  assert.ok(error, 'expected the connection to fail');
  assert.equal(error.message, 'TRANSPORT_UNAVAILABLE');
  return error.diag;
}

test('connectBroker: no endpoint -> stage connecting, socket error code', posixOnly, async () => {
  const diag = await diagOf(connectBroker({ endpoint: path.join(tmpDir(), 'missing.sock'), secret: crypto.randomBytes(32), timeoutMs: 2000 }));
  assert.equal(diag.stage, 'connecting');
  assert.equal(diag.reason, 'socket-error');
  assert.equal(diag.code, 'ENOENT');
});

test('connectBroker: pipe opens but the peer closes with no data -> pipe-open / peer-close', posixOnly, async () => {
  const srv = await fakeServer((socket) => socket.end());
  const stages = [];
  const diag = await diagOf(connectBroker({ endpoint: srv.endpoint, secret: crypto.randomBytes(32), timeoutMs: 2000, onStage: (s) => stages.push(s) }));
  assert.deepEqual(stages, ['pipe-open']);
  assert.equal(diag.stage, 'pipe-open');
  assert.equal(diag.reason, 'peer-close');
  assert.equal(diag.bytes_in, 0);
  await srv.close();
});

test('connectBroker: pipe opens but nothing arrives -> pipe-open / timeout', posixOnly, async () => {
  const held = [];
  const srv = await fakeServer((socket) => held.push(socket));
  const diag = await diagOf(connectBroker({ endpoint: srv.endpoint, secret: crypto.randomBytes(32), timeoutMs: 200 }));
  assert.equal(diag.stage, 'pipe-open');
  assert.equal(diag.reason, 'timeout');
  for (const s of held) s.destroy();
  await srv.close();
});

test('connectBroker: hello then close -> auth-sent / peer-close', posixOnly, async () => {
  const srv = await fakeServer((socket) => {
    socket.write(`${JSON.stringify({ t: 'hello', proto: PROTO, nonce: 'ab'.repeat(32) })}\n`);
    socket.once('data', () => socket.end());
  });
  const stages = [];
  const diag = await diagOf(connectBroker({ endpoint: srv.endpoint, secret: crypto.randomBytes(32), timeoutMs: 2000, onStage: (s) => stages.push(s) }));
  assert.deepEqual(stages, ['pipe-open', 'hello-received', 'auth-sent']);
  assert.equal(diag.stage, 'auth-sent');
  assert.equal(diag.reason, 'peer-close');
  assert.ok(diag.bytes_in > 0);
  await srv.close();
});

test('connectBroker + broker: wrong secret -> auth-sent / peer-close and server bad-proof; right secret reaches auth-ok', posixOnly, async () => {
  const endpoint = path.join(tmpDir(), 'b.sock');
  const secret = crypto.randomBytes(32);
  const events = [];
  const server = createBrokerServer({ endpoint, secret, onTool: () => ({ ok: true }), onEvent: (e) => events.push(e) });
  await server.listen();
  const diag = await diagOf(connectBroker({ endpoint, secret: crypto.randomBytes(32), timeoutMs: 2000 }));
  assert.equal(diag.stage, 'auth-sent');
  assert.equal(diag.reason, 'peer-close');
  await new Promise((r) => setTimeout(r, 50));
  const failed = events.filter((e) => e.event === 'auth_failed');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].reason, 'bad-proof');

  const stages = [];
  const conn = await connectBroker({ endpoint, secret, timeoutMs: 2000, onStage: (s) => stages.push(s) });
  assert.deepEqual(stages, ['pipe-open', 'hello-received', 'auth-sent', 'auth-ok']);
  conn.close();
  await server.close();
});

test('broker: a client that closes before authenticating is recorded as auth_failed', posixOnly, async () => {
  const endpoint = path.join(tmpDir(), 'b.sock');
  const events = [];
  const server = createBrokerServer({ endpoint, secret: crypto.randomBytes(32), onTool: () => null, onEvent: (e) => events.push(e) });
  await server.listen();
  const socket = net.createConnection(endpoint);
  await once(socket, 'data');
  socket.destroy();
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(events.map((e) => e.event), ['connection_accepted', 'hello_sent', 'auth_failed']);
  assert.equal(events[2].reason, 'peer-closed-before-auth');
  assert.equal(typeof events[2].elapsed_ms, 'number');
  await server.close();
});

function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {};
  return child;
}

test('pipe relay: logs ready, accept, hand-off, connection errors and peer close with byte counts', async () => {
  const sid = 'S-1-5-21-1-2-3-1001';
  const child = fakeChild();
  const logs = [];
  const received = [];
  const listenWith = createSecurePipeListener({ pipePath: '\\\\.\\pipe\\wswb-test', sid, spawnFn: () => child, onLog: (e) => logs.push(e) });
  const ready = listenWith((conn) => { received.push(conn); conn.on('data', () => {}); conn.write('hi\n'); });
  child.stdout.write(`READY ${sid} D:P(D;;FA;;;NU)(A;;FA;;;${sid})\n`);
  await ready;
  child.stdout.write('O 7\n');
  child.stdout.write(`D 7 ${Buffer.from('abc').toString('base64')}\n`);
  child.stdout.write('X 7 IOException\n');
  child.stdout.write('X 7 bad;type\n');
  child.stdout.write('C 7\n');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(received.length, 1);
  assert.deepEqual(logs.map((e) => e.event), ['relay_ready', 'relay_accepted', 'relay_handed_off', 'relay_conn_error', 'relay_conn_error', 'relay_peer_closed']);
  assert.equal(logs[1].relay_id, 7);
  assert.equal(logs[3].code, 'IOException');
  assert.equal(logs[4].code, 'unknown');
  assert.equal(logs[5].bytes_in, 3);
  assert.equal(logs[5].bytes_out, 3);
});

test('audit log: diagnostic fields are kept, anything else (e.g. a secret) is dropped', () => {
  const dir = tmpDir();
  const log = createAuditLog({ dir, prefix: 'adapter' });
  log.record({ event: 'adapter_connect_failed', stage: 'pipe-open', reason: 'peer-close', code: null, elapsed_ms: 3, bytes_in: 0, secret: 'deadbeef', proof: 'x', nonce: 'y' });
  const [file] = fs.readdirSync(dir);
  assert.match(file, /^adapter-\d{4}-\d{2}-\d{2}\.jsonl$/);
  const line = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  assert.equal(line.stage, 'pipe-open');
  assert.equal(line.secret, undefined);
  assert.equal(line.proof, undefined);
  assert.equal(line.nonce, undefined);
  assert.throws(() => createAuditLog({ dir, prefix: '../x' }));
});

test('adapter: a failed connect reports stage/reason in the MCP error and the diag file, never the secret', posixOnly, async () => {
  const dir = tmpDir();
  const secretHex = crypto.randomBytes(32).toString('hex');
  const srv = await fakeServer((socket) => socket.end());
  fs.writeFileSync(path.join(dir, 'pairing.key'), secretHex);
  fs.writeFileSync(path.join(dir, 'endpoint.json'), JSON.stringify({ proto: PROTO, endpoint: srv.endpoint }));
  const { spawn } = require('child_process');
  const child = spawn(process.execPath, [path.join(__dirname, '..', '..', 'src', 'mcp', 'adapter.js')], {
    env: { ...process.env, WSLWB_INTEGRATION_DIR: dir }, stdio: ['pipe', 'pipe', 'pipe']
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'workbench_capabilities', arguments: {} } })}\n`);
  for (let i = 0; i < 100 && !out.includes('\n'); i++) await new Promise((r) => setTimeout(r, 30));
  child.stdin.end();
  await once(child, 'exit');
  const reply = JSON.parse(out.split('\n')[0]);
  const error = reply.result.structuredContent.error;
  assert.equal(error.code, 'APP_UNAVAILABLE');
  assert.match(error.message, /stage=pipe-open, reason=peer-close/);
  assert.match(err, /"event":"adapter_stage","stage":"pipe-open"/);
  assert.match(err, /"event":"adapter_connect_failed"/);
  const diagDir = path.join(dir, 'diag');
  const text = fs.readdirSync(diagDir).map((f) => fs.readFileSync(path.join(diagDir, f), 'utf8')).join('');
  assert.match(text, /adapter_connect_failed/);
  for (const blob of [text, err, out]) assert.ok(!blob.includes(secretHex));
  await srv.close();
});
