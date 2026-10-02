// Profiles vs. the CLI version actually running in the pane: verified / same-major unverified
// (explicit, remembered compat approval) / major change / unknown / user-confirmed / version change
// while input is on; staged observation after Enter (only output after the Enter counts).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { IntegrationController } = require('../../src/integration');
const { versionStatus, findProfile, detectCli, publicProfile } = require('../../src/integration/input-profiles');
const { toolResult } = require('../../src/mcp/server');
const { validate, GET_OPERATION_OUTPUT_SCHEMA } = require('../../src/mcp/schemas');

const posixOnly = { skip: process.platform === 'win32' ? 'uses a Unix socket' : false };
const CLAUDE = 'claude-code.2.1.prompt.single-line';
const CODEX = 'codex.0.160.composer.single-line';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = () => new Promise((r) => setImmediate(r));

function testTransport() {
  return () => (onConnection) => new Promise((resolve, reject) => {
    const endpoint = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wswb-v-sock-')), 's.sock');
    const srv = net.createServer(onConnection);
    srv.once('error', reject);
    srv.listen(endpoint, () => resolve({ close: () => new Promise((r) => srv.close(() => r())) }));
  });
}

async function setup({ settings = {}, clock } = {}) {
  let st = settings;
  const writes = [];
  const confirmations = [];
  const opts = clock ? { now: () => clock.t } : {};
  const ctl = new IntegrationController({
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'wswb-v-')),
    readSettings: () => st,
    writeSettings: (p) => { st = { ...st, ...p }; return true; },
    writePty: (viewId, termId, data) => { writes.push(data); return true; },
    requestConfirmation: (req) => confirmations.push(req),
    cancelConfirmation: () => {},
    journalKey: () => crypto.randomBytes(32),
    secureTransport: testTransport(),
    ...opts
  });
  await ctl.enable();
  ctl.rateLimiter.burst = 1000;
  ctl.rateLimiter.ratePerSec = 1000;
  await ctl.setInputEnabled(true);
  ctl.ptyStarted(1, 1, { distro: 'Ubuntu', wslPath: '/w' });
  ctl.share(1, 1);
  const s = ctl.registry.bySlot(1, 1);
  const pane = () => ctl.paneState(1)[0];
  const banner = (v, family = 'claude') => ctl.ptyData(1, 1, family === 'claude' ? `\r\n ✻ Welcome to Claude Code v${v}\r\n` : `>_ OpenAI Codex (v${v})\r\n`);
  const send = (text, profile = CLAUDE) => ctl.broker.handle(ctl.principal, 'workbench_write_input', {
    target: ctl.registry.target(s), expected_state_revision: String(s.stateRevision), idempotency_key: `k-${crypto.randomUUID()}`,
    input_contract: 'actions-v1', profile_id: profile, profile_revision: '1', action: { type: 'text_and_submit', text, submit_key: 'Enter' }
  });
  const getOp = (id) => ctl.broker.handle(ctl.principal, 'workbench_get_operation', { operation_id: id, wait_ms: 0 });
  const approveBoth = (id) => { ctl.confirmOperation(id, 'initial', 'approved'); ctl.confirmOperation(id, 'submit', 'approved'); };
  return { ctl, s, pane, banner, send, getOp, approveBoth, writes, confirmations, settings: () => st };
}

test('versionStatus: verified / same-major unverified / approved / major change / unknown / other CLI / 0.x minor', () => {
  const c = findProfile(CLAUDE);
  const x = findProfile(CODEX);
  assert.equal(versionStatus(c, { family: 'claude-code', version: '2.1.287' }).status, 'verified');
  assert.equal(versionStatus(c, { family: 'claude-code', version: '2.3.0' }).status, 'compat_pending');
  assert.equal(versionStatus(c, { family: 'claude-code', version: '2.3.0' }, ['2.3.0']).status, 'compat_approved');
  assert.equal(versionStatus(c, { family: 'claude-code', version: '3.0.0' }, ['3.0.0']).status, 'major_changed');
  assert.equal(versionStatus(c, { family: 'claude-code', version: '1.0.3' }).status, 'major_changed');
  assert.equal(versionStatus(c, null).status, 'unknown');
  assert.equal(versionStatus(c, { family: 'codex', version: '2.1.287' }).status, 'family_mismatch');
  assert.equal(versionStatus(x, { family: 'codex', version: '0.160.0' }).status, 'verified');
  assert.equal(versionStatus(x, { family: 'codex', version: '0.160.5' }).status, 'compat_pending');
  assert.equal(versionStatus(x, { family: 'codex', version: '0.161.0' }).status, 'major_changed', '0.x: a minor change is like a major one');
  assert.deepEqual(publicProfile(c).verified_versions, ['2.1.287']);
  assert.equal(publicProfile(c).id, CLAUDE, 'profile IDs are unchanged');
});

test('banner detection: last banner wins; split across chunks', posixOnly, async () => {
  assert.deepEqual(detectCli('Claude Code v2.1.287 ... Claude Code v2.1.300 '), { family: 'claude-code', version: '2.1.300', end: 45 });
  const t = await setup();
  try {
    t.ctl.ptyData(1, 1, 'Welcome to Claude Co');
    t.ctl.ptyData(1, 1, 'de v2.1.287\r\n');
    assert.deepEqual(t.pane().cli, { family: 'claude-code', version: '2.1.287', source: 'pane_output' });
  } finally { await t.ctl.shutdown(); }
});

test('known version: usable as before', posixOnly, async () => {
  const t = await setup();
  try {
    t.banner('2.1.287');
    t.ctl.selectProfile(1, 1, CLAUDE);
    assert.equal(t.pane().cliStatus, 'verified');
    t.ctl.grantInput(1, 1);
    assert.equal(t.send('hi').ok, true);
  } finally { await t.ctl.shutdown(); }
});

test('unverified same-major version: blocked until approved once; approval is remembered and turns nothing on', posixOnly, async () => {
  const t = await setup();
  try {
    t.banner('2.3.0');
    t.ctl.selectProfile(1, 1, CLAUDE);
    assert.equal(t.pane().cliStatus, 'compat_pending');
    assert.throws(() => t.ctl.grantInput(1, 1), /not verified/);
    t.ctl.approveCompat(CLAUDE, '2.3.0');
    assert.equal(t.pane().cliStatus, 'compat_approved');
    assert.equal(t.pane().state, 'read', 'approval does not turn input on');
    assert.equal(t.pane().autoConfirm, false);
    t.ctl.grantInput(1, 1);
    assert.equal(t.send('hi').ok, true);
    assert.deepEqual(t.settings().integration.compatApprovals[CLAUDE], ['2.3.0']);
  } finally { await t.ctl.shutdown(); }
  // Same version later (another run): not asked again.
  const u = await setup({ settings: { integration: { compatApprovals: { [CLAUDE]: ['2.3.0'] } } } });
  try {
    u.banner('2.3.0');
    u.ctl.selectProfile(1, 1, CLAUDE);
    assert.equal(u.pane().cliStatus, 'compat_approved');
    assert.equal(u.pane().state, 'read', 'and input is still OFF after a restart');
  } finally { await u.ctl.shutdown(); }
});

test('major change or unknown: never automatically compatible', posixOnly, async () => {
  const t = await setup();
  try {
    t.banner('3.0.0');
    t.ctl.selectProfile(1, 1, CLAUDE);
    assert.equal(t.pane().cliStatus, 'major_changed');
    assert.throws(() => t.ctl.approveCompat(CLAUDE, '3.0.0'), /Only an unverified version of a verified major/);
    assert.throws(() => t.ctl.grantInput(1, 1), /different major/);
  } finally { await t.ctl.shutdown(); }
  const u = await setup();
  try {
    u.ctl.selectProfile(1, 1, CLAUDE); // the CLI started before sharing: no banner seen
    assert.equal(u.pane().cliStatus, 'unknown');
    assert.equal(u.pane().cli, null);
    assert.throws(() => u.ctl.grantInput(1, 1), /unknown/);
    // The user states the version: marked as such, still needs to be a usable version.
    u.ctl.confirmCliVersion(1, 1, '2.1.287', u.ctl.inputTarget(1, 1));
    assert.deepEqual(u.pane().cli, { family: 'claude-code', version: '2.1.287', source: 'user_confirmed' });
    assert.equal(u.pane().cliStatus, 'verified');
    assert.equal(u.pane().state, 'read', 'confirming the version does not turn input on');
  } finally { await u.ctl.shutdown(); }
});

test('PATH mismatch: only the pane\'s own output (or the user) identifies the CLI; a pane banner overrides the user statement', posixOnly, async () => {
  const t = await setup();
  try {
    t.ctl.selectProfile(1, 1, CLAUDE);
    t.ctl.confirmCliVersion(1, 1, '2.1.287', t.ctl.inputTarget(1, 1)); // what the user believes
    t.banner('1.0.3'); // what actually started in the pane (an old install earlier on PATH)
    assert.deepEqual(t.pane().cli, { family: 'claude-code', version: '1.0.3', source: 'pane_output' });
    assert.equal(t.pane().cliStatus, 'major_changed');
    assert.throws(() => t.ctl.confirmCliVersion(1, 1, '2.1.287', t.ctl.inputTarget(1, 1)), /already seen in this pane/);
    assert.equal(typeof t.ctl.probeCliVersion, 'undefined', 'no separate-process probe exists');
  } finally { await t.ctl.shutdown(); }
});

test('CLI / version change while input is on: input stops, pending input stops, nothing is re-sent', posixOnly, async () => {
  const t = await setup();
  try {
    t.banner('2.1.287');
    t.ctl.selectProfile(1, 1, CLAUDE);
    t.ctl.grantInput(1, 1);
    const r = t.send('pending');
    t.ctl.confirmOperation(r.operation_id, 'initial', 'approved');
    assert.deepEqual(t.writes, ['pending']);
    t.banner('2.3.0'); // the CLI was restarted with another version
    assert.equal(t.pane().state, 'read');
    assert.equal(t.ctl.arbiter.ops.get(r.operation_id).status, 'outcome_unknown');
    t.ctl.confirmOperation(r.operation_id, 'submit', 'approved');
    await sleep(700);
    assert.deepEqual(t.writes, ['pending'], 'no Enter after the change');
    // The same version shown again (e.g. a redraw of the banner) is not a change.
    t.ctl.approveCompat(CLAUDE, '2.3.0');
    t.ctl.grantInput(1, 1);
    t.banner('2.3.0');
    assert.equal(t.pane().state, 'read_input');
  } finally { await t.ctl.shutdown(); }
});

test('observation: only output after the Enter counts (old screens never), staged acceptance / response', posixOnly, async () => {
  const clock = { t: 1_000_000 };
  const t = await setup({ clock });
  try {
    t.banner('2.1.287');
    t.ctl.selectProfile(1, 1, CLAUDE);
    t.ctl.grantInput(1, 1);
    // Old screen content that LOOKS like acceptance and a reply.
    t.ctl.ptyData(1, 1, '✻ Working… (esc to interrupt)\r\n⏺ OK\r\n');
    const r = t.send('ツールを使わず、OKとだけ返してください');
    t.approveBoth(r.operation_id);
    await sleep(700);
    let op = await t.getOp(r.operation_id);
    assert.equal(op.status, 'delivered');
    assert.deepEqual([op.observation.cli_acceptance, op.observation.response], ['pending', 'unknown'], 'old output is not counted');
    clock.t += 20_000;
    op = await t.getOp(r.operation_id);
    assert.equal(op.observation.cli_acceptance, 'not_confirmed');
    // New output after the Enter.
    t.ctl.ptyData(1, 1, '✶ Pondering… (esc to interrupt)\r\n');
    op = await t.getOp(r.operation_id);
    assert.deepEqual([op.observation.cli_acceptance, op.observation.response], ['observed', 'pending']);
    t.ctl.ptyData(1, 1, '⏺ OK\r\n');
    op = await t.getOp(r.operation_id);
    assert.deepEqual([op.observation.cli_acceptance, op.observation.response], ['observed', 'observed']);
    // MCP: structured result unchanged (schema-valid), observation in the text.
    const mcp = toolResult('workbench_get_operation', op);
    assert.equal('observation' in mcp.structuredContent, false);
    assert.equal(validate(GET_OPERATION_OUTPUT_SCHEMA, mcp.structuredContent).ok, true, validate(GET_OPERATION_OUTPUT_SCHEMA, mcp.structuredContent).message);
    assert.match(mcp.content[0].text, /CLI acceptance=observed, response=observed/);
    assert.match(mcp.content[0].text, /does NOT mean the input was not sent/);
    assert.deepEqual(t.writes, ['ツールを使わず、OKとだけ返してください', '\r'], 'observation never sends anything');
  } finally { await t.ctl.shutdown(); }
});

test('observation unknown when output is gone (cleared / capture restarted): never "not sent", never re-sent', posixOnly, async () => {
  const t = await setup();
  try {
    t.banner('2.1.287');
    t.ctl.selectProfile(1, 1, CLAUDE);
    t.ctl.grantInput(1, 1);
    const r = t.send('x');
    t.approveBoth(r.operation_id);
    await sleep(700);
    t.ctl.clearBuffer(1, 1);
    const op = await t.getOp(r.operation_id);
    assert.equal(op.status, 'delivered');
    assert.equal(op.observation.cli_acceptance, 'unknown');
    assert.equal(op.observation.note, 'no_capture');
    await sleep(100);
    assert.deepEqual(t.writes, ['x', '\r']);
    // A text-only operation (no Enter) has no observation.
    t.ctl.ptyData(1, 1, ' Claude Code v2.1.287\r\n');
    const k = t.ctl.broker.handle(t.ctl.principal, 'workbench_write_input', {
      target: t.ctl.registry.target(t.s), expected_state_revision: String(t.s.stateRevision), idempotency_key: 'k-text',
      input_contract: 'actions-v1', profile_id: CLAUDE, profile_revision: '1', action: { type: 'text', text: 'y' }
    });
    t.ctl.confirmOperation(k.operation_id, 'initial', 'approved');
    assert.equal((await t.getOp(k.operation_id)).observation, undefined);
  } finally { await t.ctl.shutdown(); }
});

test('codex: banner + shell prompt in one chunk -> unknown; share OFF/ON forgets the CLI; split version number', posixOnly, async () => {
  const t = await setup();
  try {
    t.ctl.selectProfile(1, 1, CLAUDE);
    t.ctl.ptyData(1, 1, ' Claude Code v2.1.287\r\nbye\r\n\x1b]7;file:///w\x07$ ');
    assert.equal(t.pane().cli, null, 'the CLI exited in the same chunk');
    assert.throws(() => t.ctl.grantInput(1, 1), /unknown/);
    t.banner('2.1.287');
    assert.equal(t.pane().cliStatus, 'verified');
    t.ctl.stopSharing(1, 1);
    t.ctl.share(1, 1);
    assert.equal(t.pane().cli, null, 'nothing was observed while sharing was off');
    t.ctl.ptyData(1, 1, 'Welcome to Claude Code v2.1.28');
    assert.equal(t.pane().cli, null, 'not taken before the number is complete');
    t.ctl.ptyData(1, 1, '7\r\n');
    assert.deepEqual(t.pane().cli, { family: 'claude-code', version: '2.1.287', source: 'pane_output' });
  } finally { await t.ctl.shutdown(); }
});

test('codex: a second, still incomplete banner is not lost; a stale version dialog is refused', posixOnly, async () => {
  const t = await setup();
  try {
    t.ctl.selectProfile(1, 1, CLAUDE);
    t.ctl.ptyData(1, 1, ' Claude Code v2.1.287\r\n Claude Code v3.0.');
    assert.equal(t.pane().cli.version, '2.1.287');
    t.ctl.ptyData(1, 1, '0\r\n');
    assert.equal(t.pane().cli.version, '3.0.0');
  } finally { await t.ctl.shutdown(); }
  const u = await setup();
  try {
    u.ctl.selectProfile(1, 1, CLAUDE);
    const shown = u.ctl.inputTarget(1, 1);
    u.ctl.ptyData(1, 1, '\x1b]7;file:///w\x07$ '); // the CLI exited while the dialog was open
    assert.throws(() => u.ctl.confirmCliVersion(1, 1, '2.1.287', shown), /changed while the dialog/);
    assert.throws(() => u.ctl.confirmCliVersion(1, 1, '2.1.287'), /changed while the dialog/, 'no snapshot, no confirmation');
    assert.equal(u.pane().cli, null);
  } finally { await u.ctl.shutdown(); }
});

test('codex: stream order — prompt then a CLI started from it (same chunk) identifies the new CLI', posixOnly, async () => {
  const t = await setup();
  try {
    t.ctl.selectProfile(1, 1, CLAUDE);
    t.ctl.ptyData(1, 1, '\x1b]7;file:///w\x07$ claude\r\n Claude Code v2.1.287\r\n');
    assert.deepEqual(t.pane().cli, { family: 'claude-code', version: '2.1.287', source: 'pane_output' });
    t.ctl.ptyData(1, 1, ' Claude Code v2.1.287\r\nbye\r\n\x1b]7;file:///w\x07$ ');
    assert.equal(t.pane().cli, null, 'banner then prompt: the CLI exited');
  } finally { await t.ctl.shutdown(); }
});

test('codex: every banner in a chunk counts (Codex then Claude again still revokes input)', posixOnly, async () => {
  const t = await setup();
  try {
    t.banner('2.1.287');
    t.ctl.selectProfile(1, 1, CLAUDE);
    t.ctl.grantInput(1, 1);
    t.ctl.enableAutoConfirm(1, 1, t.ctl.inputTarget(1, 1));
    t.ctl.ptyData(1, 1, '>_ OpenAI Codex (v0.160.0)\r\n Claude Code v2.1.287\r\n');
    assert.equal(t.pane().state, 'read');
    assert.equal(t.pane().autoConfirm, false);
  } finally { await t.ctl.shutdown(); }
});

test('codex: a reply after more than one page of output is still observed', posixOnly, async () => {
  const t = await setup();
  try {
    t.banner('2.1.287');
    t.ctl.selectProfile(1, 1, CLAUDE);
    t.ctl.grantInput(1, 1);
    const r = t.send('x');
    t.approveBoth(r.operation_id);
    await sleep(700);
    t.ctl.ptyData(1, 1, '✻ Working (esc to interrupt)\r\n');
    for (let i = 0; i < 27; i++) t.ctl.ptyData(1, 1, 'y'.repeat(10000) + '\r\n');
    t.ctl.ptyData(1, 1, '⏺ OK\r\n');
    const op = await t.getOp(r.operation_id);
    assert.deepEqual([op.observation.cli_acceptance, op.observation.response], ['observed', 'observed']);
  } finally { await t.ctl.shutdown(); }
});

test('codex: a prerelease / build suffix is a different (unverified) version', posixOnly, async () => {
  const c = findProfile(CLAUDE);
  assert.equal(versionStatus(c, { family: 'claude-code', version: '2.1.287-beta.1' }).status, 'compat_pending');
  assert.deepEqual(detectCli('Claude Code v2.1.287-beta.1 '), { family: 'claude-code', version: '2.1.287-beta.1', end: 27 });
  assert.equal(detectCli('>_ OpenAI Codex (v0.160.0-alpha.2)').version, '0.160.0-alpha.2');
  const t = await setup();
  try {
    t.ctl.selectProfile(1, 1, CLAUDE);
    t.ctl.ptyData(1, 1, ' Claude Code v2.1.287-beta.1\r\n');
    assert.equal(t.pane().cliStatus, 'compat_pending');
    assert.throws(() => t.ctl.grantInput(1, 1), /not verified/);
  } finally { await t.ctl.shutdown(); }
});

test('codex: prerelease + build suffix; a version dialog from an earlier share is refused', posixOnly, async () => {
  assert.equal(detectCli('Claude Code v2.1.287-beta.1+build.5 ').version, '2.1.287-beta.1+build.5');
  assert.equal(versionStatus(findProfile(CLAUDE), { family: 'claude-code', version: '2.1.287-beta.1+build.5' }).status, 'compat_pending');
  const t = await setup();
  try {
    t.ctl.selectProfile(1, 1, CLAUDE);
    const shown = t.ctl.inputTarget(1, 1);
    t.ctl.stopSharing(1, 1);
    t.ctl.share(1, 1);
    assert.throws(() => t.ctl.confirmCliVersion(1, 1, '2.1.287', shown), /changed while the dialog/);
  } finally { await t.ctl.shutdown(); }
});

test('codex: the same version confirmed by its banner after the user did keeps operations and skip-confirmation', posixOnly, async () => {
  const t = await setup();
  try {
    t.ctl.selectProfile(1, 1, CLAUDE);
    t.ctl.confirmCliVersion(1, 1, '2.1.287', t.ctl.inputTarget(1, 1));
    t.ctl.grantInput(1, 1);
    t.ctl.enableAutoConfirm(1, 1, t.ctl.inputTarget(1, 1));
    const r = t.send('same');
    await tick();
    assert.deepEqual(t.writes, ['same']);
    t.banner('2.1.287'); // evidence upgraded to pane_output, same version
    await sleep(700);
    assert.deepEqual(t.writes, ['same', '\r']);
    assert.equal(t.pane().autoConfirm, true);
    assert.equal(t.pane().cli.source, 'pane_output');
  } finally { await t.ctl.shutdown(); }
});
