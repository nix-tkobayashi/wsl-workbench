const { app, BrowserWindow, ipcMain, dialog, shell, Menu, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const pty = require('node-pty');
const i18n = require('./i18n');
const { imageMimeForPath } = require('./file-types');
const { normalizeVersion, isNewer } = require('./version');

const RELEASES_API = 'https://api.github.com/repos/nix-tkobayashi/wsl-workbench/releases/latest';
const RELEASES_PAGE = 'https://github.com/nix-tkobayashi/wsl-workbench/releases/latest';
const REPO_URL = 'https://github.com/nix-tkobayashi/wsl-workbench';

const DEFAULT_DISTRO = process.env.WSLWB_DISTRO || 'Ubuntu';
// WSLg with systemd sets XDG_RUNTIME_DIR to /run/user/<uid> but leaves the Wayland socket under
// /mnt/wslg/runtime-dir, so wl-copy/wl-paste (hence Claude Code's clipboard image paste) can't find
// it. When the default socket is missing but WSLg's exists, point WAYLAND_DISPLAY at the real one.
// Shared by the terminal's login shell (so CLIs inside inherit it) and the image-bridge command.
const WSLG_WAYLAND_FIX =
  'if [ -S /mnt/wslg/runtime-dir/wayland-0 ] && [ ! -S "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/wayland-0" ]; ' +
  'then export WAYLAND_DISPLAY=/mnt/wslg/runtime-dir/wayland-0; fi';
const DEFAULT_WSL_PATH = process.env.WSLWB_PATH || `/home/${os.userInfo().username}/projects`;
const DEFAULT_WSL_HOME_PATH = process.env.WSLWB_HOME_PATH || `/home/${os.userInfo().username}`;

const WORKSPACE_EXT = 'wslwb-workspace';

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

const WORKSPACE_EXTENSIONS = new Set([`.${WORKSPACE_EXT}`, '.json']);

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
    // Custom title bar (like VS Code / Cursor): frameless window with the toolbar drawn in its place.
    // The toolbar is the drag region; min/max/close are custom buttons wired to IPC below. The app
    // menu is retained only for keyboard accelerators (autoHideMenuBar keeps it from drawing a row).
    frame: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  windowState.set(win.id, {
    workspace: normalizeWorkspace(initialWorkspace),
    terminals: new Map(), // terminal id -> pty (multiple tabs per window)
    showLanding
  });

  win.on('closed', () => {
    const state = windowState.get(win.id);
    if (state) {
      for (const ptyProc of state.terminals.values()) {
        try { ptyProc.kill(); } catch {}
      }
    }
    windowState.delete(win.id);
  });

  // Keep the custom maximize/restore button glyph in sync with the actual window state.
  const sendMaximized = () => {
    if (!win.isDestroyed()) win.webContents.send('window:maximized', win.isMaximized());
  };
  win.on('maximize', sendMaximized);
  win.on('unmaximize', sendMaximized);

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
      { name: tr('filter.workspace'), extensions: [WORKSPACE_EXT, 'json'] },
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

// Only trust https URLs on github.com (never trust an arbitrary URL from the API response).
function isGithubHttpsUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === 'github.com';
  } catch {
    return false;
  }
}

function safeReleaseUrl(url) {
  return isGithubHttpsUrl(url) ? url : RELEASES_PAGE;
}

// Pick the NSIS one-click installer asset (e.g. "WSL.Workbench.Setup.0.6.0.exe") — not the portable build.
function pickInstallerAsset(assets) {
  if (!Array.isArray(assets)) return null;
  const asset = assets.find((a) =>
    a && typeof a.name === 'string' &&
    /setup/i.test(a.name) && a.name.toLowerCase().endsWith('.exe') &&
    isGithubHttpsUrl(a.browser_download_url));
  return asset ? { name: path.basename(asset.name), url: asset.browser_download_url } : null;
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
    return {
      version: normalizeVersion(data.tag_name),
      url: safeReleaseUrl(data.html_url),
      installer: pickInstallerAsset(data.assets)
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Refuse to execute an installer unless it is Authenticode-signed by the same publisher as the
// running app (matched on certificate subject so it survives a self-signed cert renewal). This
// guards against running arbitrary bytes if the release/GitHub account is ever compromised.
function verifyInstallerSignature(installerPath) {
  try {
    const script =
      "$ErrorActionPreference='Stop';" +
      '$a=Get-AuthenticodeSignature -LiteralPath $env:WB_INSTALLER;' +
      '$b=Get-AuthenticodeSignature -LiteralPath $env:WB_SELF;' +
      '[pscustomobject]@{it=$a.SignerCertificate.Subject;is=$a.Status.ToString();st=$b.SignerCertificate.Subject}|ConvertTo-Json -Compress';
    const ps = require('child_process').spawnSync('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { env: { ...process.env, WB_INSTALLER: installerPath, WB_SELF: process.execPath }, timeout: 20000, encoding: 'utf8' });
    if (ps.status !== 0 || !ps.stdout) return { ok: false, reason: 'verification failed' };
    const info = JSON.parse(ps.stdout.trim());
    if (!info.it) return { ok: false, reason: 'installer is not signed' };
    // Require a trusted certificate chain — this is the real cryptographic guarantee (a tampered
    // installer is HashMismatch; a forged self-signed cert is untrusted). The chain is trusted only
    // if the user installed the publisher cert into their trust store (the documented install step).
    if (info.is !== 'Valid') return { ok: false, reason: `untrusted (${info.is})` };
    // Defense in depth: when the running app is itself signed, pin the installer to the same publisher
    // so a different, unrelated trusted cert cannot be substituted.
    if (info.st && String(info.it).toLowerCase() !== String(info.st).toLowerCase()) {
      return { ok: false, reason: 'publisher mismatch' };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error.message || 'verification error' };
  }
}

// Spawn the installer detached, then quit so it can replace the running app. Quit only once spawn
// has actually started (a missing/quarantined file emits 'error' first).
function launchInstallerAndQuit(installerPath) {
  return new Promise((resolve, reject) => {
    const child = require('child_process').spawn(installerPath, [], { detached: true, stdio: 'ignore' });
    let settled = false;
    child.once('error', (error) => { if (!settled) { settled = true; reject(error); } });
    setTimeout(() => {
      if (settled) return;
      settled = true;
      child.unref();
      app.quit();
      resolve();
    }, 500);
  });
}

// Download the installer to a temp file (reporting progress to the window), verify its signature,
// launch it, and quit. The NSIS one-click installer relaunches the app when it finishes.
let updateInProgress = false;
async function downloadAndInstallUpdate(win, installer) {
  if (updateInProgress) return;
  updateInProgress = true;
  const { pipeline } = require('stream/promises');
  const { Readable } = require('stream');
  const send = (payload) => { if (win && !win.isDestroyed()) win.webContents.send('update:progress', payload); };
  const setBar = (frac) => { if (win && !win.isDestroyed()) win.setProgressBar(frac); };
  const dest = path.join(app.getPath('temp'), installer.name);
  const controller = new AbortController();
  let stallTimer = null;
  const armStall = () => { if (stallTimer) clearTimeout(stallTimer); stallTimer = setTimeout(() => controller.abort(), 60000); };
  try {
    send({ phase: 'download', received: 0, total: 0 });
    armStall();
    const res = await fetch(installer.url, { headers: { 'User-Agent': 'wsl-workbench' }, signal: controller.signal });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length')) || 0;
    let received = 0;
    const source = Readable.fromWeb(res.body);
    source.on('data', (chunk) => {
      received += chunk.length;
      armStall();
      send({ phase: 'download', received, total });
      setBar(total > 0 ? received / total : -1);
    });
    // pipeline cleans up both streams (and the dest file) on any error, including an abort.
    await pipeline(source, fs.createWriteStream(dest), { signal: controller.signal });
    clearTimeout(stallTimer);
    setBar(-1);

    const verdict = verifyInstallerSignature(dest);
    if (!verdict.ok) throw new Error(`${tr('update.untrusted')} (${verdict.reason})`);

    send({ phase: 'launching' });
    await launchInstallerAndQuit(dest);
  } catch (error) {
    updateInProgress = false;
    clearTimeout(stallTimer);
    setBar(-1);
    try { fs.unlinkSync(dest); } catch {}
    send({ phase: 'error', message: error.message || String(error) });
    dialog.showErrorBox(tr('update.failed'), error.message || String(error));
  }
}

// "About" dialog: shows the current version, checks GitHub for the latest, and offers to open the
// release page when a newer version exists.
async function showAboutDialog(win) {
  const current = app.getVersion();
  const latest = await fetchLatestRelease();

  const lines = [`${tr('about.currentVersion')}: ${current}`];
  // Buttons and a parallel list of click actions (null = just dismiss). Index 0 is the default.
  const buttons = [];
  const actions = [];
  const addButton = (label, fn) => { buttons.push(label); actions.push(fn || null); };

  if (latest && latest.version) {
    lines.push(`${tr('about.latestVersion')}: ${latest.version}`);
    if (isNewer(latest.version, current)) {
      lines.push('', tr('about.updateAvailable'));
      const target0 = win && !win.isDestroyed() ? win : null;
      if (latest.installer) addButton(tr('about.downloadInstall'), () => downloadAndInstallUpdate(target0, latest.installer));
      else addButton(tr('about.openReleasePage'), () => shell.openExternal(latest.url).catch(() => {}));
    } else {
      lines.push('', tr('about.upToDate'));
    }
  } else {
    lines.push('', tr('about.checkFailed'));
  }
  lines.push('', `GitHub: ${REPO_URL}`);
  addButton(tr('about.github'), () => shell.openExternal(REPO_URL).catch(() => {}));
  addButton(tr('about.close'), null);

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
  const fn = actions[result.response];
  if (fn) fn();
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
        {
          label: tr('menu.saveWorkspace'),
          accelerator: 'CmdOrCtrl+Shift+S',
          click: async () => {
            const { win, state } = getFocusedWindowAndState();
            if (!win || !state) return;
            // Default the filename to the workspace directory name, e.g. test003.wslwb-workspace.
            const dirName = String(state.workspace.wslPath || '').split('/').filter(Boolean).pop() || 'workspace';
            const result = await dialog.showSaveDialog(win, {
              title: tr('dialog.saveWorkspace'),
              defaultPath: `${dirName}.${WORKSPACE_EXT}`,
              filters: [
                { name: tr('filter.workspace'), extensions: [WORKSPACE_EXT, 'json'] },
                { name: tr('filter.allFiles'), extensions: ['*'] }
              ]
            });
            if (result.canceled || !result.filePath) return;
            fs.writeFileSync(result.filePath, JSON.stringify({ ...state.workspace, app: 'WSL Workbench', version: 1 }, null, 2), 'utf8');
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

// The directory `git clone <url>` creates: the URL's last path segment without a trailing .git.
// Handles https URLs and scp-style (git@host:user/repo.git); returns '' if none can be derived.
function repoDirNameFromUrl(url) {
  const trimmed = String(url).trim().replace(/[/\\]+$/, '');
  const last = trimmed.split(/[/\\:]/).pop() || '';
  const name = last.replace(/\.git$/i, '');
  return (name === '.' || name === '..') ? '' : name;
}

// Run `git clone` inside the distro. url/name are passed as argv (never through a shell) so a hostile
// URL can't inject commands; `--` stops git from reading either as an option. GIT_TERMINAL_PROMPT=0 +
// GIT_ASKPASS=/bin/true make auth failures error out instead of hanging on a prompt with no TTY.
function runWslGitClone(distro, parentDirPath, url, name) {
  return new Promise((resolve) => {
    const args = ['-d', distro, '--cd', parentDirPath, '--',
      'env', 'GIT_TERMINAL_PROMPT=0', 'GIT_ASKPASS=/bin/true', 'git', 'clone', '--', url, name];
    const child = require('child_process').spawn('wsl.exe', args, { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => resolve({ ok: false, message: String(err.message || err) }));
    child.on('close', (code) => resolve({ ok: code === 0, message: stderr.trim() }));
  });
}

// Clone a repo into the chosen parent folder, then open the cloned directory as the workspace.
ipcMain.handle('workspace:clone', async (event, { distro = DEFAULT_DISTRO, parentDirPath, url } = {}) => {
  const { win } = getStateForWebContents(event.sender);
  if (!url || !url.trim()) throw new Error('Repository URL is required.');
  if (!parentDirPath) throw new Error('Destination folder is required.');
  const cleanUrl = url.trim();
  const name = repoDirNameFromUrl(cleanUrl);
  if (!name) throw new Error('Could not determine a folder name from the URL.');
  const targetWslPath = path.posix.join(parentDirPath, name);
  const targetFsPath = wslPathToWindowsFsPath(distro, targetWslPath);
  if (safeStat(targetFsPath)) throw new Error(`Already exists: ${name}`);

  const res = await runWslGitClone(distro, parentDirPath, cleanUrl, name);
  if (!res.ok) throw new Error(res.message || 'git clone failed.');
  if (!safeStat(targetFsPath)) throw new Error('Clone succeeded but the folder was not found.');

  setCurrentWorkspaceForWindow(win, { distro, wslPath: targetWslPath });
  return { ok: true, wslPath: targetWslPath, name };
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

// Clipboard via the main process: the `clipboard` module is not available in a sandboxed preload,
// so the renderer reaches it through these IPC channels. sendSync keeps the renderer API synchronous.
ipcMain.on('clipboard:writeText', (event, text) => {
  clipboard.writeText(String(text ?? ''));
  event.returnValue = true;
});
ipcMain.on('clipboard:readText', (event) => {
  event.returnValue = clipboard.readText();
});
// True when the clipboard holds a bitmap image (e.g. a screenshot). Lets the renderer decide whether
// a paste in the tree/terminal should be handled as an image instead of text.
ipcMain.on('clipboard:hasImage', (event) => {
  event.returnValue = !clipboard.readImage().isEmpty();
});

// Bridge the clipboard image into the WSL distro's own clipboard as PNG. Claude Code reads the OS
// clipboard on Ctrl+V (via wl-copy/xclip) and shows it as [Image #N]; a Windows-side clipboard image
// (BMP over WSLg) isn't visible to it, so we push a PNG in ourselves, then the renderer sends Ctrl+V.
// The PNG is staged to a temp file (not piped straight into a tool) so that if wl-copy is present but
// its Wayland server is unreachable, we can still fall through to xclip on the same bytes. stdout/
// stderr go to /dev/null so the daemon wl-copy/xclip forks doesn't hold spawnSync's pipes open.
// Returns { ok }; the renderer reports failure to the user (it does not write a file).
ipcMain.handle('clipboard:pushImageToWsl', (_event, { distro = DEFAULT_DISTRO } = {}) => {
  const image = clipboard.readImage();
  if (image.isEmpty()) return { ok: false, reason: 'no-image' };
  const script = `${WSLG_WAYLAND_FIX}; ` +
    'tmp=$(mktemp --suffix=.png) || exit 4; cat > "$tmp"; rc=3; ' +
    'if command -v wl-copy >/dev/null 2>&1; then wl-copy --type image/png < "$tmp" >/dev/null 2>&1 && rc=0; fi; ' +
    'if [ $rc -ne 0 ] && command -v xclip >/dev/null 2>&1; then xclip -selection clipboard -t image/png -i "$tmp" >/dev/null 2>&1 && rc=0; fi; ' +
    'rm -f "$tmp"; exit $rc';
  const res = require('child_process').spawnSync(
    'wsl.exe', ['-d', distro, '--exec', 'bash', '-lc', script],
    { input: image.toPNG(), timeout: 10000 }
  );
  if (res.error) return { ok: false, reason: String(res.error.message || res.error) };
  if (res.status !== 0) return { ok: false, reason: `exit-${res.status}` };
  return { ok: true };
});

// Custom window controls (frameless window): the toolbar's min/max/close buttons drive these.
ipcMain.on('window:minimize', (event) => {
  BrowserWindow.fromWebContents(event.sender)?.minimize();
});
ipcMain.on('window:toggleMaximize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});
ipcMain.on('window:close', (event) => {
  BrowserWindow.fromWebContents(event.sender)?.close();
});

// Pop a top-level application menu's submenu at a screen position, so the in-app toolbar buttons
// can show the real menus (the native menu bar itself is hidden via autoHideMenuBar). index maps
// to the application menu's top-level order: 0 Workspace, 1 Edit, 2 View, 3 Language, 4 Help.
ipcMain.on('menu:popup', (event, { index, x, y } = {}) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const appMenu = Menu.getApplicationMenu();
  if (!win || !appMenu) return;
  const item = appMenu.items[index];
  if (item && item.submenu) {
    item.submenu.popup({ window: win, x: Math.round(x || 0), y: Math.round(y || 0) });
  }
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

// Two-digit zero-pad for the timestamp used in pasted-image filenames.
function pad2(n) { return String(n).padStart(2, '0'); }

// Save the clipboard's bitmap image as a PNG into the given WSL directory. Used by both the tree
// (explicit paste-to-save) and the terminal (so an AI CLI can reference the saved path). Returns the
// created file's WSL path so the renderer can refresh/insert it.
ipcMain.handle('fs:saveClipboardImage', (_event, { distro = DEFAULT_DISTRO, targetDirPath } = {}) => {
  if (!targetDirPath) throw new Error('targetDirPath is required.');
  const image = clipboard.readImage();
  if (image.isEmpty()) throw new Error('No image in clipboard.');
  const targetDir = wslPathToWindowsFsPath(distro, targetDirPath);
  const targetStat = safeStat(targetDir);
  if (!targetStat || !targetStat.isDirectory()) throw new Error(`Target directory not found: ${targetDirPath}`);

  const now = new Date();
  const stamp = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}-${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
  const base = `pasted-image-${stamp}`;
  const png = image.toPNG();
  // Exclusive create ('wx') so a name collision (or a symlink planted between check and write) can't
  // clobber an existing file; on EEXIST, try the next suffix.
  let name = `${base}.png`;
  for (let i = 1; ; i++) {
    try {
      fs.writeFileSync(path.join(targetDir, name), png, { flag: 'wx' });
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      name = `${base}-${i}.png`;
    }
  }
  return { ok: true, name, path: path.posix.join(targetDirPath, name) };
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

ipcMain.on('terminal:start', (event, { id, distro, wslPath, command = '' }) => {
  const { win, state } = getStateForWebContents(event.sender);
  const workspace = normalizeWorkspace({ distro, wslPath }, state.workspace);
  state.workspace = workspace;
  const existing = state.terminals.get(id);
  if (existing) {
    try { existing.kill(); } catch {}
  }
  // Repair the Wayland env first so CLIs in the shell (e.g. Claude Code) can read clipboard images.
  const launch = command ? `${command}; exec bash` : 'exec bash';
  const args = ['-d', workspace.distro, '--cd', workspace.wslPath, '--exec', 'bash', '-lc', `${WSLG_WAYLAND_FIX}; ${launch}`];
  const ptyProc = pty.spawn('wsl.exe', args, {
    name: 'xterm-256color',
    cols: 100,
    rows: 30,
    cwd: os.homedir(),
    env: process.env
  });
  state.terminals.set(id, ptyProc);
  ptyProc.onData((data) => {
    if (state.terminals.get(id) !== ptyProc) return; // ignore output from a superseded pty
    if (!win.isDestroyed()) win.webContents.send('terminal:data', { id, data });
  });
  ptyProc.onExit(() => {
    if (state.terminals.get(id) !== ptyProc) return; // superseded by a newer pty for this id; ignore its late exit
    state.terminals.delete(id);
    if (!win.isDestroyed()) {
      win.webContents.send('terminal:data', { id, data: `\r\n\x1b[90m${tr('terminal.exited')}\x1b[0m\r\n` });
      win.webContents.send('terminal:exit', { id });
    }
  });
});

ipcMain.on('terminal:write', (event, { id, data }) => {
  const { state } = getStateForWebContents(event.sender);
  const ptyProc = state.terminals.get(id);
  if (ptyProc) ptyProc.write(data);
});

ipcMain.on('terminal:resize', (event, { id, cols, rows }) => {
  const { state } = getStateForWebContents(event.sender);
  const ptyProc = state.terminals.get(id);
  if (ptyProc && cols && rows) ptyProc.resize(cols, rows);
});

ipcMain.on('terminal:close', (event, { id }) => {
  const { state } = getStateForWebContents(event.sender);
  const ptyProc = state.terminals.get(id);
  if (ptyProc) {
    try { ptyProc.kill(); } catch {}
  }
  state.terminals.delete(id);
});
