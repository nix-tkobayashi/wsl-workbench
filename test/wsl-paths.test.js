const { test } = require('node:test');
const assert = require('node:assert/strict');
const { wslToUnc, wslPathToWindowsFsPath, windowsDrivePathToWsl, uncToWsl } = require('../src/wsl-paths');

test('wslToUnc builds a \\\\wsl.localhost UNC path', () => {
  assert.equal(wslToUnc('Ubuntu', '/home/skype/projects'), '\\\\wsl.localhost\\Ubuntu\\home\\skype\\projects');
  assert.equal(wslToUnc('Ubuntu', '/'), '\\\\wsl.localhost\\Ubuntu\\');
});

test('wslPathToWindowsFsPath maps native WSL paths to UNC', () => {
  assert.equal(wslPathToWindowsFsPath('Ubuntu', '/home/skype'), '\\\\wsl.localhost\\Ubuntu\\home\\skype');
});

test('wslPathToWindowsFsPath maps /mnt/<drive> to a Windows drive path', () => {
  assert.equal(wslPathToWindowsFsPath('Ubuntu', '/mnt/c/Users/skype/proj'), 'C:\\Users\\skype\\proj');
  assert.equal(wslPathToWindowsFsPath('Ubuntu', '/mnt/d'), 'D:\\');
});

test('windowsDrivePathToWsl converts drive paths to /mnt/<drive>', () => {
  assert.equal(windowsDrivePathToWsl('C:\\Users\\skype\\proj'), '/mnt/c/Users/skype/proj');
  assert.equal(windowsDrivePathToWsl('D:'), '/mnt/d');
  assert.equal(windowsDrivePathToWsl('\\\\wsl.localhost\\Ubuntu\\x'), null); // not a drive path
});

test('uncToWsl passes through an existing Linux path', () => {
  assert.equal(uncToWsl('Ubuntu', '/home/skype/projects/test003'), '/home/skype/projects/test003');
});

test('uncToWsl converts a WSL UNC selection to a WSL path (Open Workspace path)', () => {
  assert.equal(
    uncToWsl('Ubuntu', '\\\\wsl.localhost\\Ubuntu\\home\\skype\\projects\\test003'),
    '/home/skype/projects/test003'
  );
  // legacy \\wsl$ form, case-insensitive distro match
  assert.equal(uncToWsl('Ubuntu', '\\\\wsl$\\ubuntu\\home\\skype'), '/home/skype');
});

test('uncToWsl converts a native Windows drive selection to /mnt/<drive>', () => {
  assert.equal(uncToWsl('Ubuntu', 'C:\\dev\\repo'), '/mnt/c/dev/repo');
});

test('Open Workspace round-trips: UNC selection -> WSL path -> back to the same UNC', () => {
  const distro = 'Ubuntu';
  const selected = '\\\\wsl.localhost\\Ubuntu\\home\\skype\\projects\\test003';
  const wslPath = uncToWsl(distro, selected);
  assert.equal(wslPath, '/home/skype/projects/test003');
  assert.equal(wslPathToWindowsFsPath(distro, wslPath), selected);
});
