const { test } = require('node:test');
const assert = require('node:assert/strict');
const { withTimeout } = require('../src/async-timeout');

test('withTimeout returns an operation result before the deadline', async () => {
  assert.equal(await withTimeout(Promise.resolve('ok'), 50), 'ok');
});

test('withTimeout rejects a stalled operation with ETIMEDOUT', async () => {
  await assert.rejects(
    withTimeout(new Promise(() => {}), 10, 'WSL path did not respond.'),
    { name: 'OperationTimeoutError', code: 'ETIMEDOUT', message: 'WSL path did not respond.' }
  );
});
