// File-type helpers shared by the main process (require) and the renderer (window.fileTypes).
// Wrapped in an IIFE so nothing leaks into the renderer's global scope (see i18n.js for the
// `window.api` collision lesson). Pure string logic — no filesystem access.
(function () {
  const IMAGE_MIME = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.avif': 'image/avif'
  };

  // Lowercased extension (incl. dot) of a path, handling both / and \ separators.
  function extOf(p) {
    const base = String(p || '').split(/[\\/]/).pop() || '';
    const i = base.lastIndexOf('.');
    return i > 0 ? base.slice(i).toLowerCase() : '';
  }

  function isImagePath(p) {
    return Object.prototype.hasOwnProperty.call(IMAGE_MIME, extOf(p));
  }

  function imageMimeForPath(p) {
    return IMAGE_MIME[extOf(p)] || 'application/octet-stream';
  }

  function isMarkdownPath(p) {
    const ext = extOf(p);
    return ext === '.md' || ext === '.markdown';
  }

  function isHtmlPath(p) {
    const ext = extOf(p);
    return ext === '.html' || ext === '.htm';
  }

  function isPdfPath(p) {
    return extOf(p) === '.pdf';
  }

  // "Can this be shown as text?" sniffed from the head of a file (issue #79) — never from the
  // extension alone (a `.zip` that is really text is text; a `.txt` full of NULs is not). Binary
  // when the sample holds a NUL byte, is mostly control characters, or is not valid UTF-8 (the
  // editor decodes as UTF-8, so Shift_JIS / Latin-1 would only render as mojibake). Tabs, line
  // breaks, form feed, backspace and ESC (ANSI logs) are ordinary text controls.
  const TEXT_SAMPLE_BYTES = 8192;
  const TEXT_CONTROL_BYTES = new Set([0x08, 0x09, 0x0a, 0x0c, 0x0d, 0x1b]);

  function looksBinary(bytes, sampleBytes = TEXT_SAMPLE_BYTES) {
    const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    const head = buf.subarray(0, Math.max(0, sampleBytes));
    if (!head.length) return false;
    let control = 0;
    for (const b of head) {
      if (b === 0) return true;
      if (b < 0x20 && !TEXT_CONTROL_BYTES.has(b)) control++;
    }
    if (control / head.length > 0.1) return true;
    // Strict UTF-8. A truncated sample may end inside a multi-byte sequence, so it is decoded in
    // streaming mode: the decoder holds an unfinished-but-valid tail back instead of rejecting it,
    // while anything that can never become valid (0xFF, a stray continuation byte, an overlong or
    // surrogate / out-of-range prefix such as E0 80 or ED A0) still throws.
    try { new TextDecoder('utf-8', { fatal: true }).decode(head, { stream: head.length < buf.length }); return false; }
    catch { return true; }
  }

  const fileTypes = { isImagePath, imageMimeForPath, extOf, isMarkdownPath, isHtmlPath, isPdfPath, looksBinary, TEXT_SAMPLE_BYTES };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = fileTypes; // main process: require('./file-types')
  }
  if (typeof window !== 'undefined') {
    window.fileTypes = fileTypes; // renderer: <script src="./file-types.js">
  }
})();
