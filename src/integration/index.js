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
const { AccessControl, RateLimiter, READ_PERMISSIONS, INPUT_PERMISSIONS } = require('./access-control');
const { Broker } = require('./broker');
const { createBrokerServer, principalFor } = require('./local-transport');
const { createAuditLog } = require('./audit');
const { OperationStore } = require('./operation-store');
const { InputArbiter } = require('./input-arbiter');
const { verifiedProfiles, findProfile, versionStatus } = require('./input-profiles');
const { createSecurePipeListener } = require('./pipe-relay');
const pairing = require('./pairing');


// Bytes xterm sends on its own (focus reports, device-attribute / cursor-position / colour replies).
// They travel the same IPC as keystrokes but are not a human taking over the pane.
const TERMINAL_REPORT_RE = /^(?:\x1b\[[IO]|\x1b\[[?>]?[\d;]*[cnR]|\x1b\][\d;]*[^\x07\x1b]*(?:\x07|\x1b\\))+$/;
function isTerminalReport(data) { return typeof data === 'string' && data.length > 0 && TERMINAL_REPORT_RE.test(data); }

const SWEEP_MS = 5000; // output-retention pruning only; sharing itself has no time limit

class IntegrationController {
  constructor({
    userDataDir, appVersion = '0.0.0', platform = process.platform,
    readSettings = () => ({}), writeSettings = () => true,
    notifyView = () => {}, limits = {}, now = Date.now, monotonic,
    // Stage B hooks (main.js): PTY writer, confirmation UI, OS-protected journal key, test overrides.
    writePty = () => false, requestConfirmation = () => { throw new Error('no confirmation UI'); }, cancelConfirmation = () => {},
    journalKey = () => null, secureTransport = null,
    // Optional tunnel-client runner (tunnel-runner.js): runs only while the integration is on.
    tunnel = null
  }) {
    this.tunnel = tunnel;
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
    this.access = new AccessControl({ now, onEnd });
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
      onChange: (op) => this.pushPaneState(op.viewId),
      autoApprove: (op) => this.autoConfirmApplies(op),
      targetState: (session) => this.cliTarget(session),
      outputMark: (session) => this.outputMark(session),
      observe: (op) => this.observeOperation(op)
    });
    this.broker.setInput({ arbiter: this.arbiter, gate: () => this.inputGate(), cliStatus: (session) => this.cliTarget(session).status });
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
      this.pushAllPaneStates(); // panes opened while the listener was starting get their badge
      if (this.enabled && this.tunnel) this.tunnel.autoStart();
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
    this.audit.record({ event: 'broker_listening', reason: this.transportGate === 'reviewed' ? 'relay' : 'plain-pipe', endpoint, pid: process.pid });
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
    this.pushAllPaneStates();
    if (this.tunnel) this.tunnel.autoStart();
  }

  // Always turns the integration off (closing the pipe is the safe direction). Returns
  // { tunnelStopped: false } when tunnel-client could not be ended, so the caller can tell the user.
  async disable() {
    const tunnelStopped = this.tunnel ? this.tunnel.stop('integration_disabled') !== false : true;
    this.revokeAll('integration_disabled');
    if (this.server) { try { await this.server.close(); } catch {} }
    this.server = null;
    if (this.sweepTimer) { clearInterval(this.sweepTimer); this.sweepTimer = null; }
    this.saveIntegration({ enabled: false });
    this.transportGate = 'blocked';
    if (this.store) { this.store.close(); this.store = null; this.arbiter.store = { healthy: false, digest: () => '', lookup: () => null, append: () => { throw new Error('no journal'); }, retentionMs: 0 }; }
    this.audit.record({ event: 'integration_disabled' });
    this.pushAllPaneStates();
    return { tunnelStopped };
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
    if (this.tunnel) this.tunnel.stop('app_exit');
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
      this.clearAutoConfirm(session, `pty_${event}`);
      session.inputProfile = null;
      session.inputPaused = false;
      this.endGrant(session, 'GRANT_REVOKED', `pty_${event}`);
    } else if (event === 'started') {
      this.pushPaneState(session.viewId); // a new / restarted pane shows its (OFF) state right away
    } else if (event === 'shell_prompt') {
      // The shell printed its prompt (OSC 7 cwd report): the CLI that input was approved for has
      // exited (or was never in front). Input must be allowed again for whatever runs next; an
      // Input ON dialog still open for the old target is invalidated too.
      session.inputEpoch = (session.inputEpoch || 0) + 1;
      session.cli = null; // the CLI is gone; the next one has to be identified again
      this.revokeInputFor(session, 'shell_prompt');
      this.pushPaneState(session.viewId);
    } else if (event === 'cli_banner') {
      this.cliSeen(session, session.lastBanner);
    } else if (event === 'exited') {
      // The pane's process ended: both switches go OFF (a restarted shell is a new generation).
      this.arbiter.sessionChanged(session.sessionId, 'STATE_CONFLICT');
      this.endGrant(session, 'GRANT_REVOKED', 'pty_exited');
    }
  }

  // Single cleanup path for every ended grant (revoke, sweep, or expiry noticed lazily by a read):
  // capture stops and retained output is discarded, which also invalidates every cursor.
  onGrantEnded(grant, code) {
    this.arbiter.sessionChanged(grant.session_id, code);
    const session = this.registry.sessions.get(grant.session_id);
    if (session) this.clearAutoConfirm(session, 'grant_ended');
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
    for (const session of this.registry.sessions.values()) if (session.buffer) session.buffer.prune();
  }

  // --- UI operations (pane menu / app menu in main.js) ---

  sessionFor(viewId, termId) {
    const session = this.registry.bySlot(viewId, termId);
    return session && session.lifecycle !== 'closed' ? session : null;
  }

  // Read sharing switch ON for one pane. Capture starts NOW: earlier scrollback is never shared.
  // No time limit: it stays on until turned off, the PTY is replaced/closed, the integration is
  // turned off, or the app exits.
  share(viewId, termId, { label } = {}) {
    if (!this.enabled) throw new Error('The dots integration is turned off.');
    const session = this.sessionFor(viewId, termId);
    if (!session || session.lifecycle !== 'alive') throw new Error('This terminal is not running.');
    if (this.access.active(session.sessionId)) return this.access.active(session.sessionId); // already on
    if (label !== undefined) this.registry.setLabel(session, label);
    const grant = this.access.issue({ principal: this.principal, sessionId: session.sessionId, generation: session.generation, permissions: READ_PERMISSIONS });
    this.registry.resetCapture(session);
    this.registry.startCapture(session);
    this.audit.record({ event: 'grant_issued', principal: this.principal, session_id: session.sessionId, generation: session.generation, permissions: READ_PERMISSIONS });
    this.pushPaneState(viewId);
    return grant;
  }

  // Read sharing switch OFF: input goes OFF with it; pending (unconfirmed / unsent) AI input is
  // stopped; anything already dispatched is outcome_unknown and never re-sent.
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
      for (const s2 of this.registry.sessions.values()) {
        this.clearAutoConfirm(s2, 'input_disabled');
        s2.inputEpoch = (s2.inputEpoch || 0) + 1;
      }
      for (const grant of [...this.access.grants.values()]) {
        this.access.revokeInput(grant);
        const session = this.registry.sessions.get(grant.session_id);
        if (session) { this.registry.bump(session); this.pushPaneState(session.viewId); }
      }
    }
  }

  // Add input:write + operation:read to the pane's existing (read) grant; same expiry.
  // The input-target snapshot a confirmation dialog shows; grantInput(…, expect) refuses when it
  // changed meanwhile (pane restarted, profile changed, shell prompt came back, read went off).
  inputTarget(viewId, termId) {
    const session = this.sessionFor(viewId, termId);
    if (!session) return null;
    const grant = this.access.active(session.sessionId);
    return { sessionId: session.sessionId, generation: session.generation, grantId: grant ? grant.grant_id : null, inputEpoch: session.inputEpoch || 0, profileId: session.inputProfile ? session.inputProfile.id : null, cliKey: this.cliTarget(session).key };
  }

  grantInput(viewId, termId, expect = null) {
    const session = this.sessionFor(viewId, termId);
    const grant = session && this.access.active(session.sessionId);
    if (!grant) throw new Error('Share this terminal first.');
    if (session.lifecycle !== 'alive') throw new Error('This terminal is not running.');
    if (!this.inputGate().open) throw new Error('Terminal input is not enabled.');
    if (!session.inputProfile) throw new Error('Choose a CLI input profile first.');
    const cliTarget = this.cliTarget(session);
    if (!cliTarget.usable) throw new Error(cliTarget.message);
    if (expect) {
      const now = this.inputTarget(viewId, termId);
      if (!now || now.sessionId !== expect.sessionId || now.generation !== expect.generation || !expect.grantId || now.grantId !== expect.grantId
        || now.inputEpoch !== expect.inputEpoch || now.profileId !== expect.profileId || now.cliKey !== expect.cliKey) {
        throw new Error('The terminal changed while the dialog was open (CLI exited, profile changed, or pane restarted). Turn Input ON again.');
      }
    }
    this.access.grantInput(grant); // no time limit: on until turned off (or read sharing goes off)
    this.registry.bump(session);
    this.audit.record({ event: 'input_granted', principal: grant.principal, session_id: session.sessionId, generation: session.generation, permissions: INPUT_PERMISSIONS });
    this.pushPaneState(viewId);
    return grant;
  }

  revokeInput(viewId, termId) {
    const session = this.sessionFor(viewId, termId);
    if (session) this.revokeInputFor(session, 'user_stopped');
  }

  // --- which CLI / version the pane's input goes to ---
  // Identified from the pane's OWN output (the CLI's startup banner, source 'pane_output') or by the
  // user ('user_confirmed'). A version found by running the CLI in another process is never used:
  // PATH can start a different install than the one in the pane.

  compatApprovals(profileId) {
    const all = this.settingsIntegration().compatApprovals;
    const list = all && typeof all === 'object' && Array.isArray(all[profileId]) ? all[profileId] : [];
    return list.filter((v) => typeof v === 'string');
  }

  cliStatus(session) {
    const b = session.inputProfile;
    const profile = b ? findProfile(b.id, b.revision) : null;
    const st = versionStatus(profile, session.cli, profile ? this.compatApprovals(profile.id) : []);
    return { ...st, profile };
  }

  // For the arbiter: may input go to this pane now, and a key that changes with CLI/version/status.
  cliTarget(session) {
    const st = this.cliStatus(session);
    const cli = session.cli;
    // Not the evidence source: the same CLI / version confirmed again by its banner is the same target.
    const key = [st.profile ? st.profile.id : '-', cli ? cli.family : '-', cli ? cli.version : '-', st.status].join('|');
    const messages = {
      unknown: 'The CLI version running in this terminal is unknown. Confirm it in Workbench (pane menu), or restart the CLI while Read Sharing is on.',
      family_mismatch: 'The CLI running in this terminal does not match the selected input profile.',
      major_changed: 'The CLI in this terminal is a different major version than the verified ones; the input profile has to be measured again.',
      compat_pending: 'The CLI version in this terminal is not verified; the user has to allow compatible behaviour for it in Workbench.'
    };
    return { usable: st.usable, key, message: messages[st.status] || null, status: st.status };
  }

  // A CLI banner appeared in the pane: a (new) CLI started. A different CLI or version is a new
  // input target: input (and skipping confirmations) stops until the user turns it on again.
  cliSeen(session, cli) {
    if (!cli) return;
    const prev = session.cli;
    const changed = !prev || prev.family !== cli.family || prev.version !== cli.version;
    session.cli = { family: cli.family, version: cli.version, source: 'pane_output', at: this.now() };
    if (changed) {
      session.inputEpoch = (session.inputEpoch || 0) + 1;
      this.revokeInputFor(session, 'cli_changed');
      this.audit.record({ event: 'cli_detected', session_id: session.sessionId, generation: session.generation, reason: `${cli.family} ${cli.version}` });
    }
    this.pushPaneState(session.viewId);
  }

  // The user states which version runs in the pane (when no banner was seen). Never turns input on.
  confirmCliVersion(viewId, termId, version, expect) {
    const session = this.sessionFor(viewId, termId);
    const st = session && this.cliStatus(session);
    if (!session || !st.profile) throw new Error('Choose a CLI input profile first.');
    // The dialog's snapshot: same pane incarnation, input period, profile and CLI state as shown.
    const now = this.inputTarget(viewId, termId);
    if (!expect || !now || now.sessionId !== expect.sessionId || now.generation !== expect.generation || !expect.grantId || now.grantId !== expect.grantId
      || now.inputEpoch !== expect.inputEpoch || now.profileId !== expect.profileId || now.cliKey !== expect.cliKey) {
      throw new Error('The terminal changed while the dialog was open. Check the version again.');
    }
    if (!st.profile.verified_versions.includes(String(version))) throw new Error('Only a verified version can be confirmed by the user.');
    const prev = session.cli;
    if (prev && prev.source === 'pane_output') throw new Error('The version was already seen in this pane\'s output.');
    session.cli = { family: st.profile.cli_family, version: String(version), source: 'user_confirmed', at: this.now() };
    if (!prev || prev.version !== session.cli.version) {
      session.inputEpoch = (session.inputEpoch || 0) + 1;
      this.revokeInputFor(session, 'cli_changed');
    }
    this.audit.record({ event: 'cli_user_confirmed', session_id: session.sessionId, generation: session.generation, reason: `${session.cli.family} ${session.cli.version}` });
    this.pushPaneState(viewId);
  }

  // Allow compatible behaviour for one unverified version of the same major (remembered, so the same
  // version is not asked again). Does NOT turn sharing, input or skip-confirmation on.
  approveCompat(profileId, version) {
    const profile = findProfile(profileId);
    if (!profile) throw new Error('Unknown profile.');
    const st = versionStatus(profile, { family: profile.cli_family, version }, []);
    if (st.status !== 'compat_pending') throw new Error('Only an unverified version of a verified major version can be allowed.');
    const all = { ...(this.settingsIntegration().compatApprovals || {}) };
    all[profileId] = [...new Set([...(Array.isArray(all[profileId]) ? all[profileId] : []), version])].slice(-20);
    this.saveIntegration({ compatApprovals: all });
    this.audit.record({ event: 'compat_approved', reason: `${profileId} ${version}` });
    for (const s2 of this.registry.sessions.values()) this.pushPaneState(s2.viewId);
  }

  // --- staged observation after Enter (advisory) ---

  outputMark(session) {
    const buffer = session.buffer;
    if (!buffer || !session.captureId) return null;
    return { captureId: session.captureId, epoch: buffer.epoch, pos: buffer.endPosition() };
  }

  // Delivery (text / Enter written) is in op.delivery. This adds what the pane's output showed
  // AFTER the Enter write: the CLI's busy line (acceptance) and then a reply marker (response).
  // Only output after the mark counts, so earlier screens and earlier operations never do. Not seeing
  // something is "not_confirmed", never "not sent".
  observeOperation(op) {
    if (!op.submitAt) return null;
    const unknown = (why) => ({ basis: 'pane_output_after_enter', advisory: true, cli_acceptance: 'unknown', response: 'unknown', note: why });
    const session = this.registry.sessions.get(op.sessionId);
    const mark = op.submitMark;
    if (!session || session.generation !== op.generation) return unknown('terminal_changed');
    if (!mark || !session.buffer || session.captureId !== mark.captureId || session.buffer.epoch !== mark.epoch) return unknown('no_capture');
    const resolved = session.buffer.resolvePosition(mark.pos);
    if (!resolved.ok || resolved.gap) return unknown('output_not_retained');
    // Everything retained after the mark (the per-pane buffer is bounded), page by page.
    let text = '';
    let pos = resolved.pos;
    for (let i = 0; i < 64; i++) {
      const page = session.buffer.read(pos, 256 * 1024);
      if (page.gap) return unknown('output_gap');
      text += page.text;
      pos = page.pos;
      if (!page.hasMore || !page.bytes) break;
    }
    const elapsed = this.now() - op.submitAt;
    const ACCEPT_WINDOW_MS = 15000;
    const RESPONSE_WINDOW_MS = 180000;
    const profile = op.profile;
    let acceptance = 'unknown';
    let acceptAt = -1;
    if (profile.acceptMarker) {
      acceptAt = text.search(profile.acceptMarker);
      acceptance = acceptAt >= 0 ? 'observed' : (elapsed < ACCEPT_WINDOW_MS ? 'pending' : 'not_confirmed');
    }
    let response = 'unknown';
    if (profile.responseMarker && acceptAt >= 0) {
      const found = text.slice(acceptAt).search(profile.responseMarker) >= 0;
      response = found ? 'observed' : (elapsed < RESPONSE_WINDOW_MS ? 'pending' : 'not_confirmed');
    }
    return { basis: 'pane_output_after_enter', advisory: true, cli_acceptance: acceptance, response, note: null };
  }

  // --- "skip the send confirmation" (per pane, opt-in, OFF by default) ---
  // Bound to ONE pane incarnation, read grant, input epoch and CLI profile; never persisted. It
  // only replaces Workbench's two confirmation dialogs: every check, the write order, the submit
  // delay, idempotency, journaling and human takeover stay. Operations already waiting when it is
  // turned on keep their dialogs.

  enableAutoConfirm(viewId, termId, expect) {
    const session = this.sessionFor(viewId, termId);
    const grant = session && this.access.active(session.sessionId);
    if (!session || session.lifecycle !== 'alive') throw new Error('This terminal is not running.');
    if (!grant || !this.access.hasInput(grant)) throw new Error('Turn Input ON first.');
    if (!this.inputGate().open) throw new Error('Terminal input is not enabled.');
    if (!session.inputProfile) throw new Error('Choose a CLI input profile first.');
    const now = this.inputTarget(viewId, termId);
    if (!expect || !now || now.sessionId !== expect.sessionId || now.generation !== expect.generation || now.grantId !== expect.grantId
      || now.inputEpoch !== expect.inputEpoch || now.profileId !== expect.profileId || now.cliKey !== expect.cliKey) {
      throw new Error('The terminal changed while the dialog was open. Turn it on again.');
    }
    session.autoConfirm = {
      sessionId: session.sessionId, generation: session.generation, grantId: grant.grant_id, inputEpoch: session.inputEpoch || 0,
      profileId: session.inputProfile.id, profileRevision: session.inputProfile.revision, sinceSeq: this.arbiter.seq,
      cliKey: this.cliTarget(session).key
    };
    // No state_revision bump: an operation already waiting keeps its own dialogs and stays valid.
    this.audit.record({ event: 'auto_confirm_enabled', principal: grant.principal, session_id: session.sessionId, generation: session.generation, reason: session.inputProfile.id });
    this.pushPaneState(viewId);
  }

  disableAutoConfirm(viewId, termId) {
    const session = this.sessionFor(viewId, termId);
    if (session) this.clearAutoConfirm(session, 'user_stopped');
  }

  // Turn the setting off; any operation that was running under it stops (unsent parts are not sent).
  clearAutoConfirm(session, reason) {
    const ac = session.autoConfirm;
    if (!ac) return false;
    session.autoConfirm = null;
    const op = this.arbiter.pending.get(session.sessionId);
    if (op && op.seq > ac.sinceSeq) this.arbiter.stop(op, 'PERMISSION_DENIED', 'Skipping the send confirmation was turned off; the rest was not sent.');
    this.audit.record({ event: 'auto_confirm_disabled', session_id: session.sessionId, generation: session.generation, reason });
    this.pushPaneState(session.viewId);
    return true;
  }

  // Asked by the arbiter before each step and each write.
  autoConfirmApplies(op) {
    const session = this.registry.sessions.get(op.sessionId);
    const ac = session && session.autoConfirm;
    if (!ac || session.lifecycle !== 'alive') return false;
    const grant = this.access.active(session.sessionId);
    return !!(grant && this.access.hasInput(grant) && this.inputGate().open
      && ac.sessionId === session.sessionId && ac.generation === session.generation && op.generation === session.generation
      && ac.grantId === grant.grant_id && op.grantId === grant.grant_id
      && ac.inputEpoch === (session.inputEpoch || 0)
      && session.inputProfile && ac.profileId === session.inputProfile.id && ac.profileRevision === session.inputProfile.revision
      && op.profile.id === ac.profileId && op.profile.revision === ac.profileRevision
      && op.seq > ac.sinceSeq
      && ac.cliKey === this.cliTarget(session).key && op.targetKey === ac.cliKey);
  }

  // Input switch OFF (read stays): pending AI input stops; nothing dispatched is ever re-sent.
  revokeInputFor(session, reason) {
    this.clearAutoConfirm(session, reason);
    const grant = this.access.active(session.sessionId);
    if (!grant || !this.access.hasInput(grant)) return false;
    session.inputEpoch = (session.inputEpoch || 0) + 1; // dialogs opened for the old input period are stale
    this.arbiter.sessionChanged(session.sessionId, 'GRANT_REVOKED');
    this.access.revokeInput(grant);
    this.registry.bump(session);
    this.audit.record({ event: 'input_revoked', principal: grant.principal, session_id: session.sessionId, generation: session.generation, reason });
    this.pushPaneState(session.viewId);
    return true;
  }

  selectProfile(viewId, termId, profileId) {
    const session = this.sessionFor(viewId, termId);
    if (!session) return;
    const profile = profileId ? findProfile(profileId) : null;
    if (profileId && !profile) throw new Error('Unknown or unverified profile.');
    const before = session.inputProfile;
    const changed = !before !== !profile || (before && profile && (before.id !== profile.id || before.revision !== profile.revision));
    this.arbiter.sessionChanged(session.sessionId, 'STATE_CONFLICT');
    session.inputProfile = profile ? { id: profile.id, revision: profile.revision } : null;
    // A different CLI profile means a different target: input must be confirmed again.
    if (changed) {
      session.inputEpoch = (session.inputEpoch || 0) + 1;
      this.revokeInputFor(session, 'profile_changed');
    }
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
        // 'off' | 'read' | 'read_input' — what the badge shows.
        state: !grant ? 'off' : (grant.permissions.has('input:write') ? 'read_input' : 'read'),
        autoConfirm: !!(grant && grant.permissions.has('input:write') && session.autoConfirm),
        cli: session.cli ? { family: session.cli.family, version: session.cli.version, source: session.cli.source } : null,
        cliStatus: this.cliTarget(session).status,
        integration: this.enabled,
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

  // Every view's badges (the integration was turned on/off: "共有OFF" badges appear/disappear).
  pushAllPaneStates() {
    for (const viewId of new Set([...this.registry.sessions.values()].map((x) => x.viewId))) this.pushPaneState(viewId);
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
