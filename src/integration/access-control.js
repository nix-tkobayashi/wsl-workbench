// dots integration: per-session grants and per-principal rate limiting.
//
// Grants are issued ONLY from the Workbench UI (main process); no tool call can create, extend, or
// widen one. A grant names one principal and one session incarnation (session_id + generation), a
// permission set, and an expiry. Expiry is checked against BOTH wall-clock and a monotonic clock:
// whichever says "expired" wins, so neither a clock change nor sleep/resume can extend a grant.
// Grants are never persisted: an app restart, PTY replacement, or close ends them.

const crypto = require('crypto');

const READ_PERMISSIONS = ['session:list', 'output:read'];
const DEFAULT_GRANT_MS = 30 * 60 * 1000;
const MAX_ENDED = 1000;

class AccessControl {
  // onEnd(grant, code) runs for EVERY ended grant, whichever path noticed it (lazy expiry on a
  // read, the sweep, revoke), so the owner can always stop capture and drop the buffer.
  constructor({ now = Date.now, monotonic = () => performance.now(), randomUUID = crypto.randomUUID, onEnd = null } = {}) {
    this.onEnd = onEnd;
    this.now = now;
    this.monotonic = monotonic;
    this.randomUUID = randomUUID;
    this.grants = new Map(); // session_id -> grant
    this.ended = new Map();  // `${principal}|${session_id}|${generation}` -> 'GRANT_EXPIRED' | 'GRANT_REVOKED'
  }

  issue({ principal, sessionId, generation, permissions = READ_PERMISSIONS, durationMs = DEFAULT_GRANT_MS }) {
    this.grants.delete(sessionId); // replaced silently: the caller restarts capture itself
    const grant = {
      grant_id: this.randomUUID(),
      principal,
      session_id: sessionId,
      generation,
      permissions: new Set(permissions),
      issued_at: this.now(),
      expiresAtWall: this.now() + durationMs,
      expiresAtMono: this.monotonic() + durationMs
    };
    this.grants.set(sessionId, grant);
    this.ended.delete(endedKey(principal, sessionId, generation));
    return grant;
  }

  // Extends from NOW (not from the old expiry), so repeated extends can't stack up.
  extend(sessionId, durationMs = DEFAULT_GRANT_MS) {
    const grant = this.active(sessionId);
    if (!grant) return null;
    grant.expiresAtWall = this.now() + durationMs;
    grant.expiresAtMono = this.monotonic() + durationMs;
    return grant;
  }

  isExpired(grant) {
    return this.now() >= grant.expiresAtWall || this.monotonic() >= grant.expiresAtMono;
  }

  // The live grant for a session, ending it first when it has expired. Returns null if none.
  active(sessionId) {
    const grant = this.grants.get(sessionId);
    if (!grant) return null;
    if (this.isExpired(grant)) {
      this.end(sessionId, 'GRANT_EXPIRED');
      return null;
    }
    return grant;
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

  // Sweep expired grants; returns the ended ones (so the caller can drop their buffers).
  sweep() {
    const ended = [];
    for (const [sessionId, grant] of [...this.grants]) {
      if (this.isExpired(grant)) { this.end(sessionId, 'GRANT_EXPIRED'); ended.push(grant); }
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
    for (const sessionId of [...this.grants.keys()]) {
      const grant = this.active(sessionId);
      if (grant && grant.principal === principal) out.push(grant);
    }
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

module.exports = { AccessControl, RateLimiter, READ_PERMISSIONS, DEFAULT_GRANT_MS };
