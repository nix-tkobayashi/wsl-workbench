const { test } = require('node:test');
const assert = require('node:assert/strict');
const { render } = require('../src/markdown');

test('renders headings and inline emphasis/code', () => {
  assert.equal(render('# Title'), '<h1>Title</h1>');
  assert.ok(render('**bold**').includes('<strong>bold</strong>'));
  assert.ok(render('*it*').includes('<em>it</em>'));
  assert.ok(render('`x=1`').includes('<code>x=1</code>'));
});

test('escapes HTML so raw tags cannot inject markup', () => {
  const out = render('<script>alert(1)</script>');
  assert.ok(!out.includes('<script>'), 'script tag must be escaped');
  assert.ok(out.includes('&lt;script&gt;'));
});

test('code spans/blocks are shown verbatim and escaped', () => {
  assert.ok(render('`<b>`').includes('<code>&lt;b&gt;</code>'));
  const block = render('```\n<x> a & b\n```');
  assert.ok(block.startsWith('<pre><code>'));
  assert.ok(block.includes('&lt;x&gt; a &amp; b'));
});

test('a number surrounded by spaces is not mistaken for a code-span placeholder', () => {
  assert.equal(render('in 5 out'), '<p>in 5 out</p>');
});

test('links: safe URLs become anchors, javascript: is neutralized', () => {
  assert.ok(render('[go](https://a.com)').includes('<a href="https://a.com"'));
  const js = render('[x](javascript:alert)');
  assert.ok(!js.includes('href'), 'javascript: URL must not produce an href');
  assert.ok(!js.includes('<a '), 'javascript: URL must not produce an anchor');
  assert.equal(js, '<p>x</p>');
});

test('images: only http/data:image render, local paths fall back to alt', () => {
  assert.ok(render('![a](https://a.com/x.png)').includes('<img src="https://a.com/x.png"'));
  assert.equal(render('![alt](./local.png)'), '<p>alt</p>');
});

test('lists group consecutive items', () => {
  assert.equal(render('- a\n- b'), '<ul><li>a</li><li>b</li></ul>');
  assert.equal(render('1. a\n2. b'), '<ol><li>a</li><li>b</li></ol>');
});

test('blockquote and horizontal rule', () => {
  assert.ok(render('> quoted').includes('<blockquote>'));
  assert.equal(render('---'), '<hr>');
});

test('renders a GFM pipe table with header and body', () => {
  const out = render('| A | B | C |\n|---|---|---|\n| a | b | c |\n| d | e | f |');
  assert.ok(out.startsWith('<table><thead><tr><th>A</th><th>B</th><th>C</th></tr></thead>'));
  assert.ok(out.includes('<tbody><tr><td>a</td><td>b</td><td>c</td></tr><tr><td>d</td><td>e</td><td>f</td></tr></tbody>'));
});

test('table alignment from the delimiter row', () => {
  const out = render('| L | C | R |\n|:--|:-:|--:|\n| a | b | c |');
  assert.ok(out.includes('<th style="text-align:left">L</th>'));
  assert.ok(out.includes('<th style="text-align:center">C</th>'));
  assert.ok(out.includes('<td style="text-align:right">c</td>'));
});

test('table cells: escaped pipe stays literal, inline markup and escaping apply', () => {
  const out = render('| A\\|B | **b** |\n|---|---|\n| <x> | `c` |');
  assert.ok(out.includes('<th>A|B</th>'));
  assert.ok(out.includes('<strong>b</strong>'));
  assert.ok(out.includes('<td>&lt;x&gt;</td>'));
  assert.ok(out.includes('<code>c</code>'));
});

test('body rows are padded/truncated to the header column count', () => {
  const out = render('| A | B |\n|---|---|\n| a |\n| x | y | z |');
  assert.ok(out.includes('<tr><td>a</td><td></td></tr>'));
  assert.ok(out.includes('<tr><td>x</td><td>y</td></tr>'));
  assert.ok(!out.includes('<td>z</td>'));
});

test('escaped pipe at row end without a closing outer pipe stays literal', () => {
  const out = render('A | B\\|\n---|---\n a | b ');
  assert.ok(out.includes('<th>B|</th>'));
});

test('not a table when the delimiter column count mismatches', () => {
  const out = render('a | b\n---');
  assert.ok(!out.includes('<table>'));
});

test('escaped pipes alone do not start a table', () => {
  const out = render('A\\|B\n|---|');
  assert.ok(!out.includes('<table>'));
});

test('a pipe-less prose line continues the table as a single-cell row (GFM)', () => {
  const out = render('| A | B |\n|---|---|\n| a | b |\nbar');
  assert.ok(out.includes('<tr><td>bar</td><td></td></tr>'));
});

test('a block boundary (blockquote/list/heading) ends the table body', () => {
  const out = render('| A | B |\n|---|---|\n| a | b |\n> q | r');
  assert.ok(out.includes('<table>'));
  assert.ok(out.includes('<blockquote>'));
  assert.ok(!out.includes('<td>q'));
});

test('escaped backslash before a pipe still delimits cells (GFM)', () => {
  // Source row: "A \\| B" — literal backslash, then a real cell delimiter.
  const out = render('A \\\\| B\n---|---\n a | b ');
  assert.ok(out.includes('<table>'));
  assert.ok(out.includes('<th>A \\\\</th>'));
  assert.ok(out.includes('<th>B</th>'));
});

test('table right after a paragraph is not swallowed into it', () => {
  const out = render('intro text\n| A | B |\n|---|---|\n| a | b |');
  assert.ok(out.includes('<p>intro text</p>'));
  assert.ok(out.includes('<table>'));
});
