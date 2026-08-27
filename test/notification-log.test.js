const test = require('node:test');
const assert = require('node:assert/strict');
const { MAX_HISTORY, pushNotification, shouldToast, toastText, formatClock } = require('../src/notification-log');

test('pushNotification: newest first, ids increase, input untouched', () => {
  const a = pushNotification([], { label: 'claude' });
  const b = pushNotification(a, { label: 'codex' });
  assert.deepEqual(b.map((e) => e.label), ['codex', 'claude']);
  assert.deepEqual(b.map((e) => e.id), [2, 1]);
  assert.equal(a.length, 1); // not mutated
});

test('pushNotification: bounded to max (default 50), dropping the oldest', () => {
  let list = [];
  for (let i = 0; i < 60; i++) list = pushNotification(list, { label: String(i) });
  assert.equal(list.length, MAX_HISTORY);
  assert.equal(list[0].label, '59');
  assert.equal(list[list.length - 1].label, '10');
  assert.equal(pushNotification(list, { label: 'x' }, 3).length, 3);
});

test('pushNotification: ids keep increasing after truncation and tolerate bad input', () => {
  let list = [];
  for (let i = 0; i < 5; i++) list = pushNotification(list, { label: 'x' }, 2);
  assert.equal(list[0].id, 5);
  assert.equal(pushNotification(null, { label: 'y' })[0].id, 1);
});

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

test('formatClock: zero-padded 24h HH:MM', () => {
  const d = new Date(2026, 0, 1, 9, 5);
  assert.equal(formatClock(d.getTime()), '09:05');
  assert.equal(formatClock(new Date(2026, 0, 1, 23, 59).getTime()), '23:59');
});
