const { test } = require('node:test');
const assert = require('node:assert/strict');
const { initialWindowState } = require('../src/startup-workspace');

const fallback = { distro: 'Ubuntu', wslPath: '/home/user/projects' };

test('startup restores the saved workspace without filesystem validation', () => {
  const lastWorkspace = { distro: 'Ubuntu-22.04', wslPath: '/home/user/project' };
  assert.deepEqual(initialWindowState({ lastWorkspace }, fallback), {
    workspace: lastWorkspace,
    showLanding: false
  });
});

test('startup shows the landing screen when no workspace was saved', () => {
  assert.deepEqual(initialWindowState({}, fallback), {
    workspace: fallback,
    showLanding: true
  });
});
