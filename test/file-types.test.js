const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ft = require('../src/file-types');

test('isImagePath recognizes image extensions (case-insensitive)', () => {
  for (const p of ['/a/b/pic.png', '/a/PIC.PNG', 'x.jpg', 'x.jpeg', 'x.gif', 'x.webp', 'x.bmp', 'x.svg', 'x.ico', 'x.avif']) {
    assert.equal(ft.isImagePath(p), true, p);
  }
});

test('isImagePath rejects non-images and extension-less names', () => {
  for (const p of ['/a/b/notes.txt', '/a/b/script.js', '/a/b/Makefile', '/a/.gitignore', '/a/b/archive.png.txt']) {
    assert.equal(ft.isImagePath(p), false, p);
  }
});

test('imageMimeForPath maps known types and falls back to octet-stream', () => {
  assert.equal(ft.imageMimeForPath('a.png'), 'image/png');
  assert.equal(ft.imageMimeForPath('a.JPG'), 'image/jpeg');
  assert.equal(ft.imageMimeForPath('a.svg'), 'image/svg+xml');
  assert.equal(ft.imageMimeForPath('a.txt'), 'application/octet-stream');
});

test('isHtmlPath recognizes .html/.htm (case-insensitive) and rejects others', () => {
  for (const p of ['/a/b/page.html', '/a/b/page.htm', 'INDEX.HTML', 'C:\\x\\y.Htm']) {
    assert.equal(ft.isHtmlPath(p), true, p);
  }
  for (const p of ['/a/b/page.xhtml', '/a/b/page.html.txt', 'html', '/a/.html', 'x.md']) {
    assert.equal(ft.isHtmlPath(p), false, p);
  }
});

test('isPdfPath recognizes .pdf (case-insensitive) and rejects others', () => {
  for (const p of ['/a/b/doc.pdf', 'DOC.PDF', 'C:\\x\\y.Pdf']) {
    assert.equal(ft.isPdfPath(p), true, p);
  }
  for (const p of ['/a/b/doc.pdf.txt', 'pdf', '/a/.pdf', 'x.ps']) {
    assert.equal(ft.isPdfPath(p), false, p);
  }
});

test('extOf handles both separators and dotfiles', () => {
  assert.equal(ft.extOf('C:\\\\x\\\\y.PNG'), '.png');
  assert.equal(ft.extOf('/a/b/c.tar.gz'), '.gz');
  assert.equal(ft.extOf('/a/.bashrc'), ''); // leading-dot name is not an extension
  assert.equal(ft.extOf('noext'), '');
});

// Same renderer-collision guard as i18n.js: file-types.js loads as a classic <script> and must
// not leak globals or clash with the preload's non-configurable window.api.
test('file-types.js is IIFE-wrapped and sets window.fileTypes with a global `api` present', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'file-types.js'), 'utf8');
  const firstCode = src.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('//'));
  assert.ok(firstCode.startsWith('(function'), 'file-types.js should be wrapped in an IIFE');
  assert.ok(!/(^|\n)\s*(const|let|var)\s+api\b/.test(src), 'must not declare a top-level `api`');

  const sandbox = { window: {}, module: undefined };
  vm.createContext(sandbox);
  Object.defineProperty(sandbox, 'api', { value: { bridge: true }, configurable: false, writable: false });
  assert.doesNotThrow(() => vm.runInContext(src, sandbox, { filename: 'file-types.js' }));
  assert.equal(sandbox.window.fileTypes.isImagePath('a.png'), true);
});
