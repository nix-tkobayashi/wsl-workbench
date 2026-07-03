const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseGitInfoOutput, MAX_STATUS_ENTRIES } = require('../src/git-status');

const HEADER = 'main\n/home/u/repo\n';

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
  const out = parseGitInfoOutput('main\n\n M a.js\n');
  assert.deepEqual(out.statuses, [{ code: ' M', dir: false, path: 'a.js' }]);
});
