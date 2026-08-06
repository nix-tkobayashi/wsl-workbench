const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { tabTitleForWorkspace, classifyTabDrop, insertionIndex, nextActiveTab, shellWindowTitle } = require('../src/tab-shell');

test('tabTitleForWorkspace: last two path segments, like the in-view workspace name', () => {
  assert.equal(tabTitleForWorkspace({ wslPath: '/home/skype/projects/nix/wb' }), 'nix/wb');
  assert.equal(tabTitleForWorkspace({ wslPath: '/home' }), 'home');
  assert.equal(tabTitleForWorkspace({ wslPath: '/' }), '/');
});

test('tabTitleForWorkspace: the landing screen shows the localized new-tab word', () => {
  assert.equal(tabTitleForWorkspace({ wslPath: '/home/x', showLanding: true }, '新しいタブ'), '新しいタブ');
  assert.equal(tabTitleForWorkspace({ wslPath: '' }, 'New Tab'), 'New Tab');
  assert.equal(tabTitleForWorkspace(undefined, 'New Tab'), 'New Tab');
});

const WINDOWS = [
  { id: 1, x: 0, y: 0, width: 800, stripHeight: 34 },
  { id: 2, x: 1000, y: 100, width: 600, stripHeight: 34 }
];

test('classifyTabDrop: a drop on the source strip is a reorder', () => {
  const verdict = classifyTabDrop({ point: { x: 400, y: 10 }, windows: WINDOWS, sourceWinId: 1 });
  assert.deepEqual(verdict, { type: 'reorder', winId: 1 });
});

test('classifyTabDrop: a drop on another window\'s strip merges into that window', () => {
  const verdict = classifyTabDrop({ point: { x: 1200, y: 120 }, windows: WINDOWS, sourceWinId: 1 });
  assert.deepEqual(verdict, { type: 'merge', winId: 2 });
});

test('classifyTabDrop: below the strip band (or nowhere) is a tear-off', () => {
  assert.equal(classifyTabDrop({ point: { x: 400, y: 34 }, windows: WINDOWS, sourceWinId: 1 }).type, 'outside'); // just past the strip
  assert.equal(classifyTabDrop({ point: { x: 400, y: 500 }, windows: WINDOWS, sourceWinId: 1 }).type, 'outside');
  assert.equal(classifyTabDrop({ point: { x: 900, y: 10 }, windows: WINDOWS, sourceWinId: 1 }).type, 'outside'); // between windows
  assert.equal(classifyTabDrop({}).type, 'outside');
});

test('classifyTabDrop: overlapping strips resolve to the first (front-most) window given', () => {
  const overlapping = [
    { id: 7, x: 0, y: 0, width: 800, stripHeight: 34 },
    { id: 8, x: 100, y: 0, width: 800, stripHeight: 34 }
  ];
  assert.equal(classifyTabDrop({ point: { x: 200, y: 5 }, windows: overlapping, sourceWinId: 8 }).winId, 7);
});

test('insertionIndex: counts the tab centers the pointer has passed', () => {
  assert.equal(insertionIndex([], 500), 0);
  assert.equal(insertionIndex([100, 200], 50), 0);
  assert.equal(insertionIndex([100, 200], 150), 1);
  assert.equal(insertionIndex([100, 200], 250), 2);
});

test('nextActiveTab: closing a background tab keeps the active one', () => {
  assert.equal(nextActiveTab([1, 2, 3], 3, 1), 1);
});

test('nextActiveTab: closing the active tab activates its right neighbor, else the new last', () => {
  assert.equal(nextActiveTab([1, 2, 3], 2, 2), 3); // right neighbor
  assert.equal(nextActiveTab([1, 2, 3], 3, 3), 2); // was last: left neighbor
  assert.equal(nextActiveTab([1], 1, 1), null);    // nothing remains
});

test('shellWindowTitle: active workspace plus the attention mark when a CLI waits', () => {
  assert.equal(shellWindowTitle({ activeTitle: 'nix/wb' }), 'nix/wb — WSL Workbench');
  assert.equal(shellWindowTitle({ activeTitle: 'nix/wb', attentionCount: 2 }), '● nix/wb — WSL Workbench');
  assert.equal(shellWindowTitle({}), 'WSL Workbench');
});

test('tab-shell.js is IIFE-wrapped and sets window.tabShell without leaking globals', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'tab-shell.js'), 'utf8');
  const firstCode = src.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('//'));
  assert.ok(firstCode.startsWith('(function'), 'should be IIFE-wrapped');
  const sandbox = { window: {}, module: undefined };
  vm.createContext(sandbox);
  assert.doesNotThrow(() => vm.runInContext(src, sandbox, { filename: 'tab-shell.js' }));
  assert.equal(typeof sandbox.window.tabShell.classifyTabDrop, 'function');
});
