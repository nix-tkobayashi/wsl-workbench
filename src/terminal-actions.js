// Terminal right-click action logic, separated from the DOM so it can be unit-tested.
// Dependency-injected via `io` (selection/clipboard/pty access). IIFE so nothing leaks to the
// renderer global scope; dual-exported for require() in tests and window.* in the renderer.
(function () {
  // Right-click: copy the current selection, or (when there's none) paste the clipboard.
  // Returns { action, text } for assertions/telemetry.
  function terminalRightClick(io) {
    if (io.hasSelection()) {
      const text = io.getSelection() || '';
      if (text) io.writeClipboard(text);
      io.clearSelection();
      return { action: 'copy', text };
    }
    const text = io.readClipboard() || '';
    if (text) io.writePty(text);
    return { action: 'paste', text };
  }

  const terminalActions = { terminalRightClick };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = terminalActions;
  }
  if (typeof window !== 'undefined') {
    window.terminalActions = terminalActions;
  }
})();
