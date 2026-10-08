// Secret key rules shared by the main process (secrets.js) and the renderer's edit dialog: a key
// becomes a file name in WSL, so only [A-Za-z0-9._-], 1–64 characters, and never "." or "..".
(function () {
  const KEY_RE = /^[A-Za-z0-9._-]{1,64}$/;
  function isValidKey(key) {
    return typeof key === 'string' && KEY_RE.test(key) && key !== '.' && key !== '..';
  }
  const secretKeys = { isValidKey };
  if (typeof module !== 'undefined' && module.exports) module.exports = secretKeys;
  if (typeof window !== 'undefined') window.secretKeys = secretKeys;
})();
