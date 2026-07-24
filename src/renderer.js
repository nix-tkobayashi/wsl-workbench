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
  // Re-label open terminal tabs in the new language (custom pane names, if set, are kept).
  for (const group of termGroups.values()) renderTermTab(group);
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

// --- Terminal tabs & splits: each tab is a GROUP of 1..MAX_PANES side-by-side terminal panes.
// Every pane has its own pty in the main process (keyed by pane id; IPC is unchanged). ---
const terminals = new Map();  // pane id -> { id, groupId, term, fit, host, divider, exited }
const termGroups = new Map(); // group id -> { id, name, tab, container, paneIds, activePaneId }
let activeGroupId = null;
let nextTermId = 1;
let nextGroupId = 1;
const MAX_PANES = 3;
const terminalHost = document.getElementById('terminalHost');
const terminalTabList = document.getElementById('terminalTabList');

function activeGroup() { return termGroups.get(activeGroupId) || null; }

// The pane terminal actions target (menu restart, tree-path drop, image paste):
// the focused pane of the active tab.
function activeTerminal() {
  const group = activeGroup();
  return group ? terminals.get(group.activePaneId) || null : null;
}

function fitPane(entry) {
  // Only fit a visible pane; a hidden/zero-size host would resize the pty wrong.
  if (!entry || !entry.host.clientWidth) return;
  try { entry.fit.fit(); } catch {}
  window.api.terminalResize({ id: entry.id, cols: entry.term.cols, rows: entry.term.rows });
}
function fitGroupPanes(group) { if (group) for (const pid of group.paneIds) fitPane(terminals.get(pid)); }
function fitActiveTerminal() { fitGroupPanes(activeGroup()); }
window.addEventListener('resize', fitActiveTerminal);

function activateTerminal(groupId) {
  const group = termGroups.get(groupId);
  if (!group) return;
  activeGroupId = groupId;
  for (const [gid, g] of termGroups) {
    const on = gid === groupId;
    g.container.style.display = on ? 'flex' : 'none';
    g.tab.classList.toggle('active', on);
  }
  setTimeout(() => {
    fitGroupPanes(group);
    const focus = terminals.get(group.activePaneId);
    if (focus) focus.term.focus();
  }, 0);
}

// Show per-pane close buttons and the focused-pane outline only when a group is actually split.
function refreshPaneChrome(group) {
  const multi = group.paneIds.length > 1;
  for (const pid of group.paneIds) {
    const e = terminals.get(pid);
    if (!e) continue;
    e.host.classList.toggle('focused', multi && pid === group.activePaneId);
    const btn = e.host.querySelector('.term-pane-close');
    if (btn) btn.style.display = multi ? '' : 'none';
  }
}

// Move the focused mark between existing segments IN PLACE: a focus change must not rebuild the
// segment nodes, or the second click of a double-click lands on a replaced element and the rename
// dblclick never fires.
function refreshTabSegmentFocus(group) {
  const label = group.tab && group.tab.querySelector('.term-tab-label');
  if (!label) return;
  const multi = group.paneIds.length > 1;
  for (const el of label.querySelectorAll('.term-tab-seg')) {
    el.classList.toggle('focused', multi && Number(el.dataset.paneId) === group.activePaneId);
  }
}

function setActivePane(group, paneId) {
  if (group.activePaneId === paneId) return;
  group.activePaneId = paneId;
  refreshPaneChrome(group);
  refreshTabSegmentFocus(group);
}

// Every PANE has its own name (Cursor-style): custom when set, else localized "Terminal <pane id>".
function paneTabText(entry) { return entry.name || `${t('terminal.tab')} ${entry.id}`; }

// Rebuild a tab's label: one clickable segment per pane, so split panes stay individually
// selectable and renameable. Called whenever panes are added/closed/renamed/refocused and on
// language change.
function renderTermTab(group) {
  const label = group.tab && group.tab.querySelector('.term-tab-label');
  if (!label) return;
  label.textContent = '';
  const segments = window.terminalActions.buildTabSegments({
    panes: group.paneIds.map((pid) => ({ id: pid, name: (terminals.get(pid) || {}).name || null })),
    activePaneId: group.activePaneId,
    defaultWord: t('terminal.tab')
  });
  segments.forEach((seg, i) => {
    if (i > 0) {
      const sep = document.createElement('span');
      sep.className = 'term-tab-sep';
      sep.textContent = '|';
      label.appendChild(sep);
    }
    const el = document.createElement('span');
    el.className = 'term-tab-seg' + (seg.focused ? ' focused' : '');
    el.dataset.paneId = String(seg.id);
    el.textContent = seg.label;
    el.title = t('terminal.renameHint');
    // Segment click focuses THAT pane (the tab-level handler would only re-focus the last active
    // one); stopPropagation keeps the tab handler from racing it.
    el.addEventListener('mousedown', (event) => {
      event.stopPropagation();
      setActivePane(group, seg.id);
      activateTerminal(group.id);
    });
    el.addEventListener('dblclick', (event) => {
      event.stopPropagation();
      const entry = terminals.get(seg.id);
      if (entry) renamePane(entry);
    });
    label.appendChild(el);
  });
}

// Double-click a tab segment to rename that pane (empty input restores the default name).
async function renamePane(entry) {
  const next = await askPrompt(t('prompt.renameTerminal'), paneTabText(entry));
  if (next === null) return;
  const trimmed = next.trim();
  // Empty, or unchanged from the localized default, means "no custom name" (keep localizing it).
  entry.name = (!trimmed || trimmed === `${t('terminal.tab')} ${entry.id}`) ? null : trimmed;
  const group = termGroups.get(entry.groupId);
  if (group) renderTermTab(group);
}

function makeTermTab(group) {
  const tab = document.createElement('div');
  tab.className = 'term-tab';
  const label = document.createElement('span');
  label.className = 'term-tab-label';
  const close = document.createElement('span');
  close.className = 'term-tab-close';
  close.textContent = '×';
  tab.append(label, close);
  tab.addEventListener('mousedown', (event) => {
    if (event.target === close) return;
    activateTerminal(group.id);
  });
  close.addEventListener('click', (event) => { event.stopPropagation(); closeTerminal(group.id); });
  terminalTabList.appendChild(tab);
  return tab; // segments are rendered by renderTermTab once the first pane exists
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
  // See terminalActions.shouldHandleRightClick for the policy (own the click when mouse reporting is
  // off, or when a clipboard image makes the paste intent unambiguous).
  const weOwnRightClick = () => window.terminalActions.shouldHandleRightClick({
    mouseReporting: mouseReportingActive(),
    hasImage: window.api.clipboardHasImage()
  });
  entry.host.addEventListener('mousedown', (event) => {
    if (event.button !== 2 || !weOwnRightClick()) return;
    event.preventDefault();
    event.stopPropagation();
    // In mouse-reporting mode we only reach here for an image paste (see weOwnRightClick): the app
    // owns selection/copy, so there's nothing to do but push the image the way Ctrl+V does.
    if (mouseReportingActive()) { pasteImageToTerminal(entry); return; }
    const result = window.terminalActions.terminalRightClick(io);
    if (result.action === 'paste') term.focus();
  }, true);
  // Also swallow the matching right-button mouseup so xterm doesn't emit a dangling release report.
  entry.host.addEventListener('mouseup', (event) => {
    if (event.button !== 2 || !weOwnRightClick()) return;
    event.preventDefault();
    event.stopPropagation();
  }, true);
  // Suppress xterm's own contextmenu handler (it stages the selection into the hidden textarea, which
  // could leak into the pty). Only when we own the right-click (mouse reporting off, or an image paste).
  entry.host.addEventListener('contextmenu', (event) => {
    if (!weOwnRightClick()) return;
    event.preventDefault();
    event.stopPropagation();
  }, true);
}

// Draggable divider between two panes; it resolves its left pane from the DOM at drag time, so a
// pane removal can never leave it pointing at a disposed terminal.
function makeTermDivider(group) {
  const divider = document.createElement('div');
  divider.className = 'term-divider';
  divider.addEventListener('mousedown', (event) => {
    event.preventDefault();
    const leftHost = divider.previousElementSibling;
    if (!leftHost) return;
    const startX = event.clientX;
    const startW = leftHost.getBoundingClientRect().width;
    let rafQueued = false;
    const onMove = (move) => {
      leftHost.style.flex = `0 0 ${Math.max(120, startW + (move.clientX - startX))}px`;
      if (!rafQueued) {
        rafQueued = true;
        requestAnimationFrame(() => { rafQueued = false; fitGroupPanes(group); });
      }
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      fitGroupPanes(group);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });
  return divider;
}

// One terminal pane (its own xterm + pty) appended to the group's flex row.
function createPane(group, { command = '', cwd = '' } = {}) {
  const id = nextTermId++;
  const host = document.createElement('div');
  host.className = 'term-pane';
  const entry = { id, groupId: group.id, term: null, fit: null, host, divider: null, exited: false, cwd: null, name: null };
  if (group.paneIds.length > 0) {
    entry.divider = makeTermDivider(group);
    group.container.appendChild(entry.divider);
  }
  group.container.appendChild(host);
  const term = new Terminal({ cursorBlink: true, fontFamily: 'Consolas, monospace', fontSize: 13 });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  // Clickable URLs: the web-links addon underlines http(s) URLs on hover; clicking routes through
  // the main process (shell:openExternal re-validates the scheme) so links open in the OS browser,
  // never in an Electron window.
  term.loadAddon(new WebLinksAddon.WebLinksAddon((_event, uri) => {
    if (/^https?:\/\//i.test(uri)) window.api.openExternal(uri);
  }));
  term.open(host);
  entry.term = term;
  entry.fit = fit;
  // The shell reports its cwd on every prompt via OSC 7 (PROMPT_COMMAND set by the main process);
  // Split Terminal / New Terminal read it so a new shell starts where the user actually is.
  term.parser.registerOscHandler(7, (payload) => {
    const parsed = window.terminalActions.parseOsc7Cwd(payload);
    if (parsed) entry.cwd = parsed;
    return true;
  });
  // Per-pane close (shown only while split): kills this pane's shell and gives its space back.
  const closeBtn = document.createElement('button');
  closeBtn.className = 'term-pane-close';
  closeBtn.textContent = '×';
  closeBtn.dataset.i18nTitle = 'terminal.closePane';
  closeBtn.title = t('terminal.closePane');
  closeBtn.addEventListener('click', (event) => { event.stopPropagation(); closePane(id); });
  host.appendChild(closeBtn);
  // Track which pane holds focus (xterm's textarea focus bubbles as focusin).
  host.addEventListener('focusin', () => setActivePane(group, id));
  terminals.set(id, entry);
  wireTerminal(entry);
  group.paneIds.push(id);
  group.activePaneId = id;
  renderTermTab(group); // the new pane gets its own tab segment
  window.api.terminalStart({ id, ...config, command, cwd });
  return entry;
}

function createTerminal({ command = '', cwd = '' } = {}) {
  if (!config) return null;
  const id = nextGroupId++;
  const container = document.createElement('div');
  container.className = 'term-group';
  terminalHost.appendChild(container);
  const group = { id, tab: null, container, paneIds: [], activePaneId: null }; // names live on panes
  group.tab = makeTermTab(group);
  termGroups.set(id, group);
  const entry = createPane(group, { command, cwd });
  activateTerminal(id);
  refreshPaneChrome(group);
  setTimeout(() => fitPane(entry), 60);
  return entry;
}

// Split the active tab: another shell pane beside the existing ones (widths reset to equal shares).
// The new shell starts in the focused pane's current directory (workspace root until the first
// prompt has reported a cwd).
function splitActiveTerminal() {
  const group = activeGroup();
  if (!group || !config || group.paneIds.length >= MAX_PANES) return null;
  const source = terminals.get(group.activePaneId);
  for (const pid of group.paneIds) {
    const e = terminals.get(pid);
    if (e) e.host.style.flex = ''; // drop dragged widths so the new pane gets an equal share
  }
  const entry = createPane(group, { cwd: (source && source.cwd) || '' });
  refreshPaneChrome(group);
  setTimeout(() => { fitGroupPanes(group); entry.term.focus(); }, 60);
  return entry;
}

// After the shell exits, the pty is gone; any keystroke (or the menu) restarts that pane's shell,
// back in the directory the old shell was last in.
function restartTerminal(entry) {
  if (!entry || !config) return;
  entry.exited = false;
  entry.term.clear();
  window.api.terminalStart({ id: entry.id, ...config, command: '', cwd: entry.cwd || '' });
  setTimeout(() => fitPane(entry), 200);
}

// Close one pane of a split group (the group itself when it's the last pane).
function closePane(paneId) {
  const entry = terminals.get(paneId);
  if (!entry) return;
  const group = termGroups.get(entry.groupId);
  if (!group) return;
  if (group.paneIds.length <= 1) { closeTerminal(group.id); return; }
  window.api.terminalClose({ id: paneId });
  entry.term.dispose();
  // Remove the divider that came with this pane; the first pane has none, so the one owned by the
  // (about to become first) second pane goes instead.
  if (entry.divider) {
    entry.divider.remove();
  } else {
    const second = terminals.get(group.paneIds[1]);
    if (second && second.divider) { second.divider.remove(); second.divider = null; }
  }
  entry.host.remove();
  terminals.delete(paneId);
  group.paneIds = group.paneIds.filter((pid) => pid !== paneId);
  for (const pid of group.paneIds) {
    const e = terminals.get(pid);
    if (e) e.host.style.flex = ''; // re-share the freed space equally
  }
  if (group.activePaneId === paneId) group.activePaneId = group.paneIds[group.paneIds.length - 1];
  refreshPaneChrome(group);
  renderTermTab(group); // drop the closed pane's tab segment
  setTimeout(() => {
    fitGroupPanes(group);
    const focus = terminals.get(group.activePaneId);
    if (focus) focus.term.focus();
  }, 0);
}

function closeTerminal(groupId) {
  const group = termGroups.get(groupId);
  if (!group) return;
  for (const pid of group.paneIds) {
    const e = terminals.get(pid);
    if (!e) continue;
    window.api.terminalClose({ id: pid });
    e.term.dispose();
    terminals.delete(pid);
  }
  group.container.remove();
  group.tab.remove();
  termGroups.delete(groupId);
  if (activeGroupId === groupId) {
    const next = termGroups.keys().next().value;
    if (next != null) activateTerminal(next);
    else { activeGroupId = null; createTerminal(); } // always keep at least one terminal
  }
}

function disposeAllTerminals() {
  for (const entry of terminals.values()) {
    window.api.terminalClose({ id: entry.id });
    entry.term.dispose();
  }
  for (const group of termGroups.values()) {
    group.container.remove();
    group.tab.remove();
  }
  terminals.clear();
  termGroups.clear();
  activeGroupId = null;
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

// New Terminal follows the focused terminal's current directory, same as Split Terminal.
document.getElementById('newTerminalBtn').addEventListener('click', () => {
  const from = activeTerminal();
  createTerminal({ cwd: (from && from.cwd) || '' });
});
document.getElementById('splitTerminalBtn').addEventListener('click', () => splitActiveTerminal());

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
// The tab strip hides its scrollbars (they squeeze the 30px bar); scroll it with the mouse wheel
// instead — vertical wheel motion maps to horizontal tab scrolling, like VS Code's tab bar.
editorTabList.addEventListener('wheel', (event) => {
  if (!event.deltaY) return;
  event.preventDefault();
  editorTabList.scrollLeft += event.deltaY;
}, { passive: false });

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
  if (on) {
    editorPreview.innerHTML = window.markdown.render(editor.value);
    editorPreview.scrollTop = 0;
    renderMermaidBlocks();
  }
}

// --- Mermaid diagrams in the Markdown preview ---
// markdown.js renders ```mermaid fences as ordinary escaped code blocks; this pass swaps each for
// the diagram SVG. Rendering is async, so a generation counter drops results that finish after the
// preview was re-rendered (tab switch, edit/preview toggle) — never paint into a newer preview.
let mermaidInited = false;
let mermaidGeneration = 0;
async function renderMermaidBlocks() {
  const blocks = editorPreview.querySelectorAll('pre > code.language-mermaid');
  if (!blocks.length || typeof mermaid === 'undefined') return;
  if (!mermaidInited) {
    // securityLevel 'strict' sanitizes labels and disables click bindings; suppressErrorRendering
    // keeps mermaid from appending its error bomb to the document on parse failures.
    mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict', suppressErrorRendering: true });
    mermaidInited = true;
  }
  const gen = ++mermaidGeneration;
  for (let k = 0; k < blocks.length; k++) {
    const code = blocks[k];
    const src = code.textContent;
    try {
      // The id must be unique per call: mermaid uses it as the SVG element id.
      const { svg } = await mermaid.render(`mermaid-${gen}-${k}`, src);
      if (gen !== mermaidGeneration) return;
      const box = document.createElement('div');
      box.className = 'mermaid-diagram';
      box.innerHTML = svg;
      code.parentElement.replaceWith(box);
    } catch (error) {
      if (gen !== mermaidGeneration) return;
      // Leave the source visible and flag the block; the message pinpoints the syntax error.
      const note = document.createElement('div');
      note.className = 'mermaid-error';
      note.textContent = `Mermaid: ${(error && error.message) || error}`;
      code.parentElement.classList.add('mermaid-failed');
      code.parentElement.before(note);
    }
  }
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

// --- Git status coloring for the tree (VS Code-like: untracked green, modified amber, folders
// with changed descendants a muted amber). Fed by the same git:info poll as the branch badge. ---
let gitFileStatus = new Map();     // absolute path -> porcelain XY code
let gitDirStatus = [];             // whole-dir entries (e.g. an untracked directory), prefix-matched
let gitChangedAncestors = new Set(); // dirs (under the workspace root) containing changed descendants

function applyGitStatuses(statuses) {
  gitFileStatus = new Map();
  gitDirStatus = [];
  gitChangedAncestors = new Set();
  const root = config ? config.wslPath : '';
  for (const s of statuses || []) {
    if (!s || typeof s.path !== 'string') continue;
    if (s.dir) gitDirStatus.push(s); else gitFileStatus.set(s.path, s.code);
    // Mark every ancestor directory below the workspace root so folders tint too.
    let p = s.path;
    for (let idx = p.lastIndexOf('/'); idx > 0; idx = p.lastIndexOf('/')) {
      p = p.slice(0, idx);
      if (!root || p === root || !p.startsWith(root + '/')) break;
      gitChangedAncestors.add(p);
    }
  }
}

function gitCodeForPath(p) {
  const code = gitFileStatus.get(p);
  if (code) return code;
  // Files/dirs beneath a whole-dir entry (untracked directory) inherit its status.
  for (const d of gitDirStatus) {
    if (p === d.path || p.startsWith(d.path + '/')) return d.code;
  }
  return null;
}

// Re-tint all visible tree rows from the current status maps (cheap: class toggles only).
function decorateTreeGitStatus() {
  document.querySelectorAll('#tree .row').forEach((row) => {
    const p = row.dataset.path;
    const code = gitCodeForPath(p);
    const untracked = code === '??';
    row.classList.toggle('git-untracked', untracked);
    row.classList.toggle('git-modified', !!code && !untracked);
    row.classList.toggle('git-dirty-dir', !code && row.dataset.type === 'directory' && gitChangedAncestors.has(p));
  });
}

// Show the workspace's current git branch (⎇ name, plus * when dirty) in the tree header, or hide the
// badge when it isn't a git repo. Re-run on an interval since branch/dirtiness change via the terminal.
let updatingGitBranch = false;

// The repo-link icon next to the branch badge: shown when the repo has a web-mappable remote
// (git:info normalizes ssh/scp forms to https), clicking opens it in the default browser.
function updateGitRemoteLink(remoteUrl) {
  const link = document.getElementById('gitRemoteLink');
  if (!link) return;
  if (remoteUrl) {
    link.dataset.url = remoteUrl;
    link.title = remoteUrl;
    link.classList.remove('hidden');
  } else {
    delete link.dataset.url;
    link.classList.add('hidden');
  }
}

// stopPropagation: a plain click on the #cwd header retargets the tree paste target (see
// initTreePasteTarget); clicking the icon should only open the browser.
function initGitRemoteLink() {
  document.getElementById('gitRemoteLink').addEventListener('click', (event) => {
    event.stopPropagation();
    const url = event.currentTarget.dataset.url;
    if (url) window.api.openExternal(url);
  });
}

async function updateGitBranch() {
  const badge = document.getElementById('gitBranch');
  if (!badge) return;
  if (!config) { badge.classList.add('hidden'); updateGitRemoteLink(null); return; }
  if (updatingGitBranch) return;
  updatingGitBranch = true;
  const cfgAtStart = config;
  try {
    const info = await window.api.gitInfo({ distro: cfgAtStart.distro, wslPath: cfgAtStart.wslPath });
    if (config !== cfgAtStart) {
      // Workspace switched mid-call: this result is stale, and the switch-time refresh was dropped
      // by the updatingGitBranch guard. Hide the old repo's badge/link and redo the fetch for the
      // new workspace (queued so the finally below releases the guard first).
      badge.classList.add('hidden');
      updateGitRemoteLink(null);
      queueMicrotask(updateGitBranch);
      return;
    }
    if (info && info.branch) {
      badge.textContent = `⎇ ${info.branch}${info.dirty ? ' *' : ''}`;
      badge.title = info.branch + (info.dirty ? ' (uncommitted changes)' : '');
      badge.classList.remove('hidden');
      updateGitRemoteLink(info.remoteUrl);
      applyGitStatuses(info.statuses);
    } else {
      badge.classList.add('hidden');
      updateGitRemoteLink(null);
      applyGitStatuses([]); // not a repo: clear any leftover tinting
    }
    decorateTreeGitStatus();
  } catch {
    badge.classList.add('hidden');
    updateGitRemoteLink(null);
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
  // Keep the Delete-key / paste target in sync with the row the user just visually selected here, so
  // a right-click followed by Delete acts on this node — not on whatever was last left-clicked. Root
  // clears the target (it's never deletable and has no row to paste beside).
  setTreePasteTarget(isRoot ? null : node);
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

// Delete a file/directory after a path-showing confirm, then close any open tabs under it and
// refresh. Shared by the context-menu action and the tree pane's Delete-key handler. The workspace
// root has no row and must never be deletable, so callers guard against it.
async function deleteTreeNode(node) {
  if (!node || !config || node.path === config.wslPath) return;
  const message = node.type === 'directory' ? t('confirm.deleteDir') : t('confirm.deleteFile');
  if (!confirm(`${message}\n\n${node.path}`)) return;
  await window.api.deleteFsItem({ distro: config.distro, targetPath: node.path });
  closeEditorTabsUnder(node.path);
  // Drop the paste/Delete target if it pointed at what we just removed, so a follow-up Delete
  // doesn't act on a stale path (falls back to the workspace root).
  if (treeSelection && treeSelection.path === node.path) setTreePasteTarget(null);
  await renderTree();
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
      await deleteTreeNode(node);
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
  // Distro name as a badge, path as plain text (the full distro:path stays in the tooltip).
  const distroEl = document.getElementById('cwdDistro');
  distroEl.textContent = cfg.distro;
  distroEl.classList.remove('hidden');
  document.getElementById('cwdPath').textContent = cfg.wslPath;
  cwdEl.title = `${cfg.distro}:${cfg.wslPath}`;
  updateWorkspaceName();
  decorateTreeGitStatus(); // fresh rows: re-apply the last known git tinting immediately
  updateGitBranch();       // then refresh branch + statuses asynchronously
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
      layout.style.gridTemplateColumns = `${width}px 1px 1fr`;
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
      rightPane.style.gridTemplateRows = `${topHeight}px 1px 1fr`;
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
  // Delete key: remove the last-clicked file/directory (the same node a context-menu delete would
  // target). Scoped to the tree pane's focus so it never fires while editing text in the editor.
  // deleteTreeNode guards the workspace root (treeSelection is null when the root is the target).
  pane.addEventListener('keydown', (event) => {
    if (event.key !== 'Delete' || !treeSelection) return;
    event.preventDefault();
    deleteTreeNode(treeSelection).catch((error) => alert(error.message || String(error)));
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

(async function init() {
  // One-time wiring that does not depend on a chosen workspace. pollTreeChanges no-ops while config is null.
  initResizers();
  initTerminalDropTarget();
  initTreeRootDropTarget();
  initTreePasteTarget();
  initLanding();
  initMenubar();
  initEditorPreview();
  initGitRemoteLink();
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
  try {
    await renderTree();
  } catch (error) {
    // A saved WSL workspace may be unavailable during startup. Keep the window usable and fall
    // back to the landing screen instead of leaving a blank renderer behind a wedged main process.
    console.error('Failed to restore the last workspace:', error);
    config = null;
    expanded.clear();
    landing.classList.remove('hidden');
    updateWorkspaceName();
    renderLandingRecent();
    await window.api.resyncWorkspace({ showLanding: true });
    return;
  }
  createTerminal();
  restoreEditorSession(); // reopen this workspace's files from the last session
})();
