// Startup must not touch the filesystem: a disconnected \\wsl.localhost provider can block a
// synchronous stat before Electron creates its first window. Let the renderer validate the saved
// workspace through the asynchronous, time-limited tree IPC instead.
function initialWindowState(settings, fallbackWorkspace) {
  const last = settings && settings.lastWorkspace;
  if (last && last.wslPath) return { workspace: last, showLanding: false };
  return { workspace: fallbackWorkspace, showLanding: true };
}

module.exports = { initialWindowState };
