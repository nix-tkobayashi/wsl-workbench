// Per-pane "skip the send confirmation": OFF by default; opt-in per pane / session / grant / profile;
// only Workbench's dialogs are skipped (checks, order, delay, idempotency, journal, takeover stay);
// waiting operations are never bulk-approved; every OFF path clears it; mid-operation stops never
// re-send. Also re-checks the normal (confirmed) mode.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { IntegrationController } = require('../../src/integration');

const posixOnly = { skip: process.platform === 'win32' ? 'uses a Unix socket' : false };
const CODEX = 'codex.0.160.composer.single-line';
const CLAUDE = 'claude-code.2.1.prompt.single-line';
const tick = () => new Promise((r) => setImmediate(r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function testTransport() {
  return () => (onConnection) => new Promise((resolve, reject) => {
    const endpoint = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wswb-a-sock-')), 's.sock');
    const srv = net.createServer(onConnection);
    srv.once('error', reject);
    srv.listen(endpoint, () => resolve({ close: () => new Promise((r) => srv.close(() => r())) }));
  });
}

async function setup({ settings = {} } = {}) {
  let st = settings;
  const writes = [];
  const confirmations = [];
  const audits = [];
  const ctl = new IntegrationController({
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'wswb-a-')),
    readSettings: () => st,
    writeSettings: (p) => { st = { ...st, ...p }; return true; },
    writePty: (viewId, termId, data) => { writes.push([termId, data]); return true; },
    requestConfirmation: (req) => confirmations.push(req),
    cancelConfirmation: () => {},
    journalKey: () => crypto.randomBytes(32),
    secureTransport: testTransport()
  });
  await ctl.enable();
  const rec = ctl.audit.record.bind(ctl.audit);
  ctl.audit.record = (e) => { audits.push(e); rec(e); };
  ctl.rateLimiter.burst = 1000;
  ctl.rateLimiter.ratePerSec = 1000;
  await ctl.setInputEnabled(true);
  const pane = (termId = 1, profile = CLAUDE) => {
    ctl.ptyStarted(1, termId, { distro: 'Ubuntu', wslPath: '/w' });
    ctl.share(1, termId);
    ctl.selectProfile(1, termId, profile);
    ctl.grantInput(1, termId);
    return ctl.registry.bySlot(1, termId);
  };
  const send = (session, text, { profile = CLAUDE, idem } = {}) => ctl.broker.handle(ctl.principal, 'workbench_write_input', {
    target: ctl.registry.target(session), expected_state_revision: String(session.stateRevision), idempotency_key: idem || `k-${crypto.randomUUID()}`,
    input_contract: 'actions-v1', profile_id: profile, profile_revision: '1',
    action: { type: 'text_and_submit', text, submit_key: 'Enter' }
  });
  const enableAuto = (termId = 1) => ctl.enableAutoConfirm(1, termId, ctl.inputTarget(1, termId));
  const op = (id) => ctl.arbiter.ops.get(id);
  const state = (termId = 1) => ctl.paneState(1).find((p) => p.id === termId);
  return { ctl, writes, confirmations, audits, pane, send, enableAuto, op, state, settings: () => st };
}

test('normal mode (default): both steps wait for the dialog; nothing is sent without it', posixOnly, async () => {
  const t = await setup();
  try {
    const s = t.pane();
    assert.equal(t.state().autoConfirm, false);
    const r = t.send(s, 'hello');
    await tick();
    assert.equal(t.writes.length, 0);
    assert.equal(t.confirmations.length, 1);
    t.ctl.confirmOperation(r.operation_id, 'initial', 'approved');
    assert.deepEqual(t.writes, [[1, 'hello']]);
    assert.equal(t.confirmations.at(-1).stage, 'submit');
    t.ctl.confirmOperation(r.operation_id, 'submit', 'approved');
    await sleep(700);
    assert.deepEqual(t.writes, [[1, 'hello'], [1, '\r']]);
    assert.equal(t.op(r.operation_id).status, 'delivered');
  } finally { await t.ctl.shutdown(); }
});

test('skip mode: text, then Enter after the profile delay, no dialogs; checks/journal/audit stay', posixOnly, async () => {
  const t = await setup();
  try {
    const s = t.pane();
    assert.throws(() => t.ctl.enableAutoConfirm(1, 1, null), /changed while the dialog/);
    t.enableAuto();
    assert.equal(t.state().autoConfirm, true);
    const r = t.send(s, 'ツールを使わず、OKとだけ返してください');
    assert.equal(r.ok, true);
    assert.equal(t.writes.length, 0, 'never written synchronously from the tool call');
    await tick();
    assert.deepEqual(t.writes, [[1, 'ツールを使わず、OKとだけ返してください']]);
    await tick();
    assert.equal(t.writes.length, 1, 'Enter waits for the profile delay');
    await sleep(700);
    assert.deepEqual(t.writes.map((w) => w[1]), ['ツールを使わず、OKとだけ返してください', '\r']);
    assert.equal(t.confirmations.length, 0);
    assert.equal(t.op(r.operation_id).status, 'delivered');
    assert.deepEqual(t.audits.filter((e) => e.event === 'auto_confirmed').map((e) => e.stage), ['initial', 'submit']);
    // Duplicate-send protection: the same idempotency key only looks the operation up.
    const args = {
      target: t.ctl.registry.target(s), expected_state_revision: String(s.stateRevision), idempotency_key: 'same-key',
      input_contract: 'actions-v1', profile_id: CLAUDE, profile_revision: '1', action: { type: 'text_and_submit', text: 'dup', submit_key: 'Enter' }
    };
    const again = t.ctl.broker.handle(t.ctl.principal, 'workbench_write_input', args);
    await sleep(700);
    const replay = t.ctl.broker.handle(t.ctl.principal, 'workbench_write_input', args);
    assert.equal(replay.operation_id, again.operation_id);
    await sleep(700);
    assert.equal(t.writes.filter((w) => w[1] === 'dup').length, 1);
    // Profile is still checked: naming another profile is refused.
    assert.equal(t.send(s, 'x', { profile: CODEX }).ok, false);
  } finally { await t.ctl.shutdown(); }
});

test('turning it on never approves operations that were already waiting', posixOnly, async () => {
  const t = await setup();
  try {
    const s = t.pane();
    const waiting = t.send(s, 'old');
    await tick();
    t.enableAuto();
    await tick();
    assert.equal(t.writes.length, 0, 'the waiting operation is not sent');
    assert.equal(t.op(waiting.operation_id).awaiting, 'initial');
    t.ctl.confirmOperation(waiting.operation_id, 'initial', 'approved'); // its own dialog
    assert.equal(t.confirmations.at(-1).stage, 'submit', 'and its Enter is still confirmed');
  } finally { await t.ctl.shutdown(); }
});

test('scope: only this pane / session / profile; other panes keep their dialogs', posixOnly, async () => {
  const t = await setup();
  try {
    const s1 = t.pane(1);
    const s2 = t.pane(2);
    t.enableAuto(1);
    assert.equal(t.state(2).autoConfirm, false);
    t.send(s2, 'other');
    await tick();
    assert.equal(t.writes.length, 0);
    assert.equal(t.confirmations.length, 1);
    t.send(s1, 'mine');
    await tick();
    assert.deepEqual(t.writes, [[1, 'mine']]);
  } finally { await t.ctl.shutdown(); }
});

test('every OFF path clears it, and a restart starts without it', posixOnly, async () => {
  const t = await setup();
  try {
    const cases = [
      ['input off', () => t.ctl.revokeInput(1, 1)],
      ['read off', () => t.ctl.stopSharing(1, 1)],
      ['profile change', () => t.ctl.selectProfile(1, 1, CODEX)],
      ['shell prompt (CLI exited)', () => t.ctl.ptyData(1, 1, '\x1b]7;file:///w\x07$ ')],
      ['terminal input off', async () => { await t.ctl.setInputEnabled(false); await t.ctl.setInputEnabled(true); }],
      ['pane exit', () => t.ctl.ptyExited(1, 1)],
      ['user turns it off', () => t.ctl.disableAutoConfirm(1, 1)]
    ];
    for (const [name, off] of cases) {
      const s = t.pane();
      t.enableAuto();
      assert.equal(t.state().autoConfirm, true, name);
      await off();
      assert.equal(!!(t.ctl.registry.bySlot(1, 1) || {}).autoConfirm, false, name);
      assert.ok(!(t.state() && t.state().autoConfirm), name);
      // Turning input back on does not bring it back.
      if (t.ctl.sessionFor(1, 1) && t.ctl.sessionFor(1, 1).lifecycle === 'alive') {
        if (!t.ctl.access.active(s.sessionId)) t.ctl.share(1, 1);
        t.ctl.selectProfile(1, 1, CLAUDE);
        try { t.ctl.grantInput(1, 1); } catch {}
        assert.equal(t.state().autoConfirm, false, `${name}: not restored`);
      }
    }
    t.pane();
    t.enableAuto();
    await t.ctl.disable();
    assert.equal(t.ctl.registry.bySlot(1, 1).autoConfirm, null, 'integration off');
  } finally { await t.ctl.shutdown(); }
  const saved = t.settings();
  assert.ok(!/autoConfirm|auto_confirm/.test(JSON.stringify(saved)), 'never persisted');
});

test('stops mid-operation: setting off / human typing / input off before Enter -> no Enter, never re-sent', posixOnly, async () => {
  for (const stop of [
    (t) => t.ctl.disableAutoConfirm(1, 1),
    (t) => t.ctl.userInput(1, 1, 'x'),
    (t) => t.ctl.revokeInput(1, 1)
  ]) {
    const t = await setup();
    try {
      const s = t.pane();
      t.enableAuto();
      const r = t.send(s, 'half');
      await tick();
      assert.deepEqual(t.writes, [[1, 'half']]);
      stop(t);
      await sleep(800);
      assert.deepEqual(t.writes, [[1, 'half']], 'no Enter after the stop');
      assert.equal(t.op(r.operation_id).status, 'outcome_unknown');
      assert.equal(t.confirmations.length, 0, 'no dialog appears half-way either');
    } finally { await t.ctl.shutdown(); }
  }
});

test('turning it off before the text is sent stops the operation (failed, nothing sent)', posixOnly, async () => {
  const t = await setup();
  try {
    const s = t.pane();
    t.enableAuto();
    const r = t.send(s, 'never');
    t.ctl.disableAutoConfirm(1, 1); // same tick, before the auto-approval runs
    await sleep(50);
    assert.equal(t.writes.length, 0);
    assert.equal(t.op(r.operation_id).status, 'failed');
  } finally { await t.ctl.shutdown(); }
});

test('codex: consent from before an Input OFF -> ON cycle (or terminal input off/on) is stale', posixOnly, async () => {
  const t = await setup();
  try {
    t.pane();
    let snap = t.ctl.inputTarget(1, 1);
    t.ctl.revokeInput(1, 1);
    t.ctl.grantInput(1, 1);
    assert.throws(() => t.ctl.enableAutoConfirm(1, 1, snap), /changed while the dialog/);
    snap = t.ctl.inputTarget(1, 1);
    await t.ctl.setInputEnabled(false);
    await t.ctl.setInputEnabled(true);
    t.ctl.grantInput(1, 1);
    assert.throws(() => t.ctl.enableAutoConfirm(1, 1, snap), /changed while the dialog/);
    t.ctl.enableAutoConfirm(1, 1, t.ctl.inputTarget(1, 1));
    assert.equal(t.state().autoConfirm, true);
  } finally { await t.ctl.shutdown(); }
});
