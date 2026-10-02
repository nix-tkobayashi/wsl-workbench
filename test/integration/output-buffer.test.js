const test = require('node:test');
const assert = require('node:assert/strict');
const { TerminalNormalizer, OutputBuffer, utf8Prefix } = require('../../src/integration/output-buffer');

function norm(chunks) {
  const n = new TerminalNormalizer();
  return chunks.map((c) => n.push(c).text).join('');
}

test('normalizer strips CSI/OSC/DCS and keeps text (A04)', () => {
  assert.equal(norm(['\x1b[1;31mred\x1b[0m plain']), 'red plain');
  assert.equal(norm(['a\x1b]0;title\x07b']), 'ab');
  assert.equal(norm(['a\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\b']), 'alinkb');
  assert.equal(norm(['x\x1bP1;2|data\x1b\\y']), 'xy');
  assert.equal(norm(['\x1b(Bok\x1b=']), 'ok');
});

test('normalizer handles sequences split across PTY callbacks', () => {
  assert.equal(norm(['ab\x1b', '[3', '2mcd']), 'abcd');
  assert.equal(norm(['a\x1b]0;ti', 'tle\x1b', '\\b']), 'ab');
});

test('OSC 52 clipboard payloads are dropped, never surfaced as text (A04)', () => {
  const seen = [];
  const n = new TerminalNormalizer({ onOsc: (code) => seen.push(code) });
  const { text, controlRemoved } = n.push('before\x1b]52;c;aGVsbG8=\x07after');
  assert.equal(text, 'beforeafter');
  assert.equal(controlRemoved, true);
  assert.deepEqual(seen, ['52']); // reported to the hook (which ignores it), never replayed
});

test('OSC 7 is surfaced to the hook', () => {
  const seen = [];
  const n = new TerminalNormalizer({ onOsc: (code, payload) => seen.push([code, payload]) });
  n.push('\x1b]7;file://host/home/u\x07$ ');
  assert.deepEqual(seen, [['7', 'file://host/home/u']]);
});

test('CRLF and lone CR become LF, also across chunk boundaries', () => {
  assert.equal(norm(['a\r\nb\rc\n']), 'a\nb\nc\n');
  assert.equal(norm(['a\r', '\nb']), 'a\nb');
});

test('C0/C1 controls are removed; invalid UTF-8 marker is reported', () => {
  const n = new TerminalNormalizer();
  const r = n.push('a\x07b\x08c\x00d\u0085e�');
  assert.equal(r.text, 'abcde�');
  assert.equal(r.controlRemoved, true);
  assert.equal(r.replaced, true);
});

test('utf8Prefix never splits a code point', () => {
  assert.equal(utf8Prefix('aé', 2), 'a');
  assert.equal(utf8Prefix('😀x', 3), '');
  assert.equal(utf8Prefix('😀x', 4), '😀');
});

test('chunks are <= 4 KiB and never split a multibyte character (A04)', () => {
  const b = new OutputBuffer();
  b.append('あ'.repeat(5000)); // 15000 bytes
  for (const c of b.chunks) {
    assert.ok(c.bytes <= 4096);
    assert.equal(Buffer.byteLength(c.text), c.bytes);
  }
  const all = b.chunks.map((c) => c.text).join('');
  assert.equal(all, 'あ'.repeat(5000));
});

test('sequential reads with returned positions have no duplication or loss (A05)', () => {
  const b = new OutputBuffer();
  let expected = '';
  for (let i = 0; i < 300; i++) { const s = `line ${i} 日本語\n`; expected += s; b.append(s); }
  let pos = { seq: b.firstSeq, offset: 0 };
  let got = '';
  for (let guard = 0; guard < 1000; guard++) {
    const r = b.read(pos, 777);
    got += r.text;
    pos = r.pos;
    if (!r.hasMore) break;
  }
  assert.equal(got, expected);
  // Appending more and continuing from the last position yields exactly the new data.
  b.append('tail\n');
  const r = b.read(b.resolvePosition(pos).pos, 1000);
  assert.equal(r.text, 'tail\n');
});

test('retention by bytes reports an explicit gap and advances to the oldest data (A04)', () => {
  const b = new OutputBuffer({ maxBytes: 8192, chunkBytes: 1024 });
  b.append('x'.repeat(1024));
  const old = { seq: b.firstSeq, offset: 0 };
  b.append('y'.repeat(20000));
  assert.ok(b.totalBytes <= 8192);
  const resolved = b.resolvePosition(old);
  assert.equal(resolved.ok, true);
  assert.equal(resolved.gap.reason, 'retention_expired');
  assert.equal(resolved.pos.seq, b.firstSeq);
});

test('retention by age', () => {
  let t = 0;
  const b = new OutputBuffer({ maxAgeMs: 1000, now: () => t });
  b.append('old');
  t = 2000;
  b.prune();
  assert.equal(b.chunks.length, 0);
});

test('forged positions are rejected', () => {
  const b = new OutputBuffer();
  b.append('héllo');
  assert.equal(b.resolvePosition({ seq: 99, offset: 0 }).error, 'CURSOR_INVALID');
  assert.equal(b.resolvePosition({ seq: 1, offset: 2 }).error, 'CURSOR_INVALID'); // inside é
  assert.equal(b.resolvePosition({ seq: 1, offset: 100 }).error, 'CURSOR_INVALID');
  assert.equal(b.resolvePosition({ seq: 1, offset: 3 }).ok, true);
});

test('pause stores nothing and resume inserts a capture_paused gap', () => {
  const b = new OutputBuffer();
  b.append('a');
  const pos = b.endPosition();
  b.pause();
  b.append('hidden');
  b.resume();
  b.append('b');
  const r1 = b.read(b.resolvePosition(pos).pos, 100);
  assert.equal(r1.gap.reason, 'capture_paused');
  assert.equal(r1.text, 'b');
  assert.ok(!b.chunks.some((c) => c.text.includes('hidden')));
});

test('text before a gap marker is returned first, then the gap', () => {
  const b = new OutputBuffer();
  b.append('a');
  b.pause(); b.resume();
  b.append('b');
  const r1 = b.read({ seq: 1, offset: 0 }, 100);
  assert.equal(r1.text, 'a');
  assert.equal(r1.gap, null);
  assert.equal(r1.hasMore, true);
  const r2 = b.read(r1.pos, 100);
  assert.equal(r2.gap.reason, 'capture_paused');
  assert.equal(r2.text, 'b');
});

test('tail position returns the last max_bytes', () => {
  const b = new OutputBuffer({ chunkBytes: 10 });
  b.append('0123456789abcdefghij');
  const r = b.read(b.tailPosition(5), 5);
  assert.equal(r.text, 'fghij');
  assert.equal(r.hasMore, false);
});

test('max_bytes smaller than the next character reports tooSmall', () => {
  const b = new OutputBuffer();
  b.append('😀');
  const r = b.read({ seq: 1, offset: 0 }, 2);
  assert.equal(r.tooSmall, 4);
  assert.equal(r.text, '');
});

test('clear bumps the epoch', () => {
  const b = new OutputBuffer();
  b.append('x');
  const e = b.epoch;
  b.clear();
  assert.equal(b.epoch, e + 1);
  assert.equal(b.totalBytes, 0);
});

test('codex r2: a trickle of output cannot keep old text past maxAgeMs', () => {
  let t = 0;
  const b = new OutputBuffer({ maxAgeMs: 10 * 60 * 1000, now: () => t });
  b.append('old secret\n');
  for (let i = 1; i <= 20; i++) { t = i * 5 * 60 * 1000 / 5; b.append('.'); } // every minute, 20 min
  assert.ok(!b.chunks.some((c) => c.text.includes('old secret')));
  for (const c of b.chunks) assert.ok(t - c.firstAt < 10 * 60 * 1000);
});
