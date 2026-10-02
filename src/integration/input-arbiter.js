// Stage B: the input arbiter — one ordering point for AI input into existing PTYs.
//
// Every AI write runs here, in the main process's single thread, interleaved with the human input
// path (main calls humanInput() for each renderer keystroke batch BEFORE handing it to the PTY), so
// "who wrote first" is well defined. Per session at most one AI operation is pending.
//
// Operation lifecycle (status / phase):
//   accepted/awaiting_user  -> local confirmation dialog (foreground is never verified, so every
//                              operation needs one; 60 s, one-shot, bound to op + digest + target +
//                              profile + state revision)
//   accepted/text_dispatch  -> intent durably journaled, then the text is handed to the PTY library
//   accepted/text_written   -> text accepted by the library
//   accepted/awaiting_submit_confirmation -> (text_and_submit) the user checks the real input line
//   accepted/submit_dispatch -> intent journaled, profile delay, then Enter
//   delivered/finished | failed/finished | outcome_unknown/finished
// "delivered" means the PTY library accepted the bytes — never that the CLI accepted or finished.
// Anything that stops an operation after dispatch intent yields outcome_unknown; nothing is ever
// re-sent, completed, or undone (no automatic Enter, no Backspace "rollback").
//
// Prompt text lives only in memory on the live operation and is dropped at the terminal state.

const crypto = require('crypto');
const { findProfile, checkText, encodeText, keyBytes } = require('./input-profiles');
const { JournalUnavailable } = require('./operation-store');

const CONFIRM_MS = 60 * 1000;
const WRITES_PER_MINUTE = 10;
const METHOD = 'workbench_write_input';

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter((k) => value[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function iso(ms) { return ms == null ? null : new Date(ms).toISOString(); }

class InputArbiter {
  constructor({
    registry, access, store, writePty, requestConfirmation = () => {}, cancelConfirmation = () => {},
    cursorAt = () => null, audit = null, isGateOpen = () => false, now = Date.now, randomUUID = crypto.randomUUID,
    confirmMs = CONFIRM_MS, writesPerMinute = WRITES_PER_MINUTE, onChange = () => {},
    // Per-pane "skip Workbench's send confirmation" (controller decides): (op, stage) => boolean.
    // Re-asked right before every step and every write; false means the normal dialog.
    autoApprove = () => false,
    // Which CLI / version the pane's input goes to, as the controller judges it:
    // (session) => { usable, key, message }. key changes when the CLI, its version or the status do.
    targetState = () => ({ usable: true, key: '' }),
    // Where the pane's captured output ends right now (observation after Enter), and what was seen
    // after that mark: (session) => mark | null, (op) => observation object.
    outputMark = () => null,
    observe = () => null
  }) {
    Object.assign(this, { registry, access, store, writePty, requestConfirmation, cancelConfirmation, cursorAt, audit, isGateOpen, now, randomUUID, confirmMs, writesPerMinute, onChange, autoApprove, targetState, outputMark, observe });
    this.seq = 0; // accept order: auto-approval only applies to operations accepted after it was enabled
    this.ops = new Map();       // op id -> live operation (this process)
    this.pending = new Map();   // session id -> op
    this.acceptLog = new Map(); // session id -> accept timestamps (rate limit)
  }

  record(entry) { if (this.audit) { try { this.audit.record(entry); } catch {} } }

  // --- request intake ---

  parse(args) {
    if (args.action) {
      const a = args.action;
      return { contract: 'actions-v1', kind: a.type, text: a.text, key: a.key, submit: a.type === 'text_and_submit', legacy: false };
    }
    if (args.text !== undefined) return { contract: 'legacy', kind: 'text', text: args.text, submit: false, legacy: true };
    return { contract: 'legacy', kind: 'key', key: args.key, submit: false, legacy: true };
  }

  // Validated args from the broker. Returns { op } (new or known) or { error: { code, message, operationId } }.
  submit(principal, args) {
    const fail = (code, message, operationId = null) => ({ error: { code, message, operationId } });
    const target = args.target;
    const resolved = this.registry.resolve(target);
    if (resolved.code) {
      const ended = resolved.code === 'SESSION_NOT_FOUND' ? this.access.endedCode(principal, target.session_id, target.generation) : null;
      return fail(ended || resolved.code);
    }
    const session = resolved.session;
    const decision = this.access.check(principal, session.sessionId, session.generation, 'input:write');
    if (!decision.ok) return fail(decision.code === 'FORBIDDEN' ? 'PERMISSION_DENIED' : decision.code);
    if (!this.store.healthy) return fail('JOURNAL_UNAVAILABLE', 'The operation journal is unavailable; nothing was sent.');

    const req = this.parse(args);
    // Idempotency: look the key up BEFORE any freshness check (a known request returns its result
    // even though the state revision moved on), and compare the full canonical request.
    const idx = this.store.digest('idx', canonical([principal, METHOD, target.app_instance_id, target.session_id, target.generation, args.idempotency_key]));
    const payload = canonical({
      target, expected_state_revision: args.expected_state_revision, contract: req.contract, kind: req.kind,
      text: req.text, key: req.key, submit: req.submit,
      profile_id: args.profile_id, profile_revision: args.profile_revision
    });
    const digest = this.store.digest('payload', payload);
    const known = this.store.lookup(idx);
    if (known) {
      if (known.digest !== digest) return fail('IDEMPOTENCY_CONFLICT', 'This idempotency_key was used for a different request. Look up the existing operation; do not reuse the key.', known.id);
      return { op: this.ops.get(known.id) || null, knownId: known.id };
    }

    if (!this.isGateOpen()) return fail('UNSUPPORTED', 'Terminal input is not enabled in this Workbench.');
    const binding = session.inputProfile;
    const profile = binding ? findProfile(binding.id, binding.revision) : null;
    if (!profile) return fail('UNSUPPORTED', 'No verified input profile is selected for this terminal in Workbench.');
    if (req.contract === 'actions-v1' && (args.profile_id !== profile.id || args.profile_revision !== profile.revision)) {
      return fail('STATE_CONFLICT', 'profile_id / profile_revision do not match the profile selected in Workbench. Refresh the session.');
    }
    const cliTarget = this.targetStateOf(session);
    if (!cliTarget.usable) return fail('STATE_CONFLICT', cliTarget.message || 'The CLI version in this terminal has to be confirmed in Workbench first.');
    let textBytes = 0;
    if (req.kind === 'text' || req.kind === 'text_and_submit') {
      const checked = checkText(req.text, { profile, legacy: req.legacy });
      if (!checked.ok) return fail(checked.code, checked.message);
      textBytes = checked.bytes;
    }
    if (req.kind === 'key' && !keyBytes(profile, req.key)) return fail('UNSUPPORTED', `Key ${req.key} is not verified for the selected profile.`);
    if (req.submit && !keyBytes(profile, 'Enter')) return fail('UNSUPPORTED', 'Enter is not verified for the selected profile.');

    if (session.lifecycle !== 'alive') return fail('STATE_CONFLICT', 'The terminal process is not running.');
    if (session.inputPaused) return fail('USER_INTERVENED', 'The user took over this terminal. AI input resumes only after the user re-enables it in Workbench.');
    if (args.expected_state_revision !== String(session.stateRevision)) return fail('STATE_CONFLICT', 'The session changed (state_revision). Read it again and let the user decide.');
    if (this.pending.has(session.sessionId)) return fail('SESSION_BUSY', 'Another input operation is pending for this session.');
    const t = this.now();
    const recent = (this.acceptLog.get(session.sessionId) || []).filter((at) => at > t - 60000);
    if (recent.length >= this.writesPerMinute) return fail('RATE_LIMITED', 'Too many input operations for this session; wait a minute.');

    const id = this.randomUUID();
    const profileSnap = { id: profile.id, revision: profile.revision };
    try {
      this.store.append({
        k: 'accepted', op: id, principal, method: METHOD, target, idx, digest, profile: profileSnap,
        action: req.kind, grant: decision.grant.grant_id, at: t, exp: t + this.store.retentionMs
      });
    } catch (error) {
      if (error instanceof JournalUnavailable) return fail('JOURNAL_UNAVAILABLE', 'The operation journal could not be written; nothing was sent.');
      throw error;
    }
    recent.push(t);
    this.acceptLog.set(session.sessionId, recent);
    const op = {
      id, principal, target: { ...target }, sessionId: session.sessionId, generation: session.generation,
      viewId: session.viewId, termId: session.termId, grantId: decision.grant.grant_id,
      profile, kind: req.kind, legacy: req.legacy, text: req.text === undefined ? null : req.text, key: req.key || null, submit: req.submit,
      textBytes, lineCount: req.text ? req.text.split('\n').length : 0,
      status: 'accepted', phase: 'awaiting_user', acceptedAt: t, startedAt: null, deliveredAt: null, finishedAt: null,
      dispatchStarted: false, userIntervened: false,
      delivery: {
        text_state: req.kind === 'key' ? 'not_requested' : 'not_started',
        submit_state: req.submit ? 'not_started' : 'not_requested',
        key_state: req.kind === 'key' ? 'not_started' : 'not_requested',
        bytes_written: null, encoded_bytes_offered: 0, foreground_verified: false,
        cli_acceptance: 'unknown', cli_completion: 'unknown'
      },
      reservedRevision: session.stateRevision, stateRevisionAfter: null, error: null,
      expiresAt: t + this.store.retentionMs, awaiting: null, confirmDeadline: null, timer: null,
      textWrittenAt: null, outputStart: null, outputEnd: null, version: 0, waiters: new Set(),
      seq: ++this.seq, autoApproved: new Set(), // stages approved by the per-pane setting, not a dialog
      targetKey: cliTarget.key, submitMark: null, submitAt: null
    };
    this.ops.set(id, op);
    this.pending.set(session.sessionId, op);
    this.record({ event: 'op_accepted', principal, session_id: op.sessionId, generation: op.generation, request_id: id, bytes: textBytes });
    this.askUser(op, 'initial');
    return { op };
  }

  // --- local confirmation ---

  askUser(op, stage) {
    op.awaiting = stage;
    op.confirmDeadline = this.now() + this.confirmMs;
    op.timer = setTimeout(() => this.confirm(op.id, stage, 'expired'), this.confirmMs);
    if (op.timer.unref) op.timer.unref();
    this.changed(op);
    // An operation that ran under the per-pane setting never falls back to a dialog half-way: if
    // the setting went away, the rest is stopped (nothing more is sent, nothing is re-sent).
    if (op.autoApproved.size && !this.isAutoApproved(op, stage)) {
      this.stop(op, 'PERMISSION_DENIED', 'Skipping the send confirmation was turned off; the rest was not sent.');
      return;
    }
    if (this.isAutoApproved(op, stage)) {
      // No dialog: approve on the next tick through the normal path (deadline, revalidation, journal).
      // Checked again then: if the setting went away meanwhile, the normal dialog is shown instead.
      setImmediate(() => {
        if (op.status !== 'accepted' || op.awaiting !== stage) return;
        if (!this.isAutoApproved(op, stage)) {
          if (op.autoApproved.size) { this.stop(op, 'PERMISSION_DENIED', 'Skipping the send confirmation was turned off; the rest was not sent.'); return; }
          this.showDialog(op, stage);
          return;
        }
        op.autoApproved.add(stage);
        this.record({ event: 'auto_confirmed', principal: op.principal, session_id: op.sessionId, generation: op.generation, request_id: op.id, stage });
        this.confirm(op.id, stage, 'approved');
      });
      return;
    }
    this.showDialog(op, stage);
  }

  targetStateOf(session) {
    try { return this.targetState(session) || { usable: false, key: '' }; } catch { return { usable: false, key: '' }; }
  }

  // Remember where the pane's output stood when Enter was written (observation looks only after it).
  markSubmit(op) {
    const session = this.registry.sessions.get(op.sessionId);
    try { op.submitMark = session ? this.outputMark(session) : null; } catch { op.submitMark = null; }
    op.submitAt = this.now();
  }

  isAutoApproved(op, stage) {
    try { return this.autoApprove(op, stage) === true; } catch { return false; }
  }

  showDialog(op, stage) {
    try {
      this.requestConfirmation({
        opId: op.id, stage, viewId: op.viewId, termId: op.termId, sessionId: op.sessionId, generation: op.generation,
        profile: { id: op.profile.id, revision: op.profile.revision, cli_name: op.profile.cli_name, cli_version: op.profile.cli_version },
        kind: op.kind, text: op.text, key: op.key, submit: op.submit, bytes: op.textBytes, lines: op.lineCount,
        stateRevision: op.reservedRevision, deadline: op.confirmDeadline
      });
    } catch {
      this.confirm(op.id, stage, 'declined');
    }
  }

  // decision: 'approved' | 'declined' | 'expired'. A stale or repeated answer is ignored (one-shot).
  confirm(opId, stage, decision) {
    const op = this.ops.get(opId);
    if (!op || op.status !== 'accepted' || op.awaiting !== stage) return false;
    clearTimeout(op.timer);
    op.timer = null;
    op.awaiting = null;
    // Close this step's dialog in every case (expiry included); a no-op when the UI answered itself.
    try { this.cancelConfirmation(op.id); } catch {}
    // The deadline is checked here too: a delayed timer must never let a late approval through.
    if (decision === 'approved' && this.now() > op.confirmDeadline) decision = 'expired';
    if (decision === 'expired') { this.stop(op, 'CONFIRMATION_EXPIRED', 'The local confirmation expired.'); return true; }
    if (decision !== 'approved') { this.stop(op, 'PERMISSION_DENIED', 'The user declined in Workbench.'); return true; }
    if (stage === 'initial') this.dispatchFirst(op);
    else this.dispatchSubmit(op);
    return true;
  }

  // Re-check everything right before a write. Returns an error code or null.
  revalidate(op) {
    if (!this.isGateOpen()) return 'PERMISSION_DENIED';
    const session = this.registry.sessions.get(op.sessionId);
    if (!session || session.generation !== op.generation) return 'STALE_SESSION';
    if (session.lifecycle !== 'alive') return 'STATE_CONFLICT';
    const grant = this.access.active(op.sessionId);
    if (!grant || grant.grant_id !== op.grantId) return this.access.endedCode(op.principal, op.sessionId, op.generation) || 'GRANT_REVOKED';
    if (!grant.permissions.has('input:write')) return 'GRANT_REVOKED';
    const binding = session.inputProfile;
    if (!binding || binding.id !== op.profile.id || binding.revision !== op.profile.revision) return 'STATE_CONFLICT';
    if (session.inputPaused) return 'USER_INTERVENED';
    if (session.stateRevision !== op.reservedRevision) return 'STATE_CONFLICT';
    // The CLI / version the operation was accepted for must still be the one in the pane, and usable.
    const cliTarget = this.targetStateOf(session);
    if (!cliTarget.usable || cliTarget.key !== op.targetKey) return 'STATE_CONFLICT';
    // A step approved by the per-pane setting (not by a dialog) stops if the setting went away.
    for (const stage of op.autoApproved) if (!this.isAutoApproved(op, stage)) return 'PERMISSION_DENIED';
    return null;
  }

  phase(op, phase, extra = {}) {
    op.phase = phase;
    this.store.append({ k: 'phase', op: op.id, phase, dispatch_started: op.dispatchStarted, delivery: { ...op.delivery }, at: this.now(), ...extra });
    this.changed(op);
  }

  // Hand bytes to the PTY library; bumps the session revision and moves this op's reservation with it.
  write(op, data) {
    const session = this.registry.sessions.get(op.sessionId);
    op.delivery.encoded_bytes_offered += Buffer.byteLength(data, 'utf8');
    const ok = this.writePty(session, data);
    if (!ok) throw new Error('pty-gone');
    this.registry.bump(session);
    op.reservedRevision = session.stateRevision;
    op.stateRevisionAfter = String(session.stateRevision);
  }

  dispatchFirst(op) {
    const code = this.revalidate(op);
    if (code) { this.stop(op, code); return; }
    const session = this.registry.sessions.get(op.sessionId);
    op.outputStart = this.cursorAt(session);
    const isKey = op.kind === 'key';
    try {
      op.dispatchStarted = true;
      op.startedAt = this.now();
      this.phase(op, isKey ? 'submit_dispatch' : 'text_dispatch');
    } catch {
      op.dispatchStarted = false; // the intent never became durable: nothing was written
      this.stop(op, 'JOURNAL_UNAVAILABLE', 'The operation journal could not be written; nothing was sent.');
      return;
    }
    // The flush may have taken a while: re-check everything (grant, target, confirmation deadline)
    // immediately before the write. Nothing has been written yet, so a stop here is a sure failure.
    const late = this.now() > op.confirmDeadline ? 'CONFIRMATION_EXPIRED' : this.revalidate(op);
    if (late) {
      op.dispatchStarted = false;
      this.stop(op, late);
      return;
    }
    try {
      if (isKey) {
        if (op.key === 'Enter') this.markSubmit(op);
        this.write(op, keyBytes(op.profile, op.key));
        op.delivery.key_state = 'library_accepted';
      } else {
        this.write(op, encodeText(op.profile, op.text));
        op.delivery.text_state = 'library_accepted';
      }
    } catch {
      if (isKey) op.delivery.key_state = 'unknown'; else op.delivery.text_state = 'partial_or_unknown';
      this.stop(op, 'OUTCOME_UNKNOWN', 'The PTY write failed; part of the input may have arrived.');
      return;
    }
    if (isKey || !op.submit) { this.finish(op); return; }
    op.textWrittenAt = this.now();
    try { this.phase(op, 'text_written'); } catch { this.stop(op, 'JOURNAL_UNAVAILABLE'); return; }
    try { this.phase(op, 'awaiting_submit_confirmation'); } catch { this.stop(op, 'JOURNAL_UNAVAILABLE'); return; }
    this.askUser(op, 'submit');
  }

  dispatchSubmit(op) {
    let code = this.revalidate(op);
    if (code) { this.stop(op, code); return; }
    try { this.phase(op, 'submit_dispatch'); } catch { this.stop(op, 'JOURNAL_UNAVAILABLE'); return; }
    // The approval stays valid only for the profile's submit delay after its deadline.
    const submitBy = op.confirmDeadline + op.profile.submitDelayMs;
    const wait = Math.max(0, op.profile.submitDelayMs - (this.now() - op.textWrittenAt));
    const fire = () => {
      if (op.status !== 'accepted') return; // stopped while waiting (takeover, revoke, ...)
      code = this.now() > submitBy ? 'CONFIRMATION_EXPIRED' : this.revalidate(op);
      if (code) { this.stop(op, code); return; }
      try {
        this.markSubmit(op);
        this.write(op, keyBytes(op.profile, 'Enter'));
        op.delivery.submit_state = 'library_accepted';
      } catch {
        op.delivery.submit_state = 'unknown';
        this.stop(op, 'OUTCOME_UNKNOWN', 'The PTY write of Enter failed; it may have arrived.');
        return;
      }
      this.finish(op);
    };
    if (wait > 0) { const t = setTimeout(fire, wait); if (t.unref) t.unref(); } else fire();
  }

  // --- terminal states ---

  finish(op) {
    op.status = 'delivered';
    op.deliveredAt = this.now();
    this.terminate(op, null);
  }

  // Stop an operation. Before dispatch intent it is failed (nothing was sent); after, it is
  // outcome_unknown (some or all input may have arrived). Never re-sends or completes it.
  stop(op, code, message) {
    if (op.status !== 'accepted') return;
    if (op.timer) { clearTimeout(op.timer); op.timer = null; }
    const stage = op.awaiting;
    op.awaiting = null;
    if (stage) { try { this.cancelConfirmation(op.id); } catch {} }
    op.status = op.dispatchStarted ? 'outcome_unknown' : 'failed';
    if (op.dispatchStarted) {
      if (op.delivery.text_state === 'not_started') op.delivery.text_state = 'partial_or_unknown';
      if (op.delivery.key_state === 'not_started') op.delivery.key_state = 'unknown';
    }
    op.error = { code, message: message || defaultMessage(code, op.status) };
    this.terminate(op, code);
  }

  terminate(op, code) {
    op.finishedAt = this.now();
    // Persist the terminal state first. If that fails after bytes were written, "delivered" can't
    // be claimed durably (a restart would say outcome_unknown), so report outcome_unknown now too.
    try {
      this.store.append({ k: 'final', op: op.id, status: op.status, code, at: op.finishedAt, delivered_at: op.deliveredAt });
    } catch {
      if (op.status === 'delivered') {
        op.status = 'outcome_unknown';
        code = 'JOURNAL_UNAVAILABLE';
        op.error = { code, message: 'The input was handed to the terminal, but its result could not be recorded. Check the real screen; do not resend.' };
      }
      // failed stays failed: nothing was written, and recovery agrees (no dispatch intent).
    }
    op.phase = 'finished';
    op.text = null; // prompt text never outlives the operation
    const session = this.registry.sessions.get(op.sessionId);
    op.outputEnd = session ? this.cursorAt(session) : null;
    if (this.pending.get(op.sessionId) === op) this.pending.delete(op.sessionId);
    this.record({ event: 'op_finished', principal: op.principal, session_id: op.sessionId, generation: op.generation, request_id: op.id, decision: op.status, code: code || undefined, bytes: op.delivery.encoded_bytes_offered });
    this.changed(op);
  }

  changed(op) {
    op.version += 1;
    for (const resolve of [...op.waiters]) resolve();
    op.waiters.clear();
    try { this.onChange(op); } catch {}
  }

  // --- events from the controller ---

  // Human input reached this pane (already filtered of terminal-generated reports). Any pending AI
  // operation stops and AI input stays paused until the user re-enables it.
  humanInput(session) {
    const op = this.pending.get(session.sessionId);
    if (!op) return;
    op.userIntervened = true;
    session.inputPaused = true;
    this.stop(op, 'USER_INTERVENED', 'The user typed in this terminal; the remaining input was not sent.');
  }

  takeover(session) {
    session.inputPaused = true;
    this.registry.bump(session);
    const op = this.pending.get(session.sessionId);
    if (op) { op.userIntervened = true; this.stop(op, 'USER_INTERVENED', 'The user took over this terminal.'); }
  }

  resume(session) {
    if (!session.inputPaused) return;
    session.inputPaused = false;
    this.registry.bump(session);
  }

  // The session's grant / profile / incarnation changed under a pending operation.
  sessionChanged(sessionId, code) {
    const op = this.pending.get(sessionId);
    if (op) this.stop(op, code);
  }

  stopAll(code) {
    for (const op of [...this.pending.values()]) this.stop(op, code);
  }

  // --- reads ---

  // Wait until the operation changes or ms elapse.
  waitFor(op, ms) {
    if (op.status !== 'accepted' || ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => { clearTimeout(timer); op.waiters.delete(done); resolve(); };
      const timer = setTimeout(done, ms);
      op.waiters.add(done);
    });
  }

  prune() {
    const t = this.now();
    for (const [id, op] of this.ops) if (op.status !== 'accepted' && op.expiresAt <= t) this.ops.delete(id);
  }

  view(op, { full = false } = {}) {
    const terminal = op.status !== 'accepted';
    const out = {
      operation_id: op.id,
      target: { ...op.target },
      status: op.status,
      phase: op.phase,
      accepted_at: iso(op.acceptedAt),
      delivered_at: iso(op.deliveredAt),
      finished_at: iso(op.finishedAt),
      bytes_written: null,
      dispatch_started: op.dispatchStarted,
      user_intervened: op.userIntervened,
      profile_id: op.profile.id,
      profile_revision: op.profile.revision,
      delivery: { ...op.delivery },
      state_revision_after: op.stateRevisionAfter,
      next_action: op.status === 'accepted' ? 'wait_operation' : op.status === 'delivered' ? 'read_output' : 'request_user_decision',
      retry_after_ms: terminal ? 0 : 1500,
      error: op.error ? errorObject(op.error.code, op.error.message, op.id, op.status) : null,
      idempotency_expires_at: iso(op.expiresAt)
    };
    // Staged observation after Enter (advisory; never a reason to resend). The MCP adapter moves it
    // out of the structured result into the text, so the tool output schema stays unchanged.
    let observation = null;
    try { observation = this.observe(op); } catch { observation = null; }
    if (observation) out.observation = observation;
    if (!full) return out;
    return {
      ...out,
      origin_target: { ...op.target },
      method: METHOD,
      started_at: iso(op.startedAt),
      deadline_at: op.awaiting ? iso(op.confirmDeadline) : null,
      deadline_exceeded: false,
      exit_code: null,
      completion_source: null,
      output_start_cursor: op.outputStart,
      output_end_cursor: op.outputEnd,
      output_scope: 'interleaved_pty_stream',
      cancel_requested_at: null
    };
  }
}

const SAFE_BEFORE_DISPATCH = new Set(['STATE_CONFLICT', 'SESSION_BUSY', 'RATE_LIMITED', 'CONFIRMATION_EXPIRED', 'PERMISSION_DENIED', 'USER_INTERVENED', 'APP_RESTARTED']);

function errorObject(code, message, operationId, status) {
  const unknown = status === 'outcome_unknown';
  return {
    code,
    message: message || defaultMessage(code, status),
    retryable: false,
    // A NEW request may be considered only if nothing was dispatched (failed) — never automatically.
    safe_to_retry: !unknown && status === 'failed' && SAFE_BEFORE_DISPATCH.has(code),
    operation_id: operationId || null,
    next_action: unknown ? 'request_user_decision' : code === 'STATE_CONFLICT' || code === 'STALE_SESSION' ? 'refresh_session' : 'request_user_decision'
  };
}

function defaultMessage(code, status) {
  if (status === 'outcome_unknown') return 'Some or all input may have reached the terminal. Do not resend automatically; check the real screen.';
  const map = {
    USER_INTERVENED: 'The user intervened; nothing more was sent.',
    CONFIRMATION_EXPIRED: 'The local confirmation expired; nothing was sent.',
    GRANT_EXPIRED: 'The input grant expired.',
    GRANT_REVOKED: 'The input grant was revoked.',
    STALE_SESSION: 'The terminal was restarted or closed.',
    STATE_CONFLICT: 'The session changed before the input could be sent.',
    PERMISSION_DENIED: 'Input is not permitted.',
    JOURNAL_UNAVAILABLE: 'The operation journal is unavailable.',
    APP_RESTARTED: 'Workbench restarted before the input was sent; nothing was sent.'
  };
  return map[code] || code;
}

module.exports = { InputArbiter, canonical, errorObject, CONFIRM_MS };
