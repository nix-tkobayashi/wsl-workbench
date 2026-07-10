const { test } = require('node:test');
const assert = require('node:assert/strict');
const { wslToUnc, wslPathToWindowsFsPath, windowsDrivePathToWsl, uncToWsl, parseSelectedPath, isNtfsAdsPath } = require('../src/wsl-paths');

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

test('parseSelectedPath reads the distro from a \\\\wsl.localhost selection', () => {
  assert.deepEqual(
    parseSelectedPath('\\\\wsl.localhost\\Ubuntu\\home\\skype\\projects\\test003'),
    { distro: 'Ubuntu', wslPath: '/home/skype/projects/test003' }
  );
  // legacy \\wsl$ form
  assert.deepEqual(
    parseSelectedPath('\\\\wsl$\\Ubuntu\\home\\skype'),
    { distro: 'Ubuntu', wslPath: '/home/skype' }
  );
});

test('parseSelectedPath handles a non-default distro like Ubuntu-22.04 (regression)', () => {
  // Previously the prefix match "Ubuntu" swallowed "Ubuntu-22.04" and produced /-22.04/...
  assert.deepEqual(
    parseSelectedPath('\\\\wsl.localhost\\Ubuntu-22.04\\home\\skype\\projects\\ubiregi\\ubiregi-server-infrastructure'),
    { distro: 'Ubuntu-22.04', wslPath: '/home/skype/projects/ubiregi/ubiregi-server-infrastructure' }
  );
});

test('parseSelectedPath round-trips a non-default distro back to the correct UNC', () => {
  const selected = '\\\\wsl.localhost\\Ubuntu-22.04\\home\\skype\\projects\\x';
  const { distro, wslPath } = parseSelectedPath(selected);
  assert.equal(wslPathToWindowsFsPath(distro, wslPath), selected);
});

test('parseSelectedPath returns null distro for drive paths and Linux paths', () => {
  assert.deepEqual(parseSelectedPath('C:\\dev\\repo'), { distro: null, wslPath: '/mnt/c/dev/repo' });
  assert.deepEqual(parseSelectedPath('/home/skype/x'), { distro: null, wslPath: '/home/skype/x' });
});

test('parseSelectedPath maps a distro root with no subpath to /', () => {
  assert.deepEqual(parseSelectedPath('\\\\wsl.localhost\\Ubuntu'), { distro: 'Ubuntu', wslPath: '/' });
});

test('uncToWsl no longer corrupts a non-default distro path (regression)', () => {
  // even called with the wrong distro arg, the distro is read from the path
  assert.equal(
    uncToWsl('Ubuntu', '\\\\wsl.localhost\\Ubuntu-22.04\\home\\x'),
    '/home/x'
  );
});

test('isNtfsAdsPath detects alternate-data-stream entries from an Explorer drag (#47)', () => {
  assert.equal(isNtfsAdsPath('C:\\Users\\skype\\Downloads\\サンプル資料 (1).pptx:Zone.Identifier'), true);
  assert.equal(isNtfsAdsPath('C:\\Users\\skype\\Downloads\\file.txt:stream:$DATA'), true);
  assert.equal(isNtfsAdsPath('report.pptx:Zone.Identifier'), true); // no directory part
});

test('isNtfsAdsPath detects the U+F03A-escaped colon Chromium uses when materializing ADS drag entries (#47)', () => {
  // Chromium writes a drag's virtual-file entries to temp files with ':' escaped to U+F03A;
  // copied through \\wsl.localhost, the 9P server maps it back to a literal ':' on ext4.
  assert.equal(isNtfsAdsPath('C:\\Users\\skype\\AppData\\Local\\Temp\\提案書_20260612-2.pptx\uF03AZone.Identifier'), true);
  assert.equal(isNtfsAdsPath('report.pptx\uF03AZone.Identifier'), true);
});

test('isNtfsAdsPath passes regular files, directories, and UNC paths', () => {
  assert.equal(isNtfsAdsPath('C:\\Users\\skype\\Downloads\\サンプル資料 (1).pptx'), false);
  assert.equal(isNtfsAdsPath('C:\\dev\\repo'), false);
  assert.equal(isNtfsAdsPath('C:\\'), false); // drive root: colon is in the drive segment, not the name
  assert.equal(isNtfsAdsPath('\\\\wsl.localhost\\Ubuntu\\home\\skype\\notes.md'), false);
  assert.equal(isNtfsAdsPath(''), false);
});
