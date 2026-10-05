// dots integration: the session ledger. Maps the main process's existing (view webContents id,
// renderer terminal id) slots to stable external identities and per-session capture state.
//
// Target = { app_instance_id, session_id, generation }:
//  - app_instance_id: a UUID per main-process start,
//  - session_id: a UUID per terminal slot, kept while the slot's PTY is restarted in place,
//  - generation: +1 for every PTY spawned into that slot (restart / replacement).
// Re-parenting a tab to another window keeps the view's webContents and its terminals, so the
// Target survives a tab move. A replacement PTY bumps the generation, which ends any grant and
// invalidates the old Target (STALE_SESSION). A closed slot is final; reusing its numeric id later
// creates a new session_id.
//
// Display labels, pane numbers, distro and cwd are metadata for humans; never used to resolve a target.

const crypto = require('crypto');
const path = require('path');
const { TerminalNormalizer, OutputBuffer } = require('./output-buffer');
const { parseOsc7Cwd } = require('../terminal-actions');
const { detectClis } = require('./input-profiles');

const DEFAULT_LIMITS = {
  sessionBytes: 1024 * 1024,
  sessionAgeMs: 10 * 60 * 1000,
  globalBytes: 16 * 1024 * 1024
};
const MAX_TOMBSTONES = 1000;

function stripControls(text, max) {
  return String(text || '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, max);
}

class SessionRegistry {
  constructor({ appInstanceId = crypto.randomUUID(), now = Date.now, randomUUID = crypto.randomUUID, limits = {} } = {}) {
    this.appInstanceId = appInstanceId;
    this.now = now;
    this.randomUUID = randomUUID;
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.sessions = new Map();   // session_id -> session
    this.slots = new Map();      // `${viewId}:${termId}` -> session_id
    this.workspaceIds = new Map(); // viewId -> workspace UUID (stable for the view's lifetime)
    this.tombstones = new Map(); // session_id -> last generation (closed sessions: STALE_SESSION)
    this.listeners = new Set();
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(event, session) { for (const fn of this.listeners) { try { fn(event, session); } catch {} } }

  slotKey(viewId, termId) { return `${viewId}:${termId}`; }

  bySlot(viewId, termId) {
    const id = this.slots.get(this.slotKey(viewId, termId));
    return id ? this.sessions.get(id) || null : null;
  }

  workspaceIdFor(viewId) {
    let id = this.workspaceIds.get(viewId);
    if (!id) { id = this.randomUUID(); this.workspaceIds.set(viewId, id); }
    return id;
  }

  bump(session) {
    session.stateRevision += 1;
    session.observedAt = this.now();
  }

  // A PTY was spawned into a slot (new terminal, restart after exit, or replacement of a live one).
  ptyStarted({ viewId, termId, distro, wslPath, initialCwd }) {
    const at = this.now();
    let session = this.bySlot(viewId, termId);
    if (session && session.lifecycle === 'closed') session = null;
    if (session) {
      this.emit('replaced', session); // grant holders must lose access before the generation moves
      session.generation += 1;
      this.resetCapture(session);
    } else {
      session = {
        sessionId: this.randomUUID(),
        generation: 1,
        viewId,
        termId,
        stateRevision: 0,
        observedAt: at,
        capture: 'off',
        buffer: null,
        normalizer: null,
        label: null
      };
      this.sessions.set(session.sessionId, session);
      this.slots.set(this.slotKey(viewId, termId), session.sessionId);
    }
    session.lifecycle = 'alive';
    session.distro = stripControls(distro, 64);
    session.wslPath = stripControls(wslPath, 1024);
    session.initialCwd = stripControls(initialCwd || wslPath, 1024);
    session.cwd = { value: null, source: 'unknown', observed_at: null };
    // The CLI running in this pane: { family, version, source: 'pane_output' | 'user_confirmed', at }.
    // Tracked from the pane's output whether or not it is shared (metadata only, see ptyData).
    session.cli = null;
    session.bannerTail = '';
    session.promptAt = null;
    session.firstPromptAt = null;
    session.normalizer = this.makeNormalizer(session);
    session.startedAt = at;
    this.bump(session);
    this.emit('started', session);
    return session;
  }

  // Raw PTY data. Cheap no-op unless capture is active for this session.
  // Every PTY chunk is normalized to find CLI banners and shell prompts (metadata kept in memory:
  // family, version, a <=160-character scan tail for banners split across chunks). The TEXT is kept
  // only while the pane is shared (capture active); before that nothing is stored or exposed.
  ptyData(viewId, termId, data) {
    const session = this.bySlot(viewId, termId);
    if (!session || !session.normalizer || session.lifecycle !== 'alive') return 0;
    const { text, controlRemoved, replaced } = session.normalizer.push(String(data));
    // A CLI's startup banner in the pane's own output (also while paused): which CLI and version
    // runs in THIS pane. Scanned over a small tail so a banner split across chunks is still seen.
    // Stream order: a shell prompt (OSC 7) clears the CLI; a banner AFTER the last prompt of the
    // chunk (a CLI started from that prompt) identifies the new one; a banner before it is gone.
    const promptAt = session.promptAt;
    const firstPromptAt = session.firstPromptAt;
    session.promptAt = null;
    session.firstPromptAt = null;
    const tail = session.bannerTail || '';
    // eventOffset: UTF-8 bytes of this chunk's text before the event (where it sits in the stream).
    const bytesBefore = (i) => Buffer.byteLength(text.slice(0, Math.max(0, Math.min(text.length, i))), 'utf8');
    // The EARLIEST prompt or banner in this chunk ends observation windows of earlier input: emitted
    // first, at its position (later output in the same chunk then never counts for them).
    if (text || firstPromptAt != null) {
      const banners = text ? detectClis(tail + text) : [];
      const firstBanner = banners.length ? banners[0].start - tail.length : null;
      const marks = [firstPromptAt, firstBanner].filter((v) => v != null);
      if (marks.length) {
        session.eventOffset = bytesBefore(Math.min(...marks));
        this.emit('output_boundary', session);
      }
    }
    if (promptAt != null) {
      session.bannerTail = '';
      session.eventOffset = bytesBefore(promptAt);
      this.emit('shell_prompt', session);
    }
    if (text) {
      const scan = promptAt != null ? text.slice(promptAt) : tail + text;
      session.bannerTail = scan.slice(-160);
      // Every banner, in order: any different CLI / version on the way revokes input, even if a
      // later banner in the same chunk matches the original again.
      const clis = detectClis(scan);
      const scanStart = promptAt != null ? promptAt : -tail.length; // scan index 0 in this chunk's text
      for (const cli of clis) {
        session.lastBanner = { family: cli.family, version: cli.version };
        session.eventOffset = bytesBefore(scanStart + cli.start);
        this.emit('cli_banner', session);
      }
      // Keep what follows the last banner: a next, still incomplete banner must not be lost.
      if (clis.length) session.bannerTail = scan.slice(clis[clis.length - 1].end).slice(-160);
    }
    session.eventOffset = 0;
    if (session.capture !== 'active' || !session.buffer) return 0; // not shared / paused: nothing stored
    const added = session.buffer.append(text, { controlRemoved, replaced });
    if (added) this.enforceGlobalLimit();
    return added;
  }

  ptyExited(viewId, termId) {
    const session = this.bySlot(viewId, termId);
    if (!session || session.lifecycle !== 'alive') return;
    session.lifecycle = 'exited';
    session.cli = null; // whatever ran there is gone
    session.bannerTail = '';
    this.bump(session);
    this.emit('exited', session);
  }

  // The slot is gone for good (pane closed, view destroyed, workspace switched).
  ptyClosed(viewId, termId) {
    const session = this.bySlot(viewId, termId);
    if (!session) return;
    this.slots.delete(this.slotKey(viewId, termId));
    this.close(session);
  }

  viewGone(viewId) {
    for (const session of [...this.sessions.values()]) {
      if (session.viewId === viewId) this.ptyClosed(viewId, session.termId);
    }
    this.workspaceIds.delete(viewId);
  }

  close(session) {
    session.lifecycle = 'closed';
    this.bump(session);
    this.emit('closed', session);
    this.resetCapture(session);
    this.sessions.delete(session.sessionId);
    this.tombstones.set(session.sessionId, session.generation);
    if (this.tombstones.size > MAX_TOMBSTONES) this.tombstones.delete(this.tombstones.keys().next().value);
  }

  setLabel(session, label) {
    const clean = stripControls(label, 80).trim();
    session.label = clean || null;
  }

  displayLabel(session) {
    const leaf = path.posix.basename(session.wslPath || '') || session.wslPath || '';
    return `${leaf} · ${session.label || `Terminal ${session.termId}`}`;
  }

  // One normalizer per pane incarnation, alive whether or not the pane is shared: it is what sees
  // the CLI banners and shell prompts. Only while sharing is its text kept (in the capture buffer).
  makeNormalizer(session) {
    return new TerminalNormalizer({
      onOsc: (code, payload, at) => {
        if (code !== '7') return;
        const cwd = parseOsc7Cwd(payload);
        if (cwd) session.cwd = { value: cwd, source: 'advisory_osc7', observed_at: new Date(this.now()).toISOString() };
        // Workbench's shell reports OSC 7 from PROMPT_COMMAND, i.e. once per shell prompt: the
        // foreground is the shell again (a CLI exited). Used to turn input off. Emitted after this
        // chunk's banner scan (ptyData), so a banner earlier in the same chunk cannot outlive it.
        session.promptAt = at; // the last prompt's position in this chunk's normalized text
        if (session.firstPromptAt == null) session.firstPromptAt = at; // ...and the first one
      }
    });
  }

  // --- capture control (driven by grants) ---

  startCapture(session) {
    if (session.capture !== 'off') return;
    session.buffer = new OutputBuffer({ maxBytes: this.limits.sessionBytes, maxAgeMs: this.limits.sessionAgeMs, now: this.now });
    // Every capture has its own identity; cursors bind to it, so a cursor from an earlier share of
    // the same session can never be applied to a later capture's positions.
    session.captureId = this.randomUUID();
    session.capture = 'active';
    this.bump(session);
  }

  pauseCapture(session) {
    if (session.capture !== 'active') return false;
    session.buffer.pause();
    session.capture = 'paused';
    this.bump(session);
    return true;
  }

  resumeCapture(session) {
    if (session.capture !== 'paused') return false;
    session.buffer.resume();
    session.capture = 'active';
    this.bump(session);
    return true;
  }

  clearCapture(session) {
    if (!session.buffer) return false;
    session.buffer.clear();
    this.bump(session);
    return true;
  }

  // Stop capturing and discard everything retained (grant ended, PTY replaced, slot closed).
  resetCapture(session) {
    const had = session.capture !== 'off';
    // The CLI identity is NOT reset here: banners and prompts are tracked whether or not the pane
    // is shared (metadata only), so a CLI started before sharing is still known after it.
    if (session.buffer) session.buffer.clear();
    session.buffer = null;
    session.captureId = null;
    session.capture = 'off';
    if (had && session.lifecycle !== 'closed') this.bump(session);
  }

  userInput(viewId, termId) {
    const session = this.bySlot(viewId, termId);
    if (session && session.capture !== 'off') this.bump(session);
  }

  totalBytes() {
    let total = 0;
    for (const session of this.sessions.values()) if (session.buffer) total += session.buffer.totalBytes;
    return total;
  }

  // Global retention cap: drop the oldest chunk across all sessions until under the limit.
  enforceGlobalLimit() {
    let total = this.totalBytes();
    while (total > this.limits.globalBytes) {
      let oldest = null;
      for (const session of this.sessions.values()) {
        const b = session.buffer;
        if (!b || !b.chunks.length) continue;
        if (!oldest || b.chunks[0].lastAt < oldest.buffer.chunks[0].lastAt) oldest = session;
      }
      if (!oldest) break;
      total -= oldest.buffer.dropOldest();
    }
  }

  // Resolve a Target to a live session. Order matters: a foreign app instance or old generation
  // is STALE_SESSION (never silently retargeted to the current incarnation).
  resolve(target) {
    if (target.app_instance_id !== this.appInstanceId) return { code: 'STALE_SESSION' };
    const session = this.sessions.get(target.session_id);
    if (!session) return { code: this.tombstones.has(target.session_id) ? 'STALE_SESSION' : 'SESSION_NOT_FOUND' };
    if (session.generation !== target.generation) {
      return { code: target.generation < session.generation ? 'STALE_SESSION' : 'SESSION_NOT_FOUND' };
    }
    return { session };
  }

  target(session) {
    return { app_instance_id: this.appInstanceId, session_id: session.sessionId, generation: session.generation };
  }
}

module.exports = { SessionRegistry, DEFAULT_LIMITS };
