// dots integration controller: owns the ledger, grants, broker, local server and audit log, and is
// the only thing main.js talks to. Electron-free (dependencies are injected) so it is unit-tested.
//
// OFF by default. While OFF nothing listens and nothing is captured; the PTY hooks only keep the
// session ledger (a Map update per terminal start/close), so terminals behave exactly as before.
//
// Stage B (input) has its own release gate, all of which must hold:
//  - transport 'reviewed': on Windows the DACL-restricted pipe relay started and its DACL verified
//    (pipe-relay.js); if that fails, reads continue over the plain pipe and input stays blocked,
//  - the user turned input on (Integration menu; off by default, separate confirmation),
//  - the operation journal is healthy, and at least one verified CLI profile exists.
// Each pane additionally needs its own input grant and a locally selected profile.

const path = require('path');
const { SessionRegistry } = require('./session-registry');
const { AccessControl, RateLimiter, READ_PERMISSIONS, DEFAULT_GRANT_MS } = require('./access-control');
const { Broker } = require('./broker');
const { createBrokerServer, principalFor } = require('./local-transport');
const { createAuditLog } = require('./audit');
const { OperationStore } = require('./operation-store');
const { InputArbiter } = require('./input-arbiter');
const { verifiedProfiles, findProfile } = require('./input-profiles');
const { createSecurePipeListener } = require('./pipe-relay');
const pairing = require('./pairing');

const INPUT_PERMISSIONS = ['input:write', 'operation:read'];

// Bytes xterm sends on its own (focus reports, device-attribute / cursor-position / colour replies).
// They travel the same IPC as keystrokes but are not a human taking over the pane.
const TERMINAL_REPORT_RE = /^(?:\x1b\[[IO]|\x1b\[[?>]?[\d;]*[cnR]|\x1b\][\d;]*[^\x07\x1b]*(?:\x07|\x1b\\))+$/;
function isTerminalReport(data) { return typeof data === 'string' && data.length > 0 && TERMINAL_REPORT_RE.test(data); }

const SWEEP_MS = 5000;

class IntegrationController {
  constructor({
    userDataDir, appVersion = '0.0.0', platform = process.platform,
    readSettings = () => ({}), writeSettings = () => true,
    notifyView = () => {}, limits = {}, now = Date.now, monotonic,
    // Stage B hooks (main.js): PTY writer, confirmation UI, OS-protected journal key, test overrides.
    writePty = () => false, requestConfirmation = () => { throw new Error('no confirmation UI'); }, cancelConfirmation = () => {},
    journalKey = () => null, secureTransport = null
  }) {
    this.userDataDir = userDataDir;
    this.dir = pairing.integrationDir(userDataDir);
    this.platform = platform;
    this.readSettings = readSettings;
    this.writeSettings = writeSettings;
    this.notifyView = notifyView;
    this.now = now;
    this.registry = new SessionRegistry({ limits, now });
    this.endReason = null; // set around an explicit end so the audit line says why
    const onEnd = (grant, code) => this.onGrantEnded(grant, code);
    this.access = new AccessControl(monotonic ? { now, monotonic, onEnd } : { now, onEnd });
    this.rateLimiter = new RateLimiter(monotonic ? { monotonic } : {});
    this.audit = createAuditLog({ dir: path.join(this.dir, 'audit'), now });
    this.broker = new Broker({ registry: this.registry, access: this.access, rateLimiter: this.rateLimiter, audit: this.audit, now, serverVersion: appVersion });
    this.server = null;
    this.principal = null;
    this.endpoint = null;
    this.lastError = null;
    this.sweepTimer = null;
    this.registry.onChange((event, session) => this.onSessionEvent(event, session));
    this.transportGate = 'blocked';
    this.transportNote = null;
    this.secureTransport = secureTransport; // (pipePath) => listenWith | null; default: Windows relay
    this.journalKey = journalKey;
    this.store = null;
    this.arbiter = new InputArbiter({
      registry: this.registry,
      access: this.access,
      store: { healthy: false, digest: () => '', lookup: () => null, append: () => { throw new Error('no journal'); }, retentionMs: 0 },
      writePty: (session, data) => writePty(session.viewId, session.termId, data),
      requestConfirmation,
      cancelConfirmation,
      cursorAt: (session) => this.broker.positionCursor(session),
      audit: this.audit,
      isGateOpen: () => this.inputGate().open,
      now,
      onChange: (op) => this.pushPaneState(op.viewId)
    });
    this.broker.setInput({ arbiter: this.arbiter, gate: () => this.inputGate() });
  }

  get enabled() { return !!this.server; }

  settingsIntegration() {
    const settings = this.readSettings() || {};
    return settings.integration && typeof settings.integration === 'object' ? settings.integration : {};
  }

  saveIntegration(patch) { this.writeSettings({ integration: { ...this.settingsIntegration(), ...patch } }); }

  get inputEnabled() { return !!this.settingsIntegration().inputEnabled; }

  inputGate() {
    const journalHealthy = !!(this.store && this.store.healthy);
    const profiles = verifiedProfiles().length > 0;
    return {
      open: this.enabled && this.transportGate === 'reviewed' && this.inputEnabled && journalHealthy && profiles,
      transport: this.transportGate,
      inputEnabled: this.inputEnabled,
      journalHealthy,
      profiles
    };
  }

  openJournal() {
    if (this.store) this.store.close();
    let key = null;
    try { key = this.journalKey(); } catch { key = null; }
    this.store = new OperationStore({ dir: path.join(this.dir, 'journal'), key, now: this.now });
    this.store.open();
    this.arbiter.store = this.store;
  }

  // Windows: the DACL-restricted relay; elsewhere none (tests inject one).
  async listenerFor(endpoint) {
    if (this.secureTransport) return this.secureTransport(endpoint);
    if (this.platform !== 'win32') return null;
    const sid = await pairing.currentUserSid();
    return createSecurePipeListener({ pipePath: endpoint, sid, onLog: (e) => this.audit.record(e) });
  }

  // App start: resume the listener only if the user left the integration on. Grants never persist.
  async start() {
    const settings = this.readSettings() || {};
    if (settings.integration && settings.integration.enabled) {
      try { await this.listen(); } catch (error) { this.lastError = error.message || String(error); }
    }
  }

  async listen() {
    const { secret, endpoint } = await pairing.ensurePairing(this.userDataDir, { platform: this.platform });
    const make = (listenWith) => createBrokerServer({
      endpoint,
      secret,
      listenWith,
      onTool: (principal, name, args) => this.broker.handle(principal, name, args),
      onEvent: (event) => this.audit.record(event)
    });
    let server = null;
    this.transportGate = 'blocked';
    this.transportNote = null;
    try {
      const listenWith = await this.listenerFor(endpoint);
      if (listenWith) {
        server = make(listenWith);
        await server.listen();
        this.transportGate = 'reviewed';
      } else {
        this.transportNote = 'No user-restricted transport on this platform; input stays off.';
      }
    } catch (error) {
      server = null;
      this.transportNote = `Restricted pipe unavailable (${error.message || error}); input stays off.`;
      this.audit.record({ event: 'transport_gate_blocked', reason: String(error.message || error).slice(0, 200) });
    }
    if (!server) {
      // Read-only fallback (Stage A transport). Input is never served over it.
      server = make(null);
      await server.listen();
    }
    this.openJournal();
    this.server = server;
    this.principal = principalFor(secret);
    this.endpoint = endpoint;
    this.lastError = null;
    this.audit.prune();
    if (!this.sweepTimer) {
      this.sweepTimer = setInterval(() => this.sweep(), SWEEP_MS);
      if (this.sweepTimer.unref) this.sweepTimer.unref();
    }
  }

  async enable() {
    if (this.enabled) return;
    await this.listen();
    this.saveIntegration({ enabled: true });
    this.audit.record({ event: 'integration_enabled', principal: this.principal });
  }

  async disable() {
    this.revokeAll('integration_disabled');
    if (this.server) { try { await this.server.close(); } catch {} }
    this.server = null;
    if (this.sweepTimer) { clearInterval(this.sweepTimer); this.sweepTimer = null; }
    this.saveIntegration({ enabled: false });
    this.transportGate = 'blocked';
    if (this.store) { this.store.close(); this.store = null; this.arbiter.store = { healthy: false, digest: () => '', lookup: () => null, append: () => { throw new Error('no journal'); }, retentionMs: 0 }; }
    this.audit.record({ event: 'integration_disabled' });
  }

  // New secret = new principal; all grants (bound to the old principal) end.
  async resetPairing() {
    const wasEnabled = this.enabled;
    if (wasEnabled) await this.disable();
    pairing.resetPairing(this.userDataDir);
    this.access.forgetEnded();
    if (wasEnabled) await this.enable();
  }

  async shutdown() {
    this.revokeAll('app_exit');
    if (this.store) this.store.close();
    if (this.server) { try { await this.server.close(); } catch {} }
    this.server = null;
    if (this.sweepTimer) { clearInterval(this.sweepTimer); this.sweepTimer = null; }
  }

  // --- PTY hooks (main.js). Never throw into the terminal path. ---

  ptyStarted(viewId, termId, info) { this.safe(() => this.registry.ptyStarted({ viewId, termId, ...info })); }
  ptyData(viewId, termId, data) { this.safe(() => this.registry.ptyData(viewId, termId, data)); }
  ptyExited(viewId, termId) { this.safe(() => this.registry.ptyExited(viewId, termId)); }
  ptyClosed(viewId, termId) { this.safe(() => this.registry.ptyClosed(viewId, termId)); }
  viewGone(viewId) { this.safe(() => this.registry.viewGone(viewId)); }
  // Renderer input for a pane (main calls this BEFORE writing it to the PTY). Terminal-generated
  // reports are not a human; real input moves state_revision and stops any pending AI operation.
  userInput(viewId, termId, data) {
    this.safe(() => {
      if (isTerminalReport(data)) return;
      this.registry.userInput(viewId, termId);
      const session = this.registry.bySlot(viewId, termId);
      if (session) this.arbiter.humanInput(session);
    });
  }

  // The renderer reloaded: its panes (and the user's view of what is shared) are gone.
  viewReset(viewId) {
    this.safe(() => {
      for (const session of this.registry.sessions.values()) {
        if (session.viewId === viewId) this.endGrant(session, 'GRANT_REVOKED', 'view_reloaded');
      }
    });
  }

  safe(fn) {
    try { return fn(); } catch (error) { this.lastError = error.message || String(error); return undefined; }
  }

  onSessionEvent(event, session) {
    if (event === 'replaced' || event === 'closed') {
      this.arbiter.sessionChanged(session.sessionId, 'STALE_SESSION');
      session.inputProfile = null;
      session.inputPaused = false;
      this.endGrant(session, 'GRANT_REVOKED', `pty_${event}`);
    } else if (event === 'exited') this.arbiter.sessionChanged(session.sessionId, 'STATE_CONFLICT');
    else if (event === 'exited') this.pushPaneState(session.viewId);
  }

  // Single cleanup path for every ended grant (revoke, sweep, or expiry noticed lazily by a read):
  // capture stops and retained output is discarded, which also invalidates every cursor.
  onGrantEnded(grant, code) {
    this.arbiter.sessionChanged(grant.session_id, code);
    const session = this.registry.sessions.get(grant.session_id);
    if (session && session.generation === grant.generation) this.registry.resetCapture(session);
    this.audit.record({ event: 'grant_ended', principal: grant.principal, session_id: grant.session_id, generation: grant.generation, code, reason: this.endReason || undefined });
    if (session) this.pushPaneState(session.viewId);
  }

  endGrant(session, code, reason) {
    this.endReason = reason;
    try {
      const grant = this.access.end(session.sessionId, code);
      if (!grant) this.registry.resetCapture(session);
      this.pushPaneState(session.viewId);
      return grant;
    } finally {
      this.endReason = null;
    }
  }

  sweep() {
    this.access.sweep(); // onGrantEnded does the cleanup
    for (const session of this.registry.sessions.values()) if (session.buffer) session.buffer.prune();
  }

  // --- UI operations (pane menu / app menu in main.js) ---

  sessionFor(viewId, termId) {
    const session = this.registry.bySlot(viewId, termId);
    return session && session.lifecycle !== 'closed' ? session : null;
  }

  // Grant read-only access to one pane. Capture starts NOW: earlier scrollback is never shared.
  share(viewId, termId, { label, durationMs = DEFAULT_GRANT_MS } = {}) {
    if (!this.enabled) throw new Error('The dots integration is turned off.');
    const session = this.sessionFor(viewId, termId);
    if (!session) throw new Error('This terminal is not running.');
    if (label !== undefined) this.registry.setLabel(session, label);
    const grant = this.access.issue({ principal: this.principal, sessionId: session.sessionId, generation: session.generation, permissions: READ_PERMISSIONS, durationMs });
    this.registry.resetCapture(session);
    this.registry.startCapture(session);
    this.audit.record({ event: 'grant_issued', principal: this.principal, session_id: session.sessionId, generation: session.generation, permissions: READ_PERMISSIONS });
    this.pushPaneState(viewId);
    return grant;
  }

  extend(viewId, termId, durationMs = DEFAULT_GRANT_MS) {
    const session = this.sessionFor(viewId, termId);
    const grant = session && this.access.extend(session.sessionId, durationMs);
    if (grant) {
      this.registry.bump(session);
      this.audit.record({ event: 'grant_extended', principal: grant.principal, session_id: grant.session_id, generation: grant.generation });
    }
    this.pushPaneState(viewId);
    return grant;
  }

  stopSharing(viewId, termId) {
    const session = this.sessionFor(viewId, termId);
    if (session) this.endGrant(session, 'GRANT_REVOKED', 'user_stopped');
  }

  pause(viewId, termId) {
    const session = this.sessionFor(viewId, termId);
    if (session && this.access.active(session.sessionId)) this.registry.pauseCapture(session);
    this.pushPaneState(viewId);
  }

  resume(viewId, termId) {
    const session = this.sessionFor(viewId, termId);
    if (session && this.access.active(session.sessionId)) this.registry.resumeCapture(session);
    this.pushPaneState(viewId);
  }

  clearBuffer(viewId, termId) {
    const session = this.sessionFor(viewId, termId);
    if (session && this.registry.clearCapture(session)) {
      this.audit.record({ event: 'buffer_cleared', session_id: session.sessionId, generation: session.generation });
    }
    this.pushPaneState(viewId);
  }

  // --- Stage B UI operations ---

  async setInputEnabled(on) {
    if (on && this.transportGate !== 'reviewed') throw new Error(this.transportNote || 'The restricted transport is not available; input cannot be enabled.');
    this.saveIntegration({ inputEnabled: !!on });
    this.audit.record({ event: on ? 'input_enabled' : 'input_disabled' });
    if (!on) {
      this.arbiter.stopAll('PERMISSION_DENIED');
      for (const grant of [...this.access.grants.values()]) {
        for (const perm of INPUT_PERMISSIONS) grant.permissions.delete(perm);
        const session = this.registry.sessions.get(grant.session_id);
        if (session) { this.registry.bump(session); this.pushPaneState(session.viewId); }
      }
    }
  }

  // Add input:write + operation:read to the pane's existing (read) grant; same expiry.
  grantInput(viewId, termId) {
    const session = this.sessionFor(viewId, termId);
    const grant = session && this.access.active(session.sessionId);
    if (!grant) throw new Error('Share this terminal first.');
    if (!this.inputGate().open) throw new Error('Terminal input is not enabled.');
    for (const perm of INPUT_PERMISSIONS) grant.permissions.add(perm);
    this.registry.bump(session);
    this.audit.record({ event: 'input_granted', principal: grant.principal, session_id: session.sessionId, generation: session.generation, permissions: INPUT_PERMISSIONS });
    this.pushPaneState(viewId);
    return grant;
  }

  revokeInput(viewId, termId) {
    const session = this.sessionFor(viewId, termId);
    const grant = session && this.access.active(session.sessionId);
    if (!grant) return;
    this.arbiter.sessionChanged(session.sessionId, 'GRANT_REVOKED');
    for (const perm of INPUT_PERMISSIONS) grant.permissions.delete(perm);
    this.registry.bump(session);
    this.audit.record({ event: 'input_revoked', principal: grant.principal, session_id: session.sessionId, generation: session.generation });
    this.pushPaneState(viewId);
  }

  selectProfile(viewId, termId, profileId) {
    const session = this.sessionFor(viewId, termId);
    if (!session) return;
    const profile = profileId ? findProfile(profileId) : null;
    if (profileId && !profile) throw new Error('Unknown or unverified profile.');
    this.arbiter.sessionChanged(session.sessionId, 'STATE_CONFLICT');
    session.inputProfile = profile ? { id: profile.id, revision: profile.revision } : null;
    this.registry.bump(session);
    this.pushPaneState(viewId);
  }

  takeover(viewId, termId) {
    const session = this.sessionFor(viewId, termId);
    if (session) { this.arbiter.takeover(session); this.pushPaneState(viewId); }
  }

  resumeInput(viewId, termId) {
    const session = this.sessionFor(viewId, termId);
    if (session) { this.arbiter.resume(session); this.pushPaneState(viewId); }
  }

  // The local confirmation dialog's answer: 'approved' | 'declined' | 'expired'.
  confirmOperation(opId, stage, decision) { return this.arbiter.confirm(opId, stage, decision); }

  recentOperations(limit = 10) {
    return [...this.arbiter.ops.values()].slice(-limit).reverse().map((op) => ({
      id: op.id, status: op.status, phase: op.phase, kind: op.kind, submit: op.submit,
      code: op.error ? op.error.code : null, acceptedAt: op.acceptedAt, finishedAt: op.finishedAt, sessionId: op.sessionId
    }));
  }

  revokeAll(reason = 'user_revoked_all') {
    this.endReason = reason;
    try { this.access.endAll('GRANT_REVOKED'); } finally { this.endReason = null; }
    // Belt and braces: no capture may outlive its grant.
    for (const session of this.registry.sessions.values()) {
      if (session.capture !== 'off' && !this.access.grants.has(session.sessionId)) {
        this.registry.resetCapture(session);
        this.pushPaneState(session.viewId);
      }
    }
  }

  // Sharing state of every pane of one view, for the renderer's badges.
  paneState(viewId) {
    const panes = [];
    for (const session of this.registry.sessions.values()) {
      if (session.viewId !== viewId) continue;
      const grant = this.access.active(session.sessionId);
      panes.push({
        id: session.termId,
        shared: !!grant,
        permissions: grant ? [...grant.permissions].sort() : [],
        expiresAt: grant ? Math.min(grant.expiresAtWall, this.now() + Math.max(0, grant.expiresAtMono - this.access.monotonic())) : null,
        capture: session.capture,
        sessionId: session.sessionId,
        generation: session.generation,
        input: !!(grant && grant.permissions.has('input:write')),
        profileId: session.inputProfile ? session.inputProfile.id : null,
        inputPaused: !!session.inputPaused,
        pendingStage: (() => { const op = this.arbiter.pending.get(session.sessionId); return op ? (op.awaiting || op.phase) : null; })()
      });
    }
    return panes;
  }

  pushPaneState(viewId) {
    try { this.notifyView(viewId, this.paneState(viewId)); } catch {}
  }

  status() {
    const server = this.server ? this.server.status() : null;
    return {
      enabled: this.enabled,
      endpoint: this.endpoint,
      principal: this.principal,
      connections: server ? server.connections : 0,
      lastConnectedAt: server ? server.lastConnectedAt : null,
      lastAuthFailureAt: server ? server.lastAuthFailureAt : null,
      lastCallAt: this.broker.lastCallAt,
      activeGrants: this.access.grants.size,
      lastError: this.lastError,
      integrationDir: this.dir,
      transportGate: this.transportGate,
      transportNote: this.transportNote,
      inputEnabled: this.inputEnabled,
      inputGateOpen: this.inputGate().open,
      journalHealthy: !!(this.store && this.store.healthy),
      journalError: this.store ? this.store.error : null,
      operations: this.recentOperations()
    };
  }
}

module.exports = { IntegrationController, isTerminalReport, INPUT_PERMISSIONS };
