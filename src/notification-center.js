// Pure rules behind the unified notification center (issue #73): Windows toasts relayed by the
// notification bridge and terminal OSC 9 reports share one bell list. No DOM / Electron here so
// everything is unit-testable; renderer.js owns the elements, main.js owns the bridge process.
(function () {
  // A bridge line → SystemNotification (design §10), or null when the line is not a notification
  // we can show. Unknown/extra fields are dropped so the renderer only ever sees this shape.
  function normalizeSystemNotification(msg) {
    if (!msg || typeof msg !== 'object' || msg.type !== 'notification') return null;
    const event = ['existing', 'added', 'removed'].includes(msg.event) ? msg.event : null;
    const id = Number(msg.id);
    if (!event || !Number.isFinite(id)) return null;
    const timestamp = Number(msg.timestamp);
    return {
      source: 'windows',
      event,
      windowsNotificationId: id,
      app: { name: String(msg.app || ''), id: String(msg.appId || '') },
      title: String(msg.title || ''),
      body: String(msg.body || ''),
      timestamp: Number.isFinite(timestamp) && timestamp > 0 ? timestamp : Date.now()
    };
  }

  // Coarse grouping for the row icon / future filters — no AI, just app-name keywords.
  function detectCategory(appName) {
    const app = String(appName || '').toLowerCase();
    if (/slack|teams|outlook|discord|mail|chat|line/.test(app)) return 'communication';
    if (/security|defender/.test(app)) return 'security';
    if (/windows|system|update/.test(app)) return 'system';
    return 'other';
  }

  // Same Windows notification can arrive twice ("existing" snapshot, then "added"): one key.
  function dedupeKey(notification) {
    if (!notification) return '';
    if (notification.source === 'windows') return `windows:${notification.windowsNotificationId}`;
    return '';
  }

  // Bell-list entry for a Windows notification, in the generalized model (design §16). Terminal
  // entries keep their historical flat fields (paneId/label/kind/paneName) and gain source:'terminal'.
  function toHistoryEntry(notification) {
    return {
      source: 'windows',
      category: detectCategory(notification.app.name),
      app: notification.app.name,
      title: notification.title,
      body: notification.body,
      time: notification.timestamp,
      read: false,
      windows: { notificationId: notification.windowsNotificationId, event: notification.event, active: true }
    };
  }

  // Whether an entry from the bell list is already present (by dedupe key).
  function hasEntry(list, notification) {
    const key = dedupeKey(notification);
    if (!key) return false;
    return (Array.isArray(list) ? list : []).some((e) => e && e.source === 'windows' && `windows:${e.windows && e.windows.notificationId}` === key);
  }

  // Bell rows show one line of body; the full text stays in the entry (and in the AI prompt).
  function bodyPreview(body, max = 120) {
    const one = String(body || '').replace(/\s+/g, ' ').trim();
    return one.length > max ? `${one.slice(0, max - 1)}…` : one;
  }

  // Single-letter avatar for the row: "Slack" → "S", "Windows Security" → "W".
  function appInitial(appName) {
    const s = String(appName || '').trim();
    return s ? s[0].toUpperCase() : '?';
  }

  // The text pasted into a terminal pane when the user clicks "Ask" on a notification: the whole
  // notification quoted verbatim, so the CLI (Claude Code, codex, ...) gets the full context and the
  // user can still edit it before pressing Enter. Nothing is sent anywhere automatically.
  function askPrompt(entry, { lead = 'Here is a notification I just received. Please read it and help me with it.' } = {}) {
    const lines = [lead, '', `App: ${entry.app || ''}`];
    if (entry.title) lines.push(`Title: ${entry.title}`);
    if (entry.body) lines.push('', String(entry.body).trim());
    return lines.join('\n');
  }

  // Notification text is untrusted (any local app can raise a toast). Before it goes into a pty:
  // control characters (ESC, BEL, CR, ...) are always removed, and line breaks survive only when
  // the terminal app has bracketed-paste mode on — otherwise a plain shell would run each line as a
  // command, so the text is flattened onto one line.
  function sanitizeForPaste(text, { multiline = false } = {}) {
    // eslint-disable-next-line no-control-regex
    let out = String(text || '').replace(/[\u0000-\u0008\u000b-\u001f\u007f\u0080-\u009f]/g, '').replace(/\r\n?/g, '\n');
    if (!multiline) out = out.replace(/\t/g, ' ').replace(/\n+/g, ' ');
    return out.trim();
  }

  // After the bridge (re)starts it sends a fresh "existing" snapshot; anything we still hold as
  // active that is missing from it was dismissed while the bridge was down. Returns those ids.
  function missingFromSnapshot(buffer, snapshotIds) {
    const seen = snapshotIds instanceof Set ? snapshotIds : new Set(snapshotIds || []);
    return (Array.isArray(buffer) ? buffer : [])
      .filter((n) => n && n.source === 'windows' && n.event !== 'removed' && !seen.has(n.windowsNotificationId))
      .map((n) => n.windowsNotificationId);
  }

  const notificationCenter = {
    normalizeSystemNotification, detectCategory, dedupeKey, toHistoryEntry, hasEntry, bodyPreview, appInitial, askPrompt, sanitizeForPaste, missingFromSnapshot
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = notificationCenter;
  if (typeof window !== 'undefined') window.notificationCenter = notificationCenter;
})();
