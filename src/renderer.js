// Terminals are created per tab (see the terminal-tabs section below), not a single instance.

let config = null;
let selectedPath = null;
const expanded = new Set();
let contextNode = null;
let treeSelection = null; // last-clicked tree node; the target for a clipboard-image paste into the tree

const layout = document.getElementById('layout');
const rightPane = document.getElementById('rightPane');
const editor = document.getElementById('editor');
const editorScroll = document.getElementById('editorScroll');
const editorBackdrop = document.getElementById('editorBackdrop');
const editorGutter = document.getElementById('editorGutter');
const editorMeasure = document.getElementById('editorMeasure');
const imagePreview = document.getElementById('imagePreview');
const editorPreview = document.getElementById('editorPreview');
const previewToggle = document.getElementById('previewToggle');
const wrapToggle = document.getElementById('wrapToggle');
let gutterLineCount = -1;
let previewMode = false; // Markdown preview on/off (applies only while a Markdown file is active)
let wrapMode = localStorage.getItem('editorWrap') === '1'; // soft-wrap long lines in the viewer
let editorRenderedFor = null; // tab path the textarea currently holds; guards undo-destroying rewrites

// Render the line-number gutter (only when the line count changes) and keep the editors' left padding
// matched to its width. Called whenever editor content is loaded or edited.
// Wrap-mode gutter: a logical line can span several visual rows, so the browser wraps each
// candidate line inside the hidden #editorMeasure layer (same metrics/width as the textarea) and
// the gutter gets blank rows after each number to match — numbers stay aligned with the first
// visual row of their line. Short lines that cannot possibly wrap (even if every char were
// fullwidth CJK ~15px) skip measurement, so typical files only measure their long lines.
function renderWrappedGutter() {
  if (!editorPreview.classList.contains('hidden')) { editorGutter.style.display = 'none'; return; }
  const lines = editor.value.split('\n');
  const n = lines.length;
  // Width/padding first (same formula as the unwrapped path): the left padding defines the
  // textarea's content width, which defines where lines wrap — measure only after applying it.
  const width = Math.max(40, String(n).length * 8 + 20);
  const pad = (width + 6) + 'px';
  editorGutter.style.display = '';
  editorGutter.style.width = width + 'px';
  editor.style.paddingLeft = pad;
  editorBackdrop.style.paddingLeft = pad;
  editorMeasure.style.width = editor.clientWidth + 'px';
  editorMeasure.style.paddingLeft = pad;
  editorMeasure.style.paddingRight = '10px';
  const contentWidth = editor.clientWidth - (width + 6) - 10;
  const measured = new Map(); // line index -> measuring div
  const frag = document.createDocumentFragment();
  lines.forEach((line, idx) => {
    const cols = line.includes('\t') ? line.replace(/\t/g, '  ').length : line.length;
    if (cols * 15 <= contentWidth) return; // can't wrap even at max glyph width
    const div = document.createElement('div');
    div.textContent = line;
    frag.appendChild(div);
    measured.set(idx, div);
  });
  editorMeasure.replaceChildren(frag);
  const rowH = parseFloat(getComputedStyle(editorMeasure).lineHeight) || 19;
  const nums = [];
  lines.forEach((line, idx) => {
    nums.push(String(idx + 1));
    const div = measured.get(idx);
    if (!div) return;
    const rows = Math.max(1, Math.round(div.getBoundingClientRect().height / rowH));
    for (let k = 1; k < rows; k++) nums.push('');
  });
  editorGutter.textContent = nums.join('\n');
  editorMeasure.replaceChildren(); // drop the measuring DOM
}

function renderGutter() {
  editorScroll.classList.toggle('wrap', wrapMode);
  if (wrapMode) {
    renderWrappedGutter();
    gutterLineCount = -1; // wrapped row counts change with edits inside a line: always recompute
    syncEditorOverlays();
    return;
  }
  // Don't re-show the gutter over the Markdown preview (showMarkdownPreview hid it; renderGutter
  // runs after it in renderActiveEditor and would otherwise get the final say).
  editorGutter.style.display = editorPreview.classList.contains('hidden') ? '' : 'none';
  const n = editor.value ? (editor.value.match(/\n/g) || []).length + 1 : 1;
  if (n !== gutterLineCount) {
    gutterLineCount = n;
    const nums = new Array(n);
    for (let i = 0; i < n; i++) nums[i] = i + 1;
    editorGutter.textContent = nums.join('\n');
    const width = Math.max(40, String(n).length * 8 + 20);
    editorGutter.style.width = width + 'px';
    const pad = (width + 6) + 'px';
    editor.style.paddingLeft = pad;
    editorBackdrop.style.paddingLeft = pad;
  }
  syncEditorOverlays();
}

// Keep the backdrop (both axes) and the gutter (vertical) aligned with the textarea's scroll position.
function syncEditorOverlays() {
  editorBackdrop.scrollTop = editor.scrollTop;
  editorBackdrop.scrollLeft = editor.scrollLeft;
  editorGutter.scrollTop = editor.scrollTop;
}

const landing = document.getElementById('landing');

const promptModal = document.getElementById('promptModal');
const promptMessage = document.getElementById('promptMessage');
const promptInput = document.getElementById('promptInput');
const promptOk = document.getElementById('promptOk');
const promptCancel = document.getElementById('promptCancel');

// --- i18n ---
let currentLang = 'en';
const t = (key) => window.i18n.t(currentLang, key);

// Apply the current language to all static markup (data-i18n*) and the dynamic editor bits.
function applyLanguage() {
  document.documentElement.lang = currentLang;
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle); });
  // Re-label open terminal tabs in the new language (a custom name, if set, is kept).
  for (const entry of terminals.values()) relabelTermTab(entry);
}

// Promise-based replacement for the unsupported window.prompt() in Electron.
function askPrompt(message, defaultValue = '') {
  return new Promise((resolve) => {
    promptMessage.textContent = message;
    promptInput.value = defaultValue;
    promptModal.classList.remove('hidden');
    promptInput.focus();
    promptInput.select();

    const cleanup = () => {
      promptModal.classList.add('hidden');
      promptOk.removeEventListener('click', onOk);
      promptCancel.removeEventListener('click', onCancel);
      promptModal.removeEventListener('keydown', onKey);
    };
    const onOk = () => { const value = promptInput.value; cleanup(); resolve(value); };
    const onCancel = () => { cleanup(); resolve(null); };
    // Listen on the modal (not just the input) so Enter/Escape work even when a button has focus,
    // and stop propagation so Escape does not also reach the document-level handlers.
    const onKey = (event) => {
      if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); onOk(); }
      else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel(); }
    };

    promptOk.addEventListener('click', onOk);
    promptCancel.addEventListener('click', onCancel);
    promptModal.addEventListener('keydown', onKey);
  });
}

// --- Terminal tabs: multiple terminals per window, each its own pty (keyed by id) ---
const terminals = new Map(); // id -> { id, term, fit, host, tab, exited }
let activeTermId = null;
let nextTermId = 1;
const terminalHost = document.getElementById('terminalHost');
const terminalTabList = document.getElementById('terminalTabList');

function activeTerminal() { return terminals.get(activeTermId) || null; }

function fitTerminal(entry) {
  // Only fit the visible (active) terminal; a hidden host has zero size and would resize the pty wrong.
  if (!entry || entry.id !== activeTermId) return;
  try { entry.fit.fit(); } catch {}
  window.api.terminalResize({ id: entry.id, cols: entry.term.cols, rows: entry.term.rows });
}
function fitActiveTerminal() { fitTerminal(activeTerminal()); }
window.addEventListener('resize', fitActiveTerminal);

function activateTerminal(id) {
  const entry = terminals.get(id);
  if (!entry) return;
  activeTermId = id;
  for (const [tid, e] of terminals) {
    const on = tid === id;
    e.host.style.display = on ? 'block' : 'none';
    e.tab.classList.toggle('active', on);
  }
  setTimeout(() => { fitTerminal(entry); entry.term.focus(); }, 0);
}

// A terminal tab shows its custom name when set, otherwise the localized default "Terminal <id>".
function termTabText(entry) { return entry.name || `${t('terminal.tab')} ${entry.id}`; }

function relabelTermTab(entry) {
  const lbl = entry.tab && entry.tab.querySelector('.term-tab-label');
  if (!lbl) return;
  lbl.textContent = termTabText(entry);
  lbl.title = t('terminal.renameHint');
}

// Double-click a terminal tab to rename it (empty input restores the default name).
async function renameTerminal(entry) {
  const next = await askPrompt(t('prompt.renameTerminal'), termTabText(entry));
  if (next === null) return;
  const trimmed = next.trim();
  // Empty, or unchanged from the localized default, means "no custom name" (keep localizing it).
  entry.name = (!trimmed || trimmed === `${t('terminal.tab')} ${entry.id}`) ? null : trimmed;
  relabelTermTab(entry);
}

function makeTermTab(entry) {
  const tab = document.createElement('div');
  tab.className = 'term-tab';
  const label = document.createElement('span');
  label.className = 'term-tab-label';
  label.textContent = termTabText(entry);
  label.title = t('terminal.renameHint');
  const close = document.createElement('span');
  close.className = 'term-tab-close';
  close.textContent = '×';
  tab.append(label, close);
  tab.addEventListener('mousedown', (event) => {
    if (event.target === close) return;
    activateTerminal(entry.id);
  });
  label.addEventListener('dblclick', (event) => { event.stopPropagation(); renameTerminal(entry); });
  close.addEventListener('click', (event) => { event.stopPropagation(); closeTerminal(entry.id); });
  terminalTabList.appendChild(tab);
  return tab;
}

// Paste a clipboard image into the terminal by pushing it onto the WSL clipboard as PNG, then sending
// Ctrl+V so an AI CLI (e.g. Claude Code) reads it and shows [Image #N]. No file is written to the
// workspace. If WSL lacks wl-copy/xclip (or the Wayland clipboard is unreachable), tell the user.
async function pasteImageToTerminal(entry) {
  if (!entry || !config) return;
  let res = null;
  try {
    res = await window.api.pushImageToWsl({ distro: config.distro });
  } catch (error) {
    alert(error.message || String(error));
    return;
  }
  if (res && res.ok) {
    window.api.terminalWrite({ id: entry.id, data: '\x16' }); // Ctrl+V: the CLI reads the WSL clipboard
    entry.term.focus();
    return;
  }
  alert(t('terminal.imagePasteFailed'));
}

function wireTerminal(entry) {
  const { id, term } = entry;
  term.onData((data) => {
    if (entry.exited) { restartTerminal(entry); return; }
    window.api.terminalWrite({ id, data });
  });
  // Ctrl+C copies selection (else interrupt), Ctrl+V pastes; Ctrl+S is handled by the window handler.
  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown') return true;
    // Shift+Enter inserts a newline like Alt+Enter: send ESC+CR so CLIs (e.g. Claude Code) treat it as a newline, not submit.
    if (event.key === 'Enter' && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
      if (entry.exited) restartTerminal(entry);
      else window.api.terminalWrite({ id, data: '\x1b\r' });
      event.preventDefault();
      return false;
    }
    if (!(event.ctrlKey || event.metaKey)) return true;
    const key = event.key.toLowerCase();
    if (key === 'c') {
      if (event.shiftKey || term.hasSelection()) {
        const sel = term.getSelection();
        if (sel) window.api.clipboardWriteText(sel);
        event.preventDefault();
        return false; // do not also send SIGINT
      }
      return true; // no selection: let Ctrl+C interrupt
    }
    if (key === 'v') {
      event.preventDefault();
      // An image on the clipboard takes priority over text (screenshots carry only an image).
      if (window.api.clipboardHasImage()) {
        pasteImageToTerminal(entry);
      } else {
        const text = window.api.clipboardReadText();
        if (text) term.paste(text); // bracketed paste (see the right-click paste note above)
      }
      return false;
    }
    if (key === 's' && !event.shiftKey) return false; // let window Ctrl+S save; no XOFF
    return true;
  });
  // Right-click copy/paste via mousedown (xterm suppresses contextmenu). Logic in terminal-actions.js.
  const io = {
    hasSelection: () => term.hasSelection(),
    getSelection: () => term.getSelection(),
    clearSelection: () => term.clearSelection(),
    readClipboard: () => window.api.clipboardReadText(),
    writeClipboard: (text) => window.api.clipboardWriteText(text),
    hasImage: () => window.api.clipboardHasImage(),
    pasteImage: () => pasteImageToTerminal(entry),
    // Deliver pasted text through xterm so it goes in as one bracketed paste (writing raw multi-line
    // bytes straight to the pty gets echoed twice by ConPTY / a bracketed-paste TUI).
    paste: (text) => term.paste(text)
  };
  // Capture phase + stopPropagation so xterm never sees the right-click: otherwise, when the app has
  // mouse reporting on (e.g. Claude Code), xterm forwards it as a mouse event that corrupts the paste
  // rendering. Right-click is a terminal paste/copy action, not something the app should receive.
  // When a full-screen app has mouse reporting on (e.g. Claude Code), xterm disables its own text
  // selection and forwards the drag to the app — so the visible highlight is the app's, not xterm's,
  // and there's nothing for us to copy. In that mode our right-click would just paste over the app's
  // selection, so we bow out and let the mouse event reach the app (paste is still on Ctrl+V).
  const mouseReportingActive = () => {
    const xtermEl = entry.host.querySelector('.xterm');
    return !!(xtermEl && xtermEl.classList.contains('enable-mouse-events'));
  };
  entry.host.addEventListener('mousedown', (event) => {
    if (event.button !== 2 || mouseReportingActive()) return;
    event.preventDefault();
    event.stopPropagation();
    const result = window.terminalActions.terminalRightClick(io);
    if (result.action === 'paste') term.focus();
  }, true);
  // Also swallow the matching right-button mouseup so xterm doesn't emit a dangling release report.
  entry.host.addEventListener('mouseup', (event) => {
    if (event.button !== 2 || mouseReportingActive()) return;
    event.preventDefault();
    event.stopPropagation();
  }, true);
  // Suppress xterm's own contextmenu handler (it stages the selection into the hidden textarea, which
  // could leak into the pty). Only when we own the right-click, i.e. mouse reporting is off.
  entry.host.addEventListener('contextmenu', (event) => {
    if (mouseReportingActive()) return;
    event.preventDefault();
    event.stopPropagation();
  }, true);
}

function createTerminal({ command = '' } = {}) {
  if (!config) return null;
  const id = nextTermId++;
  const host = document.createElement('div');
  host.className = 'term-pane';
  terminalHost.appendChild(host);
  const term = new Terminal({ cursorBlink: true, fontFamily: 'Consolas, monospace', fontSize: 13 });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(host);
  const entry = { id, term, fit, host, exited: false, tab: null, name: null };
  entry.tab = makeTermTab(entry);
  terminals.set(id, entry);
  wireTerminal(entry);
  activateTerminal(id);
  window.api.terminalStart({ id, ...config, command });
  setTimeout(() => fitTerminal(entry), 60);
  return entry;
}

// After the shell exits, the pty is gone; any keystroke (or the menu) restarts that tab's shell.
function restartTerminal(entry) {
  if (!entry || !config) return;
  entry.exited = false;
  entry.term.clear();
  window.api.terminalStart({ id: entry.id, ...config, command: '' });
  setTimeout(() => fitTerminal(entry), 200);
}

function closeTerminal(id) {
  const entry = terminals.get(id);
  if (!entry) return;
  window.api.terminalClose({ id });
  entry.term.dispose();
  entry.host.remove();
  entry.tab.remove();
  terminals.delete(id);
  if (activeTermId === id) {
    const next = terminals.keys().next().value;
    if (next != null) activateTerminal(next);
    else { activeTermId = null; createTerminal(); } // always keep at least one terminal
  }
}

function disposeAllTerminals() {
  for (const entry of terminals.values()) {
    window.api.terminalClose({ id: entry.id });
    entry.term.dispose();
    entry.host.remove();
    entry.tab.remove();
  }
  terminals.clear();
  activeTermId = null;
}

window.api.onTerminalData(({ id, data }) => {
  const entry = terminals.get(id);
  if (entry) entry.term.write(data);
});
window.api.onTerminalExit((id) => {
  const entry = terminals.get(id);
  if (!entry) return;
  entry.exited = true;
  entry.term.write(`\r\n\x1b[90m${t('terminal.restartHint')}\x1b[0m\r\n`);
});

document.getElementById('newTerminalBtn').addEventListener('click', () => createTerminal());

// Path of the tree item currently being dragged within the app. This is the authoritative
// internal-origin signal: it is only set during a genuine tree dragstart, so external drags
// (text/URLs/files from other apps) cannot trigger terminal insertion or fs:move.
let currentTreeDragPath = null;

// True when a drag carries external OS files. Must be checked via dataTransfer.types during dragover:
// dataTransfer.files is empty until the actual drop, so testing files.length there wrongly rejects the
// drop (the cursor shows a ✖ and nothing can be dropped).
function isExternalFileDrag(event) {
  return !!event.dataTransfer && Array.from(event.dataTransfer.types || []).includes('Files');
}

// Quote a path for the shell only when it contains characters that need it.
function shellQuotePath(p) {
  if (!p) return p;
  if (/^[\w@%+=:,./-]+$/.test(p)) return p;
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

// --- Editor tabs: multiple open files share one textarea/img; each tab keeps its own state.
// selectedPath is the active tab's path (also used for tree highlight + save). ---
const editorTabs = new Map(); // path -> { path, name, value, dirty, isImage, imageSrc, disabled, el }
const editorTabList = document.getElementById('editorTabList');

function showImagePreview(on) {
  imagePreview.style.display = on ? 'block' : 'none';
  editorScroll.style.display = on ? 'none' : '';
}

function anyEditorDirty() {
  for (const tab of editorTabs.values()) if (tab.dirty) return true;
  return false;
}

function updateEditorTabEl(tab) {
  if (!tab || !tab.el) return;
  tab.el.querySelector('.editor-tab-label').textContent = tab.name;
  // ⚠ (changed on disk with unsaved edits) takes precedence over ● (unsaved).
  tab.el.querySelector('.editor-tab-dirty').textContent = tab.externallyChanged ? '⚠' : (tab.dirty ? '●' : '');
  tab.el.classList.toggle('active', tab.path === selectedPath);
  tab.el.classList.toggle('changed', !!tab.externallyChanged);
  tab.el.title = tab.externallyChanged ? t('editor.externallyChanged') : tab.path;
}
function refreshEditorTabs() { for (const tab of editorTabs.values()) updateEditorTabEl(tab); }

// Keep the active editor tab visible when the tab strip overflows (it scrolls horizontally).
function scrollActiveEditorTabIntoView() {
  const tab = editorTabs.get(selectedPath);
  if (tab && tab.el) tab.el.scrollIntoView({ inline: 'nearest', block: 'nearest' });
}

function setDirty(value) {
  const tab = editorTabs.get(selectedPath);
  if (tab) { tab.dirty = value; updateEditorTabEl(tab); }
}

function highlightTreeRow(path) {
  document.querySelectorAll('#tree .row.selected').forEach((el) => el.classList.remove('selected'));
  if (!path) return;
  const row = document.querySelector(`#tree .row[data-path="${(window.CSS && CSS.escape) ? CSS.escape(path) : path}"]`);
  if (row) row.classList.add('selected');
}

// Persist the live textarea content into the active tab before switching away from it.
function persistActiveEditor() {
  const tab = editorTabs.get(selectedPath);
  if (tab && !tab.isImage && !tab.disabled) tab.value = editor.value;
}

// A live, editable Markdown file can be previewed.
function activeTabIsMarkdown() {
  const tab = editorTabs.get(selectedPath);
  return !!(tab && !tab.isImage && !tab.disabled && window.fileTypes.isMarkdownPath(tab.path));
}

// Swap the editor area between the textarea (+gutter/backdrop) and the rendered Markdown preview.
function showMarkdownPreview(on) {
  editorPreview.classList.toggle('hidden', !on);
  editor.style.display = on ? 'none' : '';
  editorGutter.style.display = on ? 'none' : '';
  editorBackdrop.style.display = on ? 'none' : '';
  if (on) { editorPreview.innerHTML = window.markdown.render(editor.value); editorPreview.scrollTop = 0; }
}

// Load the active tab into the shared editor/image view (or blank when no tab is open).
function renderActiveEditor() {
  const tab = editorTabs.get(selectedPath);
  if (!tab) {
    showImagePreview(false);
    imagePreview.removeAttribute('src');
    editor.value = '';
    editorRenderedFor = null;
    editor.disabled = false;
    showMarkdownPreview(false);
    previewToggle.classList.add('hidden');
    wrapToggle.classList.add('hidden');
    refreshEditorTabs();
    renderGutter();
    syncFindToActiveEditor();
    return;
  }
  if (tab.isImage) {
    showImagePreview(true);
    if (tab.imageSrc) imagePreview.src = tab.imageSrc; else imagePreview.removeAttribute('src');
    editor.disabled = false;
    showMarkdownPreview(false);
    previewToggle.classList.add('hidden');
    wrapToggle.classList.add('hidden');
  } else {
    showImagePreview(false);
    imagePreview.removeAttribute('src');
    // Rewrite the textarea only when it holds a different tab or stale content: assigning .value
    // clears the browser's undo stack, so a same-tab re-render (preview toggle, tab strip updates)
    // must leave it untouched to keep Ctrl+Z working.
    const nextValue = tab.value || '';
    if (editorRenderedFor !== tab.path || editor.value !== nextValue) {
      editor.value = nextValue;
      editorRenderedFor = tab.path;
    }
    editor.disabled = !!tab.disabled;
    wrapToggle.classList.toggle('hidden', !!tab.disabled);
    wrapToggle.classList.toggle('active', wrapMode);
    const isMd = activeTabIsMarkdown();
    previewToggle.classList.toggle('hidden', !isMd);
    const showPreview = previewMode && isMd;
    previewToggle.classList.toggle('active', showPreview);
    previewToggle.textContent = showPreview ? t('editor.edit') : t('editor.preview');
    showMarkdownPreview(showPreview);
  }
  refreshEditorTabs();
  scrollActiveEditorTabIntoView();
  renderGutter();
  syncFindToActiveEditor();
}

function makeEditorTabEl(tab) {
  const el = document.createElement('div');
  el.className = 'editor-tab';
  const label = document.createElement('span');
  label.className = 'editor-tab-label';
  label.textContent = tab.name;
  label.title = tab.path;
  const dirty = document.createElement('span');
  dirty.className = 'editor-tab-dirty';
  const close = document.createElement('span');
  close.className = 'editor-tab-close';
  close.textContent = '×';
  el.append(label, dirty, close);
  el.addEventListener('mousedown', async (event) => {
    if (event.target === close) return;
    activateEditorTab(tab.path);
    const current = editorTabs.get(tab.path);
    if (current && current.externallyChanged) await promptReloadIfNeeded(current);
  });
  close.addEventListener('click', (event) => { event.stopPropagation(); closeEditorTab(tab.path); });
  editorTabList.appendChild(el);
  return el;
}

function activateEditorTab(path) {
  if (path === selectedPath) return;
  persistActiveEditor();
  selectedPath = path;
  renderActiveEditor();
  highlightTreeRow(path);
  scheduleSessionSave();
}

// --- Editor session: remember which files are open (and which is active) per workspace, so
// reopening the workspace restores them. Saves are debounced and keyed/captured at schedule time,
// so a save can't record one workspace's tabs under another's key if the workspace switches before
// the timer fires. disposeAllEditorTabs deliberately does NOT save: clearing tabs on a workspace
// switch must not wipe the outgoing workspace's stored session.
let sessionSaveTimer = null;
let sessionSavePending = null; // the payload the debounce timer will write ({ key, tabs, active })
// Counter, not a boolean: a workspace switch can start restore B while restore A is still winding
// down, and A's exit must not unsuppress saves while B is mid-restore.
let restoringSessionDepth = 0;
function sessionKey() { return config ? `${config.distro}:${config.wslPath}` : null; }
function flushSessionSave() {
  clearTimeout(sessionSaveTimer);
  sessionSaveTimer = null;
  if (sessionSavePending) window.api.sessionSave(sessionSavePending);
  sessionSavePending = null;
}
function scheduleSessionSave() {
  if (!config || restoringSessionDepth > 0) return;
  const key = sessionKey();
  // A pending save for a DIFFERENT workspace must be written out, not debounce-cancelled — else
  // switching workspaces within the debounce window drops the outgoing workspace's last tab state.
  if (sessionSavePending && sessionSavePending.key !== key) flushSessionSave();
  sessionSavePending = { key, tabs: [...editorTabs.keys()], active: selectedPath };
  clearTimeout(sessionSaveTimer);
  sessionSaveTimer = setTimeout(flushSessionSave, 300);
}
async function restoreEditorSession() {
  const cfg = config;
  if (!cfg) return;
  let saved = null;
  try { saved = await window.api.sessionGet({ key: `${cfg.distro}:${cfg.wslPath}` }); } catch { return; }
  if (!saved || !Array.isArray(saved.tabs) || !saved.tabs.length) return;
  restoringSessionDepth++; // the opens below must not re-save the half-restored state
  try {
    for (const p of saved.tabs) {
      if (config !== cfg) return; // workspace switched mid-restore; stop opening old tabs
      if (typeof p !== 'string' || editorTabs.has(p)) continue;
      let st = null;
      try { st = await window.api.statFile({ distro: cfg.distro, wslPath: p }); } catch { continue; }
      // Re-check after the await: a switch during statFile must not open an old-workspace path
      // via openFileInEditor, which reads the (now new) global config.
      if (config !== cfg) return;
      if (!st) continue; // deleted since the last session
      await openFileInEditor({ path: p, type: 'file' });
    }
    if (config === cfg && typeof saved.active === 'string' && editorTabs.has(saved.active)) {
      activateEditorTab(saved.active);
    }
  } finally {
    restoringSessionDepth--;
  }
  if (config === cfg) scheduleSessionSave(); // normalize the stored list (drops now-missing files)
}

// Open a file in a tab (or activate its existing tab). Replaces the old single-file loadFile.
async function openFileInEditor(node) {
  if (editorTabs.has(node.path)) { activateEditorTab(node.path); return; }
  persistActiveEditor(); // save the previously active tab before switching
  // Register and activate synchronously (read-only while loading) so a second open of the same
  // file activates this tab instead of creating a duplicate, and edits can't be lost mid-load.
  const tab = { path: node.path, name: basenameFor(node.path), value: '', dirty: false, isImage: false, imageSrc: null, disabled: true, el: null, mtimeMs: null, size: null, externallyChanged: false };
  tab.el = makeEditorTabEl(tab);
  editorTabs.set(node.path, tab);
  selectedPath = node.path;
  renderActiveEditor();
  highlightTreeRow(node.path);

  // Snapshot the workspace for ALL reads below: a workspace switch mid-open must not make a later
  // read resolve the old path against the NEW distro (the switch also disposes this tab, and the
  // final render below is already guarded, so the loaded bytes are simply discarded).
  const cfg = config;
  let disabled = false;
  if (window.fileTypes.isImagePath(node.path)) {
    try { tab.imageSrc = await window.api.readImage({ distro: cfg.distro, wslPath: node.path }); tab.isImage = true; }
    catch (error) { tab.value = String(error.message || error); disabled = true; }
  } else {
    try {
      // Fingerprint BEFORE reading: if the file changes during the read, the baseline stays older
      // than disk so the next poll re-detects and reloads (never records new mtime with stale text).
      const st = await window.api.statFile({ distro: cfg.distro, wslPath: node.path });
      tab.value = await window.api.readFile({ distro: cfg.distro, wslPath: node.path });
      if (st) { tab.mtimeMs = st.mtimeMs; tab.size = st.size; }
    } catch (error) { tab.value = String(error.message || error); disabled = true; }
  }
  tab.disabled = disabled; // editable once loaded (unless the read failed)
  if (editorTabs.get(node.path) === tab && selectedPath === node.path) renderActiveEditor();
  scheduleSessionSave();
}

function closeEditorTab(path) {
  const tab = editorTabs.get(path);
  if (!tab) return;
  if (tab.dirty && !confirm(t('confirm.discardChanges'))) return;
  tab.el.remove();
  editorTabs.delete(path);
  if (selectedPath === path) {
    selectedPath = [...editorTabs.keys()].pop() || null;
    renderActiveEditor();
    highlightTreeRow(selectedPath);
  }
  scheduleSessionSave();
}

function disposeAllEditorTabs() {
  for (const tab of editorTabs.values()) tab.el.remove();
  editorTabs.clear();
  selectedPath = null;
  renderActiveEditor();
}

// Close tabs for a deleted path (and descendants) — no dirty prompt, the file is gone.
function closeEditorTabsUnder(targetPath) {
  let activeClosed = false;
  for (const p of [...editorTabs.keys()]) {
    if (p === targetPath || p.startsWith(targetPath + '/')) {
      editorTabs.get(p).el.remove();
      editorTabs.delete(p);
      if (p === selectedPath) activeClosed = true;
    }
  }
  if (activeClosed) {
    selectedPath = [...editorTabs.keys()].pop() || null;
    renderActiveEditor();
    highlightTreeRow(selectedPath);
  }
  scheduleSessionSave();
}

// Re-key tabs after a rename/move (file or directory): oldPath prefix -> newPath.
function retargetEditorTabs(oldPath, newPath) {
  for (const [p, tab] of [...editorTabs.entries()]) {
    if (p === oldPath || p.startsWith(oldPath + '/')) {
      const np = newPath + p.slice(oldPath.length);
      editorTabs.delete(p);
      tab.path = np;
      tab.name = basenameFor(np);
      const label = tab.el.querySelector('.editor-tab-label');
      label.textContent = tab.name;
      label.title = np;
      editorTabs.set(np, tab);
      if (selectedPath === p) selectedPath = np;
      if (editorRenderedFor === p) editorRenderedFor = np; // renamed, not new content: keep undo intact
    }
  }
  scheduleSessionSave();
  // Keep the tree's expanded state in sync so a renamed/moved directory stays open and the
  // active descendant row still renders (and gets re-highlighted) after renderTree().
  for (const p of [...expanded]) {
    if (p === oldPath || p.startsWith(oldPath + '/')) {
      expanded.delete(p);
      expanded.add(newPath + p.slice(oldPath.length));
    }
  }
  refreshEditorTabs();
}

editor.addEventListener('input', () => {
  if (editorTabs.get(selectedPath)) setDirty(true);
  renderGutter();             // line count may have changed
  refreshFind(false);         // keep match list/count current while typing in the editor
});

// Ctrl+S saves the active tab; Ctrl+F opens find, Ctrl+H find+replace (none use Shift). Save Workspace
// is Ctrl+Shift+S. Find/replace only opens when the editor (not the terminal) holds focus.
window.addEventListener('keydown', (event) => {
  const ctrl = event.ctrlKey || event.metaKey;
  if (!ctrl && event.key === 'F3') {
    if (!findWidget.classList.contains('hidden') && editorHasFocusForFind()) { event.preventDefault(); selectFindMatch(findIndex + (event.shiftKey ? -1 : 1)); }
    return;
  }
  if (!ctrl || event.shiftKey) return;
  const key = event.key.toLowerCase();
  if (key === 's') { event.preventDefault(); saveCurrentFile(); }
  else if (key === 'f') { if (editorHasFocusForFind()) { event.preventDefault(); openFind(false); } }
  else if (key === 'h') { if (editorHasFocusForFind()) { event.preventDefault(); openFind(true); } }
});

async function saveCurrentFile() {
  const tab = editorTabs.get(selectedPath);
  // Skip when there's no editable text buffer: no tab, an image, or an error/read-failure view.
  if (!tab || !config || tab.isImage || tab.disabled) return;
  try {
    const res = await window.api.writeFile({ distro: config.distro, wslPath: tab.path, content: editor.value });
    tab.value = editor.value;
    if (res) { tab.mtimeMs = res.mtimeMs; tab.size = res.size; } // our own write is the new baseline
    tab.externallyChanged = false;
    setDirty(false); // also repaints the tab (clears any ⚠ marker)
  } catch (error) {
    alert(error.message || String(error));
  }
}

// Replace the textarea's whole content as a single *undoable* edit (select-all + insertText), so a
// disk reload doesn't wipe the undo stack — Ctrl+Z can restore what the buffer held before it.
// Falls back to a plain .value assignment (undo is lost, content is right) when insertText is
// unavailable, e.g. while the textarea is hidden behind the Markdown preview.
function replaceEditorValuePreservingUndo(next) {
  const prevFocus = document.activeElement;
  editor.focus();
  // insertText targets document.activeElement; if focus didn't land on the editor (hidden, etc.),
  // aborting to the fallback keeps us from typing into whatever IS focused (e.g. the terminal).
  if (document.activeElement !== editor) {
    editor.value = next;
  } else {
    editor.select();
    let ok = false;
    try { ok = next ? document.execCommand('insertText', false, next) : document.execCommand('delete'); }
    catch { ok = false; }
    if (!ok || editor.value !== next) editor.value = next;
  }
  if (prevFocus && prevFocus !== editor && typeof prevFocus.focus === 'function') prevFocus.focus();
}

// Re-read a tab from disk, discarding in-memory edits, and refresh the view if it's active. `force`
// (a user-confirmed reload) overrides the guard that protects edits made during the async read.
async function reloadTabFromDisk(tab, { force = false } = {}) {
  if (!config) return;
  const cfgAtStart = config;
  try {
    const st = await window.api.statFile({ distro: cfgAtStart.distro, wslPath: tab.path });
    const content = await window.api.readFile({ distro: cfgAtStart.distro, wslPath: tab.path });
    if (config !== cfgAtStart || !editorTabs.has(tab.path)) return; // workspace switched / tab closed
    // The user may have started typing during the async read; don't silently clobber that (a forced
    // reload from the explicit confirm is allowed to). Leave it flagged so they can reload on click.
    if (!force && tab.dirty) { tab.externallyChanged = true; updateEditorTabEl(tab); return; }
    tab.value = content;
    if (st) { tab.mtimeMs = st.mtimeMs; tab.size = st.size; }
    // Active tab: swap the buffer as one undoable edit BEFORE renderActiveEditor — it then sees
    // editor.value === tab.value and leaves the textarea (and its undo stack) alone. The insertText
    // fires the 'input' listener (setDirty(true)), so dirty is cleared after, not before.
    if (tab.path === selectedPath && !tab.isImage && editorRenderedFor === tab.path) {
      replaceEditorValuePreservingUndo(content);
    }
    tab.dirty = false;
    tab.externallyChanged = false;
    if (tab.path === selectedPath) renderActiveEditor();
    updateEditorTabEl(tab);
  } catch (error) {
    if (force) alert(error.message || String(error)); // background auto-reloads shouldn't spam alerts
  }
}

// When a tab flagged as changed-on-disk (with unsaved edits) is clicked, offer to reload or keep.
async function promptReloadIfNeeded(tab) {
  if (!tab || !tab.externallyChanged) return;
  if (confirm(t('confirm.reloadExternal'))) {
    await reloadTabFromDisk(tab, { force: true });
  } else {
    tab.externallyChanged = false; // keep the user's edits; stop flagging
    updateEditorTabEl(tab);
  }
}

// Poll open text tabs for on-disk changes (e.g. an AI CLI edited the file). Clean tabs reload
// silently; tabs with unsaved edits are flagged (⚠) and reloaded only if the user confirms on click.
let checkingExternal = false;
async function checkExternalChanges() {
  if (checkingExternal || !config || document.hidden) return;
  checkingExternal = true;
  const cfgAtStart = config;
  try {
    for (const tab of [...editorTabs.values()]) {
      if (tab.isImage || tab.disabled || tab.mtimeMs == null) continue;
      let st;
      try { st = await window.api.statFile({ distro: cfgAtStart.distro, wslPath: tab.path }); } catch { continue; }
      if (config !== cfgAtStart) return; // workspace switched mid-poll
      if (!editorTabs.has(tab.path) || !st) continue; // closed, or deleted/unreadable — leave as is
      if (st.mtimeMs === tab.mtimeMs && st.size === tab.size) continue; // unchanged
      if (tab.dirty) {
        tab.mtimeMs = st.mtimeMs; tab.size = st.size; // advance baseline so we flag once per change
        tab.externallyChanged = true;
        updateEditorTabEl(tab);
      } else {
        await reloadTabFromDisk(tab); // no unsaved edits: safe to refresh in place
      }
    }
  } finally {
    checkingExternal = false;
  }
}

// --- Find & replace in the file viewer (operates on the active editor textarea) ---
const findWidget = document.getElementById('findWidget');
const findInput = document.getElementById('findInput');
const replaceInput = document.getElementById('replaceInput');
const findCount = document.getElementById('findCount');
const findCaseBtn = document.getElementById('findCase');
const findToggleReplaceBtn = document.getElementById('findToggleReplace');
const replaceOneBtn = document.getElementById('replaceOne');
const replaceAllBtn = document.getElementById('replaceAll');
let findMatches = [];
let findIndex = -1;
let findCaseSensitive = false;
let findMarkEls = [];      // the rendered <mark> elements, one per match (rebuilt only when matches change)
let findCurrentEl = null;  // the <mark> currently marked .current

// An editable text tab must be active (not an image, not a read-only/error view).
function editorIsTextEditable() {
  const tab = editorTabs.get(selectedPath);
  return !!(tab && !tab.isImage && !tab.disabled);
}
// Open find via Ctrl+F/H only when the editor (or its already-open find widget) holds focus — not the
// terminal (which uses ^F/^H) or the tree. The user clicks into the file to search it.
function editorHasFocusForFind() {
  if (!editorIsTextEditable()) return false;
  const active = document.activeElement;
  return active === editor || findWidget.contains(active);
}

function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Match the (literal, escaped) query against the original text so offsets stay aligned — case-insensitive
// matching via a regex flag, not toLowerCase(), which can change length for some Unicode characters.
function computeFindMatches() {
  findMatches = [];
  const q = findInput.value;
  if (!q || !editorIsTextEditable()) { findIndex = -1; return; }
  const re = new RegExp(escapeRegExp(q), findCaseSensitive ? 'g' : 'gi');
  const text = editor.value;
  let m;
  while ((m = re.exec(text)) !== null) {
    findMatches.push({ start: m.index, end: m.index + m[0].length });
    if (re.lastIndex === m.index) re.lastIndex++; // defensive: never stall on a zero-width match
  }
  if (findIndex >= findMatches.length) findIndex = findMatches.length - 1;
}

function escapeHtml(s) { return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

// Rebuild the backdrop's highlight spans from the current match set. This O(text) work runs only when
// the match set changes (query/content edit) — not on plain next/previous navigation.
function renderFindHighlights() {
  findCurrentEl = null;
  findMarkEls = [];
  if (findWidget.classList.contains('hidden') || !findMatches.length) { editorBackdrop.textContent = ''; return; }
  const text = editor.value;
  let html = '';
  let last = 0;
  for (const m of findMatches) {
    html += escapeHtml(text.slice(last, m.start)) + '<mark>' + escapeHtml(text.slice(m.start, m.end)) + '</mark>';
    last = m.end;
  }
  html += escapeHtml(text.slice(last));
  // A textarea reserves a final empty line after a trailing newline, but a <div> with white-space:pre
  // does not — append a space so the backdrop's height (and thus scroll range) matches the textarea,
  // otherwise highlights drift one line down when scrolled to the bottom.
  editorBackdrop.innerHTML = html + ' ';
  findMarkEls = editorBackdrop.getElementsByTagName('mark');
  setCurrentMark();
  syncEditorOverlays();
}

// Move the `.current` emphasis to findMarkEls[findIndex] — O(1), used for next/previous navigation.
function setCurrentMark() {
  if (findCurrentEl) findCurrentEl.classList.remove('current');
  findCurrentEl = (findIndex >= 0 && findMarkEls[findIndex]) || null;
  if (findCurrentEl) findCurrentEl.classList.add('current');
}

function updateFindCount() {
  if (!findInput.value) findCount.textContent = '';
  else if (!findMatches.length) findCount.textContent = t('find.noResults');
  else findCount.textContent = `${findIndex + 1}/${findMatches.length}`;
  const canReplace = editorIsTextEditable() && findMatches.length > 0;
  replaceOneBtn.disabled = !canReplace;
  replaceAllBtn.disabled = !canReplace;
}

// Scroll the textarea so the current match is in view (both axes), using the rendered mark's geometry.
function scrollEditorToCurrentMark() {
  const el = findCurrentEl;
  if (!el) return;
  const h = el.offsetHeight || 18;
  if (el.offsetTop < editor.scrollTop || el.offsetTop + h > editor.scrollTop + editor.clientHeight) {
    editor.scrollTop = Math.max(0, el.offsetTop - editor.clientHeight / 2);
  }
  if (el.offsetLeft < editor.scrollLeft || el.offsetLeft + el.offsetWidth > editor.scrollLeft + editor.clientWidth) {
    editor.scrollLeft = Math.max(0, el.offsetLeft - editor.clientWidth / 2);
  }
  syncEditorOverlays();
}

// Make the i-th match current and scroll it into view. Focus stays in the find box; the backdrop
// highlight is visible regardless of focus, so this needs no text selection.
function selectFindMatch(i) {
  if (!findMatches.length) { updateFindCount(); return; }
  findIndex = ((i % findMatches.length) + findMatches.length) % findMatches.length;
  setCurrentMark();
  scrollEditorToCurrentMark();
  updateFindCount();
}

// Recompute matches and repaint highlights; when `jump`, move to the first match at/after the caret.
function refreshFind(jump) {
  if (findWidget.classList.contains('hidden')) return;
  const caret = editor.selectionStart || 0;
  computeFindMatches();
  renderFindHighlights();
  if (!findMatches.length) { findIndex = -1; updateFindCount(); return; }
  if (jump) {
    const idx = findMatches.findIndex((m) => m.start >= caret);
    selectFindMatch(idx === -1 ? 0 : idx);
  } else {
    if (findIndex < 0) findIndex = 0;
    setCurrentMark();
    updateFindCount();
  }
}

function syncFindToActiveEditor() {
  if (findWidget.classList.contains('hidden')) return;
  if (editorIsTextEditable()) refreshFind(false); else closeFind();
}

// Show/hide the replace row (the chevron toggle and Ctrl+H both drive this).
function setReplaceVisible(on) {
  findWidget.classList.toggle('with-replace', on);
  findToggleReplaceBtn.setAttribute('aria-expanded', String(on));
}

function openFind(withReplace) {
  if (!editorIsTextEditable()) return;
  findWidget.classList.remove('hidden');
  setReplaceVisible(!!withReplace);
  const sel = editor.value.substring(editor.selectionStart, editor.selectionEnd);
  if (sel && !sel.includes('\n')) findInput.value = sel;
  findInput.focus();
  findInput.select();
  refreshFind(true);
}

function closeFind() {
  findWidget.classList.add('hidden');
  editorBackdrop.textContent = ''; // remove highlights
  findMarkEls = [];
  findCurrentEl = null;
  if (editorIsTextEditable()) editor.focus();
}

// Replace [start,end) in the textarea as an undoable edit (selection + insertText/delete); falls
// back to rebuilding .value (which loses undo) if the command is unavailable.
function replaceEditorRangePreservingUndo(start, end, text) {
  const prevFocus = document.activeElement;
  editor.focus();
  let ok = false;
  if (document.activeElement === editor) {
    editor.setSelectionRange(start, end);
    try { ok = text ? document.execCommand('insertText', false, text) : document.execCommand('delete'); }
    catch { ok = false; }
  }
  if (!ok) editor.value = editor.value.slice(0, start) + text + editor.value.slice(end);
  if (prevFocus && prevFocus !== editor && typeof prevFocus.focus === 'function') prevFocus.focus();
}

function replaceCurrentMatch() {
  if (!editorIsTextEditable() || !findMatches.length) return;
  const m = findMatches[findIndex] || findMatches[0];
  const rep = replaceInput.value;
  replaceEditorRangePreservingUndo(m.start, m.end, rep);
  setDirty(true);
  renderGutter();
  const caretAfter = m.start + rep.length;
  computeFindMatches();
  renderFindHighlights();
  if (!findMatches.length) { findIndex = -1; setCurrentMark(); updateFindCount(); return; }
  const idx = findMatches.findIndex((x) => x.start >= caretAfter);
  selectFindMatch(idx === -1 ? 0 : idx);
}

function replaceAllMatches() {
  if (!editorIsTextEditable()) return;
  computeFindMatches();
  if (!findMatches.length) return;
  const rep = replaceInput.value;
  let v = editor.value;
  for (let i = findMatches.length - 1; i >= 0; i--) v = v.slice(0, findMatches[i].start) + rep + v.slice(findMatches[i].end);
  replaceEditorValuePreservingUndo(v); // one undoable edit for the whole replace-all
  setDirty(true);
  renderGutter();
  // The replacement text may itself contain the search string; show/select any remaining matches.
  findIndex = -1;
  computeFindMatches();
  renderFindHighlights();
  if (findMatches.length) selectFindMatch(0); else updateFindCount();
}

editor.addEventListener('scroll', syncEditorOverlays);
// Wrapping depends on the editor's width, so pane/window resizes must re-measure the wrap-mode
// gutter (rAF-throttled: ResizeObserver fires every frame during a resizer drag).
let gutterResizeQueued = false;
new ResizeObserver(() => {
  if (!wrapMode || gutterResizeQueued) return;
  gutterResizeQueued = true;
  requestAnimationFrame(() => { gutterResizeQueued = false; if (wrapMode) renderGutter(); });
}).observe(editorScroll);
findInput.addEventListener('input', () => refreshFind(true));
findCaseBtn.addEventListener('click', () => {
  findCaseSensitive = !findCaseSensitive;
  findCaseBtn.classList.toggle('active', findCaseSensitive);
  findCaseBtn.setAttribute('aria-pressed', String(findCaseSensitive));
  refreshFind(true);
});
findToggleReplaceBtn.addEventListener('click', () => {
  setReplaceVisible(!findWidget.classList.contains('with-replace'));
  findInput.focus();
});
document.getElementById('findNext').addEventListener('click', () => selectFindMatch(findIndex + 1));
document.getElementById('findPrev').addEventListener('click', () => selectFindMatch(findIndex - 1));
document.getElementById('findClose').addEventListener('click', closeFind);
replaceOneBtn.addEventListener('click', replaceCurrentMatch);
replaceAllBtn.addEventListener('click', replaceAllMatches);
findInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') { event.preventDefault(); selectFindMatch(findIndex + (event.shiftKey ? -1 : 1)); }
  else if (event.key === 'Escape') { event.preventDefault(); closeFind(); }
});
replaceInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') { event.preventDefault(); replaceCurrentMatch(); }
  else if (event.key === 'Escape') { event.preventDefault(); closeFind(); }
});


function parentDirFor(node) {
  return node.type === 'directory' ? node.path : node.path.split('/').slice(0, -1).join('/') || '/';
}

function basenameFor(wslPath) {
  return wslPath.split('/').filter(Boolean).pop() || wslPath;
}

// The last two path segments (parent/leaf), e.g. "richka/aws-infra"; falls back to fewer when the
// path is shallow. Used for the toolbar title so sibling workspaces with the same leaf are told apart.
function lastTwoSegmentsFor(wslPath) {
  const parts = wslPath.split('/').filter(Boolean);
  return parts.slice(-2).join('/') || wslPath;
}

// Toolbar title: the active workspace's parent/leaf directory in brackets (e.g. "[richka/aws-infra]"),
// or blank when no workspace is open.
function updateWorkspaceName() {
  document.getElementById('workspaceName').textContent = config ? `[${lastTwoSegmentsFor(config.wslPath)}]` : '';
}

// Show the workspace's current git branch (⎇ name, plus * when dirty) in the tree header, or hide the
// badge when it isn't a git repo. Re-run on an interval since branch/dirtiness change via the terminal.
let updatingGitBranch = false;
async function updateGitBranch() {
  const badge = document.getElementById('gitBranch');
  if (!badge) return;
  if (!config) { badge.classList.add('hidden'); return; }
  if (updatingGitBranch) return;
  updatingGitBranch = true;
  const cfgAtStart = config;
  try {
    const info = await window.api.gitInfo({ distro: cfgAtStart.distro, wslPath: cfgAtStart.wslPath });
    if (config !== cfgAtStart) return; // workspace switched mid-call
    if (info && info.branch) {
      badge.textContent = `⎇ ${info.branch}${info.dirty ? ' *' : ''}`;
      badge.title = info.branch + (info.dirty ? ' (uncommitted changes)' : '');
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  } catch {
    badge.classList.add('hidden');
  } finally {
    updatingGitBranch = false;
  }
}

function showContextMenu(event, node) {
  event.preventDefault();
  event.stopPropagation();
  contextNode = node;
  document.querySelectorAll('.row.selected').forEach((el) => el.classList.remove('selected'));
  event.currentTarget.classList.add('selected');
  const menu = document.getElementById('contextMenu');
  // The workspace root has no row; its menu offers create/reveal but not rename/delete.
  const isRoot = !!config && node.path === config.wslPath;
  menu.querySelector('[data-action="rename"]').style.display = isRoot ? 'none' : '';
  menu.querySelector('[data-action="delete"]').style.display = isRoot ? 'none' : '';
  document.getElementById('ctxSepEdit').style.display = isRoot ? 'none' : '';
  menu.classList.remove('hidden');
  const x = Math.min(event.clientX, window.innerWidth - menu.offsetWidth - 8);
  const y = Math.min(event.clientY, window.innerHeight - menu.offsetHeight - 8);
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
}

function hideContextMenu() {
  document.getElementById('contextMenu').classList.add('hidden');
}

async function handleContextAction(action) {
  if (!contextNode) return;
  const node = contextNode;
  try {
    if (action === 'new-file' || action === 'new-folder') {
      const parentDirPath = parentDirFor(node);
      const type = action === 'new-folder' ? 'directory' : 'file';
      const defaultName = type === 'directory' ? 'new-folder' : 'new-file.txt';
      const name = await askPrompt(type === 'directory' ? t('prompt.newFolderName') : t('prompt.newFileName'), defaultName);
      if (!name) return;
      await window.api.createFsItem({ distro: config.distro, parentDirPath, name, type });
      expanded.add(parentDirPath);
      await renderTree();
      return;
    }

    if (action === 'rename') {
      const currentName = basenameFor(node.path);
      const newName = await askPrompt(t('prompt.newName'), currentName);
      if (!newName || newName === currentName) return;
      const result = await window.api.renameFsItem({ distro: config.distro, sourcePath: node.path, newName });
      retargetEditorTabs(node.path, result.path); // update any open tabs for the renamed file/dir
      await renderTree();
      return;
    }

    if (action === 'delete') {
      const message = node.type === 'directory' ? t('confirm.deleteDir') : t('confirm.deleteFile');
      if (!confirm(`${message}\n\n${node.path}`)) return;
      await window.api.deleteFsItem({ distro: config.distro, targetPath: node.path });
      closeEditorTabsUnder(node.path);
      await renderTree();
      return;
    }

    if (action === 'reveal') {
      await window.api.revealInExplorer({ distro: config.distro, targetPath: node.path });
      return;
    }

    if (action === 'open-new-window') {
      const workspacePath = node.type === 'directory' ? node.path : parentDirFor(node);
      await window.api.newWindow({ distro: config.distro, wslPath: workspacePath });
      return;
    }
  } catch (error) {
    alert(error.message || String(error));
  } finally {
    hideContextMenu();
  }
}

function rowFor(node) {
  const row = document.createElement('div');
  row.className = 'row';
  row.draggable = true;
  row.dataset.path = node.path;
  row.dataset.type = node.type;
  if (node.path === selectedPath) row.classList.add('selected');

  const twisty = document.createElement('span');
  twisty.className = 'twisty';
  twisty.textContent = node.type === 'directory' ? (expanded.has(node.path) ? '▾' : '▸') : '';

  const icon = document.createElement('span');
  icon.className = 'icon';
  icon.textContent = node.type === 'directory' ? '📁' : '📄';

  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = node.name;
  name.title = node.path;

  row.append(twisty, icon, name);

  row.addEventListener('click', async (event) => {
    event.stopPropagation();
    setTreePasteTarget(node); // remember the paste target (clipboard-image paste saves next to it)
    if (node.type === 'directory') {
      toggle(node.path);
    } else {
      await openFileInEditor(node); // opens/activates a tab and updates the tree highlight
    }
  });

  row.addEventListener('contextmenu', (event) => showContextMenu(event, node));

  twisty.addEventListener('click', (event) => {
    event.stopPropagation(); // suppresses the row click, so update the paste target here too
    if (node.type === 'directory') { setTreePasteTarget(node); toggle(node.path); }
  });

  row.addEventListener('dragstart', (event) => {
    currentTreeDragPath = node.path;
    event.dataTransfer.setData('text/plain', node.path);
    // 'copyMove' lets the tree accept it as a move and the terminal accept it as a path insert.
    event.dataTransfer.effectAllowed = 'copyMove';
  });
  row.addEventListener('dragend', () => { currentTreeDragPath = null; });

  row.addEventListener('dragover', (event) => {
    if (node.type !== 'directory') return;
    event.preventDefault();
    event.dataTransfer.dropEffect = isExternalFileDrag(event) ? 'copy' : 'move';
    row.classList.add('drag-over');
  });
  row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
  row.addEventListener('drop', async (event) => {
    event.preventDefault();
    event.stopPropagation(); // a drop handled by a row must not also bubble to the root drop target
    row.classList.remove('drag-over');
    if (node.type !== 'directory') return;

    const externalFiles = Array.from(event.dataTransfer.files || []);
    if (externalFiles.length > 0) {
      const sourcePaths = externalFiles
        .map((file) => window.api.getPathForFile(file))
        .filter(Boolean);
      if (sourcePaths.length === 0) return;
      try {
        await window.api.copyExternal({ distro: config.distro, sourcePaths, targetDirPath: node.path });
        expanded.add(node.path);
        await renderTree();
      } catch (error) {
        alert(error.message || String(error));
      }
      return;
    }

    const sourcePath = currentTreeDragPath;
    if (!sourcePath || sourcePath === node.path) return;
    try {
      await window.api.move({ distro: config.distro, sourcePath, targetDirPath: node.path });
      expanded.add(node.path);
      retargetEditorTabs(sourcePath, `${node.path}/${basenameFor(sourcePath)}`);
      await renderTree();
    } catch (error) {
      alert(error.message || String(error));
    }
  });

  return row;
}

async function buildNode(node, cfg, depth = 0) {
  const wrapper = document.createElement('div');
  wrapper.className = 'tree-node';
  wrapper.appendChild(rowFor(node));

  if (node.type === 'directory') {
    const children = document.createElement('div');
    children.className = `children ${expanded.has(node.path) ? 'open' : ''}`;
    if (expanded.has(node.path)) {
      try {
        const tree = await window.api.readTree({ distro: cfg.distro, wslPath: node.path });
        for (const child of tree.children) children.appendChild(await buildNode(child, cfg, depth + 1));
      } catch (error) {
        const err = document.createElement('div');
        err.className = 'row';
        err.textContent = error.message || String(error);
        children.appendChild(err);
      }
    }
    wrapper.appendChild(children);
  }
  return wrapper;
}

async function renderTree() {
  if (!config) return; // no active workspace (landing screen)
  const myGen = ++renderGeneration;
  const cfg = config; // snapshot: stay consistent even if the workspace switches mid-render
  const tree = document.getElementById('tree');
  const prevScroll = tree.scrollTop;
  // Read and build into a detached node first; touch the live DOM only at the end.
  const root = await window.api.readTree(cfg);
  // Keep the root open so its children build; skip if the workspace already switched
  // (cfg===config is checked synchronously, so this never re-adds a stale root path).
  if (cfg === config) expanded.add(root.path);
  // Render the workspace root's children directly; the root row itself is omitted since the
  // toolbar breadcrumb already shows the workspace path. Dropping onto empty tree space moves
  // an item to the workspace root (see initTreeRootDropTarget).
  const fragment = document.createDocumentFragment();
  for (const child of root.children) {
    fragment.appendChild(await buildNode(child, cfg));
  }
  if (myGen !== renderGeneration) return; // a newer render started; let it publish instead
  tree.innerHTML = '';
  tree.appendChild(fragment);
  tree.scrollTop = prevScroll;
  const cwdEl = document.getElementById('cwd');
  const cwdText = `${cfg.distro}:${cfg.wslPath}`;
  document.getElementById('cwdPath').textContent = cwdText;
  cwdEl.title = cwdText;
  updateWorkspaceName();
  updateGitBranch();
  // Invalidate the poll baseline so a just-rendered state is not re-detected as a change.
  lastTreeSignature = null;
}

async function toggle(wslPath) {
  if (expanded.has(wslPath)) expanded.delete(wslPath); else expanded.add(wslPath);
  await renderTree();
}

async function applyWorkspace(nextConfig) {
  if (anyEditorDirty() && !confirm(t('confirm.discardChanges'))) {
    // Main already committed the new workspace; put it back in sync with what we still show.
    if (config) window.api.resyncWorkspace({ workspace: config, showLanding: false });
    return;
  }
  // Snapshot config/expanded so we can roll back if the new workspace fails to load. Editor tabs
  // and terminals are only disposed AFTER a successful render, so no editor snapshot is needed.
  const prevConfig = config;
  const prevExpanded = new Set(expanded);
  config = nextConfig;
  setTreePasteTarget(null); // reset the paste target to the new workspace root
  expanded.clear();
  expanded.add(config.wslPath);
  try {
    await renderTree(); // builds detached and publishes only on success; landing stays as a loading cover
  } catch (error) {
    alert(error.message || String(error));
    // Roll back: the live tree/CWD/editor tabs were never replaced.
    config = prevConfig;
    expanded.clear();
    for (const p of prevExpanded) expanded.add(p);
    if (prevConfig) {
      window.api.resyncWorkspace({ workspace: prevConfig, showLanding: false });
    } else {
      landing.classList.remove('hidden');
      updateWorkspaceName();
      renderLandingRecent();
      window.api.resyncWorkspace({ showLanding: true });
    }
    return;
  }
  landing.classList.add('hidden');
  disposeAllEditorTabs(); // close the previous workspace's editor tabs
  disposeAllTerminals();  // close the previous workspace's terminals, open one fresh
  createTerminal();
  restoreEditorSession(); // reopen the files that were open here last time (async, best-effort)
}

function initResizers() {
  const vertical = document.getElementById('verticalResizer');
  const horizontal = document.getElementById('horizontalResizer');

  vertical.addEventListener('mousedown', (event) => {
    event.preventDefault();
    const onMove = (moveEvent) => {
      const width = Math.max(180, Math.min(700, moveEvent.clientX));
      layout.style.gridTemplateColumns = `${width}px 2px 1fr`;
      fitActiveTerminal();
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });

  horizontal.addEventListener('mousedown', (event) => {
    event.preventDefault();
    const onMove = (moveEvent) => {
      const rect = rightPane.getBoundingClientRect();
      const topHeight = Math.max(120, Math.min(rect.height - 140, moveEvent.clientY - rect.top));
      rightPane.style.gridTemplateRows = `${topHeight}px 2px 1fr`;
      fitActiveTerminal();
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });
}


document.addEventListener('click', hideContextMenu);
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') hideContextMenu(); });
document.getElementById('contextMenu').addEventListener('click', async (event) => {
  event.stopPropagation();
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  await handleContextAction(button.dataset.action);
});

// Right-clicking empty tree-pane space targets the workspace root (rows stop propagation and
// show their own menu). This is the only way to create a file/folder at the root now that the
// root row is omitted.
document.getElementById('treePane').addEventListener('contextmenu', (event) => {
  if (!config || event.target.closest('.row')) return;
  const rootName = config.wslPath.split('/').filter(Boolean).pop() || config.wslPath;
  showContextMenu(event, { path: config.wslPath, type: 'directory', name: rootName });
});

// Toolbar menu buttons pop the real application submenus (the native menu bar is hidden to save
// vertical space). data-menu maps to the app menu's top-level order.
function initMenubar() {
  document.querySelectorAll('#menubar .menubtn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const rect = btn.getBoundingClientRect();
      window.api.popupMenu({ index: Number(btn.dataset.menu), x: rect.left, y: rect.bottom });
    });
  });
}

// Markdown preview: the toolbar toggle flips edit/preview for the active Markdown file, and links in
// the rendered preview open in the default browser (never navigate the app window).
function initEditorPreview() {
  previewToggle.addEventListener('click', () => {
    persistActiveEditor(); // keep unsaved edits: copy the live textarea into the tab before re-rendering
    previewMode = !previewMode;
    renderActiveEditor();
  });
  // Word-wrap toggle: purely visual (soft wrap), persisted across sessions.
  wrapToggle.addEventListener('click', () => {
    wrapMode = !wrapMode;
    localStorage.setItem('editorWrap', wrapMode ? '1' : '0');
    wrapToggle.classList.toggle('active', wrapMode);
    renderGutter();
  });
  editorPreview.addEventListener('click', (event) => {
    const anchor = event.target.closest('a');
    if (!anchor) return;
    event.preventDefault();
    const href = anchor.getAttribute('href') || '';
    if (/^https?:\/\//i.test(href)) window.api.openExternal(href);
  });
}

// Landing screen: the two buttons trigger the same main-process dialogs as the Workspace menu.
// On success the main process sends 'workspace:changed', which applyWorkspace() handles (and hides the screen).
function initLanding() {
  document.getElementById('landingOpenWorkspace').addEventListener('click', () => window.api.openWorkspace());
  document.getElementById('landingOpenFile').addEventListener('click', () => window.api.openWorkspaceFile());
  document.getElementById('landingClone').addEventListener('click', cloneRepoFlow);
}

// Populate the landing screen's recent-workspaces list (hidden when there are none).
// Clicking an entry opens it exactly like the dialogs do (main broadcasts workspace:changed).
async function renderLandingRecent() {
  const box = document.getElementById('landingRecent');
  const list = document.getElementById('landingRecentList');
  let items = [];
  try { items = await window.api.recentWorkspaces(); } catch { items = []; }
  list.textContent = '';
  box.classList.toggle('hidden', !items.length);
  for (const item of items) {
    const btn = document.createElement('button');
    btn.className = 'landing-recent-item';
    btn.textContent = `${item.distro}:${item.wslPath}`;
    btn.title = btn.textContent;
    btn.addEventListener('click', async () => {
      try {
        await window.api.openRecentWorkspace(item);
      } catch (error) {
        alert(error.message || String(error));
        renderLandingRecent(); // e.g. the directory disappeared; refresh the list
      }
    });
    list.appendChild(btn);
  }
}

// Landing "Clone Repository": ask for a Git URL, pick the destination parent folder, then clone. On
// success the main process broadcasts workspace:changed → applyWorkspace() opens it and hides landing.
async function cloneRepoFlow() {
  const url = await askPrompt(t('prompt.cloneUrl'), '');
  if (!url || !url.trim()) return;
  const folder = await window.api.pickFolder(); // { distro, wslPath } destination parent, or null
  if (!folder) return;

  const subtitle = document.querySelector('#landing .landing-subtitle');
  const buttons = document.querySelectorAll('#landing .landing-actions button');
  const prevSubtitle = subtitle ? subtitle.textContent : '';
  if (subtitle) subtitle.textContent = t('landing.cloning');
  buttons.forEach((b) => { b.disabled = true; });
  try {
    await window.api.cloneRepo({ distro: folder.distro, parentDirPath: folder.wslPath, url: url.trim() });
  } catch (error) {
    alert(error.message || String(error));
  } finally {
    if (subtitle) subtitle.textContent = prevSubtitle;
    buttons.forEach((b) => { b.disabled = false; });
  }
}

// Dropping onto empty tree-pane space targets the workspace root: internal drags move there,
// external files are copied in. Row drops are handled by the rows themselves (and stop
// propagation), so this only fires for empty space — it replaces the move/copy-to-root target
// the (now omitted) root row used to provide. Attached to #treePane (not #tree) because #tree
// only spans its rendered rows; the empty area below is the pane.
function initTreeRootDropTarget() {
  const pane = document.getElementById('treePane');
  pane.addEventListener('dragover', (event) => {
    if (!config) return;
    // Over a row: that row owns the affordance. Also drop the pane highlight so it can't stick on
    // when the drag crosses from empty space onto a row (a row drop won't reach the pane handler).
    if (event.target.closest('.row')) { pane.classList.remove('drag-over'); return; }
    const external = isExternalFileDrag(event);
    if (!currentTreeDragPath && !external) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = external ? 'copy' : 'move';
    pane.classList.add('drag-over'); // highlight the whole pane: the drop targets the workspace root
  });
  pane.addEventListener('dragleave', (event) => {
    if (pane.contains(event.relatedTarget)) return; // ignore moves between children inside the pane
    pane.classList.remove('drag-over');
  });
  pane.addEventListener('drop', async (event) => {
    pane.classList.remove('drag-over');
    if (!config || event.target.closest('.row')) return;
    const rootPath = config.wslPath;

    const externalFiles = Array.from(event.dataTransfer.files || []);
    if (externalFiles.length > 0) {
      event.preventDefault();
      const sourcePaths = externalFiles.map((file) => window.api.getPathForFile(file)).filter(Boolean);
      if (sourcePaths.length === 0) return;
      try {
        await window.api.copyExternal({ distro: config.distro, sourcePaths, targetDirPath: rootPath });
        await renderTree();
      } catch (error) {
        alert(error.message || String(error));
      }
      return;
    }

    if (!currentTreeDragPath) return;
    event.preventDefault();
    const sourcePath = currentTreeDragPath;
    const sourceParent = sourcePath.split('/').slice(0, -1).join('/') || '/';
    if (sourceParent === rootPath) return; // already directly under the workspace root
    try {
      await window.api.move({ distro: config.distro, sourcePath, targetDirPath: rootPath });
      retargetEditorTabs(sourcePath, `${rootPath}/${basenameFor(sourcePath)}`);
      await renderTree();
    } catch (error) {
      alert(error.message || String(error));
    }
  });
}

// Set the folder a clipboard-image paste in the tree targets. `null` means the workspace root (the
// top directory has no row of its own); the path header (#cwd) is marked so the target is visible.
function setTreePasteTarget(node) {
  treeSelection = node;
  const cwdEl = document.getElementById('cwd');
  if (cwdEl) cwdEl.classList.toggle('paste-target', !node);
}

// The directory a clipboard-image paste in the tree should be saved into: the last-clicked node's
// folder (its own path if it's a directory, else its parent), falling back to the workspace root.
function treePasteTargetDir() {
  if (treeSelection) return parentDirFor(treeSelection);
  return config ? config.wslPath : null;
}

// Ctrl+V in the tree pane: if the clipboard holds an image, save it as a PNG into the target folder
// and refresh. (#treePane is focusable via tabindex so it receives the paste event.) Text pastes are
// left alone — there's no text-paste action in the tree.
function initTreePasteTarget() {
  const pane = document.getElementById('treePane');
  // Clicking empty tree space or the path header targets the workspace root (its rows do their own
  // selection and stopPropagation, so this only fires off-row) — the way to paste into the top dir.
  pane.addEventListener('click', (event) => {
    if (event.target.closest('.row')) return;
    setTreePasteTarget(null);
  });
  pane.addEventListener('paste', async (event) => {
    if (!config || !window.api.clipboardHasImage()) return;
    event.preventDefault();
    const targetDirPath = treePasteTargetDir();
    if (!targetDirPath) return;
    try {
      const saved = await window.api.saveClipboardImage({ distro: config.distro, targetDirPath });
      expanded.add(targetDirPath);
      await renderTree();
      highlightTreeRow(saved.path);
    } catch (error) {
      alert(error.message || String(error));
    }
  });
}

// Dropping a tree file/directory onto the terminal inserts its WSL path at the prompt,
// so the AI CLI can pick it up.
function initTerminalDropTarget() {
  const terminalPane = document.getElementById('terminalPane');

  terminalPane.addEventListener('dragover', (event) => {
    // Only react to genuine internal tree drags, never to external text/URL/file drags.
    if (!currentTreeDragPath) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    terminalPane.classList.add('drag-over');
  });
  terminalPane.addEventListener('dragleave', (event) => {
    // Ignore moves between child elements inside the pane to avoid highlight flicker.
    if (terminalPane.contains(event.relatedTarget)) return;
    terminalPane.classList.remove('drag-over');
  });
  terminalPane.addEventListener('drop', (event) => {
    terminalPane.classList.remove('drag-over');
    if (!currentTreeDragPath) return;
    const entry = activeTerminal();
    if (!entry) return;
    event.preventDefault();
    entry.term.paste(shellQuotePath(currentTreeDragPath) + ' '); // insert via bracketed paste, like the clipboard paste
    entry.term.focus();
  });
}

// Periodically refresh the tree so changes made outside the app (e.g. files created from the
// terminal) appear without a manual Refresh. Polls a cheap signature and re-renders only on change.
let lastTreeSignature = null;
let pollingTree = false;
let renderGeneration = 0;

function treeInteractionBusy() {
  return currentTreeDragPath !== null
    || !document.getElementById('contextMenu').classList.contains('hidden')
    || !promptModal.classList.contains('hidden');
}

async function pollTreeChanges() {
  if (pollingTree || !config || document.hidden || treeInteractionBusy()) return;
  pollingTree = true;
  const configAtStart = config;
  const genAtStart = renderGeneration;
  try {
    let signature;
    try {
      signature = await window.api.treeSignature({ distro: configAtStart.distro, paths: Array.from(expanded) });
    } catch {
      return;
    }
    if (config !== configAtStart) return; // workspace switched mid-poll; let the next tick resync
    if (lastTreeSignature !== null && signature !== lastTreeSignature) {
      await renderTree();
    }
    // Trust this signature as the baseline only if no render (poll- or app-initiated) intervened;
    // otherwise force a fresh recompute next tick so we never store a stale baseline.
    lastTreeSignature = (renderGeneration === genAtStart) ? signature : null;
  } finally {
    pollingTree = false;
  }
}

window.api.onMenuRefreshTree(() => renderTree());
window.api.onMenuRestartTerminal(() => restartTerminal(activeTerminal()));
window.api.onLangChanged((lang) => {
  currentLang = window.i18n.normalizeLang(lang);
  applyLanguage();
});
window.api.onWorkspaceChanged(async (nextConfig) => {
  await applyWorkspace(nextConfig);
});

// Custom window controls (frameless window).
const winMaxBtn = document.getElementById('winMax');
document.getElementById('winMin').addEventListener('click', () => window.api.windowMinimize());
winMaxBtn.addEventListener('click', () => window.api.windowToggleMaximize());
document.getElementById('winClose').addEventListener('click', () => window.api.windowClose());
window.api.onWindowMaximized((isMax) => {
  winMaxBtn.innerHTML = isMax ? '&#xE923;' : '&#xE922;'; // restore (overlapping squares) : maximize (single square)
  winMaxBtn.setAttribute('aria-label', isMax ? 'Restore' : 'Maximize');
});

// One-click update: main streams the installer download, then launches it and quits.
const updateModal = document.getElementById('updateModal');
const updateMessage = document.getElementById('updateMessage');
const updateBarFill = document.getElementById('updateBarFill');
const updatePercent = document.getElementById('updatePercent');
const toMB = (bytes) => (bytes / (1024 * 1024)).toFixed(1);
window.api.onUpdateProgress((p) => {
  if (p.phase === 'error') { updateModal.classList.add('hidden'); return; }
  updateModal.classList.remove('hidden');
  if (p.phase === 'launching') {
    updateMessage.textContent = t('update.installing');
    updateBarFill.classList.remove('indeterminate');
    updateBarFill.style.width = '100%';
    updatePercent.textContent = '';
    return;
  }
  // phase === 'download'
  updateMessage.textContent = t('update.downloading');
  if (p.total > 0) {
    const pct = Math.min(100, Math.round((p.received / p.total) * 100));
    updateBarFill.classList.remove('indeterminate');
    updateBarFill.style.width = pct + '%';
    updatePercent.textContent = `${pct}%  (${toMB(p.received)} / ${toMB(p.total)} MB)`;
  } else {
    updateBarFill.classList.add('indeterminate');
    updateBarFill.style.width = '';
    updatePercent.textContent = p.received > 0 ? `${toMB(p.received)} MB` : '';
  }
});

document.getElementById('claudeBtn').addEventListener('click', () => {
  if (!config) return;
  // Resolve claude exactly as the user's own interactive shell does: run inside `bash -ic` so
  // ~/.bashrc (nvm/fnm/etc.) is sourced — otherwise the non-interactive `bash -lc` the terminal
  // uses misses nvm and would pick an old /usr/local/bin/claude. Still exclude the Windows claude
  // exposed under /mnt by WSL PATH interop, and fail loudly if no WSL claude is found.
  // The not-found message is embedded in double quotes inside the single-quoted bash body.
  // Enforce shell-safety for ANY translation: drop chars that would break the single-quote or
  // trigger expansion ('`$), and escape double quotes.
  const notFound = t('claude.notFound')
    .replace(/['`$]/g, '')   // drop chars that break the single-quoted bash body / trigger expansion
    .replace(/\\/g, '\\\\')  // escape backslashes before quotes so the quote-escapes survive
    .replace(/"/g, '\\"');   // escape double quotes (message sits inside echo "...")
  const startClaude = `bash -ic 'c=$(type -aP claude | grep -v "^/mnt/" | head -n1); if [ -n "$c" ]; then "$c" --dangerously-skip-permissions; else echo "${notFound}"; fi'`;
  createTerminal({ command: startClaude }); // open Claude in a new terminal tab
});

(async function init() {
  // One-time wiring that does not depend on a chosen workspace. pollTreeChanges no-ops while config is null.
  initResizers();
  initTerminalDropTarget();
  initTreeRootDropTarget();
  initTreePasteTarget();
  initLanding();
  initMenubar();
  initEditorPreview();
  setInterval(pollTreeChanges, 1500);
  setInterval(checkExternalChanges, 2000); // reload open files edited on disk (e.g. by the AI CLI)
  setInterval(updateGitBranch, 4000);      // keep the tree-header branch badge current
  window.addEventListener('focus', () => { checkExternalChanges(); updateGitBranch(); });

  const initial = await window.api.getConfig();
  currentLang = window.i18n.normalizeLang(initial.lang);
  applyLanguage();
  if (initial.showLanding) {
    config = null; // no active workspace yet; the landing screen drives the next step
    landing.classList.remove('hidden');
    updateWorkspaceName();
    renderLandingRecent();
    return;
  }
  landing.classList.add('hidden');
  config = initial;
  expanded.add(config.wslPath);
  await renderTree();
  createTerminal();
  restoreEditorSession(); // reopen this workspace's files from the last session
})();
