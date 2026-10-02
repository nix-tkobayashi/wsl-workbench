// Stage B: the local confirmation page. Shows the WHOLE text that would be typed (scrollable), so
// nothing the user approves is hidden behind a truncated preview. Pure (no Electron) and tested.
//
// Invisible / reordering format characters (Unicode Cf: bidi overrides and isolates, zero-width
// space, BOM, ...) are rendered as visible ⟦U+XXXX⟧ markers in the preview so they can't hide or
// reorder what the user reads. ZERO WIDTH JOINER is kept when it sits between two non-space
// characters (emoji sequences) and marked elsewhere. The page itself has no script access to
// anything: it reports the choice by setting document.title, which main watches.

const APPROVE = '__wswb_approve__';
const CANCEL = '__wswb_cancel__';

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function marker(ch) { return `⟦U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}⟧`; }

// Returns { html, marked } — html is escaped preview markup; marked counts replaced characters.
function visibleText(text) {
  const chars = Array.from(String(text));
  let marked = 0;
  const out = chars.map((ch, i) => {
    if (!/\p{Cf}/u.test(ch)) return escapeHtml(ch);
    if (ch === '‍' && i > 0 && i < chars.length - 1 && !/\s/u.test(chars[i - 1]) && !/\s/u.test(chars[i + 1])) return ch;
    marked++;
    return `<mark>${escapeHtml(marker(ch))}</mark>`;
  });
  return { html: out.join(''), marked };
}

function buildConfirmHtml({ lang = 'en', title, heading, details = [], text = null, note = '', okLabel, cancelLabel, markedNote = '' }) {
  const body = text == null ? null : visibleText(text);
  return `<!doctype html>
<html lang="${escapeHtml(lang)}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; padding:16px; font:13px "Segoe UI", system-ui, sans-serif; background:#1e1e1e; color:#e6e6e6; display:flex; flex-direction:column; height:100vh; box-sizing:border-box; gap:10px; }
  h1 { font-size:15px; margin:0; }
  dl { display:grid; grid-template-columns:max-content 1fr; gap:2px 10px; margin:0; }
  dt { color:#9a9a9a; } dd { margin:0; overflow-wrap:anywhere; }
  pre { flex:1; min-height:80px; overflow:auto; margin:0; padding:8px; background:#111; border:1px solid #444; border-radius:4px; white-space:pre-wrap; overflow-wrap:anywhere; font:13px Consolas, monospace; unicode-bidi:plaintext; }
  mark { background:#7a4b00; color:#fff; }
  .note { color:#ffd479; }
  .buttons { display:flex; justify-content:flex-end; gap:8px; }
  button { padding:6px 14px; font:inherit; border-radius:4px; border:1px solid #555; background:#2d2d2d; color:#e6e6e6; cursor:pointer; }
  button.primary { background:#8a2b1c; border-color:#b33; }
</style></head>
<body>
  <h1>${escapeHtml(heading)}</h1>
  <dl>${details.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join('')}</dl>
  ${body ? `<pre>${body.html}</pre>` : ''}
  ${body && body.marked ? `<div class="note">${escapeHtml(markedNote.replace('{n}', String(body.marked)))}</div>` : ''}
  <div class="note">${escapeHtml(note)}</div>
  <div class="buttons">
    <button id="cancel" autofocus onclick="document.title='${CANCEL}'">${escapeHtml(cancelLabel)}</button>
    <button id="ok" class="primary" onclick="document.title='${APPROVE}'">${escapeHtml(okLabel)}</button>
  </div>
  <script>document.addEventListener('keydown', (e) => { if (e.key === 'Escape') document.title = '${CANCEL}'; });</script>
</body></html>`;
}

module.exports = { buildConfirmHtml, visibleText, escapeHtml, APPROVE, CANCEL };
