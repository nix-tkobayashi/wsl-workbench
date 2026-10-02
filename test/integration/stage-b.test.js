// Stage B (input) acceptance tests on mock PTYs and synthetic input only (B01–B10 at mock level).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { IntegrationController } = require('../../src/integration');
const { OperationStore } = require('../../src/integration/operation-store');
const { validate, WRITE_INPUT_OUTPUT_SCHEMA, GET_OPERATION_OUTPUT_SCHEMA, listedTools } = require('../../src/mcp/schemas');

const posixOnly = { skip: process.platform === 'win32' ? 'uses a Unix socket' : false };
const PROFILE = 'codex.0.160.composer.single-line';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A "verified" transport for tests: a plain Unix socket standing in for the DACL relay.
function testTransport() {
  return () => (onConnection) => new Promise((resolve, reject) => {
    const endpoint = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wswb-b-sock-')), 's.sock');
    const srv = net.createServer(onConnection);
    srv.once('error', reject);
    srv.listen(endpoint, () => resolve({ close: () => new Promise((r) => srv.close(() => r())) }));
  });
}

async function setup({ inputOn = true, key = crypto.randomBytes(32), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wswb-b-')), writeFails = false } = {}) {
  let settings = {};
  const writes = [];
  const confirmations = [];
  const cancelled = [];
  const ctl = new IntegrationController({
    userDataDir: dir,
    appVersion: 'test',
    readSettings: () => settings,
    writeSettings: (patch) => { settings = { ...settings, ...patch }; return true; },
    writePty: (viewId, termId, data) => { if (writeFails) throw new Error('boom'); writes.push(data); return true; },
    requestConfirmation: (req) => confirmations.push(req),
    cancelConfirmation: (id) => cancelled.push(id),
    journalKey: () => key,
    secureTransport: testTransport()
  });
  await ctl.enable();
  ctl.rateLimiter.burst = 1000; // per-principal call limit is covered elsewhere; these tests make many calls
  ctl.rateLimiter.ratePerSec = 1000;
  if (inputOn) await ctl.setInputEnabled(true);
  ctl.ptyStarted(1, 1, { distro: 'Ubuntu', wslPath: '/w' });
  ctl.share(1, 1);
  const session = ctl.registry.bySlot(1, 1);
  const P = ctl.principal;
  const target = () => ctl.registry.target(session);
  const rev = () => String(session.stateRevision);
  function prepare() {
    ctl.selectProfile(1, 1, PROFILE);
    ctl.grantInput(1, 1);
  }
  function write(extra) {
    return ctl.broker.handle(P, 'workbench_write_input', { target: target(), expected_state_revision: rev(), idempotency_key: `k-${crypto.randomUUID()}`, ...extra });
  }
  function prompt(text, idem) {
    return ctl.broker.handle(P, 'workbench_write_input', {
      target: target(), expected_state_revision: rev(), idempotency_key: idem || `k-${crypto.randomUUID()}`,
      input_contract: 'actions-v1', profile_id: PROFILE, profile_revision: '1',
      action: { type: 'text_and_submit', text, submit_key: 'Enter' }
    });
  }
  const getOp = (id, wait_ms = 0) => ctl.broker.handle(P, 'workbench_get_operation', { operation_id: id, wait_ms });
  return { ctl, session, P, target, rev, prepare, write, prompt, getOp, writes, confirmations, cancelled, dir, key };
}

test('B01: input is off by default; read tools only; command execution stays false', posixOnly, async () => {
  const t = await setup({ inputOn: false });
  try {
    const caps = t.ctl.broker.handle(t.P, 'workbench_capabilities', {});
    assert.equal(caps.features.input_write, false);
    assert.equal(caps.features.command_execution, false);
    assert.equal(caps.extensions.write_input_actions_v1.enabled, false);
    assert.equal(caps.extensions.write_input_actions_v1.transport_write_gate, 'reviewed');
    assert.equal(t.write({ text: 'hi' }).error.code, 'UNSUPPORTED');
    assert.deepEqual(listedTools({ inputEnabled: false }).map((x) => x.name).includes('workbench_write_input'), false);
    assert.throws(() => t.ctl.grantInput(1, 1), /not enabled/);
    assert.equal(t.writes.length, 0);
  } finally { await t.ctl.shutdown(); }
});

test('B01: without a verified transport input cannot even be enabled', posixOnly, async () => {
  let settings = {};
  const ctl = new IntegrationController({
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'wswb-b-')),
    readSettings: () => settings, writeSettings: (p) => { settings = { ...settings, ...p }; },
    journalKey: () => crypto.randomBytes(32)
  });
  await ctl.enable(); // Linux: no relay -> plain socket, gate blocked
  try {
    assert.equal(ctl.status().transportGate, 'blocked');
    await assert.rejects(ctl.setInputEnabled(true));
    assert.equal(ctl.broker.handle(ctl.principal, 'workbench_capabilities', {}).extensions.write_input_actions_v1.transport_write_gate, 'blocked');
  } finally { await ctl.shutdown(); }
});

test('happy path: text_and_submit = confirm, text, confirm, delay, Enter; results match the output schemas', posixOnly, async () => {
  const t = await setup();
  try {
    t.prepare();
    const caps = t.ctl.broker.handle(t.P, 'workbench_capabilities', {});
    assert.equal(caps.features.input_write, true);
    assert.deepEqual(caps.extensions.write_input_actions_v1.profiles.map((p) => p.id), [PROFILE, 'claude-code.2.1.prompt.single-line']);
    const view = t.ctl.broker.handle(t.P, 'workbench_get_session', { target: t.target() });
    assert.deepEqual(view.effective_permissions, ['input:write', 'operation:read', 'output:read', 'session:list']);
    assert.equal(view.input_profile.id, PROFILE);
    assert.equal(view.input_profile.foreground_verified, false);

    const text = '変更はせず、現在の差分を説明してください。 😀 é';
    const r = t.prompt(text);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(validate(WRITE_INPUT_OUTPUT_SCHEMA, r).ok, true, validate(WRITE_INPUT_OUTPUT_SCHEMA, r).message);
    assert.equal(r.status, 'accepted');
    assert.equal(r.phase, 'awaiting_user');
    assert.equal(r.next_action, 'wait_operation');
    assert.ok(!JSON.stringify(r).includes('変更はせず')); // results never echo the prompt
    assert.equal(t.writes.length, 0); // nothing before the local confirmation
    assert.equal(t.confirmations.length, 1);
    assert.equal(t.confirmations[0].text, text);
    assert.equal(t.confirmations[0].submit, true);

    t.ctl.confirmOperation(r.operation_id, 'initial', 'approved');
    assert.deepEqual(t.writes, [text]); // exact bytes, no normalization; Enter NOT yet
    let op = await t.getOp(r.operation_id);
    assert.equal(op.phase, 'awaiting_submit_confirmation');
    assert.equal(op.delivery.text_state, 'library_accepted');
    assert.equal(op.delivery.submit_state, 'not_started');
    assert.equal(t.confirmations[1].stage, 'submit');

    t.ctl.confirmOperation(r.operation_id, 'submit', 'approved');
    op = await t.getOp(r.operation_id, 3000); // long poll until the profile delay passes
    assert.equal(op.status, 'delivered', JSON.stringify(op));
    assert.deepEqual(t.writes, [text, '\r']); // separate writes: text, then Enter after the delay
    assert.equal(validate(GET_OPERATION_OUTPUT_SCHEMA, op).ok, true, validate(GET_OPERATION_OUTPUT_SCHEMA, op).message);
    assert.equal(op.delivery.submit_state, 'library_accepted');
    assert.equal(op.delivery.cli_acceptance, 'unknown');
    assert.equal(op.exit_code, null);
    assert.equal(op.bytes_written, null);
    assert.equal(op.delivery.encoded_bytes_offered, Buffer.byteLength(text) + 1);
    assert.equal(op.next_action, 'read_output');
  } finally { await t.ctl.shutdown(); }
});

test('B04: legacy text / key keep their meaning; mixed or unknown forms are rejected', posixOnly, async () => {
  const t = await setup();
  try {
    t.prepare();
    const a = t.write({ text: 'ls' });
    t.ctl.confirmOperation(a.operation_id, 'initial', 'approved');
    assert.deepEqual(t.writes, ['ls']);
    assert.equal((await t.getOp(a.operation_id)).status, 'delivered');
    const b = t.write({ key: 'Enter' });
    t.ctl.confirmOperation(b.operation_id, 'initial', 'approved');
    assert.deepEqual(t.writes, ['ls', '\r']);
    assert.equal(t.write({ key: 'Tab' }).error.code, 'UNSUPPORTED'); // not verified for the profile
    assert.equal(t.write({ text: 'x', key: 'Enter' }).error.code, 'INPUT_INVALID');
    assert.equal(t.write({ text: 'x', input_contract: 'actions-v1' }).error.code, 'INPUT_INVALID');
    assert.equal(t.write({ input_contract: 'actions-v2', profile_id: PROFILE, profile_revision: '1', action: { type: 'text', text: 'x' } }).error.code, 'INPUT_INVALID');
    assert.equal(t.write({ input_contract: 'actions-v1', profile_id: PROFILE, profile_revision: '1', action: { type: 'paste', text: 'x' } }).error.code, 'INPUT_INVALID');
    const wrongRev = t.write({ input_contract: 'actions-v1', profile_id: PROFILE, profile_revision: '2', action: { type: 'text', text: 'x' } });
    assert.equal(wrongRev.error.code, 'STATE_CONFLICT');
    const err = t.write({ text: 'x', key: 'Enter' });
    assert.equal(validate(WRITE_INPUT_OUTPUT_SCHEMA, err).ok, true);
  } finally { await t.ctl.shutdown(); }
});

test('B05: text rules — no CR/LF/Tab/ESC/C0/C1/lone surrogates, 8192-byte limit, exact bytes kept', posixOnly, async () => {
  const t = await setup();
  try {
    t.prepare();
    const act = (text) => t.write({ input_contract: 'actions-v1', profile_id: PROFILE, profile_revision: '1', action: { type: 'text', text } });
    for (const bad of ['a\nb', 'a\r\nb', 'a\rb', 'a\tb', 'a\x1b[200~b', 'a\x00b', 'a\x7fb', 'a\u0085b', 'a\uD800b']) {
      assert.equal(act(bad).ok, false, JSON.stringify(bad));
    }
    assert.equal(act('あ'.repeat(2731)).error.code, 'INPUT_TOO_LARGE'); // 8193 bytes
    const max = 'a'.repeat(8189) + 'あ'; // exactly 8192 bytes
    const ok = act(max);
    assert.equal(ok.ok, true);
    t.ctl.confirmOperation(ok.operation_id, 'initial', 'approved');
    const combining = 'é ｶﾞ 👩‍💻 end  ';
    const r = act(combining);
    t.ctl.confirmOperation(r.operation_id, 'initial', 'approved');
    assert.deepEqual(t.writes, [max, combining]);
    assert.equal(t.writes.join('').includes('\r'), false);
  } finally { await t.ctl.shutdown(); }
});

test('B02: human typing stops the remaining AI input and pauses AI input until re-enabled', posixOnly, async () => {
  const t = await setup();
  try {
    t.prepare();
    // before dispatch -> failed, nothing written
    const a = t.prompt('one');
    t.ctl.userInput(1, 1, 'x');
    let op = await t.getOp(a.operation_id);
    assert.equal(op.status, 'failed');
    assert.equal(op.error.code, 'USER_INTERVENED');
    assert.equal(op.user_intervened, true);
    assert.equal(t.writes.length, 0);
    assert.ok(t.cancelled.includes(a.operation_id)); // the dialog is closed
    assert.equal(t.prompt('two').error.code, 'USER_INTERVENED');
    t.ctl.resumeInput(1, 1);
    // after the text, before Enter -> outcome_unknown, Enter never sent
    const b = t.prompt('three');
    t.ctl.confirmOperation(b.operation_id, 'initial', 'approved');
    t.ctl.userInput(1, 1, '\x1b[O'); // focus report from the dialog stealing focus: NOT a human
    op = await t.getOp(b.operation_id);
    assert.equal(op.phase, 'awaiting_submit_confirmation');
    t.ctl.userInput(1, 1, 'q');
    op = await t.getOp(b.operation_id);
    assert.equal(op.status, 'outcome_unknown');
    assert.equal(op.delivery.text_state, 'library_accepted');
    assert.equal(op.delivery.submit_state, 'not_started');
    t.ctl.confirmOperation(b.operation_id, 'submit', 'approved'); // a late answer is ignored
    await sleep(700);
    assert.deepEqual(t.writes, ['three']);
  } finally { await t.ctl.shutdown(); }
});

test('takeover from the UI behaves like human input', posixOnly, async () => {
  const t = await setup();
  try {
    t.prepare();
    const a = t.prompt('x');
    t.ctl.takeover(1, 1);
    assert.equal((await t.getOp(a.operation_id)).error.code, 'USER_INTERVENED');
    assert.equal(t.ctl.paneState(1)[0].inputPaused, true);
  } finally { await t.ctl.shutdown(); }
});

test('B03: idempotency — same request returns the same op, different content conflicts, no double write', posixOnly, async () => {
  const t = await setup();
  try {
    t.prepare();
    const req = {
      target: t.target(), expected_state_revision: t.rev(), idempotency_key: 'stageb-prompt-0001',
      input_contract: 'actions-v1', profile_id: PROFILE, profile_revision: '1', action: { type: 'text', text: 'hello' }
    };
    const a = t.ctl.broker.handle(t.P, 'workbench_write_input', req);
    t.ctl.confirmOperation(a.operation_id, 'initial', 'approved');
    assert.deepEqual(t.writes, ['hello']);
    // Response lost; the client re-sends the SAME request after the revision moved on.
    const again = t.ctl.broker.handle(t.P, 'workbench_write_input', req);
    assert.equal(again.ok, true);
    assert.equal(again.operation_id, a.operation_id);
    assert.equal(again.status, 'delivered');
    assert.equal(t.confirmations.length, 1); // no new dialog
    assert.deepEqual(t.writes, ['hello']); // no second write
    const changed = t.ctl.broker.handle(t.P, 'workbench_write_input', { ...req, action: { type: 'text', text: 'HELLO' } });
    assert.equal(changed.error.code, 'IDEMPOTENCY_CONFLICT');
    assert.equal(changed.error.operation_id, a.operation_id);
  } finally { await t.ctl.shutdown(); }
});

test('freshness, busy, rate limit', posixOnly, async () => {
  const t = await setup();
  try {
    t.prepare();
    const stale = t.ctl.broker.handle(t.P, 'workbench_write_input', { target: t.target(), expected_state_revision: '0', idempotency_key: 'stale-0001', text: 'x' });
    assert.equal(stale.error.code, 'STATE_CONFLICT');
    const a = t.prompt('a');
    assert.equal(t.prompt('b').error.code, 'SESSION_BUSY');
    t.ctl.confirmOperation(a.operation_id, 'initial', 'declined');
    assert.equal((await t.getOp(a.operation_id)).status, 'failed');
    for (let i = 0; i < 9; i++) {
      const r = t.write({ text: `t${i}` });
      assert.equal(r.ok, true, JSON.stringify(r));
      t.ctl.confirmOperation(r.operation_id, 'initial', 'declined');
    }
    const over = t.write({ text: 'over' });
    assert.equal(over.error.code, 'RATE_LIMITED');
    assert.equal(validate(WRITE_INPUT_OUTPUT_SCHEMA, over).ok, true);
    t.ctl.rateLimiter.burst = 1; t.ctl.rateLimiter.buckets.clear();
    t.write({ text: 'a' });
    const limited = t.write({ text: 'b' });
    assert.equal(limited.error.code, 'RATE_LIMITED');
    assert.equal(validate(WRITE_INPUT_OUTPUT_SCHEMA, limited).ok, true, validate(WRITE_INPUT_OUTPUT_SCHEMA, limited).message);
  } finally { await t.ctl.shutdown(); }
});

test('B07: revoke / restart / profile change between text and Enter -> no Enter, outcome_unknown', posixOnly, async () => {
  for (const change of ['revokeInput', 'restart', 'profile', 'stopSharing', 'disableInput']) {
    const t = await setup();
    try {
      t.prepare();
      const a = t.prompt('payload');
      t.ctl.confirmOperation(a.operation_id, 'initial', 'approved');
      const opId = a.operation_id;
      const op = t.ctl.arbiter.ops.get(opId);
      if (change === 'revokeInput') t.ctl.revokeInput(1, 1);
      if (change === 'restart') t.ctl.ptyStarted(1, 1, { distro: 'Ubuntu', wslPath: '/w' });
      if (change === 'profile') t.ctl.selectProfile(1, 1, null);
      if (change === 'stopSharing') t.ctl.stopSharing(1, 1);
      if (change === 'disableInput') await t.ctl.setInputEnabled(false);
      t.ctl.confirmOperation(opId, 'submit', 'approved');
      await sleep(700);
      assert.equal(op.status, 'outcome_unknown', change);
      assert.deepEqual(t.writes, ['payload'], change);
    } finally { await t.ctl.shutdown(); }
  }
});

test('confirmation expiry and PTY write failure', posixOnly, async () => {
  const t = await setup();
  try {
    t.prepare();
    t.ctl.arbiter.confirmMs = 50;
    const a = t.prompt('x');
    await sleep(120);
    const op = await t.getOp(a.operation_id);
    assert.equal(op.status, 'failed');
    assert.equal(op.error.code, 'CONFIRMATION_EXPIRED');
    assert.ok(t.cancelled.includes(a.operation_id)); // the expired dialog is closed
    t.ctl.confirmOperation(a.operation_id, 'initial', 'approved'); // too late: ignored
    assert.equal(t.writes.length, 0);
  } finally { await t.ctl.shutdown(); }
  const f = await setup({ writeFails: true });
  try {
    f.prepare();
    const a = f.prompt('x');
    f.ctl.confirmOperation(a.operation_id, 'initial', 'approved');
    const op = await f.getOp(a.operation_id);
    assert.equal(op.status, 'outcome_unknown');
    assert.equal(op.delivery.text_state, 'partial_or_unknown');
    // A known failed key returns an error envelope with the operation id.
  } finally { await f.ctl.shutdown(); }
});

test('get_operation: long poll, other principals, and access after the grant ends', posixOnly, async () => {
  const t = await setup();
  try {
    t.prepare();
    const a = t.prompt('x');
    const started = Date.now();
    setTimeout(() => t.ctl.confirmOperation(a.operation_id, 'initial', 'declined'), 100);
    const op = await t.getOp(a.operation_id, 5000);
    assert.ok(Date.now() - started < 2000);
    assert.equal(op.status, 'failed');
    const other = await t.ctl.broker.handle('paired-local:other', 'workbench_get_operation', { operation_id: a.operation_id });
    assert.equal(other.error.code, 'OPERATION_NOT_FOUND');
    t.ctl.stopSharing(1, 1);
    const after = await t.getOp(a.operation_id);
    assert.equal(after.ok, false);
    assert.equal(after.error.code, 'GRANT_REVOKED');
    assert.equal(validate(GET_OPERATION_OUTPUT_SCHEMA, after).ok, true);
  } finally { await t.ctl.shutdown(); }
});

test('B08: crash recovery never replays — accepted-only -> failed, intent -> outcome_unknown', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wswb-j-'));
  const key = crypto.randomBytes(32);
  const s1 = new OperationStore({ dir, key });
  assert.equal(s1.open(), true);
  const base = { k: 'accepted', principal: 'p', method: 'workbench_write_input', target: {}, digest: 'd', profile: {}, action: 'text', grant: 'g', at: Date.now(), exp: Date.now() + 1000000 };
  s1.append({ ...base, op: 'A', idx: 'ia' });
  s1.append({ ...base, op: 'B', idx: 'ib' });
  s1.append({ k: 'phase', op: 'B', phase: 'text_dispatch', dispatch_started: true, delivery: null, at: Date.now() });
  s1.close();
  // a torn final line (crash mid-append) is ignored
  fs.appendFileSync(path.join(dir, 'operations.jsonl'), '{"k":"phase","op":"A"');
  const s2 = new OperationStore({ dir, key });
  assert.equal(s2.open(), true, s2.error);
  assert.equal(s2.ops.get('A').final.status, 'failed');
  assert.equal(s2.ops.get('B').final.status, 'outcome_unknown');
  assert.equal(s2.lookup('ia').id, 'A'); // the idempotency index survives the restart
  s2.close();
  // tampering or a different key makes the journal unavailable (never silently reset)
  const s3 = new OperationStore({ dir, key: crypto.randomBytes(32) });
  assert.equal(s3.open(), false);
  const file = path.join(dir, 'operations.jsonl');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"op":"A"', '"op":"Z"'));
  const s4 = new OperationStore({ dir, key });
  assert.equal(s4.open(), false);
});

test('journal unavailable -> nothing is sent', posixOnly, async () => {
  const t = await setup();
  try {
    t.prepare();
    t.ctl.store.close(); // simulate the journal becoming unwritable
    const r = t.prompt('x');
    assert.equal(r.ok, false);
    assert.ok(['JOURNAL_UNAVAILABLE', 'UNSUPPORTED'].includes(r.error.code));
    assert.equal(t.writes.length, 0);
  } finally { await t.ctl.shutdown(); }
});

test('B10: no prompt text in results, journal, or audit; B09: output text never answers prompts', posixOnly, async () => {
  const t = await setup();
  const secret = 'TOP-SECRET-PROMPT-本文';
  try {
    t.prepare();
    const a = t.prompt(secret);
    t.ctl.confirmOperation(a.operation_id, 'initial', 'approved');
    // The CLI prints a fake approval request: nothing is written automatically.
    t.ctl.ptyData(1, 1, 'Allow this command? (y/n) > Press Enter to approve\n');
    await sleep(50);
    assert.deepEqual(t.writes, [secret]);
    t.ctl.confirmOperation(a.operation_id, 'submit', 'approved');
    await t.getOp(a.operation_id, 3000);
    const files = [];
    const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else files.push(p); } };
    walk(path.join(t.dir, 'integration'));
    const blob = files.filter((f) => !f.endsWith('pairing.key')).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
    assert.ok(blob.includes('op_finished'));
    assert.ok(!blob.includes('TOP-SECRET'));
    assert.ok(!blob.includes('本文'));
    assert.equal(t.ctl.arbiter.ops.get(a.operation_id).text, null); // dropped from memory too
  } finally { await t.ctl.shutdown(); }
});

test('adapter lists input tools only while the gate is open', posixOnly, async () => {
  const { createMcpServer } = require('../../src/mcp/server');
  const t = await setup();
  try {
    const out = [];
    const server = createMcpServer({ send: (m) => out.push(m), callTool: async (name, args) => t.ctl.broker.handle(t.P, name, args) });
    await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.ok(out[0].result.tools.some((x) => x.name === 'workbench_write_input'));
    assert.ok(!out[0].result.tools.some((x) => x.name === 'workbench_run_command' || x.name === 'workbench_cancel_operation'));
    await t.ctl.setInputEnabled(false);
    await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.ok(!out[1].result.tools.some((x) => x.name === 'workbench_write_input'));
  } finally { await t.ctl.shutdown(); }
});

test('codex B1: a late approval after the deadline is treated as expired even if the timer lagged', posixOnly, async () => {
  const t = await setup();
  try {
    t.prepare();
    const a = t.prompt('x');
    const op = t.ctl.arbiter.ops.get(a.operation_id);
    clearTimeout(op.timer); // simulate a delayed timer
    op.confirmDeadline = Date.now() - 1;
    t.ctl.confirmOperation(a.operation_id, 'initial', 'approved');
    assert.equal(op.status, 'failed');
    assert.equal(op.error.code, 'CONFIRMATION_EXPIRED');
    assert.equal(t.writes.length, 0);
  } finally { await t.ctl.shutdown(); }
});

test('codex B1: a failed final journal write never reports delivered', posixOnly, async () => {
  const t = await setup();
  try {
    t.prepare();
    const a = t.write({ text: 'x' });
    const append = t.ctl.store.append.bind(t.ctl.store);
    t.ctl.store.append = (rec) => { if (rec.k === 'final') throw new Error('disk full'); return append(rec); };
    t.ctl.confirmOperation(a.operation_id, 'initial', 'approved');
    const op = t.ctl.arbiter.ops.get(a.operation_id);
    assert.deepEqual(t.writes, ['x']);
    assert.equal(op.status, 'outcome_unknown');
    assert.equal(op.error.code, 'JOURNAL_UNAVAILABLE');
  } finally { await t.ctl.shutdown(); }
});

test('codex B1: the confirmation page shows the whole text, escaped, with invisible characters marked', () => {
  const { buildConfirmHtml, visibleText } = require('../../src/integration/confirm-page');
  const long = 'a'.repeat(5000) + 'HIDDEN-TAIL';
  const html = buildConfirmHtml({ title: 't', heading: 'h', text: long, okLabel: 'ok', cancelLabel: 'no' });
  assert.ok(html.includes('HIDDEN-TAIL'));
  const evil = buildConfirmHtml({ title: '</title><script>x</script>', heading: '<b>', text: "<img src=x onerror=alert(1)>'\"", okLabel: 'ok', cancelLabel: 'no' });
  assert.ok(!evil.includes('<img'));
  assert.ok(!evil.includes('<script>x'));
  const v = visibleText('safe‮txt.exe ​ 👩‍💻');
  assert.equal(v.marked, 2); // RLO and ZWSP marked; the emoji ZWJ kept
  assert.ok(v.html.includes('U+202E'));
  assert.ok(!v.html.includes('‮'));
});

test('codex B2: a short journal write is retried to completion, never treated as a full record', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wswb-j-'));
  const key = crypto.randomBytes(32);
  const store = new OperationStore({ dir, key });
  assert.equal(store.open(), true);
  const real = fs.writeSync;
  let calls = 0;
  fs.writeSync = (fd, buf, off, len) => { calls++; return real(fd, buf, off, Math.min(len, 7)); }; // 7 bytes at a time
  try {
    store.append({ k: 'accepted', op: 'A', idx: 'i', principal: 'p', method: 'm', target: {}, digest: 'd', profile: {}, action: 'text', grant: 'g', at: Date.now(), exp: Date.now() + 100000 });
  } finally { fs.writeSync = real; }
  assert.ok(calls > 1);
  store.close();
  const again = new OperationStore({ dir, key });
  assert.equal(again.open(), true, again.error);
  assert.ok(again.ops.get('A'));
});

test('codex B3: a slow intent flush that crosses the deadline sends nothing (failed, not unknown)', posixOnly, async () => {
  const t = await setup();
  try {
    t.prepare();
    const a = t.write({ text: 'x' });
    const op = t.ctl.arbiter.ops.get(a.operation_id);
    const append = t.ctl.store.append.bind(t.ctl.store);
    t.ctl.store.append = (rec) => { const r = append(rec); if (rec.k === 'phase') op.confirmDeadline = Date.now() - 1; return r; };
    t.ctl.confirmOperation(a.operation_id, 'initial', 'approved');
    assert.equal(t.writes.length, 0);
    assert.equal(op.status, 'failed');
    assert.equal(op.error.code, 'CONFIRMATION_EXPIRED');
  } finally { await t.ctl.shutdown(); }
});

test('codex B3: get_operation still reports the outcome after a journal failure closed the gate', posixOnly, async () => {
  const t = await setup();
  try {
    t.prepare();
    const a = t.write({ text: 'x' });
    const append = t.ctl.store.append.bind(t.ctl.store);
    t.ctl.store.append = (rec) => { if (rec.k === 'final') { t.ctl.store.healthy = false; throw new Error('disk full'); } return append(rec); };
    t.ctl.confirmOperation(a.operation_id, 'initial', 'approved');
    assert.equal(t.ctl.inputGate().open, false);
    const op = await t.getOp(a.operation_id);
    assert.equal(op.ok, true, JSON.stringify(op));
    assert.equal(op.status, 'outcome_unknown');
    assert.equal(t.write({ text: 'y' }).error.code, 'UNSUPPORTED'); // but no new input
  } finally { await t.ctl.shutdown(); }
});

test('Claude Code 2.1.287 profile (measured 2026-10-03): text, confirm, Enter after its own confirmation and the 600 ms delay', posixOnly, async () => {
  const t = await setup();
  const CLAUDE = 'claude-code.2.1.prompt.single-line';
  try {
    t.ctl.selectProfile(1, 1, CLAUDE);
    t.ctl.grantInput(1, 1);
    const view = t.ctl.broker.handle(t.P, 'workbench_get_session', { target: t.target() });
    assert.equal(view.input_profile.id, CLAUDE);
    const r = t.ctl.broker.handle(t.P, 'workbench_write_input', {
      target: t.target(), expected_state_revision: t.rev(), idempotency_key: `k-${crypto.randomUUID()}`,
      input_contract: 'actions-v1', profile_id: CLAUDE, profile_revision: '1',
      action: { type: 'text_and_submit', text: 'ツールを使わず、OKとだけ返してください', submit_key: 'Enter' }
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(t.writes.length, 0);
    t.ctl.confirmOperation(r.operation_id, 'initial', 'approved');
    assert.deepEqual(t.writes, ['ツールを使わず、OKとだけ返してください']);
    t.ctl.confirmOperation(r.operation_id, 'submit', 'approved');
    const op = await t.getOp(r.operation_id, 3000);
    assert.equal(op.status, 'delivered', JSON.stringify(op));
    assert.deepEqual(t.writes, ['ツールを使わず、OKとだけ返してください', '\r']);
    // The codex profile is not interchangeable: naming it while Claude Code is selected is refused.
    const wrong = t.ctl.broker.handle(t.P, 'workbench_write_input', {
      target: t.target(), expected_state_revision: t.rev(), idempotency_key: `k-${crypto.randomUUID()}`,
      input_contract: 'actions-v1', profile_id: PROFILE, profile_revision: '1', action: { type: 'text', text: 'x' }
    });
    assert.equal(wrong.ok, false);
  } finally { await t.ctl.shutdown(); }
});
