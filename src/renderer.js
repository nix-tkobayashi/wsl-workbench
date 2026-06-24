const term = new Terminal({ cursorBlink: true, fontFamily: 'Consolas, monospace', fontSize: 13 });
const fitAddon = new FitAddon.FitAddon();
term.loadAddon(fitAddon);
term.open(document.getElementById('terminal'));
fitAddon.fit();

let config = null;
let selectedPath = null;
let editorDirty = false;
const expanded = new Set();
let contextNode = null;

const layout = document.getElementById('layout');
const rightPane = document.getElementById('rightPane');
const editor = document.getElementById('editor');
const imagePreview = document.getElementById('imagePreview');
const editorTitle = document.getElementById('editorTitle');
const dirtyMark = document.getElementById('dirtyMark');

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
  // editorTitle shows a file path when a file is open; only localize it when idle.
  if (!selectedPath) editorTitle.textContent = t('editor.title');
  setDirty(editorDirty); // refresh the unsaved indicator label
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

function terminalResize() {
  fitAddon.fit();
  window.api.terminalResize({ cols: term.cols, rows: term.rows });
}
window.addEventListener('resize', terminalResize);
// After the shell exits (`exit`), the pty is gone. Instead of a dead terminal, let any keystroke
// restart it (also available via the Workspace > Restart Terminal menu).
let terminalExited = false;
function restartTerminal() {
  if (!config) return;
  terminalExited = false;
  term.clear();
  window.api.terminalStart({ ...config, command: '' });
  setTimeout(terminalResize, 200);
}
term.onData((data) => {
  if (terminalExited) { restartTerminal(); return; }
  window.api.terminalWrite(data);
});
window.api.onTerminalData((data) => term.write(data));
window.api.onTerminalExit(() => {
  terminalExited = true;
  term.write(`\r\n\x1b[90m${t('terminal.restartHint')}\x1b[0m\r\n`);
});

function copyTerminalSelection() {
  const selection = term.getSelection();
  if (selection) window.api.clipboardWriteText(selection);
}
function pasteIntoTerminal() {
  const text = window.api.clipboardReadText();
  if (text) window.api.terminalWrite(text);
}

// Ctrl+C copies the selection (falls back to interrupt when nothing is selected),
// Ctrl+V pastes the clipboard into the shell. Ctrl+Shift+C/V always copy/paste.
term.attachCustomKeyEventHandler((event) => {
  if (event.type !== 'keydown' || !(event.ctrlKey || event.metaKey)) return true;
  const key = event.key.toLowerCase();
  if (key === 'c') {
    if (event.shiftKey || term.hasSelection()) {
      copyTerminalSelection();
      event.preventDefault();
      return false; // do not also send SIGINT
    }
    return true; // no selection: let Ctrl+C interrupt the process
  }
  if (key === 'v') {
    pasteIntoTerminal();
    event.preventDefault();
    return false;
  }
  if (key === 's' && !event.shiftKey) {
    // Let the window-level Ctrl+S handler save the file; don't send XOFF to the shell.
    return false;
  }
  return true;
});

// Right-click mirrors Ctrl+C / Ctrl+V (Windows Terminal / PuTTY style):
// copy when there is a selection, paste when there is none.
document.getElementById('terminal').addEventListener('contextmenu', (event) => {
  event.preventDefault();
  if (term.hasSelection()) {
    copyTerminalSelection();
    term.clearSelection();
  } else {
    pasteIntoTerminal();
    term.focus();
  }
});

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

// True while an image is shown in the preview, so save/dirty logic doesn't touch it.
let currentIsImage = false;

function showImagePreview(on) {
  currentIsImage = on;
  imagePreview.style.display = on ? 'block' : 'none';
  editor.style.display = on ? 'none' : '';
}

function setDirty(value) {
  editorDirty = value;
  dirtyMark.textContent = editorDirty ? t('editor.unsaved') : '';
}

async function loadFile(node) {
  selectedPath = node.path;
  editorTitle.textContent = node.path;

  if (window.fileTypes.isImagePath(node.path)) {
    try {
      imagePreview.src = await window.api.readImage({ distro: config.distro, wslPath: node.path });
      showImagePreview(true);
      setDirty(false);
      return;
    } catch (error) {
      // Fall back to showing the error in the text view.
      imagePreview.removeAttribute('src');
      showImagePreview(false);
      editor.value = String(error.message || error);
      editor.disabled = true;
      setDirty(false);
      return;
    }
  }

  showImagePreview(false);
  imagePreview.removeAttribute('src');
  try {
    editor.value = await window.api.readFile({ distro: config.distro, wslPath: node.path });
    editor.disabled = false;
    setDirty(false);
  } catch (error) {
    editor.value = String(error.message || error);
    editor.disabled = true;
    setDirty(false);
  }
}

editor.addEventListener('input', () => {
  if (selectedPath) setDirty(true);
});

// Editor right-click: copy when there's a selection, otherwise paste at the cursor
// (mirrors the terminal). Skipped for read-only views (image preview / read failure).
editor.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  if (start !== end) {
    window.api.clipboardWriteText(editor.value.slice(start, end));
    return;
  }
  if (!selectedPath || editor.disabled || currentIsImage) return; // nothing editable to paste into
  const text = window.api.clipboardReadText();
  if (!text) return;
  editor.value = editor.value.slice(0, start) + text + editor.value.slice(end);
  editor.selectionStart = editor.selectionEnd = start + text.length;
  if (selectedPath) setDirty(true);
});

// Ctrl+S (not Ctrl+Shift+S, which is Save Workspace) saves the open file. The toolbar button and
// the menu item were removed; Ctrl+S is the single save affordance.
window.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 's') {
    event.preventDefault();
    saveCurrentFile();
  }
});

// Save the current editor file. Triggered by Ctrl+S (the toolbar button and the menu item were
// removed; Ctrl+S is the single save affordance).
async function saveCurrentFile() {
  // Skip when there's no editable text buffer: no file, an image preview, or an error/read-failure
  // view (editor.disabled) — otherwise Ctrl+S would write the error text over the file.
  if (!selectedPath || !config || currentIsImage || editor.disabled) return;
  try {
    await window.api.writeFile({ distro: config.distro, wslPath: selectedPath, content: editor.value });
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

function clearEditorIfAffected(targetPath) {
  if (selectedPath === targetPath || selectedPath?.startsWith(targetPath + '/')) {
    selectedPath = null;
    editor.value = '';
    editorTitle.textContent = t('editor.title');
    editor.disabled = false;
    showImagePreview(false);
    imagePreview.removeAttribute('src');
    setDirty(false);
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
      if (selectedPath === node.path) {
        selectedPath = result.path;
        editorTitle.textContent = result.path;
      } else if (selectedPath?.startsWith(node.path + '/')) {
        selectedPath = result.path + selectedPath.slice(node.path.length);
        editorTitle.textContent = selectedPath;
      }
      await renderTree();
      return;
    }

    if (action === 'delete') {
      const message = node.type === 'directory' ? t('confirm.deleteDir') : t('confirm.deleteFile');
      if (!confirm(`${message}\n\n${node.path}`)) return;
      await window.api.deleteFsItem({ distro: config.distro, targetPath: node.path });
      clearEditorIfAffected(node.path);
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
    document.querySelectorAll('.row.selected').forEach((el) => el.classList.remove('selected'));
    row.classList.add('selected');
    if (node.type === 'directory') {
      toggle(node.path);
    } else {
      if (editorDirty && !confirm(t('confirm.discardChanges'))) return;
      await loadFile(node);
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
      if (selectedPath === sourcePath || selectedPath?.startsWith(sourcePath + '/')) {
        selectedPath = null;
        editor.value = '';
        editorTitle.textContent = t('editor.title');
        showImagePreview(false);
        imagePreview.removeAttribute('src');
        setDirty(false);
      }
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
  if (editorDirty && !confirm(t('confirm.discardChanges'))) {
    // Main already committed the new workspace; put it back in sync with what we still show.
    if (config) window.api.resyncWorkspace({ workspace: config, showLanding: false });
    return;
  }
  // Snapshot so we can fully roll back if the new workspace fails to load.
  const prevConfig = config;
  const prevExpanded = new Set(expanded);
  const prevEditor = { selectedPath, value: editor.value, title: editorTitle.textContent, disabled: editor.disabled, dirty: editorDirty, image: currentIsImage, imageSrc: imagePreview.getAttribute('src') };
  config = nextConfig;
  selectedPath = null;
  editor.value = '';
  editorTitle.textContent = t('editor.title');
  showImagePreview(false);
  imagePreview.removeAttribute('src');
  setDirty(false);
  expanded.clear();
  expanded.add(config.wslPath);
  try {
    await renderTree(); // builds detached and publishes only on success; landing stays as a loading cover
  } catch (error) {
    alert(error.message || String(error));
    // Roll back: the live tree/CWD/editor were never replaced, so restore the matching state.
    config = prevConfig;
    expanded.clear();
    for (const p of prevExpanded) expanded.add(p);
    selectedPath = prevEditor.selectedPath;
    editor.value = prevEditor.value;
    editorTitle.textContent = prevEditor.title;
    editor.disabled = prevEditor.disabled;
    if (prevEditor.imageSrc) imagePreview.setAttribute('src', prevEditor.imageSrc); else imagePreview.removeAttribute('src');
    showImagePreview(prevEditor.image);
    setDirty(prevEditor.dirty);
    if (prevConfig) {
      window.api.resyncWorkspace({ workspace: prevConfig, showLanding: false });
    } else {
      landing.classList.remove('hidden');
      window.api.resyncWorkspace({ showLanding: true });
    }
    return;
  }
  landing.classList.add('hidden');
  terminalExited = false; // fresh terminal for the new workspace
  window.api.terminalStart({ ...config, command: '' });
  setTimeout(terminalResize, 300);
}

function initResizers() {
  const vertical = document.getElementById('verticalResizer');
  const horizontal = document.getElementById('horizontalResizer');

  vertical.addEventListener('mousedown', (event) => {
    event.preventDefault();
    const onMove = (moveEvent) => {
      const width = Math.max(180, Math.min(700, moveEvent.clientX));
      layout.style.gridTemplateColumns = `${width}px 5px 1fr`;
      terminalResize();
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
      terminalResize();
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
      if (selectedPath === sourcePath || selectedPath?.startsWith(sourcePath + '/')) {
        selectedPath = null;
        editor.value = '';
        editorTitle.textContent = t('editor.title');
        showImagePreview(false);
        imagePreview.removeAttribute('src');
        setDirty(false);
      }
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
    event.preventDefault();
    window.api.terminalWrite(shellQuotePath(currentTreeDragPath) + ' ');
    term.focus();
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
window.api.onMenuRestartTerminal(() => restartTerminal());
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
  window.api.terminalStart({ ...config, command: startClaude });
  setTimeout(terminalResize, 300);
});

(async function init() {
  // One-time wiring that does not depend on a chosen workspace. pollTreeChanges no-ops while config is null.
  initResizers();
  initTerminalDropTarget();
  initTreeRootDropTarget();
  initLanding();
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
  window.api.terminalStart({ ...config, command: '' });
  setTimeout(terminalResize, 300);
})();
