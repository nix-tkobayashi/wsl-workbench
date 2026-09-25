const test = require('node:test');
const assert = require('node:assert/strict');
const { shouldToast, toastText } = require('../src/notification-log');

test('shouldToast: only when the window is unfocused or the tab hidden', () => {
  assert.equal(shouldToast({ focused: true, visible: true }), false);
  assert.equal(shouldToast({ focused: false, visible: true }), true);
  assert.equal(shouldToast({ focused: true, visible: false }), true);
  assert.equal(shouldToast(), true);
});

test('toastText: tool title with pane and workspace in the body', () => {
  assert.deepEqual(toastText({ title: 'claude · permission', paneName: 'Terminal 2', workspace: 'nix/wb' }),
    { title: 'claude · permission', body: 'Terminal 2 — nix/wb' });
});

test('toastText: unnamed report uses the pane name as the title', () => {
  assert.deepEqual(toastText({ title: '', paneName: 'build', workspace: 'nix/wb' }), { title: 'build', body: 'nix/wb' });
  assert.deepEqual(toastText({ title: 'codex', paneName: 'build' }), { title: 'codex', body: 'build' });
});
