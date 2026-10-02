// Stage B: durable operation journal (metadata only — NEVER prompt text or terminal output).
//
// One JSON record per line, each carrying an HMAC-SHA256 tag (key from the OS-protected key
// provider, recorded by key version) so corruption or tampering is detected. Every append is
// written and fsync'ed before the caller proceeds; the caller must not write to the PTY unless the
// matching record ("intent") was durably stored.
//
// Records:
//   accepted  { op, principal, method, target, idx, digest, profile, action, grant, at, exp }
//   phase     { op, phase, dispatch_started, delivery, at }
//   final     { op, status, code, at, delivered_at }
// Recovery on open: an op with no "final" becomes failed if it never recorded dispatch intent,
// otherwise outcome_unknown. Nothing is ever replayed. Records older than the retention window are
// compacted away (atomic rewrite), which is also when duplicate suppression for them ends.
//
// A torn LAST line (no trailing newline, from a crash mid-append) is ignored: its transition never
// became durable, so the action after it never ran. Any other bad line, or a key mismatch, makes the
// store unavailable — the index is never silently reset.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = 'operations.jsonl';
const RETENTION_MS = 24 * 60 * 60 * 1000;

// fs.writeSync may write fewer bytes than asked; a record counts only when ALL of it is written.
function writeAll(fd, text) {
  const buf = Buffer.from(text, 'utf8');
  let off = 0;
  while (off < buf.length) {
    const n = fs.writeSync(fd, buf, off, buf.length - off);
    if (!(n > 0)) throw new Error('short write');
    off += n;
  }
}

class JournalUnavailable extends Error {
  constructor(message) { super(message); this.code = 'JOURNAL_UNAVAILABLE'; }
}

class OperationStore {
  constructor({ dir, key, keyVersion = 'k1', now = Date.now, retentionMs = RETENTION_MS }) {
    this.dir = dir;
    this.file = path.join(dir, FILE);
    this.key = key;
    this.keyVersion = keyVersion;
    this.now = now;
    this.retentionMs = retentionMs;
    this.fd = null;
    this.healthy = false;
    this.error = null;
    this.ops = new Map();   // op id -> durable summary (no text)
    this.index = new Map(); // idempotency index digest -> op id
  }

  mac(body) { return crypto.createHmac('sha256', this.key).update(body).digest('hex'); }

  // Keyed digest (for idempotency index and payload comparison; never a bare hash of user text).
  digest(label, value) {
    return crypto.createHmac('sha256', this.key).update(`${label}|`).update(value).digest('hex');
  }

  open() {
    try {
      if (!Buffer.isBuffer(this.key) || this.key.length < 32) throw new JournalUnavailable('Journal key unavailable.');
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const records = this.readAll();
      const cutoff = this.now() - this.retentionMs;
      const keep = new Set();
      for (const r of records) if (r.k === 'accepted' && r.at >= cutoff) keep.add(r.op);
      const kept = records.filter((r) => keep.has(r.op));
      this.rewrite(kept);
      for (const r of kept) this.apply(r);
      this.fd = fs.openSync(this.file, 'a', 0o600);
      this.healthy = true;
      // Recovery: no replay, ever.
      for (const op of this.ops.values()) {
        if (op.final) continue;
        this.append({ k: 'final', op: op.id, status: op.dispatch_started ? 'outcome_unknown' : 'failed', code: op.dispatch_started ? 'OUTCOME_UNKNOWN' : 'APP_RESTARTED', at: this.now(), delivered_at: null });
      }
    } catch (error) {
      this.healthy = false;
      this.error = error.code === 'JOURNAL_UNAVAILABLE' ? error.message : `Journal unavailable: ${error.message}`;
      if (this.fd != null) { try { fs.closeSync(this.fd); } catch {} this.fd = null; }
    }
    return this.healthy;
  }

  readAll() {
    let raw;
    try { raw = fs.readFileSync(this.file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const lines = raw.split('\n');
    const torn = lines.pop(); // '' when the file ends with a newline; a torn last record otherwise
    void torn;
    const records = [];
    for (const line of lines) {
      if (!line) throw new JournalUnavailable('Journal is corrupted (empty record).');
      const sep = line.lastIndexOf('\t');
      if (sep < 0) throw new JournalUnavailable('Journal is corrupted (no tag).');
      const body = line.slice(0, sep);
      const tag = line.slice(sep + 1);
      let rec;
      try { rec = JSON.parse(body); } catch { throw new JournalUnavailable('Journal is corrupted (bad record).'); }
      if (!rec || rec.kv !== this.keyVersion) throw new JournalUnavailable('Journal key version mismatch.');
      const expected = this.mac(body);
      if (tag.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(tag), Buffer.from(expected))) {
        throw new JournalUnavailable('Journal integrity check failed.');
      }
      records.push(rec);
    }
    return records;
  }

  line(rec) {
    const body = JSON.stringify({ ...rec, kv: this.keyVersion });
    return `${body}\t${this.mac(body)}\n`;
  }

  rewrite(records) {
    const tmp = `${this.file}.tmp`;
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      for (const r of records) writeAll(fd, this.line(r));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.file);
  }

  apply(rec) {
    if (rec.k === 'accepted') {
      this.ops.set(rec.op, {
        id: rec.op, principal: rec.principal, method: rec.method, target: rec.target, idx: rec.idx, digest: rec.digest,
        profile: rec.profile, action: rec.action, grant: rec.grant, accepted_at: rec.at, expires_at: rec.exp,
        phase: 'awaiting_user', dispatch_started: false, delivery: null, final: null, started_at: null
      });
      this.index.set(rec.idx, rec.op);
    } else if (rec.k === 'phase') {
      const op = this.ops.get(rec.op);
      if (!op) return;
      op.phase = rec.phase;
      if (rec.dispatch_started) { op.dispatch_started = true; if (!op.started_at) op.started_at = rec.at; }
      if (rec.delivery) op.delivery = rec.delivery;
    } else if (rec.k === 'final') {
      const op = this.ops.get(rec.op);
      if (!op) return;
      op.final = { status: rec.status, code: rec.code || null, at: rec.at, delivered_at: rec.delivered_at || null };
      op.phase = 'finished';
    }
  }

  // Durable append: write + fsync, or throw JournalUnavailable (and stay unavailable).
  append(rec) {
    if (!this.healthy || this.fd == null) throw new JournalUnavailable(this.error || 'Journal unavailable.');
    try {
      writeAll(this.fd, this.line(rec));
      fs.fsyncSync(this.fd);
    } catch (error) {
      this.healthy = false;
      this.error = `Journal write failed: ${error.code || error.message}`;
      throw new JournalUnavailable(this.error);
    }
    this.apply(rec);
  }

  lookup(idx) {
    const id = this.index.get(idx);
    const op = id ? this.ops.get(id) : null;
    if (!op) return null;
    if (op.expires_at <= this.now()) return null; // retention over: no duplicate suppression claimed
    return op;
  }

  close() {
    if (this.fd != null) { try { fs.closeSync(this.fd); } catch {} }
    this.fd = null;
    this.healthy = false;
  }
}

module.exports = { OperationStore, JournalUnavailable, RETENTION_MS };
