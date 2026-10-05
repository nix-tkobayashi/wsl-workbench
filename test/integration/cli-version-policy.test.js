// CLI version handling without per-update chores: CLI metadata tracked while not shared (no text kept),
// compatibility policy per major line (0.x: minor), unknown-version input for one CLI run, and the
// unchanged MCP surface.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { IntegrationController } = require('../../src/integration');
const { listedTools, toolByName } = require('../../src/mcp/schemas');
const { PROFILES, detectCli } = require('../../src/integration/input-profiles');

const posixOnly = { skip: process.platform === 'win32' ? 'uses a Unix socket' : false };
const CLAUDE = 'claude-code.2.1.prompt.single-line';
const CODEX = 'codex.0.160.composer.single-line';

function testTransport() {
  return () => (onConnection) => new Promise((resolve, reject) => {
    const endpoint = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wswb-c-sock-')), 's.sock');
    const srv = net.createServer(onConnection);
    srv.once('error', reject);
    srv.listen(endpoint, () => resolve({ close: () => new Promise((r) => srv.close(() => r())) }));
  });
}

async function setup({ settings = {}, preset = { input: true, skipConfirm: true } } = {}) {
  let st = settings;
  const ctl = new IntegrationController({
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'wswb-c-')),
    readSettings: () => st,
    writeSettings: (p) => { st = { ...st, ...p }; return true; },
    writePty: () => true,
    requestConfirmation: () => {},
    cancelConfirmation: () => {},
    journalKey: () => crypto.randomBytes(32),
    secureTransport: testTransport()
  });
  await ctl.enable();
  if (preset) ctl.setSharePreset(preset);
  ctl.ptyStarted(1, 1, { distro: 'Ubuntu', wslPath: '/w' });
  const s = ctl.registry.bySlot(1, 1);
  const pane = () => ctl.paneState(1)[0];
  const claude = (v) => ctl.ptyData(1, 1, `\r\n ▐▛███▜▌   Claude Code v${v}\r\n▝▜█████▛▘  Opus\r\n`);
  const codex = (v) => ctl.ptyData(1, 1, `>_ OpenAI Codex (v${v})\r\n`);
  const prompt = () => ctl.ptyData(1, 1, '\x1b]7;file:///w\x07$ ');
  return { ctl, s, pane, claude, codex, prompt, settings: () => st };
}

test('(1) CLI started before sharing: its version is known when sharing turns on; no output text kept', posixOnly, async () => {
  const t = await setup();
  try {
    t.ctl.ptyData(1, 1, 'secret-before-sharing token=abc\r\n');
    t.claude('2.1.287');
    assert.equal(t.s.buffer, null, 'nothing is buffered while not shared');
    assert.ok((t.s.bannerTail || '').length <= 160);
    assert.deepEqual(t.pane().cli, { family: 'claude-code', version: '2.1.287', source: 'pane_output' });
    t.ctl.shareWithPreset(1, 1);
    assert.equal(t.pane().state, 'read_input', 'input applies right away');
    const out = t.ctl.broker.handle(t.ctl.principal, 'workbench_read_output', { target: t.ctl.registry.target(t.s) });
    assert.equal(out.ok, true);
    assert.equal(out.text.includes('secret-before-sharing'), false, 'output from before sharing is never exposed');
    assert.equal(out.text.includes('Claude Code'), false);
  } finally { await t.ctl.shutdown(); }
});

test('(1) metadata expires: CLI exit (prompt), pane exit; a restarted CLI is seen again', posixOnly, async () => {
  const t = await setup();
  try {
    t.claude('2.1.287');
    t.prompt();
    assert.equal(t.pane().cli, null);
    t.codex('0.160.0');
    assert.equal(t.pane().cli.family, 'codex');
    t.ctl.ptyExited(1, 1);
    assert.equal(t.s.cli, null);
  } finally { await t.ctl.shutdown(); }
});

test('(2) Claude 2.x policy: approved once, later 2.x updates need nothing; 3.x asks again', posixOnly, async () => {
  const t = await setup();
  try {
    t.claude('2.1.289');
    t.ctl.shareWithPreset(1, 1);
    assert.equal(t.pane().cliStatus, 'compat_pending');
    assert.equal(t.pane().state, 'read');
    t.ctl.approveCompatLine('claude-code', '2');
    assert.equal(t.pane().cliStatus, 'compat_approved');
    assert.equal(t.pane().cliBasis, 'policy');
    assert.equal(t.pane().state, 'read_input', 'the user-consented default applies to this waiting, shared pane');
    t.prompt();
    t.claude('2.4.0'); // a later update of the same major
    assert.equal(t.pane().cliStatus, 'compat_approved');
    assert.equal(t.pane().state, 'read_input');
    t.claude('2.1.287');
    assert.equal(t.pane().cliStatus, 'verified', 'verified stays distinct from policy-allowed');
    t.prompt();
    t.claude('3.0.0');
    assert.equal(t.pane().cliStatus, 'major_changed');
    assert.equal(t.pane().state, 'read');
    assert.deepEqual(t.settings().integration.compatPolicy, { 'claude-code': ['2'] });
    t.ctl.approveCompatLine('claude-code', '3');
    assert.equal(t.pane().cliStatus, 'compat_approved');
  } finally { await t.ctl.shutdown(); }
});

test('(2) Codex 0.x: the policy is per minor (0.160 covers 0.160.5, not 0.161)', posixOnly, async () => {
  const t = await setup();
  try {
    t.codex('0.160.5');
    t.ctl.shareWithPreset(1, 1);
    assert.equal(t.pane().cliStatus, 'compat_pending');
    t.ctl.approveCompatLine('codex', '0.160');
    assert.equal(t.pane().cliStatus, 'compat_approved');
    t.prompt();
    t.codex('0.161.0');
    assert.equal(t.pane().cliStatus, 'major_changed');
    assert.equal(t.pane().cliLine, '0.161');
  } finally { await t.ctl.shutdown(); }
});

test('(4) approving a policy never turns sharing / input / skip-confirmation on by itself', posixOnly, async () => {
  const t = await setup();
  try {
    t.claude('2.1.289');
    t.ctl.approveCompatLine('claude-code', '2');
    assert.equal(t.pane().state, 'off', 'not shared: stays off');
    t.ctl.share(1, 1); // the individual read switch (not the saved default)
    assert.equal(t.pane().state, 'read');
    assert.equal(t.pane().autoConfirm, false);
  } finally { await t.ctl.shutdown(); }
});

test('(3) unknown version: allowed for this CLI run only, never "verified"; another CLI is refused', posixOnly, async () => {
  const t = await setup();
  try {
    t.ctl.shareWithPreset(1, 1); // the CLI started before Workbench could see it: no banner
    assert.equal(t.pane().cliStatus, 'unknown');
    assert.throws(() => t.ctl.allowUnknownVersion(1, 1, 'claude-code', null), /changed while the dialog/);
    t.ctl.allowUnknownVersion(1, 1, 'claude-code', t.ctl.inputTarget(1, 1));
    assert.equal(t.pane().cliStatus, 'unknown_allowed');
    assert.equal(t.pane().profileId, CLAUDE);
    assert.equal(t.pane().state, 'read_input');
    const view = t.ctl.broker.handle(t.ctl.principal, 'workbench_get_session', { target: t.ctl.registry.target(t.s) });
    assert.deepEqual(view.input_profile.cli_version, { value: null, source: 'user_confirmed', status: 'unknown_allowed' });
    t.prompt(); // the CLI exited
    assert.equal(t.pane().cliStatus, 'unknown');
    assert.equal(t.pane().state, 'read');
    t.codex('0.160.0');
    assert.throws(() => t.ctl.allowUnknownVersion(1, 1, 'claude-code', t.ctl.inputTarget(1, 1)), /version is known/);
    t.ctl.selectProfile(1, 1, CLAUDE);
    assert.equal(t.pane().cliStatus, 'family_mismatch');
  } finally { await t.ctl.shutdown(); }
});

test('(5) old redraws and version numbers in text are not a new start', posixOnly, async () => {
  const t = await setup();
  try {
    t.claude('2.1.287');
    t.ctl.shareWithPreset(1, 1);
    assert.equal(t.pane().state, 'read_input');
    t.claude('2.1.287'); // the header repainted (resize, /clear)
    assert.equal(t.pane().state, 'read_input', 'same version repainted: input stays');
    t.ctl.ptyData(1, 1, 'Changelog: Claude Code v2.2.0 adds ...\r\n'); // a version in the text
    assert.equal(t.pane().cli.version, '2.1.287');
    assert.equal(detectCli('see Claude Code v9.9.9 '), null);
  } finally { await t.ctl.shutdown(); }
});

test('(6) MCP surface unchanged: tool names, required arguments, profile IDs', () => {
  assert.deepEqual(listedTools({ inputEnabled: true }).map((x) => x.name),
    ['workbench_capabilities', 'workbench_list_sessions', 'workbench_get_session', 'workbench_read_output', 'workbench_write_input', 'workbench_get_operation']);
  assert.deepEqual(toolByName('workbench_write_input').inputSchema.required, ['target', 'expected_state_revision', 'idempotency_key']);
  assert.deepEqual(toolByName('workbench_get_operation').inputSchema.required, ['operation_id']);
  assert.deepEqual(PROFILES.map((p) => p.id), [CODEX, CLAUDE]);
});

test('codex: approving a policy applies the default only to panes that were waiting for it', posixOnly, async () => {
  const t = await setup();
  try {
    t.claude('2.1.287');
    t.ctl.shareWithPreset(1, 1);
    t.ctl.disableAutoConfirm(1, 1); // the user turned skip-confirmation off in this verified pane
    t.ctl.ptyStarted(1, 2, { distro: 'Ubuntu', wslPath: '/w' });
    t.ctl.ptyData(1, 2, ' ▐▛███▜▌ Claude Code v2.1.289\r\n');
    t.ctl.shareWithPreset(1, 2);
    t.ctl.approveCompatLine('claude-code', '2');
    const p1 = t.ctl.paneState(1).find((p) => p.id === 1);
    const p2 = t.ctl.paneState(1).find((p) => p.id === 2);
    assert.equal(p1.autoConfirm, false, 'the verified pane is left alone');
    assert.equal(p2.autoConfirm, true, 'the waiting pane gets the default');
  } finally { await t.ctl.shutdown(); }
});
