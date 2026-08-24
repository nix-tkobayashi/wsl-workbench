const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { recentLabel, filterRecentWorkspaces } = require('../src/recent-filter');

const items = [
  { distro: 'Ubuntu', wslPath: '/home/u/projects/nix/nix-workbench-lite' },
  { distro: 'Ubuntu', wslPath: '/home/u/projects/sakasta' },
  { distro: 'Debian', wslPath: '/srv/Infra/terraform' },
];

test('recentLabel is distro:path', () => {
  assert.equal(recentLabel(items[0]), 'Ubuntu:/home/u/projects/nix/nix-workbench-lite');
});

test('blank query returns everything in order', () => {
  assert.deepEqual(filterRecentWorkspaces(items, ''), items);
  assert.deepEqual(filterRecentWorkspaces(items, '   '), items);
  assert.deepEqual(filterRecentWorkspaces(items, undefined), items);
});

test('substring match is case-insensitive and covers the distro', () => {
  assert.deepEqual(filterRecentWorkspaces(items, 'INFRA'), [items[2]]);
  assert.deepEqual(filterRecentWorkspaces(items, 'debian'), [items[2]]);
  assert.deepEqual(filterRecentWorkspaces(items, 'projects'), [items[0], items[1]]);
});

test('every whitespace-separated term must match, in any order', () => {
  assert.deepEqual(filterRecentWorkspaces(items, 'lite nix'), [items[0]]);
  assert.deepEqual(filterRecentWorkspaces(items, 'nix sakasta'), []);
});

test('malformed input is tolerated', () => {
  assert.deepEqual(filterRecentWorkspaces(null, 'x'), []);
  assert.deepEqual(filterRecentWorkspaces([null, { distro: 'U' }, items[1]], 'saka'), [items[1]]);
});

test('recent-filter.js is IIFE-wrapped and sets window.recentFilter without leaking globals', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'recent-filter.js'), 'utf8');
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'recent-filter.js' });
  assert.equal(typeof sandbox.window.recentFilter.filterRecentWorkspaces, 'function');
  assert.equal(Object.keys(sandbox).sort().join(','), 'window');
});
