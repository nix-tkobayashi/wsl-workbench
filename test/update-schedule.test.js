const { test } = require('node:test');
const assert = require('node:assert/strict');
const { shouldCheck, PERIOD_MS, MIN_GAP_MS } = require('../src/update-schedule');

test('first check always runs; never two at once', () => {
  assert.equal(shouldCheck({ now: 0, lastCheckAt: null, inFlight: false, reason: 'startup' }), true);
  assert.equal(shouldCheck({ now: 0, lastCheckAt: null, inFlight: true, reason: 'startup' }), false);
});

test('focus re-checks at most every 15 minutes; the hourly timer re-checks every hour', () => {
  const last = 1_000_000;
  assert.equal(shouldCheck({ now: last + MIN_GAP_MS - 1, lastCheckAt: last, inFlight: false, reason: 'focus' }), false);
  assert.equal(shouldCheck({ now: last + MIN_GAP_MS, lastCheckAt: last, inFlight: false, reason: 'focus' }), true);
  // The hourly tick is never skipped because a focus or startup check finished a moment ago.
  assert.equal(shouldCheck({ now: last + 1, lastCheckAt: last, inFlight: false, reason: 'periodic' }), true);
  assert.equal(shouldCheck({ now: last + 1, lastCheckAt: last, inFlight: true, reason: 'periodic' }), false);
  assert.ok(PERIOD_MS > MIN_GAP_MS);
});

test('a clock moved back does not postpone the next check', () => {
  assert.equal(shouldCheck({ now: 10, lastCheckAt: 1_000_000, inFlight: false, reason: 'focus' }), true);
});
