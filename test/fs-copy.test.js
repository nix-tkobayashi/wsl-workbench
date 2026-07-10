const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { copyFileContentsSync } = require('../src/fs-copy');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fs-copy-test-'));
}

test('copyFileContentsSync copies file contents byte-for-byte', () => {
  const dir = tmpDir();
  const src = path.join(dir, 'src.bin');
  const dst = path.join(dir, 'dst.bin');
  // Larger than one read chunk boundary case is covered by the loop; use a few MB of random-ish data.
  const data = Buffer.alloc(5 * 1024 * 1024);
  for (let i = 0; i < data.length; i += 4096) data[i] = i % 251;
  fs.writeFileSync(src, data);
  copyFileContentsSync(src, dst);
  assert.equal(Buffer.compare(fs.readFileSync(dst), data), 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('copyFileContentsSync copies an empty file', () => {
  const dir = tmpDir();
  const src = path.join(dir, 'empty');
  const dst = path.join(dir, 'empty-copy');
  fs.writeFileSync(src, '');
  copyFileContentsSync(src, dst);
  assert.equal(fs.readFileSync(dst).length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('copyFileContentsSync preserves the source permission bits (executables stay executable)', () => {
  const dir = tmpDir();
  const src = path.join(dir, 'tool.sh');
  const dst = path.join(dir, 'tool-copy.sh');
  fs.writeFileSync(src, '#!/bin/sh\n');
  fs.chmodSync(src, 0o755);
  copyFileContentsSync(src, dst);
  assert.equal(fs.statSync(dst).mode & 0o777, 0o755);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('copyFileContentsSync throws EEXIST when the destination exists (COPYFILE_EXCL semantics)', () => {
  const dir = tmpDir();
  const src = path.join(dir, 'a');
  const dst = path.join(dir, 'b');
  fs.writeFileSync(src, 'new');
  fs.writeFileSync(dst, 'old');
  assert.throws(() => copyFileContentsSync(src, dst), { code: 'EEXIST' });
  assert.equal(fs.readFileSync(dst, 'utf8'), 'old'); // untouched
  fs.rmSync(dir, { recursive: true, force: true });
});

test('copyFileContentsSync throws ENOENT for a missing source without creating the destination', () => {
  const dir = tmpDir();
  const dst = path.join(dir, 'never');
  assert.throws(() => copyFileContentsSync(path.join(dir, 'missing'), dst), { code: 'ENOENT' });
  assert.equal(fs.existsSync(dst), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
