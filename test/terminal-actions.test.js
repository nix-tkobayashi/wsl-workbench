const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { terminalRightClick, shouldHandleRightClick, parseOsc7Cwd, shellCdCommand, buildTabSegments, parseOsc9Attention, attentionSummary } = require('../src/terminal-actions');

// Build a mock io that records calls and lets the test control selection/clipboard.
function makeIO({ selection = '', clipboard = '' } = {}) {
  const calls = { writeClipboard: [], paste: [], clearSelection: 0 };
  return {
    hasSelection: () => selection.length > 0,
    getSelection: () => selection,
    clearSelection: () => { calls.clearSelection += 1; },
    readClipboard: () => clipboard,
    writeClipboard: (t) => calls.writeClipboard.push(t),
    paste: (t) => calls.paste.push(t),
    calls
  };
}

test('copies the selection and clears it when text is selected', () => {
  const io = makeIO({ selection: 'hello world', clipboard: 'OLD' });
  const r = terminalRightClick(io);
  assert.equal(r.action, 'copy');
  assert.equal(r.text, 'hello world');
  assert.deepEqual(io.calls.writeClipboard, ['hello world']);
  assert.equal(io.calls.clearSelection, 1);
  assert.deepEqual(io.calls.paste, []); // must not paste when copying
});

test('pastes the clipboard into the pty when there is no selection', () => {
  const io = makeIO({ selection: '', clipboard: 'pasted text' });
  const r = terminalRightClick(io);
  assert.equal(r.action, 'paste');
  assert.equal(r.text, 'pasted text');
  assert.deepEqual(io.calls.paste, ['pasted text']);
  assert.deepEqual(io.calls.writeClipboard, []); // must not copy when pasting
  assert.equal(io.calls.clearSelection, 0);
});

test('pastes a clipboard image (via pasteImage) instead of text when one is present', () => {
  const io = makeIO({ selection: '', clipboard: 'some text' });
  const calls = { pasteImage: 0 };
  io.hasImage = () => true;
  io.pasteImage = () => { calls.pasteImage += 1; };
  const r = terminalRightClick(io);
  assert.equal(r.action, 'paste-image');
  assert.equal(calls.pasteImage, 1);
  assert.deepEqual(io.calls.paste, []); // image path taken: no text paste
});

test('falls back to text paste when the clipboard has no image', () => {
  const io = makeIO({ selection: '', clipboard: 'plain text' });
  io.hasImage = () => false;
  io.pasteImage = () => { throw new Error('should not paste image'); };
  const r = terminalRightClick(io);
  assert.equal(r.action, 'paste');
  assert.deepEqual(io.calls.paste, ['plain text']);
});

test('paste with empty clipboard is a no-op write', () => {
  const io = makeIO({ selection: '', clipboard: '' });
  const r = terminalRightClick(io);
  assert.equal(r.action, 'paste');
  assert.deepEqual(io.calls.paste, []);
});

test('copy ignores a falsy selection text without writing the clipboard', () => {
  // hasSelection true but getSelection returns '' (defensive)
  const io = { ...makeIO({ clipboard: 'x' }), hasSelection: () => true, getSelection: () => '' };
  const calls = { writeClipboard: [], clearSelection: 0 };
  io.writeClipboard = (t) => calls.writeClipboard.push(t);
  io.clearSelection = () => { calls.clearSelection += 1; };
  const r = terminalRightClick(io);
  assert.equal(r.action, 'copy');
  assert.deepEqual(calls.writeClipboard, []); // empty selection -> no clipboard write
  assert.equal(calls.clearSelection, 1);
});

test('shouldHandleRightClick: renderer owns the click when mouse reporting is off', () => {
  assert.equal(shouldHandleRightClick({ mouseReporting: false, hasImage: false }), true);
  assert.equal(shouldHandleRightClick({ mouseReporting: false, hasImage: true }), true);
});

test('shouldHandleRightClick: with mouse reporting on, only a clipboard image is owned', () => {
  assert.equal(shouldHandleRightClick({ mouseReporting: true, hasImage: false }), false);
  assert.equal(shouldHandleRightClick({ mouseReporting: true, hasImage: true }), true);
});

test('shouldHandleRightClick: coerces truthy/undefined hasImage to a boolean', () => {
  assert.equal(shouldHandleRightClick({ mouseReporting: true, hasImage: undefined }), false);
  assert.strictEqual(shouldHandleRightClick({ mouseReporting: false }), true);
});

test('parseOsc7Cwd: accepts the raw path our PROMPT_COMMAND emits (no hostname)', () => {
  assert.equal(parseOsc7Cwd('file:///home/skype/projects'), '/home/skype/projects');
  assert.equal(parseOsc7Cwd('file:///'), '/');
  assert.equal(parseOsc7Cwd('file:///dir with spaces/sub'), '/dir with spaces/sub');
});

test('parseOsc7Cwd: drops a hostname and percent-decodes standard OSC 7 payloads', () => {
  assert.equal(parseOsc7Cwd('file://myhost/home/skype'), '/home/skype');
  assert.equal(parseOsc7Cwd('file://myhost/with%20space'), '/with space');
});

test('parseOsc7Cwd: keeps the raw path when percent-decoding fails', () => {
  assert.equal(parseOsc7Cwd('file:///tmp/100%done'), '/tmp/100%done');
});

test('parseOsc7Cwd: literal % sent as %25 by our PROMPT_COMMAND decodes back losslessly', () => {
  // The emitter sends "${PWD//%/%25}", so a real dir "/tmp/a %20b" arrives as "a %2520b".
  assert.equal(parseOsc7Cwd('file:///tmp/a%20%2520b'), '/tmp/a %20b');
  assert.equal(parseOsc7Cwd('file:///tmp/50%25off'), '/tmp/50%off');
});

test('parseOsc7Cwd: rejects non-file URLs, relative paths, and control characters', () => {
  assert.equal(parseOsc7Cwd('http://evil/path'), null);
  assert.equal(parseOsc7Cwd('file://hostonly'), null);
  assert.equal(parseOsc7Cwd(''), null);
  assert.equal(parseOsc7Cwd(null), null);
  assert.equal(parseOsc7Cwd('file:///bad%0apath'), null); // decoded newline
  assert.equal(parseOsc7Cwd('file:///bad\x1bpath'), null); // raw escape
});

test('shellCdCommand: builds a silenced, quoted best-effort cd', () => {
  assert.equal(shellCdCommand('/home/skype'), "cd -- '/home/skype' 2>/dev/null");
  assert.equal(shellCdCommand('/dir with spaces'), "cd -- '/dir with spaces' 2>/dev/null");
});

test('shellCdCommand: single quotes in the path cannot break out of the quoting', () => {
  assert.equal(shellCdCommand("/a'b"), "cd -- '/a'\\''b' 2>/dev/null");
});

test('shellCdCommand: returns empty for unusable input (caller stays at the workspace root)', () => {
  assert.equal(shellCdCommand(''), '');
  assert.equal(shellCdCommand('relative/path'), '');
  assert.equal(shellCdCommand('/has\nnewline'), '');
  assert.equal(shellCdCommand(null), '');
  assert.equal(shellCdCommand(42), '');
});

test('buildTabSegments: default names use the localized word + pane id, custom names win', () => {
  const segs = buildTabSegments({
    panes: [{ id: 1, name: null }, { id: 4, name: 'build' }],
    activePaneId: 4,
    defaultWord: 'ターミナル'
  });
  assert.deepEqual(segs, [
    { id: 1, label: 'ターミナル 1', focused: false, attention: false },
    { id: 4, label: 'build', focused: true, attention: false }
  ]);
});

test('buildTabSegments: a single pane is never marked focused (mark only matters when split)', () => {
  const segs = buildTabSegments({ panes: [{ id: 2, name: null }], activePaneId: 2, defaultWord: 'Terminal' });
  assert.deepEqual(segs, [{ id: 2, label: 'Terminal 2', focused: false, attention: false }]);
});

test('buildTabSegments: passes each pane\'s attention flag through as a boolean', () => {
  const segs = buildTabSegments({
    panes: [{ id: 1, name: null, attention: true }, { id: 2, name: null }],
    activePaneId: 1,
    defaultWord: 'Terminal'
  });
  assert.equal(segs[0].attention, true);
  assert.equal(segs[1].attention, false);
});

test('buildTabSegments: tolerates empty/missing input', () => {
  assert.deepEqual(buildTabSegments({}), []);
  assert.deepEqual(buildTabSegments(), []);
});

test('parseOsc9Attention: a plain tool name becomes the attention label', () => {
  assert.equal(parseOsc9Attention('claude'), 'claude');
  assert.equal(parseOsc9Attention('codex'), 'codex');
  assert.equal(parseOsc9Attention('  codex  '), 'codex'); // trimmed
});

test('parseOsc9Attention: an empty payload still signals attention (label falls back later)', () => {
  assert.equal(parseOsc9Attention(''), '');
  assert.equal(parseOsc9Attention(null), '');
  assert.equal(parseOsc9Attention(undefined), '');
});

test('parseOsc9Attention: structured "<digit>;" payloads (progress reports) are not attention', () => {
  assert.equal(parseOsc9Attention('4;1;50'), null);   // Windows Terminal / ConEmu progress
  assert.equal(parseOsc9Attention('9;10'), null);     // ConEmu sub-commands
  assert.equal(parseOsc9Attention('12;something'), null);
});

test('parseOsc9Attention: strips control characters and caps the label length', () => {
  assert.equal(parseOsc9Attention('cla\x07ude\x1b'), 'claude');
  assert.equal(parseOsc9Attention('x'.repeat(100)).length, 32);
});

test('attentionSummary: null when nothing waits', () => {
  assert.equal(attentionSummary({ items: [] }), null);
  assert.equal(attentionSummary(), null);
});

test('attentionSummary: one waiting pane names the tool and the pane', () => {
  const s = attentionSummary({ items: [{ label: 'codex', paneName: 'Terminal 2' }], waitingWord: 'Waiting', appName: 'WSL Workbench' });
  assert.equal(s.chip, 'codex — Terminal 2');
  assert.equal(s.docTitle, '● codex — Terminal 2 — WSL Workbench');
});

test('attentionSummary: an unnamed notification falls back to the pane name alone', () => {
  const s = attentionSummary({ items: [{ label: '', paneName: 'build' }], waitingWord: 'Waiting', appName: 'WSL Workbench' });
  assert.equal(s.chip, 'build');
});

test('attentionSummary: several waiting panes collapse to a localized count', () => {
  const s = attentionSummary({
    items: [{ label: 'claude', paneName: 'A' }, { label: 'codex', paneName: 'B' }],
    waitingWord: '確認待ち',
    appName: 'WSL Workbench'
  });
  assert.equal(s.chip, '確認待ち (2)');
  assert.equal(s.docTitle, '● 確認待ち (2) — WSL Workbench');
});

test('terminal-actions.js is IIFE-wrapped and sets window.terminalActions without leaking globals', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'terminal-actions.js'), 'utf8');
  const firstCode = src.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('//'));
  assert.ok(firstCode.startsWith('(function'), 'should be IIFE-wrapped');
  const sandbox = { window: {}, module: undefined };
  vm.createContext(sandbox);
  Object.defineProperty(sandbox, 'api', { value: { bridge: true }, configurable: false, writable: false });
  assert.doesNotThrow(() => vm.runInContext(src, sandbox, { filename: 'terminal-actions.js' }));
  assert.equal(typeof sandbox.window.terminalActions.terminalRightClick, 'function');
});
