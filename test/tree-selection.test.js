const test = require('node:test');
const assert = require('node:assert/strict');
const { isUnder, range, topLevel, planMove, relativeTo } = require('../src/tree-selection');

test('range selects the visible rows between anchor and target in either direction', () => {
  const rows = ['/w/a', '/w/b', '/w/b/x', '/w/c', '/w/d'];
  assert.deepEqual(range(rows, '/w/b', '/w/d'), ['/w/b', '/w/b/x', '/w/c', '/w/d']);
  assert.deepEqual(range(rows, '/w/d', '/w/b'), ['/w/b', '/w/b/x', '/w/c', '/w/d']);
  assert.deepEqual(range(rows, '/w/c', '/w/c'), ['/w/c']);
});

test('range without a visible anchor selects just the target', () => {
  const rows = ['/w/a', '/w/b'];
  assert.deepEqual(range(rows, null, '/w/b'), ['/w/b']);
  assert.deepEqual(range(rows, '/w/gone', '/w/a'), ['/w/a']);
  assert.deepEqual(range(rows, '/w/a', '/w/gone'), []);
});

test('topLevel drops descendants of other selected directories', () => {
  assert.deepEqual(topLevel(['/w/src/a.js', '/w/src', '/w/README']), ['/w/src', '/w/README']);
  assert.deepEqual(topLevel(['/w/src', '/w/srcx']), ['/w/src', '/w/srcx']); // prefix but not a child
  assert.deepEqual(topLevel(['/w/a', '/w/a']), ['/w/a']);
});

test('planMove skips items already in the target and rejects moves into themselves', () => {
  const plan = planMove(['/w/a.txt', '/w/dir', '/w/dir/b.txt', '/w/t/c.txt', '/w/t'], '/w/t');
  assert.deepEqual(plan.moves, [{ source: '/w/a.txt', dest: '/w/t/a.txt' }, { source: '/w/dir', dest: '/w/t/dir' }]);
  assert.deepEqual(plan.invalid, []); // /w/t onto itself is a silent no-op
});

test('planMove rejects a target inside a selected directory', () => {
  const plan = planMove(['/w/dir', '/w/x.txt'], '/w/dir/sub');
  assert.deepEqual(plan.moves, [{ source: '/w/x.txt', dest: '/w/dir/sub/x.txt' }]);
  assert.deepEqual(plan.invalid, ['/w/dir']);
});

test('planMove into the filesystem root builds a single-slash destination', () => {
  assert.deepEqual(planMove(['/w/a'], '/').moves, [{ source: '/w/a', dest: '/a' }]);
});

test('relativeTo strips the workspace root and keeps outside paths absolute', () => {
  assert.equal(relativeTo('/w', '/w/src/a.js'), 'src/a.js');
  assert.equal(relativeTo('/w', '/w'), '.');
  assert.equal(relativeTo('/w', '/wx/a'), '/wx/a');
  assert.equal(relativeTo('/', '/etc/hosts'), 'etc/hosts');
});

test('isUnder matches the path itself and real descendants only', () => {
  assert.ok(isUnder('/w/a', '/w/a'));
  assert.ok(isUnder('/w/a/b', '/w/a'));
  assert.ok(!isUnder('/w/ab', '/w/a'));
  assert.ok(isUnder('/etc', '/'));
});
