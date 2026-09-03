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

// --- looksBinary (issue #79): text vs. "can't show this" sniffed from the file head ---
test('looksBinary: plain / UTF-8 / BOM / ANSI-log text is text', () => {
  assert.equal(ft.looksBinary(Buffer.from('')), false);
  assert.equal(ft.looksBinary(Buffer.from('hello\nworld\r\n\tindented\n')), false);
  assert.equal(ft.looksBinary(Buffer.from('日本語のテキスト\n')), false);
  assert.equal(ft.looksBinary(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('bom\n')])), false);
  assert.equal(ft.looksBinary(Buffer.from('\x1b[32mok\x1b[0m\n\x0c')), false); // ESC and form feed are text
  assert.equal(ft.looksBinary(new Uint8Array([0x61, 0x62, 0x0a])), false);
});

test('looksBinary: NUL bytes, control-heavy data and non-UTF-8 bytes are binary', () => {
  assert.equal(ft.looksBinary(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00])), true); // zip / xlsx header
  assert.equal(ft.looksBinary(Buffer.from('text\0with nul')), true);
  assert.equal(ft.looksBinary(Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x61, 0x62, 0x63])), true); // mostly control
  assert.equal(ft.looksBinary(Buffer.from('日本語', 'utf8').subarray(0, 4)), true); // truncated sequence in a full sample = invalid
  assert.equal(ft.looksBinary(Buffer.from([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea])), true); // Shift_JIS "日本語"
  assert.equal(ft.looksBinary(Buffer.from([0xff, 0xfe, 0x61, 0x00, 0x62, 0x00])), true); // UTF-16LE with BOM
});

test('looksBinary: only the head is sampled, and a sample cut mid-character still reads as text', () => {
  const twoBytes = Buffer.from('é'.repeat(5000), 'utf8'); // 10000 bytes; 8192 splits a 2-byte char
  assert.equal(twoBytes.length, 10000);
  assert.equal(ft.looksBinary(twoBytes), false);
  assert.equal(ft.looksBinary(twoBytes, 8191), false); // the odd cut too
  // a NUL beyond the sample is not seen (the head decides), a NUL inside it is
  const late = Buffer.concat([Buffer.alloc(ft.TEXT_SAMPLE_BYTES, 0x61), Buffer.from([0])]);
  assert.equal(ft.looksBinary(late), false);
  assert.equal(ft.looksBinary(late, late.length), true);
  // a truncated sample whose invalid bytes are NOT just a dangling tail stays binary
  const bad = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.alloc(ft.TEXT_SAMPLE_BYTES + 10, 0x61)]);
  assert.equal(ft.looksBinary(bad), true);
  // only an unfinished multi-byte sequence may dangle at the cut; invalid trailing bytes never pass
  const n = ft.TEXT_SAMPLE_BYTES;
  const padded = (tail) => Buffer.concat([Buffer.alloc(n - tail.length, 0x61), Buffer.from(tail), Buffer.from('more text')]);
  assert.equal(ft.looksBinary(padded([0xe3, 0x81])), false);      // 2 of 3 bytes of "あ" — text
  assert.equal(ft.looksBinary(padded([0xf0, 0x9f, 0x98])), false); // 3 of 4 bytes of an emoji — text
  assert.equal(ft.looksBinary(padded([0xe3])), false);            // bare lead byte — text
  assert.equal(ft.looksBinary(padded([0x61, 0xff])), true);       // 0xFF is never UTF-8
  assert.equal(ft.looksBinary(padded([0x61, 0x61, 0xff])), true);
  assert.equal(ft.looksBinary(padded([0x61, 0x80])), true);       // stray continuation byte
  assert.equal(ft.looksBinary(padded([0xc0, 0x80])), true);       // overlong lead
  assert.equal(ft.looksBinary(padded([0xf8, 0x80])), true);       // out-of-range lead
  assert.equal(ft.looksBinary(padded([0xe0, 0x80])), true);       // overlong 3-byte prefix
  assert.equal(ft.looksBinary(padded([0xed, 0xa0])), true);       // UTF-16 surrogate prefix
  assert.equal(ft.looksBinary(padded([0xf0, 0x80])), true);       // overlong 4-byte prefix
  assert.equal(ft.looksBinary(padded([0xf4, 0x90])), true);       // beyond U+10FFFF
  assert.equal(ft.looksBinary(padded([0xe3, 0x81, 0x82])), false); // complete "あ" at the cut
});

test('looksBinary tolerates bad input', () => {
  assert.equal(ft.looksBinary(null), false);
  assert.equal(ft.looksBinary(undefined), false);
  assert.equal(ft.looksBinary([0x61, 0x62]), false);
  assert.equal(ft.looksBinary([0x00]), true);
});
