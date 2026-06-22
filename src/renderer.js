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
const saveBtn = document.getElementById('saveBtn');
const editorTitle = document.getElementById('editorTitle');
const dirtyMark = document.getElementById('dirtyMark');

const landing = document.getElementById('landing');

const promptModal = document.getElementById('promptModal');
const promptMessage = document.getElementById('promptMessage');
const promptInput = document.getElementById('promptInput');
const promptOk = document.getElementById('promptOk');
const promptCancel = document.getElementById('promptCancel');

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
term.onData((data) => window.api.terminalWrite(data));
window.api.onTerminalData((data) => term.write(data));

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

function setDirty(value) {
  editorDirty = value;
  saveBtn.disabled = !selectedPath || !editorDirty;
  dirtyMark.textContent = editorDirty ? '● unsaved' : '';
}

async function loadFile(node) {
  selectedPath = node.path;
  editorTitle.textContent = node.path;
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

saveBtn.addEventListener('click', async () => {
  if (!selectedPath) return;
  try {
    await window.api.writeFile({ distro: config.distro, wslPath: selectedPath, content: editor.value });
    setDirty(false);
  } catch (error) {
    alert(error.message || String(error));
  }
});

window.addEventListener('keydown', async (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    saveBtn.click();
  }
});


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
    editorTitle.textContent = 'Editor';
    editor.disabled = false;
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
      const name = await askPrompt(type === 'directory' ? 'New folder name:' : 'New file name:', defaultName);
      if (!name) return;
      await window.api.createFsItem({ distro: config.distro, parentDirPath, name, type });
      expanded.add(parentDirPath);
      await renderTree();
      return;
    }

    if (action === 'rename') {
      const currentName = basenameFor(node.path);
      const newName = await askPrompt('New name:', currentName);
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
      const label = node.type === 'directory' ? 'directory and all contents' : 'file';
      if (!confirm(`Delete this ${label}?\n\n${node.path}`)) return;
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
      if (editorDirty && !confirm('Unsaved changes will be discarded. Continue?')) return;
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
        editorTitle.textContent = 'Editor';
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
  const wrapper = await buildNode(root, cfg);
  if (myGen !== renderGeneration) return; // a newer render started; let it publish instead
  tree.innerHTML = '';
  tree.appendChild(wrapper);
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
  if (editorDirty && !confirm('Unsaved changes will be discarded. Continue?')) {
    // Main already committed the new workspace; put it back in sync with what we still show.
    if (config) window.api.resyncWorkspace({ workspace: config, showLanding: false });
    return;
  }
  // Snapshot so we can fully roll back if the new workspace fails to load.
  const prevConfig = config;
  const prevExpanded = new Set(expanded);
  const prevEditor = { selectedPath, value: editor.value, title: editorTitle.textContent, disabled: editor.disabled, dirty: editorDirty };
  config = nextConfig;
  selectedPath = null;
  editor.value = '';
  editorTitle.textContent = 'Editor';
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

// Landing screen: the two buttons trigger the same main-process dialogs as the Workspace menu.
// On success the main process sends 'workspace:changed', which applyWorkspace() handles (and hides the screen).
function initLanding() {
  document.getElementById('landingOpenWorkspace').addEventListener('click', () => window.api.openWorkspace());
  document.getElementById('landingOpenFile').addEventListener('click', () => window.api.openWorkspaceFile());
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

document.getElementById('refreshBtn').addEventListener('click', renderTree);
window.api.onWorkspaceChanged(async (nextConfig) => {
  await applyWorkspace(nextConfig);
});

document.getElementById('claudeBtn').addEventListener('click', () => {
  if (!config) return;
  // Resolve claude exactly as the user's own interactive shell does: run inside `bash -ic` so
  // ~/.bashrc (nvm/fnm/etc.) is sourced — otherwise the non-interactive `bash -lc` the terminal
  // uses misses nvm and would pick an old /usr/local/bin/claude. Still exclude the Windows claude
  // exposed under /mnt by WSL PATH interop, and fail loudly if no WSL claude is found.
  const startClaude = `bash -ic 'c=$(type -aP claude | grep -v "^/mnt/" | head -n1); if [ -n "$c" ]; then "$c" --dangerously-skip-permissions; else echo "Error: claude not found in WSL PATH (only a Windows claude under /mnt, if any). Install it inside WSL: npm i -g @anthropic-ai/claude-code"; fi'`;
  window.api.terminalStart({ ...config, command: startClaude });
  setTimeout(terminalResize, 300);
});

(async function init() {
  // One-time wiring that does not depend on a chosen workspace. pollTreeChanges no-ops while config is null.
  initResizers();
  initTerminalDropTarget();
  initLanding();
  setInterval(pollTreeChanges, 1500);

  const initial = await window.api.getConfig();
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
