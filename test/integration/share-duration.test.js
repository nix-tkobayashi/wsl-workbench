// Sharing durations (30 min / 2 h / 8 h), the "ends soon" notice + extend, separate short input
// expiry, and no re-sharing after a restart. Fake wall + monotonic clocks.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { AccessControl, SHARE_DURATIONS_MS, INPUT_GRANT_MS, normalizeShareDuration } = require('../../src/integration/access-control');
const { IntegrationController, EXPIRY_WARNING_MS } = require('../../src/integration');

const MIN = 60 * 1000;
const posixOnly = { skip: process.platform === 'win32' ? 'uses a Unix socket' : false };

function clocks() {
  const c = { wall: 1_000_000, mono: 5_000 };
  c.now = () => c.wall;
  c.monotonic = () => c.mono;
  c.advance = (ms) => { c.wall += ms; c.mono += ms; };
  return c;
}

test('normalizeShareDuration accepts only the offered durations', () => {
  assert.deepEqual(SHARE_DURATIONS_MS, [30 * MIN, 120 * MIN, 480 * MIN]);
  for (const ms of SHARE_DURATIONS_MS) assert.equal(normalizeShareDuration(ms), ms);
  for (const bad of [undefined, null, 0, -1, 31 * MIN, 24 * 60 * MIN, '7200000', NaN]) assert.equal(normalizeShareDuration(bad), 30 * MIN);
});

test('extend uses the duration chosen when sharing, from now; never stacks', () => {
  const c = clocks();
  const ac = new AccessControl({ now: c.now, monotonic: c.monotonic });
  const g = ac.issue({ principal: 'p', sessionId: 's', generation: 1, durationMs: 120 * MIN });
  c.advance(100 * MIN);
  assert.equal(ac.remainingMs(g), 20 * MIN);
  ac.extend('s');
  assert.equal(ac.remainingMs(g), 120 * MIN);
  ac.extend('s');
  assert.equal(ac.remainingMs(g), 120 * MIN, 'extending again does not add up');
});

test('input has its own short expiry, capped by the read grant; extending the share does not extend input', () => {
  const c = clocks();
  const ended = [];
  const ac = new AccessControl({ now: c.now, monotonic: c.monotonic, onInputEnd: (g) => ended.push(g.session_id) });
  const g = ac.issue({ principal: 'p', sessionId: 's', generation: 1, durationMs: 480 * MIN });
  ac.grantInput(g);
  assert.equal(ac.inputRemainingMs(g), INPUT_GRANT_MS);
  assert.equal(ac.check('p', 's', 1, 'input:write').ok, true);
  c.advance(INPUT_GRANT_MS - 1000);
  ac.extend('s');
  assert.equal(ac.inputRemainingMs(g), 1000, 'input not extended');
  c.advance(1000);
  assert.equal(ac.check('p', 's', 1, 'input:write').code, 'FORBIDDEN');
  assert.equal(ac.check('p', 's', 1, 'operation:read').code, 'FORBIDDEN');
  assert.equal(ac.check('p', 's', 1, 'output:read').ok, true, 'reading continues');
  assert.deepEqual(ended, ['s']);

  // Near the end of a short share, input never outlasts it.
  const g2 = ac.issue({ principal: 'p', sessionId: 't', generation: 1, durationMs: 30 * MIN });
  c.advance(25 * MIN);
  ac.grantInput(g2);
  assert.equal(ac.inputRemainingMs(g2), 5 * MIN);
});

test('input expiry also applies when only the monotonic clock moves (sleep / clock change)', () => {
  const c = clocks();
  const ac = new AccessControl({ now: c.now, monotonic: c.monotonic });
  const g = ac.issue({ principal: 'p', sessionId: 's', generation: 1, durationMs: 480 * MIN });
  ac.grantInput(g);
  c.mono += INPUT_GRANT_MS; // wall clock set back / frozen
  assert.equal(ac.check('p', 's', 1, 'input:write').code, 'FORBIDDEN');
  ac.grantInput(g);
  c.wall += INPUT_GRANT_MS; // or the wall clock jumps
  assert.equal(ac.check('p', 's', 1, 'input:write').code, 'FORBIDDEN');
});

function testTransport() {
  return () => (onConnection) => new Promise((resolve, reject) => {
    const endpoint = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wswb-d-sock-')), 's.sock');
    const srv = net.createServer(onConnection);
    srv.once('error', reject);
    srv.listen(endpoint, () => resolve({ close: () => new Promise((r) => srv.close(() => r())) }));
  });
}

async function controller({ settings = {}, c = clocks() } = {}) {
  let st = settings;
  const notices = [];
  const ctl = new IntegrationController({
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'wswb-d-')),
    readSettings: () => st,
    writeSettings: (p) => { st = { ...st, ...p }; return true; },
    now: c.now, monotonic: c.monotonic,
    journalKey: () => crypto.randomBytes(32),
    secureTransport: testTransport(),
    notifyExpiring: (info) => notices.push(info)
  });
  return { ctl, notices, c, settings: () => st };
}

test('the "ends soon" notice fires once per expiry, carries the incarnation, and resets on extend', posixOnly, async () => {
  const { ctl, notices, c } = await controller();
  await ctl.enable();
  try {
    ctl.ptyStarted(1, 1, { distro: 'Ubuntu', wslPath: '/w' });
    ctl.share(1, 1, { durationMs: 120 * MIN });
    ctl.sweep();
    assert.equal(notices.length, 0);
    c.advance(120 * MIN - EXPIRY_WARNING_MS);
    ctl.sweep();
    ctl.sweep();
    assert.equal(notices.length, 1);
    const n = notices[0];
    assert.equal(n.durationMs, 120 * MIN);
    assert.equal(ctl.paneState(1)[0].expiringSoon, true);

    // A stale notice (pane restarted, or the grant replaced by a re-share) extends nothing.
    assert.equal(ctl.extend(1, 1, { sessionId: n.sessionId, generation: n.generation + 1, grantId: n.grantId }), null);
    assert.equal(ctl.extend(1, 1, { sessionId: n.sessionId, generation: n.generation, grantId: 'other' }), null);
    assert.ok(ctl.extend(1, 1, { sessionId: n.sessionId, generation: n.generation, grantId: n.grantId }));
    assert.equal(ctl.paneState(1)[0].expiringSoon, false);
    assert.equal(ctl.paneState(1)[0].expiresAt, c.wall + 120 * MIN);
    c.advance(120 * MIN - EXPIRY_WARNING_MS);
    ctl.sweep();
    assert.equal(notices.length, 2, 'warned again for the new expiry');
    // Stop + re-share the same pane: the old notice must not extend the new grant.
    const old = notices[1];
    ctl.stopSharing(1, 1);
    ctl.share(1, 1, { durationMs: 30 * MIN });
    assert.equal(ctl.extend(1, 1, { sessionId: old.sessionId, generation: old.generation, grantId: old.grantId }), null);
  } finally { await ctl.shutdown(); }
});

test('input expires on its own (audited, pane updated) while reading continues', posixOnly, async () => {
  const { ctl, c } = await controller();
  await ctl.enable();
  try {
    await ctl.setInputEnabled(true);
    ctl.ptyStarted(1, 1, { distro: 'Ubuntu', wslPath: '/w' });
    ctl.share(1, 1, { durationMs: 480 * MIN });
    ctl.selectProfile(1, 1, 'codex.0.160.composer.single-line');
    ctl.grantInput(1, 1);
    let pane = ctl.paneState(1)[0];
    assert.equal(pane.input, true);
    assert.equal(pane.inputExpiresAt, c.wall + INPUT_GRANT_MS);
    ctl.extend(1, 1);
    assert.equal(ctl.paneState(1)[0].inputExpiresAt, c.wall + INPUT_GRANT_MS, 'share extension leaves input alone');
    c.advance(INPUT_GRANT_MS);
    ctl.sweep();
    pane = ctl.paneState(1)[0];
    assert.equal(pane.shared, true);
    assert.equal(pane.input, false);
    assert.equal(pane.inputExpiresAt, null);
  } finally { await ctl.shutdown(); }
});

test('a restart never re-shares: the remembered duration is only a default', posixOnly, async () => {
  const first = await controller();
  await first.ctl.enable();
  first.ctl.ptyStarted(1, 1, { distro: 'Ubuntu', wslPath: '/w' });
  first.ctl.share(1, 1, { durationMs: 480 * MIN });
  first.ctl.saveIntegration({ shareDurationMs: 480 * MIN });
  await first.ctl.shutdown();
  const saved = first.settings();
  assert.equal(saved.integration.shareDurationMs, 480 * MIN);
  assert.ok(!JSON.stringify(saved).includes('grant'), 'no grant is persisted');

  const second = await controller({ settings: saved });
  await second.ctl.start(); // integration stays on, listener resumes
  try {
    assert.equal(second.ctl.enabled, true);
    second.ctl.ptyStarted(1, 1, { distro: 'Ubuntu', wslPath: '/w' });
    assert.equal(second.ctl.paneState(1)[0].shared, false);
    assert.equal(second.ctl.access.grants.size, 0);
  } finally { await second.ctl.shutdown(); }
});
