// Pure rules behind the unified notification center (issue #73): Windows toasts relayed by the
// notification bridge and terminal OSC 9 reports share one bell list. No DOM / Electron here so
// everything is unit-testable; renderer.js owns the elements, main.js owns the bridge process.
(function () {
  // XML entity decoding for toast payload attributes (launch URIs arrive with &amp;). Unknown
  // entities are left alone rather than guessed.
  function decodeXmlEntities(s) {
    return String(s || '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, code) => {
      if (code[0] === '#') {
        const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
      }
      return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[code] || m;
    });
  }

  // One attribute out of one tag. The payload is machine-written ToastGeneric XML from
  // wpndatabase.db, so attribute regexes are enough (and the main process has no DOMParser).
  function tagAttr(xml, tag, attr) {
    const m = String(xml || '').match(new RegExp(`<${tag}\\b[^>]*?\\s${attr}="([^"]*)"`, 'i'));
    return m ? decodeXmlEntities(m[1]) : '';
  }

  // Raw toast XML → the parts the listener API drops: the activation deep link (launch="...") and
  // the toast header (Slack fills it with the workspace id + name). Empty strings when absent.
  function parseToastPayload(xml) {
    return { launch: tagAttr(xml, 'toast', 'launch'), headerId: tagAttr(xml, 'header', 'id'), headerTitle: tagAttr(xml, 'header', 'title') };
  }

  // Slack's activation URI → structured ids, or null for any other app's link. Shape:
  // slack://channel?id=C013RL7GN8H&message=1788256300.509419&team=T02J67MRB&thread_ts=...
  function parseSlackLaunch(launch) {
    const uri = String(launch || '');
    if (!/^slack:\/\//i.test(uri)) return null;
    const q = uri.indexOf('?');
    const params = {};
    if (q >= 0) {
      for (const pair of uri.slice(q + 1).split('&')) {
        const eq = pair.indexOf('=');
        if (eq <= 0) continue;
        try { params[decodeURIComponent(pair.slice(0, eq))] = decodeURIComponent(pair.slice(eq + 1)); } catch { /* keep other params */ }
      }
    }
    if (!params.team && !params.id) return null;
    return { teamId: String(params.team || ''), channelId: String(params.id || ''), messageTs: String(params.message || ''), threadTs: String(params.thread_ts || '') };
  }

  // A bridge line → SystemNotification (design §10), or null when the line is not a notification
  // we can show. Unknown/extra fields are dropped so the renderer only ever sees this shape. The
  // renderer re-normalizes main's already-normalized broadcast, so the enriched fields (link /
  // workspace / slack) are accepted directly as well as derived from a raw `payload`.
  function normalizeSystemNotification(msg) {
    if (!msg || typeof msg !== 'object' || msg.type !== 'notification') return null;
    const event = ['existing', 'added', 'removed'].includes(msg.event) ? msg.event : null;
    const id = Number(msg.id);
    if (!event || !Number.isFinite(id)) return null;
    const timestamp = Number(msg.timestamp);
    const payload = parseToastPayload(msg.payload);
    const link = String(msg.link || payload.launch || '');
    const rawSlack = msg.slack && typeof msg.slack === 'object' ? msg.slack : parseSlackLaunch(link);
    return {
      source: 'windows',
      event,
      windowsNotificationId: id,
      app: { name: String(msg.app || ''), id: String(msg.appId || '') },
      title: String(msg.title || ''),
      body: String(msg.body || ''),
      timestamp: Number.isFinite(timestamp) && timestamp > 0 ? timestamp : Date.now(),
      link,
      workspace: String(msg.workspace || payload.headerTitle || ''),
      slack: rawSlack ? { teamId: String(rawSlack.teamId || ''), channelId: String(rawSlack.channelId || ''), messageTs: String(rawSlack.messageTs || ''), threadTs: String(rawSlack.threadTs || '') } : null
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
      link: notification.link || '',
      workspace: notification.workspace || '',
      slack: notification.slack || null,
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
    if (entry.workspace) lines.push(`Workspace: ${entry.workspace}`);
    if (entry.title) lines.push(`Title: ${entry.title}`);
    if (entry.link) lines.push(`Link: ${entry.link}`);
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

  // --- Exclusion rules (通知除外設定, issue #75). A rule is up to three fields; every non-empty
  // field must be a case-insensitive substring of the notification's same field for the rule to
  // match, and a notification matching ANY rule never enters the bell list. `title` doubles as the
  // channel filter for Slack, whose toast title is the channel name; `workspace` is the toast
  // header (the Slack workspace name).
  const MAX_EXCLUSIONS = 200;

  function normalizeExclusionRule(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const rule = { app: String(raw.app || '').trim(), workspace: String(raw.workspace || '').trim(), title: String(raw.title || '').trim() };
    return rule.app || rule.workspace || rule.title ? rule : null;
  }

  // Settings value → clean, deduped rule list (bounded, so settings.json can't grow unboundedly).
  function normalizeExclusions(list) {
    const seen = new Set();
    return (Array.isArray(list) ? list : [])
      .map(normalizeExclusionRule)
      .filter((r) => {
        if (!r) return false;
        const key = JSON.stringify([r.app.toLowerCase(), r.workspace.toLowerCase(), r.title.toLowerCase()]);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, MAX_EXCLUSIONS);
  }

  // Rule identity (for delta updates: remove-by-value, not by index): same three fields,
  // case-insensitive. Invalid rules are equal to nothing.
  function sameExclusionRule(a, b) {
    const x = normalizeExclusionRule(a);
    const y = normalizeExclusionRule(b);
    return !!x && !!y
      && x.app.toLowerCase() === y.app.toLowerCase()
      && x.workspace.toLowerCase() === y.workspace.toLowerCase()
      && x.title.toLowerCase() === y.title.toLowerCase();
  }

  function matchesExclusion({ app = '', workspace = '', title = '' } = {}, rule) {
    const r = normalizeExclusionRule(rule);
    if (!r) return false;
    const has = (hay, needle) => !needle || String(hay || '').toLowerCase().includes(needle.toLowerCase());
    return has(app, r.app) && has(workspace, r.workspace) && has(title, r.title);
  }

  function isExcluded(flat, rules) {
    return (Array.isArray(rules) ? rules : []).some((rule) => matchesExclusion(flat, rule));
  }

  // --- Channel → terminal bindings (auto-ask, issue #77). A route ties one Slack channel
  // (teamId + channelId, exact match) to one terminal pane of one app workspace: a new toast from
  // that channel is automatically pasted into that pane as an "Ask" prompt, and — only when the
  // rule opts in AND the pane runs a bracketed-paste CLI — submitted with Enter. One route per
  // channel; routes are created from a live notification (the ids come from its launch URI).
  const MAX_ROUTES = 100;
  const AUTO_ASK_INTERVAL_MS = 60000;

  function normalizeRoute(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const r = {
      teamId: String(raw.teamId || '').trim(),
      channelId: String(raw.channelId || '').trim(),
      workspace: String(raw.workspace || '').trim(), // app workspace key: `${distro}:${wslPath}`
      paneId: String(raw.paneId || '').trim(),       // the pane's bindId — the delivery identity
      pane: String(raw.pane || '').trim(),           // pane display name at bind time (UI only)
      autoSend: raw.autoSend === true,
      workspaceName: String(raw.workspaceName || '').trim(), // Slack workspace, for display only
      channelName: String(raw.channelName || '').trim()      // Slack channel, for display only
    };
    return r.teamId && r.channelId && r.workspace && r.paneId ? r : null;
  }

  function routeChannelKey(route) {
    return route ? `${route.teamId}:${route.channelId}` : '';
  }

  // Settings value → clean route list: one route per channel (first wins), bounded.
  function normalizeRoutes(list) {
    const seen = new Set();
    return (Array.isArray(list) ? list : [])
      .map(normalizeRoute)
      .filter((r) => {
        if (!r) return false;
        const key = routeChannelKey(r);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, MAX_ROUTES);
  }

  function findRoute(routes, slack) {
    if (!slack || !slack.teamId || !slack.channelId) return null;
    return (Array.isArray(routes) ? routes : []).find((r) => r && r.teamId === slack.teamId && r.channelId === slack.channelId) || null;
  }

  // Per-channel throttle so a busy channel can't flood a CLI: a route fires at most once per
  // interval. `lastMs` is the previous firing (undefined for never).
  function autoAskAllowed(lastMs, nowMs, intervalMs = AUTO_ASK_INTERVAL_MS) {
    return !Number.isFinite(lastMs) || nowMs - lastMs >= intervalMs;
  }

  // The app-workspace identity used by routes and session restore alike.
  function workspaceKey(distro, wslPath) {
    return `${String(distro || '')}:${String(wslPath || '')}`;
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
    normalizeSystemNotification, detectCategory, dedupeKey, toHistoryEntry, hasEntry, bodyPreview, appInitial, askPrompt, sanitizeForPaste, missingFromSnapshot,
    parseToastPayload, parseSlackLaunch, normalizeExclusionRule, normalizeExclusions, sameExclusionRule, matchesExclusion, isExcluded, MAX_EXCLUSIONS,
    normalizeRoute, normalizeRoutes, routeChannelKey, findRoute, autoAskAllowed, workspaceKey, MAX_ROUTES, AUTO_ASK_INTERVAL_MS
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = notificationCenter;
  if (typeof window !== 'undefined') window.notificationCenter = notificationCenter;
})();
