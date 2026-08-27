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

test('mermaid fences keep the language-mermaid class and verbatim source (preview swaps them for SVG)', () => {
  const out = render('```mermaid\ngraph TD\n  A --> B\n```');
  assert.ok(out.includes('<pre><code class="language-mermaid">'));
  assert.ok(out.includes('A --&gt; B')); // escaped, un-mangled source for mermaid.render
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

test('indented items nest inside the parent item (#68)', () => {
  assert.equal(render('- foo\n  - bar'), '<ul><li>foo<ul><li>bar</li></ul></li></ul>');
  assert.equal(render('- a\n  - b\n- c'), '<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>');
});

test('deeper nesting unwinds level by level', () => {
  assert.equal(
    render('- a\n  - b\n    - c\n- d'),
    '<ul><li>a<ul><li>b<ul><li>c</li></ul></li></ul></li><li>d</li></ul>'
  );
});

test('ordered list nests inside an unordered item and vice versa', () => {
  assert.equal(render('- a\n  1. b\n  2. c'), '<ul><li>a<ol><li>b</li><li>c</li></ol></li></ul>');
  assert.equal(render('1. a\n   - b'), '<ol><li>a<ul><li>b</li></ul></li></ol>');
});

test('tab-indented items nest too', () => {
  assert.equal(render('- foo\n\t- bar'), '<ul><li>foo<ul><li>bar</li></ul></li></ul>');
});

test('marker-type switch at the same level starts a new list', () => {
  assert.equal(render('- a\n1. b'), '<ul><li>a</li></ul><ol><li>b</li></ol>');
});

test('inline markup still renders inside nested items', () => {
  assert.equal(
    render('- **a**\n  - `c`'),
    '<ul><li><strong>a</strong><ul><li><code>c</code></li></ul></li></ul>'
  );
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
