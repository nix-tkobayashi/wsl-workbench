// Terminal right-click action logic, separated from the DOM so it can be unit-tested.
// Dependency-injected via `io` (selection/clipboard/pty access). IIFE so nothing leaks to the
// renderer global scope; dual-exported for require() in tests and window.* in the renderer.
(function () {
  // Right-click: copy the current selection, or (when there's none) paste the clipboard.
  // Returns { action, text } for assertions/telemetry.
  function terminalRightClick(io) {
    // Prefer the actual selected text over hasSelection(): xterm reports hasSelection()===false while
    // a mouse-reporting app (e.g. Claude Code) has its selection service disabled, which would send us
    // down the paste path and insert the clipboard on a right-click meant to copy.
    const selection = (io.getSelection && io.getSelection()) || '';
    if (selection || io.hasSelection()) {
      if (selection) io.writeClipboard(selection);
      io.clearSelection();
      return { action: 'copy', text: selection };
    }
    // An image on the clipboard takes priority over text (screenshots carry only an image), so a
    // right-click paste bridges it to the terminal the same way Ctrl+V does.
    if (io.hasImage && io.hasImage()) {
      io.pasteImage();
      return { action: 'paste-image' };
    }
    const text = io.readClipboard() || '';
    if (text) io.paste(text);
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
