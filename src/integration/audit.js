// Minimal audit log for the dots integration: who, which target, which tool, the decision, byte
// counts, and state transitions. Never the terminal text, cursors, keys, or auth material.
// One JSON line per event in <dir>/<prefix>-YYYY-MM-DD.jsonl (prefix 'audit' by default; the adapter
// writes its connection diagnostics with prefix 'adapter'); files older than the retention are pruned.

const fs = require('fs');
const path = require('path');

const RETENTION_DAYS = 7;
const ALLOWED_FIELDS = ['event', 'principal', 'tool', 'session_id', 'generation', 'decision', 'code', 'bytes', 'request_id', 'reason', 'permissions',
  // connection diagnostics (no handshake material)
  'stage', 'relay_id', 'elapsed_ms', 'bytes_in', 'bytes_out', 'endpoint', 'pid'];

function createAuditLog({ dir, now = Date.now, retentionDays = RETENTION_DAYS, prefix = 'audit' } = {}) {
  if (!/^[a-z]+$/.test(prefix)) throw new Error('invalid audit prefix');
  const FILE_RE = new RegExp(`^${prefix}-(\\d{4}-\\d{2}-\\d{2})\\.jsonl$`);
  let lastPrune = 0;

  function prune() {
    lastPrune = now();
    const cutoff = new Date(now() - retentionDays * 86400000).toISOString().slice(0, 10);
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const name of names) {
      const m = FILE_RE.exec(name);
      if (m && m[1] < cutoff) { try { fs.unlinkSync(path.join(dir, name)); } catch {} }
    }
  }

  function record(entry) {
    if (!dir) return;
    const line = { time: new Date(now()).toISOString() };
    for (const key of ALLOWED_FIELDS) if (entry[key] !== undefined) line[key] = entry[key];
    const file = path.join(dir, `${prefix}-${line.time.slice(0, 10)}.jsonl`);
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(file, `${JSON.stringify(line)}\n`, { encoding: 'utf8', mode: 0o600 });
    } catch {}
    if (now() - lastPrune > 3600000) prune();
  }

  function clear() {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const name of names) if (FILE_RE.test(name)) { try { fs.unlinkSync(path.join(dir, name)); } catch {} }
  }

  return { record, prune, clear };
}

module.exports = { createAuditLog, RETENTION_DAYS };
