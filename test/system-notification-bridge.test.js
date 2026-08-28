const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { parseBridgeLine, createLineSplitter, createSystemNotificationBridge } = require('../src/system-notification-bridge');

test('parseBridgeLine: JSON objects with a type only; garbage never throws', () => {
  assert.deepEqual(parseBridgeLine('{"type":"status","status":"ready"}\r'), { type: 'status', status: 'ready' });
  assert.equal(parseBridgeLine(''), null);
  assert.equal(parseBridgeLine('DEBUG: connected!'), null);
  assert.equal(parseBridgeLine('[1,2]'), null);
  assert.equal(parseBridgeLine('{"status":"ready"}'), null);
  assert.equal(parseBridgeLine('{"type":"x"'), null);
});

test('createLineSplitter: joins chunks, keeps the partial tail until flush', () => {
  const lines = [];
  const s = createLineSplitter((l) => lines.push(l));
  s.push('{"a":1}\n{"b":');
  s.push('2}\n{"c"');
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}']);
  s.flush();
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}', '{"c"']);
});

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { ended: false, end() { this.ended = true; } };
  child.killed = false;
  child.kill = () => { child.killed = true; };
  return child;
}

function harness(opts = {}) {
  const children = [];
  const events = { notifications: [], statuses: [], errors: [], diags: [] };
  const timers = [];
  const bridge = createSystemNotificationBridge({
    spawn: () => { const c = fakeChild(); children.push(c); return c; },
    command: 'powershell.exe',
    args: ['-File', 'x.ps1'],
    onNotification: (n) => events.notifications.push(n),
    onStatus: (s) => events.statuses.push(s.status),
    onError: (e) => events.errors.push(e.code),
    onDiagnostic: (d) => events.diags.push(d),
    setTimeoutFn: (fn) => { timers.push(fn); return timers.length; },
    clearTimeoutFn: () => {},
    ...opts
  });
  return { bridge, children, events, timers, runTimers() { const t = timers.splice(0); t.forEach((fn) => fn()); } };
}

test('bridge: routes notification / status / error lines, tolerates malformed and unknown', () => {
  const h = harness();
  h.bridge.start();
  assert.equal(h.children.length, 1);
  const c = h.children[0];
  c.stdout.emit('data', '{"type":"status","status":"ready"}\n{"type":"notification","event":"added","id":1,"app":"Slack"}\nnot json\n');
  c.stdout.emit('data', '{"type":"weird"}\n{"type":"error","code":"POLL_FAILED","message":"m"}\n');
  c.stderr.emit('data', '[notification-bridge] diag\n');
  assert.deepEqual(h.events.statuses, ['ready']);
  assert.equal(h.events.notifications.length, 1);
  assert.equal(h.events.notifications[0].app, 'Slack');
  assert.deepEqual(h.events.errors, ['POLL_FAILED']);
  assert.ok(h.events.diags.some((d) => d.includes('unknown message type')));
  assert.ok(h.events.diags.includes('[notification-bridge] diag'));
  assert.equal(h.bridge.running, true);
  h.bridge.start(); // idempotent while running
  assert.equal(h.children.length, 1);
});

test('createLineSplitter: discards an oversized line instead of buffering it', () => {
  const lines = [];
  const s = createLineSplitter((l) => lines.push(l), 10);
  s.push('x'.repeat(20));
  s.push('yyy\n{"ok":1}\n');
  s.push('z'.repeat(11));
  s.flush();
  assert.deepEqual(lines, ['{"ok":1}']);
  s.push('w'.repeat(11) + '\n{"ok":2}\n'); // oversized *complete* line in one chunk
  assert.deepEqual(lines, ['{"ok":1}', '{"ok":2}']);
});

test('bridge: spawn error without exit still recovers (restart, then unavailable)', () => {
  const h = harness({ maxRestarts: 1 });
  h.bridge.start();
  h.children[0].emit('error', new Error('ENOENT'));
  assert.deepEqual(h.events.errors, ['SPAWN_FAILED']);
  assert.deepEqual(h.events.statuses, ['restarting']);
  h.runTimers();
  h.children[1].emit('error', new Error('ENOENT'));
  h.children[1].emit('exit', 1); // a late exit after error must not double-count
  h.runTimers();
  assert.equal(h.children.length, 2);
  assert.equal(h.events.statuses.at(-1), 'unavailable');
  assert.equal(h.bridge.running, false);
});

test('bridge: crash → restart up to the limit, then unavailable', () => {
  const h = harness({ maxRestarts: 2 });
  h.bridge.start();
  h.children[0].emit('exit', 1);
  assert.deepEqual(h.events.statuses, ['restarting']);
  h.runTimers();
  assert.equal(h.children.length, 2);
  h.children[1].emit('exit', null);
  h.runTimers();
  assert.equal(h.children.length, 3);
  h.children[2].emit('exit', 1);
  h.runTimers();
  assert.equal(h.children.length, 3); // no 4th launch
  assert.deepEqual(h.events.errors, ['BRIDGE_EXITED']);
  assert.equal(h.events.statuses.at(-1), 'unavailable');
  assert.equal(h.bridge.running, false);
});

test('bridge: fatal exit codes (no listener / access denied) are not retried', () => {
  for (const [code, status] of [[2, 'unavailable'], [3, 'permission_required']]) {
    const h = harness();
    h.bridge.start();
    h.children[0].emit('exit', code);
    h.runTimers();
    assert.equal(h.children.length, 1);
    assert.deepEqual(h.events.statuses, [status]);
  }
});

test('bridge: stop closes stdin, kills, and suppresses restarts; spawn failure is reported', () => {
  const h = harness();
  h.bridge.start();
  const c = h.children[0];
  h.bridge.stop();
  assert.equal(c.stdin.ended, true);
  assert.equal(c.killed, true);
  c.emit('exit', 1);
  h.runTimers();
  assert.equal(h.children.length, 1);
  assert.deepEqual(h.events.statuses, []);
  h.bridge.start(); // stopped bridges stay stopped
  assert.equal(h.children.length, 1);

  const events = [];
  const b = createSystemNotificationBridge({ spawn: () => { throw new Error('ENOENT'); }, command: 'x',
    onError: (e) => events.push(e.code), onStatus: (s) => events.push(s.status) });
  b.start();
  assert.deepEqual(events, ['SPAWN_FAILED', 'unavailable']);
});
