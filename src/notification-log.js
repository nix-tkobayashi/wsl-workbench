// Pure helpers behind the desktop toast that a terminal OSC 9 "waiting for you" report can raise.
// No DOM / Electron here so the rules are unit-testable; renderer.js owns the Notification API calls.
(function () {
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

  const notificationLog = { shouldToast, toastText };
  if (typeof module !== 'undefined' && module.exports) module.exports = notificationLog;
  if (typeof window !== 'undefined') window.notificationLog = notificationLog;
})();
