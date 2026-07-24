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

  const fileTypes = { isImagePath, imageMimeForPath, extOf, isMarkdownPath, isHtmlPath, isPdfPath };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = fileTypes; // main process: require('./file-types')
  }
  if (typeof window !== 'undefined') {
    window.fileTypes = fileTypes; // renderer: <script src="./file-types.js">
  }
})();
