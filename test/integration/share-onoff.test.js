// Per-pane ON/OFF switches (no time limit): read sharing and input, both OFF by default; input only
// on top of read; OFF cascades and stops pending AI input; profile change / CLI exit (shell prompt)
// turn input OFF; pane end / integration off / app exit / restart leave everything OFF.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { IntegrationController } = require('../../src/integration');

const posixOnly = { skip: process.platform === 'win32' ? 'uses a Unix socket' : false };
const PROFILE = 'codex.0.160.composer.single-line';
const DAY = 24 * 60 * 60 * 1000;

function testTransport() {
  return () => (onConnection) => new Promise((resolve, reject) => {
    const endpoint = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wswb-o-sock-')), 's.sock');
    const srv = net.createServer(onConnection);
    srv.once('error', reject);
    srv.listen(endpoint, () => resolve({ close: () => new Promise((r) => srv.close(() => r())) }));
  });
}

async function setup({ settings = {}, clock = { t: 1_000_000 } } = {}) {
  let st = settings;
  const writes = [];
  const confirmations = [];
  const cancelled = [];
  const panes = [];
  const ctl = new IntegrationController({
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'wswb-o-')),
    readSettings: () => st,
    writeSettings: (p) => { st = { ...st, ...p }; return true; },
    now: () => clock.t, monotonic: () => clock.t,
    notifyView: (viewId, state) => panes.push(state),
    writePty: (viewId, termId, data) => { writes.push(data); return true; },
    requestConfirmation: (req) => confirmations.push(req),
    cancelConfirmation: (id) => cancelled.push(id),
    journalKey: () => crypto.randomBytes(32),
    secureTransport: testTransport()
  });
  await ctl.enable();
  ctl.rateLimiter.burst = 1000;
  ctl.rateLimiter.ratePerSec = 1000;
  await ctl.setInputEnabled(true);
  ctl.ptyStarted(1, 1, { distro: 'Ubuntu', wslPath: '/w' });
  const session = ctl.registry.bySlot(1, 1);
  const P = ctl.principal;
  const target = () => ctl.registry.target(session);
  const pane = () => ctl.paneState(1)[0];
  const prompt = (text) => ctl.broker.handle(P, 'workbench_write_input', {
    target: target(), expected_state_revision: String(session.stateRevision), idempotency_key: `k-${crypto.randomUUID()}`,
    input_contract: 'actions-v1', profile_id: PROFILE, profile_revision: '1',
    action: { type: 'text_and_submit', text, submit_key: 'Enter' }
  });
  const read = () => ctl.broker.handle(P, 'workbench_read_output', { target: target() });
  // operation:read goes away with the input switch, so tests look at the arbiter's record directly.
  const getOp = (id) => ctl.arbiter.ops.get(id);
  const banner = () => ctl.ptyData(1, 1, '>_ OpenAI Codex (v0.160.0)\r\n');
  const allOn = () => { ctl.share(1, 1); banner(); ctl.selectProfile(1, 1, PROFILE); ctl.grantInput(1, 1); };
  return { ctl, session, P, target, pane, prompt, read, getOp, allOn, banner, writes, confirmations, cancelled, panes, clock, settings: () => st };
}

test('1/8: both switches start OFF and the pane state names the combination', posixOnly, async () => {
  const t = await setup();
  try {
    assert.equal(t.pane().state, 'off');
    assert.equal(t.pane().shared, false);
    assert.equal(t.pane().input, false);
    assert.equal(t.pane().integration, true);
    t.panes.length = 0;
    t.ctl.ptyStarted(1, 9, { distro: 'Ubuntu', wslPath: '/w' }); // a new pane gets its OFF badge pushed
    assert.ok(t.panes.some((ps) => ps.some((p) => p.id === 9 && p.state === 'off')));
    assert.equal(t.read().error.code, 'SESSION_NOT_FOUND');
    t.ctl.share(1, 1);
    assert.equal(t.pane().state, 'read');
    t.banner();
    t.ctl.selectProfile(1, 1, PROFILE);
    t.ctl.grantInput(1, 1);
    assert.equal(t.pane().state, 'read_input');
    for (const p of ctl_panes(t)) assert.ok(!('expiresAt' in p) && !('inputExpiresAt' in p), 'no expiry fields');
  } finally { await t.ctl.shutdown(); }
});
function ctl_panes(t) { return t.ctl.paneState(1); }

test('2: nothing turns OFF by itself, however much time passes', posixOnly, async () => {
  const t = await setup();
  try {
    t.allOn();
    t.clock.t += 365 * DAY;
    t.ctl.sweep();
    assert.equal(t.pane().state, 'read_input');
    assert.equal(t.read().ok, true);
    assert.equal(t.prompt('hello').ok, true);
  } finally { await t.ctl.shutdown(); }
});

test('3: input needs read sharing; read OFF turns input OFF too', posixOnly, async () => {
  const t = await setup();
  try {
    t.ctl.selectProfile(1, 1, PROFILE);
    assert.throws(() => t.ctl.grantInput(1, 1), /Share this terminal first/);
    t.allOn();
    t.ctl.stopSharing(1, 1);
    assert.equal(t.pane().state, 'off');
    assert.equal(t.read().error.code, 'GRANT_REVOKED');
    // Read ON again: input stays OFF until turned on again.
    t.ctl.share(1, 1);
    assert.equal(t.pane().state, 'read');
    assert.equal(t.prompt('x').ok, false, 'no input on a re-shared pane until input is turned on again');
  } finally { await t.ctl.shutdown(); }
});

test('4: pane exit / pane close / integration off / app exit all turn both OFF', posixOnly, async () => {
  const t = await setup();
  try {
    t.allOn();
    t.ctl.ptyExited(1, 1);
    assert.equal(t.pane().state, 'off');
    t.ctl.ptyStarted(1, 1, { distro: 'Ubuntu', wslPath: '/w' }); // restarted pane = new generation, OFF
    assert.equal(t.pane().state, 'off');
    t.allOn();
    t.ctl.ptyClosed(1, 1);
    assert.equal(t.ctl.paneState(1).length, 0);
    assert.equal(t.ctl.access.grants.size, 0);
    t.ctl.ptyStarted(1, 2, { distro: 'Ubuntu', wslPath: '/w' });
    t.ctl.share(1, 2);
    await t.ctl.disable();
    assert.equal(t.ctl.access.grants.size, 0);
    assert.equal(t.ctl.paneState(1).every((p) => p.state === 'off' && p.integration === false), true);
  } finally { await t.ctl.shutdown(); }
});

test('4: a restart (new controller, same settings) starts with every pane OFF', posixOnly, async () => {
  const t = await setup();
  t.allOn();
  await t.ctl.shutdown();
  assert.equal(t.ctl.access.grants.size, 0);
  const saved = t.settings();
  assert.ok(!/grant|shared|input:write/.test(JSON.stringify(saved)), 'no switch state is persisted');
  const u = await setup({ settings: saved });
  try {
    assert.equal(u.ctl.enabled, true);
    assert.equal(u.pane().state, 'off');
    assert.equal(u.ctl.access.grants.size, 0);
  } finally { await u.ctl.shutdown(); }
});

test('5: every send still asks for the text and the Enter separately; profile and target are checked', posixOnly, async () => {
  const t = await setup();
  try {
    t.allOn();
    const r = t.prompt('one');
    assert.equal(r.ok, true);
    assert.equal(t.writes.length, 0);
    assert.equal(t.confirmations.at(-1).stage, 'initial');
    t.ctl.confirmOperation(r.operation_id, 'initial', 'approved');
    assert.deepEqual(t.writes, ['one']);
    assert.equal(t.confirmations.at(-1).stage, 'submit');
    t.ctl.confirmOperation(r.operation_id, 'submit', 'declined');
    assert.deepEqual(t.writes, ['one'], 'Enter only after its own confirmation');
    const wrong = t.ctl.broker.handle(t.P, 'workbench_write_input', {
      target: t.target(), expected_state_revision: String(t.session.stateRevision), idempotency_key: 'k-wrong',
      input_contract: 'actions-v1', profile_id: 'claude-code.2.1.prompt.single-line', profile_revision: '1', action: { type: 'text', text: 'x' }
    });
    assert.equal(wrong.ok, false);
  } finally { await t.ctl.shutdown(); }
});

test('6: changing the CLI profile turns input OFF (confirm again); read stays ON', posixOnly, async () => {
  const t = await setup();
  try {
    t.allOn();
    t.ctl.selectProfile(1, 1, null);
    assert.equal(t.pane().state, 'read');
    t.ctl.selectProfile(1, 1, PROFILE);
    assert.equal(t.pane().state, 'read', 'choosing a profile again does not turn input back on');
    t.ctl.grantInput(1, 1);
    t.ctl.selectProfile(1, 1, PROFILE); // same profile re-selected: no change, input stays
    assert.equal(t.pane().state, 'read_input');
  } finally { await t.ctl.shutdown(); }
});

test('6: the shell prompt coming back (OSC 7, i.e. the CLI exited) turns input OFF', posixOnly, async () => {
  const t = await setup();
  try {
    t.allOn();
    t.ctl.ptyData(1, 1, 'codex output without OSC 7\r\n');
    assert.equal(t.pane().state, 'read_input');
    const pending = t.prompt('queued');
    t.ctl.ptyData(1, 1, '\x1b]7;file:///home/u/p\x07user@host:~/p$ ');
    assert.equal(t.pane().state, 'read');
    assert.equal(t.getOp(pending.operation_id).status, 'failed');
    assert.equal(t.writes.length, 0);
    assert.equal(t.read().ok, true, 'read sharing continues');
  } finally { await t.ctl.shutdown(); }
});

test('7: OFF refuses new reads/inputs, cancels pending confirmations, never re-sends dispatched input', posixOnly, async () => {
  const t = await setup();
  try {
    t.allOn();
    // (a) awaiting the first confirmation -> failed, dialog closed, nothing written
    const a = t.prompt('a');
    t.ctl.revokeInput(1, 1);
    assert.equal(t.getOp(a.operation_id).status, 'failed');
    assert.ok(t.cancelled.includes(a.operation_id));
    assert.equal(t.writes.length, 0);
    assert.equal(t.prompt('again').ok, false);

    // (b) text already typed, waiting for the Enter confirmation -> outcome_unknown, no Enter, no resend
    t.ctl.grantInput(1, 1);
    const b = t.prompt('b');
    t.ctl.confirmOperation(b.operation_id, 'initial', 'approved');
    assert.deepEqual(t.writes, ['b']);
    t.ctl.stopSharing(1, 1);
    assert.equal(t.getOp(b.operation_id).status, 'outcome_unknown');
    assert.ok(t.cancelled.includes(b.operation_id));
    t.ctl.confirmOperation(b.operation_id, 'submit', 'approved'); // a late click does nothing
    await new Promise((r) => setTimeout(r, 1200));
    assert.deepEqual(t.writes, ['b'], 'no Enter, no re-send');
    assert.equal(t.read().error.code, 'GRANT_REVOKED');
  } finally { await t.ctl.shutdown(); }
});

test('codex: an Input ON dialog approved after the CLI exited / profile changed / pane exited does nothing', posixOnly, async () => {
  const t = await setup();
  try {
    t.ctl.share(1, 1);
    t.banner();
    t.ctl.selectProfile(1, 1, PROFILE);
    let shown = t.ctl.inputTarget(1, 1);
    t.ctl.ptyData(1, 1, '\x1b]7;file:///w\x07$ '); // CLI exited while the dialog was open
    t.banner(); // ...and started again
    assert.throws(() => t.ctl.grantInput(1, 1, shown), /changed while the dialog was open/);
    shown = t.ctl.inputTarget(1, 1);
    t.ctl.selectProfile(1, 1, null);
    t.ctl.selectProfile(1, 1, PROFILE);
    assert.throws(() => t.ctl.grantInput(1, 1, shown), /changed while the dialog was open/);
    shown = t.ctl.inputTarget(1, 1);
    t.ctl.stopSharing(1, 1); // Read OFF -> ON while the dialog is open: a new grant, stale approval
    t.ctl.share(1, 1);
    t.banner(); // (the CLI identity is forgotten while not sharing; seen again)
    assert.throws(() => t.ctl.grantInput(1, 1, shown), /changed while the dialog was open/);
    shown = t.ctl.inputTarget(1, 1);
    t.ctl.grantInput(1, 1, shown); // unchanged: ok
    assert.equal(t.pane().state, 'read_input');
    t.ctl.ptyExited(1, 1);
    assert.throws(() => t.ctl.share(1, 1), /not running/, 'a Read ON dialog approved after exit does nothing');
    assert.equal(t.pane().state, 'off');
  } finally { await t.ctl.shutdown(); }
});
