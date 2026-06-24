const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { terminalRightClick } = require('../src/terminal-actions');

// Build a mock io that records calls and lets the test control selection/clipboard.
function makeIO({ selection = '', clipboard = '' } = {}) {
  const calls = { writeClipboard: [], writePty: [], clearSelection: 0 };
  return {
    hasSelection: () => selection.length > 0,
    getSelection: () => selection,
    clearSelection: () => { calls.clearSelection += 1; },
    readClipboard: () => clipboard,
    writeClipboard: (t) => calls.writeClipboard.push(t),
    writePty: (t) => calls.writePty.push(t),
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
  assert.deepEqual(io.calls.writePty, []); // must not paste when copying
});

test('pastes the clipboard into the pty when there is no selection', () => {
  const io = makeIO({ selection: '', clipboard: 'pasted text' });
  const r = terminalRightClick(io);
  assert.equal(r.action, 'paste');
  assert.equal(r.text, 'pasted text');
  assert.deepEqual(io.calls.writePty, ['pasted text']);
  assert.deepEqual(io.calls.writeClipboard, []); // must not copy when pasting
  assert.equal(io.calls.clearSelection, 0);
});

test('paste with empty clipboard is a no-op write', () => {
  const io = makeIO({ selection: '', clipboard: '' });
  const r = terminalRightClick(io);
  assert.equal(r.action, 'paste');
  assert.deepEqual(io.calls.writePty, []);
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
