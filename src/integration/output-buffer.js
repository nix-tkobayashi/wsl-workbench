// dots integration (stage A): per-session normalized output capture.
//
// Pure module (no Electron): unit-tested in test/integration/output-buffer.test.js.
//
// - TerminalNormalizer turns raw PTY text into "normalized_text_v1": ANSI CSI / OSC / DCS / other
//   escape sequences and C0/C1 controls are removed, CRLF and lone CR become LF. It is a streaming
//   state machine, so a sequence split across two PTY callbacks is still removed. It does NOT
//   reconstruct the screen (CR overwrites, TUI redraws): the result says display_reconstruction=false.
//   OSC 7 (cwd report) payloads are surfaced to a callback as ADVISORY metadata only; every other OSC
//   (OSC 52 clipboard, OSC 8 links, ...) is dropped and never replayed.
// - OutputBuffer keeps the normalized text as chunks of at most 4 KiB (UTF-8 bytes, never split
//   inside a code point). Each chunk has a seq (monotonic within one buffer). Positions are
//   (seq, byte offset inside that chunk); cursors carry them but are opaque to clients (cursor.js).
//   Retention is bounded by bytes and age; dropped data is reported as an explicit gap.
//   Pause stops capture and resume inserts a gap marker; clear() bumps the epoch so every cursor
//   issued before it becomes invalid.

const CHUNK_BYTES = 4096;

function byteLen(text) { return Buffer.byteLength(text, 'utf8'); }

// Largest prefix of `text` whose UTF-8 encoding fits in `maxBytes`, never splitting a code point
// (a surrogate pair counts as one code point).
function utf8Prefix(text, maxBytes) {
  if (maxBytes <= 0) return '';
  if (byteLen(text) <= maxBytes) return text;
  let bytes = 0;
  let i = 0;
  while (i < text.length) {
    const cp = text.codePointAt(i);
    const size = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (bytes + size > maxBytes) break;
    bytes += size;
    i += cp > 0xffff ? 2 : 1;
  }
  return text.slice(0, i);
}

// Slice `text` by UTF-8 byte offsets (both must be code point boundaries).
function utf8Slice(text, start, end) {
  const buf = Buffer.from(text, 'utf8');
  return buf.subarray(start, end === undefined ? buf.length : end).toString('utf8');
}

function isUtf8Boundary(text, offset) {
  const buf = Buffer.from(text, 'utf8');
  if (offset < 0 || offset > buf.length) return false;
  if (offset === buf.length) return true;
  return (buf[offset] & 0xc0) !== 0x80;
}

const OSC_PAYLOAD_LIMIT = 4096;

class TerminalNormalizer {
  constructor({ onOsc } = {}) {
    this.state = 'ground';
    this.oscPayload = '';
    this.oscOverflow = false;
    this.pendingCR = false;
    this.onOsc = onOsc || null;
  }

  // Returns { text, controlRemoved, replaced }.
  push(input) {
    let out = '';
    let controlRemoved = false;
    const replaced = input.includes('�'); // node-pty already decoded; U+FFFD marks invalid UTF-8
    for (let i = 0; i < input.length; i++) {
      const ch = input[i];
      const code = input.charCodeAt(i);
      switch (this.state) {
        case 'ground': {
          if (this.pendingCR) {
            this.pendingCR = false;
            out += '\n';
            if (ch === '\n') break; // CRLF -> one LF
          }
          if (code === 0x1b) { this.state = 'esc'; controlRemoved = true; break; }
          if (code === 0x9b) { this.state = 'csi'; controlRemoved = true; break; }
          if (code === 0x9d) { this.startOsc(); controlRemoved = true; break; }
          if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) { this.state = 'str'; controlRemoved = true; break; }
          if (ch === '\r') { this.pendingCR = true; break; }
          if (ch === '\n' || ch === '\t') { out += ch; break; }
          if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) { controlRemoved = true; break; }
          out += ch;
          break;
        }
        case 'esc': {
          if (ch === '[') this.state = 'csi';
          else if (ch === ']') this.startOsc();
          else if (ch === 'P' || ch === 'X' || ch === '^' || ch === '_') this.state = 'str';
          else if (code >= 0x20 && code <= 0x2f) this.state = 'escInter';
          else if (code === 0x1b) this.state = 'esc';
          else this.state = 'ground'; // two-byte sequence (ESC 7, ESC =, ESC M, ...) or stray ESC
          break;
        }
        case 'escInter': {
          if (code >= 0x30 && code <= 0x7e) this.state = 'ground';
          else if (code === 0x1b) this.state = 'esc';
          else if (!(code >= 0x20 && code <= 0x2f)) this.state = 'ground';
          break;
        }
        case 'csi': {
          if (code >= 0x40 && code <= 0x7e) this.state = 'ground';
          else if (code === 0x1b) this.state = 'esc';
          else if (code === 0x18 || code === 0x1a) this.state = 'ground'; // CAN / SUB abort
          break;
        }
        case 'osc': {
          if (code === 0x07 || code === 0x9c) { this.oscAt = out.length; this.endOsc(); break; }
          if (code === 0x1b) { this.state = 'oscEsc'; break; }
          if (code === 0x18 || code === 0x1a) { this.state = 'ground'; break; }
          if (this.oscPayload.length < OSC_PAYLOAD_LIMIT) this.oscPayload += ch;
          else this.oscOverflow = true;
          break;
        }
        case 'oscEsc': {
          if (ch === '\\') { this.oscAt = out.length; this.endOsc(); break; }
          // ESC without '\' terminates the OSC (xterm behaviour) and starts a new escape.
          this.state = 'esc';
          this.oscPayload = '';
          i--; // re-run this char in 'esc'
          break;
        }
        case 'str': {
          if (code === 0x9c || code === 0x07) this.state = 'ground';
          else if (code === 0x1b) this.state = 'strEsc';
          else if (code === 0x18 || code === 0x1a) this.state = 'ground';
          break;
        }
        case 'strEsc': {
          if (ch === '\\') this.state = 'ground';
          else { this.state = 'esc'; i--; }
          break;
        }
        default:
          this.state = 'ground';
      }
    }
    return { text: out, controlRemoved, replaced };
  }

  startOsc() { this.state = 'osc'; this.oscPayload = ''; this.oscOverflow = false; }

  endOsc() {
    const payload = this.oscPayload;
    const overflow = this.oscOverflow;
    this.state = 'ground';
    this.oscPayload = '';
    this.oscOverflow = false;
    if (overflow || !this.onOsc) return;
    const sep = payload.indexOf(';');
    const code = sep < 0 ? payload : payload.slice(0, sep);
    // oscAt: where in this push's normalized text the sequence ended (stream order for callers).
    try { this.onOsc(code, sep < 0 ? '' : payload.slice(sep + 1), this.oscAt == null ? 0 : this.oscAt); } catch {}
  }

  reset() {
    this.state = 'ground';
    this.oscPayload = '';
    this.oscOverflow = false;
    this.pendingCR = false;
  }
}

class OutputBuffer {
  constructor({ maxBytes = 1024 * 1024, maxAgeMs = 10 * 60 * 1000, chunkBytes = CHUNK_BYTES, now = Date.now } = {}) {
    this.maxBytes = maxBytes;
    this.maxAgeMs = maxAgeMs;
    this.chunkBytes = chunkBytes;
    this.now = now;
    this.epoch = 1;
    // Bytes ever appended in this epoch and pauses ever made: absolute marks for observation windows.
    this.appended = 0;
    this.pauses = 0;
    this.chunks = [];      // { seq, text, bytes, firstAt, lastAt, controlRemoved, replaced, gap }
    this.nextSeq = 1;
    this.totalBytes = 0;
    this.lastDropped = null; // { seq, bytes } of the most recently dropped chunk (end-of-chunk cursors)
    this.paused = false;
  }

  get firstSeq() { return this.chunks.length ? this.chunks[0].seq : this.nextSeq; }
  get oldestAt() { return this.chunks.length ? this.chunks[0].firstAt : null; }

  // The last chunk takes more text only while it is a text chunk below the size cap AND young:
  // age retention drops whole chunks by their OLDEST text (firstAt), so a chunk must not keep
  // collecting for long, or a trickle of output would keep its first bytes alive past maxAgeMs.
  openChunk() {
    const last = this.chunks[this.chunks.length - 1];
    if (!last || last.gap || last.closed || last.bytes >= this.chunkBytes) return null;
    return this.now() - last.firstAt < this.maxAgeMs / 10 ? last : null;
  }

  append(text, { controlRemoved = false, replaced = false } = {}) {
    if (this.paused || !text) return 0;
    const at = this.now();
    let rest = text;
    let added = 0;
    while (rest.length) {
      let chunk = this.openChunk();
      if (!chunk) {
        chunk = { seq: this.nextSeq++, text: '', bytes: 0, firstAt: at, lastAt: at, controlRemoved: false, replaced: false, gap: null, closed: false };
        this.chunks.push(chunk);
      }
      let part = utf8Prefix(rest, this.chunkBytes - chunk.bytes);
      if (!part) {
        // A single code point larger than the room left: start a new chunk (an empty chunk always fits it).
        if (chunk.bytes === 0) part = String.fromCodePoint(rest.codePointAt(0));
        else { chunk.closed = true; continue; }
      }
      const partBytes = byteLen(part);
      chunk.text += part;
      chunk.bytes += partBytes;
      chunk.lastAt = at;
      chunk.controlRemoved = chunk.controlRemoved || controlRemoved;
      chunk.replaced = chunk.replaced || replaced;
      this.totalBytes += partBytes;
      this.appended += partBytes;
      added += partBytes;
      rest = rest.slice(part.length);
    }
    this.prune();
    return added;
  }

  addGapMarker(reason) {
    const at = this.now();
    this.chunks.push({ seq: this.nextSeq++, text: '', bytes: 0, firstAt: at, lastAt: at, controlRemoved: false, replaced: false, gap: reason, closed: true });
  }

  pause() { this.paused = true; this.pauses++; }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    this.addGapMarker('capture_paused');
  }

  dropOldest() {
    const dropped = this.chunks.shift();
    if (!dropped) return 0;
    this.totalBytes -= dropped.bytes;
    this.lastDropped = { seq: dropped.seq, bytes: dropped.bytes };
    return dropped.bytes;
  }

  prune() {
    const cutoff = this.now() - this.maxAgeMs;
    while (this.chunks.length && (this.totalBytes > this.maxBytes || this.chunks[0].firstAt <= cutoff)) this.dropOldest();
  }

  clear() {
    this.chunks = [];
    this.totalBytes = 0;
    this.lastDropped = null;
    this.appended = 0;
    this.epoch++;
  }

  // Current end position (where the next appended byte will land).
  endPosition() {
    const open = this.openChunk();
    if (open) return { seq: open.seq, offset: open.bytes };
    return { seq: this.nextSeq, offset: 0 };
  }

  chunkIndex(seq) {
    if (!this.chunks.length) return -1;
    const idx = seq - this.chunks[0].seq; // seqs are contiguous inside the array
    return idx >= 0 && idx < this.chunks.length && this.chunks[idx].seq === seq ? idx : -1;
  }

  // Validate a position against the live buffer. Returns { ok, pos, gap } or { error }.
  //  - positions before the retained range become a gap (and are advanced to the oldest data),
  //  - positions in the future or at a non-boundary offset are invalid.
  resolvePosition(pos) {
    const end = this.endPosition();
    if (!Number.isSafeInteger(pos.seq) || !Number.isSafeInteger(pos.offset) || pos.seq < 1 || pos.offset < 0) return { error: 'CURSOR_INVALID' };
    if (pos.seq > end.seq || (pos.seq === end.seq && pos.offset > end.offset)) {
      // (seq, bytes) of a closed chunk is equal to (seq+1, 0); anything else past the end is forged.
      return { error: 'CURSOR_INVALID' };
    }
    const idx = this.chunkIndex(pos.seq);
    if (idx >= 0) {
      const chunk = this.chunks[idx];
      if (pos.offset > chunk.bytes || !isUtf8Boundary(chunk.text, pos.offset)) return { error: 'CURSOR_INVALID' };
      return { ok: true, pos, gap: null };
    }
    if (pos.seq === end.seq && pos.offset === 0) return { ok: true, pos, gap: null }; // at the end, nothing new yet
    // Before the retained window.
    if (pos.seq < this.firstSeq) {
      const exactEndOfDropped = this.lastDropped && pos.seq === this.lastDropped.seq && pos.offset === this.lastDropped.bytes
        && this.firstSeq === pos.seq + 1;
      if (exactEndOfDropped) return { ok: true, pos: { seq: this.firstSeq, offset: 0 }, gap: null };
      return {
        ok: true,
        pos: { seq: this.firstSeq, offset: 0 },
        gap: { reason: 'retention_expired', from: pos.seq, to: this.firstSeq - 1 }
      };
    }
    return { error: 'CURSOR_INVALID' };
  }

  // Position for tail=true: as late as possible while the bytes up to the end fit in maxBytes.
  // Does not cross a gap marker (the tail is contiguous captured output).
  tailPosition(maxBytes) {
    let budget = maxBytes;
    let pos = this.endPosition();
    for (let i = this.chunks.length - 1; i >= 0; i--) {
      const chunk = this.chunks[i];
      if (chunk.gap) return { seq: chunk.seq + 1, offset: 0 };
      if (chunk.bytes <= budget) {
        budget -= chunk.bytes;
        pos = { seq: chunk.seq, offset: 0 };
        continue;
      }
      // Partial chunk: start at the first boundary such that the remainder fits.
      const buf = Buffer.from(chunk.text, 'utf8');
      let start = buf.length - budget;
      while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++;
      if (start < buf.length) pos = { seq: chunk.seq, offset: start };
      return pos;
    }
    return pos;
  }

  // Read forward from a resolved position. Stops at maxBytes (UTF-8 boundary), at the end, or
  // before a second gap. Returns null text if a single code point does not fit in maxBytes.
  read(startPos, maxBytes, initialGap = null) {
    let pos = { ...startPos };
    let gap = initialGap;
    let text = '';
    let bytes = 0;
    let firstSeq = null;
    let lastSeq = null;
    let truncated = false;
    let controlRemoved = false;
    let replaced = false;
    let tooSmall = null;
    for (;;) {
      const idx = this.chunkIndex(pos.seq);
      if (idx < 0) break; // at the end
      const chunk = this.chunks[idx];
      if (chunk.gap) {
        if (gap || bytes > 0) break; // report one gap per read; text before it is returned first
        gap = { reason: chunk.gap, from: null, to: null };
        pos = { seq: chunk.seq + 1, offset: 0 };
        continue;
      }
      const available = chunk.bytes - pos.offset;
      if (available <= 0) {
        if (idx === this.chunks.length - 1 && this.openChunk() === chunk) break; // open chunk, caught up
        pos = { seq: chunk.seq + 1, offset: 0 };
        continue;
      }
      const remainingText = utf8Slice(chunk.text, pos.offset);
      const budget = maxBytes - bytes;
      const part = utf8Prefix(remainingText, budget);
      if (!part) {
        if (bytes === 0) tooSmall = byteLen(String.fromCodePoint(remainingText.codePointAt(0)));
        truncated = true;
        break;
      }
      const partBytes = byteLen(part);
      text += part;
      bytes += partBytes;
      if (firstSeq === null) firstSeq = chunk.seq;
      lastSeq = chunk.seq;
      controlRemoved = controlRemoved || chunk.controlRemoved;
      replaced = replaced || chunk.replaced;
      pos = { seq: chunk.seq, offset: pos.offset + partBytes };
      if (partBytes < available) { truncated = true; break; }
      if (bytes >= maxBytes) break;
    }
    // Normalize "end of a closed chunk" to the start of the next one.
    const idx = this.chunkIndex(pos.seq);
    if (idx >= 0) {
      const chunk = this.chunks[idx];
      // (A gap marker is never skipped here: the next read must report it.)
      if (!chunk.gap && pos.offset >= chunk.bytes && this.openChunk() !== chunk) pos = { seq: chunk.seq + 1, offset: 0 };
    }
    const end = this.endPosition();
    const hasMore = !(pos.seq === end.seq && pos.offset === end.offset) && this.chunkIndex(pos.seq) >= 0;
    return { text, bytes, firstSeq, lastSeq, pos, hasMore, truncated, gap, controlRemoved, replaced, tooSmall };
  }
}

module.exports = { TerminalNormalizer, OutputBuffer, utf8Prefix, utf8Slice, isUtf8Boundary, CHUNK_BYTES };
