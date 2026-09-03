// Pure helpers behind the notification center list (the bell dropdown, Windows notifications) and
// the desktop toast that a terminal OSC 9 "waiting for you" report can raise. No DOM / Electron
// here so the rules are unit-testable; renderer.js owns the elements and the Notification API calls.
(function () {
  const MAX_HISTORY = 50;

  // Newest-first list of notifications, bounded so a chatty app can't grow it forever.
  // Every entry gets an increasing id (for click → jump bookkeeping in the UI). Returns a new array.
  function pushNotification(list, entry, max = MAX_HISTORY) {
    const prev = Array.isArray(list) ? list : [];
    const nextId = prev.reduce((n, e) => Math.max(n, Number(e && e.id) || 0), 0) + 1;
    return [{ ...entry, id: nextId }, ...prev].slice(0, Math.max(1, max));
  }

  // A toast only earns its interruption when the user is NOT looking at this workspace: the window
  // is behind another app, minimized, or this tab is hidden behind another tab. A focused, visible
  // pane already shows the in-app badge, so no toast there.
  function shouldToast({ focused = false, visible = true } = {}) {
    return !focused || !visible;
  }

  // Toast title/body: "claude · permission" / "Terminal 2 — nix/wb". `title` falls back to the pane
  // name when the report carried no tool name, so the toast is never blank.
  function toastText({ title = '', paneName = '', workspace = '' } = {}) {
    const head = title || paneName;
    const body = title ? [paneName, workspace].filter(Boolean).join(' — ') : workspace;
    return { title: head, body };
  }

  // HH:MM for the history rows (24h, zero-padded, locale-independent so tests are stable).
  function formatClock(ms) {
    const d = new Date(Number(ms) || 0);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  const notificationLog = { MAX_HISTORY, pushNotification, shouldToast, toastText, formatClock };
  if (typeof module !== 'undefined' && module.exports) module.exports = notificationLog;
  if (typeof window !== 'undefined') window.notificationLog = notificationLog;
})();
