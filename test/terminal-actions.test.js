const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { terminalRightClick, shouldHandleRightClick, parseOsc7Cwd, shellCdCommand } = require('../src/terminal-actions');

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
