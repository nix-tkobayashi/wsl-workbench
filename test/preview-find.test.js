const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildTextIndex, locate, findAll, findInNodes } = require('../src/preview-find');

const P1 = 'p1'; const P2 = 'p2';

test('buildTextIndex joins same-block nodes seamlessly and separates blocks with a newline', () => {
  const { text, segments } = buildTextIndex([
    { data: 'foo ', block: P1 }, { data: 'bar', block: P1 }, { data: 'baz', block: P2 }
  ]);
  assert.equal(text, 'foo bar\nbaz');
  assert.deepEqual(segments, [
    { index: 0, start: 0, end: 4 }, { index: 1, start: 4, end: 7 }, { index: 2, start: 8, end: 11 }
  ]);
});

test('findAll is literal (regex metacharacters are not special) and honours case sensitivity', () => {
  assert.deepEqual(findAll('a.b A.B axb', 'a.b', false), [{ start: 0, end: 3 }, { start: 4, end: 7 }]);
  assert.deepEqual(findAll('a.b A.B axb', 'a.b', true), [{ start: 0, end: 3 }]);
  assert.deepEqual(findAll('abc', '', false), []);
});

test('locate maps boundary offsets to the right node for starts vs ends', () => {
  const { segments } = buildTextIndex([{ data: 'abc', block: P1 }, { data: 'def', block: P1 }]);
  assert.deepEqual(locate(segments, 3, false), { index: 1, offset: 0 }); // start of "def"
  assert.deepEqual(locate(segments, 3, true), { index: 0, offset: 3 });  // end of "abc"
  assert.deepEqual(locate(segments, 6, true), { index: 1, offset: 3 });
  assert.equal(locate(segments, 7, false), null);
});

test('a match may span inline markup within one block', () => {
  const nodes = [{ data: 'foo ', block: P1 }, { data: 'bar', block: P1 }, { data: ' end', block: P1 }];
  assert.deepEqual(findInNodes(nodes, 'foo bar', false), [
    { start: { index: 0, offset: 0 }, end: { index: 1, offset: 3 } }
  ]);
  assert.deepEqual(findInNodes(nodes, 'bar end', false), [
    { start: { index: 1, offset: 0 }, end: { index: 2, offset: 4 } }
  ]);
});

test('a match never crosses a block boundary', () => {
  const nodes = [{ data: 'a', block: P1 }, { data: 'b', block: P2 }];
  assert.deepEqual(findInNodes(nodes, 'ab', false), []);
  assert.equal(findInNodes(nodes, 'b', false).length, 1);
});

test('empty text nodes are skipped over, never chosen as a match edge', () => {
  const nodes = [{ data: 'ab', block: P1 }, { data: '', block: P1 }, { data: 'cd', block: P1 }];
  assert.deepEqual(findInNodes(nodes, 'bc', false), [
    { start: { index: 0, offset: 1 }, end: { index: 2, offset: 1 } }
  ]);
  assert.deepEqual(findInNodes(nodes, 'ab', false), [
    { start: { index: 0, offset: 0 }, end: { index: 0, offset: 2 } }
  ]);
});
