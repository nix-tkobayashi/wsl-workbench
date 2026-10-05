// "Sharing ON/OFF" with a saved default: terminal input on with the integration; read / input /
// skip-confirmation applied to the CLI detected in the pane; follows CLI restarts while sharing
// stays ON; unverified versions stay read-only until allowed; nothing restored after a restart.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { IntegrationController } = require('../../src/integration');

const posixOnly = { skip: process.platform === 'win32' ? 'uses a Unix socket' : false };
const CLAUDE = 'claude-code.2.1.prompt.single-line';
const CODEX = 'codex.0.160.composer.single-line';
const tick = () => new Promise((r) => setImmediate(r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function testTransport() {
  return () => (onConnection) => new Promise((resolve, reject) => {
    const endpoint = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wswb-p-sock-')), 's.sock');
    const srv = net.createServer(onConnection);
    srv.once('error', reject);
    srv.listen(endpoint, () => resolve({ close: () => new Promise((r) => srv.close(() => r())) }));
  });
}

async function setup({ settings = {}, preset = { input: true, skipConfirm: true } } = {}) {
  let st = settings;
  const writes = [];
  const confirmations = [];
  const ctl = new IntegrationController({
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'wswb-p-')),
    readSettings: () => st,
    writeSettings: (p) => { st = { ...st, ...p }; return true; },
    writePty: (viewId, termId, data) => { writes.push(data); return true; },
    requestConfirmation: (req) => confirmations.push(req),
    cancelConfirmation: () => {},
    journalKey: () => crypto.randomBytes(32),
    secureTransport: testTransport()
  });
  if (st.integration && st.integration.enabled) await ctl.start(); else await ctl.enable();
  ctl.rateLimiter.burst = 1000;
  ctl.rateLimiter.ratePerSec = 1000;
  if (preset) ctl.setSharePreset(preset);
  ctl.ptyStarted(1, 1, { distro: 'Ubuntu', wslPath: '/w' });
  const s = ctl.registry.bySlot(1, 1);
  const pane = () => ctl.paneState(1)[0];
  const claude = (v = '2.1.287') => ctl.ptyData(1, 1, ` ▐▛███▜▌ Claude Code v${v}\r\n`);
  const prompt = () => ctl.ptyData(1, 1, '\x1b]7;file:///w\x07$ ');
  const send = (text, profile = CLAUDE) => ctl.broker.handle(ctl.principal, 'workbench_write_input', {
    target: ctl.registry.target(s), expected_state_revision: String(s.stateRevision), idempotency_key: `k-${crypto.randomUUID()}`,
    input_contract: 'actions-v1', profile_id: profile, profile_revision: '1', action: { type: 'text_and_submit', text, submit_key: 'Enter' }
  });
  return { ctl, s, pane, claude, prompt, send, writes, confirmations, settings: () => st };
}

test('enabling the integration turns terminal input on (verified transport)', posixOnly, async () => {
  const t = await setup({ preset: null });
  try {
    assert.equal(t.ctl.inputEnabled, true);
    assert.equal(t.ctl.inputGate().open, true);
    assert.equal(t.ctl.sharePreset(), null);
    assert.throws(() => t.ctl.shareWithPreset(1, 1), /default for sharing/);
  } finally { await t.ctl.shutdown(); }
});

test('Sharing ON before the CLI starts: read, input waits; the CLI starting turns input + skip-confirmation on', posixOnly, async () => {
  const t = await setup();
  try {
    t.ctl.shareWithPreset(1, 1);
    assert.equal(t.pane().state, 'read');
    assert.equal(t.pane().presetInput, true);
    assert.equal(t.pane().cliStatus, 'unknown');
    t.claude();
    assert.equal(t.pane().state, 'read_input');
    assert.equal(t.pane().profileId, CLAUDE, 'profile chosen from the detected CLI');
    assert.equal(t.pane().autoConfirm, true);
    const r = t.send('hello');
    await tick();
    await sleep(700);
    assert.deepEqual(t.writes, ['hello', '\r']);
    assert.equal(t.confirmations.length, 0);
  } finally { await t.ctl.shutdown(); }
});

test('CLI exit and restart while sharing stays ON: input off at the prompt, back on for the new CLI', posixOnly, async () => {
  const t = await setup();
  try {
    t.ctl.shareWithPreset(1, 1);
    t.claude();
    t.prompt();
    assert.equal(t.pane().state, 'read');
    assert.equal(t.pane().autoConfirm, false);
    t.ctl.ptyData(1, 1, '>_ OpenAI Codex (v0.160.0)\r\n'); // another CLI started
    assert.equal(t.pane().state, 'read_input');
    assert.equal(t.pane().profileId, CODEX);
    assert.equal(t.pane().autoConfirm, true);
  } finally { await t.ctl.shutdown(); }
});

test('unverified version: read-only until allowed once; then input follows; other major never', posixOnly, async () => {
  const t = await setup();
  try {
    t.ctl.shareWithPreset(1, 1);
    t.claude('2.1.289');
    assert.equal(t.pane().state, 'read');
    assert.equal(t.pane().cliStatus, 'compat_pending');
    t.ctl.approveCompat(CLAUDE, '2.1.289');
    assert.equal(t.pane().state, 'read_input');
    assert.equal(t.pane().autoConfirm, true);
    t.prompt();
    t.claude('3.0.0');
    assert.equal(t.pane().state, 'read');
    assert.equal(t.pane().cliStatus, 'major_changed');
  } finally { await t.ctl.shutdown(); }
});

test('presets: read only / input with confirmation', posixOnly, async () => {
  const a = await setup({ preset: { input: false, skipConfirm: true } });
  try {
    assert.deepEqual(a.ctl.sharePreset(), { input: false, skipConfirm: false });
    a.ctl.shareWithPreset(1, 1);
    a.claude();
    assert.equal(a.pane().state, 'read');
    assert.equal(a.pane().presetInput, false);
  } finally { await a.ctl.shutdown(); }
  const b = await setup({ preset: { input: true, skipConfirm: false } });
  try {
    b.ctl.shareWithPreset(1, 1);
    b.claude();
    assert.equal(b.pane().state, 'read_input');
    assert.equal(b.pane().autoConfirm, false);
    b.send('x');
    await tick();
    assert.equal(b.confirmations.length, 1, 'each send confirmed');
  } finally { await b.ctl.shutdown(); }
});

test('Sharing OFF stops following; manual sharing never auto-enables input; restart shares nothing', posixOnly, async () => {
  const t = await setup();
  t.ctl.shareWithPreset(1, 1);
  t.claude();
  t.ctl.stopSharing(1, 1);
  assert.equal(t.pane().state, 'off');
  t.ctl.share(1, 1); // the individual read switch, not the preset
  t.claude('2.1.287');
  assert.equal(t.pane().state, 'read', 'no input without the preset share');
  await t.ctl.shutdown();
  const saved = t.settings();
  assert.equal(saved.integration.sharePreset.input, true, 'the preset is saved');
  const u = await setup({ settings: saved, preset: null });
  try {
    u.claude();
    assert.equal(u.pane().state, 'off', 'nothing is shared after a restart');
    assert.equal(u.ctl.sharePreset().skipConfirm, true);
  } finally { await u.ctl.shutdown(); }
});

test('codex: an explicit Stop input holds (compat approval elsewhere does not undo it); a CLI restart re-applies', posixOnly, async () => {
  const t = await setup();
  try {
    t.ctl.shareWithPreset(1, 1);
    t.claude();
    t.ctl.revokeInput(1, 1);
    assert.equal(t.pane().state, 'read');
    t.ctl.approveCompat(CLAUDE, '2.1.290');
    assert.equal(t.pane().state, 'read', 'an unrelated approval does not turn input back on');
    t.prompt();
    t.claude();
    assert.equal(t.pane().state, 'read_input', 'a new CLI start follows the default again');
  } finally { await t.ctl.shutdown(); }
});

test('codex: confirming the version with no profile chosen picks the profile', posixOnly, async () => {
  const t = await setup();
  try {
    t.ctl.shareWithPreset(1, 1); // the CLI was already running: no banner seen
    assert.equal(t.pane().profileId, null);
    t.ctl.confirmCliVersion(1, 1, '2.1.287', t.ctl.inputTarget(1, 1), CLAUDE);
    assert.equal(t.pane().profileId, CLAUDE);
    assert.equal(t.pane().cli.source, 'user_confirmed');
    assert.equal(t.pane().state, 'read_input', 'the default applies once the version is known');
  } finally { await t.ctl.shutdown(); }
});
