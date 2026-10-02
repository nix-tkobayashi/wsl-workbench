// dots integration: per-session grants and per-principal rate limiting.
//
// Grants are issued ONLY from the Workbench UI (main process); no tool call can create or widen one.
// A grant names one principal and one session incarnation (session_id + generation) and a
// permission set. Two independent per-pane switches, both OFF by default:
//   - read sharing  (session:list + output:read): the grant exists,
//   - input         (input:write + operation:read): added to an existing read grant only.
// There is NO time limit: a switch stays ON until the user turns it off, the pane's PTY is replaced
// or closed, the integration is turned off, or the app exits. Grants are never persisted, so a
// restart or a restored pane always starts with both switches OFF.

const crypto = require('crypto');

const READ_PERMISSIONS = ['session:list', 'output:read'];
const INPUT_PERMISSIONS = ['input:write', 'operation:read'];
const MAX_ENDED = 1000;

class AccessControl {
  // onEnd(grant, code) runs for EVERY ended grant (revoke, PTY replaced/closed, integration off),
  // so the owner can always stop capture and drop the buffer.
  constructor({ now = Date.now, randomUUID = crypto.randomUUID, onEnd = null } = {}) {
    this.onEnd = onEnd;
    this.now = now;
    this.randomUUID = randomUUID;
    this.grants = new Map(); // session_id -> grant
    this.ended = new Map();  // `${principal}|${session_id}|${generation}` -> 'GRANT_REVOKED'
  }

  issue({ principal, sessionId, generation, permissions = READ_PERMISSIONS }) {
    this.grants.delete(sessionId); // replaced silently: the caller restarts capture itself
    const grant = {
      grant_id: this.randomUUID(),
      principal,
      session_id: sessionId,
      generation,
      permissions: new Set(permissions),
      issued_at: this.now()
    };
    this.grants.set(sessionId, grant);
    this.ended.delete(endedKey(principal, sessionId, generation));
    return grant;
  }

  // The live grant for a session, or null.
  active(sessionId) { return this.grants.get(sessionId) || null; }

  hasInput(grant) { return !!grant && grant.permissions.has('input:write'); }

  // Input switch ON (only on top of a read grant). No expiry.
  grantInput(grant) {
    for (const perm of INPUT_PERMISSIONS) grant.permissions.add(perm);
    return grant;
  }

  // Input switch OFF; the read grant stays.
  revokeInput(grant) {
    for (const perm of INPUT_PERMISSIONS) grant.permissions.delete(perm);
  }

  end(sessionId, code = 'GRANT_REVOKED') {
    const grant = this.grants.get(sessionId);
    if (!grant) return null;
    this.grants.delete(sessionId);
    this.ended.set(endedKey(grant.principal, grant.session_id, grant.generation), code);
    if (this.ended.size > MAX_ENDED) this.ended.delete(this.ended.keys().next().value); // bounded memory
    if (this.onEnd) { try { this.onEnd(grant, code); } catch {} }
    return grant;
  }

  endAll(code = 'GRANT_REVOKED') {
    const ended = [];
    for (const sessionId of [...this.grants.keys()]) {
      const grant = this.end(sessionId, code);
      if (grant) ended.push(grant);
    }
    return ended;
  }

  // Authorization decision for one call. Never reveals a session the principal was not granted:
  // those are SESSION_NOT_FOUND. A principal whose own grant ended learns why.
  check(principal, sessionId, generation, permission) {
    const grant = this.active(sessionId);
    if (grant && grant.principal === principal && grant.generation === generation) {
      if (!grant.permissions.has(permission)) return { ok: false, code: 'FORBIDDEN' };
      return { ok: true, grant };
    }
    const ended = this.ended.get(endedKey(principal, sessionId, generation));
    if (ended) return { ok: false, code: ended };
    return { ok: false, code: 'SESSION_NOT_FOUND' };
  }

  endedCode(principal, sessionId, generation) {
    return this.ended.get(endedKey(principal, sessionId, generation)) || null;
  }

  grantsFor(principal) {
    const out = [];
    for (const grant of this.grants.values()) if (grant.principal === principal) out.push(grant);
    return out;
  }

  // Forget end records (e.g. when the principal itself is replaced on pairing reset).
  forgetEnded() { this.ended.clear(); }
}

function endedKey(principal, sessionId, generation) { return `${principal}|${sessionId}|${generation}`; }

// Token bucket per principal (handoff §8: 5 calls/s, burst 10).
class RateLimiter {
  constructor({ ratePerSec = 5, burst = 10, monotonic = () => performance.now() } = {}) {
    this.ratePerSec = ratePerSec;
    this.burst = burst;
    this.monotonic = monotonic;
    this.buckets = new Map();
  }

  take(principal) {
    const t = this.monotonic();
    const bucket = this.buckets.get(principal) || { tokens: this.burst, at: t };
    bucket.tokens = Math.min(this.burst, bucket.tokens + ((t - bucket.at) / 1000) * this.ratePerSec);
    bucket.at = t;
    this.buckets.set(principal, bucket);
    if (bucket.tokens >= 1) { bucket.tokens -= 1; return { ok: true }; }
    return { ok: false, retryAfterMs: Math.ceil(((1 - bucket.tokens) / this.ratePerSec) * 1000) };
  }
}

module.exports = { AccessControl, RateLimiter, READ_PERMISSIONS, INPUT_PERMISSIONS };
