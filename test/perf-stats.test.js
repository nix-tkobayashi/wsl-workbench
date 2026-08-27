const { test } = require('node:test');
const assert = require('node:assert/strict');
const { cpuTotals, cpuPercent, memPercent } = require('../src/perf-stats');

const core = (idle, busy) => ({ times: { user: busy, nice: 0, sys: 0, idle, irq: 0 } });

test('cpuTotals sums idle and total ticks across cores', () => {
  const totals = cpuTotals([core(80, 20), core(60, 40)]);
  assert.deepEqual(totals, { idle: 140, total: 200 });
});

test('cpuTotals tolerates an empty or missing core list', () => {
  assert.deepEqual(cpuTotals([]), { idle: 0, total: 0 });
  assert.deepEqual(cpuTotals(undefined), { idle: 0, total: 0 });
});

test('cpuPercent is the non-idle share of the tick delta', () => {
  const prev = { idle: 100, total: 200 };
  const next = { idle: 150, total: 300 }; // +100 ticks, 50 idle -> 50% busy
  assert.equal(cpuPercent(prev, next), 50);
});

test('cpuPercent reports 0 without a baseline or without a delta', () => {
  assert.equal(cpuPercent(null, { idle: 1, total: 2 }), 0);
  assert.equal(cpuPercent({ idle: 1, total: 2 }, { idle: 1, total: 2 }), 0);
});

test('cpuPercent clamps to 0..100 even on odd counter jumps', () => {
  assert.equal(cpuPercent({ idle: 0, total: 100 }, { idle: 300, total: 200 }), 0);
  assert.equal(cpuPercent({ idle: 100, total: 100 }, { idle: 90, total: 200 }), 100);
});

test('memPercent rounds the used share and guards a zero total', () => {
  assert.equal(memPercent(8, 32), 25);
  assert.equal(memPercent(1, 3), 33);
  assert.equal(memPercent(5, 0), 0);
});
