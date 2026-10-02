// The local "enter API key" window for the tunnel-client runtime key. Pure (no Electron) and tested.
// The value never goes through the page title or the URL: the sandboxed preload
// (key-input-preload.js) hands it to main over a one-shot IPC message, and the field is cleared.

const { escapeHtml } = require('./confirm-page');

function buildKeyInputHtml({ lang = 'en', title, heading, note = '', placeholder = '', okLabel, cancelLabel }) {
  return `<!doctype html>
<html lang="${escapeHtml(lang)}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; padding:16px; font:13px "Segoe UI", system-ui, sans-serif; background:#1e1e1e; color:#e6e6e6; display:flex; flex-direction:column; gap:10px; }
  h1 { font-size:15px; margin:0; }
  .note { color:#ffd479; white-space:pre-wrap; }
  input { padding:6px 8px; font:13px Consolas, monospace; background:#111; color:#e6e6e6; border:1px solid #555; border-radius:4px; }
  .buttons { display:flex; justify-content:flex-end; gap:8px; }
  button { padding:6px 14px; font:inherit; border-radius:4px; border:1px solid #555; background:#2d2d2d; color:#e6e6e6; cursor:pointer; }
  button.primary { background:#0e639c; border-color:#1177bb; }
</style></head>
<body>
  <h1>${escapeHtml(heading)}</h1>
  <div class="note">${escapeHtml(note)}</div>
  <form id="f">
    <input id="key" type="password" autocomplete="off" spellcheck="false" placeholder="${escapeHtml(placeholder)}" style="width:100%;box-sizing:border-box" autofocus>
  </form>
  <div class="buttons">
    <button id="cancel" type="button">${escapeHtml(cancelLabel)}</button>
    <button id="ok" type="submit" form="f" class="primary">${escapeHtml(okLabel)}</button>
  </div>
  <script>
    const field = document.getElementById('key');
    document.getElementById('f').addEventListener('submit', (e) => {
      e.preventDefault();
      const value = field.value;
      field.value = '';
      window.keyInput.submit(value);
    });
    document.getElementById('cancel').addEventListener('click', () => { field.value = ''; window.keyInput.cancel(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { field.value = ''; window.keyInput.cancel(); } });
  </script>
</body></html>`;
}

module.exports = { buildKeyInputHtml };
