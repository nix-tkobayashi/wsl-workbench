class OperationTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OperationTimeoutError';
    this.code = 'ETIMEDOUT';
  }
}

function withTimeout(operation, timeoutMs, message = 'Operation timed out.') {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.resolve(operation);

  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new OperationTimeoutError(message)), timeoutMs);
  });

  return Promise.race([Promise.resolve(operation), timeout])
    .finally(() => clearTimeout(timer));
}

module.exports = { OperationTimeoutError, withTimeout };
