const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const pty = require('node-pty');
const i18n = require('./i18n');
const { imageMimeForPath } = require('./file-types');
const { normalizeVersion, isNewer } = require('./version');

const RELEASES_API = 'https://api.github.com/repos/nix-tkobayashi/wsl-workbench/releases/latest';
const RELEASES_PAGE = 'https://github.com/nix-tkobayashi/wsl-workbench/releases/latest';

const DEFAULT_DISTRO = process.env.NWL_DISTRO || process.env.CWL_DISTRO || 'Ubuntu';
const DEFAULT_WSL_PATH = process.env.NWL_WSL_PATH || process.env.CWL_WSL_PATH || `/home/${os.userInfo().username}/projects`;
const DEFAULT_WSL_HOME_PATH = process.env.NWL_WSL_HOME_PATH || process.env.CWL_WSL_HOME_PATH || `/home/${os.userInfo().username}`;

const windowState = new Map();

// --- Language / settings persistence ---
let currentLang = 'en';

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}
function readSettings() {
  try { return JSON.parse(fs.readFileSync(settingsPath(), 'utf8')); } catch { return {}; }
}
function writeSettings(patch) {
  try {
    const next = { ...readSettings(), ...patch };
    fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2), 'utf8');
  } catch (error) {
    console.error('Failed to write settings:', error);
  }
}
function initLanguage() {
  const saved = readSettings().lang;
  if (saved) { currentLang = i18n.normalizeLang(saved); return; }
  // First run: follow the OS/Electron locale, default to English.
  currentLang = String(app.getLocale() || '').toLowerCase().startsWith('ja') ? 'ja' : 'en';
}
function setLanguage(lang) {
  const next = i18n.normalizeLang(lang);
  if (next === currentLang) return;
  currentLang = next;
  writeSettings({ lang: currentLang });
  buildAppMenu();
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('lang:changed', currentLang);
  }
}
const tr = (key) => i18n.t(currentLang, key);

function defaultWorkspace() {
  return { distro: DEFAULT_DISTRO, wslPath: DEFAULT_WSL_PATH };
}

const WORKSPACE_EXTENSIONS = new Set(['.nwl-workspace', '.json']);

function isWorkspaceFile(filePath) {
  if (!filePath) return false;
  const ext = path.extname(filePath).toLowerCase();
  if (!WORKSPACE_EXTENSIONS.has(ext)) return false;
  try { return fs.statSync(filePath).isFile(); } catch { return false; }
}

function readWorkspaceFile(filePath, fallback = defaultWorkspace()) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const data = JSON.parse(raw);
  return normalizeWorkspace(data, fallback);
}

function findWorkspaceArg(argv = process.argv) {
  return argv.find((arg) => isWorkspaceFile(arg));
}

function normalizeWorkspace(next = {}, fallback = defaultWorkspace()) {
  return {
    distro: next.distro || fallback.distro || DEFAULT_DISTRO,
    wslPath: next.wslPath || fallback.wslPath || DEFAULT_WSL_PATH
  };
}

function getStateForWebContents(webContents) {
  const win = BrowserWindow.fromWebContents(webContents);
  if (!win) throw new Error('Window not found.');
  const state = windowState.get(win.id);
  if (!state) throw new Error('Window state not found.');
  return { win, state };
}

function getFocusedWindowAndState() {
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  if (!win) return { win: null, state: null };
  return { win, state: windowState.get(win.id) };
}

// Forward a menu action to the focused window's renderer (for actions that live in the renderer,
// e.g. saving the open editor file or refreshing the tree).
function sendToFocusedWindow(channel) {
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  if (win && !win.isDestroyed()) win.webContents.send(channel);
}

function getCurrentWorkspaceForWindow(win) {
  const state = windowState.get(win.id);
  return normalizeWorkspace(state?.workspace);
}

function getDefaultOpenWorkspacePath(distro = DEFAULT_DISTRO) {
  // Prefer the WSL user home in the Windows directory picker.
  // Example: \\wsl.localhost\Ubuntu\home\skype
  return wslPathToWindowsFsPath(distro, DEFAULT_WSL_HOME_PATH);
}

function setCurrentWorkspaceForWindow(win, next) {
  const state = windowState.get(win.id);
  if (!state) return;
  state.workspace = normalizeWorkspace(next, state.workspace);
  state.showLanding = false;
  if (!win.isDestroyed()) {
    win.webContents.send('workspace:changed', { ...state.workspace });
  }
}

const { wslPathToWindowsFsPath, parseSelectedPath } = require('./wsl-paths');


function safeStat(fullPath) {
  try { return fs.statSync(fullPath); } catch { return null; }
}

const SKIP_EXTERNAL_NAMES = new Set([
  'NTUSER.DAT',
  'ntuser.dat',
  'ntuser.ini',
  'UsrClass.dat',
  'pagefile.sys',
  'hiberfil.sys',
  'swapfile.sys'
]);

function shouldSkipExternalPath(source) {
  const base = path.basename(source);
  if (SKIP_EXTERNAL_NAMES.has(base)) return true;
  if (/^ntuser\.dat/i.test(base)) return true;
  if (/^UsrClass\.dat/i.test(base)) return true;
  return false;
}

function copyRecursiveSafeSync(source, destination, result) {
  if (shouldSkipExternalPath(source)) {
    result.skipped.push({ source, reason: 'system profile file' });
    return;
  }

  let stat;
  try {
    stat = fs.statSync(source);
  } catch (error) {
    result.skipped.push({ source, reason: error.code || error.message });
    return;
  }

  if (safeStat(destination)) {
    result.skipped.push({ source, reason: 'destination exists' });
    return;
  }

  if (stat.isDirectory()) {
    try {
      fs.mkdirSync(destination, { recursive: false });
    } catch (error) {
      result.skipped.push({ source, reason: error.code || error.message });
      return;
    }

    let entries;
    try {
      entries = fs.readdirSync(source, { withFileTypes: true });
    } catch (error) {
      result.skipped.push({ source, reason: error.code || error.message });
      return;
    }

    for (const entry of entries) {
      const childSource = path.join(source, entry.name);
      const childDestination = path.join(destination, entry.name);
      copyRecursiveSafeSync(childSource, childDestination, result);
    }
    result.copied.push(destination);
    return;
  }

  if (stat.isFile()) {
    try {
      fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
      result.copied.push(destination);
    } catch (error) {
      result.skipped.push({ source, reason: error.code || error.message });
    }
    return;
  }

  result.skipped.push({ source, reason: 'not a regular file or directory' });
}

function readDirTree({ distro = DEFAULT_DISTRO, wslPath = DEFAULT_WSL_PATH }) {
  const fullPath = wslPathToWindowsFsPath(distro, wslPath);
  const stat = safeStat(fullPath);
  if (!stat) throw new Error(`Path not found: ${fullPath}`);
  const entries = fs.readdirSync(fullPath, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith('.git'))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    .map((entry) => {
      const childWslPath = path.posix.join(wslPath, entry.name);
      return {
        name: entry.name,
        path: childWslPath,
        type: entry.isDirectory() ? 'directory' : 'file',
        hasChildren: entry.isDirectory()
      };
    });
  return { name: path.posix.basename(wslPath) || '/', path: wslPath, type: 'directory', children: entries };
}

function createWindow(initialWorkspace = defaultWorkspace(), { showLanding = false } = {}) {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 880,
    minHeight: 560,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  windowState.set(win.id, {
    workspace: normalizeWorkspace(initialWorkspace),
    shellPty: null,
    showLanding
  });

  win.on('closed', () => {
    const state = windowState.get(win.id);
    if (state?.shellPty) {
      try { state.shellPty.kill(); } catch {}
    }
    windowState.delete(win.id);
  });

  win.loadFile(path.join(__dirname, 'index.html'));
  buildAppMenu();
  return win;
}

async function openWorkspaceDialog(win, state) {
  if (!win || !state) return;
  const result = await dialog.showOpenDialog(win, {
    title: tr('dialog.openWorkspace'),
    defaultPath: getDefaultOpenWorkspacePath(state.workspace.distro),
    properties: ['openDirectory']
  });
  if (result.canceled || !result.filePaths[0]) return;
  const parsed = parseSelectedPath(result.filePaths[0]);
  setCurrentWorkspaceForWindow(win, {
    // Use the distro from the selected path (supports non-default distros like Ubuntu-22.04);
    // fall back to the current distro for drive (/mnt) selections.
    distro: parsed.distro || state.workspace.distro,
    wslPath: parsed.wslPath
  });
}

async function openWorkspaceFileDialog(win, state) {
  if (!win || !state) return;
  const result = await dialog.showOpenDialog(win, {
    title: tr('dialog.openWorkspaceFile'),
    properties: ['openFile'],
    filters: [
      { name: tr('filter.workspace'), extensions: ['nwl-workspace', 'json'] },
      { name: tr('filter.allFiles'), extensions: ['*'] }
    ]
  });
  if (result.canceled || !result.filePaths[0]) return;
  try {
    setCurrentWorkspaceForWindow(win, readWorkspaceFile(result.filePaths[0], state.workspace));
  } catch (error) {
    dialog.showErrorBox(tr('dialog.openFileFailed'), error.message || String(error));
  }
}

// Only open https URLs on github.com (never trust an arbitrary URL from the API response).
function safeReleaseUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' && u.hostname === 'github.com') {
      return u.toString();
    }
  } catch {}
  return RELEASES_PAGE;
}

// Fetch the latest release version from GitHub (best-effort, short timeout).
async function fetchLatestRelease() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(RELEASES_API, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'wsl-workbench' },
      signal: controller.signal
    });
    if (!res.ok) return null;
    const data = await res.json();
    return { version: normalizeVersion(data.tag_name), url: safeReleaseUrl(data.html_url) };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// "About" dialog: shows the current version, checks GitHub for the latest, and offers to open the
// release page when a newer version exists.
async function showAboutDialog(win) {
  const current = app.getVersion();
  const latest = await fetchLatestRelease();

  const lines = [`${tr('about.currentVersion')}: ${current}`];
  let buttons = [tr('about.close')];
  let openIndex = -1;
  let openUrl = RELEASES_PAGE;

  if (latest && latest.version) {
    lines.push(`${tr('about.latestVersion')}: ${latest.version}`);
    if (isNewer(latest.version, current)) {
      lines.push('', tr('about.updateAvailable'));
      buttons = [tr('about.openReleasePage'), tr('about.close')];
      openIndex = 0;
      openUrl = latest.url;
    } else {
      lines.push('', tr('about.upToDate'));
    }
  } else {
    lines.push('', tr('about.checkFailed'));
  }

  const target = win && !win.isDestroyed() ? win : null;
  const opts = {
    type: 'info',
    title: tr('menu.about'),
    message: 'WSL Workbench',
    detail: lines.join('\n'),
    buttons,
    defaultId: 0,
    cancelId: buttons.length - 1
  };
  const result = target ? await dialog.showMessageBox(target, opts) : await dialog.showMessageBox(opts);
  if (openIndex >= 0 && result.response === openIndex) {
    try { await shell.openExternal(openUrl); } catch {}
  }
}

function buildAppMenu() {
  const template = [
    {
      label: tr('menu.workspace'),
      submenu: [
        {
          label: tr('menu.newWindow'),
          accelerator: 'CmdOrCtrl+N',
          click: () => {
            createWindow(defaultWorkspace(), { showLanding: true });
          }
        },
        {
          label: tr('menu.openWorkspace'),
          accelerator: 'CmdOrCtrl+O',
          click: () => {
            const { win, state } = getFocusedWindowAndState();
            openWorkspaceDialog(win, state);
          }
        },
        {
          label: tr('menu.openWorkspaceFile'),
          accelerator: 'CmdOrCtrl+Shift+O',
          click: () => {
            const { win, state } = getFocusedWindowAndState();
            openWorkspaceFileDialog(win, state);
          }
        },
        { type: 'separator' },
        {
          label: tr('menu.refresh'),
          accelerator: 'F5',
          click: () => sendToFocusedWindow('menu:refreshTree')
        },
        {
          label: tr('menu.restartTerminal'),
          click: () => sendToFocusedWindow('menu:restartTerminal')
        },
        {
          label: tr('menu.saveWorkspace'),
          accelerator: 'CmdOrCtrl+Shift+S',
          click: async () => {
            const { win, state } = getFocusedWindowAndState();
            if (!win || !state) return;
            const result = await dialog.showSaveDialog(win, {
              title: tr('dialog.saveWorkspace'),
              defaultPath: 'wsl-workbench.nwl-workspace',
              filters: [
                { name: tr('filter.workspace'), extensions: ['nwl-workspace', 'json'] },
                { name: tr('filter.allFiles'), extensions: ['*'] }
              ]
            });
            if (result.canceled || !result.filePath) return;
            fs.writeFileSync(result.filePath, JSON.stringify({ ...state.workspace, app: 'WSL Workbench', version: 1 }, null, 2), 'utf8');
          }
        },
        { type: 'separator' },
        {
          label: tr('menu.exit'),
          accelerator: 'CmdOrCtrl+W',
          // Close only the window this menu acted on, not the whole app. When the last window
          // closes, the existing window-all-closed handler quits the app.
          click: (_item, focusedWindow) => {
            const win = focusedWindow || BrowserWindow.getFocusedWindow();
            if (win && !win.isDestroyed()) win.close();
          }
        }
      ]
    },
    {
      label: tr('menu.edit'),
      submenu: [
        { role: 'undo', label: tr('menu.undo') },
        { role: 'redo', label: tr('menu.redo') },
        { type: 'separator' },
        { role: 'cut', label: tr('menu.cut') },
        { role: 'copy', label: tr('menu.copy') },
        { role: 'paste', label: tr('menu.paste') },
        { role: 'selectAll', label: tr('menu.selectAll') }
      ]
    },
    {
      label: tr('menu.view'),
      submenu: [
        { role: 'reload', label: tr('menu.reload') },
        { role: 'forceReload', label: tr('menu.forceReload') },
        { role: 'toggleDevTools', label: tr('menu.toggleDevTools') },
        { type: 'separator' },
        { role: 'resetZoom', label: tr('menu.resetZoom') },
        { role: 'zoomIn', label: tr('menu.zoomIn') },
        { role: 'zoomOut', label: tr('menu.zoomOut') },
        { type: 'separator' },
        { role: 'togglefullscreen', label: tr('menu.toggleFullscreen') }
      ]
    },
    {
      label: tr('menu.language'),
      submenu: [
        {
          label: tr('menu.english'),
          type: 'radio',
          checked: currentLang === 'en',
          click: () => setLanguage('en')
        },
        {
          label: tr('menu.japanese'),
          type: 'radio',
          checked: currentLang === 'ja',
          click: () => setLanguage('ja')
        }
      ]
    },
    {
      label: tr('menu.help'),
      submenu: [
        {
          label: tr('menu.about'),
          click: () => {
            const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
            showAboutDialog(win);
          }
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  initLanguage();
  const workspaceFile = findWorkspaceArg(process.argv);
  if (workspaceFile) {
    try {
      // Launched via a workspace file (e.g. file association): open it directly.
      createWindow(readWorkspaceFile(workspaceFile), { showLanding: false });
      return;
    } catch (error) {
      dialog.showErrorBox(tr('dialog.openFileFailed'), error.message || String(error));
    }
  }
  // Normal launch: start on the landing screen so the user picks a workspace.
  createWindow(defaultWorkspace(), { showLanding: true });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(defaultWorkspace(), { showLanding: true }); });

ipcMain.handle('window:new', (_event, workspace) => {
  // Used by the tree's "Open in New Window": the directory is already chosen, so skip landing.
  createWindow(normalizeWorkspace(workspace), { showLanding: false });
  return { ok: true };
});

ipcMain.handle('config:get', (event) => {
  const { win } = getStateForWebContents(event.sender);
  const state = windowState.get(win.id);
  return { ...getCurrentWorkspaceForWindow(win), showLanding: !!state?.showLanding, lang: currentLang };
});

ipcMain.handle('workspace:openDirectory', (event) => {
  const { win, state } = getStateForWebContents(event.sender);
  return openWorkspaceDialog(win, state);
});

ipcMain.handle('workspace:openFile', (event) => {
  const { win, state } = getStateForWebContents(event.sender);
  return openWorkspaceFileDialog(win, state);
});

// Re-assert renderer state as the source of truth (e.g. the user cancelled a discard prompt, or a
// workspace failed to load) without re-broadcasting or restarting the terminal.
ipcMain.handle('workspace:resync', (event, { workspace, showLanding = false } = {}) => {
  const { win } = getStateForWebContents(event.sender);
  const state = windowState.get(win.id);
  if (state) {
    if (workspace) state.workspace = normalizeWorkspace(workspace, state.workspace);
    state.showLanding = !!showLanding;
  }
  return { ok: true };
});

ipcMain.handle('tree:read', (_event, args) => readDirTree(args));

// Cheap fingerprint of the given directories' entries, used by the renderer to detect
// changes made outside the app (e.g. files created from the terminal) and refresh the tree.
// fs.watch does not work over \\wsl.localhost UNC paths, so the renderer polls this instead.
ipcMain.handle('tree:signature', async (_event, { distro = DEFAULT_DISTRO, paths = [] }) => {
  const parts = [];
  for (const wslPath of paths) {
    const fullPath = wslPathToWindowsFsPath(distro, wslPath);
    try {
      const entries = await fs.promises.readdir(fullPath, { withFileTypes: true });
      const names = entries
        .filter((entry) => !entry.name.startsWith('.git'))
        .map((entry) => `${entry.isDirectory() ? 'd' : 'f'}:${entry.name}`)
        .sort();
      parts.push(`${wslPath}|${names.join(',')}`);
    } catch {
      parts.push(`${wslPath}|MISSING`);
    }
  }
  return parts.join('\n');
});

ipcMain.handle('file:read', (_event, { distro = DEFAULT_DISTRO, wslPath }) => {
  const fullPath = wslPathToWindowsFsPath(distro, wslPath);
  const stat = safeStat(fullPath);
  if (!stat || !stat.isFile()) return '';
  if (stat.size > 1024 * 1024) return '[File is larger than 1MB. Editor skipped.]';
  return fs.readFileSync(fullPath, 'utf8');
});

// Read an image file as a data: URL for the renderer's <img> preview.
ipcMain.handle('file:readImage', (_event, { distro = DEFAULT_DISTRO, wslPath }) => {
  const fullPath = wslPathToWindowsFsPath(distro, wslPath);
  const stat = safeStat(fullPath);
  if (!stat || !stat.isFile()) throw new Error(`File not found: ${wslPath}`);
  if (stat.size > 16 * 1024 * 1024) throw new Error('Image is larger than 16MB.');
  const data = fs.readFileSync(fullPath).toString('base64');
  return `data:${imageMimeForPath(wslPath)};base64,${data}`;
});

ipcMain.handle('file:write', (_event, { distro = DEFAULT_DISTRO, wslPath, content }) => {
  if (!wslPath) throw new Error('wslPath is required.');
  const fullPath = wslPathToWindowsFsPath(distro, wslPath);
  const stat = safeStat(fullPath);
  if (!stat || !stat.isFile()) throw new Error(`File not found: ${wslPath}`);
  fs.writeFileSync(fullPath, content ?? '', 'utf8');
  return { ok: true };
});

ipcMain.handle('fs:move', (_event, { distro = DEFAULT_DISTRO, sourcePath, targetDirPath }) => {
  if (!sourcePath || !targetDirPath) throw new Error('sourcePath and targetDirPath are required.');
  if (sourcePath === targetDirPath || targetDirPath.startsWith(sourcePath + '/')) {
    throw new Error('Cannot move a directory into itself.');
  }
  const src = wslPathToWindowsFsPath(distro, sourcePath);
  const dst = wslPathToWindowsFsPath(distro, path.posix.join(targetDirPath, path.posix.basename(sourcePath)));
  if (!safeStat(src)) throw new Error(`Source not found: ${sourcePath}`);
  if (safeStat(dst)) throw new Error(`Destination already exists: ${path.posix.basename(dst)}`);
  fs.renameSync(src, dst);
  return { ok: true };
});

ipcMain.handle('fs:create', (_event, { distro = DEFAULT_DISTRO, parentDirPath, name, type = 'file' }) => {
  if (!parentDirPath || !name) throw new Error('parentDirPath and name are required.');
  if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') throw new Error('Invalid name.');
  const target = wslPathToWindowsFsPath(distro, path.posix.join(parentDirPath, name));
  if (safeStat(target)) throw new Error(`Already exists: ${name}`);
  if (type === 'directory') {
    fs.mkdirSync(target);
  } else {
    fs.writeFileSync(target, '', { flag: 'wx' });
  }
  return { ok: true };
});

ipcMain.handle('fs:rename', (_event, { distro = DEFAULT_DISTRO, sourcePath, newName }) => {
  if (!sourcePath || !newName) throw new Error('sourcePath and newName are required.');
  if (newName.includes('/') || newName.includes('\\') || newName === '.' || newName === '..') throw new Error('Invalid name.');
  const src = wslPathToWindowsFsPath(distro, sourcePath);
  const dstPath = path.posix.join(path.posix.dirname(sourcePath), newName);
  const dst = wslPathToWindowsFsPath(distro, dstPath);
  if (!safeStat(src)) throw new Error(`Source not found: ${sourcePath}`);
  if (safeStat(dst)) throw new Error(`Already exists: ${newName}`);
  fs.renameSync(src, dst);
  return { ok: true, path: dstPath };
});

ipcMain.handle('fs:delete', (_event, { distro = DEFAULT_DISTRO, targetPath }) => {
  if (!targetPath) throw new Error('targetPath is required.');
  const target = wslPathToWindowsFsPath(distro, targetPath);
  if (!safeStat(target)) throw new Error(`Target not found: ${targetPath}`);
  fs.rmSync(target, { recursive: true, force: false });
  return { ok: true };
});

ipcMain.handle('fs:reveal', async (_event, { distro = DEFAULT_DISTRO, targetPath }) => {
  if (!targetPath) throw new Error('targetPath is required.');
  const target = wslPathToWindowsFsPath(distro, targetPath);
  if (!safeStat(target)) throw new Error(`Target not found: ${targetPath}`);
  shell.showItemInFolder(target);
  return { ok: true };
});

ipcMain.handle('fs:copyExternal', (_event, { distro = DEFAULT_DISTRO, sourcePaths = [], targetDirPath }) => {
  if (!Array.isArray(sourcePaths) || sourcePaths.length === 0) throw new Error('sourcePaths are required.');
  if (!targetDirPath) throw new Error('targetDirPath is required.');
  const targetDir = wslPathToWindowsFsPath(distro, targetDirPath);
  const targetStat = safeStat(targetDir);
  if (!targetStat || !targetStat.isDirectory()) throw new Error(`Target directory not found: ${targetDirPath}`);

  const result = { copied: [], skipped: [] };
  for (const sourcePath of sourcePaths) {
    const sourceStat = safeStat(sourcePath);
    if (!sourceStat) {
      result.skipped.push({ source: sourcePath, reason: 'source not found' });
      continue;
    }
    const destination = path.join(targetDir, path.basename(sourcePath));
    copyRecursiveSafeSync(sourcePath, destination, result);
  }

  if (result.copied.length === 0 && result.skipped.length > 0) {
    const first = result.skipped[0];
    throw new Error(`No files were copied. First skipped item: ${first.source} (${first.reason})`);
  }

  return { ok: true, copied: result.copied, skipped: result.skipped };
});

ipcMain.handle('folder:pick', async (event) => {
  const { win, state } = getStateForWebContents(event.sender);
  const result = await dialog.showOpenDialog(win, {
    title: tr('dialog.openWorkspace'),
    defaultPath: getDefaultOpenWorkspacePath(state.workspace.distro),
    properties: ['openDirectory']
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const selected = result.filePaths[0];
  const parsed = parseSelectedPath(selected);
  return { windowsPath: selected, wslPath: parsed.wslPath, distro: parsed.distro || state.workspace.distro };
});

ipcMain.on('terminal:start', (event, { distro, wslPath, command = '' }) => {
  const { win, state } = getStateForWebContents(event.sender);
  const workspace = normalizeWorkspace({ distro, wslPath }, state.workspace);
  state.workspace = workspace;
  if (state.shellPty) {
    try { state.shellPty.kill(); } catch {}
  }
  const args = ['-d', workspace.distro, '--cd', workspace.wslPath, '--exec', 'bash', '-lc', command ? `${command}; exec bash` : 'exec bash'];
  state.shellPty = pty.spawn('wsl.exe', args, {
    name: 'xterm-256color',
    cols: 100,
    rows: 30,
    cwd: os.homedir(),
    env: process.env
  });
  state.shellPty.onData((data) => {
    if (!win.isDestroyed()) win.webContents.send('terminal:data', data);
  });
  state.shellPty.onExit(() => {
    state.shellPty = null;
    if (!win.isDestroyed()) {
      win.webContents.send('terminal:data', `\r\n\x1b[90m${tr('terminal.exited')}\x1b[0m\r\n`);
      win.webContents.send('terminal:exit');
    }
  });
});

ipcMain.on('terminal:write', (event, data) => {
  const { state } = getStateForWebContents(event.sender);
  if (state.shellPty) state.shellPty.write(data);
});

ipcMain.on('terminal:resize', (event, { cols, rows }) => {
  const { state } = getStateForWebContents(event.sender);
  if (state.shellPty) state.shellPty.resize(cols, rows);
});
