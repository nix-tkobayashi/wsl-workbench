const test = require('node:test');
const assert = require('node:assert/strict');
const { planOpen, replaceInOrder } = require('../src/editor-tab-rules');

const tabs = [
  { path: '/w/a.js', preview: false, dirty: false },
  { path: '/w/b.md', preview: true, dirty: false },
  { path: '/w/c.txt', preview: false, dirty: true }
];

test('planOpen: single click on a new file takes over the preview tab', () => {
  assert.deepEqual(planOpen(tabs, '/w/d.js', { preview: true }), { action: 'replace', replacePath: '/w/b.md' });
});

test('planOpen: single click with no preview tab appends a new preview tab', () => {
  const noPreview = tabs.filter((t) => !t.preview);
  assert.deepEqual(planOpen(noPreview, '/w/d.js', { preview: true }), { action: 'append' });
  assert.deepEqual(planOpen([], '/w/d.js', { preview: true }), { action: 'append' });
});

test('planOpen: double click (keep) never reuses the preview tab', () => {
  assert.deepEqual(planOpen(tabs, '/w/d.js', { preview: false }), { action: 'append' });
  assert.deepEqual(planOpen(tabs, '/w/d.js'), { action: 'append' });
});

test('planOpen: an already open permanent tab is just activated', () => {
  assert.deepEqual(planOpen(tabs, '/w/a.js', { preview: true }), { action: 'activate' });
  assert.deepEqual(planOpen(tabs, '/w/a.js', { preview: false }), { action: 'activate' });
});

test('planOpen: the preview tab itself is activated by a click and promoted by a double click', () => {
  assert.deepEqual(planOpen(tabs, '/w/b.md', { preview: true }), { action: 'activate' });
  assert.deepEqual(planOpen(tabs, '/w/b.md', { preview: false }), { action: 'promote' });
});

test('planOpen: a dirty preview tab is kept, not replaced', () => {
  const dirtyPreview = [{ path: '/w/b.md', preview: true, dirty: true }];
  assert.deepEqual(planOpen(dirtyPreview, '/w/d.js', { preview: true }), { action: 'append' });
});

test('planOpen: tolerates bad input', () => {
  assert.deepEqual(planOpen(null, '/w/d.js', { preview: true }), { action: 'append' });
  assert.deepEqual(planOpen([null, undefined], '/w/d.js', { preview: true }), { action: 'append' });
});

test('replaceInOrder: swaps the entry in place, keeping the strip order', () => {
  const next = { path: '/w/d.js', preview: true, dirty: false };
  const out = replaceInOrder(tabs, '/w/b.md', next);
  assert.deepEqual(out.map((t) => t.path), ['/w/a.js', '/w/d.js', '/w/c.txt']);
  assert.equal(out[1], next);
  assert.equal(tabs[1].path, '/w/b.md'); // input untouched
  assert.deepEqual(replaceInOrder(null, '/w/b.md', next), []);
});
