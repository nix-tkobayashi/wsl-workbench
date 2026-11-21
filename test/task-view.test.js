const { test } = require('node:test');
const assert = require('node:assert/strict');
const view = require('../src/task-view');

test('clampPanelWidth keeps the panel and the editor usable', () => {
  assert.equal(view.clampPanelWidth(300, 1200), 300);
  assert.equal(view.clampPanelWidth(50, 1200), view.PANEL_MIN);
  assert.equal(view.clampPanelWidth(2000, 1200), 1200 - 1 - view.EDITOR_MIN);
  assert.equal(view.clampPanelWidth(2000, 1200, 300), 1200 - 1 - view.EDITOR_MIN - 300);
  assert.equal(view.clampPanelWidth(NaN, 1200), view.PANEL_DEFAULT);
  assert.equal(view.clampPanelWidth(500, 300), view.PANEL_MIN); // narrow row: stays at the minimum
  assert.equal(view.clampPanelWidth(350, 400), view.fitPanelWidths([350], 400)[0]); // drag agrees with layout
  assert.equal(view.clampPanelWidth(500, 279, 139), 139); // never past the row beside the other panel
  assert.equal(view.clampPanelWidth(10, 279, 139), 139); // ...and the minimum yields too
});

test('filterRepos matches case-insensitively and lists checked repos first', () => {
  const repos = ['org/alpha', 'org/Beta', 'org/gamma-beta'];
  assert.deepEqual(view.filterRepos(repos, 'BETA'), ['org/Beta', 'org/gamma-beta']);
  assert.deepEqual(view.filterRepos(repos, '', new Set(['org/gamma-beta'])), ['org/gamma-beta', 'org/alpha', 'org/Beta']);
  assert.deepEqual(view.filterRepos(repos, 'zzz'), []);
});

test('isOverdue compares the due date with today', () => {
  const now = new Date(2026, 10, 21, 9, 0); // 2026-11-21 local
  assert.equal(view.isOverdue('2026-11-20', now), true);
  assert.equal(view.isOverdue('2026-11-21', now), false);
  assert.equal(view.isOverdue(null, now), false);
  assert.equal(view.isOverdue('soon', now), false);
});

test('timeLabel formats HH:MM', () => {
  assert.equal(view.timeLabel(new Date(2026, 0, 1, 7, 5)), '07:05');
  assert.equal(view.timeLabel('nope'), '');
});

test('the dialog repo cap matches the one main enforces', () => {
  assert.equal(view.REPOS_MAX, require('../src/tasks').REPOS_MAX);
});

test('fitPanelWidths keeps saved widths when they fit, else shrinks every panel in proportion', () => {
  assert.deepEqual(view.fitPanelWidths([300, 280], 1400), [300, 280]);
  // 880px window, 330px tree: 549px row, both panels at least their minimum and never clipped
  const fitted = view.fitPanelWidths([300, 300], 549);
  assert.deepEqual(fitted, [view.PANEL_MIN, view.PANEL_MIN]);
  const mid = view.fitPanelWidths([400, 200], 900); // 900-240-2 = 658 available of 600 wanted -> fits
  assert.deepEqual(mid, [400, 200]);
  const squeezed = view.fitPanelWidths([600, 300], 900); // 658 available of 900 wanted
  assert.ok(squeezed[0] + squeezed[1] <= 658 && squeezed[0] > squeezed[1]);
  assert.deepEqual(view.fitPanelWidths([NaN], 1000), [view.PANEL_DEFAULT]);
});

test('fitPanelWidths never exceeds a row too narrow for the minimums', () => {
  const w = view.fitPanelWidths([300, 300], 279); // 880px window with the tree dragged to 600px
  assert.ok(w[0] + w[1] + 2 <= 279, String(w));
  assert.equal(w[0], w[1]);
  assert.deepEqual(view.fitPanelWidths([300], 100), [99]);
  assert.deepEqual(view.fitPanelWidths([300, 300], 0), [0, 0]);
});

test('fitPanelWidths keeps the editor minimum when one panel hits its own minimum', () => {
  const w = view.fitPanelWidths([1000, 180], 800); // 800-240-2 = 558 available
  assert.ok(w[0] + w[1] <= 558, String(w));
  assert.equal(w[1], view.PANEL_MIN);
  assert.equal(w[0], 558 - view.PANEL_MIN);
});

test('terminalUrl passes a one-line http(s) URL and refuses anything that could act on the command line', () => {
  assert.equal(view.terminalUrl('https://github.com/o/r/issues/130'), 'https://github.com/o/r/issues/130');
  assert.equal(view.terminalUrl('https://example.backlog.jp/view/PRJ-1'), 'https://example.backlog.jp/view/PRJ-1');
  assert.equal(view.terminalUrl('https://github.com/o/r/issues/1\nrm -rf ~'), '');
  assert.equal(view.terminalUrl('https://github.com/o/r/issues/1\r'), '');
  assert.equal(view.terminalUrl('https://github.com/o/r issues'), '');
  assert.equal(view.terminalUrl('https://github.com/\u001b[201~x'), '');
  assert.equal(view.terminalUrl('javascript:alert(1)'), '');
  assert.equal(view.terminalUrl(''), '');
  assert.equal(view.terminalUrl(null), '');
});
