// Terminals are created per tab (see the terminal-tabs section below), not a single instance.

let config = null;
let selectedPath = null;
const expanded = new Set();
let contextNode = null;

const layout = document.getElementById('layout');
const rightPane = document.getElementById('rightPane');
const editor = document.getElementById('editor');
const imagePreview = document.getElementById('imagePreview');

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
  // Re-label open terminal tabs in the new language (file/editor tab names are not localized).
  for (const entry of terminals.values()) {
    const lbl = entry.tab.querySelector('.term-tab-label');
    if (lbl) lbl.textContent = `${t('terminal.tab')} ${entry.id}`;
  }
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

function makeTermTab(entry) {
  const tab = document.createElement('div');
  tab.className = 'term-tab';
  const label = document.createElement('span');
  label.className = 'term-tab-label';
  label.textContent = `${t('terminal.tab')} ${entry.id}`;
  const close = document.createElement('span');
  close.className = 'term-tab-close';
  close.textContent = '×';
  tab.append(label, close);
  tab.addEventListener('mousedown', (event) => {
    if (event.target === close) return;
    activateTerminal(entry.id);
  });
  close.addEventListener('click', (event) => { event.stopPropagation(); closeTerminal(entry.id); });
  terminalTabList.appendChild(tab);
  return tab;
}

function wireTerminal(entry) {
  const { id, term } = entry;
  term.onData((data) => {
    if (entry.exited) { restartTerminal(entry); return; }
    window.api.terminalWrite({ id, data });
  });
  // Ctrl+C copies selection (else interrupt), Ctrl+V pastes; Ctrl+S is handled by the window handler.
  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown' || !(event.ctrlKey || event.metaKey)) return true;
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
      const text = window.api.clipboardReadText();
      if (text) window.api.terminalWrite({ id, data: text });
      event.preventDefault();
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
    writePty: (text) => window.api.terminalWrite({ id, data: text })
  };
  entry.host.addEventListener('mousedown', (event) => {
    if (event.button !== 2) return;
    const result = window.terminalActions.terminalRightClick(io);
    if (result.action === 'paste') term.focus();
  });
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
  const entry = { id, term, fit, host, exited: false, tab: null };
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
  editor.style.display = on ? 'none' : '';
}

function anyEditorDirty() {
  for (const tab of editorTabs.values()) if (tab.dirty) return true;
  return false;
}

function updateEditorTabEl(tab) {
  if (!tab || !tab.el) return;
  tab.el.querySelector('.editor-tab-label').textContent = tab.name;
  tab.el.querySelector('.editor-tab-dirty').textContent = tab.dirty ? '●' : '';
  tab.el.classList.toggle('active', tab.path === selectedPath);
}
function refreshEditorTabs() { for (const tab of editorTabs.values()) updateEditorTabEl(tab); }

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

// Load the active tab into the shared editor/image view (or blank when no tab is open).
function renderActiveEditor() {
  const tab = editorTabs.get(selectedPath);
  if (!tab) {
    showImagePreview(false);
    imagePreview.removeAttribute('src');
    editor.value = '';
    editor.disabled = false;
    refreshEditorTabs();
    return;
  }
  if (tab.isImage) {
    showImagePreview(true);
    if (tab.imageSrc) imagePreview.src = tab.imageSrc; else imagePreview.removeAttribute('src');
    editor.disabled = false;
  } else {
    showImagePreview(false);
    imagePreview.removeAttribute('src');
    editor.value = tab.value || '';
    editor.disabled = !!tab.disabled;
  }
  refreshEditorTabs();
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
  el.addEventListener('mousedown', (event) => { if (event.target === close) return; activateEditorTab(tab.path); });
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
}

// Open a file in a tab (or activate its existing tab). Replaces the old single-file loadFile.
async function openFileInEditor(node) {
  if (editorTabs.has(node.path)) { activateEditorTab(node.path); return; }
  persistActiveEditor(); // save the previously active tab before switching
  // Register and activate synchronously (read-only while loading) so a second open of the same
  // file activates this tab instead of creating a duplicate, and edits can't be lost mid-load.
  const tab = { path: node.path, name: basenameFor(node.path), value: '', dirty: false, isImage: false, imageSrc: null, disabled: true, el: null };
  tab.el = makeEditorTabEl(tab);
  editorTabs.set(node.path, tab);
  selectedPath = node.path;
  renderActiveEditor();
  highlightTreeRow(node.path);

  let disabled = false;
  if (window.fileTypes.isImagePath(node.path)) {
    try { tab.imageSrc = await window.api.readImage({ distro: config.distro, wslPath: node.path }); tab.isImage = true; }
    catch (error) { tab.value = String(error.message || error); disabled = true; }
  } else {
    try { tab.value = await window.api.readFile({ distro: config.distro, wslPath: node.path }); }
    catch (error) { tab.value = String(error.message || error); disabled = true; }
  }
  tab.disabled = disabled; // editable once loaded (unless the read failed)
  if (editorTabs.get(node.path) === tab && selectedPath === node.path) renderActiveEditor();
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
    }
  }
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
});

// Ctrl+S (not Ctrl+Shift+S, which is Save Workspace) saves the active tab. The toolbar button and
// the menu item were removed; Ctrl+S is the single save affordance.
window.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 's') {
    event.preventDefault();
    saveCurrentFile();
  }
});

async function saveCurrentFile() {
  const tab = editorTabs.get(selectedPath);
  // Skip when there's no editable text buffer: no tab, an image, or an error/read-failure view.
  if (!tab || !config || tab.isImage || tab.disabled) return;
  try {
    await window.api.writeFile({ distro: config.distro, wslPath: tab.path, content: editor.value });
    tab.value = editor.value;
    setDirty(false);
  } catch (error) {
    alert(error.message || String(error));
  }
}


function parentDirFor(node) {
  return node.type === 'directory' ? node.path : node.path.split('/').slice(0, -1).join('/') || '/';
}

function basenameFor(wslPath) {
  return wslPath.split('/').filter(Boolean).pop() || wslPath;
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
    if (node.type === 'directory') {
      toggle(node.path);
    } else {
      await openFileInEditor(node); // opens/activates a tab and updates the tree highlight
    }
  });

  row.addEventListener('contextmenu', (event) => showContextMenu(event, node));

  twisty.addEventListener('click', (event) => {
    event.stopPropagation();
    if (node.type === 'directory') toggle(node.path);
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
    event.dataTransfer.dropEffect = event.dataTransfer.files?.length ? 'copy' : 'move';
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
  document.getElementById('cwd').textContent = `${cfg.distro}:${cfg.wslPath}`;
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
      window.api.resyncWorkspace({ showLanding: true });
    }
    return;
  }
  landing.classList.add('hidden');
  disposeAllEditorTabs(); // close the previous workspace's editor tabs
  disposeAllTerminals();  // close the previous workspace's terminals, open one fresh
  createTerminal();
}

function initResizers() {
  const vertical = document.getElementById('verticalResizer');
  const horizontal = document.getElementById('horizontalResizer');

  vertical.addEventListener('mousedown', (event) => {
    event.preventDefault();
    const onMove = (moveEvent) => {
      const width = Math.max(180, Math.min(700, moveEvent.clientX));
      layout.style.gridTemplateColumns = `${width}px 5px 1fr`;
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
      rightPane.style.gridTemplateRows = `${topHeight}px 5px 1fr`;
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

// Landing screen: the two buttons trigger the same main-process dialogs as the Workspace menu.
// On success the main process sends 'workspace:changed', which applyWorkspace() handles (and hides the screen).
function initLanding() {
  document.getElementById('landingOpenWorkspace').addEventListener('click', () => window.api.openWorkspace());
  document.getElementById('landingOpenFile').addEventListener('click', () => window.api.openWorkspaceFile());
}

// Dropping onto empty tree-pane space targets the workspace root: internal drags move there,
// external files are copied in. Row drops are handled by the rows themselves (and stop
// propagation), so this only fires for empty space — it replaces the move/copy-to-root target
// the (now omitted) root row used to provide. Attached to #treePane (not #tree) because #tree
// only spans its rendered rows; the empty area below is the pane.
function initTreeRootDropTarget() {
  const pane = document.getElementById('treePane');
  pane.addEventListener('dragover', (event) => {
    if (!config || event.target.closest('.row')) return; // rows manage their own drop affordance
    const external = !!event.dataTransfer.files?.length;
    if (!currentTreeDragPath && !external) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = external ? 'copy' : 'move';
  });
  pane.addEventListener('drop', async (event) => {
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
    window.api.terminalWrite({ id: entry.id, data: shellQuotePath(currentTreeDragPath) + ' ' });
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
  initLanding();
  initMenubar();
  setInterval(pollTreeChanges, 1500);

  const initial = await window.api.getConfig();
  currentLang = window.i18n.normalizeLang(initial.lang);
  applyLanguage();
  if (initial.showLanding) {
    config = null; // no active workspace yet; the landing screen drives the next step
    landing.classList.remove('hidden');
    return;
  }
  landing.classList.add('hidden');
  config = initial;
  expanded.add(config.wslPath);
  await renderTree();
  createTerminal();
})();
