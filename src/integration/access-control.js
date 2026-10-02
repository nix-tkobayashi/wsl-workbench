// dots integration: per-session grants and per-principal rate limiting.
//
// Grants are issued ONLY from the Workbench UI (main process); no tool call can create, extend, or
// widen one. A grant names one principal and one session incarnation (session_id + generation), a
// permission set, and an expiry. Expiry is checked against BOTH wall-clock and a monotonic clock:
// whichever says "expired" wins, so neither a clock change nor sleep/resume can extend a grant.
// Grants are never persisted: an app restart, PTY replacement, or close ends them.
//
// Read access lasts what the user chose when sharing (SHARE_DURATIONS_MS). Input permissions added
// on top of it have their OWN, short expiry (INPUT_GRANT_MS, never past the read expiry); extending
// the share does not extend input, and when input runs out only the input permissions are removed.

const crypto = require('crypto');

const READ_PERMISSIONS = ['session:list', 'output:read'];
const INPUT_PERMISSIONS = ['input:write', 'operation:read'];
const SHARE_DURATIONS_MS = [30 * 60 * 1000, 2 * 60 * 60 * 1000, 8 * 60 * 60 * 1000];
const DEFAULT_GRANT_MS = SHARE_DURATIONS_MS[0];
// The UI offers only these; anything else (e.g. a tampered settings value) falls back to 30 min.
function normalizeShareDuration(ms) { return SHARE_DURATIONS_MS.includes(ms) ? ms : DEFAULT_GRANT_MS; }
const INPUT_GRANT_MS = 30 * 60 * 1000;
const MAX_ENDED = 1000;

class AccessControl {
  // onEnd(grant, code) runs for EVERY ended grant, whichever path noticed it (lazy expiry on a
  // read, the sweep, revoke), so the owner can always stop capture and drop the buffer.
  // onInputEnd(grant) runs when a grant's input permissions expire (the read grant stays).
  constructor({ now = Date.now, monotonic = () => performance.now(), randomUUID = crypto.randomUUID, onEnd = null, onInputEnd = null } = {}) {
    this.onEnd = onEnd;
    this.onInputEnd = onInputEnd;
    this.now = now;
    this.monotonic = monotonic;
    this.randomUUID = randomUUID;
    this.grants = new Map(); // session_id -> grant
    this.ended = new Map();  // `${principal}|${session_id}|${generation}` -> 'GRANT_EXPIRED' | 'GRANT_REVOKED'
  }

  issue({ principal, sessionId, generation, permissions = READ_PERMISSIONS, durationMs = DEFAULT_GRANT_MS }) {
    if (!(Number.isFinite(durationMs) && durationMs > 0)) throw new Error('Invalid sharing duration.');
    this.grants.delete(sessionId); // replaced silently: the caller restarts capture itself
    const grant = {
      grant_id: this.randomUUID(),
      principal,
      session_id: sessionId,
      generation,
      permissions: new Set(permissions),
      issued_at: this.now(),
      durationMs,
      expiresAtWall: this.now() + durationMs,
      expiresAtMono: this.monotonic() + durationMs,
      inputExpiresAtWall: null,
      inputExpiresAtMono: null,
      warned: false // the "expires soon" notice was given for the current expiry
    };
    this.grants.set(sessionId, grant);
    this.ended.delete(endedKey(principal, sessionId, generation));
    return grant;
  }

  // Extends from NOW (not from the old expiry), so repeated extends can't stack up. Uses the
  // duration the user chose when sharing. Input permissions keep their own (shorter) expiry.
  extend(sessionId) {
    const grant = this.active(sessionId);
    if (!grant) return null;
    grant.expiresAtWall = this.now() + grant.durationMs;
    grant.expiresAtMono = this.monotonic() + grant.durationMs;
    grant.warned = false;
    return grant;
  }

  isExpired(grant) {
    return this.now() >= grant.expiresAtWall || this.monotonic() >= grant.expiresAtMono;
  }

  // Milliseconds left, by whichever clock is closer to expiry.
  remainingMs(grant) {
    return Math.max(0, Math.min(grant.expiresAtWall - this.now(), grant.expiresAtMono - this.monotonic()));
  }

  inputRemainingMs(grant) {
    if (grant.inputExpiresAtWall == null) return 0;
    return Math.max(0, Math.min(grant.inputExpiresAtWall - this.now(), grant.inputExpiresAtMono - this.monotonic()));
  }

  // Add the input permissions with their own short expiry (capped by the read expiry).
  grantInput(grant) {
    const ms = Math.min(INPUT_GRANT_MS, this.remainingMs(grant));
    grant.inputExpiresAtWall = this.now() + ms;
    grant.inputExpiresAtMono = this.monotonic() + ms;
    for (const perm of INPUT_PERMISSIONS) grant.permissions.add(perm);
    return grant;
  }

  revokeInput(grant) {
    for (const perm of INPUT_PERMISSIONS) grant.permissions.delete(perm);
    grant.inputExpiresAtWall = null;
    grant.inputExpiresAtMono = null;
  }

  // Removes expired input permissions; true when it did (onInputEnd has run).
  expireInput(grant) {
    if (!grant.permissions.has('input:write') && !grant.permissions.has('operation:read')) return false;
    if (grant.inputExpiresAtWall != null && this.inputRemainingMs(grant) > 0) return false;
    this.revokeInput(grant);
    if (this.onInputEnd) { try { this.onInputEnd(grant); } catch {} }
    return true;
  }

  // The live grant for a session, ending it first when it has expired. Returns null if none.
  active(sessionId) {
    const grant = this.grants.get(sessionId);
    if (!grant) return null;
    if (this.isExpired(grant)) {
      this.end(sessionId, 'GRANT_EXPIRED');
      return null;
    }
    this.expireInput(grant);
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
      if (this.isExpired(grant)) { this.end(sessionId, 'GRANT_EXPIRED'); ended.push(grant); } else this.expireInput(grant);
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

module.exports = { AccessControl, RateLimiter, READ_PERMISSIONS, INPUT_PERMISSIONS, SHARE_DURATIONS_MS, DEFAULT_GRANT_MS, INPUT_GRANT_MS, normalizeShareDuration };
