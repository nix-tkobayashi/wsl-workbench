const { test } = require('node:test');
const assert = require('node:assert/strict');
const { RECLAIM_SCRIPT, reclaimArgs, parseMeminfo, cacheBytes, parseReclaimOutput, formatGB } = require('../src/wsl-memory');

const KB = 1024;
const GB = 1024 * 1024 * 1024;

function meminfo({ total, free, available, buffers, cached, shmem }) {
  return [
    `MemTotal:       ${total} kB`,
    `MemFree:        ${free} kB`,
    `MemAvailable:   ${available} kB`,
    `Buffers:        ${buffers} kB`,
    `Cached:         ${cached} kB`,
    `Shmem:          ${shmem} kB`,
    'HugePages_Total:       0',
    'Active(anon):     12345 kB'
  ].join('\n');
}

test('reclaimArgs runs the script as root in the given distro without a login shell', () => {
  assert.deepEqual(reclaimArgs('Ubuntu'), ['-d', 'Ubuntu', '-u', 'root', '--exec', 'sh', '-c', RECLAIM_SCRIPT]);
});

test('script syncs before dropping caches and prints both snapshots', () => {
  const order = ['@@BEFORE', 'sync', 'drop_caches', 'compact_memory', '@@AFTER'].map((k) => RECLAIM_SCRIPT.indexOf(k));
  assert.ok(order.every((i) => i >= 0), RECLAIM_SCRIPT);
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.match(RECLAIM_SCRIPT, /sync \|\| exit 4/);
  assert.match(RECLAIM_SCRIPT, /drop_caches \|\| exit 3/);
});

test('parseMeminfo converts kB to bytes and keeps unitless / parenthesised keys', () => {
  const info = parseMeminfo(meminfo({ total: 8000000, free: 100, available: 200, buffers: 10, cached: 300, shmem: 50 }));
  assert.equal(info.MemTotal, 8000000 * KB);
  assert.equal(info.Cached, 300 * KB);
  assert.equal(info.HugePages_Total, 0);
  assert.equal(info['Active(anon)'], 12345 * KB);
  assert.deepEqual(parseMeminfo(''), {});
});

test('cacheBytes excludes shmem (not droppable) and never goes negative', () => {
  assert.equal(cacheBytes({ Cached: 300, Shmem: 50, Buffers: 10 }), 260);
  assert.equal(cacheBytes({ Cached: 10, Shmem: 50 }), 0);
  assert.equal(cacheBytes({}), 0);
});

test('parseReclaimOutput reports the freed page cache and availability after', () => {
  const before = meminfo({ total: 7969000, free: 400000, available: 5500000, buffers: 200000, cached: 5300000, shmem: 100000 });
  const after = meminfo({ total: 7969000, free: 5000000, available: 6300000, buffers: 20000, cached: 1200000, shmem: 100000 });
  const out = `@@BEFORE\r\n${before}\r\n@@AFTER\r\n${after}\r\n`;
  const r = parseReclaimOutput(out);
  assert.equal(r.freedBytes, ((5300000 - 100000 + 200000) - (1200000 - 100000 + 20000)) * KB);
  assert.equal(r.availableAfter, 6300000 * KB);
  assert.equal(r.totalBytes, 7969000 * KB);
  assert.equal(formatGB(r.freedBytes), '4.1');
});

test('parseReclaimOutput clamps a cache that grew to 0 freed', () => {
  const a = meminfo({ total: 100, free: 1, available: 1, buffers: 0, cached: 10, shmem: 0 });
  const b = meminfo({ total: 100, free: 1, available: 1, buffers: 0, cached: 20, shmem: 0 });
  assert.equal(parseReclaimOutput(`@@BEFORE\n${a}\n@@AFTER\n${b}`).freedBytes, 0);
});

test('parseReclaimOutput returns null when a snapshot is missing or empty', () => {
  const m = meminfo({ total: 100, free: 1, available: 1, buffers: 0, cached: 10, shmem: 0 });
  assert.equal(parseReclaimOutput(`@@BEFORE\n${m}\n`), null);
  assert.equal(parseReclaimOutput(`@@AFTER\n${m}\n@@BEFORE\n${m}`), null);
  assert.equal(parseReclaimOutput('@@BEFORE\n@@AFTER\n'), null);
  assert.equal(parseReclaimOutput(undefined), null);
});

test('formatGB rounds to one decimal and clamps negatives', () => {
  assert.equal(formatGB(GB * 2.26), '2.3');
  assert.equal(formatGB(-5), '0.0');
  assert.equal(formatGB(undefined), '0.0');
});
