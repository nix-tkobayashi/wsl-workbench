const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseGitInfoOutput, remoteWebUrl, MAX_STATUS_ENTRIES } = require('../src/git-status');

// branch, toplevel, remote URL (empty here — remote handling has its own tests below)
const HEADER = 'main\n/home/u/repo\n\n';

test('parses branch, toplevel-joined paths, and codes', () => {
  const out = parseGitInfoOutput(HEADER + ' M src/a.js\n?? notes.txt\n');
  assert.equal(out.branch, 'main');
  assert.deepEqual(out.statuses, [
    { code: ' M', dir: false, path: '/home/u/repo/src/a.js' },
    { code: '??', dir: false, path: '/home/u/repo/notes.txt' },
  ]);
  assert.equal(out.truncated, false);
});

test('null when there is no branch line (not a repo)', () => {
  assert.equal(parseGitInfoOutput(''), null);
  assert.equal(parseGitInfoOutput('\n\n'), null);
});

test('renames keep the NEW path', () => {
  const out = parseGitInfoOutput(HEADER + 'R  old name.js -> new name.js\n');
  assert.deepEqual(out.statuses, [{ code: 'R ', dir: false, path: '/home/u/repo/new name.js' }]);
});

test('a non-rename file whose name contains " -> " stays intact', () => {
  const out = parseGitInfoOutput(HEADER + '?? a -> b.txt\n');
  assert.deepEqual(out.statuses, [{ code: '??', dir: false, path: '/home/u/repo/a -> b.txt' }]);
});

test('ambiguous rename lines (extra " -> " inside a name) are skipped, not mis-tinted', () => {
  const out = parseGitInfoOutput(HEADER + 'R  a -> b.txt -> c.txt\n M ok.js\n');
  assert.equal(out.statuses.length, 1);
  assert.equal(out.statuses[0].path, '/home/u/repo/ok.js');
  assert.equal(out.rawCount, 2); // still counted as dirty
});

test('rawCount includes skipped and capped lines (drives the dirty flag)', () => {
  const quotedOnly = parseGitInfoOutput(HEADER + '?? "we\\tird"\n');
  assert.equal(quotedOnly.statuses.length, 0);
  assert.equal(quotedOnly.rawCount, 1); // still dirty
  const lines = Array.from({ length: MAX_STATUS_ENTRIES + 5 }, (_v, i) => `?? f${i}.txt`).join('\n');
  const capped = parseGitInfoOutput(HEADER + lines + '\n');
  assert.equal(capped.rawCount, MAX_STATUS_ENTRIES + 5);
});

test('untracked directory entries keep the dir flag, trailing slash stripped', () => {
  const out = parseGitInfoOutput(HEADER + '?? newdir/\n');
  assert.deepEqual(out.statuses, [{ code: '??', dir: true, path: '/home/u/repo/newdir' }]);
});

test('C-quoted (control-character) paths are skipped, not misparsed', () => {
  const out = parseGitInfoOutput(HEADER + '?? "we\\tird"\n M src/ok.js\n');
  assert.equal(out.statuses.length, 1);
  assert.equal(out.statuses[0].path, '/home/u/repo/src/ok.js');
});

test('caps entries at MAX_STATUS_ENTRIES and flags truncation', () => {
  const lines = Array.from({ length: MAX_STATUS_ENTRIES + 5 }, (_v, i) => `?? f${i}.txt`).join('\n');
  const out = parseGitInfoOutput(HEADER + lines + '\n');
  assert.equal(out.statuses.length, MAX_STATUS_ENTRIES);
  assert.equal(out.truncated, true);
});

test('missing toplevel falls back to the relative path', () => {
  const out = parseGitInfoOutput('main\n\n\n M a.js\n');
  assert.deepEqual(out.statuses, [{ code: ' M', dir: false, path: 'a.js' }]);
});

test('remote line becomes a normalized web URL; empty remote gives null', () => {
  const out = parseGitInfoOutput('main\n/home/u/repo\ngit@github.com:user/repo.git\n M a.js\n');
  assert.equal(out.remoteUrl, 'https://github.com/user/repo');
  assert.equal(out.statuses.length, 1);
  assert.equal(parseGitInfoOutput(HEADER + ' M a.js\n').remoteUrl, null);
});

test('remoteWebUrl normalizes https / ssh / scp-like forms', () => {
  assert.equal(remoteWebUrl('https://github.com/user/repo.git'), 'https://github.com/user/repo');
  assert.equal(remoteWebUrl('https://github.com/user/repo'), 'https://github.com/user/repo');
  assert.equal(remoteWebUrl('http://gitea.local/user/repo.git'), 'http://gitea.local/user/repo');   // http scheme kept
  assert.equal(remoteWebUrl('https://gitea.local:3000/user/repo.git'), 'https://gitea.local:3000/user/repo'); // web port kept
  assert.equal(remoteWebUrl('https://user@bitbucket.org/team/repo.git'), 'https://bitbucket.org/team/repo');
  assert.equal(remoteWebUrl('ssh://git@github.com/user/repo.git'), 'https://github.com/user/repo');
  assert.equal(remoteWebUrl('ssh://git@gitlab.com:2222/group/sub/repo.git'), 'https://gitlab.com/group/sub/repo');
  assert.equal(remoteWebUrl('git@github.com:user/repo.git'), 'https://github.com/user/repo');
  assert.equal(remoteWebUrl('git@github.com:user/repo'), 'https://github.com/user/repo');
  assert.equal(remoteWebUrl('git@gitlab.com:group/sub/repo.git/'), 'https://gitlab.com/group/sub/repo');
  assert.equal(remoteWebUrl('git@github.com:/user/repo.git'), 'https://github.com/user/repo'); // leading slash variant
});

test('remoteWebUrl rejects non-web remotes', () => {
  assert.equal(remoteWebUrl(''), null);
  assert.equal(remoteWebUrl('/home/u/bare-repo.git'), null);          // local path
  assert.equal(remoteWebUrl('../sibling/repo'), null);                 // relative path
  assert.equal(remoteWebUrl('file:///home/u/repo.git'), null);         // file scheme
  assert.equal(remoteWebUrl('C:\\repos\\thing.git'), null);            // windows path
  assert.equal(remoteWebUrl('git@github.com:'), null);                 // empty path
});
