// Terminal pure logic (right-click actions, shell-cwd tracking), separated from the DOM so it can
// be unit-tested. Dependency-injected via `io` (selection/clipboard/pty access). IIFE so nothing
// leaks to the renderer global scope; dual-exported for require() in tests, window.* in the
// renderer, and require() in the main process (shellCdCommand).
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

  // Whether the renderer (rather than the mouse-reporting app) owns a right-click. We own it whenever
  // mouse reporting is off. When it's ON we normally bow out — except for an image on the clipboard,
  // whose paste intent is unambiguous and which the app can't consume through a mouse event anyway,
  // so we still bridge it to the terminal (an image paste, the way Ctrl+V does it).
  function shouldHandleRightClick({ mouseReporting, hasImage }) {
    return !mouseReporting || !!hasImage;
  }

  // Payload of an OSC 7 sequence ("file://<host>/<path>", the shell-integration cwd report) →
  // absolute WSL path, or null when it isn't one. The shells we spawn emit the path raw, but other
  // emitters percent-encode, so decoding is attempted and skipped when it fails. Control characters
  // are rejected because the result is later embedded in a shell command (see shellCdCommand).
  function parseOsc7Cwd(payload) {
    const text = String(payload == null ? '' : payload);
    if (!text.startsWith('file://')) return null;
    let rest = text.slice('file://'.length);
    const slash = rest.indexOf('/');
    if (slash < 0) return null;
    rest = rest.slice(slash); // drop the optional hostname
    let decoded = rest;
    try { decoded = decodeURIComponent(rest); } catch {}
    if (/[\x00-\x1f\x7f]/.test(decoded)) return null;
    return decoded.startsWith('/') ? decoded : null;
  }

  // Best-effort `cd` used to start a split/new terminal in the directory the user is actually in.
  // Empty string when cwd is unusable (caller then just stays at the workspace root); errors are
  // silenced so a directory that vanished falls back to the root instead of failing the launch.
  function shellCdCommand(cwd) {
    if (typeof cwd !== 'string' || !cwd.startsWith('/') || /[\x00-\x1f\x7f]/.test(cwd)) return '';
    return `cd -- '${cwd.replace(/'/g, "'\\''")}' 2>/dev/null`;
  }

  const terminalActions = { terminalRightClick, shouldHandleRightClick, parseOsc7Cwd, shellCdCommand };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = terminalActions;
  }
  if (typeof window !== 'undefined') {
    window.terminalActions = terminalActions;
  }
})();
