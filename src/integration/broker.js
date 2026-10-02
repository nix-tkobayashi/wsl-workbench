// dots integration broker (stage A, read-only). Runs in the Electron main process and answers the
// MCP adapter's tool calls for ONE authenticated principal per connection. The principal comes from
// the transport's authentication, never from tool arguments.
//
// Every call: rate limit -> strict schema validation (again; the adapter is another process) ->
// target resolution -> grant check (re-checked immediately before data is returned) -> result.
// Results follow handoff appendix B. Terminal text is always marked untrusted.

const crypto = require('crypto');
const { API_VERSION, ENABLED_TOOLS, INPUT_TOOLS, validateToolArgs } = require('../mcp/schemas');
const { verifiedProfiles, publicProfile, findProfile, MAX_TEXT_BYTES } = require('./input-profiles');
const { createCursorCodec } = require('./cursor');
const { redact } = require('./redaction');
const { DEFAULT_GRANT_MS } = require('./access-control');

const STREAM = 'normalized_text_v1';
const LIST_SNAPSHOT_MS = 60 * 1000;
const MAX_LIST_SNAPSHOTS = 100;

// Default error semantics (handoff §8 table). Stage A has no mutations, so a failed read is always
// safe to retry once the cause is addressed.
const ERROR_DEFAULTS = {
  AUTH_REQUIRED: { retryable: false, safe_to_retry: false, next_action: 'request_user_decision' },
  FORBIDDEN: { retryable: false, safe_to_retry: false, next_action: 'request_user_decision' },
  SESSION_NOT_FOUND: { retryable: false, safe_to_retry: true, next_action: 'refresh_session' },
  STALE_SESSION: { retryable: false, safe_to_retry: true, next_action: 'refresh_session' },
  GRANT_EXPIRED: { retryable: false, safe_to_retry: false, next_action: 'request_user_decision' },
  GRANT_REVOKED: { retryable: false, safe_to_retry: false, next_action: 'request_user_decision' },
  BUSY: { retryable: true, safe_to_retry: true, next_action: 'refresh_session' },
  STATE_CONFLICT: { retryable: false, safe_to_retry: false, next_action: 'refresh_session' },
  UNSUPPORTED: { retryable: false, safe_to_retry: false, next_action: 'none' },
  CURSOR_INVALID: { retryable: false, safe_to_retry: true, next_action: 'refresh_session' },
  INPUT_INVALID: { retryable: false, safe_to_retry: true, next_action: 'none' },
  INPUT_TOO_LARGE: { retryable: false, safe_to_retry: true, next_action: 'none' },
  RATE_LIMITED: { retryable: true, safe_to_retry: true, next_action: 'none' },
  APP_UNAVAILABLE: { retryable: true, safe_to_retry: true, next_action: 'reconnect' },
  TRANSPORT_UNAVAILABLE: { retryable: true, safe_to_retry: true, next_action: 'reconnect' },
  INTERNAL_ERROR: { retryable: false, safe_to_retry: true, next_action: 'none' },
  // Stage B
  PERMISSION_DENIED: { retryable: false, safe_to_retry: false, next_action: 'request_user_decision' },
  SESSION_BUSY: { retryable: true, safe_to_retry: true, next_action: 'wait_operation' },
  IDEMPOTENCY_CONFLICT: { retryable: false, safe_to_retry: false, next_action: 'request_user_decision' },
  USER_INTERVENED: { retryable: false, safe_to_retry: false, next_action: 'request_user_decision' },
  CONFIRMATION_EXPIRED: { retryable: false, safe_to_retry: false, next_action: 'request_user_decision' },
  JOURNAL_UNAVAILABLE: { retryable: false, safe_to_retry: false, next_action: 'request_user_decision' },
  OUTCOME_UNKNOWN: { retryable: false, safe_to_retry: false, next_action: 'request_user_decision' },
  OPERATION_NOT_FOUND: { retryable: false, safe_to_retry: false, next_action: 'none' }
};
const ERROR_MESSAGES = {
  AUTH_REQUIRED: 'The connection is not authenticated.',
  FORBIDDEN: 'This session was not shared with the requested permission.',
  SESSION_NOT_FOUND: 'No shared session matches this target. List sessions again.',
  STALE_SESSION: 'This target refers to an earlier incarnation of the session. List sessions again; do not reuse it.',
  GRANT_EXPIRED: 'The user’s sharing grant for this session expired. Ask the user to share it again in Workbench.',
  GRANT_REVOKED: 'The user stopped sharing this session. Ask the user to share it again in Workbench.',
  UNSUPPORTED: 'This capability is not available in this Workbench build.',
  CURSOR_INVALID: 'The cursor is not valid for this session, generation, or buffer epoch. Read without a cursor to restart.',
  RATE_LIMITED: 'Too many calls. Wait for retry_after_ms.',
  INTERNAL_ERROR: 'Internal error.'
};

function isoTime(ms) { return ms == null ? null : new Date(ms).toISOString(); }

// get_session.input_profile: the locally selected verified profile (null when none). Foreground is
// never verified, so every operation needs local confirmation, and text_and_submit a second one.
function inputProfileView(session) {
  const b = session.inputProfile;
  if (!b || !findProfile(b.id, b.revision)) return null;
  return {
    id: b.id,
    revision: b.revision,
    foreground_verified: false,
    requires_local_confirmation: true,
    requires_submit_confirmation: true,
    input_paused: !!session.inputPaused
  };
}

class Broker {
  constructor({ registry, access, rateLimiter, audit = null, now = Date.now, randomUUID = crypto.randomUUID, serverVersion = '0.0.0', cursorCodec = createCursorCodec() }) {
    this.registry = registry;
    this.access = access;
    this.rateLimiter = rateLimiter;
    this.audit = audit;
    this.now = now;
    this.randomUUID = randomUUID;
    this.serverVersion = serverVersion;
    this.cursors = cursorCodec;
    this.listSnapshots = new Map(); // snapshot id -> { principal, sessionIds, expiresAt }
    this.lastCallAt = null;
    this.input = null; // Stage B: { arbiter, gate() } — set by the controller
  }

  setInput(input) { this.input = input; }

  inputGate() {
    const gate = this.input ? this.input.gate() : null;
    return gate || { open: false, transport: 'blocked', inputEnabled: false, journalHealthy: false };
  }

  // Stage B error envelope: exactly the six error fields of the write_input / get_operation schema.
  errorB(requestId, code, message, operationId = null) {
    const defaults = ERROR_DEFAULTS[code] || ERROR_DEFAULTS.INTERNAL_ERROR;
    return {
      api_version: API_VERSION,
      ok: false,
      request_id: requestId,
      server_time: isoTime(this.now()),
      error: {
        code,
        message: message || ERROR_MESSAGES[code] || code,
        retryable: defaults.retryable,
        safe_to_retry: defaults.safe_to_retry,
        operation_id: operationId,
        next_action: defaults.next_action
      }
    };
  }

  envelope(requestId) {
    return { api_version: API_VERSION, ok: true, request_id: requestId, server_time: isoTime(this.now()) };
  }

  error(requestId, code, extra = {}) {
    const defaults = ERROR_DEFAULTS[code] || ERROR_DEFAULTS.INTERNAL_ERROR;
    const { message, ...rest } = extra;
    return {
      api_version: API_VERSION,
      ok: false,
      request_id: requestId,
      server_time: isoTime(this.now()),
      error: { code, message: message || ERROR_MESSAGES[code] || code, ...defaults, ...rest }
    };
  }

  record(entry) {
    if (this.audit) { try { this.audit.record(entry); } catch {} }
  }

  // Entry point for one tool call from an authenticated connection.
  // Returns the result, or a Promise of it for get_operation (long poll).
  handle(principal, tool, rawArgs) {
    const requestId = this.randomUUID();
    this.lastCallAt = this.now();
    const isInput = INPUT_TOOLS.includes(tool);
    const internal = () => (isInput ? this.errorB(requestId, 'INTERNAL_ERROR') : this.error(requestId, 'INTERNAL_ERROR'));
    const audit = (result) => {
      this.record({
        event: 'call', principal, tool: String(tool).slice(0, 64), request_id: requestId,
        session_id: rawArgs && rawArgs.target && typeof rawArgs.target.session_id === 'string' ? rawArgs.target.session_id.slice(0, 64) : undefined,
        decision: result.ok ? 'allow' : 'deny', code: result.ok ? undefined : result.error.code,
        bytes: result.ok && typeof result.text === 'string' ? Buffer.byteLength(result.text, 'utf8') : undefined
      });
      return result;
    };
    let result;
    try {
      result = this.dispatch(principal, tool, rawArgs, requestId);
    } catch {
      result = internal();
    }
    if (result && typeof result.then === 'function') return result.catch(internal).then(audit);
    return audit(result);
  }

  dispatch(principal, tool, rawArgs, requestId) {
    const isInput = INPUT_TOOLS.includes(tool);
    if (!principal) return isInput ? this.errorB(requestId, 'AUTH_REQUIRED') : this.error(requestId, 'AUTH_REQUIRED');
    const limited = this.rateLimiter.take(principal);
    if (!limited.ok) {
      // The Stage B error schema has no retry_after_ms field: the wait goes into the message.
      return isInput
        ? this.errorB(requestId, 'RATE_LIMITED', `Too many calls. Retry after ${limited.retryAfterMs} ms.`)
        : this.error(requestId, 'RATE_LIMITED', { retry_after_ms: limited.retryAfterMs });
    }
    if (!ENABLED_TOOLS.has(tool)) return this.error(requestId, 'UNSUPPORTED');
    // The gate guards NEW input only. Reading an operation stays possible (with operation:read)
    // even after the gate closed, e.g. a journal failure must not hide an outcome_unknown result.
    if (tool === 'workbench_write_input' && !this.inputGate().open) return this.errorB(requestId, 'UNSUPPORTED', 'Terminal input is not enabled in this Workbench.');
    if (tool === 'workbench_get_operation' && !this.input) return this.errorB(requestId, 'UNSUPPORTED', 'Terminal input is not available in this Workbench.');
    const valid = validateToolArgs(tool, rawArgs);
    if (!valid.ok) return isInput ? this.errorB(requestId, valid.code, valid.message) : this.error(requestId, valid.code, { message: valid.message });
    const args = valid.args;
    switch (tool) {
      case 'workbench_write_input': return this.writeInput(principal, args, requestId);
      case 'workbench_get_operation': return this.getOperation(principal, args, requestId);
      case 'workbench_capabilities': return this.capabilities(requestId);
      case 'workbench_list_sessions': return this.listSessions(principal, args, requestId);
      case 'workbench_get_session': return this.getSession(principal, args, requestId);
      case 'workbench_read_output': return this.readOutput(principal, args, requestId);
      default: return this.error(requestId, 'UNSUPPORTED');
    }
  }

  capabilities(requestId) {
    const limits = this.registry.limits;
    const gate = this.inputGate();
    const profiles = verifiedProfiles().map(publicProfile);
    return {
      ...this.envelope(requestId),
      server_version: this.serverVersion,
      app_instance_id: this.registry.appInstanceId,
      features: {
        session_discovery: true,
        output_read: true,
        input_write: gate.open,
        command_execution: false,
        raw_output: false,
        events: false
      },
      limits: {
        list_limit_max: 50,
        read_default_bytes: 16384,
        read_max_bytes: 65536,
        chunk_bytes: 4096,
        session_buffer_bytes: limits.sessionBytes,
        session_buffer_age_ms: limits.sessionAgeMs,
        global_buffer_bytes: limits.globalBytes,
        grant_default_ms: DEFAULT_GRANT_MS,
        rate_per_sec: this.rateLimiter.ratePerSec,
        rate_burst: this.rateLimiter.burst,
        list_cursor_ttl_ms: LIST_SNAPSHOT_MS
      },
      supported_shells: [],
      supported_keys: gate.open ? [...new Set(profiles.flatMap((p) => p.supported_keys))] : [],
      extensions: {
        write_input_actions_v1: {
          enabled: gate.open,
          input_contract: 'actions-v1',
          actions: ['text', 'key', 'text_and_submit'],
          max_text_utf8_bytes: MAX_TEXT_BYTES,
          idempotency_retention_seconds: 86400,
          requires_local_confirmation: true,
          transport_write_gate: gate.transport === 'reviewed' ? 'reviewed' : 'blocked',
          profiles
        }
      }
    };
  }

  // Resolve + authorize a target. Returns { session, grant } or an error result.
  authorize(principal, target, permission, requestId) {
    const resolved = this.registry.resolve(target);
    if (resolved.code) {
      // A vanished session this principal held a grant on reports that grant's fate; anything else
      // stays SESSION_NOT_FOUND / STALE_SESSION (no existence leak to other principals).
      const ended = resolved.code === 'SESSION_NOT_FOUND' ? this.access.endedCode(principal, target.session_id, target.generation) : null;
      return { error: this.error(requestId, ended || resolved.code) };
    }
    const decision = this.access.check(principal, target.session_id, target.generation, permission);
    if (!decision.ok) return { error: this.error(requestId, decision.code) };
    return { session: resolved.session, grant: decision.grant };
  }

  sessionView(session, grant) {
    const buffer = session.buffer;
    if (buffer) buffer.prune(); // reported ranges must reflect age retention too
    const first = buffer && buffer.chunks.length ? buffer.chunks[0].seq : null;
    const last = buffer && buffer.chunks.length ? buffer.chunks[buffer.chunks.length - 1].seq : null;
    return {
      target: this.registry.target(session),
      display_label: this.registry.displayLabel(session),
      workspace_id: this.registry.workspaceIdFor(session.viewId),
      workspace_label: `${session.distro}: ${session.wslPath}`,
      distro: session.distro,
      initial_cwd: session.initialCwd,
      cwd: { ...session.cwd },
      lifecycle: session.lifecycle,
      activity: 'unknown', // no verified shell integration: never inferred from prompt text
      state_revision: String(session.stateRevision),
      observed_at: isoTime(session.observedAt),
      shell_kind: null,
      shell_integration: { enabled: false, version: null, completion_trust: 'none' },
      effective_permissions: [...grant.permissions].sort(),
      grant_expires_at: isoTime(Math.min(grant.expiresAtWall, this.now() + Math.max(0, grant.expiresAtMono - this.access.monotonic()))),
      capture_state: session.capture,
      active_operation_id: this.input && this.input.arbiter.pending.get(session.sessionId) ? this.input.arbiter.pending.get(session.sessionId).id : null,
      user_intervened: !!session.inputPaused,
      input_profile: inputProfileView(session),
      buffer: {
        available_from: first == null ? null : String(first),
        available_to: last == null ? null : String(last),
        bytes: buffer ? buffer.totalBytes : 0,
        oldest_at: buffer ? isoTime(buffer.oldestAt) : null
      }
    };
  }

  pruneSnapshots() {
    const t = this.now();
    for (const [id, snap] of this.listSnapshots) if (snap.expiresAt <= t) this.listSnapshots.delete(id);
    while (this.listSnapshots.size > MAX_LIST_SNAPSHOTS) this.listSnapshots.delete(this.listSnapshots.keys().next().value);
  }

  listSessions(principal, args, requestId) {
    this.pruneSnapshots();
    let snapshotId;
    let offset = 0;
    let sessionIds;
    if (args.cursor !== undefined) {
      const payload = this.cursors.decode(args.cursor);
      const snap = payload && payload.k === 'list' ? this.listSnapshots.get(payload.snap) : null;
      if (!snap || snap.principal !== principal || !Number.isSafeInteger(payload.off) || payload.off < 0) {
        return this.error(requestId, 'CURSOR_INVALID', { message: 'The list cursor expired or is not valid. List again without a cursor.' });
      }
      snapshotId = payload.snap;
      offset = payload.off;
      sessionIds = snap.sessionIds;
    } else {
      snapshotId = this.randomUUID();
      sessionIds = this.access.grantsFor(principal)
        .map((grant) => this.registry.sessions.get(grant.session_id))
        .filter((session) => session)
        .sort((a, b) => a.startedAt - b.startedAt || (a.sessionId < b.sessionId ? -1 : 1))
        .map((session) => session.sessionId);
      this.listSnapshots.set(snapshotId, { principal, sessionIds, expiresAt: this.now() + LIST_SNAPSHOT_MS });
    }
    // Re-filter against CURRENT grants: a revocation since the snapshot hides the session at once.
    const page = [];
    let index = offset;
    while (index < sessionIds.length && page.length < args.limit) {
      const session = this.registry.sessions.get(sessionIds[index]);
      index++;
      if (!session) continue;
      const decision = this.access.check(principal, session.sessionId, session.generation, 'session:list');
      if (!decision.ok) continue;
      page.push(this.sessionView(session, decision.grant));
    }
    const nextCursor = index < sessionIds.length ? this.cursors.encode({ k: 'list', snap: snapshotId, off: index }) : null;
    return { ...this.envelope(requestId), sessions: page, next_cursor: nextCursor, snapshot_at: isoTime(this.now()) };
  }

  getSession(principal, args, requestId) {
    const auth = this.authorize(principal, args.target, 'output:read', requestId);
    if (auth.error) return auth.error;
    return { ...this.envelope(requestId), ...this.sessionView(auth.session, auth.grant) };
  }

  writeInput(principal, args, requestId) {
    const { arbiter } = this.input;
    const res = arbiter.submit(principal, args);
    if (res.error) return this.errorB(requestId, res.error.code, res.error.message, res.error.operationId);
    const op = res.op;
    if (!op) return this.errorB(requestId, 'STALE_SESSION', 'The operation for this key belongs to an earlier Workbench run.', res.knownId || null);
    // A known key returning a terminal failure is reported as an error envelope with its operation id.
    if (op.status === 'failed' || op.status === 'outcome_unknown') {
      return this.errorB(requestId, op.status === 'outcome_unknown' ? 'OUTCOME_UNKNOWN' : op.error.code, op.error.message, op.id);
    }
    return { ...this.envelope(requestId), ...arbiter.view(op) };
  }

  // Operation metadata is visible only to its principal while it can still read the origin session.
  readableOperation(principal, operationId) {
    const op = this.input.arbiter.ops.get(operationId);
    if (!op || op.principal !== principal) return { code: 'OPERATION_NOT_FOUND' };
    const decision = this.access.check(principal, op.sessionId, op.generation, 'operation:read');
    if (!decision.ok) return { code: decision.code === 'FORBIDDEN' || decision.code === 'SESSION_NOT_FOUND' ? 'PERMISSION_DENIED' : decision.code, op };
    return { op };
  }

  async getOperation(principal, args, requestId) {
    let r = this.readableOperation(principal, args.operation_id);
    if (r.code) return this.errorB(requestId, r.code, undefined, r.op ? r.op.id : null);
    await this.input.arbiter.waitFor(r.op, args.wait_ms);
    r = this.readableOperation(principal, args.operation_id); // re-check right before returning
    if (r.code) return this.errorB(requestId, r.code, undefined, r.op ? r.op.id : null);
    return { ...this.envelope(requestId), ...this.input.arbiter.view(r.op, { full: true }) };
  }

  // Opaque cursor at the current end of a session's capture (operation output ranges).
  positionCursor(session) {
    const buffer = session.buffer;
    if (!buffer || !session.captureId) return null;
    const pos = buffer.endPosition();
    const target = this.registry.target(session);
    return this.cursors.encode({ k: 'out', a: target.app_instance_id, s: target.session_id, g: target.generation, st: STREAM, c: session.captureId, e: buffer.epoch, q: pos.seq, o: pos.offset });
  }

  readOutput(principal, args, requestId) {
    const auth = this.authorize(principal, args.target, 'output:read', requestId);
    if (auth.error) return auth.error;
    const { session } = auth;
    const buffer = session.buffer;
    if (!buffer) return this.error(requestId, 'INTERNAL_ERROR');
    buffer.prune(); // enforce age retention now, not only on the next append / sweep
    const target = this.registry.target(session);

    let start;
    let gap = null;
    if (args.cursor !== undefined) {
      const c = this.cursors.decode(args.cursor);
      if (!c || c.k !== 'out') return this.error(requestId, 'CURSOR_INVALID');
      if (c.a !== target.app_instance_id || c.s !== target.session_id || c.g !== target.generation || c.st !== STREAM
        || c.c !== session.captureId || c.e !== buffer.epoch) {
        return this.error(requestId, 'CURSOR_INVALID');
      }
      const resolved = buffer.resolvePosition({ seq: c.q, offset: c.o });
      if (resolved.error) return this.error(requestId, resolved.error);
      start = resolved.pos;
      gap = resolved.gap;
    } else if (args.tail) {
      start = buffer.tailPosition(args.max_bytes);
    } else {
      // No cursor: from the oldest retained position. Data dropped before it is a gap only if the
      // client could have seen it, so a fresh read reports no gap.
      start = { seq: buffer.firstSeq, offset: 0 };
    }

    const read = buffer.read(start, args.max_bytes, gap);
    if (read.tooSmall) {
      return this.error(requestId, 'INPUT_INVALID', { message: 'max_bytes is smaller than the next character.', minimum_required_bytes: read.tooSmall });
    }
    // Re-check the grant right before returning data (it may have ended while we were reading).
    const recheck = this.access.check(principal, target.session_id, target.generation, 'output:read');
    if (!recheck.ok) return this.error(requestId, recheck.code);

    const masked = redact(read.text);
    const first = buffer.chunks.length ? buffer.chunks[0].seq : null;
    const last = buffer.chunks.length ? buffer.chunks[buffer.chunks.length - 1].seq : null;
    const g = read.gap;
    return {
      ...this.envelope(requestId),
      target,
      stream: STREAM,
      text: masked.text,
      first_seq: read.firstSeq == null ? null : String(read.firstSeq),
      last_seq: read.lastSeq == null ? null : String(read.lastSeq),
      next_cursor: this.cursors.encode({ k: 'out', a: target.app_instance_id, s: target.session_id, g: target.generation, st: STREAM, c: session.captureId, e: buffer.epoch, q: read.pos.seq, o: read.pos.offset }),
      has_more: read.hasMore,
      gap: !!g,
      gap_reason: g ? g.reason : null,
      missing_range: g && g.from != null ? { from_seq: String(g.from), to_seq: String(g.to) } : null,
      truncated: read.truncated,
      available_from: first == null ? null : String(first),
      available_to: last == null ? null : String(last),
      capture_state: session.capture,
      normalization: {
        control_sequences_removed: read.controlRemoved,
        invalid_utf8_replaced: read.replaced,
        display_reconstruction: false
      },
      redaction_applied: masked.applied,
      untrusted_output: true
    };
  }
}

module.exports = { Broker, STREAM, ERROR_DEFAULTS };
